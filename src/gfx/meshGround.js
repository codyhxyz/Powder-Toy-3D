// Surface nets (Gibson 1998; Lysenko's naive surface nets), adapted from 70e0d507.
import { Box3, Frustum, Matrix4, WebGPUCoordinateSystem } from 'three/webgpu';
import { prelude } from '../shaders/common.js';
import { frameBindings, RENDER_LAYOUT } from '../shaders/bindings.js';
import { worldCopyWGSL, WORLD_COPY_LAYOUT } from '../shaders/world/copy.js';
import { farAirWGSL } from '../shaders/farShared.js';
import { farLightReadersWGSL, LIGHT_BINDINGS } from '../shaders/world/light.js';
import { GI_OFFSET_CELLS, SH_Y0, SH_Y1, SKYVIS_OPEN_DC, SHADOW_TINT_ID_SCALE, VOLUME_SHADOW_BIAS } from '../shaders/gfx/lighting.js';
import { GLASS_ALPHA_PER_CM } from '../shaders/gfx/glass.js';
import { CELL_M } from '../scale.js';
import { noiseGLSL } from '../shaders/gfx/noise.js';
import { glslMod } from '../gpu/wgsl.js';
import { STAGE } from '../gpu/kernels.js';
import { uniformStruct } from '../gpu/params.js';
import { materialTextures } from './materialTextures.js';
import { skyGLSL, skyViewGLSL, SUN_TAN_RADIUS } from './sky.js';

export const MESH_CHUNK = 32;
export const MESH_MAX_LOD = 4;
export const MESH_VCAP = 16384;
export const MESH_ICAP = 6 * MESH_VCAP;
const C = MESH_CHUNK, VCAP = MESH_VCAP, ICAP = MESH_ICAP;
const SLOTS = 384, BATCH = 16, WG = 64, FLOOR = 255;
const VBYTES = 16, IBYTES = 2, ARG_WORDS = 5, JOB_WORDS = 8;
const QN = C + 2; // quads' owners [-1,32], with one overlapping row on transition faces
const VN = C + 3; // cubes [-2,32], including the low neighbours of those owners
const FN = C + 4; // samples [-2,33]
const RN = FN + 4; // two samples on either side for the 5-tap filter
const RAW_N = RN ** 3, BLUR_X_N = FN * RN ** 2, BLUR_Y_N = FN ** 2 * RN, FIELD_N = FN ** 3;
const STRIDE = RAW_N + BLUR_X_N + BLUR_Y_N + FIELD_N + VN ** 3 + 1;
const REACH = [104, 256, 512, 1024];
const axes = [0, 1, 2];
const xyz = (v) => [v.x ?? v[0], v.y ?? v[1], v.z ?? v[2]];
const crosses = (a, b) => axes.every((k) => a.lo[k] < b.hi[k] && b.lo[k] < a.hi[k]);

function chunk(size, lo, lod) {
  const step = 1 << lod, span = C * step;
  return { key: `${lod}:${lo.join(',')}`, lo, hi: lo.map((v, i) => Math.min(size[i], v + span)), lod, step, span, faces: 0 };
}
const gap = (v, a, b) => Math.max(a - v, v - b, 0);
const near = (ch, eye) => Math.max(...axes.map((i) => gap(eye[i], ch.lo[i], ch.hi[i])));
const owns = (ch, eye) => axes.every((i) => ch.lo[i] <= eye[i] && eye[i] < ch.hi[i]);
const distance2 = (ch, eye) => axes.reduce((d, i) => d + gap(eye[i], ch.lo[i], ch.hi[i]) ** 2, 0);
const faceAdjacent = (a, b, i) => axes.every((j) => i === j ? a.hi[j] === b.lo[j] || b.hi[j] === a.lo[j] : a.lo[j] < b.hi[j] && b.lo[j] < a.hi[j]);

/** Half-open, 2:1 balanced leaves. Refining is atomic: where the budget runs out the parent covers its children. */
export function meshLodPlan(size, eye, limit = SLOTS) {
  const box = Math.max(...size) <= 4 * C;
  const top = box ? 0 : MESH_MAX_LOD, extent = C << top;
  const leaves = [];
  for (let z = 0; z < size[2]; z += extent) for (let y = 0; y < size[1]; y += extent) for (let x = 0; x < size[0]; x += extent) {
    leaves.push(chunk(size, [x, y, z], top));
  }
  if (leaves.length > limit) throw new RangeError('mesh pool cannot cover the world at its coarsest LOD');
  if (!eye) return leaves;
  const split = (p) => {
    const children = [], span = p.span / 2;
    for (let i = 0; i < 8; i++) {
      const lo = axes.map((a) => p.lo[a] + ((i >> a) & 1) * span);
      if (axes.every((a) => lo[a] < size[a])) children.push(chunk(size, lo, p.lod - 1));
    }
    return children;
  };
  const refine = (plan, p) => {
    // Refine the larger face neighbours first, so adding p's children cannot create a 4:1 seam.
    for (const q of [...plan]) if (q.lod > p.lod && plan.includes(q) && axes.some((a) => faceAdjacent(p, q, a))) {
      if (!refine(plan, q)) return false;
    }
    const children = split(p);
    if (plan.length + children.length - 1 > limit) return false;
    plan.splice(plan.indexOf(p), 1, ...children);
    return true;
  };
  for (let changed = true; changed;) {
    changed = false;
    const candidates = leaves.filter((ch) => ch.lod && near(ch, eye) < REACH[ch.lod - 1]);
    candidates.sort((a, b) => Number(owns(b, eye)) - Number(owns(a, eye)) || distance2(a, eye) - distance2(b, eye) || a.lod - b.lod);
    for (const p of candidates) {
      if (leaves.length + split(p).length - 1 > limit) continue;
      const staged = [...leaves];
      if (!refine(staged, p)) continue;
      leaves.splice(0, leaves.length, ...staged);
      changed = true;
      break;
    }
  }
  // Bit 2a: negative face, 2a+1: positive. Both sides overlap; only the fine side extrudes skirts.
  for (const p of leaves) for (const q of leaves) if (p.lod !== q.lod) for (const a of axes) {
    if (!faceAdjacent(p, q, a)) continue;
    const bit = 1 << (2 * a + Number(p.hi[a] === q.lo[a]));
    p.faces |= bit | (p.lod < q.lod ? bit << 6 : 0);
  }
  return leaves;
}

/** Include the two smoothing cells, the seam cells, and the extent of a coarse sample. */
export function meshChunkDirty(ch, changes) {
  const field = { lo: ch.lo.map((v) => v - 4 * ch.step), hi: ch.lo.map((v) => v + ch.span + 4 * ch.step) };
  return changes.some((b) => crosses(field, b));
}

/** Keep slots of surviving chunks; a new owner is never marked built until its dispatch. */
export function meshSlotCache(capacity) {
  const resident = new Map();
  const free = Array.from({ length: capacity }, (_, i) => capacity - i - 1);
  return { resident, sync(plan) {
    if (plan.length > capacity) throw new RangeError('mesh plan exceeds pool capacity');
    const wanted = new Set(plan.map((ch) => ch.key));
    for (const [key, ch] of resident) if (!wanted.has(key)) { free.push(ch.slot); resident.delete(key); }
    for (const ch of plan) {
      const old = resident.get(ch.key);
      if (old) {
        if (old.faces !== ch.faces) { old.faces = ch.faces; old.dirty = true; }
      } else resident.set(ch.key, { ...ch, slot: free.pop(), built: false, dirty: true });
    }
  } };
}

const frustum = new Frustum(), bounds = new Box3();
export function meshFrustum(viewProjModel) { return frustum.setFromProjectionMatrix(viewProjModel, WebGPUCoordinateSystem); }
export function meshChunkVisible(ch, fr) {
  const pad = 5 * ch.step; // wide enough for skirts and cube vertices on the transition faces
  bounds.min.set(...ch.lo.map((v) => v - pad));
  bounds.max.set(...ch.lo.map((v) => v + ch.span + pad));
  return fr.intersectsBox(bounds);
}

const BuildParams = uniformStruct('MeshBuildParams', { n: 'u32' });
const ViewParams = uniformStruct('MeshViewParams', { clipToWorld: 'mat4x4f', worldToClip: 'mat4x4f', size: 'vec3f', floor: 'f32', sea: 'f32' });
const buildDecls = /* wgsl */ `
${BuildParams.wgsl}
@group(3) @binding(1) var<uniform> P: MeshBuildParams;
struct Job { origin: vec3i, slot: u32, step: i32, faces: u32, pad: vec2u }
@group(2) @binding(0) var<storage, read> jobs: array<Job>;
@group(2) @binding(1) var<storage, read_write> scratch: array<u32>;
const C: i32 = ${C};
const QN: i32 = ${QN};
const VN: i32 = ${VN};
const FN: i32 = ${FN};
const RN: i32 = ${RN};
const BLUR_X: u32 = ${RAW_N}u;
const BLUR_Y: u32 = ${RAW_N + BLUR_X_N}u;
const FIELD: u32 = ${RAW_N + BLUR_X_N + BLUR_Y_N}u;
const VM: u32 = ${RAW_N + BLUR_X_N + BLUR_Y_N + FIELD_N}u;
const VCAP: u32 = ${VCAP}u;
const ICAP: u32 = ${ICAP}u;
const NONE: u32 = 0xffffffffu;
fn coord(i: u32, n: i32) -> vec3i { let a = i32(i); return vec3i(a % n, (a / n) % n, a / (n * n)); }
fn index(p: vec3i, n: i32) -> u32 { return u32(p.x + n * (p.y + n * p.z)); }
fn base(j: u32) -> u32 { return j * ${STRIDE}u; }
fn nonEmpty(j: u32) -> u32 { return base(j) + ${STRIDE - 1}u; }
fn field(j: u32, p: vec3i) -> u32 { return scratch[base(j) + FIELD + index(p + 2, FN)]; }
fn den(w: u32) -> f32 { return f32((w >> 8u) & 65535u) / 4096.0; }
fn occ(w: u32) -> bool { return (w & 255u) != 0u; }
fn vAt(j: u32, q: vec3i) -> u32 { return base(j) + VM + index(q + 2, VN); }
`;
const poolDecls = /* wgsl */ `
@group(2) @binding(2) var<storage, read_write> verts: array<vec4u>;
@group(2) @binding(3) var<storage, read_write> indices: array<u32>;
@group(2) @binding(4) var<storage, read_write> counts: array<atomic<u32>>;
@group(2) @binding(5) var<storage, read_write> args: array<u32>;
fn packNormal(n: vec3f) -> u32 {
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = (1.0 - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)); }
  let q = vec2u(round((p * 0.5 + 0.5) * 4095.0));
  return q.x | (q.y << 12u);
}
`;
const unpackNormal = /* wgsl */ `
fn unpackNormal(w: u32) -> vec3f {
  let p = vec2f(f32(w & 4095u), f32((w >> 12u) & 4095u)) / 4095.0 * 2.0 - 1.0;
  let z = 1.0 - abs(p.x) - abs(p.y);
  let t = max(-z, 0.0);
  return normalize(vec3f(p + select(vec2f(t), vec2f(-t), p >= vec2f(0.0)), z));
}`;
const main = `@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u)`;
const resetWGSL = /* wgsl */ `${buildDecls}${poolDecls}
${main} {
  if (gid.x >= P.n) { return; }
  let s = jobs[gid.x].slot * 2u;
  atomicStore(&counts[s], 0u);
  atomicStore(&counts[s + 1u], 0u);
}`;
const occupiedWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}${worldCopyWGSL()}${buildDecls}
${main} {
  if (gid.x >= P.n) { return; }
  let j = jobs[gid.x];
  let end = j.origin + (C + 4) * j.step;
  let start = j.origin - 4 * j.step;
  // A chunk that reaches the virtual floor may generate triangles without any WorldCopy cells.
  scratch[nonEmpty(gid.x)] = 1u;
  if (start.y < 0) { return; }
  let lo = max(start, vec3i(0)) / 64;
  let hi = (min(end, WC.size) - 1) / 64;
  for (var z = lo.z; z <= hi.z; z++) { for (var y = lo.y; y <= hi.y; y++) { for (var x = lo.x; x <= hi.x; x++) {
    if (wcOccupied(2u, vec3i(x, y, z) * 64)) { return; }
  } } }
  scratch[nonEmpty(gid.x)] = 0u;
}`;
const fieldWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}${worldCopyWGSL()}${buildDecls}
fn opaqueAt(c: vec3i) -> u32 {
  if (!wcOccupied(0u, c)) { return 0u; }
  let id = wcId(wcCell(c));
  if (id == E_LAVA) { return u32(id); } // molten rock is opaque, despite its simulation kind
  if (isGasLike(id) || KIND(id) == K_LIQUID || RCLASS(id) == R_GLASS || KIND(id) == K_EMPTY) { return 0u; }
  return u32(id);
}
// Full-resolution samples are exact. At distance try a stratified footprint if the centre misses:
// thin trunks/roofs survive more often than with a single point per 16-cell step.
fn matterAt(c: vec3i, step: i32) -> u32 {
  if (c.y < 0) {
    if (all(c.xz >= vec2i(0)) && all(c.xz < WC.size.xz)) { return ${FLOOR}u; }
    return 0u;
  }
  if (!wcOccupied(2u, c)) { return 0u; }
  let id = opaqueAt(c);
  if (id != 0u || step == 1 || !wcOccupied(1u, c)) { return id; }
  let r = step / 4;
  for (var j = 0u; j < 8u; j++) {
    let corner = vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u));
    let m = opaqueAt(c + corner * max(1, 2 * r) - r - 1);
    if (m != 0u) { return m; }
  }
  return 0u;
}
${main} {
  if (gid.x >= BLUR_X || gid.y >= P.n || scratch[nonEmpty(gid.y)] == 0u) { return; }
  let j = jobs[gid.y];
  let p = coord(gid.x, RN) - 4;
  let id = matterAt(j.origin + p * j.step + j.step / 2, j.step);
  let soft = id > 0u && id != ${FLOOR}u && (SURFCH(i32(id)) >= 0 || i32(id) == E_LAVA);
  scratch[base(gid.y) + gid.x] = id | (u32(soft) << 24u);
}`;

// Separable 1-4-6-4-1 is the same 5³ binomial, with 5 reads per pass rather than 27.
// Keep the intermediate sums exact (16³ weights); density moves crossings, not topology.
const blurWGSL = (axis) => /* wgsl */ `${buildDecls}
fn weight(w: u32) -> u32 { return ${axis === 0 ? 'u32(occ(w))' : '(w >> 8u) & 65535u'}; }
${main} {
  if (gid.x >= ${[BLUR_X_N, BLUR_Y_N, FIELD_N][axis]}u || gid.y >= P.n || scratch[nonEmpty(gid.y)] == 0u) { return; }
  let src = base(gid.y) + ${['0u', 'BLUR_X', 'BLUR_Y'][axis]};
  let dst = base(gid.y) + ${['BLUR_X', 'BLUR_Y', 'FIELD'][axis]};
  let u = gid.x % u32(FN);
  let v = (gid.x / u32(FN)) % u32(${axis === 0 ? 'RN' : 'FN'});
  let w = gid.x / u32(FN * ${axis === 0 ? 'RN' : 'FN'});
  let at = src + ${['u + 2u + u32(RN) * (v + u32(RN) * w)', 'u + u32(FN) * (v + 2u + u32(RN) * w)',
    'u + u32(FN) * (v + u32(FN) * (w + 2u))'][axis]};
  let stride = ${['1u', 'u32(FN)', 'u32(FN * FN)'][axis]};
  let center = scratch[at];
  let sum = 6u * weight(center) + 4u * (weight(scratch[at - stride]) + weight(scratch[at + stride]))
    + weight(scratch[at - 2u * stride]) + weight(scratch[at + 2u * stride]);
  scratch[dst + gid.x] = (center & 0x010000ffu) | (sum << 8u);
}`;

const vertsWGSL = /* wgsl */ `${buildDecls}${poolDecls}
fn corner(k: u32) -> vec3i { return vec3i(i32(k & 1u), i32((k >> 1u) & 1u), i32(k >> 2u)); }
${main} {
  if (gid.x >= ${VN ** 3}u || gid.y >= P.n || scratch[nonEmpty(gid.y)] == 0u) { return; }
  let j = gid.y;
  let job = jobs[j];
  let q = coord(gid.x, VN) - 2;
  let at = vAt(j, q);
  var d: array<f32, 8>;
  var ids: array<u32, 8>;
  var mask = 0u;
  for (var k = 0u; k < 8u; k++) {
    let w = field(j, q + corner(k));
    d[k] = den(w);
    ids[k] = w & 0x010000ffu;
    mask |= u32(occ(w)) << k;
  }
  scratch[at] = NONE;
  if (mask == 0u || mask == 255u) { return; }
  var sum = vec3f(0.0);
  var n = 0.0;
  var nCrisp = vec3f(0.0);
  var material = 0u;
  for (var k = 0u; k < 8u; k++) {
    if (ids[k] != 0u && (material == 0u || (k & 2u) != 0u)) { material = ids[k]; }
    for (var b = 1u; b < 8u; b <<= 1u) {
      if ((k & b) != 0u) { continue; }
      let k2 = k | b;
      let aSolid = ids[k] != 0u;
      if (aSolid == (ids[k2] != 0u)) { continue; }
      let soft = ((ids[k] | ids[k2]) >> 24u) != 0u;
      let a = vec3f(corner(k));
      let e = vec3f(corner(b));
      let dd = d[k] - d[k2];
      var t = 0.5;
      if (soft && abs(dd) > 1e-5) { t = clamp((d[k] - 0.5) / dd, 0.15, 0.85); }
      sum += a + e * t;
      nCrisp += e * select(-1.0, 1.0, aSolid);
      n += 1.0;
    }
  }
  let f = sum / n;
  let x0 = mix(vec4f(d[0], d[2], d[4], d[6]), vec4f(d[1], d[3], d[5], d[7]), f.x);
  let gx = mix(mix(d[1] - d[0], d[3] - d[2], f.y), mix(d[5] - d[4], d[7] - d[6], f.y), f.z);
  let gy = mix(x0.y - x0.x, x0.w - x0.z, f.z);
  let gz = mix(x0.z - x0.x, x0.w - x0.y, f.y);
  var normal = select(nCrisp, -vec3f(gx, gy, gz), material >> 24u != 0u);
  if (dot(normal, normal) < 1e-10) { normal = nCrisp; }
  if (dot(normal, normal) < 1e-10) { normal = vec3f(0.0, 1.0, 0.0); }
  let v = atomicAdd(&counts[job.slot * 2u], 1u);
  if (v >= VCAP) { return; }
  let wp = vec3f(job.origin) + (vec3f(q) + 0.5 + f) * f32(job.step);
  verts[job.slot * VCAP + v] = vec4u(bitcast<vec3u>(wp), packNormal(normalize(normal)) | ((material & 255u) << 24u));
  scratch[at] = v;
}`;

const quadsWGSL = /* wgsl */ `${buildDecls}${poolDecls}${unpackNormal}
fn quad(s: u32, v: vec4u) {
  let at = atomicAdd(&counts[s * 2u + 1u], 6u);
  if (at + 6u > ICAP) { return; }
  // Each invocation owns three aligned words; no read-modify-write on half-indices.
  let i = (s * ICAP + at) / 2u;
  indices[i] = v.x | (v.y << 16u);
  indices[i + 1u] = v.z | (v.x << 16u);
  indices[i + 2u] = v.z | (v.w << 16u);
}
fn skirt(job: Job, a: u32, b: u32) {
  let at = atomicAdd(&counts[job.slot * 2u], 2u);
  if (at + 2u > VCAP) { return; }
  let i = job.slot * VCAP;
  let va = verts[i + a];
  let vb = verts[i + b];
  // Drop behind the surface, not toward the camera. A 2:1 neighbour is two fine steps.
  let d = 3.0 * f32(job.step);
  verts[i + at] = vec4u(bitcast<vec3u>(bitcast<vec3f>(va.xyz) - d * unpackNormal(va.w)), va.w);
  verts[i + at + 1u] = vec4u(bitcast<vec3u>(bitcast<vec3f>(vb.xyz) - d * unpackNormal(vb.w)), vb.w);
  quad(job.slot, vec4u(a, b, at + 1u, at));
}
${main} {
  if (gid.x >= ${QN ** 3}u || gid.y >= P.n || scratch[nonEmpty(gid.y)] == 0u) { return; }
  let j = gid.y;
  let job = jobs[j];
  let p = coord(gid.x, QN) - 1;
  var low = vec3i(0);
  var high = vec3i(C - 1);
  for (var a = 0; a < 3; a++) {
    if ((job.faces & (1u << u32(a * 2))) != 0u || job.origin[a] == 0) { low[a] = -1; }
    if ((job.faces & (2u << u32(a * 2))) != 0u) { high[a] = C; }
  }
  if (any(p < low) || any(p > high)) { return; }
  let o0 = occ(field(j, p));
  for (var a = 0; a < 3; a++) {
    let u = (a + 1) % 3;
    let v = (a + 2) % 3;
    var ea = vec3i(0); ea[a] = 1;
    var eu = vec3i(0); eu[u] = 1;
    var ev = vec3i(0); ev[v] = 1;
    if (o0 == occ(field(j, p + ea))) { continue; }
    let v0 = scratch[vAt(j, p - eu - ev)];
    let v1 = scratch[vAt(j, p - ev)];
    let v2 = scratch[vAt(j, p)];
    let v3 = scratch[vAt(j, p - eu)];
    if (any(vec4u(v0, v1, v2, v3) == vec4u(NONE))) { continue; }
    quad(job.slot, select(vec4u(v0, v3, v2, v1), vec4u(v0, v1, v2, v3), o0));
    let seam = job.faces >> 6u;
    if (p[u] == low[u] && (seam & (1u << u32(2 * u))) != 0u) { skirt(job, v0, v3); }
    if (p[u] == high[u] && (seam & (2u << u32(2 * u))) != 0u) { skirt(job, v1, v2); }
    if (p[v] == low[v] && (seam & (1u << u32(2 * v))) != 0u) { skirt(job, v0, v1); }
    if (p[v] == high[v] && (seam & (2u << u32(2 * v))) != 0u) { skirt(job, v3, v2); }
  }
}`;
const argsWGSL = /* wgsl */ `${buildDecls}${poolDecls}
${main} {
  if (gid.x >= P.n) { return; }
  let s = jobs[gid.x].slot;
  let i = s * ${ARG_WORDS}u;
  args[i] = min(atomicLoad(&counts[s * 2u + 1u]), ICAP);
  args[i + 1u] = 1u;
  args[i + 2u] = s * ICAP;
  args[i + 3u] = s * VCAP;
  args[i + 4u] = 0u;
}`;

const atmosphere = /* wgsl */ `
const PI_L: f32 = 3.14159265;
const SUN_TAN_RADIUS: f32 = ${SUN_TAN_RADIUS};
${skyGLSL()}${skyViewGLSL()}${farAirWGSL}
${ViewParams.wgsl}
@group(3) @binding(1) var<uniform> P: MeshViewParams;
struct ColorDepth { @location(0) color: vec4f, @location(1) clipDepth: f32 }
`;
const renderLight = /* wgsl */ `
${LIGHT_BINDINGS.map(([i, name, type, body]) => `@group(2) @binding(${i}) var${body.buffer ? `<${body.buffer.type === 'uniform' ? 'uniform' : 'storage, read'}>` : ''} ${name}: ${type};`).join('\n')}
@group(2) @binding(16) var linearClamp: sampler;
const SH_Y0 = ${SH_Y0};
const SH_Y1 = ${SH_Y1};
const SH_COS1 = 2.0 / 3.0;
const GI_OFFSET = ${GI_OFFSET_CELLS}.0;
const SKYVIS_OPEN_DC = ${SKYVIS_OPEN_DC};
const SHADOW_TINT_ID_SCALE = ${SHADOW_TINT_ID_SCALE}.0;
const VOLUME_SHADOW_BIAS = ${VOLUME_SHADOW_BIAS};
const SHADOW_NORMAL_OFFSET = 0.002;
const SHADOW_BIAS_MIN = 0.8;
const PCSS_TAPS = 8;
const PCSS_HARD_TEXELS = 1.0;
const PCSS_NS_MIN = 0.2;
const PCSS_BIAS = 0.35;
const CLOUD_SHADOW_SKIP = 0.01;
var<private> gFragCoord: vec2f;
struct Probe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
fn meanSigma(id: i32) -> f32 {
  let soda = vec3f(${GLASS_ALPHA_PER_CM.map((v) => (v * CELL_M * 100).toFixed(6)).join(', ')});
  return dot(select(SIGMA(id), max(SIGMA(id), soda), id == E_GLASS), vec3f(1.0 / 3.0));
}
// The four-tap WorldLight path has no PCSS, water caustics, clouds or wand-light gather.
fn underPool(sm: vec4f, d: f32, tid: i32) -> bool { return false; }
fn causticGain(p: vec3f, d: f32) -> f32 { return 1.0; }
fn wandLight(p: vec3f) -> vec3f { return vec3f(0.0); }
fn cloudShadow(p: vec3f) -> f32 { return 1.0; }
fn wk0(o: vec2i, w: vec2f) -> f32 { let a = select(1.0 - w, w, o == vec2i(1)); return a.x * a.y; }
${farLightReadersWGSL()}
fn meshIrradiance(g: Probe, n: vec3f) -> vec3f {
  let y1 = g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z;
  return max(SH_Y0 * g.c0.rgb + SH_COS1 * SH_Y1 * y1, vec3f(0.0)) + FU.caveAmbient;
}
`;

const sandDetail = /* wgsl */ `
// surface.js: avalanche tongues, two band-limited octaves of value noise.
fn slumpNoise(q: vec3f) -> vec4f {
  let i = floor(q);
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash13(i);
  let b = hash13(i + vec3f(1,0,0)) - a;
  let c = hash13(i + vec3f(0,1,0)) - a;
  let d = hash13(i + vec3f(0,0,1)) - a;
  let e = hash13(i + vec3f(1,1,0)) - a - b - c;
  let f1 = hash13(i + vec3f(1,0,1)) - a - b - d;
  let g = hash13(i + vec3f(0,1,1)) - a - c - d;
  let h = hash13(i + vec3f(1,1,1)) - a - b - c - d - e - f1 - g;
  let n = a + dot(vec3f(b,c,d), u) + dot(vec3f(e,f1,g), u.xxy * u.yzz) + h * u.x * u.y * u.z;
  let grad = vec3f(b + e*u.y + f1*u.z, c + e*u.x + g*u.z, d + f1*u.x + g*u.y) + h * u.yzx * u.zxy;
  return vec4f(n - 0.5, grad * du);
}
fn sandSlumps(p: vec3f, footprint: f32) -> vec4f {
  let a = CELL_M / 0.27;
  let b = 2.03 * a;
  let w = 1.0 - smoothstep(0.2, 0.6, a * footprint);
  if (w <= 0.0) { return vec4f(0.0); }
  let n = slumpNoise(p * a);
  var s = w * 0.5 * n * vec4f(1.0, vec3f(a));
  let w1 = 1.0 - smoothstep(0.2, 0.6, b * footprint);
  if (w1 > 0.0) { s += 0.25 * w1 * slumpNoise(p * b + 7.31) * vec4f(1.0, vec3f(b)); }
  return s;
}
// A lean version of surface.js's quartz facets: two screen-footprint bands,
// each in a fixed world lattice. Blend the bands instead of popping at LOD changes.
fn quartzFacet(p: vec3f, n: vec3f, h: vec3f, scale: f32) -> f32 {
  let q = p * scale;
  let c = floor(q);
  let seed = hash33(c + scale);
  let cover = 1.0 - smoothstep(0.10, 0.22, distance(fract(q), 0.25 + 0.5 * seed));
  let m = normalize(n + 0.8 * (hash33(c + scale + 41.7) - 0.5));
  return cover * smoothstep(0.993, 0.999, dot(m, h));
}
fn quartzGlints(p: vec3f, n: vec3f, v: vec3f, fp: f32) -> f32 {
  if (FU.glints <= 0.0 || fp > 1.0 || dot(n, FU.sun) <= 0.0) { return 0.0; }
  let l = clamp(log2(0.2 / max(fp, 1e-5)), -4.0, 10.0);
  let scale = exp2(floor(l));
  let h = normalize(v + FU.sun + vec3f(1e-6));
  return FU.glints * 0.85 * mix(quartzFacet(p, n, h, scale), quartzFacet(p, n, h, 2.0 * scale), fract(l)) * (1.0 - smoothstep(0.6, 1.0, fp));
}`;

const drawWGSL = (g, compact) => /* wgsl */ `
${prelude(g, { state: false })}${frameBindings()}${glslMod}${noiseGLSL}
${atmosphere}${renderLight}${sandDetail}${unpackNormal}
@group(1) @binding(0) var<storage, read> verts: array<vec4u>;
@group(1) @binding(1) var tMat: texture_2d_array<f32>;
@group(1) @binding(2) var sMat: sampler;
struct Vertex {
  @builtin(position) pos: vec4f,
  @location(0) p: vec3f,
  @location(1) n: vec3f,
  @location(2) @interpolate(flat) id: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> Vertex {
  let v = verts[vi];
  let p = bitcast<vec3f>(v.xyz);
  return Vertex(P.worldToClip * vec4f(p, 1.0), p, unpackNormal(v.w), v.w >> 24u);
}
fn srgb(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
// matTextured's colour/tint, one dominant plane with explicit mip gradients.
fn matTextured(id: i32, p: vec3f, n: vec3f, dx: vec3f, dy: vec3f) -> vec3f {
  let tm = TEXMAP(id);
  let layer = i32(tm.x);
  if (layer < 0 || layer + 1 >= i32(textureNumLayers(tMat))) { return ALBEDO(id); }
  let a = abs(n);
  var uv = p.xy; var gx = dx.xy; var gy = dy.xy;
  if (a.x >= max(a.y, a.z)) { uv = p.zy; gx = dx.zy; gy = dy.zy; }
  else if (a.y >= a.z) { uv = p.xz; gx = dx.xz; gy = dy.xz; }
  return srgb(textureSampleGrad(tMat, sMat, uv * tm.y, layer, gx * tm.y, gy * tm.y).rgb) * TEXTINT(id).rgb;
}
@fragment fn fs(i: Vertex) -> ${compact ? '@location(0) vec4f' : 'ColorDepth'} {
  let dx = dpdx(i.p);
  let dy = dpdy(i.p);
  let fp = max(length(dx), length(dy));
  let eye = FU.cam - i.p;
  let dist = max(length(eye), 1e-5);
  let view = eye / dist;
  let geom = normalize(i.n);
  var n = geom;
  var albedo = GROUND_ALB;
  var emit = vec3f(0.0);
  var glint = 0.0;
  if (i.id != ${FLOOR}u) {
    let id = i32(i.id);
    albedo = matTextured(id, i.p, n, dx, dy);
    emit = EMIT(id);
    if (id == E_SAND && FU.matDetail > 0.0) {
      let s = sandSlumps(i.p, fp);
      let grad = (s.yzw - n * dot(s.yzw, n)) * (0.06 / CELL_M) * FU.matDetail;
      n = normalize(n - grad);
      albedo *= 1.0 + 0.25 * s.x;
      glint = quartzGlints(i.p, n, view, fp);
    }
  }
  var direct = vec3f(0.0);
  let nl = max(dot(n, FU.sun), 0.0);
  if (nl > 0.0) {
    var shadow = vec3f(1.0);
    if (FU.shadows != 0u) { shadow = sunMapShadowAt(i.p + geom * 0.9); }
    direct = FU.sunCol * shadow * (nl * albedo + glint);
  }
  let probe = surfProbe(i.p, geom);
  let glow = glowClipAt(i.p + geom * 0.5) * FU.lightGain;
  let color = direct + albedo * (meshIrradiance(probe, n) + glow) + emit;
  let skyShare = clamp(probe.c0.a * (SH_Y0 / SKYVIS_OPEN_DC), 0.0, 1.0);
  let hdr = vec4f(farHazeAir(color, -view, dist, skyShare), 1.0);
  return ${compact ? 'hdr' : 'ColorDepth(hdr, i.pos.z)'};
}`;

const backgroundWGSL = (compact) => /* wgsl */ `
${frameBindings()}${atmosphere}
struct SkyVertex { @builtin(position) p: vec4f, @location(0) ndc: vec2f }
struct SkyOut { @location(0) color: vec4f, ${compact ? '' : '@location(1) clipDepth: f32,'} @builtin(frag_depth) depth: f32 }
@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyVertex {
  let ndc = vec2f(f32((i & 1u) * 4u), f32((i >> 1u) * 4u)) - 1.0;
  return SkyVertex(vec4f(ndc, 0.0, 1.0), ndc);
}
@fragment fn fs(i: SkyVertex) -> SkyOut {
  let a = P.clipToWorld * vec4f(i.ndc, 0.0, 1.0);
  let b = P.clipToWorld * vec4f(i.ndc, 0.99, 1.0);
  let ro = a.xyz / a.w;
  let rd = normalize(b.xyz / b.w - ro);
  let disc = smoothstep(cos(SUN_TAN_RADIUS * 1.1), cos(SUN_TAN_RADIUS * 0.9), dot(rd, FU.sun));
  var color = farAir(rd) + disc * FU.sunCol * 20.0;
  var depth = 1.0;
  if (rd.y < -1e-5) {
    let sea = select(FU.sea, P.sea, P.sea >= 0.0);
    let water = sea > 0.0 && sea > P.floor;
    let t = (select(P.floor, sea, water) - ro.y) / rd.y;
    let at = ro + rd * max(t, 0.0);
    let outside = any(at.xz < vec2f(0.0)) || any(at.xz >= P.size.xz);
    if (outside && t > 0.0) {
      if (water) {
        let fresnel = 0.02 + 0.98 * pow(1.0 + rd.y, 5.0);
        color = mix(vec3f(0.015, 0.075, 0.09) * (FU.skyUp + FU.sunCol * max(FU.sun.y, 0.0)), skyColor(reflect(rd, vec3f(0.0, 1.0, 0.0))), fresnel);
      } else {
        color = GROUND_ALB * (FU.skyUp + FU.sunCol * max(FU.sun.y, 0.0));
      }
      color = farHazeAir(color, rd, t, 1.0);
      let clip = P.worldToClip * vec4f(at, 1.0);
      depth = clamp(clip.z / clip.w, 0.0, 1.0);
    }
  }
  return SkyOut(vec4f(color, 1.0), ${compact ? '' : 'min(depth, 0.99999994), '}depth);
}`;

/** All entry-point modules (CPU validation uses these exact strings). */
export const meshGroundWGSL = (g, compact = false) => ({
  reset: resetWGSL, occupied: occupiedWGSL(g), field: fieldWGSL(g), blurX: blurWGSL(0), blurY: blurWGSL(1), blurZ: blurWGSL(2),
  verts: vertsWGSL, quads: quadsWGSL, args: argsWGSL, draw: drawWGSL(g, compact), background: backgroundWGSL(compact),
});

const ro = { buffer: { type: 'read-only-storage' } };
const rw = { buffer: { type: 'storage' } };
const compute = (binding, entry) => ({ binding, visibility: STAGE.COMPUTE, ...entry });
const fieldLayout = [compute(0, ro), compute(1, rw)];
const buildLayout = [...fieldLayout, ...[2, 3, 4, 5].map((i) => compute(i, rw))];
const drawLayout = [
  { binding: 0, visibility: STAGE.VERTEX, ...ro },
  { binding: 1, visibility: STAGE.FRAGMENT, texture: { viewDimension: '2d-array' } },
  { binding: 2, visibility: STAGE.FRAGMENT, sampler: {} },
];
const lightLayout = [...LIGHT_BINDINGS.map(([binding, , , d]) => ({ ...d, binding, visibility: STAGE.FRAGMENT })), { binding: 16, visibility: STAGE.FRAGMENT, sampler: {} }];
const targets = [{ format: 'rgba16float' }, { format: 'r32float' }];
const work = [
  ['reset', 1], ['occupied', 1], ['field', RAW_N], ['blurX', BLUR_X_N], ['blurY', BLUR_Y_N], ['blurZ', FIELD_N],
  ['verts', VN ** 3], ['quads', QN ** 3], ['args', 1],
];
const textureEntry = (binding, resource) => ({ binding, resource });
const bufferEntry = (binding, buffer) => textureEntry(binding, { buffer });

/** Full-world opaque mesh. `eye` and `viewProjModel` are in WorldCopy's cell space.
 * `draw` targets rgba16float S. The legacy MRT variant also writes r32float D;
 * compact mode exposes only hardware depth. `allocSize` is the attachment extent.
 */
export function createMeshGround(gpu, sim, worldCopy, worldLight, opts = {}) {
  const size = worldCopy.size ?? [sim.g.nx, sim.g.ny, sim.g.nz];
  const label = (x) => `sim${sim.id} mesh ground ${x}`;
  const maxBuffer = Math.min(gpu.device.limits.maxStorageBufferBindingSize, gpu.device.limits.maxBufferSize);
  const fixed = Math.max(...size) <= 4 * C;
  const slots = Math.min(opts.slots ?? SLOTS, fixed ? size.reduce((n, s) => n * Math.ceil(s / C), 1) : 512,
    Math.floor(maxBuffer / Math.max(VCAP * VBYTES, ICAP * IBYTES)));
  if (!Number.isInteger(slots) || slots < 1) throw new RangeError('mesh pool needs a positive integer capacity');
  const planLimit = fixed ? slots : Math.floor(slots / 2); // old and new partitions can coexist until commit
  const initial = meshLodPlan(size, null, planLimit);
  const B = (size, usage, name) => gpu.createBuffer({ size, usage, label: label(name) });
  const U = GPUBufferUsage;
  const buffers = {
    jobs: B(BATCH * JOB_WORDS * 4, U.STORAGE | U.COPY_DST, 'jobs'),
    scratch: B(BATCH * STRIDE * 4, U.STORAGE, 'scratch'),
    verts: B(slots * VCAP * VBYTES, U.STORAGE, 'verts'),
    indices: B(slots * ICAP * IBYTES, U.STORAGE | U.INDEX, 'indices'),
    counts: B(slots * 8, U.STORAGE, 'counts'),
    args: B(slots * ARG_WORDS * 4, U.STORAGE | U.INDIRECT, 'args'),
  };
  const L = {
    frame: gpu.layout('FRAME', RENDER_LAYOUT.FRAME),
    field: gpu.layout('MESH_GROUND_FIELD', fieldLayout),
    build: gpu.layout('MESH_GROUND_BUILD', buildLayout),
    draw: gpu.layout('MESH_GROUND_DRAW', drawLayout),
    light: gpu.layout('MESH_GROUND_LIGHT', lightLayout),
  };
  const { compact = false } = opts;
  const source = meshGroundWGSL(sim.g, compact);
  const readsWorldCopy = (name) => name === 'occupied' || name === 'field';
  const K = Object.fromEntries(work.map(([name]) => [name, gpu.kernel({ name: `mesh ground ${name}`, code: source[name],
    layouts: readsWorldCopy(name) ? [sim.L.TABLES, worldCopy.layout, L.field] : [undefined, undefined, L.build],
    workgroupSize: [WG, 1, 1], params: BuildParams,
  })]));
  const render = (name, layouts, depthCompare) => gpu.renderPipeline({
    name: `mesh ground ${name}`, code: source[name], layouts, params: ViewParams,
    vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: compact ? targets.slice(0, 1) : targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare },
  });
  const draw = render('draw', [L.frame, L.draw, L.light], 'less');
  const sky = render('background', [L.frame], 'always');
  const pipelines = [...Object.values(K), draw, sky];
  const ready = Promise.all(pipelines.map((p) => p.ready));
  ready.catch(() => {});
  const group = (layout, entries, name) => gpu.bindGroup(layout, entries, label(name));
  const fieldGroup = group(L.field, ['jobs', 'scratch'].map((k, i) => bufferEntry(i, buffers[k])), 'field');
  const buildGroup = group(L.build, Object.keys(buffers).map((k, i) => bufferEntry(i, buffers[k])), 'build');
  const clamp = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const repeat = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  const lightGroup = group(L.light, [...worldLight.bindEntries(), textureEntry(16, clamp)], 'light');
  const { resident, sync } = meshSlotCache(slots);
  const words = new Int32Array(BATCH * JOB_WORDS);
  const inverse = new Matrix4();
  const variant = (plan) => plan.map((ch) => ({ ...ch, key: `${ch.key}/${ch.faces}` }));
  let active = [], pending = variant(initial), anchor = '', rev = -1;
  let depth, depthView, distance, distanceView, lastDepthOut, matView, matGroup;
  const stats = { meshedLast: 0, meshedTotal: 0, drawnChunks: 0, slots, planLimit };
  const mesh = {
    ready,
    get isReady() { return pipelines.every((p) => p.state === 'ready'); },
    get coverageReady() { return active.length > 0; },
    get busy() {
      if (pending.length) return true;
      for (const ch of resident.values()) if (ch.dirty) return true;
      return false;
    },
    get resident() { return resident.size; },
    get depthTexture() { return depth; },
    get depthView() { return depthView; },
    get distanceView() { return lastDepthOut; },
    get bytes() { return Object.values(buffers).reduce((n, b) => n + b.size, 0) + ((depth?.width ?? 0) * (depth?.height ?? 0) * 4 * (distance ? 2 : 1)); },
    frameLayout: L.frame,
    stats,
    update(frame, eye) {
      stats.meshedLast = 0;
      if (!mesh.isReady || !worldCopy.bindGroup) return;
      eye = xyz(eye);
      // Retarget at a stable sample point. Finish a pending partition before replacing it.
      const p = eye.map((v) => (Math.floor(v / 16) + 0.5) * 16);
      const key = p.join(',');
      if (!fixed && !pending.length && key !== anchor) {
        pending = variant(meshLodPlan(size, p, planLimit));
        anchor = key;
      }
      sync([...new Map([...active, ...pending].map((ch) => [ch.key, ch])).values()]);
      const now = worldCopy.revision;
      if (now !== rev) {
        const changes = worldCopy.changesSince(rev);
        for (const ch of resident.values()) if (!ch.dirty && meshChunkDirty(ch, changes)) ch.dirty = true;
        rev = now;
      }
      const jobs = [...resident.values()].filter((ch) => ch.dirty);
      jobs.sort((a, b) => Number(a.built) - Number(b.built) || a.lod - b.lod || distance2(a, eye) - distance2(b, eye));
      jobs.length = Math.min(BATCH, jobs.length);
      if (jobs.length) {
        jobs.forEach((ch, i) => words.set([...ch.lo, ch.slot, ch.step, ch.faces], i * JOB_WORDS));
        gpu.device.queue.writeBuffer(buffers.jobs, 0, words, 0, jobs.length * JOB_WORDS);
        const buildBind = [gpu.emptyGroup, gpu.emptyGroup, buildGroup];
        const wcBind = [sim.tables, worldCopy.bindGroup, fieldGroup];
        for (const [name, n] of work) K[name].dispatch(frame, n === 1 ? [1, 1, 1] : [Math.ceil(n / WG), jobs.length, 1], {
          bind: readsWorldCopy(name) ? wcBind : buildBind, params: { n: jobs.length },
        });
        for (const ch of jobs) { ch.built = true; ch.dirty = false; }
        stats.meshedLast = jobs.length;
        stats.meshedTotal += jobs.length;
      }
      if (pending.length && pending.every((ch) => resident.get(ch.key).built)) { active = pending; pending = []; sync(active); }
    },
    draw(frame, { views, w, h, allocSize = [w, h] }, frameGroup, viewProjModel) {
      if (!mesh.isReady) return false;
      const tex = (format, name) => gpu.createTexture({ label: label(name), size: allocSize, format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      if (!depth || depth.width !== allocSize[0] || depth.height !== allocSize[1]) {
        if (depth) gpu.flush('mesh ground resize');
        depth?.destroy(); distance?.destroy(); distance = distanceView = null;
        depth = tex('depth32float', 'hardware depth');
        depthView = depth.createView();
      }
      if (!compact && !views.D && !distance) { distance = tex('r32float', 'clip depth'); distanceView = distance.createView(); }
      lastDepthOut = compact ? null : views.D ?? distanceView;
      const mt = materialTextures(gpu);
      if (matView !== mt.view) {
        matView = mt.view;
        matGroup = group(L.draw, [bufferEntry(0, buffers.verts), textureEntry(1, mt.view), textureEntry(2, repeat)], 'draw');
      }
      const colorAttachments = (compact ? [views.S] : [views.S, lastDepthOut]).map((view) => ({ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }));
      const rp = frame.render({ colorAttachments, depthStencilAttachment: {
        view: depthView, depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store',
      } }, 'mesh ground');
      const params = { clipToWorld: inverse.copy(viewProjModel).invert().elements, worldToClip: viewProjModel.elements, size,
        floor: opts.floor ?? 0, sea: opts.sea ?? -1 };
      const fr = meshFrustum(viewProjModel);
      let drawn = 0;
      try {
        if (w !== allocSize[0] || h !== allocSize[1]) {
          rp.setViewport(0, 0, w, h, 0, 1);
          rp.setScissorRect(0, 0, w, h);
        }
        sky.draw(rp, { bind: [frameGroup], params });
        for (const ch of active.length ? active : pending) {
          const r = resident.get(ch.key);
          if (!r?.built || !meshChunkVisible(ch, fr)) continue;
          const offset = r.slot * ARG_WORDS * 4;
          if (!drawn++) draw.draw(rp, { bind: [frameGroup, matGroup, lightGroup], params,
            index: { buffer: buffers.indices, format: 'uint16' }, indirect: { buffer: buffers.args, offset } });
          else { rp.drawIndexedIndirect(buffers.args, offset); gpu.stats.draws++; }
        }
      } finally { rp.end(); }
      stats.drawnChunks = drawn;
      return true;
    },
    dispose() { Object.values(buffers).forEach((b) => b.destroy()); depth?.destroy(); distance?.destroy(); },
  };
  return mesh;
}

// Expose exact pipeline layouts to the repository's CPU binding/reflection sweep.
export const WGSL_CHECK = () => work.map(([entry]) => ({
  name: `mesh ground ${entry}`, kind: 'compute', grids: ['128'], warm: false,
  layouts: () => entry === 'occupied' || entry === 'field' ? [[RENDER_LAYOUT.FRAME[0]], WORLD_COPY_LAYOUT, fieldLayout] : [[], [], buildLayout],
  code: (g) => meshGroundWGSL(g)[entry],
})).concat(['draw', 'background'].map((entry) => ({
  name: `mesh ground ${entry}`, kind: 'render', grids: ['128'], warm: false,
  layouts: () => entry === 'draw' ? [RENDER_LAYOUT.FRAME, drawLayout, lightLayout] : [RENDER_LAYOUT.FRAME],
  code: (g) => meshGroundWGSL(g)[entry],
})));
