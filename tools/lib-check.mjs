// The render library on a real WebGPU device (docs/webgpu.md J1 U3, I1):
//   probes   every probe kernel (shaders/gfx/lib.js LIB_PROBES: each calls
//            every function its modules export, in its L.LIGHTING variant and
//            stage) validates with no error or warning, builds within
//            PIPELINE_BUDGET_MS at the smallest grid and runs once
//   values   spot values against a JS reference: the noise (hash13, hash33,
//            vnoise, fbm3, ign, with f32 rounding at every step), the sky
//            (skyRadiance, skyColor, skyAmbient: gfx/sky.js's model), sunBasis
//            (the shadow map's frame, with the window's texel snap), the SH
//            evaluation (giIrradiance, giRadiance, giSkyVis), the 3D-texture
//            readers against a CPU trilinear and cubic B-spline on a
//            non-cubic grid (fieldTex, mediaField, fieldCubic, probeTex,
//            probeAt, surfProbe, sampleLight: texel (x, y, z) is cell or
//            brick (x, y, z), edges clamped, each GI band its own volume),
//            GI's sun lookups (the GI variants' sunShadowAt and
//            sunMapShadowAt see no caustics, whatever FU.caustics, FU.time
//            and FU.frame say, docs/webgpu.md E), and the far grid's texel
//            (farUnpack and farPackTexel against farShared.js's JS twins);
//            and main's sync-2 changes: the cubic channels (cubicShare,
//            surfSample, surfChannel, cubicClose with DETAIL_CUBIC_CLOSE on
//            and off), the air's sky share (giAirSkyVis), the far field's sky
//            (farSkyOpen; farBeyond gated by it and blocked under a cave's
//            roof), the lit haze (farAirLit, farHaze, farHazePremul), the
//            mesh cut's depth to ray distance (meshCutAt, WebGPU's clip depth
//            and y-down pixels) and the near field's bounce off a lit lamp;
//            and main's sync-3 changes: a scene's ambient floor in
//            giIrradiance and giRadiance (none in the GI variants), the wall
//            torches' fixed lamps in lampLight (lit while the torch is there,
//            not on its own head, not shaded by its own cell)
// It serves tools/harness/lib.html from its own Vite (tools/vite-server.mjs:
// --port N, else a free port) and launches Chromium through tools/browser.mjs.
//   node tools/lib-check.mjs [--port N] [--only probes,values] [--budget ms]
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => import(pathToFileURL(join(ROOT, 'src', p)));
const [libM, common, bindings, farM, skyM, kernels, elementsM, lightingM, materialsM, detailM, elecM] = await Promise.all([
  src('shaders/gfx/lib.js'), src('shaders/common.js'), src('shaders/bindings.js'), src('shaders/farShared.js'),
  src('gfx/sky.js'), src('gpu/kernels.js'), src('elements.js'), src('shaders/gfx/lighting.js'), src('gfx/materials.js'),
  src('gfx/detail.js'), src('electricity.js')]);
const { lib, libProbe, libProbeLayouts, LIB_PROBES } = libM;

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const ONLY = opt('--only')?.split(',') ?? ['probes', 'values'];
const BUDGET = Number(opt('--budget') ?? kernels.PIPELINE_BUDGET_MS);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};

// ---------------------------------------------------------------- grids and data
async function gridOf(nx, ny, nz) {
  try {
    const { gridLayout } = await src('sim.js');
    return gridLayout(nx, ny, nz);
  } catch {
    return { nx, ny, nz };
  }
}
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const fromB64 = (s) => { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); };
const f32s = (s) => new Float32Array(fromB64(s).buffer);

// f32 → binary16 (round to nearest even; the test data is exact in f16 anyway)
function toHalf(x) {
  const f = new Float32Array([x]), u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000, e = ((u >>> 23) & 0xff) - 127 + 15, m = u & 0x7fffff;
  if (e <= 0) return sign;   // (no subnormals in the test data)
  if (e >= 31) return sign | 0x7c00;
  let h = sign | (e << 10) | (m >>> 13);
  const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;
  return h;
}

// FrameUniforms and the header, packed as the GPU reads them
function frameBytes(values) {
  const buf = new ArrayBuffer(bindings.FrameUniforms.size);
  bindings.FrameUniforms.write(new DataView(buf), 0, values);
  return new Uint8Array(buf);
}
function headerBytes(origin = [0, 0, 0]) {
  const buf = new ArrayBuffer(common.Header.size);
  common.Header.write(new DataView(buf), 0, { origin, src: 0, dst: 0 });
  return new Uint8Array(buf);
}
const TABLES = b64(new Uint8Array(common.tablesBuffer()));
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const SUN = norm([0.4, 0.75, 0.3]);
// sky values the way gfx/sky.js computes them for this sun (sunExt; skyUp and ground: any)
const TAU_AIR = skyM.SKY.tauRayleigh.map((t) => t + skyM.SKY.tauAerosol);
const sunExtOf = (sun) => TAU_AIR.map((t) => Math.exp(-t * skyM.airMass(sun[1])));
const FRAME = {
  sun: SUN, sunExt: sunExtOf(SUN), sunCol: [1.2, 1.1, 0.9], skyUp: [0.3, 0.4, 0.6], ground: [0.1, 0.09, 0.08],
  keyLight: [1, 1, 1], lightGain: 1, shadowRes: 128, frame: 7, time: 3.5, cam: [10, 20, 30],
  shadows: 1, nearGI: 1, glowLights: 1, caustics: 1, clouds: 0, far: 0,
};

/**
 * A job's groups: the layout entries of a probe layout, with data. extra:
 * { 'group.binding': { data | size | read | tex | samp } }.
 */
function groupsFor(layouts, { frame = FRAME, origin = [0, 0, 0], io = null, ioSize = 256, extra = {} } = {}) {
  const fill = {
    '0.0': { data: TABLES }, '0.1': { data: b64(frameBytes(frame)) },
    '3.0': { data: b64(headerBytes(origin)) }, '3.1': { size: 256 },
    '3.2': io ? { data: b64(new Uint8Array(io.buffer)), read: true } : { size: ioSize, read: true },
    '2.15': { samp: { address: 'repeat' } },
    ...extra,
  };
  return layouts.map((entries, gi) => entries.map((e) => ({ ...e, ...(fill[`${gi}.${e.binding}`] ?? {}) })));
}

// ---------------------------------------------------------------- f32 references
const F = Math.fround;
const fract = (x) => F(x - Math.floor(x));
const mixF = (a, b, t) => F(F(a * F(1 - t)) + F(b * t));
function hash13([x0, y0, z0]) {
  const S = F(0.1031), M = F(31.32);
  let x = fract(F(F(x0) * S)), y = fract(F(F(y0) * S)), z = fract(F(F(z0) * S));
  const d = F(F(F(x * F(z + M)) + F(y * F(y + M))) + F(z * F(x + M)));
  x = F(x + d); y = F(y + d); z = F(z + d);
  return fract(F(F(x + y) * z));
}
function hash33([x0, y0, z0]) {
  const M = F(33.33);
  let x = fract(F(F(x0) * F(0.1031))), y = fract(F(F(y0) * F(0.1030))), z = fract(F(F(z0) * F(0.0973)));
  const d = F(F(F(x * F(y + M)) + F(y * F(x + M))) + F(z * F(z + M)));
  x = F(x + d); y = F(y + d); z = F(z + d);
  return [fract(F(F(x + y) * z)), fract(F(F(x + x) * y)), fract(F(F(y + x) * x))];
}
function vnoise(p) {
  const i = p.map(Math.floor), f = p.map((v) => fract(F(v))), u = f.map((v) => F(F(v * v) * F(3 - F(2 * v))));
  const h = (dx, dy, dz) => hash13([i[0] + dx, i[1] + dy, i[2] + dz]);
  return mixF(mixF(mixF(h(0, 0, 0), h(1, 0, 0), u[0]), mixF(h(0, 1, 0), h(1, 1, 0), u[0]), u[1]),
    mixF(mixF(h(0, 0, 1), h(1, 0, 1), u[0]), mixF(h(0, 1, 1), h(1, 1, 1), u[0]), u[1]), u[2]);
}
const fbm3 = (p) => F(F(F(0.5 * vnoise(p)) + F(F(0.3) * vnoise(p.map((v) => F(F(v * F(2.03)) + F(17.1))))))
  + F(F(0.2) * vnoise(p.map((v) => F(F(v * F(4.01)) + F(31.7))))));
function ign([x, y], frame) {
  const sh = F(F(5.588238) * F(frame - 64 * Math.floor(frame / 64)));
  const px = F(x + sh), py = F(y + sh);
  return fract(F(F(52.9829189) * fract(F(F(F(0.06711056) * px) + F(F(0.00583715) * py)))));
}

// double references (the formulas are short; the tolerance covers f32)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function skyRadiance(d, fr) {
  const { SKY, airMass } = skyM;
  const mu = dot(d, fr.sun), mv = airMass(d[1]), ms = airMass(fr.sun[1]);
  const pR = (3 / (16 * 3.14159265)) * (1 + mu * mu);
  const g = SKY.aerosolG, g2 = g * g;
  const pM = (1 - g2) / (4 * 3.14159265 * Math.pow(1 + g2 - 2 * g * mu, 1.5));
  const dm = mv - ms;
  return TAU_AIR.map((t, k) => {
    const ev = Math.exp(-t * mv);
    const path = Math.abs(dm) < 1e-3 ? t * mv * ev : (mv * (fr.sunExt[k] - ev)) / dm;
    return fr.keyLight[k] * SKY.multi * 3.14159265 * SKY.sunTOA * (SKY.tauRayleigh[k] * pR + SKY.tauAerosol * pM) / t * path;
  });
}
const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const skyColor = (d, fr) => { const s = skyRadiance(d, fr), t = smoothstep(-0.02, 0.02, d[1]); return fr.ground.map((g, k) => g * (1 - t) + s[k] * t); };
const skyAmbient = (n, fr) => { const up = 0.5 + 0.5 * n[1]; return fr.skyUp.map((s, k) => up * s + (1 - up) * fr.ground[k]); };
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
function sunBasis(grid, sun, res, origin) {
  const c = grid.map((n) => n * 0.5), R = 0.5 * Math.hypot(...grid) + 1;
  const u = norm(cross([0, 1, 0], sun)), v = cross(sun, u);
  const T = 2 * R / Math.max(res, 1);
  const ot = [dot(origin, u) / T, dot(origin, v) / T];
  const snap = ot.map((o) => (roundEven(o) - o) * T);
  return { c: c.map((x, k) => x + snap[0] * u[k] + snap[1] * v[k]), R, u, v };
}
const SH = { Y0: lightingM.SH_Y0, Y1: lightingM.SH_Y1, COS1: 2 / 3, OPEN_DC: lightingM.SKYVIS_OPEN_DC };
function shRef(c0, cx, cy, cz, n, blur) {
  const band1 = (k) => cx[k] * n[0] + cy[k] * n[1] + cz[k] * n[2];
  const irr = [0, 1, 2].map((k) => Math.max(SH.Y0 * c0[k] + SH.COS1 * SH.Y1 * band1(k), 0));
  const k1 = SH.Y1 * (1 + (SH.COS1 - 1) * blur);
  const rad = [0, 1, 2].map((k) => Math.max(SH.Y0 * c0[k] + k1 * band1(k), 0));
  const vis = Math.min(Math.max((SH.Y0 * c0[3] + SH.COS1 * SH.Y1 * band1(3)) / Math.max(0.5 + 0.5 * n[1], 0.05), 0), 1);
  return { irr, rad, vis };
}

// a 3D volume (x fastest) and its CPU readers, as the shaders read it
function volume(size, fn) {
  const [w, h, d] = size, data = new Float32Array(w * h * d * 4);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y, z), 4 * (x + w * (y + h * z)));
  const at = (x, y, z) => { const i = 4 * (Math.min(Math.max(x, 0), w - 1) + w * (Math.min(Math.max(y, 0), h - 1) + h * Math.min(Math.max(z, 0), d - 1))); return data.subarray(i, i + 4); };
  // trilinear at texel-space point q (centres at +0.5), q already held to [0.5, n - 0.5]
  const tri = (q) => {
    const u = q.map((v) => v - 0.5), i = u.map(Math.floor), f = u.map((v, k) => v - i[k]);
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 8; c++) {
      const o = [c & 1, (c >> 1) & 1, c >> 2];
      const wgt = o.reduce((m, b, k) => m * (b ? f[k] : 1 - f[k]), 1);
      const t = at(i[0] + o[0], i[1] + o[1], i[2] + o[2]);
      for (let k = 0; k < 4; k++) out[k] += wgt * t[k];
    }
    return out;
  };
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
  return { size, at, tri, tex: { format: 'rgba16float', size, data: b64(new Uint8Array(half.buffer)) } };
}
const clampV = (p, lo, hi) => p.map((v, k) => Math.min(Math.max(v, lo[k]), hi[k]));
// cubic B-spline of a cell field at grid point p, the grid extended by its edge
function cubic(vol, p) {
  const c = clampV(p, [0.5, 0.5, 0.5], vol.size.map((n) => n - 0.5)).map((v) => v - 0.5);
  const i = c.map(Math.floor), f = c.map((v, k) => v - i[k]);
  const w = f.map((t) => [(1 - t) ** 3 / 6, (4 - 6 * t * t + 3 * t ** 3) / 6, (1 + 3 * t + 3 * t * t - 3 * t ** 3) / 6, t ** 3 / 6]);
  const out = [0, 0, 0, 0];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let e = 0; e < 4; e++) {
    const wgt = w[0][a] * w[1][b] * w[2][e], t = vol.at(i[0] - 1 + a, i[1] - 1 + b, i[2] - 1 + e);
    for (let k = 0; k < 4; k++) out[k] += wgt * t[k];
  }
  return out;
}

// giAirSkyVis: band 0's sky visibility against the open sky's, clamped to
// [0, 1]; outside the grid (no probes) open
function airSkyRef(gi0, grid, p) {
  if (p.some((v, k) => v < 0 || v > grid[k])) return 1;
  const bricks = grid.map((n) => n / 4);
  const q = clampV(p.map((v) => v / 4), [0.5, 0.5, 0.5], bricks.map((n) => n - 0.5));
  return Math.min(Math.max((SH.Y0 * gi0.tri(q)[3]) / SH.OPEN_DC, 0), 1);
}
// farAirLit: Simpson's rule over a → b, the far end GI_OFFSET back toward a
function airLitRef(sky, a, b) {
  const v = b.map((x, k) => x - a[k]), d = Math.hypot(...v);
  const bo = b.map((x, k) => x - v[k] * (Math.min(3, d) / Math.max(d, 1e-6)));
  return (sky(a) + 4 * sky(a.map((x, k) => 0.5 * (x + bo[k]))) + sky(bo)) / 6;
}
// the haze's air light toward rd (farAir) and transmittance over d cells
const farAirRef = (rd, fr) => {
  if (rd[1] > 0) return skyRadiance(rd, fr);
  const h = [rd[0], 0, rd[2]], l2 = h[0] * h[0] + h[2] * h[2];
  return skyRadiance(l2 > 1e-8 ? h.map((x) => x / Math.sqrt(l2)) : [1, 0, 0], fr);
};
const FAR_HAZE_WGSL = Number(farM.FAR_HAZE.toExponential(4));   // as farHazeFor writes it
const hazeT = (d) => TAU_AIR.map((t) => Math.exp(-FAR_HAZE_WGSL * (t / TAU_AIR[1]) * d));
// 4×4 matrices, column-major arrays of 16 (as WGSL's mat4x4f): product and inverse
const mmul = (a, b) => Array.from({ length: 16 }, (_, i) => {
  const c = i >> 2, r = i & 3;
  return a[r] * b[4 * c] + a[4 + r] * b[4 * c + 1] + a[8 + r] * b[4 * c + 2] + a[12 + r] * b[4 * c + 3];
});
const mvec = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
function minv(m) {
  // Gauss-Jordan on the row-major copy
  const a = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[4 * c + r]).concat([0, 1, 2, 3].map((c) => (c === r ? 1 : 0))));
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k]; }
  }
  return Array.from({ length: 16 }, (_, i) => a[i & 3][4 + (i >> 2)]);
}

// largest |got - want| over a list of vectors, and where
function worst(got, want) {
  let max = 0, at = -1;
  for (let i = 0; i < want.length; i++) for (let k = 0; k < want[i].length; k++) {
    const e = Math.abs(got[i][k] - want[i][k]);
    if (!(e <= max)) { max = e; at = i; }
  }
  return { max, at };
}
const fmt = (x) => (x === 0 ? '0' : x.toExponential(2));

// ---------------------------------------------------------------- the run
const vite = await startVite({ harness: true });
const browser = await launchBrowser();
try {
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/lib.html', { errors });
  const info = await gpuInfo(page);
  console.log(`lib-check: gpu ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; budget ${BUDGET} ms`);
  const run = (job) => page.evaluate((j) => window.__harness.run('run', j), { budgetMs: BUDGET, ...job });
  const msgs = (r) => r.messages.filter((m) => m.type !== 'info').map((m) => `${m.type} ${m.line}:${m.col} ${m.text}`).slice(0, 6).join(' | ');
  const ranOk = (name, r) => check(name, r.ok && !msgs(r), r.ok ? msgs(r) : `${r.stage}: ${r.error}${msgs(r) ? ` (${msgs(r)})` : ''}`);

  // -------------------------------------------------------------- probes
  if (ONLY.includes('probes')) {
    const g = await gridOf(32, 32, 32);
    console.log('\nprobes: every exported function, built and run once at 32³');
    let total = 0;
    for (const name of LIB_PROBES) {
      const code = libProbe(g, name);
      const fragment = name === 'lib.fragment';
      const r = await run({ label: name, code, kind: fragment ? 'render' : 'compute', groups: groupsFor(libProbeLayouts(name)) });
      total += r.pipelineMs;
      ranOk(`${name}: ${code.split('\n').length} lines, module ${r.moduleMs.toFixed(0)} ms, pipeline ${r.pipelineMs.toFixed(0)} ms`, r);
      if (r.ok && !fragment && name !== 'lib.gisrc') {
        const out = f32s(r.outputs['3.2']).slice(12, 16);
        check(`${name}: result written`, Array.from(out).some((x) => x !== 0), `acc = ${Array.from(out).map((x) => x.toPrecision(4)).join(', ')}`);
      }
    }
    console.log(`     pipelines ${total.toFixed(0)} ms in all`);
  }

  // -------------------------------------------------------------- values
  if (ONLY.includes('values')) {
    // a non-cubic grid, so a swapped axis shows
    const g = await gridOf(32, 16, 24);
    const head = lib(g);
    const layouts = libProbeLayouts('lib.lighting');
    const kernel = (n, body, top = head) => `${top}
@group(3) @binding(2) var<storage, read_write> io: array<vec4f>;
const NIN: u32 = ${n}u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= NIN) { return; }
  gFragCoord = vec2f(0.5);
${body}
}`;
    const rand = (() => { let s = 0x2545f491; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
    console.log('\nvalues (grid 32×16×24)');

    // noise, f32 at every step
    {
      const N = 512, io = new Float32Array(N * 4 * 3);
      const pts = [];
      for (let i = 0; i < N; i++) {
        const p = [F((rand() - 0.5) * 400), F((rand() - 0.5) * 400), F((rand() - 0.5) * 400), F(Math.floor(rand() * 300))];
        if (i < 16) p[0] = p[1] = p[2] = i - 8;   // the lattice itself
        io.set(p, 4 * i);
        pts.push(p);
      }
      const r = await run({ label: 'noise', code: kernel(N, `  let a = io[i];
  io[NIN + 2u * i] = vec4f(hash13(a.xyz), vnoise(a.xyz), fbm3(a.xyz), ign(abs(a.xy) * 4.0, a.w));
  io[NIN + 2u * i + 1u] = vec4f(hash33(a.xyz), 0.0);`), groups: groupsFor(layouts, { io }), dispatch: [N / 64, 1, 1] });
      if (ranOk('noise kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        const got = { hash13: [], vnoise: [], fbm3: [], ign: [], hash33: [] }, want = { hash13: [], vnoise: [], fbm3: [], ign: [], hash33: [] };
        pts.forEach((p, i) => {
          const o = 4 * (N + 2 * i), q = p.slice(0, 3);
          got.hash13.push([out[o]]); want.hash13.push([hash13(q)]);
          got.vnoise.push([out[o + 1]]); want.vnoise.push([vnoise(q)]);
          got.fbm3.push([out[o + 2]]); want.fbm3.push([fbm3(q)]);
          got.ign.push([out[o + 3]]); want.ign.push([ign([F(Math.abs(p[0]) * 4), F(Math.abs(p[1]) * 4)], p[3])]);
          got.hash33.push(Array.from(out.subarray(o + 4, o + 7))); want.hash33.push(hash33(q));
        });
        // The hashes take fract of products near 2000, where one f32 rounding
        // of a product (an FMA, another order) moves them by up to ~1e-3:
        // the bound below is that, and the share within 1e-6 shows the bulk
        // is the same arithmetic. A wrong formula is off by ~0.3.
        for (const k of Object.keys(got)) {
          const { max, at } = worst(got[k], want[k]);
          const flat = got[k].flatMap((v, i) => v.map((x, c) => Math.abs(x - want[k][i][c])));
          const exact = flat.filter((e) => e <= 1e-6).length / flat.length;
          check(`noise ${k}: ${N} points, max |err| ${fmt(max)}${at >= 0 ? ` (point ${at})` : ''}, ${(exact * 100).toFixed(1)}% within 1e-6`,
            max <= 2e-3 && exact >= 0.9);
        }
      }
    }

    // sky
    {
      const N = 64, io = new Float32Array(N * 4 * 4), dirs = [];
      for (let i = 0; i < N; i++) {
        const y = i < 4 ? [1, 0.001, -0.3, SUN[1]][i] : rand() * 2 - 1, a = rand() * 2 * Math.PI, r = Math.sqrt(1 - y * y);
        const d = i === 3 ? SUN : [r * Math.cos(a), y, r * Math.sin(a)];
        io.set([...d, 0], 4 * i);
        dirs.push(Array.from(io.subarray(4 * i, 4 * i + 3)));
      }
      const r = await run({ label: 'sky', code: kernel(N, `  let d = io[i].xyz;
  io[NIN + 3u * i] = vec4f(skyRadiance(d), airMass(d.y));
  io[NIN + 3u * i + 1u] = vec4f(skyColor(d), 0.0);
  io[NIN + 3u * i + 2u] = vec4f(skyAmbient(d), 0.0);`), groups: groupsFor(layouts, { io }), dispatch: [1, 1, 1] });
      if (ranOk('sky kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        const rel = (got, want) => Math.max(...want.map((w, k) => Math.abs(got[k] - w) / Math.max(Math.abs(w), 1e-3)));
        let eR = 0, eC = 0, eA = 0, eM = 0;
        dirs.forEach((d, i) => {
          const o = 4 * (N + 3 * i);
          eR = Math.max(eR, rel(out.subarray(o, o + 3), skyRadiance(d, FRAME)));
          eM = Math.max(eM, rel([out[o + 3]], [skyM.airMass(d[1])]));
          eC = Math.max(eC, rel(out.subarray(o + 4, o + 7), skyColor(d, FRAME)));
          eA = Math.max(eA, rel(out.subarray(o + 8, o + 11), skyAmbient(d, FRAME)));
        });
        // skyRadiance's path term divides sunExt - e^(-tau mv) by mv - ms: near
        // the sun's air mass (|mv - ms| just over AIRMASS_EQ_EPS) f32 loses
        // about 3e-4 of it to the cancellation, in GLSL as here; elsewhere
        // the error is f32's transcendentals'.
        check(`sky: ${N} directions, max relative error airMass ${fmt(eM)}, skyRadiance ${fmt(eR)}, skyColor ${fmt(eC)}, skyAmbient ${fmt(eA)}`,
          Math.max(eC, eR) <= 1e-3 && Math.max(eA, eM) <= 1e-5);
      }
    }

    // sunBasis: suns, shadow map sizes and window origins (the texel snap)
    {
      const cases = [
        { sun: SUN, res: 128, origin: [0, 0, 0] },
        { sun: norm([0.1, 0.9, -0.2]), res: 512, origin: [100, 0, -37] },
        { sun: norm([-0.6, 0.35, 0.5]), res: 640, origin: [513, 20, 1000] },
        { sun: norm([0.0, 1.0, 0.001]), res: 1024, origin: [-64, 8, 72] },
        { sun: norm([0.9, 0.2, 0.1]), res: 0, origin: [7, 3, 5] },
      ];
      const grid = [g.nx, g.ny, g.nz];
      let worstE = 0;
      const bad = [];
      for (const [k, c] of cases.entries()) {
        const fr = { ...FRAME, sun: c.sun, shadowRes: c.res };
        const r = await run({ label: `sunBasis ${k}`, code: kernel(1, `  var c: vec3f;
  var R: f32;
  var u: vec3f;
  var v: vec3f;
  sunBasis(&c, &R, &u, &v);
  io[0] = vec4f(c, R);
  io[1] = vec4f(u, 0.0);
  io[2] = vec4f(v, 0.0);`), groups: groupsFor(layouts, { frame: fr, origin: c.origin }), dispatch: [1, 1, 1] });
        if (!ranOk(`sunBasis kernel ${k}`, r)) continue;
        const out = f32s(r.outputs['3.2']);
        const sun = Array.from(new Float32Array(c.sun));   // as the GPU holds it
        const want = sunBasis(grid, sun, c.res, c.origin);
        const e = Math.max(...[...want.c.map((x, i) => Math.abs(out[i] - x)), Math.abs(out[3] - want.R),
          ...want.u.map((x, i) => Math.abs(out[4 + i] - x)), ...want.v.map((x, i) => Math.abs(out[8 + i] - x))]);
        worstE = Math.max(worstE, e);
        if (e > 1e-3) bad.push(`case ${k}: c ${Array.from(out.subarray(0, 3)).map((x) => x.toFixed(4))} want ${want.c.map((x) => x.toFixed(4))}`);
      }
      // c carries the window origin's dot products (up to ~1000 cells): f32 holds them to ~1e-4
      check(`sunBasis: ${cases.length} cases (sun, map size, window origin), max |err| ${fmt(worstE)}`, worstE <= 1e-3 && !bad.length, bad.join('; '));
    }

    // SH evaluation
    {
      const N = 256, io = new Float32Array(N * 4 * 7), cases = [];
      for (let i = 0; i < N; i++) {
        const c0 = [rand() * 4, rand() * 4, rand() * 4, rand() * 3], b = () => [0, 1, 2, 3].map(() => (rand() - 0.5) * 4);
        const cx = b(), cy = b(), cz = b(), n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]), blur = rand();
        io.set([...c0, ...cx, ...cy, ...cz, ...n, blur], 20 * i);
        const r32 = (k) => Array.from(io.subarray(20 * i + 4 * k, 20 * i + 4 * k + 4));
        cases.push({ c0: r32(0), cx: r32(1), cy: r32(2), cz: r32(3), n: r32(4).slice(0, 3), blur: io[20 * i + 19] });
      }
      const r = await run({ label: 'sh', code: kernel(N, `  let g = Probe(io[5u * i], io[5u * i + 1u], io[5u * i + 2u], io[5u * i + 3u]);
  let n = io[5u * i + 4u];
  io[5u * NIN + 2u * i] = vec4f(giIrradiance(g, n.xyz), giSkyVis(g, n.xyz));
  io[5u * NIN + 2u * i + 1u] = vec4f(giRadiance(g, n.xyz, n.w), 0.0);`), groups: groupsFor(layouts, { io }), dispatch: [N / 64, 1, 1] });
      if (ranOk('SH kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        const got = [], want = [];
        cases.forEach((c, i) => {
          const o = 4 * (5 * N + 2 * i), w = shRef(c.c0, c.cx, c.cy, c.cz, c.n, c.blur);
          got.push([...out.subarray(o, o + 4), ...out.subarray(o + 4, o + 7)]);
          want.push([...w.irr, w.vis, ...w.rad]);
        });
        const { max, at } = worst(got, want);
        check(`SH: ${N} probes, giIrradiance, giSkyVis, giRadiance max |err| ${fmt(max)}${at >= 0 ? ` (probe ${at})` : ''}`, max <= 2e-5);
      }
    }

    // the 3D-texture readers on known volumes
    {
      const grid = [g.nx, g.ny, g.nz], bricks = grid.map((n) => n / 4);
      // values exact in f16: multiples of 1/64 below 8
      const q = (x) => Math.round(x * 64) / 64;
      const fs = volume(grid, (x, y, z) => [q(((x * 7 + y * 3 + z * 5) % 32) / 16), q(x / 16), q(y / 8), q(z / 12)]);
      const fm = volume(grid, (x, y, z) => [q(z / 12), q(((x + 2 * y) % 9) / 8), q(x / 32), 1]);
      // the four GI bands differ from each other, so a band read from the wrong texture shows
      const gi = [
        // (band 0's alpha up to 2: giAirSkyVis clamps at 1 from ~0.89)
        volume(bricks, (x, y, z) => [q(x / 4), q(y / 2), q(z / 3), q(((x + y + z) % 5) / 2)]),
        volume(bricks, (x, y, z) => [q(y / 2), q(z / 3), q(((2 * x + z) % 5) / 4), q(x / 8)]),
        volume(bricks, (x, y, z) => [q(((3 * y + x) % 7) / 4), q(z / 6), q(x / 4), 0.25]),
        volume(bricks, (x, y, z) => [q(z / 3), q(x / 8), 0.5, q(y / 4)]),
      ];
      const lt = volume(bricks, (x, y, z) => [q(((x * 3 + z) % 7) / 2), q(y), q(z / 6), 1]);
      const GI_OFFSET = 3;   // lighting.js: cells out along the normal a surface reads the probes
      const IN = 2, OUT = 14;
      const N = 256, io = new Float32Array(N * 4 * (IN + OUT)), pts = [], nrm = [];
      for (let i = 0; i < N; i++) {
        // inside, with some outside the grid (the edge clamps)
        const p = grid.map((n) => F((rand() * 1.2 - 0.1) * n));
        const n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]).map(F);
        io.set([...p, 0, ...n, 0], 4 * IN * i);
        pts.push(p);
        nrm.push(n);
      }
      const extra = { '2.0': { tex: fs.tex }, '2.1': { tex: fm.tex }, '2.3': { tex: lt.tex },
        '2.4': { tex: gi[0].tex }, '2.5': { tex: gi[1].tex }, '2.6': { tex: gi[2].tex }, '2.7': { tex: gi[3].tex } };
      const r = await run({ label: 'textures', code: kernel(N, `  let p = io[${IN}u * i].xyz;
  let n = io[${IN}u * i + 1u].xyz;
  let o = ${IN}u * NIN + ${OUT}u * i;
  io[o] = fieldTex(tFS, p);
  io[o + 1u] = mediaField(p);
  io[o + 2u] = fieldCubic(tFS, p);
  io[o + 3u] = probeTex(tGI0, p);
  let pa = probeAt(p);
  io[o + 4u] = pa.c0;
  io[o + 5u] = pa.cx;
  io[o + 6u] = pa.cy;
  io[o + 7u] = pa.cz;
  io[o + 8u] = vec4f(sampleLight(p), surfField(p).x);
  let sp = surfProbe(p, n);
  io[o + 9u] = sp.c0;
  io[o + 10u] = sp.cx;
  io[o + 11u] = sp.cy;
  io[o + 12u] = sp.cz;
  io[o + 13u] = vec4f(giAirSkyVis(p), 0.0, 0.0, 0.0);`), groups: groupsFor(layouts, { io, extra }), dispatch: [N / 64, 1, 1] });
      if (ranOk('3D-texture kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        const fieldQ = (p, n) => clampV(p, [0.5, 0.5, 0.5], n.map((s) => s - 0.5));
        const brickQ = (p) => clampV(p.map((v) => v / 4), [0.5, 0.5, 0.5], bricks.map((s) => s - 0.5));
        const BANDS = ['c0', 'cx', 'cy', 'cz'];
        const sets = Object.fromEntries(['fieldTex', 'mediaField', 'fieldCubic', 'probeTex', ...BANDS.map((b) => `probeAt.${b}`),
          'sampleLight', ...BANDS.map((b) => `surfProbe.${b}`), 'giAirSkyVis'].map((k) => [k, [[], []]]));
        pts.forEach((p, i) => {
          const o = 4 * (IN * N + OUT * i), at = (k, n = 4) => Array.from(out.subarray(o + 4 * k, o + 4 * k + n));
          const add = (k, got, want) => { sets[k][0].push(got); sets[k][1].push(want); };
          const ps = p.map((v, k) => F(v + F(nrm[i][k] * GI_OFFSET)));   // where surfProbe reads, in f32
          add('fieldTex', [...at(0), at(8)[3]], [...fs.tri(fieldQ(p, grid)), fs.tri(fieldQ(p, grid))[0]]);
          add('mediaField', at(1), fm.tri(fieldQ(p, grid)));
          add('fieldCubic', at(2), cubic(fs, p));
          add('probeTex', at(3), gi[0].tri(brickQ(p)));
          BANDS.forEach((b, k) => add(`probeAt.${b}`, at(4 + k), gi[k].tri(brickQ(p))));
          add('sampleLight', at(8, 3), lt.tri(brickQ(p)).slice(0, 3));
          BANDS.forEach((b, k) => add(`surfProbe.${b}`, at(9 + k), gi[k].tri(brickQ(ps))));
          add('giAirSkyVis', at(13, 1), [airSkyRef(gi[0], grid, p)]);
        });
        // Hardware filtering weights are fixed point (SwiftShader: 8 bits of
        // fraction would be 1/256 of the texel step); the data steps by up to 2
        // per texel: within 2/256 of the double reference. A misplaced texel
        // (an axis swapped, an off-by-half, a band from the wrong texture, a
        // wrong offset) is off by far more.
        for (const [k, [got, want]] of Object.entries(sets)) {
          const { max, at } = worst(got, want);
          check(`${k}: ${N} points (edges included), max |err| ${fmt(max)}${at >= 0 ? ` at (${pts[at].map((v) => v.toFixed(2))})` : ''}`, max <= 2 / 256);
        }
      }
    }

    // GI's sun lookups (docs/webgpu.md E): the GI variants build the library
    // with the uniforms GI's GLSL left unset (caustics off, time and frame 0)
    // as literal zeros, so FrameUniforms' shared caustics, time and frame
    // can't reach the probes. A uniform shadow map puts every point of the
    // box under a pool of water, lit (nothing opaque), so caustics, when on,
    // change the light everywhere.
    {
      const strip = (code) => code.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      const reads = (variant) => [...new Set(strip(lib(g, { variant })).match(/FU\.(caustics|time|frame)\b/g) ?? [])].sort().join(', ') || 'none';
      const giReads = ['LIGHTING_GI', 'LIGHTING_GISRC'].map((v) => `${v} ${reads(v)}`);
      check(`GI variants read none of FU.caustics, FU.time, FU.frame (${giReads.join('; ')}; LIGHTING ${reads('LIGHTING')})`,
        giReads.every((x) => x.endsWith('none')) && reads('LIGHTING') === 'FU.caustics, FU.frame, FU.time');

      const W = elementsM.E.WATER, water = elementsM.ELEMENTS[W];
      const R = 0.5 * Math.hypot(g.nx, g.ny, g.nz) + 1, res = 16;
      // the pool: translucent from depth 0 to past the box's far side, as
      // much water as path (underPool's fill share is met at every depth),
      // nothing opaque
      const meanSigma = water.sigma.reduce((a, b) => a + b, 0) / 3, tau = meanSigma * 2 * R;
      const sm = new Float32Array(res * res * 4), smx = new Float32Array(res * res);
      for (let i = 0; i < res * res; i++) { sm.set([1e6, 0, 2 * R + 1, W * 256 + tau], 4 * i); smx[i] = 1e6; }
      const extra = { '2.8': { tex: { format: 'rgba32float', size: [res, res], data: b64(new Uint8Array(sm.buffer)) } },
        '2.9': { tex: { format: 'r32float', size: [res, res], data: b64(new Uint8Array(smx.buffer)) } } };
      const N = 128, pts = new Float32Array(N * 4 * 3);   // N points in, 2N results out
      for (let i = 0; i < N; i++) pts.set([(rand() * 0.9 + 0.05) * g.nx, (rand() * 0.9 + 0.05) * g.ny, (rand() * 0.9 + 0.05) * g.nz, 0], 4 * i);
      const body = `  let p = io[i].xyz;
  io[NIN + 2u * i] = vec4f(sunShadowAt(p), 0.0);
  io[NIN + 2u * i + 1u] = vec4f(sunMapShadowAt(p), 0.0);`;
      const live = { ...FRAME, shadowRes: res, caustics: 1, time: 3.5, frame: 7, clouds: 0 };
      const off = { ...live, caustics: 0, time: 0, frame: 0 };
      const runs = {};
      for (const [k, variant, frame] of [['live', 'LIGHTING', live], ['off', 'LIGHTING', off], ['gi', 'LIGHTING_GI', live]]) {
        const top = lib(g, { variant });
        const lay = variant === 'LIGHTING_GI' ? libProbeLayouts('lib.gi') : layouts;
        const r = await run({ label: `GI sun ${k}`, code: kernel(N, body, top),
          groups: groupsFor(lay, { frame, io: pts.slice(), extra }), dispatch: [N / 64, 1, 1] });
        if (ranOk(`GI sun kernel (${variant}, caustics ${frame.caustics}, time ${frame.time}, frame ${frame.frame})`, r)) {
          runs[k] = f32s(r.outputs['3.2']).slice(4 * N, 4 * N + 8 * N);
        }
      }
      if (runs.live && runs.off && runs.gi) {
        let changed = 0, lit = 0, eGI = 0;
        for (let i = 0; i < N; i++) {
          let dLive = 0;
          for (let k = 0; k < 8; k++) {
            if ((k & 3) === 3) continue;
            const j = 8 * i + k;
            dLive = Math.max(dLive, Math.abs(runs.live[j] - runs.off[j]));
            eGI = Math.max(eGI, Math.abs(runs.gi[j] - runs.off[j]));
          }
          if (dLive > 1e-3) changed++;
          if (runs.off[8 * i] > 0.05) lit++;
        }
        // the control: with the volume's library and caustics on, the light
        // under the pool moves (else this test couldn't see them)
        check(`GI sun control: LIGHTING with caustics on changes ${changed}/${N} points under the pool (lit ${lit}/${N})`,
          changed >= N / 2 && lit === N);
        check(`GI sun: LIGHTING_GI's sunShadowAt, sunMapShadowAt with FU.caustics 1, time 3.5, frame 7 = LIGHTING with all 0, max |diff| ${fmt(eGI)}`,
          eGI <= 1e-6);
      }
    }

    // ---- main's sync-2 changes ----
    // The library's SH constants come from lighting.js's exports (pov/viewmodel.js reads them too)
    {
      const text = lib(g);
      const want = [`const SH_Y0: f32 = ${SH.Y0.toFixed(6)};`, `const SH_Y1: f32 = ${SH.Y1.toFixed(6)};`,
        `const SKYVIS_OPEN_DC: f32 = ${SH.OPEN_DC.toFixed(6)};`];
      check(`SH constants: lighting.js exports SH_Y0 ${SH.Y0}, SH_Y1 ${SH.Y1}, SKYVIS_OPEN_DC ${SH.OPEN_DC}, and the WGSL holds them`,
        SH.Y0 === 0.282095 && SH.Y1 === 0.488603 && SH.OPEN_DC === 0.5 && want.every((w) => text.includes(w)));
    }

    // The cubic channels (gfx/materials.js CHANNELS cubic: liquid and granular)
    // read cubic by their own thin-mask channel regardless of gThin, or up close
    // (DETAIL_CUBIC_CLOSE: cubicClose from gCubicEye, gCubicPixAng). The
    // reference takes the kernel's own trilinear, mask and cubic readings
    // (their filtering is checked above) and redoes the blend: which channels,
    // which band, which share.
    {
      const grid = [g.nx, g.ny, g.nz];
      const q = (x) => Math.round(x * 64) / 64;
      const fs = volume(grid, (x, y, z) => [q(((x * 7 + y * 3 + z * 5) % 32) / 32), q(((x + 2 * z) % 16) / 16), q(((3 * x + y) % 16) / 16), q(((y + z) % 8) / 8)]);
      const ft = volume(grid, (x, y, z) => [q(((x + y) % 5) / 4), q(((y + z) % 3) / 2), q(((x + z) % 4) / 3), q(((x + 2 * z) % 5) / 4)]);
      const CH = materialsM.CHANNELS.map((c) => (c.cubic ? 1 : 0));
      const FP_NONE = detailM.CUBIC_FACET / detailM.CUBIC_PX_NONE, FP_FULL = detailM.CUBIC_FACET / detailM.CUBIC_PX_FULL;
      const eye = [g.nx / 2, g.ny / 2, g.nz / 2];
      const N = 256, IN = 2, OUT = 7, io = new Float32Array(N * 4 * (IN + OUT)), cases = [];
      for (let i = 0; i < N; i++) {
        const p = grid.map((n) => F((rand() * 0.9 + 0.05) * n));
        // gThin on or off; the eye's pixel angle 0 (another pass) or one putting the hand-off inside the box
        const thin = i % 2 === 0, pixAng = i % 4 < 2 ? 0 : F(0.004);
        io.set([...p, thin ? 1 : 0, ...eye, pixAng], 4 * IN * i);
        cases.push({ p, thin, pixAng });
      }
      const body = `  let a = io[${IN}u * i];
  let e = io[${IN}u * i + 1u];
  let p = a.xyz;
  gThin = a.w > 0.5;
  gCubicEye = e.xyz;
  gCubicPixAng = e.w;
  let o = ${IN}u * NIN + ${OUT}u * i;
  io[o] = surfField(p);
  io[o + 1u] = fieldTex(tFT, p);
  io[o + 2u] = fieldCubic(tFS, p);
  io[o + 3u] = surfSample(p);
  io[o + 4u] = vec4f(surfChannel(p, 0), surfChannel(p, 1), surfChannel(p, 2), surfChannel(p, 3));
  io[o + 5u] = vec4f(cubicShare(p, 0), cubicShare(p, 1), cubicShare(p, 2), cubicShare(p, 3));
  io[o + 6u] = vec4f(cubicClose(p), 0.0, 0.0, 0.0);`;
      const extra = { '2.0': { tex: fs.tex }, '2.2': { tex: ft.tex } };
      for (const close of [true, false]) {
        const top = lib(g, { detail: close ? { DETAIL_CUBIC_CLOSE: 1 } : {} });
        const r = await run({ label: `cubic ${close}`, code: kernel(N, body, top), groups: groupsFor(layouts, { io: io.slice(), extra }), dispatch: [N / 64, 1, 1] });
        if (!ranOk(`cubic channels kernel (DETAIL_CUBIC_CLOSE ${close ? 'on' : 'off'})`, r)) continue;
        const out = f32s(r.outputs['3.2']);
        let err = 0, exact = true, blended = 0, nearHand = 0, closeAll = 0;
        cases.forEach((c, i) => {
          const o = 4 * (IN * N + OUT * i), at = (k) => Array.from(out.subarray(o + 4 * k, o + 4 * k + 4));
          const s0 = at(0), th = at(1), cu = at(2);
          const fp = Math.hypot(...c.p.map((v, k) => v - eye[k])) * c.pixAng;
          const cl = close && c.pixAng > 0 ? 1 - smoothstep(FP_FULL, FP_NONE, fp) : 0;
          const share = CH.map((on, k) => (on ? Math.max(th[k], cl) : 0));
          const band = CH.map((on, k) => on * (s0[k] > 0.3 ? 1 : 0) * (s0[k] < 0.85 ? 1 : 0));
          const w = band.map((b, k) => b * Math.max(th[k], cl));
          const sample = s0.map((v, k) => (w[k] > 0 ? v * (1 - w[k]) + cu[k] * w[k] : v));
          const chan = s0.map((v, k) => (share[k] > 0 ? v * (1 - share[k]) + cu[k] * share[k] : v));
          const got = [...at(3), ...at(4), ...at(5), at(6)[0]], want = [...sample, ...chan, ...share, cl];
          got.forEach((x, k) => { err = Math.max(err, Math.abs(x - want[k])); });
          // the channels that don't read cubic come back exactly as read
          for (const k of [1, 3]) if (at(3)[k] !== s0[k] || at(4)[k] !== s0[k] || at(5)[k] !== 0) exact = false;
          if (w.some((x) => x > 0)) blended++;
          if (cl > 0 && cl < 1) nearHand++;
          if (cl === 1) closeAll++;
        });
        // (f32 against double of the same blends: a few ulps of values up to 1)
        check(`cubic channels (close ${close ? 'on' : 'off'}): ${N} points, surfSample, surfChannel, cubicShare, cubicClose max |err| ${fmt(err)}; `
          + `blended ${blended}, in the hand-off ${nearHand}, fully close ${closeAll}; molten and organic untouched`,
          err <= 2e-6 && exact && blended >= N / 8 && (close ? nearHand >= 8 && closeAll >= 8 : nearHand + closeAll === 0));
      }
    }

    // A mask texel in the previous brick still contributes across the face.
    // Changing the march's brick hint must not invent an isosurface there.
    {
      const grid = [g.nx, g.ny, g.nz];
      const fs = volume(grid, (x) => {
        const v = x === 3 ? 0.61 : x === 4 ? 0.40 : 0;
        return [v, 0, v, 0];
      });
      const ft = volume(grid, (x) => [x === 3 ? 1 : 0, 0, x === 3 ? 1 : 0, 0]);
      const extra = { '2.0': { tex: fs.tex }, '2.2': { tex: ft.tex } };
      for (const [name, detail, angle] of [
        ['off', {}, 0],
        ['balanced transition', { DETAIL_CUBIC_CLOSE: 1 }, 0.0077],
        ['fully close', { DETAIL_CUBIC_CLOSE: 1 }, 0.001],
      ]) {
        const body = `
  let ch = select(CH_LIQUID, CH_GRANULAR, i >= 2u);
  let forward = (i & 1u) == 0u;
  let ro = vec3f(4.0);
  let rd = vec3f(select(-0.01, 0.01, forward), sqrt(1.0 - 0.0001), 0.0);
  gCubicEye = vec3f(0.0);
  gCubicPixAng = ${angle};
  gThin = forward;
  let cached = surfSample(ro)[ch];
  let channelBefore = surfChannel(ro, ch);
  gThin = !forward;
  let current = surfSample(ro)[ch];
  let channelAfter = surfChannel(ro, ch);
  let end = surfSample(ro + rd * 0.5)[ch];
  let t = surfCross(ro, rd, ch, forward, 0.0, 0.5, 0.5, cached, end, end);
  io[2u * i] = vec4f(cached, current, end, t);
  io[2u * i + 1u] = vec4f(channelBefore, channelAfter, 0.0, 0.0);`;
        const r = await run({ label: `brick face ${name}`, code: kernel(4, body, lib(g, { detail })),
          groups: groupsFor(layouts, { extra, ioSize: 4 * 2 * 16 }), dispatch: [1, 1, 1] });
        if (!ranOk(`brick face kernel (${name})`, r)) continue;
        const out = f32s(r.outputs['3.2']);
        for (let i = 0; i < 4; i++) {
          const [cached, current, end, t, before, after] = out.subarray(8 * i, 8 * i + 6);
          check(`brick face (${name}, ${i < 2 ? 'liquid' : 'granular'}, ${i % 2 ? 'reverse' : 'forward'}): no floating surface`,
            cached === current && before === after && current < 0.5 && end < 0.5 && t === 1e9,
            `cached=${cached}, current=${current}, end=${end}, crossing=${t}`);
        }
      }
    }

    // The far field's sky, the GI past the window and the haze's air. The
    // ground's surface seen from above (farTop's y) varies by column; its
    // ground seen from below (x) is lower everywhere, so every column has a
    // roof over a cave. GI's band 0 (alpha: the probes' sky) as above.
    {
      const L = farM.farLayout(farM.WORLD_SIZE), [WBX, , WBZ] = L.bricks.n;
      const hsOf = (bx, bz) => 40 + 4 * ((bx * 3 + bz * 5) % 7);
      const top = new Uint16Array(WBX * WBZ * 4);
      for (let bz = 0; bz < WBZ; bz++) for (let bx = 0; bx < WBX; bx++) top.set([toHalf(20), toHalf(hsOf(bx, bz)), 0, toHalf(1)], 4 * (bx + WBX * bz));
      const grid = [g.nx, g.ny, g.nz], bricks = grid.map((n) => n / 4);
      const q = (x) => Math.round(x * 64) / 64;
      const gi0 = volume(bricks, (x, y, z) => [0, 0, 0, q(((x + y + z) % 5) / 2)]);
      const sky = (p) => airSkyRef(gi0, grid, p);
      const origin = [400, 30, 300];
      const fr = { ...FRAME, sea: 0, far: 1 };
      const extra = { '2.4': { tex: gi0.tex }, '2.12': { tex: { format: 'rgba16float', size: [WBX, WBZ], data: b64(new Uint8Array(top.buffer)) } } };
      const farTop = `${head}\n${farM.farHazeFor('giAirSkyVis')}\n${farM.farLayoutGLSL(L)}\n${farM.farSkyGLSL}\n${farM.farGIGLSL(L, { layout: false, sky: false })}`;
      const skyOpenRef = (w) => {
        if (w[0] < 0 || w[2] < 0 || w[0] >= farM.WORLD_SIZE[0] || w[2] >= farM.WORLD_SIZE[2]) return 1;
        const hs = hsOf(Math.trunc(w[0]) >> 2, Math.trunc(w[2]) >> 2), S = farM.FAR_SKY;
        return smoothstep(hs - S.SHUT * 4, hs - S.OPEN * 4, w[1]);
      };
      // per job: a (xyz, w), b (xyz, w) in, 4 out
      const N = 256, IN = 3, OUT = 5, io = new Float32Array(N * 4 * (IN + OUT)), cases = [];
      for (let i = 0; i < N; i++) {
        const kind = i % 4;
        let w, d;
        if (kind === 0) {
          // a window point and a random direction (farBeyond's sky gate)
          w = [(rand() * 1.4 - 0.2) * g.nx, rand() * g.ny, (rand() * 1.4 - 0.2) * g.nz].map((v, k) => v + origin[k]);
          d = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
        } else if (kind === 1) {
          // between a column's floor (20) and its roof (40 or more), level: blocked at once by the roof
          w = [rand() * 1000 + 12, 22 + rand() * 16, rand() * 1000 + 12];
          const a = rand() * 2 * Math.PI;
          d = [Math.cos(a), 0, Math.sin(a)];
        } else if (kind === 2) {
          // over every roof (64 at most), going up: the open sky
          w = [rand() * 1000 + 12, 70 + rand() * 30, rand() * 1000 + 12];
          d = norm([rand() - 0.5, 0.3 + rand(), rand() - 0.5]);
        } else {
          // anywhere, the world's edges included: farSkyOpen
          w = [rand() * 1100 - 40, 30 + rand() * 40, rand() * 1100 - 40];
          d = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
        }
        // the kernel takes the window point Q and adds the origin as farBeyond does
        const Q = w.map((v, k) => F(v - origin[k]));
        w = Q.map((v, k) => F(v + origin[k]));
        d = d.map(F);
        const b = grid.map((n) => F((rand() * 1.3 - 0.15) * n));
        const lit = F(rand()), dist = F(rand() * 60000);   // up to ~2 optical depths of haze
        io.set([...Q, lit], 4 * IN * i);
        io.set([...d, dist], 4 * IN * i + 4);
        io.set([...b, 0], 4 * IN * i + 8);
        cases.push({ kind, w, d, b, lit, dist });
      }
      const body = `  let Q = io[${IN}u * i].xyz;
  let w = Q + vec3f(H.origin);
  let lit = io[${IN}u * i].w;
  let d = io[${IN}u * i + 1u].xyz;
  let dist = io[${IN}u * i + 1u].w;
  let b = io[${IN}u * i + 2u].xyz;
  let o = ${IN}u * NIN + ${OUT}u * i;
  var o1 = 1.0;
  var o2 = 1.0;
  let fb = farBeyond(Q, Q, d, &o1);
  let fo = farBeyondOpen(w, d, &o2);
  io[o] = vec4f(fb, o1);
  io[o + 1u] = vec4f(fo, o2);
  let a = Q;   // the haze from the window point w to b
  let col = vec3f(0.02, 0.05, 0.09);
  io[o + 2u] = vec4f(farSkyOpen(w), farAirLit(a, b), giAirSkyVis(b), 0.0);
  io[o + 3u] = vec4f(farHaze(col, d, dist, lit), 0.0);
  io[o + 4u] = vec4f(farHazePremul(col, lit, a, b), 0.0);`;
      const r = await run({ label: 'far sky', code: kernel(N, body, farTop), groups: groupsFor(layouts, { frame: fr, origin, io, extra }), dispatch: [N / 64, 1, 1] });
      if (ranOk('far sky, GI and haze kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        let eSky = 0, eGate = 0, eLit = 0, eHaze = 0, ePre = 0, eOpen = 0;
        const n = { shut: 0, part: 0, open: 0, roofed: 0, roofs: 0, up: 0 };
        const col = [0.02, 0.05, 0.09];
        cases.forEach((c, i) => {
          const o = 4 * (IN * N + OUT * i), at = (k) => Array.from(out.subarray(o + 4 * k, o + 4 * k + 4));
          const [fb, fo, sk, hz, hp] = [0, 1, 2, 3, 4].map(at);
          const skyW = skyOpenRef(c.w);
          eSky = Math.max(eSky, Math.abs(sk[0] - skyW));
          if (sk[0] === 0) n.shut++; else if (sk[0] === 1) n.open++; else n.part++;
          // farBeyond = its sky share × what the open sky's march finds; *open likewise
          for (let k = 0; k < 3; k++) eGate = Math.max(eGate, Math.abs(fb[k] - sk[0] * fo[k]) / Math.max(Math.abs(fo[k]), 1));
          eGate = Math.max(eGate, Math.abs(fb[3] - sk[0] * fo[3]));
          if (sk[0] === 0 && fb.some((x) => x !== 0)) eGate = Infinity;
          if (c.kind === 1) { n.roofs++; if (fo[3] === 0) n.roofed++; }
          if (c.kind === 2) {
            const want = skyColor(c.d, fr);
            eOpen = Math.max(eOpen, fo[3] === 1 ? Math.max(...want.map((x, k) => Math.abs(fo[k] - x) / Math.max(Math.abs(x), 1e-3))) : Infinity);
            n.up++;
          }
          // the haze's air
          const a = c.w.map((v, k) => v - origin[k]);
          const lit = airLitRef(sky, a, c.b);
          eLit = Math.max(eLit, Math.abs(sk[1] - lit), Math.abs(sk[2] - sky(c.b)));
          const T = hazeT(c.dist), air = farAirRef(c.d, fr);
          const want = col.map((x, k) => x * T[k] + c.lit * air[k] * (1 - T[k]));
          eHaze = Math.max(eHaze, ...want.map((x, k) => Math.abs(hz[k] - x) / Math.max(Math.abs(x), 1e-3)));
          // farHazePremul against its own farAirLit (checked just above)
          const v = c.b.map((x, k) => x - a[k]), dv = Math.hypot(...v), Tp = hazeT(dv), airP = farAirRef(v.map((x) => x / Math.max(dv, 1e-6)), fr);
          const wantP = col.map((x, k) => x * Tp[k] + c.lit * sk[1] * airP[k] * (1 - Tp[k]));
          ePre = Math.max(ePre, ...wantP.map((x, k) => Math.abs(hp[k] - x) / Math.max(Math.abs(x), 1e-3)));
        });
        check(`farSkyOpen: ${N} world points (edges included), max |err| ${fmt(eSky)}; shut ${n.shut}, partial ${n.part}, open ${n.open}`,
          eSky <= 1e-5 && n.shut >= 8 && n.part >= 8 && n.open >= 8);
        check(`farBeyond = farSkyOpen × farBeyondOpen (light and *open), max rel |err| ${fmt(eGate)}`, eGate <= 1e-6);
        check(`farBeyondOpen: a level ray under a cave's roof is blocked (farTop's y over its x) in ${n.roofed}/${n.roofs}; `
          + `over every roof going up it sees skyColor in ${n.up}, max rel |err| ${fmt(eOpen)}`, n.roofed === n.roofs && n.roofs > 0 && eOpen <= 1e-3);
        // farAirLit's sky reads are hardware trilinear (2/256 of a step of 2, scaled by SH_Y0 / 0.5)
        check(`farAirLit, giAirSkyVis: ${N} spans in and out of the window, max |err| ${fmt(eLit)}`, eLit <= 2 / 256);
        check(`farHaze (lit), farHazePremul: max rel |err| ${fmt(eHaze)}, ${fmt(ePre)}`, Math.max(eHaze, ePre) <= 1e-3);
      }
    }

    // meshCutAt: a grid point projected by a WebGPU camera (clip depth in
    // [0, 1], pixels y down) comes back at its distance along the eye ray;
    // depth 1 (the clear) is no cut.
    {
      const cam = FRAME.cam, res = [400, 250], near = 0.5, far = 500, fy = 1 / Math.tan((60 * Math.PI) / 360);
      const P = [fy / (res[0] / res[1]), 0, 0, 0, 0, fy, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0];
      const model = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, -3, 1, 2, 1];   // grid cells → world
      const toW = (p) => mvec(model, [...p, 1]).slice(0, 3);
      const eyeW = toW(cam), tgtW = toW([g.nx / 2, g.ny / 2, g.nz / 2]);
      const zf = norm(eyeW.map((x, k) => x - tgtW[k])), xf = norm(cross([0, 1, 0], zf)), yf = cross(zf, xf);
      const V = [xf[0], yf[0], zf[0], 0, xf[1], yf[1], zf[1], 0, xf[2], yf[2], zf[2], 0, -dot(xf, eyeW), -dot(yf, eyeW), -dot(zf, eyeW), 1];
      const M = mmul(P, mmul(V, model)), inv = minv(M);
      const N = 64, pts = [];
      while (pts.length < N) {
        const qp = [rand() * g.nx, rand() * g.ny, rand() * g.nz];
        const c = mvec(M, [...qp, 1]), ndc = c.slice(0, 3).map((x) => x / c[3]);
        if (c[3] <= 0 || Math.abs(ndc[0]) > 1 || Math.abs(ndc[1]) > 1 || ndc[2] <= 0 || ndc[2] >= 1) continue;
        const clear = pts.length < 4;
        pts.push({ pix: [(ndc[0] + 1) / 2 * res[0], (1 - ndc[1]) / 2 * res[1]], d: clear ? 1 : ndc[2],
          rd: norm(qp.map((x, k) => x - cam[k])), want: clear ? 1e30 : Math.hypot(...qp.map((x, k) => x - cam[k])) });
      }
      const io = new Float32Array(4 * (5 + 2 * N + N));
      io.set(inv, 0);
      io.set([...res, 0, 0], 16);
      pts.forEach((t, i) => { io.set([...t.pix, t.d, 0], 20 + 8 * i); io.set([...t.rd, 0], 24 + 8 * i); });
      const r = await run({ label: 'meshCut', code: kernel(N, `  let m = mat4x4f(io[0], io[1], io[2], io[3]);
  gFragCoord = io[5u + 2u * i].xy;
  io[5u + 2u * NIN + i] = vec4f(meshCutAt(io[5u + 2u * i].z, m, io[4].xy, io[6u + 2u * i].xyz), 0.0, 0.0, 0.0);`),
      groups: groupsFor(layouts, { io }), dispatch: [1, 1, 1] });
      if (ranOk('meshCutAt kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        let e = 0;
        pts.forEach((t, i) => { const got = out[4 * (5 + 2 * N + i)]; e = Math.max(e, Math.abs(got - t.want) / t.want); });
        check(`meshCutAt: ${N - 4} projected grid points back at their distance, 4 clear pixels none, max rel |err| ${fmt(e)}`, e <= 1e-3);
      }
    }

    // The near field's bounce off a lit lamp (main's sparkEmit in nearField):
    // a box full of lamps, nothing else lit (no sun, probes or glow), so both
    // rays stop in their first cell and return its emission; lit minus unlit
    // is the lamp's light.
    {
      const lamp = elementsM.E.LAMP, slots = g.nx * g.ny * g.nz, nbricks = slots / 64;
      const state = (lit) => {
        const a = new Float32Array(2 * slots * 4);
        for (let i = 0; i < 2 * slots; i++) a.set([lamp, 20, 0, (lit ? elecM.LAMP_DC : 0) + 0.25], 4 * i);
        return { data: b64(new Uint8Array(a.buffer)) };
      };
      const bricksBuf = new ArrayBuffer(nbricks * bindings.BrickInfo.size);
      const dv = new DataView(bricksBuf);
      for (let i = 0; i < nbricks; i++) bindings.BrickInfo.write(dv, i * bindings.BrickInfo.size, { emit: [0, 0, 0], info: bindings.packBrickInfo({ matter: true }) });
      const fr = { ...FRAME, sunCol: [0, 0, 0], shadows: 0 };
      const N = 64, io = new Float32Array(4 * 3 * N);
      for (let i = 0; i < N; i++) io.set([(rand() * 0.6 + 0.2) * g.nx, (rand() * 0.6 + 0.2) * g.ny, (rand() * 0.6 + 0.2) * g.nz, 0], 4 * i);
      const body = `  let p = io[i].xyz;
  gFragCoord = vec2f(f32(i) + 0.5, 3.5);
  var vis: f32;
  io[NIN + 2u * i] = vec4f(nearField(p, vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.1, 0.2, 0.3), &vis), vis);`;
      const res = {};
      for (const lit of [false, true]) {
        const r = await run({ label: `nearField ${lit}`, code: kernel(N, body),
          groups: groupsFor(layouts, { frame: fr, io: io.slice(), extra: { '1.0': state(lit), '2.16': { data: b64(new Uint8Array(bricksBuf)) } } }),
          dispatch: [1, 1, 1] });
        if (ranOk(`nearField kernel (lamps ${lit ? 'lit' : 'unlit'})`, r)) res[lit] = f32s(r.outputs['3.2']);
      }
      if (res[true] && res[false]) {
        // the lamp's light as the WGSL holds it (gfx/materials.js rounds it)
        const glow = materialsM.materialsGLSL().match(/const LAMP_GLOW: vec3f = vec3f\(([^)]*)\)/)[1].split(',').map(Number);
        let e = 0;
        for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) {
          const o = 4 * (N + 2 * i) + k;
          e = Math.max(e, Math.abs(res[true][o] - res[false][o] - glow[k]) / glow[k]);
        }
        check(`nearField: a lit lamp's bounce (lit − unlit = LAMP_GLOW ${glow.map((x) => x.toFixed(3)).join(', ')}) at ${N} points, max rel |err| ${fmt(e)}`, e <= 1e-4);
      }
    }

    // ---- main's sync-3 changes ----
    // A world scene's ambient floor (FU.caveAmbient, Descent's caves) is
    // added to giIrradiance and giRadiance, after their clamp; the GI passes
    // take none (their GLSL material had no uCaveAmbient), so the GI variants
    // hold a literal zero instead.
    {
      const strip = (code) => code.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      const reads = (variant) => (strip(lib(g, { variant })).match(/FU\.caveAmbient\b/g) ?? []).length;
      const giReads = ['LIGHTING_GI', 'LIGHTING_GISRC'].map((v) => reads(v));
      check(`caveAmbient: the GI variants read no FU.caveAmbient (${giReads.join(', ')}), LIGHTING does (${reads('LIGHTING')})`,
        giReads.every((n) => n === 0) && reads('LIGHTING') === 2);
      const amb = [0.03125, 0.0625, 0.125];
      const N = 128, io = new Float32Array(N * 4 * 7), cases = [];
      for (let i = 0; i < N; i++) {
        const c0 = [rand() * 4, rand() * 4, rand() * 4, rand() * 3], b = () => [0, 1, 2, 3].map(() => (rand() - 0.5) * 4);
        // (half of them with a band 0 the clamp takes to 0 on some side)
        if (i & 1) c0[0] = c0[1] = c0[2] = 0.1;
        const cx = b(), cy = b(), cz = b(), n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]), blur = rand();
        io.set([...c0, ...cx, ...cy, ...cz, ...n, blur], 20 * i);
        const r32 = (k) => Array.from(io.subarray(20 * i + 4 * k, 20 * i + 4 * k + 4));
        cases.push({ c0: r32(0), cx: r32(1), cy: r32(2), cz: r32(3), n: r32(4).slice(0, 3), blur: io[20 * i + 19] });
      }
      const body = `  let g = Probe(io[5u * i], io[5u * i + 1u], io[5u * i + 2u], io[5u * i + 3u]);
  let n = io[5u * i + 4u];
  io[5u * NIN + 2u * i] = vec4f(giIrradiance(g, n.xyz), 0.0);
  io[5u * NIN + 2u * i + 1u] = vec4f(giRadiance(g, n.xyz, n.w), 0.0);`;
      for (const [variant, lay, add] of [['LIGHTING', layouts, amb], ['LIGHTING_GI', libProbeLayouts('lib.gi'), [0, 0, 0]]]) {
        const r = await run({ label: `cave ambient ${variant}`, code: kernel(N, body, lib(g, { variant })),
          groups: groupsFor(lay, { frame: { ...FRAME, caveAmbient: amb }, io: io.slice() }), dispatch: [N / 64, 1, 1] });
        if (ranOk(`cave ambient kernel (${variant})`, r)) {
          const out = f32s(r.outputs['3.2']);
          const got = [], want = [];
          let clamped = 0;
          cases.forEach((c, i) => {
            const o = 4 * (5 * N + 2 * i), w = shRef(c.c0, c.cx, c.cy, c.cz, c.n, c.blur);
            if (w.irr.some((x) => x === 0) || w.rad.some((x) => x === 0)) clamped++;
            got.push([...out.subarray(o, o + 3), ...out.subarray(o + 4, o + 7)]);
            want.push([...w.irr.map((x, k) => x + add[k]), ...w.rad.map((x, k) => x + add[k])]);
          });
          const { max, at } = worst(got, want);
          check(`caveAmbient ${amb.join(', ')}: ${variant}'s giIrradiance, giRadiance = the SH ${add[0] ? '+ the floor' : 'alone (the GI passes take none)'}, ${N} probes (${clamped} clamped at 0 somewhere), max |err| ${fmt(max)}${at >= 0 ? ` (probe ${at})` : ''}`,
            max <= 2e-5 && clamped > 0);
        }
      }
    }

    // Fixed lamps (lampCol.w 1: a wall torch's, world/torchLights.js) in
    // lampLight: lit only while their cell holds a wall torch, nothing on the
    // torch's own head (within LAMP_FIXED_SELF of its centre on every axis),
    // and the shadow ray stops LAMP_FIXED_PAD short of the centre, so the
    // torch's own cell doesn't shade it. A torch in an empty box (every brick
    // marked as matter, so the trace walks every cell), lit from points
    // around it; the control: a hand lamp (w 0) in the same place is shaded
    // by the torch's cell (LAMP_PAD), and a dug-out torch lights nothing.
    {
      const torch = elementsM.E.WALL_TORCH, slots = g.nx * g.ny * g.nz, nbricks = slots / 64;
      const [{ cellSlot }, { LAMP_UNIT: U }] = await Promise.all([src('sim.js'), src('gfx/lamps.js')]);
      const S = 0;   // the lamp is a point (lampShape 0): its soft core is its radius, so none, and its shadow ray aims at its centre
      const L = [10.5, 8.5, 12.5], R = 14, col = [1, 0.5, 0.25];
      const state = (withTorch) => {
        const a = new Float32Array(2 * slots * 4);
        if (withTorch) {
          for (const copy of [0, 1]) a.set([torch, 20, 0, 0.25], 4 * (copy * slots + cellSlot(g, ...L.map(Math.floor))));
        }
        return { data: b64(new Uint8Array(a.buffer)) };
      };
      const bricksBuf = new ArrayBuffer(nbricks * bindings.BrickInfo.size);
      const dv = new DataView(bricksBuf);
      for (let i = 0; i < nbricks; i++) bindings.BrickInfo.write(dv, i * bindings.BrickInfo.size, { emit: [0, 0, 0], info: bindings.packBrickInfo({ matter: true }) });
      const lamps = (w) => {
        const pos = Array.from({ length: bindings.LAMP_MAX }, () => [0, 0, 0, 0]), c = pos.map((v) => [...v]);
        pos[0] = [...L, R];
        c[0] = [...col, w];
        return { ...FRAME, sunCol: [0, 0, 0], shadows: 0, lampCount: 1, lampPos: pos, lampCol: c };
      };
      const N = 128, io = new Float32Array(4 * 3 * N), pts = [];
      for (let i = 0; i < N; i++) {
        let p, n;
        if (i < 16) {   // the torch's own head
          p = L.map((v) => v + (rand() - 0.5) * 1.1);
          n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
        } else {   // around it, 1.5 to 9 cells off, facing it give or take (some away)
          const dir = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]), d = 1.5 + 7.5 * rand();
          p = L.map((v, k) => v + dir[k] * d);
          n = norm(dir.map((v) => -v + (rand() - 0.5) * (i % 5 === 0 ? 4 : 0.8)));
        }
        p = p.map(F); n = n.map(F);
        io.set([...p, 0], 4 * i);
        io.set([...n, 0], 4 * (N + i));
        pts.push({ p, n });
      }
      const lampWant = ({ p, n }) => {
        if (p.every((v, k) => Math.abs(v - L[k]) < 0.6)) return [0, 0, 0];
        const ro = p.map((v, k) => v + n[k] * 0.55), dvec = L.map((v, k) => v - ro[k]);
        const d2 = dvec.reduce((a, v) => a + v * v, 0);
        if (d2 >= R * R) return [0, 0, 0];
        const d = Math.sqrt(d2), l = dvec.map((v) => v / Math.max(d, 1e-4)), nl = n.reduce((a, v, k) => a + v * l[k], 0);
        if (nl <= 0) return [0, 0, 0];
        const x2 = d2 / (R * R), fade = 1 - x2 * x2;
        const fall = ((U * U + S * S) / (d2 + S * S)) * fade * fade;
        return col.map((c) => c * nl * fall);
      };
      const body = `  let p = io[i].xyz;
  let n = io[NIN + i].xyz;
  io[2u * NIN + i] = vec4f(lampLight(p, n, n), 0.0);`;
      const res = {};
      for (const [k, w, withTorch] of [['torch', 1, true], ['dug', 1, false], ['hand', 0, true]]) {
        const r = await run({ label: `lampLight ${k}`, code: kernel(N, body),
          groups: groupsFor(layouts, { frame: lamps(w), io: io.slice(), extra: { '1.0': state(withTorch), '2.16': { data: b64(new Uint8Array(bricksBuf)) } } }),
          dispatch: [N / 64, 1, 1] });
        if (ranOk(`lampLight kernel (${k})`, r)) res[k] = f32s(r.outputs['3.2']).slice(8 * N, 12 * N);
      }
      if (res.torch && res.dug && res.hand) {
        let e = 0, lit = 0, head = 0, dark = 0, handLit = 0;
        pts.forEach((pt, i) => {
          const want = lampWant(pt), got = res.torch.subarray(4 * i, 4 * i + 3);
          e = Math.max(e, ...want.map((v, k) => Math.abs(got[k] - v) / Math.max(1e-3, v)));
          if (want[0] > 0) lit++;
          if (i < 16 && want[0] === 0 && got[0] === 0) head++;
          if (res.dug[4 * i] !== 0 || res.dug[4 * i + 1] !== 0 || res.dug[4 * i + 2] !== 0) dark++;
          if (res.hand[4 * i] > 0) handLit++;
        });
        const heads = pts.slice(0, 16).filter((pt) => pt.p.every((v, k) => Math.abs(v - L[k]) < 0.6)).length;
        check(`lampLight, a wall torch's lamp: ${N} points (${lit} lit; ${heads} on its head, dark) == the JS twin within ${fmt(e)} relative (≤ 1e-4)`,
          e <= 1e-4 && lit > N / 2 && heads > 0 && head >= heads);
        check(`lampLight: a dug-out torch lights nothing (${dark} of ${N} points lit)`, dark === 0);
        check(`control: a hand lamp (w 0) in the torch's cell is shaded by it (LAMP_PAD): ${handLit} of ${N} points lit`, handLit === 0);
      }
    }

    // the far grid's texel: farUnpack / farPackTexel against the JS twins
    {
      const N = 128, words = new Uint32Array(N * 4 * 4), texels = [];
      const L = farM.farLayout(farM.WORLD_SIZE);
      for (let i = 0; i < N; i++) {
        const t = { s: Math.floor(rand() * 256), l: Math.floor(rand() * 256), glow: Math.floor(rand() * 256),
          id: Math.floor(rand() * 256), liquid: Math.floor(rand() * 256), open: rand() < 0.5, appearance: Math.floor(rand() * 11) };
        if (i === 0) Object.assign(t, { s: 255, l: 255, glow: 255, id: 255, liquid: 255, open: true });
        words.set(farM.packFarTexel(t), 4 * i);
        texels.push(t);
      }
      const io = new Float32Array(words.buffer);
      const code = `${head}\n${farM.farLayoutGLSL(L)}\n` + kernel(N, `  let t = bitcast<vec4u>(io[i]);
  let f = farUnpack(t);
  io[NIN + 2u * i] = bitcast<vec4f>(vec4u(u32(f.s), u32(f.l), u32(f.glow), u32(f.id)));
  io[NIN + 2u * i + 1u] = bitcast<vec4f>(vec4u(u32(f.liquid), select(0u, 1u, f.open), u32(f.appearance), 0u));
  io[3u * NIN + i] = bitcast<vec4f>(farPackTexel(f));`).slice(head.length);
      const r = await run({ label: 'far texel', code, groups: groupsFor(layouts, { io }), dispatch: [N / 64, 1, 1] });
      if (ranOk('far texel kernel', r)) {
        const out = new Uint32Array(fromB64(r.outputs['3.2']).buffer);
        const bad = [];
        texels.forEach((t, i) => {
          const o = 4 * (N + 2 * i), u = farM.unpackFarTexel(Array.from(words.subarray(4 * i, 4 * i + 4)));
          const got = { s: out[o], l: out[o + 1], glow: out[o + 2], id: out[o + 3], liquid: out[o + 4], open: out[o + 5] === 1, appearance: out[o + 6] };
          const back = Array.from(out.subarray(4 * (3 * N + i), 4 * (3 * N + i) + 4));
          const same = (x) => ['s', 'l', 'glow', 'id', 'liquid', 'open', 'appearance'].every((k) => x[k] === t[k]);
          if (!same(got) || !same(u)
              || back.join() !== Array.from(words.subarray(4 * i, 4 * i + 4)).join()) bad.push(i);
        });
        check(`far texel: ${N} texels unpacked as packed (JS twins and WGSL), repacked exactly`, !bad.length, bad.length ? `texels ${bad.slice(0, 8)}` : '');
      }
    }
  }
  check('no page errors', !errors.length, errors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `\nlib-check: ${failures} failure(s)` : '\nlib-check: clean');
process.exit(failures ? 1 : 0);
