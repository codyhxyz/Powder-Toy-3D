// Focused interaction presentation/input checks: no browser, renderer or GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { Vector3 } from 'three';

register(`data:text/javascript,${encodeURIComponent(
  "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
)}`);
class Element {
  nodeType = 1; children = []; attrs = {}; events = {}; hidden = false;
  constructor(tag) {
    this.tag = tag;
    const classes = new Set();
    this.classList = { add: c => classes.add(c), contains: c => classes.has(c),
      toggle: (c, on) => on ? classes.add(c) : classes.delete(c) };
  }
  append(...children) { children.forEach(c => { c.parent = this; this.children.push(c); }); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { this.events[k] = fn; }
  querySelector(tag) {
    for (const child of this.children) {
      const match = child.tag === tag ? child : child.querySelector(tag);
      if (match) return match;
    }
    return null;
  }
}
globalThis.document = { createElement: tag => new Element(tag), body: new Element('body') };
const { createInteract } = await import('../src/pov/interact.js');
let mode = 'sandbox', uses = 0;
const interaction = createInteract({ getMode: () => mode });
const eye = new Vector3(), dir = new Vector3(0, 0, -1);
let target = { id: 'imported:Door', title: 'Door', verb: 'Open', lines: [],
  position: new Vector3(0, 0, -1), radius: 0.8, use() { uses++; } };
interaction.provide(() => [target]);
const update = (on = true) => interaction.update(eye, dir, Infinity, on);
const prompt = document.body.children[0];
const label = () => prompt.querySelector('button').children[0].textContent;
const button = () => prompt.querySelector('button');
try {
  update();
  assert.equal(prompt.classList.contains('source-use'), false, 'sandbox keeps incumbent card');
  assert.equal(button().attrs['aria-label'], 'Open Door');
  mode = 'crueltySquad'; update();
  assert.ok(prompt.classList.contains('source-use'), 'same target adopts live source mode');
  assert.ok(prompt.classList.contains('imported-use'));
  assert.ok(prompt.classList.contains('compact-use'), 'ordinary imported door has no redundant title');
  assert.equal(label(), 'Open');
  assert.equal(button().tag, 'button');
  assert.equal(button().attrs.type, 'button');
  assert.equal(button().attrs['aria-keyshortcuts'], 'E');
  assert.equal(button().children[1].attrs['aria-hidden'], 'true');
  button().events.click();
  assert.equal(uses, 1, 'semantic click/tap dispatches real use');
  assert.equal(interaction.use(), true);
  assert.equal(uses, 2, 'E entry point dispatches same callback');
  update();
  prompt.classList.toggle('source-use', false); update();
  assert.ok(prompt.classList.contains('source-use'), 'scope refreshes even before shownKey cache return');

  target.verb = 'Auto-closes'; update();
  assert.equal(label(), 'Use', 'do not present implementation-state Auto-closes as action');
  assert.equal(button().attrs['aria-label'], 'Use Door');
  mode = 'sandbox'; update();
  assert.equal(label(), 'Auto-closes', 'same target restores incumbent action outside source mode');
  assert.equal(prompt.classList.contains('source-use'), false);

  mode = 'crueltySquad';
  target = { ...target, id: 'imported:Locked_Door', verb: 'Inspect requirement',
    lines: ['The door is locked. Find the key.'] };
  update();
  assert.equal(prompt.classList.contains('compact-use'), false, 'locked title is not stripped');
  assert.equal(prompt.children[1].children[0].textContent, 'The door is locked. Find the key.');
  assert.equal(button().attrs['aria-label'], 'Inspect requirement Door');
  button().events.click();
  assert.equal(uses, 3, 'Inspect still invokes the provider explanation');

  target = { ...target, id: 'pickup', title: 'Potion', verb: 'Take' }; update();
  assert.equal(prompt.classList.contains('imported-use'), false, 'ordinary pickups cannot suppress Rock readout');
  target.id = 'imported:Door'; target.verb = 'Open';
  target.lines = ['Ownership warning remains readable.']; update();
  assert.equal(prompt.children[1].children[0].textContent, 'Ownership warning remains readable.');
  update(false);
  assert.equal(prompt.classList.contains('show'), false, 'focus loss releases hover suppression');
  assert.equal(interaction.focus, null);
  assert.equal(interaction.use(), false);
  assert.equal(prompt.querySelector('button'), null, 'inactive action is not keyboard/tap reachable');
} finally { interaction.dispose(); }
assert.equal(document.body.children.length, 0, 'disposal also releases hover suppression');

// CSS/source guards are deliberately static; parent performs computed-style/visual checks.
const css = readFileSync(new URL('../src/pov/pov.css', import.meta.url), 'utf8');
assert.match(css, /body:has\(\.pov-use\.source-use\.imported-use\.show\) \.readout \{ visibility: hidden; \}/,
  'readout suppression requires visible imported source-mode focus, never global');
assert.match(css, /\.pov-use\.source-use \{[^}]*padding: 0;[^}]*background: none; border: 0;/s);
assert.match(css, /\.pov-use\.source-use \.action-button:focus-visible \{ outline: 2px solid currentColor;/);
assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.pov-use\.source-use \.action-button \{ min-height: 44px; \}/);
assert.match(css, /\.pov-use\.source-use \.action-button \{[^}]*min-width: 44px;/s);
assert.match(css, /\.pov-use\.source-use \.action-key \{ display: inline-flex;[^}]*white-space: nowrap;/s,
  'bracket pseudos stay in one row, not the shared kbd grid');
assert.match(css, /\.pov-use\.source-use \.action-button \{ min-height: 44px; \}\s*\.pov-use\.source-use \.action-key \{ display: none; \}/,
  'touch keeps a large target without a desktop-only E hint');
const index = readFileSync(new URL('../src/pov/index.js', import.meta.url), 'utf8');
assert.match(index, /createInteract\(\{ getMode: \(\) => app\.gamemode\?\.\(\) \?\? 'sandbox' \}\)/);
assert.match(index, /const VEHICLE_KEY = 'KeyE'/);
assert.match(index, /if \(e\.code === VEHICLE_KEY && !e\.repeat\)[\s\S]*?mode === 'on' && interact\.use\(\)/, 'existing E routing retained');
console.log('Cruelty use: live mode/cache, semantic click/E, accessible name, locked/warning copy, scoped hover and CSS focus/touch guards pass (CPU only).');
