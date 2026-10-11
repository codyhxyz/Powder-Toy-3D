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
//
// usage: node tools/page-gpu.mjs [--port N]   (its self-check, at the end: both
//        branches on stand-ins of the two builds, in headless Chromium)
import { fileURLToPath } from 'node:url';

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

// ---------------------------------------------------------------- self-check
// node tools/page-gpu.mjs [--port N]: both branches in headless Chromium, on
// stand-ins of the two builds' window.__app (neither build's app is needed):
// this build's Gpu from src/gpu with a sim whose reads are promises, and a
// WebGL2 renderer with a sim whose reads return values, as the frozen build's.

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [{ launchBrowser, newTestPage, gpuInfo }, { startVite }] = await Promise.all([import('./browser.mjs'), import('./vite-server.mjs')]);
  const fails = [];
  const check = (name, ok, info = '') => { if (!ok) fails.push(name); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
  const vite = await startVite({ harness: true });
  const browser = await launchBrowser();
  try {
    const page = await pageGpu(await newTestPage(browser, { mode: 'manual' }));
    const url = vite.url('/tools/harness/index.html');   // any page of ours: a secure origin that serves /src
    await page.goto(url);
    check('the init script defines window.__pageGpu', await page.evaluate(() => typeof window.__pageGpu?.census === 'function'));
    check('no app yet: api is null', (await api(page)) === null);

    // ---- this build: window.__app.gpu, reads that return promises
    const gpuSide = await page.evaluate(async () => {
      const { probeWebGPU, createGpu } = await import('/src/gpu/index.js');
      const probe = await probeWebGPU({ allowFallback: true });
      if (!probe.ok) return { error: probe.message };
      const gpu = await createGpu({ adapter: probe.adapter, label: 'page-gpu check', testMode: 'manual' });
      const A = new Float32Array([1, 20, 0, 0.5]), B = new Float32Array([0, -1, 0, 1.5]);
      const later = (v) => new Promise((r) => setTimeout(() => r(v), 5));
      let updates = 0;
      const info = { update() { updates++; } };
      window.__app = { gpu, renderer: { info }, sim: {
        readState: () => later([A, B]), readCell: () => later([A, B]), census: () => later({ 1: { n: 3, T: 20, minY: 0, maxY: 1, Tmax: 20 } }),
      } };
      const P = window.__pageGpu, out = { api: P.api };
      const [a] = await P.readState();
      out.readState = Array.from(a);
      out.census = (await P.census())[1].n;
      out.fence = await Promise.race([P.fence().then(() => 'done'), new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
      out.first = P.drawCount();
      gpu.stats.draws += 1; gpu.stats.dispatches += 3; gpu.stats.indirectDispatches += 1;   // a draw, a direct and an indirect dispatch
      info.update(); info.update();                                                        // two three.js mesh draws
      out.later = P.drawCount();
      out.threeCalls = updates;
      out.info = P.info();
      return out;
    });
    if (gpuSide.error) check('a WebGPU adapter (run with --enable-unsafe-webgpu)', false, gpuSide.error);
    else {
      check('webgpu: api', gpuSide.api === 'webgpu', gpuSide.api);
      check('webgpu: readState resolves to the sim\'s arrays', gpuSide.readState.join() === '1,20,0,0.5', gpuSide.readState.join());
      check('webgpu: census resolves', gpuSide.census === 3);
      check('webgpu: fence resolves through gpu.fence()', gpuSide.fence === 'done', gpuSide.fence);
      check('webgpu: drawCount counts from its first call', gpuSide.first === 0 && gpuSide.later === 1 + 2 + 2,
        `${gpuSide.first} then ${gpuSide.later} (want 0, then 1 draw + 2 dispatches + 2 three.js draws)`);
      check('webgpu: three\'s Info.update still runs', gpuSide.threeCalls === 2);
      check('webgpu: gpuName names the adapter', /^WebGPU /.test(gpuSide.info.name), gpuSide.info.name);
      const node = { api: await api(page), name: await gpuName(page), census: await census(page), cell: await readCell(page, 1, 2, 3) };
      await fence(page);
      check('webgpu: the Node-side wrappers', node.api === 'webgpu' && node.name === gpuSide.info.name && node.census[1].n === 3
        && node.cell[0].join() === '1,20,0,0.5' && node.cell[1].join() === '0,-1,0,1.5', JSON.stringify(node));
      const g = await gpuInfo(page);
      console.log(`     adapter: ${g.vendor} ${g.architecture}${g.isFallbackAdapter ? ' (fallback)' : ''}`);
    }

    // ---- the frozen build: window.__app.renderer is WebGL2, the reads return values
    await page.reload();
    const glSide = await page.evaluate(async () => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { error: 'no WebGL2 context' };
      const A = new Float32Array([2, 30, 0, 0.25]), B = new Float32Array(4);
      let syncs = 0;
      const renderer = { getContext: () => gl, renderBufferDirect() {} };
      window.__app = { renderer, sim: {
        readState: () => [A, B], readCell: () => [A, B], census: () => ({ 2: { n: 5 } }), gpuSync: () => { syncs++; },
      } };
      const P = window.__pageGpu, out = { api: P.api };
      const s = P.readState();   // check-async-reads: ignore held to test it is a promise; awaited below
      out.promise = s instanceof Promise;
      out.readState = Array.from((await s)[0]);
      out.census = (await P.census())[2].n;
      await P.fence();
      out.syncs = syncs;
      out.first = P.drawCount();
      renderer.renderBufferDirect(); renderer.renderBufferDirect(); renderer.renderBufferDirect();
      out.later = P.drawCount();
      out.info = P.info();
      return out;
    });
    if (glSide.error) check('a WebGL2 context for the frozen build\'s branch', false, glSide.error);
    else {
      check('webgl2: api', glSide.api === 'webgl2', glSide.api);
      check('webgl2: a sync read comes back as a promise of its value', glSide.promise && glSide.readState.join() === '2,30,0,0.25');
      check('webgl2: census', glSide.census === 5);
      check('webgl2: fence is sim.gpuSync()', glSide.syncs === 1);
      check('webgl2: drawCount counts renderBufferDirect calls', glSide.first === 0 && glSide.later === 3, `${glSide.first} then ${glSide.later}`);
      check('webgl2: gpuName is the unmasked renderer', /^WebGL2 \S/.test(glSide.info.name), glSide.info.name);
    }

    // ---- pageGpu on a page that already shows a document
    const late = await newTestPage(browser, { mode: 'manual' });
    await late.goto(url);
    await pageGpu(late);
    check('pageGpu installs into the document a page already shows', await late.evaluate(() => typeof window.__pageGpu?.fence === 'function'));
  } finally {
    await browser.close();
    await vite.close();
  }
  console.log(fails.length ? `${fails.length} FAILED` : 'page-gpu OK');
  process.exit(fails.length ? 1 : 0);
}
