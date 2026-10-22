// CPU model of a WORLD load's demand loop (src/wire/worldRender.js attempt()),
// against a World scene's own ground twin (scene.ground): which bricks, sun
// tiles, GI sources and probes each stage asks for, attempt by attempt, until
// the eye and the scene ask for nothing more. Used by
// tools/world-demand-chain-cpu-check.mjs. CPU only: no browser, no GPU.
//
// What each stage reads (and so asks for when it lacks it) mirrors the shaders:
// - sun (shaders/worldSunWriter.js): every texel walks from the world's top
//   toward the ground; a brick it has no page for is walked through and asked
//   for (CELL), down to the first resident brick its ray meets matter in. With
//   rings (world/worldSunRings.js) only the near tiles are walked so: a far
//   tile is drawn coarse from the ground twin (shaders/worldSunCoarse.js),
//   which reads no page and asks for nothing.
// - source (shaders/gi.js giSourceFrag): a brick with matter reads its face
//   neighbours' cells (giOpaque: RAW of a neighbour brick), its own previous
//   probe (worldGIPreviousProbe: GI, unless a birth), and for every cell with a
//   sunlit exposed face the sun map at the cell (sunShadowAt: its 4 taps' tiles).
// - gather (giGatherFrag): a probe reads the SOURCE of its own brick and its 6
//   neighbours, then marches its 32 rays reading every brick's SOURCE until the
//   light is spent (GI.T_MIN) or the ray leaves the world; a missing SOURCE is
//   asked for and read as nothing, so the ray walks on.
// - view (the eye probe and the scene): each pixel's ray walks through bricks it
//   has no page for (CELL) to its first hit; there it reads the cells around the
//   hit (the cubic field's support), the 8 GI probes in front of it and the sun
//   map's taps at it.
// The matter is the twin's heightfield (solid under scene.ground, water counted
// as its surface): caves, overhangs and trees are not modelled, so the counts
// are the loop's shape on the real terrain, not the GPU's exact numbers.
import { worldSunProjection, WORLD_SUN_PITCH, WORLD_SUN_TILE } from '../src/world/worldSun.js';
import { worldColumnTops, forecastSunCasters, forecastViewTiles, worldViewRays, forecastGatherSources, forecastSourceTiles } from '../src/world/worldSunForecast.js';
import { BRICK } from '../src/shaders/common.js';
import { GI, giSteps } from '../src/shaders/gi.js';
import { READY } from '../src/world/renderAtlas.js';
import { worldSourceEligible, WORLD_SUPPORT_STAGES } from '../src/wire/worldRender.js';
import { selectWorldGI } from '../src/world/worldLightingHistory.js';
import { worldSunRings } from '../src/world/worldSunRings.js';
import { worldGIBrickNear, worldGIProxyCoverage } from '../src/world/worldGIRing.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CUBIC_SUPPORT = 2;          // cells a cubic field tap reaches past a hit (worldFieldCubic)
const PROBE_FRONT = BRICK / 2;    // cells in front of a hit its probes are read at (surfaces read probes from in front)
const VIEW_SAMPLE = 0.5;          // cells between a view ray's matter tests inside a resident brick
const SUN_SPACING = BRICK / Math.SQRT2 / 2;   // model sun rays: twice the forecast's density (worldSunForecast.js)

export function demandWorld({ size, scene, P, sun }) {
  const dims = size.map((n) => n / BRICK), heights = new Float32Array(size[0] * size[2]).fill(-1), water = new Uint8Array(size[0] * size[2]);
  // Open water (a column topped at or under the sea) is not opaque: its sun
  // goes through to the bed, its bricks light nothing (no opaque cell), and the
  // twin does not know the bed, so the model puts it on the generator floor.
  const sea = Number.isFinite(P?.sea) ? P.sea : 0, bed = Number.isFinite(P?.floor) ? P.floor : 0;
  const h = (x, z) => {
    x = Math.min(size[0] - 1, Math.max(0, Math.floor(x))); z = Math.min(size[2] - 1, Math.max(0, Math.floor(z)));
    const k = x + size[0] * z;
    let g = heights[k];
    if (g < 0) { try { g = Math.max(0, Math.min(size[1], Math.floor(scene.ground(x, z, P)))); } catch { g = 0; } if (sea > 0 && g <= sea) { g = bed; water[k] = 1; } heights[k] = g; }
    return g;
  };
  // what the view sees: the water's surface over open water
  const seen = (x, z) => { const g = h(x, z); return water[Math.min(size[0] - 1, Math.max(0, Math.floor(x))) + size[0] * Math.min(size[2] - 1, Math.max(0, Math.floor(z)))] ? sea : g; };
  const index = (x, y, z) => x + dims[0] * (y + dims[1] * z);
  const brick = (i) => [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))];
  const projection = worldSunProjection(size, sun), { u, v } = projection.basis, [tx0, ty0, tw, th] = projection.tiles;
  const tilesAt = (p, out) => {
    const q = [(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / WORLD_SUN_PITCH, (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / WORLD_SUN_PITCH];
    const i0 = q.map((n) => Math.floor(n - 0.5));
    for (let k = 0; k < 4; k++) {
      const x = Math.floor((i0[0] + (k & 1)) / WORLD_SUN_TILE) - tx0, y = Math.floor((i0[1] + (k >> 1)) / WORLD_SUN_TILE) - ty0;
      if (x >= 0 && y >= 0 && x < tw && y < th) out.add(x + tw * y);
    }
  };
  const infos = new Map();
  // A brick's matter as the shaders see it: any matter, its per-axis covered
  // share (giSrcCov), which faces have matter on the boundary (giOpaque reads
  // across), and the points its sunlit exposed cells look the sun up at.
  function info(i) {
    let r = infos.get(i);
    if (r) return r;
    const [bx, by, bz] = brick(i), y0 = by * BRICK, y1 = y0 + BRICK, x0 = bx * BRICK, z0 = bz * BRICK;
    const col = [], rowsX = new Set(), rowsZ = new Set();
    let colsCovered = 0, any = false;
    const faces = [false, false, false, false, false, false];   // -x +x -y +y -z +z
    const sunPoints = [];
    for (let lz = 0; lz < BRICK; lz++) for (let lx = 0; lx < BRICK; lx++) {
      const g = h(x0 + lx, z0 + lz), top = Math.min(g, y1);
      col.push(g);
      if (g <= y0) continue;
      any = true; colsCovered++;
      for (let y = y0; y < top; y++) { rowsX.add((y - y0) + BRICK * lz); rowsZ.add(lx + BRICK * (y - y0)); }
      if (lx === 0) faces[0] = true; if (lx === BRICK - 1) faces[1] = true; faces[2] = true;
      if (g >= y1) faces[3] = true;
      if (lz === 0) faces[4] = true; if (lz === BRICK - 1) faces[5] = true;
      // sunlit exposed cells of this column: its top (when inside the brick),
      // and its sides toward the sun down to the sunward neighbour's ground
      let low = top;
      if (g <= y1 && sun[1] > 0) low = top - 1;
      const sx = sun[0] > 0 ? 1 : -1, sz = sun[2] > 0 ? 1 : -1;
      if (sun[0] !== 0) low = Math.min(low, Math.max(y0, h(x0 + lx + sx, z0 + lz)));
      if (sun[2] !== 0) low = Math.min(low, Math.max(y0, h(x0 + lx, z0 + lz + sz)));
      if (low < top) {
        for (const y of new Set([low, top - 1])) sunPoints.push([x0 + lx + 0.5 + sun[0] * GI.SUN_LIFT, y + 0.5 + sun[1] * GI.SUN_LIFT, z0 + lz + 0.5 + sun[2] * GI.SUN_LIFT]);
      }
    }
    const face = BRICK * BRICK;
    r = { any, cov: [rowsX.size / face, colsCovered / face, rowsZ.size / face], faces, sunPoints, col, y0 };
    if (!any) { r.sunPoints = null; r.col = null; }
    infos.set(i, r);
    return r;
  }
  const hasMatterAt = (x, y, z) => y < h(x, z);
  return { size, dims, h, seen, index, brick, projection, tilesAt, info, hasMatterAt, scene, P };
}

// Brick DDA with each brick's entry/exit t, cells. visit(x, y, z, t0, t1) returns true to stop.
function march(size, o, d, visit) {
  const dims = size.map((n) => n / BRICK);
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) { if (o[i] < 0 || o[i] >= size[i]) return; continue; }
    let a = -o[i] / d[i], b = (size[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
  }
  if (!(t0 < t1)) return;
  let t = t0 + 1e-6;
  const cell = [0, 0, 0], step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
  for (let i = 0; i < 3; i++) {
    const p = (o[i] + d[i] * t) / BRICK;
    cell[i] = Math.min(dims[i] - 1, Math.max(0, Math.floor(p)));
    if (d[i] > 0) { step[i] = 1; tDelta[i] = BRICK / d[i]; tMax[i] = t + (cell[i] + 1 - p) * tDelta[i]; }
    else if (d[i] < 0) { step[i] = -1; tDelta[i] = -BRICK / d[i]; tMax[i] = t + (p - cell[i]) * tDelta[i]; }
  }
  for (;;) {
    const ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2), out = Math.min(tMax[ax], t1);
    if (visit(cell[0], cell[1], cell[2], t, out)) return;
    t = tMax[ax];
    if (t >= t1) return;
    cell[ax] += step[ax];
    if (cell[ax] < 0 || cell[ax] >= dims[ax]) return;
    tMax[ax] += tDelta[ax];
  }
}
// The first matter a ray meets inside [t0, t1], or -1.
function firstMatter(w, o, d, t0, t1, top = w.h) {
  for (let t = t0; t <= t1; t += VIEW_SAMPLE) { const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t; if (y < top(x, z)) return t; }
  return -1;
}

// The scene camera: pixel rays of a frustum looking from cam toward target.
export function viewRays({ cam, target, width, height, vfov }) {
  const f = target.map((n, i) => n - cam[i]), fl = Math.hypot(...f), fw = f.map((n) => n / fl);
  let r = [fw[2], 0, -fw[0]]; const rl = Math.hypot(...r); r = r.map((n) => n / rl);
  const up = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
  const ty = Math.tan(vfov / 2), tx = ty * width / height, rays = [];
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const a = ((i + 0.5) / width * 2 - 1) * tx, b = (1 - (j + 0.5) / height * 2) * ty;
    const d = fw.map((n, k) => n + a * r[k] - b * up[k] * -1);
    const l = Math.hypot(...d); rays.push(d.map((n) => n / l));
  }
  return rays;
}

// One load: attempts until the eye and the scene's feedback are complete.
// policy: { forecast: 'none' | 'casters' | 'view' }, matching worldRender.js.
// forecast: 'none' (before 186cefd7), 'eye' (186cefd7: the eye probe's tiles
// and every tile's casters), 'view' (also the whole view's tiles, from values).
// sources: 'all' (every record a SOURCE at the reset, before this fix) or
// 'eligible' (worldSourceEligible). resetBirths: worldGI.js's reset births.
// rings: far sun tiles coarse (worldRender.js forecast(); false: every tile
// full detail, as before 2026-10-22's rings). sharp: tiles already sharp on
// this sun grid (a later load of the same owner); sharpen: tiles to sharpen
// past the near ring (a load that follows a shown frame).
// giRing: the light bounce's near ring radius (cells; world/worldGIRing.js):
// a gather asks for a missing SOURCE only inside it, and past it reads the
// ground twin's stand-in (null: every read asks, as before 2026-10-22's ring).
export async function modelLoad(w, { cam, rays, values, sun, forecast = 'view', sources: sourcePolicy = 'eligible', resetBirths = true, rings = false, giRing = null, sharp = new Set(), sharpen = 0, maxAttempts = 40, log = null }) {
  const { size, dims, index, brick, info } = w;
  const req = new Map(), support = new Set(), sunTiles = new Set(), forecastTiles = new Set(sharp), forecastProbes = new Set(), ownedSources = new Set();
  let coarse = new Set(), sharpened = false, fineTiles = [];
  const shellTiles = new Set();
  let stage = 'cell';
  // worldRender.js add(): a brick first asked for by a support stage is support
  // bricks first asked for by each stage, and every brick a gather (or its
  // forecast) asked for: the light bounce's own demand (world/worldGIRing.js)
  const byStage = {}, giAsked = new Set();
  const add = (i, bits) => {
    const old = req.get(i), sup = WORLD_SUPPORT_STAGES.has(stage);
    if (old === undefined) byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (stage === 'gather' || stage === 'gather forecast') giAsked.add(i);
    if (old === undefined && sup) support.add(i); else if (!sup) support.delete(i);
    if (((old ?? 0) | bits) !== old) { req.set(i, (old ?? 0) | bits); return true; }
    return false;
  };
  const camBrick = index(...cam.map((n, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor(n / BRICK)))));
  add(camBrick, READY.CELL);
  const tops = forecast === 'none' ? null : worldColumnTops({ size, scene: w.scene, P: w.P });
  const history = [];
  let attempts = 0, done = false, forecastEye = false, viewTiles = 0, sourceTiles = 0;
  while (attempts < maxAttempts) {
    attempts++;
    // forecast (worldRender.js forecast())
    if (tops) {
      if (!forecastEye) {
        forecastEye = true;
        for (const i of forecastViewTiles(w.projection, forecast === 'view' ? { cam, rays: worldViewRays(values, size), size, tops } : { cam })) sunTiles.add(i);
      }
      if (forecast === 'view') {
        const probes = [...req].filter(([i, bits]) => bits & READY.GI && !forecastProbes.has(i)).map(([i]) => i);
        if (probes.length) {
          stage = 'gather forecast';   // gather demand, not support (worldRender.js forecast)
          const read = new Set();
          await forecastGatherSources({ size, tops, probes: probes.map(brick), mark: (i) => read.add(i), ring: giRing == null ? null : { eye: cam, radius: giRing }, yieldEvery: null });
          probes.forEach((i) => forecastProbes.add(i));
          for (const i of read) add(i, READY.GI_SOURCE);
          for (const i of forecastSourceTiles(w.projection, { size, tops, bricks: read })) sunTiles.add(i);
        }
      }
      let fine = [...sunTiles];
      if (rings) {
        const r = worldSunRings(w.projection, cam, fine, { sharp: forecastTiles, coarse: true, sharpen: sharpened ? 0 : sharpen });
        if (r.sharpened.length) sharpened = true;
        fine = r.fine; coarse = new Set(r.coarse);
      }
      fineTiles = fine;
      if (rings) {
        const shells = [...coarse].filter((i) => !shellTiles.has(i));
        if (shells.length) {
          stage = 'forecast';
          await forecastSunCasters({ size, direction: sun, tiles: shells, tops, shell: true, mark: (i) => add(i, READY.CELL), yieldEvery: null });
          shells.forEach((i) => shellTiles.add(i));
        }
      }
      const tiles = fine.filter((i) => !forecastTiles.has(i));
      if (tiles.length) {
        stage = 'forecast';
        await forecastSunCasters({ size, direction: sun, tiles, tops, mark: (i) => add(i, READY.CELL), yieldEvery: null });
        tiles.forEach((i) => forecastTiles.add(i));
      }
    }
    const resident = new Set(req.keys());
    // worldRender.js attempt(): records, then history.begin's mode-2 selection
    // plus the typed SOURCE requests; probes are the typed GI recipients.
    const records = [...req].map(([i, bits]) => ({ brick: brick(i), age: 0, matter: info(i).any, near: false, probeEligible: !!(bits & READY.GI),
      ...(sourcePolicy === 'eligible' ? { sourceEligible: worldSourceEligible(i, { requirements: req, support, ownedSources }) } : {}) }));
    const selection = selectWorldGI({ records, lightingTick: 0, mode: 2 });
    const sources = new Set(selection.sourceBricks.map((b) => index(...b))), probes = new Set(selection.gatherBricks.map((g) => index(...g.brick)));
    for (const [i, bits] of req) if (bits & READY.GI_SOURCE) sources.add(i);
    const row = { attempt: attempts, requirements: req.size, sunTiles: sunTiles.size, coarseTiles: coarse.size, support: support.size, sources: sources.size, gathers: probes.size };
    history.push(row);
    stage = 'sun';
    let grew = false;
    // sun: each tile's texel walks
    {
      const { u, v, sun: s } = w.projection.basis, span = WORLD_SUN_TILE * WORLD_SUN_PITCH, depth = w.projection.depth[0], d = s.map((n) => -n);
      const n = Math.ceil(span / SUN_SPACING);
      for (const tile of sunTiles) {
        if (coarse.has(tile)) continue;   // coarse: the ground twin's heightfield, no page read
        const a0 = (w.projection.tiles[0] + tile % w.projection.tiles[2]) * span, b0 = (w.projection.tiles[1] + Math.floor(tile / w.projection.tiles[2])) * span;
        for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
          const a = a0 + Math.min(span, k * SUN_SPACING), b = b0 + Math.min(span, j * SUN_SPACING);
          const o = [0, 1, 2].map((m) => u[m] * a + v[m] * b + s[m] * depth);
          march(size, o, d, (x, y, z, t0, t1) => {
            const i = index(x, y, z);
            if (!resident.has(i)) { grew = add(i, READY.CELL) || grew; return false; }
            return info(i).any && firstMatter(w, o, d, t0, t1) >= 0;
          });
        }
      }
    }
    if (grew) { row.stage = stage; log?.(row); continue; }
    // source: neighbours, own previous probe, sun taps
    stage = 'source';
    const born = probes;   // every probe of a first load is a birth
    for (const i of sources) {
      const r = info(i);
      if (!r.any) continue;
      const b = brick(i);
      r.faces.forEach((has, f) => {
        if (!has) return;
        const nb = [...b]; nb[f >> 1] += (f & 1) ? 1 : -1;
        if (nb.some((n, k) => n < 0 || n >= dims[k])) return;
        const j = index(...nb);
        if (!resident.has(j)) grew = add(j, READY.RAW) || grew;
      });
      if (!resetBirths && !born.has(i)) grew = add(i, READY.GI) || grew;
      const tiles = new Set();
      for (const p of r.sunPoints) w.tilesAt(p, tiles);
      for (const t of tiles) if (!sunTiles.has(t)) { sunTiles.add(t); grew = true; sourceTiles++; }
    }
    if (grew) { row.stage = stage; log?.(row); continue; }
    // gather: 7-brick burial test, then 32 rays
    stage = 'gather';
    const steps = giSteps({ nx: size[0], ny: size[1], nz: size[2] });
    // a SOURCE the attempt holds; else inside the ring asked for (and read as
    // nothing); past it the ground twin's stand-in (worldGI.js worldGISourceFar)
    const groundTops = giRing == null ? null : (tops ?? worldColumnTops({ size, scene: w.scene, P: w.P }));
    const readSource = (j) => {
      if (sources.has(j)) return info(j);
      const b = brick(j);
      if (giRing == null || worldGIBrickNear(cam, b, giRing)) { grew = add(j, READY.GI_SOURCE) || grew; return null; }
      const cov = worldGIProxyCoverage(groundTops.top(b[0], b[2]), b[1]);
      return { any: cov[1] > 0, cov };
    };
    for (const i of probes) {
      const bc = brick(i);
      let blk = 1;
      for (let k = 0; k < 7; k++) {
        const nb = [...bc]; if (k > 0) nb[(k - 1) >> 1] += (k & 1) ? 1 : -1;
        if (nb.some((n, m) => n < 0 || n >= dims[m])) { blk = 0; break; }
        const r = readSource(index(...nb));
        blk = Math.min(blk, r ? Math.min(...r.cov) : 0);
      }
      if (blk > GI.BURIED) continue;
      for (let ray = 0; ray < GI.RAYS; ray++) {
        const y = 1 - (2 * ray + 1) / GI.RAYS, rr = Math.sqrt(Math.max(1 - y * y, 0)), a = ray * GOLDEN_ANGLE, d = [rr * Math.cos(a), y, rr * Math.sin(a)];
        const q = bc.map((n) => n + 0.5);
        let T = 1;
        for (let k = 0; k < steps; k++) {
          const st = k < GI.NEAR_STEPS ? 1 : GI.FAR_STRIDE;
          for (let m = 0; m < 3; m++) q[m] += d[m] * st;
          const nb = q.map(Math.floor);
          if (nb.some((n, m) => n < 0 || n >= dims[m])) break;
          const r = readSource(index(...nb));
          if (!r || !r.any) continue;
          let al = r.cov[0] * d[0] * d[0] + r.cov[1] * d[1] * d[1] + r.cov[2] * d[2] * d[2];
          if (al <= 0) continue;
          if (k >= GI.NEAR_STEPS) al = 1 - Math.pow(1 - al, GI.FAR_STRIDE);
          T *= 1 - al;
          if (T < GI.T_MIN) break;
        }
      }
    }
    if (grew) { row.stage = stage; log?.(row); continue; }
    // probe-ready: the eye probe and the scene
    stage = 'view';
    const wantCell = (p) => {
      for (let z = Math.floor((p[2] - CUBIC_SUPPORT) / BRICK); z <= Math.floor((p[2] + CUBIC_SUPPORT) / BRICK); z++)
        for (let y = Math.floor((p[1] - CUBIC_SUPPORT) / BRICK); y <= Math.floor((p[1] + CUBIC_SUPPORT) / BRICK); y++)
          for (let x = Math.floor((p[0] - CUBIC_SUPPORT) / BRICK); x <= Math.floor((p[0] + CUBIC_SUPPORT) / BRICK); x++)
            if (x >= 0 && y >= 0 && z >= 0 && x < dims[0] && y < dims[1] && z < dims[2]) grew = add(index(x, y, z), READY.CELL) || grew;
    };
    const wantProbes = (p) => {
      const q = p.map((n, k) => Math.max(0, Math.min(dims[k] - 1, n / BRICK - 0.5))), base = q.map(Math.floor);
      for (let k = 0; k < 8; k++) {
        const b = [0, 1, 2].map((m) => Math.min(dims[m] - 1, base[m] + ((k >> m) & 1)));
        grew = add(index(...b), READY.GI) || grew;
      }
    };
    const wantSun = (p) => { const t = new Set(); w.tilesAt(p, t); for (const i of t) if (!sunTiles.has(i)) { sunTiles.add(i); grew = true; viewTiles++; } };
    wantCell(cam); wantProbes(cam); wantSun(cam);
    for (const d of rays) {
      march(size, cam, d, (x, y, z, t0, t1) => {
        const i = index(x, y, z);
        if (!resident.has(i)) { grew = add(i, READY.CELL) || grew; return false; }
        if (!info(i).any && !(y * BRICK < w.seen(x * BRICK + 2, z * BRICK + 2))) return false;
        const t = firstMatter(w, cam, d, t0, t1, w.seen);
        if (t < 0) return false;
        const p = cam.map((n, k) => n + d[k] * t);
        wantCell(p); wantSun(p); wantProbes([p[0], p[1] + PROBE_FRONT, p[2]]);
        return true;
      });
    }
    row.stage = stage; log?.(row);
    if (!grew) { done = true; break; }
  }
  return { attempts, done, history, byStage, giAsked, requirements: req.size, sunTiles: sunTiles.size, coarseTiles: coarse.size, fineTiles, coarse: [...coarse], forecastTiles: [...forecastTiles], sources: history.at(-1)?.sources ?? 0, gathers: history.at(-1)?.gathers ?? 0, viewTiles, sourceTiles };
}
