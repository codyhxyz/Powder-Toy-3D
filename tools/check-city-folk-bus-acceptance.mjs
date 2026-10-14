// Real transport controller + focus loop + live edited composed-cell adapter.
// Imported by check-city-folk.mjs. CPU only; no graphics, timers or browser.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { E } from '../src/elements.js';
import { GAMEMODES } from '../src/maps.js';
import { BrickStore, BRICK_FLOATS, encodeBrick, decodeBrick } from '../src/world/store.js';

export async function acceptCityBus({ scene, twin, size, seed }) {
  const { createCityBus, withCityBusFocus, cityBusArrivalClear, CITY_BUS_STOPS } = await import('../src/pov/village/bus.js');
  const toWorld = p => new Vector3(p[0] + size[0] / 2, p[1], p[2] + size[2] / 2);
  const town = toWorld(CITY_BUS_STOPS.town.arrival), city = toWorld(CITY_BUS_STOPS.city.arrival);
  const store = new BrickStore(size.map(n => n / 4));
  const sim = { g: { nx: 128, ny: 128, nz: 128 }, origin: new Vector3(town.x - 64, 0, town.z - 64), deco: { pending: Promise.resolve() } };
  const player = { pos: town.clone().sub(sim.origin), vel: new Vector3(), width: 6, height: 11, dead: false,
    health: 83, statuses: { chill: 0.3 }, jumpCharge: 1,
    cancelJump() { this.jumpCharge = null; }, teleport(p) { this.pos.copy(p); teleports++; return true; } };
  const world = { scene, P: { size, seed }, loaded: true, epoch: 1, sim, store, pending: Promise.resolve() };
  let mode = 'animalCrossing', active = true, focus = null, teleports = 0, shifts = 0, renders = 0, holdReads = null;
  let currentWorld = world, currentSim = sim;
  const furniture = { placed: [{ id: 'lamp', x: 7, z: -6 }] }, furnitureBefore = structuredClone(furniture);
  const bytesAt = (x, y, z) => store.key(Math.floor(x / 4), Math.floor(y / 4), Math.floor(z / 4));
  const edited = (x, y, z) => {
    const bytes = store.map.get(bytesAt(x, y, z)); if (!bytes) return null;
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS); decodeBrick(bytes, A, 0, B, 0);
    return A[((z % 4) * 16 + (y % 4) * 4 + x % 4) * 4];
  };
  function edit(x, y, z, id) {
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    const bx = Math.floor(x / 4) * 4, by = Math.floor(y / 4) * 4, bz = Math.floor(z / 4) * 4;
    for (let dz = 0; dz < 4; dz++) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++)
      A[(dz * 16 + dy * 4 + dx) * 4] = twin.wcCell(bx + dx, by + dy, bz + dz);
    const existing = store.map.get(bytesAt(x, y, z)); if (existing) decodeBrick(existing, A, 0, B, 0);
    const i = ((z % 4) * 16 + (y % 4) * 4 + x % 4) * 4;
    A[i] = id; A[i + 1] = 123; B[i] = 2.5;
    store.put(bytesAt(x, y, z), encodeBrick(A, 0, B, 0));
  }
  sim.readCell = async (x, y, z) => {
    if (holdReads) { holdReads.started.release(); await holdReads.promise; }
    const wx = x + sim.origin.x, wy = y + sim.origin.y, wz = z + sim.origin.z;
    return [[edited(wx, wy, wz) ?? twin.wcCell(wx, wy, wz), 0, 0, 0]];
  };
  const move = () => {
    const desired = new Vector3(focus[0] - 64, 0, focus[1] - 64);
    const delta = new Vector3();
    for (const a of ['x', 'z']) delta[a] = Math.sign(desired[a] - sim.origin[a]) * Math.min(16, Math.abs(desired[a] - sim.origin[a]));
    if (!delta.x && !delta.z) return false;
    sim.origin.add(delta); player.pos.sub(delta); shifts++; return true;
  };
  const adapter = { getWorld: () => currentWorld, getSim: () => currentSim, getMode: () => mode, getPlayer: () => player,
    active: () => active, requestRender() { renders++; }, notify() {},
    withVillageFocus: (at, valid, visit) => withCityBusFocus({ world: currentWorld, at, valid,
      getFocus: () => focus, setFocus: f => { focus = f; }, move, visit }) };
  const bus = createCityBus(adapter);
  const place = p => { sim.origin.set(p.x - 64, 0, p.z - 64); player.pos.copy(p).sub(sim.origin); };
  const absolute = () => player.pos.clone().add(sim.origin);
  const deferred = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
  try {
    // Two edited bricks away from the aprons, including non-id state channels.
    edit(town.x + 24, 52, town.z, E.GOLD); edit(city.x + 24, 52, city.z, E.CERAMIC);
    const snapshot = store.toBytes();
    assert.equal(bus.nearby(), 'town', 'discoverable town boarding');
    assert.equal(await cityBusArrivalClear(sim, player.pos, player), true, 'composed town apron supports full body');
    const outward = bus.board(); assert.equal(bus.busy, true);
    const input = { move: { x: 1, z: -1 }, jump: true, chargeJump: true, sprint: true, down: true, crouch: true };
    bus.freeze(input); assert.deepEqual(input.move, { x: 0, z: 0 }); assert.equal(input.jump, false); assert.equal(input.cancelJump, true);
    assert.equal((await bus.board()).ok, false, 'duplicate requests cannot overlap');
    assert.equal((await outward).ok, true); assert(absolute().equals(city), 'arrived at actual city landmark');
    assert.equal(bus.nearby(), 'city', 'discoverable return action'); assert.equal(focus, null); assert(shifts > 0);
    assert.equal((await bus.board()).ok, true); assert(absolute().equals(town), 'roundtrip returns to same town world');
    assert.equal(teleports, 2); assert.equal(world.store, store); assert.equal(currentWorld, world); assert.equal(currentSim, sim);
    assert.deepEqual(store.toBytes(), snapshot, 'voxel edits and all encoded state bytes survive both journeys');
    assert.deepEqual(furniture, furnitureBefore); assert.equal(player.health, 83); assert.deepEqual(player.statuses, { chill: 0.3 }); assert(renders > 0);
    // Edited occupied and unsupported arrivals must fail safely; then recover.
    for (const [y, id] of [[48, E.BRICK], [47, E.EMPTY], [47, E.WATER]]) {
      place(town); edit(city.x, y, city.z, id); const before = store.toBytes(), n = teleports;
      const result = await bus.board(); assert.equal(result.ok, false); assert.equal(result.reason, 'blocked');
      assert(absolute().equals(town)); assert.equal(teleports, n); assert.equal(focus, null); assert.deepEqual(store.toBytes(), before);
      store.drop(bytesAt(city.x, y, city.z));
    }
    // Cancellation/invalidations race while actual edited-cell reads are pending.
    for (const reason of ['cancel', 'mode', 'inactive', 'death', 'epoch', 'replacement', 'origin']) {
      mode = 'animalCrossing'; active = true; player.dead = false; currentWorld = world; currentSim = sim; place(town);
      holdReads = { ...deferred(), started: deferred() }; const pending = bus.board();
      await holdReads.started.promise;
      assert(focus, `${reason}: real edited-cell arrival check holds focus`); const n = teleports;
      if (reason === 'cancel') bus.cancel();
      if (reason === 'mode') mode = 'sandbox';
      if (reason === 'inactive') active = false;
      if (reason === 'death') player.dead = true;
      if (reason === 'epoch') world.epoch++;
      if (reason === 'replacement') currentWorld = { ...world, epoch: world.epoch + 1 };
      if (reason === 'origin') sim.origin.x++;
      holdReads.release(); holdReads = null;
      assert.equal((await pending).ok, false, reason); assert.equal(teleports, n, `${reason}: no stale teleport`);
      assert.equal(bus.busy, false); assert.equal(focus, null); assert.equal(world.store, store);
    }
    mode = 'animalCrossing'; active = true; player.dead = false; currentWorld = world; currentSim = sim; place(town);
    for (const { key: forbiddenMode } of GAMEMODES.filter(m => m.key !== 'animalCrossing')) {
      mode = forbiddenMode; assert.equal(bus.nearby(), null); assert.equal((await bus.board('town')).ok, false);
    }
    mode = 'animalCrossing'; world.P.size = [1024, 128, 1024]; assert.equal(bus.nearby(), null); assert.equal((await bus.board('town')).ok, false);
    world.P.size = size; currentWorld = { ...world, scene: { key: 'island' } }; assert.equal(bus.nearby(), null);
    currentWorld = world; place(town.clone().add(new Vector3(64, 0, 0))); assert.equal((await bus.board('town')).ok, false, 'cannot remotely board');
    bus.dispose(); place(town); assert.equal((await bus.board('town')).ok, false, 'disposed bus isolated');
    let attempts = 0;
    await assert.rejects(withCityBusFocus({ world, at: [city.x, city.z], valid: () => true,
      getFocus: () => focus, setFocus: f => { focus = f; }, move: () => { attempts++; return true; } }), /did not converge/);
    assert.equal(attempts, Math.ceil((size[0] + size[2]) / 16) + 4, 'focus convergence is bounded'); assert.equal(focus, null);
  } finally { holdReads?.release(); bus.dispose(); }
}
