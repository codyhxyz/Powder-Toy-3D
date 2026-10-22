// What a big map's atlas commits upload to their books, on Island's own
// demand. CPU only: the real Source -> Fields -> CELL adapter -> Atlas path,
// driven by the World owner's field tick and packing (wire/worldRender.js
// worldAdvanceFields, worldClassify), and a lighting tick's LIGHT book commits
// as attempt() makes them, on a GPU that counts commands and does no work
// (tools/world-cell-null-gpu.mjs). The demand is the CPU load model's for
// Island's start (tools/world-demand-model.mjs): its packed bricks, SOURCES
// and gathered probes.
//
// Real Chrome on Island (2026-10-22, e7787283): 3.0 s of queue.writeBuffer in
// the 20 s after the first frame, all of it book chunks, 12 stalls of
// 0.3-4.1 s. A commit sent every 64 KiB chunk holding a changed entry, and a
// lighting tick's scattered changes touched most of an 8 MiB book's chunks,
// commit after commit (a classify batch, the LIGHT clears, restores and
// publication). Here, per commit:
//   - the bytes sent are at most BOOK_BYTES_PER_ENTRY per changed entry plus
//     a run's fixed overhead, never chunks of unchanged entries;
//   - a commit's writes are at most one per changed run (runs closer than
//     renderAtlas.js BOOK_RUN_GAP_WORDS merged);
//   - a book whose entries all cleared is a fresh zero buffer: nothing sent,
//     nothing copied;
//   - a book no snapshot handle or other state reads is patched in place: a
//     lighting tick copies no book and makes at most TICK_BOOKS new ones (its
//     cleared LIGHT book and its private closure's), where each of its 33
//     commits copied an 8 MiB book into a new one;
//   - no commit's book build takes more than COMMIT_JS_MS of JS;
//   - and a lighting tick sends at least TICK_CUT times fewer bytes than the
//     64 KiB chunks did (that rule is measured here, on the same commits).
//
//   node tools/world-book-writes-cpu-check.mjs [--ticks N] [--verbose] [--gaps]
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { NullGPU } from './world-cell-null-gpu.mjs';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderSource } from '../src/world/renderSource.js';
import { RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { WorldRenderAtlas, READY, BOOK_RUN_GAP_WORDS, worldBrickIndex } from '../src/world/renderAtlas.js';
import { BrickStore } from '../src/world/store.js';
import { gridDims } from '../src/shaders/common.js';
import { worldAdvanceFields, worldClassify } from '../src/wire/worldRender.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { demandWorld, modelLoad } from './world-demand-model.mjs';
import { WORLD_GI_NEAR_RADIUS } from '../src/world/worldGIRing.js';
import { worldPageBudget } from '../src/world/worldViewRing.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');
// --gaps: what each merge gap would send and how many writes, on the same commits
const GAPS = args.includes('--gaps');
// Lighting ticks after the load: V2 changes the window's cells every step, so
// every tick changes it (sim.js noteContentChange: the window's whole box).
const TICKS = opt('ticks', 3);
// The window (app.js WORLDS.world.win) around the eye.
const WINDOW = [128, 128, 128];
// The 64 KiB chunks the books were sent in before (e7787283), for the comparison.
const OLD_CHUNK_WORDS = 16384;
// A changed entry is a 4-byte word.
const BOOK_BYTES_PER_ENTRY = 4;
// A lighting tick sends at least this many times fewer book bytes than the 64 KiB chunks did.
const TICK_CUT = 20;
// No commit's book build takes longer than this, in JS (the NullGPU's calls cost nothing).
const COMMIT_JS_MS = 5;
// New books a lighting tick makes: the cleared LIGHT book and the private closure's.
const TICK_BOOKS = 2;

// ---- Island's demand: the load model's, from its start (world-demand-chain-cpu-check.mjs camera) ----
const SUN = [0.55, 0.62, 0.32], EYE_LIFT = 6, PITCH = -8 * Math.PI / 180, VFOV = 70, VIEW = [256, 144];
const island = WORLD_SCENES.find((s) => s.key === 'island');
const size = island.size ?? WORLD_SIZE, P = island.params({ size, seed: 0 });
await island.prepare?.(P);
const [ex, ez] = island.start(P, [128, 128]), cam = [ex, island.ground(ex, ez, P) + EYE_LIFT, ez];
let values, rays = [];
{
  const centre = P.center ?? [size[0] / 2, size[2] / 2], yaw = Math.atan2(centre[1] - ez, centre[0] - ex);
  const fw = [Math.cos(yaw) * Math.cos(PITCH), Math.sin(PITCH), Math.sin(yaw) * Math.cos(PITCH)];
  const c = new PerspectiveCamera(VFOV, VIEW[0] / VIEW[1], 0.1, 1e5);
  c.position.set(...cam); c.lookAt(cam[0] + fw[0], cam[1] + fw[1], cam[2] + fw[2]); c.updateMatrixWorld(); c.updateProjectionMatrix();
  values = { cam, viewProj: c.projectionMatrix.clone().multiply(c.matrixWorldInverse).toArray(), model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  for (let j = 0; j < VIEW[1]; j++) for (let i = 0; i < VIEW[0]; i++) {
    const p = new Vector3((i + 0.5) / VIEW[0] * 2 - 1, 1 - (j + 0.5) / VIEW[1] * 2, 1).unproject(c).sub(c.position).normalize();
    rays.push([p.x, p.y, p.z]);
  }
}
const model = demandWorld({ size, scene: island, P, sun: SUN });
const demand = await modelLoad(model, { cam, rays, values, sun: SUN, forecast: 'view', sources: 'eligible', resetBirths: true, rings: true, giRing: WORLD_GI_NEAR_RADIUS,
  glow: true, viewRing: true, budget: worldPageBudget({ deviceMemoryGB: 8 }).cell, sourceReach: true, carry: true, maxAttempts: 4 });
assert(demand.done && demand.cellSet.size > 100000, `Island's modelled load: ${demand.cellSet.size} bricks`);

// ---- the CELL path at Island's size (world-tick-repack-cpu-check.mjs) ----
const wb = size.map((v) => v / 4);
const gpu = new NullGPU(), g = gridDims({ nx: 32, ny: 32, nz: 32 }), buffer = (n) => gpu.createBuffer({ size: n });
const sim = { g, gpu, cur: 0, version: 0, origin: { x: 0, y: 0, z: 0 }, L: { TABLES: gpu.layout('TABLES', []) }, tables: {}, marks: buffer(16),
  state: { A: buffer(g.slots * 32), B: buffer(g.slots * 32), F: buffer(g.slots * 8) }, flow: buffer(g.slots * 8), decoPlane: { buffer: buffer(g.slots * 4), offset: 0 },
  _retire: (b) => gpu.retire(b), header() { return { src: this.cur, dst: this.cur, origin: [this.origin.x, 0, this.origin.z] }; }, onShift() { return () => {}; }, attachAeration(a) { this.aeration = a; }, wake() {} };
const win = { sim, gpu, size, wb, epoch: 1, scene: { key: 'book-writes', glsl: () => '' }, loaded: true, planted: new Uint8Array(wb[0] * wb[2]), candidates: new Map(), store: new BrickStore(wb),
  gen: { ready: Promise.resolve(), res: { layout: [], entries: () => [], prepassFor() {} } } };
const source = new WorldRenderSource(win); win.renderSource = source; sim.worldRenderSource = source;
const producer = new RawWorldSourceProducer(win, source), atlas = new WorldRenderAtlas(gpu, { worldSize: size });
const cells = new WorldCellAtlasAdapter({ gpu, source, producer, atlas, tables: sim.tables, worldBounds: { min: [0, 0, 0], max: size } });
await cells.ready;
const book = atlas.bookLayout, brick = (i) => [i % wb[0], Math.floor(i / wb[0]) % wb[1], Math.floor(i / (wb[0] * wb[1]))];
const fromModel = (set) => new Set([...set].map((i) => worldBrickIndex(book, model.brick(i))));
const ids = fromModel(demand.cellSet), sources = fromModel(demand.sourceSet), probes = fromModel(demand.probeSet);

// ---- counting: every book upload, copy and allocation, per commit and book ----
const kindOf = (b) => /immutable light book/.test(b?.label ?? '') ? 'light' : /immutable book/.test(b?.label ?? '') ? 'cell' : null;
const zero = () => ({ calls: 0, bytes: 0, copied: 0, made: 0 });
const sent = { cell: zero(), light: zero() };
const writeBuffer = gpu.queue.writeBuffer;
gpu.queue.writeBuffer = (b, offset, data, at = 0, n) => {
  const kind = kindOf(b);
  if (kind) {
    const bytes = (n ?? (data.length - at)) * (data.BYTES_PER_ELEMENT ?? 1);
    assert(offset % 4 === 0 && offset + bytes <= book.bytes, 'book write out of range');
    sent[kind].calls++; sent[kind].bytes += bytes;
  }
  return writeBuffer.call(gpu.queue, b, offset, data, at, n);
};
const encoder = gpu.device.createCommandEncoder;
gpu.device.createCommandEncoder = (d) => { const e = encoder(d), copy = e.copyBufferToBuffer; e.copyBufferToBuffer = (s, so, t, to, n) => { const kind = kindOf(t); if (kind) sent[kind].copied += n; return copy(s, so, t, to, n); }; return e; };
const createBuffer = gpu.device.createBuffer;
gpu.device.createBuffer = (d) => { const kind = kindOf(d); if (kind) sent[kind].made += d.size; return createBuffer(d); };
// The old rule's bytes for the same commit: every 64 KiB chunk holding a changed entry.
const chunkBytes = (changed) => { const c = new Set(); for (const i of changed) c.add(Math.floor(i / OLD_CHUNK_WORDS)); let n = 0; for (const k of c) n += Math.min(OLD_CHUNK_WORDS, book.count - k * OLD_CHUNK_WORDS) * 4; return n; };
const commits = [];
let stage = 'load';
const snapshotState = atlas._snapshotState.bind(atlas);
atlas._snapshotState = (entries, lightEntries, books, ...rest) => {
  const before = { cell: { ...sent.cell }, light: { ...sent.light } }, t0 = performance.now();
  const s = snapshotState(entries, lightEntries, books, ...rest);
  const ms = performance.now() - t0, c = { stage, ms };
  for (const kind of ['cell', 'light']) {
    const changed = new Set(books[kind].changed);
    if (GAPS) c[kind + 'Sorted'] = Uint32Array.from(changed).sort();
    c[kind] = { changed: changed.size, runs: runsOf(changed), oldBytes: changed.size || !books[kind].base ? chunkBytes(changed) : 0,
      ...Object.fromEntries(Object.keys(zero()).map((k) => [k, sent[kind][k] - before[kind][k]])) };
  }
  for (const k of ['changed', 'runs', 'oldBytes', ...Object.keys(zero())]) c[k] = c.cell[k] + c.light[k];
  commits.push(c);
  return s;
};
// Changed entries' runs, nearer than the merge gap counted as one.
function runsOf(set) {
  const sorted = Uint32Array.from(set).sort(); let runs = 0;
  for (let k = 0; k < sorted.length; k++) if (!k || sorted[k] - sorted[k - 1] > BOOK_RUN_GAP_WORDS + 1) runs++;
  return runs;
}

// ---- LIGHT pages: attempt()'s commits (worldRender.js restoreJobs, publishFinal) ----
let lightTick = 0;
const noop = () => {}, pause = () => new Promise((resolve) => setTimeout(resolve, 0));
function publishLight(set) {
  lightTick++;
  const jobs = [...set].map((i) => atlas.allocateLight(brick(i), { sourceRevision: source.contentToken().sourceRevision, sourceTick: lightTick, giTick: lightTick,
    readyBits: (sources.has(i) ? READY.GI_SOURCE : 0) | (probes.has(i) ? READY.GI : 0) }));
  atlas.recordPageWrites(jobs.flatMap((job) => [...(sources.has(atlas.light.pages.get(job.lightDescriptorID).index) ? [{ job, kind: 'source', record: noop }] : []),
    ...(job.probePID !== null ? [{ job, kind: 'gi', record: noop }] : [])]));
  atlas.publish({ lightJobs: jobs });
}
// prepareProducerSnapshot's books (a private LIGHT book of the restored
// closure on the current CELL book), without its ledger leases.
function privateBook(set) {
  const lights = new Uint32Array(book.count); for (const i of set) lights[i] = 1;
  const s = atlas._snapshotState(atlas.entries, lights, { cell: { base: atlas.current.book, changed: [] }, light: { base: null, changed: set } }, [],
    atlas.resources, atlas.epoch, atlas.current.dependencies, atlas.current.sunManifest, atlas.generation + 1, atlas.generation);
  s.producerOnly = true; atlas._releaseSnapshot(s);
}
const lit = new Set([...sources, ...probes]);
async function tick(fieldTick, change) {
  if (change) source.noteContentChange(change);
  stage = `tick ${fieldTick} fields`; await worldAdvanceFields(gpu, cells, { fieldTick });
  stage = `tick ${fieldTick} classify`; await worldClassify(gpu, cells, atlas, ids, { fieldTick }, brick);
  // attempt() awaits between its LIGHT commits (metadata, restore transport, the sun, the GI passes)
  stage = `tick ${fieldTick} light clear`; await pause(); atlas.publish({ invalidations: atlas.bookPages('light').map((p) => ({ brick: [...p.brick], channels: READY.LIGHT })), sunManifest: null });
  stage = `tick ${fieldTick} restore`; await pause(); publishLight(lit);
  stage = `tick ${fieldTick} private`; await pause(); privateBook(lit);
  stage = `tick ${fieldTick} publish`; await pause(); publishLight(lit);
  gpu.flush();
}
const sum = (list) => list.reduce((a, c) => ({ commits: a.commits + 1, calls: a.calls + c.calls, bytes: a.bytes + c.bytes, oldBytes: a.oldBytes + c.oldBytes, copied: a.copied + c.copied, made: a.made + c.made, changed: a.changed + c.changed, ms: Math.max(a.ms, c.ms) }),
  { commits: 0, calls: 0, bytes: 0, oldBytes: 0, copied: 0, made: 0, changed: 0, ms: 0 });
const MiB = (n) => (n / 1024 ** 2).toFixed(2);
const report = (name, s) => console.log(`${name}: ${s.commits} commits, ${s.changed} changed entries; sent ${MiB(s.bytes)} MiB in ${s.calls} writes (64 KiB chunks: ${MiB(s.oldBytes)} MiB, ${(s.oldBytes / Math.max(1, s.bytes)).toFixed(0)}x); copied ${MiB(s.copied)} MiB, made ${MiB(s.made)} MiB; slowest book build ${s.ms.toFixed(2)} ms`);

// The load: the field tick, every demanded brick packed, then its lighting.
await tick(0, null);
assert.equal(atlas.live.cell.size, ids.size, 'the load packs every demanded brick');
const load = sum(commits);
report(`Island load (${ids.size} bricks, ${lit.size} light pages)`, load);
// Lighting ticks: V2 changes the window's box every step.
const lo = [Math.max(0, Math.floor(cam[0] - WINDOW[0] / 2)), 0, Math.max(0, Math.floor(cam[2] - WINDOW[2] / 2))], hi = [lo[0] + WINDOW[0], WINDOW[1], lo[2] + WINDOW[2]];
const ticks = [];
for (let k = 1; k <= TICKS; k++) {
  const from = commits.length;
  await tick(k, { lo, hi });
  ticks.push(sum(commits.slice(from)));
  report(`lighting tick ${k}`, ticks.at(-1));
}
if (VERBOSE) for (const c of commits) console.log(`  ${c.stage}: ${['cell', 'light'].map((k) => `${k} ${c[k].changed} changed, ${c[k].runs} runs; ${c[k].calls} writes, ${c[k].bytes} B (chunks ${c[k].oldBytes} B), copied ${c[k].copied} B, made ${c[k].made} B`).join(' | ')}; ${c.ms.toFixed(2)} ms`);

if (GAPS) for (const gap of [0, 8, 16, 32, 64, 128, 256, 512]) {
  let calls = 0, bytes = 0, maxCalls = 0;
  for (const c of commits.slice(-ticks.at(-1).commits)) {
    let n = 0;
    for (const sorted of [c.cellSorted, c.lightSorted]) for (let k = 0; k < sorted.length;) {
      const start = sorted[k]; let stop = start + 1;
      while (++k < sorted.length && sorted[k] <= stop + gap) stop = sorted[k] + 1;
      n++; bytes += (stop - start) * 4;
    }
    calls += n; maxCalls = Math.max(maxCalls, n);
  }
  console.log(`  gap ${gap} words: a lighting tick ${MiB(bytes)} MiB in ${calls} writes, at most ${maxCalls} in a commit`);
}
// ---- the bounds ----
for (const c of commits) {
  assert(c.bytes <= c.changed * BOOK_BYTES_PER_ENTRY * (BOOK_RUN_GAP_WORDS + 1), `${c.stage}: ${c.bytes} bytes for ${c.changed} changed entries`);
  assert(c.calls <= c.runs, `${c.stage}: ${c.calls} writes for ${c.runs} runs of changed entries`);
  assert(c.ms <= COMMIT_JS_MS, `${c.stage}: a commit's books took ${c.ms.toFixed(1)} ms of JS`);
}
// A tick's field commit clears every LIGHT page: its light book is zeros, sent and copied nothing.
for (const c of commits.filter((c) => /^tick [1-9]\d* fields$/.test(c.stage))) assert(c.light.changed === lit.size && c.light.bytes === 0 && c.light.copied === 0, `${c.stage}: clearing every LIGHT page sent ${c.light.bytes} bytes, copied ${c.light.copied}`);
for (const [k, t] of ticks.entries()) assert(t.copied === 0 && t.made <= TICK_BOOKS * book.bytes, `lighting tick ${k + 1} copied ${MiB(t.copied)} MiB of books and made ${MiB(t.made)} MiB of new ones`);
for (const [k, t] of ticks.entries()) assert(t.oldBytes >= TICK_CUT * t.bytes, `lighting tick ${k + 1} sent ${MiB(t.bytes)} MiB, only ${(t.oldBytes / t.bytes).toFixed(1)}x fewer than the 64 KiB chunks' ${MiB(t.oldBytes)} MiB`);
console.log(`PASS a big map's atlas commits send only their changed entries: Island ${ids.size} bricks; a lighting tick ${MiB(ticks.at(-1).bytes)} MiB in ${ticks.at(-1).calls} writes over ${ticks.at(-1).commits} commits, ${(ticks.at(-1).oldBytes / ticks.at(-1).bytes).toFixed(0)}x under the 64 KiB chunks' ${MiB(ticks.at(-1).oldBytes)} MiB; slowest commit ${Math.max(...commits.map((c) => c.ms)).toFixed(2)} ms`);
