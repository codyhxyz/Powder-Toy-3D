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
export const reliefGLSL = /* glsl */ `
#ifdef DETAIL_RELIEF
// fade-in: the relief's high point 'top' spans this many pixels (none .. full)
const float RELIEF_PX_LO = 1.0, RELIEF_PX_HI = 3.0;
// ... and the element's share of its channel's cells around the hit (none ..
// full): at a border with another material the relief flattens out
const float RELIEF_SHARE_LO = 0.55, RELIEF_SHARE_HI = 0.85;
// Carving depth, in units of the element's top: crevices bottom out at
// top - h = RELIEF_SPAN * top (a flat floor), so past that depth it's solid.
const float RELIEF_SPAN = 2.5;
// The march through the shell: one sample per RELIEF_STEP_PER_FEATURE of the
// relief's finest feature (reliefFeature) or RELIEF_PX_STEP pixels of
// footprint, whichever is longer, measured ALONG THE SURFACE (the ray's
// sideways travel; its sine to the normal floored at RELIEF_SIN_MIN), with
// RELIEF_STEPS_MIN..MAX samples; then RELIEF_REFINE regula-falsi steps on the
// bracket that crossed (each split kept RELIEF_SPLIT_LO..HI into the bracket,
// so a lopsided one still shrinks from both ends). A grazing ray's path is
// cut at RELIEF_PATH_MAX (cells), its cosine to the surface floored at
// RELIEF_COS_MIN.
const float RELIEF_PX_STEP = 2.0;
const float RELIEF_STEP_PER_FEATURE = 0.25;
const float RELIEF_SIN_MIN = 0.1;
const int RELIEF_STEPS_MIN = 2, RELIEF_STEPS_MAX = 16;
const int RELIEF_REFINE = 2;
const float RELIEF_SPLIT_LO = 0.1, RELIEF_SPLIT_HI = 0.9;
const float RELIEF_PATH_MAX = 1.5;
const float RELIEF_COS_MIN = 0.12;
const float RELIEF_SLOPE_MIN = 0.05;   // floor on |∇φ| (per cell) when converting φ to depth
// The high point 'top' of each element's height (cells): a high quantile of
// it. fBm heights (mFbmD) are ±0.45 at most and mostly within ±0.3 units.
const float RELIEF_FBM_TOP = 0.3;
const float RELIEF_CRAG_TOP = 0.5;     // rock crags, in units of ROCK_CRAG_H (rockCrags: ~±0.9) times the element's relief
float reliefTop(int id) {
  if (id == E_SAND) return (SAND_SLUMP_H + SAND_CLUMP_H) * RELIEF_FBM_TOP;
  if (id == E_SNOW) return (SNOW_DRIFT_H + SNOW_CLUMP_H) * RELIEF_FBM_TOP;
  if (id == E_GUNPOWDER) return POWDER_LUMP_H * RELIEF_FBM_TOP;
  if (id == E_ASH) return ASH_LUMP_H * RELIEF_FBM_TOP;
  if (SURF[id] == SURF_CRAG) return CRAG[id].x * ROCK_CRAG_H * RELIEF_CRAG_TOP;
  if (id == E_WOOD) return WOOD_FUR_DEPTH;   // the plates' surface (furrows and domes go down from it)
  return 0.0;
}
// Size of the finest feature of each element's relief that the march must
// not step over (cells): the wavelength of its finest strong octave.
float reliefFeature(int id) {
  if (id == E_SAND) return 1.0 / (SAND_CLUMP_F * MFBM_LACUNARITY);
  if (id == E_SNOW) return 1.0 / (SNOW_CLUMP_F * MFBM_LACUNARITY);
  if (id == E_GUNPOWDER) return 1.0 / (POWDER_LUMP_F * MFBM_LACUNARITY);
  if (id == E_ASH) return 1.0 / (ASH_LUMP_F * MFBM_LACUNARITY * MFBM_LACUNARITY);
  if (SURF[id] == SURF_CRAG) return 1.0 / (ROCK_CRAG_F * ROCK_CRAG_LAC * ROCK_CRAG_LAC);
  return WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow's half-width
}

// The relief being traced (set by reliefHit, read by reliefSunVis and
// reliefSkyVis in its shadeSurf)
bool gRelOn = false;
int gRelId, gRelCh;
float gRelW, gRelTop, gRelSlope, gRelFp, gRelD, gRelOff, gRelSun;
vec3 gRelN, gRelP, gRelQ;

// How deep the relief is carved below the envelope at p, d deep (cells): the
// height is read where p projects onto the envelope (p + n d), so the relief
// is a height field over the surface, as bark on a trunk or crags on a
// boulder, not a solid texture that changes with depth.
// g: the height's gradient there (cells per cell)
float reliefCarve(vec3 p, float d, out vec3 g) {
  vec4 h = reliefHeight(gRelId, worldPos(p + gRelN * d), gRelN, gRelFp);   // anchored in the world
  g = h.yzw;
  return gRelW * clamp(gRelTop - h.x, 0.0, RELIEF_SPAN * gRelTop);
}
float reliefCarve(vec3 p, float d) { vec3 g; return reliefCarve(p, d, g); }
// Depth below the envelope where the field is phi (cells)
float reliefDepth(float phi) { return (phi - SURF_ISO) / gRelSlope; }

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
const int RELIEF_SUN_STEPS_MAX = 12;
const float RELIEF_SUN_PX_MIN = 1.0;
// its samples per feature: a shadow is cast by a feature's bulk, so half a
// feature apart is enough (the eye's march must not step over its tips)
const float RELIEF_SUN_STEP_PER_FEATURE = 0.25;
float reliefSun(vec3 l) {
  float sinE = dot(l, gRelN);
  if (sinE <= 0.0) return 1.0;   // the envelope faces away: the shadow map and n.l have it
  sinE = max(sinE, RELIEF_COS_MIN);
  float cosE = max(sqrt(1.0 - sinE * sinE), RELIEF_SIN_MIN);
  float L = min(gRelD / sinE, RELIEF_PATH_MAX);
  if (L * cosE < RELIEF_SUN_PX_MIN * gRelFp) return 1.0;
  float step = max(gRelFp * RELIEF_PX_STEP, RELIEF_SUN_STEP_PER_FEATURE * reliefFeature(gRelId)) / cosE;
  int n = clamp(int(ceil(L / step)), 1, RELIEF_SUN_STEPS_MAX);
  float dt = max(step, L / float(RELIEF_SUN_STEPS_MAX));   // (whole steps, as the eye's march)
  float vis = 1.0, jit = 1.0 - ign(gl_FragCoord.xy, float(uFrame));   // in (0, 1]
  for (int i = 1; i <= RELIEF_SUN_STEPS_MAX; i++) {
    if (i > n) break;
    // (no nearer than a pixel along the surface: the root's own error is about that)
    float ts = clamp(dt * (float(i - 1) + jit), RELIEF_SUN_PX_MIN * gRelFp / cosE, L);
    vec3 p = gRelP + l * ts;
    float phi = surfChannel(p, gRelCh);
    if (phi < SURF_ISO) break;   // out of the envelope: past the relief
    // the ray's height above the carved surface under it
    float d = reliefDepth(phi);
    float clear = gRelOff - (d - reliefCarve(p, d));
    vis = min(vis, clamp(0.5 + 0.5 * clear / (ts * SUN_TAN_RADIUS), 0.0, 1.0));
    if (vis <= 0.0) break;
  }
  return vis;
}

// (read by shadeSurf for the hit reliefHit set)
float reliefSunVis() { return gRelOn ? gRelSun : 1.0; }

// The ray (ro, rd) enters smooth channel ch's surface at t. Moves t onto the
// carved surface and returns true, or, if the ray passes through the shell
// without meeting it, moves t to where it leaves and returns false (the
// caller restarts its march there: the ray may come back in at once).
bool reliefHit(vec3 ro, vec3 rd, int ch, inout float t) {
  gRelOn = false;
  vec3 p0 = ro + rd * t;
  // the dominant element around the hit (as gatherSurf weighs the cells)
  vec3 q = p0 - 0.5;
  ivec3 c0 = ivec3(floor(q));
  vec3 f = q - vec3(c0);
  int id1 = E_EMPTY, id2 = E_EMPTY;
  float w1 = 0.0, w2 = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    ivec3 c = c0 + o;
    if (outside(c)) continue;
    int id = eid(fetchA(c));
    if (SURFCH[id] != ch) continue;
    vec3 wv = mix(1.0 - f, f, vec3(o));
    float w = wv.x * wv.y * wv.z;
    if (id1 == E_EMPTY || id == id1) { id1 = id; w1 += w; }
    else { if (id2 == E_EMPTY || id == id2) { id2 = id; w2 += w; } }
  }
  if (w2 > w1) { id1 = id2; float tw = w1; w1 = w2; w2 = tw; }
  float top = reliefTop(id1);
  if (top <= 0.0) return true;
  float fp = footprint(p0);
  float w = smoothstep(RELIEF_PX_LO, RELIEF_PX_HI, top / fp)
          * smoothstep(RELIEF_SHARE_LO, RELIEF_SHARE_HI, w1 / max(w1 + w2, 1e-6));
  if (w <= 0.0) return true;
  // the envelope's normal and slope (tetrahedral difference, as surfNormal)
  const vec2 k = vec2(1.0, -1.0);
  vec3 gr = k.xyy * surfChannel(p0 + k.xyy * NORMAL_STEP, ch) + k.yyx * surfChannel(p0 + k.yyx * NORMAL_STEP, ch)
          + k.yxy * surfChannel(p0 + k.yxy * NORMAL_STEP, ch) + k.xxx * surfChannel(p0 + k.xxx * NORMAL_STEP, ch);
  float gl = length(gr);
  if (gl < 1e-5) return true;
  // the tetrahedron's four taps sum to 4 h ∇φ
  gRelId = id1; gRelCh = ch; gRelW = w; gRelTop = top;
  gRelN = -gr / gl;
  gRelSlope = max(gl / (4.0 * NORMAL_STEP), RELIEF_SLOPE_MIN);
  float cosV = max(-dot(rd, gRelN), RELIEF_COS_MIN);
  float sinV = max(sqrt(1.0 - cosV * cosV), RELIEF_SIN_MIN);
  // A pixel's footprint on the surface stretches by 1 / cos along the ray: the
  // relief is filtered (its octaves faded) by that, so at grazing angles only
  // what spans pixels there is left, not a speckle of sub-pixel peaks.
  gRelFp = fp / cosV;
  float L = min(w * top * RELIEF_SPAN / cosV, RELIEF_PATH_MAX);
  float step = max(gRelFp * RELIEF_PX_STEP, RELIEF_STEP_PER_FEATURE * reliefFeature(id1)) / sinV;
  int n = clamp(int(ceil(L / step)), RELIEF_STEPS_MIN, RELIEF_STEPS_MAX);
  // samples at whole steps (where they fall doesn't jump from pixel to pixel
  // with the step count), stretched only where the count runs out
  float dt = max(step, L / float(RELIEF_STEPS_MAX));
  // ia, ib: how far inside the carved surface (depth - carve, >= 0: solid)
  // the ends of the bracket [ta, tb] are; ca, cb: the carving there; da, db:
  // their depth
  // gb: the height's gradient at the solid end
  vec3 gb;
  float cb = reliefCarve(p0, 0.0, gb);
  float ta = 0.0, tb = 0.0, ia = -cb, ib = -cb, ca = cb, da = 0.0, db = 0.0;
  bool hit = ib >= 0.0, wasIn = false;
  // the whole path: a grazing ray may leave the envelope and come back in
  for (int i = 1; i <= RELIEF_STEPS_MAX; i++) {
    if (hit || i > n) break;
    float ts = min(dt * float(i), L);
    vec3 p = p0 + rd * ts;
    float phi = surfChannel(p, ch);
    // in the envelope and out again: it went through a groove
    if (phi < SURF_ISO && wasIn) { t += ts; return false; }
    wasIn = wasIn || phi >= SURF_ISO;
    ta = tb; ia = ib; ca = cb; da = db;
    db = reliefDepth(phi);
    cb = reliefCarve(p, db, gb);
    tb = ts; ib = db - cb;
    hit = ib >= 0.0;
  }
  // Never in the envelope: the tracer's crossing was a grazing touch at a
  // silhouette, or its root fell short of the surface. Either way the ray is
  // outside here: go on from the end of the path, where the march finds the
  // surface again if it is ahead. (Keeping the hit drew the uncarved
  // silhouette as a fringe of envelope above the carved one.)
  if (!hit && !wasIn) { t += L; return false; }
  // else deeper than any crevice (or the path cut): solid by then
  // gRelOff: how far inside the carved surface the hit itself is (the root's
  // error, or the cut path's shortfall), so the sun test measures clearance
  // from the surface, not from the point
  float th = tb, dh = db;
  gRelD = cb; gRelOff = ib;
  if (hit && tb > 0.0) {
    for (int i = 0; i < RELIEF_REFINE; i++) {
      float tm = mix(ta, tb, clamp(ia / (ia - ib), RELIEF_SPLIT_LO, RELIEF_SPLIT_HI));
      vec3 p = p0 + rd * tm;
      vec3 gm;
      float dm = reliefDepth(surfChannel(p, ch)), cm = reliefCarve(p, dm, gm), im = dm - cm;
      if (im >= 0.0) { tb = tm; ib = im; cb = cm; db = dm; gb = gm; } else { ta = tm; ia = im; ca = cm; da = dm; }
    }
    float s = clamp(ia / (ia - ib), 0.0, 1.0);
    th = mix(ta, tb, s);
    dh = mix(da, db, s);
    gRelD = mix(ca, cb, s);
    gRelOff = mix(ia, ib, s);
  }
  t += th;
  gRelP = p0 + rd * th;
  gRelQ = gRelP + gRelN * dh;   // where its texture is read (gatherSurf)
  gRelOn = true;
  // Its sunlight past the relief, here, where the hit is known to be carved
  // (shadeSurf is called from many places; this keeps one copy of the march
  // in the program). Only where the sun can light it: the bumped normal (the
  // tilt applyMat gives it) faces the sun, or wraps light past the terminator.
  vec3 nb = normalize(gRelN - (gb - gRelN * dot(gRelN, gb)));
  gRelSun = dot(nb, uSun) + SSS[id1] > 0.0 ? reliefSun(uSun) : 1.0;
  return true;
}

// Sky (and ambient) seen from the carved hit, from its depth d below the
// envelope in a crevice of width W: from the floor of a long slot the sky is
// the opening's angle, a view factor of 1 / sqrt(1 + (2 d / W)^2) (as deep
// as it is wide: 0.45, about half). d carries the fade-in w, so far away
// (w = 0) nothing changes. W is the relief's typical crevice: half the
// wavelength of its main octave, or a bark furrow rim to rim.
const float RELIEF_CREVICE_PER_WAVE = 0.5;
float reliefWidth(int id) {
  if (id == E_SAND) return RELIEF_CREVICE_PER_WAVE * SAND_SLUMP_M / CELL_M;
  if (id == E_SNOW) return RELIEF_CREVICE_PER_WAVE * SNOW_DRIFT_M / CELL_M;
  if (id == E_GUNPOWDER) return RELIEF_CREVICE_PER_WAVE * POWDER_LUMP_M / CELL_M;
  if (id == E_ASH) return RELIEF_CREVICE_PER_WAVE * ASH_LUMP_M / CELL_M;
  if (SURF[id] == SURF_CRAG) return RELIEF_CREVICE_PER_WAVE * ROCK_CRAG_M / CELL_M;
  return 2.0 * WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow, rim to rim (half-width x 2)
}
// (and clears the hit: it is read once, by the shadeSurf of the hit that set it)
float reliefSkyVis() {
  if (!gRelOn) return 1.0;
  gRelOn = false;
  float r = 2.0 * gRelD / reliefWidth(gRelId);
  return inversesqrt(1.0 + r * r);
}
#endif
`;
