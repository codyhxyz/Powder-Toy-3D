import * as THREE from 'three';
import { BRICK } from '../shaders/common.js';

// In-app GPU/CPU profiler (Settings → Developer; the overlay is ui/profiler.js).
//
// Off, it costs a property test per instrumented point: the pass hooks
// (sim.onPass, post.onPass) are null and phase() returns at once. No GL
// queries, syncs, readbacks, allocations or DOM writes.
//
// On, every frame times its phases on the CPU (performance.now() between the
// phase marks the frame loop sets; no GPU syncs). Every SAMPLE_INTERVAL_MS one
// frame that runs anyway is *measured*: after each pass the CPU waits for the
// GPU by reading one texel of the target that pass wrote, so the time from
// issuing the pass to the read returning is the pass's GPU time plus the read's
// own cost, which is calibrated at the start of that frame and subtracted. The
// other frames stay unsynced and keep their speed. A still scene renders nothing
// (gfx/pacing.js): the profiler doesn't wake it, it reports idle.
//
// Pitfalls on Apple GPUs (Chrome → ANGLE's Metal backend), measured 2026-10-08:
//   - EXT_disjoint_timer_query_webgl2 is exposed but misreads by about 3× either
//     way, so it isn't used.
//   - A read waits only for pending work on what it reads: a read of the canvas
//     doesn't wait for offscreen passes, a read of an untouched target returns at
//     once, and gl.finish() doesn't wait at all. So each pass syncs on its own
//     target, and the calibration (and a pass into the canvas) clears and reads a
//     1×1 target of our own.
//   - Looping one pass into one target to time it reads ~0 ms (the tile-based GPU
//     merges the draws and shades only the last), and a pass into the texture it
//     samples is dropped. Measuring the real frame's passes avoids both.
//   - performance.now() ticks in 0.1 ms steps here (no cross-origin isolation):
//     in any one frame a small pass reads as 0 or 0.1 ms.

const SAMPLE_INTERVAL_MS = 1000;   // between measured frames
const SAMPLE_MIN_FRAMES = 10;      // …and at least this many unmeasured frames between them (slow frame rates)
const CAL_SYNCS = 5;               // syncs timed per measured frame to calibrate a sync's own cost (median)
const IDLE_AFTER_MS = 500;         // without GPU work before the overlay says idle
export const HISTORY = 40;         // recent measured frames' GPU totals kept for the spike strip
const QUIET_MIN = 127;             // quiet-map texel above this: the brick is skipped (the map holds 0 or 255)
const UNNAMED = '(unnamed)';       // label of a pass whose material has no name
const MS_PER_S = 1000;

// Frame phases in display order; a pass belongs to the phase marked last (app.js frame()).
export const PHASES = [
  { id: 'paint', label: 'Paint' },       // the brush
  { id: 'sim', label: 'Sim' },           // the steps: activity scan (inert, quiet), moveBlock, moveGather, react
  { id: 'derived', label: 'Derived' },   // render fields, bricks, empty-space distance, glow volume
  { id: 'shadow', label: 'Shadow' },     // the sun's shadow map
  { id: 'gi', label: 'GI' },             // GI probes
  { id: 'view', label: 'View' },         // the raymarch (post's scene pass)
  { id: 'post', label: 'Post' },         // TAA or TAAU, bloom, tone-mapped composite
  { id: 'other', label: 'Other' },       // picking, signs, multiplayer, first-person probes, frame-loop upkeep
];
const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));
const OTHER = PHASE_INDEX.other;

// GPU memory estimate: bytes per channel by texture type, channels by format.
const TYPE_BYTES = { [THREE.FloatType]: 4, [THREE.HalfFloatType]: 2, [THREE.UnsignedByteType]: 1 };
const FORMAT_CHANNELS = { [THREE.RGBAFormat]: 4, [THREE.RGFormat]: 2, [THREE.RedFormat]: 1 };
const RGBA = 4;
const DEPTH_BYTES = 4;    // per pixel of a depth buffer: 24-bit depth padded to 32, or a float depth texture
const CANVAS_BYTES = 4;   // per drawing-buffer pixel: RGBA8, no depth, no MSAA (see app.js)

function targetBytes(t) {
  const px = t.width * t.height;
  let bytes = t.depthBuffer ? px * DEPTH_BYTES : 0;
  // (other formats count as RGBA, other types as 32-bit)
  for (const tex of t.textures) bytes += px * (FORMAT_CHANNELS[tex.format] ?? RGBA) * (TYPE_BYTES[tex.type] ?? TYPE_BYTES[THREE.FloatType]);
  return bytes;
}

// Render targets reachable from `roots`: targets, arrays of them, and the ones an
// owner object (e.g. the Simulation) holds in its own properties.
function collectTargets(roots) {
  const found = new Set();
  const take = (v) => {
    if (v?.isWebGLRenderTarget) found.add(v);
    else if (Array.isArray(v)) v.forEach(take);
  };
  for (const r of roots) {
    if (r?.isWebGLRenderTarget || Array.isArray(r)) take(r);
    else if (r) Object.values(r).forEach(take);
  }
  return found;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ describe: () => { sim, targets: any[], renderScale: number },
 *           onSample: (sample: object | null) => void }} opts
 *   describe: called once per measured frame for what the report shows besides
 *   timings (targets: render targets, arrays or owners, for the memory estimate);
 *   onSample: gets each measured frame's sample, or null when rendering went idle.
 */
export function createProfiler(renderer, { describe, onSample }) {
  const gl = renderer.getContext();
  const f32 = new Float32Array(RGBA), f16 = new Uint16Array(RGBA), u8 = new Uint8Array(RGBA);
  const readBuf = (t) => (t.texture.type === THREE.FloatType ? f32 : t.texture.type === THREE.HalfFloatType ? f16 : u8);
  const calTimes = new Float64Array(CAL_SYNCS);
  const cpuFrame = new Float64Array(PHASES.length);   // ms per phase, this frame
  const cpuSum = new Float64Array(PHASES.length);     // …summed over this window's unmeasured frames
  const drawSize = new THREE.Vector2();
  const totals = [];
  let latest = null;           // the last sample
  let quietBuf = new Uint8Array(0);
  let gpuName = '';
  let cal = null;              // 1×1 target: calibration, and syncing a pass into the canvas
  let on = false, measuring = false;
  let mark = 0, cur = OTHER;   // time of the last phase mark, and the phase since then
  let passCount = 0;           // passes issued this frame
  let overhead = 0;            // ms: one sync's own cost, calibrated per measured frame
  let gpuAt = 0;               // ms: where the next pass starts on the measured frame's GPU timeline
  let passes = [];             // the measured frame's passes: { phase, name, start, gpu }
  let frameNow = 0, frameStart = 0, prevNow = 0, prevWorked = false;
  let lastSample = -Infinity, lastWorked = 0, idle = false;
  let cpuFrames = 0, workedFrames = 0, drawDt = 0, drawN = 0, steps = 0;   // this window

  // Wait for the GPU: clear our 1×1 target and read it back.
  function syncCal() {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(cal);
    renderer.clear();
    renderer.readRenderTargetPixels(cal, 0, 0, 1, 1, u8);
    renderer.setRenderTarget(prev);
  }

  function startMeasuring() {
    measuring = true;
    passes = [];
    gpuAt = 0;
    syncCal();   // the previous frame's work must not count toward this frame's first pass
    for (let i = 0; i < CAL_SYNCS; i++) {
      const t = performance.now();
      syncCal();
      calTimes[i] = performance.now() - t;
    }
    overhead = Float64Array.from(calTimes).sort()[CAL_SYNCS >> 1];
  }

  // Share of bricks the sim steps, from the quiet map (shaders/activity.js).
  function awakeShare(sim) {
    const t = sim.actQuiet, n = t.width * t.height * RGBA;
    if (quietBuf.length < n) quietBuf = new Uint8Array(n);
    renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, quietBuf);
    let quiet = 0;
    for (let i = 0; i < n; i += RGBA) if (quietBuf[i] > QUIET_MIN) quiet++;
    const { nx, ny, nz } = sim.g;
    return 1 - quiet / ((nx / BRICK) * (ny / BRICK) * (nz / BRICK));
  }

  function finishMeasuring(frameSteps) {
    measuring = false;
    lastSample = frameNow;
    if (!passes.length) return;   // nothing ran after all: try again next interval
    const phases = PHASES.map((p) => ({ ...p, gpu: 0, cpu: cpuFrames ? 0 : null, segs: [], detail: [] }));
    let prev = -1;
    for (const ps of passes) {
      const ph = phases[ps.phase];
      ph.gpu += ps.gpu;
      // contiguous passes of one phase draw as one bar
      if (ps.phase === prev) ph.segs[ph.segs.length - 1][1] = ps.start + ps.gpu;
      else ph.segs.push([ps.start, ps.start + ps.gpu]);
      prev = ps.phase;
      // per pass name: its runs this frame, and where each sat on the timeline
      const seg = [ps.start, ps.start + ps.gpu];
      const d = ph.detail.find((x) => x.name === ps.name);
      if (d) { d.count++; d.gpu += ps.gpu; d.segs.push(seg); } else ph.detail.push({ name: ps.name, count: 1, gpu: ps.gpu, segs: [seg] });
    }
    if (cpuFrames) phases.forEach((ph, i) => { ph.cpu = cpuSum[i] / cpuFrames; });
    totals.push(gpuAt);
    if (totals.length > HISTORY) totals.shift();
    const { sim, targets, renderScale } = describe();
    let memory = renderer.getDrawingBufferSize(drawSize).x * drawSize.y * CANVAS_BYTES;
    for (const t of collectTargets(targets)) memory += targetBytes(t);
    const awake = awakeShare(sim);
    const fps = drawN ? drawN / (drawDt / MS_PER_S) : null;
    const sample = {
      phases, passes, totals: [...totals], overhead,
      wall: performance.now() - frameStart,   // the whole measured frame, syncs and all
      gpu: gpuAt,
      cpu: cpuFrames ? cpuSum.reduce((s, x) => s + x, 0) / cpuFrames : null,
      steps: frameSteps,
      fps,
      stepsPerSec: fps != null && workedFrames ? (steps / workedFrames) * fps : null,
      awake,
      memory,
      grid: [sim.g.nx, sim.g.ny, sim.g.nz],
      canvas: [drawSize.x, drawSize.y],
      pixelRatio: renderer.getPixelRatio(),
      renderScale,
      gpuName,
    };
    cpuSum.fill(0);
    cpuFrames = workedFrames = drawDt = drawN = steps = 0;
    latest = sample;
    onSample(sample);
  }

  return {
    get on() { return on; },
    /** True during a measured frame (the pass hooks sync then). */
    get measuring() { return measuring; },
    /** The last sample (for the console and tools). */
    get last() { return latest; },

    enable(v) {
      if (v === on) return;
      on = v;
      measuring = false;
      if (on) {
        cal = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
        if (!gpuName) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          gpuName = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        }
        cpuSum.fill(0);
        cpuFrames = workedFrames = drawDt = drawN = steps = 0;
        totals.length = 0;
        latest = null;
        lastSample = -Infinity;
        prevWorked = idle = false;
        lastWorked = performance.now();
      } else {
        cal.dispose();
        cal = null;
        quietBuf = new Uint8Array(0);
      }
    },

    /** Start of a frame that is due (now: its rAF timestamp, ms). */
    beginFrame(now) {
      if (!on) return;
      frameNow = now;
      frameStart = performance.now();
      cpuFrame.fill(0);
      passCount = 0;
      cur = OTHER;
      measuring = false;   // (in case the last frame threw before it ended)
      // only right after a frame that drew: measuring syncs, and an idle scene must stay idle
      if (prevWorked && now - lastSample >= SAMPLE_INTERVAL_MS && cpuFrames >= SAMPLE_MIN_FRAMES) startMeasuring();
      mark = performance.now();
    },

    /** The frame moves on to phase `id` (see PHASES). */
    phase(id) {
      if (!on) return;
      const t = performance.now();
      cpuFrame[cur] += t - mark;
      mark = t;
      cur = PHASE_INDEX[id];
    },

    /** A pass was just issued into `target` (null: the canvas). */
    pass(name, target) {
      passCount++;
      if (!measuring) return;
      const t = performance.now();
      if (target) renderer.readRenderTargetPixels(target, 0, 0, 1, 1, readBuf(target));
      else syncCal();
      const gpu = Math.max(0, performance.now() - t - overhead);
      passes.push({ phase: cur, name: name || UNNAMED, start: gpuAt, gpu });
      gpuAt += gpu;
    },

    /** End of the frame; frameSteps: sim steps it ran. */
    endFrame(frameSteps) {
      if (!on) return;
      cpuFrame[cur] += performance.now() - mark;
      const worked = passCount > 0;
      if (worked) {
        lastWorked = frameNow;
        idle = false;
        workedFrames++;
        steps += frameSteps;
        // the drawing rate counts only intervals between two frames that drew
        if (prevWorked) { drawDt += frameNow - prevNow; drawN++; }
      }
      // a measured frame's CPU times include its syncs: only unmeasured frames count
      if (measuring) finishMeasuring(frameSteps);
      else if (worked) {
        for (let i = 0; i < PHASES.length; i++) cpuSum[i] += cpuFrame[i];
        cpuFrames++;
      }
      if (!worked && !idle && frameNow - lastWorked > IDLE_AFTER_MS) { idle = true; onSample(null); }
      prevWorked = worked;
      prevNow = frameNow;
    },
  };
}
