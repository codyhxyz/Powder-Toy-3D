// CPU checks of the save format (src/saves): no browser, no GPU.
//   node tools/saves-check.mjs
// - cells: packCells/unpackCells give back every bit of states A and B (NaNs,
//   -0 and random bits included) for every grid size the app has, through the
//   state atlas's real layout (sim.js gridLayout, cellTexel);
// - files: encodeSave/decodeSave keep the header and JSON and typed-array
//   sections; a section of an unknown type is skipped, a newer version and a
//   cut-short or foreign file are refused;
// - the World's stored bricks (world/store.js toBytes/fromBytes);
// - the section registry (sections.js): every save() runs before any await,
//   absent() for a section a save lacks, a failing section doesn't stop the rest;
// - how big a lab-like 128³ save is.
import assert from 'node:assert/strict';
import { gridLayout, cellTexel } from '../src/sim.js';
import { encodeSave, decodeSave, readSaveHeader, packCells, unpackCells, SAVE_VERSION, SAVE_MAGIC } from '../src/saves/format.js';
import { registerSaveSection, unregisterSaveSection, collectSections, applySections, registerSavedSettings, savedSettingKeys } from '../src/saves/sections.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { SEED_MAX } from '../src/shaders/common.js';

const MB = 1024 * 1024;
let rng = 0x9e3779b9;
const rand = () => ((rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);

function bitsEqualAtCells(dims, g, a, b) {
  const ua = new Uint32Array(a.buffer), ub = new Uint32Array(b.buffer);
  const [nx, ny, nz] = dims;
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const t = cellTexel(g, x, y, z) * 4;
        for (let c = 0; c < 4; c++) if (ua[t + c] !== ub[t + c]) return `cell ${x},${y},${z} channel ${c}: ${ua[t + c].toString(16)} vs ${ub[t + c].toString(16)}`;
      }
  return null;
}

// ---- cells, every grid size the app has (app.js SIZES, WORLDS' windows) ----
const SIZES = [[64, 64, 64], [96, 96, 96], [128, 128, 128], [160, 96, 160], [256, 96, 128], [128, 384, 128]];
for (const dims of SIZES) {
  const g = gridLayout(...dims), texels = g.width * g.height;
  const A = new Float32Array(texels * 4), B = new Float32Array(texels * 4);
  const ua = new Uint32Array(A.buffer), ub = new Uint32Array(B.buffer);
  for (let i = 0; i < ua.length; i++) { ua[i] = (rand() * 2 ** 32) >>> 0; ub[i] = (rand() * 2 ** 32) >>> 0; }
  ua[0] = 0x7fc00001;   // a NaN with a payload
  ub[1] = 0x80000000;   // -0
  const t0 = performance.now();
  const planes = packCells(dims, (x, y, z) => cellTexel(g, x, y, z), [A, B]);
  const A2 = new Float32Array(texels * 4), B2 = new Float32Array(texels * 4);
  unpackCells(dims, (x, y, z) => cellTexel(g, x, y, z), planes, [A2, B2]);
  const ms = performance.now() - t0;
  assert.equal(planes.length, dims[0] * dims[1] * dims[2] * 32);
  assert.equal(bitsEqualAtCells(dims, g, A, A2), null, `A at ${dims}`);
  assert.equal(bitsEqualAtCells(dims, g, B, B2), null, `B at ${dims}`);
  console.log(`cells ${dims.join('×')}: lossless, pack + unpack ${ms.toFixed(0)} ms`);
}
assert.throws(() => unpackCells([64, 64, 64], (x, y, z) => cellTexel(gridLayout(64, 64, 64), x, y, z), new Uint8Array(10), [new Float32Array(4)]), /bytes/);

// ---- files ----
const header = { name: 'Test', created: '2026-10-11T12:00:00.000Z', map: 'lab', mapName: 'Lab', size: '128', preset: 'lab', dims: [4, 4, 4], world: null, thumbnail: 'data:image/jpeg;base64,AAAA' };
const f32 = Float32Array.from([1.5, -0, NaN, 3e38]);
const u8 = Uint8Array.from([0, 1, 2, 255]);
const u32 = Uint32Array.from([0xffffffff, 7]);
const json = { signs: [{ cell: [1, 2, 3], normal: [0, 1, 0], text: 'hi {t}' }], n: 4 };
const bytes = await encodeSave(header, [{ key: 'f', data: f32 }, { key: 'u', data: u8 }, { key: 'w', data: u32 }, { key: 'j', data: json }, { key: 'skip', data: undefined }]);
assert.equal(String.fromCharCode(...bytes.subarray(0, SAVE_MAGIC.length)), SAVE_MAGIC);
const h = readSaveHeader(bytes);
assert.equal(h.version, SAVE_VERSION);
assert.equal(h.name, 'Test');
assert.deepEqual(h.sections.map((s) => s.key), ['f', 'u', 'w', 'j']);
const back = await decodeSave(bytes);
assert.ok(back.sections.get('f') instanceof Float32Array);
assert.deepEqual(new Uint32Array(back.sections.get('f').buffer), new Uint32Array(f32.buffer));
assert.deepEqual(back.sections.get('u'), u8);
assert.deepEqual(back.sections.get('w'), u32);
assert.deepEqual(back.sections.get('j'), json);
assert.equal(back.header.thumbnail, header.thumbnail);
// a section type this build doesn't know (a newer build's) is skipped; the rest load
{
  const hj = JSON.parse(new TextDecoder().decode(bytes.subarray(h.bodyAt - new DataView(bytes.buffer).getUint32(SAVE_MAGIC.length + 4, true), h.bodyAt)));
  hj.sections[0].type = 'f16';
  const head = new TextEncoder().encode(JSON.stringify(hj));
  const body = bytes.subarray(h.bodyAt);
  const out = new Uint8Array(SAVE_MAGIC.length + 8 + head.length + body.length);
  out.set(bytes.subarray(0, SAVE_MAGIC.length + 4));
  new DataView(out.buffer).setUint32(SAVE_MAGIC.length + 4, head.length, true);
  out.set(head, SAVE_MAGIC.length + 8);
  out.set(body, SAVE_MAGIC.length + 8 + head.length);
  const d = await decodeSave(out);
  assert.ok(!d.sections.has('f'));
  assert.deepEqual(d.sections.get('j'), json);
}
// a newer version is refused, as are foreign and cut-short files
{
  const newer = bytes.slice();
  new DataView(newer.buffer).setUint32(SAVE_MAGIC.length, SAVE_VERSION + 1, true);
  await assert.rejects(decodeSave(newer), /newer version/);
  assert.throws(() => readSaveHeader(new TextEncoder().encode('{"not": "a save"}')), /not a Powder Toy 3D save/);
  await assert.rejects(decodeSave(bytes.subarray(0, bytes.length - 3)), /cut short/);
}
console.log(`file: header and sections round-trip (${bytes.length} bytes); unknown types skipped; newer/foreign/short refused`);

// ---- the World's stored bricks ----
{
  const store = new BrickStore([256, 32, 256]);
  const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
  for (let k = 0; k < 50; k++) {
    for (let i = 0; i < BRICK_FLOATS; i++) { A[i] = Math.floor(rand() * 8); B[i] = rand() < 0.5 ? 0 : rand(); }
    store.put(store.key(k, k % 32, 255 - k), encodeBrick(A, 0, B, 0));
  }
  const copy = new BrickStore([256, 32, 256]);
  copy.fromBytes(store.toBytes());
  assert.equal(copy.size, store.size);
  assert.equal(copy.bytes, store.bytes);
  for (const [key, b] of store.map) assert.deepEqual(copy.map.get(key), b);
  const empty = new BrickStore([1, 1, 1]);
  copy.fromBytes(empty.toBytes());
  assert.equal(copy.size, 0);
  console.log(`world store: ${store.size} bricks (${store.bytes} bytes) round-trip`);
}

// ---- the registry ----
{
  const order = [];
  registerSaveSection('t.a', { save: () => { order.push('a'); return { a: 1 }; }, load: (d) => order.push(`load a ${d.a}`) });
  registerSaveSection('t.b', { save: async () => { order.push('b'); await null; return Uint8Array.of(9); }, load: (d) => order.push(`load b ${d[0]}`) });
  registerSaveSection('t.c', { save: () => { order.push('c'); return undefined; }, load: () => order.push('load c'), absent: () => order.push('absent c') });
  registerSaveSection('t.bad', { save: () => { throw new Error('boom'); }, load: () => { throw new Error('boom'); } });
  const quiet = console.error;
  console.error = () => {};
  const got = collectSections();
  assert.deepEqual(order, ['a', 'b', 'c']);   // every save() ran before any await
  const list = await got;
  assert.deepEqual(list.map((s) => s.key), ['t.a', 't.b']);
  order.length = 0;
  await applySections(new Map(list.map((s) => [s.key, s.data]).concat([['t.bad', 1]])), {});
  console.error = quiet;
  assert.deepEqual(order, ['load a 1', 'load b 9', 'absent c']);
  for (const k of ['t.a', 't.b', 't.c', 't.bad']) unregisterSaveSection(k);
  registerSavedSettings(['gravity', 'steps']);
  registerSavedSettings(['gravity']);
  assert.deepEqual(savedSettingKeys(), ['gravity', 'steps']);
  console.log('registry: saves start together, absent() for missing sections, failures contained');
}

// ---- size of a lab-like 128³ save ----
{
  const dims = [128, 128, 128], g = gridLayout(...dims), texels = g.width * g.height;
  const A = new Float32Array(texels * 4), B = new Float32Array(texels * 4);
  const AMBIENT = 20, WALL = 1, SAND = 2, WATER = 3;   // ids only for the shape of the data
  for (let y = 0; y < dims[1]; y++)
    for (let z = 0; z < dims[2]; z++)
      for (let x = 0; x < dims[0]; x++) {
        const t = cellTexel(g, x, y, z) * 4;
        const id = y < 4 ? WALL : y < 30 && x < 64 ? WATER : y < 50 && Math.hypot(x - 96, z - 64) < 50 - y ? SAND : 0;
        A[t] = id;
        A[t + 1] = AMBIENT + (id === WATER ? rand() * 0.01 : 0);
        A[t + 2] = 0;
        A[t + 3] = rand() * SEED_MAX;   // every cell's random seed (ctype 0)
        B[t + 3] = rand() < 0.2 ? (rand() - 0.5) * 1e-3 : 0;   // decaying pressure here and there
      }
  const planes = packCells(dims, (x, y, z) => cellTexel(g, x, y, z), [A, B]);
  const t0 = performance.now();
  const file = await encodeSave({ name: 'size', dims }, [{ key: 'cells', data: planes }]);
  console.log(`lab-like 128³: ${(planes.length / MB).toFixed(0)} MB of state → ${(file.length / MB).toFixed(1)} MB saved (deflate ${(performance.now() - t0).toFixed(0)} ms)`);
}
console.log('saves-check: all passed');
