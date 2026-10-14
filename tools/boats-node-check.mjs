// CPU-only boat, sinking Jeep and pad regressions; no browser/GPU.
// node tools/boats-node-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import R from './rapier-node.mjs';
import { createPhysics } from '../src/pov/vehicles/physics.js';
import { BOAT, buildBoat } from '../src/pov/vehicles/boat.js';
import { JEEP, buildJeep } from '../src/pov/vehicles/jeep.js';
import { E, K, ELEMENTS, PALETTE, TOOLS, itemByKey, isSpawnerTool } from '../src/elements.js';
import { Spawners, SPAWNER, feetOnHit } from '../src/spawners.js';
import { CELL_M } from '../src/scale.js';
import { WGSL_CHECK } from '../src/gfx/overlays.js';

// The sky draws after opaque hulls; it must preserve their colors and depth.
const sky = WGSL_CHECK.find((p) => p.name === 'boxSky');
assert.equal(sky.depthStencil.depthCompare, 'less-equal');
assert.equal(sky.depthStencil.depthWriteEnabled, false);
assert.match(sky.code(), /o\.position = vec4f\(ndc, 1\.0, 1\.0\)/);

const H = 1 / 60, WATER_Y = 6;
const drive = (o = {}) => ({ throttle: 0, steer: 0, parked: false, dead: false, brake: false, boost: false, ...o });
const look = { part(p, g) { const m = new THREE.Mesh(g); p.add(m); return m; } };
look.glow = look.part;
function cells({ water = true, wall = false, hot = false } = {}) {
  return {
    ready: true, version: 1, dims: [128, 64, 128],
    id(x, y, z) {
      if (x < 0 || x >= 128 || z < 0 || z >= 128 || y < 0) return -1;
      if (wall && z >= 64 && z < 66) return E.ROCK;
      return water && y * CELL_M < WATER_Y ? E.WATER : E.EMPTY;
    },
    kind(id) { return id < 0 ? K.SOLID : ELEMENTS[id].kind; },
    T() { return hot ? 400 : 20; },
    isLiquid(x, y, z) { const id = this.id(x, y, z); return id >= 0 && this.kind(id) === K.LIQUID; },
  };
}
function fixture(options = {}, build = buildBoat, spec = BOAT) {
  const c = cells(options), phys = createPhysics(R, c);
  const v = build(R, phys, look, { at: new THREE.Vector3(19.2, options.water === false ? 0 : WATER_Y, 8), yaw: 0, key: 'test' });
  return {
    v, c,
    step(seconds, input = drive(), sample) {
      for (let i = 0; i < Math.round(seconds / H); i++) {
        const p = v.body.translation();
        phys.syncTerrain([{ x: p.x / CELL_M, y: p.y / CELL_M, z: p.z / CELL_M, key: 'test', ...spec.GROUND }]);
        phys.step(H, (h) => v.step(h, input, c));
        sample?.(v);
      }
    },
    close() {
      v.root.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      v.dispose(); phys.world.free();
    },
  };
}
function test(name, options, fn, build, spec) {
  const f = fixture(options, build, spec);
  try { fn(f); console.log(`ok ${name}`); } finally { f.close(); }
}
const up = (v) => new THREE.Vector3(0, 1, 0).applyQuaternion(v.body.rotation()).y;

test('boat floats, recovers roll/pitch, and remains stable unoccupied', {}, ({ v, step }) => {
  v.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0.25)), true);
  step(10, drive({ parked: true }));
  let lo = Infinity, hi = -Infinity, upright = 1;
  step(4, drive({ parked: true }), () => { const y = v.body.translation().y; lo = Math.min(lo, y); hi = Math.max(hi, y); upright = Math.min(upright, up(v)); });
  assert.ok(lo > WATER_Y - 0.3 && hi < WATER_Y + 0.5, `height ${lo}..${hi}`);
  assert.ok(hi - lo < 0.2 && upright > 0.98, `bob ${hi - lo}, up ${upright}`);
  assert.ok(v.state.wet > 0 && v.state.wet < 1 && v.state.motorWet);
});
test('uneven actual liquid cells produce free roll and pitch', {}, ({ v, c, step }) => {
  step(4);
  const original = c.id;
  c.id = function (x, y, z) {
    if (x * CELL_M > 19.2 && z * CELL_M > 8 && y * CELL_M < WATER_Y + 0.3) return E.WATER;
    return original.call(this, x, y, z);
  };
  step(0.5);
  const q = v.body.rotation();
  assert.ok(Math.abs(q.x) > 0.01 && Math.abs(q.z) > 0.01, `roll/pitch quaternion ${q.x}, ${q.z}`);
  assert.ok(up(v) > 0.9);
});
test('wet bow with a dry stern cannot run the motor', {}, ({ v, c, step }) => {
  v.body.setTranslation({ x: 19.2, y: WATER_Y, z: 8 }, true);
  const original = c.id;
  c.id = function (x, y, z) { return z * CELL_M > 8 ? original.call(this, x, y, z) : E.EMPTY; };
  step(H, drive({ throttle: 1, steer: 1 }));
  assert.ok(v.state.wet > 0 && !v.state.motorWet);
  assert.ok(Math.hypot(v.body.linvel().x, v.body.linvel().z) < 0.001 && Math.abs(v.body.angvel().y) < 0.001);
});
test('water motor reaches useful speed, coasts, then reverses', {}, ({ v, step }) => {
  step(4);
  const z = v.body.translation().z;
  step(4, drive({ throttle: 1 }));
  assert.ok(v.speed > 3 && v.body.translation().z > z + 7, `speed ${v.speed}`);
  const speed = v.speed, coastZ = v.body.translation().z;
  step(0.75, drive({ parked: true }));
  assert.ok(v.speed > 0.5 && v.speed < speed && v.body.translation().z > coastZ);
  step(6, drive({ throttle: -1 }));
  assert.ok(v.speed < -1, `reverse ${v.speed}`);
});
for (const steer of [-1, 1]) test(`water steering ${steer} turns without capsizing`, {}, ({ v, step }) => {
  step(4); step(2, drive({ throttle: 1 }));
  const x = v.body.translation().x;
  step(1.5, drive({ throttle: 1, steer }));
  assert.ok((v.body.translation().x - x) * steer > 0.5);
  assert.ok(up(v) > 0.9);
});
test('reverse steering turns the opposite way', {}, ({ v, step }) => {
  step(4); step(2, drive({ throttle: -1 }));
  step(1, drive({ throttle: -1, steer: 1 }));
  assert.ok(v.body.angvel().y < -0.2);
});
for (const airborne of [false, true]) test(`dry ${airborne ? 'airborne' : 'grounded'} boat cannot propel or steer`, { water: false }, ({ v, step }) => {
  step(3);
  if (airborne) v.body.setTranslation({ x: 19.2, y: 14, z: 8 }, true);
  const p = { ...v.body.translation() };
  step(airborne ? 0.75 : 3, drive({ throttle: 1, steer: 1, brake: true, boost: true }));
  assert.ok(Math.hypot(v.body.translation().x - p.x, v.body.translation().z - p.z) < 0.01);
  assert.ok(Math.abs(v.body.angvel().y) < 0.01 && !v.state.motorWet && v.state.wet === 0);
});
test('dead motor cannot drive a floating hull', {}, ({ v, step }) => {
  step(4); const z = v.body.translation().z;
  step(3, drive({ throttle: 1, steer: 1, dead: true }));
  assert.ok(Math.abs(v.body.translation().z - z) < 0.01 && Math.abs(v.body.angvel().y) < 0.01);
});
test('boat hits solid shoreline instead of passing through it', { wall: true }, ({ v, step }) => {
  step(4); step(7, drive({ throttle: 1 }));
  assert.ok(v.body.translation().z < 64 * CELL_M - 1.4);
  assert.ok(v.body.translation().z > 64 * CELL_M - 2.5);
});
test('Jeep sinks fully below water, retaining liquid drag and heat', { hot: true }, ({ v, step }) => {
  step(2);
  assert.ok(v.body.translation().y < WATER_Y - 1 && v.body.linvel().y < -0.2, `y ${v.body.translation().y}`);
  assert.equal(v.state.wet, 1); assert.equal(v.state.hot, true);
  assert.ok(v.body.linvel().y > -8, 'liquid drag limits sinking speed');
}, buildJeep, JEEP);

// Stable tool ID and legacy pad save path (new one-shots: entities-node-check.mjs).
assert.equal(SPAWNER.BOAT, 'boat');
const tool = itemByKey('BOATPAD');
assert.ok(tool && isSpawnerTool(tool.id) && PALETTE.find((p) => p.name === 'Entities').items.includes('BOATPAD'));
assert.equal(new Set(TOOLS.map((t) => t.id)).size, TOOLS.length, 'tool IDs are unique');
const sim = { origin: new THREE.Vector3(), g: { nx: 128, ny: 64, nz: 128 } };
const sp = new Spawners({ scene: new THREE.Scene(), getSim: () => sim, getVolume: () => new THREE.Group(), getScale: () => 1 });
try {
  const surface = feetOnHit({ cell: new THREE.Vector3(64, WATER_Y / CELL_M - 1, 40), face: 2 });
  assert.equal(surface.y * CELL_M, WATER_Y);
  sp.toggle(SPAWNER.BOAT, surface);
  const saved = sp.toJSON(); sp.fromJSON(saved);
  assert.deepEqual(sp.toJSON(), saved); assert.equal(sp.of('boat').length, 1);
  assert.equal(sp.of('boat')[0].obj.name, 'spawner-boat');
  sp.toggle(SPAWNER.BOAT, surface); assert.equal(sp.of('boat').length, 0);
  console.log('ok Boat tool ID, legacy water-surface pad, save roundtrip and removal');
} finally { sp.clear(); }
console.log('all boat checks passed');
