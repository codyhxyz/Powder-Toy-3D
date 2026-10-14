// Real pointer/OrbitControls + GPU erase/undo integration.
// node tools/brush-click-check.mjs [--url http://localhost:54923]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { E } from '../src/elements.js';

const at = process.argv.indexOf('--url');
const url = at < 0 ? 'http://localhost:54923' : process.argv[at + 1];
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${url}/?size=64&preset=empty`);
  await ready(page);
  await page.evaluate(async ({ wall, sand }) => {
    const a = __app, V = a.THREE.Vector3;
    a.test.park();
    await a.test.ready();
    a.sim.clear();
    a.sim.paint({ center: new V(32, 16, 32), radius: 4, grow: [12, 0, 12], shape: 1, tool: wall, rate: 1, replace: true });
    a.settings.radius = 3;
    a.selectTool(sand);
    a.controls.enableDamping = false;
    a.controls.target.copy(a.volume.localToWorld(new V(32, 20, 32)));
    a.camera.position.copy(a.volume.localToWorld(new V(32, 90, 33)));
    a.controls.update();
    a.test.resume();
  }, { wall: E.WALL, sand: E.SAND });
  await page.mouse.move(450, 300);
  await page.waitForFunction(wall => __app.hover.valid && __app.hover.id === wall, E.WALL);
  const state = () => page.evaluate(() => ({
    undo: __app.sim.history.length, camera: __app.camera.position.toArray(), tool: __app.settings.tool,
  }));
  const cell = await page.evaluate(() => __app.hover.cell.toArray());
  const id = () => page.evaluate(async p => Math.round((await __app.sim.readCell(...p))[0][0]), cell);
  const before = await state();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(452, 301);
  const held = await state();
  assert.equal(held.undo, before.undo, 'no erase on mouse-down');
  assert.equal(await id(), E.WALL);
  assert.deepEqual(held.camera, before.camera, 'small wobble does not rotate');
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(n => __app.sim.history.length === n + 1, before.undo);
  await page.evaluate(() => __app.test.park());
  assert.equal(await id(), E.EMPTY, 'release erases at the clicked surface');
  assert.equal((await state()).tool, E.SAND, 'selection remains unchanged');
  await page.evaluate(() => __app.undo());
  assert.equal(await id(), E.WALL, 'undo restores the erased cells');

  // A drag back to its start must not become a click on release.
  await page.mouse.move(450, 300);
  const start = await state();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(490, 320, { steps: 4 });
  assert.notDeepEqual((await state()).camera, start.camera, 'right-drag rotates the real OrbitControls camera');
  await page.mouse.move(450, 300, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  assert.equal((await state()).undo, start.undo, 'camera drag creates no erase snapshot');
  assert.equal(await id(), E.WALL, 'dragging never erases');
  assert.deepEqual(errors, []);
  console.log('ok: real right-click erases only on release, undo restores it, right-drag only orbits');
} finally {
  await browser.close();
}
