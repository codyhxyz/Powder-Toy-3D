import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appearanceRegion, packAppearancePlanes, uploadAppearance, SOURCE_APPEARANCE_ENABLED } from '../src/gfx/sourceAppearance.js';
import { volumeFrag, WGSL_CHECK as volumeChecks } from '../src/shaders/render.js';
import { WGSL_CHECK as farChecks, farFrag, farLayout } from '../src/shaders/far.js';
import { sourceAppearanceWGSL, sourceShadeWGSL } from '../src/shaders/gfx/sourceAppearance.js';
import { gridLayout } from '../src/sim.js';
import { validateAppearance } from '../src/world/import/appearance.js';
import { APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
import { appearanceFixture } from './appearance-fixture.mjs';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { crueltyFrameSettings } from '../src/gfx/crueltyDisplay.js';
import { FrameUniformsStruct, writeFrameUniforms } from '../src/gfx/uniforms.js';
import { volumeShaderGrid } from '../src/gfx/volume.js';
import { Matrix4, Vector3, PerspectiveCamera } from 'three/webgpu';
import { nagaSpawn } from './naga.mjs';
// Match CI's pinned native WGSL validator. Reflection alone cannot validate
// these full shaders (wgsl_reflect currently rejects valid vector constants).
const naga = spawnSync('naga', ['--version'], { encoding: 'utf8' });
assert.equal(naga.status, 0, 'Install the CPU validator: cargo install naga-cli --version 30.0.1 --locked');
assert.equal(naga.stdout.trim(), '30.0.1', 'Use the same Naga version as deployment');

test('appearance words survive the shared rgba16uint far-grid tail bit-exactly', () => {
  const words = Uint32Array.from({ length: 101 }, (_, i) => (i * 0x9876543) >>> 0);
  const r = appearanceRegion([3, 5, 4], words.length);
  const packed = packAppearancePlanes(words, r);
  for (let i = 0; i < words.length; i++) {
    const t = Math.floor(i / 2), x = t % 3, z = Math.floor(t / 3) % 4, y = Math.floor(t / 12);
    const at = 4 * (x + 3 * (y + r.planes * z)) + (i % 2) * 2;
    assert.equal((packed[at] | packed[at + 1] << 16) >>> 0, words[i]);
  }
  const writes = [];
  uploadAppearance({ queue: { writeTexture(...args) { writes.push(args); } } }, {}, words, r);
  assert.deepEqual(writes[0][0].origin, [0, 5, 0]);
  assert.deepEqual(writes[0][3], [3, r.planes, 4]);
  assert.deepEqual(appearanceRegion([3, 5, 4], 0).size, [3, 5, 4]);
  assert.throws(() => appearanceRegion([3, 5, 4], 100, 6), /texture limit/);
  assert.throws(() => packAppearancePlanes(words.subarray(1), r), /word count/);
});

test('the actual frame writer packs the source descriptor and bool as WGSL integers', () => {
  let written;
  const gpu = { _frameUniforms: { uniforms: { write(values) { written = values; } },
    last: { viewProj: new Matrix4(), invViewProj: new Matrix4(), model: new Matrix4(), eye: new Vector3(), written: false } } };
  writeFrameUniforms(gpu, { camera: new PerspectiveCamera(), model: new Matrix4(), sun: new Vector3(0, 1, 0),
    view: 0, sourceAppearance: [61, 5391134, 136, 148], sourceStyle: true });
  const bytes = new DataView(FrameUniformsStruct.pack(written));
  [61, 5391134, 136, 148].forEach((n, i) => assert.equal(bytes.getUint32(FrameUniformsStruct.offsets.sourceAppearance + 4 * i, true), n));
  assert.equal(bytes.getUint32(FrameUniformsStruct.offsets.sourceStyle, true), 1);
});

test('appearance validation checks shader-addressed geometry, lists and textures', () => {
  const { map, words } = appearanceFixture();
  assert.equal(validateAppearance(map, words), words);
  for (const [offset, value] of [[64, 99999], [66, 999], [70, 999], [91, 1], [92, 999999], [106, 999], [110, 999], [75, 0x7f800000]]) {
    const bad = words.slice(); bad[offset] = value;
    assert.throws(() => validateAppearance(map, bad), `word ${offset} must be checked`);
  }
  assert.throws(() => validateAppearance({ ...map, brickDims: [2, 1, 1] }, words), /header/);
  for (const key of ['maxBrickTriangles', 'lightCount']) {
    const bad = words.slice(); bad[H[key]] = 999999;
    assert.throws(() => validateAppearance(map, bad), /work bounds/);
  }
});

test('all published source payloads validate and contain their declared exact pixels', () => {
  const root = new URL('../public/local-maps/', import.meta.url);
  for (const id of ['paradise', 'pharmakokinetiks', 'androgenAssault', 'apartmentAtrocity']) {
    const map = JSON.parse(readFileSync(new URL(`${id}.json`, root)));
    const raw = gunzipSync(readFileSync(new URL(map.appearance.dataFile, root)));
    assert.equal(createHash('sha256').update(raw).digest('hex'), map.appearance.sha256);
    const words = new Uint32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    validateAppearance(map, words);
    for (const t of map.appearance.textures) {
      const pixels = raw.subarray(t.at * 4, (t.at + t.words) * 4);
      assert.equal(createHash('sha256').update(pixels).digest('hex'), t.sha256);
    }
    assert(map.appearance.materialCount > 1);
    assert(map.appearance.sources.some(s => s.path.endsWith('.tscn')));
  }
});

test('source artwork and geometry prepare together once, retaining the interaction state', async () => {
  const root = new URL('../public/local-maps/', import.meta.url);
  const map = JSON.parse(readFileSync(new URL('apartmentAtrocity.json', root)));
  const savedFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(readFileSync(new URL(new URL(url).pathname.split('/').at(-1), root)));
  };
  try {
    const scene = createImportedMapScene(map, null, { dataURL: 'https://example.test/maps/apartmentAtrocity.binpack' });
    await Promise.all([scene.prepare(), scene.prepare()]);
    await scene.prepare();
    assert.equal(SOURCE_APPEARANCE_ENABLED, true);
    assert.deepEqual(urls, ['https://example.test/maps/apartmentAtrocity.binpack', 'https://example.test/maps/apartmentAtrocity.appearance.binpack']);
    assert(scene.appearanceWords.length > 0);
    assert(scene.data().words.length > 0);
    assert(scene.interactionState, 'door state still shares the loaded geometry');
  } finally { globalThis.fetch = savedFetch; }
});

// Production generators, with capability taken from source fixture metadata.
// All numerical/validation work here is CPU-only; no WebGPU/browser is started.
const g = gridLayout(128, 128, 128), world = [1088, 488, 1184], L = farLayout(world);
const sourceScene = { importManifest: appearanceFixture().map };
const sourceGrid = volumeShaderGrid(g, world, !!sourceScene.importManifest.appearance);
const ordinaryGrid = volumeShaderGrid(g, world);
const variants = [
  ...['realistic', 'cozy'].flatMap(view => [false, true].map(curved => ({
    name: `near-${view}${curved ? '-curved' : ''}`,
    ordinary: volumeFrag(ordinaryGrid, { view, curved }),
    source: volumeFrag(sourceGrid, { view, curved }),
  }))),
  ...[false, true].map((curved) => ({
    name: `far-view${curved ? '-curved' : ''}`,
    ordinary: farFrag(g, L, { curved }),
    source: farFrag(g, L, { curved, sourceAppearance: true }),
  })),
];
const expensiveSource = /fn source(?:Pair|Word|Float|Vec4|Pixel|Texture|Environment|Diffuse)\(/;
const bindings = code => code.match(/@group\(\d+\)\s*@binding\(\d+\)[^;]*;/g);

test('ordinary worlds, boxes and default WGSL checks omit source geometry, pixels and lights', () => {
  assert.equal(ordinaryGrid.sourceAppearance, false);
  assert.equal(volumeShaderGrid(g, null, true).sourceAppearance, false, 'boxes cannot bind source artwork');
  for (const { name, ordinary, source } of variants) {
    assert.doesNotMatch(ordinary, expensiveSource, name);
    assert(!ordinary.includes(sourceShadeWGSL), `${name}: no source light loop`);
    assert.match(ordinary, /fn sourceEnabled\(\) -> bool { return false; }/);
    assert.notEqual(ordinary, source, `${name}: text-keyed shader caches cannot alias the variants`);
    assert.deepEqual(bindings(ordinary), bindings(source), `${name}: binding ABI is unchanged`);
  }
  for (const check of [...volumeChecks(), ...farChecks()]) {
    assert.doesNotMatch(check.code(g), expensiveSource, `default WGSL check: ${check.name}`);
  }
  assert.doesNotMatch(volumeFrag(volumeShaderGrid(g, null)), expensiveSource);
  assert.equal(g.sourceAppearance, undefined, 'specialization never mutates simulation dimensions');
});

test('source near/far variants preserve the optimized original reader, lighting and filtering', () => {
  for (const { name, source } of variants) {
    assert(source.includes(sourceAppearanceWGSL(true, L.bricks.n)), `${name}: exact optimized source reader`);
    assert(source.includes(sourceShadeWGSL), `${name}: original source light/material models`);
    const sample = source.slice(source.indexOf('fn sourceTexture'), source.indexOf('struct SourceMaterial'));
    assert.equal((sample.match(/sourcePixel\(/g) ?? []).length, 1, 'one native sampling call site for all four original taps');
    assert.match(sample, /mix\(mix\(taps\[0\], taps\[1\]/);
    assert.match(source, /FU.sourceStyle != 0u && FU.sourceAppearance.y >= 64u/, 'runtime style still gates source maps');
  }
  const specialized = volumeFrag({ ...sourceGrid, sourceGrid: [3, 5, 4] });
  assert.match(specialized, /let x = 3u;\s+let z = 4u;/, 'fixed world atlas dimensions reach native compilation');
  assert.deepEqual(sourceGrid.sourceGrid, [272, 122, 296], 'far atlas uses four-cell bricks, not the source directory’s eight-cell bricks');
  assert.deepEqual(volumeShaderGrid(g, null).sourceGrid, [1, 1, 1]);
  assert.equal(g.sourceGrid, undefined);
});

for (const { name, ordinary, source } of variants) {
  for (const [capability, code] of [['ordinary', ordinary], ['source', source]]) {
    test(`Naga validates ${name} ${capability} (CPU only)`, () => {
      const result = nagaSpawn(code, `${name}-${capability}.wgsl`, {encoding: 'utf8', timeout: 30000});
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    });
  }
}

test('source normal ignores saved night effect without changing the saved setting', () => {
  const saved = { cruelty: true, night: 0.9 };
  assert.equal(crueltyFrameSettings(saved).night, 0);
  assert.equal(saved.night, 0.9);
});

test('source adapter retains shared near/far call sites behind the compile-time gate', () => {
  const surface = readFileSync(new URL('../src/shaders/gfx/surface.js', import.meta.url), 'utf8');
  const far = readFileSync(new URL('../src/shaders/far.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const worldFar = readFileSync(new URL('../src/world/far.js', import.meta.url), 'utf8');
  assert.match(app, /createVolume\(gpu, sim, \{[^\n]*sourceAppearance: !mapKind\.presets && !!sceneByKey\(settings.scene\).importManifest\?\.appearance/, 'near capability follows selected scene metadata, not mode/style');
  assert.match(worldFar, /this.sourceAppearance = SOURCE_APPEARANCE_ENABLED && !!win.scene.importManifest\?\.appearance/);
  assert.match(worldFar, /farFrag\(this.sim.g, this.L, \{ curved, sourceAppearance: this.sourceAppearance \}\)/);
  assert.match(surface, /sourceMaterial\(id, p, n\)/);
  assert(surface.indexOf('let original = sourceMaterial') < surface.indexOf('if (FU.matDetail < 0.5)'));
  assert.match(far, /sourceShade\(p, normalize\(m.sourceNormal\)/);
  assert.match(app, /sourceStyle: selectedMode === 'crueltySquad' && isMaterialView\(view\)/);
  assert.match(app, /post\.settings\.cruelty = selectedMode === 'crueltySquad' && isMaterialView\(view\)/);
});
