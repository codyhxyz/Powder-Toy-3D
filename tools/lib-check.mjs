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
//            (farUnpack and farPackTexel against farShared.js's JS twins)
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
const [libM, common, bindings, farM, skyM, kernels, elementsM] = await Promise.all([
  src('shaders/gfx/lib.js'), src('shaders/common.js'), src('shaders/bindings.js'), src('shaders/farShared.js'),
  src('gfx/sky.js'), src('gpu/kernels.js'), src('elements.js')]);
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
const SH = { Y0: 0.282095, Y1: 0.488603, COS1: 2 / 3 };
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
        volume(bricks, (x, y, z) => [q(x / 4), q(y / 2), q(z / 3), q(((x + y + z) % 5) / 4)]),
        volume(bricks, (x, y, z) => [q(y / 2), q(z / 3), q(((2 * x + z) % 5) / 4), q(x / 8)]),
        volume(bricks, (x, y, z) => [q(((3 * y + x) % 7) / 4), q(z / 6), q(x / 4), 0.25]),
        volume(bricks, (x, y, z) => [q(z / 3), q(x / 8), 0.5, q(y / 4)]),
      ];
      const lt = volume(bricks, (x, y, z) => [q(((x * 3 + z) % 7) / 2), q(y), q(z / 6), 1]);
      const GI_OFFSET = 3;   // lighting.js: cells out along the normal a surface reads the probes
      const IN = 2, OUT = 13;
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
  io[o + 12u] = sp.cz;`), groups: groupsFor(layouts, { io, extra }), dispatch: [N / 64, 1, 1] });
      if (ranOk('3D-texture kernel', r)) {
        const out = f32s(r.outputs['3.2']);
        const fieldQ = (p, n) => clampV(p, [0.5, 0.5, 0.5], n.map((s) => s - 0.5));
        const brickQ = (p) => clampV(p.map((v) => v / 4), [0.5, 0.5, 0.5], bricks.map((s) => s - 0.5));
        const BANDS = ['c0', 'cx', 'cy', 'cz'];
        const sets = Object.fromEntries(['fieldTex', 'mediaField', 'fieldCubic', 'probeTex', ...BANDS.map((b) => `probeAt.${b}`),
          'sampleLight', ...BANDS.map((b) => `surfProbe.${b}`)].map((k) => [k, [[], []]]));
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

    // the far grid's texel: farUnpack / farPackTexel against the JS twins
    {
      const N = 128, words = new Uint32Array(N * 4 * 4), texels = [];
      const L = farM.farLayout(farM.WORLD_SIZE);
      for (let i = 0; i < N; i++) {
        const t = { s: Math.floor(rand() * 256), l: Math.floor(rand() * 256), glow: Math.floor(rand() * 256),
          id: Math.floor(rand() * 256), liquid: Math.floor(rand() * 256), open: rand() < 0.5 };
        if (i === 0) Object.assign(t, { s: 255, l: 255, glow: 255, id: 255, liquid: 255, open: true });
        words.set(farM.packFarTexel(t), 4 * i);
        texels.push(t);
      }
      const io = new Float32Array(words.buffer);
      const code = `${head}\n${farM.farLayoutGLSL(L)}\n` + kernel(N, `  let t = bitcast<vec4u>(io[i]);
  let f = farUnpack(t);
  io[NIN + 2u * i] = bitcast<vec4f>(vec4u(u32(f.s), u32(f.l), u32(f.glow), u32(f.id)));
  io[NIN + 2u * i + 1u] = bitcast<vec4f>(vec4u(u32(f.liquid), select(0u, 1u, f.open), 0u, 0u));
  io[3u * NIN + i] = bitcast<vec4f>(farPackTexel(f));`).slice(head.length);
      const r = await run({ label: 'far texel', code, groups: groupsFor(layouts, { io }), dispatch: [N / 64, 1, 1] });
      if (ranOk('far texel kernel', r)) {
        const out = new Uint32Array(fromB64(r.outputs['3.2']).buffer);
        const bad = [];
        texels.forEach((t, i) => {
          const o = 4 * (N + 2 * i), u = farM.unpackFarTexel(Array.from(words.subarray(4 * i, 4 * i + 4)));
          const got = { s: out[o], l: out[o + 1], glow: out[o + 2], id: out[o + 3], liquid: out[o + 4], open: out[o + 5] === 1 };
          const back = Array.from(out.subarray(4 * (3 * N + i), 4 * (3 * N + i) + 4));
          const same = (x) => ['s', 'l', 'glow', 'id', 'liquid', 'open'].every((k) => x[k] === t[k]);
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
