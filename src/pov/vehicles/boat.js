import * as THREE from 'three';
import { CELL_M } from '../../scale.js';
import { hullSamples, hullMatter } from './matter.js';
import { seatedDriver } from './look.js';
import { yawQuat } from './jeep.js';

// Minecraft boat simplicity (one seat, W/S and A/D), with Rust's small
// motorboat feel: a modest outboard, slower reverse and an unpowered coast.
// These are arcade tuning values, not a marine simulation. Actual liquid
// cells lift the hull; decorative surface waves do not drive its pose.
export const BOAT = {
  key: 'boat', name: 'Boat', LENGTH: 3.6, WIDTH: 1.8,
  MASS: 650, HALF: [0.9, 0.35, 1.8], BELOW: 0,
  GROUND: { r: 0, liquid: false },
  COM_DROP: 0.3, HEALTH: 4,
  SEAT: [0, 0.4, -0.35], CHASE: { dist: 7, lift: 2.3 },
  SPAWN_LIFT: 0.45,
};
const HULL_VOLUME = 1.8;                 // m³ sealed buoyant hull: 1800 kg displacement in water
const HULL_CD = 0.08;                    // slender hull, rather than the shared bluff-box drag
const THRUST = 1800;                     // N, Rust-inspired leisurely outboard acceleration
const TOP_SPEED = 9, REVERSE_SPEED = 3;  // m/s before motor force falls to zero
const YAW_RATE = 0.85, YAW_EASE = 3;     // rad/s, /s: Minecraft-simple forgiving steering
const SIDE_GRIP = 1.8;                   // /s, immersed keel resists sideways slip
const HEAVE_DRAG = 2;                    // /s, broad bottom damps bobbing more than forward travel
const PROP = new THREE.Vector3(0, -0.35, -1.5); // m, stern propeller must be in liquid
const DRIVER = {
  robe: [0.22, 0.3, 0.6], robeAt: [0, 0.3, 0], head: 0.27, headAt: [0, 0.8, 0], hat: [0.24, 0.55], hatAt: [0, 1.15, -0.05],
  face: 0.2, faceAt: [0, 0.78, 0.1], eye: 0.035, eyeAt: [0.08, 0.82, 0.28],
};

export function buildBoat(R, phys, look, { at, yaw, team }) {
  const { world } = phys;
  const [hx, hy, hz] = BOAT.HALF;
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(at.x, at.y + BOAT.SPAWN_LIFT, at.z)
    .setRotation(yawQuat(yaw)).setAngularDamping(0.8)
    .setCanSleep(false).setCcdEnabled(true)); // roll and pitch remain free
  const I = (a, b) => BOAT.MASS / 12 * (a * a + b * b);
  const yawInertia = I(2 * hx, 2 * hz);
  // A tapered bow and chine: solid hull collisions, not a hover spring.
  const points = [];
  for (const y of [-hy, hy]) for (const z of [-hz, hz * 0.55, hz]) {
    const w = hx * (z === hz ? 0.35 : y < 0 ? 0.75 : 1);
    points.push(-w, y, z, w, y, z);
  }
  const geometry = new Float32Array(points);
  const collider = world.createCollider(R.ColliderDesc.convexHull(geometry)
    .setMassProperties(BOAT.MASS, { x: 0, y: -BOAT.COM_DROP, z: 0 },
      { x: I(2 * hy, 2 * hz), y: yawInertia, z: I(2 * hx, 2 * hy) }, { x: 0, y: 0, z: 0, w: 1 })
    .setFriction(0.5), body);
  const samples = hullSamples(hx * 0.8, hy, hz * 0.85, [4, 4, 8]);
  const { root, driver, motor } = boatModel(look, team);
  const state = { speed: 0, wet: 0, hot: false, motorWet: false };
  const q = new THREE.Quaternion(), fwd = new THREE.Vector3(), side = new THREE.Vector3(), prop = new THREE.Vector3(), up = new THREE.Vector3();
  let steer = 0;
  return {
    spec: BOAT, body, collider, root, driver, samples, state,
    step(h, input, cells) {
      const r = body.rotation(), lv = body.linvel();
      q.set(r.x, r.y, r.z, r.w);
      fwd.set(0, 0, 1).applyQuaternion(q).setY(0).normalize();
      side.set(fwd.z, 0, -fwd.x);
      const speed = lv.x * fwd.x + lv.z * fwd.z;
      state.speed = speed;
      const matter = hullMatter(body, samples, HULL_VOLUME, cells, h, HULL_CD);
      state.wet = matter.wet; state.hot = matter.hot;
      prop.copy(PROP).applyQuaternion(q).add(body.translation()).divideScalar(CELL_M);
      state.motorWet = matter.wet > 0 && cells.isLiquid(prop.x, prop.y, prop.z);
      const wet = Math.min(1, matter.wet / 0.3);
      // The water's grip also acts while coasting/unoccupied; no parking brake.
      const slip = lv.x * side.x + lv.z * side.z;
      const grip = -slip * BOAT.MASS * Math.min(1, SIDE_GRIP * wet * h);
      body.applyImpulse({ x: side.x * grip, y: -lv.y * BOAT.MASS * Math.min(1, HEAVE_DRAG * wet * h), z: side.z * grip }, true);
      const powered = state.motorWet && !input.dead && !input.parked && up.set(0, 1, 0).applyQuaternion(q).y > 0.3;
      const throttle = powered ? input.throttle : 0;
      steer = powered ? input.steer : 0;
      const top = throttle >= 0 ? TOP_SPEED : REVERSE_SPEED;
      const force = throttle * THRUST * Math.max(0, 1 - Math.sign(throttle) * speed / top) * wet;
      // Horizontal thrust through COM: the outboard cannot launch the boat.
      body.applyImpulse({ x: fwd.x * force * h, y: 0, z: fwd.z * force * h }, true);
      // Steering reverses with travel; retained water resistance damps yaw even
      // unoccupied. Torque only about y leaves buoyancy to resolve pitch/roll.
      const turn = steer * YAW_RATE * Math.sign(Math.abs(speed) > 0.2 ? speed : throttle)
        * Math.min(1, Math.abs(speed) / 2 + Math.abs(throttle) * 0.5);
      body.applyTorqueImpulse({ x: 0, y: (turn - body.angvel().y) * yawInertia * Math.min(1, YAW_EASE * wet * h), z: 0 }, true);
    },
    pose() { motor.rotation.y = -steer * 0.45; },
    get speed() { return state.speed; },
    dispose() { world.removeRigidBody(body); },
  };
}

function boatModel(look, team) {
  const root = new THREE.Group();
  root.name = 'boat';
  const color = team === 'red' ? '#c8352b' : team === 'blue' ? '#2f6fd0' : '#d69042';
  const box = (parent, dims, at, c) => {
    const m = look.part(parent, new THREE.BoxGeometry(...dims), c);
    m.position.set(...at); return m;
  };
  // Open dinghy: floor, gunwales, pointed bow, benches and a visible outboard.
  box(root, [1.55, 0.22, 2.9], [0, -0.23, -0.25], '#655348');
  for (const x of [-0.8, 0.8]) {
    box(root, [0.18, 0.65, 2.8], [x, 0, -0.35], color);
    const bow = box(root, [0.18, 0.65, 0.95], [x * 0.69, 0, 1.35], color);
    bow.rotation.y = -Math.sign(x) * 0.6;
  }
  box(root, [1.65, 0.65, 0.16], [0, 0, -1.7], color);
  for (const z of [-0.35, 0.75]) box(root, [1.5, 0.15, 0.38], [0, 0.3, z], '#b6a181');
  const motor = new THREE.Group(); root.add(motor); motor.position.set(0, 0, -1.75);
  box(motor, [0.42, 0.55, 0.42], [0, 0.32, 0], '#363e44');
  box(motor, [0.12, 0.6, 0.12], [0, -0.18, 0], '#69747b');
  box(motor, [0.4, 0.08, 0.12], [0, -0.43, 0], '#69747b');
  const driver = seatedDriver(look, root, BOAT.SEAT, DRIVER);
  return { root, driver, motor };
}
