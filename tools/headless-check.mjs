// Real-GPU checks for the shared headless modes (docs/webgpu.md I1): the modes
// keep physics identical, preview presents at 10 Hz, a parked page submits
// nothing, picks read the state, and the launcher's browsers close on every
// kind of failure. Own Vite required:
//   node tools/headless-check.mjs --port 54873 [--stage pacer,modes,manual,paused,detail,cleanup]
// Each stage is one browser run of a few minutes on SwiftShader (a boot there
// builds every pipeline, 25-40 s); the default runs them all. The pages run the
// cheapest view (?view=plain, B5) unless a stage says otherwise.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPacer } from '../src/gfx/pacing.js';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '54873';
const STAGES = (args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'pacer,modes,manual,paused,detail,cleanup').split(',');
const base = `http://localhost:${port}/`;
// A small falling-sand scene: an empty 64³ box, then a sand ball painted the
// same way on every page (Math.random is seeded: the cells' seeds repeat).
const url = `${base}?size=64&preset=empty&view=plain`;
const VIEWPORT = { width: 320, height: 200 };
const PUMPS = 6;   // frames at 60 Hz: 0.1 s, one presentation at preview's 10 Hz
// Math.random from a seed (mulberry32); __seed() starts it over. The boot is
// asynchronous (pipelines, three's init), so how many draws other code makes
// before a load (three's UUIDs, the UI) varies: a scene loads right after a reseed.
const seedScript = () => {
  window.__seed = (s = 12345) => {
    let seed = s;
    Math.random = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  window.__seed();
};
// the empty box again (its cells' seeds from a fresh Math.random), and a sand ball
const sandBall = async () => {
  const a = window.__app, { E } = await import('/src/elements.js');
  window.__seed();
  a.loadPreset('empty', false);
  a.sim.paint({ center: new a.THREE.Vector3(32, 40, 32), radius: 6, shape: 0, tool: E.SAND, rate: 1, replace: false });
};

if (STAGES.includes('pacer')) {
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
}

const browser = STAGES.some((s) => ['modes', 'manual', 'paused', 'detail'].includes(s)) ? await launchBrowser() : null;
const errors = [];
const watch = (page) => {
  page.on('pageerror', (error) => errors.push(String(error)));
  // (Chrome reports a WebGPU error as a warning)
  page.on('console', (m) => { if (m.type() === 'warning' && /WebGPU|GPU (validation|internal)/.test(m.text())) errors.push(m.text()); });
};
const prepare = async (page) => {
  watch(page);
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(seedScript);
};
try {
  if (STAGES.includes('modes')) {
    const results = [];
    for (const mode of ['normal', 'visual', 'preview']) {
      const page = mode === 'normal' ? await browser.newPage({ viewport: VIEWPORT }) : await newTestPage(browser, { viewport: VIEWPORT, mode });
      await prepare(page);
      await page.addInitScript(() => {
        // Only this scheduler test controls global rAF, not the production driver.
        let pending = new Map(), id = 0, now;
        window.requestAnimationFrame = (cb) => { pending.set(++id, cb); return id; };
        window.cancelAnimationFrame = (id) => pending.delete(id);
        window.__pump = (n) => {
          now ??= performance.now();
          for (let i = 0; i < n; i++) {
            now += 1000 / 60;
            const callbacks = [...pending.values()];
            pending.clear();
            callbacks.forEach((cb) => cb(now));
          }
        };
      });
      await page.goto(url);
      await ready(page);
      const result = await page.evaluate(async ({ pumps, paint }) => {
        const a = window.__app;
        a.autoRes.enabled = false;
        a.settings.paused = false;
        a.settings.steps = 1;
        await (0, eval)(`(${paint})`)();
        // one frame outside the count, and each one's GPU work done before the
        // next (a frame isn't due while two are in flight: docs/webgpu.md B3)
        window.__pump(1);
        await a.gpu.fence();
        let views = 0, derived = 0;
        const draw = a.post.render.bind(a.post), fields = a.sim.updateBricks.bind(a.sim);
        a.post.render = (...args) => { views++; return draw(...args); };
        a.sim.updateBricks = (...args) => { derived++; return fields(...args); };
        const steps = a.sim.frame, time = a.view.time;
        for (let i = 0; i < pumps; i++) { window.__pump(1); await a.gpu.fence(); }
        const hashes = [];
        for (const state of await a.sim.readState()) {
          hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', state)), (x) => x.toString(16).padStart(2, '0')).join(''));
        }
        return { steps: a.sim.frame - steps, views, derived, time: a.view.time - time, hashes };
      }, { pumps: PUMPS, paint: sandBall.toString() });
      assert.equal(result.steps, PUMPS);
      assert.equal(result.views, mode === 'preview' ? PUMPS / 6 : PUMPS);
      assert.equal(result.derived, result.views);
      assert(Math.abs(result.time - PUMPS / 60) < 0.00001, 'preview slowed the view\'s animation time');
      if (results.length) assert.deepEqual(result.hashes, results[0].hashes);
      results.push(result);
      console.log(`ok: ${mode}: ${result.steps} steps, ${result.views} views, identical physics`);
      await page.close();
    }
  }

  if (STAGES.includes('manual')) {
    const manual = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
    await prepare(manual);
    await manual.goto(url);
    await ready(manual);
    assert.deepEqual(await manual.evaluate(() => [window.__app.sim.frame, window.__app.settings.paused, window.__app.test.parked]), [0, true, true]);
    await manual.evaluate(() => window.__app.test.ready());
    // Real locator actionability: global rAF must remain functional.
    await manual.getByTitle('Resume (Space)', { exact: true }).click();
    assert.equal(await manual.evaluate(() => window.__app.settings.paused), false);
    await manual.waitForTimeout(200);
    assert.equal(await manual.evaluate(() => window.__app.sim.frame), 0, 'parked app ran automatically');
    await manual.evaluate(`(${sandBall})()`);
    await manual.evaluate(() => window.__app.test.step(4));
    const before = await manual.evaluate(() => ({ step: window.__app.sim.frame, day: window.__app.day.clock }));
    await manual.evaluate(() => { window.__app.post.settings.taa = false; });   // (one frame converges the view: a test's snapshot)
    await render(manual);
    assert.deepEqual(await manual.evaluate(() => ({ step: window.__app.sim.frame, day: window.__app.day.clock })), before);
    const shot = await manual.screenshot();
    assert(shot.length > 1000);
    // parked: nothing recorded or submitted, and no frame callbacks of the app's
    const parked = await manual.evaluate(async () => {
      const a = window.__app, s = a.gpu.stats.submits, c = a.loop.callbacks;
      await new Promise((r) => setTimeout(r, 200));
      return { submits: a.gpu.stats.submits - s, callbacks: a.loop.callbacks - c };
    });
    assert.deepEqual(parked, { submits: 0, callbacks: 0 });
    // The pick marches the state itself (an exact cell DDA, docs/webgpu.md F5):
    // a cell painted since the last derived frame is hit, though the bricks the
    // view skips by haven't seen it.
    const pick = await manual.evaluate(async () => {
      const a = window.__app, { E } = await import('/src/elements.js');
      a.loadPreset('empty', false);
      a.sim.updateBricks();   // an empty brick map
      a.sim.paint({ center: new a.THREE.Vector3(32, 32, 32), radius: 1, shape: 1, tool: E.ROCK, rate: 1, replace: false });
      // (no derived frame after the edit)
      const hit = await a.vol.pick([32.5, 63.5, 32.5], [0, -1, 0]);
      return { face: hit.face, id: hit.id, cell: hit.cell, expected: E.ROCK };
    });
    assert(pick.face >= 0);
    assert.equal(pick.id, pick.expected, 'picking skipped newly occupied cells before presentation');
    console.log('ok: snapshot without stepping, a parked page submits nothing; picking reads the state, not the presentation\'s bricks');
    await assert.rejects(manual.evaluate(() => window.__app.test.step(-1)), /steps must/);
    await manual.evaluate(`(${sandBall})()`);
    await manual.evaluate(() => window.__app.test.resume());
    await manual.waitForFunction((step) => window.__app.sim.frame > step, before.step, { polling: 100 });
    await render(manual); // checkpoint must park even when the caller was running
    const stopped = await manual.evaluate(() => window.__app.sim.frame);
    await manual.waitForTimeout(200);
    assert.equal(await manual.evaluate(() => window.__app.sim.frame), stopped);
    console.log('ok: manual boot, live UI rAF, explicit steps, snapshot without stepping, parked idle, resume');
    await manual.close();
  }

  if (STAGES.includes('paused')) {
    for (const [mode, suffix] of [['ui', ''], ['visual', '&paused=1']]) {
      const page = await newTestPage(browser, { mode, viewport: VIEWPORT });
      await prepare(page);
      await page.goto(url + suffix);
      await ready(page);
      assert.equal(await page.evaluate(() => window.__app.settings.paused), true);
      await page.evaluate(() => { window.__app.post.settings.taa = false; });
      await render(page);
      assert.equal(await page.evaluate(() => window.__app.test.parked), true, 'snapshot checkpoint must stay parked');
      assert.equal(await page.evaluate(() => window.__app.sim.frame), 0);
      console.log(`ok: ${mode}${suffix} starts paused and renders without physics`);
      await page.close();
    }
  }

  if (STAGES.includes('detail')) {
    // The realistic view: a detail switch's changed base variant counts as
    // pending until it is built, and the snapshot waits for it.
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 160, height: 100 } });
    await prepare(page);
    await page.goto(`${base}?size=64&preset=empty`);
    await ready(page);
    await page.evaluate(() => { window.__app.post.settings.taa = false; return window.__app.test.ready(); });
    const feature = await page.evaluate(async () => {
      const { DETAIL, settingKey, SOFTWARE_UNDRAWABLE } = await import('/src/gfx/detail.js');
      const a = window.__app;
      // a cheap switch this device can draw (low cost: in the gate's base variant)
      const f = DETAIL.find((x) => x.cost === 'low' && !SOFTWARE_UNDRAWABLE.includes(x.define));
      const key = settingKey(f);
      a.settings[key] = !a.settings[key];
      a.applyDetail();
      return { define: f.define, on: a.settings[key], pending: a.detailGate.pending };
    });
    assert(feature.pending > 0, 'delayed base-detail changes must count as pending');
    await render(page);
    assert.equal(await page.evaluate((d) => window.__app.view.detailShown.split(',').includes(d), feature.define), feature.on);
    console.log(`ok: the snapshot waits for a changed base-detail variant (${feature.define} ${feature.on ? 'on' : 'off'})`);
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
}

// Failure, signal, and lifetime cleanup must close their own Chromium processes.
if (STAGES.includes('cleanup')) {
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
    // (the browser's helper processes may outlive its main one by a moment)
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
    for (let t = 0; t < 30 && pids.some(alive); t++) await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Chromium PID ${pid} survived ${failure}`);
    console.log(`ok: browser cleanup after ${failure}`);
  }
}
