// CPU-only: mock ownership graphs and a disposable Node process tree.
// No browser, GPU, machine-wide slot, or other session's process is touched.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { budgetMs, ownedTree, processTable } from './gpu-deadline.mjs';

for (const n of [5000, 10000]) assert.equal(budgetMs(n), n);
for (const n of [0, -1, NaN, Infinity, 1000, 10001, 180000]) assert.throws(() => budgetMs(n), RangeError);
const table = [
  { pid: 100, ppid: 1, start: 'ours' }, { pid: 101, ppid: 100, start: 'driver' },
  { pid: 102, ppid: 101, start: 'browser' }, { pid: 103, ppid: 102, start: 'gpu' },
  { pid: 200, ppid: 1, start: 'other test' }, { pid: 201, ppid: 200, start: 'other gpu' },
  { pid: 300, ppid: 100, start: 'watchdog' }, { pid: 301, ppid: 300, start: 'watchdog ps' },
];
assert.deepEqual(ownedTree(table, [table[0]], new Set([300])).map(p => p.pid), [100, 101, 102, 103]);
assert.deepEqual(ownedTree(table, [{ pid: 100, start: 'reused PID' }]), []);
assert.deepEqual(ownedTree(table.filter(p => p.pid !== 100), [table[1]], new Set([300])).map(p => p.pid), [101, 102, 103]);

for (const orphan of [false, true, 'tagless']) {
const token = randomUUID();
const leafArgs = ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"];
if (orphan !== 'tagless') leafArgs.push('--', `--tpt-gpu-lease=${token}`);
const dir = mkdtempSync(join(tmpdir(), 'gpu-deadline-cpu-'));
const slot = join(dir, 'fake-slot');
const fixture = spawn(process.execPath, ['-e', `
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,${JSON.stringify(leafArgs)},{argv0:'chromium-cpu-fixture',stdio:'ignore',env:{...process.env,TPT_GPU_LEASE_TOKEN:'${token}'}});
  process.on('SIGTERM',()=>{});
  console.log(child.pid);
  setInterval(()=>{},1000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });
const fixtureExit = once(fixture, 'exit');
let guard, child, childIdentity;
try {
  child = Number((await once(fixture.stdout, 'data'))[0].toString().trim());
  const owner = processTable().find(p => p.pid === fixture.pid);
  childIdentity = processTable().find(p => p.pid === child);
  assert(owner && Number.isSafeInteger(child));
  writeFileSync(slot, String(owner.pid));
  if (orphan) { fixture.kill('SIGKILL'); await fixtureExit; }
  const start = Date.now(), deadline = start + 1500;
  guard = spawn(process.execPath, [fileURLToPath(new URL('./gpu-deadline.mjs', import.meta.url)),
    String(owner.pid), owner.start, String(deadline), slot, String(statSync(slot).ino), token, String(start)],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let guardLog = '';
  guard.stderr.on('data', data => { guardLog += data.toString(); });
  const guardExit = once(guard, 'exit');
  await once(guard.stdout, 'data');
  assert.equal(readFileSync(slot, 'utf8').trim(), String(guard.pid), 'live watchdog retains the slot after owner death');
  guard.stdin.write('capture\n');
  const [, signal] = await fixtureExit;
  await guardExit;
  assert.match(guardLog, /total GPU slot occupancy \d+ ms/, 'forced runs must report actual total occupancy');
  assert.equal(signal, 'SIGKILL', 'independent guard stops a run that ignores graceful shutdown');
  assert(Date.now() - start < 1500, 'cleanup must finish inside the complete slot budget');
  assert.equal(existsSync(slot), false);
  let state = '';
  try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(child)], { encoding: 'utf8' }).trim(); } catch {}
  assert(!state || state.startsWith('Z'), 'owned descendant must also stop');
  assert(processTable().some(p => p.pid === process.pid), 'the unrelated test runner survives');
  console.log(`GPU deadline CPU: ${orphan === 'tagless' ? 'orphan with no tagged root' : orphan ? 'orphan before first capture' : 'unresponsive owner'} stopped inside budget; no GPU/browser.`);
} finally {
  fixture.kill('SIGKILL'); guard?.kill('SIGKILL');
  if (childIdentity && processTable().some(p => p.pid === childIdentity.pid && p.start === childIdentity.start))
    process.kill(childIdentity.pid, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
}
