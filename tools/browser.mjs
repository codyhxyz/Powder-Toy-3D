// Shared real-GPU test launcher. No global rAF mocks and no silent quality cuts.
import { chromium } from 'playwright';

const browsers = new Set();
const MODES = ['manual', 'preview', 'ui', 'visual'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
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

export async function launchBrowser(options = {}) {
  const { lifetimeMs = Number(process.env.TPT_TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), ...launch } = options;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Test lifetime must be positive milliseconds');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
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
export async function newTestPage(browser, { mode = 'preview', ...options } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  return configure(await browser.newPage(options), mode);
}
export async function newTestContext(browser, { mode = 'preview', ...options } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  return configure(await browser.newContext(options), mode);
}
export const ready = page => page.waitForFunction(() => window.__app?.sim, null, { polling: 100, timeout: 120000 });

// Park before an explicit full-quality checkpoint, including asynchronous
// compilation. Leave parked so the subsequent screenshot sees this exact frame.
// Call __app.test.resume() explicitly when the test needs live gameplay again.
export async function render(page) {
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
