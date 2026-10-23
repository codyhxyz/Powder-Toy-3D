// A big map's GPU page budget decides what it drops and evicts in slices,
// without sorting the demand, and decides exactly what it decided before.
// CPU only: the budget's rules (world/worldViewRing.js worldBudgetDemand,
// worldBudgetDemandSteps, worldFarthestSteps) and the owner's pass
// (wire/worldRender.js worldBudgetPass) against d62feb64's, verbatim
// (tools/world-budget-reference.mjs), over a stand-in atlas.
//
// Descent sat over its page budget, so every transaction ran the budget's
// over-budget path: a sort of every brick of the demand by its distance from
// the eye for each rule, then the evictions, in one task. Real Chrome with
// the user's settings (2026-10-22): 1.1 s blocked as a view round loaded ~96k
// bricks, ~2 s of every 40. Here:
//   - random demands, eyes (ties included: eyes on brick centres), budgets,
//     pool room, held, fresh and resident sets: the rule drops the same bricks
//     in the same order, keeps the same demand and lowers the same floors,
//     run straight through and in small slices;
//   - the farthest-first walk visits the bricks of a full sort, in its order;
//   - the owner's pass leaves the same demand, requirements, support, dropped
//     and squeezed sets, evicts the same pages in the same order, reclaims the
//     same counts and logs the same lines, through every branch (the
//     demand's drops, the reclaim, both evictions, the near-ring squeeze);
//   - its largest synchronous chunk, in counted Map/Set operations, brick
//     decodes, hypots and sort comparisons between two yields, stays under
//     OPS_PER_UNIT times a slice's units and the same with GROWTH times the
//     demand: counted work, not the map's size (atlas.remove, one commit,
//     not counted: see worldBudgetPass);
//   - (--scale) at Descent's size, old and new ms per pass and its largest
//     synchronous chunk at the owner's slice size, a steady tick and a view
//     round, for the report.
//
//   node tools/world-budget-slices-cpu-check.mjs [--scale] [--cases N] [--verbose]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as ref from './world-budget-reference.mjs';
import { worldBudgetDemand, worldBudgetDemandSteps, worldFarthestSteps, WORLD_VIEW_NEAR_RADIUS } from '../src/world/worldViewRing.js';
import { worldBudgetPass, worldCellCurrent, WORLD_RECLAIM_ROUNDS } from '../src/wire/worldRender.js';
import { worldRunSync, worldRunSliced, worldSliceMeter, WORLD_SLICE_UNITS } from '../src/world/worldSlices.js';
import { READY } from '../src/world/renderAtlas.js';
import { BRICK } from '../src/shaders/common.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose'), SCALE = args.includes('--scale');
// Random cases per exactness test.
const CASES = opt('cases', 300);
// The slice the exactness and bound runs use (units): small, so a pass yields many times.
const SLICE_TEST_UNITS = 512;
// Counted operations a work unit may take between two yields (a member unit
// is one to three: an entry, a lookup, an add; a ranked brick's four units up
// to eight), and a step's constant work around its loops.
const OPS_PER_UNIT = 3, OPS_SLACK = 64;
// The bound's demand, and the same world GROWTH times as dense.
const BOUND_BRICKS = 6000, GROWTH = 4;

// ---- a seeded PRNG, so a failing case reproduces ----
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
const layout = (dims) => ({ dims, brick: (i) => [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))], index: (b) => b[0] + dims[0] * (b[1] + dims[1] * b[2]) });
const floorsOf = (dims, r) => Object.freeze({ floors: Uint32Array.from({ length: dims[0] * dims[2] }, () => Math.floor(r() * (dims[1] + 2))), dims: Object.freeze([dims[0], dims[2]]) });
// An eye anywhere, or on a brick centre (distance ties), or none.
function eyeOf(dims, r) {
  const k = r();
  if (k < 0.05) return null;
  if (k < 0.3) return dims.map((n) => (Math.floor(r() * n) + 0.5) * BRICK);
  return dims.map((n) => r() * n * BRICK);
}
const sample = (list, p, r) => list.filter(() => r() < p);

// ---- 1. the rule: random demands against d62feb64's ----
let branches = { over: 0, short: 0, none: 0, ties: 0 };
for (let c = 0; c < CASES; c++) {
  const r = rng(1000 + c), dims = [8 + Math.floor(r() * 80), 1 + Math.floor(r() * 8), 8 + Math.floor(r() * 80)], { brick } = layout(dims);
  const total = dims[0] * dims[1] * dims[2], ids = new Set(sample([...Array(total).keys()], 0.05 + r() * 0.5, r));
  const all = [...ids], eye = eyeOf(dims, r), air = r() < 0.8 ? floorsOf(dims, r) : null;
  const fresh = r() < 0.2 ? null : new Set(sample(all, r(), r)), resident = r() < 0.2 ? null : new Set(all.filter((i) => !fresh?.has(i) && r() < 0.9));
  const held = new Set(sample(all, r() * 0.5, r)), news = fresh ? all.filter((i) => fresh.has(i)).length : all.length;
  const budget = r() < 0.5 ? Math.floor(all.length * (0.3 + r())) : Infinity, room = Math.floor(news * (0.2 + r() * 1.2));
  const radius = [WORLD_VIEW_NEAR_RADIUS, 0, r() * 200][Math.floor(r() * 3)];
  const o = { budget, eye, brick, held, air, fresh, room, resident, radius };
  const want = ref.worldBudgetDemand(ids, o), got = worldBudgetDemand(ids, o);
  const sliced = await worldRunSliced(worldBudgetDemandSteps(ids, { ...o, held: (i) => held.has(i) }, worldSliceMeter(SLICE_TEST_UNITS)), { pause: () => Promise.resolve() });
  for (const [name, x] of [['sync', got], ['sliced', sliced]]) {
    assert.deepStrictEqual(x.dropped, want.dropped, `case ${c} (${name}): the same bricks dropped in the same order`);
    assert.equal(x.air === air, want.air === air, `case ${c} (${name}): floors lowered alike`);
    if (want.air && want.air !== air) assert.deepStrictEqual([...x.air.floors], [...want.air.floors], `case ${c} (${name}): the same floors`);
  }
  assert.deepStrictEqual([...got.keep], [...want.keep], `case ${c}: the same demand kept, in its order`);
  if (!want.dropped.length) branches.none++; else if (all.length > budget) branches.over++; else branches.short++;
  if (eye && eye.every((n) => Number.isInteger(n / BRICK - 0.5))) branches.ties++;
}
assert(branches.over && branches.short && branches.none && branches.ties, `every branch of the rule ran: ${JSON.stringify(branches)}`);
console.log(`  rule: ${CASES} random demands drop, keep and lower exactly as d62feb64's sort (${JSON.stringify(branches)})`);

// ---- 2. the walk: a full sort's order, any prefix ----
for (let c = 0; c < CASES; c++) {
  const r = rng(5000 + c), dims = [4 + Math.floor(r() * 60), 1 + Math.floor(r() * 6), 4 + Math.floor(r() * 60)], { brick } = layout(dims);
  const list = sample([...Array(dims[0] * dims[1] * dims[2]).keys()], r(), r), eye = eyeOf(dims, r) ?? [0, 0, 0], skip = new Set(sample(list, r() * 0.3, r));
  const radius = r() < 0.5 ? -Infinity : r() * 150, take = Math.floor(r() * list.length * 1.2) + 1;
  const want = list.filter((i) => !skip.has(i)).map((i) => [Math.hypot(...brick(i).map((n, k) => (n + 0.5) * 4 - eye[k])), i]).filter(([d]) => d > radius).sort((a, b) => b[0] - a[0] || b[1] - a[1]).map(([, i]) => i).slice(0, take);
  const got = [];
  worldRunSync(worldFarthestSteps(r() < 0.5 ? list : list.values(), { eye, brick, skip: (i) => skip.has(i), radius, visit: (i) => got.push(i) >= take }, worldSliceMeter(SLICE_TEST_UNITS)));
  assert.deepStrictEqual(got, want, `case ${c}: the walk is a full sort's order`);
}
console.log(`  walk: ${CASES} random lists visited in a full sort's order, (distance, index) descending, to any count`);

// ---- 3. the owner's pass: a stand-in atlas, d62feb64's pass against the sliced one ----
// The atlas: live CELL pages (current or stale), superseded pages still
// counted in its pool, and how many of those a reclaim can take back; a
// removed page is superseded (the displayed frame's snapshot pins it); a
// missing one removes nothing (renderAtlas.js _put).
function atlasOf({ live, superseded, reclaimable, index, delay }) {
  const log = [];
  return { live: { cell: live }, superseded, reclaimable, log,
    poolUsed(kind) { assert.equal(kind, 'cell'); return this.live.cell.size + this.superseded; },
    remove(bricks, channels) { assert.equal(channels, READY.CELL); log.push(['remove', bricks.map(index)]); for (const b of bricks) if (this.live.cell.delete(index(b))) { this.superseded++; this.reclaimable++; } },
    reclaim(kind, count) { const freed = Math.min(count, this.reclaimable); this.reclaimable -= freed; this.superseded -= freed; log.push(['reclaim', kind, count, freed]); return delay(freed); } };
}
// One case, built afresh for each pass from its seed.
function passCase(seed, { dims: fixed = null, density = null, delay = (v) => Promise.resolve(v) } = {}) {
  const r = rng(seed), dims = fixed ?? [16 + Math.floor(r() * 90), 1 + Math.floor(r() * 6), 16 + Math.floor(r() * 90)], { brick, index } = layout(dims);
  const total = dims[0] * dims[1] * dims[2], every = [...Array(total).keys()];
  const ids = new Set(sample(every, density ?? 0.05 + r() * 0.4, r)), all = [...ids];
  const live = new Map();
  for (const i of all) if (r() < 0.7) live.set(i, { readyBits: r() < 0.85 ? READY.CELL : 0 });
  for (const i of sample(every.filter((i) => !ids.has(i)), r() * 0.3, r)) live.set(i, { readyBits: READY.CELL });
  const atlas = atlasOf({ live, superseded: Math.floor(r() * all.length * 0.5), reclaimable: 0, index, delay });
  atlas.reclaimable = Math.floor(atlas.superseded * r());
  const eye = eyeOf(dims, r), requirements = new Map(all.filter(() => r() < 0.85).map((i) => [i, READY.CELL]));
  const req = [...requirements.keys()], t = { full: worldSliceMeter(SLICE_TEST_UNITS), frame: { values: eye ? { cam: eye } : {} }, requirements, support: new Set(sample(req, 0.2, r)), dropped: new Set(), squeezed: new Set(sample(req, 0.05, r)), pinned: new Set(sample(req, r() * 0.2, r)) };
  const owned = () => new Set(sample(all, r() * 0.1, r)), ownedSources = owned(), ownedProbes = owned(), ownedGlow = owned();
  const fresh = all.filter((i) => !worldCellCurrent(atlas, i)).length, outside = [...live.keys()].filter((i) => !ids.has(i)).length;
  const cell = Math.floor((all.length + outside) * (0.4 + r())), pool = Math.floor(atlas.poolUsed('cell') + fresh * (r() * 1.4 - 0.6));
  const budget = { cell, pool: { cell: Math.max(0, pool) } }, air = floorsOf(dims, r), set = [];
  const ctx = { atlas, budget, cellCurrent: (i) => worldCellCurrent(atlas, i), brick, ownedSources, ownedProbes, ownedGlow, viewAirFor: async () => ({ air, id: 1 }), setViewAir: (a) => set.push(a),
    async reclaim(kind, over) { for (let k = 0; k < WORLD_RECLAIM_ROUNDS && over() > 0; k++) await atlas.reclaim(kind, over()); } };
  return { t, ids, ctx, atlas, set, air };
}
const warned = [];
const warn = console.warn;
console.warn = (m) => warned.push(String(m));
async function runPass(which, c, options, pause = () => Promise.resolve()) {
  const k = passCase(c, options), at = warned.length;
  await (which === 'ref' ? ref.budgetDemand : worldBudgetPass)(k.t, k.ids, { ...k.ctx, pause });
  return { ...k, lines: warned.slice(at) };
}
const seen = { dropped: 0, evictOutside: 0, squeezed: 0, evictResident: 0, reclaimed: 0, quiet: 0, air: 0 };
try {
  for (let c = 0; c < CASES; c++) {
    const asked = passCase(9000 + c).ids, a = await runPass('ref', 9000 + c), b = await runPass('new', 9000 + c);
    const same = (x, y, what) => assert.deepStrictEqual(y, x, `case ${9000 + c}: ${what}`);
    same([...a.ids], [...b.ids], 'the kept demand, in its order');
    same([...a.t.requirements], [...b.t.requirements], 'the requirements');
    for (const k of ['support', 'dropped', 'squeezed']) same([...a.t[k]], [...b.t[k]], `t.${k}`);
    same(a.t.budgetDropped, b.t.budgetDropped, 'budgetDropped');
    same(a.atlas.log, b.atlas.log, 'the evictions (in order) and reclaims');
    same([...a.atlas.live.cell.keys()], [...b.atlas.live.cell.keys()], 'the live pages');
    same(a.lines, b.lines, 'the log lines');
    same(a.set.map((x) => [...x.floors]), b.set.map((x) => [...x.floors]), 'the view floors');
    const lines = a.lines.join('\n');
    if (/bricks dropped$/m.test(lines)) seen.dropped++;
    if (/near ring rule/.test(lines)) seen.squeezed++;
    const removes = a.atlas.log.filter((e) => e[0] === 'remove');
    if (removes.length) seen.evictOutside++;
    if (removes.some((e) => e[1].some((i) => asked.has(i)))) seen.evictResident++;
    if (a.atlas.log.some((e) => e[0] === 'reclaim' && e[3] > 0)) seen.reclaimed++;
    if (!a.lines.length) seen.quiet++;
    if (a.set.length) seen.air++;
  }
} finally { console.warn = warn; }
for (const [k, n] of Object.entries(seen)) assert(n > 0, `the pass's ${k} branch ran (${JSON.stringify(seen)})`);
console.log(`  pass: ${CASES} random atlases and transactions end exactly as d62feb64's pass (${JSON.stringify(seen)})`);

// ---- 4. the largest synchronous chunk, in counted operations ----
const counter = { ops: 0, on: false };
const tick = () => { if (counter.on) counter.ops++; };
function countSetsAndMaps() {
  for (const proto of [Map.prototype, Set.prototype]) {
    for (const name of ['get', 'set', 'has', 'add', 'delete']) {
      const original = proto[name]; if (!original) continue;
      Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...a) { tick(); return original.apply(this, a); } });
    }
    const iterate = (it) => ({ next() { const r = it.next(); if (!r.done) tick(); return r; }, [Symbol.iterator]() { return this; } });
    for (const name of ['entries', 'keys', 'values']) { const original = proto[name]; Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...a) { return iterate(original.apply(this, a)); } }); }
    Object.defineProperty(proto, Symbol.iterator, { configurable: true, writable: true, value: proto === Map.prototype ? proto.entries : proto.values });
  }
  const hypot = Math.hypot; Math.hypot = (...a) => { tick(); return hypot(...a); };
  const typed = Object.getPrototypeOf(Uint32Array.prototype), sort = typed.sort;
  Object.defineProperty(typed, 'sort', { configurable: true, writable: true, value: function (compare) { return sort.call(this, compare && ((a, b) => { tick(); return compare(a, b); })); } });
}
async function most(seed, density, pass = worldBudgetPass) {
  // (the same world, GROWTH times as dense: only the demand's size differs)
  const k = passCase(seed, { dims: [96, 4, 96], density }), at = warned.length;
  const brick = k.ctx.brick, remove = k.atlas.remove.bind(k.atlas);
  let top = 0, from = 0, pauses = 0;
  const mark = () => { top = Math.max(top, counter.ops - from); from = counter.ops; };
  const ctx = { ...k.ctx, brick: (i) => { tick(); return brick(i); }, pause: () => { mark(); pauses++; return Promise.resolve(); } };
  // atlas.remove is one commit (not sliced, not counted); a reclaim waits for the GPU (a yield)
  k.atlas.remove = (...a) => { counter.on = false; try { return remove(...a); } finally { counter.on = true; } };
  const reclaim = k.atlas.reclaim.bind(k.atlas);
  k.atlas.reclaim = (...a) => { mark(); return reclaim(...a); };
  console.warn = (m) => warned.push(String(m));
  counter.on = true; from = counter.ops;
  try { await pass(k.t, k.ids, ctx); } finally { mark(); counter.on = false; console.warn = warn; }
  return { top, pauses, demand: k.ids.size + k.t.dropped.size, lines: warned.slice(at) };
}
if (!SCALE) {
  countSetsAndMaps();
  const bound = OPS_PER_UNIT * SLICE_TEST_UNITS + OPS_SLACK, rows = [];
  const base = BOUND_BRICKS / (96 * 4 * 96);
  for (let s = 0; s < 6; s++) {
    const small = await most(20000 + s, base), big = await most(20000 + s, base * GROWTH);
    rows.push([small.top, big.top, small.demand, big.demand, big.pauses]);
    if (VERBOSE) console.log(JSON.stringify({ small, big }));
    for (const x of [small, big]) assert(x.top <= bound, `seed ${20000 + s}: ${x.top} operations between two yields with a demand of ${x.demand}, over ${bound}`);
  }
  // (and the bound holds the sort it replaced to account: d62feb64's pass is one chunk of the demand's size)
  const old = await most(20000, base * GROWTH, ref.budgetDemand);
  assert(old.top > bound, `d62feb64's pass: ${old.top} operations between two yields, under the bound ${bound}?`);
  console.log(`  slices: the largest synchronous chunk ${rows.map((x) => `${x[0]}/${x[1]}`).join(', ')} counted operations (demand ${rows[0][2]} / ${rows[0][3]} bricks; bound ${bound}, ${SLICE_TEST_UNITS}-unit slices; d62feb64's ${old.top})`);
  console.log('PASS the GPU page budget drops, evicts and keeps exactly as before, in slices bounded by counted work, not by the demand');
} else {
  // ---- 5. (--scale) Descent: old and new, a steady tick and a view round ----
  // Descent's brick grid (tools/world-tick-incremental-cpu-check.mjs DESCENT)
  // and the user's Mac's budget (worldPageBudget, deviceMemory 8: 295,389
  // pages, pool 590,778). The demand: two brick rows a column under its top
  // (~225k bricks, the model's 220k), of which ~15% only the metadata asks
  // for (held); the pool full but ROOM pages; OUTSIDE pages held past the
  // demand; a steady tick's STEADY new pages (a change re-packed), a view
  // round's ROUND (real Chrome: ~96k new bricks).
  const dims = [352, 64, 320], { brick, index } = layout(dims), ROOM = 4000, OUTSIDE = 60000, STEADY = 6000, ROUND = 96000;
  const top = (x, z) => Math.max(5, Math.min(dims[1] - 2, Math.floor(dims[1] / 2 + 3 * Math.sin((x - 176) * 0.07) + 3 * Math.cos((z - 160) * 0.05))));
  function descent(fresh, delay) {
    const r = rng(7), ids = new Set(), live = new Map(), eye = [176.3 * BRICK, (top(176, 160) + 2) * BRICK, 160.7 * BRICK];
    for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) for (let y = top(x, z) - 1; y <= top(x, z); y++) ids.add(index([x, y, z]));
    const all = [...ids], news = new Set();
    // the new pages: a view round's farthest ring of the demand (the eye turned), a steady tick's near the eye
    const byDistance = all.map((i) => [Math.hypot(...brick(i).map((n, k) => (n + 0.5) * BRICK - eye[k])), i]).sort((a, b) => a[0] - b[0]);
    for (const [, i] of fresh === ROUND ? byDistance.slice(-fresh) : byDistance.slice(0, fresh)) news.add(i);
    for (const i of all) if (!news.has(i) || fresh !== ROUND) live.set(i, { readyBits: news.has(i) ? 0 : READY.CELL });
    for (let k = 0, z = 0; k < OUTSIDE; z++) for (let x = 0; x < dims[0] && k < OUTSIDE; x++, k++) live.set(index([x, top(x, z) - 2, z]), { readyBits: READY.CELL });
    const requirements = new Map(all.filter(() => r() < 0.85).map((i) => [i, READY.CELL]));
    const budget = { cell: 295389, pool: { cell: 590778 } };
    const atlas = atlasOf({ live, superseded: 0, reclaimable: 0, index, delay });
    // (every superseded page pinned: only an eviction makes room)
    atlas.superseded = budget.pool.cell - ROOM - live.size;
    const near = (i) => Math.hypot(...brick(i).map((n, k) => (n + 0.5) * BRICK - eye[k])) < 80, ownedSources = new Set(all.filter(near));
    const t = { full: worldSliceMeter(), frame: { values: { cam: eye } }, requirements, support: new Set(), dropped: new Set(), squeezed: new Set(), pinned: new Set() };
    const air = Object.freeze({ floors: new Uint32Array(dims[0] * dims[2]).fill(dims[1]), dims: Object.freeze([dims[0], dims[2]]) });
    const ctx = { atlas, budget, cellCurrent: (i) => worldCellCurrent(atlas, i), brick, ownedSources, ownedProbes: new Set(), ownedGlow: new Set(), viewAirFor: async () => ({ air, id: 1 }), setViewAir() {},
      async reclaim(kind, over) { for (let k = 0; k < WORLD_RECLAIM_ROUNDS && over() > 0; k++) await atlas.reclaim(kind, over()); } };
    return { t, ids, ctx, atlas };
  }
  const RUNS = opt('runs', 3);
  console.warn = () => {};
  try {
    for (const [name, fresh] of [['steady tick', STEADY], ['view round', ROUND]]) {
      for (const which of ['old', 'new']) {
        const pass = which === 'old' ? ref.budgetDemand : worldBudgetPass, rows = [];
        for (let k = 0; k < RUNS; k++) {
          // JS ms (pauses resolve at once), then the largest chunk with the owner's pauses (a macrotask each)
          const a = descent(fresh, (v) => Promise.resolve(v)), t0 = performance.now();
          await pass(a.t, a.ids, { ...a.ctx, pause: () => Promise.resolve() });
          const ms = performance.now() - t0;
          let last = 0, chunk = 0, pauses = 0;
          const yieldNow = (v) => { chunk = Math.max(chunk, performance.now() - last); pauses++; return new Promise((res) => setTimeout(() => { last = performance.now(); res(v); }, 0)); };
          const b = descent(fresh, yieldNow);
          last = performance.now();
          await pass(b.t, b.ids, { ...b.ctx, pause: () => yieldNow() });
          chunk = Math.max(chunk, performance.now() - last);
          rows.push({ ms, chunk, pauses, demand: b.ids.size + b.t.dropped.size, dropped: b.t.dropped.size, evicted: b.atlas.log.filter((e) => e[0] === 'remove').reduce((s, e) => s + e[1].length, 0) });
        }
        const best = (k) => Math.min(...rows.map((x) => x[k])).toFixed(1), x = rows[0];
        console.log(`Descent ${name} ${which}: ${x.demand} bricks asked, ${x.dropped} dropped, ${x.evicted} evicted; ${best('ms')} ms of JS a pass, largest synchronous chunk ${best('chunk')} ms (${x.pauses} yields, ${WORLD_SLICE_UNITS}-unit slices; best of ${RUNS})`);
      }
    }
  } finally { console.warn = warn; }
}
