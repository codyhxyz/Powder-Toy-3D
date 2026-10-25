# The profiler

One action shows what is wrong with performance, in one run.

- **Agents:** `node tools/profile.mjs --map <key> [--pose default|landDown|sky|horizon|x,y,z,tx,ty,tz] [--view realistic] [--frames 60] [--counters] [--knockout N|"pass,pass"] [--gpu-state min|med|max] [--out dir]`
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

`--gpufeatures core` (or a list such as `subgroups`) boots with only those optional shader features (gpu/features.js), so one feature can be A/B'd on one machine: `--gpufeatures subgroups` against the default is f16 off, everything else equal. The setup line names them (`shaders f16+subgroups`), and `--compare` counts them as a setup difference.

`--chrome-arg SWITCH` (repeatable) launches the browser with one more Chrome switch, to price it: `--chrome-arg --enable-dawn-features=disable_robustness` against the default prices Dawn's bounds checks. Chrome keeps only the last copy of a switch, so list switches (`--enable-dawn-features`, `--disable-dawn-features`, `--enable-features`, `--disable-features`) are merged with the counters' own (`COUNTER_CHROME_ARGS`, the pass labels Metal needs) into one switch. The setup line names them (`chrome --enable-dawn-features=…`), and `--compare` counts them as a setup difference.

`--compare old/profile.json` prints the per-pass deltas. It says "NOT comparable" with the reasons when the setups differ.

`--setup '<js>'` runs a fixture before each pose's warmup: an async function body given `window.__app` as `a` (say a blast repainted every few hundred ms, so particles fly through the timed frames). Its code is in the report's setup as `fixture`, and `--compare` calls two runs comparable only with the same one; what it returns is `fixtureResult`.

`--knockout N` (the N longest passes by timestamp) or `--knockout "world march,scene"` (or `--knock "world march,scene"`: those passes; on Apple the timestamps that rank passes can span whole submissions, so naming the pass is the reliable way), after the timed frames, drops the draws or dispatches of each pass for a few frames (`gpu/timing.js knockout`) and prints what the GPU span and frame interval save. The picture is wrong while a pass is knocked out. `--no-cost` skips the cost view, whose compiles take ~10 s; use it with `--knockout` (Lab with the cost view and knockouts doesn't fit the 25 s slot).

Knockout accounts for **dependants**. A pass whose draws are dropped leaves its targets cleared, so every later pass reading them runs on nothing: with the world march out, `world reflect` and `world shade` discard every pixel (`shaders/world/march.js`). A plain knockout of the march would charge their cost to it. So, for two frames before the knockouts, `gpu/timing.js depLog` records each pass's attachments (writes) and its bind groups' textures and loaded (not cleared) attachments (reads: a depth gate is one), and `passDependants` (`gfx/profileCauses.js`) finds, per frame and in order, which later passes read what each pass rendered. No names are hard-coded. Each target is then knocked out alone, its dependants alone, and both together:

```
knockout (pose 0: …)
  base: GPU span 37.08 ms · interval 33.40 ms. Savings are GPU span ms (interval ms in brackets: it moves in whole refreshes).
  world march                          out: −22.11 [−16.70] · its dependants out: −19.17 [−16.70] · both out: −22.10 [−16.70]
                                       → its own cost ≈ 2.93 ms [0.00]; 19.18 ms [16.70] of "out" is its dependants (world ev_liquid, world regate, world event, world reflect, world shade) idling without it
```

(Lab, 2026-10-25, origin/main f90d36dc: a plain knockout would have charged the lean march 22 ms; it costs 2.9, inside its Metal bounds of 1.87–3.64 ms. A pass that loads a target and renders on top, like the event kernels on the lean march's G-buffer and depth gate, passes the earlier pass's output on, so passes reading it later depend on both.)

own = saved(pass + dependants) − saved(dependants); the rest of "out" is the dependants idling. Read the GPU span: the frame interval moves in whole display refreshes or the fps cap, so it only says whether a refresh was gained (on another run: 0 ms for the march alone while the span fell 21 ms). Compute passes' storage writes are not seen as writes: knocking out a kernel leaves its data stale, not empty, so its readers keep their cost. `profile.json` keeps the graph (`knockout.dependants`), the sets measured and the rows.

`--gpu-state min|med|max` asks the Metal trace for a GPU performance state (the template's `gpuperformancestate`). On this Mac (M5, Xcode 27.1, 2026-10-25) the request is recorded ("desired state Maximum") but not enforced ("consistent state" not enabled), so the report states what the GPU actually ran at either way.

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
| `GPU performance state` | The state the GPU ran at during this pose's frames, time-weighted, from the Metal trace's `gpu-performance-state-intervals` (e.g. `Maximum 77% · Medium 23%`), and the thermal state. Apple: state changes "can affect profiling results" (WWDC 10157). `--compare` says NOT comparable when two runs' dominant states differ (`gpuPerfState`). |
| `Metal share–own ms` | Two bounds on a pass's GPU cost (below, "Trusted per-pass ms"). |
| `lanes` (cost view) | The busy-lane share of a counter over 32-pixel blocks (below, "Cost view"). |

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

Render passes (Lab, M5, 2026-10-25): under load the trace's app-side encoder list misses about half the encoders, most render work among them. Those intervals showed as "GPU Execution" or "Render Command N". `tools/gpu-counters.mjs` now labels them from Metal's object-label table, which uses the same encoder id. A pass's Metal ms is its mean GPU ms per run times the runs per timed frame the report counted. The trace drops whole intervals but not parts of them, so its run counts are low (GI and shadow at half) while its durations hold. Encoder ms are shares of the GPU's busy time: overlapping work is split evenly, so the passes sum to the busy time. A report whose Metal ms sum past the frame's GPU span is untrusted.

**Share and own: two bounds.** Apple's GPUs run vertex, fragment and compute work at once, and the next render pass's vertex stage overlaps this one's fragments (WWDC 10632). The even split above therefore gives a heavy pass running beside other work only part of its time. Each pass now shows both: `share` (the even split, a lower bound, what ranks the table and sums to the busy time) and `own` (the union of its own intervals, every channel, time shared with other encoders included: an upper bound). Under the table, the passes whose two bounds differ most say what ran beside them:

```
pass (ranked by Metal ms/frame)            phase    Metal share–own ms  share [p10–p90]   timestamp ms/frame [p10–p90]   ×/frame
world march                               view        9.441–17.801   [8.753–10.086]     17.863 [16.586–19.090]      1
world shade                               view        2.395–2.397    [2.349–2.454]      20.761 [19.564–21.887]      1
Metal share is a lower bound (time shared with other encoders split evenly), own an upper bound (its whole time on the GPU). Widest:
  world march                              9.44–17.80 ms; beside it: scene 16.69, (unlabelled) 0.02, Blit Command 4 0.01
  scene                                    8.48–16.69 ms; beside it: world march 15.81, Render Command 0 0.62
```

In that run (Lab, 2026-10-25) knockout with dependants put the march's own cost at 17.5 ms of GPU span: the `own` bound, not the share. The `scene` pass's vertex work (three's meshes) runs beside the march for most of its fragment time. `tools/gpu-counters.mjs` gives each encoder `ownMs` (with `ownMsP10`/`ownMsP90`) and `overlapWith` ([{ label, ms per run }]); the report's passes carry `msOwn` and `beside`. A kept trace re-reads without a GPU: `TPT_XCTRACE_KEEP=1` on the run, then `node tools/gpu-counters.mjs --trace <summary.trace> --pid <summary.pid>`.

On one Lab pose: scene 44.8 ms Metal against 45.6 ms timestamp, 91 of 110 passes with Metal ms, summing to 53.6 ms against a 59.3 ms span.

The Metal column also shows `[p10–p90]` over the pass's encoders in the timed frames (`gpuMsP10`/`gpuMsP90` in `tools/gpu-counters.mjs`, `msP10`/`msP90` on the pass). That is one run's spread. Runs differ by more: two plain Lab runs 25 minutes apart put the world march at 10.5 and 6.7 ms (docs/march-spill.md). For an A/B, profile both sides back to back and treat a delta inside either side's spread as no change.

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
| `march` | iterations of `traceView`'s main loop (refraction restarts included), and the trips of its runs of empty bricks (each jump a trip of the count) |
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

**Busy lanes (divergence).** An Apple GPU runs 32 fragment lanes in lockstep, and a group pays, per loop trip, for its slowest lane, so per-pixel counts can't tell "expensive work" from "groups held by one slow pixel" (research/gpu-architecture/KNOWLEDGE.md). Each counter's `busyLanes` (`gfx/costView.js laneShare`, from the per-pixel counts read back) is Σ count ÷ Σ (lanes × the block's max) over 32-pixel blocks: 100% when every lane does its block's slowest pixel's work, 1/32 when one pixel holds the group. Fragment work goes out in 2×2 quads, 8 to a 32-wide batch (desktop GPUs; Apple's packing isn't published), so blocks are made of quads: 8×4 in the `lanes` column (each split stage's own too), and the march also by 4×8 and 16×2 (`busyLanesBy`). A block's uncovered pixels count as idle lanes (they ran the shader and left at once); only blocks with a covered pixel count. Below 50% for the march (`DIVERGENT_SHARE`), the verdict says the time is groups waiting on their slowest pixels. It is a model of the grouping, not a measurement of it (the capture route below would measure it). Lab's default pose, 2026-10-25: march 95% (8×4), 94% (4×8), 93% (16×2), so not divergent there.

The splits add up: `cellStepsOwn + cellStepsDilated + cellStepsInterior = cellSteps` and
`skipBrick + skip16 + skip64 = brickSkips` (not the curved view's `warpSkip`, which isn't split).
The main march's jumps are marked (`gCostMainSkip`) so a reflection's `skipEmpty` isn't counted as one.

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

### The world march (seamless world)

The material views draw through the world march (`gfx/worldView.js`, `shaders/world/march.js`), split
into three passes: `world march` → `world reflect` → `world shade`. The cost view counts each stage
where it runs:

- Each stage's counted twin is that stage's own WGSL (`pipe.desc.code`) plus counter spans. Its colour
  targets are full (the march's G0 and G1 already use all 32 bytes a sample may have), so the counters go
  to a write-only `rgba32uint` storage texture in group 0 (the next free binding), three times the scene
  target's height: the pixel's twelve words four a row, in rows 3y to 3y + 2. The box volume uses the
  same sink (its 24 counters no longer fit beside its colour in 32 bytes a sample). A stage writes its counts as its work ends:
  after the march's trace, as the reflection is returned (`costPass` hands the value through), before
  the shade's return.
- The capture replays the frame's last draw (`worldView.lastRecorded`) twice on the state it left: the
  live stages into one G-buffer of the cost view's own, the counted stages into another. It compares
  the picture (S, D) with the box's tolerance and every other stage output a target holds (G0, G1: the
  march; O: the reflection) word for word. Any difference makes the result untrusted, naming the output.
- Each stage's counts are read back from that stage's texture. The result's `counters` are their
  per-pixel sum, and `stages.march`, `stages.reflect` and `stages.shade` keep each stage's own (stats
  over the same covered pixels, so the stage means add up to the total). `passes` names the three
  timed passes; the report puts the counts beside their summed time.
- The world's own readers are counted under the same names: cell reads are `wcCell` (the world copy),
  field taps `fieldTexL` (past its empty-level return) and `fieldFetch8`, and the sun ray's steps are
  `lcNext`'s iterations when `sunRayClear` asked for them (`gCostSun`), the near field's otherwise.
- `tools/check-cost-view.mjs` proves the same for every lit view and level of the world march (whole and
  each split stage), and that the three stages together count every counter.

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
| `gpuMs` | mean GPU time per run: its even share of the GPU's busy time (`exclusiveShares`), a lower bound |
| `ownMs` | mean GPU time per run: the union of its own intervals (every channel), time shared with other encoders included, an upper bound |
| `overlapWith` | the encoders that ran beside it longest, ms per run of this one |
| `channels.Vertex / Fragment / Compute` | mean GPU ms per run in each hardware channel. A render pass whose Fragment time dwarfs Vertex is pixel-bound |
| `spills.bytesMax` | the largest register spill reported for one shader run in this encoder (driver "compiler spill events"). Not zero means the shader ran out of registers and spills to memory |
| `spills.pipelinesPerEncoder` | spilling pipeline uses per encoder run. In timing split mode each dispatch is its own pass, so this names the kernel |
| `occupancy`, `limiters` | hardware occupancy and ALU / texture / memory limiter percentages. These stay **null on this Mac**, see below |
| `summary.top` | the most expensive encoders and their share of this process's GPU time |
| `summary.spilling` | encoders whose shaders spill, worst first |
| `summary.counterNote` | which counters the device streamed and why some fields are null |
| `summary.perfState` | the GPU performance state over the encoders' window (`shares`, `dominant`) and per pose tag (`byTag`), with `requested` and `enforced` |
| `summary.thermal` | the thermal state over the same window |

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

Adding Xcode's separate **Metal GPU Counters** instrument (`--instrument 'Metal GPU Counters'`, 2026-10-25) does not help: on top of the patched template the trace then has no counters at all (not even RT Unit Active), and on the Blank template its counter table names no device and stays empty. The tool doesn't add it. Some recordings stream no counter at all; `counterNote` says so.

Attaching and recording all processes give the same Metal tables, which are
system-wide either way, so the tool always filters to the pid.

## Capture (`--capture`)

A game map's capture boots slower under Apple's capture layer (Lab 12 s instead of 3.6 s), so it needs the lead's long slot: `TPT_LEAD_LONG_SLOT=1 node tools/profile.mjs --map lab --capture --no-cost --frozen --frames 12 --warmup 4` (Lab and Island worked, 2026-10-25). The heat maps come from the costliest draws by gpudebug's ranking, which may be a small warm-up draw rather than the full-screen pass.

Apple's own answer to "what does one pass cost and why" is a GPU capture replayed with one pass at a time on the GPU. `tools/gpu-capture.mjs` does it from the command line (Xcode 27.1's `gpucapture` and `gpudebug`; research/apple-metal/KNOWLEDGE.md 4A):

1. The browser launches through `tools/browser.mjs` with `MTL_CAPTURE_ENABLED=1` (`CAPTURE_ENV`, passed as `launchBrowser({ env })`) and `--disable-gpu-sandbox` (`CAPTURE_CHROME_ARGS`). Playwright's Chromium GPU process then shows in `gpucapture list`, with a Device boundary and its Metal queues.
2. While the page renders, `captureFrames` lists the boundaries twice 0.6 s apart, takes the queue that submitted the most (Dawn's), and captures 48 command buffers to `<out>/frame.gputrace` (a probe page: 1 s, 5 MB). Chrome did not hang after it.
3. After the browser closes, `analyzeCapture` replays under an exclusive GPU claim (`tools/gpu-log.mjs claim`): `profile run --exec serial --gpu-state high --embed` in one gpudebug session, then a second session loads the embedded profile (after `profile run` the first session's performance tree stays empty) and reads, per pass (encoders merged by label): cost share, serial duration, FS/CS occupancy, Occupancy Manager Target and every limiter; per shader: cost, temp registers, spilled bytes, instruction count and mix; the three costliest draws' heat maps (execution cost, thread divergence, instruction count) as PNG plus their top-100 JSON; every counter group's averages, with the occupancy series as JSON. All of it lands in `<out>/capture.json`. `--reuse` re-reads an embedded profile without the GPU.

Sample (the probe page, 2026-10-25):

```
GPU capture replay (serial: one pass at a time on the GPU, GPU state high; Apple's per-pass numbers, not the frame's overlap):
  pass                                cost      ms  occupancy   top limiters
  probe view                           84%   0.767   77%   F32 85% · Instruction Throughput 80% · Integer and Conditional 72%
  probe sim                            13%   0.117   69%   F32 68% · Instruction Throughput 60% · Compute Shader Launch 50%
  shader (pipeline · stage)                 cost regs  spill B  instr
  probe render · fragment                    84%   12        0     72
  occupancy over the capture: vs_occupancy 0.00% · fs_occupancy 54.27% · kernel_occupancy 8.03% · total_occupancy 62.29%
```

What stops it on the game: under the capture layer, Lab took 12 s to boot (3.6 s without) and still had 8 pipelines compiling, so the 25 s slot ended before the pipelines settled and no frame was captured. Agents can't use the long slot; the lead can: `TPT_LEAD_LONG_SLOT=1 node tools/profile.mjs --map lab --capture --no-cost --frames 12 --warmup 4`. It needs one such run before it goes to main.

### What a shader compiled to (`tools/capture-remarks.mjs`, CPU only)

A capture also keeps, for every pipeline, Apple's compile statistics with the GPU compiler's remarks, and the MSL source Dawn/Tint gave it (Tint's symbols renamed `v_N`). `node tools/capture-remarks.mjs <out>/frame.gputrace` lists the shaders (stage, instructions, registers, spill); `--instructions N` (a shader's count from `capture.json`) joins one shader's remarks to its source and prints the static instruction count per source function (each basic block counted at its first instruction's line, so an inlined body counts where it sits), the register copies, spills and reloads the allocator put in each loop, and the loop-invariant loads it could not hoist (they sit under a branch). `--msl out.metal` saves the source. No GPU and no replay: it reads the trace's files.

What it showed on the Lab's lean world march (2026-10-25, a capture of the tree just before a6ff8ede): 7,536 instructions, 3,282 of them the field reads (fieldQ's blocks: 33 a trilinear level, 206 an 8-tap cubic level); an empty-brick jump (`skipEmpty`) of 175 in one block, most of it the three i32 divisions by its node size (`(c / n) * n`, a run-time n: Tint's divide is a real one); Tint's u32 division (`a * Q / 127` in `wcShownId`) adds a volatile zero to the dividend, so even a constant divisor is a full divide (34–37 instructions, 6 inlined copies); the main loop carries 334–432 register copies a trip and 28 spills; and the grid's size (`WC.size`) and the field clip's level count are loaded inside the loop 12 times each, because every read sits behind a short-circuit `||`/`&&` (Tint lowers each to a branch).
