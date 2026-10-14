// Real pogo physics over a CPU floor probe; no browser or GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayer } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';

const sim = { g: { nx: 128, ny: 128, nz: 128 }, frame: 0, gravity: 0.025, touchCentres: () => [], paint() {} };
let liquid = false;
setPovGpu(sim, {
  ready: true, edit: () => true, transfer: () => null,
  probe(name, { boxLo: lo }) {
    const buf = new Float32Array(PROBE_CELLS * 4);
    for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
      const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
      buf[i] = lo[1] + y <= 0 ? E.WALL : liquid ? E.WATER : E.EMPTY;
      buf[i + 1] = 20;
    }
    return Promise.resolve(buf.buffer);
  },
});
const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
async function step(jump = false, held = true) {
  if (held) body.holdPogo();
  sim.frame += 4;
  body.update(1 / 60, { jump });
  await new Promise(resolve => setImmediate(resolve));
}
async function until(test) {
  for (let n = 0; n < 600; n++) {
    if (test()) return;
    await step();
  }
  assert.fail('Pogo condition not reached');
}
try {
  body.spawn(new THREE.Vector3(64, 1, 64));
  assert.equal(body.pogoCharge, null);
  await until(() => body.pogoCharge?.ready);
  assert.equal(body.pogoCharge.step, 0);
  assert.equal(body.pogoCharge.max, 3);
  await step(true);
  assert.equal(body.pogoCharge.step, 1, 'the cue matches an accepted late press');
  assert.equal(body.pogoCharge.held, true);
  assert.equal(body.pogoCharge.ready, false);
  for (let level = 2; level <= 3; level++) {
    await step();
    await until(() => body.onGround);
    assert.equal(body.pogoCharge.ready, true, 'cue on actual ground contact');
    await step(true);
    assert.equal(body.pogoCharge.step, level);
  }
  await step();
  assert.equal(body.pogoCharge.ready, false, 'no extra charge cue after a timed bounce');
  await until(() => body.onGround);
  await step(true);
  assert.equal(body.pogoCharge.step, 3, 'full power is capped');
  await until(() => body.onGround);
  await step();
  assert.equal(body.pogoCharge.step, 0, 'missed landing resets the meter');
  for (let n = 0; n < 14; n++) await step();
  assert.equal(body.pogoCharge.ready, false, 'late cue expires with the physics window');
  await step(false, false);
  assert.equal(body.pogoCharge, null, 'putting away the pogo hides its charge');
  liquid = true;
  for (let n = 0; n < 10; n++) await step();
  assert.equal(body.pogoCharge, null, 'no charge while swimming');
  liquid = false;
  body.spawn(new THREE.Vector3(64, 1, 64));
  assert.equal(body.pogoCharge, null, 'respawn clears charge');
  await until(() => body.pogoCharge);
  body.hurt(2, 'test', { shielded: false });
  assert.equal(body.pogoCharge, null, 'death hides charge immediately');
  console.log('Pogo charge: levels, timing, held input, misses, deselection, swimming and respawn passed');
} finally {
  body.dispose();
}
