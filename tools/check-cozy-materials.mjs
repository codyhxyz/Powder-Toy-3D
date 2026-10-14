// CPU-only contracts; --validate-wgsl also runs Naga over complete generated
// near/far/detail modules, through stdin (no browser or temporary files).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Matrix4, Vector3, PerspectiveCamera } from 'three/webgpu';
import { gfx, gfxUniforms, updateGfxUniforms, writeFrameUniforms, FrameUniformsStruct } from '../src/gfx/uniforms.js';
import { FRAME_UNIFORM_FIELDS } from '../src/shaders/bindings.js';
import { uniformStruct } from '../src/gpu/params.js';
import { createViewSettings } from '../src/gfx/viewInputs.js';
import { cozySurfaceWGSL, cozyWaterWGSL } from '../src/shaders/gfx/cozy.js';
import { WGSL_CHECK } from '../src/shaders/gfx/surface.js';
import { gridLayout } from '../src/sim.js';
import { farFrag } from '../src/shaders/far.js';
import { farLayout, WORLD_SIZE } from '../src/shaders/farShared.js';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { cozyFixture, SWATCHES } from './cozy-fixture.mjs';
import { E } from '../src/elements.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
assert.equal(gfx.materialStyle, 0, 'existing look remains the default');
assert.equal(gfxUniforms.uMaterialStyle.value, 0);
const oldFields = Object.fromEntries(Object.entries(FRAME_UNIFORM_FIELDS).filter(([key]) => key !== 'materialStyle'));
const oldStruct = uniformStruct('OldFrameUniforms', oldFields);
for (const [key, offset] of Object.entries(oldStruct.offsets)) assert.equal(FrameUniformsStruct.offsets[key], offset, `existing offset ${key}`);
assert.equal(FRAME_UNIFORM_FIELDS.materialStyle, 'f32');

let written;
const camera = new PerspectiveCamera();
const gpu = { _frameUniforms: {
  uniforms: { write: (values) => { written = values; } },
  last: { viewProj: new Matrix4(), invViewProj: new Matrix4(), model: new Matrix4(), eye: new Vector3(), written: false },
} };
for (const style of [0, 1]) {
  gfx.materialStyle = style;
  updateGfxUniforms({ frame: 0 }, new Vector3(0, 1, 0), [1, 1, 1]);
  writeFrameUniforms(gpu, { camera, model: new Matrix4(), sun: new Vector3(0, 1, 0) });
  assert.equal(written.materialStyle, style, 'style reaches actual frame writer');
  const bytes = FrameUniformsStruct.pack(written);
  assert.equal(new DataView(bytes).getFloat32(FrameUniformsStruct.offsets.materialStyle, true), style);
}
gfx.materialStyle = 0;
gfxUniforms.uMaterialStyle.value = 0;
const settings = { materialStyle: 0 };
const view = createViewSettings(settings);
const before = JSON.stringify(view);
settings.materialStyle = 1;
assert.notEqual(JSON.stringify(view), before, 'style participates in view-cache invalidation');

const app = source('src/app.js');
assert.match(app, /materialStyle: 0/);
assert.match(app.slice(app.indexOf('const PERSIST'), app.indexOf('const STORE')), /'materialStyle'/);
assert.match(app, /if \(!\[0, 1\]\.includes\(settings\.materialStyle\)\)/, 'stored values are sanitized');
assert.match(app, /key: 'materialStyle', options: \[\[0, 'Realistic'\], \[1, 'Cozy'\]\]/);
assert.match(app, /Object\.assign\(settings, DEFAULTS, keep\)/, 'reset restores style default');
const runtime = app.slice(app.indexOf('if (materialStyleSeen !== settings.materialStyle)'), app.indexOf('if (prof.on !== settings.profiler)'));
for (const text of ['gfx.materialStyle = settings.materialStyle', 'post.reset()', 'meshFrames.drop()', 'sim.resetGI()', 'pacer.wake()']) assert.ok(runtime.includes(text), text);
assert.match(app, /\$\{gfx\.smoothing\}\|\$\{gfx\.materialStyle\}/, 'derived key observes the style');

assert.match(cozySurfaceWGSL, /m\.emit = cellEmission\(id, T, ctype\) \+ sparkEmit\(id, ctype\)/);
assert.match(cozySurfaceWGSL, /let wp = p \* CELL_M/);
assert.match(cozySurfaceWGSL, /cozyFade/);
assert.match(cozySurfaceWGSL, /RCLASS\(id\) == R_OPAQUE/);
for (const family of ['cozyWood', 'cozyRings', 'cozyPlant', 'cozyRock', 'cozyDots', 'cozyMasonry']) assert.ok(cozySurfaceWGSL.includes(`fn ${family}(`));
assert.match(cozyWaterWGSL, /return id == E_WATER \|\| id == E_SALTWATER/);
assert.match(cozyWaterWGSL, /let foam = shore \*/);
assert.match(cozyWaterWGSL, /let t = FU\.time/);
const liquid = source('src/shaders/gfx/liquid.js');
assert.ok(liquid.indexOf('if (entering) {') < liquid.indexOf('let cartoon ='));
assert.match(liquid, /cozyWater\(id\) && geometric\.y > 0\.55/);
assert.match(liquid, /if \(mirror && !cartoon\)/);
assert.match(liquid, /isCrisp\(id\) && RCLASS\(id\) == R_OPAQUE/);
assert.ok(!liquid.slice(liquid.indexOf('// Leaving,')).includes('cartoon'), 'exit/TIR behavior stays untouched');
assert.match(source('src/shaders/gfx/grains.js'), /k == GK_PEBBLE && FU\.matDetail > 0\.5 && FU\.materialStyle > 0\.5/);
assert.match(source('src/shaders/gfx/grains.js'), /m\.cav \*= contact/, 'painted pebbles retain neighbor occlusion');
assert.match(source('src/shaders/far.js'), /RCLASS\(farIds\(q\)\.x\) == R_GLASS/, 'far glass cannot become a foam shoreline');

// Execute the real artwork, with host material tables and explicit light
// inputs. The fixture does not reimplement grain, masks, projection, or LOD.
const numerical = `${cozyFixture}
@group(0) @binding(0) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  let p = vec3f(f32(j) * 0.31 - 3.7, f32(j % 7u) * 0.41, f32(j % 5u) * 0.63);
  FU.time = f32(j % 3u) * 2.0;
  fixtureHeat = vec3f(0.13, 0.24, 0.35);
  fixtureSpark = vec3f(0.03, 0.02, 0.01);
${SWATCHES.slice(0, -1).map(([, id, n], i) => `
  let m${i} = cozyMat(${id}, p, vec3f(${n.join(',')}), 900.0, 1.0, 0.01);
  values[j * 11u + ${i}u] = vec4f(m${i}.alb, m${i}.rough);`).join('\n')}
  values[j * 11u + 7u] = cozyWaterPaint(p, 0.01, f32(j % 5u) / 4.0);
  let cold = cozyMat(E_WOOD, p, vec3f(0, 0, 1), 900.0, 1.0, 0.01);
  values[j * 11u + 8u] = vec4f(cold.emit, 1.0);
  values[j * 11u + 9u] = vec4f(cozyPlant(p.xy, 100.0, true), cozyFade(0.5, 100.0));
  values[j * 11u + 10u] = vec4f(select(0.0, 1.0, cozyWater(${E.WATER})),
      select(0.0, 1.0, cozyWater(${E.SALTWATER})), select(0.0, 1.0, cozyWater(${E.GLASS})), select(0.0, 1.0, cozyWater(${E.ACID})));
}`;
const count = 32;
const values = new Float32Array(count * 11 * 4);
new WgslExec(new WgslParser().parse(numerical)).dispatchWorkgroups('main', count, { 0: { 0: values } });
assert([...values].every(Number.isFinite), 'artwork has no NaNs at negative coordinates or cell boundaries');
for (let j = 0; j < count; j++) {
  const row = field => [...values.slice((j * 11 + field) * 4, (j * 11 + field + 1) * 4)];
  for (let i = 0; i < 7; i++) assert(row(i).slice(0, 3).every(x => x > 0 && x < 1.6), `material ${i} remains bounded`);
  assert(row(7).every(x => x >= 0 && x <= 1), 'water paint/transmission is bounded');
  row(8).slice(0, 3).forEach((x, i) => assert(Math.abs(x - [0.16, 0.26, 0.36][i]) < 1e-6, 'heat and spark survive artwork'));
  assert.deepEqual(row(9), [1, 1, 1, 0], 'distant plant artwork fades without residual aliasing');
  assert.deepEqual(row(10), [1, 1, 0, 0], 'only fresh/salt water receive cartoon paint');
}
for (let i = 0; i < 8; i++) {
  const red = Array.from({ length: count }, (_, j) => values[(j * 11 + i) * 4]);
  assert(Math.max(...red) - Math.min(...red) > 0.0003, `material ${i} has actual pattern variation`);
}
const foamCode = `${cozyFixture}
@group(0) @binding(0) var<storage, read_write> foam: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  FU.time = f32(gid.x) * 0.4;
  foam[gid.x * 2u] = cozyWaterPaint(vec3f(0.0), 0.0, 0.0);
  foam[gid.x * 2u + 1u] = cozyWaterPaint(vec3f(0.0), 0.0, 1.0);
}`;
const foam = new Float32Array(16 * 2 * 4);
new WgslExec(new WgslParser().parse(foamCode)).dispatchWorkgroups('main', 16, { 0: { 0: foam } });
for (let j = 0; j < 16; j++) {
  assert(Math.abs(foam[j * 8 + 3] - 0.14) < 1e-6, 'open water has no shoreline foam');
  assert(foam[j * 8 + 7] > 0.7, 'saturated crisp/floor shoreline retains foam at every wave phase');
}

const g = gridLayout(32, 32, 32);
const modules = WGSL_CHECK().map((entry) => [entry.name, entry.code(g)]);
for (const mesh of [false, true]) for (const curved of [false, true]) {
  modules.push([`far.${mesh ? 'mesh' : 'view'}.${curved ? 'curved' : 'flat'}`, farFrag(g, farLayout(WORLD_SIZE), mesh, { curved })]);
}
for (const [name, code] of modules) {
  for (const fn of ['cozyMat', 'cozyWaterPaint']) assert.equal((code.match(new RegExp(`fn ${fn}\\(`, 'g')) || []).length, 1, `${name}: helper defined once`);
  assert.match(code, /if \(FU\.materialStyle > 0\.5 && cozySupported\(id\)\)/);
  assert.ok(code.indexOf('if (FU.matDetail < 0.5)') < code.indexOf('if (FU.materialStyle > 0.5 && cozySupported(id))'), 'flat-texture mode still takes precedence');
  if (name.startsWith('far.')) assert.match(code, /cozyWaterPaint\(p, footprint\(p\), cozyFarShore\(p\)\)/);
  if (process.argv.includes('--validate-wgsl')) {
    const result = spawnSync('naga', ['--stdin-file-path', `${name}.wgsl`], { input: code, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    console.log(`${name}: Naga CPU validation passed`);
  }
}
console.log('Cozy materials: packing, persistence/reset, cache keys, near/far/detail artwork and optical scopes passed.');
