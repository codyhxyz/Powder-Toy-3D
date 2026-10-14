// One <=10s manual-mode slot: real E wiring, held-tool independence and release.
// node tools/grapple-browser-check.mjs [--url https://tpt3d.codyh.xyz]
import assert from 'node:assert/strict';
import { E } from '../src/elements.js';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const urlIndex = process.argv.indexOf('--url');
const vite = urlIndex < 0 ? await startVite() : null;
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${vite?.origin ?? process.argv[urlIndex + 1]}/?size=64&preset=empty&view=plain&mode=sandbox`);
  await ready(page);
  await page.evaluate(async id => {
    const a = __app, V = a.THREE.Vector3;
    await a.test.ready();
    await a.pov.enter({ at: new V(12, 0, 32.5), swoop: 0, hint: false });
    a.pov.test.assumeLocked = true;
    a.pov.setLook(-Math.PI / 2, Math.atan2(39.5, 12));
    a.sim.paint({ center: new V(26, 44, 32), radius: 2, shape: 1, tool: id, rate: 1, replace: true });
    a.hover.valid = true; a.hover.cell.set(24, 44, 32); a.hover.face = 1; a.hover.id = id;
    for (let i = 0; i < 3; i++) { a.pov.update(1 / 30); await a.gpu.fence(); }
    window.__grappleHeld = a.pov.toolbelt.selectedKey;
  }, E.ROCK);
  await page.keyboard.press('e');
  const attached = await page.evaluate(async () => {
    const a = __app;
    for (let i = 0; i < 6; i++) { a.pov.update(1 / 30); await a.gpu.fence(); }
    const hook = a.pov.toolbelt.tool('HOOK');
    return { state: hook.state, quick: hook.grappling, reel: hook.rope?.reel, held: a.pov.toolbelt.selectedKey, before: __grappleHeld };
  });
  assert.equal(attached.state, 'anchor');
  assert.equal(attached.quick, true);
  assert.equal(attached.reel, 0);
  assert.equal(attached.held, attached.before, 'E leaves the selected weapon alone');
  await page.evaluate(() => {
    window.__vehicleUse = __app.pov.vehicles.use;
    window.__vehicleUses = 0;
    __app.pov.vehicles.use = () => { __vehicleUses++; return 'flip'; };
  });
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => {
    __app.pov.update(1 / 30);
    __app.pov.vehicles.use = __vehicleUse;
    return __vehicleUses === 1 && __app.pov.player.rope !== null;
  }), true, 'a usable nearby vehicle retains E even while grappling');
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => { __app.pov.update(1 / 30); return __app.pov.player.rope === null; }), true);
  assert.deepEqual(errors, []);
  console.log('PASS real E attach/release, overhead hold, held-tool independence, vehicle-use priority, no page errors');
} finally {
  await browser?.close();
  await vite?.close();
}
