// Import-order regression: real engine graphs, CPU only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('Atlas/history/SourceCut imports have no WRITER_CHANNELS initialization cycle',()=>{
  const modules=['./src/world/renderAtlas.js','./src/world/worldLightingHistory.js','./src/world/sourceCut.js'];
  for(const order of [modules,[...modules].reverse(),[modules[1],modules[0],modules[2]]]){
    const run=spawnSync(process.execPath,['--input-type=module','-e',order.map(p=>`await import(${JSON.stringify(p)});`).join('')],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  }
});
