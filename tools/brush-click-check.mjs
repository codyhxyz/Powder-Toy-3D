// Real pointer + GPU erase/undo integration, and the god camera (src/camera.js): right-drag looks
// around in place, Q/E fly down/up without turning, W flies where you look.
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
    dir: __app.controls.target.clone().sub(__app.camera.position).normalize().toArray(),
  }));
  const angle = (a, b) => Math.acos(Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0)));
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
  await page.evaluate(() => __app.test.resume());   // the flights below need frames

  // A drag back to its start must not become a click on release.
  await page.mouse.move(450, 300);
  const start = await state();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(490, 320, { steps: 4 });
  const looked = await state();
  assert(Math.hypot(...looked.camera.map((v, i) => v - start.camera[i])) < 1e-6, 'right-drag keeps the eye in place');
  assert(angle(looked.dir, start.dir) > 0.05, 'right-drag turns the view');
  const locked = await page.evaluate(() => document.pointerLockElement === __app.canvas);
  await page.mouse.move(450, 300, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  assert.equal(await page.evaluate(() => document.pointerLockElement), null, 'letting go frees the cursor');
  assert.equal((await state()).undo, start.undo, 'camera drag creates no erase snapshot');
  assert.equal(await id(), E.WALL, 'dragging never erases');

  // Q flies straight down, E up, neither turns; W flies where you look (down here, as the view looks down)
  const hold = async (k) => { await page.keyboard.down(k); await page.waitForTimeout(300); await page.keyboard.up(k); await page.waitForTimeout(50); };
  for (const [k, sign] of [['q', -1], ['e', 1]]) {
    const a = await state();
    await hold(k);
    const b = await state();
    assert(angle(a.dir, b.dir) < 1e-6, `${k.toUpperCase()} doesn't turn the camera`);
    assert(sign * (b.camera[1] - a.camera[1]) > 0.05, `${k.toUpperCase()} flies ${sign < 0 ? 'down' : 'up'}`);
    assert(Math.hypot(b.camera[0] - a.camera[0], b.camera[2] - a.camera[2]) < 1e-6, `${k.toUpperCase()} moves straight`);
  }
  const w0 = await state();
  assert(w0.dir[1] < -0.5, 'the view looks down');
  await hold('w');
  assert((await state()).camera[1] < w0.camera[1] - 0.05, 'W while looking down lowers the camera');
  assert.equal((await state()).undo, start.undo, 'flying paints nothing');
  assert.deepEqual(errors, []);
  console.log(`ok: real right-click erases only on release, undo restores it; right-drag looks in place (pointer lock ${locked ? 'held' : 'refused, plain movement'}); Q/E straight down/up; W flies where you look`);
} finally {
  await browser.close();
}
