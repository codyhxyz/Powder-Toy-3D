import * as THREE from 'three';
import { Vehicle, MovingEntity, EntityManager, StateMachine, State, PursuitBehavior, WanderBehavior } from 'yuka';
import { createPlayer } from './player.js';
import { createFigure, part } from './figure.js';
import { buildCrasher, CRASHER_COLORS } from './figureCrasher.js';
import { addTarget } from './targets.js';
import { BODY_HEIGHT, BODY_WIDTH } from './constants.js';

// The axeman: an NPC that hunts the player with an axe (the lab world, in POV).
//
// Its body is the player's own (player.js: a second instance, with its own
// probe), so it runs, jumps, swims, burns, drowns and is blown up by the same
// rules. Its look is the Castle Crashers wizard in red with an axe in the right
// mitten (figureCrasher.js, figure.js's chop pose).
//
// Its brain is Yuka (github.com/Mugen87/yuka): a StateMachine (wander → chase →
// attack) and steering behaviours on a Vehicle that mirrors the body on the
// ground plane. Pursuit steers toward where the player is heading, not where
// they are. Each frame the vehicle's steered velocity becomes the body's wished
// move (direction and share of top speed), the same input the player's keys
// give, and the body does the moving. When the body is blocked it jumps.
//
// The player's axe and gun hit it through targets.js.

// senses
const SIGHT = 48;                 // cells: notices a player this close...
const LOSE = 72;                  // ...and gives up past this
const ATTACK_REACH = 3.6;         // cells between body centres from which the axe lands (arm + axe)
const ATTACK_HEIGHT = BODY_HEIGHT; // cells: the player's feet within this of its own

// steering (Yuka units: cells, s)
const MAX_SPEED = 24;             // cells/s it steers at: a little under the player's sprint (28.5), so the jet and a sprint escape
const MAX_FORCE = 120;            // cells/s²: how hard it can turn
const PREDICTION = 0.6;           // pursuit's look-ahead, as Yuka's predictionFactor
const WANDER = [4, 8, 30];        // Yuka WanderBehavior radius, distance, jitter
const WANDER_SHARE = 0.35;        // of top speed: a stroll
const SPRINT_FROM = 0.7;          // wished share of top speed above which it sprints (the body's run)

// the swing
const SWING_S = 0.75;             // s for one chop: the wind-up is the tell (figure.js CHOP_WINDUP)
const STRIKE_AT = 0.7;            // share of the swing when the blow lands
const COOLDOWN_S = 0.5;           // s after a chop before the next
const DAMAGE = 0.2;               // health per blow: five kill
const KNOCKBACK = 18;             // cells/s the blow throws the player away (and a little up)
const KNOCK_UP = 0.4;             // upward share of the knockback

// stuck → jump
const STUCK_SPEED = 0.25;         // share of the wished speed below which it counts as blocked...
const STUCK_S = 0.2;              // ...for this long, then it jumps
const JUMP_COOLDOWN_S = 0.5;
const CLIMB_FROM = 3;             // cells: a player this much higher makes it jump when near

// being hit
const FLINCH_S = 0.3;             // s it can't swing after taking a blow
const HIT_KNOCKBACK = 14;         // cells/s a blow throws it

// life
const RESPAWN_S = 8;              // s dead before another comes
const SPAWN_DIST = 30;            // cells from the player it appears (dropped from above)
const SPAWN_DROP = 18;            // cells above the player's feet
const EDGE = 4;                   // cells: spawns stay this far inside the box walls

// look
const PALETTE = {
  ...CRASHER_COLORS,
  robe: [0.32, 0.02, 0.02], hood: [0.22, 0.015, 0.015], trim: [0.25, 0.25, 0.27], belt: [0.06, 0.05, 0.05],
};
const EYE_GLOW = [4, 0.35, 0.15]; // HDR: red eyes
const AXE_HANDLE = [0.08, 1.7];   // cells: radius, length (forward from the mitten)
const AXE_HEAD = [0.08, 0.7, 0.5]; // cells: blade thickness, height, depth
const AXE_COLORS = { handle: [0.3, 0.15, 0.06], blade: [0.5, 0.52, 0.56] };

const HW = BODY_WIDTH / 2;

function buildAxeman() {
  const rig = buildCrasher({ palette: PALETTE, eyeGlow: EYE_GLOW, pack: false });
  // the axe: handle out forward from the right mitten, the head at its end, edge down
  const grip = new THREE.Group();
  grip.position.y = rig.handY;
  rig.elR.add(grip);
  const [hr, hl] = AXE_HANDLE, [bt, bh, bd] = AXE_HEAD;
  part(grip, new THREE.CylinderGeometry(hr, hr, hl, 8).rotateX(Math.PI / 2).translate(0, 0, -hl / 2 + 0.2), AXE_COLORS.handle);
  part(grip, new THREE.BoxGeometry(bt, bh, bd).translate(0, -bh / 2 + 0.12, -hl + 0.2 + bd / 2 - 0.1), AXE_COLORS.blade);
  return rig;
}

// Yuka's brain: states over a Vehicle on the ground plane (y = 0).
class Wander extends State {
  enter(b) { b.stateName = 'wander'; b.pursuit.active = false; b.wander.active = true; b.share = WANDER_SHARE; }
  execute(b) { if (b.sees()) b.fsm.changeTo('chase'); }
}
class Chase extends State {
  enter(b) { b.stateName = 'chase'; b.wander.active = false; b.pursuit.active = true; b.share = 1; }
  execute(b) {
    if (!b.sees(LOSE)) b.fsm.changeTo('wander');
    else if (b.inReach()) b.fsm.changeTo('attack');
  }
}
class Attack extends State {
  enter(b) { b.stateName = 'attack'; b.pursuit.active = false; b.wander.active = false; b.share = 0; b.swingT = 0; b.struck = false; }
  execute(b) {
    b.swingT += b.dt;
    if (!b.struck && b.swingT >= SWING_S * STRIKE_AT) {
      b.struck = true;
      if (b.inReach(1.25)) b.npc.blow();
    }
    if (b.swingT >= SWING_S + COOLDOWN_S) b.fsm.changeTo(b.inReach() && b.sees() ? 'attack' : 'chase');
  }
  exit(b) { b.swingT = -1; }
}

class Brain extends Vehicle {
  constructor(npc) {
    super();
    this.npc = npc;
    this.maxSpeed = MAX_SPEED;
    this.maxForce = MAX_FORCE;
    this.updateOrientation = false;
    this.prey = new MovingEntity();              // the player, mirrored on the ground plane
    this.pursuit = new PursuitBehavior(this.prey, PREDICTION);
    this.wander = new WanderBehavior(...WANDER);
    this.steering.add(this.pursuit);
    this.steering.add(this.wander);
    this.share = 0;                              // wished share of top speed, set by the state
    this.swingT = -1;                            // s into the current chop, -1 when not swinging
    this.struck = false;
    this.dt = 0;
    this.fsm = new StateMachine(this);
    this.fsm.add('wander', new Wander());
    this.fsm.add('chase', new Chase());
    this.fsm.add('attack', new Attack());
    this.fsm.changeTo('wander');
  }
  sees(range = SIGHT) { return this.npc.preyAlive() && this.npc.preyDist() < range; }
  inReach(k = 1) { return this.npc.preyAlive() && this.npc.preyDist() < ATTACK_REACH * k && Math.abs(this.npc.preyDy()) < ATTACK_HEIGHT; }
  update(delta) {
    this.dt = delta;
    if (this.npc.flinch <= 0 || this.fsm.in('attack')) this.fsm.update();
    return super.update(delta);
  }
}

// One axeman. world (each frame): { player, toWorld(grid, out), worldToGrid, scale }
export function createAxeman({ renderer, getSim }) {
  const body = createPlayer({ renderer, getSim });
  const figure = createFigure(buildAxeman);
  const npc = { flinch: 0 };
  const brain = new Brain(npc);
  const manager = new EntityManager();
  manager.add(brain);
  manager.add(brain.prey);

  let world = null, deadTime = 0, stuckT = 0, jumpWait = 0, spawned = false, yaw = 0;
  const input = { move: { x: 0, z: 0 }, jump: false, sprint: false, down: false };
  const vFeet = new THREE.Vector3(), tmp = new THREE.Vector3();

  npc.preyAlive = () => !!world && !world.player.dead;
  npc.preyDist = () => Math.hypot(world.player.pos.x - body.pos.x, world.player.pos.z - body.pos.z);
  npc.preyDy = () => world.player.pos.y - body.pos.y;
  // the blow lands: hurt the player and throw them away from the axe
  npc.blow = () => {
    const p = world.player;
    tmp.set(p.pos.x - body.pos.x, 0, p.pos.z - body.pos.z).normalize();
    tmp.y = KNOCK_UP;
    p.hurt(DAMAGE, 'Axed by the red wizard');
    p.applyImpulse(tmp.normalize().multiplyScalar(KNOCKBACK));
  };

  const removeTarget = addTarget({
    get alive() { return spawned && !body.dead; },
    box(min, max) {
      min.set(body.pos.x - HW, body.pos.y, body.pos.z - HW);
      max.set(body.pos.x + HW, body.pos.y + BODY_HEIGHT, body.pos.z + HW);
    },
    hurt(amount, cause, dir) {
      body.hurt(amount, cause);
      body.applyImpulse(tmp.set(dir.x, Math.max(dir.y, 0) + KNOCK_UP, dir.z).normalize().multiplyScalar(HIT_KNOCKBACK));
      npc.flinch = FLINCH_S;
      if (!brain.fsm.in('attack') && !body.dead) brain.fsm.changeTo('chase');   // hit from anywhere: it comes for you
    },
  });

  // drop in at SPAWN_DIST from the player, on a random bearing, inside the box
  function spawn(sim) {
    const g = sim.g, p = world.player.pos;
    const a = Math.random() * 2 * Math.PI;
    const x = THREE.MathUtils.clamp(p.x + Math.cos(a) * SPAWN_DIST, EDGE, g.nx - EDGE);
    const z = THREE.MathUtils.clamp(p.z + Math.sin(a) * SPAWN_DIST, EDGE, g.nz - EDGE);
    const y = Math.min(p.y + SPAWN_DROP, g.ny - BODY_HEIGHT - 1);
    body.spawn(new THREE.Vector3(x, y, z));
    brain.fsm.changeTo('wander');
    deadTime = 0; stuckT = 0; npc.flinch = 0;
    spawned = true;
  }

  return {
    root: figure.root,
    bind(volume, g) { figure.bind(volume, g); },
    compile(r, camera, scene) { return figure.compile(r, camera, scene); },
    get body() { return body; },
    get state() { return brain.stateName; },   // 'wander', 'chase' or 'attack' (checks)
    update(dt, w) {
      world = w;
      const sim = getSim();
      if (!sim || dt <= 0) return;
      if (!spawned) spawn(sim);
      if (body.dead) {
        deadTime += dt;
        if (deadTime >= RESPAWN_S) spawn(sim);
      }
      npc.flinch = Math.max(0, npc.flinch - dt);

      // the brain, on the ground plane
      brain.position.set(body.pos.x, 0, body.pos.z);
      brain.velocity.set(body.vel.x, 0, body.vel.z);
      brain.prey.position.set(w.player.pos.x, 0, w.player.pos.z);
      brain.prey.velocity.set(w.player.vel.x, 0, w.player.vel.z);
      if (!body.dead) manager.update(dt);

      // the body: the steered velocity is the wished move
      const alive = !body.dead;
      const sp = Math.hypot(brain.velocity.x, brain.velocity.z);
      const share = alive && sp > 1e-3 ? Math.min(1, brain.share) : 0;
      input.move.x = share ? (brain.velocity.x / sp) * share : 0;
      input.move.z = share ? (brain.velocity.z / sp) * share : 0;
      input.sprint = share > SPRINT_FROM;
      // blocked (or the player is up on something close): jump
      jumpWait = Math.max(0, jumpWait - dt);
      const want = share * MAX_SPEED, got = Math.hypot(body.vel.x, body.vel.z);
      stuckT = want > 0 && got < want * STUCK_SPEED ? stuckT + dt : 0;
      const climb = brain.fsm.in('chase') && npc.preyDy() > CLIMB_FROM && npc.preyDist() < SIGHT / 4;
      input.jump = alive && body.onGround && jumpWait === 0 && (stuckT > STUCK_S || climb);
      if (input.jump) { jumpWait = JUMP_COOLDOWN_S; stuckT = 0; }
      body.update(dt, input);

      // the figure: faces where it's going, or the player while it swings
      const swinging = brain.swingT >= 0 && alive;
      if (swinging || brain.fsm.in('chase')) yaw = Math.atan2(-(w.player.pos.x - body.pos.x), -(w.player.pos.z - body.pos.z));
      else if (got > 1) yaw = Math.atan2(-body.vel.x, -body.vel.z);
      w.toWorld(body.pos, vFeet);
      figure.setVisible(spawned);
      figure.update(dt, {
        feet: vFeet, scale: w.scale, yaw, worldToGrid: w.worldToGrid,
        speedH: got, velY: body.vel.y, onGround: body.onGround, inLiquid: body.inLiquid, headInLiquid: body.headInLiquid,
        dead: body.dead, deadTime, heat: body.feel?.heat ?? 0, jetting: false,
        chop: swinging ? Math.min(brain.swingT / SWING_S, 1) : null,
      });
    },
    setVisible(v) { figure.setVisible(v && spawned); },
    reset() { spawned = false; figure.setVisible(false); },
    dispose() { removeTarget(); figure.dispose(); body.dispose(); },
  };
}
