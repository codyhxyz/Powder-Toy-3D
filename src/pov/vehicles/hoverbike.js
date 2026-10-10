import * as THREE from 'three';
import { CELL_M } from '../../scale.js';
import { ELEMENTS, E, K } from '../../elements.js';
import { GRAVITY } from './physics.js';
import { hullSamples, hullMatter } from './matter.js';
import { yawQuat } from './jeep.js';

// The hoverbike: a rigid body held up by ray springs, Halo's Ghost by way of
// every hover racer (WipEout, F-Zero GX): four rays straight down from its
// corners, each a spring–damper (Hooke's law with a damping ratio) toward the
// hover height. The rays see a smoothed ground (physics.js) whose tops are
// solids', powders' and liquids' alike, so it skims a lake as it does a road.
//
// Steering sets the yaw rate (eased), thrust pushes along the nose, and the
// grip across it is low: sideways velocity bleeds off at only LATERAL_GRIP per
// second, so a hard turn at speed slides wide, a drift (the arcade hover-car
// recipe: strong yaw, weak lateral friction). The body only turns about the
// vertical (its roll and pitch are locked), so it never flips; the model banks
// and pitches for show.
//
// Forward is +z in its frame, up +y; metres, kg, s.

export const HOVERBIKE = {
  key: 'hoverbike', name: 'Hoverbike',
  LENGTH: 2.5, WIDTH: 1.0,
  MASS: 280,                             // kg: a motorbike's ~200 kg and its fans' housings
  HALF: [0.45, 0.3, 1.2],                // m, collider half-extents
  BELOW: 0,                              // m below the hull it reaches (nothing: it floats)
  GROUND: { r: 0.6, liquid: true },      // the fans' ground: smoothed over ~0.6 m (their wash), and liquid tops count
  HEALTH: 3,                             // body-healths: six gun rounds
  SEAT: [0, 0.3, -0.25],                 // m, the rider's hips
  CHASE: { dist: 6, lift: 2 },           // m, the third-person camera behind and above it
  SPAWN_LIFT: 1.2,                       // m above the pad it appears
};

const HOVER_HEIGHT = 0.9;                // m, the springs' rest: the body's middle this far over the ground (its belly 0.6 m up)
const RAY_MAX = 2.4;                     // m below the middle the rays reach: further down it's falling
const HOVER_HZ = 1.6;                    // Hz, the springs' natural frequency: soft, floaty
const HOVER_ZETA = 0.45;                 // damping ratio: under-damped, a little bob after a bump
const OMEGA = 2 * Math.PI * HOVER_HZ;
const RAYS = [[0.4, 0.95], [-0.4, 0.95], [0.4, -0.95], [-0.4, -0.95]];   // m, ray origins (x, z) in its frame
const K_RAY = HOVERBIKE.MASS * OMEGA * OMEGA / RAYS.length;            // N/m per ray: k = m ω²
const C_RAY = 2 * HOVER_ZETA * HOVERBIKE.MASS * OMEGA / RAYS.length;   // N·s/m per ray: c = 2 ζ m ω
const MAX_RAY_FORCE = 3 * HOVERBIKE.MASS * GRAVITY;                  // N per ray at most (a hard landing)
// drive
const ACCEL = 9;                         // m/s² of thrust at a standstill
const TOP_SPEED = 20;                    // m/s (72 km/h, about a Ghost's); linear drag along the nose sets it
const REVERSE = 0.4;                     // share of thrust backwards
const BOOST_ACCEL = 1.7;                 // × thrust with Shift...
const BOOST_TOP = 31;                    // ...and top speed (m/s)
const BOOST_S = 3;                       // s of boost in a full tank (a Ghost's boost lasts about this)
const BOOST_REFILL_S = 5;                // s to refill an empty tank...
const BOOST_WAIT_S = 1;                  // ...starting this long after you let go
const YAW_RATE = 1.9;                    // rad/s at full stick
const YAW_EASE = 7;                      // 1/s, how fast the yaw rate follows the stick
const LATERAL_GRIP = 3;                  // 1/s sideways velocity bleeds off: low, so it drifts
const BOOST_GRIP = 2;                    // 1/s while boosting: it drifts wider
const HOP_SPEED = 5.5;                   // m/s up from Space while on its springs (a 1.5 m hop)
const HOP_COOLDOWN = 0.8;                // s between hops
const AIR_DRAG = 0.5 * 1.2 * 0.5 * 0.9;  // ½ ρ_air C_d A (N per (m/s)²): a rider on a bike, C_d 0.5, 0.9 m²
const BANK = 0.35;                       // rad of lean (drawn) at full yaw rate
const PITCH_SHOW = 0.6;                  // share of the ground's slope under it the model takes on (drawn)
const SHOW_EASE = 8;                     // 1/s, how fast the drawn lean follows
const LIQUID_PROBE = 3;                  // cells under a ray's hit (on the smoothed ground) it looks for the surface: is it skimming?
const HULL_VOLUME = 0.25;                // m³ it displaces if it ever sinks (it floats on its fans)
const HULL_SAMPLES = [2, 1, 3];

const COLOR = {
  body: '#5c6670', trim: '#2c3036', seat: '#2a2320', red: '#c8352b', blue: '#2f6fd0', neutral: '#d0a030',
  glow: [1.2, 4.5, 7], robe: '#5a3d8a', face: '#121014', eyes: [4, 7, 8],
};

// the first thing under (x, y, z) (cells), within LIQUID_PROBE: is it a liquid?
function overLiquid(cells, x, y, z) {
  for (let d = 0; d < LIQUID_PROBE; d++) {
    const id = cells.id(x, y - d - 0.5, z);
    if (id === E.EMPTY || (id >= 0 && ELEMENTS[id].kind === K.GAS)) continue;
    return id >= 0 && ELEMENTS[id].kind === K.LIQUID;
  }
  return false;
}

export function buildHoverbike(R, phys, look, { at, yaw, team, key }) {
  const { world } = phys;
  const ground = phys.groundFilter(key);
  const [hx, hy, hz] = HOVERBIKE.HALF;
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(at.x, at.y + HOVERBIKE.SPAWN_LIFT, at.z)
    .setRotation(yawQuat(yaw))
    .enabledRotations(false, true, false)
    .setCanSleep(false)
    .setCcdEnabled(true));
  // a capsule along its length: the rounded nose rides up a step's edge instead of stopping on it
  const collider = world.createCollider(R.ColliderDesc.capsule(hz - hy, hy)
    .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })   // its axis from +y to +z
    .setMass(HOVERBIKE.MASS).setFriction(0.3), body);

  const { root, driver, show, pads } = bikeModel(look, team);
  const samples = hullSamples(hx, hy, hz, HULL_SAMPLES);
  const state = { speed: 0, slip: 0, grounded: 0, overLiquid: false, boost: 1, wet: 0, hot: false };
  let yawRate = 0, hopWait = 0, boostIdle = 0, slope = 0, lean = 0, pitch = 0;
  const q = new THREE.Quaternion(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), o = new THREE.Vector3();
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  return {
    spec: HOVERBIKE, body, collider, root, driver, samples, state,
    step(h, input, cells) {
      const t = body.translation(), r = body.rotation(), lv = body.linvel();
      q.set(r.x, r.y, r.z, r.w);
      fwd.set(0, 0, 1).applyQuaternion(q);
      right.set(-1, 0, 0).applyQuaternion(q);
      const m = HOVERBIKE.MASS;
      // the springs: each ray from a corner, down through the cells' copy
      let grounded = 0, liquid = 0, front = 0, back = 0, nf = 0, nb = 0, Fy = 0;
      if (!input.dead) RAYS.forEach(([x, z]) => {   // a wreck's fans are dead
        o.set(x, 0, z).applyQuaternion(q).add(t);
        ray.origin = { x: o.x, y: o.y, z: o.z };
        const hit = world.castRay(ray, RAY_MAX, true, undefined, undefined, undefined, undefined, ground);
        if (!hit) return;
        const d = hit.timeOfImpact;
        grounded++;
        if (overLiquid(cells, o.x / CELL_M, (o.y - d) / CELL_M, o.z / CELL_M)) liquid++;
        if (z > 0) { front += d; nf++; } else { back += d; nb++; }
        const f = K_RAY * (HOVER_HEIGHT - d) - C_RAY * lv.y;
        Fy += THREE.MathUtils.clamp(f, 0, MAX_RAY_FORCE);
      });
      state.grounded = grounded;
      state.overLiquid = liquid > 0;
      if (nf && nb) slope = Math.atan2(back / nb - front / nf, 2 * RAYS[0][1]);

      // thrust along the nose (level), drag sets the top speed
      const boostOn = input.boost && state.boost > 0 && input.throttle > 0;
      if (boostOn) { state.boost = Math.max(0, state.boost - h / BOOST_S); boostIdle = 0; }
      else { boostIdle += h; if (boostIdle > BOOST_WAIT_S) state.boost = Math.min(1, state.boost + h / BOOST_REFILL_S); }
      const vf = lv.x * fwd.x + lv.z * fwd.z;
      const vl = lv.x * right.x + lv.z * right.z;
      const top = boostOn ? BOOST_TOP : TOP_SPEED;
      const a = ACCEL * (boostOn ? BOOST_ACCEL : 1);
      const thrust = input.throttle >= 0 ? input.throttle * a : input.throttle * a * REVERSE;
      const drag = a * vf / top;   // linear: thrust and drag balance at the top speed
      const air = AIR_DRAG * Math.hypot(vf, vl) * vf / m;
      const along = grounded ? thrust - drag - air : -air;
      // the sideways grip, only while the fans have something to push on
      const grip = grounded ? (boostOn ? BOOST_GRIP : LATERAL_GRIP) : 0;
      const across = -vl * Math.min(grip * h, 1) / h;
      body.applyImpulse({
        x: (fwd.x * along + right.x * across) * m * h,
        y: Fy * h,
        z: (fwd.z * along + right.z * across) * m * h,
      }, true);
      // hop
      hopWait = Math.max(0, hopWait - h);
      if (input.brake && !input.parked && grounded && hopWait <= 0) {
        body.applyImpulse({ x: 0, y: m * Math.max(0, HOP_SPEED - lv.y), z: 0 }, true);
        hopWait = HOP_COOLDOWN;
      }
      // yaw: the rate eases toward the stick
      yawRate += (input.steer * YAW_RATE - yawRate) * (1 - Math.exp(-YAW_EASE * h));
      body.setAngvel({ x: 0, y: yawRate, z: 0 }, true);

      const mm = hullMatter(body, samples, HULL_VOLUME, cells, h);
      state.wet = mm.wet; state.hot = mm.hot;
      state.speed = vf;
      state.slip = Math.atan2(Math.abs(vl), Math.max(Math.abs(vf), 1e-3));   // rad between the nose and the motion
    },
    pose(dt) {
      const k = 1 - Math.exp(-SHOW_EASE * dt);
      lean += (-yawRate / YAW_RATE * BANK - lean) * k;
      pitch += (slope * PITCH_SHOW - pitch) * k;
      show.rotation.set(-pitch, 0, lean);
      for (const p of pads) p.scale.setScalar(state.grounded ? 1 : 0.6);
    },
    get speed() { return state.speed; },
    dispose() { world.removeRigidBody(body); },
  };
}

// ---- the model: a fan bike of chunky primitives, in metres; `show` leans and pitches
function bikeModel(look, team) {
  const root = new THREE.Group();
  root.name = 'hoverbike';
  const show = new THREE.Group();
  root.add(show);
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const teamColor = team === 'blue' ? COLOR.blue : team === 'red' ? COLOR.red : COLOR.neutral;
  at(look.part(show, new THREE.BoxGeometry(0.6, 0.38, 1.9), COLOR.body), 0, 0, 0);                     // hull
  const nose = look.part(show, new THREE.ConeGeometry(0.32, 0.8, 6).rotateX(Math.PI / 2), COLOR.body);   // nose, pointing +z
  at(nose, 0, 0.02, 1.3);
  at(look.part(show, new THREE.BoxGeometry(0.62, 0.06, 0.9), teamColor, { edge: false }), 0, 0.21, 0.45);   // team stripe
  at(look.part(show, new THREE.BoxGeometry(0.45, 0.14, 0.7), COLOR.seat), 0, 0.26, -0.3);              // seat
  at(look.part(show, new THREE.BoxGeometry(0.7, 0.07, 0.07), COLOR.trim), 0, 0.42, 0.55);               // handlebar
  // the fan pods either side, glowing underneath
  const pads = [];
  for (const x of [-0.5, 0.5]) {
    at(look.part(show, new THREE.CylinderGeometry(0.2, 0.24, 1.6, 10).rotateX(Math.PI / 2), COLOR.trim), x, -0.08, 0);
    for (const z of [0.55, -0.55]) {
      const p = at(look.glow(show, new THREE.CylinderGeometry(0.17, 0.17, 0.04, 10), COLOR.glow), x, -0.32, z);
      pads.push(p);
    }
  }
  const driver = new THREE.Group();
  at(driver, ...HOVERBIKE.SEAT);
  look.part(driver, new THREE.CylinderGeometry(0.2, 0.28, 0.55, 10), COLOR.robe).position.set(0, 0.3, 0.05);
  look.part(driver, new THREE.SphereGeometry(0.25, 12, 10), COLOR.robe).position.set(0, 0.75, 0.15);
  look.part(driver, new THREE.ConeGeometry(0.22, 0.5, 10), COLOR.robe).position.set(0, 1.08, 0.1);
  at(look.part(driver, new THREE.SphereGeometry(0.18, 10, 8), COLOR.face, { edge: false }), 0, 0.73, 0.26);
  for (const x of [-0.07, 0.07]) at(look.glow(driver, new THREE.SphereGeometry(0.032, 6, 4), COLOR.eyes), x, 0.77, 0.42);
  driver.visible = false;
  show.add(driver);
  return { root, driver, show, pads };
}
