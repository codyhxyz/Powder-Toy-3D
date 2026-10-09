import * as THREE from 'three';
import { createFigure, part, limb } from './figure.js';

// The wizard, drawn the way Castle Crashers draws its people: a huge round
// head on a stubby little body, mitten hands, thick black outlines and flat
// two-tone shading. The head is lost in a floppy pointed hood, the face only
// a black shadow with two glowing eyes (the game's Evil Wizard). A small
// brass jetpack sits on the back and flames while it fires.
//
// It is the stickman's rig and animation (figure.js) with this look built on
// it. Cells, feet at 0, facing −z; heights add up to the body's 5.5 cells.

// ---- proportions: half of the height is head
const THIGH = 0.45, SHIN = 0.45;
const HIP_Y = THIGH + SHIN;
const LEG_R = 0.22, HIP_HALF = 0.32;
const BOOT = [0.3, 0.22, 0.4];           // boot ellipsoid radii (x, y, z)
const TORSO = 1.5;                       // hips to the neck
// the robe: a bell, as (radius, height above the hips) from the hem up
const ROBE = [[0, -0.5], [0.95, -0.55], [0.92, -0.2], [0.8, 0.5], [0.66, 1.1], [0.5, 1.45], [0, 1.5]];
const HEM_Y = -0.5, HEM_TUBE = 0.1;      // gold trim round the hem
const BELT_Y = 0.45, BELT_TUBE = 0.09;
const SHOULDER_HALF = 0.62, SHOULDER_DROP = 0.3;
const UPPER_ARM = 0.42, FOREARM = 0.4, ARM_R = 0.21;
const MITT_R = 0.3;                      // round mitten hands
const HEAD_R = 1.4;                      // the head, in its hood...
const HEAD_UP = 1.2;                     // ...centred this far above the neck
// the face: a black ellipsoid set into the hood's front (radii as shares of HEAD_R)
const FACE = [0.78, 0.68, 0.42], FACE_DOWN = 0.12, FACE_IN = 0.72;
const EYE = [0.3, 0.02];                 // eye centres (± x, y as shares of HEAD_R) on the face
const EYE_R = 0.15, EYE_SQUASH = [1, 1.45, 0.6];
// the hood's point: three shrinking cones, each bent further back, so it flops
const TIP = [[0.8, 1.0, 0.3], [0.56, 0.85, 0.5], [0.3, 0.7, 0.65]];   // base radius, height, bend (rad) per segment
const TIP_SEAT = 0.82;                   // the first segment sits this share of HEAD_R up, as wide as the dome there
// jetpack: one fat brass barrel across the back, a nozzle under each end
const PACK_R = 0.32, PACK_LEN = 1.0, PACK_Y = 0.85, PACK_Z = 0.9;
const PACK_SIDE = 0.3;                   // nozzle offset to each side
const NOZZLE = [0.17, 0.22];             // radius, height
const FLAME = [0.15, 0.9];               // radius, length at full burn

const OUTLINE = 0.1;                     // cells, outline width
const COLOR = {                          // albedo, linear
  robe: [0.07, 0.02, 0.26], hood: [0.1, 0.025, 0.34], trim: [0.85, 0.55, 0.08], belt: [0.18, 0.08, 0.03],
  face: [0.004, 0.004, 0.008], mitt: [0.4, 0.27, 0.16], leg: [0.05, 0.04, 0.06], boot: [0.28, 0.14, 0.05],
  brass: [0.75, 0.42, 0.12], nozzle: [0.1, 0.1, 0.11],
};
const EYE_GLOW = [3.2, 3.2, 2.6];        // HDR, unlit: the eyes shine out of the dark
const FLAME_COLOR = [6, 2.6, 0.7];       // HDR, like the exhaust particles

const blob = (r, [sx, sy, sz], x, y, z) => new THREE.SphereGeometry(r, 20, 14).scale(sx, sy, sz).translate(x, y, z);

function buildCrasher() {
  const C = COLOR;
  const body = new THREE.Group(), torso = new THREE.Group(), neck = new THREE.Group();
  body.add(torso);
  part(torso, new THREE.LatheGeometry(ROBE.map(([r, y]) => new THREE.Vector2(r, y)), 24), C.robe);
  part(torso, new THREE.TorusGeometry(ROBE[1][0] - HEM_TUBE * 0.3, HEM_TUBE, 8, 32).rotateX(Math.PI / 2).translate(0, HEM_Y, 0), C.trim);
  part(torso, new THREE.TorusGeometry(0.86, BELT_TUBE, 8, 32).rotateX(Math.PI / 2).translate(0, BELT_Y, 0), C.belt);
  neck.position.y = TORSO;
  torso.add(neck);

  // head: the hood's dome, the face's shadow set into it, glowing eyes, the floppy point
  const head = new THREE.Group();
  head.position.y = HEAD_UP;
  neck.add(head);
  const R = HEAD_R;
  part(head, new THREE.SphereGeometry(R, 32, 24), C.hood);
  const fz = -R * FACE_IN, fy = -R * FACE_DOWN;
  part(head, blob(R, FACE, 0, fy, fz), C.face, { outline: false });
  const eyeZ = fz - R * FACE[2] * 0.92;
  for (const side of [-1, 1]) part(head, blob(EYE_R, EYE_SQUASH, side * R * EYE[0], fy + R * EYE[1], eyeZ), C.face, { glow: EYE_GLOW, outline: false });
  let seat = head;
  let y = R * TIP_SEAT;
  for (const [r, h, bend] of TIP) {
    const seg = new THREE.Group();
    seg.position.y = y;
    seg.rotation.x = bend;               // + tips the point back (+z)
    seat.add(seg);
    part(seg, new THREE.ConeGeometry(r, h, 20, 1, true).translate(0, h / 2, 0), C.hood);
    seat = seg;
    y = h * 0.8;                         // the next segment starts a little below this one's tip
  }

  // jetpack
  part(torso, new THREE.CapsuleGeometry(PACK_R, PACK_LEN - 2 * PACK_R, 4, 16).rotateZ(Math.PI / 2).translate(0, PACK_Y, PACK_Z), C.brass);
  const flameMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  flameMat.color.setRGB(...FLAME_COLOR);
  const [nozR, nozH] = NOZZLE, [flR, flLen] = FLAME;
  const nozY = PACK_Y - PACK_R * 0.8;
  const flames = [];
  for (const side of [-1, 1]) {
    part(torso, new THREE.ConeGeometry(nozR, nozH, 12, 1, true).translate(side * PACK_SIDE, nozY - nozH / 2, PACK_Z), C.nozzle);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(flR, flLen, 12).rotateX(Math.PI).translate(0, -flLen / 2, 0), flameMat);
    flame.position.set(side * PACK_SIDE, nozY - nozH, PACK_Z);
    flame.renderOrder = 1;               // after the volume
    flame.visible = false;
    torso.add(flame);
    flames.push(flame);
  }

  // stubby sleeved arms with big mittens, short legs in boots
  const shY = TORSO - SHOULDER_DROP;
  const shL = limb(torso, C.robe, -SHOULDER_HALF, shY, UPPER_ARM, ARM_R);
  const shR = limb(torso, C.robe, SHOULDER_HALF, shY, UPPER_ARM, ARM_R);
  const elL = limb(shL, C.robe, 0, -UPPER_ARM, FOREARM, ARM_R);
  const elR = limb(shR, C.robe, 0, -UPPER_ARM, FOREARM, ARM_R);
  for (const el of [elL, elR]) part(el, new THREE.SphereGeometry(MITT_R, 16, 12).translate(0, -FOREARM - ARM_R * 0.6, 0), C.mitt);
  const hipL = limb(body, C.leg, -HIP_HALF, 0, THIGH, LEG_R);
  const hipR = limb(body, C.leg, HIP_HALF, 0, THIGH, LEG_R);
  const knL = limb(hipL, C.leg, 0, -THIGH, SHIN, LEG_R);
  const knR = limb(hipR, C.leg, 0, -THIGH, SHIN, LEG_R);
  const [bx, by, bz] = BOOT;
  for (const kn of [knL, knR]) part(kn, blob(1, [bx, by, bz], 0, -SHIN + by * 0.4, -bz * 0.3), C.boot);

  return {
    hipY: HIP_Y, lieLift: HEAD_R * 0.6, outline: OUTLINE, toon: true, flames,
    nozzles: { back: PACK_Z, up: HIP_Y + nozY - nozH, side: PACK_SIDE },
    body, torso, neck, shL, shR, elL, elR, hipL, hipR, knL, knR,
  };
}

export const createCrasher = () => createFigure(buildCrasher);
