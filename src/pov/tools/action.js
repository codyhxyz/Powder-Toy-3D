import * as THREE from 'three';
import { gravityScale } from '../ballistics.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { gridSpace } from '../space.js';
import { muzzleCell } from './transfer.js';

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
// buffer: false discards clicks during cooldown (continuous tools stop on release).
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
//
// launchFrom(env, ctx, refuse): where a thrown or fired thing leaves the body: the
// first open cell along the aim (transfer.js muzzleCell), { sim, dir, origin },
// or null and feedback.refuse(refuse) when there's no room.
//
// launcher(env, spec): a tool that throws or fires a thing on the shared
// projectiles (ballistics.js: the bomb, the rocket, the lamps, the flask), and
// draws each one it launched while it flies (also while the tool isn't held).
//
//   const launch = launcher(env, { kind, model,     // the rounds' kind, and models.js's model drawn for them
//     refuse,                    // the refusal when there's no room ('No room to throw')
//     rig, hit, action,          // on a launch: rig.hit(hit) and tool:action `action` (feedback.act), if given
//     hand, button,              // the held model and its trigger(), for update/deselect
//     tumble,                    // rad the drawn round turns a frame (TUMBLE; 0: it's posed by onMove)
//     onMove(record, e),         // after each round:move has placed record.model
//     onEnd(record, id) });      // a round left the air without take(id) (round:end, dispose)
//   launch.fire(ctx, { gravity, speed, carry, bodies, onStrike(strike, id) }, record)
//     → { id, origin, dir } or null; gravity: true falls at the world's g. record is kept per round.
//   launch.update(ctx, shoot)    // in hand: the rig follows, and shoot(ctx) when the button is ready
//   launch.deselect()            // put away
//   launch.take(id)              // a round that struck: its record, no longer drawn
//   launch.flying                // round id → record
//   launch.world                 // the group the rounds are drawn in (in the scene until dispose)

const TIME_EPS = 1e-6;   // s: a wait this close to done counts as done (frame times don't sum exactly)

// The tools' clock: the frame's time sped up by the body's tool speed
// (ctx.toolRate, the Faster Tools perk, pov/perks.js). Everything a tool does
// over time (refire waits, swings, digging, pouring, heating) runs on it, so
// one perk speeds up every tool, a new one included.
export const toolDt = (ctx) => ctx.dt * (ctx.toolRate ?? 1);

export function trigger(interval, { hold = true, button = 'primary', buffer = true } = {}) {
  const holdWait = typeof hold === 'number' ? Math.max(0, hold - interval) : 0;   // s held repeats wait beyond `interval`
  // The waits run below zero by the part of a frame they overshot, and the next
  // one starts that much early (HL2: m_flNextPrimaryAttack += fire rate), so a
  // held SMG keeps its 13 a second at 30 fps instead of rounding up to every
  // third frame. At most one frame's worth carries over: no burst after a pause.
  // Only an overshoot carries: a click that fires before the held repeat was
  // due restarts that wait rather than adding to it.
  let wait = 0, queued = 0, heldWait = 0, frame = 0;
  const carry = (w) => Math.min(0, Math.max(w, -frame));
  return {
    // true when the tool should act this frame (call once a frame while selected)
    ready(ctx) {
      const dt = toolDt(ctx);
      frame = dt;
      wait -= dt;
      heldWait -= dt;
      queued = Math.max(0, queued - dt);
      if (ctx[`${button}Pressed`]) queued = buffer ? interval : 0;
      return wait <= TIME_EPS && ((buffer ? queued > 0 : ctx[`${button}Pressed`]) || (hold !== false && ctx[button] && heldWait <= TIME_EPS));
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

export const TUMBLE = 0.4;   // rad a thrown thing turns per frame it's drawn

export function launchFrom(env, ctx, refuse) {
  const sim = ctx.sim ?? env.getSim();
  const dir = ctx.dir.clone().normalize();
  const m = ctx.player?.pos ? muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g) : { t: 0 };
  if (!m) { env.feedback?.refuse(refuse); return null; }
  return { sim, dir, origin: ctx.eye.clone().addScaledVector(dir, m.t) };
}

export function launcher(env, {
  kind, model, refuse = 'No room to throw', rig = null, hit = null, action = null, hand = null, button = null,
  tumble = TUMBLE, onMove = null, onEnd = null,
}) {
  const { toWorld } = gridSpace(env);
  const flying = new Map();   // round id → its record ({ model, ...fire's record }), for the rounds this one launched
  const world = new THREE.Group();
  world.name = `pov-${kind}s`;
  env.scene.add(world);
  const take = (id) => {
    const f = flying.get(id);
    if (!f) return null;
    flying.delete(id);
    f.model?.dispose();
    return f;
  };
  const end = (f, id) => { onEnd?.(f, id); f.model?.dispose(); };
  const offs = [
    povEvents.on('round:move', (e) => {
      const f = e.kind === kind && flying.get(e.id);
      if (!f) return;
      f.model ??= attachModel(world, model, null, { arm: false });
      const obj = f.model.obj;
      obj.scale.setScalar(env.getScale());
      toWorld(e.to, obj.position);
      if (tumble) obj.rotation.x += tumble;
      onMove?.(f, e);
      globalThis.__app?.requestRender?.();
    }),
    povEvents.on('round:end', ({ id, kind: k }) => {
      const f = k === kind && flying.get(id);
      if (!f) return;
      flying.delete(id);
      end(f, id);
    }),
  ];
  return {
    flying,
    world,
    take,
    fire(ctx, { gravity = false, onStrike = null, ...opts } = {}, record = {}) {
      const at = launchFrom(env, ctx, refuse);
      if (!at) return null;
      let id = 0;
      id = env.ballistics.fire(at.origin, at.dir, gravity ? gravityScale(at.sim) : 0, {
        ...opts, kind, onStrike: onStrike && ((s) => onStrike(s, id)),
      });
      if (!id) return null;
      flying.set(id, { model: null, ...record });
      if (rig) rig.hit(hit);
      if (action) env.feedback?.act(action);
      return { id, origin: at.origin, dir: at.dir };
    },
    update(ctx, shoot) {
      hand.visible = true;
      rig.update(ctx);
      if (button.ready(ctx) && shoot(ctx)) button.fire();
    },
    deselect() { hand.visible = false; button.reset(); },
    dispose() {
      offs.forEach((off) => off());
      flying.forEach(end);
      flying.clear();
      world.removeFromParent();
    },
  };
}
