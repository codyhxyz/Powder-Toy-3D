// CPU-only protocol tests. No GPU/browser: kernels are spies, not a physics emulator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { prelude, STATE_OPTS, HEADER_FIELDS } from '../../src/shaders/common.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
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
    clear(b) { b.data.fill(0); },
  },
  kernel: ({ name }) => ({ name, ready: Promise.resolve(), dispatch(f, size, opts) { calls.push({ name, size, opts }); } }),
  readback: { buffer: async (b, at, n) => b.data.slice(at, at + n).buffer },
  flush() {},
};
const g = gridLayout(32, 32, 32), bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 1, version: 0, wholeWrites: 0,
  L: { TABLES: [], STATE_RO: [], UNDO: [] }, tables: {}, marks: buffer({ size: 4096 }),
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
assert.equal(calls.length, exported, 'unchanged cache does not export twice');
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

sim.snapshot('across modes');
v2.suspend();
assert.equal(sim.readHeader().format, 0);
assert.equal(sim.history.at(-1).format, 'v2', 'mode switches retain history tags');
assert(sim.undo(), 'v1 accepts the saved projection of a v2 snapshot');
sim.snapshot('legacy');
assert.equal(sim.history.at(-1).format, 'v1');
v2.activate();
assert(v2.importFull, 'return from v1 imports its current state');
sim.undo();
v2.sync();
assert.equal(calls.at(-1).name, 'v2import', 'legacy undo in v2 imports the restored projection');

sim.snapshot('shift guard');
sim.origin.x = 16;
assert.throws(() => sim.undo(), /Shifted compact undo/);
assert.equal(sim.history.length, 1, 'unsupported shift keeps the history entry');
sim.origin.x = 0;

const direct = prelude(g, STATE_OPTS.STATE_RO), bridge = v2BridgeWGSL(g), imported = v2ImportWGSL(g);
for (const code of [direct, bridge, imported]) assert(code.includes(compactDecodeWGSL), 'one shared decoder');
assert(direct.includes('A: array<vec4u>'), 'compact NaN-like bit patterns are loaded as integers');
assert(bridge.includes('V2_LEGACY + b'));
assert(!bridge.includes('V2_LIST + e'), 'lazy export is not limited to current awake bricks');
assert(v2InvalidateWGSL(g).includes('MARK_DERIVED'));
const layout = v2ActLayout(g);
assert(layout.legacy > layout.count && layout.words >= layout.legacy + g.nbricks);
const driver = readFileSync(new URL('../../src/v2/physics.js', import.meta.url), 'utf8');
assert(!driver.slice(driver.indexOf('  _tick()'), driver.indexOf('  ticks(n)')).includes('run(k.v2bridge'));
console.log('compact CPU protocol checks passed (dispatch, boundaries, paused import, exact undo, cross-mode tags, shared decode)');
