import * as THREE from 'three/webgpu';
import {
  attribute, varying, uniform, code, wgslFn, Fn, Discard, vec2, vec3, vec4, float, length, normalize, cross, abs, min, max, mix,
  smoothstep, select, positionGeometry, modelWorldMatrix, cameraViewMatrix, cameraProjectionMatrix, cameraPosition,
} from 'three/tsl';
import { lookOf } from './look.js';

// How spells look in the air: three instanced draws, whatever is cast.
//   cores   camera-facing quads streaked along their velocity: a white-hot core
//           in a coloured halo (bolts in flight, lantern orbs, impact flashes)
//   shells  spheres with a fresnel rim and scrolling noise, one style per field
//           (look.js `field`): glow, pull (rings running in), push (rings running
//           out), void (a black hole's dark heart: premultiplied blending lets one
//           draw both darken and glow), cloud, and the shock of a blast
//   beams   thick, soft, tapered cylinders with a texture running down them,
//           fading over BEAM_LIFE
// After Noita, where every spell has a glowing core, leaves particles and lights
// what it passes (the particles are vfx.js's, the light runtime.js's via
// world.setLights). No lights, meshes or materials are allocated per spell.
//
// Positions in items and pulses are grid cells; world = volume.position + grid × scale.
// An item's `offset` (cells) is where it is drawn relative to its physics
// `position`: a bolt leaves the wand's tip and converges on its true path
// (runtime.js WAND_CONVERGE_CELLS). Colours are look.js's × HDR gains (the scene
// renders HDR; above about 1.6 blooms).

// ---- capacities
const CORE_MAX = 384;
const SHELL_MAX = 96;
const BEAM_MAX = 128;
const PULSE_MAX = 384;

// ---- cores
const CORE_SIZE = [0.35, 0.9];          // cells, a bolt's core radius at least / at most...
const CORE_BASE = 0.28;                 // ...from this...
const CORE_PER_RADIUS = 0.12;           // ...plus this per cell of the spell's radius
const CORE_HALO = 2.2;                  // the quad's radius in core radii (the halo around the core)
const CORE_GAIN = 3.2;                  // HDR: the halo's colour × this
const CORE_WHITE = 6;                   // HDR: the white-hot centre
const CORE_SHARP = 9;                   // centre falloff: exp(−r² × this), r in quad radii
const STREAK_S = 0.035;                 // s of travel a streak shows behind the bolt
const STREAK_MAX = 10;                  // the streak is at most this many core radii long
const ORB_SIZE = 0.55;                  // cells, a lantern's orb (its light reaches far further)
const ORB_FLICKER = 0.08;               // share the orb's brightness wavers by
const ORB_FLICKER_RATE = 9;             // rad/s of that waver

// ---- impact flashes
const FLASH_LIFE = 0.18;                // s
const FLASH_SIZE = [0.6, 2.6];          // cells, a flash's radius at least / at most...
const FLASH_BASE = 0.45;                // ...from this...
const FLASH_PER_RADIUS = 0.35;          // ...plus this per cell of the spell's radius
const FLASH_GROW = 1.6;                 // it swells to this many times its birth size
const FLASH_GAIN = 1.6;                 // its brightness at birth, times a core's

// ---- shells (fields and blasts)
const FIELD_RADIUS_MAX = 12;            // cells: a field's shell is drawn at its radius up to this
const FIELD_FADE_IN = 0.15;             // s
const FIELD_FADE_OUT = 0.35;            // s, at the end of its life
const SHOCK_LIFE = 0.32;                // s a blast's shock shell takes to reach its radius
const SHOCK_START = 0.15;               // share of the radius it starts at
const SHOCK_GAIN = 2.5;                 // its rim's brightness at birth
const SHELL_DETAIL = 3;                 // icosphere subdivisions
// styles (the shader's iStyle)
const STYLE = Object.freeze({ glow: 0, pull: 1, push: 2, void: 3, cloud: 4, shock: 5 });
// shader constants (written into the WGSL)
const SHELL_RIM_GAIN = 2.2;             // HDR: the rim's colour × this
const SHELL_FILL = 0.35;                // a glow shell's face-on fill
const SHELL_RINGS = 3;                  // rings across a pull/push shell
const SHELL_RING_SPEED = 0.9;           // rings/s they run in or out
const SHELL_RING_GAIN = 1.6;
const VOID_ALPHA = 0.92;                // how black a black hole's heart is
const VOID_SWIRL = 0.7;                 // rad/s its accretion swirl turns
const CLOUD_LIGHT = 0.9;                // a cloud's colour × this (lit like the world's own gas, roughly)
const CLOUD_ALPHA = 0.55;
const NOISE_SCALE = 3;                  // noise cells across a unit sphere
const NOISE_SPEED = 0.6;                // its scroll, 1/s

// ---- beams
const BEAM_LIFE = 0.2;                  // s a beam hangs after its cast
const BEAM_FADE = 1.5;                  // brightness falls as (life left)^this
const BEAM_WIDTH = [0.12, 0.5];         // cells, its radius at least / at most...
const BEAM_PER_RADIUS = 0.16;           // ...this per cell of the spell's radius
const BEAM_TIP_SHARE = 0.25;            // its radius at the wand's tip, a share of full...
const BEAM_TAPER_CELLS = 4;             // ...widening to full over this many cells
const BEAM_SIDES = 12;
const BEAM_GAIN = 2.6;                  // HDR: the beam's colour × this
const BEAM_CORE_WHITE = 3;              // HDR: its white core
const BEAM_SOFT = 1.6;                  // glow falloff to the silhouette (higher = tighter)
const BEAM_CORE_SOFT = 8;               // the core's (higher = thinner)
const BEAM_SCROLL = 18;                 // cells/s its texture runs away from the wand
const BEAM_TEXTURE = 0.5;               // texture cells per cell of beam
const BEAM_TEXTURE_DEPTH = 0.45;        // share of brightness the texture takes and gives

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f = (x) => x.toFixed(4);          // a number as a WGSL float

// The three draws' materials are TSL node materials (docs/webgpu.md F8): each
// places its instances in the vertex stage from per-instance attributes, as
// the GLSL did, and shades them in a WGSL function of the GLSL's arithmetic.
// They take no light and no fog, and write linear HDR into the scene target.

// the shells' and beams' value noise (its own: kept as drawn)
const NOISE = code(/* wgsl */ `
fn wandHash3(p0: vec3f) -> f32 { var p = fract(p0 * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
fn wandNoise(x: vec3f) -> f32 {
  let i = floor(x);
  var u = fract(x);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(mix(wandHash3(i), wandHash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(wandHash3(i + vec3f(0.0, 1.0, 0.0)), wandHash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(wandHash3(i + vec3f(0.0, 0.0, 1.0)), wandHash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(wandHash3(i + vec3f(0.0, 1.0, 1.0)), wandHash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}`, [], 'wgsl');

// A core's light at q (halo radii from its segment's middle, x along the
// streak; h the segment's half-length in them), or w < 0 outside its halo.
const coreColor = wgslFn(/* wgsl */ `
fn wandCore(q: vec2f, h: f32, color: vec3f, alpha: f32) -> vec4f {
  let dx = max(abs(q.x) - h, 0.0);
  let r = length(vec2f(dx, q.y));
  if (r >= 1.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let halo = (1.0 - r) * (1.0 - r);
  let core = exp(-r * r * ${f(CORE_SHARP)});
  var tail = 1.0;   // brightest at the head
  if (h > 0.0) { tail = smoothstep(-h - 1.0, h, q.x); }
  let rgb = color * halo * ${f(CORE_GAIN)} + vec3f(core * ${f(CORE_WHITE)});
  return vec4f(rgb * alpha * mix(0.35, 1.0, tail), 1.0);
}`);

// A shell's premultiplied colour at its unit-sphere point pDir (world w, the
// eye at eye), by its style.
const shellColor = wgslFn(/* wgsl */ `
fn wandShell(pDir: vec3f, w: vec3f, eye: vec3f, color: vec3f, styleF: f32, alpha: f32, seed: f32, time: f32) -> vec4f {
  let V = normalize(eye - w);
  let face = abs(dot(pDir, V));
  let rim = 1.0 - face;
  let t = time + seed;
  let n = wandNoise(pDir * ${f(NOISE_SCALE)} + vec3f(0.0, t * ${f(NOISE_SPEED)}, seed));
  let style = i32(styleF + 0.5);
  var rgb = vec3f(0.0);
  var a = 0.0;
  if (style == ${STYLE.glow}) {
    rgb = color * (rim * rim * ${f(SHELL_RIM_GAIN)} + pow(face, 3.0) * ${f(SHELL_FILL)} * (0.6 + 0.8 * n));
  } else if (style == ${STYLE.pull} || style == ${STYLE.push}) {
    var dir = -1.0;   // pull: rings run in toward the middle; push: out
    if (style == ${STYLE.pull}) { dir = 1.0; }
    var ring = 0.5 + 0.5 * sin(6.2831853 * (rim * ${f(SHELL_RINGS)} + dir * t * ${f(SHELL_RING_SPEED)}));
    ring = smoothstep(0.6, 1.0, ring) * (0.5 + n);
    rgb = color * (rim * rim * ${f(SHELL_RIM_GAIN)} * 0.6 + ring * ${f(SHELL_RING_GAIN)} * (0.25 + rim));
  } else if (style == ${STYLE.void}) {
    // a black heart, an accretion band swirling round its edge and a bright rim
    a = smoothstep(0.15, 0.7, face) * ${f(VOID_ALPHA)};
    let ang = t * ${f(VOID_SWIRL)};
    let q = vec3f(pDir.x * cos(ang) - pDir.z * sin(ang), pDir.y, pDir.x * sin(ang) + pDir.z * cos(ang));
    let swirl = wandNoise(q * ${f(NOISE_SCALE * 2)} + vec3f(seed));
    let band = smoothstep(0.35, 0.65, rim) * (1.0 - smoothstep(0.85, 1.0, rim));
    rgb = color * (pow(rim, 3.0) * ${f(SHELL_RIM_GAIN * 2)} + band * swirl * ${f(SHELL_RING_GAIN)});
  } else if (style == ${STYLE.cloud}) {
    let m = n + 0.5 * wandNoise(pDir * ${f(NOISE_SCALE * 2)} - vec3f(t * ${f(NOISE_SPEED)}));
    let dens = pow(face, 1.5) * smoothstep(0.45, 1.1, m);
    a = dens * ${f(CLOUD_ALPHA)};
    rgb = color * ${f(CLOUD_LIGHT)} * a;
  } else {
    rgb = color * pow(rim, 3.0) * ${f(SHOCK_GAIN)} * (0.7 + 0.6 * n);
  }
  return vec4f(rgb * alpha, a * alpha);
}`, [NOISE]);

// A beam's light where its surface (normal n, world w) faces the eye, along
// cells from the wand's tip.
const beamColor = wgslFn(/* wgsl */ `
fn wandBeam(n: vec3f, w: vec3f, eye: vec3f, along: f32, color: vec3f, alpha: f32, seed: f32, time: f32) -> vec4f {
  let face = abs(dot(normalize(n), normalize(eye - w)));
  let tex = wandNoise(vec3f((along - time * ${f(BEAM_SCROLL)}) * ${f(BEAM_TEXTURE)}, seed, face * 2.0));
  let shade = 1.0 + ${f(BEAM_TEXTURE_DEPTH)} * (2.0 * tex - 1.0);
  let rgb = color * pow(face, ${f(BEAM_SOFT)}) * ${f(BEAM_GAIN)} + vec3f(pow(face, ${f(BEAM_CORE_SOFT)}) * ${f(BEAM_CORE_WHITE)});
  return vec4f(rgb * shade * alpha, 1.0);
}`, [NOISE]);

// a material of these draws: unlit, unfogged, over the scene without depth writes
function drawMaterial(name, blend) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, ...blend });
  m.lights = false;
  m.fog = false;
  m.name = name;
  return m;
}
const ADDITIVE = { blending: THREE.AdditiveBlending };
// premultiplied (rgb adds light, alpha darkens what's behind)
const PREMULTIPLIED = {
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
};
const inst = (name, type) => attribute(name, type);

// the cores: a quad, x along the streak, y across, facing the eye
function coreMaterial() {
  const mat = drawMaterial('wand cores', ADDITIVE);
  const size = inst('iSize', 'float');
  const c = cameraViewMatrix.mul(vec4(inst('iCenter', 'vec3'), 1));
  const d = cameraViewMatrix.mul(vec4(inst('iVel', 'vec3'), 0)).xy;   // mat3(viewMatrix) · velocity
  const dl = length(d);
  const ax = select(dl.greaterThan(1e-5), d.div(dl), vec2(1, 0)), px = vec2(ax.y.negate(), ax.x);
  const halo = size.mul(CORE_HALO);
  const h = min(dl.mul(STREAK_S), size.mul(STREAK_MAX)).mul(0.5);
  // the quad covers the segment from the tail (−streak) to the head, plus the halo round it
  const xy = c.xy.add(ax.mul(h.negate().add(positionGeometry.x.mul(h.add(halo))))).add(px.mul(positionGeometry.y.mul(halo)));
  mat.vertexNode = cameraProjectionMatrix.mul(vec4(xy, c.z, c.w));
  const q = varying(vec2(positionGeometry.x.mul(h.add(halo)), positionGeometry.y.mul(halo)).div(halo));   // in halo radii, from the segment's middle
  const hq = varying(h.div(halo));
  mat.colorNode = Fn(() => {
    const k = coreColor({ q, h: hq, color: inst('iColor', 'vec3'), alpha: inst('iAlpha', 'float') }).toVar();
    Discard(k.w.lessThan(0));
    return k.xyz;
  })();
  return mat;
}

// the shells: spheres round each centre, radius iRadius
function shellMaterial(time) {
  const mat = drawMaterial('wand shells', PREMULTIPLIED);
  const w = modelWorldMatrix.mul(vec4(inst('iCenter', 'vec3').add(positionGeometry.mul(inst('iRadius', 'float'))), 1));
  mat.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(w));
  mat.colorNode = shellColor({
    pDir: varying(normalize(positionGeometry)), w: varying(w.xyz), eye: cameraPosition,
    color: inst('iColor', 'vec3'), styleF: inst('iStyle', 'float'), alpha: inst('iAlpha', 'float'), seed: inst('iSeed', 'float'), time,
  });
  return mat;
}

// the beams: an open cylinder from iFrom to iTo, tapered at the tip
function beamMaterial(time, scaleU) {
  const mat = drawMaterial('wand beams', { ...ADDITIVE, side: THREE.DoubleSide });
  const from = inst('iFrom', 'vec3'), axis = inst('iTo', 'vec3').sub(from);
  const len = max(length(axis), 1e-5);
  const dir = axis.div(len);
  const up = select(abs(dir.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
  const bx = normalize(cross(up, dir)), bz = cross(dir, bx);
  const taper = mix(float(BEAM_TIP_SHARE), float(1), smoothstep(0, min(scaleU.mul(BEAM_TAPER_CELLS).div(len), 0.5), positionGeometry.y));
  const n = bx.mul(positionGeometry.x).add(bz.mul(positionGeometry.z));
  const w = from.add(axis.mul(positionGeometry.y)).add(n.mul(inst('iRadius', 'float')).mul(taper));
  mat.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(w, 1)));
  mat.colorNode = beamColor({
    n: varying(n), w: varying(w), eye: cameraPosition, along: varying(positionGeometry.y.mul(len).div(scaleU)),
    color: inst('iColor', 'vec3'), alpha: inst('iAlpha', 'float'), seed: inst('iSeed', 'float'), time,
  });
  return mat;
}

// an instanced geometry over `base` with per-instance float attributes { name: size }
function instanced(base, max, layout) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  if (base.getAttribute('normal')) g.setAttribute('normal', base.getAttribute('normal'));
  const arrays = {};
  for (const [name, size] of Object.entries(layout)) {
    arrays[name] = new Float32Array(max * size);
    g.setAttribute(name, new THREE.InstancedBufferAttribute(arrays[name], size).setUsage(THREE.DynamicDrawUsage));
  }
  g.instanceCount = 0;
  return { g, arrays };
}
function drawMesh(name, geometry, material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name; mesh.frustumCulled = false;
  return mesh;
}

export function createWandVisuals(env) {
  const time = uniform(0);
  const scaleU = uniform(1);

  // ---- cores: a quad, x along the streak, y across
  const coreBase = new THREE.PlaneGeometry(2, 2);
  const cores = instanced(coreBase, CORE_MAX, { iCenter: 3, iVel: 3, iColor: 3, iSize: 1, iAlpha: 1 });
  const coreMesh = drawMesh('wand-cores', cores.g, coreMaterial());

  // ---- shells: premultiplied (rgb adds light, alpha darkens what's behind)
  const shellBase = new THREE.IcosahedronGeometry(1, SHELL_DETAIL);
  const shells = instanced(shellBase, SHELL_MAX, { iCenter: 3, iColor: 3, iRadius: 1, iStyle: 1, iAlpha: 1, iSeed: 1 });
  const shellMesh = drawMesh('wand-shells', shells.g, shellMaterial(time));

  // ---- beams: an open cylinder, y 0 → 1 from the tip to the end
  const beamBase = new THREE.CylinderGeometry(1, 1, 1, BEAM_SIDES, 1, true).translate(0, 0.5, 0);
  const beams = instanced(beamBase, BEAM_MAX, { iFrom: 3, iTo: 3, iColor: 3, iRadius: 1, iAlpha: 1, iSeed: 1 });
  const beamMesh = drawMesh('wand-beams', beams.g, beamMaterial(time, scaleU));
  // Three builds a mesh's pipelines at its first draw unless they were
  // compiled first (docs/webgpu.md B5, F8): the draws join the scene once
  // theirs are built (gpu.three.prepare), off the frame. Without a device
  // (the node checks) they join it at once.
  let disposed = false;
  const prepare = env.getSim?.()?.gpu?.three?.prepare;
  const join = () => { if (!disposed) env.scene?.add(coreMesh, shellMesh, beamMesh); };
  if (prepare && env.scene) {
    const group = new THREE.Group();
    group.add(coreMesh, shellMesh, beamMesh);
    prepare(group).then(join, (err) => console.error('Wand visuals failed to compile', err));
  } else join();

  const pulses = [];
  const vP = new THREE.Vector3(), vQ = new THREE.Vector3();
  let nCore = 0, nShell = 0, nBeam = 0, clock = 0;
  const toWorld = (g, out) => {
    out.copy(g).multiplyScalar(env.getScale?.() ?? 1);
    const origin = env.getVolume?.()?.position;
    return origin ? out.add(origin) : out;
  };
  function core(at, vel, size, rgb, gain, alpha) {
    if (nCore >= CORE_MAX) return;
    const a = cores.arrays, i = nCore++;
    at.toArray(a.iCenter, i * 3);
    if (vel) vel.toArray(a.iVel, i * 3); else a.iVel.fill(0, i * 3, i * 3 + 3);
    for (let k = 0; k < 3; k++) a.iColor[i * 3 + k] = rgb[k] * gain;
    a.iSize[i] = size; a.iAlpha[i] = alpha;
  }
  function shell(at, radius, rgb, style, alpha, seed) {
    if (nShell >= SHELL_MAX) return;
    const a = shells.arrays, i = nShell++;
    at.toArray(a.iCenter, i * 3);
    for (let k = 0; k < 3; k++) a.iColor[i * 3 + k] = rgb[k];
    a.iRadius[i] = radius; a.iStyle[i] = style; a.iAlpha[i] = alpha; a.iSeed[i] = seed;
  }
  function beam(from, to, radius, rgb, alpha, seed) {
    if (nBeam >= BEAM_MAX) return;
    const a = beams.arrays, i = nBeam++;
    from.toArray(a.iFrom, i * 3); to.toArray(a.iTo, i * 3);
    for (let k = 0; k < 3; k++) a.iColor[i * 3 + k] = rgb[k];
    a.iRadius[i] = radius; a.iAlpha[i] = alpha; a.iSeed[i] = seed;
  }
  const coreSize = (radius) => clamp(CORE_BASE + CORE_PER_RADIUS * (radius ?? 1), CORE_SIZE[0], CORE_SIZE[1]);
  const seedOf = (o) => (o.seed ??= Math.random() * 100);
  function flush(geo, n, mesh) {
    geo.g.instanceCount = n;
    for (const name in geo.arrays) {
      const attr = geo.g.getAttribute(name);
      attr.clearUpdateRanges?.();
      attr.needsUpdate = true;
    }
    mesh.visible = n > 0;
  }

  return {
    // A short effect where a spell lands: an impact flash (and a shock shell for a blast) at
    // `position`, or, given `from`, a beam from `from` (+ opts.offset: the wand's tip) to `position`.
    // opts: { material, offset }
    pulse(position, effect, radius = 0.6, from = null, opts = {}) {
      if (pulses.length >= PULSE_MAX) pulses.shift();
      const look = lookOf(effect, opts.material);
      const base = { look, radius, age: 0 };
      if (from) {
        pulses.push({ ...base, kind: 'beam', position: position.clone(), from: from.clone().add(opts.offset ?? vQ.set(0, 0, 0)), life: BEAM_LIFE });
      }
      pulses.push({ ...base, kind: 'flash', position: position.clone(), life: FLASH_LIFE });
      if (effect === 'pressure' && !from) pulses.push({ ...base, kind: 'shock', position: position.clone(), life: SHOCK_LIFE });
    },
    // items: { position, effect, material?, radius?, offset?, velocity?, kind: 'bolt' | 'field', age?, left? }
    update(items, dt) {
      clock += dt; time.value = clock % 1000;
      const scale = env.getScale?.() ?? 1;
      scaleU.value = scale;
      nCore = nShell = nBeam = 0;
      for (let i = pulses.length - 1; i >= 0; i--) if ((pulses[i].age += dt) >= pulses[i].life) pulses.splice(i, 1);
      for (const item of items) {
        const look = lookOf(item.effect, item.material);
        toWorld(item.offset ? vQ.copy(item.position).add(item.offset) : item.position, vP);
        if (item.kind !== 'field') {
          const vel = item.velocity ? vQ.copy(item.velocity).multiplyScalar(scale) : null;
          core(vP, vel, coreSize(item.radius) * scale, look.rgb, 1, 1);
          continue;
        }
        const fade = clamp((item.age ?? FIELD_FADE_IN) / FIELD_FADE_IN, 0, 1) * clamp((item.left ?? FIELD_FADE_OUT) / FIELD_FADE_OUT, 0, 1);
        if (item.effect === 'light') {
          const flicker = 1 + ORB_FLICKER * Math.sin(clock * ORB_FLICKER_RATE + seedOf(item));
          core(vP, null, ORB_SIZE * scale, look.rgb, flicker, fade);
          continue;
        }
        const style = STYLE[look.field] ?? STYLE.glow;
        shell(vP, Math.min(item.radius ?? 1, FIELD_RADIUS_MAX) * scale, style === STYLE.cloud ? look.raw : look.rgb, style, fade, seedOf(item));
      }
      for (const p of pulses) {
        const k = 1 - p.age / p.life;   // life left, 1 → 0
        toWorld(p.position, vP);
        if (p.kind === 'beam') {
          const width = clamp(BEAM_PER_RADIUS * p.radius, BEAM_WIDTH[0], BEAM_WIDTH[1]) * scale;
          beam(toWorld(p.from, vQ), vP, width * (0.6 + 0.4 * k), p.look.rgb, k ** BEAM_FADE, seedOf(p));
        } else if (p.kind === 'flash') {
          const size = clamp(FLASH_BASE + FLASH_PER_RADIUS * p.radius, FLASH_SIZE[0], FLASH_SIZE[1]) * scale;
          core(vP, null, size * (1 + (FLASH_GROW - 1) * (1 - k)), p.look.rgb, FLASH_GAIN, k * k);
        } else {
          const r = p.radius * (SHOCK_START + (1 - SHOCK_START) * Math.sqrt(1 - k)) * scale;
          shell(vP, r, p.look.rgb, STYLE.shock, k * k, seedOf(p));
        }
      }
      flush(cores, nCore, coreMesh); flush(shells, nShell, shellMesh); flush(beams, nBeam, beamMesh);
    },
    windowShifted(dx, dz) {
      for (const pulse of pulses) for (const v of [pulse.position, pulse.from]) {
        if (v) { v.x -= dx; v.z -= dz; }
      }
    },
    clear() {
      pulses.length = 0; nCore = nShell = nBeam = 0;
      flush(cores, 0, coreMesh); flush(shells, 0, shellMesh); flush(beams, 0, beamMesh);
    },
    get active() { return pulses.length > 0; },
    get stats() {
      return { instances: nCore + nShell + nBeam, cores: nCore, shells: nShell, beams: nBeam,
        capacity: CORE_MAX + SHELL_MAX + BEAM_MAX, drawCalls: 3 };
    },
    dispose() {
      disposed = true;
      for (const mesh of [coreMesh, shellMesh, beamMesh]) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
      coreBase.dispose(); shellBase.dispose(); beamBase.dispose();
      pulses.length = 0;
    },
  };
}
