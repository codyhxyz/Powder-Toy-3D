// Whitewater's aeration field (shaders/gfx/liquidDetail.js aerationFrag): a
// per-cell texture, in the state's atlas layout, that the simulation advances
// once per step right after its move (Simulation.step calls aeration.step),
// so foam is carried by the liquid, bursts and rises on the sim's clock. It
// is render state only: the simulation never reads it.
//
// It runs only while the Whitewater switch is on (gfx/detail.js liquidFoam):
// off, a step costs nothing extra. Its targets are kept, and switching it
// back on resumes them if the world hasn't stepped meanwhile (else it starts
// clear). Anything that replaces the state (loads, undo) clears it
// (Simulation.stillFlow); a window shift moves it with the cells.
//
// It draws every cell, not only the supertiles a step draws: a resting pool
// goes quiet and its supertiles sleep, but the foam on it must still burst.
// Likewise an idle world (Simulation.step returns early) keeps stepping it,
// with every cell held in place, for AER_IDLE_STEPS, then clears it.
import * as THREE from 'three';
import { makeFieldTarget, rawMat } from '../sim.js';
import { stateUniforms } from '../shaders/common.js';
import { aerationFrag, AER_IDLE_STEPS } from '../shaders/gfx/liquidDetail.js';

// (aeration, liquid, fall speed, grounded) per cell, half floats, read by
// texelFetch (the renderer filters it by hand: liquidDetail.js aerationAt)
const makeTarget = (g) => makeFieldTarget(g.width, g.height, 1, THREE.HalfFloatType, THREE.NearestFilter);

function createAeration(sim) {
  const g = sim.g, renderer = sim.renderer;
  const targets = [makeTarget(g), makeTarget(g)];
  let cur = 0;
  let idleSteps = 0;   // idle steps run since the world went idle
  const mat = Object.assign(rawMat(aerationFrag(g), {
    ...stateUniforms(), tAerPrev: { value: null }, tQuiet: { value: null }, uStill: { value: false },
    uParity: { value: 0 }, tSlots: { value: null },
  }), { name: 'aeration' });
  const run = (still) => {
    const u = mat.uniforms, before = sim.targets[1 - sim.cur];
    u.tA.value = before.textures[0];
    u.tB.value = before.textures[1];
    u.tAerPrev.value = targets[cur].texture;
    u.tQuiet.value = sim.actQuiet.texture;
    u.uParity.value = sim.frame & 1;
    u.tSlots.value = sim.slots.texture;
    u.uStill.value = still;
    cur = 1 - cur;
    sim.run(mat, targets[cur]);
  };
  const aer = {
    enabled: true,
    stale: false,   // the world stepped while it was off
    get texture() { return targets[cur].texture; },
    get target() { return targets[cur]; },   // (tools read the field back)
    // after the move's gather, before react: sim.targets[1 - sim.cur] still
    // holds the state before the move, sim.slots the move's slots
    step() {
      if (!aer.enabled) { aer.stale = true; return; }
      idleSteps = 0;
      run(false);
    },
    // a step the world skipped (idle): nothing moves, both state copies agree
    idle() {
      if (!aer.enabled) { aer.stale = true; return; }
      if (idleSteps > AER_IDLE_STEPS) return;
      if (idleSteps++ === AER_IDLE_STEPS) { aer.reset(); return; }
      run(true);
    },
    // the window moved by the shift fs is set up for (Simulation.shift): move the field with it
    shift(fs) {
      fs.uniforms.tFlowSrc.value = targets[cur].texture;
      sim.run(fs, targets[1 - cur]);
      cur = 1 - cur;
    },
    reset() {
      const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      for (const t of targets) { renderer.setRenderTarget(t); renderer.clear(true, false, false); }
      renderer.setClearColor(clear, alpha);
      aer.stale = false;
      idleSteps = AER_IDLE_STEPS + 1;   // nothing left to burst
    },
    dispose() {
      targets.forEach((t) => t.dispose());
      mat.dispose();
    },
  };
  aer.reset();
  return aer;
}

// Switch sim's aeration field on or off (created the first time it is on).
export function setAeration(sim, on) {
  if (!on) { if (sim.aeration) sim.aeration.enabled = false; return; }
  sim.aeration ??= createAeration(sim);
  if (!sim.aeration.enabled && sim.aeration.stale) sim.aeration.reset();
  sim.aeration.enabled = true;
}
