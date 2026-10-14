// CPU-only: the converted source levels ship with the site, so the build must
// contain them — packed, under the host's per-file limit, and loadable.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';
import { actorBodyClear } from '../src/world/import/crueltyMission.js';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { ELEMENTS, K } from '../src/elements.js';

// Cloudflare Pages rejects any single asset over 25 MiB (docs/cruelty-source-comparison.md).
const FILE_LIMIT = 25 * 1024 * 1024;
const profiles = CRUELTY_PROFILES.filter((p) => !p.blocked);
const expected = profiles.flatMap((p) => [`${p.id}.json`, `${p.id}.binpack`]).sort();
let packed = 0;

for (const directory of ['public/local-maps', 'dist/local-maps']) {
  assert.deepEqual((await readdir(directory)).sort(), expected, `${directory} holds exactly the converted levels`);
  for (const name of expected) {
    const path = join(directory, name), info = await stat(path);
    assert.ok(info.size < FILE_LIMIT, `${path} is under the host's per-file limit`);
    if (!name.endsWith('.json')) continue;
    const map = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(map.id, name.slice(0, -5));
    const buffer = gunzipSync(await readFile(join(directory, `${map.id}.binpack`)));
    if (directory === 'public/local-maps') packed += info.size;
    const words = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    // Validates the manifest, every brick pointer and every packed element id.
    const scene = createImportedMapScene(map, words);
    assert.deepEqual(scene.size, map.size);
    assert.ok(scene.mission.spawn || scene.mission.available === false, `${map.id} has a start`);
    // Every actor the mission will actually place stands clear in the shipped bytes.
    const actors = [scene.mission.spawn, ...scene.mission.targets.map((a) => a.at), ...scene.mission.guards.map((a) => a.at)].filter(Boolean);
    assert.equal(actors.length, 1 + scene.mission.targets.length + scene.mission.guards.length, `${map.id} placements`);
    for (const at of actors) {
      assert.equal(ELEMENTS[scene.cell(Math.floor(at[0]), at[1] - 1, Math.floor(at[2]))]?.kind, K.SOLID, `${map.id} actor floor`);
      assert.ok(actorBodyClear(map, words, at), `${map.id} actor body clearance`);
    }
  }
  assert.ok(!expected.some((n) => n.endsWith('.bin')), `${directory} ships no uncompressed geometry`);
}
console.log(`PASS the build ships ${profiles.length} converted source levels, packed (${(packed / 1e6).toFixed(2)} MB of packed geometry, under the 25 MiB per-file limit)`);
