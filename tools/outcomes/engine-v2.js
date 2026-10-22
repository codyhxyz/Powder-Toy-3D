// Integrated production native engine; canonical material/particle/air readback.
// Contract: ./engine.js. Velocity setup is checked before the first tick.
import { Simulation } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { E, ELEMENTS } from '../../src/elements.js';
import { CELL_M } from '../../src/scale.js';
import { TICK_HZ, G_MS2, FULL, V2, v2Rows } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { readNativeState, toGrid, nativeTally, nativeFall, nativeFlight } from './native-grid.js';
import { stepClock, SetupError } from './engine.js';
import { GRAV } from '../../src/simModes.js';

// bench names that are named otherwise today
const TODAY = { AIR: 'EMPTY', FLOUR: 'DUST' };
const BENCH = Object.fromEntries(Object.entries(TODAY).map(([b, t]) => [t, b]));
const KINDS = { [V2.AIR]: 'air', [V2.SOLID]: 'solid', [V2.POWDER]: 'powder', [V2.LIQUID]: 'liquid', [V2.GAS]: 'gas' };
const ROWS = v2Rows();

// The box writer: every cell of the box (or every air cell of it) gets the element (V1's engine-v1.js's, at the v1-oracle tag).
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
  let sim = null, v2 = null, kernel = null, clock = stepClock(TICK_HZ), launches = [];
  const idOf = (name) => { const k = TODAY[name] ?? name; return k in E ? E[k] : null; };
  const engine = {
    name: 'v2',
    info: {
      label: `v2 integrated native physics (src/v2/physics.js), ${gpu.adapterInfo.vendor} ${gpu.adapterInfo.architecture}${gpu.adapterInfo.isFallbackAdapter ? ' (fallback adapter)' : ''}`,
      stepsPerSecond: TICK_HZ, clock: `${TICK_HZ} ticks a game second (Speed 1×)`,
      gravity: G_MS2, cellM: CELL_M, fillQuantum: 1 / FULL, velocity: true, pressure: true, airCell: 4, burning: true,
      velocityDetails: 'Resident liquid from the column runs: face segments\' depth-averaged flux, falling runs\' fall speed, no vertical momentum in a supported run (native-grid.js columnLiquidVelocity); powder fall speed; air velocity for air and gas',
    },
    id: idOf,
    nameOf: (id) => { const k = ELEMENTS[id]?.key ?? `#${id}`; return BENCH[k] ?? k; },
    kindOf: (id) => KINDS[ROWS[id]?.cls] ?? 'solid',
    async create([nx, ny, nz], { seed: s = 1 } = {}) {
      await engine.dispose();
      seed(s);
      sim = new Simulation(gpu, nx, ny, nz, { debug: false });
      kernel = sim.editKernel('outcomeBoxV2', BOX);
      v2 = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics });
      // A scene throws, blasts and pours: it needs the flying matter and the jets, which build behind the
      // grid's kernels (src/v2/physics.js: `ready` is the grid's, `dynamicsReady` the dynamics' and jets').
      await Promise.all([sim.ready, kernel.ready, v2.dynamicsReady]);
      clock = stepClock(TICK_HZ);
      launches = [];
      if (!v2.isReady || !v2.contactReady || !v2.dynamics || !v2.dynamicsBuilt || !v2.jets || !v2.jetsBuilt) throw new SetupError('v2: integrated native physics did not become ready');
    },
    box(lo, hi, name, { T, v = [0, 0, 0], onlyEmpty = false, pressure } = {}) {
      const id = idOf(name);
      if (id === null) throw new Error(`v2: no element ${name}`);
      if (pressure !== undefined) throw new SetupError('v2: exact box pressure initialization is unsupported; native pressure readback is in Pa');
      if (v.length !== 3 || !v.every(Number.isFinite)) throw new SetupError('v2: invalid SI velocity');
      const thrown = v.some(c => c !== 0);
      if (thrown && (onlyEmpty || ![V2.POWDER, V2.LIQUID, V2.GAS].includes(ROWS[id].cls)))
        throw new SetupError('v2: exact velocity setup supports unconditional powder/liquid/gas boxes only');
      const e = ELEMENTS[id];
      sim.edit(kernel, { lo, hi }, { id, temp: T ?? e.temp, life: e.life, ctype: id === E.LAVA ? E.STONE : 0, onlyEmpty: onlyEmpty ? 1 : 0 });
      if (thrown) {
        v2.sync();
        const result = v2.dynamics.applyBodyCoupling({ lo: lo.map(c => c + 0.5), hi: hi.map(c => c + 0.5),
          velocity: v, pushFluid: 0, pushPowder: 0, lift: 0, ahead: [0, 0], only: id });
        if (result.status !== 'queued') throw new SetupError(`v2: velocity setup rejected: ${result.reason}`);
        launches.push({ lo: [...lo], hi: [...hi], id, v: [...v] });
      }
    },
    async advance(seconds) {
      await verifyLaunches();
      const n = clock.take(seconds);
      for (let k = 0; k < n; k += 16) {
        v2.ticks(Math.min(16, n - k));
        await sim.gpuSync();
      }
    },
    // 'vertical' or 'radial' (TPT's radial mode): the box's own setting, as the drawer sets it (sim.js)
    setGravity(mode) { sim.gravityMode = mode === 'radial' ? GRAV.RADIAL : GRAV.VERTICAL; },
    get time() { return clock.time; },
    // the bare simulation, for a check that drives a tool on it (tools/v2/blast-damage-browser-check.mjs: the rocket)
    get sim() { return sim; },
    get steps() { return clock.steps; },
    async read() {
      await verifyLaunches();
      return toGrid(await readNativeState(v2));
    },
    async census() { return nativeTally(await engine.read(), engine); },
    // FNV-1a of each native buffer, and control words 0-31 as they are (docs/v2/tick-cost-floor.md, "What to measure on the GPU")
    async stateHash() {
      v2.sync();
      const d = v2.dynamics;
      const named = { cells: v2.cells, banks: v2.aux, particles: d.particles, air0: d.air[0], air1: d.air[1] };
      const copies = await Promise.all([...Object.values(named), d.control].map(b => v2.gpu.readback.buffer(b, 0, b.size)));
      const fnv = (buf) => { const w = new Uint32Array(buf); let h = 0x811c9dc5; for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };
      const out = Object.fromEntries(Object.keys(named).map((k, i) => [k, fnv(copies[i])]));
      out.airIndex = d.airIndex; out.tick = v2.tick ?? null;
      out.control = [...new Uint32Array(copies.at(-1)).slice(0, 32)];
      return out;
    },
    async activity() {
      v2.sync();
      const [s] = await Promise.all([v2.readStats(), v2.dynamics.readActivity()]);
      const idle = s.awake === 0 && s.tick > 0 && v2.unwrittenSinceTick && v2.dynamics.isIdle;
      return { awake: s.awake, units: s.units, idle };
    },
    fall(name, seconds) { return nativeFall(idOf(name), seconds); },
    flight(name, velocity, seconds) { return nativeFlight(idOf(name), velocity, seconds); },
    park() {}, resume() {},
    async dispose() { v2?.dispose(); sim?.dispose(); v2 = null; sim = null; kernel = null; launches = []; },
  };
  async function verifyLaunches() {
    if (!launches.length) return;
    const g = toGrid(await readNativeState(v2));
    for (const { lo, hi, id, v } of launches) {
      for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) {
        const ps = g.particles.filter(p => p.id === id && p.x === x + 0.5 && p.y === y + 0.5 && p.z === z + 0.5);
        if (g.id[x + g.nx * (z + g.nz * y)] !== E.EMPTY || ps.length !== 1 ||
          [ps[0].vx, ps[0].vy, ps[0].vz].some((c, a) => Math.abs(c - v[a]) > 1e-5))
          throw new SetupError('v2: native allocator did not accept exact velocity setup (capacity or overlapping writes)');
      }
    }
    launches = [];
  }
  return engine;
}
