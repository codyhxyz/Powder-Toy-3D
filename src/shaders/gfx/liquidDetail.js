import { CELL_M } from '../../scale.js';
import { prelude, STATE_OPTS, LAYOUT, STAGE, stateLayout, readFormatWGSL } from '../common.js';
import { ARGS } from '../activity.js';
import { simModesGLSL, SIM_MODE_FIELDS } from '../../simModes.js';
import { uniformStruct } from '../../gpu/params.js';
import { fold, MAX_WORKGROUPS } from '../../gpu/kernels.js';
import { glf } from '../../glsl.js';
import { VNOISE_GRAD_VAR } from './liquid.js';

// Close-up liquid detail (gfx/detail.js switches): what a liquid surface shows
// once a pixel is a few millimetres across. Each part compiles in only with
// its switch, and all of it is a function of the sim state (which liquid,
// where the crisp walls are, how fast unsupported liquid is moving) plus the
// clock the existing ripple model already runs on.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2), pasted after
// surfaceGLSL and liquidGLSL. Each part is a JS template switch (F2): detail
// is the defines object of gfx/detail.js. liquidDetail() always exists (it
// returns n unchanged with every switch off), so the tracer may call it
// unconditionally; LIQ_DETAIL(detail) says whether anything is compiled in.
//   DETAIL_LIQ_RIPPLES   gravity-capillary ripples: the wind-ripple spectrum
//                        (gfx/liquid.js) continued down to sub-cm wavelengths,
//                        each octave fading in only once pixels resolve it
//   DETAIL_LIQ_MENISCUS  the surface climbing walls and glass over its
//                        capillary length (a few mm), box-filtered per pixel
//                        and faded out by the footprint (a few metres away)
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

// The foam raft's threshold (liquidFoam): the spread of the noise it is cut
// from, and the normal quantile that cuts it. One octave of mNoiseD's value
// is a trilinear blend of uniform hashes (variance 1/12) with smoothstep
// weights s, so its variance is (1/12)·E[s² + (1 − s)²]³, E = 26/35 over a
// cell (∫s² = 13/35): σ ≈ 0.185 (200k samples of the WGSL noise: 0.184).
// Its quantiles are within 0.01 of a normal's, so a cover's threshold is
// σ·Φ⁻¹(1 − cover), Φ⁻¹ by the logistic approximation Φ(x) ≈ 1/(1 + e^(−1.702x))
// (Haley 1952; error < 0.01): the raft then covers what the far pixels show
// as its mean (Dupuy & Bruneton 2012, "Real-time animation and rendering of
// ocean whitecaps": coverage = ½ + ½·erf(threshold / √2σ)).
const FOAM_NOISE_SD = Math.sqrt((26 / 35) ** 3 / 12);
const PROBIT_LOGISTIC = 1.702;

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
// exact result for a flat vertical wall (Landau & Lifshitz §61; de Gennes,
// Brochard-Wyart & Quéré, Capillarity and Wetting Phenomena §1.3), a rise for
// θ < 90° and a dip for θ > 90° (mercury on glass, 140°).
const capLen = (p) => Math.sqrt(p.sigma / (p.rho * G_REAL));
const menH0 = (p) => Math.sign(Math.cos((p.theta * Math.PI) / 180))
  * capLen(p) * Math.sqrt(2 * (1 - Math.sin((p.theta * Math.PI) / 180)));
// The meniscus draws on more liquids than the foam models (LIQ_PROPS, which
// the aeration pass and FOAMS share): every liquid of the liquid channel
// whose real counterpart's σ, ρ and wetting are measured. The rest (Nitro,
// Toxic, Slime, the potions) are made up, so they keep a flat edge.
const MENISCUS_PROPS = {
  ...LIQ_PROPS,
  // Seawater, S = 35 g/kg at 20 °C: σ = σ_water·(1 + 3.766e-4·S + 2.347e-6·S·t)
  // (Nayar, Panchanathan, McKinley & Lienhard 2014, J. Phys. Chem. Ref. Data
  // 43, 043103); ρ 1025 kg/m³; wets like fresh water.
  SALTWATER: { sigma: 0.0738, rho: 1025, theta: 20 },
  // At 77 K: σ 8.9–9.05 mN/m (Jasper 1972; double capillary, Chin. J. Chem.
  // Phys. 13, 378), ρ 807 kg/m³ (NIST WebBook); cryogens wet every cold solid.
  LIQUID_NITROGEN: { sigma: 0.009, rho: 807, theta: 0 },
  // 40 % ABV (34 % ethanol by mass): σ ≈ 31 mN/m, between 33 (30 wt%) and
  // 30.2 (40 wt%) (Vázquez, Alvarez & Navaza 1995, J. Chem. Eng. Data 40,
  // 611); ρ 948 kg/m³; ethanol solutions wet glass nearly fully, as oils do.
  WHISKEY: { sigma: 0.031, rho: 948, theta: 10 },
  // Whole blood: σ(t) = (70.105 − 0.473 t) mN/m, 59.7 at 22 °C (Rosina et al.
  // 2007, Physiol. Res. 56 S93); ρ 1060 kg/m³; aqueous, so water's angle.
  BLOOD: { sigma: 0.0597, rho: 1060, theta: 20 },
};

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
// The longest octave, m: past a footprint of DETAIL_FADE_HI of it (gfx/detail.js) no octave is drawn as a normal.
export const CAP_LAMBDA_MAX_M = CAP_LAMBDAS[0];
// Specular anti-aliasing (the geometry -> normal -> BRDF hand-off of Bruneton,
// Neyret & Holzschuch 2010): an octave lodFade draws at weight w shows w² of its
// slope variance as normals; the rest, (1 − w²), is slope variance inside the
// pixel, so it widens the sun's and lamps' GGX lobe instead of vanishing (LEAN
// mapping, Olano & Baker 2010: second moments add under filtering; GGX
// α² += 2σ², Tokuyoshi & Kaplanyan 2019, Unity HDRP's normal filtering). Far
// away the octaves are then a constant roughness, not a mirror or sparkles.
// Per octave the slope is RIPPLE_SLOPE times value noise's gradient (mNoiseD):
// mean square slope 2·VNOISE_GRAD_VAR·RIPPLE_SLOPE² (gfx/liquid.js), GGX α² per octave.

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

const g = (x) => glf(Number.isInteger(x) ? x : +x.toPrecision(6));
// A per-liquid value as a function of the element id (0 for the rest): three
// liquids, so a comparison chain rather than an NE-entry table (docs/webgpu.md C6).
const perLiquidFn = (name, fn) => `fn ${name}(id: i32) -> f32 {
${Object.keys(LIQ_PROPS).map((k) => `  if (id == E_${k}) { return ${g(fn(LIQ_PROPS[k]))}; }`).join('\n')}
  return 0.0;
}`;
const wgslArray = (xs) => `array<f32, ${xs.length}>(${xs.map(g).join(', ')})`;

// ---- Meniscus (DETAIL_LIQ_MENISCUS) ----
// The linearised profile h(x) = h0·exp(−x/lc) is, as a feature, a low-pass
// whose spectrum turns over at 1/(2π·lc): its wavelength λm = 2π·lc (1.7 cm
// for water, the capillary crossover λc the ripples' last octave stops at).
// By the material LOD rule (gfx/detail.js DETAIL_FADE_LO/HI, lodFade) it is
// drawn whole while a pixel spans up to half of λm and gone once it spans
// all of it. Within that the pixel box filter below is exact, so it never
// aliases; past it what is left is a one-pixel rim whose tilt h0/fp is under
// h0/λm (0.18 for water) and falling, at the cost of a neighbour lookup on
// every pixel that straddles a cell face, most of which find no wall.
export const meniscusLambdaM = (p) => 2 * Math.PI * capLen(p);   // m
// The widest liquid's λm, which gfx/detail.js's fadeM mirrors.
export const MENISCUS_LAMBDA_MAX_M = Math.max(...Object.values(MENISCUS_PROPS).map(meniscusLambdaM));
// A wall face is looked up only while the pixel's near edge is within
// MEN_REACH capillary lengths of it: past that the rise is under MEN_TAIL of
// h0, and its slope (h0/lc·MEN_TAIL ≤ 0.005) under an 8-bit normal map's
// step (2/255), the precision every game's normal maps have.
const MEN_TAIL = 1 / 256;
const MEN_REACH = -Math.log(MEN_TAIL);   // capillary lengths (5.5)
// (h0 cells, lc cells, 1/λm cycles per cell) of each liquid that has one, as
// one comparison chain (perLiquidFn's, three numbers at once).
const meniscusFn = () => `fn MEN(id: i32) -> vec3f {
${Object.entries(MENISCUS_PROPS).map(([k, p]) => `  if (id == E_${k}) { return vec3f(${[menH0(p) / CELL_M, capLen(p) / CELL_M, CELL_M / meniscusLambdaM(p)].map(g).join(', ')}); }`).join('\n')}
  return vec3f(0.0);
}`;

/** The detail key a WORLD program carries while Physics V2 runs its window (app.js
 * worldDetail): its atlas then holds V2's foam (world/renderSource.js, the V2
 * aux export), so it compiles the foam as a Box program always does, Whitewater
 * switch on or off (docs/v2.md §4.3). V1 World programs never carry it. */
export const NATIVE_FOAM = 'NATIVE_FOAM';
/** Box programs always compile native compact foam (legacy detail switches still gate their effects).
 * WORLD reads no V2 state, so its switches decide what is compiled in, and under
 * V2 its NATIVE_FOAM key adds the foam. Not a deviation: the two draw the same
 * foam by different code. Under V1 World reads the same aeration, copied into its
 * atlas; under V2 the Box reads V2's foam byte from V2's cells and World reads the
 * same byte from its atlas, which the V2 aux export fills. */
export const LIQ_DETAIL = (detail = {}, backend = 'box') => backend !== 'world'
  || !!(detail.DETAIL_LIQ_RIPPLES || detail.DETAIL_LIQ_MENISCUS || detail.DETAIL_LIQ_FOAM || detail[NATIVE_FOAM]);

export const liquidDetailGLSL = (detail = {}, { backend = 'box', fixedReadFormat } = {}) => {
  // WORLD reads its own atlas, never V2's packed state: its format is the legacy one.
  const format = backend === 'world' ? '0u' : readFormatWGSL(fixedReadFormat);
  const ripples = !!detail.DETAIL_LIQ_RIPPLES;
  const meniscus = !!detail.DETAIL_LIQ_MENISCUS;
  const world = backend === 'world';
  // Intentional (V2 design, docs/v2.md §4.3 and §13.4): V2's foam is always on and every liquid
  // foams; V1's Whitewater foam stays behind its detail switch (the format test in liquidDetail
  // below; in World, NATIVE_FOAM).
  const foam = !world || !!detail.DETAIL_LIQ_FOAM || !!detail[NATIVE_FOAM]; // native §4.3 foam is independent of the legacy Whitewater switch
  return /* wgsl */ `
// Which copy of the aeration buffer (binding 19: both copies, docs/webgpu.md
// G4) is the current one, 0 or 1. The aeration's ping-pong isn't the state's,
// so the header's src can't say: the entry point sets it from its params, as
// it sets gFragCoord (docs/webgpu.md B6: a param chooses the copy).
var<private> gAerCopy: u32 = 0u;
${LIQ_DETAIL(detail, backend) ? `
fn liqDetailOn(id: i32) -> bool { return SURFCH(id) == CH_LIQUID && id != E_ICE; }

// Tilt outward normal n by a height field's world gradient gr (slope units):
// only its part along the surface counts.
fn tiltNormal(n: vec3f, gr: vec3f) -> vec3f { return normalize(n - (gr - n * dot(gr, n))); }` : ''}
${ripples ? `
// Gravity-capillary ripples: CAP_OCTAVES octaves past the wind ripples, on the same
// upward-facing surfaces (RIPPLE_UP_*), each its own value-noise height field
// in (x, z, time). Equal slope per octave (the saturation range of wind-wave
// spectra: slope variance flat per octave), the same slope as the wind
// ripples'. Octaves fade in by the pixel footprint (lodFade); in the box the
// variance of what is faded is the glint's roughness instead (the JS above),
// so far away they widen the sun's lobe rather than vanish. (Five
// entries each: private arrays, docs/webgpu.md C6.)
const CAP_OCTAVES: i32 = ${CAP_OCTAVES};
var<private> CAP_FREQ: array<f32, CAP_OCTAVES> = ${wgslArray(CAP_FREQS)};    // cycles/cell (λ ${CAP_LAMBDAS.map((l) => (l * 100).toFixed(1)).join(', ')} cm)
var<private> CAP_DRIFT: array<f32, CAP_OCTAVES> = ${wgslArray(CAP_DRIFTS)};  // noise units/s, by dispersion
const CAP_SHIFT: f32 = 13.7;   // lattice offset per octave (noise units), so octaves don't line up
// mean square slope (x and z) of one octave at full strength: GGX α² (above)
const CAP_OCT_MS: f32 = 2.0 * ${g(VNOISE_GRAD_VAR)} * RIPPLE_SLOPE * RIPPLE_SLOPE;
fn liquidCapillary(p: vec3f, n: vec3f) -> vec3f {
  let up = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y);
  var gr = vec2f(0.0);       // (x, z)
  var lost = 0.0;            // octaves' worth of slope variance not drawn as normals
  if (up > 0.0) {
    let fp = footprint(p);
    let wq = worldPos(p).xz;   // anchored in the world, like the wind ripples
    lost = f32(CAP_OCTAVES);
    for (var i = 0; i < CAP_OCTAVES; i++) {
      let w = lodFade(CAP_FREQ[i], fp);
      if (w <= 0.0) { break; }
      // d/d(noise xz) is the slope per unit noise gradient, as RIPPLE_SLOPE
      let h = mNoiseD(vec3f(wq * CAP_FREQ[i] + CAP_SHIFT * f32(i + 1), FU.time * CAP_DRIFT[i]));
      gr += h.yz * w;
      lost -= w * w;
    }
  }
  // the rest is roughness at this point, on top of the wind ripples' (liquid.js liquidInterface reads it)
  gLiqSlopeMS = select(0.0, gLiqSlopeMS, all(gLiqSlopeAt == p)) + lost * CAP_OCT_MS * up * up;
  gLiqSlopeAt = p;
  return tiltNormal(n, vec3f(gr.x, 0.0, gr.y) * RIPPLE_SLOPE * up);
}` : ''}
${meniscus ? `
// Meniscus: next to a crisp wall the surface climbs h(d) = h0·exp(−d/lc)
// (linearised Young–Laplace; d = distance to the wall). Its slope, averaged
// over the pixel's footprint [d − fp/2, d + fp/2] (exactly: the height
// difference across it over its width), tilts the normal away from the wall:
// a thin bright or dark line where water meets glass. It fades by the
// footprint (lodFade at 1/λm, MENISCUS_LAMBDA_MAX_M above), so past a few
// metres nothing is looked up.
// Only the nearer face on each axis can be in reach (reach < half a cell
// wherever the fade lets it draw), and only faces in reach are looked up,
// nearer first, in a loop of 0-2 rounds: one wall lookup in the code (Metal
// inlines it once, where four unrolled rounds made four), none on the open
// surface or a distant pixel, and one exit.
${meniscusFn()}
const MEN_PROBE: f32 = 0.25;   // cells into the liquid (against n) where the wall cells are looked up
const MEN_REACH: f32 = ${g(MEN_REACH)};   // capillary lengths past the pixel's edge a wall is looked up within
fn liquidMeniscus(p: vec3f, n: vec3f, id: i32) -> vec3f {
  let m = MEN(id);   // (h0, lc, 1/λm); lc = 0: a liquid without the model
  let fp = footprint(p);
  let half_ = 0.5 * fp;
  let w = lodFade(m.z, fp);
  let c = vec3i(floor(p - n * MEN_PROBE));
  let f = p.xz - vec2f(c.xz);
  let hiSide = f >= vec2f(0.5);          // the nearer face is the cell's high one (x, z)
  let d = select(f, 1.0 - f, hiSide);    // cells to it
  let reach = half_ + MEN_REACH * m.y;
  let first = select(0, 1, d.y < d.x);   // the nearer of the two: 0 x, 1 z
  let on = m.y > 0.0 && n.y >= RIPPLE_UP_LO && w > 0.0;
  let rounds = select(0, select(1, 2, max(d.x, d.y) < reach), on && min(d.x, d.y) < reach);
  var gr = vec2f(0.0);   // height gradient, xz
  for (var k = 0; k < rounds; k++) {
    let a = first ^ k;
    let s = select(-1.0, 1.0, hiSide[a]);   // side the wall is on
    var q = c;
    q[a * 2] += i32(s);
    if (!outside(q) && isCrisp(eid(fetchA(q)))) {
      let lo = max(d[a] - half_, 0.0);   // the footprint's part over the liquid
      let hi = d[a] + half_;
      // the surface rises toward the wall
      gr[a] += s * m.x * (exp(-lo / m.y) - exp(-hi / m.y)) / max(hi - lo, 1e-6);
    }
  }
  return tiltNormal(n, vec3f(gr.x, 0.0, gr.y) * w);
}` : ''}
${foam ? `
// Whitewater, drawn from the aeration field (the aeration pass, stepped with
// the simulation by gfx/foam.js): per liquid cell, the share of its surface
// white with entrained air, which rides with the liquid, bursts at the free
// surface and rises out of the bulk. The aeration buffer (lighting group
// binding 19, both copies, gAerCopy the current one) holds per slot
// (aeration, 1, fall, grounded) in liquid cells (y is 2 in a pour's parcel,
// and air holds wakes: the aeration model, below; only the liquid cells are
// read here), as f16 (pack2x16float: x, y in the first word, z, w in the
// second). It is read trilinearly by hand (8 taps), and x / y is the
// aeration averaged over the liquid cells around a point only (the air
// beside a surface doesn't thin it), w / y the share of them that rest on
// the ground (a pool, not liquid in the air or riding on falling liquid).
const AER_PROBE: f32 = 0.25;         // cells into the liquid (against n) where the aeration is read
const AER_LIQ_MIN: f32 = 0.02;       // liquid weight below which the read is no liquid's
fn aerTap(c: vec3i) -> vec3f {
  if (outside(c)) { return vec3f(0.0); }
  ${backend === 'world' ? 'let f = worldAeration(c);' : `if (${format} == 2u || ${format} == 3u) {
    return fetchNativeAeration(c);
  }
  let w = aeration[gAerCopy * SLOTS + slotOf(c)];
  let f = vec4f(unpack2x16float(w.x), unpack2x16float(w.y));`}
  return select(vec3f(0.0), vec3f(f.x, 1.0, f.w), f.y > 0.5);
}
fn aerationAt(p: vec3f) -> vec2f {   // (aeration, grounded share), 0..1
  let q = p - 0.5;
  let c = vec3i(floor(q));
  let f = q - vec3f(c);
  let s = mix(mix(mix(aerTap(c), aerTap(c + vec3i(1, 0, 0)), f.x),
                  mix(aerTap(c + vec3i(0, 1, 0)), aerTap(c + vec3i(1, 1, 0)), f.x), f.y),
              mix(mix(aerTap(c + vec3i(0, 0, 1)), aerTap(c + vec3i(1, 0, 1)), f.x),
                  mix(aerTap(c + vec3i(0, 1, 1)), aerTap(c + vec3i(1, 1, 1)), f.x), f.y), f.z);
  if (s.y > AER_LIQ_MIN) { return clamp(s.xz / s.y, vec2f(0.0), vec2f(1.0)); }
  return vec2f(0.0);
}

// Noise in the plane the surface faces most (x, y or z), evolving in time:
// (value, world gradient). Planes blend by |n|^4 (triplanar); planes under
// TRI_MIN weight are skipped, so a pool reads one.
const TRI_POW: f32 = 4.0;
const TRI_MIN: f32 = 0.05;
fn triNoiseD(p: vec3f, n: vec3f, f: f32, t: f32) -> vec4f {
  var w = pow(abs(n), vec3f(TRI_POW));
  w /= w.x + w.y + w.z;
  var r = vec4f(0.0);
  if (w.x > TRI_MIN) { let h = mNoiseD(vec3f(p.yz * f, t)); r += w.x * vec4f(h.x, 0.0, h.yz * f); }
  if (w.y > TRI_MIN) { let h = mNoiseD(vec3f(p.xz * f, t)); r += w.y * vec4f(h.x, h.y * f, 0.0, h.z * f); }
  if (w.z > TRI_MIN) { let h = mNoiseD(vec3f(p.xy * f, t)); r += w.z * vec4f(h.x, h.yz * f, 0.0); }
  return r / max(w.x * step(TRI_MIN, w.x) + w.y * step(TRI_MIN, w.y) + w.z * step(TRI_MIN, w.z), 1e-6);
}
// Where triNoiseD blends planes it averages independent noises, which
// narrows their spread (by 1/√2 on a 45° face). This factor widens it back,
// Σw / √(Σw²) over the planes it read (variance-preserving blending: Heitz &
// Neyret 2018, "High-Performance By-Example Noise using a Histogram-Preserving
// Blending Operator"), so the foam threshold keeps its coverage on any face.
fn triSpread(n: vec3f) -> f32 {
  var w = pow(abs(n), vec3f(TRI_POW));
  w *= step(vec3f(TRI_MIN * (w.x + w.y + w.z)), w);
  return (w.x + w.y + w.z) / max(length(w), 1e-6);
}

// Aerated water is rough: breaking, churning surfaces carry slopes of
// ~0.3 over ~15 cm (Cox & Munk's slope variance at gale force is ~0.05,
// rms 0.22, and a plunge pool is rougher still).
const ROUGH_LAMBDA_M: f32 = 0.15;    // m, size of the churned bumps
const ROUGH_FREQ: f32 = CELL_M / ROUGH_LAMBDA_M;   // cycles/cell
const ROUGH_SLOPE: f32 = 0.3;        // rms-ish slope at full aeration, per unit noise gradient
const ROUGH_EVOLVE: f32 = ${g(ROUGH_RATE_S * STEP_S)};   // noise units per step: churn decorrelates in ~1/3 s
// Foam: a bubble raft, patchy (two octaves of noise thresholded at the
// quantile that leaves the covered fraction white: FOAM_NOISE_SD, above, so
// near and far pixels show the same amount of it), white by multiple scattering: fresh foam reflects ~55%
// of light (Whitlock et al. 1982), scattered nearly diffusely and wrapping
// past the terminator, since light goes in and out of the bubble layer. As
// the aeration decays the covered fraction shrinks, so patches thin into the
// lace and streaks of old foam instead of fading as a whole. The pattern
// reshapes as its bubbles burst: one noise unit per foam lifetime.
// Aerated liquid in the air is not a raft but a spray of torn drops and
// sheets: white streaks with clear water between, so it covers less.
const FOAM_COVER_MAX: f32 = 0.7;     // covered fraction at full aeration on resting liquid (open water still shows between)
const SPRAY_COVER_MAX: f32 = 0.3;    // ... and on liquid in the air or falling with it
const FOAM_PATCH_M: f32 = 0.12;      // m, foam patches between open water
const FOAM_CLUSTER_M: f32 = 0.04;    // m, bubble clusters within them (second octave)
const FOAM_FREQ: f32 = CELL_M / FOAM_PATCH_M;      // cycles/cell
const FOAM_FREQ2: f32 = CELL_M / FOAM_CLUSTER_M;   // cycles/cell
const FOAM_OCT2_W: f32 = 0.4;        // its weight (first: 1 − this)
const FOAM_EVOLVE: f32 = ${g(STEP_S / FOAM_TAU_S)};   // noise units per step (one per FOAM_TAU_S)
const FOAM_EDGE: f32 = 0.08;         // threshold softness (noise units)
const FOAM_NOISE_SD: f32 = ${g(FOAM_NOISE_SD)};   // one octave's spread (noise units)
const FOAM_PROBIT_K: f32 = ${g(1 / PROBIT_LOGISTIC)};   // Φ⁻¹(p) ≈ ln(p / (1 − p)) / 1.702
// A cover below this is under a ten-thousandth of the surface (invisible); it
// keeps Φ⁻¹(1 − cover) finite.
const FOAM_COVER_EPS: f32 = 1e-4;
const FOAM_ALBEDO: f32 = 0.55;
const FOAM_WRAP: f32 = 0.5;          // diffuse wrap (0 = Lambert)
const FOAM_SHIFT: f32 = 29.3;        // lattice offset of the foam noise from the roughness noise
fn liquidFoam(p: vec3f, n: ptr<function, vec3f>, id: i32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let aer = aerationAt(p - *n * AER_PROBE);
  let ag = aer.x;
  if (ag <= 0.0) { return; }
  let fp = footprint(p);
  let wp = worldPos(p);   // the churn and foam are anchored in the world
  // Each noise's weight is its lodFade: the churn's is 0 past ~106 m, the
  // clusters' past ~28 m, the raft's past ~84 m at 1080p and 75° (gfx/
  // detail.js, liquidFoam). The churn and the clusters are evaluated
  // straight-line, as before, not behind tests of their weight: foam is
  // only drawn within the live physics window, so skipping them past those
  // distances saves little, and the branches would add control flow to every
  // inlined copy of the World's cold-built shader (2026-10-17: Metal timings
  // on a loaded machine could not tell the two apart, so the cheaper-to-
  // compile shape stays).
  let r = triNoiseD(wp, *n, ROUGH_FREQ, FU.simClock * ROUGH_EVOLVE);
  *n = tiltNormal(*n, r.yzw * (ROUGH_SLOPE * ag * lodFade(ROUGH_FREQ, fp) / ROUGH_FREQ));
  // covered fraction: the pattern where pixels resolve it, its mean beyond
  // (the coverage itself never fades: whitewater reads from any distance)
  let cover = mix(SPRAY_COVER_MAX, FOAM_COVER_MAX, aer.y) * ag;
  let pw = lodFade(FOAM_FREQ, fp);
  var c = cover;
  if (pw > 0.0) {
    let q = wp + FOAM_SHIFT;
    let t = FU.simClock * FOAM_EVOLVE;
    // the octaves about their mean, blended keeping one octave's spread
    let w2 = FOAM_OCT2_W * lodFade(FOAM_FREQ2, fp);
    let v = mix(triNoiseD(q, *n, FOAM_FREQ, t).x, triNoiseD(q, *n, FOAM_FREQ2, t).x, w2) - 0.5;
    let vs = v * inverseSqrt((1.0 - w2) * (1.0 - w2) + w2 * w2) * triSpread(*n);
    // white where the noise is past its (1 − cover) quantile: a share cover of the surface
    let pc = clamp(1.0 - cover, FOAM_COVER_EPS, 1.0 - FOAM_COVER_EPS);
    let z = FOAM_NOISE_SD * FOAM_PROBIT_K * log(pc / (1.0 - pc));
    c = mix(cover, smoothstep(z - FOAM_EDGE, z + FOAM_EDGE, vs), pw);
  }
  if (c <= 0.0) { return; }
  var sunVis = vec3f(1.0);
  if (FU.shadows != 0u) { sunVis = sunShadowAt(p + *n * IFACE_PROBE); }
  let diff = max((dot(*n, FU.sun) + FOAM_WRAP) / (1.0 + FOAM_WRAP), 0.0);
  let L = FU.sunCol * sunVis * diff + skyAmbient(*n) + sampleLight(p) * FU.lightGain;
  *col += *trans * c * FOAM_ALBEDO * L;
  *trans *= 1.0 - c;
}` : ''}

// The tracer's hook at a liquid surface event: hp, outward normal n0 (wind
// ripples applied), liquid id. Returns the normal to refract/reflect with;
// foam adds its light and covers what is behind it.
fn liquidDetail(hp: vec3f, n0: vec3f, id: i32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) -> vec3f {${LIQ_DETAIL(detail, backend) ? `
  if (!liqDetailOn(id)) { return n0; }
  var n = n0;${ripples ? `
  n = liquidCapillary(hp, n);` : ''}${meniscus ? `
  n = liquidMeniscus(hp, n, id);` : ''}${foam ? world ? `
  liquidFoam(hp, &n, id, col, trans);` : `
  if (${format} == 2u || ${format} == 3u || ${!!detail.DETAIL_LIQ_FOAM}) { liquidFoam(hp, &n, id, col, trans); }` : ''}
  return n;` : `
  return n0;   // (no liquid detail compiled in)`}
}
`;
};


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
//
// The kernel follows main's aerationFrag as of the last sync (docs/webgpu.md
// Sync log, Sync 3: `git show 5551bd7:src/shaders/gfx/liquidDetail.js`), with
// a list of bricks, the pre-move copy and moveSrc in place of the slots
// (docs/webgpu.md G4). Main reverted whitewater v1 and v2 between Sync 2 and
// Sync 3 (the jet's fall-height aeration, the streaks), so the model is the
// WebGPU branch's starting one (Pilch & Erdman's breakup for liquid in the
// air, `grounded` from the liquid below's w alone) with these changes, per
// cell p whose content came from q (the move's source, or p on an idle step):
//   - q is wrapped past a loop edge (simModes.js edgeCell), and a q past a
//     void edge is still air: the record is 0;
//   - p not filled with foaming liquid holds a wake (wakeAt): 0 where p
//     holds anything but air or gas; where liquid off the ground (its
//     previous record y > 0.5, w < 0.5) has just left p (q != p) with a
//     velocity (the pre-move B at p, nonzero), a new one, (v̂.x, −1, v̂.y,
//     v̂.z) with v̂ that velocity's direction scaled by 1 if the parcel was a
//     pour's (y > 1.5), else 0.5; else the wake p had (y < 0), its age −y
//     less TRAIL_FADE = 1/TRAIL_JOIN_STEPS a step, 0 once that is gone;
//   - y = 2 (a pour's parcel) for liquid that is alone (airborne, no foaming
//     liquid above q or beside it in x or z, in the pre-move state), had a
//     liquid record (y > 0.5), and either was a pour's parcel already (y >
//     1.5) or moved (q != p) into a wake going its way: a previous record
//     with y < 0 at p or one of p's four horizontal neighbours whose
//     dot(normalize(xzw), dir) > JOIN_COS, dir = normalize(B(q).xyz), the
//     pre-move velocity (0 if it is 0).
//
// Where p's content came from is the move's own record: a block that ran
// (a cell of it in a DRAWN unit, as the move decides) and isn't based in a
// quiet brick wrote moveSrc (the source 0..7 in the block, P.srcAt); a
// quiet-base block and a block that didn't run stayed put (q = p), as the
// gather's slots said in the WebGL build.
//
// The AER list (docs/webgpu.md G4). Every liquid cell's record is nonzero
// (y = 1), so listing the bricks whose output isn't zero ran the kernel over
// every pool, settled or not, at every step (~0.4 ms a step on a 128³ grid
// with a pool over the floor). It lists the bricks whose output may CHANGE
// instead. A cell's output is a function of the records and the state within
// a cell of it (q, the cells above and below q, its wakes), and the state
// changes only in DRAWN bricks (the settle rule, shaders/activity.js: a unit
// not DRAWN keeps its cells, and a write between steps forces it DRAWN). A
// brick is listed at a step when
//   - near: a brick within one brick of it (wrapped past loop edges) is
//     DRAWN under this step's map and one may hold a foaming liquid
//     (marks.foams: react's word for the DRAWN bricks it wrote, 1 from any
//     writer; exact for the pre-move content, as a brick not DRAWN keeps its
//     cells), on a real step (an idle one moves nothing);
//   - or it was near at the last step (nz bit AER_NEAR_BIT): that step's
//     move and react changed the state this step reads;
//   - or a brick within one brick of it had a record changed by the last
//     step (nz bit 1 − P.tb: the aeration kernel sets bit
//     P.tb for a brick whose output differs from its previous record, and
//     the list kernel clears it first, so a brick off the list reads as
//     unchanged; the bits alternate so that neighbours read the last step's
//     while each brick clears its own for this one);
//   - or the field starts over (P.all: after a reset or a window shift, for
//     two steps, as the foams words and the copies then say nothing).
// Exact: off the list, nothing within a cell of the brick was drawn at this
// step or the last, so the state its cells read is what the last step read,
// with no moves (q = p); and the records within a cell are what the last
// step read too. So its output is its last record, which both copies hold:
// it did not change at the last step, so the copy written then and the one
// before agree (by induction from the zeroed start). The reference runs the
// same kernel over every brick (P.all, I2.6: tools/aeration-check.mjs
// compares the two bit for bit at every step). A settled pool, foam burst,
// costs only the list kernel (a thread per brick); foam bursting on it lists
// its bricks while their records change.
const AER_FOAMS_NOTE = 'FOAMS(id): the tables\' (gfx/materials.js FOAMS), which react lists by';
export const AerParams = uniformStruct('AerParams', {
  ...SIM_MODE_FIELDS,   // gravMode, edge (src/simModes.js: edgeCell)
  still: 'u32',         // an idle step: every cell stays put
  parity: 'u32',        // the move's block offset (frame & 1)
  srcAt: 'u32',         // moveSrc's plane in its buffer (words)
  cur: 'u32',           // the aeration copy read; the other is written
  all: 'u32',           // every brick (the reference), not the list
  tb: 'u32',            // this step's changed bit in nz (AER list, above): its aeration steps alternate 0, 1
});
// nz's bits per brick (the AER list, above): changed at an aeration step of
// parity tb (bit tb), and near at the last step.
const AER_NEAR_BIT = 4;
// Group 2: moveSrc (sim.moveSrc), the aeration's two copies (vec2u: f16
// pairs), the nz words.
export const AER_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
const aerConsts = () => `const MS_PER_CELL_STEP: f32 = ${g(MS_PER_CELL_STEP)};   // m/s per cell/step
const STEP_S: f32 = ${g(STEP_S)};             // physical s per step
const AER_KEEP: f32 = ${g(Math.exp(-STEP_S / FOAM_TAU_S))};           // per step at a free surface
const AER_RISE: f32 = ${g((BUBBLE_RISE_MS * STEP_S) / CELL_M)};          // share rising a cell per step
const FOAM_V_ONSET: f32 = ${g(FOAM_V_ONSET)};   // m/s
const FOAM_V_FULL: f32 = ${g(FOAM_V_FULL)};     // m/s
const AIR_RHO: f32 = ${g(AIR_RHO)};          // kg/m³
const WE_ONSET: f32 = ${g(WE_ONSET)};
const TRAIL_FADE: f32 = ${g(1 / TRAIL_JOIN_STEPS)};   // a wake record's fade per step
const JOIN_COS: f32 = ${g(JOIN_COS)};
${perLiquidFn('AER_SIGMA', (q) => q.sigma)}   // surface tension, N/m
${perLiquidFn('AER_RHO', (q) => q.rho)}       // density, kg/m³`;
const peFitWGSL = PE_FIT.map(([lim, c, e]) => `${lim === Infinity ? '' : `if (we < ${g(lim)}) { `}return ${g(c)} * pow(x, ${g(e)});${lim === Infinity ? '' : ' }'}`).join('\n  ');

export const aerationFrag = (grid) => /* wgsl */ `
${prelude(grid, STATE_OPTS.STATE_ACT)}
${AerParams.wgsl}
@group(3) @binding(1) var<uniform> P: AerParams;
${simModesGLSL}
@group(2) @binding(0) var<storage, read> moveSrc: array<u32>;
@group(2) @binding(1) var<storage, read_write> aer: array<vec2u>;
@group(2) @binding(2) var<storage, read_write> nz: array<atomic<u32>>;
${aerConsts()}
const AER_VISIBLE_MIN: f32 = ${g(AER_VISIBLE_MIN)};
var<workgroup> wgNz: atomic<u32>;
var<workgroup> wgFoam: atomic<u32>;
fn aerPrev(c: vec3i) -> vec4f {
  let w = aer[P.cur * SLOTS + slotOf(c)];
  return vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
}
fn supports(id: i32) -> bool { return !isGasLike(id); }
// ${AER_FOAMS_NOTE}
fn foams(id: i32) -> bool { return FOAMS(id); }
// Air (or gas) at p, its content now from q: a wake if liquid off the ground
// just left it, else what wake it had, faded (pours, above).
fn wakeAt(p: vec3i, q: vec3i, id: i32) -> vec4f {
  if (supports(id)) { return vec4f(0.0); }   // (filled with something)
  let f = aerPrev(p);
  if (f.y > 0.5) {
    var v = fetchB(p).xyz;   // the parcel's velocity before it left
    if (all(q == p) || f.w > 0.5 || dot(v, v) == 0.0) { return vec4f(0.0); }   // (it was on the ground)
    v = normalize(v) * select(0.5, 1.0, f.y > 1.5);
    return vec4f(v.x, -1.0, v.y, v.z);
  }
  let rec = -f.y - TRAIL_FADE;
  if (f.y < 0.0 && rec > 0.0) { return vec4f(f.x, -rec, f.z, f.w); }
  return vec4f(0.0);
}
// a wake at c whose maker went the way dir does
fn wake(c: vec3i, dir: vec3f) -> bool {
  if (!inGrid(c)) { return false; }
  let f = aerPrev(c);
  return f.y < 0.0 && dot(normalize(f.xzw), dir) > JOIN_COS;
}
fn wet(c: vec3i) -> bool { return inGrid(c) && foams(eid(fetchA(c))); }
// Pilch & Erdman's total breakup time, in units of t* (We > WE_ONSET)
fn breakupT(we: f32) -> f32 {
  let x = we - WE_ONSET;
  ${peFitWGSL}
}
// Where p's content was before the move (outside the grid: past a void edge)
fn sourceOf(p: vec3i) -> vec3i {
  if (P.still != 0u) { return p; }
  let par = i32(P.parity);
  let base = ((p - par) >> vec3u(1u)) * 2 + par;
  // a block that didn't run, or is based in a quiet brick, stayed put (shaders/move.js).
  // Along an axis its two cells share a brick (and so a unit, and whether
  // they are in the grid: its sides are brick faces) unless it is based on a
  // brick's last layer, so each brick it spans is looked up once: 1 at
  // parity 0, 3.4 on average at parity 1, not 8.
  let span = select(vec3i(0), vec3i(1), (base & vec3i(BS - 1)) == vec3i(BS - 1));
  var ran = false;
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1);
    if (any(o > span)) { continue; }
    let c = edgeCell(base + o);
    if (inGrid(c) && drawnUnit(unitOfCell(c))) { ran = true; }
  }
  if (!ran || quietCell(edgeCell(base))) { return p; }
  let i = i32(moveSrc[P.srcAt + slotOf(p)]);
  return edgeCell(base + vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1));   // (past a loop edge: the far side's)
}
fn aeration(p: vec3i) -> vec4f {
  let q = sourceOf(p);
  if (!inGrid(q)) { return vec4f(0.0); }   // (in from past a void edge: still air)
  let id = eid(fetchA(q));
  if (!foams(id)) { return wakeAt(p, q, id); }
  let UP = vec3i(0, 1, 0);
  let f0 = aerPrev(q);
  var F = f0.x;
  var fall = f0.z;
  var below = E_WALL;
  if (q.y > 0) { below = eid(fetchA(q - UP)); }
  var above = E_EMPTY;
  if (q.y < NY - 1) { above = eid(fetchA(q + UP)); }
  var fb = vec4f(0.0);   // the field under it
  if (q.y > 0) { fb = aerPrev(q - UP); }
  let airborne = !supports(below);
  // grounded: resting on the ground through whatever liquid is under it (a
  // pool) rather than on liquid that is itself falling. Propagates up a
  // liquid column a cell per step.
  let grounded = !airborne && (!foams(below) || fb.w > 0.5);
  let bq = fetchB(q).xyz;
  let vy = bq.y;   // cells/step, before the move
  // liquid new here (poured, melted, condensed since the last step): clear,
  // and falling as fast as it was made to
  if (f0.y < 0.5) { F = 0.0; fall = max(-vy, 0.0); }
  if (foams(above)) { F -= AER_RISE * F; }
  else if (!airborne) { F *= AER_KEEP; }
  if (foams(below)) { F += AER_RISE * fb.x; }
  if (airborne) {
    let v = abs(vy) * MS_PER_CELL_STEP;
    let we = AIR_RHO * v * v * CELL_M / AER_SIGMA(id);
    if (we > WE_ONSET) { F += STEP_S * v / (breakupT(we) * CELL_M * sqrt(AER_RHO(id) / AIR_RHO)); }
  }
  // In free fall, or fell a cell: at this speed. Resting on falling liquid it
  // rides along with what it has (a blob's upper part; drops meeting in the
  // air merge rather than trap air). Resting on grounded matter it has
  // landed: it hit at its fall.
  if (airborne || (q.y > p.y && q.x == p.x && q.z == p.z)) { fall = max(-vy, 0.0); }
  else if (grounded) {
    F = max(F, smoothstep(FOAM_V_ONSET, FOAM_V_FULL, fall * MS_PER_CELL_STEP));
    fall = 0.0;
  }
  // a pour's parcel (pours, above): alone off the ground, it followed one
  // (moved into a wake going its way, or beside one), or did before
  let X = vec3i(1, 0, 0);
  let Z = vec3i(0, 0, 1);
  let alone = airborne && !foams(above) && !wet(q + X) && !wet(q - X) && !wet(q + Z) && !wet(q - Z);
  var dir = vec3f(0.0);
  if (dot(bq, bq) > 0.0) { dir = normalize(bq); }
  let moved = any(q != p);
  let pour = alone && f0.y > 0.5 && (f0.y > 1.5 || (moved && (wake(p, dir) || wake(p + X, dir)
    || wake(p - X, dir) || wake(p + Z, dir) || wake(p - Z, dir))));
  return vec4f(min(F, 1.0), select(1.0, 2.0, pour), fall, select(0.0, 1.0, grounded));
}
// A workgroup per brick of the AER list (P.all: of the grid), a thread per
// cell: the other copy's record, and the brick's nz bit P.tb if any record
// changed; and the field's count of visible foam (liquid at AER_VISIBLE_MIN
// or more) into the word after the bricks' (gfx/foam.js reads it on idle
// steps; a brick off the list holds no foam that is bursting, so none it
// would count that matters).
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let k = foldId(wg, nwg);
  var valid = k < NBRICKS;
  var b = k;
  if (P.all == 0u) {
    valid = k < act[ACT_COUNT + CNT_AER];
    if (valid) { b = act[ACT_AERL + k]; }
  }
  if (valid) {
    let s = b * 64u + li;
    let o = aeration(cellOf(s));
    let w = vec2u(pack2x16float(o.xy), pack2x16float(o.zw));
    let prev = aer[P.cur * SLOTS + s];
    aer[(1u - P.cur) * SLOTS + s] = w;
    if (any(w != prev)) { atomicOr(&wgNz, 1u); }
    if (o.y > 0.5 && o.x >= AER_VISIBLE_MIN) { atomicAdd(&wgFoam, 1u); }
  }
  workgroupBarrier();
  if (li == 0u && valid) {
    // (the list kernel cleared bit P.tb; nothing else in the word is this kernel's)
    let changed = atomicLoad(&wgNz);
    if (changed != 0u) { atomicOr(&nz[b], changed << P.tb); }
    let foam = atomicLoad(&wgFoam);
    if (foam != 0u) { atomicAdd(&nz[NBRICKS], foam); }
  }
}
`;

// The AER list kernel: a thread per brick (above), appending to the list and
// an append counter of its own (the count's word AER_APPEND, after
// ACT_COUNTS'); then the args kernel, one thread, takes its length into
// CNT_AER (the aeration kernel's bound), starts the counter over and writes
// the aeration's indirect arguments (ARGS.AER, fold()ed).
export const AER_APPEND = 6;   // act's count words: ACT_COUNTS uses 0-5
export const AerListParams = uniformStruct('AerListParams', {
  still: 'u32',   // an idle step: nothing is drawn, nothing moves
  all: 'u32',     // list every brick
  hist: 'u32',    // whether nz's history lists a brick: 1 (test only: 0, tools/aeration-check.mjs's negative control)
  wrap: 'u32',    // loop edges: the dilation wraps (edgeCell; 'loop' is reserved in WGSL)
  tb: 'u32',      // this step's changed bit (AerParams.tb)
});
// group 1 (marks, act read_write: no state) and group 2 (args, nz)
export const AER_LIST_STATE = { state: false, marks: true, act: 'read_write' };
export const AER_LIST_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
const aerListHead = (grid) => `
${prelude(grid, AER_LIST_STATE)}
${AerListParams.wgsl}
@group(3) @binding(1) var<uniform> P: AerListParams;
@group(2) @binding(0) var<storage, read_write> args: array<u32>;
@group(2) @binding(1) var<storage, read_write> nz: array<atomic<u32>>;   // (neighbours read a word while its brick's thread clears another bit of it)
const AER_APPEND: u32 = ${AER_APPEND}u;
const AER_NEAR_BIT: u32 = ${AER_NEAR_BIT}u;
const ARGS_AER: u32 = ${ARGS.AER / 4}u;   // words
const MAX_WG: u32 = ${MAX_WORKGROUPS}u;`;
export const aerListFrag = (grid) => /* wgsl */ `
${aerListHead(grid)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let h = atomicLoad(&nz[b]);
  let c = brickCoord(b);
  let last = 1u << (1u - P.tb);   // the last step's changed bit
  // over the bricks within one (wrapped past loop edges): drawn, holding
  // foaming liquid, changed at the last step (the AER list, above)
  var drawn = false;
  var wet = false;
  var changed = false;
  // (done once near is known true, or on an idle step, where nothing is near, once changed is)
  for (var i = 0; i < 27 && !(drawn && wet) && !(P.still != 0u && changed); i++) {
    var n = c + vec3i(i % 3, (i / 3) % 3, i / 9) - 1;
    if (P.wrap != 0u) { n = (n + vec3i(BX, BY, BZ)) % vec3i(BX, BY, BZ); }
    else if (any(n < vec3i(0)) || any(n >= vec3i(BX, BY, BZ))) { continue; }
    let id = brickId(n);
    if (P.still == 0u) {
      drawn = drawn || drawnUnit(unitOfBrick(id));
      wet = wet || atomicLoad(&marks[MARK_FOAMS + id]) != 0u;
    }
    changed = changed || (atomicLoad(&nz[id]) & last) != 0u;
  }
  let near = drawn && wet;
  let on = P.all != 0u || near || (P.hist != 0u && (changed || (h & AER_NEAR_BIT) != 0u));
  // this step's changed bit starts clear (the aeration kernel sets it), and the near bit is this step's
  atomicAnd(&nz[b], ~((1u << P.tb) | AER_NEAR_BIT));
  if (near) { atomicOr(&nz[b], AER_NEAR_BIT); }
  if (on) {
    let k = atomicAdd(&act[ACT_COUNT + AER_APPEND], 1u);
    atomicStore(&act[ACT_AERL + k], b);
  }
}
`;
export const aerArgsFrag = (grid) => /* wgsl */ `
${aerListHead(grid)}
@compute @workgroup_size(1)
fn main() {
  let n = atomicLoad(&act[ACT_COUNT + AER_APPEND]);
  atomicStore(&act[ACT_COUNT + CNT_AER], n);
  atomicStore(&act[ACT_COUNT + AER_APPEND], 0u);
  atomicStore(&nz[NBRICKS], 0u);   // the visible foam's count, which this step's aeration adds up
  let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
  args[ARGS_AER] = (n + y - 1u) / y;
  args[ARGS_AER + 1u] = y;
  args[ARGS_AER + 2u] = 1u;
}
`;

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
const listLayouts = () => [LAYOUT.TABLES, stateLayout(AER_LIST_STATE), AER_LIST_LAYOUT];
export const WGSL_CHECK = [
  { name: 'aeration', kind: 'compute', code: aerationFrag, params: AerParams, warm: false,
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_ACT, AER_LAYOUT], dispatch: (grid) => fold(grid.nbricks) },
  { name: 'aerList', kind: 'compute', code: aerListFrag, params: AerListParams, warm: false,
    layouts: listLayouts, dispatch: (grid) => fold(Math.ceil(grid.nbricks / 64)) },
  { name: 'aerArgs', kind: 'compute', code: aerArgsFrag, params: AerListParams, warm: false, layouts: listLayouts, dispatch: () => [1, 1, 1] },
];

// Steps an idle world's foam takes to burst to AER_VISIBLE_MIN (gfx/foam.js idle).
export const AER_IDLE_STEPS = Math.ceil((Math.log(1 / AER_VISIBLE_MIN) * FOAM_TAU_S) / STEP_S);
