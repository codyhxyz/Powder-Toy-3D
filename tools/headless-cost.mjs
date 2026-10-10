// Equal-work headless experiment, not a visual/performance regression suite.
// Start your own Vite first. Run: node tools/headless-cost.mjs --port 54873
// All modes run the same seeded physics; only display cadence changes.
// Timings include CPU submission, GPU sync and contention, NOT GPU utilization.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const port = opt('port', '54873'), size = opt('size', '128');
const ticks = Number(opt('ticks', '24')), rounds = Number(opt('rounds', '3'));
assert(Number.isInteger(ticks) && ticks > 0 && ticks % 6 === 0);
assert(Number.isInteger(rounds) && rounds > 0);
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(120000);
  await page.routeWebSocket(/.*/, () => {}); // no HMR reloads or multiplayer during measurement
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (/GL_INVALID|WebGL:/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    // Same held-rAF technique as tools/bench.mjs. Not suitable unchanged for
    // Playwright UI tests: locator actionability itself can require live rAF.
    let held = new Map(), id = 0, now = 0;
    window.requestAnimationFrame = cb => { held.set(++id, cb); return id; };
    window.cancelAnimationFrame = id => held.delete(id);
    window.__cost = {
      pump() {
        const callbacks = [...held.values()];
        held.clear();
        now += 1000 / 60;
        callbacks.forEach(cb => cb(now));
      },
      seed() {
        let s = 12345;
        Math.random = () => {
          s |= 0; s = (s + 0x6d2b79f5) | 0;
          let t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      },
    };
    window.__cost.seed();
    // Deliberately reproduce the existing tests' attempted paused boot.
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  });
  await page.goto(`http://localhost:${port}/?size=${size}&preset=lab`);
  await page.waitForFunction(() => window.__app?.sim, null, { polling: 100 });
  console.log(JSON.stringify({ boot: await page.evaluate(() => ({
    pausedDespiteSavedTrue: window.__app.settings.paused,
    grid: window.__app.settings.size,
  })) }));
  await page.evaluate(() => {
    const a = window.__app, b = window.__cost, R = a.renderer;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    b.draws = 0; b.views = 0;
    const draw = R.renderBufferDirect;
    R.renderBufferDirect = function (...args) {
      b.draws++;
      const target = R.getRenderTarget();
      if (target) b.lastTarget = target;
      b.canvasLast = !target;
      return draw.apply(this, args);
    };
    const render = a.post.render;
    a.post.render = function (...args) { b.views++; return render.apply(this, args); };
    const own = new a.THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const gl = R.getContext(), arrays = {
      [gl.FLOAT]: Float32Array, [gl.HALF_FLOAT]: Uint16Array,
      [gl.UNSIGNED_BYTE]: Uint8Array, [gl.UNSIGNED_INT]: Uint32Array, [gl.INT]: Int32Array,
    };
    // As bench.mjs: read the actual last offscreen target, not gl.finish().
    const reads = new Map();
    const read = target => {
      const prev = R.getRenderTarget();
      R.setRenderTarget(target);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      let f = reads.get(target);
      if (!f) {
        const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
        const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
        f = { format, type, buf: new arrays[type](4) };
        reads.set(target, f);
      }
      gl.readPixels(0, 0, 1, 1, f.format, f.type, f.buf);
      R.setRenderTarget(prev);
    };
    b.sync = () => {
      a.sim.gpuSync();
      if (b.lastTarget) read(b.lastTarget);
      if (b.canvasLast) {
        const prev = R.getRenderTarget();
        R.setRenderTarget(own); R.clear(); read(own); R.setRenderTarget(prev);
      }
    };
    b.reset = () => {
      b.seed();
      a.loadPreset('lab', false);
      a.sim.frame = 0; a.sim.paints = 0;
      a.day.clock = 0;
      a.post.reset();
      b.sync();
      b.draws = b.views = 0;
    };
    b.run = (every, ticks) => {
      b.reset();
      const start = performance.now();
      for (let i = 1; i <= ticks; i++) {
        for (let k = 0; k < 4; k++) a.sim.step();
        a.day.clock += 4;
        if (every && i % every === 0) {
          // Advance presentation time without running intermediate callbacks.
          b.pump();
        }
        b.sync(); // same synchronization boundary for all three modes
      }
      return { ms: performance.now() - start, steps: a.sim.frame, draws: b.draws, views: b.views };
    };
  });
  // Compile outside measurements, including the view's dynamically gated shaders.
  await page.evaluate(() => window.__cost.run(1, 24));
  const results = [];
  let expectedHash;
  for (let round = 0; round < rounds; round++) {
    const modes = round % 2 ? [0, 6, 1] : [1, 6, 0];
    for (const every of modes) {
      const result = await page.evaluate(async ({ every, ticks }) => {
        const b = window.__cost, a = window.__app;
        const result = b.run(every, ticks);
        // Full state equality, outside the timed region.
        const hashes = [];
        for (const state of a.sim.readState()) {
          const hash = await crypto.subtle.digest('SHA-256', state);
          hashes.push(Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join(''));
        }
        return { ...result, hashes };
      }, { every, ticks });
      expectedHash ??= result.hashes;
      assert.deepEqual(result.hashes, expectedHash, 'presentation cadence changed physics');
      assert.equal(result.steps, ticks * 4);
      assert.equal(result.views, every ? ticks / every : 0);
      const row = { round, mode: every === 1 ? 'render-every-tick' : every === 6 ? 'render-every-sixth' : 'physics-only', ...result };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const idle = await page.evaluate(async () => {
    const b = window.__cost, before = b.draws;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return b.draws - before;
  });
  assert.equal(idle, 0, 'held page drew while idle');
  const pausedIdle = await page.evaluate(() => {
    const b = window.__cost;
    // Existing render-on-demand should also idle without suppressing UI rAF.
    // Settle the derived filters and TAA, then sample 60 unchanged app ticks.
    for (let i = 0; i < 180; i++) b.pump();
    b.sync();
    const before = b.draws;
    for (let i = 0; i < 60; i++) b.pump();
    b.sync();
    return b.draws - before;
  });
  assert.equal(pausedIdle, 0, 'paused, settled app still drew');
  assert.deepEqual(errors, []);
  const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(JSON.stringify({ summary: [...new Set(results.map(r => r.mode))].map(mode => ({
    mode, medianMs: median(results.filter(r => r.mode === mode).map(r => r.ms)),
    draws: results.find(r => r.mode === mode).draws,
  })), idleDrawsPerSecond: idle, pausedIdleDrawsOver60Ticks: pausedIdle, stateHashesEqual: true }));
} finally {
  await browser.close();
}
