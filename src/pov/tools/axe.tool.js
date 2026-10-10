import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import { axeFrag, toolPass, AXE } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { trigger, swing } from './action.js';
import { faceNormal } from './transfer.js';
import { rayTarget, PLAYER } from '../targets.js';

// Axe: a short-range swing that breaks breakable solids in a wide, shallow
// patch around the struck cell into their debris (shaders/povTools.js axeFrag
// and AXE for the energy and tuning). Weaker and less focused than the gun:
// it chops wood where it lands, smashes glass, ice and plants around that,
// and bounces off rock and metal. Every break swaps one element for its
// debris in place, so mass is conserved.
//
// The swing is Half-Life 2's crowbar (source-sdk-2013 basebludgeonweapon.cpp,
// weapon_crowbar.h), from the shared pieces in action.js and viewmodel.js HIT:
// the blow lands on the frame you click, holding swings again every REFIRE, a
// hit throws the hand's kick and the view punch and the blade stops at the
// wood, a miss follows through.
//
// Events: tool:action 'swing' on every swing; when the blade lands on
// something, impact (source 'axe') and the rig's kick, plus tool:action
// 'refuse' if the struck cell is a solid the blow can't break.

const REFIRE = 0.4;          // s between swings (HL2 CROWBAR_REFIRE)
const BODY_DAMAGE = 0.34;    // health a blow takes from a body (an NPC): three blows kill
const BODY_ENERGY = 40;      // the impact's energy for the shake and hitmarker
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

export default {
  key: 'AXE', name: 'Axe', slot: 3, icon: ICON,
  desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.',
  create(env) {
    const model = buildModel(env);
    const pass = toolPass(axeFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
    const button = trigger(REFIRE);
    const pose = swing({ rest: REST_PITCH, hit: HIT_PITCH, miss: MISS_PITCH, strike: STRIKE_TIME, settle: SETTLE_TIME });
    let lastHit = null;

    function strike(ctx) {
      const aim = ctx.aim;
      // a body (an NPC) in reach and nearer than the struck cell takes the blow
      const body = rayTarget(ctx.eye, ctx.dir.clone().normalize(), Math.min(HAND_REACH, aim?.valid ? aim.dist : Infinity), povEvents.actor?.id ?? PLAYER);
      if (body) {
        body.target.hurt(BODY_DAMAGE, 'Axed', ctx.dir.clone().normalize());
        povEvents.emit('impact', { source: 'axe', point: body.point, normal: ctx.dir.clone().negate(), id: -1, energy: BODY_ENERGY, broke: null, body: true });
        model.rig.hit(HIT.AXE);
        return true;
      }
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
      model.rig.hit(HIT.AXE);
      if (broke === false) povEvents.emit('tool:action', { tool: 'axe', action: 'refuse', id: aim.id, point });
      return true;
    }

    return {
      update(ctx) {
        model.hand.visible = true;
        model.rig.update(ctx);
        if (button.ready(ctx)) {
          button.fire();
          povEvents.emit('tool:action', { tool: 'axe', action: 'swing' });
          pose.start(strike(ctx));
        }
        model.pivot.rotation.set(pose.angle(ctx.dt), 0, REST_ROLL);
      },
      deselect() { model.hand.visible = false; button.reset(); pose.stop(); },
      status: () => null,
      windowShifted(dx, dz) { if (lastHit) { lastHit.cell.x -= dx; lastHit.cell.z -= dz; } },   // (docs/scaling.md D11)
      get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
      dispose() { pass.dispose(); model.dispose(); },
    };
  },
};
