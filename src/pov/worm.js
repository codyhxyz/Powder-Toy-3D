import * as THREE from 'three';
import { MovingEntity, Vehicle, PursuitBehavior, SeekBehavior, WanderBehavior, Vector3 as YVector3 } from 'yuka';
import { ELEMENTS, E, K } from '../elements.js';
import { toolPass, wormFrag, WORM_BITE } from '../shaders/povTools.js';
import { figureFrag } from './figure.js';
import { addTarget, allTargets, PLAYER } from './targets.js';
import { povEvents } from './events.js';
import { OUTSIDE } from './ai/world.js';
import { ROUND_GRAVITY, gravityScale } from './ballistics.js';
import { BODY_HEIGHT } from './constants.js';

// A worm: Noita's Mato (data/entities/animals/worm.xml), a chain of segments
// that tunnels through the ground and hunts whatever walks on it.
//
// - Body: segments that follow the head at a fixed spacing along the path it
//   took (the classic snake: each segment sits a fixed arc length back along
//   the head's trail), so the body goes into the same hole the head did and
//   comes out of the same breach. One InstancedMesh, the head with jaws.
// - Movement: inside matter (the CPU world model, ai/world.js) it steers in 3D
//   with Yuka's seek, pursuit and wander, its turn bounded by the steering
//   force (Reynolds: a turn rate of maxForce / speed). The buried part of its
//   body is what it pushes against: once most of it is out in the open it has
//   nothing to push on and flies ballistic under gravity, so it breaches in an
//   arc and dives back in, Noita's signature.
// - Terrain, physics first: every couple of cells the head bites
//   (shaders/povTools.js blowFrag with WORM_BITE, the pickaxe's GPU pass): the
//   solids its energy beats break into their debris in place, loose powder and
//   liquid are parted out of its way. Nothing is deleted (Noita's worms eat what
//   they touch; this one leaves a tunnel of rubble). WALL, CLONE, METAL and the
//   box's walls stop it: it slides along them.
// - Behaviour: it hunts the nearest body (the player, an NPC) it senses within
//   Noita's hunt box, else goes to the last loud noise it heard (a gunshot, a
//   blast), else roams near home. It bites what its jaws touch, through the
//   body's own hurt (cause "Eaten by a worm"), and is hurt by every weapon
//   through targets.js, each segment a target.
//
// Units: grid cells, seconds. Noita's numbers are scaled as the player's are
// (player.js): Mina is 11 px tall and the body BODY_HEIGHT cells.

const NOITA_BODY_PX = 11;               // px, Mina head to feet (player.js)
const PX = BODY_HEIGHT / NOITA_BODY_PX; // cells per Noita pixel
const NOITA_MINA_HP = 4;                // Mina's health in Noita's units (100 shown)

// Sizes. Noita's worm.xml: hitbox_radius 5 px, part_distance 10 px, hp 10;
// worm_big.xml: part_distance 16 px (×1.6), and we scale the rest with it.
// The drawn chain is twice as dense as Noita's parts so it reads as one body.
export const WORM_SIZE = {
  small: { radius: 5 * PX, spacing: 10 * PX / 2, segments: 12, hp: 10 / NOITA_MINA_HP, bite: WORM_BITE },
  giant: { radius: 8 * PX, spacing: 16 * PX / 2, segments: 16, hp: 40 / NOITA_MINA_HP, bite: WORM_BITE },
};
const TAIL_SHARE = 0.35;                // the tail's radius as a share of the head's (it tapers)

// movement
const CRUISE_SPEED = 57 * PX / 2;       // cells/s roaming: half Mina's run (Noita: speed 2 to speed_hunt 4)
const HUNT_SPEED = 57 * PX;             // cells/s hunting: Mina's run, so on foot you only just keep ahead
// A hunt is a shark's pass, Noita's worm attack: stalk under the body, lunge up
// through it, fly on out of the ground in an arc, dive back in and come round again.
const TURN_RATE = 4;                    // rad/s: the steering force is TURN_RATE × speed (a turn radius of speed / TURN_RATE)
const BREACH_HEIGHT = 3 * BODY_HEIGHT;  // cells: a lunge clears three body heights out of the ground (sets its speed)
const STALK_UNDER = HUNT_SPEED / TURN_RATE;   // cells under the body it stalks: room to turn up into a lunge
const LUNGE_RANGE = STALK_UNDER;        // cells (horizontally) from the body it turns up and lunges
const LUNGE_S = 3;                      // s a lunge lasts at most
const LUNGE_FAR = 1000;                 // cells: a lunge steers for a point this far along its line (a heading, not a place)
const DIVE_S = 1.2;                     // s it dives on after a lunge before it stalks again
const DIVE_AHEAD = 2 * STALK_UNDER;     // cells on along its heading it dives to
const ANCHOR_SHARE = 0.75;              // share of the segments in matter it still pushes off (a quarter of it out, it flies)
const WANDER = { radius: 3, distance: 8, jitter: 40 };   // Yuka WanderBehavior: a wriggle on the way
const WANDER_WEIGHT = 0.4;
const ROAM_RADIUS = 30;                 // cells around home it roams
const ROAM_DEPTH = 8;                   // cells under the surface it roams at
const ROAM_REACH = 4;                   // cells: a roam point this close is reached, pick another
const ROAM_TRIES = 8;
const HEAD_SKIN = 0.5;                  // cells ahead of the head's centre its collision test looks
const SUBSTEP = 0.5;                    // cells: the longest move between collision tests
const MAX_DT = 0.1;                     // s: longer frames are moved as this long

// digging
const DIG_STEP = WORM_BITE.DEPTH / 2;   // cells the head moves between bites (they overlap by half)
const DIG_MIN_S = 1 / 30;               // s between bites at most (the pass is a full-grid one)
const DIG_LEAD = 1;                     // cells ahead of the head the bite is centred
const BITE_FULL = (id) => id >= 0 && ELEMENTS[id].kind === K.SOLID && !!ELEMENTS[id].breakInto && ELEMENTS[id].hard <= WORM_BITE.ENERGY;

// senses (Noita's WormAIComponent)
const SENSE = 256 * PX;                 // cells: hunt_box_radius 256 px, it feels a body this near through the ground
const HEAR_SHOT = 2 * SENSE;            // cells: a gunshot this near draws it...
const HEAR_BLAST = 3 * SENSE;           // ...and a blast this near
const NOISE_S = 250 / 60;               // s it goes after a noise (give_up_time_frames 250)

// fighting
const PLAYER_SHARE = 0.5;               // share of an NPC's damage the player takes (index.js PLAYER_DAMAGE_TAKEN)
const BITE_DAMAGE = 1 / NOITA_MINA_HP / PLAYER_SHARE;   // health a bite takes: Noita's bite_damage 1, 25 of Mina's 100 after the player's share
const BITE_COOLDOWN_S = 1;              // s between bites (one a pass)
const BITE_REACH = 1.2;                 // × the head's radius its jaws close on
const KNOCKBACK = 6;                    // cells/s a blow pushes the head (a heavy body)
const HOT_T = 300;                      // °C at the head that burns it (ai/world.js)
const BURN_RATE = 0.5;                  // health/s it loses burning
const CAUSE = 'Eaten by a worm';

// life
const RESPAWN_S = 8;                    // s dead before another comes (npc.js)
const CORPSE_S = 4;                     // s the corpse stays
const SPAWN_DIST = 40;                  // cells from the player it comes up, with no spawner

// look (linear albedo, lit like the volume: figure.js)
const FLESH = [0.42, 0.2, 0.17];
const BONE = [0.75, 0.68, 0.52];
const MOUTH = [0.12, 0.02, 0.02];
const EYE_GLOW = [3, 2.2, 0.4];         // HDR: yellow eyes
const JAW_OPEN = 0.65;                  // rad, the jaws open wide
const JAW_RATE = 12;                    // 1/s the jaws follow
const SEG_DETAIL = 1;                   // icosahedron detail of a segment
const ELONGATE = 1.25;                  // a segment's length over its width (they overlap into one body)

const KIND = ELEMENTS.map((e) => e.kind);
const isMatter = (id) => id === OUTSIDE || (id !== E.EMPTY && KIND[id] !== K.GAS);
const stops = (id) => id === OUTSIDE || (id >= 0 && KIND[id] === K.SOLID && !BITE_FULL(id));
let nextId = 1;

const instVert = /* glsl */ `
uniform mat4 uWorldToGrid;
out vec3 vGrid;
out vec3 vN;
void main() {
#ifdef USE_INSTANCING
  mat4 m = modelMatrix * instanceMatrix;
#else
  mat4 m = modelMatrix;
#endif
  vec4 w = m * vec4(position, 1.0);
  vGrid = (uWorldToGrid * w).xyz;
  vN = mat3(m) * normal;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const UNBOUND = new THREE.MeshBasicMaterial();   // until bind() builds the lit materials (figure.js)

// The worm's look: segments as one InstancedMesh, the head with its jaws and eyes.
function buildLook(size) {
  const root = new THREE.Group();
  root.visible = false;
  const segGeo = new THREE.IcosahedronGeometry(1, SEG_DETAIL);
  const body = new THREE.InstancedMesh(segGeo, UNBOUND, size.segments);
  body.frustumCulled = false;
  const head = new THREE.Group();
  const R = size.radius;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 12).scale(1, 0.85, 1.05).translate(0, 0, -R * 0.3), UNBOUND);
  // the jaws: half cones hinged at the back of the mouth, pointing forward (+z)
  const jaw = (start) => new THREE.ConeGeometry(R * 0.95, R * 1.5, 12, 1, false, start, Math.PI).rotateX(Math.PI / 2).translate(0, 0, R * 0.75);
  const upper = new THREE.Mesh(jaw(Math.PI / 2), UNBOUND), lower = new THREE.Mesh(jaw(-Math.PI / 2), UNBOUND);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(R * 0.7, 10, 8).scale(1, 0.6, 1).translate(0, 0, R * 0.2), UNBOUND);
  const hinge = new THREE.Group();
  hinge.position.z = R * 0.1;
  hinge.add(upper, lower, mouth);
  const eyeGeo = new THREE.SphereGeometry(R * 0.16, 8, 6);
  const eyeMat = new THREE.MeshBasicMaterial();
  eyeMat.color.setRGB(...EYE_GLOW);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(s * R * 0.55, R * 0.45, R * 0.35);
    head.add(e);
  }
  head.add(skull, hinge);
  root.add(body, head);
  const parts = [[body, FLESH], [skull, FLESH], [upper, BONE], [lower, BONE], [mouth, MOUTH]];
  return { root, body, head, upper, lower, parts, eyeMat };
}

// One worm. ai: { world } (npc.js createAi). env: { renderer, getSim }.
// home(): its spawner's feet (grid cells), or null for a spot near the player.
export function createWorm({ env, ai, home = () => null, size: sizeKey = 'small' }) {
  const id = `worm${nextId++}`;
  const size = WORM_SIZE[sizeKey];
  const R = size.radius;
  const length = (size.segments) * size.spacing;
  const world = ai.world;
  const look = buildLook(size);
  const uniforms = { uEmit: { value: new THREE.Vector3() }, uWorldToGrid: { value: new THREE.Matrix4() } };
  let mats = [], boundTo = null, compiled = null;
  const pass = toolPass(wormFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));

  // the head is a Yuka vehicle: its position and velocity are the worm's
  const v = new Vehicle();
  v.updateOrientation = false;
  const prey = new MovingEntity();
  const pursuit = new PursuitBehavior(prey, 0.5);
  const seek = new SeekBehavior(new YVector3());
  const wander = new WanderBehavior(WANDER.radius, WANDER.distance, WANDER.jitter);
  wander.weight = WANDER_WEIGHT;
  for (const b of [pursuit, seek, wander]) { b.active = false; v.steering.add(b); }
  const force = new YVector3();

  // the trail: head positions every TRAIL_STEP cells, newest last; the segments sit along it
  const TRAIL_STEP = size.spacing / 4;
  const TRAIL_MAX = Math.ceil(length / TRAIL_STEP) + 8;
  let trail = [];
  const segs = Array.from({ length: size.segments }, () => new THREE.Vector3());
  const radii = segs.map((_, i) => R * (1 - (1 - TAIL_SHARE) * (i / (size.segments - 1))));

  let spawned = false, dead = false, deadTime = 0, health = size.hp, cause = null;
  let digAt = null, digWait = 0, biteWait = 0, jaw = 0, anchored = false, buried = 0, mode = 'roam';
  let roamTo = null, noise = null, noiseT = 0, quarry = null;
  let phase = 'stalk', phaseT = 0, flew = false, committed = false, diveTo = null;
  const lungeDir = new YVector3();
  const listeners = new Map();
  const emit = (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload); };
  const headV = new THREE.Vector3(), tmp = new THREE.Vector3(), lo = new THREE.Vector3(), hi = new THREE.Vector3();
  const actor = { id, at: headV };
  const stats = { bites: 0, digs: 0, breaches: 0, blocked: 0 };

  // ---- hit boxes: one target per segment (weapons hit the body where it is)
  const removers = segs.map((p, i) => addTarget({
    id, creature: 'worm',
    get alive() { return spawned && !dead; },
    box(min, max) { const r = radii[i]; min.set(p.x - r, p.y - r, p.z - r); max.set(p.x + r, p.y + r, p.z + r); },
    hurt(amount, why, d) { hurt(amount, why, p, d); },
  }));

  function hurt(amount, why, at, d) {
    if (!spawned || dead) return;
    health -= amount;
    emit('hurt', { amount, cause: why, point: at.clone() });
    if (d) v.velocity.add(new YVector3(d.x, d.y, d.z).multiplyScalar(KNOCKBACK));
    if (mode !== 'hunt' && quarry === null) { noise = { x: at.x, y: at.y, z: at.z }; noiseT = NOISE_S; }
    if (health <= 0) { dead = true; deadTime = 0; cause = why; emit('death', { cause: why, point: at.clone() }); }
  }

  // loud noises draw it: gunshots and blasts
  const offShot = povEvents.on('gun:fire', (e) => heard(e.origin, HEAR_SHOT, e.by));
  const offBlast = povEvents.on('blast', (e) => heard(e.point, HEAR_BLAST, e.by));
  function heard(p, range, by) {
    if (!p || !spawned || dead || by === id) return;
    if (Math.hypot(p.x - v.position.x, p.y - v.position.y, p.z - v.position.z) > range) return;
    noise = { x: p.x, y: p.y, z: p.z }; noiseT = NOISE_S;
  }

  // ---- life
  function spawn(at) {
    const sim = env.getSim(), g = sim.g;
    let p = at;
    if (!p) {
      // under the ground, SPAWN_DIST from the nearest body
      const t = nearestBody(Infinity);
      const c = t ? t.center : { x: g.nx / 2, y: 0, z: g.nz / 2 };
      const a = Math.random() * 2 * Math.PI;
      const x = THREE.MathUtils.clamp(c.x + Math.cos(a) * SPAWN_DIST, R, g.nx - R), z = THREE.MathUtils.clamp(c.z + Math.sin(a) * SPAWN_DIST, R, g.nz - R);
      p = { x, y: Math.max(R, world.standAt(x, z) - ROAM_DEPTH), z };
    }
    v.position.set(p.x, p.y, p.z);
    v.velocity.set(0, -CRUISE_SPEED, 0);   // it goes in head first
    // the body trails straight up behind it, out of the hole it makes
    trail = [];
    for (let k = TRAIL_MAX - 1; k >= 0; k--) trail.push(new THREE.Vector3(p.x, p.y + k * TRAIL_STEP, p.z));
    placeSegments();
    health = size.hp; dead = false; deadTime = 0; cause = null;
    digAt = null; biteWait = 0; jaw = 0; noise = null; roamTo = null; quarry = null;
    setPhase('stalk');
    spawned = true;
  }

  // the live body (not a worm) nearest the head within range: { t, center, dist }
  function nearestBody(range) {
    let best = null;
    for (const t of allTargets()) {
      if (!t.alive || t.creature === 'worm') continue;
      t.box(lo, hi);
      const c = tmp.addVectors(lo, hi).multiplyScalar(0.5);
      const d = Math.hypot(c.x - v.position.x, c.y - v.position.y, c.z - v.position.z);
      if (d < range && d < (best?.dist ?? Infinity)) best = { t, center: { x: c.x, y: c.y, z: c.z }, dist: d };
    }
    return best;
  }

  // a point in matter near home to roam to
  function pickRoam() {
    const h = home() ?? { x: v.position.x, y: v.position.y, z: v.position.z };
    const [nx, , nz] = world.dims;
    for (let k = 0; k < ROAM_TRIES; k++) {
      const a = Math.random() * 2 * Math.PI, r = Math.random() * ROAM_RADIUS;
      const x = THREE.MathUtils.clamp(h.x + Math.cos(a) * r, R, nx - R), z = THREE.MathUtils.clamp(h.z + Math.sin(a) * r, R, nz - R);
      const y = world.standAt(x, z) - ROAM_DEPTH;
      if (y > R && isMatter(world.id(x, y, z)) && !stops(world.id(x, y, z))) return { x, y, z };
    }
    return null;
  }

  // ---- the mind: what it steers for
  function decide(dt, w) {
    pursuit.active = seek.active = wander.active = false;
    noiseT = Math.max(0, noiseT - dt);
    const q = nearestBody(SENSE);
    quarry = q;
    const p = v.position;
    if (q) {
      mode = 'hunt';
      phaseT += dt;
      const c = q.center;
      const tv = q.t.id === PLAYER ? w.player?.vel : null;   // the player's velocity leads the pursuit; others are chased where they are
      prey.position.set(c.x, c.y, c.z);
      if (tv) prey.velocity.set(tv.x, tv.y, tv.z); else prey.velocity.set(0, 0, 0);
      const h = Math.hypot(c.x - p.x, c.z - p.z);
      v.maxSpeed = HUNT_SPEED;
      if (phase === 'stalk') {
        // under it, deep enough to turn up into the lunge
        const ground = Math.min(world.standAt(c.x, c.z, c.y + 1), c.y);
        seek.target.set(c.x, Math.max(R + 1, ground - STALK_UNDER), c.z);
        seek.active = true;
        if (h < LUNGE_RANGE && p.y < c.y) setPhase('lunge');
      } else if (phase === 'lunge') {
        // up at it (pursuit) until level with it, then straight on through (it passes, it doesn't circle),
        // fast enough to fly BREACH_HEIGHT on once its body stops pushing
        const g = ROUND_GRAVITY * gravityScale(env.getSim());
        v.maxSpeed = Math.max(HUNT_SPEED, Math.sqrt(2 * g * BREACH_HEIGHT));
        if (!committed && p.y >= c.y) { committed = true; lungeDir.copy(v.velocity).normalize(); }
        if (committed) { seek.target.copy(p).add(lungeDir.clone().multiplyScalar(LUNGE_FAR)); seek.active = true; }
        else pursuit.active = true;
        if (!anchored) flew = true;
        if ((flew && anchored) || phaseT > LUNGE_S) {
          // back in the ground (or it never got out): dive on, ahead and down
          const sp = Math.hypot(v.velocity.x, v.velocity.z) || 1;
          const x = p.x + (v.velocity.x / sp) * DIVE_AHEAD, z = p.z + (v.velocity.z / sp) * DIVE_AHEAD;
          diveTo = { x, y: Math.max(R + 1, world.standAt(x, z) - STALK_UNDER), z };
          setPhase('dive');
        }
      } else {
        seek.target.set(diveTo.x, diveTo.y, diveTo.z);
        seek.active = true;
        if (phaseT > DIVE_S) setPhase('stalk');
      }
    } else if (noise && noiseT > 0) {
      mode = 'noise';
      seek.target.set(noise.x, Math.min(noise.y, world.standAt(noise.x, noise.z) - ROAM_DEPTH / 2), noise.z);
      seek.active = true;
      v.maxSpeed = HUNT_SPEED;
      if (p.distanceTo(seek.target) < ROAM_REACH) noise = null;
    } else {
      mode = 'roam';
      if (!roamTo || Math.hypot(roamTo.x - p.x, roamTo.y - p.y, roamTo.z - p.z) < ROAM_REACH) roamTo = pickRoam();
      if (roamTo) { seek.target.set(roamTo.x, roamTo.y, roamTo.z); seek.active = true; }
      wander.active = true;
      v.maxSpeed = CRUISE_SPEED;
    }
    v.maxForce = TURN_RATE * v.maxSpeed;
  }

  function setPhase(ph) { phase = ph; phaseT = 0; flew = false; committed = false; }

  // ---- moving: steer when it has something to push on, else fly; slide along what stops it
  function move(dt) {
    const sim = env.getSim();
    const headIn = isMatter(world.id(v.position.x, v.position.y, v.position.z));
    buried = 0;
    for (const s of segs) if (isMatter(world.id(s.x, s.y, s.z))) buried++;
    const wasAnchored = anchored;
    anchored = !dead && (headIn || buried >= ANCHOR_SHARE * segs.length);
    if (wasAnchored && !anchored && v.velocity.y > 0) stats.breaches++;
    if (anchored) {
      v.steering.calculate(dt, force);
      v.velocity.add(force.divideScalar(v.mass).multiplyScalar(dt));
      if (v.getSpeedSquared() > v.maxSpeed * v.maxSpeed) v.velocity.normalize().multiplyScalar(v.maxSpeed);
    } else {
      v.velocity.y -= ROUND_GRAVITY * gravityScale(sim) * dt;
    }
    // move in substeps, each axis on its own: a stopping cell ahead zeroes that axis (slide)
    const dist = v.velocity.length() * dt;
    const n = Math.max(1, Math.ceil(dist / SUBSTEP));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      for (const a of ['x', 'y', 'z']) {
        const d = v.velocity[a] * h;
        if (!d) continue;
        const p = v.position;
        const ahead = p[a] + d + Math.sign(d) * HEAD_SKIN;
        const q = { x: p.x, y: p.y, z: p.z };
        q[a] = ahead;
        if (stops(world.id(q.x, q.y, q.z))) { v.velocity[a] = 0; stats.blocked++; continue; }
        p[a] += d;
      }
    }
    // keep the trail: a point every TRAIL_STEP
    const last = trail[trail.length - 1];
    headV.set(v.position.x, v.position.y, v.position.z);
    const gap = last.distanceTo(headV);
    if (gap >= TRAIL_STEP) {
      const steps = Math.min(Math.floor(gap / TRAIL_STEP), TRAIL_MAX);
      for (let k = 1; k <= steps; k++) trail.push(last.clone().lerp(headV, k / steps));
      if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
    }
    placeSegments();
  }

  // each segment a fixed arc length back along the trail from the head
  function placeSegments() {
    let i = 0, want = size.spacing, acc = 0;
    let prev = headV.set(v.position.x, v.position.y, v.position.z).clone();
    for (let k = trail.length - 1; k >= 0 && i < segs.length; k--) {
      const p = trail[k];
      const d = prev.distanceTo(p);
      while (i < segs.length && acc + d >= want) {
        segs[i].copy(prev).lerp(p, d > 0 ? (want - acc) / d : 0);
        i++; want += size.spacing;
      }
      acc += d; prev = p;
    }
    for (; i < segs.length; i++) segs[i].copy(prev);
  }

  // ---- digging: the pickaxe's pass, every DIG_STEP cells, where there's something to bite
  function dig(dt) {
    digWait = Math.max(0, digWait - dt);
    const p = v.position, sp = v.velocity.length();
    if (digWait > 0 || sp < 1e-3) return;
    if (digAt && Math.hypot(p.x - digAt.x, p.y - digAt.y, p.z - digAt.z) < DIG_STEP) return;
    const d = tmp.set(v.velocity.x / sp, v.velocity.y / sp, v.velocity.z / sp);
    const cx = p.x + d.x * DIG_LEAD, cy = p.y + d.y * DIG_LEAD, cz = p.z + d.z * DIG_LEAD;
    // only where the world model has matter it can move (breakable or loose) at the head or ahead
    const ids = [world.id(p.x, p.y, p.z), world.id(cx, cy, cz), world.id(cx + d.x * R, cy + d.y * R, cz + d.z * R)];
    if (!ids.some((i) => i >= 0 && i !== E.EMPTY && (BITE_FULL(i) || KIND[i] === K.POWDER || KIND[i] === K.LIQUID))) return;
    const sim = env.getSim();
    const mat = pass(sim);
    mat.uniforms.uCenter.value.set(cx, cy, cz);
    mat.uniforms.uDir.value.copy(d);
    sim.pass(mat);
    digAt = { x: p.x, y: p.y, z: p.z };
    digWait = DIG_MIN_S;
    stats.digs++;
  }

  // ---- biting: a body its jaws touch
  function bite(dt) {
    biteWait = Math.max(0, biteWait - dt);
    const p = v.position, reach = R * BITE_REACH;
    let near = false;
    for (const t of allTargets()) {
      if (!t.alive || t.creature === 'worm') continue;
      t.box(lo, hi);
      const dx = Math.max(lo.x - p.x, 0, p.x - hi.x), dy = Math.max(lo.y - p.y, 0, p.y - hi.y), dz = Math.max(lo.z - p.z, 0, p.z - hi.z);
      const d = Math.hypot(dx, dy, dz);
      if (d < reach * 2) near = true;
      if (d > reach || biteWait > 0) continue;
      const sp = v.velocity.length() || 1;
      const dir = new THREE.Vector3(v.velocity.x / sp, v.velocity.y / sp, v.velocity.z / sp);
      headV.set(p.x, p.y, p.z);
      povEvents.as(actor, () => t.hurt(BITE_DAMAGE, CAUSE, dir));
      povEvents.as(actor, () => povEvents.emit('impact', { source: 'worm', point: headV.clone(), normal: dir.clone().negate(), id: -1, energy: WORM_BITE.ENERGY, broke: null, body: true }));
      biteWait = BITE_COOLDOWN_S;
      jaw = 0;   // snapped shut
      stats.bites++;
    }
    return near;
  }

  // ---- the look
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3();
  function draw(dt, w, near) {
    look.root.position.copy(w.toWorld(tmp.set(0, 0, 0), new THREE.Vector3()));
    look.root.scale.setScalar(w.scale);
    uniforms.uWorldToGrid.value.copy(w.worldToGrid);
    for (let i = 0; i < segs.length; i++) {
      const a = i === 0 ? headV.set(v.position.x, v.position.y, v.position.z) : segs[i - 1];
      dir.subVectors(a, segs[i]);
      if (dir.lengthSq() > 1e-9) q.setFromUnitVectors(fwd, dir.normalize());
      const r = radii[i];
      mtx.compose(segs[i], q, sc.set(r, r, r * ELONGATE));
      look.body.setMatrixAt(i, mtx);
    }
    look.body.instanceMatrix.needsUpdate = true;
    const sp = v.velocity.length();
    if (sp > 1e-3) look.head.quaternion.setFromUnitVectors(fwd, dir.set(v.velocity.x / sp, v.velocity.y / sp, v.velocity.z / sp));
    look.head.position.set(v.position.x, v.position.y, v.position.z);
    const open = dead ? 1 : near && biteWait === 0 ? 1 : 0;
    jaw += (open - jaw) * (1 - Math.exp(-JAW_RATE * dt));
    look.upper.rotation.x = -JAW_OPEN * jaw;
    look.lower.rotation.x = JAW_OPEN * jaw;
  }

  // a dead worm's body drops where it's in the open
  function sag(dt) {
    const g = ROUND_GRAVITY * gravityScale(env.getSim());
    const fall = g * Math.min(deadTime, CORPSE_S) * dt;
    for (const p of [...trail]) if (!isMatter(world.id(p.x, p.y - 1, p.z))) p.y -= fall;
    const h = trail[trail.length - 1];
    v.position.set(h.x, h.y, h.z);
    v.velocity.set(0, 0, 0);
    placeSegments();
  }

  return {
    id, kind: 'worm',
    root: look.root,
    bind(volume, g) {
      if (boundTo === volume) return;
      boundTo = volume;
      for (const m of mats) m.dispose();
      const frag = figureFrag(g);
      const byColor = new Map();
      for (const [mesh, albedo] of look.parts) {
        const key = albedo.join();
        if (!byColor.has(key)) {
          byColor.set(key, new THREE.ShaderMaterial({
            vertexShader: instVert, fragmentShader: frag, side: THREE.DoubleSide,
            uniforms: { ...volume.material.uniforms, ...uniforms, uAlbedo: { value: new THREE.Vector3(...albedo) } },
          }));
        }
        mesh.material = byColor.get(key);
      }
      mats = [...byColor.values()];
    },
    compile(renderer, camera, scene) {
      if (compiled === mats[0]) return Promise.resolve();
      compiled = mats[0];
      return renderer.compileAsync(look.root, camera, scene).catch(() => {});
    },
    // what the shell's per-NPC code reads (index.js: perks, the revenge blast): a worm takes no perks
    body: {
      get pos() { return v.position; },
      get dead() { return dead || !spawned; },
      get health() { return Math.max(0, health) / size.hp; },
      get cause() { return cause; },
      perks: null,
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    },
    get debug() {
      return {
        mode, phase, anchored, buried, health, dead, speed: v.velocity.length(), head: { x: v.position.x, y: v.position.y, z: v.position.z },
        vel: { x: v.velocity.x, y: v.velocity.y, z: v.velocity.z }, quarry: quarry ? quarry.t.id : null, ...stats,
      };
    },
    get segments() { return segs; },
    update(dt, w) {
      const sim = env.getSim();
      if (!sim || dt <= 0) return;
      dt = Math.min(dt, MAX_DT);
      if (!world.ready) return;
      if (!spawned) spawn(home());
      if (dead) {
        deadTime += dt;
        if (deadTime < CORPSE_S) sag(dt);
        if (deadTime >= RESPAWN_S) spawn(home());
      } else {
        if (world.T(v.position.x, v.position.y, v.position.z) > HOT_T) hurt(BURN_RATE * dt, 'Burned', headV.set(v.position.x, v.position.y, v.position.z));
        decide(dt, w);
        move(dt);
        dig(dt);
      }
      const near = !dead && bite(dt);
      look.root.visible = spawned && !(dead && deadTime >= CORPSE_S);
      draw(dt, w, near);
    },
    setVisible(vis) { look.root.visible = vis && spawned && !(dead && deadTime >= CORPSE_S); },
    reset() { spawned = false; look.root.visible = false; },
    placeAt(at) { if (env.getSim() && world.ready) spawn(at); },
    dispose() {
      offShot(); offBlast();
      for (const r of removers) r();
      pass.dispose();
      for (const m of mats) m.dispose();
      look.eyeMat.dispose();
      look.root.traverse((o) => o.geometry?.dispose());
    },
  };
}
