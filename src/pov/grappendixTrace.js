import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { BRICK } from '../shaders/common.js';
import { TRACE, TRACE_MISS, TRACE_ROUND } from '../shaders/povTrace.js';
import { decodeBrick, BRICK_FLOATS } from '../world/store.js';
import { voxelWalk } from './grid.js';
import { povGpu } from './gpu.js';

const stops = id => id < 0 || (id !== E.EMPTY && ELEMENTS[id]?.kind !== K.GAS);
export const grappleResident = (g, cell) => cell.x >= 0 && cell.x < g.nx && cell.y >= 0 && cell.y < g.ny && cell.z >= 0 && cell.z < g.nz;

// Only imported scenes expose the canonical CPU voxel source. Never substitute
// its pristine cells for resident simulation cells (including destroyed walls).
export function grappleFarCells(world) {
  if (!world?.scene.importManifest || !world.scene.cell || world.pending) return null;
  const cache = new Map();
  return (x, y, z) => {
    if (x < 0 || x >= world.size[0] || z < 0 || z >= world.size[2] || y >= world.size[1]) return E.EMPTY;
    if (y < 0) return -1;
    const bx = Math.floor(x / BRICK), by = Math.floor(y / BRICK), bz = Math.floor(z / BRICK);
    const key = world.store.key(bx, by, bz), bytes = world.store.map.get(key);
    if (!bytes) return world.scene.cell(x, y, z);
    let cells = cache.get(key);
    if (!cells) {
      cells = new Float32Array(BRICK_FLOATS * 2);
      decodeBrick(bytes, cells, 0, cells, BRICK_FLOATS);
      cache.set(key, cells);
    }
    return Math.round(cells[((y % BRICK * BRICK + z % BRICK) * BRICK + x % BRICK) * 4]);
  };
}

// One on-demand flat physical ray, not the displayed/curved hover ray. Live
// resident matter always wins; outside the window use the same imported voxels
// as the generator plus saved edits. No combat trace limits are changed.
export async function traceGrappendix(sim, world, eye, dir, range) {
  const starts = Array.from({ length: TRACE.ROUNDS }, () => [0, 0, 0, 0]);
  const ends = Array.from({ length: TRACE.ROUNDS }, () => [0, 0, 0, 0]);
  starts[0] = [...eye, TRACE_ROUND];
  ends[0] = [...eye.clone().addScaledVector(dir, range), 0];
  const read = povGpu(sim).probe('povTrace', { starts, ends });
  if (!read) return null; // kernels not ready: do not bypass unknown live cells
  const farCell = sim.g.windowed ? grappleFarCells(world) : null;
  const origin = sim.origin?.clone() ?? new THREE.Vector3();
  let far = null, knownDistance = range;
  if (sim.g.windowed) {
    voxelWalk(eye, dir, range, (x, y, z, dist, axis, step) => {
      if (grappleResident(sim.g, { x, y, z })) return;
      // Above the open top is known air even without a CPU source.
      if (y >= sim.g.ny) return;
      if (!farCell) { knownDistance = dist; return true; }
      const id = farCell(x + origin.x, y, z + origin.z);
      if (axis >= 0 && stops(id)) {
        far = { id, cell: new THREE.Vector3(x, Math.max(-1, y), z), face: axis * 2 + (step > 0 ? 1 : 0),
          dist, point: eye.clone().addScaledVector(dir, dist) };
        return true;
      }
    });
  }
  const b = new Float32Array(await read);
  let live = null;
  if (Math.round(b[3]) !== TRACE_MISS) {
    const at = 2 * TRACE.ROUNDS * 4;
    live = { cell: new THREE.Vector3(b[0], b[1], b[2]), face: Math.round(b[3]),
      id: Math.round(b[TRACE.ROUNDS * 4 + 3]), dist: b[at + 3] * range,
      point: new THREE.Vector3(b[at], b[at + 1], b[at + 2]) };
  }
  const hit = live && (!far || live.dist <= far.dist) ? live : far;
  // Do not shoot through unqueryable procedural terrain to a distant actor.
  return { hit: hit && hit.dist <= knownDistance ? hit : null, distance: Math.min(knownDistance, hit?.dist ?? range) };
}
