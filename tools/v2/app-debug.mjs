// Scratch: runs a JS snippet in the game booted at ?physics=v2 (manual mode) and prints its result.
//   node tools/v2/app-debug.mjs <file.js> [--port N] [--query 'size=64&preset=empty']   (the file's text is the body of an async function(a))
import { readFileSync } from 'node:fs';
import { launchBrowser, newTestPage } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
const argv = process.argv.slice(2);
const body = readFileSync(argv[0], 'utf8');
const q = argv.includes('--query') ? argv[argv.indexOf('--query') + 1] : 'size=64&preset=empty';
const vite = await startVite();
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(vite.url(`/?${q}&view=plain&physics=v2`));
  await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 150000 });
  await page.evaluate(async () => { await window.__app.test.ready(); window.__app.test.park(); });
  const r = await page.evaluate(async (src) => new Function('a', `return (async () => { ${src} })();`)(window.__app), body);
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
  if (errors.length) console.log('page errors:', errors.join('\n'));
} finally { await browser.close(); await vite.close(); }
