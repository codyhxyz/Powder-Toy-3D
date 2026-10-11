// Build-agnostic page helpers (docs/webgpu.md W6, I4). One script drives both
// builds: the frozen WebGL2 one (a local checkout of the last WebGL2 commit,
// W5), whose sim reads the GPU back synchronously, and this one, where every
// GPU→CPU read is a promise (C7). pageGpu(page) adds an init script that
// defines window.__pageGpu in every document the page (or context) loads, and
// tools call it inside page.evaluate, awaiting each read:
//
//   import { launchBrowser, newTestPage } from './browser.mjs';
//   import { pageGpu, gpuName } from './page-gpu.mjs';
//   const page = await pageGpu(await newTestPage(browser, { mode: 'manual' }));
//   await page.goto(url);
//   console.log(await gpuName(page));
//   const water = await page.evaluate(async () => {
//     const { E } = await import('/src/elements.js');
//     return (await window.__pageGpu.census())[E.WATER]?.n ?? 0;
//   });
//
// In the page:
//   api                    'webgpu' (window.__app.gpu is our device), 'webgl2'
//                          (the old build's renderer), or null before boot
//   readState(sim)         [A, B] Float32Arrays in atlas order (sim.cellTexel)
//   readCell(x, y, z, sim) [a, b], Float32Array(4) each
//   census(sim)            { [id]: { n, T, minY, maxY, Tmax } }
//   fence(sim)             resolves when the GPU has done the work recorded so far
//   drawCount()            draws and dispatches since the first call (which returns 0)
//   gpuName(), info()      the adapter (WebGPU) or the unmasked renderer (WebGL2)
// `sim` defaults to window.__app.sim, read at the call (a rebuild replaces it).
// readState, readCell, census and fence return promises in both builds, so a
// tool awaits them once and runs unchanged on either; tools/check-async-reads.mjs
// fails a call that isn't awaited (a missed await turns
// `census()[E.ROCK]?.n > 0` into a comparison of undefined that never fails).
//
// The Node-side wrappers at the end return small results (a census, a cell, a
// name, a count) through page.evaluate. A full readState stays in the page,
// where the tool reduces it: 67 MB at 128³ doesn't cross the CDP bridge well.
//
// This is the one file in tools/ that names the old build's GL API (the
// WebGL2 branches of info and drawCount): the cross-build runs need it.

/**
 * Defines window.__pageGpu, once per document. Runs in the page (as an init
 * script, or through page.evaluate), so it closes over nothing in this module.
 */
function installPageGpu() {
  if (window.__pageGpu) return;
  const app = () => window.__app;
  const simOf = (sim) => {
    const s = sim ?? app()?.sim;
    if (!s) throw new Error('page-gpu: no simulation yet (window.__app.sim); pass one');
    return s;
  };
  // our device: the app's, the harness's (tools/harness/), or a standalone sim's
  const gpuOf = (sim) => sim?.gpu ?? app()?.gpu ?? window.__harness?.gpu ?? null;
  const apiOf = (sim) => {
    if (gpuOf(sim)) return 'webgpu';
    const r = sim?.renderer ?? app()?.renderer;
    if (typeof r?.getContext === 'function' && typeof WebGL2RenderingContext === 'function'
      && r.getContext() instanceof WebGL2RenderingContext) return 'webgl2';
    return null;
  };

  // drawCount: the old build counts three's renderBufferDirect calls (every
  // pass of its sim and view was a draw, as tools/bench.mjs and headless-cost
  // counted them); this one counts our draws and dispatches from gpu.stats
  // (an indirect dispatch once, though stats.dispatches counts it twice, B3)
  // plus three's mesh draws, through its Info.update (one call per draw).
  let base = null;
  const counted = new WeakMap();   // the patched object → its count
  const countCalls = (obj, method) => {
    if (!obj || typeof obj[method] !== 'function') return () => 0;
    if (!counted.has(obj)) {
      const call = obj[method];
      counted.set(obj, 0);
      obj[method] = function (...args) { counted.set(obj, counted.get(obj) + 1); return call.apply(this, args); };
    }
    return () => counted.get(obj);
  };
  const draws = () => {
    const which = apiOf();
    if (which === 'webgpu') {
      const s = gpuOf().stats, three = countCalls(app()?.renderer?.info, 'update');
      return s.draws + s.dispatches - s.indirectDispatches + three();
    }
    if (which === 'webgl2') return countCalls(app().renderer, 'renderBufferDirect')();
    return 0;
  };

  const info = (sim) => {
    const which = apiOf(sim);
    if (which === 'webgpu') {
      const i = gpuOf(sim).adapterInfo ?? {};
      const what = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') || 'unknown adapter';
      return { api: which, name: `WebGPU ${what}${i.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
        vendor: i.vendor ?? '', architecture: i.architecture ?? '', description: i.description ?? '',
        isFallbackAdapter: Boolean(i.isFallbackAdapter) };
    }
    if (which === 'webgl2') {
      const gl = (sim?.renderer ?? app().renderer).getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      const vendor = gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
      return { api: which, name: `WebGL2 ${renderer}`, vendor, architecture: '', description: renderer,
        isFallbackAdapter: /swiftshader|llvmpipe|software/i.test(renderer) };
    }
    return { api: null, name: 'no GPU yet', vendor: '', architecture: '', description: '', isFallbackAdapter: false };
  };

  const api = {
    get api() { return apiOf(); },
    apiOf,
    // The old build's methods return the value, this one's a promise: an
    // async wrapper hands both back as a promise of the value.
    async readState(sim) { return simOf(sim).readState(); },
    async readCell(x, y, z, sim) { return simOf(sim).readCell(x, y, z); },
    async census(sim) { return simOf(sim).census(); },
    async fence(sim) {
      const s = sim ?? app()?.sim, gpu = gpuOf(s);
      if (gpu) return gpu.fence();     // flush, then onSubmittedWorkDone (B8)
      // the old build: a one-texel read of the state, which waits for the passes that wrote it
      if (typeof s?.gpuSync === 'function') return s.gpuSync();
      throw new Error('page-gpu: nothing to fence on (no WebGPU device and no sim.gpuSync)');
    },
    drawCount() {
      const n = draws();
      base ??= n;
      return n - base;
    },
    gpuName(sim) { return info(sim).name; },
    info,
  };
  Object.defineProperty(window, '__pageGpu', { value: Object.freeze(api), configurable: true });
}

/**
 * Defines window.__pageGpu in every document `target` loads from now on, and
 * in the documents it already shows.
 * @template {import('playwright').Page | import('playwright').BrowserContext} T
 * @param {T} target a page or a context
 * @returns {Promise<T>}
 */
export async function pageGpu(target) {
  await target.addInitScript(installPageGpu);
  const pages = typeof target.pages === 'function' ? target.pages() : [target];
  for (const p of pages) if (p.url() !== 'about:blank') await p.evaluate(installPageGpu);
  return target;
}

// Node-side wrappers: each installs the helper if the page lacks it, so they
// work on a page that never went through pageGpu.
const run = async (page, fn, arg) => {
  await page.evaluate(installPageGpu);
  return page.evaluate(fn, arg);
};

/** 'webgpu', 'webgl2', or null when the app hasn't booted. */
export const api = (page) => run(page, () => window.__pageGpu.api);
/** The GPU's name for reports: "WebGPU <vendor architecture …>" or "WebGL2 <renderer>". */
export const gpuName = (page) => run(page, () => window.__pageGpu.gpuName());
/** { api, name, vendor, architecture, description, isFallbackAdapter } */
export const pageGpuInfo = (page) => run(page, () => window.__pageGpu.info());
/** Resolves when the page's GPU has finished the work recorded so far. */
export const fence = (page) => run(page, () => window.__pageGpu.fence());
/** Draws and dispatches since the page's first drawCount (0 on that call). */
export const drawCount = (page) => run(page, () => window.__pageGpu.drawCount());
/** The current sim's census: { [id]: { n, T, minY, maxY, Tmax } }. */
export const census = (page) => run(page, () => window.__pageGpu.census());
/** One cell of the current state: [a, b] as plain arrays of 4 numbers. */
export const readCell = (page, x, y, z) => run(page, async ([x, y, z]) => {
  const [a, b] = await window.__pageGpu.readCell(x, y, z);
  return [Array.from(a), Array.from(b)];
}, [x, y, z]);
