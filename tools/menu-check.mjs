// The start menu end to end, on the GPU: the bare page shows the menu without
// loading the game; Start shows the loading screen and boots the picked map at
// its size; Esc brings the menu back over the game; Load map switches to a
// world; the drawer's Map row names it. Screenshots go to --out.
// Needs a dev server: `npx vite --port 5733 --strictPort`, then
// usage: node tools/menu-check.mjs [--port 5733] [--base https://tpt3d.codyh.xyz] [--out dir]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { MAPS } from '../src/maps.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5733');
const out = opt('out', 'menu-shots');
const base = opt('base', `http://localhost:${port}`);   // the live site too
const LOAD_TIMEOUT = 180000;   // ms: a cold shader compile
const MENU_MS = 1500;          // ms: the most the bare page may take to show the menu (dev server, unbundled)
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errs.push(m.text().slice(0, 400)); });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const t0 = Date.now();
await p.goto(`${base}/`);
await p.waitForSelector('.mm.open .mm-card img');
const menuMs = Date.now() - t0;
check('menu up', menuMs < MENU_MS, `${menuMs} ms`);
check('the game is not loaded behind it', await p.evaluate(() => !window.__app));
const cards = await p.$$eval('.mm-card', (els) => els.map((e) => [e.dataset.map, e.querySelector('.mm-tag').textContent]));
check('every map listed with a size tag', cards.length === MAPS.length && cards.every(([, t]) => t), JSON.stringify(cards));
await p.evaluate(() => Promise.all([...document.images].map((i) => i.complete || new Promise((r) => { i.onload = i.onerror = r; }))));
check('every preview loads', await p.$$eval('.mm-card .mm-thumb', (els) => els.every((e) => e.querySelector('img')?.naturalWidth > 0)));
await p.screenshot({ path: join(out, '1-menu.png') });

await p.click('.mm-card[data-map="lab"]');
await p.click('.mm-start');
await p.waitForSelector('.mm.loading');
await p.screenshot({ path: join(out, '2-loading.png') });
await p.waitForFunction(() => window.__app?.sim && !document.querySelector('.mm.open'), null, { timeout: LOAD_TIMEOUT });
const s1 = await p.evaluate(() => { const s = window.__app.settings; return { size: s.size, preset: s.preset, dims: [window.__app.sim.g.nx, window.__app.sim.g.ny, window.__app.sim.g.nz] }; });
check('Start boots the lab at 128³', s1.size === '128' && s1.preset === 'lab' && s1.dims.join() === '128,128,128', JSON.stringify(s1));
await p.waitForTimeout(1500);
await p.screenshot({ path: join(out, '3-game.png') });

await p.mouse.move(700, 450);
await p.keyboard.press('Escape');
await p.waitForSelector('.mm.open.in-game');
check('Esc opens the menu over the game, on the lab', await p.$eval('.mm-card[aria-selected="true"]', (e) => e.dataset.map) === 'lab');
await p.screenshot({ path: join(out, '4-ingame-menu.png') });
await p.keyboard.press('Space');   // the game gets no keys while the menu is up
check('keys stay in the menu', await p.evaluate(() => !window.__app.settings.paused));
await p.dblclick('.mm-card[data-map="volcanoWorld"]');
await p.waitForFunction(() => window.__app.win?.scene.key === 'volcanoWorld' && window.__app.win.loaded, null, { timeout: LOAD_TIMEOUT });
check('a double-click loads Volcano Isles in a world', await p.evaluate(() => window.__app.settings.size === 'world' && !document.querySelector('.mm.open')));
await p.waitForTimeout(3000);
await p.screenshot({ path: join(out, '5-world.png') });

await p.keyboard.press(',');
await p.waitForSelector('.drawer.open');
await p.waitForTimeout(500);   // (it slides in)
const row = await p.$eval('.map-row', (e) => e.textContent);
check('the drawer names the map and its size', row.includes('Volcano Isles') && row.includes('1024×1024'), row);
await p.screenshot({ path: join(out, '6-drawer.png') });
await p.click('.map-row .btn');
check('Change map opens the menu', await p.$eval('.mm', (e) => e.classList.contains('open') && e.classList.contains('in-game')));
await p.click('.mm-resume');
check('Resume closes it', await p.$eval('.mm', (e) => !e.classList.contains('open')));

// a direct link skips the menu, as the test tools and invites need
await p.goto(`${base}/?map=damValley`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: LOAD_TIMEOUT });
const s2 = await p.evaluate(() => ({ size: window.__app.settings.size, preset: window.__app.settings.preset, menu: !!document.querySelector('.mm.open') }));
check('?map=damValley boots straight into it', s2.size === 'valley' && s2.preset === 'damValley' && !s2.menu, JSON.stringify(s2));

check('no errors', !errs.length, errs.join('\n'));
await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
