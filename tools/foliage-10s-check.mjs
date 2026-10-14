// One user-approved attempt, capped below ten seconds INCLUDING browser startup.
// CPU server preparation happens first. No retries and no background GPU work.
// node tools/foliage-10s-check.mjs /path/to/baseline
import { fork, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (process.argv.includes('--guard')) {
  let timer, browserPid;
  process.on('message', m => {
    if (m.pid) browserPid = m.pid;
    if (m.deadline) timer = setTimeout(() => {
      if (browserPid) {
        // Only this run's Chromium tree, never another session's browser.
        const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
          .trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
        const owned = new Set([browserPid]);
        for (let n = -1; n !== owned.size;) {
          n = owned.size;
          for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
        }
        for (const pid of [...owned].reverse()) try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      process.exit(0);
    }, Math.max(0, m.deadline - Date.now()));
    if (m.done) { clearTimeout(timer); process.exit(0); }
  });
} else {
  const baseline = process.argv[2];
  if (!baseline) throw new Error('Supply a baseline checkout');
  // Fail promptly if the shared GPU slot or player gate is busy. Never bypass it.
  process.env.TPT_GPU_WAIT_MS = '1';
  const { launchBrowser, newTestPage, ready, gpuInfo } = await import('./browser.mjs');
  const { startVite } = await import('./vite-server.mjs');
  const { startVite: startBefore } = await import(pathToFileURL(resolve(baseline, 'tools/vite-server.mjs')));
  const servers = [], report = { limitMs: 10000, samples: [], errors: [], stages: [] };
  let browser, guard, timer, started;
  const stage = text => { report.stages.push({ text, ms: Date.now() - started }); console.log(text); };
  try {
    servers.push(await startVite({ port: 58643, harness: true }));
    servers.push(await startBefore({ port: 58644, harness: true }));
    // CPU-only transform preparation, before any browser exists.
    for (const s of servers) {
      await Promise.all(['/', '/src/app.js', '/src/world/gpu.js', '/src/constructions/builtins.js',
        '/src/constructions/runtime.js'].map(p => fetch(s.url(p)).then(r => r.text())));
    }
    started = Date.now();
    guard = fork(new URL(import.meta.url), ['--guard'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    guard.send({ deadline: started + 9500 });
    timer = setTimeout(() => { report.capped = true; void browser?.close(); }, 8500);
    browser = await launchBrowser({
      lifetimeMs: 9500, timeout: 6000,
      browserLog(line) {
        const m = /<launched> pid=(\d+)/.exec(line);
        if (m && guard.connected) guard.send({ pid: Number(m[1]) });
      },
    });
    browser.once('disconnected', () => { report.browserClosedMs = Date.now() - started; });
    if (report.capped) throw new Error('Startup exhausted the limit');
    // New build first: even an incomplete attempt can expose a shader error.
    for (const [i, label] of ['after', 'before'].entries()) {
      stage(`${label}: boot`);
      const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 1280, height: 800 } });
      page.on('pageerror', e => report.errors.push(`${label}: ${e.message}`));
      page.on('console', m => {
        if (/error|warning/.test(m.type()) && /GPU|shader|validation/i.test(m.text())) report.errors.push(`${label}: ${m.text()}`);
      });
      await page.goto(servers[i].url('/?size=128&preset=empty&view=realistic&paused=1&test=visual'), { waitUntil: 'domcontentloaded' });
      await ready(page);
      stage(`${label}: app ready`);
      report.adapter ??= await gpuInfo(page);
      await page.evaluate(async () => {
        const a = window.__app;
        a.test.park();
        await a.test.ready();
        const [{ runGenerator, bake }, { BUILTINS }, { stamperFor }] = await Promise.all([
          import('/src/constructions/runtime.js'), import('/src/constructions/builtins.js'), import('/src/world/gpu.js'),
        ]);
        const s = bake(runGenerator(BUILTINS.TREE, { size: 6, seed: 12345, variant: 'oak' }), 0);
        const stamper = stamperFor(a.sim);
        await stamper.ready;
        stamper.stamp([{ s, at: [64 - s.base.x, 2, 64 - s.base.z], seed: 12345 }]);
        a.autoRes.enabled = false;
        a.test.resetView();
        await a.test.render();
      });
      stage(`${label}: tree rendered`);
      const sample = await page.evaluate(async () => {
        const a = window.__app, ms = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await a.test.renderOnce();
          ms.push(performance.now() - start);
        }
        return { ms, volumeDrawn: a.view.volumeDrawn };
      });
      report.samples.push({ label, ...sample });
      await page.close();
    }
  } catch (e) {
    report.stopped = String(e.message);
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    if (guard?.connected) guard.send({ done: true });
    await Promise.all(servers.map(s => s.close()));
    writeFileSync('/tmp/tpt-foliage-10s-result.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
