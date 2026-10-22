// CPU-only: World draws Physics V2's foam as Box does (CLAUDE.md "Same features in every world").
//
// Box under V2 reads its whitewater straight from V2's cores (shaders/common.js fetchNativeAeration,
// liquidDetail.js aerTap for formats 2/3), always compiles native foam whatever the Whitewater switch,
// and layers it on molten liquids (render.js realistic). World reads its own atlas, whose aeration came
// from V1's field (gfx/foam.js), which only V1's step advances: under V2 World showed foam frozen from
// before the switch, or none, never on lava, and only with Whitewater on. Pins:
//   (1) while V2 runs the box, World's live copies carry V2's foam packed from the cores
//       (world/renderSource.js's native pack, shaders/renderSource.js nativePackWGSL), straight into
//       the source; under V1 V1's field, as before;
//   (2) the packed record decodes, through World's worldAeration/aerTap, to what Box's aerTap reads;
//   (3) the World view carries WORLD_NATIVE under V2 only (freezeWorldView), and its programs then compile
//       native foam and molten foam as Box's format-2 programs do; without it World's text is unchanged;
//   (4) those programs and the pack kernel validate in Naga.
// No GPU, browser or WebGPU execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Matrix4, Vector3 } from 'three';
import { WorldRenderSource, snapshotSource } from '../../src/world/renderSource.js';
import { nativePackWGSL, NATIVE_PACK_LAYOUT, nativePackSlot } from '../../src/shaders/renderSource.js';
import { volumeFrag, VOLUME_LAYOUTS, VOLUME_VIEWS, REALISTIC_LEVELS } from '../../src/shaders/render.js';
import { WORLD_NATIVE } from '../../src/shaders/gfx/liquidDetail.js';
import { freezeWorldView, worldViewDetail } from '../../src/wire/worldRenderFrame.js';
import { gridDims, cellSlot, LAYOUT } from '../../src/shaders/common.js';
import { isMaterialView } from '../../src/views.js';
import { checkPipeline } from '../check-sampler-budget.mjs';
import { assertNaga } from './wgsl-grouping.mjs';

globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x04, COPY_DST: 0x08 };
const NATIVE_WORD = 0x5eed0001;   // what the fake pack kernel "writes" into V2's aeration
const LEGACY_WORD = 0x0a1e0001;   // V1's (stale under V2) aeration field

function fixture({ native }) {
  const commands = [], dispatched = [];
  const flush = () => { while (commands.length) commands.shift()(); };
  const frame = { copy(a, ao, b, bo, n) { assert(ao + n <= a.size && bo + n <= b.size); commands.push(() => b.bytes.set(a.bytes.subarray(ao, ao + n), bo)); },
    clear(b, at = 0, n = b.size) { commands.push(() => b.bytes.fill(0, at, at + n)); } };
  const createBuffer = ({ size, label }) => ({ size, label, bytes: new Uint8Array(size), getMappedRange() { return this.bytes.buffer; }, unmap() {}, destroy() {} });
  const gpu = { frame, stats: { flushes: 0 }, createBuffer,
    write(b, at, data) { flush(); b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); },
    layout(_name, e) { return e; }, bindGroup(layout, entries) { return { layout, entries }; },
    // The pack's dispatch, in order with the copies: it "writes" NATIVE_WORD into the foam of each cell of its box.
    kernel(desc) { return { ...desc, state: 'ready', ready: Promise.resolve(), dispatch(_f, size, opts) {
      dispatched.push({ kernel: desc, size, opts });
      const { lo, hi, dstOrigin, dstTiles, aer } = opts.params, out = opts.bind[2].entries[2].resource.buffer;
      if (aer) commands.push(() => { const w = new Uint32Array(out.bytes.buffer);
        for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) w[nativePackSlot(dstTiles, x - dstOrigin[0], y - dstOrigin[1], z - dstOrigin[2]) * 2] = NATIVE_WORD; });
    } }; } };
  const g = gridDims({ nx: 32, ny: 32, nz: 32 });
  const readGroup = { name: 'v2 compact readers (air)' };
  const owner = { isReady: true, tick: 7, dynamics: { isReady: true, air: [{}] }, readGroup: () => readGroup, synced: 0, sync() { this.synced++; } };
  const sim = { id: 1, g, gpu, cur: 1, version: 1, origin: { x: 32, y: 0, z: 32 }, L: { TABLES: LAYOUT.TABLES, STATE_RO: LAYOUT.STATE_RO }, tables: { name: 'tables' },
    state: { A: createBuffer({ size: g.slots * 32 }), B: createBuffer({ size: g.slots * 32 }) }, flow: createBuffer({ size: g.slots * 8 }),
    aeration: { buffer: createBuffer({ size: g.slots * 16 }), cur: 0, generation: 3 }, decoPlane: null,
    compact: native ? owner : null, compactOwner: owner,
    _retire() {}, legacyState() {}, header() { return { origin: [this.origin.x, 0, this.origin.z], src: this.cur, dst: this.cur, format: 0, capture: 0 }; } };
  new Uint32Array(sim.aeration.buffer.bytes.buffer).fill(LEGACY_WORD);
  const win = { sim, gpu, size: [128, 32, 128], epoch: 1, wb: [32, 8, 32], scene: {}, planted: new Uint8Array(32 * 32), candidates: new Map(), store: { map: new Map() } };
  const source = new WorldRenderSource(win);
  return { sim, owner, readGroup, source, frame, flush, dispatched };
}
const chunkAeration = (source, cell) => {
  const c = source.chunks.get(cell.map(v => Math.floor(v / 32) * 32).join(','));
  return new Uint32Array(c.aeration.bytes.buffer)[cellSlot(c.g, ...cell.map((v, i) => v - c.origin[i])) * 2];
};

test('(1) under V2 World\'s live copy carries V2\'s foam, packed from the cores into the source; under V1 V1\'s field', () => {
  const v2 = fixture({ native: true });
  v2.source.recordLiveCopy(v2.frame); v2.flush();
  assert(v2.dispatched.length > 0, 'V2\'s cores packed into the source');
  for (const d of v2.dispatched) {
    assert.equal(d.kernel.name, 'worldNativePack');
    assert.equal(d.opts.bind[1], v2.readGroup, 'it reads V2\'s cores, as Box\'s format-2 volume binds them');
    assert.equal(d.opts.header.format, 2); assert.equal(d.opts.params.aer, 1);
  }
  assert(v2.owner.synced > 0, 'V2 imports pending writes before the pack');
  assert.equal(chunkAeration(v2.source, [40, 5, 40]), NATIVE_WORD, 'World\'s atlas holds V2\'s foam, not V1\'s frozen field');
  const snap = snapshotSource(v2.sim);
  assert.equal(snap.aerCopy, 0); assert.equal(snap.boundedWake, true); assert.equal(snap.aerGeneration, v2.owner.tick);
  assert.equal(v2.source.needsLiveCopy(v2.sim), false, 'an unchanged V2 box needs no new copy');
  v2.sim.version++;
  assert.equal(v2.source.needsLiveCopy(v2.sim), true, 'a recorded tick (V2\'s foam moved) needs one');

  const v1 = fixture({ native: false });   // V1 steps the grid (a suspended V2 owner keeps its cells)
  v1.source.recordLiveCopy(v1.frame); v1.flush();
  assert.equal(v1.dispatched.length, 0, 'V1 packs nothing');
  assert.equal(chunkAeration(v1.source, [40, 5, 40]), LEGACY_WORD, 'V1\'s World reads V1\'s field, as before');
  assert.equal(snapshotSource(v1.sim).aeration, v1.sim.aeration.buffer);
  assert.equal(snapshotSource(v1.sim).aerGeneration, 3);
});

test('(1b) leaving copies under V2 carry V2\'s foam too (captured outside foam stays authoritative)', () => {
  const v2 = fixture({ native: true });
  v2.source.recordLeavingCopy(v2.frame, v2.sim, { lo: [32, 0, 32], hi: [40, 32, 64] }); v2.flush();
  assert.equal(chunkAeration(v2.source, [33, 3, 50]), NATIVE_WORD);
});

// The pack, by the kernel's own WGSL: a liquid cell with fill keeps (age / 255, 1, 1), else 0.
const f16 = Math.f16round;
function packRecord([x, y, z]) { return y > 0.5 ? [f16(x), f16(y), f16(0), f16(z)] : [0, 0, 0, 0]; }
// World's reader (worldAccess.js worldAeration → liquidDetail.js aerTap world branch).
const worldTap = f => f[1] > 0.5 ? [f[0], 1, f[3]] : [0, 0, 0];
test('(2) the packed record reads, through World\'s aerTap, as Box\'s aerTap reads V2\'s cores', () => {
  const code = nativePackWGSL(gridDims({ nx: 32, ny: 32, nz: 32 }));
  assert.match(code, /let a = fetchNativeAeration\(p\);/, 'Box\'s own reader');
  assert.match(code, /select\(vec2u\(0u\), vec2u\(pack2x16float\(vec2f\(a\.x, a\.y\)\), pack2x16float\(vec2f\(0\.0, a\.z\)\)\), a\.y > 0\.5\)/);
  assert.match(code, /fn fetchNativeAeration\(p: vec3i\) -> vec3f \{\n  if \(2u != 2u && 2u != 3u\) \{ return vec3f\(0\.0\); \}/, 'fixed format 2: the cores');
  for (let age = 0; age < 256; age++) {
    const box = [age / 255, 1, 1];   // shaders/common.js fetchNativeAeration for a liquid with fill
    const world = worldTap(packRecord(box));
    for (let i = 0; i < 3; i++) assert(Math.abs(world[i] - box[i]) <= 2 ** -11, `age ${age}: f16 of the atlas only`);
  }
  assert.deepEqual(worldTap(packRecord([0, 0, 0])), [0, 0, 0], 'no liquid, no foam');
});

const world = { nx: 384, ny: 128, nz: 384, sourceAppearance: false, sourceGrid: [128, 0, 128] };
test('(3) the World view carries WORLD_NATIVE under V2 only; its programs then compile Box\'s native foam', () => {
  assert.deepEqual(worldViewDetail({ compact: {} }, { DETAIL_LIQ_RIPPLES: 1 }), { DETAIL_LIQ_RIPPLES: 1, [WORLD_NATIVE]: true });
  assert.deepEqual(worldViewDetail({ compact: null, compactOwner: {} }, { DETAIL_LIQ_RIPPLES: 1 }), { DETAIL_LIQ_RIPPLES: 1 }, 'V1 (owner suspended): as before');
  const camera = new PerspectiveCamera(55, 1, 0.1, 100); camera.updateMatrixWorld();
  const app = (sim) => ({ sim, camera, settings: {}, post: { settings: {} }, pov: null, presentation: { parameters: { k: 0, anchor: [0, 0, 0], dir: [0, 0, 1] },
    sceneToWorld: new Matrix4(), worldToScene: new Matrix4(), uniforms: { uWarpK: { value: 0 }, uWarpAnchor: { value: new Vector3() }, uWarpDir: { value: new Vector3() } } } });
  const values = { model: new Matrix4().toArray(), cam: [0, 0, 0] };
  assert.equal(freezeWorldView(app({ compact: {} }), values, { view: 'realistic', detail: {} }).detail[WORLD_NATIVE], true, 'a V2 frame asks for the native programs');
  assert.equal(freezeWorldView(app({ compact: null }), values, { view: 'realistic', detail: {} }).detail[WORLD_NATIVE], undefined);

  const plain = volumeFrag(world, { backend: 'world', view: 'realistic', detail: {} });
  const native = volumeFrag(world, { backend: 'world', view: 'realistic', detail: { [WORLD_NATIVE]: true } });
  assert.doesNotMatch(plain, /liquidFoam\(/, 'V1 World without Whitewater: no foam compiled, as before');
  assert.match(native, /\n  liquidFoam\(hp, &n, id, col, trans\);/, 'V2 World: foam whatever the Whitewater switch, as Box format 2');
  assert.match(native, /if \(stop && true && hitK == HIT_SMOOTH && s\.ch == CH_MOLTEN && KIND\(s\.id\) == K_LIQUID\) \{/, 'molten liquids take native foam, as Box format 2/3 (a hit, not the floor: shadeHit)');
  assert.match(native, /let f = worldAeration\(c\);/, 'from World\'s atlas (V2\'s packed foam)');
  const whitewater = volumeFrag(world, { backend: 'world', view: 'realistic', detail: { DETAIL_LIQ_FOAM: 1 } });
  assert.doesNotMatch(whitewater, /CH_MOLTEN && KIND\(s\.id\) == K_LIQUID\) \{/, 'V1 World keeps its programs');
});

test('(4) the native World programs and the source pack validate in Naga', () => {
  let n = 0;
  for (const view of VOLUME_VIEWS.filter(isMaterialView)) for (const [level, d] of Object.entries(REALISTIC_LEVELS)) for (const curved of [false, true]) {
    const code = volumeFrag(world, { backend: 'world', view, detail: { ...d(), [WORLD_NATIVE]: true }, curved });
    assert.deepEqual(checkPipeline({ code, groups: VOLUME_LAYOUTS({ backend: 'world' }), kind: 'render' }).problems, [], `${view}.${level}${curved ? '.curved' : ''}`);
    if (level === 'off' || level === 'full') { assertNaga(code, `world.volume.${view}.${level}${curved ? '.curved' : ''}.native`); n++; }
  }
  const g = gridDims({ nx: 128, ny: 128, nz: 128 });
  assertNaga(nativePackWGSL(g), 'worldNativePack'); n++;
  assert.deepEqual(NATIVE_PACK_LAYOUT.map(e => e.buffer.type), ['storage', 'storage', 'storage']);
  console.log(`Naga: ${n} native World modules`);
});
