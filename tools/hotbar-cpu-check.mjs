// Real selector logic with a minimal DOM and fake clock; no browser or GPU.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mock } from 'node:test';

register(`data:text/javascript,${encodeURIComponent(
  "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
)}`);
class Element extends EventTarget {
  nodeType = 1; children = []; attrs = {}; style = {}; hovered = false; inert = false;
  constructor() {
    super();
    const classes = new Set();
    this.classList = {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
    };
  }
  append(...children) {
    for (const child of children) {
      child.remove(); child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  matches(selector) { assert.equal(selector, ':hover'); return this.hovered; }
}
globalThis.document = Object.assign(new EventTarget(), {
  createElement: () => new Element(), body: new Element(), activeElement: null, pointerLockElement: null,
});
globalThis.matchMedia = () => ({ matches: false });
const { createHotbar } = await import('../src/pov/tools/hotbar.js');
mock.timers.enable({ apis: ['setTimeout'] });
const hotbar = createHotbar();
const isOpen = () => hotbar.el.classList.contains('open');
const lock = value => {
  document.pointerLockElement = value;
  document.dispatchEvent(new Event('pointerlockchange'));
};
try {
  hotbar.setSlot(0, [{ key: 'SHOVEL', name: 'Shovel' }], 0);
  hotbar.select(0);
  hotbar.setVisible(true);
  assert.equal(isOpen(), false, 'entering with a free mouse does not open the selector');
  lock({});
  lock(null); // Esc releases pointer lock.
  assert.equal(isOpen(), false, 'Esc must not open the selector');
  hotbar.select(0);
  assert.equal(isOpen(), true, 'number/wheel selection still opens it');
  assert.equal(hotbar.confirm(), false, 'a free-mouse click does not consume a selection');
  mock.timers.tick(1500);
  assert.equal(isOpen(), false, 'selection fades even with a free mouse');
  lock({});
  hotbar.select(0);
  lock(null);
  assert.equal(isOpen(), false, 'Esc dismisses a visible selector');
  lock({});
  hotbar.select(0);
  assert.equal(hotbar.confirm(), true, 'a gameplay click confirms selection');
  assert.equal(hotbar.confirm(), false, 'the following click can fire');
  hotbar.select(0);
  hotbar.el.hovered = true;
  mock.timers.tick(1500);
  assert.equal(isOpen(), true, 'hover keeps deliberate selection usable');
  hotbar.el.hovered = false;
  document.activeElement = hotbar.el.children[0].children[0];
  hotbar.el.dispatchEvent(new Event('pointerleave'));
  mock.timers.tick(1500);
  assert.equal(isOpen(), true, 'keyboard focus keeps selection usable');
  document.activeElement = null;
  hotbar.el.dispatchEvent(new Event('focusout'));
  mock.timers.tick(1500);
  assert.equal(isOpen(), false);
  hotbar.select(0);
  hotbar.setVisible(false);
  assert.equal(isOpen(), false);
  assert.equal(hotbar.el.inert, true);
  lock(null);
  hotbar.setVisible(true);
  assert.equal(isOpen(), false, 'restoring the HUD does not reopen the selector');
} finally {
  hotbar.dispose();
  mock.timers.reset();
}
assert.equal(document.body.children.length, 0);
console.log('Hotbar: Esc/unlock stays closed; deliberate selection, fade, confirmation and focus pass (CPU only).');
