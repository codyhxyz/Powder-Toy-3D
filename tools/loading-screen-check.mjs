// The start menu's icons and its loading screen (src/ui/menu.js), on the GPU.
// The menu: every gamemode listed with its icon, the picked one's emblem in
// its title. The loading screen, held at each of its steps (the game's own
// download is stalled, and the steps are reported through launch.progress as
// app.js would): its mode, name, one step line and portrait, nothing more, and
// no sideways scroll at a narrow width. Then one real boot: the step line
// walks through and the screen comes down once the map is up. Screenshots go to --out.
// Needs a dev server: `node_modules/.bin/vite --port 5611 --strictPort`, then
// usage: node tools/loading-screen-check.mjs [--port 5611] [--out dir] [--no-boot]
//        node tools/loading-screen-check.mjs --boot-only --base <a build: vite preview, the live site>
//   (--boot-only: only the real boot; a build has no /src/app.js to hold)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';
import { GAMEMODES } from '../src/maps.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5611');
const out = opt('out', 'loading-shots');
const boot = !args.includes('--no-boot');
const held = !args.includes('--boot-only');
const base = opt('base', `http://localhost:${port}`);
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 380, height: 760 };   // a narrow window (not a phone emulation)
const LOAD_TIMEOUT = 180000;                   // ms: a cold shader compile
const TEAM = GAMEMODES.find((m) => m.key === 'slayer');   // the team game the checks pick
const STEP_WAIT = 5000;                        // ms: the first step line
mkdirSync(out, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const browser = await launchBrowser();
const errs = [];
try {
  if (held) {
    const page = await newTestPage(browser, { mode: 'ui', viewport: WIDE });
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
    // hold the game's download (never answered): the loading screen stays up for its pictures.
    // (launch.progress is reached through the page's own copy of src/launch.js: the dev server's URL for it)
    await page.route(/\/src\/app\.js/, () => {});

    await page.goto(`${base}/`);
    await page.waitForSelector('.mm.open .mm-card img');
    const modes = await page.$$eval('.mm-mode', (els) => els.map((e) => [e.querySelector('.mm-mode-name').textContent, !!e.querySelector('.mm-mode-ico svg path')]));
    check('every gamemode listed with its icon', modes.length > 0 && modes.every(([, icon]) => icon), JSON.stringify(modes));
    check('the title has the gamemode\'s emblem', await page.$eval('.mm-mode-head .mm-emblem svg path', (p) => p.getAttribute('d').length > 50));
    await page.screenshot({ path: join(out, '1-menu-sandbox.png') });
    if (modes.some(([n]) => n === TEAM.name)) {
      await page.click(`.mm-mode:has-text("${TEAM.name}")`);
      await page.screenshot({ path: join(out, '2-menu-slayer.png') });
    }

    // a box in a team game: Lab, Team Slayer
    await page.click('.mm-card[data-map="lab"]');
    await page.click('.mm-start');
    await page.waitForSelector('.mm.loading');
    await page.waitForFunction(() => document.querySelector('.mm-load-step')?.textContent, null, { timeout: STEP_WAIT });
    const report = (step) => page.evaluate(async (s) => (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/src/launch.js')))).launch.progress(s), step);
    const step = () => page.$eval('.mm-load-step', (e) => e.textContent);
    check('the loading screen: build under way', (await step()).startsWith('Filling'), await step());
    await report('compile');
    await report('cold');
    check('compile under way, with the cold note', (await step()).startsWith('Compiling') && (await step()).includes('update'), await step());
    const load = await page.evaluate(() => ({
      mode: document.querySelector('.mm-load-mode').textContent, name: document.querySelector('.mm-load-name').textContent,
      you: document.querySelector('.mm-you img')?.naturalWidth ?? 0,
      extra: document.querySelectorAll('.mm-load svg, .mm-load ul, .mm-load ol, .mm-load aside').length,   // no medals, step list or tip
    }));
    check('mode, name and portrait, nothing more', load.mode && load.name && load.you > 0 && load.extra === 0, JSON.stringify(load));
    await page.screenshot({ path: join(out, '3-loading-lab-slayer.png') });
    await page.setViewportSize(NARROW);
    await page.waitForTimeout(200);
    const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('.mm-load').scrollWidth]);
    check('no sideways scroll at a narrow width', scroll[0] <= scroll[1] && scroll[2] <= scroll[1], JSON.stringify(scroll));
    await page.screenshot({ path: join(out, '4-loading-narrow.png') });
    await page.setViewportSize(WIDE);

    // a world in Sandbox: a fresh page, Island
    const page2 = await newTestPage(browser, { mode: 'ui', viewport: WIDE });
    page2.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
    await page2.route(/\/src\/app\.js/, () => {});   // never answered: the screen stays
    await page2.goto(`${base}/`);
    await page2.waitForSelector('.mm.open .mm-card img');
    await page2.click('.mm-mode:first-of-type');
    await page2.click('.mm-card[data-map="island"]');
    await page2.click('.mm-start');
    await page2.waitForFunction(() => document.querySelector('.mm-load-step')?.textContent, null, { timeout: STEP_WAIT });
    for (const s of ['compile', 'world']) await page2.evaluate(async (k) => (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/src/launch.js')))).launch.progress(k), s);
    const s2 = await page2.$eval('.mm-load-step', (e) => e.textContent);
    check('a world has the world step, under way', s2 === 'Generating the world', s2);
    await page2.screenshot({ path: join(out, '5-loading-island.png') });
    await page2.close();
    await page.close();
  }

  if (boot) {
    // the real boot, on a fresh page: Lab in Team Slayer, so its match starts behind the screen too
    const page3 = await newTestPage(browser, { mode: 'ui', viewport: WIDE });
    page3.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
    await page3.goto(`${base}/`);
    await page3.waitForSelector('.mm.open .mm-card img');
    // every step line the screen shows, until it comes down
    await page3.evaluate(() => {
      window.__seen = new Set();
      const mo = new MutationObserver(() => {
        window.__seen.add(document.querySelector('.mm-load-step').textContent);
        if (window.__app && !document.querySelector('.mm.open')) mo.disconnect();
      });
      mo.observe(document.querySelector('.mm'), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const slayer = await page3.$(`.mm-mode:has-text("${TEAM.name}")`);
    if (slayer) await slayer.click();
    await page3.click('.mm-card[data-map="lab"]');
    await page3.click('.mm-start');
    await page3.waitForFunction(() => window.__app?.sim && !document.querySelector('.mm.open'), null, { timeout: LOAD_TIMEOUT });
    const seen = await page3.evaluate(() => [...window.__seen]);
    // (a team game's match step reads app.js's line for it)
    const lines = ['Downloading', 'Filling', 'Compiling', ...(slayer ? ['Picking the teams'] : [])];
    const reached = lines.every((t) => seen.some((l) => l.includes(t)));
    check('a real boot reaches every step and the screen comes down', reached, JSON.stringify(seen));
    const s3 = await page3.evaluate(() => ({ preset: window.__app.settings.preset, size: window.__app.settings.size }));
    check('the lab is up', s3.preset === 'lab', JSON.stringify(s3));
    await page3.close();
  }
  check('no page errors', !errs.length, errs.join(' | '));
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed; shots in ${out}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
