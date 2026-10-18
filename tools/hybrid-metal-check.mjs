// Focused production opaque-pipeline compiler probe; no app, resources or draws.
// --cpu validates all variants without a browser; native variants share one slot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridDims, LAYOUT } from '../src/shaders/common.js';
import { RENDER_LAYOUT } from '../src/shaders/bindings.js';
import { drawWGSL, FACES_LAYOUT, geometryPipelines } from '../src/shaders/hybrid/geometry.js';
import { hybridMaterialsWGSL, hybridMaterialLayoutEntries, hybridMaterialEntries } from '../src/shaders/hybrid/materials.js';
import { shadowBindingDescriptors } from '../src/shaders/hybrid/shadows.js';
import { createHybridShading } from '../src/gfx/hybrid/shading.js';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const variants = ['full', 'no-reflections'];
const variant = process.argv.find(a => a.startsWith('--variant='))?.split('=')[1] ?? 'full';
const selected = variant.split(',');
assert(selected.every(v => variants.includes(v)) && new Set(selected).size === selected.length,
  `--variant must list ${variants.join(', ')}`);
const cpu = process.argv.includes('--cpu');
const artifacts = mkdtempSync('/tmp/hybrid-metal-');
const g = gridDims({ nx: 128, ny: 128, nz: 128 });
const materials = { shader: hybridMaterialsWGSL, layoutEntries: hybridMaterialLayoutEntries,
  entries: opts => hybridMaterialEntries({ table: {}, albedo: {}, normal: {}, sampler: {} }, opts) };
const shadows = { bindingDescriptors: shadowBindingDescriptors,
  bindings: ({ binding }) => [{}, {}, { buffer: {} }].map((resource, i) => ({ binding: binding + i, resource })) };
const gpu = { device: { createSampler: () => ({}) } };
const sim = { g, derived: { views: { gi: [{}, {}, {}, {}], light: {} } } };
function generate(name) {
  const shading = createHybridShading(gpu, sim, { materials, shadows, controls: { buffer: {} },
    gate: {}, binding: 1, reflections: name !== 'no-reflections' });
  assert.deepEqual(shading.layout.map(e => e.binding), shading.entries.map(e => e.binding));
  assert.equal(new Set(shading.layout.map(e => e.binding)).size, shading.layout.length);
  return { code: drawWGSL(g, { shadingWGSL: shading.wgsl, shade: 'hybridOpaqueShade' }),
    layouts: [RENDER_LAYOUT.FRAME, LAYOUT.STATE_RO, [...FACES_LAYOUT, ...shading.layout], LAYOUT.PARAMS],
    pipeline: geometryPipelines().opaque };
}
let browser, vite, launchedAt;
const browserLog = [];
try {
  const sources = Object.fromEntries((cpu ? variants : selected).map(name => [name, generate(name)]));
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(`${artifacts}/${name}.wgsl`, source.code);
    writeFileSync(`${artifacts}/${name}.json`, JSON.stringify({ layouts: source.layouts, pipeline: source.pipeline }, null, 2));
    const reflected = new WgslReflect(source.code);
    for (const r of [...reflected.uniforms, ...reflected.storage, ...reflected.textures, ...reflected.samplers]) {
      assert(source.layouts[r.group]?.some(e => e.binding === r.binding), `missing layout for ${r.name}`);
    }
    execFileSync('naga', ['--stdin-file-path', `${name}.wgsl`], { input: source.code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`PASS CPU ${name}: production 128³ opaque WGSL/layouts; Naga validated`);
  }
  if (!cpu) {
    vite = await startVite({ port: 58476, harness: true });
    console.log(`GPU plan: ${selected.length} native pipeline compile(s): ${variant}, one Chrome/manual slot, no draws; <=25s total`);
    launchedAt = Date.now();
    browser = await launchBrowser({ channel: 'chrome', lifetimeMs: 25000, browserLog: line => browserLog.push(line) });
    const page = await newTestPage(browser, { mode: 'manual' });
    page.setDefaultTimeout(20000);
    await page.route('**/__metal-probe', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><title>Metal compiler probe</title>' }));
    await page.goto(vite.url('/__metal-probe'));
    const failed = [];
    for (const name of selected) {
    const result = await page.evaluate(async ({ source, mac }) => {
      let device;
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
        const info = adapter.info;
        const identity = [info.vendor, info.architecture, info.device, info.description].join(' ');
        if (mac && (adapter.isFallbackAdapter || info.isFallbackAdapter ||
          !/apple/i.test(identity) || /swiftshader|software|llvmpipe/i.test(identity))) {
          throw new Error(`Expected native Apple adapter, got ${identity}`);
        }
        device = await adapter.requestDevice();
        const errors = [];
        device.addEventListener('uncapturederror', e => errors.push(e.error.message));
        const module = device.createShaderModule({ code: source.code });
        const messages = (await module.getCompilationInfo()).messages;
        const invalid = messages.filter(m => m.type === 'error');
        if (invalid.length) throw new Error(invalid.map(m => `${m.lineNum}:${m.linePos}: ${m.message}`).join('\n'));
        const layout = device.createPipelineLayout({ bindGroupLayouts: source.layouts.map(entries => device.createBindGroupLayout({ entries })) });
        const p = source.pipeline;
        await device.createRenderPipelineAsync({ layout,
          vertex: { module, entryPoint: p.vertex.entry, buffers: p.vertex.buffers ?? [], constants: {} },
          fragment: { module, entryPoint: p.fragment.entry, targets: p.fragment.targets, constants: {} },
          primitive: p.primitive, depthStencil: p.depthStencil, ...(p.multisample ? { multisample: p.multisample } : {}) });
        if (errors.length) throw new Error(errors.join('\n'));
        return { ok: true, adapter: identity };
      } catch (e) { return { ok: false, error: `${e.name}: ${e.message}\n${e.stack ?? ''}` }; }
      finally { device?.destroy(); }
    }, { source: sources[name], mac: process.platform === 'darwin' });
    writeFileSync(`${artifacts}/${name}-result.json`, JSON.stringify(result, null, 2));
    if (!result.ok) {
      failed.push(name);
      console.log(`FAIL native ${name}: ${result.error.split('\n')[0]}`);
    } else console.log(`PASS native ${name}: ${result.adapter}`);
    }
    assert.equal(failed.length, 0, `Native compilation failed: ${failed.join(', ')}; full errors in per-variant result.json`);
  }
} catch (error) {
  const detail = [error.stack ?? String(error), error.stdout, error.stderr].filter(Boolean).join('\n');
  writeFileSync(`${artifacts}/error.txt`, detail);
  console.error(`FAIL hybrid Metal ${cpu ? 'CPU' : variant}: ${String(error.message).split('\n')[0]}\nFull error: ${artifacts}/error.txt`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally {
    await vite?.close();
    if (launchedAt) console.log(`Wall occupancy (before launchBrowser through cleanup): ${Date.now() - launchedAt} ms`);
    writeFileSync(`${artifacts}/browser.log`, browserLog.join('\n'));
    console.log(`Artifacts: ${artifacts}`);
  }
}
