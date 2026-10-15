// Disabled continuous-world GI producer. Inputs/history/publication are explicit;
// this is not the application's scheduler, cold-history replay, or frame gate.
import { GiParams, giBgBlend } from '../shaders/gi.js';
import { worldGISource, worldGIGather, worldGILayouts } from '../shaders/worldGI.js';
import { validateWorldGIInitialization } from '../world/worldLightingHistory.js';
import { BU, TU, uint, frozenArray, worldLightingIndex, validateLightingInput, sameLightingProvenance, createLightingResources, completeLightingBatch, createLightingTransport } from './worldLightingBatch.js';

export function createWorldGI(gpu, { g, snapshotProvider, readerBindingProvider, feedbackProvider } = {}) {
  if (!g || ![g.nx, g.ny, g.nz].every(n => Number.isInteger(n) && n > 0 && n % 4 === 0) ||
    !snapshotProvider?.acquire || !snapshotProvider.isCurrent || typeof readerBindingProvider !== 'function' || !feedbackProvider?.layout || !feedbackProvider.reserve) throw new TypeError('explicit world GI providers required');
  const device = gpu.device ?? gpu, queue = device.queue, size = [g.nx, g.ny, g.nz];
  const resources = createLightingResources(device), transport = createLightingTransport(device, ['source', 'gi']);
  const sourceLayouts = worldGILayouts().map(entries => device.createBindGroupLayout({ entries }));
  const gatherLayouts = [...sourceLayouts.slice(0, 3), device.createBindGroupLayout({ entries: worldGILayouts({ gather: true })[3] })];
  const pipeline = (code, layouts, label) => device.createComputePipelineAsync({ label, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const ready = Promise.all([pipeline(worldGISource(g), sourceLayouts, 'world GI source'), pipeline(worldGIGather(g), gatherLayouts, 'world GI gather'), transport.ready]);
  let dead = false, serial = 0, active = null;
  const pending = new Set();
  const alive = () => { if (dead) throw new Error('world GI disposed'); };
  const drop = p => { if (p && --p.refs === 0) p.owned.forEach(r => r.destroy()); };
  function handle(p) {
    if (!p) return null;
    p.refs++; let released = false;
    const live = () => { if (released) throw new Error('released world GI output'); };
    const h = { token: p.token, sources: p.sources, probes: p.probes,
      retain() { live(); return handle(p); },
      release() { if (!released) { released = true; drop(p); } },
      // Exact packed band-major history for the future provider. No texture
      // readback/float re-quantization is needed to retain temporal ownership.
      bindings() { live(); return Object.freeze({ source: p.source, history: p.history, bands: p.views, probeCount: p.probes.length, token: p.token }); },
      writeAtlas(atlas, job, kind) {
        live(); const index = worldLightingIndex(size, job.brick), ids = kind === 'source' ? p.sources : kind === 'gi' ? p.probes : null;
        const slot = ids?.indexOf(index);
        if (slot == null || slot < 0) throw new Error('output does not own requested Atlas brick/channel');
        const copies = kind === 'source' ? [{ from: slot * 16, to: 0, size: 16 }] : Array.from({ length: 4 }, (_, k) => ({ from: (k * p.probes.length + slot) * 8, to: k * 8, size: 8 }));
        return transport.write({ atlas, job, kind, token: p.token, source: kind === 'source' ? p.source : p.history, copies, retain: () => handle(p) });
      },
    };
    return Object.freeze(h);
  }
  async function prepare({ lightingTick, sourceBricks = [], gatherBricks = [], reset = false, shadows = true, configVersion, initialization = null } = {}) {
    alive();
    if (!uint(lightingTick) || configVersion == null || reset !== (lightingTick === 0)) throw new TypeError('world logical lighting tick/config/reset');
    const canonical = (entries, gather) => {
      const jobs = entries.map(entry => ({ index: worldLightingIndex(size, Array.isArray(entry) ? entry : entry.brick), background: gather && entry.background === true }));
      jobs.sort((a, b) => a.index - b.index);
      if (jobs.some((j, i) => i && j.index === jobs[i - 1].index)) throw new Error('duplicate world GI job');
      return jobs;
    };
    const sources = canonical(sourceBricks, false), probes = canonical(gatherBricks, true), count = sources.length + probes.length;
    if (!count) throw new Error('empty GI selection: scheduler owns the logical tick, not draw/prepare');
    if (count * 16 > resources.limit || probes.length * 32 > resources.limit || probes.length > 256 * (device.limits?.maxTextureDimension2D ?? 8192)) throw new RangeError('world GI selection exceeds bounded slab; provider must partition the SOURCE phase before any gather');
    const id = ++serial, owned = []; let input, recorded = false, finished = false;
    const destroy = () => owned.splice(0).forEach(r => r.destroy());
    const release = () => { input?.release(); input = null; };
    try {
      input = await snapshotProvider.acquire({ lightingTick, reset, sourceIndices: frozenArray(sources.map(j => j.index)), probeIndices: frozenArray(probes.map(j => j.index)), initialization });
      validateLightingInput(input, size);
      const validateInitialization = () => {
        if (!initialization) { if (input.initialization) throw new Error('explicit initialization manifest required'); return; }
        if (input.initialization !== initialization || input.previous?.initialization !== initialization) throw new Error('pinned initialization/previous manifest mismatch');
        validateWorldGIInitialization(initialization, { epoch: input.epoch, lightingTick, sourceIndices: sources.map(j=>j.index), probeIndices: probes.map(j=>j.index), previousToken: input.previous?.token, cutToken: input.source.contentToken, sourcePhaseToken: input.sourcePhaseToken });
      };
      validateInitialization();
      if (input.previous?.complete !== true || input.previous.token == null || input.previous.lightingTick !== lightingTick - 1 || typeof input.previous.recordHistory !== 'function' || input.previous.recordHistory.constructor.name === 'AsyncFunction' ||
        reset && input.previous.resetSeed !== true) throw new Error('exact pinned previous history or explicit original reset seed required');
      const pipes = await ready; alive(); validateInitialization();
      if (id !== serial || !snapshotProvider.isCurrent(input)) { release(); return Object.freeze({ status: 'stale', retry: true }); }
      const births = new Set(initialization?.indices ?? []);
      const key = JSON.stringify([lightingTick, reset, shadows, sources, probes]);
      if (active?.token.initialization === initialization && active?.token.lightingTick === lightingTick && active.key === key && sameLightingProvenance(active.token,input) && active.token.configVersion === configVersion && active.token.previousToken === input.previous.token) {
        release(); return Object.freeze({ status: 'cached', snapshot: handle(active) });
      }
      // A different uncommitted slab/retry may use the SAME logical tick, but
      // MUST seed from tick-1 again. Producing outputs is not history adoption.
      if (active?.token.epoch === input.epoch && lightingTick < active.token.lightingTick) throw new Error('world GI tick regression');
      const fb = feedbackProvider.layout({ snapshot: input, jobCount: count });
      const typedWords = 6 * Math.ceil(size[0] / 4 * (size[1] / 4) * (size[2] / 4) / 32) + 1;
      if (!uint(fb?.wordCount) || !uint(fb.reservedWords) || fb.reservedWords < typedWords || !uint(fb.jobStatusWordOffset) || fb.jobStatusWordOffset < fb.reservedWords || fb.jobStatusWordOffset + count > fb.wordCount || fb.wordCount * 4 > resources.limit || typeof fb.decode !== 'function') throw new RangeError('explicit nonoverlapping typed/Sun/job feedback ranges required');
      const buffer = (label, bytes, usage, data) => { const b = resources.buffer(label, bytes, usage, data); owned.push(b); return b; };
      const requests = buffer('world GI typed feedback', fb.wordCount * 4, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST);
      const words = new Uint32Array(Math.max(4, count * 4));
      [...sources, ...probes].forEach((j, i) => words.set([j.index, (j.background ? 1 : 0) | (births.has(j.index) ? 2 : 0), 0, 0], i * 4));
      const jobs = buffer('world GI global jobs', words.byteLength, BU.STORAGE, words);
      const source = buffer('private world GI sources', sources.length * 16, BU.STORAGE | BU.COPY_SRC);
      const history = buffer('COW world GI packed history', probes.length * 32, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST);
      const params = buffer('world GI logical params', 32, BU.UNIFORM, new Uint32Array([sources.length, probes.length, fb.jobStatusWordOffset, lightingTick, input.epoch, 0, 0, 0]));
      const gi = new ArrayBuffer(GiParams.size), dv = new DataView(gi);
      // GiParams is the ORIGINAL packed uniform layout; normal blend .4,
      // background blend 1-(1-.4)^4, reset blend 1. No allocation-based phase.
      dv.setInt32(0, -1, true); dv.setUint32(4, probes.length, true); dv.setFloat32(8, reset ? 1 : .4, true); dv.setUint32(12, shadows ? 1 : 0, true); dv.setUint32(16, 0, true); dv.setFloat32(20, reset ? 1 : giBgBlend(.4), true);
      const giParams = buffer('world GI original params', gi.byteLength, BU.UNIFORM, new Uint8Array(gi));
      const height = Math.max(1, Math.ceil(probes.length / 256));
      const textures = Array.from({ length: 4 }, (_, k) => {
        const t = device.createTexture({ label: `private world GI band${k}`, size: [256, height, 1], format: 'rgba16float', usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.COPY_SRC }); owned.push(t); return t;
      });
      const views = frozenArray(textures.map(t => t.createView({ dimension: '2d-array' })));
      const entries = readerBindingProvider(input);
      if (!Array.isArray(entries) || entries.length !== 4 || entries[3].some(e => e.binding > 5)) throw new TypeError('exact full world reader G0..G3 entries required, without pick output');
      const first = entries.slice(0, 3).map((entries, i) => device.createBindGroup({ layout: sourceLayouts[i], entries }));
      const operation = [...entries[3].filter(e => e.binding !== 1), { binding: 1, resource: { buffer: requests } }, { binding: 6, resource: { buffer: giParams } }, { binding: 7, resource: { buffer: params } }, { binding: 8, resource: { buffer: jobs } }, { binding: 9, resource: { buffer: source } }];
      const sourceGroup = device.createBindGroup({ layout: sourceLayouts[3], entries: operation });
      const gatherGroup = device.createBindGroup({ layout: gatherLayouts[3], entries: [...operation, { binding: 10, resource: { buffer: history } }, ...views.map((resource, k) => ({ binding: 11 + k, resource }))] });
      let status = 'prepared', completion;
      const candidate = { get status() { return status; }, get completion() { return completion; },
        record(frame = gpu.frame) {
          alive(); if (recorded || finished) throw new Error('world GI candidate already consumed');
          try { validateInitialization(); } catch (error) { candidate.cancel(); throw error; }
          if (id !== serial || !snapshotProvider.isCurrent(input)) { candidate.cancel(); status = 'stale'; completion = Promise.resolve(Object.freeze({ status, retry: true })); return completion; }
          const dispatch = (phase, group, n) => { if (!n) return; frame._command(); const pass = frame.compute(`world GI ${phase}`, { dispatch: true }); pass.setPipeline(pipes[phase === 'source' ? 0 : 1]); [...first, group].forEach((b, i) => pass.setBindGroup(i, b)); pass.dispatchWorkgroups(Math.min(n, 65535), Math.ceil(n / 65535), 1); frame._commandDone(`world GI ${phase}`); };
          try {
            completion = completeLightingBatch({ frame, queue, feedbackBuffer: requests, wordCount: fb.wordCount, submissionProvider: feedbackProvider,
              encode() {
                const result = input.previous.recordHistory(frame, { indices: frozenArray(probes.map(p => p.index)), destination: history, format: 'band-major-4x-vec2u', lightingTick: lightingTick - 1 });
                if (result?.then) throw new TypeError('previous history must record synchronously at call time');
                dispatch('source', sourceGroup, sources.length);
                // GLOBAL phase barrier: never interleave source/gather per core.
                dispatch('gather', gatherGroup, Math.ceil(probes.length / 2));
              },
              finish(words) {
                const decoded = fb.decode(words), failures = Array.from({ length: count }, (_, i) => i).filter(i => words[fb.jobStatusWordOffset + i] !== 1);
                if (decoded.incomplete || failures.length) { status = 'incomplete'; return Object.freeze({ status, feedback: decoded, failedJobs: frozenArray(failures), retry: true }); }
                if (dead || id !== serial || !snapshotProvider.isCurrent(input)) { status = 'stale'; return Object.freeze({ status, retry: true }); }
                validateInitialization();
                const token = Object.freeze({ initialization, epoch: input.epoch, sourceRevision: input.source.sourceRevision, sourceContentToken: input.source.contentToken, fieldPublishedToken: input.field.publishedToken, logicalFieldTick: input.field.logicalFieldTick, previousToken: input.previous.token, lightingTick, configVersion, dependencySetID: input.dependencySetID, dependencyVersion: input.dependencyVersion });
                const retainedResources = [source, history, ...textures]; for (const r of retainedResources) owned.splice(owned.indexOf(r), 1);
                const next = { refs: 1, owned: retainedResources, source, history, textures, views, sources: frozenArray(sources.map(j => j.index)), probes: frozenArray(probes.map(j => j.index)), token, key };
                const old = active; active = next; drop(old); status = 'published'; return Object.freeze({ status, token });
              },
            });
          } catch (e) { throw e; }
          recorded = true; status = 'pending';
          completion = completion.catch(error => { status = 'failed'; return Object.freeze({ status, error: String(error.message ?? error), retry: true }); }).finally(() => { finished = true; pending.delete(candidate); release(); destroy(); });
          return completion;
        },
        cancel() { if (recorded) throw new Error('queued world GI must complete, not cancel'); if (!finished) { finished = true; status = 'cancelled'; pending.delete(candidate); release(); destroy(); } },
      };
      pending.add(candidate); return Object.freeze(candidate);
    } catch (e) { release(); destroy(); throw e; }
  }
  return Object.freeze({ ready, prepare, snapshot() { alive(); return handle(active); },
    reset() { alive(); serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
    dispose() { if (dead) return; dead = true; serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
  });
}
