// Participating media: smoke, steam and fire as continuous density volumes.
//
// Density. The blurred media fields say how much gas is around a point (smoke:
// its remaining life). MEDIA_FLOOR (the brick-skip threshold) is subtracted
// first, so the gas is exactly 0 wherever a brick gets skipped and brick edges
// never show; thin gas then fades in over GAS_EDGE, which keeps edges crisper
// than the blur and lone cells faint. Sub-cell detail comes from tileable noise
// (gfx/mediaNoise.js, uniform on [0, 1]): it displaces the point the fields are
// read at (curling edges, and breaking the lattice's star-shaped blob around a
// lone cell into a wisp), and scales the density around its mean, strongly
// where the gas is thin, gently in dense cores, which keep their optical
// depth. The noise drifts up with the simulation clock (gases rise), so it
// freezes when paused.
//
// Marching. Samples sit on a fixed lattice along the ray (MEDIA_STEP apart,
// jittered per pixel and frame; TAA averages), independent of the voxel grid.
// The DDA hands over one cell segment at a time and the lattice carries on
// across segments and skipped bricks.
//
// Light. Single scattering of the sun with a dual-lobe Henyey–Greenstein
// phase; multiple scattering by Wrenninge et al.'s octaves (2013): each further
// octave sees half the optical depth, MS_B·albedo of the energy and MS_C of
// the anisotropy. Sun visibility = the shadow map (opaque things, liquids and
// the smooth gas, with transport-reduced extinction) beyond SELF_SHADOW_DIST,
// times one sample of the detailed gas before that: billows shade themselves.
// Sky light is attenuated by the gas above; the glow volume (fire, lava)
// scatters isotropically. The hand lamps and wall torches light the gas as the
// sun does (gasLamps: Unreal's Volumetric Fog with local lights), unshadowed
// by walls but windowed to their reach.
// Flames are soot: sheets with a sharp edge that rise in tongues, absorbing and
// emitting blackbody light (Kirchhoff) at the temperature of the burning gas,
// hotter in the core, with a flicker. Tongues are sized like a real fire's
// (a few tenths of its width), and they split dense fire as well as its edge,
// so a big fire is a crown of tongues, not a ball. Inside, the soot gathers
// on thin wrinkled sheets (flamelets) around the noise's mid-level, which
// keeps the mean density: a flame is streaked, not an even glow.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2), pasted after
// surfaceGLSL (footprint, lodFade). The detail noise is a 64³ rgba8unorm 3D
// texture (lighting group binding 10) read through the repeating sampler
// (binding 15) at level 0; GLSL's mod is glslMod (the clock's wrap can go
// negative, H1.2). The close-up switches (mediaDetail.js) are JS template
// switches: detail is the defines object of gfx/detail.js.
import { mediaDetailGLSL, MEDIA_DETAIL_ON } from './mediaDetail.js';

export const mediaGLSL = (detail = {}) => {
  const flow = !!detail.DETAIL_MEDIA_FLOW;
  const fine = !!detail.DETAIL_MEDIA_FINE;
  const stepOn = !!detail.DETAIL_MEDIA_STEP;
  return /* wgsl */ `
// tMediaNoise (r billows, g wisps, b flame tongues, a flicker; gba: warp) is the lighting group's binding 10 (shaders/bindings.js)

const MEDIA_STEP: f32 = 1.0;          // march step (cells): the finest detail is ~4 cells, TAA averages the jitter
const MEDIA_MAX_PER_SEG: i32 = 2;     // lattice samples in one cell segment (<= sqrt(3) / MEDIA_STEP, rounded up)
const MEDIA_MIN_SIGMA: f32 = 1e-4;    // extinction (1/cell) below which a sample adds nothing visible
const MEDIA_DEPTH_ALPHA: f32 = 0.5;   // a pixel's depth goes where the gas has become this opaque...
const MEDIA_KEEP_ALPHA: f32 = 0.002;  // ...and thinner gas than this, with nothing behind it, is dropped
const MEDIA_KEEP_RADIANCE: f32 = 0.002;   // unless it glows this much (flames are nearly transparent)

// ---- sub-cell detail ----
const BILLOW_EDGE: f32 = 0.9;         // detail modulation of thin gas: edges fray into wisps
const BILLOW_CORE: f32 = 0.3;         // ...of dense gas: structure to shade, no holes
const BILLOW_CORE_D: f32 = 0.15;      // density from which gas counts as dense (spreading plumes are mostly 0.02-0.2)
const WISP_AMT: f32 = 0.45;           // finer wisps on top of the billows (relative)
const GAS_WARP: f32 = 0.8;            // how far the noise displaces the gas (cells)
const GAS_EDGE: f32 = 0.1;            // density over which gas fades in from nothing: edges sharper than
                                      // the blurred field's ~3 cells, and lone cells (peak ~0.065) stay faint
const NOISE_MEAN: f32 = 0.5;          // mean of every detail-noise channel (equalised to uniform on [0, 1])
// Flames are sheets with a sharp luminous edge: the fire density, displaced by
// rising tongue noise, crosses FLAME_LEVEL there.
const FLAME_STRETCH: f32 = 2.0;       // tongues are this much taller than wide (a power of 2: seamless clock wrap)
const FLAME_SCALE: f32 = 2.0;         // tongue noise read this many times finer than smoke's (a whole number:
                                      // seamless clock wrap): its finest tongues ~2 cells (0.6 m) across
const FLAME_DETAIL: f32 = 0.3;        // how far the tongues displace the flame's edge (fire density units)
const FLAME_SPLIT: f32 = 0.85;        // ...and how much they scale the fire around its mean (0-1): dense fire splits too
const FLAME_SHEET: f32 = 0.6;         // share of the soot that gathers on the flamelet sheets (0 = an even glow)
const FLAME_SHEET_EXP: f32 = 2.0;     // their sharpness: soot ~ (1 - |2n - 1|)^this, (this + 1) times that keeps the mean
const FLAME_LEVEL: f32 = 0.12;        // fire density at the flame's edge
const FLAME_SOFT: f32 = 0.05;         // half-width of that edge
const FLAME_FLICKER: f32 = 0.12;      // turbulent temperature fluctuation of flames (relative)

// ---- light ----
const PHASE_BACK_G: f32 = -0.3;       // anisotropy of the weak back lobe (droplets and soot backscatter a little)
const PHASE_FWD_W: f32 = 0.85;        // weight of the forward lobe
const MS_OCTAVES: i32 = 3;
const MS_B: f32 = 0.75;               // energy (times albedo) carried by each further octave
const MS_C: f32 = 0.5;                // anisotropy left in each further octave
const SELF_SHADOW_DIST: f32 = 2.0;    // cells toward the sun sampled through the detailed gas
const SELF_SHADOW_MIN_SIGMA: f32 = 0.04;   // extinction (1/cell) below which gas skips that sample
const SKY_PROBE: f32 = 3.0;           // cells up: how much gas hides the sky
// The glow volume is irradiance / pi (like FU.sunCol); isotropic in-scatter of
// irradiance E is E / (4 pi) per unit albedo, so pi / (4 pi).
const GLOW_SCATTER: f32 = 0.25;

// ---- flames ----
const FLAME_RADIANCE: f32 = 3.0;      // soot blackbody radiance at FLAME_REF_K (sunlit white ~1)
const FLAME_REF_K: f32 = 1273.15;     // 1000 °C
const FLAME_T_EXP: f32 = 4.0;         // radiance ~ T^4 (Stefan–Boltzmann)
// The luminous soot in a flame's core burns hotter than the cell average the
// simulation tracks (~750-900 °C for a wood fire): real soot glows at
// ~1200-1500 °C there (wood's adiabatic flame temperature is ~1950 °C), cooling
// toward the edges and tips. This is what makes cores yellow and tips red.
const FLAME_SOOT_DT: f32 = 1000.0;    // soot temperature above the gas's, in the core (°C)
const FLAME_CORE_D: f32 = 0.25;       // fire density from which a flame counts as core
const FLAME_MIN_FIRE: f32 = 0.02;     // fire density below which there is no flame to draw
const FLAME_T_PRIOR: f32 = 800.0;     // typical burning-gas temperature in the simulation (°C)...
const FLAME_PRIOR_W: f32 = 0.15;      // ...weighted as this much fire density

// Gas densities (smoke, steam, fire) from the fields, the brick floor removed.
fn gasBase(m: vec4f) -> vec3f { return max(m.xyz - MEDIA_FLOOR, vec3f(0.0)) * (1.0 / (1.0 - MEDIA_FLOOR)); }
// Transport extinction (similarity relation): forward-scattered light still
// gets through, so diffuse light sees sigma_t (1 - albedo g).
const MD_TRANSPORT: vec3f = MD_EXT * (1.0 - MD_ALBEDO * MD_G);

${mediaDetailGLSL(detail)}

// Detail noise at p, read 'scale' times finer (a whole number), drifting up
// at 'rise' cells/step and stretched along y.
fn gasNoise(p0: vec3f, rise: f32, stretch: f32, scale: f32) -> vec4f {${flow ? `
  return flowNoise(p0, scale, vec3f(0.0), stretch);   // riding the flow instead` : `
  var p = worldPos(p0);   // anchored in the world
  p.y = (p.y - glslMod(FU.simClock * rise, MEDIA_NOISE_CELLS * stretch)) / stretch;
  return textureSampleLevel(tMediaNoise, linearRepeat, p * (scale / MEDIA_NOISE_CELLS), 0.0);`}
}

// Smoke and steam detail: dense gas billows (finer wisps on top); thin gas,
// lone cells included, frays into the finer wisps alone.
fn gasDetail(d: vec2f, n: vec4f) -> vec2f {
  let dense = smoothstep(vec2f(0.0), vec2f(BILLOW_CORE_D), d);
  let wisp = 2.0 * n.g - 1.0;
  let b = mix(vec2f(wisp), vec2f(2.0 * n.r - 1.0 + WISP_AMT * wisp), dense);
  let amt = mix(vec2f(BILLOW_EDGE), vec2f(BILLOW_CORE), dense);
  return d * smoothstep(vec2f(0.0), vec2f(GAS_EDGE), d) * max(1.0 + amt * b, vec2f(0.0));
}

// Detailed densities (smoke, steam, fire) at p. The fields are read at a
// point displaced by up to 'warp' cells along the noise: that curls the gas,
// so lone cells and edges turn into irregular wisps instead of the lattice's
// star-shaped blobs. *m returns the fields read, *nf the flame noise.
fn gasDensity(p0: vec3f, warp: f32, m: ptr<function, vec4f>, nf: ptr<function, vec4f>) -> vec3f {
  var p = p0;
  var mf = mediaField(p);
  *m = mf;
  *nf = vec4f(NOISE_MEAN);
  if (max(mf.x, max(mf.y, mf.z)) <= MEDIA_FLOOR) { return vec3f(0.0); }${flow ? `
  // always the flow: any blend toward another velocity across space (e.g. by
  // transmittance, a shell around the eye) shears the advected noise into rings
  gFlowV = flowVel(p);` : ''}
  let n = gasNoise(p, MD_RISE.y, 1.0, 1.0);
  if (warp > 0.0) {
    p += warp * (2.0 * n.gba - 1.0);
    mf = mediaField(p);
    *m = mf;
  }
  var d = gasBase(mf);
  d = vec3f(gasDetail(d.xy, n), d.z);${fine ? `
  let fine = gasFine(p, d);   // the filaments (xy) and the flame's wrinkle (z)
  d = vec3f(fine.xy, d.z);` : ''}
  if (d.z > 0.0) {
    let nfv = gasNoise(p, MD_RISE.z, FLAME_STRETCH, FLAME_SCALE);
    *nf = nfv;
    var v = d.z * (1.0 + FLAME_SPLIT * (2.0 * nfv.b - 1.0)) + FLAME_DETAIL * (nfv.b - NOISE_MEAN);${fine ? `
    v += fine.z;` : ''}
    d.z = smoothstep(FLAME_LEVEL - FLAME_SOFT, FLAME_LEVEL + FLAME_SOFT, v);
    // flamelets: the soot on the sheets where the wisp noise crosses its mean
    let sheet = (FLAME_SHEET_EXP + 1.0) * pow(1.0 - abs(2.0 * nfv.g - 1.0), FLAME_SHEET_EXP);
    d.z *= 1.0 + FLAME_SHEET * (sheet - 1.0);
  }
  return d;
}

fn gasPhase(mu: f32, g: f32) -> f32 { return hgPhase2(mu, PHASE_BACK_G * g, g, PHASE_FWD_W); }

// Skylight (the gas above shades it) plus the glow volume, scattered.
fn gasAmbient(p: vec3f) -> vec3f {
  let skyT = exp(-dot(MD_TRANSPORT, gasBase(mediaField(p + vec3f(0.0, SKY_PROBE, 0.0)))) * SKY_PROBE);
  return 0.5 * (skyAmbient(vec3f(0.0, 1.0, 0.0)) * skyT + skyAmbient(vec3f(0.0, -1.0, 0.0)))
       + sampleLight(p) * FU.lightGain * GLOW_SCATTER;
}

// Visible sunlight at p inside gas of extinction sigT: the shadow map from
// SELF_SHADOW_DIST toward the sun on, and one sample of the detailed gas
// before that (unwarped and flames as their field: cheaper, and soft anyway).
// Thin gas barely shades itself: there the shadow map at p does.
fn gasSun(p: vec3f, sigT: f32) -> vec3f {
  if (sigT < SELF_SHADOW_MIN_SIGMA) {
    if (FU.shadows != 0u) { return sunShadowAt(p); }
    return vec3f(1.0);
  }
  var T = vec3f(1.0);
  if (FU.shadows != 0u) { T = sunShadowAt(p + FU.sun * SELF_SHADOW_DIST); }
  let q = p + FU.sun * (0.5 * SELF_SHADOW_DIST);
  let m = mediaField(q);
  if (max(m.x, max(m.y, m.z)) <= MEDIA_FLOOR) { return T; }
  var d = gasBase(m);
  d = vec3f(gasDetail(d.xy, gasNoise(q, MD_RISE.y, 1.0, 1.0)), d.z);
  return T * exp(-dot(MD_EXT, d) * SELF_SHADOW_DIST);
}

// The hand lamps' and wall torches' light scattered toward the eye at p (gas
// of extinction sigT, scattering mean anisotropy g, octave energy factor bMul:
// the sun's), as Unreal's Volumetric Fog lights its fog with local lights
// (Wronski 2014, "Volumetric Fog", SIGGRAPH Advances): each lamp's falloff
// (lighting.js lampFall, from its tube's nearest point) times the phase toward
// it, octave by octave as the sun's, in the sunlight's units (FU.sunCol's,
// irradiance / pi). The gas between p and the lamp shades it by one sample of
// the smooth field halfway there (the midpoint rule), as the sun's near gas
// does (gasSun), and thin gas not at all; walls don't (Unreal's local lights
// without volumetric shadows), so the light is windowed to the lamp's reach.
fn gasLamps(p: vec3f, rd: vec3f, sigT: f32, g0: f32, bMul: f32) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }
    let q = lampNearest(i, p);
    let dv = q - p;
    let d2 = dot(dv, dv);
    let R = FU.lampPos[i].w;
    if (d2 >= R * R || !lampLive(i)) { continue; }
    let d = sqrt(d2);
    let mu = dot(rd, dv) * inverseSqrt(max(d2, 1e-8));   // (lighting.js lampSeen's guard)
    var Tl = 1.0;
    if (sigT >= SELF_SHADOW_MIN_SIGMA) {
      Tl = exp(-dot(MD_EXT, gasBase(mediaField(0.5 * (p + q)))) * d);
    }
    var L = 0.0;
    var g = g0;
    var b = 1.0;
    for (var k = 0; k < MS_OCTAVES; k++) {
      L += b * gasPhase(mu, g) * Tl;
      b *= bMul;
      g *= MS_C;
      Tl = sqrt(Tl);
    }
    sum += FU.lampCol[i].rgb * lampFall(d2, R, FU.lampShape[i].x) * L;
  }
  if (FU.beaconDir.w > 0.0) {
    let E = beaconIrradiance(p); // unlike hand lamps, geometry shadows this beam
    let dv = beaconPosition() - p;
    let mu = dot(rd, dv) * inverseSqrt(max(dot(dv, dv), 1e-8));
    // Single scattering by the real gas density below, never an air overlay.
    sum += E * gasPhase(mu, g0);
  }
  return sum;
}

// Integrate the media over the ray segment [ta, tb]. *next is the next
// lattice sample along the ray (start it at jitter * MEDIA_STEP); it carries
// over between segments. Returns the opacity added, for depth decisions.
fn mediaSegment(ro: vec3f, rd: vec3f, ta: f32, tb: f32, next: ptr<function, f32>, col: ptr<function, vec3f>,
                trans: ptr<function, vec3f>) -> f32 {
  let st = mediaStepAt(${stepOn ? 'ro + rd * ta' : 'ta'});
  if (*next < ta || *next >= ta + st) { *next = ta + glslMod(*next - ta, st); }
  if (*next >= tb) { return 0.0; }
  // Nothing here outlives the call: state kept across the tracer's loop costs
  // registers, and so occupancy, for the whole shader.
  let mu = dot(rd, FU.sun);
  var amb = vec3f(-1.0);   // per segment, on its first lit sample
  var tr = 1.0;${stepOn ? `
  // The fine march's light (mediaDetail.js): radiance per unit scattering,
  // evaluated at the base march's rate (once per MEDIA_STEP along the ray, and
  // again when the gas turns thick enough to shade itself) and reused by the
  // fine samples in between, which refine only the density. Sun, sky and lamp
  // light vary over cells (the self-shadow probe is a cell toward the sun), so
  // the fine samples' light is what the base march would have given them.
  var litL = vec3f(0.0);
  var litT = -1.0;          // ray distance where it was evaluated (< 0: not yet)
  var litDense = false;     // whether that sample shaded itself (sigT >= SELF_SHADOW_MIN_SIGMA)` : ''}
  for (var k = 0; k < MEDIA_SEG_SAMPLES; k++) {
    if (*next >= tb) { break; }${MEDIA_DETAIL_ON(detail) ? `
    let tv = *trans;
    gMediaVis = max(tv.r, max(tv.g, tv.b));` : ''}
    let p = ro + rd * (*next);
    let dt = mediaStepAt(${stepOn ? 'p' : '*next'});   // this sample stands for [next, next + dt)${stepOn ? `
    let tS = *next;` : ''}
    *next += dt;
    var m: vec4f;
    var nf: vec4f;
    let sig = MD_EXT * gasDensity(p, GAS_WARP, &m, &nf);
    let sigT = sig.x + sig.y + sig.z;
    if (sigT < MEDIA_MIN_SIGMA) { continue; }
    let sigS2 = sig.xy * MD_ALBEDO.xy;   // fire (soot) doesn't scatter
    let sigS = sigS2.x + sigS2.y;
    var S = vec3f(0.0);
    if (sigS > MEDIA_MIN_SIGMA) {${stepOn ? `
      let dense = sigT >= SELF_SHADOW_MIN_SIGMA;
      if (litT < 0.0 || tS - litT >= MEDIA_STEP || dense != litDense) {
        litT = tS;
        litDense = dense;` : ''}
      // sun, octave by octave: each sees half the optical depth (sqrt of T)
      var Ts = gasSun(p, sigT);
      var Lsun = vec3f(0.0);
      let g0 = dot(sigS2, MD_G.xy) / sigS;
      var g = g0;
      var b = 1.0;
      let bMul = MS_B * sigS / sigT;
      for (var i = 0; i < MS_OCTAVES; i++) {
        Lsun += b * gasPhase(mu, g) * Ts;
        b *= bMul;
        g *= MS_C;
        Ts = sqrt(Ts);
      }
      if (amb.x < 0.0) { amb = gasAmbient(ro + rd * (0.5 * (ta + tb))); }
      // FU.sunCol is irradiance / pi; so is a lamp's colour × falloff
      var Llamp = vec3f(0.0);
      if (FU.lampCount > 0 || FU.beaconDir.w > 0.0) { Llamp = gasLamps(p, rd, sigT, g0, bMul); }${stepOn ? `
        litL = PI_L * (FU.sunCol * Lsun + Llamp) + amb;
      }
      S = sigS * litL;` : `
      S = sigS * (PI_L * (FU.sunCol * Lsun + Llamp) + amb);`}
    }
    if (sig.z > 0.0 && m.z > FLAME_MIN_FIRE) {
      // flames: soot emits blackbody light at the burning gas's temperature
      let core = smoothstep(FLAME_LEVEL, FLAME_CORE_D, m.z);
      // gas temperature = w / fire, pulled toward FLAME_T_PRIOR where there is
      // little fire: both fields carry 8-bit rounding, which the ratio would
      // blow up into colour bands
      let Tgas = (m.w * HEAT_RANGE + FLAME_PRIOR_W * (FLAME_T_PRIOR - AMBIENT)) / (m.z + FLAME_PRIOR_W);
      let T = AMBIENT + (Tgas + FLAME_SOOT_DT * core) * (1.0 + FLAME_FLICKER * (2.0 * nf.a - 1.0));
      S += sig.z * FLAME_RADIANCE * blackbody(T) * pow((T + C_TO_K) / FLAME_REF_K, FLAME_T_EXP);
    }
    // energy-conserving integration over the step (Hillaire 2015)
    let att = exp(-sigT * dt);
    *col += *trans * S * ((1.0 - att) / sigT);
    *trans *= att;
    tr *= att;
  }
  return 1.0 - tr;
}
`;
};

