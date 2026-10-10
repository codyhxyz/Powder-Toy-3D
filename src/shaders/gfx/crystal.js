// Crystal (E_CRYSTAL) shapes: a run of crystal cells is one long crystal, not
// a stack of cubes. Fluorite's own habit is the cube, and a cube of crystal on
// the cell grid reads as just another block; the shape eyes read as "crystal"
// is quartz's: a long six-sided prism capped by a six-sided point. So that is
// the shape drawn here (a game liberty on the habit; the colour, the glow and
// the optics stay fluorite's: gfx/surface.js crystalLook).
//
// Which way a cell's crystal runs: along one of the three grid axes, looking
// both ways along each to where the crystal ends. An axis with open space
// (nothing solid) at one end and rock (or more crystal than it looks along) at
// the other is a crystal rooted in the rock and pointing out; crystals grow
// toward the open, so the one with the open space nearest wins, then the one
// rooted deepest (ties: up, then z, then x). Failing that, open at both ends
// is a loose crystal pointed at both ends; failing that, buried: a plain prism.
// Every cell of a run sees the same run, so they agree on one crystal: its
// width, where it sits across the cells, its lean and how far into its last
// cell its point reaches are hashes of its root cell, and each cell draws the
// piece inside it. A cluster becomes a bundle of crystals of mixed widths and
// lengths, each pointing out of the rock it grew on.
//
// A crystal is three slabs (the hexagon) and, in the cell that holds its
// point, six planes through the apex (pushed off the axis a little, so the
// faces of a point come out unequal, as real ones do): a convex solid, hit
// exactly, cut by its cell. It leans by less than its cell leaves room for
// along the whole run, so it never crosses a side of its cells. The march
// finds it as it crosses the cell (crispHit), and the shadow map does too
// (shadowFrag).
export const crystalGLSL = /* glsl */ `
const int CRYS_RUN_MAX = 6;          // cells looked along each way; more crystal than that counts as rock
const float CRYS_R_MIN = 0.16, CRYS_R_MAX = 0.38;  // apothem of a crystal (cells)
const float CRYS_R_LOOSE = 0.33;     // most a crystal pointed at both ends in one cell may have (room for two points)
const float CRYS_GAP = 0.03;         // least room (cells) a crystal leaves to its cells' sides
const float CRYS_OFF_SHARE = 0.6;    // share of the room left across the cell spent on where it sits (the rest leans)
const float CRYS_TILT_MAX = 0.3;     // most it leans: tangent off its axis
const float CRYS_TIP_IN = 0.06;      // the apex stays this far (cells) inside its cell
// Quartz's rhombohedral faces meet its c axis at 38.2°: the point rises
// cot(38.2°) apothems from the prism's shoulder to its apex.
const float CRYS_TIP_K = 1.27;
const float CRYS_TIP_SKEW = 0.4;     // the apex sits up to this many apothems off the axis
const float CRYS_CIRC = 1.1547;      // circumradius / apothem of a hexagon (2/√3)
const float CRYS_SALT = 17.31, CRYS_SALT2 = 5.77;   // decorrelate a crystal's hashes
const float CRYS_RAY_EPS = 1e-6;     // a ray this parallel to a plane is treated as parallel
const float CRYS_IN = 1e-3;          // cells: a hit point stepped back this far is inside its cell
// unit hexagon: the side normals' (u, w) components (the slabs are the first three)
const vec2 CRYS_HEX[6] = vec2[6](vec2(1.0, 0.0), vec2(0.5, 0.8660254), vec2(-0.5, 0.8660254),
                                 vec2(-1.0, 0.0), vec2(-0.5, -0.8660254), vec2(0.5, -0.8660254));

// what a hit landed on (gCrysKind)
#define CRYS_SIDE 0    // a prism side
#define CRYS_TIP 1     // a face of a point
#define CRYS_CUT 2     // where its cell's face cuts through it (it grows on into other crystal)

// ends a cell holds (Shard.ends)
#define CRYS_END_FRONT 1
#define CRYS_END_BACK 2

struct Shard {
  vec3 o;      // the axis where it leaves the rock (its root cell's back face)
  vec3 d;      // the grid axis it runs along, toward its point
  vec3 a;      // its axis (unit): d, leaning
  vec3 u, w;   // across the axis: the hexagon's frame
  float r;     // apothem
  vec3 apex;   // its point…
  vec3 apexB;  // …and the back one (a loose crystal)
  int ends;    // the points in this cell (CRYS_END_*)
  float len;   // root face to apex, along d (cells)
  float seed;  // a hash of the crystal, in [0, 1)
};

// The crystal the last crystalHit landed on, for the look (gfx/surface.js
// crystalLook, which runs right after it on the same cell).
bool gCrysOn = false;
ivec3 gCrysCell = ivec3(0);
int gCrysKind = CRYS_CUT;
Shard gCrys;

// Crystal from cell along dir: the steps to where it ends (1: the neighbour
// isn't crystal), and whether open space ends it. Reaching past CRYS_RUN_MAX
// counts as rock; so does the box's floor, and the box's outside is open.
int crysRun(ivec3 cell, ivec3 dir, out bool open) {
  for (int k = 1; k <= CRYS_RUN_MAX; k++) {
    ivec3 c = cell + dir * k;
    if (c.y < 0) { open = false; return k; }
    if (outside(c)) { open = true; return k; }
    int id = eid(fetchA(c));
    if (id == E_CRYSTAL) continue;
    open = isGasLike(id) || SURFCH[id] == CH_LIQUID || RCLASS[id] == R_GLASS;
    return k;
  }
  open = false;
  return CRYS_RUN_MAX + 1;
}

// planes of the point(s) (i < 6: the front point's faces, else the back's), as dot(p - o, m) <= dist
void crysPlane(Shard s, int i, out vec3 m, out float dist) {
  vec2 hx = CRYS_HEX[i % 6];
  vec3 nk = hx.x * s.u + hx.y * s.w;
  bool front = i < 6;
  m = normalize(CRYS_TIP_K * nk + (front ? s.a : -s.a));
  dist = dot((front ? s.apex : s.apexB) - s.o, m);
}

// Ray (ro, rd) vs the crystal's piece in this cell, within [tN, tF]: tN
// becomes the entry and n its face (left as passed in if the ray starts
// inside); kind: which face.
bool shardHit(Shard s, vec3 ro, vec3 rd, inout float tN, float tF, inout vec3 n, out int kind) {
  vec3 q = ro - s.o;
  kind = CRYS_CUT;
  for (int i = 0; i < 3; i++) {
    vec3 m = CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w;
    float dn = dot(rd, m), dq = dot(q, m);
    if (abs(dn) < CRYS_RAY_EPS) { if (abs(dq) > s.r) return false; continue; }
    float ta = (-s.r - dq) / dn, tb = (s.r - dq) / dn;
    float tin = min(ta, tb);
    if (tin > tN) { tN = tin; n = -sign(dn) * m; kind = CRYS_SIDE; }
    tF = min(tF, max(ta, tb));
  }
  for (int i = 0; i < 12; i++) {
    if ((s.ends & (i < 6 ? CRYS_END_FRONT : CRYS_END_BACK)) == 0) continue;
    vec3 m; float d;
    crysPlane(s, i, m, d);
    float dn = dot(rd, m), dist = d - dot(q, m);
    if (dn < -CRYS_RAY_EPS) { float t = dist / dn; if (t > tN) { tN = t; n = m; kind = CRYS_TIP; } }
    else if (dn > CRYS_RAY_EPS) tF = min(tF, dist / dn);
    else if (dist < 0.0) return false;
  }
  return tN <= tF;
}

// How far a ray from p (inside the crystal) along unit d runs before it
// leaves it (its piece in this cell has no end but its points: through the
// cell's faces the crystal carries on).
float shardExit(Shard s, vec3 p, vec3 d) {
  vec3 q = p - s.o;
  float t = 1e9;
  for (int i = 0; i < 3; i++) {
    vec3 m = CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w;
    float dn = dot(d, m), dq = dot(q, m);
    if (abs(dn) > CRYS_RAY_EPS) t = min(t, (sign(dn) * s.r - dq) / dn);
  }
  for (int i = 0; i < 12; i++) {
    if ((s.ends & (i < 6 ? CRYS_END_FRONT : CRYS_END_BACK)) == 0) continue;
    vec3 m; float dist;
    crysPlane(s, i, m, dist);
    float dn = dot(d, m);
    if (dn > CRYS_RAY_EPS) t = min(t, (dist - dot(q, m)) / dn);
  }
  return max(t, 0.0);
}

// The crystal running through cell.
Shard crysShard(ivec3 cell) {
  // which way it runs (y first, so ties go up)
  int best = -1, ax = 1, fwd = CRYS_RUN_MAX + 2, back = 0;
  bool plus = true;
  for (int j = 0; j < 3; j++) {
    int k = (j + 1) % 3;   // y, z, x
    ivec3 e = ivec3(0);
    e[k] = 1;
    bool oP, oM;
    int kP = crysRun(cell, e, oP), kM = crysRun(cell, -e, oM);
    int cls = oP != oM ? 2 : (oP ? 1 : 0);   // rooted, loose, buried
    bool pl = cls != 2 || oP;
    int f = pl ? kP : kM, bk = pl ? kM : kP;
    if (cls > best || (cls == best && (f < fwd || (f == fwd && bk > back)))) {
      best = cls; ax = k; plus = pl; fwd = f; back = bk;
    }
  }
  int bestLen = fwd + back - 1;
  Shard s;
  s.d = vec3(0.0);
  s.d[ax] = plus ? 1.0 : -1.0;
  ivec3 di = ivec3(s.d);
  ivec3 root = cell - di * (back - 1);   // the run's first cell
  float n = float(bestLen);              // cells in the run
  vec3 wr = worldPos(vec3(root)) + float(ax) * CRYS_SALT;
  vec3 h1 = hash33(wr), h2 = hash33(wr + CRYS_SALT2);
  s.seed = h2.z;
  bool loose = best == 1;
  s.r = mix(CRYS_R_MIN, loose && bestLen == 1 ? CRYS_R_LOOSE : CRYS_R_MAX, h1.x);
  // where it sits across its cells and how it leans, within the room it has
  vec3 t1 = vec3(0.0), t2 = vec3(0.0);
  t1[(ax + 1) % 3] = 1.0; t2[(ax + 2) % 3] = 1.0;
  float room = 0.5 - CRYS_CIRC * s.r - CRYS_GAP;
  vec2 off = (2.0 * vec2(h1.y, h1.z) - 1.0) * room * CRYS_OFF_SHARE;
  vec2 lean = (2.0 * vec2(h2.x, h2.y) - 1.0) * min((room - abs(off)) / n, vec2(CRYS_TILT_MAX));
  vec3 rootFace = vec3(root) + 0.5 - s.d * 0.5;
  s.o = rootFace + t1 * off.x + t2 * off.y;
  vec3 lv = s.d + t1 * lean.x + t2 * lean.y;   // the axis per cell along d
  s.a = normalize(lv);
  // the hexagon's turn about the axis
  float turn = h2.z * 1.0471976;   // up to 60°
  vec3 b1 = normalize(cross(s.a, t2)), b2 = cross(s.a, b1);
  s.u = cos(turn) * b1 + sin(turn) * b2;
  s.w = cross(s.a, s.u);
  // the point: its apex somewhere in the run's last cell, CRYS_TIP_IN from its face at most
  float tipH = CRYS_TIP_K * s.r * dot(s.a, s.d);   // the point's height along d
  float lo = loose ? CRYS_TIP_IN + 2.0 * tipH - n + 1.0 : CRYS_TIP_IN + tipH;   // a loose one leaves room for its back point
  float hi = 1.0 - CRYS_TIP_IN;
  s.len = n - 1.0 + mix(max(lo, tipH), hi, hash13(wr + 2.0 * CRYS_SALT2));
  s.apex = s.o + lv * s.len;
  s.apexB = s.o + lv * CRYS_TIP_IN;
  vec2 sk = (hash33(wr + 2.0 * CRYS_SALT).xy * 2.0 - 1.0) * CRYS_TIP_SKEW * s.r;
  s.apex += s.u * sk.x + s.w * sk.y;
  s.apexB -= s.u * sk.y + s.w * sk.x;
  s.ends = (best >= 1 && fwd == 1 ? CRYS_END_FRONT : 0) | (loose && back == 1 ? CRYS_END_BACK : 0);
  return s;
}

// The march crossing crystal cell over [tEnter, tExit]: true with the hit's t
// and normal n (n comes in as the entry face) if it meets the cell's piece of
// crystal. Sets gCrys for the look.
bool crystalHit(ivec3 cell, vec3 ro, vec3 rd, float tEnter, float tExit, inout float t, inout vec3 n) {
  Shard s = crysShard(cell);
  float tk = tEnter;
  vec3 nk = n;
  int kind;
  if (!shardHit(s, ro, rd, tk, tExit, nk, kind)) { gCrysOn = false; return false; }
  gCrysOn = true; gCrysCell = cell; gCrysKind = kind; gCrys = s;
  t = tk; n = nk;
  return true;
}
`;
