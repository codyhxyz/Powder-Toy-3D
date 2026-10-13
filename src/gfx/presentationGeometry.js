import * as THREE from 'three/webgpu';
import { ROLLING_LOG } from './presentationMath.js';

// Linear raster edges approximate the parabola with error k*L²/4. At 16
// world cells this is <=1/32 cell. Detail's cell faces already satisfy this.
// Only static meshes/lines are subdivided: skin/morph/custom-motion topology
// remains authored (the wrapper runs AFTER its motion). Points have no edges.
// Animated assets must keep moving edges <=16 cells to claim the same bound.
export const MESH_CHORD_ERROR = 1 / 32;
export const MESH_EDGE_CELLS = Math.sqrt(4 * MESH_CHORD_ERROR / ROLLING_LOG.k);
export function subdividePresentation(object, maxLength) {
  const source = object.geometry;
  if (!source?.attributes.position || object.isPoints || object.isSkinnedMesh || source.morphAttributes.position?.length) return null;
  // Instanced/custom-deformed meshes retain their topology and all motion
  // attributes; subdividing their CPU positions cannot bound GPU-only motion.
  if (object.isInstancedMesh || source.isInstancedBufferGeometry) return null;
  const p = source.attributes.position, index = source.index;
  const lines = object.isLine, width = lines ? 2 : 3;
  if (!object.isMesh && !lines) return null;
  const stride = object.isLine && !object.isLineSegments ? 1 : width;
  const count = index?.count ?? p.count;
  const ids = i => index ? index.getX(i) : i;
  const point = i => new THREE.Vector3().fromBufferAttribute(p, i);
  let needed = false;
  for (let i=0; i+width<=count && !needed; i+=stride) {
    const a = point(ids(i));
    for (let j=1; j<width; j++) if (a.distanceTo(point(ids(i+j))) > maxLength) needed = true;
    if (width === 3 && point(ids(i+1)).distanceTo(point(ids(i+2))) > maxLength) needed = true;
  }
  if (!needed) return null;
  const attributes = Object.entries(source.attributes), data = Object.fromEntries(attributes.map(([k]) => [k,[]]));
  const vertex = i => Object.fromEntries(attributes.map(([k,a]) => [k,Array.from({length:a.itemSize},(_,j) => a.getComponent(i,j))]));
  const mid = (a,b) => Object.fromEntries(attributes.map(([k]) => [k,a[k].map((x,j) => (x+b[k][j])/2)]));
  const dist = (a,b) => Math.hypot(...a.position.map((x,j) => x-b.position[j]));
  const emit = vertices => { for (const v of vertices) for (const [k] of attributes) data[k].push(...v[k]); };
  const split = vertices => {
    const edges = width === 2 ? [[0,1]] : [[0,1],[1,2],[2,0]];
    let edge = edges[0], length = dist(vertices[edge[0]],vertices[edge[1]]);
    for (const e of edges.slice(1)) {
      const l = dist(vertices[e[0]],vertices[e[1]]);
      if (l > length) { length=l; edge=e; }
    }
    if (length <= maxLength) { emit(vertices); return; }
    const [a,b] = edge, m = mid(vertices[a],vertices[b]);
    if (width === 2) { split([vertices[0],m]); split([m,vertices[1]]); }
    else {
      const c = 3-a-b;
      split([vertices[a],m,vertices[c]]); split([m,vertices[b],vertices[c]]);
    }
  };
  const geo = new THREE.BufferGeometry();
  // Preserve material groups. A Line's contiguous strip becomes line segments.
  const groups = source.groups.length ? source.groups : [{start:0,count,materialIndex:0}];
  for (const group of groups) {
    const start = data.position.length/3;
    for (let i=group.start; i+width<=Math.min(count,group.start+group.count); i+=stride)
      split(Array.from({length:width},(_,j) => vertex(ids(i+j))));
    geo.addGroup(start,data.position.length/3-start,group.materialIndex);
  }
  for (const [k,a] of attributes) geo.setAttribute(k,new THREE.Float32BufferAttribute(data[k],a.itemSize));
  geo.computeBoundingSphere();
  return geo;
}
