// GPU work budgets (docs/webgpu.md I1, J4): per scripted frame, what gpu.stats
// counts (submits, render and compute passes, dispatches with indirect ones
// twice, workgroups, bytes allocated and uploaded, pipelines created) against
// each unit's numbers. Scenarios live in tools/budgets/<unit>.mjs, one file
// per unit (the format is in tools/budgets/foundation.mjs); a unit that
// changes a number says why in its commit.
//
// A unit file names its page: a harness page (harness: true, served in Vite's
// harness mode) or an app URL. It may give ready(page) and mode; the default
// waits for __harness.ready or __app.sim, in 'manual' mode.
//
// usage: node tools/budget-check.mjs [--unit foundation,sim] [--port N]
import { readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const UNITS = argv.includes('--unit') ? argv[argv.indexOf('--unit') + 1].split(',') : null;

const dir = join(ROOT, 'tools/budgets');
const units = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
  const u = (await import(pathToFileURL(join(dir, f)))).default;
  if (!UNITS || UNITS.includes(u.unit ?? basename(f, '.mjs'))) units.push({ file: f, ...u });
}
if (!units.length) { console.error(`no budget files${UNITS ? ` for ${UNITS}` : ''} in tools/budgets/`); process.exit(1); }

// a measured value: a stats counter, else a top-level extra
const valueOf = (m, key) => (m?.stats && key in m.stats ? m.stats[key] : m?.[key]);
function compare(m, expect) {
  const bad = [];
  for (const [key, want] of Object.entries(expect)) {
    const got = valueOf(m, key);
    const ok = typeof want === 'number' ? got === want
      : (want.min === undefined || got >= want.min) && (want.max === undefined || got <= want.max);
    if (!ok) bad.push(`${key} ${got} (want ${typeof want === 'number' ? want : JSON.stringify(want)})`);
  }
  return bad;
}

const servers = {};
const serve = async (harness) => (servers[harness ? 'harness' : 'app'] ??= await startVite({ harness }));
const browser = await launchBrowser();
let failures = 0, printedGpu = false;
try {
  for (const u of units) {
    const vite = await serve(Boolean(u.harness));
    const errors = [];
    let page;
    if (u.harness) {
      page = await openHarness(browser, vite, u.page, { mode: u.mode ?? 'manual', errors });
    } else {
      page = await newTestPage(browser, { mode: u.mode ?? 'manual', viewport: u.viewport ?? { width: 640, height: 400 } });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(vite.url(u.page));
    }
    if (u.ready) await u.ready(page);
    else if (!u.harness) await page.waitForFunction(() => window.__app?.sim, null, { polling: 100, timeout: 120000 });
    if (!printedGpu) {
      const info = await gpuInfo(page);
      console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
      printedGpu = true;
    }
    console.log(`\n${u.unit} (tools/budgets/${u.file}, ${u.page})`);
    for (const s of u.scenarios) {
      let m;
      try { m = await s.run(page); } catch (e) { failures++; console.log(`FAIL ${s.name}: ${e.message.split('\n')[0]}`); continue; }
      const bad = compare(m, s.expect);
      const shown = Object.keys(s.expect).map((k) => `${k} ${valueOf(m, k)}`).join(', ');
      if (bad.length) { failures++; console.log(`FAIL ${s.name}: ${bad.join('; ')}`); } else console.log(`ok   ${s.name}: ${shown}`);
    }
    if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ')}`); }
    await page.close();
  }
} finally {
  await browser.close();
  for (const v of Object.values(servers)) await v.close();
}
console.log(failures ? `\nbudget-check: ${failures} over budget` : '\nbudget-check: within budget');
process.exit(failures ? 1 : 0);
