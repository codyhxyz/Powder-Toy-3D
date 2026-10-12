import { LAYOUT, STAGE, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { MAX_FOOT } from '../constructions/runtime.js';

// A construction stamped into the grid (src/constructions.js): a box writer
// (sim.editKernel, docs/webgpu.md D6) over the construction's box and the
// footings under it, reading its baked cells from a storage buffer.
//
// Baked cell (constructions/runtime.js bake): x = element id + 1 (0 leaves the
// cell alone, 1 carves air), y = temperature, z = ctype, w = 1 when the cell
// is part of the base and may grow a footing; x fastest, then y, then z. A
// footing column extends that cell's element straight down, but only through
// cells that can't bear weight (air, gas, liquid) and only if it reaches
// ground within P.foot cells, so a house on a slope gets a plinth and one in a
// lake stands on stilts, while one placed in mid-air simply floats. The
// footing test reads the cells below, so the writer is two-phase (reads
// 'neighbours'): every cell tests the grid as it was before the stamp.
//
// (shaders/stamp.js is the world window's many-stamp pass, which plants
// trees; this is the one the construction tools and shrines use.)

export const BuildStampParams = uniformStruct('BuildStampParams', {
  ...EDIT_FIELDS,
  at: 'vec3i',     // grid cell of the construction's low corner
  foot: 'i32',     // deepest footing, cells (MAX_FOOT at most)
  size: 'vec3i',   // its baked box, cells
  seed: 'u32',     // the stamped cells' colour seeds
});

export const BUILD_STAMP_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];

export const buildStampDecls = /* wgsl */ `
@group(2) @binding(0) var<storage, read> stampCells: array<vec4f>;
`;

export const buildStampUpdate = /* wgsl */ `
const STAMP_RNG_SALT: u32 = 0x57a3u;   // a stamped cell's colour seed (shaders/stamp.js's stream)
const MAX_FOOT: i32 = ${MAX_FOOT};

fn bearsWeight(c: vec3i) -> bool {
  let id = eid(fetchA(c));
  return id != E_EMPTY && KIND(id) != K_GAS && KIND(id) != K_LIQUID;
}
fn stampCell(q: vec3i) -> vec4f { return stampCells[u32(q.x + P.size.x * (q.y + P.size.y * q.z))]; }

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = p - P.at;
  if (any(q < vec3i(0, -P.foot, 0)) || any(q >= P.size)) { return; }
  var s: vec4f;
  if (q.y >= 0) {
    s = stampCell(q);
  } else {
    s = stampCell(vec3i(q.x, 0, q.z));
    if (s.w < 0.5) { return; }
    // nothing that bears weight between this cell and the base... (a base
    // above the grid's top has nothing over the grid: slotOf of a cell there
    // is another, real cell, H1.29)
    for (var i = 1; i <= MAX_FOOT; i++) {
      let y = P.at.y - i;
      if (y < p.y) { break; }
      if (y >= NY) { continue; }
      if (bearsWeight(vec3i(p.x, y, p.z))) { return; }
    }
    // ...and ground somewhere below it, within reach
    var ground = false;
    for (var i = 1; i <= MAX_FOOT; i++) {
      let y = P.at.y - i;
      if (i > P.foot) { break; }
      if (y >= NY) { continue; }
      if (y < 0 || bearsWeight(vec3i(p.x, y, p.z))) { ground = true; break; }
    }
    if (!ground) { return; }
  }
  if (s.x < 0.5) { return; }

  let id = i32(s.x + 0.5) - 1;
  var rs = seed3(p, P.seed, STAMP_RNG_SALT);
  *oA = vec4f(f32(id), s.y, SPAWNLIFE(id), s.z + rnd(&rs) * SEED_MAX);
  *oB = vec4f(0.0, 0.0, 0.0, b.w);
}
`;

/** The editKernel description (sim.editKernel('buildStamp', BUILD_STAMP_KERNEL)). */
export const BUILD_STAMP_KERNEL = {
  update: buildStampUpdate, params: BuildStampParams, reads: 'neighbours', decls: buildStampDecls, layout: BUILD_STAMP_LAYOUT,
};

/** tools/check-wgsl.mjs (built when a construction is first stamped or previewed: `tool`, not warmed) */
export const WGSL_CHECK = [{
  name: 'buildStamp', kind: 'compute', tool: true,
  code: (g) => editKernelWGSL(g, BUILD_STAMP_KERNEL),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, [...BUILD_STAMP_LAYOUT, { binding: EDIT_SCRATCH_BINDING, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]],
  dispatch: (g) => fold(gridDims(g).nbricks),
}];
