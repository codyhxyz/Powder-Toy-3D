// CPU-only: a runtime V2 -> V1 switch carries the Factory and the tools' cargo.
// Drives the real transfer engine (pov/tools/transfer.js -> pov/gpu.js) and the
// real engine retag (industry/engineSwitch.js) over a fake GPU. No browser.
//   - cargo V2 took (nativeCargo: display fields + raw native words) goes into
//     V1's cells as V2's own V1 export gives it, liquid counted by fill: no
//     throw, no mass made or lost (the rest of a cell waits in the load);
//   - a gate closed and a pump built under V2 get V1's ownership tags back on
//     the switch, so V1's kernels own them (the gate is CLOSED, not DAMAGED).
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { createTransfer, Load, legacyCargo } from '../../src/pov/tools/transfer.js';
import { nativeCargo } from '../../src/v2/transfer.js';
import { createEngineRetag, retagEdits, RETAG_EDIT } from '../../src/industry/engineSwitch.js';
import { gateGeometry, GATE_OWNER_MARKER, GATE_OWNER_MARKER_NATIVE } from '../../src/industry/gates.js';
import { PUMP_BACKPLATE_TAG, pumpBackplateCells } from '../../src/industry/pumpStructure.js';
import { PUMP_BACKPLATE_TAG_NATIVE } from '../../src/industry/construction.js';
import { FULL } from '../../src/v2/layout.js';
import { editKernelWGSL } from '../../src/shaders/common.js';
import { uniformStruct } from '../../src/gpu/params.js';
import { EDIT_FIELDS } from '../../src/shaders/common.js';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { assertNaga } from './wgsl-grouping.mjs';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1 };
const g = gridLayout(32, 32, 32);

// ---- cargo
// A V2 take's item: [id, T, life, ctype] (compactProbeA) then core x/y/z/w and the bank (v2/transfer.js).
const nativeWater = (fill, T = 20) => [E.WATER, T, 0, 3, E.WATER | (Math.round((T + 273.25) * 4) << 8), fill | (3 << 24), 0x3c003c00, 0x00010000, 0x89abcdef];
assert(nativeCargo(nativeWater(0x6000)), 'the fixture is real native cargo');
const fillOf = load => load.cells.reduce((n, c) => n + (c.length > 4 ? c[5] & 0xffffff : FULL), 0)
  + [...(load.legacyCarry?.values() ?? [])].reduce((n, l) => n + l.fill, 0);

// The V1 transfer engine's dispatch, recorded: what V1's povTransfer kernel would place.
const dispatched = [];
const ring = { buffer: {}, next: () => 0, read: () => Promise.resolve(new Float32Array(1024).fill(-1)) };
const gpu = {
  layout: (name, entries) => entries, createBuffer: d => ({ ...d }), bindGroup: (layout, entries) => ({ layout, entries }),
  kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(), dispatch(f, size, opts) { dispatched.push({ name, opts }); } }),
  readback: { ring: () => ring },
};
const sim = { id: 1, gpu, g, L: { TABLES: [], STATE_RW: [] }, tables: {}, bindRW: {}, compact: null, compactOwner: {},
  header: () => ({}), wake() {}, version: 0, _dispatch(k, size, opts) { k.dispatch(null, size, opts); } };
const transfer = createTransfer({ getSim: () => sim });

// A pump's load after V2 took eight part-full cells (16-cell pump load, industry/physics.js machineState)
const pump = new Load(16);
const fills = [0x6000, 0x6000, 0x6000, 0x6000, 0x8000, 0x8000, 0x10000, 0x4000];   // 3.75 cells of water in all
pump.cells = fills.map((f, i) => nativeWater(f, 20 + i));
const mass = fillOf(pump);
assert.equal(mass, 3.75 * FULL);
// the switch to V1: sim.compact is gone (PhysicsV2.suspend keeps compactOwner)
let threw = null, placing = null;
try { placing = transfer.put(pump, { cells: Array.from({ length: 8 }, (_, i) => [i, 4, 0]), max: 8, vel: [0, 0, 0] }); } catch (e) { threw = e; }
assert.equal(threw, null, 'placing V2 cargo under V1 does not throw');
const put = dispatched.at(-1);
assert.equal(put?.name, 'povTransfer', 'V1 places it with its own transfer kernel');
const items = put.opts.params.items;
assert(items.every(c => c.length === 4), 'V1 gets V1 cells');
assert.equal(items.length, 3, 'liquid is counted by fill: 3.75 cells are 3 whole cells');
assert(items.every(c => c[0] === E.WATER));
const T = fills.reduce((n, f, i) => n + f * (20 + i), 0) / fills.reduce((n, f) => n + f, 0);
assert(items.every(c => Math.abs(c[1] - T) < 1e-9), 'at the fill-weighted temperature');
assert.equal(pump.legacyCarry.get(E.WATER).fill, 0.75 * FULL, 'the rest of a cell waits in the load');
assert.equal(fillOf(pump) + pump.out * FULL, mass, 'every fill is accounted for: placing, or waiting');
assert.equal(await placing, 0, '(the fixture\'s outlet takes none)');
assert.equal(fillOf(pump), mass, 'what did not land comes back: no fill made or lost');
// more V2 cargo later (or a switch back and forth) joins the carry
pump.cells.push(nativeWater(0x4000, 30));
legacyCargo(pump);
assert.equal(pump.cells.length, 4, 'a quarter more makes the fourth whole cell');
assert.equal(pump.legacyCarry.size, 0); assert.equal(fillOf(pump), mass + 0x4000);
// a non-liquid's cargo is its display fields (what V2's export gives the cell)
const pack = new Load(64);
const sand = [E.SAND, 40, 0, 7.5, E.SAND | (1250 << 8), 7 << 16, 0, 0, 0];
pack.cells = [sand]; legacyCargo(pack);
assert.deepEqual(pack.cells, [[E.SAND, 40, 0, 7.5]]);
// V2 still steps the grid: cargo stays exact; a carry left from V1 comes out as whole cells only
const back = new Load(16); back.cells = [nativeWater(0x6000)]; back.legacyCarry = new Map([[E.WATER, { fill: FULL + 5, heat: 25 * (FULL + 5), life: 0, ctype: 3 }]]);
legacyCargo(back, { native: true });
assert.equal(back.cells.length, 2); assert.deepEqual(back.cells[0], nativeWater(0x6000), 'native cargo is untouched under V2');
assert.equal(back.cells[1].length, 4); assert.equal(back.legacyCarry.get(E.WATER).fill, 5);
// pure V1 (V1's own 4-word cells) is unchanged
const v1 = new Load(16); v1.cells = [[E.WATER, 20, 0, 0.5]]; const v1Version = v1.version;
legacyCargo(v1); assert.deepEqual(v1.cells, [[E.WATER, 20, 0, 0.5]]); assert.equal(v1.version, v1Version);
console.log('PASS V2 cargo under V1: no throw, V1 cells, liquid by fill (no mass made or lost), V2 cargo exact while V2 runs');

// ---- ownership tags
const gate = { id: 'g', type: 'gate', x: 4, y: 4, z: 4, rotation: 1 };
const pumpDevice = { id: 'p', type: 'pump', x: 16, y: 4, z: 8, rotation: 2 };
const edits = [];
let kernelState = 'pending';
const tsim = { compact: {}, compactOwner: {}, editKernel: (name, spec) => ({ name, spec, main: { get state() { return kernelState; } } }),
  edit: (kernel, box, values) => edits.push({ kernel, box, values }) };
const retag = createEngineRetag({ getSim: () => tsim });
assert.equal(retag.update([gate, pumpDevice]), true); assert.equal(edits.length, 0, 'nothing while V2 runs');
tsim.compact = null;   // V2 -> V1
assert.equal(retag.update([gate, pumpDevice]), false, 'the machines wait for the retag kernel');
assert.equal(edits.length, 0);
kernelState = 'ready';
assert.equal(retag.update([gate, pumpDevice]), true);
assert.equal(edits.length, 2, 'one retag edit a tagged machine');
assert.equal(retag.update([gate, pumpDevice]), true); assert.equal(edits.length, 2, 'once a switch');
// the edits' boxes hold exactly the machines' tagged cells, and the tags V1 owns
const inBox = (p, { lo, hi }) => p.every((v, a) => v >= lo[a] && v <= hi[a]);
const box3 = ({ lo, hi }) => (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
const leaf = gateGeometry(gate, g).aperture, plate = pumpBackplateCells(pumpDevice);
const [gateEdit, plateEdit] = edits;
assert(leaf.every(p => inBox(p, gateEdit.box)) && box3(gateEdit.box) === leaf.length, 'the gate retag covers its 12-cell leaf only');
assert.deepEqual(gateEdit.values, { tagId: E.WALL, fromTag: GATE_OWNER_MARKER_NATIVE, toTag: GATE_OWNER_MARKER });
assert(plate.every(p => inBox(p, plateEdit.box)) && box3(plateEdit.box) === plate.length, 'the pump retag covers its backplate only');
assert.deepEqual(plateEdit.values, { tagId: E.TUNGSTEN, fromTag: PUMP_BACKPLATE_TAG_NATIVE, toTag: PUMP_BACKPLATE_TAG });
// V1's gate (gates.js gateOwned: WALL and A.z == GATE_OWNER_MARKER) then owns all 12: CLOSED, not DAMAGED.
// CPU spec of RETAG_EDIT's update over the V2 export of a closed leaf (shaders/compact.js compactA life):
const exported = leaf.map(() => ({ id: E.WALL, z: GATE_OWNER_MARKER_NATIVE }));
const retagged = exported.map(a => (a.id === gateEdit.values.tagId && a.z === gateEdit.values.fromTag ? { ...a, z: gateEdit.values.toTag } : a));
assert(exported.every(a => a.z !== GATE_OWNER_MARKER), 'before: V1 owned none of the leaf (DAMAGED)');
assert.equal(retagged.filter(a => a.id === E.WALL && a.z === GATE_OWNER_MARKER).length, 12, 'after: V1 owns the whole leaf (CLOSED)');
assert(RETAG_EDIT.update.includes('eid(a) == P.tagId && a.z == P.fromTag') && RETAG_EDIT.update.includes('(*oA).z = P.toTag'));
// V1 -> V2 needs nothing (V1's tags import to exactly V2's), and back on V2 before the kernel builds owes nothing
const r2 = createEngineRetag({ getSim: () => tsim }); edits.length = 0;
tsim.compact = null; r2.update([gate]); tsim.compact = {}; assert.equal(r2.update([gate]), true); assert.equal(edits.length, 0);
assert.deepEqual(retagEdits([{ type: 'belt', x: 0, y: 0, z: 0, rotation: 0 }]), [], 'untagged machines are left alone');
// the kernel is valid WGSL as sim.editKernel builds it
const struct = uniformStruct('IndustryRetagParams', { ...EDIT_FIELDS, ...RETAG_EDIT.params });
assertNaga(editKernelWGSL(g, { update: RETAG_EDIT.update, params: struct, reads: RETAG_EDIT.reads }), 'industryRetag');
assert.equal(ELEMENTS[E.WALL].kind, K.SOLID);
console.log('PASS V2 -> V1: gate leaf and pump backplate get V1\'s ownership tags once, before the machines step; naga-valid');
