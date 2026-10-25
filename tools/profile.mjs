// THE profiler for agents (docs/profiler.md): one command shows what is wrong
// with performance, from one run. Improve this tool rather than timing around it.
//
//   node tools/profile.mjs --map island [--pose default|landDown|sky|horizon|x,y,z,tx,ty,tz]
//     [--view realistic] [--frames 60] [--warmup 30] [--counters] [--out dir]
//     [--url https://tpt3d.codyh.xyz] [--port N] [--size 1280x800] [--dpr 2]
//     [--autores] [--paused] [--compare old/profile.json]
//   node tools/profile.mjs --self-test     # CPU only: arguments and the report path
//
// What it does, in one 25 s headless GPU slot (tools/browser.mjs):
//   boots the map in ?test=visual (full presentation cadence and quality) with
//   ?profile=1, waits for every pipeline (__app.test.ready, gpu.pipelines.settled),
//   sets the pose, keeps the view rendering (a still scene draws nothing), warms
//   up, then __app.prof.capture({ frames }) over the next N frames the player's
//   own pipeline ran: every pass's GPU time from timestamp queries, CPU per
//   phase, frame interval, compiles in flight, GPU memory. Then, outside the
//   timed frames: agent C's cost counters (__app.prof.cost?.capture()) and,
//   with --counters, agent D's Apple GPU counters (tools/gpu-counters.mjs).
// It prints the ranked text report and writes profile.json, profile.html (a
// self-contained waterfall) and cost.png (C's heatmap, when there is one) to --out.
// Never ad-hoc timing: whatever an agent needs to know goes into the report.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatReport, reportHtml, annotate, compareReports } from '../src/gfx/profileReport.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// the whole headless slot (CLAUDE.md), boot to close; the lead's long slot (tools/gpu-deadline.mjs: TPT_LEAD_LONG_SLOT=1, never in agent briefs) for big maps' full boot
export const SLOT_MS = process.env.TPT_LEAD_LONG_SLOT === '1' ? 120000 : 25000;
const BOOT_TIMEOUT_MS = 15000;         // the page's own boot, inside the slot
const PAGE_MARGIN_MS = 6000;           // the page gives up this long before the slot ends (the launcher's cleanup is 4 s)
const PAGE_ANSWER_MS = 1000;           // ... and the tool this long after the page should have (it says the last stage the page reported)
const SHARED_BUSY_PCT = 25;            // GPU busy % right after our browser closed: someone else was using it
export const POSES = ['default', 'landDown', 'sky', 'horizon'];

const HELP = `node tools/profile.mjs --map <key> [--pose ${POSES.join('|')}|x,y,z,tx,ty,tz] [--view realistic]
  [--frames 60] [--warmup 30] [--counters] [--out dir] [--url URL] [--port N] [--size WxH] [--dpr N]
  [--autores] [--paused] [--compare profile.json] [--allow-battery] [--self-test]`;

export function parseArgs(argv) {
  const o = { map: 'lab', pose: 'default', view: 'realistic', frames: 60, warmup: 30, counters: false, out: null, url: null,
    port: null, size: '1280x800', dpr: 2, autores: false, paused: false, compare: null, allowBattery: false, selfTest: false, help: false };
  const flags = { '--counters': 'counters', '--autores': 'autores', '--paused': 'paused', '--allow-battery': 'allowBattery', '--self-test': 'selfTest', '--help': 'help' };
  const values = ['map', 'pose', 'view', 'frames', 'warmup', 'out', 'url', 'port', 'size', 'dpr', 'compare'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) { o[flags[a]] = true; continue; }
    const key = a.slice(2);
    if (!a.startsWith('--') || !values.includes(key)) throw new Error(`Unknown option ${a}\n${HELP}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
    o[key] = ['frames', 'warmup', 'port', 'dpr'].includes(key) ? Number(v) : v;
  }
  if (!Number.isSafeInteger(o.frames) || o.frames < 10 || o.frames > 240) throw new Error('--frames must be 10–240 (the median and spread need 10; the profiler keeps 240)');
  if (!Number.isSafeInteger(o.warmup) || o.warmup < 0 || o.warmup > 240) throw new Error('--warmup must be 0–240');
  if (!(o.dpr > 0 && o.dpr <= 3)) throw new Error('--dpr must be in (0, 3]');
  if (!/^\d+x\d+$/.test(o.size)) throw new Error('--size must be WxH');
  if (o.port !== null && (!Number.isSafeInteger(o.port) || [5173, 8787].includes(o.port))) throw new Error('--port: a private port, not 5173 or 8787');
  o.poseSpec = parsePose(o.pose);
  o.viewport = { width: Number(o.size.split('x')[0]), height: Number(o.size.split('x')[1]) };
  o.out ??= join(tmpdir(), 'tpt-profile', `${o.map}-${o.poseSpec.name}`);
  return o;
}

export function parsePose(p) {
  if (POSES.includes(p)) return { name: p };
  const v = p.split(',').map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) throw new Error(`--pose must be ${POSES.join('|')} or x,y,z,tx,ty,tz`);
  return { name: 'custom', eye: v.slice(0, 3), target: v.slice(3) };
}

// Runs in the page (serialized by page.evaluate: everything it uses is inside it).
async function captureInPage({ pose, frames, warmup, autores, paused, deadline }) {
  // In the page: the pose, applied to the orbit camera (three units). Named poses keep the
  // eye where the map put it and turn the view: down at the land, up at the sky, level at the horizon.
  function applyPose(spec) {
    const a = window.__app, cam = a.camera, ctl = a.controls, V = a.THREE.Vector3;
    if (spec.name !== 'default') {
      if (a.pov?.active) throw new Error('pose: the first-person body has the camera; poses need the god view');
      const eye = cam.position.clone();
      const dist = Math.max(1e-3, eye.distanceTo(ctl.target));
      const fwd = new V().subVectors(ctl.target, eye); fwd.y = 0;
      if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
      fwd.normalize();
      // (a little forward lean: OrbitControls can't look exactly along its up axis)
      const LEAN = 0.05;
      if (spec.name === 'custom') { cam.position.fromArray(spec.eye); ctl.target.fromArray(spec.target); }
      else if (spec.name === 'landDown') ctl.target.copy(eye).addScaledVector(fwd, LEAN * dist).add(new V(0, -dist, 0));
      else if (spec.name === 'sky') ctl.target.copy(eye).addScaledVector(fwd, LEAN * dist).add(new V(0, dist, 0));
      else if (spec.name === 'horizon') ctl.target.copy(eye).addScaledVector(fwd, dist);
      ctl.update();
    }
    a.requestRender();
    return { name: spec.name, eye: cam.position.toArray(), target: ctl.target.toArray() };
  }
  const a = window.__app;
  const t0 = performance.now();
  // Every stage races the slot's deadline: a stalled run still says where it stalled and why.
  const state = { stage: 'start', stages: [] };
  const why = () => ({ stage: state.stage, at: Math.round(performance.now() - t0), prof: !!a.prof?.on, landed: a.prof?.landed?.length ?? null,
    supported: a.gpu.timing.supported, compiling: a.gpu.timing.pipelines ?? null, cache: { pending: a.gpu.pipelines?.pending?.size, queue: a.gpu.pipelines?.queue?.length, idle: a.gpu.pipelines?.idleQueue?.length },
    frameNo: a.gpu.frameNo, asleep: a.loop?.asleep, parked: a.test?.parked, failure: a.gpu.failure?.message ?? null });
  const step = (name, p) => {
    state.stage = name; state.stages.push([name, Math.round(performance.now() - t0)]);
    console.info(`[profile-stage] ${name}`);   // (the tool prints it as it happens: a page that stops answering still said where)
    let timer;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`profile stalled at "${name}": ${JSON.stringify(why())}`)), Math.max(1, deadline - Date.now())); })])
      .finally(() => clearTimeout(timer));
  };
  await step('test.ready', a.test.ready());
  // the cost view's counted twins, queued to build with the rest (gfx/costView.js prepare): settled waits for them
  if (typeof a.prof.cost?.prepare === 'function') {
    try { await step('cost.prepare', a.prof.cost.prepare()); } catch (e) { console.warn(`cost view: ${e?.message ?? e}`); }
  }
  await step('pipelines.settled', a.gpu.settled());
  const readyWaitMs = performance.now() - t0;   // (page load to here is not in it)
  if (!autores) a.autoRes.enabled = false;   // frozen at the scale it has (the report says so)
  a.settings.paused = !!paused;
  const applied = applyPose(pose);
  // keep the view rendering every frame: a settled scene draws nothing (gfx/pacing.js)
  let keep = true;
  const pump = () => { if (!keep) return; a.requestRender(); requestAnimationFrame(pump); };
  requestAnimationFrame(pump);
  try {
    if (!a.prof.on) a.prof.enable(true);
    if (warmup) await step('warmup', a.prof.capture({ frames: warmup }));
    // the pose (a big map's window moving) can start builds: wait them out before timing
    await step('test.ready (after pose)', a.test.ready());
    await step('pipelines.settled (after pose)', a.gpu.settled());
    const report = await step('capture', a.prof.capture({ frames, extra: { pose: applied, readyWaitMs: Math.round(readyWaitMs) } }));
    report.setup.stages = state.stages;
    keep = false;
    // outside the timed frames: agent C's cost view (a variant: shown as work, never as time)
    let cost = null, costError = null;
    if (typeof a.prof.cost?.capture === 'function') {
      try { cost = await step('cost.capture', a.prof.cost.capture()); } catch (e) { costError = String(e?.message ?? e); }
    }
    return { report, cost, costError };
  } finally { keep = false; }
}

function onBattery() {
  if (process.platform !== 'darwin') return false;
  try { return /Battery Power/.test(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 1000 })); } catch { return false; }
}

async function selfTest() {
  const assert = (await import('node:assert/strict')).default;
  const o = parseArgs(['--map', 'island', '--pose', '1,2,3,4,5,6', '--frames', '30']);
  assert.deepEqual(o.poseSpec, { name: 'custom', eye: [1, 2, 3], target: [4, 5, 6] });
  assert.throws(() => parseArgs(['--frames', '3']));
  assert.throws(() => parseArgs(['--pose', 'upside']));
  assert.throws(() => parseArgs(['--port', '5173']));
  assert.throws(() => parseArgs(['--bogus']));
  console.log('PASS: profile.mjs arguments (the report path: node tools/profile-cpu-check.mjs)');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (o.selfTest) { await selfTest(); return; }
  if (onBattery() && !o.allowBattery) throw new Error('On battery: no GPU runs (docs/profiler.md). Plug in, or --allow-battery when the user allows it.');
  const { launchBrowser, newTestPage, gpuInfo, gpuBusyPct, slotDeadlineAt } = await import('./browser.mjs');
  let vite = null, browser = null, counters = null, countersDone = null, result, info, slot = {};
  const url = new URL(o.url ?? 'http://127.0.0.1/');
  try {
    if (!o.url) {
      const { startVite } = await import('./vite-server.mjs');
      // CPU transforms before the slot (vite-server.mjs): not spent on the GPU's time
      vite = await startVite({ port: o.port ?? undefined, warmupEntries: ['/src/main.js', '/src/app.js'] });
      url.href = vite.url('/');
    }
    url.searchParams.set('map', o.map);
    url.searchParams.set('view', o.view);
    url.searchParams.set('profile', '1');
    slot.busyBefore = await gpuBusyPct();
    // --counters: the GPU counters need our pass labels to reach Metal (tools/gpu-counters.mjs COUNTER_CHROME_ARGS)
    const counterArgs = o.counters && existsSync(join(HERE, 'gpu-counters.mjs'))
      ? (await import(pathToFileURL(join(HERE, 'gpu-counters.mjs')).href)).COUNTER_CHROME_ARGS : [];
    browser = await launchBrowser({ lifetimeMs: SLOT_MS, args: counterArgs });   // (waits for the slot; the slot starts inside it)
    const t0 = Date.now();
    const page = await newTestPage(browser, { mode: 'visual', viewport: o.viewport, deviceScaleFactor: o.dpr });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // exceptions and GPU failures make the capture untrusted; other console errors (a failed fetch) are notes
    const consoleLines = [];
    const GPU_FAILURE = /GPU validation|Graphics stopped|device (was )?lost|GraphicsFailure/i;
    page.on('console', (m) => {
      if (m.type() === 'info' && m.text().startsWith('[profile-stage] ')) { lastStage = m.text().slice(16); log(`stage ${lastStage}`); return; }
      if (!['error', 'warning'].includes(m.type())) return;
      const line = `console.${m.type()}: ${m.text().slice(0, 300)}`;
      (GPU_FAILURE.test(line) ? errors : consoleLines).push(line);
    });
    const log = (msg) => console.error(`[profile] +${((Date.now() - t0) / 1000).toFixed(1)} s ${msg}`);
    let lastStage = 'boot';
    log(`browser up (${((t0 - (slotDeadlineAt() - SLOT_MS)) / 1000).toFixed(1)} s of the slot gone)`);
    await page.goto(url.href);
    await page.waitForFunction(() => window.__app?.sim && window.__app?.prof, null, { polling: 100, timeout: BOOT_TIMEOUT_MS });
    log('app booted');
    info = await gpuInfo(page);   // refuses a software adapter on a real-GPU run
    if (o.counters) {
      const mod = join(HERE, 'gpu-counters.mjs');
      if (existsSync(mod)) counters = await (await import(pathToFileURL(mod).href)).start({ browser, page, outDir: o.out, frames: o.frames });
      else console.error('[profile] --counters: tools/gpu-counters.mjs is not there yet (agent D); skipped');
    }
    // the page gives up (with where it stalled) before the launcher's own deadline closes it: the
    // slot's, which started before the browser launched (its launch and the boot are in it)
    const deadline = Math.min(t0 + SLOT_MS, slotDeadlineAt() || Infinity) - PAGE_MARGIN_MS;
    // and the tool gives up on a page that stopped answering, saying the last stage it reported
    let silent;
    const unanswered = new Promise((_, reject) => {
      silent = setTimeout(() => reject(new Error(`profile stalled at "${lastStage}": the page did not answer by its deadline (+${((deadline - t0) / 1000).toFixed(1)} s)`)),
        Math.max(1, deadline + PAGE_ANSWER_MS - Date.now()));
    });
    try {
      result = await Promise.race([page.evaluate(captureInPage, { pose: o.poseSpec, frames: o.frames, warmup: o.warmup, autores: o.autores, paused: o.paused, deadline }), unanswered]);
    } catch (e) {
      throw new Error(`${e.message.split('\n')[0]}\npage errors/warnings: ${errors.slice(0, 8).join('\n  ') || 'none'}`);
    } finally { clearTimeout(silent); }
    log('captured');
    // the GPU counters: end the recording now, but parse the trace (10-60 s of CPU) only after the browser
    // has closed, so the GPU slot isn't held during it (tools/gpu-counters.mjs)
    if (counters) { countersDone = counters.stop(); countersDone.catch(() => {}); counters = null; }
    result.errors = errors;
    result.console = consoleLines;
    slot.ms = Date.now() - t0;
    emit(o, result, { url, info, slot, shared: null });   // (now, inside the slot: closing the browser can take seconds)
  } finally {
    await counters?.stop?.().catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
  }
  // the GPU right after our browser closed: busy means someone else (the player) was on it
  slot.busyAfter = await gpuBusyPct();
  if (countersDone) {
    console.error('[profile] parsing the GPU counter trace (after the browser closed)');
    try { result.gpuCounters = await countersDone; } catch (e) { result.gpuCounters = { text: `gpu-counters failed: ${e?.message ?? e}` }; }
  }
  const shared = slot.busyAfter >= SHARED_BUSY_PCT ? `GPU ${slot.busyAfter}% busy right after the capture` : null;
  if (shared || result.gpuCounters) {
    // (the report printed inside the slot lacked these: the final one, in full)
    console.log(`\n---- final report (${[shared && 'the GPU was shared', result.gpuCounters && 'GPU counters'].filter(Boolean).join(', ')}) ----`);
    emit(o, result, { url, info, slot, shared });
  } else {
    emit(o, result, { url, info, slot, shared, quiet: true });
    console.log(`GPU busy ${slot.busyAfter}% right after the capture: not shared · ${join(o.out, 'profile.json')} updated`);
  }
}

// The report: written and printed as soon as the capture is back, inside the slot (closing the browser
// can take seconds: a report that waited for it could be lost to the slot's deadline), and again with
// what comes after the browser has closed (the GPU's busy share, the GPU counters).
function emit(o, result, { url, info, slot, shared, quiet = false }) {
  const report = annotate(structuredClone(result.report), { cost: result.cost, gpuCounters: result.gpuCounters, gpuShared: shared });
  Object.assign(report.setup, { url: url.href.replace(/\?.*/, ''), viewport: o.viewport, dpr: o.dpr, slot: { ...slot },
    adapter: info && { vendor: info.vendor, architecture: info.architecture, description: info.description },
    pageErrors: result.errors, costError: result.costError ?? null });
  if (result.errors.length) { report.untrusted.push(`page errors: ${result.errors.slice(0, 3).join(' | ')}`); report.trusted = false; }
  if (result.console?.length) report.notes.push(`console (not timing): ${[...new Set(result.console)].slice(0, 3).join(' | ')}`);
  delete report.text;
  mkdirSync(o.out, { recursive: true });
  let heatmap = null;
  if (result.cost?.image?.startsWith('data:image/')) {
    writeFileSync(join(o.out, 'cost.png'), Buffer.from(result.cost.image.split(',')[1], 'base64'));
    heatmap = result.cost.image;
  }
  writeFileSync(join(o.out, 'profile.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(o.out, 'profile.html'), reportHtml(report, { heatmap, title: `Profile: ${o.map} / ${o.poseSpec.name}` }));
  if (quiet) return;
  let text = formatReport(report);
  if (o.compare) {
    const c = compareReports(JSON.parse(readFileSync(o.compare, 'utf8')), report);
    text += `\n\ncompare with ${o.compare}: ${c.comparable ? 'comparable' : `NOT comparable (${c.why.join('; ')})`}`
      + `\n  GPU sum ${c.gpu.a?.toFixed(2)} → ${c.gpu.b?.toFixed(2)} ms · interval ${c.interval.a?.toFixed(2)} → ${c.interval.b?.toFixed(2)} ms`
      + c.passes.slice(0, 10).map((p) => `\n  ${p.name.padEnd(40)} ${p.a?.toFixed(3) ?? '–'} → ${p.b?.toFixed(3) ?? '–'} (${p.delta === null ? 'new/gone' : (p.delta >= 0 ? '+' : '') + p.delta.toFixed(3)})`).join('');
  }
  console.log(text);
  console.log(`\nslot ${slot.ms} ms (GPU busy ${slot.busyBefore}% before, ${slot.busyAfter == null ? 'after: measured once the browser has closed' : `${slot.busyAfter}% after`}) · wrote ${join(o.out, 'profile.json')}, ${join(o.out, 'profile.html')}${heatmap ? `, ${join(o.out, 'cost.png')}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exitCode = 1; });
}
