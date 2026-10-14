import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { appearanceRegion, packAppearancePlanes, uploadAppearance } from '../src/gfx/sourceAppearance.js';
import { validateAppearance } from '../src/world/import/appearance.js';
import { APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
import { appearanceFixture } from './appearance-fixture.mjs';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { crueltyFrameSettings } from '../src/gfx/crueltyDisplay.js';
import { FrameUniformsStruct, writeFrameUniforms } from '../src/gfx/uniforms.js';
import { Matrix4, Vector3, PerspectiveCamera } from 'three/webgpu';

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

test('appearance loading is coalesced with geometry and retained across repeated prepare', async () => {
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
    assert.equal(urls.length, 2);
    assert.equal(scene.appearanceWords.length, map.appearance.totalWords);
    assert(urls.includes('https://example.test/maps/apartmentAtrocity.appearance.binpack'));
  } finally { globalThis.fetch = savedFetch; }
});

test('source normal ignores saved night effect without changing the saved setting', () => {
  const saved = { cruelty: true, night: 0.9 };
  assert.equal(crueltyFrameSettings(saved).night, 0);
  assert.equal(saved.night, 0.9);
});

test('source artwork uses one shared lookup for the near volume and far meshes', () => {
  const surface = readFileSync(new URL('../src/shaders/gfx/surface.js', import.meta.url), 'utf8');
  const far = readFileSync(new URL('../src/shaders/far.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(surface, /sourceMaterial\(id, p, n\)/);
  assert(surface.indexOf('let original = sourceMaterial') < surface.indexOf('if (FU.matDetail < 0.5)'));
  assert.match(far, /sourceShade\(p, normalize\(m.sourceNormal\)/);
  assert.match(app, /sourceStyle: selectedMode === 'crueltySquad' && isMaterialView\(view\)/);
  assert.match(app, /post\.settings\.cruelty = selectedMode === 'crueltySquad' && isMaterialView\(view\)/);
});
