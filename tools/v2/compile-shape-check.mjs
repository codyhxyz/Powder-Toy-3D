// CPU only (no GPU, no browser): V2's start-up waits on its cold Metal compile, and Metal inlines
// every helper call, so each call site of a big contact rule is another copy to compile. Checks:
// 1. the block contact pass and the airborne react stage hold one call of each one-sided pair rule
//    (both orders run in a two-trip loop whose bound Metal can't fold), and ctPhase one ctConvert
//    and one ctProduct (cold compile, 2026-10-20: react 3.8 -> 2.9 s, block 4.8 -> 3.3 s);
// 2. ctPhase decides exactly as its earlier one-convert-a-branch form (below, verbatim), on random
//    cells of every element across the whole temperature range;
// 3. sim.prepareNative starts the brush's kernels with the owner's, not after its readiness.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { particlesWGSL } from '../../src/shaders/v2/particles.js';
import { nativeDynamicsHead, v2BlockWGSL } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { marksLayout } from '../../src/shaders/common.js';
import { ctPhase, ctRow, ctConvert, ctSetEnergy, ctEnergy, ctPastPhase, ctProduct, ctNew, ctPuff, CONTACT_ELEMENT_COUNT } from '../../src/v2/contact.js';
import { assertNaga } from './wgsl-grouping.mjs';

// 1. call sites in the generated kernels (a definition is not a call)
const calls = (code, name) => [...code.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].length - [...code.matchAll(new RegExp(`\\bfn ${name}\\(`, 'g'))].length;
const body = (code, name) => { const i = code.indexOf(`fn ${name}(`); assert(i >= 0, `${name} is generated`); return code.slice(i, code.indexOf('\nfn ', i + 3)); };
for (const dims of [[32, 32, 32], [128, 128, 128]]) {
  const g = gridLayout(...dims);
  const kernels = { react: particlesWGSL(g, nativeDynamicsHead, 'react'), block: v2BlockWGSL(g, contactWGSL, true) };
  for (const [kernel, code] of Object.entries(kernels)) {
    for (const rule of ['ctAcid', 'ctSwallow', 'ctResolvePhase']) assert.equal(calls(code, rule), 1, `${kernel}: one inlined ${rule} for both orders`);
    const phase = body(code, 'ctPhase');
    assert.equal(calls(phase, 'ctConvert'), 1, `${kernel}: ctPhase converts at one call`);
    assert.equal(calls(phase, 'ctProduct'), 1, `${kernel}: ctPhase picks a product at one call`);
    assert.match(code, /for ?\(var order ?= ?0u; ?order ?< ?(dPairOrders|ctPairOrders)\(\); ?order\+\+\)/, `${kernel}: the orders' loop has a runtime bound`);
    assertNaga(code, `${kernel} ${dims}`);
  }
}

// 1b. v2pairs (src/shaders/v2/columns.js): one colTransfers for the pair a thread owns, and colSends' one
// colPour and one colTransfer for both lane directions (2026-10-20: 4.75 M -> 1.43 M chars inlined, 3.3 -> 1.4 s);
// the volume shaders' caustic taps in one rippleH call (lighting.js causticGain, Box and World)
{
  const { v2PairsWGSL } = await import('../../src/shaders/v2.js');
  const { volumeFrag } = await import('../../src/shaders/render.js');
  const pairs = v2PairsWGSL(gridLayout(32, 32, 32));
  const main = pairs.slice(pairs.lastIndexOf('fn main('));
  assert.equal(calls(main, 'colTransfers'), 1, 'v2pairs main: one colTransfers');
  const sends = body(pairs, 'colSends');
  assert.equal(calls(sends, 'colPour'), 1, 'colSends: one colPour');
  assert.equal(calls(sends, 'colTransfer'), 1, 'colSends: one colTransfer');
  assert.equal(calls(sends, 'colSend'), 0, 'colSends: colSend\'s rule inline, not a second colPour');
  for (const backend of ['box', 'world']) {
    const caustic = body(volumeFrag({ nx: 32, ny: 32, nz: 32 }, { backend, view: 'realistic', detail: {} }), 'causticGain');
    assert.equal(calls(caustic, 'rippleH'), 1, `${backend} causticGain: one rippleH in its taps' loop`);
  }
}

// 1c. the realistic volume's tracer (render.js traceView; the Box and World volume shaders, every material
// view, detail level and the curved twin): one inlined copy of each big helper. matOf through planMat's one
// call (gfx/surface.js MatPlan), the reflection march through reflectResolve's (gfx/liquid.js reflectDefer),
// one liquidInterface for the box wall and every bend, one shadeHit for a hit or the floor, and World's
// probes read their four bands per tap lookup (worldAccess.js worldProbe). Cold Metal compile, CPU-timed
// 2026-10-20 (medians of 3): World base 23.4 -> 9.9 s, Box base 5.3 -> 3.3 s.
{
  const { volumeFrag, REALISTIC_LEVELS } = await import('../../src/shaders/render.js');
  for (const backend of ['box', 'world']) for (const view of ['realistic', 'cozy']) for (const level of ['off', 'base', 'full']) for (const curved of [false, true]) {
    const tag = `${backend} ${view} ${level}${curved ? ' curved' : ''}`;
    const g = backend === 'world' ? { nx: 3072, ny: 384, nz: 1024 } : { nx: 32, ny: 32, nz: 32 };
    const code = volumeFrag(g, { backend, view, detail: REALISTIC_LEVELS[level](), curved }).replace(/\/\/[^\n]*/g, '');   // (calls, not comments)
    const trace = body(code, 'traceView');
    assert.equal(calls(trace, 'planMat'), 1, `${tag}: traceView evaluates materials at one planMat call`);
    for (const f of ['crispSurf', 'gatherSurf', 'shadeSurf', 'shadeFloor', 'shadeFloorFw']) assert.equal(calls(trace, f), 0, `${tag}: traceView calls no ${f}`);
    assert.equal(calls(body(code, 'planMat'), 'matOf'), 1, `${tag}: planMat's one matOf`);
    assert.equal(calls(trace, 'shadeHit'), 1, `${tag}: one shadeHit for a hit or the floor`);
    assert.equal(calls(trace, 'liquidInterface'), 1, `${tag}: one liquidInterface for the box wall and every bend`);
    assert.equal(calls(trace, 'reflectResolve'), 1, `${tag}: the reflection is marched once`);
    assert.equal(calls(code, 'reflectHit'), 1, `${tag}: reflectHit's one call is reflectResolve's`);
    for (const f of ['liquidInterface', 'crystalInterface']) assert.equal(calls(body(code, f), 'reflectHit'), 0, `${tag}: ${f} defers its reflection`);
    if (backend === 'world') {
      const probe = body(code, 'probeAt');
      assert.equal(calls(probe, 'worldProbe'), 1, `${tag}: probeAt reads the four bands together`);
      assert.equal(calls(probe, 'probeTex'), 0, `${tag}: probeAt does no lookup per band`);
      assert.equal(calls(body(code, 'worldProbe'), 'worldLightDescriptor'), 1, `${tag}: one descriptor lookup per tap`);
    }
  }
}

// 2. ctPhase as it was (one ctConvert a branch, with phase-blast's puffs), against today's
function ctPhaseBefore(input, surface, random) {
  if (ctRow(input.id).kind === 3 && input.fill === 0) return ctConvert(input, E.EMPTY, 0);
  let c = ctSetEnergy(input, ctEnergy(input));
  const r = ctRow(c.id);
  if (r.hotOut >= 0 && ctPastPhase(c, true)) {
    c = ctConvert(c, ctProduct(r.hotOut, random), r.hotOf);
    if (r.hotGas !== 0) {
      if (c.id !== input.id) c.request = ctPuff(c.request, r.hotGas);
      else if (c.pending >= 0) c.pendingGas = r.hotGas;
    }
    return c;
  }
  if (r.coldOut >= 0 && ctPastPhase(c, false)) {
    let id = ctProduct(r.coldOut, random);
    if (c.id === E.STEAM && surface === 0) id = E.CLOUD;
    c = ctConvert(c, id, r.coldOf);
    if (r.coldGas !== 0) {
      if (c.id !== input.id) c.request = ctPuff(c.request, r.coldGas);
      else if (c.pending >= 0) c.pendingGas = r.coldGas;
    }
    return c;
  }
  if (c.tq > r.meltQ) return ctConvert(c, E.LAVA, r.meltInto);
  if (c.id === E.LAVA) {
    let of = c.ctype;
    if (of <= 0 || of >= CONTACT_ELEMENT_COUNT) of = E.STONE;
    if (c.tq < ctRow(of).meltQ - 600) return ctConvert(c, of, 0);
  }
  return c;
}
let seed = 0x2545f491;
const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const outcome = f => { try { return JSON.stringify(f(), (_, v) => typeof v === 'bigint' ? `${v}n` : v); } catch (e) { return `throws ${e.message}`; } };
let cases = 0, converted = 0;
for (let id = 0; id < CONTACT_ELEMENT_COUNT; id++) {
  for (let n = 0; n < 160; n++) {
    const liquid = ELEMENTS[id].kind === K.LIQUID;
    const fill = liquid ? (n % 8 === 0 ? 0 : 1 + Math.floor(rand() * 65536)) : 65536;
    let cell;
    try { cell = ctNew(id, Math.floor(rand() * 41094), fill); } catch { continue; }
    cell.ctype = Math.floor(rand() * (CONTACT_ELEMENT_COUNT + 4)) - 2;
    cell.pending = rand() < 0.2 ? Math.floor(rand() * CONTACT_ELEMENT_COUNT) : -1;
    cell.request = Math.floor(rand() * 8);
    const surface = n % 2, random = rand();
    const before = outcome(() => ctPhaseBefore({ ...cell }, surface, random)), after = outcome(() => ctPhase({ ...cell }, surface, random));
    assert.equal(after, before, `ctPhase(${ELEMENTS[id].key}, tq ${cell.tq}, fill ${fill}, ctype ${cell.ctype}) as before`);
    cases++; if (JSON.parse(before.startsWith('throws') ? '{}' : before).id !== id) converted++;
  }
}
assert(converted > 500, `the cases reach phase changes (${converted} of ${cases})`);

// 3. the brush's kernels start building with the owner's, before it is ready
{
  const g = gridLayout(16, 16, 16), built = [];
  globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100 };
  const buffer = ({ size }) => ({ size, destroy() {} });
  const gpu = { L: { EMPTY: [] }, createBuffer: buffer, layout: (_n, e) => e, bindGroup: (l, e) => ({ l, e }), queue: { writeBuffer() {} }, write() {},
    kernel: ({ name }) => { built.push(name); return { name, state: 'idle', ready: new Promise(() => {}) }; } };
  const sim = Object.assign(Object.create(Simulation.prototype), { gpu, g, L: { TABLES: [], STATE_RO: [] }, marks: buffer({ size: marksLayout(g).words * 4 }) });
  let resolve;
  const owner = { ready: new Promise(r => { resolve = r; }), isReady: false, aux: {}, dynamics: { ready: new Promise(() => {}) },
    nativeDynamics: { layout: [] } };
  sim.compactOwner = owner;
  sim.prepareNative(owner);
  for (const name of ['nativePaintEvaluate', 'nativePaintCommit', 'nativePaintForceForceEvaluate', 'nativePaintForceForcePlan']) {
    assert(built.includes(name), `${name} builds before the owner is ready`);
  }
  // the window's kernels too (v2/integration.js): only the owner's buffers, not its readiness, so they
  // were a serial tail of the loading screen after its kernels
  assert(['shift', 'gather', 'scatter'].every(n => built.includes(`nativeWindow${n}`)), 'the integration builds with the owner');
  resolve(owner);
}
console.log(`V2 compile shape: one inlined copy of each pair rule and of ctPhase's conversion in react and block; ctPhase exact on ${cases} cells (${converted} converted); the brush builds with the owner; no GPU`);
