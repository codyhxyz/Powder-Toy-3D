#!/usr/bin/env node
// One machine-wide log of who uses the GPU, why and for how long. Every
// session, subagent and worktree writes to the same file, so anyone can see
// who holds the GPU right now and who has been on it today. It only records:
// nothing here refuses a run (the slot rules live in browser.mjs).
//
//   node tools/gpu-log.mjs                 who holds the GPU now + recent runs
//   node tools/gpu-log.mjs --since 6h      totals per session over that window
//   node tools/gpu-log.mjs note "why" [--secs 60]
//                                          log GPU use the launcher can't see
//                                          (windowed Chrome, Claude in Chrome)
//   node tools/gpu-log.mjs --json          the raw entries
//
// launchBrowser() writes a `start` line for every run and a `refused` line
// when it can't get the slot; the deadline guard's runs/<pid>-<guard>.json
// report supplies the end time, so a killed test still gets its occupancy.
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
const RECENT = 15;                  // runs listed by default
const RUN_TIMEOUT_MS = 500;
const LSOF_TIMEOUT_MS = 2000;     // lsof walks every open file first
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
    commit: run('git', ['rev-parse', '--short', 'HEAD'], top),
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

// Guard reports with no start line: runs from worktrees whose launcher predates
// this log. Listed so the log still counts every headless run on the machine.
function unlogged(log) {
  const seen = new Set(log.filter(e => e.event === 'start').map(e => `${e.pid}-${e.guardPid}.json`));
  let files = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json') && !seen.has(f)); } catch {}
  return files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(r => r?.startedAt).map(r => {
      const running = r.status === 'running' && alive(r.guardPid);
      return {
        event: 'start', at: r.startedAt, pid: r.ownerPid, guardPid: r.guardPid, branch: '?',
        worktree: running ? worktreeOf(r.ownerPid) : '',
        command: !running ? '(older launcher: no who/why)'
          : alive(r.ownerPid) ? `(older launcher) ${run('ps', ['-o', 'args=', '-p', String(r.ownerPid)]).slice(0, 160)}`
          : '(older launcher: test exited, guard cleaning up)',
        ms: r.occupancyMs ?? (running ? Date.now() - Date.parse(r.startedAt) : null),
        status: running ? 'running' : r.status === 'running' ? 'stale' : r.forced ? 'forced' : r.status,
      };
    });
}
// A live process's worktree, from its working directory.
function worktreeOf(pid) {
  const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], undefined, LSOF_TIMEOUT_MS).split('\n').find(l => l.startsWith('n'))?.slice(1);
  return cwd ? path.basename(run('git', ['rev-parse', '--show-toplevel'], cwd) || cwd) : '';
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
  if (!holder) return 'GPU slot: free';
  return `GPU slot: held by ${describeHolder(holder, log)}${alive(holder) ? '' : ' (holder is DEAD: the lease needs cleanup, see docs/headless-testing-cost.md)'}`;
}

function row(e) {
  const what = e.why || e.command || '';
  if (e.event === 'refused') return `${when(e.at)}  refused   ${label(e)}  ${what}\n${' '.repeat(24)}${e.reason}`;
  if (e.event === 'note') return `${when(e.at)}  note ${secs(e.ms).padStart(7)}  ${label(e)}  ${what}`;
  const branch = e.branch && e.branch !== '?' ? ` (${e.branch})` : '';
  return `${when(e.at)}  ${(e.status === 'running' ? 'now' : ['forced', 'stale'].includes(e.status) ? e.status : '').padEnd(6)}${secs(e.ms).padStart(6)}  ${label(e)}${branch}  ${what}`;
}

function totals(log, sinceMs) {
  const from = Date.now() - sinceMs, by = new Map();
  for (const e of log.filter(x => Date.parse(x.at) >= from && x.event !== 'refused')) {
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
  if (args[0] === 'note') {
    const why = args[1];
    if (!why) { console.error('usage: gpu-log.mjs note "why" [--secs N]'); process.exit(2); }
    const s = Number(opt('--secs'));
    // The note's own process is this CLI; the agent and worktree are what matter.
    let table = [];
    try { table = processTable(); } catch {}
    const who = whoAmI(table);
    logGpu({ event: 'note', why, ...who, command: '', ms: Number.isFinite(s) ? s * 1000 : null });
    console.log(`logged: ${label(who)}: ${why}`);
  } else {
    const logged = readLog();
    const log = [...logged.map(withReport), ...unlogged(logged)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (args.includes('--json')) console.log(JSON.stringify(log, null, 2));
    else {
      console.log(now(log));
      const since = parseSince(opt('--since'));
      if (since) {
        console.log(`\nGPU time per session, last ${opt('--since')}:`);
        console.log(totals(log, since).join('\n') || '  (none)');
      } else {
        console.log(`\nRecent (${LOG_FILE}):`);
        console.log(log.slice(-RECENT).map(row).join('\n') || '  (no runs logged yet)');
      }
    }
  }
}
