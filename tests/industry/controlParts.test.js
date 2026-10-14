import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PARTS, CONTROL_PART_KEYS, CONTROL_PART_THRESHOLD_BOUNDS, validateControlPartSpec,
  controlPartsWGSL, WGSL_CHECK, createFactoryControlParts,
} from '../../src/industry/controlParts.js';
import { E } from '../../src/elements.js';
import { World } from '../../src/ui/tiles/engine.js';

const BOUNDS = { nx: 32, ny: 32, nz: 32 };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function fakeSim() {
  const requests = [], slots = new Map();
  const ring = {
    buffer: {}, next() {
      const slot = slots.size;
      slots.set(slot, deferred());
      return slot;
    },
    read(slot) { return slots.get(slot).promise; },
    answer(i, values) { slots.get(requests[i].params.slot).resolve(new Float32Array(values).buffer); },
  };
  const gpu = {
    layout: () => ({}), readback: { ring: () => ring }, bindGroup: () => ({}),
    kernel: () => ({ ready: Promise.resolve() }), flush() {},
  };
  const sim = { g: BOUNDS, gpu, L: { TABLES: [], STATE_RW: [] }, tables: {}, bindRW: {}, version: 0,
    header: () => ({}), wake() {}, _dispatch(_kernel, _size, args) { requests.push(args); } };
  return { sim, requests, answer: (i, result) => ring.answer(i, result) };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('timed out waiting for async GPU stub operation');
}

test('control parts are a paid whitelist of existing native materials', () => {
  assert.deepEqual(CONTROL_PART_KEYS, ['TSNS', 'SWITCH', 'BATTERY', 'METAL', 'PSCN', 'NSCN', 'INSULATOR']);
  assert.deepEqual(CONTROL_PART_KEYS.map(key => CONTROL_PARTS[key].material), [E.TSNS, E.SWITCH, E.BATTERY, E.METAL, E.PSCN, E.NSCN, E.INSULATOR]);
  assert.deepEqual(CONTROL_PART_KEYS.map(key => CONTROL_PARTS[key].cost), [3, 2, 5, 1, 1, 1, 1]);
  for (const p of Object.values(CONTROL_PARTS)) assert.ok(p.description.length > 8);
  assert.equal(CONTROL_PARTS.TSNS.defaultThreshold, 200);
  assert.deepEqual(CONTROL_PART_THRESHOLD_BOUNDS, [-273.15, 10000]);
});

test('pure control-part validation enforces bounds and native TSNS threshold convention', () => {
  assert.deepEqual(validateControlPartSpec({ key: 'TSNS', x: 1, y: 2, z: 3 }, BOUNDS), {
    key: 'TSNS', material: E.TSNS, cost: 3, x: 1, y: 2, z: 3, threshold: 200,
  });
  assert.equal(validateControlPartSpec({ key: 'TSNS', x: 1, y: 2, z: 3, threshold: -273.15 }, BOUNDS).threshold, Math.fround(-273.15));
  assert.equal(validateControlPartSpec({ key: 'TSNS', x: 1, y: 2, z: 3, threshold: 10000 }, BOUNDS).threshold, 10000);
  assert.deepEqual(validateControlPartSpec({ key: 'SWITCH', x: 0, y: 0, z: 0 }, BOUNDS), {
    key: 'SWITCH', material: E.SWITCH, cost: 2, x: 0, y: 0, z: 0,
  });
  for (const key of ['', 'PCLN', 'WALL', 'SPARK']) {
    assert.throws(() => validateControlPartSpec({ key, x: 1, y: 2, z: 3 }, BOUNDS), /permitted/);
  }
  for (const position of [[-1, 1, 1], [1, 32, 1], [1.5, 1, 1], [1, 1, NaN]]) {
    assert.throws(() => validateControlPartSpec({ key: 'METAL', x: position[0], y: position[1], z: position[2] }, BOUNDS), /in-bounds/);
  }
  for (const threshold of [NaN, Infinity, -Infinity, -273.151, 10000.01, '200', null]) {
    assert.throws(() => validateControlPartSpec({ key: 'TSNS', x: 1, y: 2, z: 3, threshold }, BOUNDS), /threshold/);
  }
  assert.throws(() => validateControlPartSpec({ key: 'BATTERY', x: 1, y: 2, z: 3, threshold: undefined }, BOUNDS), /Only TSNS/);
  assert.throws(() => validateControlPartSpec({ key: 'SWITCH', x: 1, y: 2, z: 3, threshold: 200 }, BOUNDS), /Only TSNS/);
  assert.throws(() => validateControlPartSpec({ key: 'TSNS', x: 1, y: 2, z: 3 }, [0, 1, 1]), /bounds/);
});

test('control-part WGSL writes only an empty cell and toggles only actual E_SWITCH', () => {
  const code = controlPartsWGSL(BOUNDS);
  assert.match(code, /@compute @workgroup_size\(1\)/);
  assert.match(code, /if \(eid\(a\) == E_EMPTY\)/);
  assert.match(code, /if \(P\.mode == FACTORY_PART_TOGGLE && eid\(a\) == E_SWITCH\)/);
  assert.match(code, /outA\.z = select\(SWITCH_ON, SWITCH_ON - 1\.0, a\.z == SWITCH_ON\)/);
  assert.match(code, /SPAWNLIFE\(P\.material\)/);
  assert.match(code, /markBrick\(brickId\(P\.at >> vec3u\(2u\)\)\)/);
  assert.match(code, /markControlNeighbours\(P\.at\)/);
  assert.deepEqual(WGSL_CHECK[0].dispatch(), [1, 1, 1]);
  assert.deepEqual(WGSL_CHECK[0].layouts().at(-1), [{ binding: 0, buffer: { type: 'storage' } }]);
  const featureBody = code.slice(code.indexOf('const FACTORY_PART_PLACE'));
  assert.doesNotMatch(featureBody, /E_PCLN|E_CLONE|newElement|credits|partsSpent/);
});

test('OFF propagates through a touching switch bank instead of relatching ON', () => {
  const world = new World(8, 8);
  world.put(3, 3, E.SWITCH, { life: 9 });
  world.put(4, 3, E.SWITCH, { life: 10 });
  world.step();
  assert.equal(world.life[world.idx(3, 3)], 8);
  assert.equal(world.life[world.idx(4, 3)], 9);
  for (let step = 0; step < 12; step++) world.step();
  assert.equal(world.life[world.idx(3, 3)], 0);
  assert.equal(world.life[world.idx(4, 3)], 0);
});

test('place resolves only after confirmed write; occupied writes and non-switch toggles fail', async () => {
  const fake = fakeSim(), parts = createFactoryControlParts({ getSim: () => fake.sim });
  const placed = parts.place({ key: 'TSNS', x: 2, y: 3, z: 4, threshold: 450 });
  await waitFor(() => fake.requests.length === 1);
  assert.equal(parts.pending, 1);
  assert.equal(fake.requests[0].params.material, E.TSNS);
  assert.equal(fake.requests[0].params.temperature, 450);
  fake.answer(0, [1, E.TSNS, 450, 0]);
  const result = await placed;
  assert.deepEqual(result, { ok: true, reason: '', key: 'TSNS', material: E.TSNS, cost: 3, x: 2, y: 3, z: 4, threshold: 450 });
  assert.equal(parts.pending, 0);
  assert.equal(fake.sim.version, 1);

  const occupied = parts.place({ key: 'BATTERY', x: 2, y: 3, z: 4 });
  await waitFor(() => fake.requests.length === 2);
  fake.answer(1, [2, E.TSNS, 450, 0]);
  assert.equal((await occupied).ok, false);

  const toggle = parts.toggle({ x: 8, y: 3, z: 4 });
  await waitFor(() => fake.requests.length === 3);
  assert.equal(fake.requests[2].params.mode, 1);
  fake.answer(2, [2, E.BATTERY, 20, 0]);
  assert.equal((await toggle).ok, false);
  assert.equal(parts.pending, 0);
  parts.dispose();
});

test('toggle reports the confirmed native switch state and stale simulation writes do not succeed', async () => {
  const first = fakeSim(), second = fakeSim();
  let current = first.sim;
  const parts = createFactoryControlParts({ getSim: () => current });
  const toggle = parts.toggle({ x: 1, y: 1, z: 1 });
  await waitFor(() => first.requests.length === 1);
  first.answer(0, [1, E.SWITCH, 20, 10]);
  assert.deepEqual(await toggle, { ok: true, reason: '', key: 'SWITCH', material: E.SWITCH, x: 1, y: 1, z: 1, on: true });
  const pending = parts.place({ key: 'SWITCH', x: 2, y: 2, z: 2 });
  await waitFor(() => first.requests.length === 2);
  current = second.sim;
  first.answer(1, [1, E.SWITCH, 20, 0]);
  const stale = await pending;
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /Simulation changed/);
  assert.equal(parts.pending, 0);
  parts.dispose();
});

test('invalid placements return failed promises without GPU dispatch or charge', async () => {
  const fake = fakeSim(), parts = createFactoryControlParts({ getSim: () => fake.sim });
  const bad = await parts.place({ key: 'PCLN', x: 1, y: 1, z: 1 });
  assert.equal(bad.ok, false);
  assert.equal(fake.requests.length, 0);
  assert.equal(parts.pending, 0);
  assert.equal(Object.values(CONTROL_PARTS).some(p => p.material === E.PCLN), false);
  parts.dispose();
});
