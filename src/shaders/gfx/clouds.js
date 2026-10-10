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
// The wind drifts the deck with the simulation clock (frozen when paused).
import { CELL_M } from '../../scale.js';

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

// Needs (before it): lighting.js (uSun, SUN_COL, uSkyUp, uGround, PI_L), the
// far field's haze (farAir, FAR_HAZE_RGB), hash33, uFrame, uSea.
export const cloudsGLSL = /* glsl */ `
uniform highp sampler3D tMediaNoise;   // r billows, g wisps (gfx/mediaNoise.js)
uniform vec2 uCloudShift;              // cells: the wind's drift of the deck
#define CLOUD_BASE ${cells(CLOUD.baseM)}
#define CLOUD_THICK ${cells(CLOUD.thickM)}
#define CLOUD_COVER ${glf(CLOUD.cover)}
#define CLOUD_SHAPE_A_F ${glf(CELL_M / CLOUD.shapeAM)}   // tiles per cell
#define CLOUD_SHAPE_B_F ${glf(CELL_M / CLOUD.shapeBM)}
#define CLOUD_SHAPE_B_W ${glf(CLOUD.shapeBW)}
#define CLOUD_SLICE_A ${glf(CLOUD.sliceA)}
#define CLOUD_SLICE_B ${glf(CLOUD.sliceB)}
#define CLOUD_DETAIL_F ${glf(CELL_M / CLOUD.detailM)}
#define CLOUD_ERODE ${glf(CLOUD.erode)}
#define CLOUD_DETAIL_NEAR ${cells(CLOUD.detailFadeM[0])}
#define CLOUD_DETAIL_FAR ${cells(CLOUD.detailFadeM[1])}
#define CLOUD_NOISE_MEAN 0.5  // the noise channels are equalised to uniform on [0, 1]
#define CLOUD_ROUND_LO ${glf(CLOUD.roundLo)}
#define CLOUD_ROUND_HI ${glf(CLOUD.roundHi)}
#define CLOUD_DOME ${glf(CLOUD.dome)}
#define CLOUD_SIGMA ${glf(CLOUD.sigmaM * CELL_M)}   // per cell
#define CLOUD_STEPS ${CLOUD.steps}
#define CLOUD_MAX_SPAN ${cells(CLOUD.maxSpanM)}
#define CLOUD_MAX_DIST ${cells(CLOUD.maxDistM)}
#define CLOUD_LIGHT_STEPS ${CLOUD.lightSteps}
#define CLOUD_LIGHT_STEP0 ${cells(CLOUD.lightStep0M)}
#define CLOUD_G_FWD ${glf(CLOUD.gFwd)}
#define CLOUD_G_BACK ${glf(CLOUD.gBack)}
#define CLOUD_G_MIX ${glf(CLOUD.gMix)}
#define CLOUD_MS_OCTAVES ${CLOUD.msOctaves}
#define CLOUD_MS_A ${glf(CLOUD.msA)}
#define CLOUD_MS_B ${glf(CLOUD.msB)}
#define CLOUD_MS_C ${glf(CLOUD.msC)}
#define CLOUD_AMB_BASE ${glf(CLOUD.ambBase)}
#define CLOUD_T_MIN ${glf(CLOUD.tMin)}
#define CLOUD_HAZE_H ${cells(CLOUD.hazeScaleM)}
#define CLOUD_FLAT_EPS 1e-4   // height differences below this count as level (the haze's scale-height factor)

// Cloud density (0..1) at world point p (cells); detail (0..1): how much the
// fine billows erode it (0: their mean, for the light march and far off).
float cloudDensity(vec3 p, float detail) {
  float h = (p.y - uSea - CLOUD_BASE) / CLOUD_THICK;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec2 xz = p.xz + uCloudShift;
  float w = mix(texture(tMediaNoise, vec3(xz * CLOUD_SHAPE_A_F, CLOUD_SLICE_A)).r,
                texture(tMediaNoise, vec3(xz.yx * CLOUD_SHAPE_B_F, CLOUD_SLICE_B)).g, CLOUD_SHAPE_B_W);
  float cov = (w - (1.0 - CLOUD_COVER)) / CLOUD_COVER;
  if (cov <= 0.0) return 0.0;
  // flat bases, domed tops: the profile thins the coverage away from the core
  float prof = smoothstep(0.0, CLOUD_ROUND_LO, h) * (1.0 - smoothstep(CLOUD_ROUND_HI, 1.0, h));
  float d = cov - CLOUD_DOME * (1.0 - prof);
  if (d <= 0.0) return 0.0;
  float n = detail > 0.0 ? texture(tMediaNoise, vec3(xz.x, p.y, xz.y) * CLOUD_DETAIL_F).r : CLOUD_NOISE_MEAN;
  return clamp(d - CLOUD_ERODE * (1.0 - mix(CLOUD_NOISE_MEAN, n, detail)), 0.0, 1.0);
}

float cloudHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI_L * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// The deck seen from ro along rd: rgb = the light it sends toward the eye
// (premultiplied, hazed), a = how much of what lies behind it still shows.
vec4 cloudLayer(vec3 ro, vec3 rd) {
  if (rd.y <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float lo = uSea + CLOUD_BASE, hi = lo + CLOUD_THICK;
  float t0 = max((lo - ro.y) / rd.y, 0.0);
  if (t0 > CLOUD_MAX_DIST) return vec4(0.0, 0.0, 0.0, 1.0);
  float t1 = min((hi - ro.y) / rd.y, t0 + CLOUD_MAX_SPAN);
  float dt = (t1 - t0) / float(CLOUD_STEPS);
  float t = t0 + dt * hash33(vec3(gl_FragCoord.xy, float(uFrame))).x;   // jittered: TAA blends the banding away
  float mu = dot(rd, uSun);
  float detail = 1.0 - smoothstep(CLOUD_DETAIL_NEAR, CLOUD_DETAIL_FAR, t0);
  vec3 S = vec3(0.0);
  float T = 1.0, tw = 0.0, ww = 0.0;   // transmittance; the in-scatter's mean distance (for the haze)
  for (int i = 0; i < CLOUD_STEPS; i++, t += dt) {
    vec3 p = ro + rd * t;
    float d = cloudDensity(p, detail);
    if (d <= 0.0) continue;
    // sunlight reaching p: optical depth along a short march toward the sun
    float od = 0.0, s0 = 0.0, len = CLOUD_LIGHT_STEP0;
    for (int k = 0; k < CLOUD_LIGHT_STEPS; k++) {
      od += cloudDensity(p + uSun * (s0 + 0.5 * len), 0.0) * len;
      s0 += len; len *= 2.0;
    }
    od *= CLOUD_SIGMA;
    vec3 sun = vec3(0.0);
    float a = 1.0, b = 1.0, c = 1.0;
    for (int k = 0; k < CLOUD_MS_OCTAVES; k++) {
      sun += b * mix(cloudHG(mu, CLOUD_G_BACK * c), cloudHG(mu, CLOUD_G_FWD * c), CLOUD_G_MIX) * exp(-a * od);
      a *= CLOUD_MS_A; b *= CLOUD_MS_B; c *= CLOUD_MS_C;
    }
    float h = (p.y - lo) / CLOUD_THICK;
    vec3 L = PI_L * SUN_COL * sun + mix(uGround, uSkyUp, mix(CLOUD_AMB_BASE, 1.0, h));
    float a0 = 1.0 - exp(-CLOUD_SIGMA * d * dt);   // this step's opacity (albedo 1: what it stops, it scatters)
    float wgt = T * a0;
    S += wgt * L;
    tw += wgt * t; ww += wgt;
    T *= 1.0 - a0;
    if (T < CLOUD_T_MIN) break;
  }
  if (ww <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  // the haze in front: the far field's air, thinning with height over its scale height
  float dist = tw / ww, dy = dist * rd.y;
  float k = dy > CLOUD_FLAT_EPS ? CLOUD_HAZE_H / dy * (1.0 - exp(-dy / CLOUD_HAZE_H)) : 1.0;
  vec3 Th = exp(-FAR_HAZE_RGB * dist * k);
  S = S * Th + farAir(rd) * (1.0 - Th) * (1.0 - T);
  return vec4(S, T);
}
`;
