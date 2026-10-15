// Isolated-cell geometry only. Liquid/molten/glass and independent energy
// particles (src/rays.js) remain owned by optics/the existing renderer.
import { prelude, STATE_OPTS, STAGE } from '../common.js';
import { frameBindings } from '../bindings.js';
import { materialsGLSL, THIN_RADIUS } from '../../gfx/materials.js';
import { uniformStruct } from '../../gpu/params.js';

export const PARTICLE_OWNERSHIP = Object.freeze({ channels: Object.freeze([2, 3]), liquids: false, molten: false, glass: false });

export const PARTICLE_BYTES = 32;
export const PARTICLE_VERTICES = 96; // subdivided octahedron (32 triangles)
export const PARTICLE_RADIUS = THIN_RADIUS;
export const PARTICLE_LOD_PIXELS = 8;
export const ParticleMeshParams = uniformStruct('ParticleMeshParams', { capacity: 'u32', slot: 'u32', world: 'u32' });
export const ParticleDrawParams = uniformStruct('ParticleDrawParams', { matrix: 'mat4x4f', viewport: 'vec2f' });
export const PARTICLE_MESH_LAYOUT = [0, 1, 2, 3].map((binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }));
export const PARTICLE_DRAW_LAYOUT = [{ binding: 0, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } }];

/**
 * Exact ownership, shared with extraction. Requires SURFCH, CH_GRANULAR,
 * CH_ORGANIC, inGrid, fetchA, eid and NX/NY/NZ. `world` rejects the one-cell
 * x/z window halo: its unseen neighbours cannot be classified honestly.
 * All 26 neighbours, including across bricks, are tested in state, NOT in
 * fieldThin (thin features are already boosted there and may still be visible).
 * Producers MUST remove owned cells BEFORE blur/EMA/extraction, not simply
 * discard triangles whose nearest cell is owned: their blurred tails remain.
 */
export const particleOwnershipWGSL = /* wgsl */ `
fn hybridParticleChannel(id: i32) -> bool {
  return SURFCH(id) == CH_GRANULAR || SURFCH(id) == CH_ORGANIC;
}
fn hybridParticleOwns(c: vec3i, world: bool) -> bool {
  if (!inGrid(c)) { return false; }
  if (world && (c.x == 0 || c.z == 0 || c.x == NX - 1 || c.z == NZ - 1)) { return false; }
  let ch = SURFCH(eid(fetchA(c)));
  if (ch != CH_GRANULAR && ch != CH_ORGANIC) { return false; }
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0 && z == 0) { continue; }
        let q = c + vec3i(x, y, z);
        if (inGrid(q)) {
          if (SURFCH(eid(fetchA(q))) == ch) { return false; }
        }
      }
    }
  }
  return true;
}`;

/** CPU mirror: channelAt(cell) returns 0 liquid, 1 molten, 2 granular,
 * 3 organic, or -1 crisp/empty. size is [nx,ny,nz]. */
export function particleOwns(cell, size, channelAt, world = false) {
  const inside = (p) => p.every((v, i) => v >= 0 && v < size[i]);
  if (!inside(cell)) return false;
  const [cx, , cz] = cell;
  if (world && (cx === 0 || cz === 0 || cx === size[0] - 1 || cz === size[2] - 1)) return false;
  const ch = channelAt(cell);
  if (ch !== 2 && ch !== 3) return false;
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    if (!(x || y || z)) continue;
    const p = [cell[0] + x, cell[1] + y, cell[2] + z];
    if (inside(p) && channelAt(p) === ch) return false;
  }
  return true;
}

/** Physical coordinates: no seed jitter, invented displacement or minimum
 * screen size. Simulation matter is cell-centred (velocity is not position). */
export const particleGeometry = (cell) => ({ center: cell.map((x) => x + 0.5), radius: PARTICLE_RADIUS });
/** CPU mirror of hpDetailed's diameter estimate. vp is column-major
 * viewProj*model; returns Infinity when the sphere reaches the eye plane. */
export function particleFootprint(center, vp, viewport) {
  const project = (p) => [0, 1, 3].map((r) => vp[r] * p[0] + vp[r + 4] * p[1] + vp[r + 8] * p[2] + vp[r + 12]);
  if (project(center)[2] <= 0.0001) return Infinity;
  let pixels = 0;
  for (let axis = 0; axis < 3; axis++) {
    const lo = [...center], hi = [...center];
    lo[axis] -= PARTICLE_RADIUS; hi[axis] += PARTICLE_RADIUS;
    const a = project(lo), b = project(hi);
    if (Math.min(a[2], b[2]) <= 0.0001) return Infinity;
    pixels = Math.max(pixels, Math.hypot(...[0, 1].map((i) => (b[i] / b[2] - a[i] / a[2]) * viewport[i] * 0.5)));
  }
  return pixels;
}
export function particleCapacity(slots, maxBinding, requested = slots) {
  if (![slots, requested].every((v) => Number.isSafeInteger(v) && v > 0) || !(maxBinding >= PARTICLE_BYTES)) throw new RangeError('Invalid particle capacity');
  return Math.min(slots, requested, Math.floor(maxBinding / PARTICLE_BYTES));
}
/** CPU compaction oracle; an overflowing generation is entirely suppressed. */
export function particleCompaction(count, capacity) {
  if (![count, capacity].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new RangeError('Invalid particle count');
  const overflow = count > capacity;
  return { count, overflow, args: [PARTICLE_VERTICES, overflow ? 0 : count, 0, 0] };
}

const instanceWGSL = /* wgsl */ `
struct HybridParticle {
  center: vec3f,
  id: u32,
  a: vec4f, // complete unquantized source A: id, Celsius, life, ctype+seed
}
`;

export const particleMeshWGSL = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${ParticleMeshParams.wgsl}
@group(3) @binding(1) var<uniform> P: ParticleMeshParams;
${instanceWGSL}
@group(2) @binding(0) var<storage, read_write> particles: array<HybridParticle>;
@group(2) @binding(1) var<storage, read_write> count: atomic<u32>;
@group(2) @binding(2) var<storage, read_write> args: array<u32, 4>;
@group(2) @binding(3) var<storage, read_write> results: array<vec4u>;
${particleOwnershipWGSL}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u,
  @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let c = cellOf(s);
  if (!hybridParticleOwns(c, P.world != 0u)) { return; }
  let index = atomicAdd(&count, 1u);
  if (index < P.capacity) {
    let a = fetchAs(s);
    particles[index] = HybridParticle(vec3f(c) + vec3f(0.5), u32(eid(a)), a);
  }
}
@compute @workgroup_size(1) fn finish() {
  let n = atomicLoad(&count);
  let overflow = n > P.capacity;
  args[0] = ${PARTICLE_VERTICES}u;
  args[1] = select(n, 0u, overflow); // never draw a silently truncated generation
  args[2] = 0u;
  args[3] = 0u;
  results[P.slot] = vec4u(n, select(0u, 1u, overflow), P.capacity, 0u);
  atomicStore(&count, 0u);
}`;

// Generate an octahedron with winding irrelevant (cullMode none). At <=8 px
// only the first 8 triangles survive; the remaining vertices degenerate.
// Large footprints subdivide each octant four ways, with normalized midpoints.
function meshVertices() {
  const out = [];
  const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  for (let z of [-1, 1]) for (let y of [-1, 1]) for (let x of [-1, 1]) {
    const a = [x, 0, 0], b = [0, y, 0], c = [0, 0, z];
    const ab = unit([x, y, 0]), bc = unit([0, y, z]), ca = unit([x, 0, z]);
    out.push(...[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]);
  }
  return out;
}
const vertices = meshVertices();
export { vertices as particleUnitVertices };

const geometryWGSL = /* wgsl */ `
${instanceWGSL}
${ParticleDrawParams.wgsl}
@group(3) @binding(1) var<uniform> P: ParticleDrawParams;
@group(1) @binding(0) var<storage, read> particles: array<HybridParticle>;
const HP_RADIUS: f32 = ${PARTICLE_RADIUS};
const HP_VERTICES = array<vec3f, ${PARTICLE_VERTICES}>(
${vertices.map((v) => `vec3f(${v.map((x) => x.toFixed(8)).join(', ')})`).join(',\n')});
fn hpUnit(vi: u32, detailed: bool) -> vec3f {
  if (detailed) { return HP_VERTICES[vi]; }
  if (vi >= 24u) { return vec3f(0.0); }
  let face = vi / 3u;
  let k = vi % 3u;
  let sx = select(-1.0, 1.0, (face & 1u) != 0u);
  let sy = select(-1.0, 1.0, (face & 2u) != 0u);
  let sz = select(-1.0, 1.0, (face & 4u) != 0u);
  if (k == 0u) { return vec3f(sx, 0.0, 0.0); }
  if (k == 1u) { return vec3f(0.0, sy, 0.0); }
  return vec3f(0.0, 0.0, sz);
}`;

/** Optional shading composition seam: WGSL defines
 * hybridParticleShade(id:i32,seed:f32,p:vec3f,n:vec3f,temp:f32)->vec3f.
 * p/n are grid-cell physical position/normal; seed is fract(source A.w),
 * Celsius is unmodified. Adapter may call hybridMaterial(id,seed,p,n,temp)
 * and the light lane; result is opaque linear HDR radiance (alpha is 1).
 * Additional bindings live at group 2; no other ABI is changed.
 */
export const particleDrawWGSL = (g, { shadeWGSL = '' } = {}) => /* wgsl */ `
${prelude(g, { state: false })}
${frameBindings()}
${materialsGLSL()}
${geometryWGSL}
${shadeWGSL || /* wgsl */ `
fn hybridParticleShade(id: i32, seed: f32, p: vec3f, n: vec3f, temp: f32) -> vec3f {
  let jitter = 1.0 + (seed * 2.0 - 1.0) * COLORVAR(id);
  let albedo = ALBEDO(id) * jitter;
  let sky = mix(FU.ground, FU.skyUp, n.y * 0.5 + 0.5) + FU.caveAmbient;
  let direct = FU.sunCol * FU.sunExt * FU.keyLight * max(dot(n, normalize(FU.sun)), 0.0);
  return albedo * (sky + direct) + emission(id, temp);
}`}
struct VOut {
  @builtin(position) position: vec4f,
  @location(0) grid: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) a: vec4f,
}
fn hpDetailed(center: vec3f) -> bool {
  let vp = FU.viewProj * FU.model;
  let c = vp * vec4f(center, 1.0);
  if (c.w <= 0.0001) { return true; }
  var pixels = 0.0;
  for (var axis = 0u; axis < 3u; axis++) {
    var d = vec3f(0.0);
    d[axis] = HP_RADIUS;
    let lo = vp * vec4f(center - d, 1.0);
    let hi = vp * vec4f(center + d, 1.0);
    if (min(lo.w, hi.w) <= 0.0001) { return true; }
    pixels = max(pixels, length((hi.xy / hi.w - lo.xy / lo.w) * P.viewport * 0.5));
  }
  return pixels > ${PARTICLE_LOD_PIXELS}.0;
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let instance = particles[ii];
  let u = hpUnit(vi, hpDetailed(instance.center));
  let p = instance.center + HP_RADIUS * u;
  var o: VOut;
  o.position = FU.viewProj * FU.model * vec4f(p, 1.0);
  o.grid = p;
  o.normal = u;
  o.a = instance.a;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  return vec4f(hybridParticleShade(eid(i.a), fract(i.a.w), i.grid, normalize(i.normal), i.a.y), 1.0);
}`;

/** matrix is grid -> light clip, WebGPU [0,1]; always full-detail geometry. */
export const particleShadowWGSL = () => /* wgsl */ `
${geometryWGSL}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let p = particles[ii].center + HP_RADIUS * hpUnit(vi, true);
  return P.matrix * vec4f(p, 1.0);
}`;
