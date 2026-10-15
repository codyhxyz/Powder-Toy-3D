// CPU only: shader reflection, descriptors, field ABI and recording contracts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { Derived } from '../src/derived.js';
import { gridDims } from '../src/shaders/common.js';
import { uniformStruct } from '../src/gpu/params.js';
import { EmaParams, BoostParams, fieldEmaFrag, fieldBoostFrag, particleAgeFrag } from '../src/shaders/fields.js';
import { SMOOTH_CASES, SMOOTH_EDGES, SMOOTH_TETS, SMOOTH_EXTRACT_LAYOUT, SMOOTH_DRAW_LAYOUT, smoothExtractWGSL, smoothDrawWGSL } from '../src/shaders/hybrid/smooth.js';
import { createHybridSmooth } from '../src/gfx/hybrid/smooth.js';

export const g = gridDims({ nx: 32, ny: 32, nz: 32 });
export function reflect(code) {
  const r = new WgslReflect(code);
  for (const stage of ['compute', 'vertex', 'fragment']) for (const fn of r.entry[stage]) {
    const storage = fn.resources.filter(v => r.storage.includes(v));
    assert(storage.length <= 8, `${fn.name}: ${storage.length} storage buffers`);
  }
  return r;
}
export function fixture(split = false) {
  const log = [], buffers = [], rings = [], reads = [];
  const gpu = {
    device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 128 * 1024 * 1024 } },
    _frameUniforms: { layout: {}, group: {}, last: {} }, frame: {}, emptyGroup: {},
    layout: (_n, entries) => entries, bindGroup: (_l, entries) => entries,
    createBuffer(d) { const b = { ...d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    readback: { ring() { const r = { buffer: {}, next: () => 0, read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })), close() { this.closed = true; } }; rings.push(r); return r; } },
    kernel(d) { return { state: 'ready', ready: Promise.resolve(), dispatch(_f, _n, p) { log.push({ name: d.name, ...p }); } }; },
    renderPipeline(d) { return { state: 'ready', ready: Promise.resolve(), draw(_rp, p) { log.push({ name: d.name, ...p }); } }; },
    flush() {},
  };
  const derived = { particleSplit: split, world: null, dlist: {}, fieldSurf: {}, fieldThin: {}, views: { fieldSurf: {}, fieldThin: {} } };
  const sim = { id: 1, g, derived, fieldSurf: derived.fieldSurf, fieldThin: derived.fieldThin, L: { TABLES: [], STATE_RO: [] }, origin: { x: 0, y: 0, z: 0 }, version: 0, cur: 0, header: () => ({}) };
  return { gpu, sim, log, buffers, rings, reads };
}

for (const [now, old, values] of [
  [EmaParams, uniformStruct('OldEma', { emaS: 'vec4f', emaM: 'vec4f', reset: 'u32', aer: 'u32' }), { emaS: [1, .2, .3, .4], emaM: [.5, .6, .7, .8], reset: 1, aer: 1 }],
  [BoostParams, uniformStruct('OldBoost', { s: 'vec4f', axis: 'u32', aer: 'u32' }), { s: [1, 2, 3, 4], axis: 2, aer: 1 }],
]) {
  assert.equal(now.size, old.size);
  assert.deepEqual(new Uint8Array(now.pack(values)), new Uint8Array(old.pack(values)), 'default encoded ABI identical including old padding');
  const words = new Uint32Array(now.pack({ ...values, particleSplit: 1, world: 1 }));
  assert.deepEqual([...words.slice(-2)], [1, 1]);
}
const d = Object.assign(Object.create(Derived.prototype), { particleSplit: false, sim: {} });
assert.equal(d.setParticleSplit(false), false);
assert.equal(d.setParticleSplit(true), true);
assert(d.sim.fieldReset && d.sim.changedAll);
d.sim.fieldReset = d.sim.changedAll = false;
assert.equal(d.setParticleSplit(true), false);
assert(!d.sim.fieldReset && !d.sim.changedAll);
assert.equal(d.setParticleSplit(false), true);
assert(d.sim.fieldReset && d.sim.changedAll);
// Exercise real dispatch parameter plumbing without allocating GPU resources.
const calls = [];
Object.assign(d, {
  g, gpu: { emptyGroup: {} }, world: [32, 32, 32], frameNo: 0,
  kernels: Object.fromEntries(['fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldPeak', 'age', 'dirty', 'dirtyArgs', 'particleAges'].map(n => [n, n])),
  groups: { blur: [{}, {}, {}], boost: [{}, {}, {}], book: {}, particleAges: {}, particleBook: {} },
  _over: x => x, _jet: () => 1, _carry() {},
  _dispatch(kernel, size, opts) { calls.push({ kernel, size, ...opts }); },
});
Object.assign(d.sim, { smoothing: 1, header: () => ({}), actNoted: true });
for (const split of [false, true]) {
  d.setParticleSplit(split); calls.length = 0;
  d.updateDirty();
  assert.equal(calls.some(c => c.kernel === 'particleAges'), split);
  assert.equal(calls.find(c => c.kernel === 'dirty').bind[2], split ? d.groups.particleBook : d.groups.book);
  if (split) assert(calls.findIndex(c => c.kernel === 'particleAges') < calls.findIndex(c => c.kernel === 'dirty'));
  calls.length = 0; d.updateFields();
  for (const c of calls.filter(c => ['fieldEma', 'fieldBoost0', 'fieldBoost'].includes(c.kernel))) {
    assert.equal(c.params.particleSplit, Number(split)); assert.equal(c.params.world, 1); assert.equal(c.params.aer, 1);
  }
  assert.equal(d.sim.fieldReset, false);
}
const ema = fieldEmaFrag(g), boost = fieldBoostFrag(g, 0), extract = smoothExtractWGSL(g);
assert(ema.indexOf('if (particleOwned) { sv[ch] = 0.0; }') > ema.indexOf('sv = mix('));
assert.match(ema, /ch >= 0 && !particleOwned/);
assert.match(boost, /hybridParticleOwns\(q, P.world != 0u\)/);
assert.match(boost, /if \(jetAt\(q\)\) \{ occ.x = 1.0/);
assert.match(extract, /material == E_EMPTY\) \{ continue;/);
assert(!extract.includes('textureLoad(thin'));
assert.match(extract, /SURFCH\(eid\(s\)\) == ch && d < best && !/);
assert.match(extract, /args\[0\] = select\(0u, total \* 3u, bad == 0u\)/);
assert.match(extract, /required = max\(required, n\)/);
for (const code of [ema, boost, fieldBoostFrag(g, 1), particleAgeFrag(g), extract, smoothDrawWGSL(g)]) reflect(code);
for (const [code, layout] of [[extract, SMOOTH_EXTRACT_LAYOUT], [smoothDrawWGSL(g), SMOOTH_DRAW_LAYOUT]]) {
  const r = reflect(code);
  const bindings = [...r.storage, ...r.textures].filter(v => v.group === 2).map(v => v.binding).sort((a, b) => a - b);
  assert.deepEqual(bindings, layout.map(v => v.binding));
}
for (let mask = 0; mask < 16; mask++) {
  assert(SMOOTH_CASES[mask].length <= 2);
  for (const tri of SMOOTH_CASES[mask]) for (const e of tri) {
    const [a, b] = SMOOTH_EDGES[e];
    assert.notEqual((mask >> a) & 1, (mask >> b) & 1);
  }
  assert.equal(SMOOTH_CASES[mask].length, SMOOTH_CASES[15 - mask].length);
}
// Adjacent cubes have exactly the same face triangulation after translation.
const corner = i => [i & 1, (i >> 1) & 1, i >> 2];
for (let axis = 0; axis < 3; axis++) {
  const face = side => SMOOTH_TETS.flatMap(t => {
    const v = t.map(corner).filter(p => p[axis] === side);
    return v.length === 3 ? [v.map(p => p.filter((_, i) => i !== axis).join(',')).sort().join('|')] : [];
  }).sort();
  assert.deepEqual(face(0), face(1));
}
const f = fixture(), renderer = createHybridSmooth(f.gpu, f.sim);
assert.equal(renderer.resources.capacityPerBrick, 768);
assert(renderer.capabilities.particleSplit);
assert.equal(renderer.update({ revision: 1, particleSplit: true }), false);
f.sim.derived.particleSplit = true;
assert(renderer.update({ revision: 1, particleSplit: true }));
assert(renderer.stats.pending);
assert(!renderer.stats.fallbackRequired);
assert(renderer.draw({}));
assert(renderer.drawShadow({}, { matrix: Array(16).fill(0) }));
assert.deepEqual(f.log.slice(0, 3).map(x => x.name), ['hybrid.smooth.extract', 'hybrid.smooth.finish', 'hybrid.smooth.draw']);
assert.equal(f.log[0].params.particleSplit, 1);
for (let revision = 2; revision < 5; revision++) { assert(renderer.update({ revision })); assert(renderer.draw({})); }
f.reads.at(-1).resolve(new Uint32Array([1, 2000, 1000, 1]).buffer);
await Promise.resolve();
assert.equal(renderer.stats.requiredPerBrick, 1000);
assert.equal(renderer.stats.count, 2000);
assert.equal(renderer.stats.fallbackReason, 'capacity-overflow');
assert(!renderer.draw({}));
assert(renderer.update({ revision: 5 })); assert(renderer.draw({}));
renderer.dispose(); renderer.dispose();
assert(f.buffers.every(b => b.destroyed)); assert(f.rings.every(r => r.closed));
const source = readFileSync(new URL('../src/derived.js', import.meta.url), 'utf8');
assert.match(source, /particleSplit \? this.groups.particleBook : book/);
assert.match(source, /params: \{ s, axis, aer, particleSplit, world \}/);
console.log('PASS smooth CPU: field ABI/default-zero, reset, split/history/jet guards, static reflection <=8 storage, descriptor cases/seams, source selection, overflow suppression, same-frame draw/shadow, disposal');
