import { Goal, CompositeGoal, GoalEvaluator } from 'yuka';
import { GoToGoal, hdist } from '../pov/ai/brain.js';

// A bot's objectives in a team game, as Buckland's goal-driven agent wants
// them (ai/brain.js): one more GoalEvaluator in its Think, beside the fight
// (Attack, Hunt, Breach, Climb, Cover...). The game (index.js) says what the
// objective is for this bot right now (objective(bot) → a plan), and this
// scores it and runs it:
//
//   plan = { kind, at: { x, y, z }, r, want }
//     kind  'carry' (bring their flag home), 'return' (touch ours, dropped),
//           'getFlag', 'escort' (follow our carrier), 'defend' (our stand),
//           'hill', 'attackCore', 'defendCore', 'roam'
//     at    where (grid cells, feet), r: how near counts as there (a zone's radius)
//     want  its desirability, on the brain's scale: Attack (an enemy in sight)
//           is 0.6 and Hunt (one remembered) 0.45, so a plan above 0.6 beats
//           fighting (a carrier runs home) and one between them beats chasing
//
// Raven's CTF bots (and Quake III's) split a team into roles: the game gives
// each bot 'attack' or 'defend'.

export const WANT = {
  carry: 0.9,          // over everything but putting itself out: the carrier runs home
  return: 0.7,         // our flag on the ground: over fighting
  getFlagNear: 0.65,   // their flag within reach (NEAR): over fighting
  inZone: 0.65,        // already on the hill or core: stay rather than chase
  getFlag: 0.62,       // an attacker runs for their flag through the fight (Halo's flag runner)
  getFlagIdle: 0.55,   // a defender with nothing to guard goes for it too, but fights first
  zone: 0.55,          // go to the hill or the core
  escort: 0.5,
  defend: 0.5,
  roam: 0.3,           // Slayer: go looking (over gathering sand, under hunting)
};
export const NEAR = 20;              // cells: a flag this near is worth more than a fight
const REPLAN = 4;                    // cells the objective's point moves before it plans the way again
const HOLD_S = 3;                    // s it holds a zone before Think weighs things again
const FAIL_COOLDOWN_S = 4;           // s an objective that failed (no way there) waits
const ROAM_STEER = 0.3;              // move share wandering inside a zone
const ZONE_RETURN = 0.6;             // share of the radius it wanders out to before it steers back in
const ARRIVE = 2;                    // cells: near enough to a point (not a zone)

export class ObjectiveEvaluator extends GoalEvaluator {
  constructor(objective) { super(); this.objective = objective; }
  calculateDesirability(a) {
    if (!a.ready('OBJECTIVE')) return 0;
    const p = this.objective(a);
    a.plan = p;
    return p ? p.want : 0;
  }
  setGoal(a) {
    const cur = a.brain.currentSubgoal();
    if (cur instanceof ObjectiveGoal && cur.same(a.plan)) return;
    a.brain.clearSubgoals();
    a.brain.addSubgoal(new ObjectiveGoal(a, a.plan, this.objective));
  }
}

// Go to the objective's point and stay there (a zone) or arrive (a point). It
// follows the point when it moves (a carrier, a dropped flag).
export class ObjectiveGoal extends CompositeGoal {
  constructor(a, plan, objective) { super(a); this.plan = plan; this.objective = objective; this.label = `Objective:${plan.kind}`; }
  same(p) { return p && p.kind === this.plan.kind && hdist(p.at, this.anchor ?? this.plan.at) < REPLAN; }
  activate() {
    const a = this.owner;
    this.clearSubgoals();
    this.t = 0;
    const { at, r } = this.plan;
    this.anchor = { x: at.x, y: at.y, z: at.z };   // where the point was when it set off
    this.goTo = null;
    if (hdist(a.feet, at) > (r || ARRIVE)) this.addSubgoal(this.goTo = new GoToGoal(a, { x: at.x, y: at.y, z: at.z }, r ? r * ZONE_RETURN : ARRIVE));
  }
  execute() {
    const a = this.owner;
    this.activateIfInactive();
    const p = this.objective(a);
    if (!p || p.kind !== this.plan.kind) { this.status = Goal.STATUS.COMPLETED; return; }
    if (hdist(p.at, this.anchor) >= REPLAN) {
      // it moved (a carrier, a dropped flag): on the way, the walk heads for the new spot at its
      // next re-plan (GoTo re-plans every 1.5 s, so a moving point doesn't run A* every frame); there, go again
      this.plan = p;
      this.anchor = { x: p.at.x, y: p.at.y, z: p.at.z };
      if (this.goTo && this.hasSubgoals()) {
        Object.assign(this.goTo.dest, this.anchor);
        this.goTo.best = Infinity; this.goTo.bestAt = this.goTo.t;   // progress counts toward the new spot
      }
      else { this.status = Goal.STATUS.INACTIVE; return; }
    }
    this.plan = p;
    if (this.hasSubgoals()) {
      const s = this.executeSubgoals();
      if (s === Goal.STATUS.FAILED) { a.cooldown('OBJECTIVE', FAIL_COOLDOWN_S); this.status = Goal.STATUS.FAILED; }
      return;
    }
    // there: hold a zone (wander in it, steer back when it strays), or done
    if (!p.r) { this.status = Goal.STATUS.COMPLETED; return; }
    this.t += a.dt;
    if (hdist(a.feet, p.at) > p.r * ZONE_RETURN) a.steerTo(p.at, ROAM_STEER * 2);
    else a.roam(ROAM_STEER);
    if (this.t > HOLD_S) this.status = Goal.STATUS.COMPLETED;
  }
}
