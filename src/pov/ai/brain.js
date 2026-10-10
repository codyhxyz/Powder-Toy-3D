import {
  Vehicle, MovingEntity, Think, Goal, CompositeGoal, GoalEvaluator, Regulator,
  PursuitBehavior, SeekBehavior, WanderBehavior, MemorySystem,
  FuzzyModule, FuzzyVariable, FuzzyRule, LeftShoulderFuzzySet, TriangularFuzzySet, RightShoulderFuzzySet,
  Vector3 as YVector3,
} from 'yuka';
import { ELEMENTS, E, K } from '../../elements.js';
import { HAND_REACH, BODY_HEIGHT, EYE_HEIGHT } from '../constants.js';
import { AXE, PICK, FLAMER, PHYS } from '../../shaders/povTools.js';
import { ROUND_GRAVITY, gravityScale } from '../ballistics.js';
import { THROW_SPEED } from '../tools/bomb.tool.js';

// An NPC's mind, from Mat Buckland's "Programming Game AI by Example" as Yuka
// implements it (github.com/Mugen87/yuka):
//
// - Goal-driven behaviour (ch. 9): a Think goal arbitrates between strategies
//   (GoalEvaluators score how desirable each is right now; the best one sets
//   the goal), and goals are composites of subgoals (go there, then dig, then
//   build). Re-arbitrated a few times a second (Regulator) or when a goal ends.
// - Fuzzy weapon selection (ch. 10, Raven's weapon system): each tool used as
//   a weapon has a FuzzyModule rating its desirability from the distance to the
//   target; hard requirements (a line of sight, something to grab) gate it.
// - Short-term memory (Raven's sensory memory): Yuka's MemorySystem keeps when
//   and where the target was last seen, so it hunts where you were.
// - Steering (Reynolds): Yuka's pursuit, seek and wander on the ground plane.
//
// The goals don't move the body or press buttons themselves: each frame they
// fill agent.intent (move share, jump, the point to look at, the tool and its
// buttons), and npc.js turns that into the body's input and the tool's ctx.
// World knowledge comes from world.js (the cells, read back) and nav.js (A*).

// ---- tuning
const ARBITRATE_HZ = 4;              // Think re-weighs its strategies this often
const MEMORY_S = 12;                 // s it remembers where it last saw the target
const SIGHT = 80;                    // cells: farther than this it doesn't see the target
const TOUCH = 4;                     // cells: this close it senses the target even through debris (hears, touches)
const CHEST = 3;                     // cells above the feet it aims at
const TOOL_EYE = EYE_HEIGHT;
// Fairness, the standard shooter-AI rules: it reacts after a perception delay
// (Halo and Doom AI), its first shot after spotting you misses on purpose and
// its aim tightens the longer it has you in sight (Naughty Dog's accuracy ramp
// in Uncharted and The Last of Us), every dangerous action has a wind-up you can
// see (the tell), a hit staggers it out of a wind-up, and after it lands a hit
// it takes a breather before the next attack.
const REACTION_S = 0.7;              // s it has to see the target before it attacks
const AIM_ERROR_START = 0.16;        // rad, its gun's spread (σ) when it first has you in sight...
const AIM_ERROR = 0.05;              // ...narrowing to this...
const AIM_RAMP_S = 4;                // ...over this long in sight
const AIM_ERROR_MOVING = 0.003;      // rad more per cell/s the target moves
const WARNING_MISS = 2.5;            // body widths aside its first shot lands (a near miss you see and hear)
const STAGGER_S = 0.35;              // s a hit stops it (and loses its wind-up)
const BREATHER_S = 0.9;              // s after it hurts the target before it attacks again
const THROW_WINDUP = 0.6;            // s the arm is up before a bomb leaves (the tell)
const TORCH_IGNITE_S = 0.4;          // s the torch is aimed before the flame lights
const TORCH_BURST_S = 1;             // s the flame burns at most...
const TORCH_REST_S = 1.6;            // ...then it rests
const GUN_INTERVAL = 1.1;            // s between its shots
const AXE_WINDUP = 0.6;              // s it faces the target, axe up, before a blow (the tell)
const AXE_COOLDOWN = 0.5;            // s after a blow
const PICK_COOLDOWN = 0.7;           // s after a pickaxe blow (its refire is 0.6)
const AXE_RANGE = Math.min(HAND_REACH, 6);   // cells: it swings from closer than the hand's reach
const TORCH_RANGE = 1.5 + FLAMER.LENGTH;      // cells: nozzle reach + flame
const BOMB_MIN = 10;                 // cells: closer than this a bomb would hurt itself
const BOMB_COOLDOWN = 7;             // s between bombs
const BOMB_ERROR = 0.12;             // its throw's spread: σ of the landing point, as a share of the distance
const PHYS_GRAB_S = 0.9;             // s it holds the beam on loose matter before flinging
const PHYS_FIND = 12;                // cells: loose matter this near its eye can be grabbed
const PHYS_COOLDOWN = 2.5;
const LAVA_FIND = HAND_REACH - 1;    // cells: lava this near its eye can be scooped
const POUR_RANGE = 8;                // cells: it pours a bucket of lava from this close
const POUR_S = 1.2;
const BUCKET_WANT = 60;              // cells of lava before it goes to pour
const WEAPON_NOISE = 6;              // ± desirability points of whim, so it doesn't use one tool forever
const WEAPON_SWITCH_S = 2.5;         // s it keeps a weapon before re-choosing

const BLOCK = 3;                     // cells: the trowel's block (trowel.tool.js BLOCK)
const BLOCK_CELLS = BLOCK ** 3;
const JUMP_UP = 6;                   // cells: what a jump clears (nav.js)
const PILLAR_MAX = 8;                // blocks it stacks at most
const PILLAR_PLACE_RISE = BLOCK + 0.6; // cells above the last block's top before it places the next
const GATHER_TO = 6 * BLOCK_CELLS;   // cells in the pack it digs up before building
const GATHER_FIND = 30;              // cells: powder this near counts for gathering
const COVER_HEALTH = 0.4;            // health below which, under fire, it walls itself in
const COVER_COOLDOWN = 8;            // s between walls
const BREACH_RANGE = 8;              // cells: a wall this close between it and the target is breached
const WATER_FIND = 48;               // cells: water this near is where it runs when burning
const BURNING = 0.25;                // feel.heat above which it's on fire

const GOTO_REPATH_S = 1.5;
const GOTO_TIMEOUT_S = 12;
const STUCK_FAIL_S = 2.5;            // s without progress before a GoTo gives up
const WAYPOINT_REACH = 1.6;          // cells
const WANDER_S = 3;

const KIND = ELEMENTS.map((e) => e.kind);
const LOOSE = (i) => i !== E.EMPTY && i >= 0 && (KIND[i] === K.POWDER || KIND[i] === K.LIQUID);
const DIGGABLE = (i) => i >= 0 && i !== E.EMPTY && (KIND[i] === K.POWDER || (KIND[i] === K.SOLID && ELEMENTS[i].breakInto && ELEMENTS[i].hard <= 40));
const AXEABLE = (i) => i >= 0 && KIND[i] === K.SOLID && ELEMENTS[i].breakInto && ELEMENTS[i].hard <= AXE.ENERGY;
const PICKABLE = (i) => i >= 0 && KIND[i] === K.SOLID && ELEMENTS[i].breakInto && ELEMENTS[i].hard <= PICK.ENERGY;
const BOMBABLE = (i) => i >= 0 && KIND[i] === K.SOLID && ELEMENTS[i].breakInto;

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const gauss = () => { const u = Math.random() || 1e-9, v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------------------------------------------------------------- weapons (fuzzy)

// Distance sets (cells) and desirability sets (0..100), Raven's shapes.
function distanceModule(rules) {
  const m = new FuzzyModule();
  const dist = new FuzzyVariable();
  const close = new LeftShoulderFuzzySet(0, 4, 16);
  const medium = new TriangularFuzzySet(4, 16, 45);
  const far = new RightShoulderFuzzySet(16, 45, 200);
  dist.add(close); dist.add(medium); dist.add(far);
  m.addFLV('distance', dist);
  const want = new FuzzyVariable();
  const sets = {
    no: new LeftShoulderFuzzySet(0, 25, 50),
    yes: new TriangularFuzzySet(25, 50, 75),
    very: new RightShoulderFuzzySet(50, 75, 100),
  };
  want.add(sets.no); want.add(sets.yes); want.add(sets.very);
  m.addFLV('desirability', want);
  const near = { close, medium, far };
  for (const [d, w] of rules) m.addRule(new FuzzyRule(near[d], sets[w]));
  return (d) => { m.fuzzify('distance', d); return m.defuzzify('desirability'); };
}

// Each weapon: its tool, how desirable it is at a distance, and what it needs.
const WEAPONS = {
  AXE: { rate: distanceModule([['close', 'very'], ['medium', 'no'], ['far', 'no']]) },
  GUN: { rate: distanceModule([['close', 'yes'], ['medium', 'yes'], ['far', 'yes']]), needsSight: true },
  BOMB: { rate: distanceModule([['close', 'no'], ['medium', 'very'], ['far', 'yes']]) },
  BLOWTORCH: { rate: distanceModule([['close', 'very'], ['medium', 'no'], ['far', 'no']]), needsSight: true },
  PHYSGUN: { rate: distanceModule([['close', 'yes'], ['medium', 'yes'], ['far', 'no']]), needsSight: true },
  BUCKET: { rate: distanceModule([['close', 'very'], ['medium', 'yes'], ['far', 'no']]) },
};

// ---------------------------------------------------------------- the agent

export class Agent extends Vehicle {
  // npc: { body, world, nav, kit, getSim, packCells(), bucket() → { id, n }, target() → { pos, vel, alive, holding } }
  constructor(npc) {
    super();
    this.npc = npc;
    this.maxSpeed = 24;
    this.maxForce = 240;
    this.updateOrientation = false;
    this.now = 0;
    this.prey = new MovingEntity();               // the target, mirrored (for pursuit and memory)
    this.pursuit = new PursuitBehavior(this.prey, 0.6);
    this.seek = new SeekBehavior(new YVector3());
    this.wander = new WanderBehavior(4, 8, 30);
    for (const b of [this.pursuit, this.seek, this.wander]) { b.active = false; this.steering.add(b); }
    this.memory = new MemorySystem(this);
    this.memory.memorySpan = MEMORY_S;
    this.memory.createRecord(this.prey);
    this.record.timeLastSensed = -Infinity;      // Yuka starts it at -1: as if just seen
    this.brain = new Think(this);
    for (const e of [new AttackEvaluator(), new HuntEvaluator(), new BreachEvaluator(), new ClimbEvaluator(0.9),
      new CoverEvaluator(), new ExtinguishEvaluator(), new GatherEvaluator(), new WanderEvaluator()]) this.brain.addEvaluator(e);
    this.regulator = new Regulator(ARBITRATE_HZ);
    this.intent = {};
    this.cool = {};                                // tool → time it's ready again
    this.weapon = null; this.weaponAt = -Infinity;
    this.lastGoal = '';
  }

  // ---- senses
  get feet() { return this.npc.body.pos; }
  eye(out = {}) { const p = this.npc.body.pos; out.x = p.x; out.y = p.y + TOOL_EYE; out.z = p.z; return out; }
  get target() { return this.npc.target(); }
  chest(p = this.target.pos) { return { x: p.x, y: p.y + CHEST, z: p.z }; }
  get record() { return this.memory.getRecord(this.prey); }
  get sees() { return this.record.visible; }
  get knows() { return this.target.alive && this.now - this.record.timeLastSensed < MEMORY_S; }
  get lastSeen() { const p = this.record.lastSensedPosition; return { x: p.x, y: p.y, z: p.z }; }
  get dist() { return hdist(this.feet, this.target.pos); }
  get dist3() { const t = this.target.pos, f = this.feet; return Math.hypot(t.x - f.x, t.y - f.y, t.z - f.z); }
  ready(tool) { return this.now >= (this.cool[tool] ?? 0); }
  cooldown(tool, s) { this.cool[tool] = this.now + s; }

  sense() {
    const t = this.target, rec = this.record;
    this.prey.position.set(t.pos.x, 0, t.pos.z);
    this.prey.velocity.set(t.vel.x, 0, t.vel.z);
    const e = this.eye();
    const visible = t.alive && (this.dist3 < TOUCH || (this.dist3 < SIGHT && this.npc.world.sees(e, this.chest())));
    if (visible) {
      if (!rec.visible) rec.timeBecameVisible = this.now;
      rec.timeLastSensed = this.now;
      rec.lastSensedPosition.set(t.pos.x, t.pos.y, t.pos.z);
    }
    rec.visible = visible;
  }

  // a hit: stagger out of whatever it was winding up
  stagger() {
    this.cooldown('ATTACK', STAGGER_S);
    this.useState = null;
  }
  // it hurt the target: a breather before the next attack
  landed() { this.cooldown('ATTACK', BREATHER_S); }
  // s it has had the target in sight, this time
  get inSight() { return this.sees ? this.now - this.record.timeBecameVisible : 0; }

  // it was hurt by the target, or heard it: it knows where the target is now
  alert() {
    const t = this.target, rec = this.record;
    if (!t.alive) return;
    rec.timeLastSensed = this.now;
    rec.lastSensedPosition.set(t.pos.x, t.pos.y, t.pos.z);
  }

  // ---- intents (what goals ask for this frame)
  clearIntent() {
    const i = this.intent;
    i.share = 0; i.sprint = false; i.jump = false; i.look = null; i.tool = null;
    i.primary = false; i.secondary = false; i.primaryPressed = false; i.secondaryPressed = false; i.chop = null;
    this.pursuit.active = this.seek.active = this.wander.active = false;
  }
  steerTo(p, share = 1) { this.seek.target.set(p.x, 0, p.z); this.seek.active = true; this.intent.share = share; this.intent.sprint = share > 0.7; }
  chase(share = 1) { this.pursuit.active = true; this.intent.share = share; this.intent.sprint = share > 0.7; }
  roam(share = 0.35) { this.wander.active = true; this.intent.share = share; }
  lookAt(p) { this.intent.look = { x: p.x, y: p.y, z: p.z }; }
  hold(tool) { this.intent.tool = tool; }

  // one frame of thinking: senses, (re)arbitration, the current goal
  think(dt) {
    this.now += dt;
    this.dt = dt;
    this.sense();
    this.clearIntent();
    if (this.regulator.ready()) this.brain.arbitrate();
    this.brain.execute();
    const g = this.brain.currentSubgoal();
    this.lastGoal = g?.label ?? '';
  }
}

// ---------------------------------------------------------------- evaluators

// The target is known: fight. Seen, more so.
class AttackEvaluator extends GoalEvaluator {
  calculateDesirability(a) { return a.knows && a.sees ? 0.6 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof AttackGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new AttackGoal(a)); } }
}
// Lost sight of it: go where it was last seen.
class HuntEvaluator extends GoalEvaluator {
  calculateDesirability(a) { return a.knows && !a.sees && a.ready('HUNT') ? 0.45 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof HuntGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new HuntGoal(a)); } }
}
// No way round to it and a breakable wall in between: break through.
class BreachEvaluator extends GoalEvaluator {
  calculateDesirability(a) {
    if (!a.knows || a.sees) return 0;
    if (!a.blockedAt || a.now - a.blockedAt > 2) return 0;   // set by GoTo when the path fails
    return a.ready('BREACH') && breachPlan(a) ? 0.7 : 0;
  }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof BreachGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new BreachGoal(a)); } }
}
// The target is up where it can't walk or jump: build up to it.
class ClimbEvaluator extends GoalEvaluator {
  calculateDesirability(a) {
    if (!a.knows || !a.ready('CLIMB')) return 0;
    const up = a.lastSeen.y - a.feet.y;
    if (up <= JUMP_UP) return 0;
    if (a.dist > 2 * BLOCK + 2 && a.npc.nav.path(a.feet, a.lastSeen, a.now)) return 0;   // there's a way round: walk it
    return 0.75;
  }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof ClimbGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new ClimbGoal(a)); } }
}
// Hurt and under fire: wall itself off, the sooner if the target holds something that reaches it.
const RANGED = new Set(['GUN', 'SMG', 'SNIPER', 'BOMB', 'ROCKET']);
class CoverEvaluator extends GoalEvaluator {
  calculateDesirability(a) {
    const b = a.npc.body;
    if (!a.sees || b.health > COVER_HEALTH || !a.ready('COVER') || a.npc.packCells() < 2 * BLOCK_CELLS) return 0;
    return RANGED.has(a.target.holding) ? 0.8 : 0.5;
  }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof CoverGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new CoverGoal(a)); } }
}
// On fire: get into water.
class ExtinguishEvaluator extends GoalEvaluator {
  calculateDesirability(a) { const b = a.npc.body; return ((b.feel?.heat ?? 0) > BURNING || b.status?.has('BURNING')) && !b.inLiquid && a.ready('EXTINGUISH') ? 0.95 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof ExtinguishGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new ExtinguishGoal(a)); } }
}
// Nothing to fight and an empty pack: dig some material for building.
class GatherEvaluator extends GoalEvaluator {
  calculateDesirability(a) { return !a.knows && a.npc.packCells() < GATHER_TO && a.ready('GATHER') ? 0.2 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof GatherGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new GatherGoal(a, GATHER_TO)); } }
}
class WanderEvaluator extends GoalEvaluator {
  calculateDesirability() { return 0.05; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof WanderGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new WanderGoal(a)); } }
}

// ---------------------------------------------------------------- atomic goals

// Walk to a point along an A* path (nav.js), re-planned as it goes.
class GoToGoal extends Goal {
  constructor(a, dest, within = 2) { super(a); this.dest = dest; this.within = within; }
  activate() { this.t = 0; this.plan(); this.best = Infinity; this.bestAt = 0; }
  plan() {
    const a = this.owner;
    this.path = a.npc.nav.path(a.feet, this.dest, a.now);
    this.i = 0; this.planned = this.t;
    if (!this.path) { a.blockedAt = a.now; this.status = Goal.STATUS.FAILED; }
  }
  execute() {
    const a = this.owner;
    this.t += a.dt;
    const d = hdist(a.feet, this.dest);
    if (d < this.within) { this.status = Goal.STATUS.COMPLETED; return; }
    if (d < this.best - 0.5) { this.best = d; this.bestAt = this.t; }
    if (this.t > GOTO_TIMEOUT_S || this.t - this.bestAt > STUCK_FAIL_S) { a.blockedAt = a.now; this.status = Goal.STATUS.FAILED; return; }
    if (this.t - this.planned > GOTO_REPATH_S) this.plan();
    if (!this.path) return;
    while (this.i < this.path.length - 1 && hdist(a.feet, this.path[this.i]) < WAYPOINT_REACH) this.i++;
    const w = this.path[this.i];
    a.steerTo(w);
    if (w.y - a.feet.y > 1.2 && hdist(a.feet, w) < 3) a.intent.jump = true;   // the next column is a step up
  }
}

// Use a tool through a per-frame plan: plan(agent, goal) returns true when done, false to fail, or undefined.
class ToolGoal extends Goal {
  constructor(a, plan, timeout = 6) { super(a); this.planFn = plan; this.timeout = timeout; }
  activate() { this.t = 0; this.state = {}; }
  execute() {
    this.t += this.owner.dt;
    const r = this.planFn(this.owner, this);
    if (r === true) this.status = Goal.STATUS.COMPLETED;
    else if (r === false || this.t > this.timeout) this.status = Goal.STATUS.FAILED;
  }
}

class WanderGoal extends Goal {
  activate() { this.t = 0; }
  execute() { this.t += this.owner.dt; this.owner.roam(); if (this.t > WANDER_S) this.status = Goal.STATUS.COMPLETED; }
}

// ---------------------------------------------------------------- composite goals
//
// Yuka runs a composite's subgoals in the order they were added (addSubgoal
// puts each at the front, currentSubgoal() takes the back): add them first to last.
// A composite that fails puts its strategy on FAIL_COOLDOWN_S, so Think tries
// something else instead of failing the same way every frame.

const FAIL_COOLDOWN_S = 4;
function settle(goal, name) {
  goal.status = goal.executeSubgoals();
  if (goal.status === Goal.STATUS.FAILED) goal.owner.cooldown(name, FAIL_COOLDOWN_S);
}

// Fight: choose a weapon (fuzzy), close in if it needs to, and use it.
class AttackGoal extends CompositeGoal {
  activate() { this.clearSubgoals(); }
  execute() {
    const a = this.owner;
    if (!a.knows) { this.status = Goal.STATUS.COMPLETED; return; }
    if (this.hasSubgoals()) {   // a GoTo toward it in progress
      const s = this.executeSubgoals();
      if (s === Goal.STATUS.FAILED) this.status = Goal.STATUS.FAILED;
      return;
    }
    const w = chooseWeapon(a);
    if (!w) {   // nothing usable from here: get closer
      approach(a);
      return;
    }
    // not yet: still reacting to the sight of it, staggered, or catching its breath; face it and hold
    if ((a.sees && a.inSight < REACTION_S) || !a.ready('ATTACK')) {
      a.lookAt(a.chest());
      a.hold(w);
      return;
    }
    USE[w](a);
  }
}

// Go where it was last seen, then look around.
class HuntGoal extends CompositeGoal {
  activate() { this.clearSubgoals(); this.addSubgoal(new GoToGoal(this.owner, this.owner.lastSeen, 3)); this.addSubgoal(new WanderGoal(this.owner)); }
  execute() {
    if (this.owner.sees) { this.status = Goal.STATUS.COMPLETED; return; }
    settle(this, 'HUNT');
  }
}

// Break through what's between it and the target: shovel (powder), axe (wood,
// glass, plants, ice), pickaxe (rock), bomb from a distance (what's left).
function breachPlan(a) {
  const e = a.eye(), c = a.chest(a.lastSeen);
  const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z);
  const dir = { x: (c.x - e.x) / d, y: (c.y - e.y) / d, z: (c.z - e.z) / d };
  const hit = a.npc.world.raycast(e, dir, Math.min(d, BREACH_RANGE * 3));
  if (!hit.valid || hit.cell.y < 0) return null;
  const id = hit.id;
  if (KIND[id] === K.POWDER) return { tool: 'SHOVEL', hit };
  if (AXEABLE(id)) return { tool: 'AXE', hit };
  if (PICKABLE(id)) return { tool: 'PICKAXE', hit };
  if (BOMBABLE(id)) return { tool: 'BOMB', hit };
  return null;
}
class BreachGoal extends CompositeGoal {
  activate() {
    const a = this.owner;
    const p = breachPlan(a);
    this.clearSubgoals();
    if (!p) { this.status = Goal.STATUS.FAILED; return; }
    const target = { x: p.hit.cell.x + 0.5, y: p.hit.cell.y + 0.5, z: p.hit.cell.z + 0.5 };
    if (p.tool === 'BOMB') {
      this.addSubgoal(new ToolGoal(a, (ag) => throwBombAt(ag, target, true) || undefined, 4));
    } else {
      // up to it, then work at it until it's gone
      if (Math.hypot(target.x - a.feet.x, target.z - a.feet.z) > HAND_REACH - 2) this.addSubgoal(new GoToGoal(a, target, HAND_REACH - 2));
      this.addSubgoal(new ToolGoal(a, (ag) => workCell(ag, p.tool, target), 8));
    }
  }
  execute() { this.activateIfInactive(); settle(this, 'BREACH'); }
}

// Build up to a target above: dig material if the pack is short, then pillar
// up (jump, place a block under the feet at the top of the jump), Minecraft's way.
class ClimbGoal extends CompositeGoal {
  activate() {
    const a = this.owner;
    this.clearSubgoals();
    const blocks = Math.min(PILLAR_MAX, Math.ceil((a.lastSeen.y - a.feet.y) / BLOCK));
    // material first, then stand next to the target's column, then build
    if (a.npc.packCells() < blocks * BLOCK_CELLS) this.addSubgoal(new GatherGoal(a, blocks * BLOCK_CELLS));
    const t = a.lastSeen;
    if (hdist(a.feet, t) > 2 * BLOCK) {
      const k = (hdist(a.feet, t) - BLOCK) / hdist(a.feet, t);
      this.addSubgoal(new GoToGoal(a, { x: a.feet.x + (t.x - a.feet.x) * k, y: a.feet.y, z: a.feet.z + (t.z - a.feet.z) * k }, 2));
    }
    this.addSubgoal(new ToolGoal(a, pillar(blocks), 6 + blocks * 2));
  }
  execute() { this.activateIfInactive(); settle(this, 'CLIMB'); }
}

// Wall itself off from the target: two blocks, one on the other, between them.
class CoverGoal extends CompositeGoal {
  activate() {
    const a = this.owner;
    a.cooldown('COVER', COVER_COOLDOWN);
    this.clearSubgoals();
    this.addSubgoal(new ToolGoal(a, coverWall(), 3));
  }
  execute() { this.activateIfInactive(); settle(this, 'COVER'); }
}

// On fire: run to the nearest water and stay in it until it's out.
class ExtinguishGoal extends CompositeGoal {
  activate() {
    const a = this.owner;
    this.clearSubgoals();
    const w = a.npc.world.nearest(a.feet, WATER_FIND, (i) => i === E.WATER);
    if (!w) { this.status = Goal.STATUS.FAILED; a.cooldown('EXTINGUISH', FAIL_COOLDOWN_S); return; }
    this.addSubgoal(new GoToGoal(a, { x: w.x + 0.5, y: w.y, z: w.z + 0.5 }, 1.5));
  }
  execute() {
    this.activateIfInactive();
    if (this.failed()) return;
    const b = this.owner.npc.body;
    if (b.inLiquid || (b.feel?.heat ?? 0) < BURNING / 2) { this.status = Goal.STATUS.COMPLETED; return; }
    settle(this, 'EXTINGUISH');
  }
}

// Dig until the pack holds `want` cells: the nearest powder, or the ground at its feet.
class GatherGoal extends CompositeGoal {
  constructor(a, want) { super(a); this.want = want; }
  activate() {
    const a = this.owner;
    this.clearSubgoals();
    const sand = a.npc.world.nearest(a.feet, GATHER_FIND, (i) => i >= 0 && KIND[i] === K.POWDER);
    const spot = sand ? { x: sand.x + 0.5, y: sand.y + 0.5, z: sand.z + 0.5 } : null;
    if (spot && hdist(a.feet, spot) > HAND_REACH - 2) this.addSubgoal(new GoToGoal(a, spot, HAND_REACH - 2));
    this.addSubgoal(new ToolGoal(a, (ag) => {
      if (ag.npc.packCells() >= this.want) return true;
      const e = ag.eye();
      // the nearest diggable cell in reach, or the ground in front of its feet
      const c = reachable(ag, ag.npc.world.nearest(e, HAND_REACH - 1, DIGGABLE), DIGGABLE);
      if (!c) return false;   // nothing to dig here
      ag.hold('SHOVEL');
      ag.lookAt({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
      ag.intent.primary = true;
      return undefined;
    }, 12));
  }
  execute() { this.activateIfInactive(); settle(this, 'GATHER'); }
}

// ---------------------------------------------------------------- weapons in use

function chooseWeapon(a) {
  // keep the current weapon a while unless it can't be used any more
  if (a.weapon && a.now - a.weaponAt < WEAPON_SWITCH_S && usable(a, a.weapon)) return a.weapon;
  let best = null, bw = 0;
  for (const [key, w] of Object.entries(WEAPONS)) {
    if (!usable(a, key)) continue;
    const d = w.rate(a.dist3) + (Math.random() * 2 - 1) * WEAPON_NOISE;
    if (d > bw) { bw = d; best = key; }
  }
  if (best !== a.weapon) { a.weapon = best; a.weaponAt = a.now; }
  return best;
}
// can weapon `key` be used from here, now?
const GATED = new Set(['BOMB', 'PHYSGUN', 'BUCKET']);   // unusable during their cooldown (the gun and axe wait while held)
function usable(a, key) {
  const w = WEAPONS[key];
  if (GATED.has(key) && !a.ready(key)) return false;
  if (w.needsSight && !a.sees) return false;
  const d = a.dist3;
  switch (key) {
    case 'AXE': return d < AXE_RANGE + 6;   // close enough to step in
    case 'BLOWTORCH': return d < TORCH_RANGE + 4;
    case 'BOMB': return d > BOMB_MIN && d < 90;
    case 'GUN': return true;
    case 'PHYSGUN': return d < PHYS.HOLD_MAX && !!a.npc.world.nearest(a.eye(), PHYS_FIND, LOOSE);
    case 'BUCKET': {
      const b = a.npc.bucket();
      if (b.id === E.LAVA && b.n >= BUCKET_WANT / 2) return d < 30;
      return !!a.npc.world.nearest(a.eye(), LAVA_FIND, (i) => i === E.LAVA);
    }
    default: return false;
  }
}

function approach(a) {
  // straight at it when it can see it, else along a path to where it was
  if (a.sees && Math.abs(a.target.pos.y - a.feet.y) < JUMP_UP) { a.chase(); a.lookAt(a.chest()); return; }
  const g = new GoToGoal(a, a.lastSeen, AXE_RANGE);
  a.brain.currentSubgoal()?.addSubgoal?.(g);
}

// aim the tool at p (with the hand's error), the look ray
function aimWith(a, p, err = 0) {
  if (!err) { a.lookAt(p); return; }
  const e = a.eye();
  const d = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z);
  a.lookAt({ x: p.x + gauss() * err * d, y: p.y + gauss() * err * d, z: p.z + gauss() * err * d });
}

const USE = {
  AXE(a) {
    const s = a.useState ??= {};
    if (s.tool !== 'AXE') { s.tool = 'AXE'; s.t = 0; }
    a.hold('AXE');
    a.lookAt(a.chest());
    if (a.dist3 > AXE_RANGE) { a.chase(); s.t = 0; return; }
    if (!a.ready('AXE')) return;
    s.t += a.dt;
    a.intent.chop = Math.min(s.t / AXE_WINDUP, 1) * 0.7;   // the arm rises: the tell (figure.js chop)
    if (s.t >= AXE_WINDUP) { a.intent.primaryPressed = true; a.intent.chop = 1; a.cooldown('AXE', AXE_COOLDOWN); s.t = 0; s.tool = null; }
  },
  GUN(a) {
    a.hold('GUN');
    const t = a.target;
    const ramp = Math.min(a.inSight / AIM_RAMP_S, 1);
    const err = AIM_ERROR_START + (AIM_ERROR - AIM_ERROR_START) * ramp + AIM_ERROR_MOVING * Math.hypot(t.vel.x, t.vel.z);
    const c = a.chest();
    if (a.warnedAt !== a.record.timeBecameVisible) {
      // the first shot since it spotted you: a near miss to one side
      const e = a.eye(), dx = c.x - e.x, dz = c.z - e.z, d = Math.hypot(dx, dz) || 1, side = Math.random() < 0.5 ? -1 : 1;
      a.lookAt({ x: c.x - (dz / d) * side * WARNING_MISS * 1.6, y: c.y, z: c.z + (dx / d) * side * WARNING_MISS * 1.6 });
      if (a.ready('GUN')) { a.intent.primaryPressed = true; a.cooldown('GUN', GUN_INTERVAL); a.warnedAt = a.record.timeBecameVisible; }
      return;
    }
    aimWith(a, c, err);
    if (a.dist3 > 60) a.chase(0.6);
    if (a.ready('GUN')) { a.intent.primaryPressed = true; a.cooldown('GUN', GUN_INTERVAL); }
  },
  BOMB(a) {
    const s = a.useState ??= {};
    if (s.tool !== 'BOMB') { s.tool = 'BOMB'; s.t = 0; }
    s.t += a.dt;
    a.hold('BOMB');
    a.lookAt(a.chest());
    a.intent.chop = Math.min(s.t / THROW_WINDUP, 1) * 0.7;   // the arm goes up: the tell
    if (s.t < THROW_WINDUP) return;
    const t = a.target.pos, d = a.dist;
    const at = { x: t.x + gauss() * BOMB_ERROR * d, y: t.y, z: t.z + gauss() * BOMB_ERROR * d };
    if (throwBombAt(a, at, false)) a.cooldown('BOMB', BOMB_COOLDOWN);
    s.tool = null;
  },
  BLOWTORCH(a) {
    const s = a.useState ??= {};
    if (s.tool !== 'BLOWTORCH') { s.tool = 'BLOWTORCH'; s.t = 0; }
    a.hold('BLOWTORCH');
    a.lookAt(a.chest());
    if (a.dist3 > TORCH_RANGE - 0.5) { a.chase(); s.t = 0; return; }
    s.t += a.dt;
    // aimed a moment (the tell), a burst, then a rest
    a.intent.primary = s.t > TORCH_IGNITE_S;
    if (s.t > TORCH_IGNITE_S + TORCH_BURST_S) { a.cooldown('ATTACK', TORCH_REST_S); s.tool = null; }
  },
  PHYSGUN(a) {
    const s = a.useState ??= {};
    if (s.tool !== 'PHYSGUN') { s.tool = 'PHYSGUN'; s.t = 0; s.cell = a.npc.world.nearest(a.eye(), PHYS_FIND, LOOSE); }
    a.hold('PHYSGUN');
    s.t += a.dt;
    if (s.t < PHYS_GRAB_S && s.cell) {
      a.lookAt({ x: s.cell.x + 0.5, y: s.cell.y + 0.5, z: s.cell.z + 0.5 });
      a.intent.primary = true;
      a.intent.primaryPressed = s.t <= a.dt;
      return;
    }
    a.lookAt(a.chest());
    a.intent.primary = true;
    a.intent.secondaryPressed = true;   // fling it at the target
    a.cooldown('PHYSGUN', PHYS_COOLDOWN);
    s.tool = null;
  },
  BUCKET(a) {
    const b = a.npc.bucket();
    a.hold('BUCKET');
    if (b.id === E.LAVA && b.n >= BUCKET_WANT / 2) {
      // carry it over and pour it on them
      const s = a.useState ??= {};
      if (s.tool !== 'BUCKET') { s.tool = 'BUCKET'; s.t = 0; }
      if (a.dist > POUR_RANGE) { a.chase(); a.lookAt(a.chest()); return; }
      a.lookAt({ x: a.target.pos.x, y: a.target.pos.y + 1, z: a.target.pos.z });
      a.intent.secondary = true;
      s.t += a.dt;
      if (s.t > POUR_S) { s.tool = null; a.cooldown('BUCKET', 2); }
      return;
    }
    // scoop lava within reach
    const lava = a.npc.world.nearest(a.eye(), LAVA_FIND, (i) => i === E.LAVA);
    if (!lava) return;
    a.lookAt({ x: lava.x + 0.5, y: lava.y + 0.5, z: lava.z + 0.5 });
    a.intent.primary = true;
  },
};

// Throw a bomb to land at p: the low arc of the projectile's launch angle
// θ = atan((v² − √(v⁴ − g(g·x² + 2·y·v²))) / (g·x)). False if out of range.
function throwBombAt(a, p, breach) {
  const e = a.eye();
  const dx = p.x - e.x, dz = p.z - e.z, x = Math.hypot(dx, dz), y = p.y + (breach ? 0 : 0.5) - e.y;
  if (!breach && x < BOMB_MIN) return false;
  const sim = a.npc.getSim();
  const g = ROUND_GRAVITY * gravityScale(sim), v = THROW_SPEED;
  const disc = v ** 4 - g * (g * x * x + 2 * y * v * v);
  if (disc < 0) { a.chase(); return false; }   // too far: close in
  const th = Math.atan((v * v - Math.sqrt(disc)) / (g * x));
  const c = Math.cos(th);
  a.hold('BOMB');
  a.lookAt({ x: e.x + (dx / x) * c * 10, y: e.y + Math.sin(th) * 10, z: e.z + (dz / x) * c * 10 });
  a.intent.primaryPressed = true;
  return true;
}

// cell c if the hand gets to it: the cell its look ray strikes on the way, if
// that passes want(id) (dig through what's in front), else null
function reachable(a, c, want) {
  if (!c) return null;
  const e = a.eye(), p = { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 };
  const d = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) || 1;
  const hit = a.npc.world.raycast(e, { x: (p.x - e.x) / d, y: (p.y - e.y) / d, z: (p.z - e.z) / d }, d + 1);
  if (!hit.valid || hit.cell.y < 0 || !want(hit.id)) return null;
  return { x: hit.cell.x, y: hit.cell.y, z: hit.cell.z, id: hit.id };
}

// Work at a cell with a hand tool (shovel, axe or pickaxe) until it's gone: true then.
const WORKS = { SHOVEL: DIGGABLE, AXE: AXEABLE, PICKAXE: PICKABLE };   // what each can take away
const BLOW_COOLDOWN = { AXE: AXE_COOLDOWN, PICKAXE: PICK_COOLDOWN };   // the swung ones, a click a blow
function workCell(a, tool, c) {
  const id = a.npc.world.id(c.x, c.y, c.z);
  if (id === E.EMPTY || !WORKS[tool](id)) return true;
  a.hold(tool);
  a.lookAt(c);
  if (tool in BLOW_COOLDOWN) a.intent.primaryPressed = a.ready(tool) && (a.cooldown(tool, BLOW_COOLDOWN[tool]), true);
  else a.intent.primary = true;
  return undefined;
}

// Pillar up `blocks` blocks: jump; near the top of the jump, look straight down
// and set a block under the feet. Done when that many are placed or it's up.
function pillar(blocks) {
  let placed = 0, base = null, waitLand = false;
  return (a) => {
    const b = a.npc.body;
    base ??= b.pos.y;
    if (placed >= blocks || b.pos.y - a.lastSeen.y > -1) return true;
    if (a.npc.packCells() < BLOCK_CELLS) return false;
    a.hold('TROWEL');
    if (b.onGround) {
      if (waitLand) { waitLand = false; }
      a.intent.jump = true;
      return undefined;
    }
    const top = base + placed * BLOCK;   // where the next block goes
    a.lookAt({ x: b.pos.x, y: b.pos.y - 10, z: b.pos.z });
    if (!waitLand && b.pos.y >= top + PILLAR_PLACE_RISE && b.vel.y < 4) {
      a.intent.primaryPressed = true;
      placed++; waitLand = true;
    }
    return undefined;
  };
}

// Two blocks between it and the target, one on the other.
function coverWall() {
  let placed = 0, t = 0;
  return (a) => {
    if (placed >= 2) return true;
    if (a.npc.packCells() < BLOCK_CELLS) return false;
    t += a.dt;
    a.hold('TROWEL');
    const f = a.feet, tp = a.target.pos, d = hdist(f, tp) || 1;
    const at = { x: f.x + ((tp.x - f.x) / d) * (BLOCK + 1), z: f.z + ((tp.z - f.z) / d) * (BLOCK + 1) };
    const y = placed === 0 ? a.npc.world.standAt(at.x, at.z, f.y + 1) - 0.5 : f.y + BLOCK - 0.5;
    a.lookAt({ x: at.x, y, z: at.z });
    if (t > 0.3) { a.intent.primaryPressed = true; placed++; t = 0; }
    return undefined;
  };
}

// readable names for checks (class names don't survive minification)
for (const [G, label] of [[AttackGoal, 'Attack'], [HuntGoal, 'Hunt'], [BreachGoal, 'Breach'], [ClimbGoal, 'Climb'], [CoverGoal, 'Cover'],
  [ExtinguishGoal, 'Extinguish'], [GatherGoal, 'Gather'], [WanderGoal, 'Wander'], [GoToGoal, 'GoTo'], [ToolGoal, 'Tool']]) G.prototype.label = label;

export { WEAPONS, BLOCK_CELLS, BODY_HEIGHT };
