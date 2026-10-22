import { skyGLSL, skyViewGLSL, SUN_TAN_RADIUS } from '../../gfx/sky.js';
import { cloudDeckGLSL } from './clouds.js';
import { LAMP_UNIT, LAMP_FIXED_PAD } from '../../gfx/lamps.js';
import { WAND_LIGHTS } from '../bindings.js';
import { libChecks } from './lib.js';
import { lighthouseGLSL } from './lighthouse.js';
import { worldSunAccessWGSL, worldSunReaderWGSL } from './worldSun.js';

// The count lives in shaders/bindings.js beside the uniform arrays it sizes
// (gfx/uniforms.js imports it from here).
export { WAND_LIGHTS };

// The probes' spherical-harmonic constants and the open sky's band-0 sky
// visibility, for the shaders below and CPU readers of the probes (pov/viewmodel.js).
export const SH_Y0 = 0.282095;          // Y00
export const SH_Y1 = 0.488603;          // Y1m = SH_Y1 * (x, y, z)
export const SKYVIS_OPEN_DC = 0.5;      // SH_Y0 * c0.a of the open sky: the sphere's upper half
// Surfaces read the probes this many cells out along their normal (GI_OFFSET below).
export const GI_OFFSET_CELLS = 3;
// The sun shadow map's layout and its test inside volumes (sunBasis, sunMapShadow
// below), for CPU readers of the map too (pov/viewmodel.js: the sun on the hands).
export const meanSigmaWGSL = 'fn meanSigma(id: i32) -> f32 { return dot(SIGMA(id), vec3f(1.0 / 3.0)); }';
export const SHADOW_TINT_ID_SCALE = 256;   // w = tint element id * this + optical depth (see below)
export const SHADOW_PAD = 1;               // voxels the map's disc reaches past the box's bounding sphere
export const VOLUME_SHADOW_BIAS = 0.6;     // depth bias (voxels) for points inside volumes (no normal)

// Soft-shadow taps per pass (blocker search, then filter).
const PCSS_TAPS = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Points of an n-point Vogel (sunflower) disc of radius 1, as WGSL vec2fs.
const vogel = (n) => Array.from({ length: n }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / n), a = i * GOLDEN_ANGLE;
  return `vec2f(${(r * Math.cos(a)).toFixed(5)}, ${(r * Math.sin(a)).toFixed(5)})`;
}).join(', ');

/**
 * Lighting: sun + shadow map, sky, the GI probe volume, the glow (emission)
 * volume and ambient occlusion. Shading code only talks to the scene's light
 * through these. WGSL (the name is the GLSL version's, docs/webgpu.md W2),
 * after core and noise in lib() (shaders/gfx/lib.js), which also brings the
 * clouds' deck. Per-frame values come from FrameUniforms (FU), as the GLSL's
 * uniforms did: what was SUN_COL (#define uSunCol) is FU.sunCol, uShadows is
 * FU.shadows != 0u, and so on.
 *
 * The functions, by what they need:
 *   sky (FU only)       airMass, skyRadiance(d), skyColor(d), skyAmbient(n)
 *   shadow map frame    sunBasis(&c, &R, &u, &v): the map's centre, radius and
 *                       axes; shared bit for bit by its writer and every reader
 *   the map (8, 9)      sunMapShadow(hp, n) (a surface point and its normal),
 *                       sunMapShadowAt(p) (a point inside a volume), and with
 *                       the clouds sunShadow(hp, n) / sunShadowAt(p): the GLSL's
 *                       two overloads of each, renamed (WGSL has none, H1.12)
 *   caustics            rippleH, underPool, causticGain
 *   exact sun ray       smoothOpaque(p), sunRayClear(ro, tLim)
 *   GI probes (4-7)     probeTex(t, p), probeAt(p), surfProbe(p, n) -> Probe
 *   SH evaluation       giIrradiance(g, n), giRadiance(g, d, blur), giSkyVis(g, n)
 *   the air's sky       giAirSkyVis(p) (the probes: band 0's sky visibility),
 *                       giAirSkyHeld(p) -> vec2f (from the probes already in)
 *   glow volume (3)     sampleLight(gp) (with wandLight(p))
 *   AO                  occluder(c), faceAO(cell, n, hp), solidity(p), fieldAO(p, n)
 *   traced rays         nearSmoothIn, traceNear(ro, rd, tLim, opaqueOnly, selfSkip, &hc, &hn),
 *                       pixRand(k), lampRand(i) (the hand lamps' shadows)
 *   near field          nearSolid(q, &id, &a), hitLight(p, n, alb, emit), nearField(p, ng, n, irr, &vis) (map + probes)
 *   glow lights         glowWorthIt(local, irr), glowLum(p), glowLightScale(p, ng, n)
 *   hand lamps          lampLight(p, ng, n), lampShade(p, ng, n, soft, view) (+ specular)
 *   GGX specular        smithV, ggxSpecA, ggxSpec
 * Options (lib() sets them per L.LIGHTING variant): shadowMap: false leaves
 * out what reads the shadow map (the shadow kernel writes it); probes: false
 * what samples the GI bands (GI gather writes them). nearField needs both.
 * giUniforms: the GI passes' uniforms. Their GLSL material (sim.js
 * giUniforms) set no uCaustics, uTime, uFrame or uCaveAmbient, so those read
 * 0 there; GI binds the shared FrameUniforms, so here the four are literal
 * zeros in the text instead (docs/webgpu.md E): no caustics in the sun
 * lookups (sunShadow and sunShadowAt as GI calls them), causticGain at time
 * 0, frame 0 in the per-frame jitter (PCSS, pixRand, the glow candidates), no
 * ambient floor in giIrradiance and giRadiance.
 * @param {{ shadowMap?: boolean, probes?: boolean, giUniforms?: boolean }} [opts]
 */
export const lightingGLSL = ({ shadowMap = true, probes = true, giUniforms = false, far = false, backend = 'box' } = {}) => {
  // FU.caustics != 0u, FU.time, f32(FU.frame), or the GI passes' zeros
  const caustics = giUniforms ? 'false' : 'FU.caustics != 0u';
  const time = giUniforms ? '0.0' : 'FU.time';
  const frame = giUniforms ? '0.0' : 'f32(FU.frame)';
  // FU.caveAmbient, or the GI passes' zero: their material had no uCaveAmbient
  // (main's sim.js giUniforms), so giSource's bounce took none
  const caveAmbient = giUniforms ? 'vec3f(0.0)' : 'FU.caveAmbient';
  return /* wgsl */ `
${backend === 'world' ? worldSunAccessWGSL : ''}const PI_L: f32 = 3.14159265;
// Lighting upgrades, each switchable at run time (Settings → Lighting):
// FU.nearGI (traced voxel AO and nearby bounce light), FU.glowLights (lava and
// fire as shadowed lights), FU.caustics (sun caustics through liquid).
// Hand lamps (src/pov/lamps.js): point lights the first-person body carries or
// throws, the torch and the lantern: FU.lampPos[i] (xyz grid cells, w its
// reach in cells), FU.lampCol[i] (rgb: linear colour × intensity, in the
// sunlight's units at LAMP_UNIT cells; w 1: fixed, a wall torch's),
// FU.lampShape[i] (x: the light's radius, y: its length upright, in cells:
// the flame's or the lantern glass's own size, gfx/lamps.js),
// FU.lampCount of them lit (0 costs nothing).
// FU.caveAmbient: a scene's ambient floor, radiance (gfx/uniforms.js; a world
// scene's ambient), 0 elsewhere.

// ---- sun and sky: a clear-sky atmosphere (gfx/sky.js) ----
// Values that only depend on the sun are computed once per frame in JS:
// FU.sunExt (transmittance of the air along the sun's path), FU.sunCol (direct
// sunlight at the ground: warmer and dimmer as the sun gets lower), FU.skyUp
// (open-sky irradiance on an upward surface), FU.ground (radiance of the
// sunlit, sky-lit ground around the box), FU.keyLight (sunlight's colour
// scale: 1 by day, dim blue under the moon, gfx/daylight.js).
${skyGLSL()}
// World's cumulus deck (clouds.js): sunShadow multiplies its shadow in.
${cloudDeckGLSL}
// airMass, skyRadiance, skyColor: gfx/sky.js skyViewGLSL (the box's backdrop draws the same sky, gfx/overlays.js)
${skyViewGLSL({ source: far })}
// Two Henyey–Greenstein lobes (hgPhase, gfx/sky.js): back lobe gBack, forward
// lobe gFwd with weight wFwd (the clouds' silver lining, the gas's glow).
fn hgPhase2(mu: f32, gBack: f32, gFwd: f32, wFwd: f32) -> f32 {
  return mix(hgPhase(mu, gBack), hgPhase(mu, gFwd), wFwd);
}
// Rough open-environment irradiance / pi on a surface facing n (no occlusion):
// the sky over the share of n's hemisphere it covers, the ground below. The GI
// probes integrate the real thing; this is for code without them.
fn skyAmbient(n: vec3f) -> vec3f {
  let up = 0.5 + 0.5 * n.y;
  return up * FU.skyUp + (1.0 - up) * FU.ground;
}

// ---- sun shadow map ----
// An orthographic shadow map covering the box, traced once per derived frame
// from the sun (FU.shadowRes² texels; the shadow kernel writes it). Each texel
// stores (depth of first opaque surface, depth where translucent material
// starts, depth where it ends, tint element id * SHADOW_TINT_ID_SCALE +
// optical depth accumulated through it), as tShadow (rgba32float), and its x
// again as tShadowX (r32float) for the soft shadows' 16 taps (docs/webgpu.md
// E). Points in between get a proportional share. Both are read with
// textureLoad only (unfilterable).
// w packing: id * this + optical depth (< this). The map is 32-bit float, so
// with element ids up to 255 (docs/elements.md) w stays below 2^16 and keeps
// the optical depth to 2^-8 (0.4% in the light let through). Depth past
// SCALE - 1 lets no light through anyway (e^-255); it only flattens the
// proportional share inside a medium that thick (~270 cells of oil along the
// sun, 10,000 of water).
const SHADOW_TINT_ID_SCALE: f32 = ${SHADOW_TINT_ID_SCALE.toFixed(1)};
const SHADOW_PAD: f32 = ${SHADOW_PAD.toFixed(1)};               // voxels the map's disc reaches past the box's bounding sphere
const SHADOW_NORMAL_OFFSET: f32 = 0.002;   // voxels a surface lookup moves off the surface along its normal
// Hard-map depth bias (voxels), see sunMapShadow: at least SHADOW_BIAS_MIN, else the
// PCF slope term (n.sun floored at SHADOW_BIAS_NS_MIN) plus SHADOW_BIAS_PAD.
const SHADOW_BIAS_MIN: f32 = 0.8;
const SHADOW_BIAS_NS_MIN: f32 = 0.25;
const SHADOW_BIAS_PAD: f32 = 0.1;
const VOLUME_SHADOW_BIAS: f32 = ${VOLUME_SHADOW_BIAS.toFixed(1)};       // depth bias (voxels) for points inside volumes (no normal)
// Exact sun rays: smooth opaque surfaces block them where their field is
// inside (by SUN_RAY_ISO_MARGIN: trilinear creases wobble about the level),
// except within SUN_RAY_SMOOTH_SKIP voxels of the start, which sits on one.
const SUN_RAY_SMOOTH_SKIP: f32 = 0.5;
const SUN_RAY_ISO_MARGIN: f32 = 0.02;

// Soft shadows (PCSS): the sun is a disc, so a shadow's edge blurs with the
// distance from its caster. tan of the sun's apparent radius: the real sun is
// 0.27 deg; 1.2 deg stands in for a slightly hazy sky, so penumbrae read at
// the scale of the box while contact shadows stay crisp.
const SUN_TAN_RADIUS: f32 = ${SUN_TAN_RADIUS};   // (gfx/sky.js: the backdrop's sun disc is this size too)
const PCSS_TAPS: i32 = ${PCSS_TAPS};                 // taps for the blocker search, and again for the filter
const PCSS_HARD_TEXELS: f32 = 1.0;  // penumbra radius (texels) below which the hard path settles the edge
const PCSS_NS_MIN: f32 = 0.2;       // n.sun floor for the receiver-plane slope (grazing receivers)
const PCSS_BIAS: f32 = 0.35;        // depth bias (voxels) on top of the receiver plane
const GOLDEN_ANGLE: f32 = ${GOLDEN_ANGLE.toFixed(8)};

// ---- caustics: sunlight focused by the ripples on open liquid ----
// The ripple height field (gfx/liquid.js tilts liquid normals with it): a
// slowly drifting two-octave value noise, in noise space q = xz * RIPPLE_FREQ.
const RIPPLE_FREQ: f32 = 0.3;        // cycles per cell, first octave
const RIPPLE_DRIFT: f32 = 0.6;       // noise-space speed, per second
const RIPPLE_OCT2: f32 = 2.1;        // second octave: frequency multiple ...
const RIPPLE_OCT2_AMP: f32 = 0.5;    // ... height multiple ...
const RIPPLE_OCT2_DRIFT: f32 = 1.3;  // ... drift multiple ...
const RIPPLE_OCT2_SHIFT: f32 = 7.3;  // ... and offset, so it doesn't line up with the first
// The ripples' height at noise-space point q and drift time t.
fn rippleH(q: vec2f, t: f32) -> f32 {
  return vnoise(vec3f(q, t)) + RIPPLE_OCT2_AMP * vnoise(vec3f(q * RIPPLE_OCT2 + RIPPLE_OCT2_SHIFT, t * RIPPLE_OCT2_DRIFT));
}
// Refraction bends a beam entering at a surface slope g by about
// CAUSTIC_BEND * g (1 - 1/n for water), so at depth D it lands displaced by
// D * CAUSTIC_BEND * grad h. The light of a patch of surface then covers
// det(I + D * CAUSTIC_BEND * Hessian(h)) ~ 1 + D * CAUSTIC_BEND * lap(h) of
// the bed: crests focus it, troughs spread it. The sun's disc blurs the
// pattern with depth (the penumbra of a beam is D * SUN_TAN_RADIUS), which
// fades its contrast like a Gaussian of the ripples' wavelength.
// The rendered ripples are kept gentle (RIPPLE_SLOPE) so the mirror stays
// readable; light sees the slopes of real wind ripples, a few degrees steeper.
const CAUSTIC_BEND: f32 = 0.25;       // 1 - 1/1.33
const CAUSTIC_SLOPE: f32 = 0.18;      // ripple slope per unit noise gradient, for the light
const CAUSTIC_EPS: f32 = 0.35;        // finite-difference step of the Laplacian, noise space (wide enough to
                                      // smooth over the value noise's lattice, whose curvature jumps there)
const CAUSTIC_BED_GAP: f32 = 2.0;     // cells: the liquid must reach this close to a point (along the sun) to
                                      // focus light on it; a drop or puddle higher up just tints its shadow
const CAUSTIC_FILL: f32 = 0.7;        // share of the path below the liquid's top that must be liquid: a pool
                                      // (water soaked into sand or gravel has no open surface to focus with)
const CAUSTIC_MAX: f32 = 4.0;         // brightest focus (beams cross past it)
const CAUSTIC_MIN: f32 = 0.3;         // darkest spread
// Mean extinction of element id over the three channels (an optical depth's grey share).
${meanSigmaWGSL}
// Whether a shadow-map texel sm, seen from depth d, has the receiver under a body of liquid tid.
fn underPool(sm: vec4f, d: f32, tid: i32) -> bool {
  if (RCLASS(tid) != R_LIQUID || d <= sm.y || d >= sm.z + CAUSTIC_BED_GAP) { return false; }
  let lenL = (sm.w - f32(tid) * SHADOW_TINT_ID_SCALE) / max(meanSigma(tid), 1e-4);
  return lenL >= CAUSTIC_FILL * (min(d, sm.z) - sm.y);
}
// The Laplacian's taps: the centre and four neighbours. Every caller asks only with FU.caustics set
// (1), so the bound is exactly CAUSTIC_TAPS; read from the uniform, Metal can't fold it and unroll.
const CAUSTIC_TAPS: u32 = 5u;
fn causticTaps() -> u32 { return min(CAUSTIC_TAPS, CAUSTIC_TAPS * FU.caustics); }
// The light the ripples focus on grid point p lying D cells under the surface (along the sun).
fn causticGain(p: vec3f, D: f32) -> f32 {
  let s = p + FU.sun * D;   // where the light entered the liquid
  let q = worldPos(s).xz * RIPPLE_FREQ;   // the ripples are anchored in the world (gfx/liquid.js)
  let t = ${time} * RIPPLE_DRIFT;
  // the centre and its four neighbours, one rippleH a tap in a loop Metal can't unroll (each
  // inlined copy is two value noises, and the sun lookups inline this at every call: cold
  // compile, docs/webgpu.md B5); the neighbours add in the order the Laplacian always summed them
  var h0 = 0.0;
  var around = 0.0;
  for (var k = 0u; k < causticTaps(); k++) {
    var qk = q;
    if (k == 1u) { qk = q + vec2f(CAUSTIC_EPS, 0.0); }
    else if (k == 2u) { qk = q - vec2f(CAUSTIC_EPS, 0.0); }
    else if (k == 3u) { qk = q + vec2f(0.0, CAUSTIC_EPS); }
    else if (k == 4u) { qk = q - vec2f(0.0, CAUSTIC_EPS); }
    let h = rippleH(qk, t);
    if (k == 0u) { h0 = h; } else if (k == 1u) { around = h; } else { around += h; }
  }
  let lapQ = (around - 4.0 * h0) / (CAUSTIC_EPS * CAUSTIC_EPS);
  let lap = CAUSTIC_SLOPE * RIPPLE_FREQ * lapQ;   // per cell
  let I = clamp(1.0 / max(1.0 + D * CAUSTIC_BEND * lap, 1e-3), CAUSTIC_MIN, CAUSTIC_MAX);
  let blur = D * SUN_TAN_RADIUS * RIPPLE_FREQ * 2.0 * PI_L;
  return mix(1.0, I, exp(-0.5 * blur * blur));
}

// The shadow map's frame: centre *c, radius *R of the disc it covers (grid
// cells), and the axes *u, *v across the sun (FU.sun). Its writer (the shadow
// kernel) and every reader call this one function, so they agree bit for bit.
fn sunBasis(c: ptr<function, vec3f>, R: ptr<function, f32>, u: ptr<function, vec3f>, v: ptr<function, vec3f>) {
  *c = vec3f(GRID) * 0.5;
  *R = 0.5 * length(vec3f(GRID)) + SHADOW_PAD;
  *u = normalize(cross(vec3f(0.0, 1.0, 0.0), FU.sun));
  *v = cross(FU.sun, *u);
  // The map's texel lattice stays put in the world as the window moves
  // (docs/scaling.md D11): the centre takes the window's offset rounded to
  // whole texels across the sun (along it, depths only shift). Within half a
  // texel, which SHADOW_PAD covers. In a box the origin is 0 and so is the snap.
  let o = vec3f(H.origin);
  let T = 2.0 * *R / f32(max(FU.shadowRes, 1));   // texel size (a pass without a map: anything finite)
  let ot = vec2f(dot(o, *u), dot(o, *v)) / T;
  let snap = (round(ot) - ot) * T;
  *c += snap.x * *u + snap.y * *v;
}

// 1 if the ray from ro toward the sun gets tLim voxels without entering
// opaque matter, else 0 (exact DDA, same traversal as the view rays). Crisp
// voxels block as cubes. Smooth surfaces block as drawn, by their field (as
// the shadow map pass sees them), not as their cells: the cells' staircase
// stands proud of a smooth slope, and on lit sand it cut jagged shadows.
fn smoothOpaque(p: vec3f) -> f32 {
  let s = surfField(p);
  return max(s.y, max(s.z, s.w));
}
fn sunRayClear(ro: vec3f, tLim: f32) -> f32 {
  let rd = safeDir(FU.sun);
  let bh = boxHit(ro, rd);
  let t = max(bh.x, 0.0);
  if (bh.y <= t) { return 1.0; }
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t, &istp, &tDelta, &cell, &tMax);
  var tEnter = t;
  let tSkip = t + SUN_RAY_SMOOTH_SKIP;
  var lastB = vec3i(-1);
  var occ = 0u;
  for (var i = 0; i < MAX_STEPS; i++) {
    if (outside(cell) || tEnter > tLim) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) { lastB = bc; occ = brickOcc(bc); }
    if (!brickMatter(occ)) { skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter); continue; }
    let id = eid(fetchA(cell));
    let ax = argmin3(tMax);
    let tExit = min(tMax[ax], tLim);
    if (isCrisp(id)) {
      if (RCLASS(id) == R_OPAQUE) { return 0.0; }
    } else {
      // where the ray passes closest to the cell centre (a lone grain can
      // sit between the ends) and where it leaves the cell
      let tM = tClosest(cell, ro, rd, tEnter, tExit);
      if (tM > tSkip && smoothOpaque(ro + rd * tM) > SURF_ISO + SUN_RAY_ISO_MARGIN) { return 0.0; }
      if (tExit > tSkip && smoothOpaque(ro + rd * tExit) > SURF_ISO + SUN_RAY_ISO_MARGIN) { return 0.0; }
    }
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// Bilinear weight of tap o (0/1 each way) at fraction w.
fn wk0(o: vec2i, w: vec2f) -> f32 {
  return select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
}
${shadowMap ? /* wgsl */ `
// The taps: a Vogel (sunflower) disc of radius 1, rotated per pixel and
// frame. Eight entries, so a private array (docs/webgpu.md C6).
var<private> VOGEL: array<vec2f, ${PCSS_TAPS}> = array<vec2f, ${PCSS_TAPS}>(${vogel(PCSS_TAPS)});

// Point p in the map whose frame is sunBasis's (c, R, u, v): its depth along
// the sun, *d, and its 2×2 taps (the low texel *i0, the bilinear fraction *w:
// wk0). Returns its map coordinate st, 0..1 across the disc.
fn shadowProject(p: vec3f, c: vec3f, R: f32, u: vec3f, v: vec3f, d: ptr<function, f32>, i0: ptr<function, vec2i>, w: ptr<function, vec2f>) -> vec2f {
  let q = p - c;
  let st = vec2f(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  *d = R - dot(q, FU.sun);
  let f = st * f32(FU.shadowRes) - 0.5;
  *i0 = vec2i(floor(f));
  *w = f - vec2f(*i0);
  return st;
}
// The light map texel sm lets through to depth d: tinted by its translucent
// stretch (its tint element's colour, the proportional share of its optical
// depth), 1 outside it.
fn shadowTexelAtt(sm: vec4f, d: f32) -> vec3f {
  var att = vec3f(1.0);
  let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
  if (tid > 0 && d > sm.y) {
    let tau = sm.w - f32(tid) * SHADOW_TINT_ID_SCALE;
    let frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
    let tint = SIGMA(tid) / max(meanSigma(tid), 1e-4);
    att = exp(-tint * tau * frac);
  }
  return att;
}

// Sun visibility at a surface point hp with normal n, from the map (sunShadow
// below adds the clouds).
${backend === 'world' ? worldSunReaderWGSL({ caustics, frame }) : `fn sunMapShadow(hp: vec3f, n: vec3f) -> vec3f {
  var c: vec3f;
  var R: f32;
  var u: vec3f;
  var v: vec3f;
  sunBasis(&c, &R, &u, &v);
  let p = hp + n * SHADOW_NORMAL_OFFSET;
  var d: f32;
  var i0: vec2i;
  var w: vec2f;
  let st = shadowProject(p, c, R, u, v, &d, &i0, &w);
  // Depth bias. A PCF tap one texel (T voxels) away sees the receiver's own face
  // up to T*(|n.u|+|n.v|)/(n.s) closer, and at the foot of a sun-facing wall it
  // sees that wall up to ~0.6 closer: hence >= 0.8. It must stay well below
  // 1/sun.y (1.23), the depth gap to the top of a 1-voxel step.
  let T = 2.0 * R / f32(FU.shadowRes);
  let bias = max(SHADOW_BIAS_MIN, T * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, FU.sun), SHADOW_BIAS_NS_MIN) + SHADOW_BIAS_PAD);
  var acc = vec3f(0.0);
  var tr = vec3f(0.0);
  var nLit = 0.0;
  var cD = 0.0;   // depth under liquid (along the sun) ...
  var cW = 0.0;   // ... weight of the taps that see it
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1u);
    let sm = textureLoad(tShadow, clamp(i0 + o, vec2i(0), vec2i(FU.shadowRes - 1)), 0);
    let lit = select(0.0, 1.0, d < sm.x + bias);
    let att = shadowTexelAtt(sm, d);
    let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
    let wk = wk0(o, w);
    if (tid > 0 && underPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += lit * att * wk;
    tr += att * wk;
    nLit += lit;
  }
  if (${caustics} && cW > 0.0) {
    let cg = mix(1.0, causticGain(p, cD / cW), cW);
    acc *= cg;
    tr *= cg;
  }

  // Clearly lit by the hard map: done. Penumbrae are only grown inward, into
  // the hard shadow (below), so lit pixels (most of them) skip the search.
  if (nLit == 4.0) { return acc; }

  // PCSS. Taps are compared against the receiver's plane (its depth moves by
  // slope per voxel along u, v), so wide kernels don't shadow sloped receivers.
  let ns = max(dot(n, FU.sun), PCSS_NS_MIN);
  let slope = vec2f(dot(n, u), dot(n, v)) / ns;
  let ft = st * f32(FU.shadowRes);
  let hi = vec2i(FU.shadowRes - 1);
  let rot = 2.0 * PI_L * ign(gFragCoord, ${frame});
  let R2 = mat2x2f(cos(rot), sin(rot), -sin(rot), cos(rot));
  // blocker search over the widest penumbra anything in front of p could cast
  let rs = SUN_TAN_RADIUS * d;
  var bSum = 0.0;
  var bN = 0.0;
  for (var i = 0; i < PCSS_TAPS; i++) {
    let o = R2 * VOGEL[i] * rs;
    let sm = textureLoad(tShadowX, clamp(vec2i(floor(ft + o / T)), vec2i(0), hi), 0).x;
    if (sm + PCSS_BIAS < d + dot(o, slope)) { bSum += sm; bN += 1.0; }
  }
  var pen = 0.0;
  if (bN > 0.0) { pen = SUN_TAN_RADIUS * (d - bSum / bN); }
  if (pen < PCSS_HARD_TEXELS * T) {
    // Hard edge (contact, or no caster near): p is within a texel (~0.44
    // voxels at 128^3) of the edge, and the hard map's bilinear filter (acc)
    // draws it as a ramp a texel wide, the map's own resolution, as TF2's and
    // Halo 3's filtered shadow maps draw theirs. (An exact DDA ray toward the
    // sun per edge pixel used to sharpen it: a walk through the grid for a
    // fraction of a cell, sub-pixel past a few metres. sunRayClear stays for
    // the probes in lib.js.)
    return acc;
  }
  // The filtered visibility is 1/2 on the hard edge and falls to 0 a penumbra
  // inside it: doubled, it meets the lit side continuously.
  var lit = 0.0;
  for (var i = 0; i < PCSS_TAPS; i++) {
    let o = R2 * VOGEL[i] * pen;
    let sm = textureLoad(tShadowX, clamp(vec2i(floor(ft + o / T)), vec2i(0), hi), 0).x;
    if (sm + PCSS_BIAS >= d + dot(o, slope)) { lit += 1.0; }
  }
  return tr * min(2.0 * lit / f32(PCSS_TAPS), 1.0);
}

// Sun visibility at a point p inside a volume (media, liquid interiors), from the map.
fn sunMapShadowAt(p: vec3f) -> vec3f {
  var c: vec3f;
  var R: f32;
  var u: vec3f;
  var v: vec3f;
  sunBasis(&c, &R, &u, &v);
  var d: f32;
  var i0: vec2i;
  var w: vec2f;
  shadowProject(p, c, R, u, v, &d, &i0, &w);
  var acc = vec3f(0.0);
  var cD = 0.0;
  var cW = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1u);
    let sm = textureLoad(tShadow, clamp(i0 + o, vec2i(0), vec2i(FU.shadowRes - 1)), 0);
    let lit = select(vec3f(0.0), vec3f(1.0), d < sm.x + VOLUME_SHADOW_BIAS) * shadowTexelAtt(sm, d);
    let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
    let wk = wk0(o, w);
    if (tid > 0 && underPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += lit * wk;
  }
  if (${caustics} && cW > 0.0) { acc *= mix(1.0, causticGain(p, cD / cW), cW); }
  return acc;
}`}

// Sunlight at grid point hp of a surface with normal n: the map, under the
// clouds' shadow (a fully clouded point skips the map).
fn sunShadow(hp: vec3f, n: vec3f) -> vec3f {
  let c = cloudShadow(worldPos(hp));
  if (c > CLOUD_SHADOW_SKIP) { return c * sunMapShadow(hp, n); }
  return vec3f(0.0);
}
// ...and at a point p inside a volume.
fn sunShadowAt(p: vec3f) -> vec3f {
  let c = cloudShadow(worldPos(p));
  if (c > CLOUD_SHADOW_SKIP) { return c * sunMapShadowAt(p); }
  return vec3f(0.0);
}` : `
// (no shadow-map readers here: this pipeline writes the map)`}

// ---- indirect light: the GI probe volume (shaders/gi.js) ----
// One probe per brick centre holds the light arriving there from every
// direction (sky, ground and one-or-more bounces off lit matter, occluded at
// brick scale) as L1 spherical harmonics: rgb = radiance, a = sky visibility.
// Bands: tGI0 (band 0), tGI1, tGI2, tGI3 (band 1: x, y, z).
const SH_Y0: f32 = ${SH_Y0.toFixed(6)};      // Y00
const SH_Y1: f32 = ${SH_Y1.toFixed(6)};      // Y1m = SH_Y1 * (x, y, z)
const SH_COS1: f32 = 2.0 / 3.0;   // band-1 clamped-cosine convolution / pi (band 0: 1)
// Surfaces read the probes this many cells out along their normal: past the
// brick their own matter shares, into the light in front of them. Detail
// closer than that comes from the near-field AO below.
const GI_OFFSET: f32 = ${GI_OFFSET_CELLS.toFixed(1)};
const SKYVIS_MIN: f32 = 0.05;     // floor of the open-sky share used to normalise sky visibility

// A probe's four bands.
struct Probe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
${probes ? /* wgsl */ `
// Trilinear probe lookup of band t at p (grid units): one hardware sample,
// held to the edge probes' centres.
${backend === 'world' ? `fn probeTex(t: texture_2d_array<f32>, p: vec3f) -> vec4f { return worldProbeTex(t,p,WORLD_GI); }` : `fn probeTex(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let B = vec3f(f32(BX), f32(BY), f32(BZ));
  let q = clamp(p / f32(BS), vec3f(0.5), B - 0.5);
  return textureSampleLevel(t, linearClamp, q / B, 0.0);
}`}
// The probe at grid point p.
fn probeAt(p: vec3f) -> Probe {${backend === 'world' ? `
  let w = worldProbe(p);   // (the four bands' taps share their lookups: worldAccess.js)
  return Probe(w.c0, w.cx, w.cy, w.cz);` : `
  return Probe(probeTex(tGI0, p), probeTex(tGI1, p), probeTex(tGI2, p), probeTex(tGI3, p));`}
}
// Probe for a surface at p with geometric normal n.
fn surfProbe(p: vec3f, n: vec3f) -> Probe { return probeAt(p + n * GI_OFFSET); }` : `
// (no probe readers here: this pipeline writes the bands)`}

// Indirect irradiance / pi on a surface facing unit n.
// FU.caveAmbient: a scene's floor of light everywhere (world scene ambient:
// the Descent's caves, which Noita never draws pitch black); 0 elsewhere.
fn giIrradiance(g: Probe, n: vec3f) -> vec3f {
  return max(SH_Y0 * g.c0.rgb + SH_COS1 * SH_Y1 * (g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z), vec3f(0.0)) + ${caveAmbient};
}
// Indirect radiance arriving from unit direction d, as blurry as L1 allows;
// blur in [0, 1] widens it further, to the irradiance lobe (rough reflections).
fn giRadiance(g: Probe, d: vec3f, blur: f32) -> vec3f {
  let k1 = SH_Y1 * mix(1.0, SH_COS1, blur);
  return max(SH_Y0 * g.c0.rgb + k1 * (g.cx.rgb * d.x + g.cy.rgb * d.y + g.cz.rgb * d.z), vec3f(0.0)) + ${caveAmbient};
}
// Share of the open sky a surface facing n sees (1 in the open, less under
// overhangs, in pits and between tall things).
fn giSkyVis(g: Probe, n: vec3f) -> f32 {
  let v = SH_Y0 * g.c0.a + SH_COS1 * SH_Y1 * (g.cx.a * n.x + g.cy.a * n.y + g.cz.a * n.z);
  return clamp(v / max(0.5 + 0.5 * n.y, SKYVIS_MIN), 0.0, 1.0);
}
// Share of the open sky the air at p sees, over every direction (1 in the
// open, 0 in a closed cave): band 0 against the open sky's, the sphere's upper
// half. Past the window there are no probes: open.
const SKYVIS_OPEN_DC: f32 = ${SKYVIS_OPEN_DC.toFixed(6)};   // SH_Y0 * c0.a of the open sky${probes ? /* wgsl */ `
fn giAirSkyVis(p: vec3f) -> f32 {
  if (any(p < vec3f(0.0)) || any(p > vec3f(GRID))) { return 1.0; }
  return clamp(SH_Y0 * probeTex(tGI0, p).a / SKYVIS_OPEN_DC, 0.0, 1.0);
}
// The same share from the probes already in, for a reader that can do without
// (the haze: shaders/farShared.js hazeAirLit): (share * weight, weight), the
// weight being how much of p's probes are held. A box's window holds all of
// its probes; a world holds the bricks something has asked for, and this
// asks for none (worldAccess.js worldProbeHeld). Different code, the same
// share wherever the probes are in.
fn giAirSkyHeld(p: vec3f) -> vec2f {${backend === 'world' ? `
  var s = vec2f(1.0);   // past the world, as giAirSkyVis: open
  if (all(p >= vec3f(0.0)) && all(p <= vec3f(GRID))) {
    let h = worldProbeAlphaHeld(tGI0, p);
    s = vec2f(clamp(SH_Y0 * h.x / max(h.y, 1e-6) / SKYVIS_OPEN_DC, 0.0, 1.0) * h.y, h.y);
  }
  return s;` : `
  return vec2f(giAirSkyVis(p), 1.0);`}
}` : `
// (no giAirSkyVis here: it samples the bands this pipeline writes)`}

// Cold wand lights (FU.wandLightPosition: xyz grid cells, w reach;
// FU.wandLightColor: rgb, w intensity; FU.wandLightCount of them) enter the
// same surface/media lighting path as local glow, without spawning hot voxels.
fn wandLight(p: vec3f) -> vec3f {
  if (FU.wandLightCount == 0) { return vec3f(0.0); }
  var light = vec3f(0.0);
  // ponytail: eight unshadowed radial lights; add occlusion only if light leaking matters.
  for (var i = 0; i < WAND_LIGHTS; i++) {
    if (i >= FU.wandLightCount) { break; }
    let pr = FU.wandLightPosition[i];
    let ci = FU.wandLightColor[i];
    let d = p - pr.xyz;
    let falloff = max(1.0 - dot(d, d) / (pr.w * pr.w), 0.0);
    light += ci.rgb * ci.w * falloff * falloff;
  }
  return light;
}

// ---- glow volume: blurred emission of lava, fire, hot metal ----
// The light at grid point gp: the glow volume (tLight, one texel per brick),
// one hardware trilinear sample held to the edge bricks' centres (the 8
// manual taps clamped to the edge it replaces), plus the wand lights.
fn sampleLight(gp: vec3f) -> vec3f {
  ${backend === 'world' ? 'return worldLight(gp) + wandLight(gp);' : `let B = vec3f(f32(BX), f32(BY), f32(BZ));
  let q = clamp(gp / f32(BS), vec3f(0.5), B - 0.5);
  return textureSampleLevel(tLight, linearClamp, q / B, 0.0).rgb + wandLight(gp);`}
}

// ---- ambient occlusion (near field; the probes cover the larger scale) ----
// Whether cell c occludes: the floor below the box does, the outside doesn't,
// matter but gas does.
fn occluder(c: vec3i) -> bool {
  if (c.y < 0) { return true; }
  if (outside(c)) { return false; }
  let id = eid(fetchA(c));
  return !isGasLike(id);
}

// Smooth per-corner AO on a crisp voxel face (Minecraft style): cell's face
// with outward normal n (one axis, ±1), at hit point hp.
const FACE_AO_MIN: f32 = 0.25;   // light left in a fully enclosed corner
fn faceAO(cell: vec3i, n: vec3i, hp: vec3f) -> f32 {
  let u = select(vec3i(1, 0, 0), vec3i(0, 1, 0), n.x != 0);
  let w = select(vec3i(0, 0, 1), vec3i(0, 1, 0), n.z != 0);
  let b = cell + n;
  let s1 = f32(occluder(b + u));
  let s2 = f32(occluder(b - u));
  let s3 = f32(occluder(b + w));
  let s4 = f32(occluder(b - w));
  let c1 = f32(occluder(b + u + w));
  let c2 = f32(occluder(b + u - w));
  let c3 = f32(occluder(b - u + w));
  let c4 = f32(occluder(b - u - w));
  let aPP = select(3.0 - (s1 + s3 + c1), 0.0, s1 * s3 > 0.0);
  let aPM = select(3.0 - (s1 + s4 + c2), 0.0, s1 * s4 > 0.0);
  let aMP = select(3.0 - (s2 + s3 + c3), 0.0, s2 * s3 > 0.0);
  let aMM = select(3.0 - (s2 + s4 + c4), 0.0, s2 * s4 > 0.0);
  let fu = fract(dot(hp, vec3f(u)));
  let fw = fract(dot(hp, vec3f(w)));
  let ao = mix(mix(aMM, aPM, fu), mix(aMP, aPP, fu), fw) / 3.0;
  return FACE_AO_MIN + (1.0 - FACE_AO_MIN) * ao;
}

// How solid the world is at p, 0..1 (smooth surfaces from the fields, crisp
// voxels and the floor from the state).
const AO_LIQUID_SOLIDITY: f32 = 0.6;   // how much liquid occludes, relative to solid matter
fn solidity(p: vec3f) -> f32 {
  if (p.y < 0.0) { return 1.0; }
  let s = surfField(p);
  var o = max(max(s.y, s.z), max(s.w, s.x * AO_LIQUID_SOLIDITY));
  let c = vec3i(floor(p));
  if (!outside(c) && isCrisp(eid(fetchA(c)))) { o = 1.0; }
  return clamp(o, 0.0, 1.0);
}

// AO for smooth surfaces at p with normal n: probe the solidity along the
// normal (a flat surface sees ~0 from FIELD_AO_D1 out, crevices and the foot
// of piles see more).
const FIELD_AO_D1: f32 = 1.5;   // probe distances (cells) ...
const FIELD_AO_D2: f32 = 3.0;
const FIELD_AO_D3: f32 = 5.0;
const FIELD_AO_W1: f32 = 0.45;  // ... and their weights
const FIELD_AO_W2: f32 = 0.3;
const FIELD_AO_W3: f32 = 0.2;
const FIELD_AO_MIN: f32 = 0.2;   // light left in the deepest crevice
fn fieldAO(p: vec3f, n: vec3f) -> f32 {
  let occ = FIELD_AO_W1 * solidity(p + n * FIELD_AO_D1) + FIELD_AO_W2 * solidity(p + n * FIELD_AO_D2)
          + FIELD_AO_W3 * solidity(p + n * FIELD_AO_D3);
  return clamp(1.0 - occ, FIELD_AO_MIN, 1.0);
}

// ---- traced near field: short rays through the voxel grid ----
// First matter a ray from ro along rd enters within tLim cells: returns its
// distance (or -1) and in *hc, *hn the cell and entry-face normal.
// opaqueOnly: only matter that blocks light outright counts (shadow rays);
// otherwise anything but gas does (AO). Smooth surfaces count as drawn, where
// their field is inside (sampled where the ray passes closest to the cell
// centre: their cells' staircase stands proud of a slope), and only from
// selfSkip cells out, since the ray starts by one; the floor counts as matter.
const NEAR_MAX_STEPS: i32 = 48;   // cells (or empty-region jumps) a traced ray may visit
// Whether p is inside a smooth surface (opaqueOnly: an opaque one; else liquid too).
fn nearSmoothIn(p: vec3f, opaqueOnly: bool) -> bool {
  let s = surfField(p);
  return max(max(s.y, s.z), max(s.w, select(s.x, 0.0, opaqueOnly))) >= SURF_ISO;
}
fn traceNearSteps(ro: vec3f, rd0: vec3f, tLim: f32, opaqueOnly: bool, selfSkip: f32, maxSteps: i32,
             hc: ptr<function, vec3i>, hn: ptr<function, vec3f>) -> f32 {
  let rd = safeDir(rd0);
  var istp: vec3i;
  var tDelta: vec3f;
  var tMax: vec3f;
  var cell = vec3i(floor(ro));
  *hc = cell;
  *hn = vec3f(0.0);
  if (cell.y < 0 || outside(cell)) { return -1.0; }
  ddaInit(ro, rd, cell, &istp, &tDelta, &tMax);
  var tEnter = 0.0;
  var ax = 1;
  var lastB = vec3i(-1);
  var occ = 0u;
  for (var i = 0; i < maxSteps; i++) {
    if (tEnter > tLim) { break; }
    if (cell.y < 0) { *hc = cell; *hn = vec3f(0.0, 1.0, 0.0); return tEnter; }
    if (outside(cell)) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) { lastB = bc; occ = brickOcc(bc); }
    if (!brickMatter(occ)) { ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter); continue; }
    let id = eid(fetchA(cell));
    let axOut = argmin3(tMax);
    if (!isGasLike(id) && (!opaqueOnly || RCLASS(id) == R_OPAQUE)
        && (isCrisp(id) || (tEnter > selfSkip && nearSmoothIn(ro + rd * tClosest(cell, ro, rd, tEnter, tMax[axOut]), opaqueOnly)))) {
      var h = vec3f(0.0);
      h[ax] = -f32(istp[ax]);
      var th = tEnter;
      var hit = true;
      if (id == E_CRYSTAL) {
        // Trace the visible prism, not its enclosing cube. Do not overwrite
        // gCrys*: these secondary rays run while shading the primary crystal.
        var kind: i32;
        hit = shardHit(crysShard(cell), ro, rd, &th, min(tMax[axOut], tLim), &h, &kind);
      }
      if (hit) { *hc = cell; *hn = h; return th; }
    }
    ax = axOut;
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return -1.0;
}

fn traceNear(ro: vec3f, rd: vec3f, tLim: f32, opaqueOnly: bool, selfSkip: f32,
             hc: ptr<function, vec3i>, hn: ptr<function, vec3f>) -> f32 {
  return traceNearSteps(ro, rd, tLim, opaqueOnly, selfSkip, NEAR_MAX_STEPS, hc, hn);
}

// Random numbers for this pixel (gFragCoord) and frame: k-th of a decorrelated set.
// Streams: a lamp's shadow ray each (the near field and the glow lights draw none).
const LAMP_STREAM: i32 = 0;                              // the first lamp's
const NEAR_RAND_STREAMS: i32 = LAMP_STREAM + LAMP_MAX;   // random streams per frame
fn pixRand3(k: i32) -> vec3f {
  return hash33(vec3f(gFragCoord, ${frame} * f32(NEAR_RAND_STREAMS) + f32(k)));
}
fn pixRand(k: i32) -> vec2f { return pixRand3(k).xy; }
// The estimators' own samples are spatiotemporal (noise.js stbn1/2/3): each
// 3x3 window of pixels, TAAU's neighbourhood, holds a stratified set, so the
// window's mean is steady from frame to frame instead of shimmering.
// A lamp's soft-shadow aim: a point on the disc its ball shows (radius², angle) and along its length.
fn lampRand(i: i32) -> vec3f {
  return vec3f(stbn2(gFragCoord, ${frame}, f32(LAMP_STREAM + i)), fract(ignR(gFragCoord) + R1_G * stbnT(${frame}, f32(i))));
}

// ---- hand lamps: their light ----
// Each is a tube light (Karis 2013, "Real Shading in Unreal Engine 4": sphere
// and tube lights, as UE4's Source Radius and Source Length): a ball of
// radius r (FU.lampShape.x) swept upright over a length h (.y), the size of
// the flame or the lantern's glass you see. A surface sees it from the
// tube's nearest point, as the paper's representative point; its light falls
// off as a sphere light's, inverse-square with the light's own radius as the
// soft core, (U² + r²) / (d² + r²), so its colour is the irradiance at
// U = LAMP_UNIT, and it reaches the light's surface without blowing up; and
// Karis's window (1 − (d/R)⁴)₊² fades it out at its reach R.
const LAMP_UNIT: f32 = ${LAMP_UNIT.toFixed(1)};        // cells at which a lamp's colour is its irradiance
fn lampFall(d2: f32, R: f32, r: f32) -> f32 {
  let x2 = d2 / (R * R);
  let fade = max(1.0 - x2 * x2, 0.0);
  return (LAMP_UNIT * LAMP_UNIT + r * r) / (d2 + r * r) * fade * fade;
}
// The point of lamp i's tube nearest p.
fn lampNearest(i: i32, p: vec3f) -> vec3f {
  let c = FU.lampPos[i].xyz;
  let h = 0.5 * FU.lampShape[i].y;
  return vec3f(c.x, clamp(p.y, c.y - h, c.y + h), c.z);
}
// A fixed lamp (a wall torch's) is lit while its cell is still a torch: dug out or burnt, it goes dark.
fn lampLive(i: i32) -> bool {
  if (FU.lampCol[i].w < 0.5) { return true; }
  let lc = vec3i(floor(FU.lampPos[i].xyz));
  return !outside(lc) && eid(fetchA(lc)) == E_WALL_TORCH;
}
// The lamps' light on a surface at p (normal n), unshadowed: what a near-field
// bounce ray sees on the matter it hits, as it sees the sun there (a shadow
// ray per hit per lamp would cost more than the rest of the near field).
fn lampSeen(p: vec3f, n: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }
    let dv = lampNearest(i, p) - p;
    let d2 = dot(dv, dv);
    let R = FU.lampPos[i].w;
    if (d2 >= R * R || !lampLive(i)) { continue; }
    sum += FU.lampCol[i].rgb * max(dot(n, dv) * inverseSqrt(max(d2, 1e-8)), 0.0) * lampFall(d2, R, FU.lampShape[i].x);
  }
  return sum;
}

// ---- the near field: occlusion and bounce within a few cells, from the volumes ----
// What the probes are too coarse for (they are a brick apart, read GI_OFFSET
// out): matter within a few cells that shades a surface and lights it with
// what bounces off it. Source lights its models from an ambient cube and Halo 3
// its world from SH probes, a light volume read at the surface, with no ray
// traced per pixel (Mitchell, McTaggart & Green 2006, "Shading in Valve's
// Source Engine"; Chen & Liu 2008, "Lighting and Material of Halo 3"); the
// occlusion between them is read off the voxels around the face, as
// Minecraft's smooth lighting reads it off a block's neighbours. Here: a fixed
// kernel of NEAR_TAPS points in the hemisphere over the surface (a cosine-
// weighted set, one along the normal and a ring round it, at a few cells),
// each asking the fields (smooth matter, already blurred, so its occlusion is
// soft) and the state (crisp voxels, the floor) how solid it is there. The
// light the occluding matter sends back is its albedo times the light at one
// representative point in front of it (the sun through the map, the probes'
// irradiance, the glow), plus what it gives off. The same every frame, so
// nothing shimmers and TAA has nothing to average (two random rays a pixel
// used to walk the grid for it). At surface point p (geometric normal ng,
// shading normal n), returns the indirect irradiance / pi to use instead of
// irr * AO, and writes *vis, the visibility for specular occlusion and glow.
const NEAR_TAPS: i32 = 6;
const NEAR_START: f32 = 0.55;    // cells off the surface (along its normal) the kernel is centred
const NEAR_VIS_MIN: f32 = 0.15;  // light left in the deepest crevice
const NEAR_ISO: vec2f = vec2f(0.35, 0.65);   // smooth fields: empty below, solid above (about SURF_ISO)
const NEAR_LIQUID: f32 = 0.6;    // how much liquid occludes, relative to solid matter (fieldAO's AO_LIQUID_SOLIDITY)
const NEAR_REP_D: f32 = 1.0;     // cells from the kernel's centre toward the occluders where their light is looked up
// The kernel's tangent frame: this fixed oblique direction projected into the
// surface's plane (a frame that turns smoothly with the normal: the taps don't
// jump where a select between two axes would flip them).
const NEAR_FRAME_A: vec3f = vec3f(0.4319, 0.2903, 0.8540);
// The taps: (x, y, z) a unit direction in the frame (z along n; the ring at
// 50 degrees from it, its azimuths 72 degrees apart and turned off the grid's
// axes), w its distance in cells. Cosine-weighted: each counts by its z.
var<private> NEAR_KERNEL: array<vec4f, NEAR_TAPS> = array<vec4f, NEAR_TAPS>(
  vec4f(0.0, 0.0, 1.0, 2.2),
  vec4f(0.7196, 0.2627, 0.6428, 1.5),
  vec4f(-0.0274, 0.7656, 0.6428, 2.5),
  vec4f(-0.7366, 0.2105, 0.6428, 1.8),
  vec4f(-0.4278, -0.6355, 0.6428, 2.6),
  vec4f(0.4722, -0.6032, 0.6428, 2.0),
);
// How solid the world is at q for the near field (0..1), and in *hid the
// element there (E_EMPTY: none, or the floor: -1) and *ha its cell.
fn nearSolid(q: vec3f, hid: ptr<function, i32>, ha: ptr<function, vec4f>) -> f32 {
  *hid = E_EMPTY;
  *ha = vec4f(0.0);
  if (q.y < 0.0) { *hid = -1; return 1.0; }
  let c = vec3i(floor(q));
  if (outside(c)) { return 0.0; }
  let sf = surfField(q);
  var o = max(smoothstep(NEAR_ISO.x, NEAR_ISO.y, max(sf.y, max(sf.z, sf.w))), NEAR_LIQUID * smoothstep(NEAR_ISO.x, NEAR_ISO.y, sf.x));
  let a = fetchA(c);
  let id = eid(a);
  if (!isGasLike(id)) {
    *hid = id;
    *ha = a;
    if (isCrisp(id)) { o = 1.0; }
  }
  return o;
}
${shadowMap && probes ? /* wgsl */ `
// The light a secondary ray sees on the matter it meets at p (normal n, lifted
// off the face): albedo alb times the sun (shadow-mapped), the lamps (lampSeen,
// unshadowed), the probes' light and the glow there, plus emit, its own light
// (gfx/materials.js cellEmission + sparkEmit, what the view shows). One cheap
// model for every second-hand view of a surface, so they all agree: the
// near-field bounce's hits (nearField) and what a liquid or glass mirrors
// (liquid.js reflShade, the floor included). No texture, AO or specular:
// reflections are dimmed by Fresnel and wobbled by ripples, and bounce light
// is blurred by TAA, so they wouldn't show for the cost.
fn hitLight(p: vec3f, n: vec3f, alb: vec3f, emit: vec3f) -> vec3f {
  let ndl = max(dot(n, FU.sun), 0.0);
  var sun = vec3f(0.0);
  if (ndl > 0.0) {
    var shade = vec3f(1.0);
    if (FU.shadows != 0u) { shade = sunShadowAt(p); }
    sun = FU.sunCol * ndl * shade;
  }
  var lamp = vec3f(0.0);
  if (FU.lampCount > 0) { lamp = lampSeen(p, n); }   // and the lamps', as the sun's
  return alb * (sun + lamp + giIrradiance(probeAt(p + n * GI_OFFSET), n) + sampleLight(p) * FU.lightGain) + emit;
}

fn nearField(p: vec3f, ng: vec3f, n: vec3f, irr: vec3f, vis: ptr<function, f32>) -> vec3f {
  let t1 = normalize(NEAR_FRAME_A - n * dot(NEAR_FRAME_A, n) + vec3f(1e-4, 0.0, 0.0));
  let t2 = cross(n, t1);
  let ro = p + ng * NEAR_START;
  var wSum = 0.0;
  var occ = 0.0;           // weighted occlusion
  var dirC = vec3f(0.0);   // ... its mean direction
  var alb = vec3f(0.0);    // the occluders' albedo, weighted as the occlusion ...
  var albW = 0.0;
  var emit = vec3f(0.0);   // ... and what they give off
  for (var i = 0; i < NEAR_TAPS; i++) {
    let k = NEAR_KERNEL[i];
    var d = t1 * k.x + t2 * k.y + n * k.z;
    if (dot(d, ng) < 0.0) { d = reflect(d, ng); }   // keep it above the geometric surface
    var hid: i32;
    var ha: vec4f;
    let o = nearSolid(ro + d * k.w, &hid, &ha) * k.z;
    wSum += k.z;
    if (o <= 0.0) { continue; }
    occ += o;
    dirC += o * d;
    if (hid < 0) { alb += o * GROUND_ALB; albW += o; }
    else if (hid != E_EMPTY) {
      alb += o * ALBEDO(hid);
      albW += o;
      emit += o * (cellEmission(hid, ha.y, floor(ha.w)) + sparkEmit(hid, floor(ha.w)));   // a live conductor, a lit lamp
    }
  }
  *vis = max(1.0 - occ / wSum, NEAR_VIS_MIN);
  if (occ <= 0.0) { return irr; }
  // smooth matter seen only through its blurred field (the tap's own cell empty): the surface's own
  if (albW < occ) {
    let oc = vec3i(floor(p - ng * 0.5));
    var own = GROUND_ALB;
    if (oc.y >= 0 && !outside(oc)) {
      let oid = eid(fetchA(oc));
      if (oid != E_EMPTY) { own = ALBEDO(oid); }
    }
    alb += (occ - albW) * own;
  }
  // the light on the occluders, seen as every second-hand view sees matter
  // (hitLight), at one point in front of them, facing back
  let dc = dirC / max(length(dirC), 1e-6);
  let Lhit = hitLight(ro + dc * NEAR_REP_D, -dc, alb / occ, emit / occ);
  return mix(irr, Lhit, occ / wSum);
}` : `
// (no nearField here: it reads the shadow map and the probes)`}

// ---- lava and fire as lights ----
// The glow volume carries emitted light blurred over bricks: no direction and
// no shadows. It gets both here from the volume itself and the fields, the
// same every frame: the volume's gradient points to its light, so a face
// toward it takes up to twice the glow and a face away from it none, as far as
// the gradient is steep against the glow there (deep in a glowing region the
// light comes from all round, and the glow stays as it is); and GLOW_TAPS
// points along that direction ask the fields and the state whether opaque
// matter stands between the face and the light, as Minecraft's block light
// stops at opaque blocks. A light volume read at the surface, as Source's
// ambient cubes are (Mitchell et al. 2006), where one shadow ray a pixel to a
// randomly picked emitting brick used to flicker under TAA.
const GLOW_START: f32 = 0.55;        // cells off the surface the taps start
const GLOW_EMIT_MIN: f32 = 1e-4;     // glow (luminance) below this is dark
const GLOW_GRAD_H: f32 = 2.0;        // cells: the gradient's central-difference step
// How directional the glow is: |grad E| / E times this. A light r cells away
// (1/r^2) has |grad E| / E = 2 / r: fully directional within 2 × this of it.
const GLOW_DIR_LEN: f32 = 8.0;
const GLOW_TAPS: i32 = 3;
const GLOW_TAP_D: vec3f = vec3f(1.0, 2.5, 5.0);   // cells from the start toward the light
// The taps stay within this share of the light's distance (from the gradient,
// as above: r = 2 E / |grad E|), so none lands in it or past it.
const GLOW_REACH: f32 = 0.75;
const GLOW_ISO: vec2f = vec2f(0.4, 0.7);   // smooth fields: clear below, blocking above
// Worth looking only where the glow is at least this share of the light already there.
const GLOW_REL_MIN: f32 = 0.05;
fn glowWorthIt(local: vec3f, irr: vec3f) -> bool {
  return FU.glowLights != 0u && dot(local, LUMA_709) > GLOW_REL_MIN * dot(irr, LUMA_709);
}
// The glow volume's luminance at grid point gp (sampleLight's texture, no wand lights).
fn glowLum(gp: vec3f) -> f32 {
  ${backend === 'world' ? 'return dot(worldLight(gp), LUMA_709);' : `let B = vec3f(f32(BX), f32(BY), f32(BZ));
  let q = clamp(gp / f32(BS), vec3f(0.5), B - 0.5);
  return dot(textureSampleLevel(tLight, linearClamp, q / B, 0.0).rgb, LUMA_709);`}
}
// The glow's scale at surface point p (geometric normal ng, shading normal n).
fn glowLightScale(p: vec3f, ng: vec3f, n: vec3f) -> f32 {
  let ro = p + ng * GLOW_START;
  let e0 = glowLum(ro);
  if (e0 < GLOW_EMIT_MIN) { return 1.0; }
  let h = vec2f(GLOW_GRAD_H, 0.0);
  let g = vec3f(glowLum(ro + h.xyy) - glowLum(ro - h.xyy), glowLum(ro + h.yxy) - glowLum(ro - h.yxy),
                glowLum(ro + h.yyx) - glowLum(ro - h.yyx)) / (2.0 * GLOW_GRAD_H);
  let gl = length(g);
  if (gl < 1e-8) { return 1.0; }
  let L = g / gl;
  let D = clamp(gl * GLOW_DIR_LEN / e0, 0.0, 1.0);
  let reach = GLOW_REACH * 2.0 * e0 / gl;
  var vis = 1.0;
  let tapD = GLOW_TAP_D;
  for (var i = 0; i < GLOW_TAPS; i++) {
    if (tapD[i] > reach) { break; }
    let q = ro + L * tapD[i];
    let c = vec3i(floor(q));
    if (q.y < 0.0 || outside(c)) { break; }   // (past the light: the floor is never between)
    // opaque matter blocks: granular and natural solids (lava, liquids and glass don't), crisp opaque voxels unless they glow
    let sf = surfField(q);
    var o = smoothstep(GLOW_ISO.x, GLOW_ISO.y, max(sf.z, sf.w));
    let a = fetchA(c);
    let id = eid(a);
    if (isCrisp(id) && RCLASS(id) == R_OPAQUE && dot(cellEmission(id, a.y, floor(a.w)) + sparkEmit(id, floor(a.w)), LUMA_709) < GLOW_EMIT_MIN) { o = 1.0; }
    vis *= 1.0 - o;
  }
  return vis * mix(1.0, 2.0 * max(dot(n, L), 0.0), D);
}

// ---- specular: the GGX microfacet BRDF ----
// The sun's (gfx/surface.js shadeSurf, far.js) and the hand lamps' (lampShade below).
const GGX_ALPHA_MIN: f32 = 2e-3;   // floor on GGX alpha (= roughness²): keeps the lobe finite

// Height-correlated Smith visibility, V = G2 / (4 n·l n·v).
fn smithV(nl: f32, nv: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  let gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// GGX specular BRDF times n·l, optionally anisotropic: grooves along t are
// smoother along t than across, so the highlight stretches across them.
fn ggxSpecA(n: vec3f, v: vec3f, l: vec3f, rough: f32, F0: vec3f, t0: vec3f, aniso: f32) -> vec3f {
  let nl = dot(n, l);
  if (nl <= 0.0) { return vec3f(0.0); }
  let h = normalize(v + l);
  let nv = max(dot(n, v), 1e-4);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  var a = max(rough * rough, GGX_ALPHA_MIN);
  var D: f32;
  if (aniso > 0.0) {
    let b = normalize(cross(n, t0));
    let t = cross(b, n);
    let at = max(a * (1.0 - aniso), GGX_ALPHA_MIN);
    let ab = max(a * (1.0 + aniso), GGX_ALPHA_MIN);
    let th = dot(t, h) / at;
    let bh = dot(b, h) / ab;
    let d = th * th + bh * bh + nh * nh;
    D = 1.0 / (PI_L * at * ab * d * d);
    a = sqrt(at * ab);
  } else {
    let a2 = a * a;
    let d = nh * nh * (a2 - 1.0) + 1.0;
    D = a2 / (PI_L * d * d);
  }
  let F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return D * smithV(nl, nv, a) * F * nl;
}
fn ggxSpec(n: vec3f, v: vec3f, l: vec3f, rough: f32, F0: vec3f) -> vec3f {
  return ggxSpecA(n, v, l, rough, F0, vec3f(1.0, 0.0, 0.0), 0.0);
}


// ---- hand lamps: their specular ----
// A lamp is a tube of radius r and length h (lampNearest), so its highlight is
// Karis 2013's ("Real Shading in Unreal Engine 4", Area Lights): the BRDF lit
// from a representative point, the point of the light nearest the reflection
// ray r. The tube's line first, eq. 19 (shortest distance between the
// segment L0 + t·Ld and r), then the sphere around that point, eq. 11; l
// points at the result. Moving the light's origin onto its body widens the
// lobe, so the energy is put back as the paper does, by the ratio of GGX's
// normalisation (π α²) at the widened α' to the original: eq. 14,
// (α / α')², for the sphere, and eq. 20, α / α', for the line (widened in
// one dimension, anisotropic GGX's π αx αy); the two are accumulated ("these
// operations can be accumulated ... approximates a convolution of the
// shapes"). α' is the paper's own widening, eq. 10 (which eq. 14 says it
// reuses, "the same reasoning used by the specular D modification"):
// α' = saturate(α + sourceRadius / (3 · distance)); for the line, its
// half-length is the radius it subtends along its length.
const LAMP_SPEC_WIDEN: f32 = 1.0 / 3.0;   // α' = α + LAMP_SPEC_WIDEN · radius / d (Karis 2013, eq. 10)
const LAMP_SPEC_EPS: f32 = 1e-6;    // cells²: a segment this short, or r along it, has no nearest-point solve (t = 0.5)
// What lampShade needs for the specular: the view direction v (toward the eye),
// the surface's GGX roughness, F0 and anisotropy (ggxSpecA), and on (false: diffuse only).
struct LampSpecIn { v: vec3f, rough: f32, F0: vec3f, tang: vec3f, aniso: f32, on: bool }
struct LampLit { diff: vec3f, spec: vec3f }
// Lamp i's specular at p (normal n) per unit of its irradiance there, as the
// sun's is per unit of FU.sunCol (× π: the colour is irradiance / π).
fn lampSpec(i: i32, p: vec3f, n: vec3f, view: LampSpecIn) -> vec3f {
  let rr = reflect(-view.v, n);
  let len = FU.lampShape[i].y;
  let rad = FU.lampShape[i].x;
  let L0 = FU.lampPos[i].xyz - p - vec3f(0.0, 0.5 * len, 0.0);
  let Ld = vec3f(0.0, len, 0.0);
  let rLd = dot(rr, Ld);
  let den = dot(Ld, Ld) - rLd * rLd;
  var t = 0.5;
  if (den > LAMP_SPEC_EPS) { t = (dot(rr, L0) * rLd - dot(L0, Ld)) / den; }   // eq. 19
  let Lc = L0 + Ld * clamp(t, 0.0, 1.0);
  let toRay = dot(Lc, rr) * rr - Lc;                                         // eq. 11
  let Lp = Lc + toRay * clamp(rad / max(length(toRay), LAMP_SPEC_EPS), 0.0, 1.0);
  let d = max(length(Lc), LAMP_SPEC_EPS);
  let a = max(view.rough * view.rough, GGX_ALPHA_MIN);
  let aS = a / clamp(a + LAMP_SPEC_WIDEN * rad / d, 0.0, 1.0);               // eq. 14's ratio
  let aL = a / clamp(a + LAMP_SPEC_WIDEN * 0.5 * len / d, 0.0, 1.0);         // eq. 20 (its half-length)
  return PI_L * ggxSpecA(n, view.v, normalize(Lp), view.rough, view.F0, view.tang, view.aniso) * (aS * aS * aL);
}

// The lamps' specular at p (normal n) unshadowed, as lampSeen's diffuse: for
// the clear interfaces (liquid.js liquidInterface: water, ice), which reflect
// what the light falls on them from the lamps' own bodies.
fn lampSpecSeen(p: vec3f, n: vec3f, view: LampSpecIn) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }
    let dv = lampNearest(i, p) - p;
    let d2 = dot(dv, dv);
    let R = FU.lampPos[i].w;
    if (d2 >= R * R || dot(n, dv) <= 0.0 || !lampLive(i)) { continue; }
    sum += FU.lampCol[i].rgb * lampFall(d2, R, FU.lampShape[i].x) * lampSpec(i, p, n, view);
  }
  return sum;
}

// ---- hand lamps: their shadows ----
// The light of the lamps at surface point p (normal n, geometric normal ng),
// to be multiplied by the albedo: each lampFall's, shadowed by a traced ray
// (opaque matter only, as the glow lights'). soft: the ray aims at a random
// point of the light's body, a stratum of its length and of the disc its ball
// shows p (the stochastic area-light shadow every path tracer casts; TAA
// averages it into the penumbra a light that size casts). Else (the GI's
// source pass, which has no per-pixel jitter to average) at its nearest point.
// The light the room bounces back into the shadows is the GI's: giSource
// lights the faces with lampSum as it does with the sun, so the probes and
// nearField carry it.
const LAMP_START: f32 = 0.55;      // cells off the surface a shadow ray starts
const LAMP_SELF_SKIP: f32 = 1.0;   // smooth-surface cells ignored this close to its start
const LAMP_PAD: f32 = 0.3;         // cells short of the lamp the shadow ray stops (it hangs in air)
const LAMP_FIXED_PAD: f32 = ${LAMP_FIXED_PAD.toFixed(2)};   // ...a fixed lamp's: its light is in a solid cell (gfx/lamps.js)
const LAMP_FIXED_SELF: f32 = 0.6;  // cells: a surface this close to a fixed lamp's centre (each axis) is its own cell's
// view: what the specular needs (lampSpec, off in lampSum); the shadow ray is shared.
// beamOn: whether the lighthouse's beam lights the diffuse sum (a caller that
// reads only .spec passes false: the beam has no specular, and its shadow ray
// would only request bricks for light nobody uses).
fn lampLights(p: vec3f, ng: vec3f, n: vec3f, soft: bool, view: LampSpecIn, beamOn: bool) -> LampLit {
  var sum = vec3f(0.0);
  var spec = vec3f(0.0);${giUniforms ? `
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }` : `
  // Beacon direct light only: no rotating contribution left behind in GI
  // history. It is the loop's last trip (i == lamps, beaconDiffuse's light),
  // so its shadow ray and the lamps' are one traceNearSteps call site: Metal
  // inlines every call, and the second copy of the march cost the World
  // volume ~0.3 s of its cold build (2026-10-21). Same light, same order.
  let lamps = min(FU.lampCount, LAMP_MAX);
  for (var i = 0; i <= LAMP_MAX; i++) {
    let beam = i == lamps;
    if (i > lamps || (beam && !(beamOn && FU.beaconDir.w > 0.0))) { break; }`}
    let ro = p + ng * LAMP_START;
    var o = ro;
    var rd = vec3f(0.0);
    var len = 0.0;
    var steps = NEAR_MAX_STEPS;
    var nl = 0.0;
    var d2 = 0.0;
    var R = 0.0;
    var r = 0.0;${giUniforms ? '' : `
    var trace = true;
    var power = vec3f(0.0);
    var ray: BeaconRay;
    if (beam) {
      // beaconDiffuse(p, ng, n): beaconIrradiance(ro) * nl, with beaconVisible's ray
      let dv = beaconPosition() - ro;
      nl = max(dot(n, dv) * inverseSqrt(max(dot(dv, dv), 1e-8)), 0.0);
      if (nl <= 0.0) { break; }
      power = beaconPower(ro);
      // Cull daylight, darkness, range and cone BEFORE tracing/sampling.
      if (max(power.r, max(power.g, power.b)) <= 0.0) { break; }
      ray = beaconRay(ro);
      o = ray.o; rd = ray.d; len = ray.len; steps = BEACON_MAX_STEPS; trace = ray.trace;
    } else {`}
    let near = lampNearest(i, ro);
    let dv = near - ro;
    d2 = dot(dv, dv);
    R = FU.lampPos[i].w;
    if (d2 >= R * R) { continue; }
    let fixedLamp = FU.lampCol[i].w > 0.5;
    if (!lampLive(i)) { continue; }
    if (fixedLamp && all(abs(p - FU.lampPos[i].xyz) < vec3f(LAMP_FIXED_SELF))) { continue; }   // the torch's own head: its glow is its emission
    let d = sqrt(d2);
    let l = dv / max(d, 1e-4);
    nl = dot(n, l);
    if (nl <= 0.0) { continue; }
    r = FU.lampShape[i].x;
    var aim = near;
    if (soft) {
      let u = lampRand(i);
      let t1 = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(l.y) < 0.9), l));
      let t2 = cross(l, t1);
      let a = 2.0 * PI_L * u.y;
      aim = FU.lampPos[i].xyz + vec3f(0.0, (u.z - 0.5) * FU.lampShape[i].y, 0.0) + (t1 * cos(a) + t2 * sin(a)) * (r * sqrt(u.x));
    }
    let sv = aim - ro;
    let sd = length(sv);
    // stop as far short of the aim as it is off the nearest point, so the ray ends by the light, never in the wall a torch hangs on
    let pad = select(LAMP_PAD, LAMP_FIXED_PAD, fixedLamp) + distance(aim, near);
    rd = sv / max(sd, 1e-4);
    len = max(sd - pad, 0.0);${giUniforms ? '' : `
    }`}
    var hc: vec3i;
    var hn: vec3f;
    // (traceNear: the lamps' NEAR_MAX_STEPS)
    if (${giUniforms ? '' : 'trace && '}traceNearSteps(o, rd, len, true, LAMP_SELF_SKIP, steps, &hc, &hn) >= 0.0) { continue; }${giUniforms ? '' : `
    if (beam) {
      if (beaconFarClear(ro, ray)) { sum += power * nl; }
      break;
    }`}
    let E = FU.lampCol[i].rgb * lampFall(d2, R, r);
    sum += E * nl;
    if (view.on) { spec += E * lampSpec(i, p, n, view); }
  }
  return LampLit(sum, spec);
}
fn lampShade(p: vec3f, ng: vec3f, n: vec3f, soft: bool, view: LampSpecIn) -> LampLit {
  return lampLights(p, ng, n, soft, view, true);
}
fn lampSum(p: vec3f, ng: vec3f, n: vec3f, soft: bool) -> vec3f {
  return lampShade(p, ng, n, soft, LampSpecIn(vec3f(0.0), 1.0, vec3f(0.0), vec3f(1.0, 0.0, 0.0), 0.0, false)).diff;
}
fn lampLight(p: vec3f, ng: vec3f, n: vec3f) -> vec3f { return lampSum(p, ng, n, true); }
${lighthouseGLSL({ far: backend === 'world' ? false : far })}
`;
};

/** tools/check-wgsl.mjs: probe kernels calling every function above (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('lighting');
