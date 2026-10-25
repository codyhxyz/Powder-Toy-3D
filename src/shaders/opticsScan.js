import { prelude, LAYOUT } from './common.js';
import { brickInfoWGSL } from './bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';

// Does the grid hold a thin water film (gfx/film.js) or crisp glass
// (gfx/glass.js)? One thread per brick of the brick map (shaders/passes.js
// brickFrag writes BRICK_FILM_CELLS and BRICK_GLASS_CELLS); any brick with
// either writes this scan's stamp into its slot of a result ring. A slot is
// never cleared: it holds P.stamp only if this scan saw one, so the CPU
// compares (gfx/opticsScan.js). The view compiles without the rich optics
// until one turns up (gfx/volume.js). Intentional (2026-10-24, speed): dry floor
// beside a deep pool with no film anywhere (BRICK_FILM alone) doesn't count;
// the film's lip rising to meet a pool is the films' own look, and a grid
// without films draws its pools with the fields alone, as before films.
export const OPTICS_SCAN_WG = 64;   // (foldThread's workgroup)
export const OpticsScanParams = uniformStruct('OpticsScanParams', { stamp: 'u32', slot: 'u32' });
// group 2: the brick map (read) and the result ring
export const OPTICS_SCAN_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
export const opticsScanDispatch = (g) => fold(Math.ceil(g.nbricks / OPTICS_SCAN_WG));

export const opticsScanWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${brickInfoWGSL}
${OpticsScanParams.wgsl}
@group(3) @binding(1) var<uniform> P: OpticsScanParams;
@group(2) @binding(0) var<storage, read> brick: array<BrickInfo>;
@group(2) @binding(1) var<storage, read_write> ringOut: array<u32>;   // the result ring (B7)
@compute @workgroup_size(${OPTICS_SCAN_WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let w = brick[i].info;
  if (brickMatter(w) && (w & (BRICK_FILM_CELLS | BRICK_GLASS_CELLS)) != 0u) { ringOut[P.slot] = P.stamp; }
}
`;

/** tools/check-wgsl.mjs */
export const WGSL_CHECK = [
  { name: 'opticsScan', kind: 'compute', code: (g) => opticsScanWGSL(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, OPTICS_SCAN_LAYOUT], dispatch: (g) => opticsScanDispatch(g) },
];
