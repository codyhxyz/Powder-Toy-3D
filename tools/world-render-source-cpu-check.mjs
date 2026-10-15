// CPU command/authority tests. No browser, GPU, shader interpreter or speed claim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorldRenderSource, SOURCE_GRID, SOURCE_RANK, snapshotSource, sourceBounds, planSourceCopies, recordSourceCopies, decodeSourceBrick } from '../src/world/renderSource.js';
import { rawSourceGrid, treeColumnMask, sourceTrees, RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { gridDims, cellSlot, slotCell } from '../src/shaders/common.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { WorldWindow } from '../src/world/window.js';
import { Simulation } from '../src/sim.js';
import { setAeration, dropAeration, aerationForSource } from '../src/gfx/foam.js';
import { cellWordsDiffer, cellDiffersWGSL } from '../src/shaders/generate.js';
import { STAMP_LIB, stampLib } from '../src/shaders/stamp.js';
import { rawStampWGSL, rawApplyWGSL, RAW_LAYOUT, RAW_READ_LAYOUT, APPLY_STATE } from '../src/shaders/renderSource.js';
import { stateLayout } from '../src/shaders/common.js';

let assertions = 0;
function check(name, fn) { fn(); assertions++; console.log(`PASS ${name}`); }
function fixture() {
  const commands = [], retired = [], owned = [];
  const flush = () => { while (commands.length) commands.shift()(); };
  const frame = { copy(a, ao, b, bo, n) { assert(ao + n <= a.size && bo + n <= b.size); commands.push(() => b.bytes.set(a.bytes.subarray(ao, ao + n), bo)); },
    clear(b, at = 0, n = b.size) { commands.push(() => b.bytes.fill(0, at, at + n)); } };
  const gpu = { frame, stats: { flushes: 0 },
    createBuffer({ size, label }) { const b = { size, label, bytes: new Uint8Array(size) }; owned.push(b); return b; },
    write(b, at, data, { ordered = true } = {}) { if (ordered) flush(); b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); },
    layout(_name, e) { return e; }, bindGroup(layout, entries) { return { layout, entries }; },
    kernel(desc) { return { ...desc, ready: Promise.resolve(), dispatch(_frame, size, opts) { this.calls ??= []; this.calls.push({ size, opts }); } }; } };
  const g = gridDims({ nx: 32, ny: 32, nz: 32 });
  const buf = (size) => gpu.createBuffer({ size });
  const sim = { g, gpu, cur: 1, version: 1, origin: { x: 32, y: 0, z: 32 }, L: { TABLES: [] }, tables: {},
    state: { A: buf(g.slots * 32), B: buf(g.slots * 32), F: buf(g.slots * 8) }, marks: buf(16),
    flow: buf(g.slots * 8), aeration: { buffer: buf(g.slots * 16), cur: 1 },
    decoPlane: { buffer: buf(g.slots * 4), offset: 0 },
    _retire(b) { retired.push(b); }, noteWrite() { this.version++; }, freshFlags() { this.refreshedFlags = true; this.noteWrite(); },
    header() { return { origin: [this.origin.x, 0, this.origin.z], src: this.cur, dst: this.cur }; } };
  const win = { sim, gpu, size: [128, 32, 128], epoch: 1, wb: [32, 8, 32], scene: { importManifest: { sourceStyle: true }, appearanceWords: new Uint32Array([0x12345678]) }, planted: new Uint8Array(32 * 32), candidates: new Map() };
  win.store = new BrickStore(win.wb);
  const source = new WorldRenderSource(win); win.renderSource = source;
  return { sim, win, source, gpu, frame, flush, retired, owned };
}
function wordView(buffer) { return new Uint32Array(buffer.bytes.buffer); }
function fillState(f, salt = 0) {
  for (const name of ['A', 'B']) {
    const u = wordView(f.sim.state[name]);
    for (let s = 0; s < f.sim.g.slots; s++) for (let c = 0; c < 4; c++) u[(f.sim.cur * f.sim.g.slots + s) * 4 + c] = (0x3f000001 + s * 16381 + c * 7919 + salt + (name === 'B' ? 713 : 0)) >>> 0;
  }
  for (const b of [f.sim.flow, f.sim.aeration.buffer, f.sim.decoPlane.buffer]) wordView(b).forEach((_v, i, a) => { a[i] = (0xa1010ab + i * 971 + salt) >>> 0; });
}
function stateWords(src, name, p) {
  const slot = cellSlot(src.g, ...p.map((v, i) => v - src.origin[i]));
  return [...wordView(src[name]).subarray(((src.copy ?? 0) * src.g.slots + slot) * 4, ((src.copy ?? 0) * src.g.slots + slot + 1) * 4)];
}
check('complete A/B capture preserves all original words and auxiliary planes', () => {
  const f = fixture(); fillState(f);
  const live = snapshotSource(f.sim), revision = f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  assert(revision > 0);
  for (let s = 0; s < live.g.slots; s++) {
    const p = slotCell(live.g, s).map((v, i) => v + live.origin[i]);
    const out = f.source.getSource(p); assert.equal(out.kind, 'live'); assert.equal(out.aux, 7);
    for (const name of ['A', 'B']) assert.deepEqual(stateWords(out.chunk, name, p), stateWords(live, name, p));
    assert.equal(wordView(out.chunk.flow)[out.slot * 2], wordView(live.flow)[s * 2]);
    assert.equal(wordView(out.chunk.aeration)[out.slot * 2], wordView(live.aeration)[(live.aerCopy * live.g.slots + s) * 2]);
    assert.equal(wordView(out.chunk.deco.buffer)[out.slot], wordView(live.deco.buffer)[s]);
  }
});
check('disabled-but-allocated aeration remains discoverable, while dropped aux cannot resurrect stale buffers', () => {
  const f = fixture(), previousUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 0x04, COPY_DST: 0x08, INDIRECT: 0x100 };
  f.sim.attachAeration = (aer) => { f.sim.aeration = aer; }; f.sim.onShift = () => () => {};
  try {
    const aer = setAeration(f.sim, true), buffer = aer.buffer;
    wordView(buffer)[0] = 0x12345678;
    setAeration(f.sim, false); assert.equal(f.sim.aeration, null);
    assert.equal(aerationForSource(f.sim), aer); assert.equal(snapshotSource(f.sim).aeration, buffer);
    f.source.recordLiveCopy(f.frame, f.sim); f.flush(); assert(!f.source.needsLiveCopy());
    aer.reset(); assert(f.source.needsLiveCopy(), 'aux reset invalidates even an unchanged source version');
    f.source.recordLiveCopy(f.frame, f.sim); f.flush();
    dropAeration(f.sim); f.sim.decoPlane = null;
    assert(f.source.needsLiveCopy()); f.source.recordLiveCopy(f.frame, f.sim); f.flush();
    const out = f.source.getSource([32, 0, 32]); assert.equal(out.aux, 1);
    assert.equal(wordView(out.chunk.aeration)[out.slot * 2], 0); assert.equal(wordView(out.chunk.deco.buffer)[out.slot], 0);
  } finally { dropAeration(f.sim); if (previousUsage === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = previousUsage; }
});
check('actual idle step captures aeration copy changes even without a physics/source version change', () => {
  const f = fixture(); fillState(f);
  Object.assign(f.sim, { worldRenderSource: f.source, frame: 0, idleCertified: true, actDirty: false, actFresh: false, actSteps: 1e6, quietOk: true, skipSleeping: true, rays: { active: false } });
  f.sim.aeration.generation = 7;
  f.sim.aeration.idle = () => { f.sim.aeration.cur = 0; };
  Simulation.prototype.step.call(f.sim); f.flush();
  const out = f.source.getSource([33, 1, 33]); assert.equal(out.kind, 'live');
  const slot = cellSlot(f.sim.g, 1, 1, 1);
  assert.equal(wordView(out.chunk.aeration)[out.slot * 2], wordView(f.sim.aeration.buffer)[slot * 2]);
});
check('real copy plans are bricked, exact at partial/corner overlaps, immutable across shifts', () => {
  const f = fixture(); fillState(f); const src = snapshotSource(f.sim), dst = f.source._chunk([32, 0, 32]);
  assert(Object.isFrozen(src.origin)); assert(Object.isFrozen(src.g));
  const box = { lo: [35, 1, 34], hi: [49, 7, 44] }, runs = planSourceCopies(src, dst, box);
  assert.equal(runs.reduce((n, r) => n + r.cells, 0), 14 * 6 * 10);
  const full = planSourceCopies(src, dst, sourceBounds(f.sim)); assert.equal(full.length, 1); assert.equal(full[0].cells, 32 ** 3);
  recordSourceCopies(f.frame, src, dst, runs);
  f.sim.origin.x += 16; f.sim.cur = 0; f.flush();
  for (let z = 34; z < 44; z++) for (let y = 1; y < 7; y++) for (let x = 35; x < 49; x++) assert.deepEqual(stateWords(dst, 'B', [x, y, z]), stateWords(src, 'B', [x, y, z]));
});
check('no-step departure, delayed save and return restore exact captured GPU words', () => {
  const f = fixture(); fillState(f); f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  const before = snapshotSource(f.sim), p = [33, 8, 35], expected = stateWords(before, 'A', p);
  const bounds = { lo: [32, 0, 32], hi: [48, 32, 64] };
  const capture = f.source.recordLeavingCopy(f.frame, f.sim, bounds, [32, 0, 32]);
  // Mutation occurs AFTER recording, before GPU command execution.
  f.sim.origin.x = 48; f.sim.cur = 0; f.flush();
  assert.equal(f.source.getSource(p).kind, 'captured'); assert(f.source.getSource(p).pending);
  f.sim.origin.x = 32; wordView(f.sim.state.A).fill(0, 0, f.sim.g.slots * 4);
  f.source.restoreCaptured(f.frame, f.sim, bounds); f.flush();
  assert.deepEqual(stateWords(snapshotSource(f.sim), 'A', p), expected);
  assert(f.sim.refreshedFlags, 'native state restore must refresh physical activity flags');
  const keys = []; for (let z = 8; z < 16; z++) for (let y = 0; y < 8; y++) for (let x = 8; x < 12; x++) keys.push(f.win.store.key(x, y, z));
  f.source.commitStoreRevision(keys, capture);
  assert.equal(f.source.getSource(p).kind, 'saved'); assert(!f.source.getSource(p).pending); assert.equal(f.source.getSource(p).aux, 7);
  f.source.recordLiveCopy(f.frame, f.sim); f.source.commitStoreRevision(keys, capture); assert.equal(f.source.getSource(p).kind, 'live');
});
check('generated < saved < outgoing < live, stale revisions/epochs and partial edges', () => {
  const f = fixture(); fillState(f); const raw = { ...snapshotSource(f.sim), kind: 'generated' }, old = f.source.token();
  f.source.recordPopulate(f.frame, raw, old); assert.equal(f.source.getSource([32, 0, 32]).kind, 'generated');
  f.source.recordPopulate(f.frame, { ...raw, kind: 'saved', bounds: { lo: [33, 0, 33], hi: [35, 2, 35] } }, old);
  assert.equal(f.source.getSource([33, 1, 33]).kind, 'saved'); assert.equal(f.source.getSource([32, 1, 33]).kind, 'generated');
  f.source.recordLiveCopy(f.frame, f.sim, { lo: [34, 0, 34], hi: [36, 2, 36] });
  f.source.recordPopulate(f.frame, raw, old); assert.equal(f.source.getSource([34, 1, 34]).kind, 'live');
  f.source.invalidateGenerated(); assert.equal(f.source.getSource([32, 0, 32]).kind, 'unknown');
  assert.equal(f.source.recordPopulate(f.frame, raw, old), 0);
  const current = f.source.token(); f.source.reset(2); assert.equal(f.source.recordPopulate(f.frame, raw, current), 0);
  assert.equal(f.source.getSource([127, 31, 127]).kind, 'unknown');
});
check('world corners and partial construction cores never widen unknown cells or invalid layouts', () => {
  const f = fixture(); f.win.size[0] = 112;
  const raw = { ...snapshotSource(f.sim), origin: [96, 0, 32] };
  assert.equal(f.source.recordPopulate(f.frame, raw), 16 * 32 * 32);
  assert.equal(f.source.getSource([111, 31, 63]).kind, 'generated');
  assert.equal(f.source.getSource([112, 31, 63]).kind, 'unknown');
  assert.throws(() => planSourceCopies({ ...raw, origin: [97, 0, 32] }, raw, { lo: [96, 0, 32], hi: [112, 32, 64] }), /brick-aligned/);
});
check('lossless store decode uses actual cell layout and complete pressure/seed/life bits', () => {
  const f = fixture(), A = new Float32Array(256), B = new Float32Array(256), au = new Uint32Array(A.buffer), bu = new Uint32Array(B.buffer);
  for (let i = 0; i < 256; i++) { au[i] = (0x3f0a0101 + i * 743) >>> 0; bu[i] = (0x4a100001 + i * 577) >>> 0; }
  // Signed zero and nontrivial NaN payloads are transport words, not JS floats.
  au[7] = 0x7fc12345; bu[11] = 0x80000000;
  const bytes = encodeBrick(A, 0, B, 0), decoded = decodeSourceBrick(bytes);
  for (let l = 0; l < 64; l++) {
    const d = cellSlot(SOURCE_GRID, l & 3, l >> 2 & 3, l >> 4) * 4;
    assert.deepEqual([...decoded.A.subarray(d, d + 4)], [...au.subarray(l * 4, l * 4 + 4)]);
    assert.deepEqual([...decoded.B.subarray(d, d + 4)], [...bu.subarray(l * 4, l * 4 + 4)]);
  }
  f.win.store.put(f.win.store.key(9, 1, 9), bytes); f.source.recordStore({ lo: [36, 4, 36], hi: [40, 8, 40] });
  assert.equal(f.source.getSource([36, 4, 36]).kind, 'saved');
  assert.deepEqual(stateWords(f.source.getSource([36, 4, 36]).chunk, 'A', [36, 4, 36]), [...au.subarray(0, 4)]);
});
check('exact persistence catches pressure-only, air seed-only, tiny heat/life, signed zero and NaN payload changes', () => {
  const a = [0, 0x41a00000, 0x3f800000, 0x3f012345], b = [0, 0, 0, 0];
  assert(!cellWordsDiffer(a, b, a, b));
  for (const [which, c, v] of [['A', 3, a[3] + 1], ['A', 1, a[1] + 1], ['A', 2, a[2] + 1], ['B', 3, 1], ['B', 0, 0x80000000], ['B', 3, 0x7fc12345]]) {
    const aa = [...a], bb = [...b]; (which === 'A' ? aa : bb)[c] = v; assert(cellWordsDiffer(aa, bb, a, b));
  }
  assert(cellDiffersWGSL.includes('bitcast<vec4u>(b)')); assert(!cellDiffersWGSL.includes('abs('));
});
check('world tree ordering, roots/crowns outside core, footing support domain and planted masks', () => {
  const f = fixture(), g = rawSourceGrid(384), origin = [16, 0, 16];
  assert.equal(g.ny, 384); assert.equal(g.nx, 64); assert.equal(g.slots * 32 <= 128 * 1024 * 1024, true);
  f.win.scene.trees = { treesIn: () => [{ x: 60, y: 20, z: 60, seed: 7 }, { x: 12, y: 20, z: 12, seed: 9 }] };
  f.win.bakeTree = () => ({ w: 40, h: 40, d: 40, base: { x: 20, y: 0, z: 20 }, foot: 32 });
  const trees = sourceTrees(f.win, origin, g); assert.equal(trees.length, 2); assert.deepEqual(trees.map(t => t.seed), [9, 7]);
  const index = 8 * f.win.wb[0] + 8; f.win.planted[index] = 1;
  const mask = treeColumnMask(f.win, [16, 0, 16], g); assert.equal(mask[4 + g.bx * 4], 0); assert.equal(mask[5 + g.bx * 4], 1);
  const raw = rawStampWGSL(rawSourceGrid(32)); assert(raw.includes(stampLib({ support: 'inGrid(c) && !isFluid(eid(fetchA(c)))', floor: 'y + H.origin.y < 0' })));
  assert(raw.includes('SPAWNLIFE(id)')); assert(raw.includes('s.z + rnd(&rs) * SEED_MAX')); assert(raw.includes('b.w'));
  assert(raw.includes('0x80000000u')); assert(raw.includes('columns[')); assert(STAMP_LIB.includes('fn footing('));
  // Actual shared footing is strictly vertical: a full world-height column,
  // floor test and immutable original state for each stamp, not box residency.
  assert.equal((STAMP_LIB.match(/vec3i\(p.x, y, p.z\)/g) ?? []).length, 2);
});
check('cold full-state crown survives a visited root and no-step physics/chunk boundary crossing', () => {
  const f = fixture(); fillState(f, 971);
  // A cold raw 32-cubed core at x=64, complete A/B, not IDs or half heat.
  const cold = { ...snapshotSource(f.sim), origin: [64, 0, 32], kind: 'generated' };
  const crown = [68, 12, 36], expectedA = stateWords(cold, 'A', crown), expectedB = stateWords(cold, 'B', crown);
  f.source.recordPopulate(f.frame, cold); f.flush();
  f.win.scene.trees = { treesIn: () => [{ x: 60, y: 4, z: 36, seed: 123 }] };
  f.win.bakeTree = () => ({ w: 24, h: 20, d: 8, base: { x: 8, y: 0, z: 4 }, foot: 32 });
  const g = rawSourceGrid(32), rawOrigin = [48, 0, 16], rootKey = 15 + 9 * f.win.wb[0];
  assert.equal(treeColumnMask(f.win, rawOrigin, g)[5 + g.bx * 5], 1);
  f.win.planted[rootKey] = 1;
  const mask = treeColumnMask(f.win, rawOrigin, g);
  assert.equal(mask[3 + g.bx * 5], 0); // root already visited
  assert.equal(mask[5 + g.bx * 5], 1); // actual crown target still unvisited
  assert.equal(sourceTrees(f.win, rawOrigin, g).length, 1, 'visited root must not discard the entire tree');
  const leaving = { lo: [32, 0, 32], hi: [48, 32, 64] };
  f.source.recordLiveCopy(f.frame, f.sim);
  f.source.recordLeavingCopy(f.frame, f.sim, leaving, [32, 0, 32]); f.flush();
  f.sim.origin.x = 48; f.sim.cur = 0; // no step
  const cached = f.source.getSource(crown).chunk;
  // The incoming shared producer must finish before the live publication;
  // exercise the exact transfer helper used by that producer, without GPU execution.
  const dst = snapshotSource(f.sim), box = { lo: [64, 0, 32], hi: [80, 32, 64] };
  recordSourceCopies(f.frame, cached, dst, planSourceCopies(cached, dst, box));
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  const out = f.source.getSource(crown);
  assert.equal(out.kind, 'live'); assert.deepEqual(stateWords(out.chunk, 'A', crown), expectedA); assert.deepEqual(stateWords(out.chunk, 'B', crown), expectedB);
});
check('actual window control ordering captures before origin mutation; no incomplete live publication', () => {
  const f = fixture(), order = [], win = f.win, sim = f.sim;
  sim.origin.clone = () => ({ ...sim.origin }); sim.shift = (dx, dz) => { order.push('shift'); sim.origin.x += dx; sim.origin.z += dz; sim.cur = 1 - sim.cur; };
  win.renderSource = { recordLeavingCopy(_frame, _sim, bounds, old) { order.push('capture'); assert.deepEqual(old, [32, 0, 32]); assert.deepEqual(bounds.lo, [32, 0, 32]); return {}; },
    restoreCaptured() { order.push('restoreCaptured'); }, recordLiveCopy() { order.push('publishLive'); } };
  win.gen = { diff() { order.push('diff'); }, fill() { order.push('fill'); } }; win.leave = {}; win.readBack = () => order.push('readBack'); win.restore = () => { order.push('restoreStore'); return 0; };
  win.plant = () => { order.push('plant'); return 0; }; win.scene.trees = {};
  WorldWindow.prototype.shift.call(win, 16, 0);
  assert.deepEqual(order, ['capture', 'diff', 'readBack', 'shift', 'fill', 'restoreStore', 'restoreCaptured', 'plant', 'publishLive']);
});
check('raw producer rejects an epoch/revision overtaken before recording; separate default-limit layouts', () => {
  const f = fixture(); f.win.gen = { ready: Promise.resolve(), res: { layout: [] } }; f.win.scene.glsl = () => '';
  const p = new RawWorldSourceProducer(f.win, f.source), token = f.source.token(); f.source.nextRevision();
  assert.equal(p.record(f.frame, [32, 32], token), null); f.source.reset(5); assert.equal(p.record(f.frame, [32, 32], token), null);
  assert.equal(RAW_LAYOUT.length + 2, 7); assert.equal(RAW_READ_LAYOUT.length + stateLayout(APPLY_STATE).length + 1, 8);
  p.dispose();
});
// Exercise the real raw producer's command wiring (not a second generator).
{
  const f = fixture();
  f.win.gen = { ready: Promise.resolve(), res: { layout: [], entries: () => [], prepassFor() {} } };
  f.win.scene.glsl = () => '';
  f.win.scene.trees = { treesIn: () => [{ x: 68, y: 4, z: 36, seed: 123 }] };
  f.win.bakeTree = () => ({ w: 1, h: 1, d: 1, base: { x: 0, y: 0, z: 0 }, foot: 32, data: new Float32Array([5, 87, 11, 1]) });
  const A = new Float32Array(256), B = new Float32Array(256); new Uint32Array(B.buffer).fill(0x3f012345);
  f.win.store.put(f.win.store.key(17, 1, 9), encodeBrick(A, 0, B, 0)); // support beyond x=64 physics edge
  f.sim.deco = { store: new Map([[f.win.store.key(17, 1, 9), new Uint8Array(new Uint32Array(64).fill(0xfe123456).buffer)]]) };
  f.win.loaded = true;
  const producer = new RawWorldSourceProducer(f.win, f.source); await producer.ready;
  check('real raw producer overlays outside saved support, protects edits and applies only touched fresh bounds', () => {
    const token = f.source.token(), result = producer.record(f.frame, [32, 32], token, { physicsBounds: { lo: [32, 0, 32], hi: [48, 32, 64] } });
    assert(result); f.flush();
    assert.equal(producer.generate.calls.length, 1); assert.equal(producer.stamp.calls.length, 1); assert.equal(producer.apply.calls.length, 1);
    assert.deepEqual(producer.generate.calls[0].opts.header.origin, [16, 0, 16]);
    const rs = cellSlot(producer.g, 68 - 16, 4, 36 - 16);
    assert.equal(wordView(producer.buffers.touched)[rs], 0x80000000);
    assert.deepEqual(producer.apply.calls[0].opts.params.lo, [0, 0, 0]);
    assert.deepEqual(producer.apply.calls[0].opts.params.hi, [16, 32, 32]);
    const out = f.source.getSource([68, 4, 36]); assert.equal(out.kind, 'saved'); assert(out.aux & 4);
    assert.equal(wordView(out.chunk.deco.buffer)[out.slot], 0xfe123456);
    assert.equal(f.source.getSource([120, 0, 120]).kind, 'unknown');
  });
  producer.dispose();
}
check('real physics plant keeps planted marks until shared producer records and skips reentry', () => {
  const f = fixture(), win = f.win, order = [];
  win.sourceProducer = { record(_frame, _xz, _token, opts) { assert.equal(win.planted[8 + 8 * 32], 0); assert.deepEqual(opts.physicsBounds.lo, [32, 0, 32]); order.push('record'); return { trees: 1 }; } };
  assert.equal(WorldWindow.prototype.plant.call(win, [0, 0, 0], [16, 32, 16]), 1);
  assert.equal(win.planted[8 + 8 * 32], 1); assert.equal(order.length, 1);
  assert.equal(WorldWindow.prototype.plant.call(win, [0, 0, 0], [16, 32, 16]), 0); assert.equal(order.length, 1);
});
check('source owns only its cache buffers; disposal idempotent and scene appearance preserved', () => {
  const f = fixture(); fillState(f); f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  assert.equal(f.source.bindings.appearanceWords, f.win.scene.appearanceWords); assert.equal(f.source.bindings.importManifest, f.win.scene.importManifest);
  assert.match(f.source.auxContract.histories, /phase 2/); assert.match(f.source.auxContract.persistence, /aux remains/);
  f.source.dispose(); const n = f.retired.length; f.source.dispose(); assert.equal(f.retired.length, n); assert(n > 0);
  assert(!f.retired.includes(f.sim.state.A)); assert(!f.retired.includes(f.sim.flow));
  assert.equal(f.source.recordPopulate(f.frame, snapshotSource(f.sim)), 0);
});
const windowCode = readFileSync(new URL('../src/world/window.js', import.meta.url), 'utf8');
assert(windowCode.includes('this.sourceProducer.record('));
assert(readFileSync(new URL('../src/sim.js', import.meta.url), 'utf8').includes('this.worldRenderSource?.recordLiveCopy(f, this)'));
console.log(`PASS ${assertions} world raw source CPU contracts; GPU numerical/visual equivalence remains unverified`);
