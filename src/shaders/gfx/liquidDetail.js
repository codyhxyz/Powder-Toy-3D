import { ELEMENTS } from '../../elements.js';

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
// Units: the sim's cells are CELL_M metres, and a step lasts STEP_S seconds
// (what makes its gravity real gravity), so velocities in cells/step convert
// to m/s and the physical constants below to cells.

const CELL_M = 0.08;                   // m per cell
const G_REAL = 9.81;                   // m/s²
const SIM_GRAVITY = 0.025;             // cells/step² (sim.js GRAVITY_DEFAULT)
const STEP_S = Math.sqrt((SIM_GRAVITY * CELL_M) / G_REAL);   // s per step (≈ 1/70)
const MS_PER_CELL_STEP = CELL_M / STEP_S;                    // m/s per cell/step (≈ 5.6)

// Liquid properties at room temperature: surface tension σ (N/m), density ρ
// (kg/m³), contact angle θ on ordinary solids and glass (degrees; water on
// clean glass 0–20°, oils wet nearly everything). Acid is aqueous. Ice is
// solid: no ripples, meniscus or foam.
const LIQ_PROPS = {
  WATER: { sigma: 0.072, rho: 1000, theta: 20 },
  OIL: { sigma: 0.032, rho: 900, theta: 10 },
  ACID: { sigma: 0.072, rho: 1050, theta: 20 },
};
// Capillary length lc = √(σ / ρg) (m): how far the meniscus reaches.
// Meniscus height at the wall h0 = lc·√(2(1 − sin θ)) (m), the exact result
// for a flat wall (Landau & Lifshitz §61).
const capLen = (p) => Math.sqrt(p.sigma / (p.rho * G_REAL));
const menH0 = (p) => capLen(p) * Math.sqrt(2 * (1 - Math.sin((p.theta * Math.PI) / 180)));

// Dispersion of gravity-capillary waves, ω² = gk + σk³/ρ (water), for the
// time scale of each ripple octave (k from cycles per cell).
const omega = (cyclesPerCell) => {
  const k = (2 * Math.PI * cyclesPerCell) / CELL_M;
  const w = LIQ_PROPS.WATER;
  return Math.sqrt(G_REAL * k + (w.sigma * k ** 3) / w.rho);
};
// Ripple octaves added below the wind ripples' two (gfx/liquid.js RIPPLE_*:
// 0.3 and 0.63 cycles/cell). Wavelengths ≈ 6, 3 and 1.5 cm: the last one is
// at the gravity-capillary crossover (1.7 cm), the shortest wind ripples.
const RIPPLE_BASE_FREQ = 0.3;          // cycles/cell, gfx/liquid.js RIPPLE_FREQ
const RIPPLE_BASE_DRIFT = 0.6;         // noise units/s, gfx/liquid.js RIPPLE_DRIFT
const CAP_FREQS = [1.3, 2.64, 5.36];   // cycles/cell (λ = CELL_M / f)
// Each octave evolves faster than the base octave by the ratio of their wave
// frequencies, so the model's existing (slow) clock is kept, scaled physically.
const CAP_DRIFTS = CAP_FREQS.map((f) => (RIPPLE_BASE_DRIFT * omega(f)) / omega(RIPPLE_BASE_FREQ));

const g = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(6));
const perLiquid = (fn) => ELEMENTS.map((e) => g(LIQ_PROPS[e.key] ? fn(LIQ_PROPS[e.key]) : 0));

export const liquidDetailGLSL = /* glsl */ `
#if defined(DETAIL_LIQ_RIPPLES) || defined(DETAIL_LIQ_MENISCUS) || defined(DETAIL_LIQ_FOAM)
#define LIQ_DETAIL 1
#endif
#ifdef LIQ_DETAIL
#define MS_PER_CELL_STEP ${g(MS_PER_CELL_STEP)}   // m/s per cell/step
#define CELL_M ${g(CELL_M)}                       // m per cell
bool liqDetailOn(int id) { return SURFCH[id] == CH_LIQUID && id != E_ICE; }
const float LIQ_SIGMA[NE] = float[NE](${perLiquid((p) => p.sigma).join(', ')});   // surface tension, N/m

// Tilt outward normal n by a height field's world gradient gr (slope units):
// only its part along the surface counts.
vec3 tiltNormal(vec3 n, vec3 gr) { return normalize(n - (gr - n * dot(gr, n))); }
#endif

#ifdef DETAIL_LIQ_RIPPLES
// Gravity-capillary ripples: three octaves past the wind ripples, on the same
// upward-facing surfaces (RIPPLE_UP_*), each its own value-noise height field
// in (x, z, time). Equal slope per octave (the saturation range of wind-wave
// spectra: slope variance flat per octave), the same slope as the wind
// ripples'. Octaves fade in by the pixel footprint (lodFade), so far away
// nothing changes.
const float CAP_FREQ[3] = float[3](${CAP_FREQS.map(g).join(', ')});    // cycles/cell
const float CAP_DRIFT[3] = float[3](${CAP_DRIFTS.map(g).join(', ')});  // noise units/s, by dispersion
#define CAP_SHIFT 13.7   // lattice offset per octave (noise units), so octaves don't line up
vec3 liquidCapillary(vec3 p, vec3 n) {
  float up = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y);
  if (up <= 0.0) return n;
  float fp = footprint(p);
  vec3 gr = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float w = lodFade(CAP_FREQ[i], fp);
    if (w <= 0.0) break;
    // d/d(noise xz) is the slope per unit noise gradient, as RIPPLE_SLOPE
    vec4 h = mNoiseD(vec3(p.xz * CAP_FREQ[i] + CAP_SHIFT * float(i + 1), uTime * CAP_DRIFT[i]));
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
    if (outside(q) || !isCrisp(eid(cellA(q)))) continue;
    float d = s < 0.0 ? f[ax >> 1] : 1.0 - f[ax >> 1];   // to the wall's face
    float a = d - half_, b = d + half_;
    float slope = (menHeight(a, lc, h0) - menHeight(b, lc, h0)) / max(b - max(a, 0.0), 1e-6);
    gr[ax >> 1] += s * slope;   // the surface rises toward the wall
  }
  return tiltNormal(n, vec3(gr.x, 0.0, gr.y));
}
#endif

#ifdef DETAIL_LIQ_FOAM
// Whitewater. Agitation is how fast unsupported liquid (nothing solid or
// liquid under it: falling, spraying, splashing) moves near the surface: the
// sim accelerates it by gravity and turns impacts into sideways splash
// (move.js land), so its speed is real. Liquid resting on liquid carries the
// automaton's flow impulses instead (pool cells hold ±1 sideways at rest), so
// it doesn't count, nor do curl or divergence of those.
// Measured as the flux of it coming down onto the surface point: the mean,
// over the AGIT_REACH cells above it, of unsupported liquid's speed (a
// solid jet at speed v gives v; a sparse spray, its volume fraction of v),
// bilinear across the four columns around the point. Over a pool that is
// what lands there; on a stream's side, the stream above.
#define AGIT_REACH 4           // cells above the point
// Air entrainment by a plunging jet starts at ~1 m/s (Ervine et al. 1980;
// Chanson 1997); a jet past ~4 m/s is white with it.
#define FOAM_V_ONSET 1.0       // m/s
#define FOAM_V_FULL 4.0        // m/s
bool supports(int id) { return id != E_EMPTY && KIND[id] != K_GAS; }
float columnFlux(ivec3 c) {   // c = lowest cell; cells/step
  if (c.x < 0 || c.z < 0 || c.x >= NX || c.z >= NZ) return 0.0;
  int below = c.y > 0 ? eid(cellA(c - ivec3(0, 1, 0))) : E_WALL;
  float s = 0.0;
  for (int k = 0; k < AGIT_REACH; k++) {
    if (c.y >= NY) break;
    int id = eid(cellA(c));
    if (liqDetailOn(id) && !supports(below)) s += length(cellB(c).xyz);
    below = id;
    c.y++;
  }
  return s / float(AGIT_REACH);
}
float agitation(vec3 p) {   // 0..1
  ivec3 c = ivec3(floor(p));
  // skip when the bricks above hold no matter at all
  ivec3 b0 = c / BS, b1 = (c + ivec3(0, AGIT_REACH - 1, 0)) / BS;
  if (brickInfo(clamp(b0, ivec3(0), ivec3(BX, BY, BZ) - 1)) == 0 && brickInfo(clamp(b1, ivec3(0), ivec3(BX, BY, BZ) - 1)) == 0) return 0.0;
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
  if (outside(c) || c.y == 0 || eid(cellA(c)) != id || supports(eid(cellA(c - ivec3(0, 1, 0))))) return 0.0;
  float v = length(cellB(c).xyz) * MS_PER_CELL_STEP;
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
// ~0.3 at a few cm (Cox & Munk's slope variance at gale force is ~0.05,
// rms 0.22, and a plunge pool is rougher still).
#define ROUGH_FREQ 1.7         // cycles/cell (≈ 5 cm bumps)
#define ROUGH_SLOPE 0.3        // rms-ish slope at full agitation, per unit noise gradient
#define ROUGH_RATE 3.0         // noise units/s: churn decorrelates in ~1/3 s
// Foam: a bubble raft, patchy (two octaves of noise thresholded to the
// covered fraction), white by multiple scattering: fresh foam reflects ~55%
// of light (Whitlock et al. 1982), scattered nearly diffusely and wrapping
// past the terminator, since light goes in and out of the bubble layer.
#define FOAM_COVER_MAX 0.7     // covered fraction where a jet plunges at full agitation
#define SPRAY_COVER_MAX 0.3    // ... and on falling liquid fully torn up (white streaks, still clear between)
#define FOAM_FREQ 2.3          // cycles/cell (≈ 3.5 cm patches)
#define FOAM_FREQ2 5.1         // second octave, cycles/cell (bubble clusters)
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
  vec4 r = triNoiseD(p, n, ROUGH_FREQ, t * ROUGH_RATE);
  n = tiltNormal(n, r.yzw * (ROUGH_SLOPE * ag * lodFade(ROUGH_FREQ, fp) / ROUGH_FREQ));
  // covered fraction: the pattern where pixels resolve it, its mean beyond
  float cover = max(FOAM_COVER_MAX * agI, SPRAY_COVER_MAX * agB);
  float pw = lodFade(FOAM_FREQ, fp);
  float c = cover;
  if (pw > 0.0) {
    vec3 q = p + FOAM_SHIFT;
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
