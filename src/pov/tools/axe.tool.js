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
// The swing is Half-Life 2's crowbar (source-sdk-2013 basebludgeonweapon.cpp,
// weapon_crowbar.h): the blow lands on the frame you click, not after a
// wind-up; holding the button swings again every REFIRE; a hit throws the view
// punch (feel.js) and the blade stops at the wood and rebounds, a miss follows
// through. A click during the refire wait is kept and swings as soon as it can.
//
// Events: tool:action 'swing' on every swing; when the blade lands on
// something, impact (source 'axe') and the rig's kick, plus tool:action
// 'refuse' if the struck cell is a solid the blow can't break.

const REFIRE = 0.4;          // s between swings (HL2 CROWBAR_REFIRE)
const STRIKE_TIME = 0.06;    // s for the blade to come down (the blow itself lands at once)
const SETTLE_TIME = REFIRE;  // s from the swing to back at rest, ready for the next

// viewmodel, in cells (camera space: +x right, +y up, −z forward); the
// model's origin is the end of the handle, in the hand
const AXE_POS = [0.7, -0.95, -1.55];
const REST_PITCH = 0.35;     // rad, held up and back
const HIT_PITCH = -0.55;     // rad, blade down where it bit into something
const MISS_PITCH = -1.15;    // rad, blade down past the aim: a miss follows through
const REST_ROLL = -0.25;     // rad, tilted in toward the crosshair

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M14 3l7 7-3 3-2-2-9 9-2-2 9-9-2-2z"/><path d="M14 3c-3 0-5 2-5 5l3 1"/></svg>`;

// The held axe: the model (models.js) on a hand of the
// viewmodel rig, turned about the hand by the swing.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(AXE_POS);
  const pivot = new THREE.Group();   // the axe turns about the hand
  hand.add(pivot);
  const mesh = attachModel(pivot, 'axe');
  return { rig, hand, pivot, dispose() { mesh.dispose(); hand.removeFromParent(); } };
}

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutQuad = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

// Swing pose: a fast eased chop from rest to `low`, then eased back to rest.
function swingPitch(t, low) {
  if (t < 0 || t >= SETTLE_TIME) return REST_PITCH;
  if (t < STRIKE_TIME) return THREE.MathUtils.lerp(REST_PITCH, low, easeOutCubic(t / STRIKE_TIME));
  return THREE.MathUtils.lerp(low, REST_PITCH, easeInOutQuad((t - STRIKE_TIME) / (SETTLE_TIME - STRIKE_TIME)));
}

export default {
  key: 'AXE', name: 'Axe', slot: 3, icon: ICON,
  desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.',
  create(env) {
    const model = buildModel(env);
    const pass = toolPass(axeFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
    let time = 0, swingAt = -Infinity, nextSwing = 0, queued = false, low = REST_PITCH;
    let lastHit = null;

    function strike(ctx) {
      const aim = ctx.aim;
      if (!aim?.valid || aim.dist > HAND_REACH || aim.cell.y < 0) return false;   // air, or the floor
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
      return true;
    }

    return {
      update(ctx) {
        time += ctx.dt;
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.primaryPressed) queued = true;
        if ((ctx.primary || queued) && time >= nextSwing) {
          swingAt = time; nextSwing = time + REFIRE; queued = false;
          povEvents.emit('tool:action', { tool: 'axe', action: 'swing' });
          low = strike(ctx) ? HIT_PITCH : MISS_PITCH;
        }
        model.pivot.rotation.set(swingPitch(time - swingAt, low), 0, REST_ROLL);
      },
      deselect() { model.hand.visible = false; queued = false; },
      status: () => null,
      get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
      dispose() { pass.dispose(); model.dispose(); },
    };
  },
};
