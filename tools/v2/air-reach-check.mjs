// CPU-only: the air substeps' reach gate is exact. An f32 port of air.js
// source's start set, the reach dilation and step (Math.fround on every
// operation keeps IEEE f32 rounding and signed zeros) runs every substep on
// every brick, then only on reached bricks; both ping-pong copies must match
// bit for bit over several ticks, every air/edge/heat mode and stray writes
// to one copy. A shorter reach must fail, so the fixtures exercise it.
import assert from 'node:assert/strict';
import { AIR, DT } from '../../src/v2/dynamics-reference.js';
import { REACH } from '../../src/shaders/v2/air.js';
import { AIR as AIR_MODE, EDGE } from '../../src/simModes.js';
import { dynamicsRows } from '../../src/v2/dynamics-reference.js';
import { COUPLE_MODE, blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { gridLayout } from '../../src/sim.js';

const fr = Math.fround, F = x => fr(x);
const A_DT = F(DT / AIR.substeps), A_DX = F(AIR.edge), A_C = F(AIR.sound), A_RHO = F(AIR.rho), A_DIFF = F(AIR.diffusion);
const A_PQ = F(AIR.pQuantum), A_VQ = F(AIR.vQuantum), A_SQ = F(AIR.scalarQuantum), QUIET = F(AIR.quietTicks);
const LOSS = F(AIR.loss ** (1 / AIR.substeps)), BUOYANCY_EXCESS = F(0.01), GRAVITY = F(19.6);
const negZero = x => x === 0 && 1 / x < 0;
const bits = a => Array.from(new Uint32Array(Float32Array.from(a).buffer));

// Deterministic xorshift, so a failure names its seed.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function world(dims, modes, random, coldGas = false) {
  const [bx, by, bz] = dims, n = bx * by * bz;
  const id = (x, y, z) => x + bx * (y + by * z), coord = b => [b % bx, Math.floor(b / bx) % by, Math.floor(b / (bx * by))];
  const neighbor = (b, axis, side, d = 1) => {
    const c = coord(b); c[axis] += side * d;
    if (modes.edge === EDGE.LOOP) c[axis] = ((c[axis] % dims[axis]) + dims[axis]) % dims[axis];
    else if (c[axis] < 0 || c[axis] >= dims[axis]) return -1;
    return id(...c);
  };
  // Cached faces: open fractions in 1/16 steps (often 0 or 1) and gas buoyancy.
  const pick = () => { const r = random(); return r < 0.3 ? 0 : r < 0.7 ? 1 : F(Math.floor(random() * 17) / 16); };
  const faces = Array.from({ length: n }, () => ({ open: [pick(), pick(), pick()], w: !coldGas && random() < 0.15 ? F((random() - 0.5) * 0.05) : 0 }));
  const voidOpen = Array.from({ length: n * 6 }, pick);
  return { n, neighbor, faces, voidOpen };
}

function physics(modes) {
  const vel = [AIR_MODE.ON, AIR_MODE.PRESSURE_OFF, AIR_MODE.NO_UPDATE].includes(modes.airMode);
  const pres = [AIR_MODE.ON, AIR_MODE.VELOCITY_OFF, AIR_MODE.NO_UPDATE].includes(modes.airMode), heat = modes.heat;
  const still = a => Math.abs(a.vp[3]) < A_PQ && a.vp.slice(0, 3).every(v => Math.abs(v) < A_VQ);
  const rest = a => bits(a.vp).every(w => w === 0) && a.th[2] === QUIET && !a.th.some(negZero);
  const level = (a, b) => [0, 1].every(i => Math.abs(fr(a.th[i] - b.th[i])) < A_SQ);
  const virtual = () => ({ vp: [0, 0, 0, 0], th: [0, 0, QUIET, 0] });
  function flux(left, right, axis) {
    const l = [...left.vp.slice(0, 3).map(v => vel ? v : 0), pres ? left.vp[3] : 0];
    const r = [...right.vp.slice(0, 3).map(v => vel ? v : 0), pres ? right.vp[3] : 0];
    const delta = r.map((v, i) => fr(v - l[i]));
    const acoustic = [0, 0, 0, 0];
    acoustic[axis] = fr(fr(l[3] + r[3]) / fr(2 * A_RHO));
    acoustic[3] = fr(fr(fr(fr(A_RHO * A_C) * A_C) * fr(l[axis] + r[axis])) * 0.5);
    for (let i = 0; i < 4; i++) acoustic[i] = fr(acoustic[i] - fr(fr(0.5 * A_C) * delta[i]));
    const courant = Math.min(F(1 / 12), Math.max(F(-1 / 12), fr(fr(fr(fr(l[axis] + r[axis]) * 0.5) * A_DT) / A_DX)));
    const donor = courant >= 0 ? l : r;
    const vp = acoustic.map((v, i) => fr(fr(fr(v * A_DT) / A_DX) + (i < 3 ? fr(donor[i] * courant) : 0)));
    const k = fr(fr(A_DIFF * A_DT) / fr(A_DX * A_DX)), scalar = [0, 1].map(i => {
      let d = fr(right.th[i] - left.th[i]); if (Math.abs(d) < A_SQ) d = 0;
      return fr(fr(courant * (courant >= 0 ? left.th[i] : right.th[i])) - fr(k * d));
    });
    if (!heat) scalar[0] = 0; if (!(pres || vel)) scalar[1] = 0;
    return { vp, th: [scalar[0], scalar[1], 0, 0] };
  }
  function step(w, airIn, t, substep) {
    const before = airIn[t], next = { vp: [...before.vp], th: [...before.th] };
    let quiet = still(before), gradient = false;
    const face = (q, axis, side) => q < 0 ? (modes.edge === EDGE.VOID ? w.voidOpen[t * 6 + axis * 2 + (side > 0)] : 0) : side > 0 ? w.faces[t].open[axis] : w.faces[q].open[axis];
    for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
      const q = w.neighbor(t, axis, side); if (q < 0 && modes.edge !== EDGE.VOID) continue;
      const other = q < 0 ? virtual() : airIn[q], open = face(q, axis, side); if (open === 0) continue;
      quiet = quiet && still(other);
      gradient = gradient || (heat && Math.abs(fr(other.th[0] - before.th[0])) >= A_SQ) || ((pres || vel) && Math.abs(fr(other.th[1] - before.th[1])) >= A_SQ);
      const f = side > 0 ? flux(before, other, axis) : flux(other, before, axis), so = fr(side * open);
      for (let i = 0; i < 4; i++) next.vp[i] = fr(next.vp[i] - fr(so * f.vp[i]));
      next.vp[axis] = fr(next.vp[axis] + fr(fr(fr(fr(so * before.vp[3]) / A_RHO) * A_DT) / A_DX));
      for (let i = 0; i < 4; i++) next.th[i] = fr(next.th[i] - fr(so * f.th[i]));
    }
    const excess = fr(before.th[0] + w.faces[t].w), g = modes.gravity ? [0, -GRAVITY, 0] : [0, 0, 0];
    if (heat && vel && Math.abs(excess) > BUOYANCY_EXCESS && g[1] !== 0) for (let axis = 0; axis < 3; axis++) {
      const below = w.neighbor(t, axis, -1), open = fr(w.faces[t].open[axis] + face(below, axis, -1));
      const lift = fr(fr(fr(g[axis] * Math.min(2, Math.max(-0.5, fr(excess / F(Math.max(1, modes.ambient + 273.15)))))) * A_DT) * Math.min(open, 1));
      next.vp[axis] = fr(next.vp[axis] - lift); if (open > 0 && g[axis] !== 0) quiet = false;
    }
    next.vp = next.vp.map(v => fr(v * LOSS));
    if (modes.airMode === AIR_MODE.NO_UPDATE) next.vp = [...before.vp];
    if (!vel) next.vp = [0, 0, 0, next.vp[3]]; if (!pres) next.vp[3] = 0; if (!heat) next.th[0] = 0;
    if (substep === AIR.substeps - 1) {
      if (quiet && !gradient && still(next)) { next.th[2] = Math.min(QUIET, fr(before.th[2] + 1)); if (next.th[2] >= QUIET) next.vp = [0, 0, 0, 0]; }
      else next.th[2] = 0;
    }
    return next;
  }
  // air.js source minus its cell reads: an optional gas/shock/vacuum effect, the mode masks, the start set.
  function source(w, airIn, effects) {
    const out = airIn.map((before, t) => {
      const a = { vp: [...before.vp], th: [...before.th] };
      if (effects.has(t)) { a.vp[3] = fr(a.vp[3] + effects.get(t)); a.th[2] = 0; }
      if (!pres) a.vp[3] = 0; if (!vel) a.vp = [0, 0, 0, a.vp[3]]; if (!heat) a.th[0] = 0;
      return a;
    });
    const start = out.map((a, t) => {
      const changed = bits([...a.vp, ...a.th]).some((v, i) => v !== bits([...airIn[t].vp, ...airIn[t].th])[i]);
      let settled = !changed && rest(a) && !(heat && vel && Math.abs(fr(a.th[0] + w.faces[t].w)) > BUOYANCY_EXCESS);
      for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
        const q = w.neighbor(t, axis, side); if (q < 0 && modes.edge !== EDGE.VOID) continue;
        const other = q < 0 ? virtual() : airIn[q]; settled = settled && rest(other) && level(a, other);
      }
      return !settled;
    });
    return { out, start };
  }
  return { step, source };
}

function reach(w, start, radius) {
  let set = start;
  for (let axis = 0; axis < 3; axis++) set = set.map((_, t) => {
    for (let d = -radius; d <= radius; d++) { const q = d === 0 ? t : w.neighbor(t, axis, Math.sign(d), Math.abs(d)); if (q >= 0 && set[q]) return true; }
    return false;
  });
  return set;
}

// One tick of the driver's ping-pong: source then the substeps. Returns the
// reached share so the fixtures prove the gate actually skips.
function tick(w, P, buffers, index, effects, radius) {
  const { out, start } = P.source(w, buffers[index], effects);
  buffers[1 - index] = out; index ^= 1;
  const reached = radius === null ? null : reach(w, start, radius);
  for (let i = 0; i < AIR.substeps; i++) {
    const airIn = buffers[index], airOut = buffers[1 - index];
    for (let t = 0; t < w.n; t++) if (!reached || reached[t]) airOut[t] = P.step(w, airIn, t, i);
    index ^= 1;
  }
  return { index, skipped: reached ? reached.filter(r => !r).length : 0 };
}

function scenario(seed, dims, modes, radius, pressureOnly = false) {
  const random = rng(seed), w = world(dims, modes, random, pressureOnly), P = physics(modes);
  const restValue = () => ({ vp: [0, 0, 0, 0], th: [0, 0, QUIET, 0] });
  const initial = Array.from({ length: w.n }, restValue);
  // A few disturbances: pressure, sub-quantum wind, gradients either side of
  // the scalar quantum, a -0 scalar and a broken quiet run.
  const kinds = [a => { a.vp[3] = F(random() * 400 - 200); a.th[2] = 0; }, a => { a.vp[0] = F(A_VQ * random() * 0.5); },
    a => { a.th[0] = F(random()); }, a => { a.th[1] = F(A_SQ * 0.5); }, a => { a.th[0] = -0; }, a => { a.th[2] = 3; }];
  for (let k = 0; k < 3; k++) kinds[pressureOnly ? 0 : Math.floor(random() * kinds.length)](initial[Math.floor(random() * w.n)]);
  const copy = a => a.map(x => ({ vp: [...x.vp], th: [...x.th] }));
  const full = { buffers: [copy(initial), copy(initial)], index: 0 }, gated = { buffers: [copy(initial), copy(initial)], index: 0 };
  let skipped = 0, equal = true;
  for (let n = 0; n < 6; n++) {
    const effects = new Map(); if (random() < 0.5) effects.set(Math.floor(random() * w.n), F(random() * 50));
    // A blast finish / weather commit writes only the current copy, sometimes
    // keeping the brick resting (the second copy is then stale).
    if (!pressureOnly && random() < 0.5) { const t = Math.floor(random() * w.n), v = F(random() < 0.5 ? A_SQ * 0.25 : random());
      for (const s of [full, gated]) s.buffers[s.index][t] = { ...s.buffers[s.index][t], th: [v, ...s.buffers[s.index][t].th.slice(1)] }; }
    full.index = tick(w, P, full.buffers, full.index, effects, null).index;
    const r = tick(w, P, gated.buffers, gated.index, effects, radius); gated.index = r.index; skipped += r.skipped;
    for (const b of [0, 1]) for (let t = 0; t < w.n; t++)
      if (bits([...full.buffers[b][t].vp, ...full.buffers[b][t].th]).join() !== bits([...gated.buffers[b][t].vp, ...gated.buffers[b][t].th]).join()) equal = false;
    if (!equal) break;
  }
  return { equal, skipped, total: 6 * w.n };
}

const shapes = [[20, 3, 3], [3, 19, 4], [4, 3, 21], [7, 6, 5]];
const modeSets = [];
for (const airMode of Object.values(AIR_MODE)) for (const edge of Object.values(EDGE)) for (const heat of [true, false])
  modeSets.push({ airMode, edge, heat, gravity: true, ambient: 20 });
modeSets.push({ airMode: AIR_MODE.ON, edge: EDGE.SOLID, heat: true, gravity: false, ambient: 20 });
let runs = 0, skipped = 0, total = 0, shortFailed = 0;
for (const [m, modes] of modeSets.entries()) for (const [s, dims] of shapes.entries()) for (let k = 0; k < 3; k++) {
  const seed = 1 + m * 97 + s * 13 + k;
  const r = scenario(seed, dims, modes, REACH);
  assert.ok(r.equal, `reach gate changed air bits: seed ${seed}, dims ${dims}, modes ${JSON.stringify(modes)}`);
  runs++; skipped += r.skipped; total += r.total;
  if (!scenario(seed, dims, modes, REACH - 2).equal) shortFailed++;
}
// The reach is now scattered from lists (air.js reach): each brick with bit a marks bit a+1 on the
// bricks within REACH along a. On every topology it equals the gather above.
function scatterReach(w, start, radius, variant = {}) {
  let set = start;
  for (let axis = 0; axis < 3; axis++) {
    const next = new Array(w.n).fill(false);
    for (let t = 0; t < w.n; t++) if (set[t]) for (let d = -radius; d <= radius; d++) {
      if (d === 0 && variant.noSelf) continue;
      const q = d === 0 ? t : w.neighbor(t, axis, Math.sign(d), Math.abs(d)); if (q >= 0) next[q] = true;
    }
    set = next;
  }
  return set;
}
let scatterRuns = 0, selfBroke = false;
for (const edge of Object.values(EDGE)) for (const dims of [...shapes, [1, 1, 5], [2, 9, 1]]) for (let seed = 1; seed <= 8; seed++) {
  const random = rng(seed * 31 + edge), w = world(dims, { edge }, random), start = Array.from({ length: w.n }, () => random() < 0.08);
  assert.deepEqual(scatterReach(w, start, REACH), reach(w, start, REACH), `scattered reach differs: dims ${dims}, edge ${edge}`);
  if (scatterReach(w, start, REACH, { noSelf: true }).join() !== reach(w, start, REACH).join()) selfBroke = true;
  scatterRuns++;
}
assert.ok(selfBroke, 'a scatter that skips the brick itself must break the reach');
// The exhaustive fixtures are about as wide as the 17-brick reach box; longer
// ones show that a pressure disturbance leaves most of a still box untouched
// (heat and gas disturbances really do spread a brick per substep).
let longSkipped = 0, longTotal = 0;
for (const dims of [[56, 3, 2], [2, 3, 56], [3, 56, 2]]) for (const edge of Object.values(EDGE)) {
  const r = scenario(7 + edge, dims, { airMode: AIR_MODE.ON, edge, heat: true, gravity: true, ambient: 20 }, REACH, true);
  assert.ok(r.equal, `reach gate changed air bits: dims ${dims}, edge ${edge}`);
  runs++; skipped += r.skipped; total += r.total; longSkipped += r.skipped; longTotal += r.total;
}
assert.ok(longSkipped > longTotal / 10, `fixtures must skip real work (${longSkipped}/${longTotal})`);
assert.ok(shortFailed > 0, 'a reach two bricks short must break some fixture');

// ---- The list-driven air tick (air.js list/source/reach/windList). Source runs
// only on listed bricks: a live brick, a cell note or an effect, or a face
// neighbour live or noted. A listed brick's live word becomes "not settled",
// a reached brick's becomes live, and an unlisted brick keeps a reach word of 0
// and both copies. Outside writers (a blast finish, weather) note the air they
// write; a cell change notes its brick (faces change for it or a neighbour).
// Both copies must match the full driver bit for bit, and a brick off the wind
// list (no live word on it or a face neighbour) must be at rest, level with
// resting neighbours and equal in both copies, so wind, pressure differences
// and air activity are all zero there.
const keyOf = a => bits([...a.vp, ...a.th]).join();
function listedTick(w, P, s, effects, variant) {
  const nbrs = t => { const out = []; for (let a = 0; a < 3; a++) for (const side of [-1, 1]) { const q = w.neighbor(t, a, side); if (q >= 0) out.push(q); } return out; };
  const listed = Array.from({ length: w.n }, (_, t) => s.live[t] || s.notes[t] || effects.has(t) ||
    (!variant.noDilation && nbrs(t).some(q => s.live[q] || s.notes[q])));
  // the cached faces: read again where source runs and it or a face neighbour is noted
  for (let t = 0; t < w.n; t++) if (listed[t] && (s.notes[t] || nbrs(t).some(q => s.notes[q]))) s.cache[t] = w.faces[t];
  const wc = { ...w, faces: s.cache };
  const { out, start } = P.source(wc, s.buffers[s.index], effects), starts = new Array(w.n).fill(false);
  for (let t = 0; t < w.n; t++) if (listed[t]) { s.buffers[1 - s.index][t] = out[t]; starts[t] = start[t]; s.live[t] = start[t] ? 1 : 0; }
  s.index ^= 1;
  const reached = reach(w, starts, REACH);
  for (let t = 0; t < w.n; t++) if (reached[t] && !variant.forgetReached) s.live[t] = 1;
  s.notes.fill(0);
  for (let i = 0; i < AIR.substeps; i++) {
    const airIn = s.buffers[s.index], airOut = s.buffers[1 - s.index];
    for (let t = 0; t < w.n; t++) if (reached[t]) airOut[t] = P.step(wc, airIn, t, i);
    s.index ^= 1;
  }
  // the wind list's promise for every brick off it
  for (let t = 0; t < w.n; t++) {
    if (s.live[t] || nbrs(t).some(q => s.live[q])) continue;
    const a = s.buffers[s.index][t], rest = x => bits(x.vp).every(v => v === 0) && x.th[2] === QUIET;
    if (!rest(a) || keyOf(a) !== keyOf(s.buffers[1 - s.index][t])) return { listed, promise: false };
    if (nbrs(t).some(q => !rest(s.buffers[s.index][q]) || [0, 1].some(i => Math.abs(fr(a.th[i] - s.buffers[s.index][q].th[i])) >= A_SQ))) return { listed, promise: false };
  }
  return { listed, promise: true };
}
function listedScenario(seed, dims, modes, variant = {}, still = false) {
  const random = rng(seed), w = world(dims, modes, random, still), P = physics(modes);
  const initial = Array.from({ length: w.n }, () => ({ vp: [0, 0, 0, 0], th: [0, 0, QUIET, 0] }));
  const copy = a => a.map(x => ({ vp: [...x.vp], th: [...x.th] }));
  const full = { buffers: [copy(initial), copy(initial)], index: 0 };
  const lean = { buffers: [copy(initial), copy(initial)], index: 0, live: new Uint8Array(w.n).fill(1), notes: new Uint8Array(w.n).fill(1), cache: w.faces.slice() };
  let listedBricks = 0, total = 0;
  for (let n = 0; n < 10; n++) {
    const rate = variant.rare ? 0.06 : 1;
    const effects = new Map(); if (random() < 0.3 * rate) effects.set(Math.floor(random() * w.n), F(random() * 50));
    if (random() < 0.4 * rate) { // an outside write to the current copy: pressure, heat or a broken quiet run
      const t = Math.floor(random() * w.n), k = Math.floor(random() * 3), heat = F(random() < 0.5 ? A_SQ * 0.25 : random());
      for (const s of [full, lean]) { const a = s.buffers[s.index][t], b = { vp: [...a.vp], th: [...a.th] };
        if (k === 0) b.vp[3] = F(b.vp[3] + 20); else if (k === 1) b.th[0] = heat; else b.th[2] = 0;
        s.buffers[s.index][t] = b; }
      if (!variant.silentStray) lean.live[t] = 1;
    }
    if (random() < 0.3 * rate) { // a cell change: its brick's or a face neighbour's faces and buoyancy
      const t = Math.floor(random() * w.n), q = random() < 0.5 ? t : w.neighbor(t, Math.floor(random() * 3), random() < 0.5 ? -1 : 1);
      w.faces[t] = { open: w.faces[t].open.map(o => random() < 0.5 ? o : F(Math.floor(random() * 17) / 16)), w: random() < 0.5 ? F((random() - 0.5) * 0.05) : 0 };
      if (!variant.silentFaces) lean.notes[q >= 0 ? q : t] = 1;
    }
    full.index = tick(w, P, full.buffers, full.index, effects, null).index;
    const r = listedTick(w, P, lean, effects, variant);
    listedBricks += r.listed.filter(Boolean).length; total += w.n;
    for (const b of [0, 1]) for (let t = 0; t < w.n; t++) if (keyOf(full.buffers[b][t]) !== keyOf(lean.buffers[b][t])) return { equal: false, listedBricks, total };
    if (!r.promise) return { equal: false, promise: false, listedBricks, total };
  }
  return { equal: true, listedBricks, total };
}
let listedRuns = 0, listedShare = 0, listedTotal = 0;
for (const [m, modes] of modeSets.entries()) for (const [s, dims] of [...shapes, [24, 2, 2], [2, 24, 2]].entries()) for (let k = 0; k < 2; k++) {
  const seed = 5 + m * 89 + s * 11 + k, r = listedScenario(seed, dims, modes);
  assert.ok(r.equal, `listed air tick changed air bits or broke the wind list's promise: seed ${seed}, dims ${dims}, modes ${JSON.stringify(modes)}`);
  listedRuns++; listedShare += r.listedBricks; listedTotal += r.total;
}
// Long boxes with one disturbance at a time: the source list stays near the disturbance.
let longListed = 0, longBricks = 0;
for (const dims of [[56, 3, 2], [2, 3, 56], [3, 56, 2]]) for (const edge of Object.values(EDGE)) for (let k = 0; k < 2; k++) {
  const r = listedScenario(31 + edge * 7 + k, dims, { airMode: AIR_MODE.ON, edge, heat: true, gravity: true, ambient: 20 }, { rare: true }, true);
  assert.ok(r.equal, `listed air tick changed air bits: dims ${dims}, edge ${edge}`);
  listedRuns++; longListed += r.listedBricks; longBricks += r.total;
}
console.log(`listed share small ${(100 * listedShare / listedTotal).toFixed(1)}% long ${(100 * longListed / longBricks).toFixed(1)}%`);
assert.ok(longListed < longBricks * 0.75, `the source list must skip real work in long boxes (${longListed}/${longBricks})`);
for (const [what, variant] of [['an outside write without noteAir', { silentStray: true }], ['a list without its neighbour dilation', { noDilation: true }],
  ['reached bricks left calm', { forgetReached: true }], ['a cell change without a note', { silentFaces: true }]]) {
  let broke = false;
  for (const [m, modes] of modeSets.entries()) { for (const dims of shapes) for (let k = 0; k < 2 && !broke; k++) broke = !listedScenario(5 + m * 89 + k, dims, modes, variant).equal; if (broke) break; }
  assert.ok(broke, `${what} must break the listed air tick`);
}

// couplePlan's quiet-brick skip rests on two row facts: every lift is above 0
// (no wind, no lift) and no breakable row is weaker than the emitted minimum.
const breakable = dynamicsRows.filter(r => r.breakInto >= 0), weakest = Math.min(...breakable.map(r => r.strength));
assert.ok(dynamicsRows.every(r => r.lift > 0), 'a zero-wind brick must lift nothing');
assert.ok(breakable.every(r => fr(r.strength) >= fr(weakest)) && weakest > 0, 'zero pressure difference must break nothing');
const g = gridLayout(16, 8, 8);
assert.match(blastsWGSL(g, nativeDynamicsHead, 'couplePlan'), /!dCoupleActive\(t\/64u\)/);
assert.match(blastsWGSL(g, nativeDynamicsHead, 'count'), new RegExp(`P\\.mode!=${COUPLE_MODE}u \\|\\| \\(dWindListed\\(t\\) && dCoupleActive\\(t\\)\\)`));
assert.match(blastsWGSL(g, nativeDynamicsHead, 'apply'), new RegExp(`P\\.mode==${COUPLE_MODE}u && !dCoupleActive`));

// Recorded air tick: no faces pass, three reach axes, gas stages only where
// they can act, and the couple run tagged so only it skips quiet bricks.
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
for (const [airMode, edge] of [[AIR_MODE.ON, EDGE.SOLID], [AIR_MODE.ON, EDGE.VOID], [AIR_MODE.VELOCITY_OFF, EDGE.VOID]]) {
  const calls = [], buffer = ({ size }) => ({ size, bytes: new ArrayBuffer(size), destroy() {} });
  const gpu = { createBuffer: buffer, queue: { writeBuffer() {} }, write() {}, layout: (_n, l) => l, bindGroup: (_l, b) => b,
    kernel: d => ({ name: d.name, ready: Promise.resolve(), dispatch: (_f, size, o) => { d.params.pack(o.params); calls.push({ name: d.name, size, params: o.params }); } }),
    frame: { clear() {}, copy() {} }, readback: { buffer: () => Promise.resolve(new ArrayBuffer(0)) } };
  const owner = { gpu, g, epoch: 0, tick: 1, sim: { origin: { x: 0, y: 0, z: 0 }, header: () => ({}), airMode, edgeMode: edge },
    nativeDynamics: { head: () => '', layout: [], group: [] }, wake() {}, _params: () => ({}), events: buffer({ size: g.slots * 4 }) };
  const d = new NativeDynamics(owner); await d.ready; d.advanceAir(1);
  const names = calls.map(c => c.name), wind = airMode !== AIR_MODE.VELOCITY_OFF;
  assert.ok(!names.includes('v2air_faces'));
  assert.deepEqual(calls.filter(c => c.name === 'v2air_reach').map(c => c.params.substep), [0, 1, 2]);
  assert.ok(names.indexOf('v2air_source') < names.indexOf('v2air_reach') && names.lastIndexOf('v2air_reach') < names.indexOf('v2air_step'));
  assert.equal(names.includes('v2air_gas'), wind);
  assert.equal(names.includes('v2air_gasBoundary'), wind && edge === EDGE.VOID);
  for (const stage of ['couplePlan', 'count', 'allocate', 'apply', 'children']) assert.equal(calls.find(c => c.name === `v2blasts_${stage}`).params.mode, COUPLE_MODE);
  d.dispose();
}
console.log(`air reach gate: ${runs} scenarios bit-identical in both ping-pong copies; ${(100 * skipped / total).toFixed(1)}% brick-substeps skipped; reach ${REACH - 2} breaks ${shortFailed}`);
console.log(`air lists: ${listedRuns} listed-tick scenarios bit-identical with the wind list's promise kept; source read ${(100 * longListed / longBricks).toFixed(1)}% of a long box's bricks; 4 red variants caught`);
