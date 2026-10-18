// Explicit sparse world ABI, not a rewrite of the local shader library.
import { AUX_RECORDS, LIGHT_RECORDS, READY, WORLD_ATLAS_ABI, WRITER_CHANNELS, PAGE_CHANNELS, worldReaderLayouts, worldWriterLayouts } from '../world/renderAtlas.js';

/** Caller MUST worldBeginQuery(), perform the WHOLE dependent ray/shading
 * query, then test worldQueryIncomplete(). Placeholder zeros are unusable
 * when incomplete: discard/withhold the entire production frame and service
 * the feedback bitset. Never turn a miss into AIR, sky, or an early ray exit.
 * Out-of-world raw queries also mark incomplete (no request bit): callers own
 * the genuine world exterior policy. Field/probe filters extend world edges.
 * Feedback must be cleared before the query dispatch, and read after its
 * completion. Bit i requests canonical global brick i; it is NOT a page ID.
 */
export function worldAccessWGSL(layout = {}) {
  worldReaderLayouts(layout.limits);
  const integrated = layout.backend === 'world';
  const opticalWriter = layout.opticalWriter === true;
  const field = integrated ? ['tFS', 'tFM', 'tFT'] : ['worldField0', 'worldField1', 'worldField2'];
  const gi = integrated ? ['tGI0', 'tGI1', 'tGI2', 'tGI3'] : ['worldGI0', 'worldGI1', 'worldGI2', 'worldGI3'];
  const glow = integrated ? 'tLight' : 'worldGlow';
  return /* wgsl */ `
const WORLD_ABI: u32 = ${WORLD_ATLAS_ABI}u;
const WORLD_RAW: u32 = ${READY.RAW}u;
const WORLD_FIELD: u32 = ${READY.FIELD}u;
const WORLD_AUX: u32 = ${READY.AUX}u;
const WORLD_GI_SOURCE: u32 = ${READY.GI_SOURCE}u;
const WORLD_GI: u32 = ${READY.GI}u;
const WORLD_GLOW: u32 = ${READY.GLOW}u;
struct WorldParams {
  world: vec4u, // size xyz, epoch
  bricks: vec4u, // brick dimensions xyz, generation
  tiles: vec4u, // cells tiles x/y, page capacity, ABI
  aux: vec4u, // width/height/layers, records per page
  probes: vec4u, // width/height/layers, reserved
  light: vec4u, // descriptor base/count/stride, dependency manifest version
  feedback: vec4u, // words per channel plane, status word, sun suffix, reserved
}
@group(0) @binding(${integrated ? 3 : 0}) var<uniform> WA: WorldParams;
@group(0) @binding(${integrated ? 4 : 1}) var<storage, read> worldBook: array<u32>;
${opticalWriter ? '' : `@group(0) @binding(${integrated ? 5 : 2}) var<storage, read> worldLightBook: array<u32>;`}
@group(1) @binding(0) var worldStateA: texture_2d_array<u32>;
@group(1) @binding(1) var worldStateB: texture_2d_array<u32>;
@group(1) @binding(2) var ${field[0]}: texture_2d_array<f32>;
@group(1) @binding(3) var ${field[1]}: texture_2d_array<f32>;
@group(1) @binding(4) var ${field[2]}: texture_2d_array<f32>;
@group(1) @binding(5) var worldAux: texture_2d_array<u32>;
${opticalWriter ? '' : `@group(2) @binding(0) var ${gi[0]}: texture_2d_array<f32>;
@group(2) @binding(1) var ${gi[1]}: texture_2d_array<f32>;
@group(2) @binding(2) var ${gi[2]}: texture_2d_array<f32>;
@group(2) @binding(3) var ${gi[3]}: texture_2d_array<f32>;
@group(2) @binding(4) var ${glow}: texture_2d_array<f32>;
@group(2) @binding(5) var worldSunDepth: texture_2d_array<f32>;
@group(2) @binding(6) var worldSunOptical: texture_2d_array<f32>;
@group(2) @binding(7) var ${integrated ? 'tMediaNoise' : 'worldMediaNoise'}: texture_3d<f32>;
@group(2) @binding(8) var worldSourceAppearance: texture_3d<u32>;
@group(2) @binding(9) var worldPackedMesh: texture_2d<u32>;`}
@group(3) @binding(${integrated ? 1 : 0}) var<storage, read_write> worldRequests: array<atomic<u32>>;
var<private> worldIncomplete: bool;
fn worldBeginQuery() { worldIncomplete = false; }
fn worldQueryIncomplete() -> bool { return worldIncomplete; }
fn worldInBounds(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < vec3i(WA.world.xyz)); }
fn worldBrickInBounds(b: vec3i) -> bool { return all(b >= vec3i(0)) && all(b < vec3i(WA.bricks.xyz)); }
fn worldBookIndex(b: vec3i) -> u32 { return u32(b.x) + WA.bricks.x * (u32(b.y) + WA.bricks.y * u32(b.z)); }
fn worldRequest(index: u32, channels: u32) {
  worldIncomplete = true;
  for (var plane = 0u; plane < 6u; plane++) {
    if ((channels & (1u << plane)) != 0u) {
      atomicOr(&worldRequests[plane * WA.feedback.x + (index >> 5u)], 1u << (index & 31u));
    }
  }
}
fn worldLinearAddress(i: u32, dims: vec2u) -> vec3i {
  return vec3i(vec3u(i % dims.x, (i / dims.x) % dims.y, i / (dims.x * dims.y)));
}
fn worldAuxAddress(pid: u32, record: u32) -> vec3i {
  return worldLinearAddress(pid * ${AUX_RECORDS}u + record, WA.aux.xy);
}
fn worldPageMeta(pid: u32, record: u32) -> vec4u {
  let a = worldAuxAddress(pid, record);
  return textureLoad(worldAux, a.xy, a.z, 0);
}
// -1 is UNKNOWN; a physical ID of zero is valid (book entry=1).
fn worldPage(b: vec3i, ready: u32) -> i32 {
  if (!worldBrickInBounds(b)) { worldIncomplete = true; return -1; }
  let i = worldBookIndex(b);
  let e = worldBook[i];
  if (e == 0u || e > WA.tiles.z || WA.tiles.w != WORLD_ABI) { worldRequest(i, ready); return -1; }
  let pid = e - 1u;
  let m = worldPageMeta(pid, 0u);
  if (m.y != WA.world.w) { worldRequest(i, ready); return -1; }
  if ((m.x & ready) != ready) { worldRequest(i, ready & ~m.x); return -1; }
  return i32(pid);
}
fn worldCellTexel(pid: u32, c: vec3i) -> vec3i {
  let l = c & vec3i(3);
  let s = u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
  return vec3i(vec3u((pid % WA.tiles.x) * 8u + (s & 7u), ((pid / WA.tiles.x) % WA.tiles.y) * 8u + (s >> 3u), pid / (WA.tiles.x * WA.tiles.y)));
}
fn worldFetchState(t: texture_2d_array<u32>, c: vec3i) -> vec4f {
  if (!worldInBounds(c)) { worldIncomplete = true; return vec4f(0.0); }
  let pid = worldPage(c >> vec3u(2u), WORLD_RAW);
  if (pid < 0) { return vec4f(0.0); }
  let a = worldCellTexel(u32(pid), c);
  return bitcast<vec4f>(textureLoad(t, a.xy, a.z, 0));
}
fn worldFetchA(c: vec3i) -> vec4f { return worldFetchState(worldStateA, c); }
fn worldFetchB(c: vec3i) -> vec4f { return worldFetchState(worldStateB, c); }
fn worldCellAux(c: vec3i, record: u32) -> vec4u {
  if (!worldInBounds(c)) { worldIncomplete = true; return vec4u(0u); }
  let pid = worldPage(c >> vec3u(2u), WORLD_AUX);
  if (pid < 0) { return vec4u(0u); }
  let l = c & vec3i(3);
  let s = u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
  return worldPageMeta(u32(pid), 4u + s * 2u + record);
}
fn worldFlow(c: vec3i) -> vec3f {
  let r = worldCellAux(c, 0u);
  return vec3f(unpack2x16float(r.x), unpack2x16float(r.y).x);
}
fn worldAeration(c: vec3i) -> vec4f {
  let r = worldCellAux(c, 0u);
  return vec4f(unpack2x16float(r.z), unpack2x16float(r.w));
}
fn worldDeco(c: vec3i) -> u32 { return worldCellAux(c, 1u).x; }
struct WorldBrickInfo { emit: vec3f, info: u32 }
fn worldBrickInfo(b: vec3i) -> WorldBrickInfo {
  let pid = worldPage(b, ${integrated ? 'WORLD_RAW | WORLD_FIELD | WORLD_AUX' : 'WORLD_AUX'});
  if (pid < 0) { return WorldBrickInfo(vec3f(0.0), 0u); }
  let m = worldPageMeta(u32(pid), 1u);
  return WorldBrickInfo(bitcast<vec3f>(m.xyz), m.w);
}
fn worldBrickOccupancy(b: vec3i) -> vec2u {
  let pid = worldPage(b, WORLD_AUX);
  if (pid < 0) { return vec2u(0u); }
  return worldPageMeta(u32(pid), 2u).xy;
}
// Same distance+1 encoding as local brickDist: zero decodes to -1, NOT empty.
fn worldBrickDistance(b: vec3i) -> i32 {
  let pid = worldPage(b, WORLD_AUX);
  if (pid < 0) { return -1; }
  return i32(worldPageMeta(u32(pid), 2u).z) - 1;
}
fn worldFieldLoad(t: texture_2d_array<f32>, cell: vec3i) -> vec4f {
  let c = clamp(cell, vec3i(0), vec3i(WA.world.xyz) - 1);
  let pid = worldPage(c >> vec3u(2u), WORLD_FIELD);
  if (pid < 0) { return vec4f(0.0); }
  let a = worldCellTexel(u32(pid), c);
  return textureLoad(t, a.xy, a.z, 0);
}
fn worldFieldLinear(t: texture_2d_array<f32>, p: vec3f) -> vec4f {
  let q = clamp(p - 0.5, vec3f(0.0), vec3f(WA.world.xyz) - 1.0);
  let base = vec3i(floor(q)); let f = fract(q);
  var value = vec4f(0.0);
  for (var z = 0; z < 2; z++) { for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let w = select(1.0-f, f, vec3i(x,y,z) == vec3i(1));
    value += worldFieldLoad(t, base + vec3i(x,y,z)) * w.x * w.y * w.z;
  } } }
  return value;
}
fn worldBSpline(t: f32) -> vec4f {
  let t2 = t*t; let t3 = t2*t;
  return vec4f(1.0-3.0*t+3.0*t2-t3, 4.0-6.0*t2+3.0*t3, 1.0+3.0*t+3.0*t2-3.0*t3, t3) / 6.0;
}
// Reference 64-control-point B-spline. No hardware blend between unrelated
// atlas tiles; equivalent to local Sigg folding, including WORLD edge clamp.
fn worldFieldCubic(t: texture_2d_array<f32>, p: vec3f) -> vec4f {
  let q = clamp(p - 0.5, vec3f(0.0), vec3f(WA.world.xyz) - 1.0);
  let base = vec3i(floor(q)); let f = fract(q);
  let wx = worldBSpline(f.x); let wy = worldBSpline(f.y); let wz = worldBSpline(f.z);
  var value = vec4f(0.0);
  for (var z = 0; z < 4; z++) { for (var y = 0; y < 4; y++) { for (var x = 0; x < 4; x++) {
    value += worldFieldLoad(t, base + vec3i(x,y,z) - 1) * wx[x] * wy[y] * wz[z];
  } } }
  return value;
}
${opticalWriter ? '' : `// LIGHT book IDs never pass through worldPage/cell auxiliary metadata.
fn worldLightMeta(id: u32, record: u32) -> vec4u {
  let a = worldLinearAddress(WA.light.x + id * ${LIGHT_RECORDS}u + record, WA.aux.xy);
  return textureLoad(worldAux, a.xy, a.z, 0);
}
fn worldLightDescriptor(b: vec3i, ready: u32) -> i32 {
  if (!worldBrickInBounds(b)) { worldIncomplete = true; return -1; }
  let i = worldBookIndex(b); let e = worldLightBook[i];
  if (e == 0u || e > WA.light.y || WA.tiles.w != WORLD_ABI) { worldRequest(i, ready); return -1; }
  let id = e - 1u; let m = worldLightMeta(id, 0u);
  let publication = worldLightMeta(id, 3u);
  if (m.y != WA.world.w || publication.z != WORLD_ABI || publication.w == 0u || publication.w > WA.bricks.w) { worldRequest(i, ready); return -1; }
  if ((m.x & ready) != ready) { worldRequest(i, ready & ~m.x); return -1; }
  return i32(id);
}
// Exact giSrcPack words. Missing zero is only a placeholder, NEVER canonical air.
fn worldGISource(b: vec3i) -> vec4u {
  let id = worldLightDescriptor(b, WORLD_GI_SOURCE);
  if (id < 0) { return vec4u(0u); }
  return worldLightMeta(u32(id), 4u);
}
fn worldProbeLoad(t: texture_2d_array<f32>, brick: vec3i, ready: u32) -> vec4f {
  let b = clamp(brick, vec3i(0), vec3i(WA.bricks.xyz) - 1);
  let id = worldLightDescriptor(b, ready);
  if (id < 0) { return vec4f(0.0); }
  let refs = worldLightMeta(u32(id), 1u);
  let e = select(refs.x, refs.y, ready == WORLD_GLOW);
  if (e == 0u || e > WA.probes.w) { worldRequest(worldBookIndex(b), ready); return vec4f(0.0); }
  let a = worldLinearAddress(e - 1u, WA.probes.xy);
  return textureLoad(t, a.xy, a.z, 0);
}
// Global SH/glow phase: probes at (4*b + 2), NEVER chunk-local or page-local.
fn worldProbeTex(t: texture_2d_array<f32>, p: vec3f, ready: u32) -> vec4f {
  let q = clamp(p/4.0 - 0.5, vec3f(0.0), vec3f(WA.bricks.xyz) - 1.0);
  let base = vec3i(floor(q)); let f = fract(q);
  var value = vec4f(0.0);
  for (var z = 0; z < 2; z++) { for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let w = select(1.0-f, f, vec3i(x,y,z) == vec3i(1));
    value += worldProbeLoad(t, base + vec3i(x,y,z), ready) * w.x * w.y * w.z;
  } } }
  return value;
}
struct WorldProbe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
fn worldProbe(p: vec3f) -> WorldProbe {
  return WorldProbe(worldProbeTex(${gi[0]},p,WORLD_GI), worldProbeTex(${gi[1]},p,WORLD_GI), worldProbeTex(${gi[2]},p,WORLD_GI), worldProbeTex(${gi[3]},p,WORLD_GI));
}
fn worldLight(p: vec3f) -> vec3f { return worldProbeTex(${glow},p,WORLD_GLOW).rgb; }
struct WorldMesh { color: vec4f, depth: f32, coverageFlags: u32 }
fn worldMeshAt(pixel: vec2i) -> WorldMesh {
  let m = textureLoad(worldPackedMesh, pixel, 0);
  return WorldMesh(vec4f(unpack2x16float(m.x),unpack2x16float(m.y)), bitcast<f32>(m.z), m.w);
}`}
`;
}

/** Separate compute pipelines: only storage outputs, never same-resource
 * sampled + storage-written. Inputs use original slot order. raw inputs are
 * vec4u; final-field/GI inputs are floats, converted to rgba16float on store.
 * Output views come ONLY from an unpublished job via writerBindings().
 */
export function worldPageWriterWGSL(kind) {
  worldWriterLayouts(kind);
  const names = kind === 'source' ? ['aux'] : WRITER_CHANNELS[kind];
  if (!names) throw new Error('not a page writer');
  const declarations = names.map((name, i) => {
    const [format] = PAGE_CHANNELS[name], type = format === 'rgba32uint' ? 'u32' : 'f32';
    return `@group(0) @binding(${i+1}) var<storage, read> src${i}: array<vec4<${type}>>;
@group(1) @binding(${i}) var out${i}: texture_storage_2d_array<${format}, write>;`;
  }).join('\n');
  const stores = names.map((name, i) => {
    const shape = PAGE_CHANNELS[name][1];
    if (kind === 'source') return `if (s == 0u) { let a = writerLinear(WP.reserved.x, WP.aux.xy); textureStore(out${i}, a.xy, a.z, src${i}[0]); }`;
    if (shape === 'aux') return `if (s < ${AUX_RECORDS}u) { let a = writerLinear(WP.page.x * ${AUX_RECORDS}u + s, WP.aux.xy); textureStore(out${i}, a.xy, a.z, src${i}[s]); }`;
    if (shape === 'cells') return `if (s < 64u) { textureStore(out${i}, cell.xy, cell.z, src${i}[s]); }`;
    return `if (s == 0u) { let a = writerLinear(WP.page.x, WP.probes.xy); textureStore(out${i}, a.xy, a.z, src${i}[0]); }`;
  }).join('\n');
  return /* wgsl */ `
struct WriterParams { page: vec4u, aux: vec4u, probes: vec4u, reserved: vec4u }
@group(0) @binding(0) var<uniform> WP: WriterParams;
${declarations}
fn writerLinear(i: u32, dims: vec2u) -> vec3i { return vec3i(vec3u(i%dims.x, (i/dims.x)%dims.y, i/(dims.x*dims.y))); }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let s = gid.x;
  let cell = vec3i(vec3u((WP.page.x%WP.page.y)*8u+(s&7u), ((WP.page.x/WP.page.y)%WP.page.z)*8u+(s>>3u), WP.page.x/(WP.page.y*WP.page.z)));
  ${stores}
}`;
}
// RGB/alpha already rounded to RGBA16Float at the old render target. A
// load/unpack/pack round-trip preserves finite half values including HDR.
// For ALL half bit patterns (NaN payloads included), use packMeshWords on
// CPU/raw-copy data; floating-point texture loads cannot retain NaN payloads.
// depth remains f32; .w bit0 is coverage supplied by caller's depth convention.
export function worldPackedMeshWriterWGSL() {
  worldWriterLayouts('mesh');
  return /* wgsl */ `
@group(0) @binding(0) var meshColor: texture_2d<f32>;
@group(0) @binding(1) var meshDepth: texture_depth_2d;
@group(0) @binding(2) var packedMesh: texture_storage_2d<rgba32uint, write>;
fn packWorldMeshWords(colorHalfWords: vec2u, depthBits: u32, flags: u32) -> vec4u {
  return vec4u(colorHalfWords, depthBits, flags);
}
fn packWorldMesh(color: vec4f, depth: f32, flags: u32) -> vec4u {
  return packWorldMeshWords(vec2u(pack2x16float(color.xy), pack2x16float(color.zw)), bitcast<u32>(depth), flags);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(packedMesh);
  if (any(gid.xy >= size)) { return; }
  let p = vec2i(gid.xy); let d = textureLoad(meshDepth,p,0);
  textureStore(packedMesh,p,packWorldMesh(textureLoad(meshColor,p,0),d,select(0u,1u,d < 1.0)));
}`;
}
// Optical shadow allocation/tracing is a later backend. This writer is the
// exact two-r32float copy contract, with no reader bindings/feedback aliasing.
export function worldShadowWriterWGSL() {
  worldWriterLayouts('shadow');
  return /* wgsl */ `
@group(0) @binding(0) var depthOut: texture_storage_2d_array<r32float, write>;
@group(0) @binding(1) var opticalOut: texture_storage_2d_array<r32float, write>;
fn worldStoreShadow(pixel: vec2i, layer: i32, depth: f32, optical: f32) {
  textureStore(depthOut,pixel,layer,vec4f(depth,0.0,0.0,0.0));
  textureStore(opticalOut,pixel,layer,vec4f(optical,0.0,0.0,0.0));
}`;
}

// Existing CPU sampler-budget discovery validates these REAL ABI layouts.
// These assemblages are check-only, not an application render path.
export const WGSL_CHECK = [
  { name: 'worldAtlasReaderABI', kind: 'compute', grids: false,
    code: () => worldAccessWGSL() + `\n@compute @workgroup_size(1) fn main() { worldBeginQuery(); let a = worldFetchA(vec3i(0)); }`,
    layouts: () => worldReaderLayouts(), dispatch: () => [1, 1, 1] },
  ...[...Object.keys(WRITER_CHANNELS), 'source'].map(kind => ({ name: `worldAtlasWriter_${kind}`, kind: 'compute', grids: false,
    code: () => worldPageWriterWGSL(kind), layouts: () => [...worldWriterLayouts(kind), [], []],
    dispatch: () => [kind === 'raw' ? 3 : 1, 1, 1] })),
  { name: 'worldAtlasPackedMesh', kind: 'compute', grids: false, code: () => worldPackedMeshWriterWGSL(),
    layouts: () => [...worldWriterLayouts('mesh'), [], [], []], dispatch: () => [1, 1, 1] },
  { name: 'worldAtlasShadowABI', kind: 'compute', grids: false,
    code: () => worldShadowWriterWGSL() + `\n@compute @workgroup_size(1) fn main() { worldStoreShadow(vec2i(0), 0, 1.0, 0.0); }`,
    layouts: () => [...worldWriterLayouts('shadow'), [], [], []], dispatch: () => [1, 1, 1] },
];
