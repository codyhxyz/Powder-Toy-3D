// CPU-only registry + real vehicle lifecycle/physics. No browser or GPU.
// Rendering, terrain readback and voxel edits are replaced at their boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import R from './rapier-node.mjs';
import { Spawners, SPAWNER } from '../src/spawners.js';
import { E, K, ELEMENTS, TOOLS } from '../src/elements.js';

const scene = new THREE.Scene(), volume = new THREE.Group();
const sim = { g: { nx: 128, ny: 64, nz: 128 }, origin: new THREE.Vector3() };
const sp = new Spawners({ scene, getSim: () => sim, getVolume: () => volume, getScale: () => 1 });
const at = new THREE.Vector3(32, 2, 32);
for (const kind of Object.values(SPAWNER).filter((k) => k !== 'player')) {
  assert.equal(sp.place(kind, at), 'added');
  assert.equal(sp.place(kind, at), 'added', `${kind}: no proximity toggle`);
  assert.equal(sp.of(kind).length, 2);
  assert.ok(sp.of(kind).every((s) => s.oneShot && !s.obj));
}
assert.equal(sp.root.children.length, 0, 'sandbox entities have no marker meshes');
for (let i = 2; i < 8; i++) assert.equal(sp.place('boat', at), 'added');
assert.equal(sp.place('boat', at), 'full');
sp.consume(sp.of('boat')[0]);
assert.equal(sp.place('boat', at), 'added', 'dead entities release the cap');
assert.equal(sp.place('player', at), 'added');
assert.equal(sp.place('player', at), 'removed', 'Player spawn remains intentional toggle');
const saved = sp.toJSON();
sp.fromJSON(saved);
assert.equal(sp.of('boat').length, 8);
assert.deepEqual(sp.toJSON(), saved);
sp.clear();
sp.fromJSON([{ kind: 'boat', world: [12, 2, 12] }, { kind: 'boat', world: [1, 2, 3], oneShot: true, consumed: true }]);
assert.equal(sp.list.length, 1);
assert.ok(!sp.list[0].oneShot && sp.list[0].obj, 'flagless saves remain repeated pads');
sp.consume(sp.list[0]);
assert.equal(sp.toJSON().length, 1, 'legacy deaths do not consume their home');
sim.g.windowed = true;
for (const kind of ['boat', 'jeep', 'hoverbike', 'enemy', 'gunner', 'worm', 'giantworm']) assert.equal(sp.place(kind, at), 'unsupported');
assert.equal(sp.place('birds', at), 'added');
sim.g.windowed = false;
sp.clear();
for (const name of ['Boat', 'Jeep', 'Hoverbike', 'Axeman', 'Gunner', 'Worm', 'Giant worm', 'Bird flock']) assert.ok(TOOLS.some((t) => t.name === name));
console.log('ok one-shot registry: no toggle/pad, cap, death/save, legacy and World rejection');

// Exercise production vehicle management with real Rapier bodies. Only GPU/UI
// boundaries are mocked, not spawn, damage, homes, persistence or respawn logic.
globalThis.__entityFixture = { R };
const hooks = registerHooks({
  load(url, context, next) {
    if (!url.endsWith('/src/pov/vehicles/index.js')) return next(url, context);
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace(/import .* from '\.\/look\.js';/, `const createLook = () => ({
      part(parent, geometry) { const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); parent.add(m); return m; },
      glow(parent, geometry) { return this.part(parent, geometry); }, bind() {}, update() {}, char() {}, ember() {}, dispose() {},
    });`);
    source = source.replace(/import .* from '\.\.\/ai\/world\.js';/, `const createWorldModel = () => ({
      ready: true, version: 1, dims: [128, 64, 128], update() {},
      id(x, y, z) { return x < 0 || x >= 128 || z < 0 || z >= 128 || y < 1 ? E.ROCK : E.EMPTY; },
      kind(id) { return ELEMENTS[id]?.kind ?? K.SOLID; }, T() { return 20; }, isLiquid() { return false; },
    });`);
    source = source.replace(/import .* from '\.\.\/tools\/transfer\.js';/, `class Load { constructor() { this.cells = []; } }
      const sharedTransfer = () => ({ put() {} }), cellsNear = () => [], ballRadius = () => 1;`);
    source = source.replace(/import .* from '\.\.\/gpu\.js';/, 'const volumeLight = () => null;');
    source = source.replace('import { loadRapier, createPhysics }', 'import { createPhysics }');
    source = source.replace("import './vehicles.css';", 'const loadRapier = async () => globalThis.__entityFixture.R;');
    source = source.slice(0, source.indexOf('function createHud()')) + 'function createHud() { return { show() {}, dispose() {} }; }';
    return { format: 'module', source, shortCircuit: true };
  },
});
const { createVehicles } = await import('../src/pov/vehicles/index.js');
const vehicles = createVehicles({ scene, renderer: {}, getSim: () => sim, getVolume: () => volume, getScale: () => 1, getSpawners: () => sp });
const frame = { player: null, live: false, worldToGrid: new THREE.Matrix4() };
const tick = (dt = 0) => vehicles.update(dt, frame);
try {
  sp.place('boat', at); sp.place('boat', at);
  tick(); await new Promise((r) => setImmediate(r)); tick();
  assert.equal(vehicles.list.length, 2, 'overlapping one-shots both spawn, without POV');
  assert.ok(vehicles.root.visible);
  const boat = vehicles.list[0], id = boat.id;
  const placement = sp.of('boat')[0];
  boat.impl.body.setTranslation({ x: 7, y: 4, z: 8 }, true);
  vehicles.damage(boat, 0.25);
  const hp = boat.health;
  for (let i = 0; i < 5; i++) { vehicles.reset(); tick(); }
  assert.equal(vehicles.list[0].id, id);
  assert.equal(boat.health, hp);
  assert.deepEqual({ ...boat.impl.body.translation() }, { x: 7, y: 4, z: 8 }, 'paused frames and camera reset do not step/reset');
  const data = sp.toJSON();
  assert.deepEqual(data[0].state.position, [7, 4, 8]);
  assert.equal(data[0].state.health, hp);
  assert.deepEqual(data[0].world, [7 / 0.3, 4 / 0.3, 8 / 0.3]);
  sp.fromJSON(data); vehicles.worldReplaced(); tick();
  assert.equal(vehicles.list.length, 2);
  assert.deepEqual({ ...vehicles.list[0].impl.body.translation() }, { x: 7, y: 4, z: 8 });
  assert.equal(vehicles.list[0].health, hp);
  const restored = vehicles.list[0];
  vehicles.damage(restored, 999);
  assert.ok(!restored.alive && sp.of('boat')[0].consumed);
  assert.equal(sp.toJSON().length, 1, 'destroyed boat is absent from saves immediately');
  for (let i = 0; i < 300; i++) tick(1 / 30);
  assert.ok(!vehicles.list.some((v) => v.home === restored.home && v.alive), 'one-shot never replenishes after 8s');
  vehicles.reset(); tick();
  assert.ok(!vehicles.list.some((v) => v.home === restored.home && v.alive));
  tick(30); // the wreck's body is disposed: saves must not call its old snapshot
  assert.ok(!vehicles.list.includes(restored));
  const survivors = sp.toJSON();
  sp.fromJSON(survivors); vehicles.worldReplaced(); tick();
  assert.equal(vehicles.list.length, survivors.length, 'save/load never resurrects the destroyed boat');
  sp.clear(); vehicles.worldReplaced();
  for (const legacy of [true, false]) {
    if (legacy) sp.fromJSON([{ kind: 'boat', world: [64, 2, 64] }]);
    else vehicles.spawnLayout({ vehicles: [{ kind: 'boat', at: [64, 2, 64] }] });
    tick();
    const old = vehicles.list.find((v) => v.alive);
    assert.ok(old);
    vehicles.damage(old, 999);
    for (let i = 0; i < 270; i++) tick(1 / 30);
    assert.ok(vehicles.list.some((v) => v.alive && v.id !== old.id), `${legacy ? 'legacy pad' : 'arena layout'} still replenishes`);
    sp.clear(); vehicles.spawnLayout(null); vehicles.worldReplaced();
  }
  assert.ok(placement.oneShot); // fixture retained no accidental mutation of its flag
  console.log('ok real vehicle lifecycle: immediate spawn, pause, mode reset, live save pose/health, permanent death, legacy/layout respawn');
} finally {
  const physics = vehicles.physics;
  vehicles.dispose(); physics?.world.free(); sp.clear(); hooks.deregister();
  delete globalThis.__entityFixture;
}
