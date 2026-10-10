import * as THREE from 'three';
import { gfxUniforms } from '../gfx/uniforms.js';
import { povEvents } from './events.js';

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
// The pass. The hands are drawn after the main post pass, in their own render
// (renderViewmodels, one call in app.js's frame loop), so they never go
// through TAA (which smears anything that moves with the camera) and never
// clip into walls: their own camera (the main camera's pose and FOV, a near
// plane of VM_NEAR cells), their own depth buffer, lit like the world (the sun's
// direction and colour, the sky and ground fill: gfx/uniforms.js), tone mapped
// with the post pass's exposure and composited over the frame. Everything under
// env.viewmodel goes on VIEWMODEL_LAYER, which the main camera doesn't see. It
// stays in the main scene graph, so the frame loop's scene key (and with it
// render-on-demand) still notices when a hand moves.

export const VIEWMODEL_LAYER = 5;     // three.js layer the viewmodels draw on (the main camera sees layer 0 only)

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
// [min, max] rad ranges, pitch + up and yaw + left. The axe's are HL2's crowbar (CWeaponCrowbar::AddViewKick:
// 1–2° down, 1–2° right). The gun's peaks where its old camera kick did (2°): Source's spring peaks at
// ≈ 1.28 × the punch angle, so 2° / 1.28.
const DEG = Math.PI / 180;
const GUN_PUNCH = (2 / 1.28) * DEG;
export const HIT = {
  GUN: { kick: 1, punch: { pitch: [GUN_PUNCH, GUN_PUNCH] } },                          // a shot
  SMG: { kick: 0.45, punch: { pitch: [0.3 * DEG, 0.8 * DEG], yaw: [-0.4 * DEG, 0.4 * DEG] } },   // a round of a burst (HL2 SMG1's 0.5–1° kick)
  SNIPER: { kick: 2.2, punch: { pitch: [4 * DEG, 5 * DEG], yaw: [-0.5 * DEG, 0.5 * DEG] } },     // a .50: a heavy shove up
  ROCKET: { kick: 1.6, punch: { pitch: [2 * DEG, 3 * DEG] } },                         // a rocket leaving the tube
  DRY: { kick: 0.25 },                                                                 // a dry click
  AXE: { kick: 0.5, punch: { pitch: [-2 * DEG, -1 * DEG], yaw: [-2 * DEG, -1 * DEG] } },   // a blow landing
  PICK: { kick: 0.7, punch: { pitch: [-3 * DEG, -2 * DEG], yaw: [-1.5 * DEG, -0.5 * DEG] } },   // a pickaxe blow: heavier, straight down
  FLING: { kick: 0.6 },                                                                // a physgun fling
  PLACE: { kick: 0.3 },                                                                // a trowel block set down
  THROW: { kick: 0.4 },                                                                // a bomb thrown
  DRINK: { kick: 0.15, punch: { pitch: [1 * DEG, 1.5 * DEG] } },                     // a gulp from the flask: the head tips back
  KNIFE: { kick: 0.3, punch: { pitch: [-1 * DEG, -0.5 * DEG] } },                     // a stab: half the axe's punch, straight in
  BACKSTAB: { kick: 0.8, punch: { pitch: [-3 * DEG, -2 * DEG], yaw: [-1 * DEG, 1 * DEG] } },   // a backstab: the blade driven in, the pickaxe's weight
  POGO: { kick: 0.2 },                                                                 // a pogo bounce: the stick's jolt in the hands
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
const VM_MSAA = 4;                    // samples: the hands skip TAA, so they get MSAA
// three's Lambert BRDF is albedo/π; the engine's shading is albedo × light. Lights at π make them agree.
const LIGHT_SCALE = Math.PI;

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
  const pos = new THREE.Vector3(), rot = new THREE.Euler();

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
    bobAmp += ((walking && bobbing ? Math.min(speedH / BOB_FULL_SPEED, 1) : 0) - bobAmp) * approach(BOB_RATE, dt);
    if (walking) bobPhase += (speedH / BOB_STRIDE) * 2 * Math.PI * dt;
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
    update,
    kick,
    hit,
    get state() {
      return { pos: pos.clone(), rot: new THREE.Vector3(rot.x, rot.y, rot.z), spring: { ...sp } };
    },
    dispose() { root.removeFromParent(); },
  };
}

// A material for meshes a tool adds to its model (the shovel's heap, the
// bucket's liquid): flat-shaded and lit by the pass's lights, like the models.
export function heldMaterial(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function setLayers(obj) {
  obj.traverse((o) => o.layers.set(VIEWMODEL_LAYER));
}

// ---------------------------------------------------------------- the overlay pass

let pass = null;

function createPass(renderer) {
  const cam = new THREE.PerspectiveCamera();
  cam.layers.set(VIEWMODEL_LAYER);
  cam.matrixAutoUpdate = false;
  const sun = new THREE.DirectionalLight(0xffffff, LIGHT_SCALE);
  const sky = new THREE.HemisphereLight(0xffffff, 0xffffff, LIGHT_SCALE);
  sun.layers.set(VIEWMODEL_LAYER);
  sky.layers.set(VIEWMODEL_LAYER);
  sky.position.set(0, 1, 0);
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: VM_MSAA });
  // composite: linear premultiplied radiance → three's AgX at the post pass's exposure → sRGB, over the frame.
  // Tone mapping and the sRGB curve are nonlinear, so they run on straight colour: applied to premultiplied
  // colour they brighten every partly covered (anti-aliased) edge pixel into a pale outline.
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { tColor: { value: target.texture } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tColor, vUv);
        if (c.a <= 0.0) discard;
        gl_FragColor = vec4(c.rgb / c.a, c.a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    depthTest: false, depthWrite: false, transparent: true, premultipliedAlpha: true,
  }));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera();
  const size = new THREE.Vector2(), clear = new THREE.Color();
  return { cam, sun, sky, target, quadScene, quadCam, size, clear, attached: null };
}

// Draw the viewmodels over the finished frame. Call right after post.render
// (and before anything reads the canvas, like the screenshot).
export function renderViewmodels(renderer, scene, camera, post) {
  const vm = scene.getObjectByName('pov-viewmodel');
  if (!vm?.visible || !vm.parent) return;
  pass ??= createPass(renderer);
  const { cam, sun, sky, target, quadScene, quadCam, size, clear } = pass;
  if (pass.attached !== scene) { scene.add(sun, sky); pass.attached = scene; }
  setLayers(vm);

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

  // lit like the world: the key light's direction and colour, sky above and ground below
  const SUN = globalThis.__app?.SUN;
  if (SUN) sun.position.copy(SUN);
  // the key light: the sun by day, the dim blue moon by night (gfx/daylight.js)
  const [kr, kg, kb] = gfxUniforms.uKeyLight?.value ?? [1, 1, 1];
  const [sr, sg, sb] = gfxUniforms.uSunCol.value;
  sun.color.setRGB(sr * kr, sg * kg, sb * kb);
  sky.color.setRGB(...gfxUniforms.uSkyUp.value);
  sky.groundColor.setRGB(...gfxUniforms.uGround.value);

  renderer.getDrawingBufferSize(size);
  if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);

  const prev = {
    target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
  };
  renderer.getClearColor(clear);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.clear(true, true, false);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  renderer.toneMapping = post?.settings.raw ? THREE.NoToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** (post?.settings.exposure ?? 0);
  renderer.render(quadScene, quadCam);
  renderer.toneMapping = prev.toneMapping;
  renderer.toneMappingExposure = prev.exposure;
  renderer.autoClear = prev.autoClear;
  renderer.setClearColor(clear, prev.alpha);
  renderer.setRenderTarget(prev.target);
}
