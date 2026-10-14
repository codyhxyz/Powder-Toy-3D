import * as THREE from 'three';

// Three.js owns interpolation, crossfades and one-shot playback; physics owns takeoff/landing.
// Minecraft horse-jump anticipation, with a forward-reaching toy silhouette.
export function createLeapAnimation(body, limbs) {
  // Sample a separate pose so a punch/tool can override an arm without corrupting held mixer values.
  const pose = new THREE.Group(), limbPoses = limbs.map(() => new THREE.Group());
  pose.add(...limbPoses);
  const mixer = new THREE.AnimationMixer(pose);
  const track = (node, property, times, values) =>
    new THREE.NumberKeyframeTrack(`${node.uuid}.${property}`, times, values, THREE.InterpolateSmooth);
  const clip = (name, times, { y, pitch, legs, arms }) => {
    const tracks = [track(pose, 'position[y]', times, y), track(pose, 'rotation[x]', times, pitch)];
    limbPoses.forEach((limb, i) => tracks.push(track(limb, 'rotation[x]', times, i % 2 ? arms : legs)));
    const action = mixer.clipAction(new THREE.AnimationClip(name, -1, tracks));
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
    return action;
  };
  const actions = {
    charge: clip('charge', [0, 1], { y: [0, -0.6], pitch: [0, -0.28], legs: [0, 0.45], arms: [0, -0.85] }),
    leap: clip('leap', [0, 0.09, 0.24], { y: [-0.25, 0.12, 0], pitch: [-0.28, -0.7, -0.5],
      legs: [0.45, -0.65, -0.4], arms: [-0.85, 2.3, 2] }),
    fall: clip('fall', [0, 0.18], { y: [0, 0], pitch: [-0.5, -0.15], legs: [-0.4, 0.25], arms: [2, 0.6] }),
    land: clip('land', [0, 0.07, 0.26], { y: [0, -0.5, 0], pitch: [-0.15, -0.35, 0],
      legs: [0.25, 0.5, 0], arms: [0.6, -0.3, 0] }),
  };
  let state = null, action = null, wasLeaping = false;
  return {
    update(dt, motion, reduced = false) {
      const leaping = !!motion?.leaping && !motion.onGround && !motion.inLiquid && !motion.dead;
      let next = motion?.jumpCharge != null ? 'charge'
        : leaping ? (motion.vel.y > 0 ? 'leap' : 'fall')
          : wasLeaping && motion.onGround ? 'land'
            : state === 'land' && !action.paused ? 'land' : null;
      wasLeaping = leaping;
      if (motion?.dead || motion?.inLiquid) next = null;
      if (next !== state) {
        const previous = action;
        action = next ? actions[next].reset().play() : null;
        if (action && previous) action.crossFadeFrom(previous, 0.08, false);
        if (!action) mixer.stopAllAction();
        state = next;
      }
      if (!action) return false;
      if (state === 'charge') { action.time = motion.jumpCharge; action.paused = true; }
      // Keep the physical arc, but soften nonessential motion through mixer weights.
      for (const a of Object.values(actions)) a.weight = reduced ? 0.25 : 1;
      mixer.update(dt);
      body.position.y = pose.position.y; body.rotation.x = pose.rotation.x;
      limbs.forEach((limb, i) => { limb.rotation.x = limbPoses[i].rotation.x; });
      return true;
    },
    reset() { mixer.stopAllAction(); state = action = null; wasLeaping = false; },
  };
}
