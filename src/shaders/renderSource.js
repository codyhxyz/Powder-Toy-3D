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

// Physics V2's air and motion in the B lane the World's source copies, for the
// drawn projection (world/renderSource.js, the V2 air export): B as V1 keeps it
// (a grain's or a liquid's own velocity, else the air's; pressure: the
// Pressure/Flow views, the hover readout, smoke following the flow), from the
// physical reader's air (format 3: shaders/common.js fetchBs) and the core
// (shaders/v2/viewRead.js nativeMotionB), so these are the values the Box's
// views read from V2's own buffers (shaders/render.js volumeB). (V2's foam
// reaches the source by v2/nativeAeration.js.)
export const NATIVE_AIR_LAYOUT = [storage(0, true)];
export const nativeAirWGSL = (g) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RO, fixedReadFormat: 3 })}
${nativeMotionWGSL}
@group(2) @binding(0) var<storage, read_write> airB: array<vec4f>;
${thread}
  airB[s] = nativeMotionB(fetchNativeCoreS(s), fetchBs(s));
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
  { name: 'world native air', kind: 'compute', grids: ['128'], warm: false, code: nativeAirWGSL,
    layouts: () => [LAYOUT.TABLES, stateLayout(STATE_OPTS.STATE_RO), NATIVE_AIR_LAYOUT], dispatch: (g) => fold(Math.ceil(g.slots / 64)) },
]);
