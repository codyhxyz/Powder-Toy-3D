// Current-world CPU geometry, shaded by the production Cozy WGSL on the GPU.
// No full-game boot, physics, plain palette, or replacement texture artwork.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { willowCove, willowCoveTwin } from '../src/world/scenes/willowCove.js';
import { E } from '../src/elements.js';
import { compositeWGSL } from '../src/gfx/post.js';
import { cozyFixture } from './cozy-fixture.mjs';
import { trace } from './descent-thumb.mjs';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const unit = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const SUN = unit([-0.55, 0.8, 0.35]), FOV = Math.tan(Math.PI / 8);

export function geometry(size = 800) {
  const dims = willowCove.size;
  const params = willowCove.params({ size: dims, seed: 20261008 }), twin = willowCoveTwin(params);
  const tops = new Int16Array(dims[0] * dims[2]).fill(-1), ids = new Uint16Array(tops.length);
  const cell = (x, y, z) => {
    const i = x + dims[0] * z;
    if (tops[i] < 0) {
      let top = dims[1];
      while (top && twin.wcCell(x, top - 1, z) === E.EMPTY) top--;
      tops[i] = top; ids[i] = top ? twin.wcCell(x, top - 1, z) : E.EMPTY;
    }
    return y >= tops[i] ? E.EMPTY : y === tops[i] - 1 ? ids[i] : twin.wcCell(x, y, z);
  };
  const offset = unit(willowCove.view.dir), target = [dims[0] / 2 - 160, 24, dims[2] / 2 - 100];
  const eye = target.map((x, i) => x + offset[i] * willowCove.view.dist * 6.5);
  const forward = offset.map(x => -x), right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const hits = new Float32Array(size * size * 12), materials = new Set();
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const u = (2 * (px + 0.5) / size - 1) * FOV, v = (1 - 2 * (py + 0.5) / size) * FOV;
    const direction = unit(forward.map((x, i) => x + right[i] * u + up[i] * v));
    const hit = trace(eye, direction, dims, cell);
    const distance = hit?.distance ?? (params.sea - eye[1]) / direction[1];
    const id = hit?.id ?? (distance > 0 ? E.WATER : E.EMPTY);
    const p = eye.map((x, i) => x + direction[i] * distance), normal = hit?.normal ?? [0, 1, 0];
    let shore = 0;
    if (id === E.WATER) for (const step of [2, 4, 8, 12]) {
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const x = Math.floor(p[0] + dx), z = Math.floor(p[2] + dz);
        if (x < 0 || z < 0 || x >= dims[0] || z >= dims[2]) continue;
        const neighbor = twin.wcCell(x, Math.floor(p[1]), z);
        if (neighbor !== E.WATER && neighbor !== E.EMPTY) shore = Math.max(shore, 1 - step / 16);
      }
    }
    const shadow = hit && dot(normal, SUN) > 0
      && trace(p.map((x, i) => x + normal[i] * 0.001), SUN, dims, cell);
    hits.set([...p, id, ...normal, 0, shadow ? 0 : 1, shore, distance * 2 * FOV / size, 0], (py * size + px) * 12);
    materials.add(id);
  }
  return { hits, materials };
}

export function shader(size) {
  const composite = compositeWGSL();
  const tone = composite.slice(composite.indexOf('const SRGB_TO_REC2020:'), composite.indexOf('// AgX desaturates'));
  return `${cozyFixture}
${composite.match(/const LUMA_709:[^\n]+/)[0]}
struct FixturePost { look: f32 }
var<private> P: FixturePost;
${tone}
struct Hit { p: vec4f, n: vec4f, extra: vec4f }
@group(0) @binding(0) var<storage, read> hits: array<Hit>;
@group(0) @binding(1) var<storage, read_write> pixels: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= ${size}u || gid.y >= ${size}u) { return; }
  let i = gid.y * ${size}u + gid.x;
  let h = hits[i]; let id = i32(h.p.w); let fp = max(h.extra.z, 0.001);
  let sky = vec3f(0.32, 0.53, 0.7);
  FU.time = 4.0; P.look = 0.5;
  var colour = sky;
  if (id != E_EMPTY) {
    let sun = normalize(vec3f(${SUN.join(',')}));
    if (id == E_WATER) {
      let paint = cozyWaterPaint(h.p.xyz, fp, h.extra.y);
      let normal = cozyWaterNormal(h.p.xyz, vec3f(0.0, 1.0, 0.0), fp);
      let light = 0.7 + max(dot(normal, sun), 0.0) * h.extra.x;
      colour = paint.rgb * light * paint.a + vec3f(0.02, 0.12, 0.22) * (1.0 - paint.a);
    } else {
      let mat = cozyMat(id, h.p.xyz, h.n.xyz, 20.0, 0.0, fp);
      let normal = normalize(h.n.xyz - mat.g + h.n.xyz * dot(mat.g, h.n.xyz));
      colour = mat.alb * (0.65 + max(dot(normal, sun), 0.0) * h.extra.x * 1.3) + mat.emit;
    }
    colour = mix(colour, sky, 0.04);
  }
  pixels[i] = vec4f(agx(colour), 1.0);
}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const size = 800, started = performance.now();
  const { hits, materials } = geometry(size);
  assert(materials.has(E.WOOD) && materials.has(E.BRICK) && materials.has(E.WATER));
  console.log(`Current-map geometry: ${((performance.now() - started) / 1000).toFixed(2)}s CPU; ${materials.size} materials`);
  const job = {
    label: 'willow-cozy-preview', code: shader(size), kind: 'compute', budgetMs: 5000,
    groups: [[
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' }, data: Buffer.from(hits.buffer).toString('base64') },
      { binding: 1, visibility: 4, buffer: { type: 'storage' }, size: size * size * 16, read: true },
    ]], dispatch: [Math.ceil(size / 8), Math.ceil(size / 8)],
  };
  const vite = await startVite({ port: 55197, harness: true });
  let browser, result;
  try {
    browser = await launchBrowser({ lifetimeMs: 15000 });
    const page = await openHarness(browser, vite, '/tools/harness/lib.html', { timeout: 5000 });
    console.log('GPU:', await gpuInfo(page));
    result = await page.evaluate(job => __harness.run('run', job), job);
    assert(result.ok, JSON.stringify({ ...result, outputs: undefined }));
  } finally {
    await browser?.close();
    await vite.close();
  }
  const bytes = Buffer.from(result.outputs['0.1'], 'base64');
  const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), rgb = Buffer.alloc(size * size * 3);
  assert(pixels.every(Number.isFinite));
  for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) {
    const linear = Math.max(0, pixels[i * 4 + c]);
    const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    rgb[i * 3 + c] = Math.round(255 * Math.min(1, srgb));
  }
  const file = fileURLToPath(new URL('../public/maps/willowCove.webp', import.meta.url));
  const args = ['ppm:-', '-quality', '85', file], input = Buffer.concat([Buffer.from(`P6\n${size} ${size}\n255\n`), rgb]);
  try { execFileSync('magick', args, { input }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; execFileSync('convert', args, { input }); }
  console.log(`Production Cozy materials, bump, water and tone mapper → ${file}`);
}
