import { Think, Goal, GoalEvaluator } from 'yuka';
import {
  Agent, distanceModule, aimWith, hdist, HuntEvaluator, ExtinguishEvaluator, WanderEvaluator,
  REACTION_S, AIM_ERROR_START, AIM_ERROR, AIM_RAMP_S, AIM_ERROR_MOVING, WARNING_MISS,
} from './brain.js';
import { BODY_HEIGHT } from '../constants.js';

// The jetpack gunner: Noita's jetpack Hiisi (Hiisi Jetpack), on the axeman's
// body and mind (npc.js, brain.js). It fights only with guns, the pistol, SMG and
// sniper chosen by Raven's fuzzy distance rules, and keeps its range the way
// shooter AI does: it backs off when you close in, strafes side to side in its
// band, and closes when you get away. It flies on the body's own jetpack
// (player.js: hold jump in the air) up to a vantage over you and hovers there,
// strafing, and when the tank runs low it drops and lands to refuel (the tank
// refills on the ground). Same fairness rules as the axeman's gun: a reaction
// delay, a warning shot, an aim that tightens the longer it has you in sight.
//
// Strategies: Engage (sees you: keep range, fly, shoot), Hunt, Extinguish and
// Wander (brain.js's own).

// range (cells), Noita's Hiisi keep their distance and shoot
const RANGE_MIN = 16;                // closer than this it backs off
const RANGE_MAX = 40;                // farther than this it closes in
const STRAFE_S = [1.2, 2.8];         // s it strafes one way before it may turn (uniform in this range)
const STRAFE_REACH = 10;             // cells: how far ahead of itself it steers when strafing or backing off
const STRAFE_SHARE = 0.75;           // share of its speed while strafing (it aims as it goes)
// flight (player.js jetpack: a 3 s tank, refilled in 0.5 s on the ground)
const VANTAGE_UP = 2 * BODY_HEIGHT;  // cells over the target's feet it hovers at
const HOVER_BAND = 1.5;              // cells: it lets the jet go this far over the vantage, and lights it under
const FLY_FUEL = 0.6;                // tank share it needs to take off
const LAND_FUEL = 0.2;               // tank share at which it stops jetting and comes down to refuel
const REFUEL_TO = 0.95;              // tank share it waits for on the ground before it flies again
// the guns: Raven's distance sets (close < 16 < medium < 45 < far), how each is fired
const GUNS = {
  SMG: { rate: distanceModule([['close', 'very'], ['medium', 'yes'], ['far', 'no']]), burst: 0.6, rest: 1.3 },
  GUN: { rate: distanceModule([['close', 'yes'], ['medium', 'very'], ['far', 'yes']]), interval: 1.1 },
  SNIPER: { rate: distanceModule([['close', 'no'], ['medium', 'yes'], ['far', 'very']]), interval: 2.6 },
};
const WEAPON_NOISE = 6;              // ± desirability points of whim (brain.js)
const WEAPON_SWITCH_S = 3;           // s it keeps a gun before re-choosing

export class GunnerAgent extends Agent {
  constructor(npc) {
    super(npc);
    this.brain = new Think(this);
    for (const e of [new EngageEvaluator(), new HuntEvaluator(), new ExtinguishEvaluator(), new WanderEvaluator()]) this.brain.addEvaluator(e);
    this.strafeSide = 1; this.strafeUntil = 0; this.refueling = false;
  }
  clearIntent() { super.clearIntent(); this.intent.jet = false; }
}

// It sees you: fight at range.
class EngageEvaluator extends GoalEvaluator {
  calculateDesirability(a) { return a.knows && a.sees ? 0.6 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof EngageGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new EngageGoal(a)); } }
}

class EngageGoal extends Goal {
  execute() {
    const a = this.owner;
    if (!a.knows) { this.status = Goal.STATUS.COMPLETED; return; }
    keepRange(a);
    fly(a);
    shoot(a);
  }
}

// back off, strafe or close in, on the ground plane (Yuka seek)
function keepRange(a) {
  const f = a.feet, t = a.target.pos, d = hdist(f, t) || 1;
  const ux = (t.x - f.x) / d, uz = (t.z - f.z) / d;   // toward the target
  if (a.now >= a.strafeUntil) {
    a.strafeSide = Math.random() < 0.5 ? -1 : 1;
    a.strafeUntil = a.now + STRAFE_S[0] + Math.random() * (STRAFE_S[1] - STRAFE_S[0]);
  }
  let radial = 0, share = STRAFE_SHARE;
  if (d < RANGE_MIN) { radial = -1; share = 1; } else if (d > RANGE_MAX) { radial = 1; share = 1; }
  const sx = -uz * a.strafeSide, sz = ux * a.strafeSide;   // sideways
  a.steerTo({ x: f.x + (sx + ux * radial) * STRAFE_REACH, z: f.z + (sz + uz * radial) * STRAFE_REACH }, share);
  a.mode = radial < 0 ? 'back off' : radial > 0 ? 'close in' : 'strafe';
}

// up to a vantage over the target and hover there; down to refuel when the tank runs low
function fly(a) {
  const b = a.npc.body;
  if (b.inLiquid) return;
  if (b.jetFuel < LAND_FUEL) a.refueling = true;
  if (a.refueling && b.onGround && b.jetFuel >= REFUEL_TO) a.refueling = false;
  if (a.refueling) { a.flight = 'refuel'; return; }
  const want = a.target.pos.y + VANTAGE_UP;
  if (b.onGround) {
    if (b.jetFuel >= FLY_FUEL && b.pos.y < want - HOVER_BAND) { a.intent.jump = true; a.flight = 'take off'; } else a.flight = 'ground';
    return;
  }
  // in the air: light the jet under the vantage (or falling toward it), let it go over
  a.intent.jet = b.pos.y < want - HOVER_BAND || (b.pos.y < want + HOVER_BAND && b.vel.y < 0);
  a.flight = 'hover';
}

// the gun for the distance (fuzzy), fired as that gun fires, with the axeman's aim rules
function shoot(a) {
  let key = a.weapon in GUNS ? a.weapon : null;
  if (!key || a.now - a.weaponAt >= WEAPON_SWITCH_S) {
    let best = null, bw = -Infinity;
    for (const [k, g] of Object.entries(GUNS)) {
      const w = g.rate(a.dist3) + (Math.random() * 2 - 1) * WEAPON_NOISE;
      if (w > bw) { bw = w; best = k; }
    }
    if (best !== a.weapon) { a.weapon = best; a.weaponAt = a.now; }
    key = best;
  }
  const g = GUNS[key];
  a.hold(key);
  const c = a.chest(), t = a.target;
  // still reacting to the sight of it, staggered, or catching its breath: face it and hold
  if (a.inSight < REACTION_S || !a.ready('ATTACK')) { a.lookAt(c); return; }
  if (a.warnedAt !== a.record.timeBecameVisible) {
    // the first shot since it spotted you: a near miss to one side
    const e = a.eye(), dx = c.x - e.x, dz = c.z - e.z, d = Math.hypot(dx, dz) || 1, side = Math.random() < 0.5 ? -1 : 1;
    a.lookAt({ x: c.x - (dz / d) * side * WARNING_MISS * 1.6, y: c.y, z: c.z + (dx / d) * side * WARNING_MISS * 1.6 });
    if (a.ready(key)) { a.intent.primaryPressed = true; a.cooldown(key, g.interval ?? g.rest); a.warnedAt = a.record.timeBecameVisible; }
    return;
  }
  const ramp = Math.min(a.inSight / AIM_RAMP_S, 1);
  aimWith(a, c, AIM_ERROR_START + (AIM_ERROR - AIM_ERROR_START) * ramp + AIM_ERROR_MOVING * Math.hypot(t.vel.x, t.vel.z));
  if (g.burst) {
    // a burst held down, then a rest
    const s = a.useState ??= {};
    if (s.tool !== key) { s.tool = key; s.t = 0; }
    if (!a.ready(key)) return;
    s.t += a.dt;
    a.intent.primary = true;
    a.intent.primaryPressed = s.t <= a.dt;
    if (s.t >= g.burst) { a.cooldown(key, g.rest); s.t = 0; }
  } else if (a.ready(key)) { a.intent.primaryPressed = true; a.cooldown(key, g.interval); }
}

for (const [G, label] of [[EngageGoal, 'Engage']]) G.prototype.label = label;
