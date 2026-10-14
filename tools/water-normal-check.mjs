// Production WGSL normals on analytic fields, plus submerged window-exit alpha.
// node tools/water-normal-check.mjs [--port 55483]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const vite = await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    const localRelay = m.text().includes('ERR_CONNECTION_REFUSED') && /^http:\/\/(?:localhost|127\.0\.0\.1):8787\//.test(m.location().url);
    if (!localRelay && (m.type() === 'error' || m.type() === 'warning' && /WebGPU|GPU (validation|internal)/.test(m.text()))) errors.push(`${m.text()} (${m.location().url})`);
  });
  await page.goto(vite.url('/?map=island&paused=1'));
  await ready(page);
  console.log('GPU:', await gpuInfo(page));
  const normals = await page.evaluate(async () => {
    const a = window.__app;
    await a.test.ready();
    a.test.park();
    const { coreGLSL } = await import('/src/shaders/gfx/core.js');
    const source = coreGLSL(a.sim.g);
    const normal = source.slice(source.indexOf('const NORMAL_STEP:'), source.indexOf('// ---- the opaque meshes'));
    const device = a.gpu.device;
    const code = `
      const CH_LIQUID: i32 = 0;
      var<private> fixture: i32;
      var<private> thin: f32;
      fn cubicShare(p: vec3f, ch: i32) -> f32 { return thin; }
      fn surfChannel(p: vec3f, ch: i32) -> f32 {
        let d = p - vec3f(16.0);
        if (fixture == 0) { return .5 - .1*d.y + .08*d.x*d.y; }
        if (fixture == 1) { return .5 - .1*d.z + .08*d.y*d.z; }
        if (fixture == 2) { return .5 - .1*d.x + .08*d.z*d.x; }
        if (fixture == 3) { return .5 - .1*d.y; }
        if (fixture == 4) { return exp(-dot(d,d)); }
        return .5;
      }
      ${normal}
      @group(0) @binding(0) var<storage, read_write> values: array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
        let i = i32(id.x);
        var channel = 0;
        thin = f32(i / 6); fixture = i % 6;
        if (i >= 12) { channel = 1; thin = f32((i-12)/3); fixture = (i-12)%3; }
        var p = vec3f(16.0);
        if (fixture == 4) { p += vec3f(.35,.1,-.2); }
        values[id.x] = vec4f(surfNormal(p, channel, vec3f(0,1,0)), 1);
      }
    `;
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    if (info.messages.length) throw new Error(JSON.stringify(info.messages.map(m => m.message)));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const values = device.createBuffer({ size: 18*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 18*16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: values } }] }));
      pass.dispatchWorkgroups(18); pass.end();
      encoder.copyBufferToBuffer(values, 0, read, 0, 18*16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      return [...new Float32Array(read.getMappedRange())];
    } finally { values.destroy(); read.destroy(); }
  });
  for (let i = 0; i < 18; i++) {
    const channel = i < 12 ? 0 : 1;
    const thin = channel ? Math.floor((i-12)/3) : Math.floor(i/6);
    const fixture = channel ? (i-12)%3 : i%6;
    const n = normals.slice(i*4, i*4+3);
    assert(n.every(Number.isFinite));
    if (fixture < 3) {
      const expected = [0,0,0]; expected[(fixture+1)%3] = 1;
      // Opaque channels retain the old stencil at both cubic sampling shares.
      if (channel) expected[(fixture+2)%3] = -.8 * (thin ? .25 : .55);
      const length = Math.hypot(...expected);
      n.forEach((v, axis) => assert(Math.abs(v-expected[axis]/length) < 1e-4, `normal case ${i}, axis ${axis}: ${n}`));
    } else if (fixture === 4) {
      const radial = [.35,.1,-.2];
      assert(n.reduce((s,v,j) => s+v*radial[j], 0)/Math.hypot(...radial) > .995, `round drop: ${n}`);
    } else {
      assert(Math.abs(n[1]-1) < 1e-5 && Math.abs(n[0])+Math.abs(n[2]) < 1e-5);
    }
  }
  // Continuous water, reaching the local world window's sides. Grazing rays
  // leave submerged; probe the production trace's final transmission.
  await page.evaluate(async () => {
    const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js');
    a.autoRes.enabled = false; a.settings.upscale = 'native';
    a.day.fixed = { az: 35, el: 50 };
    const [A,B] = a.sim.blankState();
    const { nx, nz } = a.sim.g;
    for (let z=0; z<nz; z++) for (let x=0; x<nx; x++) {
      const top = 32 + Math.round(8*Math.exp(-(((x-64)/14)**2)));
      for (let y=0; y<top; y++) {
        const id = y<4 ? E.SAND : E.WATER, i = a.sim.cellTexel(x,y,z)*4;
        A[i]=id; A[i+1]=ELEMENTS[id].temp; A[i+2]=ELEMENTS[id].life; A[i+3]=.5;
      }
    }
    a.sim.load(A,B);
    a.camera.position.set(64,42,112).multiplyScalar(a.scale).add(a.volume.position);
    a.camera.lookAt(new a.THREE.Vector3(64,31,0).multiplyScalar(a.scale).add(a.volume.position));
    a.camera.updateMatrixWorld(); a.post.reset();
  });
  await render(page);
  const exits = await page.evaluate(async () => {
    const a = window.__app, gpu = a.gpu;
    const { volumeFrag, volumePipeline, VOLUME_LAYOUTS, VolumeParams, LAYOUT_NAMES } = await import('/src/shaders/render.js');
    const { halfsToFloats } = await import('/src/gpu/readback.js');
    const source = volumeFrag(a.sim.g);
    const marker = source.indexOf('  // only thin gas:');
    if (marker < 0) throw new Error('Missing transmission probe marker');
    const probe = `
      return VolumeHit(vec4f(select(0.0, 1.0, FU.far != 0u && liq != E_EMPTY && outside(cell) && cell.y >= 0 && cell.y < NY),
        1.0 - dot(trans, vec3f(1.0/3.0)), f32(FU.far), 1.0), 0.0, true);
    `;
    const layouts = VOLUME_LAYOUTS();
    const pipe = gpu.renderPipeline({
      name: 'water-window-exit', code: source.slice(0,marker)+probe+source.slice(marker),
      layouts: LAYOUT_NAMES.volume.map((name,i) => gpu.layout(name,layouts[i])),
      params: VolumeParams, ...volumePipeline(),
    });
    await pipe.ready;
    const color = gpu.createTexture({ size:[64,40], format:'rgba16float', usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC });
    const depth = gpu.createTexture({ size:[64,40], format:'depth32float', usage:GPUTextureUsage.RENDER_ATTACHMENT });
    const original = a.vol.pipeline;
    try {
      a.vol.pipeline = () => pipe;
      const rp = gpu.frame.render({
        colorAttachments:[{ view:color.createView(), loadOp:'clear', storeOp:'store', clearValue:[0,0,0,0] }],
        depthStencilAttachment:{ view:depth.createView(), depthLoadOp:'clear', depthStoreOp:'store', depthClearValue:1 },
      }, 'water-window-exit');
      a.vol.draw(rp); rp.end();
      const pixels = halfsToFloats(await gpu.readback.texture(color));
      let count=0, leaks=0;
      for (let i=0; i<pixels.length; i+=4) if (pixels[i]===1) {
        count++; if (pixels[i+1]<.999) leaks++;
      }
      return { count, leaks };
    } finally { a.vol.pipeline=original; color.destroy(); depth.destroy(); }
  });
  assert(exits.count > 20, `fixture must exercise submerged world exits: ${JSON.stringify(exits)}`);
  assert.equal(exits.leaks, 0, 'submerged exits must not reveal the original background');
  assert.deepEqual(errors, []);
  console.log(`PASS: 18 GPU normal cases; ${exits.count} submerged window exits, zero background leaks.`);
} finally { await browser?.close(); await vite.close(); }
