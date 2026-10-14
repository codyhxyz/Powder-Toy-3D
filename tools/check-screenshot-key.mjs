// CPU-only regression for the screenshot shortcut and POV key routing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/app.js');
const pov = read('../src/pov/index.js');
const branch = app.match(/else if \(k === 'F2'\) \{[^\n]+\}/)?.[0];
assert(branch, 'F2 screenshot handler exists');
assert.doesNotMatch(app, /k === 'p' \|\| k === 'P'\) actions.screenshot/);
const passKeys = vm.runInNewContext(pov.match(/const PASS_KEYS = (new Set\([^;]+\));/)[1]);
const blocksKey = pov.match(/const blocksKey = ([^\n]+);/)[1];
for (const active of [false, true]) {
  const blocked = vm.runInNewContext(blocksKey, { editing: false, active: () => active, PASS_KEYS: passKeys, classesOn: () => false });
  assert.equal(blocked({ key: 'F2' }), false, 'F2 passes through god/POV routing');
}
assert.equal(passKeys.has('p'), false);
assert.equal(passKeys.has('P'), false);
for (const [key, repeat, expected] of [['F2', false, 1], ['F2', true, 0], ['p', false, 0], ['P', false, 0]]) {
  let shots = 0, prevented = false;
  vm.runInNewContext(branch.replace(/^else /, ''), {
    k: key, e: { repeat, preventDefault() { prevented = true; } },
    actions: { screenshot() { shots++; } },
  });
  assert.equal(shots, expected);
  assert.equal(prevented, key === 'F2');
}
assert.match(read('../src/ui/hud.js'), /row\('Screenshot', 'F2'\)/);
assert.match(read('../README.md'), /\| `F2` \| save a screenshot/);
console.log('PASS: F2 screenshots in god/POV, no repeat downloads, P removed, help updated.');
