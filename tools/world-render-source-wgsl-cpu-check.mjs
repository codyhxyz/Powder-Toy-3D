// CPU-only Naga validation of actual raw source and exact persistence modules.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { rawSourceGrid } from '../src/world/renderSourceProducer.js';
import { rawGenerateWGSL, rawStampWGSL, rawApplyWGSL, nativeAirWGSL } from '../src/shaders/renderSource.js';
import { sceneDiffFrag } from '../src/shaders/generate.js';
import { nagaSpawn } from './naga.mjs';
const imported = createImportedMapScene(JSON.parse(readFileSync(new URL('../public/local-maps/androgenAssault.json', import.meta.url), 'utf8')));
const scenes = [...WORLD_SCENES, imported];
let count = 0;
for (const height of [128, 384]) {
  const raw = rawSourceGrid(height), sim = { nx: 128, ny: height, nz: 128 };
  const modules = [
    ['stamp', rawStampWGSL(raw)], ['apply', rawApplyWGSL(sim, raw)], ['v2-air', nativeAirWGSL(sim)],
    ...scenes.flatMap(scene => [[`${scene.key}-generate`, rawGenerateWGSL(raw, scene)], [`${scene.key}-persist`, sceneDiffFrag(sim, scene.glsl(sim))]]),
  ];
  for (const [name, code] of modules) {
    const resources = [...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+\w+\s*:\s*([^;]+);/g)];
    assert(resources.every(r => Number(r[1]) < 4));
    assert(resources.filter(r => r[3]?.startsWith('storage')).length <= 8, `${name}: storage budget`);
    assert(resources.filter(r => r[4].startsWith('texture_')).length <= 16);
    const run = nagaSpawn(code, `${name}-${height}.wgsl`, {encoding: 'utf8'});
    if (run.error || run.status !== 0) throw new Error(`${name}-${height}: ${run.error ?? run.stderr ?? run.stdout}`);
    count++;
  }
  console.log(`PASS Naga raw source and exact persistence at height ${height}; raw A/B each ${raw.slots * 32} bytes < 128 MiB`);
}
console.log(`PASS ${count} actual assembled source/persistence modules and default binding limits; no GPU/browser`);
