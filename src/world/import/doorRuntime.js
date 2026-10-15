import { doorPose, transformDoorPoint, doorSweptBounds } from './doorMotion.js';

export const DOOR_SOURCE_WORDS = 12;
function cellBounds(positions) {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const p of positions) for(let k=0;k<3;k++) { min[k]=Math.min(min[k],p[k]); max[k]=Math.max(max[k],p[k]+1); }
  return {min,max};
}
export function doorCellPositions(map, door, progress) {
  const matrix = doorPose(door.motion, progress);
  const result = [];
  for (let i = 0; i < door.cells.length; i += 2) {
    const index = door.cells[i], x = index % map.size[0], y = Math.floor(index / map.size[0]) % map.size[1], z = Math.floor(index / (map.size[0] * map.size[1]));
    result.push(transformDoorPoint(matrix, [x + 0.5, y + 0.5, z + 0.5]).map(Math.floor));
  }
  return result;
}
// Shared analytic interval sweep of living original centers, rounded out to
// the actual floor-quantized unit-cell footprint (not the full motion envelope).
export function doorStepBounds(map, door, from, to, alive = null) {
  const centers=doorCellPositions(map,door,0).filter((_,i)=>!alive||alive[i]).map(p=>p.map(v=>v+0.5));
  if(!centers.length) return null;
  const bounds=doorSweptBounds(door.motion,centers,from,to);
  return { min:bounds.min.map(Math.floor), max:bounds.max.map(v=>Math.floor(v)+1) };
}

// Dense destination metadata + CSR linked source lists. Only a destination's
// invocation writes its source records; all fetches see the old two-phase state.
export function prepareDoorMove(map, door, state, progress, origin) {
  const old = doorCellPositions(map, door, state.progress), next = doorCellPositions(map, door, progress);
  const {min,max} = cellBounds(old.concat(next));
  const size = max.map((v,k) => v-min[k]), sourceAt = size.reduce((a,b) => a*b,1)*2;
  const data = new Uint32Array(sourceAt + old.length * DOOR_SOURCE_WORDS);
  const offset = p => (p[0]-min[0] + size[0]*(p[1]-min[1]+size[1]*(p[2]-min[2])))*2;
  for (let i = 0; i < old.length; i++) {
    const at = sourceAt + i*DOOR_SOURCE_WORDS, dst = offset(next[i]);
    data.set([...old[i].map((v,k) => (v-origin[k])>>>0), door.cells[i*2+1], state.alive[i], state.placed[i], data[dst+1], 0, 0, 0, 0, 0], at);
    data[dst+1] = i+1;
    if (state.alive[i] && state.placed[i]) data[offset(old[i])] = door.cells[i*2+1];
  }
  return { data, min, max, size, sourceAt, old, next };
}
