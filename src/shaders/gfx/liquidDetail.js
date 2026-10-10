import { ELEMENTS } from '../../elements.js';
import { CELL_M } from '../../scale.js';

// Close-up liquid detail (gfx/detail.js switches): what a liquid surface shows
// once a pixel is a few millimetres across. Each part compiles in only with
// its switch, and all of it is a function of the sim state (which liquid,
// where the crisp walls are, how fast unsupported liquid is moving) plus the
// clock the existing ripple model already runs on.
//
//   DETAIL_LIQ_RIPPLES   gravity-capillary ripples: the wind-ripple spectrum
//                        (gfx/liquid.js) continued down to sub-cm wavelengths,
//                        each octave fading in only once pixels resolve it
//   DETAIL_LIQ_MENISCUS  the surface climbing walls and glass over its
//                        capillary length (a few mm), box-filtered per pixel
//   DETAIL_LIQ_FOAM      whitewater: where liquid is falling or splashing fast
//                        (a pour, an impact) its surface roughens and aerates
//                        into foam
//
// Units: everything is sized in metres and converted with CELL_M
// (src/scale.js). Speeds: the sim's time doesn't follow its length scale
// (scale.js), so a speed in cells/step is read through what physically sets
// it, the height fallen: v²/2g_sim cells, i.e. CELL_M times that in metres,
// gives the real speed √(2 g h). That makes one cell/step MS_PER_CELL_STEP.
const G_REAL = 9.81;                   // m/s²
const SIM_GRAVITY = 0.025;             // cells/step² (sim.js GRAVITY_DEFAULT)
const MS_PER_CELL_STEP = Math.sqrt((G_REAL * CELL_M) / SIM_GRAVITY);   // m/s per cell/step (≈ 11)

// Liquid properties at room temperature: surface tension σ (N/m), density ρ
// (kg/m³), contact angle θ on ordinary solids and glass (degrees; water on
// clean glass 0–20°, oils wet nearly everything). Acid is aqueous. Ice is
// solid: no ripples, meniscus or foam.
const LIQ_PROPS = {
  WATER: { sigma: 0.072, rho: 1000, theta: 20 },
  OIL: { sigma: 0.032, rho: 900, theta: 10 },
  ACID: { sigma: 0.072, rho: 1050, theta: 20 },
};
// Capillary length lc = √(σ / ρg) (m): how far the meniscus reaches (2.7 mm
// for water). Meniscus height at the wall h0 = lc·√(2(1 − sin θ)) (m), the
// exact result for a flat wall (Landau & Lifshitz §61).
const capLen = (p) => Math.sqrt(p.sigma / (p.rho * G_REAL));
const menH0 = (p) => capLen(p) * Math.sqrt(2 * (1 - Math.sin((p.theta * Math.PI) / 180)));

// Dispersion of gravity-capillary waves, ω² = gk + σk³/ρ (water), for the
// time scale of each ripple octave.
const omega = (lambdaM) => {
  const k = (2 * Math.PI) / lambdaM;
  const w = LIQ_PROPS.WATER;
  return Math.sqrt(G_REAL * k + (w.sigma * k ** 3) / w.rho);
};
// Ripple octaves continuing the wind ripples (gfx/liquid.js RIPPLE_*: two
// octaves, 0.3 and 0.3·2.1 cycles/cell) down to the gravity-capillary
// crossover, λc = 2π·lc ≈ 1.7 cm for water: the shortest wind ripples (below
// it waves are capillary, damped fast and not wind-sustained). Geometric
// spacing, CAP_OCTAVES of them, the last at λc.
const RIPPLE_BASE_FREQ = 0.3;          // cycles/cell, gfx/liquid.js RIPPLE_FREQ
const RIPPLE_BASE_OCT2 = 2.1;          // gfx/liquid.js RIPPLE_OCT2
const RIPPLE_BASE_DRIFT = 0.6;         // noise units/s, gfx/liquid.js RIPPLE_DRIFT
const CAP_OCTAVES = 5;
const LAMBDA_TOP_M = CELL_M / (RIPPLE_BASE_FREQ * RIPPLE_BASE_OCT2);   // wind ripples' finest, m
const LAMBDA_C_M = 2 * Math.PI * capLen(LIQ_PROPS.WATER);               // crossover, m
const CAP_RATIO = (LAMBDA_TOP_M / LAMBDA_C_M) ** (1 / CAP_OCTAVES);
const CAP_LAMBDAS = Array.from({ length: CAP_OCTAVES }, (_, i) => LAMBDA_TOP_M / CAP_RATIO ** (i + 1));   // m
const CAP_FREQS = CAP_LAMBDAS.map((l) => CELL_M / l);   // cycles/cell
// Each octave evolves faster than the base octave by the ratio of their wave
// frequencies, so the model's existing clock is kept, scaled physically.
const CAP_DRIFTS = CAP_LAMBDAS.map((l) => (RIPPLE_BASE_DRIFT * omega(l)) / omega(CELL_M / RIPPLE_BASE_FREQ));

const g = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(6));
const perLiquid = (fn) => ELEMENTS.map((e) => g(LIQ_PROPS[e.key] ? fn(LIQ_PROPS[e.key]) : 0));

export const liquidDetailGLSL = /* glsl */ `
#if defined(DETAIL_LIQ_RIPPLES) || defined(DETAIL_LIQ_MENISCUS) || defined(DETAIL_LIQ_FOAM)
#define LIQ_DETAIL 1
#endif
#ifdef LIQ_DETAIL
#define MS_PER_CELL_STEP ${g(MS_PER_CELL_STEP)}   // m/s per cell/step
bool liqDetailOn(int id) { return SURFCH[id] == CH_LIQUID && id != E_ICE; }
const float LIQ_SIGMA[NE] = float[NE](${perLiquid((p) => p.sigma).join(', ')});   // surface tension, N/m

// Tilt outward normal n by a height field's world gradient gr (slope units):
// only its part along the surface counts.
vec3 tiltNormal(vec3 n, vec3 gr) { return normalize(n - (gr - n * dot(gr, n))); }
#endif

#ifdef DETAIL_LIQ_RIPPLES
// Gravity-capillary ripples: CAP_OCTAVES octaves past the wind ripples, on the same
// upward-facing surfaces (RIPPLE_UP_*), each its own value-noise height field
// in (x, z, time). Equal slope per octave (the saturation range of wind-wave
// spectra: slope variance flat per octave), the same slope as the wind
// ripples'. Octaves fade in by the pixel footprint (lodFade), so far away
// nothing changes.
#define CAP_OCTAVES ${CAP_OCTAVES}
const float CAP_FREQ[CAP_OCTAVES] = float[CAP_OCTAVES](${CAP_FREQS.map(g).join(', ')});    // cycles/cell (λ ${CAP_LAMBDAS.map((l) => (l * 100).toFixed(1)).join(', ')} cm)
const float CAP_DRIFT[CAP_OCTAVES] = float[CAP_OCTAVES](${CAP_DRIFTS.map(g).join(', ')});  // noise units/s, by dispersion
#define CAP_SHIFT 13.7   // lattice offset per octave (noise units), so octaves don't line up
vec3 liquidCapillary(vec3 p, vec3 n) {
  float up = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y);
  if (up <= 0.0) return n;
  float fp = footprint(p);
  vec2 wq = worldPos(p).xz;   // anchored in the world, like the wind ripples
  vec3 gr = vec3(0.0);
  for (int i = 0; i < CAP_OCTAVES; i++) {
    float w = lodFade(CAP_FREQ[i], fp);
    if (w <= 0.0) break;
    // d/d(noise xz) is the slope per unit noise gradient, as RIPPLE_SLOPE
    vec4 h = mNoiseD(vec3(wq * CAP_FREQ[i] + CAP_SHIFT * float(i + 1), uTime * CAP_DRIFT[i]));
    gr.xz += h.yz * w;
  }
  return tiltNormal(n, gr * RIPPLE_SLOPE * up);
}
#endif

#ifdef DETAIL_LIQ_MENISCUS
// Meniscus: next to a crisp wall the surface climbs h(d) = h0·exp(−d/lc)
// (linearised Young–Laplace; d = distance to the wall). Its slope, averaged
// over the pixel's footprint [d − fp/2, d + fp/2] (exactly: the height
// difference across it over its width), tilts the normal away from the wall:
// a thin bright or dark line where water meets glass, and nothing when a
// pixel is much wider than lc.
const float MEN_LC[NE] = float[NE](${perLiquid((p) => capLen(p) / CELL_M).join(', ')});   // cells
const float MEN_H0[NE] = float[NE](${perLiquid((p) => menH0(p) / CELL_M).join(', ')});    // cells
#define MEN_PROBE 0.25   // cells into the liquid (against n) where the wall cells are looked up
float menHeight(float d, float lc, float h0) { return h0 * exp(-max(d, 0.0) / lc); }
vec3 liquidMeniscus(vec3 p, vec3 n, int id) {
  if (n.y < RIPPLE_UP_LO) return n;
  float lc = MEN_LC[id], h0 = MEN_H0[id];
  float half_ = 0.5 * footprint(p);
  ivec3 c = ivec3(floor(p - n * MEN_PROBE));
  vec2 f = p.xz - vec2(c.xz);
  vec2 gr = vec2(0.0);   // height gradient, xz
  for (int k = 0; k < 4; k++) {
    ivec3 q = c;
    int ax = k < 2 ? 0 : 2;
    float s = (k & 1) == 0 ? -1.0 : 1.0;   // side the wall is on
    q[ax] += int(s);
    if (outside(q) || !isCrisp(eid(fetchA(q)))) continue;
    float d = s < 0.0 ? f[ax >> 1] : 1.0 - f[ax >> 1];   // to the wall's face
    float a = d - half_, b = d + half_;
    float slope = (menHeight(a, lc, h0) - menHeight(b, lc, h0)) / max(b - max(a, 0.0), 1e-6);
    gr[ax >> 1] += s * slope;   // the surface rises toward the wall
  }
  return tiltNormal(n, vec3(gr.x, 0.0, gr.y));
}
#endif

#ifdef DETAIL_LIQ_FOAM
// Whitewater. Agitation is how fast free liquid (falling, spraying,
// splashing) moves near the surface: the sim accelerates it by gravity and
// turns impacts into sideways splash (move.js land), so its speed is real.
// Free means moving down (a jet: every cell rides on the falling one below
// it, which the react pass's normal force doesn't hold up, so v.y < 0) or
// with nothing under it (spray). Liquid resting on liquid is held (v.y = 0)
// and carries the automaton's flow impulses instead (pool cells hold ±1
// sideways at rest), so it doesn't count, nor do curl or divergence of those.
// Measured as the flux of it coming down onto the surface point: the mean,
// over the AGIT_REACH cells above it, of free liquid's speed (a
// solid jet at speed v gives v; a sparse spray, its volume fraction of v),
// bilinear across the four columns around the point. Over a pool that is
// what lands there; on a stream's side, the stream above.
#define AGIT_REACH 4           // cells above the point (1.2 m at CELL_M = 0.3)
#define AGIT_GATE_LIFT 2.5     // cells above the point where the gate reads the liquid field
#define AGIT_GATE_PHI 0.02     // liquid field below which nothing is up there
// Air entrainment by a plunging jet starts at ~1 m/s (Ervine et al. 1980;
// Chanson 1997); a jet past ~4 m/s is white with it.
#define FOAM_V_ONSET 1.0       // m/s
#define FOAM_V_FULL 4.0        // m/s
bool supports(int id) { return id != E_EMPTY && KIND[id] != K_GAS; }
// speed of liquid in cell c with below under it, if it is free (else 0); cells/step
float freeSpeed(ivec3 c, int below) {
  vec3 v = fetchB(c).xyz;
  return v.y < 0.0 || !supports(below) ? length(v) : 0.0;
}
float columnFlux(ivec3 c) {   // c = lowest cell; cells/step
  if (c.x < 0 || c.z < 0 || c.x >= NX || c.z >= NZ) return 0.0;
  int below = c.y > 0 ? eid(fetchA(c - ivec3(0, 1, 0))) : E_WALL;
  float s = 0.0;
  for (int k = 0; k < AGIT_REACH; k++) {
    if (c.y >= NY) break;
    int id = eid(fetchA(c));
    if (liqDetailOn(id)) s += freeSpeed(c, below);
    below = id;
    c.y++;
  }
  return s / float(AGIT_REACH);
}
float agitation(vec3 p) {   // 0..1
  // Cheap gate first: the (blurred, time-smoothed) liquid field halfway up
  // the reach. Over a flat pool it is the tail of the blur, ~0.006 there
  // (σ = 1 cell, 2.5 cells above the 0.5 level); a single drop anywhere in
  // the reach lifts it past ~0.05. So nothing above: no column walks.
  if (surfField(p + vec3(0.0, AGIT_GATE_LIFT, 0.0)).x < AGIT_GATE_PHI) return 0.0;
  ivec3 c = ivec3(floor(p));
  vec2 q = p.xz - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  float s = mix(mix(columnFlux(ivec3(i.x, c.y, i.y)), columnFlux(ivec3(i.x + 1, c.y, i.y)), f.x),
                mix(columnFlux(ivec3(i.x, c.y, i.y + 1)), columnFlux(ivec3(i.x + 1, c.y, i.y + 1)), f.x), f.y);
  return smoothstep(FOAM_V_ONSET, FOAM_V_FULL, s * MS_PER_CELL_STEP);
}
// Falling liquid itself tears up and aerates once air drag beats surface
// tension: Weber number We = ρ_air v² D / σ, with D a cell (the size of the
// sim's smallest blob of liquid). Bag breakup starts at We ≈ 12, and past
// ≈ 50 (multimode, then sheet-thinning breakup) the blob is ragged and white
// (Pilch & Erdman 1987).
#define WE_ONSET 12.0
#define WE_FULL 50.0
#define AIR_RHO 1.2            // kg/m³
#define BREAKUP_PROBE 0.5      // cells into the liquid (against n) where its cell is read
float breakup(vec3 p, vec3 n, int id) {   // 0..1
  ivec3 c = ivec3(floor(p - n * BREAKUP_PROBE));
  if (outside(c) || c.y == 0 || eid(fetchA(c)) != id) return 0.0;
  float v = freeSpeed(c, eid(fetchA(c - ivec3(0, 1, 0)))) * MS_PER_CELL_STEP;
  return smoothstep(WE_ONSET, WE_FULL, AIR_RHO * v * v * CELL_M / LIQ_SIGMA[id]);
}

// Noise in the plane the surface faces most (x, y or z), evolving in time:
// (value, world gradient). Planes blend by |n|^4 (triplanar); planes under
// TRI_MIN weight are skipped, so a pool reads one.
#define TRI_POW 4.0
#define TRI_MIN 0.05
vec4 triNoiseD(vec3 p, vec3 n, float f, float t) {
  vec3 w = pow(abs(n), vec3(TRI_POW));
  w /= w.x + w.y + w.z;
  vec4 r = vec4(0.0);
  if (w.x > TRI_MIN) { vec4 h = mNoiseD(vec3(p.yz * f, t)); r += w.x * vec4(h.x, 0.0, h.yz * f); }
  if (w.y > TRI_MIN) { vec4 h = mNoiseD(vec3(p.xz * f, t)); r += w.y * vec4(h.x, h.y * f, 0.0, h.z * f); }
  if (w.z > TRI_MIN) { vec4 h = mNoiseD(vec3(p.xy * f, t)); r += w.z * vec4(h.x, h.yz * f, 0.0); }
  return r / max(w.x * step(TRI_MIN, w.x) + w.y * step(TRI_MIN, w.y) + w.z * step(TRI_MIN, w.z), 1e-6);
}

// Agitated water is rough: breaking, churning surfaces carry slopes of
// ~0.3 over ~15 cm (Cox & Munk's slope variance at gale force is ~0.05,
// rms 0.22, and a plunge pool is rougher still).
#define ROUGH_LAMBDA_M 0.15    // m, size of the churned bumps
#define ROUGH_FREQ (CELL_M / ROUGH_LAMBDA_M)   // cycles/cell
#define ROUGH_SLOPE 0.3        // rms-ish slope at full agitation, per unit noise gradient
#define ROUGH_RATE 3.0         // noise units/s: churn decorrelates in ~1/3 s
// Foam: a bubble raft, patchy (two octaves of noise thresholded to the
// covered fraction), white by multiple scattering: fresh foam reflects ~55%
// of light (Whitlock et al. 1982), scattered nearly diffusely and wrapping
// past the terminator, since light goes in and out of the bubble layer.
#define FOAM_COVER_MAX 0.7     // covered fraction where a jet plunges at full agitation
#define SPRAY_COVER_MAX 0.3    // ... and on falling liquid fully torn up (white streaks, still clear between)
#define FOAM_PATCH_M 0.12      // m, foam patches between open water
#define FOAM_CLUSTER_M 0.04    // m, bubble clusters within them (second octave)
#define FOAM_FREQ (CELL_M / FOAM_PATCH_M)      // cycles/cell
#define FOAM_FREQ2 (CELL_M / FOAM_CLUSTER_M)   // cycles/cell
#define FOAM_OCT2_W 0.4        // its weight (first: 1 − this)
#define FOAM_RATE 1.5          // noise units/s
#define FOAM_EDGE 0.08         // threshold softness (noise units)
#define FOAM_ALBEDO 0.55
#define FOAM_WRAP 0.5          // diffuse wrap (0 = Lambert)
#define FOAM_SHIFT 29.3        // lattice offset of the foam noise from the roughness noise
void liquidFoam(vec3 p, inout vec3 n, int id, inout vec3 col, inout vec3 trans) {
  float agI = agitation(p), agB = breakup(p, n, id);
  float ag = max(agI, agB);
  if (ag <= 0.0) return;
  float fp = footprint(p);
  float t = uTime;
  vec3 wp = worldPos(p);   // the churn and foam are anchored in the world
  vec4 r = triNoiseD(wp, n, ROUGH_FREQ, t * ROUGH_RATE);
  n = tiltNormal(n, r.yzw * (ROUGH_SLOPE * ag * lodFade(ROUGH_FREQ, fp) / ROUGH_FREQ));
  // covered fraction: the pattern where pixels resolve it, its mean beyond
  float cover = max(FOAM_COVER_MAX * agI, SPRAY_COVER_MAX * agB);
  float pw = lodFade(FOAM_FREQ, fp);
  float c = cover;
  if (pw > 0.0) {
    vec3 q = wp + FOAM_SHIFT;
    float v = mix(triNoiseD(q, n, FOAM_FREQ, t * FOAM_RATE).x, triNoiseD(q, n, FOAM_FREQ2, t * FOAM_RATE).x,
                  FOAM_OCT2_W * lodFade(FOAM_FREQ2, fp));
    c = mix(cover, smoothstep(1.0 - cover - FOAM_EDGE, 1.0 - cover + FOAM_EDGE, v), pw);
  }
  if (c <= 0.0) return;
  vec3 sunVis = uShadows ? sunShadow(p + n * IFACE_PROBE) : vec3(1.0);
  float diff = max((dot(n, uSun) + FOAM_WRAP) / (1.0 + FOAM_WRAP), 0.0);
  vec3 L = SUN_COL * sunVis * diff + skyAmbient(n) + sampleLight(p) * uLightGain;
  col += trans * c * FOAM_ALBEDO * L;
  trans *= 1.0 - c;
}
#endif

#ifdef LIQ_DETAIL
// The tracer's hook at a liquid surface event: hp, outward normal n (wind
// ripples applied), liquid id. Returns the normal to refract/reflect with;
// foam adds its light and covers what is behind it.
vec3 liquidDetail(vec3 hp, vec3 n, int id, inout vec3 col, inout vec3 trans) {
  if (!liqDetailOn(id)) return n;
#ifdef DETAIL_LIQ_RIPPLES
  n = liquidCapillary(hp, n);
#endif
#ifdef DETAIL_LIQ_MENISCUS
  n = liquidMeniscus(hp, n, id);
#endif
#ifdef DETAIL_LIQ_FOAM
  liquidFoam(hp, n, id, col, trans);
#endif
  return n;
}
#endif
`;
