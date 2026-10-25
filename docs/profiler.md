# The profiler

One action shows what is wrong with performance, in one run.

- **Agents:** `node tools/profile.mjs --map <key> [--pose default|landDown|sky|horizon|x,y,z,tx,ty,tz] [--view realistic] [--frames 60] [--counters] [--out dir]`
- **In the browser:** `?profile=1`, or Settings → Developer → Profiler, or `__app.prof.enable(true)`. `await __app.prof.capture({ frames: 60 })` returns the report for the next 60 frames, and `__app.prof.report()` returns it for the frames already kept. `.text` holds the printout, the same text the tool prints.

**The rule:** if the report doesn't tell you what you need, improve the profiler. Add the pass label, the counter or the report line here, so every later agent gets it. Don't work around it with ad-hoc `performance.now()` timing, a private frame pump or a one-off bench. "Build the perfect profiler waterfall; all else will come downstream."

## What a run does

`tools/profile.mjs` uses one 25 s headless GPU slot (`tools/browser.mjs`). It refuses to run on battery. It starts a private Vite server and transforms the JS before it takes the slot. Then it:

1. boots `?map=<key>&view=<view>&profile=1` in `?test=visual` mode, at full presentation cadence and quality;
2. waits for `__app.test.ready()` and `gpu.pipelines.settled()`. Big maps build their physics kernels after the first frame, so a capture taken earlier is inflated;
3. freezes auto resolution at its current scale (`--autores` leaves it running), sets the pose, and calls `__app.requestRender()` every animation frame. A settled scene draws nothing (gfx/pacing.js), so without this nothing would render;
4. warms up for `--warmup` frames, waits out any builds the pose started, then runs `prof.capture({ frames })`;
5. after the timed frames, collects agent C's cost counters (`__app.prof.cost?.capture()`) and, with `--counters`, agent D's GPU counters (`tools/gpu-counters.mjs`);
6. closes the browser, measures GPU utilization again to detect a shared GPU, prints the report, and writes `profile.json`, `profile.html` (a self-contained waterfall) and `cost.png` (C's heatmap) to `--out`. The default is `$TMPDIR/tpt-profile/<map>-<pose>`.

`--compare old/profile.json` prints the per-pass deltas. It says "NOT comparable" with the reasons when the setups differ.

## Reading the report

The header says `PROFILE (trusted)`, or `UNTRUSTED:` followed by every reason. Below it come the setup, the pose and the compile state.

| Line / column | Meaning |
|---|---|
| `»` verdict | Which side bounds the frame. `GPU-bound`: the GPU span is at least 90% of the frame interval. `CPU-bound`: the main thread's frame work is at least 90% of it. `At the 60 fps cap`: neither, with the headroom. `Neither side fills…`: frames in flight, vsync or the compositor. Then the top three GPU passes and the top CPU phase. |
| `frame interval` | rAF start to the next frame's start: what the player feels. Median [p10–p90] and fps. |
| `CPU work` | The tick's main-thread time, from `beginFrame` to `endFrame`. |
| `GPU sum` | The sum of every timed pass in a frame. Passes can overlap, and split mode adds overhead (see below), so this is an upper bound. |
| `GPU span` | First pass start to last pass end, on one frame's timeline, when the timeline is whole. |
| phase `GPU ms` / `CPU ms` | Per frame, by the phase the app marked when the pass began (`prof.phase` in app.js: Paint, Sim, Derived, Blocks, Shadow, GI, View, Post, Other). |
| pass `ms/frame` | The mean cost per captured frame. A pass that runs every other frame costs half its median. The table is ranked by this column. |
| `median [p10–p90]` | Over the frames the pass ran in. A wide spread is flagged `noisy`. |
| `×/frame` | How many passes of that name a frame runs (split mode: one per dispatch). |
| `share` | `ms/frame` over the median GPU sum. |
| `in N%` | The pass ran in only N% of the frames (derived passes, GI every other frame). |
| `untimed:<why>` | Its timestamps are missing. The frame's total is invalid, not zero. |
| `work (agent C's cost counters…)` | Per-pixel work in the tracer (steps, samples…), shown beside the pass's real time. It is never a time. |
| `GPU counters` | Agent D's Apple GPU counters (occupancy, limiters), from the real shader. |

`profile.html` draws the median frame as a waterfall. Each pass is one bar at its GPU start, coloured by phase, with markers at 16.7 ms and at the frame's interval. The page also has the ranked table, the phases, C's heatmap and the setup.

## Why it can't lie

- **Times come only from the player's pipeline.** Every time is a timestamp query on the passes the game itself ran (`src/gpu/timing.js`). The queries hook the device's command encoders, so three.js, our passes and any future client are all covered without a hand-kept list. No test variant or cost variant is ever timed. C's cost view runs after the timed frames, and its output is labelled *work*.
- **Compiles are refused.** The capture starts only after `test.ready()` and `gpu.pipelines.settled()`. Every frame records the compiles in flight when it ended: the pipeline cache's queue, plus every async create on the device, three's included, counted at the device boundary. If any frame ended with a compile in flight, a pipeline was created during the capture, or one is still pending at the end, the report is UNTRUSTED and says so at the top. The setup also carries `framesSinceBoot`.
- **A shared GPU is reported.** The launcher takes the slot only while the GPU is idle. The tool measures utilization again right after its browser closes. If something else was using the GPU, the report is UNTRUSTED.
- **Missing timestamps invalidate.** A pass with no timestamp (query capacity, no free pool, a readback failure) is listed with its reason, and its frame has no total. It is never counted as zero.
- **Noise is in the numbers.** Every pass reports median and p10–p90 over all the frames, so one slow frame can't mislead. Fewer than 10 frames makes the report UNTRUSTED.
- **What was measured travels with the numbers.** The map, mode, view, detail, canvas, pixel ratio, scene scale (the scene target can be half resolution), TAA, upscale, auto resolution, pose, grid and world, GPU, and test mode. `compareReports` / `--compare` refuse to call two reports comparable when any of these differ.
- **Split mode is stated.** While the profiler is on, every dispatch is its own compute pass (docs/webgpu.md B8), which keeps per-kernel times. The extra pass boundaries cost time, so pass sums are upper bounds on the unsplit frame. The report notes this every time.
- **Work vs time disagreement is called out.** If C's counters are all inside their normal ranges but the traced pass costs more than half a capped frame for its pixels, the report prints `work normal, time high: shader occupancy/register pressure suspected; run --counters`. D's counters, read from the real shader, answer that question. If the counters are outside normal, it prints `work high` instead.

## Extending it

- **A new pass label.** Every pass gets the name its encoder was given: `gpu.frame.compute(name)`, `gpu.frame.render(desc, name)`, a kernel's `name` (in split mode each dispatch is named after its kernel), or `gpu.timing.scope` for a client that can't label its passes (three's renders are `three:<scene name>`). An `(unlabelled compute|render)` row in the report is a missing label. Fix it where the encoder begins the pass.
- **A new phase.** Add it to `PHASES` in `src/gfx/profiler.js` and mark it in app.js with `prof.phase('<id>')`. The report, the overlay and the HTML follow automatically. Give it a hue in `PHASE_HUE` (`src/gfx/profileReport.js`).
- **A new report line or check.** Add it to `buildReport` (and `formatReport`) in `src/gfx/profileReport.js`, with a case in `tools/profile-cpu-check.mjs`.
- **A new thing measured around the capture.** Collect it in `tools/profile.mjs`, outside the timed frames, and add it through `annotate()`.

## Hooks for other tools

- **Per-pixel cost (agent C).** `__app.prof.cost = { capture: async () => ({ counters: { <name>: { mean, p50, p95, max } }, image: <data URL>, pass?: 'scene', pixels?: <n>, normal?: { <name>: [lo, hi] } }) }`. `pass` names the waterfall pass the counters describe (default `scene`), and `pixels` is its pixel count (default: the scene target). `normal` gives the expected range per counter, which the work/time flag needs. The tool calls it after the timed frames, prints the counters and saves `image` as `cost.png`.
- **GPU counters (agent D).** `tools/gpu-counters.mjs` exports `start({ browser, page, outDir, frames })`, which resolves to `{ stop(): Promise<{ text: string, summary?: object, trace?: string }> }`. `--counters` starts it before the capture and stops it after. `text` is printed as is, and `summary` goes into `profile.json`. If the module is missing, `--counters` says so and goes on.

## Checks

- `node tools/profile-cpu-check.mjs`: no GPU. Covers the sampling fixes, `capture(n)`, the report, the untrusted reasons, the work/time flag, and text, HTML and compare.
- `node tools/check-profiler-coverage.mjs`: no GPU. Covers the timing hooks themselves.
- `node tools/profile.mjs --self-test`: no GPU. Covers argument parsing.

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
