// The World view's feedback comes back compacted, decoded in proportion to its requests, and
// exactly as the whole-buffer decode had it. CPU only: no browser, no GPU.
//
// Each read used to copy back the whole feedback (24 MiB on Descent) and scan its six planes:
// 5.3 s of requestedBricks, 1.7 s copying, 2.5 s GC in 40 s of Descent (real Chrome, 2026-10-22).
// Now a compute pass lists its non-zero words and only the list comes back
// (gfx/worldFeedbackCompact.js). Here:
//   1. Naga validates the pass, and its actual WGSL (CPU-executed) writes the list its JS twin
//      writes, count and overflow included, on small worlds whose brick counts are not /32;
//   2. on random bitsets (empty, sparse, clustered, full planes, last-word edges, overflow) at
//      small, Island and Descent sizes, the decoded list in any GPU order equals the old decode
//      (decodeWorldFeedback: requestedChannels/requestedBricks) field for field, and its work is
//      bounded by the list's entries and their set bits, never the world's size;
//   3. WorldVolume's candidates read it so: recordFeedback dispatches the pass and copies the list,
//      readFeedback decodes it, an overflow decodes the full copy, the capacity follows the counts,
//      and a candidate never uploads its zeros.
//
//   node tools/world-feedback-compact-cpu-check.mjs
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { nagaExec } from './naga.mjs';
import { worldBookLayout, requestChannels, requestedChannels, requestedBricks, READY, WorldRenderAtlas } from '../src/world/renderAtlas.js';
import { decodeWorldFeedback, createWorldVolume } from '../src/gfx/worldVolume.js';
import { worldFeedbackCompactWGSL, compactWorldFeedbackCPU, decodeCompactWorldFeedback, createWorldFeedbackScratch, worldFeedbackReadWords,
  worldFeedbackCompactBytes, worldFeedbackCompactGroups, worldFeedbackMaxEntries, nextWorldFeedbackCapacity, WORLD_FEEDBACK_MIN_ENTRIES,
  WORLD_FEEDBACK_COMPACT_HEADER_WORDS } from '../src/gfx/worldFeedbackCompact.js';
import { worldFeedbackExtraWords } from '../src/wire/worldRender.js';
import { worldSunProjection, worldSunFeedbackWords } from '../src/world/worldSun.js';
import { tableLayout } from '../src/shaders/common.js';
import { fold } from '../src/gpu/kernels.js';

let seed = 0x2545f491;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const shuffle = (l) => { for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; };
const popcount = (v) => { let n = 0; for (; v; v &= v - 1) n++; return n; };

// A feedback the size the atlas gives it, with the misses `fill` sets.
function feedbackOf(size, sunTileCount, fill) {
  const book = worldBookLayout(size), words = new Uint32Array(book.statusWord + 1 + Math.max(worldFeedbackExtraWords(size), Math.ceil(sunTileCount / 32)));
  fill(words, book);
  return { book, words, readWords: worldFeedbackReadWords(book, sunTileCount), sunTileCount };
}
const KINDS = {
  empty: () => {},
  // Dozens to thousands of misses: a frustum's clustered slab and scattered budget-dropped bricks.
  sparse: (w, book) => { const n = Math.min(book.count, 1 + Math.floor(random() * 3000)); for (let k = 0; k < n; k++) requestChannels(w, book, Math.floor(random() * book.count), 1 + Math.floor(random() * READY.ALL)); },
  clustered: (w, book) => { for (let r = 0; r < 20; r++) { const base = Math.floor(random() * book.count), n = Math.floor(random() * 400);
    for (let k = 0; k < n && base + k < book.count; k++) requestChannels(w, book, base + k, k % 3 ? READY.CELL : READY.GI | READY.GLOW); } },
  // Every bit of some planes, those past the world's last brick included (the decode drops them).
  fullPlanes: (w, book) => { for (const p of [0, 2, 5]) w.fill(0xffffffff, p * book.planeWords, (p + 1) * book.planeWords); },
  // The last word of each plane: a world whose brick count is not /32 ends mid-word.
  lastWords: (w, book) => { for (let p = 0; p < 6; p++) w[p * book.planeWords + book.planeWords - 1] = (random() * 2 ** 32) >>> 0 | 1 << 31; w[0] = 1; },
};
const withSun = (fill) => (w, book) => { fill(w, book); w[book.statusWord] = random() < .5 ? 1 : 0; for (let k = 0; k < 6; k++) w[book.sunWord + Math.floor(random() * 3)] |= 1 << Math.floor(random() * 32); };
const setBits = (f) => { let n = 0; for (let i = 0; i < f.readWords; i++) n += popcount(f.words[i]); return n; };
const nonZero = (f) => { let n = 0; for (let i = 0; i < f.readWords; i++) n += f.words[i] !== 0; return n; };
// The decode the old path made of the whole feedback, plus the old functions' own pieces.
function oldDecode(f) {
  const d = decodeWorldFeedback(f.words, f.book, f.sunTileCount);
  assert.deepEqual(d.requirements, requestedChannels(f.words, f.book));
  assert.deepEqual(d.sun, requestedBricks(f.words.subarray(f.book.statusWord + 1), f.sunTileCount));
  return d;
}
const same = (a, b, what) => {
  assert.deepEqual(b.requirements, a.requirements, `${what}: requirements`);
  assert.deepEqual({ ...b, requirements: null }, { ...a, requirements: null }, `${what}: status, geometry, Sun or completeness`);
};

// ---- 1. the WGSL: Naga, and CPU-executed against its twin ----
class Exec extends WgslExec {
  _dispatchWorkgroup(fn, id, context) {
    // wgsl_reflect parses a single workgroup size as a string (world-cell-adapter-cpu-check.mjs).
    for (const a of fn.node.attributes ?? []) if (a.name === 'workgroup_size' && typeof a.value === 'string') a.value = [a.value];
    return super._dispatchWorkgroup(fn, id, context);
  }
}
const code = worldFeedbackCompactWGSL();
nagaExec(code, 'world-feedback-compact.wgsl', { timeout: 10000 });
const program = new WgslParser().parse(code);
const byIndex = (list) => [...list].sort((a, b) => a[0] - b[0]);
const entries = (out, n) => Array.from({ length: n }, (_, s) => [out[2 + 2 * s], out[3 + 2 * s]]);
let executed = 0;
// Brick counts 126 (9x2x7), 3200 and 8190 (none /32), and a two-row folded grid.
for (const size of [[36, 8, 28], [128, 16, 100], [180, 4, 728]]) for (const kind of ['empty', 'sparse', 'clustered', 'fullPlanes', 'lastWords']) {
  const f = feedbackOf(size, 70, withSun(KINDS[kind])), nz = nonZero(f);
  for (const capacity of [Math.max(1, nz), Math.max(1, nz >> 1), nz + 7]) {
    const out = new Uint32Array(worldFeedbackCompactBytes(capacity) / 4);
    const groups = worldFeedbackCompactGroups(f.readWords), grid = kind === 'lastWords' ? [Math.ceil(groups / 2), 2, 1] : fold(groups);
    new Exec(program).dispatchWorkgroups('main', grid, { 0: { 0: new Uint32Array([f.readWords, capacity, 0, 0]), 1: f.words, 2: out } });
    const twin = compactWorldFeedbackCPU(f.words, f.readWords, capacity);
    assert.equal(out[0], nz, `${kind} ${size}: the pass counts every non-zero word`);
    assert.equal(twin[0], nz);
    const n = Math.min(nz, capacity);
    if (capacity >= nz) assert.deepEqual(byIndex(entries(out, n)), byIndex(entries(twin, n)), `${kind} ${size}: the WGSL's list is not its twin's`);
    else for (const [i, w] of entries(out, n)) assert.equal(f.words[i], w, `${kind} ${size}: an overflowed list's entry is not its word`);
    assert(out.subarray(2 + 2 * n).every((w) => w === 0), `${kind} ${size}: the pass wrote past its capacity`);
    const decoded = decodeCompactWorldFeedback(out, f.book, f.sunTileCount);
    if (capacity >= nz) same(oldDecode(f), decoded, `WGSL ${kind} ${size}`); else assert.equal(decoded, null, 'an overflowed list decodes as an overflow');
    executed++;
  }
}
console.log(`PASS feedback compaction WGSL (Naga + CPU-executed, ${executed} dispatches): its list is its twin's, count past capacity flags an overflow, nothing written past it`);

// ---- 2. the decode equals the old one, in any order, in bounded work ----
const WORLDS = { small: [36, 8, 28], medium: [128, 16, 100], island: [1024, 128, 1024], descent: [2560, 320, 2560] };
const BIG = new Set(['island', 'descent']);
const rows = [];
for (const [name, size] of Object.entries(WORLDS)) {
  const sunTileCount = !BIG.has(name) ? 70 : (() => { const t = worldSunProjection(size, [1, .01, 0]).tiles; return t[2] * t[3]; })();
  const scratch = createWorldFeedbackScratch();
  for (const kind of Object.keys(KINDS)) for (const sun of [false, true]) {
    if (BIG.has(name) && kind === 'fullPlanes') continue;   // (every brick a requirement: millions of the old decode's objects)
    const f = feedbackOf(size, sunTileCount, sun ? withSun(KINDS[kind]) : KINDS[kind]), nz = nonZero(f), bits = setBits(f);
    const capacity = nextWorldFeedbackCapacity(f.readWords, WORLD_FEEDBACK_MIN_ENTRIES, nz);
    const old = oldDecode(f);
    if (nz > capacity) {
      // Past the largest list the read takes the full copy: the list says so.
      assert(nz > worldFeedbackMaxEntries(f.readWords), `${name} ${kind}: overflowed below the largest list`);
      assert.equal(decodeCompactWorldFeedback(compactWorldFeedbackCPU(f.words, f.readWords, capacity), f.book, sunTileCount, scratch), null);
      rows.push({ world: name, kind, sun, nonZero: nz, requirements: old.requirements.length, read: 'full copy' });
      continue;
    }
    for (const order of [null, shuffle]) {
      const decoded = decodeCompactWorldFeedback(compactWorldFeedbackCPU(f.words, f.readWords, capacity, order), f.book, sunTileCount, scratch);
      same(old, decoded, `${name} ${kind}${sun ? ' + Sun' : ''}${order ? ' shuffled' : ''}`);
      // Work: one step an entry and one a set bit of its words; the world's size is not in it.
      assert(scratch.ops <= nz + bits, `${name} ${kind}: ${scratch.ops} steps for ${nz} words, ${bits} bits`);
      // (slack: the status word, Sun bits past the tile count, a last word's bits past the brick count)
      assert(scratch.ops <= 7 * (old.requirements.length + old.sun.length) + 1 + 6 + (kind === 'fullPlanes' || kind === 'lastWords' ? 6 * 32 : 0),
        `${name} ${kind}: ${scratch.ops} steps for ${old.requirements.length} requirements`);
    }
    if (kind === 'empty' && !sun) assert.equal(scratch.ops, 0, `${name}: an empty feedback took decode steps`);
    rows.push({ world: name, kind, sun, nonZero: nz, requirements: old.requirements.length, steps: scratch.ops, readKiB: +(worldFeedbackCompactBytes(capacity) / 1024).toFixed(1), wholeKiB: +(f.readWords / 256).toFixed(1) });
  }
}
console.table(rows);
// The capacity policy: a list fits the last count, shrinks back, and past its largest gives way to the full copy.
{
  const W = 6_150_001, max = worldFeedbackMaxEntries(W);
  assert.equal(nextWorldFeedbackCapacity(W, WORLD_FEEDBACK_MIN_ENTRIES, 100), WORLD_FEEDBACK_MIN_ENTRIES);
  assert.equal(nextWorldFeedbackCapacity(W, WORLD_FEEDBACK_MIN_ENTRIES, 5000), 16384);
  assert.equal(nextWorldFeedbackCapacity(W, 16384, 1000), 8192);
  assert.equal(nextWorldFeedbackCapacity(W, 16384, max + 1), WORLD_FEEDBACK_MIN_ENTRIES);
  assert(max * 8 <= W * 4 / 2 && max >= W / 8, 'the largest list is half the full copy\'s bytes at most');
  for (let c = 0; c < 2 * max; c += 977) { const next = nextWorldFeedbackCapacity(W, WORLD_FEEDBACK_MIN_ENTRIES, c); assert(c > max || next >= c); }
}
console.log('PASS compacted feedback decode: equal to the whole-buffer decode on empty, sparse, clustered, full and edge planes at four sizes, in any order; steps bounded by entries and set bits');

// ---- 3. WorldVolume candidates read it compacted ----
function fakeGPU() {
  const buffers = [], uploads = [];
  const device = { limits: {},
    queue: { writeBuffer(b, off, raw) { uploads.push({ label: b.label, bytes: raw.byteLength }); const a = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength); b.data.set(a, off); },
      writeTexture() {}, submit() {}, onSubmittedWorkDone: () => Promise.resolve() },
    createBuffer(d) { const b = { ...d, data: new Uint8Array(d.size), mapped: false, destroy() { this.dead = true; },
      mapAsync: async () => { assert(d.usage & 1, 'mapped a buffer without MAP_READ'); b.mapped = true; }, getMappedRange: () => b.data.buffer, unmap() { b.mapped = false; } }; buffers.push(b); return b; },
    createTexture(d) { return { ...d, createView: () => ({}), destroy() {} }; },
    createBindGroupLayout: (d) => d, createPipelineLayout: (d) => d, createSampler: (d) => d, createShaderModule: (d) => d,
    createRenderPipelineAsync: async (d) => d, createComputePipelineAsync: async (d) => d, createBindGroup: (d) => d };
  const u32 = (b) => new Uint32Array(b.data.buffer);
  // A command encoder that runs: the compaction pass is its twin (the WGSL's, part 1).
  const encoder = { passes: 0, beginComputePass(desc) { let group; return { setPipeline() {}, setBindGroup(_, g) { group = g; },
    dispatchWorkgroups: () => { assert.equal(desc.label, 'world feedback compact'); encoder.passes++;
      const at = (n) => group.entries.find((e) => e.binding === n).resource, P = new Uint32Array(at(0).buffer.data.buffer);
      u32(at(2).buffer).set(compactWorldFeedbackCPU(u32(at(1).buffer), P[0], P[1], shuffle)); }, end() {} }; },
    copyBufferToBuffer(s, so, d, o, n) { d.data.set(s.data.subarray(so, so + n), o); } };
  return { device, buffers, uploads, encoder, u32 };
}
async function volumeAt(size) {
  const gpu = fakeGPU(), sun = worldSunProjection(size, [1, .01, 0]);
  const atlas = new WorldRenderAtlas(gpu, { worldSize: size, initialCapacity: 1, feedbackExtraWords: Math.max(worldSunFeedbackWords(sun.tiles), worldFeedbackExtraWords(size)), retire: (fn) => fn() });
  const lighting = { params: { ...sun, physical: [256, 8, 64, 1], version: [1, 1, 1, atlas.bookLayout.requestBytes / 4 + 1] }, book: gpu.device.createBuffer({ size: sun.tiles[2] * sun.tiles[3] * 32 }), sun0: {}, sun1: {} };
  atlas.publish({ sunManifest: { epoch: 1, basisRevision: 1, publishRevision: 1, dependencySetID: 0, dependencyVersion: 0, book: lighting.book, sun0: lighting.sun0, sun1: lighting.sun1, params: lighting.params } });
  const volume = createWorldVolume(gpu, { g: { nx: size[0], ny: size[1], nz: size[2] }, atlas, tables: gpu.device.createBuffer({ size: tableLayout().Tables.size }), lighting });
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const prepare = (feedbackKind) => volume.prepare({ frameUniforms: { cam: [9, 9, 9], model: I, viewProj: I }, physicsOrigin: [0, 0, 0], params: { meshInv: I, meshRes: [1, 1] }, external: { mediaNoise: {}, sourceAppearance: {}, packedMesh: {} }, feedbackKind });
  return { gpu, atlas, volume, prepare, tileCount: sun.tiles[2] * sun.tiles[3] };
}
// One frame's read: misses written into the candidate's feedback, then its readback recorded and read.
async function frame(v, kind, fill) {
  const c = v.prepare(kind), words = v.gpu.u32(c.feedback);
  fill(words, v.atlas.bookLayout);
  const full = c.decodeFeedback(words.slice());
  const dst = v.gpu.device.createBuffer({ size: c.feedbackWords * 4 + 80 });
  c.recordFeedback(v.gpu.encoder, dst, 0);
  const read = await c.readFeedback(v.gpu.u32(dst).subarray(0, c.feedbackWords));
  c.release();
  return { c, full, read, mapped: c.feedbackWords * 4 };
}
for (const [name, size] of [['island', WORLDS.island], ['descent', WORLDS.descent]]) {
  const v = await volumeAt(size), feedbackBytes = v.atlas.feedbackBytes;
  const first = v.prepare('scene');
  assert.equal(first.feedbackWords, feedbackBytes / 4, 'before the pass is built a candidate reads its whole feedback');
  first.release();
  await v.volume.compilationSettled;
  assert(!v.gpu.uploads.some((u) => u.bytes >= feedbackBytes), `${name}: a candidate uploaded its feedback's zeros`);
  const log = [];
  for (const [kind, fill] of [['empty', KINDS.empty], ['sparse', withSun(KINDS.sparse)], ['clustered', KINDS.clustered], ['sparse', KINDS.sparse], ['empty', KINDS.empty]]) {
    const r = await frame(v, 'scene', fill);
    same(r.full, r.read, `${name} volume ${kind}`);
    log.push({ kind, mapped: r.mapped });
  }
  // A burst past the list (the full planes of a world's first frame): the full copy, exactly, and the next list fits the burst.
  const burst = await frame(v, 'scene', (w, book) => { for (let k = 0; k < 3 * WORLD_FEEDBACK_MIN_ENTRIES; k++) requestChannels(w, book, (k * 7919) % book.count, READY.CELL); });
  same(burst.full, burst.read, `${name} volume overflow`);
  const after = v.prepare('scene');
  assert(after.feedbackWords > burst.c.feedbackWords, `${name}: the list did not grow after an overflow`);
  assert(v.gpu.buffers.some((b) => b.label === 'world feedback full copy' && b.mapped === false && b.dead), 'the overflowed read mapped and released the full copy');
  after.release();
  // The eye's point query keeps its own small list beside the scene's.
  const eye = await frame(v, 'eye', KINDS.empty);
  assert.equal(eye.mapped, worldFeedbackCompactBytes(WORLD_FEEDBACK_MIN_ENTRIES));
  assert(eye.mapped * 32 < feedbackBytes, `${name}: an empty read maps ${eye.mapped} B of a ${feedbackBytes} B feedback`);
  console.log(`PASS ${name} WorldVolume: compacted reads equal the whole decode; ${log.map((l) => `${l.kind} ${(l.mapped / 1024).toFixed(0)} KiB`).join(', ')}; burst via the full copy; whole feedback ${(feedbackBytes / 1048576).toFixed(1)} MiB; ${v.gpu.encoder.passes} passes`);
  v.volume.dispose(); v.atlas.dispose();
}
assert.equal(WORLD_FEEDBACK_COMPACT_HEADER_WORDS, 2);
