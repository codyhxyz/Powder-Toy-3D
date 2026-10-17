# Tick cost floor

Branch `lean/perf-floor` from `lean/integrate` (81f7393b). CPU-only work: these figures are byte counts from the code
at 128³ (N = 2,097,152 cells, B = 32,768 bricks of 4³, a 65,536-slot particle pool of 48 B), **not GPU timings**.
DRAM bytes are counted as each dispatch's footprint (an upper bound: small per-brick arrays may stay in the
system cache). Water (R13, jets) belongs to the column-water work and is listed apart. Watts use the brief's
model: about 30 pJ per DRAM byte at 60 ticks/s, so 1 MB/tick ≈ 1.8 mW.

## The formula

A tick costs `A·N + B·awake + C·changed + D·bricks + E·pool + F`.

| term | lean/integrate | round 1 | this branch | what it is |
|---|---|---|---|---|
| A, per grid cell | **24 B** (50 MB) | 0 | 0 | air `source` read every core and request word (20 B); blast `select` read every request word (4 B) |
| D, per brick | 344 B (11.3 MB) | 376 B (12.3 MB) | **60 B (2.0 MB)** | now only small words: the activity scan (8 B), cols (4), invalidate (4), the air source list (16), reach (16), windList (4), count (4), the event list (4) |
| C, per changed brick | (inside A) | ~1.3 KB on it and its 6 face neighbours | same | faces and vacuum read again from its 64 cores; requests read only where noted |
| air-active bricks | (inside D) | (inside D) | ~116 B source + ~80 B a reached substep, on listed bricks only | source, substeps, gas, couple and air activity run over GPU-built lists |
| E, pool | **6.8 MB every tick**, even with no particle | 0 without a launch request or live particle | same | the air tick's couple allocation read the whole pool twice |
| E', live particles | 12 MB while any particle lives | unchanged | unchanged | integrate/elect/impact/deposit sweep all 65,536 slots |
| B, per awake cell | ~100 B outside water (estimate) | unchanged | unchanged | support, block, column (whole awake columns) |
| F, fixed | 149 dispatches + 18 copies/clears outside water (water: 11, jets: 21) | 150 + 19 | 159 + 18 | 113 are the eight blast batches; ~121 are zero-size indirect when idle |

Round 1: noteState's per-brick word (every core store sets it) tells the air source which bricks' faces and vacuum to
read again; a per-brick request word (noteEvents) limits gas sources, the census and the first select; a one-thread
gate keeps the couple allocation off the particle pool. Round 2: a per-brick **air-live** word (clear: the brick's
air ended its last air tick settled and unchanged in both copies; noteAir for every other writer) and GPU-built
brick lists: source, the eight substeps (the reached bricks), gas, couplePlan, apply and air activity (live
bricks and their face neighbours) and the first select (noted bricks) run over lists whose args a one-thread
`listArgs` writes directly; count skips unlisted bricks. The activity pass runs over a scan's list: bricks near a
busy brick, or still counting their quiet run. Each step is exact: `tools/v2/air-cache-check.mjs`,
`air-reach-check.mjs` (an f32 twin of the listed air tick), `activity-list-check.mjs`, `allocation-check.mjs`
and `blast-batch-check.mjs` hold the proofs and their red variants.

One cost moved rather than vanished: a brick's quiet run counts on to its cap of 255 ticks after it sleeps, and
the saves keep that count, so every brick is in the activity list for ~4 s after a load or restore.

## The lower bound

An exact implementation must read every cell a rule can change this tick plus that rule's inputs, write what
changed, and learn which cells can change next tick. With `k` changed cells, `a` resting-or-not air bricks in the
acoustic reach and `p` live particles, roughly:

`bound ≈ k·(8 to 27 input cells × 20 B + 20 B written + a neighbourhood push of ~27 words) + a·~100 B + p·96 B`

plus one dispatch per dependent stage (import, lists, column, support, block, requests, liquid, 8 air substeps,
couple, invalidate: ~20) and **zero when nothing can change** (certified idle already records nothing). Nothing in it
scales with N or B: a still brick need not be touched.

## Three scenes (per tick, outside water)

| scene | lean/integrate | round 1 | this branch | bound | V1 |
|---|---|---|---|---|---|
| one grain falling in a still world (~30–60 awake bricks, ~9 awake columns, still air, no particles) | **69 MB** (68 + ~0.5 awake), 149 dispatches | 12.8 MB, 150 | **~2.5 MB** (2.0 + ~0.5 awake), 159 | ~2 KB, ~20 | 1.1 MB |
| lab, ~25 % awake, ~10 % of bricks changing, particles live | 68 + 19 MB + awake and substep terms | 12.3 + 13 + 19 MB + same | 2.0 + 13 + 19 MB + same (air work now only on listed bricks) | ∝ changed cells | — |
| everything awake and changing, few requests, particles live | 68 + 19 MB + awake terms | 47 + 19 MB + same | ~47.5 + 19 MB + same (every list full; +0.5 MB of list words) | ∝ N | — |

Watts, scene 1 (bytes only): 124 mW before, 23 mW after round 1, **~4.5 mW now**, V1 ≈ 2 mW, the bound ≈ 0. Scene 1 is now
2.3× V1 by bytes. The awake share (~0.5 MB) is mostly the column pass reading the full 128-cell height of each
awake column.

## The remaining gap, ranked (scene 1, this branch)

1. **Fixed dispatches: 159 a tick, ~121 zero-size indirect when idle** (103 in the blast batches, 8 air
   substeps, gas, couplePlan, apply, activity, the couple chain). Each costs a recorded command and, in Chrome,
   a validation dispatch. With bytes at ~2.6 MB this is probably the largest remaining cost; it is unmeasured
   (at an assumed 2 to 5 µs each it is 0.2 to 0.6 ms a tick). Closing it: one blast batch a tick at the same
   service rate (a behaviour change, the user's call, removes ~98); merging adjacent one-thread stages
   (listArgs ×4, actArgs, coupleGate, workArgs, args); skipping a recorded subsystem needs a GPU-to-CPU
   signal the CPU does not have.
2. **All-brick scans of small words, 2.0 MB (3.6 mW).** Air: the source list builder, reach ×3, windList, count
   and the event list (1.44 MB); grid: the activity scan, cols and invalidate (0.52 MB). Closing it: push the
   lists instead of scanning (append on a word's 0 → 1 change in markBusy, noteState, noteEvents and noteAir),
   dilate reach by scattering over the start list, make cols and invalidate list-driven.
3. **The column pass reads whole columns**, 128 cells per lane for each awake brick column (~32 KB each,
   ~0.3 MB here). Restricting it to the awake bricks' heights plus a falling run's reach makes it ∝ awake.
4. **The particle pool, 12 MB (+6.8 MB of couple preparation) while any particle lives**: ∝ capacity, not live
   particles. A per-64-slot live mask kept by every spawner and retirer needs the column-water branch (jets).
5. **A noted brick re-reads its 64 cores** (~1.3 KB) even when one cell changed. An incremental update needs
   integer sums: the f32 summation order is part of today's bits, so that would be a behaviour change.
6. **holdCOM** loops over 65,536 slots in one thread while the physgun holds; a parallel reduction fixes it.

## What to measure on the GPU

Split timings of the air tick, the first select, the couple chain, the activity scan and the zero-size
dispatches in scene 1 at 128³ on both branches; the cost of one zero-size indirect dispatch in Chrome and Safari;
and a bit-identity A/B of cells, banks, both air copies, particles and control words 0–31 after N ticks against
lean/integrate with the wake fix (`a000f667`) applied to both sides. Leave out the activity buffer's state
words (transient here, sticky there) and everything past the saved words.
