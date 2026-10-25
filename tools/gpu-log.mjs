#!/usr/bin/env node
// One machine-wide log of who uses the GPU, why and for how long. Every
// session, subagent and worktree writes to the same file, so anyone can see
// who holds the GPU right now and who has been on it today.
//
//   node tools/gpu-log.mjs                 who holds the GPU now + recent runs
//   node tools/gpu-log.mjs --since 6h      totals per session over that window
//   node tools/gpu-log.mjs claim "why" [--exclusive] -- <command...>
//   node tools/gpu-log.mjs claim "why" [--exclusive] [--secs 120]   (then: release)
//                                          register GPU use the launcher can't
//                                          see: windowed Chrome, Claude in
//                                          Chrome, a dev page left open
//
// Timing-critical work gets the GPU to itself. An exclusive run (a profiler
// or bench script, launchBrowser({ exclusive: true }), TPT_GPU_EXCLUSIVE=1,
// claim --exclusive) waits out or refuses while any other registered GPU use
// is live, and everything else waits out or refuses while it runs. Ordinary
// headless tests and ordinary claims may overlap each other; headless tests
// never overlap one another (the slot). The user's own play is not
// registered: the launcher's busy check covers it.
//
// launchBrowser() writes a `start` line for every run and a `refused` line
// when it can't get the slot; the deadline guard's runs/<pid>-<guard>.json
// report supplies the end time, so a killed test still gets its occupancy
// (runs from launchers older than this log don't appear).
// Say why with launchBrowser({ why }) or TPT_GPU_WHY="..."; without one the
// log shows the script and its arguments.
import { execFileSync } from 'node:child_process';
import { processTable } from './gpu-deadline.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOG_DIR = path.join(os.homedir(), '.cache', 'tpt-headless');
export const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');
const SLOT_FILE = path.join(LOG_DIR, 'slot');
const RUNS_DIR = path.join(LOG_DIR, 'runs');
const CLAIMS_DIR = path.join(LOG_DIR, 'claims');
const RECENT = 15;                  // runs listed by default
const CLAIM_SECS = 120;             // a timed claim's default length
const CLAIM_WAIT_MS = 30000;        // a claim waits out one 25 s headless slot, then gives up
const POLL_MS = 1000;
const FOREVER_MS = 864e5;           // a command claim ends with its command; this is only a backstop
/** Scripts whose numbers are timings: they run exclusive without being told. */
export const TIMING_TOOLS = /^(profile|frame-profile|app-compile-probe|[\w-]*bench)\.mjs$/;
const RUN_TIMEOUT_MS = 500;
// Process names that start an agent session, nearest ancestor wins.
const AGENT_RE = /(^|\/)(claude|pi|codex|cursor-agent|aider|gemini)( |$)/;

const run = (cmd, args, cwd, timeout = RUN_TIMEOUT_MS) => {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The agent session that started this process: nearest agent ancestor in `table` (ps rows). */
function agentOf(table) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  for (let p = byPid.get(process.ppid), hops = 0; p && hops < 32; p = byPid.get(p.ppid), hops++) {
    const m = AGENT_RE.exec(p.args.split(' ').slice(0, 2).join(' '));
    if (m) return { agent: m[2], agentPid: p.pid };
  }
  return { agent: process.env.AI_AGENT?.split('_')[0] ?? 'human', agentPid: 0 };
}

/** Who this process is: worktree, branch, script, agent session. `table` is a processTable(). */
export function whoAmI(table = []) {
  const cwd = process.cwd();
  const top = run('git', ['rev-parse', '--show-toplevel'], cwd) || cwd;
  const script = process.argv[1] ? path.relative(top, process.argv[1]) : '';
  return {
    worktree: path.basename(top),
    branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], top),
    command: [script, ...process.argv.slice(2)].join(' ').slice(0, 300),
    session: process.env.CLAUDE_CODE_SESSION_ID?.slice(0, 8) ?? '',
    ...agentOf(table),
  };
}

/** Appends one entry. Never throws: logging must not break a test. */
export function logGpu(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {}
}

export function readLog(file = LOG_FILE) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** A start entry joined with its guard report: end, occupancy, status. */
function withReport(e) {
  if (e.event !== 'start') return e;
  const report = (() => { try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${e.pid}-${e.guardPid}.json`), 'utf8')); } catch { return null; } })();
  const running = report ? report.status === 'running' && alive(e.guardPid) : alive(e.pid);
  return { ...e, ms: report?.occupancyMs ?? (running ? Date.now() - Date.parse(e.at) : null),
    status: running ? 'running' : report?.status === 'running' ? 'stale' : report?.forced ? 'forced' : report?.status ?? 'ended', forced: report?.forced };
}

/** Live claims (claims/<id>.json): the claimant's process is alive and its time hasn't run out. Stale ones are removed. */
export function liveClaims() {
  let files = [];
  try { files = fs.readdirSync(CLAIMS_DIR).filter(f => f.endsWith('.json')); } catch {}
  const out = [];
  for (const f of files) {
    const file = path.join(CLAIMS_DIR, f);
    let c = null;
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (c && alive(c.pid) && Date.now() < c.until) out.push({ ...c, file });
    else try { fs.rmSync(file, { force: true }); } catch {}
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
const describeClaim = c => `${label(c)}: ${c.why}${c.exclusive ? ' (exclusive)' : ''}, for ${secs(Date.now() - Date.parse(c.at))}`;

/** The headless slot's holder: its pid and its start line, if it logged one. */
function slotHolder(log = readLog()) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(SLOT_FILE, 'utf8').trim()); } catch {}
  if (!pid) return null;
  return { pid, entry: [...log].reverse().find(x => x.event === 'start' && (x.guardPid === pid || x.pid === pid)) };
}

/**
 * What stops an `exclusive` (or ordinary) run starting now, besides the
 * headless slot itself: claims an exclusive run can't share the GPU with, or
 * an exclusive claim. `self` skips the caller's own claim. Older claims only,
 * when `olderThan` is set, so two waiting claimants can't block each other.
 * @returns {string[]} one line per blocker; empty when clear
 */
export function gpuBlockers({ exclusive = false, self = '', olderThan = Infinity } = {}) {
  return liveClaims().filter(c => c.id !== self && Date.parse(c.at) < olderThan && (exclusive || c.exclusive)).map(describeClaim);
}

/** One line about whoever holds the slot, for the launcher's "held by" message. */
export function describeHolder(holderPid, log = readLog()) {
  const e = [...log].reverse().find(x => x.event === 'start' && (x.guardPid === holderPid || x.pid === holderPid));
  if (e) return `${label(e)}: ${e.why || e.command}, for ${secs(Date.now() - Date.parse(e.at))}`;
  const cmd = run('ps', ['-o', 'args=', '-p', String(holderPid)]);
  return cmd ? `pid ${holderPid} (${cmd.slice(0, 120)}), not in the GPU log` : `pid ${holderPid}`;
}

const secs = ms => ms == null ? '?' : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : `${(ms / 60000).toFixed(1)} min`;
const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const label = e => [e.agent, e.session || (e.agentPid ? `pid ${e.agentPid}` : ''), e.worktree].filter(Boolean).join(' · ') || 'unknown';
const DURATION = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
const parseSince = s => { const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s ?? ''); return m ? Number(m[1]) * DURATION[m[2]] : null; };

function now(log) {
  let holder = null;
  try { holder = Number(fs.readFileSync(SLOT_FILE, 'utf8').trim()); } catch {}
  const slot = !holder ? 'Headless slot: free'
    : `Headless slot: ${describeHolder(holder, log)}${alive(holder) ? '' : ' (holder is dead: the next launch sets it aside if no browser of it is left)'}`;
  const claims = liveClaims().map(c => `Claim: ${describeClaim(c)}`);
  return [slot, ...claims].join('\n');
}

function row(e) {
  const what = e.why || e.command || '';
  if (e.event === 'refused') return `${when(e.at)}  refused   ${label(e)}  ${what}\n${' '.repeat(24)}${e.reason}`;
  if (e.event === 'claim') return `${when(e.at)}  ${(e.ms == null ? 'now' : 'claim').padEnd(6)}${secs(e.ms).padStart(6)}  ${label(e)}  ${what}${e.exclusive ? ' (exclusive)' : ''}`;
  if (e.event === 'recovered') return `${when(e.at)}  recovered dead lease of pid ${e.holder}`;
  if (e.event === 'release') return null;
  return `${when(e.at)}  ${(e.status === 'running' ? 'now' : ['forced', 'stale'].includes(e.status) ? e.status : '').padEnd(6)}${secs(e.ms).padStart(6)}  ${label(e)} (${e.branch})  ${what}`;
}

function totals(log, sinceMs) {
  const from = Date.now() - sinceMs, by = new Map();
  for (const e of log.filter(x => Date.parse(x.at) >= from && ['start', 'claim'].includes(x.event))) {
    const k = label(e), t = by.get(k) ?? { runs: 0, ms: 0, refused: 0 };
    t.runs++; t.ms += e.ms ?? 0; by.set(k, t);
  }
  for (const e of log.filter(x => Date.parse(x.at) >= from && x.event === 'refused')) {
    const t = by.get(label(e)) ?? { runs: 0, ms: 0, refused: 0 }; t.refused++; by.set(label(e), t);
  }
  return [...by].sort((a, b) => b[1].ms - a[1].ms)
    .map(([k, t]) => `${secs(t.ms).padStart(8)}  ${String(t.runs).padStart(3)} runs${t.refused ? `, ${t.refused} refused` : ''}  ${k}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === 'claim') process.exit(await claim(args));
  else if (args[0] === 'release') {
    let table = [];
    try { table = processTable(); } catch {}
    const { agentPid } = whoAmI(table), owner = agentPid || process.ppid;
    const mine = liveClaims().filter(c => c.pid === owner);
    for (const c of mine) { fs.rmSync(c.file, { force: true }); logGpu({ event: 'release', id: c.id, ms: Date.now() - Date.parse(c.at) }); }
    console.log(mine.length ? `released: ${mine.map(c => c.why).join('; ')}` : 'no claim of this session to release');
  } else {
    const logged = readLog();
    const released = new Map(logged.filter(e => e.event === 'release').map(e => [e.id, e.ms]));
    const log = logged.map(withReport).map(e => e.event === 'claim' ? { ...e, ms: released.get(e.id) ?? e.ms } : e);
    console.log(now(log));
    const since = parseSince(opt('--since'));
    if (since) {
      console.log(`\nGPU time per session, last ${opt('--since')}:`);
      console.log(totals(log, since).join('\n') || '  (none)');
    } else {
      console.log(`\nRecent (${LOG_FILE}):`);
      console.log(log.slice(-RECENT).map(row).filter(Boolean).join('\n') || '  (no runs logged yet)');
    }
  }
}

// Registers GPU use the launcher can't see. The claim is written first, then
// it waits for the GPU to suit it, so a launcher that checks after taking the
// slot always sees it (no window where both start).
async function claim(args) {
  const dash = args.indexOf('--'), command = dash >= 0 ? args.slice(dash + 1) : [];
  const own = dash >= 0 ? args.slice(1, dash) : args.slice(1);
  const why = own.find((a, i) => !a.startsWith('--') && own[i - 1] !== '--secs');
  const exclusive = own.includes('--exclusive');
  const s = Number(own[own.indexOf('--secs') + 1]);
  if (!why || (dash >= 0 && !command.length)) {
    console.error('usage: gpu-log.mjs claim "why" [--exclusive] [--secs N] [-- command...]');
    return 2;
  }
  let table = [];
  try { table = processTable(); } catch {}
  const who = { ...whoAmI(table), command: command.join(' ').slice(0, 300) };
  // A command claim lives as long as this process; a timed one as long as the session, or its time.
  const pid = command.length ? process.pid : who.agentPid || process.ppid;
  const at = new Date().toISOString(), id = `${process.pid}-${Date.now()}`;
  const until = Date.now() + (command.length ? FOREVER_MS : (Number.isFinite(s) && s > 0 ? s : CLAIM_SECS) * 1000);
  fs.mkdirSync(CLAIMS_DIR, { recursive: true });
  const file = path.join(CLAIMS_DIR, `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, at, pid, until, why, exclusive, ...who }));
  fs.renameSync(`${file}.tmp`, file);
  const drop = () => { try { fs.rmSync(file, { force: true }); } catch {} };
  const giveUp = Date.now() + CLAIM_WAIT_MS;
  let said = '';
  for (;;) {
    const holder = slotHolder();
    const slotBlocks = holder && alive(holder.pid) && (exclusive || holder.entry?.exclusive);
    const blockers = [...(slotBlocks ? [`headless run ${describeHolder(holder.pid)}`] : []),
      ...gpuBlockers({ exclusive, self: id, olderThan: Date.parse(at) })];
    if (!blockers.length) break;
    if (Date.now() > giveUp) {
      drop();
      console.error(`GPU busy, claim given up after ${CLAIM_WAIT_MS / 1000} s:\n  ${blockers.join('\n  ')}`);
      logGpu({ event: 'refused', why, ...who, reason: `claim: ${blockers.join('; ')}`.slice(0, 300) });
      return 3;
    }
    if (blockers.join('; ') !== said) console.error(`[gpu] waiting: ${said = blockers.join('; ')}`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  logGpu({ event: 'claim', id, why, exclusive, ...who, ms: command.length ? null : until - Date.now() });
  if (!command.length) {
    console.log(`GPU claimed${exclusive ? ' exclusively' : ''} until ${new Date(until).toLocaleTimeString()}: ${why}\n` +
      'Run `node tools/gpu-log.mjs release` when done; it also ends with this session.');
    return 0;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  const code = await new Promise(r => { child.on('exit', (c, sig) => r(c ?? (sig ? 1 : 0))); child.on('error', e => { console.error(e.message); r(127); }); });
  drop();
  logGpu({ event: 'release', id, ms: Date.now() - Date.parse(at) });
  return code;
}
