// Vite resolves one shared three/TSL instance for the isolated visual check.
export * as THREE from 'three/webgpu';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
export { createFigure } from '../../src/pov/figure.js';
export { buildSpartan } from '../../src/pov/figureSpartan.js';
export { buildCrasher } from '../../src/pov/figureCrasher.js';
export { createRealFigure } from '../../src/pov/figureReal.js';
export { meshLight } from '../../src/gfx/meshLight.js';
