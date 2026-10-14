import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { parseGodot3Scene, embeddedMeshes, decodeSurface, transformPoint, numbers } from '../src/world/import/godot3.js';
import { voxelizeMeshes, triangleIntersectsCell, importedCell, sourceToCells } from '../src/world/import/voxelize.js';
import { createImportedMapScene, validateImportedMap } from '../src/world/scenes/importedMap.js';
import { paradiseMission, PARADISE_MATERIALS, PARADISE_NODES } from '../src/world/import/paradise.js';
import { localMapPlugin } from '../scripts/local-map-plugin.mjs';
import { E } from '../src/elements.js';

// These tiny numerical fixtures are original test data, NOT substitutes for
// Paradise. Real copyrighted geometry remains optional and outside git.
function surface(points, format = 97559, indices = [0, 1, 2]) {
  const stride = format === 97495 ? 36 : 24, data = Buffer.alloc(points.length * stride);
  points.forEach((p, i) => p.forEach((v, k) => data.writeFloatLE(v, i * stride + k * 4)));
  const ib = Buffer.alloc(format === 97495 ? 0 : indices.length * 2);
  if (format !== 97495) indices.forEach((v, i) => ib.writeUInt16LE(v, i * 2));
  return `{
"array_data": PoolByteArray( ${[...data].join(', ')} ),
"array_index_data": PoolByteArray( ${[...ib].join(', ')} ),
"format": ${format},
"index_count": ${ib.length / 2},
"material": SubResource( 2 ),
"primitive": 4,
"vertex_count": ${points.length}
}`;
}
const triangle = [[-1, 0, -1], [2, 0, -1], [-1, 0, 2]];
function mesh(points = triangle, materialPath = 'fixture', indices = [0, 1, 2]) { return [{ nodePath: 'test-only', surfaces: [{ positions: points.flat(), indices, materialPath }] }]; }
function sceneText() { return `[gd_scene load_steps=4 format=2]
[ext_resource path="res://fixture.png" type="Texture" id=1]
[sub_resource type="SpatialMaterial" id=2]
albedo_texture = ExtResource( 1 )
[sub_resource type="ArrayMesh" id=3]
surfaces/0 = ${surface(triangle)}
[node name="TestFixture" type="Spatial"]
transform = Transform( 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0 )
[node name="Group" type="Spatial" parent="."]
transform = Transform( 0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 2, 3 )
[node name="Mesh" type="MeshInstance" parent="Group"]
mesh = SubResource( 3 )
[connection signal="unused" from="." to="." method="unused"]
`; }

test('actual Godot3 interleaved vertex formats decode without executing scripts', () => {
  for (const format of [97559, 97495]) {
    const decoded = decodeSurface(surface(triangle, format));
    assert.deepEqual([...decoded.positions], triangle.flat());
    assert.deepEqual([...decoded.indices], [0, 1, 2]);
  }
  assert.throws(() => decodeSurface(surface(triangle).replace('97559', '123')), /Unsupported/);
  assert.throws(() => decodeSurface(surface(triangle, 97559, [0, 1, 3])), /out of range/);
  assert.throws(() => decodeSurface(surface(triangle).replace('"vertex_count": 3', '"vertex_count": 4')), /stream/);
});
test('hierarchical column-major transforms and source material resolution', () => {
  const scene = parseGodot3Scene(sceneText());
  assert.deepEqual(transformPoint(scene.nodes.get('Group/Mesh').worldTransform, [1, 0, 0]), [10, 2, 2]);
  const meshes = embeddedMeshes(scene);
  assert.equal(meshes[0].surfaces[0].materialPath, 'res://fixture.png');
  assert.deepEqual([...meshes[0].surfaces[0].positions.slice(0, 3)], [9, 2, 4]);
  assert.throws(() => parseGodot3Scene(sceneText().replace('format=2', 'format=3')), /format=2/);
});
test('voxel units, negative translation, deterministic packing, strict materials', () => {
  const a = voxelizeMeshes(mesh(), { fixture: E.ROCK });
  const b = voxelizeMeshes(mesh(), { fixture: E.ROCK });
  assert.deepEqual(a.words, b.words);
  assert.deepEqual(sourceToCells(a, [0, 0, 0]), a.origin.map((v) => -v));
  const p = sourceToCells(a, [0, 0, 0]).map(Math.floor);
  assert.equal(importedCell(a, a.words, ...p), E.ROCK);
  assert.equal(importedCell(a, a.words, -1, 0, 0), E.EMPTY);
  assert.throws(() => voxelizeMeshes(mesh(), {}), /Unmapped/);
  assert.throws(() => voxelizeMeshes(mesh(), { fixture: 256 }), /Invalid mapped/);
  assert.throws(() => voxelizeMeshes(mesh(), { fixture: E.ROCK }, { maxCandidates: 1 }), /budget/);
});
test('dominant-axis raster agrees with exhaustive triangle/cell SAT, all orientations', () => {
  const fixtures = [triangle, [[0, -1, -1], [0, 2, -1], [0, -1, 2]], [[-1, -1, 0], [2, -1, 0], [-1, 2, 0]], [[-0.7, 0.8, 0.3], [1.6, -0.4, 1.3], [0.1, 1.9, -1.1]]];
  for (const points of fixtures) {
    const map = voxelizeMeshes(mesh(points), { fixture: E.ROCK }, { cellMeters: 1 });
    const shifted = points.map((p) => p.map((v, k) => v - map.origin[k]));
    let occupied = 0;
    for (let x = 0; x < map.size[0]; x++) for (let y = 0; y < map.size[1]; y++) for (let z = 0; z < map.size[2]; z++) {
      const expected = triangleIntersectsCell(shifted, [x, y, z]);
      assert.equal(importedCell(map, map.words, x, y, z) !== 0, expected, `${points}: ${x},${y},${z}`);
      if (expected) occupied++;
    }
    assert.equal(map.stats.cells, occupied);
  }
});
test('packed-u8 cells cross brick boundaries and preserve explicit overlap order', () => {
  const data = mesh([[0, 0, 0], [10, 0, 0], [0, 0, 10]]);
  data.push(...mesh([[0, 0, 0], [10, 0, 0], [0, 0, 10]], 'glass'));
  const map = voxelizeMeshes(data, { fixture: E.ROCK, glass: E.GLASS }, { cellMeters: 1 });
  for (let i = 0; i < 9; i++) assert.equal(importedCell(map, map.words, ...sourceToCells(map, [i, 0, 0])), E.GLASS);
});
test('scene adapter validates pointers, exposes identical voxel collision cells and WGSL SD lookup', () => {
  const map = voxelizeMeshes(mesh(), { fixture: E.ROCK });
  map.mission = { spawn: sourceToCells(map, [0, 0.9, 0]) };
  const scene = createImportedMapScene(map, map.words);
  assert.deepEqual(scene.size, map.size);
  assert.deepEqual(scene.start(), [map.mission.spawn[0], map.mission.spawn[2]]);
  assert.equal(scene.cell(...sourceToCells(map, [0, 0, 0])), E.ROCK);
  assert.equal(scene.data().words, map.words);
  const reflect = new WgslReflect(scene.glsl());
  assert.equal(reflect.storage[0].group, 2);
  assert.equal(reflect.storage[0].binding, 1);
  const corrupted = map.words.slice(); corrupted[0] = 1;
  assert.throws(() => validateImportedMap(map, corrupted), /pointer/);
  assert.throws(() => validateImportedMap({ ...map, cellMeters: 2 }, map.words), /scale/);
});
test('mission fixture reads authored nodes and local support instead of topmost roof', () => {
  const scene = { nodes: new Map(), external: new Map(), resources: new Map() };
  const t = (p) => [1, 0, 0, 0, 1, 0, 0, 0, 1, ...p];
  for (const path of [PARADISE_NODES.spawn, ...PARADISE_NODES.targets, PARADISE_NODES.extraction]) scene.nodes.set(path, { path, worldTransform: t([0, 1, 0]), props: {} });
  scene.nodes.set('exit-collider', { path: 'exit-collider', parent: PARADISE_NODES.extraction, type: 'CollisionShape', worldTransform: t([0, 1, 0]), props: { shape: 'SubResource( 1 )' } });
  scene.resources.set(1, { type: 'ConvexPolygonShape', props: { points: 'PoolVector3Array( -1, -1, -2, 1, 1, 2 )' } });
  const geometry = [...mesh(), ...mesh(triangle.map((p) => [p[0], 5, p[2]]))];
  const map = voxelizeMeshes(geometry, { fixture: E.ROCK });
  const mission = paradiseMission(scene, map, map.words);
  assert.equal(mission.targets.length, 3); assert.equal(mission.guards.length, 0);
  assert.deepEqual(mission.targets[0].sourceAt, [0, 1, 0]);
  assert.ok(mission.spawn[1] < sourceToCells(map, [0, 5, 0])[1]);
  assert.ok(Math.abs(mission.extraction.height - 2 / map.cellMeters) < 1e-10);
  assert.equal(PARADISE_MATERIALS['res://Maps/textures/base/glass1.tres'], E.GLASS);
  assert.equal(PARADISE_MATERIALS['res://Maps/textures/special/exit.tres'], E.EMPTY);
});
test('dev-only route serves exactly known local files, rejects traversal/methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpt-import-check-'));
  await mkdir(join(root, '.tmp-cruelty-import'));
  await writeFile(join(root, '.tmp-cruelty-import/paradise.json'), '{"local":true}');
  let handler;
  const plugin = localMapPlugin(); assert.equal(plugin.apply, 'serve');
  plugin.configureServer({ config: { root }, middlewares: { use: (f) => { handler = f; } } });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${url}/local-maps/paradise.json`); assert.equal(ok.status, 200); assert.equal(await ok.text(), '{"local":true}');
    assert.equal((await fetch(`${url}/local-maps/%2e%2e/CLAUDE.md`)).status, 404);
    assert.equal((await fetch(`${url}/local-maps/other.json`)).status, 404);
    assert.equal((await fetch(`${url}/local-maps/paradise.json`, { method: 'POST' })).status, 404);
  } finally { await new Promise((r) => server.close(r)); await rm(root, { recursive: true }); }
});
if (process.env.PARADISE_SOURCE) test('optional actual original Level2 source integration (CPU only)', async () => {
  const scene = parseGodot3Scene(await readFile(process.env.PARADISE_SOURCE, 'utf8'));
  assert.deepEqual(transformPoint(scene.nodes.get(PARADISE_NODES.spawn).worldTransform, [0, 0, 0]), [53, 1.5, 1.5]);
  assert.deepEqual(PARADISE_NODES.targets.map((p) => transformPoint(scene.nodes.get(p).worldTransform, [0, 0, 0])), [[-20.4825, 9.00043, 151.838], [26.2109, -2.04942, 148.798], [-13.273, 7.00043, 188.281]]);
  const meshes = embeddedMeshes(scene);
  assert.equal(meshes.length, 216);
  const world = meshes.find((m) => m.nodePath === 'QodotMap/entity_0_worldspawn/entity_0_mesh_instance');
  const collision = [...scene.resources.values()].find((r) => r.type === 'ConcavePolygonShape');
  const source = numbers(collision.props.data, 'PoolVector3Array');
  const decoded = world.surfaces.flatMap((s) => [...s.indices].flatMap((i) => [...s.positions.slice(i * 3, i * 3 + 3)]));
  assert.equal(decoded.length, source.length);
  for (let i = 0; i < source.length; i++) assert.ok(Math.abs(decoded[i] - source[i]) < 0.001, `Authored world collision scalar ${i}`);
});
