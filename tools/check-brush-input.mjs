// CPU regression for the app's actual input handlers; no browser/GPU required.
// The browser counterpart is brush-input-check.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { E, TOOLS, PROP_TOOL } from '../src/elements.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const upStart = source.indexOf("addEventListener('pointerup', (e) => {");
const up = source.slice(upStart, source.indexOf('\n});', upStart) + 4);
const erase = TOOLS.find(t => t.key === 'ERASE').id;
let clicks = 0, snapshots = 0, release;
const c = vm.createContext({
  selectedMode: 'sandbox', ctx: {}, signs: null,
  document: { activeElement: null }, innerWidth: 900, innerHeight: 600,
  settings: { tool: E.SAND, radius: 3 }, pointer: new THREE.Vector2(),
  hover: { valid: true, cell: new THREE.Vector3(32, 19, 32), face: 2, id: E.WALL },
  tmpV: new THREE.Vector3(), dragY: 0, ERASE_TOOL: erase, PROP_TOOL,
  painting: false, releasePending: false, strokePainted: false,
  shapeDrag: null, strokeTool: E.SAND, strokeButton: 0, windFromValid: false, eyedropper: false,
  mp: { isGuest: false }, sim: { snapshot: () => snapshots++ },
  toolbar: { setUndoEnabled() {} }, hud: { dismissHint() {}, toast() {} }, pacer: { wake() {} },
  toolById: id => ({ name: String(id) }), canvasEl: { setPointerCapture() {} },
  clickTool: () => { clicks++; return null; }, drawModeOf: () => null,
  propValue: () => null, openProp: () => assert.fail('erase must not open Property'),
  pickHovered: () => assert.fail('erase must not pick an element'),
  addEventListener: (_, cb) => { release = cb; },
  pov: null, brushValid: false, brushCenter: new THREE.Vector3(), pointerInside: true, uiHover: false,
  scale: 1, volume: { position: new THREE.Vector3() }, builds: null,
  isBrush: id => id !== -5, isBuild: () => false,
  planePoint: out => { out.set(32.5, 19.5, 32.5); return true; },
  clampToGrid() {}, presentationPoint: (p, out) => out.copy(p),
  brush: { set: state => { c.drawn = state; } },
});
vm.runInContext(['hoverBrushCenter', 'startStroke', 'press', 'updateBrush'].map(fn).join('\n') + '\n' + up, c);
const event = (button = 0, extra = {}) => ({ button, clientX: 450, clientY: 300, pointerType: 'mouse', ...extra });
for (const tool of [E.SAND, -5, PROP_TOOL]) {
  c.settings.tool = tool;
  c.eyedropper = true;
  c.press(event(2));
  assert.equal(c.strokeTool, erase);
  assert.equal(c.strokeButton, 2);
  assert.equal(c.dragY, 19.5, 'erase centres on the cell, not above its face');
  assert.equal(c.settings.tool, tool, 'selection is unchanged');
  assert.equal(c.painting, true);
  c.updateBrush();
  assert.equal(c.brushValid, true, 'erase works even when the selected tool is not a brush');
  assert.equal(c.drawn.visible, true, 'erase shows a brush even with the eyedropper selected');
  const n = snapshots;
  c.press(event(0));
  release(event(0));
  assert.equal(snapshots, n, 'other buttons cannot start another stroke');
  assert.equal(c.painting, true, 'other buttons cannot release this stroke');
  c.strokePainted = true;
  release(event(2));
  assert.equal(c.painting, false, 'right release ends the stroke');
  c.press(event(2));
  release(event(2));
  assert.equal(c.releasePending, true, 'a quick click waits for its first paint');
  c.painting = c.releasePending = false;
}
assert.equal(clicks, 0, 'right-click bypasses one-click tools');
for (const e of [event(1), event(2, { shiftKey: true }), event(0, { altKey: true }), event(2, { altKey: true })]) {
  const n = snapshots;
  c.press(e);
  assert.equal(snapshots, n, 'camera gestures do not erase');
}
c.settings.tool = E.SAND;
c.eyedropper = false;
c.press(event());
assert.equal(c.strokeTool, E.SAND, 'left-click still paints the selected element');
assert.equal(c.dragY, 23, 'element placement retains its face offset');
assert.equal(clicks, 1);
console.log('ok: erase selection, placement, undo snapshots, quick clicks, button ownership and camera guards');
