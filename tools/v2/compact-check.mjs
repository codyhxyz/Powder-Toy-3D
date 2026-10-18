// CPU-only protocol tests. No GPU/browser: kernels are spies, not a physics emulator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { prelude, STATE_OPTS, HEADER_FIELDS, marksLayout } from '../../src/shaders/common.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { Header, uniformStruct } from '../../src/gpu/params.js';
import raysWire from '../../src/wire/rays.js';
import { v2BridgeWGSL, v2ImportWGSL, v2InvalidateWGSL, v2ActLayout } from '../../src/shaders/v2.js';

globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const calls = [];
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {},
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: {
    copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
    clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); },
  },
  kernel: ({ name }) => ({ name, ready: Promise.resolve(), dispatch(f, size, opts) { calls.push({ name, size, opts }); } }),
  readback: { buffer: async (b, at, n) => b.data.slice(at, at + n).buffer },
  flush() {},
};
const g = gridLayout(32, 32, 32), bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], UNDO: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [],
  wake() {}, _retire() {}, stillFlow() {}, rays: { wake() {} },
  passes: { undoShift: { name: 'undoShift', dispatch() {} } },
});
const v2 = new PhysicsV2(sim);
await v2.ready;
v2.sync();
assert.equal(calls.at(-1).name, 'v2import');
assert.equal(calls.at(-1).opts.header.format, 0);
assert.equal(sim.readHeader().format, 2);
assert.equal(sim.readHeader().src, 1, 'copy index is not overloaded');
assert.equal(sim.bindRO, v2.groups.read);
assert.equal(HEADER_FIELDS.format, 'u32');
assert.deepEqual(Header.fields, uniformStruct('Header', HEADER_FIELDS).fields, 'CPU and shader header layouts agree');
const packed = Header.pack(sim.readHeader());
assert.equal(new DataView(packed).getUint32(Header.offsets.format, true), 2, 'real parameter ring can pack the compact selector');

calls.length = 0;
v2.ticks(40);
assert(!calls.some(c => c.name === 'v2bridge'), 'normal ticks do not export');
assert.equal(calls.filter(c => c.name === 'v2invalidate').length, 40);
sim.bindRO; sim.readHeader();
assert(!calls.some(c => c.name === 'v2bridge'), 'direct reader setup does not export');
assert(v2.legacyPending);
v2.certified = true; // accumulated compatibility dirtiness must survive idle certification
sim.bindRW;
assert.equal(calls.at(-1).name, 'v2bridge', 'write boundary exports even after sleep');
const exported = calls.length;
sim.bindFlagsRO; sim.bindAct;
assert.equal(calls.length, exported + 1, 'visual readers refresh the physical edit projection once');
assert.equal(v2.legacyNative, false);
sim.bindFlagsRO; sim.bindAct;
assert.equal(calls.length, exported + 1, 'unchanged visual cache does not export twice');
sim.version++;
sim.bindRO;
assert.equal(calls.at(-1).name, 'v2import', 'paused reader imports edits, without a tick');
assert.equal(v2.tick, 40);

// Exact snapshot ownership/copy protocol (all four compact words, arbitrary fractional/flux bits).
const words = new Uint32Array(v2.cells.data.buffer);
words.set([0x04950103, 12345, 0xbc007c00, 0xffff3800], 16);
v2.exportLegacy();
sim.snapshot('fractional');
assert.equal(sim.history.at(-1).format, 'v2');
assert.deepEqual(sim.history.at(-1).compact.data, v2.cells.data);
const original = v2.cells.data.slice();
words.fill(0);
assert(sim.undo());
assert.deepEqual(v2.cells.data, original, 'undo preserves fractional fill and flux bits');
assert(!v2.importFull, 'undo must not subsequently re-import the lossy projection');

// A switch is not a whole-state write. An unchanged box keeps every compact word.
const beforeSwitch = sim.wholeWrites;
calls.length = 0;
v2.suspend();
assert.equal(sim.header().capture, 1, 'suspended compact owner tracks legacy cell writes');
v2.activate();
assert.equal(sim.wholeWrites, beforeSwitch);
assert(!calls.some(c => c.name === 'v2import'), 'no-op round trip never projects back into compact cells');
assert.deepEqual(v2.cells.data, original);

// Saves own the clock, activity and raw bits, not just visible A/B.
v2.tick = 123; v2.acc = 0.625; sim.frame = 912; sim.paints = 84;
const saved = await v2.captureState();
words.fill(0); v2.tick = 0; v2.acc = 0; sim.frame = 0; sim.paints = 0;
v2.restoreState(saved);
assert.deepEqual(v2.cells.data, original);
assert.equal(v2.tick, 123); assert.equal(v2.acc, 0.625);
assert.equal(sim.frame, 912); assert.equal(sim.paints, 84);
assert(!v2.importFull && !v2.importMarked);
calls.length = 0;
v2.ticks(1);
const continuation = calls.map(({ name, size, opts }) => ({ name, size, header: opts.header, params: opts.params }));
v2.restoreState(saved);
calls.length = 0;
v2.ticks(1);
assert.deepEqual(calls.map(({ name, size, opts }) => ({ name, size, header: opts.header, params: opts.params })), continuation,
  'restored clock dispatches the same partition offset and busy parity on continuation');
assert.equal(sim.readHeader().capture, 2, 'active native edits use field-preserving ownership');
v2.exportLegacy();
assert.equal(calls.at(-1).opts.header.capture, 0, 'bridge writes cannot steal compact ownership');
v2.restoreState(saved, { legacyCurrent: true });
calls.length = 0;
v2.suspend();
assert(!calls.some(c => c.name === 'v2bridge'), 'a suspended-mode load keeps saved legacy velocities instead of projecting zeros');
v2.activate();
sim.version += 2; // a v1 step or edit; activity marks may already have been consumed
v2.sync();
assert.equal(calls.at(-1).opts.params.full, 0, 'ordinary legacy writes import only owned cells');
assert.equal(calls.at(-1).opts.header.capture, 0, 'import cannot re-mark ownership');

sim.snapshot('across modes');
v2.suspend();
assert.equal(sim.readHeader().format, 0);
assert.equal(sim.history.at(-1).format, 'v2', 'mode switches retain history tags');
assert(sim.undo(), 'v1 accepts the saved projection of a v2 snapshot');
sim.snapshot('legacy');
assert.equal(sim.history.at(-1).format, 'v1');
v2.activate();
assert.equal(calls.at(-1).opts.params.full, 1, 'an actual legacy undo replaces the retained compact state on activation');
assert(!v2.importFull, 'activation consumes the replacement immediately');
sim.undo();
v2.sync();
assert.equal(calls.at(-1).name, 'v2import', 'legacy undo in v2 imports the restored projection');

sim.snapshot('shift guard');
sim.origin.x = 16;
assert.throws(() => sim.undo(), /Native shifted undo is not ready/);
assert.equal(sim.history.length, 1, 'a not-yet-ready shift keeps the history entry');
sim.origin.x = 0;

const direct = prelude(g, STATE_OPTS.STATE_RO), bridge = v2BridgeWGSL(g), imported = v2ImportWGSL(g);
for (const code of [direct, bridge, imported]) assert(code.includes(compactDecodeWGSL), 'one shared decoder');
assert(direct.includes('A: array<vec4u>'), 'compact NaN-like bit patterns are loaded as integers');
assert(bridge.includes('V2_LEGACY + b'));
assert(!bridge.includes('V2_LIST + e'), 'lazy export is not limited to current awake bricks');
assert(v2InvalidateWGSL(g).includes('MARK_DERIVED'));
assert(v2InvalidateWGSL(g).includes('atomicExchange(&act2[V2_VISIBLE + b], 0u)'));
assert(!v2InvalidateWGSL(g).includes('atomicLoad(&act2[V2_AWAKE + b])'), 'quiet awake halos do not reset render ages');
assert(imported.includes('MARK_OWNED + b * 2u'), 'ownership survives consumption of legacy activity marks');
assert(imported.includes('atomicAnd(&marks[MARK_OWNED'), 'import clears only consumed ownership bits');
const writer = prelude(g, STATE_OPTS.STATE_RW);
assert(writer.includes('noteLegacy(s, a, b);'));
assert(writer.includes('noteLegacy(slotOf(p), a, b);'));
assert(writer.indexOf('ownLegacy(slotOf(p));', writer.indexOf('fn writeCell')) < writer.indexOf('if (all(oA == a)', writer.indexOf('fn writeCell')), 'explicit no-op erases claim hidden fill');
const marks = marksLayout(g);
assert.equal(marks.words - marks.owned, g.slots / 32, 'one sticky bit per cell');
const layout = v2ActLayout(g);
assert(layout.legacy > layout.count && layout.words >= layout.legacy + g.nbricks);
const driver = readFileSync(new URL('../../src/v2/physics.js', import.meta.url), 'utf8');
assert(!driver.slice(driver.indexOf('  _tick()'), driver.indexOf('  ticks(n)')).includes('run(k.v2bridge'));
const wholeBefore = sim.wholeWrites;
sim.noteWrite({ replaceState: false });
assert.equal(sim.wholeWrites, wholeBefore, 'flags-only invalidation does not replace compact state');
sim.noteWrite();
assert.equal(sim.wholeWrites, wholeBefore + 1, 'actual full-state writes still request full import');
const app = { sim: { compact: {}, rays: { active: true, holds: false } }, settings: { paused: false } };
assert.equal(raysWire.busy(app), false, 'an empty legacy scan cannot keep v2 awake');
app.sim.rays.holds = true;
assert.equal(raysWire.busy(app), true, 'actual particles are not hidden from the busy check');
app.sim.compact = null; app.sim.rays.holds = false;
assert.equal(raysWire.busy(app), true, 'v1 still runs its pending emitter scan');
// The foundation owns allocation; persistence treats its one-word-per-cell aux as opaque.
v2.aux = buffer({ size: g.slots * 4 });
const auxWords = new Uint32Array(v2.aux.data.buffer);
auxWords.set([0xdeadbeef, 0x7fc00001, 0xffffffff, 0x80000000]);
const expectedAux = v2.aux.data.slice();
v2.sync();
const withAux = await v2.captureState();
auxWords.fill(0);
v2.restoreState(withAux);
assert.deepEqual(v2.aux.data, expectedAux, 'save restores every opaque aux word');
v2.restoreState(saved);
assert(auxWords.every(word => word === 0), 'pre-aux save restores zero state');
auxWords.set([0xdeadbeef, 0x7fc00001, 0xffffffff, 0x80000000]);
assert(sim.undo(), 'the pre-aux compact snapshot is still in history');
assert(auxWords.every(word => word === 0), 'pre-aux undo clears auxiliary state');
auxWords.set([0xdeadbeef, 0x7fc00001, 0xffffffff, 0x80000000]);
sim.snapshot('aux exact');
assert.deepEqual(sim.history.at(-1).aux.data, expectedAux);
auxWords.fill(0);
assert(sim.undo());
assert.deepEqual(v2.aux.data, expectedAux, 'undo restores every opaque aux word');
const auxBuffer = v2.aux;
delete v2.aux;
assert.throws(() => v2.restoreState(withAux), /auxiliary owner/, 'do not silently discard nonzero aux before foundation merge');
v2.restoreState(saved); // absent owner is valid for old zero/default state
v2.aux = auxBuffer;
console.log('compact CPU protocol checks passed (dispatch, boundaries, paused import, exact undo, cross-mode tags, shared decode)');
