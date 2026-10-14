// CPU-only production boundary: original game-derived local imports must not ship.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

assert.ok(!existsSync('public/local-maps'), 'Original local maps must stay outside public/');
assert.ok(!existsSync('dist/local-maps'), 'Original local maps leaked into production');
async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await check(path);
    else if (item.name.endsWith('.js')) {
      const text = await readFile(path, 'utf8');
      for (const needle of ['/local-maps/', 'sparse-brick-u8-v1', 'uImportBricks'])
        assert.ok(!text.includes(needle), `${path} includes the dev-only source importer: ${needle}`);
    }
  }
}
await check('dist');
console.log('PASS production excludes original local maps and their dev-only loader');
