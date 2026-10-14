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
import { VIEWS, viewKey, viewForMode, isMaterialView, materialStyleForView } from '../src/views.js';
import { GAMEMODES, mapByKey, mapOf, modeByKey, resolveMode } from '../src/maps.js';
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
const animalCrossing = modeByKey('animalCrossing');
assert.equal(animalCrossing.defaultView, 'cozy');
for (const mode of GAMEMODES) for (const saved of VIEWS) {
  assert.equal(viewForMode(mode, saved.id), mode === animalCrossing ? cozy.id : saved.id,
    'only Animal Crossing supplies a starting shader; other modes retain the selected view');
}
assert.equal(viewForMode(resolveMode(mapByKey('lab'), 'animalCrossing'), 0), 0, 'ineligible maps do not receive the mode default');
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
const linkedViewCode = app.slice(app.indexOf('const viewParam ='), app.indexOf('// ?win='));
const bootModeCode = app.slice(app.indexOf('let selectedMode ='), app.indexOf('if (!toolById'));
const bootView = new Function('settings', 'params', 'bootMap', 'launch', 'VIEWS', 'resolveMode', 'modeByKey', 'viewForMode',
  `${linkedViewCode}\n${bootModeCode}\nreturn settings.view;`);
for (const [query, expected] of [
  ['mode=animalCrossing', cozy.id], ['mode=animalCrossing&view=heat', 1],
  ['mode=animalCrossing&view=5', 5], ['mode=animalCrossing&view=bogus', cozy.id], ['mode=sandbox', 0],
]) {
  assert.equal(bootView({ view: 0 }, new URLSearchParams(query), mapByKey('willowCove'), {},
    VIEWS, resolveMode, modeByKey, viewForMode), expected, 'actual boot code applies mode defaults but honors valid explicit links');
}
assert.equal(bootView({ view: 5 }, new URLSearchParams(), mapByKey('willowCove'), { mode: 'animalCrossing' },
  VIEWS, resolveMode, modeByKey, viewForMode), cozy.id, 'menu launch also overrides an old saved view');
const modeCode = app.slice(app.indexOf('async function startMode('), app.indexOf('// maps.js is plain data'));
const makeMode = new Function('settings', 'helpers', `
  const { resolveMode, mapOf, viewForMode } = helpers;
  let selectedMode = 'sandbox', modeEpoch = 0, villageFocus = null;
  const win = null, pov = null, mp = { role: 'solo' }, ctx = {};
  const hud = { toast() {}, dismissHint() {} }, presentation = { select() {} }, pacer = { wake() {} };
  const applyGravity = () => {}, setView = id => { settings.view = id; };
  ${modeCode}
  return startMode;
`);
const modeSettings = { view: 0, size: 'world', scene: 'willowCove' };
const startMode = makeMode(modeSettings, { resolveMode, mapOf, viewForMode });
await startMode('animalCrossing');
assert.equal(modeSettings.view, cozy.id, 'entering the running mode selects Cozy');
modeSettings.view = 1;
await startMode('animalCrossing');
assert.equal(modeSettings.view, 1, 'a manual shader change is not forced back during the same mode');
await startMode('sandbox');
assert.equal(modeSettings.view, 1, 'other modes do not override the selected shader');
await startMode('animalCrossing');
assert.equal(modeSettings.view, cozy.id, 're-entering Animal Crossing applies its default again');
const openMapCode = app.slice(app.indexOf('function openMap('), app.indexOf('// Animal Crossing on Tinker Creek'));
assert(openMapCode.indexOf('setView(modeView)') < openMapCode.indexOf('setSize(m.size)'), 'new maps choose their shader before building pipelines');
const preload = source('src/preload.js');
const warmMapCode = preload.slice(preload.indexOf('export function warmMap('), preload.indexOf("// The grid a map's")).replace('export ', '');
const makeWarmer = new Function('mapByKey', 'resolveMode', `
  const launch = { adapter: {} }, warmed = new Set(), calls = [];
  const gridOf = () => ({ key: '128x128x128w' });
  const warmer = { grid: g => calls.push(g) };
  ${warmMapCode}
  return { warmMap, calls };
`);
const warmer = makeWarmer(mapByKey, resolveMode);
warmer.warmMap('island', 'sandbox');
warmer.warmMap('willowCove', 'animalCrossing');
warmer.warmMap('willowCove', 'animalCrossing');
assert.equal(warmer.calls.length, 2, 'same-grid shader variants have separate warm keys but are deduplicated');
assert.equal(warmer.calls[1].view, 'cozy');
assert.equal(warmer.calls[1].curved, true);
assert.equal(warmer.calls[1].volumeOnly, true, 'mode changes reuse the grid kernels');
assert.match(preload, /view = views\.viewKey\(settings\.view\)/);
assert.match(preload, /render\.warmChecks\(view, settings, \{ fallback, curved \}\)/);
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
for (const family of ['cozyWood', 'cozyRings', 'cozyLeaf', 'cozyPlant', 'cozyRock', 'cozyDots', 'cozySoil', 'cozySnow', 'cozyMasonry']) assert.ok(cozySurfaceWGSL.includes(`fn ${family}(`));
assert.match(cozyWaterWGSL, /return id == E_WATER \|\| id == E_SALTWATER/);
assert.match(cozyWaterWGSL, /let foam = shore \*/);
assert.match(cozyWaterWGSL, /let t = FU\.time/);
const liquid = source('src/shaders/gfx/liquid.js');
assert.ok(liquid.indexOf('if (entering) {') < liquid.indexOf('let cartoon ='));
assert.match(liquid, /cozyWater\(id\) && geometric\.y > 0\.55/);
assert.match(liquid, /if \(mirror && !cartoon\)/);
assert.match(liquid, /isCrisp\(id\) && RCLASS\(id\) == R_OPAQUE/);
assert.ok(!liquid.slice(liquid.indexOf('// Leaving,')).includes('cartoon'), 'exit/TIR behavior stays untouched');
assert.match(liquid, /cozyWaterNormal\(worldPos\(hp\), geometric, footprint\(hp\)\)/);
assert.match(source('src/shaders/far.js'), /cozyWaterNormal\(p, geometric, footprint\(p\)\)/, 'far uses the same world-space optical waves');
for (const file of ['src/shaders/gfx/liquid.js', 'src/shaders/far.js']) {
  assert.match(source(file), /COZY_WATER_ROUGH/);
  assert.match(source(file), /COZY_WATER_REFLECT/);
}
assert.match(source('src/shaders/gfx/grains.js'), /k == GK_PEBBLE && FU\.matDetail > 0\.5 && FU\.materialStyle > 0\.5/);
assert.match(source('src/shaders/gfx/grains.js'), /m\.cav \*= contact/, 'painted pebbles retain neighbor occlusion');
assert.match(source('src/shaders/far.js'), /RCLASS\(farIds\(q\)\.x\) == R_GLASS/, 'far glass cannot become a foam shoreline');

// Execute the real artwork, with host material tables and explicit light
// inputs. The fixture does not reimplement grain, masks, projection, or LOD.
const materialCount = SWATCHES.length - 1, stride = materialCount + 4;
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
  values[j * ${stride}u + ${i}u] = vec4f(m${i}.alb, m${i}.rough);`).join('\n')}
  values[j * ${stride}u + ${materialCount}u] = cozyWaterPaint(p, 0.01, f32(j % 5u) / 4.0);
  let cold = cozyMat(E_WOOD, p, vec3f(0, 0, 1), 900.0, 1.0, 0.01);
  values[j * ${stride}u + ${materialCount + 1}u] = vec4f(cold.emit, 1.0);
  values[j * ${stride}u + ${materialCount + 2}u] = vec4f(cozyPlant(p.xy, 100.0, true), cozyFade(0.5, 100.0));
  values[j * ${stride}u + ${materialCount + 3}u] = vec4f(select(0.0, 1.0, cozyWater(${E.WATER})),
      select(0.0, 1.0, cozyWater(${E.SALTWATER})), select(0.0, 1.0, cozyWater(${E.GLASS})), select(0.0, 1.0, cozyWater(${E.ACID})));
}`;
const count = 32;
const values = new Float32Array(count * stride * 4);
new WgslExec(new WgslParser().parse(numerical)).dispatchWorkgroups('main', count, { 0: { 0: values } });
assert([...values].every(Number.isFinite), 'artwork has no NaNs at negative coordinates or cell boundaries');
for (let j = 0; j < count; j++) {
  const row = field => [...values.slice((j * stride + field) * 4, (j * stride + field + 1) * 4)];
  for (let i = 0; i < materialCount; i++) assert(row(i).slice(0, 3).every(x => x > 0 && x < 1.6), `material ${i} remains bounded`);
  assert(row(materialCount).every(x => x >= 0 && x <= 1), 'water paint/transmission is bounded');
  assert(row(materialCount)[3] <= 0.782, 'even foam retains at least 21.8% transmission before Fresnel');
  row(materialCount + 1).slice(0, 3).forEach((x, i) => assert(Math.abs(x - [0.16, 0.26, 0.36][i]) < 1e-6, 'heat and spark survive artwork'));
  assert.deepEqual(row(materialCount + 2), [1, 1, 1, 0], 'distant plant artwork fades without residual aliasing');
  assert.deepEqual(row(materialCount + 3), [1, 1, 0, 0], 'only fresh/salt water receive cartoon paint');
}
for (let i = 0; i <= materialCount; i++) {
  if (SWATCHES[i][0] === 'Metal') continue;   // clean metal's detail is its BRDF, not albedo noise
  const red = Array.from({ length: count }, (_, j) => values[(j * stride + i) * 4]);
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
  assert(foam[j * 8 + 3] >= 0.139 && foam[j * 8 + 3] <= 0.679, 'open-water wave highlights cannot become a saturated shoreline');
  assert(foam[j * 8 + 7] > 0.7, 'saturated crisp/floor shoreline retains foam at every wave phase');
}

// Run the actual optical guard, not a JS reimplementation of its ray math.
const opticalNormal = liquid.slice(liquid.indexOf('fn liquidOpticalNormal('), liquid.indexOf("// The sun's highlight"));
assert(opticalNormal.startsWith('fn liquidOpticalNormal('));
const opticsCode = `${cozyFixture}
${opticalNormal}
@group(0) @binding(0) var<storage, read_write> optics: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  let p = vec3f(f32(j) * 7.31 - 32.2, 0.0, f32(j % 8u) * 13.5 - 54.0);
  let geometric = normalize(vec3f(f32(j % 3u) * 0.2, 0.85, 0.15));
  let tangent = normalize(vec3f(geometric.y, -geometric.x, 0.0));
  let c = 0.0001 + f32(j % 8u) / 8.0;
  let rd = normalize(tangent * sqrt(1.0 - c * c) - geometric * c);
  FU.time = f32(j) * 0.7;
  let n = cozyWaterNormal(p, geometric, 0.06);
  let guarded = liquidOpticalNormal(rd, n, geometric, true, 1.333);
  optics[j * 4u] = vec4f(n, length(n));
  optics[j * 4u + 1u] = vec4f(dot(refract(rd, guarded, 1.0 / 1.333), geometric),
      dot(reflect(rd, guarded), geometric), dot(rd, guarded), distance(cozyWaterNormal(p, geometric, 100.0), geometric));
  let now = cozyWaterPaint(p, 0.06, 0.4);
  let frozen = cozyWaterPaint(p, 0.06, 0.4);
  FU.time += 2.0;
  optics[j * 4u + 2u] = abs(cozyWaterPaint(p, 0.06, 0.4) - now);
  optics[j * 4u + 3u] = abs(frozen - now);
}`;
const optics = new Float32Array(64 * 4 * 4);
new WgslExec(new WgslParser().parse(opticsCode)).dispatchWorkgroups('main', 64, { 0: { 0: optics } });
assert([...optics].every(Number.isFinite));
let motion = 0;
for (let j = 0; j < 64; j++) {
  const at = j * 16;
  assert(Math.abs(optics[at + 3] - 1) < 1e-5, 'water normal remains unit length');
  assert(optics[at + 4] < 0, 'guarded refraction enters the actual water surface even at grazing angles');
  assert(optics[at + 5] >= -1e-5, 'reflection stays above the actual surface');
  assert(optics[at + 6] < 0, 'guarded normal faces the incoming ray');
  assert(optics[at + 7] < 1e-5, 'distant waves converge to the geometric normal');
  motion += [...optics.slice(at + 8, at + 12)].reduce((a, b) => a + b, 0);
  assert.deepEqual([...optics.slice(at + 12, at + 16)], [0, 0, 0, 0], 'same paused clock produces identical water');
}
assert(motion > 0.1, 'painted water visibly moves rather than only changing its lighting');
const seamCode = `${cozyFixture}
@group(0) @binding(0) var<storage, read_write> seams: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  let alongY = j % 2u == 1u;
  let uv = select(vec2f(f32(j) - 8.0, 0.37), vec2f(0.37, f32(j) - 8.0), alongY);
  let dx = select(vec2f(0.00001, 0.0), vec2f(0.0, 0.00001), alongY);
  let fp = select(0.001, 0.06, j % 4u >= 2u);
  seams[j * 5u] = vec4f(abs(cozyWood(uv * vec2f(1.45, 2.3) + dx, fp) - cozyWood(uv * vec2f(1.45, 2.3) - dx, fp)), 1.0);
  seams[j * 5u + 1u] = vec4f(abs(cozyPlant(uv * 0.84 + dx, fp, false) - cozyPlant(uv * 0.84 - dx, fp, false)), 1.0);
  seams[j * 5u + 2u] = vec4f(abs(cozyMasonry(uv * vec2f(0.72, 0.32) + dx, fp, false) - cozyMasonry(uv * vec2f(0.72, 0.32) - dx, fp, false)), 1.0);
  seams[j * 5u + 3u] = vec4f(abs(cozyRings(uv * 1.65 + dx, fp) - cozyRings(uv * 1.65 - dx, fp)), 1.0);
  seams[j * 5u + 4u] = vec4f(abs(cozyPlant(uv * 0.68 + dx, fp, true) - cozyPlant(uv * 0.68 - dx, fp, true)), 1.0);
}`;
const seams = new Float32Array(16 * 5 * 4);
new WgslExec(new WgslParser().parse(seamCode)).dispatchWorkgroups('main', 16, { 0: { 0: seams } });
for (let i = 0; i < seams.length; i++) if (i % 4 !== 3) {
  assert(seams[i] < 0.003, `no cell-grid seams: sample ${Math.floor(i / 20)}, family ${Math.floor(i / 4) % 5}, delta ${seams[i]}`);
}

const g = gridLayout(32, 32, 32);
const modules = WGSL_CHECK().map((entry) => [entry.name, entry.code(g)]);
modules.push(['optics.cozy', opticsCode], ['seams.cozy', seamCode]);
for (const entry of renderChecks().filter(e => e.view === 'cozy')) modules.push([entry.name, entry.code(g)]);
for (const entry of renderChecks().filter(e => e.view === 'realistic')) {
  const code = entry.code(g);
  assert(!code.includes('FU.materialStyle'), 'Realistic has no runtime artwork branch');
  assert.match(code, /if \(0\.0 > 0\.5 && cozySupported\(id\)\)/);
}
for (const mesh of [false, true]) for (const curved of [false, true]) {
  modules.push([`far.${mesh ? 'mesh' : 'view'}.${curved ? 'curved' : 'flat'}`, farFrag(g, farLayout(WORLD_SIZE), mesh, { curved })]);
}
for (const [name, code] of modules) {
  for (const fn of ['cozyMat', 'cozyWaterPaint']) assert.equal((code.match(new RegExp(`fn ${fn}\\(`, 'g')) || []).length, 1, `${name}: helper defined once`);
  if (!name.startsWith('optics.') && !name.startsWith('seams.')) {
    const selector = name.startsWith('volume.cozy.') ? '1.0' : 'FU.materialStyle';
    assert.ok(code.includes(`if (${selector} > 0.5 && cozySupported(id))`));
    assert.ok(code.indexOf('if (FU.matDetail < 0.5)') < code.indexOf(`if (${selector} > 0.5 && cozySupported(id))`), 'flat-texture mode still takes precedence');
  }
  if (name.startsWith('far.')) assert.match(code, /cozyWaterPaint\(p, footprint\(p\), cozyFarShore\(p\)\)/);
  if (process.argv.includes('--validate-wgsl')) {
    const result = spawnSync('naga', ['--stdin-file-path', `${name}.wgsl`], { input: code, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    console.log(`${name}: Naga CPU validation passed`);
  }
}
console.log('Cozy view: picker catalog, per-draw artwork, view persistence/reset, GI/detail variants, near/far artwork and optical scopes passed.');
