// Clear-sky model, shared by the shaders (sky radiance per direction) and JS
// (per-frame values that depend only on the sun: its colour at the ground and
// the open-sky irradiance), so both sides use the same constants.
//
// Single scattering in a flat exponential atmosphere, integrated in closed
// form along the view ray, with sunlight attenuated by the same air. Light
// units are irradiance / pi: a white Lambert surface facing the light has
// radiance equal to that value.

import { glf } from '../glsl.js';

export const SKY = {
  tauRayleigh: [0.046, 0.108, 0.265], // zenith optical depth of air at 680 / 550 / 440 nm (~lambda^-4)
  tauAerosol: 0.04,     // grey haze (Mie) optical depth: a clear day
  aerosolG: 0.8,        // Henyey-Greenstein asymmetry: haze scatters forward (the glow around the sun)
  sunTOA: 1.5,          // sunlight above the atmosphere
  multi: 2.0,           // multiple scattering, which the single-scatter sky leaves out
  // relative air mass toward zenith cosine cz: 1 / (cz + h e^(-f cz)): 1 overhead,
  // ~40 at the horizon (Rozenberg 1966)
  airmassHorizon: 0.025,
  airmassFalloff: 11,
  groundAlb: [0.11, 0.106, 0.102], // the floor's albedo (weathered concrete), continued as open ground around the box
  floorLineAlb: [0.075, 0.078, 0.085], // the floor grid's seams, darker than the floor (inside the box and out, gfx/overlays.js)
};

// tan of the sun's apparent radius: the real sun is 0.27 deg; 1.2 deg stands in
// for a slightly hazy sky, so penumbrae read at the scale of the box (PCSS,
// shaders/gfx/lighting.js) and its disc and highlights are that size.
export const SUN_TAN_RADIUS = 0.021;
// The sun's disc radiance in the sky, x the sunlight at the ground (shaders/far.js FAR_VIEW.SUN_DISC: the real ratio blooms the whole sky)
export const SUN_DISC = 40.0;
export const SUN_DISC_EDGE = 0.15;   // its soft edge, share of its radius

// Quadrature for the open-sky irradiance: rings in elevation × steps in azimuth.
const IRR_RINGS = 16, IRR_STEPS = 32;
// View and sun air masses closer than this use the limit of the path integral
// (their difference divides it).
const AIRMASS_EQ_EPS = 1e-3;

// the air's whole extinction per channel (TAU_AIR in the WGSL), for the haze's colour too (shaders/farShared.js)
export const tauAir = SKY.tauRayleigh.map((t) => t + SKY.tauAerosol);

export function airMass(cz) {
  const c = Math.max(cz, 0);
  return 1 / (c + SKY.airmassHorizon * Math.exp(-SKY.airmassFalloff * c));
}

// Sky radiance toward unit direction d (JS twin of skyRadiance in lighting.js).
function skyRadiance(d, sun, sunExt) {
  const mu = d[0] * sun.x + d[1] * sun.y + d[2] * sun.z;
  const mv = airMass(d[1]), ms = airMass(sun.y);
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = SKY.aerosolG, g2 = g * g;
  const pM = (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * mu, 1.5));
  return tauAir.map((t, i) => {
    const dm = mv - ms;
    const path = Math.abs(dm) < AIRMASS_EQ_EPS ? t * mv * Math.exp(-t * mv) : (mv * (sunExt[i] - Math.exp(-t * mv))) / dm;
    return SKY.multi * Math.PI * SKY.sunTOA * ((SKY.tauRayleigh[i] * pR + SKY.tauAerosol * pM) / t) * path;
  });
}

/**
 * Per-frame sky values for sun direction `sun` (unit THREE.Vector3), with its
 * light scaled per colour by `light` (the moon is a dim, blue sun: gfx/daylight.js),
 * written into `out` = { sunExt, sunCol, skyUp, ground } (arrays of 3):
 *   sunExt  transmittance of the air along the sun's path
 *   sunCol  direct sunlight at the ground
 *   skyUp   open-sky irradiance on an upward surface
 *   ground  radiance of the sunlit, sky-lit ground
 */
export function skyState(sun, light, out) {
  const ms = airMass(sun.y);
  out.sunExt = tauAir.map((t) => Math.exp(-t * ms));
  out.sunCol = out.sunExt.map((e, k) => SKY.sunTOA * e * light[k]);
  const up = [0, 0, 0];
  for (let i = 0; i < IRR_RINGS; i++) {
    // midpoint rule in cos(zenith); weight cos * dOmega / pi
    const cz = (i + 0.5) / IRR_RINGS, sz = Math.sqrt(1 - cz * cz);
    const w = (cz * (1 / IRR_RINGS) * (2 * Math.PI / IRR_STEPS)) / Math.PI;
    for (let j = 0; j < IRR_STEPS; j++) {
      const a = ((j + 0.5) / IRR_STEPS) * 2 * Math.PI;
      const L = skyRadiance([sz * Math.cos(a), cz, sz * Math.sin(a)], sun, out.sunExt);
      for (let k = 0; k < 3; k++) up[k] += L[k] * light[k] * w;
    }
  }
  out.skyUp = up;
  out.ground = SKY.groundAlb.map((a, k) => a * (out.sunCol[k] * Math.max(sun.y, 0) + up[k]));
  return out;
}

export { glf };
const vec3 = (a) => `vec3f(${a.map(glf).join(', ')})`;

// WGSL for the render library (shaders/gfx/lighting.js; the name is the GLSL
// version's, docs/webgpu.md W2): the model's constants, each with its type.
export function skyGLSL() {
  return [
    `const TAU_RAYLEIGH: vec3f = ${vec3(SKY.tauRayleigh)};`,
    `const TAU_AEROSOL: f32 = ${glf(SKY.tauAerosol)};`,
    `const AEROSOL_G: f32 = ${glf(SKY.aerosolG)};`,
    `const TAU_AIR: vec3f = ${vec3(tauAir)};`,
    `const SUN_TOA: f32 = ${glf(SKY.sunTOA)};`,
    `const SKY_MULTI: f32 = ${glf(SKY.multi)};`,
    `const AIRMASS_HORIZON: f32 = ${glf(SKY.airmassHorizon)};`,
    `const AIRMASS_FALLOFF: f32 = ${glf(SKY.airmassFalloff)};`,
    `const AIRMASS_EQ_EPS: f32 = ${glf(AIRMASS_EQ_EPS)};`,
    `const GROUND_ALB: vec3f = ${vec3(SKY.groundAlb)};`,
    `const FLOOR_LINE_ALB: vec3f = ${vec3(SKY.floorLineAlb)};   // the grid's seams, darker than the floor`,
  ].join('\n');
}

// WGSL: the sky's radiance per direction (needs skyGLSL's constants, PI_L and
// FrameUniforms FU): what lights and is mirrored in the scene
// (shaders/gfx/lighting.js) and what the box's backdrop shows (gfx/overlays.js).
export function skyViewGLSL({ source = false } = {}) {
  return /* wgsl */ `
const HORIZON_BLEND: f32 = 0.02;  // sky -> ground blend half-width at the horizon (direction y)

// Henyey–Greenstein phase function: the share of light scattered through
// angle acos(mu) by a medium of asymmetry g, per steradian (the haze here,
// the clouds and gas lighting.js's hgPhase2 mixes two of).
fn hgPhase(mu: f32, g: f32) -> f32 {
  let k = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / (4.0 * PI_L * k * sqrt(k));
}

// Relative air mass toward zenith cosine cz (airMass above).
fn airMass(cz0: f32) -> f32 {
  let cz = max(cz0, 0.0);
  return 1.0 / (cz + AIRMASS_HORIZON * exp(-AIRMASS_FALLOFF * cz));
}

// Clear-sky radiance toward unit d (d.y >= 0; lower directions see the
// horizon), without the sun's disc (skyRadiance above is its JS twin).
fn analyticSkyRadiance(d: vec3f) -> vec3f {
  let mu = dot(d, FU.sun);
  let mv = airMass(d.y);
  let ms = airMass(FU.sun.y);
  let pR = 3.0 / (16.0 * PI_L) * (1.0 + mu * mu);
  let pM = hgPhase(mu, AEROSOL_G);
  // the integral over height of e^(-tau ms x) e^(-tau mv (1 - x)) (x = relative air density)
  let dm = mv - ms;
  let ev = exp(-TAU_AIR * mv);
  var path: vec3f;
  if (abs(dm) < AIRMASS_EQ_EPS) { path = TAU_AIR * mv * ev; } else { path = mv * (FU.sunExt - ev) / dm; }
  return FU.keyLight * SKY_MULTI * PI_L * SUN_TOA * (TAU_RAYLEIGH * pR + TAU_AEROSOL * pM) / TAU_AIR * path;
}

// Radiance of the environment toward unit d: sky above the horizon, ground below.
fn skyRadiance(d: vec3f) -> vec3f {
  ${source ? 'if (sourceEnabled()) { return sourceSky(d); }' : ''}
  return analyticSkyRadiance(d);
}
fn skyColor(d: vec3f) -> vec3f {
  ${source ? 'if (sourceEnabled()) { return sourceSky(d); }' : ''}
  return mix(FU.ground, analyticSkyRadiance(d), smoothstep(-HORIZON_BLEND, HORIZON_BLEND, d.y));
}`;
}
