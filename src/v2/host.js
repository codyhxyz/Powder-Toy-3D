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
// The V1 steps a frame advanced the world by, for a tool rule authored per V1 step: V1's own
// (ctx.stepsPerFrame: app.js runs settings.steps a frame), or under V2 the ticks the frame ran
// (ctx.stepsPerFrame = app.nativeToolSteps) at LEGACY_STEPS_PER_TICK each. V2 ticks at 60 Hz
// whatever the frame rate: counting its ticks as steps ran such a rule at a quarter of V1's speed.
export const legacySteps = (sim, stepsPerFrame) => (sim?.compact ? stepsPerFrame * LEGACY_STEPS_PER_TICK : stepsPerFrame);

// Game time in V1 steps (1/LEGACY_STEP_HZ s): what V1's sim.frame counts, one a step (sim.js step()).
// A native tick, resting or not, advances sim.frame by one and this by LEGACY_STEPS_PER_TICK, so a
// clock authored on V1 steps (the media drift, the cloud deck: app.js viewClock, gfx/uniforms.js)
// runs at the same speed under either engine, across a runtime switch too. Exactly sim.frame while
// only V1 has stepped this grid.
export const stepClock = sim => sim.frame + (sim.nativeTicks ?? 0) * (LEGACY_STEPS_PER_TICK - 1);

// Ticks a frame may run at Speed 1×, at most: past them time dilates rather than the frame
// stretching (docs/v2.md 5.1: Minecraft's lag; v2/physics.js CATCH_UP, its own frame()).
export const CATCH_UP_TICKS = 2;
/**
 * The ticks a frame of `dt` seconds runs at `speed` (ticks a second over HOST_HZ, the Speed setting)
 * from the accumulator `acc`: the whole ticks of game time it holds, at most ⌈CATCH_UP_TICKS·speed⌉,
 * and the accumulator after them. nativeHostSteps runs exactly these; the app reads them before it
 * ticks, for the clocks that pace the frame's input by its game time (app.js ctx.nativeToolSteps).
 * @returns {{ n: number, acc: number }}
 */
export function frameTicks(acc, dt, speed) {
  const max = Math.max(1, Math.ceil(CATCH_UP_TICKS * speed));
  const total = acc + Math.max(0, dt) * HOST_HZ * speed;
  const n = Math.floor(total);
  return n > max ? { n: max, acc: 0 } : { n, acc: total - n };
}

// The share of its next tick a box's game time has reached: its accumulator, 0 to 1 (0 under V1,
// for a replica, which never ticks, and for a box that hasn't run). Minecraft's partial tick (its
// renderer's partialTicks): what the view adds to the ticks run, so a clock it draws by moves every
// frame, as it does under V1's steps a frame, when a frame runs no tick (Speed under 1×, a display
// over 60 Hz). Paused, the accumulator holds and so does the clock.
export const partialTick = sim => {
  const a = sim?.compact?.acc;
  return Number.isFinite(a) ? Math.min(Math.max(a, 0), 1) : 0;
};
// The view's clock (FrameUniforms' simClock, the cloud deck's drift: app.js viewClock, gfx/uniforms.js)
// in V1 steps: stepClock and the partial tick. A V1 grid at Speed 1 moves it one step a frame; a V2
// box at Speed 1 (a tick every fourth 60 Hz frame) moved it four steps every fourth frame. Presentation
// only: the game's clocks (weather, storms, machines) keep stepClock, whole ticks.
export const viewStepClock = sim => stepClock(sim) + partialTick(sim) * LEGACY_STEPS_PER_TICK;
// How far behind its record (s) a box's flying matter and rays are drawn: the share of a tick its game
// time has not reached, so the draw is Minecraft's lerp(prev, pos, partialTicks) with prev = pos − velocity
// × a tick (gfx/nativeParticles.js, shaders/v2/particleRender.js). At Speed 1 (a tick every fourth frame)
// a thrown grain moved four V1 steps every fourth frame; V1's moves a step a frame. 0 for a box this
// client doesn't tick (`ticking` false: a co-op replica draws the host's records as they come).
export const particleLagSeconds = (sim, ticking = true) => (ticking && sim?.compact ? (1 - partialTick(sim)) / HOST_HZ : 0);

/**
 * V1 runs a script's beforesim and aftersim around each of its steps (app.js's V1 loop: beforeStep,
 * sim.step, afterStep; TPT's event.beforesim / event.aftersim), and a step's writes reach the steps
 * after it (console/index.js: beforeStep flushes the queued writes, afterStep's wait for the next
 * one). A native tick is LEGACY_STEPS_PER_TICK of those steps run as one: the hooks keep V1's count and
 * order around it, B A B A B A B [tick] A. Every write a beforesim makes reaches the tick that runs its
 * step, an aftersim's the tick after its step, and a script that counts, pairs or alternates them (a flag
 * set before and read after, a write every other step) sees V1's sequence, each call's writes applied
 * in order rather than merged with the next call's.
 * Intentional (decided under the user's delegation, 2026-10-22): the world doesn't move between those
 * calls, a tick's four steps being one GPU pass sequence (v2/physics.js _tick): a script that writes the
 * same cell each step sets what the tick sees by its last write, as V1's last step does.
 * @param {() => void} beforeStep one V1 step's beforesim (scripts.beforeStep)
 * @param {() => void} afterStep one V1 step's aftersim (scripts.afterStep)
 * @returns {{ before: () => void, after: () => void }} a tick's: before it, after it
 */
export function legacyStepHooks(beforeStep, afterStep) {
  return {
    before() {
      for (let i = 1; i < LEGACY_STEPS_PER_TICK; i++) { beforeStep(); afterStep(); }
      beforeStep();
    },
    after() { afterStep(); },
  };
}

/**
 * The paints a held brush owes, at V1's rate. V1 paints it once a frame, and a frame is settings.steps
 * of its steps (app.js: the paint phase, then the steps): one paint per `per` V1 steps of game time,
 * the first at once, the next before the steps that follow. A V2 frame runs 0 to ⌈2·speed⌉ ticks of
 * LEGACY_STEPS_PER_TICK steps each, so a paint a frame painted half as much a game step at 30 fps (two
 * ticks a frame) and twice as much on a 120 Hz display (a tick every other frame). This keeps V1's
 * instants: a frame paints every multiple of `per` since the stroke began that its steps reach, and the
 * one due now (a stroke's first, whatever the frame runs).
 */
export function brushPace() {
  let at = 0, next = 0;   // V1 steps since the stroke began; the step of its next paint
  return {
    start() { at = next = 0; },
    /**
     * @param {number} steps the V1 steps the frame is about to run (a native frame: ticks × LEGACY_STEPS_PER_TICK)
     * @param {number} per V1 steps a paint (settings.steps: V1's steps a frame)
     * @returns {number} the paints this frame owes
     */
    frame(steps, per) {
      per = Math.max(1, per);
      let n = 0;
      while (next <= at || next < at + steps) { n++; next += per; }
      at += Math.max(0, steps);
      return n;
    },
  };
}

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

// The native ticks a world ran between the calls of a loop that isn't the app's frame (a
// requestAnimationFrame at the display's rate, pov/tools/index.js drive): each call is the ticks
// since the last (sim.nativeTicks counts them), none for a new world; reset(sim) sets the count
// from now. Reading the last app frame's tick count at every such call ran its ticks once a call.
export function tickCounter() {
  let of = null, seen = 0;
  const since = (sim) => {
    const t = sim?.nativeTicks ?? 0, n = sim && sim === of ? Math.max(0, t - seen) : 0;
    of = sim; seen = t;
    return n;
  };
  since.reset = (sim) => { of = sim ?? null; seen = sim?.nativeTicks ?? 0; };
  return since;
}

// The physics time governor: physics may take PHYSICS_BUDGET_MS of the GPU's time a 60 Hz frame
// (its share of wall time). Each frame earns that share of its own time as credit and each tick
// spends its measured GPU cost; a frame without the credit for a tick runs none, and game time
// slows instead of the frame rate (The Powder Toy's and Minecraft's lag: the world slows, the
// screen keeps moving), never more ticks to catch up. The cost is timed on the queue: the work
// before the ticks and the ticks go as submissions of their own, and a tick's cost is from the
// earlier work's completion to its own.
export const PHYSICS_BUDGET_MS = 10;
const PHYSICS_SHARE = PHYSICS_BUDGET_MS * HOST_HZ / 1000;   // of wall time
const COST_WEIGHT = 0.2;   // a new tick's weight in the running cost
export function createPhysicsGovernor(gpu) {
  let ms = 0, credit = 0;
  return {
    /** A recording tick's GPU cost, ms (0: not measured yet). */
    get ms() { return ms; },
    /** The recording ticks a frame of dt seconds may run. Credit holds a frame's budget at most (or one
     * tick, when a tick costs more), so a quiet spell doesn't bank a burst. */
    allow(dt) {
      credit = Math.min(credit + Math.max(0, dt) * 1000 * PHYSICS_SHARE, Math.max(ms, PHYSICS_BUDGET_MS));
      return ms > 0 ? Math.floor(credit / ms) : Infinity;
    },
    /** Runs record() (it returns the ticks it recorded), timed on the queue, and charges them. */
    measure(record) {
      gpu.frame.flush('physics governor: before the ticks');
      let start = performance.now();
      gpu.queue.onSubmittedWorkDone().then(() => { start = Math.max(start, performance.now()); }, () => {});
      const n = record();
      if (n > 0) {
        credit -= n * ms;
        gpu.frame.flush('physics governor: the ticks');
        gpu.queue.onSubmittedWorkDone().then(() => {
          const each = (performance.now() - start) / n;
          ms = ms > 0 ? ms + COST_WEIGHT * (each - ms) : each;
        }, () => {});
      }
      return n;
    },
  };
}

// max: the recording ticks the governor allows this frame (createPhysicsGovernor allow); past it the
// frame runs fewer and the accumulator starts over (game time slows). owner.recordedTicks: the ticks
// this call recorded (a resting box's cost nothing).
export function nativeHostSteps(owner, dt, { speed = 1, once = false, before, after, max = Infinity } = {}) {
  if (!owner?.isReady || owner.disposed || owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  if (!Number.isFinite(dt) || !Number.isFinite(speed) || speed < 0) throw new Error('Invalid native host time');
  owner.activate();
  owner.sync();
  // A resting box keeps its clock: V1 steps a certified-idle grid too (sim.js step(): "simulation
  // time and parity advance even when there is nothing to step"), so its hooks (weather, scripts,
  // machines) and the clocks keyed on its steps go on while it records nothing (nativeHostTick rest).
  const due = frameTicks(owner.acc, dt, speed);
  owner.acc = due.acc;
  let n = once ? Math.max(1, due.n) : due.n;
  if (!once && !owner.asleep && n > max) { n = max; owner.acc = 0; }
  let recorded = 0;
  for (let i = 0; i < n; i++) recorded += nativeHostTick(owner, { before, after, rest: true });
  owner.recordedTicks = recorded;
  return n;
}
/**
 * One host tick: before(), the native tick, after(). rest: a box still certified idle after before()
 * records nothing (V1's idle step, sim.js step()), and only its clock advances; without it the tick
 * always records (explicit steps: scripts, tests). Returns 1 if it recorded GPU work.
 */
export function nativeHostTick(owner, { before, after, rest = false } = {}) {
  if (owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  before?.();
  const frame = owner.sim.frame;
  const records = !rest || !owner.asleep;
  if (records) owner.ticks(1);
  // Old prototype drivers didn't advance the host counter. New drivers may;
  // either way sources and tools observe exactly one counter increment/tick.
  if (owner.sim.frame === frame) owner.sim.frame++;
  owner.sim.nativeTicks = (owner.sim.nativeTicks ?? 0) + 1;
  after?.();
  return records ? 1 : 0;
}
export function nativeReadiness(sim, { world = false, pov = false, guest = false } = {}) {
  if (guest) return { ready: false, reason: 'render-only guest' };
  if (!sim?.compactOwner?.isReady) return { ready: false, reason: 'native pipelines building' };
  if (sim.nativeTransition || sim.nativeTransitionError) return { ready: false, reason: 'native world transition pending or failed' };
  const c = sim.nativeCapabilities;
  if (!c?.state) return { ready: false, reason: 'native state integration unavailable' };
  // While the flying matter's kernels build (PhysicsV2.dynamicsReady) the grid steps: the window waits
  // to move (world/window.js update) and the tools' requests wait in order (sim.nativePending), so
  // neither stops the world. Once they are built, a capability still missing is a real gap.
  // Intentional (user request, 2026-10-21: "MAKE IT LOAD FAST"; the world steps the whole time).
  const d = sim.compactOwner.dynamics, building = !!d && !d.disposed && d.isReady !== true;
  if (world && !c.world && !building) return { ready: false, reason: 'native world dynamics shift unavailable' };
  if (pov && !c.pov && !building) return { ready: false, reason: 'native POV tools unavailable' };
  return { ready: true, reason: null, ...(building ? { building: 'native dynamics' } : {}) };
}
