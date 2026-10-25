// The cost view (docs/profiler.md "Cost view"): per-pixel work counters for
// the lit volume, read back exactly. __app.prof.cost:
//
//   kinds                       the counters (shaders/costView.js COST_COUNTERS)
//   capture({ kind? })          one frame's counts: { counters: { key: { mean, p50, p95, max, sum } }, image, … }
//   show(on?, { kind? })        the false-colour overlay with its legend (F9 toggles it)
//
// What a capture does. The live loop draws a frame; gfx/volume.js keeps that
// draw's options and pipeline (volume.lastDraw). Then, on the frame state the
// loop left (FrameUniforms: the same camera, jitter, frame number and sun; the
// same mesh depth, shadow map and GI), it draws, into targets of its own at the
// scene target's size:
//   1. that same live pipeline, colour only;
//   2. its counted twin (shaders/costView.js costify of the pipeline's own WGSL
//      text), colour and counters.
// The two colours are compared texel by texel. Only if they match is the
// result trusted; otherwise it says how they differ, and the counts are marked
// as not describing the real frame. Nothing here is timed: the counted
// variant's speed is not the real shader's, so the result carries counts of
// work (unit 'work') and no durations. Neither draw is TAA-resolved,
// tone-mapped or sRGB-encoded: the counters are integers in integer targets,
// and the colour compared is the volume's raw premultiplied output.
// Stats cover only the pixels the volume covered (the box was hit and the
// trace ran; misses inside the box count, the rays cost work), at the scene
// target's real size, not the canvas's.

import { costify, costPipeline, COST_COUNTERS, COST_KINDS, COST_COVERED_BIT, COST_MAX, COST_MARCH_MAX } from '../shaders/costView.js';
import { halfToFloat } from '../gpu/readback.js';
import { isMaterialView } from '../views.js';

// GPUTextureUsage bits (no GPU globals at import: tools/check-imports.mjs)
const USAGE = { COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x10 };
// The two pictures are the same when no more than this share of the covered
// pixels differ by more than SAME_TOL in any channel (linear, premultiplied).
// The code is identical but for counter increments, so they should match
// exactly; the tolerance only absorbs a compiler ordering floating-point
// operations differently in the larger module (fused multiply-adds).
const SAME_TOL = 1 / 1024;
const SAME_SHARE = 1e-4;
// the heatmap's scale: this percentile of the covered pixels' counts (so a few hot pixels don't wash it out)
const SCALE_PERCENTILE = 0.99;
// a new live frame to measure: polled per animation frame, given up after this long
const FRAME_WAIT_MS = 3000;
// the overlay's heatmap opacity over the game
const OVERLAY_ALPHA = 0.85;
const TOGGLE_KEY = 'F9';

// inferno (matplotlib's, CC0), 9 stops: dark = little work, bright = a lot
const INFERNO = [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]];
function inferno(x) {
  const t = Math.min(1, Math.max(0, x)) * (INFERNO.length - 1), i = Math.min(INFERNO.length - 2, Math.floor(t)), f = t - i;
  return INFERNO[i].map((a, c) => Math.round(a + (INFERNO[i + 1][c] - a) * f));
}
const LUT = Array.from({ length: 256 }, (_, i) => inferno(i / 255));

// the 12 counts of every pixel from the two integer targets (shaders/costView.js costWrite)
function decode(c0, c1, n) {
  const vals = COST_KINDS.map(() => new Uint16Array(n)), covered = new Uint8Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) {
    const w = [c0[4 * p], c0[4 * p + 1], c0[4 * p + 2], c0[4 * p + 3], c1[2 * p], c1[2 * p + 1]];
    if (!(w[0] & COST_COVERED_BIT)) continue;
    covered[p] = 1; count++;
    for (let s = 0; s < COST_KINDS.length; s++) {
      const word = w[s >> 1];
      vals[s][p] = s & 1 ? word >>> 16 : word & (s === 0 ? COST_MARCH_MAX : COST_MAX);
    }
  }
  return { vals, covered, count };
}

// mean, p50, p95, max, sum over the covered pixels, from a histogram (counts are 16-bit)
function stats(v, covered, count, cap) {
  const hist = new Uint32Array(COST_MAX + 1);
  let sum = 0, max = 0, saturated = 0;
  for (let p = 0; p < v.length; p++) {
    if (!covered[p]) continue;
    const x = v[p];
    hist[x]++; sum += x;
    if (x > max) max = x;
    if (x >= cap) saturated++;
  }
  const pct = (q) => {
    if (!count) return 0;
    const want = Math.ceil(q * count);
    for (let x = 0, seen = 0; x <= max; x++) { seen += hist[x]; if (seen >= want) return x; }
    return max;
  };
  return { mean: count ? sum / count : 0, p50: pct(0.5), p95: pct(0.95), p99: pct(SCALE_PERCENTILE), max, sum, saturated };
}

// the live pipeline's colour against the twin's, texel by texel (rgba16float bits)
function compare(a, b, covered) {
  let maxDiff = 0, differing = 0, exact = 0;
  const n = covered.length;
  for (let p = 0; p < n; p++) {
    let d = 0, same = true;
    for (let c = 0; c < 4; c++) {
      const i = 4 * p + c;
      if (a[i] === b[i]) continue;
      same = false;
      const x = halfToFloat(a[i]), y = halfToFloat(b[i]);
      d = Math.max(d, Number.isNaN(x) || Number.isNaN(y) ? Infinity : Math.abs(x - y));
    }
    if (same) { exact++; continue; }
    if (d > maxDiff) maxDiff = d;
    if (d > SAME_TOL) differing++;
  }
  return { maxDiff, differing, exactShare: exact / n };
}

function heatmap(v, covered, w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data;
  for (let p = 0; p < v.length; p++) {
    if (!covered[p]) continue;   // (transparent: the volume didn't cover it)
    const [r, g, b] = LUT[Math.min(255, Math.round((v[p] / scale) * 255))];
    d[4 * p] = r; d[4 * p + 1] = g; d[4 * p + 2] = b; d[4 * p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Attaches app.prof.cost (window.__app). Nothing is built or drawn until the first capture.
 * @param {object} app window.__app: gpu, vol, post, prof, test
 */
export function attachCostView(app) {
  const gpu = app.gpu;
  const twins = new WeakMap();   // live pipeline → its counted twin
  let targets = null;            // { w, h, colorLive, colorTwin, depth, cost0, cost1 }
  let last = null;               // the last capture's decoded counts (the overlay redraws from them)

  const twinOf = (pipe) => {
    let t = twins.get(pipe);
    if (!t) {
      const { code, layouts, params, vertex, fragment, primitive, depthStencil, multisample } = pipe.desc;
      twins.set(pipe, t = gpu.renderPipeline({
        name: `${pipe.name}.cost`, code: costify(code), layouts, params,
        ...costPipeline({ vertex, fragment, primitive, depthStencil, ...(multisample ? { multisample } : {}) }),
        build: 'now', optional: true,   // (a failure to build it is the cost view's, not the game's)
      }));
    }
    return t;
  };
  const targetsFor = (w, h) => {
    if (targets && targets.w === w && targets.h === h) return targets;
    if (targets) for (const k of ['colorLive', 'colorTwin', 'depth', 'cost0', 'cost1']) targets[k].destroy();
    const tex = (label, format) => gpu.createTexture({ label: `cost view ${label}`, size: [w, h], format, usage: USAGE.RENDER_ATTACHMENT | USAGE.COPY_SRC });
    targets = { w, h, colorLive: tex('live colour', 'rgba16float'), colorTwin: tex('counted colour', 'rgba16float'),
      depth: tex('depth', 'depth32float'), cost0: tex('counters 0', 'rgba32uint'), cost1: tex('counters 1', 'rg32uint') };
    return targets;
  };
  const colour = (t) => ({ view: t.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' });
  const depthOf = (t) => ({ view: t.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' });

  // a live frame drawn just now (its draw options in vol.lastDraw)
  async function freshFrame() {
    const vol = app.vol, before = vol.lastDraw?.n ?? 0;
    if (app.test?.parked) { await app.test.renderOnce(); return vol.lastDraw; }
    app.requestRender?.();
    const until = performance.now() + FRAME_WAIT_MS;
    while ((vol.lastDraw?.n ?? 0) === before) {
      if (performance.now() > until) throw new Error('cost view: no frame drew the volume (is the view still building?)');
      await new Promise((r) => requestAnimationFrame(r));
    }
    return vol.lastDraw;
  }

  async function capture({ kind } = {}) {
    if (kind !== undefined && !COST_KINDS.includes(kind)) throw new Error(`cost view: no counter ${kind} (${COST_KINDS.join(', ')})`);
    await gpu.pipelines.settled();
    let draw = await freshFrame();
    if (!isMaterialView(draw.view)) throw new Error(`cost view: the view drawn (${draw.view}) is not a lit view; the counters live in the lit volume's tracer`);
    const twin = twinOf(draw.pipe);
    if (twin.state !== 'ready') {
      await twin.ready;   // (its build took frames: measure a frame drawn after it)
      draw = await freshFrame();
      if (twinOf(draw.pipe) !== twin) return capture({ kind });   // (the view changed meanwhile)
    }
    const vol = app.vol;
    const { width: w, height: h } = app.post.sceneTarget;
    const t = targetsFor(w, h);
    const opts = { view: draw.view, detail: draw.detail, meshDepth: draw.meshDepth, marchNear: draw.marchNear, aerCopy: draw.aerCopy, warp: draw.warp };
    // synchronously, before anything rewrites the frame state: the live pipeline, then its twin
    const f = gpu.frame;
    let rp = f.render({ colorAttachments: [colour(t.colorLive)], depthStencilAttachment: depthOf(t) }, 'cost view live');
    const drewLive = vol.draw(rp, opts);
    rp.end();
    rp = f.render({ colorAttachments: [colour(t.colorTwin), colour(t.cost0), colour(t.cost1)], depthStencilAttachment: depthOf(t) }, 'cost view counted');
    const drewTwin = vol.draw(rp, { ...opts, pipe: twin });
    rp.end();
    if (!drewLive || !drewTwin) { gpu.flush('cost view'); throw new Error('cost view: the volume could not draw (its read format changed or its pipeline is rebuilding); capture again'); }
    const reads = [t.colorLive, t.colorTwin, t.cost0, t.cost1].map((x) => gpu.readback.texture(x));
    gpu.flush('cost view');
    const [live, counted, c0, c1] = await Promise.all(reads);

    const n = w * h;
    const { vals, covered, count } = decode(c0, c1, n);
    const counters = {};
    COST_COUNTERS.forEach((c, s) => { counters[c.key] = { label: c.label, where: c.where, ...stats(vals[s], covered, count, s === 0 ? COST_MARCH_MAX : COST_MAX) }; });
    const cmp = compare(live, counted, covered);
    const diffShare = count ? cmp.differing / count : (cmp.differing ? 1 : 0);
    const samePicture = diffShare <= SAME_SHARE;
    const warnings = COST_KINDS.filter((k) => counters[k].saturated).map((k) => `${k}: ${counters[k].saturated} pixel(s) reached the 16-bit ceiling (their counts are lower bounds)`);
    const costliest = COST_KINDS.reduce((a, b) => (counters[b].sum > counters[a].sum ? b : a));
    const shown = kind ?? costliest;
    const s = COST_KINDS.indexOf(shown);
    const scale = Math.max(1, counters[shown].p99);
    const image = heatmap(vals[s], covered, w, h, scale);
    last = { vals, covered, w, h, counters };
    const reason = samePicture ? null
      : `the counted variant drew a different picture than the live pipeline (${(100 * diffShare).toFixed(3)} % of covered pixels differ, up to ${cmp.maxDiff}): its counts do not describe the real frame`;
    return {
      unit: 'work',   // counts of work per pixel; nothing here is a time
      trusted: samePicture, reason,
      samePicture, maxDiff: cmp.maxDiff, diffShare, exactShare: cmp.exactShare,
      size: [w, h], pixels: n, covered: count,
      view: draw.view, detail: Object.keys(draw.detail ?? {}).filter((k) => draw.detail[k]).sort(), curved: !!draw.warp?.k,
      pipeline: draw.pipe.name,
      counters, costliest, kind: shown,
      legend: { kind: shown, label: counters[shown].label, min: 0, max: scale, scale: `linear to the covered pixels' p${Math.round(SCALE_PERCENTILE * 100)}`, colormap: 'inferno', uncovered: 'transparent' },
      warnings,
      image: image.toDataURL('image/png'),
    };
  }

  // ---- the overlay: the same counters as a false-colour view, with a legend ----
  let overlay = null, shownKind = null, lastResult = null;
  function legendHTML(r) {
    const stops = INFERNO.map((c, i) => `rgb(${c}) ${(100 * i) / (INFERNO.length - 1)}%`).join(',');
    const c = r.counters[r.kind];
    const trust = r.trusted ? `<span style="color:#7c7">same picture as the live pipeline (${(100 * r.exactShare).toFixed(2)} % bit-exact)</span>`
      : `<span style="color:#f66">UNTRUSTED: ${r.reason}</span>`;
    return `<div style="font-weight:600">${c.label} <span style="opacity:.6">per pixel (work, not time)</span></div>
<div style="height:10px;margin:6px 0 2px;background:linear-gradient(90deg,${stops})"></div>
<div style="display:flex;justify-content:space-between"><span>0</span><span>${r.legend.max}+ (p99)</span></div>
<div style="opacity:.8;margin:4px 0">mean ${c.mean.toFixed(1)} · p50 ${c.p50} · p95 ${c.p95} · max ${c.max} · ${r.covered} of ${r.pixels} px covered (${r.size.join('×')} scene)</div>
<div style="opacity:.8;margin-bottom:6px">${trust}</div>
<div style="display:flex;flex-wrap:wrap;gap:3px">${COST_KINDS.map((k) => `<button data-kind="${k}" style="font:inherit;padding:1px 5px;border:1px solid #555;border-radius:3px;cursor:pointer;background:${k === r.kind ? '#ddd;color:#000' : '#222;color:#ddd'}">${k}</button>`).join('')}
<button data-again="1" style="font:inherit;padding:1px 5px;border:1px solid #555;border-radius:3px;cursor:pointer;background:#335;color:#ddd">capture again</button></div>`;
  }
  function render(r) {
    if (!overlay) return;
    const canvas = app.renderer?.domElement ?? document.querySelector('canvas');
    const box = canvas.getBoundingClientRect();
    Object.assign(overlay.img.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    overlay.img.src = r.image;
    overlay.legend.innerHTML = legendHTML(r);
  }
  // the overlay's image for another counter, from the last capture's counts (no new frame)
  function redraw(kind) {
    if (!last || !lastResult) return;
    const s = COST_KINDS.indexOf(kind), scale = Math.max(1, last.counters[kind].p99);
    lastResult = { ...lastResult, kind, legend: { ...lastResult.legend, kind, label: last.counters[kind].label, max: scale },
      image: heatmap(last.vals[s], last.covered, last.w, last.h, scale).toDataURL('image/png') };
    render(lastResult);
  }
  async function show(on = !overlay, { kind } = {}) {
    if (!on) { overlay?.root.remove(); overlay = null; return null; }
    if (!overlay) {
      const root = document.createElement('div');
      root.dataset.costView = '';
      const img = document.createElement('img');
      Object.assign(img.style, { position: 'fixed', pointerEvents: 'none', opacity: String(OVERLAY_ALPHA), imageRendering: 'pixelated', zIndex: 9998 });
      const legend = document.createElement('div');
      Object.assign(legend.style, { position: 'fixed', left: '12px', bottom: '12px', maxWidth: '440px', padding: '8px 10px', zIndex: 9999,
        background: 'rgba(0,0,0,.82)', color: '#ddd', font: '12px/1.35 ui-monospace,Menlo,monospace', borderRadius: '6px' });
      legend.textContent = 'cost view: capturing…';
      legend.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.again) show(true, { kind: shownKind });
        else { shownKind = b.dataset.kind; redraw(shownKind); }
      });
      root.append(img, legend);
      document.body.append(root);
      overlay = { root, img, legend };
    }
    shownKind = kind ?? shownKind ?? undefined;
    try {
      lastResult = await capture({ kind: shownKind });
      shownKind = lastResult.kind;
      render(lastResult);
      return lastResult;
    } catch (e) {
      if (overlay) overlay.legend.textContent = `cost view: ${e.message}`;
      throw e;
    }
  }
  addEventListener('keydown', (e) => {
    if (e.code !== TOGGLE_KEY || e.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    e.preventDefault();
    show().catch((err) => console.warn(err));
  });

  const cost = { kinds: COST_COUNTERS, capture, show };
  if (app.prof) app.prof.cost = cost;
  return cost;
}
