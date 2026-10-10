import * as THREE from 'three';
import { PHYS as ENGINE } from '../../physics.js';
import { physgunFrag, physgunComFrag, blastFrag, toolPass, PHYS, PHYS_MODE, BLAST, glowTexture, disposeTree } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';

// Physgun: a force beam on loose matter (powders, liquids, gases). Press and
// hold left-click to grab what's around the aim point: every frame one pass
// finds the centre of mass of the movable cells near the hold point (eye +
// aim · distance) and a second gives them a spring velocity that brings it to
// the hold point, plus the gravity they lose over the frame
// (shaders/povTools.js PHYS), so the matter gathers into a floating ball that
// follows the aim. The wheel moves the hold point nearer
// or farther. The hold point chases the aim along an arc around the eye no
// faster than the matter can move (CHASE · V_MAX), so whipping the view
// round swings the ball after it instead of leaving it out of the beam's
// reach. Right-click flings the ball along the aim; letting go drops it.
// Right-click with nothing held blasts: one shove into the loose matter in a
// cone along the aim, and a pressure pulse just past the surface it meets that
// splashes water and craters piles (shaders/povTools.js BLAST). It can't lift or knock over
// solids: there are no rigid bodies.
//
// The beam's reaction force on the player is left out (the body doesn't feel
// the weight it carries).
//
// The gun is a viewmodel (drawn over the frame, viewmodel.js); the beam and
// the reach ball live in the world, so walls hide them like anything else.
// Events: tool:action 'grab', 'fling', 'release' and 'blast'.

// viewmodel, in cells (camera space: +x right, +y up, −z forward)
const GUN_POS = [0.6, -0.42, -1.45];
const TIP = [0, 0.1, -0.65];      // cells from the model's centre: where the beam leaves
const BEAM_TIP_RADIUS = 0.02;     // cells, where the beam leaves the gun...
const BEAM_END_RADIUS = 0.15;     // ...and at the hold point (perspective evens it out)
const BEAM_PULSE = 9;             // rad/s the beam's brightness throbs at
const BEAM_PULSE_DEPTH = 0.35;    // share of its opacity the throb takes
const BEAM_OPACITY = 0.8;
const BEAM_COLOR = 0x7fd8ff;
const RIM_STRENGTH = 0.35;        // the faint ball showing the beam's reach: glow at its silhouette...
const RIM_POWER = 3;              // ...falling off this steeply toward its middle
const RIM_CLEAR = 2;              // cells: the ball fades out as the eye comes within this of its surface, so it never wraps the view
const TIP_SIZE = 0.35;            // cells, the glow at the tip
const TIP_IDLE = 0.35;            // tip glow opacity while not holding
const BLAST_FLASH_S = 0.15;       // s the beam flashes along a blast
const CHASE = 0.8;                // share of V_MAX the hold point chases the aim at, so the ball keeps up

// Additive glow strongest where the sphere is seen edge-on: a light outline of
// the reach that never veils what's inside it.
function rimMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(BEAM_COLOR) }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFade;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), ${RIM_POWER.toFixed(1)});
        gl_FragColor = vec4(uColor * rim * ${RIM_STRENGTH} * uFade, 1.0);
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// The held gun (the model, models.js, on a hand of the viewmodel rig) with
// the tip glow, and the beam and reach ball in the world.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(GUN_POS);
  const tip = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: BEAM_COLOR, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  tip.scale.setScalar(TIP_SIZE);
  tip.position.set(...TIP);
  hand.add(tip);
  const mesh = attachModel(hand, 'physgun');
  // the beam and reach ball: world space, sized in cells by the world's scale
  const root = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(BEAM_END_RADIUS, BEAM_TIP_RADIUS, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: BEAM_OPACITY,
      blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(PHYS.RADIUS, 24, 16),
    rimMaterial(),
  );
  beam.frustumCulled = sphere.frustumCulled = false;
  beam.visible = sphere.visible = false;
  root.add(beam, sphere);
  env.scene.add(root);
  return {
    rig, hand, tip, root, beam, sphere,
    dispose() { mesh.dispose(); disposeTree(hand); disposeTree(root); },
  };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export default {
  key: 'PHYSGUN', name: 'Physgun', slot: 5, model: 'physgun',
  desc: 'Hold to lift loose powder, liquid or gas; wheel for distance, right-click to fling. Right-click empty-handed to blast.',
  create(env) {
    const model = buildModel(env);
    const pass = toolPass(physgunFrag, () => ({
      tCom: { value: null }, uHold: { value: new THREE.Vector3() }, uCarry: { value: new THREE.Vector3() },
      uSteps: { value: 0 }, uGravity: { value: 0 }, uMode: { value: PHYS_MODE.HOLD }, uFling: { value: new THREE.Vector3() },
    }));
    const comPass = toolPass(physgunComFrag, () => ({ uHold: { value: new THREE.Vector3() } }));
    const blastPass = toolPass(blastFrag, () => ({
      uMuzzle: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() }, uReach: { value: 0 },
      uPulse: { value: new THREE.Vector3() }, uPulseP: { value: 0 },
    }));
    const comTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    const prevHold = new THREE.Vector3(), carry = new THREE.Vector3();
    let time = 0, holding = false, dist = PHYS.HOLD_MIN, blastWait = 0, flash = 0;
    const hold = new THREE.Vector3();   // where the beam holds the ball: chases `aimPt`
    const aimPt = new THREE.Vector3(), fromEye = new THREE.Vector3(), toAim = new THREE.Vector3();
    const turn = new THREE.Quaternion(), full = new THREE.Quaternion(), still = new THREE.Quaternion(), prevEye = new THREE.Vector3();

    // Move the hold point toward the aim point by at most `reach` cells: along
    // the arc around the eye (a straight chord would cut through the body),
    // then in or out along the aim.
    function chase(eye, reach) {
      fromEye.subVectors(hold, eye);
      toAim.subVectors(aimPt, eye);
      const r0 = fromEye.length(), r1 = toAim.length();
      if (r0 < 1e-6) { hold.copy(aimPt); return; }
      fromEye.divideScalar(r0);
      toAim.divideScalar(r1);
      const arc = fromEye.angleTo(toAim) * r0;
      full.setFromUnitVectors(fromEye, toAim);
      turn.slerpQuaternions(still, full, arc > reach ? reach / arc : 1);
      const left = Math.max(reach - arc, 0);
      hold.copy(eye).addScaledVector(fromEye.applyQuaternion(turn), r0 + THREE.MathUtils.clamp(r1 - r0, -left, left));
    }
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

    function run(ctx, mode) {
      const sim = ctx.sim ?? env.getSim();
      const com = comPass(sim);
      com.uniforms.tA.value = sim.stateA;
      com.uniforms.uHold.value.copy(hold);
      sim.run(com, comTarget);
      const mat = pass(sim);
      const u = mat.uniforms;
      u.tCom.value = comTarget.texture;
      u.uHold.value.copy(hold);
      // the hold point's velocity, so the ball keeps up as the aim moves
      carry.subVectors(hold, prevHold).divideScalar(Math.max(ctx.stepsPerFrame, 1)).clampLength(0, ENGINE.V_MAX);
      u.uCarry.value.copy(carry);
      u.uSteps.value = ctx.stepsPerFrame;
      u.uGravity.value = sim.gravity;
      u.uMode.value = mode;
      u.uFling.value.copy(ctx.dir).normalize().multiplyScalar(PHYS.FLING);
      // it changes only cells whose centres are within the beam's reach of the
      // hold point (shaders/povTools.js), so only those are rebuilt and woken (Simulation.touch)
      const at = hold.toArray();
      sim.touchCentres(at.map((x) => x - PHYS.RADIUS), at.map((x) => x + PHYS.RADIUS));
      sim.pass(mat);
    }

    // One shove along the aim, stopping just past the aimed face, and a
    // pressure pulse just past the face if it's within range (shaders/povTools.js
    // BLAST). The beam flashes to where it stops (drawn from `hold`).
    function blast(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const face = ctx.aim?.valid && ctx.aim.dist + BLAST.PULSE_DEPTH <= BLAST.RANGE ? ctx.aim.dist : Infinity;
      const reach = Math.min(face + BLAST.BITE, BLAST.RANGE);
      const mat = blastPass(sim);
      const u = mat.uniforms;
      u.uMuzzle.value.copy(ctx.eye);
      u.uDir.value.copy(ctx.dir).normalize();
      u.uReach.value = reach;
      const pulse = Number.isFinite(face);
      u.uPulse.value.copy(ctx.eye).addScaledVector(u.uDir.value, pulse ? face + BLAST.PULSE_DEPTH : 0);
      u.uPulseP.value = pulse ? BLAST.PULSE_P : 0;
      hold.copy(ctx.eye).addScaledVector(u.uDir.value, reach);
      // the cone's bounding box: both ends, padded by the radius at the far end
      // (and the pulse's, which sits inside the cone's reach)
      const pad = Math.max(BLAST.RADIUS0 + BLAST.SPREAD * reach, BLAST.PULSE_RADIUS);
      const a = ctx.eye.toArray(), b = hold.toArray();
      sim.touchCentres(a.map((x, i) => Math.min(x, b[i]) - pad), a.map((x, i) => Math.max(x, b[i]) + pad));
      sim.pass(mat);
      model.rig.hit(HIT.FLING);
      povEvents.emit('tool:action', { tool: 'physgun', action: 'blast', point: hold.clone() });
      blastWait = BLAST.COOLDOWN;
      flash = BLAST_FLASH_S;
    }

    const release = () => {
      if (holding) povEvents.emit('tool:action', { tool: 'physgun', action: 'release', point: hold.clone() });
      holding = false;
    };

    // Beam from the tip to the hold point and the reach ball, in world space.
    function drawBeam() {
      const vol = env.getVolume(), scale = env.getScale();
      vol.updateMatrixWorld();
      const end = vol.localToWorld(tmpA.copy(hold));
      model.tip.updateWorldMatrix(true, false);
      const start = model.tip.getWorldPosition(tmpB);
      const span = end.clone().sub(start);
      const len = span.length();
      model.beam.position.copy(start).addScaledVector(span, 0.5);
      model.beam.quaternion.setFromUnitVectors(Y_AXIS, span.divideScalar(len || 1));
      model.beam.scale.set(scale, len, scale);   // radii in cells, length in world units
      model.beam.material.opacity = BEAM_OPACITY * (1 - BEAM_PULSE_DEPTH * (0.5 + 0.5 * Math.sin(time * BEAM_PULSE)));
      model.sphere.position.copy(end);
      model.sphere.scale.setScalar(scale);
    }

    return {
      update(ctx) {
        time += ctx.dt;
        blastWait = Math.max(blastWait - ctx.dt, 0);
        flash = Math.max(flash - ctx.dt, 0);
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.primaryPressed && !holding) {
          holding = true;
          dist = THREE.MathUtils.clamp(ctx.aim?.valid ? ctx.aim.dist - PHYS.GRAB_STANDOFF : PHYS.HOLD_MAX, PHYS.HOLD_MIN, PHYS.HOLD_MAX);
          const point = hold.copy(ctx.eye).addScaledVector(ctx.dir, dist).clone();
          aimPt.copy(hold);
          prevEye.copy(ctx.eye);
          povEvents.emit('tool:action', { tool: 'physgun', action: 'grab', point, id: ctx.aim?.valid ? ctx.aim.id : undefined });
        }
        if (holding && !ctx.primary) release();
        if (holding && ctx.wheel) {
          // +1 = wheel rolled down/toward you: pull the ball in
          dist = THREE.MathUtils.clamp(dist - ctx.wheel * PHYS.WHEEL_STEP, PHYS.HOLD_MIN, PHYS.HOLD_MAX);
        }
        if (holding) {
          prevHold.copy(hold);
          aimPt.copy(ctx.eye).addScaledVector(ctx.dir, dist);
          // the hold point rides along with the eye, then chases the aim
          hold.add(tmpA.subVectors(ctx.eye, prevEye));
          prevEye.copy(ctx.eye);
          chase(ctx.eye, CHASE * ENGINE.V_MAX * ctx.stepsPerFrame);
          if (ctx.primaryPressed) prevHold.copy(hold);
          if (ctx.secondaryPressed) {
            run(ctx, PHYS_MODE.FLING);
            model.rig.hit(HIT.FLING);
            povEvents.emit('tool:action', { tool: 'physgun', action: 'fling', point: hold.clone() });
            holding = false;
          } else if (ctx.stepsPerFrame > 0) run(ctx, PHYS_MODE.HOLD);
        } else if (ctx.secondaryPressed && blastWait === 0) blast(ctx);
        model.tip.material.opacity = holding || flash > 0 ? 1 : TIP_IDLE;
        // the beam shows with the gun (not in third person, where the viewmodel is hidden)
        model.beam.visible = (holding || flash > 0) && env.viewmodel.visible;
        model.sphere.visible = holding && env.viewmodel.visible;
        if (!holding && flash > 0) {
          drawBeam();
          model.beam.material.opacity = BEAM_OPACITY * flash / BLAST_FLASH_S;
        }
        if (holding) {
          drawBeam();
          const clear = ctx.eye.distanceTo(hold) - PHYS.RADIUS;
          model.sphere.material.uniforms.uFade.value = THREE.MathUtils.clamp(clear / RIM_CLEAR, 0, 1);
        }
      },
      deselect() {
        release();
        flash = 0;
        model.hand.visible = false;
        model.beam.visible = model.sphere.visible = false;
      },
      status: () => (holding ? `${Math.round(dist)} cells` : null),
      wantsWheel: () => holding,
      // the hold point stays put in the world, so the carried ball doesn't get yanked (docs/scaling.md D11)
      windowShifted(dx, dz) {
        for (const v of [hold, prevHold, aimPt, prevEye]) { v.x -= dx; v.z -= dz; }
      },
      get hold() { return holding ? hold.clone() : null; },   // for checks
      readCom() {   // for checks: [com x, y, z, cells] of the last frame (a synchronous readback)
        const buf = new Float32Array(4);
        env.renderer.readRenderTargetPixels(comTarget, 0, 0, 1, 1, buf);
        return [...buf];
      },
      dispose() { pass.dispose(); comPass.dispose(); blastPass.dispose(); comTarget.dispose(); model.dispose(); },
    };
  },
};
