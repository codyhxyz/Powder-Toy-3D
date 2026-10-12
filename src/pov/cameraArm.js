import * as THREE from 'three';
import { TRACE, TRACE_MISS, TRACE_SIGHT } from '../shaders/povTrace.js';
import { povGpu } from './gpu.js';
import { PROBE_OUTSIDE } from '../shaders/povBody.js';
import { ELEMENTS, E, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { voxelRay } from './ai/world.js';

// The camera's spring arm: the third-person and death cameras come in where
// matter stands between them and the body, instead of sitting inside it.
// Minecraft's (Camera.getMaxZoom): eight rays, from the corners of a small cube
// around the body end to the same corners around the camera's spot, and the
// camera comes in to the nearest hit, so its near plane never reaches into a
// wall. Powders and solids stop a ray; liquids let it through (Minecraft's
// ClipContext.Fluid.NONE: a swimmer's camera stays behind the swimmer).
//
// The rays run twice. On the GPU, through the guns' trace (shaders/
// povTrace.js traceFrag, TRACE_SIGHT segments, into its result ring:
// docs/webgpu.md B7), so every cell is the sim's own, at any world size; an
// answer lands a frame or two after it is asked (several are in flight, so one
// lands about every frame). And at once on the
// CPU, through the cells around the body that its probe read (player.js
// cellAt), so an arm swung fast into a slope comes in on the same frame
// rather than a trace later. The arm takes whichever is shorter.
//
// Each frame: want(k, from, to) for each arm in use (grid cells), then
// trace(sim) once. share(k) is the share of the arm from `from` that is
// clear, 0..1. An arm with no GPU answer yet (just taken up, or a new world)
// is 0: the camera holds in at the body until a trace finds room.

const RAYS = 8;                         // the cube's corners
export const ARMS = TRACE.ROUNDS / RAYS;   // arms traced at once (the trace's rounds / 8)
const CORNER = 0.1 / CELL_M;            // cells, half the cube's side: Minecraft's 0.1 blocks (m)
const INFLIGHT = 3;                     // readbacks in flight at once
const RGBA = 4;
const KIND = ELEMENTS.map((e) => e.kind);
// what stops the arm on the CPU: the box's walls and floor, powders and solids (as TRACE_SIGHT);
// an unknown cell (past the probe, any other negative id) doesn't: the GPU's answer covers it
const STOPS = (id) => id === PROBE_OUTSIDE || (id >= 0 && id !== E.EMPTY && (KIND[id] === K.SOLID || KIND[id] === K.POWDER));

// cellAt(x, y, z): the CPU's cells (player.js cellAt); top: the grid's height
export function createCameraArm({ cellAt, top }) {
  const share = new Float32Array(ARMS);   // the GPU's latest answers
  const near = new Float32Array(ARMS).fill(1);   // the CPU's, this frame
  const o = new THREE.Vector3(), d = new THREE.Vector3(), hit = {};
  // on: wanted this frame so far; used: wanted the frame of the last trace
  const asked = [...Array(ARMS)].map(() => ({ on: false, used: false, from: new THREE.Vector3(), to: new THREE.Vector3(), size: 1 }));
  const starts = [...Array(TRACE.ROUNDS)].map(() => [0, 0, 0, 0]);
  const ends = [...Array(TRACE.ROUNDS)].map(() => [0, 0, 0, 0]);
  let simId = -1, tracing = 0;
  let seq = 0, landed = -1;   // answers may resolve out of order: only a newer one counts

  function ensureWorld(sim) {
    if (sim.id === simId) return;
    simId = sim.id;
    share.fill(0);
    landed = seq;   // answers about the old world don't count
  }

  return {
    // arm k this frame: from the body end to the camera's spot (grid cells);
    // size scales the corner cube (the body's own size: Shrink)
    want(k, from, to, size = 1) {
      const a = asked[k];
      a.on = true; a.from.copy(from); a.to.copy(to); a.size = size;
      const len = d.subVectors(to, from).length();
      near[k] = 1;
      if (!(len > 0)) return;
      d.divideScalar(len);
      const c = CORNER * size, h = top();
      for (let r = 0; r < RAYS; r++) {
        o.set(from.x + (r & 1 ? c : -c), from.y + (r & 2 ? c : -c), from.z + (r & 4 ? c : -c));
        if (voxelRay(cellAt, h, o, d, len, STOPS, hit).valid) near[k] = Math.min(near[k], hit.dist / len);
      }
    },
    share: (k) => Math.min(share[k], near[k]),
    trace(sim) {
      ensureWorld(sim);
      for (let k = 0; k < ARMS; k++) {
        const a = asked[k];
        a.used = a.on; a.on = false;
        if (!a.used) share[k] = 0;   // an arm out of use forgets its answer
      }
      if (tracing >= INFLIGHT || !asked.some((a) => a.used)) return;
      const on = asked.map((a) => a.used);
      asked.forEach((a, k) => {
        for (let r = 0; r < RAYS; r++) {
          const i = k * RAYS + r, from = starts[i], to = ends[i];
          if (!a.used) { from[3] = 0; continue; }
          const c = CORNER * a.size;
          const dx = (r & 1 ? c : -c), dy = (r & 2 ? c : -c), dz = (r & 4 ? c : -c);
          from[0] = a.from.x + dx; from[1] = a.from.y + dy; from[2] = a.from.z + dz; from[3] = TRACE_SIGHT;
          to[0] = a.to.x + dx; to[1] = a.to.y + dy; to[2] = a.to.z + dz;
        }
      });
      const read = povGpu(sim).probe('povTrace', { starts, ends });
      if (!read) return;   // (its kernel is still building: B5)
      tracing++;
      const mySeq = ++seq, mySim = simId;
      read.then((bytes) => {
        tracing--;
        if (mySim !== simId || mySeq <= landed) return;
        landed = mySeq;
        const b = new Float32Array(bytes);
        for (let k = 0; k < ARMS; k++) {
          if (!on[k] || !asked[k].used) continue;   // (put down since: it stays forgotten)
          let clear = 1;
          for (let r = 0; r < RAYS; r++) {
            const i = k * RAYS + r;
            if (Math.round(b[i * RGBA + 3]) === TRACE_MISS) continue;   // row 0: the face, or a miss
            clear = Math.min(clear, b[(2 * TRACE.ROUNDS + i) * RGBA + 3]);   // row 2: the share flown to the hit
          }
          share[k] = clear;
        }
      }).catch(() => { tracing--; });
    },
    dispose() { simId = -1; },
  };
}
