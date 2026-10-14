import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { part, limb, STICK_HAND, buildJetpack } from './figure.js';

// Halo 3's Mark VI silhouette: sealed helmet, gold visor, broad shoulder
// plates and segmented armor over a black undersuit. Same rig as figure.js,
// in cells, facing -z; no download or separate animation system.
const ARMOR = [0.16, 0.23, 0.065], DARK = [0.018, 0.023, 0.025];
const TRIM = [0.065, 0.085, 0.045], GOLD = [0.95, 0.48, 0.075];
const HIP = 2.5, THIGH = 1.2, SHIN = 1.3, TORSO = 1.75;
const UPPER_ARM = 0.85, FOREARM = 0.85;

export function buildSpartan() {
  const body = new THREE.Group(), torso = new THREE.Group(), neck = new THREE.Group();
  body.name = 'spartan';
  body.add(torso);
  neck.position.y = TORSO;
  torso.add(neck);
  const plate = (parent, name, size, at, color = ARMOR) => {
    const geo = new RoundedBoxGeometry(...size, 1, Math.min(...size) * 0.18);
    geo.translate(...at);
    const mesh = part(parent, geo, color);
    mesh.name = name;
    return mesh;
  };

  plate(torso, 'undersuit', [1.15, 1.6, 0.66], [0, 0.8, 0], DARK);
  plate(torso, 'chest-armor', [1.48, 0.8, 0.85], [0, 1.22, -0.05]);
  plate(torso, 'chest-inset', [0.85, 0.19, 0.09], [0, 1.37, -0.51], TRIM);
  for (const y of [0.45, 0.73]) plate(torso, 'abdominal-plate', [0.94, 0.23, 0.78], [0, y, 0]);
  plate(body, 'belt', [1.25, 0.26, 0.8], [0, 0.1, 0], TRIM);
  plate(body, 'pelvis-armor', [0.56, 0.46, 0.27], [0, -0.15, -0.35]);
  plate(torso, 'back-armor', [1.06, 1.1, 0.38], [0, 1.02, 0.47]);
  for (const x of [-0.36, 0.36]) plate(torso, 'back-vent', [0.19, 0.65, 0.09], [x, 1.04, 0.7], DARK);

  plate(neck, 'neck-seal', [0.48, 0.28, 0.48], [0, 0.1, 0], DARK);
  plate(neck, 'helmet', [1.05, 1.05, 1.03], [0, 0.65, 0]);
  plate(neck, 'visor-gasket', [0.96, 0.46, 0.19], [0, 0.69, -0.49], DARK);
  plate(neck, 'gold-visor', [0.86, 0.32, 0.18], [0, 0.71, -0.58], GOLD);
  plate(neck, 'helmet-brow', [1.06, 0.17, 0.25], [0, 0.98, -0.48]);
  plate(neck, 'chin-guard', [0.64, 0.22, 0.28], [0, 0.29, -0.48]);
  for (const x of [-0.49, 0.49]) plate(neck, 'helmet-cheek', [0.2, 0.48, 0.42], [x, 0.42, -0.33]);

  const arms = [], legs = [];
  for (const side of [-1, 1]) {
    const sh = limb(torso, DARK, side * 0.88, 1.5, UPPER_ARM, 0.21);
    const el = limb(sh, DARK, 0, -UPPER_ARM, FOREARM, 0.18);
    plate(sh, 'shoulder-armor', [0.68, 0.65, 0.79], [side * 0.06, -0.13, 0]);
    plate(sh, 'upper-arm-armor', [0.45, 0.42, 0.52], [0, -0.56, 0]);
    plate(el, 'gauntlet', [0.48, 0.6, 0.57], [0, -0.4, 0]);
    plate(el, 'glove', [0.35, 0.3, 0.4], [0, -FOREARM, -0.02], DARK);
    arms.push(sh, el);

    const hip = limb(body, DARK, side * 0.4, 0, THIGH, 0.25);
    const kn = limb(hip, DARK, 0, -THIGH, SHIN - 0.15, 0.21);
    plate(hip, 'thigh-armor', [0.61, 0.85, 0.7], [0, -0.54, 0]);
    plate(kn, 'knee-armor', [0.57, 0.42, 0.29], [0, -0.08, -0.32]);
    plate(kn, 'shin-armor', [0.55, 0.82, 0.62], [0, -0.64, 0]);
    plate(kn, 'boot', [0.6, 0.34, 0.92], [0, -SHIN + 0.17, -0.14], TRIM);
    legs.push(hip, kn);
  }
  const [shL, elL, shR, elR] = arms, [hipL, knL, hipR, knR] = legs;
  const hand = new THREE.Group();
  hand.name = STICK_HAND;
  hand.position.y = -FOREARM;
  elR.add(hand);
  return {
    hipY: HIP, lieLift: 0.55, body, torso, neck,
    jetpack: buildJetpack(torso, { up: 1.05, back: 1, color: ARMOR, nozzleColor: DARK }),
    shL, shR, elL, elR, hipL, hipR, knL, knR, handY: -FOREARM,
  };
}
