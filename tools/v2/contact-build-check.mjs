// CPU-only production/minification regression. No browser or GPU.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { contactPrelude, contactEntry } from './contact-prelude.mjs';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';
// Chromium's WGSL parser rejects ungrouped arithmetic mixed with XOR, even
// though Naga accepts it. Check the real emitted seed expression before bundling.
const seedExpression=contactWGSL.match(/fn ctSeed[^]*?return bitcast<i32>\(([^;]+)\);/)[1];
assert.deepEqual(seedExpression.split(' ^ '),[
  '(u32(position.x)*73856093u)','(u32(position.y)*19349663u)',
  '(u32(position.z)*83492791u)','(tick*2654435761u)',
]);
const dir = mkdtempSync(join(tmpdir(), 'contact-build-'));
try {
  const bundle = await build({ configFile: false, logLevel: 'warn', build: {
    write: false, minify: true, lib: { entry: 'src/shaders/v2/contact.js', formats: ['es'] },
  } });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  const chunk = result.output.find(x => x.type === 'chunk' && x.isEntry);
  assert.ok(chunk, 'production bundle has an entry');
  const module = join(dir, 'contact.mjs'); writeFileSync(module, chunk.code);
  const minified = await import(pathToFileURL(module));
  assert.equal(minified.contactWGSL, contactWGSL, 'minification cannot change generated WGSL');
  const source=contactPrelude + minified.contactWGSL + contactEntry;
  assert.deepEqual(wgslGroupingErrors(source),[],'production contact mixed operators require grouping');
  const file = join(dir, 'contact.wgsl'); writeFileSync(file, source);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error) throw naga.error;
  assert.equal(naga.status, 0, naga.stderr);
  console.log('Production minified native contact bundle: identical WGSL; Naga valid; no GPU');
} finally { rmSync(dir, { recursive: true, force: true }); }
