// WebGPU regression: immersed rays, flat/sloping beds, and grazing ripple optics.
// node tools/underwater-check.mjs [--port 18583] [--out /tmp/tpt-underwater]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const port = Number(opt('port', '18583')), out = opt('out', '/tmp/tpt-underwater');
mkdirSync(out, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')
      || m.type() === 'warning' && /WebGPU|GPU (validation|internal)/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?map=empty&paused=1`);
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app, { E, ELEMENTS } = await import('/src/elements.js');
    await a.test.ready();
    a.test.park(); a.autoRes.enabled = false; a.settings.upscale = 'native';
    a.day.fixed = { az: 35, el: 50 };
    window.loadWaterFixture = sloped => {
      const [A, B] = a.sim.blankState();
      for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) {
        const bed = sloped ? 16 + Math.floor((96 - z) * 0.25 + 2 * Math.sin(x / 8)) : 16;
        for (let y = 0; y < Math.max(32, bed); y++) {
          const id = y < bed ? E.SAND : E.WATER, i = a.sim.cellTexel(x, y, z) * 4;
          A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = 0.5;
        }
      }
      a.sim.load(A, B);
    };
    window.waterProbes = new Map();
  });
  const probe = (where, code, points) => page.evaluate(async ({ where, code, points }) => {
    const a = window.__app, gpu = a.gpu;
    const { volumeFrag, volumePipeline, VOLUME_LAYOUTS, VolumeParams, LAYOUT_NAMES } = await import('/src/shaders/render.js');
    const { halfsToFloats } = await import('/src/gpu/readback.js');
    let pipe = window.waterProbes.get(where);
    if (!pipe) {
      const source = volumeFrag(a.sim.g);
      const marker = where === 'start' ? source.indexOf('  for (var i = 0;', source.indexOf('// Entering the box'))
        : where === 'end' ? source.indexOf('// ---- shading, one call site')
        : source.indexOf('  var ro = ro0;', source.indexOf('fn traceView'));
      if (marker < 0) throw new Error(`Missing shader probe: ${where}`);
      const layouts = VOLUME_LAYOUTS();
      pipe = gpu.renderPipeline({
        name: `underwater-${where}`,
        code: source.slice(0, marker) + code + '\n' + source.slice(marker),
        layouts: LAYOUT_NAMES.volume.map((name, i) => gpu.layout(name, layouts[i])),
        params: VolumeParams, ...volumePipeline(),
      });
      await pipe.ready;
      window.waterProbes.set(where, pipe);
    }
    const color = gpu.createTexture({ size: [32, 20], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const depth = gpu.createTexture({ size: [32, 20], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const original = a.vol.pipeline;
    try {
      a.vol.pipeline = () => pipe;
      const rp = gpu.frame.render({
        colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      }, `underwater-${where}`);
      a.vol.draw(rp);
      rp.end();
      const pixels = halfsToFloats(await gpu.readback.texture(color));
      return points.map(([x, y]) => [...pixels.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]);
    } finally {
      a.vol.pipeline = original;
      color.destroy(); depth.destroy();
    }
  }, { where, code, points });
  const points = [4, 16, 27].flatMap(x => [14, 16, 18].map(y => [x, y]));
  for (const sloped of [false, true]) {
    await page.evaluate(sloped => window.loadWaterFixture(sloped), sloped);
    for (const y of [34, 31.8, 28]) {
      await page.evaluate(y => {
        const a = window.__app, T = a.THREE;
        a.camera.position.set(64, y, 96).multiplyScalar(a.scale).add(a.volume.position);
        a.camera.lookAt(new T.Vector3(64, y - 5, 32).multiplyScalar(a.scale).add(a.volume.position));
        a.camera.updateMatrixWorld(); a.post.reset();
      }, y);
      await render(page);
      await page.screenshot({ path: `${out}/${sloped ? 'shore' : 'pool'}-${y}.png` });
      if (y < 32) {
        const starts = await probe('start', `
          return VolumeHit(vec4f(length(rd - rd0), length(ro - ro0),
            length(trans - vec3f(1.0)), select(0.0, 1.0, liq == E_WATER)), 0.0, true);
        `, points);
        for (const [direction, origin, transmission, water] of starts) {
          assert(direction < 1e-5 && origin < 1e-5 && transmission < 1e-5 && water === 1,
            `immersed start invents an interface at y=${y}: ${[direction, origin, transmission, water]}`);
        }
      }
      const beds = await probe('end', 'return VolumeHit(vec4f(f32(hitK), f32(bends), hitP.y, trans.z), 0.0, true);', points);
      for (const [kind, bends, height, transmission] of beds) {
        assert.equal(kind, 2, `sand bed must be hit at y=${y}: ${beds}`);
        assert.equal(bends, y < 32 ? 0 : 1, 'a touching sand bed is not a water-air interface');
        assert(height > 15 && height < (sloped ? 28 : 16.1) && transmission > 0 && transmission <= 1, `invalid bed hit: ${beds}`);
      }
    }
  }
  const optics = await probe('optics', `
    let entering = gFragCoord.x < 16.0;
    let grazing = gFragCoord.y < 10.0;
    let geometric = vec3f(0.0, 1.0, 0.0);
    let incident = normalize(vec3f(select(0.0, 1.0, grazing), select(1.0, -1.0, entering) * select(1.0, 0.005, grazing), 0.0));
    let ripple = normalize(vec3f(select(-0.04, 0.04, entering), 1.0, 0.0));
    let optical = liquidOpticalNormal(incident, ripple, geometric, entering, 1.333);
    let face = select(-optical, optical, entering);
    let transmitted = refract(incident, face, select(1.333, 1.0 / 1.333, entering));
    let tir = dot(transmitted, transmitted) < 1e-6;
    let outgoing = select(transmitted, reflect(incident, face), tir);
    return VolumeHit(vec4f(outgoing.y, reflect(incident, face).y, optical.x, select(0.0, 1.0, tir)), 0.0, true);
  `, [[8, 5], [24, 5], [8, 15], [24, 15]]);
  for (let i = 0; i < optics.length; i++) {
    const [outgoingY, reflectedY, slope, tir] = optics[i], entering = i % 2 === 0;
    assert(entering ? reflectedY > 0 : reflectedY < 0, `wrong reflection side: ${optics[i]}`);
    assert(entering || tir ? outgoingY < 0 : outgoingY > 0, `wrong transmission side: ${optics[i]}`);
    assert(i < 2 ? slope === 0 : Math.abs(slope) > 0.03, 'reject bad grazing normals, retain ordinary ripples');
    assert.equal(tir, i === 1 ? 1 : 0);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS immersed rays, flat/sloping sand contact, grazing optics and TIR. Screenshots: ${out}`);
} finally {
  await browser?.close();
  await server.close();
}
