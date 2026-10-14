import * as THREE from 'three';
export { furniture } from './furnitureModels.js';
import { createLeapAnimation } from './leap.js';

// Original toy-like silhouettes; baked soft directional shading works with the
// voxel renderer's unlit scene and its shared rolling-log mesh transform.
function mesh(parent, geometry, color, at, scale = [1, 1, 1]) {
  const c = new THREE.Color(color), n = geometry.attributes.normal, colors = [];
  const light = new THREE.Vector3(-0.4, 0.8, -0.5).normalize();
  for (let i = 0; i < n.count; i++) {
    const k = 0.72 + 0.28 * Math.max(0, n.getX(i) * light.x + n.getY(i) * light.y + n.getZ(i) * light.z);
    colors.push(c.r * k, c.g * k, c.b * k);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.position.set(...at); m.scale.set(...scale); m.renderOrder = 1; parent.add(m);
  return m;
}
const ball = (p, color, at, scale) => mesh(p, new THREE.SphereGeometry(1, 16, 12), color, at, scale);
const box = (p, color, at, scale) => mesh(p, new THREE.BoxGeometry(1, 1, 1), color, at, scale);
const cylinder = (p, color, at, r1, r2, height) => mesh(p, new THREE.CylinderGeometry(r1, r2, height, 20), color, at);
const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export function character({ species = 'human', persona = 'boy', color = '#edbd96', shirt = persona === 'girl' ? '#d87598' : '#5c9a93' } = {}) {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  body.name = 'village-body';
  const limbs = [], knees = [], elbows = [], eyes = [], lids = [];
  for (const x of [-0.55, 0.55]) {
    const side = x < 0 ? 'left' : 'right';
    const leg = new THREE.Group(); leg.position.set(x, 1.25, 0); body.add(leg);
    leg.name = `leg-${side}`;
    ball(leg, '#665a51', [0, -0.26, 0], [0.36, 0.38, 0.36]);
    const knee = new THREE.Group(); knee.name = `knee-${side}`; knee.position.y = -0.55; leg.add(knee); knees.push(knee);
    ball(knee, '#665a51', [0, -0.17, 0], [0.33, 0.32, 0.33]);
    ball(knee, '#f6ecd0', [0, -0.4, -0.2], [0.43, 0.27, 0.63]); limbs.push(leg);
    const arm = new THREE.Group(); arm.position.set(x * 2, 2.7, 0); body.add(arm);
    arm.name = `arm-${side}`;
    ball(arm, shirt, [0, -0.2, 0], [0.43, 0.4, 0.43]);
    const elbow = new THREE.Group(); elbow.position.y = -0.5; arm.add(elbow); elbows.push(elbow);
    const fist = ball(elbow, color, [0, -0.27, 0], [0.32, 0.4, 0.33]);
    fist.name = `village-${side}-fist`; limbs.push(arm);
  }
  ball(body, shirt, [0, 2.15, 0], [1.05, 1.12, 0.65]);
  box(body, '#f5e8c3', [0, 2.2, -0.64], [1.75, 0.24, 0.12]);
  const head = new THREE.Group(); body.add(head);
  ball(head, color, [0, 4.08, 0], [1.4, 1.36, 1.19]);
  if (species === 'human') {
    ball(head, '#76513a', [0, 4.78, 0.14], [1.43, 0.85, 1.18]);
    for (const [x, y] of [[-0.95, 4.75], [-0.45, 4.9], [0.12, 5], [0.8, 4.86]])
      ball(head, '#76513a', [x, y, -0.92], [0.47, 0.5, 0.36]);
    if (persona === 'girl') {
      // Animal Crossing's round pigtails and flared dress, on the same animated rig.
      for (const x of [-1.35, 1.35]) {
        ball(head, '#76513a', [x, 4.15, 0.28], [0.55, 0.85, 0.55]);
        ball(head, '#f4ce87', [x, 4.65, 0.04], [0.25, 0.19, 0.23]);
      }
      cylinder(body, shirt, [0, 1.48, 0], 0.72, 1.1, 0.85);
    }
  } else for (const x of [-1, 1]) {
    if (species === 'cat') {
      mesh(head, new THREE.ConeGeometry(0.63, 1.3, 3), color, [x, 5.26, 0]);
      mesh(head, new THREE.ConeGeometry(0.3, 0.65, 3), '#dea39c', [x, 5.3, -0.24]);
    } else {
      const rabbit = species === 'rabbit';
      ball(head, color, [x * 0.9, rabbit ? 5.65 : 5.05, 0], [rabbit ? 0.44 : 0.65, rabbit ? 1.2 : 0.65, 0.39]);
      ball(head, '#dfa59e', [x * 0.9, rabbit ? 5.7 : 5.05, -0.32], [0.26, rabbit ? 0.8 : 0.39, 0.1]);
    }
    ball(body, color, [0.1, 1.9, 0.87], species === 'cat' ? [0.3, 0.85, 0.35] : [0.45, 0.45, 0.45]);
  }
  for (const x of [-0.55, 0.55]) {
    eyes.push(ball(head, '#fff9e9', [x, 4.13, -1.02], [0.36, 0.49, 0.15]),
      ball(head, '#302d29', [x, 4.12, -1.15], [0.2, 0.32, 0.075]),
      ball(head, '#ffffff', [x - 0.06, 4.25, -1.21], [0.065, 0.09, 0.025]));
    const lid = ball(head, '#674b3e', [x, 4.12, -1.18], [0.27, 0.04, 0.07]);
    lid.name = `sleep-eye-${x < 0 ? 'left' : 'right'}`; lid.visible = false; lids.push(lid);
    ball(head, '#db927e', [x * 1.65, 3.72, -0.94], [0.26, 0.13, 0.055]);
  }
  ball(head, species === 'human' ? '#d99e76' : '#77534b', [0, 3.83, -1.18], [0.21, 0.16, 0.23]);
  const smile = mesh(head, new THREE.TorusGeometry(0.23, 0.035, 6, 14, Math.PI), '#674b3e', [0, 3.51, -1.13]);
  smile.rotation.z = Math.PI;
  root.name = `village-${species}`;
  root.userData.persona = persona === 'girl' ? 'girl' : 'boy';
  const leap = createLeapAnimation(body, limbs);
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
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
    if (kick > 0 && !carrying) limbs[2].rotation.x = Math.sin(kick * Math.PI) * 1.7;
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
      limbs[3].rotation.x += ((2.2 - 0.4 * jab) - limbs[3].rotation.x) * guard;
      limbs[3].rotation.z = 0.6 * guard;
      elbows[1].rotation.x = 0.7 * guard * (1 - jab);
      limbs[3].position.y += (0.3 + 0.3 * jab) * guard;
      limbs[3].position.z = (-0.7 - 0.85 * jab) * guard;
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
