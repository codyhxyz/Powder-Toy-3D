import * as THREE from 'three';
import { quadVert, stateUniforms } from '../../shaders/common.js';
import { laserFrag, laserReachFrag, LASER } from '../../shaders/povBore.js';
import { toolPass } from '../../shaders/povTools.js';
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
// momentum, so there's no recoil; the kick and the shake are the gun's feel.
//
// The beam's reach comes back from one small pass (laserReachFrag) read at
// once, a short GPU wait once a shot, before the beam itself (laserFrag) runs
// on the same state.
//
// Events: laser:charge { amount 0..1, dt } every frame it charges (audio.js's
// rising whine); tool:action 'laser' 'charge' / 'cancel' / 'fire'; gun:fire
// (vfx.js's flash, the shot's sound); laser { from, to, dir, radius, hit } in
// world space (vfx.js's beam); laser:aim { from, to, amount } in world space every
// frame it charges (vfx.js's thin red sighting beam, which thickens as it fills,
// as the Spartan Laser's does in Halo 3); shake { trauma }.

const CHARGE_S = 3;            // s to full charge (Halo's Spartan Laser, about three)
const REFIRE_S = 2;            // s of standby after a shot before it charges again (Halo's, about two)
const BODY_CLEARANCE = 0.3;    // cells: the beam starts this far outside the body
const SHAKE = 1;               // trauma a shot adds to the screen shake (0..1, feel.js): all of it
const TREMBLE = 0.035;         // cells the gun shudders in the hands at full charge (it grows as the square of the charge)
const GLOW_IDLE = 0.15;        // the charge strip's brightness when idle, as a share of full
const GLOW_FULL = 4;           // ...and at full charge (HDR: it blooms)
const GLOW_FLICKER = 0.15;     // share the strip's brightness flickers by while charging
const RGBA = 4;

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
    const beam = toolPass(laserFrag, () => ({
      uFrom: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
      uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
    }));
    let reachMat = null, reachSim = -1;
    const reachTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    const reachBuf = new Float32Array(RGBA);
    let charge = 0, standby = 0, armed = true, lastShot = null;

    function setGlow(share) {
      if (glow) glow.color.copy(glowBase).multiplyScalar(share);
    }

    function reachFor(sim) {
      if (sim.id !== reachSim) {
        reachMat?.dispose();
        reachMat = new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: laserReachFrag(sim.g),
          uniforms: { ...stateUniforms(), uFrom: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } },
          depthTest: false, depthWrite: false,
        });
        reachSim = sim.id;
      }
      return reachMat;
    }

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const feet = ctx.player?.pos;
      const from = ctx.eye.clone().addScaledVector(dir, feet ? bodyExit(ctx.eye, dir, feet, BODY_CLEARANCE) : 0);
      // how far it gets, on the state as it is now
      const rm = reachFor(sim), ru = rm.uniforms;
      ru.tA.value = sim.stateA; ru.tB.value = sim.stateB; ru.tF.value = sim.stateF;
      ru.uFrom.value.copy(from); ru.uDir.value.copy(dir);
      sim.run(rm, reachTarget);
      env.renderer.readRenderTargetPixels(reachTarget, 0, 0, 1, 1, reachBuf);
      const reach = Math.min(Math.max(reachBuf[0], 0), LASER.LENGTH), stopId = Math.round(reachBuf[1]);
      // the beam
      const mat = beam(sim), u = mat.uniforms;
      u.uFrom.value.copy(from); u.uDir.value.copy(dir);
      const end = from.clone().addScaledVector(dir, reach);
      const lo = from.clone().min(end).subScalar(LASER.RIM_RADIUS + 1).floor();
      const hi = from.clone().max(end).addScalar(LASER.RIM_RADIUS + 1).floor();
      u.uLo.value.copy(lo); u.uHi.value.copy(hi);
      sim.touchCentres(lo.toArray(), hi.toArray());
      sim.pass(mat);
      // every body in it
      const hits = beamTargets(from, dir, reach, LASER.RIM_RADIUS, povEvents.actor?.id ?? PLAYER);
      for (const h of hits) {
        h.target.hurt(LASER.DAMAGE, 'Lasered', dir.clone());
        povEvents.emit('impact', { source: 'laser', point: h.point.clone(), normal: dir.clone().negate(), id: -1, energy: LASER.ENERGY, broke: null, body: true });
      }
      lastShot = { from: from.clone(), dir: dir.clone(), reach, stopId, end: end.clone(), hits: hits.map((h) => h.target.id) };
      rig.hit(HIT.LASER);
      muzzle.updateWorldMatrix(true, false);
      const muzzleWorld = hand.visible ? muzzle.getWorldPosition(new THREE.Vector3()) : null;
      const toWorld = (g) => g.clone().multiplyScalar(env.getScale()).add(env.getVolume().position);
      povEvents.emit('tool:action', { tool: 'laser', action: 'fire' });
      povEvents.emit('gun:fire', { origin: from.clone(), dir: dir.clone(), muzzleWorld, gun: 'LASER', sound: { voice: 'laserFire', rate: 1, gain: 1.4, thump: 2.5 } });
      povEvents.emit('laser', { from: muzzleWorld ?? toWorld(from), to: toWorld(end), dir: dir.clone(), radius: LASER.CORE_RADIUS * env.getScale(), hit: reach < LASER.LENGTH });
      povEvents.emit('shake', { trauma: SHAKE });
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
        const dt = toolDt(ctx);
        standby = Math.max(0, standby - dt);
        if (!ctx.primary) { cancel(); armed = true; }
        else if (armed && standby <= 0) {
          if (charge === 0) povEvents.emit('tool:action', { tool: 'laser', action: 'charge' });
          charge += dt;
          povEvents.emit('laser:charge', { amount: Math.min(1, charge / CHARGE_S), dt });
          aim(ctx, Math.min(1, charge / CHARGE_S));
          if (charge >= CHARGE_S) {
            fire(ctx);
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
      windowShifted(dx, dz) { if (lastShot) for (const v of [lastShot.from, lastShot.end]) { v.x -= dx; v.z -= dz; } },
      // for checks
      get charge() { return charge / CHARGE_S; },
      get lastShot() { return lastShot; },
      dispose() {
        cancel();
        beam.dispose();
        reachMat?.dispose();
        reachTarget.dispose();
        glow?.dispose();
        mesh.dispose();
        hand.removeFromParent();
      },
    };
  },
};
