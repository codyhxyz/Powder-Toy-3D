// Concrete CELL transport. Native source/half bytes never become JS floats.
import { uniformStruct } from '../gpu/params.js';
import { brickFrag, WorldBrickParams } from './passes.js';
export { WorldBrickParams };
export const worldCellClassifierWGSL = g => brickFrag(g, { world: true });
const ro = binding => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } });
export const WORLD_CLASSIFIER_LAYOUT = [ro(0), ...[1,2,3].map(binding => ({ binding, visibility: 4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } })), { binding: 4, visibility: 4, buffer: { type: 'storage' } }];
export const CellPackParams = uniformStruct('CellPackParams', { page: 'vec4u', aux: 'vec4u', version: 'vec4u' });
export const WORLD_CELL_PACK_LAYOUTS = [
  [...Array.from({ length: 7 }, (_, i) => ro(i)), { binding: 7, visibility: 4, buffer: { type: 'uniform' } }],
  [0,1,2].map(binding => ({ binding, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba32uint', viewDimension: '2d-array' } })),
];
export const worldCellPackWGSL = /* wgsl */ `
${CellPackParams.wgsl}
@group(0) @binding(0) var<storage,read> A: array<vec4u>;
@group(0) @binding(1) var<storage,read> B: array<vec4u>;
@group(0) @binding(2) var<storage,read> flow: array<vec2u>;
@group(0) @binding(3) var<storage,read> aeration: array<vec2u>;
@group(0) @binding(4) var<storage,read> deco: array<u32>;
@group(0) @binding(5) var<storage,read> classification: array<vec4u>;
// header=(source brick slot, classification brick,0,0), then 64 aux flags.
@group(0) @binding(6) var<storage,read> jobs: array<u32>;
@group(0) @binding(7) var<uniform> P: CellPackParams;
@group(1) @binding(0) var outA: texture_storage_2d_array<rgba32uint,write>;
@group(1) @binding(1) var outB: texture_storage_2d_array<rgba32uint,write>;
@group(1) @binding(2) var outAux: texture_storage_2d_array<rgba32uint,write>;
var<workgroup> occLo: atomic<u32>;
var<workgroup> occHi: atomic<u32>;
fn auxAddress(r: u32) -> vec3i {
  let i = P.page.x * 132u + r;
  return vec3i(vec3u(i % P.page.w, (i / P.page.w) % P.aux.x, i / (P.page.w * P.aux.x)));
}
fn putAux(r: u32, v: vec4u) { let a = auxAddress(r); textureStore(outAux,a.xy,a.z,v); }
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) s: u32) {
  let src = jobs[0] + s;
  let a = A[src];
  let pixel = vec3i(vec3u((P.page.x % P.page.y) * 8u + (s & 7u), ((P.page.x / P.page.y) % P.page.z) * 8u + (s >> 3u), P.page.x / (P.page.y * P.page.z)));
  textureStore(outA,pixel.xy,pixel.z,a);
  textureStore(outB,pixel.xy,pixel.z,B[src]);
  let flags = jobs[4u+s];
  var f = vec2u(0u); var aer = vec2u(0u); var d = 0u;
  if ((flags & 1u) != 0u) { f = flow[src]; }
  if ((flags & 2u) != 0u) { aer = aeration[src]; }
  if ((flags & 4u) != 0u) { d = deco[src]; }
  putAux(4u+2u*s, vec4u(f,aer));
  putAux(5u+2u*s, vec4u(d,0u,0u,0u));
  let x = s & 3u; let y = ((s >> 2u) & 1u) + 2u*(s >> 5u); let z = (s >> 3u) & 3u;
  let k = x + 4u*y + 16u*z;
  if (i32(floor(bitcast<vec4f>(a).x + 0.5)) != 0) {
    if (k < 32u) { atomicOr(&occLo, 1u << k); } else { atomicOr(&occHi, 1u << (k-32u)); }
  }
  workgroupBarrier();
  if (s == 0u) {
    putAux(0u,P.version);
    putAux(1u,classification[jobs[1]]);
    // Unknown distance is deliberately NOT fabricated empty-space distance.
    putAux(2u,vec4u(atomicLoad(&occLo),atomicLoad(&occHi),0u,0u));
    putAux(3u,vec4u(0u));
  }
}
`;

// Capture XYZ rows -> original 8x8 brick slot tile. Each native copy is a
// single four-cell row, so WebGPU needs no bytesPerRow (and no illegal 128).
export function copyCapturedFieldPage(encoder, buffer, localBrick, destination) {
  const [bx,by,bz] = localBrick.map(v => v * 4);
  for (let y=0;y<4;y++) for (let z=0;z<4;z++) {
    const offset = ((bx) + 32*((by+y) + 32*(bz+z))) * 8;
    const slot = 4*(y&1)+8*(z+4*(y>>1));
    const origin = [destination.origin[0]+(slot&7),destination.origin[1]+(slot>>3),destination.origin[2]];
    encoder.copyBufferToTexture({buffer,offset},{texture:destination.texture,origin},[4,1,1]);
  }
}
