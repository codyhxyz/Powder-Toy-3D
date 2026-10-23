// The V2 CPU suite (run locally; not part of the deploy since CI was trimmed): every CPU-only check of Physics V2
// (tools/v2/*-check.mjs, tools/v2/check-*.mjs, tools/outcomes/*-check.mjs), plus the import and
// state-access lints, one at a time. A script that launches a browser is left out (GPU checks run on
// the Mac, CLAUDE.md), so a new browser check never reaches CI by accident.
//   --skip-long  leave out LONG (the deploy job), --only-long  run just LONG (its parallel job)
//   --list       print the selection and exit
// usage: node tools/v2/cpu-suite.mjs [--skip-long | --only-long] [--list]
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
// minutes together (column-run water's WGSL twin, about 210 s since the pair stages run 4 times a tick), split
// by case into four processes of about a minute each (tools/v2/column-wgsl-cases.mjs): the deploy's parallel job
export const LONG = ['tools/v2/column-wgsl-check.mjs', 'tools/v2/column-wgsl-summaries-check.mjs',
  'tools/v2/column-wgsl-layers-check.mjs', 'tools/v2/column-wgsl-bench-check.mjs'];
const BROWSER = /browser\.mjs|playwright|launchBrowser|newTestPage|chromium|vite-server/;
// CPU-only although they name the launcher (native-grid-check stubs newTestPage)
const CPU_ONLY = new Set(['tools/outcomes/native-grid-check.mjs']);
const list = (dir, pick) => readdirSync(join(root, dir)).filter(pick).sort().map(f => `${dir}/${f}`);

export function selection({ long = 'with' } = {}) {
  const all = [
    ...list('tools/v2', f => f.endsWith('-check.mjs') || /^check-.*\.mjs$/.test(f)),
    ...list('tools/outcomes', f => f.endsWith('-check.mjs')),
    'tools/check-imports.mjs', 'tools/check-state-access.mjs',
  ];
  const cpu = all.filter(rel => CPU_ONLY.has(rel) || !BROWSER.test(readFileSync(join(root, rel), 'utf8')));
  return long === 'skip' ? cpu.filter(rel => !LONG.includes(rel)) : long === 'only' ? cpu.filter(rel => LONG.includes(rel)) : cpu;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const picked = selection({ long: argv.includes('--skip-long') ? 'skip' : argv.includes('--only-long') ? 'only' : 'with' });
  if (argv.includes('--list')) { console.log(picked.join('\n')); process.exit(0); }
  const failed = [];
  for (const rel of picked) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [rel], { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    const ok = r.status === 0, s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${rel} ${s}s`);
    if (!ok) { failed.push(rel); console.log(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.split('\n').filter(Boolean).slice(-20).join('\n')); }
  }
  console.log(`V2 CPU suite: ${picked.length - failed.length}/${picked.length} passed${failed.length ? `; failed: ${failed.join(' ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
