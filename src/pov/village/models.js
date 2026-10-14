import * as THREE from 'three';
export { furniture } from './furnitureModels.js';
import { createLeapAnimation } from './leap.js';
import { loft, hairGeometry, faceEllipse, faceStroke, eyeSurface, eyeTexture, noseGeometry, clothTexture } from './characterShapes.js';
import { strikePose, sampleKickPose, kickBlend } from '../strikePose.js';

// Wild World / City Folk silhouettes; baked shading and painted details work
// in the voxel renderer's unlit scene and shared rolling-log mesh transform.
function mesh(parent, geometry, color, at, scale = [1, 1, 1]) {
  const c = new THREE.Color(color), n = geometry.attributes.normal, colors = [];
  const light = new THREE.Vector3(-0.4, 0.8, -0.5).normalize();
  for (let i = 0; i < n.count; i++) {
    const k = 0.72 + 0.28 * Math.max(0, n.getX(i) * light.x + n.getY(i) * light.y + n.getZ(i) * light.z);
    const shade = geometry.attributes.shade?.getX(i) ?? 1;
    colors.push(c.r * k * shade, c.g * k * shade, c.b * k * shade);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.position.set(...at); m.scale.set(...scale); m.renderOrder = 1; parent.add(m);
  return m;
}
const ball = (p, color, at, scale) => mesh(p, new THREE.SphereGeometry(1, 16, 12), color, at, scale);
const box = (p, color, at, scale) => mesh(p, new THREE.BoxGeometry(1, 1, 1), color, at, scale);
const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export function character({ species = 'human', persona = 'boy', color = '#edbd96', shirt = persona === 'girl' ? '#d87598' : '#5c9a93' } = {}) {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  body.name = 'village-body';
  const human = species === 'human', girl = human && persona === 'girl', tanuki = species === 'tanuki';
  const ink = '#49342b', cream = '#fff1d0', origin = [0, 0, 0];
  const limbs = [], knees = [], elbows = [], eyes = [], lids = [];
  for (const x of [-0.55, 0.55]) {
    const side = x < 0 ? 'left' : 'right';
    const leg = new THREE.Group(); leg.position.set(x, 1.25, 0); body.add(leg);
    leg.name = `leg-${side}`;
    mesh(leg, loft([[0.12, 0.28, 0.28], [-0.35, 0.25, 0.25], [-0.55, 0.19, 0.19]], 10),
      human ? girl ? color : '#4b5960' : color, origin);
    const knee = new THREE.Group(); knee.name = `knee-${side}`; knee.position.y = -0.55; leg.add(knee); knees.push(knee);
    const sock = mesh(knee, loft([[0.08, 0.19, 0.19], [-0.34, 0.18, 0.18]], 10), girl ? '#ffffff' : human ? cream : color, origin);
    if (girl) sock.material.map = clothTexture('#506979', 'stripe');
    const shoe = mesh(knee, loft([[-0.22, 0.24, 0.36, -0.12], [-0.36, 0.35, 0.53, -0.2], [-0.58, 0.35, 0.55, -0.2]], 10),
      human ? girl ? '#aa493f' : '#74513a' : '#ad865d', origin);
    shoe.name = `shoe-${side}`;
    mesh(knee, loft([[-0.58, 0.35, 0.55, -0.2], [-0.66, 0.34, 0.54, -0.2]], 10), cream, origin);
    limbs.push(leg);
    const arm = new THREE.Group(); arm.position.set(x * 2, 2.7, 0); body.add(arm);
    arm.name = `arm-${side}`;
    mesh(arm, loft([[0.1, 0.23, 0.26], [-0.1, 0.33, 0.34], [-0.44, 0.27, 0.29]], 10), shirt, origin);
    const elbow = new THREE.Group(); elbow.position.y = -0.5; arm.add(elbow); elbows.push(elbow);
    mesh(elbow, loft([[0.06, 0.17, 0.17], [-0.25, 0.15, 0.15]], 8), color, origin);
    const fist = mesh(elbow, loft([[0.17, 0.15, 0.17], [0.06, 0.25, 0.23], [-0.18, 0.23, 0.23], [-0.24, 0.12, 0.15]], 8),
      color, [0, -0.27, 0]);
    fist.name = `village-${side}-fist`; limbs.push(arm);
  }
  // One neck-to-hem garment, including its back. No shirt sphere pokes through a separate skirt.
  const clothing = mesh(body, loft(girl
    ? [[3.12, 0.4, 0.36], [2.96, 0.74, 0.47], [2.7, 0.88, 0.54], [2.1, 0.66, 0.45],
      [1.15, 1.04, 0.67], [1.06, 1.04, 0.67]]
    : tanuki
      ? [[3.2, 0.55, 0.42], [2.95, 1.04, 0.7], [2.1, 1.3, 0.86], [1.24, 1.15, 0.74]]
      : [[3.12, 0.4, 0.36], [2.96, 0.74, 0.47], [2.7, 0.94, 0.57], [1.62, 0.86, 0.57], [1.54, 0.85, 0.56]]),
    '#ffffff', origin);
  clothing.name = girl ? 'village-dress' : 'village-shirt';
  clothing.material.map = clothTexture(shirt, girl || species === 'rabbit' ? 'flower' : species === 'bear' ? 'cardigan' : species === 'cat' ? 'stripe' : 'plaid');
  if (!girl && !tanuki)
    mesh(body, loft([[1.65, 0.78, 0.49], [1.32, 0.75, 0.47], [1.15, 0.65, 0.4]], 16),
      human ? '#4b5960' : color, origin).name = 'village-hips';
  if (tanuki) {
    const denim = '#648aa3';
    ball(body, denim, [0, 1.65, 0], [1.3, 0.85, 0.9]);
    box(body, denim, [0, 2.35, -0.83], [1.36, 1.22, 0.18]).name = 'overall-bib';
    for (const x of [-0.52, 0.52]) {
      box(body, denim, [x, 2.94, -0.67], [0.24, 0.82, 0.2]).rotation.x = -0.3;
      ball(body, '#d6ba69', [x, 2.74, -0.96], [0.1, 0.1, 0.04]);
      box(body, '#f1e6cc', [x * 0.4, 2.46, -0.97], [0.21, 0.47, 0.035]).rotation.z = x * 0.35;
    }
    box(body, '#52778d', [0, 2.13, -0.99], [0.73, 0.47, 0.08]).name = 'receipt-pocket';
    const tail = new THREE.Group(); tail.name = 'ring-tail'; tail.position.set(0, 1.65, 0.65);
    tail.rotation.x = Math.PI / 3; body.add(tail);
    const fur = mesh(tail, loft([[1.8, 0.17, 0.17], [1.62, 0.34, 0.34], [0.4, 0.46, 0.46], [0, 0.36, 0.36]], 12), '#ffffff', origin);
    fur.material.map = clothTexture(color, 'rings');
  }
  const head = new THREE.Group(); body.add(head);
  head.name = 'village-head';
  ball(head, color, [0, 4.08, 0], [1.4, 1.36, 1.19]).name = 'village-skull';
  if (human) {
    for (const x of girl ? [] : [-1.31, 1.31])
      mesh(head, new THREE.SphereGeometry(1, 8, 6), color, [x, 4.04, 0], [0.21, 0.29, 0.22]);
    mesh(head, hairGeometry(girl), girl ? '#84482d' : '#65462e', origin).name = 'village-hair';
  } else for (const x of [-1, 1]) {
    if (species === 'cat') {
      mesh(head, new THREE.ConeGeometry(0.63, 1.3, 3), color, [x, 5.26, 0]);
      mesh(head, new THREE.ConeGeometry(0.3, 0.65, 3), '#dea39c', [x, 5.3, -0.24]);
    } else {
      const rabbit = species === 'rabbit';
      ball(head, color, [x * 0.9, rabbit ? 5.65 : 5.05, 0], [rabbit ? 0.44 : 0.65, rabbit ? 1.2 : 0.65, 0.39]);
      ball(head, '#dfa59e', [x * 0.9, rabbit ? 5.7 : 5.05, -0.32], [0.26, rabbit ? 0.8 : 0.39, 0.1]);
    }
  }
  if (!human && !tanuki) {
    const tail = species === 'cat'
      ? mesh(body, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 1.8, 0.5), new THREE.Vector3(0.65, 1.9, 1.1), new THREE.Vector3(0.85, 2.7, 1.15),
      ]), 12, 0.2, 8, false), color, origin)
      : ball(body, color, [0, 1.9, 0.9], [0.36, 0.38, 0.38]);
    tail.name = 'village-tail';
  }
  if (tanuki) {
    for (const x of [-0.58, 0.58])
      mesh(head, faceEllipse(x, 4.18, 0.64, 0.59, 0.025), '#634838', origin).name = 'raccoon-mask';
    mesh(head, faceEllipse(0, 3.66, 0.76, 0.41, 0.045), '#edd5ad', origin).name = 'light-muzzle';
  } else if (species === 'bear') {
    mesh(head, faceEllipse(0, 3.7, 0.55, 0.29, 0.045), '#e8c695', origin).name = 'light-muzzle';
  } else if (species === 'cat' || species === 'rabbit') {
    for (const x of [-0.18, 0.18])
      mesh(head, faceEllipse(x, 3.7, 0.25, 0.19, 0.04), '#f5e5c2', origin).name = 'light-muzzle';
  }
  for (const x of [-0.55, 0.55]) {
    const eye = new THREE.Group(); eye.name = 'village-eye'; head.add(eye); eyes.push(eye);
    const painted = mesh(eye, eyeSurface(x, 4.15), '#ffffff', origin);
    painted.material.map = eyeTexture(species, girl);
    painted.material.transparent = true; painted.material.depthWrite = false;
    const lid = mesh(head, faceStroke([[x - 0.25, 4.14], [x, 4.07], [x + 0.25, 4.14]], 0.035, 0.09), ink, origin);
    lid.name = `sleep-eye-${x < 0 ? 'left' : 'right'}`; lid.visible = false; lids.push(lid);
    mesh(head, faceEllipse(x * 1.65, 3.78, 0.22, 0.1, 0.025), '#d99678', origin);
  }
  const nose = species === 'bear'
    ? ball(head, '#684936', [0, 3.92, -1.23], [0.19, 0.12, 0.12])
    : tanuki ? ball(head, '#372e2b', [0, 3.94, -1.25], [0.26, 0.17, 0.15])
      : mesh(head, noseGeometry(species), human ? '#e27b35' : species === 'cat' ? '#ae716a' : '#c28592', origin);
  nose.name = 'village-nose';
  const splitMouth = species === 'cat' || species === 'rabbit';
  mesh(head, faceStroke(splitMouth
    ? [[-0.25, 3.63], [-0.12, 3.59], [0, 3.68], [0.12, 3.59], [0.25, 3.63]]
    : [[-0.25, 3.62], [0, 3.51], [0.25, 3.62]], 0.026, 0.065), ink, origin).name = 'village-smile';
  if (splitMouth)
    mesh(head, faceStroke([[0, 3.85], [0, 3.68]], 0.02, 0.065), ink, origin);
  if (species === 'cat') for (const x of [-1, 1]) for (const y of [3.78, 3.91])
    mesh(head, faceStroke([[x * 0.78, y], [x * 1.12, y + 0.045]], 0.013, 0.025), '#8c694a', origin);
  root.name = `village-${species}`;
  root.userData.persona = persona === 'girl' ? 'girl' : 'boy';
  const leap = createLeapAnimation(body, limbs);
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const kickPose = strikePose(), punchPose = new THREE.Quaternion();
  const punchGuard = new THREE.Quaternion().setFromEuler(new THREE.Euler(2.2, 0, 0.6));
  const punchHit = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.8, 0, 0.6));
  let lastTime = 0, phase = 0, lean = 0, toolTime = Infinity, wasUsing = false;
  return { root, hand: limbs[3], reset: () => leap.reset(),
    animate(time, walking = 0, talking = false, carrying = false, sprintRush = 0, punch = 0, tool = false, using = false, motion = null, kick = 0, pose = null) {
    const dt = Math.max(0, Math.min(0.1, time - lastTime)); lastTime = time;
    body.position.z = body.rotation.y = 0;
    limbs.forEach(l => { l.rotation.y = l.rotation.z = l.position.z = 0; });
    elbows.forEach(e => { e.rotation.x = 0; e.parent.position.y = 2.7; });
    if (pose) leap.reset();
    const posing = leap.update(dt, pose ? null : motion, reducedMotion?.matches);
    // Animal Crossing speed-cheat silhouette: pitch forward and scramble, without a phase jump.
    lean += (0.55 * sprintRush - lean) * (1 - Math.exp(-8 * dt));
    phase += (7 + 9 * sprintRush) * dt;
    const gait = Math.sin(phase) * Math.min(0.65, walking * 0.2);
    if (!posing) {
      limbs.forEach((l, i) => { l.rotation.x = gait * (i < 2 ? 1 : -1) * (i % 2 ? -1 : 1); });
      body.position.y = Math.sin(time * (talking ? 12 : 2)) * (talking ? 0.08 : 0.035);
      body.rotation.x = -lean;
    }
    const working = tool && using && !carrying;
    if (!tool || carrying) toolTime = Infinity;
    else if (working && (!wasUsing || toolTime >= 0.38)) toolTime = 0;
    wasUsing = working;
    toolTime += dt;
    if (tool && !carrying) limbs[3].rotation.x = 0.9;
    body.rotation.z = talking ? Math.sin(time * 9) * 0.025 : 0;
    if (tool && !carrying && toolTime < 0.38) {
      // Minecraft's overhead mining stroke: lift high, chop fast, recover even after a tap.
      const t = toolTime / 0.38, raise = ease(t / 0.4), chop = ease((t - 0.4) / 0.18);
      const recover = ease((t - 0.65) / 0.35), weight = reducedMotion?.matches ? 0.25 : 1;
      limbs[3].rotation.x = 0.9 + (1.9 * raise - 2.65 * chop + 0.75 * recover) * weight;
      limbs[3].rotation.z = -0.35 * raise * (1 - recover) * weight;
      limbs[1].rotation.x += 0.6 * chop * (1 - recover) * weight;
      body.rotation.y = (-0.3 * raise + 0.55 * chop) * (1 - recover) * weight;
      body.rotation.x += -0.2 * chop * (1 - recover) * weight;
    }
    if (punch > 0 && !carrying) {
      // Halo-like quick melee; readable guard/contact/recovery poses (jasondeheras.com/gamedesign/powerfulcombo).
      const t = 1 - punch, guard = ease(t / 0.18) * (1 - ease((t - 0.88) / 0.12));
      const jab = ease((t - 0.3) / 0.1) * (1 - ease((t - 0.62) / 0.16));
      const follow = ease((t - 0.4) / 0.12) * (1 - ease((t - 0.68) / 0.2));
      const weight = reducedMotion?.matches ? 0.25 : 1;
      punchPose.copy(punchGuard).slerp(punchHit, jab);
      limbs[3].quaternion.slerp(punchPose, guard);
      elbows[1].rotation.x = 0.7 * guard * (1 - jab);
      limbs[3].position.y += (0.3 + 0.3 * jab) * guard;
      limbs[3].position.z = (-0.7 - 1.45 * jab) * guard;
      limbs[1].rotation.x += (2.1 - limbs[1].rotation.x) * guard;
      limbs[1].rotation.z = -0.6 * guard;
      elbows[0].rotation.x = 0.85 * guard;
      limbs[1].position.y += 0.3 * guard;
      limbs[1].position.z = -0.7 * guard;
      body.rotation.y = 0.18 * follow * weight;
      if (!posing) {
        // The fist leads; suppress sprint's forward lean rather than bowing into the punch.
        body.rotation.x *= 1 - guard;
        body.position.z = -0.1 * follow * weight;
        limbs[0].rotation.x += 0.18 * follow * weight;
        limbs[2].rotation.x -= 0.12 * follow * weight;
      }
    }
    if (carrying) limbs.forEach((l, i) => { if (i % 2) l.rotation.x = 1.3; });
    const sitting = pose?.kind === 'sit', sleeping = pose?.kind === 'sleep';
    const gripping = pose?.kind === 'grip', dresser = pose?.kind === 'dresser';
    const effort = pose?.effort ?? 0, reach = pose?.reach ?? 0, pull = pose?.pull ?? 0;
    knees.forEach(k => { k.rotation.x = sitting ? -Math.PI / 2 : gripping && pose.low ? -1.2 * reach : 0; });
    if (pose) elbows.forEach(e => { e.rotation.x = dresser ? -0.8 * pull : gripping ? -0.2 : 0; });
    eyes.forEach(e => { e.visible = !sleeping; });
    lids.forEach(e => { e.visible = sleeping; });
    head.position.z = sleeping ? -0.8 : 0;
    if (pose) body.position.z = dresser ? 0.3 * pull : 0;
    if (sitting || sleeping) {
      limbs.forEach((l, i) => { l.rotation.x = i % 2 ? -0.15 : sitting ? Math.PI / 2 : 0; });
      body.rotation.x = sleeping ? Math.PI / 2 : -0.06;
      body.position.y = reducedMotion?.matches ? 0 : Math.sin(time * 2) * (sleeping ? 0.025 : 0.015);
    } else if (gripping || dresser) {
      // Animal Crossing's reach-in, then forward push versus backward yank.
      const strain = reducedMotion?.matches ? 0 : effort;
      limbs.forEach((l, i) => {
        if (i % 2) l.rotation.x = dresser ? 1.35 * reach - 0.45 * pull : (1.2 + 0.08 * strain) * reach;
        else if (gripping && pose.low) l.rotation.x += 0.75 * reach;
      });
      body.rotation.x = dresser ? -0.1 * reach : (-0.18 + (pose.pulling ? 0.3 : -0.12) * strain) * reach;
      if (gripping) body.position.y = pose.low ? -0.2 * reach : 0;
    }
    // A chicken wingbeat. Positive x is the raised arm (the punch above); both arms, not the tool hand only.
    const flap = pose ? 0 : motion?.flap ?? 0;
    if (flap > 0 && !(punch > 0 && !carrying)) {
      limbs[1].rotation.x = 2.4 * flap; limbs[3].rotation.x = 2.4 * flap;
      limbs[1].rotation.z = 1.1 * flap; limbs[3].rotation.z = -1.1 * flap;
    }
    if (kick > 0 && !carrying && !pose) {
      sampleKickPose(1 - kick, kickPose);
      limbs[2].quaternion.slerp(kickPose.hip, kickBlend(1 - kick));
      knees[1].quaternion.slerp(kickPose.knee, kickBlend(1 - kick));
      if (!reducedMotion?.matches) body.quaternion.multiply(kickPose.torso);
    }
  } };
}
export function nameplate(text) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f6edd2'; ctx.beginPath(); ctx.roundRect(4, 4, 504, 120, 30); ctx.fill();
  ctx.fillStyle = '#4c644b'; ctx.font = 'bold 48px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }));
  sign.rotation.y = Math.PI; sign.renderOrder = 1;
  return sign;
}
export function speechBubble(name, text) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff9e6'; ctx.beginPath(); ctx.roundRect(8, 8, 496, 152, 38); ctx.fill();
  ctx.beginPath(); ctx.moveTo(232, 155); ctx.lineTo(256, 187); ctx.lineTo(280, 155); ctx.fill();
  ctx.textAlign = 'center'; ctx.fillStyle = '#26786b'; ctx.font = 'bold 32px sans-serif'; ctx.fillText(name, 256, 56);
  ctx.fillStyle = '#625440'; ctx.font = 'bold 44px sans-serif'; ctx.fillText(text, 256, 121);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const bubble = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.625),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  bubble.name = 'village-speech-bubble'; bubble.position.y = 8;
  bubble.renderOrder = 2; bubble.visible = false;
  return bubble;
}
export function dispose(root) {
  root.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  root.removeFromParent();
}
