// A big map's next field tick packs only the CELL pages that changed. CPU
// only: the real Source -> Producer -> Fields -> adapter -> Atlas path, driven
// by the World owner's own field tick and packing (wire/worldRender.js
// worldAdvanceFields, worldClassify), on a GPU that counts commands and does
// no work (tools/world-cell-null-gpu.mjs).
//
// Island's and Descent's second tick (2026-10-22) packed every resident brick
// again on top of its old page: 400k on Island behind a 9.75 s stall, 650k on
// Descent past the pool's page cap ("WORLD page budget: cell pool of 1308933
// pages past 1048576"), every tick after the first. Here:
//   - the 8-bit field blend from a fresh brick's target rounds back to it, for
//     every channel's weight (why a load's field owners are born settled);
//   - a second tick with no change packs 0 bricks and reserves 0 pages;
//   - a change packs only the cores it reaches, as its owners settle, then 0;
//   - a tick near the page cap never throws, where packing the whole demand
//     again could not fit.
//
//   node tools/world-tick-repack-cpu-check.mjs [--cores 24] [--bricks N] [--verbose]
// --bricks sizes the world to about N demanded bricks (Island ~400000,
// Descent ~650000) for a report; the default is the gate's smaller world.
import assert from 'node:assert/strict';
import { NullGPU } from './world-cell-null-gpu.mjs';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderSource } from '../src/world/renderSource.js';
import { RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { WorldRenderAtlas, READY, WORLD_PAGE_BUDGET, worldBrickIndex } from '../src/world/renderAtlas.js';
import { BrickStore } from '../src/world/store.js';
import { gridDims } from '../src/shaders/common.js';
import { FIELD_EMA_SETTLE } from '../src/shaders/fields.js';
import { CHANNELS, MEDIA } from '../src/gfx/materials.js';
import { worldAdvanceFields, worldClassify } from '../src/wire/worldRender.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');

// ---- 1. a fresh brick's EMA is the blend's fixed point ----
// The EMA pass (shaders/fields.js fieldEmaFrag) stores pack4x8unorm of a fresh
// brick's target t, and the next tick blends mix(unpack(stored), t, w) and
// stores it again. That rounds back to the same byte for every target and
// every channel's weight w, with GLSL mix in either of its usual forms and
// float->unorm ties rounded up or to even (gfx/pacing.js blendFixedFrames'
// conventions), so a born owner never needs to advance.
const U8_MAX = 255, HALF_STEPS = 2 * U8_MAX;
// Targets: a uniform float32 grid this fine, and every half step of 8 bits
// (the rounding edges) with this many float32 neighbours on either side.
const TARGET_GRID = 1 << 16, EDGE_ULPS = 64;
{
  const f = Math.fround, ulp = new Float32Array(1), bitsOf = new Uint32Array(ulp.buffer);
  const toU8 = [
    (x) => Math.floor(f(Math.min(Math.max(x, 0), 1) * U8_MAX) + 0.5),
    (x) => { const v = f(Math.min(Math.max(x, 0), 1) * U8_MAX); return v - Math.floor(v) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v); },
  ];
  const step = (t, k) => { ulp[0] = t; bitsOf[0] += k; return ulp[0]; };
  const targets = [];
  for (let k = 0; k <= TARGET_GRID; k++) targets.push(f(k / TARGET_GRID));
  for (let k = 0; k <= HALF_STEPS; k++) {
    const edge = f(k / HALF_STEPS);
    for (let d = 1; d <= EDGE_ULPS; d++) { if (edge < 1) targets.push(step(edge, d)); if (edge > 0) targets.push(step(edge, -d)); }
  }
  const weights = [...new Set([...CHANNELS, ...MEDIA].map((c) => c.ema))];
  let compared = 0;
  for (const w of weights) {
    const wf = f(w), keep = f(1 - wf);
    const mixes = [(x, y) => f(f(x * keep) + f(y * wf)), (x, y) => f(x + f(wf * f(y - x)))];
    for (const t of targets) for (const q of toU8) for (const mix of mixes) {
      const stored = q(t), next = q(mix(f(stored / U8_MAX), t));
      if (next !== stored) assert.fail(`weight ${w}: a fresh target ${t} stored as ${stored} blends to ${next}: a born field owner would change`);
      compared++;
    }
  }
  console.log(`PASS a fresh field owner is the 8-bit blend's fixed point: ${compared} target/weight/mix/rounding cases, weights ${weights.join(', ')}`);
}

// ---- 2. the CELL path at a big map's scale ----
// A world of CORES x CORES 32-cell cores, one core tall, its ground a shell
// SHELL bricks thick: SHELL_BRICKS bricks a core, every one demanded.
const CORE = 32, BRICK = 4, CORE_BRICKS = CORE / BRICK, SHELL = [2, 4];
const SHELL_BRICKS = CORE_BRICKS * CORE_BRICKS * (SHELL[1] - SHELL[0]);
const CORES = args.includes('--bricks') ? Math.ceil(Math.sqrt(opt('bricks', 0) / SHELL_BRICKS)) : opt('cores', 24);
// A physics step's change: the simulation's box (sim.js noteContentChange,
// renderSource.js sourceBounds), here a 128-cell box in the middle of the world.
const SIM_BOX = 128;
// The page cap of the near-cap tick: room for the demand and this share of it
// again, less than a second copy of every page (renderAtlas.js reserve).
const CAP_SHARE = 1.5;

const size = [CORES * CORE, CORE, CORES * CORE], wb = size.map((v) => v / BRICK);
const gpu = new NullGPU(), g = gridDims({ nx: 32, ny: 32, nz: 32 }), buffer = (n) => gpu.createBuffer({ size: n });
const sim = { g, gpu, cur: 0, version: 0, origin: { x: 0, y: 0, z: 0 }, L: { TABLES: gpu.layout('TABLES', []) }, tables: {}, marks: buffer(16),
  state: { A: buffer(g.slots * 32), B: buffer(g.slots * 32), F: buffer(g.slots * 8) }, flow: buffer(g.slots * 8), decoPlane: { buffer: buffer(g.slots * 4), offset: 0 },
  _retire: (b) => gpu.retire(b), header() { return { src: this.cur, dst: this.cur, origin: [this.origin.x, 0, this.origin.z] }; }, onShift() { return () => {}; }, attachAeration(a) { this.aeration = a; }, wake() {} };
const win = { sim, gpu, size, wb, epoch: 1, scene: { key: 'tick-repack', glsl: () => '' }, loaded: true, planted: new Uint8Array(wb[0] * wb[2]), candidates: new Map(), store: new BrickStore(wb),
  gen: { ready: Promise.resolve(), res: { layout: [], entries: () => [], prepassFor() {} } } };
const source = new WorldRenderSource(win); win.renderSource = source; sim.worldRenderSource = source;
const producer = new RawWorldSourceProducer(win, source), atlas = new WorldRenderAtlas(gpu, { worldSize: size });
const cells = new WorldCellAtlasAdapter({ gpu, source, producer, atlas, tables: sim.tables, worldBounds: { min: [0, 0, 0], max: size } });
await cells.ready;
const book = atlas.bookLayout, brick = (i) => [i % wb[0], Math.floor(i / wb[0]) % wb[1], Math.floor(i / (wb[0] * wb[1]))];
const ids = new Set();
for (let z = 0; z < wb[2]; z++) for (let y = SHELL[0]; y < SHELL[1]; y++) for (let x = 0; x < wb[0]; x++) ids.add(worldBrickIndex(book, [x, y, z]));

// What a tick packs and reserves: the atlas's own calls. Reserved: the pages
// the owner's packing reserves for the tick (worldClassify), not the CELL
// adapter's own reservation per batch inside it.
const counts = { packed: 0, reserved: 0 };
const allocate = atlas.allocate.bind(atlas), reserve = atlas.reserve.bind(atlas);
atlas.allocate = (b, v) => { counts.packed++; return allocate(b, v); };
atlas.reserve = (kind, n) => { if (kind === 'cell' && !cells.pending) counts.reserved += n; return reserve(kind, n); };
const packedBricks = [];
async function tick(fieldTick) {
  counts.packed = counts.reserved = 0; packedBricks.length = 0;
  const seen = atlas.allocate;
  atlas.allocate = (b, v) => { packedBricks.push(b); return seen(b, v); };
  const t0 = performance.now(), capacity = atlas.resources.layout.capacity, nextID = atlas.cell.nextID;
  try {
    await worldAdvanceFields(gpu, cells, { fieldTick });
    await worldClassify(gpu, cells, atlas, ids, { fieldTick }, brick);
  } finally { atlas.allocate = seen; }
  gpu.flush();
  const out = { fieldTick, packed: counts.packed, reserved: counts.reserved, grew: atlas.resources.layout.capacity - capacity, newIDs: atlas.cell.nextID - nextID,
    unsettled: cells.fields.history.unsettledCount(), ms: performance.now() - t0 };
  if (VERBOSE) console.log(JSON.stringify(out));
  return out;
}

// Tick 1: the load.
const load = await tick(0);
assert.equal(load.packed, ids.size, 'the load packs every demanded brick');
assert.equal(atlas.live.cell.size, ids.size);
assert.equal(load.unsettled, 0, 'a load\'s field owners are born settled');
const loadPages = new Map([...atlas.live.cell].map(([i, p]) => [i, p]));

// Tick 2: nothing changed. Every page stays the one the load packed.
const second = await tick(1);
assert.equal(second.packed, 0, `a second field tick with no change packed ${second.packed} of ${ids.size} bricks again`);
assert.equal(second.reserved, 0, `a second field tick with no change reserved ${second.reserved} pages`);
assert.equal(second.grew, 0); assert.equal(second.newIDs, 0);
assert([...atlas.live.cell].every(([i, p]) => loadPages.get(i) === p), 'every page is the load\'s');
assert.equal(atlas.cellRevision, source.contentToken().sourceRevision, 'the book is current through this revision');

// Tick 3: a physics step changes the middle box. Only the cores it reaches pack;
// every demanded brick inside it does.
const mid = Math.floor(size[0] / 2 / CORE) * CORE, lo = [mid - SIM_BOX / 2, 0, mid - SIM_BOX / 2], hi = [mid + SIM_BOX / 2, CORE, mid + SIM_BOX / 2];
source.noteContentChange({ lo, hi });
const changed = await tick(2);
// A change reaches a core's fields within the blur and the EMA halo (fields.js
// touchedCores: 8 cells): the cores that box, grown by that, overlaps.
const REACH = 8, near = (b) => b.every((n, k) => k === 1 || (n * BRICK + BRICK > lo[k] - REACH - CORE && n * BRICK < hi[k] + REACH + CORE));
const inBox = [...ids].map(brick).filter((b) => b.every((n, k) => n * BRICK < hi[k] && n * BRICK + BRICK > lo[k]));
assert(changed.packed >= inBox.length, `a change packed ${changed.packed} bricks, fewer than the ${inBox.length} it covers`);
assert(packedBricks.every(near), 'a change packed a brick outside the cores it reaches');
assert(changed.packed < ids.size / 4, `a ${SIM_BOX}-cell change packed ${changed.packed} of ${ids.size} bricks`);
const reach = new Set(packedBricks.map((b) => b.join(',')));
// Its owners settle over FIELD_EMA_SETTLE ticks, packing only those cores again, then stop.
let settling = [];
for (let k = 0; k <= FIELD_EMA_SETTLE; k++) {
  const r = await tick(3 + k); settling.push(r.packed);
  assert(packedBricks.every((b) => reach.has(b.join(','))), 'settling packed a brick its change did not reach');
}
assert.equal(settling.at(-1), 0, `a change's owners settle in ${FIELD_EMA_SETTLE} ticks (packed ${settling.join('/')})`);
assert.equal(cells.fields.history.unsettledCount(), 0);

// Tick near the page cap: the pool may hold the demand and half of it again.
// Packing every page again (the old rule) needs room for a second copy of
// each; the next tick needs none and never throws.
const used = atlas.cell.nextID - atlas.cell.free.length, cap = Math.max(atlas.resources.layout.capacity, Math.ceil(CAP_SHARE * ids.size));
atlas.setPageBudget({ cell: cap, light: cap, probe: cap });
assert.throws(() => reserve('cell', ids.size), new RegExp(WORLD_PAGE_BUDGET), `the cap of ${cap} pages has no room for a second copy of ${used}: the fixture is near it`);
const capped = await tick(4 + FIELD_EMA_SETTLE);
assert.equal(capped.packed, 0); assert(atlas.resources.layout.capacity <= cap);

console.log(`PASS a big map's next field tick packs only what changed: ${ids.size} bricks in ${CORES * CORES} cores; load ${load.packed} packed;`
  + ` 2nd tick ${second.packed} packed, ${second.reserved} reserved (${second.ms.toFixed(0)} ms); a ${SIM_BOX}-cell change ${changed.packed} packed, settling ${settling.join('/')}; near the ${cap}-page cap ${capped.packed} packed, no throw`);
console.log(`(info, not checked) load ${(load.ms / 1000).toFixed(1)} s, 2nd tick ${second.ms.toFixed(0)} ms, change tick ${changed.ms.toFixed(0)} ms`);
