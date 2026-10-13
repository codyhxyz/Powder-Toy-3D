// Runs the raster bench page (bench/raster.html, docs/v2.md 11 "Week 0")
// headless through tools/browser.mjs, at a small canvas: every pipeline built,
// the light grid filled, each configuration drawn for a few frames, then the
// page's JSON printed. Exits non-zero if the page reports an error (a WGSL or
// pipeline error, a GPU error, a lost device, face counts that don't match
// the bake), or gives no verdict where msaa-1 and taau-1 both ran. In this container the adapter is SwiftShader (a CPU): its numbers
// say the page works, not what a frame costs. The real numbers come from the
// page on the user's iPhone and Mac (open /bench/raster.html there).
//
// usage: node tools/raster-bench.mjs [--scene lab|volcano|lab,volcano] [--frames 12] [--warmup 3]
//          [--size 320x200] [--res device|v2|both] [--only msaa-1,taau-1] [--timestamps 0] [--cold 0|1]
//          [--shadow 1024|2048] [--url <a served bench page>] [--port N] [--out results.json] [--timeout 170]
//          [--shot still.png]
//   --url        a page served elsewhere (vite preview of dist/, the live site); else a private Vite
//                dev server of this checkout (tools/vite-server.mjs) on --port or a free port
//   --timestamps 0 times by submit-to-onSubmittedWorkDone, as on a browser without timestamp-query
//                (the page then adds the shadow-free msaa-1-ns and taau-1-ns runs for its verdict)
//   --pace free  frames back to back instead of one per animation frame
//   --shot       saves the page's still of the scene (an MSAA frame it draws after the runs)
import { writeFileSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const [W, H] = opt('size', '320x200').split('x').map(Number);
const TIMEOUT = Number(opt('timeout', 170)) * 1000;
const query = new URLSearchParams({
  auto: '1', scene: opt('scene', 'lab'), frames: opt('frames', '12'), warmup: opt('warmup', '3'),
  res: opt('res', 'device'), cold: opt('cold', '1'), shadow: opt('shadow', '1024'),
});
for (const k of ['only', 'timestamps', 'pace']) if (opt(k, null) != null) query.set(k, opt(k));

const vite = opt('url', null) ? null : await startVite({ harness: true });
const base = opt('url', null) ?? vite.url('/bench/raster.html');
const url = `${base}${base.includes('?') ? '&' : '?'}${query}`;
const t0 = Date.now();
let failed = false;
const noVerdict = [];
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${String(e.stack || e).slice(0, 500)}`));
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU/.test(m.text()))) pageErrors.push(`${m.type()}: ${m.text().slice(0, 500)}`); });
  console.log(`raster bench: ${url}`);
  await page.goto(url);
  let last = '';
  const deadline = Date.now() + TIMEOUT;
  for (;;) {
    const s = await page.evaluate(() => ({ state: window.__bench?.state, status: document.getElementById('status')?.textContent }));
    if (s.status && s.status !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s  ${s.status}`); last = s.status; }
    if (s.state === 'done' || s.state === 'error') break;
    if (Date.now() > deadline) throw new Error(`the page did not finish within ${TIMEOUT / 1000} s (state ${s.state})`);
    await page.waitForTimeout(500);
  }
  const bench = await page.evaluate(() => ({ state: window.__bench.state, error: window.__bench.error, result: window.__bench.result }));
  const r = bench.result;
  const fallback = r.device?.adapter?.isFallbackAdapter;
  const label = fallback ? 'SwiftShader or another software adapter: these numbers are NOT representative of any real GPU' : 'a hardware adapter';
  console.log(`\nadapter: ${JSON.stringify(r.device?.adapter)} (${label})`);
  console.log(`timestamps: ${r.device?.timestampQuery}; transient attachments: ${r.device?.transientAttachments}; rAF ${r.device?.raf?.hz} Hz`);
  if (r.compile) console.log(`compile${r.compile.cold ? ' (cold)' : ''}: ${r.compile.pipelines.map((p) => `${p.name} ${p.ms}`).join(', ')} ms; pipelines ${r.compile.totalMs} ms`);
  for (const sc of r.scenes ?? []) {
    console.log(`${sc.name}: ${sc.bytes} bytes; faces ${sc.faces.opaque}/${sc.faces.liquid}/${sc.faces.glass} in ${sc.faces.extractMs} ms (${sc.faces.match ? 'as baked' : 'NOT as baked'}); light fill ${sc.lightFill?.gpuMs ?? '–'} ms GPU, ${sc.lightFill?.wallMs} ms wall`);
    for (const res of sc.resolutions ?? []) {
      for (const x of res.runs) {
        if (x.error) { console.log(`  ${res.label} ${res.pixels.join('x')} ${x.config}: ${x.error}`); continue; }
        const passes = Object.entries(x.gpuMs?.passes ?? {}).map(([p, s]) => `${p} ${s?.median}`).join(', ');
        console.log(`  ${res.label} ${res.pixels.join('x')} ${x.config}: ${x.frames} frames, GPU ${x.gpuMs?.frame?.median ?? '–'} ms, without the shadow ${x.gpuMs?.afterShadow?.median ?? '–'} ms (${passes || 'no timestamps'})${x.timestampProblem && x.gpuMs ? ` [timestamps refused: ${x.timestampProblem}]` : ''}, submit→done ${x.submitToDoneMs?.median} ms, CPU ${x.cpuEncodeMs?.median} ms`);
      }
      const v = res.verdict;
      const tag = fallback ? ' [SwiftShader, not representative]' : '';
      if (v?.choice) {
        console.log(`  ${res.label}: ${v.choice} on ${v.basis} (MSAA ${v.msaaMs} / TAAU ${v.taauMs} = ${v.ratio}); whole frame ${v.wholeFrame.msaaMs} / ${v.wholeFrame.taauMs} = ${v.wholeFrame.ratio}; ${v.method}${v.timestampsRefused ? `; timestamps refused: ${v.timestampsRefused}` : ''}${tag}`);
      } else if (res.runs.some((x) => x.config === 'msaa-1' && !x.error) && res.runs.some((x) => x.config === 'taau-1' && !x.error)) {
        noVerdict.push(`${sc.name} ${res.label}: no verdict (${v?.noVerdict ?? 'none'})`);
      }
    }
  }
  if (opt('shot', null)) { await page.locator('#view').screenshot({ path: opt('shot') }); console.log(`still: ${opt('shot')}`); }
  const json = JSON.stringify(r, null, 1);
  if (opt('out', null)) { writeFileSync(opt('out'), json); console.log(`\nJSON: ${opt('out')}`); } else console.log(`\n${json}`);
  const problems = [...(r.errors ?? []), ...pageErrors, ...noVerdict];
  if (bench.state !== 'done' || problems.length) {
    failed = true;
    console.log(`\nFAIL: the page reported ${bench.state === 'error' ? 'an error' : 'problems'}:\n  ${[bench.error, ...problems].filter(Boolean).join('\n  ')}`);
  } else console.log(`\nraster bench: ok (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} catch (e) {
  failed = true;
  console.log(`FAIL: ${e.stack || e}`);
} finally {
  await browser.close();
  await vite?.close();
}
process.exit(failed ? 1 : 0);
