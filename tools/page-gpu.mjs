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
//                          (WebGL2: the work since page-gpu first saw the renderer, below)
//   drawCount()            draws and dispatches since its first call after boot
//                          (which returns 0; 0 before boot)
//   gpuName(), info()      the adapter (WebGPU) or the unmasked renderer (WebGL2)
// `sim` defaults to window.__app.sim, read at the call (a rebuild replaces it).
//
// The two fences. This build's is gpu.fence() (B8): everything submitted to the
// queue. The old build has no such thing: a WebGL read waits for the pending
// work on what it reads and only that, and gl.finish() doesn't wait at all
// (the old src/gfx/profiler.js, measured on Apple GPUs). So its fence is the
// old tools/bench.mjs sync: sim.gpuSync() (a texel of the state), a texel of
// the newest offscreen target drawn, and, when the canvas was drawn last, a
// clear and read of a 1×1 target of our own (a read of the canvas waits for
// nothing). Knowing the newest target takes a hook on the renderer's
// renderBufferDirect, which also counts the draws for drawCount. It goes in at
// the first __pageGpu call that sees the WebGL renderer (any of them: api,
// gpuName, drawCount, fence), so a tool that times the old build makes one
// before the span it times, as it calls drawCount once before counting; the
// gpuName for its report, or an untimed fence after boot, does it. Until a
// draw has been seen, the fence clears and reads its own target as a best
// effort.
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
// WebGL2 branches of info, fence and drawCount: getContext(), readPixels):
// the cross-build runs need it.
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
  // The old build's three.WebGLRenderer, by its flag: getContext() on three's
  // WebGPURenderer would run the backend's lazy context getter, which configures
  // the canvas (the side effect W7 and B10 keep to src/gpu/present.js).
  const glRendererOf = (sim) => {
    const r = sim?.renderer ?? app()?.renderer;
    return r?.isWebGLRenderer === true ? r : null;
  };
  // The old build's renderer, hooked once: three calls renderBufferDirect once
  // per draw (every pass of the old sim and view was one, as tools/bench.mjs
  // and headless-cost counted them), so the hook counts the draws and notes
  // where each went, the newest offscreen target and whether the canvas came
  // last (null target), for the fence.
  const hooks = new WeakMap();   // renderer → { draws, last, canvasLast, seen, reads, own }
  const glHook = (r) => {
    let h = hooks.get(r);
    if (h) return h;
    h = { draws: 0, last: null, canvasLast: false, seen: new WeakSet(), reads: new WeakMap(), own: null };
    hooks.set(r, h);
    const draw = r.renderBufferDirect;
    r.renderBufferDirect = function (...args) {
      const t = r.getRenderTarget();
      h.draws++;
      h.canvasLast = !t;
      if (t && t !== h.last) {
        h.last = t;
        if (!h.seen.has(t)) {   // a disposed target is no longer one to read
          h.seen.add(t);
          t.addEventListener('dispose', () => { if (h.last === t) h.last = null; });
        }
      }
      return draw.apply(this, args);
    };
    return h;
  };
  const apiOf = (sim) => {
    if (gpuOf(sim)) return 'webgpu';
    const r = glRendererOf(sim);
    if (r && typeof WebGL2RenderingContext === 'function' && r.getContext() instanceof WebGL2RenderingContext) {
      glHook(r);
      return 'webgl2';
    }
    return null;
  };

  // One texel of a target of the old build's renderer, read in the format the
  // implementation reads it in natively (float, half float, 8-bit or integer
  // alike, as the old bench did). The first read of each target is checked.
  const READ_ARRAYS = (gl) => ({ [gl.FLOAT]: Float32Array, [gl.HALF_FLOAT]: Uint16Array, [gl.UNSIGNED_BYTE]: Uint8Array,
    [gl.BYTE]: Int8Array, [gl.UNSIGNED_SHORT]: Uint16Array, [gl.SHORT]: Int16Array, [gl.UNSIGNED_INT]: Uint32Array, [gl.INT]: Int32Array });
  const readTexel = (r, h, t) => {
    const gl = r.getContext();
    const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), level = r.getActiveMipmapLevel();
    r.setRenderTarget(t);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);   // (three leaves an MRT target's read buffer where its last read put it)
    let f = h.reads.get(t), err = 0;
    if (!f) {
      gl.getError();   // (an older error isn't ours)
      const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT), type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
      f = { format, type, buf: new (READ_ARRAYS(gl)[type] ?? Float32Array)(4) };
      gl.readPixels(0, 0, 1, 1, format, type, f.buf);
      err = gl.getError();
      if (!err) h.reads.set(t, f);
    } else gl.readPixels(0, 0, 1, 1, f.format, f.type, f.buf);
    r.setRenderTarget(prev, face, level);
    if (err) throw new Error(`page-gpu: the fence's read of a render target failed (GL error ${err})`);
  };
  // After a pass into the canvas: clear a 1×1 target of our own and read that
  // (the old profiler's and bench's way). Its class comes from the old app's
  // THREE (window.__app.THREE), else from the sim's targets.
  const syncOwn = (r, h, sim) => {
    if (!h.own) {
      const RenderTarget = app()?.THREE?.WebGLRenderTarget ?? sim?.targets?.[0]?.constructor;
      if (typeof RenderTarget !== 'function') throw new Error('page-gpu: no WebGLRenderTarget class for the fence (window.__app.THREE)');
      h.own = new RenderTarget(1, 1, { depthBuffer: false });
    }
    const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), level = r.getActiveMipmapLevel();
    r.setRenderTarget(h.own);
    r.clear(true, false, false);
    r.setRenderTarget(prev, face, level);
    readTexel(r, h, h.own);
  };

  // drawCount: the old build counts its renderer's draws (the hook above);
  // this one counts our draws and dispatches from gpu.stats
  // (an indirect dispatch once, though stats.dispatches counts it twice, B3)
  // plus three's mesh draws, through its Info.update (one call per draw).
  // The count starts at drawCount's first call once there is a GPU, and again
  // when the counted device or renderer changes (a reload of the app, a new
  // harness device): a call before boot returns 0 and fixes nothing.
  let base = 0, baseOf = null;
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
  // [what is counted (the device or the renderer), its count so far], or null before boot
  const draws = () => {
    const which = apiOf();
    if (which === 'webgpu') {
      const gpu = gpuOf(), s = gpu.stats, three = countCalls(app()?.renderer?.info, 'update');
      return [gpu, s.draws + s.dispatches - s.indirectDispatches + three()];
    }
    if (which === 'webgl2') return [app().renderer, glHook(app().renderer).draws];
    return null;
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
      const gl = glRendererOf(sim).getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
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
      // the old build (the header): the state, the newest target, the canvas through our own
      const r = apiOf(s) === 'webgl2' ? glRendererOf(s) : null;
      if (!r && typeof s?.gpuSync !== 'function') throw new Error('page-gpu: nothing to fence on (no WebGPU device, no WebGL2 renderer)');
      await s?.gpuSync?.();
      if (!r) return;
      const h = glHook(r);
      if (h.last) readTexel(r, h, h.last);
      if (h.canvasLast || !h.draws) syncOwn(r, h, s);
    },
    drawCount() {
      const now = draws();
      if (!now) return 0;
      const [of, n] = now;
      if (of !== baseOf) { baseOf = of; base = n; }
      return n - base;
    },
    gpuName(sim) { return info(sim).name; },
    info,
  };
  Object.defineProperty(window, '__pageGpu', { value: Object.freeze(api), configurable: true });
  apiOf();   // a document that already shows the old build's app (pageGpu after boot): hook its renderer now
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
/** Resolves when the page's GPU has finished the work recorded so far (on the old build, since page-gpu first saw its renderer). */
export const fence = (page) => run(page, () => window.__pageGpu.fence());
/** Draws and dispatches since the page's first drawCount after boot (0 on that call). */
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
      let updates = 0, touched = 0;
      const info = { update() { updates++; } };
      const P = window.__pageGpu, out = {};
      // before boot: three's renderer without our device, whose getContext() would configure the canvas
      window.__app = { renderer: { info, getContext() { touched++; return null; } } };
      out.early = { api: P.api, count: P.drawCount(), name: P.gpuName() };
      gpu.stats.draws += 4;   // boot work before the first count
      window.__app = { gpu, renderer: { info, getContext() { touched++; return null; } }, sim: {
        readState: () => later([A, B]), readCell: () => later([A, B]), census: () => later({ 1: { n: 3, T: 20, minY: 0, maxY: 1, Tmax: 20 } }),
      } };
      out.api = P.api;
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
      out.touched = touched;
      return out;
    });
    if (gpuSide.error) check('a WebGPU adapter (run with --enable-unsafe-webgpu)', false, gpuSide.error);
    else {
      check('before boot: api null, drawCount 0, no getContext() on a renderer that isn\'t WebGL',
        gpuSide.early.api === null && gpuSide.early.count === 0 && gpuSide.touched === 0, JSON.stringify({ ...gpuSide.early, getContext: gpuSide.touched }));
      check('webgpu: api', gpuSide.api === 'webgpu', gpuSide.api);
      check('webgpu: readState resolves to the sim\'s arrays', gpuSide.readState.join() === '1,20,0,0.5', gpuSide.readState.join());
      check('webgpu: census resolves', gpuSide.census === 3);
      check('webgpu: fence resolves through gpu.fence()', gpuSide.fence === 'done', gpuSide.fence);
      check('webgpu: drawCount counts from its first call after boot', gpuSide.first === 0 && gpuSide.later === 1 + 2 + 2,
        `${gpuSide.first} then ${gpuSide.later} (want 0, then 1 draw + 2 dispatches + 2 three.js draws; 4 boot draws before)`);
      check('webgpu: three\'s Info.update still runs', gpuSide.threeCalls === 2);
      check('webgpu: gpuName names the adapter', /^WebGPU /.test(gpuSide.info.name), gpuSide.info.name);
      const node = { api: await api(page), name: await gpuName(page), census: await census(page), cell: await readCell(page, 1, 2, 3) };
      await fence(page);
      check('webgpu: the Node-side wrappers', node.api === 'webgpu' && node.name === gpuSide.info.name && node.census[1].n === 3
        && node.cell[0].join() === '1,20,0,0.5' && node.cell[1].join() === '0,-1,0,1.5', JSON.stringify(node));
      const g = await gpuInfo(page);
      console.log(`     adapter: ${g.vendor} ${g.architecture}${g.isFallbackAdapter ? ' (fallback)' : ''}`);
    }

    // ---- the frozen build: window.__app.renderer is three's WebGLRenderer (a real one,
    // the old build's), the reads return values, sim.gpuSync reads a texel of the state
    await page.reload();
    const glSide = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: Object.assign(document.createElement('canvas'), { width: 4, height: 4 }) }); }
      catch (e) { return { error: e.message }; }
      const gl = renderer.getContext();
      if (!(gl instanceof WebGL2RenderingContext)) return { error: 'no WebGL2 context' };
      // every read and clear, with the framebuffer it went to (null: the canvas)
      const log = [], readPixels = gl.readPixels.bind(gl), clear = gl.clear.bind(gl);
      gl.readPixels = (...a) => { readPixels(...a); log.push({ op: 'read', fb: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), px: Array.from(a[6].slice(0, 4)) }); };
      gl.clear = (bits) => { clear(bits); log.push({ op: 'clear', fb: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) }); };
      // the state (float, as the old sim's) and another pass's target (8-bit), one quad drawn into either or the canvas
      const state = new THREE.WebGLRenderTarget(2, 2, { type: THREE.FloatType, depthBuffer: false });
      const other = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
      const material = new THREE.MeshBasicMaterial({ color: 0xff00ff });
      const scene = new THREE.Scene().add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
      const pass = (t) => { renderer.setRenderTarget(t); renderer.render(scene, camera); };
      const fbOf = (t) => renderer.properties.get(t).__webglFramebuffer;
      const A = new Float32Array([2, 30, 0, 0.25]), B = new Float32Array(4), texel = new Float32Array(4);
      let syncs = 0;
      window.__app = { renderer, THREE, sim: { renderer, targets: [state],
        readState: () => [A, B], readCell: () => [A, B], census: () => ({ 2: { n: 5 } }),
        gpuSync() { syncs++; renderer.readRenderTargetPixels(state, 0, 0, 1, 1, texel); },   // as the old src/sim.js
      } };
      const P = window.__pageGpu, out = { api: P.api };
      const s = P.readState();   // check-async-reads: ignore held to test it is a promise; awaited below
      out.promise = s instanceof Promise;
      out.readState = Array.from((await s)[0]);
      out.census = (await P.census())[2].n;
      log.length = 0;
      await P.fence();                  // no draw seen yet: sim.gpuSync, and our own target as a best effort
      out.beforeDraws = log.splice(0);  // (three skips gpuSync's read: the state has no framebuffer before its first pass)
      out.syncsBefore = syncs;
      out.first = P.drawCount();
      pass(state);                      // a sim pass…
      pass(other);                      // …then another pass, into its own target
      log.length = 0;
      await P.fence();
      out.afterOther = { log: log.splice(0), stateFb: fbOf(state), otherFb: fbOf(other), restored: renderer.getRenderTarget() === other };
      pass(null);                       // a pass into the canvas
      log.length = 0;
      await P.fence();
      out.afterCanvas = { log: log.splice(0), restored: renderer.getRenderTarget() === null };
      out.later = P.drawCount();
      out.syncs = syncs;
      // three's cached GL state still holds: a pass after the fences draws and reads back right
      material.color.setHex(0x00ff00);
      pass(other);
      const px = new Uint8Array(4);
      renderer.readRenderTargetPixels(other, 0, 0, 1, 1, px);
      out.after = Array.from(px);
      out.info = P.info();
      const fbs = new Map();   // framebuffers as names, for the report
      const name = (fb) => fb === null ? 'canvas' : fb === out.afterOther.stateFb ? 'state' : fb === out.afterOther.otherFb ? 'other'
        : (fbs.has(fb) || fbs.set(fb, `own${fbs.size}`), fbs.get(fb));
      for (const l of [...out.beforeDraws, ...out.afterOther.log, ...out.afterCanvas.log]) l.fb = name(l.fb);
      delete out.afterOther.stateFb; delete out.afterOther.otherFb;
      renderer.dispose();
      return out;
    });
    if (glSide.error) check('a WebGL2 context for the frozen build\'s branch', false, glSide.error);
    else {
      const ops = (log) => log.map((l) => `${l.op} ${l.fb}`).join(', ');
      const o = glSide.afterOther, c = glSide.afterCanvas;
      check('webgl2: api', glSide.api === 'webgl2', glSide.api);
      check('webgl2: a sync read comes back as a promise of its value', glSide.promise && glSide.readState.join() === '2,30,0,0.25');
      check('webgl2: census', glSide.census === 5);
      check('webgl2: fence before any draw is seen: sim.gpuSync, then a clear and a read of its own target',
        glSide.syncsBefore === 1 && ops(glSide.beforeDraws) === 'clear own0, read own0', `${ops(glSide.beforeDraws)}; gpuSync ${glSide.syncsBefore}`);
      check('webgl2: fence after a pass into another target: sim.gpuSync, then a read of that target',
        o.log.length === 2 && o.log[0].op === 'read' && o.log[0].fb === 'state' && o.log[1].op === 'read' && o.log[1].fb === 'other'
        && o.log[1].px.join() === '255,0,255,255' && o.restored, `${ops(o.log)}; other read ${o.log[1]?.px}; target restored ${o.restored}`);
      const own = c.log.find((l) => l.op === 'clear')?.fb;
      check('webgl2: fence after a pass into the canvas: a clear and a read of its own 1×1 target, no read of the canvas',
        own?.startsWith('own') && c.log.at(-2)?.op === 'clear' && c.log.at(-1)?.op === 'read' && c.log.at(-1).fb === own
        && !c.log.some((l) => l.fb === 'canvas') && c.restored && glSide.syncs === 3, `${ops(c.log)}; canvas restored ${c.restored}`);
      check('webgl2: drawCount counts the renderer\'s draws', glSide.first === 0 && glSide.later === 3, `${glSide.first} then ${glSide.later}`);
      check('webgl2: three draws and reads back right after the fences', glSide.after.join() === '0,255,0,255', glSide.after.join());
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
