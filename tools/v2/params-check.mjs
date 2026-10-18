// CPU-only: use real uniform packers, not permissive command-recording mocks.
import assert from 'node:assert/strict';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { gridLayout } from '../../src/sim.js';
import { V2Params, v2ActLayout } from '../../src/shaders/v2.js';
import { DynamicParams } from '../../src/shaders/v2/particles.js';

const owner={sim:{origin:[16,8,-24]},layout:v2ActLayout(gridLayout(32,32,32)),
  jets:{isReady:false},_params:PhysicsV2.prototype._params};
owner.sim.compact=owner;
const dynamics={owner,sequence:7};
for(const ready of [false,true])for(const tick of [0,1,2,101]) {
  owner.jets.isReady=ready;
  const grid=owner._params(tick);
  assert.equal('nativeJets' in grid,false);
  assert.equal(V2Params.pack(grid).byteLength,V2Params.size);
  const dynamic=NativeDynamics.prototype._params.call(dynamics,tick,{mode:13,substep:2});
  assert.equal(dynamic.nativeJets,+ready);
  assert.equal(dynamic.busyIn,grid.busyIn);
  assert.equal(dynamic.busyOut,grid.busyOut);
  assert.deepEqual(dynamic.origin,owner.sim.origin);
  for(const key of ['full','offset','preserveLegacyMarks'])assert.equal(key in dynamic,false);
  assert.equal(DynamicParams.pack(dynamic).byteLength,DynamicParams.size);
}
assert.throws(()=>V2Params.pack({...owner._params(1),nativeJets:1}),/no field/);
assert.throws(()=>DynamicParams.pack({...NativeDynamics.prototype._params.call(dynamics,1),offset:[0,0,0]}),/no field/);
console.log('native parameter schemas: grid/dynamics/jet clocks pack strictly; unknown-field rejection retained');
