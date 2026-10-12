// The outcome bench's engine on the game itself, at a URL (tools/outcomes.mjs
// runs it in Node over a Playwright page): the app tests (tests/world.js) boot
// a scene the game makes for itself (?map=island&win=64) and measure it through
// window.__app only, so the same test runs on any build served at any URL:
// today's checkout, the frozen /v1/ build, a v2 candidate (--app-query
// engine=v2). Contract: ./engine.js; box() is not offered (the scene is the
// game's), and read() isn't either (a world window is half a million cells:
// census() counts in the page).
//   clock     the game's steps a second: sim.stepsPerSecond when it has one
//             (v2's tick), else settings.steps a frame at 60 frames a second
//             (app.js tick; physics.js NOMINAL_STEP_RATE)
//   advance   __app.test.step(n) on the parked page (CLAUDE.md: manual mode)
//   activity  __app.sim.readCounts() and __app.sim.idleCertified
import { newTestPage } from '../browser.mjs';
import { stepClock } from './engine.js';

// bench names that are named otherwise in the game's table
const TODAY = { AIR: 'EMPTY', FLOUR: 'DUST' };
const KINDS = ['air', 'solid', 'powder', 'liquid', 'gas'];   // elements.js K
const LOAD_TIMEOUT = 300000;   // ms a world may take to boot on SwiftShader (smoke.mjs, world-check.mjs)

/**
 * @param {import('playwright').Browser} browser
 * @param {{ base: string, query?: string, errors?: string[] }} opts base: the server's origin
 *   (http://127.0.0.1:PORT); query: added to every test's URL (engine=v2)
 */
export function createEngine(browser, { base, query = '', errors = [] }) {
  let page = null, meta = null, clock = stepClock(240);
  const engine = {
    name: 'app', app: true,
    info: { label: '', stepsPerSecond: 240, gravity: NaN, cellM: 0.3, fillQuantum: 1, pressure: false, burning: false },
    id: (name) => { const k = TODAY[name] ?? name, i = meta?.keys.indexOf(k) ?? -1; return i >= 0 ? i : null; },
    nameOf: (id) => { const k = meta?.keys[id] ?? `#${id}`; return Object.entries(TODAY).find(([, t]) => t === k)?.[0] ?? k; },
    kindOf: (id) => KINDS[meta?.kinds[id]] ?? 'solid',
    async create(size, { url }) {
      await engine.dispose();
      page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`); });
      await page.goto(`${base}${url}${query ? `${url.includes('?') ? '&' : '?'}${query}` : ''}`);
      await page.waitForFunction(() => (window.__app?.sim && (!window.__app.win || window.__app.win.loaded)) || document.getElementById('error')?.textContent,
        null, { polling: 250, timeout: LOAD_TIMEOUT });
      const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
      if (failed) throw new Error(`boot: ${failed.slice(0, 300)}`);
      meta = await page.evaluate(async () => {
        const a = window.__app;
        await a.test.ready();
        a.test.park();
        const { ELEMENTS } = await import('/src/elements.js');
        const info = a.gpu?.adapterInfo ?? {};
        return {
          keys: ELEMENTS.map((e) => e?.key ?? ''), kinds: ELEMENTS.map((e) => e?.kind ?? 1),
          sps: a.sim.stepsPerSecond ?? a.settings.steps * 60, size: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
          adapter: `${info.vendor ?? ''} ${info.architecture ?? ''}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
        };
      });
      clock = stepClock(meta.sps);
      Object.assign(engine.info, { label: `the game at ${base}${url}${query ? ` +${query}` : ''}, ${meta.adapter}`, stepsPerSecond: meta.sps });
    },
    box() { throw new Error('app: the scene is the game\'s own (no box writes)'); },
    async advance(seconds) {
      const n = clock.take(seconds);
      await page.evaluate(async (n) => {
        const a = window.__app, sim = a.sim;
        for (let k = 0; k < n; k++) {
          a.test.step(1);
          if ((k & 15) === 15) { await sim.gpuSync(); if (sim.idleRead) await sim.idleRead; }
        }
        await sim.gpuSync();
      }, n);
    },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() { throw new Error('app: read() is not offered (census() counts in the page)'); },
    async census() {
      const c = await page.evaluate(async () => {
        const sim = window.__app.sim, g = sim.g, [A] = await sim.readState();
        const n = {};
        for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
          const id = Math.floor(A[sim.cellTexel(x, y, z) * 4] + 0.5);
          n[id] = (n[id] ?? 0) + 1;
        }
        return n;
      });
      const cells = {}, classes = {}, liquid = {};
      for (const [id, k] of Object.entries(c)) {
        const name = engine.nameOf(+id), kind = engine.kindOf(+id);
        cells[name] = k;
        classes[kind] = (classes[kind] ?? 0) + k;
        if (kind === 'liquid') liquid[name] = k;
      }
      return { size: meta.size, cells, classes, liquid, particles: {} };
    },
    async activity() {
      return page.evaluate(async () => {
        const sim = window.__app.sim;
        await sim.gpuSync();
        if (sim.idleRead) await sim.idleRead;
        const c = await sim.readCounts();
        return { awake: c.awake, units: c.units, idle: sim.idleCertified };
      });
    },
    fall: () => null,
    flight: () => null,
    park: () => page.evaluate(() => window.__app.test.park()),
    resume: () => page.evaluate(() => window.__app.test.resume()),
    async dispose() { await page?.close().catch(() => {}); page = null; },
  };
  return engine;
}
