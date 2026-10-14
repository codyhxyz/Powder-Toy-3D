// Real-shell smoke: normal palette + water click, one-shot spawn, E seat, W/S/A/D,
// chase camera and exit. CPU physics coverage is boats-node-check.mjs.
// node tools/boats-check.mjs --port 5497 (owned dev server), or --url https://tpt3d.codyh.xyz
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { E, ELEMENTS } from '../src/elements.js';
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const url = new URL(opt('url', `http://localhost:${opt('port', '5497')}/`));
url.searchParams.set('size', '128'); url.searchParams.set('preset', 'empty');
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const source = m.location().url;
    // Local smoke does not start the optional multiplayer/AI relay.
    if (/^http:\/\/(?:localhost|127\.0\.0\.1):8787\//.test(source) && /ERR_CONNECTION_REFUSED/.test(m.text())) return;
    errors.push(`${m.text()} (${source})`);
  });
  await page.goto(url.href);
  await ready(page);
  await page.waitForFunction(() => window.__app?.spawners && window.__app?.pov);
  await page.evaluate(({ id, temp, life }) => {
    const a = window.__app;
    const [A, B] = a.sim.blankState(), g = a.sim.g;
    for (let y = 0; y < 20; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = a.sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = temp; A[i + 2] = life;
    }
    a.sim.load(A, B); a.requestRender();
  }, { id: E.WATER, temp: ELEMENTS[E.WATER].temp, life: ELEMENTS[E.WATER].life });
  await page.keyboard.press('t');
  await page.getByRole('button', { name: 'Entities', exact: true }).click();
  await page.getByRole('button', { name: 'Boat', exact: true }).click();
  const click = await page.evaluate(() => {
    const a = window.__app;
    const p = new a.THREE.Vector3(64, 20, 64).multiplyScalar(a.scale).add(a.volume.position).project(a.camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  });
  await page.mouse.move(click.x, click.y);
  await page.waitForFunction((water) => {
    const a = window.__app;
    return a.hover.valid && a.hover.id === water && a.hover.face === 2;
  }, E.WATER);
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
  await page.waitForFunction(() => document.querySelector('.veh-panel b')?.textContent === 'Boat');
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
  if (opt('shot', null)) {
    await page.evaluate(() => {
      const p = window.__app.pov;
      p.setLook(p.vehicles.headingYaw() + 0.6, -0.6);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await render(page);
    await page.screenshot({ path: opt('shot'), fullPage: true });
    await page.evaluate(() => window.__app.test.resume());
  }
  await page.keyboard.press('e');
  await page.waitForFunction(() => !window.__app.pov.vehicles.seated);
  await page.evaluate(() => window.__app.test.park());
  assert.deepEqual(errors, []);
  console.log('ok Boat pad placed on water through UI; boat spawns, boards, drives/steers/reverses, exits; no boost HUD or browser errors');
} finally { await browser.close(); }
