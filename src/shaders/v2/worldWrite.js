import { prelude, STAGE, LAYOUT } from '../common.js';
import { uniformStruct } from '../../gpu/params.js';
import { fold } from '../../gpu/kernels.js';
import { v2ActLayout, LEGACY_WORD } from '../v2.js';
import { nativeImportHelpersWGSL, importAWGSL } from './leave.js';
import { RawApplyParams, RAW_READ_LAYOUT } from '../renderSource.js';
import { sceneLayout } from '../../world/scenes/sceneGpu.js';
import { WORLD_SCENES } from '../../world/scenes/index.js';

// World's writers of Physics V2's cells: the generator's fill (world/gpu.js WorldGenerator.fill:
// a world's load, the slab a move uncovers) and the planted trees' apply (world/renderSourceProducer.js),
// straight into V2's cores while V2 runs the window. Each wrote V1's A/B as an edit and claimed its
// cells, which V2 then imported (shaders/v2.js v2import: importA of the cell's A, its bank 0); now the
// same importA (the import kernel's own text: shaders/v2/leave.js importAWGSL) of the same A, stored
// as the import stores it: a cell that changes takes the import's core and a zero bank, its brick's
// projection goes stale and its cells are noted, and a brick that took matter (not air over air) wakes,
// as the scatter of a restored brick notes its bricks (shaders/v2/window.js nativeScatterWGSL). V2's
// terrain is importA of the scene's cell (shaders/v2/leave.js), so the leaving slab's diff still finds
// a regenerated brick equal, bit for bit.
export const NATIVE_WRITE_LAYOUT = [0, 1, 2].map((binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }));
export const NativeFillParams = uniformStruct('NativeFillParams', { origin: 'vec3i', lo: 'vec3i', hi: 'vec3i' });

const head = (g, a = v2ActLayout(g)) => /* wgsl */ `
${prelude(g, { state: false })}
${nativeImportHelpersWGSL}
${importAWGSL(g)}
@group(1) @binding(0) var<storage, read_write> cores: array<vec4u>;
@group(1) @binding(1) var<storage, read_write> banks: array<i32>;
@group(1) @binding(2) var<storage, read_write> act: array<atomic<u32>>;
fn nativeWrite(s: u32, a: vec4f) {
  let n = importA(a);
  let c = cores[s];
  let bank = banks[s];
  if (all(n == c) && bank == 0) { return; }
  cores[s] = n;
  banks[s] = 0;
  let b = s / 64u;
  atomicStore(&act[${a.legacy}u + b], ${LEGACY_WORD.STALE}u);
  atomicStore(&act[${a.state}u + b], 1u);
  atomicStore(&act[${a.air}u + b], 1u);
  atomicStore(&act[${a.summary}u + b], 0u);
  if (cls(n.x & LEAVE_ID_MASK) != C_AIR || cls(c.x & LEAVE_ID_MASK) != C_AIR || bank != 0) {
    atomicStore(&act[${a.busy0}u + b], 1u);
    atomicStore(&act[${a.busy1}u + b], 1u);
  }
}
`;
const MAIN = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {`;

/** The fill: the scene's cell at each window cell of [lo, hi) (the grid at world cell origin). A workgroup a brick of the box. */
export const nativeFillWGSL = (g, sceneGLSL) => /* wgsl */ `
${head(g)}
${sceneGLSL}
${NativeFillParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeFillParams;
${MAIN}
  let base = (P.lo >> vec3u(2u)) * BS;
  let nb = vec3u((P.hi - base + BS - 1) / BS);
  let k = foldId(wg, nwg);
  if (k >= nb.x * nb.y * nb.z) { return; }
  let p = base + vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y))) * BS + vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  if (any(p < P.lo) || any(p >= P.hi) || !inGrid(p)) { return; }
  nativeWrite(slotOf(p), sceneCell(P.origin + p).A);
}`;
/** Workgroups of nativeFillWGSL for the box [lo, hi). */
export const nativeFillSize = (lo, hi) => {
  const base = lo.map((v) => Math.floor(v / 4) * 4);
  return fold(hi.reduce((n, v, i) => n * Math.ceil((v - base[i]) / 4), 1));
};

/** The planted trees' apply (shaders/renderSource.js rawApplyWGSL's cells: the stamps' touched cells of the raw scratch in [lo, hi)). */
export const nativeApplyWGSL = (g, rawGrid) => /* wgsl */ `
${head(g)}
@group(2) @binding(0) var<storage, read> rawA: array<vec4u>;
@group(2) @binding(1) var<storage, read> rawB: array<vec4u>;
@group(2) @binding(2) var<storage, read> touched: array<u32>;
${RawApplyParams.wgsl}
@group(3) @binding(1) var<uniform> P: RawApplyParams;
${MAIN}
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let p = cellOf(s);
  if (any(p < P.lo) || any(p >= P.hi)) { return; }
  let q = p + H.origin - P.sourceOrigin;
  if (any(q < vec3i(0)) || any(q >= vec3i(${rawGrid.nx}, ${rawGrid.ny}, ${rawGrid.nz}))) { return; }
  let rb = q / BS;
  let st = rb / SUPER_B;
  let k = rb - st * SUPER_B;
  let brick = (st.x + ${rawGrid.nx / 16} * (st.z + ${rawGrid.nz / 8} * st.y)) * 16 + k.x + 4 * (k.z + 2 * k.y);
  let l = q & vec3i(3);
  let rs = u32(brick * 64 + l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
  if ((touched[rs] & 1u) == 0u) { return; }
  nativeWrite(s, bitcast<vec4f>(rawA[P.copy * ${rawGrid.slots}u + rs]));
}`;

export const WGSL_CHECK = () => WORLD_SCENES.map((scene) => ({
  name: `${scene.key} native fill`, kind: 'compute', grids: ['128'], warm: false, tool: true,
  code: (g) => nativeFillWGSL(g, scene.glsl(g)), layouts: () => [LAYOUT.TABLES, NATIVE_WRITE_LAYOUT, sceneLayout({ data: !!scene.data })],
  params: NativeFillParams, dispatch: (g) => fold(g.nbricks),
})).concat([{ name: 'native tree apply', kind: 'compute', grids: ['128'], warm: false, tool: true,
  code: (g) => nativeApplyWGSL(g, { ...g, nx: 64, nz: 64, slots: 64 * g.ny * 64 }),
  layouts: () => [LAYOUT.TABLES, NATIVE_WRITE_LAYOUT, RAW_READ_LAYOUT], params: RawApplyParams, dispatch: (g) => fold(Math.ceil(g.slots / 64)) }]);
