import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E, ELEMENTS, R, itemByKey } from '../src/elements.js';
import { BUTTON_HOLD, conductsInto, ELEC, sparkLevel, takesSpark, tsnsSenses } from '../src/electricity.js';
import { decodeScenePlaques, nearbyPlaques } from '../src/lab/scenePlaques.js';
import { mapByKey, mapOf, mapsFor } from '../src/maps.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT, HAND_REACH } from '../src/pov/constants.js';
import { buildPreset } from '../src/presets.js';
import { EMITTERS, RAYS, sigmas } from '../src/rays.js';
import {
  buildNuclearReactor, NUCLEAR_REACTOR_SIZE as size, NUCLEAR_REACTOR_SPAWN as spawn, nuclearReactorManifest,
} from '../src/scenes/nuclearReactor.js';
import { contactAmbientQ, ctConduct, ctLife, ctNew, ctPhase, ctStep, ctWithLife } from '../src/v2/contact.js';
import { electricGrid, electricTick, gridCell, setGridCell } from '../src/v2/electric.js';

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const add = (a, b) => a.map((v, i) => v + b[i]);
const key = p => p.join(',');
const inBounds = p => p.every((v, i) => Number.isInteger(v) && v >= 0 && v < size[i]);
const index = ([x, y, z]) => x + size[0] * (y + size[1] * z);
function* region([x0, y0, z0, x1, y1, z1]) {
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) yield [x, y, z];
}
const ids = new Uint8Array(size.reduce((a, b) => a * b)), extras = new Map();
const set = (x, y, z, id, extra) => {
  const p = [x, y, z];
  assert(inBounds(p), `out of bounds: ${p}`);
  assert.equal(ELEMENTS[id]?.id, id, `not a grid material: ${id}`);
  ids[index(p)] = id;
  if (extra) extras.set(index(p), extra);
  else extras.delete(index(p));
};
const box = (x0, y0, z0, x1, y1, z1, id, extra) => {
  assert(inBounds([x0, y0, z0]) && inBounds([x1 - 1, y1 - 1, z1 - 1]));
  assert(x1 > x0 && y1 > y0 && z1 > z0);
  for (const p of region([x0, y0, z0, x1, y1, z1])) set(...p, id, extra);
};
const scene = buildNuclearReactor({ box, set });
const at = p => inBounds(p) ? ids[index(p)] : E.EMPTY;
const extraAt = p => extras.get(index(p)) ?? {};
const is = (p, id) => assert.equal(at(p), id, `material at ${p} (expected ${ELEMENTS[id].key})`);

function trace(from, to, clear) {
  const d = to.map((v, i) => v - from[i]), n = Math.ceil(Math.hypot(...d) * 4);
  const points = [];
  for (let t = 0; t < n; t++) {
    const p = from.map((v, i) => Math.floor(v + d[i] * t / n));
    if (!points.length || key(points.at(-1)) !== key(p)) points.push(p);
    assert(clear(at(p)), `obstructed ray at ${p}: ${ELEMENTS[at(p)].key}`);
  }
  return points;
}

// Sink terminals don't pass current. Gated buttons are not traversable unless
// pressed; a battery or a hot TSNS is the source, not an ordinary conductor.
function electricalPaths(source, pressed = null) {
  const found = new Set([key(source)]), queue = [source];
  for (let i = 0; i < queue.length; i++) for (const face of FACES) {
    const p = add(queue[i], face), k = key(p);
    if (found.has(k) || !takesSpark(at(p), k === pressed ? BUTTON_HOLD : 0) || !conductsInto(at(queue[i]), at(p))) continue;
    found.add(k); queue.push(p);
  }
  return found;
}

const bankNames = Object.keys(scene.banks);
const targets = Object.fromEntries(Object.entries(scene.banks).map(([name, cells]) => [name, new Set(cells.map(key))]));
function cloneReach(path, silicon, bank) {
  const found = new Set(), queue = [];
  for (const p of scene.banks[bank]) {
    if (!FACES.some(d => {
      const q = add(p, d);
      return at(q) === silicon && path.has(key(q));
    })) continue;
    found.add(key(p)); queue.push(p);
  }
  for (const p of queue) for (const face of FACES) {
    const q = add(p, face), k = key(q);
    if (targets[bank].has(k) && !found.has(k)) { found.add(k); queue.push(q); }
  }
  return found;
}

// Reuse the actual native electricity twin on a cropped copy of the set.
// The crop contains the full circuits, floor and anything touching a wire.
function electricalFixture() {
  const min = [104, 22, 46], max = [153, 65, 104], dims = max.map((n, i) => n - min[i]);
  const g = electricGrid(...dims), relative = p => p.map((n, i) => n - min[i]);
  const read = p => gridCell(g, ...relative(p));
  const put = (p, c) => setGridCell(g, ...relative(p), c);
  const awake = new Set(), bx = Math.ceil(dims[0] / 4), by = Math.ceil(dims[1] / 4);
  const mat = (id, temp = ELEMENTS[id].temp, life = ELEMENTS[id].life, ctype = 0) => {
    const out = ctWithLife(ctNew(id, contactAmbientQ(temp), 65536), life);
    out.ctype = ctype;
    return out;
  };
  for (const p of region([...min, ...max])) {
    const id = at(p), e = extraAt(p);
    if (id) put(p, mat(id, e.temp, e.life, e.ctype));
  }
  const active = [...Object.values(scene.controls).flatMap(({ button, supply }) => [...electricalPaths(supply, key(button))]),
    ...scene.alarms.flatMap(({ sensor }) => [...electricalPaths(sensor)]), ...Object.values(scene.banks).flat().map(key)];
  for (const p of new Set(active)) {
    const [x, y, z] = relative(p.split(',').map(Number)).map(n => n >> 2);
    awake.add(x + bx * (y + by * z));
  }
  let tick = 0;
  const step = n => { for (let i = 0; i < n; i++) electricTick(g, tick++, { awake }); };
  const press = control => {
    const p = scene.controls[control].button;
    put(p, ctWithLife(read(p), BUTTON_HOLD));
    step(control === 'scram' ? 36 : 25);
    assert.equal(ctLife(read(p)), 0, 'button must be momentary');
  };
  return { read, put, mat, step, press };
}

test('registered fixed-size map stamps the preset state and starts at its authored viewpoint', () => {
  const map = mapByKey('nuclearReactor');
  assert.deepEqual(map.dims, size);
  assert.equal(map.size, 'valley');
  assert.equal(mapOf({ size: map.size, preset: 'nuclearReactor' }), map);
  assert(mapsFor('sandbox').includes(map));
  assert.equal(map.startInPov, true);
  assert.equal(map.spawnYaw, 0); // -Z, toward the clear side of the plant
  const source = p => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  assert.match(source('app.js'), /nuclearReactor: 'valley'/);
  assert.match(source('app.js'), /\['nuclearReactor', nuclearReactorManifest\]/);
  assert.match(source('wire/pov.js'), /nuclearReactor: NUCLEAR_REACTOR_SPAWN/);
  assert.throws(() => buildPreset(map.preset, { g: { nx: 128, ny: 128, nz: 128 } }), /requires a 256×96×128 grid/);
  const g = Object.fromEntries(['nx', 'ny', 'nz'].map((name, i) => [name, size[i]]));
  const A = new Float32Array(ids.length * 4), B = {};
  const result = buildPreset(map.preset, {
    g, blankState: () => [A, B], cellTexel: (...p) => index(p),
    load(a, b) { assert.equal(a, A); assert.equal(b, B); },
  });
  assert.deepEqual(result, scene);
  assert.deepEqual(nuclearReactorManifest(), scene);
  for (const { sensor, temp } of scene.alarms) assert.equal(A[4 * index(sensor) + 1], temp);
  for (const p of scene.banks.water) assert.equal(Math.floor(A[4 * index(p) + 3]), E.WATER);
});

test('shell, fuel cassettes, coolant channels, steam stack, drainage and melt-through pit are physical', () => {
  for (const [p, id] of [
    [[132, 76, 77], E.METAL], [[64, 30, 60], E.TUNGSTEN], [[128, 43, 94], E.GLASS],
    [[128, 43, 80], E.GLASS], [[150, 36, 67], E.TUNGSTEN], [[128, 43, 79], E.EMPTY],
    [[119, 22, 49], E.VOID], [[119, 23, 50], E.EMPTY], [[119, 23, 51], E.WATER],
    [[111, 26, 61], E.VOID], [[111, 27, 61], E.EMPTY],
  ]) is(p, id);
  assert.equal(scene.rods.length, 12);
  for (const { foot, fuel } of scene.rods) {
    for (const p of region(foot)) is(p, E.GLASS);
    for (const slice of fuel) for (const p of region(slice)) is(p, E.URANIUM);
  }
  for (const x of [122, 129, 137, 145]) {
    is([x, 26, 69], E.WATER);
    for (let y = 29; y < 58; y++) is([x, y, 69], E.EMPTY);
  }
  for (const p of region(scene.exhaust)) is(p, E.VOID);
  for (let y = scene.exhaust[1] - 1; y >= 60; y--) is([128, y, 57], E.EMPTY);
  assert(ELEMENTS[E.LAVA].temp > ELEMENTS[E.GOLD].melt, 'heater can melt the floor fuse');
  for (const p of region(scene.plug)) is(p, E.GOLD);
  for (let y = scene.plug[1] - 1; y > scene.pit[1] + 1; y--) is([134, y, 62], E.EMPTY);
  is([134, 5, 62], E.CERAMIC);
  for (let y = scene.plug[1] + 1; y < 60; y++) {
    assert([E.EMPTY, E.WATER].includes(at([134, y, 62])), 'heater has an open drop to the fuse');
  }
});

test('walkable balcony spawn, unobstructed forward view, reachable button faces and valid labels', () => {
  const [x, y, z] = spawn;
  const eye = [x, y + EYE_HEIGHT, z];
  const r = BODY_WIDTH / 2;
  const footprint = [Math.floor(x - r), y, Math.floor(z - r), Math.ceil(x + r), Math.ceil(y + BODY_HEIGHT), Math.ceil(z + r)];
  for (const p of region(footprint)) is(p, E.EMPTY);
  for (const p of region([footprint[0], y - 1, footprint[2], footprint[3], y, footprint[5]])) is(p, E.CERAMIC);
  const view = trace(eye, [x, eye[1], 64.5], id => id === E.EMPTY || ELEMENTS[id].render === R.GLASS);
  for (const pane of [80, 94]) assert(view.some(p => p[2] === pane && at(p) === E.GLASS));
  // A slightly off-axis ray reaches a visible fuel cassette, not just the hall.
  trace(eye, [126.5, 43, 76.5], id => id === E.EMPTY || id === E.GLASS || id === E.URANIUM);
  for (const { button } of Object.values(scene.controls)) {
    const localEye = [button[0] + 0.5, eye[1], z];
    for (const p of region([Math.floor(Math.min(x, localEye[0])), y, 105, Math.ceil(Math.max(x, localEye[0])), Math.ceil(y + BODY_HEIGHT), 108])) is(p, E.EMPTY);
    const front = add(button, [0.5, 0.5, 1.01]);
    assert(Math.hypot(...front.map((n, i) => n - localEye[i])) < HAND_REACH);
    trace(localEye, front, id => id === E.EMPTY);
  }
  assert.deepEqual(decodeScenePlaques(scene.plaques), scene.plaques);
  const texts = nearbyPlaques(scene.plaques, eye).map(p => p.text).sort();
  for (const match of [/1\. COOLANT ON/, /2\. IGNITE/, /3\. COOLANT OFF/, /4\. SCRAM/, /AUX HEATER/, /RELOAD MAP/]) {
    assert(texts.some(s => match.test(s)), `missing plaque ${match}`);
  }
  for (const { cell, normal } of scene.plaques) {
    assert.notEqual(at(cell), E.EMPTY, `floating plaque at ${cell}`);
    is(add(cell, normal), E.EMPTY);
  }
});

test('every button and sensor has an isolated, continuous circuit to its own terminals', () => {
  const wiring = {
    ignite: [['starter'], []], coolantOn: [['water'], []], coolantOff: [[], ['water']],
    aux: [['heater'], []], scram: [['scram'], ['starter', 'heater']],
  };
  for (const [name, { button, supply }] of Object.entries(scene.controls)) {
    is(button, E.BUTTON); is(supply, E.BATTERY);
    assert.deepEqual([...electricalPaths(supply)], [key(supply)], `${name} must not be wired around the contact`);
    const path = electricalPaths(supply, key(button));
    for (const { button: other, supply: otherSupply } of Object.values(scene.controls)) {
      assert.equal(path.has(key(other)), key(other) === key(button));
      if (key(otherSupply) !== key(supply)) assert(FACES.every(d => !path.has(key(add(otherSupply, d)))));
    }
    for (const bank of bankNames) for (const [i, silicon] of [E.PSCN, E.NSCN].entries()) {
      const reach = cloneReach(path, silicon, bank);
      assert.deepEqual(reach, wiring[name][i].includes(bank) ? targets[bank] : new Set(), `${name}/${bank}/${ELEMENTS[silicon].key}`);
    }
    for (const alarm of scene.alarms) assert(!path.has(key(alarm.lamp)), `${name} backfeeds an alarm`);
  }
  for (const { sensor, lamp, sample, temp } of scene.alarms) {
    is(sensor, E.TSNS); is(lamp, E.LAMP);
    assert.equal(extraAt(sensor).temp, temp);
    assert(FACES.some(d => key(add(sensor, d)) === key(sample)));
    assert(tsnsSenses(at(sample)));
    const path = electricalPaths(sensor);
    assert(path.has(key(lamp)), `unwired ${temp} C alarm`);
    for (const other of scene.alarms) if (other.temp !== temp) assert(!path.has(key(other.lamp)));
    for (const bank of bankNames) for (const silicon of [E.PSCN, E.NSCN]) assert.equal(cloneReach(path, silicon, bank).size, 0);
  }
  assert.deepEqual(scene.alarms.map(a => a.temp), [150, 600]);
});

test('native electric CPU twin latches coolant and starter, cuts coolant, and SCRAM stops heat and opens the flood', () => {
  const { read, step, press } = electricalFixture();
  const bankLife = (name, on) => {
    for (const p of scene.banks[name]) assert.equal(ctLife(read(p)), on ? ELEC.SWITCH_ON : 0, `${name} at ${p}`);
  };
  step(5);
  for (const name of bankNames) bankLife(name, false);
  press('coolantOn'); bankLife('water', true);
  press('ignite'); bankLife('starter', true);
  press('coolantOff'); bankLife('water', false); bankLife('starter', true);
  press('aux'); bankLife('heater', true);
  press('scram'); bankLife('starter', false); bankLife('heater', false); bankLife('scram', true);
  step(20);
  bankLife('starter', false); bankLife('heater', false); bankLife('scram', true); bankLife('water', false);
});

test('native alarm twin senses its own setpoint and drives only its dashboard lamp', () => {
  const { read, put, mat, step } = electricalFixture();
  for (const alarm of scene.alarms) {
    const { sensor, sample, lamp, temp } = alarm;
    put(sample, mat(at(sample), temp - 1));
    step(30);
    assert.equal(ctLife(read(sensor)), 0);
    assert.equal(sparkLevel(read(lamp).spark), 0);
    put(sample, mat(at(sample), temp + 1));
    step(30);
    assert.equal(ctLife(read(sensor)), ELEC.TSNS_FIRE);
    assert(sparkLevel(read(lamp).spark) > 0);
    for (const other of scene.alarms) if (other !== alarm) assert.equal(sparkLevel(read(other.lamp).spark), 0);
    put(sample, mat(at(sample)));
    step(30);
    assert.equal(sparkLevel(read(lamp).spark), 0);
  }
});

test('clone outputs are native materials; the starter produces neutron events, not grid rays', () => {
  assert(itemByKey('NEUTRON').id < 0 && !('NEUTRON' in E));
  const mk = id => ctNew(id, contactAmbientQ(ELEMENTS[id].temp), 65536);
  const air = mk(E.EMPTY);
  const products = { starter: E.PLUTONIUM, water: E.WATER, heater: E.LAVA, scram: E.LIQUID_NITROGEN };
  for (const [name, id] of Object.entries(products)) {
    for (const p of scene.banks[name]) {
      is(p, E.PCLN); is(add(p, [0, -1, 0]), E.EMPTY);
      assert.equal(extraAt(p).ctype, id);
    }
    const c = { ...ctWithLife(mk(E.PCLN), ELEC.SWITCH_ON), ctype: id };
    let spawned = false;
    for (let seed = 0; seed < 100 && !spawned; seed++) spawned = ctStep(air, [c, air, air], seed).id === id;
    assert(spawned, `native PCLN cannot generate ${name}`);
    assert.equal(ctStep(air, [ctWithLife(c, 0), air, air], 0).id, E.EMPTY);
  }
  assert(EMITTERS.PLUTONIUM > 0 && !EMITTERS.URANIUM);
  const plutonium = mk(E.PLUTONIUM);
  let event = false;
  for (let seed = 0; seed < 200_000 && !event; seed++) event = !!(ctStep(plutonium, [air, air, air], seed).request & 4);
  assert(event, 'a native piece of starter plutonium requests a neutron');
  assert(sigmas('URANIUM')[2] > 0 && RAYS.FISSION_HEAT > 0);
  const steam = mk(E.STEAM);
  assert.equal(ctStep(steam, [mk(E.VOID), air, air], 0).id, E.EMPTY);
});

test('local native heat transfer melts the plug under replenished lava and flood removes heat', () => {
  const mk = (id, temp = ELEMENTS[id].temp) => ctNew(id, contactAmbientQ(temp), 65536);
  const plug = at([134, 22, 62]);
  let fuse = mk(plug);
  const heater = mk(extraAt(scene.banks.heater[0]).ctype);
  for (let i = 0; i < 250 && fuse.id === plug; i++) {
    fuse = ctPhase(ctConduct(fuse, heater, 1).a, 0, 0.5);
  }
  assert.equal(fuse.id, E.LAVA);
  assert.equal(fuse.ctype, plug);
  const cold = mk(extraAt(scene.banks.scram[0]).ctype);
  const warm = mk(E.CERAMIC, 700);
  const cooled = ctConduct(warm, cold, 1).a;
  assert(cooled.tq < warm.tq);
});
