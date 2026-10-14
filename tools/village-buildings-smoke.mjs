// One <=10s GPU slot: real application boot and door interaction.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:54983';
const browser = await launchBrowser({ lifetimeMs: 10000 });
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${url}/?map=willowCove&mode=animalCrossing&paused=1`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => window.__app?.pov?.village?.enabled, null, { timeout: 5000 });
  const result = await page.evaluate(() => {
    const a = __app, v = a.pov.village;
    a.test.park();
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 96, 24, a.win.P.size[2] / 2 + 42).sub(a.sim.origin));
    a.pov.setLook(Math.PI, -0.2); v.update(0, true, Math.PI);
    const initial = v.doors.find(d => d.id === 'home-0').progress;
    const action = v.act({ type: 'interact' });
    v.update(0.225, true, Math.PI);
    const halfway = v.doors.find(d => d.id === 'home-0').progress;
    v.update(0.225, true, Math.PI);
    return { count: v.buildings.length, doors: v.doors.length, initial, halfway,
      opened: v.doors.find(d => d.id === 'home-0').progress, error: action.error };
  });
  assert.equal(result.count, 16); assert.equal(result.doors, 17);
  assert.equal(result.error, undefined);
  assert.equal(result.initial, 0); assert.equal(result.halfway, 0.5); assert.equal(result.opened, 1);
  await render(page);
  await page.screenshot({ path: '/tmp/crossing-home-door.png' });
  assert.deepEqual(errors, []);
  console.log('PASS real Crossing boot, 16 buildings, 17 doors and animated home-door interaction');
} finally {
  await browser.close();
}
