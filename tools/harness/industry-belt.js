// Factory transport on the GPU, V1 against V2 (tools/v2/industry-belt-browser-check.mjs drives it):
// the REAL machine driver (src/industry/physics.js) on a bare engine (tools/outcomes/engine-v1.js or
// engine-v2.js), stepped as the app's frame loop steps it (src/app.js: V1 runs settings.steps steps and
// then the frame's machine pass; V2 runs its ticks, each followed by industry.nativeStep, and then the
// frame's pass). No app, no world.
//   belt(engine, { steps, fps, frames })  grains on a line of belts: the mean cells a game second
//   lift(engine, { steps })               a grain on a lift: its apex (cells) and the game time to it
import { boot, ready, log, test } from './harness.js';
import { createEngine as v1Engine } from '../outcomes/engine-v1.js';
import { createEngine as v2Engine } from '../outcomes/engine-v2.js';
import { createIndustryPhysics } from '/src/industry/physics.js';
import { nativeIndustry } from '/src/v2/industry.js';
import { nativeHostTick, LEGACY_STEPS_PER_TICK, LEGACY_STEP_HZ } from '/src/v2/host.js';
import { E } from '/src/elements.js';

const h = await boot({ label: 'industry belt' });
const gpu = h.gpu;
const engines = { v1: v1Engine(gpu), v2: v2Engine(gpu) };
const BASE_Y = 2, GRAIN_Y = BASE_Y + 1;

async function scene(name, dims, devices, grains, steps) {
  const engine = engines[name];
  await engine.create(dims);
  for (const d of devices) engine.box([d.x, d.y, d.z], [d.x + 3, d.y, d.z + 3], 'INSULATOR');
  for (const [x, y, z] of grains) engine.box([x, y, z], [x, y, z], 'NUGGETS');
  const sim = engine.sim, errors = [];
  if (name === 'v2') { await engine.advance(1 / 60); }
  const physics = createIndustryPhysics({ getSim: () => sim, onError: e => errors.push(String(e?.message ?? e)), legacySteps: () => steps });
  await physics.ready;
  if (name === 'v2') await nativeIndustry(sim).ready;   // (its kernels build on first use)
  return { engine, sim, physics, errors };
}
// One app frame (src/app.js frame): V1 runs `steps` steps a frame; V2 the ticks the frame's game time holds.
function frameRunner(name, sim, physics, devices, { steps, fps }) {
  let acc = 0;
  return () => {
    const dt = 1 / fps;
    if (name === 'v1') {
      for (let i = 0; i < steps; i++) { sim.step(); physics.nativeStep(devices); }
    } else {
      acc += dt * 60 * steps / 4;
      const n = Math.floor(acc); acc -= n;
      for (let i = 0; i < n; i++) nativeHostTick(sim.compactOwner, { after: () => physics.nativeStep(devices) });
    }
    physics.step(dt, devices);
  };
}
async function grains(engine) {
  const g = await engine.read(), out = [];
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    if (g.id[x + g.nx * (z + g.nz * y)] === E.NUGGETS) out.push([x + 0.5, y + 0.5, z + 0.5]);
  }
  for (const p of g.particles ?? []) if (p.id === E.NUGGETS) out.push([p.x, p.y, p.z]);
  return out;
}
const gameSteps = (name, sim) => (name === 'v1' ? sim.frame : (sim.nativeTicks ?? 0) * LEGACY_STEPS_PER_TICK);

test('belt', async (name, { steps = 4, fps = 60, frames = 30 } = {}) => {
  const lines = [0, 8, 16, 24], devices = [];
  for (const x of lines) for (let z = 0; z < 64; z += 4) devices.push({ id: `b${x}-${z}`, type: 'belt', x, y: BASE_Y, z, rotation: 0 });
  const start = lines.flatMap(x => [[x + 1, GRAIN_Y, 1], [x + 2, GRAIN_Y, 1]]);
  const { engine, sim, physics, errors } = await scene(name, [32, 32, 64], devices, start, steps);
  const frame = frameRunner(name, sim, physics, devices, { steps, fps });
  physics.step(1 / fps, devices);            // the first pass (V1's frames end with one)
  const s0 = gameSteps(name, sim), before = await grains(engine);
  for (let f = 0; f < frames; f++) frame();
  await sim.gpuSync?.();
  const after = await grains(engine), s1 = gameSteps(name, sim);
  const z0 = before.reduce((n, p) => n + p[2], 0) / Math.max(1, before.length), z1 = after.reduce((n, p) => n + p[2], 0) / Math.max(1, after.length);
  const seconds = (s1 - s0) / LEGACY_STEP_HZ;
  const out = { engine: name, steps, fps, frames, grains: [before.length, after.length], seconds, cellsPerSecond: (z1 - z0) / seconds,
    zs: after.map(p => +p[2].toFixed(1)).sort((a, b) => a - b), ys: [...new Set(after.map(p => Math.floor(p[1])))], errors };
  log(JSON.stringify(out));
  return out;
});

// One grain on a line of belts, tick by tick (V2) or frame by frame (V1): where it is after each, on the grid or flying.
test('trace', async (name, { steps = 4, frames = 10 } = {}) => {
  const devices = [];
  for (let z = 0; z < 64; z += 4) devices.push({ id: `b${z}`, type: 'belt', x: 0, y: BASE_Y, z, rotation: 0 });
  const { engine, sim, physics, errors } = await scene(name, [32, 32, 64], devices, [[1, GRAIN_Y, 1]], steps);
  const frame = frameRunner(name, sim, physics, devices, { steps, fps: 60 }), out = [];
  physics.step(1 / 60, devices);
  for (let f = 0; f < frames; f++) {
    frame();
    const g = await engine.read(), cells = [], flying = [];
    for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < 4; x++) if (g.id[x + g.nx * (z + g.nz * y)] === E.NUGGETS) cells.push([x, y, z]);
    for (const p of g.particles ?? []) if (p.id === E.NUGGETS) flying.push([+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.vz.toFixed(1)]);
    out.push({ f, cells, flying });
  }
  log(JSON.stringify(out));
  return { engine: name, out, errors };
});

test('lift', async (name, { steps = 4 } = {}) => {
  const d = { id: 'lift', type: 'lift', x: 4, y: BASE_Y, z: 4, rotation: 0 };
  const { engine, sim, physics, errors } = await scene(name, [32, 32, 64], [d], [[5, GRAIN_Y, 5], [6, GRAIN_Y, 6]], steps);
  physics.step(1 / 60, [d]);                 // the kick
  const s0 = gameSteps(name, sim), track = [];
  const per = name === 'v1' ? 1 : LEGACY_STEPS_PER_TICK;
  for (let k = 0; k < 64; k += per) {
    if (name === 'v1') sim.step(); else nativeHostTick(sim.compactOwner, {});
    const g = await grains(engine);
    track.push([(gameSteps(name, sim) - s0) / LEGACY_STEP_HZ, Math.max(...g.map(p => p[1])) - (GRAIN_Y + 0.5)]);
  }
  const apex = track.reduce((m, t) => (t[1] > m[1] ? t : m), [0, -Infinity]);
  const out = { engine: name, apexCells: apex[1], apexSeconds: apex[0], track: track.map(t => [+t[0].toFixed(4), +t[1].toFixed(2)]), errors };
  log(JSON.stringify({ ...out, track: undefined }));
  return out;
});

ready();
