// UI-only fixture: no simulation or shader compilation.
// node tools/topbar-check.mjs http://127.0.0.1:54339
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(app, /text: 'Save game'/);
assert.match(app, /text: 'Keyboard shortcuts'/);
assert.match(app, /type: 'views', key: 'view', label: 'Shader', options: VIEWS, renderThumb/);
assert.match(app, /openShaders:.*setSettingsOpen\(true\); settingsPanel.focusViews\(\)/);
assert.match(app, /k === 'p' \|\| k === 'P'\) actions.screenshot\(\)/);
assert.doesNotMatch(app, /toolbar\.(sync|close|isOpen)/);

const url = process.argv[2] ?? 'http://127.0.0.1:54339';
const browser = await launchBrowser({ lifetimeMs: 10000 });
try {
  for (const touch of [false, true]) {
    const page = await newTestPage(browser, { mode: 'ui',
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: touch, isMobile: touch });
    page.setDefaultTimeout(1500);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__toolbar-check', route => route.fulfill({
      contentType: 'text/html',
      body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/ui/styles.css"><body></body>',
    }));
    await page.goto(`${url}/__toolbar-check`);
    await page.evaluate(async () => {
      const [{ createToolbar }, { createHud }, { createSettings }, { h }, { VIEWS }] = await Promise.all([
        import('/src/ui/topbar.js'), import('/src/ui/hud.js'), import('/src/ui/settings.js'), import('/src/ui/dom.js'),
        import('/src/views.js'),
      ]);
      const settings = { paused: false, view: 0 };
      let panel;
      const hud = createHud({ onTogglePause: () => { settings.paused = !settings.paused; hud.setPaused(settings.paused); } });
      hud.setPaused(false);
      hud.setStats({ fpsV: 60, stepsV: 120, cellsV: '64³', resV: '1440 × 900' });
      const calls = [];
      let renders = 0, inFlight = 0, maxInFlight = 0;
      const toolbar = createToolbar({ actions: {
        setCamera: id => calls.push(id),
        toggleIndustryBuild: () => calls.push('build'),
        undo: () => calls.push('undo'),
        openShaders: () => { panel.setOpen(true); panel.focusViews(); },
        toggleSettings: () => { panel.setOpen(!panel.isOpen); toolbar.setSettingsOpen(panel.isOpen); },
      } });
      toolbar.setUndoEnabled(false);
      panel = createSettings({ settings, onClose: () => panel.setOpen(false), sections: [
        { title: 'Game', rows: [{ type: 'custom', el: h('div.settings-actions', {},
          h('button.btn', { text: 'Save game', on: { click: () => calls.push('save') } }),
          h('button.btn', { text: 'Keyboard shortcuts', on: { click: () => calls.push('help') } })) }] },
        { title: 'Shader', rows: [{ type: 'views', key: 'view', label: 'Shader', options: VIEWS,
          renderThumb: async (id, canvas) => {
            maxInFlight = Math.max(maxInFlight, ++inFlight);
            await new Promise(requestAnimationFrame);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = ['#bfa276', '#ea5a32', '#ff5c9a', '#3fcf86', '#9ea3ad', '#2f66d6'][id];
            ctx.fillRect(0, 0, 320, 200);
            canvas.dataset.rendered = '1';
            renders++; inFlight--;
            return true;
          }, onChange: id => { settings.view = id; } }] },
      ] });
      window.fixture = { settings, hud, toolbar, panel, calls,
        get renders() { return renders; }, get maxInFlight() { return maxInFlight; } };
      // Match the game's global Space binding to detect double keyboard activation.
      addEventListener('keydown', e => {
        if (e.code === 'Space') { e.preventDefault(); settings.paused = !settings.paused; hud.setPaused(settings.paused); }
      });
      hud.dismissHint();
    });
    const bar = page.locator('.toolbar');
    assert.equal(await bar.locator('button').count(), 4, 'build (hidden), undo, shader and settings');
    assert.equal(await bar.locator('select').count(), 1, 'one camera selector');
    assert.equal(await bar.locator('.pause-btn, .view-btn, .cam-seg, .keys-only').count(), 0);
    const pause = page.locator('.stats .pause-btn');
    await pause.click();
    assert.equal(await pause.getAttribute('aria-label'), 'Resume (Space)');
    await pause.focus();
    await page.keyboard.press('Space');
    assert.equal(await pause.getAttribute('aria-label'), 'Pause (Space)', 'focused Space toggles once');
    await page.getByRole('combobox', { name: 'Camera mode' }).selectOption('third');
    assert.equal(await page.evaluate(() => fixture.calls.at(-1)), 'third');
    assert.equal(await page.locator('.camera-select').inputValue(), 'god', 'wait for actual camera state');
    await page.evaluate(() => fixture.toolbar.setCamera('third'));
    assert.equal(await page.locator('.camera-select').inputValue(), 'third');
    assert.equal(await page.evaluate(() => fixture.renders), 0, 'no previews while closed');
    await bar.getByRole('button', { name: 'Change shader', exact: true }).click();
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Realistic');
    assert.equal(await page.locator('.view-card').count(), 6);
    await page.waitForFunction(() => document.querySelectorAll('.view-card canvas[data-rendered="1"]').length === 6);
    await page.getByRole('button', { name: 'Heat', exact: true }).click();
    assert.equal(await page.evaluate(() => fixture.settings.view), 1, 'numeric shader IDs preserved');
    assert.equal(await page.getByRole('button', { name: 'Heat', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => fixture.settings.paused), false, 'shader keyboard activation does not pause gameplay');
    await page.evaluate(() => {
      fixture.settings.view = 5;
      fixture.panel.sync();
      fixture.panel.setOpen(false);
      fixture.panel.setOpen(true);
    });
    await page.waitForFunction(() => !document.querySelector('.view-card:last-child .preview-status:not([hidden])'));
    assert.equal(await page.getByRole('button', { name: 'Plain', exact: true }).getAttribute('aria-pressed'), 'true', 'external view changes sync');
    assert.equal(await page.evaluate(() => fixture.maxInFlight), 1, 'reopening never overlaps preview readbacks');
    await page.getByRole('button', { name: 'Save game', exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => fixture.calls.slice(-2)), ['save', 'help']);
    await page.screenshot({ path: `/tmp/tpt-toolbar-settings-${touch ? 'mobile' : 'desktop'}.png`, animations: 'disabled' });
    await page.evaluate(() => { fixture.panel.setOpen(false); fixture.toolbar.setIndustry(true, true); });
    for (const [width, height] of [[1440, 900], [760, 800], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height });
      const bounds = await page.locator('.toolbar button:visible, .camera-select, .stats .pause-btn').evaluateAll(els =>
        els.map(el => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { name: el.title, x, y, width, height };
        }));
      for (const b of bounds) {
        assert(b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height, `${width}: ${b.name} fits`);
        if (touch) assert(b.width >= 44 && b.height >= 44, `${b.name}: 44px touch target`);
      }
      const strip = await page.locator('.stats').boundingBox();
      assert(strip.y > height / 2, 'playback stays bottom-right');
      for (let i = 0; i < bounds.length; i++) for (const b of bounds.slice(i + 1)) {
        const a = bounds[i];
        assert(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 ||
          a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5, `${width}: ${a.name} overlaps ${b.name}`);
      }
    }
    await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.evaluate(() => fixture.toolbar.setIndustry(false, false));
    await page.screenshot({ path: `/tmp/tpt-toolbar-ship-${touch ? 'mobile' : 'desktop'}.png`, animations: 'disabled' });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: compact toolbar, playback, camera, settings, keyboard and desktop/touch layout.');
} finally {
  await browser.close();
}
