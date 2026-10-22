// A big map's field plan costs its change, not its window, and is the plan the
// old planner made. CPU only.
//
// V2 notes its whole window every step (renderSource.js changesSince), so each
// lighting tick hands WorldFields every brick of it as changed. The planner
// visited each changed brick's 27 neighbours by string key (2.2 million
// lookups a tick on Descent), copied every owner it changed, sorted them all,
// keyed every advancing owner's core, and history re-keyed each one at the
// commit (2026-10-22): 120 ms a tick on Island, 330 ms on Descent, of JS alone.
//
//   1. Exactness: the planner and recording (src/world/fields.js) against the
//      old ones (tools/world-field-reference/, the code before the change) on
//      random ticks: dense windows, small boxes, scattered and out-of-world
//      bricks, repeats, wanted cores, smoothing and aeration switches, sourcePlan
//      reuse, same-tick records and failed publications. Every plan's advancing
//      owners, flags, batches, jobs, regions and touched cores; every history
//      copy dispatch and its jobs; the EMA lists and ages each EMA dispatch
//      reads; every publication; and history after each record (owners, pages,
//      ages, ticks, order, free pages, unsettled owners) must match.
//   2. Cost: on a 128-cell window over a big ground, a tick of the same change
//      makes at most OPS_PER_BATCH Map/Set calls a batch (none a brick), any
//      later tick at most OPS_PER_BRICK a changed brick, and every one at least
//      MIN_GAIN times fewer than the old planner (about 50 a brick, every tick).
//
//   node tools/world-field-owners-cpu-check.mjs [--steps 160] [--seed 7] [--verbose]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WorldFields } from '../src/world/fields.js';
import { WorldFieldHistory, unsettledLive } from '../src/world/fieldHistory.js';
import { WorldFields as OldFields } from './world-field-reference/fields.js';
import { WorldFieldHistory as OldHistory } from './world-field-reference/fieldHistory.js';
import { FieldTestGPU, FIELD_HISTORY_KERNEL } from './field-test-gpu.mjs';
import { NullGPU } from './world-cell-null-gpu.mjs';
import { FIELD_EMA_SETTLE } from '../src/shaders/fields.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const STEPS = opt('steps', 160), VERBOSE = args.includes('--verbose');
let seed = opt('seed', 7) >>> 0;
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32, int = (n) => Math.floor(rand() * n);

// ---- 1. exactness against the old planner ----
// A world of 6 x 2 x 5 cores, small enough for byte-backed buffers.
const BOUNDS = { min: [0, 0, 0], max: [192, 64, 160] }, WB = BOUNDS.max.map((v) => v / 4);
const hash = (u32) => { let h = 2166136261 >>> 0; for (let i = 0; i < u32.length; i++) { h ^= u32[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
function side(Fields, History) {
  const gpu = new FieldTestGPU({ emulateCopies: true }), log = [], state = { revision: 0, aeration: true, failPublish: false };
  const fields = new Fields(gpu, { worldBounds: BOUNDS, tables: {}, history: new History(gpu, { pagesPerSlab: 256 }), publisher: {
    recordOwnedFields(frame, p) { log.push(['owned', p.scratchOrigin.join(), p.ownedWorldBricks.length]); return { token: p.token }; },
    publish({ invalidatedCoreKeys }) { if (state.failPublish) throw new Error('Injected publication failure'); log.push(['publish', invalidatedCoreKeys.join(' ')]); } } });
  gpu.onDispatch = (k, opts) => {
    if (k.name === FIELD_HISTORY_KERNEL) {
      const p = opts.params, jobs = new Uint32Array(opts.bind[0].entries[0].resource.buffer.bytes);
      log.push(['copies', p.first, p.count, p.scatter, p.slab, hash(jobs.subarray(3 * p.first, 3 * (p.first + p.count)))]);
    } else if (k.name === 'fieldEma') {
      const s = fields.scratch;
      log.push(['ema', hash(new Uint32Array(s.dlist.bytes)), hash(new Uint32Array(s.age.bytes)), hash(new Uint32Array(s.ema.bytes))]);
    }
  };
  const snapshot = () => { const r = state.revision, a = state.aeration; return { epoch: fields.history.epoch, sourceRevision: r, jetValidity: 'producer-bounded-v1', aerationActive: a,
    isCurrent: () => state.revision === r, assertComplete() {}, recordGatherRaw() {} }; };
  return { gpu, fields, log, state, snapshot };
}
const fresh = side(WorldFields, WorldFieldHistory), old = side(OldFields, OldHistory);
await Promise.all([fresh.fields.ready, old.fields.ready]);

const keyOf = (b) => b.join(',');
function planView(plan, isOld) {
  return {
    advancing: plan.advancing.map((o) => keyOf(o.brick)),
    batches: plan.batches.map((b, i) => ({ core: b.core.join(), owners: b.owners.map((o) => keyOf(o.brick)), changed: b.owners.map((o, k) => isOld ? (o.changed ? 1 : 0) : plan.batches[i].changed[k]) })),
    jobs: plan.jobs.map((c) => c.join()), regions: JSON.stringify(plan.regions),
    nearAdvancing: [...plan.nearAdvancing].sort(), nearChanged: [...plan.nearChanged].sort(),
  };
}
function historyView(side, isOld) {
  const h = side.fields.history, page = (p) => p && `${h.slabs.indexOf(p.buffer)}:${p.offset}`;
  const unsettled = isOld ? [...h.unsettled].flatMap(([t, keys]) => [...keys].map((k) => `${t}@${k}`))
    : [...h.unsettled].flatMap(([t, list]) => list.filter((o) => unsettledLive(o, t)).map((o) => `${t}@${keyOf(o.brick)}`));
  return {
    owners: [...h.owners].map(([k, o]) => [k, page(o.page), o.age, o.lastTick, o.sourceVersion, o.order]),
    order: h.order, free: h.free.map(page), slabs: h.slabs.length, unsettled: unsettled.sort(),
    fields: [side.fields.lastTick, side.fields.version, side.fields.smoothing, side.fields.aerationActive, [...side.fields.published].join(' ')],
  };
}
const randomBrick = (pad = 0) => WB.map((n) => int(n + 2 * pad) - pad);
function randomChange(previous) {
  const r = rand();
  if (r < 0.12) return previous;                                   // the same list again
  if (r < 0.2) return previous.map((b) => [...b]);                  // the same bricks, a new list
  if (r < 0.3) return [];
  const out = [];
  const box = (lo, size) => { for (let z = lo[2]; z < lo[2] + size[2]; z++) for (let y = lo[1]; y < lo[1] + size[1]; y++) for (let x = lo[0]; x < lo[0] + size[0]; x++) out.push([x, y, z]); };
  if (r < 0.55) box(randomBrick(1), [1 + int(16), 1 + int(12), 1 + int(16)]);            // a window, maybe past an edge
  else if (r < 0.75) for (let k = 0, n = 1 + int(4); k < n; k++) box(randomBrick(), [1 + int(4), 1 + int(4), 1 + int(4)]);
  else for (let k = 0, n = 1 + int(40); k < n; k++) out.push(randomBrick(3));                 // scattered, some outside
  if (rand() < 0.2 && out.length) out.push([...out[int(out.length)]]);                         // a repeat
  return out;
}
const randomCores = () => {
  const out = [];
  if (rand() < 0.5) return out;   // a field tick (worldAdvanceFields): no wanted cores
  for (let k = 0, n = int(5); k < n; k++) out.push([int(8) - 1, int(3), int(7) - 1].map((v) => v * 32));
  return out;
};
let tick = 0, changed = [], compared = 0, failures = 0, recorded = 0, retry = false;
const outcome = (fn) => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };
for (let step = 0; step < STEPS; step++) {
  // After a failed record the same tick and change again (a tick is never skipped).
  const sameTick = !retry && step > 0 && rand() < 0.25 && fresh.fields.lastTick === tick;
  if (!sameTick && !retry) {
    if (step > 0) tick++;
    changed = randomChange(changed);
    if (changed.length) for (const s of [fresh, old]) s.state.revision++;
    if (rand() < 0.05 && step > 2) for (const s of [fresh, old]) s.state.aeration = !s.state.aeration;
  }
  const options = { fieldTick: tick, wantedCores: randomCores(), changedBricks: sameTick ? [] : changed, smoothing: rand() < 0.08 ? 0.5 : 1, full: rand() < 0.1 };
  if (VERBOSE) console.log('step', step, 'tick', tick, sameTick ? 'same tick' : '', retry ? 'retry' : '', options.changedBricks.length, 'changed');
  const reuse = rand() < 0.5, fail = rand() < 0.07;
  const run = (s, isOld) => {
    s.state.failPublish = fail;
    const planned = outcome(() => {
      const prior = reuse ? s.fields.sourcePlan({ ...options, sourceSnapshot: s.snapshot() }) : null;
      return s.fields.plan({ ...options, sourceSnapshot: s.snapshot() }, prior);
    });
    if (planned.error) return { plan: planned.error };
    // A failed record quarantines its pages in both alike (fields.js record).
    const recordedOutcome = outcome(() => { const r = s.fields.record(s.gpu.frame, planned.value); r.retire(); return 'ok'; });
    return { plan: planView(planned.value, isOld), record: recordedOutcome.error ?? recordedOutcome.value };
  };
  const a = run(fresh, false), b = run(old, true);
  assert.deepEqual(a.plan, b.plan, `step ${step} (tick ${tick}): the plan differs from the old planner's`);
  assert.equal(a.record, b.record, `step ${step}: the recording's outcome differs`);
  assert.deepEqual(fresh.log, old.log, `step ${step}: GPU history copies, EMA inputs or publications differ`);
  assert.deepEqual(historyView(fresh, false), historyView(old, true), `step ${step}: history differs after the record`);
  if (a.record === 'ok') recorded++; else if (a.record) failures++;
  retry = a.record !== undefined && a.record !== 'ok';
  compared += fresh.log.length; fresh.log.length = 0; old.log.length = 0;
  if (VERBOSE) console.log('  ', typeof a.plan === 'string' ? a.plan : `${a.plan.advancing.length} advancing, ${a.plan.batches.length} batches, ${a.plan.jobs.length} jobs`, a.record ?? '');
}
assert(recorded > STEPS / 2 && failures > 0, `the random ticks recorded ${recorded} and failed ${failures}: too few of either to compare`);
console.log(`PASS the field planner makes the old planner's plans: ${STEPS} random ticks (${recorded} recorded, ${failures} failed alike), ${compared} history copy, EMA and publication events, and history after each, identical`);

// ---- 2. cost: Map/Set calls a tick, against the change ----
// Island's ground and V2 window, cut down: a 128 x 128 x 128-cell window
// changed every tick over a settled ground of a 512 x 128 x 512 world.
const OPS_PER_BATCH = 32, OPS_PER_BRICK = 1, MIN_GAIN = 20, WIN = 128;
const ops = { n: 0 };
for (const proto of [Map.prototype, Set.prototype]) for (const name of ['get', 'has', 'set', 'add', 'delete']) {
  const f = proto[name];
  if (!f) continue;
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...a) { ops.n++; return f.apply(this, a); } });
}
async function costRun(Fields, History) {
  const size = [512, 128, 512], wb = size.map((v) => v / 4), gpu = new NullGPU(), state = { revision: 0 };
  const fields = new Fields(gpu, { worldBounds: { min: [0, 0, 0], max: size }, tables: {}, history: new History(gpu), publisher: { recordOwnedFields: () => ({}), publish() {} } });
  await fields.ready;
  const h = fields.history;
  // A settled ground: what a load leaves (born settled).
  const ground = [];
  for (let z = 0; z < wb[2]; z++) for (let x = 0; x < wb[0]; x++) for (let y = 10; y < 14; y++) ground.push([x, y, z]);
  const snapshot = () => { const r = state.revision; return { epoch: h.epoch, sourceRevision: r, jetValidity: 'producer-bounded-v1', aerationActive: true, isCurrent: () => state.revision === r, assertComplete() {}, recordGatherRaw() {} }; };
  const tickOf = (fieldTick, changedBricks) => {
    const options = { fieldTick, wantedCores: [], changedBricks, smoothing: 1 };
    const n0 = ops.n, t0 = performance.now();
    const prior = fields.sourcePlan({ ...options, sourceSnapshot: snapshot() });
    const t1 = performance.now();
    const plan = fields.plan({ ...options, sourceSnapshot: snapshot() }, prior);
    fields.record(gpu.frame, plan).retire(); gpu.flush();
    return { ops: ops.n - n0, planMs: t1 - t0, recordMs: performance.now() - t1, advancing: plan.advancing.length, batches: plan.batches.length };
  };
  state.revision++; tickOf(0, ground);
  const origin = [192, 0, 192], windowOf = () => {
    const out = [];
    for (let z = origin[2] / 4; z < (origin[2] + WIN) / 4; z++) for (let y = 0; y < wb[1]; y++) for (let x = origin[0] / 4; x < (origin[0] + WIN) / 4; x++) out.push(Object.freeze([x, y, z]));
    return Object.freeze(out);
  };
  const rows = [];
  for (let t = 1; t <= 6; t++) { if (t === 5) origin[0] += 16; state.revision++; rows.push({ t, walk: t === 5, ...tickOf(t, windowOf()) }); }
  return { rows, changed: windowOf().length };
}
const now = await costRun(WorldFields, WorldFieldHistory), before = await costRun(OldFields, OldHistory);
if (VERBOSE) console.log(JSON.stringify(now.rows), JSON.stringify(before.rows));
const steady = now.rows.filter((r) => r.t === 3 || r.t === 4), walk = now.rows.find((r) => r.walk);
// Ticks 1 and 2 meet the window first (its air owners are made, then found);
// 3 and 4 repeat its change; 5 walks it 16 cells; 6 finds the walked one.
for (const r of steady) assert(r.ops <= OPS_PER_BATCH * r.batches, `a tick of the same ${now.changed}-brick change made ${r.ops} Map/Set calls for ${r.batches} batches`);
for (const [k, r] of now.rows.entries()) {
  assert.equal(r.advancing, before.rows[k].advancing, 'the cost runs advance the same owners');
  if (r.t < 2) continue;
  assert(r.ops <= OPS_PER_BRICK * now.changed, `tick ${r.t} made ${r.ops} Map/Set calls for ${now.changed} changed bricks`);
  assert(r.ops * MIN_GAIN <= before.rows[k].ops, `tick ${r.t} made ${r.ops} Map/Set calls, the old planner ${before.rows[k].ops}: under ${MIN_GAIN}x fewer`);
}
const ms = (rows) => rows.map((r) => (r.planMs + r.recordMs).toFixed(1)).join('/');
console.log(`PASS a field tick's Map/Set calls follow its change, not its window: ${now.changed} changed bricks a tick; ticks 2-6 ${now.rows.slice(1).map((r) => r.ops).join('/')} calls (the same change again: ${steady[0].ops} for ${steady[0].batches} batches; the walk: ${walk.ops}), the old planner ${before.rows.slice(1).map((r) => r.ops).join('/')}`);
console.log(`(info, not checked) ms a tick (plan + record) ticks 1-6: now ${ms(now.rows)}, old ${ms(before.rows)}; settle ${FIELD_EMA_SETTLE}`);
