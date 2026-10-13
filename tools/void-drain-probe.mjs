// Where the water of elements-gpu-check's "void drains water" scene goes: a
// 20×10×20 slab dropped onto a 40×40 VOID floor, counted every 50 steps, on
// the void's footprint and off it (on the box's floor, where nothing drains).
// usage: node tools/void-drain-probe.mjs [--port 5418]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const pi = process.argv.indexOf('--port');
const port = pi > 0 ? process.argv[pi + 1] : '5418';
const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 480, height: 320 } });
  await p.routeWebSocket(/.*/, () => {});
  await p.goto(`http://localhost:${port}/?size=128&preset=empty&paused=1`);
  await ready(p);
  console.log(await p.evaluate(async () => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E, ELEMENTS } = await import('/src/elements.js');
    a.test.park();
    await a.test.ready();   // (load and step need the grid's pipelines)
    const [A, B] = sim.blankState();
    const box = (x0, y0, z0, x1, y1, z1, id) => {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = Math.random() * 0.999;
      }
    };
    box(40, 0, 40, 80, 1, 80, E.VOID); box(50, 10, 50, 70, 20, 70, E.WATER);
    sim.load(A, B);
    const rows = [];
    for (let s = 0; s <= 400; s += 50) {
      if (s) a.test.step(50);
      const [S] = await sim.readState();
      let on = 0, off = 0, top = 0;
      for (let y = 0; y < 24; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        if (Math.round(S[sim.cellTexel(x, y, z) * 4]) !== E.WATER) continue;
        if (x >= 40 && x < 80 && z >= 40 && z < 80) on++; else off++;
        top = Math.max(top, y);
      }
      rows.push(`step ${s}: on the void ${on}, off it ${off}, top y ${top}`);
    }
    return rows.join('\n');
  }));
} finally {
  await b.close();
}
