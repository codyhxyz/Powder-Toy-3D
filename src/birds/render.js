import * as THREE from 'three/webgpu';
import {
  uniform, attribute, varying, vec3, vec4, float, abs, sign, sin, cos, mix, max, dot, pow, normalize, cross, smoothstep, select, fract, clamp,
  positionGeometry, normalGeometry, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, faceDirection,
} from 'three/tsl';
import { gfxUniforms } from '../gfx/uniforms.js';
import { createBillboards } from '../gfx/billboards.js';
import { prepareMesh } from '../gfx/meshLight.js';

// The birds on screen: every bird is one instance of one InstancedMesh (one
// draw call), its wings beating in the vertex shader, lit by the same sun and
// sky as the volume (gfxUniforms: the key light's colour at the ground and the
// open sky's irradiance, so they darken at dusk and go moonlit blue at night),
// plus their magic: an iridescent sheen whose hue shifts with the view, and at
// dusk and night a soft emissive glow (no lights) and a faint trail of light
// motes (gfx/billboards.js, one more draw call). Linear HDR radiance like the
// volume's; above ~1.6 it blooms. TSL (docs/webgpu.md F8): the wings beat in
// the vertex stage (positionNode), the sheen and glow in the fragment.
//
// The model is in wingspans (1 = tip to tip), x across the wings, y up, z
// forward (Yuka's forward), the body at the origin.

export const BIRDS_MAX = 256;                // instances (birds alive and dead at once)

// ---- the model (wingspans)
const BODY_NOSE = 0.3, BODY_TAIL = -0.2, BODY_R = 0.055, BODY_RING_Z = 0.04;
const TAIL_Z = -0.4, TAIL_HALF = 0.11;
// a wing from root to tip: [span share, leading edge z, trailing edge z]
const WING = [[0.08, 0.1, -0.12], [0.45, 0.11, -0.13], [0.75, 0.07, -0.1], [1, -0.07, -0.07]];

// ---- wing motion (rad, shares)
const FLAP_AMP = 0.85;                       // rad of wing swing at full effort (up and down from level)
const TIP_EXTRA = 0.6;                       // the outer wing swings this much further (it bends at the wrist)
const DIHEDRAL = 0.12;                       // rad: wings held this far up while gliding
const FOLD_X = 0.22;                         // a folded wing's span share left
const FOLD_SWEEP = 0.35;                     // wingspans a folded tip lies back along the body
const FOLD_DROP = 0.02;                      // wingspans a folded wing sits below the back

// ---- the look (linear)
const BODY_ALBEDO = [0.12, 0.12, 0.15];      // slate: a rock dove's
const WING_ALBEDO = [0.3, 0.3, 0.35];        // its paler wings (they read against the trees)
const SHEEN = 1.4;                           // iridescent sheen at grazing angles, by day (times the light on it)
const SHEEN_POW = 2;                         // Fresnel-like falloff of the sheen toward face-on
const IRID_SPREAD = 0.35;                    // hue turns this far (of a full turn) from face-on to grazing, root to tip
const IRID_SAT = 0.75;
const HUE_DRIFT = 0.03;                      // turns/s every bird's hue drifts
const GLOW_RADIANCE = 1.6;                   // HDR, a wing's edge at full night glow (just blooms)
const GLOW_BODY = 0.25;                      // share of that on the body
const FIRE_RGB = [6, 2.4, 0.5];              // HDR, a burning bird
const FIRE_HZ = 23;                          // its flicker

// ---- light motes behind flying birds
const MOTE_MAX = 600;                        // alive at once
const MOTE_RATE = 7;                         // motes/s behind a bird at full glow...
const MOTE_DAY = 0.15;                       // ...and this share of that by day
const MOTE_RANGE = 220;                      // cells from the camera: farther birds leave none
const MOTE_LIFE = [0.8, 1.7];                // s
const MOTE_SIZE = [0.25, 0.45];              // cells across
const MOTE_DRIFT = 1.2;                      // cells/s, a mote's own random drift
const MOTE_CARRY = 0.08;                     // share of the bird's velocity a mote keeps
const MOTE_SINK = 0.6;                       // cells/s², motes settle slowly
const MOTE_RADIANCE = 2.6;                   // HDR at night (by day as the glow fades, MOTE_RADIANCE_DAY)
const MOTE_RADIANCE_DAY = 0.6;
const MOTE_JITTER = 0.25;                    // wingspans: where along the bird a mote leaves
const FEATHERS = 14;                         // motes in the puff when a bird is killed
const FEATHER_SPEED = 5;                     // cells/s
const FEATHER_RGB = [0.5, 0.5, 0.55];
const MOTE_TEX = 32;                         // px, the mote's soft dot
const MOTE_FALLOFF = 2;

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randIn = ([lo, hi]) => rand(lo, hi);
const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const v3 = (a) => `vec3(${a.map(glf).join(', ')})`;

function birdGeometry() {
  const pos = [], wing = [];
  const tri = (a, b, c, w = [0, 0, 0]) => { pos.push(...a, ...b, ...c); wing.push(...w); };
  // body: a slim double cone from nose to tail around a ring
  const ring = [[0, BODY_R, BODY_RING_Z], [BODY_R, 0, BODY_RING_Z], [0, -BODY_R * 0.8, BODY_RING_Z], [-BODY_R, 0, BODY_RING_Z]];
  const nose = [0, 0, BODY_NOSE], tail = [0, BODY_R * 0.2, BODY_TAIL];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    tri(nose, b, a);
    tri(tail, a, b);
  }
  // tail fan
  tri([0, BODY_R * 0.2, BODY_TAIL], [-TAIL_HALF, 0, TAIL_Z], [TAIL_HALF, 0, TAIL_Z]);
  // wings: strips root → tip, aWing = signed span share
  for (const s of [-1, 1]) {
    for (let i = 0; i < WING.length - 1; i++) {
      const [w0, l0, t0] = WING[i], [w1, l1, t1] = WING[i + 1];
      const x0 = s * w0 / 2, x1 = s * w1 / 2;
      const A = [x0, 0, l0], B = [x1, 0, l1], C = [x1, 0, t1], D = [x0, 0, t0];
      const order = s > 0 ? [[A, D, B], [B, D, C]] : [[A, B, D], [B, C, D]];
      for (const [p, q, r] of order) {
        tri(p, q, r, [s * Math.abs(p[0]) * 2, s * Math.abs(q[0]) * 2, s * Math.abs(r[0]) * 2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

// WEBGPU-STUB (docs/webgpu.md J3): the GLSL; birdMaterial is the TSL port
export const birdVert = '';
// WEBGPU-STUB (docs/webgpu.md J3)
export const birdFrag = '';

// rotate v by unit quaternion q
const rotate = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2));

// The birds' material: the GLSL birdVert/birdFrag in TSL, on an instanced
// geometry whose instances carry their pose (aPose: scene position, scale;
// aTurn: rotation) beside aBird and aLook. u: { sun, glow, time } uniform nodes.
function birdMaterial(u) {
  const wing = attribute('aWing', 'float');   // signed share of the half-span (0: body and tail)
  const bird = attribute('aBird', 'vec4');    // wing phase (rad), effort (0..1), fold (0..1), burning (0..1)
  const look = attribute('aLook', 'vec2');    // hue (turns), glow (0..1: a dead bird's is gone)
  const pose = attribute('aPose', 'vec4'), turn = attribute('aTurn', 'vec4');
  // the wing beats about the body's long axis, the outer part further
  const w = abs(wing), side = sign(wing), fold = bird.z;
  const beat = sin(bird.x).mul(FLAP_AMP).mul(bird.y).add(float(DIHEDRAL).mul(float(1).sub(bird.y)));
  const ang = beat.mul(w.mul(TIP_EXTRA).add(1)).mul(float(1).sub(fold));
  const p0 = positionGeometry;
  const r = abs(p0.x).mul(mix(float(1), float(FOLD_X), fold));
  const isWing = w.greaterThan(0);
  const p = select(isWing, vec3(side.mul(r).mul(cos(ang)), p0.y.add(r.mul(sin(ang))).sub(float(FOLD_DROP).mul(fold)), p0.z.sub(float(FOLD_SWEEP).mul(fold).mul(w))), p0);
  const n = select(isWing, vec3(side.negate().mul(sin(ang)), cos(ang), 0), normalGeometry);
  const world = rotate(turn, p.mul(pose.w)).add(pose.xyz);   // scene units (the mesh sits at the origin)
  const vW = varying(world), vN = varying(rotate(turn, n));   // (uniform scale: the normal only turns)
  const vWing = varying(wing), vBurn = varying(bird.w), vLook = varying(look);

  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  mat.lights = false;
  mat.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1)));
  const nn = normalize(vN).mul(faceDirection);
  const V = normalize(cameraPosition.sub(vW));
  const wv = abs(vWing);
  const albedo = mix(vec3(...BODY_ALBEDO), vec3(...WING_ALBEDO), smoothstep(0, 0.3, wv));
  const light = u.sunCol.mul(max(dot(nn, u.sun), 0)).add(u.skyUp.mul(nn.y.mul(0.5).add(0.5)));   // sun, and a hemisphere of sky
  const grazing = pow(float(1).sub(abs(dot(nn, V))), SHEEN_POW);
  const hue = vLook.x.add(float(IRID_SPREAD).mul(grazing.add(wv))).add(u.time.mul(HUE_DRIFT));
  const k = clamp(abs(fract(vec3(hue).add(vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1), 0, 1);
  const irid = mix(vec3(1), k, IRID_SAT);
  const col = albedo.mul(light).add(irid.mul(SHEEN).mul(grazing).mul(albedo).mul(light));
  const edge = mix(float(GLOW_BODY), float(1), smoothstep(0.2, 1, wv));
  mat.colorNode = col.add(irid.mul(GLOW_RADIANCE).mul(u.glow).mul(vLook.y).mul(edge))
    .add(vec3(...FIRE_RGB).mul(vBurn).mul(sin(u.time.mul(FIRE_HZ).add(wv.mul(9))).mul(0.25).add(0.75)));
  mat.name = 'birds';
  return mat;
}

const hueRgb = (h, out) => {
  for (let k = 0; k < 3; k++) {
    const c = Math.abs((((h + [0, 2 / 3, 1 / 3][k]) % 1) + 1) % 1 * 6 - 3) - 1;
    out[k] = 1 + (Math.min(1, Math.max(0, c)) - 1) * IRID_SAT;
  }
  return out;
};

// env: { scene, sun (Vector3, toward the key light), getScale }
export function createBirdView({ scene, sun, getScale }) {
  // the model, once per instance (InstancedBufferGeometry: each instance's pose, beat and look)
  const model = birdGeometry();
  const geo = new THREE.InstancedBufferGeometry();
  for (const k of ['position', 'normal', 'aWing']) geo.setAttribute(k, model.getAttribute(k));
  const inst = (k, n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(BIRDS_MAX * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, a);
    return a;
  };
  const aPose = inst('aPose', 4), aTurn = inst('aTurn', 4), aBird = inst('aBird', 4), aLook = inst('aLook', 2);
  geo.instanceCount = 0;
  const u = {
    sun: uniform(sun), sunCol: uniform(new THREE.Vector3()), skyUp: uniform(new THREE.Vector3()),
    glow: uniform(0), time: uniform(0),
  };
  const mat = birdMaterial(u);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'birds';
  mesh.frustumCulled = false;   // the instances span the world; one draw either way
  mesh.visible = false;
  Object.defineProperty(mesh, 'count', { get: () => geo.instanceCount });   // (as the InstancedMesh's was: tools read it)

  // ---- motes: a billboard pool (gfx/billboards.js), additive soft dots
  const motes = createBillboards({ name: 'bird-motes', capacity: MOTE_MAX, texture: 'dot', blending: 'additive', textureSize: MOTE_TEX });
  // both join the scene once their pipelines are built (docs/webgpu.md B5)
  let disposed = false;
  const group = new THREE.Group();
  group.add(mesh, motes.mesh);
  prepareMesh(group).then(() => { if (!disposed) scene.add(mesh, motes.mesh); });
  function burst(n, init) {
    return motes.burst(Math.floor(n), init);
  }

  const q = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), pos = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
  const rgb = [0, 0, 0], cam = new THREE.Vector3(), vel = new THREE.Vector3(), at = new THREE.Vector3(), rnd = new THREE.Vector3();
  const pv = new THREE.Vector3(), vv = new THREE.Vector3();
  const moteAcc = new Map();   // bird id → motes owed
  let clock = 0;

  return {
    mesh, batch: motes.mesh,
    // rows: one per bird (index.js gatherRows): { id, p (world cells), useQ, q [x, y, z, w] (its
    // flight's rotation, if useQ) else heading (rad about up), roll (rad), phase, effort, fold, burn,
    // hue, glow, flying, vel (cells/s) }; toScene(world cells, out) → scene units
    update(dt, rows, toScene, { glow, camera, span }) {
      clock += dt;
      u.time.value = clock;
      u.glow.value = glow;
      u.sunCol.value.fromArray(gfxUniforms.uSunCol.value);
      u.skyUp.value.fromArray(gfxUniforms.uSkyUp.value);
      const s = getScale();
      camera.getWorldPosition(cam);
      const n = Math.min(rows.length, BIRDS_MAX);
      const moteRadiance = MOTE_RADIANCE_DAY + (MOTE_RADIANCE - MOTE_RADIANCE_DAY) * glow;
      const rate = MOTE_RATE * (MOTE_DAY + (1 - MOTE_DAY) * glow);
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        toScene(r.p, pos);
        if (r.useQ) q.set(r.q[0], r.q[1], r.q[2], r.q[3]);
        else q.setFromAxisAngle(Y, r.heading);
        qRoll.setFromAxisAngle(Z, r.roll);
        q.multiply(qRoll);
        aPose.setXYZW(i, pos.x, pos.y, pos.z, span * s);
        aTurn.setXYZW(i, q.x, q.y, q.z, q.w);
        aBird.setXYZW(i, r.phase, r.effort, r.fold, r.burn);
        aLook.setXY(i, r.hue, r.glow);
        // motes behind it while it flies near enough to see
        if (!r.flying || dt <= 0 || pos.distanceTo(cam) > MOTE_RANGE * s) continue;
        let acc = (moteAcc.get(r.id) ?? Math.random()) + rate * dt;
        const k = Math.floor(acc);
        acc -= k;
        moteAcc.set(r.id, acc);
        if (!k) continue;
        hueRgb(r.hue + clock * HUE_DRIFT, rgb);
        vel.set(r.vel.x, r.vel.y, r.vel.z).multiplyScalar(MOTE_CARRY * s);
        at.copy(pos);
        burst(k, (p) => p.set(
          pv.copy(at).add(rnd.randomDirection().multiplyScalar(MOTE_JITTER * span * s)),
          vv.copy(vel).add(rnd.randomDirection().multiplyScalar(MOTE_DRIFT * s)),
          randIn(MOTE_SIZE) * s, [rgb[0] * moteRadiance, rgb[1] * moteRadiance, rgb[2] * moteRadiance], 1, randIn(MOTE_LIFE),
          { gravity: MOTE_SINK * s },
        ));
      }
      geo.instanceCount = n;
      mesh.visible = n > 0;
      for (const a of [aPose, aTurn, aBird, aLook]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
      if (moteAcc.size > BIRDS_MAX * 2) moteAcc.clear();
      motes.update(dt);
    },
    // a killed bird's puff of feathers at world cells p
    feathers(p, toScene) {
      const s = getScale(), from = toScene(p, new THREE.Vector3());
      burst(FEATHERS, (pt) => pt.set(from, vv.randomDirection().multiplyScalar(FEATHER_SPEED * s), randIn(MOTE_SIZE) * s, FEATHER_RGB, 1, randIn(MOTE_LIFE), { gravity: MOTE_SINK * s }));
    },
    get motes() { return motes.count(); },
    clear() { geo.instanceCount = 0; mesh.visible = false; motes.clear(); moteAcc.clear(); },
    dispose() {
      disposed = true;
      scene.remove(mesh);
      motes.dispose();
      geo.dispose(); model.dispose(); mat.dispose();
    },
  };
}
