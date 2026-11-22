import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { E, ELEMENTS } from '../src/elements.js';
import { BUTTON_HOLD, CONDUCTS, ELEC, LAMP_DC } from '../src/electricity.js';
import { decodeScenePlaques, nearbyPlaques } from '../src/lab/scenePlaques.js';
import { mapByKey } from '../src/maps.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT, HAND_REACH } from '../src/pov/constants.js';
import { buildPreset } from '../src/presets.js';
import { buildVolcanoTown, VOLCANO_TOWN_SIZE, VOLCANO_TOWN_SPAWN, volcanoTownManifest } from '../src/scenes/volcanoTown.js';
import { ctConduct, ctElecApply, ctElecStep, ctLife, ctLive, ctNew, ctPhase, ctRow, ctStep, ctWithLife, packContact } from '../src/v2/contact.js';
import { chargeBatchDamage, chargeEnergy } from '../src/v2/dynamics-reference.js';

const [nx, ny, nz] = VOLCANO_TOWN_SIZE;
const at = ([x, y, z]) => (y * nz + z) * nx + x;
const inside = p => p.every((v, i) => Number.isInteger(v) && v >= 0 && v < VOLCANO_TOWN_SIZE[i]);
const coords = i => [i % nx, Math.floor(i / (nx * nz)), Math.floor(i / nx) % nz];
const add = (a, b) => a.map((v, i) => v + b[i]);
const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const ids = new Uint8Array(nx * ny * nz), extras = new Map();
const get = p => inside(p) ? ids[at(p)] : -1;
const extra = p => extras.get(at(p)) ?? {};
function put(p, id, data) {
  const i = at(p);
  ids[i] = id;
  if (data) extras.set(i, data); else if (extras.size) extras.delete(i);
}
const built = buildVolcanoTown({
  set(x, y, z, id, data) {
    assert(inside([x, y, z]) && ELEMENTS[id], `invalid set ${[x, y, z]} / ${id}`);
    put([x, y, z], id, data);
  },
  box(x, y, z, x1, y1, z1, id, data) {
    assert(inside([x, y, z]) && inside([x1 - 1, y1 - 1, z1 - 1]) && ELEMENTS[id], `invalid box ${[x, y, z, x1, y1, z1]} / ${id}`);
    assert(x < x1 && y < y1 && z < z1, 'inverted box');
    for (let yy = y; yy < y1; yy++) for (let zz = z; zz < z1; zz++) for (let xx = x; xx < x1; xx++) put([xx, yy, zz], id, data);
  },
});
const [erupt, dam, stop] = built.plaques.slice(0, 3).map(r => r.cell);
const counts = new Uint32Array(ELEMENTS.length);
const electrics = [], charges = [], reservoir = [], wet = p => get(p) === E.WATER;
for (let i = 0; i < ids.length; i++) {
  const id = ids[i]; counts[id]++;
  if ((CONDUCTS[id] && id !== E.WATER) || id === E.PCLN || id === E.BATTERY) electrics.push(i);
  if (id === E.C4 || id === E.TNT) charges.push(coords(i));
  if (id === E.WATER && coords(i)[0] > 150 && coords(i)[2] < 56) reservoir.push(i);
}

// Traverse only volume below the maximum backed-up water level. Explicitly
// simulate an opened gate to prove the test could detect a leak.
function reachable(seeds, pass, directions = faces, target = -1) {
  const seen = new Uint8Array(ids.length), queue = [...seeds];
  for (const i of queue) seen[i] = 1;
  for (let q = 0; q < queue.length; q++) {
    const p = coords(queue[q]);
    for (const f of directions) {
      const n = add(p, f);
      if (!inside(n) || !pass(n)) continue;
      const i = at(n);
      if (seen[i]) continue;
      seen[i] = 1;
      if (i === target) return seen;
      queue.push(i);
    }
  }
  return seen;
}

test('bounds, snow-capped stratovolcano and distinct molten chamber and crest', () => {
  assert.deepEqual(VOLCANO_TOWN_SIZE, [256, 96, 128]);
  assert(counts[E.SNOW] > 350 && counts[E.BASALT] > 500 && counts[E.WOOD] > 250);
  assert.equal(get([61, 66, 34]), E.ROCK);
  assert.equal(get([61, 40, 40]), E.EMPTY);
  assert.equal(get([61, 20, 40]), E.LAVA);
  for (let z = 46; z < 90; z++) assert.equal(get([61, 27, z]), E.EMPTY, 'open gallery adit');
  assert.equal(get([67, 75, 44]), E.ROCK);
  assert.equal(get([67, 76, 44]), E.SAND);
  for (const p of [[61, 20, 40], [66, 66, 45], [39, 24, 72], [140, 6, 96]]) {
    assert.equal(get(p), E.LAVA);
    assert.equal(extra(p).ctype, E.BASALT);
    assert(extra(p).temp > ELEMENTS[E.BASALT].melt);
  }
  assert.equal(get([39, 39, 72]), E.GLASS);
  assert.equal(get([39, 40, 72]), E.WATER);
  assert.equal(get([39, 38, 72]), E.EMPTY);
  assert.equal(get([39, 26, 72]), E.EMPTY);
  assert.equal(get([33, 44, 72]), E.EMPTY);
});

test('lake is sealed below the waterline; breach has a downhill route to the confluence', () => {
  assert(reservoir.length > 30_000, `reservoir only holds ${reservoir.length} water cells`);
  assert.equal(get([199, 33, 55]), E.WATER);
  assert.equal(get([199, 33, 56]), E.PLANKS);
  assert.equal(get([199, 33, 57]), E.EMPTY);
  const pass = p => p[1] < 42 && [E.EMPTY, E.WATER].includes(get(p));
  const contained = reachable(reservoir, pass);
  assert(!contained[at([199, 33, 57])], 'water behind the sluices cannot reach their dry side');
  for (let i = 0; i < contained.length; i++) if (contained[i]) {
    const [x, y, z] = coords(i);
    assert(x > 151 && x < 240 && y >= 23 && z > 3 && z < 59, `reservoir leaks to ${[x, y, z]}`);
  }
  const confluence = at([151, 8, 102]);
  const opened = p => p[0] >= 139 && p[0] < 215 && p[2] >= 55 && p[2] <= 103 &&
    (pass(p) || (p[2] === 56 && p[0] >= 195 && p[0] < 204 && get(p) === E.PLANKS));
  const downhill = faces.filter(f => f[1] <= 0);
  assert(reachable([at([201, 28, 55])], opened, downhill, confluence)[confluence], 'open sluice must drain toward town');
  const run = ([x, y, z]) => x >= 61 && x < 156 && z >= 50 && z <= 103 && get([x, y, z]) === E.EMPTY;
  assert(reachable([at([67, 68, 50])], run, downhill, confluence)[confluence], 'open vent must drain toward the same reach');
});

test('village has hollow combustible houses, glazing, a crossing and lit streetlamps', () => {
  assert.equal(get([120, 15, 92]), E.WOOD);
  assert.equal(get([121, 13, 92]), E.PLANKS);
  assert.equal(get([126, 13, 96]), E.EMPTY);
  assert.equal(get([126, 14, 102]), E.PLANKS);
  assert.equal(get([124, 12, 107]), E.BRICK);
  assert.equal(get([125, 14, 107]), E.GLASS);
  assert.equal(get([129, 14, 112]), E.EMPTY);
  for (let x = 139; x < 166; x++) assert([E.PLANKS, E.WOOD].includes(get([x, 10, 105])));
  assert.equal(get([151, 6, 113]), E.WOOD);
  assert.equal(get([151, 10, 113]), E.PLANKS);
  assert.equal(get([160, 17, 109]), E.BATTERY);
  assert.equal(get([160, 17, 110]), E.LAMP);
  assert.equal(extra([160, 17, 110]).ctype, LAMP_DC);
});

const q = t => Math.round((t + 273.25) * 4);
const air = ctNew(E.EMPTY, q(20), 65536);
const cell = p => {
  const id = get(p), e = ELEMENTS[id], data = extra(p);
  const c = ctWithLife(ctNew(id, q(data.temp ?? e.temp), 65536), data.life ?? e.life);
  if (CONDUCTS[id]) c.spark = data.ctype ?? 0;
  else c.ctype = data.ctype ?? c.ctype;
  return c;
};
const byIndex = new Map(electrics.map((i, n) => [i, n]));
const active = electrics.map(i => cell(coords(i)));
const neighbors = electrics.map(i => faces.map(f => {
  const p = add(coords(i), f);
  return inside(p) ? byIndex.get(at(p)) : undefined;
}));
const volts = (state, p) => state[byIndex.get(at(p))];

function pulse(state, button, steps = 320) {
  if (button) {
    state = [...state];
    const i = byIndex.get(at(button));
    state[i] = ctWithLife(state[i], BUTTON_HOLD);
  }
  const sparked = new Set();
  for (let step = 0; step < steps; step++) {
    state = state.map((c, i) => {
      const word = ctElecStep(c, neighbors[i].map(n => state[n] ?? air), 0.5);
      const next = word ? ctElecApply(c, word, i) : c;
      if (ctLive(next)) sparked.add(electrics[i]);
      return next;
    });
  }
  return { state, sparked };
}
const selectors = electrics.map(coords).filter(p => [E.PSCN, E.NSCN].includes(get(p)));
const clones = electrics.map(coords).filter(p => get(p) === E.PCLN);
const atDam = ([x]) => x > 180;
const assertPower = (state, shouldBeOn) => {
  for (const p of clones) assert.equal(ctLife(volts(state, p)), shouldBeOn(p) ? ELEC.SWITCH_ON : 0, `PCLN at ${p}`);
};
const assertSelectors = (sparked, shouldBeLive) => {
  for (const p of selectors) assert.equal(sparked.has(at(p)), shouldBeLive(p), `selector at ${p}`);
};

test('real six-face electricity gates and latches: independent eruption, breach and stop circuits', () => {
  assert.equal(counts[E.BUTTON], 3);
  assert.equal(counts[E.PSCN], 5);
  assert.equal(counts[E.NSCN], 5);
  for (const p of [erupt, dam, stop]) {
    assert.equal(get(p), E.BUTTON);
    assert.equal(get(add(p, [0, 0, -1])), E.BATTERY);
  }
  for (const p of electrics.map(coords)) {
    assert(!faces.some(f => wet(add(p, f))), `live parts touch water at ${p}`);
  }
  const idle = pulse(active, null, 30);
  assertPower(idle.state, () => false);
  assertSelectors(idle.sparked, () => false);
  const on = pulse(idle.state, erupt);
  assertPower(on.state, p => !atDam(p));
  assertSelectors(on.sparked, p => get(p) === E.PSCN && !atDam(p));
  assert.equal(ctLife(volts(on.state, erupt)), 0, 'clone must stay latched after momentary press');
  const both = pulse(on.state, dam, 260);
  assertPower(both.state, () => true);
  assertSelectors(both.sparked, p => get(p) === E.PSCN && atDam(p));
  const settled = pulse(both.state, null, 150);
  assertPower(settled.state, p => !atDam(p));
  assertSelectors(settled.sparked, p => get(p) === E.NSCN && atDam(p));
  const off = pulse(settled.state, stop);
  assertPower(off.state, () => false);
  assertSelectors(off.sparked, p => get(p) === E.NSCN && !atDam(p));
  assertPower(pulse(off.state, erupt).state, p => !atDam(p));
  assertPower(pulse(idle.state, stop).state, () => false);
});

function emitted(state, atAir) {
  assert.equal(get(atAir), E.EMPTY, `air gap at ${atAir}`);
  const around = faces.map(f => add(atAir, f)).filter(p => get(p) === E.PCLN).map(p => volts(state, p));
  assert(around.length > 0, `no exposed outlet at ${atAir}`);
  for (let seed = 0; seed < 64; seed++) {
    const spawned = ctStep(air, [...around, air, air].slice(0, 3), seed);
    if (spawned.id === E.LAVA) return spawned;
  }
  assert.fail(`no hot lava yielded from ${atAir}`);
}

function localBlast(origin, dims, detonated) {
  const cells = new Map();
  for (let x = 0; x < dims[0]; x++) for (let y = 0; y < dims[1]; y++) for (let z = 0; z < dims[2]; z++) {
    const p = [x, y, z], id = get(add(origin, p));
    if (id !== E.EMPTY) cells.set(p.join(','), id);
  }
  return chargeBatchDamage({ dims, cells, charges: detonated.map(p => ({
    p: p.map((v, i) => v - origin[i]), id: get(p), energy: chargeEnergy(packContact(cell(p))),
  })) });
}

test('emitter heat requests native blasts; charge fronts break the vent lip and all three sluices', () => {
  const erupting = pulse(active, erupt).state;
  const breached = pulse(active, dam, 260).state;
  const seeds = [];
  for (const p of charges) {
    assert(!faces.some(f => {
      const n = add(p, f);
      return get(n) === E.LAVA && extra(n).temp >= ELEMENTS[get(p)].ignite;
    }), `charge at ${p} is hot before a button press`);
    const gap = add(p, [0, 0, atDam(p) ? 1 : -1]);
    if (get(gap) !== E.EMPTY || !faces.some(f => get(add(gap, f)) === E.PCLN)) continue;
    const pilot = emitted(atDam(p) ? breached : erupting, gap);
    assert(pilot.tq > ctRow(get(p)).igniteQ);
    assert(ctStep(cell(p), [pilot, air, air], 0).request & 1, `charge at ${p} does not request a blast`);
    seeds.push(p);
  }
  for (const x of [64, 68, 72]) assert(seeds.some(([xx, , z]) => xx === x && z === 48));
  for (const x of [188, 197, 208]) for (const id of [E.C4, E.TNT]) assert(seeds.some(p => p[0] === x && get(p) === id));
  const vent = localBlast([60, 64, 40], [20, 16, 16], seeds.filter(p => !atDam(p)));
  assert(vent.get([8, 3, 9].join(','))?.break, 'summit sill survives the charge front');
  const sluices = localBlast([184, 20, 52], [32, 12, 12], seeds.filter(atDam));
  for (const x of [189, 199, 209]) assert(sluices.get([x - 184, 5, 4].join(','))?.break, `sluice near ${x} survives the charge front`);
  for (const p of [[100, 24, 78], [112, 14, 88], [136, 10, 95]]) emitted(erupting, p);
});

test('native thermal products are steam pressure and basalt, not a scripted conversion', () => {
  // A drop from the cistern surrounded by its authored hot pool. Run the
  // actual face heat and phase rules on this static contact fixture.
  let drop = cell([39, 40, 72]);
  let bath = Array.from({ length: 5 }, () => cell([39, 24, 72]));
  let madeSteam = false, madeBasalt = false;
  for (let t = 0; t < 500 && !(madeSteam && madeBasalt); t++) {
    bath = bath.map(lava => {
      const { a, b } = ctConduct(drop, lava, 0);
      drop = ctPhase(a, 1, 0);
      const cooled = ctPhase(b, 1, 0);
      if (drop.id === E.STEAM) {
        madeSteam ||= (drop.request & 2) !== 0;
        drop = cell([39, 40, 72]); // the vent releases steam; more cold water falls in
      }
      madeBasalt ||= cooled.id === E.BASALT;
      return cooled;
    });
  }
  assert(madeSteam, 'boiling requests a gas pressure puff');
  assert(madeBasalt, 'quenching freezes the authored lava back to basalt');
});

test('walkable overlook, short unobstructed use rays and attached plaques', () => {
  const spawn = VOLCANO_TOWN_SPAWN;
  const eye = add(spawn, [0, EYE_HEIGHT, 0]);
  for (const dx of [-BODY_WIDTH / 2, BODY_WIDTH / 2]) for (const dz of [-BODY_WIDTH / 2, BODY_WIDTH / 2]) {
    const [x, y, z] = add(spawn, [dx, 0, dz]).map(Math.floor);
    assert.equal(get([x, y - 1, z]), E.ROCK);
    for (let dy = 0; dy < BODY_HEIGHT; dy++) assert.equal(get([x, y + dy, z]), E.EMPTY);
  }
  for (let x = 108; x < 123; x++) {
    const y = Math.max(10, 27 - (x - 107));
    assert.equal(get([x, y - 1, 114]), E.ROCK);
    assert.equal(get([x, y, 114]), E.EMPTY);
  }
  const ray = (p, sameFeature = () => false) => {
    const center = add(p, [0.5, 0.5, 0.5]);
    const dir = center.map((v, i) => v - eye[i]), distance = Math.hypot(...dir);
    for (let d = 0; d < distance; d += 0.25) {
      const v = eye.map((n, i) => Math.floor(n + dir[i] * d / distance));
      if (at(v) === at(p) || sameFeature(v)) break;
      assert.equal(get(v), E.EMPTY, `sightline to ${p} obstructed by ${v}`);
    }
    return distance;
  };
  for (const p of [erupt, dam, stop]) assert(ray(p) <= HAND_REACH);
  ray([69, 73, 49]);
  ray([199, 40, 64], ([x, y, z]) => x >= 185 && x < 214 && y >= 39 && z === 64 && get([x, y, z]) === E.BRICK);
  ray([130, 16, 120], ([x, y, z]) => x >= 122 && x <= 136 && z >= 106 && z <= 121 &&
    [E.PLANKS, E.BRICK].includes(get([x, y, z])));
  assert.deepEqual(decodeScenePlaques(built.plaques), volcanoTownManifest().plaques);
  assert.equal(nearbyPlaques(built.plaques, eye).filter(r => r.normal[2] === 1 && r.cell[2] === 109).length, 4);
  for (const { cell, normal, text } of built.plaques) {
    assert.notEqual(get(cell), E.EMPTY, `${text} lacks a surface`);
    assert.equal(get(add(cell, normal)), E.EMPTY, `${text} faces a solid cell`);
  }
});

test('map registers as a fixed valley sandbox and loads authored metadata through buildPreset', () => {
  const map = mapByKey('volcanoTown');
  assert.equal(map.name, 'Volcano & Dam');
  assert.equal(map.size, 'valley');
  assert.equal(map.preset, 'volcanoTown');
  assert.deepEqual(map.dims, VOLCANO_TOWN_SIZE);
  assert(map.startInPov);
  assert.throws(() => buildPreset(map.preset, { g: { nx: 128, ny, nz } }), /256×96×128/);
  const samples = [erupt, dam, stop, [61, 20, 40], [199, 33, 55], [63, 70, 46]];
  // Sample the production writer without uploading or allocating GPU state.
  const samplesByTexel = new Map(samples.map((p, i) => [at(p), i]));
  const A = new Float32Array(samples.length * 4), B = new Float32Array();
  let loaded = false;
  const layout = buildPreset(map.preset, {
    g: { nx, ny, nz }, blankState: () => [A, B], cellTexel: (...p) => samplesByTexel.get(at(p)) ?? -1,
    load(a, b) { assert.equal(a, A); assert.equal(b, B); loaded = true; },
  });
  assert(loaded);
  assert.equal(layout, volcanoTownManifest());
  for (const [i, p] of samples.entries()) assert.equal(A[i * 4], get(p));
  assert.equal(Math.floor(A[3 * 4 + 3]), E.BASALT);
  assert.equal(Math.floor(A[5 * 4 + 3]), E.LAVA);
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source('../src/app.js'), /FIXED_PRESET_GRID\s*=\s*\{[^}]*volcanoTown: 'valley'/);
  assert.match(source('../src/app.js'), /PRESET_PLAQUES\s*=\s*(?:new Map\(\[[\s\S]*?\['volcanoTown',\s*volcanoTownManifest\]|\{[^}]*volcanoTown:\s*volcanoTownManifest)/);
  assert.match(source('../src/wire/pov.js'), /PRESET_SPAWNS\s*=\s*\{[^}]*volcanoTown: VOLCANO_TOWN_SPAWN/);
});
