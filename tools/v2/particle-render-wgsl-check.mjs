// CPU-only Naga validation. No browser/device or GPU slot.
import { WGSL_CHECK } from '../../src/shaders/v2/particleRender.js';
import { assertNaga } from './wgsl-grouping.mjs';
for (const entry of WGSL_CHECK) {
  assertNaga(entry.code(),entry.name);
  console.log(`${entry.name}: Naga passed`);
}
