import { prelude } from './common.js';
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
// gather pass then rebuilds the state at cell resolution.
//
// The block update is generated in JS with every cell index baked in as a
// literal, and the 8 cells live in plain named variables (a0..a7 etc). GPU
// compilers don't reliably inline helpers that index arrays, and dynamic
// indexing spills the whole block to memory — this layout keeps it all in
// registers and is several times faster.

// Cell i lives at local (x, y, z) = (i & 1, (i >> 1) & 1, (i >> 2) & 1).
const CELLS = [0, 1, 2, 3, 4, 5, 6, 7];

const swap = (i, j) => `{
    vec4 ta = a${i}; a${i} = a${j}; a${j} = ta;
    vec3 tv = v${i}; v${i} = v${j}; v${j} = tv;
    int ti = k${i}; k${i} = k${j}; k${j} = ti;
    int tn = n${i}; n${i} = n${j}; n${j} = tn;
    float td = d${i}; d${i} = d${j}; d${j} = td;
    m${i} = true; m${j} = true;
  }`;
// Collision between particles i and j along component c (i on the negative
// side, j on the positive side). Fast impacts exchange momentum, weighted by
// density as mass, with restitution 0.3 — this is what lets a blast or an
// impact travel through a pile like a Newton's cradle. Slow contact is just
// support: the approaching velocity is cancelled.
const collide = (i, j, c) => `{
      float rel = v${i}.${c} - v${j}.${c};
      if (rel > 0.15) {
        float mi = d${i}, mj = d${j}, inv = 1.0 / (mi + mj);
        float vc = (mi * v${i}.${c} + mj * v${j}.${c}) * inv;
        v${i}.${c} = vc - 0.3 * mj * inv * rel;
        v${j}.${c} = vc + 0.3 * mi * inv * rel;
      } else if (rel > 0.0) {
        if (v${i}.${c} > 0.0) v${i}.${c} = 0.0;
        if (v${j}.${c} < 0.0) v${j}.${c} = 0.0;
      }
    }`;

const can = (i, j, dir) => `canMove(k${i}, k${j}, d${i}, d${j}, ${dir})`;
const drag = (i, j) => `dragF(k${i}, k${j}, d${i}, d${j})`;

// 1. vertical exchange within one column (b = bottom, t = top)
const vertical = (b, t) => `
  {
    bool mt = movable(k${t}), mb = movable(k${b});
    bool down = v${t}.y < 0.0, up = v${b}.y > 0.0;
    if (!mt || !mb) {
      if (mt && down) { v${t} = land(v${t}, k${t}); s${t} = true; }
      if (mb && up) { v${b}.y = 0.0; s${b} = true; }
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
        if (up) s${b} = true;
      }
    }
  }`;

// 2. diagonal topple: a blocked top cell falls diagonally (powders/liquids),
// a blocked bottom gas cell rises diagonally. Candidates are scored by the
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
  const kindOk = top ? `(kd == K_POWDER || kd == K_LIQUID)` : `kd == K_GAS`;
  return `
  if (s${i} && !m${i}) {
    int kd = KIND[k${i}];
    if (${kindOk} && (kd != K_POWDER || rnd(rs) <= SLIDE[k${i}])) {
      float sA = ${ok(cols[0])} ? ${dirs[0]} + rnd(rs) * 0.6 : -9.0;
      float sB = ${ok(cols[1])} ? ${dirs[1]} + rnd(rs) * 0.6 : -9.0;
      float sC = ${ok(cols[2])} ? ${dirs[2]} + rnd(rs) * 0.6 : -9.0;
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
        if (w0) v${i}.${c} *= bounceR(k${i});
        if (w1) v${j}.${c} *= bounceR(k${j});
      }
    }
  }`;
const horizontalX = () => [[0, 1], [2, 3], [4, 5], [6, 7]].map(([i, j]) => horizontal(i, j, 'x')).join('');
const horizontalZ = () => [[0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => horizontal(i, j, 'z')).join('');

export const moveBlockFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
uniform int uParity;
uniform uint uFrame;
${CELLS.map((i) => `layout(location = ${i}) out vec4 o${i};`).join('\n')}
${quietGLSL}

uint rs;

// Can a particle (id a, density da) move into the place of (b, db), travelling
// in direction dir (0 = down, 1 = up, 2 = sideways)?
bool canMove(int a, int b, float da, float db, int dir) {
  if (!movable(a) || !movable(b)) return false;
  if (a == b && a != E_EMPTY) return false;
  if (isGasLike(a) && isGasLike(b)) {
    if (dir == 0) return da > db - 0.02;
    if (dir == 1) return da < db + 0.02;
    return true;
  }
  if (!isFluid(a) && !isFluid(b)) return false; // grains don't sink into grains
  if (dir == 0) return da > db;
  if (dir == 1) return da != db;               // buoyant rise, or thrown upward
  return db < da;
}

// Moving through a liquid is slower than through air.
float dragF(int a, int b, float da, float db) {
  bool la = KIND[a] == K_LIQUID, lb = KIND[b] == K_LIQUID;
  if ((la && !isGasLike(b)) || (lb && !isGasLike(a)))
    return 0.25 + 0.75 * clamp(2.0 * abs(da - db) / max(da, db), 0.0, 1.0);
  return 1.0;
}

// A particle tried to fall and hit something.
vec3 land(vec3 v, int id) {
  float vy = v.y;
  v.y = 0.0;
  if (KIND[id] == K_LIQUID && vy < -0.15) {
    // A real impact: liquids convert vertical momentum into a sideways splash.
    // (Resting liquid gets its flow from the react pass instead.)
    vec2 h = v.xz;
    float f = FLOW[id];
    if (dot(h, h) < f * f * 0.25) {
      float ang = rnd(rs) * 6.2831853;
      h = vec2(cos(ang), sin(ang)) * f;
    }
    h += normalize(h) * (-vy) * 0.3;
    v.xz = clamp(h, -1.0, 1.0);
  } else if (KIND[id] == K_POWDER) {
    // Grains scatter a little when they land hard, then friction takes over.
    float ang = rnd(rs) * 6.2831853;
    v.xz = v.xz * 0.3 + vec2(cos(ang), sin(ang)) * (-vy) * 0.12;
  }
  return v;
}

float bounceR(int id) {
  int k = KIND[id];
  return k == K_LIQUID ? -0.7 : (k == K_POWDER ? 0.0 : -0.5);
}

void main() {
  ivec3 bc = blockFromFrag(ivec2(gl_FragCoord.xy));
  ivec3 base = bc * 2 - ivec3(uParity);
  // A block whose base cell is in a quiet brick (shaders/activity.js) lies
  // within that brick's inert halo: it stays put, velocities and all.
  if (quietCell(base)) {
    ${CELLS.map((i) => `{
    ivec3 q = base + ivec3(${i & 1}, ${(i >> 1) & 1}, ${(i >> 2) & 1});
    o${i} = vec4(float(${i}), inGrid(q) ? texelFetch(tB, atlas(q), 0).xyz : vec3(0.0));
    }`).join('\n    ')}
    return;
  }

  ${CELLS.map((i) => `vec4 a${i}; vec3 v${i}; int k${i}; float d${i}; int n${i} = ${i}; bool m${i} = false, s${i} = false;`).join('\n  ')}
  ${CELLS.map((i) => `{
    ivec3 q = base + ivec3(${i & 1}, ${(i >> 1) & 1}, ${(i >> 2) & 1});
    if (inGrid(q)) { a${i} = texelFetch(tA, atlas(q), 0); v${i} = texelFetch(tB, atlas(q), 0).xyz; }
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

  ${CELLS.map((i) => `o${i} = vec4(float(n${i}), v${i});`).join('\n  ')}
}
`;

export const moveGatherFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
${CELLS.map((i) => `uniform sampler2D tM${i};`).join('\n')}
uniform int uParity;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (p.y >= NY) { oA = vec4(0.0); oB = vec4(0.0); return; }
  ivec3 off = ivec3(uParity);
  ivec3 base = ((p + off) / 2) * 2 - off;
  ivec3 lp = p - base;
  int me = lp.x + 2 * lp.y + 4 * lp.z;
  ivec2 bt = blockAtlas((base + off) / 2);
  vec4 m;
  ${CELLS.map((i) => `${i ? 'else ' : ''}if (me == ${i}) m = texelFetch(tM${i}, bt, 0);`).join('\n  ')}
  int src = int(m.x + 0.5);
  ivec3 q = base + ivec3(src & 1, (src >> 1) & 1, (src >> 2) & 1);
  oA = texelFetch(tA, atlas(q), 0);
  oB = vec4(m.yzw, texelFetch(tB, atlas(p), 0).w);
}
`;
