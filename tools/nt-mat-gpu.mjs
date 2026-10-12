// Headless GPU check of Noita's materials (elements.js BLOOD ... PHEROMONE):
// one browser, a 64³ box.
//   activity  a closed rock cave: a pool dammed by moss in a corner, a log
//             with fungus at its damp end over a water-filled pit, a dry fungus
//             patch on the back wall. Steps with the activity map on, and
//             checks the map built from the flags against the reference pass
//             (as tools/activity-check.mjs does): they must never differ.
//             Reports the growers' counts before and after.
//   cave-*    the cave, dark but for the fungus's glow; close up
//   day-*     every new liquid in a row of rock basins in daylight; close up
// (The dock tiles run the CPU twin: tools/nt-mat-check.mjs.)
// usage: node tools/nt-mat-gpu.mjs <outDir> [--port 5432] [--steps 4000]
//   (the app on your own Vite: npx vite --port 5432 --strictPort)
import { mkdirSync } from 'fs';
import { launchBrowser, newTestContext, ready, render } from './browser.mjs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5432');
const STEPS = +opt('steps', '4000');
mkdirSync(out, { recursive: true });

const b = await launchBrowser();
try {
// a parked app (manual mode): the steps are ours, the shots converged views (tools/browser.mjs render)
const ctx = await newTestContext(b, { mode: 'manual', viewport: { width: 1280, height: 800 } });
await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GPUValidationError|WGSL/.test(t)) errs.push(t.slice(0, 2000));
});
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, paused: true, glowLights: true }));
});
const t0 = Date.now();
await p.goto(`http://localhost:${port}/?preset=empty&size=64`, { waitUntil: 'commit', timeout: 120000 });
await ready(p);
await p.evaluate(() => window.__app.test.ready());
const loadS = (Date.now() - t0) / 1000;
const ev = (fn, arg) => p.evaluate(fn, arg);

await ev(async () => {
  const { E, ELEMENTS } = await import('/src/elements.js');
  const a = window.__app, sim = a.sim;
  a.settings.paused = true;
  a.day.clock = 0;   // 10 am
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  a.test.park();
  const idx = (x, y, z) => sim.cellTexel(x, y, z) * 4;
  const t = {
    fresh() { [t.A, t.B] = sim.blankState(); },
    set(x, y, z, key) {
      const id = E[key], i = idx(x, y, z), e = ELEMENTS[id];
      t.A[i] = id; t.A[i + 1] = e.temp; t.A[i + 2] = e.life; t.A[i + 3] = t.A[i + 3] % 1;
      t.B[i] = t.B[i + 1] = t.B[i + 2] = t.B[i + 3] = 0;
    },
    box(x0, x1, y0, y1, z0, z1, key) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) t.set(x, y, z, key);
    },
    cave() {
      t.fresh();
      t.box(10, 53, 0, 30, 10, 53, 'ROCK');      // walls, floor (top at y = 2) and lid, 3 cells thick
      t.box(13, 50, 3, 27, 13, 50, 'EMPTY');
      t.box(30, 33, 12, 14, 50, 53, 'EMPTY');    // the opening, in the front wall
      // a pool in the back-left corner, dammed by moss
      t.box(13, 17, 3, 3, 13, 17, 'WATER');
      t.box(18, 18, 3, 3, 13, 18, 'MOSS');
      t.box(13, 17, 3, 3, 18, 18, 'MOSS');
      // a log on the floor, fungus at its end over a pit of water
      t.box(30, 42, 3, 4, 24, 25, 'WOOD');
      t.box(29, 29, 2, 2, 24, 25, 'WATER');
      t.box(29, 29, 3, 4, 24, 25, 'FUNGUS');
      // a dry fungus patch on the back wall, and a rotted stump of it
      t.box(36, 41, 8, 12, 13, 13, 'FUNGUS');
      t.box(22, 24, 3, 6, 34, 36, 'FUNGUS');
      sim.frame = 0;
      sim.load(t.A, t.B);
    },
    // every new liquid in its own rock basin, 4 × 4 × 3, along x
    basins() {
      t.fresh();
      const L = ['WATER', 'BLOOD', 'TOXIC', 'SLIME', 'WHISKEY', 'TELEPORTATIUM', 'LEVITATIUM', 'HEALTHIUM', 'BERSERKIUM', 'POLYMORPHINE', 'PHEROMONE'];
      L.forEach((k, n) => {
        const x0 = 2 + n * 5 + (n >= 6 ? -30 : 0), z0 = n >= 6 ? 38 : 26;
        t.box(x0, x0 + 5, 0, 3, z0, z0 + 5, 'ROCK');
        t.box(x0 + 1, x0 + 4, 1, 3, z0 + 1, z0 + 4, k);
      });
      t.box(20, 26, 0, 3, 50, 52, 'MOSS');      // a moss bank and a fungus mound for daylight looks
      t.box(30, 34, 0, 3, 50, 52, 'FUNGUS');
      sim.frame = 0;
      sim.load(t.A, t.B);
    },
    cam(pos, tgt) {
      a.volume.updateMatrixWorld();
      const V = a.camera.position.constructor;
      a.camera.position.copy(a.volume.localToWorld(new V(...pos)));
      a.controls.target.copy(a.volume.localToWorld(new V(...tgt)));
      a.controls.update();
      a.post.reset();
    },
    async count() {
      const [A] = await sim.readState(), c = {};
      for (let i = 0; i < A.length; i += 4) { const k = ELEMENTS[Math.round(A[i])]?.key; if (k && k !== 'EMPTY') c[k] = (c[k] ?? 0) + 1; }
      return c;
    },
  };
  window.__t = t;
});
// ---- the activity map against its reference, while the cave steps: after
// every map the simulation builds, the reference kernel rebuilds the inert
// map from the state alone (sim.inertRef) and the quiet map follows from it
// (tools/harness/sim-activity.js, as tools/activity-check.mjs does)
const act = await ev(async (steps) => {
  const a = window.__app, sim = a.sim, t = window.__t, g = sim.g;
  await sim.prepare('inertRef');
  const stat = { builds: 0, inertDiff: 0, quietDiff: 0, quietShare: 0, quietLast: 0 };
  const pending = [];
  const build = sim.updateActivity.bind(sim);
  sim.updateActivity = () => {
    build();
    const enabled = sim.quietOk;
    pending.push(Promise.all([sim.readMaps(), sim.inertRef()]).then(([m, ref]) => {
      let di = 0, dq = 0, nq = 0;
      for (let i = 0; i < ref.length; i++) {
        const bx = i % g.bx, by = Math.floor(i / g.bx) % g.by, bz = Math.floor(i / (g.bx * g.by));
        let q = enabled;
        for (let z = -1; z <= 1 && q; z++) for (let y = -1; y <= 1 && q; y++) for (let x = -1; x <= 1 && q; x++) {
          const nx = bx + x, ny = by + y, nz = bz + z;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= g.bx || ny >= g.by || nz >= g.bz) continue;
          if (!ref[nx + g.bx * (ny + g.by * nz)]) q = false;
        }
        if (m.inert[i] !== ref[i]) di++;
        if (m.quiet[i] !== (q ? 1 : 0)) dq++;
        nq += q;
      }
      stat.builds++; stat.inertDiff += di; stat.quietDiff += dq;
      stat.quietShare += nq / ref.length; stat.quietLast = nq / ref.length;
    }));
  };
  sim.skipQuiet = true;
  t.cave();
  const before = await t.count();
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (pending.length > 8) { await Promise.all(pending); pending.length = 0; }   // (a few maps in flight at most)
  }
  await Promise.all(pending);
  const after = await t.count();
  sim.updateActivity = build;
  stat.quietShare /= Math.max(1, stat.builds);
  const pick = (c) => ({ MOSS: c.MOSS, FUNGUS: c.FUNGUS, WOOD: c.WOOD, WATER: c.WATER });
  return { ...stat, before: pick(before), after: pick(after) };
}, STEPS);
console.log(JSON.stringify({ loadS, activity: act }));

const shot = (name) => p.screenshot({ path: `${out}/${name}.png` });
// a camera, then the view converged (fields' EMA, GI feedback, TAA: tools/browser.mjs render)
const view = async (pos, tgt) => { await ev(([pos, tgt]) => window.__t.cam(pos, tgt), [pos, tgt]); await render(p); };

// ---- the cave (as it stands after the steps above), then daylight basins
await view([33, 15, 46], [30, 6, 22]); await shot('cave');
await view([33, 9, 33], [30, 4, 24]); await shot('cave-log');
await view([28, 10, 30], [16, 4, 16]); await shot('cave-pool');
await ev(() => window.__t.basins());
await view([32, 26, 70], [32, 2, 34]); await shot('day-basins');
await view([16, 9, 44], [16, 2, 30]); await shot('day-close');
await view([28, 8, 62], [28, 2, 50]); await shot('day-moss-fungus');

console.log(errs.length ? errs.join('\n') : 'no console errors');
} finally {
  await b.close();
}
