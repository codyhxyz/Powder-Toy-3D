// Retired in the WebGPU port (docs/webgpu.md D4, E): the sim's and the
// derived passes' kernels run over GPU-built brick lists with indirect
// dispatch, so there are no region quads to cull in a vertex shader and no
// share to pick a full-screen quad by. The names stay until U16 deletes them
// (docs/webgpu.md J3).

const retired = (name) => () => { throw new Error(`${name} removed in the WebGPU port: docs/webgpu.md D4 (brick lists, indirect dispatch)`); };
// WEBGPU-STUB (docs/webgpu.md J3)
export const regionVert = retired('regionVert');
// WEBGPU-STUB (docs/webgpu.md J3)
export const regionMaterial = retired('regionMaterial');
// WEBGPU-STUB (docs/webgpu.md J3)
export class RegionQuads {
  constructor() { retired('RegionQuads')(); }
}
