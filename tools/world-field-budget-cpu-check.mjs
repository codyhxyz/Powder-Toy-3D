// A big map's field tick records at most its budget of GPU work, carries the
// rest forward core by core, and ends with the fields the unbudgeted tick
// makes. CPU only: no browser, no GPU, no server.
//
// V2 noted its whole window changed every tick, and one Descent field tick
// queued `world field history` x80460, `fieldEma` x180118 and `fieldBlur`
// passes of 145k-500k workgroups in one submission: every frame behind it
// waited about 10 s (real Chrome, 2026-10-22). world/fields.js now admits a
// field tick's cores, oldest waiting and nearest the eye first, while their
// workgroups (EMA batches, and the CELL stage's jobs their invalidation
// causes) fit WORLD_FIELD_TICK_WORKGROUPS; the rest wait. Here:
//   1. exactness (byte fakes: the EMA and the history copies executed): a
//      budgeted run and an unbudgeted one over the same load, a big change and
//      quiet ticks end with the same owners, the same history words, ages and
//      published cores, once the backlog drains and the owners settle; no core
//      is ever derived from a halo with a pending owner, and every published
//      core was derived after its halo's last advance;
//   2. the bound (the real Source -> Fields -> CELL adapter -> Atlas path on a
//      command-counting GPU): every tick's field workgroups, its field tick's
//      and its CELL stage's, are within the budget (or one core's work, the
//      least a tick takes), for a whole-window change and a small one, and
//      the backlog drains in the ticks its size over the budget allows;
//   3. (--scale) the same at Island's and Descent's sizes, before and after,
//      for the report.
//
//   node tools/world-field-budget-cpu-check.mjs [--scale] [--verbose]
import assert from 'node:assert/strict';
import { FieldTestGPU, FIELD_HISTORY_KERNEL } from './field-test-gpu.mjs';
import { NullGPU } from './world-cell-null-gpu.mjs';
import { E } from '../src/elements.js';
import { gridDims, cellSlot } from '../src/shaders/common.js';
import { FIELD_EMA_SETTLE } from '../src/shaders/fields.js';
import { WorldFields, WORLD_FIELD_TICK_WORKGROUPS } from '../src/world/fields.js';
import { WorldFieldHistory, HISTORY_WORDS, brickKey } from '../src/world/fieldHistory.js';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderSource } from '../src/world/renderSource.js';
import { RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { WorldRenderAtlas, worldBrickIndex } from '../src/world/renderAtlas.js';
import { BrickStore } from '../src/world/store.js';
import { worldAdvanceFields, worldClassify } from '../src/wire/worldRender.js';

const args = process.argv.slice(2), VERBOSE = args.includes('--verbose'), SCALE = args.includes('--scale');
const CORE = 32, BRICK = 4;
// Ticks past a drained backlog for every owner to settle (and a margin).
const SETTLE_TICKS = FIELD_EMA_SETTLE + 2;
const groups = (size) => (Array.isArray(size) ? size[0] * (size[1] ?? 1) * (size[2] ?? 1) : 0);

// ---- 1. exactness against the unbudgeted run ----
{
  // 6 x 1 x 6 cores, all demanded; the change: a box over most of them.
  const bounds = { min: [0, 0, 0], max: [192, 32, 192] }, cores = [];
  for (let z = 0; z < bounds.max[2]; z += CORE) for (let x = 0; x < bounds.max[0]; x += CORE) cores.push([x, 0, z]);
  const change = [];
  for (let z = 4; z < 44; z++) for (let y = 0; y < 8; y++) for (let x = 2; x < 42; x++) change.push([x, y, z]);
  const eye = [24, 16, 24];
  function run(budget) {
    const gpu = new FieldTestGPU({ emulateEMA: true }), state = { revision: 0 };
    const source = () => { const revision = state.revision; return { epoch: 0, sourceRevision: revision, jetValidity: 'producer-bounded-v1',
      isCurrent: () => state.revision === revision, assertComplete() {},
      recordGatherRaw(frame, { resources, g, scratchOrigin }) {
        const A = new Float32Array(resources.A.bytes); A.fill(0); new Uint32Array(resources.aeration.bytes).fill(0);
        for (let z = 0; z < 64; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
          const w = [x, y, z].map((v, i) => v + scratchOrigin[i]);
          if (w.some((v, i) => v < bounds.min[i] || v >= bounds.max[i])) continue;
          const inBox = w[0] >= 8 && w[0] < 168 && w[2] >= 16 && w[2] < 176 && w[1] < 32;
          const r = inBox ? state.revision : 0;
          const id = (w[0] + 3 * w[1] + 5 * w[2] + r) % 3 === 0 ? E.WATER : w[1] < 8 + (r % 5) ? E.SAND : E.EMPTY;
          A.set([id, 300 + ((w[0] * 7 + w[2] * 13 + r * 101) % 900), 0.5, 0.31], cellSlot(g, x, y, z) * 4);
        }
      } }; };
    // The book: each published core and the tick it was derived at (a CELL page's fieldTick).
    const book = new Map(), derived = new Map();
    let invalidated = [];
    const fields = new WorldFields(gpu, { worldBounds: bounds, tables: {}, history: new WorldFieldHistory(gpu, { pagesPerSlab: 256, maxPagesPerSlab: 256 }), budget,
      publisher: { recordOwnedFields: (frame, p) => ({ token: p.token, key: brickKey(p.scratchOrigin.map((v) => v + 16)) }),
        publish({ invalidatedCoreKeys }) { invalidated = invalidatedCoreKeys; } } });
    const ticks = [];
    // One lighting tick (wire/worldRender.js): the field tick, then the CELL
    // stage derives every demanded core the book lacks.
    function tick(fieldTick, changedBricks = []) {
      if (changedBricks.length) state.revision++;
      const from = gpu.trace.length, row = { fieldTick, workgroups: 0, first: 0 };
      const fieldPlan = fields.plan({ fieldTick, sourceSnapshot: source(), changedBricks, eye });
      row.first = fieldPlan.budget?.firstWorkgroups ?? 0;
      fields.record(gpu.frame, fieldPlan).retire();
      for (const key of invalidated) book.delete(key);
      const wanted = cores.filter((c) => !book.has(brickKey(c)));
      if (wanted.length) {
        const plan = fields.plan({ fieldTick, sourceSnapshot: source(), wantedCores: wanted });
        // No core is derived while an owner of its EMA halo is pending.
        for (const core of plan.jobs) for (const [owner] of fields.pending) {
          const b = owner.brick;
          assert(!b.every((v, k) => v * 4 + 4 > core[k] - 4 && v * 4 < core[k] + 36), `tick ${fieldTick}: core ${core} derived with pending owner ${b} in its halo`);
        }
        const result = fields.record(gpu.frame, plan); result.retire();
        for (const out of result.outputs) { book.set(out.key, fieldTick); derived.set(out.key, fieldTick); }
      }
      for (const e of gpu.trace.slice(from)) row.workgroups += groups(e.size);
      ticks.push(row);
    }
    return { fields, gpu, book, derived, ticks, tick, backlog: () => fields.pending.size + fields.lagging.size };
  }
  const whole = run(Infinity);
  // A budget a few cores' work: the big change takes several ticks.
  const BUDGET = 6 * (7 * gridDims({ nx: 64, ny: 64, nz: 64 }).nbricks);
  const budgeted = run(BUDGET);
  await Promise.all([whole.fields.ready, budgeted.fields.ready]);
  for (const r of [whole, budgeted]) { r.tick(0); r.tick(1, change); }
  let t = 2, drained = null;
  for (; t < 200; t++) {
    for (const r of [whole, budgeted]) r.tick(t);
    if (drained === null && !budgeted.backlog()) drained = t;
    if (drained !== null && t >= drained + SETTLE_TICKS) break;
  }
  assert(drained !== null && drained > 2, `the budgeted run's backlog ${drained === null ? 'never drained' : 'never formed'}`);
  for (const r of [whole, budgeted]) assert.equal(r.fields.history.unsettledCount(), 0, 'every owner settled');
  const wordsOf = (f) => new Map([...f.history.owners].map(([key, o]) => [key, Array.from(new Uint32Array(o.page.buffer.bytes, o.page.offset, HISTORY_WORDS))]));
  const a = wordsOf(whole.fields), b = wordsOf(budgeted.fields);
  assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort(), 'the budgeted run has other field owners');
  let words = 0;
  for (const [key, w] of a) { assert.deepEqual(b.get(key), w, `owner ${key}: the budgeted run's history words differ`); words += w.length; }
  for (const [key, o] of whole.fields.history.owners) assert.equal(budgeted.fields.history.owners.get(key).age, o.age, `owner ${key}: age`);
  assert.deepEqual([...budgeted.fields.published].sort(), [...whole.fields.published].sort(), 'published cores differ');
  // Every published core was derived after every owner of its halo last advanced: its fields are the current EMA's.
  for (const r of [whole, budgeted]) for (const key of r.fields.published) {
    const core = key.split(',').map(Number), at = r.derived.get(key);
    for (const o of r.fields.history.owners.values()) {
      if (!o.brick.every((v, k) => v * 4 + 4 > core[k] - 4 && v * 4 < core[k] + 36)) continue;
      assert(o.lastTick <= at, `core ${key} derived at ${at}, before its halo owner ${o.brick} advanced at ${o.lastTick}`);
    }
  }
  // The bound: every budgeted tick past the load within the budget, or its first core's work.
  const over = budgeted.ticks.slice(1).filter((r) => r.workgroups > Math.max(BUDGET, r.first));
  assert.equal(over.length, 0, `ticks over the budget: ${JSON.stringify(over)}`);
  const peak = (r) => Math.max(...r.ticks.slice(1).map((x) => x.workgroups));
  assert(peak(whole) > BUDGET, 'the fixture\'s change fits the budget whole: nothing to carry');
  console.log(`PASS budgeted fields equal the unbudgeted ones once drained: ${a.size} owners, ${words} history words, ages and ${whole.fields.published.size} published cores the same;`
    + ` the change's peak tick ${peak(whole)} workgroups whole, at most ${peak(budgeted)} budgeted (budget ${BUDGET}); backlog drained by tick ${drained} (change at tick 1); no core derived from a pending halo`);
  whole.fields.dispose(); budgeted.fields.dispose();
}

// ---- 2./3. the bound on the real CELL path ----
// Ticks of V2's whole-window change before the quiet ones.
const WHOLE_TICKS = 3;
// A world, its V2 window (cells), the demand (every brick within a core of the
// window, and a ground shell elsewhere) and a small change.
async function world({ name, size, win, ticks = 64, budget = WORLD_FIELD_TICK_WORKGROUPS }) {
  const wb = size.map((v) => v / BRICK), gpu = new NullGPU(), g = gridDims({ nx: 32, ny: 32, nz: 32 }), buffer = (n) => gpu.createBuffer({ size: n });
  const sim = { g, gpu, cur: 0, version: 0, origin: { x: 0, y: 0, z: 0 }, L: { TABLES: gpu.layout('TABLES', []) }, tables: {}, marks: buffer(16),
    state: { A: buffer(g.slots * 32), B: buffer(g.slots * 32), F: buffer(g.slots * 8) }, flow: buffer(g.slots * 8), decoPlane: { buffer: buffer(g.slots * 4), offset: 0 },
    _retire: (b) => gpu.retire(b), header() { return { src: this.cur, dst: this.cur, origin: [this.origin.x, 0, this.origin.z] }; }, onShift() { return () => {}; }, attachAeration(a) { this.aeration = a; }, wake() {} };
  const w = { sim, gpu, size, wb, epoch: 1, scene: { key: `field-budget-${name}`, glsl: () => '' }, loaded: true, planted: new Uint8Array(wb[0] * wb[2]), candidates: new Map(), store: new BrickStore(wb),
    gen: { ready: Promise.resolve(), res: { layout: [], entries: () => [], prepassFor() {} } } };
  const source = new WorldRenderSource(w); w.renderSource = source; sim.worldRenderSource = source;
  const producer = new RawWorldSourceProducer(w, source), atlas = new WorldRenderAtlas(gpu, { worldSize: size });
  const cells = new WorldCellAtlasAdapter({ gpu, source, producer, atlas, tables: sim.tables, worldBounds: { min: [0, 0, 0], max: size }, fieldBudget: budget });
  await cells.ready;
  const book = atlas.bookLayout, brick = (i) => [i % wb[0], Math.floor(i / wb[0]) % wb[1], Math.floor(i / (wb[0] * wb[1]))];
  const mid = [Math.floor(size[0] / 2 / CORE) * CORE, 0, Math.floor(size[2] / 2 / CORE) * CORE];
  const window = { lo: [mid[0] - win[0] / 2, 0, mid[2] - win[2] / 2], hi: [mid[0] + win[0] / 2, win[1], mid[2] + win[2] / 2] };
  const eye = [mid[0], Math.min(size[1] - 1, 48), mid[2]];
  const ids = new Set();
  for (let z = 0; z < wb[2]; z++) for (let y = 0; y < wb[1]; y++) for (let x = 0; x < wb[0]; x++) {
    const c = [x, y, z].map((v) => v * BRICK), near = [0, 2].every((k) => c[k] >= window.lo[k] - CORE && c[k] < window.hi[k] + CORE);
    if (near || (y >= 2 && y < 4)) ids.add(worldBrickIndex(book, [x, y, z]));
  }
  const fieldNames = new Set(['fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldPeak', FIELD_HISTORY_KERNEL, 'world owned classifier']);
  const fieldGroups = () => { let n = 0; for (const [k, v] of gpu.workgroups) if (fieldNames.has(k)) n += v; return n; };
  const byKernel = () => Object.fromEntries([...gpu.workgroups].filter(([k]) => fieldNames.has(k)));
  async function tick(fieldTick, change = null) {
    if (change) source.noteContentChange(change);
    gpu.workgroups.clear();
    const t0 = performance.now();
    await worldAdvanceFields(gpu, cells, { fieldTick, eye });
    const advance = fieldGroups();
    await worldClassify(gpu, cells, atlas, ids, { fieldTick }, brick);
    gpu.flush();
    const f = cells.fields;
    return { fieldTick, workgroups: fieldGroups(), advance, kernels: byKernel(), pending: f.pending.size, lagging: f.lagging.size, first: f.lastFirstWorkgroups ?? 0, ms: performance.now() - t0 };
  }
  const load = await tick(0);
  // Whole window: V2's change every tick (renderSource.js noteContentChange of the window's box), for a few ticks.
  const rows = { whole: [], small: [] };
  let t = 1;
  for (; t <= WHOLE_TICKS; t++) rows.whole.push(await tick(t, window));
  let drainedAt = null;
  for (; t < ticks; t++) { const r = await tick(t); rows.whole.push(r); if (!r.pending && !r.lagging) { drainedAt = t; break; } }
  for (let k = 0; k < FIELD_EMA_SETTLE + 1; k++) await tick(++t);
  // Small: an 8-cell box at the window's middle.
  const small = { lo: [mid[0] - 4, 8, mid[2] - 4], hi: [mid[0] + 4, 16, mid[2] + 4] };
  rows.small.push(await tick(++t, small));
  for (let k = 0; k < 2; k++) rows.small.push(await tick(++t));
  return { name, size, win, budget, demanded: ids.size, load, rows, drainedAt, owners: cells.fields.history.owners.size, cells };
}
const report = (r) => {
  const peak = (list) => Math.max(...list.map((x) => x.workgroups)), sum = (list) => list.reduce((n, x) => n + x.workgroups, 0);
  return `${r.name} ${r.size.join('x')} window ${r.win.join('x')} (${r.demanded} bricks demanded, ${r.owners} owners), budget ${r.budget}: whole-window change peak tick ${peak(r.rows.whole)} workgroups`
    + ` (${sum(r.rows.whole)} over ${r.rows.whole.length} ticks, drained at tick ${r.drainedAt}${r.lag !== undefined ? `, ${r.lag} ticks after the change's last, bound ${r.lagBound}` : ''}); small change peak ${peak(r.rows.small)}`;
};
const cases = SCALE
  ? [{ name: 'Island', size: [1024, 128, 1024], win: [128, 128, 128] }, { name: 'Descent', size: [512, 256, 512], win: [128, 256, 128] }]
  : [{ name: 'gate', size: [384, 64, 384], win: [128, 64, 128] }];
for (const c of cases) {
  const before = await world({ ...c, budget: Infinity }), after = await world(c);
  if (VERBOSE) for (const r of [before, after]) console.log(JSON.stringify({ name: r.name, budget: r.budget, rows: r.rows }));
  for (const [kind, list] of Object.entries(after.rows)) for (const r of list) {
    assert(r.workgroups <= Math.max(after.budget, r.first), `${c.name} ${kind} tick ${r.fieldTick}: ${r.workgroups} field workgroups over the budget ${after.budget} (first core ${r.first})`);
  }
  assert(after.drainedAt !== null, `${c.name}: the backlog never drained`);
  const total = before.rows.whole.reduce((n, x) => n + x.workgroups, 0);
  // The lag: drained within twice the ticks the unbudgeted work over the budget
  // takes (a core re-derived while its halo still settles is derived again
  // once it has), and the settle.
  if (VERBOSE) console.log(after.rows.whole.map((r) => [r.fieldTick, r.workgroups, r.advance, r.pending, r.lagging, r.first].join('/')).join(' '));
  const lag = after.drainedAt - WHOLE_TICKS, bound = 2 * Math.ceil(total / after.budget) + FIELD_EMA_SETTLE;
  assert(lag <= bound, `${c.name}: drained ${lag} ticks after the change, past ${bound} (${total} workgroups over a ${after.budget} budget)`);
  after.lag = lag; after.lagBound = bound;
  // The small change is one tick, within the budget, its work the unbudgeted path's.
  assert.equal(after.rows.small[0].workgroups, before.rows.small[0].workgroups, `${c.name}: a small change's tick is not the unbudgeted one`);
  console.log(`${SCALE ? '' : 'PASS '}before: ${report(before)}`);
  console.log(`${SCALE ? '' : 'PASS '}after:  ${report(after)}`);
  if (VERBOSE || SCALE) for (const [label, r] of [['before', before], ['after', after]]) console.log(`  ${label} kernels, first whole-window tick: ${JSON.stringify(r.rows.whole[0].kernels)}; small: ${JSON.stringify(r.rows.small[0].kernels)}`);
}
