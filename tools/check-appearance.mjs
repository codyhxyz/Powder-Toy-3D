// CPU-only codecs, real WGSL artwork, physics twin and ordered console edits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E, ELEMENTS } from '../src/elements.js';
import { Appearance as A, appearanceOf, appearanceCtype, physicalCtype, materialWord } from '../src/appearance.js';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { cozyFixture } from './cozy-fixture.mjs';
import { ScriptWorld, EDIT } from '../src/console/world.js';

const families = [
  [E.PLANT, A.GRASS], [E.PLANT, A.LEAVES], [E.PLANT, A.PLAIN],
  [E.MOSS, A.LEAVES],
  ...[A.LOG_X, A.LOG_Y, A.LOG_Z, A.PLANK_X, A.PLANK_Y, A.PLANK_Z, A.BARK, A.PLAIN].map(a => [E.WOOD, a]),
];
const cases = families.flatMap(([id, ap]) => {
  const damp = id === E.MOSS ? [0, 1, 2, 3, 4] : [0];
  return damp.map(d => [id, appearanceCtype(id, d, ap) + 0.375, ap, d]);
});
for (const [id, ctype, ap, damp] of cases) {
  assert.equal(appearanceOf(id, ctype), ap);
  assert.equal(physicalCtype(id, ctype), damp);
  assert.equal(appearanceCtype(id, ctype, A.NONE), damp);
  for (let i = 0; i < 1024; i++) {
    const raw = Math.fround(Math.floor(ctype) + i / 1024 * 0.999);
    assert.equal(Math.floor(raw), Math.floor(ctype), 'Float32 seed never carries into ctype');
    assert.equal(appearanceOf(id, raw), ap);
  }
}
for (const id of [E.EMPTY, E.FIRE, E.ASH, E.SAWDUST, E.CLONE, E.FUNGUS, E.METAL]) {
  for (const ctype of [0, 4, 58, 224, 228, 244, 250, 255]) {
    assert.equal(appearanceOf(id, ctype), A.NONE, 'markers are strictly element-scoped');
    assert.equal(physicalCtype(id, ctype), ctype);
  }
}
assert.throws(() => appearanceCtype(E.WOOD, 1, A.LOG_Y));
assert.throws(() => appearanceCtype(E.PLANT, 0, A.PLANK_Y));
assert.throws(() => appearanceCtype(E.MOSS, 5, A.LEAVES));
assert.equal(appearanceOf(E.MOSS, 5), A.NONE);
for (const name of ['povBore', 'povKick', 'povTools', 'povTrace']) {
  const code = readFileSync(new URL(`../src/shaders/${name}.js`, import.meta.url), 'utf8');
  const breakWrites = [...code.matchAll(/\(\*oA\)\.x = f32\(into\);/g)];
  assert(breakWrites.length, `${name} must exercise a debris writer`);
  for (const match of breakWrites) {
    // Laser's noncombustible rim cannot match these eligible, ignitable solids.
    if (name === 'povBore' && code.slice(match.index - 150, match.index).includes('IGNITE(id) <= 0.0')) continue;
    assert.match(code.slice(match.index, match.index + 110), /physicalCtype\(id, a\.w\) \+ fract\(a\.w\)/, `${name} debris strips appearance`);
  }
}

const input = new Float32Array(cases.flat()), output = new Float32Array(input.length);
const codec = `${cozyFixture}
@group(0) @binding(0) var<storage, read> input: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let v = input[gid.x]; let id = i32(v.x); let ap = i32(v.z);
  output[gid.x] = vec4f(f32(appearanceOf(id, v.y)), physicalCtype(id, v.y),
    appearanceCtype(id, physicalCtype(id, v.y), ap), f32(materialWord(id, ap)));
}`;
new WgslExec(new WgslParser().parse(codec)).dispatchWorkgroups('main', cases.length, { 0: { 0: input, 1: output } });
for (let i = 0; i < cases.length; i++) {
  const [id, ctype, ap, d] = cases[i];
  assert.deepEqual([...output.subarray(i * 4, i * 4 + 4)], [ap, d, Math.floor(ctype), materialWord(id, ap)]);
}

// Independent expected projection: role comes from authoring, not the face.
const roles = families.map(([id, ap]) => `vec2i(${id}, ${ap})`).join(', ');
const artwork = `${cozyFixture}
@group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let roles = array<vec2i, ${families.length}>(${roles});
  let normals = array<vec3f, 6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1));
  let j = gid.x; let role = roles[j % ${families.length}u]; let id = role.x; let ap = role.y;
  let n = normals[(j / ${families.length}u) % 6u];
  let p = vec3f(1.17, 2.31, -0.81) + f32(j / ${families.length * 6}u) * vec3f(1.43,0.71,2.13);
  let fp = 0.005; let pixel = fp * CELL_M; var q = p * CELL_M; var qn = n;
  var expected = vec3f(1.0);
  if (ap != AP_PLAIN) {
    if (id == E_WOOD) {
      if (ap == AP_LOG_X || ap == AP_PLANK_X) { q = q.yxz; qn = n.yxz; }
      if (ap == AP_LOG_Z || ap == AP_PLANK_Z) { q = q.xzy; qn = n.xzy; }
      var uv = q.xy;
      if (abs(qn.x) > 0.5) { uv = q.zy; }
      if (abs(qn.y) > 0.5) { uv = q.xz; }
      if (ap >= AP_PLANK_X && ap <= AP_PLANK_Z) { expected = cozyPlanks(uv, pixel); }
      else if (ap != AP_BARK && abs(qn.y) > 0.5) { expected = cozyRings(q.xz, pixel); }
      else { expected = cozyWood(uv, pixel); }
    } else {
      var uv = q.xy;
      if (abs(n.x) > 0.5) { uv = q.zy; }
      if (abs(n.y) > 0.5) { uv = q.xz; }
      expected = cozyPlant(uv, pixel, ap == AP_GRASS);
    }
  }
  expected *= matBase(id).alb;
  let actual = cozyMat(id, p, n, 20.0, appearanceCtype(id,0.0,ap), fp);
  output[j] = vec4f(abs(actual.alb - expected), select(0.0,1.0,cozySupported(id,appearanceCtype(id,0.0,ap))));
}`;
const n = families.length * 6 * 3, paints = new Float32Array(n * 4);
new WgslExec(new WgslParser().parse(artwork)).dispatchWorkgroups('main', n, { 0: { 0: paints } });
for (let i = 0; i < n; i++) {
  assert([...paints.subarray(i * 4, i * 4 + 3)].every(x => Number.isFinite(x) && x < 1e-5), `authored projection ${i}`);
  assert.equal(paints[i * 4 + 3], 1);
}

// A deterministic physics twin: compare wet/dry cedar with ordinary moss.
const oldRandom = Math.random;
let TileWorld;
try { Math.random = () => 0.5; ({ World: TileWorld } = await import('../src/ui/tiles/engine.js')); }
finally { Math.random = oldRandom; }
for (const T of [20, 100]) for (const damp of [0, 1, 4]) {
  const bare = new TileWorld(8, 8), tagged = new TileWorld(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bare.put(x, y, E.MOSS, { T, ctype: damp, seed: 0.375 });
    tagged.put(x, y, E.MOSS, { T, ctype: appearanceCtype(E.MOSS, damp, A.LEAVES), seed: 0.375 });
  }
  for (let step = 0; step < 3; step++) {
    bare.react(); tagged.react();
    for (const f of ['id', 'T', 'life', 'vx', 'vy', 'P']) assert.deepEqual(tagged[f], bare[f], `cedar physics ${f}`);
    for (let i = 0; i < bare.id.length; i++) {
      assert.equal(physicalCtype(tagged.id[i], tagged.ctype[i]), bare.ctype[i]);
      assert.equal(appearanceOf(tagged.id[i], tagged.ctype[i]), A.LEAVES);
    }
  }
}
for (const [id, ap] of [[E.WOOD, A.LOG_Y], [E.PLANT, A.LEAVES], [E.MOSS, A.LEAVES]]) {
  const w = new TileWorld(8, 8);
  w.put(3, 3, id, { T: 2000, life: 0, ctype: appearanceCtype(id, 0, ap) });
  w.react();
  const i = w.idx(3, 3);
  assert.notEqual(w.id[i], id, 'burning actually converted the marked cell');
  assert(w.ctype[i] < ELEMENTS.length, 'appearance never becomes an invalid clone subtype in debris/fire');
}

// Real queued edit merging: an intermediate conversion must clear the label,
// even when a subsequent edit restores the original physical element.
for (const edits of [
  [[EDIT.TYPE, { type: E.FIRE }], [EDIT.TYPE, { type: E.WOOD }]],
  [[EDIT.CTYPE, { ctype: appearanceCtype(E.WOOD, 0, A.LOG_Y) }], [EDIT.TYPE, { type: E.FIRE }]],
]) {
  const backend = { epoch: () => 'test', size: () => [1, 1, 1], locate: () => [0, 0], applyEdits() {} };
  const world = new ScriptWorld(backend);
  const block = { a: new Float32Array([E.WOOD, 20, 1, appearanceCtype(E.WOOD, 0, A.LOG_Y) + 0.375]), b: new Float32Array(4) };
  world.blocks.set(0, block);
  for (const [mask, values] of edits) world.edit(0, 0, 0, mask, values);
  world.flush();
  assert.equal(Math.floor(block.a[3]), 0);
  assert.equal(world.passes, 2, 'noncommuting edits execute in order');
}
console.log(`appearance: codecs, ${n} real WGSL face/axis projections, cedar physics, conversions and edit order OK`);
