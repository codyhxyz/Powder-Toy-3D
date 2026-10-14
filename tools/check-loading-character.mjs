import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { characterForMode } from '../src/pov/character.js';

for (const mode of ['slayer', 'ctf', 'koth', 'infection']) {
  for (const choice of [undefined, 'real', 'stick', 'invalid']) {
    assert.equal(characterForMode(mode, choice), 'spartan', `${mode}/${choice}`);
  }
}
for (const mode of ['sandbox', 'siege', undefined]) {
  assert.equal(characterForMode(mode, 'stick'), 'stick');
  for (const choice of [undefined, 'real', 'invalid', null]) {
    assert.equal(characterForMode(mode, choice), 'real');
  }
}
console.log('PASS loading/gameplay character selection: Halo armor, saved preference, invalid preference');

for (const name of ['you', 'you-stick', 'you-spartan']) {
  const bytes = readFileSync(new URL(`../public/${name}.webp`, import.meta.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
}

// Exercise the actual worker lifecycle without taking the player's GPU.
const source = readFileSync(new URL('../src/ui/menu.js', import.meta.url), 'utf8');
const workers = [], classes = new Set();
const node = () => ({
  isConnected: true,
  replaceWith(other) { this.isConnected = false; other.isConnected = true; },
  transferControlToOffscreen() { return {}; },
});
const fig = {
  dataset: {},
  classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)) },
  addEventListener() {},
};
const context = {
  console: { warn() {} }, URL, devicePixelRatio: 1,
  OffscreenCanvas: class {},
  HTMLCanvasElement: { prototype: { transferControlToOffscreen() {} } },
  Worker: class {
    constructor() { workers.push(this); }
    postMessage(data) { if (data.canvas) this.character = data.character; }
    terminate() { this.terminated = true; }
  },
  YOU: (choice) => choice === 'real' ? '/you.webp' : `/you-${choice}.webp`,
  YOU_MAX_DPR: 2, YOU_MAX_H: 560, YOU_ASPECT: 260 / 420, h: node,
};
const liveYou = runInNewContext(`(${source.slice(source.indexOf('function liveYou(')).replaceAll('import.meta.url', '"https://test.invalid/menu.js"')})`, context);
const still = node(), preview = liveYou(fig, still);
preview.start('stick');
assert.equal(still.src, '/you-stick.webp');
assert.equal(workers.at(-1).character, 'stick');
workers.at(-1).onmessage({ data: 'ready' });
assert.ok(classes.has('live'));
const old = workers.at(-1);
preview.start('spartan');
assert.ok(old.terminated);
assert.ok(still.isConnected);
assert.equal(still.src, '/you-spartan.webp');
assert.equal(workers.at(-1).character, 'spartan');
old.onmessage({ data: 'ready' });
assert.ok(!classes.has('live'));
workers.at(-1).onmessage({ data: { failed: 'test failure' } });
assert.ok(still.isConnected);
assert.equal(still.src, '/you-spartan.webp');
preview.stop();
context.OffscreenCanvas = undefined;
preview.start('real');
assert.equal(still.src, '/you.webp');
assert.ok(!classes.has('live'));
preview.stop();
console.log('PASS portraits exist; worker selection, switching, stale replies, failure, and no-OffscreenCanvas fallback');
