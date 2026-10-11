import { prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, gridDims, atlasDims, stateLayout, EDIT_FIELDS, editKernelWGSL } from './common.js';
import { FIELD_REACH, FIELD_SCRATCH_REACH } from './fields.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// The simulation's own passes besides the step (docs/webgpu.md D6, D7, C2):
// the brush (an edit), fresh flags over the whole grid, the conversions
// between the brick-major slots and the CPU's atlas order, and the note of
// the quiet map for the derived passes. The derived passes' kernels (brick,
// blur, brickDist, age, dirty) are U4's (src/derived.js).

// Air flags (bits): air worth showing in the heat, pressure and flow views
// (the brick map's info word, shaders/bindings.js BRICK_INFO).
export const AIR_FLAGS = { HOT: 1, PRESSURE: 2, FLOW: 4 };
// WEBGPU-STUB (docs/webgpu.md J3): the brick map's float encoding is the
// BrickInfo record now (shaders/bindings.js).
export const brickGLSL = '';

// ---- the brush ----
// Spawns elements or applies tools inside a sphere or cube: an edit that reads
// only its own cell, in place (sim.paint; docs/webgpu.md D6, D7). Its own
// random stream: frame is sim.paints, not the step count (sim.js paint).
export const PaintParams = uniformStruct('PaintParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',
  radius: 'f32',
  shape: 'u32',     // 0 sphere, 1 cube
  tool: 'i32',      // element id, or negative tool id
  rate: 'f32',      // spawn density multiplier
  replace: 'u32',
  frame: 'u32',
});
// The update editMain calls (shaders/common.js): fn update(p, a, b, oA, oB).
export const paintUpdateWGSL = /* wgsl */ `
const PAINT_RNG_SALT: u32 = 0xb7u;    // salt that gives the brush its own random stream (seed3)
const BRUSH_EDGE_EPS: f32 = 0.001;    // keeps smoothstep's edges apart at radius 0
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.center;
  var r = max(abs(d.x), max(abs(d.y), abs(d.z)));
  if (P.shape == 0u) { r = length(d); }
  if (r > P.radius) { return; }
  let falloff = 1.0 - smoothstep(P.radius * TOOL_FALLOFF, P.radius + BRUSH_EDGE_EPS, r);

  var rs = seed3(p, P.frame, PAINT_RNG_SALT);
  let id = eid(a);
  let tool = P.tool;

  if (tool >= 0) {
    if (id == tool) { return; }
    if (id != E_EMPTY && P.replace == 0u) { return; }
    if (rnd(&rs) > SPAWNDENS(tool) * P.rate) { return; }
    let T = SPAWNT(tool);
    let ctype = select(0.0, f32(E_STONE), tool == E_LAVA);
    *oA = vec4f(f32(tool), T, SPAWNLIFE(tool), ctype + rnd(&rs) * SEED_MAX);
    let vy = select(0.0, SPAWN_DROP_V, KIND(tool) == K_POWDER || KIND(tool) == K_LIQUID);
    *oB = vec4f(0.0, vy, 0.0, b.w);
  } else if (tool == T_ERASE) {
    *oA = vec4f(f32(E_EMPTY), AMBIENT, 0.0, rnd(&rs) * SEED_MAX);
    *oB = vec4f(0.0, 0.0, 0.0, b.w);
  } else if (tool == T_HEAT) {
    (*oA).y = min(a.y + TOOL_HEAT * falloff, CELL_TEMP_MAX);
  } else if (tool == T_COOL) {
    (*oA).y = max(a.y - TOOL_HEAT * falloff, CELL_TEMP_MIN);
  } else if (tool == T_BLAST) {
    (*oB).w = b.w + TOOL_PRESSURE * falloff;
  } else if (tool == T_SPARK) {
    sparkCell(oA);   // conductors only, and only when ready (src/electricity.js)
  }
}`;
// WEBGPU-STUB (docs/webgpu.md J3): the brush is an edit (sim.editKernel with
// paintUpdateWGSL), not a full-screen copy-through pass.
export function paintFrag() { throw new Error('paintFrag removed in the WebGPU port: docs/webgpu.md D6 (paintUpdateWGSL)'); }

// ---- whole-grid passes: one thread per slot ----
const perSlot = (g) => fold(Math.ceil(gridDims(g).slots / 64));
const slotMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }`;

// Every cell of the copy H.dst gets fresh flags from its own state
// (freshFlags: the next activity map redoes its neighbour tests): after a
// whole-grid write that wrote A and B only (a codec unpack, U12; the CPU's
// copies, docs/webgpu.md D6). Reads H.src: the same copy.
export const freshFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${slotMain}
  let p = cellOf(s);
  writeFlags(p, freshFlags(fetchAs(s), fetchBs(s)));
}
`;

// The conversions to and from the CPU's order (docs/webgpu.md C2: the state
// atlas, sim.js cellTexel): a scratch buffer of u32 words, the atlas's A
// (4 words a texel) then its B, or for flags one word a texel. Bit copies
// (bitcast), so every float comes back as it is, -0 and all.
export const ConvertParams = uniformStruct('ConvertParams', { flags: 'u32' });
export const CONVERT_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
const atlasWGSL = (g) => {
  const at = atlasDims(g);
  return /* wgsl */ `
${ConvertParams.wgsl}
@group(3) @binding(1) var<uniform> P: ConvertParams;
@group(2) @binding(0) var<storage, read_write> scratch: array<u32>;
const STW: i32 = ${at.stw};   // supertiles per atlas row (shaders/common.js atlasDims)
const ATLAS_W: i32 = ${at.width};
const TEXELS: u32 = ${at.width * at.height}u;
// cell p's texel in the atlas (sim.js cellTexel): supertile i's square at
// (i % STW, i / STW), its brick k's tile at (k.x, k.z + SUPER.z·k.y), the cell
// at (x + BRICK·(y & 1), z + BRICK·(y >> 1)) in the tile
fn atlasIndex(p: vec3i) -> u32 {
  let b = p >> vec3u(2u);
  let st = b / SUPER_B;
  let k = b - st * SUPER_B;
  let i = st.x + STX * (st.z + STZ * st.y);
  let ly = p.y & 3;
  let u = (i % STW) * ${SUPER_TEX} + k.x * ${TILE} + (p.x & 3) + ${BRICK} * (ly & 1);
  let v = (i / STW) * ${SUPER_TEX} + (k.z + ${SUPER.z} * k.y) * ${TILE} + (p.z & 3) + ${BRICK} * (ly >> 1u);
  return u32(v * ATLAS_W + u);
}`;
};
// toAtlas: the copy H.src into the scratch: A and B, or the flags.
export const toAtlasFrag = (g) => /* wgsl */ `
${prelude(g, { state: 'read', flags: true })}
${atlasWGSL(g)}
${slotMain}
  let t = atlasIndex(cellOf(s));
  if (P.flags != 0u) {
    scratch[t] = fetchFs(s);
    return;
  }
  let a = bitcast<vec4u>(fetchAs(s));
  let b = bitcast<vec4u>(fetchBs(s));
  for (var c = 0u; c < 4u; c++) {
    scratch[4u * t + c] = a[c];
    scratch[4u * (TEXELS + t) + c] = b[c];
  }
}
`;
// fromAtlas: the scratch's A and B into the copy H.dst, with fresh flags (load).
export const fromAtlasFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${atlasWGSL(g)}
${slotMain}
  let t = atlasIndex(cellOf(s));
  var a: vec4u;
  var b: vec4u;
  for (var c = 0u; c < 4u; c++) {
    a[c] = scratch[4u * t + c];
    b[c] = scratch[4u * (TEXELS + t) + c];
  }
  let fa = bitcast<vec4f>(a);
  let fb = bitcast<vec4f>(b);
  writeStateS(s, fa, fb, freshFlags(fa, fb));
}
`;
// The copy H.src into the copy H.dst, flags and all (syncCopies: an exact
// copy keeps the sleeping invariant, docs/webgpu.md D6). A kernel, not
// copyBufferToBuffer: WebGPU doesn't copy between two ranges of one buffer,
// and the copies are halves of A, B and F.
export const copyFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${slotMain}
  writeStateS(s, fetchAs(s), fetchBs(s), fetchFs(s));
}
`;

// ---- the derived passes' note of the quiet map (docs/webgpu.md D4 noteAwake) ----
// The bricks the current quiet map doesn't skip may change: changed[b] =
// noted ? changed[b] | !quiet[b] : !quiet[b] (the old MAX blend). One thread
// per brick; sim.noteAwake() runs it for updateDirty's carry (the build
// notes its own maps in its quiet kernel).
export const AwakeParams = uniformStruct('AwakeParams', { noted: 'u32' });
export const awakeFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_BUILD)}
${AwakeParams.wgsl}
@group(3) @binding(1) var<uniform> P: AwakeParams;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let woke = atomicLoad(&act[ACT_QUIET + b]) == 0u;
  let was = atomicLoad(&act[ACT_CHANGED + b]) != 0u;
  atomicStore(&act[ACT_CHANGED + b], select(0u, 1u, woke || (P.noted != 0u && was)));
}
`;

// ---- the derived passes (U4, src/derived.js) ----
// Their constants stay here for the modules that read them; their kernels
// are U4's to port (docs/webgpu.md E, J3).
export const BRICK_DIST_MAX = 8;          // bricks; also the half-width of each pass's window
export const BRICK_DIST_SCALE = 255;      // stored as distance / this in an 8-bit channel (gfx/core.js until U3/U6)
export const AGE_MAX = 255;               // frames an age counts up to
export const FIELDS_DILATE = Math.ceil(FIELD_REACH / BRICK);
export const WORK_DILATE = Math.ceil((FIELD_REACH + FIELD_SCRATCH_REACH) / BRICK);
const derivedStub = (name) => () => { throw new Error(`${name} removed in the WebGPU port: docs/webgpu.md E (src/derived.js)`); };
// WEBGPU-STUB (docs/webgpu.md J3)
export const brickFrag = derivedStub('brickFrag');
// WEBGPU-STUB (docs/webgpu.md J3)
export const blurFrag = derivedStub('blurFrag');
// WEBGPU-STUB (docs/webgpu.md J3)
export const brickDistFrag = derivedStub('brickDistFrag');
// WEBGPU-STUB (docs/webgpu.md J3)
export const ageFrag = derivedStub('ageFrag');
// WEBGPU-STUB (docs/webgpu.md J3)
export const dirtyFrag = derivedStub('dirtyFrag');
// WEBGPU-STUB (docs/webgpu.md J3): region maps are gone (the derived kernels run over brick lists)
export const fieldRegionMapFrag = derivedStub('fieldRegionMapFrag');
// WEBGPU-STUB (docs/webgpu.md J3)
export const regionShareFrag = derivedStub('regionShareFrag');

const rw = () => [LAYOUT.TABLES, LAYOUT.STATE_RW];
// The brush's kernel as sim.editKernel assembles it.
export const paintKernelWGSL = (g, opts = {}) => editKernelWGSL(g, { update: paintUpdateWGSL, params: PaintParams, reads: 'own', ...opts });
// One 64-thread workgroup per brick of a box (editMain), at most the grid's.
const perBox = (g) => fold(gridDims(g).nbricks);
/**
 * tools/check-wgsl.mjs, and the pipelines a grid needs (the start menu's
 * warm-up, docs/webgpu.md B5): every entry but those marked `tool` (built only
 * when a tool or a writer asks: sim.prepare) and `windowed` (a world's grid only).
 */
export const WGSL_CHECK = [
  { name: 'paint', kind: 'compute', code: (g) => paintKernelWGSL(g), layouts: rw, dispatch: perBox },
  { name: 'fresh', kind: 'compute', code: (g) => freshFrag(g), layouts: rw, dispatch: perSlot, tool: true },
  { name: 'copy', kind: 'compute', code: (g) => copyFrag(g), layouts: rw, dispatch: perSlot, tool: true, windowed: true },
  { name: 'toAtlas', kind: 'compute', code: toAtlasFrag, dispatch: perSlot, tool: true,
    layouts: () => [LAYOUT.TABLES, stateLayout({ state: 'read', flags: true }), CONVERT_LAYOUT] },
  { name: 'fromAtlas', kind: 'compute', code: (g) => fromAtlasFrag(g), dispatch: perSlot, layouts: () => [...rw(), CONVERT_LAYOUT] },
  { name: 'awake', kind: 'compute', code: awakeFrag, dispatch: (g) => fold(Math.ceil(gridDims(g).nbricks / 64)),
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_BUILD] },
];
