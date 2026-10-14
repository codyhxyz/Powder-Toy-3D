// WebGPU regression: tool-dependent liquid targeting, including mixed pick batches.
// Run: node tools/liquid-tool-pick-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port: 18579, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error' && !(m.location().url.startsWith('http://127.0.0.1:8787/') && m.text().includes('ERR_CONNECTION_REFUSED'))) errors.push(m.text());
  });
  await page.goto('http://127.0.0.1:18579/?preset=empty&size=64');
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    const { GEAR } = await import('/src/pov/tools/catalog.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const paint = (y, tool) => a.sim.paint({
      center: new a.THREE.Vector3(32.5, y, 32.5), radius: 1.5, shape: 1, tool, rate: 100, replace: true,
    });
    const eye = [32.5, 15, 32.5], dir = [0, -1, 0];
    for (const warp of [null, { k: 0.002, anchor: [32.5, 32.5], dir: [0, 1] }]) {
      for (const liquid of [E.WATER, E.OIL, E.LAVA]) {
        paint(5, E.SAND); paint(9, liquid);
        // Opposing policies in the same dispatch must not leak into one another.
        const hits = await Promise.all(GEAR.map(g => a.vol.pick(eye, dir, warp, !g.pickLiquids)));
        hits.forEach((hit, i) => {
          const g = GEAR[i];
          check(hit.valid && hit.id === (g.pickLiquids ? liquid : E.SAND), `${g.key}: liquid ${liquid}, warp ${warp?.k}`);
          check(hit.face === 2, `${g.key}: top face`);
        });
        const submerged = await Promise.all([true, false].map(skip => a.vol.pick([32.5, 9, 32.5], dir, warp, skip)));
        check(submerged[0].id === E.SAND && submerged[1].id === liquid, 'submerged eyes');
        check((await a.vol.pick(eye, dir, warp)).id === liquid, 'ordinary pick sees liquids');
      }
      paint(5, E.ROCK);
      check((await a.vol.pick(eye, dir, warp, true)).id === E.ROCK, 'solid beneath liquid');
      paint(5, E.EMPTY);
      const floor = await a.vol.pick(eye, dir, warp, true);
      check(floor.valid && floor.id === -1 && floor.face === 2, 'floor beneath liquid');
      check(!(await a.vol.pick(eye, [0, 1, 0], warp, true)).valid, 'empty ray misses');
    }
    paint(5, E.SAND); paint(9, E.WATER);
    a.settings.paused = true;
    a.pov.test.assumeLocked = true;
    await a.pov.enter({ at: new a.THREE.Vector3(32.5, 6, 32.5) });
    a.pov.setLook(0, -1.5);
    a.test.resume();
  });
  await page.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  for (const key of ['SHOVEL', 'BUCKET', 'PICKAXE', 'FLASK', 'SHOVEL']) {
    const expected = await page.evaluate(async key => {
      const a = window.__app, { E } = await import('/src/elements.js');
      const { gearByKey } = await import('/src/pov/tools/catalog.js');
      a.pov.toolbelt.select(key);
      return gearByKey(key).pickLiquids ? E.WATER : E.SAND;
    }, key);
    await page.waitForFunction(id => {
      const a = window.__app;
      return a.hover.valid && a.hover.id === id && a.pov.ctx.aim.valid && a.pov.ctx.aim.id === id;
    }, expected, { timeout: 15000, polling: 50 });
  }
  assert(await page.evaluate(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    a.test.park();
    const hit = await a.pickRay(new a.THREE.Vector3(32.5, 15, 32.5), new a.THREE.Vector3(0, -1, 0));
    return hit.valid && hit.id === E.WATER;
  }), 'one-off pick retains liquid targeting');
  assert.deepEqual(errors, []);
  console.log('PASS: all tools, mixed batches, water/oil/lava, flat/curved rays, submerged eyes, floor/misses, live tool switches and one-off picks');
} finally {
  await browser?.close();
  await server.close();
}
