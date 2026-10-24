import * as THREE from 'three/webgpu';
import { gfxUniforms } from '../gfx/uniforms.js';
import { povEvents } from './events.js';
import { flameOverlay } from './flame.js';
import { updateViewmodelArms } from './viewmodelArms.js';
import { createFlapAnimation } from './flapPose.js';
import { useWebGPUCamera, gpuTextureOf } from '../gpu/three.js';
import { guardMeshes, PENDING_MASK } from '../gfx/meshLight.js';
import { readWorldEye } from '../gfx/worldEyeLight.js';
import { BRICK } from '../shaders/common.js';
import { SH_Y0, SH_Y1, SKYVIS_OPEN_DC, SHADOW_TINT_ID_SCALE, SHADOW_PAD, VOLUME_SHADOW_BIAS } from '../shaders/gfx/lighting.js';

// The viewmodel: the tool in your hands, its motion, and the pass that draws it.
//
// The rig. Every tool hangs its model on a hand (`rig.hand(restPos)`): a group
// at the tool's rest pose in cells (camera space: +x right, +y up, −z forward).
// On top of that rest pose the rig adds, the same for every hand:
//   - spring recoil with overshoot, on position and rotation: kick(strength)
//     throws the spring, and an
//     underdamped spring (natural frequency SPRING_OMEGA, damping ratio
//     SPRING_ZETA, the Gunplay Feel Lab's k = 260 /s², c = 18 /s) brings it
//     back past rest and settles it;
//   - sway: the hand trails the look (inertia), from the aim's angular velocity;
//   - a slow breathing drift while idle, a walk bob in step with the camera's,
//     and a raised pose while swimming (the tool held up, out of the stroke).
// The selected tool calls rig.update(ctx) every frame.
//
//   const rig = viewmodelRig(env);        // one per env.viewmodel, shared by every tool
//   const hand = rig.hand([x, y, z]);     // add the model to hand; hand.visible is the tool's to set
//   rig.update(ctx);
//   rig.hit(HIT.AXE);                      // a tool's blow, shot or fling: the hand's kick and the view punch
//   rig.kick(1);                           // the hand's kick alone
//   rig.state                              // { pos, rot, spring } the rig's current offset (cells, rad), for checks
//
// The pass. The hands are drawn in their own render (renderViewmodels, once a
// presented frame, before post.render), so they never go through TAA (which
// smears anything that moves with the camera) and never clip into walls: their
// own camera (the main camera's pose and FOV, a near plane of VM_NEAR cells),
// their own multisampled target and depth, lit like the world (the sun's
// direction and colour, the light of the GI probe at the eye). Post's canvas
// pass tone maps them with the frame's exposure and composites them over it
// (docs/webgpu.md F3): renderViewmodels returns the resolved target, and the
// glow layer's, for post.render's { viewmodel, glow }. Everything under
// env.viewmodel goes on VIEWMODEL_LAYER, which the main camera doesn't see. It
// stays in the main scene graph, so the frame loop's scene key (and with it
// render-on-demand) still notices when a hand moves.

export const VIEWMODEL_LAYER = 5;     // three.js layer the viewmodels draw on (the main camera sees layer 0 only)
// Light the hands give off (a torch's flame: flame.js 'overlay'), drawn into its own target and added
// over the finished frame, tone mapped by itself: the hands' pass has no bloom, and light with no
// coverage can't go through its straight-colour composite. A mesh goes on it with userData.vmLayer.
export const VIEWMODEL_GLOW_LAYER = 6;

// spring recoil
const SPRING_OMEGA = Math.sqrt(260);  // rad/s natural frequency (Feel Lab SPRING.k = 260 /s²)
const SPRING_ZETA = 18 / (2 * SPRING_OMEGA);   // damping ratio (Feel Lab SPRING.c = 18 /s): ≈ 0.56, one clear overshoot
const SPRING_SUBSTEP = 1 / 240;       // s: longest integration step (keeps the spring stable on slow frames)
// Kick at strength 1: velocity thrown into the spring (the Feel Lab's KICK × its 30 /s impulse rate).
const KICK_BACK = 0.22 * 30;          // cells/s, back toward the eye (+z)
const KICK_PITCH = 0.16 * 30;         // rad/s, muzzle up
const KICK_ROLL = 0.05 * 30;          // rad/s, either way at random
const KICK_RISE = 0.05 * 30;          // cells/s, up

// How each tool's moment feels, in one table so every tool (and any new one) gets the same treatment:
// kick, the hand's spring strength (above); punch, the view punch (feel.js, Source's ViewPunch spring) as
// [min, max] rad ranges, pitch + up and yaw + left. Mining contact is handled by feel.js, not this spring.
// The gun's peaks where its old camera kick did (2°): Source's spring peaks at
// ≈ 1.28 × the punch angle, so 2° / 1.28.
const DEG = Math.PI / 180;
const GUN_PUNCH = (2 / 1.28) * DEG;
export const HIT = {
  GUN: { kick: 1, punch: { pitch: [GUN_PUNCH, GUN_PUNCH] } },                          // a shot
  SMG: { kick: 0.45, punch: { pitch: [0.3 * DEG, 0.8 * DEG], yaw: [-0.4 * DEG, 0.4 * DEG] } },   // a round of a burst (HL2 SMG1's 0.5–1° kick)
  SNIPER: { kick: 2.2, punch: { pitch: [4 * DEG, 5 * DEG], yaw: [-0.5 * DEG, 0.5 * DEG] } },     // a .50: a heavy shove up
  ROCKET: { kick: 1.6, punch: { pitch: [2 * DEG, 3 * DEG] } },                         // a rocket leaving the tube
  DRY: { kick: 0.25 },                                                                 // a dry click
  AXE: { kick: 0.5 },                                                                  // the hand carries the chop
  PICK: { kick: 0.7 },                                                                 // the heavier head's recoil stays in the hand
  FLING: { kick: 0.6 },                                                                // a physgun fling
  SHOVEL: { kick: 0.25 },                                                            // the blade carries the scoop
  PLACE: { kick: 0.3 },                                                                // a trowel block set down
  THROW: { kick: 0.4 },                                                                // a bomb thrown
  DRINK: { kick: 0.15, punch: { pitch: [1 * DEG, 1.5 * DEG] } },                     // a gulp from the flask: the head tips back
  KNIFE: { kick: 0.3, punch: { pitch: [-1 * DEG, -0.5 * DEG] } },                     // a stab: half the axe's punch, straight in
  BACKSTAB: { kick: 0.8, punch: { pitch: [-3 * DEG, -2 * DEG], yaw: [-1 * DEG, 1 * DEG] } },   // a backstab: the blade driven in, the pickaxe's weight
  POGO: { kick: 0.2 },                                                                 // a pogo bounce: the stick's jolt in the hands
  HOOK: { kick: 0.5, punch: { pitch: [0.5 * DEG, 1 * DEG] } },                       // the hook's claw fired
  KICK: { punch: { pitch: [-1.5 * DEG, -0.5 * DEG], yaw: [-0.5 * DEG, 0.5 * DEG] } },   // the boot landed (kick.js): the view jolts, the hands stay put
  LASER: { kick: 4 },                                                                  // the laser cannon's beam: the heaviest shove in the hands, but no view punch (Halo 3's Spartan Laser never throws the view), so the crosshair stays on the lingering beam
  BURROWER: { kick: 1.2, punch: { pitch: [1.5 * DEG, 2.5 * DEG] } },                   // the burrower's drill leaving the tube
  WAND: { kick: 0.4, punch: { pitch: [0.2 * DEG, 0.5 * DEG], yaw: [-0.2 * DEG, 0.2 * DEG] } },   // a wand's cast: a flick of the wrist and a small nod, under the SMG's (Noita's wands have no recoil of their own)
};
const randIn = ([lo, hi] = [0, 0]) => lo + Math.random() * (hi - lo);

// sway (the hand trails the look)
const SWAY_GAIN = 0.05;               // s: offset per rad/s of look rate (Feel Lab)
const SWAY_MAX = 0.12;                // the sway signal is clamped to this (≈ 2.4 rad/s of look rate)
const SWAY_FOLLOW = 10;               // 1/s: how fast sway follows the look rate (Feel Lab)
const SWAY_POS = 0.3;                 // cells of offset per unit of sway (Feel Lab)
const SWAY_ROT = 0.5;                 // rad per unit of sway (Feel Lab)
const SWAY_ROLL = 0.4;                // rad of roll per unit of yaw sway (Feel Lab)

// breathing and walking
const BREATH_RATE = 1.6;              // rad/s of the breathing cycle (Feel Lab)
const BREATH_AMP = 0.016;             // cells (the Feel Lab's 0.008, doubled: its gun sat half as far from the eye)
const BOB_STRIDE = 9;                 // cells per bob cycle: the camera's (camera.js BOB_STRIDE), so they step together
const BOB_FULL_SPEED = 6;             // cells/s of ground speed for the full bob (camera.js BOB_FULL_SPEED)
const BOB_RATE = 8;                   // 1/s: how fast the bob's size follows the speed
const BOB_Y = 0.05;                   // cells, down at each footstep
const BOB_X = 0.04;                   // cells, side to side once per cycle
const BOB_ROLL = 0.03;                // rad, roll with the side-to-side

// swimming: the tool held up and tipped back, out of the stroke
const SWIM_LIFT = 0.12;               // cells up
const SWIM_PITCH = 0.25;              // rad
const SWIM_RATE = 4;                  // 1/s: how fast the pose blends in and out

// render on demand: the rig asks for frames until it has settled this close to rest
const REST_EPS = 1e-4;                // cells, rad and their rates

// the overlay pass
const VM_NEAR = 0.01;                 // cells: near plane (the hands sit 1–2 cells from the eye)
const VM_FAR = 12;                    // cells: far plane (the physgun's beam doesn't draw here)
const VM_MSAA = 4;                    // samples: the hands skip TAA, so they get MSAA (resolved for post's composite)
// three's Lambert BRDF is albedo/π; the engine's shading is albedo × light. Lights at π make them agree.
const LIGHT_SCALE = Math.PI;
// The world's light at the eye: the GI probe the camera is in, read back a few
// times a second. Its spherical harmonics light the hands the way the probes
// light the world (sky and bounce in the open, a cave's own light under the
// ground: three's LightProbe takes the same L1 basis, irradiance included).
// The sun on them is the window's sun shadow map at the eye, read as the world
// reads it inside volumes (lighting.js sunMapShadow): the hands hold no
// daylight down a tunnel. (The probe's sky visibility won't do for the sun:
// L1 over a brick leaves a cave a few % of the open sky's, and the sun is so
// much brighter than a cave's own light that the hands shone in it.)
const EYE_READ_S = 0.25;              // s between reads of the eye's probe and its sun
const EYE_LIGHT_TAU = 0.3;            // s: the hands' light follows the reads this smoothly (no pop at a cave's mouth)

const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The rig of env.viewmodel, made on first use. It is also env.viewmodel.userData.rig
// (for checks: `__app.pov.viewmodel.userData.rig`).
export function viewmodelRig(env) {
  env.viewmodel.userData.rig ??= createRig(env);
  return env.viewmodel.userData.rig;
}

function createRig(env) {
  const root = new THREE.Group();     // cell-scaled camera space
  root.name = 'viewmodel-rig';
  env.viewmodel.add(root);
  const hands = [];

  // spring state: position (cells) and rotation (rad) offsets, and their rates
  const sp = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  const sv = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  const sway = new THREE.Vector2();   // x: yaw, y: pitch
  let prevYaw = NaN, prevPitch = NaN;
  let time = 0, bobPhase = 0, bobAmp = 0, swim = 0;
  const pos = new THREE.Vector3(), rot = new THREE.Euler(), wingAnimation = createFlapAnimation();
  // Built on the first flap, not at rig creation: a mesh id draws from Math.random, and the
  // gun's spread uses that same generator (firearm.js).
  let wingArms = null, wingSleeve = null, wingSkin = null, wingGeo = null;
  function wings() {
    if (wingArms) return wingArms;
    wingSleeve = new THREE.MeshLambertMaterial({ color: 0x8a3a2a, flatShading: true });
    wingSkin = new THREE.MeshLambertMaterial({ color: 0xc48a5c, flatShading: true });
    wingGeo = {
      fist: new THREE.BoxGeometry(0.26, 0.3, 0.11),
      finger: new THREE.BoxGeometry(0.048, 0.15, 0.09),
      thumb: new THREE.BoxGeometry(0.08, 0.16, 0.1),
      upper: new THREE.CapsuleGeometry(0.14, 0.52, 4, 8),
      fore: new THREE.CapsuleGeometry(0.12, 0.66, 4, 8),
    };
    wingArms = [-1, 1].map((side) => {
      const g = new THREE.Group();
      g.name = 'flap-wing';
      g.position.set(side * 0.65, -0.85, 0.25);
      const upper = new THREE.Mesh(wingGeo.upper, wingSleeve);
      upper.position.y = -0.4;
      const elbow = new THREE.Group(); elbow.name = 'flap-elbow'; elbow.position.y = -0.8;
      const fist = new THREE.Mesh(wingGeo.fist, wingSkin);
      fist.name = 'flap-fist'; fist.position.y = -0.9;
      for (const x of [-0.09, -0.03, 0.03, 0.09]) {
        const finger = new THREE.Mesh(wingGeo.finger, wingSkin);
        finger.position.set(x, -1.09, 0);
        elbow.add(finger);
      }
      const thumb = new THREE.Mesh(wingGeo.thumb, wingSkin);
      thumb.position.set(side * 0.16, -0.9, 0); thumb.rotation.z = -side * 0.5;
      elbow.add(thumb);
      const fore = new THREE.Mesh(wingGeo.fore, wingSkin);
      fore.position.y = -0.45;
      elbow.add(fist, fore); g.add(upper, elbow);
      g.traverse((o) => o.layers.set(VIEWMODEL_LAYER));
      root.add(g);
      return { g, elbow, side };
    });
    return wingArms;
  }
  function poseFlap(wing, dt = 0) {
    root.scale.setScalar(env.getScale());
    const beat = wing > 0 ? wing : 0;
    const wingPose = wingAnimation.update(dt, beat);
    if (!wingAnimation.active && !wingArms) return;
    const heldRight = hands.some((h) => h.visible && h.userData.rest.x > 0.05);
    const heldLeft = hands.some((h) => h.visible && h.userData.rest.x < -0.05);
    for (const { g, elbow, side } of wings()) {
      g.visible = wingAnimation.active && !(side > 0 && heldRight) && !(side < 0 && heldLeft);
      g.quaternion.identity().slerp(side < 0 ? wingPose.viewLeft : wingPose.viewRight, wingPose.weight);
      elbow.quaternion.identity().slerp(wingPose.viewElbow, wingPose.weight);
    }
    if (wingAnimation.active) globalThis.__app?.requestRender?.();
  }

  function stepSpring(dt) {
    for (const k in sp) {
      sv[k] += (-SPRING_OMEGA * SPRING_OMEGA * sp[k] - 2 * SPRING_ZETA * SPRING_OMEGA * sv[k]) * dt;
      sp[k] += sv[k] * dt;
    }
  }

  function kick(strength = 1) {
    sv.z += KICK_BACK * strength;
    sv.y += KICK_RISE * strength;
    sv.pitch += KICK_PITCH * strength;
    sv.roll += (Math.random() - 0.5) * 2 * KICK_ROLL * strength;
    globalThis.__app?.requestRender?.();
  }

  const settled = () => Object.keys(sp).every((k) => Math.abs(sp[k]) < REST_EPS && Math.abs(sv[k]) < REST_EPS)
    && sway.lengthSq() < REST_EPS * REST_EPS && bobAmp < REST_EPS;

  function update(ctx) {
    const dt = ctx.dt;
    time += dt;
    root.scale.setScalar(env.getScale());

    // recoil
    for (let left = dt; left > 0; left -= SPRING_SUBSTEP) stepSpring(Math.min(left, SPRING_SUBSTEP));

    // sway from the aim's angular velocity
    const yaw = Math.atan2(-ctx.dir.x, -ctx.dir.z), pitch = Math.asin(THREE.MathUtils.clamp(ctx.dir.y, -1, 1));
    const rateYaw = Number.isNaN(prevYaw) || dt <= 0 ? 0 : wrapAngle(yaw - prevYaw) / dt;
    const ratePitch = Number.isNaN(prevPitch) || dt <= 0 ? 0 : (pitch - prevPitch) / dt;
    prevYaw = yaw; prevPitch = pitch;
    const clampSway = (r) => THREE.MathUtils.clamp(r * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
    sway.x += (clampSway(rateYaw) - sway.x) * approach(SWAY_FOLLOW, dt);
    sway.y += (clampSway(ratePitch) - sway.y) * approach(SWAY_FOLLOW, dt);

    // walk bob, in step with the camera's
    const p = ctx.player ?? {};
    const speedH = p.vel ? Math.hypot(p.vel.x, p.vel.z) : 0;
    const walking = p.onGround && !p.inLiquid;
    const bobbing = ctx.viewBobbing !== false;   // the View Bobbing setting (Minecraft's: it stills the hand too)
    const rush = p.body?.sprintRush ?? 0;
    bobAmp += ((walking && bobbing ? Math.min(speedH / BOB_FULL_SPEED, 1) * (1 - 0.65 * rush) : 0) - bobAmp) * approach(BOB_RATE, dt);
    if (walking) bobPhase += (speedH / (1 + rush) / BOB_STRIDE) * 2 * Math.PI * dt;
    const bobY = -BOB_Y * bobAmp * 0.5 * (1 - Math.cos(2 * bobPhase));
    const bobX = BOB_X * bobAmp * Math.sin(bobPhase);

    // swimming pose
    swim += ((p.inLiquid ? 1 : 0) - swim) * approach(SWIM_RATE, dt);

    const breath = Math.sin(time * BREATH_RATE) * BREATH_AMP;
    // Turning left (yaw rate > 0), the hand lags: it drifts right and turns right of the aim.
    pos.set(
      sp.x + sway.x * SWAY_POS + bobX,
      sp.y - sway.y * SWAY_POS + bobY + breath + swim * SWIM_LIFT,
      sp.z,
    );
    rot.set(
      sp.pitch - sway.y * SWAY_ROT + swim * SWIM_PITCH,
      sp.yaw - sway.x * SWAY_ROT,
      sp.roll + sway.x * SWAY_ROLL + BOB_ROLL * bobAmp * Math.sin(bobPhase),
    );
    for (const h of hands) {
      h.position.copy(h.userData.rest).add(pos);
      h.rotation.copy(rot);
    }
    updateViewmodelArms(root, env.getCharacter?.() ?? 'real');
    // The shell advances the flap once per frame, after tools place their grips.
    setLayers(env.viewmodel);
    if (!settled()) globalThis.__app?.requestRender?.();
  }

  // a HIT entry: the hand's kick, and the view punch (feel.js listens for 'punch')
  function hit(spec) {
    if (spec.kick) kick(spec.kick);
    if (spec.punch) povEvents.emit('punch', { pitch: randIn(spec.punch.pitch), yaw: randIn(spec.punch.yaw) });
  }

  return {
    root,
    hand(rest) {
      const h = new THREE.Group();
      h.userData.rest = new THREE.Vector3(...rest);
      h.position.copy(h.userData.rest);
      h.visible = false;
      root.add(h);
      hands.push(h);
      return h;
    },
    releaseHand(hand) {
      const i = hands.indexOf(hand);
      if (i !== -1) hands.splice(i, 1);
      hand.removeFromParent();
    },
    update,
    kick,
    hit,
    get state() {
      return { pos: pos.clone(), rot: new THREE.Vector3(rot.x, rot.y, rot.z), spring: { ...sp } };
    },
    poseFlap,
    resetFlap() { wingAnimation.reset(); wingArms?.forEach(({ g }) => { g.visible = false; }); },
    dispose() {
      wingSleeve?.dispose(); wingSkin?.dispose();
      if (wingGeo) Object.values(wingGeo).forEach(geometry => geometry.dispose());
      root.removeFromParent();
    },
  };
}

// A material for meshes a tool adds to its model (the shovel's heap, the
// bucket's liquid): flat-shaded and lit by the pass's lights, like the models.
export function heldMaterial(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

// every viewmodel object on its layer (but one waiting on its pipelines: guardMeshes moves
// it back); true if any is on the glow layer
function setLayers(obj) {
  let glow = false;
  obj.traverse((o) => {
    const layer = o.userData.vmLayer ?? VIEWMODEL_LAYER;
    if (o.layers.mask !== PENDING_MASK) o.layers.set(layer);
    if (layer === VIEWMODEL_GLOW_LAYER && o.visible) glow = true;
  });
  return glow;
}

// ---------------------------------------------------------------- the overlay pass

let pass = null;

function createPass() {
  const cam = useWebGPUCamera(new THREE.PerspectiveCamera());
  cam.layers.set(VIEWMODEL_LAYER);
  cam.matrixAutoUpdate = false;
  const sun = new THREE.DirectionalLight(0xffffff, LIGHT_SCALE);
  const sky = new THREE.LightProbe();   // the eye's GI probe (eyeLight)
  sun.layers.set(VIEWMODEL_LAYER);
  sky.layers.set(VIEWMODEL_LAYER);
  // Linear premultiplied radiance, multisampled and resolved; the samples
  // themselves are only needed inside the pass. Post's canvas pass tone maps
  // it on straight colour (tone mapping is nonlinear: on premultiplied colour
  // every partly covered edge pixel would brighten into a pale outline).
  const target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, samples: VM_MSAA, stencilBuffer: false,
    storeMultisampledColorBuffer: false, storeMultisampledDepthBuffer: false,
  });
  target.texture.name = 'viewmodel';
  // the glow layer: display values (its materials tone map themselves), added over the frame
  const glowTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  glowTarget.texture.name = 'viewmodel glow';
  const size = new THREE.Vector2(), clear = new THREE.Color();
  const eye = {
    read: new Float32Array(16),   // the last read: band 0 (rgb, sky visibility), band 1 x, y, z
    cur: new Float32Array(16),    // what lights the hands now, easing toward it
    have: false, pending: false, readAt: -Infinity, at: 0, pos: new THREE.Vector3(),
    sunRead: 1, sunCur: 1,        // the sun's share at the eye: the last read, and easing toward it
  };
  return { cam, sun, sky, target, glowTarget, size, clear, eye, attached: null };
}

// The probe bands of an open hemisphere: sky radiance sky over the upper half,
// ground under it (the world's skyAmbient as L1), sky visibility whole. The
// hands' light before the first read and with the eye outside the window.
function hemisphereSH(out, sky, ground) {
  for (let c = 0; c < 3; c++) {
    out[c] = (sky[c] + ground[c]) / (2 * SH_Y0);
    out[4 + c] = out[12 + c] = 0;
    out[8 + c] = (3 * (sky[c] - ground[c])) / (4 * SH_Y1);
  }
  out[3] = SKYVIS_OPEN_DC / SH_Y0;
  out[7] = out[11] = out[15] = 0;
}

// Where the window's sun shadow map (volume.shadowTextures.map, render.js
// shadowFrag) holds grid point p: its texel (x, y) and p's depth d along the
// sun, as lighting.js sunBasis and sunMapShadowAt(p) find them.
const UP = new THREE.Vector3(0, 1, 0);
const sb = { u: new THREE.Vector3(), v: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Vector3(), o: new THREE.Vector3() };
function shadowTexel(g, origin, sun, res, p) {
  const R = 0.5 * Math.hypot(g.nx, g.ny, g.nz) + SHADOW_PAD, T = (2 * R) / res;
  const { u, v, c, q, o } = sb;
  u.crossVectors(UP, sun).normalize();
  v.crossVectors(sun, u);
  // the map's centre, snapped to whole texels across the sun as the window moves
  o.set(origin?.x ?? 0, origin?.y ?? 0, origin?.z ?? 0);
  const ou = o.dot(u) / T, ov = o.dot(v) / T;
  c.set(g.nx / 2, g.ny / 2, g.nz / 2).addScaledVector(u, (Math.round(ou) - ou) * T).addScaledVector(v, (Math.round(ov) - ov) * T);
  q.subVectors(p, c);
  const texel = (s) => Math.min(Math.max(Math.floor(((s / R) * 0.5 + 0.5) * res), 0), res - 1);
  return { x: texel(q.dot(u)), y: texel(q.dot(v)), d: R - q.dot(sun) };
}
// The sun's share at depth d behind texel sm: none past the first opaque
// matter, and liquid or glass in between dims it by its optical depth.
function sunThrough(sm, d) {
  if (d >= sm[0] + VOLUME_SHADOW_BIAS) return 0;
  const tid = Math.floor(sm[3] / SHADOW_TINT_ID_SCALE);
  if (tid === 0 || d <= sm[1]) return 1;
  const frac = Math.min(Math.max((d - sm[1]) / Math.max(sm[2] - sm[1], 1e-3), 0), 1);
  return Math.exp(-(sm[3] - tid * SHADOW_TINT_ID_SCALE) * frac);
}

// Read the probe and the sun at the eye (now and then: both reads are async,
// B7) and ease the hands' light toward them. Returns the share of the sun
// reaching the eye.
function eyeLight(camera, eye, sky) {
  const app = globalThis.__app, sim = app?.sim, volume = app?.volume, vol = app?.vol;
  const derived = app?.derived ?? sim?.derived;
  const now = performance.now() / 1000;
  const dt = Math.min(now - eye.at, 1);
  eye.at = now;
  let target = eye.read;
  const p = sim && volume ? volume.worldToLocal(camera.getWorldPosition(eye.pos)) : null;
  const g = sim?.g;
  const b = p && [Math.floor(p.x / BRICK), Math.floor(p.y / BRICK), Math.floor(p.z / BRICK)];
  // on frames the world march draws, L's light at the eye in world cells (gfx/worldEyeLight.js), anywhere
  // in the world: its probe cascades hand over to the open sky past them, as the world's surfaces' do
  const wl = app?.worldLight ?? null;
  const inside = wl ? !!p : b && b[0] >= 0 && b[1] >= 0 && b[2] >= 0 && b[0] < g.nx / BRICK && b[1] < g.ny / BRICK && b[2] < g.nz / BRICK;
  const sun = app?.SUN, gpu = app?.gpu;
  if (wl && p && gpu && !eye.pending && now - eye.readAt >= EYE_READ_S) {
    const o = sim.origin;
    eye.pending = true;
    eye.readAt = now;
    readWorldEye(gpu, wl, [p.x + (o?.x ?? 0), p.y + (o?.y ?? 0), p.z + (o?.z ?? 0)],
      { skyUp: gfxUniforms.uSkyUp.value, ground: gfxUniforms.uGround.value })
      .then((r) => {
        if (!r) return;
        eye.read.set(r.probe);
        eye.sunRead = r.sun;
        if (!eye.have) { eye.cur.set(eye.read); eye.sunCur = eye.sunRead; }
        eye.have = true;
        app.requestRender?.();
      })
      .catch(() => {})   // (a light replaced or the device lost under the read: the next one)
      .finally(() => { eye.pending = false; });
  } else if (!wl && inside && derived?.readProbe && vol && sun && gpu && !eye.pending && now - eye.readAt >= EYE_READ_S) {
    // (no shadow map yet, or none in this view: the sun as the volume has it, unshadowed)
    const st = vol.shadowState === 'ready' ? shadowTexel(g, sim.origin, sun, vol.shadowRes, p) : null;
    eye.pending = true;
    eye.readAt = now;
    Promise.all([
      derived.readProbe(b),
      st ? gpu.readback.texture(vol.shadowTextures.map, { origin: [st.x, st.y, 0], size: [1, 1, 1] }) : null,
    ])
      .then(([probe, sm]) => {
        if (!probe) return;
        eye.read.set(probe);
        eye.sunRead = sm ? sunThrough(sm, st.d) : 1;
        if (!eye.have) { eye.cur.set(eye.read); eye.sunCur = eye.sunRead; }   // the first read: no easing in from nothing
        eye.have = true;
        app.requestRender?.();
      })
      .catch(() => {})   // (a grid replaced or the device lost under the read: the next one)
      .finally(() => { eye.pending = false; });
  }
  let sunTarget = eye.sunRead;
  if (!inside || !eye.have) {
    target = eye.hemi ??= new Float32Array(16);
    hemisphereSH(target, gfxUniforms.uSkyUp.value, gfxUniforms.uGround.value);
    sunTarget = 1;
    if (!eye.have) { eye.cur.set(target); eye.sunCur = sunTarget; }
  }
  const k = 1 - Math.exp(-dt / EYE_LIGHT_TAU);
  for (let j = 0; j < 16; j++) eye.cur[j] += (target[j] - eye.cur[j]) * k;
  eye.sunCur += (sunTarget - eye.sunCur) * k;
  // three's SH3 order: Y00, then band 1 as y, z, x
  const sh = sky.sh.coefficients, c = eye.cur;
  sh[0].set(c[0], c[1], c[2]);
  sh[1].set(c[8], c[9], c[10]);
  sh[2].set(c[12], c[13], c[14]);
  sh[3].set(c[4], c[5], c[6]);
  return eye.sunCur;
}

// what this frame's pass drew: { frame (gpu.frameNo), drawn }
let last = { frame: -1, drawn: null };

/**
 * Draws the viewmodels into their own targets for this presented frame: the
 * hands (linear premultiplied, resolved from VM_MSAA samples) and their glow
 * layer (display values). Pass what it returns as post.render's
 * { viewmodel, glow } (src/wire/mesh.js does, as app.viewmodel and app.glow).
 * Draws once a frame: a second call in the same frame (src/wire/pov.js asks
 * too) returns the first's. Null when there is nothing to draw; glow null
 * when no glow mesh shows.
 * @param {object} three three's renderer (app.renderer)
 * @param {object} scene
 * @param {object} camera
 * @param {object} [post] gfx/post.js's (its exposure and raw switch light the glow layer)
 * @returns {{ viewmodel: GPUTexture, glow: GPUTexture | null } | null}
 */
export function renderViewmodels(three, scene, camera, post) {
  const frame = globalThis.__app?.gpu?.frameNo;
  if (frame != null && frame === last.frame) return last.drawn;
  last = { frame: frame ?? -1, drawn: drawViewmodels(three, scene, camera, post) };
  return last.drawn;
}

function drawViewmodels(three, scene, camera, post) {
  const vm = scene.getObjectByName('pov-viewmodel');
  if (!vm?.visible || !vm.parent) return null;
  pass ??= createPass();
  const { cam, sun, sky, target, glowTarget, size, clear, eye } = pass;
  if (pass.attached !== scene) { scene.add(sun, sky); pass.attached = scene; }
  const glow = setLayers(vm);

  // the main camera's pose and lens, a near plane just in front of the eye
  const scale = vm.getObjectByName('viewmodel-rig')?.scale.x ?? 1;
  camera.updateMatrixWorld();
  cam.matrix.copy(camera.matrixWorld);
  cam.updateMatrixWorld(true);
  cam.fov = camera.fov;
  cam.aspect = camera.aspect;
  cam.near = VM_NEAR * scale;
  cam.far = VM_FAR * scale;
  cam.updateProjectionMatrix();

  // lit like the world: the key light's direction and colour, as much of it as
  // reaches the eye, and the light of the probe the eye is in
  const SUN = globalThis.__app?.SUN;
  if (SUN) sun.position.copy(SUN);
  const lit = eyeLight(camera, eye, sky);
  // the key light: the sun by day, the dim blue moon by night (gfx/daylight.js)
  const [kr, kg, kb] = gfxUniforms.uKeyLight?.value ?? [1, 1, 1];
  const [sr, sg, sb2] = gfxUniforms.uSunCol.value;
  sun.color.setRGB(sr * kr * lit, sg * kg * lit, sb2 * kb * lit);
  const settings = post?.settings;
  flameOverlay.exposure.value = 2 ** (settings?.exposure ?? 0);
  flameOverlay.raw.value = settings?.raw ? 1 : 0;

  three.getDrawingBufferSize(size);
  const w = Math.max(1, size.x), h = Math.max(1, size.y);
  if (target.width !== w || target.height !== h) { target.setSize(w, h); glowTarget.setSize(w, h); }

  // a mesh three hasn't compiled for these targets waits until it has (no pipeline built at a draw)
  const wake = () => globalThis.__app?.requestRender?.();
  guardMeshes(vm, cam, { target, scene, onReady: wake });
  if (glow) {
    cam.layers.set(VIEWMODEL_GLOW_LAYER);
    try { guardMeshes(vm, cam, { target: glowTarget, scene, onReady: wake }); }
    finally { cam.layers.set(VIEWMODEL_LAYER); }
  }

  const prev = { target: three.getRenderTarget(), autoClear: three.autoClear, alpha: three.getClearAlpha() };
  three.getClearColor(clear);
  try {
    // cleared in the pass itself: a separate clear pass would store samples the draw then loads
    three.autoClear = true;
    three.setClearColor(0x000000, 0);
    three.setRenderTarget(target);
    three.render(scene, cam);
    if (glow) {   // the hands' light, its own target added over the frame by post
      cam.layers.set(VIEWMODEL_GLOW_LAYER);
      three.setRenderTarget(glowTarget);
      three.render(scene, cam);
    }
  } finally {
    cam.layers.set(VIEWMODEL_LAYER);
    three.autoClear = prev.autoClear;
    three.setClearColor(clear, prev.alpha);
    three.setRenderTarget(prev.target);
  }
  // (three's GPUTextures: made anew on a resize, so fetched each frame)
  return { viewmodel: gpuTextureOf(three, target.texture), glow: glow ? gpuTextureOf(three, glowTarget.texture) : null };
}
