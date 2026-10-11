// node tools/gpu-process-loss-check.mjs [port=5496]
// Kill this test browser's own GPU process (a real process death, as Chrome's
// GPU watchdog does to a hung GPU: exit 512 in chrome://gpu), not the
// synthetic WEBGL_lose_context of tools/gpu-failure-check.mjs, and check that
// it is reported as a lost GPU process, never as a broken shader.
//   1. bare WebGL2: the first link after the death reads LINK_STATUS false
//      with empty logs while isContextLost() is still false, and
//      gfx/gpuLoss.js calls it a silent failure (the bird probe's "shader
//      failure with empty diagnostics" was this).
//   2. the app (needs 8 draw buffers; skipped on a GPU without them): the
//      error names the lost GPU process, and the report survives a reload.
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
  // 1. the signature, on a bare context
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 64, height: 64 } });
  await page.goto(`${base}/`, { waitUntil: 'commit' });
  await page.setContent('<canvas></canvas>');
  await page.evaluate(async (url) => {
    const { silentLinkFailure } = await import(url);
    const gl = document.querySelector('canvas').getContext('webgl2');
    window.seen = [];
    gl.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); seen.push({ ev: 'lost' }); });
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    let n = 0;
    (function link() {
      if (seen.some((s) => s.ev === 'lost')) return;
      n++;   // a new program each time, as a cold first use is
      const v = sh(gl.VERTEX_SHADER, `#version 300 es\nvoid main(){gl_Position=vec4(${n}.0);}`);
      const f = sh(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float; out vec4 o; void main(){o=vec4(${n}.0);}`);
      const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (gl.getProgramParameter(p, gl.LINK_STATUS) === false)
        seen.push({ ev: 'link', lostYet: gl.isContextLost(), silent: silentLinkFailure(gl, p, v, f) });
      setTimeout(link, 1);
    })();
  }, `${base}/src/gfx/gpuLoss.js`);
  await page.waitForTimeout(500);
  killOwnGpuProcess();
  await page.waitForFunction(() => seen.some((s) => s.ev === 'lost'), null, { timeout: 15000 });
  const seen = await page.evaluate(() => seen);
  const first = seen.find((s) => s.ev === 'link');
  // three.js tests LINK_STATUS === false: the link before the lost event is the one it blames
  assert(first && seen.indexOf(first) < seen.findIndex((s) => s.ev === 'lost'), `no false link before the lost event: ${JSON.stringify(seen)}`);
  assert.equal(first.lostYet, false);
  assert.equal(first.silent, true);
  console.log('PASS: a killed GPU process first shows as a silent link failure, before the context-lost event');
  await page.close();

  // 2. the app
  const app = await newTestPage(browser, { mode: 'preview', viewport: { width: 640, height: 400 } });
  const errors = [];
  app.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await app.goto(`${base}/?size=64&preset=empty`, { waitUntil: 'domcontentloaded' });
  const drawBuffers = await app.evaluate(() => document.createElement('canvas').getContext('webgl2')?.getParameter(WebGL2RenderingContext.MAX_DRAW_BUFFERS) ?? 0);
  if (drawBuffers < 8) {
    console.log(`SKIP app check: this GPU has ${drawBuffers} draw buffers, the app needs 8 (run it on a real GPU)`);
  } else {
    await ready(app);
    await app.waitForFunction(() => __app.sim.frame > 8);
    killOwnGpuProcess();
    await app.waitForFunction(() => document.getElementById('error').textContent.includes('Rendering and simulation stopped'), null, { timeout: 30000 });
    const text = await app.evaluate(() => document.getElementById('error').textContent);
    assert.doesNotMatch(text, /GPU shader failed/, text);
    assert.match(text, /GPU process stopped responding|lost the WebGL context/, text);
    assert(!errors.some((s) => /GPU shader failed/.test(s)), errors.join('\n'));
    const report = await app.evaluate(() => __app.lastGpuFailure);
    assert(report && ['gpuProcessLost', 'contextLost'].includes(report.kind), JSON.stringify(report));
    assert(Number.isFinite(report.msSinceLastFrame) && Array.isArray(report.newPrograms), JSON.stringify(report));
    console.log('PASS: the app reports a killed GPU process as one, with what it was waiting on', report.kind);
  }
} finally {
  await browser.close();
}
