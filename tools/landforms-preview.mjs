// CPU previews of the island's landforms and strata (src/world/island/
// landforms.js, strata.js) from the island's JS twin (world/generator.js
// islandTwin: the cells the GPU makes, but for trees): a shaded top-down map of
// the whole island, close-ups of each landform, and cross-sections through
// each one with the rock coloured by stratum, as PNGs, plus the stability
// checks the landforms promise. No GPU: fine on battery.
//
//   node tools/landforms-preview.mjs [outDir] [seed]
// (default: ./landform-previews, the default world seed)
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { ELEMENTS, E } from '../src/elements.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { worldParams, islandTwin, GEN_INT, TREE } from '../src/world/generator.js';
import { LANDFORMS as LF } from '../src/world/island/landforms.js';
import { STRATA_UNITS, STRATA_ELEMENTS } from '../src/world/island/strata.js';

const [outDir = 'landform-previews', seedArg] = process.argv.slice(2);
const SEED = seedArg ? Number(seedArg) : 20261008;   // world/generator.js WORLD_SEED
mkdirSync(outDir, { recursive: true });

const VIEW_PX = 1024;            // images are blown up (nearest neighbour) toward this many pixels across
const CLOSE_MARGIN = 24;         // cells around a landform's reach in its close-up
const SECTION_PAD_LO = 6;        // cells shown below a section's lowest ground...
const SECTION_PAD_HI = 10;       // ...and above its highest
const SUN = [-0.5, 0.75, -0.43]; // map hillshade: light from the north-west, 50° up (x, y, z; normalised below)
const SHADE_AMBIENT = 0.45;      // the shade's floor
const DEEP = 12;                 // cells of water at which it is drawn darkest
const RIA_SECTIONS = [0.15, 0.5, 0.85];   // across the ria at these shares of its length
const RIA_ALONG_PAD = 30;        // cells before its mouth and past its head in the section along it
const WALK = 1.0;                // cells per cell: the steepest slope counted as walkable in the report
const CHANGED = 0.5;             // cells: ground counts as changed by a landform past this
const BAND_IN = 2;               // cells inside a band's edges where its slopes are read (a slope reads two columns)

// ---------------------------------------------------------------- PNG
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
// 8-bit RGB rows rgb0 (w0 × h0), blown up by a whole factor toward VIEW_PX across
function png(name, w0, h0, rgb0) {
  const k = Math.max(1, Math.floor(VIEW_PX / w0)), w = w0 * k, h = h0 * k;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rgb0.copy(raw, y * (w * 3 + 1) + 1 + x * 3, (Math.floor(y / k) * w0 + Math.floor(x / k)) * 3, (Math.floor(y / k) * w0 + Math.floor(x / k)) * 3 + 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(join(outDir, `${name}.png`), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const hex = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const element = (id) => hex(ELEMENTS[id].color);
// rock by stratum (the basement is ROCK, which other things are too)
const UNIT_COLOURS = STRATA_UNITS.map((u) => element(STRATA_ELEMENTS[u]));
const ROCKS = new Set(Object.values(STRATA_ELEMENTS));
const SKY = [200, 225, 245];
const WATER_SHALLOW = [110, 175, 230], WATER_DEEP = [22, 70, 150];

// ---------------------------------------------------------------- the world
const t0 = performance.now();
const P = worldParams({ size: WORLD_SIZE, seed: SEED, snow: false });   // the island scene's (scenes/island.js)
const S = P.landforms, T = islandTwin(P);
const [NX, NY, NZ] = P.size;
const at = (x, z) => z * NX + x;
const H = new Float32Array(NX * NZ), G = new Float32Array(NX * NZ), W = new Float32Array(NX * NZ);
const top = new Int16Array(NX * NZ), cover = new Uint8Array(NX * NZ);
for (let z = 0; z < NZ; z++)
  for (let x = 0; x < NX; x++) {
    const i = at(x, z), c = T.column(x, z);
    H[i] = T.genHeight(x, z);
    G[i] = c[0];
    W[i] = c[3];
    top[i] = T.genTop(x, z);
    cover[i] = T.genCover(x, z);
  }
const tGrid = performance.now();
const clampX = (x) => Math.min(NX - 1, Math.max(0, x)), clampZ = (z) => Math.min(NZ - 1, Math.max(0, z));
const ground = (x, z) => top[at(clampX(x), clampZ(z))];
const level = (x, z) => W[at(clampX(x), clampZ(z))];
const slopeAt = (x, z) => 0.5 * Math.hypot(G[at(clampX(x + 1), z)] - G[at(clampX(x - 1), z)], G[at(x, clampZ(z + 1))] - G[at(x, clampZ(z - 1))]);

// The colour of cell (x, y, z) as the twin makes it, its rock by stratum.
function cellRGB(x, y, z) {
  const id = T.islandCell(x, y, z);
  if (id === E.EMPTY) return SKY;
  if (id === E.WATER) return WATER_SHALLOW;
  if (ROCKS.has(id)) return UNIT_COLOURS[T.stUnit(x + 0.5, y + 0.5, z + 0.5)];
  return element(id);
}

// ---------------------------------------------------------------- map and close-ups
const sunLen = Math.hypot(...SUN), sun = SUN.map((v) => v / sunLen);
function surfaceRGB(x, z) {
  const g = ground(x, z), lv = level(x, z);
  if (g < lv) {
    const t = Math.min(1, (lv - g) / DEEP);
    return WATER_SHALLOW.map((c, k) => c + (WATER_DEEP[k] - c) * t);
  }
  const base = cellRGB(x, g - 1, z);
  // Lambert on the ground's normal (-dG/dx, 1, -dG/dz)
  const gx = 0.5 * (ground(x + 1, z) - ground(x - 1, z)), gz = 0.5 * (ground(x, z + 1) - ground(x, z - 1));
  const lambert = Math.max(0, (-gx * sun[0] + sun[1] - gz * sun[2]) / Math.hypot(gx, 1, gz));
  return base.map((c) => Math.min(255, c * (SHADE_AMBIENT + (1 - SHADE_AMBIENT) * lambert)));
}
function mapImage(name, x0, z0, w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + i, z = z0 + j;
      const c = x < 0 || z < 0 || x >= NX || z >= NZ ? SKY : surfaceRGB(x, z);
      for (let k = 0; k < 3; k++) rgb[(j * w + i) * 3 + k] = c[k];
    }
  png(name, w, h, rgb);
}
const closeUp = (name, cx, cz, half) => {
  const r = Math.ceil(half + CLOSE_MARGIN);
  mapImage(name, Math.round(cx) - r, Math.round(cz) - r, 2 * r, 2 * r);
};

// ---------------------------------------------------------------- sections
// A vertical section through the columns at points [[x, z], ...], cropped to
// the heights where something is.
function section(name, points) {
  const cols = points.map(([x, z]) => [Math.floor(x), Math.floor(z)]).filter(([x, z]) => x >= 0 && z >= 0 && x < NX && z < NZ);
  let lo = NY, hi = 0;
  for (const [x, z] of cols) { lo = Math.min(lo, ground(x, z)); hi = Math.max(hi, ground(x, z), Math.ceil(level(x, z))); }
  lo = Math.max(0, lo - SECTION_PAD_LO); hi = Math.min(NY, hi + SECTION_PAD_HI);
  const w = cols.length, h = hi - lo;
  const rgb = Buffer.alloc(w * h * 3);
  cols.forEach(([x, z], i) => {
    for (let y = lo; y < hi; y++) {
      const c = cellRGB(x, y, z);
      for (let k = 0; k < 3; k++) rgb[((hi - 1 - y) * w + i) * 3 + k] = c[k];
    }
  });
  png(name, w, h, rgb);
}
const line = (x0, z0, x1, z1) => {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0));
  return Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
};

mapImage('island-map', 0, 0, NX, NZ);
const files = ['island-map'];
if (S.ria) {
  const r = S.ria, ex = r.x + r.dx * r.len, ez = r.z + r.dz * r.len;
  const half = Math.hypot(ex - r.x, ez - r.z) / 2 + LF.MEANDER_AMP + LF.RIA_MOUTH_HALF;
  closeUp('ria', (r.x + ex) / 2, (r.z + ez) / 2, half);
  // the centreline's point at u along the axis (sites are column centres)
  const centre = (u) => { const m = T.lfMeander(u); return [r.x + r.dx * u - r.dz * m, r.z + r.dz * u + r.dx * m]; };
  for (const f of RIA_SECTIONS) {
    const [cx, cz] = centre(f * r.len), w = LF.RIA_GORGE_HALF + LF.RIA_MOUTH_HALF + 3 * LF.MEANDER_AMP;
    section(`ria-across-${Math.round(f * 100)}`, line(cx + r.dz * w, cz - r.dx * w, cx - r.dz * w, cz + r.dx * w));
    files.push(`ria-across-${Math.round(f * 100)}`);
  }
  const along = [];
  for (let u = -RIA_ALONG_PAD; u < r.len + RIA_ALONG_PAD; u++) {
    const [cx, cz] = centre(Math.min(u, r.len)), past = Math.max(0, u - r.len);
    along.push([cx + r.dx * past, cz + r.dz * past]);
  }
  section('ria-along', along);
  files.push('ria', 'ria-along');
}
if (S.mesa) {
  const m = S.mesa;
  closeUp('mesa', m.x, m.z, m.r);
  section('mesa-x', line(m.x - m.r - CLOSE_MARGIN, m.z, m.x + m.r + CLOSE_MARGIN, m.z));
  section('mesa-z', line(m.x, m.z - m.r - CLOSE_MARGIN, m.x, m.z + m.r + CLOSE_MARGIN));
  files.push('mesa', 'mesa-x', 'mesa-z');
}
S.lakes.forEach((l, i) => {
  const reach = l.r + LF.LAKE_REACH;
  closeUp(`tarn-${i}`, l.x, l.z, reach);
  section(`tarn-${i}-x`, line(l.x - reach - CLOSE_MARGIN, l.z, l.x + reach + CLOSE_MARGIN, l.z));
  section(`tarn-${i}-z`, line(l.x, l.z - reach - CLOSE_MARGIN, l.x, l.z + reach + CLOSE_MARGIN));
  files.push(`tarn-${i}`, `tarn-${i}-x`, `tarn-${i}-z`);
});
S.stacks.forEach((s, i) => {
  closeUp(`stack-${i}`, s.x, s.z, s.r + LF.STACK_REACH);
  // along the ray from the island's centre: from the land behind it out to sea
  const dx = s.x - P.center[0], dz = s.z - P.center[1], d = Math.hypot(dx, dz), ux = dx / d, uz = dz / d;
  const back = 3 * (s.r + LF.STACK_REACH), on = s.r + LF.STACK_REACH + CLOSE_MARGIN;
  section(`stack-${i}-section`, line(s.x - ux * back, s.z - uz * back, s.x + ux * on, s.z + uz * on));
  files.push(`stack-${i}`, `stack-${i}-section`);
});
const tImages = performance.now();

// ---------------------------------------------------------------- checks
// on the gorge's walls: carved by the ria, standing past its floor's edge
const onWall = (x, z) => {
  const r = S.ria, cx = x + LF.CENTRE, cz = z + LF.CENTRE, h = H[at(x, z)];
  if (!r || T.lfRia(cx, cz, h) >= h - CHANGED) return false;
  const u = (cx - r.x) * r.dx + (cz - r.z) * r.dz, v = (cz - r.z) * r.dx - (cx - r.x) * r.dz;
  return T.lfRiaDist(u, v) > T.lfRiaHalf(Math.min(u, r.len)) + LF.RIA_ROUGH;
};
const inTarn = (x, z) => S.lakes.some((l, i) => T.lfLakeDist(i, x + LF.CENTRE, z + LF.CENTRE) < l.r + LF.LAKE_RIM);
const C = { SAND: 1, PLANT: 3 };   // generator.js GEN_CODE's covers
let leaks = 0, plantsWet = 0, sandUnstable = 0, water = 0, tarnWater = 0, wallTrees = 0, tarnTrees = 0, tarnPlants = 0;
for (let z = 1; z < NZ - 1; z++)
  for (let x = 1; x < NX - 1; x++) {
    const g = ground(x, z), lv = level(x, z), i = at(x, z);
    if (g < lv) {
      water++;
      if (lv > P.sea) tarnWater++;
      // water at its surface (y = lv - 1) escapes to a neighbour whose ground and water are both lower
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && ground(x + dx, z + dz) < lv && level(x + dx, z + dz) < lv) leaks++;
    }
    if (cover[i] === C.PLANT) {
      // the plant cell (y = g - 1) touches water in a face neighbour
      const y = g - 1;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (ground(x + dx, z + dz) <= y && y < level(x + dx, z + dz)) plantsWet++;
      if (inTarn(x, z) && g < lv) tarnPlants++;
    }
    if (cover[i] === C.SAND) {
      let drop = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) drop = Math.max(drop, g - ground(x + dx, z + dz));
      if (drop > GEN_INT.POWDER_STEP_MAX) sandUnstable++;
    }
    // trees: generator.js genTreeZone, the GPU's and treesIn's ground check
    if ((onWall(x, z) || (inTarn(x, z) && g - lv < TREE.ABOVE_SEA)) && T.genTreeZone(x, z) !== 0) {
      if (onWall(x, z)) wallTrees++; else tarnTrees++;
    }
  }
// walkability: the steepest ground of each landform's walkable parts, where it changed the ground
const steepest = (pred) => {
  let m = 0;
  for (let z = 1; z < NZ - 1; z++)
    for (let x = 1; x < NX - 1; x++) {
      const i = at(x, z);
      if (Math.abs(G[i] - H[i]) > CHANGED && pred(x + LF.CENTRE, z + LF.CENTRE, x, z)) m = Math.max(m, slopeAt(x, z));
    }
  return m;
};
const walk = (m) => `${m.toFixed(2)}${m > WALK ? ' (NOT walkable)' : ''}`;
const report = [];
S.lakes.forEach((l, i) => {
  const shore = steepest((cx, cz, x, z) => {
    const d = T.lfLakeDist(i, cx, cz) - l.r;
    return d >= BAND_IN && d < LF.LAKE_SHORE_W - BAND_IN && ground(x, z) <= l.level + LF.LAKE_FREEBOARD + LF.LAKE_SHORE * LF.LAKE_SHORE_W;
  });
  report.push(`tarn ${i}: level ${l.level} (${l.level - P.sea} cells above the sea), radius ${l.r}, steepest carved shore ${walk(shore)}`);
});
if (S.ria) {
  const r = S.ria;
  const floorSlope = steepest((cx, cz, x, z) => {
    const u = (cx - r.x) * r.dx + (cz - r.z) * r.dz, v = (cz - r.z) * r.dx - (cx - r.x) * r.dz;
    return u > 0 && u < r.len && T.lfRiaDist(u, v) < T.lfRiaHalf(u) - LF.RIA_ROUGH - BAND_IN && ground(x, z) >= P.sea;
  });
  report.push(`ria: mouth (${r.x.toFixed(0)}, ${r.z.toFixed(0)}), length ${r.len}, drowned ${r.drown.toFixed(0)}, steepest dry floor ${walk(floorSlope)}`);
}
if (S.mesa) report.push(`mesa: centre (${S.mesa.x}, ${S.mesa.z}), radius ${S.mesa.r}`);
report.push(`stacks: ${S.stacks.map((s) => `(${s.x.toFixed(0)}, ${s.z.toFixed(0)}) r ${s.r} top +${s.top - P.sea}`).join(', ')}`);
console.log(`seed ${SEED}: columns ${((tGrid - t0) / 1000).toFixed(1)} s, images ${((tImages - tGrid) / 1000).toFixed(1)} s`);
console.log(report.join('\n'));
console.log(`checks: water columns ${water} (tarns ${tarnWater}); leaks ${leaks}; plants touching water ${plantsWet}; `
  + `plant cover under tarns ${tarnPlants}; sand off its repose ${sandUnstable}; tree ground on gorge walls ${wallTrees}, in or by tarns ${tarnTrees}`);
console.log(`wrote ${files.length} images to ${outDir}/`);
