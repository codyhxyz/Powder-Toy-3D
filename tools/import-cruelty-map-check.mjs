import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CRUELTY_PROFILES, crueltyProfile } from '../src/world/import/crueltyProfiles.js';
import { CRUELTY_MATERIALS, MATERIAL_LOSSES } from '../src/world/import/crueltyMaterials.js';
import { crueltyExcludeNode, crueltyMission, hiddenActorHelper, actorBodyClear, actorFeetAt } from '../src/world/import/crueltyMission.js';
import { parseGodot3Scene, embeddedMeshes, numbers, reference, transformPoint } from '../src/world/import/godot3.js';
import { importedCell, voxelizeMeshes } from '../src/world/import/voxelize.js';
import { createImportedMapScene, fetchImportedWords } from '../src/world/scenes/importedMap.js';
import { convertCrueltyMap } from './import-cruelty-map.mjs';
import { E, ELEMENTS, K } from '../src/elements.js';
import { convexProjectionAxes, convexOverlapsBox } from '../src/world/import/convexVolume.js';

// The published levels: public/local-maps ships with the site.
const shippedDirectory = 'public/local-maps';

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
test('shipped levels are gzip-packed, decode, and hold every runtime actor clear', async () => {
  for (const profile of CRUELTY_PROFILES.filter((p) => !p.blocked)) {
    const map = JSON.parse(await readFile(join(shippedDirectory, `${profile.id}.json`), 'utf8'));
    assert.equal(map.dataCompression, 'gzip'); assert.ok(map.dataFile.endsWith('.binpack'));
    const packed = await readFile(join(shippedDirectory, map.dataFile));
    // A raw map exceeds the host's 25 MiB per-file limit; packing must have happened.
    assert.ok(packed.byteLength < 25 * 1024 * 1024, `${profile.id} is under the host limit`);
    const buffer = gunzipSync(packed);
    const words = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    const adapter = createImportedMapScene(map, words);
    assert.deepEqual(adapter.size, map.size);
    assert.ok(map.mission.spawn || map.mission.available === false);
    for (const at of [map.mission.spawn, ...map.mission.targets.map((a) => a.at), ...map.mission.guards.map((a) => a.at)].filter(Boolean)) {
      assert.equal(ELEMENTS[adapter.cell(Math.floor(at[0]), at[1] - 1, Math.floor(at[2]))]?.kind, K.SOLID);
      assert.ok(actorBodyClear(map, words, at), `${profile.id} actor body clearance`);
    }
    assert.throws(() => createImportedMapScene({ ...map, dataCompression: undefined }), /gzip-packed/);
    // Boot lists the map from its manifest alone: the far field asks for the
    // border height then, and must get the loaded voxels' own median.
    const lazy = createImportedMapScene(map);
    assert.equal(lazy.ground(0, 0), map.plainHeight);
    assert.throws(() => lazy.cell(0, 0, 0), /not loaded yet/);
    const [wx, , wz] = map.size, heights = [];
    for (let x = 0; x < wx; x++) heights.push(adapter.ground(x, 0), adapter.ground(x, wz - 1));
    for (let z = 1; z < wz - 1; z++) heights.push(adapter.ground(0, z), adapter.ground(wx - 1, z));
    heights.sort((a, b) => a - b);
    assert.equal(map.plainHeight, heights[heights.length >> 1], `${profile.id} plain height matches its loaded border`);
  }
});
test('packed geometry decodes whether or not the host pre-decodes it', async () => {
  const packed = await readFile(join(shippedDirectory, 'paradise.binpack'));
  const raw = gunzipSync(packed);
  // A host that recognises the packed bytes as an encoded representation serves
  // them with `Content-Encoding: gzip` (Vite does this for a `.gz` name), and
  // the fetch layer then inflates them before the loader sees them.
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    if (req.url === '/labeled') res.setHeader('Content-Encoding', 'gzip');
    res.end(packed);
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const [asIs, decoded] = await Promise.all([fetchImportedWords(`${base}/packed`), fetchImportedWords(`${base}/labeled`)]);
    const expected = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    assert.deepEqual([...asIs], [...expected], 'the packed stream inflates to the original words');
    assert.deepEqual([...decoded], [...expected], 'a response the host already decoded is not inflated twice');
  } finally { await new Promise((r) => server.close(r)); }
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
const generatedDirectory = process.env.CRUELTY_OUTPUT_DIR ?? shippedDirectory;
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
  const buffer = gunzipSync(await readFile(join(generatedDirectory, `${profile.id}.binpack`)));
  const words = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
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
