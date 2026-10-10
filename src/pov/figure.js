import * as THREE from 'three';
import { lib } from '../shaders/render.js';
import { BODY_HEIGHT, BODY_WIDTH } from './constants.js';

// The body you see in third person and when you die, built from three.js
// primitives in grid cells and scaled into the world. createFigure(build)
// takes the look: buildStick here, a stick figure, a nod to The Powder Toy's
// STKM (square head, stick limbs), and the stand-in while the realistic body
// (figureReal.js) loads; or another look on the same rig and animation
// (figureCrasher.js). A look can ask for outlines (an inverted hull), two-tone
// cel shading, unlit glowing parts and jetpack flames.
//
// It is lit by the same light as the volume: the same lighting GLSL
// (shaders/gfx/lighting.js) with the volume's own uniforms, so the sun and its
// shadow map, the GI probes (sky and bounce light, dark in caves) and the
// glow of hot matter fall on it the way they fall on the sand next to it. It
// writes depth, and the volume (drawn after it, writing its hit depth) tests
// against it.

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

// Material: a light, slightly warm matte (albedo, linear).
const ALBEDO = [0.72, 0.7, 0.66];

// Where the jetpack's exhaust leaves (vfx.js): cells behind the feet, up from
// them and to each side. The small of the realistic body's back.
export const JET_NOZZLES = { back: 0.6, up: 3.2, side: 0.3 };
const FLAME_FLICKER = 0.35;               // ± share of a jet flame's length, frame to frame
const TOON_EDGE = 0.08;                  // n·l over which a cel-shaded look goes from shade to lit
const HEAT_GLOW = [2.4, 0.9, 0.25];      // radiance added at full heat (feel.heat = 1): a burning body glows
const SHADOW_LIFT = 0.6;                 // cells: shadow lookups move this far toward the sun (off the body's own cells)
const GI_LIFT = 1.5;                     // cells: GI probes are read this far out along the normal

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
const STEP_BOB = 0.12;                   // cells the pelvis drops at mid-stance
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
// The kick (kick.js): s.kick is its progress 0..1. A front kick's three phases,
// as martial arts teach it: chamber (knee up, shin folded), extend (the leg
// snaps straight out ahead), retract (back along the same line), with a lean
// back to balance it. Right leg.
const KICK_CHAMBER_END = 0.25;           // share of the kick spent chambering...
const KICK_EXTEND_END = 0.45;            // ...then extending; the rest retracts
const KICK_CHAMBER = [1.35, -1.9];       // rad: hip forward, knee folded
const KICK_EXTEND = [1.5, -0.05];        // rad: leg straight out, about level
const KICK_LEAN = -0.25;                 // rad: torso back, against the kick

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

const figureVert = /* glsl */ `
uniform mat4 uWorldToGrid;
out vec3 vGrid;
out vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vGrid = (uWorldToGrid * w).xyz;
  vN = mat3(modelMatrix) * normal;   // uniform scale only
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const figureFrag = (g) => /* glsl */ `
${lib(g)}
#define FIG_SHADOW_LIFT ${SHADOW_LIFT.toFixed(3)}
#define FIG_GI_LIFT ${GI_LIFT.toFixed(3)}
#define FIG_TOON_EDGE ${TOON_EDGE.toFixed(3)}
uniform vec3 uAlbedo;
uniform vec3 uEmit;
in vec3 vGrid;
in vec3 vN;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 sh = uShadows ? sunShadow(vGrid + uSun * FIG_SHADOW_LIFT) : vec3(1.0);
  vec3 irr = giIrradiance(probeAt(vGrid + n * FIG_GI_LIFT), n);
  vec3 local = sampleLight(vGrid) * uLightGain;
  // linear HDR radiance, like the volume (post tone-maps both)
  float ndl = max(dot(n, uSun), 0.0);
#ifdef FIG_TOON
  ndl = smoothstep(0.0, FIG_TOON_EDGE, ndl);   // cel shading: lit or not, with a thin soft edge
#endif
  gl_FragColor = vec4(uAlbedo * (SUN_COL * ndl * sh + irr + local) + uEmit, 1.0);
}`;

// Outlines: the mesh again, pushed out along its normals and drawn back faces
// only, in black (the inverted-hull outline of cel-shaded games).
const outlineVert = /* glsl */ `
uniform float uWidth;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uWidth, 1.0); }`;
const outlineFrag = /* glsl */ `
void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`;

const contactFrag = /* glsl */ `
varying vec2 vUv;
uniform float uDark;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float k = 1.0 - smoothstep(0.0, 1.0, r);
  gl_FragColor = vec4(vec3(mix(1.0, uDark, k)), 1.0);
}`;
const contactVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---- building a look (also for figureCrasher.js)

// A mesh in `parent` with its albedo (linear rgb) on it; bind() gives it the
// material. opts.glow: unlit, this HDR colour instead. opts.outline: false
// leaves it out of the look's outline.
const UNBOUND = new THREE.MeshBasicMaterial();   // until bind() builds the lit materials
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

// A look's build() returns the rig: body (at the hips) > torso > neck, the
// shoulders, elbows, hips and knees, all joints rotating about x, plus
//   hipY (cells), lieLift (cells the body lifts lying dead on its back),
//   and optionally outline (cells wide), toon (cel shading), flames (meshes
//   shown, flickering, while the jetpack fires) and nozzles (JET_NOZZLES' shape).
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
  return {
    hipY: HIP_Y, lieLift: LIMB_R, body, torso, neck, shL, shR, hipL, hipR,
    elL: limb(shL, ALBEDO, 0, -UPPER_ARM, FOREARM, LIMB_R),
    elR: limb(shR, ALBEDO, 0, -UPPER_ARM, FOREARM, LIMB_R),
    knL: limb(hipL, ALBEDO, 0, -THIGH, SHIN, LIMB_R),
    knR: limb(hipR, ALBEDO, 0, -THIGH, SHIN, LIMB_R),
  };
}

export function createFigure(build = buildStick) {
  const uniforms = {
    uEmit: { value: new THREE.Vector3() },
    uWorldToGrid: { value: new THREE.Matrix4() },
  };
  // materials are compiled per grid (their GLSL bakes the grid size in), one per albedo
  let mats = [];
  let boundTo = null, compiled = null;

  const root = new THREE.Group();      // at the feet, turned to face the look direction
  root.visible = false;
  const rig = build();
  const { body, torso, neck, shL, shR, elL, elR, hipL, hipR, knL, knR } = rig;
  const flames = rig.flames ?? [];
  const HIP = rig.hipY;
  body.position.y = HIP;
  root.add(body);
  const meshes = [];
  body.traverse((o) => { if (o.isMesh && o.userData.albedo) meshes.push(o); });
  const glowMats = [];
  for (const m of meshes) {
    if (!m.userData.glow) continue;
    const mat = new THREE.MeshBasicMaterial();
    mat.color.setRGB(...m.userData.glow);
    m.material = mat;
    glowMats.push(mat);
  }
  const outlineMat = rig.outline ? new THREE.ShaderMaterial({
    vertexShader: outlineVert, fragmentShader: outlineFrag, side: THREE.BackSide,
    uniforms: { uWidth: { value: rig.outline } },
  }) : null;
  if (outlineMat) for (const m of meshes) if (m.userData.outline) m.add(new THREE.Mesh(m.geometry, outlineMat));

  const contact = new THREE.Mesh(new THREE.PlaneGeometry(2 * CONTACT_R, 2 * CONTACT_R).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: contactVert, fragmentShader: contactFrag,
      uniforms: { uDark: { value: CONTACT_DARK } },
      transparent: true, depthWrite: false,
      blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    }));
  contact.position.y = CONTACT_LIFT;
  contact.renderOrder = 1;               // after the volume (transparent, order 0)
  root.add(contact);

  // pose state: current joint angles, blend weights
  const J = { hipL: 0, hipR: 0, knL: 0, knR: 0, shL: 0, shR: 0, elL: 0, elR: 0, armOut: 0, legOut: 0, lean: 0, drop: 0, headPitch: 0 };
  const T = { ...J };
  const w = { walk: 0, air: 0, jet: 0, swim: 0, tread: 0 };
  let phase = 0, clock = 0, pitch = 0, facing = 0;

  function setTarget(k, v, weight) { T[k] += v * weight; }

  return {
    root,
    // Rebuild the material for a new volume (grid size): it shares the
    // volume's uniforms, so it sees the same sun, shadow map, GI and glow.
    bind(volume, g) {
      if (boundTo === volume) return;
      boundTo = volume;
      for (const m of mats) m.dispose();
      const byColor = new Map();
      const frag = figureFrag(g);
      for (const mesh of meshes) {
        if (mesh.userData.glow) continue;
        const key = mesh.userData.albedo.join();
        if (!byColor.has(key)) {
          byColor.set(key, new THREE.ShaderMaterial({
            vertexShader: figureVert, fragmentShader: frag, side: THREE.DoubleSide,
            defines: rig.toon ? { FIG_TOON: '' } : {},
            uniforms: { ...volume.material.uniforms, ...uniforms, uAlbedo: { value: new THREE.Vector3(...mesh.userData.albedo) } },
          }));
        }
        mesh.material = byColor.get(key);
      }
      mats = [...byColor.values()];
    },
    get material() { return mats[0]; },
    // Compile the shader without blocking (KHR_parallel_shader_compile), so
    // the first drop-in doesn't stall on it.
    compile(renderer, camera, scene) {
      if (compiled === mats[0]) return Promise.resolve();
      compiled = mats[0];
      return renderer.compileAsync(root, camera, scene).catch(() => {});
    },
    // s = { feet (world), scale, yaw, worldToGrid (Matrix4), speedH (cells/s), velY (cells/s),
    //       onGround, inLiquid, dead, deadTime (s), heat (0..1), jetting }
    update(dt, s) {
      clock += dt;
      root.position.copy(s.feet);
      root.scale.setScalar(s.scale);
      uniforms.uWorldToGrid.value.copy(s.worldToGrid);
      uniforms.uEmit.value.set(...HEAT_GLOW).multiplyScalar(s.heat ?? 0);
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
      setTarget('hipL', swing, w.walk);
      setTarget('hipR', -swing, w.walk);
      setTarget('knL', -knee * amt * Math.max(0, Math.cos(phase)), w.walk);
      setTarget('knR', -knee * amt * Math.max(0, -Math.cos(phase)), w.walk);
      setTarget('shL', -swing * ARM_SWING + breath, w.walk);
      setTarget('shR', swing * ARM_SWING + breath, w.walk);
      setTarget('elL', 0.25 + 0.9 * run, w.walk);
      setTarget('elR', 0.25 + 0.9 * run, w.walk);
      setTarget('armOut', 0.08, w.walk);
      setTarget('lean', RUN_LEAN * run, w.walk);
      setTarget('drop', STEP_BOB * amt * Math.abs(Math.cos(phase)), w.walk);
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
      torso.rotation.x = -J.lean;
      neck.rotation.x = J.headPitch;
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
        const p = Math.min(Math.max(s.kick, 0), 1);
        const chamber = smooth01(p / KICK_CHAMBER_END);
        const extend = smooth01((p - KICK_CHAMBER_END) / (KICK_EXTEND_END - KICK_CHAMBER_END));
        const back = smooth01((p - KICK_EXTEND_END) / (1 - KICK_EXTEND_END));
        const at = (rest, i) => THREE.MathUtils.lerp(THREE.MathUtils.lerp(THREE.MathUtils.lerp(rest, KICK_CHAMBER[i], chamber), KICK_EXTEND[i], extend), rest, back);
        hipR.rotation.x = at(J.hipR, 0);
        knR.rotation.x = at(J.knR, 1);
        torso.rotation.x = -J.lean - KICK_LEAN * (chamber - back);
      }
      contact.visible = s.onGround && !s.dead;
      for (const f of flames) {
        f.visible = !!s.jetting && !s.dead;
        f.scale.set(1, 1 + (Math.random() * 2 - 1) * FLAME_FLICKER, 1);
      }
    },
    setVisible(v) { root.visible = v; },
    // where this body's jetpack exhaust leaves (vfx.js), JET_NOZZLES' shape
    nozzles: rig.nozzles ?? JET_NOZZLES,
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

// figureVert for a SkinnedMesh: three's skinning chunks pose the vertex and
// its normal, then it goes to grid space like the stickman's. Pair it with
// figureFrag(g) and the volume's uniforms (plus uAlbedo, uEmit, uWorldToGrid).
export const figureSkinnedVert = /* glsl */ `
#include <skinning_pars_vertex>
uniform mat4 uWorldToGrid;
out vec3 vGrid;
out vec3 vN;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 w = modelMatrix * vec4(transformed, 1.0);
  vGrid = (uWorldToGrid * w).xyz;
  vN = mat3(modelMatrix) * objectNormal;   // uniform scale only
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// The soft contact shadow the stickman stands on, for another body: a child
// of the body's root (at the feet), drawn after the volume.
export function createContactShadow() {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * CONTACT_R, 2 * CONTACT_R).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: contactVert, fragmentShader: contactFrag,
      uniforms: { uDark: { value: CONTACT_DARK } },
      transparent: true, depthWrite: false,
      blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    }));
  mesh.position.y = CONTACT_LIFT;
  mesh.renderOrder = 1;                  // after the volume (transparent, order 0)
  return mesh;
}
