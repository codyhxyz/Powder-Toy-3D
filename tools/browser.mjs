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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const browsers = new Set();
const MODES = ['manual', 'preview', 'ui', 'visual'];
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
// Headless GPU budget. The user plays on this same GPU while agents test, so
// headless time is rationed: one browser machine-wide at a time, and each
// Claude session (subagents share its id) gets a small rolling allowance.
const BUDGET_DIR = path.join(os.homedir(), '.cache', 'tpt-headless');
const SLOT_FILE = path.join(BUDGET_DIR, 'slot');
const SESSION_BUDGET_MS = Number(process.env.TPT_HEADLESS_BUDGET_MS ?? 5 * 60 * 1000);
const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const SLOT_WAIT_MS = 5 * 60 * 1000;
const SLOT_POLL_MS = 2000;
const session = process.env.CLAUDE_CODE_SESSION_ID;
const ledgerFile = session && path.join(BUDGET_DIR, `${session}.json`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function spentMs(now = Date.now()) {
  if (!ledgerFile) return 0;
  return readJSON(ledgerFile, []).filter(r => r.end > now - BUDGET_WINDOW_MS).reduce((t, r) => t + (r.end - r.start), 0);
}
function record(start) {
  if (!ledgerFile) return;
  const now = Date.now();
  const runs = readJSON(ledgerFile, []).filter(r => r.end > now - BUDGET_WINDOW_MS);
  runs.push({ start, end: now });
  fs.writeFileSync(ledgerFile, JSON.stringify(runs));
}
let slotHeld = false;
async function takeSlot() {
  fs.mkdirSync(BUDGET_DIR, { recursive: true });
  const until = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(SLOT_FILE, String(process.pid), { flag: 'wx' });
      slotHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = Number(readJSON(SLOT_FILE, 0));
    if (holder === process.pid) { slotHeld = true; return; }
    if (!holder || !alive(holder)) { fs.rmSync(SLOT_FILE, { force: true }); continue; }
    if (Date.now() > until) throw new Error(`Headless GPU slot still held by pid ${holder}; giving up. Do a CPU check instead.`);
    console.error(`[browser] waiting for the headless GPU slot (held by pid ${holder})`);
    await new Promise(r => setTimeout(r, SLOT_POLL_MS));
  }
}
function releaseSlot() {
  if (!slotHeld) return;
  slotHeld = false;
  if (Number(readJSON(SLOT_FILE, 0)) === process.pid) fs.rmSync(SLOT_FILE, { force: true });
}
process.on('exit', releaseSlot);

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
  // Only our browsers. A broken driver must not prevent the test process exiting.
  const deadline = setTimeout(() => process.exit(code), 5000);
  await Promise.allSettled([...browsers].map(b => b.close()));
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
 * uncaught failures and signals and after `lifetimeMs` (TPT_TEST_TIMEOUT_MS).
 * `browserLog(line)` receives the browser's stderr, GPU process included
 * (adds --enable-logging=stderr).
 * @param {{ lifetimeMs?: number, args?: string[], browserLog?: (line: string) => void } & object} [options] Playwright launch options
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(options = {}) {
  const { lifetimeMs = Number(process.env.TPT_TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), args = [], browserLog, ...launch } = options;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Test lifetime must be positive milliseconds');
  const logArgs = browserLog && hookBrowserLog(browserLog) ? ['--enable-logging=stderr', '--v=0'] : [];
  const left = SESSION_BUDGET_MS - spentMs();
  if (left <= 0) throw new Error(`Headless GPU budget spent (${SESSION_BUDGET_MS / 60000} min per hour per session). The user plays on this GPU: check on the CPU, or ship and verify on prod.`);
  if (!browsers.size) await takeSlot();
  const started = Date.now();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: mergeArgs([...GPU_ARGS, ...logArgs], args),
      ...launch,
    });
  } catch (e) {
    if (!browsers.size) releaseSlot();
    throw e;
  }
  if (!browsers.size) for (const [event, fn] of Object.entries(handlers)) process.on(event, fn);
  browsers.add(browser);
  const limit = Math.min(lifetimeMs, left);
  const timer = setTimeout(() => stop(1, new Error(`GPU test exceeded ${limit} ms (lifetime or session budget)`)), limit);
  timer.unref();
  browser.once('disconnected', () => {
    clearTimeout(timer);
    browsers.delete(browser);
    record(started);
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
