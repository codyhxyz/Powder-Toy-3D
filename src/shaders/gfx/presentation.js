import { presentationGLSL } from '../../gfx/presentationMath.js';

// Adapter between exact quadratic grid traversal and the existing unit-ray
// material kernels. Chords stay INSIDE one cell and deviate by <=1/1024 cell.
// Empty regions remain exact, single jumps, independent of that error bound.
// reliefHit retains its 1.5-cell shell past a segment: extrapolation there is
// bounded by k*1.5*(sqrt(2)+1.5) < 1/256 cell (check-presentation.mjs). Its
// outgoing local-flat ray is explicitly restarted through warpRestart.
export const presentationNearGLSL = /* glsl */ `
${presentationGLSL}
struct WarpWalk { WarpRay ray; vec4 spans; float t; float end; int axis; int endAxis; bool boundary; };
WarpWalk warpWalk(vec3 ro, vec3 rd, float nearT) {
  WarpRay r = warpRay(ro + vec3(uOrigin), rd);
  r.C -= vec3(uOrigin);
  vec4 spans = warpSpans(r, vec3(0.0), vec3(GRID), nearT, WARP_INF);
  return WarpWalk(r, spans, spans.x, spans.x, warpEntryAxis(r, spans.x), -1, spans.x > nearT);
}
void warpRestart(inout WarpWalk w, vec3 p, vec3 d) {
  // Optical/relief kernels return a LOCAL FLAT direction. Push it forward,
  // then invert the new displayed ray: curvature continues after the bend.
  vec3 world = p + vec3(uOrigin);
  w = warpWalk(warpPoint(world) - vec3(uOrigin), normalize(warpVector(world, d)), 0.0);
}
bool warpLocate(inout WarpWalk w, out ivec3 cell) {
  float next = warpResume(w.t, w.spans);
  if (next != w.t) {
    w.axis = warpEntryAxis(w.ray,next);
    w.boundary = true;
  }
  w.t = next;
  if (w.t >= WARP_INF) return false;
  cell = w.boundary ? warpCellAfter(w.ray,w.t,w.axis) : warpCell(w.ray,w.t);
  return !outside(cell);
}
bool warpSegment(inout WarpWalk w, out ivec3 cell, out vec3 ro, out vec3 rd, out float lengthT, out int exitAxis) {
  if (!warpLocate(w,cell)) return false;
  vec2 ex = warpExit(w.ray, vec3(cell), vec3(cell+1), w.t);
  w.end = min(ex.x, w.t + warpChordLimit(w.ray));
  w.endAxis = w.end == ex.x ? int(ex.y) : -1;
  if (w.end <= w.t) return false;
  ro = warpAt(w.ray, w.t);
  vec3 delta = warpAt(w.ray, w.end) - ro;
  lengthT = length(delta); rd = delta / max(lengthT,1e-8);
  exitAxis = int(ex.y);
  return true;
}
void warpAdvance(inout WarpWalk w) {
  w.t = w.end;
  w.boundary = w.endAxis >= 0;
  w.axis = w.boundary ? w.endAxis : warpEntryAxis(w.ray,w.t);
}
void warpSkip(inout WarpWalk w, ivec3 bc, bool distanceSkip) {
  int r = distanceSkip ? max(int(texelFetch(tBrickDist, brickAtlas(bc), 0).x * BRICK_DIST_SCALE + 0.5)-1,0) : 0;
  vec3 lo = vec3(max(bc-r,ivec3(0))*BS), hi = vec3(min(bc+r+1,ivec3(BX,BY,BZ))*BS);
  vec2 ex = warpExit(w.ray,lo,hi,w.t);
  w.t = ex.x; w.axis = int(ex.y); w.boundary = true;
}
bool warpFloor(WarpWalk w, out vec3 p, out float t) {
  vec2 roots = warpPlane(w.ray,1,0.0);
  t = roots.x; p = warpAt(w.ray,t);
  return t >= 0.0 && t < WARP_INF && w.t >= t-WARP_EPS && warpSlope(w.ray,t).y < 0.0
    && all(greaterThanEqual(p.xz,vec2(0.0))) && all(lessThan(p.xz,vec2(GRID.xz)));
}
vec3 warpGridPoint(vec3 p) { return warpPoint(p + vec3(uOrigin)) - vec3(uOrigin); }
`;
