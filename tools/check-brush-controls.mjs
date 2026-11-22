// CPU check of the real app/tool-gun handlers: outside click erases on release,
// a drag is the camera's (looking around: tools/check-camera-turn.mjs), and first-person right-click keeps its held erase stroke.
// node tools/check-brush-controls.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { E, TOOLS, PROP_TOOL } from '../src/elements.js';
import * as editing from '../src/editing.js';

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const tool = readFileSync(new URL('../src/pov/tools/toolgun.tool.js', import.meta.url), 'utf8');
const fn = name => {
  const start = app.indexOf(`function ${name}(`);
  assert(start >= 0);
  return app.slice(app.slice(start - 6, start) === 'async ' ? start - 6 : start, app.indexOf('\n}', start) + 2);
};
const start = app.indexOf('const toolGun = {');
const gun = app.slice(start, app.indexOf('\n};', start) + 3).replace('const toolGun', 'var toolGun');
let snapshots = 0, clicks = 0;
const c = vm.createContext({
  THREE, controls: {}, selectedMode: 'sandbox', ctx: {}, signs: null,
  document: { activeElement: null }, settings: { tool: E.SAND, radius: 3 },
  ERASE_TOOL: TOOLS.find(t => t.key === 'ERASE').id, SIGN_TOOL: -5, GUN_AIR_DIST: 4,
  painting: false, strokeTool: E.SAND, strokePainted: false, releasePending: false,
  windFromValid: false, toolGunOut: false, toolGunBuilding: false, strokeDist: 0,
  pendingShape: null, shapeDrag: null, builderMode: 'freehand',
  hover: { valid: true, cell: new THREE.Vector3(32, 19, 32), face: 2, id: E.WALL },
  tmpV: new THREE.Vector3(), povRay: { origin: new THREE.Vector3(32, 30, 32) },
  aimScreenRay: () => true, presentationPoint: (p, out) => out.copy(p),
  checkpointRestoring: () => false, hoverOnSlice: () => false,
  mp: { isGuest: false }, sim: { snapshot: () => snapshots++ },
  toolbar: { setUndoEnabled() {} }, hud: {}, pacer: { wake() {} },
  toolById: id => ({ name: String(id) }), clickTool: () => { clicks++; return null; },
  // Only the model/animation shell is stubbed; button dispatch is the real tool.
  gear: () => ({}), attachModel: () => ({ dispose() {} }),
  viewmodelRig: () => ({ hand: () => ({ visible: false }), update() {}, hit() {} }), HIT: { DRY: 0 },
});
vm.runInContext([fn('hoverBrushCenter'), fn('startStroke'), fn('press'), gun].join('\n'), c);
vm.runInContext(tool.replace(/^import .*;\n/gm, '').replace('export default', 'var definition ='), c);
const held = c.definition.create({ toolGun: c.toolGun });
const buttons = (patch = {}) => ({ primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, ...patch });

for (const selected of [E.SAND, -5]) {
  c.settings.tool = selected;
  const before = snapshots;
  held.update(buttons({ secondary: true, secondaryPressed: true }));
  assert.equal(c.strokeTool, c.ERASE_TOOL);
  assert.equal(c.painting, true);
  assert.equal(c.settings.tool, selected, 'erase does not change the selected brush');
  held.update(buttons({ secondary: true }));
  assert.equal(snapshots, before + 1, 'one undo snapshot per held stroke');
  assert.equal(clicks, 0, 'erase bypasses one-click tools such as signs');
  held.update(buttons());
  assert.equal(c.painting, false, 'releasing right-click ends erase');
}
c.settings.tool = E.SAND;
held.update(buttons({ primary: true, primaryPressed: true }));
assert.equal(c.strokeTool, E.SAND, 'left-click still paints the selected element');
held.deselect();
assert.equal(c.painting, false, 'changing tools ends the stroke');

const before = snapshots;
c.press({ button: 2 });
assert.equal(snapshots, before, 'outside right-button press never paints or erases');
vm.runInContext(app.match(/^controls\.mouseButtons = .*;$/m)[0], c);
assert.equal(c.controls.mouseButtons.RIGHT, null, 'outside, OrbitControls leaves the right drag to camera.js (it looks around)');
assert.equal(c.controls.mouseButtons.MIDDLE, THREE.MOUSE.PAN);
// The released click's own pick, not a stale hover, supplies the erase centre.
const paints = [];
Object.assign(c, {
  innerWidth: 900, innerHeight: 600, pointer: new THREE.Vector2(),
  gridRay: () => ({ origin: new THREE.Vector3(), direction: new THREE.Vector3(0, -1, 0) }),
  pickRay: async () => ({ valid: true, id: E.WALL, cell: new THREE.Vector3(10, 11, 12) }),
  canEraseClick: () => true,
  brushStroke: tool => ({ tool, radius: 3, shape: 0 }),
  paintStroke: stroke => paints.push(stroke),
});
vm.runInContext(fn('eraseClick'), c);
await c.eraseClick({ clientX: 450, clientY: 300 });
assert.equal(paints.length, 1);
assert.equal(paints[0].tool, c.ERASE_TOOL);
assert.deepEqual(paints[0].center.toArray(), [10.5, 11.5, 12.5]);
assert.equal(c.settings.tool, E.SAND);
assert.equal(snapshots, before + 1, 'one undo snapshot for the erased click');
assert.equal(c.painting, false, 'a released click never starts a held stroke');
c.canEraseClick = () => false;
await c.eraseClick({ clientX: 450, clientY: 300 });
assert.equal(paints.length, 1, 'a mode change during the async pick cancels the erase');
console.log('ok: first-person erase unchanged; outside press safe, released click erases one dab with undo');

// Drive the actual app shape handlers through the Tool Gun, keeping only the
// picking/input/rendering boundaries fake. One click per stage, one edit/undo.
Object.assign(c, editing, {
  builderMode: 'hollow', parked: null, pov: { active: true }, presentation: { active: false }, performance,
  worldAim: () => false, workAt() {}, builds: null, camera: { quaternion: new THREE.Quaternion() },
  PROP_TOOL, isVoxelBrush: t => t === E.SAND, hud: { toast: msg => assert.fail(msg) },
  sim: { ...c.sim, origin: new THREE.Vector3(), g: { nx: 64, ny: 64, nz: 64 } },
});
c.settings.rate = 1;
c.hover.cell.set(5, 1, 15);
c.povRay.origin.set(5.5, 10, 5.5);
c.povRay.direction = new THREE.Vector3(0, -8, 10).normalize();
const bindings = ['gridSize', 'containsBounds', 'cellPoint', 'localPoint'];
vm.runInContext([
  ...bindings.map(name => app.match(new RegExp(`^const ${name} = .*;$`, 'm'))[0]),
  ...['builderBounds', 'shapeAim', 'startShape', 'updateShapeDrag', 'advanceShape', 'finishShape', 'submitShape'].map(fn),
].join('\n'), c);
const left = () => held.update(buttons({ primaryPressed: true }));
const right = () => held.update(buttons({ secondaryPressed: true }));
const expectedSnapshots = snapshots + 1;
left();
assert.equal(c.shapeDrag.draft.phase, 'footprint');
assert.equal(c.painting, false, 'shape clicks never start a held stroke');
c.povRay.direction.set(4, -8, 14).normalize();
left();
assert.equal(c.shapeDrag.draft.phase, 'extrude');
c.povRay.direction.set(4, -3, 14).normalize();
left();
assert.equal(c.shapeDrag, null);
assert.equal(paints.length, 2);
assert.equal(paints[1].shell, 3);
assert.deepEqual(paints[1].center.toArray(), [7.5, 5, 17.5]);
assert.equal(snapshots, expectedSnapshots);
right();
assert.equal(c.shapeDrag.draft.carve, true);
assert.equal(c.shapeDrag.draft.hollow, false);
right();
assert.equal(c.shapeDrag, null);
assert.equal(paints.length, 2, 'right-click cancels the active selection without a stroke');
console.log('ok: tool gun clicks through footprint, extrude and commit; right starts a solid cut or cancels');
