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
//   through it without asking (shaders/worldAccess.js worldViewFarAir), and
//   every reader of it (cells, fields, media) gets the empty placeholder. A
//   brick that is resident is still read: what the view already holds is
//   drawn. A missing far brick under the floor (the ground and the trees on
//   it) is still asked for: that is the far ground the picture shows, which
//   the load's own forecast mostly asks for first (worldSunForecast.js).
// - Far shading: the sun tiles a far pixel finds are drawn coarse from the
//   same twin (worldSunRings.js, by the tile's distance), never with casters.
// - Past WORLD_VIEW_GI_RADIUS a surface's light bounce is the open sky's
//   (no bounce, all of the sky), faded in over WORLD_VIEW_GI_FADE: no probe
//   there is ever asked for, so none is born. Past it glow reads nothing.
// - Inside the near rings the view behaves exactly as before.
// And a GPU memory budget (worldPageBudget): a load never asks the atlas for
// more pages than a stated share of the device's memory holds, and no pool
// grows past that times its copies; past it the farthest requested bricks
// are dropped and read as air from there up (worldBudgetDemand), as UE5's
// Nanite and Virtual Shadow Map pools do with a fixed page budget
// (r.Nanite.Streaming.StreamingPoolSize, r.Shadow.Virtual.MaxPhysicalPages:
// the pool is a budget, overflow drops the farthest/coarsest requests, it
// never grows past it).
import { WORLD_SUN_NEAR_RADIUS } from './worldSunRings.js';
import { BRICK } from '../shaders/common.js';
import { AUX_RECORDS, LIGHT_RECORDS, PAGE_CHANNELS } from './renderAtlas.js';
import { worldRunSync, WORLD_SLICE_COST as COST } from './worldSlices.js';

// The view's full-detail ring, cells: the sun's near ring (worldSunRings.js:
// the screen-error rule of gfx/lodFade.js applied to the coarse stand-in's
// error). Inside it every brick a pixel reads is asked for, as before rings.
export const WORLD_VIEW_NEAR_RADIUS = WORLD_SUN_NEAR_RADIUS;
// How far over the ground twin's top a missing far brick must start to be read
// as air, cells: the tallest a World scene's trees reach over their column's
// ground (scenes/giantVolcano.js TREE_REACH: Volcano isles' trees, half as big
// again as Island's), since the twin (scene.ground) holds the terrain and its
// structures but not the trees planted on it. So a far crown is still asked
// for and drawn; only the open sky over it is skipped. Matter the twin cannot
// know of higher up (smoke, a cloud, a player's tower) is drawn past the ring
// when its bricks are resident, and not asked for when they are not: the
// open follow-up is a per-brick "holds matter" summary from the simulation,
// asked for by the load (Minecraft's empty chunk sections, which it never
// meshes), so far air over the floor that does hold something is loaded too.
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
// A column floor no brick row reaches: every missing brick there is asked for.
export const WORLD_VIEW_NO_FLOOR = 0xffffffff;

// Per brick column (x fastest), the lowest brick row from which a missing
// brick past the near ring is air: the brick rows wholly over the highest twin
// top within WORLD_VIEW_AIR_DILATE columns (open water: its surface,
// tops.sea), plus WORLD_VIEW_AIR_CLEARANCE. Brick rows, not cells, so the
// shader's test is one integer compare. tops: worldSunForecast.js
// worldColumnTops, or casters: the coarse sun's heightfield of the same tops
// (worldSunRings.js worldCoarseCasters), read without asking the twin again.
// No twin: every floor is WORLD_VIEW_NO_FLOOR (nothing is skipped until the
// budget lowers one).
export function worldViewAirFloors({ size, tops, casters = null }) {
  const dims = [Math.ceil(size[0] / BRICK), Math.ceil(size[2] / BRICK)], raw = new Float32Array(dims[0] * dims[1]), sea = tops?.sea ?? 0;
  if (!tops) return Object.freeze({ floors: new Uint32Array(raw.length).fill(WORLD_VIEW_NO_FLOOR), dims: Object.freeze(dims) });
  for (let z = 0; z < dims[1]; z++) for (let x = 0; x < dims[0]; x++) raw[x + dims[0] * z] = Math.max(casters ? casters.heights[x + dims[0] * z] : tops.top(x, z), sea);
  const floors = new Uint32Array(raw.length);
  for (let z = 0; z < dims[1]; z++) for (let x = 0; x < dims[0]; x++) {
    let h = 0;
    for (let k = -WORLD_VIEW_AIR_DILATE; k <= WORLD_VIEW_AIR_DILATE; k++) for (let i = -WORLD_VIEW_AIR_DILATE; i <= WORLD_VIEW_AIR_DILATE; i++) {
      const xi = Math.min(dims[0] - 1, Math.max(0, x + i)), zi = Math.min(dims[1] - 1, Math.max(0, z + k));
      h = Math.max(h, raw[xi + dims[0] * zi]);
    }
    floors[x + dims[0] * z] = Math.ceil((h + WORLD_VIEW_AIR_CLEARANCE) / BRICK);
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
  return s > radius * radius && b[1] >= air.floors[b[0] + air.dims[0] * b[2]];
}
// Is a GI probe sampled at p (cells) past the view's light-bounce ring? (worldProbe's
// fade reaches 1 there: it asks for none of its taps.)
export const worldViewProbeFar = (eye, p, radius = WORLD_VIEW_GI_RADIUS) => !!eye && Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) >= radius;
// The floors as the words appended to the SunBook (gfx/worldSunLighting.js):
// one brick row per column, then the column count, which tells the shader they are there.
export function worldViewAirWords(air) {
  if (!air) return null;
  const n = air.floors.length, words = new Uint32Array(n + 1);
  words.set(air.floors);
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
// The share of the device's memory a load's demand may hold in atlas pages.
// Real Chrome on the user's Mac (navigator.deviceMemory 8) held 449k pages
// (2.6 GB) through a load and ran out of GPU memory growing past ~480k, the
// pool's doubling growth holding the old and the new arrays at once
// (2026-10-22): a fifth keeps a load's demand at ~295k pages there, which
// with its copies (WORLD_PAGE_COPIES) is ~590k pages, held without a doubling.
export const WORLD_GPU_MEMORY_SHARE = 0.2;
// Pages a pool holds per demanded brick at most: a re-pack writes a brick's
// new page while its old one is still published (renderAtlas.js keeps the
// previous snapshot's pages until the new one is accepted, copy-on-write),
// so a pool may need two pages for a brick during a load.
export const WORLD_PAGE_COPIES = 2;
// GiB assumed when the browser does not say (navigator.deviceMemory is absent
// outside Chrome): Chrome's own cap, the most the user's Mac reports; every
// desktop that runs WebGPU has at least that, and phones start on the small
// maps (Box), which hold no atlas.
export const WORLD_DEVICE_MEMORY_FALLBACK_GB = 8;
// Pages a load's demand may hold (cell, light, probe) and the most each pool
// may grow to (pool: the demand times WORLD_PAGE_COPIES): a brick's worst case
// is a CELL page and a LIGHT page. Each pool is also held under one
// maxBufferSize per page plane's texture array (a pool can never be bigger
// than the device can address in one resource), which only binds on a device
// with a small limit. The rule of UE5's streaming pools (Nanite's
// r.Nanite.Streaming.StreamingPoolSize, Virtual Shadow Maps'
// r.Shadow.Virtual.MaxPhysicalPages): a fixed page budget, never grown past.
export function worldPageBudget({ deviceMemoryGB, limits = {} } = {}) {
  const gb = Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 ? deviceMemoryGB : WORLD_DEVICE_MEMORY_FALLBACK_GB;
  const bytes = Math.floor(gb * 1024 ** 3 * WORLD_GPU_MEMORY_SHARE);
  let pool = Math.floor(bytes / (WORLD_CELL_PAGE_BYTES + WORLD_LIGHT_PAGE_BYTES)) * WORLD_PAGE_COPIES;
  const maxBuffer = limits.maxBufferSize;
  if (Number.isFinite(maxBuffer) && maxBuffer > 0) pool = Math.min(pool, Math.floor(maxBuffer / (64 * PAGE_CHANNELS.stateA[2])));
  const pages = Math.floor(pool / WORLD_PAGE_COPIES);
  return Object.freeze({ cell: pages, light: pages, probe: pages, pool: Object.freeze({ cell: pool, light: pool, probe: pool }), bytes, deviceMemoryGB: gb });
}
// The demand that fits the budget: ids (brick indices) to keep. When there are
// more than `budget` of them, or more new pages (fresh: the bricks a pack
// would write a page for; all of them when null) than the pool has `room` for,
// the farthest from the eye that are not `held` (pages the owner keeps anyway;
// a Set, or a rule asked of ids' bricks) and lie past the near ring are
// dropped, until both fit. A dropped brick the atlas does not hold (not in
// `resident`) lowers its column's floor to its own row, so it and every brick
// over it in the column read as air: the view never asks for them again on
// this load, the far edge of the picture is what is resident, as past
// Minecraft's render distance nothing is drawn. A resident one keeps its last
// page. Returns { keep, dropped, air } (air: the lowered copy, or the input
// when nothing was lowered).
// (worldBudgetDemandSteps: the same in slices, worldSlices.js, without keep)
export function worldBudgetDemand(ids, options) {
  const r = worldRunSync(worldBudgetDemandSteps(ids, options)), dropped = new Set(r.dropped);
  return { keep: new Set([...ids].filter((i) => !dropped.has(i))), dropped: r.dropped, air: r.air };
}
export function* worldBudgetDemandSteps(ids, { budget, eye, brick, held = null, air = null, radius = WORLD_VIEW_NEAR_RADIUS, fresh = null, room = Infinity, resident = null }, full = () => false) {
  const isHeld = !held ? () => false : typeof held === 'function' ? held : (i) => held.has(i), isFresh = (i) => !fresh || fresh.has(i);
  // ids' new pages, counted over the smaller of the two sets
  let news = ids.size;
  if (fresh) {
    news = 0;
    const [a, b] = fresh.size < ids.size ? [fresh, ids] : [ids, fresh];
    for (const i of a) { if (b.has(i)) news++; if (full(COST.member)) yield; }
  }
  let over = ids.size - budget, short = news - room;
  if (!(over > 0 || short > 0) || !eye) return { dropped: [], air };
  const dropped = [];
  // A brick goes while either is short; once only the pool is (over never
  // rises again), only a new page frees room, so a demand within its budget
  // ranks only its new pages (walking the smaller of the two sets): the same
  // farthest-first walk over fewer bricks.
  const [list, skip] = over > 0 ? [ids, isHeld] : fresh && fresh.size < ids.size ? [fresh, (i) => !ids.has(i) || isHeld(i)] : [ids, (i) => !isFresh(i) || isHeld(i)];
  yield* worldFarthestSteps(list, { eye, brick, skip, radius, visit(i) {
    const f = isFresh(i);
    if (over > 0 || f) { dropped.push(i); over--; if (f) short--; }
    return over <= 0 && short <= 0;
  } }, full);
  let next = air;
  if (air) {
    let floors = null;
    for (const i of dropped) {
      if (!resident?.has(i)) { const b = brick(i), c = b[0] + air.dims[0] * b[2]; floors ??= Uint32Array.from(air.floors); floors[c] = Math.min(floors[c], b[1]); }
      if (full(COST.member)) yield;
    }
    if (floors) next = Object.freeze({ floors, dims: air.dims });
  }
  return { dropped, air: next };
}
// visit(i), farthest first, for the bricks of ids that skip(i) does not skip
// and whose centre lies past radius cells of eye, until visit returns true:
// the order the budget's rules read (worldBudgetDemand above, the owner's
// evictions: wire/worldRender.js worldBudgetPass), every brick by its
// distance, the higher index first at a tie. In slices (worldSlices.js), and
// no sort of them all: each distance goes to one of about as many buckets as
// bricks, a bucket the same share of the distances' span (a monotone rule, so
// a farther bucket holds only bricks as far or farther), and a bucket is put
// in order only when the walk reaches it: the bricks once, then what the walk
// takes. The budget sorted every brick of a big map's demand, ~300k, for each
// of its rules, all in one task (Descent, real Chrome with the user's
// settings, 2026-10-22: 1.1 s blocked as a view round loaded ~96k bricks).
export function* worldFarthestSteps(ids, { eye, brick, skip = null, radius = -Infinity, visit }, full = () => false) {
  let n = 0, D = new Float64Array(Math.max(1, ids.size ?? ids.length ?? 0)), I = new Uint32Array(D.length), lo = Infinity, hi = -Infinity;
  for (const i of ids) {
    if (!skip?.(i)) {
      // (the distance as worldViewFarAir's centre rule, bit for bit)
      const b = brick(i), d = Math.hypot((b[0] + 0.5) * BRICK - eye[0], (b[1] + 0.5) * BRICK - eye[1], (b[2] + 0.5) * BRICK - eye[2]);
      if (d > radius) {
        if (n === D.length) { const d2 = new Float64Array(2 * n), i2 = new Uint32Array(2 * n); d2.set(D); i2.set(I); D = d2; I = i2; }
        D[n] = d; I[n++] = i; if (d < lo) lo = d; if (d > hi) hi = d;
      }
    }
    if (full(COST.rank)) yield;
  }
  if (!n) return;
  const buckets = n, width = (hi - lo) / buckets, bucket = width > 0 ? (d) => Math.min(buckets - 1, Math.floor((d - lo) / width)) : () => 0;
  // a counting sort into the buckets: starts, then each brick's slot
  const start = new Uint32Array(buckets + 1), order = new Uint32Array(n);
  for (let k = 0; k < n; k++) { start[bucket(D[k]) + 1]++; if (full(COST.typed)) yield; }
  for (let k = 0; k < buckets; k++) { start[k + 1] += start[k]; if (full(COST.typed)) yield; }
  const slot = start.slice(0, buckets);
  for (let k = 0; k < n; k++) { order[slot[bucket(D[k])]++] = k; if (full(COST.typed)) yield; }
  const farther = (a, b) => D[b] - D[a] || I[b] - I[a];
  for (let k = buckets - 1; k >= 0; k--) {
    const s = start[k], e = start[k + 1];
    if (e - s > 1) { order.subarray(s, e).sort(farther); if (full(COST.compare * (e - s) * Math.ceil(Math.log2(e - s)))) yield; }
    for (let j = s; j < e; j++) { if (visit(I[order[j]])) return; if (full(COST.member)) yield; }
    if (full(COST.typed)) yield;
  }
}
