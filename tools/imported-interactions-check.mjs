import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Vector3 } from 'three';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { voxelizeMeshes, importedCell } from '../src/world/import/voxelize.js';
import { parseGodot3Scene, sourceActorMetadata, authoredPrimitiveProperties } from '../src/world/import/godot3.js';
import { crueltyInteractions } from '../src/world/import/crueltyInteractions.js';
import { crueltyExcludeNode } from '../src/world/import/crueltyMission.js';
import { embeddedMeshes } from '../src/world/import/godot3.js';
import { createImportedInteractions, importedDoorOccupied, IMPORTED_DOOR_EDIT, WGSL_CHECK } from '../src/pov/importedInteractions.js';
import { decodeImportedIndex } from '../src/world/import/importedInteractionState.js';
import { WorldWindow } from '../src/world/window.js';
import { BrickStore } from '../src/world/store.js';
import { createSaves } from '../src/saves/game.js';
import { decodeSave } from '../src/saves/format.js';
import { E } from '../src/elements.js';
import { gridLayout } from '../src/sim.js';
import { WgslReflect } from '../node_modules/wgsl_reflect/wgsl_reflect.module.js';

registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/pov/index.js')) return { format: 'module', source: 'export function createPov() { throw new Error("UI shell unused in wire timer check"); }', shortCircuit: true };
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: povWire } = await import('../src/wire/pov.js');

function fixture() {
  const surface = x => ({ materialPath: 'door', positions: new Float64Array([x, 2, 6, 6, 2, 6, 6, 7, 6]), indices: new Uint32Array([0, 1, 2]) });
  const voxel = voxelizeMeshes([{ nodePath: 'door', surfaces: [surface(3)] }, { nodePath: 'wall', surfaces: [surface(5)] }], { door: E.WOOD }, { cellMeters: 1, padding: 2, alignment: 16, ownerForMesh: m => m.nodePath === 'door' ? 'door' : null });
  const { words, ownedCells } = voxel;
  // Only test fixture scaling differs from source geometry; runtime scale is canonical.
  const map = { ...voxel, cellMeters: 0.3, id: 'test', dataFile: 'test.binpack', dataCompression: 'gzip', plainHeight: 0, mission: { spawn: [1, 1, 1] } };
  delete map.words; delete map.ownedCells;
  const cells = ownedCells.door;
  const ps = cells.filter((_, i) => i % 2 === 0).map(i => decodeImportedIndex(map, i));
  const bounds = { min: [0, 1, 2].map(k => Math.min(...ps.map(p => p[k]))), max: [0, 1, 2].map(k => Math.max(...ps.map(p => p[k])) + 1) };
  const door = { sourcePath: 'door', sourceResource: 'res://Scripts/Door.gd', cells, bounds, supported: true, kind: 'swing' };
  map.interactions = { version: 1, doors: [door], ladders: [] };
  const scene = createImportedMapScene(map, words.slice());
  const gpuCells = new Map();
  for (let x = 0; x < map.size[0]; x++) for (let y = 0; y < map.size[1]; y++) for (let z = 0; z < map.size[2]; z++) if (scene.cell(x, y, z)) gpuCells.set(`${x},${y},${z}`, scene.cell(x, y, z));
  const uploads = [], sim = {
    origin: { x: 0, y: 0, z: 0 }, g: { nx: map.size[0], ny: map.size[1], nz: map.size[2] },
    editKernel(name, code) { assert.equal(code, IMPORTED_DOOR_EDIT); return { ready: Promise.resolve() }; },
    gpu: {
      createBuffer: ({ size }) => ({ bytes: new Uint32Array(size / 4) }),
      write(buffer, at, data) { buffer.bytes.set(data, at / 4); },
      readback: { async buffer(buffer) { return buffer.bytes.slice().buffer; } },
    },
    _retire() {},
    // CPU emulation of this narrow conditional edit, not a replacement for the
    // parent's actual GPU assertion. This exercises real runtime orchestration.
    edit(kernel, box, p, { bind }) {
      const dense = bind[0].buffer.bytes;
      for (let z = 0; z < p.size[2]; z++) for (let y = 0; y < p.size[1]; y++) for (let x = 0; x < p.size[0]; x++) {
        const i = (x + p.size[0] * (y + p.size[1] * z)) * 2, id = dense[i];
        if (!id) continue;
        const pos = [x + p.at[0], y + p.at[1], z + p.at[2]], key = pos.join(','), actual = gpuCells.get(key) ?? 0;
        if (p.opening) { dense[i + 1] = actual === id ? 1 : 0; if (dense[i + 1]) gpuCells.delete(key); }
        else if (dense[i + 1]) { if (actual) dense[i + 1] = 0; else gpuCells.set(key, id); }
      }
    },
  };
  const world = { scene, sim, P: { seed: 0 }, pending: null }, bodies = [];
  let provider;
  const runtime = createImportedInteractions({ app: { getWorld: () => world, getSim: () => sim }, interact: { provide(fn) { provider = fn; return () => {}; } }, getBodies: () => bodies });
  scene.subscribeData((at, data) => uploads.push([at, data.slice()]));
  return { map, scene, door, sim, world, runtime, gpuCells, bodies, uploads, provider };
}
const keyOf = (f, i) => decodeImportedIndex(f.map, f.door.cells[i * 2]).join(',');

test('concurrent generator preparation shares one canonical interaction state', async () => {
  const f = fixture(), packed = gzipSync(Buffer.from(f.scene.data().words.buffer));
  const scene = createImportedMapScene(f.map, null, { dataURL: `data:application/octet-stream;base64,${packed.toString('base64')}` });
  const states = await Promise.all([1, 2, 3].map(async () => { await scene.prepare(); return scene.interactionState; }));
  assert.ok(states[0]);
  assert.ok(states.every(state => state === states[0]), 'near and far generators must not diverge');
});

test('E provider opens/closes exclusively owned cells, CPU/GPU generator agree; reset precedes retry fill', async () => {
  const f = fixture(), original = f.scene.data().words.slice();
  f.bodies.push({ pos: { x: 1, y: 1, z: 1 } });
  assert.equal(f.provider()[0].verb, 'Open');
  assert.equal(await f.runtime.use(f.door), true);
  assert.equal(f.provider()[0].verb, 'Close');
  for (let i = 0; i < f.door.cells.length / 2; i++) { assert.equal(f.gpuCells.get(keyOf(f, i)) ?? 0, 0); assert.equal(f.scene.cell(...keyOf(f, i).split(',').map(Number)), 0); }
  // Stream away/back: newly generated cells come from the SAME canonical words,
  // so no separate transient render-only door state can re-close the aperture.
  const streamed = f.scene.data().words.slice();
  for (let i = 0; i < f.door.cells.length; i += 2) assert.equal(importedCell(f.map, streamed, ...decodeImportedIndex(f.map, f.door.cells[i])), 0);
  assert.ok(f.uploads.length && f.uploads.every(([, data]) => data.length < original.length / 2), 'only sparse word runs, never the whole map');
  f.bodies.length = 0;
  assert.equal(await f.runtime.use(f.door), true);
  assert.deepEqual(f.scene.data().words, original);
  await f.runtime.use(f.door);
  const fake = { gpu: { frame: {} }, renderSource: { reset() {}, recordLiveCopy() {} }, storeRevisions: new Map(), sim: { g: {}, deco: null, origin: { set() {} }, noteWrite() {}, dropHistory() {}, stillFlow() {} }, scene: f.scene, epoch: 0, store: { clear() {} }, planted: { fill() {} }, gen: { fill() { assert.deepEqual(f.scene.data().words, original); } } };
  WorldWindow.prototype.load.call(fake, [0, 0, 0]);
  assert.equal(f.scene.interactionState.states.size, 0);
  assert.equal(f.world.pending, null);
});

test('destroyed door cells and static overlapping surfaces survive arbitrary cycles', async () => {
  const f = fixture(), before = new Map(f.gpuCells), lost = keyOf(f, 0);
  assert.ok(f.door.cells.length > 2);
  f.gpuCells.delete(lost); // destruction before opening
  await f.runtime.use(f.door);
  await f.runtime.use(f.door);
  assert.equal(f.gpuCells.has(lost), false);
  assert.equal(f.scene.cell(...lost.split(',').map(Number)), 0);
  for (const [key, id] of before) if (!f.door.cells.some((v, i) => i % 2 === 0 && decodeImportedIndex(f.map, v).join(',') === key)) assert.equal(f.gpuCells.get(key), id, 'wall/floor overlap is never cleared');
  await f.runtime.use(f.door);
  const replaced = keyOf(f, 1); f.gpuCells.set(replaced, E.ROCK);
  await f.runtime.use(f.door);
  assert.equal(f.gpuCells.get(replaced), E.ROCK, 'closing does not overwrite foreign matter');
  await f.runtime.use(f.door); await f.runtime.use(f.door);
  assert.equal(f.gpuCells.has(lost), false, 'later cycles cannot resurrect destroyed cells');
  assert.equal(f.gpuCells.get(replaced), E.ROCK);
});

test('manifest rejects free ordinary special gates and invalid ownership', () => {
  const f = fixture();
  assert.throws(() => createImportedMapScene({ ...f.map, interactions: { ...f.map.interactions, doors: [{ ...f.door, sourceResource: 'res://Scripts/Divine_Door.gd' }] } }), /Unsupported gate/);
  assert.throws(() => createImportedMapScene({ ...f.map, interactions: { ...f.map.interactions, doors: [{ ...f.door, cells: [...f.door.cells, ...f.door.cells] }] } }), /Invalid imported door cell/);
});

test('closing refuses player and NPC overlap, pending stream, nonresident doors and unsupported gates', async () => {
  const f = fixture(); await f.runtime.use(f.door);
  const min = f.door.bounds.min;
  for (const size of [1, 2]) {
    const body = { pos: { x: min[0] + 0.5, y: min[1], z: min[2] + 0.5 }, size };
    f.bodies.push(body);
    assert.equal(importedDoorOccupied(f.door, f.bodies, [0, 0, 0]), true);
    assert.equal(await f.runtime.use(f.door), false);
    f.bodies.pop();
  }
  f.world.pending = Promise.resolve(); assert.equal(await f.runtime.use(f.door), false); f.world.pending = null;
  f.sim.origin.x = f.map.size[0]; assert.equal(await f.runtime.use(f.door), false); f.sim.origin.x = 0;
  assert.equal(await f.runtime.use({ ...f.door, supported: false, requirement: 'Requires intact soul (unsupported)' }), false);
  assert.equal(await f.runtime.use(f.door), true);
});

test('sliding door timer closes after 5 seconds, deferring while occupied', async () => {
  const f = fixture(); f.door.autoCloseSeconds = 5; f.door.kind = 'sliding';
  await f.runtime.use(f.door);
  assert.equal(await f.runtime.use(f.door), false, 'source elevator use does not manually close an open door');
  f.runtime.update(4.9);
  assert.equal(f.scene.interactionState.states.get('door').open, true);
  const min = f.door.bounds.min; f.bodies.push({ pos: { x: min[0], y: min[1], z: min[2] } });
  f.runtime.update(0.2); await Promise.resolve();
  assert.equal(f.scene.interactionState.states.get('door').open, true);
  f.bodies.pop(); f.runtime.update(0.1); await f.world.pending;
  assert.equal(f.scene.interactionState.states.get('door').open, false);
});

test('timed doors keep world updates alive outside POV, but not while paused', async () => {
  const f = fixture(); f.door.autoCloseSeconds = 5; f.door.kind = 'sliding';
  const app = { settings: { paused: false }, pov: { active: false, npcs: [], vehicles: { list: [] }, importedInteractions: f.runtime } };
  assert.equal(povWire.busy(app), false);
  await f.runtime.use(f.door);
  assert.equal(povWire.busy(app), true);
  app.settings.paused = true;
  assert.equal(povWire.busy(app), false);
  app.settings.paused = false;
  f.runtime.update(5.1); await f.world.pending;
  assert.equal(povWire.busy(app), false);
});

test('real save codec restores open doors, destruction masks, timers and canonical words before fill', async () => {
  const f = fixture();
  f.door.autoCloseSeconds = 5;
  f.gpuCells.delete(keyOf(f, 0));
  await f.runtime.use(f.door);
  f.runtime.update(2);
  const expected = f.scene.interactionState.snapshot();
  Object.assign(f.sim.g, gridLayout(f.sim.g.nx, f.sim.g.ny, f.sim.g.nz));
  f.sim.origin = new Vector3();
  const blank = () => [new Float32Array(f.sim.g.width * f.sim.g.height * 4), new Float32Array(f.sim.g.width * f.sim.g.height * 4)];
  Object.assign(f.sim, { rays: { active: false }, prepare: async () => {}, readState: async () => blank(),
    blankState: blank, load() {}, dropHistory() {} });
  Object.assign(f.world, { loaded: true, epoch: 0, size: f.map.size,
    gpu: { frame: {} }, renderSource: { reset() {}, recordLiveCopy() {} }, storeRevisions: new Map(),
    store: new BrickStore(f.map.size.map(n => n / 4)),
    planted: new Uint8Array(f.map.size[0] * f.map.size[2] / 16),
    loadSaved: WorldWindow.prototype.loadSaved });
  const saves = createSaves({ settings: {}, getSim: () => f.sim, getWin: () => f.world,
    header: () => ({ map: 'test', world: { scene: 'test', seed: 0 } }), prepare: async () => true, finish() {}, onSettings() {} });
  const bytes = await saves.capture('open door');
  assert.deepEqual((await decodeSave(bytes)).sections.get('worldInteractions'), expected);
  f.scene.reset(); assert.equal(f.scene.interactionState.states.size, 0);
  await saves.apply(bytes);
  assert.deepEqual(f.scene.interactionState.snapshot(), expected);
  assert.equal(f.scene.cell(...keyOf(f, 1).split(',').map(Number)), 0);
  const before = f.scene.data().words.slice();
  assert.throws(() => f.scene.interactionState.restore({ version: 1, doors: [{ ...expected.doors[0], alive: [7] }] }), /Invalid saved door/);
  assert.deepEqual(f.scene.data().words, before, 'invalid save cannot mutate terrain');
  f.scene.interactionState.restore(undefined);
  assert.equal(f.scene.interactionState.states.size, 0, 'legacy saves clear current attempt state');
  // A use/auto-close can begin while capture waits for shader preparation.
  f.sim.prepare = async () => { void f.runtime.use(f.door); };
  f.sim.readState = async () => {
    assert.equal(f.world.pending, null, 'copies must wait for the new door transaction');
    assert.equal(f.scene.interactionState.states.get('door').open, true);
    return blank();
  };
  const duringPreparation = await decodeSave(await saves.capture('door opened during preparation'));
  assert.equal(duringPreparation.sections.get('worldInteractions').doors[0].open, true);
});

test('door WGSL parses on CPU with main entry and bounded storage bindings', () => {
  for (const check of WGSL_CHECK) {
    const module = new WgslReflect(check.code(gridLayout(32, 32, 32)));
    assert.deepEqual(module.entry.compute.map(e => e.name), check.name === 'importedDoorMotion' ? ['main', 'apply'] : ['main']);
    assert.ok(module.storage.length <= 8);
  }
});

test('actor metadata retains only authored finite primitive properties and world yaw', () => {
  const s = parseGodot3Scene('[gd_scene load_steps=2 format=2]\n\n[ext_resource path="res://Enemy.tscn" type="PackedScene" id=1]\n\n[node name="Root" type="Spatial"]\n\n[node name="Actor" parent="." instance=ExtResource( 1 )]\ntransform = Transform( 0, 0, -1, 0, 1, 0, 1, 0, 0, 3, 4, 5 )\nweapon = 4\nhealth = 250.5\nhell_only = true\nname = "A \\"quote\\""\ncolor = Color( 1, 0, 0, 1 )\ninvalid = 1e999\n');
  assert.deepEqual(authoredPrimitiveProperties({ props: { multiline: '"first\nsecond"', escaped: '"tab\\tquote\\""' } }), { multiline: 'first\nsecond', escaped: 'tab\tquote"' });
  const metadata = sourceActorMetadata(s.nodes.get('Actor'), s);
  assert.equal(metadata.sourceResource, 'res://Enemy.tscn');
  assert.equal(metadata.sourceYaw, Math.PI / 2);
  assert.equal(metadata.sourceProperties.health, 250.5); assert.equal(metadata.sourceProperties.hell_only, true);
  assert.equal(metadata.sourceProperties.transform, undefined); assert.equal(metadata.sourceProperties.invalid, undefined); assert.equal(metadata.sourceProperties.color, undefined);
});

const sourceDir = process.env.CRUELTY_SOURCE_DIR;
if (sourceDir) for (const [level, expected] of [[1, [22, 3, 0, 3, 1]], [2, [45, 7, 14, 1, 4]], [3, [22, 1, 0, 0, 1]], [4, [67, 1, 0, 1, 4]], [6, [39, 1, 0, 0, 2]]]) test(`source Level${level}: complete scripted inventory and authored door/ladder counts`, async () => {
  const scene = parseGodot3Scene(await readFile(`${sourceDir}/Level${level}.tscn`, 'utf8'));
  const inventory = crueltyInteractions(scene, embeddedMeshes(scene, { excludeNode: crueltyExcludeNode }), { cellMeters: 0.3, origin: [0, 0, 0] }, {});
  assert.deepEqual([inventory.doors.filter(d => d.kind === 'swing').length, inventory.doors.filter(d => d.kind === 'sliding').length, inventory.doors.filter(d => d.kind === 'vertical').length, inventory.doors.filter(d => !d.supported).length, inventory.ladders.length], expected);
  assert.equal(inventory.inventory.length, [...scene.nodes.values()].filter(n => n.props.script || n.instance).length);
  console.log(`Level${level}: swing/sliding/vertical/gates/ladders=${expected.join('/')} scripted+packed=${inventory.inventory.length}`);
});
