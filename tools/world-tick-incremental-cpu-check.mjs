// A big map's lighting tick plans its light bounce in JS proportional to what
// it can select and what changed, not to every brick the map holds. CPU only:
// the World owner's records step (wire/worldRender.js worldGIRecords) and the
// real lighting history (world/worldLightingHistory.js begin, expand, stage,
// seal, commit), tick after tick, against the code they replaced
// (tools/world-tick-reference.mjs, the b3edc868 path verbatim).
//
// Real Chrome (2026-10-22, 20 s after the first frame): Island 12.8 rAF/s with
// stalls of 1.4-6.4 s, Descent 18.7 rAF/s with stalls of 1.3-2.9 s; of them
// 2.7-3.3 s was attempt() itself and 1.9-2.5 s history.begin, each tick
// building, testing and copying a record of all 40k-450k bricks the metadata
// holds. Here:
//   - every tick's plan is the old path's: its SOURCES, its gathers and their
//     background flags, its birth manifest, the same after an in-place birth
//     expansion, and the committed births with their declarations, over a
//     multi-tick run through the load (mode 2), the settle ticks, the
//     pattern ticks, a lamp change and a light-key change;
//   - a tick's Map/Set work is the same with OPERATION_GROWTH times the
//     records outside what it can select: bounded by the selection and the
//     change, never the map's size;
//   - the tick's metadata rows are exactly the brute-force stale rule's
//     (world/worldLightingRecords.js worldLightingStale: the delta's rows and
//     those of re-captured cores), and they and the final publish's pages
//     (wire/worldRender.js worldRestoreResident) are the same with
//     OPERATION_GROWTH times the records;
//   - (--scale) at Island's and Descent's record counts, the old and new
//     ms per tick and the largest synchronous step, and the other stages'
//     ms and rows/pages (old -> new), for the report.
//
//   node tools/world-tick-incremental-cpu-check.mjs [--scale] [--ticks N] [--verbose]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { worldGIRecords } from '../src/wire/worldRender.js';
import { createWorldLightingHistory } from '../src/world/worldLightingHistory.js';
import { READY } from '../src/world/renderAtlas.js';
import { AGE } from '../src/shaders/fields.js';
import { GI_SETTLE } from '../src/shaders/gi.js';
import * as reference from './world-tick-reference.mjs';
import { worldLightingStale } from '../src/world/worldLightingRecords.js';
import { worldRestoreResident, worldCellCurrent } from '../src/wire/worldRender.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose'), SCALE = args.includes('--scale');
// Exactness ticks: the load, every settle tick after it and a few pattern ticks.
const TICKS = opt('ticks', GI_SETTLE + 8);
// Ticks with a lamp change and with a light-key change (a new settle).
const LAMP_TICK = 3, KEY_TICK = GI_SETTLE + 4;
// A tick's change: this many boxes of this many bricks a side, near the eye.
const CHANGE_BOXES = 3, CHANGE_SIDE = 6;
// Births a SOURCE pass adds in place (worldRender.js sourceBirths), per tick.
const BIRTHS = 4;
// Per tick after the load: new GI and SOURCE asks at the rings' edge, and CELL asks (every SUPPORT_EVERY-th one support).
const NEW_PROBES = 24, NEW_SOURCES = 48, CELL_ASKS = 600, SUPPORT_EVERY = 5;
// The far records added for the operation bound, as a multiple of the base fixture's.
const OPERATION_GROWTH = 4;
// Ops may differ by this share (none expected: only the far records differ).
const OPERATION_TOLERANCE = 0;
// A brick out of every REACH_SKIP the gathers' ring does not reach (worldGIReach stand-in).
const REACH_SKIP = 7;

// ---- operation counter: Map/Set entries handed out by their iterators ----
const counter = { entries: 0, on: false };
function countIterators(proto) {
  const wrap = (it) => ({ next() { const r = it.next(); if (!r.done && counter.on) counter.entries++; return r; }, [Symbol.iterator]() { return this; } });
  for (const name of ['entries', 'keys', 'values']) {
    const original = proto[name];
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...a) { return wrap(original.apply(this, a)); } });
  }
  Object.defineProperty(proto, Symbol.iterator, { configurable: true, writable: true, value: proto === Map.prototype ? proto.entries : proto.values });
  const forEach = proto.forEach;
  Object.defineProperty(proto, 'forEach', { configurable: true, writable: true, value: function (fn, self) { if (counter.on) counter.entries += this.size; return forEach.call(this, fn, self); } });
}
if (!SCALE) { countIterators(Map.prototype); countIterators(Set.prototype); }

// ---- the fixture: a ground shell of records, the eye over its middle ----
// dims in bricks; each column holds DEPTH matter bricks under its top and AIR above.
function world({ dims, depth, air, sourceRadius, probeRadius, far = 0 }) {
  const [bx, by, bz] = dims, size = dims.map((n) => n * 4), count = bx * by * bz;
  const index = (b) => b[0] + bx * (b[1] + by * b[2]), brick = (i) => [i % bx, Math.floor(i / bx) % by, Math.floor(i / (bx * by))];
  // (relative to the middle: a bigger world holds the same ground around the eye)
  const top = (x, z) => Math.max(depth, Math.min(by - air - 1, Math.floor(by / 2 + 3 * Math.sin((x - (bx >> 1)) * 0.07) + 3 * Math.cos((z - (bz >> 1)) * 0.05))));
  const eye = [bx >> 1, top(bx >> 1, bz >> 1) + 2, bz >> 1];
  const committed = new Map(), base = new Set();
  // the base fixture: every column within the far radius of the eye; far adds columns past it
  const reach = Math.max(sourceRadius, probeRadius) + CHANGE_SIDE * 4;
  for (let z = 0; z < bz; z++) for (let x = 0; x < bx; x++) {
    const d = Math.hypot(x - eye[0], z - eye[2]), inside = d <= reach;
    if (!inside && !far) continue;
    if (!inside && far && ((x * 31 + z * 17) % (far + 1)) === 0) continue;   // thin the far ring, deterministically
    const h = top(x, z);
    for (let y = h - depth + 1; y <= h + air; y++) {
      const i = index([x, y, z]);
      committed.set(i, { brick: Object.freeze([x, y, z]), matter: y <= h, changedTick: 0 });
      if (inside) base.add(i);
    }
  }
  return { dims, size, count, index, brick, top, eye, committed, base, sourceRadius, probeRadius };
}
// The tick's metadata batch (worldLightingRecords read(): age from the last change, matter, near false).
function batchOf(w, derivedTick, changedBricks) {
  return { changes: { changedBricks },
    records(indices) {
      const ids = Array.from(indices, (i) => { if (!Number.isInteger(i) || i < 0 || i >= w.count) throw new RangeError('world lighting record index'); return i; });
      const missing = ids.filter((i) => !w.committed.has(i)); if (missing.length) throw new Error(`Submitted world lighting metadata required (${missing.length})`);
      return Object.freeze(ids.map((i) => { const r = w.committed.get(i); return Object.freeze({ brick: r.brick, age: Math.min(AGE.MAX, derivedTick - r.changedTick), matter: r.matter, near: false }); }));
    } };
}
// A deterministic stream of the tick's asks and changes, the same for both paths.
function* ticks(w, count) {
  const ring = (radius, matter) => [...w.base].filter((i) => { const r = w.committed.get(i), b = r.brick; return r.matter === matter && Math.hypot(b[0] - w.eye[0], b[2] - w.eye[2]) <= radius; }).sort((a, b) => a - b);
  const sources = ring(w.sourceRadius, true), probes = ring(w.probeRadius, false);
  const edgeSources = ring(w.sourceRadius + CHANGE_SIDE * 3, true).filter((i) => !sources.includes(i)), edgeProbes = ring(w.probeRadius + CHANGE_SIDE * 3, false).filter((i) => !probes.includes(i));
  const cells = [...w.base].sort((a, b) => a - b);
  for (let k = 0; k < count; k++) {
    const requirements = new Map(), support = new Set();
    if (k === 0) { for (const i of sources) requirements.set(i, READY.GI_SOURCE | READY.CELL); for (const i of probes) requirements.set(i, READY.GI | READY.CELL); }
    else {
      for (let n = 0; n < CELL_ASKS; n++) { const i = cells[(k * 7919 + n * 104729) % cells.length]; requirements.set(i, READY.CELL); if (n % SUPPORT_EVERY === 0) support.add(i); }
      for (let n = 0; n < NEW_SOURCES; n++) requirements.set(edgeSources[(k * NEW_SOURCES + n) % edgeSources.length], READY.GI_SOURCE);
      for (let n = 0; n < NEW_PROBES; n++) requirements.set(edgeProbes[(k * NEW_PROBES + n) % edgeProbes.length], READY.GI | READY.CELL);
    }
    // the change: boxes around the eye, the records in them changed at this tick
    const changed = [];
    if (k > 0) for (let n = 0; n < CHANGE_BOXES; n++) {
      const cx = w.eye[0] + ((k * 13 + n * 29) % (2 * w.probeRadius)) - w.probeRadius, cz = w.eye[2] + ((k * 17 + n * 23) % (2 * w.probeRadius)) - w.probeRadius;
      for (let z = cz; z < cz + CHANGE_SIDE; z++) for (let x = cx; x < cx + CHANGE_SIDE; x++) {
        if (x < 0 || z < 0 || x >= w.dims[0] || z >= w.dims[2]) continue;
        const h = w.top(x, z);
        for (let y = h - 1; y <= h + 1; y++) { const i = w.index([x, y, z]); if (w.committed.has(i)) changed.push(i); }
      }
    }
    const lamps = k >= LAMP_TICK ? [{ pos: [w.eye[0] * 4, w.eye[1] * 4, w.eye[2] * 4 + (k === LAMP_TICK ? 0 : 8), 6], col: [1, 0.8, 0.5], shape: [0, 1] }] : [];
    yield { k, requirements, support, changed: [...new Set(changed)].sort((a, b) => a - b), lamps, globalKey: k >= KEY_TICK ? [2] : [1] };
  }
}
// A transaction's GI output, as a published slab stages it.
const outputOf = (plan, history, w, cutToken) => ({ sources: Uint32Array.from(plan.sourceBricks, w.index), probes: Uint32Array.from(plan.gatherBricks, (r) => w.index(r.brick)),
  token: { epoch: 1, lightingTick: plan.lightingTick, initialization: plan.initialization, previousToken: history.token, sourceContentToken: cutToken },
  retain() { return this; }, release() {} });
const complete = { incomplete: false, requirements: [], sun: [] };

// One path's whole run: its own history and owned sets; the shared fixture's metadata.
function runner(w, path) {
  const history = (path === 'old' ? reference : { createWorldLightingHistory }).createWorldLightingHistory({ worldSize: w.size, epoch: 1 });
  const ownedSources = new Set(), ownedProbes = new Set();
  const reached = (i) => { const b = w.brick(i), d = 3 * (b[0] - w.eye[0]) + 5 * (b[2] - w.eye[2]); return ((d % REACH_SKIP) + REACH_SKIP) % REACH_SKIP !== 0; };
  return { history, ownedSources, ownedProbes,
    // records + begin: one synchronous step of attempt()
    plan(tick, batch) {
      const opts = { size: w.size, requirements: tick.requirements, support: tick.support, ownedSources, ownedProbes, reached };
      let r;
      if (path === 'old') {
        const ids = new Set([...w.committed.keys(), ...ownedSources, ...ownedProbes, ...tick.requirements.keys()]);
        r = reference.oldGIRecords(batch, { ...opts, ids });
      } else r = worldGIRecords(batch, opts);
      const cutToken = { tick: tick.k };
      const plan = history.begin({ lightingTick: tick.k, globalKey: tick.globalKey, records: r.records, currentLamps: tick.lamps, mode: tick.k === 0 ? 2 : 0,
        initialization: { cutToken, sourceBricks: r.requestedSources, probeBricks: r.never.map((x) => x.brick), records: r.records } });
      return { plan, cutToken };
    },
    // the SOURCE pass's births (sourceBirths): SOURCES with no probe, in place
    // (half of them SOURCES asked for by name: one the selection itself
    // could not pick still needs its record's declaration as a birth)
    births(plan, tick) {
      const probes = new Set(plan.gatherBricks.map((r) => w.index(r.brick)));
      const open = plan.sourceBricks.filter((b) => { const i = w.index(b); return !probes.has(i) && !ownedProbes.has(i); });
      const named = open.filter((b) => tick.requirements.get(w.index(b)) & READY.GI_SOURCE).slice(0, BIRTHS / 2);
      const born = [...named, ...open.filter((b) => !named.includes(b)).slice(0, BIRTHS - named.length)];
      if (born.length) plan.expand({ probeBricks: born });
      return born;
    },
    commit(plan, cutToken, changed) {
      const out = outputOf(plan, history, w, cutToken);
      plan.stage(out); plan.seal({ cutToken, feedback: complete }); plan.commit();
      for (const i of out.sources) ownedSources.add(i); for (const i of out.probes) ownedProbes.add(i);
      history.noteChanged(changed.map(w.brick), plan.lightingTick);
    } };
}
const snapshot = (plan) => ({ sources: plan.sourceBricks, gathers: plan.gatherBricks, births: plan.initialization?.indices ?? null });

// ---- 1. the same plans, tick after tick ----
function exactness(spec) {
  const w = world(spec), old = runner(w, 'old'), now = runner(w, 'new');
  let compared = 0, births = 0, maxSources = 0;
  for (const tick of ticks(w, TICKS)) {
    for (const i of tick.changed) w.committed.get(i).changedTick = tick.k;
    const batch = batchOf(w, tick.k, tick.changed.map(w.brick));
    const a = old.plan(tick, batch), b = now.plan(tick, batch);
    assert.deepStrictEqual(snapshot(b.plan), snapshot(a.plan), `tick ${tick.k}: the plan is the old path's`);
    const bornA = old.births(a.plan, tick), bornB = now.births(b.plan, tick);
    assert.deepStrictEqual(bornB, bornA, `tick ${tick.k}: the same in-place births`);
    assert.deepStrictEqual(snapshot(b.plan), snapshot(a.plan), `tick ${tick.k}: the expanded plan is the old path's`);
    old.commit(a.plan, a.cutToken, tick.changed); now.commit(b.plan, b.cutToken, tick.changed);
    for (const i of new Set([...old.ownedProbes, ...now.ownedProbes])) assert.deepStrictEqual(now.history.birth(i), old.history.birth(i), `tick ${tick.k}: probe ${i}'s birth and declaration`);
    assert.deepStrictEqual([...now.ownedSources].sort(), [...old.ownedSources].sort(), `tick ${tick.k}: the same owned SOURCES`);
    assert.equal(now.history.lightingTick, old.history.lightingTick);
    compared++; births += bornB.length; maxSources = Math.max(maxSources, b.plan.sourceBricks.length);
    if (VERBOSE) console.log(`  tick ${tick.k}: ${b.plan.sourceBricks.length} SOURCES, ${b.plan.gatherBricks.length} gathers, ${bornB.length} births, ${tick.changed.length} changed`);
  }
  return { compared, births, maxSources, records: w.committed.size, owned: now.ownedSources.size + now.ownedProbes.size };
}
// ---- 2. the same Map/Set work with OPERATION_GROWTH times the far records ----
function operations(spec) {
  const w = world(spec), run = runner(w, 'new'), out = [];
  for (const tick of ticks(w, TICKS)) {
    for (const i of tick.changed) w.committed.get(i).changedTick = tick.k;
    const batch = batchOf(w, tick.k, tick.changed.map(w.brick));
    counter.entries = 0; counter.on = true;
    const p = run.plan(tick, batch); run.births(p.plan, tick); run.commit(p.plan, p.cutToken, tick.changed);
    counter.on = false; out.push(counter.entries);
  }
  return { ops: out, records: w.committed.size };
}
// ---- 3. (--scale) old and new at Island's and Descent's record counts ----
function timed(spec, path, count) {
  const w = world(spec), run = runner(w, path), rows = [];
  for (const tick of ticks(w, count)) {
    for (const i of tick.changed) w.committed.get(i).changedTick = tick.k;
    const batch = batchOf(w, tick.k, tick.changed.map(w.brick));
    const t0 = performance.now(); const p = run.plan(tick, batch);
    const t1 = performance.now(); run.births(p.plan, tick);
    const t2 = performance.now(); run.commit(p.plan, p.cutToken, tick.changed);
    const t3 = performance.now();
    rows.push({ k: tick.k, plan: t1 - t0, births: t2 - t1, commit: t3 - t2, total: t3 - t0, chunk: Math.max(t1 - t0, t2 - t1, t3 - t2), sources: p.plan.sourceBricks.length, gathers: p.plan.gatherBricks.length });
  }
  return { rows, records: w.committed.size, owned: run.ownedSources.size + run.ownedProbes.size };
}

// ---- 4. the tick's other stages over every brick (wire/worldRender.js attempt()) ----
// metadata: the rows a tick records (worldLightingStale, against recording
// every committed row: the old path) with each core's capture new where the
// change's field owners advance (FIELD_REACH bricks around it); the final
// publish's restored pages (worldRestoreResident, against every owned one);
// and the scans still over every brick (ids, the budget's and the CELL
// stage's), for the report.
const FIELD_REACH = 2;
function stages(spec, count, { time = true } = {}) {
  const w = world(spec), run = runner(w, 'new'), rows = [], dims = w.dims, core = (i) => { const b = w.brick(i); return (b[0] >> 3) + Math.ceil(dims[0] / 8) * ((b[1] >> 3) + Math.ceil(dims[1] / 8) * (b[2] >> 3)); };
  const capture = new Map(), cores = new Map(), captureOf = (b) => capture.get((b[0] >> 3) + Math.ceil(dims[0] / 8) * ((b[1] >> 3) + Math.ceil(dims[1] / 8) * (b[2] >> 3)));
  for (const i of w.committed.keys()) { const k = core(i); if (!capture.has(k)) capture.set(k, { k, v: 0 }); let m = cores.get(k); if (!m) cores.set(k, m = new Map([[capture.get(k), new Set()]])); m.get(capture.get(k)).add(i); }
  const live = new Map([...w.committed.keys()].map((i) => [i, { readyBits: READY.CELL }])), atlas = { live: { cell: live } };
  const clock = () => (time ? performance.now() : 0);
  for (const tick of ticks(w, count)) {
    for (const i of tick.changed) w.committed.get(i).changedTick = tick.k;
    // the change's cores take new captures (their field owners advance)
    const recaptured = new Set();
    for (const i of tick.changed) { const b = w.brick(i); for (const dz of [-FIELD_REACH, 0, FIELD_REACH]) for (const dx of [-FIELD_REACH, 0, FIELD_REACH]) { const x = b[0] + dx, z = b[2] + dz; if (x >= 0 && z >= 0 && x < dims[0] && z < dims[2]) recaptured.add((x >> 3) + Math.ceil(dims[0] / 8) * ((b[1] >> 3) + Math.ceil(dims[1] / 8) * (z >> 3))); } }
    for (const k of recaptured) if (capture.has(k)) capture.set(k, { k, v: tick.k });
    const t0 = clock();
    const ids = new Set(w.committed.keys()); for (const set of [run.ownedSources, run.ownedProbes, tick.requirements.keys()]) for (const i of set) ids.add(i);
    const t1 = clock(); let outside = 0; for (const i of live.keys()) if (!ids.has(i)) outside++;
    const t2 = clock(); let staleCells = 0; for (const i of ids) if (!worldCellCurrent(atlas, i)) staleCells++;
    const t3 = clock();
    const delta = { global: tick.k === 0, changedBricks: tick.changed.map(w.brick) };
    const stale = worldLightingStale({ dims, committed: w.committed, cores, delta, captureOf });
    const t4 = clock();
    // the brute-force rule: every committed row in the delta or read from a capture its core no longer has
    const changed = new Set(tick.changed);
    if (!time) for (const [k, m] of cores) for (const [buffer, set] of m) for (const i of set) assert.equal(stale.has(i), delta.global || changed.has(i) || buffer !== capture.get(k), `tick ${tick.k}: row ${i} stale`);
    // the records step reads the rows; commit moves each re-read row to its core's capture
    for (const i of stale) { const k = core(i), m = cores.get(k); for (const set of m.values()) set.delete(i); let set = m.get(capture.get(k)); if (!set) m.set(capture.get(k), set = new Set()); set.add(i); }
    for (const m of cores.values()) for (const [buffer, set] of m) if (!set.size) m.delete(buffer);
    const batch = batchOf(w, tick.k, tick.changed.map(w.brick)), p = run.plan(tick, batch); run.births(p.plan, tick);
    // the final publish: the restore made every owned page resident; the plan's selection is new
    const owned = new Set([...run.ownedSources, ...run.ownedProbes]), selected = new Set([...p.plan.sourceBricks.map(w.index), ...p.plan.gatherBricks.map((r) => w.index(r.brick))]);
    const resident = new Map(), leases = new Map(), page = new Map();
    for (const i of owned) { const job = {}, token = { i }; resident.set(i, { job, source: token, gi: null }); leases.set(i, { source: { token } }); page.set(i, { job }); }
    const t5 = clock();
    const allocated = worldRestoreResident(new Set([...owned, ...selected]), { resident, live: page, leases, fresh: (i) => selected.has(i) });
    const t6 = clock();
    run.commit(p.plan, p.cutToken, tick.changed);
    rows.push({ k: tick.k, ids: t1 - t0, budget: t2 - t1, classify: t3 - t2, stale: t4 - t3, restore: t6 - t5, oldRows: w.committed.size, newRows: stale.size, oldPages: owned.size + [...selected].filter((i) => !owned.has(i)).length, newPages: allocated.size, outside, staleCells });
  }
  return { rows, records: w.committed.size };
}

const SMALL = { dims: [96, 24, 96], depth: 5, air: 2, sourceRadius: 18, probeRadius: 12 };
if (!SCALE) {
  const e = exactness(SMALL);
  assert(e.births > 0 && e.compared === TICKS, 'the run births probes in place');
  console.log(`  exact: ${e.compared} ticks (${e.records} records, ${e.owned} owned at the end, up to ${e.maxSources} SOURCES a tick, ${e.births} in-place births)`);
  const far = exactness({ ...SMALL, far: 1 });
  console.log(`  exact with far records: ${far.compared} ticks (${far.records} records)`);
  const a = operations(SMALL), b = operations({ ...SMALL, dims: [SMALL.dims[0] * 2, SMALL.dims[1], SMALL.dims[2] * 2], far: 1e9 });
  assert(b.records >= OPERATION_GROWTH * a.records, `the far fixture holds ${b.records} records, not ${OPERATION_GROWTH}x ${a.records}`);
  for (let k = 0; k < a.ops.length; k++) assert(Math.abs(b.ops[k] - a.ops[k]) <= OPERATION_TOLERANCE * a.ops[k], `tick ${k}: ${b.ops[k]} Map/Set entries with ${b.records} records, ${a.ops[k]} with ${a.records}`);
  console.log(`  bounded: the same Map/Set work every tick with ${b.records} records as with ${a.records} (up to ${Math.max(...a.ops)} entries a tick)`);
  // metadata and restore: exactly the brute-force rule, and rows/pages bounded by the change, not the map
  const sa = stages(SMALL, TICKS, { time: false }), sb = stages({ ...SMALL, dims: [SMALL.dims[0] * 2, SMALL.dims[1], SMALL.dims[2] * 2], far: 1e9 }, TICKS, { time: false });
  for (let k = 1; k < sa.rows.length; k++) {
    assert.equal(sb.rows[k].newRows, sa.rows[k].newRows, `tick ${k}: ${sb.rows[k].newRows} metadata rows with ${sb.records} records, ${sa.rows[k].newRows} with ${sa.records}`);
    assert.equal(sb.rows[k].newPages, sa.rows[k].newPages, `tick ${k}: ${sb.rows[k].newPages} restored pages with ${sb.records} records, ${sa.rows[k].newPages} with ${sa.records}`);
    assert(sa.rows[k].newRows < sa.rows[k].oldRows && sa.rows[k].newPages < sa.rows[k].oldPages);
  }
  console.log(`  metadata and restore: the brute-force stale rule every tick; up to ${Math.max(...sa.rows.slice(1).map((r) => r.newRows))} rows and ${Math.max(...sa.rows.slice(1).map((r) => r.newPages))} pages a tick, the same with ${sb.records} records as with ${sa.records}`);
  console.log(`PASS a lighting tick's GI plan is the old path's, tick after tick, in work bounded by its selection and change`);
} else {
  // Island ~450k records, Descent ~650k (real Chrome, 2026-10-22); their SOURCE rings ~80k and ~100k.
  const ISLAND = { dims: [256, 32, 256], depth: 6, air: 1, sourceRadius: 64, probeRadius: 40, far: 0 };
  const DESCENT = { dims: [352, 64, 320], depth: 5, air: 1, sourceRadius: 80, probeRadius: 48, far: 0 };
  const n = opt('ticks', 4);
  for (const [name, spec] of [['Island', ISLAND], ['Descent', DESCENT]]) {
    const full = { ...spec, far: 1e9 };   // every column, as a loaded big map holds
    for (const path of ['old', 'new']) {
      const r = timed(full, path, n), steady = r.rows.slice(1);
      const avg = (k) => steady.reduce((a, x) => a + x[k], 0) / steady.length;
      console.log(`${name} ${path}: ${r.records} records, ${r.owned} owned; load ${r.rows[0].total.toFixed(0)} ms; steady tick ${avg('total').toFixed(1)} ms (plan ${avg('plan').toFixed(1)}, births ${avg('births').toFixed(1)}, commit ${avg('commit').toFixed(1)}), largest step ${Math.max(...steady.map((x) => x.chunk)).toFixed(1)} ms; ${steady.at(-1).sources} SOURCES, ${steady.at(-1).gathers} gathers`);
    }
    const st = stages(full, n), sr = st.rows.slice(1), avg = (k) => sr.reduce((a, x) => a + x[k], 0) / sr.length;
    console.log(`${name} stages: ids ${avg('ids').toFixed(1)} ms, budget scan ${avg('budget').toFixed(1)}, CELL scan ${avg('classify').toFixed(1)}, metadata selection ${avg('stale').toFixed(1)} (rows ${avg('oldRows').toFixed(0)} -> ${avg('newRows').toFixed(0)}), final-publish selection ${avg('restore').toFixed(1)} (pages ${avg('oldPages').toFixed(0)} -> ${avg('newPages').toFixed(0)})`);
  }
}
