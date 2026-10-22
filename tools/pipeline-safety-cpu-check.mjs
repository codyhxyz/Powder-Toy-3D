// CPU only: real Gpu/PipelineCache with a fake WebGPU device and Node's clock.
// No browser, adapter discovery, shader compiler, or GPU process is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu } from '../src/gpu/device.js';
import { GraphicsFailure } from '../src/gpu/errors.js';
import { OptionalShaderFailure, PIPELINE_BUDGET_MS, PIPELINE_CONCURRENCY, PIPELINE_CONCURRENCY_MIN, PIPELINE_CONCURRENCY_MAX, pipelineConcurrency, BUILD_RANK, OUTSIDE_VIEW_SLOTS } from '../src/gpu/kernels.js';
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

function pipe(gpu, i, { kind = 'compute', build = 'now', name = `pipe-${i}`, optional, code = 'shared WGSL', first } = {}) {
  return gpu[kind === 'compute' ? 'kernel' : 'renderPipeline']({ name, code, constants: { i }, build, optional, first });
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
  // (the idle build waits behind the four foreground ones: it starts once none is queued)
  assert.equal(gpu.stats.pipelinesPending, 5);
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

await test('first failure cancels queued idle builds plus manual pipes', async (t) => {
  const f = await fixture(t);
  const pipes = Array.from({ length: 5 }, (_, i) => pipe(f.gpu, i, { build: 'idle' }));
  pipes.push(pipe(f.gpu, 6, { build: 'manual' }));
  await drain();
  assert.equal(f.calls.length, SLOTS, 'idle builds start at once in free slots, no idle callback');
  assert.equal(f.idle.size, 0);
  const failure = f.gpu.fail(new Error('startup aborted'));
  await Promise.all(pipes.map((p) => sameFailure(p.ready, failure)));
  for (const p of pipes) await sameFailure(p.build(), failure);
  f.runIdle(); await drain();
  assert.equal(f.calls.length, SLOTS, 'the queued idle builds never start');
  assert.equal(f.reports.length, 1);
  await f.gpu.settled();
  stopped(f);
});

await test('a queued idle build behind full slots never starts after a failure', async (t) => {
  const f = await fixture(t);
  delete globalThis.requestIdleCallback;
  const busy = Array.from({ length: SLOTS }, (_, i) => pipe(f.gpu, 50 + i));
  const p = pipe(f.gpu, 0, { build: 'idle' });
  await drain();
  assert.equal(f.calls.length, SLOTS);
  const failure = f.gpu.fail(new Error('abort before the idle build'));
  t.mock.timers.tick(0);
  await sameFailure(p.ready, failure);
  await Promise.all(busy.map((b) => sameFailure(b.ready, failure)));
  await drain();
  assert.equal(f.calls.length, SLOTS);
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

await test('optional idle failure frees its slot for the next idle build, and a manual build remains usable', async (t) => {
  const f = await fixture(t);
  const pipes = [0, 1, 2].map((i) => pipe(f.gpu, i, { optional: true, build: 'idle' }));
  const manual = pipe(f.gpu, 3, { build: 'manual' });
  await drain();
  assert.equal(f.calls.length, SLOTS);
  f.calls[0].reject(new Error('optional idle failed'));
  f.calls[1].resolve({});
  await drain();
  await assert.rejects(pipes[0].ready, OptionalShaderFailure);
  assert.equal(f.calls.length, 3, 'the next idle build started in the freed slot');
  assert.equal(f.idle.size, 0, 'with no idle callback');
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
  assert.equal(PIPELINE_CONCURRENCY_MAX, 4);
  for (const [cores, slots] of [[null, 2], [NaN, 2], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2], [7, 3], [8, 4], [10, 4], [64, 4]]) {
    assert.equal(pipelineConcurrency(cores), slots, `${cores} cores: ${slots} at once`);
  }
  assert.equal(PIPELINE_CONCURRENCY, pipelineConcurrency(globalThis.navigator?.hardwareConcurrency));
});

await test('at the scaled bound, foreground and idle builds share its slots, and a failure still stops all of them', async (t) => {
  const slots = PIPELINE_CONCURRENCY_MAX;
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

await test('a build made outside the cache (the World volume) counts against the bound while it compiles, never under the floor', async (t) => {
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MAX });
  const outsideBuild = deferred();
  assert.equal(f.gpu.pipelines.outside(outsideBuild.promise), outsideBuild.promise);
  const pipes = Array.from({ length: 6 }, (_, i) => pipe(f.gpu, 300 + i));
  await drain();
  assert.equal(f.calls.length, PIPELINE_CONCURRENCY_MAX - 1, 'one slot is the outside build\'s');
  outsideBuild.resolve({});
  await drain();
  assert.equal(f.calls.length, PIPELINE_CONCURRENCY_MAX, 'its slot returns when it settles');
  const many = Array.from({ length: 4 }, () => deferred());
  for (const d of many) f.gpu.pipelines.outside(d.promise);
  for (const c of f.calls) c.resolve({});
  await drain();
  assert.ok(f.counts.active >= PIPELINE_CONCURRENCY_MIN, 'outside builds never take the cache under the floor');
  for (const d of many) d.reject(new Error('outside failure is its owner\'s to report'));
  for (let i = 0; i < 4; i++) { for (const c of f.calls) c.resolve({}); await drain(); }
  await Promise.all(pipes.map((p) => p.ready));
  assert.equal(f.gpu.pipelines.outsideBuilds, 0);
  liveAndDrained(f);
});

// V2's boot (src/v2/physics.js, src/v2/dynamics.js): the long poles start first, the rest of what
// the first frame waits for next, and an idle build never ahead of either, whenever it arrived.
await test('queued builds start by rank: first, now, then idle ones; a demand moves a queued idle build up', async (t) => {
  const f = await fixture(t, { concurrency: SLOTS });
  const started = () => f.calls.map((c) => c.descriptor.label);
  const blockers = Array.from({ length: SLOTS }, (_, i) => pipe(f.gpu, 400 + i, { name: `busy-${i}` }));
  await drain();
  assert.deepEqual(started(), blockers.map((p) => p.name), 'the slots are full');
  // idle builds behind the full slots: the long pole (first) leads them, the rest in arrival order
  const idle = [...Array.from({ length: SLOTS }, (_, i) => pipe(f.gpu, 410 + i, { name: `idle-${i}`, build: 'idle' })),
    pipe(f.gpu, 418, { name: 'idle-late', build: 'idle' }), pipe(f.gpu, 419, { name: 'idle-react', build: 'idle', first: true })];
  const waiting = ['idle-react', ...idle.slice(0, SLOTS).map((p) => p.name), 'idle-late'];
  assert.deepEqual(f.gpu.pipelines.idleQueue.map((p) => p.name), waiting, 'a first idle build leads the idle queue');
  assert.equal(f.gpu.pipelines.queue.length, 0, 'no idle build queues a native build while every slot is busy');
  // then foreground builds, a long pole last of all: they start ahead of every idle build
  const now = [pipe(f.gpu, 420, { name: 'now-a' }), pipe(f.gpu, 421, { name: 'now-b' })];
  const pole = pipe(f.gpu, 422, { name: 'pole', first: true });
  assert.deepEqual(f.gpu.pipelines.queue.map((j) => [j.name, j.rank]), [['pole', BUILD_RANK.FIRST], ['now-a', BUILD_RANK.NOW], ['now-b', BUILD_RANK.NOW]]);
  // a demand for an idle build (a view drawn now that was prefetched) queues it now, at its rank
  idle[1].build();
  assert.deepEqual(f.gpu.pipelines.queue.map((j) => j.name), ['pole', 'now-a', 'now-b', 'idle-1']);
  idle[1].build(BUILD_RANK.BACKGROUND);
  assert.equal(f.gpu.pipelines.queue.find((j) => j.name === 'idle-1').rank, BUILD_RANK.NOW, 'never moved back down');
  const finishOne = async () => { f.calls.find((c) => !c.done && (c.done = true)).resolve({}); await drain(); };
  while (f.calls.length < SLOTS + 4) await finishOne();
  assert.deepEqual(started().slice(SLOTS, SLOTS + 4), ['pole', 'now-a', 'now-b', 'idle-1'], 'the waited-for builds first');
  while (f.calls.some((c) => !c.done) || f.gpu.pipelines.idleQueue.length) await finishOne();
  assert.deepEqual(started().slice(SLOTS + 4), waiting.filter((n) => n !== 'idle-1'), 'then the idle ones, the long pole first');
  await Promise.all([...blockers, ...idle, ...now, pole].map((p) => p.ready));
  assert.equal(f.gpu.pipelines.queued.size, 0);
});

// Every build settles whatever order demands, promotions, idle callbacks and completions come in:
// no queued job is lost or left behind its `ready` (seeded interleavings of the ranked queue).
await test('ranked queue: random demands, promotions, idle callbacks and completions settle every build', async (t) => {
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MAX });
  let seed = 0x2545f491;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const modes = ['now', 'idle', 'manual'], pipes = [];
  for (let round = 0; round < 400; round++) {
    const action = rnd(6);
    if (action <= 1 && pipes.length < 160) {
      // a new pipe, sometimes the same module and constants as an earlier one (a cache hit)
      const i = rnd(3) === 0 && pipes.length ? rnd(pipes.length) : 1000 + pipes.length;
      pipes.push(pipe(f.gpu, i, { name: `r${pipes.length}`, build: modes[rnd(3)], first: rnd(4) === 0, kind: rnd(2) ? 'compute' : 'render' }));
    } else if (action === 2 && pipes.length) pipes[rnd(pipes.length)].build(rnd(3));   // a demand at any rank
    else if (action === 3) f.runIdle();
    else if (action >= 4) {
      const open = f.calls.filter((c) => !c.done);
      if (open.length) { const c = open[rnd(open.length)]; c.done = true; c.resolve({}); }
    }
    await drain();
    assert.ok(f.counts.maxActive <= PIPELINE_CONCURRENCY_MAX);
  }
  // then everything asked for is built: demand each manual pipe, and drain
  for (const p of pipes) p.build();
  for (let i = 0; i < 2000 && (f.calls.some((c) => !c.done) || f.gpu.pipelines.queue.length || f.gpu.pipelines.idleQueue.length || f.gpu.pipelines.idleJobs.size); i++) {
    for (const c of f.calls) if (!c.done) { c.done = true; c.resolve({}); }
    await drain(); f.runIdle(); await drain();
  }
  const states = await Promise.all(pipes.map((p) => Promise.race([p.ready.then(() => 'ready'), new Promise((r) => setImmediate(() => r('pending')))])));
  assert.ok(pipes.length > 50 && f.calls.length > 30, `a real mix (${pipes.length} pipes, ${f.calls.length} native builds)`);
  assert.deepEqual(states.filter((s) => s !== 'ready'), [], 'every ready settled');
  assert.equal(f.gpu.pipelines.queue.length, 0); assert.equal(f.gpu.pipelines.queued.size, 0);
  assert.equal(f.gpu.pipelines.pending.size, 0); assert.equal(f.gpu.stats.pipelinesPending, 0);
});

// The deferred dynamics (src/v2/dynamics.js: 65+ idle builds) are ready in their compile time, not
// the page's idle time: a 60 fps frame loop leaves little, and one idle callback per few builds held
// them for up to ~18 s after the first frame (scratchpad model, 2026-10-22). Here the page never idles
// and no timer runs: every idle build must still start as slots free up.
await test('idle builds finish in their compile time with no idle time at all (a busy frame loop)', async (t) => {
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MAX });
  globalThis.requestIdleCallback = () => { throw new Error('an idle build waited for idle time'); };
  const now = Array.from({ length: 6 }, (_, i) => pipe(f.gpu, 500 + i, { name: `core-${i}` }));
  const idle = Array.from({ length: 65 }, (_, i) => pipe(f.gpu, 600 + i, { name: `dyn-${i}`, build: 'idle', first: i === 40 }));
  await drain();
  assert.deepEqual(f.calls.map((c) => c.descriptor.label), now.slice(0, PIPELINE_CONCURRENCY_MAX).map((p) => p.name), 'the first frame\'s builds hold the slots');
  // each compile completes in turn, no timer advanced, no idle callback
  let rounds = 0;
  while (f.calls.some((c) => !c.done)) {
    for (const c of f.calls) if (!c.done) { c.done = true; c.resolve({}); }
    await drain(); rounds++;
    assert.ok(f.counts.maxActive <= PIPELINE_CONCURRENCY_MAX);
  }
  await Promise.all([...now, ...idle].map((p) => p.ready));
  assert.ok(rounds <= Math.ceil((now.length + idle.length) / PIPELINE_CONCURRENCY_MAX) + 1, `bounded by compiles: ${rounds} rounds`);
  const order = f.calls.map((c) => c.descriptor.label);
  assert.ok(order.indexOf('dyn-40') < order.indexOf('dyn-0'), 'the long idle pole first');
  assert.ok(Math.max(...now.map((p) => order.indexOf(p.name))) < Math.min(...idle.map((p) => order.indexOf(p.name))), 'every first-frame build before any idle one');
});

// A big map's step kernels (v2/physics.js windowed: build 'later') queue behind every build asked for
// now, its World load's and first frame's, even those asked for after them (2026-10-22).
await test("'later' builds start at once but behind every 'now' build, and a 'now' request moves one up", async (t) => {
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MIN });
  const later = Array.from({ length: 3 }, (_, i) => pipe(f.gpu, 400 + i, { build: 'later', name: `step-${i}` }));
  const now = Array.from({ length: 3 }, (_, i) => pipe(f.gpu, 410 + i, { name: `first-${i}` }));
  await drain();
  assert.deepEqual(f.calls.map((c) => c.descriptor.label), ['step-0', 'step-1'], 'an idle cache starts them at once');
  for (const c of f.calls.splice(0)) c.resolve({});
  await drain();
  assert.deepEqual(f.calls.map((c) => c.descriptor.label), ['first-0', 'first-1'], 'then every now build before the last later one');
  // the same pipeline asked for now (a shared module): it moves up beside the now builds
  const shared = f.gpu.kernel({ name: 'step-2', code: 'shared WGSL', constants: { i: 402 } });
  for (const c of f.calls.splice(0)) c.resolve({});
  await drain();
  assert.deepEqual(f.calls.map((c) => c.descriptor.label).sort(), ['first-2', 'step-2']);
  for (const c of f.calls.splice(0)) c.resolve({});
  await Promise.all([...later, ...now, shared].map((p) => p.ready));
  liveAndDrained(f);
});

// A World window's V2 grid kernels (v2/physics.js: 'later', its long poles `first`): behind every now
// build, the long poles ahead of the other later ones.
await test("a 'later' long pole starts ahead of the other 'later' builds, still behind every 'now' one", async (t) => {
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MIN });
  const hold = Array.from({ length: PIPELINE_CONCURRENCY_MIN }, (_, i) => pipe(f.gpu, 600 + i, { name: `busy-${i}` }));
  await drain();
  const short = pipe(f.gpu, 610, { build: 'later', name: 'later-short' });
  const pole = pipe(f.gpu, 611, { build: 'later', first: true, name: 'later-pole' });
  const now = pipe(f.gpu, 612, { name: 'now-late' });
  assert.deepEqual(f.gpu.pipelines.queue.map((j) => [j.name, j.rank]), [['now-late', BUILD_RANK.NOW], ['later-pole', BUILD_RANK.LATER], ['later-short', BUILD_RANK.LATER]]);
  for (let i = 0; i < 3; i++) { for (const c of f.calls.splice(0)) c.resolve({}); await drain(); }
  await Promise.all([...hold, short, pole, now].map((p) => p.ready));
  liveAndDrained(f);
});

await test('a World view build takes OUTSIDE_VIEW_SLOTS of the bound while it compiles, never under the floor', async (t) => {
  assert.ok(Number.isInteger(OUTSIDE_VIEW_SLOTS) && OUTSIDE_VIEW_SLOTS >= 1);
  const f = await fixture(t, { concurrency: PIPELINE_CONCURRENCY_MAX });
  const view = deferred();
  f.gpu.pipelines.outside(view.promise, OUTSIDE_VIEW_SLOTS);
  const pipes = Array.from({ length: 6 }, (_, i) => pipe(f.gpu, 500 + i));
  await drain();
  assert.equal(f.calls.length, Math.max(PIPELINE_CONCURRENCY_MIN, PIPELINE_CONCURRENCY_MAX - OUTSIDE_VIEW_SLOTS));
  view.resolve({});
  await drain();
  assert.equal(f.calls.length, PIPELINE_CONCURRENCY_MAX, 'its slots return when it settles');
  for (let i = 0; i < 3; i++) { for (const c of f.calls) c.resolve({}); await drain(); }
  await Promise.all(pipes.map((p) => p.ready));
  assert.equal(f.gpu.pipelines.outsideBuilds, 0);
  liveAndDrained(f);
});
