// Real toolbelt + UI, with a fresh inventory. Starts and stops its own server.
// Run: node tools/tool-selection-check.mjs [--shots /tmp/tool-selection]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shots = process.argv[process.argv.indexOf('--shots') + 1];
const shotDir = process.argv.includes('--shots') ? shots : null;
if (shotDir) await mkdir(shotDir, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port: 18473, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && /toolbelt/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://127.0.0.1:18473/?preset=empty&size=128');
  await page.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(async () => {
    const { inventory } = await import('/src/pov/tools/inventory.js');
    return ['GUN', 'SMG', 'SNIPER'].filter((k) => inventory.has(k));
  }), ['GUN', 'SMG', 'SNIPER'], 'all guns are available without a palette visit');
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await page.evaluate(() => { window.__app.pov.test.assumeLocked = true; });
  const held = () => page.evaluate(() => window.__app.pov.toolbelt.selectedKey);
  const stack = page.locator('.hb-stack');
  const checkHeld = async (key) => {
    assert.equal(await held(), key);
    assert.equal(await page.locator('.hb-tool[aria-pressed="true"]').getAttribute('data-key'), key);
  };

  await page.keyboard.press('3');
  await checkHeld('GUN');
  assert.deepEqual(await page.locator('.hb-tool-name').allTextContents(), ['Pistol', 'SMG', 'Sniper rifle']);
  assert.match(await stack.innerText(), /Press 3 again: next tool/);
  await page.keyboard.press('3'); await checkHeld('SMG');
  await page.keyboard.press('3'); await checkHeld('SNIPER');
  await page.keyboard.press('3'); await checkHeld('GUN');
  await page.keyboard.down('3'); await checkHeld('SMG');
  await page.keyboard.down('3'); await checkHeld('SMG'); // browser repeat
  await page.keyboard.up('3');
  await page.keyboard.press('1'); await checkHeld('SHOVEL');
  await page.keyboard.press('3'); await checkHeld('SMG'); // remembers this slot

  // Other slots, singleton slots, and tools acquired while playing.
  await page.keyboard.press('4'); await checkHeld('BOMB');
  await page.keyboard.press('4'); await checkHeld('BOMB');
  await page.evaluate(async () => (await import('/src/pov/tools/inventory.js')).inventory.give('ROCKET'));
  await checkHeld('ROCKET');
  assert.equal(await page.locator('.hb-tool').count(), 2);
  await page.keyboard.press('4'); await checkHeld('BOMB');

  // The existing wheel path still visits every tool, including all three guns.
  await page.evaluate(() => {
    const { toolbelt, ctx } = window.__app.pov;
    toolbelt.select('GUN');
    toolbelt.update({ ...ctx, wheel: 1 });
  });
  await checkHeld('SMG');
  await page.evaluate(() => {
    const { toolbelt, ctx } = window.__app.pov;
    toolbelt.update({ ...ctx, wheel: -1 });
  });
  await checkHeld('GUN');

  // No tool selection shortcuts while typing or holding modifiers.
  await page.evaluate(() => {
    const input = document.body.appendChild(document.createElement('input'));
    input.id = 'selection-test-input'; input.focus();
  });
  await page.keyboard.press('3');
  assert.equal(await held(), 'GUN');
  await page.locator('#selection-test-input').evaluate((el) => el.remove());
  await page.keyboard.press('Control+3');
  assert.equal(await held(), 'GUN');

  // Unlocked pointer selection uses the same toolbelt path, not a cosmetic preview.
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('.hb-tool[data-key="SNIPER"]').click();
  await checkHeld('SNIPER');
  assert.equal(await page.locator('.hb-name').innerText(), 'Sniper rifle');
  await page.keyboard.press('Tab'); // native keyboard navigation
  await page.locator('.hb-tool[data-key="GUN"]').focus();
  await page.keyboard.press('Enter');
  await checkHeld('GUN');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'GUN', 'focus survives row refresh');

  const bounds = async () => {
    for (const locator of [page.locator('.hotbar'), stack, ...await page.locator('.hb-slot').all()]) {
      const box = await locator.boundingBox();
      const vp = page.viewportSize();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1,
        `menu stays in viewport: ${JSON.stringify(box)}`);
    }
    assert.ok(await page.locator('.hb-slot').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth)),
      'category labels fit their slots');
  };
  await page.mouse.move(5, 200);
  await bounds();
  if (shotDir) await page.screenshot({ path: `${shotDir}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await bounds();
  if (shotDir) await page.screenshot({ path: `${shotDir}/mobile.png` });
  await page.setViewportSize({ width: 320, height: 568 });
  await bounds();

  // Touch affordance and direct row selection on an actual coarse-pointer page.
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await touch.goto('http://127.0.0.1:18473/?preset=empty&size=128');
  await touch.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await touch.evaluate(() => window.__app.pov.enter());
  await touch.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await touch.locator('.hb-slot').nth(2).tap();
  assert.equal(await touch.locator('.hb-touch-hint').isVisible(), true);
  await touch.locator('.hb-tool[data-key="SMG"]').tap();
  assert.equal(await touch.evaluate(() => window.__app.pov.toolbelt.selectedKey), 'SMG');
  if (shotDir) await touch.screenshot({ path: `${shotDir}/touch.png` });
  await touch.close();

  await page.evaluate(() => document.activeElement.blur());
  await page.mouse.move(5, 200);
  await page.waitForFunction(() => document.querySelector('.hb-stack').hidden, null, { timeout: 6000 });
  assert.equal(await page.locator('.hb-name').isVisible(), true, 'equipped name remains after stack closes');
  await page.keyboard.press('3');
  await checkHeld('SMG');
  assert.equal(await stack.isVisible(), true);
  await page.evaluate(() => window.__app.pov.toolbelt.setVisible(false));
  assert.equal(await page.locator('.hotbar').evaluate((el) => el.inert), true);
  assert.deepEqual(errors, []);
  console.log('PASS: default guns, slot cycling/wrap/recall, repeat guard, wheel, spawn additions, pointer/keyboard/touch, responsive bounds, auto-hide.');
} finally {
  await browser?.close();
  await server.close();
}
