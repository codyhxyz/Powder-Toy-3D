import * as THREE from 'three';
import { BODY_HEIGHT } from './constants.js';

// The POV camera: mouse look, the eye with its head bob and landing dip, the
// over-the-shoulder third person, the death camera, and the swoop between the
// god view and the eyes. Everything here is in grid cells (one cell ≈ 30 cm)
// and seconds unless noted; poses come out in world space.

const DEG = THREE.MathUtils.degToRad;

export const POV_FOV = 75;              // degrees, vertical
const SPRINT_FOV_BOOST = 7;             // degrees wider while sprinting
const SPRINT_FOV_SPEED = 8;             // cells/s of ground speed from which the sprint FOV shows
const FOV_RATE = 5;                     // 1/s: how fast the FOV follows its target

// Mouse look
const LOOK_SENSITIVITY = 0.0022;        // rad per pixel of mouse movement
const LOOK_MAX_PX = 250;                // px: bigger single jumps (a browser hiccup on lock) are clamped
const PITCH_LIMIT = DEG(88);            // up and down from level
export const ENTRY_PITCH = DEG(-8);     // dropping in, the view starts a little below the horizon

// Head bob, while walking on the ground. Set HEAD_BOB to false to turn it off.
export const HEAD_BOB = true;
const BOB_STRIDE = 9;                   // cells walked per bob cycle (two footsteps)
const BOB_AMP_Y = 0.13;                 // cells, down at each footstep
const BOB_AMP_X = 0.06;                 // cells, side to side once per cycle
const BOB_FULL_SPEED = 6;               // cells/s of ground speed at which the bob reaches full size
const BOB_RATE = 8;                     // 1/s: how fast the bob's size follows the speed

// Landing dip: a critically damped spring on the eye height, kicked downward.
const DIP_STIFFNESS = 140;              // 1/s²
const LAND_DIP_MIN_SPEED = 6;           // cells/s: softer landings don't dip
const LAND_DIP_PER_SPEED = 0.25;        // cells/s of dip per cell/s of landing speed above the minimum
const LAND_DIP_MAX = 7;                 // cells/s
const ENTRY_DIP = 3;                    // cells/s: the settle as the swoop lands in the eyes

// Third person: over the right shoulder, behind the eye.
const TP_DIST = 10;                     // cells behind the eye
const TP_SHOULDER = 2.4;                // cells to the right
const TP_UP = 1.4;                      // cells above the eye
const TP_RATE = 7;                      // 1/s: how fast V swings the camera in or out
const BOX_MARGIN = 0.5;                 // cells: the camera stays this far inside the box

// Death camera: up and back from the body, slowly circling it.
const DEATH_CAM_DIST = 13;              // cells, horizontally from the body
const DEATH_CAM_UP = 11;                // cells above the feet
const DEATH_ORBIT_RATE = DEG(9);        // rad/s
const DEATH_CAM_RATE = 1.6;             // 1/s: how fast the camera gets there
const DEATH_LOOK_Y = 0.8;               // cells above the feet the death camera looks at (the fallen body)

// The swoop: a quadratic Bézier from the start pose to the end pose. Its
// control point sits behind the eye (and a little above it), so the camera
// dives in behind the body and glides forward into the eyes, or pulls back
// out of them the same way.
export const SWOOP_S = 0.9;             // s, dropping in and popping out
export const RESPAWN_SWOOP_S = 0.75;    // s, from the death camera back into the eyes
const SWOOP_BACK = 0.32;                // share of the flight distance the control point sits behind the eye
const SWOOP_LIFT = 0.1;                 // share of it above the eye
const SWOOP_BACK_MAX = 30;              // cells: caps both on long flights
const SWOOP_FACE_END = 0.4;             // share of a drop-in over which the view turns toward the body
const SWOOP_FACE_DIST = 6;              // cells from the eye where popping out has turned toward the body
const SWOOP_ALIGN_START = 0.55;         // share of the flight from which the view turns to its final orientation
const CHEST_Y = BODY_HEIGHT * 0.62;     // cells above the feet: where the swoop looks at the body

// The figure shows once the camera is this far from the eye (closer, it
// would fill the screen from inside its own head).
export const FIGURE_HIDE_DIST = 2.2;    // cells

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const smoother01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * t * (t * (6 * t - 15) + 10); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

export function createPovCamera() {
  const UP = new THREE.Vector3(0, 1, 0);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const m4 = new THREE.Matrix4();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();

  const look = { yaw: 0, pitch: 0 };
  let third = false;
  let tp = 0;                               // 0 first person … 1 third person
  let bobPhase = 0, bobAmp = 0;
  let dip = 0, dipVel = 0;                  // cells, cells/s
  let fov = POV_FOV;
  let death = 0, deathAngle = 0;            // death camera blend 0..1, its orbit angle
  let swoop = null;
  const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: POV_FOV, eyeDist: 0 };
  const live = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

  // look direction (unit, grid = world axes) and its horizontal parts
  const dir = (out) => out.set(0, 0, -1).applyEuler(euler.set(look.pitch, look.yaw, 0));
  const forwardH = (out) => out.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
  const rightH = (out) => out.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));

  const lookAtQuat = (from, to, out) => out.setFromRotationMatrix(m4.lookAt(from, to, UP));

  // keep a world point inside the box: shorten the segment a → b until it is
  function clampSegment(a, b, box) {
    let t = 1;
    for (const ax of ['x', 'y', 'z']) {
      const d = b[ax] - a[ax];
      const lo = box.min[ax] + box.margin, hi = box.max[ax] - box.margin;
      if (d > 0 && b[ax] > hi) t = Math.min(t, Math.max(0, (hi - a[ax]) / d));
      if (d < 0 && b[ax] < lo) t = Math.min(t, Math.max(0, (lo - a[ax]) / d));
    }
    return b.lerpVectors(a, b, t);
  }

  return {
    look,
    get third() { return third; },
    set third(v) { third = !!v; },
    get swooping() { return !!swoop; },
    get swoopKind() { return swoop?.kind ?? null; },
    pose,
    dir,
    forwardH,
    rightH,
    // mouse movement in px
    turn(dx, dy) {
      const cx = THREE.MathUtils.clamp(dx, -LOOK_MAX_PX, LOOK_MAX_PX);
      const cy = THREE.MathUtils.clamp(dy, -LOOK_MAX_PX, LOOK_MAX_PX);
      look.yaw -= cx * LOOK_SENSITIVITY;
      look.pitch = THREE.MathUtils.clamp(look.pitch - cy * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
    },
    setLook(yaw, pitch) {
      look.yaw = yaw;
      look.pitch = THREE.MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    },
    // a fresh body: no bob, no dip, the FOV at rest, third person as it was
    reset() {
      bobPhase = bobAmp = dip = dipVel = 0;
      fov = POV_FOV;
      death = 0;
      tp = third ? 1 : 0;
    },
    land(speed) {
      if (speed < LAND_DIP_MIN_SPEED) return;
      dipVel -= Math.min((speed - LAND_DIP_MIN_SPEED) * LAND_DIP_PER_SPEED, LAND_DIP_MAX);
    },
    // Fly from `from` ({pos, quat, fov}, world) into the eyes ('in'), or from
    // the current pose to `to` ('out'). The cells→world scale sizes the curve.
    startSwoop(kind, from, { to = null, duration = SWOOP_S } = {}) {
      swoop = {
        kind, t: 0, duration,
        p0: from.pos.clone(), q0: from.quat.clone(), fov0: from.fov,
        to: to && { pos: to.pos.clone(), quat: to.quat.clone(), fov: to.fov },
      };
    },
    // Call once per frame. s = {
    //   dt, eye (world, the unbobbed eye), feet (world), scale (world units per cell),
    //   speedH (cells/s), onGround, inLiquid, sprinting, dead, deadTime (s), box {min, max, margin} (world)
    // }. Returns the pose; pose.done is set on the frame a swoop finishes.
    update(s) {
      const { dt, scale } = s;
      pose.done = null;

      // head bob and landing dip, in cells
      const walking = HEAD_BOB && s.onGround && !s.inLiquid && !s.dead;
      bobAmp += ((walking ? Math.min(s.speedH / BOB_FULL_SPEED, 1) : 0) - bobAmp) * approach(BOB_RATE, dt);
      if (walking) bobPhase += (s.speedH / BOB_STRIDE) * 2 * Math.PI * dt;
      dipVel += (-DIP_STIFFNESS * dip - 2 * Math.sqrt(DIP_STIFFNESS) * dipVel) * dt;
      dip += dipVel * dt;
      const bobY = -BOB_AMP_Y * bobAmp * 0.5 * (1 - Math.cos(2 * bobPhase));
      const bobX = BOB_AMP_X * bobAmp * Math.sin(bobPhase);

      // first / third person
      tp += ((third ? 1 : 0) - tp) * approach(TP_RATE, dt);
      const tpK = smooth01(tp);

      // live pose: the eye, swung over the shoulder by tpK
      const eye = v1.copy(s.eye).addScaledVector(UP, (bobY + dip) * scale).addScaledVector(rightH(v3), bobX * scale);
      const lookDir = dir(v2);
      live.pos.copy(eye)
        .addScaledVector(lookDir, -TP_DIST * scale * tpK)
        .addScaledVector(rightH(v3), TP_SHOULDER * scale * tpK)
        .addScaledVector(UP, TP_UP * scale * tpK);
      clampSegment(eye, live.pos, s.box);
      live.quat.setFromEuler(euler.set(look.pitch, look.yaw, 0));

      // death: up, back and circling the body, looking at it
      death += ((s.dead ? 1 : 0) - death) * approach(DEATH_CAM_RATE, dt);
      if (!s.dead && death < 1e-3) death = 0;
      if (death > 0) {
        if (s.dead) deathAngle = look.yaw + (s.deadTime ?? 0) * DEATH_ORBIT_RATE;
        const at = v3.copy(s.feet).addScaledVector(UP, DEATH_LOOK_Y * scale);
        const dp = v2.set(Math.sin(deathAngle), 0, Math.cos(deathAngle)).multiplyScalar(DEATH_CAM_DIST * scale)
          .add(s.feet).addScaledVector(UP, DEATH_CAM_UP * scale);
        clampSegment(at, dp, s.box);
        lookAtQuat(dp, at, qa);
        const k = smooth01(death);
        live.pos.lerp(dp, k);
        live.quat.slerp(qa, k);
      }

      // FOV: a little wider at a sprint
      const fovTarget = POV_FOV + (s.sprinting && s.onGround && s.speedH > SPRINT_FOV_SPEED ? SPRINT_FOV_BOOST : 0);
      fov += (fovTarget - fov) * approach(FOV_RATE, dt);

      if (!swoop) {
        pose.pos.copy(live.pos);
        pose.quat.copy(live.quat);
        pose.fov = fov;
      } else {
        swoop.t = Math.min(1, swoop.t + dt / swoop.duration);
        const t = swoop.t;
        const into = swoop.kind === 'in';
        const endPos = into ? live.pos : swoop.to.pos;
        const endQuat = into ? live.quat : swoop.to.quat;
        const endFov = into ? fov : swoop.to.fov;
        // control point: behind and above the eye (the end going in, the start going out)
        const eyeEnd = into ? live.pos : swoop.p0;
        const span = Math.min(swoop.p0.distanceTo(endPos), SWOOP_BACK_MAX * scale);
        const ctrl = v2.copy(eyeEnd).addScaledVector(forwardH(v3), -span * SWOOP_BACK).addScaledVector(UP, span * SWOOP_LIFT);
        const k = smoother01(t), j = 1 - k;
        pose.pos.copy(swoop.p0).multiplyScalar(j * j).addScaledVector(ctrl, 2 * j * k).addScaledVector(endPos, k * k);
        // orientation: turn toward the body, then into the final view
        const chest = v3.copy(s.feet).addScaledVector(UP, CHEST_Y * scale);
        const face = into ? smooth01(t / SWOOP_FACE_END)
          : smooth01(pose.pos.distanceTo(swoop.p0) / (SWOOP_FACE_DIST * scale));
        if (pose.pos.distanceToSquared(chest) > 1e-8) lookAtQuat(pose.pos, chest, qb); else qb.copy(swoop.q0);
        qc.copy(swoop.q0).slerp(qb, face);
        pose.quat.copy(qc).slerp(endQuat, smooth01((t - SWOOP_ALIGN_START) / (1 - SWOOP_ALIGN_START)));
        pose.fov = swoop.fov0 + (endFov - swoop.fov0) * smooth01(t);
        if (t >= 1) {
          pose.done = swoop.kind;
          if (into) dipVel -= ENTRY_DIP;
          swoop = null;
        }
      }
      // how far the camera is from the eye, in cells (the figure hides when close)
      pose.eyeDist = pose.pos.distanceTo(s.eye) / scale;
      return pose;
    },
  };
}

