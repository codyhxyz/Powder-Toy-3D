// Distance rings for what the WORLD renderer's own view asks for (big maps
// only). Box, the small maps, holds its whole window every frame and asks for
// nothing, so none of this applies to it: not a deviation, the picture a World
// view converges to inside its rings is the one Box draws.
//
// Why: a World load's own demand was bounded (world/worldSunRings.js,
// world/worldGIRing.js), but the view's feedback was not. A view ray treats a
// brick it has no page for as unknown, asks for it and walks on, so from
// Island's hill every pixel asked for every brick of air it crossed over the
// whole island; every surface it shaded asked for its 8 GI probes, so every
// visible far surface became a light-bounce gather; and every glow lookup asked
// for its 32-cell core's glow, whose blur reads 16^3 bricks around it. Real
// Chrome (2026-10-22 02:22, base 18a914b0): bricks 235k -> 481k, gathers 4 ->
// 49,496, then the GPU ran out of memory and no frame was ever shown.
//
// So, the rule of UE5's virtual texture feedback (a far pixel asks for a
// coarser mip, never the finest: "Virtual Texturing", UE 5 docs, feedback mip
// bias) and Lumen's near/far split:
// - Past WORLD_VIEW_NEAR_RADIUS of the eye, a missing brick over the scene's
//   ground twin by more than WORLD_VIEW_AIR_CLEARANCE is air: the view walks
//   through it without asking (shaders/worldAccess.js worldViewFarAir). A brick
//   that is resident is still read: what the view already holds is drawn.
// - Past WORLD_VIEW_GI_RADIUS a surface's light bounce is the open sky's
//   (no bounce, all of the sky), faded in over WORLD_VIEW_GI_FADE: no probe
//   there is ever asked for, so none is born. Past it glow reads nothing.
// - Inside the near rings the view behaves exactly as before.
// And a GPU memory budget (worldPageBudget): a load never asks the atlas for
// more pages than a stated share of the device's memory holds; past it the
// farthest requested bricks are dropped and read as air from there up
// (worldBudgetDemand), as UE5's Nanite and Virtual Shadow Map pools do with a
// fixed page budget (r.Nanite.StreamingPoolSize, r.Shadow.Virtual.MaxPhysicalPages:
// the pool is a budget, overflow drops the farthest/coarsest requests, it never
// grows past it).
import { WORLD_SUN_NEAR_RADIUS } from './worldSunRings.js';
import { BRICK } from '../shaders/common.js';
import { AUX_RECORDS, LIGHT_RECORDS, PAGE_CHANNELS } from './renderAtlas.js';

// The view's full-detail ring, cells: the sun's near ring (worldSunRings.js:
// the screen-error rule of gfx/lodFade.js applied to the coarse stand-in's
// error). Inside it every brick a pixel reads is asked for, as before rings.
export const WORLD_VIEW_NEAR_RADIUS = WORLD_SUN_NEAR_RADIUS;
// How far over the ground twin's top a missing far brick must start to be read
// as air, cells: the tallest a World scene's trees reach over their column's
// ground (scenes/giantVolcano.js TREE_REACH: Volcano isles' trees, half as big
// again as Island's), since the twin (scene.ground) holds the terrain and its
// structures but not the trees planted on it. So a far crown is still asked
// for and drawn; only the open sky over it is skipped.
export const WORLD_VIEW_AIR_CLEARANCE = 28;
// Columns around a brick column whose highest top it is held under: the twin
// is sampled once per column (its centre), so a slope or a step inside the
// column can put real ground up to a column's width higher.
export const WORLD_VIEW_AIR_DILATE = 1;
// The view's light-bounce ring, cells: the sun's near ring again. The light
// bounce is low-frequency (a probe is a brick wide), and past this the sky's
// share, not the bounce, is most of a lit surface's indirect light. The
// probes inside it come to a few thousand on Island's hill (tools/world-demand-model.mjs).
export const WORLD_VIEW_GI_RADIUS = WORLD_SUN_NEAR_RADIUS;
// Cells over which the probes' light eases into the open sky's, inside the
// ring: two probes' spacing, so the hand-off is never a step at a probe edge.
export const WORLD_VIEW_GI_FADE = 2 * BRICK;
// A column floor no brick reaches (f32): every missing brick there is asked for.
export const WORLD_VIEW_NO_FLOOR = 3.0e38;

// Per brick column (x fastest), the lowest cell y from which a missing brick
// past the near ring is air: the highest twin top within WORLD_VIEW_AIR_DILATE
// columns (open water: its surface, tops.sea), plus WORLD_VIEW_AIR_CLEARANCE.
// tops: worldSunForecast.js worldColumnTops, or casters: the coarse sun's
// heightfield of the same tops (worldSunRings.js worldCoarseCasters), read
// without asking the twin again. No twin: every floor is WORLD_VIEW_NO_FLOOR
// (nothing is skipped until the budget lowers one).
export function worldViewAirFloors({ size, tops, casters = null }) {
  const dims = [Math.ceil(size[0] / BRICK), Math.ceil(size[2] / BRICK)], raw = new Float32Array(dims[0] * dims[1]), sea = tops?.sea ?? 0;
  if (!tops) return Object.freeze({ floors: raw.fill(WORLD_VIEW_NO_FLOOR), dims: Object.freeze(dims) });
  for (let z = 0; z < dims[1]; z++) for (let x = 0; x < dims[0]; x++) raw[x + dims[0] * z] = Math.max(casters ? casters.heights[x + dims[0] * z] : tops.top(x, z), sea);
  const floors = new Float32Array(raw.length);
  for (let z = 0; z < dims[1]; z++) for (let x = 0; x < dims[0]; x++) {
    let h = 0;
    for (let k = -WORLD_VIEW_AIR_DILATE; k <= WORLD_VIEW_AIR_DILATE; k++) for (let i = -WORLD_VIEW_AIR_DILATE; i <= WORLD_VIEW_AIR_DILATE; i++) {
      const xi = Math.min(dims[0] - 1, Math.max(0, x + i)), zi = Math.min(dims[1] - 1, Math.max(0, z + k));
      h = Math.max(h, raw[xi + dims[0] * zi]);
    }
    floors[x + dims[0] * z] = h + WORLD_VIEW_AIR_CLEARANCE;
  }
  return Object.freeze({ floors, dims: Object.freeze(dims) });
}
// CPU twin of shaders/worldAccess.js worldViewFarAir: is missing brick b (brick
// coordinates) read as air by the view from eye (cells)? By the brick's centre,
// as the shader decides it, so every pixel agrees on a brick.
export function worldViewFarAir(eye, b, air, radius = WORLD_VIEW_NEAR_RADIUS) {
  if (!air || !eye) return false;
  let s = 0;
  for (let k = 0; k < 3; k++) { const d = (b[k] + 0.5) * BRICK - eye[k]; s += d * d; }
  return s > radius * radius && b[1] * BRICK >= air.floors[b[0] + air.dims[0] * b[2]];
}
// Is a GI probe sampled at p (cells) past the view's light-bounce ring? (worldProbe's
// fade reaches 1 there: it asks for none of its taps.)
export const worldViewProbeFar = (eye, p, radius = WORLD_VIEW_GI_RADIUS) => !!eye && Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) >= radius;
// The floors as the words appended to the SunBook (gfx/worldSunLighting.js):
// one f32 per column, then the column count, which tells the shader they are there.
export function worldViewAirWords(air) {
  if (!air) return null;
  const n = air.floors.length, words = new Uint32Array(n + 1);
  words.set(new Uint32Array(air.floors.buffer, air.floors.byteOffset, n));
  words[n] = n;
  return words;
}

// ---- the GPU memory budget ----
// Bytes of one CELL page (renderAtlas.js PAGE_CHANNELS: 64 cells of state A and
// B and three field planes, plus its AUX_RECORDS aux texels) and one LIGHT page
// (its LIGHT_RECORDS descriptor texels and one texel in each probe plane).
const channelBytes = (shape) => Object.values(PAGE_CHANNELS).filter(([, s]) => s === shape).reduce((a, [, , b]) => a + b, 0);
export const WORLD_CELL_PAGE_BYTES = 64 * channelBytes('cells') + AUX_RECORDS * PAGE_CHANNELS.aux[2];
export const WORLD_LIGHT_PAGE_BYTES = LIGHT_RECORDS * PAGE_CHANNELS.aux[2] + channelBytes('probes');
// The share of the device's memory the World's atlas pages may hold. Real
// Chrome on the user's Mac (navigator.deviceMemory 8) ran out of GPU memory at
// ~480k CELL pages (2.7 GB of pages, a third of it, with their growth copy and
// the load's transient buffers on top) and held 235k-449k (2026-10-22): a fifth
// keeps a load at ~300k pages there, under what it held.
export const WORLD_GPU_MEMORY_SHARE = 0.2;
// GiB assumed when the browser does not say (navigator.deviceMemory is absent
// outside Chrome; Chrome caps it at 8).
export const WORLD_DEVICE_MEMORY_FALLBACK_GB = 4;
// Pages each pool may hold: a brick's worst case is a CELL page and a LIGHT
// page. Also held under one maxBufferSize per page plane's texture array
// (a pool can never be bigger than the device can address in one resource),
// which only binds on a device with a small limit.
export function worldPageBudget({ deviceMemoryGB, limits = {} } = {}) {
  const gb = Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 ? deviceMemoryGB : WORLD_DEVICE_MEMORY_FALLBACK_GB;
  const bytes = Math.floor(gb * 1024 ** 3 * WORLD_GPU_MEMORY_SHARE);
  let pages = Math.floor(bytes / (WORLD_CELL_PAGE_BYTES + WORLD_LIGHT_PAGE_BYTES));
  const maxBuffer = limits.maxBufferSize;
  if (Number.isFinite(maxBuffer) && maxBuffer > 0) pages = Math.min(pages, Math.floor(maxBuffer / (64 * PAGE_CHANNELS.stateA[2])));
  return Object.freeze({ cell: pages, light: pages, probe: pages, bytes, deviceMemoryGB: gb });
}
// The demand that fits the budget: ids (brick indices) to keep. When there are
// more than `budget` of them, the farthest from the eye that are not `held`
// (pages the owner keeps anyway) and lie past the near ring are dropped, and
// each dropped brick lowers its column's floor to its own bottom, so it and
// every brick over it in the column read as air (the view never asks for them
// again on this load). Returns { keep, dropped, floors } (floors: the changed
// copy, or the input when nothing was dropped).
export function worldBudgetDemand(ids, { budget, eye, brick, held = new Set(), air = null, radius = WORLD_VIEW_NEAR_RADIUS }) {
  const all = [...ids];
  if (!(all.length > budget) || !eye) return { keep: new Set(all), dropped: [], air };
  const far = [];
  for (const i of all) {
    if (held.has(i)) continue;
    const b = brick(i), d = Math.hypot(...b.map((n, k) => (n + 0.5) * BRICK - eye[k]));
    if (d > radius) far.push([d, i, b]);
  }
  far.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const drop = far.slice(0, all.length - budget), dropped = new Set(drop.map(([, i]) => i));
  let next = air;
  if (drop.length && air) {
    const floors = Float32Array.from(air.floors);
    for (const [, , b] of drop) { const c = b[0] + air.dims[0] * b[2]; floors[c] = Math.min(floors[c], b[1] * BRICK); }
    next = Object.freeze({ floors, dims: air.dims });
  }
  return { keep: new Set(all.filter((i) => !dropped.has(i))), dropped: drop.map(([, i]) => i), air: next };
}
