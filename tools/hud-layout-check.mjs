// UI-only fixture: real HUD components/styles, no GPU simulation.
// node tools/hud-layout-check.mjs http://127.0.0.1:54683
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:54683';
const browser = await launchBrowser();
const separate = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x ||
  a.y + a.height <= b.y || b.y + b.height <= a.y;
try {
  for (const touch of [false, true]) {
    const page = await newTestPage(browser, { mode: 'ui', hasTouch: touch, reducedMotion: 'reduce' });
    await page.route('**/__hud-layout-check', route => route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
    }));
    await page.goto(`${url}/__hud-layout-check`);
    await page.evaluate(async () => {
      await Promise.all([
        import('/src/fonts.css'), import('/src/ui/styles.css'), import('/src/pov/pov.css'),
      ]);
      const { createHud } = await import('/src/ui/hud.js');
      const { createHotbar } = await import('/src/pov/tools/hotbar.js');
      const { createPovHud } = await import('/src/pov/hud.js');
      const hud = createHud();
      hud.dismissHint();
      hud.setStats({ fpsV: 56, stepsV: 224, cellsV: '2.1M of 134.2M', resV: '17% res' });
      const hotbar = createHotbar();
      hotbar.setSlot(0, [{ key: 'shovel', name: 'Shovel' }], 0);
      hotbar.select(0);
      hotbar.setStatus(0, 'SAND+ ×104');
      hotbar.setVisible(true);
      createPovHud().show(true);
      document.querySelector('.pov-vitals').classList.add('show');
      document.body.classList.add('pov-on');
      window.layoutHotbar = hotbar;
      await document.fonts.ready;
    });
    for (const width of [1440, 900, 761, 760, 560, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const held = page.locator('.hb-held');
      if (touch) {
        assert.equal(await held.isVisible(), false, 'touch uses its action-button label');
        continue;
      }
      for (const name of ['Shovel', 'Long tool name for wrapping']) {
        await page.evaluate(name => {
          window.layoutHotbar.setSlot(0, [{ key: 'shovel', name }], 0);
          window.layoutHotbar.select(0);
        }, name);
        const box = await held.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 &&
          box.y + box.height <= 900, `${width}: held tool fits`);
        for (const selector of ['.stats', '.pov-vitals']) {
          assert(separate(box, await page.locator(selector).boundingBox()),
            `${width}: held tool overlaps ${selector}`);
        }
        if (name === 'Shovel' && (width === 1440 || width === 390)) {
          await page.screenshot({ path: `/tmp/tpt-hud-layout-${width}.png` });
        }
      }
    }
    await page.evaluate(() => window.layoutHotbar.setVisible(false));
    assert.equal(await page.locator('.hb-held').isVisible(), false);
    await page.close();
  }
  console.log('HUD layout passed: desktop, narrow, touch, long names and hidden state.');
} finally {
  await browser.close();
}
