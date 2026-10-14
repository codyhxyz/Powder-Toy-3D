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
import { VIEWS, viewKey, isMaterialView, materialStyleForView } from '../src/views.js';
import { createDetailGate, gateVariants } from '../src/gfx/detailGate.js';
import { detailDefaults } from '../src/gfx/detail.js';
import { VOLUME_VIEWS, viewShadows, warmChecks, WGSL_CHECK as renderChecks } from '../src/shaders/render.js';
import { WGSL_CHECK as giChecks } from '../src/shaders/gi.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
assert.equal(gfx.materialStyle, undefined, 'artwork is not a second renderer setting');
assert.equal(gfxUniforms.uMaterialStyle, undefined);
const cozy = VIEWS.find(v => v.key === 'cozy');
assert.equal(cozy.id, 6);
assert.equal(cozy.hotkey, '6');
assert.equal(VIEWS[1], cozy, 'Cozy appears beside Realistic in the existing picker');
for (const key of ['id', 'key', 'hotkey']) assert.equal(new Set(VIEWS.map(v => v[key])).size, VIEWS.length, `unique ${key}`);
assert(VOLUME_VIEWS.includes('cozy'));
assert.equal(viewKey(cozy.id), 'cozy');
assert(viewShadows('cozy'));
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
// Different-view thumbnails must not inherit the currently selected artwork.
for (const id of [0, cozy.id, 0, cozy.id, 1, cozy.id, 5, ...VIEWS.map(v => v.id)]) {
  const style = materialStyleForView(id) ?? 0;
  updateGfxUniforms({ frame: 0 }, new Vector3(0, 1, 0), [1, 1, 1]);
  writeFrameUniforms(gpu, { camera, model: new Matrix4(), sun: new Vector3(0, 1, 0), view: id });
  assert.equal(written.view, id);
  assert.equal(written.materialStyle, style, 'actual frame writer derives artwork from each drawn view');
  const bytes = FrameUniformsStruct.pack(written);
  assert.equal(new DataView(bytes).getFloat32(FrameUniformsStruct.offsets.materialStyle, true), style);
}
const settings = { view: 0 };
const view = createViewSettings(settings);
const before = JSON.stringify(view);
settings.view = cozy.id;
assert.notEqual(JSON.stringify(view), before, 'Cozy uses existing view-cache invalidation');
assert(!('materialStyle' in view));

const app = source('src/app.js');
assert.doesNotMatch(app, /materialStyle|Material style/, 'separate preference and drawer control removed');
assert.match(app.slice(app.indexOf('const PERSIST'), app.indexOf('const STORE')), /'view'/);
assert.match(app, /view: 0, camSpeed/, 'Realistic remains the default');
const runtime = app.slice(app.indexOf('function setView(id)'), app.indexOf('// The blocks renderer on or off'));
for (const text of ['settings.view = id', 'post.reset()', 'meshFrames.drop()', 'sim.resetGI()', 'detailGate.setView(id)', 'save()']) assert.ok(runtime.includes(text), text);
assert.match(app, /post\.settings\.raw = blocks \? false : !isMaterialView\(settings\.view\)/);
assert.match(app, /post\.settings\.raw = view === 'plain' \? false : !isMaterialView\(view\)/, 'Cozy thumbnails retain tone mapping');
for (const file of ['src/app.js', 'src/wire/world.js', 'src/wire/weather.js']) {
  assert.doesNotMatch(source(file), /settings\.view [!=]== 0/, `${file}: lit rendering includes Cozy`);
}

const detail = detailDefaults();
for (const shader of ['realistic', 'cozy']) {
  assert(isMaterialView(shader));
  const warm = warmChecks(shader, detail);
  assert.deepEqual(warm[0].detail, gateVariants(detail).base);
  assert(warm.some(e => e.name === 'shadow'));
  assert(giChecks().every(e => e.warm({ view: shader })), 'both material views preload GI');
  assert(warmChecks(shader, detail, { curved: true })[0].curved);
}
assert(!isMaterialView('plain'));
assert(giChecks().every(e => !e.warm({ view: 'heat' })));
const requests = [];
const volume = { pipeline(shader, defines) {
  requests.push({ shader, defines });
  return { state: 'ready', ready: Promise.resolve(), build() {} };
} };
const gate = createDetailGate(null);
try {
  gate.configure(volume, detail, 0);
  gate.update(camera, [0, 0, 0], [32, 32, 32], 640);
  assert(requests.every(r => r.shader === 'realistic'));
  requests.length = 0;
  gate.setView(cozy.id);
  gate.update(camera, [0, 0, 0], [32, 32, 32], 640);
  assert.equal(gate.view, 'cozy');
  assert(requests.length >= 2, 'Cozy builds its own base and near variants');
  assert(requests.every(r => r.shader === 'cozy'), 'cannot reuse a Realistic near pipeline');
  requests.length = 0;
  gate.setView(1);
  gate.update(camera, [0, 0, 0], [32, 32, 32], 640);
  assert.equal(requests.length, 0, 'data views do not compile material detail');
  assert.equal(gate.pending, 0);
} finally { gate.dispose(); }

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
for (const entry of renderChecks().filter(e => e.view === 'cozy')) modules.push([entry.name, entry.code(g)]);
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
console.log('Cozy view: picker catalog, per-draw artwork, view persistence/reset, GI/detail variants, near/far artwork and optical scopes passed.');
