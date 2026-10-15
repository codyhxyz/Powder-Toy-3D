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
  --engine both|v1|v2 (default both)
  --v2-path direct|compatibility|both (default direct; same-physics bridge comparison)
  --scene all|sand|water|settled (default all)
  --view realistic|plain (default realistic; plain is an explicit blocks-renderer diagnostic)
  --port N         private strict-port Vite server (otherwise OS-assigned)
  --url URL        existing app URL instead of starting Vite
  --out FILE       raw JSON report (otherwise stdout)
  --seed N         unsigned 32-bit fixture seed (default 12345)
  --split          also replay fresh cases with split GPU passes (diagnostic only)
  --trace-startup  record native pipeline creation before app readiness
  --self-check     CPU statistics/arguments/fixtures checks; no GPU
Fixed: 128³ box, 1280×720 viewport, DPR 1, Quality upscale, autoRes OFF.
One frame: v1 test.step(4) / v2 test.step(1), then renderOnce + GPU fence.
Non-parity: v2 is missing physics; no equivalent-work speedup claim until the full suite passes.`;

export function parseArgs(argv) {
  const o = { frames: 60, warmup: 12, engine: 'both', 'v2-path': 'direct', scene: 'all', view: 'realistic', seed: 12345,
    port: null, url: null, out: null, split: false, traceStartup: false, selfCheck: false, help: false };
  const flags = { '--split': 'split', '--trace-startup': 'traceStartup', '--self-check': 'selfCheck', '--help': 'help' };
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
  for (const [key, allowed] of Object.entries({ engine: ['both', 'v1', 'v2'], 'v2-path': ['direct', 'compatibility', 'both'], scene: ['all', 'sand', 'water', 'settled'], view: ['realistic', 'plain'] })) {
    if (!allowed.includes(o[key])) throw new Error(`${key} must be ${allowed.join('|')}`);
  }
  if ([5173, 8787].includes(o.port)) throw new Error('Use a private port, not 5173 or 8787');
  if (o.url) {
    if (!['http:', 'https:'].includes(new URL(o.url).protocol)) throw new Error('url must be HTTP(S)');
    if (o.port !== null) throw new Error('--url and --port are mutually exclusive');
  }
  return o;
}

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
  for (const argv of [['--frames', '0'], ['--warmup', '-1'], ['--frames', '1.5'], ['--seed', '4294967296'],
    ['--engine', 'v3'], ['--v2-path', 'unknown'], ['--view', 'cheap'], ['--port', '5173'], ['--url', 'file:///tmp/a'],
    ['--url', 'http://localhost', '--port', '43199'], ['--out'], ['--oops'], ['--split', '--split']]) assert.throws(() => parseArgs(argv));
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
  console.log('ok: statistics, CLI validation, deterministic full-size CPU fixtures, GPU-f32 camera quality checks');
}

async function run(o) {
  const { launchBrowser, newTestPage, ready, gpuInfo } = await import('../browser.mjs');
  const { startVite } = await import('../vite-server.mjs');
  let commit = null, gitStatus = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  } catch { /* URL-only runs need not have Git */ }
  const toolHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const report = { schema: 1, complete: false, createdAt: new Date().toISOString(), toolCommit: commit, gitStatus, toolHash, options: o,
    parity: 'NON-PARITY: v2 is missing physics. Comparison with v1 is not equivalent work until the full physics suite passes.',
    methodology: [
      'Serialized frame latency, not live-loop FPS: parked app; v1 step(4) or v2 step(1), renderOnce(), gpu.fence().',
      'Wall clock covers CPU recording, submissions, physics, bridge, renderer derived/shadows/GI/volume/meshes/post, and GPU completion; no bandwidth estimate.',
      'Unsplit timestamp instrumentation is enabled for headline samples. GPU pass sums are NOT elapsed GPU frame time: intervals can overlap. Copies/gaps are excluded. Wall time is the headline metric.',
      'Timing readback settling and explicit awake-count readbacks are outside wall samples. Native asynchronous simulation bookkeeping remains inside.',
      'Warmup advances the fixture. Each engine/scene/diagnostic starts in a fresh page from identical CPU arrays and seed; evolved states are NOT identical.',
      'V2 direct/compatibility use identical physics. Compatibility exports after each tick and renders the legacy projection; this diagnoses conversion cost, not full feature parity.',
      'Fixed camera and frozen render-only animation clocks; forced draws even when idle. Settled geometry is not a live idle-loop/power benchmark.',
      'Camera equality uses GPU f32 precision; raw CPU camera values remain recorded. Render-quality settings are compared unchanged.',
      'Memory is the app GPU resource registry, not total VRAM; excludes unregistered driver/three/timestamp scratch resources. JS heap is optional Chromium telemetry.',
      'toolCommit identifies this checkout, not necessarily the build served by --url.',
    ], results: [], errors: [] };
  let vite, browser;
  const checkpoint = (stage, result = report) => {
    result.stage = stage;
    console.error(`[frame-bench] ${stage}`);
    if (o.out) {
      mkdirSync(dirname(o.out), { recursive: true });
      writeFileSync(o.out, JSON.stringify(report, null, 2) + '\n');
    }
  };
  try {
    checkpoint('CPU import preparation');
    if (!o.url) vite = await startVite({ port: o.port ?? undefined, warmupEntries: ['/src/main.js'] });
    checkpoint('GPU acquisition');
    // Both resources are inside this try: a launch failure must still close Vite.
    browser = await launchBrowser();
    report.browserVersion = browser.version();
    const engines = o.engine === 'both' ? ['v1', 'v2'] : [o.engine];
    const cases = engines.flatMap(engine => engine === 'v1' ? [{ engine, compactPath: null }]
      : (o['v2-path'] === 'both' ? ['direct', 'compatibility'] : [o['v2-path']]).map(compactPath => ({ engine, compactPath })));
    const scenes = o.scene === 'all' ? ['sand', 'water', 'settled'] : [o.scene];
    for (const split of o.split ? [false, true] : [false]) for (const scene of scenes) for (const { engine, compactPath } of cases) {
      const result = { engine, compactPath, scene, diagnosticSplit: split, errors: [], warnings: [], samples: [] };
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
        await page.addScriptTag({ content: `window.__frameBenchFixture = ${buildFixture.toString()};` });
        checkpoint(`${scene}/${engine}: fixture upload`, result);
        result.fixture = await page.evaluate(async ({ engine, compactPath, scene, seed }) => {
          const a = window.__app;
          if (a.physics.mode !== engine || (engine === 'v2' && !a.physics.active)) throw new Error('Wrong physics engine');
          if (engine === 'v2') {
            if (typeof a.sim.readHeader !== 'function') throw new Error('This build has no compact reader path');
            a.physics.v2.forceCompatibility = compactPath === 'compatibility';
            if (a.sim.readHeader().format !== (compactPath === 'direct' ? 2 : 0)) throw new Error('Wrong v2 reader path');
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
          const snapshot = () => ({ simFrame: a.sim.frame, v2Tick: a.physics.v2?.tick ?? null,
            asleep: engine === 'v2' ? a.physics.v2.asleep : null, // v1 exposes certification, not an asleep getter
            certified: engine === 'v2' ? a.physics.v2.certified : a.sim.idleCertified });
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
          for (let i = 0; i < warmup; i++) { a.test.step(stepCount); await a.test.renderOnce(); await gpu.fence(); }
          await a.test.ready();
          const initialSettings = settings(), before = snapshot(), memoryBefore = memory();
          await gpu.fence();
          timing.split = split; timing.enabled = true;
          const samples = window.__frameBenchSamples = [];
          let bridges = 0;
          const onPass = a.sim.onPass;
          a.sim.onPass = (name, info) => { if (name === 'v2bridge') bridges++; onPass?.(name, info); };
          try {
            for (let i = 0; i < frames; i++) {
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
              samples.push(sample);
              if (engine === 'v2' && compactPath === 'direct' && bridges !== 0) throw new Error('Direct tick/render unexpectedly exported legacy cells');
              if (!sample.volumeDrawn || sample.renderScale !== initialSettings.renderScale || a.autoRes.enabled || a.autoRes.scale !== 1) throw new Error('Rendering/quality changed during measurement');
            }
          } finally { timing.enabled = false; timing.split = false; a.sim.onPass = onPass; }
          return { initialSettings, finalSettings: settings(), before, after: snapshot(), memoryBefore, memoryAfter: memory(),
            timestampSupported: timing.supported, stepCount, samples };
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
