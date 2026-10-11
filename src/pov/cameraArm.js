import * as THREE from 'three';
import { quadVert } from '../shaders/common.js';
import { traceFrag, TRACE, TRACE_MISS, TRACE_SIGHT } from '../shaders/povTrace.js';
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
// The rays run twice. On the GPU, through the guns' trace pass (shaders/
// povTrace.js traceFrag, TRACE_SIGHT segments), so every cell is the sim's
// own, at any world size; an answer lands a frame or two after it is asked
// (several are in flight, so one lands about every frame). And at once on the
// CPU, through the cells around the body that its probe read (player.js
// cellAt), so an arm swung fast into a slope comes in on the same frame
// rather than a trace later. The arm takes whichever is shorter.
//
// Each frame: want(k, from, to) for each arm in use (grid cells), then
// trace(sim) once. share(k) is the share of the arm from `from` that is
// clear, 0..1. An arm with no GPU answer yet (just taken up, or a new world)
// is 0: the camera holds in at the body until a trace finds room.

const RAYS = 8;                         // the cube's corners
export const ARMS = TRACE.ROUNDS / RAYS;   // arms traced at once (the pass's texels / 8)
const CORNER = 0.1 / CELL_M;            // cells, half the cube's side: Minecraft's 0.1 blocks (m)
const INFLIGHT = 3;                     // readbacks in flight at once
const RGBA = 4;
const KIND = ELEMENTS.map((e) => e.kind);
// what stops the arm on the CPU: the box's walls and floor, powders and solids (as TRACE_SIGHT);
// an unknown cell (past the probe, any other negative id) doesn't: the GPU's answer covers it
const STOPS = (id) => id === PROBE_OUTSIDE || (id >= 0 && id !== E.EMPTY && (KIND[id] === K.SOLID || KIND[id] === K.POWDER));

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}

// cellAt(x, y, z): the CPU's cells (player.js cellAt); top: the grid's height
export function createCameraArm({ renderer, cellAt, top }) {
  const share = new Float32Array(ARMS);   // the GPU's latest answers
  const near = new Float32Array(ARMS).fill(1);   // the CPU's, this frame
  const o = new THREE.Vector3(), d = new THREE.Vector3(), hit = {};
  // on: wanted this frame so far; used: wanted the frame of the last trace
  const asked = [...Array(ARMS)].map(() => ({ on: false, used: false, from: new THREE.Vector3(), to: new THREE.Vector3(), size: 1 }));
  const slots = [...Array(INFLIGHT)].map(() => ({
    target: new THREE.WebGLRenderTarget(TRACE.ROUNDS, TRACE.ROWS, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    }),
    buf: new Float32Array(TRACE.ROUNDS * TRACE.ROWS * RGBA), busy: false,
  }));
  let mat = null, simId = -1, compiled = false;
  let seq = 0, landed = -1;   // answers may resolve out of order: only a newer one counts

  function ensureMat(sim) {
    if (sim.id === simId) return;
    mat?.dispose();
    mat = rawMat(traceFrag(sim.g), {
      tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tBrickDist: { value: null }, tLight: { value: null },
      uFrom: { value: [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector4()) },
      uTo: { value: [...Array(TRACE.ROUNDS)].map(() => new THREE.Vector3()) },
    });
    simId = sim.id;
    compiled = false;
    share.fill(0);
    landed = seq;   // answers about the old world don't count
    // compile in the background (the guns' pass is the same program: usually built already)
    const built = mat, keep = sim.quad.material;
    sim.quad.material = mat;
    // (failing that, the first trace compiles it)
    const done = () => { if (mat === built) compiled = true; };
    renderer.compileAsync(sim.scene, sim.camera).then(done, done);
    sim.quad.material = keep;
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
      ensureMat(sim);
      for (let k = 0; k < ARMS; k++) {
        const a = asked[k];
        a.used = a.on; a.on = false;
        if (!a.used) share[k] = 0;   // an arm out of use forgets its answer
      }
      const slot = slots.find((s) => !s.busy);
      if (!compiled || !slot || !asked.some((a) => a.used)) return;
      const u = mat.uniforms;
      const on = asked.map((a) => a.used);
      asked.forEach((a, k) => {
        for (let r = 0; r < RAYS; r++) {
          const i = k * RAYS + r, from = u.uFrom.value[i], to = u.uTo.value[i];
          if (!a.used) { from.w = 0; continue; }
          const c = CORNER * a.size;
          const dx = (r & 1 ? c : -c), dy = (r & 2 ? c : -c), dz = (r & 4 ? c : -c);
          from.set(a.from.x + dx, a.from.y + dy, a.from.z + dz, TRACE_SIGHT);
          to.set(a.to.x + dx, a.to.y + dy, a.to.z + dz);
        }
      });
      u.tA.value = sim.stateA;
      u.tB.value = sim.stateB;
      u.tBrick.value = sim.brick.texture;
      u.tBrickDist.value = sim.brickDistTexture;
      sim.run(mat, slot.target);
      slot.busy = true;
      const mySeq = ++seq, mySim = simId;
      renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, TRACE.ROUNDS, TRACE.ROWS, slot.buf).then(() => {
        slot.busy = false;
        if (mySim !== simId || mySeq <= landed) return;
        landed = mySeq;
        const b = slot.buf;
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
      }).catch(() => { slot.busy = false; });
    },
    dispose() {
      slots.forEach((s) => s.target.dispose());
      mat?.dispose();
      mat = null; simId = -1;
    },
  };
}
