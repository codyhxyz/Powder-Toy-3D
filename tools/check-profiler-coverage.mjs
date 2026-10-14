// No browser/GPU. Exercise the real timing hooks with independent encoder
// clients, not a hand-maintained list of the app's rendering passes.
import assert from 'node:assert/strict';
import { GpuTiming, MAX_TIMED_PASSES } from '../src/gpu/timing.js';
import { createProfiler } from '../src/gfx/profiler.js';

globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 };
globalThis.GPUMapMode = { READ: 1 };
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const realNow = performance.now;
function fixture(supported = true) {
  let clock = 1000000n, allocated = 0;
  // The synchronous mock advances CPU time with GPU work. A separate offset
  // reproduces a GPU-only clock discontinuity between query sets.
  performance.now = () => Number(clock) / 1e6;
  const state = { fail: false, hold: false, pending: [], timestampOffset: 0n, durationOffset: 0n };
  const device = {
    features: new Set(supported ? ['timestamp-query'] : []),
    createQuerySet({ count }) { allocated++; return { values: new BigUint64Array(count), destroy() {} }; },
    createBuffer({ size }) {
      allocated++;
      const data = new ArrayBuffer(size);
      return {
        data, destroy() {}, unmap() {},
        getMappedRange: (start, size) => data.slice(start, start + size),
        mapAsync() {
          if (state.fail) return Promise.reject(new Error('device/readback failure'));
          return state.hold ? new Promise(resolve => state.pending.push(resolve)) : Promise.resolve();
        },
      };
    },
    createCommandEncoder() {
      const ops = [];
      const begin = (d) => {
        ops.push(() => {
          const w = d.timestampWrites, start = clock;
          clock += BigInt(Math.round((d.ms ?? 1) * 1e6));
          if (w) {
            w.querySet.values[w.beginningOfPassWriteIndex] = start + state.timestampOffset;
            w.querySet.values[w.endOfPassWriteIndex] = clock + state.timestampOffset + state.durationOffset;
          }
        });
        return { end() {} };
      };
      return {
        beginRenderPass: begin, beginComputePass: begin,
        resolveQuerySet(q, first, count, dst, offset) { ops.push(() => new BigUint64Array(dst.data, offset, count).set(q.values.subarray(first, first + count))); },
        copyBufferToBuffer(src, a, dst, b, size) { ops.push(() => new Uint8Array(dst.data, b, size).set(new Uint8Array(src.data, a, size))); },
        finish() { return { ops }; },
      };
    },
  };
  const queue = { submit(buffers) { for (const b of buffers) for (const op of b.ops) op(); } };
  const gpu = {
    device, queue, frameNo: 0, adapterInfo: {}, memory: () => ({ bytes: 0 }),
    createBuffer: d => device.createBuffer(d),
  };
  gpu.timing = new GpuTiming(gpu);
  const pass = (enc, name, ms = 1, extra = {}) => enc.beginComputePass({ label: name, ms, ...extra }).end();
  return { gpu, state, pass, allocated: () => allocated };
}

{
  const { gpu, pass, allocated } = fixture(), t = gpu.timing;
  let e = gpu.device.createCommandEncoder(); pass(e, 'off');
  gpu.queue.submit([e.finish()]); t._endFrame(1); await drain();
  assert.equal(allocated(), 0, 'disabled profiler allocates no GPU resources');
  t.enabled = true;
  // Two clients record independently and submit in reverse recording order.
  const a = gpu.device.createCommandEncoder(), b = gpu.device.createCommandEncoder();
  pass(a, 'same', 3); pass(b, 'same', 1);
  b.beginRenderPass({ label: 'new renderer never registered with profiler', ms: 2 }).end();
  const first = a.finish(), second = b.finish();
  gpu.queue.submit([second]); gpu.queue.submit([first]); t._endFrame(2);
  await drain();
  assert.equal(t.frameMs, 6);
  assert.equal(t.last.same, 4);
  assert.deepEqual(t.lastPasses.map(p => [p.name, p.gpu, p.start]), [
    ['same', 1, 0], ['new renderer never registered with profiler', 2, 1], ['same', 3, 3],
  ]);
  assert.deepEqual([t.lastCoverage.observed, t.lastCoverage.timed, t.lastCoverage.complete], [3, 3, true]);
  t.enabled = false;
  assert.equal(t.frameMs, 6, 'stopping a capture keeps its completed results inspectable');
  t.enabled = true;
  e = gpu.device.createCommandEncoder(); e.beginRenderPass({}).end();
  gpu.queue.submit([e.finish()]); t._endFrame(3); await drain();
  assert.equal(t.lastCoverage.unlabelled, 1, 'unknown clients remain measured and visible');
}
{
  const { gpu, pass, state } = fixture(), t = gpu.timing;
  t.enabled = true;
  const a = gpu.device.createCommandEncoder(), b = gpu.device.createCommandEncoder();
  pass(a, 'before clock jump'); pass(b, 'after clock jump');
  gpu.queue.submit([a.finish()]);
  state.timestampOffset = 20000000000n;
  gpu.queue.submit([b.finish()]); t._endFrame(1); await drain();
  assert.equal(t.frameMs, 2, 'within-pass durations survive an inter-submission clock jump');
  assert.equal(t.lastCoverage.complete, true);
  assert.equal(t.lastCoverage.timelineComplete, false);
  assert.equal(t.lastCoverage.spanMs, null, 'never display an impossible GPU frame span');
  assert(t.lastPasses.every(p => p.start === null));
}
{
  const { gpu, pass, state } = fixture(), t = gpu.timing;
  t.enabled = true;
  const e = gpu.device.createCommandEncoder(); pass(e, 'impossible duration');
  state.durationOffset = 20000000000n;
  gpu.queue.submit([e.finish()]); t._endFrame(1); await drain();
  assert.equal(t.frameMs, null);
  assert.equal(t.lastCoverage.missing[0].error, 'timestamp duration exceeds capture wall time');
}
{
  const { gpu, pass } = fixture(), t = gpu.timing;
  t.enabled = true;
  const e = gpu.device.createCommandEncoder();
  for (let i = 0; i <= MAX_TIMED_PASSES; i++) pass(e, 'overflow');
  gpu.queue.submit([e.finish()]); t._endFrame(1); await drain();
  assert.equal(t.lastCoverage.observed, MAX_TIMED_PASSES + 1);
  assert.equal(t.lastCoverage.timed, MAX_TIMED_PASSES);
  assert.equal(t.lastCoverage.complete, false);
  assert.equal(t.frameMs, null, 'partial timings must never claim to be a frame total');
}
{
  const { gpu, state, pass } = fixture(), t = gpu.timing;
  t.enabled = true;
  let e = gpu.device.createCommandEncoder(); pass(e, 'failed map');
  state.fail = true; gpu.queue.submit([e.finish()]); t._endFrame(1); await drain();
  assert.equal(t.lastCoverage.missing[0].error, 'timestamp readback failed');
  assert.equal(t.frameMs, null);
  state.fail = false;
  const foreign = gpu.device.createQuerySet({ count: 2 });
  e = gpu.device.createCommandEncoder();
  pass(e, 'foreign', 1, { timestampWrites: { querySet: foreign, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
  gpu.queue.submit([e.finish()]); t._endFrame(2); await drain();
  assert.equal(t.lastCoverage.missing[0].error, 'foreign timestamp owner');
  assert.equal(t.frameMs, null);
}
{
  const { gpu, state, pass } = fixture(), t = gpu.timing;
  t.enabled = true;
  state.hold = true;
  let e = gpu.device.createCommandEncoder(); pass(e, 'old frame', 7);
  gpu.queue.submit([e.finish()]); t._endFrame(1);
  state.hold = false;
  e = gpu.device.createCommandEncoder(); pass(e, 'new frame', 2);
  gpu.queue.submit([e.finish()]); t._endFrame(2); await drain();
  assert.equal(t.lastFrame, 2);
  state.pending.splice(0).forEach(resolve => resolve()); await drain();
  assert.equal(t.lastFrame, 2, 'late readbacks cannot replace newer frames');
  state.hold = true;
  e = gpu.device.createCommandEncoder(); pass(e, 'previous capture');
  gpu.queue.submit([e.finish()]); t._endFrame(3);
  t.enabled = false; t.enabled = true;
  state.pending.splice(0).forEach(resolve => resolve()); await drain();
  assert.equal(t.lastFrame, -1, 'late readbacks cannot contaminate a new capture');
}
{
  const { gpu, pass } = fixture(), t = gpu.timing;
  t.enabled = true;
  const old = gpu.device.createCommandEncoder(); pass(old, 'previous capture');
  t.enabled = false; t.enabled = true;
  pass(old, 'new capture on old encoder', 8);
  const fresh = gpu.device.createCommandEncoder(); pass(fresh, 'fresh', 1);
  gpu.queue.submit([old.finish(), fresh.finish()]); t._endFrame(1); await drain();
  assert.equal(t.lastCoverage.observed, 2);
  assert.equal(t.lastCoverage.complete, false);
  assert.equal(t.frameMs, null, 'an encoder spanning capture toggles must not hide missing passes');
}
{
  const { gpu, pass } = fixture();
  let sample;
  const p = createProfiler(gpu, { describe: () => ({}), onSample: s => { if (s) sample = s; } });
  p.enable(true); p.beginFrame(0);
  const e = gpu.device.createCommandEncoder();
  p.phase('view'); pass(e, 'same', 2);
  p.phase('post'); pass(e, 'same', 6);
  gpu.queue.submit([e.finish()]); gpu.timing._endFrame(++gpu.frameNo);
  p.endFrame(4); await drain();
  p.beginFrame(1001); p.endFrame(0);
  assert.equal(sample.gpu, 8);
  assert.equal(sample.phases.find(p => p.id === 'view').gpu, 2);
  assert.equal(sample.phases.find(p => p.id === 'post').gpu, 6, 'same-name passes retain exact phase costs, not averaged costs');
  assert.equal(sample.passes.length, sample.coverage.observed);
  p.enable(false);
}
{
  const { gpu, pass, allocated } = fixture(false);
  gpu.timing.enabled = true;
  const e = gpu.device.createCommandEncoder(); pass(e, 'unsupported');
  gpu.queue.submit([e.finish()]); gpu.timing._endFrame(1); await drain();
  assert.equal(gpu.timing.enabled, false);
  assert.equal(allocated(), 0);
  assert.equal(gpu.timing.frameMs, null);
}
performance.now = realNow;
console.log('profiler coverage OK: automatic clients, submission order, repeated names, overflow, read failures, capture epochs, unsupported devices');
