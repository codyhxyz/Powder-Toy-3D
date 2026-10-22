// The outcome bench's engine on today's build: the Simulation of src/sim.js
// (docs/webgpu.md C, D) on the page's WebGPU device, no app, as
// tools/harness/sim-check.js drives it. Runs in tools/harness/outcomes.html.
// Contract: ./engine.js.
//   clock     NOMINAL_STEP_RATE steps a game second (physics.js: 4 a frame at
//             60 fps, the game's default), SIM_GRAVITY cells/step² at it:
//             432 m/s² at 0.30 m cells, today's ~44 g
//   box       one edit (sim.editKernel, docs/webgpu.md D6): A = (id, T, life,
//             ctype + the cell's own seed), B = (v in cells/step, pressure);
//             the bricks it changes are marked, so the next step wakes them
//   liquids   whole cells (fill 1), so a level moves in steps of a cell
//   read      B's velocity (cells/step) as m/s; B's pressure per cell (the
//             air cell is the cell: airCell 1)
//   burning   a flammable cell that has burnt some of its life (react.js: fuel
//             at its ignition point burns `life` down)
//   activity  sim.readCounts() AWAKE units and sim.idleCertified (D4's idle
//             check: AWAKE and DRAWN both 0)
//   fall, flight  the react pass's own velocity rule, step by step (gravity,
//             then drag v *= 1 - drag, clamped to V_MAX; the move spends last
//             step's velocity first): audit-physics' "ideal"
import { Simulation, cellTexel } from '/src/sim.js';
import { E, ELEMENTS, K } from '/src/elements.js';
import { CELL_M } from '/src/scale.js';
import { NOMINAL_STEP_RATE, SIM_GRAVITY, PHYS } from '/src/physics.js';
import { stepClock } from './engine.js';
import { tally } from './lib.js';

// bench names that are named otherwise today
const TODAY = { AIR: 'EMPTY', FLOUR: 'DUST' };
const BENCH = Object.fromEntries(Object.entries(TODAY).map(([b, t]) => [t, b]));
const KINDS = { [K.EMPTY]: 'air', [K.SOLID]: 'solid', [K.POWDER]: 'powder', [K.LIQUID]: 'liquid', [K.GAS]: 'gas' };

// The box writer: every cell of the box (or every air cell of it) gets the element.
const BOX = {
  update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (P.onlyEmpty != 0u && eid(a) != E_EMPTY) { return; }
  *oA = vec4f(f32(P.id), P.temp, P.life, P.ctype + fract(a.w));
  *oB = vec4f(P.vel, select(b.w, P.pressure, P.setPressure != 0u));
}`,
  params: { id: 'i32', temp: 'f32', life: 'f32', ctype: 'f32', vel: 'vec3f', pressure: 'f32', onlyEmpty: 'u32', setPressure: 'u32' },
};

const STEPS_PER_S = NOMINAL_STEP_RATE;

/**
 * @param {object} gpu the page's gpu (tools/harness/harness.js boot)
 * @param {{ seed?: (s: number) => void }} [opts] seed: seeds Math.random (the blank state's cell seeds)
 */
export function createEngine(gpu, { seed = () => {} } = {}) {
  let sim = null, kernel = null, clock = stepClock(STEPS_PER_S), texel = null;
  const idOf = (name) => { const k = TODAY[name] ?? name; return k in E ? E[k] : null; };
  // the react pass's velocity rule for a cell of `name`, step by step, in cells/step
  const law = (name) => {
    const id = idOf(name), e = id === null ? null : ELEMENTS[id];
    if (!e || (e.kind !== K.POWDER && e.kind !== K.LIQUID)) return null;
    // (liquids skip drag in free fall: react.js, audit-physics B8)
    return { g: SIM_GRAVITY * (e.grav ?? 1), drag: e.kind === K.LIQUID ? 0 : e.drag, vmax: PHYS.V_MAX };
  };
  const integrate = (L, v0, seconds) => {
    let x = 0, y = 0, [vx, vy] = v0;
    for (let k = 0; k < Math.round(seconds * STEPS_PER_S); k++) {
      x += vx; y += vy;
      vy -= L.g; vx *= 1 - L.drag; vy *= 1 - L.drag;
      vx = Math.max(-L.vmax, Math.min(L.vmax, vx)); vy = Math.max(-L.vmax, Math.min(L.vmax, vy));
    }
    return [x, y];
  };
  const engine = {
    name: 'v1',
    info: {
      label: `today's Simulation (src/sim.js), ${gpu.adapterInfo.vendor} ${gpu.adapterInfo.architecture}${gpu.adapterInfo.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
      stepsPerSecond: STEPS_PER_S, clock: `${STEPS_PER_S} steps a game second (physics.js NOMINAL_STEP_RATE: 4 a frame at 60 fps)`,
      gravity: SIM_GRAVITY * STEPS_PER_S ** 2 * CELL_M, cellM: CELL_M, fillQuantum: 1, velocity: true, pressure: true, airCell: 1, burning: true,
    },
    id: idOf,
    nameOf: (id) => { const k = ELEMENTS[id]?.key ?? `#${id}`; return BENCH[k] ?? k; },
    kindOf: (id) => KINDS[ELEMENTS[id]?.kind] ?? 'solid',
    async create([nx, ny, nz], { seed: s = 1 } = {}) {
      await engine.dispose();
      seed(s);
      sim = new Simulation(gpu, nx, ny, nz, { debug: false });
      kernel = sim.editKernel('outcomeBox', BOX);
      await Promise.all([sim.ready, kernel.ready]);
      clock = stepClock(STEPS_PER_S);
      texel = new Int32Array(nx * ny * nz);
      for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) texel[x + nx * (z + nz * y)] = cellTexel(sim.g, x, y, z) * 4;
    },
    box(lo, hi, name, { T, v = [0, 0, 0], onlyEmpty = false, pressure } = {}) {
      const id = idOf(name);
      if (id === null) throw new Error(`v1: no element ${name}`);
      const e = ELEMENTS[id], perStep = 1 / (CELL_M * STEPS_PER_S);
      sim.edit(kernel, { lo, hi }, {
        id, temp: T ?? e.temp, life: e.life, ctype: id === E.LAVA ? E.STONE : 0,
        vel: v.map((c) => c * perStep), pressure: pressure ?? 0, onlyEmpty: onlyEmpty ? 1 : 0, setPressure: pressure === undefined ? 0 : 1,
      });
    },
    async advance(seconds) {
      const n = clock.take(seconds);
      for (let k = 0; k < n; k++) {
        sim.step();
        // (the GPU kept a little ahead, and the idle check's read let through, so a settled world certifies)
        if ((k & 15) === 15) { await sim.gpuSync(); if (sim.idleRead) await sim.idleRead; }
      }
      await sim.gpuSync();
    },
    get time() { return clock.time; },
    // the bare simulation, for a check that drives a tool on it (tools/v2/blast-damage-browser-check.mjs: the rocket)
    get sim() { return sim; },
    get steps() { return clock.steps; },
    async read() {
      const [A, B] = await sim.readState();
      const { nx, ny, nz } = sim.g, n = nx * ny * nz;
      const g = {
        nx, ny, nz, id: new Int32Array(n), amount: new Float32Array(n), T: new Float32Array(n),
        burning: new Uint8Array(n), pressure: new Float32Array(n), moving: new Uint8Array(n), vel: new Float32Array(3 * n), particles: [],
      };
      const ms = CELL_M * STEPS_PER_S;   // cells/step to m/s
      for (let i = 0; i < n; i++) {
        const t = texel[i], id = Math.floor(A[t] + 0.5), e = ELEMENTS[id];
        g.id[i] = id;
        g.T[i] = A[t + 1];
        if (e?.kind === K.LIQUID) g.amount[i] = 1;
        if (e?.ignite > 0 && e.life > 0 && A[t + 2] < e.life) g.burning[i] = 1;
        g.pressure[i] = B[t + 3];
        if (B[t] || B[t + 1] || B[t + 2]) g.moving[i] = 1;
        g.vel[3 * i] = B[t] * ms; g.vel[3 * i + 1] = B[t + 1] * ms; g.vel[3 * i + 2] = B[t + 2] * ms;
      }
      return g;
    },
    async census() { return tally(await engine.read(), engine); },
    async activity() {
      await sim.gpuSync();
      if (sim.idleRead) await sim.idleRead;
      const c = await sim.readCounts();
      return { awake: c.awake, units: c.units, idle: sim.idleCertified };
    },
    fall(name, seconds) { const L = law(name); return L ? -integrate(L, [0, 0], seconds)[1] : null; },
    flight(name, [vx, vy], seconds) {
      const L = law(name);
      if (!L) return null;
      const [x, y] = integrate(L, [vx / STEPS_PER_S, vy / STEPS_PER_S], seconds);
      return [x, y];
    },
    park() {}, resume() {},
    async dispose() { sim?.dispose(); sim = null; kernel = null; },
  };
  return engine;
}
