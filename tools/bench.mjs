// A/B performance and physics census for two builds (checkouts) of Powder Toy 3D.
//
// Serves each checkout with its own vite and opens one headless page per build on
// the real GPU. Each round reloads the scenario's preset on both from the same
// seed and settles it with the same number of steps, so every round times
// identical work. Then each metric is timed in short chunks that alternate
// between the builds (A B B A A B ...): contention from other processes on the
// GPU changes from one second to the next, and only fine interleaving makes it
// hit both sides alike. The app's frame loop is held throughout: its
// requestAnimationFrame callbacks queue up and run only when the bench pumps a
// frame (to set up the view), never while something is being timed.
//
// Metrics: wall clock over a chunk (about CHUNK_MS of the faster build's work), with a GPU
// sync before and after it.
//   derived     ms per sim.updateBricks()
//   view        ms per post.render(scene, camera), from the home view
//   step        ms per sim.step()
//   stepNoSkip  ms per sim.step() with sim.skipQuiet = false
// A round's value per build is its median chunk (per iteration), and its B/A
// the median ratio of the chunk pairs (each A chunk with the B chunk next to it),
// so a burst of contention in one chunk doesn't decide the round. Reported: the
// median and interquartile range over the rounds.
//
// The sync is sim.gpuSync() when a build has one, plus a 1-texel read of the
// render target drawn last: a read waits for the pending GPU work on what it
// reads and only that (see gfx/profiler.js), so it has to be the newest target.
// After the last chunk of a metric every target it drew is read twice more: a
// first pass slower than the second means the sync returned before the GPU had
// finished (the "residual", reported and warned about).
//
// --census reads the state back instead of timing it: cells per element,
// energy Σ CAP[id]·T, the quiet-brick share and the mean |velocity| of powder
// and liquid cells, at load and after settling.
//
// usage: node tools/bench.mjs --a <dirA> --b <dirB> [--scenarios lab:128,volcano:128,empty:128]
//          [--rounds 5] [--settle 200] [--metrics derived,view,step,stepNoSkip] [--out report.json]
//          [--census] [--wait-idle] [--port 5391]
// A scenario is preset:size (a size from ?size=). Each dir is a full checkout with node_modules;
// a baseline from a branch: git archive main | tar -x -C <dir> && ln -s <repo>/node_modules <dir>/node_modules
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { existsSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const SEED = 12345;                                 // Math.random seed (mulberry32, as tools/regress.mjs)
const VIEWPORT = { width: 1280, height: 800 };      // CSS px at device pixel ratio 1 (as tools/regress.mjs)
const CHROME_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];   // the real GPU
const HOST = '127.0.0.1';         // vite binds here only, so no other server can answer on our port
const CACHE_ROOT = `${tmpdir()}/tpt-bench-vite`;   // vite dependency caches, one per checkout, kept between runs
const BASE_PORT = 5391;           // first port tried, for A; B tries the ones above A's
const PORT_TRIES = 20;            // ports tried per server
const SERVER_TIMEOUT_MS = 30000;  // vite must print its URL within this
const BOOT_TIMEOUT_MS = 60000;    // the app must expose window.__app within this
const POLL_MS = 100;              // while waiting for either
const BOOT_FRAMES = 4;            // app frames pumped after boot: compiles the frame's shaders
const PUMP_STEP_MS = 100;         // virtual time between pumped frames: longer than any frame-pacing interval
const KILL_GRACE_MS = 3000;       // a server gets SIGTERM, then SIGKILL after this
const ERROR_CHARS = 500;          // page errors are kept to this length
const HTTP_ERROR = 400;           // responses from this status up are failed loads (a boot failure lists them)
const BOOT_REPORT = 8;            // failed loads and errors a boot failure lists, at most
const ROUNDS = 5;                 // default --rounds
const SETTLE_STEPS = 200;         // default --settle: steps from load to the measured state
const SCENARIOS = 'lab:128,volcano:128,empty:128';   // default --scenarios
const DEFAULT_SIZE = '128';       // a scenario's size when it names none (the app's default grid)
// Timed work per round and build, in run order (derived and view leave the state as it is):
// warmup iterations (GPU clocks up, shaders compiled; each also timed on its own, to size the
// chunks), then `chunks` chunks per build.
const METRICS = {
  derived: { warmup: 4, chunks: 8 },
  view: { warmup: 4, chunks: 8 },
  step: { warmup: 8, chunks: 8 },
  stepNoSkip: { warmup: 8, chunks: 8 },
};
// A chunk is as many iterations as take the faster build about this long, judged by its fastest
// warmup iteration in the first round (the least slowed by contention), then fixed and the same
// for both builds, so their worlds advance in step. Long enough that a sync's own cost
// (~0.05–0.1 ms) stays well under 1% and a burst of contention is a small part of it, short
// enough that both builds see the same contention.
const CHUNK_MS = 40;
const MIN_ITERS = 4;              // per chunk, whatever the warmup said
const MAX_ITERS = 500;
// src/sim.js exports tried for cell → texel index (in texels, into readState()'s arrays), called
// as f(g, x, y, z); without one the census uses the y-slice atlas of src/presets.js idx.
const CELL_TEXEL_EXPORTS = ['cellTexel', 'cellToTexel', 'texelIndex', 'cellIndex'];
const QUIET_MIN = 127;            // quiet-map texel above this: a skipped brick (the map holds 0 or 255)
const IDLE_UTIL = 10;             // % GPU utilization --wait-idle waits for before a round
const WAIT_IDLE_MAX_MS = 30000;   // …for at most this long
const WAIT_IDLE_POLL_MS = 500;
const BUSY_UTIL = 25;             // % utilization above which the report warns that timings were contended
// Median share of a checked chunk still running after its sync above which the report warns. A
// sync that works leaves only readback jitter (medians 0.3–1.3% measured under contention, single
// chunks up to ~9%); one that doesn't wait leaves the whole chunk's GPU time (over 100%).
const RESIDUAL_WARN = 0.25;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
if (!opt('a') || !opt('b')) {
  console.error('usage: node tools/bench.mjs --a <dirA> --b <dirB> [--scenarios lab:128,...] [--rounds 5] [--settle 200]'
    + ' [--metrics derived,view,step,stepNoSkip] [--out report.json] [--census] [--wait-idle] [--port 5391]');
  process.exit(2);
}
const builds = ['a', 'b'].map((k) => ({ name: k.toUpperCase(), dir: resolve(opt(k)), errors: [], failed: [] }));
for (const b of builds) {
  if (!existsSync(`${b.dir}/src/app.js`) || !existsSync(`${b.dir}/node_modules/vite/dist/node/index.js`))
    throw new Error(`${b.dir} isn't a checkout with node_modules (symlink the repo's)`);
}
const scenarios = opt('scenarios', SCENARIOS).split(',').map((s) => {
  const [preset, size] = s.split(':');
  return { name: s, preset, size: size ?? DEFAULT_SIZE };
});
const rounds = +opt('rounds', ROUNDS);
const settle = +opt('settle', SETTLE_STEPS);
const metrics = opt('metrics', Object.keys(METRICS).join(',')).split(',');
for (const m of metrics) if (!METRICS[m]) throw new Error(`unknown metric ${m} (${Object.keys(METRICS).join(', ')})`);
const plan = Object.keys(METRICS).filter((m) => metrics.includes(m));
const census = flag('census');
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => {
  const s = [...xs].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const median = (xs) => quantile(xs, 0.5);

// GPU "Device Utilization %" of the IOAccelerator (macOS), or null.
function gpuUtil() {
  try {
    const m = execFileSync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { encoding: 'utf8' }).match(/"Device Utilization %"=(\d+)/);
    return m ? +m[1] : null;
  } catch { return null; }
}

// Short commit of a checkout (+ if it has local changes), or null for a tree that isn't one.
function gitHead(dir) {
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(dir)) return null;
    return git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '+' : '');
  } catch { return null; }
}

// ---------------------------------------------------------------- servers
// Each vite runs in its own process group (it spawns helpers), killed as a group.
const servers = [];
const killGroup = (p, sig) => { try { process.kill(-p.pid, sig); } catch { /* already gone */ } };
process.on('exit', () => servers.forEach((p) => killGroup(p, 'SIGKILL')));   // never leave one behind
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

async function stopServer(p) {
  servers.splice(servers.indexOf(p), 1);
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise((r) => p.once('exit', () => r(true)));
  killGroup(p, 'SIGTERM');
  if (!(await Promise.race([exited, sleep(KILL_GRACE_MS).then(() => false)]))) killGroup(p, 'SIGKILL');
}

// Start the checkout's own vite in dir on the first free port from `first`; resolves to
// { port, proc }. It runs through vite's API (the CLI has no option for this) to get:
//   - a dependency cache of its own: checkouts symlink one node_modules, and servers sharing
//     its .vite (ours, and other sessions') keep re-optimizing each other's deps;
//   - no file watcher and no HMR: other sessions edit checkouts, and a reload mid-run would
//     swap the code being measured.
// The checkout's vite config, if any, still applies (createServer merges it).
async function serve(dir, first) {
  const cacheDir = `${CACHE_ROOT}/${dir.replace(/[^\w.-]+/g, '_')}`;
  const vite = pathToFileURL(`${dir}/node_modules/vite/dist/node/index.js`).href;
  for (let port = first; port < first + PORT_TRIES; port++) {
    const script = `const { createServer, searchForWorkspaceRoot } = await import(${JSON.stringify(vite)});
const server = await createServer({ cacheDir: ${JSON.stringify(cacheDir)}, server: { host: ${JSON.stringify(HOST)}, port: ${port},
  strictPort: true, hmr: false, watch: null, fs: { allow: [searchForWorkspaceRoot(process.cwd()), ${JSON.stringify(cacheDir)}] } } });
await server.listen();
server.printUrls();`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(proc);
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    // up when vite prints its own URL (an HTTP poll could reach some other server)
    const up = () => out.replace(/\x1b\[[0-9;]*m/g, '').includes(`${HOST}:${port}/`);
    const t0 = Date.now();
    while (proc.exitCode === null && !up() && Date.now() - t0 < SERVER_TIMEOUT_MS) await sleep(POLL_MS);
    if (up()) return { port, proc };
    await stopServer(proc);
    if (!/in use/i.test(out)) throw new Error(`vite in ${dir} didn't start:\n${out}`);
  }
  throw new Error(`no free port for vite in ${first}–${first + PORT_TRIES - 1}`);
}

// ---------------------------------------------------------------- page side
// These run in the pages (serialized by playwright): they see only their arguments.

// Init script, before the app's code.
function pageInit({ seed, pumpStepMs }) {
  // mulberry32 (as tools/regress.mjs; its numbers are the published constants): reseeded before every load
  let s = seed;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Hold every requestAnimationFrame callback, the app's frame loop included:
  // they wait until pump() runs them, so nothing draws while the bench times.
  let held = new Map(), nextId = 1, clock = 0;
  window.requestAnimationFrame = (cb) => { held.set(nextId, cb); return nextId++; };
  window.cancelAnimationFrame = (id) => { held.delete(id); };
  window.__bench = {
    reseed() { s = seed; },
    // run n frames' worth of the waiting callbacks
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const cbs = [...held.values()];
        held = new Map();
        clock = Math.max(clock + pumpStepMs, performance.now());
        for (const cb of cbs) cb(clock);
      }
    },
  };
  // the UI animates on its own timers: hide it (as tools/regress.mjs)
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
    document.head.appendChild(st);
  });
}

// Installs the timing and census helpers once the app has booted.
function pageSetup({ bootFrames, cellTexelExports, quietMin }) {
  const RGBA = 4;
  const b = window.__bench, a = window.__app, r = a.renderer, gl = r.getContext();
  a.settings.paused = true;     // pumped frames must not step the sim
  a.autoRes.enabled = false;    // nor change the resolution

  // Every draw notes its render target (null: the canvas), for the sync and the residual check.
  const draw = r.renderBufferDirect;
  b.drawn = new Set();
  r.renderBufferDirect = function (...p) {
    const t = r.getRenderTarget();
    b.drawn.add(t);
    if (t) b.lastTarget = t;
    b.canvasLast = !t;
    return draw.apply(this, p);
  };
  // One texel of a target, read in the format the implementation reads it in natively
  // (float, half float, 8-bit or integer state alike). The first read of each is error-checked.
  const ARRAYS = { [gl.FLOAT]: Float32Array, [gl.HALF_FLOAT]: Uint16Array, [gl.UNSIGNED_BYTE]: Uint8Array,
    [gl.UNSIGNED_INT]: Uint32Array, [gl.INT]: Int32Array };
  const reads = new Map();
  b.readTexel = (t) => {
    const prev = r.getRenderTarget();
    r.setRenderTarget(t);
    if (t) gl.readBuffer(gl.COLOR_ATTACHMENT0);   // (three leaves an MRT target's read buffer where its last read put it)
    let f = reads.get(t);
    if (!f) {
      gl.getError();   // (an older error isn't ours)
      const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT), type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
      f = { format, type, buf: new (ARRAYS[type] ?? Float32Array)(RGBA) };
      gl.readPixels(0, 0, 1, 1, f.format, f.type, f.buf);
      const err = gl.getError();
      if (err) throw new Error(`reading back a render target failed (GL error ${err})`);
      reads.set(t, f);
    } else gl.readPixels(0, 0, 1, 1, f.format, f.type, f.buf);
    r.setRenderTarget(prev);
  };
  // A read of the canvas doesn't wait for anything: after a pass into the canvas, clear a 1×1
  // target of our own and read that (as gfx/profiler.js does).
  const own = new a.sim.targets[0].constructor(1, 1, { depthBuffer: false });   // (a THREE.WebGLRenderTarget)
  b.syncOwn = () => {
    const prev = r.getRenderTarget();
    r.setRenderTarget(own);
    r.clear();
    b.readTexel(own);
    r.setRenderTarget(prev);
  };
  b.sync = () => {
    a.sim.gpuSync?.();                            // newer builds
    if (b.lastTarget) b.readTexel(b.lastTarget);  // the newest offscreen target
    if (b.canvasLast) b.syncOwn();
  };

  // The timed work. setup/teardown run untimed around a metric's chunks; a build without what
  // a metric calls reports — for it instead of failing the run.
  b.metrics = {
    derived: { supported: () => typeof a.sim.updateBricks === 'function', run: () => a.sim.updateBricks() },
    view: {
      supported: () => typeof a.post?.render === 'function',
      setup() {
        a.rig?.reset(true);   // the home view
        b.pump(1);           // one app frame: derived passes, shadow, GI and the volume's uniforms for this state
      },
      run: () => a.post.render(a.scene, a.camera),
    },
    step: { run: () => a.sim.step() },
    stepNoSkip: {
      supported: () => 'skipQuiet' in a.sim,
      setup() {
        this.skip = a.sim.skipQuiet;
        a.sim.skipQuiet = false;
        a.sim.actDirty = true;   // the next step rebuilds the activity map, with nothing skipped
      },
      run: () => a.sim.step(),
      teardown() {
        a.sim.skipQuiet = this.skip;
        a.sim.actDirty = true;
      },
    },
  };
  // Each run is flushed, so the GPU starts on it while the next is issued: a chunk takes the
  // larger of CPU and GPU time, not their sum.
  const runFlushed = (run, n) => { for (let i = 0; i < n; i++) { run(); gl.flush(); } };
  // Setup and warmup: null when this build can't run the metric, else the fastest warmup run in
  // ms (each timed with its own sync, after the first, which compiles and allocates).
  b.prepare = (name, warmup) => {
    const m = b.metrics[name];
    if (m.supported && !m.supported()) return null;
    m.setup?.();
    m.run();
    b.sync();
    let fastest = Infinity;
    for (let i = 1; i < warmup; i++) {
      const t0 = performance.now();
      m.run();
      b.sync();
      fastest = Math.min(fastest, performance.now() - t0);
    }
    return fastest;
  };
  // ms for `iters` runs; with check, also the residual: ms the GPU was still busy after the sync
  b.chunk = (name, iters, check) => {
    const run = b.metrics[name].run;
    b.sync();
    b.drawn.clear();
    const t0 = performance.now();
    runFlushed(run, iters);
    b.sync();
    const ms = performance.now() - t0;
    if (!check) return { ms };
    const readAll = () => {
      const t = performance.now();
      for (const tg of b.drawn) if (tg) b.readTexel(tg); else b.syncOwn();
      return performance.now() - t;
    };
    const first = readAll();
    return { ms, residual: first - readAll() };
  };
  b.finish = (name) => b.metrics[name].teardown?.();

  // Census of the current state, in the D5 float meaning (A = id, °C, life, ctype + seed;
  // B = velocity xyz, pressure), with each build's own element table.
  b.census = async () => {
    const sim = a.sim, g = sim.g;
    const [{ ELEMENTS, K }, simModule, { BRICK }] = await Promise.all(
      [import('/src/elements.js'), import('/src/sim.js'), import('/src/shaders/common.js')]);
    let A, B;
    if (typeof sim.readState === 'function') {
      const s = sim.readState();
      [A, B] = Array.isArray(s) ? s : [s.A ?? s.a, s.B ?? s.b];
    } else {
      const t = sim.targets[sim.cur];
      if (t.textures.length < 2) throw new Error('packed state without sim.readState(): can\'t census this build');
      A = new Float32Array(t.width * t.height * RGBA);
      B = new Float32Array(A.length);
      r.readRenderTargetPixels(t, 0, 0, t.width, t.height, A, undefined, 0);
      r.readRenderTargetPixels(t, 0, 0, t.width, t.height, B, undefined, 1);
    }
    const helper = cellTexelExports.find((k) => typeof simModule[k] === 'function');
    const texel = helper ? (x, y, z) => simModule[helper](g, x, y, z)
      : (x, y, z) => (Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x;
    const texels = A.length / RGBA, seen = new Uint8Array(texels);
    const n = {}, energy = {};
    let vPowder = 0, nPowder = 0, vLiquid = 0, nLiquid = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const t = texel(x, y, z);
          // every cell must land on its own texel
          if (!(t >= 0 && t < texels) || seen[t]++) throw new Error(`cell → texel mapping (${helper ?? 'y-slice atlas'}) doesn't fit this build`);
          const i = t * RGBA, id = Math.round(A[i]), e = ELEMENTS[id];
          n[id] = (n[id] ?? 0) + 1;
          energy[id] = (energy[id] ?? 0) + (e ? e.cap : NaN) * A[i + 1];
          if (e?.kind === K.POWDER || e?.kind === K.LIQUID) {
            const v = Math.sqrt(B[i] * B[i] + B[i + 1] * B[i + 1] + B[i + 2] * B[i + 2]);
            if (e.kind === K.POWDER) { vPowder += v; nPowder++; } else { vLiquid += v; nLiquid++; }
          }
        }
    // the build's own census() counts cells with its own mapping: a check on ours
    let crossCheck = null;
    if (typeof sim.census === 'function') {
      const c = sim.census();
      crossCheck = Object.keys({ ...c, ...n }).every((id) => (c[id]?.n ?? 0) === (n[id] ?? 0));
    }
    // quiet share: skipped bricks over all bricks (texels outside the grid hold 0, as gfx/profiler.js relies on)
    let quiet = null;
    if (typeof sim.updateActivity === 'function' && sim.actQuiet) {
      const skip = sim.skipQuiet;
      sim.skipQuiet = true;
      sim.updateActivity();
      sim.skipQuiet = skip;
      const t = sim.actQuiet, q = new Uint8Array(t.width * t.height * RGBA);
      r.readRenderTargetPixels(t, 0, 0, t.width, t.height, q);
      let k = 0;
      for (let i = 0; i < q.length; i += RGBA) if (q[i] > quietMin) k++;
      quiet = k / ((g.nx / BRICK) * (g.ny / BRICK) * (g.nz / BRICK));
    }
    const key = (id) => ELEMENTS[id]?.key ?? `id${id}`;
    return {
      cells: Object.fromEntries(Object.entries(n).map(([id, c]) => [key(id), c])),
      energy: Object.values(energy).reduce((s, e) => s + e, 0),
      energyBy: Object.fromEntries(Object.entries(energy).map(([id, e]) => [key(id), e])),
      quiet,
      vPowder: nPowder ? vPowder / nPowder : null,
      vLiquid: nLiquid ? vLiquid / nLiquid : null,
      source: typeof sim.readState === 'function' ? 'sim.readState()' : 'state targets',
      mapping: helper ?? 'y-slice atlas',
      crossCheck,
    };
  };

  b.pump(bootFrames);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    size: a.settings.size,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    sync: `${a.sim.gpuSync ? 'sim.gpuSync() + ' : ''}newest target read`,
  };
}

// Load the scenario from the seed and settle it.
function pageSettle({ preset, settle }) {
  const b = window.__bench, a = window.__app;
  b.reseed();                     // the same scene every round, on both builds
  a.loadPreset(preset, false);
  a.sim.frame = 0;                // the sim's random streams are seeded by its step counter
  for (let i = 0; i < settle; i++) a.sim.step();
  b.sync();
}

async function pageCensus({ preset, settle }) {
  const b = window.__bench, a = window.__app;
  b.reseed();
  a.loadPreset(preset, false);
  a.sim.frame = 0;
  const initial = await b.census();
  for (let i = 0; i < settle; i++) a.sim.step();
  return { initial, settled: await b.census() };
}

// ---------------------------------------------------------------- run
let browser = null;
const report = {
  date: new Date().toISOString(),
  config: { scenarios: scenarios.map((s) => s.name), rounds, settle, census, waitIdle: flag('wait-idle'),
    metrics: census ? {} : Object.fromEntries(plan.map((m) => [m, METRICS[m]])) },
  builds: {},
  gpuUtil: { before: gpuUtil(), rounds: [], after: null },
  results: {},
  census: {},
  warnings: [],
};
try {
  let port = +opt('port', BASE_PORT);
  for (const b of builds) {
    Object.assign(b, await serve(b.dir, port));
    port = b.port + 1;
    log(`${b.name}: ${b.dir} on :${b.port}`);
  }
  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  for (const b of builds) {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    await ctx.routeWebSocket(/.*/, () => {});   // sockets are mocked and silent: no multiplayer relay
    await ctx.addInitScript(pageInit, { seed: SEED, pumpStepMs: PUMP_STEP_MS });
    b.page = await ctx.newPage();
    b.page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) b.errors.push(m.text().slice(0, ERROR_CHARS));
    });
    b.page.on('pageerror', (e) => b.errors.push(`PAGEERROR ${String(e).slice(0, ERROR_CHARS)}`));
    b.page.on('response', (r) => { if (r.status() >= HTTP_ERROR) b.failed.push(`${r.status()} ${r.url()}`); });
  }
  // load a size (one build at a time, so their first loads don't compete)
  const boot = async (b, size) => {
    if (b.size === size) return;
    await b.page.goto(`http://${HOST}:${b.port}/?size=${size}&preset=empty`);
    try {
      await b.page.waitForFunction(() => window.__app?.sim, null, { polling: POLL_MS, timeout: BOOT_TIMEOUT_MS });
    } catch {
      // e.g. a node_modules without every package in package.json: vite answers 500 for the imports
      throw new Error(`${b.name} (${b.dir}) didn't boot.\n${[...b.failed, ...b.errors].slice(0, BOOT_REPORT).join('\n')}`);
    }
    const info = await b.page.evaluate(pageSetup, { bootFrames: BOOT_FRAMES, cellTexelExports: CELL_TEXEL_EXPORTS, quietMin: QUIET_MIN });
    if (info.size !== size) throw new Error(`${b.name} has no grid size ${size}`);
    Object.assign(b, info, { size });
  };
  const call = (b, fn, ...a) => b.page.evaluate(([fn, a]) => window.__bench[fn](...a), [fn, a]);

  for (const sc of scenarios) {
    for (const b of builds) await boot(b, sc.size);
    if (census) {
      report.census[sc.name] = {};
      for (const b of builds) {
        report.census[sc.name][b.name] = await b.page.evaluate(pageCensus, { preset: sc.preset, settle });
        log(`${sc.name} census ${b.name} done`);
      }
      continue;
    }
    const res = (report.results[sc.name] = {});
    for (const m of plan) res[m] = { iters: null, A: [], B: [], ratio: [], residual: { A: [], B: [] }, chunks: { A: [], B: [] } };
    for (let i = 0; i < rounds; i++) {
      if (flag('wait-idle')) {
        const t0 = Date.now();
        while (gpuUtil() > IDLE_UTIL && Date.now() - t0 < WAIT_IDLE_MAX_MS) await sleep(WAIT_IDLE_POLL_MS);
      }
      const util = gpuUtil();
      report.gpuUtil.rounds.push(util);
      const order = i % 2 ? [...builds].reverse() : builds;
      for (const b of order) await b.page.evaluate(pageSettle, { preset: sc.preset, settle });
      for (const m of plan) {
        const { warmup, chunks } = METRICS[m];
        const runs = [], per = [];
        for (const b of order) {
          const ms = await call(b, 'prepare', m, warmup);
          if (ms !== null) { runs.push(b); per.push(ms); }
        }
        if (!runs.length) continue;
        const iters = (res[m].iters ??= Math.min(MAX_ITERS, Math.max(MIN_ITERS, Math.ceil(CHUNK_MS / Math.min(...per)))));
        const times = Object.fromEntries(runs.map((b) => [b.name, []]));
        // chunks alternate A B, B A, ...; the last one of each build checks the sync
        for (let k = 0; k < chunks; k++) {
          for (const b of k % 2 ? [...runs].reverse() : runs) {
            const c = await call(b, 'chunk', m, iters, k === chunks - 1);
            times[b.name].push(c.ms);
            if (c.residual !== undefined) res[m].residual[b.name].push(c.residual / c.ms);
          }
        }
        for (const b of runs) {
          await call(b, 'finish', m);
          res[m][b.name].push(median(times[b.name]) / iters);
          res[m].chunks[b.name].push(times[b.name]);
        }
        if (runs.length === builds.length) res[m].ratio.push(median(times.A.map((t, k) => times.B[k] / t)));
      }
      log(`${sc.name} round ${i + 1}/${rounds} (GPU ${util ?? '?'}%): ${plan.map((m) => {
        const [x, y] = [res[m].A.at(-1), res[m].B.at(-1)];
        return `${m} ${x?.toFixed(2) ?? '—'}/${y?.toFixed(2) ?? '—'} ms${res[m].ratio.length > i ? ` (${res[m].ratio.at(-1).toFixed(2)})` : ''}`;
      }).join('  ')}`);
    }
  }
} finally {
  await browser?.close();
  await Promise.all([...servers].map(stopServer));
}
report.gpuUtil.after = gpuUtil();

// ---------------------------------------------------------------- report
const stats = (xs) => (xs.length ? { median: quantile(xs, 0.5), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75) } : null);
const range = (s, f) => (s ? `${f(s.median)} [${f(s.q1)}–${f(s.q3)}]` : '—');
const fmtMs = (v) => v.toFixed(v < 1 ? 3 : 2);
const fmtRatio = (v) => v.toFixed(3);
const warn = (s) => report.warnings.push(s);

for (const b of builds) {
  report.builds[b.name] = { dir: b.dir, git: gitHead(b.dir), port: b.port, gpu: b.gpu, sync: b.sync, errors: b.errors };
  if (/swiftshader|llvmpipe|software/i.test(b.gpu ?? '')) warn(`${b.name} rendered on ${b.gpu}, not the GPU`);
  if (b.errors.length) warn(`${b.name} logged ${b.errors.length} page error(s); see builds.${b.name}.errors`);
}
const util = report.gpuUtil, roundUtil = util.rounds.filter((u) => u !== null);
const utilMedian = roundUtil.length ? median(roundUtil) : null;
const utilText = `${util.before ?? '?'}% before, ${utilMedian === null ? '' : `${utilMedian}% median at round starts, `}${util.after ?? '?'}% after`;
if (!census && [util.before, util.after, utilMedian].some((u) => u > BUSY_UTIL))
  warn(`the GPU was busy (utilization ${utilText}): absolute times are inflated and noisy; the interleaved B/A ratios hold up better`);

const lines = [];
const name = (b) => `${b.dir}${report.builds[b.name].git ? ` @ ${report.builds[b.name].git}` : ''}`;
lines.push(`## bench: A = ${name(builds[0])}, B = ${name(builds[1])}`, '');
lines.push(`${builds[0].gpu}. ${census ? 'Census' : `${rounds} rounds of interleaved chunks`}, ${settle} settle steps.`
  + ` GPU utilization: ${utilText}.`, '');

if (!census) {
  lines.push('| scenario | metric | A ms | B ms | B/A |', '|---|---|---|---|---|');
  for (const [sc, res] of Object.entries(report.results)) {
    for (const [m, r] of Object.entries(res)) {
      r.summary = { A: stats(r.A), B: stats(r.B), ratio: stats(r.ratio),
        residual: { A: stats(r.residual.A), B: stats(r.residual.B) } };
      lines.push(`| ${sc} | ${m} | ${range(r.summary.A, fmtMs)} | ${range(r.summary.B, fmtMs)} | ${range(r.summary.ratio, fmtRatio)} |`);
      // a sync that returned early shows as a residual
      for (const b of ['A', 'B']) {
        const share = r.summary.residual[b]?.median;
        if (share > RESIDUAL_WARN) warn(`${sc} ${m} ${b}: ${(share * 100).toFixed(1)}% of a chunk (median) was still running after its sync`);
      }
    }
  }
  lines.push('', 'Median [interquartile range] over the rounds. Per round: the median chunk per iteration, and the median B/A of the chunk pairs.');
} else {
  const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const num = (v, d = 3) => (v === null || v === undefined ? '—' : v.toFixed(d));
  const int = (v) => (v ?? 0).toLocaleString('en-US');
  for (const [sc, byBuild] of Object.entries(report.census)) {
    const A = byBuild.A.settled, B = byBuild.B.settled;
    lines.push(`### ${sc}: census after ${settle} steps`, '', '| | A | B | B − A |', '|---|---|---|---|');
    for (const k of [...new Set([...Object.keys(A.cells), ...Object.keys(B.cells)])])
      lines.push(`| ${k} | ${int(A.cells[k])} | ${int(B.cells[k])} | ${int((B.cells[k] ?? 0) - (A.cells[k] ?? 0))} |`);
    lines.push(`| energy Σ cap·T | ${num(A.energy, 1)} | ${num(B.energy, 1)} | ${num(B.energy - A.energy, 1)} (${pct((B.energy - A.energy) / A.energy)}) |`);
    lines.push(`| quiet bricks | ${pct(A.quiet)} | ${pct(B.quiet)} | ${A.quiet === null || B.quiet === null ? '—' : `${((B.quiet - A.quiet) * 100).toFixed(1)} pt`} |`);
    lines.push(`| mean \\|v\\| powder | ${num(A.vPowder)} | ${num(B.vPowder)} | ${A.vPowder === null || B.vPowder === null ? '—' : num(B.vPowder - A.vPowder)} |`);
    lines.push(`| mean \\|v\\| liquid | ${num(A.vLiquid)} | ${num(B.vLiquid)} | ${A.vLiquid === null || B.vLiquid === null ? '—' : num(B.vLiquid - A.vLiquid)} |`);
    const [a0, b0] = [byBuild.A.initial, byBuild.B.initial];
    const same = a0.energy === b0.energy && Object.keys({ ...a0.cells, ...b0.cells }).every((k) => a0.cells[k] === b0.cells[k]);
    lines.push('', `At load: A and B ${same ? 'identical' : 'differ'} (energy ${num(byBuild.A.initial.energy, 1)} / ${num(byBuild.B.initial.energy, 1)}).`, '');
    for (const b of ['A', 'B']) {
      for (const when of ['initial', 'settled']) {
        const c = byBuild[b][when];
        if (c.crossCheck === false) warn(`${sc} ${b} ${when}: cell counts disagree with the build's sim.census() (cell mapping ${c.mapping})`);
      }
    }
  }
}
if (report.warnings.length) lines.push('', ...report.warnings.map((w) => `**warning:** ${w}`));
console.log(lines.join('\n'));
if (opt('out')) writeFileSync(opt('out'), JSON.stringify(report, null, 2));
