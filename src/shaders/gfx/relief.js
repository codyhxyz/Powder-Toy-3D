
// Surface relief up close (gfx/detail.js: DETAIL_RELIEF).
//
// The smooth solids (powders, wood, rock) are the 0.5 isosurface of blurred
// occupancy, so up close they are smooth blobs whose texture is only a bump
// map. With relief on, where the relief's height spans pixels, the tracer
// carves that surface by the material's own mid-scale height field
// (reliefHeight in gfx/surface.js, the same one the bump uses): crags,
// clumps and bark furrows get real silhouettes, occlude each other, shift
// with parallax and shade each other from the sun.
//
// The blurred surface is the envelope: relief only ever carves into it, never
// adds matter outside it. Below the envelope at depth d (cells) a point is
// solid if d >= carve = w * clamp(top - h, 0, RELIEF_SPAN * top), where h is
// the height, top its usual high point (heights above it are the envelope's
// flat tops) and w the fade-in. So the tracer's own hit is where the ray
// enters the shell; from there it marches through the shell to the carved
// surface, or out the other side (a groove at a silhouette: the ray goes on).
// d comes from the field: (φ - 0.5) / |∇φ|, with |∇φ| taken at the entry.
// h is read where the point projects onto the envelope (p + n d): the relief
// is a height field over the surface (bark on a trunk, crags on a boulder),
// and the hit's texture is read there too (gatherSurf), so its colour and
// bump belong to the same spot of the field as its carved shape. (Read at p
// itself, the solid noise changed with depth: a furrow 3 cm deep is half a
// plate across in the bark's lattice, which tore the walls into slivers.)
//
// w fades the geometry in by the relief's size in pixels (and out at borders
// between materials), so nothing pops and distant views are unchanged. The
// shading normal is already the bump of the same height, i.e. the carved
// surface's normal: it is not bumped again. Lighting lookups (shadow map,
// AO, probes) stay those of the envelope; the shadow map's bias (≥ 0.8
// cells) covers the carving, so carved points don't self-shadow from it.
// What the envelope's lighting can't see is the relief itself, so two terms
// add it (both from the same carved solid the eye ray met):
// - reliefSun (run by reliefHit, read by shadeSurf as reliefSunVis): the sun
//   ray from the hit through the shell, blocked by the relief around it
//   (crevices and furrows in the shade of their walls when the sun is low
//   across them: the cue that makes relief read; the bump alone only turns
//   faces toward or away from the sun);
// - reliefSkyVis: how far down a crevice the hit is darkens the ambient and
//   sky light (not the sun: it has its own test).
//
// The march steps by what the ray covers along the surface, not along itself:
// the carved surface under the ray changes only as the ray moves sideways,
// so a ray looking straight in needs few samples and a grazing one many.
// The crossing is then refined by regula falsi on the depth (the same
// quantity the samples give for free).
//
// Everything is a function of position, the element and its cells' data: the
// relief is anchored in the matter like its texture.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2); surfaceGLSL
// pastes it only with DETAIL_RELIEF on (a JS template switch, F2). The GLSL's
// two reliefCarve overloads are reliefCarve(p, d, &g) and reliefCarveAt(p, d)
// (WGSL has no overloads, H1.12).
export const reliefGLSL = /* wgsl */ `
// fade-in: the relief's high point 'top' spans this many pixels (none .. full)
const RELIEF_PX_LO: f32 = 1.0;
const RELIEF_PX_HI: f32 = 3.0;
// ... and the element's share of its channel's cells around the hit (none ..
// full): at a border with another material the relief flattens out
const RELIEF_SHARE_LO: f32 = 0.55;
const RELIEF_SHARE_HI: f32 = 0.85;
// Carving depth, in units of the element's top: crevices bottom out at
// top - h = RELIEF_SPAN * top (a flat floor), so past that depth it's solid.
const RELIEF_SPAN: f32 = 2.5;
// The march through the shell: one sample per RELIEF_STEP_PER_FEATURE of the
// relief's finest feature (reliefFeature) or RELIEF_PX_STEP pixels of
// footprint, whichever is longer, measured ALONG THE SURFACE (the ray's
// sideways travel; its sine to the normal floored at RELIEF_SIN_MIN), with
// RELIEF_STEPS_MIN..MAX samples; then RELIEF_REFINE regula-falsi steps on the
// bracket that crossed (each split kept RELIEF_SPLIT_LO..HI into the bracket,
// so a lopsided one still shrinks from both ends). A grazing ray's path is
// cut at RELIEF_PATH_MAX (cells), its cosine to the surface floored at
// RELIEF_COS_MIN.
const RELIEF_PX_STEP: f32 = 2.0;
const RELIEF_STEP_PER_FEATURE: f32 = 0.25;
const RELIEF_SIN_MIN: f32 = 0.1;
const RELIEF_STEPS_MIN: i32 = 2;
const RELIEF_STEPS_MAX: i32 = 16;
const RELIEF_REFINE: i32 = 2;
const RELIEF_SPLIT_LO: f32 = 0.1;
const RELIEF_SPLIT_HI: f32 = 0.9;
const RELIEF_PATH_MAX: f32 = 1.5;
const RELIEF_COS_MIN: f32 = 0.12;
const RELIEF_SLOPE_MIN: f32 = 0.05;   // floor on |∇φ| (per cell) when converting φ to depth
// The high point 'top' of each element's height (cells): a high quantile of
// it. fBm heights (mFbmD) are ±0.45 at most and mostly within ±0.3 units.
const RELIEF_FBM_TOP: f32 = 0.3;
const RELIEF_CRAG_TOP: f32 = 0.5;     // rock crags, in units of ROCK_CRAG_H (rockCrags: ~±0.9) times the element's relief
fn reliefTop(id: i32) -> f32 {
  if (id == E_SAND) { return (SAND_SLUMP_H + SAND_CLUMP_H) * RELIEF_FBM_TOP; }
  if (id == E_SNOW) { return (SNOW_DRIFT_H + SNOW_CLUMP_H) * RELIEF_FBM_TOP; }
  if (id == E_GUNPOWDER) { return POWDER_LUMP_H * RELIEF_FBM_TOP; }
  if (id == E_ASH) { return ASH_LUMP_H * RELIEF_FBM_TOP; }
  if (SURF(id) == SURF_CRAG) { return SURFP(id).x * ROCK_CRAG_H * RELIEF_CRAG_TOP; }
  if (id == E_WOOD) { return WOOD_FUR_DEPTH; }   // the plates' surface (furrows and domes go down from it)
  return 0.0;
}
// Size of the finest feature of each element's relief that the march must
// not step over (cells): the wavelength of its finest strong octave.
fn reliefFeature(id: i32) -> f32 {
  if (id == E_SAND) { return 1.0 / (SAND_CLUMP_F * MFBM_LACUNARITY); }
  if (id == E_SNOW) { return 1.0 / (SNOW_CLUMP_F * MFBM_LACUNARITY); }
  if (id == E_GUNPOWDER) { return 1.0 / (POWDER_LUMP_F * MFBM_LACUNARITY); }
  if (id == E_ASH) { return 1.0 / (ASH_LUMP_F * MFBM_LACUNARITY * MFBM_LACUNARITY); }
  if (SURF(id) == SURF_CRAG) { return 1.0 / (ROCK_CRAG_F * ROCK_CRAG_LAC * ROCK_CRAG_LAC); }
  return WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow's half-width
}

// The relief being traced (set by reliefHit, read by reliefSunVis and
// reliefSkyVis in its shadeSurf)
var<private> gRelOn: bool = false;
var<private> gRelId: i32;
var<private> gRelCh: i32;
var<private> gRelW: f32;
var<private> gRelTop: f32;
var<private> gRelSlope: f32;
var<private> gRelFp: f32;
var<private> gRelD: f32;
var<private> gRelOff: f32;
var<private> gRelSun: f32;
var<private> gRelN: vec3f;
var<private> gRelP: vec3f;
var<private> gRelQ: vec3f;

// How deep the relief is carved below the envelope at p, d deep (cells): the
// height is read where p projects onto the envelope (p + n d), so the relief
// is a height field over the surface, as bark on a trunk or crags on a
// boulder, not a solid texture that changes with depth.
// *g: the height's gradient there (cells per cell)
fn reliefCarve(p: vec3f, d: f32, g: ptr<function, vec3f>) -> f32 {
  let h = reliefHeight(gRelId, worldPos(p + gRelN * d), gRelN, gRelFp);   // anchored in the world
  *g = h.yzw;
  return gRelW * clamp(gRelTop - h.x, 0.0, RELIEF_SPAN * gRelTop);
}
fn reliefCarveAt(p: vec3f, d: f32) -> f32 {
  var g: vec3f;
  return reliefCarve(p, d, &g);
}
// Depth below the envelope where the field is phi (cells)
fn reliefDepth(phi: f32) -> f32 { return (phi - SURF_ISO) / gRelSlope; }

// Sunlight reaching the carved hit past the relief around it: the sun ray (l)
// from the hit, marched through the shell until it leaves it (it can only be
// blocked while it is deeper than the carving gets, and only by the relief:
// the envelope's own shape at the cell scale is the shadow map's). Each
// sample sees the carved surface under it at an elevation angle, clearance /
// distance; the share of the sun's disc (SUN_TAN_RADIUS, gfx/lighting.js)
// above the highest such horizon is the light that gets through: a true
// penumbra, crisp at the centimetre scale as real contact shadows are.
// Sampling as the eye's march (along the surface: the sun ray moves sideways
// at the cosine of its elevation), at most RELIEF_SUN_STEPS_MAX samples, the
// whole set shifted by a per-pixel, per-frame fraction of a step (ign, as the
// tracer's own march) so a ridge tip between two samples shows as noise that
// TAA averages into the edge rather than as streaks along the sun; no test
// where its whole path is under RELIEF_SUN_PX_MIN pixels (a shadow that short
// is the bumped normal's own falloff).
const RELIEF_SUN_STEPS_MAX: i32 = 12;
const RELIEF_SUN_PX_MIN: f32 = 1.0;
// its samples per feature: a shadow is cast by a feature's bulk, so half a
// feature apart is enough (the eye's march must not step over its tips)
const RELIEF_SUN_STEP_PER_FEATURE: f32 = 0.25;
fn reliefSun(l: vec3f) -> f32 {
  var sinE = dot(l, gRelN);
  if (sinE <= 0.0) { return 1.0; }   // the envelope faces away: the shadow map and n.l have it
  sinE = max(sinE, RELIEF_COS_MIN);
  let cosE = max(sqrt(1.0 - sinE * sinE), RELIEF_SIN_MIN);
  let L = min(gRelD / sinE, RELIEF_PATH_MAX);
  if (L * cosE < RELIEF_SUN_PX_MIN * gRelFp) { return 1.0; }
  let stride = max(gRelFp * RELIEF_PX_STEP, RELIEF_SUN_STEP_PER_FEATURE * reliefFeature(gRelId)) / cosE;
  let n = clamp(i32(ceil(L / stride)), 1, RELIEF_SUN_STEPS_MAX);
  let dt = max(stride, L / f32(RELIEF_SUN_STEPS_MAX));   // (whole steps, as the eye's march)
  var vis = 1.0;
  let jit = 1.0 - ign(gFragCoord, f32(FU.frame));   // in (0, 1]
  for (var i = 1; i <= RELIEF_SUN_STEPS_MAX; i++) {
    if (i > n) { break; }
    // (no nearer than a pixel along the surface: the root's own error is about that)
    let ts = clamp(dt * (f32(i - 1) + jit), RELIEF_SUN_PX_MIN * gRelFp / cosE, L);
    let p = gRelP + l * ts;
    let phi = surfChannel(p, gRelCh);
    if (phi < SURF_ISO) { break; }   // out of the envelope: past the relief
    // the ray's height above the carved surface under it
    let d = reliefDepth(phi);
    let clear = gRelOff - (d - reliefCarveAt(p, d));
    vis = min(vis, clamp(0.5 + 0.5 * clear / (ts * SUN_TAN_RADIUS), 0.0, 1.0));
    if (vis <= 0.0) { break; }
  }
  return vis;
}

// (read by shadeSurf for the hit reliefHit set)
fn reliefSunVis() -> f32 { return select(1.0, gRelSun, gRelOn); }

// The ray (ro, rd) enters smooth channel ch's surface at *t. Moves *t onto the
// carved surface and returns true, or, if the ray passes through the shell
// without meeting it, moves *t to where it leaves and returns false (the
// caller restarts its march there: the ray may come back in at once).
fn reliefHit(ro: vec3f, rd: vec3f, ch: i32, t: ptr<function, f32>) -> bool {
  gRelOn = false;
  let p0 = ro + rd * (*t);
  // the dominant element around the hit (as gatherSurf weighs the cells)
  let q = p0 - 0.5;
  let c0 = vec3i(floor(q));
  let f = q - vec3f(c0);
  var id1 = E_EMPTY;
  var id2 = E_EMPTY;
  var w1 = 0.0;
  var w2 = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1);
    let c = c0 + o;
    if (outside(c)) { continue; }
    let id = eid(fetchA(c));
    if (SURFCH(id) != ch) { continue; }
    let wv = mix(1.0 - f, f, vec3f(o));
    let w = wv.x * wv.y * wv.z;
    if (id1 == E_EMPTY || id == id1) { id1 = id; w1 += w; }
    else if (id2 == E_EMPTY || id == id2) { id2 = id; w2 += w; }
  }
  if (w2 > w1) { id1 = id2; let tw = w1; w1 = w2; w2 = tw; }
  let top = reliefTop(id1);
  if (top <= 0.0) { return true; }
  let fp = footprint(p0);
  let w = smoothstep(RELIEF_PX_LO, RELIEF_PX_HI, top / fp)
        * smoothstep(RELIEF_SHARE_LO, RELIEF_SHARE_HI, w1 / max(w1 + w2, 1e-6));
  if (w <= 0.0) { return true; }
  // the envelope's normal and slope (tetrahedral difference, as surfNormal)
  let k = vec2f(1.0, -1.0);
  let gr = k.xyy * surfChannel(p0 + k.xyy * NORMAL_STEP, ch) + k.yyx * surfChannel(p0 + k.yyx * NORMAL_STEP, ch)
         + k.yxy * surfChannel(p0 + k.yxy * NORMAL_STEP, ch) + k.xxx * surfChannel(p0 + k.xxx * NORMAL_STEP, ch);
  let gl = length(gr);
  if (gl < 1e-5) { return true; }
  // the tetrahedron's four taps sum to 4 h ∇φ
  gRelId = id1; gRelCh = ch; gRelW = w; gRelTop = top;
  gRelN = -gr / gl;
  gRelSlope = max(gl / (4.0 * NORMAL_STEP), RELIEF_SLOPE_MIN);
  let cosV = max(-dot(rd, gRelN), RELIEF_COS_MIN);
  let sinV = max(sqrt(1.0 - cosV * cosV), RELIEF_SIN_MIN);
  // A pixel's footprint on the surface stretches by 1 / cos along the ray: the
  // relief is filtered (its octaves faded) by that, so at grazing angles only
  // what spans pixels there is left, not a speckle of sub-pixel peaks.
  gRelFp = fp / cosV;
  let L = min(w * top * RELIEF_SPAN / cosV, RELIEF_PATH_MAX);
  let stride = max(gRelFp * RELIEF_PX_STEP, RELIEF_STEP_PER_FEATURE * reliefFeature(id1)) / sinV;
  let n = clamp(i32(ceil(L / stride)), RELIEF_STEPS_MIN, RELIEF_STEPS_MAX);
  // samples at whole steps (where they fall doesn't jump from pixel to pixel
  // with the step count), stretched only where the count runs out
  let dt = max(stride, L / f32(RELIEF_STEPS_MAX));
  // ia, ib: how far inside the carved surface (depth - carve, >= 0: solid)
  // the ends of the bracket [ta, tb] are; ca, cb: the carving there; da, db:
  // their depth
  // gb: the height's gradient at the solid end
  var gb: vec3f;
  var cb = reliefCarve(p0, 0.0, &gb);
  var ta = 0.0;
  var tb = 0.0;
  var ia = -cb;
  var ib = -cb;
  var ca = cb;
  var da = 0.0;
  var db = 0.0;
  var hit = ib >= 0.0;
  var wasIn = false;
  // the whole path: a grazing ray may leave the envelope and come back in
  for (var i = 1; i <= RELIEF_STEPS_MAX; i++) {
    if (hit || i > n) { break; }
    let ts = min(dt * f32(i), L);
    let p = p0 + rd * ts;
    let phi = surfChannel(p, ch);
    // in the envelope and out again: it went through a groove
    if (phi < SURF_ISO && wasIn) { *t += ts; return false; }
    wasIn = wasIn || phi >= SURF_ISO;
    ta = tb; ia = ib; ca = cb; da = db;
    db = reliefDepth(phi);
    cb = reliefCarve(p, db, &gb);
    tb = ts; ib = db - cb;
    hit = ib >= 0.0;
  }
  // Never in the envelope: the tracer's crossing was a grazing touch at a
  // silhouette, or its root fell short of the surface. Either way the ray is
  // outside here: go on from the end of the path, where the march finds the
  // surface again if it is ahead. (Keeping the hit drew the uncarved
  // silhouette as a fringe of envelope above the carved one.)
  if (!hit && !wasIn) { *t += L; return false; }
  // else deeper than any crevice (or the path cut): solid by then
  // gRelOff: how far inside the carved surface the hit itself is (the root's
  // error, or the cut path's shortfall), so the sun test measures clearance
  // from the surface, not from the point
  var th = tb;
  var dh = db;
  gRelD = cb; gRelOff = ib;
  if (hit && tb > 0.0) {
    for (var i = 0; i < RELIEF_REFINE; i++) {
      let tm = mix(ta, tb, clamp(ia / (ia - ib), RELIEF_SPLIT_LO, RELIEF_SPLIT_HI));
      let p = p0 + rd * tm;
      var gm: vec3f;
      let dm = reliefDepth(surfChannel(p, ch));
      let cm = reliefCarve(p, dm, &gm);
      let im = dm - cm;
      if (im >= 0.0) { tb = tm; ib = im; cb = cm; db = dm; gb = gm; } else { ta = tm; ia = im; ca = cm; da = dm; }
    }
    let s = clamp(ia / (ia - ib), 0.0, 1.0);
    th = mix(ta, tb, s);
    dh = mix(da, db, s);
    gRelD = mix(ca, cb, s);
    gRelOff = mix(ia, ib, s);
  }
  *t += th;
  gRelP = p0 + rd * th;
  gRelQ = gRelP + gRelN * dh;   // where its texture is read (gatherSurf)
  gRelOn = true;
  // Its sunlight past the relief, here, where the hit is known to be carved
  // (shadeSurf is called from many places; this keeps one copy of the march
  // in the program). Only where the sun can light it: the bumped normal (the
  // tilt applyMat gives it) faces the sun, or wraps light past the terminator.
  let nb = normalize(gRelN - (gb - gRelN * dot(gRelN, gb)));
  gRelSun = 1.0;
  if (dot(nb, FU.sun) + SSS(id1) > 0.0) { gRelSun = reliefSun(FU.sun); }
  return true;
}

// Sky (and ambient) seen from the carved hit, from its depth d below the
// envelope in a crevice of width W: from the floor of a long slot the sky is
// the opening's angle, a view factor of 1 / sqrt(1 + (2 d / W)^2) (as deep
// as it is wide: 0.45, about half). d carries the fade-in w, so far away
// (w = 0) nothing changes. W is the relief's typical crevice: half the
// wavelength of its main octave, or a bark furrow rim to rim.
const RELIEF_CREVICE_PER_WAVE: f32 = 0.5;
fn reliefWidth(id: i32) -> f32 {
  if (id == E_SAND) { return RELIEF_CREVICE_PER_WAVE * SAND_SLUMP_M / CELL_M; }
  if (id == E_SNOW) { return RELIEF_CREVICE_PER_WAVE * SNOW_DRIFT_M / CELL_M; }
  if (id == E_GUNPOWDER) { return RELIEF_CREVICE_PER_WAVE * POWDER_LUMP_M / CELL_M; }
  if (id == E_ASH) { return RELIEF_CREVICE_PER_WAVE * ASH_LUMP_M / CELL_M; }
  if (SURF(id) == SURF_CRAG) { return RELIEF_CREVICE_PER_WAVE * ROCK_CRAG_M / CELL_M; }
  return 2.0 * WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow, rim to rim (half-width x 2)
}
// (and clears the hit: it is read once, by the shadeSurf of the hit that set it)
fn reliefSkyVis() -> f32 {
  if (!gRelOn) { return 1.0; }
  gRelOn = false;
  let r = 2.0 * gRelD / reliefWidth(gRelId);
  return inverseSqrt(1.0 + r * r);
}
`;

