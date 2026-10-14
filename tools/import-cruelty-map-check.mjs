import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { CRUELTY_PROFILES, crueltyProfile } from '../src/world/import/crueltyProfiles.js';
import { CRUELTY_MATERIALS, MATERIAL_LOSSES } from '../src/world/import/crueltyMaterials.js';
import { crueltyExcludeNode, crueltyMission, hiddenActorHelper, actorBodyClear, actorFeetAt } from '../src/world/import/crueltyMission.js';
import { parseGodot3Scene, embeddedMeshes, numbers, reference, transformPoint } from '../src/world/import/godot3.js';
import { importedCell, voxelizeMeshes } from '../src/world/import/voxelize.js';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { convertCrueltyMap } from './import-cruelty-map.mjs';
import { localMapPlugin } from '../scripts/local-map-plugin.mjs';
import { E, ELEMENTS, K } from '../src/elements.js';
import { convexProjectionAxes, convexOverlapsBox } from '../src/world/import/convexVolume.js';

test('four approved profiles; Sin source is explicitly blocked, never converted as a substitute', () => {
  assert.deepEqual(CRUELTY_PROFILES.filter((p) => !p.blocked).map((p) => p.level), [1, 2, 4, 6]);
  assert.throws(() => convertCrueltyMap('', crueltyProfile(3)), /not imported.*budget/);
  assert.deepEqual(CRUELTY_PROFILES.filter((p) => !p.blocked).map((p) => p.exits.length), [1, 1, 2, 3]);
});
test('audited translations use existing mechanics, not new color elements', () => {
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/base/Marble1green.tres'], E.LIMESTONE);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/base/Tile_Wall.png'], E.CERAMIC);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/base/flesh_tile.png'], E.ROCK);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/base/moss.png'], E.ROCK);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/base/red_water.png'], E.WATER);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/apartment/oven.png'], E.METAL);
  for (const id of Object.values(CRUELTY_MATERIALS)) assert.ok(ELEMENTS[id] && MATERIAL_LOSSES[ELEMENTS[id].key]);
  assert.equal(CRUELTY_MATERIALS['res://Maps/textures/unapproved.png'], undefined);
});
test('explicitly hidden actor debug helpers excluded; hidden terrain collision retained', () => {
  const scene = { nodes: new Map(), external: new Map([[1, { path: 'res://Scripts/EnemyHandler.gd' }]]) };
  scene.nodes.set('Actor', { props: { script: 'ExtResource( 1 )' } });
  const helper = { parent: 'Actor', props: { visible: 'false' } };
  assert.equal(hiddenActorHelper(helper, scene), true);
  assert.equal(crueltyExcludeNode(helper, scene), true);
  assert.equal(crueltyExcludeNode({ parent: '.', props: { visible: 'false' } }, scene), false);
  assert.equal(hiddenActorHelper({ parent: 'Actor', props: { visible: 'true' } }, scene), false);
  assert.equal(crueltyExcludeNode({ parent: 'Actor', props: { visible: 'true' } }, scene), true, 'living actor art is not static terrain');
});
test('DEV whitelist includes all four pairs, blocks Sin, unknown files and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpt-cruelty-check-'));
  const directory = join(root, '.tmp-cruelty-import'); await mkdir(directory);
  for (const p of CRUELTY_PROFILES.filter((p) => !p.blocked)) await writeFile(join(directory, `${p.id}.json`), '{}');
  await writeFile(join(root, 'outside.bin'), 'do-not-serve');
  await symlink(join(root, 'outside.bin'), join(directory, 'paradise.bin'));
  let handler; localMapPlugin().configureServer({ config: { root }, middlewares: { use: (f) => { handler = f; } } });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of CRUELTY_PROFILES.filter((p) => !p.blocked)) assert.equal((await fetch(`${base}/local-maps/${p.id}.json`)).status, 200);
    for (const path of ['sinSpaceEngineering.json', 'unknown.json', 'paradise.bin', '%2e%2e/outside.bin']) assert.equal((await fetch(`${base}/local-maps/${path}`)).status, 404);
  } finally { await new Promise((r) => server.close(r)); await rm(root, { recursive: true }); }
});
test('authored arch SAT rejects corner inside bounds, accepts overlapping body', () => {
  const profile = [[-1, 0], [1, 0], [1, 1], [0, 2], [-1, 1]];
  const points = [-0.5, 0.5].flatMap((z) => profile.map(([x, y]) => [x, y, z]));
  const axes = convexProjectionAxes(points);
  assert.equal(convexOverlapsBox(axes, [0.85, 1.85, 0], [0.05, 0.05, 0.05]), false);
  assert.equal(convexOverlapsBox(axes, [0, 1, 0], [0.2, 0.4, 0.2]), true);
  assert.equal(convexOverlapsBox(axes, [0, 1, 2], [0.2, 0.4, 0.2]), false);
});
const sourceDirectory = process.env.CRUELTY_SOURCE_DIR;
const generatedDirectory = process.env.CRUELTY_OUTPUT_DIR;
if (sourceDirectory) for (const profile of CRUELTY_PROFILES) test(`actual Level${profile.level}: all source materials/nodes and world collider decode`, async () => {
  const text = await readFile(join(sourceDirectory, `Level${profile.level}.tscn`), 'utf8');
  const scene = parseGodot3Scene(text), meshes = embeddedMeshes(scene, { excludeNode: crueltyExcludeNode });
  for (const m of meshes) for (const s of m.surfaces) assert.ok(Object.hasOwn(CRUELTY_MATERIALS, s.materialPath), s.materialPath);
  for (const path of [profile.spawn, ...profile.targets, ...profile.exits]) assert.ok(scene.nodes.has(path), path);
  for (const path of profile.exits) {
    const node = scene.nodes.get(path); assert.ok(!Object.values(node.props).includes('false'));
    const shapes = [...scene.nodes.values()].filter((n) => n.type === 'CollisionShape' && n.parent === path);
    for (const shape of shapes) assert.notEqual(shape.props.disabled, 'true');
  }
  let matched = 0;
  for (const shapeNode of scene.nodes.values()) {
    if (shapeNode.type !== 'CollisionShape') continue;
    const shape = scene.resources.get(reference(shapeNode.props.shape).id);
    if (shape?.type !== 'ConcavePolygonShape') continue;
    const body = scene.nodes.get(shapeNode.parent), mesh = meshes.find((m) => m.nodePath === body?.parent);
    if (!mesh) continue;
    const source = numbers(shape.props.data, 'PoolVector3Array');
    const decoded = mesh.surfaces.flatMap((s) => [...s.indices].flatMap((i) => [...s.positions.slice(i * 3, i * 3 + 3)]));
    assert.equal(decoded.length, source.length);
    for (let i = 0; i < source.length; i += 3) {
      const p = transformPoint(shapeNode.worldTransform, source.slice(i, i + 3));
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - decoded[i + k]) < 0.002, `Collision coordinate ${i + k}`);
    }
    matched++;
  }
  assert.ok(matched > 0, 'An authored concave world collider must verify the source byte stream');
  if (profile.blocked || !generatedDirectory) return;
  const map = JSON.parse(await readFile(join(generatedDirectory, `${profile.id}.json`), 'utf8'));
  const buffer = await readFile(join(generatedDirectory, `${profile.id}.bin`));
  const words = new Uint32Array(buffer.length / 4); for (let i = 0; i < words.length; i++) words[i] = buffer.readUInt32LE(i * 4);
  const adapter = createImportedMapScene(map, words);
  assert.equal(map.provenance.sha256, createHash('sha256').update(text).digest('hex'));
  const expectedMission = crueltyMission(scene, map, words, profile); assert.deepEqual(map.mission, expectedMission);
  assert.equal(map.mission.authoredTargets.length, profile.targets.length); assert.equal(map.mission.extractions.length, profile.exits.length);
  for (const at of [map.mission.spawn, ...map.mission.targets.map((t) => t.at), ...map.mission.guards.map((g) => g.at)].filter(Boolean)) {
    assert.equal(ELEMENTS[adapter.cell(Math.floor(at[0]), at[1] - 1, Math.floor(at[2]))]?.kind, K.SOLID);
    assert.ok(actorBodyClear(map, words, at), 'every runtime actor has full ordinary body clearance');
  }
  for (const a of [...map.mission.authoredTargets, ...map.mission.authoredGuards]) {
    assert.deepEqual(a.at, actorFeetAt(map, words, a.sourceAt));
    if (!a.at) assert.ok(map.mission.placementFailures.some(f => f.sourcePath === a.sourcePath));
  }
  if (profile.id === 'paradise') assert.equal(actorBodyClear(map, words, [584.3333333333334, 329, 538]), false, 'original beam-clipped guard placement rejected');
  for (const exit of map.mission.extractions) {
    assert.deepEqual(exit.axes, convexProjectionAxes(exit.points));
    for (const p of exit.points) assert.ok(convexOverlapsBox(exit.axes, p, [0, 0, 0]), 'Authored hull vertex retained');
    for (let k = 0; k < 3; k++) {
      assert.equal(exit.bounds.min[k], Math.min(...exit.points.map((p) => p[k])));
      assert.equal(exit.bounds.max[k], Math.max(...exit.points.map((p) => p[k])));
    }
  }
  for (const m of meshes) for (const s of m.surfaces) for (let i = 0; i < s.positions.length; i++) {
    const k = i % 3, v = s.positions[i] / map.cellMeters - map.origin[k]; assert.ok(v >= 0 && v < map.size[k], 'No source vertex cropped');
  }
  assert.equal(importedCell(map, words, -1, 0, 0), 0);
});
