// CPU only: compile both production shaders, execute their math, and check the pass wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WgslExec, WgslParser, WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { Matrix4, Vector3, WebGPUCoordinateSystem } from 'three';
import { E } from '../src/elements.js';
import { createOpticsOverlay, mediaHalfSize, opticsCameraParams } from '../src/gfx/opticsOverlay.js';
import { tablesBuffer } from '../src/shaders/common.js';
import { WGSL_CHECK, opticsMathWGSL, opticsOverlayWGSL, OpticsParams } from '../src/shaders/world/opticsOverlay.js';
import { WC_OWN, WorldCopyUniforms, WORLD_COPY_LAYOUT, wcLayout } from '../src/shaders/world/copy.js';
import { WC_MIXED, wcWord } from '../src/shaders/world/cellWord.js';
import { nagaExec } from './naga.mjs';

const g = { nx: 128, ny: 128, nz: 128 };
for (const { name, code, layouts } of WGSL_CHECK) {
  test(`${name}: Naga validation and WebGPU resource ABI`, () => {
    const source = code(g);
    nagaExec(source, `${name}.wgsl`);
    nagaExec(code({ nx: 128, ny: 384, nz: 128 }), `${name}-tall.wgsl`);
    const r = new WgslReflect(source);
    assert.deepEqual(r.entry.vertex.map((e) => e.name), ['vs']);
    assert.deepEqual(r.entry.fragment.map((e) => e.name), ['fs']);
    assert.ok(r.storage.length <= 8, 'storage buffer limit');
    assert.ok(r.textures.length <= 16, 'sampled texture limit');
    const groups = [...layouts(), [0, 1].map((binding) => ({ binding, buffer: { type: 'uniform' } }))];
    const bindings = [...r.uniforms, ...r.storage, ...r.textures, ...r.samplers];
    assert.equal(bindings.length, groups.flat().length);
    for (const b of bindings) {
      const e = groups[b.group].find((x) => x.binding === b.binding);
      assert.ok(e, `${b.name} is not in the bind group layout`);
      if (r.uniforms.includes(b)) assert.equal(e.buffer.type, 'uniform');
      if (r.storage.includes(b)) assert.equal(e.buffer.type, 'read-only-storage');
      if (r.samplers.includes(b)) assert.equal(e.sampler.type, 'filtering');
      if (r.textures.includes(b)) {
        assert.equal(e.texture.sampleType, b.type.name.includes('depth') ? 'depth' : 'float');
        assert.equal(e.texture.viewDimension ?? '2d', b.type.name.endsWith('3d') ? '3d' : '2d');
      }
    }
    assert.equal(r.uniforms.find((b) => b.name === 'OP').size, OpticsParams.size);
  });
}

const math = /* wgsl */ `
${opticsMathWGSL}
@group(0) @binding(0) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let sigma = vec3f(0.1, 0.025, 0.0);
  out[0] = vec4f(overlayAttenuation(sigma, 12.0), 1.0);
  out[1] = vec4f(overlayAttenuation(sigma, -1.0), 1.0);
  out[2] = vec4f(overlayAttenuation(sigma, 6.0) * overlayAttenuation(sigma, 6.0), 1.0);
  out[3] = vec4f(f32(overlayBehind(0.8, 0.5, -1.0)), f32(overlayBehind(0.4, 0.5, -1.0)),
                f32(overlayBehind(0.8, 0.5, 0.5)), f32(overlayBehind(0.5, 0.5, -1.0)));
  out[4] = vec4f(f32(overlayBehind(1.0, 0.7, 0.0)), f32(overlayBehind(1.0, 1.0, 0.0)), 0.0, 0.0);
  out[5] = vec4f(overlayDepthWeight(0.2, 0.2, false, false), overlayDepthWeight(0.2, 0.198, false, false),
                overlayDepthWeight(0.2, 0.19, false, false), overlayDepthWeight(0.2, 0.05, false, false));
  out[6] = vec4f(overlayDepthWeight(0.2, 0.001, false, true), overlayDepthWeight(0.001, 0.2, true, false),
                overlayDepthWeight(0.0, 0.0, true, true), overlayDepthWeight(0.198, 0.2, false, false));
  out[7] = vec4f(vec2f(overlayMediaRep(vec2i(2, 3))), overlayMediaCoord(vec2i(3, 5)));
}
`;
const readMath = () => {
  const output = new Float32Array(32);
  new WgslExec(new WgslParser().parse(math)).dispatchWorkgroups('main', 1, { 0: { 0: output } });
  return Array.from({ length: 8 }, (_, i) => [...output.subarray(4 * i, 4 * i + 4)]);
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≉ ${b}`);

test('production WGSL: Beer-Lambert, refraction guard and bilateral weights', () => {
  const [atten, clamped, split, behind, sky, weight, skyWeight, grid] = readMath();
  near(atten[0], Math.exp(-1.2));
  near(atten[1], Math.exp(-0.3));
  assert.equal(atten[2], 1);
  assert.deepEqual(clamped, [1, 1, 1, 1]);
  split.forEach((x, i) => near(x, atten[i]));
  assert.deepEqual(behind, [1, 0, 0, 0]); // background, foreground, sloped plane foreground, coincident
  assert.deepEqual(sky, [1, 0, 0, 0]); // accept clear sky unless front is already at far depth
  assert.equal(weight[0], 1);
  near(weight[1], 0.875 ** 2);
  near(weight[2], 0.375 ** 2);
  assert.equal(weight[3], 0);
  assert.deepEqual(skyWeight.slice(0, 3), [0, 0, 1]);
  near(skyWeight[3], weight[1]);
  assert.deepEqual(grid, [4, 6, 1.5, 2.5]);
});

test('production DDA skips empty hierarchy and uniform rock, then stops at the real opaque depth', () => {
  const L = wcLayout([96, 4, 4]);
  const table = new Uint32Array(L.tableWords);
  const meta = new Uint32Array(L.metaWords);
  const stone = wcWord(E.STONE, 0, 20, 1);
  table[19] = stone;
  table[20] = WC_MIXED;
  table[21] = wcWord(E.WATER, 0, 20, 1);
  meta[19] = WC_OWN.CRISP | WC_OWN.OPAQUE;
  meta[20] = WC_OWN.CRISP | WC_OWN.OPAQUE; // mixed rock and glass: cannot reject on opaque bit
  meta[21] = WC_OWN.SURF;
  meta[L.occ1At] = 1 << 4 | 1 << 5;
  meta[L.occ2At] = 1 << 1;
  const pool = new Uint32Array(64).fill(stone);
  pool[22] = wcWord(E.GLASS, 0, 20, 1); // (2, 1, 1) local to brick x=20
  const source = `${opticsOverlayWGSL(g)}
@group(0) @binding(9) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let rd = vec3f(1.0, 1e-6, 1e-6);
  let before = overlayTrace(OverlayRay(rd, 0.0, 83.0));
  out[0] = vec4f(f32(before.id), before.t, before.exit, f32(before.ax));
  let glass = overlayTrace(OverlayRay(rd, 0.0, 83.5));
  out[1] = vec4f(f32(glass.id), glass.t, glass.exit, f32(glass.ax));
  let water = overlayTrace(OverlayRay(rd, 84.5, 90.0));
  out[2] = vec4f(f32(water.id), water.t, water.exit, f32(water.ax));
}`;
  const out = new Float32Array(12);
  const { size, bricks, n1, n2, occ1At, occ2At } = L;
  new WgslExec(new WgslParser().parse(source)).dispatchWorkgroups('main', 1, {
    0: { 0: tablesBuffer(), 9: out },
    1: { 0: WorldCopyUniforms.pack({ size, bricks, n1, n2, occ1At, occ2At }), 1: table, 2: pool, 3: meta },
    3: { 1: OpticsParams.pack({ eye: [-1, 1.5, 1.5] }) },
  });
  assert.deepEqual([...out], [E.EMPTY, 0, 0, -1, E.GLASS, 83, 83.5, 0, E.WATER, 85, 89, 0]);
});

test('production DDA measures a hanging puddle and a glass wall across mixed and uniform bricks', () => {
  const L = wcLayout([4, 16, 4]);
  const table = new Uint32Array(L.tableWords);
  const meta = new Uint32Array(L.metaWords);
  const water = wcWord(E.WATER, 0, 20, 1), glass = wcWord(E.GLASS, 0, 20, 1);
  const pool = new Uint32Array(64 * 2);
  // One cell of water at y=13, then an air gap below it.
  table[3] = WC_MIXED;
  pool[21] = water;
  // 2 cells below the gap (y=9,8) and 4 more in a full brick.
  table[2] = WC_MIXED | 1;
  pool[64 + 21] = pool[64 + 17] = glass;
  table[1] = glass;
  meta[3] = WC_OWN.SURF;
  meta[1] = meta[2] = WC_OWN.CRISP;
  meta[L.occ1At] = meta[L.occ2At] = 1;
  const src = `${opticsOverlayWGSL(g)}
@group(0) @binding(9) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let rd = vec3f(1e-6, -1.0, 1e-6);
  let puddle = overlayTrace(OverlayRay(rd, 0.0, 14.0));
  let wall = overlayTrace(OverlayRay(rd, 5.0, 14.0));
  let clipped = overlayTrace(OverlayRay(rd, 5.0, 9.5));
  out[0] = vec4f(puddle.t, puddle.exit, wall.t, wall.exit);
  out[1] = vec4f(puddle.exit - puddle.t, wall.exit - wall.t, clipped.exit - clipped.t, 0.0);
}`;
  const out = new Float32Array(8);
  const { size, bricks, n1, n2, occ1At, occ2At } = L;
  new WgslExec(new WgslParser().parse(src)).dispatchWorkgroups('main', 1, {
    0: { 0: tablesBuffer(), 9: out },
    1: { 0: WorldCopyUniforms.pack({ size, bricks, n1, n2, occ1At, occ2At }), 1: table, 2: pool, 3: meta },
    3: { 1: OpticsParams.pack({ eye: [1.5, 16, 1.5] }) },
  });
  assert.deepEqual([...out], [2, 3, 6, 12, 1, 6, 3.5, 0]);
});

test('production ray reconstructs perspective depth in world cells with a large camera origin', () => {
  const eye = new Vector3(100_001, 8_000, -30_000);
  const projection = new Matrix4().makePerspective(-0.5, 0.5, 0.5, -0.5, 0.5, 2048, WebGPUCoordinateSystem);
  const viewProj = projection.clone().multiply(new Matrix4().makeTranslation(-eye.x, -eye.y, -eye.z));
  const invViewProj = viewProj.clone().invert();
  const params = opticsCameraParams({ viewProj, invViewProj, eye, maxDist: 120 });
  const z = new Vector3(8, -4, -16).add(eye).applyMatrix4(viewProj).z;
  const source = `${opticsOverlayWGSL(g)}
@group(0) @binding(9) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let ray = overlayRayAt(vec2f(0.5, -0.25), ${z});
  out[0] = vec4f(ray.rd, ray.stop);
  let sky = overlayRayAt(vec2f(0.0), 1.0);
  out[1] = vec4f(sky.near, sky.stop, clipDepth(OP.eyeToClip * vec4f(ray.rd * ray.stop, 1.0)), 0.0);
}`;
  const out = new Float32Array(8);
  new WgslExec(new WgslParser().parse(source)).dispatchWorkgroups('main', 1, {
    0: { 9: out }, 3: { 1: OpticsParams.pack(params) },
  });
  const t = Math.hypot(8, -4, -16);
  const expected = [8 / t, -4 / t, -16 / t, t, 0.5, 120, z, 0];
  expected.forEach((v, i) => near(out[i], v));
});

test('half-res coverage includes the last pixel on odd and even edges', () => {
  for (const [w, h, expected] of [[1920, 1080, [960, 540]], [1919, 1079, [960, 540]], [1, 1, [1, 1]], [5, 10, [3, 5]]]) {
    const size = mediaHalfSize(w, h);
    assert.deepEqual(size, expected);
    for (const [full, half] of [[w, size[0]], [h, size[1]]]) {
      assert.ok(2 * (half - 1) < full, 'the final representative pixel is in range');
      assert.equal(Math.floor((full - 1) / 2), half - 1, 'the final pixel belongs to the final tile');
    }
  }
});

test('host records media before optics, caches groups, and retires resized textures', async () => {
  const calls = [];
  const pipes = [];
  const gpu = {
    device: { createSampler: () => ({}) },
    layout: (name, entries) => ({ name, entries }),
    renderPipeline: (d) => {
      const pipe = { state: 'building', ready: Promise.resolve(), draw(rp, opts) { calls.push(['draw', rp.name, d, opts]); } };
      pipes.push(pipe);
      return pipe;
    },
    bindGroup: (l, entries) => {
      assert.deepEqual(entries.map((e) => e.binding).sort((a, b) => a - b), l.entries.map((e) => e.binding).sort((a, b) => a - b));
      const group = { layout: l, entries };
      calls.push(['group', group]);
      return group;
    },
    createTexture: (d) => {
      const view = {};
      calls.push(['texture', d, view]);
      return { createView: () => view, destroy: () => calls.push(['destroy', view]) };
    },
    flush: () => calls.push(['submit']),
  };
  const frame = { render(d, name) { calls.push(['pass', name, d]); return { name, end: () => calls.push(['end', name]) }; } };
  const copy = { layout: WORLD_COPY_LAYOUT, bindGroup: {} };
  const light = { bindEntries: () => [8, 9, 10, 11, 12, 14, 15].map((binding) => ({ binding, resource: {} })) };
  const renderer = createOpticsOverlay(gpu, { g }, copy, light);
  const opts = { w: 11, h: 7, frameGroup0: {}, opaqueColorView: {}, opaqueDepthView: {}, outColorView: {}, outDepthView: {},
    invViewProj: new Matrix4(), viewProj: new Matrix4(), eye: [2, 3, 4], maxDist: 120 };
  assert.equal(renderer.render(frame, opts), false);
  assert.deepEqual(calls, []);
  await renderer.ready;
  for (const pipe of pipes) pipe.state = 'ready';
  assert.equal(renderer.render(frame, opts), true);
  const [first, second] = calls.filter(([what]) => what === 'pass');
  assert.equal(first[1], 'world media half');
  assert.equal(second[1], 'world optics overlay');
  assert.equal(second[2].depthStencilAttachment.view, opts.outDepthView);
  assert.equal(second[2].colorAttachments[0].view, opts.outColorView);
  const [created] = calls.filter(([what]) => what === 'texture');
  assert.deepEqual(created[1].size, [6, 4]);
  assert.equal(created[2], first[2].colorAttachments[0].view);
  const [, , spec, draw] = calls.filter(([what]) => what === 'draw')[1];
  assert.equal(spec.depthStencil.depthCompare, 'always');
  assert.equal(draw.params.maxDist, opts.maxDist);
  assert.equal(draw.bind[0], opts.frameGroup0);
  assert.equal(draw.bind[1], copy.bindGroup);
  assert.equal(draw.bind[2].entries.find(({ binding }) => binding === 2).resource, created[2]);

  const count = (what) => calls.filter(([type]) => type === what).length;
  renderer.render(frame, { ...opts, w: 12, h: 8 }); // same half extent, same mock input views
  assert.equal(count('texture'), 1);
  assert.equal(count('group'), 2);
  renderer.render(frame, { ...opts, opaqueColorView: {} });
  assert.equal(count('group'), 3, 'new opaque color only replaces the optics group');
  renderer.render(frame, { ...opts, w: 13 });
  assert.equal(count('texture'), 2);
  assert.equal(count('group'), 5, 'resizing invalidates cached attachments');
  assert.equal(count('destroy'), 0);
  renderer.render(frame, opts);
  assert.equal(count('texture'), 2, 'the previous extent is cached');
  renderer.render(frame, { ...opts, w: 15 });
  assert.equal(count('texture'), 3);
  assert.equal(count('destroy'), 1);
  assert.ok(calls.findIndex(([a]) => a === 'submit') < calls.findIndex(([a]) => a === 'destroy'));
  renderer.dispose();
  renderer.dispose();
  assert.equal(count('destroy'), 3);
  assert.equal(renderer.render(frame, opts), false);
});
