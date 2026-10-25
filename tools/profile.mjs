// THE profiler for agents (docs/profiler.md): one command shows what is wrong
// with performance, from one run. Improve this tool rather than timing around it.
//
//   node tools/profile.mjs --map island [--pose default|landDown|sky|horizon|x,y,z,tx,ty,tz]
//     [--view realistic] [--frames 60] [--warmup 30] [--counters] [--out dir]
//     [--url https://tpt3d.codyh.xyz] [--port N] [--size 1280x800] [--dpr 2]
//     [--autores] [--paused] [--compare old/profile.json] [--knockout N] [--no-cost] [--gpufeatures core|subgroups|f16,…]
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
import { CLEANUP_MS } from './gpu-deadline.mjs';
import { metalTimes, applyMetal, categoryTotals, estimateCauses, causesFor, targetVerdict, compareCauses } from '../src/gfx/profileCauses.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// the whole headless slot (CLAUDE.md), boot to close; the lead's long slot (tools/gpu-deadline.mjs: TPT_LEAD_LONG_SLOT=1, never in agent briefs) for big maps' full boot
export const SLOT_MS = process.env.TPT_LEAD_LONG_SLOT === '1' ? 120000 : 25000;
const BOOT_TIMEOUT_MS = 15000;         // the page's own boot, inside the slot
// the page gives up this long before the slot ends: before the launcher's guard starts closing the
// browser (2 × CLEANUP_MS before the deadline, gpu-deadline.mjs), so a stall is reported and the poses
// already captured still print (at 6 s the guard closed the browser first and the run said nothing)
const PAGE_MARGIN_MS = 2 * CLEANUP_MS + 2000;   // (+ PAGE_ANSWER_MS for the tool: still 1 s before the guard)
const PAGE_ANSWER_MS = 1000;           // ... and the tool this long after the page should have (it says the last stage the page reported)
const SHARED_BUSY_PCT = 25;            // GPU busy % right after our browser closed: someone else was using it
export const POSES = ['default', 'landDown', 'sky', 'horizon'];
const MAX_POSES = 6;
const POSE_MS = 2500;                  // a pose's warmup, settle, timed frames and cost capture, about (Lab, 20 frames)
const BOOT_FRAMES = 600;               // frames xctrace may see before the poses (its recording length only)
// --knockout N: after a pose's timed frames, its N longest passes (timestamps) each have their draws or
// dispatches dropped (gpu/timing.js knockout) for KNOCKOUT_FRAMES frames after KNOCKOUT_WARMUP: the frame
// interval without a pass's work names the pass that holds the frame back when neither the timestamps
// (whole submissions on Apple's tilers) nor Metal's trace (it drops intervals under load) can
// (Descent, 2026-10-25: timestamps put ~100 ms in every render pass, Metal 2 ms in the world march)
const KNOCKOUT_FRAMES = 6;
const KNOCKOUT_WARMUP = 2;
const MAX_KNOCKOUTS = 8;

const HELP = `node tools/profile.mjs --map <key> [--pose ${POSES.join('|')}|x,y,z,tx,ty,tz] [--poses "p1;p2;…"] [--view realistic]
  [--frames 30] [--warmup 10] [--no-counters] [--target ms] [--compare profile.json] [--out dir] [--url URL] [--port N]
  [--size WxH] [--dpr N] [--autores] [--paused] [--shot] [--knockout N] [--no-cost] [--gpufeatures core|LIST] [--allow-battery] [--self-test]`;

export function parseArgs(argv) {
  // Metal's encoder times (tools/gpu-counters.mjs) by default on a Mac: render-pass timestamps on Apple's tilers can
  // span whole submissions, the encoder times don't (docs/profiler.md "Trusted ms")
  const o = { map: 'lab', pose: 'default', poses: null, view: 'realistic', frames: 30, warmup: 10, counters: process.platform === 'darwin', out: null, url: null,
    port: null, size: '1280x800', dpr: 2, autores: false, paused: false, compare: null, target: null, knockout: 0, cost: true, gpufeatures: null, shot: false, allowBattery: false, selfTest: false, help: false };
  const flags = { '--shot': 'shot', '--counters': 'counters', '--autores': 'autores', '--paused': 'paused', '--allow-battery': 'allowBattery', '--self-test': 'selfTest', '--help': 'help' };
  const values = ['map', 'pose', 'poses', 'view', 'frames', 'warmup', 'out', 'url', 'port', 'size', 'dpr', 'compare', 'target', 'knockout', 'gpufeatures'];
  argv = argv.filter((a) => { if (a === '--no-counters') { o.counters = false; return false; } if (a === '--no-cost') { o.cost = false; return false; } return true; });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) { o[flags[a]] = true; continue; }
    const key = a.slice(2);
    if (!a.startsWith('--') || !values.includes(key)) throw new Error(`Unknown option ${a}\n${HELP}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
    o[key] = ['frames', 'warmup', 'port', 'dpr', 'target', 'knockout'].includes(key) ? Number(v) : v;
  }
  if (!Number.isSafeInteger(o.frames) || o.frames < 10 || o.frames > 240) throw new Error('--frames must be 10–240 (the median and spread need 10; the profiler keeps 240)');
  if (!Number.isSafeInteger(o.warmup) || o.warmup < 0 || o.warmup > 240) throw new Error('--warmup must be 0–240');
  if (!(o.dpr > 0 && o.dpr <= 3)) throw new Error('--dpr must be in (0, 3]');
  if (!/^\d+x\d+$/.test(o.size)) throw new Error('--size must be WxH');
  if (o.port !== null && (!Number.isSafeInteger(o.port) || [5173, 8787].includes(o.port))) throw new Error('--port: a private port, not 5173 or 8787');
  if (o.target !== null && !(o.target > 0)) throw new Error('--target: a frame time in ms');
  if (!Number.isSafeInteger(o.knockout) || o.knockout < 0 || o.knockout > MAX_KNOCKOUTS) throw new Error(`--knockout: 0–${MAX_KNOCKOUTS} passes`);
  // --poses "default;landDown;sky;horizon" (';' between: a custom pose has commas): several poses in one run,
  // what the ms-per-cause fit needs (gfx/profileCauses.js estimateCauses)
  o.poseSpecs = (o.poses ? o.poses.split(';').filter(Boolean) : [o.pose]).map(parsePose);
  if (o.poseSpecs.length > MAX_POSES) throw new Error(`--poses: at most ${MAX_POSES} in one slot`);
  o.poseSpec = o.poseSpecs[0];
  o.viewport = { width: Number(o.size.split('x')[0]), height: Number(o.size.split('x')[1]) };
  o.out ??= join(tmpdir(), 'tpt-profile', `${o.map}-${o.poseSpecs.map((p) => p.name).join('+')}`);
  return o;
}

export function parsePose(p) {
  if (POSES.includes(p)) return { name: p };
  const v = p.split(',').map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) throw new Error(`--pose must be ${POSES.join('|')} or x,y,z,tx,ty,tz`);
  return { name: 'custom', eye: v.slice(0, 3), target: v.slice(3) };
}

// Installed in the page (serialized by page.evaluate: everything it uses is inside it) as
// window.__profTool: prepare() once, then pose(i, spec) per pose (timed frames, then the cost
// counters); stop() ends the frame pump. Every stage races the slot's deadline, so a stalled run
// says where and why.
function installInPage({ frames, warmup, autores, paused, deadline, knockout, koFrames, koWarmup, cost: withCost }) {
  const a = window.__app;
  const t0 = performance.now();
  const state = { stage: 'start', stages: [] };
  const why = () => ({ stage: state.stage, at: Math.round(performance.now() - t0), prof: !!a.prof?.on, landed: a.prof?.landed?.length ?? null,
    supported: a.gpu.timing.supported, compiling: a.gpu.timing.pipelines ?? null, cache: { pending: a.gpu.pipelines?.pending?.size, queue: a.gpu.pipelines?.queue?.length, idle: a.gpu.pipelines?.idleQueue?.length },
    // the builds still running, by name and age: which kernels hold a stalled run
    building: [...(a.gpu.pipelines?.active ?? [])].map((j) => `${j.name} ${Math.round(performance.now() - (j.t0 ?? performance.now()))} ms`),
    frameNo: a.gpu.frameNo, asleep: a.loop?.asleep, parked: a.test?.parked, failure: a.gpu.failure?.message ?? null });
  const step = (name, p) => {
    state.stage = name; state.stages.push([name, Math.round(performance.now() - t0)]);
    console.info(`[profile-stage] ${name}`);   // (the tool prints it as it happens: a page that stops answering still said where)
    let timer;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`profile stalled at "${name}": ${JSON.stringify(why())}`)), Math.max(1, deadline - Date.now())); })])
      .finally(() => clearTimeout(timer));
  };
  // Named poses keep the eye where the map put it and turn the view: down at the land, up at the sky, level at the horizon.
  let home = null;
  function applyPose(spec) {
    const cam = a.camera, ctl = a.controls, V = a.THREE.Vector3;
    home ??= { eye: cam.position.clone(), target: ctl.target.clone() };
    cam.position.copy(home.eye); ctl.target.copy(home.target);   // (every pose from the map's own)
    if (spec.name !== 'default') {
      if (a.pov?.active) throw new Error('pose: the first-person body has the camera; poses need the god view');
      const eye = cam.position.clone();
      const dist = Math.max(1e-3, eye.distanceTo(ctl.target));
      const fwd = new V().subVectors(ctl.target, eye); fwd.y = 0;
      if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
      fwd.normalize();
      const LEAN = 0.05;   // (OrbitControls can't look exactly along its up axis)
      if (spec.name === 'custom') { cam.position.fromArray(spec.eye); ctl.target.fromArray(spec.target); }
      else if (spec.name === 'landDown') ctl.target.copy(eye).addScaledVector(fwd, LEAN * dist).add(new V(0, -dist, 0));
      else if (spec.name === 'sky') ctl.target.copy(eye).addScaledVector(fwd, LEAN * dist).add(new V(0, dist, 0));
      else if (spec.name === 'horizon') ctl.target.copy(eye).addScaledVector(fwd, dist);
    }
    ctl.update();
    a.requestRender();
    return { name: spec.name, eye: cam.position.toArray(), target: ctl.target.toArray() };
  }
  let keep = false, readyWaitMs = null;
  const pump = () => { if (!keep) return; a.requestRender(); requestAnimationFrame(pump); };
  const timing = a.gpu.timing;
  window.__profTool = {
    async prepare() {
      await step('test.ready', a.test.ready());
      // the cost view's counted twins, queued to build with the rest (gfx/costView.js prepare): settled waits for them
      if (withCost && typeof a.prof.cost?.prepare === 'function') {
        try { await step('cost.prepare', a.prof.cost.prepare()); } catch (e) { console.warn(`cost view: ${e?.message ?? e}`); }
      }
      await step('pipelines.settled', a.gpu.settled());
      readyWaitMs = Math.round(performance.now() - t0);
      // frozen at the preset's own scale (resolutionScale 1), not wherever adaptation left it, so two runs (a branch,
      // live) draw the same pixels: adaptation would hand a faster build more of them (the report says the scale)
      if (!autores) {
        a.autoRes.enabled = false;
        a.autoRes.scale = 1;
        if (a.post?.settings) a.post.settings.resolutionScale = 1;
      }
      a.settings.paused = !!paused;
      if (!a.prof.on) a.prof.enable(true);
      timing.labelTag = '@-';   // Metal encoders outside a pose's timed frames (gfx/profileCauses.js UNTIMED_TAG)
      keep = true; requestAnimationFrame(pump);   // keep the view rendering every frame: a settled scene draws nothing
      return { readyWaitMs };
    },
    async pose(i, spec) {
      const applied = applyPose(spec);
      if (warmup) await step(`pose ${i} warmup`, a.prof.capture({ frames: warmup }));
      // the pose (a big map's window moving) can start builds: wait them out before timing
      await step(`pose ${i} test.ready`, a.test.ready());
      await step(`pose ${i} pipelines.settled`, a.gpu.settled());
      timing.labelTag = `@${i}`;
      let report;
      try { report = await step(`pose ${i} capture`, a.prof.capture({ frames, extra: { pose: applied, readyWaitMs } })); }
      finally { timing.labelTag = '@-'; }
      // --knockout: the frame without each of the longest passes' work (KNOCKOUT_FRAMES)
      let knocked = null;
      if (knockout) {
        knocked = [];
        const names = report.passes.filter((p) => p.perFrame > 0).sort((x, y) => y.perFrame - x.perFrame).slice(0, knockout).map((p) => p.name);
        try {
          for (const name of names) {
            timing.knockout = new Set([name]);
            await step(`pose ${i} knockout ${name}`, a.prof.capture({ frames: koWarmup }));
            const r = await step(`pose ${i} knockout ${name}`, a.prof.capture({ frames: koFrames }));
            knocked.push({ name, interval: r.frames.interval.median, span: r.frames.span.median });
          }
        } finally { timing.knockout = null; }
        report.knockout = { base: { interval: report.frames.interval.median, span: report.frames.span.median }, passes: knocked };
      }
      // outside the timed frames: agent C's cost view (a variant: shown as work, never as time)
      let cost = null, costError = null;
      if (withCost && typeof a.prof.cost?.capture === 'function') {
        try { cost = await step(`pose ${i} cost.capture`, a.prof.cost.capture()); } catch (e) { costError = String(e?.message ?? e); }
      }
      report.setup.stages = state.stages.slice();
      return { report, cost, costError };
    },
    stop() { keep = false; timing.labelTag = ''; },
  };
  return true;
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
  assert.equal(parseArgs(['--gpufeatures', 'subgroups']).gpufeatures, 'subgroups');
  console.log('PASS: profile.mjs arguments (the report path: node tools/profile-cpu-check.mjs)');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (o.selfTest) { await selfTest(); return; }
  if (onBattery() && !o.allowBattery) throw new Error('On battery: no GPU runs (docs/profiler.md). Plug in, or --allow-battery when the user allows it.');
  const { launchBrowser, newTestPage, gpuInfo, gpuBusyPct, slotDeadlineAt } = await import('./browser.mjs');
  const countersMod = o.counters && existsSync(join(HERE, 'gpu-counters.mjs')) ? await import(pathToFileURL(join(HERE, 'gpu-counters.mjs')).href) : null;
  if (o.counters && !countersMod) console.error('[profile] GPU counters: tools/gpu-counters.mjs is missing; timestamps only');
  let vite = null, browser = null, counters = null, countersDone = null, info, slot = {};
  const runs = [];   // per pose: { report, cost, costError }
  const errors = [], consoleLines = [];
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
    // only these optional shader features (gpu/features.js): `core`, or a list such as `subgroups` (f16 off), to A/B one feature
    if (o.gpufeatures !== null) url.searchParams.set('gpufeatures', o.gpufeatures);
    slot.busyBefore = await gpuBusyPct();
    // the GPU counters need our pass labels to reach Metal (tools/gpu-counters.mjs COUNTER_CHROME_ARGS)
    browser = await launchBrowser({ lifetimeMs: SLOT_MS, args: countersMod?.COUNTER_CHROME_ARGS ?? [] });   // (waits for the slot; the slot starts inside it)
    const t0 = Date.now();
    const page = await newTestPage(browser, { mode: 'visual', viewport: o.viewport, deviceScaleFactor: o.dpr });
    page.on('pageerror', (e) => errors.push(String(e)));
    // exceptions and GPU failures make the capture untrusted; other console errors (a failed fetch) are notes
    const GPU_FAILURE = /GPU validation|Graphics stopped|device (was )?lost|GraphicsFailure/i;
    let lastStage = 'boot';
    const log = (msg) => console.error(`[profile] +${((Date.now() - t0) / 1000).toFixed(1)} s ${msg}`);
    page.on('console', (m) => {
      if (m.type() === 'info' && m.text().startsWith('[profile-stage] ')) { lastStage = m.text().slice(16); log(`stage ${lastStage}`); return; }
      if (!['error', 'warning'].includes(m.type())) return;
      const line = `console.${m.type()}: ${m.text().slice(0, 300)}`;
      (GPU_FAILURE.test(line) ? errors : consoleLines).push(line);
    });
    log(`browser up (${((t0 - (slotDeadlineAt() - SLOT_MS)) / 1000).toFixed(1)} s of the slot gone)`);
    // Metal's encoder times: xctrace takes seconds to attach, so it starts now, beside the boot (whose
    // encoders carry no pose tag and are left out); the poses wait for it only as long as the slot allows
    let countersStarting = null;
    if (countersMod) {
      countersStarting = countersMod.start({ browser, page, outDir: o.out, frames: o.poseSpecs.length * (o.frames + o.warmup) * 2 + BOOT_FRAMES })
        .then((c) => { log('GPU counters recording'); return c; });
      countersStarting.catch((e) => { slot.countersError = String(e?.message ?? e); });
    }
    await page.goto(url.href);
    await page.waitForFunction(() => window.__app?.sim && window.__app?.prof, null, { polling: 100, timeout: BOOT_TIMEOUT_MS });
    log('app booted');
    info = await gpuInfo(page);   // refuses a software adapter on a real-GPU run
    // the page gives up (with where it stalled) before the launcher's own deadline closes it: the
    // slot's, which started before the browser launched (its launch and the boot are in it)
    const deadline = Math.min(t0 + SLOT_MS, slotDeadlineAt() || Infinity) - PAGE_MARGIN_MS;
    // and the tool gives up on a page that stopped answering, saying the last stage it reported
    const answered = async (p) => {
      let silent;
      const unanswered = new Promise((_, reject) => {
        silent = setTimeout(() => reject(new Error(`profile stalled at "${lastStage}": the page did not answer by its deadline (+${((deadline - t0) / 1000).toFixed(1)} s)`)),
          Math.max(1, deadline + PAGE_ANSWER_MS - Date.now()));
      });
      try { return await Promise.race([p, unanswered]); }
      catch (e) { throw new Error(`${e.message.split('\n')[0]}\npage errors/warnings: ${errors.slice(0, 8).join('\n  ') || 'none'}`); }
      finally { clearTimeout(silent); }
    };
    await page.evaluate(installInPage, { frames: o.frames, warmup: o.warmup, autores: o.autores, paused: o.paused, deadline,
      knockout: o.knockout, koFrames: KNOCKOUT_FRAMES, koWarmup: KNOCKOUT_WARMUP, cost: o.cost });
    await answered(page.evaluate(() => window.__profTool.prepare()));
    // Metal's encoder times over the poses' frames only: started after the boot's compiles, each pose's
    // timed frames tagged "@<pose>" in the encoder labels (gpu/timing.js labelTag)
    if (countersStarting) {
      // the poses need about POSE_MS each: wait for xctrace no longer than leaves them that
      const wait = deadline - Date.now() - o.poseSpecs.length * POSE_MS;
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, wait)); });
      try { counters = await Promise.race([countersStarting, late]); } catch { counters = null; } finally { clearTimeout(timer); }
      if (!counters) {
        slot.countersError ??= `xctrace was not recording within the slot (${(Math.max(0, wait) / 1000).toFixed(1)} s left for it)`;
        console.error(`[profile] GPU counters: ${slot.countersError}; timestamps only`);
        countersStarting.then((c) => c.stop()).catch(() => {});   // (it may still start: end it)
      }
    }
    // a pose that stalls ends the poses, not the run: the ones captured still report, and the stall is said
    for (let i = 0; i < o.poseSpecs.length; i++) {
      try {
        runs.push(await answered(page.evaluate(([i, spec]) => window.__profTool.pose(i, spec), [i, o.poseSpecs[i]])));
        // --shot: each pose's frame as the player sees it after its capture (frame-<i>-<pose>.png: a picture pair per pose for an A/B)
        if (o.shot) { mkdirSync(o.out, { recursive: true }); writeFileSync(join(o.out, `frame-${i}-${o.poseSpecs[i].name}.png`), await page.screenshot()); }
      }
      catch (e) {
        if (!runs.length) throw e;
        slot.poseError = `pose ${i} (${o.poseSpecs[i].name}): ${e.message.split('\n')[0]}`;
        console.error(`[profile] ${slot.poseError}`);
        break;
      }
    }
    log('captured');
    // the GPU counters: end the recording now, but parse the trace (10-60 s of CPU) only after the browser
    // has closed, so the GPU slot isn't held during it (tools/gpu-counters.mjs)
    if (counters) { countersDone = counters.stop(); countersDone.catch(() => {}); counters = null; }
    await page.evaluate(() => window.__profTool.stop()).catch(() => {});
    slot.ms = Date.now() - t0;
    emit(o, runs, { url, info, slot, shared: null, gpuCounters: null, errors, consoleLines, pending: !!countersDone });   // (now, inside the slot: closing the browser can take seconds)
  } catch (e) {
    console.error(`[profile] ${e?.message ?? e}`);   // (now: the cleanup below can outlast the slot)
    throw e;
  } finally {
    // the browser first: xctrace's save after SIGINT takes seconds, and the slot is the browser's
    const stopping = counters?.stop?.();
    stopping?.catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
  }
  // the GPU right after our browser closed: busy means someone else (the player) was on it
  slot.busyAfter = await gpuBusyPct();
  let gpuCounters = null;
  if (countersDone) {
    console.error('[profile] parsing the GPU counter trace (after the browser closed)');
    try { gpuCounters = await countersDone; } catch (e) { gpuCounters = { text: `gpu-counters failed: ${e?.message ?? e}` }; }
  }
  // The run was exclusive (gpu-log.mjs TIMING_TOOLS), so whatever is busy now is
  // either a claim that started as the slot ended or nothing registered at all.
  const others = slot.busyAfter >= SHARED_BUSY_PCT ? (await import('./gpu-log.mjs')).gpuBlockers({ exclusive: true }) : [];
  const shared = slot.busyAfter >= SHARED_BUSY_PCT ? `GPU ${slot.busyAfter}% busy right after the capture (${others.length
    ? `registered: ${others.join('; ')}` : 'nothing registered in tools/gpu-log.mjs: the player, or a session that did not claim'})` : null;
  if (shared || gpuCounters) {
    // (the report printed inside the slot lacked these: the final one, in full)
    console.log(`\n---- final report (${[shared && 'the GPU was shared', gpuCounters && 'Metal encoder times and GPU counters'].filter(Boolean).join(', ')}) ----`);
    emit(o, runs, { url, info, slot, shared, gpuCounters, errors, consoleLines });
  } else {
    emit(o, runs, { url, info, slot, shared, gpuCounters, errors, consoleLines, quiet: true });
    console.log(`GPU busy ${slot.busyAfter}% right after the capture: not shared · ${join(o.out, 'profile.json')} updated`);
  }
}

// The report: written and printed as soon as the capture is back, inside the slot (closing the browser
// can take seconds: a report that waited for it could be lost to the slot's deadline), and again with
// what comes after the browser has closed (the GPU's busy share, Metal's encoder times, the GPU counters).
function emit(o, runs, { url, info, slot, shared, gpuCounters, errors, consoleLines, quiet = false, pending = false }) {
  runs = structuredClone(runs);
  const reports = runs.map((run, i) => {
    let r = run.report;
    delete r.text;
    // Metal's per-encoder ms for this pose, as the authoritative pass times (gfx/profileCauses.js)
    if (gpuCounters?.byEncoder) r = applyMetal(r, metalTimes(r, gpuCounters.byEncoder, i));
    else if (pending) r.notes.push('Metal encoder times follow in the final report (the trace is parsed after the browser closes)');
    else if (o.counters) r.notes.push(`no Metal encoder times (${slot.countersError ?? gpuCounters?.text ?? 'counters off'}): pass ms are timestamps`);
    if (slot.poseError) r.notes.push(`poses cut short: ${slot.poseError}`);
    r = annotate(r, { cost: run.cost, gpuCounters: i === 0 ? gpuCounters && { text: gpuCounters.text, summary: gpuCounters.summary } : null, gpuShared: shared });
    Object.assign(r.setup, { url: url.href.replace(/\?.*/, ''), viewport: o.viewport, dpr: o.dpr, slot,
      adapter: info && { vendor: info.vendor, architecture: info.architecture, description: info.description },
      pageErrors: errors, costError: run.costError ?? null });
    if (errors.length) { r.untrusted.push(`page errors: ${errors.slice(0, 3).join(' | ')}`); r.trusted = false; }
    if (consoleLines.length) r.notes.push(`console (not timing): ${[...new Set(consoleLines)].slice(0, 3).join(' | ')}`);
    return r;
  });
  // ms per cause: the fit over every (pose, pass) the run measured, then each pose's split
  const totals = runs.map((run) => (run.cost && run.cost.trusted !== false ? categoryTotals(run.cost) : []));
  const observations = reports.flatMap((r, i) => totals[i].map((t) => ({ pose: i, pass: t.pass, sums: t.sums,
    // trusted ms only: Metal's, or timestamps from a trusted report (never a fit on times the report distrusts)
    ms: r.timeSource === 'metal' ? r.passes.find((p) => p.name === t.pass)?.ms ?? null : r.trusted ? r.passes.find((p) => p.name === t.pass)?.perFrame ?? null : null })));
  let fit = totals.some((t) => t.length) ? estimateCauses(observations) : null;
  if (fit && !fit.ok && !observations.some((x) => Number.isFinite(x.ms)))
    fit = { ...fit, why: `no trusted pass time for the counted passes (${reports.map((r) => r.timeSource ?? 'timestamps').join(', ')}; ${reports[0].untrusted[0] ?? 'no Metal encoder times'})` };
  reports.forEach((r, i) => {
    if (!totals[i].length && !fit) return;
    const frameMs = r.frames.metalMs ?? r.frames.span.median ?? r.frames.gpu.median;
    const counted = new Set(totals[i].map((t) => t.pass));
    const passMs = (p) => p.ms ?? p.perFrame ?? 0;
    const covered = runs[i].cost?.covered ?? null, pixels = runs[i].cost?.pixels ?? null;
    r.causes = { fit, rows: causesFor(fit, totals[i]) ?? [], totals: totals[i],
      coverage: { passes: [...counted], countedMs: r.passes.filter((p) => counted.has(p.name)).reduce((s, p) => s + passMs(p), 0), frameMs,
        pixelShare: covered !== null && pixels ? covered / pixels : null,
        uncounted: r.passes.filter((p) => !counted.has(p.name) && passMs(p) > 0).map((p) => ({ name: p.name, ms: passMs(p) })).slice(0, 8) } };
    if (r.timeSource !== 'metal' && !r.trusted && fit?.ok) r.notes.push('ms per cause was fitted on untrusted timestamps: re-run where Metal encoder times are available');
  });
  // the target: --target, or the compare file's frame ms
  const old = o.compare ? JSON.parse(readFileSync(o.compare, 'utf8')) : null;
  const oldPrimary = old?.reports ? old.reports[0] : old;
  const frameOf = (r) => r.frames.metalMs ?? r.frames.span?.median ?? r.frames.gpu?.median ?? null;
  const target = o.target ?? (oldPrimary ? frameOf(oldPrimary) : null);
  const main0 = reports[0];
  let cmp = null, cmpCauses = null;
  if (oldPrimary) { cmp = compareReports(oldPrimary, main0); cmpCauses = compareCauses(oldPrimary, main0); }
  if (target !== null) {
    const items = cmpCauses?.rows.some((x) => x.delta !== null)
      ? cmpCauses.rows.filter((x) => x.b !== null).map((x) => ({ name: `${x.pass} · ${x.category}`, ms: x.b, delta: x.delta }))
      : main0.causes?.rows.length ? main0.causes.rows.map((x) => ({ name: `${x.pass} · ${x.category}`, ms: x.ms }))
        : cmp ? cmp.passes.filter((p) => p.b !== null).map((p) => ({ name: p.name, ms: p.b, delta: p.delta }))
          : main0.passes.map((p) => ({ name: p.name, ms: p.ms ?? p.perFrame ?? 0 }));
    main0.target = targetVerdict(frameOf(main0), target, items, { source: o.target !== null ? 'target' : `in ${o.compare}` });
    if (main0.target) main0.verdict.unshift(main0.target.line);
  }
  mkdirSync(o.out, { recursive: true });
  let heatmap = null;
  const img = runs[0]?.cost?.image;
  if (img?.startsWith('data:image/')) { writeFileSync(join(o.out, 'cost.png'), Buffer.from(img.split(',')[1], 'base64')); heatmap = img; }
  writeFileSync(join(o.out, 'profile.json'), JSON.stringify(reports.length > 1 ? { ...main0, reports } : main0, null, 1));
  writeFileSync(join(o.out, 'profile.html'), reportHtml(main0, { heatmap, title: `Profile: ${o.map} / ${o.poseSpec.name}` }));
  let text = formatReport(main0);
  for (const [i, r] of reports.entries()) {
    const k = r.knockout;
    if (!k) continue;
    text += `\n\nknockout (pose ${i}: each pass's draws or dispatches dropped for ${KNOCKOUT_FRAMES} frames; the picture is wrong meanwhile, the frame says what the pass costs):`
      + `\n  ${'(none)'.padEnd(40)} interval ${k.base.interval?.toFixed(2)} ms · GPU span ${k.base.span?.toFixed(2)} ms`
      + k.passes.map((p) => `\n  ${p.name.padEnd(40)} interval ${p.interval?.toFixed(2)} ms (${(p.interval - k.base.interval >= 0 ? '+' : '') + (p.interval - k.base.interval).toFixed(2)}) · GPU span ${p.span?.toFixed(2)} ms (${(p.span - k.base.span >= 0 ? '+' : '') + (p.span - k.base.span).toFixed(2)})`).join('');
  }
  if (reports.length > 1) {
    text += '\n\nposes (Metal ms when present, else timestamps):';
    reports.forEach((r, i) => { const top = r.passes.slice(0, 3).map((p) => `${p.name} ${(p.ms ?? p.perFrame ?? 0).toFixed(2)}`).join(', ');
      text += `\n  ${i} ${o.poseSpecs[i].name.padEnd(9)} frame ${(frameOf(r) ?? NaN).toFixed(2)} ms · ${r.trusted ? 'trusted' : 'UNTRUSTED'} · ${top}`; });
  }
  if (cmp) {
    text += `\n\ncompare with ${o.compare}: ${cmp.comparable ? 'comparable' : `NOT comparable (${cmp.why.join('; ')})`}`
      + `\n  frame ${frameOf(oldPrimary)?.toFixed(2)} → ${frameOf(main0)?.toFixed(2)} ms · interval ${cmp.interval.a?.toFixed(2)} → ${cmp.interval.b?.toFixed(2)} ms`
      + cmp.passes.slice(0, 10).map((p) => `\n  ${p.name.padEnd(40)} ${p.a?.toFixed(3) ?? '–'} → ${p.b?.toFixed(3) ?? '–'} (${p.delta === null ? 'new/gone' : (p.delta >= 0 ? '+' : '') + p.delta.toFixed(3)})`).join('');
    if (cmpCauses?.rows.length) {
      text += `\n  by category (ms where both runs have a fit; work per covered pixel always):`;
      for (const x of cmpCauses.rows.slice(0, 12)) text += `\n  ${`${x.pass} · ${x.category}`.padEnd(40)} ${x.a?.toFixed(2) ?? '–'} → ${x.b?.toFixed(2) ?? '–'} ms${x.delta !== null ? ` (${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(2)})` : ''} · work/px ${x.workA?.toFixed(1) ?? '–'} → ${x.workB?.toFixed(1) ?? '–'}`;
      const ca = cmpCauses.coverage.a, cb = cmpCauses.coverage.b;
      if (ca && cb && JSON.stringify(ca.passes) !== JSON.stringify(cb.passes)) text += `\n  NOT the same pixels counted: ${ca.passes.join('+') || 'none'} vs ${cb.passes.join('+') || 'none'} (uncounted ms: ${ca.uncounted.map((u) => u.name).join(', ')} vs ${cb.uncounted.map((u) => u.name).join(', ')})`;
    }
  }
  if (quiet) return;
  console.log(text);
  console.log(`\nslot ${slot.ms} ms (GPU busy ${slot.busyBefore}% before, ${slot.busyAfter == null ? 'after: measured once the browser has closed' : `${slot.busyAfter}% after`}) · wrote ${join(o.out, 'profile.json')}, ${join(o.out, 'profile.html')}${heatmap ? `, ${join(o.out, 'cost.png')}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.stack ?? e); process.exitCode = 1; });
}
