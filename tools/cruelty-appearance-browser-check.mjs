// One bounded UI-mode slot: real original-art upload/render and mode exit.
// node tools/cruelty-appearance-browser-check.mjs [--url https://tpt3d.codyh.xyz]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { preview } from 'vite';

const at = process.argv.indexOf('--url');
// Use built assets: dev dependency optimization must not consume a GPU slot.
const vite = at < 0 ? await preview({ preview: { host: '127.0.0.1', port: 54973, strictPort: true }, logLevel: 'warn' }) : null;
const origin = vite ? 'http://127.0.0.1:54973' : process.argv[at + 1];
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 640, height: 400 } });
  if (process.argv.includes('--diagnostic')) await page.addInitScript(() => {
    const pending = new Set();
    for (const method of ['createComputePipelineAsync', 'createRenderPipelineAsync']) {
      const original = GPUDevice.prototype[method];
      GPUDevice.prototype[method] = function (descriptor) {
        const name = descriptor.label ?? method;
        pending.add(name);
        return original.call(this, descriptor).finally(() => pending.delete(name));
      };
    }
    setInterval(() => console.debug('Appearance boot:', JSON.stringify({
      pending: [...pending],
      marks: performance.getEntriesByType('mark').map(m => m.name),
      screen: document.body?.innerText.slice(-500),
    })), 3000);
  });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', m => {
    if (m.text().startsWith('Appearance boot:')) console.log(m.text());
    if (m.type() === 'error') { errors.push(m.text()); console.error(m.text()); }
  });
  page.on('requestfailed', r => console.error('Request failed:', r.url(), r.failure()?.errorText));
  page.on('response', r => { if (r.status() >= 400) console.error('HTTP:', r.status(), r.url()); });
  await page.goto(`${origin}/?map=paradise&mode=crueltySquad&view=realistic`, { waitUntil: 'commit' });
  console.log('Appearance check: page committed');
  await Promise.race([
    ready(page),
    page.waitForFunction(() => document.getElementById('error')?.textContent.trim()).then(async () => {
      throw new Error(`Game startup error: ${await page.locator('#error').textContent()}`);
    }),
  ]);
  console.log('Appearance check: app exposed');
  await page.waitForFunction(() => __app.pov.mission.active);
  console.log('Appearance check: mission active');
  await render(page);
  const state = await page.evaluate(() => ({
    mode: __app.current().mode, cruelty: __app.post.settings.cruelty,
    words: __app.win.scene.appearanceWords?.length,
    planes: __app.win.far.appearance.planes, view: __app.settings.view,
    sim: __app.sim.id, parked: __app.test.parked,
  }));
  assert.equal(state.mode, 'crueltySquad');
  assert.equal(state.cruelty, true);
  assert.equal(state.view, 0);
  assert.equal(state.words, undefined, 'disabled original-art path stays unloaded');
  assert.equal(state.planes, 0, 'no unused appearance allocation');
  assert(state.parked);
  await page.screenshot({ path: '/tmp/cruelty-source-paradise.png' });
  // Reproduce the reported refresh hang in the same browser, not just a
  // one-shot numerical fixture. The original mission URL must boot again.
  await page.reload({ waitUntil: 'commit' });
  await ready(page);
  await page.waitForFunction(() => __app.pov.mission?.state?.phase === 'active');
  await render(page);
  console.log('Appearance check: refreshed mission active');
  const after = await page.evaluate(async () => {
    const beforeSim = __app.sim.id;
    const saved = { exposure: __app.post.settings.exposure, bloom: __app.post.settings.bloom };
    await __app.setMode('sandbox');
    await __app.test.renderOnce();
    return { mode: __app.current().mode, cruelty: __app.post.settings.cruelty, sim: __app.sim.id, beforeSim,
      saved, after: { exposure: __app.post.settings.exposure, bloom: __app.post.settings.bloom } };
  });
  assert.equal(after.mode, 'sandbox'); assert.equal(after.cruelty, false);
  assert.equal(after.sim, after.beforeSim); assert.deepEqual(after.saved, after.after);
  assert.deepEqual(errors, []);
  console.log('PASS cold mission boot, fallback render, refresh and sandbox exit; screenshot /tmp/cruelty-source-paradise.png', state);
} finally {
  await browser?.close();
  if (vite) await new Promise(resolve => vite.httpServer.close(resolve));
}
