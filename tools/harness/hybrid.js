import { Matrix4, OrthographicCamera, Vector3, WebGPUCoordinateSystem } from 'three';
import { createGpu } from '../../src/gpu/device.js';
import { gridDims, cellSlot, LAYOUT } from '../../src/shaders/common.js';
import { frameUniformsOf, updateGfxUniforms, writeFrameUniforms } from '../../src/gfx/uniforms.js';
import { createHybridRenderer } from '../../src/gfx/hybrid/index.js';
import { createHybridGeometry } from '../../src/gfx/hybrid/geometry.js';
import { E, ELEMENTS, K } from '../../src/elements.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
export async function run() {
  const gpu = await createGpu({ label: 'hybrid core test' });
  window.__harness.gpu = gpu;
  const owned = [];
  let hybrid, overflow;
  try {
    // Full-size numerical fixture. No physics/grid-quality reduction.
    const g = gridDims({ nx: 128, ny: 128, nz: 128 });
    const buffer = (label, size) => { const b = gpu.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); owned.push(b); return b; };
    const A = buffer('hybrid test A', g.slots * 32), B = buffer('hybrid test B', g.slots * 32);
    const fu = frameUniformsOf(gpu);
    const tables = gpu.bindGroup(gpu.layout('TABLES', LAYOUT.TABLES), [{ binding: 0, resource: { buffer: fu.tables } }]);
    const bindRO = gpu.bindGroup(gpu.layout('STATE_RO', LAYOUT.STATE_RO),
      [{ binding: 0, resource: { buffer: A } }, { binding: 1, resource: { buffer: B } }]);
    const gi = gpu.createTexture({ label: 'zero GI probe fixture', size: [32, 32, 32], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    owned.push(gi);
    const views = { gi: Array.from({ length: 4 }, () => gi.createView()), light: gi.createView() };
    const sim = { id: 'hybrid-test', g, tables, bindRO, cur: 0, version: 1, frame: 0,
      origin: { x: 0, y: 0, z: 0 }, derived: { views },
      header() { return { origin: [0, 0, 0], src: 0, dst: 0 }; } };
    const write = (x, id, temperature = 20) => gpu.queue.writeBuffer(A, cellSlot(g, x, 63, 63) * 16, new Float32Array([id, temperature, 0, 0.5]));
    assert(ELEMENTS[E.WALL].kind === K.SOLID, 'fixture must be crisp solid, not falling stone');
    write(63, E.WALL); write(64, E.WALL);
    const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    camera.coordinateSystem = WebGPUCoordinateSystem;
    camera.position.set(64, 63.5, 80); camera.lookAt(64, 63.5, 63); camera.updateProjectionMatrix();
    const model = new Matrix4(), sun = new Vector3(0, 1, 0);
    updateGfxUniforms(sim, sun, [1, 1, 1]);
    writeFrameUniforms(gpu, { camera, model, sun });
    const texture = (format, usage) => {
      const t = gpu.createTexture({ size: [64, 64], format, usage }); owned.push(t); return t;
    };
    const color = texture('rgba16float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const depth = texture('depth32float', GPUTextureUsage.RENDER_ATTACHMENT);
    const p = { sceneDescriptor: () => ({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
    }) };
    hybrid = createHybridRenderer(gpu, sim);
    await hybrid.ready;
    const results = [];
    async function frame(expectedFaces, expectedRebuilt) {
      hybrid.update({ sun, model });
      assert(hybrid.drawOpaque(p), `opaque producer declined: ${hybrid.stats.reason}`);
      const argsRead = gpu.readback.buffer(hybrid.geometry.resources.args, 0, 16);
      const imageRead = gpu.readback.texture(color);
      gpu.flush('hybrid test frame');
      const [argsBytes, image] = await Promise.all([argsRead, imageRead]);
      await gpu.readback.idle();
      const args = [...new Uint32Array(argsBytes)];
      assert(args[0] === 6 && args[1] === expectedFaces, `indirect args ${args}; expected ${expectedFaces} faces`);
      assert(hybrid.geometry.stats.rebuiltBricks === expectedRebuilt,
        `rebuilt ${hybrid.geometry.stats.rebuiltBricks}; expected ${expectedRebuilt}`);
      assert(image.some((v, i) => i % 4 === 3 && v > 0), 'opaque pass produced no covered pixels');
      results.push({ faces: args[1], rebuilt: hybrid.geometry.stats.rebuiltBricks });
    }
    await frame(10, g.nbricks);
    write(64, E.WALL, 1500); sim.version++;
    await frame(10, 0);
    write(64, E.EMPTY); sim.version++;
    await frame(6, 7);
    const draws = gpu.stats;
    overflow = createHybridGeometry(gpu, sim, { facesPerBrick: 1 });
    await overflow.ready; overflow.update();
    const overflowRead = gpu.readback.buffer(overflow.resources.args, 0, 16);
    gpu.flush('hybrid overflow fixture');
    const overflowArgs = [...new Uint32Array(await overflowRead)];
    await gpu.readback.idle();
    assert(overflowArgs[1] === 0 && overflow.stats.overflow, 'overflow did not suppress the entire producer');
    assert(!gpu.failure, String(gpu.failure));
    return { passed: true, grid: [128, 128, 128], results, overflowSuppressed: true, draws };
  } finally {
    try {
      overflow?.dispose(); hybrid?.dispose();
      await gpu.fence().catch(() => {});
    } finally {
      for (const resource of owned) resource.destroy();
      gpu.device.destroy();
    }
  }
}
