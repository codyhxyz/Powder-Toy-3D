// CPU checks only. Native GPU checks require the parent's serialized test slot.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const lanes = [
  // Core covers change tracking, geometry, materials, shared shadows and the
  // production composition. Shading covers lighting and selective reflections.
  'core', 'shading', 'smooth', 'optics', 'media', 'particles',
  'motion', 'temporal', 'resolution',
];
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const list = args.length === 1 && args[0] === '--list';
if (args.length && !list) {
  console.error('Usage: node tools/hybrid-check.mjs [--list]');
  process.exit(2);
}

let failed = 0;
for (const lane of lanes) {
  const path = `tools/hybrid-${lane}-check.mjs`;
  const present = existsSync(new URL(`../${path}`, import.meta.url));
  if (list) {
    console.log(`${lane}: ${present ? path : 'not delivered'}`);
    continue;
  }
  if (!present) {
    console.error(`Missing lane check: ${path}`);
    failed++;
    continue;
  }
  console.log(`\n--- ${lane} ---`);
  let laneFailed=false;
  for(const grid of lane==='core'?['32','64','128','wide','valley','giant']:[null]){
    const result = spawnSync(process.execPath, [path,...(grid?[grid]:[])], {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000,
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error(`${lane}${grid?'@'+grid:''} failed: ${result.error?.message ?? result.signal ?? result.status}`);
      laneFailed=true;
    }
  }
  if(laneFailed)failed++;
}
if (!list) {
  console.log(`\nHybrid CPU lanes: ${lanes.length - failed}/${lanes.length} passed.`);
  process.exitCode = failed ? 1 : 0;
}
