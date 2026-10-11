// Fair-weather cumulus over the world (World mode's sky, shaders/far.js).
//
// A deck of cumulus between CLOUD.baseM and baseM + thickM above the sea,
// raymarched on sky pixels only. Shapes come from the tileable media noise
// (gfx/mediaNoise.js): its billows (inverted Worley fBm, the cauliflower puffs
// of steam) and wisps, read as a 2D coverage map at two non-commensurate
// scales so the tile doesn't repeat visibly, then eroded by the billows in 3D
// at a fine scale. The approach is Schneider's (Horizon Zero Dawn, "The
// real-time volumetric cloudscapes", SIGGRAPH 2015) with Hillaire's
// energy-conserving integration and Wrenninge's multiple-scattering octaves
// (Frostbite, "Physically based sky, atmosphere and cloud rendering", 2016):
// sunlight through a short march toward the sun, a two-lobe Henyey–Greenstein
// phase (the silver lining toward the sun), sky and ground light by height.
// The haze in front fades distant clouds into the horizon, through the
// aerosol's scale height rather than the far field's ground-level air.
// Its shadows fall on the island (cloudShadow, in every sun lookup). The wind
// drifts the deck with the simulation clock (frozen when paused).
import { CELL_M } from '../../scale.js';
import { libChecks } from './lib.js';

export const CLOUD = {
  baseM: 1200,          // m above the sea: the flat bases (lifting condensation level of a humid day)
  thickM: 900,          // m: deck depth (cumulus humilis to mediocris)
  cover: 0.42,          // share of the coverage noise's range that is cloud (fair weather: about a third of the sky)
  shapeAM: 6000,        // m per tile of the coverage billows...
  shapeBM: 9000,        // ...and of the wisps mixed in (non-commensurate, so the tile doesn't repeat)...
  shapeBW: 0.35,        // ...at this weight
  sliceA: 0.21,         // the 3D noise's slices read as the 2D coverage maps
  sliceB: 0.67,
  detailM: 600,         // m per tile of the 3D billows that erode the shapes (puffs of ~40–150 m)
  erode: 0.45,          // density the detail can eat at its hollows...
  detailFadeM: [4000, 12000],   // ...faded to its mean over this distance (m), where its puffs are below a pixel
  roundLo: 0.08,        // share of the depth over which the flat bases round off...
  roundHi: 0.35,        // ...and from where the domed tops start
  dome: 0.9,            // how much the profile thins the coverage away from the core (domes)
  sigmaM: 0.04,         // 1/m: extinction of cloud at density 1 (visibility ~75 m inside)
  steps: 24,            // view-ray samples through the deck
  shadowSamples: 2,     // samples through the deck along the sun for the shadows on the ground
  shadowSkip: 1e-3,     // sunlight through the deck below this skips the shadow map (it can't show)
  maxSpanM: 7000,       // m: the deck's stretch along grazing rays is clipped to this...
  maxDistM: 40000,      // m: ...and nothing farther is drawn (gone into the haze)
  lightSteps: 5,        // samples toward the sun, each segment twice the last...
  lightStep0M: 40,      // ...the first this long (~1.2 km in all)
  gFwd: 0.8,            // Henyey–Greenstein forward lobe (the silver lining)...
  gBack: -0.3,          // ...back lobe...
  gMix: 0.7,            // ...forward share
  msOctaves: 4,         // multiple-scattering octaves: each sees a^k of the optical depth,
  msA: 0.25,            // b^k of the energy and c^k of the phase anisotropy
  msB: 0.85,
  msC: 0.5,
  ambBase: 0.3,         // sky (vs ground) share of the light at the bases (1 at the tops)
  tMin: 0.02,           // the march stops once this little of the background shows
  hazeScaleM: 1200,     // m: scale height of the aerosol haze between the eye and a cloud
  windMS: 15,           // m/s at cloud level (850 hPa: 10–15 m/s)...
  windDir: [0.8, 0.6],  // ...toward this (x, z)
  stepsPerS: 240,       // simulation steps per second (gfx/daylight.js: 4 per frame at 60 fps)
};

// The drift wraps at a common period of every tile (cells), seamlessly.
const lcm = (a, b) => { const g = (x, y) => (y ? g(y, x % y) : x); return (a / g(a, b)) * b; };
export const CLOUD_PERIOD = [CLOUD.shapeAM, CLOUD.shapeBM, CLOUD.detailM].reduce(lcm) / CELL_M;
const windCells = CLOUD.windMS / CLOUD.stepsPerS / CELL_M;   // cells per simulation step
const windLen = Math.hypot(...CLOUD.windDir);

// The deck's drift (cells, wrapped) after `steps` simulation steps, into out (array of 2).
export function cloudShift(steps, out) {
  for (let k = 0; k < 2; k++) {
    const s = (steps * windCells * CLOUD.windDir[k]) / windLen;
    out[k] = ((s % CLOUD_PERIOD) + CLOUD_PERIOD) % CLOUD_PERIOD;
  }
  return out;
}

const glf = (x) => { const s = String(+(+x).toPrecision(7)); return /[.e]/.test(s) ? s : s + '.0'; };
const cells = (m) => glf(m / CELL_M);

// The deck itself and the sunlight through it, in every pipeline that lights
// with the sun (lighting.js: sunShadow multiplies it in, so the window's
// surfaces, media, figures and GI probes all lie in the clouds' shadows), off
// in a box (FU.clouds). WGSL (the name is the GLSL version's, docs/webgpu.md
// W2); reads the media noise (tMediaNoise, L.LIGHTING binding 10: r billows,
// g wisps, b flame tongues, a flicker; gfx/mediaNoise.js), which tiles, through
// linearRepeat, and FrameUniforms' clouds, cloudShift (cells: the wind's drift
// of the deck), cloudSea (world cells: the sea level the deck's height counts
// from) and sun.
//   cloudDensity(p, detail) -> f32   the deck's density (0..1) at world point p
//   cloudShadow(w) -> f32            sunlight reaching world point w through it (1: no deck)
export const cloudDeckGLSL = /* wgsl */ `
const CLOUD_BASE: f32 = ${cells(CLOUD.baseM)};
const CLOUD_THICK: f32 = ${cells(CLOUD.thickM)};
const CLOUD_COVER: f32 = ${glf(CLOUD.cover)};
const CLOUD_SHAPE_A_F: f32 = ${glf(CELL_M / CLOUD.shapeAM)};   // tiles per cell
const CLOUD_SHAPE_B_F: f32 = ${glf(CELL_M / CLOUD.shapeBM)};
const CLOUD_SHAPE_B_W: f32 = ${glf(CLOUD.shapeBW)};
const CLOUD_SLICE_A: f32 = ${glf(CLOUD.sliceA)};
const CLOUD_SLICE_B: f32 = ${glf(CLOUD.sliceB)};
const CLOUD_DETAIL_F: f32 = ${glf(CELL_M / CLOUD.detailM)};
const CLOUD_ERODE: f32 = ${glf(CLOUD.erode)};
const CLOUD_DETAIL_NEAR: f32 = ${cells(CLOUD.detailFadeM[0])};
const CLOUD_DETAIL_FAR: f32 = ${cells(CLOUD.detailFadeM[1])};
const CLOUD_NOISE_MEAN: f32 = 0.5;   // the noise channels are equalised to uniform on [0, 1]
const CLOUD_ROUND_LO: f32 = ${glf(CLOUD.roundLo)};
const CLOUD_ROUND_HI: f32 = ${glf(CLOUD.roundHi)};
const CLOUD_DOME: f32 = ${glf(CLOUD.dome)};
const CLOUD_SIGMA: f32 = ${glf(CLOUD.sigmaM * CELL_M)};   // per cell
const CLOUD_SHADOW_N: i32 = ${CLOUD.shadowSamples};
const CLOUD_SHADOW_SKIP: f32 = ${glf(CLOUD.shadowSkip)};   // sunlight through the deck below this: the shadow map isn't read

// Cloud density (0..1) at world point p (cells); detail (0..1): how much the
// fine billows erode it (0: their mean, for the light march and far off).
fn cloudDensity(p: vec3f, detail: f32) -> f32 {
  let h = (p.y - FU.cloudSea - CLOUD_BASE) / CLOUD_THICK;
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let xz = p.xz + FU.cloudShift;
  let w = mix(textureSampleLevel(tMediaNoise, linearRepeat, vec3f(xz * CLOUD_SHAPE_A_F, CLOUD_SLICE_A), 0.0).r,
              textureSampleLevel(tMediaNoise, linearRepeat, vec3f(xz.yx * CLOUD_SHAPE_B_F, CLOUD_SLICE_B), 0.0).g, CLOUD_SHAPE_B_W);
  let cov = (w - (1.0 - CLOUD_COVER)) / CLOUD_COVER;
  if (cov <= 0.0) { return 0.0; }
  // flat bases, domed tops: the profile thins the coverage away from the core
  let prof = smoothstep(0.0, CLOUD_ROUND_LO, h) * (1.0 - smoothstep(CLOUD_ROUND_HI, 1.0, h));
  let d = cov - CLOUD_DOME * (1.0 - prof);
  if (d <= 0.0) { return 0.0; }
  var n = CLOUD_NOISE_MEAN;
  if (detail > 0.0) { n = textureSampleLevel(tMediaNoise, linearRepeat, vec3f(xz.x, p.y, xz.y) * CLOUD_DETAIL_F, 0.0).r; }
  return clamp(d - CLOUD_ERODE * (1.0 - mix(CLOUD_NOISE_MEAN, n, detail)), 0.0, 1.0);
}

// Sunlight reaching world point w (cells) through the deck: its optical depth
// along the sun, read at CLOUD_SHADOW_N heights through it (the shapes without
// their fine detail, which the sun's penumbra at that height, ~10 m, blurs).
fn cloudShadow(w: vec3f) -> f32 {
  if (FU.clouds == 0u) { return 1.0; }
  var od = 0.0;
  for (var k = 0; k < CLOUD_SHADOW_N; k++) {
    let y = FU.cloudSea + CLOUD_BASE + (f32(k) + 0.5) / f32(CLOUD_SHADOW_N) * CLOUD_THICK;
    od += cloudDensity(w + FU.sun * ((y - w.y) / FU.sun.y), 0.0);   // (the key light stays above DAY.keyElMin)
  }
  return exp(-CLOUD_SIGMA * od * CLOUD_THICK / (FU.sun.y * f32(CLOUD_SHADOW_N)));
}
`;

// The deck seen in World's sky (the far view, shaders/far.js farSky). Needs,
// before it: lib() (the deck, lighting.js's sky, hash33, gFragCoord) and the
// far field's haze (shaders/farShared.js farHazeGLSL: farAir, FAR_HAZE_RGB).
//   cloudHG(mu, g) -> f32           Henyey–Greenstein phase
//   cloudLayer(ro, rd) -> vec4f     the deck seen from ro along rd: rgb the light it
//                                   sends toward the eye (premultiplied, hazed), a how
//                                   much of what lies behind it still shows
export const cloudsGLSL = /* wgsl */ `
const CLOUD_STEPS: i32 = ${CLOUD.steps};
const CLOUD_MAX_SPAN: f32 = ${cells(CLOUD.maxSpanM)};
const CLOUD_MAX_DIST: f32 = ${cells(CLOUD.maxDistM)};
const CLOUD_LIGHT_STEPS: i32 = ${CLOUD.lightSteps};
const CLOUD_LIGHT_STEP0: f32 = ${cells(CLOUD.lightStep0M)};
const CLOUD_G_FWD: f32 = ${glf(CLOUD.gFwd)};
const CLOUD_G_BACK: f32 = ${glf(CLOUD.gBack)};
const CLOUD_G_MIX: f32 = ${glf(CLOUD.gMix)};
const CLOUD_MS_OCTAVES: i32 = ${CLOUD.msOctaves};
const CLOUD_MS_A: f32 = ${glf(CLOUD.msA)};
const CLOUD_MS_B: f32 = ${glf(CLOUD.msB)};
const CLOUD_MS_C: f32 = ${glf(CLOUD.msC)};
const CLOUD_AMB_BASE: f32 = ${glf(CLOUD.ambBase)};
const CLOUD_T_MIN: f32 = ${glf(CLOUD.tMin)};
const CLOUD_HAZE_H: f32 = ${cells(CLOUD.hazeScaleM)};
const CLOUD_FLAT_EPS: f32 = 1e-4;   // height differences below this count as level (the haze's scale-height factor)

fn cloudHG(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI_L * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

fn cloudLayer(ro: vec3f, rd: vec3f) -> vec4f {
  if (rd.y <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let lo = FU.cloudSea + CLOUD_BASE;
  let hi = lo + CLOUD_THICK;
  let t0 = max((lo - ro.y) / rd.y, 0.0);
  if (t0 > CLOUD_MAX_DIST) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let t1 = min((hi - ro.y) / rd.y, t0 + CLOUD_MAX_SPAN);
  let dt = (t1 - t0) / f32(CLOUD_STEPS);
  var t = t0 + dt * hash33(vec3f(gFragCoord, f32(FU.frame))).x;   // jittered: TAA blends the banding away
  let mu = dot(rd, FU.sun);
  let detail = 1.0 - smoothstep(CLOUD_DETAIL_NEAR, CLOUD_DETAIL_FAR, t0);
  var S = vec3f(0.0);
  var T = 1.0;    // transmittance
  var tw = 0.0;   // the in-scatter's mean distance (for the haze): its weighted sum ...
  var ww = 0.0;   // ... and its weight
  var i = 0;
  loop {
    if (i >= CLOUD_STEPS) { break; }
    let p = ro + rd * t;
    let d = cloudDensity(p, detail);
    if (d > 0.0) {
      // sunlight reaching p: optical depth along a short march toward the sun
      var od = 0.0;
      var s0 = 0.0;
      var len = CLOUD_LIGHT_STEP0;
      for (var k = 0; k < CLOUD_LIGHT_STEPS; k++) {
        od += cloudDensity(p + FU.sun * (s0 + 0.5 * len), 0.0) * len;
        s0 += len;
        len *= 2.0;
      }
      od *= CLOUD_SIGMA;
      var sun = 0.0;
      var a = 1.0;
      var b = 1.0;
      var c = 1.0;
      for (var k = 0; k < CLOUD_MS_OCTAVES; k++) {
        sun += b * mix(cloudHG(mu, CLOUD_G_BACK * c), cloudHG(mu, CLOUD_G_FWD * c), CLOUD_G_MIX) * exp(-a * od);
        a *= CLOUD_MS_A;
        b *= CLOUD_MS_B;
        c *= CLOUD_MS_C;
      }
      let h = (p.y - lo) / CLOUD_THICK;
      let L = PI_L * FU.sunCol * sun + mix(FU.ground, FU.skyUp, mix(CLOUD_AMB_BASE, 1.0, h));
      let a0 = 1.0 - exp(-CLOUD_SIGMA * d * dt);   // this step's opacity (albedo 1: what it stops, it scatters)
      let wgt = T * a0;
      S += wgt * L;
      tw += wgt * t;
      ww += wgt;
      T *= 1.0 - a0;
      if (T < CLOUD_T_MIN) { break; }
    }
    continuing {
      i++;
      t += dt;
    }
  }
  if (ww <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // the haze in front: the far field's air, thinning with height over its scale height
  let dist = tw / ww;
  let dy = dist * rd.y;
  var k = 1.0;
  if (dy > CLOUD_FLAT_EPS) { k = CLOUD_HAZE_H / dy * (1.0 - exp(-dy / CLOUD_HAZE_H)); }
  let Th = exp(-FAR_HAZE_RGB * dist * k);
  S = S * Th + farAir(rd) * (1.0 - Th) * (1.0 - T);
  return vec4f(S, T);
}
`;

/** tools/check-wgsl.mjs: probe kernels calling the deck's functions and cloudLayer (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('clouds');
