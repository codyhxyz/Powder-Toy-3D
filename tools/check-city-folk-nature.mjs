// CPU-only nature lane contract checks. The integration suite must additionally
// check the composed scene against the final terrain/town masks.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../src/elements.js';
import { CITY_FOLK_NATURE as N } from '../src/world/scenes/cityFolk/nature.js';
import { compileShared, definesTypes, jsConstants } from '../src/world/scenes/themedShared.js';
import { toWgsl } from '../src/world/scenes/subsetWgsl.js';
import { willowCoveTwin } from '../src/world/scenes/willowCove.js';

let terrainReads = 0;
let reserve = () => false;
let path = (x, z) => Math.abs(x) <= 920 && (Math.abs(z - 36) < 6 || Math.abs(z + 28) < 6);
let height = (x, z) => z >= 140 ? 18 : z < -104 ? 48 : z < -48 ? 36 : 24;
let support = (x, y, z) => {
  const h = height(x, z);
  return y < h - 1 ? E.ROCK : y === h - 1 ? (z >= 140 ? E.SAND : E.PLANT) : E.EMPTY;
};
const make = seed => compileShared(N.src, seed, {
  ...jsConstants('NATURE', N),
  cfHeight: (x, z) => height(x, z),
  cfTerrainCell: (x, y, z) => { terrainReads++; return support(x, y, z); },
  cfPath: (x, z) => path(x, z),
  cfTownReserved: (x, z) => reserve(x, z),
});
const T = make(20261008);
const at = (x, y, z, twin = T) => twin.cfNatureCell(x, y, z, height(x, z), support(x, y, z));
const generated = (x, y, z, twin = T) => at(x, y, z, twin) !== support(x, y, z);
const wgsl = toWgsl(N.src, {
  consts: definesTypes('NATURE', N),
  externs: { cfHeight: 'i32', cfTerrainCell: 'i32', cfPath: 'bool', cfTownReserved: 'bool' },
});
assert.match(wgsl, /fn cfNatureCell\(x: i32, y: i32, z: i32, h: i32, id: i32\) -> i32/);
assert.doesNotMatch(wgsl, /#define|\bint\b/);
assert.doesNotMatch(N.src, /\b(?:new|async|await)\b|\[/, 'no per-cell allocation/asynchrony');
assert(Object.keys(N.ints).every(k => Number.isInteger(N.ints[k])));
for (const m of Object.values(N.landmarks)) {
  assert.equal(m.at.length, 2);
  assert(Number.isInteger(m.floor) && m.kind.length > 0);
}

// Inspect actual full-size supported silhouettes, including a face-connected
// support flood fill (no detached leaves, fronds, fruit or coconuts).
let treeCells = 0;
for (const [name, x, z, accent, minimumHeight] of [
  ['cedar', -592, -112, E.MOSS, 27],
  ['hardwood', 304, 80, E.PLANT, 22],
  ['apple', 624, 80, E.BRICK, 22],
  ['palm', 336, 152, E.SANDSTONE, 20],
]) {
  const h = height(x, z), cells = new Map(), reached = new Set(), queue = [];
  let high = 0;
  const key = (dx, dy, dz) => `${dx},${dy},${dz}`;
  for (let dz = -11; dz <= 11; dz++) for (let dx = -11; dx <= 11; dx++) for (let dy = 0; dy <= 30; dy++) {
    const id = at(x + dx, h + dy, z + dz);
    assert(ELEMENTS[id], `${name}: valid material`);
    if (id === E.EMPTY) continue;
    cells.set(key(dx, dy, dz), id);
    high = Math.max(high, dy);
    if (dy === 0) { queue.push([dx, dy, dz]); reached.add(key(dx, dy, dz)); }
  }
  assert(cells.size > 100, `${name}: substantial silhouette`);
  assert([...cells.values()].includes(accent), `${name}: characteristic accent`);
  assert(high >= minimumHeight && high <= 30, `${name}: recognizable bounded height ${high}`);
  for (let i = 0; i < queue.length; i++) {
    const [dx, dy, dz] = queue[i];
    for (const [sx, sy, sz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const k = key(dx + sx, dy + sy, dz + sz);
      if (cells.has(k) && !reached.has(k)) { reached.add(k); queue.push([dx + sx, dy + sy, dz + sz]); }
    }
  }
  assert.equal(reached.size, cells.size, `${name}: every cell connected to ground`);
  treeCells += cells.size;
}
assert.equal(at(400, 24, 120), E.PLANT, 'flower stem');
assert([E.CERAMIC, E.BRICK].includes(at(400, 25, 120)), 'flower petals');
assert.equal(at(464, 24, 120), E.ROCK, 'scattered rock');
assert.equal(at(304, 18, 156), E.CERAMIC, 'ivory shell');
assert.equal(at(432, 23, 120), E.SANDSTONE, 'visible discovery star');
assert.equal(at(432, 22, 120), E.LIMESTONE, 'buried pale fossil');
assert.equal(at(416, 23, 44), E.SANDSTONE, 'worn route shoulder');
terrainReads = 0;
assert.equal(T.cfNatureCell(640, 50, 80, 24, E.EMPTY), E.EMPTY);
assert.equal(terrainReads, 0, 'empty silhouette air performs no bare-terrain reads');
terrainReads = 0;
assert.equal(T.cfNatureCell(624, 45, 80, 24, E.EMPTY), E.PLANT);
assert(terrainReads <= 36, 'candidate support checks are statically bounded, not full scene scans');

// Preserve protected paths, reservations, original village, authored matter,
// river water and bridge cells. Exclusion applies to all decorations and dirt.
for (const [x, z] of [[624, 36], [-560, -28], [528, 36]]) {
  for (let y = 0; y < 90; y++) assert.equal(at(x, y, z), support(x, y, z), 'protected sprint body');
}
reserve = () => true;
for (const [x, z] of [[-464, -112], [624, 80], [400, 120], [432, 120], [304, 156], [416, 44]]) {
  for (let y = 0; y < 90; y++) assert.equal(at(x, y, z), support(x, y, z), 'town reservation');
}
reserve = (x, z) => x === 449 && z === 90;
assert.equal(at(446, 23, 90), E.SANDSTONE, 'worn ground outside busy landmark reservation');
assert.equal(at(449, 23, 90), E.PLANT, 'reserved landmark ground unchanged');
reserve = () => false;
for (const id of [E.WOOD, E.BRICK, E.GLASS, E.WATER, E.CERAMIC, E.SANDSTONE]) {
  for (const y of [23, 24, 25, 40]) assert.equal(T.cfNatureCell(624, y, 80, 24, id), id, 'existing authored matter wins');
}
const old = willowCoveTwin({ seed: 20261008, size: [3072, 128, 1024] });
for (let z = -176; z <= 196; z += 4) for (let x = -188; x <= 188; x += 4) {
  for (let y = 0; y < 80; y += 3) {
    const id = old.wcCell(x + 1536, y, z + 512);
    assert.equal(T.cfNatureCell(x, y, z, old.wcHeight(x, z), id), id, 'unchanged original village');
  }
}

// Also compose against the actual integration-base bare terrain, rather than
// assuming that the stretched octagonal beach is a rectangular sand strip.
// Final terrain and town changes still require the independent composed suite.
const fixtureHeight = height, fixtureSupport = support;
height = (x, z) => old.cfHeight(x, z);
support = (x, y, z) => old.cfTerrainCell(x, y, z);
for (const key of ['cedarWoods', 'hardwoodGrove', 'nativeOrchard', 'beachPalms']) {
  const { at: [x, z], floor } = N.landmarks[key];
  assert.equal(height(x, z), floor, `${key}: real terrain floor`);
  assert.equal(at(x, floor + 10, z), E.WOOD, `${key}: supported on actual bare terrain`);
}
assert.equal(at(304, 18, 156), E.CERAMIC, 'shell lies on actual dry beach');
assert.equal(at(819, 37, 145), E.PLANT, 'supported palm frond can overhang inland beach lip');
height = fixtureHeight;
support = fixtureSupport;

// Reject water under an apparently empty air cell, cliff edges, a one-cell
// hole below a trunk, and paths/reservations beneath prospective crowns.
const dry = support;
support = (x, y, z) => y === height(x, z) - 1 ? E.WATER : dry(x, y, z);
for (const [x, z] of [[400, 120], [464, 120], [432, 120], [304, 156], [624, 80]]) {
  const h = height(x, z);
  for (let y = h - 2; y <= h + 30; y++) assert.equal(at(x, y, z), support(x, y, z), 'water/river never decorated');
}
support = dry;
for (const reject of [
  (x, y, z) => x === 624 && z === 80 && y === 23 ? E.WATER : dry(x, y, z),
  (x, y, z) => x === 625 && z === 81 && y === 23 ? E.EMPTY : dry(x, y, z),
]) {
  support = reject;
  assert.equal(at(624, 30, 80), E.EMPTY, 'unsafe trunk rejected');
}
support = dry;
const flat = height;
height = (x, z) => x === 633 && z === 89 ? 25 : flat(x, z);
assert.equal(at(624, 30, 80), E.EMPTY, 'cliff edge rejected');
height = flat;
reserve = (x, z) => x === 633 && z === 89;
assert.equal(at(624, 30, 80), E.EMPTY, 'crown reservation rejects tree');
reserve = () => false;
const route = path;
path = (x, z) => route(x, z) || (x === 633 && z === 89);
assert.equal(at(624, 30, 80), E.EMPTY, 'crown path rejects tree');
path = route;

// Generous open meadow, bounded generation and deterministic streaming order.
for (const [west, east, north, south] of [[192, 224, 72, 112], [-1100, -960, 60, 112], [864, 896, 64, 112]]) {
  for (let z = north; z <= south; z += 4) for (let x = west; x <= east; x += 4) {
    for (let y = 24; y <= 54; y++) assert.equal(at(x, y, z), E.EMPTY, 'open meadow stays open');
  }
}
const repeat = make(20261008), other = make(42);
for (let i = 0; i < 20000; i++) {
  const x = (i * 97) % 2200 - 1100, z = (i * 53) % 352 - 176, y = (i * 31) % 128;
  const first = at(x, y, z);
  assert.equal(at(x, y, z, repeat), first, 'repeat seed / independent streamed calls');
  assert(ELEMENTS[first]);
  // Only worn-ground edge grain varies by seed, not trees or landmarks.
  if (y !== height(x, z) - 1) assert.equal(at(x, y, z, other), first, 'stable landmark topology');
  if (y < height(x, z) - 3 || y > height(x, z) + 30 || Math.abs(x) > 920) {
    assert(!generated(x, y, z), 'bounded changes');
  }
}
console.log(`PASS City Folk nature: ${treeCells} connected tree voxels; silhouettes, scenery, protected masks, original core, support, meadows, determinism and shared WGSL translation`);
