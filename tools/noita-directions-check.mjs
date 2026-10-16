// Artifact-only verification. Never starts the game or requests a GPU adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage } from './browser.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const html = fs.readFileSync(path.join(root, 'noita-directions.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'noita-directions/source.json'), 'utf8'));
assert.equal(manifest.biome, 'Mines (first main biome)');
assert.equal(manifest.native_biome_file, 'data/biome/coalmine.xml');
assert.deepEqual(manifest.origin, [-512, 512]);
assert.equal(manifest.source_cells, 262144);
assert.equal(manifest.names.length, 34);
assert.equal(manifest.sha256, '2791184113d62c12e68bf7e2240891228f3d86096d24e3960360fadf9307b724');
for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
for (const kind of ['reference', 'shaped', 'fold']) {
  for (const file of [`${kind}-overview.webp`, `${kind}-section.webp`, `${kind}-eye.webp`, `${kind}-plan.png`]) {
    assert.ok(fs.statSync(path.join(root, 'noita-directions', file)).size > 500, file);
  }
  assert.equal(Object.keys(manifest.models[kind].overviewMarkers).length, 4);
}
for (const match of html.matchAll(/(?:src|href)="(noita-directions\/[^"]+)"/g)) {
  assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
}
console.log('Static checks passed: Mines source, 12 rendered views, source references, landmark metadata, inline JS.');

if (!process.argv.includes('--static')) {
  const port = 54873;
  const mime = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filename.startsWith(root) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('content-type', mime[path.extname(filename)] || 'application/octet-stream');
    res.end(fs.readFileSync(filename));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await launchBrowser({ lifetimeMs: 25000 });
    const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1380, height: 1050 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(3500);
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/noita-directions.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#source-sha').textContent.startsWith('279118'));
    for (const kind of ['reference', 'shaped', 'fold']) {
      await page.locator(`[data-kind="${kind}"]`).click();
      await page.locator('#overview').evaluate(img => img.decode());
      assert.ok((await page.locator('#overview').getAttribute('src')).endsWith(`${kind}-overview.webp`));
      assert.equal(await page.locator(`[data-kind="${kind}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.locator('#section').check();
    await page.locator('#overview').evaluate(img => img.decode());
    assert.ok((await page.locator('#overview').getAttribute('src')).endsWith('fold-section.webp'));
    await page.locator('#landmarks').uncheck();
    assert.equal(await page.locator('.markers:not([hidden])').count(), 0);
    await page.locator('#landmarks').check();
    await page.locator('#section').uncheck();
    await page.locator('[data-kind="shaped"]').click();
    await page.locator('#copy').click();
    await page.waitForFunction(() => document.querySelector('#copy-result').textContent.length > 0);
    await page.locator('#overview').evaluate(img => img.decode());
    const inspect = () => page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      broken: [...document.images].filter(img => !img.complete || !img.naturalWidth).map(img => img.src),
      modelMarkers: document.querySelectorAll('.model-markers .marker').length,
      sourceMarkers: document.querySelectorAll('.source-markers .marker').length,
    }));
    assert.deepEqual(await inspect(), { overflow: false, broken: [], modelMarkers: 4, sourceMarkers: 4 });
    await page.screenshot({ path: '/tmp/noita-directions-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-kind="fold"]').click();
    await page.locator('#overview').evaluate(img => img.decode());
    assert.deepEqual(await inspect(), { overflow: false, broken: [], modelMarkers: 4, sourceMarkers: 4 });
    await page.screenshot({ path: '/tmp/noita-directions-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('UI checks passed: all directions, cutaway, markers, copy/fallback, desktop/mobile, no missing images or page errors.');
    console.log('Screenshots: /tmp/noita-directions-{desktop,mobile}.png');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
