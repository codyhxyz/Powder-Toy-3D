// Water's look, for a before/after pair: a splash landing on the box floor,
// a shallow puddle at a few centimetres of fill, and a deep pool whose top
// cell is part full. The cells are V2's own (exact fills), written straight
// into the engine's state, so the fixture is the same on every build.
// node tools/water-look-check.mjs --out <dir> --label before|after [--port 18617]
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const port = Number(opt('port', '18617')), out = opt('out', '/tmp/tpt-water-look'), label = opt('label', 'after');
mkdirSync(out, { recursive: true });
// Ticks the splash falls and spreads before each of its shots (the blob drops
// SPLASH_DROP cells, ~7 m: about a second and a half at 60 Hz, then lands).
const SPLASH_TICKS = [90, 140];
// Camera (eye, target) in cells for each shot.
const VIEWS = {
  puddle: [[80, 9, 70], [80, 0, 32]],
  pool: [[26, 30, 66], [26, 16, 24]],
  splash: [[79, 12, 116], [79, 0, 86]],
};
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'error',
});
let browser;
const t0 = Date.now();
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?map=empty&paused=1`);
  await ready(page);
  await page.addStyleTag({ content: 'body *{visibility:hidden !important} canvas{visibility:visible !important}' });
  await page.evaluate(async () => {
    const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js');
    const { makeMaterial, FULL } = await import('/src/v2/layout.js');
    const { encodeV2State, decodeV2State } = await import('/src/v2/state.js');
    const { cellSlot } = await import('/src/shaders/common.js');
    await a.test.ready();
    a.test.park(); a.autoRes.enabled = false; a.settings.upscale = 'native';
    a.day.fixed = { az: 35, el: 40 };
    const v2 = a.sim.compact, g = a.sim.g;
    // The scene as whole cells (sim.load, as the presets do), one tick for V2
    // to take it in and wake, then V2's own cells with their exact fills.
    const P0 = 8, P1 = 44, PH = 20, POOL_TOP_FILL = 0.6;   // a wall basin 6 m deep, its top row 60 % full
    const C = [80, 30], R = 18, MID = 0.15, RIM = 0.03;    // a puddle 4.5 cm deep in the middle, 1 cm at its rim
    const scene = (put) => {
      for (let y = 0; y <= PH + 1; y++) for (let z = P0; z < P1; z++) for (let x = P0; x < P1; x++) {
        const rim = x === P0 || z === P0 || x === P1 - 1 || z === P1 - 1;
        if (rim) put(x, y, z, E.WALL);
        else if (y < PH) put(x, y, z, E.WATER, y === PH - 1 ? POOL_TOP_FILL : 1);
      }
      for (let z = C[1] - R - 2; z <= C[1] + R + 2; z++) for (let x = C[0] - R - 2; x <= C[0] + R + 2; x++) {
        const d = Math.hypot(x - C[0], z - C[1]) / R;
        put(x, 0, z, d <= 1 ? E.WATER : E.EMPTY, MID + (RIM - MID) * d);
      }
    };
    const [A, B] = a.sim.blankState();
    const legacy = (x, y, z, id) => { const i = a.sim.cellTexel(x, y, z) * 4; A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = 0.5; };
    scene(legacy);
    // a blob of water in the air over the floor, to drop
    for (let y = 24; y < 30; y++) for (let z = 84; z < 90; z++) for (let x = 76; x < 82; x++) legacy(x, y, z, E.WATER);
    a.sim.load(A, B);
    a.test.step(1);
    const state = decodeV2State(await v2.captureState(), [g.nx, g.ny, g.nz]);
    scene((x, y, z, id, fill = 1) => {
      const m = makeMaterial(id, ELEMENTS[id].temp, id === E.WATER ? Math.round(fill * FULL) : FULL);
      state.cells.set(m.core, cellSlot(g, x, y, z) * 4);
    });
    v2.restoreState(encodeV2State({ ...state, certified: false }));
  });
  // the fields at the puddle's middle and near its rim, up its column (liquid channel: surface, thin mask)
  const probe = () => page.evaluate(async () => {
    const a = window.__app, { halfsToFloats } = await import('/src/gpu/readback.js'), g = a.sim.g;
    const d = await a.sim.derived.read(), S = halfsToFloats(d.fieldSurf), T = halfsToFloats(d.fieldThin);
    const at = (x, y, z) => (x + g.nx * (y + g.ny * z)) * 4;
    return [[80, 30], [92, 30]].map(([x, z]) => [0, 1, 2].map(y => `${S[at(x, y, z)].toFixed(3)}/${T[at(x, y, z)].toFixed(2)}`).join(' '));
  });
  const shoot = async (name) => {
    const [pos, tgt] = VIEWS[name.split('-')[0]];
    await page.evaluate(([pos, tgt]) => {
      const a = window.__app, T = a.THREE;
      a.camera.position.set(...pos).multiplyScalar(a.scale).add(a.volume.position);
      a.camera.lookAt(new T.Vector3(...tgt).multiplyScalar(a.scale).add(a.volume.position));
      a.camera.updateMatrixWorld(); a.post.reset();
    }, [pos, tgt]);
    await render(page);
    await page.screenshot({ path: `${out}/water-${label}-${name}.png` });
  };
  await shoot('puddle');
  console.log('puddle fields (surface/thin, y = 0 1 2):', JSON.stringify(await probe()));
  await shoot('pool');
  let done = 0;
  for (const [i, n] of SPLASH_TICKS.entries()) {
    const info = await page.evaluate(async n => {
      const a = window.__app, v2 = a.sim.compact;
      a.test.step(n);
      const c = await v2.readCells(), stats = await v2.readStats();
      let cells = 0, fill = 0, airborne = 0;
      for (let i = 0; i < c.fill.length; i++) if (c.fill[i] > 0) { cells++; fill += c.fill[i]; if (i >= a.sim.g.nx * a.sim.g.nz && c.fill[i - a.sim.g.nx * a.sim.g.nz] === 0 && c.id[i - a.sim.g.nx * a.sim.g.nz] === 0) airborne++; }
      return { tick: stats.tick, cells, fill: +fill.toFixed(1), airborne };
    }, n - done);
    console.log(`splash after ${n} ticks:`, JSON.stringify(info));
    done = n;
    await shoot(`splash-${i}`);
  }
  console.log(label, errors.length ? errors.slice(0, 5) : 'no errors', `${((Date.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await browser?.close();
  await server.close();
}
