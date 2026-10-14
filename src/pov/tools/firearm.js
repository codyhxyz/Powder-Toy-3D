import * as THREE from 'three';
import { MAX_ROUNDS, gravityScale } from '../ballistics.js';
import { CELL_METERS } from '../vitals.js';
import { povEvents } from '../events.js';
import { heldModel } from './held.js';
import { h } from '../../ui/dom.js';
import { trigger, toolDt } from './action.js';
import { muzzleCell } from './transfer.js';
import { gridSpace } from '../space.js';
import './firearm.css';

// A gun (the pistol, the SMG, the sniper rifle): fires rounds that fly with
// real ballistics outside the sim (ballistics.js) and, where they strike,
// spend their energy breaking and shoving cells along their path
// (povTrace.js strikeFrag). They add nothing to the world.
//
// The round and its effects leave the same model-space barrel exit. Aim from
// there toward the crosshair. At point-blank range, start at the eye so the
// round hits the nearby surface instead of spawning beyond it.
//
// Accuracy is Half-Life 2's pistol (weapon_pistol.cpp): every shot adds
// spread.penalty seconds of inaccuracy, up to spread.penaltyMax, which wears
// off at one second a second once the trigger has rested SPREAD_RECOVER_DELAY;
// the cone's full angle runs from spread.min to spread.max with it. Spam the
// trigger and the shots wander; pace them and they're true. The penalty holds
// mid-burst the way CS and Rust bloom does: decaying between an SMG's rounds,
// it outran the 0.1 s a round added and a held spray never opened up.
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
// A gun without a scope aims down its sights while right-click is held, the
// way Rust, CS and Halo's do it: over ADS_TIME the gun comes up to the middle of the
// screen (its bore just under the crosshair), the view narrows by ADS_ZOOM, the
// cone shrinks to ADS_SPREAD of the hip's and the body walks at ADS_SPEED.
// Hip fire sprays; aim to hit.
//
// Events (docs/pov.md): gun:fire { origin, dir, muzzleWorld, gun, sound },
// round:move, round:end and impact from ballistics.js.
//
//   export default firearm({ ...gear(KEY),       // the tool definition (catalog.js)
//     round: { speed, energy, depth, damage, mass },   // m/s, sim KE units, cells, health, kg
//     refire, hold,                               // action.js trigger: s between shots, and held repeats
//     spread: { min, max, penalty, penaltyMax },  // rad (full cone angle), s
//     hit,                                        // viewmodel.js HIT row of a shot
//     sound: { rate, gain, thump },               // the shot's sound (audio.js), as a share of the pistol's
//     scope: { zoom },                            // optional: right-click zoom
//     pose: { pos, ads } });                      // hip and optional aimed poses, in cells (camera space)

const MUZZLE_NUDGE = 1e-3;         // cells past the muzzle cell's entry face the round starts
const BODY_MASS_KG = 70;           // kg, the player
const SPREAD_RECOVER = 1;          // s of accuracy penalty worn off per second
const SPREAD_RECOVER_DELAY = 0.25; // s after a shot before the penalty starts wearing off
// ironsights (right-click held, guns without a scope)
const ADS_TIME = 0.2;              // s to raise the sights or drop them (Rust's and CS's are ~0.2–0.3 s)
const ADS_ZOOM = 1.3;              // × the view's zoom aimed in (Rust's ironsights, a light zoom)
const ADS_SPREAD = 0.3;            // × the hip's cone aimed in
const ADS_SPEED = 0.6;             // × walking speed aimed in (CS's scoped walk, Rust's ADS walk)
const ADS_SIGHT_DROP = 0.08;       // cells: how far under the crosshair the bore sits aimed in

// a random direction within a cone of full angle `angle` around unit d (uniform over the cone's cap)
const smooth = (t) => t * t * (3 - 2 * t);   // smoothstep: the sights ease up and down
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
    const held = heldModel(env, { model: modelKey, pos: pose.pos });
    const { hand } = held;
    const muzzle = held.mesh.obj.getObjectByName('muzzle');
    // the hand's rest pose at the hip and aimed in (ironsights: the bore centred, just under the crosshair)
    const hip = new THREE.Vector3(...pose.pos);
    const ads = new THREE.Vector3(...(pose.ads ?? [-muzzle.position.x, -muzzle.position.y - ADS_SIGHT_DROP, pose.pos[2]]));
    return {
      ...held, muzzle,
      aimPose: (k) => hand.userData.rest.lerpVectors(hip, ads, k),
      // the muzzle in world space (for gun:fire's muzzleWorld); valid before the mesh arrives
      muzzleWorld: (out = new THREE.Vector3()) => { muzzle.updateWorldMatrix(true, false); return muzzle.getWorldPosition(out); },
    };
  }

  return {
    key, name, model: modelKey, desc,
    create(env) {
      const model = buildModel(env);
      const { toWorld, toGrid } = gridSpace(env);
      const ballistics = env.ballistics;   // the toolbelt's: it keeps rounds flying after the gun is put away
      const button = trigger(refire, { hold });
      // the scope's view (only the player's: an NPC's toolbelt has no hud)
      const overlay = scope && env.hud ? h('div.pov-scope', { 'aria-hidden': 'true' }) : null;
      if (overlay) document.body.append(overlay);
      let penalty = 0, sinceShot = Infinity, scoped = false, aimed = 0, body = null, lastShot = null;   // aimed: 0 hip … 1 down the sights

      const setScoped = (v) => {
        scoped = !!scope && v;
        overlay?.classList.toggle('on', scoped);
        env.requestRender?.();
      };

      function fire(ctx) {
        const sim = ctx.sim ?? env.getSim();
        const aimDir = ctx.dir.clone().normalize();
        const m = muzzleCell(ctx.eye, aimDir, ctx.player.pos, sim.g);
        const aim = ctx.aim;
        if (ballistics.count >= MAX_ROUNDS) return false;
        const cone = THREE.MathUtils.lerp(spread.min, spread.max, Math.min(1, penalty / spread.penaltyMax))
          * THREE.MathUtils.lerp(1, ADS_SPREAD, aimed);
        const firstPerson = !povEvents.actor && env.viewmodel.visible && model.hand.visible;
        const world = model.hand.visible && (firstPerson || env.heldOnBody?.()) ? model.muzzleWorld() : null;
        const origin = world
          ? toGrid(world)
          : ctx.eye.clone().addScaledVector(aimDir, m ? m.t + MUZZLE_NUDGE : 0);
        // Close terrain changes the launch point, never whether the gun fires.
        if (!m || (aim?.valid && (
          (aim.cell && m.path.some((c) => c.equals(aim.cell)))
          || aim.dist <= origin.clone().sub(ctx.eye).dot(aimDir)
        ))) origin.copy(ctx.eye);
        const distance = aim?.valid && Number.isFinite(aim.dist) ? aim.dist : Math.max(sim.g.nx, sim.g.ny, sim.g.nz);
        // Do not let a close crosshair target turn the shot backwards into the player.
        const target = ctx.eye.clone().addScaledVector(aimDir, Math.max(distance, origin.distanceTo(ctx.eye) + 1));
        const dir = scatter(target.sub(origin).normalize(), cone);
        const id = ballistics.fire(origin, dir, gravityScale(sim), {
          speed, energy: round.energy, depth: round.depth, damage: round.damage,
        });
        if (!id) return false;
        penalty = Math.min(spread.penaltyMax, penalty + spread.penalty);
        sinceShot = 0;
        // momentum: the round's at its muzzle speed (cells/s)
        const dv = dir.clone().multiplyScalar(-round.mass * speed / BODY_MASS_KG);
        if (ctx.player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
        ctx.player.applyImpulse(dv);
        lastShot = { id, origin: origin.clone(), dir: dir.clone(), cell: origin.clone().floor(), dv: dv.clone(), cone };
        model.rig.hit(hit);
        povEvents.emit('gun:fire', {
          origin: origin.clone(), dir: dir.clone(),
          muzzleWorld: world ?? toWorld(origin),
          muzzleAnchor: firstPerson ? model.muzzle : null, gun: key, sound,
        });
        return true;
      }

      return {
        update(ctx) {
          const dt = toolDt(ctx);
          sinceShot += dt;
          if (sinceShot > SPREAD_RECOVER_DELAY) penalty = Math.max(0, penalty - SPREAD_RECOVER * dt);
          if (scope && ctx.secondaryPressed) setScoped(!scoped);
          // ironsights: right-click held
          const aimTo = !scope && ctx.secondary ? 1 : 0;
          if (aimed !== aimTo) {
            aimed = aimTo > aimed ? Math.min(1, aimed + dt / ADS_TIME) : Math.max(0, aimed - dt / ADS_TIME);
            model.aimPose(smooth(aimed));
            env.requestRender?.();
          }
          model.update(ctx, !scoped);
          body = ctx.player;
          if (body) body.aimScale = THREE.MathUtils.lerp(1, ADS_SPEED, aimed);
          if (button.ready(ctx) && fire(ctx)) button.fire();
        },
        deselect() {
          model.deselect(); button.reset(); setScoped(false);
          aimed = 0; model.aimPose(0);
          if (body) body.aimScale = 1;
        },
        status: () => null,
        // the view's zoom: FOV ÷ this (the toolbelt hands it to the camera)
        zoom: () => (scoped ? scope.zoom : THREE.MathUtils.lerp(1, ADS_ZOOM, aimed)),
        // rounds in the air keep flying where they are in the world (docs/scaling.md D11)
        windowShifted(dx, dz) {
          for (const v of lastShot ? [lastShot.origin, lastShot.cell] : []) { v.x -= dx; v.z -= dz; }
        },
        // for checks: the last shot ({ id, origin, dir, cell (muzzle), dv (recoil), cone }) and the rounds
        get lastShot() { return lastShot; },
        get ballistics() { return ballistics; },
        get penalty() { return penalty; },
        get scoped() { return scoped; },
        get aimed() { return aimed; },         // 0 at the hip … 1 down the sights
        get muzzle() { return model.muzzle; }, // the viewmodel's muzzle point (Object3D)
        muzzleWorld: model.muzzleWorld,        // (out?) → its world position now
        dispose() { setScoped(false); if (body) body.aimScale = 1; overlay?.remove(); model.dispose(); },
      };
    },
  };
}
