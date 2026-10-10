// End-to-end moving-camera A/B with the same fixed output and scene scale.
// node tools/lod-frame-bench.mjs beforePort afterPort [rounds=2]
import { chromium } from 'playwright';
const ports = process.argv.slice(2, 4), rounds = +(process.argv[4] ?? 2);
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const results = {};
  for (let round = 0; round < rounds; round++) for (const port of round % 2 ? [...ports].reverse() : ports) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      const raf = requestAnimationFrame;
      let set = false;
      window.requestAnimationFrame = (fn) => raf((t) => {
        if (window.__app && !set) {
          set = true;
          const a = __app;
          a.autoRes.enabled = false; a.autoRes.scale = 1;
          a.renderer.setPixelRatio(1);
          a.settings.upscale = 'quality';
          a.day.fixed = { az: 215, el: 38 };
        }
        fn(t);
      });
    });
    await page.goto(`http://localhost:${port}/?map=island`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__app?.win?.loaded, null, { timeout: 180000 });
    await page.waitForTimeout(16000);
    const sample = await page.evaluate(async () => {
      const a = __app, times = [], start = performance.now(), pos = a.camera.position.clone(), target = a.controls.target.clone();
      let previous = start, versions = a.sim.version;
      await new Promise(resolve => {
        const frame = now => {
          times.push(now - previous); previous = now;
          const angle = 0.015 * Math.sin((now - start) / 1500);
          a.camera.position.copy(pos).sub(target).applyAxisAngle(new a.THREE.Vector3(0, 1, 0), angle).add(target);
          a.camera.lookAt(target); a.camera.updateMatrixWorld();
          if (now - start < 8000) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      const duration = previous - start;
      times.sort((a, b) => a - b);
      return { fps: +(1000 * times.length / duration).toFixed(1),
        medianMs: +times[times.length >> 1].toFixed(1), p95Ms: +times[Math.floor(times.length * .95)].toFixed(1),
        versionChanges: a.sim.version - versions, idle: a.sim.idleCertified ?? false,
        cached: a.win.far.detail?.entries.size ?? 0, canvas: [a.renderer.domElement.width, a.renderer.domElement.height], scale: a.post.renderScale };
    });
    (results[port] ??= []).push(sample);
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
