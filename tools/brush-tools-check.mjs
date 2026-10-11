// CPU check of TPT's brush tools (elements.js TOOLS -50..-57, shaders/passes.js
// paintUpdateWGSL, the brush's kernel). No browser, no GPU:
//   1. Mix: a twin of mixCell (same hash, same block rule) over a random 3D
//      grid and many paints, with the window anywhere in the world. Every
//      cell must end up in exactly one place (no cell lost or copied), only in
//      a mutual swap with a cell of its own kind, both inside the brush; air
//      and solids never move. It also prints how fast Mix mixes, next to TPT's.
//   2. Vacuum: the tiles' CPU port of the engine (ui/tiles/engine.js), with the
//      Vacuum brush applied as the kernel does, must pull loose matter in.
//   3. Wiring: every tool has a branch in the kernel, a dock tile in the Tools
//      group, and is paintable over the network.
// usage: node tools/brush-tools-check.mjs
import { ELEMENTS, E, K, TOOLS, PALETTE } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { paintKernelWGSL, MIX_BITS } from '../src/shaders/passes.js';
import { gridLayout } from '../src/sim.js';
import { World } from '../src/ui/tiles/engine.js';

let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

// ---- the shader's hash (shaders/common.js pcg, seedWorld, rnd), in uint32 ----
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const LCG_MUL = 1664525;
const seedWorld = (w, frame, salt) =>
  pcg((w[0] >>> 0) + pcg((w[1] >>> 0) + pcg((w[2] >>> 0) + pcg(Math.imul(frame, LCG_MUL) + salt))));
const rnd = (s) => pcg(s) / 4294967296;

// the constants mixCell reads, from the WGSL itself, so the twin can't drift from them
const g = gridLayout(32, 32, 32);
const src = paintKernelWGSL(g);
const def = (name) => {
  const m = src.match(new RegExp(`const ${name}(?:: *\\w+)? *= *([^;]+);`));
  if (!m) throw new Error(`the brush's kernel has no const ${name}`);
  return m[1].replace(/[uif]$/, '');
};
const BITS = +def('MIX_BITS'), MASK = +def('MIX_MASK');
const SALT = parseInt(def('MIX_SALT')), PAIR_SALT = parseInt(def('MIX_PAIR_SALT'));
const SWAP = Math.fround(+def('TOOL_MIX_SWAP'));
if (BITS !== MIX_BITS || MASK !== (1 << BITS) - 1 || SWAP !== Math.fround(PHYS.TOOL_MIX_SWAP)) fail('Mix constants in the brush\'s kernel disagree with passes.js/physics.js');

// ---- 1. Mix ----
// twin of the kernel's strokeDist/inBrush/mixes/mixCell; cell (x, y, z) of an n³ grid
const brushDist = (d, shape) => (shape === 0 ? Math.hypot(...d) : Math.max(...d.map(Math.abs)));
const inBrush = (p, br) => brushDist(p.map((c, k) => c + 0.5 - br.center[k]), br.shape) <= br.radius;
const mixes = (id) => [K.POWDER, K.LIQUID, K.GAS].includes(ELEMENTS[id].kind);
function mixPartner(p, br, frame, origin, n, ids) {
  const fs = pcg((Math.imul(frame, LCG_MUL) + SALT) >>> 0);
  const off = [fs, fs >>> BITS, fs >>> (2 * BITS)].map((x) => x & MASK);
  const w = p.map((c, k) => c + origin[k] + off[k]);
  const l = w.map((c) => c & MASK);
  const base = w.map((c, k) => c - l[k]);
  const hs = seedWorld(base, frame, SALT);
  const m = [hs, hs >>> BITS, hs >>> (2 * BITS)].map((x) => x & MASK);
  const lq = l.map((c, k) => c ^ m[k]);
  const q = p.map((c, k) => c + lq[k] - l[k]);
  if (m.every((c) => c === 0) || q.some((c) => c < 0 || c >= n) || !inBrush(p, br) || !inBrush(q, br)) return null;
  const at = (c) => c[0] + n * (c[1] + n * c[2]);
  const id = ids[at(p)], qid = ids[at(q)];
  if (!mixes(id) || ELEMENTS[qid].kind !== ELEMENTS[id].kind) return null;
  const li = l[0] | (l[1] << BITS) | (l[2] << (2 * BITS)), lqi = lq[0] | (lq[1] << BITS) | (lq[2] << (2 * BITS));
  const ps = seedWorld(base.map((c, k) => c + (li < lqi ? l : lq)[k]), frame, PAIR_SALT);
  return rnd(ps) >= SWAP ? null : q;
}

{
  const n = 20, cells = n * n * n;
  const palette = ['EMPTY', 'EMPTY', 'WALL', 'ROCK', 'SAND', 'SALT', 'DUST', 'WATER', 'OIL', 'STEAM', 'SMOKE'].map((k) => E[k]);
  let seed = 12345;
  const lcg = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  let ids = Int16Array.from({ length: cells }, () => palette[Math.floor(lcg() * palette.length)]);
  let tags = Int32Array.from({ length: cells }, (_, i) => i);   // which original cell sits here
  const home = Int32Array.from({ length: cells }, (_, i) => i);
  const at = (x, y, z) => x + n * (y + n * z);
  let swaps = 0, bad = 0;
  const PAINTS = 3000;
  for (let frame = 1; frame <= PAINTS; frame++) {
    const br = {
      center: [lcg() * n, lcg() * n, lcg() * n], radius: 1 + lcg() * 9, shape: lcg() < 0.7 ? 0 : 1,
    };
    const origin = [Math.floor((lcg() - 0.5) * 400), Math.floor((lcg() - 0.5) * 40), Math.floor((lcg() - 0.5) * 400)];
    const nIds = new Int16Array(cells), nTags = new Int32Array(cells);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = at(x, y, z);
      const q = mixPartner([x, y, z], br, frame, origin, n, ids);
      if (!q) { nIds[i] = ids[i]; nTags[i] = tags[i]; continue; }
      const j = at(...q);
      // the partner must pick this cell back, and both must be loose matter of one kind
      const back = mixPartner(q, br, frame, origin, n, ids);
      if (!back || at(...back) !== i || !mixes(ids[i]) || ELEMENTS[ids[i]].kind !== ELEMENTS[ids[j]].kind) bad++;
      nIds[i] = ids[j]; nTags[i] = tags[j];
      swaps++;
    }
    // a permutation: every original cell exactly once
    const seen = new Uint8Array(cells);
    for (const t of nTags) seen[t]++;
    if (seen.some((c) => c !== 1)) { fail(`Mix lost or copied a cell at paint ${frame}`); break; }
    ids = nIds; tags = nTags;
  }
  if (bad) fail(`Mix: ${bad} one-sided or cross-kind swaps`);
  // air and solids never moved
  let stuck = 0;
  for (let i = 0; i < cells; i++) {
    const kind = ELEMENTS[ids[i]].kind;
    if ((kind === K.EMPTY || kind === K.SOLID) && tags[i] !== home[i]) stuck++;
  }
  if (stuck) fail(`Mix moved ${stuck} air or solid cells`);
  if (!failed) ok(`Mix: ${PAINTS} paints over a ${n}³ grid, ${swaps / 2} pair swaps; every cell kept, air and solids never moved`);

  // how fast it mixes, deep inside a big brush, against TPT's MIX.cpp: a
  // particle swaps 2 frames in 100 with one up to ±5 pixels away (8.5 px² per axis)
  const big = 32, region = big * big * big;
  const all = Int16Array.from({ length: region }, () => E.SAND);
  let d2 = 0, cnt = 0;
  for (let frame = 1; frame <= 200; frame++) {
    const br = { center: [big / 2, big / 2, big / 2], radius: big, shape: 1 };
    for (let z = 4; z < big - 4; z++) for (let y = 4; y < big - 4; y++) for (let x = 4; x < big - 4; x++) {
      const q = mixPartner([x, y, z], br, frame, [0, 0, 0], big, all);
      cnt++;
      if (q) d2 += ((x - q[0]) ** 2 + (y - q[1]) ** 2 + (z - q[2]) ** 2) / 3;
    }
  }
  const ours = d2 / cnt, tpt = (2 / 100) * 8.5;
  ok(`Mix spreads ${ours.toFixed(3)} cells² per axis per frame (TPT MIX.cpp: ~${tpt.toFixed(3)} px²)`);
  if (ours < tpt / 2 || ours > tpt * 2) fail('Mix rate is not within 2× of TPT\'s');
}

// ---- 2. Vacuum: the engine pulls matter into it (tiles' CPU port) ----
{
  const w = new World(48, 48);
  w.gravity = 0;   // so the only pull is the vacuum's
  const c = 24, R = 6;
  // a ring of dust around the brush
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    if (r > R && r < R + 4) w.put(x, y, E.DUST);
  }
  let inward = 0, n = 0, minP = 0;
  for (let frame = 0; frame < 20; frame++) {
    // the kernel's Vacuum branch: max(P - TOOL_PRESSURE·falloff, P_MIN)
    w.brush(c, c, R, (i, f) => { w.P[i] = Math.max(w.P[i] - PHYS.TOOL_PRESSURE * f, PHYS.P_MIN); });
    for (let i = 0; i < w.P.length; i++) minP = Math.min(minP, w.P[i]);
    for (let s = 0; s < 4; s++) w.step();
  }
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const i = w.idx(x, y);
    if (w.id[i] !== E.DUST) continue;
    const dx = x + 0.5 - c, dy = y + 0.5 - c, r = Math.hypot(dx, dy) || 1;
    inward += -(w.vx[i] * dx + w.vy[i] * dy) / r;
    n++;
  }
  if (minP >= 0) fail('Vacuum: no pressure below 0');
  if (!(inward / n > 0)) fail(`Vacuum: dust is not drawn in (mean inward speed ${(inward / n).toFixed(4)})`);
  else ok(`Vacuum: pressure down to ${minP.toFixed(1)}, dust drawn in at ${(inward / n).toFixed(4)} cells/step on average`);
}

// ---- 3. wiring ----
{
  const NEW = { VACUUM: -50, WIND: -51, MIX: -52, CYCLONE: -53, GRAV_IN: -54, GRAV_OUT: -55, AMB_HEAT: -56, AMB_COOL: -57 };
  const tools = PALETTE.find((p) => p.name === 'Tools').items;
  const ids = new Set();
  for (const t of TOOLS) { if (ids.has(t.id)) fail(`tool id ${t.id} is used twice`); ids.add(t.id); }
  for (const [key, id] of Object.entries(NEW)) {
    const t = TOOLS.find((x) => x.key === key);
    if (!t || t.id !== id) { fail(`${key} is not tool ${id}`); continue; }
    if (key in E) fail(`${key} is also an element key`);
    if (!tools.includes(key)) fail(`${key} is not in the dock's Tools group`);
    if (!t.abbr || !t.desc) fail(`${key} has no abbreviation or description`);
    if (!new RegExp(`tool == T_${key}\\b`).test(src)) fail(`the brush's kernel has no branch for T_${key}`);
    if (!src.includes(`const T_${key}: i32 = ${id};`)) fail(`T_${key} is not a const ${id}`);
  }
  if (!failed) ok(`wiring: ${Object.keys(NEW).length} tools have ids, dock tiles and the brush kernel's branches`);
}

if (failed) process.exit(1);
