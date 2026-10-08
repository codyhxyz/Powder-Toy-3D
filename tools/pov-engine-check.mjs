// Headless GPU checks for hardness and breaking (POV engine work): impact
// breaking, impact heat, blast breaking and mass conservation, on a 64³ grid.
// Each scene is built on the CPU, uploaded with sim.load and stepped by hand.
// usage: node tools/pov-engine-check.mjs [--port 5191] [scene ...]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const port = opt('port', '5191');
const only = args;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 320 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); else if (m.type() === 'log') console.log('  [page]', m.text()); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, res: 0.5, liveTiles: false }));
});
await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

// ---- helpers, installed in the page ----
await p.evaluate(async () => {
  const { E, ELEMENTS } = await import('/src/elements.js');
  const a = window.__app;
  a.settings.paused = true;
  const sim = a.sim;
  const g = sim.g;
  const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
  const t = {
    E, ELEMENTS, g,
    fresh() { [t.A, t.B] = sim.blankState(); },
    set(x, y, z, key, o = {}) {
      const id = E[key], i = idx(x, y, z), e = ELEMENTS[id];
      t.A[i] = id; t.A[i + 1] = o.T ?? e.temp; t.A[i + 2] = o.life ?? e.life; t.A[i + 3] = (o.ctype ?? 0) + (t.A[i + 3] % 1);
      t.B[i] = o.vx ?? 0; t.B[i + 1] = o.vy ?? 0; t.B[i + 2] = o.vz ?? 0; t.B[i + 3] = o.P ?? 0;
    },
    box(x0, x1, y0, y1, z0, z1, key, o) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) t.set(x, y, z, key, o);
    },
    load() { sim.frame = 0; sim.load(t.A, t.B); },
    step(n = 1) { for (let i = 0; i < n; i++) sim.step(); },
    read() {
      const n = g.width * g.height * 4;
      t.rA = new Float32Array(n); t.rB = new Float32Array(n);
      const tgt = sim.targets[sim.cur];
      a.renderer.readRenderTargetPixels(tgt, 0, 0, g.width, g.height, t.rA, undefined, 0);
      a.renderer.readRenderTargetPixels(tgt, 0, 0, g.width, g.height, t.rB, undefined, 1);
    },
    cell(x, y, z) {
      const i = idx(x, y, z);
      return { id: Math.round(t.rA[i]), key: ELEMENTS[Math.round(t.rA[i])].key, T: +t.rA[i + 1].toFixed(1),
        life: +t.rA[i + 2].toFixed(3), v: [t.rB[i], t.rB[i + 1], t.rB[i + 2]].map((v) => +v.toFixed(3)), P: +t.rB[i + 3].toFixed(2) };
    },
    // per-element counts, and the hottest cell of each
    counts() {
      const c = {};
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z), k = ELEMENTS[Math.round(t.rA[i])].key;
        const o = (c[k] ??= { n: 0, Tmax: -1e9 });
        o.n++; o.Tmax = Math.max(o.Tmax, +t.rA[i + 1].toFixed(1));
      }
      delete c.EMPTY;
      return c;
    },
    // every cell of an element (x, y, z, T)
    where(key) {
      const out = [], id = E[key];
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z);
        if (Math.round(t.rA[i]) === id) out.push([x, y, z, +t.rA[i + 1].toFixed(1)]);
      }
      return out;
    },
    maxP(cells) { return Math.max(...cells.map(([x, y, z]) => t.rB[idx(x, y, z) + 3])); },
  };
  window.__t = t;
});

const scenes = {
  // Probe: peak blast pressure in open air at distance d from a gunpowder ball.
  async blastProfile() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      for (const r of [1, 2]) {
        t.fresh();
        t.box(20 - r, 20 + r, 30 - r, 30 + r, 32 - r, 32 + r, 'GUNPOWDER', { T: 250 });
        t.load();
        const peak = {};
        for (let s = 0; s < 40; s++) {
          t.step();
          t.read();
          for (const d of [1, 2, 3, 4, 6, 8, 10, 14, 18]) {
            const x = 20 + r + d;
            peak[d] = Math.max(peak[d] ?? -1e9, t.cell(x, 30, 32).P);
          }
        }
        out[`ball ${2 * r + 1}³`] = peak;
      }
      // a 9³ pile lit by one flame at a corner: it goes off in a wave, and each
      // cell's blast lands on the pressure its neighbours already made
      t.fresh();
      t.box(10, 18, 2, 10, 28, 36, 'GUNPOWDER');
      t.set(9, 2, 28, 'FIRE');
      t.load();
      const peak = {}, inside = [];
      let pin = 0;
      for (let s = 0; s < 120; s++) {
        t.step();
        t.read();
        for (let x = 10; x <= 18; x++) pin = Math.max(pin, t.cell(x, 6, 32).P);
        for (const d of [1, 2, 3, 4, 6, 8, 10, 14]) peak[d] = Math.max(peak[d] ?? -1e9, t.cell(18 + d, 6, 32).P);
      }
      out['9³ pile, lit at a corner'] = { inside: pin, ...peak };
      return out;
    });
  },
};

for (const [name, fn] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`== ${name}`);
  console.log(JSON.stringify(await fn(), null, 1));
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
