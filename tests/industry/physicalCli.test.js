import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const driver = fileURLToPath(new URL('../../tools/industry-physical-check.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [driver, ...args, '--preflight'], {
  encoding: 'utf8', timeout: 10_000,
});

test('refueling comparison preflights its physical apron without a browser', () => {
  const result = run('--case', 'line', '--operator', 'tools', '--refuel-once');
  assert.equal(result.status, 0, result.stderr);
  const geometry = JSON.parse(result.stdout);
  assert.equal(geometry.operatorMode, 'tools');
  assert.equal(geometry.refuelOnce, true);
  assert.equal(geometry.devices, 91);
});

test('refueling comparison rejects non-tool and non-line cases before launch', () => {
  for (const args of [
    ['--case', 'line'],
    ['--case', 'loading'],
    ['--case', 'thermal'],
  ]) {
    const result = run(...args, '--refuel-once');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /requires --case line --operator tools/);
  }
});

test('default line preflight preserves the backend fixture and does not request refueling', () => {
  const result = run('--case', 'line');
  assert.equal(result.status, 0, result.stderr);
  const geometry = JSON.parse(result.stdout);
  assert.equal(geometry.operatorMode, 'transfer');
  assert.equal(geometry.refuelOnce, false);
  assert.equal(geometry.devices, 83);
});
