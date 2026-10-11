
// Close-up detail (gfx/detail.js): grains drawn as real geometry inside their cells.
//
// "grains" (DETAIL_GRAINS): up close, each rubble (STONE) cell is the pile
// of broken rock it holds. A cell is CELL_M across and a chip ~PEBBLE_M
// (gfx/surface.js), so a cell holds a sub-lattice of PEB_N³ chip sites; most
// sites hold a chip: a box of its own size, flattening and turn with its
// corners knocked off (cut by an ellipsoid PEB_CORNER times its size), so
// flat faces meet at sharp edges like freshly broken rock. A
// pebble belongs to its cell (its seed) and the sub-lattice runs on unbroken
// across cells: a pebble near a face may straddle it into the gravel next
// door, so a heap shows no seams at the cell faces. The heap
// keeps the shape the smooth surface gives it (the cells' staircase would
// otherwise show as terraces): pebbles outside that surface are left out, and
// where it bulges into an empty cell (the inside corner of a step) that cell
// holds pebbles of the gravel cell next to it. A lone gravel cell is a round
// clump. Rays walk
// the sub-lattice through the gravel cells they cross and test only the eight
// sites nearest each stretch of the ray (exact ray–ellipsoid hits), so a heap
// has real silhouettes, pebbles hide one another, and the eye sees down into
// dark gaps between them. A pebble is darkened by the pebbles touching it
// (contact occlusion) and shadowed by the ones between it and the sun.
//
// "grainClusters" (DETAIL_GRAIN_CLUSTERS): a lone cell of powder (sand, snow,
// gunpowder, ash; gravel when pebbles are off), which the smooth surface draws
// as one round blob, is a 30 cm clump. Its grains are far below a pixel even
// up close (sand ~0.3 mm, black powder ~1 mm), so it is drawn as a cohesive
// clod: a few flat, overlapping lumps blended into one body (smooth minimum
// of their distance fields), roughened by noise, with the element's own
// texture, slumped onto whatever it rests on. Rays sphere-trace it.
//
// Honesty: where a cell's pebbles or lobes sit, how big they are, how they
// are turned and what rock they are is a hash of the cell's seed and nothing
// else, so they are fixed to the cell and move exactly when and where the sim
// moves it. Nothing is animated.
//
// Hand-off: by footprint. Far away the gravel texture (same rock types, same
// pebble size) or the smooth blob is drawn; up close the geometry. In between
// both are traced and crossfaded by distance, with no threshold to pop.
// Beyond the band nothing here runs past a footprint test.
//
// Hooks in render.js: grainEvent per cell of the realistic march, and the
// EV_GRAIN hit and the hand-off's path not taken (gAlt*), both shaded after
// the march through grainSurf.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2), pasted after
// surfaceGLSL. What #ifdef'd it is a JS template switch (F2): detail is the
// defines object of gfx/detail.js; with neither switch on there is no code
// at all, and GRAINS_ANY(detail) tells the tracer whether to call it. It uses
// the tracer's event codes EV_NONE and EV_OPAQUE (render.js, as in GLSL).
// The march's state (gGrainMode, gPebSteps, ...) is private to the
// invocation; the tracer resets nothing, one pixel being one invocation.

/** Whether either grain switch is on (the GLSL's GRAINS_ANY), for the tracer. */
export const GRAINS_ANY = (detail = {}) => !!(detail.DETAIL_GRAINS || detail.DETAIL_GRAIN_CLUSTERS);

export const grainsGLSL = (detail = {}) => {
  const pebbles = !!detail.DETAIL_GRAINS;
  const clusters = !!detail.DETAIL_GRAIN_CLUSTERS;
  if (!pebbles && !clusters) return '// (no grains: DETAIL_GRAINS and DETAIL_GRAIN_CLUSTERS are off)';
  return /* wgsl */ `
const EV_GRAIN: i32 = 4;   // tracer event (render.js EV_*): the ray hit a grain

// What the ray is committed to (see grainEvent).
const GM_OPEN: i32 = 0;    // nothing yet
const GM_GEOM: i32 = 1;    // geometry: the smooth surface it replaces is skipped
const GM_TEX: i32 = 2;     // the textured smooth surface: no more geometry

// gHitK: what was hit
const GK_VOID: i32 = -1;   // the dark depth between pebbles (the ray went too deep)
const GK_PEBBLE: i32 = -2; // a pebble (gHitA = its site)
const GK_CLOD: i32 = 0;    // a clod (gHitA = its cell)

// ---- pebbles (gravel cells) ----
const PEB_N: i32 = i32(PEBBLE_F + 0.5);   // pebble sites per cell along a line
const PEB_Q: f32 = 1.0 / f32(PEB_N);      // site pitch, cells
// in site pitches:
const PEB_P: f32 = 0.88;                  // share of sites holding a pebble
const PEB_R_MIN: f32 = 0.4;               // longest semi-axis of the box ...
const PEB_R_VAR: f32 = 0.2;
const PEB_CORNER: f32 = 1.3;              // the corner-cutting ellipsoid, as a multiple of the box's semi-axes
const PEB_JITTER: f32 = 0.2;              // centre's reach from the site's middle (each axis)
// (a chip reaches at most PEB_CORNER · (PEB_R_MIN + PEB_R_VAR) <= 1 -
// PEB_JITTER from its centre, so any point of it lies in the 2×2×2 sites
// nearest that point: the walk only tests those)
// semi-axes as shares of the longest (broken rock: blocky to slabby)
const PEB_MID_MIN: f32 = 0.6;
const PEB_FLAT_MIN: f32 = 0.35;
const PEB_FLAT_MAX: f32 = 0.85;
const PEB_CLUMP_R: f32 = 0.45;            // a lone gravel cell: pebbles within this of its middle (cells)
// An empty cell inside the smooth surface holds pebbles of the gravel cell
// next to it, looked for in this order (below first: they slumped there).
// A site of an empty cell whose middle's field is under this share of the
// surface level can't hold a pebble (its jittered centre is inside the
// surface only where the field is near it): skips the neighbour search.
const PEB_FILL_PRECHECK: f32 = 0.6;
// six entries, so a private array (docs/webgpu.md C6)
var<private> PEB_FILL_DIRS: array<vec3i, 6> = array<vec3i, 6>(vec3i(0, -1, 0), vec3i(1, 0, 0), vec3i(-1, 0, 0),
                                                             vec3i(0, 0, 1), vec3i(0, 0, -1), vec3i(0, 1, 0));

// ---- clods (lone powder cells) ----
const CLOD_LOBES: i32 = 4;                // a core and its lumps
const CLOD_CORE_R: f32 = 0.27;            // core's longest semi-axis, cells
const CLOD_CORE_VAR: f32 = 0.05;
const CLOD_LUMP_R: f32 = 0.17;            // lump's longest semi-axis, cells
const CLOD_LUMP_VAR: f32 = 0.06;
const CLOD_LUMP_OFF: f32 = 0.1;           // lump's distance from the middle, cells (they overlap the core)
const CLOD_LUMP_OFF_VAR: f32 = 0.08;
const CLOD_REST_SQUASH: f32 = 0.6;        // a resting clod's lobes keep this share of their height over the floor
const CLOD_BLEND: f32 = 0.12;             // smooth-minimum width blending the lobes into one body, cells
// Roughness: noise displacement of the surface (frequency per cell, amplitude cells), two octaves.
const CLOD_BUMP_F: f32 = 4.5;
const CLOD_BUMP: f32 = 0.035;
const CLOD_GRIT_F: f32 = 12.0;
const CLOD_GRIT: f32 = 0.01;
const SMIN_BULGE: f32 = 0.25;             // the smooth minimum swells the union by at most this share of its width
const CLOD_MARGIN: f32 = CLOD_BUMP + CLOD_GRIT + SMIN_BULGE * CLOD_BLEND;   // the lobes keep this far inside the cell (cells)
// Per element: shortest/longest semi-axis of a lobe (clods are flattish crumbs).
const CLOD_FLAT_SAND: f32 = 0.6;
const CLOD_FLAT_SNOW: f32 = 0.7;
const CLOD_FLAT_GUNPOWDER: f32 = 0.6;
const CLOD_FLAT_ASH: f32 = 0.4;
const CLOD_FLAT_STONE: f32 = 0.6;
// Sphere tracing: steps, step shrink (the noise steepens the field past a true
// distance), hit tolerance (share of a pixel), normal stencil (cells, at least).
const CLOD_STEPS: i32 = 48;
const CLOD_STEP_K: f32 = 0.6;
const CLOD_HIT_PX: f32 = 0.5;
const CLOD_NORMAL_H: f32 = 2e-3;

// ---- hand-off by footprint ----
// Geometry starts where a feature is *_PX_NONE pixels across and has taken
// over by *_PX_FULL (feature: a pebble; a clod's lump).
const PEB_PX_NONE: f32 = 8.0;
const PEB_PX_FULL: f32 = 16.0;
const CLOD_PX_NONE: f32 = 8.0;
const CLOD_PX_FULL: f32 = 16.0;
const PEB_D: f32 = PEBBLE_M / CELL_M;            // a pebble's size, cells
const CLOD_D: f32 = 2.0 * CLOD_LUMP_R;           // a lump's size, cells
const PEB_FP_NONE: f32 = PEB_D / PEB_PX_NONE;    // cells per pixel
const PEB_FP_FULL: f32 = PEB_D / PEB_PX_FULL;
const CLOD_FP_NONE: f32 = CLOD_D / CLOD_PX_NONE;
const CLOD_FP_FULL: f32 = CLOD_D / CLOD_PX_FULL;

// ---- bounds on the work per ray ----
const PEB_MAX_STEPS: i32 = 24;            // sub-lattice steps (8 sites each) per ray; then it is in the dark between them
const PEB_SUN_STEPS: i32 = 8;             // sub-lattice steps toward the sun tested for pebble shadows
const CLOD_MAX_CELLS: i32 = 4;            // lone cells tested per ray

// ---- shading ----
const GRAIN_TEX_SPREAD: f32 = 61.0;       // cells of texture space the hash spreads pebbles and clods over
const PEB_AO_R: f32 = 0.8;                // a neighbour occludes like a ball this share of its longest semi-axis
const PEB_AO_GAIN: f32 = 0.6;             // contact occlusion: darkening per unit of summed ball occlusion ...
const PEB_AO_MAX: f32 = 0.85;             // ... at most this much
const GRAIN_NUDGE: f32 = 1e-3;            // cells off a surface where its sun ray starts
const DUAL_NUDGE: f32 = 1e-4;             // sub-lattice units past the start of a walk
const TWO_PI_G: f32 = 6.2831853;
const GRAIN_SALT: u32 = 0x9e3779b9u;      // golden-ratio odd constant: spreads site / lobe indices apart in the hash

// a uniform draw from hash stream *h (u32ToF32: rounded the same on every device, H1.28)
fn u01(h: ptr<function, u32>) -> f32 {
  *h = pcg(*h);
  return u32ToF32(*h) * UINT_TO_UNIT;
}

// ---- which cells hold geometry ----
fn isPebbles(id: i32) -> bool { return ${pebbles ? 'id == E_STONE' : 'false'}; }
fn grainElement(id: i32) -> bool {
  if (isPebbles(id)) { return true; }${clusters ? `
  if (SURFCH(id) == CH_GRANULAR) { return true; }` : ''}
  return false;
}
fn granularAt(c: vec3i) -> bool { return !outside(c) && SURFCH(eid(fetchA(c))) == CH_GRANULAR; }
// no granular face neighbour
fn loneCell(c: vec3i) -> bool {
  return !granularAt(c + vec3i(1, 0, 0)) && !granularAt(c - vec3i(1, 0, 0)) && !granularAt(c + vec3i(0, 1, 0))
      && !granularAt(c - vec3i(0, 1, 0)) && !granularAt(c + vec3i(0, 0, 1)) && !granularAt(c - vec3i(0, 0, 1));
}
// pebbles: every gravel cell; clods: only a lone cell
fn grainCellOk(c: vec3i, id: i32) -> bool { return isPebbles(id) || loneCell(c); }
// a lone cell resting on something
fn grainResting(c: vec3i) -> bool {
  if (c.y == 0) { return true; }
  let b = eid(fetchA(c - vec3i(0, 1, 0)));
  return b != E_EMPTY && KIND(b) != K_GAS;
}

// Weight of the geometry (vs the texture) at footprint fp.
fn grainW(id: i32, fp: f32) -> f32 {
  if (isPebbles(id)) { return 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp); }
  return 1.0 - smoothstep(CLOD_FP_FULL, CLOD_FP_NONE, fp);
}
fn grainWMax(fp: f32) -> f32 {
  var w = 0.0;${pebbles ? `
  w = 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp);` : ''}${clusters ? `
  w = max(w, 1.0 - smoothstep(CLOD_FP_FULL, CLOD_FP_NONE, fp));` : ''}
  return w;
}

// A uniformly random turn (Shoemake's quaternion), as axes (columns).
fn randomTurn(h: ptr<function, u32>) -> mat3x3f {
  let q1 = u01(h);
  let q2 = TWO_PI_G * u01(h);
  let q3 = TWO_PI_G * u01(h);
  let q = vec4f(sqrt(1.0 - q1) * vec2f(sin(q2), cos(q2)), sqrt(q1) * vec2f(sin(q3), cos(q3)));
  let x = q.x;
  let y = q.y;
  let z = q.z;
  let w = q.w;
  return mat3x3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
                 2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
                 2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

// Normal of the ellipsoid (centre c, semi-axes s along the columns of R) at p.
fn ellNormal(p: vec3f, c: vec3f, s: vec3f, R: mat3x3f) -> vec3f { return normalize(R * ((transpose(R) * (p - c)) / (s * s))); }
// Ray vs a chip: the box of semi-axes s (turned by R) cut by the ellipsoid of
// semi-axes PEB_CORNER · s. Both are convex, so the ray is inside the chip from
// the later of the two entries to the earlier of the two exits.
fn chipHit(ro: vec3f, rd: vec3f, c: vec3f, s: vec3f, R: mat3x3f) -> f32 {
  let Rt = transpose(R);
  let o = Rt * (ro - c);
  let d = Rt * rd;
  let inv = 1.0 / d;
  let ta = (-s - o) * inv;
  let tb = (s - o) * inv;
  let tn = min(ta, tb);
  let tf = max(ta, tb);
  var t0 = max(max(tn.x, tn.y), tn.z);
  var t1 = min(min(tf.x, tf.y), tf.z);
  let se = s * PEB_CORNER;
  let oe = o / se;
  let de = d / se;
  let a = dot(de, de);
  let b = dot(oe, de);
  let k = dot(oe, oe) - 1.0;
  var h = b * b - a * k;
  if (h < 0.0) { return NO_HIT; }
  h = sqrt(h);
  t0 = max(t0, (-b - h) / a);
  t1 = min(t1, (-b + h) / a);
  return select(NO_HIT, t0, t0 <= t1);
}
// Normal of a chip at p on its surface: the box face it is on, or the cut corner.
fn chipNormal(p: vec3f, c: vec3f, s: vec3f, R: mat3x3f) -> vec3f {
  let q = transpose(R) * (p - c);
  let b = abs(q) / s;
  let box = max(max(b.x, b.y), b.z);
  if (length(q / (s * PEB_CORNER)) > box) { return ellNormal(p, c, s * PEB_CORNER, R); }
  var f: vec3f;
  if (b.x >= box) { f = vec3f(sign(q.x), 0.0, 0.0); }
  else if (b.y >= box) { f = vec3f(0.0, sign(q.y), 0.0); }
  else { f = vec3f(0.0, 0.0, sign(q.z)); }
  return R * f;
}
// does the ray (rd unit length) come within r of c somewhere in [tMin, tBest)?
fn ballNear(ro: vec3f, rd: vec3f, c: vec3f, r: f32, tMin: f32, tBest: f32) -> bool {
  let oc = ro - c;
  let b = dot(oc, rd);
  var h = b * b - dot(oc, oc) + r * r;
  if (h < 0.0) { return false; }
  h = sqrt(h);
  return -b - h < tBest && -b + h >= tMin;
}

// ---- pebbles ----
// The pebble at site s of its cell (state a; trimmed to a round clump if the
// cell is lone): false if the site is empty, else its centre *c (grid units)
// and longest semi-axis *r. *h carries on to pebbleShape.
// (cell: the cell the site is in; a: its owner's state, the cell itself or,
// filling an empty cell, its gravel neighbour PEB_FILL_DIRS[fill - 1])
fn pebbleAt(s: vec3i, cell: vec3i, a: vec4f, lone: bool, fill: i32, c: ptr<function, vec3f>, r: ptr<function, f32>,
            h: ptr<function, u32>) -> bool {
  let l = s - cell * PEB_N;
  *h = pcg(bitcast<u32>(fract(a.w)) ^ (u32(1 + l.x + PEB_N * (l.y + PEB_N * (l.z + PEB_N * fill))) * GRAIN_SALT));
  let pr = u01(h);
  let rr = PEB_Q * (PEB_R_MIN + PEB_R_VAR * u01(h));
  *r = rr;
  let jx = u01(h);
  let jy = u01(h);
  let jz = u01(h);
  let cc = (vec3f(s) + 0.5 + (2.0 * vec3f(jx, jy, jz) - 1.0) * PEB_JITTER) * PEB_Q;
  *c = cc;
  // (Pebbles may straddle their cell's faces: the walk tests them from both
  // sides; where they would poke into open air the smooth surface below has
  // already left them out.)
  if (pr >= PEB_P) { return false; }
  if (lone) { return distance(cc, vec3f(cell) + 0.5) + rr < PEB_CLUMP_R; }   // a round clump inside its cell
  return surfField(cc)[CH_GRANULAR] >= SURF_ISO;   // the heap's smooth shape
}
fn pebbleShape(r: f32, h: ptr<function, u32>, sa: ptr<function, vec3f>, R: ptr<function, mat3x3f>) {
  let u1 = u01(h);
  let u2 = u01(h);
  *sa = r * vec3f(1.0, mix(PEB_MID_MIN, 1.0, u1), mix(PEB_FLAT_MIN, PEB_FLAT_MAX, u2));
  *R = randomTurn(h);
}

// The gravel cell an empty cell borrows pebbles from (fill = 1 + its index in
// PEB_FILL_DIRS, its state in *a), or fill = 0 if none.
fn pebbleFill(cell: vec3i, a: ptr<function, vec4f>) -> i32 {
  *a = vec4f(0.0);
  for (var i = 0; i < 6; i++) {
    let c = cell + PEB_FILL_DIRS[i];
    if (outside(c)) { continue; }
    let ac = fetchA(c);
    *a = ac;
    if (eid(ac) == E_STONE) { return i + 1; }
  }
  return 0;
}

// The first pebble the ray hits in [t0, t1] (its stretch through cell 'cell',
// gravel or an empty cell borrowing pebbles), NO_HIT if none; *sHit = its
// site. Walks the dual sub-lattice (whose corners are the sites) and tests the
// sites at each step's corners: the cell's own and those of gravel next door
// reaching in. *steps (the march's gPebSteps) counts the walk against
// PEB_MAX_STEPS; *tStop = where it ran out (a dual-lattice plane, half a site
// off every cell face).
fn pebblesHit(cell: vec3i, a: vec4f, lone: bool, fill: i32, ro: vec3f, rd: vec3f, t0: f32, t1: f32,
              steps: ptr<private, i32>, sHit: ptr<function, vec3i>, tStop: ptr<function, f32>) -> f32 {
  *sHit = vec3i(-1);
  *tStop = t0;
  let N = f32(PEB_N);
  let o2 = ro * N - 0.5;   // dual cell k spans sites k .. k + 1
  let d2 = rd * N;
  var dc = vec3i(floor(o2 + d2 * t0 + sign(d2) * DUAL_NUDGE));
  let istp = vec3i(sign(d2));
  let tDelta = abs(1.0 / d2);
  var tMax = (vec3f(dc) + step(vec3f(0.0), d2) - o2) / d2;
  var best = NO_HIT;
  for (var i = 0; i < PEB_MAX_STEPS; i++) {
    if (*steps >= PEB_MAX_STEPS) { break; }
    *steps += 1;
    let tb = min(min(tMax.x, tMax.y), tMax.z);
    for (var k = 0; k < 8; k++) {
      let s = dc + vec3i(k & 1, (k >> 1u) & 1, k >> 2u);
      let own = vec3i(floor((vec3f(s) + 0.5) * PEB_Q));
      var c: vec3f;
      var r: f32;
      var h: u32;
      if (all(own == cell)) {
        if (!pebbleAt(s, cell, a, lone, fill, &c, &r, &h)) { continue; }
      } else {
        // a neighbour's pebble reaching in: gravel's own, or one an empty cell borrowed
        if (outside(own)) { continue; }
        let an = fetchA(own);
        let idn = eid(an);
        if (idn == E_STONE) {
          if (!pebbleAt(s, own, an, false, 0, &c, &r, &h)) { continue; }
        } else if (idn == E_EMPTY) {
          if (surfField((vec3f(s) + 0.5) * PEB_Q)[CH_GRANULAR] < SURF_ISO * PEB_FILL_PRECHECK) { continue; }   // (cheap: clearly outside)
          var af: vec4f;
          let fl = pebbleFill(own, &af);
          if (fl == 0 || !pebbleAt(s, own, af, false, fl, &c, &r, &h)) { continue; }
        } else { continue; }
      }
      if (!ballNear(ro, rd, c, PEB_CORNER * r, t0, best)) { continue; }
      var sa: vec3f;
      var R: mat3x3f;
      pebbleShape(r, &h, &sa, &R);
      let t = chipHit(ro, rd, c, sa, R);
      if (t >= t0 && t < best) { best = t; *sHit = s; }
    }
    if (best <= tb || tb >= t1) { break; }   // nothing nearer can come later
    *tStop = tb;
    let ax = argmin3(tMax);
    dc[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return select(NO_HIT, best, best <= t1 + PEB_Q);   // (a pebble straddling the exit face counts)
}

// ---- clods ----
fn clodFlat(id: i32) -> f32 {
  if (id == E_SAND) { return CLOD_FLAT_SAND; }
  if (id == E_SNOW) { return CLOD_FLAT_SNOW; }
  if (id == E_GUNPOWDER) { return CLOD_FLAT_GUNPOWDER; }
  if (id == E_ASH) { return CLOD_FLAT_ASH; }
  return CLOD_FLAT_STONE;
}
// The clod of a lone cell: its lobes (centre, semi-axes, inverse turn) and a
// texture-space offset for its roughness, all from the cell's seed.
fn clodBuild(cell: vec3i, id: i32, a: vec4f, C: ptr<function, array<vec3f, CLOD_LOBES>>, S: ptr<function, array<vec3f, CLOD_LOBES>>,
             RT: ptr<function, array<mat3x3f, CLOD_LOBES>>, off: ptr<function, vec3f>) {
  let resting = grainResting(cell);
  let fl = clodFlat(id);
  var h0 = pcg(bitcast<u32>(fract(a.w)));
  let ox = u01(&h0);
  let oy = u01(&h0);
  let oz = u01(&h0);
  *off = vec3f(ox, oy, oz) * GRAIN_TEX_SPREAD;
  for (var k = 0; k < CLOD_LOBES; k++) {
    var h = pcg(bitcast<u32>(fract(a.w)) ^ (u32(k + 1) * GRAIN_SALT));
    var r: f32;
    var o = vec3f(0.0);
    if (k == 0) {
      r = CLOD_CORE_R + CLOD_CORE_VAR * u01(&h);
    } else {
      r = CLOD_LUMP_R + CLOD_LUMP_VAR * u01(&h);
      let z = 2.0 * u01(&h) - 1.0;
      let ph = TWO_PI_G * u01(&h);
      let dist = CLOD_LUMP_OFF + CLOD_LUMP_OFF_VAR * u01(&h);
      let rz = sqrt(max(1.0 - z * z, 0.0));
      o = dist * vec3f(rz * cos(ph), z, rz * sin(ph));
    }
    let u1 = u01(&h);
    (*S)[k] = r * vec3f(1.0, mix(fl, 1.0, u1), fl);
    (*RT)[k] = transpose(randomTurn(&h));
    var lc = 0.5 + o;
    let m = r + CLOD_MARGIN;
    if (resting) { lc.y = m + (lc.y - m) * CLOD_REST_SQUASH; }   // slumped onto what it rests on
    (*C)[k] = vec3f(cell) + clamp(lc, vec3f(m), vec3f(1.0 - m));
  }
}
// ellipsoid distance bound (Quilez): q in the ellipsoid's frame, semi-axes s
fn sdEll(q: vec3f, s: vec3f) -> f32 {
  let k0 = length(q / s);
  let k1 = length(q / (s * s));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
fn clodSDF(p: vec3f, C: ptr<function, array<vec3f, CLOD_LOBES>>, S: ptr<function, array<vec3f, CLOD_LOBES>>,
           RT: ptr<function, array<mat3x3f, CLOD_LOBES>>, off: vec3f, cell: vec3i) -> f32 {
  var d = sdEll((*RT)[0] * (p - (*C)[0]), (*S)[0]);
  for (var k = 1; k < CLOD_LOBES; k++) { d = sminP(d, sdEll((*RT)[k] * (p - (*C)[k]), (*S)[k]), CLOD_BLEND); }
  let q = M_ROT * (p - vec3f(cell) + off);
  return d + CLOD_BUMP * (2.0 * vnoise(q * CLOD_BUMP_F) - 1.0) + CLOD_GRIT * (2.0 * vnoise(q * CLOD_GRIT_F) - 1.0);
}
// First hit of the clod in a lone cell along [t0, t1], NO_HIT if none.
fn clodHit(cell: vec3i, id: i32, a: vec4f, ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> f32 {
  var C: array<vec3f, CLOD_LOBES>;
  var S: array<vec3f, CLOD_LOBES>;
  var RT: array<mat3x3f, CLOD_LOBES>;
  var off: vec3f;
  clodBuild(cell, id, a, &C, &S, &RT, &off);
  var t = t0;
  for (var i = 0; i < CLOD_STEPS; i++) {
    if (t > t1) { break; }
    let p = ro + rd * t;
    let d = clodSDF(p, &C, &S, &RT, off, cell);
    if (d < CLOD_HIT_PX * footprint(p)) { return t; }
    t += max(d * CLOD_STEP_K, CLOD_HIT_PX * footprint(p));
  }
  return NO_HIT;
}
fn clodNormal(p: vec3f, cell: vec3i, id: i32, a: vec4f) -> vec3f {
  var C: array<vec3f, CLOD_LOBES>;
  var S: array<vec3f, CLOD_LOBES>;
  var RT: array<mat3x3f, CLOD_LOBES>;
  var off: vec3f;
  clodBuild(cell, id, a, &C, &S, &RT, &off);
  let hN = max(CLOD_NORMAL_H, footprint(p));
  let e = vec2f(1.0, -1.0);
  return normalize(e.xyy * clodSDF(p + e.xyy * hN, &C, &S, &RT, off, cell) + e.yyx * clodSDF(p + e.yyx * hN, &C, &S, &RT, off, cell)
                 + e.yxy * clodSDF(p + e.yxy * hN, &C, &S, &RT, off, cell) + e.xxx * clodSDF(p + e.xxx * hN, &C, &S, &RT, off, cell));
}

// ---- the march's state for this pixel (kept small: it stays live across the whole march) ----
var<private> gGrainMode: i32 = GM_OPEN;
var<private> gPebSteps: i32 = 0;          // sub-lattice steps walked so far
var<private> gClodCells: i32 = 0;         // lone cells tested so far
var<private> gPebInside: bool = false;    // the ray is inside the gravel's smooth surface (it was skipped)
var<private> gHitA: vec3i = vec3i(0);     // the EV_GRAIN hit: pebble site, or the clod's cell ...
var<private> gHitK: i32 = GK_VOID;        // ... and GK_* or the clod's lobe (shaded after the march)
// The path not taken while crossfading in the hand-off band: it ended at gAltP
// (geometry: gAltA, gAltK; else the granular surface) with (col, trans) in
// front of it; gAltW = the geometry's weight there (< 0: none); gAltGeom: the
// stored path is the geometry one.
var<private> gAltW: f32 = -1.0;
var<private> gAltGeom: bool = false;
var<private> gAltCol: vec3f = vec3f(0.0);
var<private> gAltTrans: vec3f = vec3f(0.0);
var<private> gAltRd: vec3f = vec3f(0.0);
var<private> gAltP: vec3f = vec3f(0.0);
var<private> gAltA: vec3i = vec3i(0);
var<private> gAltK: i32 = GK_VOID;

// The textured granular surface hit at hp: does geometry replace it here?
// True if every granular cell around hp holds geometry (or there are none,
// e.g. the blurred trail of a lone cell that moved on); *w = its weight.
fn grainSuppress(hp: vec3f, w: ptr<function, f32>) -> bool {
  let fp = footprint(hp);
  *w = grainWMax(fp);
  if (*w <= 0.0) { return false; }
  let c0 = vec3i(floor(hp - 0.5));
  var wMin = 2.0;
  for (var i = 0; i < 8; i++) {
    let c = c0 + vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1);
    if (outside(c)) { continue; }
    let id = eid(fetchA(c));
    if (SURFCH(id) != CH_GRANULAR) { continue; }
    if (!grainElement(id) || !grainCellOk(c, id)) { return false; }
    wMin = min(wMin, grainW(id, fp));
  }
  if (wMin <= 1.0) { *w = wMin; }
  return *w > 0.0;
}

// Per cell of the realistic march (render.js), once the segment's event (*ev
// at *tEv, channel evCh) is known: geometry in this cell may come first (*ev
// becomes EV_GRAIN), and the granular surface is skipped where geometry
// replaces it. In the hand-off band the first of the two to be reached is
// stored as the other path (gAlt*) and the ray goes on as the other;
// render.js shades both after the march and blends them.
fn grainEvent(cell: vec3i, id: i32, a: vec4f, ro: vec3f, rd: vec3f, tEnter: f32, tExit: f32,
              col: vec3f, trans: vec3f, ev: ptr<function, i32>, evCh: i32, tEv: ptr<function, f32>,
              anyHit: ptr<function, bool>, hitPos: ptr<function, vec3f>) {
  if (gGrainMode == GM_TEX) { return; }
  let isoCand = *ev == EV_OPAQUE && evCh == CH_GRANULAR;
  let cand = grainElement(id);
  var fillCand = false;${pebbles ? `
  // an empty cell the gravel's smooth surface reaches into
  if (id == E_EMPTY && gPebInside && !isoCand) { gPebInside = surfField(ro + rd * tEnter)[CH_GRANULAR] >= SURF_ISO; }
  fillCand = id == E_EMPTY && (isoCand || gPebInside);` : ''}
  if (!cand && !isoCand && !fillCand) { return; }
  // 1. this cell's geometry (gated by footprint before any per-cell work)
  var tG = NO_HIT;
  var wG = 0.0;
  var kG = GK_VOID;
  var aG = cell;
  if (cand) {
    wG = grainW(id, footprint(ro + rd * tEnter));
    if (wG > 0.0) {
      if (isPebbles(id)) {
        if (gPebSteps < PEB_MAX_STEPS) {
          var s: vec3i;
          var tStop: f32;
          tG = pebblesHit(cell, a, loneCell(cell), 0, ro, rd, tEnter, tExit, &gPebSteps, &s, &tStop);
          gPebInside = true;
          if (tG < NO_HIT) { kG = GK_PEBBLE; aG = s; }
          else if (gPebSteps >= PEB_MAX_STEPS) { tG = clamp(tStop, tEnter, tExit); }   // lost in the dark between the pebbles
        }
      } else if (gClodCells < CLOD_MAX_CELLS && loneCell(cell)) {
        gClodCells++;
        tG = clodHit(cell, id, a, ro, rd, tEnter, tExit);
        kG = GK_CLOD;
      }
    }
  }
  // 2. the granular surface, where geometry replaces it
  var wS: f32;
  var tIn = tEnter;   // where the ray is inside the smooth surface from
  var supp = false;
  if (isoCand && tG >= *tEv && grainSuppress(ro + rd * (*tEv), &wS)) {
    let hp = ro + rd * (*tEv);
    if (gGrainMode == GM_OPEN && wS < 1.0) {
      gAltW = wS; gAltGeom = false; gAltCol = col; gAltTrans = trans; gAltRd = rd; gAltP = hp;
      if (!(*anyHit)) { *anyHit = true; *hitPos = hp; }
    }
    gGrainMode = GM_GEOM;
    tIn = *tEv;
    *ev = EV_NONE;
    *tEv = tExit;
    supp = true;
  }${pebbles ? `
  // 2b. an empty cell inside the gravel's smooth surface: its neighbour's pebbles
  if (fillCand && (supp || gPebInside) && gGrainMode == GM_GEOM && gPebSteps < PEB_MAX_STEPS) {
    var an: vec4f;
    let fill = pebbleFill(cell, &an);
    gPebInside = fill > 0;
    if (fill > 0) {
      var s: vec3i;
      var tStop: f32;
      let t = pebblesHit(cell, an, false, fill, ro, rd, tIn, tExit, &gPebSteps, &s, &tStop);
      if (t < tG) { tG = t; kG = GK_PEBBLE; aG = s; }
      else if (t >= NO_HIT && gPebSteps >= PEB_MAX_STEPS) { tG = clamp(tStop, tIn, tExit); kG = GK_VOID; }
    }
  }` : ''}
  // 3. geometry in front of whatever else this segment holds
  if (tG < *tEv) {
    if (gGrainMode == GM_OPEN && wG < 1.0) {
      gAltW = wG; gAltGeom = true; gAltCol = col; gAltTrans = trans; gAltRd = rd;
      gAltP = ro + rd * tG; gAltA = aG; gAltK = kG;
      if (!(*anyHit)) { *anyHit = true; *hitPos = gAltP; }
      gGrainMode = GM_TEX;
    } else {
      gGrainMode = GM_GEOM;
      *ev = EV_GRAIN;
      *tEv = tG;
      gHitA = aG;
      gHitK = kG;
    }
  }
}

// ---- shading ----
// Occlusion of point p (normal n) by a ball (centre c, radius r), Quilez's
// analytic sphere occlusion.
fn ballOcc(p: vec3f, n: vec3f, c: vec3f, r: f32) -> f32 {
  let d = c - p;
  let l2 = dot(d, d);
  return max(dot(n, d) * inverseSqrt(l2), 0.0) * min(r * r / l2, 1.0);   // (inside the ball: fully)
}

// The pebble at site s, whichever cell owns it: false if none.
fn pebbleOf(s: vec3i, cell: ptr<function, vec3i>, a: ptr<function, vec4f>, c: ptr<function, vec3f>, r: ptr<function, f32>,
            h: ptr<function, u32>) -> bool {
  let own = vec3i(floor((vec3f(s) + 0.5) * PEB_Q));
  *cell = own;
  *a = vec4f(0.0); *c = vec3f(0.0); *r = 0.0; *h = 0u;
  if (outside(own)) { return false; }
  let ao = fetchA(own);
  *a = ao;
  let id = eid(ao);
  if (id == E_STONE) { return pebbleAt(s, own, ao, loneCell(own), 0, c, r, h); }
  if (id != E_EMPTY) { return false; }
  let fill = pebbleFill(own, a);
  return fill > 0 && pebbleAt(s, own, *a, false, fill, c, r, h);
}

// Sun visibility at p on the pebble at site sSelf, past the pebbles between it
// and the sun (the shadow map is far too coarse for them): PEB_SUN_STEPS steps.
fn pebbleSunVis(sSelf: vec3i, p: vec3f) -> f32 {
  let rd = safeDir(FU.sun);
  let N = f32(PEB_N);
  let o2 = p * N - 0.5;
  let d2 = rd * N;
  var dc = vec3i(floor(o2));
  let istp = vec3i(sign(d2));
  let tDelta = abs(1.0 / d2);
  var tMax = (vec3f(dc) + step(vec3f(0.0), d2) - o2) / d2;
  for (var i = 0; i < PEB_SUN_STEPS; i++) {
    for (var k = 0; k < 8; k++) {
      let s = dc + vec3i(k & 1, (k >> 1u) & 1, k >> 2u);
      if (all(s == sSelf)) { continue; }
      var cell: vec3i;
      var a: vec4f;
      var c: vec3f;
      var r: f32;
      var h: u32;
      if (!pebbleOf(s, &cell, &a, &c, &r, &h)) { continue; }
      if (!ballNear(p, rd, c, PEB_CORNER * r, 0.0, NO_HIT)) { continue; }
      var sa: vec3f;
      var R: mat3x3f;
      pebbleShape(r, &h, &sa, &R);
      let t = chipHit(p, rd, c, sa, R);
      if (t >= 0.0 && t < NO_HIT) { return 0.0; }
    }
    let ax = argmin3(tMax);
    dc[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// A material with element id's base values (as matOf starts from).
fn baseMat(id: i32) -> Mat {
  var m: Mat;
  m.alb = ALBEDO(id); m.g = vec3f(0.0); m.tang = vec3f(1.0, 0.0, 0.0); m.sssCol = vec3f(1.0);
  m.rough = ROUGH(id); m.metal = METAL(id);
  m.f0 = (IOR(id) - 1.0) / (IOR(id) + 1.0); m.f0 *= m.f0;
  m.sss = SSS(id); m.glint = GLINT(id); m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  m.emit = vec3f(0.0);
  return m;
}

// Surface record of the geometry hit at p (site / cell aH, GK_* / lobe k) by a
// ray along rd; sets gGrainSun for its shadeSurf.
fn grainSurf(aH: vec3i, k: i32, p: vec3f, rd: vec3f) -> Surf {
  var s: Surf;
  s.p = p; s.tp = p; s.tp1 = p; s.flowW = 0.0;   // glints sample at tp (shadeSurf); grains have one layer
  s.ch = CH_GRANULAR; s.face = vec3i(0, 1, 0);
  let fp = footprint(p);
  gGrainSun = 1.0;
  var m: Mat;
  if (k == GK_PEBBLE) {
    var cell: vec3i;
    var a: vec4f;
    var c: vec3f;
    var r: f32;
    var h: u32;
    _ = pebbleOf(aH, &cell, &a, &c, &r, &h);
    var sa: vec3f;
    var R: mat3x3f;
    pebbleShape(r, &h, &sa, &R);
    let n = chipNormal(p, c, sa, R);
    s.n = n; s.ng = n; s.id = E_STONE; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
    m = baseMat(E_STONE);
    if (FU.matDetail > 0.5) {
      // its own rock, shade, polish and mottle (gfx/surface.js PEB_*), in its own frame
      let typ = u01(&h);
      let shade = u01(&h);
      let ox = u01(&h);
      let oy = u01(&h);
      let oz = u01(&h);
      let lp = transpose(R) * (p - c) + vec3f(ox, oy, oz) * GRAIN_TEX_SPREAD;
      let gr = mFbmD(lp, PEB_MOTTLE_F, PEB_MOTTLE_OCT, fp);
      m.alb *= pebbleRock(typ) * (PEB_SHADE_MIN + PEB_SHADE_RANGE * shade) * (1.0 + PEB_MOTTLE_ALB * gr.x);
      m.g = R * (PEB_MOTTLE_H * gr.yzw);
      m.rough += PEB_ROUGH_VAR * (shade - 0.5) - PEB_POLISH;
    }
    // contact occlusion by the nearest pebbles (the 2×2×2 sites around p)
    let s0 = vec3i(floor(p * f32(PEB_N) - 0.5));
    var occ = 0.0;
    for (var i = 0; i < 8; i++) {
      let sn = s0 + vec3i(i & 1, (i >> 1u) & 1, i >> 2u);
      if (all(sn == aH)) { continue; }
      var cn: vec3i;
      var an: vec4f;
      var cc: vec3f;
      var rn: f32;
      var hn: u32;
      if (pebbleOf(sn, &cn, &an, &cc, &rn, &hn)) { occ += ballOcc(p, n, cc, PEB_AO_R * rn); }
    }
    m.cav *= 1.0 - min(PEB_AO_GAIN * occ, PEB_AO_MAX);
    m.emit = hotEmit(m, s.id, s.T);
    if (dot(n, FU.sun) > 0.0) { gGrainSun = pebbleSunVis(aH, p + n * GRAIN_NUDGE); }
  } else if (k == GK_VOID) {
    let cell = clamp(vec3i(floor(p)), vec3i(0), GRID - 1);
    let a = fetchA(cell);
    s.n = -normalize(rd); s.ng = s.n; s.id = E_STONE; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
    m = baseMat(E_STONE);
    m.alb *= PEB_VOID_ALB;
    m.cav = PEB_VOID_CAV;
    m.emit = hotEmit(m, s.id, s.T);
    gGrainSun = 0.0;
  } else {
    // a clod: the element's own texture, from a spot of texture space of the clod's own
    let a = fetchA(aH);
    let id = eid(a);
    let n = clodNormal(p, aH, id, a);
    s.n = n; s.ng = n; s.id = id; s.cell = aH; s.seed = fract(a.w); s.T = a.y;
    var hc = pcg(bitcast<u32>(s.seed));
    let ox = u01(&hc);
    let oy = u01(&hc);
    let oz = u01(&hc);
    let tp = p - vec3f(aH) + vec3f(ox, oy, oz) * GRAIN_TEX_SPREAD;
    m = matOf(id, tp, n, s.T, floor(a.w), fp);
  }
  applyMat(&s, m);
  return s;
}
`;
};

