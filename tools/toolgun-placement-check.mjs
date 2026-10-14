// Built app (or live site), one <=10s GPU slot:
// node tools/toolgun-placement-check.mjs [http://127.0.0.1:54937/]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { E } from '../src/elements.js';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:54937/');
url.search = '?size=64&preset=empty&view=plain';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 480, height: 300 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/POV toolbelt update failed|GPU (validation|internal)|GraphicsFailure/.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url.href);
  await ready(page);
  const before = await page.evaluate(async sand => {
    const a = __app;
    await a.test.ready();
    await a.pov.enter({ swoop: 0, hint: false, at: new a.THREE.Vector3(32, 0, 32) });
    a.pov.test.assumeLocked = true;
    a.pov.update(1 / 30);
    a.pov.toolbelt.select('TOOLGUN');
    a.pov.toolbelt.confirmSelection();
    a.pov.setLook(0, 0);
    a.selectTool(sand);
    a.settings.radius = 2;
    a.settings.rate = 1;
    const start = { paints: a.sim.paints, frame: a.view.frame, history: a.sim.history.length };
    a.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    a.test.resume();
    return start;
  }, E.SAND);
  await page.waitForFunction(start => __app.sim.paints >= start.paints + 3 && __app.view.frame > start.frame,
    before, { timeout: 1800 });
  const after = await page.evaluate(async sand => {
    const a = __app;
    a.test.park();
    dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    const [state] = await a.sim.readState();
    let cells = 0;
    for (let i = 0; i < state.length; i += 4) if (Math.round(state[i]) === sand) cells++;
    return { cells, paints: a.sim.paints, frame: a.view.frame, history: a.sim.history.length };
  }, E.SAND);
  assert(after.cells > 0, 'holding the tool gun must create sand, not just fire feedback');
  assert.equal(after.history, before.history + 1, 'one undo snapshot per held stroke');
  await page.evaluate(() => __app.test.resume());
  await page.waitForFunction(frame => __app.view.frame >= frame + 2, after.frame, { timeout: 1000 });
  const released = await page.evaluate(() => {
    __app.test.park();
    return __app.sim.paints;
  });
  assert.equal(released, after.paints, 'release stops painting');
  assert.deepEqual(errors, [], 'no frame-loop or GPU errors');
  console.log('PASS: held tool gun creates sand, keeps rendering, takes one snapshot, and stops on release', after);
} finally {
  await browser.close();
}
