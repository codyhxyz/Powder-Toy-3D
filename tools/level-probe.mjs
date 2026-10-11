// How fast a dropped slab of water levels out: a 16×6×16 slab dropped from
// 2 cells up onto the Lab's floor (128³), its tallest column and wet area read
// back every LEVEL_EVERY steps, and the steps until its tallest column is
// down to 3, 2 and 1 cells. usage: node tools/level-probe.mjs [--port 5287]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const pi = process.argv.indexOf('--port');
const port = pi > 0 ? process.argv[pi + 1] : '5287';
const LEVEL_EVERY = 20, LEVEL_MAX_STEPS = 2000;
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
  console.log(await p.evaluate(async ([EVERY, MAX]) => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E, ELEMENTS } = await import('/src/elements.js');
    a.test.park();
    const [A, B] = sim.blankState();
    for (let y = 2; y < 8; y++) for (let z = 56; z < 72; z++) for (let x = 56; x < 72; x++) {
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = E.WATER; A[i + 1] = ELEMENTS[E.WATER].temp; A[i + 3] = Math.random() * 0.999;
    }
    sim.load(A, B);
    const at = {}, rows = [];
    for (let s = EVERY; s <= MAX; s += EVERY) {
      a.test.step(EVERY);
      const [S] = sim.readState();
      let top = 0, wet = 0;
      for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        let h = 0;
        for (let y = 0; y < 12; y++) if (Math.round(S[sim.cellTexel(x, y, z) * 4]) === E.WATER) h++;
        if (h) wet++;
        top = Math.max(top, h);
      }
      for (const lv of [3, 2, 1]) if (top <= lv && at[lv] == null) at[lv] = s;
      if (s % 200 === 0) rows.push(`step ${s}: tallest ${top}, wet columns ${wet}`);
      if (top <= 1) break;
    }
    return `${rows.join('\n')}\nsteps until the tallest column is down to 3 / 2 / 1 cells: ${at[3] ?? '>' + MAX} / ${at[2] ?? '>' + MAX} / ${at[1] ?? '>' + MAX}`;
  }, [LEVEL_EVERY, LEVEL_MAX_STEPS]));
} finally {
  await b.close();
}
