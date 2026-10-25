# Profiler

## Cost view

The pass timings say *which* pass is slow. The lit volume is one big fragment pass, so they cannot say
*why*. The cost view counts the work each pixel's ray does inside the realistic tracer, exactly, as
integers.

### Counters

Twelve per pixel, 16 bits each (`src/shaders/costView.js` `COST_COUNTERS`):

| key | counts |
| --- | --- |
| `march` | iterations of `traceView`'s main loop (refraction restarts included) |
| `brickSkips` | `traceView`'s empty-region jumps (`skipEmpty`; curved: `warpSkip`) |
| `cellSteps` | `traceView`'s DDA advances (the crisp-only fast path, `ddaStep`; curved: `warpAdvance`) |
| `shadowSteps` | iterations of `sunRayClear` (secondary sun rays) |
| `nearSteps` | iterations of `traceNearSteps` (near field, AO, lamp shadow rays) |
| `reflSteps` | iterations of `reflectHit` (the traced reflection) |
| `refractions` | `liquidInterface` and `crystalInterface` calls (each bends and restarts the main march) |
| `rootIters` | iterations of `surfRoot` and `reflCross` (surface root finding) |
| `shading` | `shadeHit` calls |
| `sunShadow` | `sunMapShadow` and `sunMapShadowAt` calls (`sunShadow`/`sunShadowAt` reach the map through them) |
| `fieldReads` | field texture taps: `fieldTex` (1) and `cubicFetch8` (8) |
| `cellReads` | `fetchAs`, `fetchBs`, `fetchNativeCore` (cell state) and `occIdOf` (occupancy ids) calls |

A count that reaches 65535 (the march: 32767) stops there; `saturated` says how many pixels did, and a
warning says their counts are lower bounds.

### API

```js
__app.prof.cost.kinds                    // the counters: [{ key, label, where }]
await __app.prof.cost.capture({ kind })  // kind optional: the heatmap's counter
await __app.prof.cost.show(on, { kind }) // the overlay (F9 toggles it)
```

`capture()` returns

```js
{
  unit: 'work',                  // counts of work per pixel; no field is a time
  trusted, reason,               // reason: why not, when not trusted
  samePicture, maxDiff, diffShare, exactShare,   // live pipeline vs counted twin, texel by texel
  size: [w, h], pixels, covered, // the scene target's real size; pixels the volume covered
  view, detail, curved, pipeline,
  counters: { march: { label, where, mean, p50, p95, p99, max, sum, saturated }, … },
  costliest,                     // the counter with the largest sum
  kind, legend,                  // what the image shows: { label, min: 0, max (its p99), colormap: 'inferno' }
  warnings,
  image,                         // PNG data URL at the scene target's size, uncovered pixels transparent
}
```

Stats cover only the pixels the volume covered: the box was hit and the trace ran. A ray that crossed
the box and hit nothing still counts (it cost work). The overlay shows the same counts as a false-colour
image over the canvas, with a legend, the stats, the trust line and a button per counter (switching
counter redraws from the same capture; "capture again" takes a new one).

`node tools/cost-view-check.mjs --map lab|island --out dir` is one real-GPU capture (manual mode).

### Why it can't lie

- **Same code, proven.** The counted module is the live pipeline's own WGSL text
  (`pipe.desc.code`, what `volumeFrag` generated) with spans inserted, each fenced
  `/*cost{*/ … /*}cost*/`. Nothing is removed or rewritten. `tools/check-cost-view.mjs` proves, for
  every lit view, detail level, flat and curved, and read format, that stripping the spans gives the
  normal module byte for byte, that every span is a counter increment, the counters' declarations or
  the outputs that carry them, and that every counter counts somewhere. An anchor the tracer loses makes
  `costify` throw instead of reading 0.
- **Off is off.** The normal modules' sha256 is the same before the cost module is imported, after, and
  after every module has been counted; and the generator is not touched (the counters are inserted into
  its output), so the live pipelines are byte-identical with or without the cost view. No live pipeline
  is ever built from the counted text.
- **Same picture, proven.** The counted variant still writes the normal colour and depth; its counters
  go to two integer targets beside them. Each capture draws the live pipeline and the counted twin on the
  same frame state (the FrameUniforms the frame left: the same camera, TAA jitter, frame number, sun;
  the same mesh depth, shadow map, GI), neither TAA-resolved, and compares their colour texel by
  texel. If more than 0.01 % of the covered pixels differ by more than 1/1024, the result is
  `trusted: false` with the reason, and the overlay shows it as UNTRUSTED.
- **Never timed.** The counted variant's speed is not the real shader's (its counters change its
  registers), so nothing in the result is a time, and the counts are labelled work.
- **Exact readback.** Counters are integers in `rgba32uint`/`rg32uint` targets at the scene target's
  real size (not the canvas's: the scene can be rendered at a fraction of it), read back as integers.
  No sRGB encode, exposure, tone map or TAA touches them. Stats cover only covered pixels, and the
  result says how many those were.
