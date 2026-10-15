// CPU-only: node tools/check-far-appearance.mjs
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../src/elements.js';
import { readFileSync } from 'node:fs';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { cozyFixture } from './cozy-fixture.mjs';
import { Appearance as A, appearanceCtype, appearanceOf, materialWord, materialId, materialAppearance } from '../src/appearance.js';
import { packFarTexel, unpackFarTexel, packFarSceneCell, unpackFarSceneCell, dominantFarMaterial, farLayout, farLayoutGLSL } from '../src/shaders/farShared.js';
import { buildSurfaceMesh, meshPadding } from '../src/world/surfaceMesh.js';
import { encodeBrick, decodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { structureData, structureWords, structureMaterialAt, structureCellAt } from '../src/world/structures.js';

for (let appearance = 0; appearance <= A.BARK; appearance++) {
  const f = { s: 255, l: 254, glow: 253, id: 255, liquid: 252, open: true, appearance };
  const packed = packFarTexel(f);
  assert.deepEqual(unpackFarTexel(packed), f);
  assert.equal(packed[0], 511); assert.equal(packed[1], 254);
  assert.equal(packed[3], 253 | (252 << 8));
}
assert.equal(unpackFarTexel(packFarTexel({ s: 0, l: 0, glow: 0, id: E.WOOD, liquid: 0, open: false })).appearance, A.NONE);
for (const [id, a] of [[E.WOOD, A.LOG_X], [E.WOOD, A.LOG_Y], [E.WOOD, A.LOG_Z], [E.WOOD, A.PLANK_Z], [E.WOOD, A.BARK], [E.PLANT, A.GRASS], [E.PLANT, A.LEAVES], [E.PLANT, A.PLAIN], [E.MOSS, A.LEAVES], [E.ROCK, A.NONE]]) {
  const ctype = appearanceCtype(id, id === E.MOSS ? 4 : 0, a);
  assert.deepEqual(unpackFarSceneCell(packFarSceneCell(id, -12.5, ctype + 0.375)), { id, appearance: a, temperature: -12.5 });
}
const winner = dominantFarMaterial([
  { id: E.WOOD, appearance: A.LOG_X, weight: 4 },
  { id: E.WOOD, appearance: A.PLANK_Z, weight: 4 },
  { id: E.PLANT, appearance: A.GRASS, weight: 7 },
]);
assert.equal(materialId(winner), E.WOOD);
assert.equal(materialAppearance(winner), A.LOG_X);
assert.equal(dominantFarMaterial([{ id: E.WOOD, appearance: A.BARK, weight: 1 }, { id: E.WOOD, appearance: A.NONE, weight: 8 }]), E.WOOD);

// Execute production counting/election. Observe its two integer winners before
// packing: wgsl_reflect cannot pass a struct bool to select(). Packing is
// covered separately above and by the generated production Naga checks.
const countCode = readFileSync(new URL('../src/shaders/far.js', import.meta.url), 'utf8').match(/const countGLSL = \/\* wgsl \*\/ `([\s\S]*?)`;/)[1];
assert(!countCode.includes('${'), 'expand interpolated counting code before using this fixture');
const votes = [
  [[E.WOOD, A.LOG_X, 4], [E.WOOD, A.PLANK_Z, 4], [E.PLANT, A.GRASS, 7]],
  [[E.PLANT, A.GRASS, 8], [E.PLANT, A.LEAVES, 8], [E.WOOD, A.LOG_Y, 15]],
  [[E.MOSS, A.LEAVES, 5], [E.MOSS, A.NONE, 6]],
  [[E.WOOD, A.BARK, 20], [E.WOOD, A.LOG_Y, 3]],
];
const inputs = new Float32Array(votes.flatMap((vs, group) => vs.flatMap(v => [...v, group])));
const counted = new Float32Array(votes.length * 4);
const voteCode = `${cozyFixture}
${farLayoutGLSL(farLayout([32,32,32]))}
const NE: i32 = ${ELEMENTS.length};
const INCAND_T0: f32 = 0.0; // unused: the fixture votes directly, with no heat
fn KIND(id: i32) -> i32 { ${ELEMENTS.map((e, id) => `if(id == ${id}){return ${e.kind};}`).join('')} return 0; }
fn isGasLike(id: i32) -> bool { return id == E_EMPTY || KIND(id) == ${K.GAS}; }
${countCode.replace('return farPackTexel(f);', 'return vec4u(u32(f.id), u32(f.appearance), 0u, 0u);')}
@group(0) @binding(0) var<storage, read> votes: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  var c: FarCount;
  for(var i=0u;i<${inputs.length / 4}u;i++) {
    let v=votes[i]; if(u32(v.w)==gid.x){farVote(&c,i32(v.x),i32(v.y),v.z);}
  }
  result[gid.x]=vec4f(farPack(&c));
}`;
try {
  new WgslExec(new WgslParser().parse(voteCode)).dispatchWorkgroups('main', votes.length, { 0: { 0: inputs, 1: counted } });
} catch (err) {
  const line = Number(err.message.match(/Line (\d+)/)?.[1]);
  throw new Error(`${err.message}: ${voteCode.split('\n')[line - 1]}`, { cause: undefined });
}
votes.forEach((vs, i) => {
  const word = dominantFarMaterial(vs.map(([id, appearance, weight]) => ({ id, appearance, weight })));
  assert.deepEqual([...counted.subarray(i * 4, i * 4 + 4)], [materialId(word), materialAppearance(word), 0, 0]);
});

const state = new Float32Array(BRICK_FLOATS), velocity = new Float32Array(BRICK_FLOATS);
state.set([E.MOSS, 20, 0, appearanceCtype(E.MOSS, 4, A.LEAVES) + 0.375]);
const restored = new Float32Array(BRICK_FLOATS), restoredB = new Float32Array(BRICK_FLOATS);
decodeBrick(encodeBrick(state, 0, velocity, 0), restored, 0, restoredB, 0);
assert.deepEqual(restored, state); assert.equal(appearanceOf(restored[0], restored[3]), A.LEAVES);

// Geometry and normals stay identical; every coarse donor retains its label.
for (const step of [1, 2, 4]) {
  const pad = meshPadding(step), side = 8 + 2 * pad, size = [side, side, side], origin = [-pad, -pad, -pad], bounds = [0, 0, 0, 8, 8, 8];
  const ids = new Uint8Array(side ** 3), appearances = new Uint8Array(ids.length);
  for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = x + side * (y + side * z);
    if (y - pad < 4) { ids[i] = E.WOOD; appearances[i] = x - pad < 4 ? A.LOG_Y : A.PLANK_X; }
  }
  const opts = { size, origin, bounds, step };
  const bare = buildSurfaceMesh(ids, opts), tagged = buildSurfaceMesh(ids, { ...opts, appearances });
  const triangles = mesh => Array.from(mesh.indices, i => [...mesh.positions.subarray(i * 3, i * 3 + 3), ...mesh.normals.subarray(i * 3, i * 3 + 3)]);
  assert.deepEqual(triangles(tagged), triangles(bare));
  assert(tagged.appearances.includes(A.LOG_Y)); assert(tagged.appearances.includes(A.PLANK_X));
  assert(tagged.ids.every(id => id === E.WOOD));
  assert(bare.appearances.every(a => a === A.NONE));
  for (let i = 0; i < tagged.indices.length; i += 3) assert.equal(new Set(Array.from(tagged.indices.subarray(i, i + 3), v => tagged.appearances[v])).size, 1);
}

// Actual detail worker: readback and parked edits, without a browser.
const pad = meshPadding(), side = 8 + 2 * pad, height = 8;
const raw = new Uint32Array(side * side * height);
for (let y = 0; y < height; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
  raw[x + side * (z + side * y)] = packFarSceneCell(y < 4 ? E.WOOD : E.EMPTY, 20, y < 4 ? appearanceCtype(E.WOOD, 0, A.LOG_Y) : 0);
}
const parked = new Float32Array(BRICK_FLOATS);
for (let i = 0; i < parked.length; i += 4) parked.set([E.WOOD, 20, 0, appearanceCtype(E.WOOD, 0, A.PLANK_Z) + 0.375], i);
const oldSelf = globalThis.self;
try {
  let result;
  globalThis.self = { postMessage: packet => { result = packet; } };
  await import('../src/world/detail-worker.js');
  globalThis.self.onmessage({ data: { token: { step: 1 }, raw, layout: { side }, origin: [-pad, -pad, -pad], height, pad,
    bounds: [0, 0, 0, 8, 8, 8], live: [100, 100, 100, 110, 110, 110], planted: new Uint8Array(16 * 16), wb: [16, 2, 16], trees: [],
    edits: [{ at: [0, 0, 0], bytes: encodeBrick(parked, 0, velocity, 0) }] } });
  assert.equal(result.error, undefined);
  assert(result.appearances.includes(A.LOG_Y)); assert(result.appearances.includes(A.PLANK_Z));
} finally {
  if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf;
}

const P = { size: [64, 16, 64], seed: 991, structures: { start: [0, 0] } };
const stamp = new Float32Array([
  E.WOOD + 1, 20, appearanceCtype(E.WOOD, 0, A.LOG_X), 1,
  E.WOOD + 1, 20, appearanceCtype(E.WOOD, 0, A.PLANK_Z), 0,
  E.MOSS + 1, 20, appearanceCtype(E.MOSS, 4, A.LEAVES), 0,
]);
const st = { x0: 8, z0: 8, y: 4, s: { w: 3, h: 1, d: 1, base: { x: 0, y: 0, z: 0 }, foot: 4, data: stamp } };
const atlas = structureData(P, [st]);
assert(atlas.cells instanceof Uint16Array);
assert.equal(atlas.cells[0], E.WOOD + 1 + 128 + A.LOG_X * 256);
const pool = structureWords(P), cellAt = pool.values.uStructCellsAt;
assert.equal(pool.data[cellAt] & 65535, atlas.cells[0]);
assert.equal(pool.data[cellAt] >>> 16, atlas.cells[1]);
assert.equal(pool.data[cellAt + 1] & 65535, atlas.cells[2]);
assert.equal(pool.data[cellAt + 1] >>> 16, 0);
assert.equal(structureMaterialAt(9, 4, 8, E.EMPTY, P, () => E.ROCK), materialWord(E.WOOD, A.PLANK_Z));
assert.equal(structureMaterialAt(10, 4, 8, E.EMPTY, P, () => E.ROCK), materialWord(E.MOSS, A.LEAVES));
assert.equal(pool.data.length, cellAt + Math.ceil(atlas.cells.length / 2));
assert.equal(structureMaterialAt(8, 4, 8, E.EMPTY, P, () => E.ROCK), materialWord(E.WOOD, A.LOG_X));
assert.equal(structureCellAt(P, 8, 4, 8, E.EMPTY, () => E.ROCK), E.WOOD);
const ground = y => y <= 1 ? E.ROCK : E.EMPTY;
assert.equal(structureMaterialAt(8, 2, 8, E.EMPTY, P, ground), materialWord(E.WOOD, A.LOG_X));
assert.equal(structureMaterialAt(8, 2, 8, materialWord(E.WOOD, A.BARK), P, ground), materialWord(E.WOOD, A.BARK));
console.log('far appearance CPU checks passed');
