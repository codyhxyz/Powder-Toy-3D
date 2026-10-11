// GPU check of the simulation modes (src/simModes.js: TPT's Simulation
// Options): one headless run on the real GPU, a 64³ box, each mode judged by
// reading the state back after stepping it (manual test mode: the app loop is
// parked, the steps are sim.step()). Needs a dev server.
// usage: node tools/sim-modes-check.mjs [--port 5793]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const pi = process.argv.indexOf('--port');
const port = pi > 0 ? process.argv[pi + 1] : '5793';

const browser = await launchBrowser();
let fails = 0;
try {
  const p = await newTestPage(browser, { mode: 'manual', viewport: { width: 480, height: 320 } });
  await p.routeWebSocket(/.*/, () => {});   // no multiplayer relay
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  p.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:|Shader Error/.test(t)) errs.push(t.slice(0, 600));
  });
  await p.goto(`http://localhost:${port}/?preset=empty&size=64`, { timeout: 180000, waitUntil: 'domcontentloaded' });
  await ready(p);

  const R = await p.evaluate(async () => {
    const a = window.__app, sim = a.sim;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { GRAV, AIR, EDGE, SIM_MODE_DEFAULTS } = await import('/src/simModes.js');
    const { nx, ny, nz } = sim.g;
    const out = [];
    const check = (name, ok, info) => out.push({ name, ok: !!ok, info });
    const modes = (m) => a.setSimModes({ ...SIM_MODE_DEFAULTS, ...m });
    const scene = (fill) => {
      const [A, B] = sim.blankState();
      const box = (x0, y0, z0, x1, y1, z1, key, o = {}) => {
        const id = E[key];
        for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
          const i = sim.cellTexel(x, y, z) * 4;
          A[i] = id; A[i + 1] = o.T ?? ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = Math.random() * 0.999;
          if (o.P != null) B[i + 3] = o.P;
        }
      };
      fill(box);
      sim.load(A, B);
    };
    const steps = (k) => { for (let i = 0; i < k; i++) sim.step(); };
    // per element: count, mean x/y/z, mean and max |distance from the centre|; air temperature and wind; pressure
    const tally = () => {
      const [s, b] = sim.readState();
      const o = { air: { Tmax: -1e9, Tmin: 1e9, vmax: 0 }, Pabs: 0, Pmax: 0 };
      for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = sim.cellTexel(x, y, z) * 4, id = Math.round(s[i]);
        o.Pabs += Math.abs(b[i + 3]); o.Pmax = Math.max(o.Pmax, Math.abs(b[i + 3]));
        if (id === E.EMPTY) {
          o.air.Tmax = Math.max(o.air.Tmax, s[i + 1]); o.air.Tmin = Math.min(o.air.Tmin, s[i + 1]);
          o.air.vmax = Math.max(o.air.vmax, Math.abs(b[i]), Math.abs(b[i + 1]), Math.abs(b[i + 2]));
          continue;
        }
        const e = (o[ELEMENTS[id]?.key ?? id] ??= { n: 0, x: 0, y: 0, z: 0, ymax: 0, r: 0, rmax: 0, T: 0 });
        const r = Math.hypot(x + 0.5 - nx / 2, y + 0.5 - ny / 2, z + 0.5 - nz / 2);
        e.n++; e.x += x; e.y += y; e.z += z; e.ymax = Math.max(e.ymax, y); e.r += r; e.rmax = Math.max(e.rmax, r); e.T += s[i + 1];
      }
      for (const k in o) if (o[k].n) for (const f of ['x', 'y', 'z', 'r', 'T']) o[k][f] = +(o[k][f] / o[k].n).toFixed(2);
      return o;
    };
    const n = (t, k) => t[k]?.n ?? 0;
    const SAND = 6 * 6 * 6;

    // vertical (the default): a block of sand in mid-air falls
    modes({});
    scene((box) => box(29, 40, 29, 35, 46, 35, 'SAND'));
    steps(300);
    let t = tally();
    check('vertical: sand falls to the floor', n(t, 'SAND') === SAND && t.SAND.y < 5, t.SAND);

    // off: it stays up; a column on the floor doesn't topple
    modes({ gravityMode: GRAV.OFF });
    check('off: sim.gravity reads 0 (the body, shots and physgun float)', sim.gravity === 0, sim.gravity);
    scene((box) => { box(29, 40, 29, 35, 46, 35, 'SAND'); box(10, 0, 10, 12, 12, 12, 'SAND'); });
    steps(300);
    t = tally();
    const hi = await (async () => { const [s] = sim.readState(); let m = 0; for (let y = 30; y < ny; y++) for (let z = 20; z < 44; z++) for (let x = 20; x < 44; x++) if (Math.round(s[sim.cellTexel(x, y, z) * 4]) === E.SAND) m++; return m; })();
    const col = (() => { const [s] = sim.readState(); let top = -1; for (let y = 0; y < ny; y++) for (let z = 10; z < 12; z++) for (let x = 10; x < 12; x++) if (Math.round(s[sim.cellTexel(x, y, z) * 4]) === E.SAND) top = Math.max(top, y); return top; })();
    check('off: sand in mid-air stays up', hi > 0.9 * SAND, { aloft: hi, of: SAND });
    check('off: a sand column stands', col === 11, { top: col });

    // radial: sand from the eight corners gathers at the centre; nothing is made or lost
    modes({ gravityMode: GRAV.RADIAL });
    scene((box) => {
      for (const x of [2, 56]) for (const y of [2, 56]) for (const z of [2, 56]) box(x, y, z, x + 6, y + 6, z + 6, 'SAND');
      box(26, 50, 26, 38, 54, 38, 'WATER');
    });
    const r0 = tally();
    steps(900);
    t = tally();
    check('radial: sand gathers at the centre', n(t, 'SAND') === 8 * SAND && t.SAND.r < 0.5 * r0.SAND.r, { r: [r0.SAND.r, t.SAND.r], rmax: t.SAND.rmax });
    check('radial: no cell made or lost (sand, water)', n(t, 'SAND') === 8 * SAND && n(t, 'WATER') === n(r0, 'WATER'), { SAND: n(t, 'SAND'), WATER: [n(r0, 'WATER'), n(t, 'WATER')] });
    check('radial: water falls in too', t.WATER.r < 0.6 * r0.WATER.r, { r: [r0.WATER.r, t.WATER.r] });

    // void edges: sand falls out of the floor and is gone
    modes({ edgeMode: EDGE.VOID });
    scene((box) => box(29, 2, 29, 35, 8, 35, 'SAND'));
    steps(200);
    t = tally();
    check('void: sand falls out of the box', n(t, 'SAND') < 0.2 * SAND, { left: n(t, 'SAND'), of: SAND });
    // ...and a blast vents through the sides
    scene((box) => box(0, 20, 20, 4, 24, 24, 'EMPTY', { P: 100 }));
    steps(60);
    const pVoid = tally().Pabs;
    modes({});
    scene((box) => box(0, 20, 20, 4, 24, 24, 'EMPTY', { P: 100 }));
    steps(60);
    const pSolid = tally().Pabs;
    check('void: pressure drains out of the sides (less is left than with walls)', pVoid < pSolid, { void: +pVoid.toFixed(1), solid: +pSolid.toFixed(1) });

    // loop edges: sand falls through the floor and comes back in at the top
    modes({ edgeMode: EDGE.LOOP });
    scene((box) => box(29, 2, 29, 35, 8, 35, 'SAND'));
    steps(120);
    t = tally();
    check('loop: sand falls through the floor and in at the top, none lost', n(t, 'SAND') === SAND && t.SAND.ymax > ny - 10, t.SAND);
    scene((box) => box(60, 30, 30, 64, 34, 34, 'WATER'));
    for (let i = 0; i < 12; i++) {
      const [A, B] = sim.readState();
      // keep pushing it toward +x
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { const c = sim.cellTexel(x, y, z) * 4; if (Math.round(A[c]) === E.WATER) B[c] = 0.8; }
      sim.load(A, B); steps(3);
    }
    t = tally();
    // (from x = 60-63 it ends up near the low side: 2026-10-11 run, mean x 9.2)
    check('loop: water thrown out of +x comes in at −x, none lost', n(t, 'WATER') === 64 && t.WATER.x < 40, t.WATER);

    // air modes: a blob of pressure
    const blast = (m) => { modes(m); scene((box) => box(28, 28, 28, 36, 36, 36, 'EMPTY', { P: 80 })); steps(1); const t1 = tally(); steps(30); return [t1, tally()]; };
    let [a1, a2] = blast({});
    // (the shock front spreads it, so the total grows while the peak falls)
    check('air on: pressure spreads, fades and blows', a2.Pmax < a1.Pmax && a2.air.vmax > 0.05, { Pmax: [a1.Pmax, a2.Pmax], wind: a2.air.vmax });
    [a1, a2] = blast({ airMode: AIR.PRESSURE_OFF });
    check('pressure off: none left', a1.Pmax === 0 && a2.Pmax === 0, { Pmax: [a1.Pmax, a2.Pmax] });
    [a1, a2] = blast({ airMode: AIR.VELOCITY_OFF });
    check('velocity off: pressure stays, the air is still', a2.Pmax > 0 && a2.air.vmax === 0, { Pmax: a2.Pmax, wind: a2.air.vmax });
    [a1, a2] = blast({ airMode: AIR.OFF });
    check('air off: no pressure, no wind', a2.Pmax === 0 && a2.air.vmax === 0, { Pmax: a2.Pmax, wind: a2.air.vmax });
    [a1, a2] = blast({ airMode: AIR.NO_UPDATE });
    check('no update: pressure holds where it is', Math.abs(a2.Pabs - a1.Pabs) < 1e-3 * a1.Pabs, { P: [a1.Pabs, a2.Pabs] });

    // ambient heat: a hot metal block in air
    const hot = (m) => { modes(m); scene((box) => box(28, 28, 28, 36, 36, 36, 'METAL', { T: 600 })); steps(200); return tally(); };
    const on = hot({}), off = hot({ ambientHeat: false });
    check('ambient heat on: the metal warms the air and cools', on.air.Tmax > 30 && on.METAL.T < 600, { air: on.air.Tmax, metal: on.METAL.T });
    check('ambient heat off: the air stays at ambient, the metal keeps its heat', off.air.Tmax === 20 && off.METAL.T > 599.9, { air: off.air.Tmax, metal: off.METAL.T });

    // a fresh scene starts the modes over
    modes({ gravityMode: GRAV.RADIAL, airMode: AIR.OFF, ambientHeat: false, edgeMode: EDGE.LOOP });
    a.loadPreset('empty', false);
    check('a fresh scene starts the modes over', sim.gravityMode === GRAV.VERTICAL && sim.airMode === AIR.ON && sim.ambientHeat && sim.edgeMode === EDGE.SOLID
      && a.settings.gravityMode === GRAV.VERTICAL, { g: sim.gravityMode, air: sim.airMode, heat: sim.ambientHeat, edge: sim.edgeMode });
    return out;
  });
  for (const r of R) {
    if (!r.ok) fails++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  ${JSON.stringify(r.info)}`);
  }
  if (errs.length) { fails++; console.log('errors:\n' + errs.join('\n')); }
} finally {
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
