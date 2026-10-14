import { prelude, editKernelWGSL, EDIT_FIELDS, LAYOUT, STATE_OPTS, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { BODY_HEIGHT } from '../pov/constants.js';
import { RING_LAYOUT, ringWGSL } from './povBody.js';
import { consts } from '../glsl.js';

// GPU work for the kick (src/pov/kick.js) and the hook (src/pov/tools/hook.tool.js).
//
// Units: cells, cells/step, and the sim's kinetic energy ½·DENS·|v|² (the unit
// of ELEMENTS[].hard, HARD() in WGSL), as in shaders/povTools.js.

// Kick: a boot's blow over a small round patch around the struck cell. Its
// size is Noita's kick (data/entities/player.xml KickComponent kick_radius,
// 3 px; a Noita pixel is half a cell at this body's height, player.js PX).
// Across the patch, r the distance from its centre over RADIUS:
//   w(r) = 1 − r²
// - a breakable solid takes E = ENERGY·w and breaks into its debris where E
//   beats its hardness (the axe's rule, povTools.js blow). With ENERGY 16
//   (twice GLASS's 8, under WOOD's 20) a pane breaks around the boot, out to
//   r² ≤ 0.5 (the struck cell and its six face neighbours); ICE and PLANT (6)
//   a little wider; WOOD, ROCK and METAL never.
// - the fresh debris gets the struck lump's velocity times w. The momentum
//   handed over is the lump's: kick.js sums the same w-weighted mass from the
//   body's probe and splits the boot's speed between the lump and the body by
//   inverse mass (pov/tug.js).
// Loose matter (powder, liquid) isn't touched here: kick.js carries off the
// grains under the sole through the cell transfer (tools/transfer.js).
// kick.js keeps the CPU copy of these numbers; the WGSL gets them as consts.
const NOITA_BODY_PX = 11;                     // px, Noita's Mina head to feet (player.js)
const NOITA_PX = BODY_HEIGHT / NOITA_BODY_PX;  // cells per Noita pixel (player.js PX)
const NOITA_KICK_RADIUS_PX = 3;                // px (KickComponent kick_radius)
export const KICK = {
  RADIUS: NOITA_KICK_RADIUS_PX * NOITA_PX,   // cells (1.5)
  ENERGY: 16,        // sim KE units at the patch centre (between GLASS's 8 and WOOD's 20)
};
// w(r) on the CPU, matching the WGSL below: r = distance from the centre, cells
export const kickWeight = (r) => Math.max(0, 1 - (r * r) / (KICK.RADIUS * KICK.RADIUS));

export const KickParams = uniformStruct('KickParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',   // grid cells: the centre of the struck cell
  shove: 'vec3f',    // cells/step: the struck lump's velocity (along the kick), for the debris
});

export const kickWGSL = /* wgsl */ `
${consts('KICK', KICK)}
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.center;
  let r2 = dot(d, d) / (KICK_RADIUS * KICK_RADIUS);
  if (r2 >= 1.0) { return; }
  let w = 1.0 - r2;
  let id = eid(a);
  let into = BREAKINTO(id);
  if (KIND(id) == K_SOLID && into >= 0 && KICK_ENERGY * w >= HARD(id)) {
    (*oA).x = f32(into);
    *oB = vec4f(clamp(P.shove * w, vec3f(-V_MAX), vec3f(V_MAX)), b.w);
  }
}
`;
export const kickFrag = (g) => editKernelWGSL(g, { update: kickWGSL, params: KickParams });

// What a few cells hold now (state A), read back: the hook's anchor, so the
// rope lets go when its anchor stops being solid (it broke, melted or burned).
// A thread per listed cell (CELLS_MAX at most), into a ring slot; a cell
// outside the grid reads (-1, -1, -1, -1).
export const CELLS_MAX = 16;
export const CellsParams = uniformStruct('CellsParams', { cells: `array<vec4f, ${CELLS_MAX}>`, count: 'u32', slot: 'u32' });
export const hookCellFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${CellsParams.wgsl}
@group(3) @binding(1) var<uniform> P: CellsParams;
${ringWGSL()}
const CELLS_MAX: u32 = ${CELLS_MAX}u;

@compute @workgroup_size(${CELLS_MAX})
fn main(@builtin(local_invocation_index) i: u32) {
  if (i >= P.count) { return; }
  let c = vec3i(floor(P.cells[i].xyz + 0.5));
  var o = vec4f(-1.0);
  if (inGrid(c)) { o = fetchA(c); }
  ringOut[P.slot * CELLS_MAX + i] = o;
}
`;

// This module's edit family (src/pov/gpu.js).
export const POV_KICK_EDITS = { povKick: { update: kickWGSL, params: KickParams } };

/** tools/check-wgsl.mjs */
export const WGSL_CHECK = [
  { name: 'povKick', kind: 'compute', code: (g) => kickFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW], dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'povCells', kind: 'compute', code: (g) => hookCellFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT], dispatch: () => [1, 1, 1] },
];
