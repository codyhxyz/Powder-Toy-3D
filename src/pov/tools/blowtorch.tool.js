import * as THREE from 'three';
import { ELEMENTS } from '../../elements.js';
import { torchFrag, toolPass, TORCH } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';
import { bodyExit } from './transfer.js';
import { toolDt } from './action.js';
import { gear } from './catalog.js';

// Blowtorch: hold left-click for a roofing torch's flame
// (shaders/povTools.js torchFrag and TORCH). The flame is engine FIRE at a
// propane flame's 1,900 °C, blown along the aim, and what it touches heats up
// toward that; the engine decides what happens: wood and plants catch,
// gunpowder goes off, ice melts, metal glows and slowly melts to lava. While
// it burns, the readout shows the temperature of what the flame is on.
//
// Events: tool:action 'on' / 'off' when the flame lights and goes out.

const NOZZLE_REACH = 1.5;    // cells from the eye to the nozzle (arm's length and the torch)
const BODY_CLEARANCE = 0.3;  // cells: the flame starts this far outside the body
const FLICKER = 0.25;        // the held flame's length varies by this share, frame to frame

// viewmodel, in cells (camera space)
const HELD_POS = [0.55, -0.6, -1.3];

export default {
  ...gear('BLOWTORCH'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const mesh = attachModel(hand, 'torch');
    const flame = mesh.obj.getObjectByName('flame');
    flame.visible = false;
    const baseLen = flame.scale.y;
    const pass = toolPass(torchFrag, () => ({
      uNozzle: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
      uReach: { value: 0 }, uDt: { value: 0 }, uFrame: { value: 0 },
    }));
    let burning = false, frame = 0;
    const nozzle = new THREE.Vector3();

    function setBurning(on) {
      if (on === burning) return;
      burning = on;
      flame.visible = on;
      povEvents.emit('tool:action', { tool: 'blowtorch', action: on ? 'on' : 'off' });
    }

    // cells from the eye to the nozzle along the aim: arm's length, and never inside the body
    function nozzleT(ctx) {
      const feet = ctx.player?.pos;
      return Math.max(NOZZLE_REACH, feet ? bodyExit(ctx.eye, ctx.dir, feet, BODY_CLEARANCE) : 0);
    }

    function burn(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const t = nozzleT(ctx);
      nozzle.copy(ctx.eye).addScaledVector(dir, t);
      const aim = ctx.aim;
      const toFace = aim?.valid && Number.isFinite(aim.dist) ? aim.dist - t : Infinity;
      const mat = pass(sim);
      const u = mat.uniforms;
      u.uNozzle.value.copy(nozzle);
      u.uDir.value.copy(dir);
      u.uReach.value = THREE.MathUtils.clamp(toFace, 0, TORCH.LENGTH);
      u.uDt.value = toolDt(ctx);
      u.uFrame.value = ++frame;
      sim.pass(mat);
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        setBurning(!!ctx.primary);
        if (burning) {
          burn(ctx);
          flame.scale.y = baseLen * (1 + (Math.random() - 0.5) * 2 * FLICKER);
        }
      },
      deselect() { hand.visible = false; setBurning(false); },
      // the temperature of what the flame is on, while it burns
      readout(ctx) {
        const a = ctx.aim;
        if (!burning || !a?.valid || a.id < 0 || !(a.dist <= nozzleT(ctx) + TORCH.LENGTH + TORCH.BITE)) return null;
        const el = ELEMENTS[a.id];
        return { name: el.name, color: el.color, T: a.T };
      },
      get burning() { return burning; },
      get nozzle() { return nozzle; },   // for checks: grid cells
      dispose() { setBurning(false); pass.dispose(); mesh.dispose(); hand.removeFromParent(); },
    };
  },
};
