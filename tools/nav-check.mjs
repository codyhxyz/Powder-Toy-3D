// CPU check of the NPCs' walk map (src/pov/ai/nav.js), no browser or GPU: its
// A* on typed arrays against the Yuka Graph + AStar it replaced (kept below as
// the reference, built exactly as nav.js built it), both over the same stand-in
// for the world model (ai/world.js's queries over a box of cells).
//
// Maps: Dam Valley (src/arenas, with lava pools and spot fires painted in) and
// seeded random height maps with cliffs, walls, sealed plateaus, one-way pits,
// a lava-ringed island, water, roofs, gas over the ground, odd sizes (a last
// half node column) and the box's edges. For each, every node's height must
// match, and for many start/goal pairs both must agree on whether there is a
// path and on its cost (every hop must be one of the reference graph's edges);
// the share of identical paths is reported. Then the map following the world
// (a change shows after the throttle; a readback that changed nothing relinks
// nothing), and the old vs new rebuild and search times on Dam Valley; with
// --expose-gc also the heap per rebuild/search and the GCs over a bot workload.
//
// usage: node --expose-gc tools/nav-check.mjs [--pairs 1500] [--seed 7] [--no-bench]
import { Graph, NavNode, NavEdge, AStar, Vector3 as YVector3 } from 'yuka';
import { PerformanceObserver } from 'perf_hooks';
import { E, K, ELEMENTS } from '../src/elements.js';
import { buildDamValley, ARENA_SIZE } from '../src/arenas/damValley.js';
import { createNav, NAV_CELL } from '../src/pov/ai/nav.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PAIRS = +opt('pairs', 1500);
const SEED = +opt('seed', 7);
const BENCH = !args.includes('--no-bench');
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const mulberry32 = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---------------------------------------------------------------- the world model's stand-in
// A box of cells (ids, °C) with ai/world.js's queries as the nav uses them.
const KIND = ELEMENTS.map((e) => e.kind);
const OUTSIDE = -1;
function box(nx, ny, nz) {
  const ids = new Uint8Array(nx * ny * nz), temps = new Float32Array(nx * ny * nz).fill(20);
  const at = (x, y, z) => (y * nz + z) * nx + x;
  const inBox = (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < nx && y < ny && z < nz;
  let version = 1;
  function id(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y >= ny) return E.EMPTY;
    if (x < 0 || z < 0 || y < 0 || x >= nx || z >= nz) return OUTSIDE;
    return ids[at(x, y, z)];
  }
  const kind = (i) => (i === OUTSIDE ? K.SOLID : KIND[i]);
  function T(x, y, z) { x = Math.floor(x); y = Math.floor(y); z = Math.floor(z); return inBox(x, y, z) ? temps[at(x, y, z)] : 20; }
  function standAt(x, z, y = ny) {
    for (let yy = Math.min(Math.floor(y), ny - 1); yy >= -1; yy--) {
      if (yy < 0) return 0;
      const i = id(x, yy, z);
      if (i === E.EMPTY || kind(i) === K.GAS) continue;
      return yy + 1;
    }
    return 0;
  }
  const set = (x, y, z, i, t = ELEMENTS[i].temp ?? 20) => { if (inBox(x, y, z)) { ids[at(x, y, z)] = i; temps[at(x, y, z)] = t; } };
  return {
    ids, temps, set, bump() { version++; },
    get ready() { return true; }, get version() { return version; }, get dims() { return [nx, ny, nz]; },
    id, kind, T, standAt,
  };
}

// ---------------------------------------------------------------- the reference: nav.js as it was (Yuka)
const JUMP_UP = 6, SWIM_COST = 4, CLIMB_COST = 0.5, HOT_T = 300, REBUILD_S = 2, DIAG = Math.SQRT2;
function createYukaNav(world) {
  let graph = null, cols = 0, rows = 0, builtAt = -Infinity, builtVersion = -1;
  let heights = null, wet = null;
  const nodeAt = (x, z) => {
    const c = Math.floor(x / NAV_CELL), r = Math.floor(z / NAV_CELL);
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1;
  };
  function build() {
    const [nx, , nz] = world.dims;
    cols = Math.floor(nx / NAV_CELL); rows = Math.floor(nz / NAV_CELL);
    graph = new Graph();
    graph.digraph = true;
    heights = new Float32Array(cols * rows);
    wet = new Uint8Array(cols * rows);
    const blocked = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let h = 0, liquid = 0, hot = false;
        for (let dz = 0; dz < NAV_CELL; dz++)
          for (let dx = 0; dx < NAV_CELL; dx++) {
            const x = c * NAV_CELL + dx, z = r * NAV_CELL + dz;
            const y = world.standAt(x, z);
            if (y > h) h = y;
            const top = world.id(x, y - 1, z);
            if (top !== E.EMPTY && world.kind(top) === K.LIQUID) liquid++;
            if (world.T(x, y - 1, z) > HOT_T) hot = true;
          }
        heights[i] = h;
        wet[i] = liquid * 2 >= NAV_CELL * NAV_CELL ? 1 : 0;
        blocked[i] = hot ? 1 : 0;
        graph.addNode(new NavNode(i, new YVector3((c + 0.5) * NAV_CELL, h, (r + 0.5) * NAV_CELL)));
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (blocked[i]) continue;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const c2 = c + dc, r2 = r + dr;
            if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows) continue;
            const j = r2 * cols + c2;
            if (blocked[j]) continue;
            const up = heights[j] - heights[i];
            if (up > JUMP_UP) continue;
            if (dr && dc && (heights[r * cols + c2] - heights[i] > JUMP_UP || heights[r2 * cols + c] - heights[i] > JUMP_UP)) continue;
            const run = (dr && dc ? DIAG : 1) * NAV_CELL;
            const cost = run * (wet[j] ? SWIM_COST : 1) + Math.max(0, up) * CLIMB_COST;
            graph.addEdge(new NavEdge(i, j, cost));
          }
      }
    builtVersion = world.version;
  }
  return {
    get graph() { return graph; }, build,
    path(a, b, now) {
      if (!world.ready) return null;
      if (!graph || (world.version !== builtVersion && now - builtAt >= REBUILD_S)) { build(); builtAt = now; }
      const s = nodeAt(a.x, a.z), t = nodeAt(b.x, b.z);
      if (s < 0 || t < 0) return null;
      if (s === t) return [{ x: b.x, y: b.y, z: b.z }];
      const search = new AStar(graph, s, t);
      search.search();
      if (!search.found) return null;
      return search.getPath().map((i) => { const p = graph.getNode(i).position; return { x: p.x, y: p.y, z: p.z }; });
    },
    heightAt(x, z) { const i = nodeAt(x, z); return i >= 0 && heights ? heights[i] : null; },
  };
}

// a path's cost over the reference graph's edges, or NaN if a hop isn't an edge
function pathCost(graph, cols, path) {
  let sum = 0;
  for (let k = 1; k < path.length; k++) {
    const i = Math.floor(path[k - 1].z / NAV_CELL) * cols + Math.floor(path[k - 1].x / NAV_CELL);
    const j = Math.floor(path[k].z / NAV_CELL) * cols + Math.floor(path[k].x / NAV_CELL);
    const e = graph.getEdge(i, j);
    if (!e) return NaN;
    sum += e.cost;
  }
  return sum;
}

// ---------------------------------------------------------------- maps
function damValley() {
  const [nx, ny, nz] = ARENA_SIZE;
  const w = box(nx, ny, nz);
  const { ids } = buildDamValley();
  w.ids.set(ids);
  for (let i = 0; i < ids.length; i++) w.temps[i] = ELEMENTS[ids[i]].temp ?? 20;
  // hot spots: lava pools on the ground and spot fires (gas, so they don't count as ground)
  const rnd = mulberry32(99);
  for (let k = 0; k < 12; k++) {
    const x0 = Math.floor(rnd() * (nx - 8)), z0 = Math.floor(rnd() * (nz - 8)), s = 2 + Math.floor(rnd() * 6);
    for (let z = z0; z < z0 + s; z++) for (let x = x0; x < x0 + s; x++) { const y = w.standAt(x, z); if (y > 0) w.set(x, y - 1, z, E.LAVA); }
  }
  for (let k = 0; k < 40; k++) { const x = Math.floor(rnd() * nx), z = Math.floor(rnd() * nz); w.set(x, w.standAt(x, z), z, E.FIRE); }
  return w;
}

function terrain(seed, nx, ny, nz) {
  const rnd = mulberry32(seed), ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const w = box(nx, ny, nz);
  const ground = new Int32Array(nx * nz);
  const waves = Array.from({ length: 4 }, () => ({ ax: (rnd() - 0.5) * 0.4, az: (rnd() - 0.5) * 0.4, p: rnd() * 6.3, a: 1 + rnd() * 5 }));
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      let h = ny * 0.3;
      for (const v of waves) h += v.a * Math.sin(v.ax * x + v.az * z + v.p);
      ground[z * nx + x] = Math.round(h);
    }
  const rect = (fn) => {
    const x0 = ri(-4, nx - 4), z0 = ri(-4, nz - 4), sx = ri(3, nx / 3), sz = ri(3, nz / 3);
    for (let z = Math.max(0, z0); z < Math.min(nz, z0 + sz); z++)
      for (let x = Math.max(0, x0); x < Math.min(nx, x0 + sx); x++) fn(x, z, x - x0, z - z0, sx, sz);
  };
  const edge = (u, v, su, sv) => u === 0 || v === 0 || u === su - 1 || v === sv - 1;
  for (let k = 0; k < 6; k++) { const d = ri(4, 18); rect((x, z) => { ground[z * nx + x] += d; }); }                    // cliffs and plateaus
  for (let k = 0; k < 3; k++) { const d = ri(8, 14); rect((x, z, u, v, su, sv) => { ground[z * nx + x] += edge(u, v, su, sv) ? 0 : -d; }); }   // pits
  for (let k = 0; k < 5; k++) {                                                                          // walls, some with a gap
    const d = ri(7, 16), gap = rnd() < 0.5 ? ri(0, 40) : -99, along = rnd() < 0.5;
    const x0 = ri(0, nx - 1), z0 = ri(0, nz - 1), len = ri(10, Math.max(nx, nz)), thick = ri(1, 3);
    for (let l = 0; l < len; l++)
      for (let t = 0; t < thick; t++) {
        if (Math.abs(l - gap) < 3) continue;
        const x = along ? x0 + l : x0 + t, z = along ? z0 + t : z0 + l;
        if (x < nx && z < nz) ground[z * nx + x] += d;
      }
  }
  for (let k = 0; k < nx * nz / 40; k++) ground[ri(0, nz - 1) * nx + ri(0, nx - 1)] += ri(-8, 8);   // spikes and holes
  for (let x = 0; x < Math.min(nx, 12); x++) ground[x] = 0;                                         // the floor itself at an edge
  for (let i = 0; i < ground.length; i++) ground[i] = Math.max(0, Math.min(ny - 14, ground[i]));
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ground[z * nx + x]; y++) w.set(x, y, z, (x + y + z) % 5 ? E.ROCK : E.SAND);
  for (let k = 0; k < 4; k++) { const L = ri(ny * 0.2, ny * 0.45); rect((x, z) => { for (let y = ground[z * nx + x]; y < L; y++) w.set(x, y, z, E.WATER); }); }   // lakes
  for (let k = 0; k < 3; k++) rect((x, z) => { if (rnd() < 0.7) { const g = ground[z * nx + x]; if (g > 0) w.set(x, g - 1, z, E.LAVA); } });   // lava
  for (let k = 0; k < 2; k++) rect((x, z) => { const g = ground[z * nx + x]; if (g > 0 && rnd() < 0.5) w.set(x, g - 1, z, E.ROCK, 400); });   // hot rock
  rect((x, z, u, v, su, sv) => { if (edge(u, v, su, sv)) { const g = w.standAt(x, z); if (g > 0) w.set(x, g - 1, z, E.LAVA); } });   // a lava-ringed island
  for (let k = 0; k < 2; k++) { const y = ri(ny * 0.5, ny - 3); rect((x, z) => { w.set(x, y, z, E.METAL); }); }                     // roofs
  for (let k = 0; k < nx * nz / 30; k++) { const x = ri(0, nx - 1), z = ri(0, nz - 1); w.set(x, w.standAt(x, z), z, rnd() < 0.5 ? E.STEAM : E.FIRE); }   // gas
  return w;
}

// ---------------------------------------------------------------- equivalence
function compare(name, world, pairs, seed) {
  const ref = createYukaNav(world), nav = createNav(world);
  const [nx, , nz] = world.dims, cols = Math.floor(nx / NAV_CELL), rows = Math.floor(nz / NAV_CELL);
  const rnd = mulberry32(seed);
  const pt = () => {
    const e = rnd();   // a share on the box's edges and corners
    const x = e < 0.1 ? (rnd() < 0.5 ? 0 : nx - 1) : rnd() * nx, z = e > 0.05 && e < 0.15 ? (rnd() < 0.5 ? 0 : nz - 1) : rnd() * nz;
    return { x, y: 0, z };
  };
  ref.path({ x: 0, z: 0 }, { x: 0, z: 0 }, 0); nav.path({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);
  let heightsOk = true;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * NAV_CELL + 1, z = r * NAV_CELL + 1;
    if (ref.heightAt(x, z) !== nav.heightAt(x, z)) heightsOk = false;
  }
  check(`${name}: every node's height matches`, heightsOk, `${cols}×${rows} nodes`);
  let found = 0, reachBad = 0, costBad = 0, hopBad = 0, same = 0, worst = 0;
  for (let k = 0; k < pairs; k++) {
    const a = pt(), b = pt();
    const p0 = ref.path(a, b, 0), p1 = nav.path(a, b, 0);
    if (!p0 !== !p1) { reachBad++; continue; }
    if (!p0) continue;
    found++;
    if (JSON.stringify(p0) === JSON.stringify(p1)) same++;
    if (p0.length === 1) continue;
    const c0 = pathCost(ref.graph, cols, p0), c1 = pathCost(ref.graph, cols, p1);
    if (Number.isNaN(c1)) { hopBad++; continue; }
    const d = Math.abs(c0 - c1);
    worst = Math.max(worst, d);
    if (d > 1e-9 * Math.max(1, c0)) costBad++;
  }
  check(`${name}: the same pairs have a path`, !reachBad, `${found}/${pairs} found, ${reachBad} disagree`);
  check(`${name}: every hop is a reference edge`, !hopBad, `${hopBad} bad`);
  check(`${name}: the same path costs`, !costBad, `${costBad} differ, worst by ${worst}`);
  console.log(`     ${name}: ${same}/${found} paths identical waypoint for waypoint`);
  return { ref, nav };
}

const dam = damValley();
compare('Dam Valley', dam, Math.min(PAIRS, 600), SEED);
const sizes = [[64, 48, 64], [97, 64, 61], [40, 40, 130], [128, 64, 128], [33, 32, 34]];
sizes.forEach((s, k) => compare(`random ${s.join('×')} #${k}`, terrain(SEED * 1000 + k, ...s), PAIRS, SEED + k));

// ---------------------------------------------------------------- the map follows the world
{
  const w = terrain(SEED + 50, 64, 48, 64);
  const nav = createNav(w);
  const a = { x: 3, y: 0, z: 30 }, b = { x: 60, y: 0, z: 30 };
  // flatten a band across the middle so the walk is clear, then build
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) for (let y = 0; y < 48; y++) w.set(x, y, z, y < 10 ? E.ROCK : E.EMPTY);
  const p0 = nav.path(a, b, 0);
  check('dynamic: a clear field has a path', !!p0 && nav.stats.derived === 1 && nav.stats.relinked === 1, JSON.stringify(nav.stats));
  w.bump();
  nav.path(a, b, 1);
  check('dynamic: a readback within REBUILD_S is not derived', nav.stats.derived === 1);
  const p1 = nav.path(a, b, 2.5);
  check('dynamic: a readback that changed nothing is derived but not relinked', nav.stats.derived === 2 && nav.stats.relinked === 1 && JSON.stringify(p0) === JSON.stringify(p1), JSON.stringify(nav.stats));
  nav.path(a, b, 9);
  check('dynamic: no readback, nothing derived', nav.stats.derived === 2);
  // a wall across the box, far too high to jump
  for (let z = 0; z < 64; z++) for (let x = 30; x < 33; x++) for (let y = 10; y < 30; y++) w.set(x, y, z, E.WALL);
  w.bump();
  const p2 = nav.path(a, b, 10);
  check('dynamic: a wall raised since shows once derived', nav.stats.relinked === 2 && !p2, JSON.stringify(nav.stats));
  const ref = createYukaNav(w);
  check('dynamic: and the reference agrees', !ref.path(a, b, 0) && !!ref.path(b, { x: 40, y: 0, z: 5 }, 0) === !!nav.path(b, { x: 40, y: 0, z: 5 }, 10));
  // a gap in it: the walk goes through
  for (let z = 20; z < 24; z++) for (let x = 30; x < 33; x++) for (let y = 10; y < 30; y++) w.set(x, y, z, E.EMPTY);
  w.bump();
  const p3 = nav.path(a, b, 12.5), ref3 = createYukaNav(w), r3 = ref3.path(a, b, 0);
  const c3 = p3 && pathCost(ref3.graph, 32, p3), d3 = r3 && pathCost(ref3.graph, 32, r3);
  check('dynamic: a gap opened shows, same cost as the reference', !!p3 && c3 === d3 && p3.some((p) => p.z > 19 && p.z < 25 && p.x > 29 && p.x < 34), `${c3} vs ${d3}`);
  // a different box (a new map)
  const small = terrain(SEED + 51, 40, 40, 44);
  const nav2 = createNav(small), ref2 = createYukaNav(small);
  const q = [{ x: 1, y: 0, z: 1 }, { x: 38, y: 0, z: 42 }];
  check('dynamic: a fresh nav per box agrees', !!nav2.path(...q, 0) === !!ref2.path(...q, 0));
}

// ---------------------------------------------------------------- bench: Dam Valley
if (BENCH) {
  const w = dam, ref = createYukaNav(w), nav = createNav(w);
  const [nx, , nz] = w.dims;
  const rnd = mulberry32(SEED + 3);
  const pairs = Array.from({ length: 400 }, () => [{ x: rnd() * nx, y: 0, z: rnd() * nz }, { x: rnd() * nx, y: 0, z: rnd() * nz }]);
  const same = { x: 1, y: 0, z: 1 };
  ref.path(same, same, 0); nav.path(same, same, 0);
  const median = (xs) => xs.sort((p, q) => p - q)[xs.length >> 1];
  const time = (fn, reps) => { const t = []; for (let k = 0; k < reps; k++) { const t0 = performance.now(); fn(k); t.push(performance.now() - t0); } return median(t); };
  let clock = 0;
  const reb0 = time(() => ref.build(), 15);
  const reb1 = time(() => { w.bump(); clock += REBUILD_S; nav.path(same, same, clock); }, 15);
  // a changed map each time: flip a column at the far corner
  const reb2 = time((k) => { w.set(nx - 1, 80, nz - 1, k % 2 ? E.EMPTY : E.WALL); w.bump(); clock += REBUILD_S; nav.path(same, same, clock); }, 15);
  w.set(nx - 1, 80, nz - 1, E.EMPTY); w.bump(); clock += REBUILD_S; nav.path(same, same, clock); ref.build();
  const searches = (n) => { const t0 = performance.now(); for (const [a, b] of pairs) n.path(a, b, clock); return (performance.now() - t0) / pairs.length; };
  searches(ref); searches(nav);   // warm
  const s0 = Math.min(searches(ref), searches(ref)), s1 = Math.min(searches(nav), searches(nav));
  const found = pairs.filter(([a, b]) => nav.path(a, b, clock)).length;
  console.log(`bench Dam Valley ${nx}×${nz} (${(nx / NAV_CELL) * (nz / NAV_CELL)} nodes, ${[...ref.graph._edges.values()].reduce((s, e) => s + e.length, 0)} edges):`);
  console.log(`  rebuild    yuka ${reb0.toFixed(1)} ms   typed: unchanged ${reb1.toFixed(1)} ms, changed ${reb2.toFixed(1)} ms   (median)`);
  console.log(`  search     yuka ${s0.toFixed(2)} ms   typed ${s1.toFixed(2)} ms   (mean of ${pairs.length} random pairs, ${found} with a path)`);

  if (globalThis.gc) {
    const heap = () => process.memoryUsage().heapUsed;
    const perOp = (fn, reps) => { const d = []; for (let k = 0; k < reps; k++) { gc(); const h0 = heap(); fn(k); d.push(heap() - h0); } return median(d); };
    const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
    const hb0 = perOp(() => ref.build(), 5);
    const hb1 = perOp(() => { w.bump(); clock += REBUILD_S; nav.path(same, same, clock); }, 5);
    const hs0 = perOp((k) => ref.path(...pairs[k], clock), 100), hs1 = perOp((k) => nav.path(...pairs[k], clock), 100);
    console.log(`  heap/op    rebuild yuka ${kb(hb0)} typed ${kb(hb1)}   search yuka ${kb(hs0)} typed ${kb(hs1)}   (median; the typed search's is its returned path)`);
    // a minute of a 7-bot game: a rebuild every 2 s (each readback bumps the version), each bot re-plans every 1.5 s
    const gcs = (fn) => {
      gc();
      let n = 0, ms = 0;
      const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { n++; ms += e.duration; } });
      obs.observe({ entryTypes: ['gc'] });
      const t0 = performance.now();
      fn();
      const t = performance.now() - t0;
      return new Promise((done) => setTimeout(() => { obs.disconnect(); done({ n, ms, t }); }, 50));
    };
    const game = (n, rebuild) => () => {
      let k = 0;
      for (let s = 0; s < 60; s += 0.5) {
        if (s % 2 === 0) rebuild();
        for (let bot = 0; bot < 7; bot++) if ((s * 2 + bot) % 3 === 0) { const [a, b] = pairs[k++ % pairs.length]; n.path(a, b, clock); }
      }
    };
    const g0 = await gcs(game(ref, () => ref.build()));
    const g1 = await gcs(game(nav, () => { w.bump(); clock += REBUILD_S; nav.path(same, same, clock); }));
    console.log(`  7-bot min  yuka ${g0.t.toFixed(0)} ms CPU, ${g0.n} GCs (${g0.ms.toFixed(1)} ms)   typed ${g1.t.toFixed(0)} ms CPU, ${g1.n} GCs (${g1.ms.toFixed(1)} ms)`);
  } else console.log('  (run with node --expose-gc for the heap and GC numbers)');
}

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
