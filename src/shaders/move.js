import { prelude, stateOutGLSL } from './common.js';
import { quietGLSL } from './activity.js';

// Movement pass: Margolus block cellular automaton.
//
// The grid is partitioned into 2×2×2 blocks; the partition shifts by one cell
// on every step (uParity). Every fragment loads its whole block, runs the
// *same* deterministic block update (all randomness is seeded from the block
// coordinate + frame), then writes out its own cell. Because a block is only
// ever permuted, mass is conserved exactly and two particles can never claim
// the same cell — the classic GPU falling-sand race condition can't happen.
//
// Movement is velocity driven: each particle carries a velocity (cells/step)
// integrated in the react pass (gravity, buoyancy, pressure, drag). Here a
// particle attempts to move along each axis with probability |v|, and a
// density test decides whether it can displace its neighbour. Blocked
// particles get collision responses: powders topple diagonally, liquids turn
// their fall into horizontal flow, gases slide along ceilings.
//
// To avoid solving every block 8 times (once per cell), the block pass runs
// at block resolution and writes, for each of the 8 destination slots, which
// source cell lands there plus its new velocity (8 MRT attachments). A cheap
// gather pass then rebuilds the state at cell resolution, each cell reading
// its slot (slotGLSL postMove). (Folding the gather into the react pass, which
// would read the moved state of the cell and its 6 neighbours through the
// slots, was measured slower: 7 slot lookups of 3 fetches each per cell cost
// more than writing the moved state once and reading it back.)
//
// Impacts on solids. A grain that slams into a solid (faster than COLLIDE_V,
// the line between an impact and resting contact) stops, and the kinetic
// energy it loses becomes heat (physics.js KE_TO_HEAT), shared between it and
// the solid so both warm by the same amount. Liquids splash and flow on and
// gases bounce, so their motion isn't counted. A grain whose impact would
// break the solid isn't stopped at all: the react pass after this one breaks
// the solid and charges the grain for it (react.js). The heat rides out of the
// block pass packed into each slot's source index (see packSlot).
//
// The block update is generated in JS with every cell index baked in as a
// literal, and the 8 cells live in plain named variables (a0..a7 etc). GPU
// compilers don't reliably inline helpers that index arrays, and dynamic
// indexing spills the whole block to memory — this layout keeps it all in
// registers and is several times faster.

// Cell i lives at local (x, y, z) = (i & 1, (i >> 1) & 1, (i >> 2) & 1).
const CELLS = [0, 1, 2, 3, 4, 5, 6, 7];

// Impact heat leaves the block pass in each slot's first channel next to the
// source index: n + SLOTS·round(q·HEAT_QUANTA), q in kinetic-energy units.
// A float holds integers exactly up to 2^24, so with this resolution q tops
// out at 2^24 / 8 / 1024 ≈ 2048, far above anything a step can deposit.
export const SLOTS = 8;   // a block's cells, and so its slots
const HEAT_QUANTA = 1024;   // quanta per unit of kinetic energy (resolution ≈ 0.001)
const HEAT_Q_MAX = Math.floor((2 ** 24 / SLOTS - 1) / HEAT_QUANTA);
const heatGLSL = /* glsl */ `
#define SLOTS ${SLOTS}
#define HEAT_QUANTA ${HEAT_QUANTA}.0
#define HEAT_Q_MAX ${HEAT_Q_MAX}.0
`;

const swap = (i, j) => `{
    vec4 ta = a${i}; a${i} = a${j}; a${j} = ta;
    vec3 tv = v${i}; v${i} = v${j}; v${j} = tv;
    int ti = k${i}; k${i} = k${j}; k${j} = ti;
    int tn = n${i}; n${i} = n${j}; n${j} = tn;
    float td = d${i}; d${i} = d${j}; d${j} = td;
    float tq = q${i}; q${i} = q${j}; q${j} = tq;
    m${i} = true; m${j} = true;
  }`;
// Collision between particles i and j along component c (i on the negative
// side, j on the positive side). Fast impacts exchange momentum, weighted by
// density as mass, with restitution 0.3 — this is what lets a blast or an
// impact travel through a pile like a Newton's cradle. Slow contact is just
// support: the approaching velocity is cancelled.
const collide = (i, j, c) => `{
      float rel = v${i}.${c} - v${j}.${c};
      if (rel > COLLIDE_V) {
        float mi = d${i}, mj = d${j}, inv = 1.0 / (mi + mj);
        float vc = (mi * v${i}.${c} + mj * v${j}.${c}) * inv;
        v${i}.${c} = vc - RESTITUTION * mj * inv * rel;
        v${j}.${c} = vc + RESTITUTION * mi * inv * rel;
      } else if (rel > 0.0) {
        if (v${i}.${c} > 0.0) v${i}.${c} = 0.0;
        if (v${j}.${c} < 0.0) v${j}.${c} = 0.0;
      }
    }`;

// Particle i (velocity before vOld) was stopped by solid j: its lost kinetic
// energy, if it was a real impact by a grain, becomes heat shared by capacity.
const impactHeat = (i, j, vOld, speed) => `
      if (KIND[k${i}] == K_POWDER && ${speed} > COLLIDE_V) {
        float lost = max(0.5 * d${i} * (dot(${vOld}, ${vOld}) - dot(v${i}, v${i})), 0.0);
        float share = CAP[k${i}] / (CAP[k${i}] + CAP[k${j}]);
        q${i} += lost * share; q${j} += lost * (1.0 - share);
      }`;
// Would particle i, moving at vn along the axis toward solid j, break it?
// Then leave it be: the react pass breaks j and charges i for it.
const breaks = (i, j, vn) => `(BREAKINTO[k${j}] >= 0 && 0.5 * d${i} * ${vn} * ${vn} >= HARD[k${j}])`;

const can = (i, j, dir) => `canMove(k${i}, k${j}, d${i}, d${j}, ${dir})`;
const drag = (i, j) => `dragF(k${i}, k${j}, d${i}, d${j})`;

// 1. vertical exchange within one column (b = bottom, t = top). A top cell the
// react pass's normal force holds at rest (v.y = 0 under gravity) still
// presses on what's below, so where that is a dead end it is blocked and may
// topple (2) like a falling one; it just doesn't land again every step.
const vertical = (b, t) => `
  {
    bool mt = movable(k${t}), mb = movable(k${b});
    bool down = v${t}.y < 0.0, up = v${b}.y > 0.0;
    bool held = v${t}.y == 0.0 && GRAV[k${t}] * uGravity > 0.0;
    if (!mt || !mb) {
      if (mt && down && !${breaks(t, b, `v${t}.y`)}) {
        vec3 v0 = v${t};
        v${t} = land(v${t}, k${t}); s${t} = true;${impactHeat(t, b, 'v0', '-v0.y')}
      } else if (mt && held) s${t} = true;
      if (mb && up && !${breaks(b, t, `v${b}.y`)}) {
        vec3 v0 = v${b};
        v${b}.y = 0.0; s${b} = true;${impactHeat(b, t, 'v0', 'v0.y')}
      }
    } else if (down || up) {
      bool okDown = down && ${can(t, b, 0)};
      bool okUp = up && ${can(b, t, 1)};
      if (okDown || okUp) {
        float pr = max(okDown ? -v${t}.y : 0.0, okUp ? v${b}.y : 0.0) * ${drag(t, b)};
        if (rnd(rs) < pr) ${swap(t, b)}
      } else {
        // blocked by another particle: collide (bottom is on the -y side)
        float vt = v${t}.y;
        ${collide(b, t, 'y')}
        if (down) { if (KIND[k${t}] == K_LIQUID) v${t} = land(vec3(v${t}.x, vt, v${t}.z), k${t}) + vec3(0.0, v${t}.y, 0.0); s${t} = true; }
        else if (held) s${t} = true;
        if (up) s${b} = true;
      }
    } else if (held && !${can(t, b, 0)}) s${t} = true;
  }`;

// 2. diagonal topple: a blocked top cell falls diagonally (powders/liquids),
// a blocked bottom gas cell that is buoyant rises diagonally. Candidates are scored by the
// particle's horizontal velocity plus noise; the best open one wins.
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
    return `(!m${target} && ${passable} && ${can(i, target, top ? 0 : 1)})`;
  };
  const kindOk = top ? `(kd == K_POWDER || kd == K_LIQUID)` : `(kd == K_GAS && GRAV[k${i}] < 0.0)`;   // buoyant gases (not cloud, which rides the air)
  return `
  if (s${i} && !m${i}) {
    int kd = KIND[k${i}];
    if (${kindOk} && (kd != K_POWDER || rnd(rs) <= SLIDE[k${i}])) {
      float sA = ${ok(cols[0])} ? ${dirs[0]} + rnd(rs) * DIAG_NOISE : -9.0;
      float sB = ${ok(cols[1])} ? ${dirs[1]} + rnd(rs) * DIAG_NOISE : -9.0;
      float sC = ${ok(cols[2])} ? ${dirs[2]} + rnd(rs) * DIAG_NOISE : -9.0;
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
    float h0 = v${i}.${c}, h1 = v${j}.${c};
    bool w0 = h0 > 0.0, w1 = h1 < 0.0;
    if (w0 || w1) {
      bool ok0 = w0 && ${can(i, j, 2)};
      bool ok1 = w1 && ${can(j, i, 2)};
      if (ok0 || ok1) {
        float pr = max(ok0 ? h0 : 0.0, ok1 ? -h1 : 0.0) * ${drag(i, j)};
        if (rnd(rs) < pr) ${swap(i, j)}
      } else if (movable(k${i}) && movable(k${j})) {
        ${collide(i, j, c)}
      } else {
        if (w0 && !${breaks(i, j, 'h0')}) { vec3 v0 = v${i}; v${i}.${c} *= bounceR(k${i});${impactHeat(i, j, 'v0', 'h0')} }
        if (w1 && !${breaks(j, i, 'h1')}) { vec3 v0 = v${j}; v${j}.${c} *= bounceR(k${j});${impactHeat(j, i, 'v0', '-h1')} }
      }
    }
  }`;
const horizontalX = () => [[0, 1], [2, 3], [4, 5], [6, 7]].map(([i, j]) => horizontal(i, j, 'x')).join('');
const horizontalZ = () => [[0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => horizontal(i, j, 'z')).join('');

export const moveBlockFrag = (g) => /* glsl */ `
${prelude(g)}
uniform int uParity;
uniform uint uFrame;
uniform float uGravity;
${CELLS.map((i) => `layout(location = ${i}) out vec4 o${i};`).join('\n')}
${quietGLSL}
${heatGLSL}
uint rs;

// Moving through a liquid is slower than through air.
float dragF(int a, int b, float da, float db) {
  bool la = KIND[a] == K_LIQUID, lb = KIND[b] == K_LIQUID;
  if ((la && !isGasLike(b)) || (lb && !isGasLike(a)))
    return DRAG_LIQUID_MIN + DRAG_LIQUID_SPAN * clamp(DRAG_LIQUID_DENS * abs(da - db) / max(da, db), 0.0, 1.0);
  return 1.0;
}

// A particle tried to fall and hit something.
vec3 land(vec3 v, int id) {
  float vy = v.y;
  v.y = 0.0;
  if (KIND[id] == K_LIQUID && vy < -LAND_SPLASH_V) {
    // A real impact: liquids convert vertical momentum into a sideways splash.
    // (Resting liquid gets its flow from the react pass instead.)
    vec2 h = v.xz;
    float f = FLOW[id];
    if (dot(h, h) < f * f * LAND_SPLASH_FLOW) {
      float ang = rnd(rs) * 6.2831853;
      h = vec2(cos(ang), sin(ang)) * f;
    }
    h += normalize(h) * (-vy) * LAND_SPLASH_GAIN;
    v.xz = clamp(h, -V_MAX, V_MAX);
  } else if (KIND[id] == K_POWDER) {
    // Grains scatter a little when they land hard, then friction takes over.
    float ang = rnd(rs) * 6.2831853;
    v.xz = v.xz * LAND_POWDER_KEEP + vec2(cos(ang), sin(ang)) * (-vy) * LAND_POWDER_SCATTER;
  }
  return v;
}

float bounceR(int id) {
  int k = KIND[id];
  return k == K_LIQUID ? BOUNCE_LIQUID : (k == K_POWDER ? 0.0 : BOUNCE_GAS);
}

// A slot's source index (0..7) and the impact heat its cell picked up, in one float.
float packSlot(int n, float q) {
  return float(n + SLOTS * int(clamp(q, 0.0, HEAT_Q_MAX) * HEAT_QUANTA + 0.5));
}

void main() {
  bool valid;
  ivec3 j = blockFromFrag(ivec2(gl_FragCoord.xy), valid);
  // a texel holding no block (the low margin's blocks exist at offset 1 only)
  if (!valid || (uParity == 0 && any(lessThan(j, ivec3(0))))) {
    ${CELLS.map((i) => `o${i} = vec4(0.0);`).join(' ')}
    return;
  }
  ivec3 base = 2 * j + ivec3(uParity);
  // A block whose base cell is in a quiet brick (shaders/activity.js) lies
  // within that brick's inert halo: it stays put, velocities and all.
  if (quietCell(base)) {
    ${CELLS.map((i) => `{
    ivec3 q = base + ivec3(${i & 1}, ${(i >> 1) & 1}, ${(i >> 2) & 1});
    o${i} = vec4(float(${i}), inGrid(q) ? fetchB(q).xyz : vec3(0.0));
    }`).join('\n    ')}
    return;
  }

  ${CELLS.map((i) => `vec4 a${i}; vec3 v${i}; int k${i}; float d${i}; int n${i} = ${i}; float q${i} = 0.0; bool m${i} = false, s${i} = false;`).join('\n  ')}
  ${CELLS.map((i) => `{
    ivec3 q = base + ivec3(${i & 1}, ${(i >> 1) & 1}, ${(i >> 2) & 1});
    if (inGrid(q)) { a${i} = fetchA(q); v${i} = fetchB(q).xyz; }
    else { a${i} = vec4(float(E_WALL), AMBIENT, 0.0, 0.0); v${i} = vec3(0.0); }
    k${i} = eid(a${i}); d${i} = densityOf(k${i}, a${i}.y);
  }`).join('\n  ')}
  rs = seed3(base, uFrame, 0x51u);

  // Columns are independent in the vertical phase, so a fixed order is fair.
  ${vertical(0, 2)}${vertical(1, 3)}${vertical(4, 6)}${vertical(5, 7)}

  // Diagonal order alternates so no direction is systematically favoured.
  if (rnd(rs) < 0.5) {
    ${[2, 7, 3, 6, 0, 5, 1, 4].map(diagonal).join('')}
  } else {
    ${[6, 3, 7, 2, 4, 1, 5, 0].map(diagonal).join('')}
  }

  if (rnd(rs) < 0.5) {
    ${horizontalX()}${horizontalZ()}
  } else {
    ${horizontalZ()}${horizontalX()}
  }

  ${CELLS.map((i) => `o${i} = vec4(packSlot(n${i}, q${i}), v${i});`).join('\n  ')}
}
`;

// The block pass's results, read per cell (the gather pass, the flow pass):
// uniforms tSlots and uParity, and
//   slotOf(c, q)     cell c's slot texel (its packed source and new velocity),
//                    and q, the cell its content comes from
//   postMove(c, a, b)  cell c's state after the move
// The slots are the layers of one array texture, layer i holding slot i of
// every block (Simulation.slots), so a cell's slot is one fetch whatever its
// place in its block: picking among 8 textures per cell costs a fetch from
// each, since the cells of a SIMD group sit at all 8 places.
// The block pass draws only the supertiles whose slots a step reads (sleeping
// supertiles, shaders/activity.js SUPER_MAP BLOCKS): those of blocks based in
// a brick that isn't quiet (the gather and the flow pass), and those of quiet
// blocks reaching into one (the flow pass reads their identity slots). The
// rest hold an older step's slots, which nothing reads.
export const slotGLSL = /* glsl */ `
uniform highp sampler2DArray tSlots;
uniform int uParity;
${heatGLSL}
// the base (lowest) cell of the block holding cell c
ivec3 blockBase(ivec3 c) { ivec3 off = ivec3(uParity); return ((c + off) / 2) * 2 - off; }
vec4 slotOf(ivec3 c, out ivec3 q) {
  ivec3 off = ivec3(uParity);
  ivec3 base = blockBase(c);
  ivec3 lp = c - base;
  int me = lp.x + 2 * lp.y + 4 * lp.z;
  vec4 m = texelFetch(tSlots, ivec3(blockAtlas((base + off) / 2 - off), me), 0);
  int src = int(m.x + 0.5) % SLOTS;
  q = base + ivec3(src & 1, (src >> 1) & 1, (src >> 2) & 1);
  return m;
}
// Cell c's state after this step's move: its source cell's state A, warmed by
// the impact energy the slot carries (packSlot), and the slot's new velocity
// with the pressure of c itself (pressure stays with the position). (A block
// whose base is in a quiet brick stayed put: its slots give each cell its own
// state, as fetchA and fetchB would.)
void postMove(ivec3 c, out vec4 a, out vec4 b) {
  ivec3 q;
  vec4 m = slotOf(c, q);
  a = fetchA(q);
  float heat = float(int(m.x + 0.5) / SLOTS) / HEAT_QUANTA;   // impact energy this cell took
  if (heat > 0.0) a.y = min(a.y + heat * KE_TO_HEAT / CAP[eid(a)], CELL_TEMP_MAX);
  b = vec4(m.yzw, fetchB(c).w);
}
`;

// Gather: every cell's state after the move. A block whose base is in a quiet
// brick stayed put, so its cells copy themselves (as their slots would say).
export const moveGatherFrag = (g) => /* glsl */ `
${prelude(g)}
${quietGLSL}
${slotGLSL}
uniform bool uFresh;   // the first step since the activity map was built: dirty marks start over
${stateOutGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { writeState(vec4(0.0), vec4(0.0), 0u); return; }   // a texel holding no cell
  vec4 a, b;
  if (quietCell(blockBase(p))) { a = fetchA(p); b = fetchB(p); }
  else postMove(p, a, b);
  // activity flags: the react pass after this one re-tests the cell; mark it
  // dirty if the move changed what its neighbours' tests read (shaders/common.js FLAG)
  uint f = fetchF(p);
  if (uFresh) f &= ~FLAG_DIRTY;
  if (nearChange(fetchA(p), a)) f |= FLAG_DIRTY;
  writeState(a, b, f);
}
`;

// Flow field for the renderer (gfx/surface.js, flowing grains): how far each
// cell's content moved this step (from q to p, as postMove reads it), which
// the blend unit averages into the field over recent steps (Simulation's
// FLOW_BLEND). This is motion that happened, not velocity: grains pressed
// against a pile want to fall but go nowhere, so a resting pile reads 0.
// Quiet bricks (shaders/activity.js) hold only still air and solids, which
// the renderer doesn't read flow for, so they keep what they have.
export const moveFlowFrag = (g) => /* glsl */ `
${prelude(g)}
out vec4 oV;
${quietGLSL}
${slotGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p) || quietCell(p)) discard;
  ivec3 q;
  slotOf(p, q);
  oV = vec4(vec3(p - q), 0.0);
}
`;
