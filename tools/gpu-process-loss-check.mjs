// node tools/gpu-process-loss-check.mjs [port=5496]
// Kill this test browser's own GPU process (a real process death, as Chrome's
// GPU watchdog does to a hung GPU: exit 512 in chrome://gpu), not the
// device.destroy() of tools/gpu-failure-check.mjs, and check that it is
// reported as a lost device, never as a broken shader (docs/webgpu.md B9):
//   1. a bare WebGPU page building pipelines when the process dies: the
//      device's `lost` says so (reason 'unknown'), and what the pipelines
//      building then do is recorded (under WebGL the first program linked
//      after the death read LINK_STATUS false with empty logs, and took the
//      blame: gfx/gpuLoss.js's history)
//   2. the app: the error names the lost device, not a shader, and the
//      report (__app.lastGpuFailure) survives a reload with the time since
//      the last frame and the pipelines building then.
//   3. the app's boot, killed while its pipelines build (the cold build that
//      most often gets a GPU process killed): every pipeline then rejects
//      with its own 'GPU shader failed', and the page must still name the
//      lost device, from the first failure.
//   4. the start menu: its warm-up's device (src/preload.js) lost while the
//      menu is up, before any game exists; Start then boots the game on a
//      new device instead of stopping for good.
// Cases 3 and 4 each get a browser of their own: Chrome gives up on a GPU
// process that keeps dying.
// Only this browser's processes are touched (found by walking our own process tree).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const port = process.argv[2] ?? '5496';
const base = `http://localhost:${port}`;

function killOwnGpuProcess() {
  const rows = execSync('ps -eo pid=,ppid=,args=').toString().trim().split('\n').map((l) => {
    const [, pid, ppid, args] = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: +pid, ppid: +ppid, args };
  });
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; }
  }
  const gpu = rows.filter((r) => mine.has(r.pid) && r.args.includes('--type=gpu-process'));
  assert(gpu.length, 'no GPU process of our own to kill (in-process GPU?)');
  for (const g of gpu) process.kill(g.pid, 'SIGKILL');
}

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
// a page's console errors and uncaught errors (the relay the UI asks for quota isn't running here)
function watch(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
// the device app.js boots on, from the page (launch.gpu: null until it asks for one)
const launchGpu = (page) => page.evaluate(async () => {
  const { launch } = await import('/src/launch.js');
  return launch.gpu ? (await launch.gpu).stats.pipelinesPending : -1;
}).catch(() => -1);

const browser = await launchBrowser(launchOpts);
try {
  // 1. the signature, on a bare device
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 64, height: 64 } });
  await page.goto(`${base}/`, { waitUntil: 'commit' });
  await page.setContent('<canvas></canvas>');
  await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    window.seen = [];
    device.lost.then((info) => seen.push({ ev: 'lost', reason: info.reason, message: info.message.slice(0, 200) }));
    device.addEventListener('uncapturederror', (e) => seen.push({ ev: 'error', message: e.error.message.slice(0, 200) }));
    let n = 0;
    // a new pipeline each time, as a cold first use is
    (function build() {
      if (seen.some((s) => s.ev === 'lost')) return;
      n++;
      const module = device.createShaderModule({ code: `@compute @workgroup_size(1) fn main() { _ = ${n}u; }` });
      device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
        .then(() => {}, (e) => seen.push({ ev: 'pipeline', name: e.name, reason: e.reason ?? null, message: String(e.message).slice(0, 200), lostYet: seen.some((s) => s.ev === 'lost') }));
      setTimeout(build, 5);
    })();
  });
  await page.waitForTimeout(500);
  killOwnGpuProcess();
  await page.waitForFunction(() => seen.some((s) => s.ev === 'lost'), null, { timeout: 15000 });
  await page.waitForTimeout(500);   // (what the pipelines in flight do, after the loss)
  const seen = await page.evaluate(() => seen);
  const lost = seen.find((s) => s.ev === 'lost');
  assert.notEqual(lost.reason, 'destroyed', JSON.stringify(lost));
  const early = seen.filter((s) => s.ev === 'pipeline' && !s.lostYet);
  console.log(`PASS: a killed GPU process shows as a lost device (reason '${lost.reason}': ${lost.message.slice(0, 80)})`);
  console.log(`      pipelines rejected before the loss was reported: ${early.length}${early.length ? ` (${early[0].name}: ${early[0].message.slice(0, 80)})` : ''}`);
  await page.close();

  // 2. the app
  const app = await newTestPage(browser, { mode: 'preview', viewport: { width: 320, height: 200 } });
  const errors = [];
  app.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await app.goto(`${base}/?size=64&preset=lab&view=plain`, { waitUntil: 'domcontentloaded' });
  await ready(app);
  await app.waitForFunction(() => __app.sim.frame > 2, null, { timeout: 120000 });
  killOwnGpuProcess();
  await app.waitForFunction(() => document.getElementById('error').textContent.includes('Rendering and simulation stopped'), null, { timeout: 30000 });
  const text = await app.evaluate(() => document.getElementById('error').textContent);
  assert.doesNotMatch(text, /GPU shader failed/, text);
  assert.match(text, /lost the WebGPU device/, text);
  assert(!errors.some((s) => /GPU shader failed/.test(s)), errors.join('\n'));
  const report = await app.evaluate(() => __app.lastGpuFailure);
  assert(report && report.kind === 'deviceLost', JSON.stringify(report));
  assert(Number.isFinite(report.msSinceLastFrame) && Array.isArray(report.pendingPipelines), JSON.stringify(report));
  // the report outlives the page (localStorage), for the bug report after a reload
  await app.reload({ waitUntil: 'domcontentloaded' });
  const kept = await app.evaluate(() => JSON.parse(localStorage.getItem('powder-toy-3d:lastGpuFailure') || 'null'));
  assert.equal(kept?.kind, 'deviceLost');
  console.log(`PASS: the app reports a killed GPU process as a lost device, with what it was waiting on (${report.msSinceLastFrame} ms since the last frame; building: ${report.pendingPipelines.join(', ') || 'none'})`);
} finally {
  await browser.close();
}

// 3. the boot, killed with its pipelines building
{
  const browser = await launchBrowser(launchOpts);
  try {
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
    const errors = watch(page);
    await page.goto(`${base}/?size=64&preset=lab&view=plain`, { waitUntil: 'domcontentloaded' });
    let pending = -1;
    for (const t = Date.now(); (pending = await launchGpu(page)) <= 0;) {
      assert(Date.now() - t < 60000, 'the boot built no pipelines within 60 s');
      await page.waitForTimeout(20);
    }
    killOwnGpuProcess();
    await page.waitForFunction(() => document.getElementById('error').textContent, null, { timeout: 30000 });
    await page.waitForTimeout(1000);   // (every pipeline in flight rejects, and the boot's catch runs)
    const r = await page.evaluate(() => ({
      text: document.getElementById('error').textContent, app: !!window.__app,
      report: JSON.parse(localStorage.getItem('powder-toy-3d:lastGpuFailure') || 'null'),
    }));
    assert(!r.app, 'the boot finished before the kill: no pipelines were building');
    assert.match(r.text, /lost the WebGPU device/, r.text);
    assert.doesNotMatch(r.text, /GPU shader failed/, r.text);
    assert(!errors.some((s) => /GPU shader failed/.test(s)), errors.join('\n'));
    assert(r.report?.kind === 'deviceLost' && r.report.pendingPipelines.length, JSON.stringify(r.report));
    console.log(`PASS: a GPU process killed during the boot (${pending} pipelines building) is reported as a lost device, not as one of them (building then: ${r.report.pendingPipelines.length}, e.g. ${r.report.pendingPipelines.slice(0, 3).join(', ')})`);
  } finally {
    await browser.close();
  }
}

// 4. the menu's device lost before Start
{
  const t0 = Date.now();
  const browser = await launchBrowser(launchOpts);
  try {
    const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 250 } });
    const errors = watch(page);
    // the Lab last played, in the plain view (app.js STORE), as tools/smoke.mjs's warm stage
    const { VIEWS } = await import('../src/views.js');
    await page.addInitScript((v) => {
      try { localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ size: '128', preset: 'lab', view: v, rev: 2 })); } catch { /* storage unavailable */ }
    }, VIEWS.find((v) => v.key === 'plain').id);
    await page.goto(`${base}/`);
    // the warm-up under way: its device made, a few of its pipelines built
    for (const t = Date.now(); !await page.evaluate(async () => ((await import('/src/launch.js')).launch.warm?.built ?? 0) >= 4);) {
      assert(Date.now() - t < 90000, 'the menu warmed nothing within 90 s');
      await page.waitForTimeout(250);
    }
    await page.evaluate(async () => { window.__menuGpu = await (await import('/src/launch.js')).launch.gpu; });
    killOwnGpuProcess();
    await page.waitForFunction(() => window.__menuGpu.lost, null, { timeout: 15000 });
    const dropped = await page.evaluate(async () => (await import('/src/launch.js')).launch.warm === null);
    assert(dropped, 'the warm-up kept its state for a lost device');
    await page.waitForTimeout(1000);   // (the GPU process restarts)
    await page.click('.mm-start');
    await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
    const r = await page.evaluate(async () => {
      const failed = document.getElementById('error')?.textContent || null;
      if (failed) return { failed };
      // (__app exists once the grid's own pipelines are built: a step can be recorded)
      return { failed, fresh: __app.gpu !== window.__menuGpu, lost: __app.gpu.lost, frame: __app.sim.frame, dims: [__app.sim.g.nx, __app.sim.g.ny, __app.sim.g.nz] };
    });
    assert(!r.failed, `Start stopped on the lost menu device: ${r.failed}`);
    assert(r.fresh && !r.lost, JSON.stringify(r));
    // it runs: a step on the new device
    await page.evaluate(async () => { __app.test.step(2); await __app.gpu.fence(); });
    assert.equal(await page.evaluate(() => __app.sim.frame), r.frame + 2);
    assert(!errors.some((s) => /GPU shader failed|Graphics stopped/.test(s)), errors.join('\n'));
    console.log(`PASS: a device lost on the start menu is replaced at Start: the ${r.dims.join('×')} Lab boots on a new device and steps (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } finally {
    await browser.close();
  }
}
