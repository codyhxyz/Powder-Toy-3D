// A big map's field-history page copies take a few GPU commands a batch,
// whatever its owners, and move every bit. CPU only: no browser, no GPU.
//
// Each owner page moved by 3 native copyBufferToBuffer calls (a 256-byte plane
// each), both ways: 2.8 s of copyBufferToBuffer in 20 s of Island after its
// first frame (real Chrome, 2026-10-22). Now a batch stages every copy into one
// job list and dispatches the copy kernel once per run and pool slab
// (world/fieldHistory.js HistoryCopies, shaders/fieldHistory.js). Here:
//   1. the kernel's actual WGSL (CPU-executed) moves exactly the words the old
//      native copies moved, both ways, slab by slab, and nothing else; the
//      fake GPUs' copy (field-test-gpu.mjs) is the same function;
//   2. WorldFields records no native history copy, and a batch's history
//      dispatches do not grow with its owners (O(1): a run and slab each);
//   3. a pool of many small slabs ends with the same history, word for word,
//      as one slab, each run dispatched once per slab it touches.
//
//   node tools/world-field-copies-cpu-check.mjs
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { nagaExec } from './naga.mjs';
import { FieldTestGPU, fieldHistoryCopy, FIELD_HISTORY_KERNEL } from './field-test-gpu.mjs';
import { E } from '../src/elements.js';
import { gridDims, cellSlot } from '../src/shaders/common.js';
import { fold } from '../src/gpu/kernels.js';
import { fieldHistoryWGSL, FieldHistoryParams, FIELD_HISTORY_JOB_WORDS } from '../src/shaders/fieldHistory.js';
import { WorldFields } from '../src/world/fields.js';
import { WorldFieldHistory, HISTORY_WORDS } from '../src/world/fieldHistory.js';

// ---- 1. the WGSL moves the old native copies' words, and only those ----
class Exec extends WgslExec {
  _dispatchWorkgroup(fn, id, context) {
    // wgsl_reflect parses a single workgroup size as a string (world-cell-adapter-cpu-check.mjs).
    for (const a of fn.node.attributes ?? []) if (a.name === 'workgroup_size' && typeof a.value === 'string') a.value = [a.value];
    return super._dispatchWorkgroup(fn, id, context);
  }
}
const SMALL = gridDims({ nx: 16, ny: 16, nz: 16 }), code = fieldHistoryWGSL(SMALL), program = new WgslParser().parse(code);
nagaExec(fieldHistoryWGSL(gridDims({ nx: 64, ny: 64, nz: 64 })), 'world-field-history.wgsl', { timeout: 10000 });
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
// Every word random, with float specials among them: NaN payloads, infinities, signed zeros, subnormals.
const SPECIAL = [0x7fc12345, 0xffc00001, 0x7f800000, 0xff800000, 0x80000000, 0, 1, 0x807fffff];
const words = (n) => Uint32Array.from({ length: n }, (_, i) => (i % 97 < SPECIAL.length ? SPECIAL[i % 97] : random()));
const PAGES = 6, SLABS = 2;
// Jobs across both slabs, interleaved, distinct bricks and pages, after a
// prefix the dispatch must skip (P.first).
const PREFIX = 2, jobs = [];
for (let k = 0; k < 9; k++) jobs.push({ brick: (k * 7 + 3) % SMALL.nbricks, slab: k % SLABS, page: Math.floor(k / SLABS) });
const list = new Uint32Array((PREFIX + jobs.length) * FIELD_HISTORY_JOB_WORDS).fill(0xffffffff);
jobs.forEach((j, k) => list.set([j.brick * 64, j.page * HISTORY_WORDS, j.slab], (PREFIX + k) * FIELD_HISTORY_JOB_WORDS));
// The old path: per plane, copyBufferToBuffer of 256 bytes between scratch
// slot (plane * SLOTS + brick * 64) and page word (page * 192 + plane * 64).
function nativeCopies(ema, pools, scatter) {
  for (const j of jobs) for (let plane = 0; plane < 3; plane++) {
    const s = plane * SMALL.slots + j.brick * 64, q = j.page * HISTORY_WORDS + plane * 64, pool = pools[j.slab];
    if (scatter) pool.set(ema.slice(s, s + 64), q); else ema.set(pool.slice(q, q + 64), s);
  }
}
let executed = 0;
for (const scatter of [false, true]) {
  const ema = words(3 * SMALL.slots), pools = Array.from({ length: SLABS }, () => words(PAGES * HISTORY_WORDS));
  const expected = { ema: ema.slice(), pools: pools.map((p) => p.slice()) };
  nativeCopies(expected.ema, expected.pools, scatter);
  const viaWGSL = { ema: ema.slice(), pools: pools.map((p) => p.slice()) }, viaFake = { ema: ema.slice(), pools: pools.map((p) => p.slice()) };
  const desc = { code }, buffer = (a) => ({ buffer: { bytes: a.buffer } });
  for (let slab = 0; slab < SLABS; slab++) {
    const params = { first: PREFIX, count: jobs.length, scatter, slab };
    // A folded 1-D grid (gpu/kernels.js fold) with a spare workgroup past the count.
    const size = [Math.ceil((jobs.length + 1) / 2), 2, 1];
    assert(size[0] * size[1] > jobs.length);
    const P = new Uint32Array(FieldHistoryParams.pack(params));
    new Exec(program).dispatchWorkgroups('main', size, { 0: { 0: list, 1: viaWGSL.pools[slab], 2: viaWGSL.ema }, 3: { 1: P } });
    fieldHistoryCopy(desc, { bind: [{ entries: [{ binding: 0, resource: buffer(list) }, { binding: 1, resource: buffer(viaFake.pools[slab]) }, { binding: 2, resource: buffer(viaFake.ema) }] }], params });
    executed++;
  }
  assert.deepEqual(viaWGSL.ema, expected.ema, `WGSL ${scatter ? 'scatter' : 'gather'}: scratch words differ from the native copies'`);
  viaWGSL.pools.forEach((p, s) => assert.deepEqual(p, expected.pools[s], `WGSL ${scatter ? 'scatter' : 'gather'}: slab ${s} words differ from the native copies'`));
  assert.deepEqual(viaFake, viaWGSL, 'the fake GPUs\' history copy is not the WGSL\'s');
  assert.notDeepEqual(scatter ? expected.pools : expected.ema, scatter ? pools : ema, 'the fixture moved nothing');
}
console.log(`PASS field-history copy WGSL (CPU-executed, ${executed} dispatches): every bit of ${jobs.length} pages both ways across ${SLABS} slabs equals 3 native 256-byte copies a page; skipped jobs, other slabs and past-the-count workgroups write nothing; the fake GPUs' copy matches; Naga validates the 64^3 kernel`);

// ---- 2./3. WorldFields: no native history copy, O(1) dispatches a batch ----
const bounds = { min: [0, 0, 0], max: [128, 32, 64] };
const cores = [];
for (let z = 0; z < bounds.max[2]; z += 32) for (let x = 0; x < bounds.max[0]; x += 32) cores.push([x, 0, z]);
function fixture(history) {
  const gpu = new FieldTestGPU({ emulateEMA: true }), state = { revision: 0 };
  const source = () => { const revision = state.revision; return { epoch: 0, sourceRevision: revision, jetValidity: 'producer-bounded-v1',
    isCurrent: () => state.revision === revision, assertComplete() {},
    recordGatherRaw(frame, { resources, g, scratchOrigin }) {
      const A = new Float32Array(resources.A.bytes); A.fill(0); new Uint32Array(resources.aeration.bytes).fill(0);
      for (let z = 0; z < 64; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
        const w = [x, y, z].map((v, i) => v + scratchOrigin[i]);
        if (w.some((v, i) => v < bounds.min[i] || v >= bounds.max[i])) continue;
        const id = (w[0] + 3 * w[1] + 5 * w[2] + state.revision) % 3 === 0 ? E.WATER : w[1] < 8 ? E.SAND : E.EMPTY;
        A.set([id, 300 + ((w[0] * 7 + w[2] * 13 + state.revision * 101) % 900), 0.5, 0.31], cellSlot(g, x, y, z) * 4);
      }
    } }; };
  const fields = new WorldFields(gpu, { worldBounds: bounds, tables: {}, history: history(gpu),
    publisher: { recordOwnedFields: (frame, p) => ({ token: p.token }), publish() {} } });
  const nativeHistory = () => gpu.trace.filter((e) => e.name === 'copy' && (e.src === fields.scratch.ema || e.dst === fields.scratch.ema
    || fields.history.slabs.includes(e.src) || fields.history.slabs.includes(e.dst))).length;
  const record = (tick, changedBricks = []) => {
    if (changedBricks.length) state.revision++;
    const plan = fields.plan({ fieldTick: tick, sourceSnapshot: source(), wantedCores: cores, changedBricks });
    const from = gpu.trace.length;
    fields.record(gpu.frame, plan).retire();
    const trace = gpu.trace.slice(from), copies = trace.filter((e) => e.name === FIELD_HISTORY_KERNEL);
    // A dispatch's copies: its range's jobs in the bound slab (the WGSL's rule).
    const moved = copies.reduce((n, e) => { const l = new Uint32Array(e.opts.bind[0].entries[0].resource.buffer.bytes), s = e.opts.params.slab;
      let k = 0; for (let j = e.opts.params.first; j < e.opts.params.first + e.opts.params.count; j++) if (l[j * 3 + 2] === s) k++; return n + k; }, 0);
    return { plan, dispatches: copies.length, moved };
  };
  const wordsOf = () => Object.fromEntries([...fields.history.owners].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, o]) => [key, Array.from(new Uint32Array(o.page.buffer.bytes, o.page.offset, HISTORY_WORDS))]));
  return { gpu, fields, record, wordsOf, nativeHistory };
}
const one = fixture((gpu) => new WorldFieldHistory(gpu, { pagesPerSlab: 16384 })), many = fixture((gpu) => new WorldFieldHistory(gpu, { pagesPerSlab: 64, maxPagesPerSlab: 64 }));
await Promise.all([one.fields.ready, many.fields.ready]);
// Ticks: the load (every owner fresh: scatters only), one brick changed (few
// owners), four cores' ground changed (many), then their settling.
const ticks = [[], [[9, 3, 9]], Array.from({ length: 16 * 4 * 16 }, (_, i) => [i & 15, i >> 8, (i >> 4) & 15]), [], []];
const rows = [];
for (const [tick, changed] of ticks.entries()) {
  const a = one.record(tick, changed), b = many.record(tick, changed);
  const pages = a.plan.batches.reduce((n, x) => n + x.owners.length, 0);
  // Every page copy is a job one dispatch carries out, in either pool.
  assert.equal(b.moved, a.moved, `tick ${tick}: slabs moved other pages than one slab`);
  // One slab: a dispatch a non-empty run, i.e. at most 2 a batch and 1 a job, whatever their owners.
  assert(a.dispatches <= 2 * a.plan.batches.length + a.plan.jobs.length, `tick ${tick}: ${a.dispatches} history dispatches for ${a.plan.batches.length} batches, ${a.plan.jobs.length} jobs`);
  // Many slabs: at most one a slab a run touches.
  assert(b.dispatches <= (2 * b.plan.batches.length + b.plan.jobs.length) * many.fields.history.slabs.length);
  rows.push({ tick, owners: pages, batches: a.plan.batches.length, jobs: a.plan.jobs.length, moved: a.moved, dispatches: a.dispatches, slabDispatches: b.dispatches });
}
assert.equal(one.nativeHistory() + many.nativeHistory(), 0, 'a history page moved by a native copy');
assert.deepEqual(many.wordsOf(), one.wordsOf(), 'many small slabs end with other history words than one slab');
assert(many.fields.history.slabs.length > 8, 'the small-slab pool spans many slabs');
// O(1) in owners: a tick advancing 16x the owners takes no more dispatches a
// batch (two: its gathers, its scatters) and a job (one) than the small one.
const few = rows[1], lots = rows[2];
assert(lots.owners >= 16 * few.owners, `fixture: the big change advances ${lots.owners} owners, the small one ${few.owners}`);
for (const r of rows) assert(r.moved >= r.owners, `tick ${r.tick}: ${r.moved} page copies for ${r.owners} advancing owners`);
console.log(`PASS field-history copies are O(1) GPU commands a batch: no native history copies; ${rows.map((r) => `tick ${r.tick} ${r.owners} owners/${r.batches} batches/${r.jobs} jobs: ${r.moved} pages in ${r.dispatches} dispatches (${r.slabDispatches} over ${many.fields.history.slabs.length} slabs)`).join('; ')}; slab layout changes no history word`);
one.fields.dispose(); many.fields.dispose();
