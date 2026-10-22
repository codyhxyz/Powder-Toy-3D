// CPU only (no GPU, no browser): the native Mix and Property-type brush
// (src/v2/nativePaint.js). Checks the generated modules compile (Naga), that
// they carry V1's own brush rule verbatim, that the real Simulation.paint routes
// both tools to them and never to a legacy edit/import, that every chunk is
// evaluated before any commits (Mix pairs read each other), and that the brush's
// native kernels build with the native owner (sim.prepareNative).
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { nativePaintWGSL, nativePaintParams, nativePaintUpdateWGSL, NATIVE_PAINT_RESULT_BYTES } from '../../src/v2/nativePaint.js';
import { prepareNativeBrush, NATIVE_BRUSH_KERNELS } from '../../src/v2/interactions.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { paintUpdateWGSL } from '../../src/shaders/passes.js';
import { TOOLS, PROP_TOOL, E } from '../../src/elements.js';
import { PROP } from '../../src/editing.js';
import { assertNaga } from './wgsl-grouping.mjs';

// 1. V1's rule, unchanged: the only edit is recording mixCell's partner.
assert.equal(nativePaintUpdateWGSL().replace('\n  paintPartner = q;', ''), paintUpdateWGSL, 'the native brush runs V1 passes.js paintUpdateWGSL verbatim');
let modules = 0;
for (const dims of [[32, 32, 32], [48, 16, 32]]) {
  const g = gridLayout(...dims), params = nativePaintParams();
  for (const stage of ['evaluate', 'commit', 'particleEvaluate', 'particleCommit']) {
    const code = nativePaintWGSL(g, params, stage);
    assert([...code.matchAll(/var<storage,/g)].length <= 8, `${stage} storage budget`);
    assertNaga(code, `nativePaint/${stage} ${dims}`); modules++;
  }
}
const commitCode = nativePaintWGSL(gridLayout(32, 32, 32), nativePaintParams(), 'commit');
assert.match(commitCode, /if\(isLiq\(before\.core\) && cls\(id\)==C_LIQUID\) \{ amount=cFill\(before\.core\); \}/, 'a liquid retyped to a liquid keeps its fill');
assert.match(commitCode, /m=Material\(r\.core,r\.bank\);/, 'a Mix swap moves the partner\'s exact core and bank');
const evalCode = nativePaintWGSL(gridLayout(32, 32, 32), nativePaintParams(), 'evaluate');
assert.match(evalCode, /r\.core=fetchNativeCore\(paintPartner\); r\.bank=paintBanks\[slotOf\(paintPartner\)\]/);
assert.doesNotMatch(evalCode, /var<storage, read_write> (A|B|marks)\b/, 'the evaluate reads the frozen physical view only');

// 2. The real Simulation.paint over a recording GPU.
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8 };
const calls = [], built = [], retired = [];
const gpu = { _simTables: { airT: 22 }, limits: {}, createBuffer: o => ({ ...o }), layout: (_n, x) => x, bindGroup: (_l, x) => x, frame: { clear() {} },
  kernel: o => { built.push(o.name); return { ...o, state: 'ready', ready: Promise.resolve(), dispatch(_f, size, args) { calls.push({ name: o.name, size, args }); } }; } };
const g = gridLayout(32, 32, 32);
const d = { isReady: true, ready: Promise.resolve(), air: [{}], airIndex: 0, plans: {}, particles: { label: 'particles' }, control: { label: 'control' }, _allocate() {}, _externalWork() { calls.push('externalWork'); } };
const owner = { dynamics: d, aux: { label: 'banks' }, nativeDynamics: { head: nativeDynamicsHead, layout: V2_DYNAMICS_LAYOUT, group: {} }, tick: 7,
  sync() { calls.push('sync'); } };
const sim = Object.assign(Object.create(Simulation.prototype), {
  g, gpu, L: { TABLES: [], STATE_RO: [] }, tables: {}, origin: { x: 64, y: 0, z: -32 }, version: 0, paints: 0, noMask: { dummy: true },
  readHeader: o => ({ format: o?.physical ? 3 : 2 }), header: () => ({ format: 0 }), _retire: b => retired.push(b), wake() {},
  _paintMask: data => ({ mask: data }), compactOwner: owner, compact: owner, rays: { paint: () => false, noteElement() {} }, passes: { paint: {}, paintMix: {} }, touchCentres: Simulation.prototype.touchCentres,
  edit() { throw new Error('legacy edit forbidden: the native brush must not write V1 state for V2 to reimport'); },
});
Object.defineProperty(sim, 'bindPhysicalRO', { value: { physical: true } });
await prepareNativeBrush(sim);
for (const name of ['nativePaintEvaluate', 'nativePaintCommit', 'nativePaintForceForceEvaluate']) assert(built.includes(name), `${name} builds with the native owner`);
assert.deepEqual(NATIVE_BRUSH_KERNELS, ['nativePaintForce', 'nativePaint']);
const mix = TOOLS.find(t => t.key === 'MIX').id, center = { x: 10, y: 10, z: 10 };
calls.length = 0;
assert.equal(Simulation.prototype.paint.call(sim, { center, radius: 4, shape: 0, tool: mix, rate: 1 }), true);
let ev = calls.filter(c => c.name === 'nativePaintEvaluate'), co = calls.filter(c => c.name === 'nativePaintCommit');
assert.equal(ev.length, 1); assert.equal(co.length, 1);
assert.equal(ev[0].args.header.format, 3, 'the evaluate reads the physical (non-dithered) native view');
assert.equal(ev[0].args.bind[1], sim.bindPhysicalRO);
assert.equal(ev[0].args.bind[2].at(-1).resource.buffer, owner.aux, 'the evaluate reads the partner\'s bank');
assert.equal(ev[0].args.params.tool, mix); assert.equal(ev[0].args.params.frame, 1, 'V1\'s paint counter seeds the pairing');
assert.equal(co[0].args.bind[0], owner.nativeDynamics.group, 'the commit writes the native cells and banks');
assert(calls.indexOf('sync') < calls.indexOf(ev[0]), 'pending edits import before the frozen view is read');
assert.equal(sim.version, 1); assert.equal(owner.seenVersion, 1, 'a native write is not a legacy edit to import');
assert(owner.legacyPending && calls.includes('externalWork'));
// A big fill splits into chunks: every chunk evaluates before any commits.
gpu.limits.maxStorageBufferBindingSize = 16 * 16 * 16 * NATIVE_PAINT_RESULT_BYTES;
calls.length = 0; retired.length = 0;
const mask = { lo: [0, 0, 0], hi: [31, 31, 31], data: new Uint8Array(4) };
assert(Simulation.prototype.paint.call(sim, { center, radius: 4, shape: 0, tool: mix, rate: 1, mask }));
const order = calls.filter(c => c.name?.startsWith('nativePaint')).map(c => c.name);
assert(order.length >= 4, 'the fill was chunked');
assert.equal(order.lastIndexOf('nativePaintEvaluate') + 1, order.indexOf('nativePaintCommit'), 'all evaluates precede all commits');
ev = calls.filter(c => c.name === 'nativePaintEvaluate');
assert(ev.every(c => c.args.params.masked === 1 && c.args.bind[2][0].resource.buffer.mask === mask.data), 'the fill\'s mask binds');
assert.equal(retired.length, order.length / 2, 'every chunk\'s scratch retired');
gpu.limits = {};
// Property type: native; other properties keep their own routes.
calls.length = 0;
assert(Simulation.prototype.paint.call(sim, { center, radius: 2, shape: 1, tool: PROP_TOOL, rate: 1, prop: { field: PROP.TYPE, value: E.OIL } }));
ev = calls.filter(c => c.name === 'nativePaintEvaluate');
assert.equal(ev.length, 1); assert.equal(ev[0].args.params.prop, PROP.TYPE); assert.equal(ev[0].args.params.propValue, E.OIL);
calls.length = 0;
assert(Simulation.prototype.paint.call(sim, { center, radius: 2, shape: 1, tool: PROP_TOOL, rate: 1, prop: { field: PROP.TEMP, value: 300 } }),
  'temperature merges as sensible heat on the native cells (nativePaint.js nativeEditCommit), never through V1\'s cells');
assert(calls.some(c => c.name === 'nativePaintCommit'));
// Erase and specific delete empty V2's flying matter too (V1 kept it in the grid), before the grid's own edit.
for (const stroke of [{ tool: TOOLS.find(t => t.key === 'ERASE').id }, { tool: E.SAND, erase: true }, { tool: PROP_TOOL, prop: { field: PROP.TYPE, value: E.EMPTY } }]) {
  calls.length = 0;
  let threw = null;
  try { Simulation.prototype.paint.call(sim, { center, radius: 3, shape: 0, rate: 1, ...stroke }); } catch (e) { threw = e; }
  const names = calls.filter(c => c.name).map(c => c.name);
  assert(names.includes('nativePaintParticleEvaluate') && names.indexOf('nativePaintParticleEvaluate') < names.indexOf('nativePaintParticleCommit'), 'flying matter in the brush is erased');
  const erase = calls.find(c => c.name === 'nativePaintParticleCommit');
  assert.deepEqual(erase.args.bind[1].map(e => e.resource.buffer), [erase.args.bind[1][0].resource.buffer, d.particles, d.control], 'the erase writes the particle list and its live count');
  assert.equal(erase.size[0] * 64, 65536);
  assert.equal(threw, null, 'the grid cells are emptied natively too, never through V1\'s cells');
  assert(names.indexOf('nativePaintCommit') >= 0 && names.indexOf('nativePaintCommit') < names.indexOf('nativePaintParticleEvaluate'), 'the grid first, then the flying matter');
}
const erase = nativePaintWGSL(g, nativePaintParams(), 'particleCommit');
assert.match(erase, /paintParticles\[i\]\.id=0u; atomicSub\(&paintControl\[0\],1u\); noteDead\(i\);/, 'a particle dies as the particle lane kills one');
// Heat, Cool, Spark and the Property tool's type, temperature, life and ctype reach flying matter too
// (V1's flying matter was grid cells): the particle pass runs after the grid's native commit.
const ids = Object.fromEntries(TOOLS.map(t => [t.key, t.id]));
for (const stroke of [{ tool: ids.HEAT }, { tool: ids.COOL }, { tool: ids.SPARK }, { tool: PROP_TOOL, prop: { field: PROP.TEMP, value: 300 } },
  { tool: PROP_TOOL, prop: { field: PROP.LIFE, value: 5 } }, { tool: PROP_TOOL, prop: { field: PROP.CTYPE, value: E.WATER } }, { tool: PROP_TOOL, prop: { field: PROP.TYPE, value: E.OIL } }]) {
  calls.length = 0;
  let threw = null;
  try { Simulation.prototype.paint.call(sim, { center, radius: 3, shape: 0, rate: 1, ...stroke }); } catch (e) { threw = e; }
  const names = calls.filter(c => c.name).map(c => c.name);
  const label = stroke.prop ? `Property ${Object.keys(PROP).find(k => PROP[k] === stroke.prop.field)}` : TOOLS.find(t => t.id === stroke.tool).key;
  assert(names.indexOf('nativePaintParticleEvaluate') >= 0 && names.indexOf('nativePaintParticleEvaluate') < names.indexOf('nativePaintParticleCommit'), `${label} reaches flying matter`);
  assert.equal(threw, null, `${label}: grid cells natively too, never through V1's cells`);
  assert(names.includes('nativePaintCommit'), `${label}: the grid's commit`);
}
// The flying cell's change is V1's own rule's result, merged as V2's importProperties merges a grid cell's,
// in packet energy (a particle owns no air carrier): sensible heat by packet capacity, a declared source.
const pe = nativePaintWGSL(g, nativePaintParams(), 'particleEvaluate');
assert.match(pe, /update\(p,a,b,&outA,&outB\);/, 'the particle runs V1 passes.js update');
assert.match(erase, /let heat=energyMul\(packetCapacityQ\(m\.core\),u32\(abs\(dq\)\)\);/, 'heat by packet capacity');
assert.match(erase, /if\(packetEnergyFits\(m,edited\)\) \{ m=withPacketEnergy\(m,edited\); \}/, 'unrepresentable heat stays out, never wraps');
assert.match(erase, /noteEnergySource\(p,energySub\(packetOwnedEnergy\(m\),packetOwnedEnergy\(before\)\)\)/, 'the tool\'s energy is a declared source');
assert.match(erase, /if\(isLiq\(before\.core\) && cls\(id\)==C_LIQUID\) \{ amount=cFill\(before\.core\); \}/, 'a retyped liquid droplet keeps its fill');
// The dynamics' kernels still building (the first frame no longer waits for them: src/v2/physics.js
// dynamicsReady): the brush records only its own, so it paints natively from the first frame.
const building = Object.assign(Object.create(Simulation.prototype), { ...sim, compactOwner: { ...owner }, compact: null });
building.compact = building.compactOwner; building.compactOwner.dynamics = { ...d, isReady: false, disposed: false };
calls.length = 0;
assert.equal(Simulation.prototype.paint.call(building, { center, radius: 4, shape: 0, tool: mix, rate: 1 }), true, 'paints while the dynamics build');
assert(calls.some(c => c.name === 'nativePaintCommit') && !calls.some(c => /^v2(particles|blasts|air|lists|jets)_/.test(c.name ?? '')), 'its own kernels only');
// Gone (disposed): refused explicitly, never a V1 edit.
const notReady = Object.assign(Object.create(Simulation.prototype), { ...sim, compactOwner: { ...owner }, compact: null });
notReady.compact = notReady.compactOwner; notReady.compactOwner.dynamics = { ...d, isReady: false, disposed: true };
assert.equal(Simulation.prototype.paint.call(notReady, { center, radius: 4, shape: 0, tool: mix, rate: 1 }), false);
console.log(`${modules} native paint modules validated; Mix and Property type run V1's rule on native cells (exact swap, fill kept), evaluate-before-commit, built with the owner; no GPU`);
