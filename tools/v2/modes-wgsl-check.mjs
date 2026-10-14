// CPU-only actual generated native grid kernels, including full contact ABI.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gridLayout } from '../../src/sim.js';
import { V2_KERNELS, v2BlockWGSL } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
const dir=mkdtempSync(join(tmpdir(),'native-modes-')); let count=0;
try {
  for (const dims of [[32,32,32],[48,16,32]]) {
    const g=gridLayout(...dims);
    for (const kernel of [...V2_KERNELS,{name:'contact-modes',code:g=>v2BlockWGSL(g,contactWGSL)}]) {
      const code=kernel.code(g), file=join(dir,`${kernel.name}-${dims.join('x')}.wgsl`);
      writeFileSync(file,code); const result=spawnSync('naga',[file],{encoding:'utf8'});
      if (result.error) throw result.error;
      assert.equal(result.status,0,`${kernel.name}: ${result.stderr}`); count++;
    }
  }
  console.log(`${count} actual native grid/contact mode WGSL modules validated (CPU Naga, no GPU)`);
} finally { rmSync(dir,{recursive:true,force:true}); }
