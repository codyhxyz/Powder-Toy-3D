// UI-only fixture: no world generation or physics compilation; one <=10s browser slot.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const port = process.argv[2] ?? '56329';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(1500);
  await page.route('**/__village_ui', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><body class="village-on" style="background:#608971"><script type="module">
      import { createVillageUi } from '/src/pov/village/ui.js';
      import { initialState } from '/src/pov/village/state.js';
      const c = { active: true, home: true, state: initialState(), tool: null };
      window.actions = [];
      const ui = createVillageUi({ context: () => c, primary: () => null,
        act(a) { actions.push(a); if (a.type === 'tool') c.tool = a.key; },
        onOpen() {}, onClose() {}, speakNext() {}, stopSpeech() {}, toggleMute() {} });
      addEventListener('keydown', e => ui.handleKey(e));
      ui.update({ active: true, place: 'Home, sweet home' });
      window.fixtureReady = true;
    </script></body></html>`,
  }));
  await page.goto(`http://127.0.0.1:${port}/__village_ui`);
  await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(() => document.fonts.ready);
  const tools = page.getByRole('group', { name: 'World tools' });
  await tools.getByRole('button', { name: 'Shovel' }).click();
  assert.equal(await tools.getByRole('button', { name: 'Shovel' }).getAttribute('aria-pressed'), 'true');
  await page.locator('[data-action="tool-primary"]').click();
  await page.locator('[data-action="tool-secondary"]').click();
  await page.keyboard.press('f');
  assert.deepEqual(await page.evaluate(() => actions.map(a => a.type)), ['tool', 'tool-primary', 'tool-secondary', 'kick']);
  await tools.getByRole('button', { name: 'Hands' }).click();
  await page.locator('[data-action="punch"]').click();
  assert.equal(await page.evaluate(() => actions.at(-1).type), 'punch', 'punch is a click action, not F');
  await page.screenshot({ path: '/tmp/tpt-ac-tools-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await tools.getByRole('button', { name: 'Trowel' }).click();
  await page.locator('[data-action="tool-primary"]').click();
  const boxes = await page.locator('.village-hud button:visible').evaluateAll(buttons => buttons.map(b => {
    const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  for (const b of boxes) {
    assert.ok(b.x >= 0 && b.x + b.w <= 390 && b.y >= 0 && b.y + b.h <= 844, 'mobile buttons fit');
    assert.ok(b.w >= 44 && b.h >= 44, 'touch targets are at least 44px');
  }
  await page.screenshot({ path: '/tmp/tpt-ac-tools-mobile.png' });
  await page.locator('[data-action="pockets"]').click();
  assert.equal(await tools.isVisible(), false, 'tools hide while pockets own input');
  assert.equal(await page.locator('.village-panel').isVisible(), true);
  console.log('PASS desktop/mobile village tool picker, dig/dump/punch inputs, target sizes and modal ownership');
} finally {
  await browser.close();
}
