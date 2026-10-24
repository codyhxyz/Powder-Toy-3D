import { FILM_MIN_CELLS } from '../../gfx/materials.js';
import { FULL } from '../../v2/layout.js';
import { glf } from '../../glsl.js';

// Thin water: films and puddles at their true thickness.
//
// The render fields can't hold a surface lower than about FILM_MIN_CELLS over
// a floor (gfx/materials.js: the box's edge clamps the field there, and a
// crisp bed counts neither way), so a 2 cm puddle drew nothing. A liquid cell
// resting on a floor (the box's, or solid matter) with less than that in it is
// a film instead: the fields leave it out (shaders/fields.js), and the tracer
// meets its top as an analytic height field, floor + fill, in the cell
// (filmHit). V2 keeps the exact fill (v2/layout.js FULL), so the film is as
// thick as the water it holds: 0.1 of a cell is 3 cm.
//
// The film's outline and thickness are quadratic B-splines over the 3×3 of
// cells around (the fields' smoothing, done analytically): wet, the spline of
// "holds water" (a film or deeper liquid 1, dry floor 0), and the water's
// mean depth over the wet cells. The edge is where wet is 1/2: on the shared
// face across a straight rim, cutting a staircase's corners on the diagonal,
// so a puddle's outline reads round, not as square cells. Walls and solid
// matter count neither way (as in the fields' blur), so water lies flat up to
// them. A deeper neighbour counts as FILM_MIN_CELLS deep: the film rises to
// meet the pool the fields draw from there. Toward the edge the depth falls
// to zero over FILM.MENISCUS of wet, about a third of a cell: the rounded lip
// a puddle's surface tension gives it (a 3 cm puddle meets the floor at
// ~10-20°, about water's contact angle on concrete). A dry floor cell next to
// a film is traced too, so the lip may spill past the film's own cells.
// Under FILM.EDGE_CELLS of water the floor is dry.
//
// It is crossed going in only, from above. Refraction, reflection and the
// ripples are the liquid surface's own (shaders/render.js's event, gfx/liquid.js
// liquidInterface, liquidDetail); inside, the fields hold no surface, so the
// march is back in air at once and goes on to the floor, which the film
// darkens (FILM_WET_ALBEDO) and tints by its own thin path (filmTint).
// Shadows and traced reflections pass films by, as they pass every liquid
// surface: a film casts no shadow worth drawing and floats over nothing.
export const FILM = {
  EDGE_CELLS: 0.003,     // cells (~1 mm): thinner than this, the floor is dry
  ITER: 3,               // fixed-point steps onto the height field (gentle: under FILM_MIN_CELLS / MENISCUS·(wet's slope) per cell)
  MENISCUS: 0.25,        // of wet (1/2 at the edge, 7/8 a cell centre in from a straight rim): the lip's width
  // Wet floors darken: light that enters a wet surface is reflected back down
  // at the water's top (total internal reflection) and absorbed again, so a
  // wet rough surface reflects ~0.5-0.7 of what it did dry (Lekner & Dorf
  // 1988, Appl. Opt. 27, 1278; Twomey, Bohren & Mergenthaler 1986).
  WET_ALBEDO: 0.6,
  COS_MIN: 0.2,          // the shallowest descent the film's slant path is figured for (beyond it, grazing light is reflected anyway)
};

// The cell helpers, for any module with the state's native reader
// (fetchNativeCore), eid/fetchA and the element tables: the fields, the brick
// pass and the tracer share them, so all three agree which cells are films.
export const filmCellsWGSL = /* wgsl */ `
const FILM_FILL_MAX: f32 = ${glf(FILM_MIN_CELLS)};   // cells: the fields draw resting water from this fill up
const FILM_FULL: f32 = ${FULL}.0;                     // a whole cell in V2's fill units
// (liquid id, fill in cells) at c, or (-1, 0)
fn filmLiquid(c: vec3i) -> vec2f {
  let core = fetchNativeCore(c);
  let id = i32(core.x & 255u);
  if (KIND(id) != K_LIQUID || (core.y & 0xffffffu) == 0u) { return vec2f(-1.0, 0.0); }
  return vec2f(f32(id), f32(core.y & 0xffffffu) / FILM_FULL);
}
// is there a floor under c: the box's, or solid matter (not liquid, a gas or air)
fn filmFloorUnder(c: vec3i) -> bool {
  let q = c - vec3i(0, 1, 0);
  if (q.y < 0) { return true; }
  let k = KIND(eid(fetchA(q)));
  return k == K_SOLID || k == K_POWDER;
}
// (liquid id, fill) if c is a film: liquid resting on a floor, thinner than the fields show; else (-1, 0)
fn filmAt(c: vec3i) -> vec2f {
  let l = filmLiquid(c);
  if (l.y <= 0.0 || l.y >= FILM_FILL_MAX || !filmFloorUnder(c)) { return vec2f(-1.0, 0.0); }
  return l;
}`;

// The tracer's part (after filmCellsWGSL, in the volume's module).
export const filmTraceWGSL = /* wgsl */ `
const FILM_EDGE_CELLS: f32 = ${glf(FILM.EDGE_CELLS)};
const FILM_ITER: i32 = ${FILM.ITER};
const FILM_WET_ALBEDO: f32 = ${glf(FILM.WET_ALBEDO)};
const FILM_COS_MIN: f32 = ${glf(FILM.COS_MIN)};
const FILM_MENISCUS: f32 = ${glf(FILM.MENISCUS)};
const FILM_WET_EDGE: f32 = 0.5;   // wet's level on the outline: midway between a wet and a dry cell
// What a cell adds to the splines: (counts, wet, depth); walls count neither way.
fn filmCell(q: vec3i) -> vec3f {
  if (outside(q)) { return vec3f(0.0); }   // the box's wall
  let f = filmAt(q);
  if (f.y > 0.0) { return vec3f(1.0, 1.0, f.y); }
  let l = filmLiquid(q);
  if (l.y > 0.0) { return vec3f(1.0, 1.0, FILM_FILL_MAX); }   // deeper: the fields' pool
  let k = KIND(eid(fetchA(q)));
  if (k == K_SOLID || k == K_POWDER) { return vec3f(0.0); }
  return vec3f(1.0, 0.0, 0.0);   // dry
}
// The quadratic B-spline's weights for the centres at -1, 0, +1 at offset u
// (cells, -1/2..1/2) from the middle one, and their slopes.
fn filmSpline(u: f32) -> vec3f { return vec3f(0.5 * (0.5 - u) * (0.5 - u), 0.75 - u * u, 0.5 * (0.5 + u) * (0.5 + u)); }
fn filmSplineD(u: f32) -> vec3f { return vec3f(u - 0.5, -2.0 * u, u + 0.5); }
// The ray's entry into the film over [ta, tb] in cell (a film's, or dry floor
// beside one): its t (NO_HIT if none), the surface normal, the liquid and the
// film's depth there (cells).
fn filmHit(cell: vec3i, ro: vec3f, rd: vec3f, ta: f32, tb: f32,
           n: ptr<function, vec3f>, lid: ptr<function, i32>, h: ptr<function, f32>) -> f32 {
  if (rd.y >= 0.0) { return NO_HIT; }
  let base = f32(cell.y);
  if (ro.y + rd.y * tb - base > FILM_FILL_MAX) { return NO_HIT; }   // (the segment stays above any film)
  let own = filmCell(cell);
  if (own.x == 0.0 || (own.z == 0.0 && !filmFloorUnder(cell))) { return NO_HIT; }   // (solid, or air over no floor)
  if (own.z >= FILM_FILL_MAX) { return NO_HIT; }   // (deeper water: the fields')
  // the 3×3 around: counts, wet, depth (row z, column x), and a film's liquid
  var cw: array<vec3f, 3>;
  var ci: array<vec3f, 3>;
  var cf: array<vec3f, 3>;
  var liquid = E_EMPTY;
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 3; i++) {
      let q = cell + vec3i(i - 1, 0, j - 1);
      let v = filmCell(q);
      cw[j][i] = v.x; ci[j][i] = v.y; cf[j][i] = v.z;
      if (v.y > 0.0 && liquid == E_EMPTY) { liquid = i32(filmLiquid(q).x); }
    }
  }
  if (liquid == E_EMPTY) { return NO_HIT; }   // (dry all around)
  let c = vec2f(cell.xz) + 0.5;
  var t = clamp((base + max(own.z, FILM_EDGE_CELLS) - ro.y) / rd.y, ta, tb);
  var hh = 0.0;
  var grad = vec2f(0.0);
  for (var k = 0; k < FILM_ITER; k++) {
    let uv = clamp(ro.xz + rd.xz * t - c, vec2f(-0.5), vec2f(0.5));
    let wx = filmSpline(uv.x); let wz = filmSpline(uv.y);
    let dx = filmSplineD(uv.x); let dz = filmSplineD(uv.y);
    // each spline and its slope (x, z): rows blended along x, then along z
    let rw = vec3f(dot(wx, cw[0]), dot(wx, cw[1]), dot(wx, cw[2]));
    let ri = vec3f(dot(wx, ci[0]), dot(wx, ci[1]), dot(wx, ci[2]));
    let rf = vec3f(dot(wx, cf[0]), dot(wx, cf[1]), dot(wx, cf[2]));
    let sw = dot(wz, rw); let si = dot(wz, ri); let sf = dot(wz, rf);
    let gw = vec2f(dot(wz, vec3f(dot(dx, cw[0]), dot(dx, cw[1]), dot(dx, cw[2]))), dot(dz, rw));
    let gi = vec2f(dot(wz, vec3f(dot(dx, ci[0]), dot(dx, ci[1]), dot(dx, ci[2]))), dot(dz, ri));
    let gf = vec2f(dot(wz, vec3f(dot(dx, cf[0]), dot(dx, cf[1]), dot(dx, cf[2]))), dot(dz, rf));
    let wet = si / max(sw, FILM_EDGE_CELLS);
    let depth = sf / max(si, FILM_EDGE_CELLS);
    let gwet = (gi * sw - si * gw) / max(sw * sw, FILM_EDGE_CELLS);
    let gdepth = (gf * si - sf * gi) / max(si * si, FILM_EDGE_CELLS);
    let x = clamp((wet - FILM_WET_EDGE) / FILM_MENISCUS, 0.0, 1.0);
    let lip = x * x * (3.0 - 2.0 * x);
    hh = depth * lip;
    grad = gdepth * lip + depth * (6.0 * x * (1.0 - x) / FILM_MENISCUS) * gwet;
    t = (base + hh - ro.y) / rd.y;
  }
  if (t < ta || t > tb || hh < FILM_EDGE_CELLS) { return NO_HIT; }
  *n = normalize(vec3f(-grad.x, 1.0, -grad.y));
  *lid = liquid;
  *h = hh;
  return t;
}
// What the floor seen through a film keeps: the film's own absorption down
// and back up through thickness h along rd, and the wet floor's darkening.
fn filmTint(lid: i32, h: f32, rd: vec3f) -> vec3f {
  return exp(-SIGMA(lid) * (2.0 * h / max(-rd.y, FILM_COS_MIN))) * FILM_WET_ALBEDO;
}`;
