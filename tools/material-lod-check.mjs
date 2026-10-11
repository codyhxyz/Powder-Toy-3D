// The render materials' checks (docs/webgpu.md J1 U5):
//   leaf     the leaf fast path must be exactly the old fully faded material:
//            in matOf's E_PLANT branch (shaders/gfx/surface.js), once the
//            leaves are below a pixel (lodFade 0) it skips the 27-cell
//            cellular search and sets the averaged result directly (CPU: the
//            WGSL text, and the mix() algebra it relies on)
//   values   the same on the GPU: matOf for foliage at footprints where the
//            leaves have faded out gives exactly ALBEDO · MEAN, cavity MEAN,
//            no bump, its roughness, tint and translucency, at every point;
//            just inside the fade (lodFade a few 1e-5) the full search lands
//            within that weight of it, so the hand-off doesn't pop; lodFade
//            against its JS formula
//   floor    the floor's grid lines, shaded after the march where WGSL has
//            no derivatives, take fwidth from the ray derivatives surfView
//            kept (surface.js floorFwidth): in a fragment shader whose every
//            pixel sees the floor, against fwidth() itself (uniform control
//            flow), at the image centre for cameras at several elevations
//            and headings and across the screen (edges, corners) of 60° and
//            90° views; the same through a plane mirror (floorFwidthMirror,
//            reflectTrace's floor); surfView's pixel angle against each
//            pixel's own; controls: the no-derivative fallback (the ray's
//            heading) holds at the centre and drifts off it, and an
//            isotropic footprint is off everywhere, both by more than the
//            check allows
//   deltas   main's sync-2 changes on the GPU, against JS twins: crispT (a
//            crisp face's temperature, bilinear with its three neighbours in
//            the face's plane, gas and cells past the grid left out) at
//            points on three faces of a slab with a temperature ramp, and
//            crispSurf's T is it; whitewater's aerationAt over liquid records
//            only (the air holds the falling parcels' wakes), from the
//            current copy; controls: a cell's own temperature, and taps that
//            take the wakes, are off
//   combos   every combination of the close-up detail switches (gfx/detail.js
//            DETAIL: ten since smoothClose, 2^10 = 1024 module texts of the
//            realistic probe)
//            validates with Tint as check-wgsl (a) does (no error, no
//            warning), and each switch alone builds within
//            PIPELINE_BUDGET_MS as check-wgsl (b) does, with its time
// check-wgsl itself lists the off, balanced and full levels and the plain
// view (surface.js materialChecks); the 1024 here (about two minutes of Tint
// on SwiftShader, the builds aside) would weigh on every check-wgsl run.
// It serves the harness pages from its own Vite (tools/vite-server.mjs: --port N,
// else a free port) and launches Chromium through tools/browser.mjs.
//   node tools/material-lod-check.mjs [--only leaf,values,floor,deltas,combos] [--port N] [--budget ms]
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => import(pathToFileURL(join(ROOT, 'src', p)));
const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const ONLY = opt('--only')?.split(',') ?? ['leaf', 'values', 'floor', 'deltas', 'combos'];

const surface = await src('shaders/gfx/surface.js');
const { surfaceGLSL } = surface;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};

// matOf's E_PLANT branch, its constants read from the WGSL
const leafSrc = surfaceGLSL({}).split('} else if (id == E_PLANT) {')[1].split('} else if')[0];
const leafConst = (name) => {
  const m = new RegExp(`const ${name}: (?:f32|vec3f) = ([^;]+);`).exec(leafSrc);
  if (!m) throw new Error(`material-lod-check: no const ${name} in matOf's E_PLANT branch`);
  return m[1].startsWith('vec3f') ? m[1].slice(6, -1).split(',').map(Number) : m[1];
};

// ---------------------------------------------------------------- leaf (CPU)
if (ONLY.includes('leaf')) {
  console.log('leaf: the faded foliage fast path in the WGSL');
  const mean = +leafConst('MEAN');
  check('the fast path comes before the cellular search', leafSrc.indexOf('if (lw <= 0.0)') >= 0 && leafSrc.indexOf('if (lw <= 0.0)') < leafSrc.indexOf('mCell('));
  check('it sets the averaged albedo and cavity', leafSrc.includes('m.alb *= MEAN;') && leafSrc.includes('m.cav = MEAN;'));
  for (let i = 0; i < 100; i++) {
    const mix = (a, b, t) => a * (1 - t) + b * t;
    const alb = i / 99, rough = 0.5, arbitraryLeaf = i * 0.17, lw = 0;
    assert.equal(alb * mix(mean, arbitraryLeaf, lw), alb * mean);
    assert.equal(mix(mean, arbitraryLeaf, lw), mean);
    assert.equal(rough + arbitraryLeaf * lw, rough);
  }
  check('faded foliage skips the cellular search without changing its averaged material (mix algebra, 100 cases)', true);
}

// ---------------------------------------------------------------- GPU stages
if (['values', 'floor', 'deltas', 'combos'].some((k) => ONLY.includes(k))) {
  const { launchBrowser, gpuInfo } = await import('./browser.mjs');
  const { startVite } = await import('./vite-server.mjs');
  const { openHarness } = await import('./harness/open.mjs');
  const [common, bindings, kernels, detailM, elementsM, materialsM, scaleM, liquidDetailM] = await Promise.all([
    src('shaders/common.js'), src('shaders/bindings.js'), src('gpu/kernels.js'), src('gfx/detail.js'),
    src('elements.js'), src('gfx/materials.js'), src('scale.js'), src('shaders/gfx/liquidDetail.js')]);
  const BUDGET = Number(opt('--budget') ?? kernels.PIPELINE_BUDGET_MS);
  let gridLayout = null;
  try { ({ gridLayout } = await src('sim.js')); } catch { /* sizes alone */ }
  const g = gridLayout ? gridLayout(32, 32, 32) : { nx: 32, ny: 32, nz: 32 };
  const F = Math.fround;
  const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  const f32s = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(); };

  const vite = await startVite({ harness: true });
  const browser = await launchBrowser();
  try {
    const errors = [];
    // ------------------------------------------------------------ values
    if (ONLY.includes('values')) {
      const page = await openHarness(browser, vite, '/tools/harness/lib.html', { errors });
      const info = await gpuInfo(page);
      console.log(`\nvalues: gpu ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}, grid 32³`);
      // the leaves' lodFade frequency (cycles per cell) and where they are gone
      const LEAF_F = F(F(scaleM.CELL_M) / F(+leafConst('LEAF_M')));
      const fLeaf = F(LEAF_F * F(+leafConst('LEAF_LOD')));
      const { DETAIL_FADE_LO: lo, DETAIL_FADE_HI: hi } = detailM;
      const lodFade = (f, fp) => { const t = Math.min(Math.max((f * fp - lo) / (hi - lo), 0), 1); return 1 - t * t * (3 - 2 * t); };
      // the same in f32 as the GPU computes it: near the fade's end 1 - smoothstep
      // cancels, so the weight the kernel used is this, not the exact one
      const lodFade32 = (f, fp) => {
        const t = Math.min(Math.max(F(F(F(f * fp) - F(lo)) / F(hi - lo)), 0), 1);
        return F(1 - F(F(t * t) * F(3 - F(2 * t))));
      };
      // one unit in the last place of v (f32): the rounding of a sum near v
      const ulp = (v) => 2 ** (Math.floor(Math.log2(Math.max(Math.abs(v), 2 ** -126))) - 23);
      // points: N faded (f·fp from just past HI to far), N just inside the fade
      const N = 128;
      const rand = (() => { let s = 0x1234567; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
      const io = new Float32Array(2 * N * 4 + 2 * N * 4 * 4 + 64 * 4 * 2);
      const pts = [];
      for (let i = 0; i < 2 * N; i++) {
        const faded = i < N;
        const x = faded ? hi * (1.001 + 3 * rand()) : hi * (1 - 2e-3 * (0.2 + rand()));   // f·fp
        const fp = F(x / fLeaf);
        const p = [F((rand() - 0.5) * 600), F(rand() * 120), F((rand() - 0.5) * 600)];
        io.set([...p, fp], 4 * i);
        pts.push({ p, fp, faded, lw: lodFade32(fLeaf, fp) });
      }
      // lodFade spot values: (f, fp) pairs across the fade
      const lods = [];
      for (let i = 0; i < 64; i++) {
        const f = F(0.5 + 30 * rand()), fp = F((rand() * 0.7) / f);
        lods.push({ f, fp });
        io.set([f, fp, 0, 0], 4 * (2 * N + 8 * N + i));
      }
      const frame = new ArrayBuffer(bindings.FrameUniforms.size);
      bindings.FrameUniforms.write(new DataView(frame), 0, { matDetail: 1, sun: [0.4, 0.8, 0.45], sunCol: [1, 1, 1], shadowRes: 128 });
      const header = new ArrayBuffer(common.Header.size);
      common.Header.write(new DataView(header), 0, { origin: [0, 0, 0], src: 0, dst: 0 });
      const layouts = surface.materialProbeLayouts().map((e) => [...e]);
      layouts[3] = [...layouts[3], { binding: 2, visibility: common.STAGE.COMPUTE, buffer: { type: 'storage' } }];
      const fill = {
        '0.0': { data: b64(new Uint8Array(common.tablesBuffer())) }, '0.1': { data: b64(new Uint8Array(frame)) },
        '3.0': { data: b64(new Uint8Array(header)) }, '3.1': { size: 256 },
        '3.2': { data: b64(new Uint8Array(io.buffer)), read: true }, '2.15': { samp: { address: 'repeat' } },
      };
      const groups = layouts.map((entries, gi) => entries.map((e) => ({ ...e, ...(fill[`${gi}.${e.binding}`] ?? {}) })));
      // a compute kernel on the material module: no derivatives here (surfView
      // isn't called; matOf takes the footprint as an argument)
      const code = `${surface.materialModule(g, {})}
@group(3) @binding(2) var<storage, read_write> io: array<vec4f>;
const NP: u32 = ${2 * N}u;
const NL: u32 = 64u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  gFragCoord = vec2f(0.5);
  if (i < NP) {
    let q = io[i];
    let m = matOf(E_PLANT, q.xyz, normalize(vec3f(0.3, 1.0, 0.2)), AMBIENT, 0.0, q.w);
    io[NP + 4u * i] = vec4f(m.alb, m.cav);
    io[NP + 4u * i + 1u] = vec4f(m.g, m.rough);
    io[NP + 4u * i + 2u] = vec4f(m.sssCol, m.trans);
    io[NP + 4u * i + 3u] = vec4f(m.metal, m.f0, m.sss, m.glint);
  } else if (i < NP + NL) {
    let j = NP + 4u * NP + (i - NP);
    let q = io[j];
    io[j] = vec4f(q.xy, lodFade(q.x, q.y), 0.0);
  }
}`;
      const r = await page.evaluate((j) => window.__harness.run('run', j), {
        label: 'material-lod values', code, kind: 'compute', groups, dispatch: [Math.ceil((2 * N + 64) / 64), 1, 1], budgetMs: BUDGET });
      const msgs = r.messages.filter((m) => m.type !== 'info').map((m) => `${m.type} ${m.line}:${m.col} ${m.text}`).slice(0, 6).join(' | ');
      if (check(`kernel: ${code.split('\n').length} lines, module ${r.moduleMs.toFixed(0)} ms, pipeline ${r.pipelineMs.toFixed(0)} ms`, r.ok && !msgs, r.ok ? msgs : `${r.stage}: ${r.error} ${msgs}`)) {
        const out = f32s(r.outputs['3.2']);
        const plant = elementsM.E.PLANT;
        const look = materialsM.LOOK[plant];
        const mean = F(+leafConst('MEAN'));
        const albFaded = look.alb.map((a) => F(F(a) * mean));
        const tint = leafConst('DEEP_TINT').map(F);
        const rough = F(look.rough);
        let exactBad = 0, worst = { alb: 0, cav: 0, g: 0, rough: 0 }, worstRel = 0;
        const firstBad = [];
        pts.forEach((pt, i) => {
          const o = 4 * (2 * N + 4 * i);
          const alb = out.subarray(o, o + 3), cav = out[o + 3], gv = out.subarray(o + 4, o + 7), rgh = out[o + 7];
          const sss = out.subarray(o + 8, o + 11), trans = out[o + 11];
          if (pt.faded) {
            const ok = alb.every((v, k) => v === albFaded[k]) && cav === mean && gv.every((v) => v === 0) && rgh === rough
              && sss.every((v, k) => v === tint[k]) && trans === 1;
            if (!ok) { exactBad++; if (firstBad.length < 3) firstBad.push(`p ${pt.p.map((v) => v.toFixed(1))} fp ${pt.fp}: alb ${Array.from(alb)} cav ${cav} g ${Array.from(gv)} rough ${rgh}`); }
          } else {
            // |Δ| / lodFade, after the f32 rounding of the result itself (2 ulp)
            const lw = Math.max(pt.lw, 1e-9);
            const rel = (got, want, scale = 1) => Math.max(Math.abs(got - want) - 2 * ulp(want), 0) / (lw * scale);
            worst.alb = Math.max(worst.alb, ...Array.from(alb).map((v, k) => rel(v, albFaded[k], Math.max(albFaded[k], 1e-6))));
            worst.cav = Math.max(worst.cav, rel(cav, mean));
            worst.g = Math.max(worst.g, Math.hypot(...gv) / lw);
            worst.rough = Math.max(worst.rough, rel(rgh, rough));
            worstRel = Math.max(worstRel, pt.lw);
          }
        });
        check(`faded foliage: ${N} points, matOf gives exactly ALBEDO·MEAN, cavity MEAN, no bump, its roughness, tint and translucency`,
          exactBad === 0, firstBad.join('; '));
        // just inside the fade the slow path differs from the faded result by
        // at most its weight times the swing of each term (gfx/surface.js: the
        // albedo mixes toward a leaf or the clump's depth, at most ~2.1× MEAN
        // apart; the cavity toward 0.2..1; the bump's tilt ~1.1 plus curl ~1
        // per unit weight; the roughness ±WAX_VAR/2)
        check(`fade edge: ${N} points with lodFade ≤ ${worstRel.toExponential(1)}, |Δ| / lodFade: albedo ${worst.alb.toFixed(2)} (≤ 2.5), cavity ${worst.cav.toFixed(2)} (≤ 1), bump ${worst.g.toFixed(2)} (≤ 3), roughness ${worst.rough.toFixed(3)} (≤ 0.125)`,
          worst.alb <= 2.5 && worst.cav <= 1 && worst.g <= 3 && worst.rough <= 0.125);
        let lodErr = 0;
        lods.forEach(({ f, fp }, i) => { lodErr = Math.max(lodErr, Math.abs(out[4 * (10 * N + i) + 2] - lodFade(f, fp))); });
        check(`lodFade: 64 (f, fp) pairs across the fade against 1 - smoothstep(${lo}, ${hi}, f·fp), max |err| ${lodErr.toExponential(2)}`, lodErr <= 1e-6);
      }
      await page.close();
    }

    // ------------------------------------------------------------ floor
    if (ONLY.includes('floor')) {
      const page = await openHarness(browser, vite, '/tools/harness/lib.html', { errors });
      console.log('\nfloor: the grid lines\' fwidth from the ray derivatives against fwidth(), a 4×4 patch per run');
      // Pinhole cameras without roll: eye height h, elevation of the view el
      // (degrees below the horizon), heading hd (degrees about y), pix =
      // tan(fovY/2) / (half the screen's height): radians per pixel at the
      // image centre. A run renders a 4×4 patch whose centre sits off (x, y)
      // pixels from the image centre (y down).
      const runs = [];
      for (const el of [8, 20, 45, 70, 89]) for (const hd of [0, 37, 90, 211]) runs.push({ el, hd, h: 40, pix: 1e-3, off: [0, 0] });
      runs.push({ el: 30, hd: 15, h: 300, pix: 2e-4, off: [0, 0] }, { el: 60, hd: 300, h: 5, pix: 4e-3, off: [0, 0] });
      // across a 1600×900 screen: its edges' midpoints and corners
      const W = 800, H = 450;
      const offs = [[W, 0], [-W, 0], [0, H], [0, -H], [W, H], [-W, H], [W, -H], [-W, -H]];
      const views = [];
      for (const el of [20, 45, 70]) for (const hd of [37, 211]) views.push({ el, hd, fov: 60 });
      views.push({ el: 30, hd: 120, fov: 90 }, { el: 60, hd: 120, fov: 90 });
      for (const v of views) {
        const pix = Math.tan((v.fov * Math.PI) / 360) / H;
        for (const off of [[0, 0], ...offs]) runs.push({ ...v, h: 40, pix, off });
      }
      const PIX_SCALE = 1.5;   // a render scale, so the factor GLSL applied to fwidth is checked too
      const frame = new ArrayBuffer(bindings.FrameUniforms.size);
      bindings.FrameUniforms.write(new DataView(frame), 0, { pixScale: PIX_SCALE, sun: [0.4, 0.8, 0.45] });
      const header = new ArrayBuffer(common.Header.size);
      common.Header.write(new DataView(header), 0, { origin: [0, 0, 0], src: 0, dst: 0 });
      const layouts = surface.materialProbeLayouts().map((e) => [...e]);
      layouts[3] = [...layouts[3], { binding: 2, visibility: common.STAGE.FRAGMENT, buffer: { type: 'storage' } }];
      // io: [0] eye, pix; [1] forward; [2] the patch's offset; [3] the
      // mirror's plane (unit normal facing the eye, d: n·p = d); then 16
      // pixels each of: [4+] fwidth (x, z), floorFwidth; [20+] surfView's
      // angle, the no-derivative fallback, an isotropic footprint/|rd.y|;
      // [36+] through the mirror: fwidth, floorFwidthMirror; [52+] rd.y,
      // the mirror point's height, the reflected ray's y, its distance;
      // [68+] floorFwidth of the reflected floor point
      const code = `${surface.materialModule(g, {})}
${(await src('gpu/wgsl.js')).fullscreenVert('vs')}
@group(3) @binding(2) var<storage, read_write> io: array<vec4f>;
@fragment fn fs(frag: FullScreen) -> @location(0) vec4f {
  gFragCoord = frag.position.xy;
  let eye = io[0].xyz;
  let pix = io[0].w;
  let fwd = io[1].xyz;
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let px = frag.position.xy - 2.0 + io[2].xy;   // from the image centre, y down
  let rd = normalize(fwd + (px.x * right - px.y * up) * pix);
  surfView(eye, rd);
  // (uniform control flow throughout: nothing branches, so fwidth() is exact)
  let hp = eye + rd * (-eye.y / rd.y);
  let fw = fwidth(worldPos(hp).xz) * FU.pixScale;   // the GLSL's fwidth(q) * uPixScale, q in cells
  let i = u32(frag.position.x) + 4u * u32(frag.position.y);
  io[4u + i] = vec4f(fw, floorFwidth(hp, rd));
  let fallback = floorFwidthRay(distance(hp, eye), rd, vec3f(0.0), vec3f(0.0));
  io[20u + i] = vec4f(gPixAng, fallback, footprint(hp) / max(abs(rd.y), 1e-3));
  // a plane mirror between the eye and the floor, as reflectTrace starts off it
  let nm = io[3].xyz;
  let tm = (io[3].w - dot(nm, eye)) / dot(nm, rd);
  let m = eye + rd * tm;
  let r = reflect(rd, nm);
  let ro = m + nm * REFL_START;
  let hr = ro - r * (ro.y / r.y);
  io[36u + i] = vec4f(fwidth(worldPos(hr).xz) * FU.pixScale, floorFwidthMirror(hr, r, ro));
  io[52u + i] = vec4f(rd.y, m.y, r.y, tm);
  io[68u + i] = vec4f(floorFwidth(hr, r), 0.0, 0.0);   // (the control: as if the ray came straight from the eye)
  return vec4f(0.0);
}`;
      const fill = {
        '0.0': { data: b64(new Uint8Array(common.tablesBuffer())) }, '0.1': { data: b64(new Uint8Array(frame)) },
        '3.0': { data: b64(new Uint8Array(header)) }, '3.1': { size: 256 }, '2.15': { samp: { address: 'repeat' } },
      };
      // each pixel's own angle, as dpdx/dpdy take it: the step to its quad
      // neighbour of the unit ray, the larger of the two axes
      const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
      const rayAt = (c, f, r, u, x, y) => norm([0, 1, 2].map((k) => f[k] + (x * r[k] - y * u[k]) * c.pix));
      const STEEP = 0.05;   // |rd.y| below this the floor is so foreshortened that fwidth's one-pixel difference isn't a derivative
      const stat = () => ({ worst: 0, n: 0, at: '' });
      const on = stat(), offAxis = stat(), mirror = stat(), straight = stat(), ang = stat(), fbOn = stat(), fbOff = stat(), naive = stat();
      const note = (s, e, at) => { s.n++; if (e > s.worst) { s.worst = e; s.at = at; } };
      const bad = [];
      let ran = 0, mirrorRuns = 0, skipped = 0;
      for (const c of runs) {
        const el = (c.el * Math.PI) / 180, hd = (c.hd * Math.PI) / 180;
        const fwdv = [Math.cos(el) * Math.sin(hd), -Math.sin(el), Math.cos(el) * Math.cos(hd)];
        const right = norm([-fwdv[2], 0, fwdv[0]]);   // cross(fwd, y)
        const up = [right[1] * fwdv[2] - right[2] * fwdv[1], right[2] * fwdv[0] - right[0] * fwdv[2], right[0] * fwdv[1] - right[1] * fwdv[0]];
        // the patch's centre ray; the mirror: a plane through its point at 40%
        // of the way to the floor, facing back along the view's heading and
        // tipped down 10° (the ray turns down, so it still meets the floor),
        // upright for steep views
        const eye = [7.3, c.h, -11.9];
        const rc = rayAt(c, fwdv, right, up, c.off[0], c.off[1]);
        const pm = eye.map((e, k) => e + rc[k] * 0.4 * (-eye[1] / rc[1]));
        const tip = c.el >= 45 ? 0 : -Math.sin(Math.PI / 18);
        const hv = norm([rc[0], 0, rc[2]]);
        const nm = norm([-hv[0], tip, -hv[2]]);
        const io = new Float32Array(84 * 4);
        io.set([...eye, c.pix, ...fwdv, 0, ...c.off, 0, 0, ...nm, nm[0] * pm[0] + nm[1] * pm[1] + nm[2] * pm[2]]);
        const groups = layouts.map((entries, gi) => entries.map((e) => ({ ...e,
          ...(gi === 3 && e.binding === 2 ? { data: b64(new Uint8Array(io.buffer)), read: true } : fill[`${gi}.${e.binding}`] ?? {}) })));
        const where = `${c.fov ? `${c.fov}° view ` : ''}el ${c.el}° hd ${c.hd}° patch (${c.off})`;
        const r = await page.evaluate((j) => window.__harness.run('run', j), { label: `floor ${where}`, code, kind: 'render', groups, budgetMs: BUDGET });
        if (!r.ok) { bad.push(`${where}: ${r.stage}: ${r.error}`); continue; }
        ran++;
        const out = f32s(r.outputs['3.2']);
        const px = (i) => [(i & 3) - 1.5 + c.off[0], (i >> 2) - 1.5 + c.off[1]];
        const at = (i, k) => out.subarray(4 * (k + i), 4 * (k + i + 1));
        const rows = [...Array(16).keys()];
        if (!rows.every((i) => at(i, 52)[0] < -STEEP)) { skipped++; continue; }   // part of the patch above or near the horizon
        const centre = c.off[0] === 0 && c.off[1] === 0;
        for (const i of rows) {
          const [fx, fz, ax, az] = at(i, 4);
          const [ga, hx, hz, nv] = at(i, 20);
          const e = Math.max(Math.abs(ax / fx - 1), Math.abs(az / fz - 1));
          note(centre ? on : offAxis, e, `${where} pixel ${i}`);
          if (!(e <= 0.03) && bad.length < 6) bad.push(`${where} pixel ${i}: fwidth (${fx.toPrecision(4)}, ${fz.toPrecision(4)}) floorFwidth (${ax.toPrecision(4)}, ${az.toPrecision(4)})`);
          note(centre ? fbOn : fbOff, Math.max(Math.abs(hx / fx - 1), Math.abs(hz / fz - 1)), `${where} pixel ${i}`);
          note(naive, Math.max(Math.abs(nv / fx - 1), Math.abs(nv / fz - 1)), where);
          // the pixel's angle: forward differences within its 2×2 quad
          const [x, y] = px(i), qx = x - (i & 1), qy = y - ((i >> 2) & 1);
          const d = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
          const want = PIX_SCALE * Math.max(d(rayAt(c, fwdv, right, up, qx + 1, y), rayAt(c, fwdv, right, up, qx, y)),
            d(rayAt(c, fwdv, right, up, x, qy + 1), rayAt(c, fwdv, right, up, x, qy)));
          note(ang, Math.abs(ga / want - 1), `${where} pixel ${i}`);
        }
        // through the mirror, where every pixel's ray meets it in front of the
        // eye above the floor and leaves it steeply enough down (and not for
        // the 89° views, whose rays would graze the upright mirror)
        if (c.el <= 70 && rows.every((i) => at(i, 52)[3] > 0 && at(i, 52)[1] > 0 && at(i, 52)[2] < -STEEP)) {
          mirrorRuns++;
          for (const i of rows) {
            const [fx, fz, ax, az] = at(i, 36);
            const e = Math.max(Math.abs(ax / fx - 1), Math.abs(az / fz - 1));
            note(mirror, e, `${where} pixel ${i}`);
            const [sx, sz] = at(i, 68);
            note(straight, Math.max(Math.abs(sx / fx - 1), Math.abs(sz / fz - 1)), `${where} pixel ${i}`);
            if (!(e <= 0.03) && bad.length < 6) bad.push(`${where} mirror pixel ${i}: fwidth (${fx.toPrecision(4)}, ${fz.toPrecision(4)}) floorFwidthMirror (${ax.toPrecision(4)}, ${az.toPrecision(4)})`);
          }
        }
      }
      const pct = (s) => `${(s.worst * 100).toFixed(1)}%`;
      // fwidth is a difference between neighbouring pixels, the analytic form
      // the derivative at the pixel: they agree to first order, and differ by
      // about a pixel's change of the derivative, most at grazing views
      check(`${ran}/${runs.length} runs (${skipped} patches near the horizon left out): floorFwidth/fwidth within ${pct(on)} at the image centre (${on.n} pixels: elevation 8-89°, four headings, eye 5-300 cells up) and ${pct(offAxis)} off it (${offAxis.n} pixels: edges and corners of 60° and 90° views) (≤ 3%)`,
        ran === runs.length && on.n > 0 && offAxis.n > 0 && on.worst <= 0.03 && offAxis.worst <= 0.03, bad.join('; '));
      check(`through a plane mirror (reflectTrace's floor): floorFwidthMirror/fwidth within ${pct(mirror)} (${mirror.n} pixels, ${mirrorRuns} patches) (≤ 3%)`, mirrorRuns >= 20 && mirror.worst <= 0.03, `worst at ${mirror.at}`);
      check(`surfView's pixel angle within ${(ang.worst * 100).toFixed(2)}% of each pixel's own (≤ 1%)`, ang.worst <= 0.01, `worst at ${ang.at}`);
      // controls: the fallback (no derivatives, surfViewAng) takes the screen's
      // axes as across and along the ray's heading, true only near the image
      // centre; an isotropic footprint is off everywhere. The check sees both.
      check(`control: the no-derivative fallback within ${pct(fbOn)} at the image centre (≤ 12%), off by up to ${pct(fbOff)} off it (${fbOff.at}; the check sees it: > 30%)`,
        fbOn.worst <= 0.12 && fbOff.worst > 0.3);
      check(`control: floorFwidth in the mirror (the straight distance from the eye, the derivatives unturned) is off by up to ${pct(straight)} (the check sees it: > 30%)`, straight.worst > 0.3);
      check(`control: an isotropic footprint/|rd.y| is off by up to ${(naive.worst * 100).toFixed(0)}% (the check sees it: > 50%)`, naive.worst > 0.5);
      await page.close();
    }

    // ------------------------------------------------------------ deltas
    if (ONLY.includes('deltas')) {
      const page = await openHarness(browser, vite, '/tools/harness/lib.html', { errors });
      console.log('\ndeltas: main\'s sync-2 changes to the materials, against JS twins');
      const { cellSlot } = await src('sim.js');
      const E = elementsM.E;
      const S = g.nx * g.ny * g.nz;
      // state A, copy 0 (the header reads it): a 6×6 metal slab at y = 10 on
      // the grid's x = 0 face, its temperature a ramp; steam beside it (gas:
      // left out), a hot metal cell on top of it (a neighbour of its x faces)
      const A = new Float32Array(4 * S);
      const cells = new Map();
      const put = (x, y, z, id, T) => { A.set([id, T, 0, 0.25], 4 * cellSlot(g, x, y, z)); cells.set(`${x},${y},${z}`, { id, T }); };
      for (let x = 0; x < 6; x++) for (let z = 8; z < 14; z++) put(x, 10, z, E.METAL, 100 + 37 * x + 11 * z);
      put(6, 10, 10, E.STEAM, 900);
      put(3, 11, 10, E.METAL, 500);
      const at = (x, y, z) => cells.get(`${x},${y},${z}`) ?? { id: E.EMPTY, T: 0 };
      const gasLike = (id) => id === E.EMPTY || elementsM.ELEMENTS[id].kind === elementsM.K.GAS;
      const outside = (c) => c.some((v, k) => v < 0 || v >= [g.nx, g.ny, g.nz][k]);
      // the JS twin of crispT (shaders/gfx/surface.js), in doubles
      const crispT = (cell, T, hp, face) => {
        const fa = face.map(Math.abs);
        const u = fa[0] === 1 ? [0, 1, 0] : [1, 0, 0], v = fa[2] === 1 ? [0, 1, 0] : [0, 0, 1];
        const f = hp.map((h, k) => Math.min(Math.max(h - cell[k] - 0.5, -0.5), 0.5));
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const fu = dot(f, u), fv = dot(f, v);
        const su = fu < 0 ? u.map((x) => -x) : u, sv = fv < 0 ? v.map((x) => -x) : v;
        const wu = Math.abs(fu), wv = Math.abs(fv), w0 = (1 - wu) * (1 - wv);
        let sum = T * w0, wsum = w0;
        const taps = [[su, wu * (1 - wv)], [sv, (1 - wu) * wv], [su.map((x, k) => x + sv[k]), wu * wv]];
        for (const [d, w] of taps) {
          const c = cell.map((x, k) => x + d[k]);
          if (outside(c) || gasLike(at(...c).id)) continue;
          sum += w * at(...c).T;
          wsum += w;
        }
        return sum / wsum;
      };
      const rnd = (() => { let st = 0x2468ace; return () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296; }; })();
      const FACES = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, -1]];
      const pts = [];
      for (const [x, z] of [[0, 8], [0, 11], [2, 10], [3, 10], [5, 10], [5, 13], [4, 9]])
        for (const face of FACES)
          for (let k = 0; k < 6; k++) {
            const cell = [x, 10, z], fu = rnd() - 0.5, fv = rnd() - 0.5;
            const fa = face.map(Math.abs);
            const u = fa[0] === 1 ? [0, 1, 0] : [1, 0, 0], v = fa[2] === 1 ? [0, 1, 0] : [0, 0, 1];
            const hp = cell.map((c, j) => F(c + 0.5 + 0.5 * face[j] + fu * u[j] + fv * v[j]));
            pts.push({ cell, face, hp, want: crispT(cell, at(...cell).T, hp, face), own: at(...cell).T });
          }
      // aeration (lighting group binding 19, two copies of vec2u per slot):
      // copy 1 holds liquid records in a 4×4×4 block (y 1, or 2 in a stream)
      // and falling parcels' wakes in the air beside it (y 0); copy 0 a decoy
      const half = (x) => {
        if (x === 0) return 0;
        const bits = new Uint32Array(new Float32Array([x]).buffer)[0];
        return ((bits >>> 16) & 0x8000) | ((((bits >>> 23) & 255) - 112) << 10) | ((bits >>> 13) & 1023);
      };
      const aerWords = new Uint32Array(4 * S);
      const recs = new Map();
      const rec = (x, y, z, f, copy = 1) => {
        const i = 2 * (copy * S + cellSlot(g, x, y, z));
        aerWords[i] = half(f[0]) | (half(f[1]) << 16);
        aerWords[i + 1] = half(f[2]) | (half(f[3]) << 16);
        if (copy === 1) recs.set(`${x},${y},${z}`, f);
      };
      for (let x = 20; x < 24; x++) for (let y = 18; y < 22; y++) for (let z = 20; z < 24; z++) {
        rec(x, y, z, [((x + 2 * y + 3 * z) % 5) / 4, (x + z) % 3 ? 1 : 2, 0, (y + x) % 2]);
      }
      for (let y = 18; y < 24; y++) for (const [x, z] of [[24, 21], [19, 22], [22, 24]]) rec(x, y, z, [1, 0, 0.5, 0.75]);
      for (let y = 22; y < 24; y++) for (let x = 20; x < 24; x++) rec(x, y, 22, [0, 0, 0.25, 0.875]);
      for (let x = 18; x < 26; x++) for (let y = 16; y < 24; y++) for (let z = 18; z < 26; z++) rec(x, y, z, [0.5, 1, 0, 1], 0);
      for (let x = 2; x <= 10; x++) for (let y = 2; y <= 10; y++) for (let z = 2; z <= 10; z++) rec(x, y, z, [0.625, 1, 0, 1]);   // a resting raft
      // the JS twins of aerationAt: liquid taps only (main's), and every record's (x, y, w) (the control)
      const aerAt = (p, liquidOnly) => {
        const q = p.map((v) => v - 0.5), c = q.map(Math.floor), f = q.map((v, k) => v - c[k]);
        const s = [0, 0, 0];
        for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const r = recs.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? [0, 0, 0, 0];
          const tap = liquidOnly ? (r[1] > 0.5 ? [r[0], 1, r[3]] : [0, 0, 0]) : [r[0], r[1], r[3]];
          const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
          tap.forEach((t, k) => { s[k] += w * t; });
        }
        return s[1] > 0.02 ? [Math.min(Math.max(s[0] / s[1], 0), 1), Math.min(Math.max(s[2] / s[1], 0), 1)] : [0, 0];
      };
      const apts = [];
      for (let k = 0; k < 96; k++) {
        const p = [19 + 6 * rnd(), 17.5 + 7 * rnd(), 19 + 6 * rnd()].map(F);
        apts.push({ p, want: aerAt(p, true), old: aerAt(p, false) });
      }
      // whitewater v2's foam (liquidFoam, liquidUnderSkin) where pixels are far
      // too big for the streaks and the raft's pattern (lodFade 0: their means),
      // so it is the formulas alone: the thin mask's jet channels (fieldThin y,
      // z) in three regions, a raft from the aeration above, rays entering and
      // leaving at every angle
      const wg = (name) => {
        const m = new RegExp(`const ${name}: f32 = ([^;]+);`).exec(liquidDetailM.liquidDetailGLSL({ DETAIL_LIQ_FOAM: 1 }));
        if (!m) throw new Error(`material-lod-check: no const ${name} in liquidDetailGLSL`);
        return F(+m[1]);
      };
      const JET = { TAU: wg('JET_TAU'), FRINGE: wg('JET_FRINGE'), EDGE_MIN: wg('JET_EDGE_MIN'), M_MIN: wg('JET_M_MIN'), COVER: wg('FOAM_COVER_MAX') };
      // fieldThin (lighting binding 2): (0, aeration × presence, presence, 0) by region
      const REGIONS = { A: [0.5, 1], B: [0.375, 0.5], C: [0.0078125, 0.015625] };
      const regionOf = (x, z) => (z >= 16 ? 'B' : x >= 24 ? 'C' : 'A');
      const thin = new Uint16Array(4 * S);
      for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
        const [ym, m] = REGIONS[regionOf(x, z)];
        thin.set([0, half(ym), half(m), 0], 4 * (x + g.nx * (y + g.ny * z)));
      }
      const smooth = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };
      const unit = () => { for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], l = Math.hypot(...v); if (l > 0.2 && l < 1) return v.map((x) => x / l); } };
      const fpts = [];
      for (const [lo, hi] of [[[4, 4, 4], [8, 8, 8]], [[12, 12, 4], [20, 16, 12]], [[4, 3, 19], [12, 12, 28]], [[26, 12, 4], [30, 16, 12]]])
        for (let k = 0; k < 24; k++) {
          const p = lo.map((v, j) => F(v + (hi[j] - v) * rnd()));
          const n = unit().map(F);
          let rd = unit().map(F);
          const d0 = n.reduce((a, v, j) => a + v * rd[j], 0);
          if ((k & 1) === (d0 < 0 ? 1 : 0)) rd = rd.map((v) => -v);   // half entering, half leaving
          const dot = n.reduce((a, v, j) => a + v * rd[j], 0), chord = Math.abs(dot);
          const aer = aerAt(p.map((v, j) => v - n[j] * 0.25), true), raft = aer[0] * aer[1];
          const [ym, m] = REGIONS[regionOf(p[0], p[2])];
          const jw = m > JET.M_MIN && dot < 0 ? Math.min(Math.max(ym / m, 0), 1) : 0;
          let t1 = 1, jc = 0;
          if (Math.max(raft, jw) > 0) {
            const c = JET.COVER * raft;
            const cj = jw > 0 ? jw * (1 - Math.exp(-JET.TAU * chord)) * smooth(0, Math.max(Math.sqrt(JET.FRINGE * jw), JET.EDGE_MIN), chord) : 0;
            if (c > 0 || cj > 0) { t1 = 1 - c; jc = cj; }
          }
          fpts.push({ p, n, rd, raft, jw, want: [t1, jc, t1 * (1 - jc), 0] });
        }
      const NP = pts.length, NA = apts.length, NF = fpts.length;
      const io = new Float32Array(4 * (2 * NP + NP + 2 * NA + 4 * NF));
      const faceIndex = (fc) => FACES.findIndex((x) => x.every((v, k) => v === fc[k]));
      pts.forEach((pt, i) => { io.set([...pt.hp, faceIndex(pt.face)], 4 * i); io.set([...pt.cell, 0], 4 * (NP + i)); });
      apts.forEach((pt, i) => io.set([...pt.p, 0], 4 * (3 * NP + i)));
      fpts.forEach((pt, i) => io.set([...pt.p, 0, ...pt.n, 0, ...pt.rd, 0], 4 * (3 * NP + 2 * NA + 4 * i)));
      const frame = new ArrayBuffer(bindings.FrameUniforms.size);
      bindings.FrameUniforms.write(new DataView(frame), 0, { matDetail: 1, sun: [0.4, 0.8, 0.45], sunCol: [1, 1, 1], shadowRes: 128 });
      const header = new ArrayBuffer(common.Header.size);
      common.Header.write(new DataView(header), 0, { origin: [0, 0, 0], src: 0, dst: 0 });
      const layouts = surface.materialProbeLayouts().map((e) => [...e]);
      layouts[3] = [...layouts[3], { binding: 2, visibility: common.STAGE.COMPUTE, buffer: { type: 'storage' } }];
      const fill = {
        '0.0': { data: b64(new Uint8Array(common.tablesBuffer())) }, '0.1': { data: b64(new Uint8Array(frame)) },
        '1.0': { data: b64(new Uint8Array(A.buffer)) }, '1.1': { size: 16 * S },
        '2.19': { data: b64(new Uint8Array(aerWords.buffer)) },
        '2.2': { tex: { format: 'rgba16float', size: [g.nx, g.ny, g.nz], data: b64(new Uint8Array(thin.buffer)) } },
        '3.0': { data: b64(new Uint8Array(header)) }, '3.1': { size: 256 },
        '3.2': { data: b64(new Uint8Array(io.buffer)), read: true }, '2.15': { samp: { address: 'repeat' } },
      };
      const groups = layouts.map((entries, gi) => entries.map((e) => ({ ...e, ...(fill[`${gi}.${e.binding}`] ?? {}) })));
      const code = `${surface.materialModule(g, { DETAIL_LIQ_FOAM: 1 })}
@group(3) @binding(2) var<storage, read_write> io: array<vec4f>;
const NP: u32 = ${NP}u;
const NA: u32 = ${NA}u;
const NF: u32 = ${NF}u;
var<private> FACE: array<vec3i, 4> = array<vec3i, 4>(${FACES.map((fc) => `vec3i(${fc.join(', ')})`).join(', ')});
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  gFragCoord = vec2f(0.5);
  gAerCopy = 1u;
  if (i < NP) {
    let q = io[i];
    let cell = vec3i(io[NP + i].xyz);
    let face = FACE[u32(q.w)];
    let a = fetchA(cell);
    let t = crispT(cell, a.y, q.xyz, face);
    let sf = crispSurf(cell, eid(a), a, q.xyz, vec3f(face));
    io[2u * NP + i] = vec4f(t, sf.T, 0.0, 0.0);
  } else if (i < NP + NA) {
    let j = i - NP;
    io[3u * NP + NA + j] = vec4f(aerationAt(io[3u * NP + j].xyz), 0.0, 0.0);
  } else if (i < NP + NA + NF) {
    let b = 3u * NP + 2u * NA + 4u * (i - NP - NA);   // p, n, rd in, the result out
    let p = io[b].xyz;
    gEye = p + vec3f(0.0, 1.0e4, 0.0);   // far: pixels a hundred metres across
    gPixAng = 1.0;
    var n = io[b + 1u].xyz;
    var col = vec3f(0.0);
    var trans = vec3f(1.0);
    liquidFoam(p, &n, E_WATER, io[b + 2u].xyz, &col, &trans);
    let t1 = trans.x;
    let jc = gJetC;
    liquidUnderSkin(&col, &trans);
    io[b + 3u] = vec4f(t1, jc, trans.x, gJetC);
  }
}`;
      const r = await page.evaluate((j) => window.__harness.run('run', j), {
        label: 'material deltas', code, kind: 'compute', groups, dispatch: [Math.ceil((NP + NA + NF) / 64), 1, 1], budgetMs: BUDGET });
      const msgs = r.messages.filter((m) => m.type !== 'info').map((m) => `${m.type} ${m.line}:${m.col} ${m.text}`).slice(0, 6).join(' | ');
      if (check(`kernel: ${code.split('\n').length} lines, module ${r.moduleMs.toFixed(0)} ms, pipeline ${r.pipelineMs.toFixed(0)} ms`, r.ok && !msgs, r.ok ? msgs : `${r.stage}: ${r.error} ${msgs}`)) {
        const out = f32s(r.outputs['3.2']);
        let worst = 0, surfBad = 0, ownOff = 0;
        const bad = [];
        pts.forEach((pt, i) => {
          const [t, st] = out.subarray(4 * (2 * NP + i), 4 * (2 * NP + i) + 2);
          const e = Math.abs(t - pt.want) / Math.max(1, Math.abs(pt.want));
          worst = Math.max(worst, e);
          if (e > 1e-5 && bad.length < 4) bad.push(`cell ${pt.cell} face ${pt.face} hp ${pt.hp.map((v) => v.toFixed(3))}: ${t} want ${pt.want}`);
          if (st !== t) surfBad++;
          if (Math.abs(pt.own - pt.want) > 1) ownOff++;
        });
        check(`crispT: ${NP} points on four faces of a slab (its edge on the grid's face, steam and a hot cell beside it) == the JS twin within ${worst.toExponential(1)} relative (≤ 1e-5)`, worst <= 1e-5, bad.join('; '));
        check('crispSurf\'s temperature is crispT\'s at every point', surfBad === 0, surfBad ? `${surfBad} points` : '');
        check(`control: the cell's own temperature (the old crispSurf) is off by more than 1 °C at ${ownOff} of ${NP} points`, ownOff > NP / 2);
        let aWorst = 0, oldOff = 0, liquid = 0;
        const abad = [];
        apts.forEach((pt, i) => {
          const got = out.subarray(4 * (3 * NP + NA + i), 4 * (3 * NP + NA + i) + 2);
          const e = Math.max(...pt.want.map((v, k) => Math.abs(got[k] - v)));
          aWorst = Math.max(aWorst, e);
          if (e > 1e-5 && abad.length < 4) abad.push(`p ${pt.p.map((v) => v.toFixed(3))}: ${Array.from(got)} want ${pt.want}`);
          if (pt.want.some((v, k) => Math.abs(v - pt.old[k]) > 1e-3)) oldOff++;
          if (pt.want[0] > 0 || pt.want[1] > 0) liquid++;
        });
        check(`aerationAt: ${NA} points (${liquid} over liquid) from the current copy, liquid records only, == the JS twin within ${aWorst.toExponential(1)} (≤ 1e-5)`, aWorst <= 1e-5 && liquid > NA / 4, abad.join('; '));
        check(`control: taps that take the wakes (the old aerTap) differ at ${oldOff} of ${NA} points`, oldOff > 4);
        let fWorst = 0;
        const fbad = [], kinds = { raft: 0, jet: 0, both: 0, none: 0 };
        fpts.forEach((pt, i) => {
          const got = out.subarray(4 * (3 * NP + 2 * NA + 4 * i + 3), 4 * (3 * NP + 2 * NA + 4 * i + 4));
          const e = Math.max(...pt.want.map((v, k) => Math.abs(got[k] - v)));
          fWorst = Math.max(fWorst, e);
          if (e > 1e-5 && fbad.length < 4) fbad.push(`p ${pt.p.map((v) => v.toFixed(2))} raft ${pt.raft} jet ${pt.jw}: ${Array.from(got).map((v) => v.toFixed(5))} want ${pt.want.map((v) => v.toFixed(5))}`);
          kinds[pt.raft > 0 && pt.jw > 0 ? 'both' : pt.raft > 0 ? 'raft' : pt.jw > 0 ? 'jet' : 'none']++;
        });
        check(`liquidFoam + liquidUnderSkin: ${NF} points (raft and jet ${kinds.both}, raft ${kinds.raft}, jet ${kinds.jet}, neither ${kinds.none}): the raft's cover on top, the jet's body under the skin, == the JS twin within ${fWorst.toExponential(1)} (≤ 1e-5)`,
          fWorst <= 1e-5 && Object.values(kinds).every((v) => v > 0), fbad.join('; '));
      }
      await page.close();
    }

    // ------------------------------------------------------------ combos
    if (ONLY.includes('combos')) {
      const page = await openHarness(browser, vite, '/tools/harness/wgsl.html', { errors });
      const info = await gpuInfo(page);
      const n = surface.DETAIL_COMBINATIONS;
      console.log(`\ncombos: gpu ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}, ${n} detail combinations at 32³, budget ${BUDGET} ms`);
      const names = detailM.DETAIL.map((d) => d.key);
      const label = (bits) => names.filter((_, i) => (bits >> i) & 1).join('+') || 'off';
      const bad = [];
      let tint = 0, lines = [Infinity, 0];
      for (let b = 0; b < n; b += 16) {
        const items = [];
        for (let bits = b; bits < Math.min(b + 16, n); bits++) {
          const code = surface.materialProbe(g, surface.detailCombination(bits));
          const L = code.split('\n').length;
          lines = [Math.min(lines[0], L), Math.max(lines[1], L)];
          items.push({ key: label(bits), code });
        }
        for (const res of await page.evaluate((batch) => window.__harness.run('validate', batch), items)) {
          tint += res.ms;
          const msgs = res.messages.filter((m) => m.type !== 'info');
          if (msgs.length || res.scope) bad.push(`${res.key}: ${msgs.slice(0, 3).map((m) => `${m.type} ${m.line}:${m.col} ${m.text}`).join(' | ') || res.scope}`);
        }
      }
      check(`validate: ${n}/${n} combinations, ${lines[0]}–${lines[1]} lines, no error or warning, Tint ${(tint / 1000).toFixed(1)} s in all`, bad.length === 0, bad.slice(0, 6).join('\n     '));
      // each switch alone, built as check-wgsl (b) builds a probe
      const groups = surface.materialProbeLayouts();
      let total = 0;
      for (const [i, d] of detailM.DETAIL.entries()) {
        const code = surface.materialProbe(g, surface.detailCombination(1 << i));
        const r = await page.evaluate(([it, budget]) => window.__harness.run('build', it, budget), [{
          name: `mat.${d.key}`, kind: 'render', code, groups, vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] },
        }, BUDGET]);
        total += r.ms;
        check(`build ${d.key} alone (${d.define}): ${r.status}, pipeline ${r.ms.toFixed(0)} ms (module ${r.validateMs.toFixed(0)} ms)`, r.status === 'ok', r.message ?? '');
      }
      console.log(`     ${detailM.DETAIL.length} pipelines built, ${(total / 1000).toFixed(1)} s in all`);
      await page.close();
    }
    check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    await vite.close();
  }
}

console.log(failures ? `\nmaterial-lod-check: ${failures} failure(s)` : '\nmaterial-lod-check: clean');
process.exit(failures ? 1 : 0);
