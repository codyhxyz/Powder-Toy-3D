import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { characterForMode, previewCharacter, nextYouZoom, YOU_ZOOM_MIN, YOU_ZOOM_MAX, bodiesFor, genderOf } from '../src/pov/character.js';

for (const mode of ['slayer', 'ctf', 'koth', 'infection']) {
  for (const choice of [undefined, 'real', 'woman', 'stick', 'invalid']) {
    assert.equal(characterForMode(mode, choice), 'spartan', `${mode}/${choice}`);
  }
}
for (const mode of ['sandbox', 'siege', undefined]) {
  assert.equal(characterForMode(mode, 'stick'), 'stick');
  assert.equal(characterForMode(mode, 'woman'), 'woman');
  for (const choice of [undefined, 'real', 'invalid', null]) {
    assert.equal(characterForMode(mode, choice), 'real');
  }
}
console.log('PASS loading/gameplay character selection: Halo armor, saved preference, invalid preference');

assert.equal(previewCharacter('animalCrossing', 'stick', 'girl'), 'girl');
assert.equal(previewCharacter('animalCrossing', 'woman', 'boy'), 'boy');
assert.equal(previewCharacter('animalCrossing', 'real', 'nope'), 'boy');
assert.equal(previewCharacter('slayer', 'stick', 'girl'), 'spartan');
assert.equal(previewCharacter('sandbox', 'woman', 'girl'), 'woman');
assert.equal(previewCharacter('siege', 'stick'), 'stick');
// the remembered gender dresses the player in every world: the wizard here, the village boy or girl
for (const [gender, character, want] of [['female', 'stick', 'woman'], ['male', 'woman', 'real'], ['male', 'stick', 'stick'], ['nope', undefined, 'real']]) {
  const b = bodiesFor(gender, character);
  assert.equal(b.character, want, `${gender}/${character}`);
  assert.equal(previewCharacter('animalCrossing', b.character, b.villageCharacter), b.gender === 'female' ? 'girl' : 'boy');
  assert.equal(genderOf(b.character), b.gender);
}
assert.equal(nextYouZoom(1, 0), 1);
assert.ok(nextYouZoom(1, 100) > 1);
assert.ok(nextYouZoom(1, -100) < 1);
assert.equal(nextYouZoom(0.01, -1e6), YOU_ZOOM_MIN);
assert.equal(nextYouZoom(100, 1e6), YOU_ZOOM_MAX);
console.log('PASS loading preview: Animal Crossing persona, and Skyrim wheel zoom');

for (const name of ['you', 'you-woman', 'you-bag', 'you-spartan', 'you-boy', 'you-girl']) {
  const bytes = readFileSync(new URL(`../public/${name}.webp`, import.meta.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8X', 'portrait carries transparency');
  assert.ok(bytes.readUIntLE(27, 3) + 1 >= 1120, 'fallback covers the largest portrait at 2x density');
}

// Exercise the actual worker lifecycle without taking the player's GPU.
const source = readFileSync(new URL('../src/ui/menu.js', import.meta.url), 'utf8');
const YOU = runInNewContext(source.match(/^const YOU = .*;$/m)[0] + '\nYOU;');
assert.equal(YOU('stick'), '/you-bag.webp', 'saved stick choice uses the new paper-bag asset, not a cached stickman');
const workers = [], portraits = [], classes = new Set();
const node = () => {
  const portrait = {
    isConnected: true,
    style: {},
    attrs: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    set src(value) { this.attrs.src = value; },
    get src() { return this.attrs.src; },
    replaceWith(other) { this.isConnected = false; other.isConnected = true; },
    transferControlToOffscreen() { return {}; },
  };
  portraits.push(portrait);
  return portrait;
};
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
    postMessage(data) {
      if (data.canvas) this.character = data.character;
      if ('zoom' in data) this.zoom = data.zoom;
    }
    terminate() { this.terminated = true; }
  },
  YOU,
  YOU_MAX_DPR: 2, YOU_MAX_H: 560, YOU_ASPECT: 260 / 420, h: node,
  nextYouZoom,
};
const liveYou = runInNewContext(`(${source.slice(source.indexOf('function liveYou(')).replaceAll('import.meta.url', '"https://test.invalid/menu.js"')})`, context);
const still = node(), preview = liveYou(fig, still);
preview.start('stick');
assert.equal(still.src, '/you-bag.webp');
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
preview.start('woman');
assert.equal(still.src, '/you-woman.webp');
assert.equal(workers.at(-1).character, 'woman');
preview.stop();
preview.start('girl');
assert.equal(still.src, '/you-girl.webp');
assert.equal(workers.at(-1).character, 'girl');
preview.zoom(-200);
assert.equal(still.style.transform, `scale(${Math.exp(0.3).toFixed(4)})`);
workers.at(-1).onmessage({ data: 'ready' });
assert.equal(workers.at(-1).zoom, undefined, 'worker camera stays framed');
assert.equal(portraits.at(-1).style.transform, `scale(${Math.exp(0.3).toFixed(4)})`);
preview.zoom(400);
assert.equal(portraits.at(-1).style.transform, `scale(${Math.exp(-0.3).toFixed(4)})`);
assert.equal(still.style.transform, portraits.at(-1).style.transform, 'fallback and live zoom match');
preview.stop();
assert.equal(still.style.transform, `scale(${Math.exp(-0.3).toFixed(4)})`, 'failure/stop keeps fallback zoom');
context.OffscreenCanvas = undefined;
preview.start('real');
assert.equal(still.src, '/you.webp');
assert.equal(still.style.transform, '', 'new character resets zoom');
assert.ok(!classes.has('live'));
preview.zoom(-1e6);
assert.equal(still.style.transform, `scale(${(1 / YOU_ZOOM_MIN).toFixed(4)})`, 'fallback zoom is bounded too');
preview.stop();
console.log('PASS portraits exist; worker selection, switching, stale replies, failure, and no-OffscreenCanvas fallback');
console.log('PASS whole-portrait zoom: still/live handoff, framed worker camera, bounds, and character reset');
