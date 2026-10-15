// Shared real-GPU test launcher. No global rAF mocks and no silent quality cuts.
//
// Every browser starts with GPU_ARGS (docs/webgpu.md I3): WebGPU needs
// --enable-unsafe-webgpu in headless Chromium, and the developer features stop
// Chrome quantizing timestamp queries to 100 µs. A tool that passes `args`
// adds to them; it never replaces them, and the backend switches GPU_ARGS
// sets for this platform win over a tool's (see GPU_ARGS).
//
// --real-gpu (the default on macOS, --no-real-gpu turns it off) makes gpuInfo()
// throw on a fallback (software) adapter, so a Mac run can't pass on
// SwiftShader by accident.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_SLOT_MS, CLEANUP_MS, budgetMs, processTable } from './gpu-deadline.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const browsers = new Set();
const MODES = ['manual', 'preview', 'ui', 'visual'];
const DEFAULT_TIMEOUT_MS = MAX_SLOT_MS;
// Headless GPU budget. The user plays on this same GPU while agents test, so a
// headless browser (1) never runs beside another one; (2) releases its slot
// if the player uses the GPU; and (3) occupies a slot for <=25s TOTAL,
// including compilation and cleanup. macOS reports utilization in the IO
// Registry ("Device Utilization %", no permissions needed); its median over
// BUSY_WINDOW_MS discounts the desktop's own spikes (a window drag, a video).
// Off macOS (CI, the Linux container) there is no player and no reading.
const BUDGET_DIR = path.join(os.homedir(), '.cache', 'tpt-headless');
const SLOT_FILE = path.join(BUDGET_DIR, 'slot');
const SLOT_WAIT_MS = Number(process.env.TPT_GPU_WAIT_MS ?? 3000);
const SLOT_POLL_MS = 2000;
// A raymarched frame at 30-60 fps keeps the M-series GPU above ~80 %; the
// desktop alone reads 0-25 % with spikes past 50 % (sampled 2026-10-13).
const BUSY_PCT = 50;
const BUSY_SAMPLES = 9;           // readings per check (odd: a true median)
const BUSY_WINDOW_MS = 1800;      // spread over this long
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function gpuUtilization() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { encoding: 'utf8', timeout: 200 });
    const m = /"Device Utilization %"=(\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
/** The GPU's median utilization (%) over BUSY_WINDOW_MS; 0 where it can't be read. */
export async function gpuBusyPct() {
  if (process.platform !== 'darwin' || process.env.TPT_IGNORE_PLAYER) return 0;
  const v = [];
  for (let i = 0; i < BUSY_SAMPLES; i++) {
    v.push(gpuUtilization());
    if (i < BUSY_SAMPLES - 1) await sleep(BUSY_WINDOW_MS / (BUSY_SAMPLES - 1));
  }
  return v.sort((a, b) => a - b)[BUSY_SAMPLES >> 1];
}
let slotHeld = false;
let slotStarted = 0, slotDeadline = 0, slotInode = null, slotToken = '', slotGuardPid = 0, watchdog = null, launching = false, attempted = false;
let guardFinished = Promise.resolve();
// A spawned guard may have transferred the lease even if readiness fails.
// Only its verified-release message permits local release/reset afterward.
let slotGuarded = false;
async function takeSlot() {
  fs.mkdirSync(BUDGET_DIR, { recursive: true });
  const until = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    if (!slotHeld) {
      try {
        fs.writeFileSync(SLOT_FILE, String(process.pid), { flag: 'wx' });
        slotHeld = true;
        slotStarted = Date.now();
        slotInode = fs.statSync(SLOT_FILE).ino; slotToken = randomUUID();
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const holder = readJSON(SLOT_FILE, null);
        if (holder === process.pid || !Number.isSafeInteger(holder) || holder <= 1 || !alive(holder)) {
          throw new Error('Headless GPU slot holder is dead or unverified; preserving the lease and report regardless of age. Require ownership/cleanup verification before recovery; do a CPU check instead.');
        }
        if (!slotHeld) {
          if (Date.now() > until) throw new Error(`Headless GPU slot still held by pid ${holder}; giving up. Do a CPU check instead.`);
          console.error(`[browser] waiting for the headless GPU slot (held by pid ${holder})`);
          await sleep(SLOT_POLL_MS);
          continue;
        }
      }
    }
    // the slot is ours, so no other test is on the GPU: whatever is busy is the player
    const busy = await gpuBusyPct();
    if (busy < BUSY_PCT) return;
    releaseSlot();
    throw new Error(`The GPU is busy (${busy} % used): the user is likely playing. Slot released; do CPU work instead.`);
  }
}
function releaseSlot() {
  if (!slotHeld) return;
  if (slotGuarded) {
    watchdog?.stdin.write('released\n'); // guard verifies browser descendants exited first
    return; // disappearance, failed readiness, or a failed close is not release
  }
  slotHeld = false;
  try {
    const owner = readJSON(SLOT_FILE, null);
    if (fs.statSync(SLOT_FILE).ino === slotInode && (owner === process.pid || (slotGuardPid > 0 && owner === slotGuardPid)))
      fs.rmSync(SLOT_FILE, { force: true });
  } catch {}
  if (slotStarted && !slotGuardPid) console.error(`[browser] total GPU slot occupancy ${Date.now() - slotStarted} ms`);
  slotStarted = slotDeadline = 0; slotInode = null; slotToken = ''; slotGuardPid = 0;
}
// A failed close must not cancel the independent hard kill or release the
// lock while our browser is still alive.
process.on('exit', () => { if (!browsers.size && !launching) releaseSlot(); });

async function guardSlot(limit) {
  if (watchdog) return;
  slotDeadline = slotStarted + limit;
  const owner = processTable().find(p => p.pid === process.pid);
  if (!owner) throw new Error('Cannot establish test process ownership; refusing GPU launch');
  watchdog = spawn(process.execPath, [
    fileURLToPath(new URL('./gpu-deadline.mjs', import.meta.url)),
    String(owner.pid), owner.start, String(slotDeadline), SLOT_FILE, String(slotInode), slotToken, String(slotStarted),
  ], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
  slotGuarded = true;
  slotGuardPid = watchdog.pid;
  watchdog.stdin.on('error', () => {});
  const guard = watchdog;
  let finishGuard;
  guardFinished = new Promise(resolve => { finishGuard = resolve; });
  let output = '';
  guard.stdout.on('data', data => {
    output += data.toString();
    if (output.includes('stop\n')) void stop(1, new Error('GPU deadline guard cannot verify ownership'));
    if (output.includes('released\n') && watchdog === guard) {
      watchdog = null;
      slotGuarded = false;
      releaseSlot();
      finishGuard();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GPU deadline guard did not start')), 500);
      guard.once('error', error => { clearTimeout(timer); reject(error); });
      guard.once('exit', () => { clearTimeout(timer); reject(new Error('GPU deadline guard exited before readiness')); });
      const ready = () => {
        if (!output.split('\n').includes('ready')) return;
        clearTimeout(timer); guard.stdout.off('data', ready); resolve();
      };
      guard.stdout.on('data', ready);
    });
  } catch (error) {
    watchdog = null;
    finishGuard();
    guard.kill('SIGTERM'); // our child only; retain the uncertain lease, no browser started
    throw error;
  }
  guard.once('exit', () => {
    finishGuard();
    if (watchdog !== guard) return; // normal release already acknowledged
    watchdog = null;
    void stop(1, new Error('GPU deadline guard exited unexpectedly'));
  });
}

/** True when this run must not accept a fallback (software) WebGPU adapter. */
export const REAL_GPU = process.argv.includes('--real-gpu')
  || (process.platform === 'darwin' && !process.argv.includes('--no-real-gpu'));

/**
 * Chromium switches every test browser starts with (docs/webgpu.md I3). The
 * backend switches here (--use-angle=, --use-vulkan=) are what this platform
 * needs to present a WebGPU canvas, so a tool's own value for one of them is
 * dropped unless --real-gpu is set (mergeArgs); a tool's --use-angle=metal is
 * dropped off macOS, where it means nothing. gp-audio, gp-integration and
 * wand-editor-check still pass it from the WebGL days: on Linux it would come
 * last, win, and lose the device at the first present.
 */
export const GPU_ARGS = [
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features',
  // only the frozen WebGL2 build in cross-build runs reads it; harmless otherwise
  ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
  // Linux: a WebGPU canvas presents through a Vulkan shared image. Without
  // Vulkan (and, with no GPU, without SwiftShader behind both ANGLE and
  // Vulkan) the GPU process has no backing for the swap chain and the first
  // present loses the device ("A valid external Instance reference no longer
  // exists"); compute alone works either way.
  ...(process.platform === 'linux' ? ['--enable-features=Vulkan'] : []),
  ...(process.platform === 'linux' && !REAL_GPU ? ['--use-angle=swiftshader', '--use-vulkan=swiftshader'] : []),
];

// Playwright passes its own --enable-features and Chromium keeps only the last
// one, so ours and a tool's are merged into one switch that repeats
// Playwright's (CDPScreenshotNewSurface: headless screenshots). Tools'
// --disable-features are merged with each other only, as before. A tool's
// backend switch gives way to ours (GPU_ARGS).
const PLAYWRIGHT_FEATURES = process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? [] : ['CDPScreenshotNewSurface'];
const BACKEND = /^--(use-angle|use-vulkan|use-gl)=/;
function mergeArgs(base, extra) {
  const ours = new Set(base.map((a) => BACKEND.exec(a)?.[1]).filter(Boolean));
  const tool = extra.filter((a) => {
    const m = BACKEND.exec(a);
    if (!m) return true;
    if (a === '--use-angle=metal' && process.platform !== 'darwin') return false;
    return REAL_GPU || !ours.has(m[1]);
  });
  const out = [], enable = [...PLAYWRIGHT_FEATURES], disable = [];
  for (const a of [...base, ...tool]) {
    const m = /^--(enable|disable)-features=(.*)$/.exec(a);
    if (!m) { if (!out.includes(a)) out.push(a); continue; }
    for (const f of m[2].split(',').filter(Boolean)) {
      const list = m[1] === 'enable' ? enable : disable;
      if (!list.includes(f)) list.push(f);
    }
  }
  if (enable.length > PLAYWRIGHT_FEATURES.length) out.push(`--enable-features=${enable.join(',')}`);
  if (disable.length) out.push(`--disable-features=${disable.join(',')}`);
  return out;
}

let stopping = false;
async function stop(code, error) {
  if (stopping) return;
  stopping = true;
  if (error) console.error(error);
  const finished = guardFinished;
  // Only our browsers. A broken driver must not prevent the test process exiting.
  const deadline = setTimeout(() => process.exit(code), Math.max(1, Math.min(1000, slotDeadline - Date.now())));
  await Promise.allSettled([...browsers].map(b => b.close()));
  // Do not cut off the watchdog's verified release/timing message. This
  // shares the existing cleanup deadline; it does not extend the GPU lease.
  await finished;
  clearTimeout(deadline);
  process.exit(code);
}
const handlers = {
  SIGINT: () => stop(130),
  SIGTERM: () => stop(143),
  SIGHUP: () => stop(129),
  uncaughtException: error => stop(1, error),
  unhandledRejection: error => stop(1, error),
};

// The browser's own stderr (the GPU process's log, where a lost device says
// why) reaches Playwright's `pw:browser` debug channel. browserLog turns that
// channel on and hands its lines to a callback instead of printing them.
// Returns false when this Playwright doesn't expose its debug module.
function hookBrowserLog(fn) {
  let debug;
  try { debug = createRequire(import.meta.url)('playwright-core/lib/utilsBundle').debug; } catch { return false; }
  if (typeof debug?.enable !== 'function') return false;
  const was = debug.disable();
  debug.enable([was, 'pw:browser'].filter(Boolean).join(','));
  const log = debug.log;
  debug.log = (...parts) => {
    const line = parts.join(' ').replace(/\u001b\[[0-9;]*m/g, '');
    if (/pw:browser/.test(line)) fn(line.replace(/^.*?pw:browser\s*/, ''));
    else if (log) log(...parts);
    else process.stderr.write(`${parts.join(' ')}\n`);
  };
  return true;
}

/**
 * Launches headless Chromium with GPU_ARGS plus `options.args`, closed on
 * uncaught failures and signals. `lifetimeMs` includes the entire slot:
 * player check, launch, compilation, assertions and cleanup; maximum 25s.
 * `browserLog(line)` receives the browser's stderr, GPU process included
 * (adds --enable-logging=stderr).
 * @param {{ lifetimeMs?: number, args?: string[], browserLog?: (line: string) => void } & object} [options] Playwright launch options
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(options = {}) {
  const { lifetimeMs = Number(process.env.TPT_TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), args = [], browserLog, ...launch } = options;
  budgetMs(lifetimeMs);
  if (attempted) throw new Error('One browser launch per test process. Reuse contexts; do not retry or renew the GPU slot.');
  attempted = true; launching = true;
  const logArgs = browserLog && hookBrowserLog(browserLog) ? ['--enable-logging=stderr', '--v=0'] : [];
  let browser;
  try {
    await takeSlot();
    await guardSlot(lifetimeMs);
    const remaining = slotDeadline - Date.now() - CLEANUP_MS;
    if (remaining <= 0) throw new Error('GPU slot budget exhausted before browser launch');
    launching = true;
    browser = await chromium.launch({
      headless: true,
      args: mergeArgs([...GPU_ARGS, ...logArgs, `--tpt-gpu-lease=${slotToken}`],
        args.filter(a => !a.startsWith('--tpt-gpu-lease='))),
      ...launch,
      env: { ...(launch.env ?? process.env), TPT_GPU_LEASE_TOKEN: slotToken },
      timeout: Math.max(1, Math.min(launch.timeout || remaining, remaining)),
    });
  } catch (e) {
    launching = false;
    if (!browsers.size) releaseSlot();
    throw e;
  }
  if (!browsers.size) for (const [event, fn] of Object.entries(handlers)) process.on(event, fn);
  browsers.add(browser);
  launching = false;
  watchdog?.stdin.write('capture\n');
  const timer = setTimeout(() => stop(1, new Error(`GPU slot budget exhausted; closing within the ${MAX_SLOT_MS / 1000}s total cap`)),
    Math.max(1, Math.min(lifetimeMs - CLEANUP_MS, slotDeadline - Date.now() - CLEANUP_MS)));
  timer.unref();
  browser.once('disconnected', () => {
    clearTimeout(timer);
    browsers.delete(browser);
    if (!browsers.size) releaseSlot();
    if (!browsers.size) for (const [event, fn] of Object.entries(handlers)) process.off(event, fn);
  });
  return browser;
}

// The mode is explicit and survives reloads. URL ?test= overrides it.
async function configure(target, mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  await target.addInitScript(mode => { window.__TPT_TEST_MODE__ = mode; }, mode);
  return target;
}
/**
 * A page in an explicit test mode (manual, ui, preview, visual).
 * @param {import('playwright').Browser} browser
 * @param {{ mode?: string } & object} [options] Playwright page options
 */
export async function newTestPage(browser, { mode = 'preview', ...options } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  return configure(await browser.newPage(options), mode);
}
/**
 * A context whose pages start in an explicit test mode.
 * @param {import('playwright').Browser} browser
 * @param {{ mode?: string } & object} [options] Playwright context options
 */
export async function newTestContext(browser, { mode = 'preview', ...options } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  return configure(await browser.newContext(options), mode);
}
/** Resolves when the app has built its simulation. */
export const ready = page => page.waitForFunction(() => window.__app?.sim, null, { polling: 100, timeout: 120000 });

// Park before an explicit full-quality checkpoint, including asynchronous
// compilation. Leave parked so the subsequent screenshot sees this exact frame.
// Call __app.test.resume() explicitly when the test needs live gameplay again.
/**
 * Parks the app and converges the view without stepping physics. Awaits
 * `__app.test.ready()` (every pipeline the settings need, docs/webgpu.md B5)
 * when the app has it, else waits out `detailGate.pending` as before.
 * @param {import('playwright').Page} page
 */
export async function render(page) {
  const hasReady = await page.evaluate(() => typeof window.__app?.test?.ready === 'function');
  if (hasReady) {
    await page.evaluate(async () => {
      const a = window.__app;
      a.test.park();
      await a.test.ready();
      await a.test.render();
    });
    return;
  }
  const pending = await page.evaluate(() => {
    const a = window.__app;
    a.test.park(); a.test.render();
    return a.detailGate.pending;
  });
  if (pending) {
    await page.waitForFunction(() => !window.__app.detailGate.pending, null, { polling: 100, timeout: 120000 });
    await page.evaluate(() => window.__app.test.render());
  }
}

/**
 * The page's WebGPU adapter, for every report: vendor, architecture, whether
 * it is a fallback adapter, its features and the limits the port cares about.
 * Reads the app's or the harness's `gpu` when there is one, else asks for an
 * adapter. Throws on a fallback adapter (or none) under --real-gpu.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ webgpu: boolean, vendor: string, architecture: string, device: string, description: string,
 *   isFallbackAdapter: boolean, features: string[], limits: Record<string, number> }>}
 */
export async function gpuInfo(page) {
  const info = await page.evaluate(async () => {
    const KEYS = [
      'maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage',
      'maxStorageTexturesPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupsPerDimension', 'maxColorAttachmentBytesPerSample', 'maxTextureDimension3D',
    ];
    const gpu = window.__app?.gpu ?? window.__harness?.gpu;
    let adapter = gpu?.adapter;
    if (!adapter && navigator.gpu) adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { webgpu: false, vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false, features: [], limits: {} };
    }
    const i = adapter.info ?? {};
    const limits = gpu?.device?.limits ?? adapter.limits;
    return {
      webgpu: true,
      vendor: i.vendor ?? '', architecture: i.architecture ?? '', device: i.device ?? '', description: i.description ?? '',
      isFallbackAdapter: Boolean(i.isFallbackAdapter ?? adapter.isFallbackAdapter),
      features: [...adapter.features].sort(),
      limits: Object.fromEntries(KEYS.map((k) => [k, limits[k]])),
    };
  });
  if (REAL_GPU && (!info.webgpu || info.isFallbackAdapter)) {
    throw new Error(`--real-gpu: this run got ${info.webgpu ? `a fallback adapter (${info.vendor} ${info.architecture})` : 'no WebGPU adapter'}`);
  }
  return info;
}
