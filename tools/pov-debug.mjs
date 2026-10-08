// scratch: run one scene and log per-frame body state
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`http://localhost:5192/?preset=empty`);
await page.waitForFunction(() => window.__app?.sim);
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const { createPlayer } = await import('/src/pov/player.js');
  const { ELEMENTS, E } = await import('/src/elements.js');
  const a = window.__app, sim = a.sim, g = sim.g;
  const [A, B] = sim.blankState();
  const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
  const box = (x0, y0, z0, x1, y1, z1, id) => { for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) { const i = idx(x, y, z); A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; } };
  
  sim.load(A, B);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 30; i++) await frame();
  let t0 = performance.now(); const ft = [];
  for (let i = 0; i < 60; i++) { await frame(); const n = performance.now(); ft.push(n - t0); t0 = n; }
  const base = 'no player: mean ' + (ft.reduce((a, b) => a + b) / 60).toFixed(1) + ' max ' + Math.max(...ft).toFixed(0);
  const p = createPlayer({ renderer: a.renderer, getSim: () => sim });
  p.spawn({ x: 64, y: 40, z: 64 });
  const log = [];
  let last = performance.now();
  for (let i = 0; i < 60; i++) {
    await frame();
    const now = performance.now();
    p.update((now - last) / 1000, {});
    log.push(`${(now - last).toFixed(0)}ms y=${p.pos.y.toFixed(2)} vy=${p.vel.y.toFixed(1)} sub=${p.submerged.toFixed(2)} g=${p.onGround} T=${p.skinT.toFixed(0)} rate=${p.stepRate.toFixed(0)} dbg=${JSON.stringify(p._dbg?.())}`);
    last = now;
  }
  return [base, ...log];
});
console.log(r.join('\n'));
await b.close();
