// CPU-only: mock ownership graphs and disposable Node processes/private leases.
// No browser, GPU, machine-wide slot, or other session's process is touched.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs, { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { MAX_SLOT_MS, CLEANUP_MS, budgetMs, ownedTree, processTable, inspectionFailure } from './gpu-deadline.mjs';

assert.equal(MAX_SLOT_MS, 25000);
assert.equal(CLEANUP_MS, 4000);
assert(CLEANUP_MS >= 3 * (1000 + 250) + 100, 'reserve delayed observation, fresh kill verification, and exit verification');
for (const n of [5000, 6000, 10000, 25000]) assert.equal(budgetMs(n), n);
for (const n of [0, -1, NaN, Infinity, 1000, 1500, 2000, 4000, 25001, 180000]) assert.throws(() => budgetMs(n), RangeError);
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms, label) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`CPU fixture timed out: ${label}`);
    await sleep(20);
  }
}
function track(child) {
  const state = { exited: false, code: null, signal: null, error: false, output: '', log: '' };
  child.on('error', () => { state.error = true; });
  child.on('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }); });
  child.stdout?.on('data', data => { state.output += data.toString(); });
  child.stderr?.on('data', data => { state.log += data.toString(); });
  child.stdin?.on('error', () => {});
  return state;
}
function identity(child) {
  const p = processTable().find(p => p.pid === child.pid && p.ppid === process.pid);
  assert(p, 'new disposable child must have verified parent/start identity');
  return p;
}
const live = p => processTable().some(q => q.pid === p.pid && q.start === p.start);
function killVerified(p) {
  if (p && live(p)) process.kill(p.pid, 'SIGKILL');
}
async function cleanup(handles, seeds, token) {
  // Capture descendants BEFORE killing an owner, including startup failures
  // before the fixture has printed its child's PID. Never signal by PID alone.
  const current = processTable();
  const tagged = current.filter(p => {
    const args = p.args.split(/\s+/);
    return args.includes(`--tpt-gpu-lease=${token}`) || (args.includes(guardFile) && args.includes(token));
  });
  const roots = [...seeds, ...tagged, ...handles.filter(h => h && h.exitCode === null && h.signalCode === null)
    .map(h => current.find(p => p.pid === h.pid && p.ppid === process.pid)).filter(Boolean)];
  const owned = ownedTree(current, roots);
  for (const p of owned.reverse()) killVerified(p);
  await waitFor(() => !owned.some(p => live(p)), 2000, 'own disposable cleanup');
}
function checkReport(report, scenario, budget, start, deadline) {
  const diagnostic = JSON.stringify({ scenario, budget, status: report.status, occupancyMs: report.occupancyMs,
    finishedAt: report.finishedAt, failures: report.failures?.map(inspectionFailure) });
  assert.equal(report.status, 'released', diagnostic);
  assert.equal(Date.parse(report.startedAt), start);
  assert.equal(Date.parse(report.deadlineAt), deadline, 'absolute deadline must not move');
  assert(report.occupancyMs < budget && report.finishedAt, diagnostic);
}
const guardFile = fileURLToPath(new URL('./gpu-deadline.mjs', import.meta.url));

// Exercise private launcher functions with CPU stubs, never importing Playwright.
const launcher = readFileSync(new URL('./browser.mjs', import.meta.url), 'utf8');
const takeSource = launcher.slice(launcher.indexOf('async function takeSlot()'), launcher.indexOf('function releaseSlot()'));
for (const age of [100, MAX_SLOT_MS + 10000]) for (const text of ['99', '42', '0', '-1', '1.5', 'not-json', 'null', 'true', '{}', '[42]', '"42"']) {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-lease-refusal-cpu-')), slot = join(dir, 'fake-slot'), report = join(dir, 'fake-report');
  try {
    writeFileSync(slot, text); writeFileSync(report, 'incomplete report sentinel');
    fs.utimesSync(slot, new Date(Date.now() - age), new Date(Date.now() - age));
    const before = statSync(slot);
    const take = vm.runInNewContext(`(${takeSource})`, {
      slotHeld: false, BUDGET_DIR: dir, SLOT_FILE: slot, SLOT_WAIT_MS: 0, MAX_SLOT_MS,
      Date, process: { pid: 42 }, fs,
      readJSON(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } },
      alive: pid => pid === 42,
      gpuBusyPct() { assert.fail('must not proceed without acquiring the slot'); },
    });
    await assert.rejects(take(), /dead or unverified.*preserving/);
    assert.equal(readFileSync(slot, 'utf8'), text);
    assert.equal(statSync(slot).ino, before.ino); assert.equal(statSync(slot).mtimeMs, before.mtimeMs);
    assert.equal(readFileSync(report, 'utf8'), 'incomplete report sentinel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const releaseSource = launcher.slice(launcher.indexOf('function releaseSlot()'), launcher.indexOf('// A failed close'));
const guardSource = launcher.slice(launcher.indexOf('async function guardSlot('), launcher.indexOf('/** True when'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./browser.mjs', import.meta.url).href));
function privateGuard() {
  const guard = new EventEmitter();
  Object.assign(guard, { pid: 99, stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
  let removed = 0, stopped = 0;
  const context = vm.createContext({
    slotHeld: true, slotStarted: Date.now(), slotDeadline: 0, slotInode: 7, slotToken: 'private-nonce',
    slotGuardPid: 0, slotGuarded: false, watchdog: null, guardFinished: Promise.resolve(),
    SLOT_FILE: '/fake/slot', process: { pid: 42, execPath: process.execPath },
    processTable: () => [{ pid: 42, start: 'verified-owner' }], fileURLToPath, URL,
    spawn(_exe, args, options) {
      assert.equal(options.detached, true, 'execute actual private spawn, not an option regex');
      assert.deepEqual(Array.from(options.stdio), ['pipe', 'pipe', 'inherit']);
      assert.equal(args[1], '42'); assert.equal(args[2], 'verified-owner');
      assert.equal(args[6], 'private-nonce');
      return guard;
    },
    readJSON: () => 99, fs: { statSync: () => ({ ino: 7 }), rmSync() { removed++; } },
    stop() { stopped++; }, Date, Promise, setTimeout, clearTimeout, console: { error() {} },
  });
  vm.runInContext(`${releaseSource}\n${guardSource}`, context);
  return { guard, context, removed: () => removed, stopped: () => stopped };
}
{
  const test = privateGuard();
  test.context.readJSON = () => 42;
  test.context.releaseSlot();
  assert.equal(test.removed(), 1, 'pre-guard/no-browser cancellation can release its verified own lease');
  assert.equal(test.context.slotHeld, false);
}
for (const outcome of ['released', 'exit', 'readiness-failure', 'readiness-exit', 'stdout-close']) {
  const test = privateGuard();
  const ready = test.context.guardSlot(budgetMs(6000));
  if (outcome.startsWith('readiness-')) {
    // Unexpected output must not count as ready; the real 500 ms wait is bounded.
    if (outcome === 'readiness-exit') test.guard.emit('exit', 1, null);
    else test.guard.stdout.write('stop\n');
    await assert.rejects(ready, /did not start|exited before readiness/);
  } else {
    test.guard.stdout.write('ready\n');
    await ready;
    if (outcome === 'released') test.guard.stdout.write('released\n');
    if (outcome === 'exit') test.guard.emit('exit', 1, null);
    if (outcome === 'stdout-close') test.guard.stdout.emit('close');
  }
  test.context.releaseSlot(); // same path used by launch failure, disconnect and process exit
  assert.equal(test.removed(), 0, 'guard acknowledgment resets local ownership; the guard alone unlinks its lease');
  assert.equal(test.context.slotHeld, outcome !== 'released');
  assert.equal(test.context.slotGuarded, outcome !== 'released');
  if (outcome === 'exit') assert.equal(test.stopped(), 1);
}
const stopSource = launcher.slice(launcher.indexOf('async function stop('), launcher.indexOf('const handlers ='));
for (const closeFails of [false, true]) {
  let acknowledge, closeCalls = 0;
  const guardFinished = new Promise(resolve => { acknowledge = resolve; });
  const exits = [];
  const stop = vm.runInNewContext(`(${stopSource})`, {
    stopping: false, guardFinished, slotDeadline: Date.now() + MAX_SLOT_MS, Date, Promise,
    browsers: closeFails ? new Set([{ close() { closeCalls++; return Promise.reject(new Error('fixture close failure')); } }]) : new Set(),
    process: { exit: code => exits.push(code) }, setTimeout: () => 1, clearTimeout() {},
  });
  const stopped = stop(1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closeCalls, closeFails ? 1 : 0);
  assert.deepEqual(exits, [], 'parent must await guard even after rejected browser.close (fallback timer stubbed)');
  acknowledge(); await stopped;
  assert.deepEqual(exits, [1]);
}
console.log('GPU deadline CPU: fresh/old dead and malformed leases preserved; private detached spawn, guarded release/failure/close, parent acknowledgment passed.');

// Deliberately fail before any child PID output; finally must still recover
// only this disposable tree using the verified owner/start identity.
{
  const token = randomUUID();
  const fixture = spawn(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',${JSON.stringify(`--tpt-gpu-lease=${token}`)}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = track(fixture), seeds = [];
  let descendants = [];
  try {
    const owner = identity(fixture); seeds.push(owner);
    await waitFor(() => {
      descendants = ownedTree(processTable(), [owner]).filter(p => p.pid !== owner.pid);
      return descendants.length > 0;
    }, 2000, 'pre-PID descendant startup');
    await assert.rejects(waitFor(() => state.output.includes('\n'), 100, 'deliberately missing PID'), /deliberately missing PID/);
  } finally { await cleanup([fixture], seeds, token); }
  assert(descendants.every(p => !live(p)), 'pre-PID failure cleanup must stop its exact descendants');
  console.log('GPU deadline CPU: bounded pre-PID failure cleaned only its disposable tree.');
}

for (const scenario of ['normal', 'orphan', 'tagless', 'ps-failure', 'closed-pipe', 'ps-failure-closed-pipe', 'slow-ps', 'ps-timeout']) {
  const faultyPs = scenario.includes('ps-failure'), slowPs = scenario === 'slow-ps', timeoutPs = scenario === 'ps-timeout';
  const customPs = faultyPs || slowPs || timeoutPs, closedPipe = scenario.includes('closed-pipe');
  const token = randomUUID(), dir = mkdtempSync(join(tmpdir(), 'gpu-deadline-cpu-')), slot = join(dir, 'fake-slot');
  const leafArgs = ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"];
  if (scenario !== 'tagless') leafArgs.push('--', `--tpt-gpu-lease=${token}`);
  const fixture = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    process.stdin.once('data',()=>{
      const child=spawn(process.execPath,${JSON.stringify(leafArgs)},{argv0:'chromium-cpu-fixture',stdio:'ignore',env:{...process.env,TPT_GPU_LEASE_TOKEN:'${token}'}});
      console.log(child.pid);
    });
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const fixtureState = track(fixture), seeds = [];
  let guard, guardState, childIdentity;
  try {
    const owner = identity(fixture); seeds.push(owner);
    fixture.stdin.write('start\n');
    await waitFor(() => fixtureState.output.includes('\n') || fixtureState.exited || fixtureState.error, 2000, `${scenario} fixture PID`);
    const child = Number(fixtureState.output.trim());
    childIdentity = processTable().find(p => p.pid === child && p.ppid === owner.pid);
    assert(childIdentity, 'verify disposable descendant before orphaning'); seeds.push(childIdentity);
    writeFileSync(slot, String(owner.pid));
    if (scenario === 'orphan' || scenario === 'tagless') {
      killVerified(owner);
      await waitFor(() => fixtureState.exited, 2000, `${scenario} orphan owner exit`);
    }
    if (faultyPs) writeFileSync(join(dir, 'ps'), '#!/bin/sh\nif [ ! -e "$TPT_CPU_PS_FLAG" ]; then\n touch "$TPT_CPU_PS_FLAG"\n echo "PRIVATE_FAULT_DETAIL" >&2\n exit 7\nfi\nexec /bin/ps "$@"\n', { mode: 0o755 });
    if (slowPs) writeFileSync(join(dir, 'ps'), '#!/bin/sh\nif [ "$1" = "-axo" ]; then /bin/sleep 0.55; fi\nexec /bin/ps "$@"\n', { mode: 0o755 });
    if (timeoutPs) {
      // exec, not a sleeping child: timeout cannot abandon a helper subprocess.
      writeFileSync(join(dir, 'ps'), `#!/bin/sh\nif [ "$1" = "-axo" ]; then exec "${process.execPath}" "${join(dir, 'slow-table.cjs')}" "$@"; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'slow-table.cjs'), `
        const fs=require('node:fs');
        if(fs.existsSync(process.env.TPT_CPU_PS_FLAG)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
        process.stdout.write(require('node:child_process').execFileSync('/bin/ps',process.argv.slice(2)));
      `);
      writeFileSync(join(dir, 'failed-once'), '');
    }
    const budget = budgetMs(6000), start = Date.now(), deadline = start + budget;
    guard = spawn(process.execPath, [guardFile, String(owner.pid), owner.start, String(deadline), slot,
      String(statSync(slot).ino), token, String(start)], { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: customPs ? { ...process.env, PATH: `${dir}:${process.env.PATH}`, TPT_CPU_PS_FLAG: join(dir, 'failed-once') } : process.env });
    guardState = track(guard); seeds.push(identity(guard));
    await waitFor(() => guardState.output.includes('ready\n') || guardState.exited || guardState.error, 2000, `${scenario} guard ready`);
    assert(guardState.output.includes('ready\n'), `${scenario}: guard must become ready`);
    assert.equal(readFileSync(slot, 'utf8').trim(), String(guard.pid));
    guard.stdin.write('capture\n');
    if (closedPipe) { guard.stdout.destroy(); guard.stderr.destroy(); }
    if (timeoutPs) {
      await waitFor(() => guardState.output.includes('stop\n') || guardState.exited, 4500, 'timeout ownership failure');
      assert(guardState.output.includes('stop\n'));
      assert.equal(readFileSync(slot, 'utf8').trim(), String(guard.pid));
      assert(live(owner), 'failed verification must not signal owner');
      assert(live(childIdentity), 'failed verification must not signal descendant');
      const failed = JSON.parse(readFileSync(join(dir, 'runs', `${owner.pid}-${guard.pid}.json`), 'utf8'));
      assert.equal(failed.status, 'inspection-failed'); assert.equal(failed.failures[0].code, 'ETIMEDOUT');
      rmSync(join(dir, 'failed-once')); // Permit fresh verification, not a deadline extension.
    }
    await waitFor(() => fixtureState.exited && guardState.exited, Math.max(1, deadline + 1500 - Date.now()), `${scenario} fixture/guard exit`);
    const reportText = readFileSync(join(dir, 'runs', `${owner.pid}-${guard.pid}.json`), 'utf8'), report = JSON.parse(reportText);
    checkReport(report, scenario, budget, start, deadline);
    if (slowPs) {
      assert.deepEqual(report.failures, [], 'valid inspections slower than 500 ms must not fail');
      assert(!guardState.output.includes('stop\n'));
    }
    if (timeoutPs) { assert.equal(report.failures[0].stage, 'process-table'); assert.equal(report.failures[0].code, 'ETIMEDOUT'); }
    if (!closedPipe) assert.match(guardState.log, /total GPU slot occupancy \d+ ms/);
    if (faultyPs) {
      assert.equal(report.failures[0].stage, 'process-table'); assert.equal(report.failures[0].status, 7);
      assert(!`${reportText}${guardState.log}`.includes('PRIVATE_FAULT_DETAIL'), 'no raw inspection stderr');
    }
    assert.equal(fixtureState.signal, 'SIGKILL'); assert.equal(guardState.code, 1); assert.equal(guardState.signal, null);
    assert(Date.now() - start < budget, `${scenario}: complete cleanup must fit legal budget`);
    assert.equal(existsSync(slot), false); assert(!live(childIdentity), 'exact owned descendant must stop');
    assert(processTable().some(p => p.pid === process.pid), 'unrelated runner survives');
    console.log(`GPU deadline CPU: ${scenario} released; occupancy ${report.occupancyMs}/${budget} ms; no GPU/browser.`);
  } finally {
    await cleanup([fixture, guard], seeds, token);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Terminate ONLY a verified disposable owner group. Its detached guard must
// survive and find a separately parented, nonce-tagged fake browser orphan.
{
  const dir = mkdtempSync(join(tmpdir(), 'gpu-deadline-group-cpu-')), slot = join(dir, 'fake-slot'), token = randomUUID();
  const budget = budgetMs(6000), seeds = [];
  let owner, guardIdentity, browser, bystander;
  try {
    browser = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', `--tpt-gpu-lease=${token}`], { stdio: 'ignore' });
    bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    track(browser); track(bystander);
    const browserIdentity = identity(browser), bystanderIdentity = identity(bystander); seeds.push(browserIdentity, bystanderIdentity);
    owner = spawn(process.execPath, ['-e', `
      const fs=require('node:fs'),{spawn,execFileSync}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const slot=${JSON.stringify(slot)}, start=Date.now(), deadline=start+${budget};
      fs.writeFileSync(slot,String(process.pid));
      const row=execFileSync('ps',['-o','lstart=','-p',String(process.pid)],{encoding:'utf8',timeout:1000}).trim().replace(/\\s+/g,' ');
      const guard=spawn(process.execPath,${JSON.stringify([guardFile])}.concat([String(process.pid),row,String(deadline),slot,String(fs.statSync(slot).ino),${JSON.stringify(token)},String(start)]),{detached:true,stdio:['pipe','pipe','ignore']});
      console.log(JSON.stringify({guard:guard.pid,start,deadline}));
      guard.stdout.pipe(process.stdout);guard.stdin.on('error',()=>{});setInterval(()=>{},1000);
    `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ownerState = track(owner), ownerIdentity = identity(owner); seeds.push(ownerIdentity);
    await waitFor(() => ownerState.output.includes('ready\n') || ownerState.exited, 2000, 'group guard ready');
    assert(ownerState.output.includes('ready\n'));
    const info = JSON.parse(ownerState.output.split('\n')[0]);
    guardIdentity = processTable().find(p => p.pid === info.guard && p.ppid === owner.pid);
    assert(guardIdentity); seeds.push(guardIdentity);
    const pgid = pid => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim());
    assert.equal(pgid(owner.pid), owner.pid); assert.equal(pgid(info.guard), info.guard);
    assert.notEqual(pgid(browser.pid), owner.pid); assert.notEqual(pgid(process.pid), owner.pid);
    assert(live(ownerIdentity)); // Fresh identity + unique PGID immediately before own group signal.
    process.kill(-owner.pid, 'SIGKILL');
    await waitFor(() => ownerState.exited, 1000, 'own group exit');
    assert.equal(ownerState.signal, 'SIGKILL'); assert(live(guardIdentity), 'independent guard survives owner group termination');
    const reportPath = join(dir, 'runs', `${owner.pid}-${info.guard}.json`);
    await waitFor(() => {
      if (!existsSync(reportPath)) return false;
      return JSON.parse(readFileSync(reportPath, 'utf8')).status === 'released' && !live(guardIdentity);
    }, Math.max(1, info.deadline + 1500 - Date.now()), 'group durable release/guard exit');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    checkReport(report, 'owner-group', budget, info.start, info.deadline);
    assert(report.forced); assert.equal(existsSync(slot), false);
    assert(!live(browserIdentity), 'exact separately owned tagged browser stopped');
    assert(live(bystanderIdentity), 'untagged sibling survives guard cleanup');
    assert(Date.now() < info.deadline, 'group cleanup and report fit legal absolute deadline');
    console.log(`GPU deadline CPU: owner-group termination; detached guard survived, exact orphan stopped, sibling survived; durable occupancy ${report.occupancyMs}/${budget} ms.`);
  } finally {
    await cleanup([owner, browser, bystander], seeds, token);
    rmSync(dir, { recursive: true, force: true });
  }
}
