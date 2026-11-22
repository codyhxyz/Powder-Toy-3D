import { fullscreenVert } from '../../gpu/wgsl.js';
import { STAGE } from '../common.js';
import { SCENE_FORMATS } from '../render.js';

const layout = [
  { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth' } },
];

// All passes share an origin-zero viewport. Pixel positions (not normalized
// texture UVs) map its active rectangle 1:1 into the reusable allocations.
export const rasterCompositeWGSL = () => /* wgsl */ `
${fullscreenVert()}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
struct Out { @location(0) color: vec4f, @builtin(frag_depth) z: f32 }
@fragment fn fs(in: FullScreen) -> Out {
  let p = vec2i(in.position.xy);
  return Out(textureLoad(hdr, p, 0), textureLoad(depth, p, 0));
}
`;

export const WGSL_CHECK = () => [{
  name: 'world raster composite', kind: 'render', grids: false, warm: false,
  code: rasterCompositeWGSL, layouts: () => [layout],
  fragment: { targets: [{ format: SCENE_FORMATS.color }] },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
}];
