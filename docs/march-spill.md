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

The big lever is the 576 B ceiling. A run without the heavy bodies drew Lab at 60 fps instead of 30, with a
different picture. Reaching it exactly takes **splitting the stage**:

- A lean traversal pass does the DDA, the occupancy, crisp hits, smooth-surface crossing tests and gas skipping.
- It stops at the first rich event (liquid surface, glass or source pane, crystal, media brick) and writes its
  state to the G-buffer, as the march → reflect → shade split already does.
- An event pass resumes from there.

A ray that meets several events needs either a bounded loop of these passes or an event queue. This is a
design change in the march itself. It belongs to the march's owner (the big-map lead is editing march.js and
worldView.js now) and is not part of this investigation.

## Cost of this investigation

10 headless slots, 113 s of GPU occupancy (each slot ≤15.4 s):

- 2 plain runs, 1 bounds-check run and 3 variant runs gave results.
- The rest failed on a cold pipeline cache: the robustness switch changes Dawn's cache key, and
  `v2particles_react` takes about 10 s to compile cold. One more failed because xctrace didn't finish saving
  its trace in 180 s.

Ran to 10 slots against the planned 6–8: the extra re-baseline was needed to show how far the ms drift.
