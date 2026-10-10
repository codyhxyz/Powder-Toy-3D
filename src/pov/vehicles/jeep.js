import * as THREE from 'three';
import { GRAVITY } from './physics.js';
import { hullSamples, hullMatter, surfaceId, isPowder } from './matter.js';

// The jeep: a Warthog (Halo's M12 LRV) on Rapier's DynamicRayCastVehicleController,
// the port of Bullet's btRaycastVehicle: a rigid chassis held up by four
// suspension rays, with tyre friction worked out per wheel.
//
// Feel: Halo's Warthog is floaty, long-travel and forgiving. The suspension
// numbers follow Kester Maddock's "Vehicle Simulation With Bullet" guide to
// btRaycastVehicle (stiffness 10 for an off-road buggy, 50 a sports car;
// damping as a share k of critical, 2k·√stiffness, with k 0.1–0.3 compressing
// and a little more relaxing), on a long rest length and travel. Grip is a
// little above a real tyre's (μ ≈ 1) so it forgives. Surfaces: rolling
// resistance from the textbook table (Wikipedia, "Rolling resistance": car
// tyres on concrete 0.010–0.015, on sand 0.3) and loose sand's lower grip, so
// a jeep driven into sand bogs down.
//
// Forward is +z in the chassis frame, up +y; all in metres, kg, s.

export const JEEP = {
  key: 'jeep', name: 'Jeep',
  // M12 Warthog: 4.5 m long, about 2.3 m wide, ~3 t (Halo Encyclopedia)
  LENGTH: 4.5, WIDTH: 2.2,
  MASS: 3000,                            // kg
  HALF: [0.95, 0.35, 2.15],              // m, chassis collider half-extents (the tub; the wheels are rays)
  BELOW: 0.7,                            // m the wheels reach below the tub at rest (for its hit box)
  COM_DROP: 0.45,                        // m the centre of mass sits below the tub's middle (engine, axles, wheels): resists rolling over
  HEALTH: 6,                             // body-healths: twelve gun rounds (a round takes 0.5), or one bomb close by
  SEAT: [0.45, 0.25, -0.1],              // m, the driver's hips in the chassis frame (left seat: +x is left, facing +z)
  CHASE: { dist: 8.5, lift: 2.6 },       // m, the third-person camera behind and above the chassis
  SPAWN_LIFT: 1.3,                       // m above the pad the chassis appears (it drops onto its springs)
};

// wheels: Warthog track ~1.9 m, wheelbase ~2.9 m, tyres ~1.1 m across
const WHEEL_X = 0.95, WHEEL_Z = 1.45;    // m, hard points either side of the middle
const WHEEL_Y = -0.15;                   // m, hard point height (inside the tub, above its floor)
const WHEEL_R = 0.55;                    // m, tyre radius
const WHEEL_W = 0.45;                    // m, tyre width (drawn only)
const REST = 0.6;                        // m, suspension rest length: long travel
const TRAVEL = 0.5;                      // m, how far it compresses at most
const STIFFNESS = 10;                    // Maddock: an off-road buggy's (static sag g/(4·10)·4 ≈ 0.25 m)
const DAMP_COMPRESS = 2 * 0.2 * Math.sqrt(STIFFNESS);   // k = 0.2 of critical (Maddock: 0.1–0.3)
const DAMP_RELAX = 2 * 0.3 * Math.sqrt(STIFFNESS);      // k = 0.3: a little slower back out, so it floats over bumps
const MAX_SUSPENSION_FORCE = 4 * JEEP.MASS * GRAVITY / 4; // N per wheel: 4× its share of the weight (a hard landing) before the spring gives out
const GRIP = 1.6;                        // friction slip (μ): forgiving, above a real tyre's ~1
const GRIP_POWDER = 0.55;                // share of grip on loose powder (sand's μ ≈ 0.5–0.6 against dry asphalt's ~0.9-1)
const SIDE_STIFFNESS = 1;                // Rapier's side friction stiffness (its default)
const CRR_SOLID = 0.015;                 // rolling resistance on rock, concrete, metal (car tyre on concrete)
const CRR_POWDER = 0.3;                  // ... on powder (car tyre on sand)
// engine: 0 to 20 m/s in about 4 s, all four wheels driven (the Warthog is 4WD)
const ACCEL = 5;                         // m/s² at a standstill
const TOP_SPEED = 25;                    // m/s (90 km/h, Halo's Warthog flat out); force falls off linearly to it
const REVERSE_SPEED = 8;                 // m/s, top speed backwards
const BOOST = 1.5;                       // × force and top speed with Shift
const BRAKE_DECEL = 0.8 * GRAVITY;       // m/s², S while rolling forward (a good tyre's braking)
const HANDBRAKE_DECEL = 0.6 * GRAVITY;   // m/s², Space: the rear wheels lock...
const HANDBRAKE_REAR_GRIP = 0.45;        // ...and slide (share of grip): it swings the tail out
const PARK_DECEL = 0.5 * GRAVITY;        // m/s², nobody in it: the parking brake on all four
const BRAKE_TO_REVERSE = 1;              // m/s: slower than this forward, S reverses instead of braking
// steering: full lock at a crawl, less at speed (speed-sensitive steering), eased in
const STEER_LOW = 0.6;                   // rad of lock at a standstill
const STEER_HIGH = 0.2;                  // rad at STEER_FADE and above
const STEER_FADE = 22;                   // m/s
const STEER_RATE = 6;                    // 1/s, how fast the wheels turn toward the stick
const AIR_DRAG = 0.5 * 1.2 * 0.6 * 3.2;  // ½ ρ_air C_d A (N per (m/s)²): a boxy 4×4, C_d 0.6, 3.2 m² frontal

const WHEELS = [
  { x: WHEEL_X, z: WHEEL_Z, front: true }, { x: -WHEEL_X, z: WHEEL_Z, front: true },
  { x: WHEEL_X, z: -WHEEL_Z, front: false }, { x: -WHEEL_X, z: -WHEEL_Z, front: false },
];
const HULL_VOLUME = 3.2;                 // m³ the tub, frame and tyres displace when wading (an open tub floods)
const HULL_SAMPLES = [3, 2, 5];

const COLOR = {
  body: '#6b7a3a', bodyDark: '#4b5629', tyre: '#262626', hub: '#8a8f94', metal: '#55595e', seat: '#3a2c22',
  glass: '#a8c8d8', red: '#c8352b', blue: '#2f6fd0', light: [6, 5.4, 3.6], robe: '#5a3d8a', face: '#121014', eyes: [4, 7, 8],
};

export function buildJeep(R, phys, look, { at, yaw, team }) {
  const { world } = phys;
  const [hx, hy, hz] = JEEP.HALF;
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(at.x, at.y + JEEP.SPAWN_LIFT, at.z)
    .setRotation(yawQuat(yaw))
    .setCanSleep(false)
    .setCcdEnabled(true));
  // the tub, with the mass and inertia of the whole jeep, its centre of mass low
  const I = (a, b) => JEEP.MASS / 12 * (a * a + b * b);
  const w = 2 * hx, hgt = 2 * (hy + WHEEL_R), l = 2 * hz;
  const collider = world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz)
    .setMassProperties(JEEP.MASS, { x: 0, y: -JEEP.COM_DROP, z: 0 }, { x: I(hgt, l), y: I(w, l), z: I(w, hgt) }, { x: 0, y: 0, z: 0, w: 1 })
    .setFriction(0.6), body);
  const ctrl = world.createVehicleController(body);
  // (the controller's axes are +y up and +z forward by default: our chassis frame)
  WHEELS.forEach((wh, i) => {
    ctrl.addWheel({ x: wh.x, y: WHEEL_Y, z: wh.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
    ctrl.setWheelMaxSuspensionTravel(i, TRAVEL);
    ctrl.setWheelSuspensionStiffness(i, STIFFNESS);
    ctrl.setWheelSuspensionCompression(i, DAMP_COMPRESS);
    ctrl.setWheelSuspensionRelaxation(i, DAMP_RELAX);
    ctrl.setWheelMaxSuspensionForce(i, MAX_SUSPENSION_FORCE);
    ctrl.setWheelFrictionSlip(i, GRIP);
    ctrl.setWheelSideFrictionStiffness(i, SIDE_STIFFNESS);
  });

  const { root, wheelMeshes, driver } = jeepModel(look, team);
  const samples = hullSamples(hx, hy + WHEEL_R / 2, hz, HULL_SAMPLES);
  let steer = 0;
  const fwd = new THREE.Vector3(), q = new THREE.Quaternion(), cp = new THREE.Vector3(), cn = new THREE.Vector3();
  const state = { speed: 0, surface: [], onPowder: 0, grounded: 0, wet: 0, hot: false };

  return {
    spec: JEEP, body, collider, root, driver, samples,
    state,
    // one fixed step: the driver's input, the ground, then the controller
    step(h, input, cells) {
      const rot = body.rotation();
      q.set(rot.x, rot.y, rot.z, rot.w);
      fwd.set(0, 0, 1).applyQuaternion(q);
      const lv = body.linvel();
      const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;   // m/s along the chassis
      state.speed = v;
      // what each wheel stands on (last step's contacts)
      let powder = 0, grounded = 0, load = 0, crrLoad = 0;
      for (let i = 0; i < WHEELS.length; i++) {
        if (!ctrl.wheelIsInContact(i)) { state.surface[i] = -1; continue; }
        grounded++;
        const p = ctrl.wheelContactPoint(i), n = ctrl.wheelContactNormal(i);
        cp.set(p.x, p.y, p.z); cn.set(n.x, n.y, n.z);
        const id = surfaceId(cells, cp, cn);
        state.surface[i] = id;
        const soft = isPowder(id);
        if (soft) powder++;
        const N = ctrl.wheelSuspensionForce(i) ?? 0;
        load += N;
        crrLoad += N * (soft ? CRR_POWDER : CRR_SOLID);
        const rear = !WHEELS[i].front;
        ctrl.setWheelFrictionSlip(i, GRIP * (soft ? GRIP_POWDER : 1) * (rear && input.brake ? HANDBRAKE_REAR_GRIP : 1));
      }
      state.onPowder = grounded ? powder / grounded : 0;
      state.grounded = grounded;

      // engine: linear falloff to top speed (the torque curve of an electric drive), all four wheels
      const boost = input.boost ? BOOST : 1;
      const mass = JEEP.MASS;
      let engine = 0, brake = 0;
      if (input.throttle > 0) {
        engine = input.throttle * mass * ACCEL * boost * Math.max(0, 1 - v / (TOP_SPEED * boost));
      } else if (input.throttle < 0) {
        if (v > BRAKE_TO_REVERSE) brake = BRAKE_DECEL;
        else engine = input.throttle * mass * ACCEL * Math.max(0, 1 + v / REVERSE_SPEED);
      }
      for (let i = 0; i < WHEELS.length; i++) {
        ctrl.setWheelEngineForce(i, engine / WHEELS.length);
        const rear = !WHEELS[i].front;
        const b = brake + (rear && input.brake ? HANDBRAKE_DECEL : 0) + (input.parked ? PARK_DECEL : 0);
        // the controller's brake is the most rolling impulse a wheel takes per step (Bullet's m_brake)
        ctrl.setWheelBrake(i, b * mass / WHEELS.length * h);
      }
      // rolling resistance (the controller has none while the engine pulls) and air drag, on the chassis
      // along its heading, never more than stops it this step
      const resist = (crrLoad + AIR_DRAG * v * v) * h;
      const stopJ = Math.abs(v) * mass;
      const j = Math.min(resist, stopJ) * Math.sign(v);
      if (j) body.applyImpulse({ x: -fwd.x * j, y: -fwd.y * j, z: -fwd.z * j }, true);
      state.load = load;

      // steering, speed-sensitive and eased
      const lock = THREE.MathUtils.lerp(STEER_LOW, STEER_HIGH, Math.min(Math.abs(v) / STEER_FADE, 1));
      steer += (input.steer * lock - steer) * (1 - Math.exp(-STEER_RATE * h));
      ctrl.setWheelSteering(0, steer);
      ctrl.setWheelSteering(1, steer);

      const m = hullMatter(body, samples, HULL_VOLUME, cells, h);
      state.wet = m.wet; state.hot = m.hot;
      ctrl.updateVehicle(h);
    },
    // the wheels drawn where the rays put them, turning with the ground
    pose() {
      for (let i = 0; i < WHEELS.length; i++) {
        const wm = wheelMeshes[i];
        const len = ctrl.wheelSuspensionLength(i) ?? REST;
        wm.position.set(WHEELS[i].x, WHEEL_Y - len, WHEELS[i].z);
        wm.rotation.set(0, WHEELS[i].front ? steer : 0, 0);
        wm.children[0].rotation.x = ctrl.wheelRotation(i) ?? 0;
      }
    },
    get steer() { return steer; },
    get speed() { return state.speed; },
    dispose() { world.removeVehicleController(ctrl); world.removeRigidBody(body); },
  };
}

export const yawQuat = (yaw) => { const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); return { x: q.x, y: q.y, z: q.z, w: q.w }; };

// ---- the model: an olive Warthog-ish 4×4 of chunky primitives, in metres
function jeepModel(look, team) {
  const root = new THREE.Group();
  root.name = 'jeep';
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const teamColor = team === 'blue' ? COLOR.blue : team === 'red' ? COLOR.red : COLOR.bodyDark;
  // tub and nose
  at(look.part(root, box(1.9, 0.55, 4.3), COLOR.body), 0, 0, 0);
  at(look.part(root, box(1.8, 0.4, 1.5), COLOR.body), 0, 0.42, 1.35).rotation.x = 0.12;   // the hood, sloping to the grille
  at(look.part(root, box(2.05, 0.28, 0.3), COLOR.metal), 0, -0.05, 2.25);                 // bumper
  at(look.part(root, box(0.5, 0.06, 1.3), teamColor, { edge: false }), 0, 0.65, 1.35).rotation.x = 0.12;   // team stripe
  // fenders over the wheels
  for (const [x, z] of [[1, 1.45], [-1, 1.45], [1, -1.45], [-1, -1.45]]) at(look.part(root, box(0.55, 0.18, 1.35), COLOR.bodyDark), x, 0.18, z);
  // windscreen frame and roll bar
  at(look.part(root, box(1.8, 0.08, 0.08), COLOR.metal), 0, 1.05, 0.55);
  for (const x of [-0.86, 0.86]) {
    at(look.part(root, box(0.08, 0.8, 0.08), COLOR.metal), x, 0.65, 0.55).rotation.x = -0.25;
    at(look.part(root, box(0.1, 1.1, 0.1), COLOR.metal), x, 0.8, -0.75);
  }
  at(look.part(root, box(1.8, 0.1, 0.1), COLOR.metal), 0, 1.35, -0.75);
  // seats
  for (const x of [-0.45, 0.45]) {
    at(look.part(root, box(0.6, 0.15, 0.6), COLOR.seat), x, 0.33, -0.1);
    at(look.part(root, box(0.6, 0.6, 0.12), COLOR.seat), x, 0.6, -0.45);
  }
  // the turret on the bed: a post, a drum and three barrels
  at(look.part(root, new THREE.CylinderGeometry(0.12, 0.16, 0.7, 8), COLOR.metal), 0, 0.6, -1.4);
  const gun = at(new THREE.Group(), 0, 1.0, -1.4);
  root.add(gun);
  at(look.part(gun, box(0.45, 0.35, 0.7), COLOR.metal), 0, 0, 0);
  for (const [x, y] of [[0, 0.07], [-0.07, -0.05], [0.07, -0.05]]) {
    const b = look.part(gun, new THREE.CylinderGeometry(0.045, 0.045, 1.1, 6).rotateX(Math.PI / 2), COLOR.metal, { edge: false });
    at(b, x, y, 0.85);
  }
  at(look.part(gun, box(0.8, 0.5, 0.05), COLOR.bodyDark), 0, 0.1, 0.4);   // the gun shield
  // headlights
  for (const x of [-0.65, 0.65]) at(look.glow(root, new THREE.BoxGeometry(0.22, 0.14, 0.05), COLOR.light), x, 0.3, 2.16);
  // wheels: a group per wheel (steer), the tyre inside it (roll)
  const wheelMeshes = WHEELS.map((wh) => {
    const g = new THREE.Group();
    const tyre = new THREE.Group();
    look.part(tyre, new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 14).rotateZ(Math.PI / 2), COLOR.tyre);
    look.part(tyre, new THREE.CylinderGeometry(WHEEL_R * 0.5, WHEEL_R * 0.5, WHEEL_W + 0.04, 6).rotateZ(Math.PI / 2), COLOR.hub, { edge: false });
    g.add(tyre);
    root.add(g);
    g.position.set(wh.x, WHEEL_Y - REST, wh.z);
    return g;
  });
  // the driver: a seated wizard (the player's look), shown while someone drives
  const driver = new THREE.Group();
  at(driver, ...JEEP.SEAT);
  look.part(driver, new THREE.CylinderGeometry(0.22, 0.3, 0.6, 10), COLOR.robe).position.y = 0.3;
  look.part(driver, new THREE.SphereGeometry(0.27, 12, 10), COLOR.robe).position.y = 0.8;
  look.part(driver, new THREE.ConeGeometry(0.24, 0.55, 10), COLOR.robe).position.set(0, 1.15, -0.05);
  at(look.part(driver, new THREE.SphereGeometry(0.2, 10, 8), COLOR.face, { edge: false }), 0, 0.78, 0.1);
  for (const x of [-0.08, 0.08]) at(look.glow(driver, new THREE.SphereGeometry(0.035, 6, 4), COLOR.eyes), x, 0.82, 0.28);
  driver.visible = false;
  root.add(driver);
  return { root, wheelMeshes, driver };
}
