// Smoke test of the app on WebGPU (docs/webgpu.md I1): it boots, draws each
// box scene, and the subsystems that aren't ported yet are cleanly greyed out
// rather than crashing. Pages run in a 400×250 viewport with ?view=plain (the
// cheapest view to build: realistic and the data views are --views'), and a
// shot of every scene is saved for review.
//
//   node tools/smoke.mjs [--port N] [--stage boxes,worlds,views] [--views heat,realistic] [--out dir]
//
// Stages (default: boxes,worlds):
//   boxes   one boot at 64³; each box scene (the lab, the volcano, the Islet,
//           Empty) loaded and drawn with test.renderOnce: no GPU error, a
//           non-blank canvas (its luminance varies above a floor), the shot
//   worlds  every World map: with the world's wiring ready (src/wire/world.js,
//           U10) each boots at ?win=64 and draws; until then a World map
//           falls back to a box with a toast (a boot from ?map=), and the
//           menu's openMap refuses it, and nothing throws. The giant volcano's
//           window is 384 tall: only check-wgsl (a) covers it
//   views   the booted lab in each view of --views (default: every view),
//           each one's pipeline built on first use as the app builds it
//
// Until U13 lands, three.js's warnings for its meshes' ShaderMaterials are
// allowed (ALLOW). Runs its own Vite (tools/vite-server.mjs) and launches
// through tools/browser.mjs.
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const STAGES = arg('stage', 'boxes,worlds').split(',');
const OUT = arg('out', join(ROOT, '.tmp-smoke'));   // (ignored by git: .tmp-*)
const VIEWPORT = { width: 400, height: 250 };
const BOXES = ['lab', 'volcano', 'island', 'empty'];
const WORLD_MAPS = ['island', 'volcanoWorld', 'labWorld', 'descent'];
// a scene's canvas: the standard deviation of its luminance (0-255) at least this
const MIN_STDEV = 4;
// three's warnings for a built-in or GLSL material it can't take as a node material (U13 ports them)
const ALLOW = [/NodeBuilder: Material "ShaderMaterial" is not compatible/, /NodeBuilder: Material "RawShaderMaterial" is not compatible/];
// what the page may log without it being an error of ours: the relay the UI asks for quota (not running here)
const IGNORE = [/Failed to load resource: net::ERR_CONNECTION_REFUSED/];

mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

// A page's errors: page errors, GPU and console errors (less the allowed and ignored ones).
function watch(page) {
  const errors = [], allowed = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 400)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (ALLOW.some((r) => r.test(t))) { allowed.push(t); return; }
    if (IGNORE.some((r) => r.test(t))) return;
    // (Chrome reports a WebGPU error as a warning; its info lines, such as "WebGPU is experimental on this platform", aren't)
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
  });
  return { errors, allowed };
}

// The app at `query`, parked (manual mode) and with every pipeline its settings need built.
async function boot(browser, vite, query) {
  const page = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  const w = watch(page);
  await page.goto(vite.url(`/${query}`));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (!failed) await page.evaluate(() => { __app.post.settings.taa = false; return __app.test.ready(); });
  return { page, ...w, failed };
}

// Two frames of the current scene (the first after a load runs the derived
// passes over every brick), the second's canvas as presented: its luminance's
// mean and standard deviation, and a shot.
async function draw(page, name) {
  const s = await page.evaluate(async () => {
    await __app.test.renderOnce();
    const shot = await __app.test.renderOnce({ capture: true });
    let sum = 0, sum2 = 0;
    const n = shot.width * shot.height, d = shot.data;
    for (let i = 0; i < n; i++) {
      const l = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
      sum += l; sum2 += l * l;
    }
    const mean = sum / n;
    return { mean, stdev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), size: [shot.width, shot.height] };
  });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  return s;
}

const vite = await startVite();
const browser = await launchBrowser();
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
try {
  if (STAGES.includes('boxes') || STAGES.includes('views') || STAGES.includes('worlds')) {
    const { page, errors, allowed, failed } = await boot(browser, vite, '?size=64&preset=lab&view=plain');
    ok(!failed, `boot ?size=64&preset=lab&view=plain (${secs()})${failed ? `: ${failed.slice(0, 300)}` : ''}`);
    if (!failed) {
      const info = await gpuInfo(page);
      console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
      if (STAGES.includes('boxes')) {
        for (const preset of BOXES) {
          const loaded = await page.evaluate((p) => { __app.loadPreset(p, false); return __app.settings.preset; }, preset);
          const s = await draw(page, `box-${preset}`);
          // (the Islet is the world's generator on a box: until U10 the lab stands in, with a toast)
          const wired = await page.evaluate(() => __app.wires.world);
          const expect = preset === 'island' && !wired ? 'lab' : preset;
          ok(loaded === expect, `${preset}: loads${loaded !== preset ? ` (as ${loaded}: its port isn't in yet)` : ''}`);
          ok(preset === 'empty' ? s.stdev > 0 : s.stdev >= MIN_STDEV,
            `${preset}: canvas ${s.size.join('×')}, luminance mean ${s.mean.toFixed(1)}, stdev ${s.stdev.toFixed(1)} (${secs()})`);
        }
      }
      if (STAGES.includes('worlds')) {
        const wired = await page.evaluate(() => __app.wires.world);
        if (!wired) {
          // the menu's Start on a World map: refused, the box and its scene untouched
          const r = await page.evaluate((maps) => maps.map((m) => {
            const before = [__app.settings.size, __app.sim.id];
            let opened, threw = null;
            try { opened = __app.openMap(m); } catch (e) { threw = e.message; }
            return { m, opened, threw, same: __app.settings.size === before[0] && __app.sim.id === before[1] };
          }), WORLD_MAPS);
          for (const x of r) ok(x.opened === false && !x.threw && x.same, `${x.m}: World maps aren't wired yet: openMap refuses it, the box stays${x.threw ? ` (threw ${x.threw})` : ''}`);
        }
      }
      if (STAGES.includes('views')) {
        const keys = arg('views', null)?.split(',');
        const views = await page.evaluate(async (want) => {
          const { VIEWS } = await import('/src/views.js');
          return VIEWS.filter((v) => !want || want.includes(v.key)).map((v) => ({ id: v.id, key: v.key }));
        }, keys);
        await page.evaluate(() => __app.loadPreset('lab', false));
        for (const v of views) {
          const t = Date.now();
          await page.evaluate((id) => { __app.setView(id); return __app.test.ready(); }, v.id);
          const s = await draw(page, `view-${v.key}`);
          ok(s.stdev >= MIN_STDEV, `view ${v.key}: built and drawn in ${((Date.now() - t) / 1000).toFixed(1)} s, luminance stdev ${s.stdev.toFixed(1)}`);
        }
      }
      ok(!errors.length, `no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
      if (allowed.length) console.log(`(${allowed.length} allowed three.js material warnings, until U13)`);
    }
    await page.close();
  }

  if (STAGES.includes('worlds')) {
    const { page, errors, failed } = await boot(browser, vite, '?size=64&map=labWorld&view=plain&win=64');
    const wired = !failed && await page.evaluate(() => __app.wires.world);
    if (failed) ok(false, `boot ?map=labWorld: ${failed.slice(0, 300)}`);
    else if (!wired) {
      const r = await page.evaluate(() => ({ size: __app.settings.size, win: !!__app.win, dims: [__app.sim.g.nx, __app.sim.g.ny, __app.sim.g.nz] }));
      ok(r.size === '64' && !r.win, `?map=labWorld before the world's port: a 64³ box instead (${r.dims.join('×')}), no window (${secs()})`);
      const s = await draw(page, 'world-fallback');
      ok(s.stdev >= MIN_STDEV, `the fallback box draws: luminance stdev ${s.stdev.toFixed(1)}`);
    } else {
      await page.close();
      for (const m of WORLD_MAPS) {
        const b = await boot(browser, vite, `?map=${m}&view=plain&win=64`);
        ok(!b.failed, `${m}: boots at ?win=64${b.failed ? `: ${b.failed.slice(0, 300)}` : ''}`);
        if (!b.failed) {
          await b.page.waitForFunction(() => __app.win?.loaded, null, { polling: 250, timeout: 120000 });
          const s = await draw(b.page, `world-${m}`);
          ok(s.stdev >= MIN_STDEV, `${m}: luminance stdev ${s.stdev.toFixed(1)} (${secs()})`);
          ok(!b.errors.length, `${m}: no page or GPU errors${b.errors.length ? `:\n  ${b.errors.join('\n  ')}` : ''}`);
        }
        await b.page.close();
      }
    }
    if (!wired) ok(!errors.length, `no page or GPU errors in the fallback${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
    if (!page.isClosed()) await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `\nsmoke: ${failures} failed (shots in ${OUT})` : `\nsmoke: ok (${secs()}; shots in ${OUT})`);
process.exit(failures ? 1 : 0);
