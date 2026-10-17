// Persistent crisp-solid surfaces. No copied material/heat: faces contain only
// (simulation slot << 3) | side. See gfx/hybrid/geometry.js for lifecycle/ABI.
import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims } from '../common.js';
import { frameBindings, RENDER_LAYOUT } from '../bindings.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { uniformStruct } from '../../gpu/params.js';
import { fold } from '../../gpu/kernels.js';

export const MAX_FACES_PER_BRICK = 64 * 6;
export const FACE_BYTES = 4;
export const RESULT_BYTES = 16;
export const GeometryParams = uniformStruct('HybridGeometryParams', {
  capacity: 'u32', force: 'u32', world: 'u32', slot: 'u32',
});
export const ShadowParams = uniformStruct('HybridGeometryShadowParams', { matrix: 'mat4x4f' });
const storage = (binding, type = 'storage', visibility = STAGE.COMPUTE) => ({ binding, visibility, buffer: { type } });
// Separate mesh/compact layouts stay within eight storage bindings per stage.
export const MESH_LAYOUT = [0, 1, 2].map(b => storage(b));
export const COMPACT_LAYOUT = [storage(0), storage(1, 'read-only-storage'), ...[2, 3, 4, 5].map(b => storage(b))];
export const compactLayouts = () => [LAYOUT.TABLES, LAYOUT.EMPTY, COMPACT_LAYOUT];
export const FACES_LAYOUT = [storage(0, 'read-only-storage', STAGE.VERTEX)];
export const meshLayouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RO, MESH_LAYOUT];
export const drawLayouts = () => [RENDER_LAYOUT.FRAME, LAYOUT.STATE_RO, FACES_LAYOUT];
export const CLASSIFY_WGSL = /* wgsl */ `
fn hybridCrispOpaque(id: i32) -> bool {
  return id != E_EMPTY && RCLASS(id) == R_OPAQUE && SURFCH(id) < 0 && MEDIACH(id) < 0;
}
`;

/** Pure allocation policy; 384 is a proof bound, never an assumed scene density. */
export function geometryCapacity(grid, limits = {}, requested = MAX_FACES_PER_BRICK) {
  const g = gridDims(grid);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_FACES_PER_BRICK) throw new RangeError('geometry facesPerBrick must be 1..384');
  const max = Math.min(limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024, limits.maxBufferSize ?? 256 * 1024 * 1024);
  const capacity = Math.min(requested, Math.floor(max / (g.nbricks * FACE_BYTES)));
  const reason = g.slots > 0x20000000 ? 'slot-index-range' : capacity < 1 || g.slots * 4 > max || g.nbricks * 16 > max ? 'device-buffer-limit' : null;
  return { capacity, faceBytes: g.nbricks * capacity * FACE_BYTES, guaranteed: capacity === MAX_FACES_PER_BRICK, reason };
}

export const meshWGSL = grid => /* wgsl */ `
${prelude(grid, STATE_OPTS.STATE_RO)}
${GeometryParams.wgsl}
@group(3) @binding(1) var<uniform> P: HybridGeometryParams;
struct BrickMesh { changed: u32, unsupported: u32, count: u32, rebuilt: u32 }
@group(2) @binding(0) var<storage, read_write> previous: array<u32>;
@group(2) @binding(1) var<storage, read_write> bricks: array<BrickMesh>;
@group(2) @binding(2) var<storage, read_write> faces: array<u32>;
${CLASSIFY_WGSL}
var<workgroup> changed: atomic<u32>;
var<workgroup> unsupported: atomic<u32>;
var<workgroup> count: atomic<u32>;

// Exact comparison, not a collision-prone hash. Only material identity affects
// topology. Temperature, life, tint and velocity are read at draw time instead.
@compute @workgroup_size(64)
fn compare(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = wg.x + wg.y * nwg.x;
  if (b >= NBRICKS) { return; }
  if (li == 0u) { atomicStore(&changed, P.force); atomicStore(&unsupported, 0u); }
  workgroupBarrier();
  let s = b * 64u + li;
  let a = fetchA(cellOf(s));
  let id = eid(a);
  let key = select(0u, u32(id) + 1u, hybridCrispOpaque(id));
  if (previous[s] != key) { atomicOr(&changed, 1u); }
  previous[s] = key;
  if (hybridCrispOpaque(id) && appearanceOf(id, a.w) != AP_NONE) { atomicOr(&unsupported, 1u); }
  workgroupBarrier();
  if (li == 0u) {
    bricks[b].changed = atomicLoad(&changed);
    bricks[b].unsupported = atomicLoad(&unsupported);
  }
}
fn occupied(p: vec3i) -> bool {
  if (p.y < 0) { return true; } // existing box floor/world bedrock
  if (p.y >= NY) { return false; }
  if (p.x < 0 || p.z < 0 || p.x >= NX || p.z >= NZ) { return P.world != 0u; }
  return hybridCrispOpaque(eid(fetchA(p)));
}
fn faceDir(side: u32) -> vec3i {
  var d = vec3i(0);
  d[side >> 1u] = select(-1, 1, (side & 1u) != 0u);
  return d;
}
@compute @workgroup_size(64)
fn mesh(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = wg.x + wg.y * nwg.x;
  if (b >= NBRICKS) { return; }
  let bc = brickCoord(b);
  var dirty = bricks[b].changed != 0u;
  // No diagonal AO in this producer, so exactly the six face neighbours suffice.
  for (var side = 0u; side < 6u; side++) {
    let q = bc + faceDir(side);
    if (all(q >= vec3i(0)) && all(q < vec3i(BX, BY, BZ))) {
      dirty = dirty || bricks[brickId(q)].changed != 0u;
    }
  }
  if (li == 0u) { bricks[b].rebuilt = select(0u, 1u, dirty); atomicStore(&count, 0u); }
  // Storage-derived flags are not uniform to WGSL's validator. All lanes
  // reach both barriers; only dirty bricks change persistent face slots.
  workgroupBarrier();
  let s = b * 64u + li;
  let p = cellOf(s);
  if (dirty && hybridCrispOpaque(eid(fetchA(p)))) {
    for (var side = 0u; side < 6u; side++) {
      if (!occupied(p + faceDir(side))) {
        let at = atomicAdd(&count, 1u);
        if (at < P.capacity) { faces[b * P.capacity + at] = (s << 3u) | side; }
      }
    }
  }
  workgroupBarrier();
  if (li == 0u && dirty) { bricks[b].count = atomicLoad(&count); }
}
`;

// Separate module/layout: no state buffers, keeping below eight storage buffers.
export const compactWGSL = grid => /* wgsl */ `
${prelude(grid, { state: false })}
${GeometryParams.wgsl}
@group(3) @binding(1) var<uniform> P: HybridGeometryParams;
struct BrickMesh { changed: u32, unsupported: u32, count: u32, rebuilt: u32 }
struct Control { total: u32, rebuilt: u32, overflow: u32, unsupported: u32, needsCompact: u32 }
@group(2) @binding(0) var<storage, read_write> bricks: array<BrickMesh>;
@group(2) @binding(1) var<storage, read> faces: array<u32>;
@group(2) @binding(2) var<storage, read_write> compactFaces: array<u32>;
@group(2) @binding(3) var<storage, read_write> args: array<u32>;
@group(2) @binding(4) var<storage, read_write> control: Control;
@group(2) @binding(5) var<storage, read_write> results: array<u32>;
// Exclusive prefix over brick counts. This small serial pass is a baseline,
// not a claimed optimized parallel scan. Never reads face/volume data on CPU.
@compute @workgroup_size(1)
fn prepare() {
  var total = 0u;
  var rebuilt = 0u;
  var overflow = 0u;
  var bad = 0u;
  for (var b = 0u; b < NBRICKS; b++) {
    bricks[b].changed = total; // compare overwrites this before the next mesh
    total += bricks[b].count;
    rebuilt += bricks[b].rebuilt;
    overflow |= select(0u, 1u, bricks[b].count > P.capacity);
    bad |= bricks[b].unsupported;
  }
  let retry = (control.overflow | control.unsupported) != 0u;
  control = Control(total, rebuilt, overflow, bad, select(0u, 1u, rebuilt != 0u || retry));
}
@compute @workgroup_size(64)
fn compact(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = wg.x + wg.y * nwg.x;
  if (b >= NBRICKS || control.needsCompact == 0u || (control.overflow | control.unsupported) != 0u) { return; }
  for (var j = li; j < bricks[b].count; j += 64u) {
    compactFaces[bricks[b].changed + j] = faces[b * P.capacity + j];
  }
}
// A small validation/status readback only. No CPU draw counts. Suppress the
// WHOLE mesh on overflow/unsupported appearance, never silently drop faces.
@compute @workgroup_size(1)
fn finish() {
  args[0] = 6u;
  args[1] = select(0u, control.total, (control.overflow | control.unsupported) == 0u);
  args[2] = 0u;
  args[3] = 0u;
  results[P.slot * 4u] = control.rebuilt;
  results[P.slot * 4u + 1u] = control.overflow;
  results[P.slot * 4u + 2u] = control.unsupported;
  results[P.slot * 4u + 3u] = 0u;
}
`;

/** Reusable vertex ABI for shared PBR: call hybridVertex(vi, ii).
 * Requires common prelude + frameBindings, faces at group 2 binding 0 and live
 * state at group 1. vi is 0..5; ii addresses the compact live face list.
 * grid/normal stay in physical grid axes; FU.model only controls presentation.
 */
export const VERTEX_WGSL = /* wgsl */ `
@group(2) @binding(0) var<storage, read> hybridFaces: array<u32>;
struct HybridVertex {
  grid: vec3f,
  normal: vec3f,
  slot: u32,
}
fn hybridVertex(vi: u32, ii: u32) -> HybridVertex {
  let word = hybridFaces[ii];
  let side = word & 7u;
  let axis = side >> 1u;
  let plus = (side & 1u) != 0u;
  let v = vi % 6u;
  let c = select(v, select(v - 2u, 0u, v == 3u), v >= 3u);
  let u = select(0.0, 1.0, c == 1u || c == 2u);
  let w = select(0.0, 1.0, c >= 2u);
  var p = vec3f(cellOf(word >> 3u));
  p[axis] += select(0.0, 1.0, plus);
  p[(axis + 1u) % 3u] += select(w, u, plus);
  p[(axis + 2u) % 3u] += select(u, w, plus);
  var n = vec3f(0.0);
  n[axis] = select(-1.0, 1.0, plus);
  return HybridVertex(p, n, word >> 3u);
}
`;

export const drawWGSL = (grid, { shadingWGSL = '', shade = null } = {}) => /* wgsl */ `
${prelude(grid, STATE_OPTS.STATE_RO)}
${frameBindings()}
${materialsGLSL()}
${VERTEX_WGSL}
${shadingWGSL}
struct VOut {
  @builtin(position) position: vec4f,
  @location(0) grid: vec3f,
  @location(1) @interpolate(flat) normal: vec3f,
  @location(2) @interpolate(flat) slot: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let v = hybridVertex(vi, ii);
  return VOut(FU.viewProj * FU.model * vec4f(v.grid, 1.0), v.grid, v.normal, v.slot);
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let footprint = max(length(dpdx(v.grid)), length(dpdy(v.grid)));
  let a = fetchA(cellOf(v.slot));
  let id = eid(a);
  ${shade ? `return ${shade}(id, a, v.grid, v.normal, footprint);` : `
  let tint = 1.0 + COLORVAR(id) * (fract(a.w) * 2.0 - 1.0);
  let alb = ALBEDO(id) * tint;
  let diffuse = alb * (FU.sunCol * max(dot(v.normal, FU.sun), 0.0) + FU.skyUp * (0.35 + 0.65 * max(v.normal.y, 0.0)) + FU.caveAmbient);
  return vec4f((diffuse + cellEmission(id, a.y, a.w) + sparkEmit(id, a.w)) * FU.lightGain, 1.0);`}
}
`;
export const shadowWGSL = grid => /* wgsl */ `
${prelude(grid, { state: false })}
${VERTEX_WGSL}
${ShadowParams.wgsl}
@group(3) @binding(1) var<uniform> P: HybridGeometryShadowParams;
@vertex fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return P.matrix * vec4f(hybridVertex(vi, ii).grid, 1.0);
}
`;
export const geometryPipelines = () => ({
  opaque: {
    vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
  },
  shadow: {
    vertex: { entry: 'vsShadow' }, fragment: null,
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
  },
});
// Parent may run the repository's native WGSL checker; CPU lane tests only parse.
export const WGSL_CHECK = () => {
  const p = geometryPipelines();
  return [
    ...['compare', 'mesh'].map(entry => ({
      name: `hybrid.geometry.${entry}`, kind: 'compute', code: meshWGSL, entry,
      layouts: meshLayouts, layoutNames: ['TABLES', 'STATE_RO', 'HYBRID_GEOMETRY_MESH'], params: GeometryParams,
      workgroupSize: [entry === 'finish' ? 1 : 64, 1, 1], dispatch: g => entry === 'finish' ? [1, 1, 1] : fold(gridDims(g).nbricks), warm: false,
    })),
    ...['prepare', 'compact', 'finish'].map(entry => ({
      name: `hybrid.geometry.${entry}`, kind: 'compute', code: compactWGSL, entry,
      layouts: compactLayouts, layoutNames: ['TABLES', 'EMPTY', 'HYBRID_GEOMETRY_COMPACT'], params: GeometryParams,
      workgroupSize: [entry === 'compact' ? 64 : 1, 1, 1], dispatch: g => entry === 'compact' ? fold(gridDims(g).nbricks) : [1, 1, 1], warm: false,
    })),
    { name: 'hybrid.geometry.opaque', kind: 'render', code: g => drawWGSL(g, 384), layouts: drawLayouts,
      layoutNames: ['FRAME', 'STATE_RO', 'HYBRID_GEOMETRY_FACES'], ...p.opaque, warm: false },
    { name: 'hybrid.geometry.shadow', kind: 'render', code: g => shadowWGSL(g, 384), layouts: () => [LAYOUT.TABLES, LAYOUT.EMPTY, FACES_LAYOUT],
      layoutNames: ['TABLES', 'EMPTY', 'HYBRID_GEOMETRY_FACES'], params: ShadowParams, ...p.shadow, warm: false },
  ];
};
