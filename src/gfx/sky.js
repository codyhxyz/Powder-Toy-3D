// Clear-sky model, shared by the shaders (sky radiance per direction) and JS
// (per-frame values that depend only on the sun: its colour at the ground and
// the open-sky irradiance), so both sides use the same constants.
//
// Single scattering in a flat exponential atmosphere, integrated in closed
// form along the view ray, with sunlight attenuated by the same air. Light
// units are irradiance / pi: a white Lambert surface facing the light has
// radiance equal to that value.

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
};

// Quadrature for the open-sky irradiance: rings in elevation × steps in azimuth.
const IRR_RINGS = 16, IRR_STEPS = 32;
// View and sun air masses closer than this use the limit of the path integral
// (their difference divides it).
const AIRMASS_EQ_EPS = 1e-3;

const tauAir = SKY.tauRayleigh.map((t) => t + SKY.tauAerosol);

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
 * Per-frame sky values for sun direction `sun` (unit THREE.Vector3), written into
 * `out` = { sunExt, sunCol, skyUp, ground } (arrays of 3):
 *   sunExt  transmittance of the air along the sun's path
 *   sunCol  direct sunlight at the ground
 *   skyUp   open-sky irradiance on an upward surface
 *   ground  radiance of the sunlit, sky-lit ground
 */
export function skyState(sun, out) {
  const ms = airMass(sun.y);
  out.sunExt = tauAir.map((t) => Math.exp(-t * ms));
  out.sunCol = out.sunExt.map((e) => SKY.sunTOA * e);
  const up = [0, 0, 0];
  for (let i = 0; i < IRR_RINGS; i++) {
    // midpoint rule in cos(zenith); weight cos * dOmega / pi
    const cz = (i + 0.5) / IRR_RINGS, sz = Math.sqrt(1 - cz * cz);
    const w = (cz * (1 / IRR_RINGS) * (2 * Math.PI / IRR_STEPS)) / Math.PI;
    for (let j = 0; j < IRR_STEPS; j++) {
      const a = ((j + 0.5) / IRR_STEPS) * 2 * Math.PI;
      const L = skyRadiance([sz * Math.cos(a), cz, sz * Math.sin(a)], sun, out.sunExt);
      for (let k = 0; k < 3; k++) up[k] += L[k] * w;
    }
  }
  out.skyUp = up;
  out.ground = SKY.groundAlb.map((a, k) => a * (out.sunCol[k] * Math.max(sun.y, 0) + up[k]));
  return out;
}

const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vec3 = (a) => `vec3(${a.map(glf).join(', ')})`;

export function skyGLSL() {
  return [
    `const vec3 TAU_RAYLEIGH = ${vec3(SKY.tauRayleigh)};`,
    `const float TAU_AEROSOL = ${glf(SKY.tauAerosol)};`,
    `const float AEROSOL_G = ${glf(SKY.aerosolG)};`,
    `const vec3 TAU_AIR = ${vec3(tauAir)};`,
    `const float SUN_TOA = ${glf(SKY.sunTOA)};`,
    `const float SKY_MULTI = ${glf(SKY.multi)};`,
    `const float AIRMASS_HORIZON = ${glf(SKY.airmassHorizon)};`,
    `const float AIRMASS_FALLOFF = ${glf(SKY.airmassFalloff)};`,
    `const float AIRMASS_EQ_EPS = ${glf(AIRMASS_EQ_EPS)};`,
    `const vec3 GROUND_ALB = ${vec3(SKY.groundAlb)};`,
  ].join('\n');
}
