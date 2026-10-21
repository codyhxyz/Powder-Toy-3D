// CPU-only registry + real vehicle lifecycle/physics. No browser or GPU.
// Rendering, terrain readback and voxel edits are replaced at their boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import R from './rapier-node.mjs';
import { Spawners, SPAWNER } from '../src/spawners.js';
import { E, K, ELEMENTS, TOOLS } from '../src/elements.js';
import { targetsInBox } from '../src/pov/targets.js';

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
sp.clear();
// NPCs and vehicles live in a World's window as in a box (CLAUDE.md "Same features in every world")
for (const kind of ['boat', 'jeep', 'hoverbike', 'enemy', 'gunner', 'worm', 'giantworm']) assert.equal(sp.place(kind, at), 'added');
sim.g.windowed = false;
sp.clear();
for (const name of ['Boat', 'Jeep', 'Hoverbike', 'Axeman', 'Gunner', 'Worm', 'Giant worm']) assert.ok(TOOLS.some((t) => t.name === name));
// Birds were removed (2026-10-20): no kind, no palette tool, and an old save's
// Bird flock (kind 'birds', a one-shot with its survivors, or a flagless pad)
// loads without it, the rest of the save as before.
const OLD_BIRDS = 'birds';
assert.ok(!Object.values(SPAWNER).includes(OLD_BIRDS), 'no bird spawner kind');
assert.ok(!TOOLS.some((t) => /bird|flock/i.test(`${t.key} ${t.name}`)), 'no Bird flock tool');
const oldSave = [
  { kind: OLD_BIRDS, world: [12, 2, 12], oneShot: true, state: { birdCount: 9 } },
  { kind: 'enemy', world: [20, 2, 20], oneShot: true, state: null },
  { kind: OLD_BIRDS, world: [40, 2, 40] },
  { kind: 'boat', world: [60, 2, 60] },
];
sp.fromJSON(oldSave);
assert.deepEqual(sp.list.map((s) => s.kind), ['enemy', 'boat'], 'an old save loads with its flock dropped');
assert.deepEqual(sp.toJSON(), oldSave.filter((s) => s.kind !== OLD_BIRDS), 'and saves again without it');
sp.clear();
console.log('ok one-shot registry: no toggle/pad, cap, death/save, legacy, World NPCs, World vehicles and old saves with bird flocks');

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
    source = source.replace(/import .* from '\.\.\/ai\/world\.js';/, `const createWorldModel = () => globalThis.__entityFixture.model?.() ?? ({
      ready: true, version: 1, dims: [128, 64, 128], update() {},
      id(x, y, z) { return x < 0 || x >= 128 || z < 0 || z >= 128 || y < 1 ? E.ROCK : E.EMPTY; },
      kind(id) { return ELEMENTS[id]?.kind ?? K.SOLID; }, T() { return 20; }, isLiquid() { return false; },
    });`);
    source = source.replace(/import .* from '\.\.\/tools\/transfer\.js';/, `class Load { constructor() { this.cells = []; } }
      const sharedTransfer = () => ({ put() {} }), cellsNear = () => [], ballRadius = () => 1;`);
    source = source.replace(/import .* from '\.\.\/gpu\.js';/, 'const volumeLight = () => null;');
    source = source.replace('import { loadRapier, createPhysics }', 'import { createPhysics }');
    source = source.replace("import './vehicles.css';", 'const loadRapier = async () => globalThis.__entityFixture.R;');
    source = source.replace(/import .* from '\.\/hud\.js';/, 'const createVehicleHud = () => ({ show() {}, board() {}, leave() {}, dispose() {} });');
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
  vehicles.dispose(); physics?.world.free(); sp.clear();
}

// ---- a World: a 128-cell window over a 1024-cell world (docs/scaling.md D11), the cells' copy
// (ai/world.js's model, as the vehicles use it) of the window it was read from, landing when
// land() is called (a readback after the window moved). The world: a rock floor 20 cells deep
// and a rock plateau 10 cells higher, both in world cells; dig() takes the plateau away.
const WORLD = [1024, 64, 1024], WIN = [128, 64, 128], FLOOR = 20, PLATEAU = 30, WIN_STEP = 16;
const PLATEAU_X = [620, 680], PLATEAU_Z = [490, 550];
let dug = false;
const worldId = (x, y, z) => {
  if (y < FLOOR) return E.ROCK;
  const on = !dug && x >= PLATEAU_X[0] && x < PLATEAU_X[1] && z >= PLATEAU_Z[0] && z < PLATEAU_Z[1];
  return on && y < PLATEAU ? E.ROCK : E.EMPTY;
};
const simW = { id: 'world', version: 0, g: { nx: WIN[0], ny: WIN[1], nz: WIN[2], windowed: true }, origin: new THREE.Vector3(576, 0, 448), world: [...WORLD] };
const copy = {
  ready: true, version: 1, idVersion: 1, dims: WIN, soon: 0,
  at: { origin: simW.origin.toArray(), world: [...WORLD] },
  update(dt, soon) { if (soon) this.soon++; },
  land() { this.at = { origin: simW.origin.toArray(), world: [...WORLD] }; this.version++; this.idVersion = this.version; },
  id(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y >= WIN[1]) return E.EMPTY;
    if (x < 0 || z < 0 || y < 0 || x >= WIN[0] || z >= WIN[2]) return -1;
    return worldId(x + this.at.origin[0], y, z + this.at.origin[2]);
  },
  kind(id) { return id === -1 ? K.SOLID : ELEMENTS[id].kind; }, T() { return 20; }, isLiquid() { return false; },
};
globalThis.__entityFixture.model = () => copy;
const spW = new Spawners({ scene, getSim: () => simW, getVolume: () => volume, getScale: () => 1 });
const vehiclesW = createVehicles({ scene, renderer: {}, getSim: () => simW, getVolume: () => volume, getScale: () => 1, getSpawners: () => spW });
const tickW = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) vehiclesW.update(dt, frame); };
const SETTLE = 240;   // frames (4 s) for a dropped jeep to come to rest on its springs
const near = (a, b, eps) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
const shift = (dx, dz) => { simW.origin.x += dx; simW.origin.z += dz; };   // the sim's window moves (world/window.js shift)
try {
  // placed on the plateau: its feet in the window's grid cells, kept in world cells
  const feet = new THREE.Vector3(650, PLATEAU, 520).sub(simW.origin);
  assert.equal(spW.place('jeep', feet), 'added', 'a World takes a vehicle');
  tickW(); await new Promise((r) => setImmediate(r)); tickW(SETTLE);
  assert.equal(vehiclesW.list.length, 1, 'it spawns in the World');
  const jeep = vehiclesW.list[0], body = jeep.impl.body;
  const rest = { ...body.translation() };
  assert.ok(Math.abs(rest.x / 0.3 - 650) < 1 && Math.abs(rest.z / 0.3 - 520) < 1, `its body is in world metres (${rest.x.toFixed(2)}, ${rest.z.toFixed(2)})`);
  assert.ok(rest.y / 0.3 > PLATEAU, `it rests on the plateau (${(rest.y / 0.3).toFixed(1)} cells up)`);
  const drawnX = jeep.impl.root.position.x;
  assert.ok(Math.abs(drawnX - (rest.x / 0.3 - simW.origin.x)) < 1e-6, 'it is drawn in the window');
  // the window moves twice under it, the copies landing a few frames after each move
  for (const d of [WIN_STEP, WIN_STEP]) { shift(d, 0); tickW(3); copy.land(); tickW(60); }
  assert.ok(copy.soon > 0, 'a moved World window asks for its copy at once');
  assert.ok(near(body.translation(), rest, 0.01), 'the window moving keeps it where it is in the world');
  assert.ok(!jeep.parked && body.isEnabled(), 'inside the window it stays simulated');
  assert.ok(Math.abs(jeep.impl.root.position.x - (drawnX - 2 * WIN_STEP)) < 0.01, 'it is drawn where it is: 32 cells further back in the window');
  const box = [new THREE.Vector3(), new THREE.Vector3()];
  for (const t of targetsInBox(new THREE.Vector3(-1e4, -1e4, -1e4), new THREE.Vector3(1e4, 1e4, 1e4), null, [])) if (t.id === jeep.id) t.box(...box);
  assert.ok(Math.abs((box[0].x + box[1].x) / 2 - (rest.x / 0.3 - simW.origin.x)) < 0.5, 'its hit box is in the window\'s cells');
  // it collides with the world's cells where it is: dig the plateau away (world cells) and it drops to the floor
  dug = true; copy.version++; copy.idVersion = copy.version;
  tickW(SETTLE);
  const fell = body.translation();
  assert.ok(near({ ...fell, y: 0 }, { ...rest, y: 0 }, 0.3) && fell.y < rest.y - 0.8 * (PLATEAU - FLOOR) * 0.3 && fell.y / 0.3 > FLOOR,
    `with the plateau dug out it drops onto the floor below (${(rest.y / 0.3).toFixed(1)} → ${(fell.y / 0.3).toFixed(1)} cells)`);
  const resting = { ...fell };
  // the window leaves it: parked, held still, unseen, out of the terrain sync
  shift(256, 0); tickW(2);
  assert.ok(jeep.parked && !body.isEnabled() && !jeep.impl.root.visible, 'outside the window it waits, parked and unseen');
  copy.land(); tickW(120);
  assert.ok(near(body.translation(), resting, 1e-6), 'parked, it is held still');
  assert.equal(vehiclesW.physics.ground(jeep.id), null, 'parked, its terrain is let go');
  // ... and it comes back once the window and its copy cover it again
  shift(-256, 0); tickW(2);
  assert.ok(jeep.parked, 'it waits for the copy of the window that covers it');
  copy.land(); tickW(60);
  assert.ok(!jeep.parked && body.isEnabled() && jeep.impl.root.visible, 'back in the window it is simulated again');
  assert.ok(near(body.translation(), resting, 0.05), 'it resumes where it waited, on the floor');
  // saved in world cells and metres; loaded into a window somewhere else, it waits there, then appears where it was
  const savedW = spW.toJSON();
  const now = body.translation();
  assert.ok(Math.abs(savedW[0].world[0] - now.x / 0.3) < 1e-6 && Math.abs(savedW[0].state.position[0] - now.x) < 1e-6 && savedW[0].world[0] > WIN[0], 'a World save stores world positions');
  shift(256, 0); copy.land();
  spW.fromJSON(savedW); vehiclesW.worldReplaced(); tickW(2);
  assert.equal(vehiclesW.list.length, 0, 'a loaded vehicle outside the window waits to appear');
  shift(-256, 0); copy.land(); vehiclesW.update(0, frame);
  assert.equal(vehiclesW.list.length, 1, 'it appears when the window covers it');
  const [sx, sy, sz] = savedW[0].state.position;
  assert.ok(near(vehiclesW.list[0].impl.body.translation(), { x: sx, y: sy, z: sz }, 1e-6), 'where it was saved, in the world');
  console.log('ok World vehicles: placed, kept in world cells as the window moves, collide with the world\'s cells, park outside the window and resume, save/load world positions');
} finally {
  const physics = vehiclesW.physics;
  vehiclesW.dispose(); physics?.world.free(); spW.clear(); hooks.deregister();
  delete globalThis.__entityFixture;
}
