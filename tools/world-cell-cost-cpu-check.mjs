// A World load's CELL stage costs the same per batch however much it has
// already loaded. CPU only: the real Source -> Producer -> Fields -> adapter ->
// Atlas path on a GPU that counts commands and does no work.
//
// Operation counts, not wall time: every entry a Map or Set iterator hands out
// during a batch (copies, spreads, for-of, forEach), and the GPU commands it
// records. Island's CELL batches grew with what they had loaded: each copied
// and visited every field owner and pinned every resident page, 87 us a brick
// for its first 235k and 237 us for the next 240k (2026-10-22). Here a later
// batch of the same shape as an earlier one, with several times the resident
// pages, must count the same operations.
//
//   node tools/world-cell-cost-cpu-check.mjs [--rows 24] [--verbose]
import assert from 'node:assert/strict';
import { NullGPU } from './world-cell-null-gpu.mjs';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderSource } from '../src/world/renderSource.js';
import { RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { WorldRenderAtlas, READY } from '../src/world/renderAtlas.js';
import { BrickStore } from '../src/world/store.js';
import { gridDims } from '../src/shaders/common.js';
import { worldClassifyBatches, WORLD_CLASSIFY_BRICKS, WORLD_CLASSIFY_COLUMNS } from '../src/wire/worldRender.js';
import { HistoryCopies } from '../src/world/fieldHistory.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');
// The fixture: a world of CORES_X x ROWS cores of 32 cells, its ground a shell
// SHELL bricks thick inside the bottom core layer. Classified in rows of cores
// along x, so every batch of a row past the first meets the same neighbours
// (the row before it loaded, the row after it not): its work is the same.
const CORES_X = 32, ROWS = opt('rows', 24), HEIGHT = 64, SHELL = [2, 4];
const CORE = 32, BRICK = 4, CORE_BRICKS = CORE / BRICK;
// The rows compared: one early, past the world's edge row, and the last one
// whose next row is still interior.
const EARLY_ROW = 2, LATE_ROW = ROWS - 3;
// A later batch may differ from its early twin by this share of its counts:
// none expected, a little room for a cache whose size is the loaded cores
// (the adapter's capture snapshot per publication, ~1 entry a core).
const OPERATION_TOLERANCE = 0.02;
// The fixture must load several times as much between its two rows for the
// comparison to mean anything.
const MIN_RESIDENCY_GROWTH = 4;

// ---- operation counter: Map/Set entries handed out by their iterators ----
const counter = { entries: 0 };
function countIterators(proto) {
  const wrap = (it) => ({ next() { const r = it.next(); if (!r.done) counter.entries++; return r; }, [Symbol.iterator]() { return this; } });
  for (const name of ['entries', 'keys', 'values']) {
    const original = proto[name];
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...a) { return wrap(original.apply(this, a)); } });
  }
  Object.defineProperty(proto, Symbol.iterator, { configurable: true, writable: true, value: proto === Map.prototype ? proto.entries : proto.values });
  const forEach = proto.forEach;
  Object.defineProperty(proto, 'forEach', { configurable: true, writable: true, value: function (fn, self) { counter.entries += this.size; return forEach.call(this, fn, self); } });
}
countIterators(Map.prototype); countIterators(Set.prototype);
// Self-test: copies, spreads and loops are all seen.
{
  const m = new Map([[1, 1], [2, 2]]), s = new Set([1, 2, 3]), before = counter.entries;
  new Map(m); [...s]; for (const _ of m.values()); s.forEach(() => {}); Array.from(m.keys());
  assert.equal(counter.entries - before, 2 + 3 + 2 + 3 + 2, 'the operation counter sees Map/Set copies, spreads and loops');
}

// ---- the real CELL path on a counting GPU ----
const size = [CORES_X * CORE, HEIGHT, ROWS * CORE], wb = size.map((v) => v / BRICK);
const gpu = new NullGPU(), g = gridDims({ nx: 32, ny: 32, nz: 32 }), buffer = (n) => gpu.createBuffer({ size: n });
const sim = { g, gpu, cur: 0, version: 0, origin: { x: 0, y: 0, z: 0 }, L: { TABLES: gpu.layout('TABLES', []) }, tables: {}, marks: buffer(16),
  state: { A: buffer(g.slots * 32), B: buffer(g.slots * 32), F: buffer(g.slots * 8) }, flow: buffer(g.slots * 8), decoPlane: { buffer: buffer(g.slots * 4), offset: 0 },
  _retire: (b) => gpu.retire(b), header() { return { src: this.cur, dst: this.cur, origin: [this.origin.x, 0, this.origin.z] }; }, onShift() { return () => {}; }, attachAeration(a) { this.aeration = a; }, wake() {} };
const win = { sim, gpu, size, wb, epoch: 1, scene: { key: 'cell-cost', glsl: () => '' }, loaded: true, planted: new Uint8Array(wb[0] * wb[2]), candidates: new Map(), store: new BrickStore(wb),
  gen: { ready: Promise.resolve(), res: { layout: [], entries: () => [], prepassFor() {} } } };
const source = new WorldRenderSource(win); win.renderSource = source; sim.worldRenderSource = source;
const producer = new RawWorldSourceProducer(win, source), atlas = new WorldRenderAtlas(gpu, { worldSize: size });
const cells = new WorldCellAtlasAdapter({ gpu, source, producer, atlas, tables: sim.tables, worldBounds: { min: [0, 0, 0], max: size } });
await cells.ready;

// The demand, core by core in row order, as a load's classify batches it.
const bricks = [];
for (let cz = 0; cz < ROWS; cz++) for (let cx = 0; cx < CORES_X; cx++)
  for (let z = 0; z < CORE_BRICKS; z++) for (let y = SHELL[0]; y < SHELL[1]; y++) for (let x = 0; x < CORE_BRICKS; x++) bricks.push([cx * CORE_BRICKS + x, y, cz * CORE_BRICKS + z]);
atlas.reserve('cell', bricks.length);
const batches = worldClassifyBatches(bricks);
const perRow = batches.length / ROWS;
assert(Number.isInteger(perRow) && batches.every((b) => b.length === batches[0].length), 'fixture rows split into equal whole-core batches');
assert(batches[0].length <= WORLD_CLASSIFY_BRICKS, 'fixture batches are classify-sized');

// The field history copies a batch's pages in a dispatch a copy run and pool
// slab, with a bind group a slab (world/fieldHistory.js HistoryCopies): a run
// across a slab's edge takes a dispatch more, and the batch that fills a slab
// makes the next. Where the edges fall is the pool's size, not a batch's work,
// so those count apart, bounded below; every other command must match its
// twin's exactly.
const history = cells.fields.history, copy = { dispatches: 0, runs: 0, groups: 0 }, copyKernel = cells.fields.historyCopy.kernel, dispatch = copyKernel.dispatch;
copyKernel.dispatch = function (...a) { copy.dispatches++; return dispatch.apply(this, a); };
const begin = HistoryCopies.prototype.begin, bindGroup = gpu.bindGroup;
HistoryCopies.prototype.begin = function (...a) { copy.runs++; return begin.apply(this, a); };
gpu.bindGroup = function (layout, entries, name) { if (layout === cells.fields.historyCopy.layout) copy.groups++; return bindGroup.call(this, layout, entries, name); };
const rows = [], gpuTotal = () => Object.values(gpu.counts).reduce((a, b) => a + b, 0) - copy.dispatches - copy.groups - history.slabs.length;
for (const [k, requirements] of batches.entries()) {
  if (k) await new Promise((r) => setTimeout(r, 0));
  const e0 = counter.entries, g0 = gpuTotal(), d0 = copy.dispatches, r0 = copy.runs, s0 = history.slabs.length, t0 = performance.now(), options = { fieldTick: 0, requirements, smoothing: 1 };
  // As a load's classify does: the batch's source columns a task at a time.
  while (cells.recordSourceColumns(gpu.frame, options, WORLD_CLASSIFY_COLUMNS)) gpu.flush();
  const h = cells.record(gpu.frame, options);
  gpu.flush();
  const p = cells.commitAfterSourceFlush(h); p.previousLightingSnapshot.release();
  const ms = performance.now() - t0;
  rows.push({ k, row: Math.floor(k / perRow), slot: k % perRow, n: requirements.length, resident: atlas.live.cell.size, entries: counter.entries - e0, gpu: gpuTotal() - g0, ms,
    copyDispatches: copy.dispatches - d0, copyRuns: copy.runs - r0, slabs: history.slabs.length - s0 });
  // A run's copies are pages allocated together (a load's): at most one slab edge apart.
  const last = rows.at(-1);
  assert(last.copyDispatches <= 2 * last.copyRuns, `batch ${k}: ${last.copyDispatches} history copy dispatches for ${last.copyRuns} copy runs`);
  if (VERBOSE) console.log(JSON.stringify(rows.at(-1)));
}
assert.equal(atlas.live.cell.size, bricks.length, 'every requested brick has a CELL page');

const at = (row, slot) => rows.find((r) => r.row === row && r.slot === slot);
let worst = 0;
for (let slot = 0; slot < perRow; slot++) {
  const a = at(EARLY_ROW, slot), b = at(LATE_ROW, slot);
  assert(b.resident >= MIN_RESIDENCY_GROWTH * a.resident, `fixture loads ${MIN_RESIDENCY_GROWTH}x between its compared rows (${a.resident} -> ${b.resident})`);
  assert.equal(b.gpu, a.gpu, `batch ${b.k} records as many GPU commands as its twin ${a.k}`);
  const growth = (b.entries - a.entries) / a.entries;
  worst = Math.max(worst, growth);
  assert(growth <= OPERATION_TOLERANCE, `batch ${b.k} (${b.resident} resident) counts ${b.entries} Map/Set entries, its twin ${a.k} (${a.resident} resident) ${a.entries}: +${(100 * growth).toFixed(1)}%, over ${100 * OPERATION_TOLERANCE}%: a CELL batch's work grows with what is already loaded`);
}
const early = rows.filter((r) => r.row === EARLY_ROW), late = rows.filter((r) => r.row === LATE_ROW);
const us = (list) => (1000 * list.reduce((a, r) => a + r.ms, 0) / list.reduce((a, r) => a + r.n, 0)).toFixed(1);
console.log(`PASS a CELL batch's operations do not grow with resident pages: row ${EARLY_ROW} (${early[0].resident} resident) vs row ${LATE_ROW} (${late[0].resident}), Map/Set entries ${early.map((r) => r.entries).join('/')} vs ${late.map((r) => r.entries).join('/')} (+${(100 * worst).toFixed(2)}%), GPU commands ${early[0].gpu} each, and ${early[0].copyDispatches} history copy dispatches for ${early[0].copyRuns} copy runs`);
console.log(`(info, not checked) ${us(early)} vs ${us(late)} us a brick; ${bricks.length} bricks in ${batches.length} batches`);
