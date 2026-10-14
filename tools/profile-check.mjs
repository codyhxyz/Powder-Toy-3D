// Profiler check (src/gfx/profiler.js, Settings → Developer). The profiler reads
// GPU time from timestamp queries in split mode (every dispatch its own pass,
// docs/webgpu.md B8); this runs frames with it off and on and checks:
//   - its samples keep the report's shape (ui/profiler.js reads it): every phase,
//     passes in order with their phase, per-name detail, totals, memory, GPU name;
//   - the passes it attributes are the frame's (by name and phase);
//   - its frame total against a reference: the same frames timed by gpu.timing
//     alone, not split (one compute pass), so the ratio is split mode's own cost;
//   - the frame rate with it off and on.
// Run it on an otherwise idle GPU: other GPU work inflates every number, unevenly.
//
// --harness (the default until the app boots on WebGPU): post's harness page,
// a synthetic scene and post at 400×250 (phases view and post).
// --app: the lab in the app (?preset=lab): the profiler as Settings → Developer
// turns it on (U8's app.js wires prof.phase and gpu.endFrame as before).
// usage: node tools/profile-check.mjs [--harness | --app] [--port N] [--ms N]
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const APP = args.includes('--app');
const MS = Number(opt('ms', '3000'));       // per mode
let failures = 0;
const check = (ok, line) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`); };
const ms = (v) => (v == null ? '–' : v.toFixed(2));

const vite = await startVite({ harness: !APP });
const browser = await launchBrowser();
try {
  let sample, ref, offFps, onFps, frames;
  if (!APP) {
    const page = await openHarness(browser, vite, '/tools/harness/post.html', { viewport: { width: 400, height: 250 } });
    const info = await gpuInfo(page);
    console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; harness: post at 400×250`);
    const run = (name, arg) => page.evaluate(([n, a]) => window.__harness.run(n, a), [name, arg]);
    const off = await run('profiler', { ms: MS, on: false });
    const on = await run('profiler', { ms: MS, on: true });
    ref = (await run('timing', { split: false })).last;
    sample = on.last;
    offFps = off.fps; onFps = on.fps; frames = on.frames;
    check(/Post/.test(on.panel ?? '') && /taa|View/.test(on.panel ?? ''), `the overlay (ui/profiler.js) shows the sample: ${JSON.stringify((on.panel ?? '').split('\n').slice(0, 3).join(' | '))}`);
    if (!on.supported) console.log('note: no timestamp-query on this device: GPU times are null');
  } else {
    const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 1280, height: 800 } });
    await page.goto(vite.url('/?preset=lab'));
    await page.waitForFunction(() => window.__app?.sim && window.__app?.gpu, null, { polling: 100, timeout: 120000 });
    const info = await gpuInfo(page);
    console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; app: the lab`);
    const r = await page.evaluate(async (MS) => {
      const a = window.__app, gpu = a.gpu;
      a.autoRes.enabled = false;
      const sleep = (t) => new Promise((res) => setTimeout(res, t));
      const rate = async (on) => {
        a.settings.profiler = on;
        await sleep(500);
        const f0 = gpu.frameNo, t0 = performance.now();
        await sleep(MS);
        return (gpu.frameNo - f0) / ((performance.now() - t0) / 1000);
      };
      const offFps = await rate(false);
      const onFps = await rate(true);
      const sample = a.prof.last && JSON.parse(JSON.stringify(a.prof.last));
      a.settings.profiler = false;
      await sleep(200);
      gpu.timing.enabled = true;   // the reference: timestamps, not split
      await sleep(1000);
      const ref = { ...gpu.timing.last };
      gpu.timing.enabled = false;
      return { offFps, onFps, sample, ref };
    }, MS);
    ({ sample, ref, offFps, onFps } = r);
  }

  console.log(`\nframe rate: profiler off ${offFps.toFixed(1)} fps, on ${onFps.toFixed(1)} fps${frames ? ` (${frames} frames)` : ''}`);
  check(Boolean(sample), 'the profiler produced a sample');
  if (sample) {
    const ids = sample.phases.map((p) => p.id).join(',');
    check(ids === 'paint,sim,derived,shadow,gi,view,post,other', `phases in the report's order: ${ids}`);
    const sum = sample.phases.reduce((s, p) => s + (p.gpu ?? 0), 0);
    check(sample.gpu != null && Math.abs(sum - sample.gpu) < 1e-6 && Math.abs(sample.passes.reduce((s, p) => s + p.gpu, 0) - sample.gpu) < 1e-6,
      `the phases and passes add up to the frame: ${ms(sample.gpu)} ms GPU`);
    check(sample.coverage?.complete && sample.coverage.observed === sample.passes.length,
      `${sample.passes.length}/${sample.coverage?.observed} device passes represented, including external renderers`);
    check(sample.coverage.timelineComplete
      ? sample.passes.every(p => Number.isFinite(p.start) && p.start >= 0 && p.start + p.gpu <= sample.coverage.spanMs + 1e-6)
      : sample.coverage.spanMs === null && sample.passes.every(p => p.start === null),
    'timestamp intervals fit the GPU span, or inconsistent clocks suppress the timeline');
    if (APP) check(sample.passes.some(p => p.name.startsWith('three:')), 'Three.js passes are timed too');
    check(typeof sample.memory === 'number' && sample.memory > 0 && sample.gpuName && Array.isArray(sample.totals) && sample.totals.length > 0,
      `memory ${(sample.memory / 2 ** 20).toFixed(1)} MB, gpu "${sample.gpuName}", ${sample.totals.length} totals`);
    console.log('\nphase      gpu ms   cpu ms   passes');
    for (const p of sample.phases) {
      console.log(`${p.label.padEnd(9)}${ms(p.gpu).padStart(8)} ${ms(p.cpu).padStart(8)}   ${p.detail.map((d) => `${d.name}${d.count > 1 ? `×${d.count}` : ''} ${ms(d.gpu)}`).join(', ')}`);
    }
    if (!APP) {
      const post = sample.phases.find((p) => p.id === 'post'), view = sample.phases.find((p) => p.id === 'view');
      const names = post.detail.map((d) => `${d.name}${d.count > 1 ? `×${d.count}` : ''}`).join(' ');
      check(['prefilter', 'canvas'].every(name => post.detail.some(d => d.name === name))
        && post.detail.some(d => /taa/i.test(d.name)), `post's passes, split: ${names}`);
      check(view.detail.map((d) => d.name).join(' ') === 'scene', 'the scene pass is the view phase');
    }
    const refTotal = Object.values(ref).reduce((s, x) => s + x, 0);
    const ratio = sample.gpu / refTotal;
    console.log(`\nreference (timestamps, not split): ${Object.entries(ref).map(([k, v]) => `${k} ${ms(v)}`).join(', ')}`);
    check(refTotal > 0 && ratio > 0.5 && ratio < 2, `profiler frame ${ms(sample.gpu)} ms vs reference ${ms(refTotal)} ms: ratio ${ratio.toFixed(2)} (split mode's own cost and frame-to-frame noise)`);
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\nprofile-check: ${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
