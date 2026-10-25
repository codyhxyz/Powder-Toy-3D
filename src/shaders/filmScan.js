import { prelude, LAYOUT } from './common.js';
import { brickInfoWGSL } from './bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';

// Does the grid hold a thin water film (gfx/film.js)? One thread per brick of
// the brick map (shaders/passes.js brickFrag writes BRICK_FILM_CELLS); any brick
// with a film's cells writes this scan's stamp into its slot of a result ring. A slot
// is never cleared: it holds P.stamp only if this scan saw a film, so the CPU
// compares (gfx/filmScan.js). The view compiles without the film code until
// one turns up (gfx/volume.js). Intentional (2026-10-24, speed): dry floor
// beside a deep pool with no film anywhere (BRICK_FILM alone) doesn't count;
// the film's lip rising to meet a pool is the films' own look, and a grid
// without films draws its pools with the fields alone, as before films.
export const FILM_SCAN_WG = 64;   // (foldThread's workgroup)
export const FilmScanParams = uniformStruct('FilmScanParams', { stamp: 'u32', slot: 'u32' });
// group 2: the brick map (read) and the result ring
export const FILM_SCAN_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
export const filmScanDispatch = (g) => fold(Math.ceil(g.nbricks / FILM_SCAN_WG));

export const filmScanWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${brickInfoWGSL}
${FilmScanParams.wgsl}
@group(3) @binding(1) var<uniform> P: FilmScanParams;
@group(2) @binding(0) var<storage, read> brick: array<BrickInfo>;
@group(2) @binding(1) var<storage, read_write> ringOut: array<u32>;   // the result ring (B7)
@compute @workgroup_size(${FILM_SCAN_WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= NBRICKS) { return; }
  let w = brick[i].info;
  if (brickMatter(w) && (w & BRICK_FILM_CELLS) != 0u) { ringOut[P.slot] = P.stamp; }
}
`;

/** tools/check-wgsl.mjs */
export const WGSL_CHECK = [
  { name: 'filmScan', kind: 'compute', code: (g) => filmScanWGSL(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, FILM_SCAN_LAYOUT], dispatch: (g) => filmScanDispatch(g) },
];
