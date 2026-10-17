# Tick cost floor

Branch `lean/perf-floor` from `lean/integrate` (81f7393b). CPU-only work: these figures are byte counts from the code
at 128³ (N = 2,097,152 cells, B = 32,768 bricks of 4³, a 65,536-slot particle pool of 48 B), **not GPU timings**.
DRAM bytes are counted as each dispatch's footprint (an upper bound: small per-brick arrays may stay in the
system cache). Water (R13, jets) belongs to the column-water work and is listed apart. Watts use the brief's
model: about 30 pJ per DRAM byte at 60 ticks/s, so 1 MB/tick ≈ 1.8 mW.

## The formula

A tick costs `A·N + B·awake + C·changed + D·bricks + E·pool + F`.

| term | lean/integrate | this branch | what it is |
|---|---|---|---|
| A, per grid cell | **24 B** (50 MB) | **0** | air `source` read every core and request word (20 B); blast `select` read every request word (4 B) |
| D, per brick | 344 B (11.3 MB) | 376 B (12.3 MB) | activity, cols, invalidate; air source/reach/step/gas/couplePlan/count/apply/activity each read the brick's 32 B air state |
| C, per changed brick | (inside A) | ~1.3 KB, on it and its 6 face neighbours | faces and vacuum read again from its 64 cores; request scan only when it holds one |
| E, pool | **6.8 MB every tick**, even with no particle | 0 without a launch request or live particle; 6.8 MB otherwise | the air tick's couple allocation read the whole pool twice (freeCount, freeScatter) |
| E', live particles | 12 MB while any particle lives | unchanged | integrate/elect/impact/deposit sweep all 65,536 slots |
| B, per awake cell | ~100 B outside water (estimate) | unchanged | support, block, column (whole awake columns) |
| F, fixed | 149 dispatches + 18 copies/clears outside water (water: 11, jets: 21) | 150 + 19 (the couple gate and its args copy) | 113 are the eight blast batches; 108 of all dispatches are zero-size indirect when idle |

What changed: noteState's per-brick word (every core store sets it; nothing read it) now tells the air source
which bricks' faces and vacuum to read again, and a new per-brick "may hold a request" word (noteEvents, after the
saved activity words) limits the gas sources, the census and the first blast select to bricks that hold one. The
couple allocation's pool preparation, allocator and children sit behind a one-thread GPU gate. Each step is exact:
`tools/v2/air-cache-check.mjs` and `tools/v2/allocation-check.mjs` hold the proofs and their red variants.

## The lower bound

An exact implementation must read every cell a rule can change this tick plus that rule's inputs, write what
changed, and learn which cells can change next tick. With `k` changed cells, `a` resting-or-not air bricks in the
acoustic reach and `p` live particles, roughly:

`bound ≈ k·(8 to 27 input cells × 20 B + 20 B written + a neighbourhood push of ~27 words) + a·~100 B + p·96 B`

plus one dispatch per dependent stage (import, lists, column, support, block, requests, liquid, 8 air substeps,
couple, invalidate: ~20) and **zero when nothing can change** (certified idle already records nothing). Nothing in it
scales with N or B: a still brick need not be touched.

## Three scenes (per tick, outside water)

| scene | lean/integrate | this branch | bound | V1 |
|---|---|---|---|---|
| one grain falling in a still world (~30 awake bricks, ~10 columns, no particles) | **68 MB**, 149 dispatches | **12.3 MB**, 150 | ~2 KB (grain + its column), ~20 | 1.1 MB |
| lab, ~25 % awake, ~10 % of bricks changing, particles live | 68 MB + 12 MB pool + awake terms | 12.3 + ~13 MB re-reads + 6.8 + 12 MB + awake terms | ∝ changed cells | — |
| everything awake and changing, few requests, particles live | 68 + 12 MB + awake terms | ~47 MB (12.3 + 34 MB of core re-reads) + 6.8 + 12 MB + awake terms | ∝ N (everything changes) | — |

Watts, scene 1 (bytes only): 68 MB ≈ 122 mW before, 12.3 MB ≈ 22 mW after, the bound ≈ 0. In scene 3 the faces
cache pays nothing back: every brick is noted, so every core is read as before, plus ~0.9 MB of note words and the
vacuum cache. The 16 MB of request-word reads stay saved while few bricks hold requests; the pool gate saves nothing
while a particle lives.

## The remaining gap, ranked (scene 1, this branch)

1. **Per-brick air sweeps, ~11 MB (20 mW), 340 of the 376 B a brick.** Source, reach, the eight step gates, gas,
   couplePlan, count, apply and activity each read every brick's air words. Close it with a
   GPU-built list of air-active bricks (reach set, wind, notes) and indirect dispatch; source can skip a settled
   brick only if both ping-pong copies are kept equal outside the list (copy once on settling).
2. **Fixed dispatches: 113 blast dispatches, 108 zero-size when idle.** Each indirect dispatch costs a recorded
   command and, in Chrome, a validation dispatch. Batches are sequential by design (a blast can arm the next
   charge), so the CPU cannot skip them without a GPU result it does not have. Options: one batch a tick with the
   same service rate (a flagged behaviour change), or measure that zero-size indirect dispatches are cheap on Apple
   GPUs. Per-dispatch GPU cost is unmeasured; at an assumed 2 to 5 µs each it rivals the remaining bytes.
3. **Activity, ~0.7 MB and 32,768 × 27 loads.** List-driven activity over bricks within one brick of last
   tick's busy or awake set makes it ∝ awake.
4. **The particle pool, 12 MB (+6.8 MB of couple preparation) while any particle lives.** Cost ∝ capacity, not
   live particles. A per-64-slot live mask kept by every spawner and retirer (jets included, so it needs the
   column-water branch) would make it ∝ p.
5. **Whole-grid launches that exit at once**: gas, couplePlan, apply and the first select launch N/64
   workgroups each (~0 B, ~131k workgroups). The list from 1 removes them.
6. **holdCOM** loops over 65,536 slots in one thread while the physgun holds; a parallel reduction fixes it.

## What to measure on the GPU

Split timings of `source`, `select`, the couple chain and the zero-size batches in scene 1 at 128³ on both
branches; the cost of one zero-size indirect dispatch in Chrome and Safari; and a bit-identity A/B of cells,
banks and air after N ticks against lean/integrate with the wake fix (`a000f667`) applied to both sides.
