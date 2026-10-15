// Native global point read. No local-window lighting proxy or readback/submit.
import { uniformStruct } from '../gpu/params.js';
import { lib } from './gfx/lib.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';
import { worldVolumeLayouts } from './worldRenderBackend.js';

export const WORLD_POINT_BYTES = 80;
export const WorldPointParams = uniformStruct('WorldPointParams', { position: 'vec4f' });
export function worldPointLayouts() {
  const groups = worldVolumeLayouts({ pick: true, paramsSize: WorldPointParams.size });
  groups[3].find(e => e.binding === 6).buffer.minBindingSize = WORLD_POINT_BYTES;
  return groups;
}
export const worldPointWGSL = g => /* wgsl */ `${lib(g, { backend: 'world' })}
${shadowOpticsWGSL({ backend: 'world' })}
${WorldPointParams.wgsl}
@group(3) @binding(0) var<uniform> P: WorldPointParams;
@group(3) @binding(6) var<storage, read_write> pointOut: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  worldBeginQuery(); worldSunValidate();
  let p = P.position.xyz;
  let pr = probeAt(p);
  let sun = sunShadowAt(p);
  worldEndQuery();
  // Keep every SH coefficient, including the alpha sky-visibility bands.
  // Placeholder data on a missing dependency is NEVER an accepted zero.
  pointOut[0] = pr.c0;
  pointOut[1] = pr.cx;
  pointOut[2] = pr.cy;
  pointOut[3] = pr.cz;
  pointOut[4] = vec4f(sun, select(1.0, -1.0, worldQueryIncomplete()));
}
`;

export const WGSL_CHECK = () => [128, 384].flatMap(ny => [false, true].map(sourceAppearance => ({
  name: `world-point-${ny}-${sourceAppearance}`, kind: 'compute',
  code: () => worldPointWGSL({ nx: 3072, ny, nz: 1024, sourceAppearance, sourceGrid: [128, 0, 128] }),
  layouts: worldPointLayouts,
})));
