// Scratch: runs a JS snippet against the v2 engine in the outcomes harness page (engine=v2) and prints its result.
//   node tools/v2/debug-run.mjs <file.js> [--port N]   (the file's text is the body of an async function(e, h))
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';
const file = process.argv[2];
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 5820);
const body = readFileSync(file, 'utf8');
const vite = await startVite({ harness: true, port });
const browser = await launchBrowser();
try {
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/outcomes.html?engine=v2', { errors });
  const r = await page.evaluate(async (src) => {
    const { createEngine } = await import('/tools/outcomes/engine-v2.js');
    const h = window.__harness;
    const e = createEngine(h.gpu);
    const fn = new Function('e', 'h', `return (async () => { ${src} })();`);
    try { return await fn(e, h); } finally { await e.dispose(); }
  }, body);
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
  if (errors.length) console.log('page errors:', errors.join('\n'));
} finally { await browser.close(); await vite.close(); }
