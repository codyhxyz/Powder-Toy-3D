// (scratch) Island default view: CPU ms of each world step per frame (writeback, fields, light) and the frame interval.
// Hypothesis: recordWriteback's whole-window CPU sets dominate (tens of ms); fields and light are a few ms.
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
const vite = await startVite();
let browser = null;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 960, height: 600 } });
  await page.goto(vite.url('/?map=island'));
  await page.waitForFunction(() => window.__app?.sim && window.__app.view?.volumeDrawn, null, { polling: 200, timeout: 60000 });
  const r = await page.evaluate(async () => {
    const wv = window.__app.worldView, acc = { wb: [], fields: [], light: [] };
    const wrap = (o, k, key) => { const f = o[k].bind(o); o[k] = (...a) => { const t = performance.now(); const r = f(...a); acc[key].push(performance.now() - t); return r; }; };
    wrap(wv.worldCopy, 'recordWriteback', 'wb'); wrap(wv.fields, 'update', 'fields'); wrap(wv.light, 'update', 'light');
    const ts = [], t = performance.now();
    await new Promise((done) => { const f = (now) => { ts.push(now); if (now - t < 3000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
    const s = (a) => { const d = [...a].sort((x, y) => x - y); return a.length ? { n: a.length, p50: +d[d.length >> 1].toFixed(2), max: +d.at(-1).toFixed(2) } : { n: 0 }; };
    const iv = ts.slice(1).map((v, i) => v - ts[i]);
    return { frame: s(iv), wb: s(acc.wb), fields: s(acc.fields), light: s(acc.light), copy: wv.worldCopy.stats?.() ?? null };
  });
  console.log(JSON.stringify(r));
} finally { await browser?.close(); await vite.close(); }
