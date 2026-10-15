import {
  prelude, STATE_OPTS, LAYOUT, STAGE, BRICK, TILE, SUPER, SUPER_TEX, gridDims, atlasDims, stateLayout, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL,
} from './common.js';
import {
  AGE, FIELDS_DILATE, WORK_DILATE, FIELD_LAYOUT, LAYOUT_ENTRY, dirtyListsWGSL, listMainWGSL, FIELD_REACH, FIELD_SCRATCH_REACH,
} from './fields.js';
import { brickInfoWGSL, frameBindings, RENDER_LAYOUT } from './bindings.js';
import { SHADOW_PAD } from './gfx/lighting.js';
import { occupancyWords } from './occupancy.js';
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
// Shared by native external sources: exactly the brush's swept/grown metric.
export const strokeDistanceWGSL = `
fn strokeDistance(position: vec3f, center: vec3f, end: vec3f, grow: vec3f, shape: u32) -> f32 {
  var d=position-center;let segment=end-center;
  d-=segment*clamp(dot(d,segment)/max(dot(segment,segment),1e-6),0.0,1.0);
  d=max(abs(d)-grow,vec3f(0));
  if(shape==0u) { return length(d); }return max(d.x,max(d.y,d.z));
}
`;
const brushToolsWGSL = /* wgsl */ `
${strokeDistanceWGSL}
const MIX_BITS: u32 = ${MIX_BITS}u;
const MIX_MASK: u32 = ${(1 << MIX_BITS) - 1}u;
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
  return strokeDistance(vec3f(p)+0.5,P.center,P.end,P.grow,P.shape);
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
// a cell's index in its block (x, then y, then z bits)
fn mixIndex(l: vec3i) -> i32 { return l.x | (l.y << MIX_BITS) | (l.z << (2u * MIX_BITS)); }
fn mixCell(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let fs = pcg(P.frame * LCG_MUL + SALT_MIX);   // this paint's block offset
  let off = vec3i(vec3u(fs, fs >> MIX_BITS, fs >> (2u * MIX_BITS)) & vec3u(MIX_MASK));
  let w = p + H.origin + off;              // world cell, so blocks don't follow the window
  let l = w & vec3i(i32(MIX_MASK));        // the cell in its block (two's complement: fine below 0)
  let base = w - l;
  let hs = seedWorld(base, P.frame, SALT_MIX);
  let m = vec3i(vec3u(hs, hs >> MIX_BITS, hs >> (2u * MIX_BITS)) & vec3u(MIX_MASK));   // the block's mask
  let lq = l ^ m;
  let q = p + lq - l;
  if (all(m == vec3i(0)) || !inGrid(q) || !inBrush(p) || !inBrush(q)) { return; }
  let qa = fetchA(q);
  let id = eid(a);
  if (!isLooseOrGas(id) || KIND(eid(qa)) != KIND(id)) { return; }
  var ps = seedWorld(base + select(lq, l, mixIndex(l) < mixIndex(lq)), P.frame, SALT_MIX_PAIR);
  if (rnd(&ps) >= TOOL_MIX_SWAP) { return; }
  ownLegacy(slotOf(p)); // a successful Mix swap replaces the selected cell
  *oA = qa;
  *oB = vec4f(fetchB(q).xyz, b.w);   // the cell moves with its velocity; the air's pressure stays
}
`;

// The update editMain calls (shaders/common.js): fn update(p, a, b, oA, oB).
export const paintUpdateWGSL = /* wgsl */ `
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

  var rs = seed3(p, P.frame, SALT_PAINT);
  let id = eid(a);
  if (P.filter_ >= 0 && id != P.filter_) { return; }
  // TPT's PropertyTool sets particles only (SetProperty skips empty pixels); pressure is the air's own
  if (tool == T_PROP && id == E_EMPTY && P.prop != PROP_PRESSURE) { return; }
  let propErases = tool == T_PROP && P.prop == PROP_TYPE && P.propValue == f32(E_EMPTY);   // TPT: type NONE kills the particle

  if (tool >= 0 && P.del == 0u) {
    if (id == tool) {
      if (P.replace != 0u) { ownLegacy(slotOf(p)); }
      return;
    }
    if (id != E_EMPTY && P.replace == 0u) { return; }
    if (rnd(&rs) > SPAWNDENS(tool) * P.rate) { return; }
    ownLegacy(slotOf(p));
    let T = SPAWNT(tool);
    let ctype = select(0.0, f32(E_STONE), tool == E_LAVA);
    *oA = vec4f(f32(tool), T, SPAWNLIFE(tool), ctype + rnd(&rs) * SEED_MAX);
    let vy = select(0.0, SPAWN_DROP_V, isLoose(tool));
    *oB = vec4f(0.0, vy, 0.0, b.w);
  } else if (tool == T_ERASE || tool >= 0 || propErases) {   // (tool >= 0 here: specific delete)
    ownLegacy(slotOf(p));
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
    else if (P.prop == PROP_TYPE) {
      ownLegacy(slotOf(p));
      if (i32(v + 0.5) != id) { (*oA).w = physicalCtype(id, a.w) + fract(a.w); }
      (*oA).x = v;
    }
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
export const atlasIndexWGSL = (g) => {
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
// FIELDS, the empty-space distance around the bricks whose matter bit flipped
// and the glow volume around those whose light changed (REGIONS below).
export const BRICK_DIST_MAX = 8;          // bricks; also the half-width of each pass's window
// WEBGPU-STUB (docs/webgpu.md J3): brickDist holds the distance itself, a u32 per brick (bindings.js brickDistAt).
export const BRICK_DIST_SCALE = null;
export const AGE_MAX = AGE.MAX;           // frames an age counts up to
export { FIELDS_DILATE, WORK_DILATE };

const E = LAYOUT_ENTRY;
// Group 2 of the derived kernels (src/derived.js makes them; the field
// kernels' are shaders/fields.js FIELD_LAYOUT):
//   BOOK      the ages and the lists buffer (age, dirty, dirtyArgs)
//   BRICK     the FIELDS list, the three final fields (sampled), the brick map
//             and the regions' boxes (the changes it notes)
//   PAIR      a source and a destination: a brick buffer's shift; the shadow
//             map's tiles (the lists, brickDist's buffer)
//   DIST      a source, a destination and the regions: brickDist's axes, the
//             light blur
//   LIGHT     the light blur's last pass: the source, the light volume, the regions
//   BOXES     the regions alone (boxArgs)
//   GI_SHIFT  the GI probes' history, its shifted copy and their four textures
//   GI_SELECT the ages, the brick map, giSrc (its lists) and the lists buffer
//             (GI_NEAR; the GI's indirect arguments: shaders/gi.js giSelect, giArgs)
export const DERIVED_LAYOUT = {
  BOOK: [E.rw(0), E.rw(1)],
  BRICK: [E.ro(0), E.tex3d(1), E.tex3d(2), E.tex3d(3), E.rw(4), E.rw(5)],
  PAIR: FIELD_LAYOUT.PAIR,
  DIST: [E.ro(0), E.rw(1), E.ro(2)],
  LIGHT: [E.ro(0), E.out3d(1), E.ro(2)],
  BOXES: [E.rw(0)],
  GI_SHIFT: [E.ro(0), E.rw(1), E.out3d(2), E.out3d(3), E.out3d(4), E.out3d(5)],
  GI_SELECT: [E.ro(0), E.ro(1), E.rw(2), E.rw(3)],
};

const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const brickMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {`;

// Appends entries to a list from a whole workgroup (docs/webgpu.md D4): the
// workgroup counts its entries, one thread adds them to the list's counter
// (word count of buffer buf, atomic<u32>s), then each writes its own at word
// list + its place. Uniform control flow only (barriers). name: the function's.
export const appendWGSL = (name, buf, count, list) => /* wgsl */ `
var<workgroup> ${name}Count: atomic<u32>;
var<workgroup> ${name}Base: u32;
fn ${name}(on: bool, entry: u32, li: u32) {
  var mine = 0u;
  if (on) { mine = atomicAdd(&${name}Count, 1u); }
  workgroupBarrier();
  if (li == 0u) {
    ${name}Base = atomicAdd(&${buf}[${count}], atomicLoad(&${name}Count));
    atomicStore(&${name}Count, 0u);
  }
  let base = workgroupUniformLoad(&${name}Base);
  if (on) { atomicStore(&${buf}[${list} + base + mine], entry); }
}`;

// ---- the brick-resolution passes' regions (docs/scaling.md D9) ----
// brickDist and the glow volume are separable passes over the brick grid
// with a known reach, so they run over the box of bricks a change can reach,
// not every brick. The brick kernel notes the box of the bricks whose matter
// bit flipped (DIST: brickDist reads only that bit) and of those whose light
// changed (LIGHT), comparing each brick's record with what it held; boxArgs
// turns them into each pass's region (lo, size, count) and its indirect
// arguments, and empties them for the next frame. full (a grid's first
// frame, a window shift, sim.incremental = false) makes every region the grid.
//   brickDist: each axis into a buffer of its own (distX, distY, then brickDist,
//     src/derived.js), which holds its values everywhere, so an axis's region
//     is where its output may change: the box grown by BRICK_DIST_MAX along the
//     axes done so far.
//   light: the blur's six passes ping-pong two scratch buffers, so a pass
//     covers every brick the passes after it read: the last its own output's
//     reach (2 a pass along each of its axes), each earlier one that and the
//     next pass's 2 along its axis.
// Exact: each region holds every brick whose output may change, and every
// value a pass reads there was written this frame or holds what it would be.
export const DIST_PASSES = 3;
export const LIGHT_BLUR_PASSES = 6;
const LIGHT_TAP_REACH = 2;   // blurFrag's 5 taps
const axisReach = (axis, r) => [0, 1, 2].map((a) => (a === axis ? r : 0));
const addReach = (a, b) => a.map((x, i) => x + b[i]);
const DIST_REACH = [0, 1, 2].map((k) => [0, 1, 2].map((a) => (a <= k ? BRICK_DIST_MAX : 0)));
const LIGHT_REACH = (() => {
  const axis = (i) => i % 3;
  const r = [];
  r[LIGHT_BLUR_PASSES - 1] = [0, 0, 0];
  for (let i = 0; i < LIGHT_BLUR_PASSES; i++) r[LIGHT_BLUR_PASSES - 1] = addReach(r[LIGHT_BLUR_PASSES - 1], axisReach(axis(i), LIGHT_TAP_REACH));
  for (let i = LIGHT_BLUR_PASSES - 2; i >= 0; i--) r[i] = addReach(r[i + 1], axisReach(axis(i + 1), LIGHT_TAP_REACH));
  return r;
})();
// The regions in order: brickDist's axes (0-2), then the light blur's passes (3-8).
export const REGIONS = { DIST: 0, LIGHT: DIST_PASSES, count: DIST_PASSES + LIGHT_BLUR_PASSES, reach: [...DIST_REACH, ...LIGHT_REACH] };
// The boxes buffer (src/derived.js), in u32 words: the two change boxes (lo
// x, y, z then hi x, y, z; empty while lo > hi), each region's lo, size and
// count (8 words), each region's indirect arguments (4 words).
export const BOXES = { DIST: 0, LIGHT: 8, REGION: 16, ARGS: 16 + 8 * REGIONS.count, words: 16 + 12 * REGIONS.count };
const boxesWGSL = /* wgsl */ `
const BOX_DIST: u32 = ${BOXES.DIST}u;
const BOX_LIGHT: u32 = ${BOXES.LIGHT}u;
const BOX_REGION: u32 = ${BOXES.REGION}u;
const BOX_ARGS: u32 = ${BOXES.ARGS}u;
const BOX_EMPTY: u32 = 0xffffffffu;   // a box's lo while it holds nothing`;
// main() of a pass over region P.region: a thread per brick of it. Declares bc
// (the brick) and i (its number). A thread past the region's end returns.
const regionMainWGSL = /* wgsl */ `${brickMain}
  let t = foldThread(wg, nwg, li);
  let at = BOX_REGION + 8u * P.region;
  let size = vec3u(boxes[at + 3u], boxes[at + 4u], boxes[at + 5u]);
  if (t >= boxes[at + 6u]) { return; }
  let bc = vec3i(vec3u(boxes[at], boxes[at + 1u], boxes[at + 2u]) + vec3u(t % size.x, (t / size.x) % size.y, t / (size.x * size.y)));
  let i = brickId(bc);`;
// boxArgs: one thread. full: every region is the grid.
export const BoxParams = uniformStruct('BoxParams', { full: 'bool' });
export const boxArgsFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${boxesWGSL}
${foldArgsWGSL}
${BoxParams.wgsl}
@group(3) @binding(1) var<uniform> P: BoxParams;
@group(2) @binding(0) var<storage, read_write> boxes: array<u32>;
var<private> REACH: array<vec3i, ${REGIONS.count}> = array<vec3i, ${REGIONS.count}>(${REGIONS.reach.map((r) => `vec3i(${r.join(', ')})`).join(', ')});
@compute @workgroup_size(1)
fn main() {
  let top = vec3i(BX, BY, BZ) - 1;
  for (var k = 0u; k < ${REGIONS.count}u; k++) {
    let box = select(BOX_LIGHT, BOX_DIST, k < ${REGIONS.LIGHT}u);
    let lo = vec3u(boxes[box], boxes[box + 1u], boxes[box + 2u]);
    let hi = vec3u(boxes[box + 3u], boxes[box + 4u], boxes[box + 5u]);
    var a = vec3i(0);
    var b = top;
    var n = 0u;
    if (P.full != 0u) {
      n = NBRICKS;
    } else if (all(lo <= hi)) {
      a = max(vec3i(lo) - REACH[k], vec3i(0));
      b = min(vec3i(hi) + REACH[k], top);
      let s = vec3u(b - a + 1);
      n = s.x * s.y * s.z;
    }
    let at = BOX_REGION + 8u * k;
    boxes[at] = u32(a.x);
    boxes[at + 1u] = u32(a.y);
    boxes[at + 2u] = u32(a.z);
    boxes[at + 3u] = u32(b.x - a.x + 1);
    boxes[at + 4u] = u32(b.y - a.y + 1);
    boxes[at + 5u] = u32(b.z - a.z + 1);
    boxes[at + 6u] = n;
    let args = foldArgs((n + 63u) / 64u);
    boxes[BOX_ARGS + 4u * k] = args.x;
    boxes[BOX_ARGS + 4u * k + 1u] = args.y;
    boxes[BOX_ARGS + 4u * k + 2u] = args.z;
  }
  for (var c = 0u; c < 3u; c++) {
    boxes[BOX_DIST + c] = BOX_EMPTY;
    boxes[BOX_DIST + 3u + c] = 0u;
    boxes[BOX_LIGHT + c] = BOX_EMPTY;
    boxes[BOX_LIGHT + 3u + c] = 0u;
  }
}
`;

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
// From the same neighbourhood, the brick's masks for the field passes'
// coverage (shaders/fields.js COVER, dirtyLists): which of its 3³ neighbours
// are EMA bricks, and which are FIELDS bricks (an EMA brick within one of
// them: the EMA bricks over the 5³ neighbourhood, as rows of 5 bits along x,
// dilated a brick along each axis in turn); and GI_NEAR, a brick within
// GI_NEAR_DILATE that changed within GI_RECENT frames (shaders/gi.js giSelect).
// Written for every brick (a list's reader looks at its own bricks only).
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
const ROWS: i32 = 2 * WORK_DILATE + 1;   // the neighbourhood's side, in bricks
${brickMain}
  let b = foldThread(wg, nwg, li);
  var near = WORK_DILATE + 1;
  if (b < NBRICKS) {
    let bc = brickCoord(b);
    // A recent centre proves all three lists, GI_NEAR and the entire FIELDS
    // mask. Only the 3³ EMA mask still needs neighbours, not the 5³ dilation.
    if ((age[b] & AGE_MASK) < min(EMA_SETTLE, GI_RECENT) && FIELDS_DILATE >= 1) {
      near = 0;
      var em = 0u;
      for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
          for (var x = -1; x <= 1; x++) {
            let q = bc + vec3i(x, y, z);
            if (!brickInGrid(q)) { continue; }
            if ((age[brickId(q)] & AGE_MASK) < EMA_SETTLE) {
              em |= 1u << u32((x + 1) + 3 * (y + 1) + 9 * (z + 1));
            }
          }
        }
      }
      atomicStore(&dlist[DL_EMASK + b], em | GI_NEAR);
      atomicStore(&dlist[DL_FMASK + b], (1u << 27u) - 1u);
    } else {
    var rows: array<u32, ROWS * ROWS>;   // EMA bricks: row (y, z) of the neighbourhood, bit x
    var gi = false;
    for (var z = -WORK_DILATE; z <= WORK_DILATE; z++) {
      for (var y = -WORK_DILATE; y <= WORK_DILATE; y++) {
        var row = 0u;
        for (var x = -WORK_DILATE; x <= WORK_DILATE; x++) {
          let q = bc + vec3i(x, y, z);
          if (!brickInGrid(q)) { continue; }
          let a = age[brickId(q)] & AGE_MASK;
          if (a < EMA_SETTLE) {
            near = min(near, max(abs(x), max(abs(y), abs(z))));
            row |= 1u << u32(x + WORK_DILATE);
          }
          if (a < GI_RECENT && max(abs(x), max(abs(y), abs(z))) <= GI_NEAR_DILATE) { gi = true; }
        }
        rows[(y + WORK_DILATE) + ROWS * (z + WORK_DILATE)] = row;
      }
    }
    // FIELDS bricks: the EMA bricks dilated a brick along x, then y, then z
    // (bits outside a row's ROWS fall off; the grid's edges are outside every row)
    let side = (1u << u32(ROWS)) - 1u;
    var dx: array<u32, ROWS * ROWS>;
    var dy: array<u32, ROWS * ROWS>;
    for (var i = 0; i < ROWS * ROWS; i++) { let r = rows[i]; dx[i] = (r | (r << 1u) | (r >> 1u)) & side; }
    for (var z = 0; z < ROWS; z++) {
      for (var y = 0; y < ROWS; y++) {
        var r = dx[y + ROWS * z];
        if (y > 0) { r |= dx[y - 1 + ROWS * z]; }
        if (y < ROWS - 1) { r |= dx[y + 1 + ROWS * z]; }
        dy[y + ROWS * z] = r;
      }
    }
    // the masks of the 3³ around the brick, 3 bits (x) to a row (y, z)
    var em = 0u;
    var fm = 0u;
    let mid = WORK_DILATE - 1;   // offset -1, in the rows
    for (var z = 0; z < 3; z++) {
      for (var y = 0; y < 3; y++) {
        let k = (mid + y) + ROWS * (mid + z);
        let at = u32(3 * y + 9 * z);
        em |= ((rows[k] >> u32(mid)) & 7u) << at;
        var f = dy[k];
        if (mid + z > 0) { f |= dy[k - ROWS]; }
        if (mid + z < ROWS - 1) { f |= dy[k + ROWS]; }
        fm |= ((f >> u32(mid)) & 7u) << at;
      }
    }
    atomicStore(&dlist[DL_EMASK + b], em | select(0u, GI_NEAR, gi));
    atomicStore(&dlist[DL_FMASK + b], fm);
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
// ([ceil(n / y), y, 1], y = ceil(n / 65535)): a workgroup per entry; and
// FIELDS's a thread per entry (DL_THREADS).
export const foldArgsWGSL = /* wgsl */ `
const MAX_WG: u32 = ${MAX_WORKGROUPS}u;
// n workgroups as src/gpu/kernels.js fold() makes them
fn foldArgs(n: u32) -> vec3u {
  let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
  return vec3u((n + y - 1u) / y, y, 1u);
}`;
export const dirtyArgsFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
${foldArgsWGSL}
@group(2) @binding(1) var<storage, read_write> dlist: array<atomic<u32>>;
fn putArgs(at: u32, a: vec3u) {
  atomicStore(&dlist[at], a.x);
  atomicStore(&dlist[at + 1u], a.y);
  atomicStore(&dlist[at + 2u], a.z);
}
@compute @workgroup_size(1)
fn main() {
  for (var l = 0u; l < 3u; l++) {
    let n = atomicLoad(&dlist[DL_COUNT + l]);
    atomicStore(&dlist[DL_LAST + l], n);
    atomicStore(&dlist[DL_COUNT + l], 0u);
    putArgs(DL_ARGS + 4u * l, foldArgs(n));
    if (l == LIST_FIELDS) { putArgs(DL_THREADS, foldArgs((n + 63u) / 64u)); }
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
// the regions' change boxes (REGIONS): the bricks whose matter bit flipped, and whose light changed
@group(2) @binding(5) var<storage, read_write> boxes: array<atomic<u32>>;
${boxesWGSL}
fn noteChange(box: u32, b: vec3i) {
  for (var c = 0u; c < 3u; c++) {
    atomicMin(&boxes[box + c], u32(b[c]));
    atomicMax(&boxes[box + 3u + c], u32(b[c]));
  }
}
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
    let id = eid(fetchA(q));
    if (RCLASS(id) != R_OPAQUE && id != E_CRYSTAL) { n += 1.0; }
  }
  return n;
}

var<workgroup> wgEm: array<vec4f, 64>;    // emission (rgb), summed
var<workgroup> wgMax: array<vec4f, 64>;   // surface field, opaque, thin mask, media field
var<workgroup> wgAir: array<vec4f, 64>;   // |pressure|, speed² (core cells), liquid-interior violation (all cells)
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
  if (!isGasLike(id) && RCLASS(id) != R_LIQUID && RCLASS(id) != R_GLASS) { opaque = 1.0; }
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
  else if (!isGasLike(id) && (a.y > INCAND_T0 || luminous(id) || sparkLive(id, floor(a.w)) || lampLit(id, floor(a.w)))) {
    // small sources shed more (gfx/materials.js SHED); a live conductor or a
    // lit lamp too (LAMP_ROOM_GAIN) (src/electricity.js)
    let ce = cellEmission(id, a.y, floor(a.w)) * SHED(id) + sparkEmit(id, floor(a.w)) * select(1.0, LAMP_ROOM_GAIN, id == E_LAMP);
    if (dot(ce, ce) > 0.0) {
      var f = 1.0;
      // Crystal's glass optics must not remove its exposed-face light budget.
      if (RCLASS(id) == R_OPAQUE || id == E_CRYSTAL) { f = openFaces(p) * GLOW_FACE_GAIN; }
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
  // Reuse the existing max reduction and texel load: no new resource/pass.
  // A safety margin from the isovalue covers filtering roundoff. This is a
  // certificate, not a surface approximation: uncertified bricks march normally.
  air.z = max(1.0 - sf.x, max(sf.y, max(sf.z, sf.w)));
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
             | select(0u, BRICK_THIN, mx.z > 0.0) | select(0u, BRICK_MIXED, mixed)
             | select(0u, BRICK_LIQUID_INTERIOR, wgAir[0].z < 0.499);
    var info = brickInfoWord(0u, flags, 0u, false);
    if (atomicLoad(&wgOcc) != 0u || hasSurf || hasMedia) { info = brickInfoWord(bits, flags, atomicLoad(&wgGas), true); }
    let rec = BrickInfo(wgEm[0].xyz / f32(BS * BS * BS), info);
    let was = brick[b];
    if (brickMatter(was.info) != brickMatter(rec.info)) { noteChange(BOX_DIST, brickCoord(b)); }
    if (any(was.emit != rec.emit)) { noteChange(BOX_LIGHT, brickCoord(b)); }
    brick[b] = rec;
  }
}
`;

// Empty-space distance: for each brick, the Chebyshev distance (in bricks) to
// the nearest brick the realistic view must visit (a matter brick), capped at
// BRICK_DIST_MAX. Every brick within (distance - 1) of an empty one is empty
// too, so a ray can cross that whole cube in one step instead of brick by
// brick (gfx/core.js skipEmpty). L∞ distance is separable: three passes, each
// a minimum over a 1D window along one axis (axis 0 reads the brick map, the
// others the distance so far). One thread per brick of the axis's region
// (REGIONS: region = axis).
export const BrickDistParams = uniformStruct('BrickDistParams', { axis: 'u32', region: 'u32' });
export const brickDistFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${brickInfoWGSL}
${boxesWGSL}
${BrickDistParams.wgsl}
@group(3) @binding(1) var<uniform> P: BrickDistParams;
@group(2) @binding(0) var<storage, read> src: array<u32>;   // axis 0: the brick map (4 words a brick), else distances
@group(2) @binding(1) var<storage, read_write> dst: array<u32>;
@group(2) @binding(2) var<storage, read> boxes: array<u32>;
const DIST_MAX: i32 = ${BRICK_DIST_MAX};
${regionMainWGSL}
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
// sampled textures, so nothing reads the light volume's alpha. One thread
// per brick of the pass's region (REGIONS: region = REGIONS.LIGHT + pass).
export const BlurParams = uniformStruct('BlurParams', { axis: 'u32', region: 'u32' });
export const blurFrag = (g, { last = false } = {}) => /* wgsl */ `
${prelude(g, { state: false })}
${boxesWGSL}
// tent-ish 5-tap weights (sum 1), and a gain that makes up for light spread past the box
const LIGHT_BLUR_GAIN: f32 = 1.15;
var<private> W: array<f32, 5> = array<f32, 5>(0.10, 0.22, 0.36, 0.22, 0.10);
${BlurParams.wgsl}
@group(3) @binding(1) var<uniform> P: BlurParams;
@group(2) @binding(0) var<storage, read> src: array<vec4f>;   // a texel per brick, brickId order
${last
    ? '@group(2) @binding(1) var dstTex: texture_storage_3d<rgba16float, write>;   // the light volume'
    : '@group(2) @binding(1) var<storage, read_write> dst: array<vec4f>;'}
@group(2) @binding(2) var<storage, read> boxes: array<u32>;
${regionMainWGSL}
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

// ---- the sun's shadow map, by tiles (src/derived.js shadowTiles) ----
// The map (shaders/render.js shadowFrag) traces a ray per texel from the sun
// through the box. A texel's ray reads the cells, the brick map and the final
// fields along it, so it changes only when a brick it crosses does: the
// FIELDS bricks hold every such change (the state's, the fields', the brick
// map's), give or take brickDist's empty-space skips, which land a ray on the
// same cells. So the map is re-traced in tiles (SHADOW_TILE texels square,
// the shadow kernel's workgroup): those the FIELDS bricks project onto, each
// brick's box grown by SHADOW_MARGIN cells (the fields' trilinear and cubic
// samples reach into the bricks around) and a texel. Every tile when the
// map's key changes (the sun, its size, the window's origin, the far field's
// switch: shadowList compares FrameUniforms and the header with what the last
// list was made for) or src/derived.js says so (full: a derived frame went
// without a map since the last, a far field attached, sim.incremental off).
// With a world's far field (FrameUniforms.far) a band of rows each frame too
// (one in SHADOW_SLICE): its casters change as the world streams in, not with
// the window's bricks.
//   shadowMark  a thread per FIELDS brick (the lists' DL_THREADS): its tiles' bits
//   shadowList  a thread per tile: the list of those to trace; clears the bits
//   shadowArgs  one thread: the list's length, the indirect arguments, the key
// It all lives in brickDist's buffer after its NBRICKS distances and the
// march's occupancy (shaders/occupancy.js; shadowTileWords): the shadow kernel already binds that buffer (L.LIGHTING
// binding 17) and reads the list there (shadowTilesWGSL), so no layout changes.
export const SHADOW_TILE = 8;         // texels a tile's side: shaders/render.js SHADOW_WORKGROUP
const SHADOW_RES_MAX = 1024;          // texels a side at most (shaders/render.js shadowRes)
export const SHADOW_TILES_MAX = (SHADOW_RES_MAX / SHADOW_TILE) ** 2;
const SHADOW_MARGIN = 2;              // cells: a cubic sample's reach
export const SHADOW_SLICE = 16;       // with a far field, a row of tiles in this many each frame
const SHADOW_KEY_WORDS = 8;           // sun xyz, res, origin xyz, far
export function shadowTileWords(g) {
  // (after the distances and the march's occupancy, shaders/occupancy.js)
  const at = occupancyWords(g), key = at + 4, args = key + SHADOW_KEY_WORDS, bits = args + 4, list = bits + SHADOW_TILES_MAX / 32;
  return { last: at, count: at + 1, key, args, bits, list, words: list + SHADOW_TILES_MAX };
}
/** The shadow kernel's view of the tiles (shaders/render.js shadowFrag): the list's length and entries in brickDist's buffer. */
export const shadowTilesWGSL = (g) => {
  const w = shadowTileWords(g);
  return /* wgsl */ `
// ---- the tiles to trace (shaders/passes.js shadowTileWords; src/derived.js shadowTiles) ----
const SH_TILE: u32 = ${SHADOW_TILE}u;
const SH_LAST: u32 = ${w.last}u;    // the list's length
const SH_LIST: u32 = ${w.list}u;    // entries: tile x | tile y << 16
// the corner texel of the list's tile e; false past the list's end
fn shadowTileAt(e: u32, corner: ptr<function, vec2u>) -> bool {
  if (e >= brickDist[SH_LAST]) { return false; }
  let t = brickDist[SH_LIST + e];
  *corner = vec2u(t & 0xffffu, t >> 16u) * SH_TILE;
  return true;
}`;
};
// res: the map's texels a side (FrameUniforms.shadowRes); full: every tile;
// phase: the far field's band of rows this frame (a frame count % SHADOW_SLICE).
export const ShadowTileParams = uniformStruct('ShadowTileParams', { res: 'u32', full: 'bool', phase: 'u32' });
const shadowBookWGSL = (g) => {
  const w = shadowTileWords(g);
  return /* wgsl */ `
${frameBindings()}
${ShadowTileParams.wgsl}
@group(3) @binding(1) var<uniform> P: ShadowTileParams;
const SH_TILE: u32 = ${SHADOW_TILE}u;
const SH_LAST: u32 = ${w.last}u;
const SH_COUNT: u32 = ${w.count}u;
const SH_KEY: u32 = ${w.key}u;
const SH_ARGS: u32 = ${w.args}u;
const SH_BITS: u32 = ${w.bits}u;
const SH_LIST: u32 = ${w.list}u;
const SH_MARGIN: f32 = ${SHADOW_MARGIN.toFixed(1)};
const SH_SLICE: u32 = ${SHADOW_SLICE}u;
const SH_PAD: f32 = ${SHADOW_PAD.toFixed(1)};   // shaders/gfx/lighting.js SHADOW_PAD
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read_write> sh: array<atomic<u32>>;   // brickDist's buffer
// the map's key as FrameUniforms and the header have it now
fn shadowKey() -> array<u32, ${SHADOW_KEY_WORDS}> {
  let o = bitcast<vec3u>(H.origin);
  return array<u32, ${SHADOW_KEY_WORDS}>(bitcast<u32>(FU.sun.x), bitcast<u32>(FU.sun.y), bitcast<u32>(FU.sun.z), P.res, o.x, o.y, o.z, FU.far);
}`;
};
export const shadowMarkFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${dirtyListsWGSL(g)}
${shadowBookWGSL(g)}
${brickMain}
  let e = foldThread(wg, nwg, li);
  if (e >= dlist[DL_LAST + LIST_FIELDS]) { return; }
  let bc = brickCoord(dlist[LIST_FIELDS * NBRICKS + e]);
  // the map's basis (shaders/gfx/lighting.js sunBasis)
  let grid = vec3f(f32(NX), f32(NY), f32(NZ));
  var c = grid * 0.5;
  let R = 0.5 * length(grid) + SH_PAD;
  let u = normalize(cross(vec3f(0.0, 1.0, 0.0), FU.sun));
  let v = cross(FU.sun, u);
  let res = f32(P.res);
  let T = 2.0 * R / res;
  let o = vec3f(H.origin);
  let ot = vec2f(dot(o, u), dot(o, v)) / T;
  let snap = (round(ot) - ot) * T;
  c += snap.x * u + snap.y * v;
  // the texels whose rays cross the brick's box, grown: its corners' span, and a texel
  let lo = vec3f(bc * BS) - SH_MARGIN;
  let hi = vec3f(bc * BS + BS) + SH_MARGIN;
  var fmin = vec2f(1e30);
  var fmax = vec2f(-1e30);
  for (var k = 0u; k < 8u; k++) {
    let q = select(lo, hi, (vec3u(k) & vec3u(1u, 2u, 4u)) != vec3u(0u)) - c;
    let f = (vec2f(dot(q, u), dot(q, v)) / R * 0.5 + 0.5) * res - 0.5;   // texel i's ray is at i
    fmin = min(fmin, f);
    fmax = max(fmax, f);
  }
  let top = vec2i(i32(P.res) - 1);
  let t0 = vec2u(clamp(vec2i(floor(fmin)) - 1, vec2i(0), top)) / SH_TILE;
  let t1 = vec2u(clamp(vec2i(ceil(fmax)) + 1, vec2i(0), top)) / SH_TILE;
  let side = P.res / SH_TILE;
  for (var y = t0.y; y <= t1.y; y++) {
    for (var x = t0.x; x <= t1.x; x++) {
      let t = y * side + x;
      atomicOr(&sh[SH_BITS + (t >> 5u)], 1u << (t & 31u));
    }
  }
}
`;
export const shadowListFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${shadowBookWGSL(g)}
${appendWGSL('appendTile', 'sh', 'SH_COUNT', 'SH_LIST')}
${brickMain}
  let t = foldThread(wg, nwg, li);
  let side = P.res / SH_TILE;
  var key = shadowKey();
  var full = P.full != 0u;
  for (var k = 0u; k < ${SHADOW_KEY_WORDS}u; k++) { full = full || atomicLoad(&sh[SH_KEY + k]) != key[k]; }
  var on = false;
  var entry = 0u;
  if (t < side * side) {
    let x = t % side;
    let y = t / side;
    let marked = ((atomicLoad(&sh[SH_BITS + (t >> 5u)]) >> (t & 31u)) & 1u) != 0u;
    let band = FU.far != 0u && y % SH_SLICE == P.phase;
    on = full || marked || band;
    entry = x | (y << 16u);
  }
  appendTile(on, entry, li);
  // (every thread has read its bit before the append's barrier; a word's 32 tiles are this workgroup's)
  if (t < side * side && (t & 31u) == 0u) { atomicStore(&sh[SH_BITS + (t >> 5u)], 0u); }
}
`;
export const shadowArgsFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${shadowBookWGSL(g)}
${foldArgsWGSL}
@compute @workgroup_size(1)
fn main() {
  let n = atomicLoad(&sh[SH_COUNT]);
  atomicStore(&sh[SH_LAST], n);
  atomicStore(&sh[SH_COUNT], 0u);
  let a = foldArgs(n);
  atomicStore(&sh[SH_ARGS], a.x);
  atomicStore(&sh[SH_ARGS + 1u], a.y);
  atomicStore(&sh[SH_ARGS + 2u], a.z);
  var key = shadowKey();
  for (var k = 0u; k < ${SHADOW_KEY_WORDS}u; k++) { atomicStore(&sh[SH_KEY + k], key[k]); }
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
  // (the layouts made after DERIVED_LAYOUT's are named as src/derived.js names them: preload.js's table predates them)
  { name: 'boxArgs', kind: 'compute', code: boxArgsFrag, dispatch: () => [1, 1, 1], layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.BOXES],
    layoutNames: [null, null, 'DERIVED_BOXES'] },
  { name: 'brickDist', kind: 'compute', code: brickDistFrag, dispatch: perBrick, layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.DIST],
    layoutNames: [null, null, 'DERIVED_DIST'] },
  { name: 'blur', kind: 'compute', code: (g) => blurFrag(g), dispatch: perBrick, layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.DIST],
    layoutNames: [null, null, 'DERIVED_DIST'] },
  { name: 'blurLast', kind: 'compute', code: (g) => blurFrag(g, { last: true }), dispatch: perBrick,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.LIGHT] },
  // the shadow map's tiles (src/derived.js shadowTiles): views with shadows
  ...[['shadowMark', shadowMarkFrag, perBrick], ['shadowList', shadowListFrag, (g) => fold(Math.ceil(SHADOW_TILES_MAX / 64))],
    ['shadowArgs', shadowArgsFrag, () => [1, 1, 1]]].map(([name, code, dispatch]) => ({
    name, kind: 'compute', code, dispatch, params: ShadowTileParams, layouts: () => [RENDER_LAYOUT.FRAME, 'EMPTY', DERIVED_LAYOUT.PAIR],
    layoutNames: ['FRAME', null, 'DERIVED_PAIR'],
  })),
  { name: 'brickShift', kind: 'compute', code: brickShiftFrag, dispatch: perBrick, windowed: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
  { name: 'giShift', kind: 'compute', code: giShiftFrag, dispatch: perBrick, windowed: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.GI_SHIFT] },
  { name: 'brickBits', kind: 'compute', code: brickBitsFrag, dispatch: () => [1, 1, 1], tool: true,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', DERIVED_LAYOUT.PAIR] },
];
