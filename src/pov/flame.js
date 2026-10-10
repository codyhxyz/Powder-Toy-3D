import * as THREE from 'three';

// A live flame (the torch's), drawn by a shader on a card that faces the eye
// and stands along the world's up, so the flame always rises, however the
// torch is held or lies. Seen from above or below the card shortens toward a
// round blob. A second, wider card is the glow round it (the light the air
// scatters; in the hand it also stands in for the bloom the hands don't get).
//
// The shape is the classic noise flame: an egg, round at the foot and drawn
// out to a point, pushed sideways by turbulence that rises through it and
// grows toward the tip, which eats the top into licking tongues. Its heat
// picks a colour from deep red at the edges through orange and yellow to a
// pale core, and a brightness that climbs steeply with it (linear HDR).
//
// Air moving past it leans it over: setWind(v) takes the air's velocity past
// the flame (world units/s, the flame's own motion negated), and the flame
// bends away along it, more toward the tip, and stretches when the air comes
// from above (the torch swung down).
//
//   const f = createFlame({ width, height, mode: 'world' | 'overlay' });   // sizes in the parent's units
//   parent.add(f.obj);                 // f.obj's origin is the flame's foot
//   f.setWind(airVelocity);            // world units/s
//   f.setFlicker(k);                   // brightness × k (the light's flicker, so the two move together)
//   f.dispose();
//
// mode 'world': drawn into the scene's HDR target (light added, its coverage in
// alpha, as the effects' particles are). mode 'overlay': drawn by the
// viewmodel pass straight onto the finished frame, tone mapped by itself
// (viewmodel.js renderViewmodels, its glow layer: the hands get no bloom).

// card shape, in units of the flame's height (y) and half-width (x)
const FOOT = 0.2;              // the card reaches this far below the foot (the egg's round bottom)
const CARD_WIDTH = 3;          // card half-width, × the flame's half-width: room for the licks to sway and lean out
const TOP_VIEW = 0.45;         // the card's height left when seen straight from above or below
// In the hand (mode 'overlay') the torch is fixed to the view, so a flame that rose straight up in the
// world would swing across the screen as you look down; its up is the world's plus this much of the screen's.
const SCREEN_UP = 1;
// the glow card: a soft round haze centred up the flame
const GLOW_RADIUS = 1.5;       // × the flame's height
const GLOW_CENTRE = 0.35;      // × the flame's height above the foot
// how much the air bends the flame (shader), and how far at most
const LEAN_GAIN = 0.4;         // flame half-widths of lean per (world unit/s ÷ flame height)
const LEAN_MAX = 2.5;          // flame half-widths
const STRETCH_GAIN = 0.12;     // height share per (world unit/s ÷ flame height) of air from above
const STRETCH_MAX = 0.6;
// brightness (linear HDR radiance)
const CORE_GAIN = 2.8;         // at the hottest point (blooms; tone maps to a pale yellow)
const EDGE_GAIN = 0.3;         // at the cool edge of the body
const GLOW_GAIN = 0.12;        // the glow's centre
const OUTER_WIDTH = 1.5;       // the outer flame's width, × the body's
const OUTER_GAIN = 0.45;       // its brightness: a dim red-orange
const TIP = 1.2;               // the card reaches this far up (× height): the licks break off above the body
const SEEDS = 97;              // flames' noise offsets are spread over this many units

const time = { value: 0 };
let seedNext = 0;

const VERT = /* glsl */ `
uniform vec3 uSize;      // half-width, height, card half-width (object units)
uniform vec2 uSpan;      // the card's y range (× height)
uniform vec3 uWind;      // world units/s of air past the flame
uniform float uTopView;
uniform float uScreenUp;   // how far its up leans toward the screen's (0 = the world's)
varying vec2 vUv;        // x: −1..1 across the card; y: the card's span (× height, 0 = foot)
varying vec2 vLean;      // lean (half-widths at the tip) and stretch (share of the height)
void main() {
  float s = length(modelMatrix[0].xyz);
  vec3 base = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz + vec3(0.0, uScreenUp, 0.0));
  vec3 toEye = normalize(-base);
  vec3 right = cross(up, toEye);
  float side = length(right);   // sin of the angle between up and the eye's ray
  right = side > 1e-3 ? right / side : vec3(1.0, 0.0, 0.0);
  vec3 upq = normalize(cross(toEye, right));
  float h = uSize.y * s * mix(uTopView, 1.0, side);
  vec3 w = (viewMatrix * vec4(uWind, 0.0)).xyz / max(uSize.y * s, 1e-6);
  vLean = vec2(clamp(dot(w, right) * ${LEAN_GAIN.toFixed(3)}, -${LEAN_MAX.toFixed(2)}, ${LEAN_MAX.toFixed(2)}),
               clamp(-dot(w, upq) * ${STRETCH_GAIN.toFixed(3)}, -0.3, ${STRETCH_MAX.toFixed(2)}));
  float y = mix(uSpan.x, uSpan.y, position.y);
  vUv = vec2(position.x, y);
  vec3 p = base + right * position.x * uSize.z * s + upq * y * h;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const NOISE = /* glsl */ `
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.9375;
}`;

// out: radiance (linear HDR) and coverage
const OUT_WORLD = 'gl_FragColor = vec4(rad, cover);';
const OUT_OVERLAY = /* glsl */ `gl_FragColor = vec4(rad, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = 0.0;`;

const flameFrag = (out) => /* glsl */ `
uniform float uTime, uSeed, uGain, uWidthShare;
varying vec2 vUv;
varying vec2 vLean;
${NOISE}
void main() {
  float t = uTime + uSeed;
  // flame space: x in the flame's half-widths, y in its height (0 = foot)
  vec2 p = vec2(vUv.x / uWidthShare, vUv.y / (1.0 + vLean.y));
  float y = clamp(p.y, 0.0, 1.0);
  p.x -= vLean.x * y * y;
  // turbulence rising through it: a slow sway of the whole flame, big eddies, small fast licks
  float sway = vnoise(vec3(t * 1.1, uSeed, 0.0)) - 0.5;
  float slow = fbm(vec3(p.x * 0.6, p.y * 1.5 - t * 1.7, t * 0.3 + uSeed));
  float fast = fbm(vec3(p.x * 1.5, p.y * 3.4 - t * 3.8, t * 0.5 + uSeed * 1.3));
  float fine = vnoise(vec3(p.x * 3.5, p.y * 7.0 - t * 7.0, t * 0.8 + uSeed));
  p.x += (sway * 0.9 + (slow - 0.5) * 2.4) * y;
  // the egg: round below its widest (WIDE up the flame), drawn up to a ragged point
  const float WIDE = 0.16;
  float below = p.y < WIDE ? (WIDE - p.y) / (WIDE + ${FOOT.toFixed(2)}) : 0.0;
  float above = p.y > WIDE ? (p.y - WIDE) / (1.0 - WIDE) : 0.0;
  float halfW = mix(1.0, 0.25, pow(above, 0.75));
  float r = length(vec2(p.x / halfW, below + above * 0.42));
  float heat = 1.0 - r;
  heat += (fast - 0.5) * 1.1 * (0.25 + y) + (fine - 0.5) * 0.35 * y;
  heat -= smoothstep(0.25, 1.0, y) * fast * 0.95;   // the top tears into licks
  heat -= smoothstep(1.0, 1.25, p.y);
  // a wider, more torn envelope of cooler flame round the body: the torch's bushy outer flame
  float outer = 1.0 - length(vec2(p.x / (halfW * ${OUTER_WIDTH.toFixed(2)}), below * 0.8 + above * 0.38));
  outer += (fast - 0.5) * 1.3 * (0.3 + y) - smoothstep(0.15, 1.0, y) * fast * 1.15 - smoothstep(1.0, 1.25, p.y);
  if (heat <= 0.0 && outer <= 0.0) discard;
  heat = clamp(heat * 1.5, 0.0, 1.0);
  // colour by heat: deep red at the edges, orange, yellow, a pale core low in the flame
  vec3 col = mix(vec3(0.5, 0.03, 0.0), vec3(1.0, 0.24, 0.02), smoothstep(0.0, 0.3, heat));
  col = mix(col, vec3(1.0, 0.48, 0.08), smoothstep(0.25, 0.6, heat));
  col = mix(col, vec3(1.0, 0.72, 0.32), smoothstep(0.6, 1.0, heat) * (1.0 - 0.6 * y));
  float cover = smoothstep(0.0, 0.18, heat);
  float shimmer = 0.8 + 0.4 * fine;
  vec3 rad = col * cover * shimmer * uGain * mix(${EDGE_GAIN.toFixed(3)}, ${CORE_GAIN.toFixed(3)}, heat * heat);
  float o = smoothstep(0.0, 0.35, outer);
  rad += vec3(1.0, 0.2, 0.015) * o * shimmer * uGain * ${OUTER_GAIN.toFixed(3)};
  cover = max(cover, o * 0.5);
  ${out}
}`;

const glowFrag = (out) => /* glsl */ `
uniform float uGain;
varying vec2 vUv;
void main() {
  vec2 q = vec2(vUv.x, (vUv.y - ${GLOW_CENTRE.toFixed(2)}) / ${GLOW_RADIUS.toFixed(2)});
  float d2 = dot(q, q);
  if (d2 >= 1.0) discard;
  float a = (exp(-d2 * 5.0) - exp(-5.0)) / (1.0 - exp(-5.0));
  float cover = 0.0;
  vec3 rad = vec3(1.0, 0.42, 0.1) * a * a * uGain * ${GLOW_GAIN.toFixed(3)};
  ${out}
}`;

const quad = () => new THREE.PlaneGeometry(2, 1).translate(0, 0.5, 0);   // x −1..1, y 0..1

function cardMaterial(mode, frag, uniforms) {
  const overlay = mode === 'overlay';
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag(overlay ? OUT_OVERLAY : OUT_WORLD),
    transparent: true, depthWrite: false, depthTest: !overlay,
    toneMapped: overlay,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: overlay ? THREE.ZeroFactor : THREE.OneFactor,
    blendDstAlpha: overlay ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
  });
}

export function createFlame({ width, height, mode = 'world' }) {
  const seed = ((seedNext++ * 0.618034) % 1) * SEEDS;
  const wind = new THREE.Vector3();
  const gain = { value: 1 };
  const shared = { uWind: { value: wind }, uTopView: { value: TOP_VIEW }, uScreenUp: { value: mode === 'overlay' ? SCREEN_UP : 0 } };

  const flameMat = cardMaterial(mode, flameFrag, {
    ...shared,
    uSize: { value: new THREE.Vector3(width, height, width * CARD_WIDTH) },
    uSpan: { value: new THREE.Vector2(-FOOT, TIP + STRETCH_MAX) },
    uTime: time, uSeed: { value: seed }, uGain: gain,
    uWidthShare: { value: 1 / CARD_WIDTH },
  });
  const glowMat = cardMaterial(mode, glowFrag, {
    ...shared,
    uSize: { value: new THREE.Vector3(height * GLOW_RADIUS, height, height * GLOW_RADIUS) },
    uSpan: { value: new THREE.Vector2(GLOW_CENTRE - GLOW_RADIUS, GLOW_CENTRE + GLOW_RADIUS) },
    uGain: gain,
  });
  const obj = new THREE.Group();
  obj.name = 'flame';
  const glow = new THREE.Mesh(quad(), glowMat);
  const body = new THREE.Mesh(quad(), flameMat);
  for (const m of [glow, body]) {
    m.frustumCulled = false;   // the vertex shader places the card
    obj.add(m);
  }
  glow.renderOrder = 1;
  body.renderOrder = 2;
  body.onBeforeRender = () => { time.value = performance.now() / 1000; };

  return {
    obj,
    meshes: [glow, body],
    setWind(v) { wind.copy(v); },
    setFlicker(k) { gain.value = k; },
    dispose() {
      obj.removeFromParent();
      for (const m of [glow, body]) { m.geometry.dispose(); m.material.dispose(); }
    },
  };
}
