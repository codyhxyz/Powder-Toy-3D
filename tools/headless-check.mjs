// Real-GPU checks for the shared headless modes. Own Vite required:
// node tools/headless-check.mjs --port 54873
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPacer } from '../src/gfx/pacing.js';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '54873';
const url = `http://localhost:${port}/?size=64&preset=lab`;
const pace = createPacer({ derivedSettle: 2, viewSettle: 2, presentHz: 10 });
let ticks = 0, presentations = 0;
for (let i = 0; i < 60; i++) {
  const now = i * 1000 / 60;
  if (pace.due(now)) ticks++;
  if (pace.present(now)) {
    presentations++;
    const derived = pace.derived('fixed');
    pace.view('fixed', derived);
  }
}
assert.equal(ticks, 60);
assert.equal(presentations, 10);
assert(pace.settled);
assert(pace.present(1000, true));
console.log('ok: 60 simulation ticks / 10 presentations, convergence counts preserved');

const browser = await launchBrowser();
const errors = [];
const watch = page => {
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', m => { if (/GL_INVALID|WebGL:/.test(m.text())) errors.push(m.text()); });
};
try {
  const results = [];
  for (const mode of ['normal', 'visual', 'preview']) {
    const options = { viewport: { width: 640, height: 400 } };
    const page = mode === 'normal' ? await browser.newPage(options) : await newTestPage(browser, { ...options, mode });
    watch(page);
    await page.routeWebSocket(/.*/, () => {});
    await page.addInitScript(() => {
      let seed = 12345;
      Math.random = () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      // Only this scheduler test controls global rAF, not the production driver.
      let pending = new Map(), id = 0, now;
      window.requestAnimationFrame = cb => { pending.set(++id, cb); return id; };
      window.cancelAnimationFrame = id => pending.delete(id);
      window.__pump = n => {
        now ??= performance.now();
        for (let i = 0; i < n; i++) {
          now += 1000 / 60;
          const callbacks = [...pending.values()];
          pending.clear();
          callbacks.forEach(cb => cb(now));
        }
      };
    });
    await page.goto(url);
    await ready(page);
    const result = await page.evaluate(async () => {
      const a = window.__app;
      a.autoRes.enabled = false;
      window.__pump(1); // compile outside the count
      let views = 0, derived = 0;
      const draw = a.post.render.bind(a.post), fields = a.sim.updateBricks.bind(a.sim);
      a.post.render = (...args) => { views++; return draw(...args); };
      a.sim.updateBricks = (...args) => { derived++; return fields(...args); };
      const steps = a.sim.frame, time = a.volume.material.uniforms.uTime.value;
      window.__pump(12);
      const hashes = [];
      for (const state of a.sim.readState()) {
        hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', state)), x => x.toString(16).padStart(2, '0')).join(''));
      }
      return { steps: a.sim.frame - steps, views, derived, time: a.volume.material.uniforms.uTime.value - time, hashes };
    });
    assert.equal(result.steps, 48);
    assert.equal(result.views, mode === 'preview' ? 2 : 12);
    assert.equal(result.derived, result.views);
    assert(Math.abs(result.time - 0.2) < 0.00001, 'preview slowed shader animation time');
    if (results.length) assert.deepEqual(result.hashes, results[0].hashes);
    results.push(result);
    console.log(`ok: ${mode}: ${result.steps} steps, ${result.views} views, identical physics`);
    await page.close();
  }

  const manual = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  watch(manual);
  await manual.routeWebSocket(/.*/, () => {});
  await manual.goto(url);
  await ready(manual);
  assert.deepEqual(await manual.evaluate(() => [window.__app.sim.frame, window.__app.settings.paused, window.__app.test.parked]), [0, true, true]);
  // Real locator actionability: global rAF must remain functional.
  await manual.getByTitle('Resume (Space)', { exact: true }).click();
  assert.equal(await manual.evaluate(() => window.__app.settings.paused), false);
  await manual.waitForTimeout(200);
  assert.equal(await manual.evaluate(() => window.__app.sim.frame), 0, 'parked app ran automatically');
  await manual.evaluate(() => window.__app.test.step(12));
  const before = await manual.evaluate(() => ({ step: window.__app.sim.frame, day: window.__app.day.clock }));
  await manual.evaluate(async () => {
    const { PERK } = await import('/src/pov/perks.js');
    const a = __app;
    a.perkOrbs.add(Object.keys(PERK)[0], new a.THREE.Vector3(32, 32, 32));
    window.__birdCount = Object.getOwnPropertyDescriptor(a.birds, 'count');
    Object.defineProperty(a.birds, 'count', { configurable: true, value: 1 });
  }); // marker animation must freeze too, or snapshot rendering never converges
  await render(manual);
  await manual.evaluate(() => Object.defineProperty(__app.birds, 'count', window.__birdCount));
  assert.deepEqual(await manual.evaluate(() => ({ step: window.__app.sim.frame, day: window.__app.day.clock })), before);
  const shot = await manual.screenshot();
  assert(shot.length > 1000);
  await manual.evaluate(() => {
    const a = window.__app, draw = a.renderer.renderBufferDirect;
    window.__draws = 0;
    a.renderer.renderBufferDirect = function (...args) { window.__draws++; return draw.apply(this, args); };
  });
  await manual.waitForTimeout(200);
  assert.equal(await manual.evaluate(() => window.__draws), 0);
  const feature = await manual.evaluate(async () => {
    const { DETAIL, settingKey } = await import('/src/gfx/detail.js');
    const a = window.__app, f = DETAIL.find(f => f.cost === 'low');
    const key = settingKey(f);
    a.settings[key] = !a.settings[key];
    a.applyDetail();
    return { define: f.define, on: a.settings[key], pending: a.detailGate.pending };
  });
  assert(feature.pending > 0, 'delayed base-detail changes must count as pending');
  await render(manual);
  assert.equal(await manual.evaluate(define => !!window.__app.volume.material.defines[define], feature.define), feature.on);
  const pick = await manual.evaluate(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    const { quadVert } = await import('/src/shaders/common.js');
    const { pickFrag } = await import('/src/shaders/render.js');
    a.loadPreset('empty', false);
    a.sim.updateBricks(); // empty occupancy map
    a.sim.paint({ center: new a.THREE.Vector3(32, 32, 32), radius: 1, shape: 1, tool: E.ROCK, rate: 1, replace: false });
    // Deliberately do not refresh the presentation's brick map after the edit.
    const mat = new a.THREE.RawShaderMaterial({
      glslVersion: a.THREE.GLSL3, vertexShader: quadVert, fragmentShader: pickFrag(a.sim.g),
      uniforms: { tA: { value: a.sim.stateA }, tB: { value: a.sim.stateB }, tBrick: { value: a.sim.brick.texture },
        uRo: { value: new a.THREE.Vector3(32.5, 63.5, 32.5) }, uRd: { value: new a.THREE.Vector3(0, -1, 0) } },
    });
    const target = new a.THREE.WebGLRenderTarget(2, 1, { type: a.THREE.FloatType, depthBuffer: false });
    try {
      a.sim.run(mat, target);
      const buf = new Float32Array(8);
      a.renderer.readRenderTargetPixels(target, 0, 0, 2, 1, buf);
      return { face: buf[3], id: buf[4], expected: E.ROCK };
    } finally { mat.dispose(); target.dispose(); }
  });
  assert(pick.face >= 0);
  assert.equal(pick.id, pick.expected, 'picking skipped newly occupied cells before presentation');
  console.log('ok: snapshot waits for base-detail changes; picking does not depend on stale presentation bricks');
  await assert.rejects(manual.evaluate(() => window.__app.test.step(-1)), /steps must/);
  await manual.evaluate(() => window.__app.test.resume());
  await manual.waitForFunction(step => window.__app.sim.frame > step, before.step, { polling: 100 });
  await render(manual); // checkpoint must park even when the caller was running
  const stopped = await manual.evaluate(() => window.__app.sim.frame);
  await manual.waitForTimeout(200);
  assert.equal(await manual.evaluate(() => window.__app.sim.frame), stopped);
  console.log('ok: manual boot, live UI rAF, explicit steps, snapshot without stepping, parked idle, resume');
  await manual.close();

  for (const [mode, suffix] of [['ui', ''], ['visual', '&paused=1']]) {
    const page = await newTestPage(browser, { mode, viewport: { width: 640, height: 400 } });
    watch(page);
    await page.routeWebSocket(/.*/, () => {});
    await page.goto(url + suffix);
    await ready(page);
    assert.equal(await page.evaluate(() => window.__app.settings.paused), true);
    await render(page);
    assert.equal(await page.evaluate(() => window.__app.test.parked), true, 'snapshot checkpoint must stay parked');
    assert.equal(await page.evaluate(() => window.__app.sim.frame), 0);
    console.log(`ok: ${mode}${suffix} starts paused and renders without physics`);
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

// Failure, signal, and lifetime cleanup must close their own Chromium processes.
for (const failure of ['throw', 'timeout', 'signal']) {
  const script = `
    import { launchBrowser } from ${JSON.stringify(new URL('./browser.mjs', import.meta.url).href)};
    const browser = await launchBrowser({ lifetimeMs: ${failure === 'timeout' ? 1500 : 10000} });
    const cdp = await browser.newBrowserCDPSession();
    console.log(JSON.stringify((await cdp.send('SystemInfo.getProcessInfo')).processInfo.map(p => p.id)));
    ${failure === 'throw' ? "throw new Error('intentional cleanup check');" : failure === 'signal' ? "process.kill(process.pid, 'SIGTERM');" : ''}
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, failure === 'signal' ? 143 : 1, child.stderr);
  const pids = JSON.parse(child.stdout.trim());
  assert(pids.length);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Chromium PID ${pid} survived ${failure}`);
  console.log(`ok: browser cleanup after ${failure}`);
}
