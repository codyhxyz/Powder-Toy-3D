// Shared original GI arithmetic against world leafs; no application switch.
import { GiParams, giSourceFrag, giGatherFrag } from './gi.js';
import { worldVolumeLayouts } from './worldRenderBackend.js';
import { assertWorldLayout } from '../world/renderAtlas.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';

export function worldGILayouts({ gather = false, limits } = {}) {
  const groups = worldVolumeLayouts({ limits }).map(g => g.map(e => ({ ...e })));
  const uniform = (binding, size) => ({ binding, visibility: 4, buffer: { type: 'uniform', minBindingSize: size } });
  const storage = (binding, type) => ({ binding, visibility: 4, buffer: { type, minBindingSize: 16 } });
  groups[3].push(uniform(6, GiParams.size), uniform(7, 32), storage(8, 'read-only-storage'), storage(9, 'storage'));
  if (gather) {
    groups[3].push({ binding: 10, visibility: 4, buffer: { type: 'storage', minBindingSize: 8 } });
    for (let k = 0; k < 4; k++) groups[3].push({ binding: 11 + k, visibility: 4,
      storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } });
  }
  return assertWorldLayout(groups, limits);
}

export const worldGIBirthWGSL = /* wgsl */ `
const WORLD_GI_BIRTH: u32 = 2u;
fn worldGIJobBlend(ordinary: f32, flags: u32) -> f32 {
  return select(ordinary, 1.0, (flags & WORLD_GI_BIRTH) != 0u);
}
`;
function declarations(gather) { return /* wgsl */ `
${shadowOpticsWGSL({ backend: 'world' })}
${GiParams.wgsl}
@group(3) @binding(6) var<uniform> P: GiParams;
struct WorldGIParams { counts: vec4u, config: vec4u }
// counts: source count, gather count, absolute first job-status word, logical tick.
// config: scene epoch, reserved. Job flags: bit0 background, bit1 ledger-authenticated birth.
// Jobs are source-first, each phase sorted by GLOBAL index.
@group(3) @binding(7) var<uniform> WGI: WorldGIParams;
@group(3) @binding(8) var<storage, read> worldGIJobs: array<vec4u>;
@group(3) @binding(9) var<storage, read_write> worldGISources: array<vec4u>;
${worldGIBirthWGSL}
fn worldGIPreviousProbe(job: u32, bc: vec3i) -> Probe {
  if ((worldGIJobs[job].y & WORLD_GI_BIRTH) != 0u) {
    return Probe(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  }
  return Probe(worldProbeLoad(tGI0, bc, WORLD_GI), worldProbeLoad(tGI1, bc, WORLD_GI), worldProbeLoad(tGI2, bc, WORLD_GI), worldProbeLoad(tGI3, bc, WORLD_GI));
}
fn worldGIReport(job: u32) {
  atomicOr(&worldRequests[WGI.counts.z + job], select(1u, 3u, worldQueryIncomplete()));
}
${gather ? `@group(3) @binding(10) var<storage, read_write> worldGIHistory: array<vec2u>;
@group(3) @binding(11) var worldGI0Out: texture_storage_2d_array<rgba16float, write>;
@group(3) @binding(12) var worldGI1Out: texture_storage_2d_array<rgba16float, write>;
@group(3) @binding(13) var worldGI2Out: texture_storage_2d_array<rgba16float, write>;
@group(3) @binding(14) var worldGI3Out: texture_storage_2d_array<rgba16float, write>;
// Private source overlay. Every source dispatch precedes EVERY gather dispatch.
// Nonselected sources come from the immutable published prior source snapshot.
fn worldGISourceStaged(b: vec3i) -> vec4u {
  let index = worldBookIndex(b);
  var lo = 0u; var hi = WGI.counts.x;
  loop {
    if (lo >= hi) { break; }
    let mid = lo + (hi - lo) / 2u;
    if (worldGIJobs[mid].x < index) { lo = mid + 1u; } else { hi = mid; }
  }
  if (lo < WGI.counts.x && worldGIJobs[lo].x == index) { return worldGISources[lo]; }
  return worldGISource(b);
}` : ''}
`; }
export const worldGISource = g => giSourceFrag(g, { backend: 'world', worldWGSL: declarations(false) });
export const worldGIGather = g => giGatherFrag(g, { backend: 'world', worldWGSL: declarations(true) });
export const WGSL_CHECK = () => [128, 384].flatMap(ny => [false, true].flatMap(sourceAppearance => [false, true].map(gather => ({
  name: `worldGI.${gather ? 'gather' : 'source'}.${ny}.${sourceAppearance ? 'imported' : 'native'}`,
  kind: 'compute', grids: false, warm: false,
  code: () => (gather ? worldGIGather : worldGISource)({ nx: 3072, ny, nz: 1024, sourceAppearance, sourceGrid: [384, 16, 128] }),
  layouts: () => worldGILayouts({ gather }), workgroupSize: [64, 1, 1], dispatch: () => [1, 1, 1],
}))));
