import { Matrix4, Vector3 } from 'three';
import { createBody } from '../pov/figureReal.js';
import { volumeLight } from '../pov/gpu.js';
import { interpolatePose } from './protocol.js';

// Presentation only: remote bodies never register hitboxes, tools or simulation writers.
export function createRemotePlayers({ scene, renderer, camera, getSim, getVolume, makeBody = createBody }) {
  const peers = new Map(), inverse = new Matrix4(), feet = new Vector3();
  function remove(id) { const p = peers.get(id); if (!p) return; scene.remove(p.body.root); p.body.dispose(); peers.delete(id); }
  return {
    set(id, pose) {
      let p = peers.get(id);
      if (!p) {
        const body = makeBody({ choice: () => 'stick' });
        p = { body, pose: null, from: null, age: 0 };
        peers.set(id, p); scene.add(body.root);
        body.compile(renderer, camera, scene).catch((err) => console.warn('Remote body compile failed', err));
      }
      if (p.pose && pose.seq <= p.pose.seq && pose.map === p.pose.map) return;
      p.from = p.pose ? interpolatePose(p.from, p.pose, Math.min(1, p.age / 0.1)) : null;
      p.pose = { ...pose, p: pose.p.slice() }; p.age = 0;
    },
    remove,
    clear() { for (const id of [...peers.keys()]) remove(id); },
    update(dt) {
      const sim = getSim(), vol = getVolume(); if (!sim || !vol) return;
      vol.updateMatrixWorld(); inverse.copy(vol.matrixWorld).invert();
      for (const p of peers.values()) {
        p.age += dt;
        const pose = interpolatePose(p.from, p.pose, Math.min(1, p.age / 0.1));
        p.body.setVisible(pose.active && p.age < 3);
        if (!pose.active) continue;
        feet.fromArray(pose.p).sub(sim.origin).applyMatrix4(vol.matrixWorld);
        p.body.bind(volumeLight(vol), sim.g);
        p.body.update(dt, { feet, scale: vol.scale.x, yaw: pose.yaw, worldToGrid: inverse,
          speedH: Math.hypot(pose.vel[0], pose.vel[2]), velY: pose.vel[1], onGround: !!pose.ground,
          inLiquid: !!pose.liquid, headInLiquid: false, dead: false, deadTime: 0, heat: 0,
          jetting: !!pose.jet, crouch: 0, sprintRush: 0, look: { pitch: pose.pitch, spine: 0 }, lift: 0 });
      }
    },
  };
}
