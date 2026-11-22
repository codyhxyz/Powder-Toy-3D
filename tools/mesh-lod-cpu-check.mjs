// CPU only: validate the emitted WGSL and exercise the same planning/recording code as the renderer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Matrix4, WebGPUCoordinateSystem } from 'three/webgpu';
import { WgslExec, WgslParser, WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { tablesBuffer } from '../src/shaders/common.js';
import { gridLayout } from '../src/sim.js';
import { settleParkedView } from '../src/gfx/pacing.js';
import { nagaExec } from './naga.mjs';
import {
  createMeshGround, meshGroundWGSL, meshLodPlan, meshChunkDirty, meshSlotCache, meshChunkVisible, meshFrustum,
  MESH_VCAP, MESH_ICAP, MESH_FIXED_VCAP, MESH_FIXED_ICAP, MESH_CHUNK, MESH_MAX_LOD, meshPoolSlots, WGSL_CHECK,
} from '../src/gfx/meshGround.js';

const g = gridLayout(128, 128, 128);
const axes = [0, 1, 2];
const nearLOD = (plan, p) => plan.find((ch) => axes.every((i) => p[i] >= ch.lo[i] && p[i] < ch.hi[i]))?.lod;

function cover(size, plan) {
  let covered = 0;
  for (const a of plan) {
    for (const i of axes) {
      assert.equal(a.lo[i] % a.span, 0);
      assert.ok(a.lo[i] >= 0 && a.lo[i] < a.hi[i] && a.hi[i] <= size[i]);
    }
    assert.equal(a.span, MESH_CHUNK * (1 << a.lod));
    covered += axes.reduce((v, i) => v * (a.hi[i] - a.lo[i]), 1);
    let faces = 0;
    for (const b of plan) {
      if (a === b) continue;
      const overlap = axes.map((i) => Math.min(a.hi[i], b.hi[i]) - Math.max(a.lo[i], b.lo[i]));
      assert.ok(Math.min(...overlap) <= 0, `${a.key} overlaps ${b.key}`);
      for (const i of axes) if (overlap[i] === 0 && axes.every((j) => j === i || overlap[j] > 0)) {
        assert.ok(Math.abs(a.lod - b.lod) <= 1, `unbalanced face ${a.key} / ${b.key}`);
        if (a.lod !== b.lod) {
          const bit = 1 << (2 * i + Number(a.hi[i] === b.lo[i]));
          faces |= bit | (a.lod < b.lod ? bit << 6 : 0);
        }
      }
    }
    assert.equal(a.faces, faces, `overlap and skirt bits on ${a.key}`);
  }
  // All leaves are disjoint subsets: summing their exact integer-cell volumes proves full coverage.
  assert.equal(covered, size.reduce((a, b) => a * b, 1));
}

test('no holes or overlapping owners; mixed LOD has symmetric margins and fine-side skirts', () => {
  const sizes = [[128, 128, 128], [1024, 128, 1024], [3072, 128, 1024], [3072, 384, 1024], [2560, 320, 2560], [1036, 140, 548]];
  const limit = meshPoolSlots(128 << 20, false) / 2;
  assert.equal(limit, 192);
  for (const size of sizes) {
    cover(size, meshLodPlan(size, null, limit));
    const center = size.map((v) => Math.floor(v * 0.5));
    for (const eye of [center, [3, 2, 4], [size[0] - 9, 24, size[2] - 17], [-110, 20, -70]]) {
      const plan = meshLodPlan(size, eye, limit);
      cover(size, plan);
      assert.ok(plan.length <= limit);
      if (Math.max(...size) <= 128) assert.ok(plan.every((ch) => ch.lod === 0 && ch.faces === 0));
      else if (eye[0] >= 0) {
        assert.equal(nearLOD(plan, eye), 0, `${size} has LOD0 at ${eye}`);
        assert.ok(plan.some((ch) => ch.faces >> 6), 'no mixed-LOD seam exercised');
        if (size[0] >= 2560) assert.equal(new Set(plan.map((ch) => ch.lod)).size, MESH_MAX_LOD + 1);
      }
    }
  }
  assert.throws(() => meshLodPlan(sizes[0], null, 63), RangeError);
});

test('dirty half-open boxes include overlap, smoothing and coarse footprints at every LOD', () => {
  for (let lod = 0; lod <= MESH_MAX_LOD; lod++) {
    const step = 1 << lod, span = MESH_CHUNK * step;
    const ch = { lo: [512, 512, 512], span, step, lod };
    for (const a of axes) {
      const b = (start) => ({ lo: ch.lo.map((x, i) => x + (i === a ? start : 1)), hi: ch.lo.map((x, i) => x + (i === a ? start + 1 : 2)) });
      assert.ok(meshChunkDirty(ch, [b(-4 * step)]));
      assert.ok(meshChunkDirty(ch, [b(span + 4 * step - 1)]));
      assert.ok(!meshChunkDirty(ch, [b(-4 * step - 1), b(span + 4 * step)]));
    }
  }
});

test('slots survive motion, dirtied seams rebuild, evicted slots never inherit stale draw state', () => {
  const { resident, sync } = meshSlotCache(3);
  const [a, b, c, d] = meshLodPlan([128, 128, 128], [0, 0, 0]);
  sync([a, b, c]);
  Object.assign(resident.get(a.key), { built: true, dirty: false });
  Object.assign(resident.get(b.key), { built: true, dirty: false });
  const replacedSlot = resident.get(c.key).slot;
  const keepSlot = resident.get(b.key).slot;
  sync([{ ...a, faces: 17 }, d, b]);
  assert.equal(resident.get(b.key).slot, keepSlot);
  assert.ok(resident.get(b.key).built && !resident.get(b.key).dirty);
  assert.ok(resident.get(a.key).built && resident.get(a.key).dirty);
  assert.equal(resident.get(d.key).slot, replacedSlot);
  assert.ok(!resident.get(d.key).built && resident.get(d.key).dirty);
  assert.equal(resident.has(c.key), false);
  assert.throws(() => sync([a, b, c, d]), RangeError);
});

test('frustum uses WebGPU depth range and keeps the transition halo', () => {
  const matrix = new Matrix4().makeOrthographic(-40, 40, 40, -40, 10, 100, WebGPUCoordinateSystem);
  const f = meshFrustum(matrix);
  const ch = (x, y, z) => ({ lo: [x, y, z], span: 32, step: 1 });
  assert.ok(meshChunkVisible(ch(0, 0, -60), f));
  assert.ok(meshChunkVisible(ch(42, 0, -60), f), 'seam overlap just inside right plane');
  for (const p of [[48, 0, -60], [0, -80, -60], [0, 0, -3], [0, 0, -160]]) assert.ok(!meshChunkVisible(ch(...p), f));
});

test('checkerboard chunks and overlap/skirts fit the exact capacities and uint16', () => {
  const c = MESH_CHUNK, v = c + 3, q = c + 2;
  const inside = (x, y, z) => ((x + y + z) & 1) !== 0;
  let verts = 0, quads = 0, skirts = 0;
  // The whole dispatch's domain with all overlap bits set; place skirts on
  // one face per axis, the upper bound for dyadic neighbours.
  for (let z = -2; z <= c; z++) for (let y = -2; y <= c; y++) for (let x = -2; x <= c; x++) {
    if (inside(x, y, z) !== inside(x + 1, y, z)) verts++;
  }
  for (let z = -1; z <= c; z++) for (let y = -1; y <= c; y++) for (let x = -1; x <= c; x++) {
    const p = [x, y, z];
    for (const a of axes) {
      const next = p.map((n, k) => n + Number(a === k));
      if (inside(...p) === inside(...next)) continue;
      quads++;
      skirts += axes.filter((b) => b !== a && p[b] === c).length;
    }
  }
  assert.equal(verts, v ** 3);
  assert.equal(quads, 3 * q ** 3);
  assert.equal(skirts, 6 * q ** 2);
  assert.equal(verts + 2 * skirts, MESH_VCAP);
  assert.equal(6 * (quads + skirts), MESH_ICAP);
  assert.ok(MESH_VCAP <= 65536);
  assert.ok((c + 1) ** 3 + 2 * (c + 1) <= MESH_FIXED_VCAP);
  assert.ok(6 * 3 * (c + 1) ** 3 <= MESH_FIXED_ICAP);
  const values = [MESH_VCAP - 1, MESH_VCAP - 2, 0, 1];
  const pack = (a, b) => a | (b << 16);
  const view = new DataView(new ArrayBuffer(12));
  [pack(values[0], values[1]), pack(values[2], values[0]), pack(values[2], values[3])].forEach((w, i) => view.setUint32(i * 4, w, true));
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getUint16(i * 2, true)), [values[0], values[1], values[2], values[0], values[2], values[3]]);
  assert.equal(MESH_ICAP % 6, 0);
});

test('naga validates every emitted WGSL module; reflection verifies layouts and draw bindings', () => {
  const checks = new Map(WGSL_CHECK().map((check) => [check.name, check]));
  const validated = new Set();
  for (const grid of [g, gridLayout(128, 384, 128)]) for (const tier of ['fixed', 'normal', 'overflow']) for (const [name, code] of Object.entries(meshGroundWGSL(grid, false, tier))) {
    if (validated.has(code)) continue;
    nagaExec(code, `mesh-lod-${name}-${grid.ny}.wgsl`);
    validated.add(code);
    const reflect = new WgslReflect(code);
    const { kind, layouts } = checks.get(`mesh ground ${name}`);
    const stages = kind === 'compute' ? ['compute'] : ['vertex', 'fragment'];
    for (const stage of stages) {
      assert.equal(reflect.entry[stage].length, 1, `${name}/${stage}`);
      const visibility = { vertex: 1, fragment: 2, compute: 4 }[stage];
      for (const r of reflect.entry[stage][0].resources) {
        if (r.group === 3) { assert.equal(r.binding, 1); continue; }
        const entry = layouts(grid)[r.group].find((e) => e.binding === r.binding);
        assert.ok(entry?.visibility & visibility, `${name}/${stage} misses ${r.name} at ${r.group}:${r.binding}`);
      }
    }
    if (name === 'draw') for (const tex of ['tMat', 'tGI0', 'tGI1', 'tGI2', 'tGI3', 'tGlow', 'lcBuf', 'decoPlane', 'wcPool']) {
      assert.ok(reflect.entry.fragment[0].resources.some((r) => r.name === tex));
    }
    if (name === 'field') {
      assert.equal(reflect.structs.find((s) => s.name === 'Job').size, 32);
      assert.equal(reflect.structs.find((s) => s.name === 'Job').members.find((m) => m.name === 'slot').offset, 12);
    }
  }
  assert.ok(validated.size >= 10);
});

test('raster WGSL evaluates distinct default, Cozy and Noita albedos and painted tint', () => {
  const code = `${meshGroundWGSL(g, true).draw}
@group(0) @binding(19) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn probe() {
  let p = vec3f(5.2, 3.1, 4.8);
  let n = vec3f(0.0, 1.0, 0.0);
  let id = E_STONE;
  let base = matBase(id).alb;
  result[0] = vec4f(base, 1.0);
  result[1] = vec4f(cozyMat(id, p, n, 20.0, 0.0, 0.04).alb, f32(cozySupported(id, 0.0)));
  result[2] = vec4f(noitaMat(id, p, n, 20.0, 0.0, 0.04).alb, f32(noitaSupported(id, 0.0)));
  result[3] = vec4f(decoTint(base, base, vec4f(1.0, 0.0, 0.0, 1.0)), 1.0);
}`;
  const out = new Float32Array(16);
  new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('probe', 1, { 0: { 0: tablesBuffer(), 19: out } });
  const [base, cozy, noita, paint] = Array.from({ length: 4 }, (_, i) => [...out.subarray(i * 4, i * 4 + 4)]);
  assert.equal(cozy[3], 1);
  assert.equal(noita[3], 1);
  assert.notDeepEqual(cozy, base);
  assert.notDeepEqual(noita, base);
  assert.notDeepEqual(cozy, noita);
  assert.deepEqual(paint, [1, 0, 0, 1]);
});

test('oversized indirect args draw nothing in the normal pool and the complete checkerboard on retry', () => {
  const jobs = new Int32Array(8);  // slot 0
  const counts = new Uint32Array([MESH_VCAP, MESH_ICAP]);
  const params = new Uint32Array([1]);
  const args = new Uint32Array(5);
  for (const tier of ['normal', 'overflow']) {
    const code = meshGroundWGSL(g, true, tier).args;
    new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main', 1, { 2: { 0: jobs, 4: counts, 5: args }, 3: { 1: params } });
    assert.equal(args[0], tier === 'normal' ? 0 : MESH_ICAP);
  }
});

function fixture(countFor = () => [3, 6]) {
  globalThis.GPUBufferUsage ??= { COPY_SRC: 4, STORAGE: 128, COPY_DST: 8, INDEX: 16, INDIRECT: 256 };
  globalThis.GPUTextureUsage ??= { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const textures = [], buffers = [], dispatches = [], passDescs = [], drawCalls = [];
  let jobWords;
  const gpu = {
    device: {
      limits: { maxStorageBufferBindingSize: 128 << 20, maxBufferSize: 256 << 20 },
      createSampler: (s) => s,
      queue: { writeBuffer: (buf, offset, jobs, start, count) => { assert.equal(count % 8, 0); jobWords = jobs.slice(start, count); } },
    },
    emptyGroup: {}, stats: { draws: 0 }, flush() {},
    createBuffer: (d) => {
      assert(d.size <= 128 << 20, d.label);
      const b = { ...d, destroy() { this.destroyed = true; } }; buffers.push(b); return b;
    },
    readback: { buffer(b) {
      const counts = new Uint32Array(b.size / 4);
      for (let i = 0; i < jobWords.length; i += 8) counts.set(countFor(jobWords.subarray(i, i + 8)), jobWords[i + 3] * 2);
      return Promise.resolve(counts.buffer);
    } },
    createTexture: (d) => {
      const tex = { ...d, width: d.size[0], height: d.size[1], createView: () => ({ tex }), destroy() { this.destroyed = true; } };
      textures.push(tex);
      return tex;
    },
    layout: (label, entries) => ({ label, entries }),
    bindGroup: (layout, entries) => ({ layout, entries }),
    kernel: (desc) => ({ state: 'ready', ready: Promise.resolve(), dispatch: (_, size, { params }) => dispatches.push({ desc, size, ...params }) }),
    renderPipeline: (desc) => ({ state: 'ready', ready: Promise.resolve(), draw: (_, args) => drawCalls.push({ desc, args }) }),
  };
  const frame = { render(desc) { passDescs.push(desc); return { drawIndexedIndirect() {}, end() {} }; } };
  return { gpu, frame, textures, buffers, dispatches, passDescs, drawCalls };
}

test('recording holds old coverage during retarget, budgets rebuilds and writes sampled hardware depth', async () => {
  const { gpu, frame, textures, dispatches, passDescs, drawCalls } = fixture();
  const copy = { size: [1024, 128, 1024], bindGroup: {}, layout: {}, revision: 0, changesSince: () => [] };
  const m = createMeshGround(gpu, { g, L: { TABLES: {} }, tables: {} }, copy, { bindEntries: () => [] }, { mediaNoise: {} });
  await m.ready;
  const eye = [320, 24, 320], farther = [900, 24, 900];
  m.update(frame, eye);
  assert.equal(m.stats.meshedLast, 4);
  assert.ok(!m.coverageReady, 'counts must land before the first plan commits');
  await m.waitForBuildReadbacks();
  assert.ok(m.coverageReady);
  const matrix = new Matrix4().makeOrthographic(-1000, 2000, 2000, -1000, -2000, 1000, WebGPUCoordinateSystem);
  const S = {};
  assert.ok(m.draw(frame, { views: { S }, w: 640, h: 480 }, {}, matrix));
  assert.equal(m.stats.drawnChunks, 4);
  const depth = m.depthTexture;
  assert.equal(depth.format, 'depth32float');
  assert.equal(depth.usage, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST);
  assert.equal(passDescs.at(-1).depthStencilAttachment.depthStoreOp, 'store');
  assert.equal(passDescs.at(-1).depthStencilAttachment.view, m.depthView);
  assert.equal(m.distanceView.tex.format, 'r32float');
  assert.equal(drawCalls.at(-2).args.index.format, 'uint16');
  assert.equal(drawCalls.at(-1).desc.name, 'mesh ground background');
  m.update(frame, farther);
  assert.equal(m.stats.meshedLast, 16);
  m.draw(frame, { views: { S }, w: 640, h: 480 }, {}, matrix);
  assert.equal(m.stats.drawnChunks, 4, 'old partition remains during staging');
  for (let i = 0; i < 16; i++) { await m.waitForBuildReadbacks(); m.update(frame, farther); }
  m.draw(frame, { views: { S, D: {} }, w: 800, h: 600 }, {}, matrix);
  assert.ok(m.stats.drawnChunks > 4);
  assert.equal(depth.destroyed, true);
  copy.revision++;
  copy.changesSince = () => [{ lo: [900, 20, 900], hi: [904, 24, 904] }];
  m.update(frame, farther);
  assert.ok(m.stats.meshedLast > 0 && m.stats.meshedLast <= 16);
  assert.ok(dispatches.every((d) => d.n <= 16 && d.size[0] <= 1000));
  m.dispose();
  assert.ok(textures.filter((t) => t.format === 'depth32float').every((t) => t.destroyed));
});

test('parked convergence drains change lists and promotes dense chunks before committing coverage', async () => {
  let dense = false, reads = 0;
  const { gpu, frame, buffers, dispatches } = fixture(([x, y, z]) => dense && x === 0 && y === 0 && z === 0
    ? [MESH_VCAP, MESH_ICAP] : [3, 6]);
  const changed = [{ lo: [0, 0, 0], hi: [16, 16, 16] }];
  let dirtyRead = false, landed = false, read;
  const copy = { size: [1024, 128, 1024], bindGroup: {}, layout: {}, revision: 0, changesSince: () => changed,
    get pendingChanges() { return dirtyRead || !!read || landed; },
    waitForChanges: () => read,
  };
  const m = createMeshGround(gpu, { g, L: { TABLES: {} }, tables: {} }, copy, { bindEntries: () => [] }, { mediaNoise: {} });
  const eye = [320, 24, 320];
  const pacer = { settled: true, wake() {}, settleLimit: 2 };
  function render() {
    if (landed) { landed = false; copy.revision++; dense = true; }
    if (dirtyRead) {
      dirtyRead = false;
      read = Promise.resolve().then(() => { reads++; landed = true; read = null; });
    }
    m.update(frame, eye);
  }
  await m.ready;
  m.update(frame, eye);
  await m.waitForBuildReadbacks();
  assert(m.coverageReady);
  assert.equal(buffers.some((b) => b.label.includes('overflow')), false, 'normal terrain uses only the lean pool');
  dirtyRead = true;
  const frames = await settleParkedView(pacer, render, () => ({ mesh: m, worldCopy: copy }));
  assert(frames > 2, 'must not stop after the initial pacing frames');
  assert.equal(reads, 1);
  assert.equal(copy.revision, 1);
  assert(m.coverageReady && !m.busy && m.dirtyCount === 0 && !copy.pendingChanges);
  assert(m.stats.promotions > 0);
  assert(dispatches.some(({ desc }) => desc.name === 'mesh ground args overflow'));
  const full = buffers.find((b) => b.label.includes('overflow 0 indices'));
  assert.equal(full.size, 8 * MESH_ICAP * 2);
  m.dispose();
  assert(full.destroyed);
});
