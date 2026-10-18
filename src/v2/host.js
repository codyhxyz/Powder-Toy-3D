// Native host clock. Minecraft-style bounded catch-up: lag dilates game time
// instead of recording an unbounded burst. Guests never own this clock.
const HOST_HZ = 60;
export const INDUSTRY_V2_UNAVAILABLE = 'Factory machines require V1 physics. V2 machine transport is not implemented.';
// main's World renderer copies V1's cell buffers (src/world/renderSource.js); V2 keeps its own until it feeds that copy.
export const WORLD_V2_UNAVAILABLE = 'The World map requires V1 physics. Its renderer does not read V2 cells yet.';
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
export function nativeReadiness(sim, { world = false, pov = false, guest = false, industry = false } = {}) {
  if (guest) return { ready: false, reason: 'render-only guest' };
  if (!sim?.compactOwner?.isReady) return { ready: false, reason: 'native pipelines building' };
  if (sim.nativeTransition || sim.nativeTransitionError) return { ready: false, reason: 'native world transition pending or failed' };
  if (industry) return { ready: false, reason: INDUSTRY_V2_UNAVAILABLE };
  if (world) return { ready: false, reason: WORLD_V2_UNAVAILABLE };
  const c = sim.nativeCapabilities;
  if (!c?.state) return { ready: false, reason: 'native state integration unavailable' };
  if (world && !c.world) return { ready: false, reason: 'native world dynamics shift unavailable' };
  if (pov && !c.pov) return { ready: false, reason: 'native POV tools unavailable' };
  return { ready: true, reason: null };
}
