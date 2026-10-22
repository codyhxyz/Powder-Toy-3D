// CPU only (no GPU, no browser): V2's native cell writers and readers (the v2f/writers workstream).
// Part A executes the production WGSL on CPU through scalar adapters (as edit-intent-check does):
// V1's brush rule (passes.js update), then the native edit's own decision (nativePaint.js
// nativeEditChange) and commit (nativeEditCommit, nativeNewCell) on real native cell words, the
// energy arithmetic by the CPU twin (src/v2/layout.js). Part B drives the real Simulation and a real
// PhysicsV2 on a recording GPU (integration-check style): every writer and reader records only its
// native kernels (the brush's evaluate and commit executed by Part A's functions on the buffers'
// bytes), never V1's export (v2bridge) or the import (v2import), and leaves a liquid pool's fill,
// flux, fall words and banks bit-exact wherever the rule didn't change them. Not a GPU emulator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, gridLayout, cellTexel } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { nativePaintWGSL, nativePaintParams, nativeEditSpec, nativeEditParams, NATIVE_PAINT_FLAG as F, NATIVE_PAINT_PARTICLE as PF } from '../../src/v2/nativePaint.js';
import { paintUpdateWGSL } from '../../src/shaders/passes.js';
import { BUILD_STAMP_KERNEL, buildStampWriter } from '../../src/shaders/construction.js';
import { IMPORTED_DOOR_EDIT, IMPORTED_DOOR_MOTION_EDIT, IMPORTED_DOOR_MOVE_HOOK, importedDoorWriter } from '../../src/pov/importedInteractions.js';
import { nativeIdsWGSL, nativeRectToAtlasWGSL } from '../../src/v2/nativeRead.js';
import { runFill, PROP } from '../../src/editing.js';
import { cityBusArrivalClear } from '../../src/pov/village/bus.js';
import { v2Rows, V2 } from '../../src/shaders/v2.js';
import { cellSlot, marksLayout } from '../../src/shaders/common.js';
import { E, ELEMENTS, TOOLS, PROP_TOOL } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
import * as L from '../../src/v2/layout.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(32, 32, 32), tools = Object.fromEntries(TOOLS.map(t => [t.key, t.id])), rows = v2Rows();
// ---- the WGSL, executed: function bodies to JS ----
function body(code, name) {
  const start = code.indexOf('{', code.indexOf(`fn ${name}(`));
  assert(start >= 0, `fn ${name}`); let depth = 1, end = start + 1;
  for (; depth; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return code.slice(start + 1, end - 1);
}
const scalar = s => s.replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1').replace(/\bvar\b/g, 'let')
  .replace(/\(\*o([AB])\)/g, 'o$1').replace(/\*o([AB])/g, 'o$1').replace(/&rs/g, 'rs');
const vec = (x = 0, y = x, z = x, w = x) => ({ x, y, z, w });
const roundEven = x => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1; };   // WGSL round
const params = nativePaintParams();
const evalCode = nativePaintWGSL(g, params, 'evaluate'), commitCode = nativePaintWGSL(g, params, 'commit');
const ctx = {
  ...PHYS, ...Object.fromEntries(Object.entries(E).map(([k, v]) => [`E_${k}`, v])), ...Object.fromEntries(TOOLS.map(t => [`T_${t.key}`, t.id])),
  ...Object.fromEntries(Object.entries(PROP).map(([k, v]) => [`PROP_${k}`, v])),
  f32: Number, i32: Math.trunc, u32: x => Math.trunc(x) >>> 0, max: Math.max, min: Math.min, abs: Math.abs, round: roundEven, floor: Math.floor,
  fract: x => x - Math.floor(x), clamp: (x, a, b) => Math.max(a, Math.min(b, x)), select: (a, b, c) => (c ? b : a),
  smoothstep: (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); },
  vec4f: vec, V3: (a = 0, b = a, c = a) => [a, b, c], eid: a => Math.floor(a.x + 0.5), same: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w,
  bcU32: i => i >>> 0, bcI32: u => u | 0,
  // V1's brush helpers the dabs below don't exercise: no random draw (every spawn lands), air at 20 °C
  seed3: () => 0, rnd: () => 0, slotOf: () => 0, airT: () => 20, SALT_PAINT: 0, SEED_MAX: 0.999, BRUSH_EDGE_EPS: 0.001,
  SPAWNDENS: () => 1, SPAWNT: () => 20, SPAWNLIFE: () => 0, isLoose: () => false, physicalCtype: (_id, w) => Math.floor(w),
  sparkCell: a => { a.w = 3 + (a.w - Math.floor(a.w)); return true; }, mixCell: () => {},   // (Mix's pairing: native-paint-check; its move: SWAP below)
  // the native head's, by the CPU twin
  FULLU: L.FULL, C_AIR: V2.AIR, C_LIQUID: V2.LIQUID, C_GAS: V2.GAS, cls: id => rows[id].cls, fadeOf: id => rows[id].fade,
  cid: L.cid, cFill: L.cFill, isLiq: c => L.isLiquid(L.cid(c)), conductsNative: L.isConductor,
  makeMaterial: (id, T, amount, ct) => L.makeMaterial(id, T, Math.min(amount, L.MAX_FILL), ct),
  withLife: (c, v) => L.withPayload({ core: c, bank: 0 }, Math.max(0, Math.min(65535, Math.round(v * L.lifeScale(L.cid(c)))))).core,
  withCtype: (c, v) => { const n = new Uint32Array(c), mask = ELEMENTS[L.cid(c)].burnRate > 0 ? 127 : 255; n[1] = L.isLiquid(L.cid(c)) ? (n[1] & ~(mask << 24)) | ((v & mask) << 24) : (n[1] & 0xff00ffff) | ((v & 255) << 16); return n; },
  withSpark: (c, v) => { const n = new Uint32Array(c); if (L.isLiquid(L.cid(c))) n[3] = (n[3] & 0xf000ffff) | ((v & 4095) << 16); else n[3] = (n[3] & 0xfffff000) | (v & 4095); return n; },
  Material: (core, bank) => ({ core: new Uint32Array(core), bank }), capacityQ: L.capacityQ, energyOf: L.energyOf, energyFits: L.energyFits, withEnergy: L.withEnergy,
  energyMul: (a, b) => BigInt(a) * BigInt(b), energyAdd: (a, b) => a + b, energyNeg: a => -a,
};
const fnOf = (code, name, args, fix = s => s) => new Function('ctx', ...args, `with(ctx) { ${fix(scalar(body(code, name)))} }`);
const v1Update = new Function('ctx', 'p', 'a', 'b', `with(ctx) { let oA={...a},oB={...b}; ${scalar(body(paintUpdateWGSL, 'update'))
  .replace('vec3f(p) + 0.5 - P.center', 'vec4f(0)').replaceAll('return;', 'return {oA,oB};')}; return {oA,oB}; }`);
const changeFn = fnOf(evalCode, 'nativeEditChange', ['a', 'outA', 'owned'], s => s.replace('all(outA==a)', 'same(outA,a)').replace(/vec3u\(/g, 'V3(').replace('bitcast<u32>(', 'bcU32('));
const commitFn = fnOf(commitCode, 'nativeEditCommit', ['r', 'before'], s => s.replace('let m=before;', 'let m={core:new Uint32Array(before.core),bank:before.bank};').replace('bitcast<i32>(', 'bcI32('));
const newCellFn = fnOf(commitCode, 'nativeNewCell', ['a', 'amount'], s => s.replace('m.core.w=', 'm.core[3]='));
ctx.nativeNewCell = (a, amount) => newCellFn(ctx, a, amount);
// the physical view of a core (shaders/compact.js compactProbeA: a quantum of liquid is liquid), seed 0
const project = c => {
  const id = L.cid(c), liquid = L.isLiquid(id);
  if (id === E.EMPTY || (liquid && L.cFill(c) === 0)) return vec(0, L.cTq(c) * 0.25 - 273.25, 0, 0);
  return vec(id, L.cTq(c) * 0.25 - 273.25, L.isConductor(id) && liquid ? 0 : L.payloadOf(c) / L.lifeScale(id), L.ctypeOf(c));
};
// One cell through V1's rule and the native edit: the cell it leaves (null: unchanged).
function paintCell(P, m, distance = 0) {
  let owned = false;
  Object.assign(ctx, { P: { radius: 2, center: vec(), frame: 1, filter_: -1, del: 0, replace: 0, rate: 1, prop: 0, propValue: 0, ...P }, strokeDist: () => distance, ownLegacy: () => { owned = true; } });
  const a = project(m.core), { oA } = v1Update(ctx, vec(), a, vec());
  const [flags, x, y] = changeFn(ctx, a, oA, owned);
  if (!flags) return null;
  return commitFn(ctx, { core: new Uint32Array(4), after: oA, bank: 0, flags, pad: { x, y } }, m);
}
const water = (amount, bank, flux = [0xbc003c00, 0x80003a00]) => { const m = L.makeMaterial(E.WATER, 22, amount); m.core[2] = flux[0] >>> 0; m.core[3] = ((m.core[3] & 0xffff0000) | (flux[1] & 0xffff)) >>> 0; m.bank = bank; return m; };
const keepsLiquid = (out, m, label) => {
  assert.equal(L.cFill(out.core), L.cFill(m.core), `${label}: fill kept`);
  assert.equal(out.core[2], m.core[2], `${label}: flux kept`); assert.equal(out.core[3] & 0xffff, m.core[3] & 0xffff, `${label}: flux kept`);
};

// ---- Part A: V1's rule and the native commit, executed ----
let checks = 0;
for (const amount of [1, 12345, L.FULL, 3 * L.FULL]) for (const bank of [-73, 177]) {
  const m = water(amount, bank);
  // Heat and Cool: sensible heat on the cell's own bank, the rule's own change (TOOL_HEAT at the centre)
  for (const [tool, sign] of [[tools.HEAT, 1], [tools.COOL, -1]]) {
    const out = paintCell({ tool }, m);
    keepsLiquid(out, m, `heat ${amount}`);
    assert.deepEqual([out.core[1], out.core[2], out.core[3]], [m.core[1], m.core[2], m.core[3]], 'only the temperature word moves');
    assert.equal(L.energyOf(out) - L.energyOf(m), BigInt(sign * L.capacityQ(m.core) * roundEven(PHYS.TOOL_HEAT * 4)), 'the tool\'s heat, by the cell\'s capacity');
    checks++;
  }
  // The Property tool's life and ctype: merged in place, fill, flux and bank kept
  for (const [prop, propValue] of [[PROP.LIFE, 3], [PROP.CTYPE, 7]]) {
    const out = paintCell({ tool: PROP_TOOL, prop, propValue }, m);
    keepsLiquid(out, m, `prop ${prop}`); assert.equal(out.bank, m.bank, 'a property is not heat'); checks++;
  }
  // Spark on a conductor: its spark code, nothing else
  const sparked = paintCell({ tool: tools.SPARK }, m);
  keepsLiquid(sparked, m, 'spark'); assert.equal(sparked.bank, m.bank); assert.equal((sparked.core[3] >>> 16) & 4095, 3); checks++;
  // An element brush over the same element (V1: no change), even in replace mode, whose V1-path
  // import made the owned cell FULL with its bank reset: untouched now
  assert.equal(paintCell({ tool: E.WATER }, m), null);
  assert.equal(paintCell({ tool: E.WATER, replace: 1 }, m), null, 'replace over its own element leaves a film a film');
  // Property type to another liquid: the fill kept (PropertyTool changes the type, not the mass)
  const oil = paintCell({ tool: PROP_TOOL, prop: PROP.TYPE, propValue: E.OIL }, m);
  assert.equal(L.cid(oil.core), E.OIL); assert.equal(L.cFill(oil.core), Math.min(amount, L.MAX_FILL), 'retype keeps the fill'); checks++;
  // Erase: a new air cell, at the air's temperature
  const erased = paintCell({ tool: tools.ERASE }, m);
  assert.equal(L.cid(erased.core), E.EMPTY); assert.equal(erased.bank, 0); checks++;
  // Outside the brush: nothing
  assert.equal(paintCell({ tool: tools.HEAT }, m, 3), null);
}
// An element brush into air: a new cell, liquids FULL (as V1 writes whole cells); a powder at rest
const air = L.makeMaterial(E.EMPTY, 20);
for (const id of [E.WATER, E.SAND, E.STEAM]) {
  const made = paintCell({ tool: id }, air);
  assert.equal(L.cid(made.core), id); assert.equal(made.bank, 0);
  if (L.isLiquid(id)) assert.equal(L.cFill(made.core), L.FULL, 'a painted liquid is a whole cell'); checks++;
}
// A powder's fall state (its motion words) survives heat and the Property tool
const sand = L.makeMaterial(E.SAND, 20); sand.core[2] = 0x3f00abcd; sand.core[3] = 0x12340000; sand.bank = 5;
for (const P of [{ tool: tools.HEAT }, { tool: tools.COOL }, { tool: PROP_TOOL, prop: PROP.CTYPE, propValue: 9 }]) {
  const out = paintCell(P, sand);
  assert.equal(out.core[2], sand.core[2], 'fall kept'); assert.equal(out.core[3] >>> 16, sand.core[3] >>> 16, 'seed kept'); checks++;
}
// A seed-only change owns nothing (importProperties)
assert.deepEqual(changeFn(ctx, vec(E.WATER, 20, 0, 0.25), vec(E.WATER, 20, 0, 0.5), false), [0, 0, 0]);
// A move (Mix, a door leaf): the source's exact core and bank
{ const src = water(4321, -9), dst = water(L.FULL, 3);
  const moved = commitFn(ctx, { core: src.core, after: vec(), bank: src.bank, flags: F.SWAP, pad: { x: 0, y: 0 } }, dst);
  assert.deepEqual([...moved.core], [...src.core]); assert.equal(moved.bank, src.bank); checks++; }
// a new cell is V2's import of an owned cell (shaders/v2.js importA): a gas that fades starts alive
{ const fire = ctx.nativeNewCell(vec(E.FIRE, 900, 0, 0), L.FULL); assert(L.payloadOf(fire.core) > 0, 'a fading gas painted with no life starts alive'); }

// Every writer's modules compile (Naga); the doors' leaf move is hooked where V1 copies the cell.
const writerSpecs = [['nativeBuildStamp', BUILD_STAMP_KERNEL, {}], ['nativeImportedDoor', IMPORTED_DOOR_EDIT, {}],
  ['nativeImportedDoorMotion', IMPORTED_DOOR_MOTION_EDIT, { hook: IMPORTED_DOOR_MOVE_HOOK, moved: 'paintMoved', noteMoves: true }]];
let modules = 0;
for (const [name, desc, opts] of writerSpecs) {
  const spec = nativeEditSpec({ update: desc.update, decls: desc.decls, layout: desc.layout, ...opts }), p = nativeEditParams(name, desc.params);
  for (const stage of ['evaluate', 'commit']) { assertNaga(nativePaintWGSL(g, p, stage, spec), `${name}/${stage}`); modules++; }
  if (opts.hook) assert.match(spec.update, /if \(wasPlaced\) \{ \*oA = oldA; \*oB = fetchB\(old\); paintMoved = true; paintPartner = old; \}/, 'the leaf takes its old cell\'s core');
}
for (const code of [nativeIdsWGSL(g), nativeRectToAtlasWGSL(g, { drawn: true })]) { assertNaga(code, 'native reader'); modules++; }
assert.match(nativeRectToAtlasWGSL(g, { drawn: true }), /a = bitcast<vec4u>\(compactA\(p, A\[s\]\)\);/, 'a save\'s cells: the drawn projection, as the export gave old builds');

// ---- Part B: the real Simulation and PhysicsV2 on a recording GPU ----
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40 };
const calls = [], readbacks = [];
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const words = b => new Uint32Array(b.data.buffer);
const res = (group, binding) => group.entries.find(e => e.binding === binding).resource.buffer;
let owner = null;
const strokeDistance = (p, P) => {
  if (P.masked) return P.maskData[cellTexel(g, ...p)] < 128 ? P.radius + 1 : 0;
  const c = [P.center[0], P.center[1], P.center[2]], e = [P.end[0], P.end[1], P.end[2]], s = e.map((v, i) => v - c[i]);
  let d = p.map((v, i) => v + 0.5 - c[i]); const ss = s.reduce((n, v) => n + v * v, 0);
  const t = ss > 1e-6 ? Math.max(0, Math.min(1, d.reduce((n, v, i) => n + v * s[i], 0) / ss)) : 0;
  d = d.map((v, i) => Math.max(Math.abs(v - s[i] * t) - P.grow[i], 0));
  return P.shape === 0 ? Math.hypot(...d) : Math.max(...d);
};
function boxCells(P) {
  const out = [];
  for (let z = P.editLo[2]; z <= P.editHi[2]; z++) for (let y = P.editLo[1]; y <= P.editHi[1]; y++) for (let x = P.editLo[0]; x <= P.editHi[0]; x++) out.push([x, y, z]);
  return out;
}
// Reference dispatches: the native brush's two stages executed with Part A's production functions on
// the owner's bytes; the ids reader as its documented layout (an independent coordinate reference).
function referenceDispatch(name, opts) {
  const core = owner && words(owner.cells), bank = owner && new Int32Array(owner.aux.data.buffer, 0, g.slots);
  if (name === 'nativePaintEvaluate') {
    const P = opts.params, scratch = res(opts.bind[2], 1);
    const maskData = P.masked ? res(opts.bind[2], 0).data : null;
    scratch.results = boxCells(P).map(p => {
      const s = cellSlot(g, ...p), m = { core: core.slice(s * 4, s * 4 + 4), bank: bank[s] };
      let owned = false;
      Object.assign(ctx, { P: { ...P, center: vec(...P.center), maskData }, strokeDist: () => strokeDistance(p, { ...P, maskData }), ownLegacy: () => { owned = true; } });
      ctx.P.tool = P.tool;
      const a = project(m.core), { oA } = v1Update(ctx, vec(), a, vec());
      const [flags, x, y] = changeFn(ctx, a, oA, owned);
      return { core: new Uint32Array(4), after: oA, bank: 0, flags, pad: { x, y } };
    });
  } else if (name === 'nativePaintCommit') {
    const results = res(opts.bind[1], 0).results;
    ctx.P = { tool: opts.params.tool };
    boxCells(opts.params).forEach((p, i) => {
      const r = results[i]; if (!r.flags) return;
      const s = cellSlot(g, ...p), before = { core: core.slice(s * 4, s * 4 + 4), bank: bank[s] }, m = commitFn(ctx, r, before);
      core.set(m.core, s * 4); bank[s] = m.bank;
    });
  } else if (name === 'nativeIds') {
    const out = res(opts.bind[2], 0).data;
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const s = cellSlot(g, x, y, z); out[cellTexel(g, x, y, z)] = project(core.subarray(s * 4, s * 4 + 4)).x;
    }
  }
}
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 }, limits: {},
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); }, onSubmittedWorkDone: () => Promise.resolve() },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { open: false, copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
  kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(), dispatch(_f, size, opts) { calls.push({ name, size, opts }); referenceDispatch(name, opts); } }),
  readback: { buffer: (b, at, n) => { readbacks.push({ b, n }); return Promise.resolve(b.data.slice(at, at + n).buffer); } },
  flush() {},
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [], CONVERT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) }, act: buffer({ size: 4096 }),
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8 }), noMask: buffer({ size: 16 }),
  _shiftListeners: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {},
  rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() { throw new Error('V1\'s ray layer under V2'); } },
  passOf: name => gpu.kernel({ name }), passes: { paint: { name: 'paint' }, undoShift: gpu.kernel({ name: 'undoShift' }) },
  edit() { throw new Error('V1 edit under V2: a writer must commit natively, never V1\'s cells for V2 to import'); },
});
owner = new PhysicsV2(sim); await owner.ready;
owner.aux ??= buffer({ size: g.slots * 4 });
owner.contactReady = true;
owner.dynamics = { isReady: true, windowReady: true, isIdle: true, air: [0, 1].map(() => buffer({ size: g.nbricks * 32 })), airIndex: 0, ready: Promise.resolve(),
  capabilities: { physicsReady: true, drawReady: true }, readActivity: async () => ({}), plans: buffer({ size: g.slots * 16 }), particles: buffer({ size: 65536 * 48 }),
  control: buffer({ size: 4096 }), _allocate() {}, _externalWork() {}, flushLaunch() {}, restoreDynamicState() {} };
await sim.prepareNative(owner);
let exports = 0;
const exportLegacy = owner.exportLegacy;
owner.exportLegacy = function (...a) { exports++; return exportLegacy.apply(this, a); };
owner.sync();

// The scene: a liquid pool (whole cells below a partial surface, its faces' flux), a sand column with
// fall words, every cell with a bank; the rest air.
const core = words(owner.cells), bank = new Int32Array(owner.aux.data.buffer, 0, g.slots);
const at = (x, y, z) => cellSlot(g, x, y, z);
const put = (p, m) => { const s = at(...p); core.set(m.core, s * 4); bank[s] = m.bank; };
for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) put([x, y, z], { ...L.makeMaterial(E.EMPTY, 20), bank: 0 });
const pool = [];
for (let z = 4; z < 12; z++) for (let x = 4; x < 12; x++) for (let y = 1; y <= 3; y++) { put([x, y, z], water(y < 3 ? L.FULL : 20000 + x * 100 + z, (x * 7 + z) - 40, [0xbc003c00 ^ x, 0x80003a00 ^ z])); pool.push([x, y, z]); }
for (let y = 1; y <= 5; y++) { const m = L.makeMaterial(E.SAND, 20); m.core[2] = 0x3f00abcd ^ y; m.bank = y; put([20, y, 20], m); }
const snapshot = () => ({ core: core.slice(), bank: bank.slice() });
const cellOf = (snap, p) => ({ core: snap.core.slice(at(...p) * 4, at(...p) * 4 + 4), bank: snap.bank[at(...p)] });
const sameCell = (x, y) => x.bank === y.bank && x.core.every((w, i) => w === y.core[i]);
const legacyKernels = /^(v2bridge|v2import|v2externalEvents|paint|paintMix|toAtlas|rectToAtlas|fromAtlas|buildStamp|importedDoor|importedDoorMotion)( apply)?$/;
const owned = () => words(sim.marks).subarray(marksLayout(g).owned, marksLayout(g).owned + Math.ceil(g.slots / 32)).some(Boolean);
function noLegacy(label) {
  owner.sync();
  const legacy = calls.filter(c => legacyKernels.test(c.name)).map(c => c.name);
  assert.deepEqual(legacy, [], `${label}: no V1 kernel, export or import`);
  assert.equal(exports, 0, `${label}: V1's projection never exported`);
  assert(!owned(), `${label}: no cell claimed for a whole-cell import`);
  assert.equal(owner.seenVersion, sim.version, `${label}: a native write is not a legacy edit to import`);
}
const brush = (stroke) => Simulation.prototype.paint.call(sim, { radius: 3, shape: 0, rate: 1, replace: false, ...stroke });
const P = (x, y, z) => ({ x, y, z });

// 1. Heat, Cool, Spark, Warm/Cool air and the Property tool over the pool: in the brush, fill, flux and
// fall kept and heat on the bank; outside it, every word bit-exact.
for (const stroke of [{ tool: tools.HEAT }, { tool: tools.COOL }, { tool: tools.SPARK }, { tool: tools.AMB_HEAT }, { tool: tools.AMB_COOL },
  { tool: PROP_TOOL, prop: { field: PROP.TEMP, value: 60 } }, { tool: PROP_TOOL, prop: { field: PROP.LIFE, value: 2 } }, { tool: PROP_TOOL, prop: { field: PROP.CTYPE, value: 5 } }]) {
  const before = snapshot(); calls.length = 0;
  assert.equal(brush({ ...stroke, center: P(8, 3, 8) }), true);
  const label = stroke.prop ? `Property ${stroke.prop.field}` : TOOLS.find(t => t.id === stroke.tool).key;
  assert(calls.some(c => c.name === 'nativePaintEvaluate') && calls.some(c => c.name === 'nativePaintCommit'), `${label}: native`);
  let changed = 0;
  for (const p of pool) {
    const was = cellOf(before, p), now = cellOf(snapshot(), p);
    assert.equal(L.cFill(now.core), L.cFill(was.core), `${label}: fill`); assert.equal(now.core[2], was.core[2], `${label}: flux`);
    assert.equal(now.core[3] & 0xffff, was.core[3] & 0xffff, `${label}: flux`);
    if (strokeDistance(p, { center: [8, 3, 8], end: [8, 3, 8], grow: [0, 0, 0], shape: 0 }) > 3) assert(sameCell(now, was), `${label}: outside the brush untouched`);
    else if (!sameCell(now, was)) changed++;
  }
  // (Warm and Cool air change only air; a conducting liquid keeps no life, as importProperties keeps none)
  if ([tools.AMB_HEAT, tools.AMB_COOL].includes(stroke.tool) || stroke.prop?.field === PROP.LIFE) assert.equal(changed, 0, `${label}: not the water`);
  else assert(changed > 0, `${label}: the brush changed the pool`);
  noLegacy(label); checks++;
}
// 2. Elements: sand above the pool (new cells at rest), water poured onto its partial surface (air gets
// whole cells, the film's cells keep their fill: V1 spawns only into air), replace, specific delete, Erase.
{
  let before = snapshot(); calls.length = 0;
  brush({ tool: E.SAND, center: P(8, 9, 8) });
  for (let y = 7; y <= 11; y++) assert.equal(L.cid(cellOf(snapshot(), [8, y, 8]).core), E.SAND, 'sand painted');
  for (const p of pool) assert(sameCell(cellOf(snapshot(), p), cellOf(before, p)), 'the pool untouched by sand above it');
  noLegacy('element');
  before = snapshot(); calls.length = 0;
  brush({ tool: E.WATER, center: P(8, 4, 8) });
  for (const p of pool) if (p[1] === 3) assert(sameCell(cellOf(snapshot(), p), cellOf(before, p)), 'a partial surface keeps its fill and flux under more water');
  assert.equal(L.cFill(cellOf(snapshot(), [8, 4, 8]).core), L.FULL, 'water into air: a whole cell');
  noLegacy('water'); checks++;
  calls.length = 0;
  brush({ tool: E.SAND, erase: true, center: P(8, 9, 8) });
  for (let y = 7; y <= 11; y++) assert.equal(L.cid(cellOf(snapshot(), [8, y, 8]).core), E.EMPTY, 'specific delete');
  noLegacy('specific delete');
  calls.length = 0; before = snapshot();
  brush({ tool: tools.ERASE, center: P(20, 3, 20), radius: 1 });
  assert.equal(L.cid(cellOf(snapshot(), [20, 3, 20]).core), E.EMPTY, 'erase');
  assert(sameCell(cellOf(snapshot(), [20, 5, 20]), cellOf(before, [20, 5, 20])), 'sand out of reach keeps its fall words');
  noLegacy('erase'); checks++;
}
// 3. A line and a box of an element, and Mix: one native stroke each.
for (const stroke of [{ tool: E.STONE, center: P(25, 10, 5), end: P(28, 10, 5) }, { tool: E.STONE, center: P(25, 14, 5), grow: [1, 0, 1] }, { tool: tools.MIX, center: P(8, 2, 8) }]) {
  calls.length = 0; assert.equal(brush(stroke), true); assert(calls.some(c => c.name === 'nativePaintCommit')); noLegacy('line/box/mix');
}
// 4. The Rain Cloud perk's brush (pov/player.js rainCloud: cloud into air, never replacing) and the
// console's tpt paint go through sim.paint: native.
{ calls.length = 0; const before = snapshot();
  assert.equal(Simulation.prototype.paint.call(sim, { center: P(8, 12, 8), radius: 2, shape: 0, tool: E.CLOUD, rate: 0.5, replace: false }), true);
  assert.equal(L.cid(cellOf(snapshot(), [8, 12, 8]).core), E.CLOUD, 'cloud seeded');
  for (const p of pool) assert(sameCell(cellOf(snapshot(), p), cellOf(before, p)));
  noLegacy('Rain Cloud'); checks++; }
// 5. Flood fill: the read is a byte a texel of V2's ids (not 32 of V1's projection), the write the
// native brush through the fill's mask; the pool's cells (water, not the region's air) untouched.
{ calls.length = 0; readbacks.length = 0; const before = snapshot();
  const r = await runFill(sim, { cell: [28, 5, 28], id: E.EMPTY, maxY: 5, stroke: { tool: E.OIL, radius: 1, shape: 0, rate: 1, replace: false } });
  assert(r.count > 0, `the fill found its region (${JSON.stringify(r)})`);
  assert(calls.some(c => c.name === 'nativeIds'), 'the native ids reader');
  assert.equal(readbacks.length, 1); assert.equal(readbacks[0].n, g.width * g.height, 'a byte a texel');
  assert.equal(L.cid(cellOf(snapshot(), [28, 5, 28]).core), E.OIL); assert.equal(L.cFill(cellOf(snapshot(), [28, 5, 28]).core), L.FULL);
  for (const p of pool) assert(sameCell(cellOf(snapshot(), p), cellOf(before, p)), 'the pool untouched by the fill above it');
  noLegacy('flood fill'); checks++; }
// 6. Constructions and shrines: the stamp is V1's rule on V2's cells (shaders/construction.js buildStampWriter).
{ calls.length = 0;
  const w = buildStampWriter(sim); await w.ready;
  assert.equal(w.native, true); assert(w.isReady);
  const stamp = buffer({ size: 64 * 16 });
  assert.equal(w.write({ lo: [2, 0, 20], hi: [5, 4, 23] }, { at: [2, 1, 20], foot: 1, size: [4, 4, 4], seed: 7 }, stamp), true);
  const names = calls.map(c => c.name);
  assert(names.indexOf('nativeBuildStampEvaluate') >= 0 && names.lastIndexOf('nativeBuildStampEvaluate') < names.indexOf('nativeBuildStampCommit'), 'every chunk evaluated before any commits: the footings read the grid before the stamp');
  const ev = calls.find(c => c.name === 'nativeBuildStampEvaluate');
  assert.equal(ev.opts.header.format, 3, 'the physical view'); assert.equal(res(ev.opts.bind[2], 0), stamp, 'the baked cells bind');
  noLegacy('construction'); checks++; }
// 7. Imported-map doors (pov/importedInteractions.js): both writers native, their records bound read-write.
for (const [name, desc, opts] of [['importedDoor', IMPORTED_DOOR_EDIT, {}], ['importedDoorMotion', IMPORTED_DOOR_MOTION_EDIT, { hook: IMPORTED_DOOR_MOVE_HOOK, moved: 'paintMoved', noteMoves: true }]]) {
  calls.length = 0;
  const w = importedDoorWriter(sim, name, desc, opts); await w.ready;
  assert.equal(w.native, true);
  const records = buffer({ size: 4096 });
  assert.equal(w.write({ lo: [24, 1, 24], hi: [25, 4, 24] }, { at: [24, 1, 24], size: [2, 4, 1], opening: 1, sourceAt: 16, origin: [0, 0, 0], seed: 1 }, records), true);
  const kname = `native${name[0].toUpperCase()}${name.slice(1)}`;
  assert(calls.some(c => c.name === `${kname}Evaluate`) && calls.some(c => c.name === `${kname}Commit`), `${name}: native`);
  assert.equal(res(calls.find(c => c.name === `${kname}Evaluate`).opts.bind[2], 0), records);
  noLegacy(name); checks++;
}
// 8. The city bus's arrival check: V2's ids (a liquid film is liquid, not the drawn projection's empty).
{ calls.length = 0; readbacks.length = 0;
  const feet = { x: 16.5, y: 10, z: 16.5 }, player = {};
  for (let x = 15; x <= 17; x++) for (let z = 15; z <= 17; z++) put([x, 9, z], { ...L.makeMaterial(E.METAL, 20), bank: 0 });
  assert.equal(await cityBusArrivalClear(sim, feet, player), true, 'standing room on metal');
  put([16, 11, 16], water(300, 0));
  assert.equal(await cityBusArrivalClear(sim, feet, player), false, 'a film in the body\'s cells is not standing room');
  assert(readbacks.every(r => r.n === g.width * g.height), 'one ids read an arrival, not a cell at a time');
  noLegacy('bus'); checks++; }
// 9. A save's cells: V2's own cells as old builds read them (no export), and a V2 save loads without V1's.
{ calls.length = 0;
  assert.equal(sim.saveStatePass, 'nativeDrawnToAtlas');
  const [A, B] = await sim.readSaveState();
  assert.equal(A.length, g.width * g.height * 4); assert.equal(B.length, A.length);
  assert(calls.some(c => c.name === 'nativeDrawnToAtlas'));
  noLegacy('save cells');
  calls.length = 0; const whole = sim.wholeWrites, version = sim.version, before = snapshot();
  sim.loadNative();
  assert.equal(sim.wholeWrites, whole, 'no whole-grid import'); assert(sim.version > version);
  assert(sameCell(cellOf(snapshot(), pool[5]), cellOf(before, pool[5])));
  noLegacy('V2 save load');
  const game = readFileSync(new URL('../../src/saves/game.js', import.meta.url), 'utf8'), wire = readFileSync(new URL('../../src/wire/saves.js', import.meta.url), 'utf8');
  assert.match(game, /const reads = \[sim\.readSaveState \? sim\.readSaveState\(\) : sim\.readState\(\)\];/, 'the capture reads V2\'s cells');
  assert.match(game, /if \(native\) fill = \(\) => sim\.loadNative\(\);/, 'a V2 save in V2 skips V1\'s cells');
  assert.match(wire, /nativeLoad: nativeSaveLoad\(app\),/); checks++; }
// 10. The profiler's awake/drawn shares: V2's activity, not V1's map (never built under V2).
{ readbacks.length = 0;
  const act = words(owner.act), A = owner.layout;
  act.fill(0, 0, A.awake + g.nbricks); act[A.awake + 3] = act[A.awake + 9] = 1; act[A.busy1 + 9] = 1;
  const maps = await sim.readMaps();
  assert.equal(readbacks[0].b, owner.act, 'V2\'s activity words');
  assert.equal(maps.awake.reduce((n, v) => n + v, 0), 2); assert.equal(maps.drawn.reduce((n, v) => n + v, 0), 1); checks++; }

// ---- V1 stays V1's: the same calls as before when V1 presents ----
{ const edits = [], v1 = Object.assign(Object.create(Simulation.prototype), { compact: null, compactOwner: null, editKernel: (name, desc) => ({ name, desc, ready: Promise.resolve(), main: { state: 'ready' }, apply: { state: 'ready' } }),
    edit: (...a) => edits.push(a) });
  const stamp = buildStampWriter(v1); assert.equal(stamp.native, false);
  stamp.write({ lo: [0, 0, 0], hi: [1, 1, 1] }, { at: [0, 0, 0] }, 'buf');
  assert.equal(edits[0][0].name, 'buildStamp'); assert.deepEqual(edits[0][3], { bind: [{ buffer: 'buf' }], scrub: true }, 'V1\'s stamp edit, as before');
  const door = importedDoorWriter(v1, 'importedDoor', IMPORTED_DOOR_EDIT); door.write({ lo: [0, 0, 0], hi: [0, 0, 0] }, {}, 'rec');
  assert.equal(edits[1][0].name, 'importedDoor'); assert.deepEqual(edits[1][3], { bind: [{ buffer: 'rec' }], scrub: true });
  let read = null; const fill = Object.assign(Object.create(Simulation.prototype), { g, origin: sim.origin, compact: null, readStateAAsync: o => { read = o; return Promise.resolve(new Float32Array(g.width * g.height * 4)); } });
  await runFill(fill, { cell: [0, 0, 0], id: 5, stroke: {} }); assert.deepEqual(read, { physical: true }, 'V1\'s fill reads its state as before');
  assert.equal(await Simulation.prototype.readSaveState.call({ compact: null, readState: () => 'v1' }), 'v1'); checks++; }
console.log(`native writers: ${checks} checks, ${modules} modules validated; brush (every grid tool), flood fill, Rain Cloud, constructions, doors, bus read, save cells/load and profiler maps native on V2's cells; no export, no import; no GPU`);
