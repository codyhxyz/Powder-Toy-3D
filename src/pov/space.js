import * as THREE from 'three';

// Grid ↔ world: the grid's cells (the sim's coordinates, a cell a unit) and the
// scene's world, where the volume sits at getVolume().position, getScale() world
// units a cell. Read when called, so a new grid or a rescale is followed.
//
//   const { toWorld, toGrid } = gridSpace(env);   // anything with getScale() and getVolume()
//   toWorld(cell, out); toGrid(point, out);       // out: a new vector when left out

export function gridSpace(src) {
  return {
    toWorld: (g, out = new THREE.Vector3()) => out.copy(g).multiplyScalar(src.getScale()).add(src.getVolume().position),
    toGrid: (w, out = new THREE.Vector3()) => out.copy(w).sub(src.getVolume().position).divideScalar(src.getScale()),
  };
}
