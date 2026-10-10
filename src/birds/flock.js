import {
  EntityManager, Vehicle, SteeringBehavior, AlignmentBehavior, CohesionBehavior, SeparationBehavior,
  WanderBehavior, ArriveBehavior, FleeBehavior, SeekBehavior, Vector3 as YVector3,
} from 'yuka';
import { CELL_M } from '../scale.js';

// Birds: flocks of Craig Reynolds' boids ("Flocks, Herds and Schools", 1987),
// steered by Yuka's own behaviours (Separation, Alignment, Cohesion, Wander,
// Arrive, Flee, Seek on Vehicles, one EntityManager per flock for its
// neighbourhoods), plus one of ours that Yuka has no twin for: keeping clear of
// the ground and water under a height lookup.
//
// This file is the CPU simulation only (it runs in node: tools/birds-check.mjs).
// Everything is in world cells (one cell = CELL_M) and seconds; a flock reads
// the world through `world` (birds/probe.js in the app, a fake in the check):
//   ground(x, z)        the top of the topmost solid or liquid at world column
//                       (x, z), cells (trees and roofs included where known)
//   hot(x, y, z)        is the cell there hot enough to set a bird alight?
//   perches(x, z, r)    perch spots within r of column (x, z): [{ x, y, z, tree }]
//                       (y: the surface a bird stands on), tree crowns and roofs
//   holds(spot)         is the surface under a perch spot still there?
//   bounds              null, or { x0, z0, x1, z1 }: the box a flock keeps inside
//
// A bird is a rock pigeon in size and speed: 0.65 m across the wings,
// cruising at 10 m/s, beating its wings ~6 times a second.

const M = 1 / CELL_M;   // cells per metre
export const G = 9.81 * M;                       // cells/s², gravity (birds fall in real time, like the POV body)

export const BIRD = {
  SPAN: 0.65 * M,                                // cells across the wings
  CRUISE: 10 * M,                                // cells/s, level flight
  MAX_SPEED: 16 * M,                             // cells/s, fleeing
  MAX_ACCEL: 22 * M,                             // cells/s², all steering together (a ~2 g turn)
  NEIGHBOR_R: 15 * M,                            // cells: a bird heeds the birds this close (Yuka neighbourhood)
  SEPARATION_R: 2 * M,                          // cells: only birds this close push apart
  SEPARATION_W: 50 * M,                          // cells²/s²: Yuka's separation sums 1/distance, so this over d is the push
  ALIGNMENT_W: 3 * M,                            // cells/s² per unit heading difference
  COHESION_W: 3 * M,                             // cells/s², toward the neighbours' centre (Yuka normalizes it)
  WANDER_R: 3 * M,                               // cells: Yuka wander circle's radius...
  WANDER_D: 6 * M,                               // ...this far ahead...
  WANDER_JITTER: 30 * M,                         // ...its target jittered this fast (cells/s)
  WANDER_W: 0.2,                                 // 1/s²: the wander force per cell to its target
  CRUISE_GAIN: 2.5,                              // 1/s: speed eases toward cruise this fast
  HOME_R: 45 * M,                                // cells: past this from home (sideways) a flock turns back
  HOME_W: 6 * M,                                 // cells/s², the pull home past it
  REGROUP_W: 4 * M,                              // cells/s²: a bird out of sight of its flock (past NEIGHBOR_R from its centre) heads back to it
  // height over the ground (cells)
  MIN_CLEAR: 3 * M,                              // closer than this, climb hard
  CRUISE_LO: 7 * M,                              // the band a flock cruises in
  CRUISE_HI: 16 * M,
  LOOKAHEAD_S: 0.9,                              // s of flight ahead whose ground counts too
  AVOID_ACCEL: 30 * M,                           // cells/s², the climb under MIN_CLEAR
  BAND_ACCEL: 4 * M,                             // cells/s², back into the band from outside it
  CLIMB_DAMP: 2.2,                               // 1/s: vertical speed damped by this while correcting
  EDGE: 6 * M,                                   // cells from a box's side where the push back starts
  EDGE_ACCEL: 20 * M,                            // cells/s², the push at the side itself
  // flapping (rendering reads these)
  FLAP_HZ: 6,                                    // wing beats per second, cruising
  FLAP_HZ_HARD: 9,                               // ...taking off and climbing hard
  GLIDE_MIN_S: 0.5, GLIDE_MAX_S: 1.4,            // s of a glide between bouts of flapping
  FLAP_MIN_S: 1.2, FLAP_MAX_S: 3,                // s of a bout of flapping
  EFFORT_RATE: 4,                                // 1/s: wing effort eases toward what flight needs
  BANK_MAX: 1.0,                                 // rad of roll into a turn at most
  BANK_RATE: 6,                                  // 1/s: roll eases toward the turn's
  // perching
  FLY_MIN_S: 25, FLY_MAX_S: 60,                  // s aloft before a flock looks for somewhere to land
  PERCH_MIN_S: 12, PERCH_MAX_S: 35,              // s on a perch by day
  PERCH_SEARCH: 40 * M,                          // cells: how far from the flock's centre it looks for perches
  PERCH_SPREAD: 8 * M,                           // cells: a flock's spots lie within this of the one it chose first
  PERCH_GAP: 1.6,                                // cells between two birds' spots at least
  APPROACH_H: 4 * M,                             // cells above its spot a bird comes in at...
  APPROACH_R: 3 * M,                             // ...until it is this close sideways, then drops onto it
  ARRIVE_DECEL: 1.2,                             // s: Yuka ArriveBehavior's deceleration (its speed is distance over this)
  ARRIVE_W: 3,                                   // 1/s: how fast a landing bird matches Arrive's velocity
  LAND_EPS: 0.6,                                 // cells from its spot a bird settles on it
  LAND_TIMEOUT_S: 20,                            // s a flock tries to land before giving up
  PERCH_RETRY_S: 8,                              // s before a flock that found nowhere looks again
  // taking off and fleeing
  STARTLE_R: 8 * M,                              // cells: a body this close flushes a perched or low flock
  TAKEOFF_UP: 4 * M,                             // cells/s up as it leaves the perch
  TAKEOFF_OUT: 3 * M,                            // cells/s away from what scared it
  TAKEOFF_S: 1.2,                                // s of hard flapping after taking off
  FLEE_S: 4,                                     // s a startled flock flees from where the scare was
  FLEE_R: 60 * M,                                // cells: Yuka FleeBehavior's panic distance
  FLEE_W: 1.4,                                   // weight on Flee (its force is a velocity change, cells/s)
  SCARED_FLY_MIN_S: 10, SCARED_FLY_MAX_S: 20,    // s a startled flock stays up before landing again
  ROOST_CALM_S: 8,                               // s after a scare before a roosting flock settles again
  // fire and death
  BURN_S: 1.6,                                   // s a burning bird flails on before it dies
  BURN_LIFT: 0.55,                               // share of its weight a burning bird still holds up
  BURN_FLAIL: 25 * M,                            // cells/s², random flailing while it burns
  FALL_DRAG: 0.4,                                // 1/s: air drag on a falling body
  DEAD_LINGER_S: 30,                             // s a dead bird lies where it fell
  KNOCK: 6 * M,                                  // cells/s a killing blow throws a bird along the blow
  SPAWN_R: 4 * M,                                // cells: a new flock's birds start within this of its home
  SPAWN_HEADING_SPREAD: 0.3,                     // rad: a new flock's birds set off within this of one heading
  CEILING_ABOVE: 40 * M,                         // cells above the highest ground under it a bird never goes
};

// a bird's states
export const S = { FLY: 0, LAND: 1, PERCH: 2, BURN: 3, FALL: 4, DEAD: 5, GONE: 6 };
// a flock's modes
const MODE = { FLY: 'fly', LAND: 'land', PERCH: 'perch' };

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const SUBSTEP = 1 / 60;   // s: steering integrates no coarser than this

// ---- our behaviours (Yuka has no terrain following)

// Keep a height band over the ground, look ahead for rising ground, climb hard
// under MIN_CLEAR; inside a box, keep off its sides.
class TerrainBehavior extends SteeringBehavior {
  constructor(flock) { super(); this.flock = flock; }
  calculate(v, force) {
    const w = this.flock.world, p = v.position;
    const gNow = w.ground(p.x, p.z);
    const gAhead = w.ground(p.x + v.velocity.x * BIRD.LOOKAHEAD_S, p.z + v.velocity.z * BIRD.LOOKAHEAD_S);
    const ground = Math.max(gNow, gAhead);
    const clear = p.y - ground;
    v.bird.clear = p.y - gNow;
    if (v.bird.state === S.LAND && v.bird.final) return force;   // the last drop onto the perch
    if (clear < BIRD.MIN_CLEAR) {
      force.y = BIRD.AVOID_ACCEL * (1 + (BIRD.MIN_CLEAR - clear) / BIRD.MIN_CLEAR) - Math.min(v.velocity.y, 0) * BIRD.CLIMB_DAMP;
    } else if (clear < BIRD.CRUISE_LO && v.bird.state === S.FLY) {
      force.y = BIRD.BAND_ACCEL * (BIRD.CRUISE_LO - clear) / BIRD.CRUISE_LO - Math.min(v.velocity.y, 0) * BIRD.CLIMB_DAMP;
    } else if (v.bird.state === S.FLY && (clear > BIRD.CRUISE_HI || clear > BIRD.CEILING_ABOVE)) {
      force.y = -BIRD.BAND_ACCEL * Math.min(1, (clear - BIRD.CRUISE_HI) / BIRD.CRUISE_HI) - Math.max(v.velocity.y, 0) * BIRD.CLIMB_DAMP;
    }
    const b = w.bounds;
    if (b) {
      const e = BIRD.EDGE;
      if (p.x < b.x0 + e) force.x += BIRD.EDGE_ACCEL * Math.min(1, (b.x0 + e - p.x) / e);
      if (p.x > b.x1 - e) force.x -= BIRD.EDGE_ACCEL * Math.min(1, (p.x - b.x1 + e) / e);
      if (p.z < b.z0 + e) force.z += BIRD.EDGE_ACCEL * Math.min(1, (b.z0 + e - p.z) / e);
      if (p.z > b.z1 - e) force.z -= BIRD.EDGE_ACCEL * Math.min(1, (p.z - b.z1 + e) / e);
    }
    return force;
  }
}

// Birds don't hover: ease the speed toward cruise along the heading.
class CruiseBehavior extends SteeringBehavior {
  calculate(v, force) {
    const s = v.getSpeed();
    if (s < 1e-6) { force.set(0, 0, BIRD.CRUISE * BIRD.CRUISE_GAIN); return force; }
    return force.copy(v.velocity).multiplyScalar((BIRD.CRUISE - s) * BIRD.CRUISE_GAIN / s);
  }
}

// Yuka's separation, from the birds within SEPARATION_R only (its 1/distance
// push summed over the whole neighbourhood throws the edge birds out)
const near = [];
class Separation extends SeparationBehavior {
  calculate(v, force, dt) {
    const all = v.neighbors, r2 = BIRD.SEPARATION_R ** 2;
    near.length = 0;
    for (const n of all) if (n.position.squaredDistanceTo(v.position) < r2) near.push(n);
    v.neighbors = near;
    super.calculate(v, force, dt);
    v.neighbors = all;
    return force;
  }
}

// Yuka's wander, its force scaled per cell to its target (its raw force is a displacement).
class Wander extends WanderBehavior {
  calculate(v, force, dt) { return super.calculate(v, force, dt).multiplyScalar(BIRD.WANDER_W); }
}

const yv = (x = 0, y = 0, z = 0) => new YVector3(x, y, z);

let nextBirdId = 1;

export class Flock {
  // world: see the top of this file; home: [x, y, z] world cells it spawns at and keeps near;
  // n: birds; opts: { homeR } (cells it roams from home, default BIRD.HOME_R)
  constructor(world, home, n, { homeR = BIRD.HOME_R } = {}) {
    this.world = world;
    this.home = yv(home[0], home[1], home[2]);
    this.homeR = homeR;
    this.manager = new EntityManager();
    this.birds = [];
    this.mode = MODE.FLY;
    this.timer = rand(BIRD.FLY_MIN_S, BIRD.FLY_MAX_S);
    this.fleeT = 0;
    this.threat = yv();
    this.centre = yv();
    this.roosting = false;
    this.landT = 0;
    this.calmT = Infinity;   // s since the last scare
    this.heading = Math.random() * 2 * Math.PI;   // rad, atan2(vx, vz): the way it sets off
    for (let i = 0; i < n; i++) this.addBird();
    this.updateCentre();
  }

  addBird() {
    const v = new Vehicle();
    const a = Math.random() * 2 * Math.PI, r = Math.random() * BIRD.SPAWN_R;
    v.position.set(this.home.x + Math.cos(a) * r, this.home.y + rand(-1, 1) * BIRD.SPAWN_R * 0.3, this.home.z + Math.sin(a) * r);
    const h = this.heading + rand(-1, 1) * BIRD.SPAWN_HEADING_SPREAD;   // a flock sets off together
    v.velocity.set(Math.sin(h) * BIRD.CRUISE, 0, Math.cos(h) * BIRD.CRUISE);
    v.maxSpeed = BIRD.MAX_SPEED;
    v.maxForce = BIRD.MAX_ACCEL;
    v.updateNeighborhood = true;
    v.neighborhoodRadius = BIRD.NEIGHBOR_R;
    v.boundingRadius = BIRD.SPAN / 2;
    const terrain = new TerrainBehavior(this);
    const separation = new Separation(); separation.weight = BIRD.SEPARATION_W;
    const flee = new FleeBehavior(this.threat, BIRD.FLEE_R); flee.weight = BIRD.FLEE_W; flee.active = false;
    const arrive = new ArriveBehavior(yv(), BIRD.ARRIVE_DECEL); arrive.weight = BIRD.ARRIVE_W; arrive.active = false;
    const alignment = new AlignmentBehavior(); alignment.weight = BIRD.ALIGNMENT_W;
    const cohesion = new CohesionBehavior(); cohesion.weight = BIRD.COHESION_W;
    const home = new SeekBehavior(yv()); home.weight = BIRD.HOME_W / BIRD.MAX_SPEED; home.active = false;
    const regroup = new SeekBehavior(this.centre); regroup.weight = BIRD.REGROUP_W / BIRD.MAX_SPEED; regroup.active = false;
    const cruise = new CruiseBehavior();
    const wander = new Wander(BIRD.WANDER_R, BIRD.WANDER_D, BIRD.WANDER_JITTER);
    // Yuka sums them in this order, each truncated to what is left of maxForce: the first come first
    for (const b of [terrain, separation, flee, arrive, alignment, cohesion, regroup, home, cruise, wander]) v.steering.add(b);
    const bird = {
      id: nextBirdId++, v, flock: this, state: S.FLY,
      b: { separation, flee, arrive, alignment, cohesion, regroup, home, cruise, wander },
      spot: null, final: false, clear: Infinity,
      // animation
      phase: Math.random() * 2 * Math.PI, effort: 0.5, gliding: false, boutT: rand(BIRD.FLAP_MIN_S, BIRD.FLAP_MAX_S),
      bank: 0, heading: Math.atan2(v.velocity.x, v.velocity.z), takeoffT: 0,   // heading: atan2(vx, vz), rad
      burnT: 0, deadT: 0, hue: Math.random(),
    };
    v.bird = bird;
    this.manager.add(v);
    this.birds.push(bird);
    return bird;
  }

  get alive() { return this.birds.filter((b) => b.state <= S.BURN).length; }
  get gone() { return this.birds.every((b) => b.state === S.GONE); }

  updateCentre() {
    let n = 0;
    this.centre.set(0, 0, 0);
    for (const b of this.birds) if (b.state <= S.PERCH) { this.centre.add(b.v.position); n++; }
    if (n) this.centre.divideScalar(n);
    else this.centre.copy(this.home);
    return n;
  }

  // Something scared the flock at p (world cells): every live bird that isn't
  // already burning or falling takes off (or, aloft, flees) away from it.
  startle(p) {
    this.threat.set(p.x, p.y, p.z);
    this.fleeT = BIRD.FLEE_S;
    this.calmT = 0;
    for (const b of this.birds) {
      if (b.state === S.PERCH || b.state === S.LAND) this.takeOff(b, p);
      if (b.state === S.FLY) b.b.flee.active = true;
    }
    this.mode = MODE.FLY;
    this.timer = rand(BIRD.SCARED_FLY_MIN_S, BIRD.SCARED_FLY_MAX_S);
  }

  takeOff(b, from = null) {
    const v = b.v;
    b.state = S.FLY;
    b.spot = null;
    b.final = false;
    b.b.arrive.active = false;
    v.active = true;
    let ox = Math.sin(b.heading), oz = Math.cos(b.heading);
    if (from) {
      const dx = v.position.x - from.x, dz = v.position.z - from.z, d = Math.hypot(dx, dz);
      if (d > 1e-3) { ox = dx / d; oz = dz / d; }
    }
    v.velocity.set(ox * BIRD.TAKEOFF_OUT, BIRD.TAKEOFF_UP, oz * BIRD.TAKEOFF_OUT);
    b.takeoffT = BIRD.TAKEOFF_S;
    b.effort = 1;
    b.gliding = false;
  }

  // A killing blow (a round, an axe, a blast) along unit dir (or none).
  kill(b, dir = null) {
    if (b.state >= S.FALL) return;
    const v = b.v;
    if (b.state === S.PERCH) v.velocity.set(0, 0, 0);
    if (dir) { v.velocity.x += dir.x * BIRD.KNOCK; v.velocity.y += dir.y * BIRD.KNOCK; v.velocity.z += dir.z * BIRD.KNOCK; }
    b.state = S.FALL;
    v.active = false;
    b.spot = null;
  }

  ignite(b) {
    if (b.state >= S.BURN) return;
    if (b.state === S.PERCH) this.takeOff(b);
    b.state = S.BURN;
    b.burnT = BIRD.BURN_S;
    b.v.active = false;
    b.spot = null;
  }

  // Find spots for the flying birds near the flock's centre and send them in.
  // Returns false if there are none.
  planLanding() {
    const spots = this.world.perches(this.centre.x, this.centre.z, BIRD.PERCH_SEARCH);
    if (!spots.length) return false;
    // trees first, then the nearest; the flock lands around the first it picks
    const c = this.centre;
    spots.sort((a, b) => (b.tree - a.tree) || (Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z)));
    const pick = spots[Math.floor(Math.random() * Math.min(spots.length, 4))];
    // the spots nearest it, a gap apart, as many as there are birds
    const flying = this.birds.filter((b) => b.state === S.FLY);
    const dist = (s) => Math.hypot(s.x - pick.x, s.z - pick.z);
    const near = spots.filter((s) => dist(s) <= BIRD.PERCH_SPREAD).sort((a, b) => dist(a) - dist(b));
    const chosen = [];
    for (const s of near) {
      if (chosen.length >= flying.length) break;
      if (chosen.every((o) => Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z) >= BIRD.PERCH_GAP)) chosen.push(s);
    }
    flying.sort((a, b) => a.v.position.distanceTo(pick) - b.v.position.distanceTo(pick));
    let k = 0;
    for (const b of flying) {
      const s = chosen[k++];
      if (!s) break;
      b.state = S.LAND;
      b.spot = s;
      b.final = false;
      b.b.arrive.active = true;
      b.b.flee.active = false;
    }
    return k > 0;
  }

  // ctx: { night: bool (roost), threats: [{ x, y, z }] (bodies that flush birds) }
  update(dt, ctx = {}) {
    if (dt <= 0) return;
    const n = Math.ceil(dt / SUBSTEP);
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h, ctx);
  }

  step(dt, ctx) {
    const live = this.updateCentre();
    // ---- the flock's mind
    for (const t of ctx.threats ?? []) {
      for (const b of this.birds) {
        if (b.state > S.PERCH) continue;
        const p = b.v.position;
        if (Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) < BIRD.STARTLE_R && (b.state !== S.FLY || this.fleeT <= 0)) { this.startle(t); break; }
      }
    }
    this.fleeT = Math.max(0, this.fleeT - dt);
    if (this.fleeT <= 0) for (const b of this.birds) b.b.flee.active = false;
    this.roosting = !!ctx.night;
    this.timer -= dt;
    this.calmT += dt;
    if (live) {
      if (this.mode === MODE.FLY && (this.timer <= 0 || (this.roosting && this.calmT >= BIRD.ROOST_CALM_S))) {
        if (this.planLanding()) { this.mode = MODE.LAND; this.landT = BIRD.LAND_TIMEOUT_S; }
        else this.timer = BIRD.PERCH_RETRY_S;
      } else if (this.mode === MODE.LAND) {
        this.landT -= dt;
        const landing = this.birds.some((b) => b.state === S.LAND);
        if (!landing) { this.mode = MODE.PERCH; this.timer = rand(BIRD.PERCH_MIN_S, BIRD.PERCH_MAX_S); }
        else if (this.landT <= 0) {   // the ones that couldn't get in fly on; the rest stay down
          for (const b of this.birds) if (b.state === S.LAND) this.takeOff(b);
          const down = this.birds.some((b) => b.state === S.PERCH);
          this.mode = down ? MODE.PERCH : MODE.FLY;
          this.timer = down ? rand(BIRD.PERCH_MIN_S, BIRD.PERCH_MAX_S) : BIRD.PERCH_RETRY_S;
        }
      } else if (this.mode === MODE.PERCH && this.timer <= 0 && !this.roosting) {
        for (const b of this.birds) if (b.state === S.PERCH || b.state === S.LAND) this.takeOff(b);
        this.mode = MODE.FLY; this.timer = rand(BIRD.FLY_MIN_S, BIRD.FLY_MAX_S);
      } else if (this.mode === MODE.PERCH) {
        // birds still up (no spot was free, or they couldn't get in) look again now and then
        this.retryT = (this.retryT ?? BIRD.PERCH_RETRY_S) - dt;
        if (this.retryT <= 0) { this.retryT = BIRD.PERCH_RETRY_S; if (this.birds.some((b) => b.state === S.FLY)) this.planLanding(); }
      }
    }
    // ---- steering for the birds in the air (Yuka), then each bird's own state
    for (const b of this.birds) this.preSteer(b);
    this.manager.update(dt);
    for (const b of this.birds) this.postStep(b, dt);
  }

  preSteer(b) {
    const v = b.v;
    if (b.state !== S.FLY && b.state !== S.LAND) return;
    const p = v.position;
    // home: past homeR (sideways) the flock turns back
    b.b.home.active = b.state === S.FLY && Math.hypot(p.x - this.home.x, p.z - this.home.z) > this.homeR;
    b.b.regroup.active = b.state === S.FLY && p.distanceTo(this.centre) > BIRD.NEIGHBOR_R;
    if (b.b.home.active) b.b.home.target.set(this.home.x, Math.max(p.y, this.world.ground(this.home.x, this.home.z) + BIRD.CRUISE_LO), this.home.z);
    if (b.state === S.LAND) {
      const s = b.spot;
      const side = Math.hypot(p.x - s.x, p.z - s.z);
      b.final = side < BIRD.APPROACH_R;
      b.b.arrive.target.set(s.x, s.y + (b.final ? 0 : BIRD.APPROACH_H), s.z);
      b.b.separation.active = !b.final;   // spots sit side by side: on the last drop each keeps to its own
      b.b.cruise.active = false;
      b.b.wander.active = false;
      b.b.alignment.active = false;
      b.b.cohesion.active = false;
    } else {
      b.b.separation.active = true;
      b.b.cruise.active = true;
      b.b.wander.active = true;
      b.b.alignment.active = true;
      b.b.cohesion.active = true;
    }
  }

  postStep(b, dt) {
    const v = b.v, p = v.position, w = this.world;
    switch (b.state) {
      case S.FLY:
      case S.LAND: {
        if (w.hot(p.x, p.y, p.z)) { this.ignite(b); break; }
        if (b.state === S.LAND) {
          const s = b.spot;
          if (!w.holds(s)) { this.takeOff(b); break; }
          if (Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) < BIRD.LAND_EPS) {
            b.state = S.PERCH;
            v.active = false;
            p.set(s.x, s.y, s.z);
            v.velocity.set(0, 0, 0);
            b.b.arrive.active = false;
            break;
          }
        }
        // never inside the ground (a lookup the steering couldn't beat: a cliff it was thrown at)
        const g = w.ground(p.x, p.z);
        if (b.state === S.FLY && p.y < g + BIRD.SPAN * 0.5) { p.y = g + BIRD.SPAN * 0.5; v.velocity.y = Math.max(v.velocity.y, 0); }
        this.animateFlight(b, dt);
        break;
      }
      case S.PERCH:
        if (w.hot(p.x, p.y, p.z)) { this.ignite(b); break; }
        if (!w.holds(b.spot ?? p)) { this.takeOff(b); break; }
        b.effort += (0 - b.effort) * ease(BIRD.EFFORT_RATE, dt);
        b.bank += (0 - b.bank) * ease(BIRD.BANK_RATE, dt);
        break;
      case S.BURN: {
        b.burnT -= dt;
        v.velocity.y -= G * (1 - BIRD.BURN_LIFT) * dt;
        v.velocity.x += rand(-1, 1) * BIRD.BURN_FLAIL * dt;
        v.velocity.z += rand(-1, 1) * BIRD.BURN_FLAIL * dt;
        this.fall(b, dt);
        b.effort = 1;
        b.phase += 2 * Math.PI * BIRD.FLAP_HZ_HARD * dt;
        if (b.burnT <= 0 && b.state === S.BURN) b.state = S.FALL;
        break;
      }
      case S.FALL:
        v.velocity.y -= G * dt;
        this.fall(b, dt);
        b.effort += (0 - b.effort) * ease(BIRD.EFFORT_RATE, dt);
        break;
      case S.DEAD:
        b.deadT -= dt;
        if (b.deadT <= 0) b.state = S.GONE;
        break;
      default: break;
    }
  }

  // ballistic flight of a burning or dead bird, landing on what is under it
  fall(b, dt) {
    const v = b.v, p = v.position;
    v.velocity.multiplyScalar(Math.exp(-BIRD.FALL_DRAG * dt));
    p.x += v.velocity.x * dt; p.y += v.velocity.y * dt; p.z += v.velocity.z * dt;
    const g = this.world.ground(p.x, p.z);
    if (p.y <= g) {
      p.y = g;
      v.velocity.set(0, 0, 0);
      if (b.state === S.FALL || b.burnT <= 0) { b.state = S.DEAD; b.deadT = BIRD.DEAD_LINGER_S; }
    }
  }

  // wing beats and banking from how the bird flies
  animateFlight(b, dt) {
    const v = b.v, s = Math.max(v.getSpeed(), 1e-6);
    // effort: climbing, slow or just off the perch needs the wings; diving doesn't
    let want = 0.45 + 1.4 * (v.velocity.y / BIRD.CRUISE) + (BIRD.CRUISE - s) / BIRD.CRUISE;
    if (b.takeoffT > 0) { b.takeoffT -= dt; want = 1; }
    // flap and glide in bouts, as pigeons and starlings do
    b.boutT -= dt;
    if (b.boutT <= 0) {
      b.gliding = !b.gliding;
      b.boutT = b.gliding ? rand(BIRD.GLIDE_MIN_S, BIRD.GLIDE_MAX_S) : rand(BIRD.FLAP_MIN_S, BIRD.FLAP_MAX_S);
    }
    if (b.gliding && want < 0.8) want = 0;
    want = Math.min(1, Math.max(0, want));
    b.effort += (want - b.effort) * ease(BIRD.EFFORT_RATE, dt);
    const hz = BIRD.FLAP_HZ + (BIRD.FLAP_HZ_HARD - BIRD.FLAP_HZ) * Math.max(0, (want - 0.5) * 2);
    b.phase = (b.phase + 2 * Math.PI * hz * dt * (b.effort > 0.05 ? 1 : 0)) % (2 * Math.PI * 1024);
    // bank into the turn: roll whose lift supplies the turn's sideways acceleration
    const heading = Math.atan2(v.velocity.x, v.velocity.z);
    let dh = heading - b.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.heading = heading;
    const omega = dh / dt;
    const roll = Math.max(-BIRD.BANK_MAX, Math.min(BIRD.BANK_MAX, Math.atan(omega * Math.hypot(v.velocity.x, v.velocity.z) / G)));
    b.bank += (roll - b.bank) * ease(BIRD.BANK_RATE, dt);
  }

  // drop the birds that are gone (their targets are already removed)
  prune() { this.birds = this.birds.filter((b) => { if (b.state !== S.GONE) return true; this.manager.remove(b.v); return false; }); }
}
