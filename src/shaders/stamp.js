import { EDIT_FIELDS, EDIT_SCRATCH_BINDING, LAYOUT, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';
import { MAX_FOOT } from '../constructions/runtime.js';

export { MAX_FOOT };

// Stamps: a baked construction (constructions/runtime.js bake) written into
// the grid, an edit over its box and the footing under it (docs/webgpu.md D7:
// two-phase, since a footing reads the cells below it). The world window's
// trees, the box's Island preset's, the felled glade round the world's shrine
// and the constructions (src/constructions.js) all stamp this way, through
// world/gpu.js stamperFor(sim).
//
// Stamp voxel: x = element id + 1 (0 leaves the cell alone, 1 carves air),
// y = temperature, z = ctype, w = 1 when the cell is part of the base and may
// grow a footing. A footing column extends that cell's element straight down,
// but only through cells that can't bear weight (air, gas, liquid) and only if
// it reaches ground within its footing depth, so a house on a slope gets a
// plinth and one in a lake stands on stilts, while one placed in mid-air
// simply floats. Footings read the state from before the edit.
//
// The voxels live in one storage buffer (the stamper's shape pool: each baked
// shape uploaded once, its w × h × d voxels x fastest, then y, then z, as vec4f
// bits), after a bitmask of the grid's brick columns: with `masked`, only
// cells whose brick column is set are written (a window move plants only the
// columns it visits for the first time, world/window.js). The stamp itself
// travels in the params: its low corner, size, footing depth, seed and its
// voxels' place in the pool.
export const STAMP_RNG_SALT = 0x57a3;   // a stamped cell's colour seed stream
export const StampParams = uniformStruct('StampParams', {
  ...EDIT_FIELDS,
  at: 'vec3i',       // grid cell of the stamp's low corner
  foot: 'i32',       // footing depth, cells (≤ MAX_FOOT)
  size: 'vec3i',     // its w, h, d
  base: 'u32',       // its first voxel in the pool (vec4 units)
  seed: 'u32',
  masked: 'u32',     // write only the brick columns set in the mask
  maskW: 'i32',      // the mask's brick columns along x (the grid's)
});
export const STAMP_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
const STAMP_DECLS = /* wgsl */ `
@group(2) @binding(0) var<storage, read> stampData: array<vec4u>;   // the brick-column mask, then the shape pool
const STAMP_RNG_SALT: u32 = ${STAMP_RNG_SALT}u;
const MAX_FOOT: i32 = ${MAX_FOOT};
fn stampColumn(c: vec2i) -> bool {
  let i = u32(c.x + P.maskW * c.y);
  return ((stampData[i >> 7u][(i >> 5u) & 3u] >> (i & 31u)) & 1u) != 0u;
}
// does what is at grid cell c bear weight? (outside the grid: nothing)
fn bearsWeight(c: vec3i) -> bool {
  if (!inGrid(c)) { return false; }
  let id = eid(fetchA(c));
  return id != E_EMPTY && KIND(id) != K_GAS && KIND(id) != K_LIQUID;
}
// Does a footing reach down from base height y0 to grid cell p? Nothing that
// bears weight between p and the base, and ground (or the grid's floor) within foot cells below it.
fn footing(p: vec3i, y0: i32, foot: i32) -> bool {
  for (var i = 1; i <= MAX_FOOT; i++) {
    let y = y0 - i;
    if (y < p.y) { break; }
    if (bearsWeight(vec3i(p.x, y, p.z))) { return false; }
  }
  for (var i = 1; i <= MAX_FOOT; i++) {
    let y = y0 - i;
    if (i > foot) { break; }
    if (y < 0 || bearsWeight(vec3i(p.x, y, p.z))) { return true; }
  }
  return false;
}`;
const STAMP_UPDATE = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (P.masked != 0u && !stampColumn(p.xz / BS)) { return; }
  let q = p - P.at;
  if (q.x < 0 || q.z < 0 || q.x >= P.size.x || q.z >= P.size.z || q.y >= P.size.y || q.y < -P.foot) { return; }
  let s = bitcast<vec4f>(stampData[P.base + u32(q.x + P.size.x * (max(q.y, 0) + P.size.y * q.z))]);
  if (q.y < 0 && (s.w < 0.5 || !footing(p, P.at.y, P.foot))) { return; }
  if (s.x < 0.5) { return; }
  let id = i32(s.x + 0.5) - 1;
  var rs = seed3(p, P.seed, STAMP_RNG_SALT);
  *oA = vec4f(f32(id), s.y, SPAWNLIFE(id), s.z + rnd(&rs) * SEED_MAX);
  *oB = vec4f(0.0, 0.0, 0.0, b.w);
}`;
/** The stamp's edit kernel (sim.editKernel takes this). */
export const stampEdit = () => ({ update: STAMP_UPDATE, decls: STAMP_DECLS, params: StampParams, reads: 'neighbours', layout: STAMP_LAYOUT });
/** Its whole module (the names are the WebGL passes', docs/webgpu.md W2: one stamp a dispatch now, D6). */
export const stampFrag = (g) => editKernelWGSL(g, stampEdit());
export const stampManyFrag = stampFrag;
// WEBGPU-STUB (docs/webgpu.md J3): stamps per WebGL pass; each stamp is its own edit now (D6)
export const MAX_STAMPS = null;

// tools/check-wgsl.mjs: the stamp's two entry points (sim.editKernel builds
// 'stamp' and 'stamp apply'), on first use (a world's trees, the box's Island,
// a construction): the warm-up leaves them out
const stampLayouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RW, [...STAMP_LAYOUT, { binding: EDIT_SCRATCH_BINDING, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]];
export const WGSL_CHECK = [
  { name: 'stamp', kind: 'compute', warm: false, code: (g) => stampFrag(g), layouts: stampLayouts, params: StampParams, dispatch: (g) => fold(g.nbricks) },
  { name: 'stamp apply', kind: 'compute', entry: 'apply', warm: false, code: (g) => stampFrag(g), layouts: stampLayouts, params: StampParams, dispatch: (g) => fold(g.nbricks) },
];
