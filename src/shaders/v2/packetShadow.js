// V2's flying matter in the sun's shadow map (Box): V1's flying cells are grid cells, so the shadow kernel
// (shaders/render.js shadowFrag) traces them and they cast the sun's shadow; V2's fly in the dynamics pool.
// Each frame, before the map's tiles are listed (src/derived.js shadowTiles), a splat over the pool writes
// each opaque packet's nearest depth along the sun into the texels its equal-volume sphere covers (the
// packet shadow buffer, atomicMin) and marks their tiles to be traced. The V2 shadow kernel is V1's, the same
// trace a texel, and folds that depth in: a packet in front of a texel's first opaque surface is that
// surface, as the flying cell would be, then the word is cleared and its tile marked to be traced again the
// next frame (so the packet's shadow leaves with it). Not a deviation: V1's map, another owner of the caster.
// A translucent packet (a liquid's droplet) casts none: V1's flying water cell tints the map by its optical
// depth, e^-0.05 a cell, which no shadow shows (an oil droplet's tint is the one left out).
import { ELEMENTS, K, R } from '../../elements.js';
import { shadowFrag, shadowRes, shadowDispatch, SHADOW_WORKGROUP } from '../render.js';
import { frameBindings, RENDER_LAYOUT } from '../bindings.js';
import { LAYOUT } from '../common.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../../gpu/kernels.js';
import { shadowTileWords, SHADOW_TILE, SHADOW_TILES_MAX } from '../passes.js';
import { SHADOW_PAD } from '../gfx/lighting.js';

// The buffer: a word a texel (res² of them: the nearest packet's depth, as f32 bits, or PACKET_SHADOW_EMPTY),
// then a bit a tile of the map (SHADOW_TILES_MAX), the tiles the last fold touched.
export const PACKET_SHADOW_EMPTY = 0xffffffff;
export const PACKET_RETRACE_WORDS = SHADOW_TILES_MAX / 32;
export const packetShadowWords = res => res * res + PACKET_RETRACE_WORDS;
// The splat's reach a packet: its sphere's texels, at most this many a side (a packet's radius is at most
// (3/4π)^(1/3) of a cell, 0.62, and a texel is 2R/res: at 32³ and up the footprint is under 4 a side)
const SPLAT_SIDE = 6;
const opaqueIds = ELEMENTS.filter(e => e.id > 0 && e.kind !== K.GAS && e.render === R.OPAQUE).map(e => e.id);
const castWGSL = `fn packetCasts(id: u32) -> bool { switch id { case ${opaqueIds.map(i => `${i}u`).join(', ')}: { return true; } default: { return false; } } }`;

/** The V2 shadow kernel: V1's (shaders/render.js shadowFrag), its texel's trace folded with the packets'. */
export function packetShadowFrag(g, res) {
  const v1 = shadowFrag(g);
  const store = /\n  let oC = shadowTexel\(ro, safeDir\(-FU\.sun\)\);\n  textureStore\(tShadow, id\.xy, oC\);\n/;
  if (!store.test(v1)) throw new Error('packetShadow: shaders/render.js shadowFrag no longer stores its texel as the fold expects');
  return v1.replace(store, `
  let oC = packetShadowFold(id.xy, res, shadowTexel(ro, safeDir(-FU.sun)));
  textureStore(tShadow, id.xy, oC);
`) + /* wgsl */ `
@group(2) @binding(20) var<storage, read_write> packetShadow: array<atomic<u32>>;
const PS_EMPTY: u32 = ${PACKET_SHADOW_EMPTY}u;
const PS_RETRACE: u32 = ${res * res}u;
// the texel's trace sm with the packets in front of it: a packet nearer the sun than its first opaque surface is
// its first opaque surface (V1's flying cell, traced); the word cleared, its tile traced again next frame
fn packetShadowFold(id: vec2u, res: u32, sm: vec4f) -> vec4f {
  var o = sm;
  if (res * res > PS_RETRACE) { return o; }
  let front = atomicExchange(&packetShadow[id.y * res + id.x], PS_EMPTY);
  if (front != PS_EMPTY) {
    o.x = min(o.x, bitcast<f32>(front));
    let tile = (id.y / SH_TILE) * (res / SH_TILE) + id.x / SH_TILE;
    atomicOr(&packetShadow[PS_RETRACE + (tile >> 5u)], 1u << (tile & 31u));
  }
  return o;
}`;
}

export const PacketShadowParams = uniformStruct('PacketShadowParams', { origin: 'vec3f', capacity: 'u32', grid: 'vec4u', res: 'u32' });
const rw = binding => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } });
// particles (read), the packet shadow buffer, brickDist's buffer (the shadow tiles' bits: shaders/passes.js shadowTileWords)
export const PACKET_SPLAT_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }, rw(1), rw(2)];

/** The splat (a thread a pool slot): last frame's folded tiles to trace again, each opaque packet's depths. */
export function packetShadowSplatWGSL(g, res) {
  const w = shadowTileWords(g);
  return /* wgsl */ `
${frameBindings()}
${PacketShadowParams.wgsl}
@group(3) @binding(1) var<uniform> P: PacketShadowParams;
struct Particle { positionId: vec4u, velocityCore: vec4u, payloadBank: vec4u }
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<storage, read_write> packetShadow: array<atomic<u32>>;
@group(1) @binding(2) var<storage, read_write> sh: array<atomic<u32>>;
const PS_RETRACE: u32 = ${res * res}u;
const SH_BITS: u32 = ${w.bits}u;
const SH_TILE: u32 = ${SHADOW_TILE}u;
const SH_PAD: f32 = ${SHADOW_PAD.toFixed(1)};   // shaders/gfx/lighting.js SHADOW_PAD
const SPLAT_SIDE: i32 = ${SPLAT_SIDE};
const LIQUID: u32 = ${K.LIQUID}u;
const LIQUIDS = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => e.kind === K.LIQUID ? '1u' : '0u').join(',')});
${castWGSL}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = (wg.x + wg.y * nwg.x) * 64u + li;
  let res = P.res;
  let side = res / SH_TILE;
  // the tiles the last fold touched: traced again, so a packet's shadow goes where it went
  if (t < (side * side + 31u) / 32u) {
    let r = atomicExchange(&packetShadow[PS_RETRACE + t], 0u);
    if (r != 0u) { atomicOr(&sh[SH_BITS + t], r); }
  }
  if (t >= P.capacity) { return; }
  let p = particles[t]; let id = p.velocityCore.w & 255u;
  if (p.positionId.w == 0u || id == 0u || id >= ${ELEMENTS.length}u || !packetCasts(id)) { return; }
  var amount = 1.0;
  if (LIQUIDS[id] != 0u) { amount = f32(p.payloadBank.x & 0xffffffu) / 65536.0; }
  if (amount <= 0.0) { return; }
  // its equal-volume sphere, as drawn (shaders/v2/particleRender.js)
  let r = pow(amount * (3.0 / (4.0 * 3.141592653589793)), 1.0 / 3.0);
  let q0 = bitcast<vec3f>(p.positionId.xyz) - P.origin;
  if (any(q0 < vec3f(-1.0)) || any(q0 > vec3f(P.grid.xyz) + 1.0)) { return; }
  // the map's frame (shaders/gfx/lighting.js sunBasis, the window's origin snapped to whole texels)
  let grid = vec3f(P.grid.xyz);
  var c = grid * 0.5;
  let R = 0.5 * length(grid) + SH_PAD;
  let u = normalize(cross(vec3f(0.0, 1.0, 0.0), FU.sun));
  let v = cross(FU.sun, u);
  let T = 2.0 * R / f32(max(res, 1u));
  let ot = vec2f(dot(P.origin, u), dot(P.origin, v)) / T;
  let snap = (round(ot) - ot) * T;
  c += snap.x * u + snap.y * v;
  let q = q0 - c;
  let at = vec2f(dot(q, u), dot(q, v));   // across the sun, cells from the map's centre
  let d = R - dot(q, FU.sun);             // depth of its centre along the sun (lighting.js shadowProject)
  // texel i's ray crosses the disc at ((i + 0.5) / res * 2 - 1) * R (shadowFrag)
  let f = (at / R * 0.5 + 0.5) * f32(res) - 0.5;
  let rt = r / T;
  let lo = vec2i(floor(f - rt)); let n = min(vec2i(ceil(f + rt)) - lo + 1, vec2i(SPLAT_SIDE));
  for (var k = 0; k < SPLAT_SIDE * SPLAT_SIDE; k++) {
    let o = vec2i(k % SPLAT_SIDE, k / SPLAT_SIDE);
    if (any(o >= n)) { continue; }
    let x = lo + o;
    if (any(x < vec2i(0)) || any(x >= vec2i(i32(res)))) { continue; }
    let ray = ((vec2f(x) + 0.5) / f32(res) * 2.0 - 1.0) * R;
    let rho = ray - at;
    let h2 = r * r - dot(rho, rho);
    if (h2 <= 0.0) { continue; }
    atomicMin(&packetShadow[u32(x.y) * res + u32(x.x)], bitcast<u32>(max(d - sqrt(h2), 0.0)));
    let tile = (u32(x.y) / SH_TILE) * side + u32(x.x) / SH_TILE;
    atomicOr(&sh[SH_BITS + (tile >> 5u)], 1u << (tile & 31u));
  }
}`;
}

// (naga and the GPU checks: built only under V2, never warmed with the views)
export const WGSL_CHECK = [
  { name: 'shadowPackets', kind: 'compute', warm: false, code: (g) => packetShadowFrag(g, shadowRes(g)),
    layouts: () => [RENDER_LAYOUT.FRAME, LAYOUT.STATE_RO, RENDER_LAYOUT.LIGHTING_SHADOW_PACKETS], layoutNames: ['FRAME', 'STATE_RO', 'LIGHTING_SHADOW_PACKETS'],
    workgroupSize: [SHADOW_WORKGROUP, SHADOW_WORKGROUP, 1], dispatch: (g) => shadowDispatch(shadowRes(g)) },
  { name: 'packetShadowSplat', kind: 'compute', warm: false, code: (g) => packetShadowSplatWGSL(g, shadowRes(g)), params: PacketShadowParams,
    layouts: () => [RENDER_LAYOUT.FRAME, PACKET_SPLAT_LAYOUT], layoutNames: ['FRAME'], workgroupSize: [64, 1, 1], dispatch: () => [1, 1, 1] },
];
