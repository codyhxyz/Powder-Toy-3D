// Post check (docs/webgpu.md U7's acceptance): src/gfx/post.js on its harness
// page (tools/harness/post.html), a synthetic scene target at 400×250, no app.
//
//   passes      a presented frame is the scene pass, 4 render passes and 1
//               compute pass of post's, and the canvas pass: one submit. An E1
//               kernel that reads FrameUniforms, recorded in compute() after
//               prepare()'s write, sees this frame's jitter and pixScale, and the
//               frame stays one submit; recorded before render() (control) the
//               write flushes and the kernel sees the frame before's
//   warm        WGSL_CHECK, built as the start menu's warm-up would (layouts under
//               layoutNames), creates no pipeline createPost hasn't (B5); under
//               other layout names (control) it creates them all
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
//               a half-covered pixel is the composite plus (1 − alpha) × the sky
//   chain       the plane over the sky (TAA, bloom, sharpening): each bloom level
//               (prefilter, down 1–5, up 4–1, up[0]) against the WGSL's taps and
//               weights in JS from the GPU's level before, its energy, and every
//               canvas pixel against the composite in JS (CAS, the bloom term: one
//               bilinear tap of up[0]'s 3×3 tent, AgX, sRGB, the sky behind partial
//               coverage, the dither) from the GPU's resolved frame and up[0]; with
//               stronger settings again, and upscaled (TAAU at 1/1.5)
//   canvas      an empty scene: the opaque canvas presents the sky gradient (alpha
//               255; the capture against this file's gradient and against
//               Playwright's screenshot of the page, and Chrome's own rendering of
//               the page's CSS background with the canvas hidden, reported)
//   still       renderStill into 320×200 rgba8unorm keeps alpha, leaves history alone;
//               resizes within one task (two still sizes, a target, the canvas)
//               submit without a validation error (post flushes before it destroys)
//   three       (the page with ?three=1) post's scene target is three's RenderTarget;
//               three draws a box in front of the plane and one behind it into it
//               after our scene pass (our depth, loadOp load): the front one shows,
//               the hidden one doesn't; ours before three, three's, ours after: 3 submits
//
// usage: node tools/post-check.mjs [--port N] [--only passes,taa,…]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { SKY, ADAPT, POST_DEFAULTS, NV_PHOSPHOR, MIPS } from '../src/gfx/post.js';
import { halfToFloat } from '../src/gpu/readback.js';

const argv = process.argv.slice(2);
// three's TAAU (gfx/post.js, gpu/three.js): a frame's submits with it, ours before it (the scene and the
// motion pass), its resolve and its two copies (the history, the previous depth), ours after…
const TAAU_SUBMITS = 5;
const TAAU_CYCLE = 32;   // …and its jitter's cycle, frames (TAAUNode's 32 Halton offsets)
// frames a still view gets to settle: TAAUNode's current-frame weight (0.025) takes ~3× the
// frames of the old resolve's 0.07
const TAAU_SETTLE_FRAMES = 256;
// The frame after a jump, against the still view's error: three's TAAU samples its history
// bilinearly (the old resolve used Catmull-Rom), so a jump softens the next frame
const MOVED_SOFTER = 1.5;
// The meter reads TAAU's resolve: its half-float history stalls within an f16 step over the
// current-frame weight of the scene's value (2⁻¹¹ / 0.025 ≈ 2e-2 of an ulp's share: under 1e-3)
const METER_TOLERANCE = 1e-3;
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

// ---------------------------------------------------------------- bloom and the whole composite, in JS (post.js's WGSL)

// an rgba16float image the harness sent ({ w, h, bits: base64 of the half bits })
function image({ w, h, bits }) {
  const u8 = new Uint8Array(Buffer.from(bits, 'base64'));
  return { w, h, d: Float64Array.from(new Uint16Array(u8.buffer), halfToFloat) };
}
const texelAt = (t, x, y) => {
  x = clamp(x, 0, t.w - 1); y = clamp(y, 0, t.h - 1);
  const i = 4 * (y * t.w + x);
  return [t.d[i], t.d[i + 1], t.d[i + 2], t.d[i + 3]];
};
// the linear clamp-to-edge sampler at uv (rgb)
function sample(t, u, v) {
  const x = u * t.w - 0.5, y = v * t.h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = texelAt(t, x0, y0), b = texelAt(t, x0 + 1, y0), c = texelAt(t, x0, y0 + 1), d = texelAt(t, x0 + 1, y0 + 1);
  return [0, 1, 2].map((k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy);
}
const addTo = (acc, c, w) => acc.map((x, k) => x + c[k] * w);
const sanitize = (c) => {
  let rgb = c.slice(0, 3).map((x) => Math.max(x, 0));
  const m = Math.max(...rgb);
  if (m > 4096) rgb = rgb.map((x) => x * 4096 / m);
  return [...rgb, Math.min(c[3], 1)];
};
function bright(c, [t, knee]) {
  const br = Math.max(c[0], c[1], c[2]);
  let rq = clamp(br - t + knee, 0, 2 * knee);
  rq = rq * rq / (4 * knee + 1e-4);
  return c.slice(0, 3).map((x) => x * (Math.max(rq, br - t) / Math.max(br, 1e-4)));
}
function tent9(t, u, v) {
  const tx = 1 / t.w, ty = 1 / t.h;
  let acc = [0, 0, 0];
  for (const [ox, oy, w] of [[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1], [0, -1, 2], [-1, 0, 2], [1, 0, 2], [0, 1, 2], [0, 0, 4]]) acc = addTo(acc, sample(t, u + ox * tx, v + oy * ty), w);
  return acc.map((x) => x / 16);
}
const makeImage = (w, h, fn) => {
  const d = new Float64Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...fn(x, y), 1], 4 * (y * w + x));
  return { w, h, d };
};
// the bloom prefilter: 2×2 texels of the resolved frame, each's bright part, averaged
const prefilterRef = (src, w, h, th) => makeImage(w, h, (x, y) => {
  let acc = [0, 0, 0];
  for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) acc = addTo(acc, bright(sanitize(texelAt(src, Math.min(2 * x + ox, src.w - 1), Math.min(2 * y + oy, src.h - 1))), th), 0.25);
  return acc;
});
// Jimenez 2014's 13 taps (DOWN_W_*), bilinear, ±1 and ±2 texels of the finer level
const downRef = (src, w, h) => makeImage(w, h, (x, y) => {
  const u = (x + 0.5) / w, v = (y + 0.5) / h, tap = (ox, oy) => sample(src, u + ox / src.w, v + oy / src.h);
  let c = tap(0, 0).map((z) => z * 0.125);
  for (const [ox, oy] of [[-2, 2], [2, 2], [-2, -2], [2, -2]]) c = addTo(c, tap(ox, oy), 0.03125);
  for (const [ox, oy] of [[0, 2], [-2, 0], [2, 0], [0, -2]]) c = addTo(c, tap(ox, oy), 0.0625);
  for (const [ox, oy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) c = addTo(c, tap(ox, oy), 0.125);
  return c;
});
// up: this level's down mixed toward the tent of the coarser level by the scatter
const upRef = (low, high, scatter) => makeImage(high.w, high.h, (x, y) => {
  const hi = texelAt(high, x, y), lo = tent9(low, (x + 0.5) / high.w, (y + 0.5) / high.h);
  return [0, 1, 2].map((k) => hi[k] + (lo[k] - hi[k]) * scatter);
});
// mean |Δ| / mean |ref| and max |Δ| over the colour channels
function levelError(ref, got) {
  let sum = 0, mag = 0, max = 0;
  for (let i = 0; i < ref.d.length; i += 4) {
    for (let k = 0; k < 3; k++) { const e = Math.abs(ref.d[i + k] - got.d[i + k]); sum += e; mag += Math.abs(ref.d[i + k]); max = Math.max(max, e); }
  }
  return { rel: sum / Math.max(mag, 1e-30), max, mean: mag / (ref.d.length * 0.75) };
}
const fract = (x) => x - Math.floor(x);
// The dither's interleaved gradient noise in f32, as the shader computes it:
// where 52.98·fract(…) lands next to an integer, f64 can wrap to the other side
// of fract (a whole code value away). FMA in the shader may still differ there,
// so the check accepts either side within IGN_WRAP of a wrap.
const IGN_WRAP = 1e-3;
function ign(x, y) {
  const r = Math.fround;
  const a = r(r(r(x) * r(0.06711056)) + r(r(y) * r(0.00583715)));
  return fract(r(r(52.9829189) * r(fract(a))));
}
// the bloom pass: up[0]'s 3×3 tent (1-2-1 ⊗ 1-2-1) on its texel grid, edges clamped; the
// composite takes one bilinear tap of it (the old nine-tap tent9 of up[0], inside the frame)
const tentRef = (src) => makeImage(src.w, src.h, (x, y) => {
  let acc = [0, 0, 0];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) acc = addTo(acc, texelAt(src, x + i, y + j), (2 - Math.abs(i)) * (2 - Math.abs(j)) / 16);
  return acc;
});
// one canvas pixel (0..255, before the 8-bit rounding) from the resolved frame and the bloom image (tentRef of up[0])
function compositeAt(hist, bloom, s, x, y, noise = ign(x, y)) {
  const u = (x + 0.5) / hist.w, v = (y + 0.5) / hist.h;
  const c = sanitize(texelAt(hist, x, y));
  let rad = c.slice(0, 3);
  const sharpen = s.taa && !s.raw ? s.sharpen : 0;
  if (sharpen > 0) {   // CAS: cross taps in c / (1 + luma) space
    const tm = (q) => { const l = 1 + luma(q); return q.slice(0, 3).map((z) => z / l); };
    const e = tm(c), n = tm(sanitize(texelAt(hist, x, y + 1))), so = tm(sanitize(texelAt(hist, x, y - 1)));
    const w = tm(sanitize(texelAt(hist, x - 1, y))), r = tm(sanitize(texelAt(hist, x + 1, y)));
    const ls = [e, n, so, w, r].map(luma);
    const mn = Math.min(...ls), mx = Math.max(...ls);
    const amp = Math.sqrt(clamp(Math.min(mn, 1 - mx) / Math.max(mx, 1e-4), 0, 1));
    const k = -amp / mix(8, 5, sharpen);
    const t = e.map((z, i) => Math.max((z + k * (n[i] + so[i] + w[i] + r[i])) / (1 + 4 * k), 0));
    const lt = Math.max(1 - luma(t), 1e-3);
    rad = t.map((z) => z / lt);
  }
  if (s.bloom > 0 && !s.raw) {
    const b = sample(bloom, u, v), br = bright(c, [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)]);
    rad = rad.map((z, k) => z + s.bloom * (b[k] - br[k]));
  }
  let o = s.raw ? srgb(rad.map((z) => clamp(z, 0, 1))) : srgb(tonemap(rad.map((z) => Math.max(z, 0) * 2 ** s.exposure), s));
  const sk = sky(u, v);
  o = o.map((z, k) => z + (1 - c[3]) * sk[k]);
  if (Math.max(...o) >= 1e-5) o = o.map((z) => z + (noise - 0.5) / 255);
  return o.map((z) => clamp(z, 0, 1) * 255);
}

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
    check(stats.renderPasses === 6 && stats.computePasses === 1 && stats.submits === TAAU_SUBMITS,
      `a presented frame: ${stats.renderPasses} render passes (scene + motion, prefilter, bloom up0, bloom + canvas), ${stats.computePasses} compute pass, ${stats.submits} submit`);
    check(stats.dispatches === 10 && stats.draws === 6, `${stats.dispatches} dispatches (bloom down 5, up 4, reduce 1), ${stats.draws} draws (scene 1 + post 5)`);
    check(stats.bytesAllocated === 0 && stats.pipelinesCreated === 0, `nothing allocated or built per frame (${stats.bytesAllocated} B, ${stats.pipelinesCreated} pipelines)`);
    for (const upscale of [1, 1 / 1.5]) {
      const r = await run('frameUniforms', { route: 'hooks', upscale });
      const [jx, jy, pix, p20] = r.seen;
      const want = [r.jitter[0], r.jitter[1], r.inSize[0] / r.size[0], 2 * r.jitter[0] / r.inSize[0]];   // (three's view offset: +2·jx/w in column 2)
      const same = r.seen.every((x, i) => Math.abs(x - want[i]) < 1e-6);
      check(same && r.stats.submits === TAAU_SUBMITS && r.stats.writeFlushes === 0 && r.jitter.some((j) => j !== 0),
        `E1's FrameUniforms reader in compute() after prepare()'s write (upscale ${r5(upscale)}): it saw this frame's jitter ${[jx, jy].map(r5)} (${r.jitter.map(r5)}), pixScale ${r5(pix)}, the jittered projection [2][0] ${r5(p20)} (${r5(want[3])}); ${r.stats.submits} submit, ${r.stats.writeFlushes} write flushes`);
    }
    const c = await run('frameUniforms', { route: 'before' });
    check(c.stats.writeFlushes === 1 && c.stats.submits === TAAU_SUBMITS + 1 && Math.abs(c.seen[0] - c.jitter[0]) > 1e-3,
      `control, the reader recorded before render(): the write flushes (${c.stats.writeFlushes}), ${c.stats.submits} submits, and it saw the frame before's jitter ${r5(c.seen[0])} (this frame's ${r5(c.jitter[0])})`);
  }

  if (want('warm')) {
    console.log('\nwarm (B5: WGSL_CHECK as the start menu\'s warm-up builds it)');
    const w = await run('warm');
    check(w.ready && w.created === 0, `${w.entries} WGSL_CHECK entries built with their layoutNames: ${w.created} pipelines created (createPost's cache has them all)`);
    const c = await run('warm', { control: true });
    check(c.ready && c.created === c.entries, `control, the same entries under other layout names: ${c.created} of ${c.entries} created`);
  }

  if (want('taa')) {
    console.log('\ntaa (still camera; error: mean |Δ| of c/(1+luma) against the 8×8-supersampled reference)');
    const r = await run('taa', { frames: TAAU_SETTLE_FRAMES, every: TAAU_CYCLE });
    const last = r.curve.at(-1), first = r.curve[1];
    console.log(`     aliased frame ${r5(r.alias.rgb)}; TAA by frame: ${r.curve.map((c) => `${c.k}: ${r5(c.rgb)}${c.delta == null ? '' : ` (Δ${TAAU_CYCLE} ${r5(c.delta)})`}`).join(', ')}`);
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
      check(ok.moved.rgb < MOVED_SOFTER * ok.static.rgb && ctrl.moved.rgb > 1.8 * ok.moved.rgb,
        `${label}: ${r5(ok.moved.rgb)} after (still ${r5(ok.static.rgb)}); unaware of the motion ${r5(ctrl.moved.rgb)}`);
    }
    const pan = await run('motion', { kind: 'pan', moving: 64 });
    const panCtrl = await run('motion', { kind: 'pan', moving: 64, control: true });
    check(pan.moved.rgb < panCtrl.moved.rgb, `a slow pan (0.3 px a frame, 64 frames): ${r5(pan.moved.rgb)}; unaware of the motion ${r5(panCtrl.moved.rgb)} (reported: thin lines crossing pixels blur)`);
  }

  if (want('taau')) {
    console.log('\ntaau (upscale 1/1.5)');
    const r = await run('taa', { upscale: 1 / 1.5, frames: TAAU_SETTLE_FRAMES, every: 2 * TAAU_CYCLE });
    const last = r.curve.at(-1);
    console.log(`     scene ${r.inSize.join('×')} → ${r.size.join('×')}; by frame: ${r.curve.map((c) => `${c.k}: ${r5(c.rgb)}${c.delta == null ? '' : ` (Δ${2 * TAAU_CYCLE} ${r5(c.delta)})`}`).join(', ')}`);
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
    check(m.luma != null && Math.abs(m.luma / f16(L) - 1) < METER_TOLERANCE, `post.sceneLuma of a uniform ${L}: ${m.luma} (its half float ${f16(L)})`);
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
    // half coverage: the composite of the premultiplied colour, plus (1 − alpha) × the sky behind it (F7)
    const half = [0.09, 0.09, 0.09].map(f16);
    const gotHalf = (await run('pixel', { fill: [...half, 0.5] })).values[0];
    const skyAt = sky(200.5 / 400, 125.5 / 250);
    const wantHalf = composite(half).map((x, i) => (clamp(x, 0, 1) + 0.5 * skyAt[i]) * 255);
    check(Math.max(...wantHalf.map((x, i) => Math.abs(x - gotHalf[i]))) <= 1.01 && gotHalf[3] === 255, `half covered, over the sky: ${gotHalf.slice(0, 3)} vs ${wantHalf.map((x) => x.toFixed(1))}`);
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

  if (want('chain')) {
    console.log('\nchain (the plane over the sky: each bloom level from the GPU\'s level before, every canvas pixel from the GPU\'s resolved frame and up[0])');
    const chains = [
      ['defaults (adaptation held at 1)', {}],
      ['bloom 1, sharpen 1, look 0, exposure +1.5', { bloom: 1, sharpen: 1, look: 0, exposure: 1.5 }],
      ['upscaled 1/1.5', { upscale: 1 / 1.5 }],
    ];
    for (const [label, settings] of chains) {
      const r = await run('chain', { settings });
      const s = r.settings;
      const hist = image(r.history), down = r.down.map(image), up = r.up.map(image), bloom = tentRef(up[0]);
      const th = [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)];
      const levels = [['prefilter', prefilterRef(hist, down[0].w, down[0].h, th), down[0]]];
      for (let i = 1; i < MIPS; i++) levels.push([`down ${i}`, downRef(down[i - 1], down[i].w, down[i].h), down[i]]);
      for (let i = MIPS - 2; i >= 0; i--) levels.push([`up ${i}`, upRef(i === MIPS - 2 ? down[MIPS - 1] : up[i + 1], down[i], s.bloomScatter), up[i]]);
      const errs = levels.map(([name, ref, got]) => ({ name, ...levelError(ref, got) }));
      const worst = errs.reduce((a, b) => (b.rel > a.rel ? b : a));
      console.log(`     ${label}: ${errs.map((e) => `${e.name} ${e.rel.toExponential(1)}`).join(', ')} (mean relative error)`);
      check(errs.every((e) => e.rel < 2e-3 && e.max < 2e-3), `${label}: ${levels.length} bloom levels match the taps and weights, worst ${worst.name}: relative ${worst.rel.toExponential(2)}, max |Δ| ${Math.max(...errs.map((e) => e.max)).toExponential(2)} (half floats)`);
      const mean = (t) => { let m = 0; for (let i = 0; i < t.d.length; i += 4) m += t.d[i] + t.d[i + 1] + t.d[i + 2]; return m / (t.d.length / 4); };
      const energy = mean(up[0]) / mean(down[0]);
      check(Math.abs(energy - 1) < 0.03 && mean(down[0]) > 1e-3, `${label}: the chain keeps the bright part's energy: mean up[0] / mean down[0] = ${energy.toFixed(4)}`);
      // every canvas pixel
      const px = new Uint8Array(Buffer.from(r.canvas.rgba, 'base64'));
      let max = 0, sum = 0, at = null, partial = 0, sharpened = 0, bloomed = 0;
      for (let y = 0; y < r.canvas.h; y++) {
        for (let x = 0; x < r.canvas.w; x++) {
          const i = 4 * (y * r.canvas.w + x), noise = ign(x, y);
          const ref = compositeAt(hist, bloom, s, x, y, noise);
          // (next to a wrap of the noise: the other side's value too)
          const alt = Math.min(noise, 1 - noise) < IGN_WRAP ? compositeAt(hist, bloom, s, x, y, noise < 0.5 ? noise + 1 : noise - 1) : ref;
          const a = texelAt(hist, x, y)[3];
          if (a > 0.02 && a < 0.98) partial++;
          for (let k = 0; k < 3; k++) {
            const d = Math.min(Math.abs(px[i + k] - ref[k]), Math.abs(px[i + k] - alt[k]));
            sum += d;
            if (d > max) { max = d; at = [x, y, k, px[i + k], ref[k].toFixed(2)]; }
          }
        }
      }
      // how much the CAS and bloom terms move pixels (the check is only as strong as they are), every 5th pixel
      for (let k = 0; k < (r.canvas.w / 5) * (r.canvas.h / 5); k++) {
        const x = 5 * (k % (r.canvas.w / 5)), y = 5 * Math.floor(k / (r.canvas.w / 5));
        const base = compositeAt(hist, bloom, { ...s, sharpen: 0, bloom: 0 }, x, y), withCas = compositeAt(hist, bloom, { ...s, bloom: 0 }, x, y), all = compositeAt(hist, bloom, s, x, y);
        sharpened = Math.max(sharpened, ...withCas.map((z, k) => Math.abs(z - base[k])));
        bloomed = Math.max(bloomed, ...all.map((z, k) => Math.abs(z - withCas[k])));
      }
      const n = r.canvas.w * r.canvas.h * 3;
      check(max <= 0.75 && sharpened > 2 && bloomed > 1 && partial > 100,
        `${label}: every canvas pixel against the composite in JS: max |Δ| ${max.toFixed(2)} at ${JSON.stringify(at)}, mean ${(sum / n).toFixed(3)} (8-bit rounding: ≤ ½); ${partial} partly covered pixels; CAS moves values by up to ${sharpened.toFixed(1)}, the bloom term by ${bloomed.toFixed(1)} (every 5th pixel)`);
    }
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
  }

  if (want('still')) {
    console.log('\nstill (thumbnail)');
    const r = await run('still');
    check(r.covered > 0 && r.clear > 0 && r.colourInClear === 0, `renderStill 320×200: ${r.covered} covered, ${r.clear} clear (alpha 0, no sky, no colour), ${r.partial} partial`);
    check(r.historyKept, 'TAA history untouched');
    check(r.stats.renderPasses === 2 && r.stats.computePasses === 0, `${r.stats.renderPasses} render passes (scene, composite), ${r.stats.computePasses} compute`);
    const z = await run('resize');
    check(z.failure === null && z.covered > 0 && z.size.join() === '400,250',
      `two stills (320×200, 160×100), a frame into 200×120 and one into the canvas in one task: ${z.submits} submits, GPU failure ${z.failure}; the second still covers ${z.covered} of ${z.pixels} pixels`);
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
    check(r.stats.submits === 3 && r.taaStats.submits === 3 + TAAU_SUBMITS - 1, `ours before three, three's own, ours after: ${r.stats.submits} submits (TAA, bloom, adaptation on: ${r.taaStats.submits}, ${r.taaStats.renderPasses} render passes of ours)`);
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
