import { Think, Goal, GoalEvaluator } from 'yuka';
import { Agent, AttackEvaluator, HuntEvaluator, ExtinguishEvaluator, WanderEvaluator } from './brain.js';

// Isolated mission mind on the existing Raven goals/navigation. No Hiisi flight,
// excavation, cover construction or omniscient through-wall touch sensing.
export class CrueltyAgent extends Agent {
  constructor(npc) {
    super(npc);
    this.profile = npc.combatProfile;
    this.maxSpeed = this.profile.speed;
    this.facing = { x: -Math.sin(this.profile.yaw), z: -Math.cos(this.profile.yaw) };
    this.brain = new Think(this);
    if (!this.profile.civilian) {
      this.brain.addEvaluator(new AttackEvaluator());
      this.brain.addEvaluator(new HuntEvaluator());
    } else this.brain.addEvaluator(new FleeEvaluator());
    this.brain.addEvaluator(new ExtinguishEvaluator());
    this.brain.addEvaluator(this.profile.patrol ? new WanderEvaluator() : new WaitEvaluator());
    this.fleeUntil = -Infinity;
  }
  canSee(at, distance) {
    if (distance >= this.profile.sight) return false;
    const dx = at.x - this.feet.x, dz = at.z - this.feet.z;
    // E_Grunt_Movement_New track_player checks front hemisphere until alerted.
    const alerted = [this.prey, ...this.foes.values()].some(e => this.now - this.memory.getRecord(e).timeLastSensed < this.memorySpan);
    if (!alerted && dx * this.facing.x + dz * this.facing.z < 0) return false;
    return this.npc.world.sees(this.eye(), this.chest(at));
  }
  alert(id) {
    if (!this.profile.civilian) {
      // Ensure an unseen attacker has a memory record on the first hit, too.
      if (id != null && !this.foes.has(id)) this.senseAll(this.npc.opponents?.() ?? []);
      super.alert(id); return;
    }
    const threat = this.npc.threat?.();
    if (!this.profile.stupid && threat?.alive) {
      this.fleeFrom = { ...threat.pos };
      this.fleeUntil = this.now + this.profile.memory;
      this.brain.clearSubgoals();
    }
  }
}
class FleeEvaluator extends GoalEvaluator {
  calculateDesirability(a) { return a.now < a.fleeUntil ? 0.8 : 0; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof FleeGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new FleeGoal(a)); } }
}
class FleeGoal extends Goal {
  execute() {
    const a = this.owner;
    if (a.now >= a.fleeUntil) { this.status = Goal.STATUS.COMPLETED; return; }
    const f = a.feet, t = a.fleeFrom;
    let dx = f.x - t.x, dz = f.z - t.z;
    if (dx === 0 && dz === 0) dx = 1;
    const d = Math.hypot(dx, dz);
    a.steerTo({ x: f.x + dx / d * 12, z: f.z + dz / d * 12 });
  }
}
class WaitEvaluator extends GoalEvaluator {
  calculateDesirability() { return 0.05; }
  setGoal(a) { if (!(a.brain.currentSubgoal() instanceof WaitGoal)) { a.brain.clearSubgoals(); a.brain.addSubgoal(new WaitGoal(a)); } }
}
class WaitGoal extends Goal {
  execute() {
    const a = this.owner;
    a.lookAt({ x: a.feet.x + a.facing.x * 10, y: a.feet.y + 5, z: a.feet.z + a.facing.z * 10 });
  }
}
FleeGoal.prototype.label = 'Flee';
WaitGoal.prototype.label = 'Wait';
