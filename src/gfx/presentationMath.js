// Presentation coordinates are canonical world cells, never simulation-local.
// Animal Crossing's rolling-log horizon, approximated by a parabola. Physics
// stays flat (as in Minecraft's render-only view effects).
export const ROLLING_LOG = Object.freeze({ k: 1 / 2048, chordError: 1 / 1024 });
export const IDENTITY = Object.freeze({ k: 0, anchor: [0, 0], dir: [0, 1] });
export function effectParameters(k = 0, anchor = [0, 0], dir = [0, 1]) {
  if (![k, ...anchor, ...dir].every(Number.isFinite) || k < 0) throw new Error('Invalid presentation parameters');
  const n = Math.hypot(...dir);
  return { k, anchor: [...anchor], dir: n > 1e-8 ? dir.map(x => x / n) : [0, 1] };
}
export function warp(p, e = IDENTITY, inverse = false) {
  const q = [...p];
  if (e.k) {
    const s = (p[0] - e.anchor[0]) * e.dir[0] + (p[2] - e.anchor[1]) * e.dir[1];
    q[1] += (inverse ? 1 : -1) * e.k * s * s;
  }
  return q;
}
export function warpTangent(p, d, e = IDENTITY, inverse = false) {
  const q = [...d];
  const s = (p[0] - e.anchor[0]) * e.dir[0] + (p[2] - e.anchor[1]) * e.dir[1];
  q[1] += (inverse ? 1 : -1) * 2 * e.k * s * (d[0] * e.dir[0] + d[2] * e.dir[1]);
  return q;
}
// t is distance on the displayed ray. B must NOT be normalized.
export function inverseRay(o, d, e = IDENTITY) {
  const v = d[0] * e.dir[0] + d[2] * e.dir[1];
  return { C: warp(o, e, true), B: warpTangent(o, d, e, true), A: [0, e.k * v * v, 0] };
}
export const rayPoint = (r, t) => r.C.map((c, i) => c + (r.B[i] + r.A[i] * t) * t);
export const rayTangent = (r, t) => r.B.map((b, i) => b + 2 * r.A[i] * t);
export function rayCell(r, t) {
  return rayPoint(r,t).map((v,i) => {
    const plane=Math.round(v), established=planeRoots(r,i,plane).includes(t);
    if (!established) return Math.floor(v);
    const d=rayTangent(r,t)[i];
    return plane-(d<0 || (d===0 && r.A[i]<0) ? 1 : 0);
  });
}
export function rayEntryAxis(r,t) {
  const p=rayPoint(r,t), d=rayTangent(r,t);
  const distances=p.map((v,i)=>d[i]===0 ? Infinity : Math.abs(v-Math.round(v))/Math.max(Math.abs(d[i]),1e-5));
  return distances.indexOf(Math.min(...distances));
}
export function arcLength(r, a, b) {
  const length=t=>Math.hypot(...rayTangent(r,t)), mid=(a+b)/2;
  if (Math.abs(2*r.A[1]*(b-a)) < 0.01*Math.max(length(mid),1e-8))
    return (b-a)*(length(a)+4*length(mid)+length(b))/6;
  const h2=Math.max(r.B[0]**2+r.B[2]**2,1e-12);
  const primitive=y=>0.5*(y*Math.sqrt(h2+y*y)+h2*Math.asinh(y/Math.sqrt(h2)));
  return (primitive(r.B[1]+2*r.A[1]*b)-primitive(r.B[1]+2*r.A[1]*a))/(2*r.A[1]);
}
export function roots(a, b, c) {
  if (a === 0) return b === 0 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  if (disc === 0) return [-b / (2 * a)];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
  return [q / a, c / q].sort((x, y) => x - y);
}
export const planeRoots = (r, axis, level) => roots(r.A[axis], r.B[axis], r.C[axis] - level);
// Include both disconnected spans. A tangent alone has no interior interval.
export function boxSpans(r, lo, hi, start = 0, end = 1e9) {
  const cuts = [start, end];
  for (let i = 0; i < 3; i++) for (const h of [lo[i], hi[i]])
    for (const t of planeRoots(r, i, h)) if (t > start && t < end) cuts.push(t);
  cuts.sort((a, b) => a - b);
  const spans = [];
  for (let j = 1; j < cuts.length; j++) {
    const a = cuts[j - 1], b = cuts[j];
    if (b <= a) continue;
    const p = rayPoint(r, (a + b) / 2);
    if (p.every((v, i) => v >= lo[i] && v < hi[i])) {
      if (spans.length && spans.at(-1)[1] === a) spans.at(-1)[1] = b;
      else spans.push([a, b]);
    }
  }
  return spans;
}
// First outward crossing; parallel faces and directional tangencies do not exit.
export function nextExit(r, lo, hi, t) {
  let end = Infinity, axis = -1;
  for (let i = 0; i < 3; i++) for (const side of [0, 1]) {
    for (const x of planeRoots(r, i, side ? hi[i] : lo[i])) {
      const v = r.B[i] + 2 * r.A[i] * x;
      if (x >= t - 1e-9 && (side ? v > 0 : v < 0) && x < end) { end = x; axis = i; }
    }
  }
  return { t: end, axis };
}
export const chordLimit = r => r.A[1] ? 2 * Math.sqrt(ROLLING_LOG.chordError / Math.abs(r.A[1])) : Infinity;

// Shared only by presentation passes; never injected into render.lib (shadows,
// probes, physics and navigation also import it). A is vertical by construction.
export const presentationGLSL = /* glsl */ `
uniform float uWarpK;
uniform vec2 uWarpAnchor, uWarpDir;
#define WARP_INF 1e9
#define WARP_EPS 1e-5
#define WARP_CHORD_ERROR ${ROLLING_LOG.chordError.toFixed(10)}
vec3 warpPointWith(vec3 p, float k, vec2 anchor, vec2 dir) {
  float s = dot(p.xz - anchor, dir); p.y -= k * s * s; return p;
}
vec3 warpPoint(vec3 p) { return warpPointWith(p, uWarpK, uWarpAnchor, uWarpDir); }
vec3 unwarpPoint(vec3 p) { return warpPointWith(p, -uWarpK, uWarpAnchor, uWarpDir); }
vec3 warpVector(vec3 p, vec3 d) {
  d.y -= 2.0 * uWarpK * dot(p.xz - uWarpAnchor, uWarpDir) * dot(d.xz, uWarpDir); return d;
}
struct WarpRay { vec3 C; vec3 B; vec3 A; };
WarpRay warpRay(vec3 o, vec3 d) {
  float s = dot(o.xz - uWarpAnchor, uWarpDir), v = dot(d.xz, uWarpDir);
  return WarpRay(unwarpPoint(o), d + vec3(0.0, 2.0 * uWarpK * s * v, 0.0), vec3(0.0, uWarpK * v * v, 0.0));
}
vec3 warpAt(WarpRay r, float t) { return r.C + (r.B + r.A * t) * t; }
vec3 warpSlope(WarpRay r, float t) { return r.B + 2.0 * r.A * t; }
vec2 warpRoots(float a, float b, float c) {
  if (a == 0.0) return b == 0.0 ? vec2(WARP_INF) : vec2(-c / b, WARP_INF);
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return vec2(WARP_INF);
  if (disc == 0.0) return vec2(-b / (2.0 * a), WARP_INF);
  float q = -0.5 * (b + (b < 0.0 ? -1.0 : 1.0) * sqrt(disc));
  return vec2(min(q / a, c / q), max(q / a, c / q));
}
vec2 warpPlane(WarpRay r, int axis, float level) { return warpRoots(r.A[axis], r.B[axis], r.C[axis] - level); }
// x/z are linear, so first clip those slabs. Only y can split the interval.
vec4 warpSpans(WarpRay r, vec3 lo, vec3 hi, float start, float end) {
  for (int j = 0; j < 2; j++) {
    int i = j * 2;
    if (r.B[i] == 0.0) { if (r.C[i] < lo[i] || r.C[i] >= hi[i]) return vec4(WARP_INF); }
    else {
      float a = (lo[i] - r.C[i]) / r.B[i], b = (hi[i] - r.C[i]) / r.B[i];
      start = max(start, min(a,b)); end = min(end, max(a,b));
    }
  }
  if (end <= start) return vec4(WARP_INF);
  vec2 a = warpPlane(r, 1, lo.y), b = warpPlane(r, 1, hi.y);
  float cuts[6]; cuts[0] = start; cuts[1] = end;
  cuts[2] = clamp(a.x,start,end); cuts[3] = clamp(a.y,start,end);
  cuts[4] = clamp(b.x,start,end); cuts[5] = clamp(b.y,start,end);
  for (int i = 1; i < 6; i++) for (int j = 0; j < 5; j++) {
    if (j < 6-i && cuts[j] > cuts[j+1]) { float v = cuts[j]; cuts[j] = cuts[j+1]; cuts[j+1] = v; }
  }
  vec4 spans = vec4(WARP_INF); int n = 0;
  for (int i = 0; i < 5; i++) {
    float y = warpAt(r, 0.5 * (cuts[i] + cuts[i+1])).y;
    if (cuts[i+1] <= cuts[i] || y < lo.y || y >= hi.y) continue;
    if (n > 0 && spans[n*2-1] == cuts[i]) spans[n*2-1] = cuts[i+1];
    else if (n < 2) { spans[n*2] = cuts[i]; spans[n*2+1] = cuts[i+1]; n++; }
  }
  return spans;
}
bool warpInside(float t, vec4 spans) { return (t >= spans.x && t < spans.y) || (t >= spans.z && t < spans.w); }
float warpResume(float t, vec4 spans) {
  if (t < spans.x) return spans.x;
  if (t < spans.y) return t;
  if (t < spans.z) return spans.z;
  return t < spans.w ? t : WARP_INF;
}
// Exact exits preserve brick/hierarchy skipping and both sides of a turn.
vec2 warpExit(WarpRay r, vec3 lo, vec3 hi, float t) {
  vec2 outp = vec2(WARP_INF, 0.0);
  for (int axis = 0; axis < 3; axis++) for (int side = 0; side < 2; side++) {
    vec2 roots = warpPlane(r, axis, side == 0 ? lo[axis] : hi[axis]);
    for (int j = 0; j < 2; j++) {
      float x = roots[j], v = warpSlope(r, x)[axis];
      if (x >= t - WARP_EPS && x < outp.x && (side == 0 ? v < 0.0 : v > 0.0)) outp = vec2(x, float(axis));
    }
  }
  return outp;
}
float warpChordLimit(WarpRay r) { return r.A.y > 0.0 ? 2.0 * sqrt(WARP_CHORD_ERROR / r.A.y) : WARP_INF; }
float warpArcPrimitive(float y, float h2) {
  float h = sqrt(h2), len = sqrt(h2+y*y);
  return 0.5*(y*len + h2*sign(y)*log((abs(y)+len)/h));
}
float warpArc(WarpRay r, float a, float b) {
  if (r.A.y == 0.0) return length(r.B)*(b-a);
  // Nearly linear (including float32-equal primitive arguments): integrate
  // speed locally, rather than subtracting huge almost-equal primitives.
  float mid = 0.5*(a+b);
  if (abs(2.0*r.A.y*(b-a)) < 0.01*max(length(warpSlope(r,mid)),1e-8))
    return (b-a)*(length(warpSlope(r,a))+4.0*length(warpSlope(r,mid))+length(warpSlope(r,b)))/6.0;
  float h2 = max(dot(r.B.xz,r.B.xz),1e-12);
  return (warpArcPrimitive(r.B.y+2.0*r.A.y*b,h2)-warpArcPrimitive(r.B.y+2.0*r.A.y*a,h2))/(2.0*r.A.y);
}
// Outgoing ownership applies ONLY at an established plane root, never to an
// arbitrary point close to a boundary. Re-solving the nearest plane recognizes
// computed crossings despite roundoff in warpAt, including simultaneous exits.
ivec3 warpCell(WarpRay r, float t) {
  vec3 p = warpAt(r, t), d = warpSlope(r,t);
  ivec3 c = ivec3(floor(p));
  for (int i=0; i<3; i++) {
    float plane = round(p[i]);
    vec2 roots = warpPlane(r,i,plane);
    if (t != roots.x && t != roots.y) continue;
    c[i] = int(plane);
    if (d[i] < 0.0 || (d[i] == 0.0 && r.A[i] < 0.0)) c[i]--;
  }
  return c;
}
// The traversal already KNOWS which face it crossed. Keep that fact: on Metal,
// re-solving the same quadratic in another inlined function can differ by an
// ULP, leaving the ray in its old cell forever. Only established exits use this
// ownership rule; an arbitrary near-face starting point is never snapped.
ivec3 warpCellAfter(WarpRay r, float t, int crossedAxis) {
  vec3 p = warpAt(r,t), d = warpSlope(r,t);
  ivec3 c = warpCell(r,t);
  float tolerance = 4.0 * 1.1920929e-7 * max(abs(t),1.0);
  for (int i=0; i<3; i++) {
    if (d[i] == 0.0) continue;
    float plane = round(p[i]);
    vec2 roots = warpPlane(r,i,plane);
    // Simultaneous faces may have independently rounded roots.
    if (i != crossedAxis && min(abs(roots.x-t),abs(roots.y-t)) > tolerance) continue;
    c[i] = int(plane) - (d[i] < 0.0 ? 1 : 0);
  }
  return c;
}
int warpEntryAxis(WarpRay r, float t) {
  vec3 p = warpAt(r,t), d = warpSlope(r,t);
  vec3 dist = abs(p-round(p)) / max(abs(d),vec3(WARP_EPS));
  for (int i=0; i<3; i++) if (d[i] == 0.0) dist[i] = WARP_INF;
  return dist.x <= dist.y && dist.x <= dist.z ? 0 : (dist.y <= dist.z ? 1 : 2);
}
`;
