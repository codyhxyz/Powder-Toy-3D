import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 320 } });
await p.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, res: 0.5, liveTiles: false })));
await p.goto(`http://localhost:5191/?preset=${process.argv[2] || 'lab'}&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(() => {
  const a = window.__app; a.settings.paused = true;
  const gl = a.renderer.getContext(), sim = a.sim;
  const px = new Float32Array(4);
  const sync = () => a.renderer.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, 1, 1, px);
  for (let i = 0; i < 60; i++) sim.step(); sync();
  const out = [];
  for (let k = 0; k < 5; k++) { const t0 = performance.now(); for (let i = 0; i < 100; i++) sim.step(); sync(); out.push((performance.now() - t0) / 100); }
  out.sort((x, y) => x - y);
  return out.map((v) => +v.toFixed(3));
});
console.log(process.argv[2] || 'lab', 'ms/step (sorted 5 runs of 100):', r.join(' '));
await b.close();
