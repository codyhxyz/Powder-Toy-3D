// Real menu/loading path only; hold the game download so no simulation boots.
// node tools/loading-quality-check.mjs [base URL] [screenshot directory]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:56437';
const out = process.argv[3] ?? '/tmp/tpt-loading-quality';
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ character: 'woman' })));
  await page.route(/\/(?:src\/app\.js|assets\/app-[^/]+\.js)/, () => {});
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.mm-mode[data-mode="crueltySquad"]').click();
  for (const id of ['pharmakokinetiks', 'androgenAssault', 'apartmentAtrocity', 'paradise']) {
    await page.locator(`.mm-card[data-map="${id}"]`).click();
    const art = await page.locator('.mm-backdrop').evaluate(async (el) => {
      const urls = [...el.style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => m[1]);
      const image = new Image();
      image.src = urls[0];
      await image.decode();
      return { urls, width: image.naturalWidth, height: image.naturalHeight };
    });
    assert.ok(art.urls[0].includes(`/maps/${id}-loading.webp`), `${id}: dedicated artwork is first`);
    assert.ok(art.urls[1].includes(`/maps/${id}.webp`), `${id}: thumbnail remains a network fallback`);
    assert.deepEqual([art.width, art.height], [2560, 1600]);
    await page.waitForSelector('.mm-backdrop.sharp', { state: 'attached' });
  }
  await page.locator('.mm-start').click();
  await page.waitForSelector('.mm.loading .mm-you.live canvas', { timeout: 6000 });
  assert.equal(await page.getAttribute('.mm-you', 'data-character'), 'woman');
  assert.equal(await page.locator('.mm-load-name').textContent(), 'Paradise');
  const canvas = await page.locator('.mm-you canvas').evaluate(el => ({ width: el.width, height: el.height }));
  assert.ok(canvas.height >= 1120, 'live portrait covers its maximum size at 2x density');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const state = await page.evaluate(() => ({
      filter: getComputedStyle(document.querySelector('.mm-backdrop')).filter,
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
      booted: !!window.__app,
    }));
    assert.ok(!state.filter.includes('blur'), 'native artwork stays sharp');
    assert.ok(state.scroll <= state.width, 'no horizontal overflow');
    assert.equal(state.booted, false, 'UI check never boots the simulation');
    await page.screenshot({ path: join(out, `loading-${viewport.width}.png`) });
  }
  // A low-resolution-only map must remain softly defocused, not expose enlarged pixels.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.mm-mode[data-mode="sandbox"]').click();
  await page.locator('.mm-card[data-map="lab"]').click();
  await page.locator('.mm-start').click();
  await page.waitForSelector('.mm.loading');
  assert.equal(await page.locator('.mm-backdrop').evaluate(el => el.classList.contains('sharp')), false);
  assert.match(await page.locator('.mm-backdrop').evaluate(el => getComputedStyle(el).filter), /blur\(18px\)/);
  await page.route('**/maps/*-loading.webp*', route => route.fulfill({ contentType: 'image/webp', body: 'invalid image' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.mm-mode[data-mode="crueltySquad"]').click();
  const failedArt = page.waitForResponse(response => response.url().includes('/maps/paradise-loading.webp'));
  await page.locator('.mm-card[data-map="paradise"]').click();
  await (await failedArt).finished();
  await page.locator('.mm-start').click();
  await page.waitForSelector('.mm.loading');
  assert.equal(await page.locator('.mm-backdrop').evaluate(el => el.classList.contains('sharp')), false,
    'failed full-size image never makes the underlying thumbnail sharp');
  assert.deepEqual(errors, []);
  console.log(`PASS all four native loading images, sharp desktop/mobile UI, live 2x female portrait, soft thumbnail fallback; screenshots ${out}`);
} finally {
  await browser.close();
}
