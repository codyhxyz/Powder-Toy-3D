import * as THREE from 'three';

// What every tool's buttons and blows share, so a new tool gets the same feel
// by using these instead of its own timers and curves.
//
// trigger(interval, { hold, button }): when a tool acts on a button. Taken from
// Half-Life 2's weapons (source-sdk-2013 basebludgeonweapon.cpp ItemPostFrame):
// the action happens on the frame the button goes down, then no sooner than
// `interval` after the last one. With hold (the default), holding the button
// repeats it; without, it acts once per click (the gun). A click during the
// wait isn't lost: it's kept and acts as soon as the wait ends (input
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

export function trigger(interval, { hold = true, button = 'primary' } = {}) {
  let wait = 0, queued = 0;
  return {
    // true when the tool should act this frame (call once a frame while selected)
    ready(ctx) {
      wait = Math.max(0, wait - ctx.dt);
      queued = Math.max(0, queued - ctx.dt);
      if (ctx[`${button}Pressed`]) queued = interval;
      return wait <= TIME_EPS && (queued > 0 || (hold && ctx[button]));
    },
    fire() { wait = interval; queued = 0; },
    reset() { wait = 0; queued = 0; },
    get waiting() { return wait; },
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
