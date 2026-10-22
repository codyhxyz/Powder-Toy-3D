import assert from 'node:assert/strict';
import { E } from '../src/elements.js';
import { JOIN_REACH } from '../src/shaders/gfx/liquidDetail.js';
import { PHYS } from '../src/physics.js';
import { cellSlot } from '../src/shaders/common.js';
import { FIELD_EMA_SETTLE, FIELD_REACH, BLUR_REACH }  from '../src/shaders/fields.js';
import { WorldFields, FIELD_DEMAND, fieldInterval } from '../src/world/fields.js';
import { WorldFieldHistory } from '../src/world/fieldHistory.js';
import { FieldTestGPU } from './field-test-gpu.mjs';
import { QuantizedFields, pack4, unpack4, half, unhalf, pack2, unpack2, roundEven, jetAt, validWake, emaWords } from './field-reference.mjs';

// Packing gates: exact bits including ties/subnormals, not float tolerances.
assert.equal(pack4([0, 1, 0.5, 0.25]), 0x4080ff00);
assert.equal(roundEven(-0.5), 0); assert.equal(roundEven(1.5), 2); assert.equal(roundEven(2.5), 2);
assert.equal(half(1), 0x3c00); assert.equal(half(-0), 0x8000); assert.equal(half(65504), 0x7bff);
assert.equal(half(2 ** -24), 1); assert.equal(half(2 ** -25), 0); assert.equal(half(3 * 2 ** -25), 2);
assert.equal(half(1 + 2 ** -11), 0x3c00); assert.equal(half(1 + 3 * 2 ** -11), 0x3c02);
for (let w = 0; w < 65536; w++) if ((w & 0x7c00) !== 0x7c00) assert.equal(half(unhalf(w)), w);
assert.deepEqual(unpack2(pack2([0.5, -2])), [0.5, -2]);
for (let b = 0; b < 256; b++) assert.equal(pack4(unpack4((b * 0x01010101) >>> 0)), (b * 0x01010101) >>> 0);
for (const [name, r] of Object.entries(FIELD_DEMAND)) {
  const interval = fieldInterval(name, 3);
  assert(interval.lo.every((v) => v >= 0)); assert(interval.hi.every((v) => v <= 64));
  assert.deepEqual(interval.lo, r.map((v) => 13 - v));
}
// (V1 whitewater's wake producer, liquidDetail.js aerationFrag, went with V1: the wakes below are what
// a World field still accepts from a source, and rejects past them)
assert.equal(BLUR_REACH, 2); assert.equal(FIELD_REACH, 4); assert.equal(JOIN_REACH, 4);
let normalSupport = 0;
for (let fraction = 0; fraction < 1000; fraction++) for (const h of [-0.55, -0.25, 0.25, 0.55]) {
  const i = Math.floor(fraction / 1000 + h - 0.5);
  for (const c of [-1, 0, 1, 2]) normalSupport = Math.max(normalSupport, Math.abs(i + c));
}
assert.equal(normalSupport, 3);
assert.equal(FIELD_REACH + JOIN_REACH + normalSupport, 11); assert(11 < 16);
// Actual producer invariant (not a velocity limit): normalize arbitrary finite
// high-speed vectors first, then half-store components, so rounded JOIN offsets
// remain <=4. Invalid oversized/nonfinite imported wakes are rejected.
for (const v of [[1e20, -2e20, 3e20], [1, 1, 1], [-1, 0, 0], [0, 1, 0]]) {
  const length = Math.hypot(...v), wake = v.map((n) => unhalf(half(n / length)));
  assert(validWake([wake[0], -1, wake[1], wake[2]]));
  for (let k = 1; k <= 4; k++) assert(wake.every((n) => Math.abs(roundEven(n * k)) <= 4));
}
assert(!validWake([2, -1, 0, 0])); assert(!validWake([NaN, -1, 0, 0]));
assert.throws(() => jetAt([0, 0, 0], () => [2, -1, 0, 0]), /Unsupported/);
for (const distance of [1, 2, 3, 4, 5]) {
  const get = ([x]) => x === 0 ? [1, -1, 0, 0] : x === -distance ? [0, 2, 0, 0] : [0, 0, 0, 0];
  assert.equal(jetAt([0, 0, 0], get), distance <= 4);
  assert.equal(jetAt([0, 0, 0], get, false), false);
}
// Actual quantized recurrence reaches the advertised fixed point by tick13;
// skipping settled owners is equivalent to another explicit recurrence.
for (const id of [E.EMPTY, E.WATER, E.SAND, E.WOOD, E.SMOKE, E.FIRE]) for (const life of [0, 0.013, 0.5, 0.97, 1]) {
  for (const old of [0, 1, 63, 127, 128, 254, 255]) {
    const a = [id, 1729, life, 0.319], seed = pack4([old / 255, old / 255, old / 255, old / 255]);
    let history = [seed, seed, seed];
    for (let tick = 0; tick < FIELD_EMA_SETTLE; tick++) history = emaWords(a, false, history);
    assert.deepEqual(emaWords(a, false, history), history, 'settled skip differs from quantized recurrence');
  }
  // A fresh owner starts at its target, already the recurrence's fixed point:
  // WorldFields births it settled (fields.js), so skipping it is exact.
  for (const jet of [false, true]) {
    const born = emaWords([id, 1729, life, 0.319], jet);
    assert.deepEqual(emaWords([id, 1729, life, 0.319], jet, born), born, 'a born owner is not at its fixed point');
  }
}
const seen = new Set();
const ids = [E.WATER, E.OIL, E.ICE, E.LAVA, E.SAND, E.STONE, E.WOOD, E.PLANT, E.SMOKE, E.STEAM, E.CLOUD, E.FIRE, E.METAL, E.EMPTY];
assert(ids.every(Number.isInteger));
const raw = ([x, y, z]) => {
  // Liquid films against a crisp wall, plus all material/media channels and
  // seed-varied rubble on 4/32-cell edges/corners and throughout height384.
  let id = ids[Math.abs((x * 13 + y * 7 + z * 3) % ids.length)];
  if (x === 30) id = E.METAL;
  if (x === 31 && y % 32 < 8) id = E.WATER;
  seen.add(id);
  return [id, 200 + ((x * 37 + y * 13) % 2500), ((x + z) % 17) / 16, 3 + ((x * 19 + y * 23 + z * 29) % 997) / 997];
};
const aeration = ([x, y, z]) => x % 32 === 31 && y % 4 === 0 && z % 4 === 0 ? [1, -0.75, 0, 0]
  : x % 32 === 27 && y % 4 === 0 && z % 4 === 0 ? [0, 2, 0, 0] : [0, 0, 0, 0];
const bounds = { min: [0, 0, 0], max: [96, 384, 96] };
let compared = 0;
const stages = ['ema', 'blur0', 'blur1', 'blur2', 'boost0', 'boost1', 'boost2', 'peak'];
// Actual core/demand helpers define partition ownership and valid intervals.
const samples = [[4, 4, 4], [31, 31, 31], [32, 32, 32], [63, 32, 31], [64, 31, 32], [95, 383, 95],
  [0, 0, 0], [0, 383, 95], [95, 0, 95], [95, 383, 0], [0, 383, 0], [95, 0, 0], [0, 0, 95],
  [0, 32, 32], [95, 32, 32], [32, 0, 32], [32, 383, 32], [32, 32, 0], [32, 32, 95],
  ...[0, 95].flatMap((x) => [0, 383].map((y) => [x, y, 32])),
  ...[0, 95].flatMap((x) => [0, 95].map((z) => [x, 32, z])),
  ...[0, 383].flatMap((y) => [0, 95].map((z) => [32, y, z])),
  ...[127, 128, 255, 256, 351, 352].map((y) => [32, y, 32])];
for (const smoothing of [0, 1, 2.5]) {
  const contiguous = new QuantizedFields({ bounds, raw, aeration, smoothing });
  const jobs = new Map();
  for (const p of samples) { const core = p.map((v) => Math.floor(v / 32) * 32), key = core.join(','); if (!jobs.has(key)) jobs.set(key, { core, points: [] }); jobs.get(key).points.push(p); }
  // Reversed/odd arrangements plus a deterministic non-axis job order.
  for (const { core, points } of [...jobs.values()].reverse()) {
    const scratchOrigin = core.map((v) => v - 16), partition = new QuantizedFields({ bounds, raw, aeration, smoothing, scratchOrigin, domainFor: (s) => fieldInterval(s, 3) });
    for (const p of points) for (const stage of stages) {
      assert.deepEqual(partition.stage(stage, p), contiguous.stage(stage, p), `${smoothing}/${stage}/${p}`); compared++;
    }
  }
}
// Exhaustive valid stage intervals and every owned final half word in an
// odd three-core domain. Scratch is poisoned conceptually by having no cached
// values from any prior job; all demand is recomputed, never Box COVER.
let denseCompared = 0;
const denseBounds = { min: [0, 0, 0], max: [96, 8, 8] };
const dense = new QuantizedFields({ bounds: denseBounds, raw, aeration });
for (const core of [[64, 0, 0], [0, 0, 0], [32, 0, 0]]) {
  const origin = core.map((v) => v - 16), partition = new QuantizedFields({ bounds: denseBounds, raw, aeration,
    scratchOrigin: origin, domainFor: (s) => fieldInterval(s) });
  for (const stage of stages) {
    const interval = fieldInterval(stage), lo = interval.lo.map((v, i) => Math.max(v + origin[i], denseBounds.min[i])), hi = interval.hi.map((v, i) => Math.min(v + origin[i], denseBounds.max[i]));
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
      const p = [x, y, z]; assert.deepEqual(partition.stage(stage, p), dense.stage(stage, p), `full interval ${stage}/${p}`); denseCompared++;
    }
  }
}
assert.equal(seen.size, ids.length, 'fixtures must actually encounter every advertised material');
// Every pure material channel and a one-cell film: crisp cells contribute no
// denominator; smooth non-liquid solids exclude liquid/media normalization.
for (const id of ids) {
  const words = emaWords([id, 1600, 0.5, 3.314], false);
  assert.equal(words.length, 3);
  if (id === E.METAL) assert.equal(words[2], 0);
  if ([E.LAVA, E.SAND, E.WOOD].includes(id)) assert.equal(words[2] & 255, 0);
}
assert.equal(emaWords([E.FIRE, PHYS.AMBIENT + 2500, 1, 0], false)[1], 0xffff0000);
assert.equal(emaWords([E.EMPTY, 20, 0, 0], true)[0] & 255, 255);
const filmBounds = { min: [0, 0, 0], max: [96, 32, 32] };
const film = new QuantizedFields({ bounds: filmBounds, raw: ([x]) => [x < 31 ? E.METAL : x === 31 ? E.WATER : E.EMPTY, 20, 0, 0] });
assert(unhalf(film.stage('peak', [31, 16, 16])[0]) >= 0.5, 'normalized one-cell liquid film survives a crisp wall');

// Field boundary queries including cubic integer support and normal offsets.
const contiguous = new QuantizedFields({ bounds, raw, aeration });
const partition = new QuantizedFields({ bounds, raw, aeration, scratchOrigin: [16, 16, 16], domainFor: (s) => fieldInterval(s, 3) });
function sample(ref, p, cubic) {
  p = p.map((v, i) => Math.max(ref.bounds.min[i] + 0.5, Math.min(ref.bounds.max[i] - 0.5, v)));
  const base = p.map((v) => Math.floor(v - 0.5)), t = p.map((v, i) => v - 0.5 - base[i]);
  const weights = t.map((a) => cubic ? [(1 - a) ** 3 / 6, (3 * a ** 3 - 6 * a * a + 4) / 6, (-3 * a ** 3 + 3 * a * a + 3 * a + 1) / 6, a ** 3 / 6] : [1 - a, a]);
  let value = 0;
  for (let z = 0; z < weights[2].length; z++) for (let y = 0; y < weights[1].length; y++) for (let x = 0; x < weights[0].length; x++) {
    const q = base.map((v, i) => Math.max(ref.bounds.min[i], Math.min(ref.bounds.max[i] - 1, v + [x, y, z][i] - (cubic ? 1 : 0))));
    value += unhalf(ref.stage('peak', q)[0]) * weights[0][x] * weights[1][y] * weights[2][z];
  }
  return value;
}
for (const boundary of [32, 36]) for (const epsilon of [-0.001, 0, 0.001]) for (const cubic of [false, true]) {
  const p = [boundary + epsilon, 32 + epsilon, 32 + epsilon];
  assert(Math.abs(sample(contiguous, p, cubic) - sample(partition, p, cubic)) <= 1e-5);
  for (const h of [0.25, 0.55]) for (let axis = 0; axis < 3; axis++) {
    const a = [...p], b = [...p]; a[axis] -= h; b[axis] += h;
    const n0 = sample(contiguous, a, cubic) - sample(contiguous, b, cubic), n1 = sample(partition, a, cubic) - sample(partition, b, cubic);
    assert(Math.abs(n0 - n1) <= 1e-5);
  }
}
for (const point of [[0, 0, 0], [96, 384, 96], [0, 32, 32], [96, 32, 32]]) {
  const core = point.map((v, i) => Math.floor(Math.max(0, Math.min(bounds.max[i] - 1, v)) / 32) * 32);
  const partition = new QuantizedFields({ bounds, raw, aeration, scratchOrigin: core.map((v) => v - 16), domainFor: (s) => fieldInterval(s, 3) });
  for (const epsilon of [-0.001, 0, 0.001]) for (const cubic of [false, true]) {
    const p = point.map((v) => v + epsilon); assert.equal(sample(contiguous, p, cubic), sample(partition, p, cubic));
  }
}
// Negative controls: wrong scratch-edge boundary, and insufficient support.
const clipped = new QuantizedFields({ bounds: { min: [32, 0, 0], max: [64, 384, 96] }, raw, aeration });
assert.notDeepEqual(clipped.stage('peak', [32, 32, 32]), contiguous.stage('peak', [32, 32, 32]));
const tooSmall = new QuantizedFields({ bounds, raw, aeration, scratchOrigin: [32, 32, 32], scratchSize: 32 });
assert.throws(() => tooSmall.stage('peak', [32, 32, 32]), /Unavailable/);
console.log(`PASS quantized field reference: ${compared + denseCompared} packed stage comparisons (including exhaustive 3-core stage intervals/all owned final words); materials/films/walls/fire/aeration; 4/32 faces/corners/world edges/height384; epsilon/cubic/normal queries; negative controls`);

// Actual WorldFields + FieldDeriver/kernel factories + native-copy history,
// executed by a fake encoder (EMA numerics use the quantized reference above).
const smallBounds = { min: [0, 0, 0], max: [96, 8, 8] }, wanted = [[0, 0, 0], [32, 0, 0], [64, 0, 0]];
function setup(reverse = false) {
  const gpu = new FieldTestGPU({ emulateEMA: true }), published = [], state = { revision: 0, epoch: 0, complete: true, gathers: 0, failAt: -1 };
  const source = () => { const sourceVersion = state.revision, sourceEpoch = state.epoch; return ({ epoch: state.epoch, sourceRevision: state.revision, jetValidity: 'producer-bounded-v1',
    isCurrent: () => state.epoch === sourceEpoch && state.epoch === fields.history.epoch && state.revision === sourceVersion,
    assertComplete(regions) { if (!state.complete) throw new Error('Missing in-world source'); assert(regions.every((r) => r.lo.every((v, i) => v <= r.hi[i]))); },
    recordGatherRaw(frame, { resources, g, scratchOrigin, sourceRevision }) {
      gpu.trace.push({ name: 'gatherRaw', scratchOrigin });
      if (++state.gathers === state.failAt) throw new Error('Injected gather retry');
      assert.equal(sourceRevision, state.revision);
      const A = new Float32Array(resources.A.bytes); A.fill(0); new Uint32Array(resources.aeration.bytes).fill(0);
      for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = Math.max(0, scratchOrigin[0]); x < Math.min(96, scratchOrigin[0] + 64); x++) {
        const p = [x, y, z].map((v, i) => v - scratchOrigin[i]), s = cellSlot(g, ...p);
        const id = state.revision && x >= 28 && x < 36 ? E.SAND : x % 2 ? E.WATER : E.EMPTY;
        A.set([id, 1200, 0.5, 0.31], s * 4);
      }
    } }); }; 
  const fields = new WorldFields(gpu, { worldBounds: smallBounds, tables: {}, publisher: {
    recordOwnedFields(frame, payload) { gpu.trace.push({ name: 'ownedFields', payload }); return { token: payload.token, bricks: payload.ownedWorldBricks.map((b) => [...b]) }; },
    publish(snapshot) { gpu.trace.push({ name: 'publish', snapshot }); published.push(snapshot); },
  } });
  const snapshot = () => source();
  const plan = (tick, options = {}) => fields.plan({ fieldTick: tick, sourceSnapshot: snapshot(), wantedCores: reverse ? [...wanted].reverse() : wanted, ...options });
  return { gpu, fields, state, plan, published, snapshot };
}
function wordsOf(fields) {
  return Object.fromEntries([...fields.history.owners].sort(([a], [b]) => a.localeCompare(b)).map(([key, owner]) => [key,
    Array.from(new Uint32Array(owner.page.buffer.bytes, owner.page.offset, 192))]));
}
function record(ctx, plan) { const result = ctx.fields.record(ctx.gpu.frame, plan); result.retire(); return result; }
// A rejected publication must not commit history that only exists in an
// encoder the caller discards. Exercise initial and replacement publications.
for (const replacing of [false, true]) {
  const ctx = setup(), control = setup(true);
  await Promise.all([ctx.fields.ready, control.fields.ready]);
  if (replacing) {
    record(ctx, ctx.plan(0)); record(control, control.plan(0));
    ctx.state.revision = control.state.revision = 1;
  }
  const tick = replacing ? 1 : 0;
  const changedBricks = replacing ? Array.from({ length: 8 }, (_, i) => [7 + (i & 1), (i >> 1) & 1, i >> 2]) : [];
  const plan = ctx.plan(tick, { changedBricks, full: true });
  const prior = { owners: ctx.fields.history.owners, words: wordsOf(ctx.fields),
    version: ctx.fields.version, tick: ctx.fields.lastTick, token: ctx.fields.publishedToken,
    published: [...ctx.fields.published], snapshots: [...ctx.published] };
  const copies = [], copy = ctx.gpu.frame.copy, publish = ctx.fields.publisher.publish;
  ctx.gpu.frame.copy = (...args) => copies.push(args);
  ctx.gpu.emulateEMA = false; // Nothing from the discarded encoder executes.
  ctx.fields.publisher.publish = () => { throw new Error('Injected publication failure'); };
  let error;
  try { ctx.fields.record(ctx.gpu.frame, plan); } catch (e) { error = e; }
  assert.match(error?.message ?? '', /Injected publication failure/);
  assert(copies.length > 0);
  assert.equal(ctx.fields.history.owners, prior.owners);
  assert.deepEqual(wordsOf(ctx.fields), prior.words);
  assert.equal(ctx.fields.version, prior.version);
  assert.equal(ctx.fields.lastTick, prior.tick);
  assert.equal(ctx.fields.publishedToken, prior.token);
  assert.deepEqual([...ctx.fields.published], prior.published);
  assert.deepEqual(ctx.published, prior.snapshots);
  copies.length = 0; // Discard rather than submit the failed recording.
  error.retireWorldFieldUploads();
  ctx.gpu.frame.copy = copy; ctx.gpu.emulateEMA = true;
  ctx.fields.publisher.publish = publish;
  record(ctx, plan); // The SAME plan must remain valid.
  record(control, control.plan(tick, { changedBricks, full: true }));
  assert.deepEqual(wordsOf(ctx.fields), wordsOf(control.fields));
  ctx.fields.dispose(); control.fields.dispose();
}
const a = setup(), b = setup(true); await a.fields.ready; await b.fields.ready;
assert.deepEqual(a.gpu.kernels.map((k) => k.name), ['fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldPeak']);
const scratch = a.fields.scratch;
assert.equal(['ema', 'tmpA', 'tmpB', 'blurred'].reduce((n, key) => n + scratch[key].size, 0) + 64 ** 3 * 24 + scratch.age.size + scratch.dlist.size, 21_069_952);
const initial = a.plan(0); assert.equal(initial.jobs.length, 3); assert.equal(initial.advancing.length, 96);
const firstPublication = record(a, initial); assert(a.fields.isCurrent(firstPublication.token)); record(b, b.plan(0)); assert.deepEqual(wordsOf(a.fields), wordsOf(b.fields));
const ownerTrace = a.gpu.trace.filter((e) => e.name === 'emaOwners').flatMap((e) => e.owners);
assert.equal(new Set(ownerTrace).size, ownerTrace.length, 'halo duplicate EMA');
const firstSpatial = a.gpu.trace.findIndex((e) => e.name === 'fieldBlur');
assert(a.gpu.trace.slice(firstSpatial).every((e) => e.name !== 'fieldEma'), 'all-owner barrier before spatial');
assert(a.gpu.trace.slice(0, firstSpatial).filter((e) => e.name === 'copy' && e.src === a.fields.scratch.ema).length === ownerTrace.length * 3);
const saved = wordsOf(a.fields), published = JSON.stringify(a.published[0]);
a.gpu.trace.length = 0;
record(a, a.plan(0)); assert(!a.fields.isCurrent(firstPublication.token)); assert.equal(a.gpu.trace.filter((e) => e.name === 'fieldEma').length, 0); assert.deepEqual(wordsOf(a.fields), saved);
record(a, a.plan(0, { smoothing: 0.5, full: true })); assert.deepEqual(wordsOf(a.fields), saved);
// Physics-origin metadata is deliberately not a field parameter, even unsettled.
for (const physicsOrigin of [[1536, 0, 512], [1552, 0, 512]]) record(a, a.plan(0, { physicsOrigin, full: true }));
assert.deepEqual(wordsOf(a.fields), saved); assert.equal(JSON.stringify(a.published[0]), published, 'publication snapshots survive scratch reuse');
assert.throws(() => a.fields.record(a.gpu.frame, initial), /Stale/);
// Born settled: a load's owners skip a tick and advance nothing.
assert.equal(a.plan(2, { wantedCores: [] }).advancing.length, 0, 'a fresh owner is born settled');
// Copy-on-write transaction retries the SAME plan without advancing partial
// owner scatters twice. Freeze actual source revision per snapshot.
a.state.revision = b.state.revision = 1;
const retryPlan = a.plan(1, { changedBricks: [[8, 0, 0]], full: true });
a.state.failAt = a.state.gathers + 2;
let retryError; try { a.fields.record(a.gpu.frame, retryPlan); } catch (e) { retryError = e; }
assert.match(retryError.message, /Injected/); retryError.retireWorldFieldUploads();
assert.deepEqual(wordsOf(a.fields), saved, 'partial tick must not commit old history');
a.state.failAt = -1;
record(a, retryPlan); record(b, b.plan(1, { changedBricks: [[8, 0, 0]], full: true }));
assert.deepEqual(wordsOf(a.fields), wordsOf(b.fields), 'retry/reversed owner+job order changed packed history');
assert.notDeepEqual(wordsOf(a.fields), saved);
// A changed owner settles over the next ticks, and skipping one is refused.
assert.throws(() => a.plan(3), /Missing dynamic field ticks/);
assert.throws(() => { a.state.revision++; return a.plan(1); }, /Source changed within/); a.state.revision--;
// Invisible owners keep settling; no missed dynamic history catch-up.
for (let tick = 2; tick <= FIELD_EMA_SETTLE + 1; tick++) record(a, a.plan(tick, { wantedCores: [] }));
assert([...a.fields.history.owners.values()].every((o) => o.age === FIELD_EMA_SETTLE));
// Only the cores the settling owners reach (the change at brick [8,0,0] and
// its 4-cell halo): the one past them keeps its fields, which never changed.
assert.deepEqual([...a.fields.published], ['64,0,0'], 'unseen settling must invalidate previously published spatial fields');
record(a, a.plan(14, { full: true }));
const settled = a.plan(20, { wantedCores: [] }); assert.equal(settled.advancing.length, 0); record(a, settled);
const incremental = a.plan(21, { changedBricks: [[0, 0, 0]] });
assert(incremental.jobs.length > 0 && incremental.jobs.length < 3); assert(incremental.advancing.length > 0);
// Explicit aeration toggles invalidate settled targets globally, not just
// visible jobs. A same-tick toggle is rejected instead of double advancing.
const togglePlan = a.fields.plan({ fieldTick: 21, sourceSnapshot: { ...a.snapshot(), aerationActive: false }, wantedCores: [] });
assert.equal(togglePlan.advancing.length, a.fields.history.owners.size);
record(a, togglePlan);
assert.throws(() => a.plan(21), /Aeration changed within/);
// Restore a different explicit logical tick for the remaining stale tests.
record(a, a.plan(22, { wantedCores: [] }));
// Missing neighbors, malformed source invariants, epochs, stale revisions.
a.state.complete = false; assert.throws(() => a.plan(22), /Missing in-world source/); a.state.complete = true;
const incomplete = a.snapshot(); incomplete.jetValidity = 'unbounded';
assert.throws(() => a.fields.plan({ fieldTick: 22, sourceSnapshot: incomplete }), /unsupported/);
const stale = a.plan(22); a.state.revision++; assert.throws(() => a.fields.record(a.gpu.frame, stale), /Stale/); a.state.revision--;
const badAsync = { ...a.snapshot(), assertComplete: () => Promise.resolve() };
assert.throws(() => a.fields.plan({ fieldTick: 22, sourceSnapshot: badAsync }), /synchronous/);
const badFalse = { ...a.snapshot(), assertComplete: () => false };
assert.throws(() => a.fields.plan({ fieldTick: 22, sourceSnapshot: badFalse }), /Incomplete/);
const preReset = a.plan(22), oldBuffers = new Set(a.fields.history.slabs);
a.fields.reset(1); a.state.epoch = 1; assert.throws(() => a.fields.record(a.gpu.frame, preReset), /Stale/);
record(a, a.plan(0)); assert([...a.fields.history.owners.values()].every((o) => !oldBuffers.has(o.page.buffer)), 'old encoded epoch must not target reused current history');
// A reset inside a recording callback cannot commit or recycle old-epoch
// transaction pages into the new epoch (no async CPU/GPU race hidden by tests).
const resetting = setup(); await resetting.fields.ready;
const resetPlan = resetting.plan(0); let resetOnce = true;
const oldSink = resetting.fields.publisher.recordOwnedFields;
resetting.fields.publisher.recordOwnedFields = (...args) => {
  if (resetOnce) { resetOnce = false; resetting.fields.reset(1); resetting.state.epoch = 1; }
  return oldSink(...args);
};
let resetError; try { resetting.fields.record(resetting.gpu.frame, resetPlan); } catch (e) { resetError = e; }
assert.match(resetError.message, /epoch changed/); resetError.retireWorldFieldUploads();
assert.equal(resetting.fields.history.owners.size, 0); assert.equal(resetting.fields.history.free.length, 0);
record(resetting, resetting.plan(0)); resetting.fields.dispose();
// Height384 planning touches twelve layers and does not truncate Y into a key.
const tallGpu = new FieldTestGPU(), tall = new WorldFields(tallGpu, { worldBounds: { min: [0, 0, 0], max: [8, 384, 8] }, tables: {},
  publisher: { recordOwnedFields() {}, publish() {} } });
const tallSource = { epoch: 0, sourceRevision: 0, jetValidity: 'producer-bounded-v1', isCurrent: () => true, assertComplete() {}, recordGatherRaw() {} };
const tallPlan = tall.plan({ fieldTick: 0, sourceSnapshot: tallSource, wantedCores: Array.from({ length: 12 }, (_, y) => [0, y * 32, 0]) });
assert.equal(tallPlan.jobs.length, 12); assert(tallPlan.owners.has('0,95,0')); assert(tallPlan.owners.has('0,32,0')); assert(tallPlan.owners.has('0,64,0'));
const worldGpu = new FieldTestGPU(), world = new WorldFields(worldGpu, { worldBounds: { min: [1536, 0, 512], max: [1696, 384, 544] }, tables: {},
  publisher: { recordOwnedFields() {}, publish() {} } });
const worldPlan = world.plan({ fieldTick: 0, sourceSnapshot: tallSource, wantedCores: [[1600, 128, 512], [1664, 352, 512]] });
assert.equal(worldPlan.jobs.length, 2); assert(worldPlan.owners.has('400,32,128')); assert(worldPlan.owners.has('416,88,128'));
world.dispose();
assert.throws(() => new WorldFieldHistory(tallGpu, { pagesPerSlab: 200000 }), /Invalid/);
for (const ctx of [a, b]) ctx.fields.dispose(); tall.dispose();
console.log('PASS world control: actual factory/recording/native-copy paths; global owner barrier; 3 odd/reversed cores; sameTick/settling/retry/source/epoch/publication/origin invariants; sparse height384; no GPU occupancy');
