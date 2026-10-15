// Full original six-pass glow on a bounded construction core, no app switch.
import { worldGlow, worldGlowLayouts, WORLD_GLOW_AXES, WORLD_GLOW_SUPPORT } from '../shaders/worldGlow.js';
import { BU, TU, uint, frozenArray, worldLightingIndex, validateLightingInput, sameLightingProvenance, createLightingResources, completeLightingBatch, createLightingTransport } from './worldLightingBatch.js';
const product = a => a.reduce((n, v) => n * v, 1);
const region = (min, max) => Object.freeze({ min: frozenArray(min), size: frozenArray(max.map((n, k) => n - min[k])), max: frozenArray(max) });
export function worldGlowPlan(worldSize, core) {
  if (!Array.isArray(core) || core.length !== 3 || core.some((n, k) => !Number.isInteger(n) || n < 0 || n * 32 >= worldSize[k]) || worldSize.some(n => !Number.isInteger(n) || n <= 0 || n % 4)) throw new RangeError('world glow construction core');
  const dims = worldSize.map(n => n / 4), lo = core.map(n => n * 8), hi = lo.map((n, k) => Math.min(n + 8, dims[k]));
  const remaining = [4, 4, 4];
  const extent = () => region(lo.map((n, k) => Math.max(0, n - remaining[k])), hi.map((n, k) => Math.min(dims[k], n + remaining[k])));
  const input = extent(), passes = []; let previous = input;
  for (const axis of WORLD_GLOW_AXES) {
    remaining[axis] -= 2; const output = extent();
    passes.push(Object.freeze({ axis, input: previous, output })); previous = output;
  }
  return Object.freeze({ world: frozenArray(dims), core: frozenArray(core), input, output: previous, passes: frozenArray(passes), support: WORLD_GLOW_SUPPORT });
}
export function createWorldGlow(gpu, { g, emissionProvider, submissionProvider } = {}) {
  if (!g || !emissionProvider?.acquire || !emissionProvider.isCurrent || !submissionProvider?.reserve) throw new TypeError('explicit complete emission/submission providers required');
  const device = gpu.device ?? gpu, queue = device.queue, size = [g.nx, g.ny, g.nz], resources = createLightingResources(device);
  const transport = createLightingTransport(device, ['glow']);
  const layouts = [false, true].map(last => device.createBindGroupLayout({ entries: worldGlowLayouts({ last })[0] }));
  const ready = Promise.all(layouts.map((layout, i) => device.createComputePipelineAsync({ label: `world glow ${i ? 'half' : 'float'}`, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: device.createShaderModule({ code: worldGlow({ last: i === 1 }) }), entryPoint: 'main' } })).concat(transport.ready));
  let dead = false, serial = 0, active = null;
  const pending = new Set(), alive = () => { if (dead) throw new Error('world glow disposed'); };
  const drop = p => { if (p && --p.refs === 0) p.owned.forEach(r => r.destroy()); };
  function handle(p) {
    if (!p) return null;
    p.refs++; let released = false;
    const live = () => { if (released) throw new Error('released world glow output'); };
    return Object.freeze({ token: p.token, plan: p.plan,
      retain() { live(); return handle(p); },
      release() { if (!released) { released = true; drop(p); } },
      bindings() { live(); return Object.freeze({ values: p.values, texture: p.view, token: p.token }); },
      writeAtlas(atlas, job) {
        live(); worldLightingIndex(size, job.brick);
        const c = job.brick.map((n, k) => n - p.plan.output.min[k]);
        if (c.some((n, k) => n < 0 || n >= p.plan.output.size[k])) throw new RangeError('glow output does not own Atlas brick');
        const index = c[0] + p.plan.output.size[0] * (c[1] + p.plan.output.size[1] * c[2]);
        return transport.write({ atlas, job, kind: 'glow', token: p.token, source: p.values, copies: [{ from: index * 16, to: 0, size: 16 }], retain: () => handle(p) });
      },
    });
  }
  async function prepare({ core, lightingTick, configVersion } = {}) {
    alive(); if (!uint(lightingTick) || configVersion == null) throw new TypeError('world glow logical tick/config');
    const plan = worldGlowPlan(size, core), id = ++serial, owned = [];
    let input, recorded = false, finished = false;
    const release = () => { input?.release(); input = null; };
    const destroy = () => owned.splice(0).forEach(r => r.destroy());
    try {
      input = await emissionProvider.acquire({ plan, lightingTick }); validateLightingInput(input, size);
      const emission = input.emission;
      if (emission?.complete !== true || !emission.buffer || emission.format !== 'xyz-linear-f32-vec4-emission-div64' ||
        !emission.min || emission.min.length !== 3 || !emission.size || emission.size.length !== 3 || emission.min.some((n, k) => n !== plan.input.min[k]) || emission.size.some((n, k) => n !== plan.input.size[k]) ||
        emission.byteLength !== product(plan.input.size) * 16 || emission.byteLength > resources.limit || !uint(emission.byteOffset ?? 0) || (emission.byteOffset ?? 0) % 256 || (emission.byteOffset ?? 0) + emission.byteLength > emission.buffer.size) throw new TypeError('complete original brick emission with exact four-brick halo required');
      const pipes = await ready; alive();
      if (id !== serial || !emissionProvider.isCurrent(input)) { release(); return Object.freeze({ status: 'stale', retry: true }); }
      const key = plan.core.join(',');
      if (active?.token.lightingTick === lightingTick && active.key === key && sameLightingProvenance(active.token,input) && active.token.configVersion === configVersion) {
        release(); return Object.freeze({ status: 'cached', snapshot: handle(active) });
      }
      if (active?.token.epoch === input.epoch && lightingTick < active.token.lightingTick) throw new Error('glow tick regression');
      const buffer = (label, bytes, usage, data) => { const b = resources.buffer(label, bytes, usage, data); owned.push(b); return b; };
      const feedback = buffer('world glow pass status', 6 * 4, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST);
      const count = product(plan.output.size), texture = device.createTexture({ label: 'private world glow half output', size: [256, Math.max(1, Math.ceil(count / 256)), 1], format: 'rgba16float', usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.COPY_SRC }); owned.push(texture);
      const view = texture.createView({ dimension: '2d-array' });
      let previous = emission.buffer, previousOffset = emission.byteOffset ?? 0;
      const jobs = plan.passes.map((pass, i) => {
        const n = product(pass.output.size), out = buffer(`world glow f32 pass${i}`, n * 16, BU.STORAGE | BU.COPY_SRC);
        const raw = new ArrayBuffer(96), ints = new Int32Array(raw), words = new Uint32Array(raw);
        ints.set(pass.input.min, 0); words.set([...pass.input.size, product(pass.input.size)], 4); ints.set(pass.output.min, 8);
        words.set([...pass.output.size, n], 12); ints.set(plan.world, 16); words[19] = pass.axis; words[20] = i;
        const params = buffer('world glow exact pass params', 96, BU.UNIFORM, words), last = i === 5;
        const group = device.createBindGroup({ layout: layouts[last ? 1 : 0], entries: [
          { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: previous, offset: previousOffset, size: product(pass.input.size) * 16 } },
          { binding: 2, resource: { buffer: out } }, { binding: 3, resource: { buffer: feedback } }, ...(last ? [{ binding: 4, resource: view }] : []),
        ] });
        previous = out; previousOffset = 0; return { group, n, last, out };
      });
      const values = jobs[5].out; let status = 'prepared', completion;
      const candidate = { get status() { return status; }, get completion() { return completion; }, plan,
        record(frame = gpu.frame) {
          alive(); if (recorded || finished) throw new Error('world glow candidate already consumed');
          if (id !== serial || !emissionProvider.isCurrent(input)) { candidate.cancel(); status = 'stale'; completion = Promise.resolve(Object.freeze({ status, retry: true })); return completion; }
          completion = completeLightingBatch({ frame, queue, feedbackBuffer: feedback, wordCount: 6, submissionProvider,
            encode() { for (const j of jobs) { frame._command(); const pass = frame.compute('world glow', { dispatch: true }); pass.setPipeline(pipes[j.last ? 1 : 0]); pass.setBindGroup(0, j.group); pass.dispatchWorkgroups(Math.ceil(j.n / 64), 1, 1); frame._commandDone('world glow'); } },
            finish(words) {
              const failures = [...words.keys()].filter(i => words[i] !== 1);
              if (failures.length) { status = 'incomplete'; return Object.freeze({ status, failedPasses: frozenArray(failures), retry: true }); }
              if (dead || id !== serial || !emissionProvider.isCurrent(input)) { status = 'stale'; return Object.freeze({ status, retry: true }); }
              const token = Object.freeze({ epoch: input.epoch, sourceRevision: input.source.sourceRevision, sourceContentToken: input.source.contentToken, fieldPublishedToken: input.field.publishedToken, logicalFieldTick: input.field.logicalFieldTick, lightingTick, configVersion, dependencySetID: input.dependencySetID, dependencyVersion: input.dependencyVersion });
              const retainedResources = [values, texture]; for (const r of retainedResources) owned.splice(owned.indexOf(r), 1);
              const next = { refs: 1, owned: retainedResources, values, texture, view, token, plan, key }; const old = active; active = next; drop(old); status = 'published'; return Object.freeze({ status, token });
            },
          });
          recorded = true; status = 'pending';
          completion = completion.catch(error => { status = 'failed'; return Object.freeze({ status, error: String(error.message ?? error), retry: true }); }).finally(() => { finished = true; pending.delete(candidate); release(); destroy(); });
          return completion;
        },
        cancel() { if (recorded) throw new Error('queued glow must complete, not cancel'); if (!finished) { finished = true; status = 'cancelled'; pending.delete(candidate); release(); destroy(); } },
      };
      pending.add(candidate); return Object.freeze(candidate);
    } catch (e) { release(); destroy(); throw e; }
  }
  return Object.freeze({ ready, prepare, snapshot() { alive(); return handle(active); },
    reset() { alive(); serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
    dispose() { if (dead) return; dead = true; serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
  });
}
