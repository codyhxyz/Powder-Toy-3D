import {
  prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, gridDims, atlasDims, stateLayout, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL,
} from './common.js';
import { FIELD_REACH, FIELD_SCRATCH_REACH } from './fields.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { propGLSL } from '../editing.js';

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
// TPT's editing tools ride along (src/editing.js): a line sweeps the brush
// from center to end, a box grows it by grow along each axis, a flood fill
// paints the cells its mask marks instead of the brush's (the fill's region,
// a byte per atlas texel, group 2); filter touches only one element (replace
// mode's target, a fill's region), del makes an element brush erase (TPT's
// specific delete), and the PROP tool sets one property (prop, propValue).
export const PaintParams = uniformStruct('PaintParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',
  radius: 'f32',
  shape: 'u32',     // 0 sphere, 1 cube
  tool: 'i32',      // element id, or negative tool id
  rate: 'f32',      // spawn density multiplier
  replace: 'u32',
  frame: 'u32',
  wind: 'vec3f',    // Wind: cells the brush moved since the stroke's last paint
  end: 'vec3f',     // a line (Shift-drag): the brush swept from center to here (center for a dab)
  grow: 'vec3f',    // a box (Ctrl-drag): the brush grown by this much along each axis (0 for a dab)
  masked: 'u32',    // a flood fill (Ctrl+Shift-click): the cells the mask marks, not the brush's
  filter_: 'i32',   // only cells of this element; -1: any ('filter' is reserved in WGSL)
  del: 'u32',       // specific delete: an element brush erases instead (TPT's SPECIFIC_DELETE)
  prop: 'u32',      // the PROP tool: which property (PROP_*), and its value
  propValue: 'f32',
});
// Group 2 of the brush's kernels: the fill's mask, a byte per atlas texel
// (editing.js regionMask), 4 to a word (a 16-byte dummy when not filling).
export const PAINT_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
export const paintDeclsWGSL = (g) => /* wgsl */ `
@group(2) @binding(0) var<storage, read> paintMask: array<u32>;
${atlasIndexWGSL(g)}`;

// The Mix tool pairs cells inside blocks of 2^MIX_BITS cells a side: up to 7
// cells apart, as MIX.cpp's reach of 10 pixels (±5) at strength 1.
export const MIX_BITS = 3;
const MIX_SALT = 0x4d, MIX_PAIR_SALT = 0x4e;   // the Mix tool's random streams (seedWorld salts)

// TPT's air tools on our cells (elements.js TOOLS -50..-57, physics.js TOOL_*).
// TPT moves its air and lets particles follow it by their advection; we have
// no advection, so the tools push the cells themselves: air in full, loose
// matter by its inertia, as the pressure push does (react.js: a = −∇P·P_ACCEL/ρ),
// solids not at all.
// Mix (TPT MIX.cpp swaps a particle with a random one within reach) can't swap
// per cell on the GPU: two cells could pick the same partner. So each paint
// splits the grid into blocks at an offset drawn for that paint, and each block
// draws one mask m: cell l of the block (its coordinates in it) pairs with
// cell l XOR m. That is its own inverse, so partners are mutual, and both
// cells test the same things (both inside the brush, loose matter of one kind,
// as MIX.cpp: powder with powder, liquid with liquid, gas with gas) and draw
// one coin seeded at the pair's lower cell: they swap together or not at all.
// No cell is lost or copied (tools/brush-tools-check.mjs runs a twin of it).
// A cell reads its partner, so Mix is a two-phase edit (sim.js paint: every
// read sees the state before the stroke, docs/webgpu.md D6).
const brushToolsWGSL = /* wgsl */ `
const MIX_BITS: u32 = ${MIX_BITS}u;
const MIX_MASK: u32 = ${(1 << MIX_BITS) - 1}u;
const MIX_SALT: u32 = ${MIX_SALT}u;
const MIX_PAIR_SALT: u32 = ${MIX_PAIR_SALT}u;
// Is the fill's mask off at cell p (its byte below half of MASK_ON)?
fn maskOff(p: vec3i) -> bool {
  let t = atlasIndex(p);
  return ((paintMask[t >> 2u] >> ((t & 3u) * 8u)) & 255u) < 128u;
}
// How far cell p lies outside the stroke (inside: at most P.radius): the brush
// at P.center, swept to P.end (a line), grown by P.grow (a box), or the cells
// the mask marks (a fill, all at distance 0). src/editing.js
fn strokeDist(p: vec3i) -> f32 {
  if (P.masked != 0u) {
    if (maskOff(p)) { return P.radius + 1.0; }
    return 0.0;
  }
  var d = vec3f(p) + 0.5 - P.center;
  let s = P.end - P.center;
  d -= s * clamp(dot(d, s) / max(dot(s, s), SEGMENT_EPS), 0.0, 1.0);   // from the line's nearest point
  d = max(abs(d) - P.grow, vec3f(0.0));                                  // from the box's core
  if (P.shape == 0u) { return length(d); }
  return max(d.x, max(d.y, d.z));
}
fn inBrush(p: vec3i) -> bool { return strokeDist(p) <= P.radius; }
// a push dv given to the air, as the cell (id at T) takes it, capped at V_MAX
fn pushed(id: i32, T: f32, v: vec3f, dv: vec3f) -> vec3f {
  if (KIND(id) == K_SOLID) { return v; }
  return clamp(v + dv * RHO_MIN / max(densityOf(id, T) * RHO_SCALE, RHO_MIN), vec3f(-V_MAX), vec3f(V_MAX));
}
// TPT CYCL.cpp turns the brush's pull a quarter turn. Ours spins about the
// vertical through the brush centre, counterclockwise seen from above, as a
// northern-hemisphere cyclone and most tornadoes do: the unit tangent at d.
fn cyclone(d: vec3f) -> vec3f {
  let r = length(d.xz);
  if (r > 0.0) { return vec3f(d.z, 0.0, -d.x) / r; }
  return vec3f(0.0);   // TPT skips the centre too
}
// A ball of mass filling the brush (physics.js TOOL_GRAVITY): the pull at d
// grows as |d| / radius, toward the centre (sign 1) or away (-1), on matter.
fn gravityWell(id: i32, v: vec3f, d: vec3f, sgn: f32) -> vec3f {
  if (id == E_EMPTY || KIND(id) == K_SOLID) { return v; }
  return clamp(v - sgn * TOOL_GRAVITY * d / max(P.radius, BRUSH_EDGE_EPS), vec3f(-V_MAX), vec3f(V_MAX));
}
// what Mix moves (MIX.cpp: TYPE_PART | TYPE_LIQUID | TYPE_GAS)
fn mixes(id: i32) -> bool { let k = KIND(id); return k == K_POWDER || k == K_LIQUID || k == K_GAS; }
// a cell's index in its block (x, then y, then z bits)
fn mixIndex(l: vec3i) -> i32 { return l.x | (l.y << MIX_BITS) | (l.z << (2u * MIX_BITS)); }
fn mixCell(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let fs = pcg(P.frame * LCG_MUL + MIX_SALT);   // this paint's block offset
  let off = vec3i(vec3u(fs, fs >> MIX_BITS, fs >> (2u * MIX_BITS)) & vec3u(MIX_MASK));
  let w = p + H.origin + off;              // world cell, so blocks don't follow the window
  let l = w & vec3i(i32(MIX_MASK));        // the cell in its block (two's complement: fine below 0)
  let base = w - l;
  let hs = seedWorld(base, P.frame, MIX_SALT);
  let m = vec3i(vec3u(hs, hs >> MIX_BITS, hs >> (2u * MIX_BITS)) & vec3u(MIX_MASK));   // the block's mask
  let lq = l ^ m;
  let q = p + lq - l;
  if (all(m == vec3i(0)) || !inGrid(q) || !inBrush(p) || !inBrush(q)) { return; }
  let qa = fetchA(q);
  let id = eid(a);
  if (!mixes(id) || KIND(eid(qa)) != KIND(id)) { return; }
  var ps = seedWorld(base + select(lq, l, mixIndex(l) < mixIndex(lq)), P.frame, MIX_PAIR_SALT);
  if (rnd(&ps) >= TOOL_MIX_SWAP) { return; }
  *oA = qa;
  *oB = vec4f(fetchB(q).xyz, b.w);   // the cell moves with its velocity; the air's pressure stays
}
`;

// The update editMain calls (shaders/common.js): fn update(p, a, b, oA, oB).
export const paintUpdateWGSL = /* wgsl */ `
const PAINT_RNG_SALT: u32 = 0xb7u;    // salt that gives the brush its own random stream (seed3)
const BRUSH_EDGE_EPS: f32 = 0.001;    // keeps smoothstep's edges apart at radius 0
const SEGMENT_EPS: f32 = 1e-6;        // a line's squared length below which it is a dab
${propGLSL()}
${brushToolsWGSL}
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let tool = P.tool;
  if (tool == T_MIX) { mixCell(p, a, b, oA, oB); return; }   // before the shape test: both cells of a pair test inBrush alike
  let r = strokeDist(p);
  if (r > P.radius) { return; }
  let d = vec3f(p) + 0.5 - P.center;   // from the brush's centre: Cyclone and the gravity wells turn about it
  let falloff = 1.0 - smoothstep(P.radius * TOOL_FALLOFF, P.radius + BRUSH_EDGE_EPS, r);

  var rs = seed3(p, P.frame, PAINT_RNG_SALT);
  let id = eid(a);
  if (P.filter_ >= 0 && id != P.filter_) { return; }
  // TPT's PropertyTool sets particles only (SetProperty skips empty pixels); pressure is the air's own
  if (tool == T_PROP && id == E_EMPTY && P.prop != PROP_PRESSURE) { return; }
  let propErases = tool == T_PROP && P.prop == PROP_TYPE && P.propValue == f32(E_EMPTY);   // TPT: type NONE kills the particle

  if (tool >= 0 && P.del == 0u) {
    if (id == tool) { return; }
    if (id != E_EMPTY && P.replace == 0u) { return; }
    if (rnd(&rs) > SPAWNDENS(tool) * P.rate) { return; }
    let T = SPAWNT(tool);
    let ctype = select(0.0, f32(E_STONE), tool == E_LAVA);
    *oA = vec4f(f32(tool), T, SPAWNLIFE(tool), ctype + rnd(&rs) * SEED_MAX);
    let vy = select(0.0, SPAWN_DROP_V, KIND(tool) == K_POWDER || KIND(tool) == K_LIQUID);
    *oB = vec4f(0.0, vy, 0.0, b.w);
  } else if (tool == T_ERASE || tool >= 0 || propErases) {   // (tool >= 0 here: specific delete)
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
  } else if (tool == T_VACUUM) {
    (*oB).w = max(b.w - TOOL_PRESSURE * falloff, P_MIN);   // TPT VAC.cpp: AIR.cpp's pressure, taken away
  } else if (tool == T_WIND) {
    *oB = vec4f(pushed(id, a.y, b.xyz, P.wind * TOOL_WIND * falloff), b.w);
  } else if (tool == T_CYCLONE) {
    *oB = vec4f(pushed(id, a.y, b.xyz, cyclone(d) * TOOL_CYCLONE * falloff), b.w);
  } else if (tool == T_GRAV_IN || tool == T_GRAV_OUT) {
    *oB = vec4f(gravityWell(id, b.xyz, d, select(-1.0, 1.0, tool == T_GRAV_IN)), b.w);
  } else if (tool == T_AMB_HEAT) {
    if (id == E_EMPTY) { (*oA).y = min(a.y + TOOL_HEAT * falloff, CELL_TEMP_MAX); }   // TPT AMBP.cpp: the air only
  } else if (tool == T_AMB_COOL) {
    if (id == E_EMPTY) { (*oA).y = max(a.y - TOOL_HEAT * falloff, CELL_TEMP_MIN); }   // TPT AMBM.cpp
  } else if (tool == T_PROP) {
    let v = P.propValue;
    if (P.prop == PROP_PRESSURE) { (*oB).w = v; }
    else if (P.prop == PROP_TYPE) { (*oA).x = v; }
    else if (P.prop == PROP_CTYPE) { (*oA).w = v + fract(a.w); }
    else if (P.prop == PROP_TEMP) { (*oA).y = v; }
    else if (P.prop == PROP_LIFE) { (*oA).z = v; }
    else if (P.prop == PROP_VX) { (*oB).x = v; }
    else if (P.prop == PROP_VY) { (*oB).y = v; }
    else if (P.prop == PROP_VZ) { (*oB).z = v; }
  }
}`;
// WEBGPU-STUB (docs/webgpu.md J3): the brush is an edit (sim.editKernel with
// paintUpdateWGSL), not a full-screen copy-through pass.
export function paintFrag() { throw new Error('paintFrag removed in the WebGPU port: docs/webgpu.md D6 (paintUpdateWGSL)'); }

// ---- whole-grid passes: one thread per slot ----
const perSlot = (g) => fold(Math.ceil(gridDims(g).slots / 64));
const perTexel = (g) => { const at = atlasDims(g); return fold(Math.ceil((at.width * at.height) / 64)); };
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
// Cell p's texel in the atlas (sim.js cellTexel): supertile i's square at
// (i % STW, i / STW), its brick k's tile at (k.x, k.z + SUPER.z·k.y), the cell
// at (x + BRICK·(y & 1), z + BRICK·(y >> 1)) in the tile.
const atlasIndexWGSL = (g) => {
  const at = atlasDims(g);
  return /* wgsl */ `
const STW: i32 = ${at.stw};   // supertiles per atlas row (shaders/common.js atlasDims)
const ATLAS_W: i32 = ${at.width};
const TEXELS: u32 = ${at.width * at.height}u;
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
const atlasWGSL = (g) => /* wgsl */ `
${ConvertParams.wgsl}
@group(3) @binding(1) var<uniform> P: ConvertParams;
@group(2) @binding(0) var<storage, read_write> scratch: array<u32>;
${atlasIndexWGSL(g)}`;
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
// rectToAtlas: the w × h rectangle of the atlas at texel P.at, of the copy
// H.src, into the scratch row by row: A (4 words a texel) then B, the console's
// reads (sim.readStateRect) at the rectangle's cost, not the grid's. A thread a
// texel, atlasIndex inverted (sim.js texelCell); a texel past the last
// supertile is no cell's and reads 0.
export const RectParams = uniformStruct('RectParams', { at: 'vec2u', size: 'vec2u' });
export const rectToAtlasFrag = (g) => /* wgsl */ `
${prelude(g, { state: 'read', flags: true })}
${RectParams.wgsl}
@group(3) @binding(1) var<uniform> P: RectParams;
@group(2) @binding(0) var<storage, read_write> scratch: array<u32>;
const STW: i32 = ${atlasDims(g).stw};   // supertiles per atlas row
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let r = foldThread(wg, nwg, li);
  let n = P.size.x * P.size.y;
  if (r >= n) { return; }
  let u = i32(P.at.x + r % P.size.x);
  let v = i32(P.at.y + r / P.size.x);
  let su = u / ${SUPER_TEX};
  let sv = v / ${SUPER_TEX};
  let i = su + STW * sv;
  var a = vec4u(0u);
  var b = vec4u(0u);
  if (i < STX * STY * STZ) {
    // supertile i, its brick tile k (x, z + SUPER.z·y), the texel l in the tile
    let st = vec3i(i % STX, i / (STX * STZ), (i / STX) % STZ);
    let tu = u - su * ${SUPER_TEX};
    let tv = v - sv * ${SUPER_TEX};
    let k = vec2i(tu / ${TILE}, tv / ${TILE});
    let l = vec2i(tu - k.x * ${TILE}, tv - k.y * ${TILE});
    let p = (st * SUPER_B + vec3i(k.x, k.y / ${SUPER.z}, k.y % ${SUPER.z})) * ${BRICK}
      + vec3i(l.x % ${BRICK}, (l.x / ${BRICK}) | ((l.y / ${BRICK}) << 1u), l.y % ${BRICK});
    let s = slotOf(p);
    a = bitcast<vec4u>(fetchAs(s));
    b = bitcast<vec4u>(fetchBs(s));
  }
  for (var c = 0u; c < 4u; c++) {
    scratch[4u * r + c] = a[c];
    scratch[4u * (n + r) + c] = b[c];
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
// The brush's kernel as sim.editKernel assembles it (Mix's: reads 'neighbours').
export const paintKernelWGSL = (g, opts = {}) => editKernelWGSL(g, { update: paintUpdateWGSL, params: PaintParams, reads: 'own', decls: paintDeclsWGSL(g), ...opts });
// One 64-thread workgroup per brick of a box (editMain), at most the grid's.
const perBox = (g) => fold(gridDims(g).nbricks);
/**
 * tools/check-wgsl.mjs, and the pipelines a grid needs (the start menu's
 * warm-up, docs/webgpu.md B5): every entry but those marked `tool` (built only
 * when a tool or a writer asks: sim.prepare) and `windowed` (a world's grid only).
 */
export const WGSL_CHECK = [
  { name: 'paint', kind: 'compute', code: (g) => paintKernelWGSL(g), layouts: () => [...rw(), PAINT_LAYOUT], dispatch: perBox },
  // Mix: two-phase (main, then apply), the scratch after the mask
  { name: 'paintMix', kind: 'compute', code: (g) => paintKernelWGSL(g, { reads: 'neighbours' }), dispatch: perBox,
    layouts: () => [...rw(), [...PAINT_LAYOUT, { binding: EDIT_SCRATCH_BINDING, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]] },
  { name: 'fresh', kind: 'compute', code: (g) => freshFrag(g), layouts: rw, dispatch: perSlot, tool: true },
  // (a world's window syncs its copies until world/window.js stops, G1; elsewhere tools only)
  { name: 'copy', kind: 'compute', code: (g) => copyFrag(g), layouts: rw, dispatch: perSlot, windowed: true },
  { name: 'toAtlas', kind: 'compute', code: toAtlasFrag, dispatch: perSlot, tool: true,
    layouts: () => [LAYOUT.TABLES, stateLayout({ state: 'read', flags: true }), CONVERT_LAYOUT] },
  // (the console's reads, U12: a rectangle as large as the atlas at most)
  { name: 'rectToAtlas', kind: 'compute', code: rectToAtlasFrag, dispatch: perTexel, tool: true,
    layouts: () => [LAYOUT.TABLES, stateLayout({ state: 'read', flags: true }), CONVERT_LAYOUT] },
  { name: 'fromAtlas', kind: 'compute', code: (g) => fromAtlasFrag(g), dispatch: perSlot, layouts: () => [...rw(), CONVERT_LAYOUT] },
  { name: 'awake', kind: 'compute', code: awakeFrag, dispatch: (g) => fold(Math.ceil(gridDims(g).nbricks / 64)),
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_BUILD] },
];
