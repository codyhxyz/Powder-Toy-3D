// Shared real-GPU test launcher. No global rAF mocks and no silent quality cuts.
//
// Every browser starts with GPU_ARGS (docs/webgpu.md I3): WebGPU needs
// --enable-unsafe-webgpu in headless Chromium, and the developer features stop
// Chrome quantizing timestamp queries to 100 µs. A tool that passes `args`
// adds to them; it never replaces them.
//
// --real-gpu (the default on macOS, --no-real-gpu turns it off) makes gpuInfo()
// throw on a fallback (software) adapter, so a Mac run can't pass on
// SwiftShader by accident.
import { chromium } from 'playwright';

const browsers = new Set();
const MODES = ['manual', 'preview', 'ui', 'visual'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** True when this run must not accept a fallback (software) WebGPU adapter. */
export const REAL_GPU = process.argv.includes('--real-gpu')
  || (process.platform === 'darwin' && !process.argv.includes('--no-real-gpu'));

/** Chromium switches every test browser starts with (docs/webgpu.md I3). */
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
// --disable-features are merged with each other only, as before.
const PLAYWRIGHT_FEATURES = process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? [] : ['CDPScreenshotNewSurface'];
function mergeArgs(args) {
  const out = [], enable = [...PLAYWRIGHT_FEATURES], disable = [];
  for (const a of args) {
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

/**
 * Launches headless Chromium with GPU_ARGS plus `options.args`, closed on
 * uncaught failures and signals and after `lifetimeMs` (TPT_TEST_TIMEOUT_MS).
 * @param {{ lifetimeMs?: number, args?: string[] } & object} [options] Playwright launch options
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(options = {}) {
  const { lifetimeMs = Number(process.env.TPT_TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), args = [], ...launch } = options;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Test lifetime must be positive milliseconds');
  const browser = await chromium.launch({
    headless: true,
    args: mergeArgs([...GPU_ARGS, ...args]),
    ...launch,
  });
  if (!browsers.size) for (const [event, fn] of Object.entries(handlers)) process.on(event, fn);
  browsers.add(browser);
  const timer = setTimeout(() => stop(1, new Error(`GPU test exceeded ${lifetimeMs} ms`)), lifetimeMs);
  timer.unref();
  browser.once('disconnected', () => {
    clearTimeout(timer);
    browsers.delete(browser);
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
