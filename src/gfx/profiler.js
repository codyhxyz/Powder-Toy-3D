// In-app GPU/CPU profiler (Settings → Developer; the overlay is ui/profiler.js).
//
// Off, it costs a property test per instrumented point: phase() returns at
// once, gpu.timing is off, and no pass is split, timed or read back.
//
// On, every frame times its phases on the CPU (performance.now() between the
// phase marks the frame loop sets). On the GPU, gpu.timing runs in split mode
// (docs/webgpu.md B8): every pass on the shared device gets timestamp queries, and every
// dispatch a compute pass of its own named after its kernel, so the report
// keeps its per-pass shape. The profiler notes, as each timed pass begins,
// which phase the frame was in; when that frame's timestamps land (1–3 frames
// later, gpu.timing.last) they are matched back to those passes. Once every
// SAMPLE_INTERVAL_MS the latest landed frame becomes a sample. A still scene
// renders nothing (gfx/pacing.js): the profiler doesn't wake it, it reports idle.
//
// Every frame also lands in a ring for the live frame-time graph: the time from
// its start to the next frame's start (what a hitch looks like), its own CPU
// work, and that work by phase.
//
// Three's meshes and TAAU are included automatically. Copy/upload commands,
// the browser compositor and other devices are outside GPU pass time.
// Splitting has overhead; compare with unsplit captures for total frame cost.
// Missing queries/readback failures invalidate the total, not silently zero it.

const SAMPLE_INTERVAL_MS = 1000;   // between samples
const IDLE_AFTER_MS = 500;         // without GPU work before the overlay says idle
const FRAMES_KEPT = 16;            // frames whose passes are kept while their timestamps are in flight
export const HISTORY = 40;         // recent samples' GPU totals kept for the spike strip
export const FRAMES = 180;         // recent frames kept for the frame-time graph (3 s at the 60 fps cap)
const MS_PER_S = 1000;
const CANVAS_BYTES = 4;            // per canvas pixel: RGBA8 (the presenter's)

// Frame phases in display order; a pass belongs to the phase marked last (app.js frame()).
export const PHASES = [
  { id: 'paint', label: 'Paint' },       // the brush
  { id: 'sim', label: 'Sim' },           // the steps: activity build (inertList, inert, quiet, drawn, move1, args), move, react, aeration
  { id: 'derived', label: 'Derived' },   // render fields, bricks, empty-space distance, glow volume
  { id: 'shadow', label: 'Shadow' },     // the sun's shadow map
  { id: 'gi', label: 'GI' },             // GI probes
  { id: 'view', label: 'View' },         // raymarch, far field, overlays and three's meshes
  { id: 'post', label: 'Post' },         // TAA or TAAU, bloom, adaptation, the canvas composite
  { id: 'other', label: 'Other' },       // picking, signs, multiplayer, first-person probes, frame-loop upkeep
];
const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));
const OTHER = PHASE_INDEX.other;

// gpu.timing observes every pass at the device boundary; the profiler tags
// each record with its phase, including passes whose timing failed. Installed
// once per gpu; `watch` is the profiler's (null while it is off).
function watchTimedPasses(timing) {
  if (timing.__profiler) return timing.__profiler;
  const hook = { watch: null };
  const previous = timing.onPass;
  timing.onPass = (pass) => {
    previous?.(pass);
    hook.watch?.(pass);
  };
  timing.__profiler = hook;
  return hook;
}

/**
 * @param {object} gpu the gpu from createGpu (src/gpu/device.js)
 * @param {{ describe: () => { sim?: object | null, renderScale: number, canvas?: number[], pixelRatio?: number, bytes?: number },
 *           onSample: (sample: object | null) => void, onFrame?: (ring: object) => void }} opts
 *   describe: called once per sample for what the report shows besides timings
 *   (canvas: the drawing buffer [w, h]; bytes: GPU memory gpu.memory() doesn't
 *   count, such as three's scene targets); onSample: gets each sample, or null
 *   when rendering went idle; onFrame: called as each frame's time is known
 *   (the frame ring, see `ring`).
 */
export function createProfiler(gpu, { describe, onSample, onFrame }) {
  const timing = gpu.timing;
  const hook = watchTimedPasses(timing);
  const cpuFrame = new Float64Array(PHASES.length);   // ms per phase, this frame
  const cpuSum = new Float64Array(PHASES.length);     // …summed over this window's frames that worked
  const totals = [];
  // the frame ring: slot = (head + i) % FRAMES for the i-th oldest of `count`
  const ring = {
    ms: new Float32Array(FRAMES),                      // start to the next frame's start
    work: new Float32Array(FRAMES),                    // its own CPU time, start to end
    phases: new Float32Array(FRAMES * PHASES.length),  // that work by phase
    head: 0, count: 0,
  };
  const pendPhases = new Float64Array(PHASES.length);  // the last frame's, until the next one starts
  let pendWork = 0, pending = false;
  const frames = new Map();    // gpu frame (as gpu.timing.lastFrame will name it) → { passes: [{ name, phase }], wall, steps }
  let latest = null;           // the last sample
  let gpuName = '';
  let on = false;
  let mark = 0, cur = OTHER;   // time of the last phase mark, and the phase since then
  let passesAtBegin = 0;       // all render + compute passes when the frame began
  let frameNow = 0, frameStart = 0, prevNow = 0, prevWorked = false;
  let lastSample = -Infinity, lastWorked = 0, idle = false, sampledFrame = -1;
  let cpuFrames = 0, workedFrames = 0, drawDt = 0, drawN = 0, steps = 0;   // this window
  let maps = { awake: null, drawn: null }, mapsReading = false;

  const passCount = () => timing.passCount;
  // the gpu frame a pass recorded now belongs to: endFrame increments frameNo,
  // then closes the timing frame under the new number
  const frameTag = () => gpu.frameNo + 1;
  const recordOf = (tag) => {
    let r = frames.get(tag);
    if (!r) {
      frames.set(tag, r = { passes: [], wall: null, steps: 0 });
      if (frames.size > FRAMES_KEPT) frames.delete(frames.keys().next().value);
    }
    return r;
  };
  const watch = (pass) => { pass.phase = cur; recordOf(frameTag()).passes.push(pass); };

  // Brick shares from the sim's maps (docs/webgpu.md G5: brick level), read
  // asynchronously; a sample shows the latest that has landed. Under V2 its own
  // activity (v2/physics.js readStats, after the last tick): the bricks its passes
  // ran over (V1's DRAWN: "the steps run it") and those a rule was busy in (V1's
  // AWAKE), over its bricks. V1's maps aren't rebuilt while V2 runs the box: they
  // showed the shares V1 last left.
  function readShares(sim) {
    if (mapsReading) return;
    const v2 = sim?.compact;
    if (typeof v2?.readStats === 'function') {
      mapsReading = true;
      v2.readStats().then((s) => {
        maps = s.units > 0 ? { awake: s.busy / s.units, drawn: s.awake / s.units } : { awake: null, drawn: null };
      }).catch(() => {}).finally(() => { mapsReading = false; });
      return;
    }
    if (typeof sim?.readMaps !== 'function') return;
    mapsReading = true;
    sim.readMaps().then((m) => {
      const share = (a) => { if (!a?.length) return null; let n = 0; for (let i = 0; i < a.length; i++) if (a[i]) n++; return n / a.length; };
      maps = { awake: share(m.awake), drawn: sim.skipSleeping === false ? 1 : share(m.drawn) };
    }).catch(() => {}).finally(() => { mapsReading = false; });
  }

  // a sample from frame `tag`, whose timestamps are `ms` ({ pass name: ms summed
  // over the frame }), or one without GPU times (ms null: no timestamp-query)
  function makeSample(tag, ms) {
    const rec = tag === null ? null : frames.get(tag);
    const coverage = ms ? timing.lastCoverage : null;
    const phases = PHASES.map((p) => ({ ...p, gpu: ms ? 0 : null, cpu: cpuFrames ? 0 : null, segs: [], detail: [] }));
    const passes = [];
    let gpuAt = 0;
    if (ms) {
      for (const ps of timing.lastPasses) {
        const phase = typeof ps.phase === 'number' ? ps.phase : PHASE_INDEX[ps.phase] ?? OTHER;
        const gpuMs = ps.gpu, ph = phases[phase];
        ph.gpu = ph.gpu === null || gpuMs === null ? null : ph.gpu + gpuMs;
        const segs = gpuMs === null || ps.start === null ? [] : [[ps.start, ps.start + gpuMs]];
        ph.segs.push(...segs);
        const d = ph.detail.find((x) => x.name === ps.name);
        if (d) {
          d.count++;
          d.gpu = d.gpu === null || gpuMs === null ? null : d.gpu + gpuMs;
          d.segs.push(...segs);
        } else ph.detail.push({ name: ps.name, count: 1, gpu: gpuMs, segs });
        passes.push({ ...ps, phase });
        gpuAt += gpuMs ?? 0;
      }
    }
    if (cpuFrames) phases.forEach((ph, i) => { ph.cpu = cpuSum[i] / cpuFrames; });
    if (coverage?.complete) {
      totals.push(gpuAt);
      if (totals.length > HISTORY) totals.shift();
    }
    const { sim = null, renderScale = 1, canvas = [0, 0], pixelRatio = 1, bytes = 0 } = describe() ?? {};
    readShares(sim);
    const fps = drawN ? drawN / (drawDt / MS_PER_S) : null;
    const sample = {
      phases, passes, totals: [...totals],
      overhead: 0,          // (no syncs: nothing to subtract)
      split: timing.split,  // one pass per dispatch while timed
      wall: rec?.wall ?? null,   // the sampled frame's CPU time, beginFrame to endFrame
      gpu: coverage?.complete ? gpuAt : null,
      measuredGpu: ms ? gpuAt : null,
      coverage,
      cpu: cpuFrames ? cpuSum.reduce((s, x) => s + x, 0) / cpuFrames : null,
      steps: rec?.steps ?? 0,
      fps,
      stepsPerSec: fps != null && workedFrames ? (steps / workedFrames) * fps : null,
      awake: maps.awake,
      drawn: maps.drawn,
      memory: gpu.memory().bytes + canvas[0] * canvas[1] * CANVAS_BYTES + bytes,
      grid: sim?.g ? [sim.g.nx, sim.g.ny, sim.g.nz] : null,
      canvas: [...canvas],
      pixelRatio,
      renderScale,
      gpuName,
    };
    cpuSum.fill(0);
    cpuFrames = workedFrames = drawDt = drawN = steps = 0;
    latest = sample;
    onSample(sample);
  }

  // The last frame's time is known once the next one starts.
  function recordFrame(ms) {
    pending = false;
    const slot = (ring.head + ring.count) % FRAMES;
    if (ring.count < FRAMES) ring.count++;
    else ring.head = (ring.head + 1) % FRAMES;
    ring.ms[slot] = ms;
    ring.work[slot] = pendWork;
    ring.phases.set(pendPhases, slot * PHASES.length);
    onFrame?.(ring);
  }

  return {
    get on() { return on; },
    /** Always false: no frame is measured with syncs any more (kept for callers that ask). */
    get measuring() { return false; },
    /** The last sample (for the console and tools). */
    get last() { return latest; },
    /** The recent frames' times (see the ring above). */
    get ring() { return ring; },

    enable(v) {
      v = Boolean(v);
      if (v === on) return;
      on = v;
      timing.enabled = on;
      timing.split = on;
      hook.watch = on ? watch : null;
      frames.clear();
      if (on) {
        if (!gpuName) {
          const i = gpu.adapterInfo ?? {};
          gpuName = [i.vendor, i.architecture, i.description && `(${i.description})`].filter(Boolean).join(' ') || 'unknown GPU';
          if (i.isFallbackAdapter) gpuName += ', software';
          if (!timing.supported) gpuName += '; no timestamp-query: GPU times unavailable';
        }
        cpuSum.fill(0);
        cpuFrames = workedFrames = drawDt = drawN = steps = 0;
        totals.length = 0;
        latest = null;
        lastSample = -Infinity;
        sampledFrame = -1;
        prevWorked = idle = false;
        lastWorked = performance.now();
        maps = { awake: null, drawn: null };
        ring.head = ring.count = 0;
        pending = false;
      }
    },

    /** Start of a frame that is due (now: its rAF timestamp, ms). */
    beginFrame(now) {
      if (!on) return;
      if (pending) recordFrame(now - frameNow);
      frameNow = now;
      frameStart = performance.now();
      cpuFrame.fill(0);
      passesAtBegin = passCount();
      cur = OTHER;
      mark = frameStart;
    },

    /** The frame moves on to phase `id` (see PHASES). */
    phase(id) {
      if (!on) return;
      const t = performance.now();
      cpuFrame[cur] += t - mark;
      mark = t;
      cur = PHASE_INDEX[id] ?? OTHER;
    },

    /** Kept for the old pass hooks (sim.onPass, post.onPass): gpu.timing times passes now. */
    pass() {},

    /** End of the frame; frameSteps: the V1 steps it ran (under V2, its ticks × LEGACY_STEPS_PER_TICK: app.js legacyStepped). */
    endFrame(frameSteps) {
      if (!on) return;
      const t = performance.now();
      cpuFrame[cur] += t - mark;
      pendWork = t - frameStart;
      pendPhases.set(cpuFrame);
      pending = true;
      const worked = passCount() > passesAtBegin;
      if (worked) {
        lastWorked = frameNow;
        idle = false;
        workedFrames++;
        steps += frameSteps;
        // the drawing rate counts only intervals between two frames that drew
        if (prevWorked) { drawDt += frameNow - prevNow; drawN++; }
        for (let i = 0; i < PHASES.length; i++) cpuSum[i] += cpuFrame[i];
        cpuFrames++;
        // the gpu frame this tick ended (app.js calls gpu.endFrame before this)
        const rec = frames.get(gpu.frameNo);
        if (rec) { rec.wall = t - frameStart; rec.steps = frameSteps; }
      }
      if (frameNow - lastSample >= SAMPLE_INTERVAL_MS && cpuFrames) {
        if (!timing.supported) {
          lastSample = frameNow;
          makeSample(null, null);
        } else if (timing.lastFrame > sampledFrame && frames.has(timing.lastFrame)) {
          lastSample = frameNow;
          sampledFrame = timing.lastFrame;
          makeSample(sampledFrame, timing.last);
        }
      }
      if (!worked && !idle && frameNow - lastWorked > IDLE_AFTER_MS) { idle = true; onSample(null); }
      prevWorked = worked;
      prevNow = frameNow;
    },
  };
}
