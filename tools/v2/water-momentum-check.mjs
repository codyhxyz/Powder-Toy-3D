// CPU witness for resident water momentum (docs/v2/water-momentum.md): the CPU prototype
// (tools/v2/lean-sim.mjs) with Stelling and Duinmeijer's energy-head advection on its face fluxes,
// against the unchanged outcome bench (tools/outcomes). Node only: no GPU, browser or World
// variant of the application. It changes no production physics.
//   1. default off: the recorded prototype hole result is reproduced exactly
//   2. rest: a resting state is a bit-exact fixed point with the term on (zero faces, zero term)
//   3. outlet: discharge and launch speed against Torricelli, per 0.25 s, both models
//   4. the bench's liquid controls (U-tube, still tank, partial pool, puddle, pipe, census) and the
//      hole, with the term on, at their unchanged thresholds
//   5. SPLASH becomes expressible: the model's own cell velocity (the upwind face per axis)
// usage: node tools/v2/water-momentum-check.mjs [--hole]   (--hole: sections 1 and 3 only)
// Attribution of the remaining jet shortfall to the existing linear drag (a diagnostic, not a
// proposal): DAMP=0.005 node tools/v2/water-momentum-check.mjs --hole
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World, AIR, WALL, WATER, FULL, TICK_HZ, SUB, CELL_M, G_CELLS, DAMP } from './lean-sim.mjs';
import { runTest } from '../outcomes/run.js';
import { createEngine } from '../outcomes/engine-lean.js';
import { TESTS } from '../outcomes/tests/index.js';

const HOLE_ONLY = process.argv.includes('--hole');
const DEFAULT_DAMP = 0.01;                      // lean-sim's DAMP, today's water drag row
const WINDOW_TICKS = 15;                        // 0.25 s windows, the hole outcome's own window
const STEADY_S = 2;                             // after the uncompressed start's acoustic ringing has decayed
// Torricelli's ideal orifice (discharge coefficient 1) bounds an energy-conserving outflow from above;
// the original pipe model exceeds it several times (DEFECT_RATIO), the Bernoulli model must not
const TORRICELLI_BOUND = 1;
const DEFECT_RATIO = 3;
const DRAINS_RATIO = 0.8;                       // and it still drains: no stagnation at the hole
const REST_TICKS = 120;                         // the still tank's own two game seconds
const recorded = JSON.parse(readFileSync(fileURLToPath(new URL('../outcomes/expected-lean.json', import.meta.url)), 'utf8'));
const r2 = (x) => Math.round(x * 100) / 100;

// Options are World properties (lean-sim: `bernoulli`, `launch`); the engine adapter builds its own
// World, so a run sets them on the prototype and restores them after.
async function withModel({ bernoulli = false, launch = 'head' }, fn) {
  const saved = [World.prototype.bernoulli, World.prototype.launch];
  World.prototype.bernoulli = bernoulli; World.prototype.launch = launch;
  try { return await fn(); } finally { [World.prototype.bernoulli, World.prototype.launch] = saved; }
}
const test = (name) => TESTS.find((t) => t.name === name);
const crit = (r, prefix) => r.criteria.find((c) => c.name.startsWith(prefix));

// ---- 1. default off --------------------------------------------------------------------------
const holeDefault = await withModel({}, () => runTest(test('hole'), createEngine()));
const reachDefault = crit(holeDefault, 'reach').measured;
if (DAMP === DEFAULT_DAMP) {
  assert.equal(reachDefault, crit({ criteria: recorded.tests.hole.criteria }, 'reach').measured, 'default prototype reproduces its recorded hole');
  console.log(`1. default off: hole ${holeDefault.status}, worst reach ${reachDefault} % (recorded ${crit({ criteria: recorded.tests.hole.criteria }, 'reach').measured} %)`);
} else console.log(`1. DAMP=${DAMP} (diagnostic): default hole worst reach ${reachDefault} %`);

// ---- 2. rest is a fixed point ----------------------------------------------------------------
function settledTank() {
  const w = new World(16, 8, 16);
  w.box(0, 0, 0, 15, 7, 15, WALL); w.box(1, 1, 1, 14, 7, 14, AIR); w.box(1, 1, 1, 14, 4, 14, WATER);
  for (let t = 0; t < 30 * TICK_HZ && w.idleAt < 0; t++) w.step();
  assert(w.idleAt >= 0, 'the tank comes to rest under the default model');
  return w;
}
function clone(w, bernoulli) {
  const c = new World(w.nx, w.ny, w.nz); c.bernoulli = bernoulli;
  for (const k of ['id', 'fill', 'qx', 'qy', 'qz', 'vy', 'acc']) c[k].set(w[k]);
  return c;
}
if (!HOLE_ONLY) {
  const base = settledTank(), off = clone(base, false), on = clone(base, true);
  for (let t = 0; t < REST_TICKS; t++) { off.step(); on.step(); }
  for (const k of ['id', 'fill', 'qx', 'qy', 'qz']) assert.deepEqual(on[k], off[k], `rest: ${k} identical with the term on`);
  assert(on.qx.every((q) => q === 0) && on.qy.every((q) => q === 0) && on.qz.every((q) => q === 0), 'rest: every face stays zero');
  console.log(`2. rest: a settled tank steps ${REST_TICKS} ticks bit-identically with the term on (all faces zero, so its kinetic head is zero)`);
}

// ---- 3. the outlet ---------------------------------------------------------------------------
// the hole outcome's scene (tools/outcomes/tests/liquids.js hole): a 7×6 tank, 18 deep, 1-cell hole at x 8, y 14, z 3
function holeScene(model) {
  const w = new World(48, 32, 8); Object.assign(w, model);
  w.box(0, 0, 0, 8, 31, 7, WALL); w.box(1, 13, 1, 7, 31, 6, AIR); w.box(1, 13, 1, 7, 30, 6, WATER); w.box(8, 14, 3, 8, 14, 3, AIR);
  return w;
}
function outlet(model, seconds = 4) {
  const w = holeScene(model), EXIT_X = 9, EXIT_Y = 14.5, hole = w.at(8, 14, 3);
  const tank = () => { let m = 0; for (let y = 13; y < 32; y++) for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) { const i = w.at(x, y, z); if (w.id[i] === WATER) m += w.fill[i]; } return m / FULL; };
  const level = () => { let s = 0; for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) { let t = 0; for (let y = 13; y < 32; y++) { const i = w.at(x, y, z); if (w.id[i] === WATER) t = y + Math.min(w.fill[i], FULL) / FULL; } s += t; } return s / 42; };
  const rows = []; let acc = null, m0 = tank();
  const reset = () => { acc = { births: 0, mv: 0, m: 0, vT: 0, face: 0, k: 0 }; };
  reset();
  for (let t = 1; t <= seconds * TICK_HZ; t++) {
    const vT = Math.sqrt(2 * G_CELLS * Math.max(level() - EXIT_Y, 0));
    // births at the hole's outer face, read as they are pushed (they fly within the same tick)
    w.parts.push = function (p) { if (p.x === EXIT_X && p.y === EXIT_Y) { acc.births++; acc.m += p.m; acc.mv += p.m * p.vx; } return Array.prototype.push.call(this, p); };
    w.step();
    acc.vT += vT; acc.face += (w.qx[hole] / FULL) * TICK_HZ * SUB; acc.k++;
    if (t % WINDOW_TICKS === 0) {
      const m = tank(), vTm = acc.vT / acc.k;
      rows.push({ t: t / TICK_HZ, head: level() - EXIT_Y, discharge: ((m0 - m) * TICK_HZ / WINDOW_TICKS) / vTm, launch: acc.m ? acc.mv / acc.m / vTm : NaN, face: acc.face / acc.k / vTm });
      m0 = m; reset();
    }
  }
  return rows;
}
const show = (rows) => rows.map((r) => `${r2(r.t)}s ${r2(r.discharge)}/${Number.isNaN(r.launch) ? '-' : r2(r.launch)}/${r2(r.face)}`).join('  ');
const linear = outlet({}), bern = outlet({ bernoulli: true, launch: 'face' }), bernTotal = outlet({ bernoulli: true, launch: 'total' });
console.log('3. outlet, per 0.25 s: discharge / A√(2gh), launch at birth / √(2gh), outlet face speed / √(2gh)');
console.log(`   pipe model:      ${show(linear)}`);
console.log(`   + energy head:   ${show(bern)}`);
console.log(`   (total-head launch: ${bernTotal.filter((r) => r.t >= STEADY_S).map((r) => r2(r.launch)).join(' ')} from ${STEADY_S} s)`);
assert(Math.max(...linear.map((r) => r.discharge)) > DEFECT_RATIO, 'the original pipe model over-discharges the hole (the defect this fixes)');
for (const r of bern.filter((r) => r.t >= STEADY_S)) {
  assert(r.discharge <= TORRICELLI_BOUND && r.discharge >= DRAINS_RATIO, `steady discharge within Torricelli's bound at ${r.t} s: ${r.discharge}`);
  assert(r.launch <= TORRICELLI_BOUND, `a face launch carries no more than the released head at ${r.t} s: ${r.launch}`);
}
if (HOLE_ONLY) {
  for (const launch of ['face', 'total']) {
    const r = await withModel({ bernoulli: true, launch }, () => runTest(test('hole'), createEngine()));
    console.log(`   hole outcome, energy head + ${launch} launch: ${r.evidence[0].split('\n').map((l) => l.replace(/ \(16 steps\)| \[.*\]|; unbroken.*/g, '')).join('; ')}`);
  }
  process.exit(0);
}

// ---- 4. the bench's liquid controls ----------------------------------------------------------
console.log('4. outcome bench on the prototype with the term on (unchanged thresholds):');
for (const name of ['utube', 'tankStill', 'partial', 'puddle', 'pipe', 'census']) {
  const r = await withModel({ bernoulli: true, launch: 'face' }, () => runTest(test(name), createEngine()));
  const was = recorded.tests[name];
  console.log(`   ${name}: ${r.status} | ${r.criteria.map((c) => `${c.name.slice(0, 32)} ${c.measured}`).join('; ')} | recorded ${was.status}: ${was.criteria.map((c) => c.measured).join(', ')}`);
  assert.equal(r.status, 'pass', `${name} still passes with the term on`);
}
for (const launch of ['face', 'total']) {
  const r = await withModel({ bernoulli: true, launch }, () => runTest(test('hole'), createEngine()));
  assert(crit(r, 'mass').ok && crit(r, 'one unbroken').ok, `hole (${launch}): exact mass, one unbroken stream`);
  console.log(`   hole, ${launch} launch: ${r.status}, worst reach ${crit(r, 'reach').measured} % (limit 5; default model ${reachDefault} %): ${r.evidence[0].split('\n').map((l) => l.replace(/ s ± 0.125 s \(16 steps\)| \[.*\]|; unbroken.*|head |cells; the stream /g, '').replace(' % off the √(2gh) parabola', ' %')).join('; ')}`);
}

// ---- 5. SPLASH is expressible ----------------------------------------------------------------
// The model's cell velocity is its upwind face per axis (the velocity whose ½û² the term uses), in m/s.
{
  let world = null;
  const step = World.prototype.step;
  World.prototype.step = function () { world = this; return step.call(this); };
  const e = createEngine(), read = e.read.bind(e), create = e.create.bind(e);
  e.info.velocity = true;
  e.create = async (size) => { await create(size); world = null; };
  e.read = async () => {
    const g = await read(), w = world, s = (TICK_HZ * SUB / FULL) * CELL_M, Q = w ? [w.qx, w.qy, w.qz] : null;
    g.vel = new Float32Array(3 * g.nx * g.ny * g.nz);
    if (w) for (let y = 0; y < w.ny; y++) for (let z = 0; z < w.nz; z++) for (let x = 0; x < w.nx; x++) {
      const c = w.at(x, y, z), d = [[x - 1, y, z], [x, y - 1, z], [x, y, z - 1]];
      for (let a = 0; a < 3; a++) {
        const qm = w.inside(...d[a]) ? Q[a][w.at(...d[a])] : 0, qp = Q[a][c];
        g.vel[3 * c + a] = (qm + qp > 0 ? qm : qm + qp < 0 ? qp : 0) * s;
      }
    }
    return g;
  };
  try {
    const r = await withModel({ bernoulli: true, launch: 'face' }, () => runTest(test('splash'), e));
    assert.notEqual(r.status, 'error', `splash runs with known, finite velocities: ${r.reason}`);
    console.log(`5. splash: expressible (${r.status}); ${r.headline}`);
    console.log(`   not a SPLASH result: the block "meets" the pool at ${r2(r.numbers.vIn)} m/s, not free fall's ${r2(r.numbers.vIdeal)}: the explicit transport sends a ${r2(0.002 * 100)} % sliver down a cell a substep, in both models, so contact fires early`);
  } finally { World.prototype.step = step; }
}
console.log('CPU prototype only: no GPU, native WGSL or application physics changes; complete native velocity stays false.');
