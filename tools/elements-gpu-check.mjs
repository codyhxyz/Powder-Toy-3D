// Integrated GPU check of the TPT element batches (docs/elements.md): one
// headless run on the real GPU, a small Lab scene per batch judged by reading
// the state back, then World loaded with every element, watching for errors.
// usage: node tools/elements-gpu-check.mjs <outDir> [--port 5418]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const out = process.argv[2] ?? 'elements-gpu';
mkdirSync(out, { recursive: true });
const pi = process.argv.indexOf('--port');
const port = pi > 0 ? process.argv[pi + 1] : '5418';
const VIEW = { width: 640, height: 400 };
const SEED = 1234;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: VIEW });
await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
await ctx.addInitScript((seed) => {
  let s = seed;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
}, SEED);
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  p.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:|Shader Error/.test(t)) errs.push(t.slice(0, 600));
  });
};

const p = await ctx.newPage();
watch(p);
await p.goto(`http://localhost:${port}/?preset=empty&size=128`, { timeout: 180000, waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 180000 });
await p.waitForTimeout(1500);

const res = await p.evaluate(async () => {
  const a = window.__app, sim = a.sim;
  const { E, ELEMENTS } = await import('/src/elements.js');
  const { isLive } = await import('/src/electricity.js');
  a.settings.paused = true;
  if (a.autoRes) a.autoRes.enabled = false;
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const { nx, ny, nz } = sim.g;

  // a fresh scene: fill(box) paints cells by element key
  const scene = async (fill) => {
    const [A, B] = sim.blankState();
    const box = (x0, y0, z0, x1, y1, z1, key, o = {}) => {
      const id = E[key];
      for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = o.T ?? ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life;
        A[i + 3] = (o.ctype ?? 0) + Math.random() * 0.999;
      }
    };
    fill(box);
    sim.load(A, B);
    await frames(3);   // draw it once: the render passes see the new elements
  };
  const steps = async (k) => { for (let i = 0; i < k; i++) sim.step(); await frames(2); };
  // per element: count, mean height, mean and max temperature; plus live conductor cells
  const tally = () => {
    const [s] = sim.readState();
    const o = {};
    let live = 0;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = sim.cellTexel(x, y, z) * 4, id = Math.round(s[i]);
      const e = (o[ELEMENTS[id]?.key ?? id] ??= { n: 0, y: 0, T: 0, Tmax: -1e9 });
      e.n++; e.y += y; e.T += s[i + 1]; e.Tmax = Math.max(e.Tmax, s[i + 1]);
      if (isLive(id, s[i + 3])) live++;
    }
    for (const k in o) { o[k].y = +(o[k].y / o[k].n).toFixed(1); o[k].T = +(o[k].T / o[k].n).toFixed(0); o[k].Tmax = +o[k].Tmax.toFixed(0); }
    o.live = live;
    return o;
  };
  const n = (t, k) => t[k]?.n ?? 0;
  const R = [];
  // known: a failure already listed in docs/elements.md Follow-ups (reported, not fatal)
  const check = (name, ok, info, known = false) => R.push({ name, ok: !!ok, info, known });

  // Explosives: a hot C-4 block goes off
  await scene((box) => box(60, 0, 60, 66, 6, 66, 'C4', { T: 1000 }));
  await steps(40);
  let t = tally();
  check('C-4 at 1000 °C goes off', n(t, 'C4') === 0, { C4: n(t, 'C4'), FIRE: n(t, 'FIRE') });

  // Explosives: thermite lit by lava burns into molten iron on a metal plate
  await scene((box) => { box(40, 20, 40, 80, 21, 80, 'METAL'); box(50, 21, 50, 70, 27, 70, 'THERMITE'); box(49, 21, 49, 50, 22, 50, 'LAVA'); });
  await steps(600);
  t = tally();
  check('thermite burns into molten metal', n(t, 'THERMITE') < 0.5 * 20 * 6 * 20 && n(t, 'LAVA') > 1, { THERMITE: n(t, 'THERMITE'), LAVA: n(t, 'LAVA'), LAVA_Tmax: t.LAVA?.Tmax });

  // Explosives: lit propane pool burns
  await scene((box) => { box(40, 0, 40, 80, 3, 80, 'PROPANE'); box(59, 3, 59, 61, 4, 61, 'FIRE'); });
  const p0 = 40 * 3 * 40;
  await steps(400);
  t = tally();
  check('a lit propane pool burns', n(t, 'PROPANE') < 0.5 * p0, { PROPANE: n(t, 'PROPANE'), of: p0 });

  // Chemistry: liquid nitrogen boils off and freezes the water it floats on
  await scene((box) => { box(40, 0, 40, 80, 4, 80, 'WATER'); box(50, 4, 50, 70, 8, 70, 'LIQUID_NITROGEN'); });
  const ln0 = 20 * 4 * 20;
  // the pool holds far more heat than the nitrogen can take, so the ice it
  // makes melts back: look for it while the nitrogen lasts
  const trace = [];
  let iceMax = 0;
  for (let k = 0; k < 12; k++) {
    await steps(50);
    t = tally();
    iceMax = Math.max(iceMax, n(t, 'ICE'));
    trace.push([n(t, 'LIQUID_NITROGEN'), n(t, 'ICE'), t.WATER ? Math.round(t.WATER.T) : null]);
  }
  check('liquid nitrogen boils off', n(t, 'LIQUID_NITROGEN') < ln0, { of: ln0, left: n(t, 'LIQUID_NITROGEN') });
  // known: no film boiling yet, so it boils ~100× too fast and never freezes a pool (docs/elements.md Follow-ups)
  check('liquid nitrogen freezes the water it floats on', iceMax > 0, { iceMax, 'per 50 steps [LN2, ICE, water °C]': trace }, true);

  // Chemistry: salt dissolves into water
  await scene((box) => { box(40, 0, 40, 80, 6, 80, 'WATER'); box(55, 6, 55, 65, 9, 65, 'SALT'); });
  await steps(400);
  t = tally();
  check('salt dissolves into saltwater', n(t, 'SALTWATER') > 0, { SALT: n(t, 'SALT'), SALTWATER: n(t, 'SALTWATER') });

  // Chemistry: hydrogen rises, CO2 and propane sink (released mid-air)
  await scene((box) => { box(20, 50, 20, 30, 60, 30, 'HYDROGEN'); box(60, 50, 60, 70, 60, 70, 'CO2'); box(95, 50, 95, 105, 60, 105, 'PROPANE'); });
  await steps(600);
  t = tally();
  check('hydrogen rises; CO2 and propane sink', t.HYDROGEN?.y > 55 && t.CO2?.y < 55 && t.PROPANE?.y < 55, { H2y: t.HYDROGEN?.y, CO2y: t.CO2?.y, C3H8y: t.PROPANE?.y });

  // Materials: stone floats on mercury, gold nuggets sink (in a glass tank)
  await scene((box) => {
    box(40, 0, 40, 80, 1, 80, 'GLASS'); box(40, 1, 40, 41, 14, 80, 'GLASS'); box(79, 1, 40, 80, 14, 80, 'GLASS');
    box(41, 1, 40, 79, 14, 41, 'GLASS'); box(41, 1, 79, 79, 14, 80, 'GLASS');
    box(41, 1, 41, 79, 8, 79, 'MERCURY');
    box(50, 20, 50, 56, 23, 56, 'STONE'); box(64, 20, 64, 70, 23, 70, 'NUGGETS');
  });
  await steps(500);
  t = tally();
  check('stone floats on mercury, gold sinks', t.STONE?.y >= 6 && t.NUGGETS?.y < t.STONE?.y - 3, { STONEy: t.STONE?.y, NUGGETSy: t.NUGGETS?.y, MERCURYy: t.MERCURY?.y });

  // Materials: void drains a falling column of water
  await scene((box) => { box(40, 0, 40, 80, 1, 80, 'VOID'); box(50, 10, 50, 70, 20, 70, 'WATER'); });
  await steps(400);
  t = tally();
  check('void drains water', n(t, 'WATER') < 0.2 * 20 * 10 * 20, { WATER: n(t, 'WATER') });

  // Batch 4: antimatter annihilates with stone; clay and water make mud; singularity eats sand
  await scene((box) => {
    box(10, 0, 10, 40, 4, 40, 'STONE'); box(22, 4, 22, 26, 6, 26, 'ANTIMATTER');
    box(60, 0, 60, 80, 3, 80, 'CLAY'); box(60, 3, 60, 80, 6, 80, 'WATER');
    box(90, 0, 90, 120, 6, 120, 'SAND'); box(105, 6, 105, 106, 7, 106, 'SINGULARITY');
  });
  const sand0 = 30 * 6 * 30;
  await steps(500);
  t = tally();
  check('antimatter annihilates', n(t, 'ANTIMATTER') === 0, { ANTIMATTER: n(t, 'ANTIMATTER'), STONE: n(t, 'STONE') });
  check('clay and water make mud', n(t, 'MUD') > 0, { MUD: n(t, 'MUD') });
  check('singularity eats sand', n(t, 'SAND') < sand0, { SAND: n(t, 'SAND'), of: sand0, SINGULARITY: n(t, 'SINGULARITY') });

  // Electricity: a battery sparks a metal wire
  await scene((box) => { box(20, 9, 62, 24, 13, 66, 'BATTERY'); box(24, 10, 63, 90, 12, 65, 'METAL'); });
  await steps(60);
  t = tally();
  check('a battery sparks a wire', t.live > 0, { live: t.live });

  return R;
});

// World, with every element in the tables
const w = await ctx.newPage();
watch(w);
await w.goto(`http://localhost:${port}/?size=world`, { timeout: 180000, waitUntil: 'domcontentloaded' });
await w.waitForFunction(() => window.__app?.win, null, { timeout: 180000 });
await w.waitForTimeout(15000);
await w.screenshot({ path: `${out}/world.png` });

for (const r of res) console.log(`${r.ok ? 'ok   ' : r.known ? 'KNOWN' : 'FAIL '} ${r.name}  ${JSON.stringify(r.info)}`);
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no console errors');
await b.close();
process.exit(res.every((r) => r.ok || r.known) && !errs.length ? 0 : 1);
