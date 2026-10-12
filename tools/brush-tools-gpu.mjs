// GPU check of TPT's brush tools (elements.js TOOLS -50..-57, shaders/passes.js
// paintFrag) on the real paint shader: one short headless run in manual mode
// (no stepping: only the brush writes the state), judged by reading it back.
//   Mix      a layered pile mixes, every element's cell count is unchanged, and
//            air, walls and pressure stay where they were
//   Vacuum   pressure falls by TOOL_PRESSURE a paint, to P_MIN
//   Wind     air takes uWind·TOOL_WIND, sand its 1/ρ share, walls nothing
//   Cyclone  counterclockwise from above: a cell east of the centre goes north (-z)
//   PGRV/NGRV matter at the edge pulled in / pushed out; air untouched
//   AMBP/AMBM air warms / cools by TOOL_HEAT at the centre; matter keeps its temperature
// Needs a dev server: npx vite --port 5197 --strictPort, then (every read is awaited: docs/webgpu.md W6)
// usage: node tools/brush-tools-gpu.mjs [--port 5197]
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5197');

const browser = await launchBrowser();
let failed = 0;
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:|Shader Error/.test(t)) errors.push(t.slice(0, 300));
  });
  await page.goto(`http://localhost:${port}/?size=64&preset=empty`);
  await ready(page);
  const res = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim;
    a.test?.park?.();
    await a.test.ready();   // (load and the brush need the grid's pipelines)
    const { E, ELEMENTS, TOOLS } = await import('/src/elements.js');
    const { PHYS } = await import('/src/physics.js');
    const T = Object.fromEntries(TOOLS.map((t) => [t.key, t.id]));
    const { nx, ny, nz } = sim.g;
    const c = [nx / 2, ny / 2, nz / 2];
    const cc = c.map((x) => x + 0.5);   // a cell's centre: the brush sits on cell c
    const out = [];
    const check = (ok, msg) => out.push(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
    const paint = (tool, { at = cc, radius = 8, shape = 0, wind = null, times = 1 } = {}) => {
      for (let i = 0; i < times; i++) sim.paint({ center: { x: at[0], y: at[1], z: at[2] }, radius, shape, tool, rate: 1, replace: false, wind });
    };
    // a fresh scene: fill(x, y, z) gives each cell's element key (null: air)
    const scene = (fill) => {
      const [A, B] = sim.blankState();
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
        const key = fill(x, y, z);
        if (!key) continue;
        const id = E[key], i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = Math.random() * 0.999;
      }
      sim.load(A, B);
    };
    // a cell as it is now (read back: docs/webgpu.md W6)
    const cell = async (x, y, z) => { const [A, B] = await sim.readCell(x, y, z); return { id: Math.round(A[0]), T: A[1], v: [B[0], B[1], B[2]], P: B[3] }; };
    const near = (x, want, tol = 1e-3) => Math.abs(x - want) <= tol * Math.max(1, Math.abs(want));

    // ---- Mix ----
    const layer = (y) => ['SAND', 'SALT', 'WATER', 'OIL', 'STEAM', 'SMOKE'][(y >> 1) % 6];
    scene((x, y, z) => (Math.hypot(x + 0.5 - c[0], z + 0.5 - c[2]) < 12 && y < 2 * c[1] ? ((x + y + z) % 11 === 0 ? 'WALL' : (y % 7 === 6 ? null : layer(y))) : null));
    const [A0, B0] = await sim.readState();
    paint(T.MIX, { radius: 10, times: 400 });
    const [A1, B1] = await sim.readState();
    const count = (A) => { const n = {}; for (let i = 0; i < A.length; i += 4) n[Math.round(A[i])] = (n[Math.round(A[i])] ?? 0) + 1; return n; };
    const n0 = count(A0), n1 = count(A1);
    const same = Object.keys({ ...n0, ...n1 }).every((k) => n0[k] === n1[k]);
    let changed = 0, fixed = 0, pMoved = 0;
    for (let i = 0; i < A0.length; i += 4) {
      const i0 = Math.round(A0[i]), i1 = Math.round(A1[i]);
      if (i0 !== i1) changed++;
      if ((i0 === E.EMPTY || i0 === E.WALL) && i1 !== i0) fixed++;
      if (B0[i + 3] !== B1[i + 3]) pMoved++;
    }
    check(same, `Mix keeps every element's cell count (${Object.keys(n0).length} elements)`);
    check(changed > 0, `Mix mixed ${changed} cells`);
    check(fixed === 0, `Mix never moves air or walls (${fixed})`);
    check(pMoved === 0, `Mix leaves pressure in place (${pMoved})`);

    // ---- Vacuum ----
    scene(() => null);
    paint(T.VACUUM);
    const p1 = (await cell(c[0], c[1], c[2])).P;
    check(near(p1, -PHYS.TOOL_PRESSURE), `Vacuum: -${PHYS.TOOL_PRESSURE} at the centre (${p1})`);
    paint(T.VACUUM, { times: 20 });
    const p2 = (await cell(c[0], c[1], c[2])).P;
    check(near(p2, PHYS.P_MIN), `Vacuum stops at P_MIN (${p2})`);

    // ---- Wind, Cyclone, gravity wells, ambient heat: on air, a sand cell and a wall cell ----
    const [sx, sy, sz] = [c[0] + 6, c[1], c[2]];   // east of the centre, inside the brush's falloff
    const fresh = () => scene((x, y, z) => (x === sx && y === sy && z === sz ? 'SAND' : x === sx - 1 && y === sy && z === sz ? 'WALL' : null));
    // after a tool: the cell beside the centre (air), the sand cell, the wall cell and the centre
    const look = async () => {
      const [air, sand, wall, centre] = await Promise.all([cell(c[0] + 1, c[1], c[2]), cell(sx, sy, sz), cell(sx - 1, sy, sz), cell(c[0], c[1], c[2])]);
      return { air, sand, wall, centre };
    };
    fresh();
    paint(T.WIND, { wind: [2, 0, 0] });
    let k = await look();
    const ra = PHYS.RHO_MIN / Math.max(ELEMENTS[E.SAND].dens * PHYS.RHO_SCALE, PHYS.RHO_MIN);
    check(near(k.air.v[0], 2 * PHYS.TOOL_WIND, 0.02), `Wind: air +x at ${k.air.v[0].toFixed(3)} (want ${2 * PHYS.TOOL_WIND})`);
    check(k.sand.v[0] > 0 && k.sand.v[0] < k.air.v[0] * ra * 1.01, `Wind: sand takes its share (${k.sand.v[0].toFixed(4)})`);
    check(k.wall.v.every((v) => v === 0), 'Wind: walls stay still');
    fresh();
    paint(T.CYCLONE);
    k = await look();
    check(k.sand.v[2] < 0 && Math.abs(k.sand.v[0]) < 1e-6, `Cyclone: east of the centre goes north (-z): ${k.sand.v.map((v) => v.toFixed(4))}`);
    fresh();
    paint(T.GRAV_IN);
    k = await look();
    check(k.sand.v[0] < 0 && k.air.v.every((v) => v === 0), `PGRV pulls sand in (${k.sand.v[0].toFixed(3)}), not air`);
    fresh();
    paint(T.GRAV_OUT);
    k = await look();
    check(k.sand.v[0] > 0, `NGRV pushes sand out (${k.sand.v[0].toFixed(3)})`);
    fresh();
    const T0 = (await cell(sx, sy, sz)).T;
    paint(T.AMB_HEAT);
    k = await look();
    check(near(k.centre.T, PHYS.AMBIENT + PHYS.TOOL_HEAT) && k.sand.T === T0, `AMBP warms air (${k.centre.T}), not sand (${k.sand.T})`);
    fresh();
    paint(T.AMB_COOL);
    k = await look();
    check(near(k.centre.T, PHYS.AMBIENT - PHYS.TOOL_HEAT) && k.sand.T === T0, `AMBM cools air (${k.centre.T}), not sand`);
    return out;
  });
  for (const line of res) { console.log(line); if (line.startsWith('FAIL')) failed++; }
  for (const e of errors) { console.log(`ERROR ${e}`); failed++; }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'brush tools: all GPU checks pass');
process.exit(failed ? 1 : 0);
