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
// A parabola's highest point can lie inside the box, not at a corner.
export function warpBox(box, e = IDENTITY, out = box) {
  out.copy(box);
  if (!e.k || box.isEmpty()) return out;
  const x0 = (box.min.x - e.anchor[0]) * e.dir[0], x1 = (box.max.x - e.anchor[0]) * e.dir[0];
  const z0 = (box.min.z - e.anchor[1]) * e.dir[1], z1 = (box.max.z - e.anchor[1]) * e.dir[1];
  const lo = Math.min(x0, x1) + Math.min(z0, z1), hi = Math.max(x0, x1) + Math.max(z0, z1);
  const minSq = lo <= 0 && hi >= 0 ? 0 : Math.min(lo * lo, hi * hi);
  const a = e.k * minSq, b = e.k * Math.max(lo * lo, hi * hi);
  out.min.y -= Math.max(a, b);
  out.max.y -= Math.min(a, b);
  return out;
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


// The WGSL twin of the mapping above, for the passes that draw the world
// bent (the volume's chord march, the far view, the pick, TAA's
// reprojection; shaders/gfx/presentation.js walks the grid with it). Never
// pasted into the render library: shadows, probes, physics and navigation
// stay flat. A is vertical by construction. Every entry point that pastes it
// calls warpUse(k, anchor, dir) first with the effect's parameters from its
// own params (they are the GLSL's uWarpK, uWarpAnchor, uWarpDir uniforms).
// Same function names as the GLSL had (docs/webgpu.md W2); the name of the
// export too until the *GLSL → *WGSL rename (U16).
export const presentationWGSL = /* wgsl */ `
var<private> gWarpK: f32;
var<private> gWarpAnchor: vec2f;
var<private> gWarpDir = vec2f(0.0, 1.0);
fn warpUse(k: f32, anchor: vec2f, dir: vec2f) { gWarpK = k; gWarpAnchor = anchor; gWarpDir = dir; }
const WARP_INF: f32 = 1e9;
const WARP_EPS: f32 = 1e-5;
const WARP_CHORD_ERROR: f32 = ${ROLLING_LOG.chordError.toFixed(10)};
fn warpPointWith(p: vec3f, k: f32, anchor: vec2f, dir: vec2f) -> vec3f {
  let s = dot(p.xz - anchor, dir);
  return vec3f(p.x, p.y - k * s * s, p.z);
}
fn warpPoint(p: vec3f) -> vec3f { return warpPointWith(p, gWarpK, gWarpAnchor, gWarpDir); }
fn unwarpPoint(p: vec3f) -> vec3f { return warpPointWith(p, -gWarpK, gWarpAnchor, gWarpDir); }
fn warpVector(p: vec3f, d: vec3f) -> vec3f {
  return vec3f(d.x, d.y - 2.0 * gWarpK * dot(p.xz - gWarpAnchor, gWarpDir) * dot(d.xz, gWarpDir), d.z);
}
struct WarpRay { C: vec3f, B: vec3f, A: vec3f }
fn warpRay(o: vec3f, d: vec3f) -> WarpRay {
  let s = dot(o.xz - gWarpAnchor, gWarpDir);
  let v = dot(d.xz, gWarpDir);
  return WarpRay(unwarpPoint(o), d + vec3f(0.0, 2.0 * gWarpK * s * v, 0.0), vec3f(0.0, gWarpK * v * v, 0.0));
}
fn warpAt(r: WarpRay, t: f32) -> vec3f { return r.C + (r.B + r.A * t) * t; }
fn warpSlope(r: WarpRay, t: f32) -> vec3f { return r.B + 2.0 * r.A * t; }
fn warpRoots(a: f32, b: f32, c: f32) -> vec2f {
  if (a == 0.0) {
    if (b == 0.0) { return vec2f(WARP_INF); }
    return vec2f(-c / b, WARP_INF);
  }
  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) { return vec2f(WARP_INF); }
  if (disc == 0.0) { return vec2f(-b / (2.0 * a), WARP_INF); }
  let q = -0.5 * (b + select(1.0, -1.0, b < 0.0) * sqrt(disc));
  return vec2f(min(q / a, c / q), max(q / a, c / q));
}
fn warpPlane(r: WarpRay, axis: i32, level: f32) -> vec2f { return warpRoots(r.A[axis], r.B[axis], r.C[axis] - level); }
// x/z are linear, so first clip those slabs. Only y can split the interval.
fn warpSpans(r: WarpRay, lo: vec3f, hi: vec3f, start0: f32, end0: f32) -> vec4f {
  var start = start0;
  var end = end0;
  for (var j = 0; j < 2; j++) {
    let i = j * 2;
    if (r.B[i] == 0.0) {
      if (r.C[i] < lo[i] || r.C[i] >= hi[i]) { return vec4f(WARP_INF); }
    } else {
      let a = (lo[i] - r.C[i]) / r.B[i];
      let b = (hi[i] - r.C[i]) / r.B[i];
      start = max(start, min(a, b));
      end = min(end, max(a, b));
    }
  }
  if (end <= start) { return vec4f(WARP_INF); }
  let a = warpPlane(r, 1, lo.y);
  let b = warpPlane(r, 1, hi.y);
  var cuts = array<f32, 6>(start, end, clamp(a.x, start, end), clamp(a.y, start, end), clamp(b.x, start, end), clamp(b.y, start, end));
  for (var i = 1; i < 6; i++) {
    for (var j = 0; j < 5; j++) {
      if (j < 6 - i && cuts[j] > cuts[j + 1]) { let v = cuts[j]; cuts[j] = cuts[j + 1]; cuts[j + 1] = v; }
    }
  }
  var spans = vec4f(WARP_INF);
  var n = 0;
  for (var i = 0; i < 5; i++) {
    let y = warpAt(r, 0.5 * (cuts[i] + cuts[i + 1])).y;
    if (cuts[i + 1] <= cuts[i] || y < lo.y || y >= hi.y) { continue; }
    if (n > 0 && spans[n * 2 - 1] == cuts[i]) { spans[n * 2 - 1] = cuts[i + 1]; }
    else if (n < 2) { spans[n * 2] = cuts[i]; spans[n * 2 + 1] = cuts[i + 1]; n++; }
  }
  return spans;
}
fn warpInside(t: f32, spans: vec4f) -> bool { return (t >= spans.x && t < spans.y) || (t >= spans.z && t < spans.w); }
fn warpResume(t: f32, spans: vec4f) -> f32 {
  if (t < spans.x) { return spans.x; }
  if (t < spans.y) { return t; }
  if (t < spans.z) { return spans.z; }
  return select(WARP_INF, t, t < spans.w);
}
// Exact exits preserve brick/hierarchy skipping and both sides of a turn: (t, axis).
fn warpExit(r: WarpRay, lo: vec3f, hi: vec3f, t: f32) -> vec2f {
  var outp = vec2f(WARP_INF, 0.0);
  for (var axis = 0; axis < 3; axis++) {
    for (var side = 0; side < 2; side++) {
      let roots = warpPlane(r, axis, select(hi[axis], lo[axis], side == 0));
      for (var j = 0; j < 2; j++) {
        let x = roots[j];
        let v = warpSlope(r, x)[axis];
        if (x >= t - WARP_EPS && x < outp.x && select(v > 0.0, v < 0.0, side == 0)) { outp = vec2f(x, f32(axis)); }
      }
    }
  }
  return outp;
}
fn warpChordLimit(r: WarpRay) -> f32 { return select(WARP_INF, 2.0 * sqrt(WARP_CHORD_ERROR / r.A.y), r.A.y > 0.0); }
fn warpArcPrimitive(y: f32, h2: f32) -> f32 {
  let h = sqrt(h2);
  let len = sqrt(h2 + y * y);
  return 0.5 * (y * len + h2 * sign(y) * log((abs(y) + len) / h));
}
fn warpArc(r: WarpRay, a: f32, b: f32) -> f32 {
  if (r.A.y == 0.0) { return length(r.B) * (b - a); }
  // Nearly linear (including float32-equal primitive arguments): integrate
  // speed locally, rather than subtracting huge almost-equal primitives.
  let mid = 0.5 * (a + b);
  if (abs(2.0 * r.A.y * (b - a)) < 0.01 * max(length(warpSlope(r, mid)), 1e-8)) {
    return (b - a) * (length(warpSlope(r, a)) + 4.0 * length(warpSlope(r, mid)) + length(warpSlope(r, b))) / 6.0;
  }
  let h2 = max(dot(r.B.xz, r.B.xz), 1e-12);
  return (warpArcPrimitive(r.B.y + 2.0 * r.A.y * b, h2) - warpArcPrimitive(r.B.y + 2.0 * r.A.y * a, h2)) / (2.0 * r.A.y);
}
// Outgoing ownership applies ONLY at an established plane root, never to an
// arbitrary point close to a boundary. Re-solving the nearest plane recognizes
// computed crossings despite roundoff in warpAt, including simultaneous exits.
fn warpCell(r: WarpRay, t: f32) -> vec3i {
  let p = warpAt(r, t);
  let d = warpSlope(r, t);
  var c = vec3i(floor(p));
  for (var i = 0; i < 3; i++) {
    let plane = round(p[i]);
    let roots = warpPlane(r, i, plane);
    if (t != roots.x && t != roots.y) { continue; }
    c[i] = i32(plane);
    if (d[i] < 0.0 || (d[i] == 0.0 && r.A[i] < 0.0)) { c[i] -= 1; }
  }
  return c;
}
// The traversal already KNOWS which face it crossed. Keep that fact: on Metal,
// re-solving the same quadratic in another inlined function can differ by an
// ULP, leaving the ray in its old cell forever. Only established exits use this
// ownership rule; an arbitrary near-face starting point is never snapped.
fn warpCellAfter(r: WarpRay, t: f32, crossedAxis: i32) -> vec3i {
  let p = warpAt(r, t);
  let d = warpSlope(r, t);
  var c = warpCell(r, t);
  let tolerance = 4.0 * 1.1920929e-7 * max(abs(t), 1.0);
  for (var i = 0; i < 3; i++) {
    if (d[i] == 0.0) { continue; }
    let plane = round(p[i]);
    let roots = warpPlane(r, i, plane);
    // Simultaneous faces may have independently rounded roots.
    if (i != crossedAxis && min(abs(roots.x - t), abs(roots.y - t)) > tolerance) { continue; }
    c[i] = i32(plane) - select(0, 1, d[i] < 0.0);
  }
  return c;
}
fn warpEntryAxis(r: WarpRay, t: f32) -> i32 {
  let p = warpAt(r, t);
  let d = warpSlope(r, t);
  var dist = abs(p - round(p)) / max(abs(d), vec3f(WARP_EPS));
  for (var i = 0; i < 3; i++) { if (d[i] == 0.0) { dist[i] = WARP_INF; } }
  if (dist.x <= dist.y && dist.x <= dist.z) { return 0; }
  return select(2, 1, dist.y <= dist.z);
}
`;
// its GLSL-era name (docs/webgpu.md W2): the same WGSL until U16's *GLSL → *WGSL rename
export const presentationGLSL = presentationWGSL;
