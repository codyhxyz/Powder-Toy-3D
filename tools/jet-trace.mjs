// Debug companion of tools/jet-check.mjs: the same tank, and a trace of the
// water around its hole, step by step (cells and velocities), to see what a
// parcel does on its way out. usage: node tools/jet-trace.mjs [--port 5287] [--warm 240] [--steps 16]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5287');
const WARM = +opt('warm', '240'), STEPS = +opt('steps', '16');
const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 480, height: 320 } });
  await p.routeWebSocket(/.*/, () => {});
  await p.addInitScript(() => {
    let s = 12345;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  await p.goto(`http://localhost:${port}/?size=128&preset=empty&paused=1`);
  await ready(p);
  const out = await p.evaluate(async ([WARM, STEPS]) => {
    const a = window.__app, sim = a.sim;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    a.test.park();
    const [A, B] = sim.blankState();
    const box = (x0, y0, z0, x1, y1, z1, id, ctype = 0) => {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = ctype + Math.random() * SEED_MAX;
      }
    };
    box(24, 0, 56, 40, 46, 72, E.WALL);
    box(25, 1, 57, 39, 44, 71, E.WATER);
    box(25, 44, 57, 39, 45, 71, E.CLONE, E.WATER);
    box(39, 30, 64, 40, 31, 65, E.EMPTY);
    sim.load(A, B);
    a.test.step(WARM);
    const lines = [];
    for (let s = 0; s < STEPS; s++) {
      a.test.step(1);
      const cells = [];
      for (let y = 31; y >= 4; y--) for (let x = 39; x <= 95; x++) for (const z of [64]) {
        const [ca, cb] = sim.readCell(x, y, z);
        if (Math.round(ca[0]) === E.WATER) cells.push(`${x},${y}: ${cb[1].toFixed(2)}`);
      }
      lines.push(`step ${sim.frame}: ${cells.join('  ')}`);
    }
    return lines.join('\n');
  }, [WARM, STEPS]);
  console.log(out);
} finally {
  await b.close();
}
