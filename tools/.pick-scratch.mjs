import { launchBrowser } from './browser.mjs';
const OUT = process.argv[2], base = 'http://localhost:18933';
const browser = await launchBrowser();
const fails = [], check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`); if (!ok) fails.push(n); };
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`${base}/`);
    await p.waitForSelector('.cp .cp-card img');
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.complete || new Promise((r) => { i.onload = i.onerror = r; }))));
    check(`${name}: chooser first, menu not open`, !(await p.$('.mm.open')));
    await p.screenshot({ path: `${OUT}/${name}-1-choose.png` });
    if (name === 'desktop') {
      await p.click('.cp-card >> nth=1');
      await p.waitForSelector('.mm.open', { timeout: 5000 });
      check('chooser gone after pick', !(await p.$('.cp')));
      const s = await p.evaluate(() => JSON.parse(localStorage.getItem('powder-toy-3d:settings')));
      check('female kept', s.gender === 'female' && s.character === 'woman' && s.villageCharacter === 'girl', JSON.stringify(s));
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${OUT}/${name}-2-menu.png` });
      await p.reload();
      await p.waitForSelector('.mm.open', { timeout: 5000 });
      check('second visit skips the chooser', !(await p.$('.cp')));
    }
    check(`${name}: no page errors`, !errs.length, errs.join(' | '));
    await ctx.close();
  }
} finally { await browser.close(); }
process.exit(fails.length ? 1 : 0);
