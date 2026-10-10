import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, ConstantColor, Vector4, Vector3 as QVector3,
  PointEmitter, Gradient, ColorOverLife,
} from 'three.quarks';
import { gfxUniforms } from '../gfx/uniforms.js';

// The birds on screen: every bird is one instance of one InstancedMesh (one
// draw call), its wings beating in the vertex shader, lit by the same sun and
// sky as the volume (gfxUniforms: the key light's colour at the ground and the
// open sky's irradiance, so they darken at dusk and go moonlit blue at night),
// plus their magic: an iridescent sheen whose hue shifts with the view, and at
// dusk and night a soft emissive glow (no lights) and a faint trail of light
// motes (three.quarks, one more draw call). Linear HDR radiance like the
// volume's; above ~1.6 it blooms.
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
const BODY_ALBEDO = [0.05, 0.05, 0.07];      // slate, nearly black: a starling's
const WING_ALBEDO = [0.11, 0.1, 0.14];
const SHEEN = 1.4;                           // iridescent sheen at grazing angles, by day (times the light on it)
const SHEEN_POW = 2;                         // Fresnel-like falloff of the sheen toward face-on
const IRID_SPREAD = 0.35;                    // hue turns this far (of a full turn) from face-on to grazing, root to tip
const IRID_SAT = 0.75;
const HUE_DRIFT = 0.03;                      // turns/s every bird's hue drifts
const GLOW_RADIANCE = 2.2;                   // HDR, a wing's edge at full night glow (blooms softly)
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

const birdVert = /* glsl */ `
#define FLAP_AMP ${glf(FLAP_AMP)}
#define TIP_EXTRA ${glf(TIP_EXTRA)}
#define DIHEDRAL ${glf(DIHEDRAL)}
#define FOLD_X ${glf(FOLD_X)}
#define FOLD_SWEEP ${glf(FOLD_SWEEP)}
#define FOLD_DROP ${glf(FOLD_DROP)}
attribute float aWing;   // signed share of the half-span (0: body and tail)
attribute vec4 aBird;    // wing phase (rad), effort (0..1), fold (0..1), burning (0..1)
attribute vec2 aLook;    // hue (turns), glow (0..1: a dead bird's is gone)
varying vec3 vN;
varying vec3 vW;
varying float vWing;
varying float vBurn;
varying vec2 vLook;
void main() {
  vec3 p = position, n = normal;
  float w = abs(aWing);
  if (w > 0.0) {
    float side = sign(aWing);
    float fold = aBird.z;
    // the wing beats about the body's long axis, the outer part further
    float beat = sin(aBird.x) * FLAP_AMP * aBird.y + DIHEDRAL * (1.0 - aBird.y);
    float ang = beat * (1.0 + TIP_EXTRA * w) * (1.0 - fold);
    float r = abs(p.x) * mix(1.0, FOLD_X, fold);
    p = vec3(side * r * cos(ang), p.y + r * sin(ang) - FOLD_DROP * fold, p.z - FOLD_SWEEP * fold * w);
    n = vec3(-side * sin(ang), cos(ang), 0.0);
  }
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(p, 1.0);
  vW = wp.xyz;
  vN = mat3(m) * n;   // uniform scale only
  vWing = aWing;
  vBurn = aBird.w;
  vLook = aLook;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const birdFrag = /* glsl */ `
#define BODY_ALBEDO ${v3(BODY_ALBEDO)}
#define WING_ALBEDO ${v3(WING_ALBEDO)}
#define SHEEN ${glf(SHEEN)}
#define SHEEN_POW ${glf(SHEEN_POW)}
#define IRID_SPREAD ${glf(IRID_SPREAD)}
#define IRID_SAT ${glf(IRID_SAT)}
#define HUE_DRIFT ${glf(HUE_DRIFT)}
#define GLOW_RADIANCE ${glf(GLOW_RADIANCE)}
#define GLOW_BODY ${glf(GLOW_BODY)}
#define FIRE_RGB ${v3(FIRE_RGB)}
#define FIRE_HZ ${glf(FIRE_HZ)}
uniform vec3 uSun;      // toward the key light (sun or moon)
uniform vec3 uSunCol;   // its light at the ground
uniform vec3 uSkyUp;    // the open sky's irradiance on an upward face
uniform float uGlow;    // 0 by day .. 1 at night
uniform float uTime;    // s
varying vec3 vN;
varying vec3 vW;
varying float vWing;
varying float vBurn;
varying vec2 vLook;
vec3 hue2rgb(float h) {
  vec3 k = abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0;
  return clamp(k, 0.0, 1.0);
}
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vW);
  float w = abs(vWing);
  vec3 albedo = mix(BODY_ALBEDO, WING_ALBEDO, smoothstep(0.0, 0.3, w));
  vec3 light = uSunCol * max(dot(n, uSun), 0.0) + uSkyUp * (0.5 + 0.5 * n.y);   // sun, and a hemisphere of sky
  float grazing = pow(1.0 - abs(dot(n, V)), SHEEN_POW);
  float hue = vLook.x + IRID_SPREAD * (grazing + w) + uTime * HUE_DRIFT;
  vec3 irid = mix(vec3(1.0), hue2rgb(hue), IRID_SAT);
  vec3 col = albedo * light + irid * SHEEN * grazing * albedo * light;
  float edge = mix(GLOW_BODY, 1.0, smoothstep(0.2, 1.0, w));
  col += irid * GLOW_RADIANCE * uGlow * vLook.y * edge;
  col += FIRE_RGB * vBurn * (0.75 + 0.25 * sin(uTime * FIRE_HZ + w * 9.0));
  gl_FragColor = vec4(col, 1.0);
}`;
export { birdVert, birdFrag };

// A behaviour that hands each new mote to `init` (vfx.js's Spawner, for motes):
// its own sink and drag, in world units.
class MoteSpawner {
  constructor(getScale) { this.type = 'BirdMotes'; this.init = null; this.getScale = getScale; }
  initialize(p) { this.init?.(p); }
  update(p, dt) { p.velocity.y -= MOTE_SINK * this.getScale() * dt; }
  frameUpdate() {}
  reset() {}
  toJSON() { return { type: this.type }; }
  clone() { return new MoteSpawner(this.getScale); }
}

function dotTexture() {
  const data = new Uint8Array(MOTE_TEX * MOTE_TEX * 4);
  for (let y = 0; y < MOTE_TEX; y++) for (let x = 0; x < MOTE_TEX; x++) {
    const u = (x + 0.5) / MOTE_TEX * 2 - 1, v = (y + 0.5) / MOTE_TEX * 2 - 1, r = Math.hypot(u, v);
    const i = (y * MOTE_TEX + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(255 * (r >= 1 ? 0 : (1 - r * r) ** MOTE_FALLOFF));
  }
  const t = new THREE.DataTexture(data, MOTE_TEX, MOTE_TEX);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
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
  const geo = birdGeometry();
  const aBird = new THREE.InstancedBufferAttribute(new Float32Array(BIRDS_MAX * 4), 4);
  const aLook = new THREE.InstancedBufferAttribute(new Float32Array(BIRDS_MAX * 2), 2);
  aBird.setUsage(THREE.DynamicDrawUsage);
  aLook.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aBird', aBird);
  geo.setAttribute('aLook', aLook);
  const uniforms = {
    uSun: { value: sun }, uSunCol: gfxUniforms.uSunCol, uSkyUp: gfxUniforms.uSkyUp,
    uGlow: { value: 0 }, uTime: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: birdVert, fragmentShader: birdFrag, uniforms, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, BIRDS_MAX);
  mesh.name = 'birds';
  mesh.count = 0;
  mesh.frustumCulled = false;   // the instances span the world; one draw either way
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  // ---- motes
  const batch = new BatchedRenderer();
  batch.name = 'bird-motes';
  scene.add(batch);
  const tex = dotTexture();
  const moteMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const spawner = new MoteSpawner(getScale);
  const sys = new ParticleSystem({
    looping: true, duration: 1, worldSpace: true,
    emissionOverTime: new ConstantValue(0),
    startLife: new ConstantValue(1), startSpeed: new ConstantValue(0), startSize: new ConstantValue(1),
    startColor: new ConstantColor(new Vector4(1, 1, 1, 1)),
    shape: new PointEmitter(), material: moteMat, renderMode: RenderMode.BillBoard,
    behaviors: [spawner, new ColorOverLife(new Gradient([[new QVector3(1, 1, 1), 0], [new QVector3(1, 1, 1), 1]], [[1, 0], [0, 1]]))],
  });
  batch.addSystem(sys);
  scene.add(sys.emitter);
  const burstState = { isBursting: false, burstParticleIndex: 0, burstParticleCount: 0, burstIndex: 0, burstWaveIndex: 0, time: 0, waitEmiting: 0, travelDistance: 0 };
  const IDENTITY = new THREE.Matrix4();
  function burst(n, init) {
    n = Math.min(Math.floor(n), MOTE_MAX - sys.particleNum);
    if (n <= 0) return;
    spawner.init = init;
    burstState.waitEmiting = n; burstState.time = 0; burstState.burstIndex = 0;
    sys.emit(0, burstState, IDENTITY);
    spawner.init = null;
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), pos = new THREE.Vector3();
  const scl = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
  const rgb = [0, 0, 0], cam = new THREE.Vector3(), vel = new THREE.Vector3(), at = new THREE.Vector3(), rnd = new THREE.Vector3();
  const moteAcc = new Map();   // bird id → motes owed
  let clock = 0;

  return {
    mesh, batch,
    // rows: one per bird (index.js gatherRows): { id, p (world cells), useQ, q [x, y, z, w] (its
    // flight's rotation, if useQ) else heading (rad about up), roll (rad), phase, effort, fold, burn,
    // hue, glow, flying, vel (cells/s) }; toScene(world cells, out) → scene units
    update(dt, rows, toScene, { glow, camera, span }) {
      clock += dt;
      uniforms.uTime.value = clock;
      uniforms.uGlow.value = glow;
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
        m4.compose(pos, q, scl.setScalar(span * s));
        mesh.setMatrixAt(i, m4);
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
        burst(k, (p) => {
          p.position.copy(at).add(rnd.randomDirection().multiplyScalar(MOTE_JITTER * span * s));
          p.velocity.copy(vel).add(rnd.randomDirection().multiplyScalar(MOTE_DRIFT * s));
          const size = randIn(MOTE_SIZE) * s;
          p.startSize.set(size, size, size); p.size.copy(p.startSize);
          p.startColor.set(rgb[0] * moteRadiance, rgb[1] * moteRadiance, rgb[2] * moteRadiance, 1);
          p.color.copy(p.startColor);
          p.life = randIn(MOTE_LIFE); p.age = 0;
        });
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      aBird.needsUpdate = true;
      aLook.needsUpdate = true;
      if (moteAcc.size > BIRDS_MAX * 2) moteAcc.clear();
      batch.update(dt);
    },
    // a killed bird's puff of feathers at world cells p
    feathers(p, toScene) {
      const s = getScale(), at = toScene(p, new THREE.Vector3());
      burst(FEATHERS, (pt) => {
        pt.position.copy(at);
        pt.velocity.copy(new THREE.Vector3().randomDirection().multiplyScalar(FEATHER_SPEED * s));
        const size = randIn(MOTE_SIZE) * s;
        pt.startSize.set(size, size, size); pt.size.copy(pt.startSize);
        pt.startColor.set(...FEATHER_RGB, 1); pt.color.copy(pt.startColor);
        pt.life = randIn(MOTE_LIFE); pt.age = 0;
      });
    },
    get motes() { return sys.particleNum; },
    clear() { mesh.count = 0; sys.particleNum = 0; moteAcc.clear(); batch.update(0); },
    dispose() {
      scene.remove(mesh, batch, sys.emitter);
      sys.dispose(); geo.dispose(); mat.dispose(); moteMat.dispose(); tex.dispose();
    },
  };
}
