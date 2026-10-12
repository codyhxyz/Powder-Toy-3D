// Performance per watt on the Mac (docs/webgpu.md I5; docs/v2.md 7.5, 11
// "Week 0": the baselines of today's build). Runs scenarios of 60 s each in
// a real browser on the real GPU while `powermetrics` samples the CPU and GPU
// power, and reports per scenario the mean GPU, CPU and package mW, mJ per
// sim step and per presented frame, submits/s and rAF callbacks/s:
//
//   blank         about:blank in the same browser: the floor under the others
//   box-settled   the lab at 128³, paused, the camera still: nothing changing
//                 (deep idle: today's build makes no submits and no rAF here)
//   lab-running   the lab at 128³ running (the default 4 steps a frame)
//   island-still  the default World island scene, the camera still (birds,
//                 Whitewater, the far field: whatever the build does unasked)
//   island-walk   the island in first person: W held, a quarter turn every 4 s
//   world-flight  the island's god view flying a 60 s circle over the world
//                 (~17 cells/s: the window shifts a slab about every second)
//
// Every page gets the same seed: Math.random is a seeded PRNG from before the
// app loads (the presets' per-cell seeds come from it), and --seed N also sets
// the world's (?seed=N; without it, the island's default world).
//
// Engine-agnostic: the tool reads only __app.gpu.stats.submits,
// __app.loop.callbacks, __app.sim.frame, __app.camera, __app.controls,
// __app.pov (enter, setLook, test.assumeLocked, player.pos), __app.sim.origin
// and __app.win.loaded, and counts presents itself (each
// GPUCanvasContext.getCurrentTexture call). A candidate build that names
// these differently provides __app.powerStats() -> { submits, rafCallbacks,
// simSteps } and keeps the URL parameters (?size, ?preset, ?paused, ?map,
// ?seed).
//
// On the Mac (Apple Silicon), from a checkout with node_modules installed:
//
//   1. sudo powermetrics --samplers gpu_power,cpu_power -i 500 -o /tmp/tpt3d-power.txt
//      (in another terminal; or let the tool start it when `sudo -n` works,
//      e.g. right after another sudo command)
//   2. node tools/power.mjs --power-file /tmp/tpt3d-power.txt --out power-today.json
//
// It builds the checkout (vite build) and serves it with vite preview: the
// production build players get. --url measures any served build instead
// (the live site, /v1/, a candidate's preview), --root another checkout
// (today's build: a checkout of the frozen port). The browser is a headed
// window on the real GPU (Playwright's Chromium, or --channel chrome for the
// installed Chrome), 1512×982 CSS pixels (the 14" MacBook Pro's default) at
// the display's devicePixelRatio, in front, on mains power, other apps quit.
// Leave the machine alone while it runs: ~10 minutes for all scenarios.
//
// In the container (no powermetrics, no GPU): --dry runs every scenario for a
// few seconds without powermetrics and checks it does what it says:
// box-settled makes no submits and no rAF callbacks, lab-running steps the
// sim, island-still's camera stays put while it presents, island-walk moves
// the player across the ground, world-flight moves the camera. It runs in
// preview test mode on a private dev server, scaled down so SwiftShader can
// draw it at all: a 64³ box, a 64-wide world window, the plain view, TAA off
// in the settled box, and the walk in an empty box. Give each scenario its own
// run there (--scenarios island-walk): each takes 1-3 minutes on SwiftShader.
//
// usage: node tools/power.mjs [--scenarios blank,box-settled,lab-running,island-still,island-walk,world-flight]
//          [--seconds 60] [--settle 5] [--cool 5] [--url <base url>] [--root <checkout>] [--serve build|dev]
//          [--port N] [--power-file <powermetrics -o file>] [--no-powermetrics] [--channel chrome]
//          [--headless] [--window 1512x982] [--mode none|visual|preview] [--seed N] [--out results.json] [--dry]
//          [--size 128] [--win N] [--view plain]
//        node tools/power.mjs --parse-power <powermetrics -o file>   (what it reads from one)
//   --mode   none (the default): the page as a player gets it, no test mode; visual: tools/browser.mjs's
//            full-cadence test mode (it adds the port's test-mode checks, a little CPU)
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage } from './browser.mjs';
import { freePort } from './vite-server.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const DRY = has('dry');
const MAC = process.platform === 'darwin';
const O = {
  scenarios: opt('scenarios', 'blank,box-settled,lab-running,island-still,island-walk,world-flight').split(','),
  seconds: Number(opt('seconds', DRY ? 8 : 60)),
  settle: Number(opt('settle', DRY ? 1 : 5)),
  cool: Number(opt('cool', DRY ? 0 : 5)),
  url: opt('url', null),
  root: resolve(opt('root', HERE)),
  serve: opt('serve', DRY ? 'dev' : 'build'),
  port: Number(opt('port', 0)) || null,
  powerFile: opt('power-file', null),
  powermetrics: !DRY && !has('no-powermetrics'),
  channel: opt('channel', undefined),
  headless: DRY || has('headless') || !MAC,
  window: opt('window', DRY ? '640x400' : '1512x982').split('x').map(Number),
  mode: opt('mode', DRY ? 'preview' : 'none'),
  // the container's reductions for --dry (SwiftShader draws a 128³ lab's first frames in about a minute each):
  // a 64³ box, a 64-wide world window, the plain view, and TAA off for the settled box (it settles in a few
  // frames instead of TAA's 109). The Mac run takes the scenarios as listed.
  size: Number(opt('size', DRY ? 64 : 128)),
  win: opt('win', DRY ? '64' : null),
  view: opt('view', DRY ? 'plain' : null),
  seed: opt('seed', null),
  out: opt('out', null),
  bootTimeout: Number(opt('boot-timeout', DRY ? 170 : 120)) * 1000,
};
const POWERMETRICS = ['powermetrics', '--samplers', 'gpu_power,cpu_power', '-i', '500'];

// ---- the scenarios: a URL, when the page is ready, what drives it, and what the dry run checks
const SCENARIOS = {
  blank: { url: null, about: 'about:blank: the browser alone' },
  'box-settled': {
    query: `?size=${O.size}&preset=lab&paused=1`,
    about: `the lab at ${O.size}³, paused, camera still`,
    ready: async (page) => {
      if (DRY) await waitFor(page, () => window.__app?.post, 'the app').then(() => page.evaluate(() => { window.__app.post.settings.taa = false; }));
      await waitFor(page, () => window.__app?.sim && window.__app.loop?.asleep, 'the loop asleep (deep idle)');
    },
    check: (a, b) => [['no submits and no rAF callbacks while settled', b.submits - a.submits === 0 && b.rafCallbacks - a.rafCallbacks === 0,
      `${b.submits - a.submits} submits, ${b.rafCallbacks - a.rafCallbacks} rAF callbacks`]],
  },
  'lab-running': {
    query: `?size=${O.size}&preset=lab`,
    about: `the lab at ${O.size}³ running`,
    ready: (page) => waitFor(page, () => window.__app?.sim?.frame > 0, 'the sim stepping'),
    until: (a, b) => b?.simSteps > a.simSteps,
    check: (a, b) => [['the sim steps advance', b.simSteps > a.simSteps, `${b.simSteps - a.simSteps} steps`]],
  },
  'island-still': {
    query: `?map=island${O.win ? `&win=${O.win}` : ''}`,
    about: 'the World island, camera still',
    ready: waitWorld,
    until: (a, b) => b?.presents > a.presents,
    check: (a, b) => [
      ['the world is loaded', b.loaded === true, `win.loaded ${b.loaded}`],
      ['the camera stays put', dist(a.cam, b.cam) < 1e-3, `moved ${dist(a.cam, b.cam).toFixed(4)} units`],
      ['it presents frames', b.presents > a.presents, `${b.presents - a.presents} presents`],
    ],
  },
  'island-walk': {
    // (--dry walks in an empty box: on SwiftShader the island's load plus the first-person kernels' compile
    // take longer than a container browser run should)
    query: DRY ? `?size=${O.size}&preset=empty` : `?map=island${O.win ? `&win=${O.win}` : ''}`,
    about: DRY ? `first person in an empty ${O.size}³ box (--dry), walking a square` : 'the island in first person, walking a square',
    ready: async (page) => {
      if (DRY) await waitFor(page, () => window.__app?.pov, 'the app');
      else await waitWorld(page);
      await page.mouse.move(O.window[0] / 2, O.window[1] / 2);
      await page.evaluate(async () => {
        const a = window.__app;
        await a.pov.enter({ swoop: 0, hint: false });
        a.pov.test.assumeLocked = true;   // (a pointer lock is a user gesture's to grant)
      });
      await waitFor(page, () => window.__app.pov.mode === 'on' && window.__app.pov.player?.onGround, 'the body standing');
    },
    start: async (page) => { await page.evaluate(() => window.__app.pov.setLook(0, 0)); await page.keyboard.down('w'); },
    // a quarter turn every 4 s, from the wall clock: a square, back near the start
    tick: (page, t) => page.evaluate((k) => window.__app.pov.setLook(k * Math.PI / 2, 0), Math.floor(t / 4)),
    stop: (page) => page.keyboard.up('w'),
    until: (a, b, legs) => legs.filter(Number.isFinite).reduce((t, x) => t + x, 0) > 1,
    check: (a, b) => [['the player walks', b.walked > 1, `${b.walked.toFixed(1)} cells walked across the ground (sum of 1 s legs)`]],
  },
  'world-flight': {
    query: `?map=island${O.win ? `&win=${O.win}` : ''}`,
    about: 'the island god view flying a circle',
    ready: waitWorld,
    // the orbit target (and the camera with it) once round a circle of 160 cells in 60 s from where it was:
    // ~17 cells/s (5 m/s, a drone's cruise), so the window shifts a slab about every second; well under
    // app.js WORLD_CAM_SPEED_MAX (9 scene units/s, 115 cells/s at 128 wide)
    start: (page) => page.evaluate(() => {
      const a = window.__app, t0 = performance.now(), s = a.scale ?? 1;
      const target0 = a.controls.target.clone(), off = a.camera.position.clone().sub(target0), R = 160 * s;
      const fly = { on: true };
      window.__powerFlight = fly;
      const step = (now) => {
        if (!fly.on) return;
        const th = 2 * Math.PI * (now - t0) / 60000;
        a.controls.target.set(target0.x + R * (Math.cos(th) - 1), target0.y, target0.z + R * Math.sin(th));
        a.camera.position.copy(a.controls.target).add(off);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }),
    stop: (page) => page.evaluate(() => { if (window.__powerFlight) window.__powerFlight.on = false; }),
    until: (a, b) => dist(a.cam, b?.cam) > 1e-3,
    check: (a, b) => [
      ['the camera moves', dist(a.cam, b.cam) > 1e-3,
        `moved ${dist(a.cam, b.cam).toFixed(2)} units; the window's origin ${a.origin?.join(',')} → ${b.origin?.join(',')}`],
    ],
  },
};
const dist = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : NaN);

async function waitFor(page, fn, what, timeout = O.bootTimeout) {
  try {
    await page.waitForFunction(fn, null, { polling: 250, timeout });
  } catch {
    const err = await page.evaluate(() => document.getElementById('error')?.textContent || null).catch(() => null);
    throw new Error(`timed out waiting for ${what}${err ? `; the page shows: ${err.slice(0, 300)}` : ''}`);
  }
}
async function waitWorld(page) {
  await waitFor(page, () => window.__app?.win?.loaded, 'the world window loaded');
  // the far field's detail settling (today's build: world/far.js); best effort, a build without it goes on
  // (--dry skips it: the checks don't need it, and SwiftShader takes minutes)
  if (DRY) return;
  await page.waitForFunction(() => {
    const d = window.__app.win?.far?.detail;
    return !d || (!d.pending && d.wanted.every((c) => d.entries.has(c.key) || d.blocked.has(c.key)));
  }, null, { polling: 500, timeout: 60000 }).catch(() => console.log('  (the far field was still filling in)'));
}

// ---- in the page: the seeded PRNG and the present counter (init scripts, before the app loads)
function initPage(seed) {
  let s = seed >>> 0;
  Math.random = () => {   // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.__powerPresents = 0;
  if (window.GPUCanvasContext) {
    const get = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function (...a) { window.__powerPresents++; return get.apply(this, a); };
  }
}
const snapshot = (page) => page.evaluate(() => {
  const a = window.__app;
  const own = a?.powerStats?.() ?? {};
  const pos = a?.pov?.player?.pos, o = a?.sim?.origin;
  return {
    t: performance.now(), wall: Date.now(),
    submits: own.submits ?? a?.gpu?.stats?.submits ?? null,
    rafCallbacks: own.rafCallbacks ?? a?.loop?.callbacks ?? null,
    simSteps: own.simSteps ?? a?.sim?.frame ?? null,
    presents: window.__powerPresents ?? null,
    cam: a?.camera ? a.camera.position.toArray() : null,
    origin: o ? [o.x, o.y, o.z] : null,
    player: pos ? [pos.x + (o?.x ?? 0), pos.y + (o?.y ?? 0), pos.z + (o?.z ?? 0)] : null,
    loaded: a?.win ? Boolean(a.win.loaded) : null,
  };
});

// ---- the server: a URL, or a private vite (build + preview, or dev) of a checkout, killed at exit
const children = new Set();
const killAll = () => { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } children.clear(); };
process.on('exit', killAll);
function run(cmd, argv, cwd, { wait = null } = {}) {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, argv, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(c);
    let out = '';
    const on = (d) => { out += d; if (wait && wait.test(out)) ok({ child: c, out }); };
    c.stdout.on('data', on);
    c.stderr.on('data', on);
    c.on('exit', (code) => { children.delete(c); if (wait) fail(new Error(`${cmd} ${argv.join(' ')} exited (${code}):\n${out.slice(-2000)}`)); else if (code) fail(new Error(`${cmd} ${argv.join(' ')} failed (${code}):\n${out.slice(-2000)}`)); else ok({ out }); });
  });
}
async function serve() {
  if (O.url) return { base: O.url.replace(/\/?$/, '/'), close: async () => {} };
  const vite = join(O.root, 'node_modules/.bin/vite');
  if (!existsSync(vite)) throw new Error(`${O.root}: no node_modules/.bin/vite (npm install there first)`);
  const port = O.port ?? await freePort();
  let started;
  if (O.serve === 'build') {
    const outDir = mkdtempSync(join(tmpdir(), 'tpt3d-power-'));
    console.log(`building ${O.root} → ${outDir}`);
    await run(vite, ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], O.root);
    started = await run(vite, ['preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], O.root, { wait: /Local:/ });
  } else {
    started = await run(vite, ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], O.root, { wait: /Local:/ });
  }
  return { base: `http://127.0.0.1:${port}/`, close: async () => { try { process.kill(-started.child.pid, 'SIGTERM'); } catch { /* gone */ } children.delete(started.child); } };
}

// ---- powermetrics: started here when sudo -n is allowed, else the user's, read from its -o file
async function startPowermetrics() {
  if (!O.powermetrics) return null;
  if (!MAC) throw new Error('powermetrics is macOS only: run with --dry here, or on the Mac');
  let file = O.powerFile, child = null;
  let sudo = false;
  try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' }); sudo = true; } catch { /* needs a password */ }
  if (!file && sudo) {
    file = join(mkdtempSync(join(tmpdir(), 'tpt3d-pm-')), 'powermetrics.txt');
    child = spawn('sudo', ['-n', ...POWERMETRICS, '-o', file], { detached: true, stdio: 'ignore' });
    children.add(child);
    console.log(`powermetrics: started (sudo -n), writing ${file}`);
  } else {
    file ??= '/tmp/tpt3d-power.txt';
    console.log(`powermetrics: run this in another terminal, then leave it running:\n\n  sudo ${POWERMETRICS.join(' ')} -o ${file}\n`);
  }
  const t0 = Date.now();
  while (!(existsSync(file) && parseSamples(readFileSync(file, 'utf8')).length)) {
    if (Date.now() - t0 > (child ? 30000 : 600000)) throw new Error(`no powermetrics samples in ${file}`);
    await sleep(1000);
  }
  console.log(`powermetrics: sampling into ${file}`);
  return { file, child };
}
// powermetrics' text: '*** Sampled system activity (Mon Oct 12 13:00:00 2026 -0700) (502.31ms elapsed) ***',
// then 'CPU Power: 812 mW', 'GPU Power: 102 mW', 'ANE Power: 0 mW', 'Combined Power (CPU + GPU + ANE): 914 mW',
// 'GPU HW active residency:   3.21% (...)'. A sample's time is its header's (whole seconds).
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseSamples(text) {
  const out = [];
  for (const block of text.split('*** Sampled system activity').slice(1)) {
    const h = /\(\w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d{4}) ([+-])(\d\d)(\d\d)\) \(([\d.]+)ms elapsed\)/.exec(block);
    if (!h) continue;
    const [, mon, day, hh, mm, ss, yr, sign, oh, om, elapsed] = h;
    const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
    const t = Date.UTC(Number(yr), MONTHS[mon], Number(day), Number(hh), Number(mm), Number(ss)) - offset * 60000;
    const s = { t, elapsedMs: Number(elapsed) };
    for (const m of block.matchAll(/^(CPU|GPU|ANE|DRAM|Package|Combined) Power[^:\n]*:\s*([\d.]+)\s*mW/gm)) s[m[1].toLowerCase()] ??= Number(m[2]);
    const r = /GPU HW active residency:\s*([\d.]+)%/.exec(block);
    if (r) s.gpuActive = Number(r[1]);
    if (s.cpu != null || s.gpu != null) out.push(s);
  }
  return out;
}

// ---- IOAccelerator's utilization (no sudo), sampled each second on the Mac
function ioreg() {
  try {
    const t = execFileSync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { encoding: 'utf8', timeout: 2000 });
    const n = (k) => { const m = new RegExp(`"${k}"=(\\d+)`).exec(t); return m ? Number(m[1]) : null; };
    return { device: n('Device Utilization %'), renderer: n('Renderer Utilization %'), tiler: n('Tiler Utilization %') };
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (v) => { const x = v.filter((y) => y != null && Number.isFinite(y)); return x.length ? x.reduce((s, y) => s + y, 0) / x.length : null; };
const r1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

async function measure(browser, name, base) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`no scenario ${name} (${Object.keys(SCENARIOS).join(', ')})`);
  const [w, h] = O.window;
  const pageOpts = O.headless ? { viewport: { width: w, height: h } } : { viewport: null };
  const page = O.mode === 'none' ? await browser.newPage(pageOpts) : await newTestPage(browser, { mode: O.mode, ...pageOpts });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message || e).slice(0, 300)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|favicon/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`); });
  const r = { scenario: name, about: sc.about, url: null };
  try {
    if (sc.url === null && !sc.query) await page.goto('about:blank');
    else {
      await page.addInitScript(initPage, Number(O.seed ?? 1));
      r.url = `${base}${sc.query}${O.view ? `&view=${O.view}` : ''}${O.seed != null ? `&seed=${O.seed}` : ''}`;
      const t0 = Date.now();
      await page.goto(r.url);
      await sc.ready?.(page);
      r.bootS = r1((Date.now() - t0) / 1000);
      await sc.start?.(page);
    }
    await sleep(O.settle * 1000);
    const a = await snapshot(page);
    const legs = [];
    let last = a.player, util = [];
    const t0 = Date.now();
    // --dry: past its seconds, a window goes on (up to a minute) until its check can tell: SwiftShader's
    // frames of an awake grid take seconds each
    let b = null;
    for (let s = 0; s < O.seconds || (DRY && sc.until && s < O.seconds + 60 && !sc.until(a, b, legs)); s++) {
      await sleep(Math.max(0, t0 + (s + 1) * 1000 - Date.now()));
      if (sc.tick) await sc.tick(page, s + 1);
      if (name === 'island-walk') {   // across the ground: x and z (a fall isn't a walk)
        const p = (await snapshot(page)).player;
        legs.push(p && last ? Math.hypot(p[0] - last[0], p[2] - last[2]) : NaN);
        last = p;
      }
      if (MAC && !DRY) util.push(ioreg());
      if (DRY && sc.until) b = await snapshot(page);
    }
    b = await snapshot(page);
    await sc.stop?.(page);
    b.walked = legs.filter(Number.isFinite).reduce((s, x) => s + x, 0);
    const secs = (b.t - a.t) / 1000;
    const rate = (k) => (a[k] == null || b[k] == null ? null : r1((b[k] - a[k]) / secs, 2));
    Object.assign(r, {
      window: { start: a.wall, end: b.wall, seconds: r1(secs, 2) },
      counts: Object.fromEntries(['submits', 'rafCallbacks', 'simSteps', 'presents'].map((k) => [k, a[k] == null || b[k] == null ? null : b[k] - a[k]])),
      perSecond: { submits: rate('submits'), rafCallbacks: rate('rafCallbacks'), simSteps: rate('simSteps'), presents: rate('presents') },
      ioAccelerator: util.length ? {
        device: r1(mean(util.map((u) => u?.device))), renderer: r1(mean(util.map((u) => u?.renderer))), tiler: r1(mean(util.map((u) => u?.tiler))),
      } : null,
    });
    if (sc.check) r.checks = sc.check(a, b).map(([what, ok, info]) => ({ what, ok: Boolean(ok), info }));
  } catch (e) {
    r.error = String(e.message || e);
  } finally {
    r.errors = errors;
    await page.close().catch(() => {});
  }
  return r;
}

// the samples inside a scenario's window, a second off each end (the headers' times are whole seconds)
function attachPower(r, samples) {
  if (!r.window) return;
  const inside = samples.filter((s) => s.t >= r.window.start + 1000 && s.t <= r.window.end - 1000);
  if (!inside.length) { r.power = { samples: 0 }; return; }
  const m = (k) => mean(inside.map((s) => s[k]));
  const pkg = m('combined') ?? m('package') ?? ((m('cpu') ?? 0) + (m('gpu') ?? 0) + (m('ane') ?? 0));
  const joules = (mw) => (mw == null ? null : mw * r.window.seconds);   // mW × s = mJ
  r.power = {
    samples: inside.length,
    mW: { gpu: r1(m('gpu')), cpu: r1(m('cpu')), ane: r1(m('ane')), dram: r1(m('dram')), package: r1(pkg) },
    gpuActivePercent: r1(m('gpuActive')),
    mJ: {
      perSimStep: r.counts.simSteps ? r1(joules(pkg) / r.counts.simSteps, 2) : null,
      perPresent: r.counts.presents ? r1(joules(pkg) / r.counts.presents, 2) : null,
      gpuPerPresent: r.counts.presents ? r1(joules(m('gpu')) / r.counts.presents, 2) : null,
    },
  };
}

// --parse-power <file>: what this tool reads from a powermetrics -o file (a check of its format)
if (opt('parse-power', null)) {
  const samples = parseSamples(readFileSync(opt('parse-power'), 'utf8'));
  const m = (k) => r1(mean(samples.map((x) => x[k])));
  console.log(`${samples.length} samples${samples.length ? `, ${new Date(samples[0].t).toISOString()} to ${new Date(samples.at(-1).t).toISOString()}` : ''}`);
  console.log(`mean mW: CPU ${m('cpu')}, GPU ${m('gpu')}, ANE ${m('ane')}, DRAM ${m('dram')}, combined ${m('combined')}; GPU active ${m('gpuActive')} %`);
  process.exit(samples.length ? 0 : 1);
}

// ---- the run
const results = {
  tool: 'tools/power.mjs', version: 1, date: new Date().toISOString(), dry: DRY, options: O,
  machine: MAC ? (() => { try { return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { return null; } })() : process.platform,
  powermetrics: null, scenarios: [],
};
let failures = 0;
const server = await serve();
let pm = null, browser = null;
try {
  pm = await startPowermetrics();
  results.powermetrics = pm ? { command: `sudo ${POWERMETRICS.join(' ')} -o ${pm.file}`, file: pm.file } : null;
  const perScenario = (O.seconds + O.settle + O.cool) * 1000 + O.bootTimeout + 60000;
  browser = await launchBrowser({
    headless: O.headless, ...(O.channel ? { channel: O.channel } : {}),
    lifetimeMs: perScenario * O.scenarios.length + 120000,
    args: O.headless ? [] : [`--window-size=${O.window[0]},${O.window[1]}`, '--window-position=0,0'],
  });
  const gpu = await (async () => {
    const p = await browser.newPage();
    try {
      await p.goto(`${server.base}robots.txt`);   // (a page of the build's origin that runs nothing: WebGPU needs a secure origin)
      return await p.evaluate(async () => {
        const ad = await navigator.gpu?.requestAdapter();
        const i = ad?.info ?? {};
        return ad ? { vendor: i.vendor, architecture: i.architecture, description: i.description, isFallbackAdapter: i.isFallbackAdapter ?? ad.isFallbackAdapter } : null;
      });
    } catch { return null; } finally { await p.close(); }
  })();
  results.adapter = gpu;
  console.log(`build: ${server.base}  adapter: ${JSON.stringify(gpu)}${gpu?.isFallbackAdapter ? ' (software: not a power measurement)' : ''}`);
  for (const name of O.scenarios) {
    console.log(`\n${name}: ${SCENARIOS[name]?.about ?? '?'}`);
    const r = await measure(browser, name, server.base);
    results.scenarios.push(r);
    if (r.error) { failures++; console.log(`  FAIL ${r.error}`); }
    if (r.counts) console.log(`  ${r.window.seconds} s${r.bootS != null ? ` (booted in ${r.bootS} s)` : ''}: ${Object.entries(r.perSecond).map(([k, v]) => `${k}/s ${v ?? '–'}`).join(', ')}`);
    for (const c of r.checks ?? []) {
      if (DRY && !c.ok) failures++;
      if (DRY) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}: ${c.info}`);
    }
    if (r.errors.length) console.log(`  page errors: ${r.errors.slice(0, 3).join(' | ')}`);
    if (O.cool) await sleep(O.cool * 1000);
  }
  if (pm) {
    // the samples past the last window's end, then stop ours
    const end = Math.max(...results.scenarios.map((r) => r.window?.end ?? 0));
    const t0 = Date.now();
    let samples = [];
    while (Date.now() - t0 < 30000) {
      samples = parseSamples(readFileSync(pm.file, 'utf8'));
      if (samples.some((s) => s.t > end + 1000)) break;
      await sleep(1000);
    }
    if (pm.child) { try { process.kill(-pm.child.pid, 'SIGINT'); } catch { /* gone */ } }
    else console.log(`\npowermetrics: done with ${pm.file}; stop it (Ctrl-C in its terminal)`);
    results.powermetrics.samples = samples.length;
    results.powermetrics.bytes = statSync(pm.file).size;
    for (const r of results.scenarios) attachPower(r, samples);
  }
} finally {
  await browser?.close();
  await server.close();
  killAll();
}

// ---- the report
console.log('\nscenario         s   GPU mW  CPU mW  pkg mW  mJ/step  mJ/frame  submits/s  rAF/s  steps/s  presents/s');
for (const r of results.scenarios) {
  const p = r.power?.mW ?? {}, j = r.power?.mJ ?? {}, f = r.perSecond ?? {};
  const c = (v, n) => String(v ?? '–').padStart(n);
  console.log(`${r.scenario.padEnd(15)}${c(r.window?.seconds != null ? Math.round(r.window.seconds) : null, 4)}${c(p.gpu, 8)}${c(p.cpu, 8)}${c(p.package, 8)}${c(j.perSimStep, 9)}${c(j.perPresent, 10)}${c(f.submits, 11)}${c(f.rafCallbacks, 7)}${c(f.simSteps, 9)}${c(f.presents, 12)}`);
}
if (!pm) console.log(DRY ? '\n(--dry: no power numbers; SwiftShader in a container, the rates are not representative either)' : '\n(no powermetrics: rates only)');
if (O.out) { writeFileSync(O.out, JSON.stringify(results, null, 1)); console.log(`\nJSON: ${O.out}`); }
console.log(failures ? `\npower: ${failures} failed` : `\npower: ${DRY ? 'dry run ok' : 'done'}`);
process.exit(failures ? 1 : 0);
