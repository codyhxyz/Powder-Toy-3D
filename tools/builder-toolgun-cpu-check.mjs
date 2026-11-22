import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E } from '../src/elements.js';
import { boxFromCorners, boxContains, boxShellThickness, builderBox, builderPress, previewBuilder, snapLine, lineRadius,
  nextBuilderMode, builderPlanePoint, builderExtrudeGuide, builderExtrudeDepth } from '../src/editing.js';
import { KEYS, is } from '../src/keys.js';
import { applyGuestStroke } from '../src/net/edits.js';
import { PAINT_SHELL, validPaintShell } from '../src/net/protocol.js';
import { builderNote } from '../src/pov/hud.js';
import { WorldWindow } from '../src/world/window.js';
import { gridLayout, Simulation } from '../src/sim.js';
import { brushWGSL } from '../src/brush.js';
import { paintKernelWGSL } from '../src/shaders/passes.js';
import { assertNaga } from './v2/wgsl-grouping.mjs';

const zero = [0, 0, 0], dims = [64, 64, 64];
const coords = [20, 22, 25];
for (let face = 0; face < 6; face++) {
  test(`face ${face}: footprint and extrude one voxel outside, carve from the hit voxel`, () => {
    const axis = face >> 1, normal = face % 2 ? -1 : 1;
    for (const carve of [false, true]) {
      const { draft } = builderPress('hollow', null, { cell: coords, face, secondary: carve });
      const start = coords.map((v, i) => i === axis && !carve ? v + normal : v);
      assert.deepEqual(draft.start, start);
      assert.equal(draft.plane, coords[axis] + (normal > 0 ? 1 : 0));
      assert.equal(draft.sign, carve ? -normal : normal);
      assert.equal(draft.hollow, !carve);
      const footprint = previewBuilder(draft, { point: [25.4, 18.1, 32.8] }, zero, dims);
      const slab = builderBox(footprint, 1);
      assert.equal(slab.size[axis], 1);
      for (let i = 0; i < 3; i++) {
        if (i === axis) continue;
        const end = [25, 18, 32][i];
        assert.equal(slab.lo[i], Math.min(start[i], end));
        assert.equal(slab.hi[i], Math.max(start[i], end) + 1);
      }
      const { draft: extrude } = builderPress('hollow', footprint);
      const box = builderBox(previewBuilder(extrude, { depth: 6.65 }, zero, dims), 1);
      assert.equal(box.size[axis], 8);
      assert.equal(box.lo[axis], start[axis] + (draft.sign < 0 ? -7 : 0));
      assert.equal(box.hi[axis], start[axis] + (draft.sign > 0 ? 8 : 1));
      assert.deepEqual(box.size.map((n, i) => i === axis ? 1 : n), slab.size);
    }
  });
}

test('extrude guide has no jump and uses the captured corner on oblique and head-on rays', () => {
  const ray = (C, B, A = zero) => ({ C, B, A });
  const { draft: box } = builderPress('box', null, { cell: [10, 0, 10] });
  const { draft } = builderPress('box', box);
  const origin = [0.5, 11.5, 10.5], dir = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  const up = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const initial = ray(origin, dir);
  const guide = builderExtrudeGuide(draft, initial, dir, up);
  assert.equal(builderExtrudeDepth(draft, guide, initial, dir), 0);
  assert.equal(builderExtrudeDepth(draft, guide, ray(origin, [1, -0.5, 0]), [1, -0.5, 0]), 5);
  assert.deepEqual(builderPlanePoint(ray([1, 3, 1], [0, -3, 1], [0, 1, 0]), 1, 1), [1, 1, 2]);
  const headOn = ray([10.5, 12, 10.5], [0, -1, 0]);
  const fallback = builderExtrudeGuide(draft, headOn, headOn.B, [0, 0, 1]);
  assert.equal(builderExtrudeDepth(draft, fallback, headOn, headOn.B), 0);
  assert(builderExtrudeDepth(draft, fallback, headOn, [0, -0.8, 0.6]) > 5);
});

test('preview snaps and clamps footprint and extrusion to world-space voxel bounds', () => {
  const lo = [96, 0, 64], hi = [128, 32, 96];
  const { draft } = builderPress('box', null, { cell: [97, 18, 65], face: 1 });
  const b = previewBuilder(draft, { point: [72.45, -10.1, 97.6] }, lo, hi);
  assert.deepEqual(b.end, [96, 0, 95]);
  const { draft: frozen } = builderPress('box', b);
  assert.equal(previewBuilder(frozen, { depth: 90 }, lo, hi).depth, 0, 'never extrudes past a map wall');
  assert.equal(previewBuilder(frozen, { depth: -3 }, lo, hi).depth, 0, 'reverse aim does not cross the footprint');
});

test('hollow skips every interior voxel; shell thickness is exact even on thin boxes', () => {
  const b = boxFromCorners([1, 2, 3], [8, 8, 12], 2);
  for (const thickness of [0, 1, 2, 3, 4]) {
    let count = 0;
    for (let x = 0; x <= 9; x++) for (let y = 1; y <= 9; y++) for (let z = 2; z <= 13; z++) {
      const p = [x, y, z];
      // Twin of the production metric: resolve the outer and inner tests in shader terms.
      const d = p.map((v, i) => Math.abs(v + 0.5 - b.center[i]));
      const outer = Math.max(...d.map((v, i) => Math.max(v - b.grow[i], 0))) <= 2;
      const face = Math.min(...d.map((v, i) => 2 + b.grow[i] - v));
      const covered = boxContains(b, p, thickness);
      assert.equal(covered, outer && (!thickness || face <= thickness));
      count += Number(covered);
    }
    const [w, h, d] = b.size;
    assert.equal(count, thickness === 0 ? w*h*d : w*h*d - b.size.reduce((n, v) => n * Math.max(0, v - 2*thickness), 1));
  }
  assert.equal(boxShellThickness(0.49), 1);
  assert.equal(boxShellThickness(2.51), 3);
  assert(boxContains(boxFromCorners([1, 2, 3], [1, 5, 7], 2), [1, 4, 5], 2));
});

test('axis snap uses the dominant X/Y/Z in either direction and minimum brush is one voxel', () => {
  const a = [12, 20, 30];
  assert.deepEqual(snapLine(a, [2, 28, 39]), [2, 20, 30]);
  assert.deepEqual(snapLine(a, [13, 32, 23]), [12, 32, 30]);
  assert.deepEqual(snapLine(a, [7, 23, 14]), [12, 20, 14]);
  assert.deepEqual(snapLine(a, [13, 21, 31]), [13, 20, 30], 'ties stay deterministic');
  assert.deepEqual(snapLine(a, a), a);
  const { draft } = builderPress('line', null, { cell: a, face: 2 });
  assert.deepEqual(previewBuilder(draft, { point: [2.9, 22.1, 32.1] }, zero, dims).end, [2, 21, 30]);
  assert.equal(lineRadius(1), 0.5);
  for (const r of [1, 2, 3]) assert.equal(2 * Math.floor(lineRadius(r)) + 1, 2*r - 1);
});

test('Tool Gun input: cycle, freehand fallback, line commit, box extrude, carve, cancel', () => {
  const modes = ['freehand', 'line', 'box', 'hollow', 'freehand'];
  assert.deepEqual(modes.slice(0, -1).map(nextBuilderMode), modes.slice(1));
  for (const secondary of [false, true]) assert.equal(builderPress('freehand', null, { secondary }).action, 'freehand');
  assert.equal(builderPress('line', null).action, 'ignore');
  const line = builderPress('line', null, { cell: coords });
  assert.equal(line.action, 'start');
  assert.equal(builderPress('line', line.draft).action, 'commit');
  assert.equal(builderPress('line', line.draft, { secondary: true }).action, 'cancel');
  const box = builderPress('box', null, { cell: coords });
  assert.equal(box.action, 'start');
  const extrude = builderPress('box', box.draft);
  assert.equal(extrude.action, 'extrude');
  assert.equal(builderBox(extrude.draft, 24).size[1], 1, 'no aim motion commits a one-cell panel');
  assert.equal(builderPress('box', extrude.draft, { secondary: true }).action, 'cancel');
  assert.equal(builderPress('box', extrude.draft).action, 'commit');
  assert.deepEqual(builderPress('hollow', null, { cell: coords, secondary: true }),
    builderPress('hollow', null, { cell: coords, carve: true }), 'dedicated eraser and RMB start the same solid cut');
  assert.match(builderNote({ mode: 'Hollow Box', size: [12, 8, 10], radius: 2, hollow: true, phase: 'extrude' }), /12×8×10 · \[HOLLOW\] · Brush 2/);
});

test('builder bindings do not collide with typed, physical, or modified keys', () => {
  for (const name of ['builderMode', 'builderHollow', 'brushSmaller', 'brushBigger']) {
    const key = KEYS[name][0];
    const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key === '[' ? 'BracketLeft' : 'BracketRight';
    for (const field of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey', null]) {
      const e = { key: field === 'shiftKey' ? key.toUpperCase() : key, code, [field]: true };
      if (field === null) assert(is(e, KEYS[name]));
      assert.deepEqual(Object.entries(KEYS).filter(([other, binding]) => other !== name && is(e, binding)).map(([other]) => other), []);
    }
  }
});

test('World finds a reachable aligned window for a whole shape in one undo', () => {
  const win = Object.create(WorldWindow.prototype);
  win.size = [256, 64, 256];
  win.sim = { origin: { x: 64, y: 0, z: 64 }, g: { nx: 64, ny: 64, nz: 64 } };
  for (const lo of [0, 1, 15, 16, 17, 96, 160, 200, 240]) for (const span of [2, 10, 60, 64, 65]) {
    const hi = Math.min(256, lo + span);
    const reachable = Array.from({ length: 13 }, (_, i) => i * 16).some(at => lo >= at && hi <= at + 64);
    const focus = win.focusForBounds([lo, 0, lo], [hi, 64, hi]);
    assert.equal(focus !== null, reachable, `${lo}..${hi}`);
    if (!focus) continue;
    const at = win.goalFor(...focus);
    assert(at[0] <= lo && at[2] <= lo && hi <= at[0] + 64 && hi <= at[2] + 64);
  }
});

test('guest shell and one-voxel line reach the host with their original parameters', () => {
  const stroke = { t: PAINT_SHELL, c: [12, 8, 8], g: [4, 2, 3], h: 2, r: 2, shape: 1, tool: E.GLASS, rate: 1 };
  assert(validPaintShell(stroke, 24));
  for (const invalid of [{ h: 0 }, { h: 2.5 }, { h: 25 }, { t: 'paint' }, { shape: 0 }, { e: [1, 1, 1] }, { g: null }])
    assert(!validPaintShell({ ...stroke, ...invalid }, 24));
  const recorded = [];
  const legacy = { paints: 0, touchCentres: Simulation.prototype.touchCentres, passes: { paint: {} }, edit: (_, box, params) => recorded.push({ box, params }) };
  legacy.paint = s => Simulation.prototype.paint.call(legacy, s);
  applyGuestStroke(legacy, stroke, { edits: { grow: stroke.g } });
  assert.equal(recorded[0].params.shell, 2);
  assert.deepEqual(recorded[0].params.grow, stroke.g);
  const line = { ...stroke, t: 'paint', h: undefined, r: 0.5, shape: 0 };
  assert(validPaintShell(line, 24));
  applyGuestStroke(legacy, line, { edits: { end: { x: 4.5, y: 8, z: 8 } } });
  assert.equal(recorded[1].params.radius, 0.5);
  assert.equal(recorded[1].params.shell, 0);
});

test('changed V1 paint/Mix and brush preview WGSL validate in CPU Naga', () => {
  assertNaga(brushWGSL(), 'brush preview');
  for (const dims of [[64, 64, 64], [128, 384, 128]]) {
    const g = gridLayout(...dims);
    assertNaga(paintKernelWGSL(g), `paint ${dims}`);
    assertNaga(paintKernelWGSL(g, { reads: 'neighbours' }), `paintMix ${dims}`);
  }
});
