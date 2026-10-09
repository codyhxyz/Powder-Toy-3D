import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import { axeFrag, toolPass, AXE } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, KICK } from '../viewmodel.js';
import { faceNormal } from './transfer.js';

// Axe: a short-range swing that breaks breakable solids in a wide, shallow
// patch around the struck cell into their debris (shaders/povTools.js axeFrag
// and AXE for the energy and tuning). Weaker and less focused than the gun:
// it chops wood where it lands, smashes glass, ice and plants around that,
// and bounces off rock and metal. Every break swaps one element for its
// debris in place, so mass is conserved.
//
// A click starts the swing; the blade lands IMPACT_TIME later and strikes
// whatever is under the crosshair then, if it's within reach.
//
// Events: tool:action 'swing' on every click; when the blade lands on
// something, impact (source 'axe') and the rig's kick, plus tool:action
// 'refuse' if the struck cell is a solid the blow can't break.

const SWING_TIME = 0.42;     // s for a whole swing, wind-up to recovery
const IMPACT_TIME = 0.12;    // s into the swing that the blade lands
const SWING_INTERVAL = 0.5;  // s between swings

// viewmodel, in cells (camera space: +x right, +y up, −z forward); the
// model's origin is the end of the handle, in the hand
const AXE_POS = [0.7, -0.95, -1.55];
const REST_PITCH = 0.35;     // rad, held up and back
const RAISE_PITCH = 0.9;     // rad, top of the wind-up
const STRIKE_PITCH = -0.9;   // rad, blade down at impact
const REST_ROLL = -0.25;     // rad, tilted in toward the crosshair

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M14 3l7 7-3 3-2-2-9 9-2-2 9-9-2-2z"/><path d="M14 3c-3 0-5 2-5 5l3 1"/></svg>`;

// The held axe: the Kenney model (models.js, async) on a hand of the
// viewmodel rig, turned about the hand by the swing.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(AXE_POS);
  const pivot = new THREE.Group();   // the axe turns about the hand
  hand.add(pivot);
  const mesh = attachModel(pivot, 'axe');
  return { rig, hand, pivot, dispose() { mesh.dispose(); hand.removeFromParent(); } };
}

// Swing pose: rest → raise (wind-up) → strike at IMPACT_TIME → back to rest.
function swingPitch(t) {
  if (t < 0 || t >= SWING_TIME) return REST_PITCH;
  const windUp = IMPACT_TIME / 2;
  if (t < windUp) return THREE.MathUtils.lerp(REST_PITCH, RAISE_PITCH, t / windUp);
  if (t < IMPACT_TIME) return THREE.MathUtils.lerp(RAISE_PITCH, STRIKE_PITCH, (t - windUp) / (IMPACT_TIME - windUp));
  return THREE.MathUtils.lerp(STRIKE_PITCH, REST_PITCH, (t - IMPACT_TIME) / (SWING_TIME - IMPACT_TIME));
}

export default {
  key: 'AXE', name: 'Axe', slot: 3, icon: ICON,
  desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.',
  create(env) {
    const model = buildModel(env);
    const pass = toolPass(axeFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
    let time = 0, swingAt = -Infinity, nextSwing = 0, struck = true;
    let lastHit = null;

    function strike(ctx) {
      const aim = ctx.aim;
      if (!aim?.valid || aim.dist > HAND_REACH || aim.cell.y < 0) return;   // air, or the floor
      const sim = ctx.sim ?? env.getSim();
      const mat = pass(sim);
      mat.uniforms.uCenter.value.copy(aim.cell).addScalar(0.5);
      mat.uniforms.uDir.value.copy(ctx.dir).normalize();
      sim.pass(mat);
      lastHit = { cell: aim.cell.clone(), id: aim.id };
      // the struck cell breaks if the blow's full energy (it lands at the patch centre) beats its hardness
      const el = ELEMENTS[aim.id];
      const solid = el?.kind === K.SOLID;
      const broke = solid ? Boolean(el.breakInto) && AXE.ENERGY >= el.hard : null;
      const point = aim.cell.clone().addScalar(0.5);
      povEvents.emit('impact', { source: 'axe', point, normal: faceNormal(aim.face), id: aim.id, energy: AXE.ENERGY, broke });
      model.rig.kick(KICK.AXE);
      if (broke === false) povEvents.emit('tool:action', { tool: 'axe', action: 'refuse', id: aim.id, point });
    }

    return {
      update(ctx) {
        time += ctx.dt;
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.primaryPressed && time >= nextSwing) {
          swingAt = time; nextSwing = time + SWING_INTERVAL; struck = false;
          povEvents.emit('tool:action', { tool: 'axe', action: 'swing' });
        }
        if (!struck && time - swingAt >= IMPACT_TIME) { struck = true; strike(ctx); }
        model.pivot.rotation.set(swingPitch(time - swingAt), 0, REST_ROLL);
      },
      deselect() { model.hand.visible = false; struck = true; },
      status: () => null,
      get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
      dispose() { pass.dispose(); model.dispose(); },
    };
  },
};
