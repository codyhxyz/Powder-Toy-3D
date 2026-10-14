// CPU-only WGSL validation for the shared reader change. Requires the Naga CLI
// (cargo install naga-cli). This does NOT substitute for WebGPU runtime checks.
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gridLayout } from '../../src/sim.js';
import { GRIDS } from '../check-sampler-budget.mjs';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';

const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});
const dir = mkdtempSync(join(tmpdir(), 'compact-wgsl-'));
let count = 0, groupingCount = 0;
const failures = [];
try {
  for (const path of walk('src')) {
    if (!/export\s+(const|let|function)\s+WGSL_CHECK\b/.test(readFileSync(path, 'utf8'))) continue;
    const mod = await import(pathToFileURL(resolve(path)));
    const entries = typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK;
    for (const entry of entries ?? []) {
      const key = Array.isArray(entry.grids) ? entry.grids[0] : '32';
      const g = entry.grids === false ? null : { ...gridLayout(...GRIDS[key]), name: key };
      const file = join(dir, `${count++}.wgsl`);
      const source=entry.code(g);
      // The supplementary parser cannot handle every legacy scene template.
      // Audit native shaders here; Naga still validates every registered module.
      if(path==='src/shaders/v2.js' || path.startsWith('src/shaders/v2/')) {
        try {
          for(const error of wgslGroupingErrors(source)) failures.push(`${path}:${entry.name}\n${error}`);
          groupingCount++;
        } catch(error) {
          throw new Error(`${path}:${entry.name} grouping parser: ${error.message}`);
        }
      }
      writeFileSync(file, source);
      const result = spawnSync('naga', [file], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status) failures.push(`${path}:${entry.name}\n${result.stderr}`);
    }
  }
  if (!count) throw new Error('No shaders discovered');
  console.log(`${count} WGSL modules CPU Naga validation; ${groupingCount} native grouping audits; ${failures.length} failures`);
  for (const failure of failures) console.error(failure);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
