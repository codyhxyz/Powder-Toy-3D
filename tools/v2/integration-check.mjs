// CPU-only application/driver protocol tests. Native residency kernels below
// execute an independent coordinate reference, NOT WGSL or physics emulation.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { nativeCapabilities } from '../../src/v2/integration.js';
import { nativeHostSteps, nativeReadiness } from '../../src/v2/host.js';
import { emitNativeRay, nativeImpulse, worldPosition } from '../../src/v2/tools.js';
import { NativeBrickStore, encodeNativeBrick, decodeNativeBrick, validateNativeWorldStore } from '../../src/world/nativeStore.js';
import { WorldWindow } from '../../src/world/window.js';
import { WorldRenderSource } from '../../src/world/renderSource.js';
import { Stamper } from '../../src/world/gpu.js';
import { cellSlot, slotCell, marksLayout } from '../../src/shaders/common.js';
import { cellOf, Load, createTransfer } from '../../src/pov/tools/transfer.js';
import { decodeNativeTransfer, nativeCargo, NativeTransfer } from '../../src/v2/transfer.js';
import { applyGuestStroke } from '../../src/net/edits.js';
import { createPacker, createUnpacker, encodeFrame, decodeFrame, FRAME_KEY } from '../../src/net/codec.js';
import { E, K, TOOLS, ELEMENTS } from '../../src/elements.js';
import { readFileSync } from 'node:fs';

const g = gridLayout(32, 32, 32), calls = [], shifts = [], requests = [], builds = [];
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const words = b => new Uint32Array(b.data.buffer);
const inside = p => p.every((v, i) => v >= 0 && v < [g.nx, g.ny, g.nz][i]);
const slot = p => cellSlot(g, ...p);
function referenceDispatch(name, opts) {
  if (name === 'nativeTransfer') {
    const [core, bank, result, items] = opts.bind[2].entries.map(e => e.resource.buffer).map(words), p = opts.params;
    const f = new Float32Array(result.buffer), candidates = [];
    // Independent CPU specification: select/rank on the pre-transfer state.
    for (let i = 0; i < p.count; i++) {
      f[i * 9] = -1;
      const at = p.cells[i].slice(0, 3);
      if (!inside(at)) continue;
      const s = slot(at), id = core[s * 4] & 255, kind = ELEMENTS[id].kind, fill = core[s * 4 + 1] & 0xffffff;
      const occupied = id !== 0 && (kind !== K.LIQUID || fill > 0);
      if (p.mode === 1) { if (!occupied) candidates.push({ i, s }); continue; }
      const T = ((core[s * 4] >>> 8) & 65535) / 4 - 273.25;
      if (!occupied || T > p.maxTemperature || !(p.kinds & (1 << kind))) continue;
      if (p.cells[i][3] >= 0 && p.cells[i][3] !== id) continue;
      candidates.push({ i, s, id, T });
    }
    candidates.slice(0, p.limit).forEach(({ i, s, id, T }, rank) => {
      if (p.mode === 1) {
        f[i * 9] = rank;
        assert.equal(items[rank * 8 + 5], 1, 'reference fixture uses exact native cargo');
        core.set(items.subarray(rank * 8, rank * 8 + 4), s * 4); bank[s] = items[rank * 8 + 4];
      } else {
        f.set([id, T, 0, core[s * 4 + 1] >>> 24], i * 9);
        result.set(core.subarray(s * 4, s * 4 + 4), i * 9 + 4); result[i * 9 + 8] = bank[s];
        core.set([1173 << 8, 0, 0, 0], s * 4); bank[s] = 0;
      }
    });
    return;
  }
  if (!name.startsWith('nativeWindow')) return;
  const [core, bank, other, otherBank] = opts.bind[2].entries.map(e => e.resource.buffer).map(words);
  const p = opts.params;
  const slabCell = i => {
    const b = Math.floor(i / 64), l = i % 64;
    return [p.lo[0] + 4 * (b % p.bricks[0]) + l % 4,
      p.lo[1] + 4 * (Math.floor(b / p.bricks[0]) % p.bricks[1]) + Math.floor(l / 4) % 4,
      p.lo[2] + 4 * Math.floor(b / (p.bricks[0] * p.bricks[1])) + Math.floor(l / 16)];
  };
  for (let i = 0; i < p.count; i++) {
    if (name === 'nativeWindowshift') {
      const q = slotCell(g, i).map((v, j) => v + p.shift[j]);
      if (inside(q)) { const from = slot(q); other.set(core.subarray(from * 4, from * 4 + 4), i * 4); otherBank[i] = bank[from]; }
      else if (!p.preserve) { other.set([1173 << 8, 0, 0, 0], i * 4); otherBank[i] = 0; }
    } else if (name === 'nativeWindowgather') {
      const from = slot(slabCell(i)); other.set(core.subarray(from * 4, from * 4 + 4), i * 4); otherBank[i] = bank[from];
    } else {
      const j = p.preserve ? otherBank[p.count + Math.floor(i / 64)] * 64 + i % 64 : i;
      const to = slot(slabCell(j)); core.set(other.subarray(i * 4, i * 4 + 4), to * 4); bank[to] = otherBank[i];
    }
  }
}
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 },
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
  kernel: ({ name, build }) => {
    builds.push({ name, build });
    return { name, state: 'ready', ready: Promise.resolve(), dispatch(f, size, opts) { calls.push({ name, size, opts }); referenceDispatch(name, opts); } };
  },
  readback: { buffer: (b, at, n, opts) => { const copy = b.data.slice(at, at + n); if (opts?.into) new Uint8Array(opts.into).set(copy); return Promise.resolve(copy.buffer); } },
  flush() {},
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8 }),
  _shiftListeners: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {},
  rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() {} },
  passOf: name => gpu.kernel({ name }), passes: { paint: {}, undoShift: gpu.kernel({ name: 'undoShift' }) },
});
const owner = new PhysicsV2(sim); await owner.ready;
for (const name of Object.keys(owner.kernels)) {
  const desc = builds.find(b => b.name === name);
  assert.equal(desc.build, name === 'v2block' ? 'now' : 'idle', 'required contact must not wait behind idle graphics builds');
}
// The foundation lane owns allocation; this fixture supplies it on old bases.
owner.aux ??= buffer({ size: g.slots * 4 });
const adapter = owner.nativeDynamics;
assert(adapter.head && adapter.layout && adapter.group, 'foundation nativeDynamics is the immutable shader adapter');
owner.contactReady = true;
owner.dynamics = { isReady: true, isIdle: true,
  advanceParticles: () => calls.push({ name: 'native-particle-tick' }),
  consumeMaterialEvents: () => calls.push({ name: 'native-event-tick' }),
  advanceAir: () => calls.push({ name: 'native-air-tick' }), ready: Promise.resolve(), capabilities: { physicsReady: true, drawReady: true, impulse: true, photon: true, neutron: true },
  readActivity: async () => ({}), shiftWindow: delta => { shifts.push(delta); return Promise.resolve(); }, applyToolImpulse: r => { requests.push(r); return 'accepted'; } };
await sim.prepareNative(owner);
const shiftNative = (dx, dz) => sim.nativeIntegration.beginShift(dx, dz, () => sim.shift(dx, dz));
assert.equal(owner.nativeDynamics, adapter, 'application does not overwrite foundation adapter');
assert.equal(nativeCapabilities(sim).world, true);
assert.equal(nativeReadiness(sim, { pov: true }).ready, true);
assert.equal(nativeReadiness(sim, { world: true, pov: true }).ready, true, "the World renderer's copy gets V2's cells (src/world/renderSource.js liveSource)");
assert.equal(nativeReadiness(sim, { industry: true }).ready, true, 'Factory machines run natively (src/v2/industry.js): no engine refusal');
owner.contactReady = false;
assert.equal(nativeReadiness(sim, { world: true }).ready, false, 'pipeline names alone do not advertise contact parity');
owner.contactReady = true;
assert.equal(nativeReadiness(sim, { guest: true }).reason, 'render-only guest');
assert.equal(sim.readHeader({ physical: true }).format, 3);
assert.equal(sim.readHeader().format, 2, 'renderer and codec keep presentation semantics');

owner.sync();
const core = words(owner.cells), bank = words(owner.aux);
for (let s = 0; s < g.slots; s++) {
  core.set([E.WATER | (1173 << 8), (s % 3 === 0 ? 1 : 0x12345) | ((s & 255) << 24), (0xbc003c00 ^ (s & 1023)) >>> 0, (0x80000000 | (s & 0x7bff)) >>> 0], s * 4);
  bank[s] = (0x80000000 + s * 997) >>> 0;
}
const originalCore = core.slice(), originalBank = bank.slice();
const slab = await sim.nativeIntegration.captureSlab([0, 0, 0], [4, 8, 8]);
assert.equal(slab.length, 256);
const store = new NativeBrickStore([16, 8, 8]);
slab.forEach((b, i) => store.put(store.key(i % 4, Math.floor(i / 4) % 8, Math.floor(i / 32)), b));
const encoded = store.toBytes();
const stored = new NativeBrickStore(store.bricks); stored.fromBytes(encoded);
assert.equal(stored.bytes, slab.length * 1280);
validateNativeWorldStore(encoded, { size: [64, 32, 32] });
for (const bad of [encoded.subarray(0, encoded.length - 1), new Uint8Array(4).fill(255), new Uint8Array(2)]) {
  assert.throws(() => stored.fromBytes(bad)); assert.deepEqual(stored.toBytes(), encoded, 'invalid store never replaces existing state');
}
const duplicate = encoded.slice(); new DataView(duplicate.buffer).setUint32(4 + 1288, 0, true); assert.throws(() => stored.fromBytes(duplicate));
assert.throws(() => validateNativeWorldStore(encoded, null));

calls.length = 0;
await shiftNative(16, 0);
assert.deepEqual(shifts, [[16, 0, 0]], 'only dynamics local fields reindex; world particle positions belong to dynamics');
for (let s = 0; s < g.slots; s++) {
  const q = slotCell(g, s); q[0] += 16;
  if (inside(q)) {
    assert.deepEqual(core.subarray(s * 4, s * 4 + 4), originalCore.subarray(slot(q) * 4, slot(q) * 4 + 4));
    assert.equal(bank[s], originalBank[slot(q)]);
  } else { assert.equal(core[s * 4] & 255, 0); assert.equal(bank[s], 0); }
}
owner.sync();
assert(!calls.some(c => c.name === 'v2import' && c.opts.params.full === 1), 'a residency shift never reimports projected whole-grid state');
await shiftNative(-16, 0);
const window = Object.assign(Object.create(WorldWindow.prototype), { sim, nativeStore: stored });
assert.equal(window.restoreNative([0, 0, 0], [4, 8, 8]), 256);
assert.equal(stored.size, 0);
assert.deepEqual(core, originalCore, 'round-trip window preserves every fractional/flux/payload word');
assert.deepEqual(bank, originalBank, 'round-trip window preserves negative/arbitrary energy banks');

// Every signed world axis uses the same exact out-of-place mapping.
for (const [dx, dz] of [[-16, 0], [0, 16], [0, -16]]) {
  const lo = [dx < 0 ? 16 : 0, 0, dz < 0 ? 16 : 0];
  const bricks = [dx ? 4 : 8, 8, dz ? 4 : 8];
  const leaving = await sim.nativeIntegration.captureSlab(lo, bricks);
  await shiftNative(dx, dz); await shiftNative(-dx, -dz);
  sim.nativeIntegration.restoreBricks(lo, bricks, leaving.map((bytes, index) => ({ index, bytes })));
  assert.deepEqual(core, originalCore); assert.deepEqual(bank, originalBank);
}

// Real asynchronous boundary: no core shift, origin movement, tools or ticks
// until dynamics has rebased its local air/claims. World particle words remain its own.
const oldShift = owner.dynamics.shiftWindow;
let finishShift;
owner.dynamics.shiftWindow = () => new Promise(resolve => { finishShift = resolve; });
const oldOrigin = sim.origin.x, oldTick = owner.tick, oldCore = core.slice();
const inFlightShift = shiftNative(16, 0);
assert(sim.nativeTransition);
assert.equal(nativeHostSteps(owner, 1, { keepAlive: true }), 0);
assert.equal(nativeReadiness(sim, { world: true }).ready, false);
assert.equal(sim.applyNativeTool({ kind: 'impulse' }), false);
assert.equal(sim.origin.x, oldOrigin); assert.equal(owner.tick, oldTick); assert.deepEqual(core, oldCore);
finishShift(); await inFlightShift;
assert.equal(sim.nativeTransition, null); assert.equal(sim.origin.x, oldOrigin + 16);
owner.dynamics.shiftWindow = oldShift;
await shiftNative(-16, 0);
sim.nativeIntegration.restoreBricks([0, 0, 0], [4, 8, 8], slab.map((bytes, index) => ({ index, bytes })));
assert.deepEqual(core, originalCore); assert.deepEqual(bank, originalBank);

// Sparse restoration touches only selected bricks (raw slab order differs
// from the compact brick's internal y/z bit order).
const sparse = encodeNativeBrick(Uint32Array.from({ length: 256 }, (_, i) => [E.WATER | (1173 << 8), 123, 0xbc003c00, 0xffff3800][i % 4]), new Int32Array(64).fill(-123));
sim.nativeIntegration.restoreBricks([0, 0, 0], [2, 2, 2], [{ index: 5, bytes: sparse }]);
for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
  const s = cellSlot(g, x, y, z), changed = x >= 4 && y < 4 && z >= 4;
  assert.equal(core[s * 4], changed ? (E.WATER | (1173 << 8)) : originalCore[s * 4]);
  assert.equal(bank[s], changed ? (-123 >>> 0) : originalBank[s]);
}
assert.deepEqual(decodeNativeBrick(sparse).bank, new Int32Array(64).fill(-123));

// Shifted undo preserves the part outside the old snapshot, never imports
// legacy whole cells before the native merge.
const snapCore = buffer({ size: bytes }), snapBank = buffer({ size: g.slots * 4 });
words(snapCore).set(originalCore); words(snapBank).set(originalBank);
const beforeUndo = core.slice(), beforeBank = bank.slice();
sim.nativeIntegration.undo(snapCore, snapBank, 16, 0);
for (let s = 0; s < g.slots; s++) {
  const q = slotCell(g, s); q[0] += 16; const from = inside(q) ? slot(q) : s;
  assert.equal(core[s * 4 + 1], (inside(q) ? originalCore : beforeUndo)[from * 4 + 1]);
  assert.equal(bank[s], (inside(q) ? originalBank : beforeBank)[from]);
}

// Tree stamps are clipped at the dispatch box, not only by a shader mask:
// legacy ownership may claim unchanged cells inside a dispatched edit.
const edits = [];
sim.editKernel = () => ({ ready: Promise.resolve() });
sim.edit = (kernel, box, values) => { edits.push({ box, values }); sim.version++; };
const stamper = new Stamper(sim);
stamper.stamp([{ s: { w: 8, h: 4, d: 8, foot: 0, data: new Uint32Array(8 * 4 * 8 * 4) }, at: [12, 2, 3], seed: 1 }],
  { clip: { lo: [16, 0, 0], hi: [31, 31, 31] } });
assert.deepEqual(edits.at(-1).box, { lo: [16, 2, 3], hi: [19, 5, 10] });

// Real PhysicsV2 owner + host orchestration: 60 weather/script invocations,
// paired immediately around each native tick, and bounded catch-up.
owner.acc = 0; owner.certified = false;
let before = 0, after = 0, weatherTime = 0;
const startTick = owner.tick, startFrame = sim.frame;
for (let i = 0; i < 60; i++) nativeHostSteps(owner, 1 / 60, { keepAlive: true,
  before: () => { before++; weatherTime += 1 / 60; assert.equal(after, before - 1); },
  after: () => { after++; assert.equal(before, after); } });
assert.equal(owner.tick - startTick, 60); assert.equal(sim.frame - startFrame, 60);
const directTick = owner.tick; sim.step();
assert.equal(owner.tick, directTick + 1); assert.equal(sim.compact, owner, 'Simulation.step cannot silently fall back to v1');
assert(Math.abs(weatherTime - 1) < 1e-12); assert.equal(before, 60); assert.equal(after, 60);
assert.equal(nativeHostSteps(owner, 30, { keepAlive: true }), 2); assert.equal(owner.acc, 0);
assert.equal(nativeHostSteps(owner, 1 / 120, { keepAlive: true }), 0);
assert.equal(nativeHostSteps(owner, 1 / 120, { keepAlive: true }), 1);
assert.throws(() => nativeHostSteps(owner, NaN));
owner.certified = true;
assert.equal(nativeHostSteps(owner, 1), 0);
assert.equal(nativeHostSteps(owner, 0, { once: true }), 1, 'manual step works at rest');

// Real host paint entrypoint routes a guest intent into its current owner,
// bounded edits only. No guest simulation and no protocol migration.
const fullBefore = sim.wholeWrites;
applyGuestStroke(sim, { c: [3, 4, 5], r: 999, shape: 0, tool: E.SAND, rate: 1, replace: false });
assert.equal(edits.at(-1).values.radius, 24); assert.equal(sim.compact, owner);
assert.equal(sim.wholeWrites, fullBefore);
owner.sync(); assert.equal(calls.at(-1).name, 'v2import'); assert.equal(calls.at(-1).opts.params.full, 0);
const packer = createPacker(); const packet = await packer.pack(sim);
assert.equal(calls.findLast(c => c.name === 'pack').opts.header.format, 2, 'actual host codec uses direct compact projection');
const frame = await encodeFrame(FRAME_KEY, 9, packet.dims, packet.bytes), decoded = await decodeFrame(frame);
assert.equal(decoded.kind, FRAME_KEY); assert.deepEqual(decoded.body, packet.bytes); packet.release();
const unpacker = createUnpacker(); const tickBeforeGuest = owner.tick;
await unpacker.unpack(sim, decoded.body);
assert.equal(sim.compact, null, 'render-only unpack suspends a retained native owner');
assert.equal(owner.tick, tickBeforeGuest, 'guest decoder never steps');
owner.activate();

// Native requests use WORLD cells, SI delta-v and deterministic tick counts.
sim.origin.x = 128; sim.origin.z = 256;
assert.deepEqual(worldPosition(sim, [1, 2, 3]), [129, 2, 259]);
assert(nativeImpulse(sim, { position: [1, 2, 3], direction: [3, 0, 0], radius: 4, acceleration: 12, dt: 1 / 60 }));
assert.equal(requests.at(-1).strength, 0.2); assert.deepEqual(requests.at(-1).direction, [1, 0, 0]);
assert.deepEqual(requests.at(-1).position, [129, 2, 259]);
owner.dynamics.applyToolImpulse = () => undefined;
assert.equal(sim.applyNativeTool({ kind: 'impulse' }), false, 'undefined/no-op is never accepted');
owner.dynamics.applyToolImpulse = r => { requests.push(r); return { status: 'queued' }; };
const photon = TOOLS.find(t => t.key === 'PHOTON').id;
const stroke = { tool: photon, center: { x: 1, y: 2, z: 3 }, radius: 1, shape: 1, rate: 0.007 };
requests.length = 0; sim.nativeEmission = undefined;
for (let i = 0; i < 60; i++) assert(emitNativeRay(sim, stroke, 1 / 60));
const emitted = requests.reduce((n, r) => n + r.count, 0);
requests.length = 0; sim.nativeEmission = undefined;
for (let i = 0; i < 120; i++) assert(emitNativeRay(sim, stroke, 1 / 120));
assert.equal(requests.reduce((n, r) => n + r.count, 0), emitted);
assert(requests.every(r => r.count > 0 && Number.isInteger(r.count)));
assert.equal(sim.nativeCapabilities.physgun, false, 'generic impulse cannot advertise working physgun hold');
owner.dynamics.capabilities.drawReady = false;
assert.equal(sim.nativeCapabilities.photon, true, 'photons are physics: their sprites building never refuses the tool');
assert.equal(sim.nativeCapabilities.neutron, true);
owner.dynamics.capabilities.drawReady = true;
// A line of photons is V1's: each dab painted once, ceil(volume x RAY_PAINT_PER_CELL x rate) a dab.
{
  const { RAYS } = await import('../../src/rays.js');
  const { strokeDabs } = await import('../../src/editing.js');
  const { isRayShape } = await import('../../src/v2/tools.js');
  const line = { tool: photon, center: { x: 1, y: 2, z: 3 }, end: { x: 21, y: 2, z: 3 }, radius: 2, shape: 0, rate: 1 };
  assert(isRayShape(line) && !isRayShape(stroke) && !isRayShape({ ...stroke, end: stroke.center }));
  requests.length = 0;
  assert(emitNativeRay(sim, line));
  const dabs = strokeDabs(line.center, line.end, undefined, line.radius), each = Math.min(RAYS.RAY_PAINT_MAX, Math.ceil(4 / 3 * Math.PI * 8 * RAYS.RAY_PAINT_PER_CELL));
  assert(dabs.length > 1);
  assert.deepEqual(requests.map(r => r.position[0]), dabs.map(c => c.x + sim.origin.x), 'one request a dab, along the whole line');
  assert(requests.every(r => r.count === each && r.kind === 'photon'));
  requests.length = 0;
  assert(Simulation.prototype.paint.call(sim, { ...line, tool: TOOLS.find(t => t.key === 'NEUTRON').id }), 'sim.paint keeps the line too');
  assert.equal(requests.length, dabs.length); assert(requests.every(r => r.kind === 'neutron'));
}
// Not ready yet (dynamics still building): native tool requests wait, bounded, then run in order. Never a refusal or V1.
{
  requests.length = 0;
  owner.dynamics.capabilities.physicsReady = false;
  assert.equal(sim.nativeCapabilities.impulse, false);
  const wind = TOOLS.find(t => t.key === 'WIND').id;
  assert.equal(sim.paint({ center: { x: 1, y: 2, z: 3 }, radius: 2, tool: wind, wind: [0, 0, 2] }), true, 'wind before the dynamics are ready is held, not thrown');
  sim.nativeEmission = undefined;
  assert(emitNativeRay(sim, { ...stroke, radius: 6, rate: 1 }), 'a held photon brush is held too');
  assert.equal(requests.length, 0); assert.equal(sim.nativePending.length, 2);
  assert.equal(sim.flushNativeTools(), 0, 'nothing runs before readiness');
  let accepted = 0; while (sim.applyNativeTool({ kind: 'impulse', position: [0, 0, 0], direction: [0, 1, 0], radius: 1, strength: 1 })) accepted++;
  assert.equal(sim.nativePending.length, accepted + 2, 'the wait is bounded');
  owner.dynamics.capabilities.physicsReady = true;
  assert.equal(sim.flushNativeTools(), accepted + 2); assert.equal(sim.nativePending.length, 0);
  assert.equal(requests[0].kind, 'impulse'); assert.deepEqual(requests[0].direction, [0, 0, 1], 'the wind went first, as painted');
  assert.equal(requests[1].kind, 'photon');
  requests.length = 0;
}
const nativeEdits = edits.length;
sim.paint({ center: { x: 1, y: 2, z: 3 }, radius: 2, tool: TOOLS.find(t => t.key === 'WIND').id, wind: [1, 0, 0] });
assert.equal(edits.length, nativeEdits, 'live native wind never writes legacy velocity or reimports liquid cells');
assert.deepEqual(requests.at(-1).position, [129, 2, 259]);

// Exact cargo payloads survive CPU readback, JSON persistence and re-upload.
const raw = new Uint32Array(9); new Float32Array(raw.buffer).set([E.WATER, 22, 0, 0]);
raw.set([E.WATER | (1181 << 8), 1, 0xff800001, 0xdeadbeef, 0xffffffff], 4);
const reply = decodeNativeTransfer(raw.buffer, 1), cell = cellOf(reply, 0);
assert(nativeCargo(cell)); assert.equal(cell.length, 9); assert.equal(cell[5], 1); assert.equal(cell[8], 0xffffffff);
assert.deepEqual(JSON.parse(JSON.stringify(cell)), cell);
const transfer = new NativeTransfer(sim);
await transfer.run({ count: 1, limit: 1, mode: 1, cells: [[1, 1, 1, -1]], items: [cell] });
const dispatch = calls.findLast(c => c.name === 'nativeTransfer');
const upload = words(dispatch.opts.bind[2].entries[3].resource.buffer);
assert.deepEqual([...upload.subarray(0, 4)], cell.slice(4, 8)); assert.equal(upload[4], 0xffffffff); assert.equal(upload[5], 1);
assert.equal(dispatch.opts.header.capture, 0, 'native transfer never claims lossy legacy ownership');
assert(!calls.slice(calls.lastIndexOf(dispatch) + 1).some(c => c.name === 'v2import'), 'no whole-grid transfer reimport');

// The actual shared bucket/pump CPU engine, backed by the independent
// atomic transfer reference above: duplicate candidates, hidden one-quantum
// water, blocked output, reservations and bank-exact eventual deposition.
core.fill(0); bank.fill(0);
const from = cellSlot(g, 4, 5, 6), to = cellSlot(g, 7, 8, 9), other = cellSlot(g, 10, 10, 10);
const material = [E.WATER | (1181 << 8), 1 | (17 << 24), 0x7fff1234, 0xdeadbeef];
core.set(material, from * 4); bank[from] = 0xffffff80;
core.set(material, other * 4); bank[other] = 0x87654321;
const bucket = new Load(4), engine = createTransfer({ getSim: () => sim });
const taken = engine.take(bucket, { cells: [[4, 5, 6], [4, 5, 6]], kinds: [K.LIQUID], limit: 2 });
assert(taken); assert.equal(bucket.reserved, 2);
assert.equal((await taken).length, 1); assert.equal(bucket.reserved, 0);
assert.equal(core[from * 4] & 255, 0); assert.equal(bank[from], 0);
assert.deepEqual(bucket.cells[0].slice(4, 8), material); assert.equal(bucket.cells[0][8], 0xffffff80);
assert.equal(await engine.put(bucket, { cells: [[10, 10, 10]] }), 0, 'blocked put returns exact cargo to load');
assert.equal(bucket.cells.length, 1); assert.equal(bank[other], 0x87654321);
const put = engine.put(bucket, { cells: [[7, 8, 9], [7, 8, 9]] });
assert.equal(bucket.out, 1); assert.equal(await put, 1); assert.equal(bucket.out, 0); assert.equal(bucket.cells.length, 0);
assert.deepEqual([...core.subarray(to * 4, to * 4 + 4)], material); assert.equal(bank[to], 0xffffff80);
assert.deepEqual([...core.subarray(other * 4, other * 4 + 4)], material, 'untouched fractional material is bit-exact');

// Folded-terrain band stores currently carry only the legacy projection.
// Refuse before examining that store or changing exact native authority.
assert(sim.compactOwner);
const terrainCore = core.slice(), terrainBank = bank.slice();
let terrainTouched = false;
const terrainWindow = { sim, get loaded() { terrainTouched = true; throw new Error('legacy terrain touched'); } };
await assert.rejects(WorldWindow.prototype.captureEdits.call(terrainWindow), /Native terrain edit capture is not supported/);
await assert.rejects(WorldWindow.prototype.restoreEdits.call(terrainWindow, {}), /Native terrain edit restore is not supported/);
assert.equal(terrainTouched, false);
assert.deepEqual(core, terrainCore); assert.deepEqual(bank, terrainBank);

// main's World renderer keeps its own copy of the cells, from the live A/B
// (src/world/renderSource.js). On a V2 world those are V2's lazy projection:
// a tick reaches the copy through an export of only the bricks it changed,
// recorded before the copy reads A/B. Nothing ticked: nothing exported.
{
  const realCopy = gpu.frame.copy;
  gpu.frame.copy = function (...args) { calls.push({ name: 'copy' }); return realCopy.apply(this, args); };
  const win = { sim, gpu, epoch: 1, size: [sim.origin.x + g.nx, g.ny, sim.origin.z + g.nz], scene: {} };
  const source = sim.worldRenderSource = new WorldRenderSource(win);
  source.recordLiveCopy(gpu.frame);
  assert.equal(source.needsLiveCopy(), false);
  owner.ticks(1);
  assert(source.needsLiveCopy(), 'a V2 tick is a live content change');
  calls.length = 0;
  source.recordLiveCopy(gpu.frame);
  const bridge = calls.findIndex(c => c.name === 'v2bridge'), copy = calls.findIndex(c => c.name === 'copy');
  assert(bridge >= 0 && bridge < copy, 'the export is recorded before the copy');
  assert.equal(calls.filter(c => c.name === 'v2bridge').length, 1);
  assert.equal(calls[bridge].opts.params.full, 0, 'only the bricks the tick changed');
  assert.equal(calls[bridge].opts.header.format, 0, 'the drawn projection, as the Box draws it');
  calls.length = 0;
  assert.equal(source.needsLiveCopy(), false);
  source.recordLiveCopy(gpu.frame);
  assert(!calls.some(c => c.name === 'v2bridge'), 'nothing ticked: nothing to export');
  // Planted trees are a bounded write: V2 imports the marked bricks, not the window.
  const whole = sim.wholeWrites, version = sim.version;
  const planter = { sim, gpu, wb: [win.size[0] / 4, 1, win.size[2] / 4], planted: new Uint8Array(win.size[0] * win.size[2] / 16), plantCost: null,
    renderSource: { token: () => ({}) }, sourceProducer: { record: () => ({ trees: 1 }) } };
  assert.equal(WorldWindow.prototype.plant.call(planter, [0, 0, 0], [g.nx, g.ny, g.nz]), 1);
  assert.equal(sim.wholeWrites, whole); assert.equal(sim.version, version + 1);
  calls.length = 0; owner.sync();
  assert.equal(calls.find(c => c.name === 'v2import').opts.params.full, 0, 'a tree stamp never reimports the whole window');
  sim.worldRenderSource = null; source.dispose(); gpu.frame.copy = realCopy;
}

const app = readFileSync('src/app.js', 'utf8');
assert(app.includes("let physicsMode = params.get('physics') === 'v2' ? 'v2' : 'v1'"), 'v1 remains default');
assert(!app.includes("if (mode === 'v2' && !physicsV2 && !worldMode)"), 'no world-only v1 fallback');
assert(app.includes('before: nativeBeforeStep'), 'automatic and manual native steps retain weather hooks');
assert(readFileSync('src/gfx/volume.js', 'utf8').includes('pickGroup], header: sim.readHeader({ physical: true })'));
console.log('native integration CPU checks passed: exact shifts/slabs/undo/cargo, store corruption, stamp clipping, 60Hz orchestration, capability guards, host engine/guest routing/direct codec, SI tools');
