// Real-shell smoke: normal palette + water click, pad spawn, E seat, W/S/A/D,
// chase camera and exit. CPU physics coverage is boats-node-check.mjs.
// Requires an owned dev server: node tools/boats-check.mjs --port 5497
// Intentionally not run by the implementation worker (parent owns GPU budget).
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const args = process.argv.slice(2), port = args[args.indexOf('--port') + 1] || '5497';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await ready(page);
  await page.waitForFunction(() => window.__app?.spawners && window.__app?.pov);
  await page.evaluate(async () => {
    const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js');
    const [A, B] = a.sim.blankState(), e = ELEMENTS[E.WATER], g = a.sim.g;
    for (let y = 0; y < 20; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = a.sim.cellTexel(x, y, z) * 4;
      A[i] = E.WATER; A[i + 1] = e.temp; A[i + 2] = e.life;
    }
    a.sim.load(A, B); a.requestRender();
  });
  await page.keyboard.press('t');
  await page.getByRole('button', { name: 'Entities', exact: true }).click();
  await page.getByRole('button', { name: 'Boat pad', exact: true }).click();
  const click = await page.evaluate(() => {
    const a = window.__app;
    const p = new a.THREE.Vector3(64, 20, 64).multiplyScalar(a.scale).add(a.volume.position).project(a.camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  });
  await page.mouse.move(click.x, click.y);
  await page.waitForFunction(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    return a.hover.valid && a.hover.id === E.WATER && a.hover.face === 2;
  });
  await page.mouse.click(click.x, click.y);
  assert.equal(await page.evaluate(() => window.__app.spawners.of('boat').length), 1);
  assert.equal(await page.evaluate(() => window.__app.spawners.of('boat')[0].world.y), 20);
  await page.keyboard.press('v');
  await page.waitForFunction(() => window.__app.pov.mode === 'on');
  await page.evaluate(() => { window.__app.pov.test.assumeLocked = true; });
  await page.waitForFunction(() => window.__app.pov.vehicles.list.some((v) => v.kind === 'boat' && v.impl.state.motorWet));
  await page.evaluate(() => {
    const a = window.__app.pov, v = a.vehicles.list.find((v) => v.kind === 'boat'), p = v.impl.body.translation();
    a.player.spawn(a.player.pos.clone().set(p.x / 0.3 + 5, p.y / 0.3, p.z / 0.3));
  });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__app.pov.vehicles.seated?.kind === 'boat');
  assert.equal(await page.locator('.veh-panel b').textContent(), 'Boat');
  assert.equal(await page.locator('.veh-panel u').isVisible(), false, 'boat has no boost meter');
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__app.pov.vehicles.seated.impl.speed > 2);
  await page.keyboard.down('a');
  await page.waitForFunction(() => window.__app.pov.vehicles.seated.impl.body.angvel().y > 0.2);
  await page.keyboard.up('a'); await page.keyboard.up('w');
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.__app.pov.vehicles.seated.impl.speed < -0.5);
  await page.keyboard.up('s');
  const camera = await page.evaluate(() => window.__app.camera.position.toArray());
  assert.ok(camera.every(Number.isFinite));
  await page.keyboard.press('e');
  await page.waitForFunction(() => !window.__app.pov.vehicles.seated);
  await page.evaluate(() => window.__app.test.park());
  assert.deepEqual(errors, []);
  console.log('ok Boat pad placed on water through UI; boat spawns, boards, drives/steers/reverses, exits; no boost HUD or browser errors');
} finally { await browser.close(); }
