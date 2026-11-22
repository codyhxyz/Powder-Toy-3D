import assert from 'node:assert/strict';
import test from 'node:test';
import { E, ELEMENTS, K } from '../src/elements.js';
import { BUTTON_HOLD, ELEC } from '../src/electricity.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT, HAND_REACH } from '../src/pov/constants.js';
import { decodeScenePlaques, nearbyPlaques } from '../src/lab/scenePlaques.js';
import { mapByKey, mapsFor } from '../src/maps.js';
import { buildPreset } from '../src/presets.js';
import { buildNuclearBunker, nuclearBunkerManifest, NUCLEAR_BUNKER_SIZE, NUCLEAR_BUNKER_SPAWN } from '../src/scenes/nuclearBunker.js';
import { BLAST_REACH_MAX, EVENT, chargeBatchDamage, dynamicsRows, v1ShockFall } from '../src/v2/dynamics-reference.js';
import { contactAmbientQ, ctConduct, ctElecApply, ctElecMaterial, ctElecStep, ctLife, ctNew, ctPhase, ctStepAtmosphere, ctWithLife } from '../src/v2/contact.js';
import { NUCLEAR } from '../src/rays.js';

const [nx, ny, nz] = NUCLEAR_BUNKER_SIZE;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const inside = (p) => p.every((n, i) => Number.isInteger(n) && n >= 0 && n < NUCLEAR_BUNKER_SIZE[i]);
const index = ([x, y, z]) => x + nx * (z + nz * y);
const point = n => [n % nx, Math.floor(n / (nx * nz)), Math.floor(n / nx) % nz];
const adjacent = (p) => FACES.map(d => p.map((n, i) => n + d[i]));
const grid = new Uint8Array(nx * ny * nz), properties = new Map();
function set(x, y, z, id, extra) {
  if (!inside([x, y, z])) assert.fail(`Out of bounds at ${x},${y},${z}`);
  if (!ELEMENTS[id]) assert.fail(`Invalid cell material ${id}`);
  const n = index([x, y, z]);
  grid[n] = id;
  if (extra) properties.set(n, extra);
  else properties.delete(n);
}
const layout = buildNuclearBunker({ set, box(x0, y0, z0, x1, y1, z1, id, extra) {
  assert(x0 < x1 && y0 < y1 && z0 < z1, 'every authored box has positive volume');
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id, extra);
} });
const idAt = p => inside(p) ? grid[index(p)] : E.WALL;
const solid = p => ELEMENTS[idAt(p)].kind === K.SOLID;
const ambient = contactAmbientQ(ELEMENTS[E.EMPTY].temp);
const cell = (id, temp = ELEMENTS[id].temp) => ctNew(id, contactAmbientQ(temp), 65536);
function contact(p) {
  const id = idAt(p), extra = properties.get(index(p)) ?? {}, c = cell(id, extra.temp);
  c.ctype = extra.ctype ?? 0;
  return extra.life == null ? c : ctWithLife(c, extra.life);
}
const materialFace = (c, b, seed) => ctStepAtmosphere(c, [cell(E.EMPTY), b, cell(E.EMPTY)], seed, 0, 0, 0, 0, 0, ambient, 0, 0, 0);

// Drive the same six-face contact rules that the native electric pass uses.
// Discover the complete local net from the physical voxels, not from waypoints
// in the builder. This catches leaking routes, opens, bypasses and wrong diodes.
function electricFixture(roots, changed = new Map()) {
  const seen = new Set(roots.map(index));
  for (const n of seen) for (const p of adjacent(point(n))) if (inside(p) && ctElecMaterial(idAt(p))) seen.add(index(p));
  const nodes = Array.from(seen, n => {
    const near = adjacent(point(n)).map(p => ({ index: index(p), state: contact(p) }));
    return { n, near, state: contact(point(n)) };
  });
  let states = new Map(nodes.map(({ n, state }) => [n, changed.get(n) ?? state]));
  const step = () => {
    const next = new Map();
    for (const { n, near } of nodes) {
      const c = states.get(n), ns = near.map(p => states.get(p.index) ?? changed.get(p.index) ?? p.state);
      const word = ctElecStep(c, ns, 0.5);
      next.set(n, word ? ctElecApply(c, word, 0) : c);
    }
    states = next;
  };
  return { step, at: p => states.get(index(p)), nodes };
}

test('sandbox map selects the fixed valley preset and loads the authored cells', () => {
  const map = mapByKey('nuclearBunker');
  assert(map && mapsFor('sandbox').includes(map));
  assert.deepEqual([map.size, map.preset, map.dims], ['valley', 'nuclearBunker', NUCLEAR_BUNKER_SIZE]);
  assert(map.startInPov);
  assert.equal(map.spawnYaw, -Math.PI / 2, 'entry faces the range to the east');
  assert.throws(() => buildPreset(map.preset, { g: { nx: 128, ny, nz } }), /requires a 256×96×128 grid/);
  let loaded = false;
  const blank = new Float32Array(grid.length * 4), other = new Float32Array();
  buildPreset(map.preset, {
    g: { nx, ny, nz }, blankState: () => [blank, other], cellTexel: (x, y, z) => index([x, y, z]),
    load(a, b) {
      assert.equal(a, blank);
      assert.equal(b, other);
      for (let i = 0; i < grid.length; i++) if (a[4 * i] !== grid[i]) assert.fail(`Preset diverges at ${point(i)}`);
      for (const { clone, recipe } of layout.tests) assert.equal(Math.floor(a[index(clone) * 4 + 3]), recipe);
      loaded = true;
    },
  });
  assert(loaded);
});

test('vault has successive armor tiers and both water jackets are sealed', () => {
  assert.deepEqual([48, 45, 43, 41, 39, 20, 18, 16].map(y => idAt([177, y, 64])),
    [E.BRICK, E.WATER, E.METAL, E.TITANIUM, E.EMPTY, E.TUNGSTEN, E.DIAMOND, E.EMPTY]);
  assert.equal(idAt([124, 16, 61]), E.ROCK, 'outside berm');
  assert.deepEqual([206, 207, 208, 209, 210, 211].map(x => idAt([x, 12, 59])),
    [E.EMPTY, E.GLASS, E.GLASS, E.GLASS, E.GLASS, E.EMPTY]);
  let water = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === E.WATER) {
    water++;
    for (const p of adjacent(point(i))) if (idAt(p) !== E.WATER && !solid(p)) assert.fail(`Water leaks from ${point(i)} to ${p}`);
  }
  assert(water > 1000, 'not just a token water cell');
});

test('each firing button closes its own native circuit; no supply bypass or cross-fire', () => {
  const roots = layout.tests.map(t => t.button);
  for (const selected of [null, ...layout.tests]) {
    const changed = new Map();
    if (selected) changed.set(index(selected.button), ctWithLife(contact(selected.button), BUTTON_HOLD));
    const fixture = electricFixture(roots, changed);
    assert(fixture.nodes.length < 5000, 'cables stay isolated from structural armor');
    for (let tick = 0; tick < nx; tick++) fixture.step();
    for (const t of layout.tests) {
      assert.equal(idAt(t.button), E.BUTTON);
      assert.equal(idAt(t.battery), E.BATTERY);
      const clones = [...properties.keys()].filter(n => grid[n] === E.PCLN && Math.abs(point(n)[2] - t.clone[2]) <= 7);
      assert(clones.length > 1, `${t.key}: missing array`);
      for (const n of clones) {
        const p = point(n), state = fixture.at(p);
        assert(state, `${t.key}: disconnected head cell at ${p}`);
        assert.equal(ctLife(state), t === selected ? ELEC.SWITCH_ON : 0, `${selected?.key ?? 'idle'} → ${t.key} at ${p}`);
      }
      assert.equal(ctLife(fixture.at(t.button)), 0, 'physical button has released');
    }
  }
});

test('live heads feed actual native ignition, impact and neutron rules', () => {
  const [buster, thermite, nitro, fission] = layout.tests;
  const below = ([x, y, z], drop) => [x, y - drop, z];
  function copyFrom(t) {
    const off = contact(t.clone), out = below(t.clone, 1);
    assert.equal(off.id, E.PCLN);
    assert.equal(off.ctype, t.recipe);
    assert.equal(idAt(out), E.EMPTY);
    const on = ctWithLife(off, ELEC.SWITCH_ON);
    for (let seed = 1; seed < 10000; seed++) {
      assert.equal(materialFace(contact(out), off, seed).id, E.EMPTY);
      const cloned = materialFace(contact(out), on, seed);
      if (cloned.id === t.recipe) return cloned;
    }
    assert.fail(`${t.key} never clones its recipe`);
  }
  const primerAt = below(buster.clone, 2), mainAt = below(buster.clone, 3);
  const starter = contact(primerAt), main = contact(mainAt);
  assert.equal(starter.id, E.C4);
  assert.equal(main.id, E.TNT);
  assert(materialFace(starter, copyFrom(buster), 1).request & EVENT.DETONATE, 'primer ignites on hot contact');
  // One pair, translated to the equivalent brick parity in a small fixture.
  const localPrimer = primerAt.map(n => 4 + n % 4), localMain = below(localPrimer, 1).join(',');
  const batch = chargeBatchDamage({ dims: [8, 8, 8],
    cells: new Map([[localPrimer.join(','), starter.id], [localMain, main.id]]),
    charges: [{ p: localPrimer, id: starter.id, energy: dynamicsRows[starter.id].energy }],
  });
  assert(batch.get(localMain)?.setOff, 'adjacent TNT is blast-sensitive to the primer');

  const powder = contact(below(thermite.clone, 2));
  assert.equal(powder.id, E.THERMITE);
  const melt = materialFace(powder, copyFrom(thermite), 1);
  assert.equal(melt.id, E.LAVA);
  assert.equal(melt.ctype, E.METAL);
  let coupon = contact(below(thermite.clone, 9));
  assert.equal(coupon.id, E.METAL, 'steel coupon beneath charge');
  assert.equal(materialFace(powder, melt, 1).id, E.LAVA, 'molten product ignites the next layer');
  // Isolate the contact (no air or lateral losses): fresh molten product
  // flowing from the bed supplies the heat, not a scripted change of steel.
  for (let drop = 0; drop < 7 && coupon.id === E.METAL; drop++) {
    let slag = melt;
    for (let tick = 0; tick < 30 && coupon.id === E.METAL && slag.tq > coupon.tq; tick++) {
      const pair = ctConduct(coupon, slag, 0);
      coupon = ctPhase(pair.a, 0, 0);
      slag = pair.b;
    }
  }
  assert.equal(coupon.id, E.LAVA, 'the hot product melts steel on native conduction and phase rules');

  const hotSlag = copyFrom(nitro);
  let fall = 0;
  while (idAt(below(nitro.clone, fall + 1)) === E.EMPTY) fall++;
  const fuel = contact(below(nitro.clone, fall + 1));
  assert.equal(fuel.id, E.NITRO);
  const trip = v1ShockFall(hotSlag.id, fuel.id);
  assert(trip > 0 && fall - 1 >= trip, 'drop exceeds native LAVA → NITRO liquid-column shock threshold');
  assert(materialFace(fuel, hotSlag, 1).request & EVENT.DETONATE, 'hot contact also underwrites ignition');
  assert(nitro.clone[2] - buster.clone[2] > BLAST_REACH_MAX + 15, 'the sensitive pan is not in the primer bay');

  const fissile = copyFrom(fission);
  assert(!grid.includes(E.PLUTONIUM), 'no spontaneous emissions before arming');
  assert.equal(fissile.id, E.PLUTONIUM);
  assert(NUCLEAR.PLUTONIUM.fF > 0 && NUCLEAR.PLUTONIUM.nuF > 1 && NUCLEAR.WATER.h > 0);
  let emitted = false;
  for (let seed = 1; seed < 200000 && !emitted; seed++) emitted = !!(materialFace(fissile, cell(E.EMPTY), seed).request & EVENT.NEUTRON);
  assert(emitted, 'cloned material emits native neutrons, not a painted ray tool');
});

test('vault alarms react to a hot face and room lamps have their own batteries', () => {
  for (const { sensor, lamp } of layout.alarms) {
    assert.equal(idAt(sensor), E.TSNS);
    assert.equal(idAt(lamp), E.LAMP);
    const fixture = electricFixture([sensor, lamp]);
    for (let step = 0; step < 150; step++) fixture.step();
    assert.equal(ctLife(fixture.at(sensor)), 0);
    assert.equal(fixture.at(lamp).spark, 0);
    const [x, y, z] = sensor, hot = [x, y + 1, z];
    const heated = electricFixture([sensor, lamp], new Map([[index(hot), cell(E.LAVA)]]));
    for (let step = 0; step < 150; step++) heated.step();
    assert.equal(ctLife(heated.at(sensor)), ELEC.TSNS_FIRE);
    assert(heated.at(lamp).spark > 0);
  }
  const light = [170, 15, 61], battery = [170, 16, 61];
  assert.equal(idAt(light), E.LAMP);
  assert.equal(idAt(battery), E.BATTERY);
  const fixture = electricFixture([light]);
  fixture.step();
  assert(fixture.at(light).spark > 0);
});

function clearBody([x, y, z]) {
  const r = BODY_WIDTH / 2;
  for (let xx = Math.floor(x - r); xx <= Math.floor(x + r); xx++) for (let zz = Math.floor(z - r); zz <= Math.floor(z + r); zz++) {
    for (let yy = y; yy < y + BODY_HEIGHT; yy++) if (idAt([xx, yy, zz]) !== E.EMPTY) return false;
  }
  return true;
}
function stand([x, y, z]) {
  if (!clearBody([x, y, z])) return false;
  const r = BODY_WIDTH / 2;
  for (let xx = Math.floor(x - r); xx <= Math.floor(x + r); xx++) {
    for (let zz = Math.floor(z - r); zz <= Math.floor(z + r); zz++) if (solid([xx, y - 1, zz])) return true;
  }
  return false;
}

test('player can reach each button and walk to the vault without jumping or digging', () => {
  assert(stand(NUCLEAR_BUNKER_SPAWN));
  const key = p => index(p.map(Math.floor));
  const queue = [NUCLEAR_BUNKER_SPAWN], reached = new Set(queue.map(key));
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i];
    for (const [dx, , dz] of FACES.filter(d => !d[1])) for (const dy of [0, -1, 1]) {
      const next = [x + dx, y + dy, z + dz], n = key(next);
      if (!inside(next.map(Math.floor)) || reached.has(n) || !stand(next)) continue;
      if (dy && !clearBody(dy > 0 ? [x, y + 1, z] : [x + dx, y, z + dz])) continue;
      reached.add(n); queue.push(next);
    }
  }
  for (const under of [[111.5, 9, 101.5], [138.5, 7, 66.5], [160.5, 6, 74.5], layout.vaultInterior]) {
    assert(reached.has(key(under)), `no supported route to ${under}`);
  }
  for (const { button } of layout.tests) {
    const target = button.map(n => n + 0.5), feet = [47.5, 33, target[2]];
    assert(reached.has(key(feet)));
    const eye = [feet[0], feet[1] + EYE_HEIGHT, feet[2]], ray = eye.map((n, i) => target[i] - n);
    assert(Math.hypot(...ray) <= HAND_REACH);
    for (let j = 0; j <= 32; j++) {
      const p = eye.map((n, i) => Math.floor(n + ray[i] * j / 32));
      if (key(p) !== key(button)) assert.equal(idAt(p), E.EMPTY, `button ${button} is occluded at ${p}`);
    }
  }
});

test('plaque manifest matches authored surfaces, with every control labeled near spawn', () => {
  assert.deepEqual(nuclearBunkerManifest(), layout);
  assert.deepEqual(decodeScenePlaques(layout.plaques), layout.plaques);
  for (const { cell: p, normal } of layout.plaques) {
    assert(inside(p) && solid(p), `plaque has no anchoring surface at ${p}`);
    assert.equal(idAt(p.map((n, i) => n + normal[i])), E.EMPTY, `plaque is obstructed at ${p}`);
  }
  const visible = nearbyPlaques(layout.plaques, NUCLEAR_BUNKER_SPAWN);
  for (const t of layout.tests) {
    assert(visible.some(p => p.cell[2] === t.button[2] && p.cell[0] === t.button[0] && /^0[1-4] /.test(p.text)));
  }
});
