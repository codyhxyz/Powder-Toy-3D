// CPU-only. Source reflection and command recording are NOT GPU validation.
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createHybridGeometry } from '../src/gfx/hybrid/geometry.js';
import { createHybridRenderer, hybridEligibility } from '../src/gfx/hybrid/index.js';
import { buildHybridMaterialTable, buildHybridDetailAtlas, createHybridMaterials } from '../src/gfx/hybrid/materials.js';
import { hybridDetailLod, hybridMaterialsWGSL } from '../src/shaders/hybrid/materials.js';
import { drawWGSL, meshWGSL, compactWGSL, shadowWGSL, geometryCapacity } from '../src/shaders/hybrid/geometry.js';
import { gridDims } from '../src/shaders/common.js';
import { ELEMENTS } from '../src/elements.js';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 8 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
const g = gridDims({ nx: 128, ny: 128, nz: 128 });
assert.equal(geometryCapacity(g).capacity, 384);
assert.equal(geometryCapacity(g).faceBytes, 48 * 1024 ** 2);
assert.equal(geometryCapacity(g, { maxBufferSize: 1 }).reason, 'device-buffer-limit');
assert.equal(geometryCapacity(g, {}, 1).guaranteed, false);
assert.throws(() => geometryCapacity(g, {}, 385), RangeError);
const rows = buildHybridMaterialTable();
assert.equal(rows.byteLength, ELEMENTS.length * 80);
assert(rows.every(Number.isFinite), 'material rows must be finite');
const atlas = buildHybridDetailAtlas({ size: 8 });
assert.equal(atlas.mipLevelCount, 4);
assert.deepEqual(atlas, buildHybridDetailAtlas({ size: 8 }), 'stable texture generation');
assert.notDeepEqual(atlas.layers[2], buildHybridDetailAtlas({ size: 8, seed: 17 }).layers[2]);
for (const layer of atlas.layers) {
  assert.deepEqual(layer.map(l => l.width), [8, 4, 2, 1]);
  for (const level of layer) assert.equal(level.albedoRoughness.length, level.width * level.height * 4);
}
assert.equal(hybridDetailLod(1, 1, 64, 7), 6);
assert.equal(hybridDetailLod(0, 1, 64, 7), 0);
assert.equal(hybridDetailLod(1 / 32, 1, 64, 7), 1);
assert.throws(() => hybridDetailLod(-1, 1, 64, 7));
assert.doesNotMatch(hybridMaterialsWGSL(), /textureSample\(/, 'divergent/compute-safe explicit LOD only');
for (const code of [meshWGSL(g), compactWGSL(g), shadowWGSL(g), drawWGSL(g, { shadingWGSL: hybridMaterialsWGSL({ binding: 1 }) })]) new WgslReflect(code);
for (const frame of [{ view: 'heat' }, { view: 'cozy' }, { world: true }, { sourceAppearance: true }, { decoration: true }, { warp: { k: 1 } }, { disabled: true }]) assert(hybridEligibility(frame));
assert.equal(hybridEligibility(), null);

const calls = [], buffers = [], textures = [], rings = [], layouts = new Map();
const resource = (desc, list) => {
  const r = { ...desc, createView() { return { texture: r }; }, destroy() { this.destroyed = true; } };
  list.push(r); return r;
};
const pipe = desc => {
  new WgslReflect(desc.code);
  return { state: 'ready', ready: Promise.resolve(),
    dispatch(_f, size, args) { calls.push({ name: desc.name, size, ...args }); },
    draw(_rp, args) { calls.push({ name: desc.name, ...args }); },
  };
};
const gpu = {
  device: { limits: { maxTextureDimension2D: 8192 }, createSampler: desc => ({ ...desc }) },
  queue: { writeBuffer() {}, writeTexture() {} },
  layout(name, entries) {
    if (layouts.has(name)) assert.deepEqual(entries, layouts.get(name).entries, `layout collision: ${name}`);
    else layouts.set(name, { name, entries });
    return layouts.get(name);
  },
  bindGroup: (layout, entries) => ({ layout, entries }),
  createBuffer: desc => resource(desc, buffers), createTexture: desc => resource(desc, textures),
  uniforms(_struct, name) { return { buffer: resource({ name, size: 4096 }, buffers), write() {} }; },
  kernel: pipe, renderPipeline: pipe, flush() {},
  frame: { render() { calls.push({ name: 'render' }); return { end() { calls.push({ name: 'end' }); } }; } },
  readback: { ring() {
    let resolve; const read = new Promise(r => { resolve = r; });
    const ring = { buffer: {}, next: () => 0, read: () => read, resolve, close() { this.closed = true; } };
    rings.push(ring); return ring;
  } },
};
const sim = {
  id: 1, g, cur: 0, version: 1, origin: { x: 0, y: 0, z: 0 }, tables: {}, bindRO: {},
  header() { return { origin: Object.values(this.origin), src: this.cur, dst: this.cur }; },
  derived: { views: { gi: [{}, {}, {}, {}], light: {} } },
};
const geometry = createHybridGeometry(gpu, sim);
await geometry.ready;
assert.equal(geometry.update(), true);
assert.deepEqual(calls.map(c => c.name.replace(/^.* geometry /, '')), ['compare', 'mesh', 'prepare', 'compact', 'finish']);
assert.equal(calls[0].params.force, 1);
assert.equal(geometry.update(), false, 'camera-only frames never compare or remesh');
sim.version++;
assert.equal(geometry.update(), true);
assert.equal(calls.at(-1).params.force, 0, 'state change uses exact GPU comparison');
sim.origin.x += 16;
geometry.update();
assert.equal(calls.at(-1).params.force, 1, 'window shift invalidates persistent slots');
assert.equal(geometry.drawOpaque({}), true);
assert.equal(calls.at(-1).indirect.buffer, geometry.resources.args);
assert.equal(geometry.update({ sourceAppearance: true }), false);
assert.equal(geometry.drawOpaque({}), false, 'known unsupported appearance cannot leak old surfaces');
geometry.dispose(); geometry.dispose();
assert.equal(geometry.isReady, false);
assert(rings[0].closed);

const materials = createHybridMaterials(gpu, sim, { size: 8 });
assert.deepEqual(materials.entries({ binding: 1 }).map(e => e.binding), [1, 2, 3, 4]);
materials.dispose(); materials.dispose();
assert.throws(() => materials.entries(), /disposed/);
const renderer = createHybridRenderer(gpu, sim);
await renderer.ready;
const composed = calls.length;
assert.equal(renderer.update({ sun: { x: 0, y: 1, z: 0 }, model: new Matrix4() }), true);
assert(calls.length > composed, 'core producer and shadows record real commands');
assert.equal(renderer.update({ view: 'heat' }), false);
assert.equal(renderer.enabled, false);
renderer.dispose();
const refused = createHybridRenderer(gpu, sim, { world: true });
assert.equal(refused.enabled, false);
refused.dispose();
console.log('PASS hybrid core: material bytes/mips/LOD, exact-change recording, allocation bounds, composition, fallback/lifecycle; CPU only.');
