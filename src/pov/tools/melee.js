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
//   export default meleeTool({ ...gear(KEY),   // the tool definition (catalog.js, docs/pov.md)
//     blow, frag,              // the blow's tuning (ENERGY ...) and its pass
//     hit,                     // viewmodel.js HIT row for a landed blow
//     refire,                  // s between swings
//     reach?,                  // cells from the eye a blow lands (HAND_REACH)
//     body: { damage, energy, cause },   // a blow on a body (an NPC): health taken, impact energy, cause of death
//     bodyBlow?(ctx, target),  // this blow on this body, instead of `body` and `hit`: { damage, energy, cause,
//                              //   hit, lethal } (lethal: all its health, through any shield), or null (the knife's backstab)
//     tell?(ctx, target),      // true while the next blow would be special: the held model eases to pose.ready
//                              //   (the knife raised for a backstab); target is the body in reach (rayTarget), or null
//     pose: { pos, rest, hit, miss, roll, strike,   // the held model, in cells and rad (camera space)
//             thrust?: [hit, miss],                 // cells it drives forward on a blow: a stab, not a chop
//             ready?, readyPos?: [x, y, z],         // rad and cells offset while tell() holds
//             lethal?: { hit, miss, thrust } } });  // a lethal blow's own motion (the backstab's plunge)

const TELL_RATE = 12;   // 1/s: the tell (pose.ready) eases in and out this fast, about 0.1 s (by eye, TF2's knife raise is a few frames)

export function meleeTool({ key, name, model: modelKey, desc, blow, frag, hit: HIT_ROW, refire, reach = HAND_REACH, body: BODY, bodyBlow, tell, pose: POSE }) {
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
    key, name, model: modelKey, desc,
    create(env) {
      const model = buildModel(env);
      const pass = toolPass(frag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
      const button = trigger(refire);
      const motion = (m) => ({ rest: POSE.rest, hit: m.hit, miss: m.miss, strike: POSE.strike, settle: refire });
      const pose = swing(motion(POSE));
      const lethalPose = POSE.lethal ? swing(motion(POSE.lethal)) : pose;
      const thrust = (m) => swing({ rest: 0, hit: m?.thrust?.[0] ?? 0, miss: m?.thrust?.[1] ?? 0, strike: POSE.strike, settle: refire });
      const push = thrust({ thrust: POSE.thrust }), lethalPush = thrust({ thrust: POSE.lethal?.thrust });
      let turning = pose, driving = push, tellK = 0, telling = false;
      let lastHit = null;

      // the body (an NPC) in reach and nearer than the struck cell, or null
      const bodyInReach = (ctx) => rayTarget(ctx.eye, ctx.dir.clone().normalize(), Math.min(reach, ctx.aim?.valid ? ctx.aim.dist : Infinity), povEvents.actor?.id ?? PLAYER);

      // { landed, lethal }
      function strike(ctx) {
        const aim = ctx.aim;
        const target = bodyInReach(ctx);
        if (target) {
          const b = bodyBlow?.(ctx, target) ?? null;
          const lethal = !!b?.lethal;
          target.target.hurt(b?.damage ?? BODY.damage, b?.cause ?? BODY.cause, ctx.dir.clone().normalize(), lethal ? { lethal } : undefined);
          povEvents.emit('impact', { source, point: target.point, normal: ctx.dir.clone().negate(), id: -1, energy: b?.energy ?? BODY.energy, broke: null, body: true, backstab: lethal });
          model.rig.hit(b?.hit ?? HIT_ROW);
          return { landed: true, lethal };
        }
        if (!aim?.valid || aim.dist > reach || aim.cell.y < 0) return { landed: false };   // air, or the floor
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
        return { landed: true };
      }

      return {
        update(ctx) {
          model.hand.visible = true;
          model.rig.update(ctx);
          const dt = toolDt(ctx);
          // the tell: the next blow would be special (a backstab lined up)
          telling = !!tell?.(ctx, bodyInReach(ctx));
          tellK += ((telling ? 1 : 0) - tellK) * (1 - Math.exp(-TELL_RATE * dt));
          if (button.ready(ctx)) {
            button.fire();
            povEvents.emit('tool:action', { tool: source, action: 'swing' });
            const r = strike(ctx);
            turning = r.lethal ? lethalPose : pose;
            driving = r.lethal ? lethalPush : push;
            turning.start(r.landed);
            driving.start(r.landed);
          }
          // the swing's turn and drive, on top of the rest pose eased toward the tell's
          const restAngle = POSE.rest + tellK * ((POSE.ready ?? POSE.rest) - POSE.rest);
          model.pivot.rotation.set(restAngle + turning.angle(dt) - POSE.rest, 0, POSE.roll);
          const rp = POSE.readyPos ?? [0, 0, 0];
          model.pivot.position.set(rp[0] * tellK, rp[1] * tellK, rp[2] * tellK - driving.angle(dt));
        },
        deselect() { model.hand.visible = false; button.reset(); pose.stop(); lethalPose.stop(); push.stop(); lethalPush.stop(); tellK = 0; telling = false; },
        status: () => null,
        get telling() { return telling; },   // for checks: the tell (pose.ready) is up
        windowShifted(dx, dz) { if (lastHit) { lastHit.cell.x -= dx; lastHit.cell.z -= dz; } },   // (docs/scaling.md D11)
        get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
        dispose() { pass.dispose(); model.dispose(); },
      };
    },
  };
}
