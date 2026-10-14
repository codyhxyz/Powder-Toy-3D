// Real tool -> event -> camera check, usable against a dev server or the deployed build.
// node tools/tool-camera-browser-check.mjs [http://127.0.0.1:54937]
import assert from 'node:assert/strict';
import { E } from '../src/elements.js';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:54937'}/?preset=empty`);
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app;
    await a.pov.enter({ at: new a.THREE.Vector3(32, 0, 64) });
    a.pov.test.assumeLocked = true;
    for (let i = 0; i < 15; i++) a.pov.update(0.1);
    a.pov.setLook(-Math.PI / 2, 0);
    window.__contacts = [];
    for (const name of ['impact', 'tool:action', 'punch']) {
      a.pov.events.on(name, e => window.__contacts.push({ name, ...e }));
    }
  });
  assert.equal(await page.evaluate(() => window.__app.pov.mode), 'on');
  for (const [key, id] of [['PICKAXE', E.ROCK], ['AXE', E.WOOD], ['SHOVEL', E.SAND]]) {
    await page.evaluate(({ key, id }) => {
      const a = window.__app, p = a.pov, V = a.THREE.Vector3;
      a.sim.paint({ center: new V(36, 4, 64), radius: 2, shape: 1, tool: id, rate: 1, replace: true });
      p.toolbelt.select(key);
      p.feel.reset();
      p.feel.update({ dt: 0, live: true, eye: new V(32, 4.5, 64.5) });
      window.__contacts.length = 0;
      const ctx = { ...p.ctx, sim: a.sim, dt: 1 / 60, toolRate: 1,
        eye: new V(32, 4.5, 64.5), dir: new V(1, 0, 0),
        primary: true, primaryPressed: true, secondary: false, secondaryPressed: false,
        aim: { valid: true, cell: new V(35, 4, 64), face: 0, id, dist: 3 },
      };
      p.toolbelt.tool(key).update(ctx);
    }, { key, id });
    await page.waitForFunction(key => window.__contacts.some(e => key === 'SHOVEL'
      ? e.tool === 'shovel' && e.action === 'dig' && e.amount > 0
      : e.name === 'impact' && e.source === key.toLowerCase()), key, { polling: 50 });
    const result = await page.evaluate(() => {
      const p = window.__app.pov;
      const look = { ...p.camera.look };
      const frames = Array.from({ length: 30 }, () => ({ ...p.feel.update({ dt: 1 / 120, live: true }) }));
      const settled = { ...p.feel.update({ dt: 0.1, live: true }) };
      return { frames, settled, trauma: p.feel.trauma, look, after: { ...p.camera.look },
        punches: window.__contacts.filter(e => e.name === 'punch').length };
    });
    const peak = Math.max(...result.frames.map(f => -f.pitch));
    assert.ok(peak > 0 && peak <= 0.6 * Math.PI / 180, `${key}: small contact nod`);
    assert.ok(result.frames.every(f => f.roll === 0), `${key}: no roll`);
    assert.equal(result.trauma, 0, `${key}: no impact jitter`);
    assert.equal(result.punches, 0, `${key}: no stacked view punch`);
    assert.ok(Object.values(result.settled).every(v => v === 0), `${key}: returns to rest`);
    assert.deepEqual(result.after, result.look, `${key}: aim is unchanged`);
    console.log(`PASS ${key}: real contact, peak ${(peak * 180 / Math.PI).toFixed(2)}°, no jitter or aim drift`);
    await page.waitForFunction(() => !window.__app.pov.toolbelt.tool('SHOVEL').load.busy, null, { polling: 50 });
  }
  await render(page);
  await page.screenshot({ path: '/tmp/tpt-tool-camera-check.png' });
  assert.deepEqual(errors, [], 'no browser errors');
} finally {
  await browser.close();
}
