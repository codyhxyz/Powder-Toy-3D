// Native host clock. Minecraft-style bounded catch-up: lag dilates game time
// instead of recording an unbounded burst. Guests never own this clock.
export const HOST_HZ = 60;
// Game time of `ticks` native ticks: what a frame that ran them advanced by.
export const nativeSeconds = (ticks) => Math.max(0, Number.isFinite(ticks) ? ticks : 0) / HOST_HZ;
// What a frame's projectiles, fuses and wand casts advance by: V1's frame time, or under V2 the
// ticks the frame ran (ctx.stepsPerFrame = app.nativeToolSteps). A 120 Hz frame runs a tick only
// every other frame: advancing those by the frame's own time flew them at half speed.
export const projectileSeconds = (sim, dt, ticks) => (sim?.compact ? nativeSeconds(ticks) : dt);
// V1's step rate: app.js DEFAULTS.steps (4) a frame at a 60 Hz display, README's "~240 sim steps/s"
// (weather.js WEATHER_STEPS_PER_SECOND, console/api.js MAX_SCRIPT_STEPS are authored at it).
export const LEGACY_STEP_HZ = 240;
// The game time of one native tick, in V1 steps.
export const LEGACY_STEPS_PER_TICK = LEGACY_STEP_HZ / HOST_HZ;

// Game time in V1 steps (1/LEGACY_STEP_HZ s): what V1's sim.frame counts, one a step (sim.js step()).
// A native tick, resting or not, advances sim.frame by one and this by LEGACY_STEPS_PER_TICK, so a
// clock authored on V1 steps (the media drift, the cloud deck: app.js viewClock, gfx/uniforms.js)
// runs at the same speed under either engine, across a runtime switch too. Exactly sim.frame while
// only V1 has stepped this grid.
export const stepClock = sim => sim.frame + (sim.nativeTicks ?? 0) * (LEGACY_STEPS_PER_TICK - 1);

// V1 steps asked of a grid (a script's sim.step(n)) as the whole native ticks they make: the steps
// short of a tick carry to the next ask on that grid, so four asks of one step run one tick, the
// 1/60 s four of V1's steps take. One carry per caller.
export function legacyStepCarry() {
  let carry = 0, of = null;
  return (sim, steps) => {
    if (sim !== of) { of = sim; carry = 0; }
    carry += steps;
    const ticks = Math.floor(carry / LEGACY_STEPS_PER_TICK);
    carry -= ticks * LEGACY_STEPS_PER_TICK;
    return ticks;
  };
}

export function nativeHostSteps(owner, dt, { speed = 1, once = false, before, after } = {}) {
  if (!owner?.isReady || owner.disposed || owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  if (!Number.isFinite(dt) || !Number.isFinite(speed) || speed < 0) throw new Error('Invalid native host time');
  owner.activate();
  owner.sync();
  // A resting box keeps its clock: V1 steps a certified-idle grid too (sim.js step(): "simulation
  // time and parity advance even when there is nothing to step"), so its hooks (weather, scripts,
  // machines) and the clocks keyed on its steps go on while it records nothing (nativeHostTick rest).
  const max = Math.max(1, Math.ceil(2 * speed));
  owner.acc += Math.max(0, dt) * HOST_HZ * speed;
  let n = Math.floor(owner.acc);
  if (n > max) { n = max; owner.acc = 0; } else owner.acc -= n;
  if (once) n = Math.max(1, n);
  for (let i = 0; i < n; i++) nativeHostTick(owner, { before, after, rest: true });
  return n;
}
/**
 * One host tick: before(), the native tick, after(). rest: a box still certified idle after before()
 * records nothing (V1's idle step, sim.js step()), and only its clock advances; without it the tick
 * always records (explicit steps: scripts, tests).
 */
export function nativeHostTick(owner, { before, after, rest = false } = {}) {
  if (owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  before?.();
  const frame = owner.sim.frame;
  if (!rest || !owner.asleep) owner.ticks(1);
  // Old prototype drivers didn't advance the host counter. New drivers may;
  // either way sources and tools observe exactly one counter increment/tick.
  if (owner.sim.frame === frame) owner.sim.frame++;
  owner.sim.nativeTicks = (owner.sim.nativeTicks ?? 0) + 1;
  after?.();
}
export function nativeReadiness(sim, { world = false, pov = false, guest = false } = {}) {
  if (guest) return { ready: false, reason: 'render-only guest' };
  if (!sim?.compactOwner?.isReady) return { ready: false, reason: 'native pipelines building' };
  if (sim.nativeTransition || sim.nativeTransitionError) return { ready: false, reason: 'native world transition pending or failed' };
  const c = sim.nativeCapabilities;
  if (!c?.state) return { ready: false, reason: 'native state integration unavailable' };
  if (world && !c.world) return { ready: false, reason: 'native world dynamics shift unavailable' };
  if (pov && !c.pov) return { ready: false, reason: 'native POV tools unavailable' };
  return { ready: true, reason: null };
}
