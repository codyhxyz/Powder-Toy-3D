// CPU-only watchdog for a test's OWN process tree. It remains responsive if
// the test blocks Node's event loop. Never signals an unrelated PID.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_SLOT_MS = 25000;
// Each capture can spend 1000 ms on the table plus 250 ms on orphan
// environments. Reserve a delayed observer, the hard kill's fresh capture,
// and exit verification (3 * 1250 ms + the 100 ms poll), without moving the
// absolute slot deadline. More inspection allowance means earlier cleanup.
export const CLEANUP_MS = 4000;
export function budgetMs(value) {
  if (!Number.isFinite(value) || value <= CLEANUP_MS || value > MAX_SLOT_MS)
    throw new RangeError(`GPU slot budget must be > ${CLEANUP_MS} and <= ${MAX_SLOT_MS} ms, including startup and cleanup`);
  return value;
}
export function processTable() {
  let text;
  try {
    text = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,stat=,args='],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { throw inspectionError('process-table', error); }
  return text.trim().split('\n').map(line => {
    const [pid, ppid, ...rest] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), start: rest.slice(0, 5).join(' '), state: rest[5], args: rest.slice(6).join(' ') };
  }).filter(p => Number.isSafeInteger(p.pid) && p.pid > 0 && !p.state?.startsWith('Z'));
}
export function ownedTree(table, seeds, exclude = new Set()) {
  const owned = new Set(seeds.filter(s => table.some(p => p.pid === s.pid && p.start === s.start)).map(s => s.pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const p of table) if (!exclude.has(p.pid) && owned.has(p.ppid) && !owned.has(p.pid)) {
      owned.add(p.pid); changed = true;
    }
  }
  return table.filter(p => owned.has(p.pid) && !exclude.has(p.pid));
}
function leaseRoots(table, token) {
  if (!token) return [];
  const roots = table.filter(p => p.args.split(/\s+/).includes(`--tpt-gpu-lease=${token}`));
  if (roots.length) return roots;
  // Chrome's children inherit the environment, but not unknown switches.
  // This recovers a GPU child even if both parent and tagged browser died
  // before our first sample. Never print process environments.
  const candidates = table.filter(p => /chrom(?:e|ium)/i.test(p.args));
  if (!candidates.length) return [];
  let text;
  try {
    text = execFileSync('ps', ['eww', '-p', candidates.map(p => p.pid).join(','), '-o', 'pid=,args='],
      { encoding: 'utf8', timeout: 250, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return [];
    throw inspectionError('orphan-environment', error);
  }
  const owned = new Set(text.split('\n').filter(line => line.split(/\s+/).includes(`TPT_GPU_LEASE_TOKEN=${token}`))
    .map(line => Number(line.trim().split(/\s+/, 1)[0])));
  return candidates.filter(p => owned.has(p.pid));
}
export function inspectionFailure(error) {
  // execFileSync errors can contain complete process environments. Do not
  // serialize message/stdout/stderr, even into a local diagnostic file.
  return {
    stage: error?.stage ?? 'process-inspection',
    code: error?.code ?? null,
    signal: error?.signal ?? null,
    status: typeof error?.status === 'number' ? error.status : null,
  };
}
function inspectionError(stage, error) {
  const details = { ...inspectionFailure(error), stage };
  return Object.assign(new Error(`GPU ${stage} inspection failed (${details.code ?? details.status ?? 'unknown'})`), details);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Parent exit closes these pipes. Cleanup and its durable report must
  // continue rather than crashing on EPIPE.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const [pidText, start, deadlineText, slot, inode, token, startedText] = process.argv.slice(2);
  const owner = { pid: Number(pidText), start }, deadline = Number(deadlineText);
  const started = Number(startedText ?? Date.now());
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !Number.isFinite(deadline)) process.exit(2);
  // Keep the numeric lock compatible with older launchers. The watchdog,
  // not the possibly-dead test, owns it until orphan cleanup is confirmed.
  const fd = fs.openSync(slot, 'r+');
  try {
    const old = fs.readFileSync(fd, 'utf8');
    if (String(fs.fstatSync(fd).ino) !== inode || old.trim() !== pidText) process.exit(2);
    fs.writeSync(fd, String(process.pid).padEnd(old.length, ' '), 0, 'utf8');
    if (String(fs.statSync(slot).ino) !== inode) process.exit(2);
  } finally { fs.closeSync(fd); }
  const reportPath = path.join(path.dirname(slot), 'runs', `${owner.pid}-${process.pid}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ownerPid: owner.pid, guardPid: process.pid, startedAt: new Date(started).toISOString(),
    deadlineAt: new Date(deadline).toISOString(), status: 'running', failures: [],
  };
  const saveReport = () => {
    fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
    fs.renameSync(`${reportPath}.tmp`, reportPath);
  };
  saveReport(); // Before readiness: no browser starts without a report.
  console.error(`[browser] GPU slot report ${reportPath}; start ${report.startedAt}; deadline ${report.deadlineAt}`);
  const persist = () => {
    try { saveReport(); } catch (error) {
      console.error(`[browser] Cannot update GPU slot report: ${error.code ?? 'unknown'}`);
    }
  };
  const exclude = new Set([process.pid]);
  let captured = [owner], browserTree = [], releasing = false, forced = false, warned = false;
  const capture = () => {
    const table = processTable();
    // The unique launch argument survives reparenting if the owner dies
    // during chromium.launch, before it can report the browser's PID.
    const roots = leaseRoots(table, token);
    browserTree = ownedTree(table, [...browserTree, ...roots], exclude);
    captured = ownedTree(table, [...captured, ...browserTree], exclude);
  };
  const unlinkOwnedSlot = () => {
    try {
      if (String(fs.statSync(slot).ino) === inode && fs.readFileSync(slot, 'utf8').trim() === String(process.pid))
        fs.unlinkSync(slot);
    } catch {}
  };
  const signal = (p, sig) => { try { process.kill(p.pid, sig); } catch {} };
  const failedOwnership = error => {
    if (!warned) {
      const failure = { ...inspectionFailure(error), at: new Date().toISOString(), elapsedMs: Date.now() - started };
      report.failures.push(failure);
      report.status = 'inspection-failed';
      persist();
      console.error(`[browser] Cannot verify process ownership ${JSON.stringify(failure)}; stopping without releasing an unverified slot`);
    }
    warned = true;
    process.stdout.write('stop\n'); // asks the owner to close its Browser handles, not an unverified PID
  };
  const graceful = setTimeout(() => {
    try { capture(); } catch (error) { failedOwnership(error); return; }
    if (captured.some(p => p.pid === owner.pid)) {
      console.error(`[browser] GPU slot deadline: closing test pid ${owner.pid}; total budget includes compilation`);
      signal(owner, 'SIGTERM');
    }
  }, Math.max(0, deadline - 2 * CLEANUP_MS - Date.now()));
  const force = () => {
    try {
      capture();
      const remaining = captured;
      // Children first, including only this test's browser/driver processes.
      for (const p of remaining.filter(p => p.pid !== owner.pid).reverse()) signal(p, 'SIGKILL');
      for (const p of remaining.filter(p => p.pid === owner.pid)) signal(p, 'SIGKILL');
    } catch (error) { failedOwnership(error); }
  };
  // Reserve the last cleanup interval to confirm exit and release the slot.
  const hard = setTimeout(() => {
    forced = releasing = true;
    force();
  }, Math.max(0, deadline - CLEANUP_MS - Date.now()));
  const observe = setInterval(() => {
    try {
      capture();
      if (releasing && (forced ? captured.length === 0 : browserTree.length === 0)) {
        unlinkOwnedSlot();
        report.status = 'released';
        const ended = Date.now();
        report.finishedAt = new Date(ended).toISOString();
        report.occupancyMs = ended - started;
        report.forced = forced;
        persist();
        console.error(`[browser] total GPU slot occupancy ${report.occupancyMs} ms${forced ? ' (forced cleanup)' : ''}; end ${report.finishedAt}; report ${reportPath}`);
        process.stdout.write('released\n');
        clearTimeout(graceful); clearTimeout(hard); clearInterval(observe);
        process.exit(forced ? 1 : 0);
      }
      if (forced) force();
    } catch (error) { failedOwnership(error); } // Keep the lock/deadline until exit is verified.
  }, 100);
  let input = '';
  process.stdin.on('data', data => {
    input += data.toString();
    for (let end; (end = input.indexOf('\n')) >= 0;) {
      const message = input.slice(0, end); input = input.slice(end + 1);
      if (message === 'capture') { try { capture(); } catch (error) { failedOwnership(error); } }
      if (message === 'released') {
        releasing = true;
      }
    }
  });
  process.stdout.write('ready\n');
}
