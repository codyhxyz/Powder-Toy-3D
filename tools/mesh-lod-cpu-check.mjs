// CPU only: validate the emitted WGSL and exercise the same planning/recording code as the renderer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Matrix4, WebGPUCoordinateSystem } from 'three/webgpu';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridLayout } from '../src/sim.js';
import { nagaExec } from './naga.mjs';
import {
  createMeshGround, meshGroundWGSL, meshLodPlan, meshChunkDirty, meshSlotCache, meshChunkVisible, meshFrustum,
  MESH_VCAP, MESH_ICAP, MESH_CHUNK, MESH_MAX_LOD, WGSL_CHECK,
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
  for (const size of sizes) {
    cover(size, meshLodPlan(size, null, 192));
    const center = size.map((v) => Math.floor(v * 0.5));
    for (const eye of [center, [3, 2, 4], [size[0] - 9, 24, size[2] - 17], [-110, 20, -70]]) {
      const plan = meshLodPlan(size, eye, 192);
      cover(size, plan);
      assert.ok(plan.length <= 192);
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

test('local indices fit uint16 and quad writes own three aligned u32 words', () => {
  assert.ok(MESH_VCAP > 0 && MESH_VCAP <= 32768);
  assert.equal(MESH_ICAP % 6, 0);
  const v = [MESH_VCAP - 1, MESH_VCAP - 2, 0, 1];
  const buf = new ArrayBuffer(12);
  const pack = (a, b) => a | (b << 16);
  const view = new DataView(buf);
  [pack(v[0], v[1]), pack(v[2], v[0]), pack(v[2], v[3])].forEach((w, i) => view.setUint32(i * 4, w, true));
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getUint16(i * 2, true)), [v[0], v[1], v[2], v[0], v[2], v[3]]);
  assert.equal((383 * MESH_ICAP + (MESH_ICAP - 6)) / 2 + 2, (384 * MESH_ICAP) / 2 - 1);
  assert.ok(384 * MESH_VCAP * 16 <= 128 * 1024 ** 2);
  assert.ok(384 * MESH_ICAP * 2 <= 128 * 1024 ** 2);
});

test('naga validates every emitted WGSL module; reflection verifies layouts and draw bindings', () => {
  const checks = new Map(WGSL_CHECK().map((check) => [check.name, check]));
  const validated = new Set();
  for (const grid of [g, gridLayout(128, 384, 128)]) for (const [name, code] of Object.entries(meshGroundWGSL(grid))) {
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
    if (name === 'draw') for (const tex of ['tMat', 'tGI0', 'tGI1', 'tGI2', 'tGI3', 'tGlow', 'lcBuf']) {
      assert.ok(reflect.entry.fragment[0].resources.some((r) => r.name === tex));
    }
    if (name === 'field') {
      assert.equal(reflect.structs.find((s) => s.name === 'Job').size, 32);
      assert.equal(reflect.structs.find((s) => s.name === 'Job').members.find((m) => m.name === 'slot').offset, 12);
    }
  }
  assert.ok(validated.size >= 10);
});

test('recording holds old coverage during retarget, budgets rebuilds and writes sampled hardware depth', async () => {
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, INDEX: 16, INDIRECT: 256 };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const textures = [], dispatches = [], passDescs = [], drawCalls = [];
  const gpu = {
    device: {
      limits: { maxStorageBufferBindingSize: 128 << 20, maxBufferSize: 256 << 20 },
      createSampler: (s) => s,
      queue: { writeBuffer: (buf, offset, jobs, start, count) => assert.equal(count % 8, 0) },
    },
    emptyGroup: {}, stats: { draws: 0 }, flush() {},
    createBuffer: (d) => ({ ...d, destroy() { this.destroyed = true; } }),
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
  const copy = { size: [1024, 128, 1024], bindGroup: {}, layout: {}, revision: 0, changesSince: () => [] };
  const frame = { render(desc) { passDescs.push(desc); return { drawIndexedIndirect() {}, end() {} }; } };
  const m = createMeshGround(gpu, { g, L: { TABLES: {} }, tables: {} }, copy, { bindEntries: () => [] });
  await m.ready;
  const eye = [320, 24, 320], farther = [900, 24, 900];
  m.update(frame, eye);
  assert.equal(m.stats.meshedLast, 4);
  assert.ok(m.coverageReady);
  const matrix = new Matrix4().makeOrthographic(-1000, 2000, 2000, -1000, -2000, 1000, WebGPUCoordinateSystem);
  const S = {};
  assert.ok(m.draw(frame, { views: { S }, w: 640, h: 480 }, {}, matrix));
  assert.equal(m.stats.drawnChunks, 4);
  const depth = m.depthTexture;
  assert.equal(depth.format, 'depth32float');
  assert.equal(depth.usage, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
  assert.equal(passDescs.at(-1).depthStencilAttachment.depthStoreOp, 'store');
  assert.equal(passDescs.at(-1).depthStencilAttachment.view, m.depthView);
  assert.equal(m.distanceView.tex.format, 'r32float');
  assert.equal(drawCalls.at(-1).args.index.format, 'uint16');
  assert.equal(drawCalls.at(-2).desc.name, 'mesh ground background');
  m.update(frame, farther);
  assert.equal(m.stats.meshedLast, 16);
  m.draw(frame, { views: { S }, w: 640, h: 480 }, {}, matrix);
  assert.equal(m.stats.drawnChunks, 4, 'old partition remains during staging');
  for (let i = 0; i < 16; i++) m.update(frame, farther);
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
