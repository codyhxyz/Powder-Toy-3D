// CPU only: real Gpu/PipelineCache with a fake WebGPU device and Node's clock.
// No browser, adapter discovery, shader compiler, or GPU process is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu } from '../src/gpu/device.js';
import { GraphicsFailure } from '../src/gpu/errors.js';
import { OptionalShaderFailure, PIPELINE_BUDGET_MS, PIPELINE_CONCURRENCY, PIPELINE_CONCURRENCY_MIN, PIPELINE_CONCURRENCY_MAX, pipelineConcurrency } from '../src/gpu/kernels.js';
// The fixtures below count slots as a weak machine has them (pipelineConcurrency's floor); the
// scaled bound has its own tests at the end.
const SLOTS = PIPELINE_CONCURRENCY_MIN;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const sameFailure = (promise, failure) => assert.rejects(promise, (e) => e === failure);

async function fixture(t, { layout = 'ok', diagnosticsHang = false, moduleError = null, moduleHang = false, destroyThrows = false, concurrency = SLOTS } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  const oldIdle = globalThis.requestIdleCallback, oldCancel = globalThis.cancelIdleCallback;
  const idle = new Map(), canceled = [];
  let nextIdle = 1;
  globalThis.requestIdleCallback = (fn) => { const id = nextIdle++; idle.set(id, fn); return id; };
  globalThis.cancelIdleCallback = (id) => { canceled.push(id); idle.delete(id); };
  const calls = [], scopes = [], layoutWaits = [], moduleWaits = [], listeners = new Map(), lost = deferred();
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
      if (scope.kind === 'module') {
        if (moduleHang) { const d = deferred(); moduleWaits.push(d); return d.promise; }
        return Promise.resolve(typeof moduleError === 'function' ? moduleError(scope.label) : moduleError);
      }
      const mode = typeof layout === 'function' ? layout(scope.label) : layout;
      if (mode === 'hang') { const d = deferred(); layoutWaits.push(d); return d.promise; }
      if (mode === 'error') return Promise.resolve({ message: 'layout limit exceeded' });
      if (mode === 'reject') return Promise.reject(new Error('layout scope rejected'));
      return Promise.resolve(null);
    },
    createShaderModule({ code, label }) {
      counts.modules++;
      Object.assign(scopes.at(-1), { kind: 'module', label });
      return { code, getCompilationInfo() {
        counts.diagnostics++;
        return diagnosticsHang ? new Promise(() => {}) : Promise.resolve({ messages: [
          { type: 'error', lineNum: 7, linePos: 3, message: 'fake compiler diagnostic' },
        ] });
      } };
    },
    createPipelineLayout(desc) { counts.layouts++; Object.assign(scopes.at(-1), { kind: 'layout', label: desc.label }); return { ...desc }; },
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
  gpu.pipelines.concurrency = concurrency;
  const reports = [];
  gpu.onFailure((error) => reports.push(error));
  t.after(() => {
    gpu.destroy();
    t.mock.timers.reset();
    if (oldUsage === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = oldUsage;
    if (oldIdle === undefined) delete globalThis.requestIdleCallback; else globalThis.requestIdleCallback = oldIdle;
    if (oldCancel === undefined) delete globalThis.cancelIdleCallback; else globalThis.cancelIdleCallback = oldCancel;
  });
  return { gpu, device, counts, calls, scopes, layoutWaits, moduleWaits, reports, idle, canceled, listeners, lost,
    runIdle() { const callbacks = [...idle.values()]; idle.clear(); for (const fn of callbacks) fn(); } };
}

function pipe(gpu, i, { kind = 'compute', build = 'now', name = `pipe-${i}`, optional, code = 'shared WGSL' } = {}) {
  return gpu[kind === 'compute' ? 'kernel' : 'renderPipeline']({ name, code, constants: { i }, build, optional });
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
  assert.equal(f.calls.length, SLOTS);
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
    assert.ok(f.counts.maxActive <= SLOTS);
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
    let activeDrained=false,queuedDrained=false;
    const activeFence=Promise.all(pipes.slice(0,2).map(p=>p.compilationSettled)).then(()=>{activeDrained=true;});
    await Promise.all(pipes.slice(2).map(p=>p.compilationSettled)).then(()=>{queuedDrained=true;});
    assert(queuedDrained,'canceled queued pipelines have no native use');assert.equal(activeDrained,false);
    for (const call of f.calls) call[late](late === 'resolve' ? {} : new Error('late rejection'));
    await drain();
    await activeFence;assert(activeDrained,'native settlement, not public timeout, closes the fence');
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


function liveAndDrained(f) {
  assert.equal(f.gpu.failure, null);
  assert.equal(f.gpu.pipelines.failure, null);
  assert.equal(f.counts.destroy, 0);
  assert.equal(f.counts.requests, 1);
  assert.equal(f.reports.length, 0);
  assert.equal(f.gpu.stats.pipelinesPending, 0);
  assert.equal(f.gpu.pipelines.pending.size, 0);
  assert.equal(f.gpu.pipelines.running, 0);
  assert.equal(f.gpu.pipelines.active.size, 0);
  assert.equal(f.gpu.pipelines.queue.length, 0);
  assert.equal(f.gpu.pipelines.pipes.size, 0);
  assert.equal(f.scopes.length, 0);
  f.device.queue.submit([]);
  assert.ok(f.gpu.frame, 'shared device remains usable');
}

for (const kind of ['render', 'compute']) {
  await test(`optional ${kind} native rejection drains and pumps unrelated core builds`, async (t) => {
    const f = await fixture(t, { diagnosticsHang: true });
    const optional = pipe(f.gpu, 0, { optional: true, kind });
    const alias = pipe(f.gpu, 0, { optional: true, kind, name: 'optional alias' });
    const core = [pipe(f.gpu, 1), pipe(f.gpu, 2), pipe(f.gpu, 3)];
    await drain();
    const error = new Error('Metal XPC_ERROR_CONNECTION_INTERRUPTED after retries');
    f.calls[0].reject(error);
    await drain();
    let failure;
    await assert.rejects(optional.ready, (e) => {
      failure = e;
      return e instanceof OptionalShaderFailure && e.cause === error && /pipe-0.*\nMetal/.test(e.message);
    });
    await sameFailure(alias.ready, failure);
    assert.equal(f.calls.length, 3, 'optional failure releases only its settled slot');
    f.calls[1].resolve({}); f.calls[2].resolve({});
    await drain();
    f.calls[3].resolve({});
    await Promise.all(core.map((p) => p.ready));
    await f.gpu.settled();
    assert.equal(optional.pipeline, null);
    assert.equal(optional.state, 'failed');
    assert.equal(f.gpu.stats.pipelinesCreated, 3);
    assert.equal(f.counts.maxActive, SLOTS);
    liveAndDrained(f);
  });
}

await test('optional diagnostics enrich asynchronously without changing original cause', async (t) => {
  const f = await fixture(t);
  const info = deferred();
  const module = f.gpu.pipelines.module('shared WGSL', 'optional module', true);
  module.getCompilationInfo = () => info.promise;
  const p = pipe(f.gpu, 0, { optional: true });
  await drain();
  const cause = new Error('native failed');
  f.calls[0].reject(cause);
  await drain();
  let failure;
  await assert.rejects(p.ready, (e) => { failure = e; return e instanceof OptionalShaderFailure; });
  assert.match(failure.message, /native failed/);
  info.resolve({ messages: [{ type: 'error', lineNum: 4, linePos: 2, message: 'later diagnostic' }] });
  await drain();
  assert.match(failure.message, /4:2 later diagnostic/);
  assert.equal(failure.cause, cause);
  liveAndDrained(f);
});

for (const stage of ['module', 'layout']) {
  for (const mode of ['throw', 'error', 'reject']) {
    await test(`optional ${stage} ${mode} is isolated and preserves the cause`, async (t) => {
      const cause = new Error(`${stage} ${mode}`);
      const f = await fixture(t, stage === 'module' && mode !== 'throw'
        ? { moduleError: (label) => label === 'pipe-0' ? (mode === 'reject' ? Promise.reject(cause) : cause) : null }
        : {});
      if (mode === 'throw') {
        const api = stage === 'module' ? 'createShaderModule' : 'createPipelineLayout';
        const original = f.device[api];
        f.device[api] = (d) => {
          if (d.label.startsWith('pipe-0')) {
            // A throwing mock still belongs to its pushed validation scope.
            f.scopes.at(-1).kind = stage;
            throw cause;
          }
          return original(d);
        };
      } else if (stage === 'layout') {
        const original = f.device.popErrorScope;
        f.device.popErrorScope = () => {
          if (f.scopes.at(-1).label === 'pipe-0 layout') {
            f.scopes.pop();
            return mode === 'reject' ? Promise.reject(cause) : Promise.resolve(cause);
          }
          return original();
        };
      }
      const p = pipe(f.gpu, 0, { optional: true });
      const core = pipe(f.gpu, 1);
      await drain();
      await assert.rejects(p.ready, (e) => e instanceof OptionalShaderFailure && e.cause === cause);
      assert.equal(f.calls.length, 1, 'failed optional validation never enters native compilation');
      f.calls[0].resolve({});
      await core.ready;
      liveAndDrained(f);
    });
  }
}

for (const optionalFirst of [true, false]) {
  await test(`identical source/layout/pipeline keeps fatal and optional policy separate (optional first: ${optionalFirst})`, async (t) => {
    const f = await fixture(t);
    const first = pipe(f.gpu, 0, { optional: optionalFirst });
    const second = pipe(f.gpu, 0, { optional: !optionalFirst });
    await drain();
    assert.equal(f.calls.length, 2);
    assert.equal(f.counts.modules, 2);
    assert.equal(f.counts.layouts, 2);
    const a = f.calls[0].descriptor, b = f.calls[1].descriptor;
    assert.notEqual(a.compute.module, b.compute.module);
    assert.notEqual(a.layout, b.layout);
    const optional = optionalFirst ? first : second, core = optionalFirst ? second : first;
    f.calls[optionalFirst ? 0 : 1].reject(new Error('optional rejection'));
    await assert.rejects(optional.ready, OptionalShaderFailure);
    assert.equal(f.gpu.failure, null);
    f.calls[optionalFirst ? 1 : 0].reject(new Error('core rejection'));
    await drain();
    await sameFailure(core.ready, f.gpu.failure);
    assert.ok(f.gpu.failure instanceof GraphicsFailure);
    stopped(f);
  });
}

for (const outcome of ['resolve', 'error', 'reject']) {
  await test(`module validation gates apparent ready and native creation until ${outcome}`, async (t) => {
    const f = await fixture(t, { moduleHang: true });
    const p = pipe(f.gpu, 0, { optional: true });
    await drain();
    assert.equal(f.calls.length, 0);
    assert.equal(p.state, 'pending');
    assert.equal(f.counts.layouts, 0);
    const cause = new Error('late module failure');
    f.moduleWaits[0][outcome === 'reject' ? 'reject' : 'resolve'](outcome === 'resolve' ? null : cause);
    await drain();
    if (outcome === 'resolve') {
      assert.equal(f.calls.length, 1);
      f.calls[0].resolve({});
      await p.ready;
    } else {
      await assert.rejects(p.ready, (e) => e instanceof OptionalShaderFailure && e.cause === cause);
      assert.equal(f.calls.length, 0);
      assert.equal(p.state, 'failed');
    }
    liveAndDrained(f);
  });
}

for (const stage of ['native', 'module', 'layout']) {
  await test(`optional ${stage} timeout remains fatal; late resolve cannot resurrect failed pipe`, async (t) => {
    const f = await fixture(t, { moduleHang: stage === 'module', layout: stage === 'layout' ? 'hang' : 'ok' });
    const pipes = [0, 1, 2].map((i) => pipe(f.gpu, i, { optional: true }));
    await drain();
    t.mock.timers.tick(PIPELINE_BUDGET_MS);
    await drain();
    const failure = f.gpu.failure;
    assert.ok(failure instanceof GraphicsFailure);
    await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
    for (const wait of [...f.calls, ...f.moduleWaits, ...f.layoutWaits]) wait.resolve(null);
    await drain();
    assert.equal(f.calls.length, stage === 'native' ? 2 : 0);
    assert.ok(pipes.every((p) => p.state === 'failed' && p.pipeline === null));
    assert.equal(f.gpu.stats.pipelinesCreated, 0);
    stopped(f);
  });
}

for (const event of ['loss', 'uncaptured']) {
  await test(`optional active and queued builds cannot absorb device ${event}`, async (t) => {
    const f = await fixture(t);
    const pipes = [0, 1, 2, 3].map((i) => pipe(f.gpu, i, { optional: true }));
    await drain();
    if (event === 'loss') f.lost.resolve({ reason: 'unknown', message: 'device lost during optional build' });
    else f.listeners.get('uncapturederror')({ error: new Error('uncaptured optional error') });
    await drain();
    const failure = f.gpu.failure;
    assert.ok(failure instanceof GraphicsFailure);
    await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
    f.calls[0].resolve({}); f.calls[1].reject(new Error('late optional rejection'));
    await drain();
    assert.equal(f.calls.length, 2, 'fatal device state prevents more native jobs');
    assert.equal(f.gpu.stats.pipelinesCreated, 0);
    assert.ok(pipes.every((p) => p.state === 'failed' && p.pipeline === null));
    stopped(f);
  });
}

await test('optional policy requires an explicit boolean', async (t) => {
  const f = await fixture(t);
  for (const optional of ['true', 1, null, {}]) {
    assert.throws(() => pipe(f.gpu, 0, { optional }), /optional must be a boolean/);
  }
  liveAndDrained(f);
});

for (const kind of ['render', 'compute']) {
  await test(`optional ${kind} synchronous native API throw remains local`, async (t) => {
    const f = await fixture(t);
    const cause = new Error('native API threw');
    const api = kind === 'compute' ? 'createComputePipelineAsync' : 'createRenderPipelineAsync';
    f.device[api] = () => { throw cause; };
    const p = pipe(f.gpu, 0, { optional: true, kind });
    await assert.rejects(p.ready, (e) => e instanceof OptionalShaderFailure && e.cause === cause);
    liveAndDrained(f);
  });
}

await test('optional idle failure releases idle scheduling and manual build remains usable', async (t) => {
  const f = await fixture(t);
  const pipes = [0, 1, 2].map((i) => pipe(f.gpu, i, { optional: true, build: 'idle' }));
  const manual = pipe(f.gpu, 3, { build: 'manual' });
  f.runIdle();
  await drain();
  f.calls[0].reject(new Error('optional idle failed'));
  f.calls[1].resolve({});
  await drain();
  await assert.rejects(pipes[0].ready, OptionalShaderFailure);
  assert.equal(f.idle.size, 1, 'next idle build scheduled after local rejection');
  f.runIdle();
  manual.build();
  await drain();
  for (const call of f.calls.slice(2)) call.resolve({});
  await Promise.all([pipes[1].ready, pipes[2].ready, manual.ready]);
  await f.gpu.settled();
  assert.equal(f.gpu.pipelines.idleJobs.size, 0);
  assert.equal(f.gpu.pipelines.idleQueue.length, 0);
  liveAndDrained(f);
});

await test('optional descriptor/programmer errors are not optional shader failures', async (t) => {
  const f = await fixture(t);
  const p = pipe(f.gpu, 0, { optional: true, build: 'manual' });
  const cause = new Error('descriptor failed before native API');
  p.descriptor = () => { throw cause; };
  p.build();
  await drain();
  await sameFailure(p.ready, f.gpu.failure);
  assert.ok(f.gpu.failure instanceof GraphicsFailure);
  assert.equal(f.gpu.failure.cause, cause);
  assert.equal(f.calls.length, 0);
  stopped(f);
});

for (const stage of ['module', 'layout', 'native']) {
  await test(`a deliberate optional retry can recover from a transient ${stage} failure`, async (t) => {
    let failing = true;
    const f = await fixture(t, {
      moduleError: () => stage === 'module' && failing ? { message: 'transient module error' } : null,
      layout: () => stage === 'layout' && failing ? 'error' : 'ok',
    });
    const first = pipe(f.gpu, 700, { optional: true });
    await drain();
    if (stage === 'native') f.calls[0].reject(new Error('XPC_ERROR_CONNECTION_INTERRUPTED'));
    await assert.rejects(first.ready, OptionalShaderFailure);
    await drain();
    liveAndDrained(f);
    failing = false;
    const retry = pipe(f.gpu, 700, { optional: true });
    await drain();
    f.calls.at(-1).resolve({});
    await retry.ready;
    const modules = f.counts.modules, layouts = f.counts.layouts, calls = f.calls.length;
    await pipe(f.gpu, 700, { optional: true }).ready;
    assert.equal(f.counts.modules, modules, 'successful modules remain cached');
    assert.equal(f.counts.layouts, layouts, 'successful layouts remain cached');
    assert.equal(f.calls.length, calls, 'successful retry pipeline remains cached');
    assert.equal(modules, stage === 'module' ? 2 : 1);
    assert.equal(layouts, stage === 'layout' ? 2 : 1);
    liveAndDrained(f);
  });
}

// The scaled bound (user request, 2026-10-20: "MAKE IT LOAD FAST"): from the CPU's cores, never
// under two, never over the cap, and every guarantee above holds at it.
await test('pipeline concurrency scales with the cores: a floor of two, a cap, the machine\'s own', () => {
  assert.equal(PIPELINE_CONCURRENCY_MIN, 2);
  for (const [cores, slots] of [[null, 2], [NaN, 2], [0, 2], [1, 2], [4, 2], [6, 2], [8, 4], [10, 6], [12, 8], [64, PIPELINE_CONCURRENCY_MAX]]) {
    assert.equal(pipelineConcurrency(cores), slots, `${cores} cores: ${slots} at once`);
  }
  assert.equal(PIPELINE_CONCURRENCY, pipelineConcurrency(globalThis.navigator?.hardwareConcurrency));
});

await test('at a scaled bound, foreground and idle builds share its slots, and a failure still stops all of them', async (t) => {
  const slots = 6;
  const f = await fixture(t, { concurrency: slots });
  const now = Array.from({ length: 8 }, (_, i) => pipe(f.gpu, i, { kind: i % 2 ? 'render' : 'compute' }));
  const idle = Array.from({ length: 8 }, (_, i) => pipe(f.gpu, 100 + i, { build: 'idle' }));
  f.runIdle();
  await drain();
  assert.equal(f.calls.length, slots, 'exactly the bound start at once');
  assert.ok(f.gpu.pipelines.idleJobs.size <= slots, 'idle jobs in flight stay within the bound');
  for (let done = 0; done < 10; done++) {
    f.calls[done].resolve({});
    await drain();
    f.runIdle();
    await drain();
    assert.ok(f.counts.maxActive <= slots);
  }
  await Promise.all(now.map((p) => p.ready));
  // each active build keeps its own unchanged budget at the higher bound
  t.mock.timers.tick(PIPELINE_BUDGET_MS);
  await drain();
  const failure = f.gpu.failure;
  assert.equal(failure?.name, 'GraphicsFailure');
  assert.match(failure.message, /30000 ms/);
  const started = f.calls.length;
  await Promise.all(idle.map((p) => p.ready.catch(() => {})));
  t.mock.timers.tick(PIPELINE_BUDGET_MS);
  f.runIdle();
  await drain();
  assert.equal(f.calls.length, started, 'a failure starts nothing more, at any bound');
  assert.equal(f.reports.length, 1, 'one failure, surfaced once');
  stopped(f);
});
