// Draws a tile's box in the dock's flat style: each cell takes its element's
// colour and the tile textures (powder specks, the liquid's surface highlight,
// the solid sheen, soft gas puffs) are applied per cell. Anything hot glows with
// the game's incandescence table, anything luminous with its own light
// (gfx/materials.js emit). Styling is per kind, never per element.
import { ELEMENTS, E, K } from '../../elements.js';
import { INCAND, INCAND_TABLE } from '../../gfx/incandescence.js';
import { LOOK as MATERIAL, SPARK_GLOW } from '../../gfx/materials.js';
import { isLive } from '../../electricity.js';
import { KIND } from './engine.js';
import { TILE, CELL, COLS, ROWS, GAS_FILL } from './scenes.js';

export const LOOK = {
  TEXTURE_ALPHA: 0.55,      // strength of the tile textures (the old CSS ::before opacity)
  TONE_LEVELS: 5,           // per-grain brightness steps, picked by the cell's seed
  TONE_SPREAD: 0.2,         // brightness spread per unit of the element's var
  SPECKS: [                 // powder dots, in SPECKS order: tint, strength
    { rgb: [0, 0, 0], alpha: 0.22 },
    { rgb: [255, 255, 255], alpha: 0.25 },
    { rgb: [0, 0, 0], alpha: 0.18 },
  ],
  AIR_RGB: [22, 26, 35],    // --panel-solid: air inside a box is the panel showing through
  AIR_MIX: 0.35,            // ...tinted by the box's material
  BANDS: [                  // liquid highlight, px below the local surface
    { from: 0, to: 2, alpha: 0.32 },
    { from: 2, to: TILE * 0.3, alpha: 0.08 },
  ],
  SHADE_FROM: 0.72,         // liquid bottom shade starts at this share of the tile
  SHADE_ALPHA: 0.16,
  SHEEN: { LIGHT: 0.18, MID: 0.45, DARK: 0.14 },
  GAS_ALPHA: 0.35,          // white at the densest part of a puff
  GAS_BLUR: 2,              // 3×3 blur passes over the gas cells
  LIGHT_LUMA: 0.6,          // pale gases also get a shaded underside
  SHADOW_RGB: [70, 84, 110],
  SHADOW_ALPHA: 0.5,        // at rest, as faint as the flat tile texture...
  SHADOW_ALPHA_LIVE: 2.5,   // ...and stronger while running, so the moving puffs show
  SHADOW_DROP: 1.5,         // px
  SMOKE_ALPHA: 0.6,         // smoke drifting through another element's tile
  GLOW_EXPOSURE: 6,         // the dock's "eye adaptation" for incandescence
  GLOW_BLUR: 0,             // hot solids glow cell by cell
  FLAME_BLUR: 1,            // flames are soft blobs, as in the game's renderer
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export function luminance(hex) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// per element: tone ramp, and speck variants for powders
const PAL = ELEMENTS.map((e) => {
  const base = hexToRgb(e.color), L = LOOK.TONE_LEVELS;
  const tones = [];
  for (let k = 0; k < L; k++) {
    const s = ((k / (L - 1)) * 2 - 1) * (e.var || 0) * LOOK.TONE_SPREAD;
    tones.push(s >= 0 ? mix(base, [255, 255, 255], s) : mix(base, [0, 0, 0], -s));
  }
  return {
    base,
    tones: tones.map((c) => css(c)),
    specks: LOOK.SPECKS.map((sp) => tones.map((c) => css(mix(c, sp.rgb, sp.alpha * LOOK.TEXTURE_ALPHA)))),
  };
});

// luminescence (gfx/materials.js emit) at the dock's exposure, scaled down to
// fit rather than clipped per channel, so its hue survives
const LUMIN = MATERIAL.map((m) => {
  const e = m.emit.map((v) => v * LOOK.GLOW_EXPOSURE);
  return e.map((v) => v / Math.max(1, ...e));
});
// a live conductor's spark (gfx/materials.js sparkEmit), the same way
const SPARK_LUMIN = (() => {
  const e = SPARK_GLOW.map((v) => v * LOOK.GLOW_EXPOSURE);
  return e.map((v) => v / Math.max(1, ...e));
})();
// What a cell at tC gives off, scaled for the dock: incandescence
// (gfx/incandescence.js) and luminescence, as emission() has them in the game,
// and a spark if it is live (ctype: its ctype).
function glow(id, tC, out, ctype = 0) {
  out.fill(0);
  const x = (tC - INCAND.T0) / INCAND.STEP;
  if (x > 0) {
    const xc = Math.min(x, INCAND.N - 1), i = Math.min(xc | 0, INCAND.N - 2), u = xc - i;
    const a = INCAND_TABLE[i], b = INCAND_TABLE[i + 1];
    const lum = 2 ** (a[3] + (b[3] - a[3]) * u) * LOOK.GLOW_EXPOSURE;
    for (let c = 0; c < 3; c++) out[c] = (a[c] + (b[c] - a[c]) * u) * lum;
  }
  for (let c = 0; c < 3; c++) out[c] += LUMIN[id][c];
  if (isLive(id, ctype)) for (let c = 0; c < 3; c++) out[c] += SPARK_LUMIN[c];
  return out[0] + out[1] + out[2] > 1 / 255;
}

// small offscreen grids for the soft layers
const OFF = document.createElement('canvas');
OFF.width = COLS; OFF.height = ROWS;
const OFFX = OFF.getContext('2d');
const IMG = OFFX.createImageData(COLS, ROWS);
const N = COLS * ROWS;
const LAYER = [new Float32Array(N * 4), new Float32Array(N * 4)];
function blur(src, passes) {
  let a = src, b = LAYER[1];
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        for (let c = 0; c < 4; c++) {
          let s = 0, w = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
              const k = (dx ? 1 : 2) * (dy ? 1 : 2); // 1-2-1 kernel
              s += a[(yy * COLS + xx) * 4 + c] * k; w += k;
            }
          b[(y * COLS + x) * 4 + c] = s / w;
        }
    [a, b] = [b, a];
  }
  return a;
}
// premultiplied float layer → canvas, scaled up smoothly
function blit(ctx, layer, op, dy = 0) {
  const d = IMG.data;
  for (let i = 0; i < N; i++) {
    const al = clamp01(layer[i * 4 + 3]);
    const k = al > 0 ? 255 / al : 0;
    d[i * 4] = Math.min(255, layer[i * 4] * k);
    d[i * 4 + 1] = Math.min(255, layer[i * 4 + 1] * k);
    d[i * 4 + 2] = Math.min(255, layer[i * 4 + 2] * k);
    d[i * 4 + 3] = al * 255;
  }
  OFFX.putImageData(IMG, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(OFF, 0, dy, TILE, TILE);
  ctx.restore();
}

// The engine's liquids are cells; the game draws them as a smooth surface, and so
// does the tile: occupancy is blurred, interpolated per pixel and thresholded.
const LIQ = {
  RES: 4,        // offscreen pixels per cell
  ISO: 0.5,      // surface level of the blurred occupancy
  EDGE: 0.12,    // half-width of the anti-aliased edge, in occupancy units
  BLUR: 1,
};
const LW = COLS * LIQ.RES, LH = ROWS * LIQ.RES;
const LCV = document.createElement('canvas');
LCV.width = LW; LCV.height = LH;
const LCX = LCV.getContext('2d');
const LIMG = LCX.createImageData(LW, LH);
const OCC = new Float32Array(N * 4);
function drawLiquid(ctx, scene, at) {
  const { world: w, item } = scene, base = PAL[item.id].base, TA = LOOK.TEXTURE_ALPHA;
  OCC.fill(0);
  for (let r = 0; r < ROWS; r++) for (let x = 0; x < COLS; x++) if (w.id[at(x, r)] === item.id) OCC[(r * COLS + x) * 4 + 3] = 1;
  const F = blur(OCC, LIQ.BLUR);
  const f = (cx, cy) => F[(Math.min(ROWS - 1, Math.max(0, cy)) * COLS + Math.min(COLS - 1, Math.max(0, cx))) * 4 + 3];
  const d = LIMG.data, pxPerTile = LW / TILE;
  for (let px = 0; px < LW; px++) {
    let surfY = -1, was = false;
    const u = (px + 0.5) / LIQ.RES - 0.5, x0 = Math.floor(u), fx = u - x0;
    for (let py = 0; py < LH; py++) {
      const v = (py + 0.5) / LIQ.RES - 0.5, y0 = Math.floor(v), fy = v - y0;
      const val = (f(x0, y0) * (1 - fx) + f(x0 + 1, y0) * fx) * (1 - fy) + (f(x0, y0 + 1) * (1 - fx) + f(x0 + 1, y0 + 1) * fx) * fy;
      const cov = clamp01((val - LIQ.ISO + LIQ.EDGE) / (2 * LIQ.EDGE));
      const inside = val > LIQ.ISO;
      if (inside && !was) surfY = py;
      was = inside;
      const o = (py * LW + px) * 4;
      if (cov <= 0) { d[o + 3] = 0; continue; }
      const depth = (py - Math.max(0, surfY)) / pxPerTile, ty = (py + 0.5) / pxPerTile;
      let wa = 0;
      for (const b of LOOK.BANDS) if (depth >= b.from && depth < b.to) wa = b.alpha;
      const sh = clamp01((ty / TILE - LOOK.SHADE_FROM) / (1 - LOOK.SHADE_FROM)) * LOOK.SHADE_ALPHA;
      for (let c = 0; c < 3; c++) d[o + c] = (base[c] + (255 - base[c]) * wa * TA) * (1 - sh * TA);
      d[o + 3] = cov * 255;
    }
  }
  LCX.putImageData(LIMG, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(LCV, 0, 0, TILE, TILE);
  ctx.restore();
}

export function drawScene(ctx, scene, activity = 0) {
  const { world: w, y0, item } = scene;
  const pal = PAL[item.id], base = pal.base;
  const TA = LOOK.TEXTURE_ALPHA;
  const at = (x, r) => w.idx(x, y0 + (ROWS - 1 - r));

  ctx.fillStyle = scene.gas ? item.color : css(mix(base, LOOK.AIR_RGB, LOOK.AIR_MIX));
  ctx.fillRect(0, 0, TILE, TILE);

  // cells
  const surf = new Int8Array(COLS).fill(-1);  // top of the liquid body in each column
  const smooth = item.kind === K.LIQUID;       // the tile's own liquid gets a smooth surface
  for (let r = 0; r < ROWS; r++)
    for (let x = 0; x < COLS; x++) {
      const i = at(x, r), id = w.id[i], k = KIND[id];
      if (id === E.EMPTY || k === K.GAS || (smooth && id === item.id)) continue;
      if (k === K.LIQUID && (r === 0 || KIND[w.id[at(x, r - 1)]] !== K.LIQUID)) surf[x] = r; // top of this body of liquid
      const tone = (w.seed[i] * LOOK.TONE_LEVELS) | 0, mark = w.mark[i];
      ctx.fillStyle = k === K.POWDER && mark ? PAL[id].specks[mark - 1][tone] : PAL[id].tones[tone];
      ctx.fillRect(x * CELL, r * CELL, CELL, CELL);
      if (k === K.LIQUID) {
        const depth = (r - surf[x]) * CELL;
        let a = 0;
        for (const b of LOOK.BANDS) a += b.alpha * clamp01((Math.min(b.to, depth + CELL) - Math.max(b.from, depth)) / CELL);
        if (a > 0) { ctx.fillStyle = css([255, 255, 255], a * TA); ctx.fillRect(x * CELL, r * CELL, CELL, CELL); }
        const shade = clamp01(((r + 0.5) * CELL / TILE - LOOK.SHADE_FROM) / (1 - LOOK.SHADE_FROM)) * LOOK.SHADE_ALPHA;
        if (shade > 0) { ctx.fillStyle = css([0, 0, 0], shade * TA); ctx.fillRect(x * CELL, r * CELL, CELL, CELL); }
      }
    }

  if (smooth) drawLiquid(ctx, scene, at);

  // the 135° sheen across a solid tile
  if (item.kind === K.SOLID) {
    const S = LOOK.SHEEN, g = ctx.createLinearGradient(0, 0, TILE, TILE);
    g.addColorStop(0, css([255, 255, 255], S.LIGHT * TA));
    g.addColorStop(S.MID, css([255, 255, 255], 0));
    g.addColorStop(S.MID, css([0, 0, 0], 0));
    g.addColorStop(1, css([0, 0, 0], S.DARK * TA));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TILE, TILE);
  }

  // gases as soft puffs: the tile's own gas in white, others in their colour
  const gasL = LAYER[0];
  gasL.fill(0);
  let anyGas = false;
  for (let r = 0; r < ROWS; r++)
    for (let x = 0; x < COLS; x++) {
      const i = at(x, r), id = w.id[i];
      if (KIND[id] !== K.GAS || (id === E.FIRE && id !== item.id)) continue;
      const o = (r * COLS + x) * 4;
      let rgb, a;
      if (id === item.id) { rgb = [255, 255, 255]; a = (LOOK.GAS_ALPHA * TA / GAS_FILL) * (id === E.SMOKE ? clamp01(w.life[i]) : 1); }
      else { rgb = id === E.SMOKE ? PAL[id].base : [255, 255, 255]; a = LOOK.SMOKE_ALPHA * (id === E.SMOKE ? clamp01(w.life[i]) : 1); }
      gasL[o] = rgb[0] / 255 * a; gasL[o + 1] = rgb[1] / 255 * a; gasL[o + 2] = rgb[2] / 255 * a; gasL[o + 3] = a;
      anyGas = true;
    }
  if (anyGas) {
    const soft = blur(gasL, LOOK.GAS_BLUR);
    if (scene.gas && luminance(item.color) > LOOK.LIGHT_LUMA) {
      const sh = LAYER[soft === LAYER[0] ? 1 : 0];
      for (let i = 0; i < N; i++) {
        const a = soft[i * 4 + 3] * (LOOK.SHADOW_ALPHA + (LOOK.SHADOW_ALPHA_LIVE - LOOK.SHADOW_ALPHA) * activity);
        sh[i * 4] = LOOK.SHADOW_RGB[0] / 255 * a; sh[i * 4 + 1] = LOOK.SHADOW_RGB[1] / 255 * a; sh[i * 4 + 2] = LOOK.SHADOW_RGB[2] / 255 * a; sh[i * 4 + 3] = a;
      }
      blit(ctx, sh, 'source-over', LOOK.SHADOW_DROP);
    }
    blit(ctx, soft, 'source-over');
  }

  // incandescence and luminescence: glowing cells, and flames as soft blobs
  // (lava's own colour already is its glow)
  const c = [0, 0, 0];
  for (const flames of [false, true]) {
    const L = LAYER[0];
    L.fill(0);
    let any = false;
    for (let r = 0; r < ROWS; r++)
      for (let x = 0; x < COLS; x++) {
        const i = at(x, r), id = w.id[i];
        if (id === E.LAVA || id === E.EMPTY || id === item.id && KIND[id] === K.GAS || (id === E.FIRE) !== flames) continue;
        // a hot non-metal's open skin runs cooler than its bulk (passes.js glow)
        if (!glow(id, w.T[i] - (id === E.METAL ? 0 : INCAND.SKIN_DROP), c, w.ctype[i])) continue;
        const o = (r * COLS + x) * 4;
        L[o] = Math.min(1, c[0]); L[o + 1] = Math.min(1, c[1]); L[o + 2] = Math.min(1, c[2]);
        L[o + 3] = Math.min(1, Math.max(c[0], c[1], c[2]));
        any = true;
      }
    if (any) blit(ctx, blur(L, flames ? LOOK.FLAME_BLUR : LOOK.GLOW_BLUR), 'lighter');
  }
}
