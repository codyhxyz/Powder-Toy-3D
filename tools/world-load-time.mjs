// World load time in the browser: N warm page loads of ?size=world (the
// browser's cache warm after the first), each timed from navigation to the
// window loaded with its far field ready and fully built, plus the main
// thread's long tasks (> 50 ms, PerformanceObserver 'longtask') until then:
// what the page blocked for. Prints each run, then the minimum and median.
// usage: node tools/world-load-time.mjs [--port 5396] [--runs 5] [--query seed=1]   (needs a server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5396'), runs = +opt('runs', 5), query = opt('query', '');
const TIMEOUT_MS = 120000;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  window.__lt = { total: 0, max: 0, n: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__lt.total += e.duration; window.__lt.max = Math.max(window.__lt.max, e.duration); window.__lt.n++; } })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* no long task timing */ }
});
const res = [];
for (let i = 0; i <= runs; i++) {   // run 0 warms the cache, and isn't counted
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  await p.goto(`http://localhost:${port}/?size=world${query ? `&${query}` : ''}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  const r = await p.waitForFunction(() => {
    const w = window.__app?.win;
    return w?.loaded && w.far?.ready && w.far.built && w.far.queue.length === 0
      ? { readyMs: performance.now(), longTaskMs: window.__lt.total, longestMs: window.__lt.max, longTasks: window.__lt.n, structures: w.P.structures ? 1 : 0 } : null;
  }, null, { timeout: TIMEOUT_MS, polling: 'raf' }).then((h) => h.jsonValue());
  if (i) { res.push(r); console.log(`run ${i}: ready ${r.readyMs.toFixed(0)} ms, long tasks ${r.longTaskMs.toFixed(0)} ms (${r.longTasks}, longest ${r.longestMs.toFixed(0)} ms)`); }
  await p.close();
}
const stat = (k) => { const v = res.map((r) => r[k]).sort((x, y) => x - y); return `min ${v[0].toFixed(0)}, median ${v[v.length >> 1].toFixed(0)}`; };
console.log(`ready: ${stat('readyMs')} ms; long tasks: ${stat('longTaskMs')} ms; longest: ${stat('longestMs')} ms`);
await b.close();
