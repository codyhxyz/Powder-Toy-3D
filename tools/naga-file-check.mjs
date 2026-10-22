// CPU only. The CPU checks hand naga a module as a file with a deadline (tools/naga.mjs), never
// through its stdin: piping it there sometimes never returns on macOS (naga waits in read() for an
// EOF node never sends; node waits in its sync loop with nothing to wake it), which hung
// tools/world-plain-cpu-check.mjs about once in 80 runs and stalled the deploy sequence.
//   node tools/naga-file-check.mjs              the deterministic checks below
//   node tools/naga-file-check.mjs --stress N   the race itself, N calls each way on the 377 KB World
//                                               Plain module (stochastic: 2 of 4800 stdin calls hung
//                                               on 2026-10-22, 0 of 4800 file calls; run 8 at once)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { nagaSpawn, nagaExec, NAGA_TIMEOUT_MS } from './naga.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

if (process.argv.includes('--stress')) {
  const n = +process.argv[process.argv.indexOf('--stress') + 1] || 600;
  const { volumeFrag } = await import('../src/shaders/render.js');
  const code = volumeFrag({ nx: 3072, ny: 384, nz: 1024, sourceAppearance: true, sourceGrid: [384, 16, 128] }, { backend: 'world', view: 'plain' });
  for (const mode of ['stdin', 'file']) {
    let hung = 0; const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const r = mode === 'stdin' ? spawnSync('naga', ['--stdin-file-path', 'plain.wgsl'], { input: code, encoding: 'utf8', timeout: 15000 })
        : nagaSpawn(code, 'plain.wgsl', { timeout: 15000 });
      if (r.error?.code === 'ETIMEDOUT') hung++;
      else assert.equal(r.status, 0, r.stderr);
    }
    console.log(`${mode}: ${n} calls of ${code.length} B, ${hung} hung (killed at 15 s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  process.exit(0);
}

// 1. No check pipes a module into naga's stdin: every one goes through tools/naga.mjs.
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === 'node_modules' || n.startsWith('.')) return [];
  return statSync(p).isDirectory() ? walk(p) : /\.(m?js|cjs)$/.test(n) ? [p] : [];
});
const offenders = [];
for (const file of [...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'scripts'))]) {
  if (file.endsWith('/tools/naga.mjs') || file.endsWith('/tools/naga-file-check.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  if (/--stdin-file-path/.test(text) || /\(\s*['"]naga['"][^)]*\binput\s*:/.test(text)) offenders.push(relative(ROOT, file));
}
assert.deepEqual(offenders, [], `pipe a module into naga's stdin (use tools/naga.mjs nagaSpawn/nagaExec): ${offenders.join(', ')}`);

// 2. The helper hands the validator a file holding the module, and nothing on its stdin: a
// validator that reads its stdin to the end (as naga does) gets EOF at once.
const dir = mkdtempSync(join(tmpdir(), 'naga-file-check-'));
try {
  const fake = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const reader = fake('reader.sh', 'cat > /dev/null; printf "%s\\n" "$1"; cat "$1"');
  const code = '@compute @workgroup_size(1) fn main() {}\n'.repeat(4096);   // (well over a pipe's buffer)
  const r = nagaSpawn(code, 'probe.wgsl', { bin: reader, timeout: 10000 });
  assert.equal(r.error, undefined, 'the validator ran to its end');
  assert.equal(r.status, 0);
  const [path, ...rest] = r.stdout.split('\n');
  assert.match(path, /probe\.wgsl$/, 'a file named after the module, with its extension');
  assert.equal(rest.join('\n'), code, 'holding the module, byte for byte');
  // 3. A validator that never answers fails with the module's name at its deadline, never holds
  // the run: what the deploy sequence's 600 s timeout met twice.
  const stuck = fake('stuck.sh', 'exec sleep 30');
  const t0 = Date.now();
  assert.throws(() => nagaExec('fn f() {}', 'stuck.wgsl', { bin: stuck, timeout: 300 }), /naga stuck\.wgsl: no answer in 300 ms/);
  assert(Date.now() - t0 < 10000, 'killed at its deadline');
  assert(NAGA_TIMEOUT_MS >= 10000 && NAGA_TIMEOUT_MS <= 120000, 'a deadline a real module never meets, well under the deploy step\'s');
} finally { rmSync(dir, { recursive: true, force: true }); }

// 4. Real naga, through the helper: a valid module passes, an invalid one fails with its messages.
assert.equal(nagaSpawn('@compute @workgroup_size(1) fn main() {}', 'ok.wgsl').status, 0);
const bad = nagaSpawn('fn main() -> u32 { return 1.5; }', 'bad.wgsl');
assert.notEqual(bad.status, 0); assert.match(`${bad.stdout}${bad.stderr}`, /bad\.wgsl|error/i);
assert.throws(() => nagaExec('fn main() -> u32 { return 1.5; }', 'bad.wgsl'), /naga bad\.wgsl exited/);
console.log('naga: every check validates through a file with a deadline (none pipes stdin); the helper writes the module whole, gives the validator no stdin, and a stalled one fails at its deadline');
