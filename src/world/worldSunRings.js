// Distance rings for the WORLD renderer's sun shadows (big maps only: Box, the
// small maps, writes its own whole shadow map every frame, gfx/post.js, and
// is untouched by this).
//
// Why: a sun tile's full-detail shadow needs CELL pages for every brick its
// texels' rays cross from the world's top down to the ground (its casters,
// shaders/worldSunWriter.js; ~27k bricks a tile on Island). Every tile the
// view could see asked for them, so a load from a hill asked for 30 tiles and
// 821k bricks up front and Chrome ran out of GPU memory (Island, 2026-10-22).
//
// So full-detail casters are asked for only near the eye, and every other
// tile the view reads gets a coarse shadow straight away, from the scene's
// ground twin (scene.ground, the CPU heightfield every World scene has):
// terrain-scale shadows of hills, cliffs and the volcano, without trees,
// roofs or a dug hole. A coarse tile sharpens to full detail once its
// casters are asked for: when the eye comes within the near ring of it, or
// by one tile per settled load inside the sharpen ring. This is how UE5's
// Virtual Shadow Maps fall back to a coarser resident page while the fine
// one renders, and how cascaded and clipmap shadows trade resolution for
// distance ("Virtual Shadow Maps", UE 5.0 docs: coarse pages; Tanner et al.
// 1998, "The Clipmap"). No tile the view reads is ever without a shadow.
import { worldSunProjection, WORLD_SUN_PITCH, WORLD_SUN_TILE } from './worldSun.js';
import { GEOM_ERR_PX_NONE, GEOM_ERR_PX_FULL } from '../gfx/lodFade.js';
import { BRICK } from '../shaders/common.js';

// The LOD reference view every close-up-detail distance is quoted at
// (gfx/detail.js): 1080 rows and a 75° vertical field of view, where a pixel
// spans 2·tan(37.5°)/1080 = 1.42 mrad.
export const LOD_REF_ROWS = 1080, LOD_REF_VFOV_DEG = 75;
export const LOD_REF_PIXEL_RAD = 2 * Math.tan(LOD_REF_VFOV_DEG / 2 * Math.PI / 180) / LOD_REF_ROWS;

// The coarse shadow's error against the full-detail terrain shadow, cells:
// the mean shift of a shadow's edge (mismatched cells over the edge's length)
// of the coarse heightfield (below) against the ground twin read at every
// cell column, on Island's shore and centre at a 44° and an 18° sun: 0.33-1.16
// cells (2026-10-22; tools/world-sun-coarse-cpu-check.mjs holds it under this).
export const WORLD_SUN_COARSE_ERR = 1.25;
// The screen-space geometric error rule of the close-up detail (gfx/lodFade.js,
// Lindstrom et al. 1996 §6): a stand-in may be drawn where its error, projected
// to the screen, stays under GEOM_ERR_PX_NONE pixels, and the full geometry is
// all of it where the error reaches GEOM_ERR_PX_FULL. So a tile is drawn with
// full-detail casters from its first frame within WORLD_SUN_NEAR_RADIUS of the
// eye (110 cells, 33 m, at the reference view), and sharpened to them after
// the first frame out to WORLD_SUN_SHARPEN_RADIUS (220 cells, 66 m); past that
// the coarse terrain shadow's error is under GEOM_ERR_PX_NONE pixels.
export const WORLD_SUN_NEAR_RADIUS = WORLD_SUN_COARSE_ERR / (GEOM_ERR_PX_FULL * LOD_REF_PIXEL_RAD);
export const WORLD_SUN_SHARPEN_RADIUS = WORLD_SUN_COARSE_ERR / (GEOM_ERR_PX_NONE * LOD_REF_PIXEL_RAD);
// Tiles sharpened past the near ring per settled load (a transaction that
// starts with a frame already shown): one tile's casters (~27k bricks on
// Island, ~2 s of CELL work) at a time, so the frame that is shown is never
// held up by more than one tile's casters, and GPU memory grows by one tile.
export const WORLD_SUN_SHARPEN_TILES = 1;

// The coarse caster surface: the ground twin's top at each brick column's
// centre (worldSunForecast.js worldColumnTops: open water reads as the floor,
// since sunlight goes through it), read bilinearly between centres, and
// WORLD_SUN_COARSE_BIAS cells under that: the twin's top is floored to a whole
// cell and the bilinear surface overshoots the real one at sharp bumps, and a
// caster above the real surface would shade its own lit face (shadow acne).
// Measured as above: 1 cell leaves 0.00-0.09% of the lit cells falsely shaded
// (no bias: 2-4% of the region).
export const WORLD_SUN_COARSE_BIAS = 1;
// Cells along a texel's ray between coarse samples: half a brick column, so a
// step never jumps over a column's peak of the bilinear surface.
export const WORLD_SUN_COARSE_STEP = BRICK / 2;
// Yield to the page while building the coarse heightfield after this much work (ms).
export const WORLD_SUN_COARSE_SLICE_MS = 8;

// Distance in cells, in the light's plane, from the eye's projection to sun
// tile `tile`'s footprint. Every receiver in the tile's beam is at least this
// far from the eye (a projection never lengthens a distance), so a tile past
// a radius holds only receivers past it.
export function worldSunTileDistance(projection, cam, tile) {
  const { u, v } = projection.basis, [x0, y0, w] = projection.tiles, span = WORLD_SUN_TILE * WORLD_SUN_PITCH;
  const p = Array.from(cam), a = u[0] * p[0] + u[1] * p[1] + u[2] * p[2], b = v[0] * p[0] + v[1] * p[1] + v[2] * p[2];
  const a0 = (x0 + tile % w) * span, b0 = (y0 + Math.floor(tile / w)) * span;
  const da = Math.max(a0 - a, 0, a - (a0 + span)), db = Math.max(b0 - b, 0, b - (b0 + span));
  return Math.hypot(da, db);
}

// Which of `tiles` get full-detail casters on this attempt: those whose casters
// were asked for before (`sharp`, the owner's set on this sun grid: they are
// resident, so they stay sharp), those within the near ring of the eye, and,
// when `sharpen` > 0, that many more of the nearest inside the sharpen ring.
// The rest are coarse. Without a coarse source (a scene with no ground twin)
// every tile is fine, as before rings.
export function worldSunRings(projection, cam, tiles, { sharp = new Set(), coarse = true, sharpen = 0,
  near = WORLD_SUN_NEAR_RADIUS, ring = WORLD_SUN_SHARPEN_RADIUS } = {}) {
  const list = [...new Set(tiles)].sort((a, b) => a - b);
  const ok = cam && Array.from(cam).length === 3 && Array.from(cam).every(Number.isFinite);
  if (!coarse || !ok) return { fine: list, coarse: [], sharpened: [] };
  const fine = new Set(), rest = [];
  for (const i of list) {
    const d = worldSunTileDistance(projection, cam, i);
    if (sharp.has(i) || d <= near) fine.add(i); else rest.push([d, i]);
  }
  const sharpened = rest.filter(([d]) => d <= ring).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, Math.max(0, sharpen)).map(([, i]) => i);
  for (const i of sharpened) fine.add(i);
  return { fine: list.filter((i) => fine.has(i)), coarse: list.filter((i) => !fine.has(i)), sharpened };
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
// The coarse caster heightfield for the whole world: one f32 per brick column,
// the twin's top there (tops.top), x fastest; maxTop the highest of them.
// Async: yields between rows after WORLD_SUN_COARSE_SLICE_MS of work (the
// Island twin costs ~23 µs a column, 1.5 s for its 65k columns, most of which
// the forecast's walks have already read and cached).
export async function worldCoarseCasters({ size, tops, yieldEvery = WORLD_SUN_COARSE_SLICE_MS }) {
  if (!tops) return null;
  const dims = [Math.ceil(size[0] / BRICK), Math.ceil(size[2] / BRICK)], heights = new Float32Array(dims[0] * dims[1]);
  let maxTop = 0, slice = now();
  for (let z = 0; z < dims[1]; z++) {
    for (let x = 0; x < dims[0]; x++) { const h = tops.top(x, z); heights[x + dims[0] * z] = h; if (h > maxTop) maxTop = h; }
    if (yieldEvery != null && now() - slice > yieldEvery) { await pause(); slice = now(); }
  }
  return Object.freeze({ heights, dims: Object.freeze(dims), maxTop, size: Object.freeze([...size]) });
}

// CPU twin of the coarse writer (shaders/worldSunCoarse.js coarseTexel): the
// depth along ray o + t·d (cells) where it first goes under the coarse
// surface, the floor's depth when it reaches the floor, else no hit.
export const WORLD_SUN_COARSE_NO_HIT = 1e5;   // = shadowOptics.js SHADOW_NO_HIT
export function coarseHeightAt(casters, x, z) {
  const { heights, dims } = casters, col = (i, j) => heights[Math.min(dims[0] - 1, Math.max(0, i)) + dims[0] * Math.min(dims[1] - 1, Math.max(0, j))];
  const qx = x / BRICK - 0.5, qz = z / BRICK - 0.5, i = Math.floor(qx), j = Math.floor(qz), fx = qx - i, fz = qz - j;
  const a = col(i, j) * (1 - fx) + col(i + 1, j) * fx, b = col(i, j + 1) * (1 - fx) + col(i + 1, j + 1) * fx;
  return a * (1 - fz) + b * fz - WORLD_SUN_COARSE_BIAS;
}
export const worldSunCoarseSteps = (size) => Math.ceil(Math.hypot(...size) / WORLD_SUN_COARSE_STEP) + 1;
export function coarseSunDepth(casters, o, d) {
  const hi = [casters.size[0], casters.maxTop, casters.size[2]];
  let t0 = 0, t1 = 1e30;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < 0 || o[i] > hi[i]) t1 = -1; continue; }
    const a = -o[i] / d[i], b = (hi[i] - o[i]) / d[i];
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  let hit = WORLD_SUN_COARSE_NO_HIT;
  if (t0 < t1) {
    const gap = (t) => o[1] + d[1] * t - coarseHeightAt(casters, o[0] + d[0] * t, o[2] + d[2] * t);
    let tp = t0, dp = gap(t0);
    if (dp <= 0) hit = t0;
    else for (let k = 1, n = worldSunCoarseSteps(casters.size); k <= n; k++) {
      const t = Math.min(t0 + k * WORLD_SUN_COARSE_STEP, t1), g = gap(t);
      if (g <= 0) { hit = tp + (t - tp) * dp / (dp - g); break; }
      tp = t; dp = g;
      if (t >= t1) break;
    }
  }
  if (hit === WORLD_SUN_COARSE_NO_HIT && d[1] < 0 && o[1] >= 0) hit = o[1] / -d[1];
  return hit;
}
// Re-exported for the owner and the model: the sun grid a direction makes.
export { worldSunProjection };
