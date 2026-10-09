// Surface relief up close (gfx/detail.js: DETAIL_RELIEF).
//
// The smooth solids (powders, wood, rock) are the 0.5 isosurface of blurred
// occupancy, so up close they are smooth blobs whose texture is only a bump
// map. With relief on, where the relief's height spans pixels, the tracer
// carves that surface by the material's own mid-scale height field
// (reliefHeight in gfx/surface.js, the same one the bump uses): crags,
// clumps and bark furrows get real silhouettes, occlude each other and shift
// with parallax.
//
// The blurred surface is the envelope: relief only ever carves into it, never
// adds matter outside it. Below the envelope at depth d (cells) a point is
// solid if d >= carve = w * clamp(top - h, 0, RELIEF_SPAN * top), where h is
// the height, top its usual high point (heights above it are the envelope's
// flat tops) and w the fade-in. So the tracer's own hit is where the ray
// enters the shell; from there it marches through the shell to the carved
// surface, or out the other side (a groove at a silhouette: the ray goes on).
// d comes from the field: (φ - 0.5) / |∇φ|, with |∇φ| taken at the entry.
//
// w fades the geometry in by the relief's size in pixels (and out at borders
// between materials), so nothing pops and distant views are unchanged. The
// shading normal is already the bump of the same height, i.e. the carved
// surface's normal: it is not bumped again. Lighting lookups (shadow map,
// AO, probes) stay those of the envelope; the shadow map's bias (≥ 0.8
// cells) covers the carving, so carved points don't self-shadow from it.
// What the envelope's lighting can't see is how far down a crevice the hit
// is: reliefSkyVis darkens the cavity term (ambient and sky) by that.
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
// The march through the shell: one sample per RELIEF_PX_STEP pixels of path,
// but no finer than RELIEF_STEP_PER_FEATURE of the relief's finest feature
// (reliefFeature), RELIEF_STEPS_MIN..MAX of them, then RELIEF_BISECT halvings
// of the step that crossed. A grazing ray's path is cut at RELIEF_PATH_MAX
// (cells), its cosine to the surface floored at RELIEF_COS_MIN.
const float RELIEF_PX_STEP = 2.0;
const float RELIEF_STEP_PER_FEATURE = 0.25;
const int RELIEF_STEPS_MIN = 4, RELIEF_STEPS_MAX = 16;
const int RELIEF_BISECT = 3;
const float RELIEF_PATH_MAX = 1.5;
const float RELIEF_COS_MIN = 0.12;
const float RELIEF_SLOPE_MIN = 0.05;   // floor on |∇φ| (per cell) when converting φ to depth
// The high point 'top' of each element's height (cells): a high quantile of
// it. fBm heights (mFbmD) are ±0.45 at most and mostly within ±0.3 units.
const float RELIEF_FBM_TOP = 0.3;
const float RELIEF_CRAG_TOP = 0.5;     // rock crags, in units of ROCK_CRAG_H (rockCrags: ~±0.9)
float reliefTop(int id) {
  if (id == E_SAND) return (SAND_SLUMP_H + SAND_CLUMP_H) * RELIEF_FBM_TOP;
  if (id == E_SNOW) return (SNOW_DRIFT_H + SNOW_CLUMP_H) * RELIEF_FBM_TOP;
  if (id == E_GUNPOWDER) return POWDER_LUMP_H * RELIEF_FBM_TOP;
  if (id == E_ASH) return ASH_LUMP_H * RELIEF_FBM_TOP;
  if (id == E_ROCK) return ROCK_CRAG_H * RELIEF_CRAG_TOP;
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
  if (id == E_ROCK) return 1.0 / (ROCK_CRAG_F * ROCK_CRAG_LAC * ROCK_CRAG_LAC);
  return WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow's half-width
}

// The relief being traced (set by reliefHit, read by reliefSkyVis)
bool gRelOn = false;
int gRelId, gRelCh;
float gRelW, gRelTop, gRelSlope, gRelFp;
vec3 gRelN;

// How deep the relief is carved below the envelope at p (cells)
float reliefCarve(vec3 p) {
  float h = reliefHeight(gRelId, p, gRelN, gRelFp).x;
  return gRelW * clamp(gRelTop - h, 0.0, RELIEF_SPAN * gRelTop);
}
// How far p, where the field is phi, is inside the carved surface (cells; >= 0: solid).
float reliefInside(vec3 p, float phi) { return (phi - SURF_ISO) / gRelSlope - reliefCarve(p); }
float reliefInside(vec3 p) { return reliefInside(p, surfChannel(p, gRelCh)); }

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
    int id = eid(cellA(c));
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
  // A pixel's footprint on the surface stretches by 1 / cos along the ray: the
  // relief is filtered (its octaves faded) by that, so at grazing angles only
  // what spans pixels there is left, not a speckle of sub-pixel peaks.
  gRelFp = fp / cosV;
  float L = min(w * top * RELIEF_SPAN / cosV, RELIEF_PATH_MAX);
  float step = max(gRelFp * RELIEF_PX_STEP, RELIEF_STEP_PER_FEATURE * reliefFeature(id1));
  int n = clamp(int(ceil(L / step)), RELIEF_STEPS_MIN, RELIEF_STEPS_MAX);
  float dt = L / float(n);
  float ta = 0.0, tb = L;
  bool hit = false, wasIn = false;
  float phi = SURF_ISO;
  // the whole path: a grazing ray may leave the envelope and come back in
  for (int i = 1; i <= RELIEF_STEPS_MAX; i++) {
    if (i > n) break;
    float ts = dt * float(i);
    vec3 p = p0 + rd * ts;
    phi = surfChannel(p, ch);
    // in the envelope and out again: it went through a groove
    if (phi < SURF_ISO && wasIn) { t += ts; return false; }
    wasIn = wasIn || phi >= SURF_ISO;
    if (reliefInside(p, phi) >= 0.0) { tb = ts; hit = true; break; }
    ta = ts;
  }
  // Never in the envelope: the tracer's crossing was a grazing touch at a
  // silhouette, or its root fell short of the surface. Either way the ray is
  // outside here: go on from the end of the path, where the march finds the
  // surface again if it is ahead. (Keeping the hit drew the uncarved
  // silhouette as a fringe of envelope above the carved one.)
  if (!hit && !wasIn) { t += L; return false; }
  // else deeper than any crevice (or the path cut): solid by then
  if (hit) {
    for (int i = 0; i < RELIEF_BISECT; i++) {
      float tm = 0.5 * (ta + tb);
      if (reliefInside(p0 + rd * tm) >= 0.0) tb = tm; else ta = tm;
    }
  }
  t += tb;
  gRelOn = true;
  return true;
}

// Sky (and ambient) seen from the carved hit p, from its depth d below the
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
  if (id == E_ROCK) return RELIEF_CREVICE_PER_WAVE * ROCK_CRAG_M / CELL_M;
  return 2.0 * WOOD_FUR_W / WOOD_PLATE_FH;   // wood: a furrow, rim to rim (half-width x 2)
}
float reliefSkyVis(vec3 p) {
  if (!gRelOn) return 1.0;
  gRelOn = false;   // once, for the hit that set it
  float r = 2.0 * reliefCarve(p) / reliefWidth(gRelId);
  return inversesqrt(1.0 + r * r);
}
#endif
`;
