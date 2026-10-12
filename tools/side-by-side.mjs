// Two builds side by side (docs/v2.md 11, Week 0): every shot of the shot
// list (tools/side-by-side/shots.mjs) captured from both with the same scene,
// camera, seed and game time, as stills and 5 s clips, composited A|B with
// labels, and a contact sheet (index.html) with every pair and the run's
// metadata. Every later phase is judged on this sheet against today's game.
//
//   node tools/side-by-side.mjs --a-dir <checkout> --b-dir <checkout> [options]
//   node tools/side-by-side.mjs --a <url> --b <url> [options]
//   node tools/side-by-side.mjs --list [--links <url>]
//
// The builds:
//   --a-dir, --b-dir  a checkout each: the tool starts a Vite dev server in it
//                     (127.0.0.1, its own port from --port, strictPort, no
//                     watching, Vite's cache outside the checkout) and stops it
//   --a, --b          a running build's URL; its query, if any (?engine=v2),
//                     goes on every page of that side
//   (neither)         this checkout against itself: the determinism check
//   --a-label, --b-label   what the sheet calls them (default: the commit and
//                     branch of a checkout, else the URL)
// The shots:
//   --shots <names>   comma-separated names, or 'stills', 'clips' (default: all)
//   --list            print the shot list and exit; --links <url> also prints
//                     each shot's ?shot= link on that build (src/shot.js: the
//                     same scene, camera and time on a phone, then it plays)
// The capture:
//   --size WxH        the page (default 1280x720)
//   --clip-seconds S  each clip's length (default 5)
//   --fps N           clip frames a game second (default 30)
//   --quality q       full (default): stills converge the view (render(page)'s
//                     checkpoint) and clips draw every game tick, the TAA
//                     history built as a player's screen builds it; draft:
//                     TAA off, two frames a still and one a clip frame (the
//                     container's only affordable mode)
//   --settings p      today's settings before boot: default, phone (the
//                     iPhone's look: app.js MOBILE_DEFAULTS) or a JSON object
//   --box N           run box scenes on an N³ box instead of their own (their
//                     positions scale); --win N: world windows N wide (?win=)
//   --time-scale f    every shot's game time before its capture (and a clip's
//                     lead-in) times f: the container's smoke runs only, where a
//                     game second of steps takes minutes
//   --out <dir>       where the run goes (default .tmp-side-by-side/<time>);
//                     --append keeps the shots an earlier run left there on the sheet
//   --serial          one side after the other (default: both at once; the
//                     frames don't depend on it, the timings do)
//   --fresh           a new page for every shot (default: one page per boot
//                     query, the shot loading its own scene, as regress.mjs does)
//   --port N          the first port for --a-dir/--b-dir servers (default 5641)
//   --timeout S       a side's limit per shot (default 900)
//   --real-gpu        refuse a software adapter (tools/browser.mjs; the default on macOS)
//
// The Mac (full quality: 1280×720, 5 s clips at 30 fps, every shot), with
// today's build checked out beside this one (git worktree add ../v1 c953a6c,
// then npm ci in it):
//   node tools/side-by-side.mjs --a-dir ../v1 --b-dir . --out ~/Desktop/sbs
//   open ~/Desktop/sbs/index.html
// A shot group at a time into one sheet (--append), e.g. the stills first:
//   node tools/side-by-side.mjs --a-dir ../v1 --b-dir . --shots stills --out ~/Desktop/sbs --append
// This container (SwiftShader: a 64³ step is ~1 s and a 320×180 frame
// 15-80 s, so everything is cut down, and its timings aren't a GPU's): one
// group per run, each side in turn, as the Week 0 sweep ran it:
//   node tools/side-by-side.mjs --a-dir /home/user/wt/v1 --b-dir . --shots lab,lab-tank \
//     --size 320x180 --quality draft --box 64 --win 64 --time-scale 0.1 \
//     --clip-seconds 0.25 --fps 8 --serial --append --out <dir>
//
// Pages run in 'manual' test mode (CLAUDE.md): the loop is parked from boot,
// so neither side draws a frame or steps the grid on its own time, and both
// start their TAA jitter at the same index. Every step, body update and frame
// is the shot runner's (tools/side-by-side/engine.mjs), in game time; so the
// frames are the same on a fast and a slow machine. The shot code is served
// from this checkout to both pages (/__sbs/), so a build without it (a frozen
// one) runs the same shots. A page that sets window.__shotEngine (a v2 engine)
// is driven through it instead of today's.
//
// Output, in --out: <shot>/a.png, b.png, ab.png (labelled, A left), diff.png
// (|A−B| ×4); a clip's a/, b/, ab/ frames and ab.mp4 (ffmpeg, libx264; without
// ffmpeg the sheet plays the frames); run.json; index.html, the sheet.
// ImageMagick isn't needed: the compositing is a canvas in the same browser.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { SHOTS, CLIP_SECONDS } from './side-by-side/shots.mjs';
import { bootQuery, PROFILES, SETTINGS_STORE } from './side-by-side/engine.mjs';
import { sheetHtml } from './side-by-side/sheet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SBS = join(HERE, 'side-by-side');
const SBS_ORIGIN = 'http://sbs.invalid';   // the compositor's made-up origin (routed, never fetched)
const BOOT_TIMEOUT_MS = 600000;            // a world's first boot is minutes on SwiftShader
const SERVER_WAIT_MS = 180000;
const DEFAULT_PORT = 5641;                 // W0-C's range (5300-5999), away from Vite's 5173
// what a page may log without it counting against the shot (no relay server here)
const IGNORE = [/ERR_CONNECTION_REFUSED/, /Failed to load resource/];

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

// ---------------------------------------------------------------- the shot list
const wanted = (() => {
  const s = opt('shots', 'all');
  if (s === 'all') return SHOTS;
  const names = s.split(',').filter(Boolean);
  const out = [];
  for (const n of names) {
    if (n === 'stills' || n === 'clips') out.push(...SHOTS.filter((x) => x.kind === n.slice(0, -1)));
    else {
      const shot = SHOTS.find((x) => x.name === n);
      if (!shot) { console.error(`no shot '${n}': ${SHOTS.map((x) => x.name).join(', ')}`); process.exit(2); }
      out.push(shot);
    }
  }
  return [...new Set(out)];
})();

if (has('list') || has('links')) {
  const base = opt('links');
  for (const s of SHOTS) {
    const link = base ? `  ${new URL(`?shot=${s.name}`, base).href}` : '';
    console.log(`${s.name.padEnd(18)} ${s.kind.padEnd(5)} ${s.title}${link}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- options
const [W, H] = opt('size', '1280x720').split('x').map(Number);
if (!(W > 0 && H > 0) || W % 2 || H % 2) { console.error('--size WxH, both even'); process.exit(2); }
const CLIP_S = Number(opt('clip-seconds', CLIP_SECONDS));
const FPS = Number(opt('fps', 30));
const QUALITY = opt('quality', 'full');
if (!['full', 'draft'].includes(QUALITY)) { console.error('--quality full or draft'); process.exit(2); }
const BOX = opt('box');
const WIN = opt('win');
const SETTINGS_ARG = opt('settings', 'default');
const SETTINGS = PROFILES[SETTINGS_ARG] ?? JSON.parse(SETTINGS_ARG);
const SHOT_TIMEOUT_MS = Number(opt('timeout', 900)) * 1000;
const TIME_SCALE = Number(opt('time-scale', 1));
const PORT = Number(opt('port', DEFAULT_PORT));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(opt('out', join(ROOT, '.tmp-side-by-side', stamp)));
for (const s of wanted) {
  try { bootQuery(s.scene, { box: boxFor(s), win: WIN }); } catch (e) { console.error(`${s.name}: ${e.message}`); process.exit(2); }
}
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const log = (s) => console.log(`[${elapsed().padStart(6)}] ${s}`);

// ---------------------------------------------------------------- the builds
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function checkoutLabel(dir) {
  const commit = git(dir, 'rev-parse', '--short', 'HEAD');
  if (!commit) return dir;
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = git(dir, 'status', '--porcelain', '--untracked-files=no') ? ', uncommitted changes' : '';
  return `${commit} (${branch === 'HEAD' ? 'detached' : branch}${dirty})`;
}

// A Vite dev server rooted at a checkout, with that checkout's config, on
// 127.0.0.1:port: Vite's JS API from this checkout (as tools/vite-server.mjs),
// no file watching or HMR, and its dependency cache in the OS's temp dir so
// the checkout itself isn't written to.
async function serveCheckout(dir, port, side) {
  const { createServer } = await import('vite');
  const cacheDir = join(os.tmpdir(), 'tpt3d-side-by-side-vite', `${createHash('sha1').update(dir).digest('hex').slice(0, 12)}-${side}`);
  const server = await createServer({
    root: dir,
    configFile: join(dir, 'vite.config.js'),
    cacheDir,
    mode: 'development',
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

const sides = {};
for (const k of ['a', 'b']) {
  const url = opt(k), dir = opt(`${k}-dir`) ?? (url ? null : ROOT);
  sides[k] = { key: k, url, dir: dir ? resolve(dir) : null, label: opt(`${k}-label`), server: null, extra: {} };
}
if (!opt('a') && !opt('a-dir') && !opt('b') && !opt('b-dir')) log('no builds given: this checkout against itself (the determinism check)');

const servers = [];
async function startServers() {
  let port = PORT;
  // a server per side, even when both are the same checkout (the self-check): nothing shared
  for (const s of Object.values(sides)) {
    if (!s.dir) continue;
    if (!existsSync(join(s.dir, 'vite.config.js'))) throw new Error(`${s.dir}: not a checkout of this game (no vite.config.js)`);
    s.server = await serveCheckout(s.dir, port++, s.key);
    servers.push(s.server);
    s.url = s.server.url;
    s.label ??= checkoutLabel(s.dir);
    log(`${s.key.toUpperCase()}: ${s.dir} on ${s.url} (${s.label})`);
  }
  for (const s of Object.values(sides)) {
    const u = new URL(s.url);
    for (const [k, v] of u.searchParams) s.extra[k] = v;   // a URL's own query: on every page of that side
    u.search = '';
    s.base = u.href;
    s.label ??= s.url;
  }
}

// ---------------------------------------------------------------- a side's pages
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' };
// /__sbs/<file>: this checkout's shot code, on any build's origin
async function routeShotCode(page) {
  await page.route(/\/__sbs\/[\w.-]+$/, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const file = join(SBS, name);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'no such file' });
    return route.fulfill({ status: 200, contentType: mime[extname(name)] ?? 'text/plain', body: readFileSync(file) });
  });
}

function watchPage(page, errors, side) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 500)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[sbs] ')) { log(`${side.key.toUpperCase()}: ${t.slice(6)}`); return; }
    if (IGNORE.some((r) => r.test(t))) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 500)}`);
  });
}

// A page of `side` booted at `query`, parked, every pipeline built.
async function openPage(browser, side, query) {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: W, height: H } });
  const errors = [];
  watchPage(page, errors, side);
  await page.routeWebSocket(/.*/, () => {});   // no relay, no reloads
  await routeShotCode(page);
  await page.addInitScript(({ store, settings }) => {
    try { if (Object.keys(settings).length) localStorage.setItem(store, JSON.stringify(settings)); } catch { /* storage unavailable */ }
    // only the canvas: the UI animates on the wall clock (tools/regress.mjs)
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = 'body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
      document.head.appendChild(st);
    });
  }, { store: SETTINGS_STORE, settings: SETTINGS });
  const q = new URLSearchParams({ ...query, ...side.extra });
  const url = `${side.base}?${q}`;
  const t = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: BOOT_TIMEOUT_MS });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot failed at ${url}: ${failed.slice(0, 400)}`);
  log(`${side.key.toUpperCase()}: booted in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  await page.evaluate(() => { window.__app.test.park(); return window.__app.test.ready(); });
  log(`${side.key.toUpperCase()}: pipelines ready at ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return { page, errors, url, bootMs: Date.now() - t };
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: over ${ms / 1000} s`)), ms))]);
const pad = (i) => String(i).padStart(4, '0');

// One shot on an open page: prepared (scene, time, camera, setup), then
// captured into <out>/<shot>/<side>.png or <side>/NNNN.png.
async function captureShot(page, side, shot) {
  const dir = join(OUT, shot.name);
  mkdirSync(dir, { recursive: true });
  const t = Date.now();
  const describe = await page.evaluate(async ({ name, quality, timeScale }) => {
    const sbs = await import('/__sbs/engine.mjs');
    const { shotByName } = await import('/__sbs/shots.mjs');
    window.__sbsEngine ??= await sbs.pageEngine({ quality });
    await sbs.prepareShot(window.__sbsEngine, shotByName(name), { timeScale });
    return window.__sbsEngine.describe();
  }, { name: shot.name, quality: QUALITY, timeScale: TIME_SCALE });
  const prepare = Date.now() - t;
  const t1 = Date.now();
  let frames = 0;
  if (shot.kind === 'still') {
    await page.evaluate(() => window.__sbsEngine.converge());
    await page.screenshot({ path: join(dir, `${side.key}.png`) });
  } else {
    mkdirSync(join(dir, side.key), { recursive: true });
    const n = Math.max(1, Math.round(CLIP_S * FPS));
    for (let i = 0; i < n; i++) {
      if (i) await page.evaluate((dt) => window.__sbsEngine.run(dt, { render: true }), 1 / FPS);
      await page.evaluate(() => window.__sbsEngine.present());
      await page.screenshot({ path: join(dir, side.key, `${pad(i + 1)}.png`) });
      frames++;
    }
  }
  return { describe, frames, ms: { prepare, capture: Date.now() - t1 } };
}

// Every wanted shot on one side: a page per boot query (or per shot with
// --fresh), in shot-list order. Results go into results[shot][side].
async function runSide(side, results) {
  // (the launcher's default lifetime is 10 minutes; a whole run is longer)
  const browser = await launchBrowser({ lifetimeMs: BOOT_TIMEOUT_MS * 3 + wanted.length * SHOT_TIMEOUT_MS });
  side.browserVersion = browser.version();
  let open = null;
  const closePage = async () => { if (open) { await open.page.close().catch(() => {}); open = null; } };
  try {
    for (const shot of wanted) {
      const query = bootQuery(shot.scene, { box: boxFor(shot), win: WIN });
      const key = JSON.stringify(query);
      const r = results[shot.name][side.key] = { query };
      try {
        if (!open || open.key !== key || has('fresh')) {
          await closePage();
          log(`${side.key.toUpperCase()}: booting ${new URLSearchParams(query)}`);
          open = { key, ...(await withTimeout(openPage(browser, side, query), BOOT_TIMEOUT_MS, 'boot')) };
          r.bootMs = open.bootMs;
          side.adapter ??= await gpuInfo(open.page).then((i) => `${i.vendor} ${i.architecture} ${i.description}`.trim() + (i.isFallbackAdapter ? ' (fallback adapter)' : ''));
        }
        const before = open.errors.length;
        Object.assign(r, await withTimeout(captureShot(open.page, side, shot), SHOT_TIMEOUT_MS, shot.name));
        r.errors = open.errors.slice(before);
        log(`${side.key.toUpperCase()}: ${shot.name} prepared in ${(r.ms.prepare / 1000).toFixed(1)} s, captured in ${(r.ms.capture / 1000).toFixed(1)} s${r.frames ? ` (${r.frames} frames)` : ''}${r.errors.length ? `, ${r.errors.length} page errors` : ''}`);
      } catch (e) {
        r.error = String(e.message || e).split('\n')[0].slice(0, 400);
        r.errors = open?.errors.slice(-5) ?? [];
        log(`${side.key.toUpperCase()}: ${shot.name} FAILED: ${r.error}`);
        await closePage();   // (the next shot boots afresh)
      }
      writeRun(results);
    }
  } finally {
    await closePage();
    await browser.close();
  }
}

// the box a box shot runs on: --box, never below what the shot needs (first person's pool)
function boxFor(shot) {
  if (!BOX) return null;
  return String(Math.max(Number(BOX), shot.scene.minBox ?? 0));
}

// ---------------------------------------------------------------- compositing
// One page on a made-up origin serving the run's files: compose.html draws
// each pair and its difference and PUTs them back here.
async function compositor(browser) {
  const page = await newTestPage(browser, { mode: 'manual' });
  await page.route(`${SBS_ORIGIN}/**`, async (route) => {
    const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname);
    if (path === '/compose.html') return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(SBS, 'compose.html')) });
    const file = join(OUT, path.replace(/^\/run\//, ''));
    if (!file.startsWith(OUT)) return route.fulfill({ status: 403, body: 'outside the run' });
    if (req.method() === 'PUT') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, req.postDataBuffer());
      return route.fulfill({ status: 204 });
    }
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'no such file' });
    return route.fulfill({ status: 200, contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${SBS_ORIGIN}/compose.html`);
  const labels = [sides.a.label, sides.b.label];
  const run = (a, b, ab, diff) => page.evaluate((x) => window.compose(x), {
    a: `${SBS_ORIGIN}/run/${a}`, b: `${SBS_ORIGIN}/run/${b}`, ab: `${SBS_ORIGIN}/run/${ab}`, diff: diff ? `${SBS_ORIGIN}/run/${diff}` : null, labels,
  });
  return { page, run };
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

async function composite(shotResults) {
  const browser = await launchBrowser();
  try {
    const { run } = await compositor(browser);
    for (const shot of wanted) {
      const r = shotResults[shot.name];
      if (r.a?.error || r.b?.error || !r.a || !r.b) continue;
      const s = shot.name;
      r.files = {};
      if (shot.kind === 'still') {
        const d = await run(`${s}/a.png`, `${s}/b.png`, `${s}/ab.png`, `${s}/diff.png`);
        r.files.ab = 'ab.png'; r.files.diff = 'diff.png';
        r.diff = d && { ...d, psnr: d.max ? d.psnr : null };
      } else {
        const n = Math.min(r.a.frames, r.b.frames);
        const per = [];
        for (let i = 1; i <= n; i++) per.push(await run(`${s}/a/${pad(i)}.png`, `${s}/b/${pad(i)}.png`, `${s}/ab/${pad(i)}.png`, null));
        r.files.frames = n;
        r.diff = summarise(per);
        r.diffPerFrame = per.map((d) => d && +d.mean.toFixed(4));
        if (hasFfmpeg) {
          const v = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(OUT, s, 'ab', '%04d.png'),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', join(OUT, s, 'ab.mp4')], { encoding: 'utf8' });
          if (v.status === 0) r.files.video = 'ab.mp4';
          else log(`${s}: ffmpeg failed: ${(v.stderr || '').trim().slice(0, 300)}`);
        }
      }
      log(`${s}: A vs B mean |d| ${r.diff ? r.diff.mean.toFixed(3) : '–'}/255, ${r.diff ? (100 * r.diff.over8).toFixed(2) : '–'}% px > 8 levels, max ${r.diff?.max ?? '–'}`);
      writeRun(shotResults);
    }
  } finally {
    await browser.close();
  }
}

// a clip's frames' differences, summed up
function summarise(per) {
  const ok = per.filter(Boolean);
  if (!ok.length) return null;
  const first = per.findIndex((d) => d && d.max > 8);
  let worst = 0;
  per.forEach((d, i) => { if (d && d.mean > (per[worst]?.mean ?? -1)) worst = i; });
  const mse = ok.reduce((s, d) => s + (d.max ? 65025 / 10 ** (d.psnr / 10) : 0), 0) / ok.length;
  return {
    frames: per.length,
    framesSame: ok.filter((d) => d.max === 0).length,
    mean: ok.reduce((s, d) => s + d.mean, 0) / ok.length,
    over8: ok.reduce((s, d) => s + d.over8, 0) / ok.length,
    over32: ok.reduce((s, d) => s + d.over32, 0) / ok.length,
    max: Math.max(...ok.map((d) => d.max)),
    psnr: mse ? 10 * Math.log10(65025 / mse) : null,
    firstDiff: first < 0 ? null : first + 1,
    firstDiffT: first < 0 ? null : first / FPS,
    worst: worst + 1,
    worstMean: per[worst]?.mean ?? null,
  };
}

// ---------------------------------------------------------------- the run's record and sheet
const meta = {
  started: new Date().toISOString(),
  host: `${os.hostname()} · ${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model ?? ''} · Node ${process.version}`,
  tool: checkoutLabel(ROOT),
  size: `${W}×${H}`,
  quality: QUALITY === 'full' ? 'full: stills converged, clips drawn every game tick (TAA on)' : 'draft: TAA off, 2 frames a still, 1 a clip frame',
  clipSeconds: CLIP_S, fps: FPS,
  settings: SETTINGS_ARG,
  box: BOX, win: WIN, timeScale: TIME_SCALE,
  nondeterminism: [
    'the sides\' timings (both pages run at once unless --serial)',
  ],
  sides: {},
};
// --append: the shots an earlier run left in --out stay on the sheet (a run
// split into groups, as the container's are), each with its own capture settings
const previous = has('append') && existsSync(join(OUT, 'run.json')) ? JSON.parse(readFileSync(join(OUT, 'run.json'), 'utf8')) : null;
const capture = { size: `${W}×${H}`, quality: QUALITY, timeScale: TIME_SCALE, box: BOX, win: WIN, settings: SETTINGS_ARG, run: stamp };
function writeRun(results) {
  meta.ms = Date.now() - t0;
  for (const k of ['a', 'b']) meta.sides[k] = { label: sides[k].label, url: sides[k].url, dir: sides[k].dir, adapter: sides[k].adapter, browser: sides[k].browserVersion };
  const now = wanted.map((s) => ({
    name: s.name, kind: s.kind, title: s.title, look: s.look, seconds: CLIP_S, fps: FPS, capture, ...results[s.name],
  }));
  const kept = (previous?.shots ?? []).filter((p) => !now.some((n) => n.name === p.name));
  const order = (x) => SHOTS.findIndex((s) => s.name === x.name);
  const shots = [...kept, ...now].sort((x, y) => order(x) - order(y));
  const runs = [...(previous?.meta.runs ?? []), { started: meta.started, shots: wanted.map((s) => s.name), ms: meta.ms }];
  const run = { meta: { ...meta, runs }, shots };
  writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 1));
  writeFileSync(join(OUT, 'index.html'), sheetHtml(run));
}

// ---------------------------------------------------------------- main
const results = Object.fromEntries(wanted.map((s) => [s.name, {}]));
let code = 0;
try {
  await startServers();
  log(`${wanted.length} shots, ${W}×${H}, ${QUALITY}, clips ${CLIP_S} s at ${FPS} fps → ${OUT}`);
  if (has('serial')) { await runSide(sides.a, results); await runSide(sides.b, results); }
  else await Promise.all([runSide(sides.a, results), runSide(sides.b, results)]);
  if (Object.values(sides).some((s) => /swiftshader|fallback/i.test(s.adapter ?? ''))) {
    meta.warning = 'Software adapter (SwiftShader): the images are right, the timings are not representative of any GPU.';
  }
  await composite(results);
  writeRun(results);
  const failed = wanted.filter((s) => results[s.name].a?.error || results[s.name].b?.error);
  log(`done: ${wanted.length - failed.length} of ${wanted.length} shots${failed.length ? `; failed: ${failed.map((s) => s.name).join(', ')}` : ''}`);
  log(`sheet: ${join(OUT, 'index.html')}`);
  if (failed.length) code = 1;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  for (const s of servers) await s.close().catch(() => {});
}
process.exit(code);
