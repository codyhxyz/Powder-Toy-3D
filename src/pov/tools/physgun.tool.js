import * as THREE from 'three';
import { physgunFrag, toolPass, PHYS, PHYS_MODE, shadedBox, glowTexture, disposeTree } from '../../shaders/povTools.js';

// Physgun: a force beam on loose matter (powders, liquids, gases). Press and
// hold left-click to grab what's around the aim point: every frame a pass
// gives the movable cells near the hold point (eye + aim · distance) a damped
// spring velocity toward it plus the gravity they lose over the frame
// (shaders/povTools.js physgunFrag and PHYS), so the matter gathers into a
// floating ball that follows the aim. The wheel moves the hold point nearer
// or farther. Right-click flings the ball along the aim; letting go drops it.
// It can't lift solids: there are no rigid bodies.
//
// The beam's reaction force on the player is left out (the body doesn't feel
// the weight it carries).

// viewmodel, in cells (camera space: +x right, +y up, −z forward)
const GUN_POS = [0.6, -0.5, -1.3];
const TIP_Z = -0.75;              // cells ahead of the gun's origin: where the beam leaves
const BEAM_RADIUS = 0.05;         // cells
const BEAM_PULSE = 9;             // rad/s the beam's brightness throbs at
const BEAM_PULSE_DEPTH = 0.35;    // share of its opacity the throb takes
const BEAM_OPACITY = 0.8;
const BEAM_COLOR = 0x7fd8ff;
const SPHERE_OPACITY = 0.07;      // the faint ball showing the beam's reach
const TIP_SIZE = 0.35;            // cells, the glow at the tip
const TIP_IDLE = 0.35;            // tip glow opacity while not holding
const RECOIL_TIME = 0.2;          // s the gun jolts after a fling
const RECOIL_BACK = 0.3;          // cells

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
<path d="M3 15h8l2-3h3"/><circle cx="19" cy="9" r="3"/><path d="M5 15v4h4"/></svg>`;

function buildModel() {
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const body = shadedBox(0.3, 0.3, 1.0, 0x30343c);
  const core = shadedBox(0.34, 0.12, 0.5, BEAM_COLOR);
  core.position.set(0, 0.06, -0.05);
  const prongL = shadedBox(0.06, 0.06, 0.3, 0xc8ced8);
  prongL.position.set(-0.1, 0, -0.6);
  const prongR = prongL.clone();
  prongR.position.x = 0.1;
  const grip = shadedBox(0.18, 0.42, 0.22, 0x22252b);
  grip.position.set(0, -0.3, 0.3);
  gun.add(body, core, prongL, prongR, grip);
  const tip = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: BEAM_COLOR, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  tip.scale.setScalar(TIP_SIZE);
  tip.position.z = TIP_Z;
  gun.add(tip);
  // beam and reach ball live in the same (cell-scaled, camera-attached) space
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: BEAM_OPACITY,
      blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(PHYS.RADIUS, 24, 16),
    new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: SPHERE_OPACITY, depthWrite: false }),
  );
  beam.frustumCulled = sphere.frustumCulled = false;
  beam.visible = sphere.visible = false;
  root.add(beam, sphere);
  root.visible = false;
  return { root, gun, tip, beam, sphere };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export default {
  key: 'PHYSGUN', name: 'Physgun', slot: 5, icon: ICON,
  desc: 'Hold to lift loose powder, liquid or gas; wheel for distance, right-click to fling.',
  create(env) {
    const model = buildModel();
    env.viewmodel.add(model.root);
    const pass = toolPass(physgunFrag, () => ({
      uHold: { value: new THREE.Vector3() }, uSteps: { value: 0 }, uGravity: { value: 0 },
      uMode: { value: PHYS_MODE.HOLD }, uFling: { value: new THREE.Vector3() },
    }));
    let time = 0, holding = false, dist = PHYS.HOLD_MIN, flungAt = -Infinity;
    const hold = new THREE.Vector3();
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

    function run(ctx, mode) {
      const sim = ctx.sim ?? env.getSim();
      const mat = pass(sim);
      const u = mat.uniforms;
      u.uHold.value.copy(hold);
      u.uSteps.value = ctx.stepsPerFrame;
      u.uGravity.value = sim.gravity;
      u.uMode.value = mode;
      u.uFling.value.copy(ctx.dir).normalize().multiplyScalar(PHYS.FLING);
      sim.pass(mat);
    }

    const release = () => { holding = false; };

    // Beam from the tip to the hold point and the reach ball, in the model's space.
    function drawBeam() {
      const vol = env.getVolume();
      model.root.updateWorldMatrix(true, true);
      const end = model.root.worldToLocal(vol.localToWorld(tmpA.copy(hold)));
      const start = model.tip.getWorldPosition(tmpB);
      model.root.worldToLocal(start);
      const span = end.clone().sub(start);
      const len = span.length();
      model.beam.position.copy(start).addScaledVector(span, 0.5);
      model.beam.quaternion.setFromUnitVectors(Y_AXIS, span.divideScalar(len || 1));
      model.beam.scale.set(BEAM_RADIUS, len, BEAM_RADIUS);
      model.beam.material.opacity = BEAM_OPACITY * (1 - BEAM_PULSE_DEPTH * (0.5 + 0.5 * Math.sin(time * BEAM_PULSE)));
      model.sphere.position.copy(end);
    }

    return {
      update(ctx) {
        time += ctx.dt;
        model.root.visible = true;
        model.root.scale.setScalar(env.getScale());
        if (ctx.primaryPressed && !holding) {
          holding = true;
          dist = THREE.MathUtils.clamp(ctx.aim?.valid ? ctx.aim.dist : PHYS.HOLD_MAX, PHYS.HOLD_MIN, PHYS.HOLD_MAX);
        }
        if (holding && !ctx.primary) release();
        if (holding && ctx.wheel) {
          // +1 = wheel rolled down/toward you: pull the ball in
          dist = THREE.MathUtils.clamp(dist - ctx.wheel * PHYS.WHEEL_STEP, PHYS.HOLD_MIN, PHYS.HOLD_MAX);
        }
        if (holding) {
          hold.copy(ctx.eye).addScaledVector(ctx.dir, dist);
          if (ctx.secondaryPressed) {
            run(ctx, PHYS_MODE.FLING);
            flungAt = time;
            release();
          } else if (ctx.stepsPerFrame > 0) run(ctx, PHYS_MODE.HOLD);
        }
        const k = Math.max(0, 1 - (time - flungAt) / RECOIL_TIME);
        model.gun.position.set(GUN_POS[0], GUN_POS[1], GUN_POS[2] + k * RECOIL_BACK);
        model.tip.material.opacity = holding ? 1 : TIP_IDLE;
        model.beam.visible = model.sphere.visible = holding;
        if (holding) drawBeam();
      },
      deselect() {
        release();
        model.root.visible = false;
      },
      status: () => (holding ? `${Math.round(dist)} cells` : null),
      wantsWheel: () => holding,
      get hold() { return holding ? hold.clone() : null; },   // for checks
      dispose() { pass.dispose(); disposeTree(model.root); },
    };
  },
};
