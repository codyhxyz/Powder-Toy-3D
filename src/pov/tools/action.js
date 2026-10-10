import * as THREE from 'three';

// What every tool's buttons and blows share, so a new tool gets the same feel
// by using these instead of its own timers and curves.
//
// trigger(interval, { hold, button }): when a tool acts on a button. Taken from
// Half-Life 2's weapons (source-sdk-2013 basebludgeonweapon.cpp ItemPostFrame):
// the action happens on the frame the button goes down, then no sooner than
// `interval` after the last one. With hold (the default), holding the button
// repeats it; without, it acts once per click. hold can also be a number: the
// seconds between repeats while held, slower than clicking can go (HL2's
// pistol, weapon_pistol.cpp: 0.1 s between clicks, 0.5 s held). A click during
// the wait isn't lost: it's kept and acts as soon as the wait ends (input
// buffering), for up to `interval`.
//
//   const t = trigger(REFIRE);                    // button: 'primary' (default) or 'secondary'
//   if (t.ready(ctx)) { if (doIt()) t.fire(); }   // ready() once a frame; fire() only when it acted
//
// swing(spec): a melee blow's pose over time, from rest down to `hit` (it bit
// into something and stops there) or `miss` (it follows through), in
// spec.strike seconds eased out, then eased back to rest by spec.settle.
//
//   const s = swing({ rest, hit, miss, strike, settle });
//   s.start(landed); pivot.rotation.x = s.angle(dt);

const TIME_EPS = 1e-6;   // s: a wait this close to done counts as done (frame times don't sum exactly)

// The tools' clock: the frame's time sped up by the body's tool speed
// (ctx.toolRate, the Faster Tools perk, pov/perks.js). Everything a tool does
// over time (refire waits, swings, digging, pouring, heating) runs on it, so
// one perk speeds up every tool, a new one included.
export const toolDt = (ctx) => ctx.dt * (ctx.toolRate ?? 1);

export function trigger(interval, { hold = true, button = 'primary' } = {}) {
  const holdWait = typeof hold === 'number' ? Math.max(0, hold - interval) : 0;   // s held repeats wait beyond `interval`
  // The waits run below zero by the part of a frame they overshot, and the next
  // one starts that much early (HL2: m_flNextPrimaryAttack += fire rate), so a
  // held SMG keeps its 13 a second at 30 fps instead of rounding up to every
  // third frame. At most one frame's worth carries over: no burst after a pause.
  let wait = 0, queued = 0, heldWait = 0, frame = 0;
  const carry = (w) => Math.max(w, -frame);
  return {
    // true when the tool should act this frame (call once a frame while selected)
    ready(ctx) {
      const dt = toolDt(ctx);
      frame = dt;
      wait -= dt;
      heldWait -= dt;
      queued = Math.max(0, queued - dt);
      if (ctx[`${button}Pressed`]) queued = interval;
      return wait <= TIME_EPS && (queued > 0 || (hold !== false && ctx[button] && heldWait <= TIME_EPS));
    },
    fire() { wait = carry(wait) + interval; heldWait = carry(heldWait) + interval + holdWait; queued = 0; },
    reset() { wait = 0; heldWait = 0; queued = 0; },
    get waiting() { return Math.max(0, wait); },
  };
}

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutQuad = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export function swing({ rest, hit, miss, strike, settle }) {
  let t = Infinity, low = rest;
  return {
    start(landed) { t = 0; low = landed ? hit : miss; },
    // the angle after advancing dt
    angle(dt) {
      t += dt;
      if (t >= settle) return rest;
      if (t < strike) return THREE.MathUtils.lerp(rest, low, easeOutCubic(t / strike));
      return THREE.MathUtils.lerp(low, rest, easeInOutQuad((t - strike) / (settle - strike)));
    },
    stop() { t = Infinity; },
  };
}
