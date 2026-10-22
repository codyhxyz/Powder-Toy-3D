// Naga (naga-cli) validation of a WGSL module for the CPU checks: the module goes to naga as a file,
// never through its stdin, and every run has a deadline.
//
// Why a file. spawnSync piping a module into `naga --stdin-file-path` sometimes never returns on
// this Mac (macOS 27.0 26A428, node 24.19.0, naga 30.0.1): naga waits in read() on its stdin for
// an EOF node never sends, and node waits in its sync loop's kevent with nothing to wake it, for
// ever. It is a race below the tools (no tool or app code runs in it): 2 of 4800 calls hung piping
// the 377 KB World Plain module, 0 of 4800 passing the same module as a file, under the same load
// (8 processes at once, load average 20-30). tools/world-plain-cpu-check.mjs, which pipes 13 large
// modules, hung about once in 80 runs and stalled the deploy sequence twice (2026-10-22).
// Why a deadline. Should anything else ever stall naga, the check fails in NAGA_TIMEOUT_MS with
// the module's name instead of holding the deploy until its own timeout.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/** The longest one naga run may take (a module validates in well under a second). */
export const NAGA_TIMEOUT_MS = 60000;

let dir = null;
const scratch = () => {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'tpt-naga-'));
    process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  }
  return dir;
};

/**
 * Runs naga on `code`, written to a file named after `file` (its extension tells naga the
 * language: '.wgsl'), and returns spawnSync's result: { status, stdout, stderr, error }. A run
 * past the deadline is killed: its status is null and error.code 'ETIMEDOUT'.
 * @param {string} code the module's source
 * @param {string} [file] its name in naga's messages (a path's last part is kept)
 * @param {{ encoding?: string, maxBuffer?: number, timeout?: number, bin?: string, args?: string[] }} [opts]
 *   bin/args: another validator binary or more arguments (tools/naga-file-check.mjs)
 */
export function nagaSpawn(code, file = 'module.wgsl', { encoding = 'utf8', maxBuffer = 64 << 20, timeout = NAGA_TIMEOUT_MS, bin = 'naga', args = [] } = {}) {
  const name = basename(String(file)).replace(/[^\w.-]/g, '_') || 'module.wgsl';
  const path = join(scratch(), name.endsWith('.wgsl') ? name : `${name}.wgsl`);
  writeFileSync(path, code);
  return spawnSync(bin, [...args, path], { encoding, maxBuffer, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * nagaSpawn, as execFileSync: its stdout, or a throw naming the module with naga's messages (or
 * the deadline it missed).
 */
export function nagaExec(code, file = 'module.wgsl', opts = {}) {
  const r = nagaSpawn(code, file, opts);
  if (r.error) throw new Error(`naga ${file}: ${r.error.code === 'ETIMEDOUT' ? `no answer in ${opts.timeout ?? NAGA_TIMEOUT_MS} ms` : r.error.message}`);
  if (r.status !== 0) throw new Error(`naga ${file} exited ${r.status ?? r.signal}:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.stdout;
}
