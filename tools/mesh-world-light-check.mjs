// CPU-only: the meshes' and V2 particles' world light (docs/seamless-world.md, "one lighting
// system"; shaders/world/lightLookup.js). The lookups validate under naga standalone; a lit TSL
// material's generated fragment shader (three's WGSLNodeBuilder, no device) declares lcBuf under
// the name the lookups read and validates under naga; the particle draw and the hands' eye probe
// validate with L bound;
// packLightMats lays LC out as lmSetMats reads it.
// node tools/mesh-world-light-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WGSLNodeBuilder, WebGPURenderer, Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicNodeMaterial } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { lightLookupWGSL, lightLookupFromMatsWGSL, packLightMats } from '../src/shaders/world/lightLookup.js';
import { litColor, meshWorldLightWGSL, meshLight, updateMeshLight } from '../src/gfx/meshLight.js';
import { ShadowCascades, probeLevels, glowLevels } from '../src/gfx/worldLightBook.js';
import { nativeParticleWGSL } from '../src/shaders/v2/particleRender.js';
import { worldEyeWGSL } from '../src/gfx/worldEyeLight.js';
import { noiseGLSL } from '../src/shaders/gfx/noise.js';
import { glslMod } from '../src/gpu/wgsl.js';

const dir = mkdtempSync(join(tmpdir(), 'mesh-world-light-'));
const naga = (name, src) => {
  const f = join(dir, `${name}.wgsl`);
  writeFileSync(f, src);
  try { execFileSync('naga', [f], { stdio: 'pipe' }); } catch (e) { throw new Error(`${name}: naga: ${e.stderr}`); }
};
try {
  // 1. the lookups alone, every entry point used
  naga('lookups', `${glslMod}\n${noiseGLSL}
@group(0) @binding(0) var<storage, read> lcBuf: array<vec4u>;
fn lmLoad(i: u32) -> vec4u { return lcBuf[i]; }
${lightLookupWGSL()}
${lightLookupFromMatsWGSL}
@group(0) @binding(1) var t3: texture_3d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var<storage, read_write> outB: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  lmSetMats(mat4x4f(), mat4x4f(), mat4x4f(), mat4x4f(), mat4x4f());
  let g = lmProbeAt(vec3f(1.0), t3, t3, t3, t3, smp, vec3f(1.0), vec3f(0.5));
  outB[0] = vec4f(lmSunMap(vec3f(1.0), vec3f(0.0, 1.0, 0.0), true, 0.0) + lmIrradiance(g, vec3f(0.0, 1.0, 0.0)) + lmGlowAt(vec3f(2.0), t3, smp), 1.0);
}`);
  naga('lookups-no-caustics', `@group(0) @binding(0) var<storage, read> lcBuf: array<vec4u>;
fn lmLoad(i: u32) -> vec4u { return lcBuf[i]; }
${lightLookupWGSL({ caustics: false })}
@group(0) @binding(3) var<storage, read_write> outB: array<vec4f>;
@compute @workgroup_size(1) fn main() { outB[0] = vec4f(lmSunMap(vec3f(1.0), vec3f(0.0), false, 0.0), 1.0); }`);

  // 2. a lit TSL material, as three generates it
  const renderer = new WebGPURenderer({ canvas: { addEventListener() {}, removeEventListener() {}, style: {} } });
  renderer.hasFeature = () => false;
  const material = new MeshBasicNodeMaterial();
  material.colorNode = litColor({ albedo: vec3(0.5, 0.4, 0.3) });
  const mesh = new Mesh(new BoxGeometry(), material);
  const builder = new WGSLNodeBuilder(mesh, renderer);
  builder.scene = new Scene();
  builder.camera = new PerspectiveCamera();
  builder.build();
  const frag = builder.fragmentShader;
  assert.ok(/var<storage,\s*read>\s*lcMeshBuf\s*:/.test(frag), 'three declares lcBuf read-only under the name the lookups read');
  assert.ok(frag.includes('lmSunMap(') && frag.includes('lmProbeAt(') && frag.includes('lmGlowAt('), 'the material carries the world lookups');
  assert.ok(frag.includes(meshWorldLightWGSL.trim().split('\n')[0]), 'the lookups are the module meshLight exports');
  naga('lit-material', frag);

  // 3. the particle draw with L's bindings
  naga('particles', nativeParticleWGSL(false));
  // and the hands' eye probe (pov/viewmodel.js eyeLight)
  naga('eye', worldEyeWGSL());

  // 4. packLightMats: LC's fields where lmSetMats reads them (column j of mat i at 16i + 4j)
  const lc = {
    shU: [[1, 2, 3, 0.5], [4, 5, 6, 2], [7, 8, 9, 8]], shV: [[10, 11, 12, 0], [13, 14, 15, 1], [16, 17, 18, 3]],
    shS: [[0, 1, 0, 5], [0, 1, 0, 6], [0, 1, 0, 7]], shO: [[-3, 4, 1, 0], [5, -6, 1, 0], [0, 0, 1, 0]],
    centre: [100, 50, 100, 300], prO: [[1, 2, 3, 4], [5, 6, 7, 16], [8, 9, 10, 64]], glO: [[11, 12, 13, 4], [14, 15, 16, 16]], size: [200, 100, 200, 0],
  };
  const m = packLightMats(lc);
  const col = (i, j) => [...m.subarray(16 * i + 4 * j, 16 * i + 4 * j + 4)];
  assert.deepEqual(col(0, 1), lc.shU[1]); assert.deepEqual(col(0, 3), lc.centre);
  assert.deepEqual(col(1, 2), lc.shV[2]); assert.deepEqual(col(1, 3), lc.size);
  assert.deepEqual(col(2, 0), lc.shS[0]); assert.deepEqual(col(2, 3), lc.glO[1]);
  assert.deepEqual(col(3, 0), lc.shO[0]); assert.deepEqual(col(3, 3), lc.glO[0]);
  assert.deepEqual(col(4, 2), lc.prO[2]);
  // 5. updateMeshLight with a world light before and after its first update (no basis, then a sun)
  const size = [256, 128, 256];
  const backendData = new Map();
  const app = { gpu: { _mediaNoise: { texture: null }, three: { renderer: { backend: { get: (o) => backendData.get(o) ?? backendData.set(o, {}).get(o) } } } }, sun: { x: 0.3, y: 0.9, z: 0.2 } };
  const wl = { size, shadow: new ShadowCascades(size), probes: probeLevels(), glow: glowLevels(), bands: [], glowTex: null, buf: { lc: { label: 'lcBuf' } } };
  app.worldLight = wl;
  updateMeshLight(app);
  assert.equal(meshLight.world.value.x, 1, 'world light on');
  assert.equal(meshLight.lc[3].value.elements[2], 0, 'nothing traced before the first update: shO.z 0');
  assert.equal(backendData.get(meshLight.lcBuf.value).buffer, wl.buf.lc, 'three binds L\'s lcBuf');
  wl.shadow.update([128, 64, 128], [0.3, 0.9, 0.2], []);
  for (const L of wl.probes) L.centre([128, 64, 128]);
  for (const L of wl.glow) L.centre([128, 64, 128]);
  updateMeshLight(app);
  assert.ok(meshLight.lc[0].value.elements.slice(0, 3).some((x) => x !== 0), 'a sun basis once L has a sun');
  app.worldLight = null;
  updateMeshLight(app);
  assert.equal(meshLight.world.value.x, 0, 'window light back');
  console.log('mesh-world-light-check: ok (lookups, lit material, particles, eye probe, LC packing)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
