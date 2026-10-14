import * as THREE from 'three/webgpu';
import {
  uniform, texture, uv, vec3, float, mix, smoothstep, length, normalWorld, positionWorld, positionLocal, normalLocal, faceDirection,
} from 'three/tsl';
import { litColor, gridPosition, figNormalMappedFn, prepareMesh, getMeshGpu, unlitMaterial } from '../gfx/meshLight.js';
import { BODY_HEIGHT, BODY_WIDTH } from './constants.js';
import { limb as ikLimb, solveLimb } from './limbs.js';
import { strikePose, sampleKickPose, kickBlend } from './strikePose.js';
import { flapPose, sampleFlap } from './flapPose.js';

// The body you see in third person and when you die, built from three.js
// primitives in grid cells and scaled into the world. createFigure(build)
// takes the look: buildStick here, a stick figure, a nod to The Powder Toy's
// STKM (square head, stick limbs), and the stand-in while the realistic body
// (figureReal.js) loads; or another look on the same rig and animation
// (figureCrasher.js). A look can ask for outlines (an inverted hull), two-tone
// cel shading, unlit glowing parts and jetpack flames.
//
// It is lit by the same light as the volume (gfx/meshLight.js: the volume's
// lighting, function for function, on its own textures), so the sun and its
// shadow map, the GI probes (sky and bounce light, dark in caves) and the
// glow of hot matter fall on it the way they fall on the sand next to it. It
// is drawn before the volume, which marches to its depth (docs/webgpu.md Sync
// log S1: water in front of a body tints it).

// Proportions, in cells. Feet at 0, eye at the head's centre (EYE_HEIGHT 5).
const HEAD = 1.0;                        // edge of the square head
const NECK = 0.15;
const HIP_Y = 2.6;                       // hip joints above the feet
const TORSO = BODY_HEIGHT - HEAD - NECK - HIP_Y;  // pelvis to the neck
const THIGH = 1.3, SHIN = HIP_Y - THIGH; // the legs reach the floor
const UPPER_ARM = 1.05, FOREARM = 1.0;
const SHOULDER_DROP = 0.2;               // shoulders sit this far below the neck
const HIP_HALF = 0.28;                   // half the distance between the hip joints
const SHOULDER_HALF = BODY_WIDTH * 0.32; // half the distance between the shoulders
const LIMB_R = 0.17;                     // stick radius
const TORSO_R = 0.24;
const CAP_SEGMENTS = 4, RADIAL_SEGMENTS = 10;

export const STICK_HAND = 'stick-hand_r';   // the stickman's right-hand point, by name (the realistic body's bone is hand_r)

// Material: a light, slightly warm matte (albedo, linear).
const ALBEDO = [0.72, 0.7, 0.66];

const FLAME_FLICKER = 0.35;               // ± share of a jet flame's length, frame to frame
const TOON_EDGE = 0.08;                  // n·l over which a cel-shaded look goes from shade to lit
const HEAT_GLOW = [2.4, 0.9, 0.25];      // radiance added at full heat (feel.heat = 1): a burning body glows

// Contact shadow under the feet on the ground: the volume can't shadow the
// figure's own occlusion, so a soft darkening grounds it.
const CONTACT_R = 1.6;                   // cells, radius
const CONTACT_DARK = 0.45;               // light left at its centre
const CONTACT_LIFT = 0.04;               // cells above the feet (no z-fighting with the ground)

// Animation. Angles in radians.
const POSE_RATE = 14;                    // 1/s: joints follow their target pose
const WEIGHT_RATE = 8;                   // 1/s: walking / airborne / swimming blend in and out
const PITCH_RATE = 5;                    // 1/s: the body tips into a swim this fast
const STEP_LEN = 3.2;                    // cells per footstep (half a walk cycle)
const WALK_FULL_SPEED = 6;               // cells/s: full walking stride from here
const RUN_SPEED = 11;                    // cells/s: the stride stretches into a run by here
const WALK_HIP = 0.55, RUN_HIP = 0.9;    // hip swing
const WALK_KNEE = 0.7, RUN_KNEE = 1.5;   // knee bend on the forward swing
const ARM_SWING = 0.75;                  // shoulder swing per unit hip swing (opposite leg)
const RUN_LEAN = 0.22;                   // forward lean at a run
export const SPRINT_LEAN = 0.55;         // extra rad at full rush: the user's Animal Crossing speed-cheat lean
const STEP_BOB = 0.12;                   // cells the pelvis drops at mid-stance
// Crouched (the body's crouch share, s.crouch: player.js): a deep squat with
// the torso over the knees and the head up, low enough that the stickman fits
// the crouched body's half height. The pelvis drops by what the bend takes off
// the legs, so the feet stay down. The realistic body bends the same.
export const CROUCH_POSE = {
  hip: 1.45,                             // rad, thighs forward
  knee: -2.6,                            // rad, knees bent back
  lean: 0.8,                             // rad, torso forward
  head: 0.6,                             // rad, the head tipped back up to look ahead
};
const CROUCH_WALK = 0.4;                 // share of the walk's leg swing kept, crouched
// how far the hips come down for a bend, with thigh and shin each half of hipY
export const crouchDrop = (hipY, c) =>
  hipY * (1 - (Math.cos(CROUCH_POSE.hip * c) + Math.cos((CROUCH_POSE.hip + CROUCH_POSE.knee) * c)) / 2);
const IDLE_BREATH = 0.035;               // shoulder sway at rest
const BREATH_HZ = 0.3;
const SWIM_SPEED = 2;                    // cells/s: faster than this in liquid swims (horizontal), slower treads water
const SWIM_PITCH = -1.25;                // body tipped forward into a swim
const KICK_HZ = 2.2;                     // flutter kick
const STROKE_HZ = 0.7;                   // arm strokes
const TREAD_HZ = 0.9;
 const FALL_S = 0.7;                      // s to topple over when dead
const FALL_BOUNCE = 0.08;                // rad of bounce as it hits the ground
const FALL_BOUNCE_HZ = 3;
// A held weapon's chop (an NPC's axe): s.chop is the swing's progress 0..1.
// The right arm rises over the head for the wind-up (the tell), then comes down fast.
const CHOP_WINDUP = 0.7;                 // share of the swing spent winding up
const CHOP_UP = [2.8, 0.7];              // rad: shoulder, elbow raised over the head
const CHOP_DOWN = [0.45, 0.1];           // rad: arm down in front, the blow landed
// Looking up and down (s.look: the look's pitch, and the share of it the torso
// takes for a held tool's aim, holds.js): the head follows most of what's left
export const HEAD_LOOK = 0.8;            // share of the look's pitch the head turns
export const HEAD_LOOK_MAX = 1.1;        // rad the head turns at most, up or down
// Reaching (reach(): a held tool's grips, a pogo stick's pegs): where the joints point, cells
// from the shoulder or hip in the body's frame (right, up, back); the left side mirrors right
export const ELBOW_POLE = [1, -1.5, 0.6];   // down, out to the side, a little back
export const KNEE_POLE = [0, -0.5, -2];      // ahead

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

// ---- the materials (docs/webgpu.md F8): TSL, lit by gfx/meshLight.js

// WEBGPU-STUB (docs/webgpu.md J3): the GLSL vertex shader; figureMaterial builds the lit material
export const figureVert = '';
// WEBGPU-STUB (docs/webgpu.md J3)
export function figureFrag() { throw new Error('figureFrag removed in the WebGPU port: docs/webgpu.md F8 (figure.js figureMaterial)'); }

const NO_TINT = [0, 0, 0, 0];   // rgb, share: no stain

/**
 * A figure's per-body values, shared by its materials: emit (linear HDR
 * radiance added unlit: heat glow, a burning wreck), tint (a stain over the
 * albedo: rgb, share) and worldToGrid (scene → grid cells). Uniform nodes:
 * set .value. The tint starts unstained (share 0): three's Vector4() is
 * (0, 0, 0, 1), a full black stain on whatever never sets it (a tool held on
 * the body, a vehicle; the GLSL's unset uniform read 0).
 */
export function figureUniforms() {
  return { emit: uniform(new THREE.Vector3()), tint: uniform(new THREE.Vector4(...NO_TINT)), worldToGrid: uniform(new THREE.Matrix4()) };
}

/**
 * The lit material of figures, vehicles and a tool held on the body (and the
 * worm's, the skinned mannequin's): linear HDR radiance, like the volume (post
 * tone-maps both), albedo × (sun × n·l × shadow + GI + glow) + emit, from the
 * same light as the volume (gfx/meshLight.js). Opaque, depth-writing.
 *   albedo     [r, g, b] linear; material.uniforms.uAlbedo.value is its Vector3
 *              (a team's look and a wreck's char set it, as on the GLSL material)
 *   u          figureUniforms() of its body (null: no emit, no tint, the shared worldToGrid)
 *   toon       cel shading: lit or not, with a thin soft edge (FIG_TOON)
 *   map        an albedo texture (sRGB, read linear) on the first UV set, × albedo
 *   normalMap  a tangent-space normal map on it (normalScale: the loaded material's)
 *   side       THREE.DoubleSide (default) or FrontSide
 * @param {{ albedo: number[], u?: object | null, toon?: boolean, map?: object, normalMap?: object, normalScale?: object, side?: number }} o
 */
export function figureMaterial({ albedo, u = null, toon = false, map = null, normalMap = null, normalScale = null, side = THREE.DoubleSide }) {
  const uAlbedo = uniform(new THREE.Vector3(...albedo));
  let base = uAlbedo;
  if (map) base = base.mul(texture(map).rgb);
  const tinted = u ? mix(base, u.tint.xyz, u.tint.w) : base;
  let n = normalWorld;
  if (normalMap) {
    const scale = uniform(new THREE.Vector2().copy(normalScale ?? new THREE.Vector2(1, 1)));
    n = figNormalMappedFn({ n: normalWorld, face: faceDirection, wp: positionWorld, uv: uv(), m0: texture(normalMap).xyz, scale });
  }
  const mat = new THREE.MeshBasicNodeMaterial({ side });
  mat.lights = false;
  mat.colorNode = litColor({
    albedo: tinted, n, grid: gridPosition(u?.worldToGrid), emit: u ? u.emit : null, toon, toonEdge: TOON_EDGE,
  });
  mat.name = 'figure';
  // what the GLSL material held, for its callers (npc.js's team colours, look.js's char)
  mat.uniforms = { uAlbedo };
  return mat;
}

// Outlines: the mesh again, pushed out along its normals and drawn back faces
// only, in black (the inverted-hull outline of cel-shaded games).
export function outlineMaterial(width, color = 0x000000) {
  const mat = unlitMaterial({ color, side: THREE.BackSide });
  mat.positionNode = positionLocal.add(normalLocal.mul(float(width)));
  mat.name = 'figure outline';
  mat.userData.outlineWidth = width;   // (what the icon bake's fingerprint reads: tools/bake-icons.mjs)
  return mat;
}

// The soft contact shadow under the feet: darkens what is already drawn
// (multiply), most at its centre.
function contactMaterial() {
  const r = length(uv().sub(0.5)).mul(2);
  const k = float(1).sub(smoothstep(0, 1, r));
  const mat = unlitMaterial({ transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true });
  mat.colorNode = vec3(mix(float(1), float(CONTACT_DARK), k));
  mat.name = 'contact shadow';
  return mat;
}

// ---- building a look (also for figureCrasher.js)

// A mesh in `parent` with its albedo (linear rgb) on it; bind() gives it the
// material. opts.glow: unlit, this HDR colour instead. opts.outline: false
// leaves it out of the look's outline.
const UNBOUND = unlitMaterial();   // until bind() builds the lit materials
export function part(parent, geo, albedo, { glow = null, outline = true } = {}) {
  const m = new THREE.Mesh(geo, UNBOUND);
  m.userData.albedo = albedo;
  m.userData.glow = glow;
  m.userData.outline = outline;
  parent.add(m);
  return m;
}
export const capsuleDown = (r, len) => new THREE.CapsuleGeometry(r, len, CAP_SEGMENTS, RADIAL_SEGMENTS).translate(0, -len / 2, 0);

// A stick from a joint downward (length len), as a child of `parent`. Returns the joint.
export function limb(parent, albedo, x, y, len, r) {
  const joint = new THREE.Group();
  joint.position.set(x, y, 0);
  part(joint, capsuleDown(r, len), albedo);
  parent.add(joint);
  return joint;
}

// The wizard's brass barrel pack (Noita's jetpack Hiisi), fitted to each torso.
// Nozzle transforms are shared by the attached flames and the exhaust particles.
// Straps run from the barrels into the back: a pack with a gap reads as floating.
const STRAP = [0.09, 0.05, 0.035];   // dark leather, linear
export function buildJetpack(parent, { up, back, color = [0.75, 0.42, 0.12], nozzleColor = [0.1, 0.1, 0.11] }) {
  const root = new THREE.Group();
  root.name = 'jetpack';
  root.position.set(0, up, back);
  parent.add(root);
  part(root, new THREE.CapsuleGeometry(0.32, 0.36, 4, 16).rotateZ(Math.PI / 2), color);
  for (const side of [-1, 1]) {
    const strap = new THREE.BoxGeometry(0.05, 0.035, 0.52);
    strap.rotateX(-0.55);
    strap.translate(side * 0.16, 0.2, -0.14);
    part(root, strap, STRAP).name = 'jet-strap';
  }
  const belt = new THREE.BoxGeometry(0.52, 0.04, 0.035);
  belt.translate(0, -0.02, -0.18);
  part(root, belt, STRAP).name = 'jet-strap';
  const material = unlitMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  material.color.setRGB(6, 2.6, 0.7);
  const nozzles = [], flames = [];
  for (const side of [-1, 1]) {
    const nozzle = new THREE.Group();
    nozzle.name = `jet-nozzle-${side < 0 ? 'left' : 'right'}`;
    nozzle.position.set(side * 0.3, -0.32 * 0.8 - 0.22, 0);
    root.add(nozzle);
    part(nozzle, new THREE.ConeGeometry(0.17, 0.22, 12, 1, true).translate(0, 0.11, 0), nozzleColor);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.9, 12).rotateX(Math.PI).translate(0, -0.45, 0), material);
    flame.name = 'jet-flame';
    flame.renderOrder = 1;
    flame.visible = false;
    nozzle.add(flame);
    nozzles.push(nozzle);
    flames.push(flame);
  }
  return { root, nozzles, flames };
}

export function updateJetFlames(flames, state) {
  for (const flame of flames) {
    flame.visible = !!state.jetting && !state.dead;
    flame.scale.set(1, 1 + (Math.random() * 2 - 1) * FLAME_FLICKER, 1);
  }
}

// A look's build() returns the rig: body (at the hips) > torso > neck, the
// shoulders, elbows, hips and knees, all joints rotating about x, plus
//   hipY (cells), lieLift (cells the body lifts lying dead on its back),
//   and optionally outline (cells wide), toon (cel shading), jetpack (buildJetpack).
export function buildStick() {
  const body = new THREE.Group(), torso = new THREE.Group(), neck = new THREE.Group();
  body.add(torso);
  part(torso, new THREE.CapsuleGeometry(TORSO_R, TORSO, CAP_SEGMENTS, RADIAL_SEGMENTS).translate(0, TORSO / 2, 0), ALBEDO);
  neck.position.y = TORSO;
  torso.add(neck);
  part(neck, new THREE.BoxGeometry(HEAD, HEAD, HEAD).translate(0, NECK + HEAD / 2, 0), ALBEDO);
  const shY = TORSO - SHOULDER_DROP;
  const shL = limb(torso, ALBEDO, -SHOULDER_HALF, shY, UPPER_ARM, LIMB_R);
  const shR = limb(torso, ALBEDO, SHOULDER_HALF, shY, UPPER_ARM, LIMB_R);
  const hipL = limb(body, ALBEDO, -HIP_HALF, 0, THIGH, LIMB_R);
  const hipR = limb(body, ALBEDO, HIP_HALF, 0, THIGH, LIMB_R);
  const elR = limb(shR, ALBEDO, 0, -UPPER_ARM, FOREARM, LIMB_R);
  // the right hand's point, where the shell (index.js) puts the tool in hand in third person
  const hand = new THREE.Group();
  hand.name = STICK_HAND;
  hand.position.y = -FOREARM;
  elR.add(hand);
  return {
    hipY: HIP_Y, lieLift: LIMB_R, body, torso, neck, shL, shR, hipL, hipR, elR,
    jetpack: buildJetpack(torso, { up: 1.05, back: 0.55 }),
    elL: limb(shL, ALBEDO, 0, -UPPER_ARM, FOREARM, LIMB_R),
    knL: limb(hipL, ALBEDO, 0, -THIGH, SHIN, LIMB_R),
    knR: limb(hipR, ALBEDO, 0, -THIGH, SHIN, LIMB_R),
  };
}

export function createFigure(build = buildStick) {
  const kickPose = strikePose();
  const wingPose = flapPose();
  const u = figureUniforms();
  const tint = [0, 0, 0, 0];
  const root = new THREE.Group();      // at the feet, turned to face the look direction
  root.visible = false;
  const rig = build();
  const { body, torso, neck, shL, shR, elL, elR, hipL, hipR, knL, knR } = rig;
  const flames = rig.jetpack?.flames ?? [];
  const nozzles = rig.jetpack?.nozzles ?? [];
  const HIP = rig.hipY;
  body.position.y = HIP;
  root.add(body);
  const meshes = [];
  body.traverse((o) => { if (o.isMesh && o.userData.albedo) meshes.push(o); });
  // one lit material per albedo (shared by its parts), unlit ones for the glows
  const byColor = new Map(), glowMats = [];
  for (const m of meshes) {
    if (m.userData.glow) {
      const mat = unlitMaterial();
      mat.color.setRGB(...m.userData.glow);
      m.material = mat;
      glowMats.push(mat);
      continue;
    }
    const key = m.userData.albedo.join();
    if (!byColor.has(key)) byColor.set(key, figureMaterial({ albedo: m.userData.albedo, u, toon: !!rig.toon }));
    m.material = byColor.get(key);
  }
  const mats = [...byColor.values()];
  const outlineMat = rig.outline ? outlineMaterial(rig.outline) : null;
  if (outlineMat) for (const m of meshes) if (m.userData.outline) m.add(new THREE.Mesh(m.geometry, outlineMat));

  const contact = createContactShadow();
  root.add(contact);
  let compiled = null;

  // pose state: current joint angles, blend weights
  const J = { hipL: 0, hipR: 0, knL: 0, knR: 0, shL: 0, shR: 0, elL: 0, elR: 0, armOut: 0, legOut: 0, lean: 0, drop: 0, headPitch: 0 };
  const T = { ...J };
  const w = { walk: 0, air: 0, jet: 0, swim: 0, tread: 0 };
  let phase = 0, clock = 0, pitch = 0, facing = 0;

  function setTarget(k, v, weight) { T[k] += v * weight; }
  // the limbs reach() bends (the stickman's lengths, unless the look has its own): the elbows bend forward (+x), the knees back (−x)
  const hand = new THREE.Vector3(0, -(rig.forearm ?? FOREARM), 0), foot = new THREE.Vector3(0, -(rig.shin ?? SHIN), 0);
  const limbs = {
    armR: ikLimb(shR, elR, hand, 1), armL: ikLimb(shL, elL, hand, 1),
    legR: ikLimb(hipR, knR, foot, -1), legL: ikLimb(hipL, knL, foot, -1),
  };
  const vPole = new THREE.Vector3();

  return {
    root,
    nozzles,
    // The light is the volume's whatever the grid (gfx/meshLight.js): nothing
    // to rebuild for a new one. Kept for the shell's calls.
    bind() {},
    get material() { return mats[0]; },
    // Compile its materials for the scene target before it is first drawn
    // (docs/webgpu.md B5, F8); the arguments are the WebGL call's, unused.
    compile() {
      if (!compiled && getMeshGpu()) compiled = prepareMesh(root);
      return compiled ?? Promise.resolve();
    },
    // s = { feet (world), scale, yaw, worldToGrid (Matrix4), speedH (cells/s), velY (cells/s),
    //       onGround, inLiquid, dead, deadTime (s), heat (0..1), jetting, status (status.js set: its stains tint the body),
    //       crouch (0 standing … 1 crouched), look ({ pitch, spine }: the head and the torso follow the look),
    //       lift (cells the body rides up off its feet: a pogo stick's pegs), ride (on a pogo stick) }
    update(dt, s) {
      clock += dt;
      // riding (a pogo stick: s.ride): standing still on its pegs, whatever the body is doing under it
      const riding = !!s.ride && !s.dead;
      if (riding) s = { ...s, onGround: true, inLiquid: false, speedH: 0 };
      root.position.copy(s.feet);
      root.position.y += (s.lift ?? 0) * s.scale;
      root.scale.setScalar(s.scale);
      u.worldToGrid.value.copy(s.worldToGrid);
      u.emit.value.set(...HEAT_GLOW).multiplyScalar(s.heat ?? 0);
      u.tint.value.set(...(s.status ? s.status.tint(tint) : tint.fill(0)));
      if (!s.dead) facing = s.yaw;
      root.rotation.set(0, facing, 0);

      // which pose: on the ground (walk/idle), in the air, swimming or treading water
      const swimming = s.inLiquid && s.speedH > SWIM_SPEED;
      const tw = {
        walk: !s.dead && s.onGround && !s.inLiquid ? 1 : 0,
        air: !s.dead && !s.onGround && !s.inLiquid && !s.jetting ? 1 : 0,
        jet: !s.dead && !!s.jetting ? 1 : 0,
        swim: !s.dead && swimming ? 1 : 0,
        tread: !s.dead && s.inLiquid && !swimming ? 1 : 0,
      };
      const kw = approach(WEIGHT_RATE, dt);
      for (const k in w) w[k] += (tw[k] - w[k]) * kw;

      for (const k in T) T[k] = 0;
      // walk / run / idle
      const amt = Math.min(s.speedH / WALK_FULL_SPEED, 1);
      const run = smooth01((s.speedH - WALK_FULL_SPEED) / (RUN_SPEED - WALK_FULL_SPEED));
      if (s.onGround) phase += (s.speedH / STEP_LEN) * Math.PI * dt;
      const swing = Math.sin(phase) * amt * (WALK_HIP + (RUN_HIP - WALK_HIP) * run);
      const knee = WALK_KNEE + (RUN_KNEE - WALK_KNEE) * run;
      const breath = Math.sin(clock * 2 * Math.PI * BREATH_HZ) * IDLE_BREATH * (1 - amt);
      // crouched (on the ground): the squat, with a shorter stride on top of it
      const crouched = s.dead ? 0 : (s.crouch ?? 0) * w.walk;
      const legs = w.walk * (1 - crouched * (1 - CROUCH_WALK));
      setTarget('hipL', CROUCH_POSE.hip, crouched);
      setTarget('hipR', CROUCH_POSE.hip, crouched);
      setTarget('knL', CROUCH_POSE.knee, crouched);
      setTarget('knR', CROUCH_POSE.knee, crouched);
      setTarget('lean', CROUCH_POSE.lean, crouched);
      setTarget('headPitch', CROUCH_POSE.head, crouched);
      setTarget('drop', crouchDrop(HIP, 1), crouched);
      setTarget('hipL', swing, legs);
      setTarget('hipR', -swing, legs);
      setTarget('knL', -knee * amt * Math.max(0, Math.cos(phase)), legs);
      setTarget('knR', -knee * amt * Math.max(0, -Math.cos(phase)), legs);
      setTarget('shL', -swing * ARM_SWING + breath, w.walk);
      setTarget('shR', swing * ARM_SWING + breath, w.walk);
      setTarget('elL', 0.25 + 0.9 * run, w.walk);
      setTarget('elR', 0.25 + 0.9 * run, w.walk);
      setTarget('armOut', 0.08, w.walk);
      setTarget('lean', RUN_LEAN * run + SPRINT_LEAN * (s.sprintRush ?? 0) * (1 - crouched) * !riding, w.walk);
      setTarget('drop', STEP_BOB * amt * Math.abs(Math.cos(phase)), legs);
      // airborne: knees tucked, arms out, more so falling
      const falling = smooth01(-s.velY / RUN_SPEED);
      setTarget('hipL', 0.7 - 0.4 * falling, w.air);
      setTarget('hipR', 0.4 - 0.3 * falling, w.air);
      setTarget('knL', -1.1 + 0.6 * falling, w.air);
      setTarget('knR', -0.8 + 0.5 * falling, w.air);
      setTarget('shL', 0.5 + 1.2 * falling, w.air);
      setTarget('shR', 0.3 + 1.2 * falling, w.air);
      setTarget('elL', 0.6, w.air);
      setTarget('elR', 0.6, w.air);
      setTarget('armOut', 0.7, w.air);
      setTarget('legOut', 0.12, w.air);
      // flying on the jetpack: legs dangling, a lazy kick, arms out for balance
      const dangle = Math.sin(clock * 2 * Math.PI * TREAD_HZ) * 0.15;
      setTarget('hipL', 0.2 + dangle, w.jet);
      setTarget('hipR', 0.05 - dangle, w.jet);
      setTarget('knL', -0.45, w.jet);
      setTarget('knR', -0.3, w.jet);
      setTarget('shL', 0.35, w.jet);
      setTarget('shR', 0.35, w.jet);
      setTarget('elL', 0.5, w.jet);
      setTarget('elR', 0.5, w.jet);
      setTarget('armOut', 0.6, w.jet);
      setTarget('legOut', 0.1, w.jet);
      setTarget('lean', 0.12, w.jet);
      // swimming: flutter kick, arms stroking overhead
      const kick = Math.sin(clock * 2 * Math.PI * KICK_HZ) * 0.35;
      const stroke = clock * 2 * Math.PI * STROKE_HZ;
      setTarget('hipL', kick, w.swim);
      setTarget('hipR', -kick, w.swim);
      setTarget('knL', -0.25 - 0.2 * Math.max(0, kick), w.swim);
      setTarget('knR', -0.25 - 0.2 * Math.max(0, -kick), w.swim);
      setTarget('shL', 2.2 + 0.9 * Math.sin(stroke), w.swim);
      setTarget('shR', 2.2 + 0.9 * Math.sin(stroke + Math.PI), w.swim);
      setTarget('elL', 0.3, w.swim);
      setTarget('elR', 0.3, w.swim);
      setTarget('armOut', 0.35 + 0.25 * Math.cos(stroke), w.swim);
      setTarget('headPitch', 0.9, w.swim);   // look ahead, not at the bottom
      // treading water: upright, legs cycling, arms sculling
      const tread = clock * 2 * Math.PI * TREAD_HZ;
      setTarget('hipL', 0.45 + 0.35 * Math.sin(tread), w.tread);
      setTarget('hipR', 0.45 + 0.35 * Math.sin(tread + Math.PI), w.tread);
      setTarget('knL', -0.9 - 0.3 * Math.cos(tread), w.tread);
      setTarget('knR', -0.9 - 0.3 * Math.cos(tread + Math.PI), w.tread);
      setTarget('shL', 0.5, w.tread);
      setTarget('shR', 0.5, w.tread);
      setTarget('elL', 0.4, w.tread);
      setTarget('elR', 0.4, w.tread);
      setTarget('armOut', 0.9 + 0.25 * Math.sin(tread * 2), w.tread);
      setTarget('legOut', 0.15, w.tread);
      // dead: limp, limbs splayed a little
      if (s.dead) { T.armOut = 0.5; T.legOut = 0.2; T.elL = T.elR = 0.2; T.knL = T.knR = -0.15; }

      const kp = approach(POSE_RATE, dt);
      for (const k in J) J[k] += (T[k] - J[k]) * kp;
      hipL.rotation.set(J.hipL, 0, -J.legOut);
      hipR.rotation.set(J.hipR, 0, J.legOut);
      knL.rotation.x = J.knL;
      knR.rotation.x = J.knR;
      shL.rotation.set(J.shL, 0, -J.armOut);
      shR.rotation.set(J.shR, 0, J.armOut);
      elL.rotation.x = J.elL;
      elR.rotation.x = J.elR;
      if (!s.dead && s.flap > 0) {
        sampleFlap(s.flap, wingPose);
        shL.quaternion.slerp(wingPose.left, wingPose.weight);
        shR.quaternion.slerp(wingPose.right, wingPose.weight);
        elL.quaternion.slerp(wingPose.elbow, wingPose.weight);
        elR.quaternion.slerp(wingPose.elbow, wingPose.weight);
      }
      const look = !s.dead && s.look ? s.look : null;
      const aimLean = look ? look.pitch * look.spine : 0;
      torso.rotation.set(-J.lean + aimLean, 0, 0);
      neck.rotation.x = J.headPitch + (look ? THREE.MathUtils.clamp((look.pitch - aimLean) * HEAD_LOOK, -HEAD_LOOK_MAX, HEAD_LOOK_MAX) : 0);
      body.position.y = HIP - J.drop;

      // swim pitch about the hips; death topples the whole body backward about the feet
      pitch += ((w.swim * SWIM_PITCH) - pitch) * approach(PITCH_RATE, dt);
      body.rotation.x = pitch;
      if (s.dead) {
        const t = Math.min((s.deadTime ?? 0) / FALL_S, 1);
        const after = Math.max((s.deadTime ?? 0) - FALL_S, 0);
        const bounce = FALL_BOUNCE * Math.exp(-after * FALL_BOUNCE_HZ * 2) * Math.abs(Math.sin(after * FALL_BOUNCE_HZ * Math.PI));
        root.rotation.x = (Math.PI / 2) * t * t - bounce;   // accelerates like a falling plank
        root.position.y += rig.lieLift * s.scale * t;       // lying on its back, not half in the ground
        body.rotation.x = pitch * (1 - t);
      }
      if (s.chop != null && !s.dead) {
        const p = Math.min(Math.max(s.chop, 0), 1);
        const up = smooth01(p / CHOP_WINDUP), down = 1 - (1 - Math.max(0, (p - CHOP_WINDUP) / (1 - CHOP_WINDUP))) ** 3;
        shR.rotation.x = THREE.MathUtils.lerp(THREE.MathUtils.lerp(J.shR, CHOP_UP[0], up), CHOP_DOWN[0], down);
        elR.rotation.x = THREE.MathUtils.lerp(THREE.MathUtils.lerp(J.elR, CHOP_UP[1], up), CHOP_DOWN[1], down);
      }
      if (s.kick != null && !s.dead) {
        sampleKickPose(s.kick, kickPose);
        const weight = kickBlend(s.kick);
        hipR.quaternion.slerp(kickPose.hip, weight);
        knR.quaternion.slerp(kickPose.knee, weight);
        torso.quaternion.premultiply(kickPose.torso);
      }
      contact.visible = s.onGround && !s.dead && !riding;
      updateJetFlames(flames, s);
    },
    setVisible(v) { root.visible = v; },
    // the eye (world), riding the torso: a held tool's aim frame hangs from it (held.js)
    anchor(out) {
      neck.updateWorldMatrix(true, false);
      return neck.localToWorld(out.set(0, NECK + HEAD / 2, 0));
    },
    // Hands and feet to points (world), after update(): { right, left } grips ({ pos },
    // the stickman has no wrist to turn), feet [right, left], weight 0..1 of the reach over the pose
    reach({ right = null, left = null, feet = null, weight = 1 }) {
      if (!(weight > 0)) return;
      const go = (L, at, pole, side) => {
        const q0 = L.upper.quaternion.clone(), q1 = L.lower.quaternion.clone();
        L.upper.parent.localToWorld(vPole.set(side * pole[0], pole[1], pole[2]).add(L.upper.position));
        solveLimb(L, at, vPole);
        if (weight < 1) { L.upper.quaternion.copy(q0.slerp(L.upper.quaternion, weight)); L.lower.quaternion.copy(q1.slerp(L.lower.quaternion, weight)); }
      };
      root.updateWorldMatrix(true, true);
      if (right) go(limbs.armR, right.pos, ELBOW_POLE, 1);
      if (left) go(limbs.armL, left.pos, ELBOW_POLE, -1);
      if (feet) { go(limbs.legR, feet[0], KNEE_POLE, 1); go(limbs.legL, feet[1], KNEE_POLE, -1); }
    },
    dispose() {
      for (const m of mats) m.dispose();
      for (const m of glowMats) m.dispose();
      outlineMat?.dispose();
      new Set(flames.map((f) => f.material)).forEach((m) => m.dispose());
      contact.material.dispose();
      root.traverse((o) => o.geometry?.dispose());
    },
  };
}

// ---- for other bodies (figureReal.js): the same light on any mesh ----

// The stickman's albedo and heat glow, so another body matches it.
export { ALBEDO as FIGURE_ALBEDO, HEAT_GLOW as FIGURE_HEAT_GLOW };

// WEBGPU-STUB (docs/webgpu.md J3): the skinned GLSL vertex shader. A
// SkinnedMesh takes figureMaterial as it is: three's node pipeline skins it.
export const figureSkinnedVert = '';

// The soft contact shadow the stickman stands on, for another body: a child
// of the body's root (at the feet), drawn after the opaque meshes and the
// volume (transparent).
export function createContactShadow() {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * CONTACT_R, 2 * CONTACT_R).rotateX(-Math.PI / 2), contactMaterial());
  mesh.position.y = CONTACT_LIFT;
  mesh.renderOrder = 1;
  return mesh;
}
