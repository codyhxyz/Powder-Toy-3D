// CPU-only: compile every native dynamics stage against the actual foundation
// adapter and enforce the spec's eight-storage-buffer limit. No browser/GPU.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { particlesWGSL, PARTICLE_STAGES, PARTICLES_LAYOUT } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, BLASTS_LAYOUT } from '../../src/shaders/v2/blasts.js';
import { airWGSL, AIR_STAGES, AIR_LAYOUT } from '../../src/shaders/v2/air.js';
import { wgslGroupingErrors, nagaErrors } from './wgsl-grouping.mjs';
let count=0; const failures=[];
for (const [name,generate,stages,layout] of [
  ['particles',particlesWGSL,PARTICLE_STAGES,PARTICLES_LAYOUT],
  ['blasts',blastsWGSL,BLAST_STAGES,BLASTS_LAYOUT],
  ['air',airWGSL,AIR_STAGES,AIR_LAYOUT],
]) {
  assert.equal(V2_DYNAMICS_LAYOUT.length+layout.length,8);
  for (const dims of [[32,32,32],[48,16,32]]) {
    const g=gridLayout(...dims);
    for (const stage of stages) {
      const source=generate(g,nativeDynamicsHead,stage);
      assert.deepEqual(wgslGroupingErrors(source),[],`${name}/${stage} mixed operators require explicit grouping`);
      assert.equal([...source.matchAll(/var<storage,/g)].length,8,`${name}/${stage} storage count`);
      const errors=nagaErrors(source); count++;
      if (errors) failures.push(`${name}/${stage}/${dims}: ${errors}`);
    }
  }
}
console.log(`${count} native dynamics WGSL modules; ${failures.length} failures; max8 storage buffers`);
for (const error of failures) console.error(error);
process.exitCode=failures.length?1:0;
