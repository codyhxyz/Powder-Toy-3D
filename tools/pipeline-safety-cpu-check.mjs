// CPU only: real Gpu/PipelineCache with a fake WebGPU device and Node's clock.
// No browser, adapter discovery, shader compiler, or GPU process is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu } from '../src/gpu/device.js';
import { GraphicsFailure } from '../src/gpu/errors.js';
import { PIPELINE_BUDGET_MS, PIPELINE_CONCURRENCY } from '../src/gpu/kernels.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const sameFailure = (promise, failure) => assert.rejects(promise, (e) => e === failure);

async function fixture(t, { layout = 'ok', diagnosticsHang = false, moduleError = null, destroyThrows = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  const oldIdle = globalThis.requestIdleCallback, oldCancel = globalThis.cancelIdleCallback;
  const idle = new Map(), canceled = [];
  let nextIdle = 1;
  globalThis.requestIdleCallback = (fn) => { const id = nextIdle++; idle.set(id, fn); return id; };
  globalThis.cancelIdleCallback = (id) => { canceled.push(id); idle.delete(id); };
  const calls = [], scopes = [], layoutWaits = [], listeners = new Map(), lost = deferred();
  const counts = { modules: 0, layouts: 0, active: 0, maxActive: 0, destroy: 0, requests: 0, submits: 0, diagnostics: 0 };
  const compile = (kind, descriptor) => {
    const d = deferred();
    counts.active++;
    counts.maxActive = Math.max(counts.maxActive, counts.active);
    d.promise.then(() => counts.active--, () => counts.active--);
    calls.push({ ...d, kind, descriptor });
    return d.promise;
  };
  const device = {
    features: new Set(), limits: { maxStorageBufferBindingSize: 1 << 20, maxBufferSize: 1 << 20 },
    queue: { submit() { counts.submits++; }, writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
    lost: lost.promise,
    addEventListener: (name, fn) => listeners.set(name, fn),
    pushErrorScope() { scopes.push({ kind: 'unknown' }); },
    popErrorScope() {
      const scope = scopes.pop();
      assert.ok(scope, 'balanced error scopes');
      if (scope.kind === 'module') return Promise.resolve(moduleError);
      if (layout === 'hang') { const d = deferred(); layoutWaits.push(d); return d.promise; }
      if (layout === 'error') return Promise.resolve({ message: 'layout limit exceeded' });
      if (layout === 'reject') return Promise.reject(new Error('layout scope rejected'));
      return Promise.resolve(null);
    },
    createShaderModule({ code }) {
      counts.modules++;
      scopes.at(-1).kind = 'module';
      return { code, getCompilationInfo() {
        counts.diagnostics++;
        return diagnosticsHang ? new Promise(() => {}) : Promise.resolve({ messages: [
          { type: 'error', lineNum: 7, linePos: 3, message: 'fake compiler diagnostic' },
        ] });
      } };
    },
    createPipelineLayout(desc) { counts.layouts++; scopes.at(-1).kind = 'layout'; return { ...desc }; },
    createComputePipelineAsync: (d) => compile('compute', d),
    createRenderPipelineAsync: (d) => compile('render', d),
    createBindGroupLayout: (d) => ({ ...d }), createBindGroup: (d) => ({ ...d }),
    createBuffer: (d) => ({ ...d, destroy() {} }),
    createCommandEncoder: () => ({ beginComputePass() {}, beginRenderPass() {}, finish() {} }),
    destroy() {
      counts.destroy++;
      lost.resolve({ reason: 'destroyed', message: 'fake device destroyed' });
      if (destroyThrows) throw new Error('already gone');
    },
  };
  const adapter = { info: {}, features: device.features, limits: device.limits,
    async requestDevice() { counts.requests++; return device; } };
  const gpu = await createGpu({ adapter });
  const reports = [];
  gpu.onFailure((error) => reports.push(error));
  t.after(() => {
    gpu.destroy();
    t.mock.timers.reset();
    if (oldUsage === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = oldUsage;
    if (oldIdle === undefined) delete globalThis.requestIdleCallback; else globalThis.requestIdleCallback = oldIdle;
    if (oldCancel === undefined) delete globalThis.cancelIdleCallback; else globalThis.cancelIdleCallback = oldCancel;
  });
  return { gpu, device, counts, calls, scopes, layoutWaits, reports, idle, canceled, listeners, lost,
    runIdle() { const callbacks = [...idle.values()]; idle.clear(); for (const fn of callbacks) fn(); } };
}

function pipe(gpu, i, { kind = 'compute', build = 'now', name = `pipe-${i}` } = {}) {
  return gpu[kind === 'compute' ? 'kernel' : 'renderPipeline']({ name, code: 'shared WGSL', constants: { i }, build });
}

function stopped(f) {
  assert.equal(f.gpu.stats.pipelinesPending, 0);
  assert.equal(f.gpu.pipelines.pending.size, 0);
  assert.equal(f.gpu.pipelines.queue.length, 0);
  assert.equal(f.gpu.pipelines.running, 0);
  assert.equal(f.gpu.pipelines.active.size, 0);
  assert.equal(f.gpu.pipelines.idleJobs.size, 0);
  assert.equal(f.gpu.pipelines.idleQueue.length, 0);
  assert.equal(f.gpu.pipelines.pipes.size, 0);
  assert.equal(f.counts.destroy, 1);
  assert.equal(f.counts.requests, 1, 'no replacement device requested');
  assert.equal(f.scopes.length, 0);
}

await test('all now/manual/idle compute+render builds share two slots; pending and ready cache reuse', async (t) => {
  const f = await fixture(t);
  const { gpu } = f;
  const pipes = [pipe(gpu, 0), pipe(gpu, 1, { kind: 'render' }),
    pipe(gpu, 2, { build: 'manual' }), pipe(gpu, 3, { kind: 'render', build: 'idle' }),
    pipe(gpu, 4), pipe(gpu, 5, { kind: 'render' })];
  pipes[2].build();
  f.runIdle();
  const alias = pipe(gpu, 0, { name: 'alias' });
  const queuedAlias = pipe(gpu, 4, { name: 'queued-alias' });
  await drain();
  assert.equal(f.calls.length, PIPELINE_CONCURRENCY);
  assert.equal(gpu.stats.pipelinesPending, 6);
  assert.equal(f.counts.modules, 1);
  assert.equal(f.counts.layouts, 1);
  const firstPromise = gpu.pipelines.pipelines.values().next().value;
  const module = gpu.pipelines.modules.get('shared WGSL');
  assert.equal(gpu.pipelines.pipeline('compute', 'same', 'main|{"i":0}', pipes[0].groups, module, () => { throw new Error('cache miss'); }), firstPromise);
  let resolved = 0;
  while (resolved < 6) {
    const batch = f.calls.slice(resolved);
    assert.ok(batch.length > 0);
    for (const call of batch) {
      // Explicit layout ABI and compute/render descriptors survive queuing.
      assert.deepEqual(call.descriptor.layout.bindGroupLayouts, pipes[0].groups);
      call.resolve({ label: call.descriptor.label });
      resolved++;
    }
    await drain();
    assert.ok(f.counts.maxActive <= PIPELINE_CONCURRENCY);
  }
  await Promise.all(pipes.map((p) => p.ready));
  await alias.ready;
  await queuedAlias.ready;
  assert.equal(alias.pipeline, pipes[0].pipeline);
  assert.equal(queuedAlias.pipeline, pipes[4].pipeline);
  const readyAlias = pipe(gpu, 0, { name: 'ready-alias' });
  await readyAlias.ready;
  assert.equal(readyAlias.pipeline, pipes[0].pipeline);
  assert.equal(f.calls.length, 6);
  assert.equal(gpu.stats.pipelinesCreated, 6);
  assert.equal(gpu.stats.pipelinesPending, 0);
  assert.equal(gpu.pipelines.times.size, 6);
  assert.ok(pipes.every((p) => p.buildMs >= 0));
  assert.equal(alias.buildMs, null); // cache alias keeps the existing named-timing contract
  await gpu.settled();
  t.mock.timers.tick(PIPELINE_BUDGET_MS * 2);
  await drain();
  assert.equal(f.reports.length, 0);
  assert.equal(gpu.failure, null, 'successful builds cleared their deadline timers');
});

await test('queued time is free; each newly active compilation gets the unchanged 30000ms budget', async (t) => {
  const f = await fixture(t);
  const pipes = Array.from({ length: 5 }, (_, i) => pipe(f.gpu, i));
  await drain();
  assert.equal(PIPELINE_BUDGET_MS, 30000);
  t.mock.timers.tick(PIPELINE_BUDGET_MS - 1000);
  f.calls[0].resolve({}); f.calls[1].resolve({});
  await drain();
  assert.equal(f.calls.length, 4);
  t.mock.timers.tick(2000);
  await drain();
  assert.equal(f.gpu.failure, null, 'queue wait did not consume active budget');
  t.mock.timers.tick(PIPELINE_BUDGET_MS - 2000);
  await drain();
  const failure = f.gpu.failure;
  assert.equal(failure.name, 'GraphicsFailure');
  assert.match(failure.message, /pipe-2[\s\S]*30000 ms/);
  await Promise.all(pipes.slice(2).map((p) => sameFailure(p.ready, failure)));
  assert.equal(f.calls.length, 4, 'timeout never starts the remaining queued job');
  assert.equal(f.gpu.stats.pipelinesCreated, 2);
  assert.equal(f.gpu.pipelines.pipelines.size, 2);
  assert.equal(f.reports.length, 1);
  stopped(f);
});

for (const late of ['resolve', 'reject']) {
  await test(`unresolved native compilation times out once; late ${late} cannot resurrect work`, async (t) => {
    const f = await fixture(t);
    const pipes = Array.from({ length: 5 }, (_, i) => pipe(f.gpu, i, { kind: i % 2 ? 'render' : 'compute' }));
    await drain();
    t.mock.timers.tick(PIPELINE_BUDGET_MS - 1);
    assert.equal(f.gpu.failure, null);
    t.mock.timers.tick(1);
    await drain();
    const failure = f.gpu.failure;
    assert.match(failure.message, /pipe-0[\s\S]*compilation exceeded/);
    await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
    for (const call of f.calls) call[late](late === 'resolve' ? {} : new Error('late rejection'));
    await drain();
    t.mock.timers.tick(PIPELINE_BUDGET_MS * 2);
    await drain();
    assert.ok(pipes.every((p) => p.state === 'failed' && p.pipeline === null));
    assert.equal(f.gpu.stats.pipelinesCreated, 0);
    assert.equal(f.gpu.pipelines.pipelines.size, 0);
    assert.equal(f.gpu.pipelines.times.size, 0);
    assert.equal(f.calls.length, 2);
    assert.equal(f.reports.length, 1);
    assert.equal(f.gpu.fail(new Error('second failure')), failure);
    assert.throws(() => f.gpu.pipelines.module('new WGSL', 'later'), (e) => e === failure);
    await sameFailure(f.gpu.pipelines.pipeline('compute', 'later', '', [], {}, () => ({})), failure);
    assert.throws(() => f.gpu.kernel({ name: 'later', code: '' }), (e) => e === failure);
    assert.throws(() => f.device.queue.submit([]), (e) => e === failure);
    assert.equal(f.counts.submits, 0);
    await f.gpu.settled();
    stopped(f);
  });
}

await test('layout error-scope hang is within the active deadline; late scope response cannot compile', async (t) => {
  const f = await fixture(t, { layout: 'hang' });
  const pipes = [pipe(f.gpu, 0), pipe(f.gpu, 1), pipe(f.gpu, 2)];
  await drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.layoutWaits.length, 1);
  t.mock.timers.tick(PIPELINE_BUDGET_MS);
  await drain();
  const failure = f.gpu.failure;
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  f.layoutWaits[0].resolve(null);
  await drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.length, 1);
  stopped(f);
});

for (const layout of ['error', 'reject']) {
  await test(`layout scope ${layout} rejects all waiters promptly`, async (t) => {
    const f = await fixture(t, { layout });
    const pipes = [pipe(f.gpu, 0), pipe(f.gpu, 1), pipe(f.gpu, 2)];
    await drain();
    const failure = f.gpu.failure;
    assert.equal(failure.name, 'GraphicsFailure');
    assert.match(failure.message, /pipe-0/);
    await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
    assert.equal(f.calls.length, 0);
    assert.equal(f.reports.length, 1);
    stopped(f);
  });
}

await test('ordinary compiler rejection latches immediately even when diagnostic retrieval hangs', async (t) => {
  const f = await fixture(t, { diagnosticsHang: true });
  const pipes = [pipe(f.gpu, 0), pipe(f.gpu, 1), pipe(f.gpu, 2)];
  await drain();
  f.calls[0].reject(new Error('driver rejected pipeline'));
  await drain();
  const failure = f.gpu.failure;
  assert.equal(failure.name, 'GraphicsFailure');
  assert.match(failure.message, /pipe-0[\s\S]*driver rejected pipeline/);
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  f.calls[1].reject(new Error('second driver rejection'));
  await drain();
  assert.equal(f.counts.diagnostics, 1);
  assert.equal(f.reports.length, 1);
  assert.equal(f.gpu.failure, failure);
  stopped(f);
});

await test('module scope validation failure stops all builds and preserves compiler diagnostics', async (t) => {
  const f = await fixture(t, { moduleError: new Error('invalid WGSL') });
  const pipes = [pipe(f.gpu, 0), pipe(f.gpu, 1)];
  await drain();
  const failure = f.gpu.failure;
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  assert.match(failure.message, /7:3 fake compiler diagnostic/);
  assert.equal(f.counts.diagnostics, 1);
  assert.equal(f.calls.length, 0);
  stopped(f);
});

await test('first failure cancels queued and already scheduled idle callbacks plus manual pipes', async (t) => {
  const f = await fixture(t);
  const pipes = Array.from({ length: 5 }, (_, i) => pipe(f.gpu, i, { build: 'idle' }));
  pipes.push(pipe(f.gpu, 6, { build: 'manual' }));
  assert.equal(f.idle.size, 2);
  const staleCallbacks = [...f.idle.values()];
  const failure = f.gpu.fail(new Error('startup aborted'));
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  assert.equal(f.canceled.length, 2);
  assert.equal(f.idle.size, 0);
  for (const fn of staleCallbacks) fn(); // cancellation racing a dispatched callback
  for (const p of pipes) await sameFailure(p.build(), failure);
  await drain();
  assert.equal(f.counts.modules, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.length, 1);
  await f.gpu.settled();
  stopped(f);
});

await test('setTimeout idle fallback is canceled on failure too', async (t) => {
  const f = await fixture(t);
  delete globalThis.requestIdleCallback;
  const p = pipe(f.gpu, 0, { build: 'idle' });
  const failure = f.gpu.fail(new Error('abort before idle timer'));
  t.mock.timers.tick(0);
  await sameFailure(p.ready, failure);
  await drain();
  assert.equal(f.counts.modules, 0);
  stopped(f);
});

await test('destroy drains active/queued/idle/manual work silently and is idempotent', async (t) => {
  const f = await fixture(t, { destroyThrows: true });
  const pipes = [pipe(f.gpu, 0), pipe(f.gpu, 1), pipe(f.gpu, 2),
    pipe(f.gpu, 3, { build: 'idle' }), pipe(f.gpu, 4, { build: 'manual' })];
  await drain();
  f.gpu.destroy(); f.gpu.destroy();
  const failure = f.gpu.pipelines.failure;
  assert.equal(failure.name, 'GraphicsFailure');
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  f.listeners.get('uncapturederror')({ error: new Error('late validation') });
  f.calls[0].resolve({}); f.calls[1].reject(new Error('late error'));
  t.mock.timers.tick(PIPELINE_BUDGET_MS * 2);
  await drain();
  assert.equal(f.gpu.fail(new Error('late failure')), failure);
  assert.equal(f.gpu.failure, null, 'explicit cleanup does not report failure');
  assert.equal(f.reports.length, 0);
  assert.throws(() => f.gpu.frame, (e) => e === failure);
  assert.throws(() => f.device.queue.submit([]), (e) => e === failure);
  assert.equal(f.gpu.stats.pipelinesCreated, 0);
  await f.gpu.settled();
  stopped(f);
});

await test('device loss and uncaptured errors preserve the first failure without automatic recovery', async (t) => {
  const f = await fixture(t);
  const p = pipe(f.gpu, 0);
  await drain();
  f.lost.resolve({ reason: 'unknown', message: 'fake device lost' });
  await drain();
  const failure = f.gpu.failure;
  assert.match(failure.message, /fake device lost/);
  await sameFailure(p.ready, failure);
  f.listeners.get('uncapturederror')({ error: new Error('second failure') });
  f.gpu.destroy();
  assert.equal(f.gpu.fail(new GraphicsFailure('third failure')), failure);
  assert.equal(f.reports.length, 1);
  stopped(f);
});
