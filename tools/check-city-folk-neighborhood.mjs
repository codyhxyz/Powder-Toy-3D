// CPU-only COMPOSED neighborhood scenery acceptance; no browser or GPU.
// Run: node --test tools/check-city-folk-neighborhood.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, K } from '../src/elements.js';
import { willowCove as scene, willowCoveTwin, WILLOW_LANDMARKS as M } from '../src/world/scenes/willowCove.js';
import { CITY_FOLK_TERRAIN as T } from '../src/world/scenes/cityFolk/terrain.js';
import { CITY_FOLK_NATURE as N } from '../src/world/scenes/cityFolk/nature.js';
import { CITY_FOLK_TOWN as town } from '../src/world/scenes/cityFolk/town.js';

const size = scene.size, seed = 20261008;
const twin = willowCoveTwin(scene.params({ size, seed }));
const cell = (x, y, z) => twin.wcCell(x + size[0] / 2, y, z + size[2] / 2);
const solid = id => ELEMENTS[id]?.kind === K.SOLID || id === E.SAND;
const key = (x, z) => `${x},${z}`;
const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Full player footprint and doorway headroom, not a single standable column.
const bodyCache = new Map();
function body(x, z) {
  const k = key(x, z);
  if (bodyCache.has(k)) return bodyCache.get(k);
  const h = twin.cfHeight(x, z);
  let clear = true;
  for (let dz = -3; dz < 3 && clear; dz++) for (let dx = -3; dx < 3 && clear; dx++) {
    if (twin.cfHeight(x + dx, z + dz) !== h || !solid(cell(x + dx, h - 1, z + dz))) { clear = false; break; }
    for (let y = h; y < h + 11; y++) if (cell(x + dx, y, z + dz) !== E.EMPTY) { clear = false; break; }
  }
  bodyCache.set(k, clear);
  return clear;
}

test('four small real neighborhood basins have solid beds and supported dry rims', () => {
  assert.equal(T.neighborhoodPonds.length, 4);
  assert(T.neighborhoodPonds.some(p => p.name === 'shops'));
  assert(T.neighborhoodPonds.filter(p => p.name.startsWith('lower-')).length >= 2);
  assert(T.neighborhoodPonds.some(p => p.name === 'original-home-edge'));
  for (const p of T.neighborhoodPonds) {
    const [cx, cz] = p.at;
    assert(p.radius >= 5 && p.radius <= 8, 'neighborhood scale, not large remote lake');
    let waterCells = 0;
    for (let dz = -p.bankRadius; dz <= p.bankRadius; dz++) for (let dx = -p.bankRadius; dx <= p.bankRadius; dx++) {
      const x = cx + dx, z = cz + dz, d2 = dx * dx + dz * dz;
      assert(!twin.cfPath(x, z) && !twin.cfTownReserved(x, z), `${p.name}: whole basin/rim off reservations`);
      assert.equal(twin.cfHeight(x, z), p.floor, 'level supported bank');
      if (d2 < p.radius * p.radius) {
        assert.equal(cell(x, p.bed - 1, z), E.ROCK, 'solid basin bed');
        for (let y = p.bed; y < p.water; y++) { assert.equal(cell(x, y, z), E.WATER); waterCells++; }
        for (let y = p.water; y < p.floor + 11; y++) assert.equal(cell(x, y, z), E.EMPTY);
      } else if (d2 <= p.bankRadius * p.bankRadius) {
        assert.equal(cell(x, p.floor - 1, z), E.ROCK, 'true rocky bank');
        assert.equal(cell(x, p.floor - 2, z), E.ROCK, 'supported bank, not floating mesh');
        for (let y = p.floor; y < p.floor + 11; y++) assert.equal(cell(x, y, z), E.EMPTY);
      }
    }
    assert(waterCells > 400 && waterCells < 1000, 'bounded small water volume');
  }
});

test('every pond has four body-clear dry banks reachable from the inhabited route network', () => {
  for (const p of T.neighborhoodPonds) {
    const [cx, cz] = p.at, [ax, az] = p.access;
    assert(twin.cfPath(ax, az), `${p.name}: access joins protected route`);
    assert(body(ax, az), 'route access body clearance');
    const queue = [[ax, az]], reached = new Set([key(ax, az)]);
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i];
      for (const [dx, dz] of steps) {
        const nx = x + dx, nz = z + dz, k = key(nx, nz);
        if (Math.abs(nx - cx) > 22 || nz < Math.min(cz - 22, az) || nz > Math.max(cz + 22, az)) continue;
        if (!reached.has(k) && body(nx, nz)) { reached.add(k); queue.push([nx, nz]); }
      }
    }
    assert.equal(p.banks.length, 4);
    for (const [x, z] of p.banks) assert(reached.has(key(x, z)), `${p.name}: unreachable bank ${x},${z}`);
  }
});

test('neighborhood trunks, crowns and low rocks are dry, fully clear of reserved footprints and face-connected', () => {
  assert(N.neighborhood.trees.length >= 6 && N.neighborhood.rocks.length >= 5);
  for (const p of [...N.neighborhood.trees, ...N.neighborhood.rocks]) {
    const [cx, cz] = p.at, h = p.floor, r = p.radius, rock = p.kind === 'rock';
    assert.equal(cell(cx, h, cz), rock ? E.ROCK : E.WOOD, `${p.kind}: actual composed root`);
    const cells = new Map(), reached = new Set(), queue = [];
    const voxelKey = (x, y, z) => `${x},${y},${z}`;
    let leaves = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, z = cz + dz;
      assert(!twin.cfPath(x, z) && !twin.cfTownReserved(x, z), 'complete root/crown rectangle, not just nine samples');
      assert.equal(twin.cfHeight(x, z), h);
      assert.equal(twin.cfTerrainCell(x, h - 1, z), E.PLANT, 'stable grass under complete footprint');
      assert.equal(twin.cfTerrainCell(x, h, z), E.EMPTY);
      for (let dy = 0; dy <= 30; dy++) {
        const id = cell(x, h + dy, z);
        if (id === E.EMPTY) continue;
        assert(!rock || (id === E.ROCK && dy <= 2), 'small stones are at most three cells tall');
        const k = voxelKey(dx, dy, dz); cells.set(k, id);
        if (dy === 0) { queue.push([dx, dy, dz]); reached.add(k); }
        if ([E.PLANT, E.MOSS].includes(id)) leaves++;
      }
    }
    if (!rock) { assert(leaves > 100, 'real crown'); assert.equal(cell(cx, h + 10, cz), E.WOOD, 'continuous trunk'); }
    for (let i = 0; i < queue.length; i++) {
      const [x, y, z] = queue[i];
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const k = voxelKey(x + dx, y + dy, z + dz);
        if (cells.has(k) && !reached.has(k)) { reached.add(k); queue.push([x + dx, y + dy, z + dz]); }
      }
    }
    assert.equal(reached.size, cells.size, 'all scenery connected to ground');
  }
});

test('complete town approaches retain six-cell body clearance and nature respects every shell/roof reservation', () => {
  for (const [[ax, az], [bx, bz]] of town.landmarks.approaches) {
    const n = Math.abs(bx - ax) + Math.abs(bz - az);
    for (let i = 0; i <= n; i++) assert(body(ax + Math.sign(bx - ax) * i, az + Math.sign(bz - az) * i), 'composed reserved approach');
  }
  for (const { min, max } of town.landmarks.reservedFootprints) {
    for (let z = min[1]; z <= max[1]; z++) for (let x = min[0]; x <= max[0]; x++) {
      const h = twin.cfHeight(x, z);
      for (const y of [h - 1, h, h + 10, h + 25]) assert.equal(twin.cfNatureCell(x, y, z, h, E.EMPTY), E.EMPTY);
    }
  }
});

test('scenery is expanded-only; original core/cottages and usable meadow stay unchanged', () => {
  const old = willowCoveTwin(scene.params({ size: scene.legacySize, seed }));
  for (const p of [...T.neighborhoodPonds, ...N.neighborhood.trees, ...N.neighborhood.rocks]) {
    const [cx, cz] = p.at;
    for (let dz = -12; dz <= 12; dz += 3) for (let dx = -12; dx <= 12; dx += 3) for (let y = 0; y < 80; y++) {
      assert.equal(old.wcCell(cx + dx + 512, y, cz + dz + 512), old.cfTerrainCell(cx + dx, y, cz + dz), 'legacy bypasses expanded modules');
    }
  }
  for (let z = -176; z <= 196; z += 4) for (let x = -188; x <= 188; x += 4) for (let y = 0; y < 80; y += 3) {
    assert.equal(cell(x, y, z), twin.cfTerrainCell(x, y, z), 'original core unchanged');
  }
  for (const [x, z] of M.cottages) {
    assert.equal(cell(x - 12, 24, z), E.PLANKS);
    assert.equal(cell(x - 12, 28, z), E.GLASS);
    assert(body(x, z - 14), 'original cottage entrance');
  }
  for (let x = 192; x <= 224; x += 4) for (let z = 72; z <= 112; z += 4) for (let y = 24; y <= 54; y++) assert.equal(cell(x, y, z), E.EMPTY, 'original open meadow');
  for (const [cx, cz] of T.landmarks.meadows) for (let dz = -12; dz <= 12; dz += 3) for (let dx = -12; dx <= 12; dx += 3) assert(body(cx + dx, cz + dz), 'published open meadow');
});
