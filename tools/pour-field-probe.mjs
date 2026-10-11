// What the field passes draw of a pour (shaders/fields.js jetAt), read back
// from whitewater's aeration field: on tools/jet-check.mjs's tank, per step,
// the pour's parcels (liquid off the ground that followed another's path),
// the wakes recorded and the wakes drawn (a parcel coming up behind them);
// and on a dropped slab (blobs and splash), the same counts, which must show
// no wake drawn. Also how continuous the drawn pour is: the levels between
// the hole and the floor holding a drawn cell (parcel or wake) or a parcel.
// usage: node tools/pour-field-probe.mjs [--port 5287] [--samples 60]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5287');
const SAMPLES = +opt('samples', '60');
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
  const r = await p.evaluate(async (SAMPLES) => {
    const a = window.__app, sim = a.sim, g = sim.g, R = a.renderer;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    const { JOIN_REACH } = await import('/src/shaders/gfx/liquidDetail.js');
    a.test.park();
    if (!sim.aeration) return { error: 'no aeration field (Whitewater off?)' };
    const build = (scene) => {
      const [A, B] = sim.blankState();
      const box = (x0, y0, z0, x1, y1, z1, id, ctype = 0) => {
        for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
          const i = sim.cellTexel(x, y, z) * 4;
          A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = ctype + Math.random() * SEED_MAX;
        }
      };
      if (scene === 'tank') {
        box(24, 0, 56, 40, 46, 72, E.WALL); box(25, 1, 57, 39, 44, 71, E.WATER);
        box(25, 44, 57, 39, 45, 71, E.CLONE, E.WATER); box(39, 30, 64, 40, 31, 65, E.EMPTY);
      } else box(56, 22, 56, 72, 28, 72, E.WATER);
      sim.load(A, B);
    };
    const F = new Uint16Array(g.width * g.height * 4);
    const half = (h) => { const s = h >> 15, e = (h >> 10) & 31, m = h & 1023; const v = e === 0 ? m / 1024 * 2 ** -14 : (1 + m / 1024) * 2 ** (e - 15); return s ? -v : v; };
    const at = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return [0, 0, 0, 0];
      const i = sim.cellTexel(x, y, z) * 4;
      return [half(F[i]), half(F[i + 1]), half(F[i + 2]), half(F[i + 3])];
    };
    const drawn = (x, y, z) => {   // shaders/fields.js jetAt
      const f = at(x, y, z);
      if (f[1] > 1.5) return 'parcel';
      if (f[1] >= 0) return null;
      for (let k = 1; k <= JOIN_REACH; k++) {
        const bb = at(x - Math.round(f[0] * k), y - Math.round(f[2] * k), z - Math.round(f[3] * k));
        if (bb[1] > 1.5) return 'wake';
      }
      return 'lone';
    };
    const run = (scene, warm, region) => {
      build(scene);
      a.test.step(warm);
      const tot = { parcel: 0, wake: 0, lone: 0, airborne: 0, levels: 0, samples: 0 };
      for (let s = 0; s < SAMPLES; s++) {
        a.test.step(1);
        R.readRenderTargetPixels(sim.aeration.target, 0, 0, g.width, g.height, F);
        const lv = new Set();
        const [x0, x1, y0, y1, z0, z1] = region;
        for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
          const f = at(x, y, z);
          if (f[1] > 0.5 && f[3] < 0.5) tot.airborne++;
          if (f[1] < 0.5 && f[1] >= 0) continue;
          const d = drawn(x, y, z);
          if (d) tot[d]++;
          if (d === 'parcel' || d === 'wake') lv.add(y);
        }
        tot.levels += lv.size; tot.samples++;
      }
      for (const k of ['parcel', 'wake', 'lone', 'airborne', 'levels']) tot[k] = +(tot[k] / tot.samples).toFixed(2);
      return tot;
    };
    return {
      // the pour: off the tank, above the floor's puddle (levels: of the 26 from the hole down to y 4)
      pour: run('tank', 400, [40, 128, 4, 31, 40, 90]),
      // the slab: everywhere above the floor
      slab: run('slab', 0, [0, 128, 2, 40, 0, 128]),
    };
  }, SAMPLES);
  console.log('per step (mean): parcel = a pour parcel drawn joined, wake = a wake drawn, lone = a wake not drawn, airborne = liquid off the ground, levels = levels holding a drawn cell');
  console.log(JSON.stringify(r, null, 1));
} finally {
  await b.close();
}
