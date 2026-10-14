// CPU only: real detail worker messages and cache methods with inert GPU doubles.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DataUtils, Matrix4 } from 'three';
import { E } from '../src/elements.js';
import { BUILTINS } from '../src/constructions/builtins.js';
import { encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { buildSurfaceMesh, meshPadding } from '../src/world/surfaceMesh.js';
import { buildFoliageMesh } from '../src/world/foliageMesh.js';
import { WorldDetail } from '../src/world/detail.js';

let response, transferred, passed = 0;
const previousSelf = globalThis.self;
globalThis.self = { postMessage: (message, transfer) => { response = message; transferred = transfer; } };
await import('../src/world/detail-worker.js');
const runWorker = data => {
  response = null;
  globalThis.self.onmessage({ data });
  assert.ok(response, 'worker replied synchronously');
  assert.equal(response.error, undefined);
  const arrays = [response, ...response.leaves].flatMap(m => Object.values(m).filter(ArrayBuffer.isView));
  assert.deepEqual(new Set(transferred), new Set(arrays.map(a => a.buffer)), 'all base and leaf buffers transferred once');
  assert.equal(transferred.length, new Set(transferred).size);
  return response;
};
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const pack = (id, temp = 20, leaf = false) => (DataUtils.toHalfFloat(id) | (DataUtils.toHalfFloat(temp) << 16) | +leaf) >>> 0;
const key = p => p.join(',');
const inside = (p, b) => p.every((v, i) => v >= b[i] && v < b[i + 3]);
let seed = 0;
function fixture() {
  const pad = meshPadding(1), height = 8, side = 8 + 2 * pad;
  const f = {
    token: { key: 0, x: 0, z: 0, step: 1, distance: 10, epoch: 0, revision: 0 },
    raw: new Uint32Array(side * side * height).fill(pack(E.EMPTY)), layout: { side },
    origin: [-pad, -pad, -pad], height, pad, bounds: [0, 0, 0, 8, 8, 8],
    live: [100, 100, 100, 101, 101, 101], planted: new Uint8Array(4), wb: [2, 2, 2], trees: [], edits: [],
    expected: new Map(),
  };
  f.expect = (p, id, leaf = false) => f.expected.set(key(p), [id, leaf && id === E.PLANT]);
  f.put = (p, id, leaf = false, temp = 20) => {
    const x = p[0] - f.origin[0], z = p[2] - f.origin[2];
    f.raw[x + side * (z + side * p[1])] = pack(id, temp, leaf);
    f.expect(p, id, leaf);
  };
  f.edit = (at, cells) => {
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const p = [at[0] + x, at[1] + y, at[2] + z];
      const [id, ctype, life] = cells.get(key(p)) ?? [E.EMPTY, 0, 0];
      A.set([id, -100, life ?? 0, ctype], (x + 4 * (y + 4 * z)) * 4);
      if (!inside(p, f.live)) f.expect(p, id, Math.floor(ctype) === E.PLANT);
    }
    f.edits.push({ at, bytes: encodeBrick(A, 0, B, 0) });
  };
  f.tree = () => f.trees.push({ x: 3, y: 2, z: 3, seed: ++seed, size: 16, variant: 'test', quarter: 0 });
  return f;
}
function expected(f) {
  const size = [f.layout.side, f.height + 2 * f.pad, f.layout.side], ids = new Uint8Array(size.reduce((a, b) => a * b)), mask = new Uint8Array(ids.length);
  for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
    const p = [x + f.origin[0], y + f.origin[1], z + f.origin[2]], i = x + size[0] * (y + size[1] * z);
    const cell = f.expected.get(key(p));
    ids[i] = cell?.[0] ?? (p[1] < 0 ? E.ROCK : E.EMPTY);
    mask[i] = +(cell?.[1] ?? false);
  }
  const terrain = ids.map((id, i) => mask[i] ? E.EMPTY : id);
  const options = { size, origin: f.origin, bounds: f.bounds, step: 1 };
  return { base: buildSurfaceMesh(terrain, options), leaves: [0, 1].map(lod => buildFoliageMesh(ids, mask, { ...options, lod })) };
}
function verify(f) {
  const out = runWorker(f), want = expected(f);
  for (const attr of ['positions', 'normals', 'ids', 'indices']) assert.deepEqual(out[attr], want.base[attr], `base ${attr}`);
  assert.deepEqual(out.leaves, want.leaves, 'both deterministic leaf LODs');
  return out;
}

check('raw tag preserves all integer ids, rounding, and signed/high temperatures', () => {
  for (let id = 0; id < 256; id++) for (const temp of [-32000, -100, 0, 20, 32000]) {
    assert.equal(DataUtils.toHalfFloat(id) & 1, 0);
    const before = pack(id, temp), after = pack(id, temp, true);
    assert.equal(before >>> 16, after >>> 16);
    const decoded = DataUtils.fromHalfFloat(after & 65535);
    assert.equal(Math.trunc(decoded), id);
    assert.equal(Math.round(decoded), id);
    assert.ok(decoded - id <= 0.125);
    assert.equal(DataUtils.fromHalfFloat(after >>> 16), DataUtils.fromHalfFloat(before >>> 16));
  }
});

check('live/scene tagged leaves become clusters; wood/ground/untagged PLANT and liquids survive', () => {
  const f = fixture();
  f.put([2, 2, 2], E.PLANT, true, -32000);
  f.put([3, 2, 2], E.PLANT);
  f.put([4, 2, 2], E.WOOD);
  f.put([4, 1, 2], E.SOIL);
  f.put([5, 1, 2], E.WATER, false, 32000);
  const out = verify(f);
  assert.ok(out.leaves[0].indices.length > out.leaves[1].indices.length);
  assert.ok(out.ids.includes(E.PLANT));
  assert.ok(out.ids.includes(E.WOOD));
  assert.ok(out.liquid);
});

check('leaf-only worker chunk has no closed base crown; live cuts/burns remove both LODs', () => {
  const f = fixture();
  f.bounds = [0, 3, 0, 8, 7, 8]; // exclude the world's bedrock floor
  f.put([3, 4, 3], E.PLANT, true);
  const before = verify(f);
  assert.equal(before.indices.length, 0);
  assert.ok(before.leaves.every(m => m.indices.length > 0));
  for (const id of [E.EMPTY, E.FIRE]) {
    f.put([3, 4, 3], id, true); // even a stale raw flag cannot retain burned/cut leaves
    const after = verify(f);
    assert.equal(after.indices.length, 0);
    assert.ok(after.leaves.every(m => m.indices.length === 0));
  }
});

check('nonfoliage-only surface mesh remains byte-for-byte unchanged', () => {
  const f = fixture();
  for (let x = 1; x < 7; x++) for (let z = 1; z < 7; z++) {
    f.put([x, 0, z], E.SOIL);
    f.put([x, 1, z], x < 4 ? E.PLANT : E.WOOD);
  }
  const out = verify(f);
  assert.equal(out.leaves[0].indices.length, 0);
  assert.equal(out.leaves[1].indices.length, 0);
});

// A tiny real baked construction isolates precedence and footing, independent
// of the evolving visual TREE generator; only this test process replaces it.
const originalTree = BUILTINS.TREE;
BUILTINS.TREE = ({ put, footing }) => {
  footing(2);
  put(0, 0, 0, 'WOOD');
  put(0, 1, 0, 'PLANT', { ctype: 'PLANT' });
  put(1, 1, 0, 'PLANT');
  put(0, 2, 0, 'PLANT', { ctype: 'PLANT' });
};
try {
  check('generated baked ctype masks override raw ids AND tags; footing stays untagged', () => {
    const f = fixture();
    f.put([3, 0, 3], E.ROCK);
    f.put([3, 2, 3], E.PLANT, true); // trunk must clear this raw tag
    f.put([4, 3, 3], E.PLANT, true); // untagged generated PLANT clears it too
    f.tree();
    for (const p of [[3, 1, 3], [3, 2, 3]]) f.expect(p, E.WOOD);
    for (const p of [[3, 3, 3], [3, 4, 3]]) f.expect(p, E.PLANT, true);
    f.expect([4, 3, 3], E.PLANT);
    verify(f);
  });

  check('stored A.w wins over generated/raw; life A.z cannot tag foliage; cuts/burns clear it', () => {
    const f = fixture();
    f.tree();
    f.expect([4, 3, 3], E.PLANT);
    f.expect([3, 4, 3], E.PLANT, true);
    f.edit([0, 0, 0], new Map([
      [key([3, 3, 3]), [E.EMPTY, E.PLANT, 0]], // cut: stale ctype cannot keep a cluster
      [key([2, 2, 2]), [E.PLANT, 0, E.PLANT]], // life is NOT ctype
      [key([1, 2, 2]), [E.PLANT, E.PLANT + 0.25, 0]],
    ]));
    f.edit([0, 4, 0], new Map([[key([3, 4, 3]), [E.FIRE, E.PLANT, 0]]]));
    const out = verify(f);
    assert.equal(out.leaves[0].ids.length, 36, 'only the stored tagged plant survives');
  });

  check('live cells beat both stored and generated cells; planted columns suppress generation', () => {
    const f = fixture();
    f.live = [0, 0, 0, 4, 8, 4];
    f.put([3, 3, 3], E.PLANT, true);
    f.put([3, 4, 3], E.EMPTY);
    f.tree();
    f.planted[1] = 1; // x=4 column, containing the untagged generated plant
    f.edit([0, 0, 0], new Map([[key([3, 3, 3]), [E.WOOD, 0, 0]]]));
    verify(f);
  });

  check('footing never inherits a tagged base plant mask', () => {
    BUILTINS.TREE = ({ put, footing }) => { footing(2); put(0, 0, 0, 'PLANT', { ctype: 'PLANT' }); };
    const f = fixture();
    f.put([3, 0, 3], E.ROCK);
    f.tree();
    f.expect([3, 1, 3], E.PLANT);
    f.expect([3, 2, 3], E.PLANT, true);
    verify(f);
  });
} finally {
  BUILTINS.TREE = originalTree;
}

const emptyMesh = () => ({ positions: new Float32Array(), normals: new Float32Array(), ids: new Uint8Array(), indices: new Uint16Array() });
const triangle = () => ({ positions: new Float32Array(9), normals: new Float32Array(9), ids: new Uint8Array(3).fill(E.PLANT), indices: new Uint16Array([0, 1, 2]) });
const token = { key: 0, x: 0, z: 0, step: 1, distance: 10, epoch: 0, revision: 0 };
const result = () => ({ token, ...triangle(), leaves: [triangle(), triangle()], liquid: false });
function cache() {
  const allocated = [], retired = [], writes = [], draws = [], depths = [];
  const c = Object.assign(Object.create(WorldDetail.prototype), {
    entries: new Map(), wanted: [{ ...token }], blocked: new Set(), revisions: new Uint32Array(4), mask: new Uint32Array(4),
    bytes: 0, epoch: 0, nx: 2, nz: 2, disposed: false, visible: true, win: { size: [64, 8, 64] },
    sim: { cur: 0, _retire: b => retired.push(b) },
    gpu: {
      createBuffer: spec => { const b = { ...spec }; allocated.push(b); return b; },
      write: (b, offset, data) => { assert.equal(c.mask[0], 0, 'ownership not published during uploads'); writes.push({ b, data }); },
      createTexture: spec => ({ width: spec.size[0], height: spec.size[1], createView: () => ({}) }),
      frame: { render: () => ({ end() {} }) },
    },
    pipe: { state: 'ready', draw: (rp, call) => draws.push(call) },
    depthPipe: { state: 'ready', draw: (rp, call) => depths.push(call) },
    worker: { terminate() {} }, cells: {},
  });
  return { c, allocated, retired, writes, draws, depths };
}
check('cache owns all three parts atomically; accurate aligned accounting and disposal', () => {
  const { c, allocated, retired, writes } = cache();
  c.accept(result());
  const e = c.entries.get(0);
  assert.equal(e.parts.length, 3);
  assert.equal(e.buffers.length, 12);
  assert.equal(c.mask[0], 1);
  assert.equal(c.bytes, allocated.reduce((sum, b) => sum + b.size, 0));
  assert.equal(c.bytes, 3 * (36 + 36 + 12 + 8), 'odd uint16 index count gets aligned');
  assert.deepEqual([...writes[2].data], [E.PLANT, E.PLANT, E.PLANT]);
  assert.deepEqual([...writes[6].data], [256 | E.PLANT, 256 | E.PLANT, 256 | E.PLANT]);
  c.dispose();
  assert.equal(c.bytes, 0);
  assert.equal(c.entries.size, 0);
  assert.equal(c.mask[0], 0);
  for (const b of allocated) assert.ok(retired.includes(b));
});

check('leaf-only chunks receive ownership, keep liquids, and reject stale tokens', () => {
  const { c, allocated } = cache();
  c.accept({ ...result(), ...emptyMesh(), liquid: true });
  assert.equal(c.entries.get(0).parts[0], null);
  assert.equal(c.mask[0], 2);
  assert.equal(allocated.length, 8);
  c.stale([0, 0, 0], [1, 1, 1]);
  c.accept(result());
  assert.equal(allocated.length, 8, 'stale revision allocates nothing');
  assert.equal(c.entries.get(0).step, 0);
  c.invalidate([0, 0, 0], [1, 1, 1]);
  assert.equal(c.mask[0], 0);
  assert.equal(c.bytes, 0);
  c.accept(result());
  assert.equal(c.entries.size, 0);
  c.reset();
  assert.equal(c.valid(token), false, 'old epoch cannot publish');
});

check('over-budget and interrupted uploads publish no partial ownership', () => {
  const { c, allocated, retired } = cache();
  c.bytes = 96 * 1024 * 1024;
  c.accept(result());
  assert.equal(c.mask[0], 0);
  assert.equal(allocated.length, 0);
  assert.ok(c.blocked.has(0));
  c.bytes = 0;
  let writes = 0;
  c.gpu.write = () => { if (++writes === 6) throw new Error('injected leaf upload failure'); };
  const log = console.error;
  console.error = () => {};
  try { c.accept(result()); } finally { console.error = log; }
  assert.equal(c.mask[0], 0);
  assert.equal(c.entries.size, 0);
  assert.equal(c.bytes, 0);
  assert.equal(retired.length, allocated.length);
  assert.equal(c.failed, true);
});

check('effective-target LOD uses the same base/leaf buffers in depth and color', () => {
  const { c, draws, depths } = cache();
  c.accept(result());
  const e = c.entries.get(0);
  const params = { worldToClip: new Matrix4().makePerspective(-1, 1, 1, -1, 1, 1000), eye: [0, 4, -100] };
  for (const [height, lod] of [[1200, 0], [600, 1], [1200, 0]]) {
    draws.length = depths.length = 0;
    assert.equal(c.depth({ width: 1000, height }, params), true);
    assert.equal(e.leafLOD, lod);
    c.draw({}, params, []);
    assert.equal(draws.length, 2);
    assert.equal(depths.length, 2);
    assert.equal(draws[0].index.buffer, e.parts[0].buffers[3]);
    assert.equal(draws[1].index.buffer, e.parts[lod + 1].buffers[3]);
    assert.deepEqual(draws.map(d => d.index.buffer), depths.map(d => d.index.buffer));
  }
  params.eye = [0, 4, -200];
  c.depth({ width: 1000, height: 1200 }, params);
  assert.equal(e.leafLOD, 1, 'distance also lowers detail');
  c.draw({}, params, []);
  draws.length = 0;
  c.draw({}, params, []);
  assert.equal(draws[1].index.buffer, e.parts[1].buffers[3], 'no prepass defaults to fine');
});

check('shader source tags state A.w, limits double-sided normals to leaf buffers', () => {
  const shader = readFileSync(new URL('../src/shaders/far.js', import.meta.url), 'utf8');
  assert.match(shader, /pack2x16float\(A\.xy\) \| select\(0u, 1u, id == E_PLANT && floor\(A\.w\) == f32\(E_PLANT\)\)/);
  assert.match(shader, /if \(\(v\.element & 256u\) != 0u && dot\(n, rd\) > 0\.0\) \{ n = -n; \}/);
  assert.match(shader, /i32\(v\.element & 255u\)/);
});

if (previousSelf === undefined) delete globalThis.self;
else globalThis.self = previousSelf;
console.log(`${passed} distant foliage CPU checks passed`);
