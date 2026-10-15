// Isolated loading UI, never boots the game. One <=10-second GPU slot.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5639';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui' });
  await page.route('**/__loading-character', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(`${base}/__loading-character`);
  await page.addStyleTag({ url: `${base}/src/ui/menu.css` });
  const results = await page.evaluate(async () => {
    const { createMenu } = await import('/src/ui/menu.js');
    const { GAMEMODES } = await import('/src/maps.js');
    const NativeWorker = window.Worker;
    const workers = [];
    window.Worker = class {
      constructor() { workers.push(this); }
      postMessage(data) { if (data.canvas) this.character = data.character; }
      terminate() { this.terminated = true; }
    };
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ character: 'stick' }));
    const menu = createMenu({ modes: GAMEMODES, map: 'lab', onStart() {} });
    const results = [];
    const check = (label, ok) => results.push({ label, ok });
    const fig = () => document.querySelector('.mm-you');
    const img = () => fig().querySelector('img')?.getAttribute('src');
    for (const mode of ['slayer', 'ctf', 'koth', 'infection', 'siege', 'sandbox']) {
      menu.loading('Loading', { mode });
      const character = ['siege', 'sandbox'].includes(mode) ? 'stick' : 'spartan';
      check(`${mode}: correct still and worker`, img() === `/you-${character === 'stick' ? 'bag' : character}.webp` && workers.at(-1).character === character);
    }
    workers.at(-1).onmessage({ data: 'ready' });
    check('ready worker replaces still', !!fig().querySelector('canvas'));
    const old = workers.at(-1);
    menu.loading('Loading', { mode: 'slayer' });
    check('changed character drops old live model', old.terminated && img() === '/you-spartan.webp' && !fig().querySelector('canvas'));
    old.onmessage({ data: 'ready' });
    check('late old worker cannot show wrong model', !fig().querySelector('canvas'));
    workers.at(-1).onmessage({ data: { failed: 'test failure' } });
    check('worker failure keeps correct fallback', img() === '/you-spartan.webp');
    menu.loading('Loading save', { name: 'Save' });
    check('save ignores previously selected Halo mode', img() === '/you-bag.webp');
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ character: 'real' }));
    menu.loading('Loading', { mode: 'sandbox' });
    check('changed preference is re-read', img() === '/you.webp');
    menu.close();
    const offscreen = window.OffscreenCanvas;
    window.OffscreenCanvas = undefined;
    menu.loading('Loading', { mode: 'slayer' });
    check('no OffscreenCanvas still shows Spartan', img() === '/you-spartan.webp');
    menu.close();
    window.OffscreenCanvas = offscreen;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    menu.loading('Loading', { mode: 'sandbox' });
    check('blocked storage matches default body', img() === '/you.webp');
    Storage.prototype.getItem = getItem;
    menu.close();
    window.Worker = NativeWorker;
    menu.loading('Loading', { mode: 'slayer' });
    window.__loadingMenu = menu;
    return results;
  });
  for (const { label, ok } of results) {
    assert.ok(ok, label);
    console.log(`PASS ${label}`);
  }
  await page.waitForSelector('.mm-you.live canvas', { state: 'attached', timeout: 4000 });
  assert.equal(await page.getAttribute('.mm-you', 'data-character'), 'spartan');
  console.log('PASS real Spartan preview worker renders');
  await page.evaluate(() => {
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ villageCharacter: 'girl' }));
    window.__loadingMenu.loading('Loading', { mode: 'animalCrossing', map: 'animalCrossing' });
  });
  await page.waitForSelector('.mm-you.live canvas', { state: 'attached', timeout: 4000 });
  assert.equal(await page.getAttribute('.mm-you', 'data-character'), 'girl');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const zoom = await page.evaluate(() => {
      const fig = document.querySelector('.mm-you'), canvas = fig.querySelector('canvas');
      document.querySelector('.mm').dispatchEvent(new WheelEvent('wheel', { deltaY: -1e6, cancelable: true }));
      return { scale: new DOMMatrix(getComputedStyle(canvas).transform).a, baseHeight: canvas.offsetHeight,
        figHeight: fig.offsetHeight, transform: canvas.style.transform };
    });
    assert.ok(zoom.scale > 2.9, 'zoom enlarges the whole canvas rather than cropping its contents');
    assert.equal(zoom.baseHeight, zoom.figHeight, 'zoom does not change loading layout');
    console.log(`PASS unclipped girl zoom at ${viewport.width}px: ${zoom.transform}`);
    if (process.env.TPT_ZOOM_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.TPT_ZOOM_SCREENSHOTS}-${viewport.width}.png` });
    }
  }
  await page.evaluate(() => window.__loadingMenu.close());
} finally {
  await browser.close();
}
