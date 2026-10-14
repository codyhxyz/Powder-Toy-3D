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
          pogo: {step: 0, max: 3, held: false, ready: false}};
        hud.update(state);
      </script>`,
  }));
  await page.goto(`${base}/__pogo-hud`);
  await page.waitForFunction(() => window.hud);
  const meter = page.locator('.pov-pogo');
  assert.equal(await meter.isVisible(), true);
  assert.match(await meter.innerText(), /Pogo 0\/3/);
  for (const step of [1, 2, 3]) {
    await page.evaluate(step => { state.pogo.step = step; hud.update(state); }, step);
    assert.match(await meter.innerText(), new RegExp(`Pogo ${step}/3`));
    const fill = await page.locator('.pov-pogo .pov-fill').evaluate(el => Number(el.style.transform.match(/[\d.]+/)[0]));
    assert.ok(Math.abs(fill - step / 3) < 0.00001);
  }
  assert.match(await meter.innerText(), /MAX/);
  await page.screenshot({ path: '/tmp/pogo-charge-desktop.png' });
  await page.evaluate(() => { state.pogo.ready = true; hud.update(state); });
  assert.match(await meter.innerText(), /Jump now!/);
  await page.setViewportSize({ width: 390, height: 844 });
  const rect = await meter.boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'meter fits a phone');
  await page.screenshot({ path: '/tmp/pogo-charge-mobile.png' });
  await page.evaluate(() => { state.pogo.held = true; state.pogo.ready = false; hud.update(state); });
  assert.match(await meter.innerText(), /Release jump/);
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
  console.log('Pogo HUD: power, cues, desktop/mobile layout, visibility and cleanup passed');
} finally {
  await browser.close();
}
