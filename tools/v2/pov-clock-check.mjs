// CPU-only: first person's tools and body under V2 run on the ticks V2 actually ran, so each moves
// as V1 does at any frame rate. V1 runs settings.steps (4) a frame at a 60 fps cap (app.js, gfx/pacing.js
// MAX_FPS); V2 ticks at 60 Hz on game time whatever the frame rate, 0, 1 or 2 ticks a frame (v2/host.js).
// Real modules (the POV wiring, the physgun, the body, the burrower, the tick counter) with the GPU and
// the app shell stubbed. No browser, no GPU.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
registerHooks({ load(url, context, next) {
  // the POV shell (createPov) records the options the wiring hands it; nothing else is stubbed
  if (url.endsWith('/src/pov/index.js')) return { format: 'module', shortCircuit: true,
    source: 'export const createPov = (o) => { globalThis.__povOptions = o; return { vehicles: { spawnLayout() {} }, game: { useLayout() {}, prepare() {} } }; };' };
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
// presentation only: the physgun's tip glow paints a canvas
globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 4 };
globalThis.document ??= { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) };
const { default: wire } = await import('../../src/wire/pov.js');
const { default: physgun } = await import('../../src/pov/tools/physgun.tool.js');
const { default: burrower } = await import('../../src/pov/tools/burrower.tool.js');
const { createPlayer } = await import('../../src/pov/player.js');
const { setPovGpu } = await import('../../src/pov/gpu.js');
const { PHYS: ENGINE, NOMINAL_STEP_RATE } = await import('../../src/physics.js');
const { tickCounter, legacySteps, LEGACY_STEPS_PER_TICK, HOST_HZ } = await import('../../src/v2/host.js');
const src = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

// ---- 1. The POV shell sees the ticks the app frame runs (app.js ctx.nativeToolSteps), live.
{
  const app = { nativeToolSteps: 1, mp: { replica: true }, settings: {} };
  wire.attach(app);
  const options = globalThis.__povOptions;
  assert.equal(options.nativeToolSteps, 1, "the POV shell reads the frame's V2 ticks (it read undefined: every V2 tool clock was 0, stepsPerFrame V1's 4)");
  app.nativeToolSteps = 2;
  assert.equal(options.nativeToolSteps, 2, 'each frame, not the first');
  app.nativeToolSteps = null;
  assert.equal(options.nativeToolSteps, null, 'V1: none (pov/index.js falls back to settings.steps)');
  // what pov/index.js makes of it: the tools' clock and their step count
  const index = src('pov/index.js');
  assert(/ctx\.nativeDt = sim\.compact \? \(app\.nativeToolSteps \?\? 0\) \/ 60 : undefined;/.test(index));
  assert(/ctx\.stepsPerFrame = app\.nativeToolSteps \?\? \(app\.settings\.paused \? 0 : app\.settings\.steps\);/.test(index));
  console.log('PASS the POV shell reads the V2 ticks each frame runs (its tools\' clock and step count)');
}

// ---- 2. The physgun's hold point chases the aim at CHASE · V_MAX a V1 step: under V2 its ticks are 4 steps each.
const rig = { hand: () => new THREE.Group(), update() {}, hit() {} };
const toolEnv = (sim) => ({ scene: new THREE.Scene(), viewmodel: { visible: true, userData: { rig } }, getScale: () => 1,
  getVolume: () => new THREE.Object3D(), getSim: () => sim, feedback: { act() {} } });
function chaseOneFrame(sim, stepsPerFrame) {
  const tool = physgun.create(toolEnv(sim));
  const eye = new THREE.Vector3(16, 16, 16);
  const ctx = { sim, dt: 1 / 60, nativeDt: sim.compact ? stepsPerFrame / HOST_HZ : undefined, stepsPerFrame, eye, dir: new THREE.Vector3(0, 0, -1),
    aim: { valid: false }, primary: true, primaryPressed: true, secondary: false, secondaryPressed: false, wheel: 0 };
  tool.update(ctx);
  const start = tool.hold;
  Object.assign(ctx, { primaryPressed: false, dir: new THREE.Vector3(1, 0, 0) });
  tool.update(ctx);
  const moved = tool.hold.sub(eye).angleTo(start.sub(eye)) * start.length();
  tool.dispose();
  return moved;
}
{
  const holds = [];
  const v2 = { id: 2, compact: { dynamics: { applyPhysgun: (r) => { holds.push(r); return { status: 'queued' }; }, holdSession: null } },
    nativeCapabilities: { physgun: true }, g: { nx: 64, ny: 64, nz: 64 }, origin: new THREE.Vector3(), gravity: 0.025 };
  const v1 = { id: 1, g: { nx: 64, ny: 64, nz: 64 }, origin: new THREE.Vector3(), gravity: 0.025, gpu: { createBuffer: () => ({ destroy() {} }), flush() {}, queue: { onSubmittedWorkDone: () => Promise.resolve() } }, touchCentres: (lo, hi) => ({ lo, hi }) };
  setPovGpu(v1, { ready: true, com: () => true, edit: () => true, probe: () => null });
  const v1Arc = chaseOneFrame(v1, 4);   // V1 at 60 fps: 4 steps a frame
  const v2Arc = chaseOneFrame(v2, 1);   // V2 at 60 fps: 1 tick a frame
  const want = 0.8 * ENGINE.V_MAX * 4;  // physgun.tool.js CHASE · V_MAX, 4 V1 steps
  assert(Math.abs(v1Arc - want) < 1e-9, `V1: ${v1Arc} cells a frame`);
  assert(Math.abs(v2Arc - want) < 1e-9, `V2's tick is four V1 steps of chase, ${v2Arc} cells (it chased a quarter as fast)`);
  assert(Math.abs(chaseOneFrame(v2, 2) - 2 * want) < 1e-9, 'a frame of two ticks (48 fps) chases two ticks\' worth');
  assert.equal(chaseOneFrame(v2, 0), 0, 'a frame without a tick waits for the next');
  assert(holds.length > 0, 'the hold is native');
  assert.equal(legacySteps(v2, 3), 3 * LEGACY_STEPS_PER_TICK);
  assert.equal(legacySteps(v1, 3), 3);
  console.log(`PASS physgun chase: ${v2Arc.toFixed(2)} cells a V2 tick, as V1's ${v1Arc.toFixed(2)} a 4-step frame`);
}

// ---- 3. Out of POV, what's in the air flies by the ticks the world ran between rAF calls, not the last app frame's count each call.
{
  const ticks = tickCounter(), sim = { nativeTicks: 10 };
  ticks.reset(sim);
  assert.equal(ticks(sim), 0, 'nothing since the reset');
  sim.nativeTicks = 11; assert.equal(ticks(sim), 1);
  assert.equal(ticks(sim), 0, 'a 120 Hz call between two ticks runs none (it ran the last frame\'s again: twice as fast)');
  sim.nativeTicks = 13; assert.equal(ticks(sim), 2);
  assert.equal(ticks({ nativeTicks: 99 }), 0, 'a new world starts its own count');
  const tools = src('pov/tools/index.js');
  assert(/stepsPerFrame = sim\?\.compact \? ticksRun\(sim\) : env\.getStepsPerFrame\?\.\(\) \?\? lastSteps;/.test(tools), 'the hidden toolbelt\'s loop counts the world\'s ticks');
  assert(/ticksRun\.reset\(env\.getSim\(\)\); raf = requestAnimationFrame\(drive\);/.test(tools), 'from when it starts');
  console.log('PASS hidden flights: the ticks run between calls');
}

// ---- 4. The body: under V2 its clock runs between ticks (no kick, gib or coupling lost on a frame without one).
{
  const make = (compact) => ({ id: compact ? 4 : 3, frame: 0, compact: compact ? {} : null, g: { nx: 32, ny: 32, nz: 32 }, origin: new THREE.Vector3(),
    gravity: 0.025, gpu: {}, touchCentres: (lo, hi) => ({ lo, hi }) });
  const rateOver = (sim, frames) => {
    setPovGpu(sim, { ready: true, edit: () => true, probe: () => null, com: () => true });
    const body = createPlayer({ renderer: null, getSim: () => sim, quiet: true });
    const rates = [];
    for (const [dt, steps] of frames) { sim.frame += steps; body.update(dt, {}); rates.push(body.stepRate); }
    return rates;
  };
  // V2 at ~100 fps: (entering the world, then) ticks 1, 0, 1, 0 ... then paused (no ticks)
  const v2 = rateOver(make(true), [[0.01, 0], [0.01, 1], [0.01, 0], [0.01, 1], [0.01, 0], [0.01, 1], [0.01, 0], [0.05, 0], [0.05, 0]]);
  assert.equal(v2[0], 0, 'no clock seen yet on entering a world (as V1\'s first frame)');
  assert.deepEqual(v2.slice(1, 7), Array(6).fill(NOMINAL_STEP_RATE), 'V2: a frame without a tick is still the running clock, at V1\'s steps a second');
  assert.equal(v2.at(-1), 0, 'paused: no clock (as V1\'s 0 steps)');
  const v1 = rateOver(make(false), [[1 / 60, 0], [1 / 60, 4], [1 / 60, 4], [1 / 60, 0]]);
  assert(v1[1] > 0 && v1[2] > 0 && v1.at(-1) === 0, 'V1 measures its steps as ever');
  const kick = src('pov/kick.js');
  assert(/const v = body\.stepRate > 0 \? KICK_SPEED \* share \/ speedRate\(sim\) : 0;/.test(kick), 'the kick gates on that clock');
  console.log('PASS body clock: V2 runs between ticks and stops when paused; V1 unchanged');
}

// ---- 5. The burrower's drills bore by the ticks the frame ran (a frame without one bores nothing, the next its two).
{
  const run = (sim, frames) => {
    setPovGpu(sim, { ready: true, edit: () => true, probe: () => null });
    const tool = burrower.create({ ...toolEnv(sim), getVolume: () => ({ position: new THREE.Vector3() }) });
    const ctx = { sim, dt: 1 / 60, stepsPerFrame: 4, eye: new THREE.Vector3(10, 20, 32), dir: new THREE.Vector3(1, 0, 0), primaryPressed: true };
    tool.update(ctx);
    const d = tool.drills[0], from = d.pos.clone();
    ctx.primaryPressed = false;
    for (const [dt, steps] of frames) { Object.assign(ctx, { dt, stepsPerFrame: steps }); tool.tick(ctx); }
    return d.pos.distanceTo(from);
  };
  const v1 = { id: 5, g: { nx: 128, ny: 128, nz: 128 }, touchCentres: () => [] };
  const v2 = { ...v1, id: 6, compact: {} };
  const v1Far = run(v1, [[1 / 60, 4], [1 / 60, 4], [1 / 60, 4]]);
  const v2Far = run(v2, [[1 / 120, 1], [1 / 120, 0], [1 / 120, 1], [1 / 120, 0], [1 / 120, 1], [1 / 120, 0]]);   // 120 fps: half the frames tick
  assert(v1Far > 0, 'the drill flies');
  assert(Math.abs(v2Far - v1Far) < 1e-6, `three ticks bore what V1's three 60 fps frames do (${v2Far.toFixed(3)} vs ${v1Far.toFixed(3)}; the frames without a tick lost their time)`);
  console.log(`PASS burrower: ${v2Far.toFixed(2)} cells over 3 V2 ticks at 120 fps, as V1's 3 frames`);
}

// ---- 6. NPCs' tools: the same clock as the player's.
assert(/ctx\.nativeDt = sim\?\.compact \? nativeSeconds\(w\.stepsPerFrame\) : undefined;/.test(src('pov/npc.js')), "an NPC's tools run on the V2 ticks too (toolDt read wall time)");
console.log('PASS NPC tools read the V2 tick clock');

// ---- 7. A wand's bolt flies the frame's game time from its cast (V2: the ticks', not the wall frame's).
assert(/started: time - frameDt,/.test(src('pov/wands/runtime.js')) && /time \+= dt; frameDt = dt;/.test(src('pov/wands/runtime.js')), "a bolt is backdated by the frame's game time");
console.log('PASS wand bolts start on the wand clock');
