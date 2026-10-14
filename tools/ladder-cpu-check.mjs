import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayer } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { overlapsLadder, LADDER_SPEED } from '../src/pov/ladder.js';

const ladders = [{ bounds: { min: [20, 2, 20], max: [22, 40, 22] } }];
assert.ok(overlapsLadder(ladders, new THREE.Vector3(19.8, 5, 21), 1, 6), 'body overlap, not feet point containment');
assert.ok(!overlapsLadder(ladders, new THREE.Vector3(18, 5, 21), 1, 6));
assert.ok(!overlapsLadder([], new THREE.Vector3(21, 5, 21), 1, 6), 'ordinary maps have no ladder effects');
assert.ok(!overlapsLadder([{ ...ladders[0], axes: [{ normal: [1, 0, 0], min: 25, max: 26 }] }],
  new THREE.Vector3(21, 5, 21), 1, 6), 'convex trigger, not only rectangular broadphase');

const flush = () => new Promise(resolve => setImmediate(resolve));
for (const fps of [30, 60, 120]) {
  const sim = { g: { nx: 64, ny: 64, nz: 64 }, frame: 0, gravity: 0.025, touchCentres: () => [], paint() {} };
  let ceiling = false;
  setPovGpu(sim, { ready: true, edit: () => true, transfer: () => null,
    probe(_name, { boxLo: lo }) {
      const data = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const at = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        data[at] = lo[1] + y < 1 || (ceiling && lo[1] + y >= 35) ? E.WALL : E.EMPTY;
        data[at + 1] = 20;
      }
      return Promise.resolve(data.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const frame = async input => { sim.frame++; body.update(1 / fps, input); await flush(); };
  const frames = async (n, input) => { for (let i = 0; i < n; i++) await frame(input); };
  try {
    body.spawn(new THREE.Vector3(21, 10, 21));
    await frames(5, { ladder: true });
    const y = body.pos.y;
    await frames(fps / 2, { ladder: true, climb: new THREE.Vector3(0, 1, 0), jump: true });
    assert.ok(Math.abs(body.pos.y - y - LADDER_SPEED / 2) < 0.05, 'source climb speed independent of frame rate');
    assert.equal(body.jetting, false);
    assert.ok(body.climbing);
    const at = body.pos.clone();
    await frames(10, { ladder: true });
    assert.ok(body.pos.distanceTo(at) < 1e-7, 'idle grips ladder instead of falling');
    await frames(10, { ladder: true, climb: new THREE.Vector3(0, -1, 0) });
    assert.ok(body.pos.y < at.y, 'looking down/back moves down');
    ceiling = true;
    body.teleport(new THREE.Vector3(21, 28, 21));
    await frames(5, { ladder: true });
    await frames(fps / 2, { ladder: true, climb: new THREE.Vector3(0, 1, 0) });
    assert.ok(body.pos.y + body.height <= 35.001, 'climbing uses the actual body collision sweep');
    ceiling = false;
    body.teleport(new THREE.Vector3(21, 20, 21));
    await frames(5, { ladder: true });
    const released = body.pos.y;
    await frames(10, {});
    assert.ok(!body.climbing && body.pos.y < released, 'leaving volume restores gravity');
    console.log(`ok ${fps} fps source ladder speed, grip, descend, ceiling collision, leave`);
  } finally { body.dispose(); }
}
