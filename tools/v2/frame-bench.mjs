// Renderer-connected, serialized frame latency (NOT a bandwidth estimate or live-loop FPS).
// node tools/v2/frame-bench.mjs --frames 60 --warmup 12 --out /tmp/frame-bench.json
// node tools/v2/frame-bench.mjs --self-check   # CPU only; no server/browser
// --split adds a SEPARATE diagnostic replay; headline samples always keep passes unsplit.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HELP = `Usage: node tools/v2/frame-bench.mjs [options]
  --frames N       measured frames per case (default 60)
  --warmup N       simulated warmup frames per case (default 12)
  --engine v2|v1|both (default v2; v1 needs --url: an app served from a checkout of the v1-oracle tag)
  --v2-path direct (V2's renderers read its cells; the compatibility render went with V1)
  --scene all|sand|water|settled (default all)
  --view realistic|plain (default realistic; plain is an explicit blocks-renderer diagnostic)
  --port N         private strict-port Vite server (otherwise OS-assigned)
  --url URL        existing app URL instead of starting Vite
  --out FILE       raw JSON report (otherwise stdout)
  --seed N         unsigned 32-bit fixture seed (default 12345)
  --split          also replay fresh cases with split GPU passes (diagnostic only)
  --split-only     diagnostic replay only; reuse an existing unsplit reference
  --trace-startup  record native pipeline creation before app readiness
  --self-check     CPU statistics/arguments/fixtures checks; no GPU
Fixed: 128³ box, 1280×720 viewport, DPR 1, Quality upscale, autoRes OFF.
One frame: v1 test.step(4) / v2 test.step(1), then renderOnce + GPU fence.
Non-parity: v2 is missing physics; no equivalent-work speedup claim until the full suite passes.`;

export function parseArgs(argv) {
  const o = { frames: 60, warmup: 12, engine: 'v2', 'v2-path': 'direct', scene: 'all', view: 'realistic', seed: 12345,
    port: null, url: null, out: null, split: false, splitOnly: false, traceStartup: false, selfCheck: false, help: false };
  const flags = { '--split': 'split', '--split-only': 'splitOnly', '--trace-startup': 'traceStartup', '--self-check': 'selfCheck', '--help': 'help' };
  const values = new Set(['frames', 'warmup', 'engine', 'v2-path', 'scene', 'view', 'seed', 'port', 'url', 'out']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], key = arg.slice(2);
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (flags[arg]) { o[flags[arg]] = true; continue; }
    if (!arg.startsWith('--') || !values.has(key)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    o[key] = ['frames', 'warmup', 'seed', 'port'].includes(key) ? Number(value) : value;
  }
  for (const [key, min, max] of [['frames', 1, 10000], ['warmup', 0, 10000], ['seed', 0, 0xffffffff], ['port', 1024, 65535]]) {
    if (key === 'port' && o.port === null) continue;
    if (!Number.isSafeInteger(o[key]) || o[key] < min || o[key] > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  }
  for (const [key, allowed] of Object.entries({ engine: ['both', 'v1', 'v2'], 'v2-path': ['direct'], scene: ['all', 'sand', 'water', 'settled'], view: ['realistic', 'plain'] })) {
    if (!allowed.includes(o[key])) throw new Error(`${key} must be ${allowed.join('|')}`);
  }
  if ([5173, 8787].includes(o.port)) throw new Error('Use a private port, not 5173 or 8787');
  if (o.engine !== 'v2' && !o.url) throw new Error('--engine v1 needs --url: V1 is the v1-oracle tag, served from a checkout of it');
  if (o.split && o.splitOnly) throw new Error('--split and --split-only are mutually exclusive');
  if (o.url) {
    if (!['http:', 'https:'].includes(new URL(o.url).protocol)) throw new Error('url must be HTTP(S)');
    if (o.port !== null) throw new Error('--url and --port are mutually exclusive');
  }
  return o;
}

const passModes = o => o.splitOnly ? [true] : o.split ? [false, true] : [false];

// Nearest-rank percentiles; no rounding or silent deletion of invalid samples.
export function stats(values) {
  if (!values.length) return { n: 0, min: null, p50: null, p95: null, max: null, mean: null };
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid timing sample');
  const s = [...values].sort((a, b) => a - b);
  const at = q => s[Math.ceil(q * s.length) - 1];
  return { n: s.length, min: s[0], p50: at(0.5), p95: at(0.95), max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

export function qualityKey(s) {
  // Compare the precision consumed by GPU uniforms, not OrbitControls' CPU
  // reconstruction noise (e.g. 13 versus 13.000000000000002).
  const f32 = values => values.map(value => {
    const n = Math.fround(value);
    if (!Number.isFinite(n)) throw new Error('Invalid benchmark camera');
    return n;
  });
  return JSON.stringify({ viewport:s.viewport,canvas:s.canvas,dpr:s.dpr,grid:s.grid,
    renderScale:s.renderScale,autoRes:s.autoRes,
    camera:{position:f32(s.camera.position),quaternion:f32(s.camera.quaternion),projection:f32(s.camera.projection)},
    gfx:s.gfx,upscale:s.app.upscale,nearGI:s.app.nearGI,glowLights:s.app.glowLights,
    caustics:s.app.caustics,taa:s.post.taa,bloom:s.post.bloom,view:s.app.view });
}

// Observe without replacing a native promise or changing a synchronous return.
export function tracePipelines(Device, note) {
  const restore = [];
  if (!Device) return () => {};
  for (const method of ['createComputePipeline', 'createComputePipelineAsync', 'createRenderPipeline', 'createRenderPipelineAsync']) {
    const original = Device.prototype[method];
    if (!original) continue;
    Device.prototype[method] = function(desc) {
      const label = desc.label;
      note({ method, label, stage: 'start' });
      try {
        const value = original.call(this, desc);
        if (value?.then) value.then(() => note({ method, label, stage: 'ready' }),
          error => note({ method, label, stage: 'failed', error: String(error) }));
        else note({ method, label, stage: 'ready' });
        return value;
      } catch (error) { note({ method, label, stage: 'failed', error: String(error) }); throw error; }
    };
    restore.push(() => { Device.prototype[method] = original; });
  }
  return () => restore.forEach(fn => fn());
}

export function assertNoPipelineActivity(activity, stats, baseline) {
  if (activity !== 0 || stats.pipelinesPending !== 0 ||
      !Number.isSafeInteger(stats.pipelinesCreated) || stats.pipelinesCreated !== baseline)
    throw new Error(`Pipeline compilation during measurement; the entire case is invalid (activity=${activity}, pending=${stats.pipelinesPending}, created=${stats.pipelinesCreated}, baseline=${baseline})`);
}

// Observation only: no simulation, presentation, import, export or GPU read.
// These clocks are necessary comparison evidence, not authoritative-state proof.
export function frameSnapshot(a, engine) {
  if (engine !== 'v1' && engine !== 'v2') throw new Error('Invalid benchmark snapshot engine');
  const native = a.physics.v2;
  if (engine === 'v2' && !native) throw new Error('Missing native engine for benchmark snapshot');
  const result = {
    simFrame: a.sim.frame, v2Tick: native?.tick ?? null,
    asleep: engine === 'v2' ? native.asleep : null,
    certified: engine === 'v2' ? native.certified : a.sim.idleCertified,
    dayClock: a.day.clock, viewTime: a.view.time, renderFrame: a.view.frame,
    parked: a.test.parked,
    physicsSettings: {
      gravityMode: a.settings.gravityMode, airMode: a.settings.airMode,
      ambientHeat: a.settings.ambientHeat, edgeMode: a.settings.edgeMode,
      gravity: a.sim.gravity, steps: a.settings.steps,
    },
  };
  if (result.parked !== true) throw new Error('Benchmark clock snapshot requires a parked page');
  if (typeof result.certified !== 'boolean' || (engine === 'v2' && typeof result.asleep !== 'boolean'))
    throw new Error('Missing benchmark rest state');
  for (const key of ['simFrame', 'renderFrame']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Invalid benchmark clock: ${key}`);
  }
  if ((engine === 'v2' || result.v2Tick !== null) &&
      (!Number.isSafeInteger(result.v2Tick) || result.v2Tick < 0)) throw new Error('Invalid benchmark clock: v2Tick');
  for (const key of ['dayClock', 'viewTime']) {
    if (!Number.isFinite(result[key])) throw new Error(`Invalid benchmark clock: ${key}`);
  }
  // Mirror simModes.js; the CPU check enumerates its canonical values.
  for (const [key, max] of [['gravityMode', 2], ['airMode', 4], ['edgeMode', 2]]) {
    const value = result.physicsSettings[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid enum physics setting: ${key}`);
  }
  if (typeof result.physicsSettings.ambientHeat !== 'boolean') throw new Error('Invalid boolean physics setting: ambientHeat');
  for (const key of ['gravity', 'steps']) {
    if (!Number.isFinite(result.physicsSettings[key])) throw new Error(`Invalid numeric physics setting: ${key}`);
  }
  return result;
}

// Read the persistence boundary without captureState()'s possible legacy import.
// Hash every authoritative buffer, not a projection or a mass summary.
export async function nativeStateEvidence(a) {
  const n = a.physics.v2;
  if (!a.test.parked || !n || n.importFull || n.importMarked ||
      n.seenVersion !== a.sim.version || n.seenWhole !== (a.sim.wholeWrites ?? 0))
    throw new Error('Native checkpoint requires parked, synchronized ownership');
  const fingerprint = async value => {
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return { bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') };
    }
    if (Array.isArray(value)) return Promise.all(value.map(fingerprint));
    if (value && typeof value === 'object') {
      const entries = await Promise.all(Object.keys(value).sort().map(async key => [key, await fingerprint(value[key])]));
      return Object.fromEntries(entries);
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
    throw new Error('Unsupported native checkpoint value');
  };
  const metadata = { tick: n.tick, acc: n.acc, frame: a.sim.frame, paints: a.sim.paints,
    certified: n.certified, writtenSinceTick: n.writtenSinceTick };
  // Queue all copies before awaiting, as the existing persistence methods do.
  const buffers = ['cells', 'act', 'args', 'aux'].filter(key => n[key]);
  const reads = buffers.map(async key => [key, new Uint8Array(await a.gpu.readback.buffer(n[key], 0, n[key].size))]);
  const dynamic = n.dynamics?.snapshotDynamicState();
  const [entries, dynamics] = await Promise.all([Promise.all(reads), dynamic]);
  return fingerprint({ metadata, buffers: Object.fromEntries(entries), dynamics: dynamics ?? null });
}

// Self-contained CPU builder, installed unchanged in the page. No GPU settling,
// random browser state, heat sources, or per-engine scene generation differences.
// The settled case is inert architecture, NOT pre-settled sand/water.
export function buildFixture(sim, E, seedMax, scene, seed) {
  const { g } = sim;
  if (g.nx !== 128 || g.ny !== 128 || g.nz !== 128) throw new Error('Fixture requires the default 128³ box');
  const A = new Float32Array(g.width * g.height * 4), B = new Float32Array(A.length);
  let rng = seed >>> 0;
  const counts = {};
  for (let i = 1; i < A.length; i += 4) A[i] = 20;
  for (let y = 0; y < 128; y++) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) {
    let id = E.EMPTY;
    // A basin keeps material in view; offset pillars give shadows/GI real geometry.
    if (y < 3 || ((x < 3 || x >= 125 || z < 3 || z >= 125) && y < 18)) id = E.WALL;
    if (x >= 48 && x < 58 && z >= 52 && z < 76 && y < 36) id = E.ROCK;
    if (scene === 'settled') {
      if (x >= 18 && x < 40 && z >= 20 && z < 108 && y < 28) id = E.ROCK;
      if (x >= 82 && x < 106 && z >= 28 && z < 96 && y < 52) id = E.WALL;
    } else if (x >= 20 && x < 108 && z >= 20 && z < 108 && y >= 72 && y < 104) {
      id = scene === 'sand' ? E.SAND : E.WATER;
    }
    const i = sim.cellTexel(x, y, z) * 4;
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    A[i] = id;
    A[i + 3] = rng / 4294967296 * seedMax;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  // Bitwise digest of the full A state, including cell seeds and temperature.
  // B is identically zero. This is an identity check, not a cryptographic hash.
  let hash = 2166136261;
  for (const word of new Uint32Array(A.buffer)) hash = Math.imul(hash ^ word, 16777619) >>> 0;
  return { A, B, meta: { scene, seed, counts, hash: hash.toString(16).padStart(8, '0'), temperatureC: 20, bytes: A.byteLength + B.byteLength } };
}

async function selfCheck() {
  const { default: assert } = await import('node:assert/strict');
  assert.deepEqual(stats([]), { n: 0, min: null, p50: null, p95: null, max: null, mean: null });
  assert.deepEqual(stats([4, 1, 3, 2]), { n: 4, min: 1, p50: 2, p95: 4, max: 4, mean: 2.5 });
  assert.equal(stats(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
  assert.throws(() => stats([NaN])); assert.throws(() => stats([-1]));
  assert.equal(parseArgs([]).view, 'realistic');
  assert.equal(parseArgs(['--warmup', '0', '--seed', '0', '--split']).split, true);
  assert.deepEqual(passModes(parseArgs([])), [false]);
  assert.deepEqual(passModes(parseArgs(['--split'])), [false, true]);
  assert.deepEqual(passModes(parseArgs(['--split-only'])), [true], 'diagnostic-only never creates headline samples');
  for (const argv of [['--frames', '0'], ['--warmup', '-1'], ['--frames', '1.5'], ['--seed', '4294967296'],
    ['--engine', 'v3'], ['--v2-path', 'unknown'], ['--view', 'cheap'], ['--port', '5173'], ['--url', 'file:///tmp/a'],
    ['--url', 'http://localhost', '--port', '43199'], ['--out'], ['--oops'], ['--split', '--split'],
    ['--split', '--split-only']]) assert.throws(() => parseArgs(argv));
  const { gridLayout, cellTexel } = await import('../../src/sim.js');
  const { E } = await import('../../src/elements.js');
  const { SEED_MAX } = await import('../../src/shaders/common.js');
  const g = gridLayout(128, 128, 128), sim = { g, cellTexel: (x, y, z) => cellTexel(g, x, y, z) };
  const make = (scene, seed) => buildFixture(sim, E, SEED_MAX, scene, seed).meta;
  const sand = make('sand', 12345);
  assert.deepEqual(make('sand', 12345), sand);
  assert.notEqual(make('sand', 12346).hash, sand.hash);
  const water = make('water', 12345), settled = make('settled', 12345);
  assert.equal(sand.counts[E.SAND], 88 * 88 * 32);
  assert.equal(water.counts[E.WATER], sand.counts[E.SAND]);
  assert.equal(settled.counts[E.WATER] ?? 0, 0); assert.equal(settled.counts[E.SAND] ?? 0, 0);
  assert.equal(Object.values(sand.counts).reduce((a, b) => a + b, 0), 128 ** 3);
  const quality={camera:{position:[1,2,13],quaternion:[0,0,0,1],projection:[1,0,0,1]},
    app:{upscale:'quality'},post:{taa:true},renderScale:2/3};
  const noise=structuredClone(quality);noise.camera.position[2]=13.000000000000002;
  assert.equal(qualityKey(quality),qualityKey(noise));
  noise.camera.position[2]=13.001;
  assert.notEqual(qualityKey(quality),qualityKey(noise));
  const lower=structuredClone(quality);lower.renderScale=0.5;
  assert.notEqual(qualityKey(quality),qualityKey(lower));
  const invalid=structuredClone(quality);invalid.camera.position[0]=Infinity;
  assert.throws(()=>qualityKey(invalid),/Invalid benchmark camera/);
  const events = [], promise = Promise.resolve({});
  class Device { createComputePipelineAsync() { return promise; } createRenderPipeline() { return 7; } }
  const original = Device.prototype.createComputePipelineAsync;
  const restore = tracePipelines(Device, event => events.push(event));
  const device = new Device();
  assert.equal(device.createComputePipelineAsync({ label: 'compute' }), promise);
  assert.equal(device.createRenderPipeline({ label: 'render' }), 7);
  await promise; await Promise.resolve();
  assert.equal(events.filter(e => e.stage === 'ready').length, 2);
  restore(); assert.equal(Device.prototype.createComputePipelineAsync, original);
  const quiet = { pipelinesPending: 0, pipelinesCreated: 10 };
  assertNoPipelineActivity(0, quiet, 10);
  assert.throws(() => assertNoPipelineActivity(1, quiet, 10), /entire case is invalid/);
  assert.throws(() => assertNoPipelineActivity(0, { ...quiet, pipelinesPending: 1 }, 10));
  assert.throws(() => assertNoPipelineActivity(0, { ...quiet, pipelinesCreated: 11 }, 10));
  const { GRAV, AIR, EDGE, SIM_MODE_DEFAULTS } = await import('../../src/simModes.js');
  const observed = {
    sim: { frame: 12, gravity: 1, idleCertified: false, step() { throw new Error('Observation must not step'); } },
    physics: { v2: { tick: 3, asleep: false, certified: false } },
    day: { clock: 9 }, view: { time: 0, frame: 4 },
    test: { parked: true, renderOnce() { throw new Error('Observation must not render'); } },
    settings: { ...SIM_MODE_DEFAULTS, steps: 4 },
  };
  const unchanged = JSON.stringify(observed);
  const clock = frameSnapshot(observed, 'v2');
  assert.equal(clock.dayClock, 9); assert.equal(clock.viewTime, 0); assert.equal(clock.renderFrame, 4);
  assert.equal(clock.simFrame, 12); assert.equal(clock.v2Tick, 3); assert.equal(clock.parked, true);
  assert.equal(JSON.stringify(observed), unchanged, 'snapshot does not mutate the app');
  const { runInNewContext } = await import('node:vm');
  assert.equal(JSON.stringify(runInNewContext(`(${frameSnapshot.toString()})`)(observed, 'v2')), JSON.stringify(clock),
    'browser-installed function is self-contained');
  clock.physicsSettings.gravity = 99;
  assert.equal(observed.sim.gravity, 1, 'snapshot does not retain mutable input objects');
  assert.notEqual(frameSnapshot({ ...observed, day: { clock: 10 } }, 'v2').dayClock, clock.dayClock);
  assert.throws(() => frameSnapshot({ ...observed, test: { parked: false } }, 'v2'), /parked/);
  assert.throws(() => frameSnapshot({ ...observed, view: { time: NaN, frame: 4 } }, 'v2'), /viewTime/);
  assert.throws(() => frameSnapshot({ ...observed, view: { time: 0, frame: 1.5 } }, 'v2'), /renderFrame/);
  assert.throws(() => frameSnapshot({ ...observed, physics: { v2: { tick: null, asleep: false, certified: false } } }, 'v2'), /v2Tick/);
  assert.throws(() => frameSnapshot({ ...observed, physics: { v2: null } }, 'v2'), /Missing native engine/);
  assert.throws(() => frameSnapshot(observed, 'v3'), /snapshot engine/);
  assert.throws(() => frameSnapshot({ ...observed, settings: {} }, 'v2'), /physics setting/);
  assert.throws(() => frameSnapshot({ ...observed, sim: { ...observed.sim, gravity: '1' } }, 'v2'), /numeric physics setting/);
  for (const [key, modes] of [['gravityMode', GRAV], ['airMode', AIR], ['edgeMode', EDGE]]) {
    const valid = Object.values(modes);
    for (let value = -1; value <= Math.max(...valid) + 1; value++) {
      const app = { ...observed, settings: { ...observed.settings, [key]: value } };
      if (valid.includes(value)) assert.equal(frameSnapshot(app, 'v2').physicsSettings[key], value);
      else assert.throws(() => frameSnapshot(app, 'v2'), /physics setting/);
    }
    for (const value of ['0', 'vertical', true, false, 0.5, NaN, Infinity, null, undefined, [], {}]) {
      assert.throws(() => frameSnapshot({ ...observed, settings: { ...observed.settings, [key]: value } }, 'v2'),
        /physics setting/, `${key} rejects ${String(value)}`);
    }
  }
  for (const value of [true, false]) {
    assert.equal(frameSnapshot({ ...observed, settings: { ...observed.settings, ambientHeat: value } }, 'v2')
      .physicsSettings.ambientHeat, value);
  }
  for (const value of [0, 1, 'false', null, undefined, NaN, [], {}]) {
    assert.throws(() => frameSnapshot({ ...observed, settings: { ...observed.settings, ambientHeat: value } }, 'v2'),
      /physics setting/, `ambientHeat rejects ${String(value)}`);
  }
  assert.equal(frameSnapshot({ ...observed, physics: { v2: null } }, 'v1').v2Tick, null);
  const raw = new Uint32Array([1, 2, 3, 4]);
  const checkpoint = { test: { parked: true }, sim: { version: 1, wholeWrites: 0, frame: 3, paints: 0 },
    physics: { v2: { seenVersion: 1, seenWhole: 0, tick: 3, acc: 0, certified: false, writtenSinceTick: false,
      cells: { size: raw.byteLength }, dynamics: { snapshotDynamicState: async () => ({ particles: raw, sequence: 3 }) } } },
    gpu: { readback: { buffer: async () => raw.slice().buffer } } };
  const evidence = await nativeStateEvidence(checkpoint);
  assert.equal(evidence.buffers.cells.bytes, raw.byteLength);
  assert.equal(evidence.buffers.cells.sha256, createHash('sha256').update(new Uint8Array(raw.buffer)).digest('hex'));
  assert.equal(evidence.buffers.cells.sha256, evidence.dynamics.particles.sha256);
  raw[3] = 5;
  assert.notEqual((await nativeStateEvidence(checkpoint)).buffers.cells.sha256, evidence.buffers.cells.sha256);
  await assert.rejects(nativeStateEvidence({ ...checkpoint, sim: { ...checkpoint.sim, version: 2 } }), /synchronized/);
  console.log('ok: statistics, CLI validation, deterministic full-size CPU fixtures, GPU-f32 quality, read-only clock snapshots');
}

async function run(o) {
  const runStarted = performance.now();
  const { launchBrowser, newTestPage, ready, gpuInfo } = await import('../browser.mjs');
  const { startVite } = await import('../vite-server.mjs');
  let commit = null, gitStatus = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  } catch { /* URL-only runs need not have Git */ }
  const toolHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const report = { schema: 1, complete: false, createdAt: new Date().toISOString(), toolCommit: commit, gitStatus, toolHash, options: o,
    parity: 'V1 (--engine v1) is the v1-oracle tag\'s app at --url; V2 is this checkout\'s.',
    methodology: [
      'Serialized frame latency, not live-loop FPS: parked app; v1 step(4) or v2 step(1), renderOnce(), gpu.fence().',
      'Wall clock covers CPU recording, submissions, physics, bridge, renderer derived/shadows/GI/volume/meshes/post, and GPU completion; no bandwidth estimate.',
      'Unsplit timestamp instrumentation is enabled for headline samples. GPU pass sums are NOT elapsed GPU frame time: intervals can overlap. Copies/gaps are excluded. Wall time is the headline metric.',
      'Timing readback settling and explicit awake-count readbacks are outside wall samples. Native asynchronous simulation bookkeeping remains inside.',
      'Warmup advances the fixture. Each engine/scene/diagnostic starts in a fresh page from identical CPU arrays and seed; evolved states are NOT identical.',
      'Fixed camera and frozen render-only animation clocks; forced draws even when idle. Settled geometry is not a live idle-loop/power benchmark.',
      'Camera equality uses GPU f32 precision; raw CPU camera values remain recorded. Render-quality settings are compared unchanged.',
      'Memory is the app GPU resource registry, not total VRAM; excludes unregistered driver/three/timestamp scratch resources. JS heap is optional Chromium telemetry.',
      'toolCommit identifies this checkout, not necessarily the build served by --url.',
      'Vite transforms the menu and its dynamically imported app on CPU before GPU acquisition; native shader compilation remains inside the slot.',
      'Measured windows reject native pipeline API calls, pending app builds, or app pipeline-count changes; contaminated frames are not silently discarded.',
      'Clock snapshots observe host/native ticks, daylight, view animation, render noise and physics settings without advancing them.',
      'Native warmup/end checkpoints hash full cells, auxiliary banks, activity, arguments and dynamic persistence state outside frame samples, inside the GPU lease. Cross-report equality must be checked.',
      'Progress elapsedRunMs includes CPU preparation and is not verified GPU lease occupancy. Stage intervals include diagnostic work excluded from headline frame latency.',
    ], progress: [], results: [], errors: [] };
  let vite, browser;
  const checkpoint = (stage, result = report) => {
    result.stage = stage;
    report.progress.push({ stage, elapsedRunMs: performance.now() - runStarted });
    console.error(`[frame-bench] ${stage}`);
    if (o.out) {
      mkdirSync(dirname(o.out), { recursive: true });
      writeFileSync(o.out, JSON.stringify(report, null, 2) + '\n');
    }
  };
  try {
    checkpoint('CPU import preparation');
    if (!o.url) vite = await startVite({ port: o.port ?? undefined, warmupEntries: ['/src/main.js', '/src/app.js'] });
    checkpoint('GPU acquisition');
    // Both resources are inside this try: a launch failure must still close Vite.
    browser = await launchBrowser();
    report.browserVersion = browser.version();
    const engines = o.engine === 'both' ? ['v1', 'v2'] : [o.engine];
    const cases = engines.flatMap(engine => engine === 'v1' ? [{ engine, compactPath: null }]
      : (o['v2-path'] === 'both' ? ['direct', 'compatibility'] : [o['v2-path']]).map(compactPath => ({ engine, compactPath })));
    const scenes = o.scene === 'all' ? ['sand', 'water', 'settled'] : [o.scene];
    for (const split of passModes(o)) for (const scene of scenes) for (const { engine, compactPath } of cases) {
      const result = { engine, compactPath, scene, diagnosticSplit: split, errors: [], warnings: [], samples: [], measurementPipelines: [] };
      report.results.push(result);
      const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      let rejectFailure;
      const failure = new Promise((_, reject) => { rejectFailure = reject; });
      failure.catch(() => {}); // A page can fail before navigation resolves.
      const checked = promise => Promise.race([promise, failure]);
      page.on('pageerror', e => {
        result.errors.push(`pageerror: ${e.message}`); checkpoint('page failure', result); rejectFailure(e);
      });
      page.on('console', m => {
        if (m.text().startsWith('FRAME_BENCH_MEASURE ')) {
          const event = JSON.parse(m.text().slice('FRAME_BENCH_MEASURE '.length));
          result.measurementPipelines.push(event);
          console.error('Measurement compilation:', JSON.stringify(event));
          checkpoint(`${scene}/${engine}: invalid measurement compilation`, result);
          return;
        }
        if (m.text().startsWith('FRAME_BENCH_BOOT ')) {
          const line = m.text().slice('FRAME_BENCH_BOOT '.length);
          if (o.out) appendFileSync(o.out + '.startup.jsonl', line + '\n');
          console.error(line);
          return;
        }
        if (m.type() !== 'error') return;
        const url = m.location().url;
        // The optional local account/AI relay is not part of the simulation benchmark.
        const optionalRelay = /^http:\/\/(?:localhost|127\.0\.0\.1):8787\//.test(url ?? '');
        (optionalRelay && /ERR_CONNECTION_REFUSED/.test(m.text()) ? result.warnings : result.errors)
          .push(`console: ${m.text()} (${url ?? ''})`);
        if (result.errors.length) { checkpoint('console failure', result); rejectFailure(new Error(m.text())); }
      });
      try {
        if (o.traceStartup) await page.addInitScript({ content:
          `window.__stopCompileTrace=(${tracePipelines.toString()})(globalThis.GPUDevice,r=>console.info('FRAME_BENCH_BOOT '+JSON.stringify({ms:performance.now(),...r})));` });
        const url = new URL(o.url ?? vite.url('/'));
        // Ignore unrelated URL switches (world/save/shot/etc could change the fixture).
        url.search = ''; url.hash = '';
        for (const [k, v] of Object.entries({ size: '128', preset: 'empty', view: o.view, physics: engine, test: 'visual', paused: '1' })) url.searchParams.set(k, v);
        result.url = url.href;
        checkpoint(`${scene}/${engine}: navigation`, result);
        await checked(page.goto(url.href));
        checkpoint(`${scene}/${engine}: app readiness`, result);
        await checked(ready(page));
        checkpoint(`${scene}/${engine}: pipeline readiness`, result);
        await checked(page.evaluate(async () => { const a = window.__app; a.test.park(); await a.test.ready(); await a.physics.v2?.ready; window.__stopCompileTrace?.(); }));
        result.adapter = await gpuInfo(page); // helper rejects fallback adapters on macOS
        await page.addScriptTag({ content: `window.__frameBenchFixture = ${buildFixture.toString()};
          window.__frameBenchSnapshot = ${frameSnapshot.toString()};
          window.__frameBenchNativeState = ${nativeStateEvidence.toString()};
          window.__frameBenchObservePipelines = ${tracePipelines.toString()};
          window.__frameBenchNoPipelineActivity = ${assertNoPipelineActivity.toString()};` });
        checkpoint(`${scene}/${engine}: fixture upload`, result);
        result.fixture = await page.evaluate(async ({ engine, compactPath, scene, seed }) => {
          const a = window.__app;
          if (a.physics.mode !== engine || (engine === 'v2' && !a.physics.active)) throw new Error('Wrong physics engine');
          if (engine === 'v2') {
            if (typeof a.sim.readHeader !== 'function') throw new Error('This build has no compact reader path');
            if (a.sim.readHeader().format !== 2) throw new Error('Wrong v2 reader path');
          }
          a.settings.profiler = false;
          a.gfx.smoothing = 1; a.gfx.materials = 1;
          a.autoRes.enabled = false; a.autoRes.scale = 1;
          a.settings.upscale = 'quality';
          a.settings.nearGI = true; a.settings.glowLights = true; a.settings.caustics = true;
          a.settings.paused = true;
          const { E } = await import('/src/elements.js');
          const { SEED_MAX } = await import('/src/shaders/common.js');
          const fixture = window.__frameBenchFixture(a.sim, E, SEED_MAX, scene, seed);
          a.sim.load(fixture.A, fixture.B);
          a.test.resetView();
          await a.test.ready();
          await a.test.renderOnce(); // complete upload and first derived build, not a simulation frame
          await a.gpu.fence();
          if (!a.view.volumeDrawn) throw new Error('Scene renderer did not draw');
          return fixture.meta;
        }, { engine, compactPath, scene, seed: o.seed });
        checkpoint(`${scene}/${engine}: warmup and measurement`, result);
        result.run = await page.evaluate(async ({ engine, compactPath, frames, warmup, split }) => {
          const a = window.__app, gpu = a.gpu, timing = gpu.timing;
          const stepCount = engine === 'v1' ? 4 : 1;
          const snapshot = () => window.__frameBenchSnapshot(a, engine);
          const awake = () => engine === 'v2' ? a.physics.v2.readStats() : a.sim.readCounts();
          const memory = () => ({ gpu: gpu.memory(), jsHeap: performance.memory ? {
            used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null });
          const settings = () => ({ app: { ...a.settings }, gfx: { ...a.gfx }, post: { ...a.post.settings },
            autoRes: { enabled: a.autoRes.enabled, scale: a.autoRes.scale }, renderScale: a.post.renderScale,
            grid: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], dpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
            canvas: [a.renderer.domElement.width, a.renderer.domElement.height],
            camera: { position: a.camera.position.toArray(), quaternion: a.camera.quaternion.toArray(), projection: a.camera.projectionMatrix.toArray() },
            detailShown: a.view.detailShown, testMode: a.test.mode, parked: a.test.parked });
          timing.enabled = false; timing.split = false;
          const warmupStart = performance.now();
          for (let i = 0; i < warmup; i++) { a.test.step(stepCount); await a.test.renderOnce(); await gpu.fence(); }
          await a.test.ready();
          const warmupMs = performance.now() - warmupStart, measurementStart = performance.now();
          const initialSettings = settings(), before = snapshot(), memoryBefore = memory();
          const beforeState = engine === 'v2' ? await window.__frameBenchNativeState(a) : null;
          if (JSON.stringify(snapshot()) !== JSON.stringify(before)) throw new Error('Clocks changed during warmup state checkpoint');
          await gpu.fence();
          timing.split = split; timing.enabled = true;
          const samples = window.__frameBenchSamples = [];
          const pipelineBaseline = gpu.stats.pipelinesCreated;
          let pipelineActivity = 0;
          const checkPipelines = () => window.__frameBenchNoPipelineActivity(pipelineActivity, gpu.stats, pipelineBaseline);
          checkPipelines();
          const restorePipelines = window.__frameBenchObservePipelines(globalThis.GPUDevice, event => {
            pipelineActivity++;
            console.info('FRAME_BENCH_MEASURE ' + JSON.stringify({ ms: performance.now(), ...event }));
          });
          let bridges = 0;
          const onPass = a.sim.onPass;
          a.sim.onPass = (name, info) => { if (name === 'v2bridge') bridges++; onPass?.(name, info); };
          try {
            for (let i = 0; i < frames; i++) {
              checkPipelines();
              const start = snapshot();
              bridges = 0;
              const t0 = performance.now();
              a.test.step(stepCount);
              await a.test.renderOnce(); // includes its fence; explicit fence keeps the contract visible
              await gpu.fence();
              const wallMs = performance.now() - t0;
              await timing.settled(); // do not charge timestamp readback drainage to frame latency
              const current = timing.enabled && timing.lastFrame === gpu.frameNo;
              const sample = { index: i, wallMs, start, end: snapshot(), frame: gpu.frameNo, bridgeDispatches: bridges,
                gpuPassSumMs: current ? timing.frameMs : null, gpuPasses: current ? structuredClone(timing.lastPasses) : [],
                gpuCoverage: current ? structuredClone(timing.lastCoverage) : null,
                renderScale: a.post.renderScale, volumeDrawn: a.view.volumeDrawn };
              sample.awake = await awake(); // diagnostic readback, outside wall/timestamp samples
              await gpu.fence();
              checkPipelines();
              samples.push(sample);
              if (engine === 'v2' && compactPath === 'direct' && bridges !== 0) throw new Error('Direct tick/render unexpectedly exported legacy cells');
              if (!sample.volumeDrawn || sample.renderScale !== initialSettings.renderScale || a.autoRes.enabled || a.autoRes.scale !== 1) throw new Error('Rendering/quality changed during measurement');
            }
          } finally { restorePipelines(); timing.enabled = false; timing.split = false; a.sim.onPass = onPass; }
          const measurementAndReadbacksMs = performance.now() - measurementStart, finalDiagnosticsStart = performance.now();
          // Last partition only, outside every measured wall/timestamp interval.
          let blockCompaction = null;
          const native = engine === 'v2' ? a.physics.v2 : null;
          if (native?.blockCompact && samples.length) {
            const last = samples.at(-1).awake;
            const originalBlocks = last.awake * 8;
            const heavyBlocks = new Uint32Array(await gpu.readback.buffer(native.liquidScratch, native.blockCompact.header, 4))[0];
            if (heavyBlocks > originalBlocks) throw new Error('Compacted block count exceeds the original partition');
            blockCompaction = { tick: last.tick, originalBlocks, heavyBlocks, identityBlocks: originalBlocks - heavyBlocks,
              addedScratchBytes: native.blockCompact.bytes - a.sim.g.slots * 16 };
          }
          const after = snapshot(), afterState = native ? await window.__frameBenchNativeState(a) : null;
          if (JSON.stringify(snapshot()) !== JSON.stringify(after)) throw new Error('Clocks changed during end state checkpoint');
          return { initialSettings, finalSettings: settings(), before, after, beforeState, afterState, memoryBefore, memoryAfter: memory(),
            timestampSupported: timing.supported, stepCount, samples, blockCompaction,
            stageMs: { warmup: warmupMs, measurementAndReadbacks: measurementAndReadbacksMs,
              finalDiagnostics: performance.now() - finalDiagnosticsStart } };
        }, { engine, compactPath, frames: o.frames, warmup: o.warmup, split });
        result.samples = result.run.samples;
        delete result.run.samples;
        const passNames = [...new Set(result.samples.flatMap(s => s.gpuPasses.map(p => p.name)))].sort();
        result.summary = { wallMs: stats(result.samples.map(s => s.wallMs)),
          gpuPassSumMs: stats(result.samples.map(s => s.gpuPassSumMs).filter(v => v !== null)),
          missingGpuSamples: result.samples.filter(s => s.gpuPassSumMs === null).length,
          // n is the number of frames observing this name, not an invented zero
          // for frames where it did not run or had incomplete timing coverage.
          gpuPassMs: Object.fromEntries(passNames.map(name => [name, stats(result.samples.flatMap(s => {
            const passes = s.gpuPasses.filter(p => p.name === name);
            return passes.length && passes.every(p => p.gpu !== null) ? [passes.reduce((sum, p) => sum + p.gpu, 0)] : [];
          }))])) };
        const reference = report.results.find(r => r !== result && r.run);
        if (reference && qualityKey(reference.run.initialSettings) !== qualityKey(result.run.initialSettings)) throw new Error('Camera or render quality differs between cases');
        if (qualityKey(result.run.initialSettings) !== qualityKey(result.run.finalSettings)) throw new Error('Camera or render quality changed during case');
        const peer = report.results.find(r => r !== result && r.scene === scene && r.fixture);
        if (peer && peer.fixture.hash !== result.fixture.hash) throw new Error('Initial CPU fixtures differ');
        console.error(`${split ? 'SPLIT DIAGNOSTIC' : 'UNSPLIT'} ${scene}/${engine}${compactPath ? `/${compactPath}` : ''}: wall p50 ${result.summary.wallMs.p50.toFixed(2)} ms, p95 ${result.summary.wallMs.p95.toFixed(2)} ms (NON-PARITY)`);
        checkpoint(`${scene}/${engine}: complete`, result);
      } catch (e) {
        result.errors.push(e.stack ?? String(e));
        // Preserve already completed raw frames if a later frame fails.
        if (!result.samples.length) {
          try { result.samples = await page.evaluate(() => window.__frameBenchSamples ?? []); } catch { /* page/device may be gone */ }
        }
      } finally { await page.close(); }
      if (result.errors.length) throw new Error(`${scene}/${engine}: case errors; see JSON`);
    }
  } catch (e) { report.errors.push(e.stack ?? String(e)); }
  finally {
    // A close failure must not bypass the other resource's cleanup or the report.
    for (const resource of [browser, vite]) if (resource) {
      try { await resource.close(); } catch (e) { report.errors.push(`cleanup: ${e.stack ?? e}`); }
    }
  }
  report.complete = !report.errors.length && report.results.every(r => !r.errors.length);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (o.out) { mkdirSync(dirname(o.out), { recursive: true }); writeFileSync(o.out, json); console.error(`Report: ${o.out}`); }
  else process.stdout.write(json);
  if (report.errors.length || report.results.some(r => r.errors.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) console.log(HELP);
    else if (o.selfCheck) await selfCheck();
    else await run(o);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
