// Phase 1: raw source construction, not field derivation or a volume renderer.
import { nativeMotionWGSL } from './v2/viewRead.js';
import { prelude, LAYOUT, STATE_OPTS, stateLayout } from './common.js';
import { stampLib } from './stamp.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';
import { sceneLayout } from '../world/scenes/sceneGpu.js';
import { WORLD_SCENES } from '../world/scenes/index.js';

const storage = (binding, write = false) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: write ? 'storage' : 'read-only-storage' } });
export const RAW_LAYOUT = [storage(0, true), storage(1, true), storage(2, true), storage(3), storage(4)];
export const RAW_READ_LAYOUT = [storage(0), storage(1), storage(2)];
export const APPLY_STATE = { state: 'read_write', marks: true };
export const RawParams = uniformStruct('RawParams', {
  at: 'vec3i', foot: 'i32', size: 'vec3i', seed: 'u32', base: 'u32',
});
export const RawApplyParams = uniformStruct('RawApplyParams', {
  sourceOrigin: 'vec3i', copy: 'u32', lo: 'vec3i', hi: 'vec3i',
});
const rawDecls = /* wgsl */ `
@group(1) @binding(0) var<storage, read_write> rawA: array<vec4u>;
@group(1) @binding(1) var<storage, read_write> rawB: array<vec4u>;
@group(1) @binding(2) var<storage, read_write> touched: array<u32>;
@group(1) @binding(3) var<storage, read> columns: array<u32>;
@group(1) @binding(4) var<storage, read> shapes: array<vec4f>;
fn fetchA(p: vec3i) -> vec4f { return bitcast<vec4f>(rawA[H.src * SLOTS + slotOf(p)]); }
${RawParams.wgsl}
@group(3) @binding(1) var<uniform> P: RawParams;
`;
const thread = /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let p = cellOf(s);
`;
export const rawGenerateWGSL = (g, scene) => /* wgsl */ `
${prelude(g, { state: false })}
${scene.glsl(g)}
${rawDecls}
${thread}
  let c = sceneCell(H.origin + p);
  rawA[s] = bitcast<vec4u>(c.A);
  rawB[s] = bitcast<vec4u>(c.B);
  touched[s] = 0u;
}`;
// Footing only reads its own x/z column. The raw domain spans the entire
// world height; the x/z halo contains every support probe for its owned core.
// Outside the scratch domain is never consulted by a published core footing.
export const rawStampWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${rawDecls}
${stampLib({ support: 'inGrid(c) && !isFluid(eid(fetchA(c)))', floor: 'y + H.origin.y < 0' })}
${thread}
  let src = H.src * SLOTS + s;
  let dst = H.dst * SLOTS + s;
  var a = bitcast<vec4f>(rawA[src]);
  var b = bitcast<vec4f>(rawB[src]);
  let q = p - P.at;
  var wrote = false;
  if ((touched[s] & 0x80000000u) == 0u && columns[u32(p.x / BS + BX * (p.z / BS))] != 0u &&
      q.x >= 0 && q.z >= 0 && q.x < P.size.x && q.z < P.size.z && q.y < P.size.y && q.y >= -P.foot) {
    let v = shapes[P.base + u32(q.x + P.size.x * (max(q.y, 0) + P.size.y * q.z))];
    if (v.x >= 0.5 && (q.y >= 0 || (v.w >= 0.5 && footing(p, P.at.y, P.foot)))) {
      stampPut(p, v, b, &a, &b);
      touched[s] = 1u;
      wrote = true;
    }
  }
  // Untouched cells are copied as integer words, including NaN payloads.
  if (!wrote) {
    rawA[dst] = rawA[src]; rawB[dst] = rawB[src];
  } else {
    rawA[dst] = bitcast<vec4u>(a); rawB[dst] = bitcast<vec4u>(b);
  }
}`;
// Only actual stamp/footing writes in the requested fresh columns enter physics.
export const rawApplyWGSL = (g, rawGrid) => /* wgsl */ `
${prelude(g, APPLY_STATE)}
@group(2) @binding(0) var<storage, read> rawA: array<vec4u>;
@group(2) @binding(1) var<storage, read> rawB: array<vec4u>;
@group(2) @binding(2) var<storage, read> touched: array<u32>;
${RawApplyParams.wgsl}
@group(3) @binding(1) var<uniform> P: RawApplyParams;
${thread}
  if (any(p < P.lo) || any(p >= P.hi)) { return; }
  let q = p + H.origin - P.sourceOrigin;
  if (any(q < vec3i(0)) || any(q >= vec3i(${rawGrid.nx}, ${rawGrid.ny}, ${rawGrid.nz}))) { return; }
  // Same original supertile/tile slot layout, but the raw domain's dimensions.
  let rb = q / BS;
  let st = rb / SUPER_B;
  let k = rb - st * SUPER_B;
  let brick = (st.x + ${rawGrid.nx / 16} * (st.z + ${rawGrid.nz / 8} * st.y)) * 16 + k.x + 4 * (k.z + 2 * k.y);
  let l = q & vec3i(3);
  let rs = u32(brick * 64 + l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
  if ((touched[rs] & 1u) == 0u) { return; }
  let at = P.copy * ${rawGrid.slots}u + rs;
  let a = fetchA(p); let b = fetchB(p);
  if (writeCell(p, a, b, fetchF(p), bitcast<vec4f>(rawA[at]), bitcast<vec4f>(rawB[at]))) { markBrick(s >> 6u); }
}`;

// World's source of Physics V2's cells, read natively (world/renderSource.js nativePack): the
// window's cells packed straight into a World source target (a 32³ source core, or the tree
// producer's raw scratch) in the World's own render format, the A/B words its atlas, fields, pick
// and store read. Every value is the one Box's draw reads from V2's own buffers through the read
// group (Simulation.bindRO under V2: v2/physics.js readGroup, format 2, the cells and dynamics'
// current coarse air):
//   A  compactA of the core (the drawn projection: Box's format-2 fetchA, a partial liquid fill
//      dithered to whole cells), or compactProbeA (edit: one quantum of liquid is liquid, the edit
//      projection's, for the tree producer's support tests);
//   B  nativeMotionB of the core in its brick's air (shaders/v2/viewRead.js: Box's volumeB, the
//      Pressure and Flow views, the hover readout, smoke following the flow); zero in edit mode
//      (nothing reads it: the producer's B never reaches physics or a drawn cell);
//   aeration  V2's foam, fetchNativeAeration packed as V1's aeration record (vec2u of f16 pairs:
//      aeration, liquid, fall, grounded), so World's worldAeration → aerTap gives what Box's aerTap
//      gives, (age / 255, 1, 1) (the atlas's half floats round age / 255 to f16).
// It replaces what V2 exported to V1's state every tick for the World's copies (v2/physics.js
// exportLegacy, the v2bridge pass, then a copy of V1's A) and the two whole-window passes beside
// it (the air export into a window-sized B, the foam into a window-sized record): the same words,
// one pass, written where the World keeps them. Different code, same picture (CLAUDE.md "Same
// features in every world"): tools/v2/world-native-source-check.mjs pins the equivalence.
// A workgroup a brick of the box [lo, hi) (world cells); cell w is window cell w - H.origin, and
// target cell w - dstOrigin, in the target's supertile slot order (common.js cellSlot) with
// dstTiles supertiles along x and z, its copy at dstBase.
export const NATIVE_PACK_LAYOUT = [storage(0, true), storage(1, true), storage(2, true)];
export const NativePackParams = uniformStruct('NativePackParams', {
  lo: 'vec3i', edit: 'u32', hi: 'vec3i', air: 'u32', dstOrigin: 'vec3i', dstBase: 'u32', dstTiles: 'vec2u', aer: 'u32',
});
/** The target slot of target-local cell (x, y, z) in a grid of tiles = [nx / 16, nz / 8] supertiles
 * (common.js cellSlot's order): the kernel's packDstSlot, as JS (tools/v2/world-native-source-check.mjs). */
export function nativePackSlot(tiles, x, y, z) {
  const bx = x >> 2, by = y >> 2, bz = z >> 2, sx = bx >> 2, sy = by >> 1, sz = bz >> 1;
  const st = sx + tiles[0] * (sz + tiles[1] * sy), ly = y & 3;
  return ((st * 16 + (bx - sx * 4) + 4 * ((bz - sz * 2) + 2 * (by - sy * 2))) * 64 + (x & 3) + 4 * (ly & 1) + 8 * ((z & 3) + 4 * (ly >> 1))) >>> 0;
}
export const nativePackWGSL = (g) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RO, fixedReadFormat: 2 })}
${nativeMotionWGSL}
@group(2) @binding(0) var<storage, read_write> outA: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> outB: array<vec4u>;
@group(2) @binding(2) var<storage, read_write> outAer: array<vec2u>;
${NativePackParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativePackParams;
fn packDstSlot(q: vec3i) -> u32 {
  let b = q >> vec3u(2u);
  let st = b / SUPER_B;
  let k = b - st * SUPER_B;
  let l = q & vec3i(3);
  let t = st.x + i32(P.dstTiles.x) * (st.z + i32(P.dstTiles.y) * st.y);
  return u32((t * 16 + k.x + 4 * (k.z + 2 * k.y)) * 64 + l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let base = (P.lo >> vec3u(2u)) * BS;
  let nb = vec3u((P.hi - base + BS - 1) / BS);
  let k = foldId(wg, nwg);
  if (k >= nb.x * nb.y * nb.z) { return; }
  let b = vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y)));
  let w = base + b * BS + vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  if (any(w < P.lo) || any(w >= P.hi)) { return; }
  let p = w - H.origin;
  if (!inGrid(p)) { return; }
  let s = slotOf(p);
  let core = fetchNativeCoreS(s);
  let q = packDstSlot(w - P.dstOrigin);
  if (P.edit != 0u) {
    outA[P.dstBase + q] = bitcast<vec4u>(compactA(p, compactProbeCore(core)));
    outB[P.dstBase + q] = vec4u(0u);
    return;
  }
  outA[P.dstBase + q] = bitcast<vec4u>(compactA(p, core));
  outB[P.dstBase + q] = bitcast<vec4u>(select(vec4f(0.0), nativeMotionB(core, nativeAirB(s)), P.air != 0u));
  if (P.aer != 0u) {
    let a = fetchNativeAeration(p);
    outAer[q] = select(vec2u(0u), vec2u(pack2x16float(vec2f(a.x, a.y)), pack2x16float(vec2f(0.0, a.z))), a.y > 0.5);
  }
}`;

export const WGSL_CHECK = () => WORLD_SCENES.map((scene) => ({
  name: `${scene.key} raw source`, kind: 'compute', grids: ['128'], warm: false,
  code: (g) => rawGenerateWGSL(g, scene), layouts: () => [LAYOUT.TABLES, RAW_LAYOUT, sceneLayout({ data: !!scene.data })],
  params: RawParams, dispatch: (g) => fold(Math.ceil(g.slots / 64)),
})).concat([
  { name: 'raw source stamp', kind: 'compute', grids: ['128'], warm: false, code: rawStampWGSL,
    layouts: () => [LAYOUT.TABLES, RAW_LAYOUT], params: RawParams, dispatch: (g) => fold(Math.ceil(g.slots / 64)) },
  { name: 'raw source apply', kind: 'compute', grids: ['128'], warm: false, code: (g) => rawApplyWGSL(g, { ...g, nx: 64, nz: 64, slots: 64 * g.ny * 64 }),
    layouts: () => [LAYOUT.TABLES, stateLayout(APPLY_STATE), RAW_READ_LAYOUT], params: RawApplyParams, dispatch: (g) => fold(Math.ceil(g.slots / 64)) },
  { name: 'world native pack', kind: 'compute', grids: ['128'], warm: false, code: nativePackWGSL, params: NativePackParams,
    layouts: () => [LAYOUT.TABLES, stateLayout(STATE_OPTS.STATE_RO), NATIVE_PACK_LAYOUT], dispatch: (g) => fold(Math.ceil(g.slots / 64)) },
]);
