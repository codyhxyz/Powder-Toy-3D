import * as THREE from 'three';
import { buildCrasher, CRASHER_COLORS } from './figureCrasher.js';
import { attachModel, MODELS } from './models.js';

// The class picker's portraits: the Castle Crashers wizard (figureCrasher.js)
// in each class's colours, posed with its tool in its mitten, cel-shaded with
// black outlines and a rim light in the class colour, as TF2's class-select
// screen poses its nine. Drawn once each, one after another, by ONE small
// offscreen renderer of their own that is let go when the last is done
// (models.js draws the hotbar icons the same way). The game's renderer isn't
// touched.
//
//   renderPortraits([{ key, color, pose, model }], (key, url) => ...)  → Promise, when all are drawn

export const PORTRAIT_W = 240;          // px drawn (the card shows it at half: sharp on a 2x screen)
export const PORTRAIT_H = 300;
const FOV = 24;                         // degrees: long lens, little distortion
const FRAME_MARGIN = 1.04;              // room round the figure's box
const FRAME_LIFT = 0.04;                // share of the box height the frame centre sits above the box centre (room for the hood)
const LOW_ANGLE = 0.12;                 // rad the camera looks up at the figure: heroic
const YAW = 0.95;                       // rad the figure turns to screen right: nearly Castle Crashers' side view, the tool out in front
const HELD_SCALE = 3.2;                 // a tool's viewmodel (sized for the eye) grown to Castle Crashers' size, to read in a thumbnail

// look
const TONES = [0.38, 1];                // toon ramp: shaded, lit (Castle Crashers' two tones)
const AMBIENT = 1.25;
const KEY = 2.6;                        // key light, from up front left
const KEY_DIR = [-2.2, 3, -3];
const RIM = 5;                          // rim light in the class colour, from behind
const RIM_DIR = [2.5, 1.6, 3.5];
const ROBE_SHADE = 0.34;                // the robe: the class colour, darkened this much (linear)
const HOOD_SHADE = 0.5;
const SLEEVE_SHADE = 0.3;
const TRIM = [0.85, 0.6, 0.18];         // gold trim (linear)
const EYE_GAIN = 2.2;                   // eyes glow in the class colour, this bright (unlit, clamped)
const OUTLINE_W = 0.09;                 // cells
const OUTLINE_COLOR = 0x0a0608;
const FLAME = [1, 0.62, 0.22];          // jet flame colour (unlit)
const FLAME_LEN = 3;                    // × the flame mesh's length: long enough to show below the robe
const FLAME_WIDTH = 1.8;                // × its width, to read at a thumbnail's size

// Poses: joint angles in radians (figure.js's rig: x swings a limb forward,
// z out to the side; knees bend back with −x). sh/hip: [x, z]; el/kn: x.
// grip: extra turn of the held tool about x (0 points it along the forearm's
// forward). lean: torso forward. lift: cells off the ground. flames: jet on.
const AIM = { shR: [1.25, 0.06], elR: 0.25, shL: [0.95, 0.42], elL: 0.75, hipL: [0.12, -0.1], hipR: [-0.1, 0.1], knL: -0.1, knR: -0.15 };
const POSES = {
  aim: AIM,
  shoulder: { ...AIM, shR: [1.55, 0.1], elR: 0.05, shL: [1.25, 0.5], elL: 0.5, hipL: [0.3, -0.15], knL: -0.3, hipR: [-0.25, 0.12], knR: -0.2 },
  sprint: { shR: [1.7, 0.1], elR: 0.5, shL: [-0.8, -0.15], elL: 0.9, hipL: [0.95, -0.05], knL: -0.4, hipR: [-0.6, 0.05], knR: -1.4, lean: 0.3, lift: 0.35 },
  hover: { shR: [1.0, 0.12], elR: 0.35, shL: [0.3, -0.75], elL: 0.4, hipL: [0.35, -0.12], knL: -0.7, hipR: [0.15, 0.12], knR: -0.45, lean: 0.18, lift: 1.8, flames: true },
  brace: { shR: [1.05, 0.0], elR: 0.45, shL: [1.0, 0.35], elL: 0.9, hipL: [0.25, -0.32], knL: -0.35, hipR: [-0.2, 0.32], knR: -0.3, lean: 0.12, drop: 0.22 },
  sneak: { shR: [0.55, 0.12], elR: 0.9, shL: [0.6, -0.2], elL: 1.2, hipL: [1.0, -0.12], knL: -1.5, hipR: [0.35, 0.12], knR: -1.2, lean: 0.45, drop: 0.5 },
  swing: { shR: [2.75, 0.18], elR: 0.55, shL: [0.5, -0.35], elL: 0.6, hipL: [0.3, -0.15], knL: -0.25, hipR: [-0.3, 0.15], knR: -0.25, lean: -0.08, grip: -0.5 },
  torch: { ...AIM, shR: [1.15, 0.0], elR: 0.3, shL: [0.65, -0.55], elL: 0.5, lean: 0.06 },
};

const lin = (hex) => new THREE.Color(hex);   // three keeps colours linear: setStyle converts the sRGB hex
const shade = (c, k) => [c.r * k, c.g * k, c.b * k];

let kit = null;
function getKit() {
  if (kit) return kit;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(PORTRAIT_W, PORTRAIT_H, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
  const key = new THREE.DirectionalLight(0xffffff, KEY);
  key.position.set(...KEY_DIR);
  const rim = new THREE.DirectionalLight(0xffffff, RIM);
  rim.position.set(...RIM_DIR);
  scene.add(key, rim);
  const camera = new THREE.PerspectiveCamera(FOV, PORTRAIT_W / PORTRAIT_H, 0.1, 200);
  const ramp = new THREE.DataTexture(new Uint8Array(TONES.flatMap((t) => [255 * t, 255 * t, 255 * t, 255])), TONES.length, 1);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  const outline = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uWidth: { value: OUTLINE_W }, uColor: { value: new THREE.Color(OUTLINE_COLOR) } },
    vertexShader: 'uniform float uWidth; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uWidth, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }',
  });
  kit = { renderer, scene, camera, rim, ramp, outline };
  return kit;
}
function dropKit() {
  if (!kit) return;
  kit.ramp.dispose();
  kit.outline.dispose();
  kit.renderer.dispose();
  kit.renderer.forceContextLoss();
  kit = null;
}

// The wizard for one class, posed, its materials made here.
function buildFigure({ color, pose, model }, k) {
  const accent = lin(color);
  const palette = {
    ...CRASHER_COLORS,
    robe: shade(accent, ROBE_SHADE), hood: shade(accent, HOOD_SHADE), trim: TRIM,
  };
  const rig = buildCrasher({ palette, eyeGlow: shade(accent, EYE_GAIN) });
  const P = POSES[pose] ?? AIM;
  const root = new THREE.Group();
  root.add(rig.body);
  rig.body.position.y = rig.hipY - (P.drop ?? 0) + (P.lift ?? 0);
  const set = (j, v) => { if (Array.isArray(v)) j.rotation.set(v[0], 0, v[1]); else if (v != null) j.rotation.x = v; };
  set(rig.shL, P.shL); set(rig.shR, P.shR); set(rig.elL, P.elL); set(rig.elR, P.elR);
  set(rig.hipL, P.hipL); set(rig.hipR, P.hipR); set(rig.knL, P.knL); set(rig.knR, P.knR);
  rig.torso.rotation.x = -(P.lean ?? 0);
  // sleeves a shade darker than the robe, so the arms read against it
  for (const j of [rig.shL, rig.shR, rig.elL, rig.elR]) j.children.forEach((m) => { if (m.isMesh && m.userData.albedo === palette.robe) m.userData.albedo = shade(accent, SLEEVE_SHADE); });
  for (const f of rig.flames) { f.visible = !!P.flames; f.material.color.setRGB(...FLAME); f.scale.set(FLAME_WIDTH, FLAME_LEN, FLAME_WIDTH); }

  // the tool in the right mitten, held along the forearm, levelled toward forward
  let held = null;
  if (model && MODELS[model]) {
    const grip = new THREE.Group();
    grip.position.y = rig.handY;
    grip.scale.setScalar(HELD_SCALE);
    const sh = Array.isArray(P.shR) ? P.shR[0] : 0;
    grip.rotation.x = -(sh + (P.elR ?? 0)) + (P.grip ?? 0);
    rig.elR.add(grip);
    held = attachModel(grip, model, null, { arm: false });
  }

  // materials: toon by albedo (linear), unlit glow, black hull outlines
  const mats = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.albedo == null) return;
    const mat = o.userData.glow
      ? new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...o.userData.glow) })
      : new THREE.MeshToonMaterial({ color: new THREE.Color().setRGB(...o.userData.albedo), gradientMap: k.ramp });
    o.material = mat;
    mats.push(mat);
  });
  root.traverse((o) => {
    if (o.isMesh && o.userData.albedo != null && o.userData.outline && !o.userData.glow) o.add(new THREE.Mesh(o.geometry, k.outline));
  });
  root.rotation.y = P.yaw ?? YAW;
  return {
    root, accent,
    dispose() {
      held?.dispose();   // the tool's geometry (its materials are models.js's, shared)
      root.traverse((o) => { if (o.userData.albedo != null) o.geometry?.dispose(); });
      mats.forEach((m) => m.dispose());
    },
  };
}

function draw(entry) {
  const k = getKit();
  const fig = buildFigure(entry, k);
  k.rim.color.copy(fig.accent);
  k.scene.add(fig.root);
  fig.root.updateMatrixWorld(true);
  // frame the posed figure: its box, from the front (the figure faces −z)
  const box = new THREE.Box3().setFromObject(fig.root, true).expandByPoint(new THREE.Vector3(0, 0, 0));   // and the ground under it (a hover reads)
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  c.y += s.y * FRAME_LIFT;
  const half = (Math.max(s.y, s.x / k.camera.aspect) / 2) * FRAME_MARGIN;
  const dist = half / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) + s.z / 2;
  k.camera.position.set(c.x, c.y - Math.sin(LOW_ANGLE) * dist, c.z - Math.cos(LOW_ANGLE) * dist);
  k.camera.lookAt(c);
  k.renderer.render(k.scene, k.camera);
  const url = k.renderer.domElement.toDataURL('image/png');
  k.scene.remove(fig.root);
  fig.dispose();
  return url;
}

// Draw every entry's portrait, one per animation frame (the picker opens at
// once and they arrive), calling onEach(key, dataUrl). The renderer goes when
// the last is done.
export function renderPortraits(entries, onEach) {
  return new Promise((resolve) => {
    const queue = [...entries];
    const next = () => {
      const e = queue.shift();
      if (!e) { dropKit(); resolve(); return; }
      try { onEach(e.key, draw(e)); } catch (err) { console.error(`class portrait ${e.key} failed`, err); }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
}
