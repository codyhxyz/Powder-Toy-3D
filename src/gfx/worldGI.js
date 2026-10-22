// Disabled continuous-world GI producer. Inputs/history/publication are explicit;
// this is not the application's scheduler, cold-history replay, or frame gate.
import { GiParams, giBgBlend } from '../shaders/gi.js';
import { worldGISource, worldGIGather, worldGILayouts, WORLD_GI_PARAMS_BYTES, WORLD_GI_GROUND_PER_WORD } from '../shaders/worldGI.js';
import { validateWorldGIInitialization } from '../world/worldLightingHistory.js';
import { BU, uint, frozenArray, worldLightingIndex, validateLightingInput, sameLightingProvenance, createLightingResources, completeLightingBatch, createLightingTransport } from './worldLightingBatch.js';

export function createWorldGI(gpu, { g, snapshotProvider, readerBindingProvider, feedbackProvider } = {}) {
  if (!g || ![g.nx, g.ny, g.nz].every(n => Number.isInteger(n) && n > 0 && n % 4 === 0) ||
    !snapshotProvider?.acquire || !snapshotProvider.isCurrent || typeof readerBindingProvider !== 'function' || !feedbackProvider?.layout || !feedbackProvider.reserve) throw new TypeError('explicit world GI providers required');
  const device = gpu.device ?? gpu, queue = device.queue, size = [g.nx, g.ny, g.nz];
  const resources = createLightingResources(device), transport = createLightingTransport(device);
  const sourceLayouts = worldGILayouts().map(entries => device.createBindGroupLayout({ entries }));
  const gatherLayouts = [...sourceLayouts.slice(0, 3), device.createBindGroupLayout({ entries: worldGILayouts({ gather: true })[3] })];
  const pipeline = (code, layouts, label) => device.createComputePipelineAsync({ label, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const ready = Promise.all([pipeline(worldGISource(g), sourceLayouts, 'world GI source'), pipeline(worldGIGather(g), gatherLayouts, 'world GI gather')]);
  let dead = false, serial = 0, active = null;
  const pending = new Set();
  // Every handle's output, for carry(): a published one, or an incomplete
  // SOURCE slab's completed jobs (p.ok).
  const carriers = new WeakMap();
  const alive = () => { if (dead) throw new Error('world GI disposed'); };
  const drop = p => { if (p && --p.refs === 0) p.owned.forEach(r => r.destroy()); };
  function handle(p) {
    if (!p) return null;
    p.refs++; let released = false;
    const live = () => { if (released) throw new Error('released world GI output'); };
    // An incomplete slab's jobs are only ever carried: never staged or written.
    const whole = () => { live(); if (p.ok) throw new Error('an incomplete world GI slab is only carried'); };
    const atlasWrite = (job, kind) => {
      whole(); const index = worldLightingIndex(size, job.brick), ids = kind === 'source' ? p.sources : kind === 'gi' ? p.probes : null;
      const slot = ids?.indexOf(index);
      if (slot == null || slot < 0) throw new Error('output does not own requested Atlas brick/channel');
      const copies = kind === 'source' ? [{ from: slot * 16, to: 0, size: 16 }] : Array.from({ length: 4 }, (_, k) => ({ from: (k * p.probes.length + slot) * 8, to: k * 8, size: 8 }));
      return { job, kind, token: p.token, source: kind === 'source' ? p.source : p.history, copies, retain: () => handle(p) };
    };
    const h = { token: p.token, sources: p.ok ? frozenArray(p.sources.filter(i => p.ok.has(i))) : p.sources, probes: p.probes,
      retain() { live(); return handle(p); },
      release() { if (!released) { released = true; drop(p); } },
      // Exact packed band-major history for the future provider. No texture
      // readback/float re-quantization is needed to retain temporal ownership.
      bindings() { whole(); return Object.freeze({ source: p.source, history: p.history, probeCount: p.probes.length, token: p.token }); },
      // One Atlas write, for transport.writeAll to submit with the others.
      atlasWrite,
      writeAtlas(atlas, job, kind) { return transport.write({ atlas, ...atlasWrite(job, kind) }); },
    };
    const frozen = Object.freeze(h); carriers.set(frozen, p);
    return frozen;
  }
  const canonical = (entries, gather) => {
    const jobs = entries.map(entry => ({ index: worldLightingIndex(size, Array.isArray(entry) ? entry : entry.brick), background: gather && entry.background === true }));
    jobs.sort((a, b) => a.index - b.index);
    if (jobs.some((j, i) => i && j.index === jobs[i - 1].index)) throw new Error('duplicate world GI job');
    return jobs;
  };
  // A job's flags (shaders/worldGI.js): bit 0 background, bit 1 a birth (the
  // original reset reads every previous probe as one).
  const jobFlags = (j, reset, births) => (j.background ? 1 : 0) | (reset || births.has(j.index) ? 2 : 0);
  const checkInitialization = (input, initialization, lightingTick, sources, probes) => {
    if (!initialization) { if (input.initialization) throw new Error('explicit initialization manifest required'); return; }
    if (input.initialization !== initialization || input.previous?.initialization !== initialization) throw new Error('pinned initialization/previous manifest mismatch');
    validateWorldGIInitialization(initialization, { epoch: input.epoch, lightingTick, sourceIndices: sources.map(j=>j.index), probeIndices: probes.map(j=>j.index), previousToken: input.previous?.token, cutToken: input.source.contentToken, sourcePhaseToken: input.sourcePhaseToken });
  };
  // A restart's SOURCE jobs that an earlier attempt of the same load already
  // computed (wire/worldRender.js carrySources), carried instead of run again:
  // a SOURCE job reads its brick's cells and its neighbours', the sun map at
  // its lit faces, the lamps and its own previous probe (shaders/gi.js
  // giSourceFrag), so one of the same cut, field tick, previous history,
  // lighting tick, config, shadows and birth flag gives the same 16 bytes, and
  // a job's light never depends on its slab's other jobs. The caller vouches
  // for the sun (the same tiles, each as sharp, as the job was lit under).
  // The kept jobs' bytes are copied into one output of this attempt's
  // initialization and current publication: what a fresh slab of them would
  // publish. Returns it (null when none is kept) and the indices it holds.
  async function carry({ from = [], sourceBricks = [], lightingTick, configVersion, initialization = null, reset = false, shadows = true } = {}) {
    alive();
    if (!uint(lightingTick) || configVersion == null || reset !== (lightingTick === 0)) throw new TypeError('world logical lighting tick/config/reset');
    const pool = from.map(h => carriers.get(h));
    if (pool.some(p => !p || p.refs < 1)) throw new Error('carry requires live outputs of this world GI producer');
    const wanted = canonical(sourceBricks, false), none = Object.freeze({ output: null, carried: frozenArray([]) });
    if (!wanted.length || !pool.length) return none;
    const input = await snapshotProvider.acquire({ lightingTick, reset, sourceIndices: frozenArray(wanted.map(j => j.index)), probeIndices: frozenArray([]), initialization });
    const owned = [];
    try {
      validateLightingInput(input, size);
      checkInitialization(input, initialization, lightingTick, wanted, []);
      alive();
      if (!snapshotProvider.isCurrent(input) || input.previous?.complete !== true || input.previous.token == null || input.previous.lightingTick !== lightingTick - 1) return none;
      const births = new Set(initialization?.indices ?? []);
      const same = p => p.token.epoch === input.epoch && p.token.sourceRevision === input.source.sourceRevision && p.token.sourceContentToken === input.source.contentToken &&
        p.token.logicalFieldTick === input.field.logicalFieldTick && p.token.previousToken === input.previous.token && p.token.lightingTick === lightingTick &&
        p.token.configVersion === configVersion && p.shadows === shadows && p.reset === reset && !p.probes.length;
      const slots = new Map();   // index -> [output, slot]
      for (const p of pool) if (same(p)) p.sources.forEach((i, slot) => { if ((!p.ok || p.ok.has(i)) && p.flags[slot] === jobFlags({ index: i }, reset, births) && !slots.has(i)) slots.set(i, [p, slot]); });
      const kept = wanted.filter(j => slots.has(j.index)).slice(0, Math.floor(resources.limit / 16));
      if (!kept.length) return none;
      const source = resources.buffer('carried world GI sources', kept.length * 16, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST); owned.push(source);
      // Runs of consecutive slots of one output, one copy each.
      for (let k = 0; k < kept.length;) {
        const [p, slot] = slots.get(kept[k].index); let n = 1;
        while (k + n < kept.length && slots.get(kept[k + n].index)[0] === p && slots.get(kept[k + n].index)[1] === slot + n) n++;
        gpu.frame.copy(p.source, slot * 16, source, k * 16, n * 16); k += n;
      }
      gpu.flush('world GI carried SOURCES');
      // The copies have run before the caller lets their outputs go.
      await queue.onSubmittedWorkDone();
      alive();
      const token = Object.freeze({ initialization, epoch: input.epoch, sourceRevision: input.source.sourceRevision, sourceContentToken: input.source.contentToken, fieldPublishedToken: input.field.publishedToken, logicalFieldTick: input.field.logicalFieldTick, previousToken: input.previous.token, lightingTick, configVersion, dependencySetID: input.dependencySetID, dependencyVersion: input.dependencyVersion, carried: true });
      owned.splice(0);
      const next = { refs: 0, owned: [source], source, history: null, sources: frozenArray(kept.map(j => j.index)), probes: frozenArray([]), flags: frozenArray(kept.map(j => jobFlags(j, reset, births))), shadows, reset, ok: null, token, key: null };
      return Object.freeze({ output: handle(next), carried: next.sources });
    } finally { input.release(); owned.forEach(r => r.destroy()); }
  }
  // ring: the light bounce's near ring ({ eye, radius }, cells: world/worldGIRing.js),
  // ground: the ground twin a gather reads past it ({ words, columns }:
  // shaders/worldGI.js worldGIGroundWords). Without both every read is near.
  async function prepare({ lightingTick, sourceBricks = [], gatherBricks = [], reset = false, shadows = true, configVersion, initialization = null, ring = null, ground = null } = {}) {
    alive();
    if (!uint(lightingTick) || configVersion == null || reset !== (lightingTick === 0)) throw new TypeError('world logical lighting tick/config/reset');
    const ringed = !!ring && !!ground;
    if (ringed && (!(Array.from(ring.eye ?? []).length === 3 && Array.from(ring.eye).every(Number.isFinite)) || !(ring.radius >= 0) ||
      !(ground.words instanceof Uint32Array) || ground.words.length % 4 || !Array.isArray(ground.columns) || ground.columns.length !== 2 || !ground.columns.every(n => uint(n) && n > 0) ||
      ground.words.length * WORLD_GI_GROUND_PER_WORD < ground.columns[0] * ground.columns[1])) throw new TypeError('world GI ring: an eye, a radius and the packed ground twin');
    const sources = canonical(sourceBricks, false), probes = canonical(gatherBricks, true), count = sources.length + probes.length;
    if (!count) throw new Error('empty GI selection: scheduler owns the logical tick, not draw/prepare');
    if (count * 16 > resources.limit || probes.length * 32 > resources.limit) throw new RangeError('world GI selection exceeds bounded slab; provider must partition the SOURCE phase before any gather');
    const id = ++serial, owned = []; let input, recorded = false, finished = false;
    const destroy = () => owned.splice(0).forEach(r => r.destroy());
    const release = () => { input?.release(); input = null; };
    try {
      input = await snapshotProvider.acquire({ lightingTick, reset, sourceIndices: frozenArray(sources.map(j => j.index)), probeIndices: frozenArray(probes.map(j => j.index)), initialization });
      validateLightingInput(input, size);
      const validateInitialization = () => checkInitialization(input, initialization, lightingTick, sources, probes);
      validateInitialization();
      if (input.previous?.complete !== true || input.previous.token == null || input.previous.lightingTick !== lightingTick - 1 || typeof input.previous.recordHistory !== 'function' || input.previous.recordHistory.constructor.name === 'AsyncFunction' ||
        reset && input.previous.resetSeed !== true) throw new Error('exact pinned previous history or explicit original reset seed required');
      const pipes = await ready; alive(); validateInitialization();
      if (id !== serial || !snapshotProvider.isCurrent(input)) { release(); return Object.freeze({ status: 'stale', retry: true }); }
      const births = new Set(initialization?.indices ?? []);
      const key = JSON.stringify([lightingTick, reset, shadows, sources, probes, ringed ? [Array.from(ring.eye), ring.radius] : null]);
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
      // The original reset (shaders/gi.js mode 2: every source and probe
      // replaced) seeds from the ledger's reset seed, every probe zero
      // (validated above), which is what a birth reads. So at the reset every
      // job reads its previous probe as a birth: a SOURCE with no probe yet no
      // longer asks for one only to read zero from it, which made each SOURCE's
      // brick a probe whose gather asked for more SOURCES, and so on (Island,
      // 2026-10-22: ~64 more probes every attempt from the 18th on).
      [...sources, ...probes].forEach((j, i) => words.set([j.index, jobFlags(j, reset, births), 0, 0], i * 4));
      // A gather's ground twin follows its jobs in the same buffer (worldGIProxy).
      const groundAt = Math.max(1, count), withGround = ringed && probes.length > 0;
      const jobWords = withGround ? new Uint32Array(groundAt * 4 + ground.words.length) : words;
      if (withGround) { jobWords.set(words.subarray(0, count * 4)); jobWords.set(ground.words, groundAt * 4); }
      const jobs = buffer('world GI global jobs', jobWords.byteLength, BU.STORAGE, jobWords);
      const source = buffer('private world GI sources', sources.length * 16, BU.STORAGE | BU.COPY_SRC);
      const history = buffer('COW world GI packed history', probes.length * 32, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST);
      // WorldGIParams (shaders/worldGI.js): counts at word 0, config 4, ring 8, ground 12.
      const paramWords = new ArrayBuffer(WORLD_GI_PARAMS_BYTES), u32 = new Uint32Array(paramWords), f32 = new Float32Array(paramWords);
      u32.set([sources.length, probes.length, fb.jobStatusWordOffset, lightingTick, input.epoch, 0, 0, 0]);
      f32.set(withGround ? [...Array.from(ring.eye), ring.radius] : [0, 0, 0, -1], 8);
      u32.set(withGround ? [ground.columns[0], ground.columns[1], groundAt, 0] : [0, 0, 0, 0], 12);
      const params = buffer('world GI logical params', WORLD_GI_PARAMS_BYTES, BU.UNIFORM, u32);
      const gi = new ArrayBuffer(GiParams.size), dv = new DataView(gi);
      // GiParams is the ORIGINAL packed uniform layout; normal blend .4,
      // background blend 1-(1-.4)^4, reset blend 1. No allocation-based phase.
      dv.setInt32(0, -1, true); dv.setUint32(4, probes.length, true); dv.setFloat32(8, reset ? 1 : .4, true); dv.setUint32(12, shadows ? 1 : 0, true); dv.setUint32(16, 0, true); dv.setFloat32(20, reset ? 1 : giBgBlend(.4), true);
      const giParams = buffer('world GI original params', gi.byteLength, BU.UNIFORM, new Uint8Array(gi));
      const entries = readerBindingProvider(input);
      if (!Array.isArray(entries) || entries.length !== 4 || entries[3].some(e => e.binding > 5)) throw new TypeError('exact full world reader G0..G3 entries required, without pick output');
      const first = entries.slice(0, 3).map((entries, i) => device.createBindGroup({ layout: sourceLayouts[i], entries }));
      const operation = [...entries[3].filter(e => e.binding !== 1), { binding: 1, resource: { buffer: requests } }, { binding: 6, resource: { buffer: giParams } }, { binding: 7, resource: { buffer: params } }, { binding: 8, resource: { buffer: jobs } }, { binding: 9, resource: { buffer: source } }];
      const sourceGroup = device.createBindGroup({ layout: sourceLayouts[3], entries: operation });
      const gatherGroup = device.createBindGroup({ layout: gatherLayouts[3], entries: [...operation, { binding: 10, resource: { buffer: history } }] });
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
                const current = !dead && id === serial && snapshotProvider.isCurrent(input);
                const token = () => Object.freeze({ initialization, epoch: input.epoch, sourceRevision: input.source.sourceRevision, sourceContentToken: input.source.contentToken, fieldPublishedToken: input.field.publishedToken, logicalFieldTick: input.field.logicalFieldTick, previousToken: input.previous.token, lightingTick, configVersion, dependencySetID: input.dependencySetID, dependencyVersion: input.dependencyVersion });
                const flags = frozenArray(sources.map(j => jobFlags(j, reset, births)));
                if (decoded.incomplete || failures.length) {
                  status = 'incomplete';
                  // A SOURCE slab's jobs that did complete (each read nothing
                  // missing), kept for a restart to carry (carry()).
                  const failed = new Set(failures);
                  let partial = null;
                  if (current && !probes.length && failed.size < count) {
                    owned.splice(owned.indexOf(source), 1);
                    partial = handle({ refs: 0, owned: [source], source, history: null, sources: frozenArray(sources.map(j => j.index)), probes: frozenArray([]), flags, shadows, reset, ok: new Set(sources.filter((j, i) => !failed.has(i)).map(j => j.index)), token: token(), key });
                  }
                  return Object.freeze({ status, feedback: decoded, failedJobs: frozenArray(failures), retry: true, partial });
                }
                if (!current) { status = 'stale'; return Object.freeze({ status, retry: true }); }
                validateInitialization();
                const retainedResources = [source, history]; for (const r of retainedResources) owned.splice(owned.indexOf(r), 1);
                const next = { refs: 1, owned: retainedResources, source, history, sources: frozenArray(sources.map(j => j.index)), probes: frozenArray(probes.map(j => j.index)), flags, shadows, reset, ok: null, token: token(), key };
                const old = active; active = next; drop(old); status = 'published'; return Object.freeze({ status, token: next.token });
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
  return Object.freeze({ ready, prepare, carry, snapshot() { alive(); return handle(active); },
    reset() { alive(); serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
    dispose() { if (dead) return; dead = true; serial++; drop(active); active = null; for (const c of [...pending]) if (c.status === 'prepared') c.cancel(); },
  });
}
