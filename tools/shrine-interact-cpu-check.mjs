// Real interaction/actions, minimal DOM, no browser or GPU.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Vector3 } from 'three';
import { CELL_M } from '../src/scale.js';
import { HAND_REACH } from '../src/pov/constants.js';

register(`data:text/javascript,${encodeURIComponent(
  "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
)}`);
class Element {
  nodeType = 1; children = []; attrs = {}; events = {}; hidden = false;
  constructor(tag) {
    this.tag = tag;
    const classes = new Set();
    this.classList = { add: c => classes.add(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) };
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
const { luminance } = await import('../src/ui/dom.js');
const interaction = createInteract();
const eye = new Vector3(), dir = new Vector3(0, 0, -1);
let taken = 0;
const target = { id: 'shrine', title: 'Saving Grace', lines: ['Stay alive.'], radius: 0.75,
  position: new Vector3(), proximity: true, use() { taken++; } };
let targets = [target];
interaction.provide(() => targets);
try {
  for (const axis of ['x', 'y', 'z']) for (const sign of [-1, 1]) {
    for (const [metres, expected] of [[1.19, target], [1.21, null], [6, null]]) {
      eye.set(0, 0, 0); eye[axis] = sign * metres / CELL_M;
      interaction.update(eye, dir, Infinity, true);
      assert.equal(interaction.focus, expected, `${axis} ${sign * metres} m`);
      if (!expected) assert.equal(interaction.use(), false);
    }
  }
  eye.set(3, 0, 3);
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus, null, 'diagonal outside radius');
  target.position.set(0, 4.75, 0); eye.set(0, 6, 3);
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus, target, 'standing beside the real plinth');
  assert.equal(taken, 0, 'proximity never automatically takes a perk');
  const button = document.body.querySelector('button');
  assert.equal(button.attrs['aria-label'], 'Take Saving Grace');
  button.events.click();
  assert.equal(taken, 1, 'click takes the perk');
  assert.equal(interaction.use(), true);
  assert.equal(taken, 2, 'E takes the perk');
  targets = [{ ...target, id: 'farther', position: new Vector3(2, 6, 3) },
    { ...target, id: 'nearest', position: new Vector3(1, 6, 3) }];
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus.id, 'nearest');
  dir.negate();
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus.id, 'nearest', 'no precise aiming for shrine choices');
  target.proximity = false; targets = [target]; eye.set(0, 0, 0);
  target.position.set(0, 0, HAND_REACH);
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus, target, 'ordinary pickup range stays unchanged');
  interaction.update(eye, dir, 0, true);
  assert.equal(interaction.focus, null, 'ordinary pickups respect the aimed obstruction');
  dir.negate();
  interaction.update(eye, dir, Infinity, true);
  assert.equal(interaction.focus, null, 'ordinary pickups require aim');
  interaction.update(eye, dir, Infinity, false);
  assert.equal(interaction.use(), false, 'inactive prompt cannot take a perk');
  assert.ok((luminance('#b8c1d1') + 0.05) / (luminance('#161a23') + 0.05) >= 4.5);
} finally {
  interaction.dispose();
}
assert.equal(document.body.children.length, 0);
console.log('Shrine range, real plinth, nearest choice, click/E, ordinary pickups and text contrast pass (CPU only).');
