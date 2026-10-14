// CPU-only: compile every native dynamics stage against the actual foundation
// adapter and enforce the spec's eight-storage-buffer limit. No browser/GPU.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gridLayout } from '../../src/sim.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { particlesWGSL, PARTICLE_STAGES, PARTICLES_LAYOUT } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, BLASTS_LAYOUT } from '../../src/shaders/v2/blasts.js';
import { airWGSL, AIR_STAGES, AIR_LAYOUT } from '../../src/shaders/v2/air.js';
const dir=mkdtempSync(join(tmpdir(),'native-dynamics-'));
let count=0; const failures=[];
// Naga accepts these ungrouped products, but Chromium rejects mixed XOR/math.
const ungroupedHashProduct=/[\w.]+\s*\*\s*[\w.]+\s*\^|\^\s*[\w.]+\s*\*/;
assert.match('w.x * 73856093u ^ w.y',ungroupedHashProduct);
assert.match('id ^ P.tick * 2654435761u',ungroupedHashProduct);
assert.doesNotMatch('(w.x * 73856093u) ^ (P.tick * 2654435761u)',ungroupedHashProduct);
try {
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
        assert.doesNotMatch(source,ungroupedHashProduct,`${name}/${stage} hash arithmetic requires explicit grouping`);
        assert.equal([...source.matchAll(/var<storage,/g)].length,8,`${name}/${stage} storage count`);
        const file=join(dir,`${name}-${stage}-${dims.join('x')}.wgsl`); writeFileSync(file,source);
        const result=spawnSync('naga',[file],{encoding:'utf8'}); count++;
        if (result.error) throw result.error;
        if (result.status) failures.push(`${name}/${stage}/${dims}: ${result.stderr}`);
      }
    }
  }
  console.log(`${count} native dynamics WGSL modules; ${failures.length} failures; max8 storage buffers`);
  for (const error of failures) console.error(error);
  process.exitCode=failures.length?1:0;
} finally { rmSync(dir,{recursive:true,force:true}); }
