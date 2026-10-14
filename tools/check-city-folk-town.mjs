// CPU-only landmark lane checks. Composition/terrain access is tested by the
// independent acceptance lane after the parent joins the modules.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E, ELEMENTS } from '../src/elements.js';
import { compileShared, jsConstants, definesTypes } from '../src/world/scenes/themedShared.js';
import { toWgsl } from '../src/world/scenes/subsetWgsl.js';
import { CITY_FOLK_TOWN as T } from '../src/world/scenes/cityFolk/town.js';
import { willowCove, willowCoveTwin, WILLOW_LANDMARKS } from '../src/world/scenes/willowCove.js';

const M = T.landmarks;
const twin = seed => compileShared(T.src, seed, jsConstants('TOWN', T));
const A = twin(17), B = twin(991);
const base = (y, floor) => y < floor - 1 ? E.ROCK : y === floor - 1 ? E.PLANT : E.EMPTY;
const cell = (x, y, z, floor) => A.cfTownCell(x, y, z, floor, base(y, floor));
const buildings = [M.townHall, M.nookShop, M.ableShop, M.museum, M.cafe, ...M.cottages];

assert.deepEqual(Object.keys(T).sort(), ['ints', 'landmarks', 'salts', 'src']);
const wgsl = toWgsl(T.src, { consts: definesTypes('TOWN', T) });
assert.match(wgsl, /fn cfTownCell\(x: i32, y: i32, z: i32, h: i32, id: i32\) -> i32/);
assert.match(wgsl, /fn cfTownReserved\(x: i32, z: i32\) -> bool/);
assert.doesNotMatch(wgsl, /\b(?:int|bool) cfTown|#define/);

// Every shell has a dry supported floor, a six-cell-wide, eleven-cell-high
// route all the way from exterior, through its door, to its center.
let checked = 0;
for (const m of buildings) {
  const [cx, cz] = m.at, [ex, ez] = m.entry;
  const dx = Math.sign(ex - cx), dz = Math.sign(ez - cz);
  const length = Math.abs(ex - cx) + Math.abs(ez - cz);
  assert.equal(A.cfTownReserved(ex, ez), true, `${m.name ?? 'cottage'} entry reserved`);
  for (let n = -4; n <= length; n++) {
    const x = ex - dx * n, z = ez - dz * n;
    for (let a = -3; a < 3; a++) for (let b = -3; b < 3; b++) {
      assert.equal(cell(x + a, m.floor - 1, z + b, m.floor), E.BRICK, `supported route ${x + a},${z + b}`);
      for (let y = m.floor; y < m.floor + 11; y++) {
        assert.equal(cell(x + a, y, z + b, m.floor), E.EMPTY, `body clearance ${x + a},${y},${z + b}`);
        checked++;
      }
    }
  }
  for (let x = cx - m.half[0]; x <= cx + m.half[0]; x++) {
    for (let z = cz - m.half[1]; z <= cz + m.half[1]; z++) {
      for (let y = 0; y < m.floor - 1; y++) assert.equal(cell(x, y, z, m.floor), E.ROCK, 'continuous foundations');
      assert.equal(cell(x, m.floor - 1, z, m.floor), E.BRICK);
    }
  }
  assert.notEqual(cell(cx, m.floor + 22, cz, m.floor), E.EMPTY, 'pitched roof is real matter');
}

// Connected café entrance through both thicknesses of the museum/annex wall.
for (let x = 260; x <= 286; x++) for (let z = -83; z < -77; z++) {
  assert.equal(cell(x, 35, z, 36), E.BRICK);
  for (let y = 36; y < 47; y++) assert.equal(cell(x, y, z, 36), E.EMPTY, 'café/museum body passage');
}

// Identifiable architecture and static interiors, not empty placeholder boxes.
assert.equal(cell(-277, 50, 13, 24), E.GLASS, 'hall clock face');
assert.equal(cell(-277, 51, 12, 24), E.METAL, 'clock hand');
assert.equal(cell(-380, 40, 22, 24), E.CERAMIC, 'supply leaf emblem');
assert.equal(cell(-430, 40, 22, 24), E.METAL, 'tailor needle emblem');
assert.equal(cell(-424, 36, 22, 24), E.LIMESTONE, 'striped tailor awning');
assert.equal(cell(-423, 29, 8, 24), E.METAL, 'tailor workbench');
assert.equal(cell(310, 42, -92, 36), E.BASALT, 'museum display');
assert.equal(cell(307, 43, -64, 36), E.LIMESTONE, 'museum civic column');
assert.equal(cell(264, 38, -87, 36), E.WOOD, 'café counter');
assert.equal(cell(-326, 31, 1, 24), E.CERAMIC, 'bulletin notice panel');
for (let x = -336; x < -316; x++) for (let z = 6; z < 22; z++) {
  assert([E.BRICK, E.LIMESTONE].includes(cell(x, 23, z, 24)));
  for (let y = 24; y < 35; y++) assert.equal(cell(x, y, z, 24), E.EMPTY, 'clear event space');
}
for (const m of M.plots) {
  assert.equal(cell(...[m.at[0], m.floor - 1, m.at[1], m.floor]), E.BRICK);
  assert.equal(cell(m.at[0] + 14, m.floor + 2, m.at[1] + 14, m.floor), E.WOOD, 'survey stake');
  for (let y = m.floor; y < m.floor + 10; y++) assert.equal(cell(m.at[0], y, m.at[1], m.floor), E.EMPTY);
}
for (let x = -263; x < -257; x++) for (let z = -128; z <= -120; z++) {
  assert.equal(cell(x, 47, z, 48), E.BRICK);
  for (let y = 48; y < 66; y++) assert.equal(cell(x, y, z, 48), E.EMPTY, 'gate body-clear portal');
  assert.equal(cell(x, 66, z, 48), E.BRICK, 'gate arch');
}
assert.equal(cell(-270, 56, -124, 48), E.LIMESTONE, 'gate pier');
for (const [x, z] of [M.busReservation.stop, M.busReservation.arrival]) {
  assert.equal(A.cfTownReserved(x, z), true);
  for (let y = 48; y < 64; y++) assert.equal(A.cfTownCell(x, y, z, 48, E.METAL), E.METAL, 'bus geometry belongs to transport');
}

// Published nature exclusion rectangles and paths exactly agree with source.
for (const r of M.reservedFootprints) {
  for (let x = r.min[0]; x <= r.max[0]; x++) for (let z = r.min[1]; z <= r.max[1]; z++) assert(A.cfTownReserved(x, z));
}
for (const [[ax, az], [bx, bz]] of M.approaches) {
  assert(ax === bx || az === bz);
  const len = Math.abs(bx - ax) + Math.abs(bz - az);
  for (let n = 0; n <= len; n++) {
    const x = ax + Math.sign(bx - ax) * n, z = az + Math.sign(bz - az) * n;
    for (let a = -3; a < 3; a++) for (let b = -3; b < 3; b++) assert(A.cfTownReserved(x + a, z + b));
  }
}

// Original village, doors, furnishings and northern lookout are untouched.
for (let x = -199; x < 200; x++) for (let z = -180; z <= 200; z++) {
  assert.equal(A.cfTownReserved(x, z), false, `original core reserved ${x},${z}`);
  for (const id of [E.EMPTY, E.WOOD, E.METAL]) assert.equal(A.cfTownCell(x, 30, z, 24, id), id);
}
for (const dims of [willowCove.size, willowCove.legacySize]) {
  const old = willowCoveTwin(willowCove.params({ size: dims, seed: 17 }));
  for (const [cx, cz] of WILLOW_LANDMARKS.cottages) {
    for (let x = cx - 15; x <= cx + 15; x++) for (let z = cz - 15; z <= cz + 15; z++) for (let y = 0; y < 60; y++) {
      const id = old.wcCell(x + dims[0] / 2, y, z + dims[2] / 2);
      assert.equal(A.cfTownCell(x, y, z, 24, id), id, 'existing cottage unchanged');
    }
  }
}
// Full sprint body widths and end connectors, including all roof heights.
const old = willowCoveTwin(willowCove.params({ size: willowCove.size, seed: 17 }));
function sprint(x, z) {
  for (let y = 0; y < 86; y++) {
    const id = old.wcCell(x + 1536, y, z + 512);
    assert.equal(A.cfTownCell(x, y, z, 24, id), id, `sprint unchanged ${x},${y},${z}`);
  }
}
for (let x = -925; x <= 925; x++) for (const z0 of [-28, 36]) for (let z = z0 - 5; z <= z0 + 5; z++) sprint(x, z);
for (const x0 of [-920, 920]) for (let x = x0 - 5; x <= x0 + 5; x++) for (let z = -28; z <= 36; z++) sprint(x, z);

// Determinism, valid materials, outside passthrough and published bounding box.
const digest = createHash('sha256');
for (let x = -760; x <= 380; x += 3) for (let z = -160; z <= 130; z += 3) for (let y = 0; y < 90; y += 3) {
  const h = z < -96 ? 48 : z < -48 ? 36 : 24;
  const id = base(y, h), a = A.cfTownCell(x, y, z, h, id);
  assert(Number.isInteger(a) && ELEMENTS[a]);
  assert.equal(B.cfTownCell(x, y, z, h, id), a, 'deterministic for all seeds');
  if (!A.cfTownReserved(x, z)) assert.equal(a, id);
  digest.update(Uint16Array.of(a));
}
for (const [x, z] of [[-1500, -500], [1400, 400], [0, 0]]) for (const id of [E.EMPTY, E.GLASS, E.WATER]) assert.equal(A.cfTownCell(x, 70, z, 24, id), id);
console.log(`PASS city-folk town: ${buildings.length} enterable buildings, ${checked} body-clear cells, square/board, 2 plots, gate, café passage, reservations, original cottages and full sprint circuit unchanged`);
console.log(`Deterministic sample sha256: ${digest.digest('hex')}; shared-source WGSL translation passed`);
