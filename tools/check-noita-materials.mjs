// CPU-only contracts of the Noita view (src/shaders/gfx/noita.js): its picker
// entry and launch defaults, material styles that never mix, the measured
// palettes run through the real WGSL (wgsl_reflect), and Descent's source
// variant labels (tools/noita-terrain-looks.json). --validate-wgsl also runs
// Naga over every generated module that carries the artwork; --swatches FILE
// writes every look as a PPM (a texture sheet for eyes, not a screenshot).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { cozyFixture } from './cozy-fixture.mjs';
import { noitaSurfaceWGSL, NOITA_LOOKS, NOITA_LOOK_INDEX, NOITA_ELEMENT_LOOKS, noitaMean } from '../src/shaders/gfx/noita.js';
import { E, ELEMENTS } from '../src/elements.js';
import { Appearance as AP, VARIANT_ELEMENTS, appearanceCtype, appearanceOf, resolveAppearance, physicalCtype } from '../src/appearance.js';
import { VIEWS, viewForMode, isMaterialView, materialStyleForView } from '../src/views.js';
import { mapByKey, modeByKey } from '../src/maps.js';
import { VOLUME_VIEWS, viewShadows, WGSL_CHECK as renderChecks } from '../src/shaders/render.js';
import { farFrag } from '../src/shaders/far.js';
import { farLayout, WORLD_SIZE } from '../src/shaders/farShared.js';
import { gridLayout } from '../src/sim.js';
import { nagaSpawn } from './naga.mjs';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path) => JSON.parse(source(path));

// ---- the picker and launch defaults ----
const noita = VIEWS.find((v) => v.key === 'noita');
assert.equal(noita.id, 8);
assert.equal(noita.hotkey, '8');
for (const key of ['id', 'key', 'hotkey']) assert.equal(new Set(VIEWS.map((v) => v[key])).size, VIEWS.length, `unique ${key}`);
assert.equal(materialStyleForView('noita'), 2);
assert.equal(materialStyleForView(noita.id), 2);
assert(isMaterialView('noita') && VOLUME_VIEWS.includes('noita') && viewShadows('noita'));
assert.deepEqual(VIEWS.filter((v) => v.materialStyle !== undefined).map((v) => v.materialStyle).sort(), [0, 0, 1, 2], 'one view per artwork, plus Test');
assert.equal(modeByKey('noita').defaultView, 'noita');
assert.equal(mapByKey('descent').defaultView, 'noita');
assert.equal(viewForMode(modeByKey('noita'), 0, mapByKey('descent')), noita.id, 'Descent in the Noita gamemode starts in the Noita view');
assert.equal(viewForMode(modeByKey('noita'), 3), noita.id);
assert.equal(viewForMode(modeByKey('sandbox'), 0, mapByKey('island')), 0, 'other maps are untouched');

// ---- styles never mix: each volume shader is specialised to its own artwork ----
const g = gridLayout(32, 32, 32);
const volumes = renderChecks().filter((e) => e.name.startsWith('volume.') && /^volume\.(realistic|cozy|noita)\.base$/.test(e.name));
assert.equal(volumes.length, 3);
for (const entry of volumes) {
  const code = entry.code(g), style = `${materialStyleForView(entry.view)}.0`;
  assert(!code.includes('FU.materialStyle'), `${entry.name}: no runtime artwork branch`);
  assert(code.includes(`if (${style} == 2.0 && noitaSupported(id, ctype))`), `${entry.name}: Noita gate`);
  assert(code.includes(`if (${style} == 1.0 && cozySupported(id, ctype))`), `${entry.name}: Cozy gate`);
  assert(code.indexOf('if (FU.matDetail < 0.5)') < code.indexOf(`if (${style} == 2.0 && noitaSupported`), 'flat-texture mode still takes precedence');
}
for (const file of ['src/shaders/gfx/surface.js', 'src/shaders/gfx/grains.js', 'src/shaders/gfx/liquid.js', 'src/shaders/far.js']) {
  assert.doesNotMatch(source(file), /FU\.materialStyle > 0\.5/, `${file}: Cozy art must not switch on in the Noita view`);
}
const farModules = [false, true].flatMap((mesh) => [false, true].map((curved) =>
  [`far.${mesh ? 'mesh' : 'view'}.${curved ? 'curved' : 'flat'}`, farFrag(g, farLayout(WORLD_SIZE), mesh, { curved })]));
for (const [name, code] of farModules) assert(code.includes('if (FU.materialStyle == 2.0 && noitaSupported(id, ctype))'), `${name}: far terrain draws Noita art too`);

// ---- Descent's native materials and their variant labels ----
const route = json('src/world/scenes/descent/terrainRoute.json');
const palette = new Map(route.palette.map((p) => [p.name, p.element]));
const looks = json('tools/noita-terrain-looks.json').nativeAppearance;
const lookOf = (el, ap) => NOITA_ELEMENT_LOOKS.find(([e, a]) => E[e] === el && AP[a] === ap)?.[2];
const apKey = (ap) => Object.keys(AP).find((k) => AP[k] === ap);
for (const [name, label] of Object.entries(looks)) {
  assert(palette.has(name), `${name}: a Descent native material`);
  const el = palette.get(name), ap = resolveAppearance(label);
  const ctype = appearanceCtype(el, 0, ap);
  assert.equal(appearanceOf(el, ctype), ap, `${name}: ${label} rides in ctype`);
  assert.equal(physicalCtype(el, ctype), 0, `${name}: the label never becomes physics`);
  assert(lookOf(el, ap), `${name}: the Noita view draws ${apKey(ap)}`);
  if (ap >= AP.VARIANT_1) assert(VARIANT_ELEMENTS.includes(el) && !ELEMENTS[el].conducts, `${name}: variants only on non-conductors`);
}
for (const el of VARIANT_ELEMENTS) assert(!ELEMENTS[el].conducts, 'a conductor\'s ctype holds its spark');
assert.throws(() => appearanceCtype(E.METAL, 0, 'variant-1'), /not valid/, 'metals carry no variant');
// The brief's priority materials (97 % of solid Descent terrain) all have a Noita look,
// except ice_static and snow_static: ICE is clear glass, outside matOf.
const nativeLook = (name) => lookOf(palette.get(name), looks[name] ? resolveAppearance(looks[name]) : AP.NONE);
const expected = {
  templebrick_static: 'temple', templebrick_noedge_static: 'temple', templebrickdark_static: 'templeDark',
  rock_hard: 'rockHard', rock_static: 'rock', rock_static_grey: 'rockGrey', rock_static_wet: 'rock',
  snowrock_static: 'snowrock', sand_static_rainforest: 'rainforest', sand_static: 'earth', soil_dead: 'soilDead',
  soil: 'soil', wood_tree: 'grain', wood_static: 'planks',
  coal_static: 'coalStatic', steelmoss_static: 'steel', steel_static: 'steel', steel_rusted_no_holes: 'steel',
  steelpipe_static: 'steel', soil_lush: 'lush', rock_hard_border: 'rockBorder', rock_vault: 'vault',
  snow: 'snow', snow_sticky: 'snow', sand: 'sand', coal: 'coal',
};
for (const [name, look] of Object.entries(expected)) assert.equal(nativeLook(name), look, `${name} looks like Noita's ${look}`);

// ---- the real WGSL: palettes, patterns, matte pixels and footprint fade ----
const N = 48, keys = Object.keys(NOITA_LOOKS);
const texels = `${cozyFixture}
${noitaSurfaceWGSL}
@group(0) @binding(0) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let look = i32(gid.x / ${N * N}u);
  let k = gid.x % ${N * N}u;
  out[gid.x] = vec4f(noitaTexel(look, vec2f(f32(k % ${N}u) - ${N / 2}.0, f32(k / ${N}u) - ${N / 2}.0)), 1.0);
}`;
const out = new Float32Array(keys.length * N * N * 4);
new WgslExec(new WgslParser().parse(texels)).dispatchWorkgroups('main', keys.length * N * N, { 0: { 0: out } });
const srgb = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
const hexOf = (i) => '#' + [0, 1, 2].map((k) => srgb(out[i * 4 + k]).toString(16).padStart(2, '0')).join('');
keys.forEach((key, li) => {
  const counts = new Map();
  for (let k = 0; k < N * N; k++) { const h = hexOf(li * N * N + k); counts.set(h, (counts.get(h) ?? 0) + 1); }
  const measured = new Map(NOITA_LOOKS[key].colours.map(([hex, w]) => [hex, w]));
  // Hiisi steel panels carry steelmoss_static's moss patches: one look, both palettes.
  const allowed = new Set([...measured.keys(), ...(key.startsWith('steel') ? [...NOITA_LOOKS.steel.colours, ...NOITA_LOOKS.steelMoss.colours].map(([hex]) => hex) : [])]);
  for (const hex of counts.keys()) assert(allowed.has(hex), `${key}: ${hex} is one of its measured colours`);
  for (const [hex, w] of measured) if (w >= 5 && !(key === 'steelMoss')) {
    assert((counts.get(hex) ?? 0) > 0, `${key}: its ${w}% colour ${hex} appears`);
  }
  if (['rock', 'rockHard', 'rockBorder', 'snowrock', 'earth'].includes(key)) {
    const speck = (counts.get(NOITA_LOOKS[key].colours[1][0]) ?? 0) / (N * N);
    assert(speck > 0.06 && speck < 0.13, `${key}: ${(speck * 100).toFixed(1)}% specks, as Noita's 9%`);
  }
});
// The material: matte, Noita colours, heat and sparks kept, distant faces at the mean.
const cases = [[E.ROCK, 0, 'rock'], [E.ROCK, appearanceCtype(E.ROCK, 0, 'variant-1'), 'rockHard'],
  [E.NOITA_TEMPLE, appearanceCtype(E.NOITA_TEMPLE, 0, 'variant-1'), 'templeDark'], [E.METAL, 0, 'steel'],
  [E.WOOD, appearanceCtype(E.WOOD, 0, 'log-y'), 'grain'], [E.SNOW, 0, 'snow']];
const matCode = `${cozyFixture}
${noitaSurfaceWGSL}
@group(0) @binding(0) var<storage, read_write> m: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  fixtureHeat = vec3f(0.13, 0.24, 0.35);
  fixtureSpark = vec3f(0.03, 0.02, 0.01);
${cases.map(([id, ctype], i) => `
  let near${i} = noitaMat(${id}, vec3f(3.2, 5.7, 9.0), vec3f(0.0, 0.0, 1.0), 900.0, ${ctype}.0, 0.01);
  let far${i} = noitaMat(${id}, vec3f(3.2, 5.7, 9.0), vec3f(0.0, 0.0, 1.0), 900.0, ${ctype}.0, 4.0);
  let top${i} = noitaMat(${id}, vec3f(3.2, 9.0, 5.7), vec3f(0.0, 1.0, 0.0), 900.0, ${ctype}.0, 4.0);
  m[${i * 5}u] = vec4f(near${i}.alb, near${i}.rough);
  m[${i * 5 + 1}u] = vec4f(far${i}.alb, near${i}.metal);
  m[${i * 5 + 2}u] = vec4f(near${i}.emit, near${i}.f0);
  m[${i * 5 + 3}u] = vec4f(top${i}.alb, f32(noitaLook(${id}, appearanceOf(${id}, ${ctype}.0))));
  m[${i * 5 + 4}u] = vec4f(select(0.0, 1.0, noitaSupported(${id}, ${ctype}.0)), noitaFaceUV(vec3f(3.2, 5.7, 9.0), vec3f(0.0, 0.0, 1.0)), 0.0);`).join('\n')}
}`;
const mats = new Float32Array(cases.length * 5 * 4);
new WgslExec(new WgslParser().parse(matCode)).dispatchWorkgroups('main', 1, { 0: { 0: mats } });
assert([...mats].every(Number.isFinite));
cases.forEach(([, , look], i) => {
  const row = (k) => [...mats.slice((i * 5 + k) * 4, (i * 5 + k + 1) * 4)];
  const [near, far, emit, top, flags] = [0, 1, 2, 3, 4].map(row);
  assert.equal(near[3], Math.fround(0.9), `${look}: matte`);
  assert.equal(far[3], 0, `${look}: no metal sheen`);
  assert.equal(emit[3], Math.fround(0.04));
  emit.slice(0, 3).forEach((x, k) => assert(Math.abs(x - [0.16, 0.26, 0.36][k]) < 1e-6, 'heat and spark survive the artwork'));
  noitaMean(look).forEach((x, k) => assert(Math.abs(far[k] - x) < 1e-5, `${look}: distant faces are the mean, no shimmer`));
  noitaMean(look).forEach((x, k) => assert(Math.abs(top[k] - x * 1.12) < 1e-5, `${look}: lit top faces`));
  assert.equal(top[3], NOITA_LOOK_INDEX[look], `${look}: selected from element + label`);
  assert.deepEqual(flags.slice(0, 3), [1, 3, -5], `${look}: supported; a face reads its own cell, rows running down (got ${flags})`);
});
const unsupported = `${cozyFixture}
${noitaSurfaceWGSL}
@group(0) @binding(0) var<storage, read_write> u: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  u[0] = vec4f(select(0.0, 1.0, noitaSupported(${E.WATER}, 0.0)), select(0.0, 1.0, noitaSupported(${E.PLANT}, 0.0)),
    select(0.0, 1.0, noitaSupported(${E.CLAY}, 0.0)), select(0.0, 1.0, noitaSupported(${E.STONE}, 0.0)));
}`;
const flags = new Float32Array(4);
new WgslExec(new WgslParser().parse(unsupported)).dispatchWorkgroups('main', 1, { 0: { 0: flags } });
assert.deepEqual([...flags], [0, 0, 0, 1], 'unlisted elements keep the Realistic look');

if (process.argv.includes('--swatches')) {
  const file = process.argv[process.argv.indexOf('--swatches') + 1];
  const cols = 6, scale = 4, pad = 4, cell = N * scale + pad, rows = Math.ceil(keys.length / cols);
  const w = cols * cell, h = rows * cell, rgb = Buffer.alloc(w * h * 3, 24);
  keys.forEach((key, li) => {
    const ox = (li % cols) * cell, oy = Math.floor(li / cols) * cell;
    for (let y = 0; y < N * scale; y++) for (let x = 0; x < N * scale; x++) {
      const i = li * N * N + Math.floor(y / scale) * N + Math.floor(x / scale);
      for (let k = 0; k < 3; k++) rgb[((oy + y) * w + ox + x) * 3 + k] = srgb(out[i * 4 + k]);
    }
  });
  writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]));
  console.log(`swatches: ${keys.join(', ')} → ${file}`);
}

// ---- every generated module that carries the artwork compiles ----
const modules = [...renderChecks().filter((e) => e.view === 'noita').map((e) => [e.name, e.code(g)]), ...farModules,
  ['texels.noita', texels], ['mat.noita', matCode]];
for (const [name, code] of modules) {
  assert.equal((code.match(/fn noitaMat\(/g) || []).length, 1, `${name}: helper defined once`);
  if (process.argv.includes('--validate-wgsl')) {
    const result = nagaSpawn(code, `${name}.wgsl`, {encoding: 'utf8'});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
  }
}
console.log(`Noita view: picker/defaults, exclusive styles, ${keys.length} measured looks through the real WGSL, ${Object.keys(looks).length} Descent variant labels${process.argv.includes('--validate-wgsl') ? `, Naga over ${modules.length} modules` : ''} passed.`);
