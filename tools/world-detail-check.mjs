// node tools/world-detail-check.mjs [port=5493] [output=/tmp/world-detail]
// Fixed-output A/B: cached geometry versus the same scene's coarse fallback.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const port = process.argv[2] ?? '5493', out = process.argv[3] ?? '/tmp/world-detail';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`http://localhost:${port}/?size=world`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.win?.loaded, null, { timeout: 180000 });
  await page.evaluate(() => {
    const a = __app;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.autoRes.scale = 1;
    a.day.fixed = { az: 215, el: 38 };
  });
  await page.waitForFunction(() => {
    const d = __app.win.far.detail;
    return d.failed || (d.entries.size > 0 && !d.pending &&
      d.wanted.every(c => d.entries.has(c.key) || d.blocked.has(c.key)));
  }, null, { timeout: 180000 });
  const cache = await page.evaluate(() => {
    const d = __app.win.far.detail;
    return { entries: d.entries.size, bytes: d.bytes, wanted: d.wanted.length, blocked: d.blocked.size, failed: !!d.failed };
  });
  assert.equal(cache.failed, false);
  assert(cache.entries > 0);
  assert(cache.bytes <= 96 * 1024 * 1024);
  await page.waitForTimeout(2000); // TAA settles before each still
  await page.screenshot({ path: `${out}/detail.png` });
  const edit = await page.evaluate(async () => {
    const a = __app, o = a.sim.origin, g = a.sim.g;
    const { E } = await import('/src/elements.js');
    const world = [o.x + 8, g.ny - 12, o.z + g.nz / 2];
    const d = a.win.far.detail;
    const key = Math.floor(world[0] / 32) + d.nx * Math.floor(world[2] / 32);
    a.sim.paint({ center: new a.THREE.Vector3(8, world[1], g.nz / 2), radius: 3, shape: 1, tool: E.GOLD, rate: 1, replace: true });
    a.worldFocus = [o.x + g.nx / 2 + 21, o.z + g.nz / 2];
    return { key, world, gold: E.GOLD, beforeX: o.x };
  });
  await page.waitForFunction(({ key, gold, beforeX }) => {
    const a = __app, d = a.win.far.detail;
    return a.sim.origin.x > beforeX && !a.win.pending &&
      d.entries.get(key)?.mesh.geometry.attributes.element.array.includes(gold);
  }, edit, { timeout: 120000 });
  const result = await page.evaluate(async () => {
    const a = __app, d = a.win.far.detail, r = a.renderer, T = a.THREE;
    // Park only this page's loop; all following draws are controlled A/B.
    const raf = requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    await new Promise(resolve => raf(resolve));
    const mask = d.mask.slice();
    const on = (v) => {
      d.group.visible = v;
      d.mask.set(v ? mask : new Uint8Array(mask.length));
      d.texture.needsUpdate = true;
    };
    const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1];
    const timings = {};
    for (const [w, h] of [[853, 533], [1280, 800]]) {
      const rt = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, depthBuffer: true });
      const pixel = new Uint16Array(4);
      const draw = () => {
        r.setRenderTarget(rt); r.clear(); r.render(a.scene, a.camera);
        r.readRenderTargetPixels(rt, 0, 0, 1, 1, pixel);
        r.setRenderTarget(null);
      };
      const samples = { coarse: [], detail: [] };
      for (let round = 0; round < 24; round++) for (const v of round % 2 ? [true, false] : [false, true]) {
        on(v); draw();
        const start = performance.now(); draw();
        samples[v ? 'detail' : 'coarse'].push(performance.now() - start);
      }
      timings[`${w}x${h}`] = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, +median(v).toFixed(2)]));
      rt.dispose();
    }
    on(false);
    for (let i = 0; i < 90; i++) a.post.render(a.scene, a.camera);
    return timings;
  });
  await page.screenshot({ path: `${out}/coarse.png` });
  // The cache's stale-job/ownership contract without changing persisted data.
  const ownership = await page.evaluate(() => {
    const d = __app.win.far.detail, c = d.wanted.find(c => d.entries.has(c.key));
    const token = { ...c, epoch: d.epoch, revision: d.revisions[c.key] };
    const validBefore = d.valid(token);
    d.invalidate([c.x, 0, c.z], [32, 128, 32]);
    return { validBefore, validAfter: d.valid(token), mask: d.mask[c.key], mesh: d.entries.has(c.key) };
  });
  assert.deepEqual(ownership, { validBefore: true, validAfter: false, mask: 0, mesh: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cache, timings: result, ownership, editedSlabPreserved: edit.world, screenshots: out }, null, 2));
} finally {
  await browser.close();
}
