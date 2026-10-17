import { particleOwnershipWGSL } from './particles.js';
import { prelude, STATE_OPTS, STAGE, gridDims } from '../common.js';
import { frameBindings } from '../bindings.js';
import { dirtyLists } from '../fields.js';
import { uniformStruct } from '../../gpu/params.js';
import { materialsGLSL } from '../../gfx/materials.js';

// Freudenthal subdivision: identical diagonals on both sides of every cube face.
// Samples are fieldSurf texel centres. Real vertices are cached at field revision time.
export const SMOOTH_TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
export const SMOOTH_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
export const SMOOTH_CASES = Array.from({ length: 16 }, (_, mask) => {
  const ins = [0, 1, 2, 3].filter((v) => mask & (1 << v));
  const out = [0, 1, 2, 3].filter((v) => !(mask & (1 << v)));
  const edge = (a, b) => SMOOTH_EDGES.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (!ins.length || !out.length) return [];
  if (ins.length === 1) return [out.map((v) => edge(ins[0], v))];
  if (out.length === 1) return [ins.map((v) => edge(out[0], v))];
  const q = [edge(ins[0], out[0]), edge(ins[0], out[1]), edge(ins[1], out[1]), edge(ins[1], out[0])];
  return [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
});
export const SMOOTH_FLAGS = Object.freeze({ OVERFLOW: 1, THIN: 2, NO_MATERIAL: 4, APPEARANCE: 8 });
export const SmoothParams = uniformStruct('SmoothParams', { capacity: 'u32', full: 'u32', unsupported: 'u32', slot: 'u32', matrix: 'mat4x4f', particleSplit: 'u32', world: 'u32' });
const ro = (binding, visibility = STAGE.COMPUTE) => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
const rw = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } });
const tex = (binding, visibility) => ({ binding, visibility, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } });
// Separate prefix layout avoids reserving unused storage slots in build pipelines.
export const SMOOTH_EXTRACT_LAYOUT = [tex(0, STAGE.COMPUTE), ro(2), rw(3), rw(4), rw(5), rw(8)];
export const SMOOTH_PREFIX_LAYOUT = [rw(4), rw(5), rw(6), rw(7)];
export const SMOOTH_DRAW_LAYOUT = [ro(1, STAGE.VERTEX), ro(2, STAGE.VERTEX), ro(3, STAGE.VERTEX | STAGE.FRAGMENT)];
// Cached vertices retain physical source slots; both camera and shadow VS read live A.
export const SMOOTH_STATE_LAYOUT = [ro(0, STAGE.VERTEX | STAGE.FRAGMENT), ro(1, STAGE.VERTEX | STAGE.FRAGMENT)];

/** Bind this small status buffer to the legacy smooth pass as read-only storage.
 * A nonzero flag means ALL granular/organic matter stays with legacy, not a
 * truncated mesh. Parent must gate the two paths with the SAME GPU predicate.
 */
export function smoothAcceptanceWGSL({ group = 2, binding = 0, name = 'smoothStatus' } = {}) {
  return `@group(${group}) @binding(${binding}) var<storage, read> ${name}: array<u32>;\nfn smoothAccepted() -> bool { return ${name}[0] == 0u; }`;
}

const tables = () => `
${particleOwnershipWGSL}
const TETS = array<vec4u, 6>(${SMOOTH_TETS.map((v) => `vec4u(${v.join(',')})`).join(',')});
const EDGES = array<vec2u, 6>(${SMOOTH_EDGES.map((v) => `vec2u(${v.join(',')})`).join(',')});
const TRI_COUNT = array<u32, 16>(${SMOOTH_CASES.map((v) => `${v.length}u`).join(',')});
const TRI_EDGES = array<vec3u, 32>(${SMOOTH_CASES.flatMap((v) => [v[0] ?? [0, 0, 0], v[1] ?? [0, 0, 0]]).map((v) => `vec3u(${v.join(',')})`).join(',')});
fn corner(i: u32) -> vec3i { return vec3i(i32(i & 1u), i32((i >> 1u) & 1u), i32(i >> 2u)); }
// Cube bases [-1, N-1] are partitioned once. Only the last brick owns a fifth
// cube layer, closing the positive box faces without duplicate seam triangles.
fn cubeBase(b: u32, local: u32) -> vec3i {
  return brickCoord(b) * 4 + vec3i(i32(local % 5u), i32((local / 5u) % 5u), i32(local / 25u)) - vec3i(1);
}
fn cubeOwned(b: u32, local: u32) -> bool {
  let bc = brickCoord(b);
  let l = vec3i(i32(local % 5u), i32((local / 5u) % 5u), i32(local / 25u));
  return all(l < vec3i(4) + vec3i(select(vec3u(0u), vec3u(1u), bc == vec3i(BX-1, BY-1, BZ-1))));
}
fn phi(q: vec3i, ch: u32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  return textureLoad(surf, q, 0)[ch];
}
// Existing state, never a new simulation. Nearest channel source in the field
// kernel's two-cell support; missing sources (EMA ghosts) emit no triangles.
fn smoothSource(p: vec3i, ch: i32) -> u32 {
  var best = 1e20;
  var a = SLOTS;
  for (var z = -2; z <= 2; z++) { for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
    let q = p + vec3i(x,y,z);
    if (inGrid(q)) {
      let s = fetchA(q);
      let d = dot(vec3f(q-p)-vec3f(0.5), vec3f(q-p)-vec3f(0.5));
      if (SURFCH(eid(s)) == ch && d < best && !(P.particleSplit != 0u && hybridParticleOwns(q, P.world != 0u))) { best = d; a = slotOf(q); }
    }
  } } }
  return a;
}
`;

const octCodec = `
fn signNZ(v: vec2f) -> vec2f { return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0)); }
fn octEncode(input: vec3f) -> vec2f {
  let n = select(vec3f(0,1,0), input, dot(input,input) > 1e-12);
  let p = n / (abs(n.x)+abs(n.y)+abs(n.z));
  return select(p.xy, (vec2f(1.0)-abs(p.yx))*signNZ(p.xy), p.z < 0.0);
}
fn octDecode(p: vec2f) -> vec3f {
  var n = vec3f(p, 1.0-abs(p.x)-abs(p.y));
  if (n.z < 0.0) { n = vec3f((vec2f(1.0)-abs(n.yx))*signNZ(n.xy), n.z); }
  return normalize(n);
}`;

export function smoothExtractWGSL(g) {
  const dl = dirtyLists(g);
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${SmoothParams.wgsl}
@group(3) @binding(1) var<uniform> P: SmoothParams;
@group(2) @binding(0) var surf: texture_3d<f32>;
@group(2) @binding(2) var<storage, read> dirty: array<u32>;
@group(2) @binding(3) var<storage, read_write> arena0: array<vec4u>;
// Per brick: triangle count, old vertex prefix, new vertex prefix, changed.
@group(2) @binding(4) var<storage, read_write> chunkMeta: array<u32>;
// flags, total triangles, required vertices, changed bricks, active arena.
@group(2) @binding(5) var<storage, read_write> status: array<u32>;
@group(2) @binding(6) var<storage, read_write> args: array<u32>;
@group(2) @binding(7) var<storage, read_write> results: array<vec4u>;
@group(2) @binding(8) var<storage, read_write> arena1: array<vec4u>;
${tables()}
${octCodec}
fn gradient(q: vec3i, ch: u32) -> vec3f {
  return vec3f(phi(q+vec3i(1,0,0),ch)-phi(q-vec3i(1,0,0),ch), phi(q+vec3i(0,1,0),ch)-phi(q-vec3i(0,1,0),ch), phi(q+vec3i(0,0,1),ch)-phi(q-vec3i(0,0,1),ch));
}
fn smoothNormal(p: vec3f, ch: u32) -> vec3f {
  let base = vec3i(floor(p-vec3f(0.5)));
  let f = fract(p-vec3f(0.5));
  var n = vec3f(0.0);
  for (var c = 0u; c < 8u; c++) {
    let k = corner(c);
    let w = mix(vec3f(1.0)-f, f, vec3f(k));
    n -= gradient(base+k,ch) * w.x*w.y*w.z;
  }
  return n / max(length(n), 1e-10);
}

fn putVertex(at: u32, value: vec4u) {
  if (status[4] == 0u) { arena0[at] = value; } else { arena1[at] = value; }
}
fn emitTriangle(at: u32, p: vec3i, ch: u32, tet: vec4u, edges: vec3u, source: u32) {
  var points: array<vec3f, 3>;
  for (var v = 0u; v < 3u; v++) {
    let edge = EDGES[edges[v]];
    let a = p+corner(tet[edge.x]); let b = p+corner(tet[edge.y]);
    let fa = phi(a,ch); let fb = phi(b,ch);
    let w = clamp((0.5-fa)/(fb-fa), 0.0, 1.0);
    points[v] = clamp(mix(vec3f(a),vec3f(b),w)+vec3f(0.5), vec3f(0.0), vec3f(f32(NX),f32(NY),f32(NZ)));
  }
  let normal = smoothNormal((points[0]+points[1]+points[2])/3.0,ch);
  let flip = dot(cross(points[1]-points[0],points[2]-points[0]),normal) < 0.0;
  for (var v = 0u; v < 3u; v++) {
    var j = v; if (flip && v != 0u) { j = 3u-v; }
    // Half floats preserve the full support; do not clamp relative position
    // (texel-centre geometry can extend to 3.5 from a source at p-2).
    let relative = points[j]-vec3f(cellOf(source));
    let n = octEncode(smoothNormal(points[j],ch));
    putVertex(at+v, vec4u(pack2x16float(relative.xy), pack2x16float(vec2f(relative.z,n.x)), pack2x16float(vec2f(n.y,0)), source));
  }
}
var<workgroup> count: atomic<u32>;
// Count and build share precisely the same source selection and tetra cases.
fn scan(b: u32, li: u32, emit: bool) {
  if (li < 125u && cubeOwned(b, li)) {
    let p = cubeBase(b,li);
    for (var ch = 2u; ch <= 3u; ch++) {
      var values: array<f32,8>;
      for (var c = 0u; c < 8u; c++) { values[c] = phi(p+corner(c),ch); }
      var source = SLOTS;
      var searched = false;
      for (var t = 0u; t < 6u; t++) {
        let tet = TETS[t]; var mask = 0u;
        for (var v = 0u; v < 4u; v++) { if (values[tet[v]] >= 0.5) { mask |= 1u << v; } }
        let n = TRI_COUNT[mask]; if (n == 0u) { continue; }
        if (!searched) { source = smoothSource(p,i32(ch)); searched = true; }
        if (source == SLOTS) { continue; } // EMA ghost or particle-owned only
        let at = atomicAdd(&count,n);
        if (emit) {
          for (var tri = 0u; tri < n; tri++) {
            emitTriangle(chunkMeta[4u*b+2u]+3u*(at+tri),p,ch,tet,TRI_EDGES[mask*2u+tri],source);
          }
        }
      }
    }
  }
}
@compute @workgroup_size(128)
fn extract(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldId(wg,nwg); if (b >= NBRICKS) { return; }
  let changed = P.full != 0u || dirty[${dl.fmask}u+b] != 0u || status[0] != 0u;
  if (li == 0u) { chunkMeta[4u*b+3u] = u32(changed); atomicStore(&count,0u); }
  workgroupBarrier();
  if (changed) { scan(b,li,false); }
  workgroupBarrier();
  if (li == 0u && changed) { chunkMeta[4u*b] = atomicLoad(&count); }
}
@compute @workgroup_size(1)
fn finish() {
  var total = 0u; var changed = 0u;
  for (var b = 0u; b < NBRICKS; b++) {
    chunkMeta[4u*b+1u] = chunkMeta[4u*b+2u]; chunkMeta[4u*b+2u] = total*3u;
    total += chunkMeta[4u*b]; changed += chunkMeta[4u*b+3u];
  }
  let required = total*3u;
  let bad = P.unsupported | select(0u,1u,required > P.capacity);
  status[0] = bad; status[1] = total; status[2] = required; status[3] = changed;
  if (changed != 0u && bad == 0u) { status[4] = 1u-status[4]; }
  results[P.slot] = vec4u(bad,total,required,changed);
  args[0] = select(0u,required,bad == 0u); args[1] = select(0u,1u,bad == 0u);
  args[2] = 0u; args[3] = 0u;
}
@compute @workgroup_size(128)
fn build(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldId(wg,nwg);
  if (li == 0u) { atomicStore(&count,0u); }
  workgroupBarrier();
  if (b >= NBRICKS || status[0] != 0u || status[3] == 0u) { return; }
  if (chunkMeta[4u*b+3u] == 0u) {
    for (var i = li; i < chunkMeta[4u*b]*3u; i += 128u) {
      let old = chunkMeta[4u*b+1u]+i;
      var rec: vec4u;
      if (status[4] == 0u) { rec = arena1[old]; } else { rec = arena0[old]; }
      putVertex(chunkMeta[4u*b+2u]+i,rec);
    }
    return;
  }
  scan(b,li,true);
}`;
}

const baselineShade = `
fn shadeSmooth(cellPosition: vec3f, normal: vec3f, elementId: i32, stateA: vec4f, footprint: f32) -> vec3f {
  let hemi = normal.y * 0.5 + 0.5;
  let light = mix(FU.ground, FU.skyUp, hemi) + FU.sunCol * FU.sunExt * max(0.0, dot(normal, FU.sun));
  return ALBEDO(elementId) * light * FU.lightGain + cellEmission(elementId, stateA.y, floor(stateA.w));
}`;

/** Composition seam: group2 bindings >=4 are reserved for the supplied shading
 * WGSL and corresponding layout/entries. shadeSmooth receives GRID coordinates
 * (physical world = cellPosition + vec3f(H.origin)), outward grid normal, exact
 * element id, current source state A, and derivative footprint. Returns unpremultiplied linear HDR
 * radiance; opaque coverage is 1. No tone mapping. */
export function smoothDrawWGSL(g, { shadingWGSL = baselineShade } = {}) {
  gridDims(g);
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${frameBindings()}
${materialsGLSL()}
${SmoothParams.wgsl}
@group(3) @binding(1) var<uniform> P: SmoothParams;
@group(2) @binding(1) var<storage, read> arena0: array<vec4u>;
@group(2) @binding(2) var<storage, read> arena1: array<vec4u>;
@group(2) @binding(3) var<storage, read> status: array<u32>;
${octCodec}
struct SmoothVertex {
  @builtin(position) clip: vec4f,
  @location(0) cellPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) stateA: vec4f,
  @location(3) @interpolate(flat) elementId: i32,
}
fn vertex(vi: u32, shadow: bool) -> SmoothVertex {
  var rec: vec4u;
  if (status[4] == 0u) { rec = arena0[vi]; } else { rec = arena1[vi]; }
  let xy = unpack2x16float(rec.x); let zn = unpack2x16float(rec.y);
  let ny = unpack2x16float(rec.z).x;
  var o: SmoothVertex;
  o.cellPosition = vec3f(cellOf(rec.w))+vec3f(xy,zn.x);
  o.normal = octDecode(vec2f(zn.y,ny));
  o.stateA = fetchA(cellOf(rec.w));
  o.elementId = eid(o.stateA);
  o.clip = FU.viewProj * FU.model * vec4f(o.cellPosition,1.0);
  // Caster matrix maps GRID coordinates directly to WebGPU [0,1] depth.
  if (shadow) { o.clip = P.matrix * vec4f(o.cellPosition,1.0); }
  return o;
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SmoothVertex { return vertex(vi,false); }
@vertex fn shadowVS(@builtin(vertex_index) vi: u32) -> SmoothVertex { return vertex(vi,true); }
${shadingWGSL}
@fragment fn fs(v: SmoothVertex) -> @location(0) vec4f {
  let footprint = max(length(dpdx(v.cellPosition)), length(dpdy(v.cellPosition)));
  if (status[0] != 0u) { discard; }
  return vec4f(shadeSmooth(v.cellPosition, normalize(v.normal), v.elementId, v.stateA, footprint), 1.0);
}`;
}
