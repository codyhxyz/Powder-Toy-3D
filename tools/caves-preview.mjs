// CPU preview of the island's caves (src/world/island/caves.js) from the
// island's JS twin (world/generator.js: islandCell, the cells the GPU makes, its
// caves hook instrumented to count noise): PNGs and a census. No GPU: fine on
// battery.
//
//   node tools/caves-preview.mjs [--cliffs] [outDir] [x0 z0 nx nz]
// (default: the whole world, into ./cave-previews). --cliffs steepens the
// generator's cliff shores (a stand-in for a heightfield with real cliffs:
// today's island is nowhere steeper than 0.9 cells per cell, too gentle for
// sea caves to open).
//
// Images:
//   slice-y<Y>.png      top down at height Y: rock, sky, sea, cave air (black),
//                       cave water (cyan), crystal (magenta), speleothems (orange)
//   section-<axis><N>.png  vertical cross-sections, and -zoom crops of them
//   entrances.png       the terrain from above (hillshade), where caves lie under
//                       it (purple tint) and their mouths: hillside (red), sea
//                       (cyan), shafts (yellow)
// Census:
//   - cave volume, as a share of the ground and of the cells caves may take;
//   - how much of it connects to a mouth (the player can walk or swim in);
//   - floor clearance (cells of headroom over each cave floor cell): tunnels
//     and caverns apart;
//   - underground lakes, sea caves and through-caves (arches);
//   - stability: anything loose or growing that a cave touches (powder over or
//     beside a void, plant cover over one or touching cave water, cave water
//     beside air, standing water (sea, lakes) beside a void, trees near open
//     caves);
//   - noise evaluations per cell, by kind (2D or 3D, value or distance).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { E } from '../src/elements.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { worldParams, treesIn, buildIslandTwin, WORLD_SEED, GEN, ISLAND_CELL_SRC } from '../src/world/generator.js';
import { caves, CAVE } from '../src/world/island/caves.js';

const NY = WORLD_SIZE[1];
const SECTION_TOP = 100;          // sections show heights 0..this (the island's peaks are below it)
const ZOOM_W = 320;               // zoomed section crops: cells across...
const ZOOM_K = 2;                 // ...blown up this much
const LAYER_DEPTH = 3;            // the deepest cover (sand, snow), cells (generator.js GEN_INT)
const TREE_FOOT_R = 3;            // the audit looks for open caves (mouths, shafts) this far around a tree's trunk
const SPELEO_MARK = 255;          // the twin marks speleothems with this id (no element's), so they show apart from rock
const MOUTH_DOT = 1;              // entrance map: mouths drawn this many pixels around
const SEA_GAP = 6;                // sea openings of one cave this far apart count as separate (arches)
const CLEAR_BINS = [0, 5.5, 8, 10, 12, 15, 21, 41];   // floor clearance histogram edges, cells
const CAVERN_MIN = 200;           // caverns smaller than this many cells aren't counted (slivers where a cavern grazes a tunnel)
const SLICES = [-8, -3, 4, 12, 22, 32, 42, 52];        // slice heights, cells above the water table

const CLIFF_STANDIN = { CLIFF_EXP: 0.3, CLIFF_EDGE_LO: 0.0, CLIFF_EDGE_HI: 0.3 };   // --cliffs: GEN's cliff shores, steeper and more of them

const args = process.argv.slice(2);
const cliffs = args.includes('--cliffs');
if (cliffs) Object.assign(GEN, CLIFF_STANDIN);
const [outDir = 'cave-previews', ...rest] = args.filter((a) => a !== '--cliffs');
mkdirSync(outDir, { recursive: true });
const [X0, Z0, NX, NZ] = rest.length === 4 ? rest.map(Number) : [0, 0, WORLD_SIZE[0], WORLD_SIZE[2]];
const P = worldParams({ size: WORLD_SIZE, seed: WORLD_SEED, snow: false });   // the island scene: no snow
const WATER = P.sea;

// ---- the island's twin, its caves hook's noise calls counted (one tally per
// kind) and its speleothems marked
const tally = new Float64Array(4);       // 2D value, 2D distance, 3D value, 3D distance
const KIND_NAMES = ['2D value', '2D dist', '3D value', '3D dist'];
const edit = (src, from, to) => { if (!src.includes(from)) throw new Error(`caves-preview: no "${from}" in the caves source`); return src.replace(from, to); };
let counted = caves.src.replace(/(float caveNoise2\([^)]*\) \{)/, '$1\n  caveTally(want);')
  .replace(/(float caveNoise3\([^)]*\) \{)/, '$1\n  caveTally(2 + want);');
counted = edit(counted, 'return id;   // a speleothem', 'return CAVE_SPELEO_MARK;   // a speleothem');
if (!counted.includes('caveTally(want)') || !counted.includes('caveTally(2 + want)')) throw new Error('caves-preview: could not find the noise functions to count');
const T = buildIslandTwin(P, {
  cellSrc: edit(ISLAND_CELL_SRC, caves.src, counted),
  change: { CAVE_SPELEO_MARK: SPELEO_MARK, caveTally: (k) => { tally[k]++; } },
});

// ---- PNG (8-bit RGB), from rgb rows
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(name, w, h, rgb, k = 1) {
  const W = w * k, H = h * k;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) rgb.copy(raw, y * (W * 3 + 1) + 1 + x * 3, (Math.floor(y / k) * w + Math.floor(x / k)) * 3, (Math.floor(y / k) * w + Math.floor(x / k)) * 3 + 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(join(outDir, name), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---- the heightfield: ground and slope per column (one column of margin for the slope)
const t0 = performance.now();
const HW = NX + 2;
const H = new Float64Array(HW * (NZ + 2));
for (let j = 0; j < NZ + 2; j++) for (let i = 0; i < HW; i++) H[j * HW + i] = T.column(X0 + i - 1, Z0 + j - 1)[0];
const hAt = (i, j) => H[(j + 1) * HW + i + 1];        // region-local column (i, j)
const groundOf = (i, j) => Math.floor(hAt(i, j) + 0.5);
console.log(`heightfield ${NX}×${NZ} in ${((performance.now() - t0) / 1000).toFixed(1)} s; water table ${WATER}, peak ${H.reduce((a, b) => Math.max(a, b)).toFixed(1)}`);

// ---- the volume: element per cell, and which cells the caves carved
const col = (i, j) => (j * NX + i) * NY;
const vol = new Uint8Array(NX * NY * NZ);
const carved = new Uint8Array(NX * NY * NZ);   // CARVED, CRYSTAL or SPELEO where the caves changed a cell
const CARVED = 1, CRYSTAL = 2, SPELEO = 3;
const cavern = new Uint8Array(NX * NY * NZ);   // 1: carved by the caverns (cheese)

const perCell = new Map();      // noise evaluations per cell → cells
let bandCells = 0, groundCells = 0, calls = 0;
const evalTotals = new Float64Array(4);
const t1 = performance.now();
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = X0 + i, z = Z0 + j, G = groundOf(i, j), c = col(i, j);
    const top = Math.max(G, Math.ceil(T.column(x, z)[3]));   // ground, then standing water
    groundCells += Math.max(0, G);
    for (let y = 0; y < top; y++) {
      tally.fill(0);
      const out = T.islandCell(x, y, z);
      let n = 0;
      for (let k = 0; k < 4; k++) { evalTotals[k] += tally[k]; n += tally[k]; }
      if (y < G) calls++;
      if (n > 0) { bandCells++; perCell.set(n, (perCell.get(n) ?? 0) + 1); }
      vol[c + y] = out === SPELEO_MARK ? E.ROCK : out;
      if (y >= G) continue;
      if (out === E.EMPTY || out === E.WATER) {
        carved[c + y] = CARVED;
        if (T.caveCheese(x + 0.5, y + 0.5, z + 0.5, G, WATER) < 0) cavern[c + y] = 1;
      } else if (out === E.CRYSTAL) carved[c + y] = CRYSTAL;
      else if (out === SPELEO_MARK) carved[c + y] = SPELEO;
    }
  }
  if (j % 128 === 127) process.stdout.write(`  rows ${j + 1}/${NZ}\r`);
}
console.log(`caves in ${((performance.now() - t1) / 1000).toFixed(1)} s`);

// ---- census helpers
const at = (i, y, j) => (i < 0 || j < 0 || i >= NX || j >= NZ || y < 0 || y >= NY ? -1 : col(i, j) + y);
const passable = (k) => k >= 0 && carved[k] === CARVED;
// outside: a cell above its column's ground (sky or sea), not carved
const outside = (i, y, j) => { const k = at(i, y, j); return k >= 0 && !carved[k] && y >= groundOf(i, j); };
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

let caveCells = 0, waterCells = 0, crystalCells = 0, speleoCells = 0;
for (let k = 0; k < vol.length; k++) {
  if (carved[k] === CARVED) { caveCells++; if (vol[k] === E.WATER) waterCells++; }
  else if (carved[k] === CRYSTAL) crystalCells++;
  else if (carved[k] === SPELEO) speleoCells++;
}

// ---- mouths: carved cells with an outside face neighbour
const mouthKind = new Map();   // cell index → 'hill' | 'sea' | 'shaft'
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const c = col(i, j), G = groundOf(i, j);
    for (let y = CAVE.BOTTOM; y < G; y++) {
      if (carved[c + y] !== CARVED) continue;
      let sea = false, open = false;
      for (const [dx, dy, dz] of FACES) {
        if (!outside(i + dx, y + dy, j + dz)) continue;
        open = true;
        if (groundOf(i + dx, j + dz) < WATER || y + dy < WATER) sea = true;
      }
      if (!open) continue;
      const shaft = T.caveShaft(X0 + i, Z0 + j, y + 0.5, G, WATER) < 0;
      mouthKind.set(c + y, shaft ? 'shaft' : sea ? 'sea' : 'hill');
    }
  }

// ---- components of the cave (6-connected through air and water), and what reaches a mouth
const comp = new Int32Array(vol.length).fill(-1);
const compSize = [], compMouths = [];
const queue = new Int32Array(caveCells + 1);
const decode = (k) => { const y = k % NY, c = (k - y) / NY; return [c % NX, y, Math.floor(c / NX)]; };
for (let k0 = 0; k0 < vol.length; k0++) {
  if (carved[k0] !== CARVED || comp[k0] >= 0) continue;
  const id = compSize.length;
  let head = 0, tail = 0, size = 0;
  const mouths = [];
  queue[tail++] = k0; comp[k0] = id;
  while (head < tail) {
    const k = queue[head++];
    size++;
    if (mouthKind.has(k)) mouths.push(k);
    const [i, y, j] = decode(k);
    for (const [dx, dy, dz] of FACES) {
      const n = at(i + dx, y + dy, j + dz);
      if (passable(n) && comp[n] < 0) { comp[n] = id; queue[tail++] = n; }
    }
  }
  compSize.push(size); compMouths.push(mouths);
}
const reached = compSize.reduce((s, n, c) => s + (compMouths[c].length ? n : 0), 0);
// sea openings of a component, clustered: two or more apart is a through-cave (an arch where it crosses a headland)
function seaOpenings(mouths) {
  const pts = mouths.filter((k) => mouthKind.get(k) === 'sea').map(decode);
  const seen = new Array(pts.length).fill(false);
  let clusters = 0;
  for (let a = 0; a < pts.length; a++) {
    if (seen[a]) continue;
    clusters++;
    const stack = [a]; seen[a] = true;
    while (stack.length) {
      const p = pts[stack.pop()];
      for (let b = 0; b < pts.length; b++)
        if (!seen[b] && Math.abs(pts[b][0] - p[0]) + Math.abs(pts[b][1] - p[1]) + Math.abs(pts[b][2] - p[2]) <= SEA_GAP) { seen[b] = true; stack.push(b); }
    }
  }
  return clusters;
}
let seaCaves = 0, throughCaves = 0;
const archAt = [];
compMouths.forEach((m, c) => {
  if (!m.some((k) => mouthKind.get(k) === 'sea')) return;
  seaCaves++;
  if (seaOpenings(m) >= 2) { throughCaves++; archAt.push(decode(m[0])); }
});

// ---- caverns: the cheese family's own components (6-connected), and how big they are across and up
const cavernSizes = [];   // [across, tall, cells]
{
  const seen = new Uint8Array(vol.length), q = [];
  for (let k0 = 0; k0 < vol.length; k0++) {
    if (!cavern[k0] || seen[k0]) continue;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], n = 0;
    q.length = 0; q.push(k0); seen[k0] = 1;
    while (q.length) {
      const k = q.pop(), p = decode(k);
      n++;
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
      for (const [dx, dy, dz] of FACES) {
        const m = at(p[0] + dx, p[1] + dy, p[2] + dz);
        if (m >= 0 && cavern[m] && !seen[m]) { seen[m] = 1; q.push(m); }
      }
    }
    if (n >= CAVERN_MIN) cavernSizes.push([Math.max(hi[0] - lo[0], hi[2] - lo[2]) + 1, hi[1] - lo[1] + 1, n]);
  }
}

// ---- underground lakes: cave water with cave air over it, not part of a cave open to the sea
const lakes = new Map();   // component → water surface cells
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const k = col(i, j) + WATER - 1;
    if (carved[k] !== CARVED || vol[k] !== E.WATER || carved[k + 1] !== CARVED || vol[k + 1] !== E.EMPTY) continue;
    const c = comp[k];
    if (compMouths[c].some((m) => mouthKind.get(m) === 'sea')) continue;
    lakes.set(c, (lakes.get(c) ?? 0) + 1);
  }

// ---- floor clearance: headroom over each dry cave floor cell (cave air over a solid cell), tunnels and
// caverns apart. A tunnel's height is its clearance where that is highest across it: a floor cell no
// horizontal neighbour's floor (a cell up or down) beats.
const clearAt = new Map();   // floor cell → [clearance, kind]
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const c = col(i, j), G = groundOf(i, j);
    for (let y = CAVE.BOTTOM; y < G; y++) {
      if (carved[c + y] !== CARVED || vol[c + y] !== E.EMPTY || passable(c + y - 1) || mouthKind.has(c + y)) continue;
      let top = y;
      while (top + 1 < NY && passable(c + top + 1)) top++;
      if (top + 1 >= G) continue;   // open to the sky: a mouth's trench, not a cave
      const kind = T.caveCheese(X0 + i + 0.5, y + 0.5, Z0 + j + 0.5, G, WATER) < 0 ? 'cavern' : 'tunnel';
      clearAt.set(c + y, [top - y + 1, kind]);
    }
  }
const bin = (h) => { let b = 0; while (b + 1 < CLEAR_BINS.length && h >= CLEAR_BINS[b + 1]) b++; return b; };
const clearance = {}, crests = {};
for (const kind of ['tunnel', 'cavern']) { clearance[kind] = new Array(CLEAR_BINS.length).fill(0); crests[kind] = new Array(CLEAR_BINS.length).fill(0); }
for (const [k, [h, kind]] of clearAt) {
  clearance[kind][bin(h)]++;
  const [i, y, j] = decode(k);
  let crest = true;
  for (const [dx, , dz] of FACES) {
    if (!dx && !dz) continue;
    for (let dy = -1; dy <= 1 && crest; dy++) { const n = at(i + dx, y + dy, j + dz); if (n >= 0 && (clearAt.get(n)?.[0] ?? 0) > h) crest = false; }
  }
  if (crest) crests[kind][bin(h)]++;
}

// ---- stability audit: anything loose or growing that a cave touches
const problems = {
  'powder over a void': 0, 'powder beside a void': 0, 'plant over a void': 0, 'plant touching cave water': 0,
  'cave water beside air': 0, 'standing water beside a void': 0,
};
const problemAt = {};
const flag = (what, i, y, j) => { problems[what]++; problemAt[what] ??= [X0 + i, y, Z0 + j]; };
for (let k = 0; k < NX * NZ; k++) {
  const i = k % NX, j = (k - i) / NX, c = col(i, j), G = groundOf(i, j);
  for (let y = Math.max(1, G - LAYER_DEPTH); y < G; y++) {
    const id = vol[c + y];
    if (id === E.SAND || id === E.SNOW) {
      if (carved[c + y - 1] === CARVED) flag('powder over a void', i, y, j);
      for (const [dx, , dz] of FACES) {
        if (!dx && !dz) continue;
        const side = at(i + dx, y, j + dz), below = at(i + dx, y - 1, j + dz);
        if (passable(side) || passable(below)) flag('powder beside a void', i, y, j);
      }
    }
    if (id === E.PLANT) {
      if (carved[c + y - 1] === CARVED) flag('plant over a void', i, y, j);
      for (const [dx, dy, dz] of FACES) {
        const n = at(i + dx, y + dy, j + dz);
        if (passable(n) && vol[n] === E.WATER) flag('plant touching cave water', i, y, j);
      }
    }
  }
}
for (let k = 0; k < vol.length; k++) {
  if (vol[k] !== E.WATER) continue;
  const [i, y, j] = decode(k);
  for (const [dx, dy, dz] of FACES) {
    if (dy > 0) continue;
    const n = at(i + dx, y + dy, j + dz);
    if (n < 0 || vol[n] !== E.EMPTY) continue;
    if (carved[k] === CARVED) flag('cave water beside air', i, y, j);
    else if (carved[n] === CARVED) flag('standing water beside a void', i, y, j);
  }
}
// trees: the generator's, standing within TREE_FOOT_R of an open cave (a mouth's or a shaft's cells, in a roof's depth)
let treesAtMouths = 0;
const trees = treesIn(X0, Z0, X0 + NX, Z0 + NZ, P);
for (const t of trees) {
  let hit = false;
  for (let dz = -TREE_FOOT_R; dz <= TREE_FOOT_R && !hit; dz++)
    for (let dx = -TREE_FOOT_R; dx <= TREE_FOOT_R && !hit; dx++) {
      const i = t.x - X0 + dx, j = t.z - Z0 + dz;
      if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
      const G = groundOf(i, j);
      for (let y = Math.max(0, G - CAVE.ROOF); y < G && !hit; y++) if (carved[col(i, j) + y] === CARVED) hit = true;
    }
  if (hit) treesAtMouths++;
}

// ---- images
const COLOURS = {
  sky: [214, 230, 244], sea: [52, 110, 190], rock: [120, 116, 110], sand: [220, 188, 116], plant: [70, 150, 60],
  air: [16, 14, 20], water: [70, 220, 235], crystal: [235, 60, 220], speleo: [240, 150, 40],
};
function cellColour(k, i, y, j) {
  const id = vol[k];
  if (carved[k] === CARVED) return id === E.WATER ? COLOURS.water : COLOURS.air;
  if (carved[k] === CRYSTAL) return COLOURS.crystal;
  if (carved[k] === SPELEO) return COLOURS.speleo;
  if (y >= groundOf(i, j)) return id === E.WATER ? COLOURS.sea : COLOURS.sky;
  if (id === E.SAND) return COLOURS.sand;
  if (id === E.PLANT) return COLOURS.plant;
  return COLOURS.rock;
}
const put = (buf, p, c, k = 1) => { for (let ch = 0; ch < 3; ch++) buf[p * 3 + ch] = Math.min(255, c[ch] * k); };
for (const dy of SLICES) {
  const y = WATER + dy, img = Buffer.alloc(NX * NZ * 3);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) put(img, j * NX + i, cellColour(col(i, j) + y, i, y, j));
  png(`slice-y${y}.png`, NX, NZ, img);
}
function section(name, along, fixed, from, width, k) {
  const img = Buffer.alloc(width * SECTION_TOP * 3);
  for (let s = 0; s < width; s++) {
    const i = along === 'x' ? from + s : fixed, j = along === 'x' ? fixed : from + s;
    if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
    const c = col(i, j);
    for (let y = 0; y < SECTION_TOP; y++) put(img, (SECTION_TOP - 1 - y) * width + s, cellColour(c + y, i, y, j));
  }
  png(name, width, SECTION_TOP, img, k);
}
// sections through the highest ground, along both axes, and zoomed crops at the places worth seeing
let peak = [0, 0];
for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) if (hAt(i, j) > hAt(...peak)) peak = [i, j];
section(`section-z${Z0 + peak[1]}.png`, 'x', peak[1], 0, NX, 1);
section(`section-x${X0 + peak[0]}.png`, 'z', peak[0], 0, NZ, 1);
const zoom = (label, i, j) => section(`zoom-${label}-x${X0 + i}-z${Z0 + j}.png`, 'x', j,
  Math.max(0, Math.min(NX - ZOOM_W, i - ZOOM_W / 2)), ZOOM_W, ZOOM_K);
zoom('peak', ...peak);
// a mouth of each kind: the one whose column is carved deepest (through a shaft's middle, a tunnel's)
const caveDepth = (i, j) => { let n = 0; for (let y = 0; y < NY; y++) if (carved[col(i, j) + y] === CARVED) n++; return n; };
for (const kind of ['hill', 'sea', 'shaft']) {
  let best = null, most = 0;
  for (const [k, m] of mouthKind) {
    if (m !== kind) continue;
    const [i, , j] = decode(k), n = caveDepth(i, j);
    if (n > most) { most = n; best = [i, j]; }
  }
  if (best) zoom(`${kind}-mouth`, ...best);
}
const bigLake = [...lakes].sort((a, b) => b[1] - a[1])[0];
if (bigLake) {
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = col(i, j) + WATER - 1;
    if (comp[k] === bigLake[0] && carved[k + 1] === CARVED) { zoom('lake', i, j); j = NZ; break; }
  }
}
if (archAt.length) zoom('arch', archAt[0][0], archAt[0][2]);
// entrance map: hillshade, cave footprint tint, mouths
{
  const img = Buffer.alloc(NX * NZ * 3);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const h = hAt(i, j);
      if (h < WATER) { put(img, j * NX + i, COLOURS.sea, 0.6 + 0.4 * Math.max(0, h) / WATER); continue; }
      const shade = 0.55 + 0.45 * Math.max(0, Math.min(1, 0.5 + 0.6 * ((hAt(i - 1, j) - hAt(i + 1, j)) + (hAt(i, j - 1) - hAt(i, j + 1)))));
      const c = col(i, j);
      let under = false;
      for (let y = CAVE.BOTTOM; y < groundOf(i, j) && !under; y++) under = carved[c + y] === CARVED;
      put(img, j * NX + i, under ? [150, 110, 190] : [150, 160, 120], shade * (0.6 + 0.4 * (h - WATER) / P.relief));
    }
  const MOUTH_COLOURS = { hill: [235, 40, 40], sea: [40, 235, 235], shaft: [250, 230, 40] };
  for (const [k, kind] of mouthKind) {
    const [i, , j] = decode(k);
    for (let dj = -MOUTH_DOT; dj <= MOUTH_DOT; dj++)
      for (let di = -MOUTH_DOT; di <= MOUTH_DOT; di++)
        if (i + di >= 0 && j + dj >= 0 && i + di < NX && j + dj < NZ) put(img, (j + dj) * NX + i + di, MOUTH_COLOURS[kind]);
  }
  png('entrances.png', NX, NZ, img);
}

// ---- report
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;
const kinds = { hill: 0, sea: 0, shaft: 0 };
for (const kind of mouthKind.values()) kinds[kind]++;
const mouthOpenings = (kind) => { let n = 0; compMouths.forEach((m) => { if (m.some((k) => mouthKind.get(k) === kind)) n++; }); return n; };
console.log(`\nregion ${X0},${Z0} ${NX}×${NZ}${cliffs ? ' (cliff stand-in)' : ''}: ground ${groundCells} cells, cave ${caveCells} (${pct(caveCells, groundCells)} of the ground, ${pct(caveCells, bandCells)} of the cells noise was read in), of it water ${pct(waterCells, caveCells)}`);
console.log(`crystal ${crystalCells} cells, speleothems ${speleoCells} cells`);
console.log(`components ${compSize.length}; largest ${[...compSize].sort((a, b) => b - a).slice(0, 5).join(', ')}`);
console.log(`connected to a mouth: ${pct(reached, caveCells)} of the cave volume (${compMouths.filter((m) => m.length).length} components with mouths)`);
console.log(`mouth cells: hillside ${kinds.hill}, sea ${kinds.sea}, shaft ${kinds.shaft}; caves with hillside mouths ${mouthOpenings('hill')}, sea caves ${seaCaves}, through-caves (arches) ${throughCaves}, shafts ${mouthOpenings('shaft')}`);
const quart = (a) => { const s = [...a].sort((p, q) => p - q); return s.length ? `${s[0]}, ${s[Math.floor(s.length / 4)]}, ${s[Math.floor(s.length / 2)]}, ${s[Math.floor((3 * s.length) / 4)]}, ${s[s.length - 1]}` : '-'; };
console.log(`caverns ${cavernSizes.length}: across (min, quartiles, max) ${quart(cavernSizes.map((c) => c[0]))}; tall ${quart(cavernSizes.map((c) => c[1]))}`);
console.log(`underground lakes ${lakes.size}; largest surfaces ${[...lakes.values()].sort((a, b) => b - a).slice(0, 6).join(', ')} cells`);
const hist = (counts) => { const total = counts.reduce((a, b) => a + b, 0); return `${counts.map((n, b) => `${CLEAR_BINS[b]}${b + 1 < CLEAR_BINS.length ? `–${CLEAR_BINS[b + 1]}` : '+'}: ${pct(n, total)}`).join(', ')} (${total})`; };
for (const kind of ['tunnel', 'cavern']) {
  console.log(`${kind} heights (highest clearance across): ${hist(crests[kind])}`);
  console.log(`${kind} floor clearance (dry floor cells): ${hist(clearance[kind])}`);
}
console.log(`stability: ${Object.entries(problems).map(([k, n]) => `${k} ${n}${n ? ` (e.g. ${problemAt[k]})` : ''}`).join('; ')}; trees at mouths and shafts ${treesAtMouths} of ${trees.length}`);
const evals = evalTotals.reduce((a, b) => a + b, 0);
const cells = NX * NY * NZ;
console.log(`noise evaluations: ${KIND_NAMES.map((n, k) => `${n} ${(evalTotals[k] / Math.max(1, bandCells)).toFixed(2)}`).join(', ')} per cell read (${bandCells} cells, ${pct(bandCells, cells)} of the world; islandCave ran on ${calls})`);
console.log(`  per world cell ${(evals / cells).toFixed(3)}, per ground cell ${(evals / groundCells).toFixed(3)}; most in one cell ${[...perCell.keys()].reduce((a, b) => Math.max(a, b), 0)}`);
const sortedCounts = [...perCell].sort((a, b) => a[0] - b[0]);
let acc = 0;
const quant = {};
for (const [n, c] of sortedCounts) { acc += c; for (const q of [0.5, 0.9, 0.99]) if (quant[q] === undefined && acc >= q * bandCells) quant[q] = n; }
console.log(`  per cell read: median ${quant[0.5]}, 90th percentile ${quant[0.9]}, 99th ${quant[0.99]}`);
console.log(`images in ${outDir}/`);
