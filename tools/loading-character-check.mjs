// Isolated loading UI, never boots the game. One <=10-second GPU slot.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5639';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui' });
  await page.route('**/__loading-character', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(`${base}/__loading-character`);
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
      check(`${mode}: correct still and worker`, img() === `/you-${character}.webp` && workers.at(-1).character === character);
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
    check('save ignores previously selected Halo mode', img() === '/you-stick.webp');
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
    return results;
  });
  for (const { label, ok } of results) {
    assert.ok(ok, label);
    console.log(`PASS ${label}`);
  }
  await page.waitForSelector('.mm-you.live canvas', { state: 'attached', timeout: 4000 });
  assert.equal(await page.getAttribute('.mm-you', 'data-character'), 'spartan');
  console.log('PASS real Spartan preview worker renders');
} finally {
  await browser.close();
}
