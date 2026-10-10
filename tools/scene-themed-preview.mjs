// CPU previews of the themed world scenes (src/world/scenes/labWorld.js,
// volcanoWorld.js) from their JS twins: a top-down map of a region (each
// column's topmost matter, shaded by its height) and vertical cross-sections,
// as PNGs, plus a census of what the region holds. No GPU: fine on battery.
//
//   node tools/scene-themed-preview.mjs [lab|volcano] [outDir] [x0 z0 size]
// (default: both scenes, the whole world, into ./scene-previews)
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { ELEMENTS, E } from '../src/elements.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { labWorld, labTwin, LAB } from '../src/world/scenes/labWorld.js';
import { volcanoWorld, volcanoTwin, VOL } from '../src/world/scenes/volcanoWorld.js';

const SEED = 20261008;           // the default world seed (world/generator.js WORLD_SEED)
const SECTION_Y = 128;           // cross-sections show the world's whole height
const SHADE_LO = 0.45;           // map shading: the lowest column's brightness...
const SHADE_SPAN = 0.55;         // ...rising to 1 at the top of the world
const SECTIONS = 3;              // cross-sections per scene, evenly through the region

const [which = 'both', outDir = 'scene-previews', ...rest] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// PNG (8-bit RGB, no filtering), from rgb rows.
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
const VIEW_PX = 1024;             // images are blown up (nearest neighbour) toward this many pixels across
function png(path, w0, h0, rgb0) {
  const k = Math.max(1, Math.floor(VIEW_PX / w0)), w = w0 * k, h = h0 * k;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rgb0.copy(rgb, (y * w + x) * 3, (Math.floor(y / k) * w0 + Math.floor(x / k)) * 3, (Math.floor(y / k) * w0 + Math.floor(x / k)) * 3 + 3);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const colour = ELEMENTS.map((e) => { const n = parseInt(e.color.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
const SKY = [200, 225, 245];

// column(x, z): the cell function of world column (x, z), y → element id
function preview(name, column, top, region) {
  const [x0, z0, n] = region;
  const step = Math.max(1, Math.round(n / 1024));   // at most 1024 pixels a side
  const w = Math.floor(n / step);
  const map = Buffer.alloc(w * w * 3);
  const census = new Map();
  const t0 = performance.now();
  for (let j = 0; j < w; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const cell = column(x, z);
      let y = top - 1, id = E.EMPTY;
      for (; y >= 0; y--) { id = cell(y); if (id !== E.EMPTY) break; }
      census.set(id, (census.get(id) ?? 0) + 1);
      const k = SHADE_LO + SHADE_SPAN * (y + 1) / SECTION_Y;
      const c = id === E.EMPTY ? SKY : colour[id];
      for (let ch = 0; ch < 3; ch++) map[(j * w + i) * 3 + ch] = Math.min(255, c[ch] * k);
    }
  const ms = performance.now() - t0;
  png(join(outDir, `${name}-map.png`), w, w, map);
  for (let s = 0; s < SECTIONS; s++) {
    const z = z0 + Math.floor((n * (s + 0.5)) / SECTIONS);
    const sec = Buffer.alloc(w * SECTION_Y * 3);
    for (let i = 0; i < w; i++) {
      const cell = column(x0 + i * step, z);
      for (let y = 0; y < SECTION_Y; y++) {
        const id = cell(y);
        const c = id === E.EMPTY ? SKY : colour[id];
        for (let ch = 0; ch < 3; ch++) sec[((SECTION_Y - 1 - y) * w + i) * 3 + ch] = c[ch];
      }
    }
    png(join(outDir, `${name}-section-z${z}.png`), w, SECTION_Y, sec);
  }
  const tops = [...census].sort((a, b) => b[1] - a[1]).map(([id, c]) => `${ELEMENTS[id].key} ${(100 * c / (w * w)).toFixed(1)}%`);
  console.log(`${name}: map ${w}² (every ${step}) in ${(ms / 1000).toFixed(1)} s; tops: ${tops.join(', ')}`);
}

const region = rest.length === 3 ? rest.map(Number) : [0, 0, WORLD_SIZE[0]];
if (which !== 'volcano') {
  const P = labWorld.params({ size: WORLD_SIZE, seed: SEED });
  const T = labTwin(P);
  preview('lab', (x, z) => (y) => T.labCell(x, y, z), LAB.SKY, region);
  const s = labWorld.start(P, [128, 128]);
  console.log(`lab start ${s}, ground there ${labWorld.ground(...s, P)}`);
}
if (which !== 'lab') {
  const P = volcanoWorld.params({ size: WORLD_SIZE, seed: SEED });
  const T = volcanoTwin(P);
  preview('volcano', (x, z) => { const col = T.volColumn(x, z); return (y) => T.volCellIn(x, y, z, col); }, VOL.SKY, region);
  const s = volcanoWorld.start(P, [128, 128]);
  console.log(`volcano start ${s.map(Math.round)}, ground there ${volcanoWorld.ground(...s, P)}`);
}
