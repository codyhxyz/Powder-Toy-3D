import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims, sleepUnitOf } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// Movement pass: Margolus block cellular automaton.
//
// The grid is partitioned into 2×2×2 blocks; the partition shifts by one cell
// on every step (P.parity). One thread per block loads its whole block, runs
// the block update (all randomness is seeded from the block's base cell and
// the frame) and writes its 8 cells back. Because a block is only ever
// permuted, mass is conserved exactly and two particles can never claim the
// same cell: the classic GPU falling-sand race condition can't happen. And
// because a block's thread reads and writes only its own 8 cells, the move
// runs in place, in the current state copy (docs/webgpu.md D2, W11).
//
// Movement is velocity driven: each particle carries a velocity (cells/step)
// integrated in the react pass (gravity, buoyancy, pressure, drag). Here a
// particle attempts to move along each axis with probability |v|, and a
// density test decides whether it can displace its neighbour. Blocked
// particles get collision responses: powders topple diagonally, liquids turn
// their fall into horizontal flow, gases slide along ceilings.
//
// Impacts on solids. A grain that slams into a solid (faster than COLLIDE_V,
// the line between an impact and resting contact) stops, and the kinetic
// energy it loses becomes heat (physics.js KE_TO_HEAT), shared between it and
// the solid so both warm by the same amount. Liquids splash and flow on and
// gases bounce, so their motion isn't counted. A grain whose impact would
// break the solid isn't stopped at all: the react pass after this one breaks
// the solid and charges the grain for it (react.js). The heat is quantized as
// the WebGL build's slot packing quantized it (HEAT_QUANTA).
//
// Which blocks run (docs/webgpu.md D2, D5). The steps run over the sleeping
// units the activity map draws (shaders/activity.js): a block runs if any of
// its cells lies in a DRAWN unit, and every other thread returns at once. A
// unit's home blocks (based in it) come from a list per partition offset:
// at offset 0 a block lies in its home brick, so the list is DRAWN; at 1 it
// reaches one cell into the next brick along each axis, so the list is MOVE1,
// DRAWN dilated toward -x, -y, -z. The blocks based outside the grid at
// offset 1 (a base coordinate of -1: the low margin) have no home brick and
// are a direct dispatch of their own (P.margin).
//
// A block whose base cell is in a quiet brick (shaders/activity.js) lies
// within that brick's inert halo: it stays put, velocities and all. Its cells
// only lose DIRTY on a map's first step (P.fresh), and those in a brick that
// isn't quiet blend still motion into the flow field.
//
// With Whitewater on, the same pipeline runs out of place (P.outOfPlace): it
// writes the other copy, copies a quiet block's A and B through, and records
// where each cell's content came from (moveSrc), which the aeration field
// follows, reading the copy from before the move (gfx/foam.js). One pipeline,
// so in place and out of place can't differ by how a compiler contracted two
// modules' math (docs/webgpu.md D8.11).
//
// The flow field for the renderer (gfx/surface.js, flowing grains): how far
// each cell's content moved this step, blended into the field over recent
// steps (FLOW_BLEND). This is motion that happened, not velocity: grains
// pressed against a pile want to fall but go nowhere, so a resting pile reads
// 0. Quiet bricks hold only still air and solids, which the renderer doesn't
// read flow for, so they keep what they have. Three half floats per cell.
//
// Code form (docs/webgpu.md D2, W23). The WebGL build generated the block
// update unrolled, every cell index a literal and the 8 cells in named
// registers (a0..a7 …), 2,377 lines at 64³, so GPU compilers kept it in
// registers. As WGSL that form outgrows SwiftShader's compiler (the test
// device): see MOVE_FORMS. The form that ships is a loop over the rules with
// the 8 cells in arrays and the rules as functions taking a cell index,
// MOVE_FORM below; tools/check-wgsl.mjs --time measures its creation.

// The block's cells: cell i at local (x, y, z) = (i & 1, (i >> 1) & 1, (i >> 2) & 1).
const CELLS = [0, 1, 2, 3, 4, 5, 6, 7];

// Impact heat travels with each cell as an amount of kinetic energy,
// quantized as the WebGL build's slots packed it beside the source index
// (n + 8·round(q·HEAT_QUANTA) in one float): resolution 1/HEAT_QUANTA, up to
// HEAT_Q_MAX, far above anything a step can deposit.
export const SLOTS = 8;   // a block's cells
const HEAT_QUANTA = 1024;   // quanta per unit of kinetic energy (resolution ≈ 0.001)
const HEAT_Q_MAX = Math.floor((2 ** 24 / SLOTS - 1) / HEAT_QUANTA);

// Share of each step's displacements blended into the flow field (the rest is
// history): grains move a cell on some steps and not others, so the field
// averages their speed over about 1 / FLOW_BLEND steps.
export const FLOW_BLEND = 0.05;

// Margolus blocks at partition offset 1 with a base coordinate of -1 (the
// grid's low margin): the slab x = -1, then y = -1 (x ≥ 0), then z = -1
// (x, y ≥ 0), with h = N/2 per axis.
export function marginBlocks(g) {
  const hx = g.nx / 2, hy = g.ny / 2, hz = g.nz / 2;
  return (hy + 1) * (hz + 1) + hx * (hz + 1) + hx * hy;
}

export const MoveParams = uniformStruct('MoveParams', {
  frame: 'u32',
  parity: 'u32',      // the partition offset: frame & 1
  gravity: 'f32',
  fresh: 'u32',       // the first step under this activity map: DIRTY marks start over
  outOfPlace: 'u32',  // Whitewater: write H.dst ≠ H.src, copy quiet blocks through, record moveSrc
  margin: 'u32',      // the low margin's blocks (direct), not a list's
  blockRev: 'u32',    // test (sim.test.blockOrder): reversed thread → block map
  eight: 'u32',       // 8: the loops' bound at runtime, so compilers keep them loops
});

// Group 2 (docs/webgpu.md C4): the flow field and moveSrc, both read_write.
export const MOVE_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];

// ---------------------------------------------------------------- the unrolled form
// The WebGL build's block update, mechanically: cell i in registers a${i}
// (state A), v${i} (velocity), k${i} (element), d${i} (density), n${i}
// (where its content came from), q${i} (impact heat), m${i} (moved this step),
// s${i} (stopped: it tried to fall or rise and hit something).
//
// QUIRK, kept for parity (docs/webgpu.md A goal 2): in the GLSL, the old
// velocity saved for impactHeat was a block-local `vec3 v0 = v${i};`. For cell
// 0 that declared `vec3 v0 = v0;`, which shadows cell 0's register, so cell 0
// rising into a solid and cell 0 bouncing off one along x or z changed only the
// dead local: it kept its velocity and took no heat (it is still marked
// stopped when rising). Both forms do exactly that; fixing it is a physics
// change (docs/webgpu.md K3).
const swap = (i, j) => `{
    let ta = a${i}; a${i} = a${j}; a${j} = ta;
    let tv = v${i}; v${i} = v${j}; v${j} = tv;
    let ti = k${i}; k${i} = k${j}; k${j} = ti;
    let tn = n${i}; n${i} = n${j}; n${j} = tn;
    let td = d${i}; d${i} = d${j}; d${j} = td;
    let tq = q${i}; q${i} = q${j}; q${j} = tq;
    m${i} = true; m${j} = true;
  }`;
// Collision between particles i and j along component c (i on the negative
// side, j on the positive side). Fast impacts exchange momentum, weighted by
// density as mass, with restitution 0.3: this is what lets a blast or an
// impact travel through a pile like a Newton's cradle. Slow contact is just
// support: the approaching velocity is cancelled.
const collide = (i, j, c) => `{
      let rel = v${i}.${c} - v${j}.${c};
      if (rel > COLLIDE_V) {
        let mi = d${i};
        let mj = d${j};
        let inv = 1.0 / (mi + mj);
        let vc = (mi * v${i}.${c} + mj * v${j}.${c}) * inv;
        v${i}.${c} = vc - RESTITUTION * mj * inv * rel;
        v${j}.${c} = vc + RESTITUTION * mi * inv * rel;
      } else if (rel > 0.0) {
        if (v${i}.${c} > 0.0) { v${i}.${c} = 0.0; }
        if (v${j}.${c} < 0.0) { v${j}.${c} = 0.0; }
      }
    }`;
// Particle i (velocity before vOld) was stopped by solid j: its lost kinetic
// energy, if it was a real impact by a grain, becomes heat shared by capacity.
const impactHeat = (i, j, vOld, speed) => `
      if (KIND(k${i}) == K_POWDER && ${speed} > COLLIDE_V) {
        let lost = max(0.5 * d${i} * (dot(${vOld}, ${vOld}) - dot(v${i}, v${i})), 0.0);
        let share = CAP(k${i}) / (CAP(k${i}) + CAP(k${j}));
        q${i} += lost * share;
        q${j} += lost * (1.0 - share);
      }`;
// Would particle i, moving at vn along the axis toward solid j, break it or
// set off an explosive (common.js impactActs)? Then leave it be: the react
// pass breaks j and charges i for it, or sets the explosive off.
const breaks = (i, j, vn) => `impactActs(k${i}, k${j}, 0.5 * d${i} * ${vn} * ${vn})`;
const can = (i, j, dir) => `canMove(k${i}, k${j}, d${i}, d${j}, ${dir})`;
const drag = (i, j) => `dragF(k${i}, k${j}, d${i}, d${j})`;

// 1. vertical exchange within one column (b = bottom, t = top). A top cell the
// react pass's normal force holds at rest (v.y = 0 under gravity) still
// presses on what's below, so where that is a dead end it is blocked and may
// topple (2) like a falling one; it just doesn't land again every step.
const vertical = (b, t) => `
  {
    let mt = movable(k${t});
    let mb = movable(k${b});
    let down = v${t}.y < 0.0;
    let up = v${b}.y > 0.0;
    let held = v${t}.y == 0.0 && GRAV(k${t}) * P.gravity > 0.0;
    if (!mt || !mb) {
      if (mt && down && !${breaks(t, b, `v${t}.y`)}) {
        let vo = v${t};
        v${t} = land(v${t}, k${t}, &rs);
        s${t} = true;${impactHeat(t, b, 'vo', '-vo.y')}
      } else if (mt && held) { s${t} = true; }
      if (mb && up && !${breaks(b, t, `v${b}.y`)}) {
        ${b === 0 ? '// (QUIRK: cell 0 keeps its velocity and takes no heat)' : `let vo = v${b};
        v${b}.y = 0.0;`}
        s${b} = true;${b === 0 ? '' : impactHeat(b, t, 'vo', 'vo.y')}
      }
    } else if (down || up) {
      let okDown = down && ${can(t, b, 0)};
      let okUp = up && ${can(b, t, 1)};
      if (okDown || okUp) {
        let pr = max(select(0.0, -v${t}.y, okDown), select(0.0, v${b}.y, okUp)) * ${drag(t, b)};
        if (rnd(&rs) < pr) ${swap(t, b)}
      } else if (!(v${b}.y > v${t}.y && shockActs(k${t}, k${b}, hitKE(d${t}, d${b}, false, v${b}.y - v${t}.y)))) {
        // blocked by another particle: collide (bottom is on the -y side).
        // (A hit that sets off an explosive is left as it is: react.js sees it.)
        let vt = v${t}.y;
        ${collide(b, t, 'y')}
        if (down) {
          if (KIND(k${t}) == K_LIQUID) { v${t} = land(vec3f(v${t}.x, vt, v${t}.z), k${t}, &rs) + vec3f(0.0, v${t}.y, 0.0); }
          s${t} = true;
        } else if (held) { s${t} = true; }
        if (up) { s${b} = true; }
      }
    } else if (held && !${can(t, b, 0)}) { s${t} = true; }
  }`;

// 2. diagonal topple: a blocked top cell falls diagonally (powders/liquids),
// a blocked bottom gas cell that is buoyant rises diagonally. Candidates are
// scored by the particle's horizontal velocity plus noise; the best open one wins.
const diagonal = (i) => {
  const top = (i & 2) !== 0;
  const xi = i & 1, zi = (i >> 2) & 1;
  const yo = top ? 0 : 2, po = top ? 2 : 0;
  const cols = [(1 - xi) + 4 * zi, xi + 4 * (1 - zi), (1 - xi) + 4 * (1 - zi)];
  const sx = (1 - 2 * xi).toFixed(1), sz = (1 - 2 * zi).toFixed(1);
  const dirs = [`v${i}.x * ${sx}`, `v${i}.z * ${sz}`, `(v${i}.x * ${sx} + v${i}.z * ${sz}) * 0.7071`];
  const ok = (c) => {
    const target = c + yo, path = c + po;
    const passable = top ? `isFluid(k${path}) && d${path} < d${i}` : `isFluid(k${path})`;
    return `!m${target} && ${passable} && ${can(i, target, top ? 0 : 1)}`;
  };
  // buoyant gases (not cloud, which rides the air)
  const kindOk = top ? '(kd == K_POWDER || kd == K_LIQUID)' : `(kd == K_GAS && GRAV(k${i}) < 0.0)`;
  const score = (n) => `
      var s${'ABC'[n]} = -9.0;
      if (${ok(cols[n])}) { s${'ABC'[n]} = ${dirs[n]} + rnd(&rs) * DIAG_NOISE; }`;
  return `
  if (s${i} && !m${i}) {
    let kd = KIND(k${i});
    if (${kindOk} && (kd != K_POWDER || rnd(&rs) <= SLIDE(k${i}))) {${score(0)}${score(1)}${score(2)}
      if (max(sA, max(sB, sC)) > -8.0) {
        if (sA >= sB && sA >= sC) ${swap(i, cols[0] + yo)}
        else if (sB >= sC) ${swap(i, cols[1] + yo)}
        else ${swap(i, cols[2] + yo)}
      }
    }
  }`;
};

// 3. horizontal exchange between i and its +axis neighbour j
const horizontal = (i, j, c) => `
  if (!m${i} && !m${j}) {
    let h0 = v${i}.${c};
    let h1 = v${j}.${c};
    let w0 = h0 > 0.0;
    let w1 = h1 < 0.0;
    if (w0 || w1) {
      let ok0 = w0 && ${can(i, j, 2)};
      let ok1 = w1 && ${can(j, i, 2)};
      if (ok0 || ok1) {
        let pr = max(select(0.0, h0, ok0), select(0.0, -h1, ok1)) * ${drag(i, j)};
        if (rnd(&rs) < pr) ${swap(i, j)}
      } else if (movable(k${i}) && movable(k${j})) {
        if (!(h0 > h1 && shockActs(k${i}, k${j}, hitKE(d${i}, d${j}, false, h0 - h1)))) ${collide(i, j, c)}
      } else {
        if (w0 && !${breaks(i, j, 'h0')}) {${i === 0 ? ' /* (QUIRK: cell 0 keeps its velocity and takes no heat) */ ' : `
          let vo = v${i};
          v${i}.${c} *= bounceR(k${i});${impactHeat(i, j, 'vo', 'h0')}
        `}}
        if (w1 && !${breaks(j, i, 'h1')}) {
          let vo = v${j};
          v${j}.${c} *= bounceR(k${j});${impactHeat(j, i, 'vo', '-h1')}
        }
      }
    }
  }`;
const horizontalX = () => [[0, 1], [2, 3], [4, 5], [6, 7]].map(([i, j]) => horizontal(i, j, 'x')).join('');
const horizontalZ = () => [[0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => horizontal(i, j, 'z')).join('');

const unrolled = () => ({
  decl: '',
  load: `
  ${CELLS.map((i) => `var a${i}: vec4f;
  var v${i}: vec3f;
  var k${i}: i32;
  var d${i}: f32;
  var n${i}: i32 = ${i};
  var q${i}: f32 = 0.0;
  var m${i} = false;
  var s${i} = false;`).join('\n  ')}
  ${CELLS.map((i) => `{
    let c = cellAt(base, ${i});
    if (inGrid(c)) { a${i} = fetchA(c); v${i} = fetchB(c).xyz; }
    else { a${i} = vec4f(f32(E_WALL), AMBIENT, 0.0, 0.0); v${i} = vec3f(0.0); }
    k${i} = eid(a${i});
    d${i} = densityOf(k${i}, a${i}.y);
  }`).join('\n  ')}`,
  solve: `
  // Columns are independent in the vertical phase, so a fixed order is fair.
  ${vertical(0, 2)}${vertical(1, 3)}${vertical(4, 6)}${vertical(5, 7)}

  // Diagonal order alternates so no direction is systematically favoured.
  if (rnd(&rs) < 0.5) {
    ${[2, 7, 3, 6, 0, 5, 1, 4].map(diagonal).join('')}
  } else {
    ${[6, 3, 7, 2, 4, 1, 5, 0].map(diagonal).join('')}
  }

  if (rnd(&rs) < 0.5) {
    ${horizontalX()}${horizontalZ()}
  } else {
    ${horizontalZ()}${horizontalX()}
  }`,
  // cell i's content after the solve: (state A, velocity, source index, impact heat)
  out: (i) => ({ a: `a${i}`, v: `v${i}`, n: `n${i}`, q: `q${i}` }),
  write: (body) => CELLS.map((i) => `{
    let i = ${i};
    let a = a${i};
    let vv = v${i};
    let src = n${i};
    let q = q${i};
    ${body}
  }`).join('\n  '),
});

// ---------------------------------------------------------------- the loop form
// The same rules, line for line and draw for draw, over the block held in
// arrays (Blk) and indexed at runtime: one function per rule, called in loops
// whose bounds the compiler doesn't know (P.eight), so each rule is compiled
// once. m and s are bit sets.
const loopDecl = /* wgsl */ `
struct Blk {
  a: array<vec4f, 8>,   // state A
  v: array<vec3f, 8>,   // velocity
  k: array<i32, 8>,     // element
  d: array<f32, 8>,     // density
  n: array<i32, 8>,     // the cell its content came from
  q: array<f32, 8>,     // impact heat (kinetic energy)
  m: u32,               // moved this step (bit i)
  s: u32,               // stopped: tried to fall or rise and hit something (bit i)
}
fn bit(i: i32) -> u32 { return 1u << u32(i); }
fn isM(b: ptr<function, Blk>, i: i32) -> bool { return ((*b).m & bit(i)) != 0u; }
fn isS(b: ptr<function, Blk>, i: i32) -> bool { return ((*b).s & bit(i)) != 0u; }
fn stop(b: ptr<function, Blk>, i: i32) { (*b).s |= bit(i); }
fn swapCells(b: ptr<function, Blk>, i: i32, j: i32) {
  let ta = (*b).a[i]; (*b).a[i] = (*b).a[j]; (*b).a[j] = ta;
  let tv = (*b).v[i]; (*b).v[i] = (*b).v[j]; (*b).v[j] = tv;
  let ti = (*b).k[i]; (*b).k[i] = (*b).k[j]; (*b).k[j] = ti;
  let tn = (*b).n[i]; (*b).n[i] = (*b).n[j]; (*b).n[j] = tn;
  let td = (*b).d[i]; (*b).d[i] = (*b).d[j]; (*b).d[j] = td;
  let tq = (*b).q[i]; (*b).q[i] = (*b).q[j]; (*b).q[j] = tq;
  (*b).m |= bit(i) | bit(j);
}
fn can(b: ptr<function, Blk>, i: i32, j: i32, dir: i32) -> bool { return canMove((*b).k[i], (*b).k[j], (*b).d[i], (*b).d[j], dir); }
fn dragOf(b: ptr<function, Blk>, i: i32, j: i32) -> f32 { return dragF((*b).k[i], (*b).k[j], (*b).d[i], (*b).d[j]); }
fn breaks(b: ptr<function, Blk>, i: i32, j: i32, vn: f32) -> bool { return impactActs((*b).k[i], (*b).k[j], 0.5 * (*b).d[i] * vn * vn); }
// Collision between particles i and j along component c (i on the negative
// side, j on the positive side). Fast impacts exchange momentum, weighted by
// density as mass, with restitution 0.3: this is what lets a blast or an
// impact travel through a pile like a Newton's cradle. Slow contact is just
// support: the approaching velocity is cancelled.
fn collide(b: ptr<function, Blk>, i: i32, j: i32, c: i32) {
  let rel = (*b).v[i][c] - (*b).v[j][c];
  if (rel > COLLIDE_V) {
    let mi = (*b).d[i];
    let mj = (*b).d[j];
    let inv = 1.0 / (mi + mj);
    let vc = (mi * (*b).v[i][c] + mj * (*b).v[j][c]) * inv;
    (*b).v[i][c] = vc - RESTITUTION * mj * inv * rel;
    (*b).v[j][c] = vc + RESTITUTION * mi * inv * rel;
  } else if (rel > 0.0) {
    if ((*b).v[i][c] > 0.0) { (*b).v[i][c] = 0.0; }
    if ((*b).v[j][c] < 0.0) { (*b).v[j][c] = 0.0; }
  }
}
// Particle i (velocity before vOld) was stopped by solid j: its lost kinetic
// energy, if it was a real impact by a grain, becomes heat shared by capacity.
fn impactHeat(b: ptr<function, Blk>, i: i32, j: i32, vOld: vec3f, speed: f32) {
  if (KIND((*b).k[i]) == K_POWDER && speed > COLLIDE_V) {
    let vi = (*b).v[i];
    let lost = max(0.5 * (*b).d[i] * (dot(vOld, vOld) - dot(vi, vi)), 0.0);
    let share = CAP((*b).k[i]) / (CAP((*b).k[i]) + CAP((*b).k[j]));
    (*b).q[i] += lost * share;
    (*b).q[j] += lost * (1.0 - share);
  }
}

// 1. vertical exchange within one column (bo = bottom, t = top). A top cell
// the react pass's normal force holds at rest (v.y = 0 under gravity) still
// presses on what's below, so where that is a dead end it is blocked and may
// topple (2) like a falling one; it just doesn't land again every step.
fn vertical(b: ptr<function, Blk>, bo: i32, t: i32, rs: ptr<function, u32>) {
  let mt = movable((*b).k[t]);
  let mb = movable((*b).k[bo]);
  let down = (*b).v[t].y < 0.0;
  let up = (*b).v[bo].y > 0.0;
  let held = (*b).v[t].y == 0.0 && GRAV((*b).k[t]) * P.gravity > 0.0;
  if (!mt || !mb) {
    if (mt && down && !breaks(b, t, bo, (*b).v[t].y)) {
      let vo = (*b).v[t];
      (*b).v[t] = land((*b).v[t], (*b).k[t], rs);
      stop(b, t);
      impactHeat(b, t, bo, vo, -vo.y);
    } else if (mt && held) { stop(b, t); }
    if (mb && up && !breaks(b, bo, t, (*b).v[bo].y)) {
      if (bo != 0) {   // (QUIRK, above: cell 0 keeps its velocity and takes no heat)
        let vo = (*b).v[bo];
        (*b).v[bo].y = 0.0;
        impactHeat(b, bo, t, vo, vo.y);
      }
      stop(b, bo);
    }
  } else if (down || up) {
    let okDown = down && can(b, t, bo, 0);
    let okUp = up && can(b, bo, t, 1);
    if (okDown || okUp) {
      let pr = max(select(0.0, -(*b).v[t].y, okDown), select(0.0, (*b).v[bo].y, okUp)) * dragOf(b, t, bo);
      if (rnd(rs) < pr) { swapCells(b, t, bo); }
    } else if (!((*b).v[bo].y > (*b).v[t].y && shockActs((*b).k[t], (*b).k[bo], hitKE((*b).d[t], (*b).d[bo], false, (*b).v[bo].y - (*b).v[t].y)))) {
      // blocked by another particle: collide (bottom is on the -y side).
      // (A hit that sets off an explosive is left as it is: react.js sees it.)
      let vt = (*b).v[t].y;
      collide(b, bo, t, 1);
      if (down) {
        if (KIND((*b).k[t]) == K_LIQUID) { (*b).v[t] = land(vec3f((*b).v[t].x, vt, (*b).v[t].z), (*b).k[t], rs) + vec3f(0.0, (*b).v[t].y, 0.0); }
        stop(b, t);
      } else if (held) { stop(b, t); }
      if (up) { stop(b, bo); }
    }
  } else if (held && !can(b, t, bo, 0)) { stop(b, t); }
}

// 2. diagonal topple: a blocked top cell falls diagonally (powders/liquids),
// a blocked bottom gas cell that is buoyant rises diagonally. Candidates are
// scored by the particle's horizontal velocity plus noise; the best open one wins.
// Candidate n of cell i (0: across x, 1: across z, 2: across both), in i's column's row.
fn diagCol(i: i32, n: i32) -> i32 {
  let xi = i & 1;
  let zi = (i >> 2u) & 1;
  if (n == 0) { return (1 - xi) + 4 * zi; }
  if (n == 1) { return xi + 4 * (1 - zi); }
  return (1 - xi) + 4 * (1 - zi);
}
// its score, or -9 if it isn't open (drawing noise only for an open one)
fn diagScore(b: ptr<function, Blk>, i: i32, n: i32, rs: ptr<function, u32>) -> f32 {
  let top = (i & 2) != 0;
  let c = diagCol(i, n);
  let to = c + select(2, 0, top);
  let path = c + select(0, 2, top);
  var passable = isFluid((*b).k[path]);
  if (top) { passable = passable && (*b).d[path] < (*b).d[i]; }
  if (!(!isM(b, to) && passable && can(b, i, to, select(1, 0, top)))) { return -9.0; }
  let sx = f32(1 - 2 * (i & 1));
  let sz = f32(1 - 2 * ((i >> 2u) & 1));
  var dir = (*b).v[i].x * sx;
  if (n == 1) { dir = (*b).v[i].z * sz; }
  if (n == 2) { dir = ((*b).v[i].x * sx + (*b).v[i].z * sz) * 0.7071; }
  return dir + rnd(rs) * DIAG_NOISE;
}
fn diagonal(b: ptr<function, Blk>, i: i32, rs: ptr<function, u32>) {
  if (!isS(b, i) || isM(b, i)) { return; }
  let top = (i & 2) != 0;
  let kd = KIND((*b).k[i]);
  // buoyant gases (not cloud, which rides the air)
  var kindOk = kd == K_GAS && GRAV((*b).k[i]) < 0.0;
  if (top) { kindOk = kd == K_POWDER || kd == K_LIQUID; }
  if (!(kindOk && (kd != K_POWDER || rnd(rs) <= SLIDE((*b).k[i])))) { return; }
  let sA = diagScore(b, i, 0, rs);
  let sB = diagScore(b, i, 1, rs);
  let sC = diagScore(b, i, 2, rs);
  if (max(sA, max(sB, sC)) > -8.0) {
    let yo = select(2, 0, top);
    if (sA >= sB && sA >= sC) { swapCells(b, i, diagCol(i, 0) + yo); }
    else if (sB >= sC) { swapCells(b, i, diagCol(i, 1) + yo); }
    else { swapCells(b, i, diagCol(i, 2) + yo); }
  }
}

// 3. horizontal exchange between i and its +axis neighbour j (axis c: 0 x, 2 z)
fn horizontal(b: ptr<function, Blk>, i: i32, j: i32, c: i32, rs: ptr<function, u32>) {
  if (isM(b, i) || isM(b, j)) { return; }
  let h0 = (*b).v[i][c];
  let h1 = (*b).v[j][c];
  let w0 = h0 > 0.0;
  let w1 = h1 < 0.0;
  if (!(w0 || w1)) { return; }
  let ok0 = w0 && can(b, i, j, 2);
  let ok1 = w1 && can(b, j, i, 2);
  if (ok0 || ok1) {
    let pr = max(select(0.0, h0, ok0), select(0.0, -h1, ok1)) * dragOf(b, i, j);
    if (rnd(rs) < pr) { swapCells(b, i, j); }
  } else if (movable((*b).k[i]) && movable((*b).k[j])) {
    if (!(h0 > h1 && shockActs((*b).k[i], (*b).k[j], hitKE((*b).d[i], (*b).d[j], false, h0 - h1)))) { collide(b, i, j, c); }
  } else {
    if (w0 && !breaks(b, i, j, h0) && i != 0) {   // (QUIRK, above: cell 0 keeps its velocity and takes no heat)
      let vo = (*b).v[i];
      (*b).v[i][c] *= bounceR((*b).k[i]);
      impactHeat(b, i, j, vo, h0);
    }
    if (w1 && !breaks(b, j, i, h1)) {
      let vo = (*b).v[j];
      (*b).v[j][c] *= bounceR((*b).k[j]);
      impactHeat(b, j, i, vo, -h1);
    }
  }
}
// The diagonal order (2, 7, 3, 6, 0, 5, 1, 4) a nibble each; the other order is it ^ 4.
const DIAG_ORDER: u32 = 0x41506372u;`;

const loop = () => ({
  decl: loopDecl,
  load: `
  var blk: Blk;
  for (var i = 0; i < i32(P.eight); i++) {
    let c = cellAt(base, i);
    if (inGrid(c)) { blk.a[i] = fetchA(c); blk.v[i] = fetchB(c).xyz; }
    else { blk.a[i] = vec4f(f32(E_WALL), AMBIENT, 0.0, 0.0); blk.v[i] = vec3f(0.0); }
    blk.k[i] = eid(blk.a[i]);
    blk.d[i] = densityOf(blk.k[i], blk.a[i].y);
    blk.n[i] = i;
    blk.q[i] = 0.0;
  }`,
  solve: `
  // Columns are independent in the vertical phase, so a fixed order is fair:
  // (0, 2), (1, 3), (4, 6), (5, 7).
  let four = i32(P.eight >> 1u);
  for (var c = 0; c < four; c++) {
    let lo = (c & 1) + 4 * (c >> 1u);
    vertical(&blk, lo, lo + 2, &rs);
  }
  // Diagonal order alternates so no direction is systematically favoured.
  let flip = select(4, 0, rnd(&rs) < 0.5);
  for (var x = 0; x < i32(P.eight); x++) {
    diagonal(&blk, i32((DIAG_ORDER >> (4u * u32(x))) & 15u) ^ flip, &rs);
  }
  // x pairs (0, 1), (2, 3), (4, 5), (6, 7) and z pairs (0, 4), (1, 5), (2, 6), (3, 7), in either order
  let xFirst = rnd(&rs) < 0.5;
  for (var h = 0; h < i32(P.eight); h++) {
    let c = h & 3;
    if ((h < four) == xFirst) { horizontal(&blk, 2 * c, 2 * c + 1, 0, &rs); }
    else { horizontal(&blk, c, c + 4, 2, &rs); }
  }`,
  write: (body) => `for (var i = 0; i < i32(P.eight); i++) {
    let a = blk.a[i];
    let vv = blk.v[i];
    let src = blk.n[i];
    let q = blk.q[i];
    ${body}
  }`,
});

/** The code forms the generator knows (docs/webgpu.md D2): one ships, MOVE_FORM. */
export const MOVE_FORMS = { unrolled, loop };
export const MOVE_FORM = 'loop';

/**
 * The move kernel (docs/webgpu.md D2): the name is the WebGL block pass's (W2).
 * @param {object} g grid
 * @param {{ form?: string, debug?: boolean, raceProbe?: boolean }} [opts]
 *   raceProbe: test only (sim.test.raceProbe, I2.10), a variant whose solve
 *   also reads a cell of the next block along x, a race in place
 */
export const moveBlockFrag = (g, { form = MOVE_FORM, debug = false, raceProbe = false } = {}) => {
  const f = MOVE_FORMS[form]();
  const u = sleepUnitOf(g);
  // the content's new state at cell c (heat-warmed), its flags, and where it came from
  const body = /* wgsl */ `let c = cellAt(base, i);
    if (inGrid(c)) {
      // the thread's own cell before the move: untouched until written here
      let aOld = fetchA(c);
      let bOld = fetchB(c);
      var fl = fetchF(c);
      var na = a;
      let heat = f32(i32(clamp(q, 0.0, HEAT_Q_MAX) * HEAT_QUANTA + 0.5)) / HEAT_QUANTA;   // impact energy this cell took
      if (heat > 0.0) { na.y = min(na.y + heat * KE_TO_HEAT / CAP(eid(na)), CELL_TEMP_MAX); }
      // activity flags are positional: the react pass after this one re-tests
      // the cell; mark it dirty if the move changed what its neighbours' tests
      // read (shaders/common.js FLAG)
      if (P.fresh != 0u) { fl &= ~FLAG_DIRTY; }
      if (nearChange(aOld, na)) { fl |= FLAG_DIRTY; }
      // velocity moves with the content, pressure stays with the position
      writeState(c, na, vec4f(vv, bOld.w), fl);
      if (P.outOfPlace != 0u) { moveSrc[slotOf(c)] = u32(src); }
      if (!quietCell(c)) { blendFlow(c, vec3f(c - cellAt(base, src))); }
    }`;
  return /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${MoveParams.wgsl}
@group(3) @binding(1) var<uniform> P: MoveParams;
@group(2) @binding(0) var<storage, read_write> flow: array<vec2u>;   // per slot: 3 × f16 (pack2x16float) + 0
@group(2) @binding(1) var<storage, read_write> moveSrc: array<u32>;  // per slot: the source cell 0..7 (out of place only)
const HEAT_QUANTA: f32 = ${HEAT_QUANTA.toFixed(1)};
const HEAT_Q_MAX: f32 = ${HEAT_Q_MAX.toFixed(1)};
const FLOW_BLEND: f32 = ${FLOW_BLEND};
const NMARGIN: u32 = ${marginBlocks(g)}u;
const BLOCKS_PER_UNIT: u32 = ${8 * u.bricks}u;   // home blocks of a sleeping unit

// Moving through a liquid is slower than through air.
fn dragF(a: i32, b: i32, da: f32, db: f32) -> f32 {
  let la = KIND(a) == K_LIQUID;
  let lb = KIND(b) == K_LIQUID;
  if ((la && !isGasLike(b)) || (lb && !isGasLike(a))) {
    return DRAG_LIQUID_MIN + DRAG_LIQUID_SPAN * clamp(DRAG_LIQUID_DENS * abs(da - db) / max(da, db), 0.0, 1.0);
  }
  return 1.0;
}

// A particle tried to fall and hit something.
fn land(vIn: vec3f, id: i32, rs: ptr<function, u32>) -> vec3f {
  var v = vIn;
  let vy = v.y;
  v.y = 0.0;
  if (KIND(id) == K_LIQUID && vy < -LAND_SPLASH_V) {
    // A real impact: liquids convert vertical momentum into a sideways splash.
    // (Resting liquid gets its flow from the react pass instead.)
    var h = v.xz;
    let f = FLOW(id);
    if (dot(h, h) < f * f * LAND_SPLASH_FLOW) {
      let ang = rnd(rs) * 6.2831853;
      h = vec2f(cos(ang), sin(ang)) * f;
    }
    h += normalize(h) * (-vy) * LAND_SPLASH_GAIN;
    h = clamp(h, vec2f(-V_MAX), vec2f(V_MAX));
    v = vec3f(h.x, v.y, h.y);
  } else if (KIND(id) == K_POWDER) {
    // Grains scatter a little when they land hard, then friction takes over.
    let ang = rnd(rs) * 6.2831853;
    let h = v.xz * LAND_POWDER_KEEP + vec2f(cos(ang), sin(ang)) * (-vy) * LAND_POWDER_SCATTER;
    v = vec3f(h.x, v.y, h.y);
  }
  return v;
}

fn bounceR(id: i32) -> f32 {
  let k = KIND(id);
  if (k == K_LIQUID) { return BOUNCE_LIQUID; }
  if (k == K_POWDER) { return 0.0; }
  return BOUNCE_GAS;
}

fn cellAt(base: vec3i, i: i32) -> vec3i { return base + vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1); }

// The flow field: three half floats per slot, blended toward how far the
// content at c moved this step.
fn blendFlow(c: vec3i, moved: vec3f) {
  let s = slotOf(c);
  let w = flow[s];
  let old = vec3f(unpack2x16float(w.x), unpack2x16float(w.y).x);
  let nf = mix(old, moved, FLOW_BLEND);
  flow[s] = vec2u(pack2x16float(nf.xy), pack2x16float(vec2f(nf.z, 0.0)));
}

// Low-margin block t's block coordinate j (its base cell is 2·j + 1).
fn marginBlock(t: u32) -> vec3i {
  let h = vec3i(NX, NY, NZ) / 2;
  let ti = i32(t);
  let ax = (h.y + 1) * (h.z + 1);
  if (ti < ax) { return vec3i(-1, ti % (h.y + 1) - 1, ti / (h.y + 1) - 1); }
  let t1 = ti - ax;
  let ay = h.x * (h.z + 1);
  if (t1 < ay) { return vec3i(t1 % h.x, -1, t1 / h.x - 1); }
  let t2 = t1 - ay;
  return vec3i(t2 % h.x, t2 / h.x, -1);
}
${f.decl}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let par = i32(P.parity);
  let t = foldId(wg, nwg) * 64u + select(li, 63u - li, P.blockRev != 0u);
  var base: vec3i;
  if (P.margin != 0u) {
    if (t >= NMARGIN) { return; }
    base = 2 * marginBlock(t) + 1;
  } else {
    // entry e of the offset's list, and the unit's home block kb
    let e = t / BLOCKS_PER_UNIT;
    var list = ACT_DRAWNL;
    var cnt = CNT_DRAWN;
    if (par == 1) { list = ACT_MOVE1L; cnt = CNT_MOVE1; }
    if (e >= act[ACT_COUNT + cnt]) { return; }
    let kb = t % BLOCKS_PER_UNIT;
    let brick = act[list + e] * UNIT_B + kb / 8u;
    let k = i32(kb % 8u);
    base = 4 * brickCoord(brick) + 2 * vec3i(k & 1, (k >> 1u) & 1, k >> 2u) + par;
  }
  // it runs if a cell of it lies in a unit this map's steps draw
  var run = false;
  for (var i = 0; i < 8; i++) {
    let c = cellAt(base, i);
    if (inGrid(c) && drawnUnit(unitOfCell(c))) { run = true; }
  }
  if (!run) { return; }

  if (quietCell(base)) {
    // it stays put: flags settle, flow blends toward still (in a brick that isn't quiet)
    for (var i = 0; i < 8; i++) {
      let c = cellAt(base, i);
      if (!inGrid(c)) { continue; }
      let f0 = fetchF(c);
      var fl = f0;
      if (P.fresh != 0u) { fl &= ~FLAG_DIRTY; }
      if (P.outOfPlace != 0u) {
        writeState(c, fetchA(c), fetchB(c), fl);
        moveSrc[slotOf(c)] = u32(i);
      } else if (fl != f0) {
        writeFlags(c, fl);
      }
      if (!quietCell(c)) { blendFlow(c, vec3f(0.0)); }
    }
    return;
  }
  ${f.load}
  var rs = seed3(base, P.frame, 0x51u);${raceProbe ? `
  // RACE PROBE (test only, docs/webgpu.md I2.10): a cell of the next block
  // along x, which its own thread may already have moved, feeds the stream
  { let r = base + vec3i(2, 0, 0); if (inGrid(r)) { rs ^= bitcast<u32>(fetchA(r).y); } }` : ''}
${f.solve}

  ${f.write(body)}
}
`;
};

const layouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RW, MOVE_LAYOUT];
// the margin's direct dispatch (the lists' are indirect, at most every unit's home blocks)
const dispatch = (g) => [fold(Math.ceil(marginBlocks(g) / 64)), fold(Math.ceil(gridDims(g).nbricks * 8 / 64))];
/**
 * tools/check-wgsl.mjs, and the pipeline a grid needs (the start menu's
 * warm-up, docs/webgpu.md B5). The unrolled form only the sim bench builds
 * (tools/harness/sim-bench.js, Mac checkpoint M1), never a session: `tool`.
 */
export const WGSL_CHECK = [
  { name: 'move', kind: 'compute', code: (g) => moveBlockFrag(g), layouts, dispatch },
  { name: 'moveUnrolled', kind: 'compute', code: (g) => moveBlockFrag(g, { form: 'unrolled' }), layouts, dispatch, tool: true },
];

// WEBGPU-STUB (docs/webgpu.md J3): the gather and flow passes are fused into
// the move (D2); the slot array they read is gone.
export const slotGLSL = '';
// WEBGPU-STUB (docs/webgpu.md J3)
export function moveGatherFrag() { throw new Error('moveGatherFrag removed in the WebGPU port: docs/webgpu.md D2'); }
// WEBGPU-STUB (docs/webgpu.md J3)
export function moveFlowFrag() { throw new Error('moveFlowFrag removed in the WebGPU port: docs/webgpu.md D2'); }
