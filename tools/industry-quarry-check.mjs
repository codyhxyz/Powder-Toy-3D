// CPU only: node --test tools/industry-quarry-check.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { E } from '../src/elements.js';
import { DEVICE_TYPES, QUARRY_STARTERS, QUARRY_SPAWN, baseMaterial } from '../src/industry/catalog.js';
import { createProgression } from '../src/industry/progression.js';
import { buildQuarry } from '../src/industry/quarry.js';
import { mapByKey, mapsFor, resolveMode } from '../src/maps.js';

const deliver = (p, count, id = E.NUGGETS, temperature = 20) => p.ship({ id, count, temperature });
const clone = value => JSON.parse(JSON.stringify(value));

test('physical deliveries unlock permanent stages, full-price builds/refunds, completion and freeplay', () => {
  let p = createProgression();
  assert.equal(p.snapshot().credits, 24);
  assert.equal(p.snapshot().stage, 0);
  assert.equal(p.canBuild('foundation').ok, true);
  assert.equal(p.build('foundation').ok, true);
  assert.equal(p.snapshot().credits, 23);
  assert.deepEqual(createProgression(clone(p.snapshot())).snapshot(),p.snapshot());
  assert.equal(p.refund('foundation').ok, true);
  assert.equal(p.snapshot().credits, 24);
  assert.equal(p.canBuild('miner').ok, false);
  assert.equal(deliver(p, 12).ok, true);
  assert.equal(p.snapshot().stage, 1);
  assert.equal(p.build('miner').ok, true);
  assert.equal(p.snapshot().credits, 18);
  assert.equal(p.build('lift').ok, true);
  for (let n = 0; n < 5; n++) assert.equal(p.build('belt').ok, true);
  assert.equal(p.snapshot().credits, 0);
  assert.equal(p.canBuild('belt').ok, false);
  assert.equal(p.snapshot().unlocked.includes('miner'), true);
  assert.equal(p.snapshot().stage, 1);
  p = createProgression(clone(p.snapshot()));
  assert.equal(p.refund('miner').ok, true);
  assert.equal(p.snapshot().credits, 18);
  assert.equal(p.refund('miner').ok, false);
  assert.equal(p.build('miner').ok, true);
  assert.equal(deliver(p, 36).ok, true);
  assert.equal(p.snapshot().stage, 2);
  assert.equal(p.build('pump').ok, true);
  assert.equal(deliver(p, 48).ok, true);
  assert.equal(p.snapshot().stage, 3);
  assert.equal(p.build('heater').ok, true);
  const before = p.snapshot();
  assert.equal(deliver(p, 32, E.METAL, 91).ok, false);
  assert.deepEqual(p.snapshot(), before);
  assert.equal(deliver(p, 31, E.METAL, 90).ok, true);
  assert.equal(p.snapshot().complete, false);
  assert.equal(deliver(p, 1, E.METAL, -10).ok, true);
  assert.equal(p.snapshot().complete, true);
  assert.equal(p.snapshot().earned, 224);
  assert.equal(p.snapshot().stage, 4);
  assert.equal(p.build('heater').ok, true);
  assert.equal(deliver(p, 1).ok, true);
  assert.deepEqual(createProgression(clone(p.snapshot())).snapshot(), p.snapshot());
});

test('starter ownership refunds exactly once; every catalog price is honored', () => {
  const p = createProgression();
  for (const d of QUARRY_STARTERS) assert.equal(p.refund(d.type).ok, true);
  const equity = 24 + QUARRY_STARTERS.reduce((n, d) => n + DEVICE_TYPES[d.type].cost, 0);
  assert.equal(p.snapshot().credits, equity);
  for (const type of Object.keys(DEVICE_TYPES)) assert.equal(p.refund(type).ok, false);
  deliver(p, 96);
  for (const [type, spec] of Object.entries(DEVICE_TYPES)) {
    const before = p.snapshot();
    assert.equal(p.build(type).ok, true);
    assert.equal(p.snapshot().credits, before.credits - spec.cost);
    assert.equal(p.refund(type).ok, true);
    assert.deepEqual(p.snapshot(), before);
  }
});

test('invalid actions never mutate money or progress, snapshots do not leak mutable state', () => {
  const p = createProgression();
  const before = p.snapshot();
  for (const type of ['__proto__', 'constructor', '', null, {}, 1, Symbol('belt')]) {
    assert.equal(p.canBuild(type).ok, false);
    assert.equal(p.build(type).ok, false);
    assert.equal(p.refund(type).ok, false);
  }
  for (const count of [NaN, Infinity, -Infinity, -1, 0, 0.5, '12', Number.MAX_SAFE_INTEGER]) {
    assert.equal(deliver(p, count).ok, false);
  }
  for (const temperature of [NaN, Infinity, -Infinity, undefined, null, '20']) {
    assert.equal(deliver(p, 12, E.NUGGETS, temperature === undefined ? NaN : temperature).ok, false);
  }
  for (const id of [E.SAND, E.SCRAP, E.GOLD, E.LAVA, `${E.NUGGETS}`, null]) assert.equal(deliver(p, 12, id).ok, false);
  for (const batch of [null, undefined, [], {}, 1]) assert.equal(p.ship(batch).ok, false);
  const leaked = p.snapshot();
  leaked.owned.belt = 100;
  leaked.unlocked.push('miner');
  leaked.delivered.metal = 100;
  assert.deepEqual(p.snapshot(), before);
});

test('save validation rejects nonfinite, negative, fractional and inconsistent equity; derived state is rebuilt', () => {
  const fresh = createProgression().snapshot();
  for (const invalid of [null, [], 1, {}, { ...fresh, version: 2 }]) assert.throws(() => createProgression(invalid), TypeError);
  for (const key of ['credits', 'earned']) {
    for (const value of [NaN, Infinity, -1, 0.25, '24', Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => createProgression({ ...fresh, [key]: value }), TypeError);
    }
  }
  for (const mutate of [
    s => s.credits++, s => s.earned++, s => s.owned.belt++,
    s => delete s.owned.pump, s => s.owned.pump = -1,
    s => s.owned.pump = Infinity, s => s.owned.extra = 0,
    s => s.delivered.nuggets = 12, s => s.delivered.metal = NaN,
    s => s.delivered.metal = -1, s => s.delivered.nuggets = 0.5,
  ]) {
    const saved = clone(fresh);
    mutate(saved);
    assert.throws(() => createProgression(saved), TypeError);
  }
  const forgedDisplay = { ...fresh, stage: 4, complete: true, unlocked: Object.keys(DEVICE_TYPES), goal: 'fake', hint: 'fake' };
  assert.deepEqual(createProgression(forgedDisplay).snapshot(), fresh);
});

const N = 128;
const ids = new Uint16Array(N ** 3);
const at = (x, y, z) => ids[(y * N + z) * N + x];
const set = (x, y, z, id) => {
  assert.ok(Number.isInteger(id), `unknown material ${id}`);
  assert.ok([x, y, z].every(n => Number.isInteger(n) && n >= 0 && n < N), `out of bounds ${x},${y},${z}`);
  ids[(y * N + z) * N + x] = id;
};
const box = (x0, y0, z0, x1, y1, z1, id) => {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id);
};
buildQuarry({ g: { nx: N, ny: N, nz: N }, set, box });

test('quarry has safe spawn, reserved registered starter decks and a physical mixed upstream batch', () => {
  const [sx, sy, sz] = QUARRY_SPAWN;
  for (let x = sx - 2; x <= sx + 2; x++) for (let z = sz - 2; z <= sz + 2; z++) {
    assert.notEqual(at(x, sy - 1, z), E.EMPTY);
    for (let y = sy; y < sy + 8; y++) assert.equal(at(x, y, z), E.EMPTY);
  }
  let gold = 0, sand = 0;
  for (const d of QUARRY_STARTERS) for (let x = d.x; x < d.x + 4; x++) for (let z = d.z; z < d.z + 4; z++) {
    assert.equal(at(x, d.y, z), baseMaterial(d.type));
    for (let y = d.y + 1; y < d.y + 8; y++) {
      const id = at(x, y, z);
      if (d.type !== 'belt' || d.id !== 'starter-belt') assert.equal(id, E.EMPTY);
      if (id === E.NUGGETS) gold++;
      if (id === E.SAND) sand++;
    }
  }
  assert.equal(gold, 16);
  assert.equal(sand, 8);
  assert.equal(createProgression().snapshot().earned, 0, 'map does not pre-credit deliveries');
});

test('terraces, continuous haul ramp, finite water, accessible ore and thermal yard', () => {
  const height = (x, z) => {
    for (let y = 127; y >= 0; y--) if (at(x, y, z) !== E.EMPTY) return y + 1;
    return 0;
  };
  assert.deepEqual([height(4, 64), height(16, 64), height(32, 64), height(64, 64)], [32, 24, 16, 8]);
  for (let x = 72; x < 80; x++) {
    let last = 8;
    for (let z = 88; z < 128; z++) {
      const h = height(x, z);
      assert.ok(h >= last && h - last <= 1, `ramp discontinuity ${x},${z}`);
      last = h;
    }
    assert.equal(last, 32);
  }
  for (const [x, y, z, id, airX, airZ] of [
    [48, 10, 35, E.GOLD, 48, 36], [92, 10, 50, E.METAL, 91, 50], [48, 10, 92, E.COAL, 48, 91],
  ]) {
    assert.equal(at(x, y, z), id);
    assert.equal(at(airX, y, airZ), E.EMPTY);
  }
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  assert.equal(counts.get(E.NUGGETS), 220);
  assert.ok(counts.get(E.GOLD) >= 1000);
  assert.equal(counts.get(E.WATER), 960);
  assert.equal(counts.get(E.CLONE) ?? 0, 0);
  assert.equal(at(82, 7, 40), E.TUNGSTEN);
  assert.equal(at(82, 8, 40), E.EMPTY);
  assert.equal(at(72, 3, 60), E.ROCK);
  assert.equal(at(72, 4, 60), E.EMPTY);
  assert.throws(() => buildQuarry({ g: { nx: 64, ny: 128, nz: 128 }, set, box }), RangeError);
});

test('quarry preset loads ordinary material state through the existing builder callbacks', async () => {
  const { buildPreset } = await import('../src/presets.js');
  let loaded = false;
  const sim = {
    g: { nx: N, ny: N, nz: N },
    blankState: () => [new Float32Array(N ** 3 * 4), new Float32Array(N ** 3 * 4)],
    cellTexel: (x, y, z) => (y * N + z) * N + x,
    load(A, B) {
      loaded = true;
      assert.equal(B.length, A.length);
      for (let i = 0; i < ids.length; i++) {
        assert.equal(A[i * 4], ids[i]);
        assert.ok(Number.isFinite(A[i * 4 + 1]), 'finite initial temperature');
      }
    },
  };
  assert.equal(buildPreset('quarry', sim), null);
  assert.equal(loaded, true);
});

test('map and Factory mode registration preserve Sandbox eligibility', () => {
  const map = mapByKey('quarry');
  assert.equal(map.preset, 'quarry');
  assert.deepEqual(map.dims, [128, 128, 128]);
  assert.equal(resolveMode(map, 'factory').key, 'factory');
  assert.equal(resolveMode(map, 'sandbox').key, 'sandbox');
  assert.equal(resolveMode(mapByKey('lab'), 'factory').key, 'sandbox');
  assert.deepEqual(mapsFor('factory').map(m => m.key), ['quarry']);
  assert.ok(mapsFor('sandbox').includes(map));
});
