// CPU-only actual generated native grid kernels, including full contact ABI.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { V2_KERNELS, v2BlockWGSL } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { assertNaga } from './wgsl-grouping.mjs';
let count=0;
for (const dims of [[32,32,32],[48,16,32]]) {
  const g=gridLayout(...dims);
  for (const kernel of [...V2_KERNELS,{name:'contact-modes',code:g=>v2BlockWGSL(g,contactWGSL)}]) {
    assertNaga(kernel.code(g),kernel.name); count++;
  }
}
console.log(`${count} actual native grid/contact mode WGSL modules validated (CPU Naga, no GPU)`);
