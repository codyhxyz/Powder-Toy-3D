import { libChecks } from './lib.js';

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
// finds it as it crosses the cell (crispHit), and the shadow map does too.
//
// WGSL (the name is the GLSL version's, docs/webgpu.md W2), after core and
// noise in lib(). Reads the state (fetchA) and nothing else.
//   crystalHit(cell, ro, rd, tEnter, tExit, &t, &n) -> bool   the march's test (sets gCrys*)
//   crysShard(cell) -> Shard                                  the crystal running through cell
//   shardHit(s, ro, rd, &tN, tF, &n, &kind) -> bool           ray vs its piece in the cell
//   shardExit(s, p, d) -> f32                                 distance to leave it from inside
//   crysRun(cell, dir, &open) -> i32, crysPlane(s, i, &m, &dist)   their parts
export const crystalGLSL = /* wgsl */ `
const CRYS_RUN_MAX: i32 = 6;         // cells looked along each way; more crystal than that counts as rock
const CRYS_R_MIN: f32 = 0.16;        // apothem of a crystal (cells), least ...
const CRYS_R_MAX: f32 = 0.38;        // ... and most
const CRYS_R_LOOSE: f32 = 0.33;      // most a crystal pointed at both ends in one cell may have (room for two points)
const CRYS_GAP: f32 = 0.03;          // least room (cells) a crystal leaves to its cells' sides
const CRYS_OFF_SHARE: f32 = 0.6;     // share of the room left across the cell spent on where it sits (the rest leans)
const CRYS_TILT_MAX: f32 = 0.3;      // most it leans: tangent off its axis
const CRYS_TIP_IN: f32 = 0.06;       // the apex stays this far (cells) inside its cell
// Quartz's rhombohedral faces meet its c axis at 38.2°: the point rises
// cot(38.2°) apothems from the prism's shoulder to its apex.
const CRYS_TIP_K: f32 = 1.27;
const CRYS_TIP_SKEW: f32 = 0.4;      // the apex sits up to this many apothems off the axis
const CRYS_CIRC: f32 = 1.1547;       // circumradius / apothem of a hexagon (2/√3)
const CRYS_SALT: f32 = 17.31;        // decorrelate a crystal's hashes
const CRYS_SALT2: f32 = 5.77;
const CRYS_RAY_EPS: f32 = 1e-6;      // a ray this parallel to a plane is treated as parallel
const CRYS_IN: f32 = 1e-3;           // cells: a hit point stepped back this far is inside its cell
const CRYS_TURN_MAX: f32 = 1.0471976;   // the hexagon turns about its axis by up to 60°
// unit hexagon: the side normals' (u, w) components (the slabs are the first
// three); six entries, so a private array (docs/webgpu.md C6)
var<private> CRYS_HEX: array<vec2f, 6> = array<vec2f, 6>(vec2f(1.0, 0.0), vec2f(0.5, 0.8660254), vec2f(-0.5, 0.8660254),
                                                        vec2f(-1.0, 0.0), vec2f(-0.5, -0.8660254), vec2f(0.5, -0.8660254));

// what a hit landed on (gCrysKind)
const CRYS_SIDE: i32 = 0;    // a prism side
const CRYS_TIP: i32 = 1;     // a face of a point
const CRYS_CUT: i32 = 2;     // where its cell's face cuts through it (it grows on into other crystal)

// ends a cell holds (Shard.ends)
const CRYS_END_FRONT: i32 = 1;
const CRYS_END_BACK: i32 = 2;

struct Shard {
  o: vec3f,       // the axis where it leaves the rock (its root cell's back face)
  d: vec3f,       // the grid axis it runs along, toward its point
  a: vec3f,       // its axis (unit): d, leaning
  u: vec3f,       // across the axis: the hexagon's frame
  w: vec3f,
  r: f32,         // apothem
  apex: vec3f,    // its point...
  apexB: vec3f,   // ...and the back one (a loose crystal)
  ends: i32,      // the points in this cell (CRYS_END_*)
  len: f32,       // root face to apex, along d (cells)
  seed: f32,      // a hash of the crystal, in [0, 1)
}

// The crystal the last crystalHit landed on, for the look (gfx/surface.js
// crystalLook, which runs right after it on the same cell).
var<private> gCrysOn: bool = false;
var<private> gCrysCell: vec3i = vec3i(0);
var<private> gCrysKind: i32 = CRYS_CUT;
var<private> gCrys: Shard;

// Crystal from cell along dir: the steps to where it ends (1: the neighbour
// isn't crystal), and in *open whether open space ends it. Reaching past
// CRYS_RUN_MAX counts as rock; so does the box's floor, and the box's outside
// is open.
fn crysRun(cell: vec3i, dir: vec3i, open: ptr<function, bool>) -> i32 {
  for (var k = 1; k <= CRYS_RUN_MAX; k++) {
    let c = cell + dir * k;
    if (c.y < 0) { *open = false; return k; }
    if (outside(c)) { *open = true; return k; }
    let id = eid(fetchA(c));
    if (id == E_CRYSTAL) { continue; }
    *open = isGasLike(id) || SURFCH(id) == CH_LIQUID || RCLASS(id) == R_GLASS;
    return k;
  }
  *open = false;
  return CRYS_RUN_MAX + 1;
}

// Plane i of the point(s) (i < 6: the front point's faces, else the back's),
// as dot(p - s.o, *m) <= *dist.
fn crysPlane(s: Shard, i: i32, m: ptr<function, vec3f>, dist: ptr<function, f32>) {
  let hx = CRYS_HEX[i % 6];
  let nk = hx.x * s.u + hx.y * s.w;
  let front = i < 6;
  *m = normalize(CRYS_TIP_K * nk + select(-s.a, s.a, front));
  *dist = dot(select(s.apexB, s.apex, front) - s.o, *m);
}

// Ray (ro, rd) vs the crystal's piece in this cell, within [*tN, tF]: *tN
// becomes the entry and *n its face (left as passed in if the ray starts
// inside); *kind: which face (CRYS_*).
fn shardHit(s: Shard, ro: vec3f, rd: vec3f, tN: ptr<function, f32>, tF0: f32, n: ptr<function, vec3f>,
            kind: ptr<function, i32>) -> bool {
  let q = ro - s.o;
  var tF = tF0;
  *kind = CRYS_CUT;
  for (var i = 0; i < 3; i++) {
    let m = CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w;
    let dn = dot(rd, m);
    let dq = dot(q, m);
    if (abs(dn) < CRYS_RAY_EPS) {
      if (abs(dq) > s.r) { return false; }
      continue;
    }
    let ta = (-s.r - dq) / dn;
    let tb = (s.r - dq) / dn;
    let tin = min(ta, tb);
    if (tin > *tN) { *tN = tin; *n = -sign(dn) * m; *kind = CRYS_SIDE; }
    tF = min(tF, max(ta, tb));
  }
  for (var i = 0; i < 12; i++) {
    if ((s.ends & select(CRYS_END_BACK, CRYS_END_FRONT, i < 6)) == 0) { continue; }
    var m: vec3f;
    var d: f32;
    crysPlane(s, i, &m, &d);
    let dn = dot(rd, m);
    let dist = d - dot(q, m);
    if (dn < -CRYS_RAY_EPS) {
      let t = dist / dn;
      if (t > *tN) { *tN = t; *n = m; *kind = CRYS_TIP; }
    } else if (dn > CRYS_RAY_EPS) {
      tF = min(tF, dist / dn);
    } else if (dist < 0.0) {
      return false;
    }
  }
  return *tN <= tF;
}

// How far a ray from p (inside the crystal) along unit d runs before it
// leaves it (its piece in this cell has no end but its points: through the
// cell's faces the crystal carries on).
fn shardExit(s: Shard, p: vec3f, d: vec3f) -> f32 {
  let q = p - s.o;
  var t = 1e9;
  for (var i = 0; i < 3; i++) {
    let m = CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w;
    let dn = dot(d, m);
    let dq = dot(q, m);
    if (abs(dn) > CRYS_RAY_EPS) { t = min(t, (sign(dn) * s.r - dq) / dn); }
  }
  for (var i = 0; i < 12; i++) {
    if ((s.ends & select(CRYS_END_BACK, CRYS_END_FRONT, i < 6)) == 0) { continue; }
    var m: vec3f;
    var dist: f32;
    crysPlane(s, i, &m, &dist);
    let dn = dot(d, m);
    if (dn > CRYS_RAY_EPS) { t = min(t, (dist - dot(q, m)) / dn); }
  }
  return max(t, 0.0);
}

// The crystal running through cell (a crystal cell in the grid).
fn crysShard(cell: vec3i) -> Shard {
  // which way it runs (y first, so ties go up)
  var best = -1;
  var ax = 1;
  var fwd = CRYS_RUN_MAX + 2;
  var back = 0;
  var plus = true;
  for (var j = 0; j < 3; j++) {
    let k = (j + 1) % 3;   // y, z, x
    var e = vec3i(0);
    e[k] = 1;
    var oP: bool;
    var oM: bool;
    let kP = crysRun(cell, e, &oP);
    let kM = crysRun(cell, -e, &oM);
    var cls = 0;                         // rooted 2, loose 1, buried 0
    if (oP != oM) { cls = 2; } else if (oP) { cls = 1; }
    let pl = cls != 2 || oP;
    let f = select(kM, kP, pl);
    let bk = select(kP, kM, pl);
    if (cls > best || (cls == best && (f < fwd || (f == fwd && bk > back)))) {
      best = cls; ax = k; plus = pl; fwd = f; back = bk;
    }
  }
  let bestLen = fwd + back - 1;
  var s: Shard;
  s.d = vec3f(0.0);
  s.d[ax] = select(-1.0, 1.0, plus);
  let di = vec3i(s.d);
  let root = cell - di * (back - 1);   // the run's first cell
  let n = f32(bestLen);                // cells in the run
  let wr = worldPos(vec3f(root)) + f32(ax) * CRYS_SALT;
  let h1 = hash33(wr);
  let h2 = hash33(wr + CRYS_SALT2);
  s.seed = h2.z;
  let loose = best == 1;
  var rMax = CRYS_R_MAX;
  if (loose && bestLen == 1) { rMax = CRYS_R_LOOSE; }
  s.r = mix(CRYS_R_MIN, rMax, h1.x);
  // where it sits across its cells and how it leans, within the room it has
  var t1 = vec3f(0.0);
  var t2 = vec3f(0.0);
  t1[(ax + 1) % 3] = 1.0;
  t2[(ax + 2) % 3] = 1.0;
  let room = 0.5 - CRYS_CIRC * s.r - CRYS_GAP;
  let off = (2.0 * vec2f(h1.y, h1.z) - 1.0) * room * CRYS_OFF_SHARE;
  let lean = (2.0 * vec2f(h2.x, h2.y) - 1.0) * min((room - abs(off)) / n, vec2f(CRYS_TILT_MAX));
  let rootFace = vec3f(root) + 0.5 - s.d * 0.5;
  s.o = rootFace + t1 * off.x + t2 * off.y;
  let lv = s.d + t1 * lean.x + t2 * lean.y;   // the axis per cell along d
  s.a = normalize(lv);
  // the hexagon's turn about the axis
  let turn = h2.z * CRYS_TURN_MAX;
  let b1 = normalize(cross(s.a, t2));
  let b2 = cross(s.a, b1);
  s.u = cos(turn) * b1 + sin(turn) * b2;
  s.w = cross(s.a, s.u);
  // the point: its apex somewhere in the run's last cell, CRYS_TIP_IN from its face at most
  let tipH = CRYS_TIP_K * s.r * dot(s.a, s.d);   // the point's height along d
  var lo = CRYS_TIP_IN + tipH;
  if (loose) { lo = CRYS_TIP_IN + 2.0 * tipH - n + 1.0; }   // a loose one leaves room for its back point
  let hi = 1.0 - CRYS_TIP_IN;
  s.len = n - 1.0 + mix(max(lo, tipH), hi, hash13(wr + 2.0 * CRYS_SALT2));
  s.apex = s.o + lv * s.len;
  s.apexB = s.o + lv * CRYS_TIP_IN;
  let sk = (hash33(wr + 2.0 * CRYS_SALT).xy * 2.0 - 1.0) * CRYS_TIP_SKEW * s.r;
  s.apex += s.u * sk.x + s.w * sk.y;
  s.apexB -= s.u * sk.y + s.w * sk.x;
  var ends = 0;
  if (best >= 1 && fwd == 1) { ends = CRYS_END_FRONT; }
  if (loose && back == 1) { ends = ends | CRYS_END_BACK; }
  s.ends = ends;
  return s;
}

// The march crossing crystal cell over [tEnter, tExit]: true with the hit's
// *t and normal *n (*n comes in as the entry face) if it meets the cell's
// piece of crystal. Sets gCrys* for the look.
fn crystalHit(cell: vec3i, ro: vec3f, rd: vec3f, tEnter: f32, tExit: f32, t: ptr<function, f32>,
              n: ptr<function, vec3f>) -> bool {
  let s = crysShard(cell);
  var tk = tEnter;
  var nk = *n;
  var kind: i32;
  if (!shardHit(s, ro, rd, &tk, tExit, &nk, &kind)) { gCrysOn = false; return false; }
  gCrysOn = true;
  gCrysCell = cell;
  gCrysKind = kind;
  gCrys = s;
  *t = tk;
  *n = nk;
  return true;
}
`;

/** tools/check-wgsl.mjs: a probe kernel calling every function above (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('crystal');
