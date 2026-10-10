// Checks of the arena presets (src/arenas): Dam Valley.
//
// On the CPU (always): builds the preset in Node and checks
//   - every layout point (spawns, flags, hills, siege core, shrines, vehicle
//     pads) is standable: air for a body's height over solid footing, and a
//     vehicle pad clear over its whole footprint;
//   - the reservoir is sealed: no water cell has air beside or under it;
//   - no loose powder: every grain rests on something with its lower
//     diagonals filled (else it slides), and no plant touches water (it grows);
//   - nothing burning or molten, and the two halves mirror each other.
// On the GPU (with --port, a dev server running): loads the preset through the
// app, checks __app.arena, the player spawners and shrine orbs, then runs the
// sim for --secs and diffs the whole state against the state at load ("nothing
// churns but what should"); times sim.step() on Dam Valley's grid against the
// 'wide' grid's Lab; and with --shots <dir> takes the overview shots and a
// contact sheet (ImageMagick's montage).
//
// usage: node tools/arena-check.mjs [--port 5404] [--secs 30] [--shots dir]
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { E, ELEMENTS, K } from '../src/elements.js';
import { ARENA_SIZE, DAM_VALLEY_LAYOUT, buildDamValley, shrineAltars } from '../src/arenas/damValley.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', null);
const secs = Number(opt('secs', 30));
const shots = opt('shots', null);
const BODY_CELLS = 6;            // cells of air a standing body needs (5.5 tall)
const JEEP_HALF = [8, 4];        // cells: a jeep's half-footprint (x, z) along its length...
const BIKE_HALF = [3, 2];        // ...and a hoverbike's
const VEHICLE_CELLS = 6;         // cells of air over a vehicle pad
const STEP_ITERS = 40;           // sim steps per timing chunk...
const STEP_CHUNKS = 7;           // ...chunks per grid (the median is reported)
const SHOT_W = 1280, SHOT_H = 800;
const SHEET_TILE = 640;          // px across each shot in the contact sheet

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

// ---------------------------------------------------------------- CPU
const [NX, NY, NZ] = ARENA_SIZE;
const t0 = performance.now();
const { ids, layout } = buildDamValley();
console.log(`built ${NX}×${NY}×${NZ} in ${(performance.now() - t0).toFixed(0)} ms`);
const id = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ ? E.WALL : ids[(y * NZ + z) * NX + x]);
const solid = (k) => ELEMENTS[k].kind === K.SOLID;
const footing = (k) => solid(k) || ELEMENTS[k].kind === K.POWDER;
const counts = {};
for (const k of ids) counts[k] = (counts[k] ?? 0) + 1;
console.log('cells:', Object.entries(counts).map(([k, n]) => `${ELEMENTS[k].key} ${n}`).join(', '));

check('layout is the exported constant', layout === DAM_VALLEY_LAYOUT);
check('layout size is the grid', layout.size.join() === ARENA_SIZE.join());
check('at least 4 spawns a team', layout.spawns.red.length >= 4 && layout.spawns.blue.length >= 4);

// standable: air for a body over solid ground (or a solid's top) at the feet's column
const standable = ([x, y, z]) => {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (!footing(id(cx, y - 1, cz))) return `nothing to stand on (${ELEMENTS[id(cx, y - 1, cz)].key})`;
  for (let k = 0; k < BODY_CELLS; k++) if (id(cx, y + k, cz) !== E.EMPTY) return `${ELEMENTS[id(cx, y + k, cz)].key} at +${k}`;
  return null;
};
const points = [
  ...layout.spawns.red.map((p, i) => [`red spawn ${i}`, p]),
  ...layout.spawns.blue.map((p, i) => [`blue spawn ${i}`, p]),
  ['red flag', layout.flags.red], ['blue flag', layout.flags.blue],
  ...layout.hills.map((h, i) => [`hill ${i}`, h.slice(0, 3)]),
  ['siege core', layout.siege.core.slice(0, 3)],
  ...layout.shrines.map((s, i) => [`shrine ${i} floor`, [s[0], s[1], s[2] + 3]]),   // (its middle is a plinth)
];
const bad = points.map(([name, p]) => [name, p, standable(p)]).filter(([, , why]) => why);
check('every layout point is standable', !bad.length, bad.map(([n, p, w]) => `${n} ${p}: ${w}`).join('; '));
const plinths = layout.shrines.flatMap((s) => shrineAltars(s)).filter(([x, y, z]) => id(Math.floor(x), y - 1, Math.floor(z)) !== E.METAL);
check('every shrine altar is a steel-topped plinth', !plinths.length, JSON.stringify(plinths));
const padBad = layout.vehicles.filter((v) => {
  const [hx, hz] = v.kind === 'jeep' ? JEEP_HALF : BIKE_HALF;
  const [x0, y, z0] = v.at;
  for (let z = z0 - hz; z <= z0 + hz; z++)
    for (let x = x0 - hx; x <= x0 + hx; x++) {
      if (!solid(id(x, y - 1, z))) return true;
      for (let k = 0; k < VEHICLE_CELLS; k++) if (id(x, y + k, z) !== E.EMPTY) return true;
    }
  return false;
});
check('every vehicle pad is flat and clear', !padBad.length, JSON.stringify(padBad));

// the reservoir is sealed; powders rest; plants stay dry; nothing hot
let leaks = 0, loose = 0, wetPlants = 0, water = 0, leakAt = null, looseAt = null;
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const DIAG = [[1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]];
for (let y = 0; y < NY; y++)
  for (let z = 0; z < NZ; z++)
    for (let x = 0; x < NX; x++) {
      const k = id(x, y, z);
      if (k === E.WATER) {
        water++;
        if (SIDES.some(([dx, dy, dz]) => id(x + dx, y + dy, z + dz) === E.EMPTY)) { leaks++; leakAt ??= [x, y, z]; }
      } else if (ELEMENTS[k].kind === K.POWDER) {
        if ([[0, -1, 0], ...DIAG].some(([dx, dy, dz]) => id(x + dx, y + dy, z + dz) === E.EMPTY)) { loose++; looseAt ??= [x, y, z, ELEMENTS[k].key]; }
      } else if (k === E.PLANT) {
        for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
          if (id(x + dx, y + dy, z + dz) === E.WATER) { wetPlants++; dy = dz = dx = 2; }
      }
    }
check('the reservoir is sealed', water > 0 && leaks === 0, `${water} water cells, ${leaks} by air${leakAt ? ` (first ${leakAt})` : ''}`);
check('no loose powder', loose === 0, loose ? `${loose} grains, first ${looseAt}` : `${(counts[E.SAND] ?? 0) + (counts[E.GUNPOWDER] ?? 0)} grains all resting`);
check('no plant touches water', wetPlants === 0, `${wetPlants}`);
check('nothing burning or molten', !counts[E.FIRE] && !counts[E.LAVA] && !counts[E.STEAM]);
// (the shrines are an odd number of cells wide, so they can't mirror about the grid's middle)
const SHRINE_REACH = [9, 6];   // cells round a shrine's middle (x, z) its pavilion and site take
const inShrine = (x, y, z) => layout.shrines.some((s) => Math.abs(x - s[0]) <= SHRINE_REACH[0] && Math.abs(z - s[2]) <= SHRINE_REACH[1]
  && y >= s[1] - 2 && y < s[1] + 14);
let asym = 0;
for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX / 2; x++)
  if (id(x, y, z) !== id(NX - 1 - x, y, z) && !inShrine(x, y, z) && !inShrine(NX - 1 - x, y, z)) asym++;
check('the halves mirror each other (but the shrines)', asym === 0, `${asym} cells differ`);

// ---------------------------------------------------------------- GPU
if (port) {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: SHOT_W, height: SHOT_H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const frames = (n) => ev(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
  try {
    await p.addInitScript(() => addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.id = 'arena-hide';
      st.textContent = 'body > *:not(canvas):not(:has(canvas)), .dock, .card, .topbar, .hud, .toast { visibility: hidden !important; }';
      document.head.appendChild(st);
    }));
    await p.goto(`http://localhost:${port}/?preset=damValley`);
    await p.waitForFunction(() => window.__app?.arena && window.__app.pov, null, { timeout: 60000 });
    await frames(10);
    const app = await ev(() => {
      const a = window.__app;
      return { size: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], name: a.arena.name, spawns: a.spawners.of('player').length,
        orbs: a.perkOrbs.list.length, preset: a.settings.preset, gridSize: a.settings.size };
    });
    check('the app loads Dam Valley on its grid', app.size.join() === ARENA_SIZE.join() && app.name === 'Dam Valley', JSON.stringify(app));
    check('player spawners at red spawns', app.spawns === layout.spawns.red.length, `${app.spawns}`);
    check('perk orbs over every shrine', app.orbs === 3 * layout.shrines.length, `${app.orbs}`);

    // ---- the GPU state matches the CPU build, then nothing churns
    const readIds = () => ev(() => {
      const a = window.__app, g = a.sim.g, [A] = a.sim.readState();
      const out = new Uint8Array(g.nx * g.ny * g.nz);
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++)
        out[(y * g.nz + z) * g.nx + x] = Math.round(A[a.sim.cellTexel(x, y, z) * 4]);
      window.__ids = out;
      return out.length;
    });
    const diff = (prev) => ev((prev) => {
      const a = window.__app, g = a.sim.g, [A] = a.sim.readState();
      const pairs = {}, cur = new Uint8Array(window.__ids.length);
      let n = 0, hot = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const t = a.sim.cellTexel(x, y, z) * 4, i = (y * g.nz + z) * g.nx + x, k = Math.round(A[t]);
        cur[i] = k;
        if (A[t + 1] > 60) hot++;
        const was = prev ? window.__ids0[i] : window.__ids[i];
        if (k !== was) { n++; const key = `${was}>${k}`; pairs[key] = (pairs[key] ?? 0) + 1; }
      }
      return { n, hot, pairs: Object.entries(pairs).sort((u, v) => v[1] - u[1]).slice(0, 8) };
    }, prev);
    await readIds();
    const gpuVsCpu = await ev((cpu) => {
      let n = 0; for (let i = 0; i < cpu.length; i++) if (window.__ids[i] !== cpu[i]) n++; return n;
    }, Array.from(ids));
    check('the GPU state at load is the CPU build', gpuVsCpu === 0, `${gpuVsCpu} cells differ`);
    await ev(() => { window.__ids0 = window.__ids; });
    const census = () => ev(async () => {
      const { E } = await import('/src/elements.js');
      const c = window.__app.sim.census();
      return Object.fromEntries(['WATER', 'FIRE', 'SMOKE', 'STEAM', 'SAND', 'GUNPOWDER', 'PLANT', 'WOOD', 'LAVA', 'CLOUD'].map((k) => [k, c[E[k]]?.n ?? 0]));
    });
    const c0 = await census();
    const steps0 = await ev(() => { const a = window.__app; a.__steps = 0; const s = a.sim.step.bind(a.sim); a.sim.step = () => { a.__steps++; s(); }; a.settings.paused = false; return a.settings.steps; });
    await p.waitForTimeout(secs * 1000);
    const ran = await ev(() => { const a = window.__app; a.settings.paused = true; return a.__steps; });
    await frames(2);
    const c1 = await census();
    const d = await diff(true);
    console.log(`ran ${secs} s: ${ran} steps (${steps0} a frame)`);
    console.log('census at load', JSON.stringify(c0));
    console.log(`census after  `, JSON.stringify(c1));
    check('the reservoir holds (water count steady)', Math.abs(c1.WATER - c0.WATER) <= c0.WATER * 0.001, `${c0.WATER} → ${c1.WATER}`);
    check('nothing lit', !c1.FIRE && !c1.SMOKE && !c1.STEAM && !c1.LAVA, JSON.stringify(c1));
    check('nothing churns', d.n <= 0.0005 * NX * NY * NZ, `${d.n} cells changed; ${d.hot} hot; top old>new: ${JSON.stringify(d.pairs)}`);

    // ---- step cost: Dam Valley's grid vs 'wide' (160×96×160) with the Lab
    const stepMs = () => ev(([iters, chunks]) => {
      const a = window.__app, sim = a.sim, out = { sleep: [], noSleep: [] };
      for (const [k, skip] of [['sleep', true], ['noSleep', false]]) {
        sim.skipSleeping = skip;
        for (let i = 0; i < 5; i++) sim.step();
        sim.gpuSync();
        for (let c = 0; c < chunks; c++) {
          const t = performance.now();
          for (let i = 0; i < iters; i++) sim.step();
          sim.gpuSync();
          out[k].push((performance.now() - t) / iters);
        }
        out[k].sort((u, v) => u - v);
        out[k] = +out[k][Math.floor(chunks / 2)].toFixed(3);
      }
      sim.skipSleeping = true;
      return out;
    }, [STEP_ITERS, STEP_CHUNKS]);
    const holdLoop = () => ev(() => { const a = window.__app; a.settings.paused = true; });
    await holdLoop();
    const valley = await stepMs();

    // ---- shots (before leaving the valley)
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await ev(() => { window.__app.day.fixed = { az: 215, el: 38 }; window.__app.autoRes.enabled = false; });
      // a camera at grid cell `from` looking at grid cell `to`
      const cam = async (from, to) => {
        await ev(([from, to]) => {
          const a = window.__app, g = a.sim.g, s = a.scale, v = a.volume.position;
          const w = (c) => [v.x + c[0] * s, v.y + c[1] * s, v.z + c[2] * s];
          a.camera.position.set(...w(from));
          a.controls.target.set(...w(to));
          a.controls.update();
          a.post.reset();
        }, [from, to]);
        await frames(30);
      };
      const shot = (name) => p.screenshot({ path: `${shots}/${name}.png` });
      await cam([-24, 92, 22], [140, 18, 70]); await shot('1-aerial-red-end');
      await cam([NX + 24, 92, NZ - 22], [116, 18, 58]); await shot('2-aerial-blue-end');
      await cam([128, 230, -90], [128, 0, 66]); await shot('3-overview');
      await cam([150, 44, 22], [124, 24, 62]); await shot('4-dam-face');
      await cam([70, 58, 118], [128, 30, 70]); await shot('5-reservoir');
      // first person: the red base's door, its roof, the crest, the pump room
      await p.keyboard.press('f');
      await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
      await ev(() => { window.__app.pov.test.assumeLocked = true; });
      const fp = async (at, yaw, pitch, name) => {
        await ev(([at, yaw, pitch]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(...at)); a.pov.setLook(yaw, pitch); a.post.reset(); }, [at, yaw, pitch]);
        await frames(40);
        await shot(name);
      };
      await fp([36, 22, 64], -Math.PI / 2, -0.04, '6-fp-red-door');
      await fp([28.5, 35, 50], -Math.PI / 2 + 0.25, -0.12, '7-fp-red-roof');
      await fp([102, 34, 60.5], -Math.PI / 2, -0.03, '8-fp-crest');
      await fp([106, 14, 60], -Math.PI / 2, 0.02, '9-fp-tunnel');
      await ev(() => window.__app.pov.exit(true));
      try {
        execFileSync('montage', [`${shots}/[1-9]-*.png`, '-resize', `${SHEET_TILE}x`, '-tile', '3x', '-geometry', '+4+4', '-background', '#111', `${shots}/sheet.jpg`]);
        console.log(`contact sheet: ${shots}/sheet.jpg`);
      } catch (e) { console.log('montage failed:', String(e).slice(0, 200)); }
    }

    // ---- 'wide' with the Lab, for the step cost
    await ev(() => { const a = window.__app; a.settings.preset = 'lab'; a.setSize('wide'); });
    await frames(10);
    await ev(() => { window.__app.settings.paused = false; });
    await p.waitForTimeout(3000);   // (the lab settles a little, as the valley did)
    await holdLoop();
    const wide = await stepMs();
    console.log(`step ms (median of ${STEP_CHUNKS}×${STEP_ITERS}): valley ${JSON.stringify(valley)}, wide+lab ${JSON.stringify(wide)}`);
    console.log(`ratio valley/wide: sleeping ${(valley.sleep / wide.sleep).toFixed(2)}, every supertile ${(valley.noSleep / wide.noSleep).toFixed(2)}`);
  } catch (err) {
    fails++;
    console.log('FAIL threw', String(err).slice(0, 600));
  }
  check('no console errors', errs.length === 0, errs.slice(0, 4).join(' || '));
  await b.close();
}
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
