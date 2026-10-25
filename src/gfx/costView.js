// The cost view (docs/profiler.md "Cost view"): per-pixel work counters for
// the lit volume, read back exactly. __app.prof.cost:
//
//   kinds                       the counters (shaders/costView.js COST_COUNTERS)
//   capture({ kind? })          one frame's counts: { counters: { key: { mean, p50, p95, max, sum } }, image, … }
//   show(on?, { kind? })        the false-colour overlay with its legend (the profiler panel's Cost button)
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

import { COST_COUNTERS, COST_KINDS, COST_COVERED_BIT, COST_MAX, COST_MARCH_MAX, COST_STORAGE_FORMAT, COST_STORAGE_ROWS, COST_WORDS } from '../shaders/costView.js';
import { MARCH_STAGES } from '../shaders/world/march.js';
import { halfToFloat } from '../gpu/readback.js';
import { isMaterialView } from '../views.js';

// GPUTextureUsage bits (no GPU globals at import: tools/check-imports.mjs)
const USAGE = { COPY_SRC: 0x01, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10 };
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

// inferno (matplotlib's, CC0), 9 stops: dark = little work, bright = a lot
const INFERNO = [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]];
function inferno(x) {
  const t = Math.min(1, Math.max(0, x)) * (INFERNO.length - 1), i = Math.min(INFERNO.length - 2, Math.floor(t)), f = t - i;
  return INFERNO[i].map((a, c) => Math.round(a + (INFERNO[i + 1][c] - a) * f));
}
const LUT = Array.from({ length: 256 }, (_, i) => inferno(i / 255));

// every pixel's counts from its COST_WORDS words (shaders/costView.js costStore: two 16-bit counts a word)
export function decode(words, n) {
  const vals = COST_KINDS.map(() => new Uint16Array(n)), covered = new Uint8Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) {
    const o = COST_WORDS * p;
    if (!(words[o] & COST_COVERED_BIT)) continue;
    covered[p] = 1; count++;
    for (let s = 0; s < COST_KINDS.length; s++) {
      const word = words[o + (s >> 1)];
      vals[s][p] = s & 1 ? word >>> 16 : word & (s === 0 ? COST_MARCH_MAX : COST_MAX);
    }
  }
  return { vals, covered, count };
}

// mean, p50, p95, max, sum over the covered pixels, from a histogram (counts are 16-bit)
export function stats(v, covered, count, cap = Infinity) {
  let max = 0;
  for (let p = 0; p < v.length; p++) if (covered[p] && v[p] > max) max = v[p];
  const hist = new Uint32Array(max + 1);
  let sum = 0, saturated = 0;
  for (let p = 0; p < v.length; p++) {
    if (!covered[p]) continue;
    const x = v[p];
    hist[x]++; sum += x;
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

// the storage sink's texture (w × ROWS·h rgba32uint: the pixel's words four a row, rows ROWS·y …) as decode's words
export function storageWords(t, w, h) {
  const out = new Uint32Array(COST_WORDS * w * h);
  for (let y = 0; y < h; y++) {
    for (let r = 0; r < COST_STORAGE_ROWS; r++) {
      const row = 4 * w * (COST_STORAGE_ROWS * y + r);
      for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out[COST_WORDS * (w * y + x) + 4 * r + c] = t[row + 4 * x + c];
    }
  }
  return out;
}
// two integer (or raw float) textures, word for word: pixels whose words differ
export function compareWords(a, b, words) {
  let differing = 0;
  for (let p = 0, n = a.length / words; p < n; p++) {
    for (let c = 0; c < words; c++) if (a[words * p + c] !== b[words * p + c]) { differing++; break; }
  }
  return differing;
}
// the live pipeline's colour against the twin's, texel by texel (rgba16float bits)
export function compare(a, b, covered) {
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
  let targets = null;            // { w, h, colorLive, colorTwin, depth, cost }
  let last = null;               // the last capture's decoded counts (the overlay redraws from them)
  // the counters' storage texture: the scene's width, COST_STORAGE_ROWS times its height
  const costTexture = (label, w, h) => gpu.createTexture({ label: `cost view ${label}`, size: [w, COST_STORAGE_ROWS * h], format: COST_STORAGE_FORMAT,
    usage: USAGE.STORAGE_BINDING | USAGE.RENDER_ATTACHMENT | USAGE.COPY_SRC });
  const targetsFor = (w, h) => {
    if (targets && targets.w === w && targets.h === h) return targets;
    if (targets) for (const k of ['colorLive', 'colorTwin', 'depth', 'cost']) targets[k].destroy();
    const tex = (label, format) => gpu.createTexture({ label: `cost view ${label}`, size: [w, h], format, usage: USAGE.RENDER_ATTACHMENT | USAGE.COPY_SRC });
    targets = { w, h, colorLive: tex('live colour', 'rgba16float'), colorTwin: tex('counted colour', 'rgba16float'),
      depth: tex('depth', 'depth32float'), cost: costTexture('counters', w, h) };
    targets.costView = targets.cost.createView();
    return targets;
  };
  // the counters cleared (a pixel nothing covers keeps 0: no coverage bit)
  const clearCounters = (f, view) => f.render({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }, 'cost view counted clear').end();
  const colour = (t) => ({ view: t.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' });
  const depthOf = (t) => ({ view: t.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' });

  // What the last frame drew: the world march (gfx/worldView.js lastRecorded: the material views
  // on this branch) or the box volume (gfx/volume.js lastDraw: the curved view), whichever is newer.
  const draws = () => (app.vol?.lastDraw?.n ?? 0) + (app.worldView?.lastRecorded?.n ?? 0);
  const newest = () => {
    const wv = app.worldView?.lastRecorded, box = app.vol?.lastDraw;
    if (wv && (!box || (wv.at ?? 0) >= (box.at ?? 0))) return { world: true, rec: wv };
    return box ? { world: false, rec: box } : null;
  };
  // a live frame drawn just now
  async function freshFrame() {
    const before = draws();
    if (app.test?.parked) await app.test.renderOnce();
    else {
      app.requestRender?.();
      const until = performance.now() + FRAME_WAIT_MS;
      while (draws() === before) {
        if (performance.now() > until) throw new Error('cost view: no frame drew the view (is it still building?)');
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    const src = newest();
    if (!src) throw new Error('cost view: no frame has drawn a lit view yet');
    return src;
  }

  // the result's shared tail: stats over the covered pixels, the costliest counter, its heatmap
  function result(base, { vals, covered, count, w, h, stages = null, kind, caps }) {
    const counters = {};
    COST_COUNTERS.forEach((c, s) => { counters[c.key] = { label: c.label, where: c.where, ...stats(vals[s], covered, count, caps[s]) }; });
    const warnings = COST_KINDS.filter((k) => counters[k].saturated).map((k) => `${k}: ${counters[k].saturated} pixel(s) reached the 16-bit ceiling (their counts are lower bounds)`);
    if (stages) {
      for (const [st, x] of Object.entries(stages)) {
        for (const k of COST_KINDS) if (x.counters[k].saturated) warnings.push(`${st} ${k}: ${x.counters[k].saturated} pixel(s) reached the 16-bit ceiling (lower bounds)`);
      }
    }
    const costliest = COST_KINDS.reduce((a, b) => (counters[b].sum > counters[a].sum ? b : a));
    const shown = kind ?? costliest;
    const scale = Math.max(1, counters[shown].p99);
    const image = heatmap(vals[COST_KINDS.indexOf(shown)], covered, w, h, scale);
    last = { vals, covered, w, h, counters };
    return {
      unit: 'work',   // counts of work per pixel; nothing here is a time
      ...base,
      size: [w, h], pixels: w * h, covered: count,
      counters, ...(stages ? { stages } : {}), costliest, kind: shown,
      legend: { kind: shown, label: counters[shown].label, min: 0, max: scale, scale: `linear to the covered pixels' p${Math.round(SCALE_PERCENTILE * 100)}`, colormap: 'inferno', uncovered: 'transparent' },
      warnings,
      image: image.toDataURL('image/png'),
    };
  }
  const detailList = (d) => Object.keys(d ?? {}).filter((k) => d[k]).sort();
  const untrustedWhy = (what, diffShare, maxDiff) => `the counted variant drew a different ${what} than the live pipeline (${(100 * diffShare).toFixed(3)} % of covered pixels differ, up to ${maxDiff}): its counts do not describe the real frame`;

  async function capture({ kind } = {}) {
    if (kind !== undefined && !COST_KINDS.includes(kind)) throw new Error(`cost view: no counter ${kind} (${COST_KINDS.join(', ')})`);
    await gpu.pipelines.settled();
    const src = await freshFrame();
    if (!isMaterialView(src.rec.view)) throw new Error(`cost view: the view drawn (${src.rec.view}) is not a lit view; the counters live in the lit tracer`);
    return src.world ? captureWorld(src.rec, kind) : captureBox(src.rec, kind);
  }

  // ---- the box volume (gfx/volume.js): one pass, the counters in a storage texture beside its colour ----
  async function captureBox(draw, kind) {
    const vol = app.vol;
    const twin = vol.costTwin(draw.pipe);
    if (twin.state !== 'ready') {
      await twin.ready;   // (its build took frames: measure a frame drawn after it)
      const again = await freshFrame();
      if (again.world || vol.costTwin(again.rec.pipe) !== twin) return capture({ kind });   // (the view changed meanwhile)
      draw = again.rec;
    }
    const { width: w, height: h } = app.post.sceneTarget;
    const t = targetsFor(w, h);
    const opts = { view: draw.view, detail: draw.detail, meshDepth: draw.meshDepth, marchNear: draw.marchNear, aerCopy: draw.aerCopy, warp: draw.warp };
    // synchronously, before anything rewrites the frame state: the live pipeline, then its twin
    const f = gpu.frame;
    clearCounters(f, t.costView);
    let rp = f.render({ colorAttachments: [colour(t.colorLive)], depthStencilAttachment: depthOf(t) }, 'cost view live');
    const drewLive = vol.draw(rp, opts);
    rp.end();
    rp = f.render({ colorAttachments: [colour(t.colorTwin)], depthStencilAttachment: depthOf(t) }, 'cost view counted');
    const drewTwin = vol.draw(rp, { ...opts, pipe: twin, cost: t.costView });
    rp.end();
    if (!drewLive || !drewTwin) { gpu.flush('cost view'); throw new Error('cost view: the volume could not draw (its read format changed or its pipeline is rebuilding); capture again'); }
    const reads = [t.colorLive, t.colorTwin, t.cost].map((x) => gpu.readback.texture(x));
    gpu.flush('cost view');
    const [live, counted, costTex] = await Promise.all(reads);
    const { vals, covered, count } = decode(storageWords(costTex, w, h), w * h);
    const cmp = compare(live, counted, covered);
    const diffShare = count ? cmp.differing / count : (cmp.differing ? 1 : 0);
    const samePicture = diffShare <= SAME_SHARE;
    return result({
      trusted: samePicture, reason: samePicture ? null : untrustedWhy('picture', diffShare, cmp.maxDiff),
      samePicture, maxDiff: cmp.maxDiff, diffShare, exactShare: cmp.exactShare,
      path: 'box', pass: 'scene', passes: ['scene'],
      view: draw.view, detail: detailList(draw.detail), curved: !!draw.warp?.k, pipeline: draw.pipe.name,
    }, { vals, covered, count, w, h, kind, caps: COST_KINDS.map((_, s) => (s === 0 ? COST_MARCH_MAX : COST_MAX)) });
  }

  // ---- the world march (gfx/worldView.js): the split stages, or the whole march ----
  // Each stage's twin writes its counters into a storage texture of its own, read back as it is:
  // a stage's counts are the ones that stage made. The live chain and the counted chain each run
  // into a G-buffer of their own; every stage output a target holds is compared (G0, G1: the march;
  // O: the reflection; S, D: the picture), so no stage's counts stand for a different stage's work.
  let world = null;   // { w, h, split, gbA, gbB, cost: { stage: texture }, colorLive, colorTwin, depth }
  const worldTargets = (wv, w, h, split) => {
    if (world && world.w === w && world.h === h && world.split === split && world.wv === wv) return world;
    if (world) { world.gbA?.destroy(); world.gbB?.destroy(); for (const t of [...Object.values(world.cost), world.colorLive, world.colorTwin, world.depth]) t?.destroy(); }
    const tex = (label, format, size = [w, h], usage = USAGE.RENDER_ATTACHMENT | USAGE.COPY_SRC) => gpu.createTexture({ label: `cost view ${label}`, size, format, usage });
    const stages = split ? MARCH_STAGES : ['whole'];
    world = {
      w, h, split, wv,
      cost: Object.fromEntries(stages.map((st) => [st, costTexture(`${st} counters`, w, h)])),
      ...(split ? { gbA: wv.costGbuffer(w, h), gbB: wv.costGbuffer(w, h) }
        : { colorLive: tex('live colour', 'rgba16float'), colorTwin: tex('counted colour', 'rgba16float'), depth: tex('depth', 'depth32float') }),
    };
    world.costViews = Object.fromEntries(Object.entries(world.cost).map(([st, t]) => [st, t.createView()]));
    return world;
  };
  async function captureWorld(rec, kind) {
    const wv = app.worldView;
    const stages = rec.split ? MARCH_STAGES : ['whole'];
    const liveOf = (r) => (r.split ? r.pipe.parts : { whole: r.pipe });
    let twinParts = Object.fromEntries(stages.map((st) => [st, wv.costTwin(liveOf(rec)[st], st)]));
    if (Object.values(twinParts).some((t) => t.state !== 'ready')) {
      await Promise.all(Object.values(twinParts).map((t) => t.ready));   // (their builds took frames: measure a frame drawn after them)
      const again = await freshFrame();
      if (!again.world || again.rec.pipe !== rec.pipe) return capture({ kind });   // (the view changed meanwhile)
      rec = again.rec;
      twinParts = Object.fromEntries(stages.map((st) => [st, wv.costTwin(liveOf(rec)[st], st)]));
    }
    const [w, h] = rec.size ?? [app.post.sceneTarget.width, app.post.sceneTarget.height];
    const t = worldTargets(wv, w, h, rec.split);
    // synchronously, before anything rewrites the frame state: the counters cleared, the live chain, the counted chain
    const f = gpu.frame;
    for (const v of Object.values(t.costViews)) clearCounters(f, v);
    const target = (c) => (rec.split ? null : { color: c.createView(), depth: t.depth.createView() });
    const okLive = wv.costReplay(f, rec, { parts: liveOf(rec), pipe: rec.pipe, g: t.gbA, target: target(t.colorLive), name: 'cost view live' });
    const okTwin = wv.costReplay(f, rec, { parts: twinParts, pipe: twinParts.whole, g: t.gbB, target: target(t.colorTwin), cost: t.costViews, name: 'cost view counted' });
    if (!okLive || !okTwin) { gpu.flush('cost view'); throw new Error('cost view: the world march could not replay (its world copy is rebuilding); capture again'); }
    // what each chain made: the picture (S, D; the whole march: its colour), the stages' outputs, the counters
    const pairs = rec.split ? { S: 'S', D: 'D', G0: 'G0', G1: 'G1', O: 'O' } : { S: null };
    const reads = {};
    for (const k of Object.keys(pairs)) {
      reads[k] = rec.split ? [t.gbA.tex[k], t.gbB.tex[k]] : [t.colorLive, t.colorTwin];
      reads[k] = reads[k].map((x) => gpu.readback.texture(x));
    }
    const costReads = stages.map((st) => gpu.readback.texture(t.cost[st]));
    gpu.flush('cost view');
    const got = {};
    for (const [k, [a, b]] of Object.entries(reads)) got[k] = [await a, await b];
    const costTex = await Promise.all(costReads);

    // each stage's counts, as that stage wrote them; the frame's per pixel is their sum
    const n = w * h;
    const per = stages.map((st, i) => ({ st, ...decode(storageWords(costTex[i], w, h), n) }));
    const frame = per[0];   // the march (or the whole march) covers every pixel the world does
    const covered = frame.covered, count = frame.count;
    const vals = COST_KINDS.map((_, s) => {
      const v = new Uint32Array(n);
      for (const x of per) { const src = x.vals[s]; for (let p = 0; p < n; p++) v[p] += src[p]; }
      return v;
    });
    const stageStats = rec.split ? Object.fromEntries(per.map((x) => [x.st, {
      pass: `world ${x.st}`, covered: x.count,
      counters: Object.fromEntries(COST_COUNTERS.map((c, s) => [c.key, stats(x.vals[s], covered, count, s === 0 ? COST_MARCH_MAX : COST_MAX)])),
    }])) : null;
    // the comparisons: the picture with a tolerance (as the box's), every stage output word for word
    const pic = compare(got.S[0], got.S[1], covered);
    let picDiffering = pic.differing;
    const outputs = {};
    if (rec.split) {
      const dDiff = compareWords(got.D[0], got.D[1], 1);
      picDiffering = Math.max(picDiffering, dDiff);
      outputs.D = dDiff;
      for (const [k, words] of [['G0', 4], ['G1', 4], ['O', 4]]) outputs[k] = compareWords(got[k][0], got[k][1], words);
    }
    const diffShare = count ? picDiffering / count : (picDiffering ? 1 : 0);
    const samePicture = diffShare <= SAME_SHARE;
    const stageOutputsSame = Object.entries(outputs).filter(([k]) => k !== 'D').every(([, d]) => d === 0);
    const trusted = samePicture && stageOutputsSame;
    const reason = !samePicture ? untrustedWhy('picture', diffShare, pic.maxDiff)
      : !stageOutputsSame ? `the counted stages wrote different G-buffer words than the live ones (${Object.entries(outputs).filter(([, d]) => d).map(([k, d]) => `${k}: ${d} px`).join(', ')}): their counts do not describe the real frame`
        : null;
    return result({
      trusted, reason, samePicture, maxDiff: pic.maxDiff, diffShare, exactShare: pic.exactShare,
      ...(rec.split ? { stageOutputsDiffering: outputs } : {}),
      path: rec.split ? 'world split' : 'world whole',
      pass: rec.split ? 'world march' : 'scene',
      passes: rec.split ? MARCH_STAGES.map((st) => `world ${st}`) : ['scene'],
      view: rec.view, detail: detailList(rec.detail), curved: false, pipeline: rec.pipe.name,
    }, { vals, covered, count, w, h, stages: stageStats, kind, caps: COST_KINDS.map((_, s) => (s === 0 ? COST_MARCH_MAX : COST_MAX) * stages.length) });
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

  const cost = { kinds: COST_COUNTERS, capture, show };
  if (app.prof) app.prof.cost = cost;
  return cost;
}
