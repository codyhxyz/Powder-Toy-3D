// CPU-only Naga validation. No browser/device or GPU slot.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WGSL_CHECK } from '../../src/shaders/v2/particleRender.js';
const dir = mkdtempSync(join(tmpdir(),'native-particle-wgsl-'));
try {
  for (const entry of WGSL_CHECK) {
    const file = join(dir,`${entry.name}.wgsl`);
    writeFileSync(file,entry.code());
    const result = spawnSync('naga',[file],{ encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status) throw new Error(`${entry.name}: ${result.stdout}\n${result.stderr}`);
    console.log(`${entry.name}: Naga passed`);
  }
} finally { rmSync(dir,{ recursive: true, force: true }); }
