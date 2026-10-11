import { CELL_M } from '../../scale.js';

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
// Falling water is a jet, not a lone drop: the sim's falling cells are
// parcels of a stream a cell (30 cm) across, and a turbulent jet that thick
// whitens as it falls. Its surface disturbances entrain air from the lip on,
// the aerated outer layer thickens with the fall, and the jet is aerated
// right through (white, breaking into spray) at its break-up length
// L_b = 6·q^0.32 m, q its discharge per unit width in m²/s (Horeni 1956, the
// rule for falling nappes used by Ervine, Falvey & Withers 1997 and Castillo
// et al. 2015). The share of the jet that is aerated is taken as the height
// fallen over L_b. (The old rule tore up a cell as a lone 30 cm drop in still
// air, Pilch & Erdman's bag breakup: that takes seconds, so streams stayed
// glassy and nearly invisible.)
const JET_Q = 0.5;                // m²/s: a nappe a cell thick leaving its lip at ~1.7 m/s
const JET_LB_M = 6 * JET_Q ** 0.32;   // m, break-up length (≈ 4.8 m)
// Bubbly water in a broken jet: void fraction and bubble radius (Chanson
// 1997, air-water flows: 1-5 mm bubbles, α ~ 0.1 in the spray region).
const JET_VOID = 0.1;
const JET_BUBBLE_R_M = 0.002;     // m
// The jet's look (liquidFoam): its aerated outer layer is not an even white
// skin but streaks drawn out along the fall, and its edge is a fringe of
// spray that thickens as it falls: the outer edge of a turbulent jet in air
// spreads by a few percent of the distance fallen (Ervine & Falvey 1987;
// 3% here), so a fully broken jet is a soft-edged rope, not a hard tube.
const JET_SPREAD = 0.03;
// Its largest surface disturbances are a fraction of its thickness: streaks
// ~6 cm across on a 30 cm jet, drawn out ~8× along the fall by its
// acceleration (photographs of plunging nappes: streaks tens of cm long).
const STREAK_ACROSS_M = 0.06;     // m
const STREAK_STRETCH = 8;         // length over width
// A parcel's wake: the sim draws a stream as parcels a few cells apart (a
// one-cell hole lets one go every ~7 steps: 7 parcels in 30 cells of fall,
// 2-8 cells apart, measured on tools/whitewater-shots.mjs's tank), so drawn
// as they are it is a dotted line of glass beads. The air a falling parcel
// (liquid off the ground) has just left keeps a record of it for
// TRAIL_JOIN_STEPS steps (over the hole's spacing). What tells a jet from a
// falling blob is the same cue a jet's continuity is: a parcel that falls
// into the wake of the one before it, within those steps, is in a stream
// (the sim's own path, no guess), and its wake is drawn for all of them, so
// successive parcels join into one rope along the path they really took. A
// parcel nothing follows (a blob, a drop of spray, a pour's leading head)
// shows its wake for TRAIL_LONE_STEPS only: half a frame at the default 4
// steps a frame, the motion blur of film's 180° shutter, not a tail.
export const TRAIL_JOIN_STEPS = 10;
export const TRAIL_LONE_STEPS = 2;
// the wake record (the aeration model, below) above which a lone parcel's wake still shows
export const TRAIL_LONE_MIN = 1 - TRAIL_LONE_STEPS / TRAIL_JOIN_STEPS;

const g = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(6));
// A per-liquid value as a function of the element id (0 for the rest): three
// liquids, so a comparison chain rather than an NE-entry table (docs/webgpu.md C6).
const perLiquidFn = (name, fn) => `fn ${name}(id: i32) -> f32 {
${Object.keys(LIQ_PROPS).map((k) => `  if (id == E_${k}) { return ${g(fn(LIQ_PROPS[k]))}; }`).join('\n')}
  return 0.0;
}`;
const wgslArray = (xs) => `array<f32, ${xs.length}>(${xs.map(g).join(', ')})`;

/** Whether any liquid detail switch is on (the GLSL's LIQ_DETAIL), for the tracer. */
export const LIQ_DETAIL = (detail = {}) => !!(detail.DETAIL_LIQ_RIPPLES || detail.DETAIL_LIQ_MENISCUS || detail.DETAIL_LIQ_FOAM);

export const liquidDetailGLSL = (detail = {}) => {
  const ripples = !!detail.DETAIL_LIQ_RIPPLES;
  const meniscus = !!detail.DETAIL_LIQ_MENISCUS;
  const foam = !!detail.DETAIL_LIQ_FOAM;
  return /* wgsl */ `
// Which copy of the aeration buffer (binding 19: both copies, docs/webgpu.md
// G4) is the current one, 0 or 1. The aeration's ping-pong isn't the state's,
// so the header's src can't say: the entry point sets it from its params, as
// it sets gFragCoord (docs/webgpu.md B6: a param chooses the copy).
var<private> gAerCopy: u32 = 0u;
${LIQ_DETAIL(detail) ? `
fn liqDetailOn(id: i32) -> bool { return SURFCH(id) == CH_LIQUID && id != E_ICE; }

// Tilt outward normal n by a height field's world gradient gr (slope units):
// only its part along the surface counts.
fn tiltNormal(n: vec3f, gr: vec3f) -> vec3f { return normalize(n - (gr - n * dot(gr, n))); }` : ''}
${ripples ? `
// Gravity-capillary ripples: CAP_OCTAVES octaves past the wind ripples, on the same
// upward-facing surfaces (RIPPLE_UP_*), each its own value-noise height field
// in (x, z, time). Equal slope per octave (the saturation range of wind-wave
// spectra: slope variance flat per octave), the same slope as the wind
// ripples'. Octaves fade in by the pixel footprint (lodFade), so far away
// nothing changes. (Five entries each: private arrays, docs/webgpu.md C6.)
const CAP_OCTAVES: i32 = ${CAP_OCTAVES};
var<private> CAP_FREQ: array<f32, CAP_OCTAVES> = ${wgslArray(CAP_FREQS)};    // cycles/cell (λ ${CAP_LAMBDAS.map((l) => (l * 100).toFixed(1)).join(', ')} cm)
var<private> CAP_DRIFT: array<f32, CAP_OCTAVES> = ${wgslArray(CAP_DRIFTS)};  // noise units/s, by dispersion
const CAP_SHIFT: f32 = 13.7;   // lattice offset per octave (noise units), so octaves don't line up
fn liquidCapillary(p: vec3f, n: vec3f) -> vec3f {
  let up = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y);
  if (up <= 0.0) { return n; }
  let fp = footprint(p);
  let wq = worldPos(p).xz;   // anchored in the world, like the wind ripples
  var gr = vec2f(0.0);       // (x, z)
  for (var i = 0; i < CAP_OCTAVES; i++) {
    let w = lodFade(CAP_FREQ[i], fp);
    if (w <= 0.0) { break; }
    // d/d(noise xz) is the slope per unit noise gradient, as RIPPLE_SLOPE
    let h = mNoiseD(vec3f(wq * CAP_FREQ[i] + CAP_SHIFT * f32(i + 1), FU.time * CAP_DRIFT[i]));
    gr += h.yz * w;
  }
  return tiltNormal(n, vec3f(gr.x, 0.0, gr.y) * RIPPLE_SLOPE * up);
}` : ''}
${meniscus ? `
// Meniscus: next to a crisp wall the surface climbs h(d) = h0·exp(−d/lc)
// (linearised Young–Laplace; d = distance to the wall). Its slope, averaged
// over the pixel's footprint [d − fp/2, d + fp/2] (exactly: the height
// difference across it over its width), tilts the normal away from the wall:
// a thin bright or dark line where water meets glass, and nothing when a
// pixel is much wider than lc.
${perLiquidFn('MEN_LC', (p) => capLen(p) / CELL_M)}   // cells
${perLiquidFn('MEN_H0', (p) => menH0(p) / CELL_M)}    // cells
const MEN_PROBE: f32 = 0.25;   // cells into the liquid (against n) where the wall cells are looked up
fn menHeight(d: f32, lc: f32, h0: f32) -> f32 { return h0 * exp(-max(d, 0.0) / lc); }
fn liquidMeniscus(p: vec3f, n: vec3f, id: i32) -> vec3f {
  if (n.y < RIPPLE_UP_LO) { return n; }
  let lc = MEN_LC(id);
  let h0 = MEN_H0(id);
  // A liquid without the model (h0 = 0) has no rise at all. (The GLSL went on
  // and could form 0 · exp(-0 / 0) = NaN at a wall: lc is 0 there too.)
  if (h0 <= 0.0) { return n; }
  let half_ = 0.5 * footprint(p);
  let c = vec3i(floor(p - n * MEN_PROBE));
  let f = p.xz - vec2f(c.xz);
  var gr = vec2f(0.0);   // height gradient, xz
  for (var k = 0; k < 4; k++) {
    var q = c;
    let ax = select(2, 0, k < 2);
    let s = select(1.0, -1.0, (k & 1) == 0);   // side the wall is on
    q[ax] += i32(s);
    if (outside(q) || !isCrisp(eid(fetchA(q)))) { continue; }
    let d = select(1.0 - f[ax >> 1u], f[ax >> 1u], s < 0.0);   // to the wall's face
    let a = d - half_;
    let b = d + half_;
    let slope = (menHeight(a, lc, h0) - menHeight(b, lc, h0)) / max(b - max(a, 0.0), 1e-6);
    gr[ax >> 1u] += s * slope;   // the surface rises toward the wall
  }
  return tiltNormal(n, vec3f(gr.x, 0.0, gr.y));
}` : ''}
${foam ? `
// Whitewater, drawn from the aeration field (the aeration pass, stepped with
// the simulation by gfx/foam.js): per liquid cell, the share of its surface
// white with entrained air, which rides with the liquid, bursts at the free
// surface and rises out of the bulk. The aeration buffer (lighting group
// binding 19, both copies, gAerCopy the current one) holds per slot
// (aeration, 1, fall, grounded) in liquid cells (y is 2 in a stream), a
// falling parcel's wake in the air it just left (y 0: the aeration model,
// below), and 0 elsewhere, as f16 (pack2x16float: x, y in the first word, z,
// w in the second). It is read trilinearly by hand (8 taps) over liquid
// cells only, so x / y is the aeration averaged over the liquid cells around
// a point (the air beside a surface doesn't thin it), w / y the share of them
// that rest on the ground (a pool, not liquid in the air or riding on
// falling liquid).
const AER_PROBE: f32 = 0.25;         // cells into the liquid (against n) where the aeration is read
const AER_LIQ_MIN: f32 = 0.02;       // liquid weight below which the read is no liquid's
fn aerTap(c: vec3i) -> vec3f {   // liquid cells only (air holds its wakes)
  if (outside(c)) { return vec3f(0.0); }
  let w = aeration[gAerCopy * SLOTS + slotOf(c)];
  let f = vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
  return select(vec3f(0.0), vec3f(f.x, 1.0, f.w), f.y > 0.5);   // (y is 2 in a stream)
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

// Aerated water is rough: breaking, churning surfaces carry slopes of
// ~0.3 over ~15 cm (Cox & Munk's slope variance at gale force is ~0.05,
// rms 0.22, and a plunge pool is rougher still).
const ROUGH_LAMBDA_M: f32 = 0.15;    // m, size of the churned bumps
const ROUGH_FREQ: f32 = CELL_M / ROUGH_LAMBDA_M;   // cycles/cell
const ROUGH_SLOPE: f32 = 0.3;        // rms-ish slope at full aeration, per unit noise gradient
const ROUGH_EVOLVE: f32 = ${g(ROUGH_RATE_S * STEP_S)};   // noise units per step: churn decorrelates in ~1/3 s
// Foam: a bubble raft, patchy (two octaves of noise thresholded to the
// covered fraction), white by multiple scattering: fresh foam reflects ~55%
// of light (Whitlock et al. 1982), scattered nearly diffusely and wrapping
// past the terminator, since light goes in and out of the bubble layer. As
// the aeration decays the covered fraction shrinks, so patches thin into the
// lace and streaks of old foam instead of fading as a whole. The pattern
// reshapes as its bubbles burst: one noise unit per foam lifetime.
const FOAM_COVER_MAX: f32 = 0.7;     // covered fraction at full aeration on resting liquid (open water still shows between)
const FOAM_PATCH_M: f32 = 0.12;      // m, foam patches between open water
const FOAM_CLUSTER_M: f32 = 0.04;    // m, bubble clusters within them (second octave)
const FOAM_FREQ: f32 = CELL_M / FOAM_PATCH_M;      // cycles/cell
const FOAM_FREQ2: f32 = CELL_M / FOAM_CLUSTER_M;   // cycles/cell
const FOAM_OCT2_W: f32 = 0.4;        // its weight (first: 1 − this)
const FOAM_EVOLVE: f32 = ${g(STEP_S / FOAM_TAU_S)};   // noise units per step (one per FOAM_TAU_S)
const FOAM_EDGE: f32 = 0.08;         // threshold softness (noise units)
const FOAM_ALBEDO: f32 = 0.55;
const FOAM_WRAP: f32 = 0.5;          // diffuse wrap (0 = Lambert)
const FOAM_SHIFT: f32 = 29.3;        // lattice offset of the foam noise from the roughness noise
// Falling water (a stream, a waterfall, spray) is not a raft: it is bubbly
// water, read from the field passes' jet channels (shaders/fields.js: the
// thin mask's y is its aeration times its presence, z its presence, so their
// ratio is the aeration at the surface, the parcels' wakes included). Its
// bubbles are 1-3 mm across at void fractions ~0.1 (Chanson 1997), which
// makes it optically thick: extinction 1.5·α/r (geometric optics, extinction
// efficiency 2), ~75 per metre. A ray through a stream a cell across meets
// its aerated part, and a chord through a round stream is shorter by the
// cosine it comes in at. The aerated share W of the jet is drawn as how much
// of its surface its white streaks cover (the way real-time waterfalls are
// drawn, as flow-mapped streaks scrolling down a translucent sheet: Naughty
// Dog's Uncharted 4 and The Last of Us Part II, Sea of Thieves, Frostbite's
// and RDR2's rivers), each streak's opacity 1 − exp(−JET_TAU·cos), soft in
// the spray fringe at the edge (JET_SPREAD). So a pour is clear, refracting
// glass with a few streaks at the lip and white by its break-up length. The
// streaks scroll down at the water's own speed, √(2g·W·L_b), in two phases
// half a cycle apart, crossfaded (Vlachos 2010, Portal 2's flow maps), so
// they never stretch. The body is drawn under the surface's reflection and
// the sun's glint (liquidUnderSkin), as bubbly water lies under its skin.
const JET_TAU: f32 = ${g((1.5 * JET_VOID / JET_BUBBLE_R_M) * CELL_M)};   // optical depth across a fully aerated stream
const JET_M_MIN: f32 = 0.02;         // jet presence below which there is none here
const JET_FRINGE: f32 = ${g((2 * JET_SPREAD * JET_LB_M) / (CELL_M / 2))};   // (edge cosine)² of the spray fringe at W = 1: 2δ/R, δ = spread × fall
const JET_EDGE_MIN: f32 = 0.05;      // edge cosine over which even a glassy jet fades in (anti-aliasing)
const STREAK_FREQ: f32 = ${g(CELL_M / STREAK_ACROSS_M)};   // cycles/cell across the streaks
const STREAK_STRETCH: f32 = ${g(STREAK_STRETCH)};
const STREAK_EDGE: f32 = 0.12;       // threshold softness (noise units)
const STREAK_PERIOD: f32 = 32.0;     // steps per flow-map cycle
const STREAK_SHIFT: f32 = 17.7;      // lattice offset of the second phase
const JET_V_FULL: f32 = ${g(Math.sqrt(2 * G_REAL * JET_LB_M) / MS_PER_CELL_STEP)};   // cells/step: the fall speed at the break-up length
// streak pattern value (0..1) at world point wp on a jet aerated by w
fn jetStreaks(wp: vec3f, w: f32) -> f32 {
  let ph = fract(FU.simClock / STREAK_PERIOD);
  let drift = sqrt(w) * JET_V_FULL * STREAK_PERIOD;   // cells a cycle: the water's speed
  let sc = vec3f(STREAK_FREQ, STREAK_FREQ / STREAK_STRETCH, STREAK_FREQ);
  let a = mNoiseD((wp + vec3f(0.0, drift * ph, 0.0)) * sc).x;
  let b = mNoiseD((wp + vec3f(0.0, drift * fract(ph + 0.5), 0.0)) * sc + STREAK_SHIFT).x;
  return mix(a, b, abs(2.0 * ph - 1.0));
}
// the jet's body as liquidFoam left it, for liquidUnderSkin
var<private> gJetC: f32 = 0.0;
var<private> gJetL: vec3f = vec3f(0.0);
fn liquidFoam(p: vec3f, n: ptr<function, vec3f>, id: i32, rd: vec3f, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let chord = abs(dot(*n, rd));   // (before the churn tilts n)
  let entering = dot(*n, rd) < 0.0;
  let aer = aerationAt(p - *n * AER_PROBE);
  let jt = fieldTex(tFT, p).yz;
  var jw = 0.0;   // falling water's aeration (its whole crossing, on the way in)
  if (jt.y > JET_M_MIN && entering) { jw = clamp(jt.x / jt.y, 0.0, 1.0); }
  let raft = aer.x * aer.y;   // aerated liquid at rest: a foam raft
  let ag = max(raft, jw);
  if (ag <= 0.0) { return; }
  let fp = footprint(p);
  let wp = worldPos(p);   // the churn and foam are anchored in the world
  let r = triNoiseD(wp, *n, ROUGH_FREQ, FU.simClock * ROUGH_EVOLVE);
  *n = tiltNormal(*n, r.yzw * (ROUGH_SLOPE * ag * lodFade(ROUGH_FREQ, fp) / ROUGH_FREQ));
  // the raft's covered fraction: the pattern where pixels resolve it, its mean beyond
  let cover = FOAM_COVER_MAX * raft;
  var pw = 0.0;
  if (cover > 0.0) { pw = lodFade(FOAM_FREQ, fp); }
  var c = cover;
  if (pw > 0.0) {
    let q = wp + FOAM_SHIFT;
    let t = FU.simClock * FOAM_EVOLVE;
    let v = mix(triNoiseD(q, *n, FOAM_FREQ, t).x, triNoiseD(q, *n, FOAM_FREQ2, t).x,
                FOAM_OCT2_W * lodFade(FOAM_FREQ2, fp));
    c = mix(cover, smoothstep(1.0 - cover - FOAM_EDGE, 1.0 - cover + FOAM_EDGE, v), pw);
  }
  var cj = 0.0;
  if (jw > 0.0) {
    let sw = lodFade(STREAK_FREQ, fp);
    var cov = jw;
    if (sw > 0.0) { cov = mix(jw, smoothstep(1.0 - jw - STREAK_EDGE, 1.0 - jw + STREAK_EDGE, jetStreaks(wp, jw)), sw); }
    cj = cov * (1.0 - exp(-JET_TAU * chord)) * smoothstep(0.0, max(sqrt(JET_FRINGE * jw), JET_EDGE_MIN), chord);
  }
  if (c <= 0.0 && cj <= 0.0) { return; }
  var sunVis = vec3f(1.0);
  if (FU.shadows != 0u) { sunVis = sunShadowAt(p + *n * IFACE_PROBE); }
  let diff = max((dot(*n, FU.sun) + FOAM_WRAP) / (1.0 + FOAM_WRAP), 0.0);
  let L = FOAM_ALBEDO * (FU.sunCol * sunVis * diff + skyAmbient(*n) + sampleLight(p) * FU.lightGain);
  *col += *trans * c * L;   // a raft floats on top
  *trans *= 1.0 - c;
  gJetC = cj;
  gJetL = L;
}
// After the surface's reflection: the jet's bubbly body under it.
fn liquidUnderSkin(col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  *col += *trans * gJetC * gJetL;
  *trans *= 1.0 - gJetC;
  gJetC = 0.0;
}` : `
// (no whitewater compiled in: nothing under the skin)
fn liquidUnderSkin(col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {}`}

// The tracer's hook at a liquid surface event: hp, outward normal n0 (wind
// ripples applied), liquid id, ray direction rd. Returns the normal to
// refract/reflect with; foam adds its light and covers what is behind it.
// After liquidInterface the tracer calls liquidUnderSkin (always defined), which
// adds a falling jet's body under the reflection.
fn liquidDetail(hp: vec3f, n0: vec3f, id: i32, rd: vec3f, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) -> vec3f {${LIQ_DETAIL(detail) ? `
  if (!liqDetailOn(id)) { return n0; }
  var n = n0;${ripples ? `
  n = liquidCapillary(hp, n);` : ''}${meniscus ? `
  n = liquidMeniscus(hp, n, id);` : ''}${foam ? `
  liquidFoam(hp, &n, id, rd, col, trans);` : ''}
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
//   off the ground (in the    a falling jet: at least the share of it its
//   air, or on falling        fall has aerated (JET_LB_M, above)
//   liquid)
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
// Output: (aeration, 1, fall speed, grounded) in liquid cells (y is 2 in a
// stream: a parcel that fell into the wake of the one before it), so the
// renderer can average the aeration over liquid cells only (aerationAt); in
// air (or gas) a falling parcel has just left, its wake (TRAIL_JOIN_STEPS,
// above): (1 if the parcel was in a stream, 0, its aeration, 1 fading to 0
// over TRAIL_JOIN_STEPS steps); 0 elsewhere. The field passes draw a parcel
// off the ground and its wake as one stream (shaders/fields.js jetWGSL).
//
// The kernel is U12's to port, here (docs/webgpu.md J1, G4: a list of
// bricks, the pre-move copy and moveSrc in place of the slots). Its GLSL is
// main's aerationFrag as of the last sync (docs/webgpu.md Sync log, Sync 2:
// `git show ff7ee51:src/shaders/gfx/liquidDetail.js`), not the one at the
// start of the WebGPU branch. Since then, per cell p whose content came from
// q (the move's source, or p on an idle step):
//   - q is wrapped past a loop edge (simModes.js edgeCell), and a q past a
//     void edge is still air: the record is 0;
//   - p not filled with foaming liquid: if it is air or gas, its wake: a new
//     one (1 if the parcel was in a stream, 0, its aeration, 1) where liquid
//     off the ground (y > 0.5, w < 0.5) has just left p (q != p), else the
//     wake p had, faded by TRAIL_FADE = 1/TRAIL_JOIN_STEPS a step (0 at or
//     under TRAIL_FADE); 0 where p holds anything else;
//   - grounded needs the liquid below to be a liquid record (y > 0.5) that is
//     grounded;
//   - off the ground, F = max(F, jetAeration(-vy)), the share fallen,
//     clamp(v² / JET_FALL_FULL), v in m/s and JET_FALL_FULL = 2·g·JET_LB_M,
//     in place of the drop breakup (AIR_RHO, WE_ONSET, PE_FIT went);
//   - y = 2 (a stream) for liquid off the ground whose record was liquid
//     (y > 0.5) and either a stream already (y > 1.5) or moved (q != p)
//     into a wake record (y < 0.5, w > 0) at p or one of p's four horizontal
//     neighbours.
// The wakes live in air cells, so the output is no longer zero wherever the
// source cell's pre-move content doesn't foam (G4's argument for the AER
// list): a brick a parcel left keeps records for TRAIL_JOIN_STEPS steps. The
// list must keep such bricks that long (aerSeen over TRAIL_JOIN_STEPS + 1
// steps, or a per-brick bit of nonzero records), and the wake test reads the
// previous records of p's horizontal neighbours. Its inputs are the model's
// constants in this file: MS_PER_CELL_STEP, STEP_S, FOAM_TAU_S,
// BUBBLE_RISE_MS, JET_LB_M, TRAIL_JOIN_STEPS, LIQ_PROPS and these two.
const FOAM_V_ONSET = 1.0;         // m/s
const FOAM_V_FULL = 4.0;          // m/s
// WEBGPU-STUB (docs/webgpu.md J3): the GLSL aeration pass, replaced by U12's WGSL kernel.
export const aerationFrag = () => {
  throw new Error('aerationFrag removed in the WebGPU port: docs/webgpu.md G4');
};

// Steps an idle world's foam takes to burst to AER_VISIBLE_MIN (gfx/foam.js idle).
export const AER_IDLE_STEPS = Math.ceil((Math.log(1 / AER_VISIBLE_MIN) * FOAM_TAU_S) / STEP_S);
