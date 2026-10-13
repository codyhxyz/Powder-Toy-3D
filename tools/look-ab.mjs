// One batched A/B capture: each map on a "before" and an "after" URL, interleaved,
// 1440x900 @2x in visual mode, a full-quality render(page) checkpoint, and the
// in-app profiler's per-pass GPU ms. Stops early to stay inside the run budget.
// usage: node tools/look-ab.mjs <outDir> --before https://tpt3d.codyh.xyz --after http://localhost:PORT [--maps lab,volcanoWorld]
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const urls = { before: opt('before', 'https://tpt3d.codyh.xyz'), after: opt('after', 'http://localhost:5591') };
const maps = opt('maps', 'lab,volcanoWorld').split(',');
const SETTLE_MS = Number(opt('settle', '5000'));     // GI and TAA converge
const PROF_MS = Number(opt('prof', '2000'));
const STOP_AFTER_MS = Number(opt('stop', '150000')); // start no new page after this
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const report = {};
const b = await launchBrowser();
try {
  outer: for (const m of maps) {
    for (const side of ['before', 'after']) {
      if (Date.now() - t0 > STOP_AFTER_MS) { console.log('budget: stopping before', m, side); break outer; }
      const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
      try {
        await p.goto(`${urls[side]}/?map=${m}`, { timeout: 60000 });
        await ready(p);
        await p.waitForFunction(() => window.__app?.gpu, null, { polling: 250, timeout: 60000 });
        await p.waitForTimeout(SETTLE_MS);
        const prof = await p.evaluate(async (ms) => {
          const a = window.__app;
          a.settings.profiler = true;
          await new Promise((r) => setTimeout(r, ms));
          const s = a.prof.last && JSON.parse(JSON.stringify(a.prof.last));
          a.settings.profiler = false;
          return { gpu: s?.gpu, phases: s?.phases?.map((ph) => ({ id: ph.id, gpu: ph.gpu, detail: ph.detail?.map((d) => [d.name, +d.gpu.toFixed(2)]) })) };
        }, PROF_MS);
        await render(p);
        await p.screenshot({ path: `${out}/${m}-${side}.png` });
        report[`${m}-${side}`] = { prof, errs: errs.slice(0, 5), t: Date.now() - t0 };
        console.log(m, side, 'gpu ms', prof.gpu, 'errs', errs.length, 't', Date.now() - t0);
      } catch (e) {
        report[`${m}-${side}`] = { error: String(e).slice(0, 300), errs };
        console.log(m, side, 'failed', String(e).slice(0, 200));
      } finally {
        await p.close();
      }
    }
  }
} finally {
  await b.close();
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
