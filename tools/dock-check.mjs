// Run against your own Vite server: node tools/dock-check.mjs http://127.0.0.1:54327
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PALETTE, E, itemByKey } from '../src/elements.js';

const url = process.argv[2] ?? 'http://127.0.0.1:54327';
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?size=64&preset=lab`);
  await page.waitForFunction(() => window.__app);
  await page.evaluate(() => { window.__app.settings.paused = true; });
  const dock = page.locator('.dock');
  const category = (name) => dock.getByRole('button', { name, exact: true });
  const swatches = dock.locator('.material-swatch:visible');
  const search = dock.getByRole('searchbox');

  for (const group of PALETTE) {
    await category(group.name).click();
    assert.equal(await swatches.count(), group.items.length, `${group.name}: all items reachable`);
    assert.equal(await category(group.name).getAttribute('aria-pressed'), 'true');
    for (const key of group.items) assert(await dock.getByRole('button', { name: itemByKey(key).name, exact: true }).isVisible());
  }
  await category('Liquids').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await category('Gases').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await category('Powders').getAttribute('aria-pressed'), 'true');

  await page.keyboard.press('/');
  assert(await search.evaluate((el) => el === document.activeElement));
  await search.fill('water');
  assert.equal(await swatches.count(), 1, 'search crosses categories');
  await search.press('Enter');
  assert.equal(await page.evaluate(() => window.__app.settings.tool), E.WATER);
  assert.equal(await category('Liquids').getAttribute('aria-pressed'), 'true');
  assert.equal(await swatches.count(), 4);
  assert.equal(await dock.getByRole('button', { name: 'Water', exact: true }).getAttribute('aria-pressed'), 'true');

  await search.fill('no-such-element');
  assert.equal(await swatches.count(), 0);
  assert(await dock.locator('.material-empty').isVisible());
  await search.press('Enter');
  assert.equal(await page.evaluate(() => window.__app.settings.tool), E.WATER, 'no match must not change the brush');
  await search.press('Escape');
  assert.equal(await swatches.count(), 4);

  await category('Solids').click();
  const size = dock.getByRole('slider', { name: 'Brush size', exact: true });
  await size.focus();
  await size.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.__app.settings.radius), 6);
  assert.equal(await category('Solids').getAttribute('aria-pressed'), 'true', 'brush adjustment preserves browsing');
  await dock.getByRole('button', { name: 'Cube brush', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__app.settings.shape), 1);
  await dock.getByRole('button', { name: 'Replace mode', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.__app.settings.replace), true);
  assert.equal(await page.evaluate(() => window.__app.settings.paused), true, 'Space on a control does not pause/unpause');
  await dock.getByRole('button', { name: 'Eyedropper', exact: true }).click();
  assert.equal(await dock.getByRole('button', { name: 'Eyedropper', exact: true }).getAttribute('aria-pressed'), 'true');

  await category('Constructions').click();
  await dock.getByRole('button', { name: 'House', exact: true }).click();
  assert(await dock.getByRole('slider', { name: 'Construction size', exact: true }).isVisible());
  assert.equal(await dock.getByRole('slider', { name: 'Flow', exact: true }).count(), 0);
  await category('Powders').click();
  await dock.getByRole('button', { name: 'Sand', exact: true }).click();
  assert(await dock.getByRole('slider', { name: 'Flow', exact: true }).isVisible());
  await dock.getByRole('button', { name: 'Hide elements', exact: true }).click();
  assert(await dock.evaluate((el) => el.inert));
  assert(await page.locator('.dock-tab').evaluate((el) => el === document.activeElement));
  await page.keyboard.press('Space');
  assert.equal(await dock.evaluate((el) => el.inert), false);
  assert(await page.locator('.dock-tab').evaluate((el) => el.inert));
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__app.pov.mode === 'on');
  await page.keyboard.press('q');
  await page.waitForFunction(() => document.body.classList.contains('pov-menu'));
  assert.equal(await category('Tools').getAttribute('aria-pressed'), 'true', 'Q reveals the first-person tools category');
  assert.equal(await dock.evaluate((el) => el.inert), false);
  assert(await dock.getByRole('button', { name: 'Pickaxe', exact: true }).isVisible());
  assert.deepEqual(errors, []);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(`${url}/?size=64&preset=lab`);
  await mobile.waitForFunction(() => window.__app);
  for (const [width, height] of [[390, 844], [320, 568], [844, 390], [768, 1024]]) {
    await mobile.setViewportSize({ width, height });
    await mobile.locator('.dock').evaluate(async (el) => {
      el.getBoundingClientRect();
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    const bounds = await mobile.locator('.dock').boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height,
      `${width}×${height}: dock fits`);
    for (const name of ['Constructions', 'Liquids', 'Powders']) {
      await mobile.locator('.dock').getByRole('button', { name, exact: true }).tap();
      assert.equal(await mobile.locator('.material-heading h4').textContent(), name);
    }
    const tile = await mobile.locator('.material-swatch:visible').first().boundingBox();
    assert(tile.width > tile.height && tile.height >= 44, 'touch swatches remain rectangles with 44px targets');
    await mobile.locator('.material-swatch:visible').last().scrollIntoViewIfNeeded();
    const list = await mobile.locator('.material-swatches').boundingBox();
    const last = await mobile.locator('.material-swatch:visible').last().boundingBox();
    assert(last.y + last.height <= list.y + list.height, 'the last row is reachable without clipping');
  }
  await mobile.locator('.dock').getByRole('button', { name: 'Sand', exact: true }).tap();
  assert(await mobile.locator('.dock').evaluate((el) => el.inert), 'touch selection closes the picker');
  await mobile.locator('.dock-tab').tap();
  assert.equal(await mobile.locator('.dock').evaluate((el) => el.inert), false);
  assert.deepEqual(errors, []);
  console.log('Picker checks passed: categories, search, keyboard, controls, collapse, construction mode, touch and layout.');
} finally {
  await browser.close();
}
