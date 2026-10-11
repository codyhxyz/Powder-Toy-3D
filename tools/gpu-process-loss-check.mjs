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

const browser = await launchBrowser(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
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
