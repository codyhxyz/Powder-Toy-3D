import * as THREE from 'three';
import { MAX_ROUNDS, gravityScale } from '../ballistics.js';
import { CELL_METERS } from '../vitals.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { h } from '../../ui/dom.js';
import { trigger, toolDt } from './action.js';
import { muzzleCell } from './transfer.js';
import './firearm.css';

// A gun (the pistol, the SMG, the sniper rifle): fires rounds that fly with
// real ballistics outside the sim (ballistics.js) and, where they strike,
// spend their energy breaking and shoving cells along their path
// (povTrace.js strikeFrag). They add nothing to the world.
//
// The round leaves the muzzle: the first cell along the aim ray outside the
// body box. The trigger only clicks (gun:dry) when that cell, or one between
// the eye and it, is matter: the pick under the crosshair is that close.
//
// Accuracy is Half-Life 2's pistol (weapon_pistol.cpp): every shot adds
// spread.penalty seconds of inaccuracy, up to spread.penaltyMax, which wears
// off at one second a second; the cone's full angle runs from spread.min to
// spread.max with it. Spam the trigger and the shots wander; pace them and
// they're true.
//
// Recoil conserves momentum: Δv_body = m_round·v_round / m_body, with a real
// round's mass. Standing, the ground takes it the way it takes any impact:
// friction the sideways part, the floor the downward part, so only an upward
// kick or a shot fired in the air or water moves you, and then barely (the
// sniper's a little more).
//
// A gun with a scope (spec.scope) zooms on right-click, Half-Life 2's
// crossbow: the view narrows by scope.zoom (pov/camera.js, through the
// toolbelt's zoom), the hand is put away and a scope covers the screen.
//
// Events (docs/pov.md): gun:fire { origin, dir, muzzleWorld, gun, sound },
// gun:dry here; round:move, round:end and impact from ballistics.js.
//
//   export default firearm({ ...gear(KEY),       // the tool definition (catalog.js)
//     round: { speed, energy, depth, damage, mass },   // m/s, sim KE units, cells, health, kg
//     refire, hold,                               // action.js trigger: s between shots, and held repeats
//     spread: { min, max, penalty, penaltyMax },  // rad (full cone angle), s
//     hit,                                        // viewmodel.js HIT row of a shot
//     sound: { rate, gain, thump },               // the shot's sound (audio.js), as a share of the pistol's
//     scope: { zoom },                            // optional: right-click zoom
//     pose: { pos, muzzle } });                   // the held model and its bore's end, in cells (camera space)

const MUZZLE_NUDGE = 1e-3;         // cells past the muzzle cell's entry face the round starts
const BODY_MASS_KG = 70;           // kg, the player
const SPREAD_RECOVER = 1;          // s of accuracy penalty worn off per second

// a random direction within a cone of full angle `angle` around unit d (uniform over the cone's cap)
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
function scatter(d, angle) {
  if (!(angle > 0)) return d;
  const half = angle / 2;
  const cosT = 1 - Math.random() * (1 - Math.cos(half));
  const sinT = Math.sqrt(1 - cosT * cosT), phi = Math.random() * Math.PI * 2;
  tmpA.set(1, 0, 0);
  if (Math.abs(d.x) > 0.9) tmpA.set(0, 1, 0);
  tmpA.cross(d).normalize();
  tmpB.copy(d).cross(tmpA);
  return d.multiplyScalar(cosT).addScaledVector(tmpA, sinT * Math.cos(phi)).addScaledVector(tmpB, sinT * Math.sin(phi)).normalize();
}

export function firearm({ key, name, model: modelKey, desc, round, refire, hold, spread, hit, sound, scope, pose }) {
  const speed = round.speed / CELL_METERS;   // cells/s

  // The held gun: the model (models.js) on a hand of the viewmodel rig and a
  // muzzle point at the end of its bore. The flash is vfx.js's, drawn at gun:fire's muzzleWorld.
  function buildModel(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(pose.pos);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(...pose.muzzle);
    hand.add(muzzle);
    const mesh = attachModel(hand, modelKey);
    return {
      rig, hand, muzzle,
      // the muzzle in world space (for gun:fire's muzzleWorld); valid before the mesh arrives
      muzzleWorld: (out = new THREE.Vector3()) => { muzzle.updateWorldMatrix(true, false); return muzzle.getWorldPosition(out); },
      dispose() { mesh.dispose(); hand.removeFromParent(); },
    };
  }

  return {
    key, name, model: modelKey, desc,
    create(env) {
      const model = buildModel(env);
      const ballistics = env.ballistics;   // the toolbelt's: it keeps rounds flying after the gun is put away
      const button = trigger(refire, { hold });
      // the scope's view (only the player's: an NPC's toolbelt has no hud)
      const overlay = scope && env.hud ? h('div.pov-scope', { 'aria-hidden': 'true' }) : null;
      if (overlay) document.body.append(overlay);
      let penalty = 0, scoped = false, lastShot = null;

      const setScoped = (v) => {
        scoped = !!scope && v;
        overlay?.classList.toggle('on', scoped);
        env.requestRender?.();
      };

      const dry = () => {
        povEvents.emit('gun:dry', {});
        model.rig.hit(HIT.DRY);
        env.feedback?.notice('Click. The muzzle is blocked.');
      };

      // the muzzle in world space: the viewmodel's muzzle while it's shown, else the eye
      function muzzleWorld(eye) {
        if (model.hand.visible) return model.muzzleWorld();
        const vol = env.getVolume();
        return eye.clone().multiplyScalar(env.getScale()).add(vol.position);
      }

      function fire(ctx) {
        const sim = ctx.sim ?? env.getSim();
        const aimDir = ctx.dir.clone().normalize();
        const m = muzzleCell(ctx.eye, aimDir, ctx.player.pos, sim.g);
        // the pick under the crosshair is on the way to the muzzle: matter there
        const aim = ctx.aim;
        if (!m || (aim?.valid && aim.cell && m.path.some((c) => c.equals(aim.cell)))) { dry(); return true; }
        if (ballistics.count >= MAX_ROUNDS) return false;
        const cone = THREE.MathUtils.lerp(spread.min, spread.max, Math.min(1, penalty / spread.penaltyMax));
        const dir = scatter(aimDir.clone(), cone);
        const origin = ctx.eye.clone().addScaledVector(aimDir, m.t + MUZZLE_NUDGE);
        const id = ballistics.fire(origin, dir, gravityScale(sim), {
          speed, energy: round.energy, depth: round.depth, damage: round.damage,
        });
        penalty = Math.min(spread.penaltyMax, penalty + spread.penalty);
        // momentum: the round's at its muzzle speed (cells/s)
        const dv = dir.clone().multiplyScalar(-round.mass * speed / BODY_MASS_KG);
        if (ctx.player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
        ctx.player.applyImpulse(dv);
        lastShot = { id, origin: origin.clone(), dir: dir.clone(), cell: m.cell.clone(), dv: dv.clone(), cone };
        model.rig.hit(hit);
        povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld: muzzleWorld(ctx.eye), gun: key, sound });
        return true;
      }

      return {
        update(ctx) {
          model.rig.update(ctx);
          penalty = Math.max(0, penalty - SPREAD_RECOVER * toolDt(ctx));
          if (scope && ctx.secondaryPressed) setScoped(!scoped);
          model.hand.visible = !scoped;
          if (button.ready(ctx) && fire(ctx)) button.fire();
        },
        deselect() { model.hand.visible = false; button.reset(); setScoped(false); },
        status: () => null,
        // the view's zoom: FOV ÷ this (the toolbelt hands it to the camera)
        zoom: () => (scoped ? scope.zoom : 1),
        // rounds in the air keep flying where they are in the world (docs/scaling.md D11)
        windowShifted(dx, dz) {
          ballistics.windowShifted(dx, dz);
          for (const v of lastShot ? [lastShot.origin, lastShot.cell] : []) { v.x -= dx; v.z -= dz; }
        },
        // for checks: the last shot ({ id, origin, dir, cell (muzzle), dv (recoil), cone }) and the rounds
        get lastShot() { return lastShot; },
        get ballistics() { return ballistics; },
        get penalty() { return penalty; },
        get scoped() { return scoped; },
        get muzzle() { return model.muzzle; }, // the viewmodel's muzzle point (Object3D)
        muzzleWorld: model.muzzleWorld,        // (out?) → its world position now
        dispose() { setScoped(false); overlay?.remove(); model.dispose(); },
      };
    },
  };
}
