// Compatibility CLI; all four maps use one converter/profile pipeline.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { convertCrueltyMap, writeConvertedMap } from './import-cruelty-map.mjs';
import { crueltyProfile } from '../src/world/import/crueltyProfiles.js';
export const convertParadise = (text) => convertCrueltyMap(text, crueltyProfile('paradise'));
async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --source Levels/Level2.tscn [--out .tmp-cruelty-import/paradise]');
    opts[args[i]] = args[i + 1];
  }
  if (!opts['--source']) throw new Error('An actual Level2.tscn source is required');
  await writeConvertedMap(convertParadise(await readFile(opts['--source'], 'utf8')), opts['--out'] ?? '.tmp-cruelty-import/paradise');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
