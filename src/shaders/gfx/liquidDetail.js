import { ELEMENTS } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { prelude } from '../common.js';
import { slotGLSL } from '../move.js';
import { quietGLSL } from '../activity.js';

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
//   DETAIL_LIQ_FOAM      whitewater: liquid white with entrained air where it
//                        plunged or landed hard, or tore up falling; the foam
//                        rides the flow and bursts over seconds (the
//                        aeration field, aerationFrag, stepped by gfx/foam.js)
//
// Units: everything is sized in metres and converted with CELL_M
// (src/scale.js). Speeds: the sim's time doesn't follow its length scale
// (scale.js), so a speed in cells/step is read through what physically sets
// it, the height fallen: v²/2g_sim cells, i.e. CELL_M times that in metres,
// gives the real speed √(2 g h). That makes one cell/step MS_PER_CELL_STEP.
const G_REAL = 9.81;                   // m/s²
const SIM_GRAVITY = 0.025;             // cells/step² (sim.js GRAVITY_DEFAULT)
const MS_PER_CELL_STEP = Math.sqrt((G_REAL * CELL_M) / SIM_GRAVITY);   // m/s per cell/step (≈ 11)
// Time, by the same token: the physical time one step stands for is the time
// in which the sim's gravity moves things as far as real gravity would,
// √(CELL_M · g_sim / g) ≈ 28 ms. Everything the whitewater does over time
// (foam bursting, bubbles rising, a falling blob tearing up) is counted in
// steps at that rate, i.e. on the simulation's clock, not the wall clock: the
// foam is made by the sim's motion and carried by it, so it ages at the pace
// that motion runs, stops when the world is paused, and drifts as far before
// it bursts as real foam would on water moving that fast. The cost is that
// the world runs ~6.6× real time (scale.js; 240 steps/s at the default 4
// steps per frame), so foam that lingers 2.5 s really lingers ~0.4 s on
// screen; a slower Speed (or a real-time POV clock) shows it at its own pace.
export const STEP_S = Math.sqrt((CELL_M * SIM_GRAVITY) / G_REAL);   // physical s per step

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

// ---- Whitewater (DETAIL_LIQ_FOAM) ----
// Foam at a free surface decays exponentially as its bubbles burst: the
// whitecap decay constant is 3.85 s on seawater and 2.54 s on fresh water
// (Monahan 1971; field values 1.4–4.8 s, Callaghan et al. 2012). Acid is
// aqueous; oils carry no surfactant to hold a foam, so they take fresh water's.
const FOAM_TAU_S = 2.54;          // s
// Once the world is idle nothing moves, but the foam on it still bursts: the
// field keeps stepping until surface foam is down to AER_VISIBLE_MIN (below
// which its covered fraction is under a percent), then whatever is left clears.
const AER_VISIBLE_MIN = 0.01;
// Bubbles under the surface rise out of the bulk at their terminal speed,
// ~0.23 m/s for the 1–5 mm bubbles of whitewater (Clift, Grace & Weber 1978).
const BUBBLE_RISE_MS = 0.23;      // m/s
// Churned water decorrelates its bumps within ~1/3 s.
const ROUGH_RATE_S = 3;           // noise units per physical second
// A falling blob tears up once air drag beats surface tension: Weber number
// We = ρ_air v² D / σ past ~12 (bag breakup), with D a cell (the sim's
// smallest blob). It takes time: the blob is fully torn into spray after
// T·t*, t* = (D / v)·√(ρ_liquid / ρ_air), T from Pilch & Erdman's (1987)
// fit, piecewise in We; until then a blob falling a few metres is still
// mostly glassy.
const AIR_RHO = 1.2;              // kg/m³
const WE_ONSET = 12;
const PE_FIT = [                  // [We below which it applies, coefficient, exponent of (We − 12)]
  [18, 6, -0.25], [45, 2.45, 0.25], [351, 14.1, -0.25], [2670, 0.766, 0.25], [Infinity, 5.5, 0],
];

const g = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(6));
const perLiquid = (fn) => ELEMENTS.map((e) => g(LIQ_PROPS[e.key] ? fn(LIQ_PROPS[e.key]) : 0));

export const liquidDetailGLSL = /* glsl */ `
#if defined(DETAIL_LIQ_RIPPLES) || defined(DETAIL_LIQ_MENISCUS) || defined(DETAIL_LIQ_FOAM)
#define LIQ_DETAIL 1
#endif
#ifdef LIQ_DETAIL
bool liqDetailOn(int id) { return SURFCH[id] == CH_LIQUID && id != E_ICE; }

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
// Whitewater, drawn from the aeration field (aerationFrag below, stepped with
// the simulation by gfx/foam.js): per liquid cell, the share of its surface
// white with entrained air, which rides with the liquid, bursts at the free
// surface and rises out of the bulk. tAer holds (aeration, 1, fall, grounded)
// in liquid cells (y is 2 in a pour's parcel, and air holds wakes: aerationFrag;
// only the liquid cells are read here), laid out like the state, so it is read
// trilinearly by hand (8 taps), and x / y is the aeration averaged over the
// liquid cells around a point only (the air beside a surface doesn't thin
// it), w / y the share of them that rest on the ground (a pool, not liquid
// in the air or riding on falling liquid).
uniform sampler2D tAer;
#define AER_PROBE 0.25         // cells into the liquid (against n) where the aeration is read
#define AER_LIQ_MIN 0.02       // liquid weight below which the read is no liquid's
vec3 aerTap(ivec3 c) {
  vec4 f = outside(c) ? vec4(0.0) : texelFetch(tAer, atlas(c), 0);
  return f.y > 0.5 ? vec3(f.x, 1.0, f.w) : vec3(0.0);
}
vec2 aerationAt(vec3 p) {   // (aeration, grounded share), 0..1

  vec3 q = p - 0.5;
  ivec3 c = ivec3(floor(q));
  vec3 f = q - vec3(c);
  vec3 s = mix(mix(mix(aerTap(c), aerTap(c + ivec3(1, 0, 0)), f.x),
                   mix(aerTap(c + ivec3(0, 1, 0)), aerTap(c + ivec3(1, 1, 0)), f.x), f.y),
               mix(mix(aerTap(c + ivec3(0, 0, 1)), aerTap(c + ivec3(1, 0, 1)), f.x),
                   mix(aerTap(c + ivec3(0, 1, 1)), aerTap(c + ivec3(1, 1, 1)), f.x), f.y), f.z);
  return s.y > AER_LIQ_MIN ? clamp(s.xz / s.y, 0.0, 1.0) : vec2(0.0);
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

// Aerated water is rough: breaking, churning surfaces carry slopes of
// ~0.3 over ~15 cm (Cox & Munk's slope variance at gale force is ~0.05,
// rms 0.22, and a plunge pool is rougher still).
#define ROUGH_LAMBDA_M 0.15    // m, size of the churned bumps
#define ROUGH_FREQ (CELL_M / ROUGH_LAMBDA_M)   // cycles/cell
#define ROUGH_SLOPE 0.3        // rms-ish slope at full aeration, per unit noise gradient
#define ROUGH_EVOLVE ${g(ROUGH_RATE_S * STEP_S)}   // noise units per step: churn decorrelates in ~1/3 s
// Foam: a bubble raft, patchy (two octaves of noise thresholded to the
// covered fraction), white by multiple scattering: fresh foam reflects ~55%
// of light (Whitlock et al. 1982), scattered nearly diffusely and wrapping
// past the terminator, since light goes in and out of the bubble layer. As
// the aeration decays the covered fraction shrinks, so patches thin into the
// lace and streaks of old foam instead of fading as a whole. The pattern
// reshapes as its bubbles burst: one noise unit per foam lifetime.
// Aerated liquid in the air is not a raft but a spray of torn drops and
// sheets: white streaks with clear water between, so it covers less.
#define FOAM_COVER_MAX 0.7     // covered fraction at full aeration on resting liquid (open water still shows between)
#define SPRAY_COVER_MAX 0.3    // ... and on liquid in the air or falling with it
#define FOAM_PATCH_M 0.12      // m, foam patches between open water
#define FOAM_CLUSTER_M 0.04    // m, bubble clusters within them (second octave)
#define FOAM_FREQ (CELL_M / FOAM_PATCH_M)      // cycles/cell
#define FOAM_FREQ2 (CELL_M / FOAM_CLUSTER_M)   // cycles/cell
#define FOAM_OCT2_W 0.4        // its weight (first: 1 − this)
#define FOAM_EVOLVE ${g(STEP_S / FOAM_TAU_S)}   // noise units per step (one per FOAM_TAU_S)
#define FOAM_EDGE 0.08         // threshold softness (noise units)
#define FOAM_ALBEDO 0.55
#define FOAM_WRAP 0.5          // diffuse wrap (0 = Lambert)
#define FOAM_SHIFT 29.3        // lattice offset of the foam noise from the roughness noise
void liquidFoam(vec3 p, inout vec3 n, int id, inout vec3 col, inout vec3 trans) {
  vec2 aer = aerationAt(p - n * AER_PROBE);
  float ag = aer.x;
  if (ag <= 0.0) return;
  float fp = footprint(p);
  vec3 wp = worldPos(p);   // the churn and foam are anchored in the world
  vec4 r = triNoiseD(wp, n, ROUGH_FREQ, uSimClock * ROUGH_EVOLVE);
  n = tiltNormal(n, r.yzw * (ROUGH_SLOPE * ag * lodFade(ROUGH_FREQ, fp) / ROUGH_FREQ));
  // covered fraction: the pattern where pixels resolve it, its mean beyond
  float cover = mix(SPRAY_COVER_MAX, FOAM_COVER_MAX, aer.y) * ag;
  float pw = lodFade(FOAM_FREQ, fp);
  float c = cover;
  if (pw > 0.0) {
    vec3 q = wp + FOAM_SHIFT;
    float t = uSimClock * FOAM_EVOLVE;
    float v = mix(triNoiseD(q, n, FOAM_FREQ, t).x, triNoiseD(q, n, FOAM_FREQ2, t).x,
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

// ---- The aeration field (whitewater's state; gfx/foam.js runs it) ----
// Per liquid cell, the share of its surface white with entrained air (0..1).
// It advances once per simulation step, right after the move, from the
// move's own bookkeeping: each cell takes the aeration of the cell its
// content came from (the slot the gather read), so foam rides with the liquid
// exactly as the sim moves it, drifting with the flow and falling with a
// blob. Then, by where that liquid is:
//   bulk (liquid above it)    bubbles rise out at BUBBLE_RISE_MS: a share
//                             AER_RISE of its aeration moves up a cell a step
//   free surface              bubbles burst: × AER_KEEP a step (FOAM_TAU_S)
//   airborne (nothing         a falling blob tears up: its aeration grows by
//   under it)                 the share of its breakup time (Pilch & Erdman,
//                             above) a step is
// and liquid that lands is white at once where it hit hard enough to entrain
// air: the speed it came down at against a plunging jet's entrainment onset.
// That speed is the fall the cell really made: each cell carries the speed
// it last fell at (the field's z, cells/step), set while it is in free fall
// or moves down a cell, kept while it rides on liquid that is itself falling
// (a blob's upper part; drops meeting in the air merge rather than trap air),
// and spent on the first step it rests on grounded matter: the ground, or
// liquid resting on it (the field's w, passed up a pool a cell per step).
// Velocity alone won't do: a pool's cells can't move into each other, yet
// gravity keeps adding to their speed until the automaton cancels it (after
// a load the whole sea "falls" in place), and its sideways speeds are the
// spreading rule (a resting pool's cells hold FLOW sideways and bounce it off
// walls), not motion that aerates. Only vertical motion counts; the sim's
// falls are gravity's, so their speeds are real (MS_PER_CELL_STEP).
// Air entrainment by a plunging jet starts at ~1 m/s (Ervine et al. 1980;
// Chanson 1997); a jet past ~4 m/s is white with it.
const FOAM_V_ONSET = 1.0;         // m/s
// Pours: a wake lasts TRAIL_JOIN_STEPS steps, and is drawn where a parcel is
// coming up behind it within JOIN_REACH cells (pours, below). The parcels of
// tools/jet-check.mjs's pour come 2-4 cells apart at ~0.8 cells/step, so the
// next one reaches a wake within ~5 steps and 4 cells. (Twice that joined
// little more of the pour and twice as much spray: tools/pour-field-probe.mjs.)
export const TRAIL_JOIN_STEPS = 6;
export const JOIN_REACH = 4;
const JOIN_COS = 0.9;   // cos 25°: the most a pour's next parcel turns from the last one's way
const FOAM_V_FULL = 4.0;          // m/s
// Output: (aeration, 1, fall speed, grounded) in liquid cells, 0 elsewhere,
// so the renderer can average the aeration over liquid cells only
// (aerationAt).
//
// Pours (shaders/fields.js jetAt). The sim pours a stream as parcels a few
// cells apart along one path (2-4 cells on tools/jet-check.mjs's hole: the
// block automaton moves a stream a cell a step only every other cell), so
// drawn as they are a pour is a dotted line of glass beads. So the field also
// keeps the wake a parcel off the ground leaves in the air it just left, for
// TRAIL_JOIN_STEPS steps: (way it went, as x, z, w, a unit vector if the
// parcel was a pour's and half that if not; −record in y, 1 fading to 0). The
// field passes draw a wake as water only where a pour's parcel left it and
// another is coming up behind it, along the way it went, within JOIN_REACH
// cells: between the parcels of a pour, which then read as one rope of water
// (three parcels on one path at least, which spray seldom makes). A parcel of a
// pour (y is 2) is liquid off the ground, touching no other liquid (a blob's
// cells touch), that has just moved into a wake (or beside one: the path
// wanders a cell) going the way that wake's maker went (within JOIN_COS: on
// one path two parcels a few cells apart differ only by its curvature,
// ~0.1 rad, where spray flies every way), and stays one while it flies on
// alone; the field passes draw it at once, without the blend that smears a
// moving cell (a rope, not beads). The wake behind a pour's last parcel, a
// falling blob or spray has no such parcel behind it, so those look as they
// always did, without tails.

const AER_FOAMS = Object.keys(LIQ_PROPS).map((k) => `id == E_${k}`).join(' || ');
const peFit = PE_FIT.map(([lim, c, e]) => `${lim === Infinity ? '' : `if (we < ${g(lim)}) `}return ${g(c)} * pow(x, ${g(e)});`).join('\n  ');
export const aerationFrag = (grid) => /* glsl */ `
${prelude(grid)}
uniform sampler2D tAerPrev;   // the aeration before this step (tA, tB: the state before its move)
uniform bool uStill;          // a step with no move (the world is idle): every cell stays put
out vec4 oF;
${quietGLSL}
${slotGLSL}
vec4 aerPrev(ivec3 c) { return texelFetch(tAerPrev, atlas(c), 0); }
#define MS_PER_CELL_STEP ${g(MS_PER_CELL_STEP)}   // m/s per cell/step
#define STEP_S ${g(STEP_S)}             // physical s per step
#define AER_KEEP ${g(Math.exp(-STEP_S / FOAM_TAU_S))}           // per step at a free surface
#define AER_RISE ${g((BUBBLE_RISE_MS * STEP_S) / CELL_M)}          // share rising a cell per step
#define FOAM_V_ONSET ${g(FOAM_V_ONSET)}   // m/s
#define FOAM_V_FULL ${g(FOAM_V_FULL)}     // m/s
#define AIR_RHO ${g(AIR_RHO)}          // kg/m³
#define WE_ONSET ${g(WE_ONSET)}
const float AER_SIGMA[NE] = float[NE](${perLiquid((p) => p.sigma).join(', ')});   // surface tension, N/m
const float AER_RHO[NE] = float[NE](${perLiquid((p) => p.rho).join(', ')});       // density, kg/m³
#define TRAIL_FADE ${g(1 / TRAIL_JOIN_STEPS)}   // a wake record's fade per step
bool supports(int id) { return id != E_EMPTY && KIND[id] != K_GAS; }
bool foams(int id) { return ${AER_FOAMS}; }
// Air (or gas) at p, its content now from q: a wake if liquid off the ground
// just left it, else what wake it had, faded (pours, above).
vec4 wakeAt(ivec3 p, ivec3 q, int id) {
  if (supports(id)) return vec4(0.0);   // (filled with something)
  vec4 f = aerPrev(p);
  if (f.y > 0.5) {
    vec3 v = fetchB(p).xyz;   // the parcel's velocity before it left
    if (q == p || f.w > 0.5 || dot(v, v) == 0.0) return vec4(0.0);   // (it was on the ground)
    v = normalize(v) * (f.y > 1.5 ? 1.0 : 0.5);
    return vec4(v.x, -1.0, v.y, v.z);
  }
  float rec = -f.y - TRAIL_FADE;
  return f.y < 0.0 && rec > 0.0 ? vec4(f.x, -rec, f.z, f.w) : vec4(0.0);
}
#define JOIN_COS ${g(JOIN_COS)}
// a wake at c whose maker went the way dir does
bool wake(ivec3 c, vec3 dir) { if (!inGrid(c)) return false; vec4 f = aerPrev(c); return f.y < 0.0 && dot(normalize(f.xzw), dir) > JOIN_COS; }
bool wet(ivec3 c) { return inGrid(c) && foams(eid(fetchA(c))); }
// Pilch & Erdman's total breakup time, in units of t* (We > WE_ONSET)
float breakupT(float we) {
  float x = we - WE_ONSET;
  ${peFit}
}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oF = vec4(0.0); return; }   // a texel holding no cell
  // where its content comes from, as the gather took it: a block based in a
  // quiet brick (or every block, on an idle step) stayed put. Quiet bricks
  // can hold a resting pool, whose foam must still burst, so they run too.
  ivec3 q = p;
  if (!uStill && !quietCell(blockBase(p))) { slotOf(p, q); q = edgeCell(q); }   // (past a loop edge: the far side's)
  if (!inGrid(q)) { oF = vec4(0.0); return; }   // (in from past a void edge: still air)
  int id = eid(fetchA(q));
  if (!foams(id)) { oF = wakeAt(p, q, id); return; }
  const ivec3 UP = ivec3(0, 1, 0);
  vec4 f0 = aerPrev(q);
  float F = f0.x, fall = f0.z;
  int below = q.y > 0 ? eid(fetchA(q - UP)) : E_WALL;
  int above = q.y < NY - 1 ? eid(fetchA(q + UP)) : E_EMPTY;
  vec4 fb = q.y > 0 ? aerPrev(q - UP) : vec4(0.0);   // the field under it
  bool airborne = !supports(below);
  // grounded: resting on the ground through whatever liquid is under it (a
  // pool) rather than on liquid that is itself falling. Propagates up a
  // liquid column a cell per step.
  bool grounded = !airborne && (foams(below) ? fb.w > 0.5 : true);
  float vy = fetchB(q).y;   // cells/step, before the move
  // liquid new here (poured, melted, condensed since the last step): clear,
  // and falling as fast as it was made to
  if (f0.y < 0.5) { F = 0.0; fall = max(-vy, 0.0); }
  if (foams(above)) F -= AER_RISE * F;
  else if (!airborne) F *= AER_KEEP;
  if (foams(below)) F += AER_RISE * fb.x;
  if (airborne) {
    float v = abs(vy) * MS_PER_CELL_STEP;
    float we = AIR_RHO * v * v * CELL_M / AER_SIGMA[id];
    if (we > WE_ONSET) F += STEP_S * v / (breakupT(we) * CELL_M * sqrt(AER_RHO[id] / AIR_RHO));
  }
  // In free fall, or fell a cell: at this speed. Resting on falling liquid it
  // rides along with what it has (a blob's upper part; drops meeting in the
  // air merge rather than trap air). Resting on grounded matter it has
  // landed: it hit at its fall.
  if (airborne || (q.y > p.y && q.x == p.x && q.z == p.z)) fall = max(-vy, 0.0);
  else if (grounded) {
    F = max(F, smoothstep(FOAM_V_ONSET, FOAM_V_FULL, fall * MS_PER_CELL_STEP));
    fall = 0.0;
  }
  // a pour's parcel (pours, above): alone off the ground, it followed one
  // (moved into a wake going its way, or beside one), or did before
  bool alone = airborne && !foams(above) && !wet(q + ivec3(1, 0, 0)) && !wet(q - ivec3(1, 0, 0))
    && !wet(q + ivec3(0, 0, 1)) && !wet(q - ivec3(0, 0, 1));
  vec3 dir = dot(fetchB(q).xyz, fetchB(q).xyz) > 0.0 ? normalize(fetchB(q).xyz) : vec3(0.0);
  bool pour = alone && f0.y > 0.5 && (f0.y > 1.5 || (q != p && (wake(p, dir) || wake(p + ivec3(1, 0, 0), dir)
    || wake(p - ivec3(1, 0, 0), dir) || wake(p + ivec3(0, 0, 1), dir) || wake(p - ivec3(0, 0, 1), dir))));
  oF = vec4(min(F, 1.0), pour ? 2.0 : 1.0, fall, grounded ? 1.0 : 0.0);
}
`;

// Steps an idle world's foam takes to burst to AER_VISIBLE_MIN (gfx/foam.js idle).
export const AER_IDLE_STEPS = Math.ceil((Math.log(1 / AER_VISIBLE_MIN) * FOAM_TAU_S) / STEP_S);
