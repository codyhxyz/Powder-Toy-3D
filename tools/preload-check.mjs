// The start menu preloads the game (src/preload.js): while the menu is up the
// browser fetches app.js and its chunks, CSS and workers without running them
// (the game is not booted behind the menu, and the menu has no long tasks),
// and Start then boots from them without fetching any again. Timed against the
// same page with the list stripped from its HTML: Start to the map on screen,
// a fresh browser each run (cold HTTP and shader caches).
// Needs a build (the dev server lists nothing): `npx vite build && npx vite preview --port 4733 --strictPort`,
// usage: node tools/preload-check.mjs [--port 4733] [--base https://tpt3d.codyh.xyz] [--maps island,lab]
//        [--menu-ms 4000] [--mbps 20 --rtt 40]   (a throttled connection, both directions)
import { launchBrowser, newTestPage } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt('base', `http://localhost:${opt('port', '4733')}`);
const maps = opt('maps', 'island,lab').split(',');
const MENU_MS = Number(opt('menu-ms', '4000'));   // how long the player looks at the menu before Start
const mbps = Number(opt('mbps', '0'));
const rtt = Number(opt('rtt', '0'));
const LOAD_TIMEOUT = 180000;   // ms: a cold shader compile on a shared GPU
const LONG_TASK_MS = 50;       // the browser's long task
const BYTES_PER_MBIT = 125000;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

async function run(map, preload) {
  const browser = await launchBrowser();
  try {
    const p = await newTestPage(browser, { mode: 'visual', viewport: { width: 1440, height: 900 } });
    const msgs = [];
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    p.on('pageerror', (e) => msgs.push(`pageerror: ${String(e).slice(0, 200)}`));
    if (mbps) {
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: mbps * BYTES_PER_MBIT, uploadThroughput: mbps * BYTES_PER_MBIT });
    }
    if (!preload) await p.route((u) => u.pathname === '/', async (route) => {
      const res = await route.fetch();
      route.fulfill({ response: res, body: (await res.text()).replace(/<script type="application\/json" id="app-preload">.*?<\/script>/, '') });
    });
    await p.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
    });
    await p.goto(`${base}/`);
    await p.waitForSelector('.mm.open .mm-card img');
    const tMenu = await p.evaluate(() => performance.now());
    await p.waitForTimeout(MENU_MS);
    const menu = await p.evaluate(({ tMenu, LONG_TASK_MS }) => ({
      listed: !!document.getElementById('app-preload'),
      booted: !!window.__app,
      long: window.__long.filter(([s, d]) => s > tMenu && d > LONG_TASK_MS).map(([, d]) => Math.round(d)),
      fetched: performance.getEntriesByType('resource').filter((e) => /\/assets\/(app|runtime)-/.test(e.name)).map((e) => e.name.split('/').pop()),
    }), { tMenu, LONG_TASK_MS });
    await p.click(`.mm-card[data-map="${map}"]`);
    const tClick = await p.evaluate(() => performance.now());
    await p.click('.mm-start');
    await p.waitForFunction(() => window.__app?.sim && !document.querySelector('.mm.open'), null, { timeout: LOAD_TIMEOUT, polling: 50 });
    const after = await p.evaluate((tClick) => {
      const ready = performance.now() - tClick;
      const res = performance.getEntriesByType('resource').filter((e) => /\/assets\/|\/models\//.test(e.name));
      return {
        ready: Math.round(ready),
        // downloaded after Start: more bytes moved than the file's (a cached file moves none, a revalidation only its headers)
        refetched: res.filter((e) => e.startTime > tClick && e.transferSize > e.encodedBodySize).map((e) => `${e.name.split('/').pop()} ${Math.round(e.transferSize / 1024)} KB`),
      };
    }, tClick);
    return { map, preload, menu, ...after, msgs };
  } finally {
    await browser.close();
  }
}

console.log(`${base}, ${mbps ? `${mbps} Mbit/s, ${rtt} ms RTT` : 'unthrottled'}, Start after ${MENU_MS} ms on the menu`);
for (const map of maps) {
  const off = await run(map, false);
  const on = await run(map, true);
  check(`${map}: the page lists the game to preload`, on.menu.listed);
  check(`${map}: the game is fetched while the menu is up`, on.menu.fetched.length >= 2, on.menu.fetched.join(' '));
  check(`${map}: but not booted behind it`, !on.menu.booted);
  check(`${map}: the menu has no long tasks while it preloads`, !on.menu.long.length, on.menu.long.join(' ') || 'none');
  check(`${map}: Start fetches no app chunk, CSS or worker again`, !on.refetched.some((r) => /^(app|runtime|detail-worker|structuresWorker)-/.test(r)), on.refetched.join(', ') || 'nothing');
  check(`${map}: no console errors or warnings`, !on.msgs.length && !off.msgs.length, [...on.msgs, ...off.msgs].join(' | '));
  console.log(`  ${map}: Start → map on screen ${off.ready} ms without the preload, ${on.ready} ms with it (${off.ready - on.ready} ms sooner)`);
  console.log(`  without it, Start fetched: ${off.refetched.join(', ') || 'nothing'}`);
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
