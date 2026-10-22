// CPU forecast of a WORLD load's sun-shadow closure (wire/worldRender.js).
//
// Why a load took ~9 attempts (Island 35k -> 213k bricks, 2026-10-21): a WORLD
// ray treats a brick it has no page for as empty and walks on, asking for it
// (shaders/worldAccess.js worldPage; World pages carry no empty-space distance,
// so skipEmpty steps one brick at a time). So every layer of the demand is
// found only once the layer before it is resident: the eye's bricks, then the
// sun tiles of what the eye hits, then those tiles' casters (each texel's walk
// from the world's top down to its first opaque cell), then the field support
// next to the hits, and every new sun tile (the scene's receivers, GI sources)
// starts that chain again. And a blind walk does not stop at the ground it
// cannot see yet: it asks for every brick down to the world's floor.
//
// The scene already knows where its ground is (scene.ground, the CPU twin every
// World scene has). This forecasts the same walks against it before an attempt
// runs: for every sun tile that enters the demand (the eye probe's, the
// scene's, GI sources'), its casters from the world's entry to the first brick
// under the ground plus a margin, and the eye probe's own tiles up front.
// (The eye's whole view's bricks are not forecast: a heightfield walk of the
// view asked for 2-3x the 35k bricks the real eye pass does, 2026-10-21 Node
// model. Its sun tiles are: forecastViewTiles. So are the SOURCES its probes'
// gathers read: forecastGatherSources.)
// It only adds requests. The GPU feedback stays the authority, so a forecast
// miss (a tree or roof over the ground, a dug hole, a cave mouth) costs the
// round trip it always did, and the pixels are the ones the feedback loop
// converges to anyway: the same pages, fetched in fewer passes.
import { worldSunProjection, WORLD_SUN_PITCH, WORLD_SUN_TILE } from './worldSun.js';
import { BRICK } from '../shaders/common.js';
import { GI, giSteps } from '../shaders/gi.js';

// Forecast sun rays run on a square grid this many cells apart in the light's
// plane. A brick's cross-section seen from any direction holds a disk BRICK
// wide, and a square grid of pitch s hits every disk wider than s·√2, so every
// brick a tile's beam crosses is crossed by at least one forecast ray.
export const FORECAST_SUN_SPACING = BRICK / Math.SQRT2;
// Bricks a forecast walk keeps going past the first brick it expects matter in:
// the ground twin is sampled once per brick column (its centre), so a slope or
// a step inside the column can put the real first hit up to this much lower.
export const FORECAST_STOP_MARGIN = 2;
// A walk expects matter in a brick only under the LOWEST ground of the brick
// columns within this many columns of it: a texel ray between two forecast rays
// can slip past a cliff's edge or a roof's rim that the nearer forecast ray
// stopped on, and go down its face (Node model, 2026-10-21: 0.1-0.5% of the
// casters were missed without it, which costs the whole restart anyway).
export const FORECAST_STOP_DILATE = 1;
// Forecast rays this many grid steps past each tile edge: a brick only a sliver
// of which lies inside the tile's beam is crossed by its texels but may sit
// between the in-tile grid points.
export const FORECAST_EDGE_RAYS = 1;
// A coarse sun tile's surface (forecastSunCasters shell): the bricks the walk
// crosses from this many over the highest nearby ground down to its stop. The
// eye sees that ground and reads its cells' cubic support (2 cells: one brick
// covers it): asked for up front, the eye's first pass stops at it, as it did
// when every tile's full casters were resident, instead of walking through it
// unknown and finding its hits a load later (Node model, 2026-10-22: Island
// 5 attempts without it, 3 with).
export const FORECAST_SHELL_BRICKS = 1;
// Start a ray a hair inside the box so its first brick is the one it enters.
const ENTRY_NUDGE = 1e-4;
// Yield to the page between forecast tiles, after this much work (ms).
export const FORECAST_SLICE_MS = 8;

// The CPU twin's estimate of where a brick column's matter starts, per brick
// column, cached: a column of open water (top at or under the sea) counts as
// unknown down to the floor, since sunlight goes through water to the bed. A
// scene without a ground twin forecasts nothing.
export function worldColumnTops({ size, scene, P }) {
  if (typeof scene?.ground !== 'function' || !Array.isArray(size) || size.length !== 3) return null;
  const bx = Math.ceil(size[0] / BRICK), bz = Math.ceil(size[2] / BRICK), sea = Number.isFinite(P?.sea) ? P.sea : 0;
  const tops = new Int32Array(bx * bz).fill(-1);
  let calls = 0;
  const top = (x, z) => {
    const i = x + bx * z;
    let h = tops[i];
    if (h >= 0) return h;
    calls++;
    const cx = Math.min(size[0] - 1, x * BRICK + BRICK / 2), cz = Math.min(size[2] - 1, z * BRICK + BRICK / 2);
    let g = 0;
    try {
      const lo = [x * BRICK, z * BRICK], hi = [lo[0] + BRICK, lo[1] + BRICK];
      g = scene.mayContainCellsXZ && !scene.mayContainCellsXZ(lo, hi, 0) ? 0 : scene.ground(cx, cz, P);
    } catch { g = 0; }
    h = Number.isFinite(g) ? Math.max(0, Math.floor(g)) : 0;
    if (sea > 0 && h <= sea) h = 0;
    tops[i] = h;
    return h;
  };
  return Object.freeze({ top, sea, get calls() { return calls; } });
}

// Brick DDA (Amanatides & Woo) of the ray o + t·d (cells) through the world's
// brick grid. visit(x, y, z) returns true to stop.
export function walkWorldBricks(size, o, d, visit) {
  const dims = size.map((n) => Math.ceil(n / BRICK));
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) { if (o[i] < 0 || o[i] >= size[i]) return; continue; }
    let a = -o[i] / d[i], b = (size[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
  }
  if (!(t0 < t1)) return;
  const t = t0 + ENTRY_NUDGE * (t1 - t0);
  const cell = [0, 0, 0], step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
  for (let i = 0; i < 3; i++) {
    const p = (o[i] + d[i] * t) / BRICK;
    cell[i] = Math.min(dims[i] - 1, Math.max(0, Math.floor(p)));
    if (d[i] > 0) { step[i] = 1; tDelta[i] = BRICK / d[i]; tMax[i] = t + (cell[i] + 1 - p) * tDelta[i]; }
    else if (d[i] < 0) { step[i] = -1; tDelta[i] = -BRICK / d[i]; tMax[i] = t + (p - cell[i]) * tDelta[i]; }
  }
  for (;;) {
    if (visit(cell[0], cell[1], cell[2])) return;
    const ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    cell[ax] += step[ax];
    if (cell[ax] < 0 || cell[ax] >= dims[ax]) return;
    tMax[ax] += tDelta[ax];
  }
}

// One forecast walk: marks every brick from the entry to FORECAST_STOP_MARGIN
// bricks past the first one the ground twin puts matter in. Returns that first
// matter brick (a receiver), or null when the ray leaves the world first.
// The lowest ground of the brick columns within FORECAST_STOP_DILATE of (x, z).
function dilatedTop(tops, dims, x, z, pick = Math.min) {
  let h = pick === Math.min ? Infinity : -Infinity;
  for (let k = -FORECAST_STOP_DILATE; k <= FORECAST_STOP_DILATE; k++) for (let i = -FORECAST_STOP_DILATE; i <= FORECAST_STOP_DILATE; i++) {
    h = pick(h, tops.top(Math.min(dims[0] - 1, Math.max(0, x + i)), Math.min(dims[2] - 1, Math.max(0, z + k))));
  }
  return h;
}
// The margin is depth, bricks under the hit's: the twin's error is a height,
// and a slanted ray's steps past the hit go sideways as often as down (Node
// model, 2026-10-22: a step margin left a 46-degree sun's ray one brick short).
// shell: mark only the bricks from FORECAST_SHELL_BRICKS over the highest
// nearby ground on, not the air the walk crosses above it (a coarse tile's surface).
function forecastWalk(size, tops, o, d, mark, shell = false) {
  const dims = size.map((n) => Math.ceil(n / BRICK));
  let hit = null;
  walkWorldBricks(size, o, d, (x, y, z) => {
    if (!shell || hit || y * BRICK < dilatedTop(tops, dims, x, z, Math.max) + FORECAST_SHELL_BRICKS * BRICK) mark(x + dims[0] * (y + dims[1] * z));
    if (hit) return y <= hit[1] - FORECAST_STOP_MARGIN;
    if (y * BRICK < dilatedTop(tops, dims, x, z)) { hit = [x, y, z]; return FORECAST_STOP_MARGIN === 0; }
    return false;
  });
  return hit;
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// The casters of sun tiles `tiles` (projection tile ids, worldSunProjection's
// virtual grid) for sun `direction`: every brick a texel's walk crosses down
// to the forecast ground. mark(index) gets each brick's canonical index
// (x + X·(y + Y·z)). Async: yields between tiles.
// shell: only the surface of each tile's beam (FORECAST_SHELL_BRICKS), for
// a coarse tile (world/worldSunRings.js), whose writer needs no caster.
export async function forecastSunCasters({ size, direction, tiles, tops, mark, shell = false, yieldEvery = FORECAST_SLICE_MS }) {
  const projection = worldSunProjection(size, direction), { u, v, sun } = projection.basis;
  const [x0, y0, w] = projection.tiles, span = WORLD_SUN_TILE * WORLD_SUN_PITCH, depth = projection.depth[0];
  const n = Math.ceil(span / FORECAST_SUN_SPACING), d = sun.map((s) => -s);
  let slice = now();
  for (const tile of tiles) {
    const a0 = (x0 + tile % w) * span, b0 = (y0 + Math.floor(tile / w)) * span;
    for (let j = -FORECAST_EDGE_RAYS; j <= n + FORECAST_EDGE_RAYS; j++) {
      for (let i = -FORECAST_EDGE_RAYS; i <= n + FORECAST_EDGE_RAYS; i++) {
        // Grid points on both tile edges (clamped), and past them.
        const at = (k) => k < 0 || k > n ? k * FORECAST_SUN_SPACING : Math.min(span, k * FORECAST_SUN_SPACING);
        const a = a0 + at(i), b = b0 + at(j);
        const o = [0, 1, 2].map((k) => u[k] * a + v[k] * b + sun[k] * depth);
        forecastWalk(size, tops, o, d, mark, shell);
      }
      if (yieldEvery != null && now() - slice > yieldEvery) { await pause(); slice = now(); }
    }
  }
}

// The sun tiles the eye's point probe reads first (shaders/worldPoint.js
// sunShadowAt(cam) -> lighting.js sunMapShadowAt: its four bilinear taps around
// the eye's light-space position), so the first attempt renders them with
// their casters instead of learning them from the probe one round later.
export function forecastEyeTiles(projection, cam) {
  if (!Array.isArray(cam) && !ArrayBuffer.isView(cam)) return [];
  const p = Array.from(cam);
  if (p.length !== 3 || !p.every(Number.isFinite)) return [];
  const { u, v } = projection.basis, [x0, y0, w, h] = projection.tiles, out = new Set();
  const dot = (a) => a[0] * p[0] + a[1] * p[1] + a[2] * p[2];
  const q = [dot(u) / WORLD_SUN_PITCH, dot(v) / WORLD_SUN_PITCH], i0 = q.map((n) => Math.floor(n - 0.5));
  for (let k = 0; k < 4; k++) {
    const tx = Math.floor((i0[0] + (k & 1)) / WORLD_SUN_TILE) - x0, ty = Math.floor((i0[1] + (k >> 1)) / WORLD_SUN_TILE) - y0;
    if (tx >= 0 && ty >= 0 && tx < w && ty < h) out.add(tx + w * ty);
  }
  return [...out].sort((a, b) => a - b);
}

// The sun tiles the eye's whole view reads (shaders/gfx/worldSun.js
// sunMapShadow at every hit), forecast before the first attempt so the sun set
// is known up front: without it each wave of tiles was learnt from the view's
// feedback, one restart per wave, and each wave's casters one more (Island,
// 2026-10-22: 1 -> 4 -> 7 -> 9 ... tiles). Only tiles are forecast, never the
// view's bricks (the GPU's eye pass asks for those itself, see above); their
// casters follow from forecastSunCasters. The ground twin's hit is known only
// to its brick, so every tile the hit brick's box touches is taken.
//
// A view ray every forecastViewStep radians: half the angle a sun tile spans
// seen from across the world's diagonal (Nyquist: sampling at half a feature's
// size resolves it), so consecutive rays land under half a tile apart on
// anything facing the eye. Ground seen at a grazing angle is foreshortened past
// that; a tile only grazing rays reach is learnt from the feedback as before.
export const forecastViewStep = (size) => WORLD_SUN_TILE * WORLD_SUN_PITCH / Math.hypot(...size) / 2;
const mul4 = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function invert4(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const k = 1 / det;
  return [(a11 * b11 - a12 * b10 + a13 * b09) * k, (a02 * b10 - a01 * b11 - a03 * b09) * k, (a31 * b05 - a32 * b04 + a33 * b03) * k, (a22 * b04 - a21 * b05 - a23 * b03) * k,
    (a12 * b08 - a10 * b11 - a13 * b07) * k, (a00 * b11 - a02 * b08 + a03 * b07) * k, (a32 * b02 - a30 * b05 - a33 * b01) * k, (a20 * b05 - a22 * b02 + a23 * b01) * k,
    (a10 * b10 - a11 * b08 + a13 * b06) * k, (a01 * b08 - a00 * b10 - a03 * b06) * k, (a30 * b04 - a31 * b02 + a33 * b00) * k, (a21 * b02 - a20 * b04 - a23 * b00) * k,
    (a11 * b07 - a10 * b09 - a12 * b06) * k, (a00 * b09 - a01 * b07 + a02 * b06) * k, (a31 * b01 - a30 * b03 - a32 * b00) * k, (a20 * b03 - a21 * b01 + a22 * b00) * k];
}
const unproject = (m, x, y, z) => { const w = m[3] * x + m[7] * y + m[11] * z + m[15]; return [0, 1, 2].map((i) => (m[i] * x + m[i + 4] * y + m[i + 8] * z + m[i + 12]) / w); };
// The view's rays in world cells, from a frame's own matrices (worldRenderFrame.js
// freezeWorldView: cells -> scene by model, scene -> clip by viewProj): unit
// directions from the eye through an NDC grid FORECAST_VIEW_STEP apart.
export function worldViewRays({ cam, viewProj, model } = {}, size) {
  const ok = (m) => (Array.isArray(m) || ArrayBuffer.isView(m)) && m.length === 16 && Array.from(m).every(Number.isFinite);
  if (!ok(viewProj) || !ok(model) || !cam || !Array.from(cam).every(Number.isFinite)) return [];
  const inv = invert4(mul4(Array.from(viewProj), Array.from(model)));
  if (!inv) return [];
  const eye = Array.from(cam), dir = (x, y) => { const p = unproject(inv, x, y, 1), d = p.map((n, i) => n - eye[i]), l = Math.hypot(...d); return l > 0 ? d.map((n) => n / l) : null; };
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const l = dir(-1, 0), r = dir(1, 0), b = dir(0, -1), t = dir(0, 1);
  if (!l || !r || !b || !t) return [];
  const step = forecastViewStep(size), nx = Math.ceil(angle(l, r) / step) + 1, ny = Math.ceil(angle(b, t) / step) + 1, rays = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const d = dir(nx > 1 ? i / (nx - 1) * 2 - 1 : 0, ny > 1 ? j / (ny - 1) * 2 - 1 : 0);
    if (d) rays.push(d);
  }
  return rays;
}
// Tiles of the sun grid a world-cell box's projection touches.
function boxTiles(projection, min, max, out) {
  const { u, v } = projection.basis, [x0, y0, w, h] = projection.tiles, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = [0, 1, 2].map((i) => ((k >> i) & 1 ? max[i] : min[i]));
    [u, v].forEach((a, i) => { const q = (p[0] * a[0] + p[1] * a[1] + p[2] * a[2]) / WORLD_SUN_PITCH; lo[i] = Math.min(lo[i], q); hi[i] = Math.max(hi[i], q); });
  }
  // a texel's bilinear taps reach one texel past it (sunMapShadow i0, i0 + 1)
  for (let ty = Math.floor((lo[1] - 1) / WORLD_SUN_TILE); ty <= Math.floor((hi[1] + 1) / WORLD_SUN_TILE); ty++)
    for (let tx = Math.floor((lo[0] - 1) / WORLD_SUN_TILE); tx <= Math.floor((hi[0] + 1) / WORLD_SUN_TILE); tx++)
      if (tx - x0 >= 0 && ty - y0 >= 0 && tx - x0 < w && ty - y0 < h) out.add(tx - x0 + w * (ty - y0));
}
// The eye probe's tiles (forecastEyeTiles) and those of every view ray's first
// ground hit on the twin (open water: its surface, which the view shades).
export function forecastViewTiles(projection, { cam, rays = [], size, tops } = {}) {
  const out = new Set(forecastEyeTiles(projection, cam));
  if (!tops || !Array.isArray(size) || !cam) return [...out].sort((a, b) => a - b);
  const eye = Array.from(cam);
  for (const d of rays) {
    walkWorldBricks(size, eye, d, (x, y, z) => {
      const top = Math.max(tops.top(x, z), tops.sea > 0 ? Math.ceil(tops.sea) : 0);
      if (y * BRICK >= top) return false;
      boxTiles(projection, [x * BRICK, y * BRICK, z * BRICK], [Math.min(size[0], (x + 1) * BRICK), Math.min(size[1], (y + 1) * BRICK), Math.min(size[2], (z + 1) * BRICK)], out);
      return true;
    });
  }
  return [...out].sort((a, b) => a - b);
}

// The SOURCES a GI gather reads (shaders/gi.js giGatherFrag, World's march),
// forecast before an attempt for every probe that entered the demand: its own
// brick and its six neighbours (the burial test), then each of its GI.RAYS
// rays brick by brick, NEAR_STEPS single steps then FAR_STRIDE, until the
// light is spent. A gather reads a SOURCE it lacks as nothing and walks on,
// asking for every brick down the rest of its ray (to the world's edge on open
// ground): those far SOURCES then asked for the sun at their own lit faces and
// those tiles for their casters (Node model, 2026-10-22: 7 -> 35 tiles on
// Island from one gather pass). Forecast, the ray stops on the ground twin
// FORECAST_STOP_MARGIN bricks past the first brick it expects matter in, as a
// sun walk does, and the gather finds what it reads resident. Only adds
// requests: the gather's feedback still closes a tree, a roof or a dug hole.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));   // the WGSL's (shaders/gfx/lighting.js)
export function giRayDir(i) {   // giGatherFrag giDir: a Fibonacci lattice, y up
  const y = 1 - (2 * i + 1) / GI.RAYS, r = Math.sqrt(Math.max(1 - y * y, 0)), a = i * GOLDEN_ANGLE;
  return [r * Math.cos(a), y, r * Math.sin(a)];
}
export async function forecastGatherSources({ size, tops, probes, mark, yieldEvery = FORECAST_SLICE_MS }) {
  const dims = size.map((n) => Math.ceil(n / BRICK)), steps = giSteps({ nx: size[0], ny: size[1], nz: size[2] });
  const at = (b) => b[0] + dims[0] * (b[1] + dims[1] * b[2]), inside = (b) => b.every((n, k) => n >= 0 && n < dims[k]);
  const dirs = Array.from({ length: GI.RAYS }, (_, i) => giRayDir(i));
  let slice = now();
  for (const bc of probes) {
    for (let k = 0; k < 7; k++) {
      const b = [...bc];
      if (k > 0) b[(k - 1) >> 1] += (k & 1) ? 1 : -1;
      if (inside(b)) mark(at(b));
    }
    for (const d of dirs) {
      const q = bc.map((n) => n + 0.5), d2 = d.map((n) => n * n);
      let T = 1, past = -1;
      for (let k = 0; k < steps; k++) {
        const s = k < GI.NEAR_STEPS ? 1 : GI.FAR_STRIDE;
        for (let i = 0; i < 3; i++) q[i] += d[i] * s;
        const b = q.map(Math.floor);
        if (!inside(b)) break;
        mark(at(b));
        if (past >= 0) { if (++past >= FORECAST_STOP_MARGIN) break; continue; }
        // giGatherFrag's own stop: the brick's share of the ray, its covered
        // face share (giSrcCov) along d^2, from the lowest nearby ground, so the
        // twin never stops a ray before the gather would.
        const fill = Math.min(1, Math.max(0, (dilatedTop(tops, dims, b[0], b[2]) - b[1] * BRICK) / BRICK));
        let a = fill * (d2[0] + d2[2]) + (fill > 0 ? d2[1] : 0);
        if (a <= 0) continue;
        if (k >= GI.NEAR_STEPS) a = 1 - Math.pow(1 - a, GI.FAR_STRIDE);
        T *= 1 - a;
        if (T < GI.T_MIN) { past = 0; if (FORECAST_STOP_MARGIN === 0) break; }
      }
    }
    if (yieldEvery != null && now() - slice > yieldEvery) { await pause(); slice = now(); }
  }
}
// The sun tiles those SOURCES look the sun up in (giSourceFrag sunShadowAt at
// each lit exposed cell; the lift toward the sun leaves its tile unchanged): a
// brick the twin puts ground in with a neighbour column's ground at or under
// its top, so a face of it can be open to the sky.
export function forecastSourceTiles(projection, { size, tops, bricks }) {
  const dims = size.map((n) => Math.ceil(n / BRICK)), out = new Set();
  for (const i of bricks) {
    const x = i % dims[0], y = Math.floor(i / dims[0]) % dims[1], z = Math.floor(i / (dims[0] * dims[1]));
    if (!(y * BRICK < tops.top(x, z)) || (y + 1) * BRICK < dilatedTop(tops, dims, x, z)) continue;
    boxTiles(projection, [x * BRICK, y * BRICK, z * BRICK], [Math.min(size[0], (x + 1) * BRICK), Math.min(size[1], (y + 1) * BRICK), Math.min(size[2], (z + 1) * BRICK)], out);
  }
  return [...out].sort((a, b) => a - b);
}
