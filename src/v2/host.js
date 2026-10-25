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

// The physics time governor: physics may take PHYSICS_BUDGET_MS of the GPU's time a frame (at most its
// share of a 60 Hz frame's wall time), and a tick is recorded a stage at a time (v2/physics.js
// TICK_STAGES), so an expensive tick spreads over frames instead of stretching one: the frame rate holds
// and game time slows (The Powder Toy's and Minecraft's lag: the world slows, the screen keeps moving),
// never more ticks to catch up. Each frame earns its budget as credit into a bank of BANK_FRAMES budgets
// and spends at most its own budget on stages, each at its measured GPU cost, so no frame records more
// than its budget; a stage that costs more than a budget runs alone, in a frame whose bank holds a whole
// budget, and later frames repay the rest (deficit round robin). Physics gets its budget a frame on
// average: what a frame leaves unspent waits in the bank for the next stage, not lost.
// A stage's cost is the GPU's own clock: its compute passes are its own (gpu.frame.endPass around it),
// each with begin and end timestamps (gpu.frame.passTimer), read back a frame or two later; while the
// profiler times every pass (gpu.timing), its times of the same passes. Timed by the queue's completion
// callbacks before, which land about a frame late in Chrome, every stage of a quiet box cost a whole
// frame (~30 ms each, 2026-10-25) and a quiet world ran 3 ticks a second; timestamps of empty passes
// came back out of order on Metal. Without timestamp queries nothing is priced, and the frame's due
// ticks are recorded whole, as before the governor.
export const PHYSICS_BUDGET_MS = 10;
const PHYSICS_SHARE = PHYSICS_BUDGET_MS * HOST_HZ / 1000;   // of wall time
const BANK_FRAMES = 2;   // the credit kept is this many frames' budgets at most: a quiet spell banks no burst
const COST_RISE = 0.5;   // a new sample's weight in a stage's running cost when it costs more (a blast starting)...
const COST_FALL = 0.2;   // ...and when it costs less
const SLOTS_MAX = 512;        // timestamp slots a frame: two a pass (a tick's stages open a few dozen passes)
const PASS_MAX_MS = 1000;     // a pass's span past this is a broken timestamp, not a cost
const NS_PER_MS = 1e6;
const QUERY_RESOLVE = 0x200;  // GPUBufferUsage.QUERY_RESOLVE
const COPY_SRC = 0x4;         // GPUBufferUsage.COPY_SRC
export function createPhysicsGovernor(gpu) {
  const cost = new Map();   // stage name -> its GPU cost, ms (absent: not measured yet)
  const timed = !!gpu.device?.features?.has?.('timestamp-query');
  let credit = 0, spent = 0, queries = null, resolved = null, slots = 0, last = [];
  let own = [];        // this frame's stages on our timestamps: { stage, slots }
  let profiled = [];   // stages on the profiler's: { stage, passes }, until their frame's times land
  const costOf = (stage) => cost.get(stage) ?? 0;
  const learn = (stage, ms) => {
    last.push([stage, ms]);
    const was = cost.get(stage);
    cost.set(stage, was === undefined ? ms : was + (ms > was ? COST_RISE : COST_FALL) * (ms - was));
  };
  const span = (begin, end) => {
    const ms = Number(end - begin) / NS_PER_MS;
    return ms >= 0 && ms < PASS_MAX_MS ? ms : null;
  };
  // the timestamp slots of a pass the stage begins (gpu.frame.passTimer)
  const passTimer = (entry) => () => {
    if (slots + 2 > SLOTS_MAX) { entry.unpriced = true; return {}; }
    queries ??= gpu.device.createQuerySet({ label: 'physics stage passes', type: 'timestamp', count: SLOTS_MAX });
    resolved ??= gpu.device.createBuffer({ label: 'physics stage passes', size: SLOTS_MAX * 8, usage: QUERY_RESOLVE | COPY_SRC });
    const at = slots;
    slots += 2;
    entry.slots.push(at);
    return { timestampWrites: { querySet: queries, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } };
  };
  return {
    /** Each stage's running GPU cost, ms ({ stage: ms }: the profiler's and tools' view). */
    get costs() { return Object.fromEntries(cost); },
    /** The stages timed most recently, [stage, ms] in the order their times landed. */
    get last() { return last; },
    /** The credit this frame has left, ms. */
    get credit() { return credit; },
    /** Whether stages are priced (the device has timestamp queries). */
    get timed() { return timed; },
    /** A recording tick's GPU cost, ms (its stages' running costs; 0: not measured yet). */
    get ms() { let sum = 0; for (const c of cost.values()) sum += c; return sum; },
    /** A frame of dt seconds starts: its budget into the bank (a long stage's debt carries over). */
    earn(dt) {
      const earned = Math.min(Math.max(0, dt) * 1000 * PHYSICS_SHARE, PHYSICS_BUDGET_MS);
      credit = Math.min(credit + earned, BANK_FRAMES * PHYSICS_BUDGET_MS);
      spent = 0;
    },
    /** Whether the frame may record `stage`: within its budget and the bank's credit, or alone (a stage
     * past a budget, once the bank holds a whole one). */
    fits(stage) {
      const c = costOf(stage);
      return spent === 0 ? credit >= Math.min(c, PHYSICS_BUDGET_MS) : spent + c <= PHYSICS_BUDGET_MS && credit >= c;
    },
    /** Records a stage (record() returns whether it ended the tick) in passes of its own, timed, and charges it. */
    run(stage, record) {
      if (!timed) return record();
      const frame = gpu.frame, entry = { stage, slots: [], passes: [], unpriced: false };
      const profiling = !!gpu.timing?.enabled;
      frame.endPass();
      const stop = profiling ? gpu.timing.addPassListener((p) => entry.passes.push(p)) : null;
      if (!profiling) frame.passTimer = passTimer(entry);
      credit -= costOf(stage);
      spent += costOf(stage);
      try {
        return record();
      } finally {
        frame.endPass();
        frame.passTimer = null;
        stop?.();
        (profiling ? profiled : own).push(entry);
      }
    },
    /** The frame's stages are recorded: their timestamps resolved and read back, each stage's cost learnt;
     * and the stages the profiler timed whose frame's times have landed. */
    settle() {
      last = [];
      profiled = profiled.filter((e) => {
        if (e.passes.some((p) => !p.error && p.end === undefined)) return true;   // (its frame's times are still coming)
        const spans = e.passes.map((p) => (p.error ? null : span(p.begin, p.end)));
        if (!spans.includes(null)) learn(e.stage, spans.reduce((a, b) => a + b, 0));
        return false;
      });
      const entries = own, used = slots;
      own = [];
      slots = 0;
      if (!used) { for (const e of entries) if (!e.unpriced) learn(e.stage, 0); return; }
      gpu.frame.direct().resolveQuerySet(queries, 0, used, resolved, 0);
      gpu.readback.buffer(resolved, 0, used * 8).then((bytes) => {
        const t = new BigUint64Array(bytes);
        for (const e of entries) {
          if (e.unpriced) continue;
          const spans = e.slots.map((at) => span(t[at], t[at + 1]));
          if (!spans.includes(null)) learn(e.stage, spans.reduce((a, b) => a + b, 0));
        }
      }, () => {});
    },
  };
}

// governor: the app's (createPhysicsGovernor): the frame's ticks are recorded a stage at a time while
// its credit lasts (owner.beginTick / stepTick), a tick in flight going on in the next frames; the ticks
// due meanwhile wait, at most the catch-up's, past it game time slows. Without one (tools, fixtures,
// an owner without stages) the frame's due ticks are recorded whole. Returns the ticks the frame ended.
export function nativeHostSteps(owner, dt, { speed = 1, once = false, before, after, governor = null } = {}) {
  if (!owner?.isReady || owner.disposed || owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  if (!Number.isFinite(dt) || !Number.isFinite(speed) || speed < 0) throw new Error('Invalid native host time');
  owner.activate();
  owner.sync();
  // A resting box keeps its clock: V1 steps a certified-idle grid too (sim.js step(): "simulation
  // time and parity advance even when there is nothing to step"), so its hooks (weather, scripts,
  // machines) and the clocks keyed on its steps go on while it records nothing (nativeHostTick rest).
  const due = frameTicks(owner.acc, dt, speed);
  owner.acc = due.acc;
  if (!governor || typeof owner.beginTick !== 'function') {
    const n = once ? Math.max(1, due.n) : due.n;
    for (let i = 0; i < n; i++) nativeHostTick(owner, { before, after, rest: true });
    return n;
  }
  let ended = 0;
  if (once) {
    // a single step (paused): the tick in flight and one more, whole
    if (owner.tickInFlight) { owner.finishTick(); ended++; }
    owner.owed = 0;
    nativeHostTick(owner, { before, after, rest: true });
    return ended + 1;
  }
  const max = Math.max(1, Math.ceil(CATCH_UP_TICKS * speed));
  let owed = (owner.owed ?? 0) + due.n;
  if (owed > max) { owed = max; owner.acc = 0; }
  governor.earn(dt);
  for (;;) {
    if (!owner.tickInFlight) {
      if (owed <= 0) break;
      owed--;
      if (!beginHostTick(owner, before, after)) { ended++; continue; }   // (at rest: its clock alone)
    }
    if (!governor.fits(owner.nextStage)) break;
    if (governor.run(owner.nextStage, () => owner.stepTick())) ended++;
  }
  governor.settle();
  owner.owed = owed;
  return ended;
}
// A host tick that records in stages: before() now, then the tick begun (stepTick records it), its clock
// and after() when its last stage is recorded. A box still at rest after before() records nothing: its
// clock and after() now, false (nativeHostTick's rest).
function beginHostTick(owner, before, after) {
  before?.();
  const frame = owner.sim.frame;
  const done = () => {
    if (owner.sim.frame === frame) owner.sim.frame++;
    owner.sim.nativeTicks = (owner.sim.nativeTicks ?? 0) + 1;
    after?.();
  };
  if (owner.asleep) { done(); return false; }
  owner.beginTick(done);
  return true;
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
