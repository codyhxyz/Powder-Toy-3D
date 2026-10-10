import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { HAND_REACH } from '../constants.js';
import { toolPass } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';
import { trigger, swing, toolDt } from './action.js';
import { faceNormal } from './transfer.js';
import { rayTarget, PLAYER } from '../targets.js';

// A melee tool (the axe, the pickaxe): a short-range swing that breaks
// breakable solids in a patch around the struck cell into their debris
// (shaders/povTools.js blowFrag; spec.blow is its tuning, AXE or PICK, and
// spec.frag its pass). Every break swaps one element for its debris in place,
// so mass is conserved. What one tool breaks and another bounces off is only
// the blow's energy against each element's hardness.
//
// The swing is Half-Life 2's crowbar (source-sdk-2013 basebludgeonweapon.cpp,
// weapon_crowbar.h), from the shared pieces in action.js and viewmodel.js HIT:
// the blow lands on the frame you click, holding swings again every refire, a
// hit throws the hand's kick and the view punch and the head stops where it
// bit, a miss follows through.
//
// Events (tool = the key in lower case): tool:action 'swing' on every swing;
// when the head lands on something, impact (source = tool) and the rig's kick,
// plus tool:action 'refuse' if the struck cell is a solid the blow can't break.
//
//   export default meleeTool({ key, name, slot, model, desc,   // the tool definition (docs/pov.md)
//     blow, frag,              // the blow's tuning (ENERGY ...) and its pass
//     hit,                     // viewmodel.js HIT row for a landed blow
//     refire,                  // s between swings
//     body: { damage, energy, cause },   // a blow on a body (an NPC): health taken, impact energy, cause of death
//     pose: { pos, rest, hit, miss, roll, strike } });   // the held model, in cells and rad (camera space)

export function meleeTool({ key, name, slot, model: modelKey, desc, blow, frag, hit: HIT_ROW, refire, body: BODY, pose: POSE }) {
  const source = key.toLowerCase();

  // The held tool: the model (models.js) on a hand of the viewmodel rig, turned about the hand by the swing.
  function buildModel(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(POSE.pos);
    const pivot = new THREE.Group();
    hand.add(pivot);
    const mesh = attachModel(pivot, modelKey);
    return { rig, hand, pivot, dispose() { mesh.dispose(); hand.removeFromParent(); } };
  }

  return {
    key, name, slot, model: modelKey, desc,
    create(env) {
      const model = buildModel(env);
      const pass = toolPass(frag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
      const button = trigger(refire);
      const pose = swing({ rest: POSE.rest, hit: POSE.hit, miss: POSE.miss, strike: POSE.strike, settle: refire });
      let lastHit = null;

      function strike(ctx) {
        const aim = ctx.aim;
        // a body (an NPC) in reach and nearer than the struck cell takes the blow
        const target = rayTarget(ctx.eye, ctx.dir.clone().normalize(), Math.min(HAND_REACH, aim?.valid ? aim.dist : Infinity), povEvents.actor?.id ?? PLAYER);
        if (target) {
          target.target.hurt(BODY.damage, BODY.cause, ctx.dir.clone().normalize());
          povEvents.emit('impact', { source, point: target.point, normal: ctx.dir.clone().negate(), id: -1, energy: BODY.energy, broke: null, body: true });
          model.rig.hit(HIT_ROW);
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
        const broke = solid ? Boolean(el.breakInto) && blow.ENERGY >= el.hard : null;
        const point = aim.cell.clone().addScalar(0.5);
        povEvents.emit('impact', { source, point, normal: faceNormal(aim.face), id: aim.id, energy: blow.ENERGY, broke });
        model.rig.hit(HIT_ROW);
        if (broke === false) povEvents.emit('tool:action', { tool: source, action: 'refuse', id: aim.id, point });
        return true;
      }

      return {
        update(ctx) {
          model.hand.visible = true;
          model.rig.update(ctx);
          if (button.ready(ctx)) {
            button.fire();
            povEvents.emit('tool:action', { tool: source, action: 'swing' });
            pose.start(strike(ctx));
          }
          model.pivot.rotation.set(pose.angle(toolDt(ctx)), 0, POSE.roll);
        },
        deselect() { model.hand.visible = false; button.reset(); pose.stop(); },
        status: () => null,
        windowShifted(dx, dz) { if (lastHit) { lastHit.cell.x -= dx; lastHit.cell.z -= dz; } },   // (docs/scaling.md D11)
        get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
        dispose() { pass.dispose(); model.dispose(); },
      };
    },
  };
}
