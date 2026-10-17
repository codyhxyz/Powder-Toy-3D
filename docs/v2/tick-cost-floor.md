# Tick cost floor

Branch `lean/perf-floor`, now on `lean/integrate` 3c95d72f (column-run water). CPU-only work: these figures are
byte counts from the code at 128³ (N = 2,097,152 cells, B = 32,768 bricks of 4³, a 65,536-slot particle pool of
48 B), **not GPU timings**. DRAM bytes are counted as each dispatch's footprint (an upper bound: small per-brick
arrays may stay in the system cache). Water (column runs, jets) belongs to the column-water work and is listed
apart. Watts use the brief's model: about 30 pJ per DRAM byte at 60 ticks/s, so 1 MB/tick ≈ 1.8 mW.

## The formula

A tick costs `A·N + B·awake + C·changed + D·bricks + E·pool + F`.

| term | lean/integrate 81f7393b | after round 2 | this branch | what it is |
|---|---|---|---|---|
| A, per grid cell | **24 B** (50 MB) | 0 | 0 | air `source` read every core and request word; the first blast select read every request word |
| D, per brick | 344 B (11.3 MB) | 60 B (2.0 MB) | 60 B (2.0 MB) | small words only: the activity scan (8 B), cols (4), invalidate (4), the air source list (16), reach (16), windList (4), count (4), the event list (4) |
| C, per changed brick | (inside A) | ~1.3 KB on it and its 6 face neighbours | same | faces and vacuum read again from its 64 cores; requests read only where noted |
| air-active bricks | (inside D) | ~116 B source + ~80 B a reached substep, listed bricks only | same | source, substeps, gas, couple and air activity run over GPU-built lists |
| E, pool, no particle | **6.8 MB every tick** | 0 | 0 | the couple allocation's pool preparation, behind its gate |
| E', pool while particles live | 12 MB (+6.8 MB a preparation) | same | **8 KB of live bits + ~200 B a live particle a stage** | every pool sweep reads only slots whose live bit is set |
| B, per awake brick column (powder fall) | ~32 KB (16 lanes × 128 cells) | same | **~1 KB a brick that is not all air or all still liquid** | the column pass skips summarised bricks |
| B, other awake cells | ~100 B outside water (estimate) | unchanged | unchanged | support, block |
| F, dispatches a tick | 149 outside water (+32 old water) | 159 outside water | **172 with the column water** (137 indirect; ~135 zero-size when idle), 18 copies, 1 clear | 115 are the blast batches and the first select's list |

What each round did:
- Round 1: noteState's per-brick word tells the air source which bricks' faces and vacuum to read again. A
  per-brick request word (noteEvents) limits gas sources, the census and the first select. A one-thread gate keeps
  the couple allocation off the particle pool.
- Round 2: a per-brick air-live word (noteAir) and GPU-built brick lists for the air tick and the first select,
  and the activity pass over a scan's list.
- Round 3:
  - Particle-pool live bits (a bit a slot): set at every spawn (the column-water jets' too), cleared by
    retirements and the pool preparation, set everywhere by restores. Every sweep skips a slot whose bit is clear.
  - holdCOM walks the live-bit words, in the same ascending order.
  - The powder column pass skips bricks the column water's summaries call all air or all still liquid.

The proofs and their red variants: `tools/v2/air-cache-check.mjs`, `air-reach-check.mjs`, `activity-list-check.mjs`,
`allocation-check.mjs`, `blast-batch-check.mjs`, `particle-live-check.mjs` and `column-skip-check.mjs`.

## The lower bound

An exact implementation must read every cell a rule can change this tick plus that rule's inputs, write what
changed, and learn which cells can change next tick. With `k` changed cells, `a` resting-or-not air bricks in the
acoustic reach and `p` live particles, roughly:

`bound ≈ k·(8 to 27 input cells × 20 B + 20 B written + a neighbourhood push of ~27 words) + a·~100 B + p·96 B`

plus one dispatch per dependent stage (import, lists, column, support, block, requests, liquid, 8 air substeps,
couple, invalidate: ~20) and **zero when nothing can change** (certified idle already records nothing). Nothing in it
scales with N or B: a still brick need not be touched.

## Three scenes (per tick, outside water)

| scene | lean/integrate 81f7393b | after round 2 | this branch | bound | V1 |
|---|---|---|---|---|---|
| one grain falling in a still world (~30–60 awake bricks, ~9 awake columns of ground under air, no particles) | **69 MB** | 2.5 MB | **~2.3 MB** (2.0 + ~0.1 column + ~0.2 support/block) | ~2 KB | 1.1 MB |
| lab, ~25 % awake (~half the columns), ~10 % of bricks changing, ~1,000 live particles | 68 + 19 + 16 MB + other awake terms | 2.0 + 13 + 19 + 16 MB + same | **~21 MB** (2.0 + 13 + ~0.3 pool + ~6 column) + same | ∝ changed cells | — |
| everything awake and changing, few requests, particles live | 68 + 19 + 32 MB + same | ~47.5 + 19 + 32 MB + same | ~47.5 + ~0.5–19 (with the live particle count) + 12–32 MB (with the ground) + same | ∝ N | — |

Watts, scene 1 (bytes only): 124 mW before round 1, ~4.5 mW after round 2, **~4.1 mW now**. V1 is ≈ 2 mW and the
bound ≈ 0. Scene 1 is ~2× V1 by bytes. The lab scene drops from ~90 mW to ~38 mW of the terms above.

## The remaining gap, ranked (scene 1, this branch)

1. **Fixed dispatches: 172 a tick, ~135 zero-size when idle.** The batches are 104 of them: 8 batches of 13 indirect
   stages, plus a workArgs each. The one-batch rule (The Powder Toy: an explosion's chain spreads one step a frame)
   at an unchanged service rate means one batch serving up to 8 charges at once. That needs multi-source blast
   planning: per-source shielded energy and per-source normalisation in one plan pass, a pick of the 8 lowest
   serviceable slots, and a finish over all of them. It is a behaviour change, so it gets its own commit and
   checks. Not done here; then merge the one-thread stages it leaves (listArgs ×4, actArgs, coupleGate, args).
   The cost of one zero-size indirect dispatch on the GPU is still unmeasured.
2. **All-brick scans of small words, 2.0 MB (3.6 mW).** Push the lists instead: append on a word's 0 → 1 change in
   markBusy, noteState, noteEvents and noteAir; dilate reach by scattering over the start list; drive cols and
   invalidate from lists. Each turns a hot store into an exchange-and-branch, so it needs GPU timing to pay.
3. **A noted brick re-reads its 64 cores.** Skipped: an incremental update changes the f32 summation order.
4. **The column pass still reads ground bricks it cannot change** (no summary for "solid or supported powder at
   rest"). A "settled" summary from support would extend the skip; the support pass would have to prove it.

## What to measure on the GPU

The `--hash` A/B of this branch against lean/integrate 3c95d72f in the eight scenes. Then split timings of the
particle stages with a few live particles, the column pass in a lab scene, and one zero-size indirect dispatch in
Chrome and Safari.
