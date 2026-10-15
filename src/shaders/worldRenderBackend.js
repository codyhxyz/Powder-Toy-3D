// Dedicated complete-reader layout; never append to the already-full Box one.
import { worldReaderLayouts, assertWorldLayout } from '../world/renderAtlas.js';
import { FrameUniforms } from './bindings.js';
import { Header, tableLayout } from './common.js';
const TABLES_BYTES = tableLayout().Tables.size;
export function worldVolumeLayouts({ pick = false, limits, paramsSize = 0 } = {}) {
  const a = worldReaderLayouts(limits);
  const uniform = (binding,size) => ({binding,visibility:7,buffer:{type:'uniform',minBindingSize:size}});
  const storage = (binding,type='read-only-storage') => ({binding,visibility:6,buffer:{type}});
  return assertWorldLayout([
    [{...storage(0),buffer:{type:'read-only-storage',minBindingSize:TABLES_BYTES}},uniform(1,Header.size),uniform(2,FrameUniforms.size),{...a[0][0],binding:3}, {...a[0][1],binding:4}],
    a[1],a[2],
    [uniform(0,paramsSize),{...a[3][0],binding:1},
      {binding:2,visibility:6,sampler:{type:'filtering'}},{binding:3,visibility:6,sampler:{type:'filtering'}},
      uniform(4,128),storage(5),...(pick ? [storage(6,'storage')] : [])],
  ], limits);
}
export const worldQueryWGSL = /* wgsl */ `
// One extra aligned word immediately after the unchanged geometry bitset.
// An incomplete query must invalidate the ENTIRE offscreen candidate frame.
fn worldEndQuery() {
  if (worldQueryIncomplete()) {
    let count = WA.bricks.x*WA.bricks.y*WA.bricks.z;
    atomicOr(&worldRequests[(count+31u)/32u],1u);
  }
}
`;
