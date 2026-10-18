// CPU-only: a v2 world outcome must not accidentally certify the v1 fallback.
import assert from 'node:assert/strict';
import { appPhysicsClock } from '../outcomes/engine-app.js';
import { runTest } from '../outcomes/run.js';

assert.equal(appPhysicsClock({ expectedPhysics: 'v1', steps: 4 }), 240);
assert.equal(appPhysicsClock({ expectedPhysics: 'v1', steps: 2, stepsPerSecond: 120 }), 120);
assert.equal(appPhysicsClock({ expectedPhysics: 'v2', physics: { active: true }, steps: 4 }), 60);
assert.throws(() => appPhysicsClock({ expectedPhysics: 'v2', physics: { mode: 'v2', active: false }, steps: 4 }), /runs v1/);
assert.throws(() => appPhysicsClock({ expectedPhysics: 'v2', steps: 4 }), /runs v1/);
assert.throws(() => appPhysicsClock({ expectedPhysics: 'v1', physics: { active: true }, steps: 4 }), /runs v2/);

let disposed = false, ran = false;
const result = await runTest({ name: 'settledWorld', run() { ran = true; } }, {
  name: 'app', info: { clock: '' }, id() { return 0; }, advance() {},
  create() { appPhysicsClock({ expectedPhysics: 'v2', physics: { active: false }, steps: 4 }); },
  dispose() { disposed = true; },
});
assert.equal(result.status, 'error');
assert.match(result.reason, /setup: v2 was requested/);
assert.equal(ran, false);
assert.equal(disposed, true);
console.log('app outcome adapter: engine identity, clock and fallback rejection passed');
