import * as THREE from 'three';
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
// shader constants (GLSL defines)
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
const f = (x) => x.toFixed(4);          // a number as a GLSL float

const NOISE_GLSL = /* glsl */ `
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), u = fract(x); u = u * u * (3.0 - 2.0 * u);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), u.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), u.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), u.x), u.y), u.z);
  }`;

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
  const time = { value: 0 };
  const scaleU = { value: 1 };

  // ---- cores: a quad, x along the streak, y across
  const coreBase = new THREE.PlaneGeometry(2, 2);
  const cores = instanced(coreBase, CORE_MAX, { iCenter: 3, iVel: 3, iColor: 3, iSize: 1, iAlpha: 1 });
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      attribute vec3 iCenter, iVel, iColor;
      attribute float iSize, iAlpha;
      varying vec2 vQ; varying float vH; varying vec3 vColor; varying float vAlpha;
      void main() {
        vec4 c = viewMatrix * vec4(iCenter, 1.0);
        vec2 d = (mat3(viewMatrix) * iVel).xy;
        float dl = length(d);
        vec2 ax = dl > 1e-5 ? d / dl : vec2(1.0, 0.0), px = vec2(-ax.y, ax.x);
        float halo = iSize * ${f(CORE_HALO)};
        float streak = min(dl * ${f(STREAK_S)}, iSize * ${f(STREAK_MAX)});
        float h = streak * 0.5;
        // the quad covers the segment from the tail (−streak) to the head, plus the halo round it
        c.xy += ax * (-h + position.x * (h + halo)) + px * position.y * halo;
        vQ = vec2(position.x * (h + halo), position.y * halo) / halo;   // in halo radii, from the segment's middle
        vH = h / halo;
        vColor = iColor; vAlpha = iAlpha;
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vQ; varying float vH; varying vec3 vColor; varying float vAlpha;
      void main() {
        float dx = max(abs(vQ.x) - vH, 0.0);
        float r = length(vec2(dx, vQ.y));
        if (r >= 1.0) discard;
        float halo = (1.0 - r) * (1.0 - r);
        float core = exp(-r * r * ${f(CORE_SHARP)});
        float tail = vH > 0.0 ? smoothstep(-vH - 1.0, vH, vQ.x) : 1.0;   // brightest at the head
        vec3 rgb = vColor * halo * ${f(CORE_GAIN)} + vec3(core * ${f(CORE_WHITE)});
        gl_FragColor = vec4(rgb * vAlpha * mix(0.35, 1.0, tail), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const coreMesh = drawMesh('wand-cores', cores.g, coreMat);

  // ---- shells: premultiplied (rgb adds light, alpha darkens what's behind)
  const shellBase = new THREE.IcosahedronGeometry(1, SHELL_DETAIL);
  const shells = instanced(shellBase, SHELL_MAX, { iCenter: 3, iColor: 3, iRadius: 1, iStyle: 1, iAlpha: 1, iSeed: 1 });
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      attribute vec3 iCenter, iColor;
      attribute float iRadius, iStyle, iAlpha, iSeed;
      varying vec3 vW, vP, vColor; varying float vStyle, vAlpha, vSeed;
      void main() {
        vP = normalize(position);
        vec4 w = modelMatrix * vec4(iCenter + position * iRadius, 1.0);
        vW = w.xyz; vColor = iColor; vStyle = iStyle; vAlpha = iAlpha; vSeed = iSeed;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vW, vP, vColor; varying float vStyle, vAlpha, vSeed;
      ${NOISE_GLSL}
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float face = abs(dot(vP, V)), rim = 1.0 - face;
        float t = uTime + vSeed;
        float n = vnoise(vP * ${f(NOISE_SCALE)} + vec3(0.0, t * ${f(NOISE_SPEED)}, vSeed));
        int style = int(vStyle + 0.5);
        vec3 rgb = vec3(0.0); float a = 0.0;
        if (style == ${STYLE.glow}) {
          rgb = vColor * (rim * rim * ${f(SHELL_RIM_GAIN)} + pow(face, 3.0) * ${f(SHELL_FILL)} * (0.6 + 0.8 * n));
        } else if (style == ${STYLE.pull} || style == ${STYLE.push}) {
          float dir = style == ${STYLE.pull} ? 1.0 : -1.0;   // pull: rings run in toward the middle; push: out
          float ring = 0.5 + 0.5 * sin(6.2831853 * (rim * ${f(SHELL_RINGS)} + dir * t * ${f(SHELL_RING_SPEED)}));
          ring = smoothstep(0.6, 1.0, ring) * (0.5 + n);
          rgb = vColor * (rim * rim * ${f(SHELL_RIM_GAIN)} * 0.6 + ring * ${f(SHELL_RING_GAIN)} * (0.25 + rim));
        } else if (style == ${STYLE.void}) {
          // a black heart, an accretion band swirling round its edge and a bright rim
          a = smoothstep(0.15, 0.7, face) * ${f(VOID_ALPHA)};
          float ang = t * ${f(VOID_SWIRL)};
          vec3 q = vec3(vP.x * cos(ang) - vP.z * sin(ang), vP.y, vP.x * sin(ang) + vP.z * cos(ang));
          float swirl = vnoise(q * ${f(NOISE_SCALE * 2)} + vec3(vSeed));
          float band = smoothstep(0.35, 0.65, rim) * (1.0 - smoothstep(0.85, 1.0, rim));
          rgb = vColor * (pow(rim, 3.0) * ${f(SHELL_RIM_GAIN * 2)} + band * swirl * ${f(SHELL_RING_GAIN)});
        } else if (style == ${STYLE.cloud}) {
          float m = n + 0.5 * vnoise(vP * ${f(NOISE_SCALE * 2)} - vec3(t * ${f(NOISE_SPEED)}));
          float dens = pow(face, 1.5) * smoothstep(0.45, 1.1, m);
          a = dens * ${f(CLOUD_ALPHA)};
          rgb = vColor * ${f(CLOUD_LIGHT)} * a;
        } else {
          rgb = vColor * pow(rim, 3.0) * ${f(SHOCK_GAIN)} * (0.7 + 0.6 * n);
        }
        gl_FragColor = vec4(rgb * vAlpha, a * vAlpha);
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const shellMesh = drawMesh('wand-shells', shells.g, shellMat);

  // ---- beams: an open cylinder, y 0 → 1 from the tip to the end
  const beamBase = new THREE.CylinderGeometry(1, 1, 1, BEAM_SIDES, 1, true).translate(0, 0.5, 0);
  const beams = instanced(beamBase, BEAM_MAX, { iFrom: 3, iTo: 3, iColor: 3, iRadius: 1, iAlpha: 1, iSeed: 1 });
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uScale: scaleU },
    vertexShader: /* glsl */ `
      uniform float uScale;
      attribute vec3 iFrom, iTo, iColor;
      attribute float iRadius, iAlpha, iSeed;
      varying vec3 vN, vW, vColor; varying float vAlong, vAlpha, vSeed;
      void main() {
        vec3 axis = iTo - iFrom;
        float len = max(length(axis), 1e-5);
        vec3 dir = axis / len;
        vec3 up = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 bx = normalize(cross(up, dir)), bz = cross(dir, bx);
        float taper = mix(${f(BEAM_TIP_SHARE)}, 1.0, smoothstep(0.0, min(${f(BEAM_TAPER_CELLS)} * uScale / len, 0.5), position.y));
        vN = bx * position.x + bz * position.z;
        vec3 w = iFrom + axis * position.y + vN * iRadius * taper;
        vW = w; vAlong = position.y * len / uScale;
        vColor = iColor; vAlpha = iAlpha; vSeed = iSeed;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vN, vW, vColor; varying float vAlong, vAlpha, vSeed;
      ${NOISE_GLSL}
      void main() {
        float face = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
        float tex = vnoise(vec3((vAlong - uTime * ${f(BEAM_SCROLL)}) * ${f(BEAM_TEXTURE)}, vSeed, face * 2.0));
        float shade = 1.0 + ${f(BEAM_TEXTURE_DEPTH)} * (2.0 * tex - 1.0);
        vec3 rgb = vColor * pow(face, ${f(BEAM_SOFT)}) * ${f(BEAM_GAIN)} + vec3(pow(face, ${f(BEAM_CORE_SOFT)}) * ${f(BEAM_CORE_WHITE)});
        gl_FragColor = vec4(rgb * shade * vAlpha, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beamMesh = drawMesh('wand-beams', beams.g, beamMat);
  env.scene?.add(coreMesh, shellMesh, beamMesh);

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
      for (const mesh of [coreMesh, shellMesh, beamMesh]) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
      coreBase.dispose(); shellBase.dispose(); beamBase.dispose();
      pulses.length = 0;
    },
  };
}
