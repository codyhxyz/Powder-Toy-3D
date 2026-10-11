// The GPU harness's shared page code (docs/webgpu.md I1): pages that run our
// WebGPU code without the app, served by the Vite dev server
// (`npm run harness`, or tools/vite-server.mjs with { harness: true }) and
// driven by tools through tools/harness/open.mjs. The core is this module,
// index.html, foundation.* (the foundation check and the walking skeleton) and
// wgsl.* (tools/check-wgsl.mjs). Units add their own page files beside them
// and boot through boot().
//
// A page's state is window.__harness: { gpu, ready, error, failures, log,
// tests, run(name, …args) }. Tools wait for `ready`, then call
// __harness.run(name) for each test the page registered with test().

import { probeWebGPU, createGpu, testModeOf } from '/src/gpu/index.js';

const h = (window.__harness = {
  gpu: null, ready: false, error: null, failures: [], log: [], tests: {},
  /**
   * Runs a registered test; resolves to its result (anything structured-cloneable).
   * @param {string} name
   * @param {...unknown} args
   */
  async run(name, ...args) {
    const fn = h.tests[name];
    if (!fn) throw new Error(`harness: no test "${name}" (have: ${Object.keys(h.tests).join(', ')})`);
    return fn(...args);
  },
});

/**
 * Registers a test the tool runs with __harness.run(name).
 * @param {string} name
 * @param {(...args: unknown[]) => unknown} fn
 */
export function test(name, fn) { h.tests[name] = fn; }

/**
 * Appends a line to the page's log (shown in a <pre id="log"> when there is one).
 * @param {...unknown} parts
 */
export function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  h.log.push(line);
  const pre = document.getElementById('log');
  if (pre) pre.textContent += `${line}\n`;
}

/**
 * Creates the page's gpu (the fallback adapter is fine here: these pages are
 * tests), records every failure in __harness.failures and returns the harness
 * state. Sets __harness.error and throws when there's no WebGPU.
 * @param {{ label?: string }} [opts]
 */
export async function boot({ label = 'harness' } = {}) {
  try {
    const probe = await probeWebGPU({ allowFallback: true });
    if (!probe.ok) throw new Error(`${probe.message}${probe.reason === 'no-webgpu' ? ' (headless Chromium needs --enable-unsafe-webgpu)' : ''}`);
    const gpu = await createGpu({ adapter: probe.adapter, label, testMode: testModeOf() ?? 'manual' });
    gpu.onFailure((f) => { h.failures.push(f.message); log('FAILURE', f.message); });
    h.gpu = gpu;
    log(`gpu: ${gpu.adapterInfo.vendor} ${gpu.adapterInfo.architecture} (${gpu.adapterInfo.description})${gpu.adapterInfo.isFallbackAdapter ? ', fallback adapter' : ''}`);
    return h;
  } catch (e) {
    h.error = e.message;
    h.ready = true;
    log('ERROR', e.message);
    throw e;
  }
}

/** Marks the page ready for its tool. */
export function ready() { h.ready = true; }

/**
 * Counts gpu.stats over `fn` (awaited): the difference of every counter.
 * @param {object} gpu
 * @param {() => unknown} fn
 * @returns {Promise<Record<string, number>>}
 */
export async function measure(gpu, fn) {
  const before = { ...gpu.stats };
  await fn();
  return Object.fromEntries(Object.entries(gpu.stats).map(([k, v]) => [k, v - before[k]]));
}

/**
 * A storage buffer's contents as u32s (copy recorded now).
 * @param {object} gpu
 * @param {GPUBuffer} buffer
 * @param {number} [count] words
 */
export async function readU32(gpu, buffer, count = buffer.size / 4) {
  return new Uint32Array(await gpu.readback.buffer(buffer, 0, count * 4));
}

/**
 * The fraction of pixels differing from the first one, the luma variance and
 * the RGBA of some pixels, of an image (a PNG screenshot as base64): the
 * "non-blank" test.
 * @param {string} base64
 * @param {[number, number][]} [points] pixels to sample
 */
export async function imageStats(base64, points = []) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  let differ = 0, sum = 0, sum2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) differ++;
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; sum2 += l * l;
  }
  const samples = points.map(([x, y]) => Array.from(d.subarray(4 * (y * bmp.width + x), 4 * (y * bmp.width + x) + 4)));
  return { width: bmp.width, height: bmp.height, differ: differ / n, variance: sum2 / n - (sum / n) ** 2, samples };
}

test('imageStats', imageStats);
