// UI-only fixtures. Economy here is seeded for presentation checks, not used
// as evidence of physical production (industry-{gpu,thermal,integration}-check).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const base = arg('url', `http://127.0.0.1:${arg('port', '19543')}`);
const out = arg('out', '/tmp/factory-ui-review');
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/?map=quarry&mode=factory&view=plain`);
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  // Graphics preparation is separate from physics readiness. A parked manual
  // boot can otherwise capture the decks before the machine models are visible.
  await page.waitForFunction(() => window.__app.scene.getObjectByName('Industry')?.visible);
  await page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    const w = p => new a.THREE.Vector3(...p).multiplyScalar(a.scale).add(a.volume.position);
    a.camera.position.copy(w([73, 38, 82]));
    a.controls.target.copy(w([50, 10, 53]));
    a.controls.update();
  });
  const refresh = () => page.evaluate(() => window.__app.industry.update(0, false));
  const unobscured = locator => locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return [[r.left + 3, r.top + 3], [r.right - 3, r.top + 3],
      [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
  });
  const capture = async name => {
    await refresh(); await render(page);
    await page.screenshot({ path: `${out}/${name}.png` });
    const bounds = await page.locator('.industry').boundingBox();
    const viewport = page.viewportSize();
    assert(bounds && bounds.x >= -1 && bounds.y >= -1
      && bounds.x + bounds.width <= viewport.width + 1
      && bounds.y + bounds.height <= viewport.height + 1, `${name}: Industry panel must fit viewport`);
  };
  await capture('closed');
  await page.keyboard.press('b'); await refresh();
  assert.equal(await page.evaluate(() => window.__app.industry.building), true);
  const machine = type => page.locator(`[data-machine="${type}"]`);
  assert.equal(await page.locator('[data-machine]').count(), 8);
  await machine('belt').focus();
  const paused = await page.evaluate(() => window.__app.settings.paused);
  await page.keyboard.press('Space'); await refresh();
  assert.equal(await page.evaluate(() => window.__app.settings.paused), paused, 'Space activates a UI button without toggling simulation');
  assert.equal(await page.evaluate(() => window.__app.industry.state.selected), 'belt');
  const rotation = await page.evaluate(() => window.__app.industry.state.rotation);
  await page.keyboard.press('r'); await refresh();
  assert.equal(await page.evaluate(() => window.__app.industry.state.rotation), (rotation + 1) % 4);
  await page.evaluate(() => {
    const a = window.__app;
    Object.assign(a.hover, { valid: true, face: 2, id: 1 });
    a.hover.cell.set(48, 7, 48); // Deliberately overlap the starter belt.
    a.industry.update(0, false);
  });
  assert.match(await page.locator('.industry').innerText(), /occupies|occupied/i);
  await capture('desktop');

  // Unlock every machine with a consistent saved-economy fixture.
  await page.evaluate(() => {
    const a = window.__app, s = a.industry.toJSON(), p = s.progression;
    p.credits += 96; p.earned += 96; p.delivered.nuggets += 96;
    a.industry.fromJSON(s);
    a.hover.valid = false;
    a.industry.update(0, false);
  });
  await page.keyboard.press('b'); await refresh();
  await machine('heater').click(); await refresh();
  assert.equal(await page.evaluate(() => window.__app.industry.state.selected), 'heater');
  await page.setViewportSize({ width: 740, height: 740 });
  await capture('compact');
  assert(await unobscured(page.locator('.industry-toggle')), 'compact Close must not sit beneath the material selector');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('phone');
  await page.getByRole('button', { name: 'Choose machine', exact: true }).click();
  assert(await unobscured(machine('heater')), 'phone chooser must reveal the selected machine');
  await page.keyboard.press('Space'); await refresh();
  assert(await unobscured(machine('heater')), 'keyboard selection must keep its focused button visible');

  await page.setViewportSize({ width: 1280, height: 800 });
  await machine('separator').click(); await refresh();
  await page.getByRole('combobox', { name: 'Separator output material' }).focus();
  await page.keyboard.press('b'); await refresh();
  assert.equal(await page.evaluate(() => window.__app.industry.building), true, 'native filter typeahead must not close construction');
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(async () => {
    const a = window.__app;
    await a.setMode('sandbox'); a.industry.update(0, false);
  });
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => window.__app.industry.building), false);
  await page.keyboard.press('Shift+b'); await refresh();
  await machine('pump').click(); await refresh();
  const power = page.locator('.industry').getByRole('checkbox');
  assert(await power.isVisible());
  await power.focus(); await page.keyboard.press('Space'); await refresh();
  assert(await power.isChecked());
  assert.equal(await page.evaluate(() => window.__app.settings.paused), paused);
  await capture('sandbox');

  await page.evaluate(async () => {
    const a = window.__app;
    await a.setMode('factory');
    a.test.resume();
    await a.pov.enter({ at: new a.THREE.Vector3(48, 8, 84), swoop: 0, hint: false });
  });
  await page.waitForFunction(() => window.__app.pov.mode === 'on');
  await page.keyboard.press('b');
  await page.waitForFunction(() => window.__app.industry.building);
  await page.evaluate(() => window.__app.test.park());
  await capture('pov');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__app.industry.building), false);
  assert.deepEqual(errors, []);
  console.log(`Industry UI: keyboard, states, viewport bounds and six captures passed → ${out}`);
} finally {
  await browser.close();
}
