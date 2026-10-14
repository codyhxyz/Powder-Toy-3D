// One short GPU slot: evaluate production artwork, then encode the swatch
// image on the CPU after closing the browser. Not a gameplay screenshot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { swatchCode, SWATCHES } from './cozy-fixture.mjs';

const size = 144, width = size * SWATCHES.length;
const code = swatchCode(size);
const validation = spawnSync('naga', ['--stdin-file-path', 'cozy-swatches.wgsl'], { input: code, encoding: 'utf8' });
assert.ifError(validation.error);
assert.equal(validation.status, 0, validation.stderr);
const job = {
  label: 'cozy-swatches', code, kind: 'compute', budgetMs: 2500,
  groups: [[{ binding: 0, visibility: 4, buffer: { type: 'storage' }, size: width * size * 16, read: true }]],
  dispatch: [Math.ceil(width / 8), Math.ceil(size / 8)],
};
const vite = await startVite({ port: 54883, harness: true });
let browser, result;
const errors = [];
try {
  browser = await launchBrowser({ lifetimeMs: 10000 });
  const page = await openHarness(browser, vite, '/tools/harness/lib.html', { timeout: 3500, errors });
  console.log('GPU:', await gpuInfo(page));
  result = await page.evaluate(job => window.__harness.run('run', job), job);
  assert(result.ok, JSON.stringify(result));
  assert.deepEqual(errors, []);
  console.log(`Artwork module ${result.moduleMs.toFixed(1)} ms, pipeline ${result.pipelineMs.toFixed(1)} ms`);
} finally {
  if (browser) await browser.close();
  await vite.close();
}
const bytes = Buffer.from(result.outputs['0.0'], 'base64');
const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
assert([...pixels].every(Number.isFinite));
const rgb = Buffer.alloc(width * size * 3);
for (let i = 0; i < width * size; i++) {
  for (let c = 0; c < 3; c++) {
    const linear = Math.max(0, pixels[i * 4 + c]);
    const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    rgb[i * 3 + c] = Math.round(255 * Math.min(1, srgb));
  }
}
for (let tile = 0; tile < SWATCHES.length; tile++) {
  let min = 1, max = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const red = pixels[(y * width + tile * size + x) * 4];
    min = Math.min(min, red); max = Math.max(max, red);
  }
  assert(max - min > 0.003, `${SWATCHES[tile][0]} must show pattern, not a flat shader failure`);
}
mkdirSync('/tmp/tpt-cozy-visual', { recursive: true });
const output = '/tmp/tpt-cozy-visual/materials.png';
const image = spawnSync('magick', ['ppm:-', output], {
  input: Buffer.concat([Buffer.from(`P6\n${width} ${size}\n255\n`), rgb]),
});
assert.ifError(image.error);
assert.equal(image.status, 0, String(image.stderr));
console.log('Left to right:', SWATCHES.map(([name]) => name).join(', '));
console.log(output);
