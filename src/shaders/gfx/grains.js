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
// Hooks in render.js: grainEvent per cell of the realistic march, the
// EV_GRAIN event (shaded after the march by grainShade), and grainResolve.
export const grainsGLSL = /* glsl */ `
#ifdef GRAINS_ANY
#define EV_GRAIN 4   // tracer event (render.js EV_*): the ray hit a grain

// What the ray is committed to (see grainEvent).
#define GM_OPEN 0    // nothing yet
#define GM_GEOM 1    // geometry: the smooth surface it replaces is skipped
#define GM_TEX 2     // the textured smooth surface: no more geometry

// gHitK: what was hit
#define GK_VOID -1   // the dark depth between pebbles (the ray went too deep)
#define GK_PEBBLE -2 // a pebble (gHitA = its site)
#define GK_CLOD 0    // a clod (gHitA = its cell)

// ---- pebbles (gravel cells) ----
const int PEB_N = int(PEBBLE_F + 0.5);    // pebble sites per cell along a line
const float PEB_Q = 1.0 / float(PEB_N);   // site pitch, cells
// in site pitches:
const float PEB_P = 0.88;                 // share of sites holding a pebble
const float PEB_R_MIN = 0.4, PEB_R_VAR = 0.2;    // longest semi-axis of the box
const float PEB_CORNER = 1.3;             // the corner-cutting ellipsoid, as a multiple of the box's semi-axes
const float PEB_JITTER = 0.2;             // centre's reach from the site's middle (each axis)
// (a chip reaches at most PEB_CORNER · (PEB_R_MIN + PEB_R_VAR) <= 1 -
// PEB_JITTER from its centre, so any point of it lies in the 2×2×2 sites
// nearest that point: the walk only tests those)
// semi-axes as shares of the longest (broken rock: blocky to slabby)
const float PEB_MID_MIN = 0.6, PEB_FLAT_MIN = 0.35, PEB_FLAT_MAX = 0.85;
const float PEB_CLUMP_R = 0.45;           // a lone gravel cell: pebbles within this of its middle (cells)
// An empty cell inside the smooth surface holds pebbles of the gravel cell
// next to it, looked for in this order (below first: they slumped there).
// A site of an empty cell whose middle's field is under this share of the
// surface level can't hold a pebble (its jittered centre is inside the
// surface only where the field is near it): skips the neighbour search.
const float PEB_FILL_PRECHECK = 0.6;
const ivec3 PEB_FILL_DIRS[6] = ivec3[6](ivec3(0, -1, 0), ivec3(1, 0, 0), ivec3(-1, 0, 0), ivec3(0, 0, 1), ivec3(0, 0, -1), ivec3(0, 1, 0));

// ---- clods (lone powder cells) ----
const int CLOD_LOBES = 4;                 // a core and its lumps
const float CLOD_CORE_R = 0.27, CLOD_CORE_VAR = 0.05;   // core's longest semi-axis, cells
const float CLOD_LUMP_R = 0.17, CLOD_LUMP_VAR = 0.06;   // lump's longest semi-axis, cells
const float CLOD_LUMP_OFF = 0.1, CLOD_LUMP_OFF_VAR = 0.08;   // lump's distance from the middle, cells (they overlap the core)
const float CLOD_REST_SQUASH = 0.6;       // a resting clod's lobes keep this share of their height over the floor
const float CLOD_BLEND = 0.12;            // smooth-minimum width blending the lobes into one body, cells
// Roughness: noise displacement of the surface (frequency per cell, amplitude cells), two octaves.
const float CLOD_BUMP_F = 4.5, CLOD_BUMP = 0.035;
const float CLOD_GRIT_F = 12.0, CLOD_GRIT = 0.01;
const float SMIN_BULGE = 0.25;            // the smooth minimum swells the union by at most this share of its width
const float CLOD_MARGIN = CLOD_BUMP + CLOD_GRIT + SMIN_BULGE * CLOD_BLEND;   // the lobes keep this far inside the cell (cells)
// Per element: shortest/longest semi-axis of a lobe (clods are flattish crumbs).
const float CLOD_FLAT_SAND = 0.6, CLOD_FLAT_SNOW = 0.7, CLOD_FLAT_GUNPOWDER = 0.6;
const float CLOD_FLAT_ASH = 0.4, CLOD_FLAT_STONE = 0.6;
// Sphere tracing: steps, step shrink (the noise steepens the field past a true
// distance), hit tolerance (share of a pixel), normal stencil (cells, at least).
const int CLOD_STEPS = 48;
const float CLOD_STEP_K = 0.6, CLOD_HIT_PX = 0.5, CLOD_NORMAL_H = 2e-3;

// ---- hand-off by footprint ----
// Geometry starts where a feature is *_PX_NONE pixels across and has taken
// over by *_PX_FULL (feature: a pebble; a clod's lump).
const float PEB_PX_NONE = 8.0, PEB_PX_FULL = 16.0;
const float CLOD_PX_NONE = 8.0, CLOD_PX_FULL = 16.0;
const float PEB_D = PEBBLE_M / CELL_M;            // a pebble's size, cells
const float CLOD_D = 2.0 * CLOD_LUMP_R;           // a lump's size, cells
const float PEB_FP_NONE = PEB_D / PEB_PX_NONE, PEB_FP_FULL = PEB_D / PEB_PX_FULL;   // cells per pixel
const float CLOD_FP_NONE = CLOD_D / CLOD_PX_NONE, CLOD_FP_FULL = CLOD_D / CLOD_PX_FULL;

// ---- bounds on the work per ray ----
const int PEB_MAX_STEPS = 24;             // sub-lattice steps (8 sites each) per ray; then it is in the dark between them
const int PEB_SUN_STEPS = 8;              // sub-lattice steps toward the sun tested for pebble shadows
const int CLOD_MAX_CELLS = 4;             // lone cells tested per ray

// ---- shading ----
const float GRAIN_TEX_SPREAD = 61.0;      // cells of texture space the hash spreads pebbles and clods over
const float PEB_AO_R = 0.8;               // a neighbour occludes like a ball this share of its longest semi-axis
const float PEB_AO_GAIN = 0.6;            // contact occlusion: darkening per unit of summed ball occlusion ...
const float PEB_AO_MAX = 0.85;            // ... at most this much
const float GRAIN_NUDGE = 1e-3;           // cells off a surface where its sun ray starts
const float DUAL_NUDGE = 1e-4;            // sub-lattice units past the start of a walk
const float TWO_PI_G = 6.2831853;
const uint GRAIN_SALT = 0x9e3779b9u;      // golden-ratio odd constant: spreads site / lobe indices apart in the hash

float u01(inout uint h) { h = pcg(h); return float(h) * UINT_TO_UNIT; }

// ---- which cells hold geometry ----
bool isPebbles(int id) {
#ifdef DETAIL_GRAINS
  return id == E_STONE;
#else
  return false;
#endif
}
bool grainElement(int id) {
  if (isPebbles(id)) return true;
#ifdef DETAIL_GRAIN_CLUSTERS
  if (SURFCH[id] == CH_GRANULAR) return true;
#endif
  return false;
}
bool granularAt(ivec3 c) { return !outside(c) && SURFCH[eid(fetchA(c))] == CH_GRANULAR; }
// no granular face neighbour
bool loneCell(ivec3 c) {
  return !granularAt(c + ivec3(1, 0, 0)) && !granularAt(c - ivec3(1, 0, 0)) && !granularAt(c + ivec3(0, 1, 0))
      && !granularAt(c - ivec3(0, 1, 0)) && !granularAt(c + ivec3(0, 0, 1)) && !granularAt(c - ivec3(0, 0, 1));
}
// pebbles: every gravel cell; clods: only a lone cell
bool grainCellOk(ivec3 c, int id) { return isPebbles(id) || loneCell(c); }
// a lone cell resting on something
bool grainResting(ivec3 c) {
  if (c.y == 0) return true;
  int b = eid(fetchA(c - ivec3(0, 1, 0)));
  return b != E_EMPTY && KIND[b] != K_GAS;
}

// Weight of the geometry (vs the texture) at footprint fp.
float grainW(int id, float fp) {
  return isPebbles(id) ? 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp) : 1.0 - smoothstep(CLOD_FP_FULL, CLOD_FP_NONE, fp);
}
float grainWMax(float fp) {
  float w = 0.0;
#ifdef DETAIL_GRAINS
  w = 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp);
#endif
#ifdef DETAIL_GRAIN_CLUSTERS
  w = max(w, 1.0 - smoothstep(CLOD_FP_FULL, CLOD_FP_NONE, fp));
#endif
  return w;
}

// A uniformly random turn (Shoemake's quaternion), as axes (columns).
mat3 randomTurn(inout uint h) {
  float q1 = u01(h); float q2 = TWO_PI_G * u01(h); float q3 = TWO_PI_G * u01(h);
  vec4 q = vec4(sqrt(1.0 - q1) * vec2(sin(q2), cos(q2)), sqrt(q1) * vec2(sin(q3), cos(q3)));
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
              2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
              2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

// Normal of the ellipsoid (centre c, semi-axes s along the columns of R) at p.
vec3 ellNormal(vec3 p, vec3 c, vec3 s, mat3 R) { return normalize(R * ((transpose(R) * (p - c)) / (s * s))); }
// Ray vs a chip: the box of semi-axes s (turned by R) cut by the ellipsoid of
// semi-axes PEB_CORNER · s. Both are convex, so the ray is inside the chip from
// the later of the two entries to the earlier of the two exits.
float chipHit(vec3 ro, vec3 rd, vec3 c, vec3 s, mat3 R) {
  mat3 Rt = transpose(R);
  vec3 o = Rt * (ro - c), d = Rt * rd;
  vec3 inv = 1.0 / d;
  vec3 ta = (-s - o) * inv, tb = (s - o) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  float t0 = max(max(tn.x, tn.y), tn.z), t1 = min(min(tf.x, tf.y), tf.z);
  vec3 se = s * PEB_CORNER;
  vec3 oe = o / se, de = d / se;
  float a = dot(de, de), b = dot(oe, de), k = dot(oe, oe) - 1.0;
  float h = b * b - a * k;
  if (h < 0.0) return NO_HIT;
  h = sqrt(h);
  t0 = max(t0, (-b - h) / a); t1 = min(t1, (-b + h) / a);
  return t0 <= t1 ? t0 : NO_HIT;
}
// Normal of a chip at p on its surface: the box face it is on, or the cut corner.
vec3 chipNormal(vec3 p, vec3 c, vec3 s, mat3 R) {
  vec3 q = transpose(R) * (p - c);
  vec3 b = abs(q) / s;
  float box = max(max(b.x, b.y), b.z);
  if (length(q / (s * PEB_CORNER)) > box) return ellNormal(p, c, s * PEB_CORNER, R);
  vec3 f = b.x >= box ? vec3(sign(q.x), 0.0, 0.0) : (b.y >= box ? vec3(0.0, sign(q.y), 0.0) : vec3(0.0, 0.0, sign(q.z)));
  return R * f;
}
// does the ray (rd unit length) come within r of c somewhere in [tMin, tBest)?
bool ballNear(vec3 ro, vec3 rd, vec3 c, float r, float tMin, float tBest) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + r * r;
  if (h < 0.0) return false;
  h = sqrt(h);
  return -b - h < tBest && -b + h >= tMin;
}

// ---- pebbles ----
// The pebble at site s of its cell (state a; trimmed to a round clump if the
// cell is lone): false if the site is empty, else its centre c (grid units)
// and longest semi-axis r. h carries on to pebbleShape.
// (cell: the cell the site is in; a: its owner's state, the cell itself or,
// filling an empty cell, its gravel neighbour PEB_FILL_DIRS[fill - 1])
bool pebbleAt(ivec3 s, ivec3 cell, vec4 a, bool lone, int fill, out vec3 c, out float r, out uint h) {
  ivec3 l = s - cell * PEB_N;
  h = pcg(floatBitsToUint(fract(a.w)) ^ (uint(1 + l.x + PEB_N * (l.y + PEB_N * (l.z + PEB_N * fill))) * GRAIN_SALT));
  float pr = u01(h);
  r = PEB_Q * (PEB_R_MIN + PEB_R_VAR * u01(h));
  float jx = u01(h); float jy = u01(h); float jz = u01(h);
  c = (vec3(s) + 0.5 + (2.0 * vec3(jx, jy, jz) - 1.0) * PEB_JITTER) * PEB_Q;
  // (Pebbles may straddle their cell's faces: the walk tests them from both
  // sides; where they would poke into open air the smooth surface below has
  // already left them out.)
  if (pr >= PEB_P) return false;
  if (lone) return distance(c, vec3(cell) + 0.5) + r < PEB_CLUMP_R;   // a round clump inside its cell
  return surfField(c)[CH_GRANULAR] >= SURF_ISO;   // the heap's smooth shape
}
void pebbleShape(float r, inout uint h, out vec3 sa, out mat3 R) {
  float u1 = u01(h); float u2 = u01(h);
  sa = r * vec3(1.0, mix(PEB_MID_MIN, 1.0, u1), mix(PEB_FLAT_MIN, PEB_FLAT_MAX, u2));
  R = randomTurn(h);
}

// The gravel cell an empty cell borrows pebbles from (fill = 1 + its index in
// PEB_FILL_DIRS), or fill = 0 if none.
int pebbleFill(ivec3 cell, out vec4 a) {
  a = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    ivec3 c = cell + PEB_FILL_DIRS[i];
    if (outside(c)) continue;
    a = fetchA(c);
    if (eid(a) == E_STONE) return i + 1;
  }
  return 0;
}

// The first pebble the ray hits in [t0, t1] (its stretch through cell 'cell',
// gravel or an empty cell borrowing pebbles), NO_HIT if none; sHit = its
// site. Walks the dual sub-lattice (whose corners are the sites) and tests the
// sites at each step's corners: the cell's own and those of gravel next door
// reaching in. steps counts the walk against PEB_MAX_STEPS; tStop = where it
// ran out (a dual-lattice plane, half a site off every cell face).
float pebblesHit(ivec3 cell, vec4 a, bool lone, int fill, vec3 ro, vec3 rd, float t0, float t1,
                 inout int steps, out ivec3 sHit, out float tStop) {
  sHit = ivec3(-1);
  tStop = t0;
  float N = float(PEB_N);
  vec3 o2 = ro * N - 0.5, d2 = rd * N;   // dual cell k spans sites k .. k + 1
  ivec3 dc = ivec3(floor(o2 + d2 * t0 + sign(d2) * DUAL_NUDGE));
  ivec3 istp = ivec3(sign(d2));
  vec3 tDelta = abs(1.0 / d2);
  vec3 tMax = (vec3(dc) + step(0.0, d2) - o2) / d2;
  float best = NO_HIT;
  for (int i = 0; i < PEB_MAX_STEPS; i++) {
    if (steps >= PEB_MAX_STEPS) break;
    steps++;
    float tb = min(min(tMax.x, tMax.y), tMax.z);
    for (int k = 0; k < 8; k++) {
      ivec3 s = dc + ivec3(k & 1, (k >> 1) & 1, k >> 2);
      ivec3 own = ivec3(floor((vec3(s) + 0.5) * PEB_Q));
      vec3 c; float r; uint h;
      if (own == cell) {
        if (!pebbleAt(s, cell, a, lone, fill, c, r, h)) continue;
      } else {
        // a neighbour's pebble reaching in: gravel's own, or one an empty cell borrowed
        if (outside(own)) continue;
        vec4 an = fetchA(own);
        int idn = eid(an);
        if (idn == E_STONE) {
          if (!pebbleAt(s, own, an, false, 0, c, r, h)) continue;
        } else if (idn == E_EMPTY) {
          if (surfField((vec3(s) + 0.5) * PEB_Q)[CH_GRANULAR] < SURF_ISO * PEB_FILL_PRECHECK) continue;   // (cheap: clearly outside)
          vec4 af;
          int fl = pebbleFill(own, af);
          if (fl == 0 || !pebbleAt(s, own, af, false, fl, c, r, h)) continue;
        } else continue;
      }
      if (!ballNear(ro, rd, c, PEB_CORNER * r, t0, best)) continue;
      vec3 sa; mat3 R;
      pebbleShape(r, h, sa, R);
      float t = chipHit(ro, rd, c, sa, R);
      if (t >= t0 && t < best) { best = t; sHit = s; }
    }
    if (best <= tb || tb >= t1) break;   // nothing nearer can come later
    tStop = tb;
    int ax = argmin3(tMax);
    dc[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return best <= t1 + PEB_Q ? best : NO_HIT;   // (a pebble straddling the exit face counts)
}

// ---- clods ----
float clodFlat(int id) {
  return id == E_SAND ? CLOD_FLAT_SAND : (id == E_SNOW ? CLOD_FLAT_SNOW : (id == E_GUNPOWDER ? CLOD_FLAT_GUNPOWDER
       : (id == E_ASH ? CLOD_FLAT_ASH : CLOD_FLAT_STONE)));
}
// The clod of a lone cell: its lobes (centre, semi-axes, inverse turn) and a
// texture-space offset for its roughness, all from the cell's seed.
void clodBuild(ivec3 cell, int id, vec4 a, out vec3 C[CLOD_LOBES], out vec3 S[CLOD_LOBES], out mat3 RT[CLOD_LOBES], out vec3 off) {
  bool resting = grainResting(cell);
  float fl = clodFlat(id);
  uint h0 = pcg(floatBitsToUint(fract(a.w)));
  float ox = u01(h0); float oy = u01(h0); float oz = u01(h0);
  off = vec3(ox, oy, oz) * GRAIN_TEX_SPREAD;
  for (int k = 0; k < CLOD_LOBES; k++) {
    uint h = pcg(floatBitsToUint(fract(a.w)) ^ (uint(k + 1) * GRAIN_SALT));
    float r;
    vec3 o = vec3(0.0);
    if (k == 0) r = CLOD_CORE_R + CLOD_CORE_VAR * u01(h);
    else {
      r = CLOD_LUMP_R + CLOD_LUMP_VAR * u01(h);
      float z = 2.0 * u01(h) - 1.0; float ph = TWO_PI_G * u01(h);
      float dist = CLOD_LUMP_OFF + CLOD_LUMP_OFF_VAR * u01(h);
      float rz = sqrt(max(1.0 - z * z, 0.0));
      o = dist * vec3(rz * cos(ph), z, rz * sin(ph));
    }
    float u1 = u01(h);
    S[k] = r * vec3(1.0, mix(fl, 1.0, u1), fl);
    RT[k] = transpose(randomTurn(h));
    vec3 lc = 0.5 + o;
    float m = r + CLOD_MARGIN;
    if (resting) lc.y = m + (lc.y - m) * CLOD_REST_SQUASH;   // slumped onto what it rests on
    C[k] = vec3(cell) + clamp(lc, vec3(m), vec3(1.0 - m));
  }
}
// ellipsoid distance bound (Quilez): q in the ellipsoid's frame, semi-axes s
float sdEll(vec3 q, vec3 s) {
  float k0 = length(q / s), k1 = length(q / (s * s));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float clodSDF(vec3 p, vec3 C[CLOD_LOBES], vec3 S[CLOD_LOBES], mat3 RT[CLOD_LOBES], vec3 off, ivec3 cell) {
  float d = sdEll(RT[0] * (p - C[0]), S[0]);
  for (int k = 1; k < CLOD_LOBES; k++) d = sminP(d, sdEll(RT[k] * (p - C[k]), S[k]), CLOD_BLEND);
  vec3 q = M_ROT * (p - vec3(cell) + off);
  return d + CLOD_BUMP * (2.0 * vnoise(q * CLOD_BUMP_F) - 1.0) + CLOD_GRIT * (2.0 * vnoise(q * CLOD_GRIT_F) - 1.0);
}
// First hit of the clod in a lone cell along [t0, t1], NO_HIT if none.
float clodHit(ivec3 cell, int id, vec4 a, vec3 ro, vec3 rd, float t0, float t1) {
  vec3 C[CLOD_LOBES], S[CLOD_LOBES]; mat3 RT[CLOD_LOBES]; vec3 off;
  clodBuild(cell, id, a, C, S, RT, off);
  float t = t0;
  for (int i = 0; i < CLOD_STEPS; i++) {
    if (t > t1) break;
    vec3 p = ro + rd * t;
    float d = clodSDF(p, C, S, RT, off, cell);
    if (d < CLOD_HIT_PX * footprint(p)) return t;
    t += max(d * CLOD_STEP_K, CLOD_HIT_PX * footprint(p));
  }
  return NO_HIT;
}
vec3 clodNormal(vec3 p, ivec3 cell, int id, vec4 a) {
  vec3 C[CLOD_LOBES], S[CLOD_LOBES]; mat3 RT[CLOD_LOBES]; vec3 off;
  clodBuild(cell, id, a, C, S, RT, off);
  float hN = max(CLOD_NORMAL_H, footprint(p));
  const vec2 e = vec2(1.0, -1.0);
  return normalize(e.xyy * clodSDF(p + e.xyy * hN, C, S, RT, off, cell) + e.yyx * clodSDF(p + e.yyx * hN, C, S, RT, off, cell)
                 + e.yxy * clodSDF(p + e.yxy * hN, C, S, RT, off, cell) + e.xxx * clodSDF(p + e.xxx * hN, C, S, RT, off, cell));
}

// ---- the march's state for this pixel (kept small: it stays live across the whole march) ----
int gGrainMode = GM_OPEN;
int gPebSteps = 0;          // sub-lattice steps walked so far
int gClodCells = 0;         // lone cells tested so far
bool gPebInside = false;    // the ray is inside the gravel's smooth surface (it was skipped)
ivec3 gHitA = ivec3(0);     // the EV_GRAIN hit: pebble site, or the clod's cell ...
int gHitK = GK_VOID;        // ... GK_* or the clod's lobe ...
const float GRAIN_NO_P = -1.0;         // (gHitP.x at or below this: no hit)
vec3 gHitP = vec3(GRAIN_NO_P - 1.0);   // ... and where (shaded after the march)
// The path not taken while crossfading in the hand-off band: it ended at gAltP
// (geometry: gAltA, gAltK; else the granular surface) with (col, trans) in
// front of it; gAltW = the geometry's weight there (< 0: none); gAltGeom: the
// stored path is the geometry one.
float gAltW = -1.0;
bool gAltGeom = false;
vec3 gAltCol = vec3(0.0), gAltTrans = vec3(0.0), gAltRd = vec3(0.0), gAltP = vec3(0.0);
ivec3 gAltA = ivec3(0);
int gAltK = GK_VOID;

// The textured granular surface hit at hp: does geometry replace it here?
// True if every granular cell around hp holds geometry (or there are none,
// e.g. the blurred trail of a lone cell that moved on); w = its weight.
bool grainSuppress(vec3 hp, out float w) {
  float fp = footprint(hp);
  w = grainWMax(fp);
  if (w <= 0.0) return false;
  ivec3 c0 = ivec3(floor(hp - 0.5));
  float wMin = 2.0;
  for (int i = 0; i < 8; i++) {
    ivec3 c = c0 + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    if (outside(c)) continue;
    int id = eid(fetchA(c));
    if (SURFCH[id] != CH_GRANULAR) continue;
    if (!grainElement(id) || !grainCellOk(c, id)) return false;
    wMin = min(wMin, grainW(id, fp));
  }
  if (wMin <= 1.0) w = wMin;
  return w > 0.0;
}

// Per cell of the realistic march (render.js), once the segment's event (ev
// at tEv, channel evCh) is known: geometry in this cell may come first (ev
// becomes EV_GRAIN), and the granular surface is skipped where geometry
// replaces it. In the hand-off band the first of the two to be reached is
// stored as the other path (gAlt*) and the ray goes on as the other;
// grainResolve blends them.
void grainEvent(ivec3 cell, int id, vec4 a, vec3 ro, vec3 rd, float tEnter, float tExit,
                vec3 col, vec3 trans, inout int ev, int evCh, inout float tEv,
                inout bool anyHit, inout vec3 hitPos) {
  if (gGrainMode == GM_TEX) return;
  bool isoCand = ev == EV_OPAQUE && evCh == CH_GRANULAR;
  bool cand = grainElement(id);
  bool fillCand = false;
#ifdef DETAIL_GRAINS
  // an empty cell the gravel's smooth surface reaches into
  if (id == E_EMPTY && gPebInside && !isoCand) gPebInside = surfField(ro + rd * tEnter)[CH_GRANULAR] >= SURF_ISO;
  fillCand = id == E_EMPTY && (isoCand || gPebInside);
#endif
  if (!cand && !isoCand && !fillCand) return;
  // 1. this cell's geometry (gated by footprint before any per-cell work)
  float tG = NO_HIT, wG = 0.0;
  int kG = GK_VOID;
  ivec3 aG = cell;
  if (cand) {
    wG = grainW(id, footprint(ro + rd * tEnter));
    if (wG > 0.0) {
      if (isPebbles(id)) {
        if (gPebSteps < PEB_MAX_STEPS) {
          ivec3 s; float tStop;
          tG = pebblesHit(cell, a, loneCell(cell), 0, ro, rd, tEnter, tExit, gPebSteps, s, tStop);
          gPebInside = true;
          if (tG < NO_HIT) { kG = GK_PEBBLE; aG = s; }
          else if (gPebSteps >= PEB_MAX_STEPS) tG = clamp(tStop, tEnter, tExit);   // lost in the dark between the pebbles
        }
      } else if (gClodCells < CLOD_MAX_CELLS && loneCell(cell)) {
        gClodCells++;
        tG = clodHit(cell, id, a, ro, rd, tEnter, tExit);
        kG = GK_CLOD;
      }
    }
  }
  // 2. the granular surface, where geometry replaces it
  float wS;
  float tIn = tEnter;   // where the ray is inside the smooth surface from
  bool supp = false;
  if (isoCand && tG >= tEv && grainSuppress(ro + rd * tEv, wS)) {
    vec3 hp = ro + rd * tEv;
    if (gGrainMode == GM_OPEN && wS < 1.0) {
      gAltW = wS; gAltGeom = false; gAltCol = col; gAltTrans = trans; gAltRd = rd; gAltP = hp;
      if (!anyHit) { anyHit = true; hitPos = hp; }
    }
    gGrainMode = GM_GEOM;
    tIn = tEv;
    ev = EV_NONE; tEv = tExit;
    supp = true;
  }
#ifdef DETAIL_GRAINS
  // 2b. an empty cell inside the gravel's smooth surface: its neighbour's pebbles
  if (fillCand && (supp || gPebInside) && gGrainMode == GM_GEOM && gPebSteps < PEB_MAX_STEPS) {
    vec4 an;
    int fill = pebbleFill(cell, an);
    gPebInside = fill > 0;
    if (fill > 0) {
      ivec3 s; float tStop;
      float t = pebblesHit(cell, an, false, fill, ro, rd, tIn, tExit, gPebSteps, s, tStop);
      if (t < tG) { tG = t; kG = GK_PEBBLE; aG = s; }
      else if (t >= NO_HIT && gPebSteps >= PEB_MAX_STEPS) { tG = clamp(tStop, tIn, tExit); kG = GK_VOID; }
    }
  }
#endif
  // 3. geometry in front of whatever else this segment holds
  if (tG < tEv) {
    if (gGrainMode == GM_OPEN && wG < 1.0) {
      gAltW = wG; gAltGeom = true; gAltCol = col; gAltTrans = trans; gAltRd = rd;
      gAltP = ro + rd * tG; gAltA = aG; gAltK = kG;
      if (!anyHit) { anyHit = true; hitPos = gAltP; }
      gGrainMode = GM_TEX;
    } else {
      gGrainMode = GM_GEOM;
      ev = EV_GRAIN; tEv = tG; gHitA = aG; gHitK = kG;
    }
  }
}

// ---- shading ----
// Occlusion of point p (normal n) by a ball (centre c, radius r), Quilez's
// analytic sphere occlusion.
float ballOcc(vec3 p, vec3 n, vec3 c, float r) {
  vec3 d = c - p;
  float l2 = dot(d, d);
  return max(dot(n, d) * inversesqrt(l2), 0.0) * min(r * r / l2, 1.0);   // (inside the ball: fully)
}

// The pebble at site s, whichever cell owns it: false if none.
bool pebbleOf(ivec3 s, out ivec3 cell, out vec4 a, out vec3 c, out float r, out uint h) {
  cell = ivec3(floor((vec3(s) + 0.5) * PEB_Q));
  a = vec4(0.0); c = vec3(0.0); r = 0.0; h = 0u;
  if (outside(cell)) return false;
  a = fetchA(cell);
  int id = eid(a);
  if (id == E_STONE) return pebbleAt(s, cell, a, loneCell(cell), 0, c, r, h);
  if (id != E_EMPTY) return false;
  int fill = pebbleFill(cell, a);
  return fill > 0 && pebbleAt(s, cell, a, false, fill, c, r, h);
}

// Sun visibility at p on the pebble at site sSelf, past the pebbles between it
// and the sun (the shadow map is far too coarse for them): PEB_SUN_STEPS steps.
float pebbleSunVis(ivec3 sSelf, vec3 p) {
  vec3 rd = safeDir(uSun);
  float N = float(PEB_N);
  vec3 o2 = p * N - 0.5, d2 = rd * N;
  ivec3 dc = ivec3(floor(o2));
  ivec3 istp = ivec3(sign(d2));
  vec3 tDelta = abs(1.0 / d2);
  vec3 tMax = (vec3(dc) + step(0.0, d2) - o2) / d2;
  for (int i = 0; i < PEB_SUN_STEPS; i++) {
    for (int k = 0; k < 8; k++) {
      ivec3 s = dc + ivec3(k & 1, (k >> 1) & 1, k >> 2);
      if (s == sSelf) continue;
      ivec3 cell; vec4 a; vec3 c; float r; uint h;
      if (!pebbleOf(s, cell, a, c, r, h)) continue;
      if (!ballNear(p, rd, c, PEB_CORNER * r, 0.0, NO_HIT)) continue;
      vec3 sa; mat3 R;
      pebbleShape(r, h, sa, R);
      float t = chipHit(p, rd, c, sa, R);
      if (t >= 0.0 && t < NO_HIT) return 0.0;
    }
    int ax = argmin3(tMax);
    dc[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// A material with element id's base values (as matOf starts from).
Mat baseMat(int id) {
  Mat m;
  m.alb = ALBEDO[id]; m.g = vec3(0.0); m.tang = vec3(1.0, 0.0, 0.0); m.sssCol = vec3(1.0);
  m.rough = ROUGH[id]; m.metal = METAL[id];
  m.f0 = (IOR[id] - 1.0) / (IOR[id] + 1.0); m.f0 *= m.f0;
  m.sss = SSS[id]; m.glint = GLINT[id]; m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  m.emit = vec3(0.0);
  return m;
}

// Surface record of the geometry hit at p (site / cell aH, GK_* / lobe k) by a
// ray along rd; sets gGrainSun for its shadeSurf.
Surf grainSurf(ivec3 aH, int k, vec3 p, vec3 rd) {
  Surf s;
  s.p = p; s.tp = p; s.tp1 = p; s.flowW = 0.0;   // glints sample at tp (shadeSurf); grains have one layer
  s.ch = CH_GRANULAR; s.face = ivec3(0, 1, 0);
  float fp = footprint(p);
  gGrainSun = 1.0;
  Mat m;
  if (k == GK_PEBBLE) {
    ivec3 cell; vec4 a; vec3 c; float r; uint h;
    pebbleOf(aH, cell, a, c, r, h);
    vec3 sa; mat3 R;
    pebbleShape(r, h, sa, R);
    vec3 n = chipNormal(p, c, sa, R);
    s.n = n; s.ng = n; s.id = E_STONE; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
    m = baseMat(E_STONE);
    if (uMatDetail > 0.5) {
      // its own rock, shade, polish and mottle (gfx/surface.js PEB_*), in its own frame
      float typ = u01(h); float shade = u01(h);
      float ox = u01(h); float oy = u01(h); float oz = u01(h);
      vec3 lp = transpose(R) * (p - c) + vec3(ox, oy, oz) * GRAIN_TEX_SPREAD;
      vec4 gr = mFbmD(lp, PEB_MOTTLE_F, PEB_MOTTLE_OCT, fp);
      m.alb *= pebbleRock(typ) * (PEB_SHADE_MIN + PEB_SHADE_RANGE * shade) * (1.0 + PEB_MOTTLE_ALB * gr.x);
      m.g = R * (PEB_MOTTLE_H * gr.yzw);
      m.rough += PEB_ROUGH_VAR * (shade - 0.5) - PEB_POLISH;
    }
    // contact occlusion by the nearest pebbles (the 2×2×2 sites around p)
    ivec3 s0 = ivec3(floor(p * float(PEB_N) - 0.5));
    float occ = 0.0;
    for (int i = 0; i < 8; i++) {
      ivec3 sn = s0 + ivec3(i & 1, (i >> 1) & 1, i >> 2);
      if (sn == aH) continue;
      ivec3 cn; vec4 an; vec3 cc; float rn; uint hn;
      if (pebbleOf(sn, cn, an, cc, rn, hn)) occ += ballOcc(p, n, cc, PEB_AO_R * rn);
    }
    m.cav *= 1.0 - min(PEB_AO_GAIN * occ, PEB_AO_MAX);
    m.emit = hotEmit(m, s.id, s.T);
    if (dot(n, uSun) > 0.0) gGrainSun = pebbleSunVis(aH, p + n * GRAIN_NUDGE);
  } else if (k == GK_VOID) {
    ivec3 cell = clamp(ivec3(floor(p)), ivec3(0), GRID - 1);
    vec4 a = fetchA(cell);
    s.n = -normalize(rd); s.ng = s.n; s.id = E_STONE; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
    m = baseMat(E_STONE);
    m.alb *= PEB_VOID_ALB; m.cav = PEB_VOID_CAV;
    m.emit = hotEmit(m, s.id, s.T);
    gGrainSun = 0.0;
  } else {
    // a clod: the element's own texture, from a spot of texture space of the clod's own
    vec4 a = fetchA(aH);
    int id = eid(a);
    vec3 n = clodNormal(p, aH, id, a);
    s.n = n; s.ng = n; s.id = id; s.cell = aH; s.seed = fract(a.w); s.T = a.y;
    uint hc = pcg(floatBitsToUint(s.seed));
    float ox = u01(hc); float oy = u01(hc); float oz = u01(hc);
    vec3 tp = p - vec3(aH) + vec3(ox, oy, oz) * GRAIN_TEX_SPREAD;
    m = matOf(id, tp, n, s.T, floor(a.w), fp);
  }
  applyMat(s, m);
  return s;
}

// Radiance of the EV_GRAIN hit (render.js).
vec3 grainShade(vec3 hp, vec3 rd) {
  vec3 c = shadeSurf(grainSurf(gHitA, gHitK, hp, rd), rd);
  gGrainSun = 1.0;
  return c;
}

// End of the ray: blend in the path not taken (hand-off band).
void grainResolve(inout vec3 col, inout vec3 trans) {
  if (gAltW < 0.0) return;
  Surf s;
  if (gAltGeom) s = grainSurf(gAltA, gAltK, gAltP, gAltRd);
  else s = gatherSurf(gAltP, surfNormal(gAltP, CH_GRANULAR, -gAltRd), CH_GRANULAR);
  vec3 alt = gAltCol + gAltTrans * shadeSurf(s, gAltRd);
  gGrainSun = 1.0;
  float w = gAltGeom ? gAltW : 1.0 - gAltW;   // weight of the stored path
  col = mix(col, alt, w);
  trans *= 1.0 - w;
}
#endif
`;
