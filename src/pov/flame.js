import * as THREE from 'three/webgpu';
import {
  uniform, varying, code, wgslFn, vec2, vec3, vec4, float, length, normalize, cross, dot, mix, max, clamp, select,
  modelWorldMatrix, modelViewMatrix, cameraViewMatrix, cameraProjectionMatrix, positionGeometry, time, Discard,
  agxToneMapping, sRGBTransferOETF, Fn,
} from 'three/tsl';

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
// viewmodel pass into the hands' glow layer, which post adds to the finished
// frame (docs/webgpu.md F3), tone mapped by itself (viewmodel.js
// renderViewmodels: the hands get no bloom).
//
// TSL (docs/webgpu.md F8): the card in the vertex stage, the flame's noise and
// colours in WGSL, as the GLSL had them.

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

let seedNext = 0;

// The card faces the eye and stands along the world's up (the screen's too in
// the hand), built in the vertex stage from the flame's origin and scale
// (modelMatrix, viewMatrix): x across the card, y up it (× the flame's height).
// Returns the clip position, and sets uvOut (x −1..1 across, y the card's span)
// and leanOut (lean in half-widths at the tip, stretch as a share of the height).
function cardVertex({ size, span, wind, topView, screenUp }) {
  const s = length(modelWorldMatrix.element(0).xyz);
  const base = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  const up = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.add(vec3(0, screenUp, 0)));
  const toEye = normalize(base.negate());
  const right0 = cross(up, toEye);
  const side = length(right0);   // sin of the angle between up and the eye's ray
  const right = select(side.greaterThan(1e-3), right0.div(side), vec3(1, 0, 0));
  const upq = normalize(cross(toEye, right));
  const h = size.y.mul(s).mul(mix(topView, float(1), side));
  const w = cameraViewMatrix.mul(vec4(wind, 0)).xyz.div(max(size.y.mul(s), 1e-6));
  const lean = vec2(clamp(dot(w, right).mul(LEAN_GAIN), -LEAN_MAX, LEAN_MAX), clamp(dot(w, upq).negate().mul(STRETCH_GAIN), -0.3, STRETCH_MAX));
  const y = mix(span.x, span.y, positionGeometry.y);
  const p = base.add(right.mul(positionGeometry.x).mul(size.z).mul(s)).add(upq.mul(y).mul(h));
  return { clip: cameraProjectionMatrix.mul(vec4(p, 1)), uv: vec2(positionGeometry.x, y), lean };
}

// the flame's noise: its own hash and value noise (not shaders/gfx/noise.js's: kept as drawn)
const NOISE = code(/* wgsl */ `
fn flameHash3(p0: vec3f) -> f32 { var p = fract(p0 * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
fn flameNoise(x: vec3f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(flameHash3(i), flameHash3(i + vec3f(1.0, 0.0, 0.0)), f.x), mix(flameHash3(i + vec3f(0.0, 1.0, 0.0)), flameHash3(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(flameHash3(i + vec3f(0.0, 0.0, 1.0)), flameHash3(i + vec3f(1.0, 0.0, 1.0)), f.x), mix(flameHash3(i + vec3f(0.0, 1.0, 1.0)), flameHash3(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
fn flameFbm(p0: vec3f) -> f32 {
  var p = p0;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) { s += a * flameNoise(p); p = p * 2.03 + vec3f(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.9375;
}`, [], 'wgsl');

// The flame's radiance (linear HDR, rgb) and coverage (w), or w < 0 where
// nothing of it is (discarded).
const flameColor = wgslFn(/* wgsl */ `
fn flameColor(uv: vec2f, lean: vec2f, time: f32, seed: f32, gain: f32, widthShare: f32) -> vec4f {
  let t = time + seed;
  // flame space: x in the flame's half-widths, y in its height (0 = foot)
  var p = vec2f(uv.x / widthShare, uv.y / (1.0 + lean.y));
  let y = clamp(p.y, 0.0, 1.0);
  p.x -= lean.x * y * y;
  // turbulence rising through it: a slow sway of the whole flame, big eddies, small fast licks
  let sway = flameNoise(vec3f(t * 1.1, seed, 0.0)) - 0.5;
  let slow = flameFbm(vec3f(p.x * 0.6, p.y * 1.5 - t * 1.7, t * 0.3 + seed));
  let fast = flameFbm(vec3f(p.x * 1.5, p.y * 3.4 - t * 3.8, t * 0.5 + seed * 1.3));
  let fine = flameNoise(vec3f(p.x * 3.5, p.y * 7.0 - t * 7.0, t * 0.8 + seed));
  p.x += (sway * 0.9 + (slow - 0.5) * 2.4) * y;
  // the egg: round below its widest (WIDE up the flame), drawn up to a ragged point
  let WIDE = 0.16;
  var below = 0.0;
  if (p.y < WIDE) { below = (WIDE - p.y) / (WIDE + ${FOOT.toFixed(2)}); }
  var above = 0.0;
  if (p.y > WIDE) { above = (p.y - WIDE) / (1.0 - WIDE); }
  let halfW = mix(1.0, 0.25, pow(above, 0.75));
  let r = length(vec2f(p.x / halfW, below + above * 0.42));
  var heat = 1.0 - r;
  heat += (fast - 0.5) * 1.1 * (0.25 + y) + (fine - 0.5) * 0.35 * y;
  heat -= smoothstep(0.25, 1.0, y) * fast * 0.95;   // the top tears into licks
  heat -= smoothstep(1.0, 1.25, p.y);
  // a wider, more torn envelope of cooler flame round the body: the torch's bushy outer flame
  var outer = 1.0 - length(vec2f(p.x / (halfW * ${OUTER_WIDTH.toFixed(2)}), below * 0.8 + above * 0.38));
  outer += (fast - 0.5) * 1.3 * (0.3 + y) - smoothstep(0.15, 1.0, y) * fast * 1.15 - smoothstep(1.0, 1.25, p.y);
  if (heat <= 0.0 && outer <= 0.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  heat = clamp(heat * 1.5, 0.0, 1.0);
  // colour by heat: deep red at the edges, orange, yellow, a pale core low in the flame
  var col = mix(vec3f(0.5, 0.03, 0.0), vec3f(1.0, 0.24, 0.02), smoothstep(0.0, 0.3, heat));
  col = mix(col, vec3f(1.0, 0.48, 0.08), smoothstep(0.25, 0.6, heat));
  col = mix(col, vec3f(1.0, 0.72, 0.32), smoothstep(0.6, 1.0, heat) * (1.0 - 0.6 * y));
  var cover = smoothstep(0.0, 0.18, heat);
  let shimmer = 0.8 + 0.4 * fine;
  var rad = col * cover * shimmer * gain * mix(${EDGE_GAIN.toFixed(3)}, ${CORE_GAIN.toFixed(3)}, heat * heat);
  let o = smoothstep(0.0, 0.35, outer);
  rad += vec3f(1.0, 0.2, 0.015) * o * shimmer * gain * ${OUTER_GAIN.toFixed(3)};
  cover = max(cover, o * 0.5);
  return vec4f(rad, cover);
}`, [NOISE]);

// the glow round it: a soft round haze (no coverage)
const glowColor = wgslFn(/* wgsl */ `
fn flameGlow(uv: vec2f, gain: f32) -> vec4f {
  let q = vec2f(uv.x, (uv.y - ${GLOW_CENTRE.toFixed(2)}) / ${GLOW_RADIUS.toFixed(2)});
  let d2 = dot(q, q);
  if (d2 >= 1.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let a = (exp(-d2 * 5.0) - exp(-5.0)) / (1.0 - exp(-5.0));
  return vec4f(vec3f(1.0, 0.42, 0.1) * a * a * gain * ${GLOW_GAIN.toFixed(3)}, 0.0);
}`);

// The overlay's tone mapping (mode 'overlay', the hands' glow layer): what
// three applied at the viewmodel pass's exposure, AgX then sRGB, or the sRGB
// curve alone in the raw views (post.settings.raw). viewmodel.js sets them.
export const flameOverlay = { exposure: uniform(1), raw: uniform(0) };

const quad = () => new THREE.PlaneGeometry(2, 1).translate(0, 0.5, 0);   // x −1..1, y 0..1

function cardMaterial(mode, color, u) {
  const overlay = mode === 'overlay';
  const v = cardVertex(u);
  const uvV = varying(v.uv), leanV = varying(v.lean);
  const c = color(uvV, leanV);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: !overlay,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: overlay ? THREE.ZeroFactor : THREE.OneFactor,
    blendDstAlpha: overlay ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
  });
  mat.lights = false;
  mat.vertexNode = v.clip;
  // nothing of the flame here: discarded (the GLSL's discard)
  const kept = (node) => Fn(() => { Discard(c.w.lessThan(0)); return node; })();
  if (overlay) {
    const rad = max(c.xyz, vec3(0));
    const mapped = select(flameOverlay.raw.greaterThan(0.5), clamp(rad, 0, 1), agxToneMapping(rad, flameOverlay.exposure));
    mat.colorNode = kept(sRGBTransferOETF(mapped));
    mat.opacityNode = float(0);
  } else {
    mat.colorNode = kept(c.xyz);
    mat.opacityNode = c.w;
  }
  mat.name = `flame ${mode}`;
  return mat;
}

export function createFlame({ width, height, mode = 'world' }) {
  const seed = uniform(((seedNext++ * 0.618034) % 1) * SEEDS);
  const wind = new THREE.Vector3();
  const gain = uniform(1);
  const shared = { wind: uniform(wind), topView: float(TOP_VIEW), screenUp: float(mode === 'overlay' ? SCREEN_UP : 0) };

  const flameMat = cardMaterial(mode, (uvN, lean) => flameColor({ uv: uvN, lean, time, seed, gain, widthShare: float(1 / CARD_WIDTH) }), {
    ...shared,
    size: uniform(new THREE.Vector3(width, height, width * CARD_WIDTH)),
    span: uniform(new THREE.Vector2(-FOOT, TIP + STRETCH_MAX)),
  });
  const glowMat = cardMaterial(mode, (uvN) => glowColor({ uv: uvN, gain }), {
    ...shared,
    size: uniform(new THREE.Vector3(height * GLOW_RADIUS, height, height * GLOW_RADIUS)),
    span: uniform(new THREE.Vector2(GLOW_CENTRE - GLOW_RADIUS, GLOW_CENTRE + GLOW_RADIUS)),
  });
  const obj = new THREE.Group();
  obj.name = 'flame';
  const glow = new THREE.Mesh(quad(), glowMat);
  const body = new THREE.Mesh(quad(), flameMat);
  for (const m of [glow, body]) {
    m.frustumCulled = false;   // the vertex stage places the card
    obj.add(m);
  }
  glow.renderOrder = 1;
  body.renderOrder = 2;

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
