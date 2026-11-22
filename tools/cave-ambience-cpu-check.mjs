// CPU-only tests of the cave detector, scheduler, and shared POV preset names.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E } from '../src/elements.js';
import { BIG_MAP, SMALL_MAP } from '../src/mapKind.js';
import { PROBE, PROBE_OUTSIDE } from '../src/shaders/povBody.js';
import { PRESET_NAMES } from '../src/pov/audio.js';
import { createCaveAmbience, hasCaveRoof } from '../src/pov/caveAmbience.js';

const UNKNOWN = -2;   // player.cellAt outside the cached probe, but inside the grid
const DRIP = 'caveDrip', GEIGER = 'caveGeiger', SETTLE = 'caveSettle';

// Fixture cellAt has the player's grid-local API. On a World the grid is a
// moving window, so its grid coordinates need not match the same cave on a Box.
function fixture({ kind = SMALL_MAP, roof = E.ROCK, roofY = 3, ore, wet } = {}) {
  const worldX = kind.streamed ? 423 : 20, worldZ = kind.streamed ? 700 : 25, eyeY = 18;
  let originX = kind.streamed ? 390 : 0, originZ = kind.streamed ? 670 : 0;
  const extras = new Map();
  const yLo = 4;
  const player = {
    pos: { x: worldX - originX + 0.25, y: eyeY - 2.25, z: worldZ - originZ + 0.25 },
    eyeHeight: 2.5, dead: false,
    cellAt(x, y, z) {
      if (x < 0 || z < 0 || x >= 96 || z >= 96 || y < 0) return PROBE_OUTSIDE;
      if (y >= 64) return E.EMPTY;
      const dx = x + originX - worldX, dz = z + originZ - worldZ;
      if (dx < -PROBE.X / 2 || dx >= PROBE.X / 2 || dz < -PROBE.Z / 2 || dz >= PROBE.Z / 2 || y < yLo || y >= yLo + PROBE.Y) return UNKNOWN;
      const dy = y - eyeY;
      return extras.get(`${dx},${dy},${dz}`) ?? (dy === roofY || dy === roofY + 1 ? roof : E.EMPTY);
    },
  };
  const set = (x, y, z, id) => extras.set(`${x},${y},${z}`, id);
  if (ore !== undefined) set(1, -1, 0, ore);
  if (wet !== undefined) set(0, -2, 1, wet);
  return {
    player, set,
    roof: () => hasCaveRoof(player.cellAt, Math.floor(player.pos.x), eyeY, Math.floor(player.pos.z)),
    recenter(dx, dz) {
      originX += dx; originZ += dz;
      player.pos.x -= dx; player.pos.z -= dz;
    },
  };
}

function record(player, random = () => 0.5) {
  let t = 0;
  const events = [];
  const cave = createCaveAmbience({ play: (name, args) => events.push({ name, t, ...args }), random });
  const state = { player, active: true, paused: false, muted: false };
  const tick = (dt, overrides) => { t += dt; return cave.update(dt, { ...state, ...overrides }); };
  return {
    events, tick,
    run(seconds, overrides) { for (let i = 0; i < seconds * 20; i++) tick(0.05, overrides); },
    sounds: (name) => events.filter((e) => e.name === name),
  };
}

function checkGaps(events, min, max) {
  assert.ok(events.length >= 2);
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].t - events[i - 1].t;
    assert.ok(gap >= min - 1e-8 && gap <= max + 0.051, `gap ${gap} not in ${min}–${max}s (+ tick rounding)`);
  }
}

test('requires a broad geological roof and a probed, unburied eye', () => {
  for (const roof of [E.ROCK, E.LIMESTONE, E.SANDSTONE, E.COAL, E.BASALT, E.URANIUM_ORE]) {
    assert.equal(fixture({ roof }).roof(), true);
  }
  assert.equal(fixture({ roofY: 13 }).roof(), true);
  assert.equal(fixture({ roofY: 18 }).roof(), false, 'cannot infer roof beyond probe');
  for (const roof of [E.EMPTY, E.WOOD, E.GLASS, E.WATER, E.STONE, UNKNOWN, PROBE_OUTSIDE]) {
    assert.equal(fixture({ roof }).roof(), false);
  }
  const shaft = fixture();
  for (const y of [3, 4]) shaft.set(0, y, 0, E.EMPTY);
  assert.equal(shaft.roof(), false, 'open sky directly overhead');
  const overhang = fixture({ roof: E.EMPTY });
  overhang.set(0, 3, 0, E.ROCK);
  assert.equal(overhang.roof(), false, 'isolated rock overhead');
  const eye = fixture();
  eye.set(0, 0, 0, E.WATER);
  assert.equal(eye.roof(), true, 'submerged eye can still be underground');
  for (const id of [UNKNOWN, PROBE_OUTSIDE, E.ROCK, E.STONE]) {
    eye.set(0, 0, 0, id);
    assert.equal(eye.roof(), false);
  }
});

test('Descent native bedrock qualifies as a cave roof', () => {
  for (const roof of [E.NOITA_SNOWROCK, E.NOITA_VAULT, E.NOITA_TEMPLE, E.NOITA_LUSH]) {
    assert.equal(fixture({ roof, kind: BIG_MAP }).roof(), true);
  }
});

test('damp signs schedule soft drips; drip pitch and spacing vary', () => {
  for (const wet of [E.WATER, E.SALTWATER, E.MUD, E.MOSS]) {
    const log = record(fixture({ wet }).player, () => 0);
    log.run(3.9);
    assert.equal(log.sounds(DRIP).length, 0);
    log.run(0.2);
    assert.equal(log.sounds(DRIP).length, 1);
  }
  let i = 0;
  const draws = [0, 0.5, 0.1, 0.95, 0.8, 0.5, 0.9, 0.15, 0.99];
  const log = record(fixture({ wet: E.WATER }).player, () => draws[i++ % draws.length]);
  log.run(24);
  const drips = log.sounds(DRIP);
  checkGaps(drips, 4, 11);
  assert.ok(new Set(drips.map((e) => e.rate)).size > 1);
  assert.ok(new Set(drips.slice(1).map((e, j) => (e.t - drips[j].t).toFixed(2))).size > 1);
});

test('dry caves have only sparse settle sounds; cues outside the scan radius do not count', () => {
  const cave = fixture();
  cave.set(6, 0, 0, E.WATER);
  cave.set(0, 0, 6, E.URANIUM_ORE);
  const log = record(cave.player, () => 0);
  log.run(31.9);
  assert.equal(log.events.length, 0);
  log.run(98.1);
  assert.ok(log.events.every((e) => e.name === SETTLE));
  checkGaps(log.events, 32, 32);
});

test('ore, uranium and plutonium trigger Geiger clicks, with distance falloff and a hard rate cap', () => {
  function clicks(ore, x = 1, dense = false) {
    const cave = fixture();
    if (dense) for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) cave.set(x, -1, z, ore);
    else cave.set(x, -1, 0, ore);
    const log = record(cave.player, () => 0);
    log.run(60);
    return log.sounds(GEIGER);
  }
  const near = clicks(E.URANIUM_ORE), far = clicks(E.URANIUM_ORE, 4), dense = clicks(E.URANIUM_ORE, 1, true);
  assert.ok(near.length > far.length && far.length > 0 && dense.length > near.length);
  assert.deepEqual(near, clicks(E.URANIUM));
  assert.deepEqual(near, clicks(E.PLUTONIUM));
  assert.equal(clicks(E.COPPER_ORE).length, 0);
  checkGaps(dense, 1.7, 2);
  assert.ok(dense.length <= Math.floor(60 / 1.7) && dense.every((e) => e.gain <= 0.21));
});

test('god view, pause, mute, death, unprobed space and outdoors go silent and reset timers', () => {
  const cave = fixture({ wet: E.WATER, ore: E.PLUTONIUM });
  for (const overrides of [{ active: false }, { paused: true }, { muted: true }, { player: { ...cave.player, dead: true } }, { player: null },
    { player: fixture({ roof: UNKNOWN, wet: E.WATER, ore: E.URANIUM }).player },
    { player: fixture({ roof: E.EMPTY, wet: E.WATER, ore: E.URANIUM }).player }]) {
    const log = record(cave.player, () => 0);
    log.run(3);
    const before = log.events.length;
    assert.equal(log.tick(0.05, overrides), false);
    log.run(90, overrides);
    log.run(3);
    assert.equal(log.events.length, before, 'no play while silent or immediate catch-up after returning');
  }
  const log = record(cave.player, () => 0);
  assert.equal(log.tick(3600), true);
  assert.equal(log.events.length, 0, 'a stalled frame cannot run up a burst of missed cues');
  log.run(2);
  cave.set(0, -2, 1, E.EMPTY);
  cave.set(1, -1, 0, E.EMPTY);
  log.run(16);
  assert.deepEqual(log.events, [], 'a drained pool and mined ore lose their cues on the next local scan');
});

test('Box and World schedule identical presets from the same cached cells, including after a window shift', () => {
  function playIn(kind) {
    const cave = fixture({ kind, wet: E.SALTWATER, ore: E.URANIUM_ORE });
    const log = record(cave.player);
    log.run(26);
    if (kind.streamed) cave.recenter(8, -7);
    log.run(80);
    return log.events;
  }
  const box = playIn(SMALL_MAP), world = playIn(BIG_MAP);
  assert.deepEqual(box, world);
  assert.deepEqual(new Set(box.map((e) => e.name)), new Set([DRIP, GEIGER, SETTLE]));
  for (const name of [DRIP, GEIGER, SETTLE]) assert.ok(PRESET_NAMES.includes(name), `audio preset registered: ${name}`);
});
