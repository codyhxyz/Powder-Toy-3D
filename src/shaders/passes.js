import {
  prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, gridDims, atlasDims, stateLayout, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL,
} from './common.js';
import {
  AGE, FIELDS_DILATE, WORK_DILATE, FIELD_LAYOUT, LAYOUT_ENTRY, dirtyListsWGSL, listMainWGSL, FIELD_REACH, FIELD_SCRATCH_REACH,
} from './fields.js';
import { brickInfoWGSL } from './bindings.js';
import { materialsGLSL } from '../gfx/materials.js';
import { uniformStruct } from '../gpu/params.js';
import { fold, MAX_WORKGROUPS } from '../gpu/kernels.js';
import { propGLSL } from '../editing.js';

// The simulation's own passes besides the step (docs/webgpu.md D6, D7, C2):
// the brush (an edit), fresh flags over the whole grid, the conversions
// between the brick-major slots and the CPU's atlas order, and the note of
// the quiet map for the derived passes. Then the derived passes' bookkeeping
// and brick-resolution kernels (docs/webgpu.md E: the ages, the dirty sets'
// lists, the brick map, the empty-space distance, the glow volume, and the
// window shift of their buffers), which src/derived.js runs; the field
// kernels between them are shaders/fields.js's.

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
    *oA = vec4f(f32(E_EMPTY), airT(), 0.0, rnd(&rs) * SEED_MAX);
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

// ---- the derived passes (docs/webgpu.md E; src/derived.js runs them) ----
// Per derived frame, at brick resolution (docs/scaling.md D9):
//   age        derived frames since each brick last changed (fields.js AGE)
//   dirty      from the ages, the dirty sets' lists (fields.js DIRTY): EMA,
//              FIELDS and WORK
//   dirtyArgs  their lengths and indirect arguments
// then the field passes over them (shaders/fields.js), the brick map over
// FIELDS, and over every brick the empty-space distance and the glow volume
// (brick-resolution passes: cheap whole).
export const BRICK_DIST_MAX = 8;          // bricks; also the half-width of each pass's window
// WEBGPU-STUB (docs/webgpu.md J3): brickDist holds the distance itself, a u32 per brick (bindings.js brickDistAt).
export const BRICK_DIST_SCALE = null;
export const AGE_MAX = AGE.MAX;           // frames an age counts up to
export { FIELDS_DILATE, WORK_DILATE };

const E = LAYOUT_ENTRY;
// Group 2 of the derived kernels (src/derived.js makes them; the field
// kernels' are shaders/fields.js FIELD_LAYOUT):
//   BOOK      the ages and the lists buffer (age, dirty, dirtyArgs)
//   BRICK     the FIELDS list, the three final fields (sampled) and the brick map
//   PAIR      a source and a destination: brickDist's axes, the light blur, a
//             brick buffer's shift
//   LIGHT     the light blur's last pass: the source and the light volume
//   GI_SHIFT  the GI probes' history, its shifted copy and their four textures
export const DERIVED_LAYOUT = {
  BOOK: [E.rw(0), E.rw(1)],
  BRICK: [E.ro(0), E.tex3d(1), E.tex3d(2), E.tex3d(3), E.rw(4)],
  PAIR: FIELD_LAYOUT.PAIR,
  LIGHT: [E.ro(0), E.out3d(1)],
  GI_SHIFT: [E.ro(0), E.rw(1), E.out3d(2), E.out3d(3), E.out3d(4), E.out3d(5)],
};

const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const brickMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {`;

// age: one thread per brick. 0 if the brick may have changed since the last
// derived frame: steps ran since (steps: sim.actNoted) and a quiet map they
// used didn't skip it (act's `changed`, noted by the activity build and
// sim.noteAwake), or a writer changed it (marks.derived, which this pass
// clears: a mark is read once), or every brick did (all: a whole-grid write, a
// new smoothing, sim.incremental = false), or a shift's fold noted a change
// (AGE_CHANGED, below). Else one more, up to AGE_MAX. A brick a shift brought
// in (AGE_SHIFTED) becomes FRESH for this frame's EMA. Without the steps gate,
// a derived frame with no steps since the last (paused, with a view or
// smoothing change) would age the last map's awake bricks back to 0: exact,
// but wasted work (docs/webgpu.md E).
// tick 0 is the fold before a window shift (src/derived.js shift): the marks
// and `changed` are where the bricks were before it, so the same test runs
// there and only notes its answer in the brick's word (AGE_CHANGED), which the
// shift moves with the brick; the age itself waits for the next derived frame,
// which counts the change as its own. One pipeline for both (D8.11).
export const AgeParams = uniformStruct('AgeParams', { steps: 'u32', all: 'u32', tick: 'u32' });
export const ageFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_BUILD)}
${dirtyListsWGSL(g)}
${AgeParams.wgsl}
@group(3) @binding(1) var<uniform> P: AgeParams;
@group(2) @binding(0) var<storage, read_write> age: array<u32>;
${brickMain}
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let word = MARK_DERIVED + (b >> 5u);
  let bit = 1u << (b & 31u);
  let marked = (atomicLoad(&marks[word]) & bit) != 0u;
  if (marked) { atomicAnd(&marks[word], ~bit); }
  let w = age[b];
  let changed = P.all != 0u || marked || (P.steps != 0u && actLoad(ACT_CHANGED + b) != 0u) || (w & AGE_CHANGED) != 0u;
  if (P.tick == 0u) {
    age[b] = w | select(0u, AGE_CHANGED, changed);
    return;
  }
  var a = min((w & AGE_MASK) + 1u, AGE_MAX);
  if (changed) { a = 0u; }
  age[b] = a | select(0u, AGE_FRESH, (w & AGE_SHIFTED) != 0u);
}
`;

// dirty: one thread per brick. Its Chebyshev distance (in bricks) to the
// nearest brick of age < EMA_SETTLE, within WORK_DILATE, puts it in the lists:
// EMA at 0, FIELDS within FIELDS_DILATE, WORK within WORK_DILATE. Appends go
// one global atomic per workgroup and list (docs/webgpu.md D4): list order is
// free, since each entry is a workgroup writing its own brick's cells.
export const dirtyFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
@group(2) @binding(0) var<storage, read_write> age: array<u32>;
@group(2) @binding(1) var<storage, read_write> dlist: array<atomic<u32>>;
var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgBase: u32;
// Appends entry to a list if on: the workgroup counts its entries, one thread
// adds them to the list's counter, then each writes its own. Uniform control
// flow only (barriers).
fn append(on: bool, entry: u32, list: u32, li: u32) {
  var mine = 0u;
  if (on) { mine = atomicAdd(&wgCount, 1u); }
  workgroupBarrier();
  if (li == 0u) {
    wgBase = atomicAdd(&dlist[DL_COUNT + list], atomicLoad(&wgCount));
    atomicStore(&wgCount, 0u);
  }
  let base = workgroupUniformLoad(&wgBase);
  if (on) { atomicStore(&dlist[list * NBRICKS + base + mine], entry); }
}
${brickMain}
  let b = foldThread(wg, nwg, li);
  var near = WORK_DILATE + 1;
  if (b < NBRICKS) {
    let bc = brickCoord(b);
    for (var z = -WORK_DILATE; z <= WORK_DILATE; z++) {
      for (var y = -WORK_DILATE; y <= WORK_DILATE; y++) {
        for (var x = -WORK_DILATE; x <= WORK_DILATE; x++) {
          let q = bc + vec3i(x, y, z);
          if (!brickInGrid(q)) { continue; }
          if ((age[brickId(q)] & AGE_MASK) < EMA_SETTLE) { near = min(near, max(abs(x), max(abs(y), abs(z)))); }
        }
      }
    }
  }
  append(near == 0, b, LIST_EMA, li);
  append(near <= FIELDS_DILATE, b, LIST_FIELDS, li);
  append(near <= WORK_DILATE, b, LIST_WORK, li);
}
`;

// dirtyArgs: one thread. Each list's length into its LAST word (what the
// kernels dispatched over it read), its counter back to 0 for the next
// frame, and its indirect arguments fold()ed as src/gpu/kernels.js folds
// ([ceil(n / y), y, 1], y = ceil(n / 65535)): a workgroup per entry.
export const dirtyArgsFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
const MAX_WG: u32 = ${MAX_WORKGROUPS}u;
@group(2) @binding(1) var<storage, read_write> dlist: array<atomic<u32>>;
@compute @workgroup_size(1)
fn main() {
  for (var l = 0u; l < 3u; l++) {
    let n = atomicLoad(&dlist[DL_COUNT + l]);
    atomicStore(&dlist[DL_LAST + l], n);
    atomicStore(&dlist[DL_COUNT + l], 0u);
    let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
    atomicStore(&dlist[DL_ARGS + 4u * l], (n + y - 1u) / y);
    atomicStore(&dlist[DL_ARGS + 4u * l + 1u], y);
    atomicStore(&dlist[DL_ARGS + 4u * l + 2u], 1u);
  }
}
`;

// The brick map (shaders/bindings.js BrickInfo): per brick, the average light
// it gives off (lava, fire, glowing-hot metal, luminous crystal, live sparks;
// the light blur spreads it into the glow volume) and an info word: what it
// holds and what the data views draw in its air.
//   matter (BRICK_MATTER): it holds matter, or a smooth surface or media
//          field reaches into it (the render fields are already blurred, so a
//          brick next to a surface or plume sees them in its own cells: the
//          skip map is dilated for free); bits BRICK_MEDIA, _SURF, _OPAQUE
//          (crisp matter or an opaque surface field), _THIN (thin cubic
//          matter, drops and grains: the tracer reads it cubic), _MIXED (more
//          than one liquid); its steam and smoke cells (brickGas)
//   air    the air flags (warmer or colder than ambient, pressure, moving)
//          on matter bricks and on air-only bricks, which carry nothing else;
//          the realistic view, picking and the shadow map skip those like
//          empty bricks (brickMatter)
// A workgroup per brick of the FIELDS list (only those may change: the rest
// keep last frame's record, since nothing they read has changed), a thread
// per cell, reduced in workgroup memory: maxima and counts are order-free,
// and the emission's sum runs a fixed tree, so it doesn't depend on how the
// threads are scheduled (docs/webgpu.md W21).
export const brickFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${brickInfoWGSL}
${dirtyListsWGSL(g)}
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var tFS: texture_3d<f32>;
@group(2) @binding(2) var tFM: texture_3d<f32>;
@group(2) @binding(3) var tFT: texture_3d<f32>;   // thin-feature mask, per surface channel (the cubic ones read it)
@group(2) @binding(4) var<storage, read_write> brick: array<BrickInfo>;
// Air worth flagging for the data views: off ambient by more than AIR_FLAG_T °C,
// pressure beyond AIR_FLAG_P, or moving faster than AIR_FLAG_V cells/step.
const AIR_FLAG_T: f32 = 3.0;
const AIR_FLAG_P: f32 = 0.04;
const AIR_FLAG_V: f32 = 0.05;
// a fire cell's glow: blackbody colour × (BASE + T / T_SCALE) × GAIN
const FIRE_GLOW_BASE: f32 = 0.6;
const FIRE_GLOW_T: f32 = 1500.0;
const FIRE_GLOW_GAIN: f32 = 1.5;
const FIELD_HERE: f32 = 0.03;   // a surface field this strong may hold a surface nearby

// A hot or luminous opaque cell lights its surroundings only through its open
// faces: buried lava or a conduit of hot rock casts no light. Per open face it
// counts as the brick-deep column under a flat surface did when every hot
// cell counted.
const GLOW_FACE_GAIN: f32 = f32(BS);
fn openFaces(c: vec3i) -> f32 {
  var n = 0.0;
  for (var k = 0; k < 6; k++) {
    var q = c;
    q[k >> 1u] += select(1, -1, (k & 1) == 0);
    if (q.y < 0) { continue; }                         // the floor
    if (!inGrid(q)) { n += 1.0; continue; }            // open sky past the box
    if (RCLASS(eid(fetchA(q))) != R_OPAQUE) { n += 1.0; }
  }
  return n;
}

var<workgroup> wgEm: array<vec4f, 64>;    // emission (rgb), summed
var<workgroup> wgMax: array<vec4f, 64>;   // surface field, opaque, thin mask, media field
var<workgroup> wgAir: array<vec4f, 64>;   // |pressure|, speed² (the core's cells)
var<workgroup> wgOcc: atomic<u32>;        // a cell holds matter
var<workgroup> wgGas: atomic<u32>;        // steam and smoke cells
var<workgroup> wgFlags: atomic<u32>;      // air flags
var<workgroup> wgLiqHi: atomic<u32>;      // 1 + the highest liquid-channel element id (0: none)
var<workgroup> wgLiqLo: atomic<u32>;      // NE - the lowest
${listMainWGSL('LIST_FIELDS')}
  let a = fetchAs(s);
  let id = eid(a);
  if (id != E_EMPTY) { atomicOr(&wgOcc, 1u); }
  else if (abs(a.y - airT()) > AIR_FLAG_T) { atomicOr(&wgFlags, AIR_HOT); }
  if (id == E_STEAM || id == E_CLOUD || id == E_SMOKE) { atomicAdd(&wgGas, 1u); }
  let sf = textureLoad(tFS, p, 0);
  let mf = textureLoad(tFM, p, 0);
  // something opaque (not liquid, glass or gas) here or in an opaque surface field
  var opaque = 0.0;
  if (id != E_EMPTY && KIND(id) != K_GAS && RCLASS(id) != R_LIQUID && RCLASS(id) != R_GLASS) { opaque = 1.0; }
  opaque = max(opaque, max(sf.y, max(sf.z, sf.w)));
  // liquids (and ice): one, or more than one
  if (SURFCH(id) == CH_LIQUID) {
    atomicMax(&wgLiqHi, u32(id) + 1u);
    atomicMax(&wgLiqLo, u32(NE - id));
  }
  let tm = textureLoad(tFT, p, 0) * CH_CUBIC;
  wgMax[li] = vec4f(max(max(sf.x, sf.y), max(sf.z, sf.w)), opaque, max(max(tm.x, tm.y), max(tm.z, tm.w)), max(mf.x, max(mf.y, mf.z)));
  var em = vec3f(0.0);
  if (id == E_FIRE || id == E_PLASMA) { em = blackbody(a.y) * (FIRE_GLOW_BASE + a.y / FIRE_GLOW_T) * FIRE_GLOW_GAIN; }
  else if (id != E_EMPTY && KIND(id) != K_GAS && (a.y > INCAND_T0 || luminous(id) || sparkLive(id, floor(a.w)) || lampLit(id, floor(a.w)))) {
    // small sources shed more (gfx/materials.js SHED); a live conductor or a
    // lit lamp too (LAMP_ROOM_GAIN) (src/electricity.js)
    let ce = cellEmission(id, a.y, floor(a.w)) * SHED(id) + sparkEmit(id, floor(a.w)) * select(1.0, LAMP_ROOM_GAIN, id == E_LAMP);
    if (dot(ce, ce) > 0.0) {
      var f = 1.0;
      if (RCLASS(id) == R_OPAQUE) { f = openFaces(p) * GLOW_FACE_GAIN; }
      em = ce * f;
    }
  }
  wgEm[li] = vec4f(em, 0.0);
  // Pressure and air velocity are smooth fields, so the brick's 2×2×2 core is
  // a good enough sample (all 64 cells' B would double the pass's reads).
  let l = p & vec3i(3);
  var air = vec4f(0.0);
  if (all(l >= vec3i(1)) && all(l <= vec3i(2))) {
    let bv = fetchBs(s);
    air = vec4f(abs(bv.w), dot(bv.xyz, bv.xyz), 0.0, 0.0);
  }
  wgAir[li] = air;
  workgroupBarrier();
  for (var w = 32u; w > 0u; w >>= 1u) {
    if (li < w) {
      wgEm[li] += wgEm[li + w];
      wgMax[li] = max(wgMax[li], wgMax[li + w]);
      wgAir[li] = max(wgAir[li], wgAir[li + w]);
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let mx = wgMax[0];
    var flags = atomicLoad(&wgFlags);
    if (wgAir[0].x > AIR_FLAG_P) { flags |= AIR_PRESSURE; }
    if (wgAir[0].y > AIR_FLAG_V * AIR_FLAG_V) { flags |= AIR_FLOW; }
    let hasSurf = mx.x > FIELD_HERE;
    let hasMedia = mx.w > MEDIA_FLOOR;
    let hasOpaque = mx.y > FIELD_HERE;
    let hi = atomicLoad(&wgLiqHi);
    let mixed = hi != 0u && hi - 1u != u32(NE) - atomicLoad(&wgLiqLo);
    let bits = select(0u, BRICK_MEDIA, hasMedia) | select(0u, BRICK_SURF, hasSurf) | select(0u, BRICK_OPAQUE, hasOpaque)
             | select(0u, BRICK_THIN, mx.z > 0.0) | select(0u, BRICK_MIXED, mixed);
    var info = brickInfoWord(0u, flags, 0u, false);
    if (atomicLoad(&wgOcc) != 0u || hasSurf || hasMedia) { info = brickInfoWord(bits, flags, atomicLoad(&wgGas), true); }
    brick[b] = BrickInfo(wgEm[0].xyz / f32(BS * BS * BS), info);
  }
}
`;

// Empty-space distance: for each brick, the Chebyshev distance (in bricks) to
// the nearest brick the realistic view must visit (a matter brick), capped at
// BRICK_DIST_MAX. Every brick within (distance - 1) of an empty one is empty
// too, so a ray can cross that whole cube in one step instead of brick by
// brick (gfx/core.js skipEmpty). L∞ distance is separable: three passes, each
// a minimum over a 1D window along one axis (axis 0 reads the brick map, the
// others the distance so far). One thread per brick.
export const BrickDistParams = uniformStruct('BrickDistParams', { axis: 'u32' });
export const brickDistFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${brickInfoWGSL}
${BrickDistParams.wgsl}
@group(3) @binding(1) var<uniform> P: BrickDistParams;
@group(2) @binding(0) var<storage, read> src: array<u32>;   // axis 0: the brick map (4 words a brick), else distances
@group(2) @binding(1) var<storage, read_write> dst: array<u32>;
const DIST_MAX: i32 = ${BRICK_DIST_MAX};
${brickMain}
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let bc = brickCoord(i);
  var dir = vec3i(0);
  dir[P.axis] = 1;
  let hi = vec3i(BX, BY, BZ) - 1;
  var d = DIST_MAX;
  for (var k = -DIST_MAX; k <= DIST_MAX; k++) {
    let q = bc + dir * k;
    if (any(q < vec3i(0)) || any(q > hi)) { continue; }
    let qi = brickId(q);
    var v: i32;
    if (P.axis == 0u) { v = select(DIST_MAX, 0, brickMatter(src[4u * qi + 3u])); } else { v = i32(src[qi]); }
    d = min(d, max(abs(k), v));
  }
  dst[i] = u32(d);
}
`;

// Separable 5-tap blur of the brick map's emission over the brick grid, one
// axis per dispatch, one thread per brick (docs/webgpu.md H2): six passes
// x, y, z, x, y, z ping-ponging two buffers (pass 0 reads the brick map
// through an array<vec4f> view: .rgb is BrickInfo's emit); the last stores
// the light volume (last: its own pipeline, writing the texture). Its alpha
// stays 1: the WebGL build carried brickDist there for the realistic view
// (gfx/core.js BRICK_DIST_IN_LIGHT, a texture unit freed for gfx/meshCut.js),
// but brickDist is a storage buffer here (shaders/bindings.js binding 17),
// which every view reads, and storage buffers don't count against the 16
// sampled textures, so nothing reads the light volume's alpha.
export const BlurParams = uniformStruct('BlurParams', { axis: 'u32' });
export const LIGHT_BLUR_PASSES = 6;
export const blurFrag = (g, { last = false } = {}) => /* wgsl */ `
${prelude(g, { state: false })}
// tent-ish 5-tap weights (sum 1), and a gain that makes up for light spread past the box
const LIGHT_BLUR_GAIN: f32 = 1.15;
var<private> W: array<f32, 5> = array<f32, 5>(0.10, 0.22, 0.36, 0.22, 0.10);
${BlurParams.wgsl}
@group(3) @binding(1) var<uniform> P: BlurParams;
@group(2) @binding(0) var<storage, read> src: array<vec4f>;   // a texel per brick, brickId order
${last
    ? '@group(2) @binding(1) var dstTex: texture_storage_3d<rgba16float, write>;   // the light volume'
    : '@group(2) @binding(1) var<storage, read_write> dst: array<vec4f>;'}
${brickMain}
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let bc = brickCoord(i);
  var dir = vec3i(0);
  dir[P.axis] = 1;
  let hi = vec3i(BX, BY, BZ) - 1;
  var s = vec3f(0.0);
  for (var k = 0; k < 5; k++) {
    let q = bc + dir * (k - 2);
    if (any(q < vec3i(0)) || any(q > hi)) { continue; }   // skipped, not renormalised, as before
    s += src[brickId(q)].rgb * W[k];
  }
  ${last ? 'textureStore(dstTex, bc, vec4f(s * LIGHT_BLUR_GAIN, 1.0));' : 'dst[i] = vec4f(s * LIGHT_BLUR_GAIN, 1.0);'}
}
`;

// ---- the window's shift (docs/webgpu.md E: the derived passes keep their
// history across a window move instead of rebuilding every brick) ----
// A per-brick buffer of `words` words a brick follows its bricks: brick b
// takes brick b + shift's words (shift in bricks), out of place (src/derived.js
// copies the result back); bricks shifted in from outside get zeros. With
// age, the ages: the bricks shifted in start over with no history (age 0,
// AGE_SHIFTED), and the bricks within FIELDS_DILATE of either grid face on a
// moving axis re-age (age 0, their bits kept: a change the fold noted, AGE_CHANGED,
// still counts): the grid's edge clamps reach them differently now. Every
// other brick is a fixed point of inputs that moved with it, so it keeps its
// age word, its brick record and its final fields.
export const BrickShiftParams = uniformStruct('BrickShiftParams', { shift: 'vec3i', words: 'u32', age: 'u32' });
export const brickShiftFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
${BrickShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: BrickShiftParams;
@group(2) @binding(0) var<storage, read> src: array<u32>;
@group(2) @binding(1) var<storage, read_write> dst: array<u32>;
${brickMain}
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let bc = brickCoord(i);
  let q = bc + P.shift;
  let inside = brickInGrid(q);
  var qi = 0u;
  if (inside) { qi = brickId(q); }
  for (var k = 0u; k < P.words; k++) {
    var w = 0u;
    if (inside) { w = src[qi * P.words + k]; }
    dst[i * P.words + k] = w;
  }
  if (P.age != 0u) {
    if (!inside) {
      dst[i] = AGE_SHIFTED;
    } else {
      let edge = (bc < vec3i(FIELDS_DILATE)) | (bc >= vec3i(BX, BY, BZ) - FIELDS_DILATE);
      if (any(edge & (P.shift != vec3i(0)))) { dst[i] = dst[i] & ~AGE_MASK; }
    }
  }
}
`;

// The GI probes follow their bricks (the WebGL build's giShiftFrag): brick b
// takes the probe of b + shift (in bricks), clamped into the grid, so the
// probes shifted in take the light of the edge they came in by. Their
// history (four bands, rgba as two pack2x16float words, band k of brick id
// at k·NBRICKS + id; src/derived.js) into a scratch that derived.js copies
// back, and the four band textures from the same words, so the two agree.
export const GiShiftParams = uniformStruct('GiShiftParams', { shift: 'vec3i' });
export const giShiftFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${GiShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: GiShiftParams;
@group(2) @binding(0) var<storage, read> hist: array<vec2u>;
@group(2) @binding(1) var<storage, read_write> histOut: array<vec2u>;
@group(2) @binding(2) var gi0: texture_storage_3d<rgba16float, write>;
@group(2) @binding(3) var gi1: texture_storage_3d<rgba16float, write>;
@group(2) @binding(4) var gi2: texture_storage_3d<rgba16float, write>;
@group(2) @binding(5) var gi3: texture_storage_3d<rgba16float, write>;
fn band(k: u32, src: u32, dst: u32) -> vec4f {
  let w = hist[k * NBRICKS + src];
  histOut[k * NBRICKS + dst] = w;
  return vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
}
${brickMain}
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let bc = brickCoord(i);
  let q = brickId(clamp(bc + P.shift, vec3i(0), vec3i(BX, BY, BZ) - 1));
  textureStore(gi0, bc, band(0u, q, i));
  textureStore(gi1, bc, band(1u, q, i));
  textureStore(gi2, bc, band(2u, q, i));
  textureStore(gi3, bc, band(3u, q, i));
}
`;

// Test only (tools/derived-check.mjs, the brick bits decode test): the
// decoders of shaders/bindings.js on a list of info words, for the JS twins
// (unpackBrickInfo) to agree with: bits, air, gas share (f32 bits), matter.
export const brickBitsFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${brickInfoWGSL}
@group(2) @binding(0) var<storage, read> words: array<u32>;
@group(2) @binding(1) var<storage, read_write> decoded: array<vec4u>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&words)) { return; }
  let w = words[id.x];
  decoded[id.x] = vec4u(brickBits(w), brickAir(w), bitcast<u32>(brickGas(w)), select(0u, 1u, brickMatter(w)));
}
`;

// WEBGPU-STUB (docs/webgpu.md J3): region maps are gone (the derived kernels run over brick lists)
export function fieldRegionMapFrag() { throw new Error('fieldRegionMapFrag removed in the WebGPU port: docs/webgpu.md E (brick lists)'); }
// WEBGPU-STUB (docs/webgpu.md J3)
export function regionShareFrag() { throw new Error('regionShareFrag removed in the WebGPU port: docs/webgpu.md E (brick lists)'); }

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
  // the derived passes (src/derived.js)
  { name: 'age', kind: 'compute', code: ageFrag, dispatch: perBrick, layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_BUILD, DERIVED_LAYOUT.BOOK] },
  { name: 'dirty', kind: 'compute', code: dirtyFrag, dispatch: perBrick, layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.BOOK] },
  { name: 'dirtyArgs', kind: 'compute', code: dirtyArgsFrag, dispatch: () => [1, 1, 1], layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.BOOK] },
  { name: 'brick', kind: 'compute', code: brickFrag, dispatch: (g) => fold(gridDims(g).nbricks),
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, DERIVED_LAYOUT.BRICK] },
  { name: 'brickDist', kind: 'compute', code: brickDistFrag, dispatch: perBrick, layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
  { name: 'blur', kind: 'compute', code: (g) => blurFrag(g), dispatch: perBrick, layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
  { name: 'blurLast', kind: 'compute', code: (g) => blurFrag(g, { last: true }), dispatch: perBrick,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.LIGHT] },
  { name: 'brickShift', kind: 'compute', code: brickShiftFrag, dispatch: perBrick, windowed: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
  { name: 'giShift', kind: 'compute', code: giShiftFrag, dispatch: perBrick, windowed: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.GI_SHIFT] },
  { name: 'brickBits', kind: 'compute', code: brickBitsFrag, dispatch: () => [1, 1, 1], tool: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
];
