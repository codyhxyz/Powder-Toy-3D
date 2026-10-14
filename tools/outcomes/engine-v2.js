// The outcome bench's engine on v2's fast version (docs/v2.md 5; src/v2/physics.js over
// src/shaders/v2.js): today's Simulation holds the state its writers write, as the game's
// ?physics=v2 does, and PhysicsV2 ticks beside it. Runs in tools/harness/outcomes.html
// (?engine=v2, `node tools/outcomes.mjs --engine v2`). Contract: ./engine.js.
//   clock     60 ticks a game second (Speed 1×), 2 g (19.6 m/s²)
//   box       one edit of today's state (sim.editKernel, as engine-v1.js), which v2 imports:
//             a liquid comes in full; thrown matter (v) isn't in this version
//   read      v2's own cells: id, a liquid's fill (2⁻¹⁶ of a cell), T; no particles yet
//   activity  awake bricks of v2's last tick, and its idle certificate: no brick awake and
//             nothing written since; idleSince is the tick after the last busy one
//   fall      R1's column-fall law, the column pass's own (shaders/v2.js fallCells)
//   flight    none: particles (throws) aren't in this version
// The full P2 adapter (docs/v2.md 11) adds velocities, particles, burning and pressure.
import { Simulation } from '/src/sim.js';
import { PhysicsV2 } from '/src/v2/physics.js';
import { E, ELEMENTS } from '/src/elements.js';
import { CELL_M } from '/src/scale.js';
import { TICK_HZ, G_MS2, FULL, V2, v2Rows, fallCells } from '/src/shaders/v2.js';
import { stepClock } from './engine.js';
import { tally } from './lib.js';

// bench names that are named otherwise today
const TODAY = { AIR: 'EMPTY', FLOUR: 'DUST' };
const BENCH = Object.fromEntries(Object.entries(TODAY).map(([b, t]) => [t, b]));
const KINDS = { [V2.AIR]: 'air', [V2.SOLID]: 'solid', [V2.POWDER]: 'powder', [V2.LIQUID]: 'liquid', [V2.GAS]: 'gas' };
const ROWS = v2Rows();

// The box writer: every cell of the box (or every air cell of it) gets the element (engine-v1.js's).
const BOX = {
  update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (P.onlyEmpty != 0u && eid(a) != E_EMPTY) { return; }
  *oA = vec4f(f32(P.id), P.temp, P.life, P.ctype + fract(a.w));
  *oB = vec4f(0.0);
}`,
  params: { id: 'i32', temp: 'f32', life: 'f32', ctype: 'f32', onlyEmpty: 'u32' },
};

/**
 * @param {object} gpu the page's gpu (tools/harness/harness.js boot)
 * @param {{ seed?: (s: number) => void }} [opts] seed: seeds Math.random (the blank state's cell seeds)
 */
export function createEngine(gpu, { seed = () => {} } = {}) {
  let sim = null, v2 = null, kernel = null, clock = stepClock(TICK_HZ);
  const idOf = (name) => { const k = TODAY[name] ?? name; return k in E ? E[k] : null; };
  const engine = {
    name: 'v2',
    info: {
      label: `v2 fast version (src/v2/physics.js), ${gpu.adapterInfo.vendor} ${gpu.adapterInfo.architecture}${gpu.adapterInfo.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
      stepsPerSecond: TICK_HZ, clock: `${TICK_HZ} ticks a game second (Speed 1×)`,
      gravity: G_MS2, cellM: CELL_M, fillQuantum: 1 / FULL, velocity: false, pressure: false, airCell: null, burning: false,
    },
    id: idOf,
    nameOf: (id) => { const k = ELEMENTS[id]?.key ?? `#${id}`; return BENCH[k] ?? k; },
    kindOf: (id) => KINDS[ROWS[id]?.cls] ?? 'solid',
    async create([nx, ny, nz], { seed: s = 1 } = {}) {
      await engine.dispose();
      seed(s);
      sim = new Simulation(gpu, nx, ny, nz, { debug: false });
      kernel = sim.editKernel('outcomeBoxV2', BOX);
      v2 = new PhysicsV2(sim);
      await Promise.all([sim.ready, kernel.ready, v2.ready]);
      clock = stepClock(TICK_HZ);
    },
    box(lo, hi, name, { T, v = [0, 0, 0], onlyEmpty = false } = {}) {
      const id = idOf(name);
      if (id === null) throw new Error(`v2: no element ${name}`);
      if (v.some((c) => c)) throw new Error('v2: no thrown matter in the fast version (particles are left out)');
      const e = ELEMENTS[id];
      sim.edit(kernel, { lo, hi }, { id, temp: T ?? e.temp, life: e.life, ctype: id === E.LAVA ? E.STONE : 0, onlyEmpty: onlyEmpty ? 1 : 0 });
    },
    async advance(seconds) {
      const n = clock.take(seconds);
      for (let k = 0; k < n; k += 16) {
        v2.ticks(Math.min(16, n - k));
        await sim.gpuSync();
      }
    },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() {
      v2.sync();   // (a write since the last tick: v2 imports it first)
      const c = await v2.readCells();
      return { nx: sim.g.nx, ny: sim.g.ny, nz: sim.g.nz, id: c.id, amount: c.fill, T: c.T, burning: null, pressure: null, moving: null, vel: null, particles: [] };
    },
    async census() { return tally(await engine.read(), engine); },
    async activity() {
      v2.sync();
      const s = await v2.readStats();
      const idle = s.awake === 0 && s.tick > 0 && v2.unwrittenSinceTick;
      return { awake: s.awake, units: s.units, idle, idleSince: idle ? (s.lastBusy + 1) / TICK_HZ : undefined };
    },
    fall(name, seconds) {
      const id = idOf(name);
      if (id === null || ROWS[id].cls !== V2.POWDER) return null;
      return fallCells(id, Math.round(seconds * TICK_HZ));
    },
    flight: () => null,
    park() {}, resume() {},
    async dispose() { v2?.dispose(); sim?.dispose(); v2 = null; sim = null; kernel = null; },
  };
  return engine;
}
