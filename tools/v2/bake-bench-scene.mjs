// The raster bench's scenes (bench/raster.html, docs/v2.md 11 "Week 0"): the
// box presets' real cells, built on the CPU exactly as the app builds them
// (src/presets.js, as tools/v2/crisp/faces.mjs does), baked to
// public/bench/<scene>.bin with a small element table, so the bench page can
// draw them with plain WebGPU and import nothing from src/.
//
// A .bin is gzip (the page reads it with DecompressionStream) of:
//   'TPB1'                     4 bytes
//   u32 header length          little endian
//   header                     JSON: scene, dims, cell order, element table,
//                              cell counts per class, exposed-face counts
//   cells                      run-length coded element ids, x fastest, then
//                              z, then y: a u8 id, then the run's length as
//                              an unsigned LEB128 varint
// It isn't named .gz: a server that sees .gz may send it with
// Content-Encoding: gzip, and the browser would then hand the page bytes that
// were already inflated.
//
// Element classes (the bench's whole material model): 0 air, 1 opaque,
// 2 liquid, 3 translucent (glass, ice, diamond), 4 gas, 5 emissive (opaque,
// and glows: matter whose default temperature is past 600 °C, a little above
// the Draper point where hot matter starts to glow visibly, 525 °C). Lava is a
// liquid that today's table draws opaque; v2 draws it as opaque faces too
// (docs/v2.md 3.5), so here it is emissive. The face rules are faces.mjs's:
// opaque against non-opaque; liquid against air, gas or translucent;
// translucent against air, gas or liquid. The box floor counts as opaque, the
// open sides and top as air. The header's face counts are what the page's own
// extraction must find (tools/v2/crisp/faces.txt has the same numbers).
//
// usage: node tools/v2/bake-bench-scene.mjs [--scenes lab,volcano] [--size 128] [--out public/bench] [--check]
//   --check  bakes in memory and fails if a file on disk differs (a stale bake)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SCENES = opt('scenes', 'lab,volcano').split(',');
const N = Number(opt('size', 128));
const OUT = join(ROOT, opt('out', 'public/bench'));
const CHECK = args.includes('--check');

const S = await import(pathToFileURL(join(ROOT, 'src/sim.js')));
const P = await import(pathToFileURL(join(ROOT, 'src/presets.js')));
const { ELEMENTS, R: RC, K } = await import(pathToFileURL(join(ROOT, 'src/elements.js')));

const CLASS = { AIR: 0, OPAQUE: 1, LIQUID: 2, TRANSLUCENT: 3, GAS: 4, EMISSIVE: 5 };
const GLOW_T = 600;   // °C: past the Draper point (525 °C), hot matter reads as glowing

// The pattern tiles the page draws procedurally (16×16, bench/raster/patterns.js), by name.
const PATTERNS = ['grain', 'rock', 'planks', 'plate', 'snow', 'crust', 'leaves', 'brick', 'smooth', 'grass'];
const PATTERN_BY_KEY = {
  WOOD: 'planks', PLANT: 'leaves', METAL: 'plate', SCRAP: 'plate', CLONE: 'plate', SNOW: 'snow', LAVA: 'crust',
  WALL: 'brick', ROCK: 'rock', STONE: 'rock', SANDSTONE: 'rock', CRYSTAL: 'rock',
};

function classOf(e) {
  if (!e || e.kind === K.EMPTY) return CLASS.AIR;
  if (e.render === RC.LIQUID) return CLASS.LIQUID;
  if (e.render === RC.GLASS) return CLASS.TRANSLUCENT;
  if (e.render === RC.GAS || e.render === RC.FIRE) return CLASS.GAS;
  return (e.temp ?? 20) >= GLOW_T ? CLASS.EMISSIVE : CLASS.OPAQUE;
}

// Blackbody colour of `c` °C, normalised to its brightest channel: Tanner
// Helland's fit to the CIE 1964 blackbody table (the curve the game's
// incandescence table follows).
function blackbody(c) {
  const t = (c + 273.15) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const v = [r, g, b].map((x) => Math.min(255, Math.max(0, x)) / 255);
  const m = Math.max(...v);
  return v.map((x) => +(x / m).toFixed(3));
}

function elementTable() {
  return ELEMENTS.map((e) => {
    const cls = classOf(e);
    const pattern = PATTERN_BY_KEY[e.key]
      ?? (e.kind === K.POWDER ? 'grain' : e.kind === K.SOLID ? 'rock' : 'smooth');
    const row = { key: e.key, cls, color: e.color, var: e.var ?? 0, pattern: PATTERNS.indexOf(pattern) };
    if (cls === CLASS.EMISSIVE) row.emit = blackbody(e.temp ?? 20);
    if (cls === CLASS.LIQUID || cls === CLASS.TRANSLUCENT) row.sigma = (e.sigma ?? [0, 0, 0]).map((x) => +x);
    return row;
  });
}

/** The preset's element ids, x fastest, then z, then y (tools/v2/crisp/export.mjs's order). */
function buildIds(name, nx, ny, nz) {
  const g = S.gridLayout(nx, ny, nz);
  let A = null;
  const sim = { g, cellTexel: (x, y, z) => S.cellTexel(g, x, y, z), load: (a) => { A = a; } };
  sim.blankState = S.Simulation.prototype.blankState.bind(sim);
  P.buildPreset(name, sim);
  if (!A) throw new Error(`${name}: the preset built no state`);
  const ids = new Uint8Array(nx * ny * nz);
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++)
    ids[x + nx * (z + nz * y)] = A[S.cellTexel(g, x, y, z) * 4];
  return ids;
}

/** Cells per class and exposed faces per class, by faces.mjs's rules. */
function census(ids, table, nx, ny, nz) {
  const cls = new Uint8Array(256);
  table.forEach((r, i) => { cls[i] = r.cls === CLASS.EMISSIVE ? CLASS.OPAQUE : r.cls; });
  const C = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) C[i] = cls[ids[i]];
  const get = (x, y, z) => {
    if (y < 0) return CLASS.OPAQUE;
    if (x < 0 || z < 0 || x >= nx || z >= nz || y >= ny) return CLASS.AIR;
    return C[x + nx * (z + nz * y)];
  };
  const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const cells = [0, 0, 0, 0, 0], faces = { opaque: 0, liquid: 0, glass: 0 };
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const c = C[x + nx * (z + nz * y)];
    cells[c]++;
    if (c === CLASS.AIR || c === CLASS.GAS) continue;
    for (const [dx, dy, dz] of D) {
      const o = get(x + dx, y + dy, z + dz);
      if (c === CLASS.OPAQUE && o !== CLASS.OPAQUE) faces.opaque++;
      else if (c === CLASS.LIQUID && (o === CLASS.AIR || o === CLASS.GAS || o === CLASS.TRANSLUCENT)) faces.liquid++;
      else if (c === CLASS.TRANSLUCENT && o !== CLASS.TRANSLUCENT && o !== CLASS.OPAQUE) faces.glass++;
    }
  }
  return { cells: { air: cells[0], opaque: cells[1], liquid: cells[2], translucent: cells[3], gas: cells[4] }, faces };
}

function rle(ids) {
  const out = [];
  for (let i = 0; i < ids.length;) {
    const id = ids[i];
    let n = 1;
    while (i + n < ids.length && ids[i + n] === id) n++;
    out.push(id);
    for (let v = n; ; v >>>= 7) {
      if (v < 0x80) { out.push(v); break; }
      out.push((v & 0x7f) | 0x80);
    }
    i += n;
  }
  return Uint8Array.from(out);
}

function bake(name) {
  const [nx, ny, nz] = [N, N, N];
  const ids = buildIds(name, nx, ny, nz);
  const table = elementTable();
  const counts = census(ids, table, nx, ny, nz);
  const used = [...new Set(ids)].sort((a, b) => a - b).map((i) => table[i].key);
  const header = {
    format: 'tpt3d raster bench scene', version: 1, scene: name, dims: [nx, ny, nz], order: 'x, then z, then y',
    classes: Object.keys(CLASS).map((k) => k.toLowerCase()), patterns: PATTERNS,
    elements: table, used, ...counts,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const cells = rle(ids);
  const raw = new Uint8Array(8 + json.length + cells.length);
  raw.set([0x54, 0x50, 0x42, 0x31]);   // 'TPB1'
  new DataView(raw.buffer).setUint32(4, json.length, true);
  raw.set(json, 8);
  raw.set(cells, 8 + json.length);
  return { name, bin: gzipSync(raw, { level: 9 }), raw, ids, counts, rleBytes: cells.length, used };
}

let stale = 0;
if (!CHECK) mkdirSync(OUT, { recursive: true });
for (const name of SCENES) {
  const t0 = performance.now();
  const b = bake(name);
  const file = join(OUT, `${name}.bin`);
  const f = b.counts.faces;
  console.log(`${name} ${N}³: ${b.ids.length} cells, ${b.counts.cells.opaque} opaque, ${b.counts.cells.liquid} liquid, ${b.counts.cells.translucent} translucent, ${b.counts.cells.gas} gas`);
  console.log(`  exposed faces: opaque ${f.opaque}, liquid ${f.liquid}, glass ${f.glass} (total ${f.opaque + f.liquid + f.glass})`);
  console.log(`  elements: ${b.used.join(' ')}`);
  console.log(`  bytes: ${b.ids.length} as ids, ${b.rleBytes} run-length coded, ${b.bin.length} gzipped (${file.slice(ROOT.length + 1)}) in ${(performance.now() - t0).toFixed(0)} ms`);
  if (CHECK) {
    // compare what the file holds, not its gzip framing (zlib's output can differ between versions)
    const same = existsSync(file) && Buffer.compare(gunzipSync(readFileSync(file)), Buffer.from(b.raw)) === 0;
    if (!same) stale++;
    console.log(`  ${same ? 'ok: the file on disk is this bake' : 'STALE: the file on disk differs; rerun without --check'}`);
  } else writeFileSync(file, b.bin);
}
if (stale) process.exit(1);
