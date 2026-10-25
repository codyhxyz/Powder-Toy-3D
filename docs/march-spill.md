# World march stage: where the register spill comes from

2026-10-25, Lab, Apple M5, `tools/profile.mjs --map lab --no-cost` (default pose, 1280×800 @2x, scene ×0.667,
detail Balanced, shaders f16+subgroups). Every number here is from a `PROFILE (trusted)` report: Metal per-encoder
ms and Metal's compiler spill events. Base origin/main f0e48e36, then 6c40feaf.

The march stage (`world march`, shaders/world/march.js stage `march`) spills **752 B per thread**. The shade stage
spills 704 B, and the scene pass 320 B.

## How to read the ms

Spill bytes are a property of the compiled pipeline. Every run of the same code gives the same spill, so spill
deltas are exact.

Stage ms drift a lot from run to run. Two plain runs 25 minutes apart measured the march at 10.51 ms and 6.66 ms,
and the whole frame's Metal time at 27.9 ms and 22.4 ms, with the same code and pose. One run's encoders spread
about ±15% (p10–p90). So compare a variant's ms only with the plain run nearest in time (`base2`, taken right after
the variants). A difference under about 30% is noise. The variants also change the picture (a stubbed path draws
something else), so their ms are only an upper bound on what an exact fix could save.

## Bounds checks (Dawn robustness)

| run | march spill | shade spill | march Metal ms [p10–p90] | frame Metal ms |
|---|---|---|---|---|
| plain (`base`) | 752 B | 704 B | 10.51 (no spread: profiler predates it) | 27.9 |
| `--chrome-arg --enable-dawn-features=disable_robustness` (next run) | 704 B | 640 B | 10.03 [9.51–12.00] | 29.2 |

Turning the bounds checks off saves 48 B of march spill and 64 B of shade spill. This also proves the switch
reached Dawn. The march gets 0.48 ms (5%) faster, inside one run's spread and far inside the run-to-run drift, while
the frame got slower. **The bounds checks are not where the spill or the time goes.** They are not worth an unsafe
switch. (This is the trusted rerun of the earlier untrusted "no difference" result.)

## Stub variants (local only, never merged)

Each variant swaps call sites in the march stage's WGSL for a stub. The variants live on branch
`perf/march-spill-variants` (`src/shaders/world/marchVariant.local.js`, selected with
`VITE_MARCH_VARIANT=a+b`). The picture is wrong in every variant.

| rank | candidate (what the stub removes) | spill removed | march Metal ms vs `base2` 6.66 | frame GPU span vs 25.7 ms | exact-preserving fix |
|---|---|---|---|---|---|
| — | **every heavy inlined body**: crystals + liquid interface + media + glass + liquid normal/detail + sun shadow + absorption | **576 B** (752 → 176) | 5.03 (−1.6, −25%) | 16.5 (60 fps instead of 30) | the ceiling. See "Recommendation" |
| 1 | **media + glass + in-loop sun shadow** (not run alone; all minus the two runs below, assuming they add up) | ~368 B | – | – | one call site per heavy lookup (see below); glass/source panes and media bricks as deferred events |
| 2 | **liquid path**: `liquidInterface` at the loop head, `surfNormal` + `liquidRipple` + `liquidDetail` at the event, `absorbDeco` per segment | 112 B (→ 640) | 6.15 (−0.5, noise) | 22.8 (−2.9) | move the event's normal, ripple and detail into the loop-head `ifPend` block next to `liquidInterface`. The block then takes `ifG`, not `ifN`, and every liquid-surface body has one inlined copy |
| 3 | **crystals**: `crystalHit` → `shardHit`/`crysShard`, `crystalInterface` | 96 B (→ 656) | 6.17 (−0.5, noise) | 25.3 (noise) | `gCrys` (a `Shard`, about 30 words) is a `var<private>`, so it survives the loop's back edge although only `crystalInterface` reads it, right after `crystalHit` writes it. Return the shard from `crystalHit` into a loop-body `let` and pass it on. Also the crystal path's own `sunShadowAt` copy (rank 1) |
| 4 | Dawn bounds checks | 48 B | −0.48 (adjacent run) | – | none needed |
| 5 | what is left (176 B): state carried round the loop, dynamic vector indexing | ≤176 B | – | – | not measured (the `dyn` variant is built but was not run). See the count below |

### What the code shows (CPU only: generated WGSL, call graph)

- **State carried round the march loop.** `traceView` declares about 85 words of locals that the loop updates:
  the DDA (ro, rd, istp, tDelta, cell, tMax), col, trans, the 9-float pending liquid interface (ifP, ifN, ifG) and
  its flags, phiA, mediumLight, lightRef, paneEnv, the brick cache, and more. Inlined callees add about 76 words of
  `var<private>`: `gCrys` (30), `gRefl*` (15), the fields' level and pick (6), the eye and its derivatives (14),
  `gLiqSlope*` (4), and others. That comes to about 160 words (640 B) live at the back edge, already past what a
  thread holds in registers. That's why removing code alone leaves 176 B of spill.
- **Inlined copies.** Every call site is inlined. From `fs`, the march stage holds about 430 k characters of WGSL:
  `sunShadowAt` (8.5 k each, with cloud density and caustics) has 6 copies (4 in `traceView`, 1 in
  `liquidInterface`, 1 in `crystalInterface`), and `surfSample` has 7. The largest single bodies are
  `liquidDetail` 49 k, `mediaSegment` 46 k, `liquidInterface` 40 k, `crystalInterface` 40 k, `surfNormal` 26 k,
  `filmHit` 21 k and `crispHit` 19 k. A spill peak forms where one of these is inlined while the carried state
  is live.
- **Not the cause:** module constant arrays (`WC_LIFE_FULL`, `CRYS_HEX`, `CAP_*`) go to the `constant` address
  space, not the stack. No other function-local arrays are reachable from the march.

## Recommendation

Do these first. They are small and exact:

1. **Crystals:** make `gCrys` a local handed from `crystalHit` to `crystalInterface`. This removes about 30 carried
   words, up to 96 B of spill.
2. **Sun shadow:** give `sunShadowAt` one call site in the march loop, through a pending point evaluated at the loop
   head (the `ifPend` pattern the liquid interface already uses). Today it has 6 copies.
3. **Liquid event:** move its normal, ripple and detail into the `ifPend` block.

Expected gain together: an estimated 100–250 B of spill and ≤1 ms of the march (≤5% fps on Lab). The ms are too
noisy to promise more, so measure each change on its own with `--compare`, in back-to-back runs.

**Done (2026-10-25), see "The three exact fixes" below: 752 → 544 B.**

The big lever is the 576 B ceiling. A run without the heavy bodies drew Lab at 60 fps instead of 30, with a
different picture. Reaching it exactly takes **splitting the stage**:

- A lean traversal pass does the DDA, the occupancy, crisp hits, smooth-surface crossing tests and gas skipping.
- It stops at the first rich event (liquid surface, glass or source pane, crystal, media brick) and writes its
  state to the G-buffer, as the march → reflect → shade split already does.
- An event pass resumes from there.

A ray that meets several events needs either a bounded loop of these passes or an event queue. This is a
design change in the march itself. It belongs to the march's owner (the big-map lead is editing march.js and
worldView.js now) and is not part of this investigation.

## The three exact fixes (2026-10-25)

Base origin/main a03e50b0, Lab default pose, `tools/profile.mjs --map lab --no-cost`, four runs back to back
(base, then each fix on top of the one before), every one `PROFILE (trusted)`. Spill is Metal's compiler spill
event for `world march@0`. The shade stage stayed at 704 B and the scene pass at 320 B in all four.

| state | march spill | march Metal ms [p10–p90] | frame GPU span |
|---|---|---|---|
| base | 752 B | 9.33 [8.87–11.10] | 28.7 ms |
| 1. crystal piece a local (f0dd21d2) | **656 B (−96)** | 6.73 [1.02–8.74] | 25.4 ms |
| 2. one sunShadowAt for lightRef (c8a23737) | 656 B (0) | 10.55 [9.31–13.63] | 30.4 ms |
| 3. liquid event's bodies at the loop head (e77fa291) | **544 B (−112)** | 6.03 [0.00–8.88] | 25.1 ms |

- **Spill: 752 → 544 B (−208 B, −28%)**, exactly the doc's estimates for the crystal (96 B) and liquid (112 B)
  paths.
- **The ms are noise.** The runs alternate slow, fast, slow, fast (9.3, 6.7, 10.5, 6.0 ms) with fix 2 changing no
  spill, which is the run-to-run drift above, not the fixes. In runs 1 and 3 a few march encoders read about
  0 ms, which pulls those means down. Compare the p90s instead: 11.1, 8.7, 13.6, 8.9 ms. No ms gain is claimed.
- **Fix 2 removed no spill.** `lightRef`'s three points (the box wall, a quiet entry into liquid, a surface met
  with the bends spent) now keep the point and look it up once, in the liquid segment that reads it. That takes
  two of the ten inlined `sunShadowAt` copies out of the march stage (its fully inlined size goes 471 k → 455 k
  characters). Kept for the smaller module, and because fix 3 builds on it.
- **Exactness.** The checks were same-pose `test.render()` converged frames, TAA off, view clocks reset, and one
  captured frame each, at 960×600. Lab (map home and looking down): fixes 1+2, and all three, are byte-identical to base.
  Island (home): both differ from base only inside the shrine's display (meshes whose items vary
  run to run). A repeat of the same frame within one run already differs by about 2.8 kB there. The march's
  pixels match.
- **One trap.** The first version of fix 3 resampled the event's `phiB` at the head (`surfSample` at the same
  point, in the same brick). That drew a 4-pixel orange line on Lab's pool edge. Keeping the event's own `phiB`
  (and setting the resume at the event) made it byte-identical. Treat a "recompute the same value" step at a
  grazing surface as not exact.
- **Stage text.** Only the tracer changed: the march stage, the whole march and the box's volume. The reflect and
  shade stages' WGSL is byte-identical, so their pipelines stay cached. No box WGSL hash check needed a rebaseline
  (`field-deriver-cpu-check` passes). `volume-format-cpu-check` already failed on base (its prelude `ro` hash).
  Text-pinned CPU checks updated: `check-crystal-transmission`, `check-opaque-surface`, `v2/foam-render-check`,
  `v2/liquid-interior-check`.

What is left (544 B) is the structural split's: glass and source panes (two `sunShadowAt` copies with their
consumers right after), `mediaSegment` (two), `liquidInterface`, `crystalInterface` and `liquidDetail` (one each),
and the state carried round the loop. A lean traversal pass plus an event pass would take all of them out of the
loop, as "Recommendation" above says.

Cost: 9 headless slots, about 94 s of GPU occupancy (4 profiles of about 9 s, 5 shot runs of 7–21 s; one shot run
hit the slot deadline on Island's look-down pose, which the later runs dropped).

## Cost of this investigation

10 headless slots, 113 s of GPU occupancy (each slot ≤15.4 s):

- 2 plain runs, 1 bounds-check run and 3 variant runs gave results.
- The rest failed on a cold pipeline cache: the robustness switch changes Dawn's cache key, and
  `v2particles_react` takes about 10 s to compile cold. One more failed because xctrace didn't finish saving
  its trace in 180 s.

Ran to 10 slots against the planned 6–8: the extra re-baseline was needed to show how far the ms drift.

## The split into a lean march and an event stage (2026-10-25, branch `perf/march-split`, not merged)

Base origin/main e7bbc239. Built, exact, measured. **It is not faster**, so it stays on the branch.

### Design

- **`world march` (the lean loop).** It is the same loop as before (shaders/render.js `realistic`, split
  `'lean'`), with every rich event's body replaced by a stop: crystals, glass and source panes, a
  liquid's quiet entry, a liquid surface met, a film, and any brick holding media. It still does the DDA,
  the occupancy, crisp hits, the smooth-surface crossing tests, the empty-cell fast path and the floor.
  It stops at the start of the iteration that meets a rich event, after the brick is entered and before
  the event changes anything. Before a ray's first rich event nothing is gathered (col 0, trans 1, out
  of liquid). So a lean pixel's G-buffer needs no G2 write: its G2 words go in G1 instead, flagged
  `GB_LEAN`. The lean stage then has one storage texture, and the cost view still fits under the
  device's 4.
- **The record.** K is one `rgba32uint` texture with 3 layers, one binding. It holds 12 words: the
  cell (packed), ax, phiStale, the kind, the iteration number, F's pick and its blend, tEnter, tMax,
  and phiA. Every float is stored as its bits, and phiA is never resampled (the trap above). With 3
  separate textures the event stage would hold 17 textures, past the 16 limit.
- **The gate.** Z is a `depth16unorm` target. The lean march writes depth 0 where it stopped and leaves
  the clear value 1 elsewhere. The event stage draws at depth 0.5 with the test `greater` and no depth
  write, so the GPU's early depth test launches it on event pixels only. This acts as the compaction.
  An earlier version used a per-draw stamp in K that every pixel read, and cost the same.
- **`world event` (continuation).** This is the whole loop (split `'resume'`), restarted from the
  record: the iteration, the DDA state, F's pick, phiA, and the brick read again. It traces the rest of
  the ray itself, every later event included. A ray stopped at its start (the box wall into liquid, or
  the eye inside liquid) is traced from its start. Bounded rounds of lean and event passes were ruled
  out on the code: a ray through smoke has a media event in every cell, and up to `MAX_BENDS` surfaces
  plus its panes. Each round would also move the loop's ~85 carried words through memory for every
  pixel.
- Reflect, shade and composite are as before. Shade reads G2 from G1 for `GB_LEAN` pixels. The
  G-buffer grows from 100 to 150 B/pixel.

### Spill (Metal's compiler spill events: exact)

| stage | before | after |
|---|---|---|
| world march | 544 B | **112 B** (lean) |
| world event | – | 544 B (560 B in the stamp version) |
| world shade | 704 B | 704 B |
| scene | 320 B | 320 B |

The inlined size from `fs` (call graph over the generated WGSL) is about 101 k characters for the lean
march, against about 455 k before. The lean march holds no `sunShadowAt` and 5 `surfSample`. The event
stage is the old march plus the resume.

### Time (Metal per-encoder ms, back to back, `tools/profile.mjs --no-cost`)

| run | pose | world march | world event | march + event | world stages | Metal ms/frame |
|---|---|---|---|---|---|---|
| base e7bbc239 (trusted) | Lab default | 9.40 [8.59–10.86] | – | 9.40 | 11.93 | 25.59 |
| split + gate (trusted) | Lab default | 2.04 [0.78–2.66] | 8.70 [0.00–13.33] | 10.74 | 12.70 | 21.22 |
| base (untrusted: a screen saver held the GPU at 33%) | Lab default | 11.23 | – | 11.23 | – | 30.04 |
| split + stamp (same screen saver) | Lab default | 2.89 [2.38–3.50] | 9.44 [4.48–12.48] | 12.33 | – | 26.12 |
| base (trusted) | Island default | 3.40 [0.00–11.40] | – | 3.40 | 4.42 | 10.92 |
| split + gate (trusted) | Island default | 2.31 [0.00–5.54] | 3.51 [0.00–8.52] | 5.82 | 7.29 | 14.85 |

- **The event stage costs what the old march cost.** On Lab it takes 8.7–9.4 ms against the old march's
  9.4–11.2. Lab's time is in the pixels that meet the glass tank and its water. Those pixels still run
  the 544 B pipeline, through the same bodies, so they cost the same.
- **The lean march is not much faster per step.** On Island its 112 B pipeline takes 2.3 ms, against
  3.4 ms for the old 544 B one doing the whole ray. The spill was not what made the traversal slow.
- The scene totals are within the drift above. The Metal frame total differs mostly in the scene pass
  (8.05 vs 2.44 ms), which this change doesn't touch. The p10s of 0 ms are the encoders that read about
  0 ms, as noted under "The three exact fixes". March plus event is about 1.3 ms (Lab) and 2.4 ms
  (Island) **more** than the old march. No ms gain is claimed, and there is no fps gain.

### What this says about the 576 B "ceiling"

The stub run's 60 fps came from **removing the heavy bodies' work** on the pixels that meet them
(sunShadowAt with its cloud density and caustics, liquidDetail, mediaSegment, the panes' lighting). It
did not come from lowering the register pressure on the other pixels. An exact split keeps that work,
so it can't reach that ceiling. The lever is the cost of those bodies themselves: fewer `sunShadowAt`
evaluations per event pixel (one per segment, not per face), cheaper shadow taps inside liquid and
glass, and `liquidDetail` and `mediaSegment` at lower sample counts where a pixel's footprint allows.
Each has to be measured as a picture change, not as exact.

### Exactness

Same-pose `test.render()` frames, TAA off, view clocks reset, 960×600, the base build (its own
worktree) against the split, back to back:

- Lab looking down: byte-identical.
- Lab default (glass tank, water, oil, ice, lava): 6 of 576,000 pixels differ, by at most 1/255. They
  sit on the sand pile and the snow block, smooth opaque surfaces the lean march draws alone. Cause:
  float noise. The same WGSL compiled in a module a quarter the size (the lean march), and a shade
  stage whose prologue changed, get different fused multiply-adds from Metal. Every pixel that meets
  water or glass matches.
- Island: not captured. The slot budget went on the timing runs.

The event stage's loop text was compared with the old march stage's: it is identical apart from the
resume block and `var i` moved outside the loop. Also checked: naga on every stage (optics and lean),
`check-wgsl --file world/march --no-build` (Tint, binding budgets: event 3/4 storage textures, lean
1/4), `check-wgsl-operators`, `check-cost-view` (6 split marches, 4 stages), `world-march-cpu-check`,
`check-crystal-transmission`, `check-opaque-surface`, `v2/foam-render-check`,
`v2/liquid-interior-check`, `field-deriver-cpu-check`.

Cost: 12 headless slots, about 165 s of GPU occupancy. 4 profiles of 9–13 s; 4 shot runs of 4–21 s
(one failed on a first-load Vite reload); 2 `check-wgsl` runs, one of which was the full suite by
mistake (21 s, hit the deadline).

## Event kernels, and why the split's gate never gated (2026-10-25)

Branch `arch/wavefront` (shaders/world/march.js "The event kernels"; Laine, Karras & Aila 2013).

**The gate.** On the Apple M5 through Dawn/Metal, a fragment shader that may `discard`, or that writes a
storage texture, gets its depth and stencil test after it runs (WGSL has no `early_fragment_tests`). The
split's event stage did both, so it ran its whole loop on every pixel the full-screen triangle covered, and
the depth gate only threw the results away. Measured on the Lab with the fat stage behind a stencil test
that never passes: 14.7 ms with its storage writes and discards, 14.7 ms with the discards removed, 0.3 ms
with neither. That is why the split above was slower, not the heavy bodies' register use alone.

**The fix.** The gated stages (the kernels and the fat stage) write the G-buffer as colour targets
(G0, G1, G2, R0, R1 and a kernel's abort mark M: 81 B a pixel, so the device asks for up to 128 B; a device
with WebGPU's default 32 draws the one-pass march), and never discard. A kernel marks the rays it aborts
(M); a re-gate pass of a few instructions moves those pixels' depth to the fat stage's. The lean march's
depth per first-event body picks the kernel. `tools/world-march-cpu-check.mjs` refuses a gated stage that
discards or writes storage.

**Measured** (whole-frame GPU span and interval, `tools/profile.mjs --no-cost --no-counters`, main 115e72ee
and the branch back to back, port 47913):

| map, pose | main span / interval | branch span / interval |
|---|---|---|
| Lab default | 35.4 / 33.4 ms | **24.9** / 33.3 ms |
| Island default | 27.0 / 33.3 ms | **22.1** / 33.3 ms |
| Island landDown | 79.5 / 83.3 ms | **67.5** / 66.7 ms |

Knockouts (bounds only): Island default, the liquid kernel 4.7 ms and the fat stage 0 (the sea is all
liquid-first); Lab default, the fat stage 8.9 ms (the tank's rays meet glass first, smoke is media: no
kernel takes them yet), the liquid kernel ~0.

**Packing.** Half the Island default's liquid pixels sent to the fat stage as a block vs a checkerboard:
span 22.0 vs 24.2 ms, the gated work ~3.2 vs ~4.5 ms. A gated fragment pass leaves rejected lanes idle
in their groups: scattered pixels cost ~40 % more. Not decisive yet; a compute pass over a packed list
(the paper's queues) would recover it, but the tracer uses dpdx/fwidth (7 sites) that compute lacks.

**Exactness** (`test.renderOnce({ capture: true })`, TAA off, view reset, 960×600, main vs branch):
Lab looking down and Island looking down byte-identical; Lab default 12 px off by 1/255 (sand, brick,
snow: float noise); Island default 489 px, all in the shrine's display and two mesh specks, where main
against main differs by 397 px (its items vary run to run).

**Adding a kind:** one entry in `EVENT_KINDS` (key, takes: first-event bodies not taken by another kind,
keep: the bodies its loop compiles). The stage, pipeline, layout, gate depth, cost twin and warm-up follow.
Next by measured cost: a glass kernel (takes glass, keeps glass and liquid: the Lab tank) and a media
kernel (takes media).

## Smoke: the efficient media march (2026-10-25, branch `perf/smoke-efficient`)

Off and Balanced march gas the efficient way (`shaders/gfx/mediaDetail.js` "the efficient march"); Full
(`DETAIL_MEDIA_FULL`) keeps the old march, its WGSL code identical to before (only the header comment differs).
Lab smoke box (`--setup` smoke-setup, `--frozen`, Balanced, 2560×1600 at ×0.667), whole-frame GPU span:
origin/main 49.1 ms, branch 31.7 ms; the Lab without gas ~18–20 ms. Where the rest goes, by stubs (local only):
- mediaSegment returning at once (no integration): 26.9 ms. So ~5 ms is the integration and ~7–8 ms is the
  fixed cost of those pixels leaving the lean march for the fat stage. Sampling can't remove that part.
- step 4 cells and light every 4 samples: 28.4 ms (-3.3 ms for half the samples): not worth the noise.
- What bought most: a brick of gas alone is one media segment and one DDA jump (render.js), not 4-7 cell
  iterations of the fat loop (41.7 → 31.7 ms on its own).
- A lattice jittered over 1 cell while the step is 2+ draws terraces (sheets): the efficient lattice
  restarts each run of gas at the ray's jitter times its own step.


## Far view: mixed resolution at Off and Balanced (2026-10-25, branch `perf/far-efficient`)

Big maps' far view (`shaders/far.js` `FAR_MIXED`, `world/far.js` drawPass) draws a quarter of its pixels at Off
and Balanced: pass `far view low` at half size each way (colour, the hit's distance in alpha), then `far view` at
full size takes the bilinear colour where the four samples around a pixel are within 1/16 of each other's
distance, and shades the rest (silhouettes, the window box's faces) in full (Cantlay, GPU Gems 3 ch. 23). Full
(`DETAIL_FAR_FULL`) draws as before: its WGSL is byte-identical to origin/main 03b045db.
Island, `--frozen --detail balanced`, back to back, whole-frame GPU span: default 20.19 -> 17.89 ms, horizon
11.07 -> 8.93 ms. Exactness at Full (same-pose stills, TAA off, 960x600): sky byte-identical; default and horizon
differ from origin/main by the same near-window pixels two origin/main runs differ by (38.6 k vs 38.6 k, 3.8 k vs 3.8 k).
What Balanced gives up, visible in TAA-off stills: texture and material boundaries on distant ground and in the
clouds are two pixels soft (TAA's jitter sharpens them live); edges between surfaces stay full resolution.
Not done: skipping far shading where the window's march covers the pixel (the window's G-buffer depth would need a
binding the view no longer has: its fragment stage holds WebGPU's 16 sampled textures and its 8 storage buffers).

## The lean loop's cost per step (2026-10-25, perf/lean-loop)

Base origin/main 729778e1. The lean march was 26–31 % of the frame (Xcode capture replay: 7,536 instructions, 126
registers, top limiters Integer & Conditional 71 %, Control Flow 50 %). `tools/capture-remarks.mjs` (docs/profiler.md)
read what that shader compiled to from the capture's own compiler remarks. The Lab's cost view put 19 of a pixel's 35
loop trips in empty-brick jumps (`brickSkips`), and a jump was the costliest trip there is:

- **An integer divide in every jump.** `skipEmpty` rounded the cell down to its empty node with `(c / n) * n`, n a
  run-time 4, 16 or 64: three real i32 divides (Tint's divide, with its zero/overflow selects). Now `c & -n` (n a
  power of two, c in the grid at every caller).
- **The loop's head and its carried state around every jump.** The main loop carries 334–432 register copies a trip
  (the remarks' `LoopSpillReloadCopies`). A run of empty bricks is now walked in a small loop of its own at the brick
  entry (shaders/render.js, the twin of the world march's airWalk): jump, then enter the next brick, each a trip of
  the count (`i`), after the next trip's head checks (cap, edge, cut); it ends at a brick with something in it,
  entered, or where the head would stop the march, which it then does.
- **F's pick at every empty brick.** `fieldPickAt` ran at every brick entered. Only a field sample reads the pick, and
  an empty brick samples nothing, so it is owed (`pickOwed`, `pickT`): taken after the loop at the same point when the
  ray ends past the empty brick (the floor, the cap), and never otherwise (shaders/world/march.js traceWorld).
- **Branches for every `||` and `&&`.** Tint lowers a short-circuit to a branch, and the compiler then cannot hoist
  the loads behind it (the remarks: the grid's size loaded 12 times in the loop). The hot tests are now one compare
  each (`outside`, `wcInWorld`, `wcInfo`: one unsigned compare; the fast path, the airWalk and the head: `&`/`|`), and
  the step cap is read once before the loop.
- **Dynamic vector indexing.** `cell[ax] += istp[ax]` and its kin (ddaStep, the fast path, the airWalk, ddaJumpBox)
  are now selects on the axis mask (`axisMask`).
- **Tint's u32 divide.** It makes the dividend volatile, so even `a * Q / 127` (a part-full liquid's dither in
  `wcShownId`, 6 inlined copies of 34–37 instructions) is a full divide: now the same test as `a·Q < 127·(r + 1)`.

Per-trip work, counted on the generated WGSL (operations, not Metal instructions; Tint's loop guard left out):
an empty-brick jump about 430 → 250, a crisp-only cell step about 130 → 100, an airWalk step about 70 → 45. The
surface trips (field samples: 33 instructions a trilinear level, 206 a cubic one) are unchanged.

Exactness: the DDA helpers against base on 400 random rays × 24 steps and jumps (wgsl_reflect's interpreter, ties
included; a tie flipped as a negative control changes 192 values): identical. Converged same-pose frames (TAA off,
view clocks reset, frozen from boot, 960×600): Lab default and looking down, Island looking down byte-identical;
Island default differs in 85 px, all on the shrine's display items, which vary run to run. (A first run of base
against a second run of base differed in 59,453 Lab px by 1/255, in the tank; the branch matched the second
exactly.)

Time (`tools/profile.mjs --no-cost --no-counters --frozen`, base 729778e1 and the branch back to back, on battery,
one run each; per-pass timestamps were untrusted, whole submissions): whole-frame GPU span Lab default 17.35 →
16.77 ms (−3 %), Island default 20.14 → 19.97 ms (−1 %, within noise). Less than the per-trip counts promised: the
jumps' arithmetic was not the bulk of the frame. The 12 ms target needs the shade, reflect and event stages too.

## The shade stage: where its time goes, and a quarter-rate probe that didn't pay (2026-10-25, perf/shade-efficient)

Base origin/main 5b46d837. Lab default, `--frozen --detail balanced`, 2560×1600 at ×0.667, Apple M5, on battery. The
shade stage's own cost is what `--knock "world shade"` saves of the whole-frame GPU span, one run per row; the
stubbed variants (local only, never merged) change the picture.

| shade stage variant | span ms | shade knocked out saves |
|---|---|---|
| as on main | 15.56 | 2.07 |
| Contact Shadows and Lava Lights off (settings: nearField, glowLightScale) | 16.01 | 1.66 |
| material stubbed (planMat: flat albedo, no bump) | 14.38 | 0.83 |
| lighting stubbed (sun shadow, probe, near field, glow, lamps) | 14.38 | 1.08 |
| sun shadow stubbed | 14.93 | 1.78 |
| surface probe stubbed (lcOpenProbe) | 15.12 | 1.26 |
| everything stubbed (the G-buffer reads and the frame of the stage) | 13.42 | 0.17 |

- **The materials are the larger half** (planMat: procedural noise, cellular chips, the scanned textures), the
  lighting the rest. The near field and the glow's direction are within noise. The G-buffer itself is not the
  cost (0.17 ms with everything stubbed).
- **A knocked-out stage's saving moves ±0.4 ms from run to run** (the same build read 2.07, 2.33 and 2.23 ms), so
  single-variant rows are rough; the probe row's 0.8 ms did not hold up (below).
- **Tried: the surface probe at a quarter of the pixels** (branch `perf/shade-efficient`, d5305078). A half-size
  `world probe` stage looks the probe up for the top-left pixel of each 2×2 block (P: rgba32uint, 2 layers, its 16
  values as f16) and the shade averages the blocks around a pixel whose point lies within 1 cell (or 4 footprints)
  of its own (Cantlay, GPU Gems 3 ch. 23). The picture matched main within 1/255 at Balanced (Lab default and
  looking down); Full's WGSL is byte-identical. **No gain:** span Lab 15.26 → 15.52 ms, Island 17.38 → 17.22 ms
  (back to back, noise); the shade still costs 2.2–2.3 ms knocked out, the probe stage 0.13 ms; dropping the
  shade's own fallback lookup (one `probeAt` copy fewer) changed nothing either. The probe's texture reads were
  never the cost; the stubbed row's gain was noise or the constant probe's folding. Not merged.
- What is left to try, by these rows: the material plan's cost per pixel (mCell's 27-cell search is 5,345 of the
  stage's 46,332 static instructions, `tools/capture-remarks.mjs`), and the stage's register pressure (126
  registers, 704 B spill: `capture-remarks` puts 651 register copies in the lamps' loop and 210 in the loop at
  the sun's soft-shadow taps). Measure each by its own A/B with several runs a side, not one knockout.

Cost: 16 headless slots, about 230 s of GPU occupancy (5 variant runs lost to a slot held by another session or a
cold compile past the deadline).
