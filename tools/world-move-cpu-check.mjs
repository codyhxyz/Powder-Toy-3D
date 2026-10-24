// CPU check of the physics region's move (docs/seamless-world.md, "P — physics region";
// src/world/physicsRegion.js, src/world/window.js, src/shaders/world/physicsFill.js). No browser, no GPU.
//   1. slabs: every move's leaving and entering slab lies in the grid, is disjoint from the other, and is
//      exactly the world cells the move uncovers / gives up; a step back's entering slab is the step's
//      leaving slab, brick for brick (re-entry reads the keys the leave wrote)
//   2. plan: the order of a move's steps (the exact store last; the fill before every restore; the render
//      source's capture before the diff); a physics-only move has no picture step, a world-copy move no plant
//   3. slicing: LeaveQueue keeps each slice within its budget, flushes only the jobs asked for, reports a
//      failing job, and the window's real coding job (WorldWindow._codeSlab) leaves the stores exactly as
//      the old one-shot code did: the kept and banked bricks coded, bit for bit, the rest dropped; then a
//      walk away and back restores those bricks at the right slab indices (WorldWindow.restoreNative)
//   4. the fill's rule (copyFillKeepsGenerator): which cells take the generator's import over the word
//   5. naga: the world-copy fill for every world scene, against a synthetic world copy module (W's
//      worldCopyWGSL stands in: wcCell over a brick table and pool of cellWord.js words); V2's own fill
//      and tree apply after their shared write moved into nativeWriteCoreWGSL
//   6. cost, CPU side, on a deterministic slab (seeded): the leaving slab's coding as one block (today's
//      landing microtask) vs its longest slice, and the Island's tree placing and baking a move visits
//      (what the world copy takes off the move path)
// usage: node tools/world-move-cpu-check.mjs [--quick] (skips the naga sweep past the five census maps)
import { gridLayout } from '../src/sim.js';
import {
  moveSlabs, movePlan, slabBase, slabBrick, slabsOverlap, LeaveQueue, LEAVE_SLICE_MS, LEAVE_SLICE_BRICKS, MOVE_CPU_BUDGET_MS,
} from '../src/world/physicsRegion.js';
import { WorldWindow, WIN_STEP } from '../src/world/window.js';
import { NativeBrickStore, encodeNativeBrick, NATIVE_BRICK_BYTES } from '../src/world/nativeStore.js';
import { BrickStore, BRICK_FLOATS } from '../src/world/store.js';
import { copyFillWGSL, copyFillKeepsGenerator, copyFillLiquid } from '../src/shaders/world/physicsFill.js';
import { nativeFillWGSL, nativeApplyWGSL } from '../src/shaders/worldWrite.js';
import { wcWord } from '../src/shaders/world/cellWord.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { island } from '../src/world/scenes/island.js';
import { sourceTrees, rawSourceGrid } from '../src/world/renderSourceProducer.js';
import { ELEMENTS } from '../src/elements.js';
import { WORLD_SEED } from '../src/world/generator.js';
import { FULL } from '../src/shaders/v2.js';
import { nagaSpawn } from './naga.mjs';

const QUICK = process.argv.includes('--quick');
let bad = 0;
const fail = (m) => { bad++; console.error('FAIL', m); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const idOf = (key) => ELEMENTS.findIndex((e) => e.key === key);
const B = 4;

// ---------------------------------------------------------------- 1. slabs
for (const dims of [[128, 128, 128], [128, 384, 128], [64, 64, 64]]) {
  const g = { nx: dims[0], ny: dims[1], nz: dims[2] };
  for (const [dx, dz] of [[WIN_STEP, 0], [-WIN_STEP, 0], [0, WIN_STEP], [0, -WIN_STEP]]) {
    const m = moveSlabs(g, dx, dz), o0 = [160, 0, 96], o1 = [o0[0] + dx, 0, o0[2] + dz];
    const inGrid = (lo) => lo.every((v, i) => v >= 0 && v + m.size[i] <= dims[i]);
    if (!inGrid(m.leaveLo) || !inGrid(m.enterLo)) fail(`slab outside the grid ${dims} at ${dx},${dz}`);
    if (!eq(m.enterHi, m.enterLo.map((v, i) => v + m.size[i]))) fail('enterHi');
    // world cells covered before and after, by brick columns (x, z)
    const cols = (o) => { const s = new Set(); for (let x = 0; x < g.nx; x += B) for (let z = 0; z < g.nz; z += B) s.add(`${o[0] + x},${o[2] + z}`); return s; };
    const slab = (o, lo) => { const s = new Set(); for (let x = 0; x < m.size[0]; x += B) for (let z = 0; z < m.size[2]; z += B) s.add(`${o[0] + lo[0] + x},${o[2] + lo[2] + z}`); return s; };
    const before = cols(o0), after = cols(o1), leave = slab(o0, m.leaveLo), enter = slab(o1, m.enterLo);
    const gone = [...before].filter((k) => !after.has(k)), come = [...after].filter((k) => !before.has(k));
    if (gone.length !== leave.size || gone.some((k) => !leave.has(k))) fail(`leaving slab ≠ the cells given up (${dims}, ${dx},${dz})`);
    if (come.length !== enter.size || come.some((k) => !enter.has(k))) fail(`entering slab ≠ the cells uncovered (${dims}, ${dx},${dz})`);
    // a step back brings back exactly the slab that left
    const back = moveSlabs(g, -dx, -dz);
    const leftBase = slabBase(o0, m.leaveLo), backBase = slabBase(o0, back.enterLo);
    if (!eq(leftBase, backBase) || !eq(m.bricks, back.bricks)) fail(`step back ${dx},${dz}: enters ${backBase} ≠ left ${leftBase}`);
    if (!slabsOverlap({ base: leftBase, bricks: m.bricks }, { base: backBase, bricks: back.bricks })) fail('slabsOverlap misses a step back');
    if (slabsOverlap({ base: leftBase, bricks: m.bricks }, { base: slabBase(o1, m.enterLo), bricks: m.bricks })) fail('a move\'s leaving and entering slabs overlap');
  }
}
for (const bad of [[0, 0], [16, 16], [6, 0]]) { try { moveSlabs({ nx: 128, ny: 128, nz: 128 }, ...bad); fail(`moveSlabs accepted ${bad}`); } catch { /* refused */ } }
{ const bricks = [4, 32, 32], seen = new Set(); for (let i = 0; i < 4096; i++) seen.add(slabBrick(i, bricks).join()); if (seen.size !== 4096) fail('slabBrick is not one to one'); }

// ---------------------------------------------------------------- 2. plan
const PICTURE = ['leaveSource', 'leaveFar', 'sourceStore', 'sourceCaptured'];
for (const physicsOnly of [false, true]) for (const worldCopy of [false, true]) for (const native of [false, true]) for (const trees of [false, true]) {
  const p = movePlan({ physicsOnly, worldCopy, native, trees }), at = (s) => p.indexOf(s), tag = JSON.stringify({ physicsOnly, worldCopy, native, trees });
  if (new Set(p).size !== p.length) fail(`plan repeats a step ${tag}`);
  if (physicsOnly && p.some((s) => PICTURE.includes(s))) fail(`physics-only move has picture work ${tag}: ${p}`);
  if (worldCopy === p.includes('plant') && trees) fail(`plant ${worldCopy ? 'with' : 'without'} a world copy ${tag}`);
  const fill = worldCopy ? 'fillCopy' : 'fillGenerator';
  if (at(fill) < 0 || at(fill) < at('shift') || at('shift') < at('leaveCapture')) fail(`capture, shift, fill out of order ${tag}`);
  for (const s of ['restoreLegacy', 'plant', 'restoreNative', 'sourceStore']) if (at(s) >= 0 && at(s) < at(fill)) fail(`${s} before the fill ${tag}`);
  if (native && p.at(-1) !== 'restoreNative') fail(`the exact store is not last ${tag}: ${p}`);
  if (at('leaveSource') >= 0 && at('leaveSource') > at('leaveCapture')) fail(`the source's capture after the diff ${tag}`);
  if (at('sourceStore') >= 0 && at('sourceStore') > at('restoreLegacy')) fail(`the source keeps stored words after restore drops them ${tag}`);
}

// ---------------------------------------------------------------- 3. slicing
{
  let t = 0;
  const q = new LeaveQueue({ now: () => t, schedule: () => {} });
  const STEP_MS = 0.01;
  const a = { tag: 'a', count: 0, finished: false }, b = { tag: 'b', count: 0, finished: false };
  a.steps = (function* () { for (let i = 0; i < 4096; i++) { t += STEP_MS; a.count++; yield; } })(); a.done = () => { a.finished = true; };
  b.steps = (function* () { for (let i = 0; i < 300; i++) { t += STEP_MS; b.count++; yield; } })(); b.done = () => { b.finished = true; };
  q.add(a); q.add(b);
  q.flush((j) => j.tag === 'b');
  if (!b.finished || b.count !== 300 || a.count !== 0) fail(`flush(test) ran the wrong jobs: a ${a.count}, b ${b.count}`);
  let slices = 0;
  while (q.busy) { q.slice(); slices++; }
  if (!a.finished || a.count !== 4096) fail('the queue did not finish job a');
  if (q.longestMs > LEAVE_SLICE_MS + LEAVE_SLICE_BRICKS * STEP_MS + 1e-9) fail(`a slice ran ${q.longestMs} ms past its ${LEAVE_SLICE_MS} ms budget`);
  if (slices < Math.floor(4096 * STEP_MS / (LEAVE_SLICE_MS + LEAVE_SLICE_BRICKS * STEP_MS))) fail(`job a ran in ${slices} slices: too few to be within budget`);
  let failed = null;
  q.add({ steps: (function* () { yield; throw new Error('boom'); })(), fail: (e) => { failed = e; } });
  q.flush();
  if (failed?.message !== 'boom' || q.busy) fail('a failing job is not reported and dropped');
}

// The window's coding job on a deterministic slab: 4 × 32 × 32 bricks (a 16-cell move of a 128³ window).
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const STONE = idOf('STONE'), WATER = idOf('WATR') >= 0 ? idOf('WATR') : idOf('WATER'), SAND = idOf('SAND');
function slabData(bricks, rnd) {
  const n = bricks[0] * bricks[1] * bricks[2], cores = new Uint32Array(n * 256), banks = new Int32Array(n * 64);
  for (let i = 0; i < n; i++) {
    const [, y] = slabBrick(i, bricks), ground = y < bricks[1] / 3, sea = !ground && y < bricks[1] / 2;
    for (let l = 0; l < 64; l++) {
      const c = (i * 64 + l) * 4, tq = Math.round((20 + 273.25) * 4);
      if (ground) { cores[c] = STONE | (tq << 8); cores[c + 3] = (Math.floor(rnd() * 65535) << 16) >>> 0; }
      else if (sea) { cores[c] = WATER | (tq << 8); cores[c + 1] = FULL; }
      else cores[c] = 0 | (tq << 8);
    }
    if (rnd() < 0.02) banks[i * 64 + Math.floor(rnd() * 64)] = 1 + Math.floor(rnd() * 1000);   // a warm cell's energy bank
  }
  return { n, cores, banks };
}
function fakeWindow(wb, physicsOnly = true) {
  return { epoch: 1, physicsOnly, store: new BrickStore(wb), nativeStore: new NativeBrickStore(wb), storeRevisions: new Map(),
    renderSource: { commitStoreRevision() {} } };
}
const wb = [512, 32, 512], bricks = [4, 32, 32], base = [40, 0, 24];
const rnd = lcg(0x5eed);
const native = slabData(bricks, rnd), n = native.n;
const keyOf = (i) => { const [x, y, z] = slabBrick(i, bricks); return (z + base[2]) * wb[1] * wb[0] + (y + base[1]) * wb[0] + x + base[0]; };
const keptIdx = []; for (let i = 0; i < n; i++) if (rnd() < 0.05) keptIdx.push(i);
const words = new Uint32Array(1 + keptIdx.length); words[0] = keptIdx.length; keptIdx.forEach((i, s) => { words[1 + s] = keyOf(i); });
const floats = new Float32Array(keptIdx.length * 2 * BRICK_FLOATS).map(() => Math.floor(rnd() * 8));
const expectNative = (exact) => { const s = new Set(); for (let i = 0; i < n; i++) if (!exact || keptIdx.includes(i) || native.banks.subarray(i * 64, i * 64 + 64).some((v) => v)) s.add(i); return s; };
for (const exact of [true, false]) {
  const win = fakeWindow(wb);
  // a stale entry the slab must drop, and one written later (a newer revision) it must not touch
  const stale = keyOf(1), newer = keyOf(2);
  win.store.put(stale, new Uint8Array([1, 0])); win.nativeStore.put(stale, new Uint8Array(NATIVE_BRICK_BYTES));
  win.storeRevisions.set(newer, 99);
  const q = new LeaveQueue({ schedule: () => {} });
  q.add({ steps: WorldWindow.prototype._codeSlab.call(win, 1, base, bricks, words, keptIdx.length, floats, native, exact, { revision: 5 }) });
  while (q.busy) q.slice();
  const want = expectNative(exact);
  for (let i = 0; i < n; i++) {
    const key = keyOf(i), got = win.nativeStore.map.get(key);
    if (want.has(i) !== !!got) { fail(`exact=${exact}: native brick ${i} ${got ? 'kept' : 'dropped'}`); break; }
    if (got && !eq(got, encodeNativeBrick(native.cores, native.banks, i))) { fail(`native brick ${i} not bit for bit`); break; }
    const legacy = win.store.has(key);
    if (key !== newer && legacy !== keptIdx.includes(i)) { fail(`legacy brick ${i} ${legacy ? 'kept' : 'dropped'}`); break; }
  }
  if (keptIdx.includes(1) === false && win.store.has(stale)) fail('a stale legacy entry survived');
  // walk away and back: the step back's restore reads exactly those bricks, at their slab indices
  const sent = [];
  const sim = { origin: { x: base[0] * B - 112, y: 0, z: base[2] * B }, compactOwner: { sync() {} },
    nativeIntegration: { isReady: true, restoreBricks: (lo, br, entries, opts) => sent.push({ lo, br, entries, opts }) } };
  const back = moveSlabs({ nx: 128, ny: 128, nz: 128 }, WIN_STEP, 0);   // the slab at grid x 112.. is base
  WorldWindow.prototype.restoreNative.call({ sim, nativeStore: win.nativeStore }, back.enterLo, back.bricks, { picture: false });
  const got = sent[0]?.entries ?? [];
  if (got.length !== want.size || got.some((e) => !want.has(e.index))) fail(`exact=${exact}: the walk back restores ${got.length} bricks, ${want.size} left`);
  if (sent[0]?.opts?.derived !== false) fail('a physics-only restore re-ages the derived passes');
  if (win.nativeStore.size !== 0) fail(`exact=${exact}: the store keeps ${win.nativeStore.size} bricks after they came back`);
}

// ---------------------------------------------------------------- 4. the fill's rule
{
  const stoneA = [STONE, 20.3, 0, 0.42], waterA = [WATER, 20, 0, 0], airA = [0, 20, 0, 0.1];
  const wood = idOf('WOOD');
  if (!copyFillKeepsGenerator(wcWord(STONE, 0, 20, 0), stoneA)) fail('a stone cell the copy agrees with is not the generator\'s');
  if (!copyFillKeepsGenerator(wcWord(STONE, 0, 20, 0.7), stoneA)) fail('matter\'s life in the word overrides the generator\'s');
  if (copyFillKeepsGenerator(wcWord(STONE, 0, 300, 0), stoneA)) fail('heated stone takes the generator\'s cold import');
  if (!copyFillKeepsGenerator(wcWord(WATER, 0, 20, 1), waterA)) fail('a whole water cell is not the generator\'s');
  if (copyFillKeepsGenerator(wcWord(WATER, 0, 20, 0.5), waterA)) fail('a half water cell takes the generator\'s whole one');
  if (copyFillKeepsGenerator(wcWord(wood, 0, 20, 1), airA)) fail('a tree cell in the copy takes the generator\'s air');
  if (copyFillLiquid(wcWord(WATER, 0, 20, 1)) !== FULL || copyFillLiquid(wcWord(WATER, 0, 20, 0)) !== 1) fail('liquid fill decode');
  void SAND;
}

// ---------------------------------------------------------------- 5. naga
const STUB_COPY = /* wgsl */ `
struct WorldCopyU { size: vec3i, pad0: i32, bricks: vec3i, pad1: i32 }
@group(1) @binding(0) var<uniform> WC: WorldCopyU;
@group(1) @binding(1) var<storage, read> wcTable: array<u32>;
@group(1) @binding(2) var<storage, read> wcPool: array<u32>;
@group(1) @binding(3) var<storage, read> wcInfoWords: array<u32>;
@group(1) @binding(4) var<storage, read> wcOcc: array<u32>;
fn wcCell(c: vec3i) -> u32 {
  if (any(c < vec3i(0)) || any(c >= WC.size)) { return 0u; }
  let b = c >> vec3u(2u);
  let e = wcTable[u32(b.x + WC.bricks.x * (b.y + WC.bricks.y * b.z))];
  if ((e & WC_MIXED) == 0u) { return e; }
  return wcPool[(e & ~WC_MIXED) * WC_BRICK_CELLS + wcLocal(c & vec3i(3))];
}`;
const g128 = gridLayout(128, 128, 128);
const naga = (code, name) => { const r = nagaSpawn(code, name); if (r.status !== 0) fail(`naga ${name}: ${(r.stdout + r.stderr).slice(0, 800)}`); };
const CENSUS = ['island', 'labWorld', 'volcanoWorld', 'giantVolcano', 'willowCove'];
for (const s of WORLD_SCENES.filter((s) => !QUICK || CENSUS.includes(s.key))) {
  const g = s.key === 'giantVolcano' ? gridLayout(128, 384, 128) : g128;
  naga(copyFillWGSL(g, STUB_COPY, s.glsl(g)), `copy-fill-${s.key}.wgsl`);
}
naga(nativeFillWGSL(g128, island.glsl(g128)), 'island-native-fill.wgsl');
naga(nativeApplyWGSL(g128, { ...g128, nx: 64, nz: 64, slots: 64 * g128.ny * 64 }), 'native-tree-apply.wgsl');

// ---------------------------------------------------------------- 6. cost (CPU)
const ms = (fn, reps = 5) => { let best = Infinity; for (let r = 0; r < reps; r++) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); } return best; };
// today: the landing's microtask coded every native brick (captureSlab), then filed the slab in one go
const oldMs = ms(() => {
  const all = Array.from({ length: n }, (_, i) => encodeNativeBrick(native.cores, native.banks, i));
  const win = fakeWindow(wb, false), keep = new Set(keptIdx.map(keyOf));
  for (let i = 0; i < n; i++) { const key = keyOf(i); if (keep.has(key)) win.nativeStore.put(key, all[i]); else win.nativeStore.drop(key); }
});
const newTotal = ms(() => {
  const win = fakeWindow(wb), q = new LeaveQueue({ schedule: () => {} });
  q.add({ steps: WorldWindow.prototype._codeSlab.call(win, 1, base, bricks, words, keptIdx.length, floats, native, true, { revision: 1 }) });
  q.flush();
});
const sliced = new LeaveQueue({ schedule: () => {} });
sliced.add({ steps: WorldWindow.prototype._codeSlab.call(fakeWindow(wb), 1, base, bricks, words, keptIdx.length, floats, native, true, { revision: 1 }) });
while (sliced.busy) sliced.slice();
// what the world copy takes off the move: the Island's trees a move visits, placed and baked (plant's CPU
// part before its GPU apply; the render source's own bookkeeping comes on top). A walk of 8 moves east.
const WORLD_SIZE = [1024, 128, 1024];   // the Island's (maps.js WORLD_DIMS)
const P = island.params({ size: WORLD_SIZE, seed: WORLD_SEED });
const treeWin = { scene: island, P, candidates: new Map(), baked: new Map(), bakeTree: WorldWindow.prototype.bakeTree };
// the load plants the first window (its chunks warm treesIn's memo and the bake's), then the walk
for (let x = 0; x < 128; x += 32) for (let z = 0; z < 128; z += 32) sourceTrees(treeWin, [448 + x - 16, 0, 448 + z - 16], rawSourceGrid(128));
let plantMs = 0, plantMax = 0, treesSeen = 0;
const WALK = 8;
for (let k = 1; k <= WALK; k++) {
  const o = [448 + k * WIN_STEP, 0, 448], lo = 128 - WIN_STEP, t0 = performance.now();
  for (let z = 0; z < 128; z += 32) treesSeen += sourceTrees(treeWin, [o[0] + Math.floor(lo / 32) * 32 - 16, 0, o[2] + z - 16], rawSourceGrid(128)).length;
  const dt = performance.now() - t0; plantMs += dt; plantMax = Math.max(plantMax, dt);
}
console.log(`leaving slab coding, ${n} bricks, ${keptIdx.length} kept: old one block ${oldMs.toFixed(2)} ms; new ${newTotal.toFixed(2)} ms in all, longest slice ${sliced.longestMs.toFixed(2)} ms over ${sliced.slices} slices (budget ${LEAVE_SLICE_MS} ms)`);
console.log(`Island tree placing + baking a move visits (${WALK} moves east, after the load's): ${(plantMs / WALK).toFixed(2)} ms a move, worst ${plantMax.toFixed(2)} ms, ${treesSeen} tree stamps; 0 with a world copy`);
if (sliced.longestMs > MOVE_CPU_BUDGET_MS) fail(`a coding slice took ${sliced.longestMs.toFixed(2)} ms, past the move's ${MOVE_CPU_BUDGET_MS} ms CPU budget`);

console.log(bad ? `world-move-cpu-check: ${bad} failures` : 'world-move-cpu-check: ok');
process.exit(bad ? 1 : 0);
