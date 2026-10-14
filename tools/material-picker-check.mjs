// DOM-only fixture: no world, simulation loop or WebGPU device.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/__material-picker-check', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Material picker fixture</title><style>body{background:#373a2d}</style></head><body></body></html>',
  }));
  await page.goto(vite.url('/__material-picker-check'));
  await page.evaluate(async () => {
    await import('/src/ui/styles.css');
    await import('/node_modules/@fontsource-variable/archivo/index.css');
    const { createMaterialPicker } = await import('/src/pov/tools/materialPicker.js');
    const { Load, packContents } = await import('/src/pov/tools/transfer.js');
    const { E } = await import('/src/elements.js');
    const load = new Load(62208);
    for (const [id, n] of [[E.FUNGUS, 54], [E.SAND, 1234], [E.STONE, 20]]) {
      for (let i = 0; i < n; i++) load.cells.push([id, 20, 1, 0.25]);
    }
    let chosen = E.SAND;
    window.check = { load, E, opens: [], locks: 0, chosen: () => chosen };
    window.check.picker = createMaterialPicker({
      load, material: () => packContents(load).find(([id]) => id === chosen) ?? packContents(load)[0],
      choose: id => { chosen = id; }, onOpenChange: v => window.check.opens.push(v),
      requestLock: () => window.check.locks++,
    });
    window.check.picker.setVisible(true);
  });
  await page.locator('.mp-trigger').click();
  assert.equal(await page.locator('.mp-material').count(), 3);
  assert.match(await page.locator('.mp-material').first().innerText(), /Fungus/);
  assert.equal(await page.locator('.mp-material[aria-pressed="true"] strong').first().textContent(), 'Sand');
  mkdirSync('artifacts/trowel', { recursive: true });
  await page.screenshot({ path: 'artifacts/trowel/desktop.png' });
  await page.getByRole('searchbox').fill('fung');
  assert.equal(await page.locator('.mp-material').count(), 1);
  assert.match(await page.locator('.mp-material').innerText(), /2 full blocks/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog').evaluate(el => el.open), false);
  assert.equal(await page.evaluate(() => check.chosen() === check.E.FUNGUS), true);
  assert.deepEqual(await page.evaluate(() => check.opens), [true, false]);
  assert.equal(await page.evaluate(() => check.locks), 1);
  assert.match(await page.locator('.mp-trigger').innerText(), /Fungus/);
  await page.locator('.mp-trigger').click();
  await page.getByRole('searchbox').fill('unobtainium');
  assert.match(await page.locator('.mp-empty').innerText(), /No matching/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => check.locks), 1, 'Escape leaves pointer free');
  await page.setViewportSize({ width: 360, height: 640 });
  await page.locator('.mp-trigger').click();
  await page.screenshot({ path: 'artifacts/trowel/mobile.png' });
  assert.equal(await page.locator('dialog').evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
  }), true, 'small viewport fits');
  await page.evaluate(() => {
    check.load.cells.length = 0; check.load.version++; check.picker.sync();
  });
  assert.match(await page.locator('.mp-empty').innerText(), /Your pack is empty/);
  await page.evaluate(() => check.picker.setVisible(false));
  assert.equal(await page.locator('dialog').evaluate(el => el.open), false, 'deselect closes modal');
  await page.evaluate(() => check.picker.dispose());
  assert.equal(await page.locator('.material-picker, .mp-trigger').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: material names/counts, fungus selection, keyboard, search, empty pack, narrow layout, lifecycle');
} finally {
  await browser?.close();
  await vite.close();
}
