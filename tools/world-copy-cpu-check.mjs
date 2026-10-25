// CPU check of the world copy (docs/seamless-world.md "W"; src/shaders/world/copy.js, src/world/worldCopy.js,
// src/world/worldCopyTwin.js). No GPU:
//   1. naga on every world-copy WGSL module (its WGSL_CHECK, and the island's scene kernel);
//   2. the JS twin's compaction and allocator on a small synthetic world: built from dense cells, then random
//      writebacks (bricks turning uniform, mixed, back), every cell decoded and compared exactly with the dense
//      world after each round; slots never shared or leaked; growth never drops; occupancy against brute force;
//      V2 cores and stored bricks decoded to the words they hold;
//   3. --census island [--stride S]: Island's CPU twin (the census's: scene, structures, trees) through the
//      twin's compaction: uniform air / uniform matter / mixed bricks, table + pool bytes (stride 1: exact).
// usage: node tools/world-copy-cpu-check.mjs [--census island] [--stride 4] [--seed N]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WGSL_CHECK, wcSceneFrag, wcLayout, WC_DILATE } from '../src/shaders/world/copy.js';
import { WC_MIXED, wcUnword, wcWord } from '../src/shaders/world/cellWord.js';
import { WorldCopyTwin, wcWordOf, wcWordOfCore, wcDilated } from '../src/world/worldCopyTwin.js';
import { storedBrickWords } from '../src/world/worldCopy.js';
import { encodeNativeBrick } from '../src/world/nativeStore.js';
import { makeMaterial, FULL } from '../src/v2/layout.js';
import { BRICK_INFO } from '../src/shaders/bindings.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { LOOK } from '../src/gfx/materials.js';
import { prelude } from '../src/shaders/common.js';
import { gridLayout } from '../src/sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = 4;

// ---------------------------------------------------------------- Island's CPU twin (the census's adapter)
/** Island's cells on the CPU: { size, column(x, z) → (y) → id, treesFor(bx, bz), treeCell, cell(x, y, z) }. */
export async function islandCpu(seed = 20261008) {
  const imp = (p) => import(pathToFileURL(join(ROOT, p)));
  const { island } = await imp('src/world/scenes/island.js');
  const { islandTwin, treesIn, TREE } = await imp('src/world/generator.js');
  const { structureMaterialAt, structuresOf } = await imp('src/world/structures.js');
  const { bakeSourceTree } = await imp('src/world/renderSourceProducer.js');
  const { materialId } = await imp('src/appearance.js');
  const { WORLD_SIZE } = await imp('src/shaders/far.js');
  const P = island.params({ size: WORLD_SIZE, seed });
  const T = islandTwin(P);
  const baked = new Map(), cache = new Map();
  const bake = (t) => {
    const k = `${t.size},${t.seed},${t.variant},${t.quarter}`;
    if (!baked.has(k)) baked.set(k, bakeSourceTree(t) ?? null);
    return baked.get(k);
  };
  const treesNear = (x0, z0, x1, z1) => {
    if (cache.size > 1 << 18) cache.clear();
    const R = TREE.REACH;
    return [...treesIn(x0 - R, z0 - R, x1 + R, z1 + R, P, cache)]
      .sort((a, b) => Math.floor(a.z / 4) - Math.floor(b.z / 4) || Math.floor(a.x / 4) - Math.floor(b.x / 4) || a.z - b.z || a.x - b.x)
      .map((t) => { const s = bake(t); return s && { s, at: [t.x - s.base.x, t.y - s.base.y, t.z - s.base.z] }; })
      .filter((o) => o && o.at[0] + o.s.w > x0 && o.at[0] < x1 && o.at[2] + o.s.d > z0 && o.at[2] < z1);
  };
  // later trees win (the window's stamp order); footings left out (the census's rule)
  const treeCell = (trees, x, y, z) => {
    let out = -1;
    for (const { s, at } of trees) {
      const qx = x - at[0], qy = y - at[1], qz = z - at[2];
      if (qx < 0 || qy < 0 || qz < 0 || qx >= s.w || qy >= s.h || qz >= s.d) continue;
      const v = s.data[((qz * s.h + qy) * s.w + qx) * 4];
      if (v > 0) out = Math.round(v) - 1;
    }
    return out;
  };
  const column = (x, z) => (y) => materialId(structureMaterialAt(x, y, z, T.islandMaterial(x, y, z), P, (yy) => T.islandCell(x, yy, z)));
  // the air bound: cells at or above it are air (the census's: the ground's top, a structure's)
  const sTop = new Map();
  for (const st of structuresOf(P)) {
    const y1 = st.y - st.s.base.y + st.s.h;
    for (let z = Math.floor(st.z0 / B); z <= Math.floor((st.z0 + st.s.d - 1) / B); z++)
      for (let x = Math.floor(st.x0 / B); x <= Math.floor((st.x0 + st.s.w - 1) / B); x++) sTop.set(`${x},${z}`, Math.max(sTop.get(`${x},${z}`) ?? 0, y1));
  }
  const top = (x, z) => { const c = T.column(x, z); return Math.max(T.genTop(x, z), Math.ceil(c[3]), sTop.get(`${x >> 2},${z >> 2}`) ?? 0); };
  return {
    P, size: P.size, column, top, treesNear, treeCell,
    cell: (x, y, z) => {
      const t = treeCell(treesNear(x, z, x + 1, z + 1), x, y, z);
      return t >= 0 ? t : column(x, z)(y);
    },
  };
}

// the word a scene cell of element id gets at the build (its spawn temperature and life: scenes/index.js)
const spawnWord = (id) => wcWordOf(id, ELEMENTS[id]?.temp ?? 20, ELEMENTS[id]?.life ?? 0, 0, 1);

async function census(stride) {
  const A = await islandCpu();
  const [X, H, Z] = A.size, BX = X / B, BY = H / B, BZ = Z / B;
  const twin = new WorldCopyTwin([X, H, Z], { capacity: 1024 });
  const col = new Uint32Array(16 * H), words = new Uint32Array(64);
  let cols = 0, airU = 0, solidU = 0, mixed = 0;
  const t0 = performance.now(), off = Math.floor(stride / 2);
  for (let bz = off; bz < BZ; bz += stride) {
    for (let bx = off; bx < BX; bx += stride) {
      cols++;
      let trees = A.treesNear(bx * B, bz * B, bx * B + B, bz * B + B);
      if (!trees.length) trees = null;
      for (let lz = 0; lz < B; lz++) for (let lx = 0; lx < B; lx++) {
        const x = bx * B + lx, z = bz * B + lz, f = A.column(x, z), t = Math.min(H, A.top(x, z) + 64);
        for (let y = 0; y < H; y++) {
          let id = y < t ? f(y) : E.EMPTY;
          if (trees) { const c = A.treeCell(trees, x, y, z); if (c >= 0) id = c; }
          col[(y * 4 + lz) * 4 + lx] = spawnWord(id);
        }
      }
      for (let by = 0; by < BY; by++) {
        for (let i = 0; i < 64; i++) { const lx = i & 3, ly = (i >> 2) & 3, lz = i >> 4; words[i] = col[((by * 4 + ly) * 4 + lz) * 4 + lx]; }
        twin.commit([bx, by, bz], words);
        const e = twin.table[twin.bi([bx, by, bz])];
        if (e & WC_MIXED) mixed++;
        else if ((e & 255) === E.EMPTY) airU++;
        else solidU++;
      }
    }
    if (bz % (stride * 32) === off) console.error(`census: bz ${bz}/${BZ} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const s = (BX * BZ) / cols, MB = (b) => +(b / 2 ** 20).toFixed(1);
  const out = {
    label: 'island', stride, sec: +((performance.now() - t0) / 1000).toFixed(1), totalBricks: BX * BY * BZ,
    airU: Math.round(airU * s), solidU: Math.round(solidU * s), mixed: Math.round(mixed * s),
    tableMB: MB(4 * BX * BY * BZ), poolMB: MB(256 * mixed * s), poolAtHeadroomMB: MB(256 * 1.5 * mixed * s), infoMB: MB(4 * BX * BY * BZ),
  };
  console.log(JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------- 1. naga
function naga() {
  const dir = mkdtempSync(join(tmpdir(), 'wcopy-'));
  const grid = gridLayout(128, 128, 128);
  let bad = 0;
  const mods = WGSL_CHECK().map((c) => [c.name, c.code(grid)]);
  return import(pathToFileURL(join(ROOT, 'src/world/scenes/island.js'))).then(({ island }) => {
    mods.push(['world copy island scene', wcSceneFrag(grid, wcLayout([1024, 128, 1024]), island.glsl(grid))]);
    for (const [name, code] of mods) {
      const f = join(dir, `${name.replace(/\W+/g, '_')}.wgsl`);
      writeFileSync(f, code);
      try { execFileSync('naga', [f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`FAIL naga ${name}: ${String(e.stderr).slice(0, 800)}`); }
    }
    console.log(`naga: ${mods.length} modules, ${bad} failing`);
    return bad;
  });
}

// ---------------------------------------------------------------- 2. the twin on a synthetic world
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function synthetic(seed) {
  let bad = 0;
  const fail = (m) => { if (bad++ < 20) console.error('FAIL', m); };
  const r = rng(seed), size = [64, 32, 48], [X, Y, Z] = size;
  const dense = new Uint32Array(X * Y * Z), at = (x, y, z) => x + X * (y + Y * z);
  const air = wcWordOf(E.EMPTY, 20, 0, 0, 0);
  const pick = [E.STONE, E.SAND, E.WATER, E.WOOD, E.PLANT, E.STEAM, E.SMOKE, E.LAVA, E.OIL];
  for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) {
    const h = 8 + Math.floor(6 * Math.sin(x / 7) + 4 * Math.cos(z / 5));
    for (let y = 0; y < Y; y++) {
      let w = air;
      if (y < h - 3) w = spawnWord(E.STONE);
      else if (y < h) w = spawnWord(E.SAND);
      else if (y < 12) w = wcWordOf(E.WATER, 20, 0, 0, y === 11 ? 0.5 : 1);
      if (r() < 0.01) w = spawnWord(pick[Math.floor(r() * pick.length)]);
      if (r() < 0.002) w = wcWordOf(E.EMPTY, 80, 0, 0, 0);   // hot air: a mixed air brick
      dense[at(x, y, z)] = w;
    }
  }
  const twin = new WorldCopyTwin(size, { capacity: 4 });   // tiny: it must grow, never drop
  const brick = (bx, by, bz) => {
    const w = new Uint32Array(64);
    for (let i = 0; i < 64; i++) w[i] = dense[at(bx * 4 + (i & 3), by * 4 + ((i >> 2) & 3), bz * 4 + (i >> 4))];
    return w;
  };
  const [BX, BY, BZ] = twin.L.bricks;
  for (let bz = 0; bz < BZ; bz++) for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) twin.commit([bx, by, bz], brick(bx, by, bz));
  twin.dilateAll();
  twin.occupancy();
  const verify = (label) => {
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      if (twin.cell(x, y, z) !== dense[at(x, y, z)]) { fail(`${label}: cell ${x},${y},${z} ${twin.cell(x, y, z)} != ${dense[at(x, y, z)]}`); return; }
    }
    // slots: every MIXED entry's slot unique and below the bump, none on the free list; used = mixed bricks
    const seen = new Set(), free = new Set(twin.free);
    let mixed = 0;
    for (let i = 0; i < twin.table.length; i++) {
      const e = twin.table[i];
      if (!(e & WC_MIXED)) continue;
      mixed++;
      const s = (e & ~WC_MIXED) >>> 0;
      if (seen.has(s) || free.has(s) || s >= twin.bump) fail(`${label}: slot ${s} shared, freed or past the bump`);
      seen.add(s);
    }
    if (mixed !== twin.used) fail(`${label}: ${mixed} mixed bricks, ${twin.used} slots in use`);
    if (twin.free.length + mixed !== twin.bump) fail(`${label}: ${twin.bump - mixed - twin.free.length} slots leaked`);
    // occupancy against brute force (level 1 and 2 from the dilated info)
    const occ = twin.occupancy();
    for (let z = 0; z < Z; z += 16) for (let y = 0; y < Y; y += 16) for (let x = 0; x < X; x += 16) {
      let on = false;
      for (let bz = z / 4; bz < Math.min(z / 4 + 4, BZ); bz++) for (let by = y / 4; by < Math.min(y / 4 + 4, BY); by++) for (let bx = x / 4; bx < Math.min(x / 4 + 4, BX); bx++)
        if (twin.info[twin.bi([bx, by, bz])] & BRICK_INFO.MATTER) on = true;
      if (twin.occupied(1, x, y, z) !== on) fail(`${label}: level-1 node at ${x},${y},${z}`);
    }
    void occ;
    // matter: a brick with any non-air cell has BRICK_MATTER
    for (let bz = 0; bz < BZ; bz++) for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) {
      const w = brick(bx, by, bz), m = w.some((v) => (v & 255) !== E.EMPTY);
      if (m && !(twin.info[twin.bi([bx, by, bz])] & BRICK_INFO.MATTER)) fail(`${label}: brick ${bx},${by},${bz} holds matter, info says none`);
    }
  };
  verify('build');
  const builtMixed = twin.used;
  // writebacks: random boxes made uniform, mixed or put back
  for (let round = 0; round < 60; round++) {
    const lo = [Math.floor(r() * X), Math.floor(r() * Y), Math.floor(r() * Z)], hi = lo.map((v, i) => Math.min(size[i], v + 1 + Math.floor(r() * 12)));
    const mode = Math.floor(r() * 3), id = pick[Math.floor(r() * pick.length)];
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++)
      dense[at(x, y, z)] = mode === 0 ? air : mode === 1 ? spawnWord(id) : (r() < 0.5 ? air : spawnWord(id));
    const blo = lo.map((v) => v >> 2), bhi = hi.map((v) => (v - 1) >> 2), changed = [];
    for (let bz = blo[2]; bz <= bhi[2]; bz++) for (let by = blo[1]; by <= bhi[1]; by++) for (let bx = blo[0]; bx <= bhi[0]; bx++) { twin.commit([bx, by, bz], brick(bx, by, bz)); changed.push([bx, by, bz]); }
    // the dilation around them (as recordWriteback's set)
    const near = new Map();
    for (const [x, y, z] of changed) for (let dz = -WC_DILATE; dz <= WC_DILATE; dz++) for (let dy = -WC_DILATE; dy <= WC_DILATE; dy++) for (let dx = -WC_DILATE; dx <= WC_DILATE; dx++) {
      const b = [x + dx, y + dy, z + dz];
      if (b.every((v, i) => v >= 0 && v < twin.L.bricks[i])) near.set(twin.bi(b), b);
    }
    twin.dilate([...near.values()]);
  }
  verify('writebacks');
  // the incremental dilation equals a full one
  const inc = twin.info.slice();
  twin.dilateAll();
  for (let i = 0; i < inc.length; i++) if (inc[i] !== twin.info[i]) { fail(`incremental dilation differs at brick ${i}`); break; }
  console.log(`twin: ${size.join('x')} world, ${builtMixed} mixed built, ${twin.used} after 60 writebacks, capacity ${twin.capacity} (${twin.grows} grows from 4), ${twin.free.length} free`);
  return bad;
}

// ---------------------------------------------------------------- 2b. the GPU-driven writeback's twin
// A window over a synthetic world moves about; random edits inside it; the writeback runs over V2's record as a
// superset (the edited bricks, random untouched ones, sometimes the whole window). After each: every cell equals
// the dense world, the info equals a full dilation, the occupancy a full rebuild; exactly the bricks whose words
// changed were written and their nodes recorded; a writeback of the same record again changes nothing.
function gpuPath(seed) {
  let bad = 0;
  const fail = (m) => { if (bad++ < 20) console.error('FAIL gpu path:', m); };
  const r = rng(seed), size = [64, 32, 48], [X, Y, Z] = size, at = (x, y, z) => x + X * (y + Y * z);
  const air = wcWordOf(E.EMPTY, 20, 0, 0, 0);
  const pick = [E.STONE, E.SAND, E.WATER, E.WOOD, E.PLANT, E.STEAM, E.SMOKE, E.LAVA, E.OIL];
  const dense = new Uint32Array(X * Y * Z);
  for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) for (let y = 0; y < Y; y++)
    dense[at(x, y, z)] = y < 6 ? spawnWord(E.STONE) : y < 9 ? wcWordOf(E.WATER, 20, 0, 0, 1) : air;
  const brick = (b) => { const w = new Uint32Array(64); for (let i = 0; i < 64; i++) w[i] = dense[at(b[0] * 4 + (i & 3), b[1] * 4 + ((i >> 2) & 3), b[2] * 4 + (i >> 4))]; return w; };
  const twin = new WorldCopyTwin(size, { capacity: 16 }), [BX, BY, BZ] = twin.L.bricks;
  for (let bz = 0; bz < BZ; bz++) for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) twin.commit([bx, by, bz], brick([bx, by, bz]));
  twin.dilateAll();
  twin.occupancy();
  const g = { nx: 32, ny: 32, nz: 24 }, GB = [8, 8, 6];
  let changedTotal = 0, candTotal = 0, nodesTotal = 0, seedsTotal = 0;
  for (let round = 0; round < 80; round++) {
    const O = [16 * Math.floor(r() * 3), 0, 8 * Math.floor(r() * 4)];
    const before = new Map();
    const edited = new Set();
    for (let e = 0, n = 1 + Math.floor(r() * 4); e < n; e++) {
      const lo = [0, 1, 2].map((k) => O[k] + Math.floor(r() * [g.nx, g.ny, g.nz][k])), hi = lo.map((v, k) => Math.min(O[k] + [g.nx, g.ny, g.nz][k], v + 1 + Math.floor(r() * 6)));
      const kind = Math.floor(r() * 4), id = pick[Math.floor(r() * pick.length)];
      for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
        const b = `${(x >> 2) - O[0] / 4},${y >> 2},${(z >> 2) - O[2] / 4}`;
        if (!edited.has(b)) edited.add(b);
        // 3: rewritten exactly as it was (a write that changes nothing)
        dense[at(x, y, z)] = kind === 0 ? air : kind === 1 ? spawnWord(id) : kind === 2 ? wcWordOf(E.WATER, 20, 0, 0, r() < 0.5 ? 1 : 0.5) : dense[at(x, y, z)];
      }
    }
    // the record: the edited bricks plus untouched ones (a tile's box, the air's), or every window brick
    const cand = new Map();
    for (const k of edited) cand.set(k, k.split(',').map(Number));
    if (r() < 0.15) { for (let z = 0; z < GB[2]; z++) for (let y = 0; y < GB[1]; y++) for (let x = 0; x < GB[0]; x++) cand.set(`${x},${y},${z}`, [x, y, z]); }
    else for (let i = 0; i < 20; i++) { const b = [0, 1, 2].map((k) => Math.floor(r() * GB[k])); cand.set(b.join(), b); }
    const ob = O.map((v) => v / 4), expect = new Set();
    for (const wb of cand.values()) { const b = wb.map((v, k) => v + ob[k]); const now = brick(b), was = twin.words(b); if (now.some((v, i) => v !== was[i])) expect.add(b.join()); }
    void before;
    let out;
    try { out = twin.gpuWriteback(g, O, [...cand.values()], (wb) => brick(wb.map((v, k) => v + ob[k]))); } catch (e) { fail(`round ${round}: ${e.message}`); break; }
    candTotal += cand.size; changedTotal += out.changed.length; nodesTotal += out.nodes.length; seedsTotal += out.seeds.length;
    const got = new Set(out.changed.map((b) => b.join()));
    if (got.size !== expect.size || [...expect].some((k) => !got.has(k))) fail(`round ${round}: wrote ${got.size} bricks, ${expect.size} changed`);
    const nodeOf = (k) => { const b = k.split(',').map(Number).map((v) => v >> 2); return b[0] + twin.L.n1[0] * (b[1] + twin.L.n1[1] * b[2]); };
    const wantNodes = new Set([...expect].map(nodeOf));
    if (out.nodes.length !== wantNodes.size || out.nodes.some((n) => !wantNodes.has(n))) fail(`round ${round}: ${out.nodes.length} change nodes, ${wantNodes.size} expected`);
    // the same record again: nothing changed, nothing recorded
    const again = twin.gpuWriteback(g, O, [...cand.values()], (wb) => brick(wb.map((v, k) => v + ob[k])));
    if (again.changed.length || again.nodes.length || again.seeds.length) fail(`round ${round}: an unchanged writeback wrote ${again.changed.length} bricks`);
  }
  // cells, info, occupancy against the dense world rebuilt from scratch
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) if (twin.cell(x, y, z) !== dense[at(x, y, z)]) { fail(`cell ${x},${y},${z}`); z = Z; break; }
  const ref = new WorldCopyTwin(size, { capacity: 16 });
  for (let bz = 0; bz < BZ; bz++) for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) ref.commit([bx, by, bz], brick([bx, by, bz]));
  ref.dilateAll();
  for (let i = 0; i < ref.info.length; i++) if (ref.info[i] !== twin.info[i]) { fail(`info of brick ${i}: ${twin.info[i].toString(16)} != ${ref.info[i].toString(16)}`); break; }
  const occ = twin.occ.slice(), full = ref.occupancy();
  for (let i = 0; i < full.length; i++) if (occ[i] !== full[i]) { fail(`occupancy word ${i}`); break; }
  console.log(`gpu path: 80 writebacks over ${candTotal} candidate bricks, ${changedTotal} changed (${seedsTotal} own bits changed), ${nodesTotal} change nodes; repeats changed nothing`);
  return bad;
}

// V2 cores and stored bricks to words
function cores() {
  let bad = 0;
  const fail = (m) => { if (bad++ < 20) console.error('FAIL', m); };
  for (const [id, T, amount] of [[E.STONE, 20, FULL], [E.WATER, 20, FULL], [E.WATER, 35, FULL / 2], [E.LAVA, 1200, FULL], [E.EMPTY, 21, 0], [E.EMPTY, 90, 0], [E.STEAM, 120, FULL], [E.WOOD, 20, FULL]]) {
    const m = makeMaterial(id, T, amount), w = wcWordOfCore(m.core), u = wcUnword(w);
    const expect = id === E.EMPTY ? (Math.abs(T - 20) <= 3 ? 0 : 0) : id;
    if (u.id !== expect) fail(`core ${ELEMENTS[id].key}: id ${u.id}`);
    if (Math.abs(u.t - (id === E.EMPTY && Math.abs(T - 20) <= 3 ? 20 : T)) > Math.max(0.6, T * 0.025)) fail(`core ${ELEMENTS[id].key} ${T} °C: ${u.t.toFixed(1)}`);
    if (ELEMENTS[id].kind === K.LIQUID && Math.abs(u.aux - amount / FULL) > 0.5 / 127) fail(`core ${ELEMENTS[id].key}: fill ${u.aux}`);
  }
  // a stored brick: cores in slot order, the words x + 4 (y + 4 z)
  const core = new Uint32Array(256), slot = (x, y, z) => x + 4 * (y & 1) + 8 * (z + 4 * (y >> 1));
  const ids = [E.STONE, E.SAND, E.WATER, E.WOOD];
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) core.set(makeMaterial(ids[(x + 2 * y + 3 * z) % 4], 20, FULL).core, slot(x, y, z) * 4);
  const words = storedBrickWords(encodeNativeBrick(core, new Int32Array(64)));
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    if ((words[x + 4 * (y + 4 * z)] & 255) !== ids[(x + 2 * y + 3 * z) % 4]) fail(`stored brick: cell ${x},${y},${z}`);
  console.log(`cores: V2 cores and a stored brick decode ${bad ? 'with errors' : 'as made'}`);
  return bad;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  let bad = 0;
  bad += await naga();
  bad += synthetic(+opt('seed', 7));
  bad += cores();
  bad += gpuPath(+opt('seed', 7) + 1);
  if (opt('census', null) === 'island') await census(+opt('stride', 4));
  console.log(bad ? `world-copy-cpu-check: ${bad} failures` : 'world-copy-cpu-check: ok');
  process.exit(bad ? 1 : 0);
}
export { census, spawnWord, wcWord, prelude, LOOK };
