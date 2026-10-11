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
//            no derivatives, take fwidth analytically from the pixel's
//            footprint (surface.js floorFwidth): in a fragment shader whose
//            every pixel sees the floor, against fwidth() itself (uniform
//            control flow) for cameras at several elevations and headings,
//            and surfView's pixel angle (dpdx/dpdy of the ray) against the
//            camera's
//   combos   every combination of the nine close-up detail switches
//            (gfx/detail.js, 2^9 = 512 module texts of the realistic probe)
//            validates with Tint as check-wgsl (a) does (no error, no
//            warning), and each switch alone builds within
//            PIPELINE_BUDGET_MS as check-wgsl (b) does, with its time
// check-wgsl itself lists the off, balanced and full levels and the plain
// view (surface.js materialChecks); the 512 here would add about a minute of
// SwiftShader to every check-wgsl run if they were built there.
// It serves the harness pages from its own Vite (tools/vite-server.mjs: --port N,
// else a free port) and launches Chromium through tools/browser.mjs.
//   node tools/material-lod-check.mjs [--only leaf,values,floor,combos] [--port N] [--budget ms]
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => import(pathToFileURL(join(ROOT, 'src', p)));
const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const ONLY = opt('--only')?.split(',') ?? ['leaf', 'values', 'floor', 'combos'];

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
if (['values', 'floor', 'combos'].some((k) => ONLY.includes(k))) {
  const { launchBrowser, gpuInfo } = await import('./browser.mjs');
  const { startVite } = await import('./vite-server.mjs');
  const { openHarness } = await import('./harness/open.mjs');
  const [common, bindings, kernels, detailM, elementsM, materialsM, scaleM] = await Promise.all([
    src('shaders/common.js'), src('shaders/bindings.js'), src('gpu/kernels.js'), src('gfx/detail.js'),
    src('elements.js'), src('gfx/materials.js'), src('scale.js')]);
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
      console.log('\nfloor: the grid lines\' analytic fwidth against fwidth(), 4×4 pixels per camera');
      // pinhole cameras without roll: eye height, elevation of the view
      // (degrees below the horizon), heading (degrees about y), pixel angle
      const cams = [];
      for (const el of [8, 20, 45, 70, 89]) for (const hd of [0, 37, 90, 211]) cams.push({ el, hd, h: 40, pix: 1e-3 });
      cams.push({ el: 30, hd: 15, h: 300, pix: 2e-4 }, { el: 60, hd: 300, h: 5, pix: 4e-3 });
      const frame = new ArrayBuffer(bindings.FrameUniforms.size);
      bindings.FrameUniforms.write(new DataView(frame), 0, { pixScale: 1, sun: [0.4, 0.8, 0.45] });
      const header = new ArrayBuffer(common.Header.size);
      common.Header.write(new DataView(header), 0, { origin: [0, 0, 0], src: 0, dst: 0 });
      const layouts = surface.materialProbeLayouts().map((e) => [...e]);
      layouts[3] = [...layouts[3], { binding: 2, visibility: common.STAGE.FRAGMENT, buffer: { type: 'storage' } }];
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
  let px = frag.position.xy - 2.0;   // from the 4×4 target's centre, y down
  let rd = normalize(fwd + (px.x * right - px.y * up) * pix);
  surfView(eye, rd);
  let hp = eye + rd * (-eye.y / rd.y);
  let fw = fwidth(worldPos(hp).xz);   // (uniform control flow: nothing has branched)
  let i = u32(frag.position.x) + 4u * u32(frag.position.y);
  io[2u + i] = vec4f(fw, floorFwidth(hp, rd));
  io[18u + i] = vec4f(gPixAng, footprint(hp), footprint(hp) / max(abs(rd.y), 1e-3), 0.0);
  return vec4f(0.0);
}`;
      const fill = {
        '0.0': { data: b64(new Uint8Array(common.tablesBuffer())) }, '0.1': { data: b64(new Uint8Array(frame)) },
        '3.0': { data: b64(new Uint8Array(header)) }, '3.1': { size: 256 }, '2.15': { samp: { address: 'repeat' } },
      };
      let worstFw = 0, worstAng = 0, worstNaive = 0, ran = 0;
      const bad = [];
      for (const c of cams) {
        const el = (c.el * Math.PI) / 180, hd = (c.hd * Math.PI) / 180;
        const fwdv = [Math.cos(el) * Math.sin(hd), -Math.sin(el), Math.cos(el) * Math.cos(hd)];
        const io = new Float32Array(34 * 4);
        io.set([7.3, c.h, -11.9, c.pix, ...fwdv, 0]);
        const groups = layouts.map((entries, gi) => entries.map((e) => ({ ...e,
          ...(gi === 3 && e.binding === 2 ? { data: b64(new Uint8Array(io.buffer)), read: true } : fill[`${gi}.${e.binding}`] ?? {}) })));
        const r = await page.evaluate((j) => window.__harness.run('run', j), { label: `floor ${c.el}/${c.hd}`, code, kind: 'render', groups, budgetMs: BUDGET });
        if (!r.ok) { bad.push(`camera ${c.el}°/${c.hd}°: ${r.stage}: ${r.error}`); continue; }
        ran++;
        const out = f32s(r.outputs['3.2']);
        for (let i = 0; i < 16; i++) {
          const [fx, fz, ax, az] = out.subarray(4 * (2 + i), 4 * (3 + i));
          const [ang, , naive] = out.subarray(4 * (18 + i), 4 * (19 + i));
          const e = Math.max(Math.abs(ax / fx - 1), Math.abs(az / fz - 1));
          worstNaive = Math.max(worstNaive, Math.abs(naive / fx - 1), Math.abs(naive / fz - 1));
          worstFw = Math.max(worstFw, e);
          worstAng = Math.max(worstAng, Math.abs(ang / c.pix - 1));
          if (!(e <= 0.12) && bad.length < 6) bad.push(`camera ${c.el}°/${c.hd}° pixel ${i}: fwidth (${fx.toPrecision(4)}, ${fz.toPrecision(4)}) analytic (${ax.toPrecision(4)}, ${az.toPrecision(4)})`);
        }
      }
      // fwidth is a difference between neighbouring pixels (exact to first
      // order); the analytic form takes one pixel angle for both screen axes
      // (the larger, as surfView does), so off-centre pixels and grazing
      // views differ by a few percent
      check(`${ran}/${cams.length} cameras (elevation 8-89°, four headings, eye 5-300 cells up): analytic/fwidth within ${(worstFw * 100).toFixed(1)}% (≤ 12%), surfView's pixel angle within ${(worstAng * 100).toFixed(2)}% of the camera's`,
        ran === cams.length && worstFw <= 0.12 && worstAng <= 0.01, bad.join('; '));
      // control: the footprint stretched by 1/|rd.y| on both axes (no heading)
      // is off by several times across the view, so the check can tell
      check(`control: an isotropic footprint/|rd.y| is off by up to ${(worstNaive * 100).toFixed(0)}% (the check sees it: > 50%)`, worstNaive > 0.5);
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
