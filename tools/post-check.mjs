// Post check (docs/webgpu.md U7's acceptance): src/gfx/post.js on its harness
// page (tools/harness/post.html), a synthetic scene target at 400×250, no app.
//
//   passes      a presented frame is the scene pass, 3 render passes and 1
//               compute pass of post's, and the canvas pass: one submit
//   taa         a still camera: TAA converges (the change over a jitter cycle
//               falls to the noise floor) to an image nearer the 8×8-supersampled
//               reference than the aliased frame; with the jitter left out or
//               mirrored (negative controls) it converges farther from it
//   motion      a 3-pixel camera jump and a dolly, one frame each: the frame after
//               is as near its reference as a still one (reprojection follows,
//               y down, depth 0..1, F4); with post unaware of the motion (control)
//               it isn't. Then a slow pan, reported
//   taau        TAAU at 1/1.5 converges
//   adaptation  a dark uniform scene: the state read back equals the histogram's
//               bin centre, the target and the gain's time course computed here;
//               post.adaptation lands; a bright scene keeps gain 1
//   meter       post.sceneLuma of a uniform scene is its radiance; an uncovered one null
//   composite   canvas pixels of uniform scenes against a JS port of the GLSL
//               composite (AgX, Punchy, hot roll-off, sRGB, raw), within the dither;
//               night vision; the viewmodel composite; the glow layer
//   canvas      an empty scene: the opaque canvas presents the sky gradient (alpha
//               255; the capture against this file's gradient and against
//               Playwright's screenshot of the page, and Chrome's own rendering of
//               the page's CSS background with the canvas hidden, reported)
//   still       renderStill into 320×200 rgba8unorm keeps alpha, leaves history alone
//   three       (the page with ?three=1) post's scene target is three's RenderTarget;
//               three draws a box in front of the plane and one behind it into it
//               after our scene pass (our depth, loadOp load): the front one shows,
//               the hidden one doesn't; ours before three, three's, ours after: 3 submits
//
// usage: node tools/post-check.mjs [--port N] [--only passes,taa,…]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { SKY, ADAPT, POST_DEFAULTS, NV_PHOSPHOR } from '../src/gfx/post.js';

const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
let failures = 0;
const check = (ok, line) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`); };
const r5 = (x) => (x == null ? x : Number(x.toPrecision(4)));

// ---------------------------------------------------------------- the composite, in JS (post.js COMPOSITE's GLSL as it was)

const mat3 = (c0, c1, c2) => (v) => [0, 1, 2].map((i) => c0[i] * v[0] + c1[i] * v[1] + c2[i] * v[2]);
const SRGB_TO_REC2020 = mat3([0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]);
const REC2020_TO_SRGB = mat3([1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]);
const AGX_INSET = mat3([0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]);
const AGX_OUTSET = mat3([1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const contrast = (x) => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };
function agxCurve(c, look) {
  const e = c.map((x) => contrast(clamp((Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393), 0, 1)));
  const p = e.map((x) => Math.max(x, 0) ** mix(1, 1.35, look));
  const l = luma(p);
  return p.map((x) => l + mix(1, 1.4, look) * (x - l));
}
const agx = (c, look) => REC2020_TO_SRGB(AGX_OUTSET(agxCurve(AGX_INSET(SRGB_TO_REC2020(c)), look)).map((x) => Math.max(x, 0) ** 2.2)).map((x) => clamp(x, 0, 1));
function tonemap(c, s) {
  const a = agx(c, s.look);
  const mx = Math.max(...c);
  const sat = 1 - Math.min(...c) / Math.max(mx, 1e-6);
  const warm = smoothstep(-0.2, 0.2, (c[0] - c[2]) / Math.max(mx, 1e-6));
  const w = smoothstep(s.hotStart, s.hotFull, mx) * sat ** 2 * warm;
  if (w <= 0) return a;
  const pc = REC2020_TO_SRGB(agxCurve(SRGB_TO_REC2020(c), s.look).map((x) => Math.max(x, 0) ** 2.2)).map((x) => clamp(x, 0, 1));
  return a.map((x, i) => mix(x, pc[i], w));
}
const srgb = (c) => c.map((x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055));
// the canvas value of a uniform opaque scene of radiance c (TAA off: no sharpening; no bloom; gain 1)
function composite(c, settings = {}) {
  const s = { ...POST_DEFAULTS, ...settings };
  if (s.raw) return srgb(c.map((x) => clamp(x, 0, 1)));
  return srgb(tonemap(c.map((x) => Math.max(x, 0) * 2 ** s.exposure), s));
}
// the page's sky at uv (SKY, ui/styles.css), sRGB-encoded
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function sky(u, v) {
  const [top, mid, low] = [hex(SKY.top), hex(SKY.mid), hex(SKY.low)];
  let c = top.map((x, i) => mix(x, mid[i], clamp(v / SKY.MID_AT, 0, 1)));
  if (v > SKY.MID_AT) c = mid.map((x, i) => mix(x, low[i], clamp((v - SKY.MID_AT) / (1 - SKY.MID_AT), 0, 1)));
  const t = Math.hypot((u - SKY.GLOW_CENTRE[0]) / SKY.GLOW_RADII[0], (v - SKY.GLOW_CENTRE[1]) / SKY.GLOW_RADII[1]) / SKY.GLOW_END;
  const a = SKY.glow[3] * clamp(1 - t, 0, 1);
  return c.map((x, i) => mix(x, SKY.glow[i] / 255, a));
}
// float32 and half-float rounding (the scene target is rgba16float)
const f16 = (x) => { const e = Math.floor(Math.log2(Math.abs(x))); const q = 2 ** (e - 10); return Math.round(x / q) * q; };

// ---------------------------------------------------------------- run

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
const errors = [];
const t0 = Date.now();
try {
  const page = await openHarness(browser, vite, '/tools/harness/post.html', { errors, viewport: { width: 400, height: 250 } });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; timestamp-query ${info.features.includes('timestamp-query') ? 'yes' : 'no'}`);
  const run = (name, arg) => page.evaluate(([n, a]) => window.__harness.run(n, a), [name, arg]);
  const want = (s) => !ONLY || ONLY.includes(s);

  if (want('passes')) {
    console.log('\npasses');
    const { stats } = await run('budget:frame');
    check(stats.renderPasses === 5 && stats.computePasses === 1 && stats.submits === 1,
      `a presented frame: ${stats.renderPasses} render passes (scene + taa, prefilter, bloom up0 + canvas), ${stats.computePasses} compute pass, ${stats.submits} submit`);
    check(stats.dispatches === 10 && stats.draws === 5, `${stats.dispatches} dispatches (bloom down 5, up 4, reduce 1), ${stats.draws} draws (scene 1 + post 4)`);
    check(stats.bytesAllocated === 0 && stats.pipelinesCreated === 0, `nothing allocated or built per frame (${stats.bytesAllocated} B, ${stats.pipelinesCreated} pipelines)`);
  }

  if (want('taa')) {
    console.log('\ntaa (still camera; error: mean |Δ| of c/(1+luma) against the 8×8-supersampled reference)');
    const r = await run('taa', { frames: 128, every: 16 });
    const last = r.curve.at(-1), first = r.curve[1];
    console.log(`     aliased frame ${r5(r.alias.rgb)}; TAA by frame: ${r.curve.map((c) => `${c.k}: ${r5(c.rgb)}${c.delta == null ? '' : ` (Δ16 ${r5(c.delta)})`}`).join(', ')}`);
    check(last.rgb < 0.8 * r.alias.rgb, `TAA converges nearer the reference than the aliased frame: ${r5(last.rgb)} < 0.8 × ${r5(r.alias.rgb)} (alpha ${r5(last.alpha)} vs ${r5(r.alias.alpha)})`);
    check(last.delta < 3e-4 && last.delta < first.delta / 4, `and settles: the change over a jitter cycle falls from ${r5(first.delta)} to ${r5(last.delta)}`);
    const none = (await run('taa', { frames: 96, jitterSign: 0 })).curve.at(-1);
    const flip = (await run('taa', { frames: 96, jitterSign: -1 })).curve.at(-1);
    check(none.rgb > 1.15 * last.rgb && flip.rgb > 1.15 * last.rgb,
      `negative controls converge farther: scene unjittered ${r5(none.rgb)}, jitter mirrored ${r5(flip.rgb)}, vs ${r5(last.rgb)} (the jitter's sign and size match the resolve's, F4)`);
  }

  if (want('motion')) {
    console.log('\nmotion (64 still frames, then the camera moves; error of the frame after, against the reference at the new camera)');
    for (const [label, arg] of [['3 px diagonal jump', { kind: 'pan', moving: 1, step: 0.06, axes: [1, 0.7] }], ['dolly jump (2.4% closer)', { kind: 'dolly', moving: 1, step: 0.1 }]]) {
      const ok = await run('motion', arg);
      const ctrl = await run('motion', { ...arg, control: true });
      check(ok.moved.rgb < 1.25 * ok.static.rgb && ctrl.moved.rgb > 1.8 * ok.moved.rgb,
        `${label}: ${r5(ok.moved.rgb)} after (still ${r5(ok.static.rgb)}); unaware of the motion ${r5(ctrl.moved.rgb)}`);
    }
    const pan = await run('motion', { kind: 'pan', moving: 64 });
    const panCtrl = await run('motion', { kind: 'pan', moving: 64, control: true });
    check(pan.moved.rgb < panCtrl.moved.rgb, `a slow pan (0.3 px a frame, 64 frames): ${r5(pan.moved.rgb)}; unaware of the motion ${r5(panCtrl.moved.rgb)} (reported: thin lines crossing pixels blur)`);
  }

  if (want('taau')) {
    console.log('\ntaau (upscale 1/1.5)');
    const r = await run('taa', { upscale: 1 / 1.5, frames: 192, every: 48 });
    const last = r.curve.at(-1);
    console.log(`     scene ${r.inSize.join('×')} → ${r.size.join('×')}; by frame: ${r.curve.map((c) => `${c.k}: ${r5(c.rgb)}${c.delta == null ? '' : ` (Δ48 ${r5(c.delta)})`}`).join(', ')}`);
    check(last.delta < 5e-4 && r.inSize[0] === 267 && r.inSize[1] === 167, `TAAU settles from ${r.inSize.join('×')} samples: change over a cycle ${r5(last.delta)}; error ${r5(last.rgb)} (native aliased ${r5(r.alias.rgb)})`);
  }

  if (want('adaptation')) {
    console.log('\nadaptation');
    const L = 2 ** -8.3, frames = 30, dt = 1 / 60;
    const r = await run('adapt', { L, frames, dt });
    // the expected: every sample in one bin (the scene target is f16), the view its centre
    const lg = Math.log2(f16(L));
    const bin = Math.floor((lg - ADAPT.LOG_MIN) / (ADAPT.LOG_MAX - ADAPT.LOG_MIN) * ADAPT.BINS);
    const view = ADAPT.LOG_MIN + (bin + 0.5) / ADAPT.BINS * (ADAPT.LOG_MAX - ADAPT.LOG_MIN);
    const target = 2 ** Math.min(Math.max(ADAPT.LOG_DARK - view, 0), ADAPT.MAX_EV);
    let g = 1;
    for (let k = 0; k < frames; k++) {
      g += (target - g) * (1 - Math.exp(-dt / (target > g ? ADAPT.TAU_DARK : ADAPT.TAU_LIGHT)));
      if (Math.abs(g - target) <= ADAPT.SETTLED * target) g = target;
    }
    const [sg, st, sv] = r.state;
    check(Math.abs(sv - view) < 1e-5 && Math.abs(st / target - 1) < 1e-5, `a uniform scene of 2^-8.3: view ${r5(sv)} (bin ${bin}'s centre ${view}), target gain ${r5(st)} (${r5(target)})`);
    check(Math.abs(sg / g - 1) < 1e-4, `after ${frames} frames of ${r5(dt)} s the gain is ${r5(sg)} (the time course here: ${r5(g)})`);
    check(r.seen && Math.abs(r.seen.target / target - 1) < 1e-5 && r.seen.gain >= 1 && r.seen.gain <= sg && r.adapting,
      `post.adaptation read back: ${JSON.stringify(r.seen && { gain: r5(r.seen.gain), target: r5(r.seen.target) })}, adapting ${r.adapting}`);
    const b = await run('adapt', { L: 0.5, frames: 10, dt });
    check(b.state[0] === 1 && b.state[1] === 1 && b.adapting === false, `a bright scene (0.5) keeps gain ${b.state[0]}, target ${b.state[1]}, not adapting`);
  }

  if (want('meter')) {
    console.log('\nmeter');
    const L = 0.04;
    const m = await run('meter', { L });
    check(m.luma != null && Math.abs(m.luma / f16(L) - 1) < 1e-4, `post.sceneLuma of a uniform ${L}: ${m.luma} (its half float ${f16(L)})`);
    const u = await run('meter', { L, a: 0.3 });
    check(u.luma === null, `under the coverage threshold: ${u.luma}`);
  }

  if (want('composite')) {
    console.log('\ncomposite (canvas pixels against the GLSL composite ported to JS here; the dither moves a value by up to 1)');
    const cases = [
      ['grey 0.18', [0.18, 0.18, 0.18]], ['white 1', [1, 1, 1]], ['dim blue', [0.02, 0.05, 0.3]],
      ['hot orange (roll-off)', [8, 2, 0.3]], ['bright violet', [3, 0.5, 6]], ['raw', [0.25, 0.5, 0.75], { raw: true }],
      ['look 0 (AgX base)', [0.6, 0.3, 0.1], { look: 0 }], ['exposure -1 EV', [0.4, 0.4, 0.4], { exposure: -1 }],
    ];
    for (const [label, c, settings = {}] of cases) {
      const cf = c.map(f16);
      const want = composite(cf, settings).map((x) => clamp(x, 0, 1) * 255);
      const { values: [got] } = await run('pixel', { fill: [...c, 1], settings });
      const err = Math.max(...want.map((x, i) => Math.abs(x - got[i])));
      check(err <= 1.01 && got[3] === 255, `${label}: ${got.slice(0, 3)} vs ${want.map((x) => x.toFixed(1))}`);
    }
    const black = (await run('pixel', { fill: [0, 0, 0, 1] })).values[0];
    check(black.slice(0, 3).every((x) => x === 0), `black stays exactly black (no dither): ${black.slice(0, 3)}`);
    const nv = (await run('pixel', { fill: [0.05, 0.05, 0.05, 1], settings: { night: 1, nightGain: 8 }, points: [[200, 125], [40, 30]] })).values;
    check(nv.every((p) => p[1] > p[0] && p[1] > p[2]) && nv[0][1] > nv[1][1], `night vision: green phosphor ${nv[0].slice(0, 3)}, vignetted toward the corner ${nv[1].slice(0, 3)}`);
    // the viewmodel: straight colour → the tone map at the exposure (no gain) → sRGB, premultiplied over
    const vm = [0.25, 0.125, 0.0625, 0.5];
    const under = composite([0.18, 0.18, 0.18].map(f16)).map((x) => x * 255);
    const tool = composite(vm.slice(0, 3).map((x) => x / vm[3])).map((x) => x * 255);
    const wantVm = tool.map((x, i) => x * vm[3] + under[i] * (1 - vm[3]));
    const gotVm = (await run('pixel', { fill: [0.18, 0.18, 0.18, 1], viewmodel: vm })).values[0];
    check(Math.max(...wantVm.map((x, i) => Math.abs(x - gotVm[i]))) <= 1.01, `viewmodel over the frame: ${gotVm.slice(0, 3)} vs ${wantVm.map((x) => x.toFixed(1))}`);
    const glow = [0.1, 0.2, 0.3].map(f16);
    const gotGlow = (await run('pixel', { fill: [0, 0, 0, 1], glow: [...glow, 0] })).values[0];
    check(Math.max(...glow.map((x, i) => Math.abs(x * 255 - gotGlow[i]))) <= 0.51, `glow added over black: ${gotGlow.slice(0, 3)} (${glow.map((x) => (x * 255).toFixed(1))})`);
  }

  if (want('canvas')) {
    console.log('\ncanvas (an empty scene: all sky)');
    const cap = await run('canvas', { mode: 'none' });
    check(cap.alphaMode === 'opaque', `the canvas is configured opaque (${cap.format}, alphaMode ${cap.alphaMode})`);
    const px = Buffer.from(cap.rgba, 'base64');
    let max = 0, sum = 0, alphaOk = true, at = null;
    for (let y = 0; y < cap.height; y++) {
      for (let x = 0; x < cap.width; x++) {
        const i = 4 * (y * cap.width + x);
        const s = sky((x + 0.5) / cap.width, (y + 0.5) / cap.height);
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(px[i + k] - s[k] * 255);
          sum += d;
          if (d > max) { max = d; at = [x, y]; }
        }
        if (px[i + 3] !== 255) alphaOk = false;
      }
    }
    check(max <= 1.01 && alphaOk, `the capture (the presenter's screenshot path) is the sky gradient: max |Δ| ${max.toFixed(2)} at ${at}, mean ${(sum / (cap.width * cap.height * 3)).toFixed(3)} code values; alpha 255 everywhere ${alphaOk}`);
    const shot = (await page.screenshot()).toString('base64');
    const seen = await run('compare', { png: shot, rgba: cap.rgba });
    check(seen.max <= 1, `what the page shows (Playwright's screenshot) is the capture: max |Δ| ${seen.max}, mean ${seen.mean?.toFixed(3)}`);
    await run('canvasVisible', false);
    const css = (await page.screenshot()).toString('base64');
    await run('canvasVisible', true);
    const cssDiff = await run('compare', { png: css, rgba: cap.rgba });
    check(cssDiff.mean <= 1.5, `Chrome's own rendering of the page's CSS background (canvas hidden) against the canvas: max |Δ| ${cssDiff.max} at ${JSON.stringify(cssDiff.at)}, mean ${cssDiff.mean?.toFixed(3)} (reported; the gradients' dithering differs)`);
    const scene = await run('canvas', { mode: 'plane' });
    check(scene.rgba.length > 0, 'the plane over the sky (TAA, bloom, adaptation on) presents');
  }

  if (want('still')) {
    console.log('\nstill (thumbnail)');
    const r = await run('still');
    check(r.covered > 0 && r.clear > 0 && r.colourInClear === 0, `renderStill 320×200: ${r.covered} covered, ${r.clear} clear (alpha 0, no sky, no colour), ${r.partial} partial`);
    check(r.historyKept, 'TAA history untouched');
    check(r.stats.renderPasses === 2 && r.stats.computePasses === 0, `${r.stats.renderPasses} render passes (scene, composite), ${r.stats.computePasses} compute`);
  }

  const failed = await page.evaluate(() => window.__harness.failures);
  check(!failed.length && !errors.length, `no GPU failures or page errors${failed.length || errors.length ? `: ${[...failed, ...errors].join(' | ')}` : ''}`);
  await page.close();

  if (want('three')) {
    console.log('\nthree (the page with ?three=1: three\'s RenderTarget as the scene target)');
    const errs = [];
    const p3 = await openHarness(browser, vite, '/tools/harness/post.html?three=1', { errors: errs, viewport: { width: 400, height: 250 } });
    const r = await p3.evaluate(() => window.__harness.run('meshes'));
    check(r.rtIsThree && r.visible, `post.sceneTarget.rt is three's RenderTarget (${r.rtIsThree}); threeHasVisible ${r.visible}`);
    const [frontWithout, behindWithout] = r.without, [front, behind] = r.with;
    check(front[0] > 200 && front[0] > 2 * front[1] && front[0] > 2 * front[2], `the box in front of the plane shows: ${front.slice(0, 3)} (the plane there: ${frontWithout.slice(0, 3)})`);
    check(behind.slice(0, 3).join() === behindWithout.slice(0, 3).join(), `the box behind it doesn't: ${behind.slice(0, 3)} (the plane: ${behindWithout.slice(0, 3)})`);
    check(r.stats.submits === 3 && r.taaStats.submits === 3, `ours before three, three's own, ours after: ${r.stats.submits} submits (TAA, bloom, adaptation on: ${r.taaStats.submits}, ${r.taaStats.renderPasses} render passes of ours)`);
    check(r.taa[0][0] > 200, `with TAA the box still shows: ${r.taa[0].slice(0, 3)}`);
    const f3 = await p3.evaluate(() => window.__harness.failures);
    check(!f3.length && !errs.length, `no GPU failures or page errors${f3.length || errs.length ? `: ${[...f3, ...errs].join(' | ')}` : ''}`);
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\npost-check: ${failures ? `${failures} failed` : 'all passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failures ? 1 : 0);
