import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, K } from '../src/elements.js';
import { Appearance, appearanceOf } from '../src/appearance.js';
import { BUTTON_HOLD, ELEC, LAMP_DC, conductsInto, isLive, takesSpark } from '../src/electricity.js';
import { decodeScenePlaques } from '../src/lab/scenePlaques.js';
import { mapByKey, mapOf } from '../src/maps.js';
import { PHYS } from '../src/physics.js';
import { EYE_HEIGHT, HAND_REACH } from '../src/pov/constants.js';
import { buildPreset } from '../src/presets.js';
import { buildDestroyableCity, destroyableCityManifest, DESTROYABLE_CITY_SIZE, DESTROYABLE_CITY_SPAWN } from '../src/scenes/destroyableCity.js';
import { World } from '../src/ui/tiles/engine.js';
import { ctElecApply, ctElecStep, ctLife, ctNew, ctStep, ctWithLife } from '../src/v2/contact.js';

const [nx, ny, nz] = DESTROYABLE_CITY_SIZE;
const ids = new Uint8Array(nx * ny * nz), ctypes = new Uint16Array(ids.length);
const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const plus = (a, b) => a.map((n, i) => n + b[i]);
const key = p => p.join(',');
const neighbors = p => faces.map(d => plus(p, d));
const inside = (...p) => p.every((n, i) => Number.isInteger(n) && n >= 0 && n < DESTROYABLE_CITY_SIZE[i]);
const index = (x, y, z) => (y * nz + z) * nx + x;
const at = (...p) => inside(...p) ? ids[index(...p)] : E.WALL;
const solid = (...p) => ELEMENTS[at(...p)].kind === K.SOLID;
const ctypeAt = p => ctypes[index(...p)];
function set(x, y, z, id, extra) {
  assert(inside(x, y, z) && ELEMENTS[id], `invalid voxel ${[x, y, z, id]}`);
  ids[index(x, y, z)] = id;
  ctypes[index(x, y, z)] = extra?.ctype ?? 0;
}
function box(x0, y0, z0, x1, y1, z1, id) {
  assert(inside(x0, y0, z0) && inside(x1 - 1, y1 - 1, z1 - 1), `out-of-bounds box ${[x0, y0, z0, x1, y1, z1]}`);
  assert(x0 < x1 && y0 < y1 && z0 < z1 && ELEMENTS[id]);
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
    ids.fill(id, index(x0, y, z), index(x1, y, z));
    ctypes.fill(0, index(x0, y, z), index(x1, y, z));
  }
}
const scene = buildDestroyableCity({ box, set });

test('valley menu registration and native preset upload', () => {
  const map = mapByKey('destroyableCity');
  assert.deepEqual(map.dims, DESTROYABLE_CITY_SIZE);
  assert.equal(map.size, 'valley');
  assert.equal(map.preset, 'destroyableCity');
  assert.equal(mapOf({ size: map.size, preset: map.preset }), map);
  assert(map.startInPov);
  assert.equal(map.spawnYaw, 0); // forward is -z at yaw zero
  assert.throws(() => buildPreset(map.preset, { g: { nx: 128, ny: 96, nz: 128 } }), /requires a 256×96×128 grid/);
  let uploaded = false;
  buildPreset(map.preset, {
    g: { nx, ny, nz }, cellTexel: index, blankState: () => [new Float32Array(ids.length * 4), null],
    load(A) {
      for (let i = 0; i < ids.length; i++) assert.equal(A[i * 4], ids[i]);
      for (const { pilot } of scene.circuits) assert.equal(Math.floor(A[4 * index(...pilot) + 3]), E.FIRE);
      for (const { lamp } of scene.lights) assert.equal(Math.floor(A[4 * index(...lamp) + 3]), LAMP_DC);
      assert.equal(appearanceOf(E.PLANKS, A[4 * index(26, 30, 18) + 3]), Appearance.PLANK_Y);
      uploaded = true;
    },
  });
  assert(uploaded);
});

test('city has structural materials, utility components, fuel and a full enclosed canal', () => {
  const counts = new Uint32Array(ELEMENTS.length);
  for (const id of ids) counts[id]++;
  for (const name of ['EMPTY', 'WALL', 'ROCK', 'BASALT', 'CERAMIC', 'BRICK', 'GLASS', 'PLANKS', 'WOOD', 'METAL', 'WATER',
    'OIL', 'PROPANE', 'GUNPOWDER', 'TNT', 'C4', 'FUSE', 'BATTERY', 'BUTTON', 'LAMP', 'INSULATOR', 'PSCN', 'PCLN']) {
    assert(counts[E[name]] > 0, name);
  }
  assert.equal(counts[E.BUTTON], 4);
  assert.equal(counts[E.FIRE], 0, 'nothing ignites before using a control');
  for (let y = 8; y < 22; y++) for (const [x, z] of [[183, 35], [208, 35], [190, 1], [190, 126]]) {
    assert(solid(x, y, z), `canal leaks at ${[x, y, z]}`);
  }
  assert.equal(at(188, 21, 36), E.WATER);
  assert.equal(at(195, 12, 72), E.BRICK, 'bridge pier');
  assert.equal(at(188, 24, 71), E.METAL, 'bridge stringer');
});

// Conservative 3×3 footprint, 6 cells clear for the 1.6×5.5 body, and a one-cell step.
function walkable(x, y, z) {
  if (!inside(x, y + 5, z)) return false;
  let support = false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    support ||= solid(x + dx, y - 1, z + dz);
    for (let dy = 0; dy < 6; dy++) if (at(x + dx, y + dy, z + dz) !== E.EMPTY) return false;
  }
  return support;
}
function flood(start) {
  const seen = new Uint8Array(ids.length), visited = new Uint8Array(ids.length), queue = [];
  const visit = (x, y, z) => {
    if (!inside(x, y, z)) return;
    const i = index(x, y, z);
    if (visited[i]) return;
    visited[i] = 1;
    if (walkable(x, y, z)) { seen[i] = 1; queue.push([x, y, z]); }
  };
  visit(...start);
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) visit(x + dx, y + dy, z + dz);
  }
  return seen;
}
function clearRay(from, to) {
  const delta = to.map((n, i) => n - from[i]), samples = Math.ceil(Math.hypot(...delta) * 8);
  for (let i = 0; i < samples; i++) {
    if (at(...from.map((n, a) => Math.floor(n + delta[a] * i / samples))) !== E.EMPTY) return false;
  }
  return true;
}

test('spawn sees the skyline; doorways, all apartment and tower floors, metro and bridge are walkable', () => {
  const [sx, sy, sz] = DESTROYABLE_CITY_SPAWN;
  assert(solid(Math.floor(sx), sy - 1, Math.floor(sz)));
  assert(walkable(...DESTROYABLE_CITY_SPAWN.map(Math.floor)));
  const eye = [sx, sy + EYE_HEIGHT, sz];
  assert(clearRay(eye, [sx, sy + EYE_HEIGHT, 48.5]), 'spawn line to the tower doorway');
  assert(clearRay(eye, [sx, 44.5, 49]), 'unobstructed tower facade');
  assert.equal(at(96, 44, 48), E.GLASS);
  const reached = flood(DESTROYABLE_CITY_SPAWN.map(Math.floor));
  for (const p of [[97, 30, 112], [41, 28, 42], [39, 15, 29], [41, 38, 34], [41, 48, 34], [137, 28, 42],
    ...[28, 39, 50, 61, 72, 83].map(y => [96, y, 27]), [16, 10, 65], [155, 10, 65], [227, 28, 72]]) {
    assert(reached[index(...p)], `unreachable room or landmark ${p}`);
  }
  for (const { button: [x, y, z] } of scene.circuits) {
    const stance = [x, sy, z + 4], center = [x + 0.5, y + 0.5, z + 0.5];
    const handEye = [x + 0.5, sy + EYE_HEIGHT, z + 4.5];
    assert(reached[index(...stance)], `unreachable button ${[x, y, z]}`);
    assert(Math.hypot(...center.map((n, i) => n - handEye[i])) <= HAND_REACH);
    // Aim at the front face (don't count the solid target cell as occlusion).
    assert(clearRay(handEye, [center[0], center[1], z + 1]), 'button is exposed on the deck');
  }
});

test('authored plaques are valid, supported and exposed; each utility lamp has local DC', () => {
  assert.deepEqual(destroyableCityManifest(), scene);
  assert.deepEqual(decodeScenePlaques(scene.plaques), scene.plaques);
  for (const { cell, normal } of scene.plaques) {
    assert(inside(...cell) && solid(...cell), `unanchored plaque ${cell}`);
    assert(inside(...plus(cell, normal)) && at(...plus(cell, normal)) === E.EMPTY, `blocked plaque ${cell}`);
  }
  assert(scene.plaques.some(p => p.text.startsWith('METRO /')));
  assert(scene.lights.some(({ lamp }) => lamp[1] < 28));
  assert(scene.lights.some(({ lamp }) => lamp[1] > 28));
  for (const { lamp, battery } of scene.lights) {
    assert.equal(at(...lamp), E.LAMP);
    assert.equal(at(...battery), E.BATTERY);
    assert(neighbors(lamp).some(p => key(p) === key(battery)));
    assert.equal(ctypeAt(lamp), LAMP_DC);
  }
});

function netOf({ button, supply, silicon, indicator }) {
  const nodes = [button], parents = new Map([[key(button), null]]);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    for (const q of neighbors(p)) {
      const id = at(...q);
      if (id === E.BATTERY) assert(key(p) === key(button) && key(q) === key(supply), `energized bypass at ${q}`);
      if (parents.has(key(q)) || !takesSpark(id, BUTTON_HOLD) || !conductsInto(at(...p), id)) continue;
      parents.set(key(q), p);
      nodes.push(q);
    }
  }
  const path = [];
  assert(parents.has(key(silicon)), 'disconnected trigger');
  for (let p = silicon; p; p = parents.get(key(p))) path.push(p);
  path.reverse();
  assert.equal(nodes.length, path.length + 1, 'short or branch outside the firing circuit');
  assert(parents.has(key(indicator)));
  assert.equal(at(...button), E.BUTTON);
  assert.equal(at(...supply), E.BATTERY);
  assert.equal(at(...indicator), E.LAMP);
  assert.equal(at(...silicon), E.PSCN);
  assert(path.slice(1, -1).every(p => at(...p) === E.METAL), 'only METAL between button and PSCN');
  // Also catch a shortcut that closes a loop without adding an extra node.
  const connected = new Set(nodes.map(key));
  for (const p of nodes) assert.equal(neighbors(p).filter(q => connected.has(key(q))).length,
    key(p) === key(silicon) || key(p) === key(indicator) ? 1 : 2, `unexpected conductive face at ${p}`);
  return nodes;
}
const q = temp => Math.round((temp + 273.25) * 4);
const native = id => ctNew(id, q(ELEMENTS[id].temp), 65536);

for (const rig of scene.circuits) test(`${rig.label}: isolated button pulse, fuse handoff, and V2 charge ignition`, () => {
  const { button, silicon, pilot, pocket, fuse, charge, chargeId, indicator } = rig;
  const nodes = netOf(rig), cells = [...nodes, pilot];
  const [head, tail] = fuse;
  const order = [silicon, pilot, pocket, head, tail, charge];
  const expected = [E.PSCN, E.PCLN, E.EMPTY, E.FUSE, E.FUSE, chargeId];
  assert.deepEqual(order.map(p => at(...p)), expected);
  for (let i = 1; i < order.length; i++) assert(neighbors(order[i - 1]).some(p => key(p) === key(order[i])));
  assert.equal(ctypeAt(pilot), E.FIRE);
  assert(neighbors(pocket).every(p => [E.PCLN, E.FUSE, E.INSULATOR].includes(at(...p))), 'fire pocket is enclosed');

  const run = pressed => {
    let signal = false, cellsByKey = new Map(cells.map(p => {
      const c = native(at(...p));
      c.ctype = ctypeAt(p);
      return [key(p), pressed && key(p) === key(button) ? ctWithLife(c, BUTTON_HOLD) : c];
    }));
    const adjacent = new Map(cells.map(p => [key(p), neighbors(p).map(n => [key(n), native(at(...n))])]));
    for (let t = 0; t <= cells.length; t++) {
      cellsByKey = new Map(cells.map(p => {
        const k = key(p), c = cellsByKey.get(k);
        const ns = adjacent.get(k).map(([a, seed]) => cellsByKey.get(a) ?? seed);
        // Cost roll 0 spends even a fractional level; this is worst case for the pulse.
        const word = ctElecStep(c, ns, 0);
        return [k, word ? ctElecApply(c, word, t) : c];
      }));
      signal ||= isLive(E.LAMP, cellsByKey.get(key(indicator)).spark);
    }
    assert.equal(signal, pressed, 'pulse indicator');
    return cellsByKey.get(key(pilot));
  };
  assert.equal(ctLife(run(false)), 0, 'unpressed circuit must be inert');
  const livePilot = run(true);
  assert.equal(ctLife(livePilot), ELEC.SWITCH_ON);
  assert.equal(livePilot.ctype, E.FIRE);

  // Actual V2 contact/electric kernel twins. Selection of the owning block
  // face rotates in V2; these are the steps where the intended pair owns it.
  const ins = native(E.INSULATOR), air = native(E.EMPTY);
  let flame = air;
  for (let n = 0; n < 100 && flame.id === E.EMPTY; n++) flame = ctStep(air, [livePilot, ins, ins], n * 17431);
  assert.equal(flame.id, E.FIRE, 'powered clone produces a flame in the pocket');
  let a = native(E.FUSE), b = native(E.FUSE);
  const unlit = a.life, explosive = native(chargeId);
  const update = (c, left, right, t) => {
    const word = ctElecStep(c, [left, right, ins, ins, ins, ins], 0);
    return word ? ctElecApply(c, word, t) : c;
  };
  assert.equal(update(a, air, b, 0).life, unlit, 'cold pocket is safe');
  a = update(a, flame, b, 1);
  assert(a.life < unlit, 'flame lights the fuse');
  let lit = false;
  for (let t = 1; t <= 2 * PHYS.FUSE_STEPS_PER_CELL + 128 && b.id === E.FUSE; t++) {
    [a, b] = [update(a, air, b, t), update(b, a, explosive, t)];
    lit ||= (ctStep(explosive, [b, ins, ins], t).request & 1) !== 0;
    if (lit) break;
  }
  assert(b.life < unlit, 'face-connected fuse hands off');
  assert(lit, 'hot end requests the heavy charge blast');
});

// V1's native rule twin is the 2D dock engine. Unfold a sleeved circuit into
// one strip for this test; the full authored route is tested above in 3D.
for (const id of [E.TNT, E.C4]) test(`V1 rules fire ${ELEMENTS[id].key} through a powered clone and two fuse cells`, () => {
  const w = new World(16, 3);
  for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) w.put(x, y, E.INSULATOR);
  const path = [E.BUTTON, E.METAL, E.METAL, E.METAL, E.PSCN, E.PCLN, E.EMPTY, E.FUSE, E.FUSE, id];
  for (const [i, material] of path.entries()) w.put(i + 2, 1, material, material === E.PCLN ? { ctype: E.FIRE } : {});
  w.put(2, 0, E.BATTERY);
  w.put(2, 2, E.LAMP);
  for (let i = 0; i < 30; i++) w.step();
  assert.equal(w.life[w.idx(7, 1)], 0);
  assert.equal(w.id[w.idx(8, 1)], E.EMPTY);
  assert.equal(w.id[w.idx(11, 1)], id);
  w.life[w.idx(2, 1)] = BUTTON_HOLD;
  let signal = false, ignited = false;
  for (let i = 0; i < 2 * PHYS.FUSE_STEPS_PER_CELL + 512; i++) {
    w.step();
    signal ||= isLive(E.LAMP, w.ctype[w.idx(2, 2)]);
    if (w.id[w.idx(11, 1)] !== id) { ignited = true; break; }
  }
  assert(signal, 'indicator lights from the button, not its own battery');
  assert(ignited, 'charge detonates');
});
