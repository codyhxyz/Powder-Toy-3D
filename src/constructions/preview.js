import { ELEMENTS, R } from '../elements.js';
import { turnCells } from './runtime.js';

// CPU preview: an isometric picture of a construction, with no GPU and no DOM.
// Coding agents get it as a PNG from the CLI and models get it as an image in
// their tool results, so both can look at what their code built.
//
// The view looks down from the front-right: +x runs right-down, +z left-down,
// +y up. Cubes are painted far to near (by x + y + z) from one pre-cut sprite.

const MAX_IMAGE_PX = 640;        // longest side of the picture
const MAX_VOXEL_PX = 16;         // cap on the cube's half-width, in pixels
const MIN_VOXEL_PX = 2;
const MARGIN_PX = 12;
const SHADE = [0, 1, 0.8, 0.62]; // per face: none, top, front-left (+z), right (+x)
const SEE_THROUGH_ALPHA = 0.45;  // glass, liquids and gases
const TEXTURE = 0.14;            // per-cell brightness variation, like the sim's colour noise
const BACKGROUND = [22, 26, 35, 255];

export const PREVIEW_VIEWS = [0, 2]; // quarter turns models and agents look from: front-right, back-left

// #rrggbb → [r, g, b] bytes
export const hexBytes = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// A stable per-cell value in [0, 1] for colour texture, so neighbouring cubes differ a little.
export const cellNoise = (x, y, z) => (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 255) / 255;

const COLORS = ELEMENTS.map((e) => hexBytes(e.color));
const seeThrough = (id) => [R.GLASS, R.LIQUID, R.GAS].includes(ELEMENTS[id].render);

// Face label (0 none, 1 top, 2 front-left, 3 right) per pixel of a cube whose
// top-back corner sits at the sprite's top-centre. The cube is 2s wide, 2s tall.
function cubeSprite(s) {
  const sprite = new Uint8Array(4 * s * s);
  for (let py = 0; py < 2 * s; py++)
    for (let px = 0; px < 2 * s; px++) {
      const dx = px + 0.5 - s, dy = py + 0.5;
      let f = 0;
      if (Math.abs(dx) / s + Math.abs(dy - s / 2) / (s / 2) <= 1) f = 1;
      else if (dx <= 0 && dx >= -s) { const t = s / 2 + (dx + s) / 2; if (dy >= t && dy <= t + s) f = 2; }
      else if (dx > 0 && dx <= s) { const t = s - dx / 2; if (dy >= t && dy <= t + s) f = 3; }
      sprite[py * 2 * s + px] = f;
    }
  return sprite;
}

// Indices of the cubes worth drawing (some visible face not covered by an
// opaque neighbour), sorted far to near.
function visibleCubes(cells, { X, Z, min, max }) {
  const [x0, , z0] = min;
  const w = max[0] - x0 + 1, h = max[1] + 1, d = max[2] - z0 + 1;
  const occ = new Int16Array(w * h * d).fill(-1);
  const at = (x, y, z) => (z * h + y) * w + x;
  for (let i = 0; i < cells.n; i++) occ[at(X[i] - x0, cells.y[i], Z[i] - z0)] = cells.id[i];
  const covers = (x, y, z) => {
    if (x >= w || y >= h || z >= d) return false;
    const id = occ[at(x, y, z)];
    return id > 0 && !seeThrough(id);
  };
  const order = [];
  for (let i = 0; i < cells.n; i++) {
    const id = cells.id[i];
    if (id === 0 || ELEMENTS[id].render === R.NONE) continue;
    const x = X[i] - x0, y = cells.y[i], z = Z[i] - z0;
    if (!(covers(x + 1, y, z) && covers(x, y + 1, z) && covers(x, y, z + 1))) order.push(i);
  }
  const Y = cells.y;
  return order.sort((a, b) => (X[a] + Y[a] + Z[a]) - (X[b] + Y[b] + Z[b]) || Y[a] - Y[b]);
}

// cells → { width, height, data: RGBA bytes }. `quarter` turns the model first,
// so quarter 2 shows the back.
export function renderIso(cells, { quarter = 0, maxPx = MAX_IMAGE_PX } = {}) {
  const t = turnCells(cells, quarter);
  const { X, Z } = t, Y = cells.y;
  const [x0, , z0] = t.min, [x1, y1, z1] = t.max;
  const w = x1 - x0 + 1, h = y1 + 1, d = z1 - z0 + 1;

  // cube size: fit the longest side into maxPx, keep it even so s/2 is whole
  let s = Math.floor(Math.min(maxPx / (w + d), maxPx / ((w + d) / 2 + h + 1)));
  s = Math.max(MIN_VOXEL_PX, Math.min(MAX_VOXEL_PX, s)) & ~1;
  const sprite = cubeSprite(s);
  const sx = (x, z) => (x - z) * s;
  const sy = (x, y, z) => ((x + z) * s) / 2 - (y + 1) * s;
  const left = sx(x0, z1) - s - MARGIN_PX, top = sy(x0, y1, z0) - MARGIN_PX;
  const width = sx(x1, z0) + s + MARGIN_PX - left;
  const height = sy(x1, 0, z1) + 2 * s + MARGIN_PX - top; // the nearest cube's bottom corner

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(BACKGROUND, i);
  for (const i of visibleCubes(cells, t)) {
    const id = cells.id[i], c = COLORS[id];
    const alpha = seeThrough(id) ? SEE_THROUGH_ALPHA : 1;
    const k = 1 - TEXTURE / 2 + TEXTURE * cellNoise(X[i], Y[i], Z[i]);
    const ox = sx(X[i], Z[i]) - s - left, oy = sy(X[i], Y[i], Z[i]) - top;
    for (let py = 0; py < 2 * s; py++) {
      const row = (oy + py) * width;
      for (let px = 0; px < 2 * s; px++) {
        const f = sprite[py * 2 * s + px];
        if (!f) continue;
        const o = (row + ox + px) * 4, l = SHADE[f] * k;
        for (let ch = 0; ch < 3; ch++) data[o + ch] = data[o + ch] * (1 - alpha) + c[ch] * l * alpha;
      }
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- PNG

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Encode RGBA as PNG. `deflate` is zlib deflate (node:zlib's deflateSync in Node).
export function encodePNG({ width, height, data }, deflate) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflate(raw))), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}
