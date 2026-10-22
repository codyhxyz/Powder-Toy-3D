// The outcome bench's engine on the game itself, at a URL (tools/outcomes.mjs
// runs it in Node over a Playwright page): the app tests (tests/world.js) boot
// a scene the game makes for itself (?map=island&win=64) and measure it through
// window.__app, so the same test runs on any checkout's dev server: this one
// (Physics V2, the only engine), or the frozen V1 oracle (a checkout of the
// v1-oracle tag, with --engine v1 --app-url). The element table comes from __app.test.elements ([{ key, kind }])
// when the build offers it, else from the page's own /src/elements.js, which
// only a dev server serves: a bundled build (a deploy, the /v1/ build) needs
// the hook (today's app has none, so --app-url must be a dev server). Contract:
// ./engine.js; box() is not offered (the scene is the game's). Native read()
// and census() include canonical grid/particles/air, including outside packets.
//   clock     the game's steps a game second: sim.stepsPerSecond when it has
//             one (v2's 60 ticks, Speed 1×: engine-v2.js), else settings.steps
//             a frame at 60 frames a second (app.js tick; physics.js
//             NOMINAL_STEP_RATE)
//   advance   __app.test.step(n) on the parked page (CLAUDE.md: manual mode)
//   activity  __app.sim.readCounts() and __app.sim.idleCertified
import { newTestPage } from '../browser.mjs';
import { toGrid, nativeTally, nativeFall, nativeFlight } from './native-grid.js';
import { stepClock, SetupError } from './engine.js';
import { GRAVITY_MS2 } from '../../src/v2/gravity.js';

// A requested engine is not proof of the engine that actually stepped (worlds currently fall back).
export function appPhysicsClock({ expectedPhysics, physics, stepsPerSecond, steps }) {
  const active = physics?.active === true;
  if (expectedPhysics === 'v2' && !active) throw new SetupError('v2 was requested, but this scene runs v1 physics');
  if (expectedPhysics === 'v1' && active) throw new SetupError('v1 was requested, but this scene runs v2 physics');
  return active ? 60 : (stepsPerSecond ?? steps * 60);
}

// bench names that are named otherwise in the game's table
const TODAY = { AIR: 'EMPTY', FLOUR: 'DUST' };
const KINDS = ['air', 'solid', 'powder', 'liquid', 'gas'];   // elements.js K
const LOAD_TIMEOUT = 300000;   // ms a world may take to boot on SwiftShader (smoke.mjs, world-check.mjs)

/**
 * @param {import('playwright').Browser} browser
 * @param {{ base: string, query?: string, errors?: string[] }} opts base: the server's origin
 *   (http://127.0.0.1:PORT); query: added to every test's URL
 * @param {'v1'|'v2'} opts.expectedPhysics the engine the result claims to measure (v1: the v1-oracle tag's checkout)
 */
export function createEngine(browser, { base, query = '', errors = [], expectedPhysics = 'v2' }) {
  let page = null, meta = null, clock = stepClock(240);
  const engine = {
    name: 'app', app: true,
    info: { label: '', stepsPerSecond: 240, clock: '', gravity: NaN, cellM: 0.3, fillQuantum: 1, velocity: false, pressure: false, airCell: null, burning: false },
    id: (name) => { const k = TODAY[name] ?? name, i = meta?.keys.indexOf(k) ?? -1; return i >= 0 ? i : null; },
    nameOf: (id) => { const k = meta?.keys[id] ?? `#${id}`; return Object.entries(TODAY).find(([, t]) => t === k)?.[0] ?? k; },
    kindOf: (id) => KINDS[meta?.kinds[id]] ?? 'solid',
    async create(size, { url }) {
      await engine.dispose();
      page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`); });
      const boot = async () => {
        await page.goto(`${base}${url}${query ? `${url.includes('?') ? '&' : '?'}${query}` : ''}`);
        await page.waitForFunction(() => (window.__app?.sim && (!window.__app.win || window.__app.win.loaded)) || document.getElementById('error')?.textContent,
          null, { polling: 250, timeout: LOAD_TIMEOUT });
        return page.evaluate(() => document.getElementById('error')?.textContent || null);
      };
      let failed = await boot();
      // a server whose dependency cache is cold re-optimizes on the first load, and with HMR off the
      // page's first import of the app fails: once more, warm
      if (failed && /Failed to fetch dynamically imported module/.test(failed)) failed = await boot();
      if (failed) throw new Error(`boot: ${failed.slice(0, 300)}`);
      meta = await page.evaluate(async () => {
        const a = window.__app;
        await a.test.ready();
        a.test.park();
        // (a build's own table when it offers one; else the checkout's module, which only a dev server serves)
        const table = a.test.elements ?? (await import('/src/elements.js').catch((err) => {
          throw new Error(`no element table: __app.test.elements is missing and /src/elements.js didn't load (${err.message}): --app-url must be a dev server of a checkout`);
        })).ELEMENTS;
        const info = a.gpu?.adapterInfo ?? {};
        return {
          keys: table.map((e) => e?.key ?? ''), kinds: table.map((e) => e?.kind ?? 1),
          physics: { mode: a.physics?.mode, active: a.physics?.active === true, nativeReady: a.physics?.v2?.contactReady === true && a.physics?.v2?.dynamics?.isReady === true },
          stepsPerSecond: a.sim.stepsPerSecond, steps: a.settings.steps, size: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
          adapter: `${info.vendor ?? ''} ${info.architecture ?? ''}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
        };
      });
      if (meta.physics.active && !meta.physics.nativeReady) throw new SetupError('app: native contact/dynamics integration is unavailable');
      meta.sps = appPhysicsClock({ expectedPhysics, ...meta });
      clock = stepClock(meta.sps);
      Object.assign(engine.info, {
        label: `the game at ${base}${url}${query ? ` +${query}` : ''}, ${meta.adapter}`, stepsPerSecond: meta.sps,
        clock: meta.physics.active || meta.stepsPerSecond ? `${meta.sps} ticks a game second` : `${meta.sps} steps a game second (${meta.steps} a frame at 60 fps)`,
        fillQuantum: meta.physics.active ? 1 / 65536 : 1,
        velocity: false,
        velocityDetails: meta.physics.active ? 'No complete cell velocities: partial SI particles, powder fall and air vectors do not establish resident-liquid kinetic energy' : 'Legacy app read() is not offered',
        pressure: meta.physics.active, burning: meta.physics.active, airCell: meta.physics.active ? 4 : null,
        gravity: meta.physics.active ? GRAVITY_MS2 : NaN,
      });
    },
    box() { throw new Error('app: the scene is the game\'s own (no box writes)'); },
    async advance(seconds) {
      const n = clock.take(seconds);
      await page.evaluate(async (n) => {
        const a = window.__app, sim = a.sim;
        for (let k = 0; k < n; k++) {
          a.test.step(1);
          if ((k & 15) === 15) {
            await sim.gpuSync();
            await (a.physics?.active ? a.physics.v2.idleRead : sim.idleRead);
          }
        }
        await sim.gpuSync();
      }, n);
    },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() {
      if (!meta.physics.active) throw new Error('app: legacy read() is not offered');
      const raw = await page.evaluate(async () => {
        const v2 = window.__app.physics.v2;
        v2.sync();
        const d = v2.dynamics, origin = v2.sim.origin;
        if (!v2.isReady || !v2.contactReady || !d?.isReady) throw new Error('app: native physics is not ready');
        const buffers = [v2.cells, v2.aux, d.particles, d.air[d.airIndex]];
        const reads = buffers.map(b => v2.gpu.readback.buffer(b, 0, b.size));
        return { layout: v2.g, origin: [origin.x, origin.y, origin.z], words: (await Promise.all(reads)).map(b => Array.from(new Uint32Array(b))) };
      });
      const [cells, banks, particles, air] = raw.words.map(w => new Uint32Array(w).buffer);
      return toGrid({ ...raw, cells, banks, particles, air });
    },
    async census() {
      if (meta.physics.active) return nativeTally(await engine.read(), engine);
      const c = await page.evaluate(async () => {
        const a = window.__app, sim = a.sim, g = sim.g, n = {}, liquid = {};
        const [A] = await sim.readState();
        for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
          const id = Math.floor(A[sim.cellTexel(x, y, z) * 4] + 0.5);
          n[id] = (n[id] ?? 0) + 1;
        }
        return { n, liquid: null };
      });
      const cells = {}, classes = {}, liquid = {};
      for (const [id, k] of Object.entries(c.n)) {
        const name = engine.nameOf(+id), kind = engine.kindOf(+id);
        cells[name] = k;
        classes[kind] = (classes[kind] ?? 0) + k;
        if (kind === 'liquid') liquid[name] = c.liquid ? (c.liquid[id] ?? 0) : k;
      }
      return { size: meta.size, cells, classes, liquid, particles: {} };
    },
    async activity() {
      return page.evaluate(async () => {
        const a = window.__app, sim = a.sim;
        if (a.physics?.active) {
          const v2 = a.physics.v2;
          v2.sync();
          const [c] = await Promise.all([v2.readStats(), v2.dynamics.readActivity()]);
          const idle = c.awake === 0 && c.tick > 0 && v2.unwrittenSinceTick && v2.dynamics.isIdle;
          return { awake: c.awake, units: c.units, idle };
        }
        await sim.gpuSync();
        if (sim.idleRead) await sim.idleRead;
        const c = await sim.readCounts();
        return { awake: c.awake, units: c.units, idle: sim.idleCertified };
      });
    },
    fall: (name, seconds) => meta?.physics.active ? nativeFall(engine.id(name), seconds) : null,
    flight: (name, v, seconds) => meta?.physics.active ? nativeFlight(engine.id(name), v, seconds) : null,
    park: () => page.evaluate(() => window.__app.test.park()),
    resume: () => page.evaluate(() => window.__app.test.resume()),
    async dispose() { await page?.close().catch(() => {}); page = null; },
  };
  return engine;
}
