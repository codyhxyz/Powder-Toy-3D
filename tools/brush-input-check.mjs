// Right-button erase through real pointer input, including a click between
// frames, undo, release, one-click tools and the remaining camera gestures.
// node tools/brush-input-check.mjs [--port 54923] [--url https://tpt3d.codyh.xyz]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { E, TOOLS, PROP_TOOL } from '../src/elements.js';

const opt = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const url = opt('url', `http://localhost:${opt('port', '54923')}`);
const erase = TOOLS.find(t => t.key === 'ERASE').id;
const SIGN_TOOL = TOOLS.find(t => t.key === 'SIGN').id;
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${url}/?size=64&preset=empty`);
  await ready(page);
  await page.evaluate(async ({ wall, sand }) => {
    const a = window.__app, V = a.THREE.Vector3;
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
    window.brushPaints = [];
    const paint = a.sim.paint.bind(a.sim);
    a.sim.paint = stroke => {
      window.brushPaints.push({ tool: stroke.tool, center: stroke.center.toArray() });
      return paint(stroke);
    };
    a.test.resume();
  }, { wall: E.WALL, sand: E.SAND });
  await page.mouse.move(450, 300);
  await page.waitForFunction(wall => __app.hover.valid && __app.hover.id === wall, E.WALL);
  const state = () => page.evaluate(() => ({
    paints: window.brushPaints.slice(), history: __app.sim.history.length,
    tool: __app.settings.tool, camera: __app.camera.position.toArray(), target: __app.controls.target.toArray(),
  }));
  const park = () => page.evaluate(() => __app.test.park());
  const resume = () => page.evaluate(() => __app.test.resume());
  const painted = n => page.waitForFunction(n => window.brushPaints.length > n, n);

  const before = await state();
  await page.mouse.down({ button: 'right' });
  await painted(0);
  await page.mouse.move(490, 300, { steps: 4 });
  const n = (await state()).paints.length;
  await painted(n);
  await page.mouse.up({ button: 'right' });
  await park();
  const after = await state();
  assert(after.paints.every(p => p.tool === erase), 'right-drag uses the eraser');
  assert(after.paints.some(p => p.center[0] > after.paints[0].center[0] + 1), 'the eraser follows the drag');
  assert(Math.abs(after.paints[0].center[1] - 19.5) < 0.01, 'erase is inside the hit cell, not above the face');
  assert.equal(after.tool, E.SAND, 'selected element is unchanged');
  assert.equal(after.history, before.history + 1, 'one undo snapshot for the stroke');
  assert.deepEqual(after.camera, before.camera, 'right-drag no longer orbits');
  const cell = after.paints[0].center.map(Math.floor);
  const idAt = () => page.evaluate(async cell => Math.round((await __app.sim.readCell(...cell))[0][0]), cell);
  assert.equal(await idAt(), E.EMPTY, 'the real paint pass removed the wall');
  await page.evaluate(() => __app.undo());
  assert.equal(await idAt(), E.WALL, 'undo restores the erased cells');

  // A short click entirely between frames still paints exactly once. Releasing
  // another button must not interrupt the right-button stroke.
  for (const tool of [E.SAND, SIGN_TOOL, PROP_TOOL]) {
    await page.evaluate(tool => __app.selectTool(tool), tool);
    await page.mouse.move(450, 300);
    await resume();
    await page.waitForFunction(wall => __app.hover.valid && __app.hover.id === wall, E.WALL);
    await park();
    const start = await state();
    await page.mouse.down({ button: 'right' });
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await resume();
    await painted(start.paints.length);
    const held = (await state()).paints.length;
    await painted(held);
    await page.mouse.up({ button: 'right' });
    await park();
    assert.equal((await state()).history, start.history + 1, 'other buttons do not start a second stroke');
    await page.evaluate(() => __app.undo());
    const quick = await state();
    await page.mouse.click(450, 300, { button: 'right' });
    await resume();
    await painted(quick.paints.length);
    await park();
    const end = await state();
    assert.equal(end.paints.length, quick.paints.length + 1, 'quick click paints exactly once');
    assert.equal(end.paints.at(-1).tool, erase, 'right-click bypasses signs and Property');
    assert.equal(end.tool, tool);
    await page.evaluate(() => __app.undo());
  }

  // Left still paints the selected element; camera-only gestures never paint.
  await page.evaluate(sand => __app.selectTool(sand), E.SAND);
  const left = await state();
  await page.mouse.click(450, 300);
  await resume();
  await painted(left.paints.length);
  await park();
  assert.equal((await state()).paints.at(-1).tool, E.SAND);
  for (const [modifier, button] of [['Alt', 'left'], ['Shift', 'right']]) {
    const start = await state();
    await page.keyboard.down(modifier);
    await page.mouse.move(450, 300);
    await page.mouse.down({ button });
    await page.mouse.move(480, 320, { steps: 4 });
    await page.mouse.up({ button });
    await page.keyboard.up(modifier);
    const end = await state();
    assert.equal(end.history, start.history, `${modifier}+${button} does not paint`);
    assert.notDeepEqual(end.camera, start.camera, `${modifier}+${button} still moves the camera`);
    if (modifier === 'Alt') assert.deepEqual(end.target, start.target, 'Alt orbits the same target');
    else assert.notDeepEqual(end.target, start.target, 'Shift+right pans the target');
  }
  const released = await state();
  await resume();
  await page.waitForFunction(() => __app.loop.asleep);
  await park();
  assert.equal((await state()).paints.length, released.paints.length, 'release stops painting');
  assert.deepEqual(errors, []);
  console.log('ok: right-drag/click erase, undo, button ownership, tool selection, left paint and camera modifiers');
} finally {
  await browser.close();
}
