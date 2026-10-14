import * as THREE from 'three';
export { furniture } from './furnitureModels.js';
import { createLeapAnimation } from './leap.js';

// Original toy-like silhouettes; baked soft directional shading works with the
// voxel renderer's unlit scene and its shared rolling-log mesh transform.
function mesh(parent, geometry, color, at, scale = [1, 1, 1]) {
  const c = new THREE.Color(color), n = geometry.attributes.normal, colors = [];
  const light = new THREE.Vector3(-0.4, 0.8, -0.5).normalize();
  for (let i = 0; i < n.count; i++) {
    const k = 0.62 + 0.38 * Math.max(0, n.getX(i) * light.x + n.getY(i) * light.y + n.getZ(i) * light.z);
    colors.push(c.r * k, c.g * k, c.b * k);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.position.set(...at); m.scale.set(...scale); m.renderOrder = 1; parent.add(m);
  return m;
}
const ball = (p, color, at, scale) => mesh(p, new THREE.SphereGeometry(1, 24, 16), color, at, scale);
const box = (p, color, at, scale) => mesh(p, new THREE.BoxGeometry(1, 1, 1), color, at, scale);
const cylinder = (p, color, at, r1, r2, height) => mesh(p, new THREE.CylinderGeometry(r1, r2, height, 20), color, at);
const line = (p, color, points, radius = 0.035) => mesh(p,
  new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(...v))), 18, radius, 6, false),
  color, [0, 0, 0]);
// Surface-following fabric, not floating boxes: longitude zero faces forward (-Z).
const panel = (p, color, at, scale, u0, u1, v0, v1) => mesh(p,
  new THREE.SphereGeometry(1, 24, 8, Math.PI * 1.5 - u1, u1 - u0, Math.PI / 2 - v1, v1 - v0),
  color, at, scale);
function collar(p, color, y, radius, tube = 0.07) {
  const m = mesh(p, new THREE.TorusGeometry(radius, tube, 8, 32), color, [0, y, 0]);
  m.rotation.x = Math.PI / 2; m.scale.y = 0.7; return m;
}
const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export function character({ species = 'human', persona = 'boy', color = '#edbd96', shirt = persona === 'girl' ? '#d87598' : '#5c9a93' } = {}) {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  body.name = 'village-body';
  const limbs = [], knees = [], elbows = [], eyes = [], lids = [];
  const human = species === 'human', tanuki = species === 'tanuki', girl = persona === 'girl';
  const cream = '#fff0cf', ink = '#48382f', furLight = human ? color : '#f7dfb4';
  const trousers = human ? '#384f64' : tanuki ? '#694d3b' : color;
  for (const x of [-0.55, 0.55]) {
    const side = x < 0 ? 'left' : 'right';
    const leg = new THREE.Group(); leg.position.set(x, 1.25, 0); body.add(leg);
    leg.name = `leg-${side}`;
    ball(leg, trousers, [0, -0.26, 0], [0.34, 0.38, 0.34]);
    const knee = new THREE.Group(); knee.name = `knee-${side}`; knee.position.y = -0.55; leg.add(knee); knees.push(knee);
    ball(knee, human ? cream : color, [0, -0.17, 0], [0.3, 0.32, 0.3]);
    ball(knee, human ? '#dac9a5' : '#a67d57', [0, -0.49, -0.2], [0.42, 0.15, 0.61]);
    ball(knee, human ? girl ? '#a45157' : '#82583f' : furLight, [0, -0.38, -0.22], [0.42, 0.25, 0.6]);
    if (human) {
      for (const z of [-0.18, -0.34])
        line(knee, cream, [[-0.18, -0.14, z], [0, -0.105, z - 0.03], [0.18, -0.14, z]], 0.025);
    }
    limbs.push(leg);
    const arm = new THREE.Group(); arm.position.set(x * 2, 2.7, 0); body.add(arm);
    arm.name = `arm-${side}`;
    ball(arm, shirt, [0, -0.2, 0], [0.43, 0.4, 0.43]);
    ball(arm, human || species === 'bear' ? cream : shirt, [0, -0.44, 0], [0.34, 0.11, 0.34]);
    const elbow = new THREE.Group(); elbow.position.y = -0.5; arm.add(elbow); elbows.push(elbow);
    const fist = ball(elbow, color, [0, -0.27, 0], [0.32, 0.4, 0.33]);
    fist.name = `village-${side}-fist`; limbs.push(arm);
    ball(elbow, color, [x < 0 ? 0.23 : -0.23, -0.22, -0.18], [0.14, 0.18, 0.16]);
  }
  const torso = tanuki ? [1.32, 1.23, 0.88] : [1.05, 1.12, 0.65];
  ball(body, shirt, [0, 2.15, 0], torso);
  if (!tanuki) {
    collar(body, cream, 3.12, 0.49);
    if ((human && !girl) || species === 'cat') {
      for (const y of [-0.35, -0.02, 0.31])
        panel(body, species === 'cat' ? '#e5e6ce' : '#e5c981', [0, 2.15, 0], [1.064, 1.134, 0.664],
          -Math.PI, Math.PI, y, y + 0.095);
      panel(body, species === 'cat' ? '#416f81' : '#447b77', [0, 2.15, 0], [1.068, 1.138, 0.668],
        -Math.PI, Math.PI, -0.91, -0.7);
    } else if (species === 'bear') {
      panel(body, cream, [0, 2.15, 0], [1.067, 1.137, 0.667], -0.22, 0.22, -0.65, 1.05).name = 'cardigan-placket';
      for (const y of [1.85, 2.2, 2.55])
        ball(body, '#a16c3c', [0, y, -0.69 * Math.sqrt(1 - ((y - 2.15) / 1.14) ** 2)], [0.062, 0.062, 0.035]);
      for (const x of [-0.59, 0.59]) {
        line(body, '#f1b194', [[x - 0.17, 2.03, -0.52], [x, 1.94, -0.57], [x + 0.17, 2.03, -0.52]], 0.035);
      }
    }
    if ((human && girl) || species === 'rabbit') {
      // Animal Crossing's bell-shaped dresses keep the big head / small body silhouette.
      const skirt = cylinder(body, shirt, [0, 1.46, 0], 0.86, 1.13, 0.92);
      skirt.name = 'dress-skirt';
      collar(body, cream, 1.04, 1.1, 0.045).scale.y = 1;
      // An embroidered flower: a readable motif even at the gameplay camera distance.
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5;
        ball(body, cream, [0.27 + Math.sin(a) * 0.13, 2.52 + Math.cos(a) * 0.13, -0.643], [0.09, 0.09, 0.025]);
      }
      ball(body, '#e9b54f', [0.27, 2.52, -0.675], [0.065, 0.065, 0.025]);
      panel(body, '#e4d8ad', [0, 2.15, 0], [1.064, 1.134, 0.664], -Math.PI, Math.PI, -0.49, -0.38);
    }
    if (species === 'cat') {
      for (const x of [-1, 1])
        ball(body, '#e4ad66', [x * 0.18, 3.01, -0.4], [0.22, 0.15, 0.08]).rotation.z = x * 0.4;
      ball(body, '#b97a42', [0, 2.99, -0.48], [0.095, 0.095, 0.05]);
    }
  }
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
    line(body, '#b5c4b7', [[-0.31, 2.3, -1.04], [-0.27, 1.96, -1.04], [0.27, 1.96, -1.04], [0.31, 2.3, -1.04]], 0.018);
    collar(body, '#68885c', 3.18, 0.61, 0.12);
    const tail = new THREE.Group(); tail.name = 'ring-tail'; tail.position.set(0, 1.65, 0.65);
    tail.rotation.x = Math.PI / 3; body.add(tail);
    for (let i = 0; i < 6; i++) ball(tail, i % 2 ? '#604738' : color, [0, i * 0.32, 0], [0.49 - i * 0.025, 0.3, 0.49 - i * 0.025]);
  }
  const head = new THREE.Group(); body.add(head);
  head.name = 'village-head';
  mesh(head, new THREE.SphereGeometry(1, 32, 24), color, [0, 4.08, 0], [1.4, 1.36, 1.19]);
  if (human) {
    const hair = girl ? '#854b34' : '#594030', sheen = girl ? '#a56b47' : '#79563b';
    for (const x of [-1.32, 1.32]) {
      ball(head, color, [x, 3.99, 0], [0.24, 0.34, 0.28]);
      ball(head, '#cf9174', [x, 4, -0.21], [0.12, 0.17, 0.035]);
    }
    ball(head, hair, [0, 4.8, 0.14], [1.43, 0.85, 1.2]);
    const fringe = girl
      ? [[-0.82, 4.83, -0.83, -0.5], [-0.26, 5.02, -1.02, -0.65], [0.53, 4.94, -0.93, 0.55], [1.02, 4.65, -0.63, 0.3]]
      : [[-1.02, 4.75, -0.69, -0.35], [-0.53, 4.95, -0.98, -0.5], [0.16, 5.02, -1.01, -0.5], [0.83, 4.87, -0.83, 0.4]];
    fringe.forEach(([x, y, z, tilt]) => {
      ball(head, hair, [x, y, z], [0.48, girl ? 0.6 : 0.48, 0.26]).rotation.z = tilt;
    });
    line(head, sheen, [[-0.91, 5.12, -0.89], [-0.51, 5.34, -0.93], [-0.06, 5.39, -0.84]], 0.025);
    if (girl) {
      for (const x of [-1.4, 1.4]) {
        ball(head, hair, [x, 4.13, 0.26], [0.49, 0.75, 0.48]).rotation.z = x * -0.13;
        ball(head, hair, [x * 1.08, 3.73, 0.29], [0.35, 0.39, 0.37]);
        ball(head, '#e8bf68', [x, 4.65, 0.02], [0.3, 0.12, 0.27]);
        for (const side of [-1, 1])
          ball(head, cream, [x + side * 0.15, 4.64, -0.2], [0.18, 0.13, 0.06]).rotation.z = side * 0.4;
      }
    }
  } else for (const x of [-1, 1]) {
    if (species === 'cat') {
      const ear = mesh(head, new THREE.ConeGeometry(0.58, 1.22, 4), color, [x * 0.96, 5.25, 0], [1, 1, 0.65]);
      ear.rotation.z = -x * 0.18;
      const inner = mesh(head, new THREE.ConeGeometry(0.34, 0.79, 4), '#d78e82', [x * 0.98, 5.27, -0.24], [1, 1, 0.28]);
      inner.rotation.z = -x * 0.18;
    } else {
      const rabbit = species === 'rabbit';
      ball(head, color, [x * 0.91, rabbit ? 5.68 : 5.07, 0], [rabbit ? 0.43 : 0.59, rabbit ? 1.15 : 0.6, 0.35]).rotation.z = -x * (rabbit ? 0.14 : 0.1);
      ball(head, '#d99583', [x * 0.94, rabbit ? 5.76 : 5.1, -0.29], [rabbit ? 0.24 : 0.35, rabbit ? 0.82 : 0.37, 0.085]).rotation.z = -x * (rabbit ? 0.14 : 0.1);
    }
  }
  let tail;
  if (!human && !tanuki) {
    tail = new THREE.Group(); tail.name = 'village-tail'; tail.position.set(0, 1.72, 0.57); body.add(tail);
    if (species === 'cat') {
      line(tail, color, [[0, 0, 0], [0.5, 0.15, 0.65], [0.74, 0.85, 0.82], [0.45, 1.22, 0.85]], 0.22);
      ball(tail, '#9a693f', [0.45, 1.22, 0.85], [0.22, 0.23, 0.22]);
    } else ball(tail, furLight, [0, 0, 0.32], species === 'rabbit' ? [0.43, 0.45, 0.43] : [0.32, 0.32, 0.32]);
  }
  if (tanuki) {
    for (const x of [-0.58, 0.58])
      ball(head, '#634838', [x, 4.18, -1.04], [0.66, 0.56, 0.18]).name = 'raccoon-mask';
    ball(head, '#edd5ad', [0, 3.65, -1.1], [0.8, 0.48, 0.3]).name = 'light-muzzle';
  } else if (!human) {
    ball(head, furLight, [0, 3.66, -1.08], [species === 'cat' ? 0.69 : 0.72, 0.4, 0.19]).name = 'light-muzzle';
    if (species === 'cat') {
      for (const x of [-1, 0, 1])
        panel(head, '#a77343', [0, 4.08, 0], [1.415, 1.375, 1.205],
          x * 0.27 - 0.05, x * 0.27 + 0.05, 0.61 + Math.abs(x) * 0.08, 1.06);
      for (const x of [-1, 1]) for (const y of [3.72, 3.87])
        line(head, '#976c4c', [[x * 0.85, y, -0.99], [x * 1.07, y + 0.025, -0.88], [x * 1.2, y + 0.09, -0.77]], 0.018);
    }
  }
  for (const x of [-0.55, 0.55]) {
    const eyeZ = tanuki ? -1.23 : -1.1;
    const eye = new THREE.Group(); eye.position.set(x, 4.17, eyeZ); eye.name = 'village-eye'; head.add(eye); eyes.push(eye);
    const iris = human ? girl ? '#547d72' : '#84613f' : species === 'rabbit' ? '#a17451' : '#657c6a';
    ball(eye, ink, [0, 0, 0], [0.345, 0.465, 0.07]);
    ball(eye, '#fff9e9', [0, -0.015, -0.025], [0.31, 0.42, 0.07]);
    ball(eye, iris, [-x * 0.06, -0.015, -0.093], [0.205, 0.3, 0.035]);
    ball(eye, '#302c2a', [-x * 0.06, 0.005, -0.126], [0.125, 0.235, 0.025]);
    ball(eye, '#ffffff', [-0.067, 0.14, -0.153], [0.065, 0.085, 0.018]);
    ball(eye, '#fff3cd', [0.075, -0.14, -0.153], [0.027, 0.035, 0.014]);
    const lid = line(head, ink, [[x - 0.25, 4.14, eyeZ], [x, 4.08, eyeZ - 0.04], [x + 0.25, 4.14, eyeZ]], 0.034);
    lid.name = `sleep-eye-${x < 0 ? 'left' : 'right'}`; lid.visible = false; lids.push(lid);
    const brow = line(head, human ? '#76513a' : '#94694b',
      [[x - 0.22, 4.74, -0.88], [x, 4.79, -0.98], [x + 0.22, 4.72, -0.94]], 0.035);
    brow.name = 'village-brow';
    ball(head, '#dc9a85', [x * 1.7, 3.77, -0.92], [0.23, 0.12, 0.035]);
    if (human && girl) line(head, ink, [[x, 4.52, -1.13], [x * 1.35, 4.56, -1.08], [x * 1.48, 4.62, -1.02]], 0.028);
  }
  const muzzleZ = human ? -1.15 : tanuki ? -1.42 : -1.29;
  ball(head, human ? '#d99e76' : '#68443d', [0, 3.84, muzzleZ], [human ? 0.17 : 0.19, 0.125, human ? 0.18 : 0.11]);
  if (!human) ball(head, '#ba8d77', [-0.05, 3.89, muzzleZ - 0.095], [0.055, 0.027, 0.018]);
  const smile = line(head, ink, [[-0.23, 3.59, muzzleZ], [0, 3.47, muzzleZ - 0.025], [0.23, 3.59, muzzleZ]], 0.032);
  smile.name = 'village-smile';
  const mouth = ball(head, '#754239', [0, 3.54, muzzleZ], [0.16, 0.14, 0.035]);
  mouth.name = 'village-talking-mouth'; mouth.visible = false;
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
    head.position.y = talking && !reducedMotion?.matches ? Math.sin(time * 9) * 0.025 : 0;
    if (tail) tail.rotation.z = reducedMotion?.matches ? 0 : Math.sin(time * 2.4) * 0.08;
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
    const blinkPhase = (time + (human ? girl ? 1.1 : 0 : species === 'rabbit' ? 0.6 : 1.8)) % 4.6;
    const blinking = !reducedMotion?.matches && blinkPhase > 4.43;
    eyes.forEach(e => { e.visible = !sleeping && !blinking; });
    lids.forEach(e => { e.visible = sleeping || blinking; });
    const speaking = talking && !sleeping;
    smile.visible = !speaking; mouth.visible = speaking;
    mouth.scale.y = speaking ? 0.09 + (reducedMotion?.matches ? 0 : Math.abs(Math.sin(time * 12)) * 0.09) : 0.14;
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
