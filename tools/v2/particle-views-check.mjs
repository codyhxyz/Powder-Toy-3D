// CPU only (no device, no browser): V2's airborne matter takes each view's look and is
// pickable (R4). Under V1 a flying cell is a grid cell: every view colours it as it colours
// its element, the sun map and the pick find it. These checks pin the particle shader's
// per-view look to the volume modules that define each view (same constants, same
// colormaps, same brick numbering), and drive gfx/nativeParticles.js's binding and pick
// recording on a fake device. Each fails with R4 reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Matrix4, PerspectiveCamera, WebGPUCoordinateSystem } from 'three';
import { gridLayout } from '../../src/sim.js';
import { prelude, STATE_OPTS } from '../../src/shaders/common.js';
import { volumeFrag, pickFrag, PICK_BATCH, colormapWGSL } from '../../src/shaders/render.js';
import { noitaSurfaceWGSL } from '../../src/shaders/gfx/noita.js';
import { COLORMAPS, VIEWS, isMaterialView } from '../../src/views.js';
import { ELEMENTS } from '../../src/elements.js';
import {
  nativeParticleWGSL, particlePickWGSL, particleAirWGSL, PICK_RAYS, NativeParticleParams, ParticlePickParams,
} from '../../src/shaders/v2/particleRender.js';
import { DATA_CONSTANTS, DATA_VEC3_CONSTANTS, NOITA_CONSTANTS, PARTICLE_VIEW, xrayMuOf, V1_CELLS_PER_STEP_MS } from '../../src/shaders/v2/particleViews.js';
import { NativeParticles } from '../../src/gfx/nativeParticles.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(16, 16, 16);
const constOf = (code, name) => {
  const m = code.match(new RegExp(`const ${name}: (f32|vec3f|i32) = ([^;]+);`));
  assert(m, `${name} defined`);
  return m[1] === 'vec3f' ? m[2].match(/[-\d.e]+/g).slice(1).map(Number) : Number(m[2]);
};
const matter = nativeParticleWGSL(false), rays = nativeParticleWGSL(true);

test('every data-view, Noita and pick constant is the volume module\'s own', () => {
  const views = Object.fromEntries(['heat', 'pressure', 'flow', 'xray'].map((v) => [v, volumeFrag(g, { view: v, fixedReadFormat: 2 })]));
  const all = Object.values(views).join('\n');
  for (const [name, value] of Object.entries(DATA_CONSTANTS)) assert.equal(constOf(all, name), value, name);
  for (const [name, value] of Object.entries(DATA_VEC3_CONSTANTS)) {
    const m = all.match(new RegExp(`const ${name}: vec3f = vec3f\\(([^)]+)\\);`));
    assert(m, name);
    const xs = m[1].split(',').map(Number);
    assert.deepEqual(xs.length === 1 ? [xs[0], xs[0], xs[0]] : xs, value, name);
  }
  for (const [name, value] of Object.entries(NOITA_CONSTANTS)) assert.equal(constOf(noitaSurfaceWGSL, name), value, name);
  // render.js xrayMu: the same attenuation per element
  const mu = views.xray.match(/fn XRAY_MU\(id: i32\) -> f32 \{([\s\S]*?)\n\}/)[1];
  for (const e of ELEMENTS) {
    const row = mu.split('\n').find((l) => new RegExp(`\\bE_${e.key}\\b`).test(l));
    assert.equal(row ? Number(row.match(/return ([-\d.e]+);/)[1]) : 0, xrayMuOf(e), e.key);
  }
  assert.equal(PICK_RAYS, PICK_BATCH);
  assert.match(pickFrag(g), /const PICK_FACE_FLOOR: i32 = 2;/);
  for (const name of ['heat', 'pressure', 'flowDir', 'flowSpeed']) assert(matter.includes(colormapWGSL(name, COLORMAPS[name])), `the ${name} colormap`);
});

test('the per-view look: data views and Plain draw a cube, Noita its look, Realistic/Cozy/Test the sphere', () => {
  for (const v of VIEWS) {
    const blocky = ['heat', 'pressure', 'flow', 'xray', 'plain'].includes(v.key);
    assert.equal(blocky, !isMaterialView(v.key), `${v.key}: cube iff not a material view`);
    if (blocky) assert.equal(PARTICLE_VIEW[v.key.toUpperCase()], v.id);
  }
  assert.match(matter, /fn blockyView\(v: i32\) -> bool \{ return isDataView\(v\) \|\| v == VIEW_PLAIN; \}/);
  assert.match(matter, /if \(blockyView\(FU\.view\)\) \{ o\.radius = o\.half \* sqrt\(3\.0\); \}/, 'the quad bounds the cube');
  assert.match(matter, /if \(blockyView\(FU\.view\)\) \{ return blockyFragment\(o, eye, direction\); \}/);
  assert.match(matter, /look = dataLook\(FU\.view, id, o\.core, n, seg, blob, T, particleAirAt\(o\.center\)\.w, o\.vel, cue\);/);
  assert.match(matter, /look = plainLook\(id, side, n, T,/);
  assert.match(matter, /o\.color = heatColor\(T\) \* mix\(1\.0, viewClay\(n\), HEAT_CLAY\);/, 'Heat: render.js marchHeat\'s solid');
  assert.match(matter, /o\.color = mix\(viewNeutral\(id\), pressureColor\(P\), smoothstep\(PRESSURE_PAINT_LO, PRESSURE_PAINT_HI, sm\)\) \* viewClay\(n\);/);
  assert.match(matter, /o\.color = flowTint\(still, v, flowSpeedPos\(length\(v\)\)\) \* viewClay\(n\);/);
  assert.match(matter, /o\.vel = bitcast<vec3f>\(p\.velocityCore\.xyz\) \/ V1_CELLS_PER_STEP_MS;/, 'velocity in V1 cells per step');
  assert.equal(V1_CELLS_PER_STEP_MS, 0.3 * 240);
  assert.match(matter, /if \(FU\.materialStyle == NOITA_STYLE && LOOK_CLASS\[id\]\.y == 1u && VIEW_NOITA\[id\]\.w > 0\.0\)/);
  // the realistic look is untouched: its paint and sphere stay
  assert.match(matter, /diffuse = mix\(diffuse, decoLinear\(paint\.rgb\), paint\.a\)/);
  assert(!rays.includes('dataLook'), 'photons and neutrons keep the ray layer\'s sprites');
  for (const [code, name] of [[matter, 'matter'], [rays, 'rays'], [particlePickWGSL(), 'pick']]) assertNaga(code, name);
});

test('the particle\'s air is its brick\'s, numbered as shaders/common.js brickId numbers it', () => {
  const ro = prelude(g, STATE_OPTS.STATE_RO);
  assert(ro.includes('let st = s.x + STX * (s.z + STZ * s.y);') && ro.includes('return u32(st * 16 + k.x + 4 * (k.z + 2 * k.y));'));
  assert(particleAirWGSL.includes('let st = s.x + i32(P.supers.x) * (s.z + i32(P.supers.y) * s.y);'));
  assert(particleAirWGSL.includes('particleAir[u32(st * 16 + k.x + 4 * (k.z + 2 * k.y)) * 2u]'));
  assert(particleAirWGSL.includes('return vec4f(air.xyz / V1_CELLS_PER_STEP_MS, air.w / LEGACY_PRESSURE_PA);'), 'shaders/common.js fetchBs format 3\'s units');
  for (const s of [NativeParticleParams, ParticlePickParams]) assert(['grid', 'supers'].every((k) => s.wgsl.includes(`${k}: vec4u`)));
  assert.match(readFileSync(new URL('../../src/shaders/common.js', import.meta.url), 'utf8'), /air\.xyz \/ \$\{240 \* CELL_M\}, air\.w \/ \$\{LEGACY_PRESSURE_PA\}/);
});

// a fake device as particle-render-check's
const buffer = (size) => ({ size, words: new Uint32Array(Math.max(4, size / 4)), destroy() {} });
function fake() {
  globalThis.GPUBufferUsage ??= { STORAGE: 128, INDIRECT: 256 };
  const calls = [];
  const gpu = { frame: {}, _frameUniforms: { layout: {}, group: { fu: true } }, layout: (_n, l) => l, bindGroup: (l, entries) => ({ l, entries }),
    createBuffer: (d) => buffer(d.size), flush() {},
    renderPipeline: (d) => ({ state: 'ready', ready: Promise.resolve(), draw: (_rp, o) => calls.push({ kind: 'draw', name: d.name, o }) }),
    kernel: (d) => ({ state: 'ready', ready: Promise.resolve(), desc: d, dispatch: (frame, n, o) => calls.push({ kind: 'kernel', name: d.name, n, o }) }) };
  const air = [buffer(32 * 64), buffer(32 * 64)];
  const source = { isIdle: false, active: true, airIndex: 0, air, g: gridLayout(16, 16, 16), attachDrawAdapter(a) { this.drawAdapter = a; }, ready: Promise.resolve(),
    particles: buffer(65536 * 48), control: buffer(16),
    get renderState() { return { version: 1, particleBytes: 48, capacity: 65536, position: 'world cells', particleIdOffset: 12, bankOffset: 44, liveCountOffset: 0,
      coreOffsets: [28, 32, 36, 40], particles: this.particles, control: this.control, ready: true }; } };
  const view = new NativeParticles(gpu, source);
  const camera = new PerspectiveCamera(55, 1, 0.1, 100); camera.coordinateSystem = WebGPUCoordinateSystem; camera.position.set(0, 0, 10); camera.updateMatrixWorld();
  view.updateView(camera, 720, new Matrix4(), [0, 0, 0]);
  return { gpu, source, view, calls, air };
}

test('the draw binds the current coarse air with its grid; a source without air binds still air', () => {
  const { gpu, source, view, calls, air } = fake();
  view.prepareDraw();
  view.draw({ frame: gpu.frame }, { width: 1, height: 1 });
  let d = calls.filter((c) => c.kind === 'draw').at(-1).o;
  assert.equal(d.bind.length, 3);
  assert.equal(d.bind[2].entries[0].resource.buffer, air[0]);
  assert.deepEqual(d.params.grid, [16, 16, 16, 1]);
  assert.deepEqual(d.params.supers, [source.g.stx, source.g.stz, 0, 0]);
  source.airIndex = 1; view.draw({ frame: gpu.frame }, { width: 1, height: 1 });
  d = calls.filter((c) => c.kind === 'draw').at(-1).o;
  assert.equal(d.bind[2].entries[0].resource.buffer, air[1], 'the air the last tick wrote');
  delete source.air; view.draw({ frame: gpu.frame }, { width: 1, height: 1 });
  d = calls.filter((c) => c.kind === 'draw').at(-1).o;
  assert.equal(d.bind[2].entries[0].resource.buffer, source.particles);
  assert.equal(d.params.grid[3], 0, 'grid.w 0: never read');
});

test('the pick records the particle pass after the grid\'s, into the same ring', () => {
  const { gpu, view, calls, air } = fake();
  const ring = buffer(4096);
  const rays = { ring, ro: [[1, 2, 3, 0]], rd: [[0, 0, -1, 0]], slot: [[5, 0, 0, 0], [0, 0, 0, 0]], n: 1, origin: { x: 32, y: 0, z: -16 } };
  assert.equal(view.recordPick(gpu.frame, rays), true);
  const k = calls.at(-1);
  assert.equal(k.name, 'nativeParticlePick');
  assert.deepEqual(k.n, [1, 1, 1]);
  assert.equal(k.o.bind[1].entries[1].resource.buffer, ring);
  assert.equal(k.o.bind[2].entries[0].resource.buffer, air[0]);
  assert.deepEqual(k.o.params.origin, [32, 0, -16]);
  assert.equal(k.o.params.capacity, 65536);
  view.source.isIdle = true;
  assert.equal(view.recordPick(gpu.frame, rays), false, 'nothing flies: no pass');
  // the volume calls it after its own pick (gfx/volume.js recordPicks)
  assert.match(readFileSync(new URL('../../src/gfx/volume.js', import.meta.url), 'utf8'),
    /pickKernel\.dispatch\([\s\S]*?sim\.compact\?\.dynamics\?\.drawAdapter\?\.recordPick\?\.\(gpu\.frame, \{ ring: pickRing\.buffer, \.\.\.rays, origin: sim\.origin \}\);/);
  const pick = particlePickWGSL();
  assert.match(pick, /if \(t < 0\.0 \|\| t >= tGrid\) \{ return; \}/, 'only nearer than the grid\'s hit');
  assert.match(pick, /picks\[s \+ 1u\] = vec4f\(f32\(id\), temperature\(id, core\.x\), particleAirAt\(c\)\.w, particleLife\(id, core\)\);/);
  assert.match(pick, /if \(kind == 4u \|\| \(skipLiquids && kind == 3u\)\) \{ return -1\.0; \}/, 'render.js pickStops');
});

test('the World pick finds flying matter too, in world cells, after its grid pick', () => {
  const { gpu, view, calls } = fake();
  // World's one-pick output (wire/worldPick.js): its rays and cells are world cells, so the pass shifts
  // the window's cells by its origin, and its group isn't kept for a buffer the pick destroys
  const output = buffer(32), origin = { x: 512, y: 0, z: -256 };
  const rays = { ring: output, ro: [[520, 9, -250, 0]], rd: [[0, -1, 0, 0]], slot: [[0, 0, 0, 0], [0, 0, 0, 0]], n: 1, origin, shift: [512, 0, -256], transient: true };
  assert.equal(view.recordPick(gpu.frame, rays), true);
  const k = calls.at(-1);
  assert.equal(k.o.bind[1].entries[1].resource.buffer, output);
  assert.deepEqual([k.o.params.origin, k.o.params.shift], [[512, 0, -256], [512, 0, -256]]);
  assert.equal(view.pickGroups.has(output), false, 'a transient output keeps no group');
  // the Box pick's default: no shift
  view.recordPick(gpu.frame, { ...rays, ring: buffer(4096), shift: undefined, transient: false });
  assert.deepEqual(calls.at(-1).o.params.shift, [0, 0, 0]);
  const src = readFileSync(new URL('../../src/wire/worldPick.js', import.meta.url), 'utf8');
  assert.match(src, /native\.recordPickReady\(gpu\.frame,\{params,output,view:view\.view\}\)\)throw[^\n]*\n[\s\S]*?sim\.compact\?\.dynamics\?\.drawAdapter\?\.recordPick\?\.\(gpu\.frame,\{ring:output,ro:params\.ro,rd:params\.rd,slot:params\.slot,n:1,\s*origin:o,shift:\[o\.x,o\.y,o\.z\],transient:true\}\);[\s\S]*?copyBufferToBuffer\(output,/,
    'after the grid\'s pick, into its output, before the output is copied out');
  const pick = particlePickWGSL();
  assert.match(pick, /let c = bitcast<vec3f>\(p\.positionId\.xyz\) - P\.origin \+ P\.shift;/, 'the hit test in the rays\' frame');
  assert.match(pick, /let cell = clamp\(vec3i\(floor\(c\)\), vec3i\(0\), vec3i\(P\.grid\.xyz\) - 1\) \+ vec3i\(P\.shift\);/, 'its cell in the rays\' frame');
  assert.match(pick, /if \(at\.w < -1\.5\) \{ return; \}/, 'World\'s incomplete grid pick (face -2) stays incomplete');
  assert(ParticlePickParams.wgsl.includes('shift: vec3f'));
});
