// Run against your own Vite server: node tools/topbar-check.mjs http://127.0.0.1:54339
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:54339';
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: touch, isMobile: touch });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}/?size=64&preset=lab`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__app, null, { timeout: 120000 });
    const bar = page.locator('.toolbar');
    const pause = bar.locator('.pause-btn');
    await pause.click();
    assert.equal(await pause.getAttribute('aria-label'), 'Resume (Space)');
    assert.equal(await pause.textContent(), 'Paused');
    assert.equal(await page.locator('.pill').count(), 0, 'no separate overlapping pause status');
    await pause.click();
    assert.equal(await pause.getAttribute('aria-label'), 'Pause (Space)');
    await pause.focus();
    await page.keyboard.press('Space');
    assert.equal(await pause.getAttribute('aria-label'), 'Resume (Space)');
    await bar.locator('.view-btn').click();
    assert.equal(await bar.locator('.view-btn').getAttribute('aria-expanded'), 'true');
    await page.locator('.view-card').nth(1).click();
    assert.equal(await bar.locator('.view-btn').getAttribute('aria-expanded'), 'false');
    await bar.locator('.view-btn').click();
    await page.locator('.view-card').first().click();
    await bar.getByRole('button', { name: 'Settings (,)', exact: true }).click();
    assert(await page.locator('.drawer').evaluate((el) => el.classList.contains('open')));
    await bar.getByRole('button', { name: 'Settings (,)', exact: true }).click();
    for (const [width, height] of [[1440, 900], [901, 700], [900, 700], [768, 1024], [760, 800], [640, 800], [480, 800], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height });
      const bounds = await bar.locator('button:visible').evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { name: button.title || button.textContent, x, y, width, height };
        }));
      for (const b of bounds) {
        assert(b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height,
          `${touch ? 'touch' : 'mouse'} ${width}: ${b.name} fits`);
        if (touch) assert(b.width >= 44 && b.height >= 44, `${b.name}: 44px touch target`);
      }
      for (let i = 0; i < bounds.length; i++) for (const b of bounds.slice(i + 1)) {
        const a = bounds[i];
        assert(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 ||
          a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5,
        `${width}: ${a.name} overlaps ${b.name}`);
      }
      if ((!touch && width === 1440) || (touch && width === 390)) {
        await page.locator('.dock').evaluate(async (el) => {
          el.getBoundingClientRect();
          await Promise.all(el.getAnimations().map((animation) => animation.finished));
        });
        await page.mouse.move(width / 2, height / 2);
        await page.screenshot({ path: `/tmp/tpt-toolbar-ship-${touch ? 'mobile' : 'desktop'}.png` });
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Toolbar checks passed: pause, keyboard, views, settings, touch targets and non-overlapping layouts.');
} finally {
  await browser.close();
}
