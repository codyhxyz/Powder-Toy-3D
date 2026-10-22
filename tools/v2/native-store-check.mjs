// CPU-only: Physics V2's world store keeps what V1's keeps, not every brick.
//
// V1's store keeps a leaving brick only while it differs from the generator
// (world/window.js readBack, shaders/generate.js cellDiffers); a brick that comes
// back is generated again. V2's native store kept every brick that left the
// window (~1.3 KB each), so it grew without bound on long Descent runs. Now V2
// diffs its cores against the generator's import (shaders/v2/leave.js) and the
// store keeps those that differ and those with a nonzero energy bank.
//
// Covers: the native leaving kernel validates in Naga (and compiles to Metal)
// for every world scene, an imported map and a Descent terrain band; the kernel
// carries the import kernel's own importA; WorldGenerator.diff picks it only
// once built and while V2's cells are what the readers see; readBack keeps
// exactly the edited and banked bricks; a long run stays bounded; and a band
// handoff (captureEdits → TerrainEditCache) carries only edits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridLayout, Simulation } from '../../src/sim.js';
import { SUPER_CELLS } from '../../src/shaders/common.js';
import { E } from '../../src/elements.js';
import { makeMaterial, withPayload } from '../../src/v2/layout.js';
import { v2ImportWGSL } from '../../src/shaders/v2.js';
import { sceneNativeDiffFrag, importAWGSL } from '../../src/shaders/v2/leave.js';
import { sceneDiffFrag } from '../../src/shaders/generate.js';
import { WORLD_SCENES } from '../../src/world/scenes/index.js';
import { createImportedMapScene } from '../../src/world/scenes/importedMap.js';
import { createTerrainScene } from '../../src/world/scenes/descent/terrainScenes.js';
import { terrainLayout } from '../../src/world/scenes/descent/terrainRaster.js';
import { createHash } from 'node:crypto';
import { WorldGenerator } from '../../src/world/gpu.js';
import { WorldWindow } from '../../src/world/window.js';
import { BrickStore } from '../../src/world/store.js';
import { NativeBrickStore, encodeNativeBrick, NATIVE_BRICK_BYTES, nativeBrickBanked, legacyBrickToNative, legacyCellCore, decodeNativeBrick } from '../../src/world/nativeStore.js';
import { encodeBrick } from '../../src/world/store.js';
import { v2Rows, V2, FULL as V2_FULL, T_OFFSET } from '../../src/shaders/v2.js';
import { SEED_MAX } from '../../src/shaders/common.js';
import { lifeScale } from '../../src/v2/layout.js';
import { setFall } from '../../src/v2/fall.js';
import { V1_STEP_MS } from '../../src/v2/gravity.js';
import { PHYS } from '../../src/physics.js';
import { ELEMENTS } from '../../src/elements.js';
import { TerrainEditCache } from '../../src/world/terrainEditCache.js';
import { leaveHeadBytes, LEAVE_BRICK_BYTES } from '../../src/shaders/generate.js';

const BRICK_CELLS = 64;
const MAX_STORAGE = 8;   // portable WebGPU storage buffers per stage
let checks = 0;

// ---------------------------------------------------------------- the kernel
{
  const g = gridLayout(32, 32, 32);
  const importA = importAWGSL(g);
  assert(v2ImportWGSL(g).includes(importA), 'the leaving kernel carries the import kernel\'s own importA text');
  assert.match(importA, /^fn importA\(a: vec4f\) -> vec4u \{/);
  checks++;
}
{
  const imported = createImportedMapScene(JSON.parse(readFileSync(new URL('../../public/local-maps/androgenAssault.json', import.meta.url), 'utf8')));
  // a Descent band (scripts/check-terrain-raster.mjs's v2 fixture route: all open air, the
  // inflation depth plane open at every pixel, one backdrop block material)
  const inflation = { maxHalfDepth: 64, backdropMargin: 4, backdropBlock: 8, backdropWindow: 9 };
  const foldConfig = { sourceMinX: -4608, sourceWidth: 9216, cellScale: 1, angleStart: -Math.PI / 2, angleSpan: Math.PI * 1.5, thickness: 2 * (64 + 4), shellThickness: 2, margin: 32 };
  const L = terrainLayout({ fold: foldConfig, inflation });
  const bytes = new Uint8Array(L.words * 4);
  for (let i = 0; i < L.pixels; i++) bytes[L.depthAt + i] = 1 + (i % (2 * inflation.maxHalfDepth));
  bytes.fill(1, L.backdropAt, L.backdropAt + L.blocks);
  const hash = a => createHash('sha256').update(a).digest('hex');
  const region = { key: 'fixture', label: 'Snowy Depths', sourceTop: 992, sourceHeight: 320, core: [1024, 1280], sectionIndex: 0, file: 'fixture.binpack',
    sha256: hash(bytes.subarray(0, L.pixels)), fieldsSha256: hash(bytes.subarray(L.pixels, L.bytes)), spawnSource: [-677, 1200, 0] };
  const route = { version: 2, encoding: 'noita-folded-raster-u8-v2', fold: foldConfig, inflation, palette: [{ name: 'air', element: E.EMPTY }, { name: 'rock_static', element: E.ROCK }], regions: [region], sections: [], startScene: 'fixture', startSource: region.spawnSource, nativePortals: [] };
  const terrain = createTerrainScene(route, region, { fetchWords: async () => new Uint32Array(bytes.buffer) });
  const dir = mkdtempSync(join(tmpdir(), 'native-leave-'));
  try {
    const cases = [
      ...[128, 384].flatMap(h => [...WORLD_SCENES, imported].map(scene => [scene.key, { nx: 128, ny: h, nz: 128 }, scene])),
      ['descent band', gridLayout(128, 320, 128), terrain],
    ];
    for (const [name, sim, scene] of cases) {
      const code = sceneNativeDiffFrag(sim, scene.glsl(sim));
      const resources = [...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+\w+\s*:\s*([^;]+);/g)];
      assert(resources.every(r => Number(r[1]) < 4), `${name}: groups 0-3`);
      assert(resources.filter(r => r[3]?.startsWith('storage')).length <= MAX_STORAGE, `${name}: storage budget`);
      // same bindings as V1's leaving kernel: the window binds one group for both
      const v1 = [...sceneDiffFrag(sim, scene.glsl(sim)).matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/g)].map(m => m[0]).sort();
      assert.deepEqual(resources.map(r => `@group(${r[1]}) @binding(${r[2]})`).sort(), v1, `${name}: V1's leaving bindings`);
      const file = join(dir, 'leave.wgsl'); writeFileSync(file, code);
      const run = spawnSync('naga', [file, join(dir, 'leave.metal')], { encoding: 'utf8' });
      if (run.error || run.status !== 0) throw new Error(`${name} ${sim.ny}: ${run.error ?? run.stderr ?? run.stdout}`);
      checks++;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(`PASS native leaving kernel: Naga + Metal for ${WORLD_SCENES.length} scenes and an imported map at heights 128 and 384, and a Descent band`);
}

// ---------------------------------------------------------------- the kernel's choice
{
  const dispatched = [];
  const kernel = name => ({ name, groups: [null, null, 'leave layout'], pipeline: {}, dispatch: (f, size, opts) => dispatched.push({ name, opts }) });
  let format = 2;
  const sim = { origin: { x: 16, y: 0, z: 0 }, gpu: { frame: { clear() {} }, bindGroup: () => ({}) }, tables: {}, bindRO: {}, readHeader: () => ({ format }), header: () => ({ format: 0 }) };
  const gen = Object.assign(Object.create(WorldGenerator.prototype), {
    sim, scene: { key: 'fixture' }, res: { prepassFor() {}, entries: e => e },
    kernels: { diff: kernel('v1'), nativeDiff: kernel('v2') },
  });
  const out = { head: {}, cells: {} }, P = { size: [256, 32, 256] }, run = (opts) => { dispatched.length = 0; const r = gen.diff(P, [0, 0, 0], [4, 8, 8], out, opts); return [r, dispatched[0].name]; };
  assert.deepEqual(run(), [false, 'v1'], 'a V1 grid diffs as before');
  assert.deepEqual(run({ native: true }), [true, 'v2'], 'a V2 grid diffs its cores against the generator\'s import');
  gen.kernels.nativeDiff.pipeline = null;
  assert.deepEqual(run({ native: true }), [false, 'v1'], 'until V2\'s kernel is built, V1\'s runs (and the window keeps every native brick)');
  gen.kernels.nativeDiff.pipeline = {}; format = 0;
  assert.deepEqual(run({ native: true }), [false, 'v1'], 'readers bound to the legacy projection (format 0) get V1\'s');
  // (A suspended owner's native diff, a World grid switched to V1 at runtime, went with V1.)
  gen.kernels.nativeDiff.pipeline = {}; format = 2;
  delete gen.kernels.nativeDiff;
  assert.deepEqual(run({ native: true }), [false, 'v1']);
  checks++;
}

// ---------------------------------------------------------------- what readBack keeps
const wb = [64, 8, 64];
const brickOf = (material, bank = 0) => {
  const core = new Uint32Array(BRICK_CELLS * 4), banks = new Int32Array(BRICK_CELLS);
  for (let i = 0; i < BRICK_CELLS; i++) { core.set(material.core, i * 4); banks[i] = bank; }
  return encodeNativeBrick(core, banks);
};
const rock = makeMaterial(E.STONE, 20), sand = makeMaterial(E.SAND, 20), water = makeMaterial(E.WATER, 20);
const pristine = brickOf(rock), edited = brickOf(sand), banked = brickOf(rock, -3);
assert.equal(nativeBrickBanked(pristine), false); assert.equal(nativeBrickBanked(banked), true);
assert.equal(nativeBrickBanked(brickOf(withPayload(water, 7))), false, 'a payload is not a bank');

// A window around the real readBack: a fake device whose head lists the bricks the native diff flagged.
function windowFor() {
  const head = { data: null }, cells = { data: null };
  const win = Object.assign(Object.create(WorldWindow.prototype), {
    wb, epoch: 1, lastKept: 0, last: null, pending: null,
    store: new BrickStore(wb), nativeStore: new NativeBrickStore(wb), storeReads: new Set(), storeRevisions: new Map(),
    renderSource: { commitStoreRevision() {} }, sim: { _retire() {} }, leave: { head, cells },
    gpu: { readback: { buffer: async (b, at, n) => b.data.slice(at, at + n).buffer } },
  });
  // keys: the flagged bricks' world keys, in the head's order
  win.flag = (keys) => {
    const n = 4 * 8 * 8;
    head.data = new Uint8Array(Math.ceil(leaveHeadBytes(n) / 4) * 4);
    const w = new Uint32Array(head.data.buffer); w[0] = keys.length; keys.forEach((k, i) => { w[1 + i] = k; });
    cells.data = new Uint8Array(n * LEAVE_BRICK_BYTES);   // (zero cells: a valid projected brick)
  };
  return win;
}
async function leave(win, base, bricks, natives, flagged, exact) {
  win.flag(flagged);
  win.readBack(base, bricks, { revision: 1 }, win.leave, Promise.resolve(natives), exact);
  await win.pending;
}
{
  const win = windowFor(), base = [8, 0, 3], bricks = [1, 1, 3];
  const keys = [0, 1, 2].map(z => win.store.key(base[0], base[1], base[2] + z));
  // a stale exact copy of the pristine brick from an earlier visit must not survive it
  win.nativeStore.put(keys[0], edited);
  await leave(win, base, bricks, [pristine, edited, banked], [keys[1]], true);
  assert.equal(win.nativeStore.has(keys[0]), false, 'a brick that is the generator\'s import goes, as V1\'s matching brick does');
  assert.deepEqual(win.nativeStore.map.get(keys[1]), edited, 'an edited brick is kept exact');
  assert.deepEqual(win.nativeStore.map.get(keys[2]), banked, 'a brick whose cores match but a bank does not is kept exact');
  assert.deepEqual([...win.store.map.keys()], [keys[1]], 'the projection store keeps V2\'s flagged bricks too');
  // V1's diff ran (V2's kernel not built yet): every native brick stays, as before
  const all = windowFor();
  await leave(all, base, bricks, [pristine, edited, banked], keys, false);
  assert.equal(all.nativeStore.size, 3);
  checks++;
}
{
  // A long run: 2000 slabs leave, every fourth brick of each edited. The native store holds the edits only.
  const win = windowFor(), legacy = windowFor(), bricks = [1, 1, 4], SLABS = 2000;
  for (let s = 0; s < SLABS; s++) {
    const base = [s % wb[0], (s >> 6) % wb[1], 0];
    const flagged = [win.store.key(base[0], base[1], 0)];
    await leave(win, base, bricks, [edited, pristine, pristine, pristine], flagged, true);
    await leave(legacy, base, bricks, [edited, pristine, pristine, pristine], flagged, false);
  }
  const kept = Math.min(SLABS, wb[0] * wb[1]);
  assert.equal(win.nativeStore.size, kept, 'the store holds only the edited bricks');
  assert.equal(win.nativeStore.bytes, kept * NATIVE_BRICK_BYTES);
  assert.equal(legacy.nativeStore.size, kept * 4, 'before: every brick that left');
  console.log(`PASS long run: ${win.nativeStore.size} edited bricks kept (${win.nativeStore.bytes} B) where every brick was (${legacy.nativeStore.size}, ${legacy.nativeStore.bytes} B)`);
  checks++;
}

// ---------------------------------------------------------------- a Descent band handoff
{
  // captureEdits (the band handoff, wire/descent.js) runs the same diff and readBack, slab by slab.
  const g = gridLayout(32, 32, 32), bandWb = [16, g.ny / 4, 16];
  const editedAt = new Set([5, 77]);   // slab-local bricks the player changed
  const win = Object.assign(windowFor(), { wb: bandWb, store: new BrickStore(bandWb), nativeStore: new NativeBrickStore(bandWb), loaded: true, capturing: false, readbackError: null, persistenceError: null, P: {} });
  win.renderSource.token = () => ({ revision: 1 });
  win.gpu.failure = null;
  const bandOwner = {};   // (V2 runs the band: the owner is the engine stepping it)
  win.sim = { g, origin: { x: 0, y: 0, z: 0 }, compactOwner: bandOwner, compact: bandOwner, disposed: false, _retire() {}, prepareNative: async () => true,
    nativeIntegration: { captureSlab: (lo, bricks) => Promise.resolve(Array.from({ length: bricks[0] * bricks[1] * bricks[2] }, (_, i) => (editedAt.has(i) ? edited : pristine))) } };
  let natives = 0;
  win.gen = { diff(P, lo, bricks, out, { native }) {
    assert.equal(native, true, 'a V2 window asks for the native diff');
    natives++;
    const flagged = [];
    for (let i = 0; i < bricks[0] * bricks[1] * bricks[2]; i++) if (editedAt.has(i)) flagged.push(win.store.key(lo[0] / 4 + i % bricks[0], Math.floor(i / bricks[0]) % bricks[1], Math.floor(i / (bricks[0] * bricks[1]))));
    win.flag(flagged);
    return true;
  } };
  await win.captureEdits();
  assert.equal(natives, g.nx / 16);
  assert.equal(win.nativeStore.size, editedAt.size * natives, 'the band keeps its edits, not every resident brick');
  const cache = new TerrainEditCache(), region = { sourceTop: 1000, sourceHeight: g.ny };
  cache.capture(region, win.store, 1, win.nativeStore);
  assert.equal(cache.native.size, win.nativeStore.size, 'the run\'s cache carries the edits alone');
  checks++;
}
// ---------------------------------------------------------------- an owner not yet presenting the grid
// (A World grid switched to V1 at runtime, and its suspended owner's second diff, went with V1.)
{
  // Retained native bricks go into the owner even before it presents the grid, and nothing is exported over
  // the V1-format cache (an export marked every brick after a native shift, zeroing B and requantizing A).
  const exports = [], restored = [];
  const owner = { sync() {}, exportLegacy() { exports.push('owner'); } };
  const win = Object.assign(windowFor(), { wb: [8, 8, 8], nativeStore: new NativeBrickStore([8, 8, 8]) });
  win.sim = { origin: { x: 0, y: 0, z: 0 }, compactOwner: owner, compact: null, nativeIntegration: { isReady: true, restoreBricks: (lo, bricks, entries) => restored.push(...entries) } };
  win.nativeStore.put(win.nativeStore.key(1, 0, 0), edited);
  assert.equal(WorldWindow.prototype.restoreNative.call(win, [0, 0, 0], [4, 8, 8]), 1);
  assert.equal(restored.length, 1, 'the owner takes the exact brick');
  assert.deepEqual(exports, [], 'and nothing is exported over V1\'s cells');
  // Simulation.shift: nothing projects first (native.shift syncs the owner itself)
  const shiftSim = (compact) => {
    const calls = [];
    const own = { isReady: true, exportLegacy() { calls.push('export'); } };
    const fake = { compactOwner: own, compact: compact ? own : null, g: { slots: 64 }, origin: { x: 0, z: 0 }, cur: 0, version: 0, wholeWrites: 0,
      nativeIntegration: { isReady: true, shift: () => calls.push('nativeShift'), shifted() {} },
      pingPong() {}, gpu: { frame: { copy() {} } }, flow: { size: 8 }, flowTmp: {}, _flowShiftGroup: {}, passOf: () => ({}), _dispatch() {},
      tables: {}, _bindRW: {}, header() { return {}; }, _shiftListeners: [], deco: null, shiftKeepsHistory: true, rays: { reset() {} },
      derived: { shiftsBricks: true }, wake() {}, stillFlow() {} };
    Simulation.prototype.shift.call(fake, SUPER_CELLS.x, 0);
    return calls;
  };
  // V2 running: the move is V2's alone; V1's cache is neither projected nor moved, and its next export rewrites it whole
  assert.deepEqual(shiftSim(true), ['nativeShift'], 'V2 running: V2 moves, V1\'s cache is left stale');
  assert.deepEqual(shiftSim(false), ['nativeShift'], 'before the owner presents: nothing exported over the cache');
  checks++;
  console.log('PASS an owner not yet presenting: retained bricks restore into it; no projection over the cache');
}
{
  // A V1-made World save keeps V1's bricks only. Under V2 they come back natively: legacyBrickToNative is
  // the import kernel's own importA (its production text, run on the CPU as tools/v2/native-writers-check.mjs
  // runs WGSL) and its powder fall, cell for cell, and the window restores them exact, never through V1's
  // restore edit and the import.
  const g = gridLayout(32, 32, 32), rows = v2Rows();
  const body = importAWGSL(g).replace(/^fn importA\(a: vec4f\) -> vec4u \{/, '').replace(/\}\s*$/, '')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1').replace(/\bvar\b/g, 'let').replace(/ >> /g, ' >>> ')
    .replace(/\ba\.([xyzw])/g, (_s, c) => `a[${'xyzw'.indexOf(c)}]`).replace(/\bc\.([xyzw]) =/g, (_s, c) => `c[${'xyzw'.indexOf(c)}] =`);
  const roundEven = x => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1; };
  const liq = c => rows[c[0] & 255].cls === V2.LIQUID;
  const ctx = {
    u32: x => Math.trunc(x) >>> 0, clamp: (x, a, b) => Math.max(a, Math.min(b, x)), round: roundEven, floor: Math.floor, max: Math.max,
    fract: x => x - Math.floor(x), select: (a, b, c) => (c ? b : a), eid: a => Math.floor(a[0] + 0.5), NE: ELEMENTS.length,
    T_OFFSET, SEED_MAX, FULLU: V2_FULL, C_AIR: V2.AIR, C_LIQUID: V2.LIQUID, C_GAS: V2.GAS,
    cls: id => rows[id].cls, fadeOf: id => rows[id].fade, conductsNative: id => ELEMENTS[id].elec > 0,
    vec4u: (...w) => new Uint32Array(w),
    withLife: (c, v) => { const o = new Uint32Array(c), p = Math.max(0, Math.min(65535, roundEven(v * lifeScale(c[0] & 255)))); if (liq(c)) o[3] = (o[3] & 0xffff) | (p << 16); else o[1] = (o[1] & 0xffff0000) | p; return o; },
    withSpark: (c, v) => { const o = new Uint32Array(c); if (liq(c)) o[3] = (o[3] & 0xf000ffff) | ((v & 4095) << 16); else o[3] = (o[3] & 0xfffff000) | (v & 4095); return o; },
  };
  const importA = new Function('ctx', 'a', `with (ctx) { ${body} }`);
  // v2import's fall, as its text reads it
  assert.match(v2ImportWGSL(g), new RegExp(`if \\(clsOf\\(n\\) == C_POWDER && vy < 0\\.0\\) \\{ n = setFall\\(n, min\\(-vy, ${PHYS.V_MAX}\\.0\\) \\* ${V1_STEP_MS}, 0\\.0\\); \\}`), 'v2import: a powder\'s fall from V1\'s B.y');
  const oracle = (a, vy) => { const c = importA(ctx, a); return rows[c[0] & 255].cls === V2.POWDER && vy < 0 ? setFall(c, Math.min(-vy, PHYS.V_MAX) * V1_STEP_MS, 0) : c; };
  let cells = 0;
  for (const e of ELEMENTS) for (const [T, life, w, vy] of [[20, 0, 0.25, 0], [-40.5, 12, 3.5, -0.75], [912.25, 0.5, 17.125, 0], [3500, 400, 0.9375, -3]]) {
    const a = [e.id, T, life, w];
    assert.deepEqual([...legacyCellCore(a, vy)], [...oracle(a, vy)], `${e.key} at ${T} °C, life ${life}, w ${w}, B.y ${vy}`);
    cells++;
  }
  // a brick of them, through V1's stored bytes (store.js encodeBrick, slab order: the native brick's)
  const A = new Float32Array(256), B = new Float32Array(256), picks = [E.SAND, E.WATER, E.STONE, E.FIRE, E.EMPTY];
  for (let l = 0; l < 64; l++) { A.set([picks[l % 5], 20 + l, l % 3, (l % 7) + 0.5], l * 4); B.set([0, l % 2 ? -0.5 : 0, 0, 0.25], l * 4); }
  const legacyBytes = encodeBrick(A, 0, B, 0), native = legacyBrickToNative(legacyBytes), decoded = decodeNativeBrick(native);
  for (let l = 0; l < 64; l++) assert.deepEqual([...decoded.core.subarray(l * 4, l * 4 + 4)], [...oracle(A.subarray(l * 4, l * 4 + 4), B[l * 4 + 1])], `brick cell ${l}`);
  assert(decoded.bank.every(v => v === 0), 'every bank 0, as the import leaves it');
  // WorldWindow.restore: a V2 window takes the legacy-only brick natively; V1's restore edit went with V1
  const restoreWin = (nativeReady) => {
    const edits = [], scattered = [];
    const win = Object.assign(windowFor(), { wb: [8, 8, 8], store: new BrickStore([8, 8, 8]), nativeStore: new NativeBrickStore([8, 8, 8]), });
    win.gpu = { createBuffer: d => ({ ...d, destroy() {} }), write() {}, stats: { flushes: 0 } };
    win.sim = { origin: { x: 0, y: 0, z: 0 }, _retire() {}, edit: (...args) => edits.push(args), compactOwner: nativeReady ? { isReady: true, sync() {} } : null,
      compact: nativeReady ? { isReady: true } : null, nativeIntegration: nativeReady ? { isReady: true, restoreBricks: (lo, bricks, entries) => scattered.push(...entries) } : null };
    const key = win.store.key(1, 0, 0);
    win.store.put(key, legacyBytes);
    const restored = WorldWindow.prototype.restore.call(win, [0, 0, 0], [4, 8, 8]);
    WorldWindow.prototype.restoreNative.call(win, [0, 0, 0], [4, 8, 8]);
    return { restored, edits, scattered, win, key };
  };
  const v2 = restoreWin(true);
  assert.equal(v2.restored, 1, 'the brick is restored');
  assert.equal(v2.edits.length, 0, 'V2: no V1 restore edit (and so no whole-cell import of its cells)');
  assert.equal(v2.scattered.length, 1, 'V2: the native scatter takes it');
  assert.deepEqual([...v2.scattered[0].bytes], [...native], '...as V2\'s import would have made it');
  assert.equal(v2.win.store.has(v2.key) || v2.win.nativeStore.has(v2.key), false, 'both stores let it go (the window holds it)');
  assert.throws(() => restoreWin(false), /native owner/, 'no owner yet: a stored brick waits for V2 (never a V1 edit)');
  checks++;
  console.log(`PASS legacy-only stored bricks: ${cells} cells bit-exact with the import kernel's importA; a V2 window restores them natively`);
}
console.log(`PASS ${checks} native store checks (CPU, fake device; no GPU/browser)`);
