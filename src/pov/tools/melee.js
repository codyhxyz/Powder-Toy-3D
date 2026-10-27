import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { beforeControlContact } from '../electronicsInteractions.js';
import { HAND_REACH } from '../constants.js';
import { toolPass } from '../gpu.js';
import { flushNativeLaunch } from '../../v2/interactions.js';
import { povEvents } from '../events.js';
import { heldModel } from './held.js';
import { trigger, swing, toolDt } from './action.js';
import { faceNormal, pack, cellsNear } from './transfer.js';
import { digger } from './dig.js';
import { rayTarget, PLAYER, dealtScale } from '../targets.js';

// A melee tool (the axe, the pickaxe): a short-range swing that breaks
// breakable solids in a patch around the struck cell into their debris
// (shaders/povTools.js blowWGSL; spec.blow is its tuning, AXE or PICK, and
// spec.frag its pass: axeFrag, …). Every break swaps one element for its debris in place,
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
// plus tool:action 'refuse' if the struck cell is a solid the blow can't break
// (feedback.refuse, silent: the slot shakes, no toast).
//
//   export default meleeTool({ ...gear(KEY),   // the tool definition (catalog.js, docs/pov.md)
//     blow, frag,              // the blow's tuning (ENERGY ...) and its pass
//     hit,                     // viewmodel.js HIT row for a landed blow
//     refire, buffer?,         // s between swings; buffer: false drops cooldown taps
//     reach?,                  // cells from the eye a blow lands (HAND_REACH)
//     body: { damage, energy, cause },   // a blow on a body (an NPC): health taken, impact energy, cause of death
//     bodyBlow?(ctx, target),  // this blow on this body, instead of `body` and `hit`: { damage, energy, cause,
//                              //   hit, lethal } (lethal: all its health, through any shield), or null (the knife's backstab)
//     tell?(ctx, target),      // true while the next blow would be special: the held model eases to pose.ready
//                              //   (the knife raised for a backstab); target is the body in reach (rayTarget), or null
//     pose: { pos, rest, hit, miss, roll, strike,   // the held model, in cells and rad (camera space)
//             thrust?: [hit, miss],                 // cells it drives forward on a blow: a stab, not a chop
//             thrustAxis?: [x, y, z],               // unit drive direction (default forward); jackhammer drives down
//             gesture?: name,                      // holds.js third-person gesture override
//             ready?, readyPos?: [x, y, z],         // rad and cells offset while tell() holds
//             lethal?: { hit, miss, thrust } },     // a lethal blow's own motion (the backstab's plunge)
//     dig });                  // { power, tools }: the blow digs a whole lattice block instead (dig.js, the pickaxe):
//                              //   outlined, cracking over ceil(hard / power) blows, all of it into the pack;
//                              //   never a solid harder than blow.ENERGY
//
// What a blow breaks is the breaker's: every melee tool takes the debris in its
// patch (whatever broke there, and any debris already lying in it) into its own
// pack (transfer.js) right after the blow, exactly as the shovel would
// (Minecraft: a block you break is yours, picked up where you stand). Left lying,
// chopped leaves hung in the canopy as specks of sawdust and a mine's rubble
// stopped the next swing short of the face behind it; taken, the matter is
// conserved and the hole stays open. With the pack full it stays put.

// debris elements: what some breakable solid breaks into
const DEBRIS = [...new Set(ELEMENTS.filter((e) => e.breakInto).map((e) => ELEMENTS.findIndex((d) => d.key === e.breakInto)))];

const TELL_RATE = 12;   // 1/s: the tell (pose.ready) eases in and out this fast, about 0.1 s (by eye, TF2's knife raise is a few frames)

export function meleeTool({ key, name, model: modelKey, desc, blow, frag, hit: HIT_ROW, refire, buffer = true, reach = HAND_REACH, body: BODY, bodyBlow, tell, pose: POSE, dig = null }) {
  const source = key.toLowerCase();

  // The held tool: the model (models.js) on a hand of the viewmodel rig, turned about the hand by the swing.
  function buildModel(env) {
    const model = heldModel(env, { model: modelKey, pos: POSE.pos, pivot: true });
    // Third-person gestures are driven separately by held.js/holds.js.
    model.hand.userData.gesture = { since: Infinity, span: refire, name: POSE.gesture, axis: POSE.thrustAxis };
    return model;
  }

  return {
    key, name, model: modelKey, desc,
    create(env) {
      const model = buildModel(env);
      const pass = toolPass(frag);
      const button = trigger(refire, { buffer });
      const motion = (m) => ({ rest: POSE.rest, hit: m.hit, miss: m.miss, strike: POSE.strike, settle: refire });
      const pose = swing(motion(POSE));
      const lethalPose = POSE.lethal ? swing(motion(POSE.lethal)) : pose;
      const thrust = (m) => swing({ rest: 0, hit: m?.thrust?.[0] ?? 0, miss: m?.thrust?.[1] ?? 0, strike: POSE.strike, settle: refire });
      const push = thrust({ thrust: POSE.thrust }), lethalPush = thrust({ thrust: POSE.lethal?.thrust });
      let turning = pose, driving = push, tellK = 0, telling = false;
      const load = pack(env.owner);
      const digs = dig ? digger(env, { power: dig.power, limit: blow.ENERGY, tools: dig.tools, reach }) : null;   // no harder than the blow's energy (melee.js's rule)
      let lastHit = null, aimed = null, disposed = false;
      const full = (id) => { if (!load.busy) env.feedback?.refuse('Your pack is full: build with the trowel or throw some with the shovel', { id }); };

      // A digging blow (spec.dig): the aimed lattice block cracks, or comes up whole into the pack.
      function digStrike(ctx, t) {
        const point = t.aim.cell.clone().addScalar(0.5), normal = faceNormal(t.aim.face);
        lastHit = { cell: t.aim.cell.clone(), id: t.id };
        const r = digs.blow(ctx, t, load, env.transfer);
        // broke: true (it came up), null (it cracked), false (it can't be dug: a bounce)
        const broke = !r ? false : r.taken ? true : null;
        if (r && r.hits >= r.need && !r.taken && load.free <= 0) full(t.id);
        povEvents.emit('impact', { source, point, normal, id: t.id, energy: blow.ENERGY, broke });
        model.rig.hit(HIT_ROW);
        if (broke === false && ELEMENTS[t.id]?.kind === K.SOLID) {
          env.feedback?.refuse(null, { id: t.id, point }, { silent: true });
          const why = digs.refusal(t.id, name.toLowerCase());
          if (why) env.feedback?.refuse(why, { id: t.id });
        }
        return { landed: true };
      }

      // Take the debris inside the blow's patch (the same ellipsoid as blowFrag) into the pack;
      // with it full, say so if the struck cell `id` broke (`broke`).
      function gather(sim, center, dir, id, broke) {
        if (!(load.free > 0)) { if (broke) full(id); return; }
        const d = new THREE.Vector3();
        const inPatch = (x, y, z) => {
          d.set(x + 0.5, y + 0.5, z + 0.5).sub(center);
          const along = d.dot(dir);
          const across2 = d.lengthSq() - along * along;
          return across2 / (blow.RADIUS * blow.RADIUS) + (along * along) / (blow.DEPTH * blow.DEPTH) < 1;
        };
        env.transfer?.take(load, { cells: cellsNear(center, Math.max(blow.RADIUS, blow.DEPTH), sim.g, inPatch), kinds: [K.POWDER], ids: DEBRIS });
      }

      // the body (an NPC) in reach and nearer than the struck cell, or null
      const bodyInReach = (ctx) => ctx.peaceful ? null : rayTarget(ctx.eye, ctx.dir.clone().normalize(), Math.min(reach, ctx.aim?.valid ? ctx.aim.dist : Infinity), povEvents.actor?.id ?? PLAYER);

      // { landed, lethal }
      function strike(ctx, activated = false, digTarget = aimed) {
        const aim = ctx.aim;
        const target = activated ? null : bodyInReach(ctx);
        if (target) {
          const b = bodyBlow?.(ctx, target) ?? null;
          const lethal = !!b?.lethal;
          target.target.hurt((b?.damage ?? BODY.damage) * dealtScale(povEvents.actor?.id), b?.cause ?? BODY.cause, ctx.dir.clone().normalize(), lethal ? { lethal } : undefined);
          povEvents.emit('impact', { source, point: target.point, normal: ctx.dir.clone().negate(), id: -1, energy: b?.energy ?? BODY.energy, broke: null, body: true, backstab: lethal });
          model.rig.hit(b?.hit ?? HIT_ROW);
          return { landed: true, lethal };
        }
        if (!activated && aim?.valid && aim.dist <= reach && aim.cell.y >= 0) {
          const sim = ctx.sim ?? env.getSim(), actor = povEvents.actor;
          const frozen = { ...ctx, eye: ctx.eye.clone(), dir: ctx.dir.clone(),
            aim: { ...aim, cell: aim.cell.clone() } };
          const frozenDig = digTarget ? { ...digTarget, min: digTarget.min.clone(), aim: { ...digTarget.aim, cell: digTarget.aim.cell.clone() } } : null;
          if (beforeControlContact(sim, frozen.aim, 'melee', shift => {
            frozen.eye.add(shift); frozen.aim.cell.add(shift);
            if (frozenDig) {
              frozenDig.aim.cell.add(shift); frozenDig.min.add(shift);
              frozenDig.key = `${frozenDig.min.x},${frozenDig.min.y},${frozenDig.min.z}:${frozenDig.id}`;
            }
            if (!disposed) povEvents.as(actor, () => strike(frozen, true, frozenDig));
          }, { valid: () => !disposed })) return { landed: true };
        }
        if (digs) return digTarget ? digStrike(ctx, digTarget) : { landed: false };
        if (!aim?.valid || aim.dist > reach || aim.cell.y < 0) return { landed: false };   // air, or the floor
        const sim = ctx.sim ?? env.getSim();
        const c = aim.cell.clone().addScalar(0.5), swingDir = ctx.dir.clone().normalize();
        const r = Math.max(blow.RADIUS, blow.DEPTH);   // the blow's reach (blowWGSL)
        // (its kernel still building, B5: the swing lands nothing rather than announce a blow it didn't strike)
        if (!pass(sim, { center: c, dir: swingDir }, sim.touchCentres([c.x - r, c.y - r, c.z - r], [c.x + r, c.y + r, c.z + r]))) return { landed: false };
        lastHit = { cell: aim.cell.clone(), id: aim.id };
        // the struck cell breaks if the blow's full energy (it lands at the patch centre) beats its hardness
        const el = ELEMENTS[aim.id];
        const solid = el?.kind === K.SOLID;
        const broke = solid ? Boolean(el.breakInto) && blow.ENERGY >= el.hard : null;
        const point = aim.cell.clone().addScalar(0.5);
        // (every landed blow: the patch breaks more than the struck cell, the axe's leaves around the wood)
        gather(sim, point, swingDir, aim.id, broke);
        // V2: the chips the pack didn't take fly now, from where V1's take left them (v2/interactions.js)
        flushNativeLaunch(sim);
        povEvents.emit('impact', { source, point, normal: faceNormal(aim.face), id: aim.id, energy: blow.ENERGY, broke });
        model.rig.hit(HIT_ROW);
        if (broke === false) env.feedback?.refuse(null, { id: aim.id, point }, { silent: true });
        return { landed: true };
      }

      return {
        update(ctx) {
          model.update(ctx);
          const dt = toolDt(ctx);
          model.hand.userData.gesture.since += dt;
          // the tell: the next blow would be special (a backstab lined up)
          telling = !!tell?.(ctx, bodyInReach(ctx));
          aimed = digs?.target(ctx) ?? null;
          tellK += ((telling ? 1 : 0) - tellK) * (1 - Math.exp(-TELL_RATE * dt));
          if (button.ready(ctx)) {
            button.fire();
            model.hand.userData.gesture.since = 0;
            env.feedback?.act('swing');
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
          const axis = POSE.thrustAxis ?? [0, 0, -1], drive = driving.angle(dt);
          model.pivot.position.set(rp[0] * tellK + axis[0] * drive, rp[1] * tellK + axis[1] * drive, rp[2] * tellK + axis[2] * drive);
        },
        deselect() { model.deselect(); digs?.hide(); button.reset(); pose.stop(); lethalPose.stop(); push.stop(); lethalPush.stop(); tellK = 0; telling = false; },
        status: () => null,
        get telling() { return telling; },   // for checks: the tell (pose.ready) is up
        windowShifted(dx, dz) { if (lastHit) { lastHit.cell.x -= dx; lastHit.cell.z -= dz; } },   // (docs/scaling.md D11)
        get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
        dispose() { disposed = true; pass.dispose(); digs?.dispose(); model.dispose(); },
      };
    },
  };
}
