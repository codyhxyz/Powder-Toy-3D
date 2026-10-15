// Actual interaction component + byte-identical deployed CSS, without booting
// unrelated world/physics pipelines. Desktop keyboard/click and coarse touch.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build, preview } from 'vite';
import { launchBrowser, newTestPage } from './browser.mjs';

const styles = readdirSync('dist/assets').filter(name => /^(app|main)-.*\.css$/.test(name));
assert(styles.some(name => name.startsWith('app-')));
for (const name of styles) {
  const response = await fetch(`https://tpt3d.codyh.xyz/assets/${name}`);
  assert(response.ok, `Deployed stylesheet missing: ${name}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(`dist/assets/${name}`));
}
const bundle = await build({
  configFile: false, logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/pov/interact.js', formats: ['es'] }, minify: true },
});
const component = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(output => output.output)
  .find(chunk => chunk.type === 'chunk' && chunk.isEntry).code;
if (process.argv.includes('--cpu')) {
  console.log('PASS deployed stylesheets are byte-identical and the real interaction component bundles independently (CPU only).');
  process.exit(0);
}
const server = await preview({ preview: { host: '127.0.0.1', port: 54987, strictPort: true }, logLevel: 'warn' });
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
${styles.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
<body class="pov-on"><div class="readout">Rock</div><script type="module">
import { createInteract } from '/prompt-component.js';
const ui = window.promptFixture = { mode: 'crueltySquad', used: 0 };
ui.control = createInteract({getMode: () => ui.mode});
ui.control.provide(() => [{id:'imported:Door',title:'Door',verb:'Open',lines:[],
  position:{x:0,y:0,z:-1},radius:0.8,use(){ui.used++;}}]);
ui.update = () => ui.control.update({x:0,y:0,z:0},{x:0,y:0,z:-1},Infinity,true);
ui.update();
</script>`;
let browser;
try {
  browser = await launchBrowser();
  for (const touch of [false, true]) {
    const page = await newTestPage(browser, { mode: 'ui', hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 600 } : { width: 800, height: 500 } });
    try {
      await page.route('**/prompt-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.route('**/prompt-component.js', route => route.fulfill({ contentType: 'text/javascript', body: component }));
      await page.goto('http://127.0.0.1:54987/prompt-fixture');
      const button = page.getByRole('button', { name: 'Open Door', exact: true });
      await button.waitFor({ state: 'visible' });
      const style = await button.evaluate(node => {
        const root = node.closest('.pov-use'), key = node.querySelector('.action-key');
        return {
          width: root.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
          key: getComputedStyle(key).display, coarse: matchMedia('(pointer: coarse)').matches,
          background: getComputedStyle(root).backgroundColor, border: getComputedStyle(root).borderTopWidth,
          readout: getComputedStyle(document.querySelector('.readout')).visibility,
        };
      });
      assert(style.width < 160);
      assert.equal(style.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px');
      assert.equal(style.readout, 'hidden');
      if (touch) {
        assert(style.coarse); assert(style.height >= 44); assert.equal(style.key, 'none');
        await button.tap();
      } else {
        assert.equal(style.key, 'flex'); assert(style.height <= 36);
        await page.keyboard.press('Tab');
        assert.equal(await button.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
        await page.keyboard.press('Enter');
        await button.click();
        await page.locator('.pov-use').screenshot({ path: '/tmp/cruelty-compact-prompt.png' });
      }
      assert.equal(await page.evaluate(() => promptFixture.used), touch ? 1 : 2);
      await page.evaluate(() => { promptFixture.mode = 'sandbox'; promptFixture.update(); });
      assert.equal(await page.locator('.pov-use').evaluate(node => node.classList.contains('source-use')), false);
      assert.equal(await page.locator('.readout').evaluate(node => getComputedStyle(node).visibility), 'visible');
      await page.evaluate(() => promptFixture.control.dispose());
      assert.equal(await page.locator('.pov-use').count(), 0);
      console.log('PASS exact deployed CSS + real interaction component', touch ? 'coarse touch' : 'desktop click/keyboard/focus', style);
    } finally { await page.context().close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
