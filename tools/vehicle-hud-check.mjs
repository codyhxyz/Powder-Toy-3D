// Real-shell driving HUD, desktop + touch. No page /src imports; works on built/live URLs.
// node tools/vehicle-hud-check.mjs --url http://localhost:5497 --shot /tmp/driving
// Browser execution is intentionally separate from the CPU check.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { E, ELEMENTS } from '../src/elements.js';
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const url = new URL(opt('url', `http://localhost:${opt('port', '5497')}/`));
url.searchParams.set('size', '128'); url.searchParams.set('preset', 'empty');
const separate = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const browser = await launchBrowser();
try {
  for (const touch of [false, true]) {
    const page = await newTestPage(browser, { mode: 'ui', hasTouch: touch, viewport: { width: 960, height: 640 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(url.href); await ready(page);
    await page.waitForFunction(() => window.__app?.pov?.vehicles && window.__app?.industry);
    await page.evaluate(({ water, temp, life }) => {
      const a = window.__app, [A, B] = a.sim.blankState(), g = a.sim.g;
      for (let y = 0; y < 20; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = a.sim.cellTexel(x, y, z) * 4;
        A[i] = water; A[i + 1] = temp; A[i + 2] = life;
      }
      a.sim.load(A, B); a.requestRender();
      a.pov.vehicles.spawnLayout({ vehicles: [
        { kind: 'boat', at: [64, 20, 64] },
        { kind: 'jeep', at: [28, 20, 28] },
        { kind: 'hoverbike', at: [100, 20, 100] },
      ] });
    }, { water: E.WATER, temp: ELEMENTS[E.WATER].temp, life: ELEMENTS[E.WATER].life });
    await page.keyboard.press('v');
    await page.waitForFunction(() => window.__app.pov.mode === 'on');
    await page.evaluate(() => { window.__app.pov.test.assumeLocked = true; });
    await page.waitForFunction(() => window.__app.pov.vehicles.list.length === 3 && window.__app.pov.vehicles.list.find(v => v.kind === 'boat').impl.state.motorWet);
    const board = async kind => {
      await page.evaluate(kind => {
        const a = window.__app, p = a.pov, v = p.vehicles.list.find(v => v.kind === kind), t = v.impl.body.translation();
        p.vehicles.dismount(p.player);
        p.player.spawn(p.player.pos.clone().set(t.x / 0.3 + 5, t.y / 0.3, t.z / 0.3));
        p.vehicles.use(p.player);
        a.test.resume();
      }, kind);
      await page.waitForFunction(kind => window.__app.pov.vehicles.seated?.kind === kind && document.querySelector('.veh-panel')?.classList.contains('on'), kind);
      await page.evaluate(() => window.__app.test.park());
    };
    await board('boat');
    assert.equal(await page.locator('.veh-name').textContent(), 'Boat');
    assert.equal(await page.locator('.veh-hull [aria-label="Hull health"]').count(), 1);
    assert.equal(await page.locator('.veh-boost').isVisible(), false);
    assert.equal(await page.locator('.veh-warning').isVisible(), false);
    for (const selector of ['.industry', '.hotbar', '.hb-held', '.pov-hint']) assert.equal(await page.locator(selector).isVisible(), false, selector);
    assert.equal(await page.locator('.pov-vitals').isVisible(), true);
    assert.equal(await page.locator('.veh-exit').isVisible(), !touch);
    if (touch) assert.equal(await page.getByRole('button', { name: 'Get out', exact: true }).isVisible(), true);
    assert(!await page.locator('.toasts').textContent().then(text => /W\/S|motor needs water/i.test(text)), 'no boarding toast');
    const sizes = touch ? [[390, 844], [844, 390], [320, 568]] : [[1280, 800], [960, 640], [390, 844], [320, 640]];
    // Enable the actual developer overlay so its bounds are part of the assertion.
    await page.evaluate(() => { window.__app.settings.profiler = true; window.__app.test.resume(); });
    await page.waitForFunction(() => document.querySelector('.prof')?.classList.contains('show'));
    await page.evaluate(() => window.__app.test.park());
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      // Keep the short-lived help present when measuring (timer behavior checked below).
      await page.locator('.veh-help').evaluate(el => el.classList.add('on'));
      const selectors = ['.veh-panel', '.pov-vitals', '.veh-help', '.prof'];
      if (touch) selectors.push('.touch-stick', '.touch-actions');
      const boxes = [];
      for (const selector of selectors) {
        const box = await page.locator(selector).boundingBox();
        assert(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${touch}/${width} ${selector} fits`);
        for (const [other, otherBox] of boxes) assert(separate(box, otherBox), `${touch}/${width}: ${selector} overlaps ${other}`);
        boxes.push([selector, box]);
      }
      if (opt('shot', null) && ((touch && width === 390) || (!touch && width === 960))) {
        await render(page);
        await page.screenshot({ path: `${opt('shot')}-${touch ? 'touch' : 'desktop'}.png` });
      }
    }
    await page.keyboard.press('F1');
    assert.equal(await page.locator('.veh-panel').isVisible(), false);
    assert.equal(await page.locator('.industry').isVisible(), false);
    await page.keyboard.press('F1');
    assert.equal(await page.locator('.veh-panel').isVisible(), true);
    await page.evaluate(() => { window.__app.settings.profiler = false; });
    await board('jeep'); assert.equal(await page.locator('.veh-boost').isVisible(), true);
    await board('hoverbike'); assert.equal(await page.locator('.veh-boost').isVisible(), true);
    await board('boat');
    // Wall time, not game time: instructions fade even when parked, exit remains.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.veh-help')).opacity === '0', null, { timeout: 6500 });
    assert.equal(await page.locator('.veh-panel').isVisible(), true);
    await page.evaluate(() => {
      const a = window.__app, b = a.pov.vehicles.seated.impl.body;
      b.setTranslation({ x: 19.2, y: 9, z: 19.2 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      a.test.resume();
    });
    await page.waitForFunction(() => !document.querySelector('.veh-warning').hidden);
    await page.evaluate(() => window.__app.test.park());
    if (touch) await page.getByRole('button', { name: 'Get out', exact: true }).tap();
    else await page.keyboard.press('e');
    await page.evaluate(() => window.__app.test.resume());
    await page.waitForFunction(() => !document.body.classList.contains('pov-driving'));
    assert.equal(await page.locator('.veh-panel').isVisible(), false);
    assert.equal(await page.locator('.industry').isVisible(), true);
    await board('boat');
    await page.evaluate(() => { const a = window.__app; a.pov.player.hurt(1000, 'HUD check'); a.test.resume(); });
    await page.waitForFunction(() => !document.body.classList.contains('pov-driving'));
    assert.equal(await page.locator('.veh-panel').isVisible(), false);
    await board('boat');
    await page.evaluate(() => { const a = window.__app; a.pov.vehicles.reset(a.pov.player); a.test.park(); });
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('pov-driving')), false);
    assert.equal(await page.locator('.veh-panel').isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS vehicle HUD ${touch ? 'touch' : 'desktop'}: layout, profiler, health, hints, boost, water warning, exit/death/reset/F1`);
  }
} finally { await browser.close(); }
