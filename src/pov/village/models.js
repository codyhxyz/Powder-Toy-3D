import * as THREE from 'three';
import { ITEMS } from './state.js';
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
  const limbs = [];
  for (const x of [-0.55, 0.55]) {
    const leg = new THREE.Group(); leg.position.set(x, 1.25, 0); body.add(leg);
    ball(leg, '#665a51', [0, -0.32, 0], [0.36, 0.65, 0.36]);
    ball(leg, '#f6ecd0', [0, -0.95, -0.2], [0.43, 0.27, 0.63]); limbs.push(leg);
    const arm = new THREE.Group(); arm.position.set(x * 2, 2.7, 0); body.add(arm);
    ball(arm, shirt, [0, -0.15, 0], [0.43, 0.55, 0.43]);
    ball(arm, color, [0, -0.77, 0], [0.32, 0.4, 0.33]); limbs.push(arm);
  }
  ball(body, shirt, [0, 2.15, 0], [1.05, 1.12, 0.65]);
  box(body, '#f5e8c3', [0, 2.2, -0.64], [1.75, 0.24, 0.12]);
  ball(body, color, [0, 4.08, 0], [1.4, 1.36, 1.19]);
  if (species === 'human') {
    ball(body, '#76513a', [0, 4.78, 0.14], [1.43, 0.85, 1.18]);
    for (const [x, y] of [[-0.95, 4.75], [-0.45, 4.9], [0.12, 5], [0.8, 4.86]])
      ball(body, '#76513a', [x, y, -0.92], [0.47, 0.5, 0.36]);
    if (persona === 'girl') {
      // Animal Crossing's round pigtails and flared dress, on the same animated rig.
      for (const x of [-1.35, 1.35]) {
        ball(body, '#76513a', [x, 4.15, 0.28], [0.55, 0.85, 0.55]);
        ball(body, '#f4ce87', [x, 4.65, 0.04], [0.25, 0.19, 0.23]);
      }
      cylinder(body, shirt, [0, 1.48, 0], 0.72, 1.1, 0.85);
    }
  } else for (const x of [-1, 1]) {
    if (species === 'cat') {
      mesh(body, new THREE.ConeGeometry(0.63, 1.3, 3), color, [x, 5.26, 0]);
      mesh(body, new THREE.ConeGeometry(0.3, 0.65, 3), '#dea39c', [x, 5.3, -0.24]);
    } else {
      const rabbit = species === 'rabbit';
      ball(body, color, [x * 0.9, rabbit ? 5.65 : 5.05, 0], [rabbit ? 0.44 : 0.65, rabbit ? 1.2 : 0.65, 0.39]);
      ball(body, '#dfa59e', [x * 0.9, rabbit ? 5.7 : 5.05, -0.32], [0.26, rabbit ? 0.8 : 0.39, 0.1]);
    }
    ball(body, color, [0.1, 1.9, 0.87], species === 'cat' ? [0.3, 0.85, 0.35] : [0.45, 0.45, 0.45]);
  }
  for (const x of [-0.55, 0.55]) {
    ball(body, '#fff9e9', [x, 4.13, -1.02], [0.36, 0.49, 0.15]);
    ball(body, '#302d29', [x, 4.12, -1.15], [0.2, 0.32, 0.075]);
    ball(body, '#ffffff', [x - 0.06, 4.25, -1.21], [0.065, 0.09, 0.025]);
    ball(body, '#db927e', [x * 1.65, 3.72, -0.94], [0.26, 0.13, 0.055]);
  }
  ball(body, species === 'human' ? '#d99e76' : '#77534b', [0, 3.83, -1.18], [0.21, 0.16, 0.23]);
  const smile = mesh(body, new THREE.TorusGeometry(0.23, 0.035, 6, 14, Math.PI), '#674b3e', [0, 3.51, -1.13]);
  smile.rotation.z = Math.PI;
  root.name = `village-${species}`;
  root.userData.persona = persona === 'girl' ? 'girl' : 'boy';
  const leap = createLeapAnimation(body, limbs);
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let lastTime = 0, phase = 0, lean = 0, toolTime = Infinity, wasUsing = false;
  return { root, hand: limbs[3], reset: () => leap.reset(),
    animate(time, walking = 0, talking = false, carrying = false, sprintRush = 0, punch = 0, tool = false, using = false, motion = null, kick = 0) {
    const dt = Math.max(0, Math.min(0.1, time - lastTime)); lastTime = time;
    body.position.z = body.rotation.y = 0;
    limbs.forEach(l => { l.rotation.y = l.rotation.z = l.position.z = 0; });
    const posing = leap.update(dt, motion, reducedMotion?.matches);
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
      // Halo-style melee: coil, snap through the target, hold contact, then recover.
      const t = 1 - punch, snap = ease((t - 0.2) / 0.2);
      const wind = ease(t / 0.2) * (1 - snap), hit = snap * (1 - ease((t - 0.5) / 0.5));
      const weight = reducedMotion?.matches ? 0.25 : 1;
      limbs[3].rotation.x = -0.65 * wind + 1.65 * hit;
      limbs[3].rotation.z = (-0.45 * wind - 0.25 * hit) * weight;
      limbs[3].position.z = (0.3 * wind - 0.8 * hit) * weight;
      limbs[1].rotation.x += 0.95 * hit * weight;
      limbs[1].rotation.z = 0.25 * hit * weight;
      body.rotation.y = (-0.45 * wind + 0.55 * hit) * weight;
      body.rotation.x += (0.08 * wind - 0.24 * hit) * weight;
      body.rotation.z += -0.1 * hit * weight;
      if (!posing) {
        body.position.y -= 0.16 * wind * weight;
        body.position.z = -0.45 * hit * weight;
        limbs[0].rotation.x += 0.45 * hit * weight;
        limbs[2].rotation.x -= 0.35 * hit * weight;
      }
    }
    if (carrying) limbs.forEach((l, i) => { if (i % 2) l.rotation.x = 1.3; });
  } };
}
export function furniture(kind) {
  const root = new THREE.Group(), c = ITEMS[kind].color, wood = '#b98452';
  const legs = (w, d, height) => {
    for (const x of [-w / 2 + 0.3, w / 2 - 0.3]) for (const z of [-d / 2 + 0.3, d / 2 - 0.3])
      box(root, wood, [x, height / 2, z], [0.35, height, 0.35]);
  };
  if (kind === 'bed') {
    legs(4, 6, 1); box(root, wood, [0, 0.85, 0], [4, 0.5, 6]);
    box(root, '#fbecd0', [0, 1.35, 0], [3.8, 0.55, 5.8]);
    box(root, c, [0, 1.66, -0.7], [3.85, 0.16, 4.1]);
    for (const x of [-0.95, 0.95]) box(root, '#f2da9e', [x, 1.76, -0.7], [0.25, 0.06, 4.1]);
    ball(root, '#fff7df', [0, 1.85, 1.8], [1.5, 0.33, 0.65]);
    box(root, wood, [0, 1.75, 2.8], [4, 2.2, 0.4]);
  } else if (kind === 'table') {
    cylinder(root, c, [0, 2.25, 0], 2, 2, 0.45);
    cylinder(root, wood, [0, 1.1, 0], 0.3, 0.5, 2.2);
    cylinder(root, wood, [0, 0.15, 0], 1.2, 1.2, 0.3);
    cylinder(root, '#f6edd2', [0, 2.53, 0], 0.55, 0.55, 0.12);
    cylinder(root, '#6b9f90', [0, 2.8, 0], 0.22, 0.18, 0.48);
  } else if (kind === 'chair') {
    legs(2, 2, 1.3); box(root, c, [0, 1.4, 0], [2, 0.35, 2]);
    box(root, c, [0, 2.4, 0.75], [2, 2, 0.35]);
    box(root, '#e7ce97', [0, 1.66, -0.1], [1.8, 0.18, 1.55]);
  } else if (kind === 'sofa') {
    legs(6, 3, 0.6); box(root, c, [0, 1, 0], [6, 1.3, 3]);
    box(root, c, [0, 2.1, 1.1], [6, 2, 0.8]);
    for (const x of [-2.6, 2.6]) ball(root, c, [x, 1.8, 0], [0.43, 0.75, 1.5]);
    for (const x of [-1.35, 1.35]) box(root, '#a3c2a8', [x, 1.75, -0.25], [2.4, 0.35, 2.1]);
  } else if (kind === 'lamp') {
    cylinder(root, wood, [0, 0.15, 0], 0.85, 0.9, 0.3);
    cylinder(root, wood, [0, 2, 0], 0.12, 0.12, 3.8);
    cylinder(root, c, [0, 3.6, 0], 0.6, 1, 1.2);
    ball(root, '#fff0b3', [0, 3.2, 0], [0.3, 0.3, 0.3]);
  } else if (kind === 'plant') {
    cylinder(root, '#c98763', [0, 0.65, 0], 0.8, 0.55, 1.3);
    cylinder(root, '#695743', [0, 1.32, 0], 0.7, 0.7, 0.08);
    cylinder(root, '#628258', [0, 2, 0], 0.1, 0.1, 1.6);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const leaf = ball(root, i % 2 ? '#88aa69' : c, [Math.cos(a) * 0.45, 2 + i * 0.14, Math.sin(a) * 0.45], [0.4, 0.8, 0.18]);
      leaf.rotation.set(0.4, -a, 0.6);
    }
  } else if (kind === 'dresser') {
    legs(4, 3, 0.45); box(root, c, [0, 1.8, 0], [4, 3.2, 3]);
    box(root, '#deb583', [0, 3.5, 0], [4.15, 0.25, 3.15]);
    for (const y of [0.8, 1.8, 2.8]) {
      box(root, '#d7ab76', [0, y, -1.55], [3.65, 0.8, 0.16]);
      for (const x of [-0.9, 0.9]) ball(root, '#79573d', [x, y, -1.73], [0.12, 0.12, 0.12]);
    }
  }
  return root;
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
