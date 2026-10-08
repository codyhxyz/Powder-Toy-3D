// Close-up detail (gfx/detail.js): grains drawn as real geometry inside their cells.
//
// "grains" (DETAIL_GRAINS): up close, each gravel (STONE) cell is the handful
// of pebbles it holds. The cell is split into 2×2×2 slots; most slots hold a
// pebble, an ellipsoid of its own size, flattening and turn, kept inside the
// cell. Rays test the pebbles of the gravel cells they cross (exact
// ray–ellipsoid hits), so a heap has real silhouettes, pebbles hide one
// another, and the eye sees down into dark gaps between them. A pebble is
// darkened by the pebbles touching it (contact occlusion) and shadowed by the
// ones between it and the sun.
//
// "grainClusters" (DETAIL_GRAIN_CLUSTERS): a lone cell of any granular
// powder (sand, snow, gunpowder, ash; gravel when pebbles are off), which the
// smooth surface draws as one blob, is drawn up close as a small cluster of
// grains, settled to the bottom of its cell if it rests on something.
//
// Honesty: where a cell's grains sit, how big they are, how they are turned
// and what rock they are is a hash of the cell's seed and nothing else, so
// they are fixed to the cell and move exactly when and where the sim moves it.
// Nothing is animated.
//
// Hand-off: by footprint. Far away the gravel texture (gfx/surface.js matOf,
// same rock types and pebble size) is drawn; up close the pebbles. In
// between both are traced and their pixels crossfaded by distance, with no
// threshold to pop. Beyond the band nothing here runs past a footprint test.
//
// Hooks in render.js: grainEvent per cell of the realistic march, the
// EV_GRAIN event (grainShade), and grainResolve at the end of the ray.
export const grainsGLSL = /* glsl */ `
#ifdef GRAINS_ANY
#define EV_GRAIN 4   // tracer event (render.js EV_*): the ray hit a grain

// What the ray is committed to (see grainEvent).
#define GM_OPEN 0    // nothing yet
#define GM_GEOM 1    // grains: the smooth surface they replace is skipped
#define GM_TEX 2     // the textured smooth surface: no more grains

// What a grain hit is.
#define GK_GRAIN 0   // a pebble or grain
#define GK_VOID 1    // the dark depth between pebbles (the ray went too deep)

// ---- pebbles (gravel cells) ----
const int PEB_SLOTS = 8;              // 2×2×2 slots per cell
const float PEB_SLOT = 0.5;           // slot edge, cells
const float PEB_P = 0.9;              // share of slots holding a pebble
const float PEB_R_MIN = 0.19, PEB_R_VAR = 0.08;   // longest semi-axis, cells (3–4.3 cm across)
const float PEB_MID_MIN = 0.7;        // middle semi-axis, as a share of the longest: at least this
const float PEB_FLAT_MIN = 0.45, PEB_FLAT_MAX = 0.8;   // shortest semi-axis share (water-worn: flattish)
const float PEB_JITTER = 0.12;        // spread of a pebble's centre about its slot's centre, cells
const float PEB_SPLIT_VAR = 0.3;      // spread of where a cell's slots divide along each axis (about the middle), cells
// Pebbles may reach this far (cells) into gravel next door, so neighbouring
// cells' pebbles interlock instead of leaving a straight seam at every cell face.
const float PEB_OVER = 0.1;
const float PEB_R_MEAN = PEB_R_MIN + 0.5 * PEB_R_VAR;
// Path (cells) the ray may run through gravel cells without hitting a pebble
// before it counts as lost in the dark between them (GK_VOID).
const float PEB_VOID_DEPTH = 1.5;

// ---- clusters (lone powder cells) ----
const int CLU_N = 12;                 // grains in a lone cell
const float CLU_R = 0.27;             // radius of the ball they gather in, cells
const float CLU_REST_SQUASH = 0.45;   // a resting cluster's height, as a share of the ball's
// Per element: (smallest semi-axis, spread, shortest/longest axis), cells.
// They stand in for a cell's worth of powder, coarser than its real grains.
const vec3 CLU_SAND = vec3(0.065, 0.04, 0.7);      // rounded grains
const vec3 CLU_SNOW = vec3(0.07, 0.05, 0.5);       // clumped crystals
const vec3 CLU_GUNPOWDER = vec3(0.06, 0.03, 0.85); // glazed granules
const vec3 CLU_ASH = vec3(0.08, 0.06, 0.25);       // flakes
const vec3 CLU_STONE = vec3(0.09, 0.05, 0.6);      // grit (gravel, with pebbles off)

// ---- hand-off by footprint ----
// Geometry starts where a grain is GRAIN_PX_NONE pixels across and has taken
// over by GRAIN_PX_FULL; cluster grains are smaller, so they start sooner.
const float PEB_PX_NONE = 8.0, PEB_PX_FULL = 16.0;   // pixels across a pebble
const float CLU_PX_NONE = 4.0, CLU_PX_FULL = 8.0;    // pixels across a cluster grain
const float CLU_GRAIN_D = 0.18;                      // typical cluster grain diameter, cells
const float PEB_FP_NONE = 2.0 * PEB_R_MEAN / PEB_PX_NONE, PEB_FP_FULL = 2.0 * PEB_R_MEAN / PEB_PX_FULL;   // cells per pixel
const float CLU_FP_NONE = CLU_GRAIN_D / CLU_PX_NONE, CLU_FP_FULL = CLU_GRAIN_D / CLU_PX_FULL;

// ---- bounds on the work per ray ----
const int GRAIN_MAX_N = 12;           // most grains in a cell (max of PEB_SLOTS, CLU_N)
const int GRAIN_MAX_CELLS = 6;        // grain cells tested per ray
const int GRAIN_SUN_CELLS = 2;        // cells toward the sun tested for grain shadows (after its own)

// ---- shading ----
const float GRAIN_TEX_SPREAD = 61.0;  // cells of texture space the hash spreads grains over
const float GRAIN_AO_R = 0.8;         // a neighbour occludes like a ball this share of its longest semi-axis
const float GRAIN_AO_GAIN = 1.2;      // contact occlusion: darkening per unit of summed ball occlusion ...
const float GRAIN_AO_MAX = 0.85;      // ... at most this much
const float GRAIN_NUDGE = 1e-3;       // cells off a grain's surface where its sun ray starts
const float CELL_STEP_NUDGE = 1e-3;   // cells past a cell's exit point that lie in the next cell
// A pebble hit closer than PEB_OVER × this (cells of path) to where the ray
// leaves its cell may be behind the next cell's pebbles reaching in (the
// path through that reach is longer than its depth when the ray is slanted).
const float PEB_OVER_REACH = 3.0;
const float TWO_PI_G = 6.2831853;
const uint GRAIN_SALT = 0x9e3779b9u;  // golden-ratio odd constant: spreads grain indices apart in the hash
const uint GRAIN_CELL_SALT = 0x85ebca6bu;  // (murmur3's constant) the per-cell hash, apart from the grains'

struct GrainRec {
  int kind;      // GK_*
  int k;         // grain index within the cell
  int id;        // element
  ivec3 cell;
  vec4 a;        // the cell's state A
  vec3 p;        // hit point (grid units)
  vec3 n;        // outward normal
  vec3 c;        // grain centre (grid units)
  mat3 R;        // grain axes (columns)
  uint h;        // hash state for its look
};

float u01(inout uint h) { h = pcg(h); return float(h) * UINT_TO_UNIT; }

// Elements whose cells may hold grains, and whether this cell does.
bool grainElement(int id) {
#ifdef DETAIL_GRAINS
  if (id == E_STONE) return true;
#endif
#ifdef DETAIL_GRAIN_CLUSTERS
  if (SURFCH[id] == CH_GRANULAR) return true;
#endif
  return false;
}
bool isPebbles(int id) {
#ifdef DETAIL_GRAINS
  return id == E_STONE;
#else
  return false;
#endif
}
bool granularAt(ivec3 c) { return !outside(c) && SURFCH[eid(cellA(c))] == CH_GRANULAR; }
// pebbles: every gravel cell; clusters: only a cell with no granular face neighbour
bool grainCellOk(ivec3 c, int id) {
  if (isPebbles(id)) return true;
  return !granularAt(c + ivec3(1, 0, 0)) && !granularAt(c - ivec3(1, 0, 0)) && !granularAt(c + ivec3(0, 1, 0))
      && !granularAt(c - ivec3(0, 1, 0)) && !granularAt(c + ivec3(0, 0, 1)) && !granularAt(c - ivec3(0, 0, 1));
}
// a lone cell resting on something settles its grains to the bottom of the cell
bool grainResting(ivec3 c) {
  if (c.y == 0) return true;
  int b = eid(cellA(c - ivec3(0, 1, 0)));
  return b != E_EMPTY && KIND[b] != K_GAS;
}

// What every grain of a cell shares: layout bounds (cell-local, cells),
// where its slots divide, whether it is gravel (pebbles) or a resting cluster.
struct CellGrains { bool peb; bool resting; uint sb; int n; vec3 lo, hi, split; };
bool stoneAt(ivec3 c) { return !outside(c) && eid(cellA(c)) == E_STONE; }
CellGrains cellGrains(ivec3 cell, int id, vec4 a) {
  CellGrains G;
  G.peb = isPebbles(id);
  G.resting = !G.peb && grainResting(cell);
  G.sb = floatBitsToUint(fract(a.w));
  G.n = G.peb ? PEB_SLOTS : CLU_N;
  G.lo = vec3(0.0); G.hi = vec3(1.0); G.split = vec3(0.5);
  if (G.peb) {
    for (int k = 0; k < 3; k++) {
      ivec3 e = ivec3(0);
      e[k] = 1;
      if (stoneAt(cell - e)) G.lo[k] = -PEB_OVER;
      if (stoneAt(cell + e)) G.hi[k] = 1.0 + PEB_OVER;
    }
    uint h = pcg(G.sb ^ GRAIN_CELL_SALT);
    float sx = u01(h); float sy = u01(h); float sz = u01(h);
    G.split = 0.5 + (vec3(sx, sy, sz) - 0.5) * PEB_SPLIT_VAR;
  }
  return G;
}

// Weight of the grains (vs the texture) at footprint fp.
float grainW(int id, float fp) {
  return isPebbles(id) ? 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp) : 1.0 - smoothstep(CLU_FP_FULL, CLU_FP_NONE, fp);
}
float grainWMax(float fp) {
  float w = 0.0;
#ifdef DETAIL_GRAINS
  w = 1.0 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp);
#endif
#ifdef DETAIL_GRAIN_CLUSTERS
  w = max(w, 1.0 - smoothstep(CLU_FP_FULL, CLU_FP_NONE, fp));
#endif
  return w;
}

vec3 clusterShape(int id) {
  return id == E_SAND ? CLU_SAND : (id == E_SNOW ? CLU_SNOW : (id == E_GUNPOWDER ? CLU_GUNPOWDER : (id == E_ASH ? CLU_ASH : CLU_STONE)));
}

// Grain k of a cell (seed bits sb): false if its slot is empty, else its
// centre (cell-local, cells) and longest semi-axis r. h carries on to grainShape.
bool grainAt(int id, CellGrains G, int k, out vec3 c, out float r, out uint h) {
  h = pcg(G.sb ^ (uint(k + 1) * GRAIN_SALT));
  float pr = u01(h);
  if (G.peb) {
    r = PEB_R_MIN + PEB_R_VAR * u01(h);
    vec3 o = vec3(ivec3(k & 1, (k >> 1) & 1, k >> 2));
    float jx = u01(h); float jy = u01(h); float jz = u01(h);
    c = mix(0.5 * G.split, 0.5 * (1.0 + G.split), o) + (vec3(jx, jy, jz) - 0.5) * PEB_JITTER;
    c = clamp(c, G.lo + r, G.hi - r);
    return pr < PEB_P;
  }
  vec3 sh = clusterShape(id);
  r = sh.x + sh.y * u01(h);
  float z = 2.0 * u01(h) - 1.0;
  float ph = TWO_PI_G * u01(h);
  float rr = CLU_R * sqrt(u01(h));   // denser toward the middle
  c = 0.5 + rr * vec3(sqrt(max(1.0 - z * z, 0.0)) * vec2(cos(ph), sin(ph)), z).xzy;
  if (G.resting) c.y = r + (c.y - 0.5 + CLU_R) * CLU_REST_SQUASH;
  c = clamp(c, vec3(r), vec3(1.0 - r));
  return true;
}

// Its semi-axes s and axes R (a uniformly random turn: Shoemake's quaternion).
void grainShape(int id, bool peb, float r, inout uint h, out vec3 s, out mat3 R) {
  float u1 = u01(h); float u2 = u01(h);
  if (peb) s = r * vec3(1.0, mix(PEB_MID_MIN, 1.0, u1), mix(PEB_FLAT_MIN, PEB_FLAT_MAX, u2));
  else { float fl = clusterShape(id).z; s = r * vec3(1.0, mix(fl, 1.0, u1), fl); }
  float q1 = u01(h); float q2 = TWO_PI_G * u01(h); float q3 = TWO_PI_G * u01(h);
  vec4 q = vec4(sqrt(1.0 - q1) * vec2(sin(q2), cos(q2)), sqrt(q1) * vec2(sin(q3), cos(q3)));
  float x = q.x, y = q.y, z = q.z, w = q.w;
  R = mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
           2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
           2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

// Nearest grain of the cell hit by the ray at t >= tMin (grain skip left
// out), NO_HIT if none; kHit = its index.
float grainsHit(ivec3 cell, int id, vec4 a, vec3 ro, vec3 rd, float tMin, int skip, out int kHit) {
  kHit = -1;
  CellGrains G = cellGrains(cell, id, a);
  bool peb = G.peb;
  int n = G.n;
  float best = NO_HIT;
  float rr = 1.0 / dot(rd, rd);
  for (int k = 0; k < GRAIN_MAX_N; k++) {
    if (k >= n) break;
    if (k == skip) continue;
    vec3 c; float r; uint h;
    if (!grainAt(id, G, k, c, r, h)) continue;
    c += vec3(cell);
    // bounding ball first
    vec3 oc = ro - c;
    float b = dot(oc, rd) * rr;
    float disc = b * b - (dot(oc, oc) - r * r) * rr;
    if (disc < 0.0) continue;
    float sq = sqrt(disc);
    if (-b - sq >= best || -b + sq < tMin) continue;
    vec3 s; mat3 R;
    grainShape(id, peb, r, h, s, R);
    // the ellipsoid, as a unit ball in its own frame
    mat3 Rt = transpose(R);
    vec3 o = (Rt * oc) / s, d = (Rt * rd) / s;
    float ea = dot(d, d), eb = dot(o, d), ec = dot(o, o) - 1.0;
    float eh = eb * eb - ea * ec;
    if (eh < 0.0) continue;
    float t = (-eb - sqrt(eh)) / ea;
    if (t < tMin || t >= best) continue;
    best = t;
    kHit = k;
  }
  return best;
}

// The full record of grain k (k < 0: the void) of a cell, hit at p by a ray along rd.
GrainRec grainRec(ivec3 cell, int k, vec3 p, vec3 rd) {
  GrainRec g;
  g.a = cellA(cell); g.id = eid(g.a); g.cell = cell; g.k = k; g.p = p;
  g.kind = k < 0 ? GK_VOID : GK_GRAIN;
  g.n = -normalize(rd); g.c = p; g.R = mat3(1.0); g.h = 0u;
  if (k >= 0) {
    CellGrains G = cellGrains(cell, g.id, g.a);
    vec3 c; float r; uint h; vec3 s; mat3 R;
    grainAt(g.id, G, k, c, r, h);
    grainShape(g.id, G.peb, r, h, s, R);
    g.c = c + vec3(cell); g.R = R; g.h = h;
    g.n = normalize(R * ((transpose(R) * (p - g.c)) / (s * s)));   // ellipsoid gradient
  }
  return g;
}

// ---- the march's state for this pixel ----
int gGrainMode = GM_OPEN;
int gGrainCells = 0;        // grain cells tested so far
float gGrainDepth = 0.0;    // path through gravel cells since the last hit-free air (cells)
// (kept small: these stay live across the whole march)
ivec3 gHitCell = ivec3(0);  // the grain of an EV_GRAIN event: its cell ...
int gHitK = -1;             // ... index (-1: the void) ...
const float GRAIN_NO_P = -1.0;   // (gHitP.x at or below this: no grain hit)
vec3 gHitP = vec3(GRAIN_NO_P - 1.0);   // ... and where it was hit (shaded after the march)
// The path not taken while crossfading in the hand-off band: it ended at gAltP
// (a grain: gAltCell, gAltK; else the granular surface) with (col, trans) in
// front of it; gAltW = the grains' weight there (< 0: none); gAltGeom: the
// stored path is the grains one.
float gAltW = -1.0;
bool gAltGeom = false;
vec3 gAltCol = vec3(0.0), gAltTrans = vec3(0.0), gAltRd = vec3(0.0), gAltP = vec3(0.0);
ivec3 gAltCell = ivec3(0);
int gAltK = -1;

// The textured granular surface hit at hp: do grains replace it here? True if
// every granular cell around hp holds grains (or there are none, e.g. the
// blurred trail of a lone cell that moved on); w = the grains' weight.
bool grainSuppress(vec3 hp, out float w) {
  float fp = footprint(hp);
  w = grainWMax(fp);
  if (w <= 0.0) return false;
  ivec3 c0 = ivec3(floor(hp - 0.5));
  float wMin = 2.0;
  for (int i = 0; i < 8; i++) {
    ivec3 c = c0 + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    if (outside(c)) continue;
    int id = eid(cellA(c));
    if (SURFCH[id] != CH_GRANULAR) continue;
    if (!grainElement(id) || !grainCellOk(c, id)) return false;
    wMin = min(wMin, grainW(id, fp));
  }
  if (wMin <= 1.0) w = wMin;
  return w > 0.0;
}

// Per cell of the realistic march (render.js), once the segment's event
// (ev at tEv, channel evCh) is known: the grains of this
// cell may come first (ev becomes EV_GRAIN), and the granular surface may be
// skipped where grains replace it. In the hand-off band the first of the two
// to be reached is stored as the other path (gAlt*) and the ray goes on as
// the other; grainResolve blends them.
void grainEvent(ivec3 cell, int id, vec4 a, vec3 ro, vec3 rd, float tEnter, float tExit,
                vec3 col, vec3 trans, inout int ev, int evCh, inout float tEv,
                inout bool anyHit, inout vec3 hitPos) {
  if (id == E_EMPTY) gGrainDepth = 0.0;
  if (gGrainMode == GM_TEX) return;
  bool isoCand = ev == EV_OPAQUE && evCh == CH_GRANULAR;
  bool cand = grainElement(id) && gGrainCells < GRAIN_MAX_CELLS;
  if (!cand && !isoCand) return;
  // 1. this cell's grains (gated by footprint before any per-cell work)
  float tG = NO_HIT, wG = 0.0;
  int kG = -1;
  ivec3 cG = cell;
  if (cand) {
    wG = grainW(id, footprint(ro + rd * tEnter));
    if (wG > 0.0 && grainCellOk(cell, id)) {
      gGrainCells++;
      // (pebbles reaching back into the cell the ray just left count: nothing there was hit)
      tG = grainsHit(cell, id, a, ro, rd, isPebbles(id) ? max(tEnter - PEB_OVER * PEB_OVER_REACH, 0.0) : tEnter, -1, kG);
      if (tG < NO_HIT && isPebbles(id) && (tExit - tG) * length(rd) < PEB_OVER * PEB_OVER_REACH) {
        // the next gravel cell's pebbles reach into this one: one may be in front
        ivec3 nc = ivec3(floor(ro + rd * tExit + rd * (CELL_STEP_NUDGE / length(rd))));
        if (stoneAt(nc)) {
          int k2;
          float t2 = grainsHit(nc, E_STONE, cellA(nc), ro, rd, tEnter, -1, k2);
          if (t2 < tG) { tG = t2; kG = k2; cG = nc; }
        }
      }
      if (tG >= NO_HIT && isPebbles(id)) {
        // through a gap: deep enough in, the gaps are dark voids
        float seg = tExit - tEnter;
        if (gGrainDepth + seg > PEB_VOID_DEPTH || gGrainCells >= GRAIN_MAX_CELLS) {
          tG = min(tEnter + max(PEB_VOID_DEPTH - gGrainDepth, 0.0), tExit);
          kG = -1; cG = cell;
        }
        gGrainDepth += seg;
      }
    }
  }
  // 2. the granular surface, where grains replace it
  float wS;
  if (isoCand && tG >= tEv && grainSuppress(ro + rd * tEv, wS)) {
    if (gGrainMode == GM_OPEN && wS < 1.0) {
      vec3 hp = ro + rd * tEv;
      gAltW = wS; gAltGeom = false; gAltCol = col; gAltTrans = trans; gAltRd = rd;
      gAltP = hp;
      if (!anyHit) { anyHit = true; hitPos = hp; }
    }
    gGrainMode = GM_GEOM;
    ev = EV_NONE; tEv = tExit;
  }
  // 3. a grain in front of whatever else this segment holds
  if (tG < tEv) {
    if (gGrainMode == GM_OPEN && wG < 1.0) {
      gAltW = wG; gAltGeom = true; gAltCol = col; gAltTrans = trans; gAltRd = rd;
      gAltP = ro + rd * tG; gAltCell = cG; gAltK = kG;
      if (!anyHit) { anyHit = true; hitPos = gAltP; }
      gGrainMode = GM_TEX;
    } else {
      gGrainMode = GM_GEOM;
      ev = EV_GRAIN; tEv = tG; gHitCell = cG; gHitK = kG;
    }
  }
}

// ---- shading ----
// Occlusion of point p (normal n) by a ball (centre c, radius r), Quilez's
// analytic sphere occlusion.
float ballOcc(vec3 p, vec3 n, vec3 c, float r) {
  vec3 d = c - p;
  float l2 = dot(d, d);
  return max(dot(n, d) * inversesqrt(l2), 0.0) * r * r / l2;
}

// Sun visibility of a grain past the grains of its own cell and of the next
// GRAIN_SUN_CELLS cells toward the sun (the shadow map is far too coarse for them).
float grainSunVis(GrainRec g) {
  vec3 ro = g.p + g.n * GRAIN_NUDGE;
  vec3 rd = safeDir(uSun);
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = g.cell;
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  int kTmp;
  for (int i = 0; i <= GRAIN_SUN_CELLS; i++) {
    if (outside(cell)) break;
    vec4 a = i == 0 ? g.a : cellA(cell);
    int id = eid(a);
    if (grainElement(id) && (i == 0 || grainCellOk(cell, id))
        && grainsHit(cell, id, a, ro, rd, 0.0, i == 0 ? g.k : -1, kTmp) < NO_HIT) return 0.0;
    int ax = argmin3(tMax);
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// Surface record of a grain hit; sets gGrainSun for its shadeSurf.
Surf grainSurf(GrainRec g) {
  Surf s;
  s.p = g.p; s.n = g.n; s.ng = g.n; s.ch = CH_GRANULAR; s.id = g.id; s.cell = g.cell;
  s.face = ivec3(0, 1, 0); s.seed = fract(g.a.w); s.T = g.a.y;
  float fp = footprint(g.p);
  Mat m;
  if (g.id == E_STONE || g.kind == GK_VOID) {
    m.alb = ALBEDO[E_STONE]; m.g = vec3(0.0); m.tang = vec3(1.0, 0.0, 0.0); m.sssCol = vec3(1.0);
    m.rough = ROUGH[E_STONE]; m.metal = METAL[E_STONE];
    m.f0 = (IOR[E_STONE] - 1.0) / (IOR[E_STONE] + 1.0); m.f0 *= m.f0;
    m.sss = SSS[E_STONE]; m.glint = GLINT[E_STONE]; m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
    if (g.kind == GK_VOID) {
      m.alb *= PEB_VOID_ALB; m.cav = PEB_VOID_CAV;
    } else if (uMatDetail > 0.5) {
      // the pebble's own rock, shade, polish and mottle (gfx/surface.js PEB_*), in its own frame
      uint h = g.h;
      float typ = u01(h); float shade = u01(h);
      float ox = u01(h); float oy = u01(h); float oz = u01(h);
      vec3 lp = transpose(g.R) * (g.p - g.c) + vec3(ox, oy, oz) * GRAIN_TEX_SPREAD;
      vec4 gr = mFbmD(lp, PEB_MOTTLE_F, PEB_MOTTLE_OCT, fp);
      m.alb *= pebbleRock(typ) * (PEB_SHADE_MIN + PEB_SHADE_RANGE * shade) * (1.0 + PEB_MOTTLE_ALB * gr.x);
      m.g = g.R * (PEB_MOTTLE_H * gr.yzw);
      m.rough += PEB_ROUGH_VAR * (shade - 0.5) - PEB_POLISH;
    }
    m.emit = hotEmit(m, s.T);
  } else {
    // a powder grain: the element's own texture, from a spot of texture space of its own
    uint h = g.h;
    float ox = u01(h); float oy = u01(h); float oz = u01(h);
    vec3 tp = transpose(g.R) * (g.p - g.c) + vec3(ox, oy, oz) * GRAIN_TEX_SPREAD;
    m = matOf(g.id, tp, g.n, s.T, floor(g.a.w), fp);
  }
  gGrainSun = 0.0;
  if (g.kind != GK_VOID) {
    // contact occlusion by the other grains of the cell
    CellGrains G = cellGrains(g.cell, g.id, g.a);
    float occ = 0.0;
    for (int k = 0; k < GRAIN_MAX_N; k++) {
      if (k >= G.n) break;
      if (k == g.k) continue;
      vec3 c; float r; uint h;
      if (grainAt(g.id, G, k, c, r, h)) occ += ballOcc(g.p, g.n, c + vec3(g.cell), GRAIN_AO_R * r);
    }
    m.cav *= 1.0 - min(GRAIN_AO_GAIN * occ, GRAIN_AO_MAX);
    gGrainSun = dot(g.n, uSun) > 0.0 ? grainSunVis(g) : 1.0;   // (facing away, n.l already darkens it)
  }
  applyMat(s, m);
  return s;
}

// Radiance of the EV_GRAIN hit at hp (render.js).
vec3 grainShade(vec3 hp, vec3 rd) {
  vec3 c = shadeSurf(grainSurf(grainRec(gHitCell, gHitK, hp, rd)), rd);
  gGrainSun = 1.0;
  return c;
}

// End of the ray: blend in the path not taken (hand-off band).
void grainResolve(inout vec3 col, inout vec3 trans) {
  if (gAltW < 0.0) return;
  Surf s;
  if (gAltGeom) s = grainSurf(grainRec(gAltCell, gAltK, gAltP, gAltRd));
  else s = gatherSurf(gAltP, surfNormal(gAltP, CH_GRANULAR, -gAltRd), CH_GRANULAR);
  vec3 alt = gAltCol + gAltTrans * shadeSurf(s, gAltRd);
  gGrainSun = 1.0;
  float w = gAltGeom ? gAltW : 1.0 - gAltW;   // weight of the stored path
  col = mix(col, alt, w);
  trans *= 1.0 - w;
}
#endif
`;
