// Isolated HUD: no world, shaders, or simulation. Serve Vite first.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:4593';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1280, height: 800 } });
  await page.route('**/__pogo-hud', route => route.fulfill({
    contentType: 'text/html',
    body: `<body class="pov-on" style="background:#607b88">
      <script type="module">
        import '/src/fonts.css';
        import '/src/ui/styles.css';
        import '/src/pov/pov.css';
        import { createPovHud } from '/src/pov/hud.js';
        window.hud = createPovHud();
        hud.show(true);
        window.state = {dt: 1/60, health: 1, breath: 1, locked: true,
          pogo: 0};
        hud.update(state);
      </script>`,
  }));
  await page.goto(`${base}/__pogo-hud`);
  await page.waitForFunction(() => window.hud);
  const meter = page.locator('.pov-pogo');
  assert.equal(await meter.isVisible(), true);
  for (const step of [0, 1, 2, 3]) {
    await page.evaluate(step => { state.pogo = step / 3; hud.update(state); }, step);
    assert.equal(await meter.innerText(), '', 'bar only: no numbers or timing cues');
    const fill = await page.locator('.pov-pogo .pov-fill').evaluate(el => Number(el.style.transform.match(/[\d.]+/)[0]));
    assert.ok(Math.abs(fill - step / 3) < 0.00001);
  }
  const desktop = await meter.boundingBox();
  assert.equal(desktop.width, 80);
  assert.equal(desktop.height, 4);
  await page.screenshot({ path: '/tmp/pogo-charge-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const rect = await meter.boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'meter fits a phone');
  await page.screenshot({ path: '/tmp/pogo-charge-mobile.png' });
  for (const patch of [{ dead: true }, { swooping: true }, { pogo: null }]) {
    await page.evaluate(patch => hud.update({ ...state, ...patch }), patch);
    assert.equal(await meter.isVisible(), false);
  }
  await page.evaluate(() => { hud.update(state); document.body.classList.add('pov-nohud'); });
  assert.equal(await meter.isVisible(), false);
  await page.evaluate(() => { document.body.classList.remove('pov-nohud'); hud.show(false); });
  assert.equal(await meter.isVisible(), false);
  await page.evaluate(() => hud.dispose());
  assert.equal(await meter.count(), 0);
  console.log('Pogo HUD: bar-only power, desktop/mobile layout, visibility and cleanup passed');
} finally {
  await browser.close();
}
