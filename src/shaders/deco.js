import { prelude, LAYOUT, STAGE, gridDims } from './common.js';
import { slabGLSL } from './window.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// The decoration layer's kernels (src/deco.js runs them): The Powder Toy's
// "deco", a colour painted onto matter that travels with it.
//
// Storage: one u32 per cell, RGBA8 (r in the low byte, as pack4x8unorm packs
// it), in the state's slot order (docs/webgpu.md C2): (r, g, b) the colour in
// sRGB and a its strength, TPT's dcolour (src/simulation/Particle.h: one
// 0xAARRGGBB word per particle). 0 is "nothing decorated". It is a plane of the
// move's moveSrc buffer (src/sim.js decoPlane), so the move can carry it
// within its eight storage buffers (docs/webgpu.md C4, Sync log S3), and there
// is one of it: the WebGL layer ping-ponged two textures only because a pass
// couldn't write the texture it read. The simulation never reads it; it only
// follows the cells:
//   - the move: every cell takes the decoration of the cell its content came
//     from, the block's own 8 words permuted with its cells, in the move
//     kernel itself (shaders/move.js; WebGL: decoGatherFrag, a pass after the
//     gather). A cell whose content is air loses it, and still air from past a
//     void edge brings none. Only blocks that run write it, so air a reaction
//     left in a block the sleeping rules skip keeps its word until a running
//     block covers it (the WebGL pass rewrote every cell each step; emptying a
//     cell marks its brick dirty, so the next map draws it);
//   - an element change in place keeps it (TPT's transitions go through
//     Simulation::part_change_type, which leaves dcolour alone:
//     src/simulation/Simulation.cpp, "ideally transitions should use
//     create_part(i)"), so painted ice melts into painted water: react never
//     touches the plane;
//   - a cell that empties loses it (kill_part), and so does a cell a write
//     outside the step gives a new element (the brush, a stamp: TPT's
//     create_part resets the particle to the element's defaults, dcolour 0,
//     src/simulation/Simulation.cpp create_part). Those writes are in place
//     (docs/webgpu.md D6), so the box's element ids are kept just before the
//     write (decoScrubFrag's keep) and compared just after it (its main).
//
// Kernels (group 0 the tables, group 1 the state read-only, group 2
// DECO_LAYOUT: the plane, the layer's work buffer, a source; group 3 the
// params), one per job: the brush (two phases: smudge reads the cells around),
// the scrub (keep, then compare), undo, the window's shift, and the World's
// stage of a leaving slab. Loads, saves and the World's stored bricks coming
// back are byte copies the CPU orders (src/deco.js), not kernels.

// TPT's deco modes (src/simulation/SimulationData.h DECO_*), in the order the
// tools' ids run (elements.js DECO_TOOLS).
export const DECO_MODE = { SET: 0, CLEAR: 1, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, DIVIDE: 5, SMUDGE: 6 };
// How much one application of add, subtract, multiply or divide moves a
// channel, per unit of the colour and its alpha (TPT's `strength`,
// src/simulation/Editing.cpp Simulation::ApplyDecoration). TPT applies it once
// per frame while the mouse is down, as the brush does here.
export const DECO_STRENGTH = 0.01;
// Smudge reads the cells within SMUDGE_REACH along each axis whose taxicab
// distance is over SMUDGE_NEAR (TPT: a 5×5 square without its centre diamond,
// `abs(rx)+abs(ry) > 2`), averaged in linear light (TPT's default
// DECOSPACE_SRGB), and takes SMUDGE_FADE off an undecorated cell's alpha.
const SMUDGE_REACH = 2;
const SMUDGE_NEAR = 2;
const SMUDGE_FADE = 3 / 255;
// A channel's 8 bits from 0..1, rounded as TPT's `+ .5f` rounds (written out
// rather than pack4x8unorm's, so every device rounds a tie the same way).
const BYTE_MAX = 255;

// Group 2 of every deco kernel: the plane (sim.decoPlane: a range of the
// moveSrc buffer), the layer's work buffer (a plane-sized scratch, or the
// stage's output), and a read-only source (an undo snapshot's plane; a
// 16-byte dummy where a kernel reads none).
export const DECO_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
];
const decoBindings = /* wgsl */ `
@group(2) @binding(0) var<storage, read_write> plane: array<u32>;   // the decoration, RGBA8 per slot
@group(2) @binding(1) var<storage, read_write> work: array<u32>;    // the layer's scratch
@group(2) @binding(2) var<storage, read> source: array<u32>;        // a snapshot's plane (undo)
const DECO_BYTE_MAX: f32 = ${BYTE_MAX.toFixed(1)};
// a paint from its word, and back (clamped to 0..1, each channel rounded half up)
fn decoUnpack(w: u32) -> vec4f { return unpack4x8unorm(w); }
fn decoPack(t: vec4f) -> u32 {
  let b = vec4u(floor(clamp(t, vec4f(0.0), vec4f(1.0)) * DECO_BYTE_MAX + 0.5));
  return b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u);
}`;

// The box kernels' main: a 4×4×4 workgroup per brick the box [lo, hi]
// (inclusive grid cells, clipped) overlaps, from a folded dispatch over its
// bricks, x fastest (shaders/common.js editMain's shape); threads outside the
// box or the grid return. Opens a scope holding p and its slot s.
const boxMain = (name) => /* wgsl */ `@compute @workgroup_size(4, 4, 4)
fn ${name}(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let b0 = P.lo >> vec3u(2u);
  let nb = vec3u((P.hi >> vec3u(2u)) - b0 + 1);
  let k = foldId(wg, nwg);
  let p = (b0 + vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y)))) * BS + vec3i(lid);
  if (k >= nb.x * nb.y * nb.z || !inGrid(p) || any(p < P.lo) || any(p > P.hi)) { return; }
  let s = slotOf(p);`;
/** A box kernel's dispatch: one workgroup per brick of the box (inclusive grid cells, clipped). */
export const boxDispatch = (lo, hi) => fold([0, 1, 2].reduce((n, k) => n * ((hi[k] >> 2) - (lo[k] >> 2) + 1), 1));

// The whole-plane kernels' main: one thread per slot, its cell p.
const slotMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let p = cellOf(s);`;
const perSlot = (g) => fold(Math.ceil(gridDims(g).slots / 64));

// ---------------------------------------------------------------- the brush
// TPT's Simulation::ApplyDecoration (src/simulation/Editing.cpp) on every cell
// holding matter inside the brush (the shape and radius of the element brush,
// shaders/passes.js). color is the picker's colour, sRGB, and its alpha, all
// 0..1 (TPT's colR..colA / 255); the 8 bits round as TPT's `+ .5f` does.
// Two phases over the brush's box, as an edit that reads its neighbours
// (docs/webgpu.md D6): main paints into the work buffer reading the plane
// before the stroke (smudge reads the cells around), apply copies the box's
// cells into the plane.
export const DecoPaintParams = uniformStruct('DecoPaintParams', {
  lo: 'vec3i', hi: 'vec3i',   // the box
  center: 'vec3f', radius: 'f32',
  shape: 'u32',               // 0 sphere, 1 cube
  mode: 'u32',                // DECO_MODE
  color: 'vec4f',
});
export const decoPaintFrag = (g) => /* wgsl */ `
${prelude(g, { state: 'read' })}
${DecoPaintParams.wgsl}
@group(3) @binding(1) var<uniform> P: DecoPaintParams;
${decoBindings}
${Object.entries(DECO_MODE).map(([k, v]) => `const DECO_${k}: u32 = ${v}u;`).join('\n')}
const DECO_STRENGTH: f32 = ${DECO_STRENGTH};
const SMUDGE_REACH: i32 = ${SMUDGE_REACH};
const SMUDGE_NEAR: i32 = ${SMUDGE_NEAR};
const SMUDGE_FADE: f32 = ${SMUDGE_FADE};
// TPT's DECOSPACE_SRGB conversions (Editing.cpp), the IEC 61966-2-1 curve
fn srgbToLin(c: vec4f) -> vec4f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec4f(2.4)), c >= vec4f(0.04045)); }
fn linToSrgb(c: vec4f) -> vec4f { return select(c * 12.92, 1.055 * pow(c, vec4f(1.0 / 2.4)) - 0.055, c >= vec4f(0.0031308)); }
// cell p's word after the stroke, w before it (kept bit for bit where the stroke leaves it)
fn decoPainted(p: vec3i, w: u32) -> u32 {
  let d = vec3f(p) + 0.5 - P.center;
  var r = length(d);
  if (P.shape != 0u) { r = max(abs(d.x), max(abs(d.y), abs(d.z))); }
  if (r > P.radius || eid(fetchA(p)) == E_EMPTY) { return w; }
  var t = decoUnpack(w);
  let c = P.color.rgb * P.color.a * DECO_STRENGTH;
  switch (P.mode) {
    case DECO_SET: { t = P.color; }
    case DECO_CLEAR: { t = vec4f(0.0); }
    case DECO_ADD: { t = vec4f(t.rgb + c, t.a); }   // (TPT leaves alpha alone for these four)
    case DECO_SUBTRACT: { t = vec4f(t.rgb - c, t.a); }
    case DECO_MULTIPLY: { t = vec4f(t.rgb * (1.0 + c), t.a); }
    case DECO_DIVIDE: { t = vec4f(t.rgb / (1.0 + c), t.a); }
    case DECO_SMUDGE: {
      var sum = vec4f(0.0);
      var n = 0.0;
      for (var z = -SMUDGE_REACH; z <= SMUDGE_REACH; z++) {
        for (var y = -SMUDGE_REACH; y <= SMUDGE_REACH; y++) {
          for (var x = -SMUDGE_REACH; x <= SMUDGE_REACH; x++) {
            let q = p + vec3i(x, y, z);
            if (abs(x) + abs(y) + abs(z) <= SMUDGE_NEAR || !inGrid(q)) { continue; }
            let wq = plane[slotOf(q)];
            if (wq == 0u || eid(fetchA(q)) == E_EMPTY) { continue; }
            sum += srgbToLin(decoUnpack(wq));
            n += 1.0;
          }
        }
      }
      if (n == 0.0) { return w; }
      var s = linToSrgb(sum / n);
      if (w == 0u) { s.a -= SMUDGE_FADE; }
      t = s;
    }
    default: {}
  }
  return decoPack(t);
}
${boxMain('main')}
  work[s] = decoPainted(p, plane[s]);
}
${boxMain('apply')}
  plane[s] = work[s];
}
`;

// ---------------------------------------------------------------- the scrub
// Around a write that isn't a step (sim.edit with { scrub: true }: the brush,
// a stamp, the console's script), over its box: keep, before it, notes each
// cell's element in the work buffer; main, after it, takes the decoration off
// every cell that changed element or emptied (TPT's create_part and
// kill_part; see the top of this file).
export const DecoBoxParams = uniformStruct('DecoBoxParams', { lo: 'vec3i', hi: 'vec3i' });
export const decoScrubFrag = (g) => /* wgsl */ `
${prelude(g, { state: 'read' })}
${DecoBoxParams.wgsl}
@group(3) @binding(1) var<uniform> P: DecoBoxParams;
${decoBindings}
${boxMain('keep')}
  work[s] = u32(eid(fetchA(p)));
}
${boxMain('main')}
  let id = eid(fetchA(p));
  if (plane[s] != 0u && (id == E_EMPTY || id != i32(work[s]))) { plane[s] = 0u; }
}
`;

// ---------------------------------------------------------------- undo and the window
// Undo (Simulation.undo): cell p takes the snapshot's cell p + shift (the grid
// cells the window moved since it was taken, shaders/window.js
// undoShiftFrag), or none with blank (a snapshot from before anything was
// decorated); cells the snapshot doesn't hold keep what they have.
export const DecoShiftParams = uniformStruct('DecoShiftParams', { shift: 'vec3i', blank: 'u32' });
export const decoUndoFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${DecoShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: DecoShiftParams;
${decoBindings}
${slotMain}
  let q = p + P.shift;
  if (!inGrid(q)) { return; }
  if (P.blank != 0u) { plane[s] = 0u; } else { plane[s] = source[heldSlot(q, s)]; }
}
`;

// The window moved (Simulation.shift): cell p takes the decoration of
// p + shift, into the work buffer (out of place, docs/webgpu.md D8.12; the
// layer copies it back); the slab uncovered starts undecorated.
export const decoShiftFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${DecoShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: DecoShiftParams;
${decoBindings}
${slotMain}
  let q = p + P.shift;
  var w = 0u;
  if (inGrid(q)) { w = plane[heldSlot(q, s)]; }
  work[s] = w;
}
`;

// The World's window (world/window.js): the slab about to leave, its bricks
// in the slab layout of shaders/window.js (brick i's 64 cells at words 64·i ..,
// x fastest, then y, then z), into the work buffer for the readback into the
// deco store. A workgroup per brick of the slab, x fastest.
export const DecoSlabParams = uniformStruct('DecoSlabParams', { lo: 'vec3i', bricks: 'vec3i' });
export const decoStageFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${slabGLSL}
${DecoSlabParams.wgsl}
@group(3) @binding(1) var<uniform> P: DecoSlabParams;   // lo: the slab's low corner (grid cells, brick-aligned); bricks: its size
${decoBindings}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldId(wg, nwg);
  let nb = vec3u(P.bricks);
  if (i >= nb.x * nb.y * nb.z) { return; }
  let b = vec3i(vec3u(i % nb.x, (i / nb.x) % nb.y, i / (nb.x * nb.y)));
  let p = P.lo + b * BS + slabCell(i32(li));
  var w = 0u;
  if (inGrid(p)) { w = plane[slotOf(p)]; }
  work[i * u32(BRICK_CELLS) + li] = w;
}
`;
/** The stage's dispatch for a slab of `bricks` ([x, y, z]) bricks. */
export const stageDispatch = (bricks) => fold(bricks[0] * bricks[1] * bricks[2]);

const layouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RO, DECO_LAYOUT];
// (a box as large as the grid at most)
const perBox = (g) => fold(gridDims(g).nbricks);
const BOX = [4, 4, 4], ROW = [64, 1, 1];
/**
 * The layer's kernels: src/deco.js builds them when a deco tool is first
 * picked or the layer is made (never at boot: `warm: false`), and
 * tools/check-wgsl.mjs checks them.
 */
export const DECO_KERNELS = [
  { name: 'decoPaint', code: decoPaintFrag, entry: 'main', params: DecoPaintParams, workgroupSize: BOX, dispatch: perBox },
  { name: 'decoPaintApply', code: decoPaintFrag, entry: 'apply', params: DecoPaintParams, workgroupSize: BOX, dispatch: perBox },
  { name: 'decoKeep', code: decoScrubFrag, entry: 'keep', params: DecoBoxParams, workgroupSize: BOX, dispatch: perBox },
  { name: 'decoScrub', code: decoScrubFrag, entry: 'main', params: DecoBoxParams, workgroupSize: BOX, dispatch: perBox },
  { name: 'decoUndo', code: decoUndoFrag, entry: 'main', params: DecoShiftParams, workgroupSize: ROW, dispatch: perSlot },
  { name: 'decoShift', code: decoShiftFrag, entry: 'main', params: DecoShiftParams, workgroupSize: ROW, dispatch: perSlot },
  { name: 'decoStage', code: decoStageFrag, entry: 'main', params: DecoSlabParams, workgroupSize: ROW, dispatch: perBox },
];
/** tools/check-wgsl.mjs */
export const WGSL_CHECK = DECO_KERNELS.map((k) => ({ ...k, kind: 'compute', code: (g) => k.code(g), layouts, warm: false }));
