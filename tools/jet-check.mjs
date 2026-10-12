// A pour through a one-cell hole, measured from the GPU state: is it one
// coherent jet? tools/whitewater-shots.mjs's tank (Lab 128³: walls, water kept
// full by a clone lid, a one-cell hole in its +x wall HOLE_Y cells up), stepped
// in manual mode and read back every step once the pour is running:
//   exit     cells/step leaving through the hole, the steps between parcels
//            (run lengths of steps with none), and the velocity of the water
//            just outside the hole, against Torricelli's √(2gh)
//   spread   where the falling water is (x, z) at levels below the hole
//   gaps     cells between successive parcels along the jet (Chebyshev)
//   exposure a long exposure of the pour seen from the side (x across, y up,
//            z collapsed), and from the front (z across)
// and, in a second scene (the tank without its clone, so nothing makes
// water), whether the steps keep every element's cell count (conservation).
// usage: node tools/jet-check.mjs [--port 5287] [--warm 240] [--samples 160] [--json out.json]
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5287');
const WARM = +opt('warm', '240');          // steps before sampling: the pour reaches the floor and settles into its rhythm
const SAMPLES = +opt('samples', '160');    // steps read back, one at a time
const CONSERVE_STEPS = 400;                // steps of the clone-less tank between its two censuses
const json = opt('json', '');

const b = await launchBrowser();
let res;
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 480, height: 320 } });
  await p.routeWebSocket(/.*/, () => {});   // no multiplayer relay
  await p.addInitScript(() => {
    let s = 12345;   // mulberry32: same scene every run (as tools/whitewater-shots.mjs)
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  p.on('console', (m) => { const t = m.text(); if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|Shader Error/.test(t)) errs.push(t.slice(0, 500)); });
  await p.goto(`http://localhost:${port}/?size=128&preset=empty&paused=1`);
  await ready(p);

  res = await p.evaluate(async ([WARM, SAMPLES, CONSERVE_STEPS]) => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    const { PHYS, SIM_GRAVITY } = await import('/src/physics.js');
    a.test.park();
    await a.test.ready();   // (load and step need the grid's pipelines)
    const HOLE = [39, 30, 64];            // the hole (tools/whitewater-shots.mjs)
    const SURFACE = 44;                   // the tank's water runs to y = 43, under the clone lid
    const OUT_X = HOLE[0] + 1;            // outside the tank
    const LEVELS = [5, 10, 15, 20, 25];   // cells below the hole
    const JET_Y0 = 4;                     // above the floor's puddle
    const build = (lid) => {
      const [A, B] = sim.blankState();
      const set = (x, y, z, id, ctype = 0) => {
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = ctype + Math.random() * SEED_MAX;
        B[i] = B[i + 1] = B[i + 2] = 0;
      };
      const box = (x0, y0, z0, x1, y1, z1, id, ctype) => {
        for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) set(x, y, z, id, ctype);
      };
      box(24, 0, 56, 40, 46, 72, E.WALL);
      box(25, 1, 57, 39, 44, 71, E.WATER);
      box(25, 44, 57, 39, 45, 71, lid, E.WATER);
      box(HOLE[0], HOLE[1], HOLE[2], HOLE[0] + 1, HOLE[1] + 1, HOLE[2] + 1, E.EMPTY);
      sim.load(A, B);
    };
    // the bottom rows of the atlas hold every cell below y = 32 (supertiles run y-major)
    const yMax = 32, sty = Math.ceil(yMax / 8);
    const rows = Math.ceil((g.stx * g.stz * sty) / g.stw) * 32;
    const A = new Float32Array(g.width * rows * 4), B = new Float32Array(g.width * rows * 4);
    const read = () => sim.readStateRect(0, 0, g.width, rows, A, B, true);   // (as it is after the step: docs/webgpu.md W6)
    const at = (x, y, z) => sim.cellTexel(x, y, z) * 4;
    const isW = (i) => Math.round(A[i]) === E.WATER;

    build(E.CLONE);
    a.test.step(WARM);
    const exits = [], vOut = [], vHole = [], levels = Object.fromEntries(LEVELS.map((d) => [d, []])), gapsAll = [];
    const side = new Map(), front = new Map();   // long exposures: "x,y" / "z,y" → count
    let lastOut = null, jetCells = 0, frames = 0;
    for (let s = 0; s < SAMPLES; s++) {
      a.test.step(1);
      await read();
      let out = 0;
      const jet = [];
      for (let y = 0; y < yMax; y++) for (let z = 0; z < g.nz; z++) for (let x = OUT_X; x < g.nx; x++) {
        const i = at(x, y, z);
        if (!isW(i)) continue;
        out++;
        if (y >= JET_Y0) jet.push([x, y, z, B[i], B[i + 1], B[i + 2]]);
      }
      if (lastOut != null) exits.push(out - lastOut);
      lastOut = out;
      const h = at(...HOLE);
      if (isW(h)) vHole.push([B[h], B[h + 1], B[h + 2]]);
      for (const [x, y, z, vx, vy, vz] of jet) {
        if (x === OUT_X && Math.abs(y - HOLE[1]) <= 1) vOut.push([vx, vy, vz]);
        const d = HOLE[1] - y;
        if (levels[d]) levels[d].push([x, z, vx, vz]);
        side.set(`${x},${y}`, (side.get(`${x},${y}`) ?? 0) + 1);
        front.set(`${z},${y}`, (front.get(`${z},${y}`) ?? 0) + 1);
      }
      // gaps along the jet: its cells from the hole down, each to the nearest one below it
      jet.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
      for (let k = 0; k + 1 < jet.length; k++) {
        const [x, y, z] = jet[k];
        let best = Infinity;
        for (let m = k + 1; m < jet.length && jet[m][1] >= y - 10; m++)
          if (jet[m][1] < y) best = Math.min(best, Math.max(Math.abs(jet[m][0] - x), y - jet[m][1], Math.abs(jet[m][2] - z)) - 1);
        if (best < Infinity) gapsAll.push(best);
      }
      jetCells += jet.length; frames++;
    }

    // ---- summaries ----
    const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
    const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
    const r3 = (x) => +(+x).toFixed(3);
    const runs = [];   // steps with nothing leaving, between parcels
    let run = 0, seen = false;
    for (const e of exits) { if (e > 0) { if (seen) runs.push(run); run = 0; seen = true; } else run++; }
    const hist = (v) => { const o = {}; for (const x of v) o[x] = (o[x] ?? 0) + 1; return o; };
    const speed = (v) => v.map(([x, y, z]) => Math.hypot(x, y, z));
    const head = SURFACE - HOLE[1] - 0.5;   // free surface to the hole's centre, cells
    const levelRows = LEVELS.map((d) => {
      const L = levels[d], xs = L.map((c) => c[0]), zs = L.map((c) => c[1]);
      return { below: d, n: L.length, x: L.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : '-', 'sd x': r3(sd(xs)),
        z: L.length ? `${Math.min(...zs)}-${Math.max(...zs)}` : '-', 'sd z': r3(sd(zs)), 'vx': r3(mean(L.map((c) => c[2]))), 'sd vx': r3(sd(L.map((c) => c[2]))), 'sd vz': r3(sd(L.map((c) => c[3]))) };
    });
    const pic = (m, u0, u1) => {
      const lines = [];
      for (let y = HOLE[1] + 1; y >= JET_Y0; y--) {
        let l = '';
        for (let u = u0; u < u1; u++) { const c = (m.get(`${u},${y}`) ?? 0) / frames; l += c === 0 ? ' ' : c < 0.05 ? '.' : c < 0.2 ? ':' : c < 0.45 ? 'o' : '#'; }
        lines.push(`${String(y).padStart(2)} |${l}|`);
      }
      return lines.join('\n');
    };
    const summary = {
      head, torricelli: r3(Math.sqrt(2 * SIM_GRAVITY * head)), 'discharge cells/step (Cd 0.61)': r3(0.61 * Math.sqrt(2 * SIM_GRAVITY * head)),
      'exit cells/step': r3(mean(exits)), 'steps between parcels: mean': r3(mean(runs)), max: Math.max(...runs), 'runs hist': hist(runs),
      'exit |v| (x=40)': `${r3(mean(speed(vOut)))} ± ${r3(sd(speed(vOut)))}`, 'exit vx': `${r3(mean(vOut.map((v) => v[0])))} ± ${r3(sd(vOut.map((v) => v[0])))}`,
      'exit vz': `${r3(mean(vOut.map((v) => v[2])))} ± ${r3(sd(vOut.map((v) => v[2])))}`, 'exit samples': vOut.length,
      'hole vx': `${r3(mean(vHole.map((v) => v[0])))} ± ${r3(sd(vHole.map((v) => v[0])))}`, 'hole full share': r3(vHole.length / SAMPLES),
      'jet cells/step': r3(jetCells / frames), 'gap mean': r3(mean(gapsAll)), 'gap max': Math.max(...gapsAll), 'gaps hist': hist(gapsAll),
    };

    // ---- conservation: the tank with a water lid instead of the clone ----
    const count = async () => {
      const c = await sim.census(), o = {};
      for (const k in c) o[ELEMENTS[k].key] = c[k].n;
      return o;
    };
    build(E.WATER);
    const c0 = await count();
    a.test.step(CONSERVE_STEPS);
    const c1 = await count();
    const conserve = Object.keys({ ...c0, ...c1 }).filter((k) => c0[k] !== c1[k]).map((k) => `${k} ${c0[k]} → ${c1[k]}`);
    return { summary, levelRows, side: pic(side, OUT_X - 1, OUT_X + 60), front: pic(front, HOLE[2] - 12, HOLE[2] + 13), conserve, water: c0.WATER };
  }, [WARM, SAMPLES, CONSERVE_STEPS]);
  res.errs = errs;
} finally {
  await b.close();
}
console.log('exit and gaps:'); console.table(res.summary);
console.log('spread below the hole:'); console.table(res.levelRows);
console.log(`long exposure, side (x ${40 - 1}..${40 + 59} across):\n${res.side}`);
console.log(`long exposure, front (z ${64 - 12}..${64 + 12} across):\n${res.front}`);
console.log(`conservation (water ${res.water} cells, ${CONSERVE_STEPS} steps): ${res.conserve.length ? 'CHANGED: ' + res.conserve.filter((s) => !s.startsWith('EMPTY')).join(', ') : 'every element kept its count'}`);
console.log(res.errs.length ? res.errs.join('\n') : 'no console errors');
if (json) writeFileSync(json, JSON.stringify(res, null, 1));
