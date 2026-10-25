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

## Trusted ms, ms per cause, targets

**Trusted per-pass ms.** On Apple's tile-based GPUs, render-pass timestamps can span whole submissions. They can sum past the frame, and the report then says UNTRUSTED. On a Mac the tool therefore records a Metal System Trace (`tools/gpu-counters.mjs`), attaching beside the boot so it costs no extra slot time. While the profiler is on, `gpu/timing.js` gives every Metal encoder the profiler's pass name plus a pose tag (`scene@0`; `@-` outside the timed frames, which are left out). `applyMetal` (`src/gfx/profileCauses.js`) maps those encoder times onto the passes:

- the frames in the trace window come from the trace itself: a once-a-frame pass's encoder count over its count per frame, median over passes;
- a pass whose encoder count doesn't fit that window loses its Metal ms;
- a pass with no labelled Metal encoder keeps its timestamp only when timestamps are trusted. Otherwise its ms is `–` with the reason, and the report is UNTRUSTED while such passes hold more than 5% of the timestamp time;
- Metal GPU time with no pass label is listed separately as unlabelled.

Known gap (Lab, M5, 2026-10-25): compute passes arrive labelled, but most render encoders reach the trace as "Render Command N" or "GPU Execution" rows. These are intervals whose encoder isn't in the app-side encoder table. So `scene`, `canvas` and three's passes have no trusted ms yet. The next step is in the trace parser (`tools/gpu-counters.mjs`): join those intervals to their command buffer and encoder, or else time each render pass in a submission of its own.

**ms per cause (an estimate).** With `--poses`, each pose gives one observation per counted pass: its trusted ms, plus agent C's counter totals by category (`CATEGORIES`, e.g. `march`, `cellStepsOwn`, `skips`, `fieldReads`). `estimateCauses` fits ms ≈ Σ cost per unit × count by non-negative least squares. It prints the fit only when it is honest:

- at least categories + 2 observations;
- no two category columns correlated above 0.95;
- a leave-one-out error under 25% of the mean ms.

Otherwise it tries coarser groupings (`CATEGORY_LEVELS`: traversal, reads, lighting, reflections, then fewer), saying so. If none fits, it prints why and the measurement that would make it possible. The printout says `ESTIMATE`, gives the method, R² and leave-one-out error, and shows ± that error per category. It never fits untrusted times.

**Coverage.** Every report says which passes the counters cover, the ms they hold out of the frame, and the share of the scene's pixels counted. It also lists the uncounted passes (the far field's `drawBehind` has no counters yet). Compare category deltas only when both runs counted the same passes; `--compare` prints "NOT the same pixels counted" when they didn't.

**Target.** `--target <ms>`, or `--compare old/profile.json` (its frame ms), adds "frame X ms vs Y ms: to reach it, cut …". With a compare, the cuts go to the categories or passes that grew most against the target build. Without one, they go to the largest.

**Slot.** xctrace attaches in parallel with the boot. Each pose takes about 2.5 s on Lab (warmup, settle, 20 frames, cost capture). A pose that stalls ends the poses, and the report covers those captured. Lab with four poses fits in 12.5 s.

## Hooks for other tools

- **Per-pixel cost (agent C).** `__app.prof.cost = { capture: async () => ({ counters: { <name>: { mean, p50, p95, max } }, image: <data URL>, pass?: 'scene', pixels?: <n>, normal?: { <name>: [lo, hi] } }) }`. `pass` names the waterfall pass the counters describe (default `scene`), and `pixels` is its pixel count (default: the scene target). `normal` gives the expected range per counter, which the work/time flag needs. The tool calls it after the timed frames, prints the counters and saves `image` as `cost.png`.
- **GPU counters (agent D).** `tools/gpu-counters.mjs` exports `start({ browser, page, outDir, frames })`, which resolves to `{ stop(): Promise<{ text: string, summary?: object, trace?: string }> }`. `--counters` starts it before the capture and stops it after. `text` is printed as is, and `summary` goes into `profile.json`. If the module is missing, `--counters` says so and goes on.

## Checks

- `node tools/profile-cpu-check.mjs`: no GPU. Covers the sampling fixes, `capture(n)`, the report, the untrusted reasons, the work/time flag, and text, HTML and compare.
- `node tools/check-profiler-coverage.mjs`: no GPU. Covers the timing hooks themselves.
- `node tools/profile.mjs --self-test`: no GPU. Covers argument parsing.


## Cost view

The pass timings say *which* pass is slow. The lit volume is one big fragment pass, so they cannot say
*why*. The cost view counts the work each pixel's ray does inside the realistic tracer, exactly, as
integers.

### Counters

Twenty-four per pixel, 16 bits each (`src/shaders/costView.js` `COST_COUNTERS`):

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
| `cellReads` | `fetchAs`, `fetchBs`, `fetchNativeCore` (cell state) and `occIdOf` (occupancy ids) calls; the world: `wcCell` |
| `cellStepsOwn` | `cellSteps` in a brick with cells of its own (the world: W's own `MATTER` bit, `wcInfo` bit 28; the box: a non-zero occupancy mask) |
| `cellStepsDilated` | `cellSteps` in a brick with no cell of its own, visited for its flags alone (the world: W's 1-brick dilation; the box: the fields' or media's reach) |
| `cellStepsInterior` | `cellSteps` in a brick flagged `BRICK_LIQUID_INTERIOR` (checked first) |
| `skipBrick` | main-march `skipEmpty` jumps over the brick alone (the world: an occupied 16³ node; the box: `brickDist` radius 0) |
| `skip16` | jumps over an empty 16³ node (the box: a cube of 3–15 bricks a side) |
| `skip64` | jumps over an empty 64³ node (the box: a cube of 16 bricks a side or more) |
| `skipCells` | cells the main march moved by its jumps (\|Δx\| + \|Δy\| + \|Δz\|) |

The counted twin writes them to a write-only `rgba32uint` storage texture in group 0 (the next free
binding), three times the scene target's height: the pixel's twelve words, four a row, in rows 3y to
3y + 2 (slots past the last counter stay 0). It writes right after the trace, before the miss's
discard, so a ray that crossed the box and hit nothing shows its cost too. (Twenty-four 16-bit counts
don't fit beside the colour in the 32 bytes a sample may have, as the first twelve did.)

The splits add up: `cellStepsOwn + cellStepsDilated + cellStepsInterior = cellSteps` and
`skipBrick + skip16 + skip64 = brickSkips` (not the curved view's `warpSkip`, which isn't split). The
main march's jumps are marked (`gCostMainSkip`) so a reflection's `skipEmpty` isn't counted as one.

A count that reaches 65535 (the march: 32767) stops there; `saturated` says how many pixels did, and a
warning says their counts are lower bounds.

### API

```js
__app.prof.cost.kinds                    // the counters: [{ key, label, where }]
await __app.prof.cost.prepare()          // queues the counted twins of what the frame draws (a cold compile: tools/profile.mjs calls it before pipelines settle, so it ends before the timed frames)
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
  go to a storage texture beside them. Each capture draws the live pipeline and the counted twin on the
  same frame state (the FrameUniforms the frame left: the same camera, TAA jitter, frame number, sun;
  the same mesh depth, shadow map, GI), neither TAA-resolved, and compares their colour texel by
  texel. If more than 0.01 % of the covered pixels differ by more than 1/1024, the result is
  `trusted: false` with the reason, and the overlay shows it as UNTRUSTED.
- **Never timed.** The counted variant's speed is not the real shader's (its counters change its
  registers), so nothing in the result is a time, and the counts are labelled work.
- **Exact readback.** Counters are integers in an `rgba32uint` storage texture at the scene target's
  real size (not the canvas's: the scene can be rendered at a fraction of it), read back as integers.
  No sRGB encode, exposure, tone map or TAA touches them. Stats cover only covered pixels, and the
  result says how many those were.

## GPU counters

`tools/gpu-counters.mjs` records Xcode's Metal System Trace (`xctrace`) of one
process, Chrome's GPU process, and reports it per Metal encoder. That is one
WebGPU pass when Chrome runs with
`--enable-dawn-features=use_user_defined_labels_in_backend`
(`COUNTER_CHROME_ARGS`). Without that switch Dawn leaves Metal's default names,
such as "Compute Command 3", and the rows can't be matched to our passes.

```js
import { startCounters, findGpuProcess, COUNTER_CHROME_ARGS } from './gpu-counters.mjs';
const c = await startCounters({ pid: findGpuProcess({ parentPid: process.pid }), seconds: 4 });
// ...frames run...
const { byEncoder, summary } = await c.stop();
```

From the command line: `node tools/gpu-counters.mjs [--pid N] [--seconds 4] [--json out.json] [--keep]`.
With no pid it uses the only Chrome GPU process that is running.

`stop()` sends SIGINT to xctrace straight away and then parses the trace. That
parse is CPU-only and takes 10–60 s, so close the browser before you await it.
Traces go to `$TPT_XCTRACE_DIR` (default `$TMPDIR/tpt-gpu-counters`) and are
deleted afterwards unless you pass `keep`. When something goes wrong it says
so: xctrace missing, template missing, permission refused (with the
`DevToolsSecurity` fix), no or several GPU processes, a second xctrace already
recording, or a start or save timeout. It kills xctrace and never hangs.

### What each field means

| field | meaning |
|---|---|
| `label` | the WebGPU pass label. Dawn names the Metal encoder `Dawn_ComputePassEncoder_<label>` and the tool strips that prefix. Unlabelled passes show as `(unlabelled)`, and other Metal work as `Blit Command N` or `GPU Execution` |
| `count` | how many times that encoder ran during the capture |
| `gpuMs` | mean GPU time per run: the longest of its channels, because vertex and fragment work overlap on Apple's tiler |
| `channels.Vertex / Fragment / Compute` | mean GPU ms per run in each hardware channel. A render pass whose Fragment time dwarfs Vertex is pixel-bound |
| `spills.bytesMax` | the largest register spill reported for one shader run in this encoder (driver "compiler spill events"). Not zero means the shader ran out of registers and spills to memory |
| `spills.pipelinesPerEncoder` | spilling pipeline uses per encoder run. In timing split mode each dispatch is its own pass, so this names the kernel |
| `occupancy`, `limiters` | hardware occupancy and ALU / texture / memory limiter percentages. These stay **null on this Mac**, see below |
| `summary.top` | the most expensive encoders and their share of this process's GPU time |
| `summary.spilling` | encoders whose shaders spill, worst first |
| `summary.counterNote` | which counters the device streamed and why some fields are null |

### What a register-pressure / occupancy problem looks like

- **Spills:** `spills.bytesMax` is above zero on the slow pass. A few hundred
  bytes per thread is already a lot, and kilobytes means the shader is
  memory-bound on its own scratch. This is the direct signature of the cliff
  we suspect. Fix it by cutting live values: split the shader, recompute
  instead of keeping values, and shrink arrays held in registers.
- **Occupancy** (when available): a low "Occupancy" or "Fragment Occupancy"
  percentage alongside a high `gpuMs` and low ALU or texture limiters means
  too few threads fit on each core, so latency is not hidden. Registers are
  the usual cause.
- **Limiters** (when available): the highest limiter names the bottleneck.
  ALU means arithmetic, Texture Sample / Filtering means texture fetches,
  Buffer / Memory read means bandwidth, and "Last Level Cache" means misses.
  If every limiter is low but the pass is slow, the shader is
  occupancy-bound or stalled.

### Sample (lab map, prod, 3 s, attached to the GPU process)

```
label            count   gpuMs  fragment  compute  spill B
v2block             73   9.093         -    9.093     2976
scene               35  16.137    16.137        -     1552
v2pairs           1460   0.100         -    0.100      288
v2heat              73   1.589         -    1.589      816
```

In that run v2block (35 % of GPU time) and the scene render pass (30 %) both run shaders that spill registers.

### What this Mac can't give (M5, Xcode 27.1, 2026-10-24)

`xctrace` sends only the "RT Unit Active" counter, whatever counter set the
template asks for. We patch Apple's template to "Performance Limiters" (raw
profile 3) and to this GPU's registry id, and the recorded settings confirm
both. Shader Timeline also records nothing from the command line. Occupancy
and limiters therefore need **Instruments.app** (Metal System Trace, set
GPU > Counter Set to Performance Limiters, attach to the Chrome GPU process)
or an Xcode GPU capture. The tool's spills and channel times are real and
come from the same trace.

Attaching and recording all processes give the same Metal tables, which are
system-wide either way, so the tool always filters to the pid.
