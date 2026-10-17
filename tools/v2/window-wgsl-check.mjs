// CPU-only Naga generation/validation. Never opens a browser or GPU device.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { WGSL_CHECK as window } from '../../src/shaders/v2/window.js';
import { WGSL_CHECK as transfer } from '../../src/shaders/v2/transfer.js';
import { assertNaga } from './wgsl-grouping.mjs';
let count = 0;
for (const dims of [[32, 32, 32], [256, 96, 128], [128, 384, 128]]) {
  const g = gridLayout(...dims);
  for (const entry of [...window, ...transfer]) {
    assertNaga(entry.code(g), entry.name);
    const storage = entry.layouts().flat().filter(e => e?.buffer?.type?.includes('storage')).length;
    assert(storage <= 8, `${entry.name}: ${storage} storage bindings exceeds portable WebGPU limit`);
    count++;
  }
}
console.log(`${count} generated native shift/gather/scatter/transfer modules passed CPU Naga and <=8-storage checks (box, rectangular world, giant world)`);
