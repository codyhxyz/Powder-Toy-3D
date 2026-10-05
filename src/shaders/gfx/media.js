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
// scatters isotropically.
// Flames are soot: sheets with a sharp edge that rise in tongues, absorbing and
// emitting blackbody light (Kirchhoff) at the temperature of the burning gas,
// hotter in the core, with a flicker.
export const mediaGLSL = /* glsl */ `
uniform highp sampler3D tMediaNoise;   // r billows, g wisps, b flame tongues, a flicker (gba: warp)
uniform float uSimClock;               // simulation steps (wrapped)

#define MEDIA_STEP 1.0          // march step (cells): the finest detail is ~4 cells, TAA averages the jitter
#define MEDIA_MAX_PER_SEG 2     // lattice samples in one cell segment (<= sqrt(3) / MEDIA_STEP, rounded up)
#define MEDIA_MIN_SIGMA 1e-4    // extinction (1/cell) below which a sample adds nothing visible
#define MEDIA_DEPTH_ALPHA 0.5   // a pixel's depth goes where the gas has become this opaque...
#define MEDIA_KEEP_ALPHA 0.002  // ...and thinner gas than this, with nothing behind it, is dropped
#define MEDIA_KEEP_RADIANCE 0.002   // unless it glows this much (flames are nearly transparent)

// ---- sub-cell detail ----
#define BILLOW_EDGE 0.9         // detail modulation of thin gas: edges fray into wisps
#define BILLOW_CORE 0.3         // ...of dense gas: structure to shade, no holes
#define BILLOW_CORE_D 0.15      // density from which gas counts as dense (spreading plumes are mostly 0.02-0.2)
#define WISP_AMT 0.45           // finer wisps on top of the billows (relative)
#define GAS_WARP 0.8            // how far the noise displaces the gas (cells)
#define GAS_EDGE 0.1            // density over which gas fades in from nothing: edges sharper than
                                // the blurred field's ~3 cells, and lone cells (peak ~0.065) stay faint
#define NOISE_MEAN 0.5          // mean of every detail-noise channel (equalised to uniform on [0, 1])
// Flames are sheets with a sharp luminous edge: the fire density, displaced by
// rising tongue noise, crosses FLAME_LEVEL there.
#define FLAME_STRETCH 2.0       // tongues are this much taller than wide (a power of 2: seamless clock wrap)
#define FLAME_DETAIL 0.3        // how far the tongues displace the flame's edge (fire density units)
#define FLAME_LEVEL 0.12        // fire density at the flame's edge
#define FLAME_SOFT 0.05         // half-width of that edge
#define FLAME_FLICKER 0.12      // turbulent temperature fluctuation of flames (relative)

// ---- light ----
#define PHASE_BACK_G -0.3       // anisotropy of the weak back lobe (droplets and soot backscatter a little)
#define PHASE_FWD_W 0.85        // weight of the forward lobe
#define MS_OCTAVES 3
#define MS_B 0.75               // energy (times albedo) carried by each further octave
#define MS_C 0.5                // anisotropy left in each further octave
#define SELF_SHADOW_DIST 2.0    // cells toward the sun sampled through the detailed gas
#define SELF_SHADOW_MIN_SIGMA 0.04   // extinction (1/cell) below which gas skips that sample
#define SKY_PROBE 3.0           // cells up: how much gas hides the sky
// The glow volume is irradiance / pi (like SUN_COL); isotropic in-scatter of
// irradiance E is E / (4 pi) per unit albedo, so pi / (4 pi).
#define GLOW_SCATTER 0.25

// ---- flames ----
#define FLAME_RADIANCE 3.0      // soot blackbody radiance at FLAME_REF_K (sunlit white ~1)
#define FLAME_REF_K 1273.15     // 1000 °C
#define FLAME_T_EXP 4.0         // radiance ~ T^4 (Stefan–Boltzmann)
// The luminous soot in a flame's core burns hotter than the cell average the
// simulation tracks (~750-900 °C for a wood fire): real soot glows at
// ~1200-1500 °C there (wood's adiabatic flame temperature is ~1950 °C), cooling
// toward the edges and tips. This is what makes cores yellow and tips red.
#define FLAME_SOOT_DT 1000.0    // soot temperature above the gas's, in the core (°C)
#define FLAME_CORE_D 0.25       // fire density from which a flame counts as core
#define FLAME_MIN_FIRE 0.02     // fire density below which there is no flame to draw
#define FLAME_T_PRIOR 800.0     // typical burning-gas temperature in the simulation (°C)...
#define FLAME_PRIOR_W 0.15      // ...weighted as this much fire density

// Gas densities (smoke, steam, fire) from the fields, the brick floor removed.
vec3 gasBase(vec4 m) { return max(m.xyz - MEDIA_FLOOR, 0.0) * (1.0 / (1.0 - MEDIA_FLOOR)); }
// Transport extinction (similarity relation): forward-scattered light still
// gets through, so diffuse light sees sigma_t (1 - albedo g).
const vec3 MD_TRANSPORT = MD_EXT * (1.0 - MD_ALBEDO * MD_G);

// Detail noise at p, drifting up at 'rise' cells/step and stretched along y.
vec4 gasNoise(vec3 p, float rise, float stretch) {
  p.y = (p.y - mod(uSimClock * rise, MEDIA_NOISE_CELLS * stretch)) / stretch;
  return texture(tMediaNoise, p * (1.0 / MEDIA_NOISE_CELLS));
}

// Smoke and steam detail: dense gas billows (finer wisps on top); thin gas,
// lone cells included, frays into the finer wisps alone.
vec2 gasDetail(vec2 d, vec4 n) {
  vec2 dense = smoothstep(vec2(0.0), vec2(BILLOW_CORE_D), d);
  float wisp = 2.0 * n.g - 1.0;
  vec2 b = mix(vec2(wisp), vec2(2.0 * n.r - 1.0 + WISP_AMT * wisp), dense);
  vec2 amt = mix(vec2(BILLOW_EDGE), vec2(BILLOW_CORE), dense);
  return d * smoothstep(vec2(0.0), vec2(GAS_EDGE), d) * max(1.0 + amt * b, 0.0);
}

// Detailed densities (smoke, steam, fire) at p. The fields are read at a
// point displaced by up to 'warp' cells along the noise: that curls the gas,
// so lone cells and edges turn into irregular wisps instead of the lattice's
// star-shaped blobs. m returns the fields read, nf the flame noise.
vec3 gasDensity(vec3 p, float warp, out vec4 m, out vec4 nf) {
  m = mediaField(p);
  nf = vec4(NOISE_MEAN);
  if (max(m.x, max(m.y, m.z)) <= MEDIA_FLOOR) return vec3(0.0);
  vec4 n = gasNoise(p, MD_RISE.y, 1.0);
  if (warp > 0.0) {
    p += warp * (2.0 * n.gba - 1.0);
    m = mediaField(p);
  }
  vec3 d = gasBase(m);
  d.xy = gasDetail(d.xy, n);
  if (d.z > 0.0) {
    nf = gasNoise(p, MD_RISE.z, FLAME_STRETCH);
    float v = d.z + FLAME_DETAIL * (nf.b - NOISE_MEAN);
    d.z = smoothstep(FLAME_LEVEL - FLAME_SOFT, FLAME_LEVEL + FLAME_SOFT, v);
  }
  return d;
}

float hgPhase(float mu, float g) {
  float k = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / (4.0 * PI_L * k * sqrt(k));
}
float gasPhase(float mu, float g) { return mix(hgPhase(mu, PHASE_BACK_G * g), hgPhase(mu, g), PHASE_FWD_W); }

// Skylight (the gas above shades it) plus the glow volume, scattered.
vec3 gasAmbient(vec3 p) {
  float skyT = exp(-dot(MD_TRANSPORT, gasBase(mediaField(p + vec3(0.0, SKY_PROBE, 0.0)))) * SKY_PROBE);
  return 0.5 * (skyAmbient(vec3(0.0, 1.0, 0.0)) * skyT + skyAmbient(vec3(0.0, -1.0, 0.0)))
       + sampleLight(p) * uLightGain * GLOW_SCATTER;
}

// Visible sunlight at p inside gas of extinction sigT: the shadow map from
// SELF_SHADOW_DIST toward the sun on, and one sample of the detailed gas
// before that (unwarped and flames as their field: cheaper, and soft anyway).
// Thin gas barely shades itself: there the shadow map at p does.
vec3 gasSun(vec3 p, float sigT) {
  if (sigT < SELF_SHADOW_MIN_SIGMA) return uShadows ? sunShadow(p) : vec3(1.0);
  vec3 T = uShadows ? sunShadow(p + uSun * SELF_SHADOW_DIST) : vec3(1.0);
  vec3 q = p + uSun * (0.5 * SELF_SHADOW_DIST);
  vec4 m = mediaField(q);
  if (max(m.x, max(m.y, m.z)) <= MEDIA_FLOOR) return T;
  vec3 d = gasBase(m);
  d.xy = gasDetail(d.xy, gasNoise(q, MD_RISE.y, 1.0));
  return T * exp(-dot(MD_EXT, d) * SELF_SHADOW_DIST);
}

// Heat shimmer: hot air has a lower refractive index, so rays bend. Returns
// the (possibly perturbed) primary ray direction for the box span [t0, t1].
vec3 hazeBend(vec3 ro, vec3 rd, float t0, float t1) {
  return rd;
}

// Integrate the media over the ray segment [ta, tb]. 'next' is the next
// lattice sample along the ray (start it at jitter * MEDIA_STEP); it carries
// over between segments. Returns the opacity added, for depth decisions.
float mediaSegment(vec3 ro, vec3 rd, float ta, float tb, inout float next, inout vec3 col, inout vec3 trans) {
  if (next < ta || next >= ta + MEDIA_STEP) next = ta + mod(next - ta, MEDIA_STEP);
  if (next >= tb) return 0.0;
  // Nothing here outlives the call: state kept across the tracer's loop costs
  // registers, and so occupancy, for the whole shader.
  float mu = dot(rd, uSun);
  vec3 amb = vec3(-1.0);   // per segment, on its first lit sample
  float tr = 1.0;
  for (int k = 0; k < MEDIA_MAX_PER_SEG; k++) {
    if (next >= tb) break;
    vec3 p = ro + rd * next;
    next += MEDIA_STEP;
    vec4 m, nf;
    vec3 sig = MD_EXT * gasDensity(p, GAS_WARP, m, nf);
    float sigT = sig.x + sig.y + sig.z;
    if (sigT < MEDIA_MIN_SIGMA) continue;
    vec2 sigS2 = sig.xy * MD_ALBEDO.xy;   // fire (soot) doesn't scatter
    float sigS = sigS2.x + sigS2.y;
    vec3 S = vec3(0.0);
    if (sigS > MEDIA_MIN_SIGMA) {
      // sun, octave by octave: each sees half the optical depth (sqrt of T)
      vec3 Ts = gasSun(p, sigT), Lsun = vec3(0.0);
      float g = dot(sigS2, MD_G.xy) / sigS, b = 1.0, bMul = MS_B * sigS / sigT;
      for (int i = 0; i < MS_OCTAVES; i++) {
        Lsun += b * gasPhase(mu, g) * Ts;
        b *= bMul; g *= MS_C;
        Ts = sqrt(Ts);
      }
      if (amb.x < 0.0) amb = gasAmbient(ro + rd * (0.5 * (ta + tb)));
      // SUN_COL is irradiance / pi
      S = sigS * (PI_L * SUN_COL * Lsun + amb);
    }
    if (sig.z > 0.0 && m.z > FLAME_MIN_FIRE) {
      // flames: soot emits blackbody light at the burning gas's temperature
      float core = smoothstep(FLAME_LEVEL, FLAME_CORE_D, m.z);
      // gas temperature = w / fire, pulled toward FLAME_T_PRIOR where there is
      // little fire: both fields carry 8-bit rounding, which the ratio would
      // blow up into colour bands
      float Tgas = (m.w * HEAT_RANGE + FLAME_PRIOR_W * (FLAME_T_PRIOR - AMBIENT)) / (m.z + FLAME_PRIOR_W);
      float T = AMBIENT + (Tgas + FLAME_SOOT_DT * core) * (1.0 + FLAME_FLICKER * (2.0 * nf.a - 1.0));
      S += sig.z * FLAME_RADIANCE * blackbody(T) * pow((T + C_TO_K) / FLAME_REF_K, FLAME_T_EXP);
    }
    // energy-conserving integration over the step (Hillaire 2015)
    float att = exp(-sigT * MEDIA_STEP);
    col += trans * S * ((1.0 - att) / sigT);
    trans *= att;
    tr *= att;
  }
  return 1.0 - tr;
}
`;
