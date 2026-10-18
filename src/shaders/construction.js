import { LAYOUT, STAGE, EDIT_FIELDS, EDIT_SCRATCH_BINDING, editKernelWGSL, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { STAMP_LIB } from './stamp.js';

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
${STAMP_LIB}
fn stampCell(q: vec3i) -> vec4f { return stampCells[u32(q.x + P.size.x * (q.y + P.size.y * q.z))]; }

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = p - P.at;
  if (any(q < vec3i(0, -P.foot, 0)) || any(q >= P.size)) { return; }
  // below the base: the base cell above, if it grows a footing that reaches down here
  let s = stampCell(vec3i(q.x, max(q.y, 0), q.z));
  if (q.y < 0 && (s.w < 0.5 || !footing(p, P.at.y, P.foot))) { return; }
  if (s.x < 0.5) { return; }
  ownLegacy(slotOf(p)); // as stamp.js: only an eligible voxel/footing, including explicit air
  stampPut(p, s, b, oA, oB);
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
