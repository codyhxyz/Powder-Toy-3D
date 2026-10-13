// Herringbone Wang tiles in 3D (docs/wang-tiles.md): a scene's levels built
// from hand-authored tile kits, Noita's way, with no visible grid.
//   bakeWang({ kit, seed, size, origin, entry, exit })   bake.js: the API a scene calls
//   wangGLSL(kit)                                         glsl.js: WGSL fn wangCell(w: vec3i) -> i32, wangElement(code), wangTemp(code)
//   MAT, WANG_OUT                                         kit.js: the material codes
export { bakeWang } from './bake.js';
export { wangGLSL } from './glsl.js';
export { MAT, MAT_NAMES, WANG_OUT, GEOM, compileKit } from './kit.js';
export { default as minesKit } from './kits/mines.js';
export { default as coalKit } from './kits/coal.js';
export { default as snowKit } from './kits/snow.js';
