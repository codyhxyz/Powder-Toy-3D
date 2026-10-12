import * as THREE from 'three';
import { LASER } from '../../shaders/povBore.js';
import { povGpu } from '../gpu.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { beamTargets, PLAYER } from '../targets.js';
import { toolDt } from './action.js';
import { gear } from './catalog.js';
import { bodyExit } from './transfer.js';

// Laser cannon: Halo's Spartan Laser. Hold left-click to charge it; it fires
// itself the moment the charge is full, and letting go before that cancels
// (Halopedia, "M6 Grindell/Galilean Nonlinear Rifle": it "will charge for
// approximately three seconds before discharging", the sequence "can be
// aborted ... as long as the weapon is not actually fired", and there is an
// "approximately two-second-long standby sequence between shots"). You let go
// and press again for the next shot.
//
// The shot is one instant beam along the crosshair (shaders/povBore.js
// laserFrag, every power number in its LASER block): it vaporises a core
// CORE_RADIUS thick and heats the rim round it, so rock spalls and melts into
// lava, metal melts, water flashes to steam and wood catches fire, all by the
// engine's own temperature rules. It leaves a glowing molten tunnel, not
// debris. Its reach is an energy budget spent on the heat each cell takes,
// so it goes far through rock, less through metal, less still through water.
// Bodies anywhere in the beam take LASER.DAMAGE. Light carries next to no
// momentum, so there's no recoil; the kick in the hands and the shake are the
// gun's feel. Neither moves the crosshair off the beam while it burns: no view
// punch (Halo 3's Spartan Laser never throws your aim), and the shake only rolls
// the view, which turns it about the crosshair.
//
// The beam's reach is worked out on the GPU (laserReachFrag), which then runs
// the beam itself (laserFrag) over the cells it reaches, dispatched from what
// the reach wrote (docs/webgpu.md G2): nothing waits for the GPU. The reach
// comes back to the CPU 1–3 frames later, and the shot's effects that need it
// (the bodies in the beam, the beam's look, lastShot) happen on the first
// frame after it lands; the beam fades over a third of a second, so the
// frames between don't show.
//
// Events: laser:charge { amount 0..1, dt } every frame it charges (audio.js's
// rising whine); tool:action 'laser' 'charge' / 'cancel' / 'fire'; gun:fire
// (vfx.js's flash, the shot's sound); laser { from, to, dir, radius, hit } in
// world space (vfx.js's beam); laser:aim { from, to, amount } in world space every
// frame it charges (vfx.js's thin red sighting beam, which thickens as it fills,
// as the Spartan Laser's does in Halo 3); shake { trauma }.

export const CHARGE_S = 3;     // s to full charge (Halo's Spartan Laser, about three)
export const REFIRE_S = 2;     // s of standby after a shot before it charges again (Halo's, about two)
const BODY_CLEARANCE = 0.3;    // cells: the beam starts this far outside the body
const SHAKE = 1;               // rumble a shot adds to the screen shake (0..1, feel.js, roll only): all of it
const TREMBLE = 0.035;         // cells the gun shudders in the hands at full charge (it grows as the square of the charge)
const GLOW_IDLE = 0.15;        // the charge strip's brightness when idle, as a share of full
const GLOW_FULL = 4;           // ...and at full charge (HDR: it blooms)
const GLOW_FLICKER = 0.15;     // share the strip's brightness flickers by while charging

// viewmodel, in cells (camera space): shouldered low at the hip, long and heavy, as Halo holds it
const HELD_POS = [0.55, -0.62, -1.9];
const MUZZLE = [0, 0.07, -1.7];   // cells from the model's centre to the prongs' mouth (models.js laser)

export default {
  ...gear('LASER'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(...MUZZLE);
    hand.add(muzzle);
    const mesh = attachModel(hand, 'laser');
    // its own copy of the strips' glow material, so their brightness is this gun's alone
    const strips = [];
    mesh.obj.traverse((o) => { if (o.name === 'charge') strips.push(o); });
    let glow = null, glowBase = null;
    if (strips.length) { glow = strips[0].material.clone(); for (const o of strips) o.material = glow; glowBase = glow.color.clone(); }
    const restPos = mesh.obj.position.clone();
    let charge = 0, standby = 0, armed = true, lastShot = null;
    // shots fired whose reach hasn't been dealt with: in flight (reach null) or landed
    const shots = [];

    function setGlow(share) {
      if (glow) glow.color.copy(glowBase).multiplyScalar(share);
    }

    // The shot: the beam on the GPU now, its reach-dependent effects once the reach lands (land()).
    // False when its kernels are still building (B5): it stays charged and fires on a later frame.
    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const feet = ctx.player?.pos;
      const from = ctx.eye.clone().addScaledVector(dir, feet ? bodyExit(ctx.eye, dir, feet, BODY_CLEARANCE) : 0);
      const reach = povGpu(sim).laser(from.toArray(), dir.toArray());
      if (!reach) return false;
      rig.hit(HIT.LASER);
      muzzle.updateWorldMatrix(true, false);
      const muzzleWorld = hand.visible ? muzzle.getWorldPosition(new THREE.Vector3()) : null;
      const shot = { from, dir, muzzleWorld, actor: povEvents.actor, simId: sim.id, reach: null, stopId: -1 };
      shots.push(shot);
      reach.then((r) => { shot.reach = Math.min(Math.max(r.reach, 0), LASER.LENGTH); shot.stopId = r.stopId; },
        () => { shots.splice(shots.indexOf(shot), 1); });   // (graphics stopped: the shot is gone with the world)
      povEvents.emit('tool:action', { tool: 'laser', action: 'fire' });
      povEvents.emit('gun:fire', { origin: from.clone(), dir: dir.clone(), muzzleWorld, gun: 'LASER', sound: { voice: 'laserFire', rate: 1, gain: 1.4, thump: 2.5 } });
      povEvents.emit('shake', { trauma: SHAKE });
      return true;
    }

    // The landed shots' effects (on a running frame, as the shooter's): every body in the beam, the beam's look, lastShot.
    function land(sim) {
      while (shots.length && shots[0].reach !== null) {
        const { from, dir, reach, stopId, muzzleWorld, actor, simId } = shots.shift();
        if (sim?.id !== simId) continue;   // a replaced world: its beam is gone with it
        povEvents.as(actor, () => {
          const end = from.clone().addScaledVector(dir, reach);
          const hits = beamTargets(from, dir, reach, LASER.RIM_RADIUS, actor?.id ?? PLAYER);
          for (const h of hits) {
            h.target.hurt(LASER.DAMAGE, 'Lasered', dir.clone());
            povEvents.emit('impact', { source: 'laser', point: h.point.clone(), normal: dir.clone().negate(), id: -1, energy: LASER.ENERGY, broke: null, body: true });
          }
          lastShot = { from: from.clone(), dir: dir.clone(), reach, stopId, end: end.clone(), hits: hits.map((h) => h.target.id) };
          const toWorld = (g) => g.clone().multiplyScalar(env.getScale()).add(env.getVolume().position);
          povEvents.emit('laser', { from: muzzleWorld ?? toWorld(from), to: toWorld(end), dir: dir.clone(), radius: LASER.CORE_RADIUS * env.getScale(), hit: reach < LASER.LENGTH });
        });
      }
    }

    // the sighting beam while it charges: from the muzzle to what the crosshair is on
    function aim(ctx, amount) {
      if (!hand.visible) return;
      muzzle.updateWorldMatrix(true, false);
      const from = muzzle.getWorldPosition(new THREE.Vector3());
      const a = ctx.aim;
      const dist = a?.valid && Number.isFinite(a.dist) ? Math.min(a.dist, LASER.LENGTH) : LASER.LENGTH;
      const to = ctx.eye.clone().addScaledVector(ctx.dir.clone().normalize(), dist).multiplyScalar(env.getScale()).add(env.getVolume().position);
      povEvents.emit('laser:aim', { from, to, amount });
    }

    function cancel() {
      if (charge > 0) povEvents.emit('tool:action', { tool: 'laser', action: 'cancel' });
      charge = 0;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        land(ctx.sim ?? env.getSim());   // (a bot's kit runs only the tool in hand: tick isn't called there)
        const dt = toolDt(ctx);
        standby = Math.max(0, standby - dt);
        if (!ctx.primary) { cancel(); armed = true; }
        else if (armed && standby <= 0) {
          if (charge === 0) povEvents.emit('tool:action', { tool: 'laser', action: 'charge' });
          charge += dt;
          povEvents.emit('laser:charge', { amount: Math.min(1, charge / CHARGE_S), dt });
          aim(ctx, Math.min(1, charge / CHARGE_S));
          if (charge >= CHARGE_S && fire(ctx)) {
            charge = 0; standby = REFIRE_S; armed = false;
          }
        }
        const share = charge / CHARGE_S;
        const shudder = TREMBLE * share * share;
        mesh.obj.position.set(restPos.x + (Math.random() - 0.5) * shudder, restPos.y + (Math.random() - 0.5) * shudder, restPos.z);
        setGlow(GLOW_IDLE + (GLOW_FULL - GLOW_IDLE) * share * (1 + (Math.random() - 0.5) * 2 * GLOW_FLICKER * share));
        if (charge > 0) env.requestRender?.();
      },
      deselect() { hand.visible = false; cancel(); armed = true; setGlow(GLOW_IDLE); },
      // the charge while charging, the standby after a shot
      status: () => (charge > 0 ? `${Math.floor(100 * charge / CHARGE_S)}%` : standby > 0 ? '…' : null),
      windowShifted(dx, dz) {
        if (lastShot) for (const v of [lastShot.from, lastShot.end]) { v.x -= dx; v.z -= dz; }
        for (const s of shots) { s.from.x -= dx; s.from.z -= dz; }
      },
      // a shot's reach lands while another tool is in hand, or the body is out of POV for it
      tick(ctx) { land(ctx.sim ?? env.getSim()); },
      // for checks
      get charge() { return charge / CHARGE_S; },
      get lastShot() { return lastShot; },
      dispose() {
        cancel();
        shots.length = 0;
        glow?.dispose();
        mesh.dispose();
        hand.removeFromParent();
      },
    };
  },
};
