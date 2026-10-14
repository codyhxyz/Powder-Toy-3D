import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseGodot3Scene, parseGodot3Resource, decodeSurface, halfFloat, embeddedMeshes } from '../src/world/import/godot3.js';
import { voxelizeMeshes, importedCell, triangleIntersectsCell } from '../src/world/import/voxelize.js';
import { APPEARANCE_VERSION, APPEARANCE_HEADER as H, APPEARANCE_HEADER_WORDS, APPEARANCE_TRIANGLE_WORDS as TW, APPEARANCE_MATERIAL_WORDS as MW, APPEARANCE_LIGHT_WORDS, APPEARANCE_FLAGS as F, APPEARANCE_MODES as M } from '../src/world/import/appearanceFormat.js';
import { AppearanceResources, sha256 } from './appearance-resources.mjs';
import { AppearanceConversion, triangleAffine, extractLighting, littleEndianWords } from './appearance-conversion.mjs';
import { convertCrueltyMap, writeConvertedMap } from './import-cruelty-map.mjs';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const evalAffine = (a, p) => a[0] * p[0] + a[1] * p[1] + a[2] * p[2] + a[3];
function stream(format, uv = [0x3c00, 0xc000]) {
  const stride = format === 97559 ? 24 : 36, data = Buffer.alloc(3 * stride);
  for (let i = 0; i < 3; i++) {
    [i, i + 0.25, -i].forEach((v, k) => data.writeFloatLE(v, i * stride + k * 4));
    data.writeUInt16LE(uv[0], i * stride + 20); data.writeUInt16LE(uv[1], i * stride + 22);
    if (stride === 36) data.fill(0xff, i * stride + 24, (i + 1) * stride);
  }
  return `{
"array_data": PoolByteArray( ${[...data]} ),
"array_index_data": PoolByteArray( 2, 0, 1, 0, 0, 0 ),
"format": ${format},
"vertex_count": 3,
"index_count": 3,
"primitive": 4
}`;
}
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tpt-appearance-check-'));
  try {
    const put = (name, text) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text); };
    const png = (name, color = '#123456', size = '2x1') => {
      const result = spawnSync('magick', ['-size', size, `xc:${color}`, join(root, name)]);
      assert.equal(result.status, 0, result.stderr.toString());
      put(`${name}.import`, '[params]\nflags/repeat=true\nflags/filter=false\nflags/mipmaps=false\nflags/srgb=1\nsize_limit=0\n');
    };
    return fn({ root, put, png });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const emptyScene = () => parseGodot3Scene(`[gd_scene format=2]
[sub_resource type="Environment" id=9]
ambient_light_color = Color( 0.2, 0.3, 0.4, 1 )
[node name="Root" type="Spatial"]
[node name="Environment" type="WorldEnvironment" parent="."]
environment = SubResource( 9 )
`);
const surface = (material = null) => ({ material, materialPath: '__default__', format: 97559, nodePath: 'Terrain', sourceSurface: 'surfaces/0', positions: new Float64Array([0, 0, 0, 12, 0, 0, 0, 0, 12]), indices: new Uint32Array([0, 1, 2]), uvs: new Float64Array([0, 0, 1, 0, 0, 1]), uvBits: new Uint16Array(6) });

test('ABI constants and both verified Godot half-UV layouts preserve position/index output', () => {
  assert.equal(APPEARANCE_VERSION, 1); assert.equal(APPEARANCE_HEADER_WORDS, 64); assert.equal(TW, 24); assert.equal(MW, 32); assert.equal(APPEARANCE_LIGHT_WORDS, 16);
  close(halfFloat(1), 2 ** -24); close(halfFloat(0x7bff), 65504); assert.ok(Object.is(halfFloat(0x8000), -0)); assert.equal(halfFloat(0x7c00), Infinity); assert.ok(Number.isNaN(halfFloat(0x7e00)));
  for (const format of [97559, 97495]) {
    const s = decodeSurface(stream(format));
    assert.deepEqual([...s.positions], [0, 0.25, -0, 1, 1.25, -1, 2, 2.25, -2]);
    assert.deepEqual([...s.indices], [2, 1, 0]); assert.deepEqual([...s.uvs], [1, -2, 1, -2, 1, -2]);
    assert.equal(s.uvBits[0], 0x3c00);
  }
  assert.equal(decodeSurface(stream(97559, [0x7c00, 0])).uvs[0], Infinity, 'undefined UV does not break legacy physics');
  assert.throws(() => decodeSurface(stream(97559).replace('97559', '97560')), /Unsupported Godot ArrayMesh/);
});

test('shared parser handles standalone roots, nested references and multiline group headers', () => {
  const resource = parseGodot3Resource(`[gd_resource type="SpatialMaterial" format=2]
[ext_resource path="res://tex.png" type="Texture" id=1]
[sub_resource type="AnimatedTexture" id=1]
frames = 1
frame_0/texture = ExtResource( 1 )
[resource]
albedo_texture = SubResource( 1 )
uv1_scale = Vector3( 2, 3, 1 )
`);
  assert.equal(resource.resources.get('root').type, 'SpatialMaterial'); assert.equal(resource.resources.get(1).type, 'AnimatedTexture');
  const scene = parseGodot3Scene(`[gd_scene format=2]
[node name="Root" type="Spatial" groups=[
"world_nav",
]]
transform = Transform( 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0 )
[node name="Child" type="Spatial" parent="."]
`);
  assert.ok(scene.nodes.has('.')); assert.equal(scene.nodes.get('Child').unresolvedParent, false); assert.equal(scene.nodes.get('Child').worldTransform[9], 10);
  assert.throws(() => parseGodot3Scene('[gd_resource type="SpatialMaterial" format=2]\n[resource]'), /Expected.*tscn/);
});

test('UV and barycentric affine mapping are exact on tilted, translated world-cell triangles', () => {
  const t = [[17, -9, 21], [19, -8, 24], [15, -5, 23]], uv = [[-2, 3], [4, 8], [-7, -1]];
  const a = triangleAffine(t, uv);
  const bary = [0.2, 0.35], p = t[0].map((v, k) => v + bary[0] * (t[1][k] - v) + bary[1] * (t[2][k] - v));
  close(evalAffine(a.baryU, p), bary[0]); close(evalAffine(a.baryV, p), bary[1]);
  for (let k = 0; k < 2; k++) close(evalAffine(k ? a.v : a.u, p), uv[0][k] + bary[0] * (uv[1][k] - uv[0][k]) + bary[1] * (uv[2][k] - uv[0][k]));
  close(Math.hypot(...a.normal.slice(0, 3)), 1);
  close(a.normal.slice(0, 3).reduce((s, v, k) => s + v * p[k], 0), a.normal[3]);
  assert.throws(() => triangleAffine([[0,0,0],[1,0,0],[2,0,0]], uv), /Degenerate/);
});

test('native PNG bytes/import flags, material identity, animation and unknown forms fail closed', () => fixture(({ root, put, png }) => {
  png('tex.png'); copyFileSync(join(root, 'tex.png'), join(root, 'same.png')); copyFileSync(join(root, 'tex.png.import'), join(root, 'same.png.import'));
  put('mat.tres', `[gd_resource type="SpatialMaterial" format=2]
[ext_resource path="res://tex.png" type="Texture" id=1]
[ext_resource path="res://same.png" type="Texture" id=2]
[sub_resource type="AnimatedTexture" id=1]
flags = 18
frames = 2
fps = 23.0
frame_0/texture = ExtResource( 1 )
frame_1/texture = ExtResource( 2 )
[resource]
albedo_texture = SubResource( 1 )
albedo_color = Color( 0.25, 0.5, 0.75, 1 )
uv1_scale = Vector3( 2, 3, 1 )
uv1_offset = Vector3( -1, 0.5, 0 )
roughness = 0.1
metallic = 0.8
metallic_specular = 0.7
roughness_texture = ExtResource( 1 )
roughness_texture_channel = 4
`);
  const r = new AppearanceResources(root), c = r.load('res://mat.tres');
  const s = { material: { kind: 'SubResource', id: 'root' }, materialPath: 'physical-only' }, m = r.material(c, s, 7);
  assert.equal(m.identity, 'res://mat.tres::root'); assert.equal(m.physicalPath, 'physical-only'); assert.equal(m.texture.frameCount, 2); assert.equal(m.texture.fps, 23);
  assert.deepEqual(m.scale, [2, 3, 1]); assert.deepEqual(m.offset, [-1, 0.5, 0]); assert.equal(m.mode, M.spatial);
  assert.ok(m.flags & F.repeat); assert.ok(m.flags & F.srgb); assert.ok(!(m.flags & F.filter)); assert.equal(m.roughness, 0.1); assert.equal(m.specular, 0.7);
  assert.equal(m.texture.pixels.length, 16); assert.equal(m.texture.pixels.readUInt32LE(0), 0xff563412); assert.equal(m.texture.pixels.readUInt32LE(8), 0xff563412);
  assert.equal(m.roughnessTexture.width, 2); assert.equal(m.roughnessChannel, 4);
  assert.ok(r.provenance().every(s => s.sha256.length === 64));
  c.scene.resources.get(1).props['frame_1/delay_sec'] = '0.1'; assert.throws(() => r.material(c, s, 7), /nonuniform/);
  c.scene.resources.get(1).props['frame_1/delay_sec'] = '0';
  png('different.png', '#123456', '1x1'); c.scene.external.get(2).path = 'res://different.png'; assert.throws(() => r.material(c, s, 7), /dimensions differ/);
  c.resource.props.normal_enabled = 'true'; assert.throws(() => r.material(c, s, 7), /Unsupported SpatialMaterial/);
  put('unknown.tres', '[gd_resource type="ShaderMaterial" format=2]\n[sub_resource type="Shader" id=1]\ncode = "shader_type spatial; void fragment() { ALBEDO=vec3(1.0); }"\n[resource]\nshader = SubResource( 1 )\n');
  assert.throws(() => r.material(r.load('res://unknown.tres'), s, 7), /Unsupported source shader.*sha256=/);
  put('bad.tres', '[gd_resource type="CanvasItemMaterial" format=2]\n[resource]\n'); assert.throws(() => r.material(r.load('res://bad.tres'), s, 7), /Unsupported material CanvasItemMaterial/);
  put('animation.tres', '[gd_resource type="AnimatedTexture" format=2]\n[ext_resource path="res://tex.png" type="Texture" id=1]\n[resource]\nframes = 1\nframe_0/texture = ExtResource( 1 )\n');
  c.scene.external.set(3, { type: 'Texture', path: 'res://animation.tres' }); assert.equal(r.texture(c, 'ExtResource( 3 )').frameCount, 1);
  put('known.tres', '[gd_resource type="ShaderMaterial" format=2]\n[sub_resource type="Shader" id=1]\ncode = "shader_type spatial;\nrender_mode unshaded;"\n[resource]\nshader = SubResource( 1 )\n');
  const unshaded = r.material(r.load('res://known.tres'), s, 7); assert.equal(unshaded.mode, M.unshaded); assert.ok(unshaded.flags & F.unshaded); assert.equal(unshaded.texture, undefined);
  assert.throws(() => r.disk('res://../escape'), /escapes root/);
}));

test('generic RSCC/RSRC adapter requires GDRE, uses text parser and preserves binary hash', () => fixture(({ root, put }) => {
  put('binary.material', Buffer.from('RSCCoriginal-binary-data'));
  assert.throws(() => new AppearanceResources(root, { gdre: '' }).load('res://binary.material'), /configure --gdre/);
  const script = join(root, 'fake-gdre');
  put('fake-gdre', `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --output=*) out="\${arg#--output=}";; esac; done\nprintf '[gd_resource type="SpatialMaterial" format=2]\\n[resource]\\nroughness = 0.5\\n' > "$out/binary.material"\n`); chmodSync(script, 0o755);
  const r = new AppearanceResources(root, { gdre: script }), loaded = r.load('res://binary.material');
  assert.equal(loaded.resource.type, 'SpatialMaterial'); assert.equal(loaded.resource.props.roughness, '0.5'); assert.equal(r.provenance()[0].sha256, sha256(readFileSync(join(root, 'binary.material'))));
}));

test('same SAT walk feeds physics and appearance, including overlaps and exact zero-based pointers', () => fixture(({ root }) => {
  const a = surface(), b = { ...surface(), materialPath: 'second' }, ignored = { ...surface(), materialPath: 'empty' };
  const meshes = [{ surfaces: [a, b, ignored] }], mapping = { __default__: 1, second: 2, empty: 0 }, r = new AppearanceResources(root), scene = emptyScene();
  const make = () => {
    const c = new AppearanceConversion(r, r.context(scene, 'res://fixture.tscn'), meshes, mapping), hits = [];
    const map = voxelizeMeshes(meshes, mapping, { cellMeters: 1, padding: 2, onTriangle: info => { const hit = c.onTriangle(info); return p => { hits.push([...p]); hit(p); }; } });
    return { map, hits, packed: c.pack(map) };
  };
  const { map, hits, packed } = make(), words = packed.words;
  assert.deepEqual(words, make().packed.words, 'byte-for-byte deterministic conversion');
  assert.equal(words[H.version], 1); assert.equal(words[H.totalWords], words.length); assert.equal(words[H.triangleCount], 2);
  assert.equal(words[H.materialCount], 2); assert.equal(words[H.materialsAt], words[H.trianglesAt] + 2 * TW);
  assert.equal(words[H.lightsAt], words[H.materialsAt] + 2 * MW); assert.equal(words[H.environmentAt], words[H.lightsAt]);
  const t = [0, 1, 2].map(i => [...a.positions.slice(i * 3, i * 3 + 3)].map((v, k) => v - map.origin[k]));
  const expected = [];
  for (let z = 0; z < map.size[2]; z++) for (let y = 0; y < map.size[1]; y++) for (let x = 0; x < map.size[0]; x++) if (triangleIntersectsCell(t, [x,y,z])) expected.push(`${x},${y},${z}`);
  assert.deepEqual([...new Set(hits.map(p => p.join(',')))].sort(), expected.sort());
  for (const p of hits) assert.equal(importedCell(map, map.words, ...p), 2, 'stable overlap precedence, not callback state');
  let max = 0, seen = 0;
  for (let k = 0; k < map.brickDims.reduce((a,b) => a*b, 1); k++) {
    const at = words[words[H.directoryAt] + k];
    assert.equal(Boolean(at), Boolean(map.words[k]));
    if (!at) continue;
    seen++; assert.ok(at >= words[H.directoryAt] + map.brickDims.reduce((a,b) => a*b, 1)); assert.ok(at + words[at] < words[H.trianglesAt]);
    assert.deepEqual([...words.slice(at + 1, at + 1 + words[at])], [0, 1]); max = Math.max(max, words[at]);
  }
  assert.equal(seen, map.stats.bricks); assert.equal(words[H.maxBrickTriangles], max);
  const raw = littleEndianWords(words); assert.equal(raw.readUInt32LE(0), 1); assert.deepEqual(gunzipSync(gzipSync(raw, { level: 9 })), raw); assert.deepEqual(gzipSync(raw), gzipSync(littleEndianWords(make().packed.words)));
}));

test('material UV scale/offset baked, RGBA texture storage deduped across identities and PBR map', () => fixture(({ root, put, png }) => {
  png('tex.png'); copyFileSync(join(root, 'tex.png'), join(root, 'same.png')); copyFileSync(join(root, 'tex.png.import'), join(root, 'same.png.import'));
  const scene = emptyScene();
  scene.external.set(1, { type: 'Texture', path: 'res://tex.png' }); scene.external.set(2, { type: 'Texture', path: 'res://same.png' });
  scene.resources.set(1, { type: 'SpatialMaterial', props: { albedo_texture: 'ExtResource( 1 )', uv1_scale: 'Vector3( 2, 3, 1 )', uv1_offset: 'Vector3( -1, 0.5, 0 )', roughness_texture: 'ExtResource( 2 )', roughness_texture_channel: '4' } });
  scene.resources.set(2, { type: 'SpatialMaterial', props: { albedo_texture: 'ExtResource( 2 )' } });
  const s = surface({ kind: 'SubResource', id: 1 }), s2 = surface({ kind: 'SubResource', id: 2 }), meshes = [{ surfaces: [s,s2] }], r = new AppearanceResources(root);
  const c = new AppearanceConversion(r, r.context(scene, 'res://fixture.tscn'), meshes, { __default__: 7 });
  const map = voxelizeMeshes(meshes, { __default__: 7 }, { cellMeters: 1, padding: 2, onTriangle: c.onTriangle }), p = c.pack(map), w = p.words, f = new Float32Array(w.buffer), t = w[H.trianglesAt], m = w[H.materialsAt];
  assert.equal(p.metadata.textures.length, 1); assert.equal(w[m], w[m + MW]); assert.equal(w[m], w[m + 22]); assert.equal(w[m + 25], 4); assert.equal(w[w[m]], 0xff563412);
  const p0 = [...f.slice(t,t+3)], u = [...f.slice(t+4,t+8)], v = [...f.slice(t+8,t+12)]; close(evalAffine(u, p0), -1); close(evalAffine(v, p0), 0.5);
  close(evalAffine(u, [p0[0]+12,p0[1],p0[2]]), 1); close(evalAffine(v, [p0[0],p0[1],p0[2]+12]), 3.5);
  assert.equal(p.metadata.materials[0].identity, 'res://fixture.tscn::1');
}));

test('undefined half UV triangles omitted explicitly, never break legacy physics or sanitize art', () => fixture(({ root }) => {
  const s = surface(); s.uvs[0] = Infinity; s.uvBits[0] = 0x7c00;
  const meshes = [{ surfaces: [s] }], r = new AppearanceResources(root), c = new AppearanceConversion(r, r.context(emptyScene(), 'res://fixture.tscn'), meshes, { __default__: 1 });
  const map = voxelizeMeshes(meshes, { __default__: 1 }, { cellMeters: 1, padding: 2, onTriangle: c.onTriangle }), p = c.pack(map);
  assert.ok(map.stats.cells > 0); assert.equal(p.metadata.triangleCount, 0); assert.equal(p.metadata.occupiedBricks, 0);
  assert.deepEqual(p.metadata.losses, [{ reason: 'source-nonfinite-uv', node: 'Terrain', surface: 'surfaces/0', material: '__default__', physicalPath: '__default__', triangleCount: 1, fallback: 'physical-substrate', evidence: [{ vertex: 0, component: 0, format: 97559, byteOffset: 20, halfBits: '0x7c00' }] }]);
}));

test('generic transformed lights, panorama/environment and source script defaults recorded', () => fixture(({ root, put, png }) => {
  png('sky.png'); put('sky.gd', 'extends WorldEnvironment\nexport var rotation_speed = 0.07\nexport var z = true\n');
  const scene = parseGodot3Scene(`[gd_scene format=2]
[ext_resource path="res://sky.png" type="Texture" id=1]
[ext_resource path="res://sky.gd" type="Script" id=2]
[sub_resource type="PanoramaSky" id=1]
panorama = ExtResource( 1 )
[sub_resource type="Environment" id=2]
background_mode = 2
background_sky = SubResource( 1 )
ambient_light_color = Color( 0.2, 0.3, 0.4, 1 )
ambient_light_energy = 2.0
fog_enabled = true
fog_depth_begin = 5.0
fog_depth_end = 60.0
[node name="Root" type="Spatial"]
transform = Transform( 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30 )
[node name="Environment" type="WorldEnvironment" parent="."]
environment = SubResource( 2 )
script = ExtResource( 2 )
[node name="Sun" type="DirectionalLight" parent="."]
light_energy = 1.72
[node name="Lamp" type="OmniLight" parent="."]
light_color = Color( 1, 0, 0, 1 )
omni_range = 6.0
[node name="Spot" type="SpotLight" parent="."]
spot_range = 9.0
spot_angle = 30.0
shadow_enabled = true
[node name="Hidden" type="OmniLight" parent="."]
visible = false
`);
  const r = new AppearanceResources(root), lighting = extractLighting(r, r.context(scene, 'res://fixture.tscn'), { origin: [1,2,3], cellMeters: 0.5 });
  assert.deepEqual(lighting.lights.map(l => l.type), [1,0,2]); assert.deepEqual(lighting.lights[1].position, [19,38,57]); assert.deepEqual(lighting.lights[0].direction, [-0,-0,-1]);
  assert.equal(lighting.lights[1].range, 12); assert.equal(lighting.lights[2].range, 18); assert.equal(lighting.lights[2].angle, 30); assert.equal(lighting.lights[2].shadow, 1);
  assert.equal(lighting.environment.begin, 10); assert.equal(lighting.environment.end, 120); assert.equal(lighting.environment.rotationSpeed, 0.07); assert.equal(lighting.environment.rotationAxis, 1); assert.equal(lighting.environment.panorama.width, 2);
  scene.resources.get(1).type = 'ProceduralSky'; assert.throws(() => extractLighting(r, r.context(scene, 'res://fixture.tscn'), { origin:[0,0,0], cellMeters:1 }), /Unsupported sky/);
}));

test('writer confines generated asset output to public/local-maps', async () => {
  await assert.rejects(writeConvertedMap({ manifest: {}, words: new Uint32Array(1) }, '/tmp/not-public'), /public\/local-maps/);
});

// Optional real-source CPU integration: never write generated assets. Verify
// canonical names, no geometry changes, all pointers, explicit Level4 loss.
if (process.env.CRUELTY_SOURCE_ROOT) for (const profile of CRUELTY_PROFILES.filter(p => !p.blocked)) test(`recovered original ${profile.name}: appearance and unchanged physics`, () => {
  const root = process.env.CRUELTY_SOURCE_ROOT, info = JSON.parse(readFileSync(join(root, 'Levels', `Level${profile.level}.json`), 'utf8'));
  assert.equal(info.name, profile.name);
  const text = readFileSync(join(root, 'Levels', `Level${profile.level}.tscn`), 'utf8');
  const converted = convertCrueltyMap(text, profile, { sourceRoot: root }), legacy = convertCrueltyMap(text, profile);
  assert.deepEqual(converted.words, legacy.words); assert.deepEqual(converted.manifest.mission, legacy.manifest.mission);
  const w = converted.appearanceWords, a = converted.manifest.appearance, bricks = converted.manifest.brickDims.reduce((a,b) => a*b, 1);
  assert.equal(w.length, a.wordCount); assert.equal(w[H.triangleCount], a.triangleCount); assert.ok(a.materials.every(m => m.identity && m.physicalPath));
  for (let k = 0; k < bricks; k++) {
    const at = w[w[H.directoryAt] + k]; if (!at) continue;
    assert.ok(converted.words[k]); assert.ok(at >= w[H.directoryAt] + bricks && at + w[at] < w[H.trianglesAt]);
    for (const index of w.subarray(at + 1, at + 1 + w[at])) assert.ok(index < a.triangleCount);
  }
  for (const m of a.materials) for (const at of [m.textureAt, m.roughnessTextureAt, m.metallicTextureAt].filter(Boolean)) assert.ok(at >= w[H.environmentAt] + 32 && at < w.length);
  assert.equal(a.losses.reduce((n,l) => n+l.triangleCount,0), profile.level === 4 ? 240 : 0);
  assert.ok(a.sources.some(s => s.path === `res://Levels/Level${profile.level}.tscn`));
});
