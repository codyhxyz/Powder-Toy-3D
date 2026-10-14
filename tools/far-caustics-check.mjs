// Same paused shore, with/without the far-bed fix; no physics or LOD changes.
// node tools/far-caustics-check.mjs [--port PORT]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const out = '/tmp/tpt-far-caustics';
mkdirSync(out, { recursive: true });
const vite = await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if ((m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text()))
        || /GPU (validation|internal)/.test(m.text())) errors.push(m.text());
  });
  await page.goto(vite.url('/?map=island&win=128'));
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app;
    await a.test.ready();
    a.test.park();
    const f = a.win.far;
    f.queue = f.queue.slice(-49);
    while (f.queue.length) { f.sceneChunks(1); await a.gpu.fence(); }
    await f.viewPipe.build();
    const { farFrag, FarViewParams, farViewPipeline } = await import('/src/shaders/far.js');
    const code = farFrag(a.sim.g, f.L).replace(
      'focus = causticGain(p, depth / max(FU.sun.y, FAR_SUN_Y_MIN));', 'focus = 1.0;');
    const before = a.gpu.renderPipeline({
      name: 'far bed without caustics', code,
      layouts: [f.viewFrameLayout, a.sim.L.STATE_RO, a.gpu.L.LIGHTING],
      params: FarViewParams, ...farViewPipeline(), build: 'manual',
    });
    await before.build();
    window.causticPipes = { before, after: f.viewPipe };
    a.autoRes.enabled = false;
    a.settings.upscale = 'native';
    a.post.settings.taa = false;
    a.day.fixed = { az: 215, el: 50 };
    const g = a.sim.g, v = a.volume.position, s = a.scale;
    const scene = ([x, y, z]) => [v.x + (g.nx / 2 + x) * s, v.y + y * s, v.z + (g.nz / 2 + z) * s];
    a.camera.position.set(...scene([-90, 140, 170]));
    a.controls.target.set(...scene([0, 20, -20]));
    a.controls.update();
    document.querySelectorAll('body > :not(canvas):not(script)').forEach(el => { el.style.visibility = 'hidden'; });
    a.renderer.domElement.style.visibility = 'visible';
    // Settle derived lighting before comparing only the far-bed shader.
    for (let i = 0; i < 8; i++) await a.test.renderOnce();
    f.detail.tick = () => {};
  });
  await page.waitForFunction(() => !window.__app.win.far.detail.pending);
  const result = await page.evaluate(async () => {
    const a = window.__app, f = a.win.far;
    const shots = {};
    for (const enabled of [false, true]) for (const variant of ['before', 'after']) {
      a.settings.caustics = enabled;
      f.viewPipe = window.causticPipes[variant];
      a.test.resetView();
      shots[`${enabled}-${variant}`] = await a.test.renderOnce({ capture: true });
    }
    const difference = enabled => {
      const a = shots[`${enabled}-before`].data, b = shots[`${enabled}-after`].data;
      let changed = 0, max = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c])));
        if (d > 2) changed++;
        max = Math.max(max, d);
      }
      return { changed, max };
    };
    return { off: difference(false), on: difference(true), frame: a.sim.frame };
  });
  for (const variant of ['before', 'after']) {
    await page.evaluate(async variant => {
      const a = window.__app;
      a.win.far.viewPipe = window.causticPipes[variant];
      a.test.resetView();
      await a.test.renderOnce();
    }, variant);
    await page.screenshot({ path: `${out}/${variant}.png` });
  }
  console.log(result);
  assert.equal(result.off.changed, 0, 'disabled caustics preserve the existing image');
  assert.ok(result.on.changed > 100, `far seabed must receive visible caustics: ${JSON.stringify(result)}`);
  assert.deepEqual(errors, []);
  console.log('PASS far-bed caustics and disabled-setting parity', result, out);
} finally {
  await browser?.close();
  await vite.close();
}
