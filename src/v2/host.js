// Native host clock. Minecraft-style bounded catch-up: lag dilates game time
// instead of recording an unbounded burst. Guests never own this clock.
export const HOST_HZ = 60;
// Game time of `ticks` native ticks: what a frame that ran them advanced by.
export const nativeSeconds = (ticks) => Math.max(0, Number.isFinite(ticks) ? ticks : 0) / HOST_HZ;
// What a frame's projectiles, fuses and wand casts advance by: V1's frame time, or under V2 the
// ticks the frame ran (ctx.stepsPerFrame = app.nativeToolSteps). A 120 Hz frame runs a tick only
// every other frame: advancing those by the frame's own time flew them at half speed.
export const projectileSeconds = (sim, dt, ticks) => (sim?.compact ? nativeSeconds(ticks) : dt);
export function nativeHostSteps(owner, dt, { speed = 1, once = false, keepAlive = false, before, after } = {}) {
  if (!owner?.isReady || owner.disposed || owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  if (!Number.isFinite(dt) || !Number.isFinite(speed) || speed < 0) throw new Error('Invalid native host time');
  owner.activate();
  owner.sync();
  if (owner.asleep && !keepAlive && !once) { owner.acc = 0; return 0; }
  const max = Math.max(1, Math.ceil(2 * speed));
  owner.acc += Math.max(0, dt) * HOST_HZ * speed;
  let n = Math.floor(owner.acc);
  if (n > max) { n = max; owner.acc = 0; } else owner.acc -= n;
  if (once) n = Math.max(1, n);
  for (let i = 0; i < n; i++) nativeHostTick(owner, { before, after });
  return n;
}
export function nativeHostTick(owner, { before, after } = {}) {
  if (owner.sim.nativeTransition || owner.sim.nativeTransitionError) return 0;
  before?.();
  const frame = owner.sim.frame;
  owner.ticks(1);
  // Old prototype drivers didn't advance the host counter. New drivers may;
  // either way sources and tools observe exactly one counter increment/tick.
  if (owner.sim.frame === frame) owner.sim.frame++;
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
