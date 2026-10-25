import { prelude, LAYOUT, STATE_OPTS } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { RING_LAYOUT } from './povBody.js';
import { ELEMENTS } from '../elements.js';

// Which elements the grid holds (gfx/materialCensus.js): a bit per element id,
// set by any cell of a sparse lattice through the grid, OR-ed into a slot of a
// result ring. The lattice is every CENSUS_STRIDE-th cell on each axis from
// P.phase, so one census reads 1/CENSUS_STRIDE³ of the grid and CENSUS_PHASES
// of them, phase by phase, cover every cell. Each workgroup ORs its cells into
// its own bits first, then writes a word only where it saw something, so the
// ring sees a handful of atomics per workgroup. Slots are never cleared: the
// answer only grows, and an element seen once is already asked for.
export const CENSUS_STRIDE = 2;
export const CENSUS_PHASES = CENSUS_STRIDE ** 3;
export const CENSUS_WG = 4;                                   // workgroup edge (4³ = 64 threads)
export const CENSUS_BITS = 32;                                // bits per word
export const CENSUS_WORDS = Math.ceil(ELEMENTS.length / CENSUS_BITS);
export const CENSUS_BYTES = CENSUS_WORDS * 4;
export const CensusParams = uniformStruct('CensusParams', { phase: 'vec4i', slot: 'u32' });

// Workgroups covering the lattice of grid g.
export const censusDispatch = (g) => [g.nx, g.ny, g.nz].map((n) => Math.ceil(Math.ceil(n / CENSUS_STRIDE) / CENSUS_WG));

export const censusFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${CensusParams.wgsl}
@group(3) @binding(1) var<uniform> P: CensusParams;
@group(2) @binding(0) var<storage, read_write> ringOut: array<atomic<u32>>;   // the result ring (B7)
const CENSUS_STRIDE: i32 = ${CENSUS_STRIDE};
const CENSUS_WORDS: u32 = ${CENSUS_WORDS}u;
const CENSUS_BITS: u32 = ${CENSUS_BITS}u;
const CENSUS_IDS: i32 = ${CENSUS_WORDS * CENSUS_BITS};
var<workgroup> seen: array<atomic<u32>, ${CENSUS_WORDS}>;

@compute @workgroup_size(${CENSUS_WG}, ${CENSUS_WG}, ${CENSUS_WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < CENSUS_WORDS) { atomicStore(&seen[li], 0u); }
  workgroupBarrier();
  let c = vec3i(gid) * CENSUS_STRIDE + P.phase.xyz;
  if (inGrid(c)) {
    let id = eid(fetchA(c));
    if (id > 0 && id < CENSUS_IDS) { atomicOr(&seen[u32(id) / CENSUS_BITS], 1u << (u32(id) % CENSUS_BITS)); }
  }
  workgroupBarrier();
  if (li < CENSUS_WORDS) {
    let bits = atomicLoad(&seen[li]);
    if (bits != 0u) { atomicOr(&ringOut[P.slot * CENSUS_WORDS + li], bits); }
  }
}
`;

/** tools/check-wgsl.mjs */
export const WGSL_CHECK = [
  { name: 'materialCensus', kind: 'compute', code: (g) => censusFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT], dispatch: (g) => censusDispatch(g) },
];
