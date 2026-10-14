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
import vm from 'node:vm';
import { MAX_SLOT_MS, budgetMs, ownedTree, processTable, inspectionFailure } from './gpu-deadline.mjs';

assert.equal(MAX_SLOT_MS, 25000);
for (const n of [5000, 10000, 25000]) assert.equal(budgetMs(n), n);
for (const n of [0, -1, NaN, Infinity, 1000, 25001, 180000]) assert.throws(() => budgetMs(n), RangeError);
const table = [
  { pid: 100, ppid: 1, start: 'ours' }, { pid: 101, ppid: 100, start: 'driver' },
  { pid: 102, ppid: 101, start: 'browser' }, { pid: 103, ppid: 102, start: 'gpu' },
  { pid: 200, ppid: 1, start: 'other test' }, { pid: 201, ppid: 200, start: 'other gpu' },
  { pid: 300, ppid: 100, start: 'watchdog' }, { pid: 301, ppid: 300, start: 'watchdog ps' },
];
assert.deepEqual(ownedTree(table, [table[0]], new Set([300])).map(p => p.pid), [100, 101, 102, 103]);
assert.deepEqual(ownedTree(table, [{ pid: 100, start: 'reused PID' }]), []);
assert.deepEqual(ownedTree(table.filter(p => p.pid !== 100), [table[1]], new Set([300])).map(p => p.pid), [101, 102, 103]);
assert.deepEqual(inspectionFailure({ stage: 'orphan-environment', code: 'ETIMEDOUT', signal: 'SIGTERM',
  status: null, stdout: 'SECRET', stderr: 'SECRET', message: 'SECRET' }),
{ stage: 'orphan-environment', code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });

for (const orphan of [false, true, 'tagless', 'ps-failure', 'closed-pipe', 'ps-failure-closed-pipe']) {
const faultyPs = String(orphan).includes('ps-failure');
const closedPipe = String(orphan).includes('closed-pipe');
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
  if (orphan === true || orphan === 'tagless') { fixture.kill('SIGKILL'); await fixtureExit; }
  if (faultyPs) {
    writeFileSync(join(dir, 'ps'), '#!/bin/sh\nif [ ! -e "$TPT_CPU_PS_FLAG" ]; then\n touch "$TPT_CPU_PS_FLAG"\n echo "PRIVATE_FAULT_DETAIL" >&2\n exit 7\nfi\nexec /bin/ps "$@"\n', { mode: 0o755 });
  }
  const start = Date.now(), deadline = start + 1500;
  guard = spawn(process.execPath, [fileURLToPath(new URL('./gpu-deadline.mjs', import.meta.url)),
    String(owner.pid), owner.start, String(deadline), slot, String(statSync(slot).ino), token, String(start)],
  { stdio: ['pipe', 'pipe', 'pipe'],
    env: faultyPs ? { ...process.env, PATH: `${dir}:${process.env.PATH}`, TPT_CPU_PS_FLAG: join(dir, 'failed-once') } : process.env });
  let guardLog = '';
  guard.stderr.on('data', data => { guardLog += data.toString(); });
  const guardExit = once(guard, 'exit');
  await once(guard.stdout, 'data');
  assert.equal(readFileSync(slot, 'utf8').trim(), String(guard.pid), 'live watchdog retains the slot after owner death');
  guard.stdin.write('capture\n');
  if (closedPipe) { guard.stdout.destroy(); guard.stderr.destroy(); }
  const [, signal] = await fixtureExit;
  await guardExit;
  const reportText = readFileSync(join(dir, 'runs', `${owner.pid}-${guard.pid}.json`), 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.status, 'released');
  assert.equal(Date.parse(report.startedAt), start);
  assert(report.occupancyMs < 1500 && report.finishedAt);
  if (!closedPipe) assert.match(guardLog, /total GPU slot occupancy \d+ ms/);
  if (faultyPs) {
    assert.equal(report.failures[0].stage, 'process-table');
    assert.equal(report.failures[0].status, 7);
    assert(!`${reportText}${guardLog}`.includes('PRIVATE_FAULT_DETAIL'), 'inspection diagnostics must not leak raw stderr');
  }
  assert.equal(signal, 'SIGKILL', 'independent guard stops a run that ignores graceful shutdown');
  assert(Date.now() - start < 1500, 'cleanup must finish inside the complete slot budget');
  assert.equal(existsSync(slot), false);
  let state = '';
  try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(child)], { encoding: 'utf8' }).trim(); } catch {}
  assert(!state || state.startsWith('Z'), 'owned descendant must also stop');
  assert(processTable().some(p => p.pid === process.pid), 'the unrelated test runner survives');
  console.log(`GPU deadline CPU: ${orphan === true ? 'orphan before capture' : orphan || 'unresponsive owner'} stopped and reported inside budget; no GPU/browser.`);
} finally {
  fixture.kill('SIGKILL'); guard?.kill('SIGKILL');
  if (childIdentity && processTable().some(p => p.pid === childIdentity.pid && p.start === childIdentity.start))
    process.kill(childIdentity.pid, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
}

// Exercise the real private launcher functions with CPU-only dependencies.
// Never import Playwright or invoke launchBrowser in these regressions.
const launcher = readFileSync(new URL('./browser.mjs', import.meta.url), 'utf8');
const takeSource = launcher.slice(launcher.indexOf('async function takeSlot()'), launcher.indexOf('function releaseSlot()'));
let clock = 2000;
const take = vm.runInNewContext(`(${takeSource})`, {
  slotHeld: false, BUDGET_DIR: '/fake', SLOT_FILE: '/fake/slot', SLOT_WAIT_MS: 0, MAX_SLOT_MS,
  Date: { now: () => ++clock }, process: { pid: 42 },
  fs: { mkdirSync() {}, writeFileSync() { throw Object.assign(new Error(), { code: 'EEXIST' }); },
    statSync: () => ({ ino: 7, mtimeMs: 1900 }), rmSync() { assert.fail('must not reclaim a fresh dead-owner lease'); } },
  readJSON: () => 99, alive: () => false,
  gpuBusyPct() { assert.fail('must not proceed without acquiring the slot'); },
});
await assert.rejects(take(), /slot still held/);

const stopSource = launcher.slice(launcher.indexOf('async function stop('), launcher.indexOf('const handlers ='));
let acknowledge;
const guardFinished = new Promise(resolve => { acknowledge = resolve; });
const exits = [];
const stop = vm.runInNewContext(`(${stopSource})`, {
  stopping: false, guardFinished, slotDeadline: Date.now() + MAX_SLOT_MS, Date, Promise,
  browsers: new Set(), process: { exit: code => exits.push(code) },
  setTimeout: () => 1, clearTimeout() {},
});
const stopped = stop(1);
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(exits, [], 'parent must wait for guard timing/release, not exit after browser.close');
acknowledge(); await stopped;
assert.deepEqual(exits, [1]);
console.log('GPU deadline CPU: fresh-lock exclusion and parent release acknowledgment passed.');
