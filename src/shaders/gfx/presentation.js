import { presentationWGSL } from '../../gfx/presentationMath.js';

// Adapter between exact quadratic grid traversal and the existing unit-ray
// material kernels. Chords stay INSIDE one cell and deviate by <=1/1024 cell.
// Empty regions remain exact, single jumps, independent of that error bound.
// Outgoing local-flat rays restart through warpRestart.
//
// WGSL (docs/webgpu.md W2: the GLSL's names). In grid cells: the header's
// origin (H.origin, the GLSL's uOrigin) takes them to the world cells the
// effect is anchored in. It needs the prelude's header, GRID and outside()
// (shaders/gfx/core.js ddaGLSL); warpSkip also the brick distances of the
// lighting group (brickDistAt), so a kernel without them (the pick) takes
// presentationNearWGSL({ skip: false }). A WarpWalk lives in a function-scope
// var: the functions that advance it take a pointer to it (H1.11).
export const presentationNearWGSL = ({ skip = true } = {}) => /* wgsl */ `
${presentationWGSL}
struct WarpWalk { ray: WarpRay, spans: vec4f, t: f32, end: f32, axis: i32, endAxis: i32, boundary: bool }
fn warpWalk(ro: vec3f, rd: vec3f, nearT: f32) -> WarpWalk {
  let o = vec3f(H.origin);
  var r = warpRay(ro + o, rd);
  r.C -= o;
  let spans = warpSpans(r, vec3f(0.0), vec3f(GRID), nearT, WARP_INF);
  return WarpWalk(r, spans, spans.x, spans.x, warpEntryAxis(r, spans.x), -1, spans.x > nearT);
}
fn warpRestart(w: ptr<function, WarpWalk>, p: vec3f, d: vec3f) {
  // Optical/relief kernels return a LOCAL FLAT direction. Push it forward,
  // then invert the new displayed ray: curvature continues after the bend.
  let world = p + vec3f(H.origin);
  *w = warpWalk(warpPoint(world) - vec3f(H.origin), normalize(warpVector(world, d)), 0.0);
}
fn warpLocate(w: ptr<function, WarpWalk>, cell: ptr<function, vec3i>) -> bool {
  let next = warpResume((*w).t, (*w).spans);
  if (next != (*w).t) {
    (*w).axis = warpEntryAxis((*w).ray, next);
    (*w).boundary = true;
  }
  (*w).t = next;
  if ((*w).t >= WARP_INF) { return false; }
  if ((*w).boundary) { *cell = warpCellAfter((*w).ray, (*w).t, (*w).axis); }
  else { *cell = warpCell((*w).ray, (*w).t); }
  return !outside(*cell);
}
fn warpSegment(w: ptr<function, WarpWalk>, cell: ptr<function, vec3i>, ro: ptr<function, vec3f>, rd: ptr<function, vec3f>,
               lengthT: ptr<function, f32>, exitAxis: ptr<function, i32>) -> bool {
  if (!warpLocate(w, cell)) { return false; }
  let ex = warpExit((*w).ray, vec3f(*cell), vec3f(*cell + 1), (*w).t);
  (*w).end = min(ex.x, (*w).t + warpChordLimit((*w).ray));
  (*w).endAxis = select(-1, i32(ex.y), (*w).end == ex.x);
  if ((*w).end <= (*w).t) { return false; }
  *ro = warpAt((*w).ray, (*w).t);
  let delta = warpAt((*w).ray, (*w).end) - *ro;
  *lengthT = length(delta);
  *rd = delta / max(*lengthT, 1e-8);
  *exitAxis = i32(ex.y);
  return true;
}
fn warpAdvance(w: ptr<function, WarpWalk>) {
  (*w).t = (*w).end;
  (*w).boundary = (*w).endAxis >= 0;
  if ((*w).boundary) { (*w).axis = (*w).endAxis; } else { (*w).axis = warpEntryAxis((*w).ray, (*w).t); }
}${skip ? `
fn warpSkip(w: ptr<function, WarpWalk>, bc: vec3i, distanceSkip: bool) {
  var r = 0;
  if (distanceSkip) { r = max(brickDistAt(bc), 0); }
  let lo = vec3f(max(bc - r, vec3i(0)) * BS);
  let hi = vec3f(min(bc + r + 1, vec3i(BX, BY, BZ)) * BS);
  let ex = warpExit((*w).ray, lo, hi, (*w).t);
  (*w).t = ex.x;
  (*w).axis = i32(ex.y);
  (*w).boundary = true;
}` : ''}
fn warpFloor(w: WarpWalk, p: ptr<function, vec3f>, t: ptr<function, f32>) -> bool {
  let roots = warpPlane(w.ray, 1, 0.0);
  *t = roots.x;
  *p = warpAt(w.ray, *t);
  return *t >= 0.0 && *t < WARP_INF && w.t >= *t - WARP_EPS && warpSlope(w.ray, *t).y < 0.0
    && all((*p).xz >= vec2f(0.0)) && all((*p).xz < vec2f(GRID.xz));
}
fn warpGridPoint(p: vec3f) -> vec3f { return warpPoint(p + vec3f(H.origin)) - vec3f(H.origin); }
`;
// the walk with its brick skipping, under the GLSL's name (docs/webgpu.md W2; U16 renames it)
export const presentationNearGLSL = presentationNearWGSL();
