// CPU only. Exercise the real component and h helper; CSS needs no DOM engine.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

let animateMode = 'normal';
const animations = [];
class Element extends Events {
  nodeType = 1;
  children = [];
  attributes = {};
  style = {};
  hidden = false;
  writes = 0;
  classes = new Set();
  classList = { add: value => this.classes.add(value) };
  constructor(tag) {
    super();
    this.tagName = tag;
    if (animateMode === 'missing') this.animate = undefined;
  }
  set textContent(value) { this.text = value; this.writes++; }
  get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  getBoundingClientRect() { return { left: 12, top: 678, width: 110, height: 110 }; }
  animate(frames, options) {
    if (animateMode === 'throws') throw new Error('WAAPI unavailable');
    const animation = {
      target: this, frames, options, cancelled: false,
      cancel() { this.cancelled = true; this.oncancel?.(); },
      finish() { this.onfinish?.(); },
    };
    animations.push(animation);
    return animation;
  }
}

globalThis.document = {
  body: new Element('body'),
  createElement: tag => new Element(tag),
  createTextNode: text => ({ nodeType: 3, textContent: text }),
};
const media = Object.assign(new Events(), { matches: false });
globalThis.window = Object.assign(new Events(), {
  innerWidth: 1200, innerHeight: 800,
  visualViewport: new Events(), matchMedia: () => media,
});
const { createDebtBadge } = await import('../src/pov/village/debtBadge.js');
const identity = 'translate(0px, 0px) scale(1)';
const state = { active: true, balance: -56000 };
const walk = node => [node, ...node.children.flatMap(walk)];
const byClass = (root, name) => walk(root).filter(node => node.classes.has(name));
let checks = 0;
function check(name, fn) {
  fn();
  assert.equal(document.body.children.length, 0, 'disposed DOM');
  assert.equal(window.listenerCount, 0, 'window listeners removed');
  assert.equal(window.visualViewport.listenerCount, 0, 'viewport listeners removed');
  assert.equal(media.listenerCount, 0, 'media listener removed');
  checks++;
  console.log(`PASS ${name}`);
}
function fixture() {
  const badge = createDebtBadge();
  return { badge, root: document.body.children.at(-1) };
}

check('reload docks; one original glyph, true minus, caption and accessible debt', () => {
  const { badge, root } = fixture();
  const before = animations.length;
  assert.equal(root.hidden, true);
  badge.update(state);
  assert.equal(root.hidden, false);
  assert.equal(document.body.children.length, 1);
  assert.equal(byClass(root, 'village-debt-badge').length, 1);
  assert.equal(byClass(root, 'village-debt-number')[0].textContent, '−56,000');
  assert.equal(byClass(root, 'village-debt-caption')[0].textContent, 'Your balance');
  const glyph = byClass(root, 'village-debt-glyph');
  assert.equal(glyph.length, 1);
  assert.equal((glyph[0].innerHTML.match(/<svg /g) ?? []).length, 1);
  assert.equal(root.attributes.role, 'status');
  assert.equal(root.attributes['aria-live'], 'polite');
  assert.equal(root.attributes['aria-label'], 'Your balance: debt 56,000 Nibs');
  assert.equal(root.style.transform, identity);
  assert.equal(animations.length, before);
  const spoken = byClass(root, 'village-debt-spoken')[0];
  const writes = spoken.writes;
  badge.update(state);
  assert.equal(spoken.writes, writes, 'no repeated live announcement');
  badge.update({ ...state, balance: -55000 });
  assert.equal(spoken.writes, writes + 1);
  assert.equal(spoken.textContent, 'Your balance: debt 55,000 Nibs');
  badge.dispose();
});

check('same bubble scales and translates in one segment, holds, settles, never replays', () => {
  const { badge, root } = fixture();
  const descendants = walk(root);
  const before = animations.length;
  badge.update({ ...state, reveal: true });
  const animation = animations.at(-1);
  assert.equal(animation.target, root);
  assert.deepEqual(walk(root), descendants);
  assert.deepEqual(animation.frames, [
    { transform: 'translate(533px, -333px) scale(2)' },
    { transform: identity },
  ]);
  assert.equal(animation.options.delay, 1200);
  assert.equal(animation.options.duration, 750);
  assert.equal(animation.options.fill, 'both');
  assert.equal(animation.options.easing, 'cubic-bezier(0.22, 1, 0.36, 1)');
  for (let i = 0; i < 5; i++) badge.update({ ...state, reveal: true });
  assert.equal(animations.length, before + 1);
  assert.equal(animation.cancelled, false);
  animation.finish();
  assert.equal(root.style.transform, identity);
  assert.equal(animation.cancelled, true, 'remove animation fill after completion');
  badge.update({ ...state, reveal: true });
  assert.equal(animations.length, before + 1);
  badge.dispose();
});

check('inactive reveal stays pending; hiding cancels, zero hides, returning docks', () => {
  const { badge, root } = fixture();
  const before = animations.length;
  badge.update({ ...state, active: false, reveal: true });
  assert.equal(root.hidden, true);
  assert.equal(animations.length, before);
  badge.update(state);
  assert.equal(animations.length, before + 1);
  const animation = animations.at(-1);
  badge.update({ ...state, active: false });
  assert.equal(animation.cancelled, true);
  assert.equal(root.style.transform, identity);
  badge.update(state);
  assert.equal(root.hidden, false);
  assert.equal(animations.length, before + 1);
  badge.update({ ...state, balance: 0 });
  assert.equal(root.hidden, true);
  badge.dispose();
});

check('reduced motion acknowledges in place with a short fade only', () => {
  media.matches = true;
  const { badge, root } = fixture();
  badge.update({ ...state, reveal: true });
  const animation = animations.at(-1);
  assert.deepEqual(animation.frames, [{ opacity: 0.65 }, { opacity: 1 }]);
  assert.equal(animation.options.duration, 180);
  assert.equal(root.style.transform, identity);
  animation.finish();
  assert.equal(root.style.opacity, '1');
  badge.dispose();
  media.matches = false;
});

for (const mode of ['missing', 'throws']) check(`${mode} animate leaves visible dock`, () => {
  animateMode = mode;
  const { badge, root } = fixture();
  badge.update({ ...state, reveal: true });
  assert.equal(root.hidden, false);
  assert.equal(root.style.transform, identity);
  badge.dispose();
  animateMode = 'normal';
});

for (const [name, target, event] of [
  ['window resize', window, 'resize'],
  ['visual viewport resize', window.visualViewport, 'resize'],
  ['motion preference change', media, 'change'],
]) check(`${name} cancels and settles`, () => {
  const { badge, root } = fixture();
  badge.update({ ...state, reveal: true });
  const animation = animations.at(-1);
  target.emit(event);
  assert.equal(animation.cancelled, true);
  assert.equal(root.style.transform, identity);
  const before = animations.length;
  badge.update({ ...state, reveal: true });
  assert.equal(animations.length, before);
  badge.dispose();
});

check('dispose cancels ongoing animation and makes later updates harmless', () => {
  const { badge, root } = fixture();
  badge.update({ ...state, reveal: true });
  const animation = animations.at(-1);
  badge.dispose();
  assert.equal(animation.cancelled, true);
  assert.equal(root.style.transform, identity);
  badge.update({ ...state, reveal: true });
  badge.dispose();
});

check('CSS pins organic dock, installed font, readable type and coarse joystick clearance', () => {
  const css = readFileSync(new URL('../src/pov/village/debtBadge.css', import.meta.url), 'utf8');
  assert.match(css, /transform-origin: center/);
  assert.match(css, /border-radius: 48% 52% 46% 54% \/ 54% 47% 53% 46%/);
  assert.match(css, /width: 110px/);
  assert.match(css, /left: max\(12px, env\(safe-area-inset-left\)\)/);
  assert.match(css, /bottom: calc\(12px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media \(pointer: coarse\), \(any-pointer: coarse\)/);
  assert.match(css, /bottom: calc\(142px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /width: 98px/);
  assert.match(css, /font-size: 17px/);
  assert.match(css, /font-size: 11px/);
  assert.match(css, /Village Nunito/);
  assert.ok(readFileSync(new URL('../public/fonts/nunito-latin-variable.woff2', import.meta.url)).length);
});

console.log(`${checks} CPU-only debt badge checks passed; no browser or GPU used.`);
