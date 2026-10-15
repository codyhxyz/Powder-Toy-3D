// CPU command/authority tests. No browser, GPU, shader interpreter or speed claim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorldRenderSource, SOURCE_GRID, SOURCE_RANK, snapshotSource, sourceBounds, planSourceCopies, recordSourceCopies, decodeSourceBrick } from '../src/world/renderSource.js';
import { rawSourceGrid, treeColumnMask, sourceTrees, RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { gridDims, cellSlot, slotCell } from '../src/shaders/common.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { WorldWindow } from '../src/world/window.js';
import { Simulation } from '../src/sim.js';
import { Deco } from '../src/deco.js';
import { WorldGenerator } from '../src/world/gpu.js';
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
    createBuffer({ size, label }) { const b = { size, label, bytes: new Uint8Array(size), getMappedRange() { return this.bytes.buffer; }, unmap() {}, destroy() {} }; owned.push(b); return b; },
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
check('whole-brick copy planning matches cell-exact runs, including mixed and partial authority', () => {
  const src = { origin: [1536, 0, 512], g: gridDims({ nx: 128, ny: 128, nz: 128 }) };
  const dst = { origin: [1600, 32, 544], g: SOURCE_GRID };
  const full = { lo: [...dst.origin], hi: dst.origin.map((v) => v + 32) };
  const partial = { lo: full.lo.map((v) => v + 1), hi: full.hi.map((v) => v - 1) };
  for (const bounds of [full, partial]) {
    assert.deepEqual(planSourceCopies(src, dst, bounds), planSourceCopies(src, dst, bounds, () => true));
    let cellCalls = 0, brickCalls = 0;
    const selected = (_d, p) => (p[0] & 4) === 0;
    const bulk = planSourceCopies(src, dst, bounds, (d, p) => { cellCalls++; return selected(d, p); },
      (d, p) => { brickCalls++; return selected(d, p); });
    assert.deepEqual(bulk, planSourceCopies(src, dst, bounds, selected));
    assert(brickCalls > 0);
    if (bounds === full) assert.equal(cellCalls, 0, 'aligned bulk copies must not visit individual cells');
    else assert(cellCalls > 0, 'partial brick edges require exact per-cell checks');
    const mixed = (_d, p) => (p[0] & 1) === 0;
    assert.deepEqual(planSourceCopies(src, dst, bounds, mixed, () => null), planSourceCopies(src, dst, bounds, mixed));
  }
});
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
check('bulk LIVE metadata never bypasses a newer partial source revision', () => {
  const f = fixture(); fillState(f);
  const src = snapshotSource(f.sim), p = [...src.origin], bounds = { lo: p, hi: p.map((v) => v + 1) };
  f.source.recordPopulate(f.frame, { ...src, kind: 'saved', bounds }, { epoch: f.source.epoch, revision: 1000 });
  f.flush();
  const original = stateWords(f.source.getSource(p).chunk, 'A', p);
  fillState(f, 700);
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  const protectedCell = f.source.getSource(p);
  assert.equal(protectedCell.kind, 'saved'); assert.equal(protectedCell.revision, 1000);
  assert.deepEqual(stateWords(protectedCell.chunk, 'A', p), original);
  assert.equal(f.source.getSource([p[0] + 1, p[1], p[2]]).kind, 'live');
  f.source.revision = 1000;
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  assert.equal(f.source.getSource(p).kind, 'live');
  assert.deepEqual(stateWords(f.source.getSource(p).chunk, 'A', p), stateWords(snapshotSource(f.sim), 'A', p));
});
check('cached live geometry reuses plans across cur changes but not origin changes', () => {
  const f = fixture(); fillState(f);
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  const core = f.source.getSource([32, 0, 32]).chunk, first = core.liveCopyPlan;
  f.sim.cur = 0; fillState(f, 800);
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  assert.equal(core.liveCopyPlan, first);
  assert.deepEqual(stateWords(core, 'B', [32, 0, 32]), stateWords(snapshotSource(f.sim), 'B', [32, 0, 32]));
  f.sim.origin.x += 16;
  f.source.recordLiveCopy(f.frame, f.sim); f.flush();
  assert.notEqual(core.liveCopyPlan, first);
  assert.deepEqual(stateWords(core, 'A', [48, 0, 32]), stateWords(snapshotSource(f.sim), 'A', [48, 0, 32]));
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
  f.win.store.put(f.win.store.key(9, 1, 9), bytes); f.source.recordStore({ lo: [36, 4, 36], hi: [40, 8, 40] }); f.flush();
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
    recordStore() { order.push('recordStore'); }, restoreCaptured() { order.push('restoreCaptured'); }, recordLiveCopy() { order.push('publishLive'); } };
  win.gen = { diff() { order.push('diff'); }, fill() { order.push('fill'); } }; win.leave = {}; win.readBack = () => order.push('readBack'); win.restore = () => { order.push('restoreStore'); return 0; };
  win.plant = () => { order.push('plant'); return 0; }; win.scene.trees = {};
  WorldWindow.prototype.shift.call(win, 16, 0);
  assert.deepEqual(order, ['capture', 'diff', 'readBack', 'shift', 'fill', 'recordStore', 'restoreStore', 'restoreCaptured', 'plant', 'publishLive']);
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
// Production JS orchestration with CPU command buffers. Dispatch below stands
// in for WGSL, not a numerical GPU proof; equality deliberately models the
// existing restore writer, so native restoration must repair signed zero.
function windowFixture() {
  const f = fixture(), { sim, win, gpu } = f;
  Object.assign(sim.origin, { set(x, y, z) { Object.assign(this, { x, y, z }); }, clone() { return { x: this.x, y: this.y, z: this.z }; } });
  Object.assign(sim, { worldRenderSource: f.source, shiftKeepsHistory: true, _shiftListeners: [], rays: { reset() {} },
    L: { FLOW_SHIFT: [] }, wake() {}, noteWrite: Simulation.prototype.noteWrite, edit: Simulation.prototype.edit,
    freshFlags: Simulation.prototype.freshFlags, shift: Simulation.prototype.shift, stillFlow: Simulation.prototype.stillFlow,
    _clip: Simulation.prototype._clip, _editGroup() { return {}; }, passOf: (name) => name });
  sim.header = (src = sim.cur, dst = src) => ({ src, dst, origin: [sim.origin.x, 0, sim.origin.z] });
  const shiftWords = (a, b, width, dx, dz, srcCopy = 0, dstCopy = 0) => {
    const src = wordView(a).slice(srcCopy * sim.g.slots * width, (srcCopy + 1) * sim.g.slots * width), dst = wordView(b);
    for (let z = 0; z < sim.g.nz; z++) for (let y = 0; y < sim.g.ny; y++) for (let x = 0; x < sim.g.nx; x++) {
      const d = (dstCopy * sim.g.slots + cellSlot(sim.g, x, y, z)) * width, sx = x + dx, sz = z + dz;
      if (sx < 0 || sx >= sim.g.nx || sz < 0 || sz >= sim.g.nz) dst.fill(0, d, d + width);
      else { const s = cellSlot(sim.g, sx, y, sz) * width; dst.set(src.subarray(s, s + width), d); }
    }
  };
  sim._dispatch = (kernel, _size, { params = {}, header = sim.header() } = {}) => {
    f.flush();
    if (kernel === 'shift') for (const name of ['A', 'B']) shiftWords(sim.state[name], sim.state[name], 4, params.shift[0], params.shift[2], header.src, header.dst);
    if (kernel === 'flowShift') shiftWords(sim.flow, sim.flowTmp, 2, params.shift[0], params.shift[2]);
    if (kernel === 'brush') wordView(sim.state.A)[(sim.cur * sim.g.slots + cellSlot(sim.g, ...params.editLo)) * 4 + 3] = 0xdeadbeef;
    if (kernel === 'fill' || kernel === 'restore') {
      const au = wordView(sim.state.A), bu = wordView(sim.state.B);
      const af = new Float32Array(au.buffer), bf = new Float32Array(bu.buffer);
      const raw = win.restoreBuf && new Uint32Array(win.restoreBuf.bytes.buffer);
      const saved = raw && new Float32Array(raw.buffer);
      for (let z = params.editLo[2]; z <= params.editHi[2]; z++) for (let y = params.editLo[1]; y <= params.editHi[1]; y++) for (let x = params.editLo[0]; x <= params.editHi[0]; x++) {
        const d = (sim.cur * sim.g.slots + cellSlot(sim.g, x, y, z)) * 4;
        if (kernel === 'fill') { au.fill(0, d, d + 4); bu.fill(0, d, d + 4); continue; }
        const p = [x, y, z].map((v, i) => v - params.lo[i]), brick = p.map(v => v >> 2);
        const index = raw[brick[0] + params.bricks[0] * (brick[1] + params.bricks[1] * brick[2])];
        if (!index) continue;
        const s = params.cellsAt * 4 + (index - 1) * 512 + ((p[0] & 3) + 4 * ((p[1] & 3) + 4 * (p[2] & 3))) * 4;
        if ([0, 1, 2, 3].every(c => af[d + c] === saved[s + c] && bf[d + c] === saved[s + 256 + c])) continue;
        au.set(raw.subarray(s, s + 4), d); bu.set(raw.subarray(s + 256, s + 260), d);
      }
    }
  };
  sim._shiftListeners.push((dx, dz) => {
    shiftWords(sim.aeration.buffer, sim.aeration.buffer, 2, dx, dz, sim.aeration.cur, sim.aeration.cur);
    shiftWords(sim.decoPlane.buffer, sim.decoPlane.buffer, 1, dx, dz);
  });
  win.gen = { P: {}, sim, res: { resources: [], prepassFor() {} }, kernels: { fill: { main: 'fill' } }, fill: WorldGenerator.prototype.fill, diff() {} };
  win.P = win.gen.P; win.restoreKernel = { main: 'restore' }; win.restore = WorldWindow.prototype.restore;
  win.storeRevisions = new Map(); win.leave = {}; win.readBack = () => {}; win.loaded = true;
  sim.dropHistory = () => {}; win.far = null;
  return f;
}
const oldUsage = globalThis.GPUBufferUsage;
globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };
try {
  check('actual cold loadSaved + shift/reentry restores signed zero, NaN payload, tiny heat, pressure and appearance words', () => {
    const f = windowFixture(), { win, sim } = f;
    const outside = new BrickStore(win.wb), A = new Float32Array(256), B = new Float32Array(256);
    const au = new Uint32Array(A.buffer), bu = new Uint32Array(B.buffer);
    bu[3] = 0x80000000; // cell differs ONLY by signed zero: equality restore skips it
    au[4 + 1] = 0x7fc12345; au[8 + 1] = 0x00000001; bu[12 + 3] = 0x3f800001; au[16 + 3] = 0xdeadbeef;
    const key = outside.key(16, 1, 9); outside.put(key, encodeBrick(A, 0, B, 0));
    WorldWindow.prototype.loadSaved.call(win, [32, 0, 32], () => {}, outside.toBytes(), win.planted.slice());
    assert.equal(f.source.getSource([64, 4, 36]).kind, 'unknown', 'saved-only; no warm cache');
    WorldWindow.prototype.shift.call(win, 16, 0); f.flush();
    assert(!win.store.has(key));
    const verify = () => {
      for (let i = 0; i < 64; i++) {
        const p = [64 + (i & 3), 4 + (i >> 2 & 3), 36 + (i >> 4)];
        const out = f.source.getSource(p);
        for (const [name, words] of [['A', au], ['B', bu]]) {
          assert.deepEqual(stateWords(snapshotSource(sim), name, p), [...words.subarray(i * 4, i * 4 + 4)]);
          assert.deepEqual(stateWords(out.chunk, name, p), [...words.subarray(i * 4, i * 4 + 4)]);
        }
      }
    };
    verify(); WorldWindow.prototype.shift.call(win, -16, 0); WorldWindow.prototype.shift.call(win, 16, 0); f.flush(); verify();
    assert.equal(f.source.bindings.appearanceWords, win.scene.appearanceWords);
  });
  check('actual no-step window departure/reentry preserves content token and every A/B/flow/aer/deco word', () => {
    const f = windowFixture(); fillState(f); f.source.recordLiveCopy(f.frame); f.flush();
    const before = snapshotSource(f.sim), originals = {};
    for (const name of ['A', 'B']) originals[name] = wordView(before[name]).slice(before.copy * before.g.slots * 4, (before.copy + 1) * before.g.slots * 4);
    originals.flow = wordView(before.flow).slice(); originals.aer = wordView(before.aeration).slice(before.aerCopy * before.g.slots * 2, (before.aerCopy + 1) * before.g.slots * 2); originals.deco = wordView(before.deco.buffer).slice();
    const token = f.source.contentToken(), authority = f.source.revision;
    const pinned = f.source.snapshotForFields();
    WorldWindow.prototype.shift.call(f.win, 16, 0); WorldWindow.prototype.shift.call(f.win, -16, 0); f.flush();
    assert.deepEqual(f.source.contentToken(), token); assert(f.source.revision > authority); assert(pinned.isCurrent());
    const after = snapshotSource(f.sim);
    for (const name of ['A', 'B']) assert.deepEqual(wordView(after[name]).slice(after.copy * after.g.slots * 4, (after.copy + 1) * after.g.slots * 4), originals[name]);
    assert.deepEqual(wordView(after.flow), originals.flow);
    assert.deepEqual(wordView(after.aeration).slice(after.aerCopy * after.g.slots * 2, (after.aerCopy + 1) * after.g.slots * 2), originals.aer);
    assert.deepEqual(wordView(after.deco.buffer), originals.deco);
    pinned.assertComplete([sourceBounds(f.sim)]);
    assert.throws(() => pinned.assertComplete([{ lo: [0, 0, 0], hi: [4, 4, 4] }]), /Incomplete/);
    const dst = { A: f.gpu.createBuffer({ size: SOURCE_GRID.slots * 16 }), B: f.gpu.createBuffer({ size: SOURCE_GRID.slots * 16 }), aeration: f.gpu.createBuffer({ size: SOURCE_GRID.slots * 8 }) };
    pinned.recordGatherRaw(f.frame, { resources: dst, g: SOURCE_GRID, scratchOrigin: before.origin, sourceRevision: token.sourceRevision }); f.flush();
    assert.deepEqual(wordView(dst.A), originals.A); assert.deepEqual(wordView(dst.B), originals.B); assert.deepEqual(wordView(dst.aeration), originals.aer);
  });
  check('content snapshots ignore ownership transfers but reject writes and resets; shift callbacks are not suppressed', () => {
    const f = windowFixture();
    const pin = f.source.snapshotForFields(), token = f.source.contentToken();
    f.source.recordStore(sourceBounds(f.sim));
    f.source.recordPopulate(f.frame, { ...snapshotSource(f.sim), kind: 'generated' });
    f.source.recordLiveCopy(f.frame); assert.deepEqual(f.source.contentToken(), token); assert(pin.isCurrent());
    f.sim._shiftListeners.push(() => f.sim.edit({ main: 'brush' }, { lo: [1, 1, 1], hi: [1, 1, 1] }));
    WorldWindow.prototype.shift.call(f.win, 16, 0);
    assert(!pin.isCurrent(), 'real listener edit during synchronous residency move must not be suppressed');
    assert.throws(() => pin.assertComplete([]), /Stale/);
    const pin2 = f.source.snapshotForFields(); f.source.reset(f.source.epoch + 1); assert(!pin2.isCurrent());
  });
  check('actual paused edit, whole write, physics step, aeration reset/idle and scene changes advance content', () => {
    const f = windowFixture(), { sim, source } = f;
    const advances = (fn) => { const before = source.contentRevision; fn(); assert(source.contentRevision > before); };
    advances(() => sim.edit({ main: 'brush' }, { lo: [0, 0, 0], hi: [0, 0, 0] }));
    advances(() => sim.noteWrite()); advances(() => sim.stillFlow()); advances(() => source.invalidateGenerated());
    Object.assign(sim, { frame: 0, actAge: 0, actSteps: 0, kernels: { move: 'move', react: 'react' }, rays: { active: false }, aeration: null });
    advances(() => Simulation.prototype.step.call(sim));
    sim.onShift = () => () => {}; sim.attachAeration = (a) => { sim.aeration = a; };
    const aer = setAeration(sim, true); aer._dispatch = () => {}; aer._group = () => ({});
    advances(() => aer.reset());
    // Actual idle method invokes actual _run, not a mirrored revision model.
    for (const k of Object.values(aer.kernels)) k.state = 'ready';
    f.gpu.readback = { buffer: async () => new Uint32Array([1]).buffer };
    aer.idleSteps = 0; advances(() => aer.idle(f.frame));
    dropAeration(sim);
  });
  {
    const f = windowFixture(), token = f.source.token();
    const producer = new RawWorldSourceProducer(Object.assign(f.win, { scene: { ...f.win.scene, glsl: () => '' }, gen: { ready: Promise.resolve(), res: { layout: [] } } }), f.source);
    let release; const delayed = new Promise(resolve => { release = resolve; });
    const result = delayed.then(() => producer.record(f.frame, [32, 32], token));
    f.sim.edit({ main: 'brush' }, { lo: [1, 1, 1], hi: [1, 1, 1] });
    const edited = f.source.contentRevision; release(); assert.equal(await result, null); assert.equal(f.source.contentRevision, edited);
    f.source.recordLiveCopy(f.frame); f.flush();
    const brush = f.source.getSource([33, 1, 33]);
    assert.equal(stateWords(brush.chunk, 'A', [33, 1, 33])[3], 0xdeadbeef, 'intervening user words survive delayed producer rejection');
    producer.dispose(); assertions++; console.log('PASS ongoing paused edit during delayed producer invalidates old token without suppression');
  }
  for (const newer of [22, 0, 'fail']) {
    const f = fixture(), requests = []; f.gpu.readback = { buffer() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); } };
    f.sim._dispatch = () => {}; // GPU dispatch only; actual Deco stage/group/read orchestration runs
    f.sim.worldRenderSource = f.source;
    const deco = new Deco(f.sim); await deco.ready; for (const k of Object.values(deco.k)) k.state = 'ready';
    const beforeUpload = f.source.contentRevision;
    deco.upload(new Uint8Array(f.sim.g.width * f.sim.g.height * 4));
    assert(f.source.contentRevision > beforeUpload);
    deco.active = true;
    deco.leave([0, 0, 0], [1, 1, 1], () => 7); const olderRead = deco.pending;
    deco.leave([0, 0, 0], [1, 1, 1], () => 7); const newerRead = [...deco.storeReads][1];
    const bytes = v => new Uint32Array(64).fill(v).buffer;
    if (newer === 'fail') {
      const savedError = console.error; console.error = () => {};
      try { requests[1].reject(new Error('intentional delayed readback failure')); await newerRead; } finally { console.error = savedError; }
    } else { requests[1].resolve(bytes(newer)); await newerRead; }
    assert.equal(deco.pending, olderRead, 'newer completion must keep older outstanding read visible');
    requests[0].resolve(bytes(11)); await olderRead;
    assert.equal(deco.pending, null); assert.equal(deco.storeReads.size, 0);
    if (newer === 22) assert.equal(new Uint32Array(deco.store.get(7).buffer)[0], 22);
    else assert(!deco.store.has(7), 'older read must not resurrect newer deletion or failed newer capture');
    deco.leave([0, 0, 0], [1, 1, 1], () => 7); const stale = deco.pending; deco.reset();
    requests[2].resolve(bytes(99)); await stale; assert(!deco.store.has(7)); assert.equal(deco.pending, null);
    deco.dispose(); assertions++; console.log(`PASS actual Deco.leave reversed newer ${newer} + epoch/error/pending cleanup`);
  }
} finally { if (oldUsage === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = oldUsage; }
const windowCode = readFileSync(new URL('../src/world/window.js', import.meta.url), 'utf8');
assert(windowCode.includes('this.sourceProducer.record('));
assert(readFileSync(new URL('../src/sim.js', import.meta.url), 'utf8').includes('this.worldRenderSource?.recordLiveCopy(f, this)'));
console.log(`PASS ${assertions} world raw source CPU contracts; GPU numerical/visual equivalence remains unverified`);
