# Physics v2 completion gates

Audit base: `b64183051da3ba978ab85f1e38399756fc842daf`, fetched from `origin/main` on 2026-10-14.

**Status: incomplete.** Renderer integration is one milestone, not completion of physics v2.
The current smooth renderer stays. The block-renderer proposal in `docs/v2.md` was superseded.

## Current evidence — 2026-10-15

Integration checkpoint: `dcd03636`, including fetched production `ea9bcb7d`.
At that checkpoint, the feature is 117 commits ahead and none behind production.
Work remains in `/tmp/tpt-physics-v2-finish`; the recovery checkout is untouched.
These results do not describe the live site.

The native engine now includes contact rules, heat, phases, particles, air,
jets, modes, exact persistence, and direct rendering.
CPU coverage does not establish complete GPU feature parity.

| GPU check | Result | Total slot occupancy |
| --- | --- | ---: |
| Full native slab, `3a89a96` | 83 ticks, 576 grains retained, one layer, correct fall and landing | 15.761 s |
| Full tank, `3a89a96` | 240 ticks, exact mass, flat surface, rest certified at 2.4 game seconds | 23.023 s |
| Wood control, `8ac7816` | Control passed after the frozen six-face exposure fix | 15.532 s |
| Census, `aed9af3` | 120 ticks, 20 checks, no measured water/particle, sand, or wall drift | 12.391 s |
| Census, `668ab1a7` | 120 ticks, 20 checks, zero measured drift after the WATER identity shortcut | 11.734 s |
| Wood control, `668ab1a7` | 60 ticks; original control passes with resident and airborne wood included | 1.563 s |
| Contact heat, `a2ee677` | 32 ticks, two metal cells, exactly 2,535,663,075,328 energy units retained | 10.382 s |
| Blast control, `17817ba` | Allocation path completed without GPU errors | 10.082 s |

All listed slots closed without forced cleanup or reported ownership errors.
The historical `8ac7816` wood counter excluded airborne wood.
The current counter includes packet amounts, temperatures and burning flags, including packets outside the grid.
Its CPU regression rejects cold wood merely lofted into packets.
The updated GPU pass does not establish complete fuel chemistry or energy accounting.
The blast control removed the entire floor from the grid.
That saturated footprint does not establish crater roundness or retained airborne mass.

The source changes preserve calibration:

- Scalar phase arrays replaced switch-return fanout. The contact pipeline now compiles and executes.
- Parallel pool and request prefixes preserve slot order and backpressure.
- Empty blast batches skip pool preparation through existing indirect arguments.
- Exact thermal admission replaces an encode/decode round trip. Its CPU oracle covers 6,183,436 cases without a mismatch.
- Uniform canonical AIR blocks skip only byte-identical work. The proof covers all 41,094 normal temperature codes.
- Full WATER blocks at exactly 20°C skip only proven identity work, preserving all 48 packed flux bits.
  Support snapshots and liquid passes still execute. Mixed blocks, other temperatures and pending requests retain the full path.
- Gather skips strict dry-AIR and balanced homogeneous-liquid identities. Phase endpoints retain the full transport path.
- Read-only cell sampling shares one decode instead of expanding three decoder call paths.
- Required contact compilation enters the bounded queue before graphics. The two-build concurrency limit remains unchanged.

Two scalar contact-row experiments passed CPU checks but exceeded Metal's startup allowance.
Both were reverted. Contact retains its GPU-verified row representation.

### Renderer-connected measurements

The unchanged water fixture uses 128³ cells, 1280×720 output, DPR 1, and quality scale 2/3.
The benchmark includes physics, rendering, and the GPU completion fence.
Native frames use no legacy bridge dispatches.

| Feature commit | Warmup / measured frames | v1 median | Native median |
| --- | --- | ---: | ---: |
| `aed9af3` | 1 / 4 | 75.2 ms | 104.1 ms |
| `17817ba` | 3 / 12 | 103.6 ms | 93.9 ms |

These runs use different sample windows.
Both engines also evolve different states from the same fixture.
The table is diagnostic evidence, not a final speedup claim.
It predates production reconciliation and the latest identity shortcuts.
An unfired detail-prefetch timer could also start shader compilation after readiness returned.
The old tool did not reject that potential measurement confound.
Headless checkpoints now request actual visible detail, including close-up and curved views, without that speculative timer.
Normal gameplay keeps its prefetch behavior. Measured windows now reject new pipeline work instead of discarding affected samples.
The second run occupied 25.744 seconds under the earlier explicit 30-second exception.
Subsequent runs use the fetched 25-second policy.

At `17817ba`, the split diagnostic occupied 19.093 seconds.
Gather still costs about 12.14 ms per frame, and contact costs 9.82 ms.
Scene rendering costs about 38.11 ms.
The overlapping motion interval is not an additional scene cost.
Allocation scans no longer dominate the compute timings.

Readonly volume-format specialization is integrated at `7cf968dd`.
Generic and writer hashes remain unchanged against the merged production checkpoint.
CPU tests cover formats 0/2/3, engine transitions, deferred readiness and shader validation.
Both engines now complete full-frame measurement at `f86a20c8`, without pipeline activity during samples.
The CPU fixture hashes, f32 cameras and complete render-quality keys match.
Three warmups precede 12 measured frames for each engine.

| Current merged reference | Median frame | p95 frame | Total occupancy |
| --- | ---: | ---: | ---: |
| v1 | 168.4 ms | 259.4 ms | 11.028 s |
| Native direct | 192.8 ms | 209.3 ms | 16.160 s |

The native median is 14.5% slower. The performance target is not met.
Evolved states differ, so neither median nor tail establishes equivalent-work performance.
These are serialized frame latencies, not live gameplay FPS.
Further diagnostics must separate compute from rendering without interpreting coalesced labels as individual kernel costs.

The two-frame split diagnostic at `956a7169` used 12.443 s total.
Scene and motion cover the same overlapping interval, about 137 ms; do not add them.
Gather averages 10.814 ms per frame; contact averages 10.739 ms.
This replay is diagnostic, not another headline sample window.

The native compatibility projection averages 168.975 ms, with a 171.1 ms median and 11.856 s total occupancy.
Its fixture, quality keys, native ticks and rendered-frame indices match the direct reference.
It adds one bridge dispatch per frame. Its scene interval averages 109.738 ms versus 135.075 ms direct.
This suggests representation overhead; it does not prove identical pixels or provide an equivalent-work speedup claim.
The direct renderer remains the intended path.

Native volume ID-only probes now use a CPU-verified scalar decoder.
It preserves visual dithering, physical nonzero-fill visibility and canonical slot coordinates.
The full-decoder oracle passes 405,024 cases; six generic/writer/picking shader hashes remain unchanged.
Metal performance remains unmeasured for this change.

Local evidence:

- `/tmp/v2-native-slab-profile-3a89a96.jsonl`
- `/tmp/v2-native-tankStill-3a89a96.json`
- `/tmp/v2-native-woodBurns-8ac7816.json`
- `/tmp/v2-native-census-aed9af3.json`
- `/tmp/v2-native-census-668ab1a7.jsonl`
- `/tmp/v2-native-woodBurns-668ab1a7.jsonl`
- `/tmp/v2-contact-thermal-a2ee677.json`
- `/tmp/v2-native-blast-17817ba.json`
- `/tmp/v2-native-water-matched-17817ba.json`
- `/tmp/v2-native-water-split-17817ba.json`
- `/tmp/v2-water-native-8d5ad463.json.startup.jsonl`
- `/tmp/v2-water-native-f86a20c8.json`
- `/tmp/v2-water-v1-f86a20c8.json`
- `/tmp/v2-water-native-split-956a7169.json`
- `/tmp/v2-water-compat-956a7169.json`

Remaining gates include full GPU feature coverage, reliable matched performance,
fresh production checks, independent review, deployment, and a live-site check.
V1 remains the default.

## Earlier startup checks — 2026-10-14 (historical)

These notes describe attempts before the scalar phase arrays.
They do not supersede the current evidence.

At base `88a2334`, `tools/v2/column-browser-check.mjs` executed the production
R1 shader in Chromium/WebGPU. It used the existing slab fixture: 576 sand
grains in a 32³ grid, stepped for 180 ticks.

- All six checkpoints retained 576 grains in one layer.
- At tick 30, measured fall was 8 cells; the declared law predicted 8.439.
- All grains reached the floor by tick 60 and remained there through tick 180.
- No page or GPU validation errors were reported.
- GPU slot occupancy was 643 ms. This is test occupancy, not frame time.

Raw result: `/tmp/v2-native-column-runtime-88a2334.json`.
Lease report: `~/.cache/tpt-headless/runs/3990-4012.json`.

This checks **R1 only**, not contact physics, particles, liquids, rendering,
or the complete engine. The full-engine slab test was terminated during
startup without returning assertions (lease `93668-93690`, 8628 ms).
The full water renderer check also remains unverified.

`tools/v2/boot-profile.mjs` records pipeline-ready events during full native
startup. Its first attempt could not acquire the GPU slot; it launched no
browser and produced no timing samples.

The subsequent trace at `ac2f993` requested 72 pipelines. Seventy-one became
ready; **`v2block` alone remained pending** when the watchdog closed the run.
Elapsed readiness milestones were about 4.0 seconds for legacy `move`,
4.5 seconds for native blast application, and 6.1 seconds for particle impacts.
These are cold-start readiness timings, not simulation or frame timings.
The run reported no ownership-inspection failure and released its slot after
8633 ms. Trace: `/tmp/v2-native-boot-profile-ac2f993.jsonl`; lease:
`~/.cache/tpt-headless/runs/29072-29094.json`.

Subsequent full-engine diagnostics also returned no outcome assertions:

| Lease | Measured slot occupancy | Result |
| --- | ---: | --- |
| `55232-55259` | 8684 ms | Watchdog cleanup |
| `73121-73143` | 8706 ms | Contact pipeline remained pending |
| `90381-90407` | 3531 ms | Ownership query timed out |
| `98284-98520` | 8714 ms | Bounded compile queue did not finish startup |
| `7558-7580` | 8638 ms | Runtime-backed contact loops did not finish startup |

All five lease reports confirm release. None counts as a physics pass.
At `8c1c1aa`, all 33 v2 CPU suites and the production build passed.
Read-only contact-table buffer work was incomplete at that point.
Its GPU compile cost was unknown.

## What existed at the audit base

`src/v2/physics.js` drives `src/shaders/v2.js` behind `?physics=v2`.
The implementation contained:

- A fixed 60 Hz clock for boxes, with bounded catch-up.
- One 16-byte compact cell array, alongside the legacy simulation allocation.
- Column falling, material-specific heaps, basic density swaps, gas motion and gas decay.
- Integer liquid fill, face flux, outflow limits, and three liquid substeps.
- Rule-reported activity and an idle certificate.

The complete legacy allocations still exist. Sixteen bytes per compact cell does not describe total memory use.
The quoted traffic reduction is an estimate, not a measured frame-time improvement.

The fetched branches contained no later implementation of these v2 modules at the audit base.
The historical `origin/claude/v2` and `origin/ship-physics` branches did not contain a completed physics engine.

## Required work

| Area | Missing at the audit base | Acceptance evidence |
| --- | --- | --- |
| Renderer | Every tick exports compact cells to legacy A/B/F | Direct reads in fields, occupancy, volume, Plain, shadows, GI and picking. No normal tick or draw exports cells. |
| Editing | Legacy projection cannot preserve partial fill | Edits preserve untouched compact cells, including edits while paused. Continuous-edit timings include synchronization. |
| Persistence | Legacy undo and saves lose fill, flux and age | Exact compact undo and save/load tests. Explicit behavior across physics modes. |
| Heat and phases | No conduction, latent heat, melting, freezing or condensation | Conserving heat tests, phase thresholds and latent-energy tests. Steam does not disappear instead of condensing. |
| Reactions and fire | No chemistry, contact ignition, fuel or burn products | Element-pair reactions, flame-to-wood ignition, fuel use, products and smothering tests. |
| Electricity | No spark automaton | Conductors, insulators and electrical devices retain their behavior. |
| Impacts and blasts | No impact damage, shielded blast damage or ejecta | Energy thresholds, wall shielding, blast symmetry and debris tests. |
| Air | No pressure solver, wind, vacuum or shocks | Sealed-vessel retention, pressure conservation, wind transport and vacuum tests. |
| Airborne matter | No ballistic throws, jets or particle deposition | Flight trajectories, collisions, deterministic claims and conserved deposition. |
| Liquids | No splash energy budget, foam or true fill-aware surfaces | U-tube, puddle, pipe, jet, compression, splash, foam and mass tests. |
| Integration | Worlds, POV and guests do not run v2 | Active-engine assertions for each mode, tool behavior, world shifts and multiplayer state tests. |
| Rest | Only implemented rules participate | Every added rule wakes affected neighbors and permits exact rest when no action remains. |

The design defers radial gravity and loop edges. That does not justify silently removing existing controls.
Their behavior needs an explicit compatibility decision before v2 becomes the default.

The compact payload also needs a defined owner for each field before new physics rules share it.
For example, liquid flux currently occupies words that other materials use for unrelated state.

## Implementation order

1. Connect the current renderer to compact cells and replace per-tick conversion with boundary synchronization.
2. Preserve compact state through edits, undo, saves and mode transitions.
3. Complete heat, phase changes, reactions, fire and electricity.
4. Complete particles, impacts, blasts, air, jets, splashes and foam.
5. Integrate worlds, POV, tools and multiplayer without silent v1 fallback.
6. Run the full feature suite and the matched frame benchmark before changing the default.

Boundary synchronization still converts cells for legacy consumers. It is not removal of all legacy storage.
Reusing v1 physics through a per-tick bridge would reintroduce the cost this work must remove.

## Measurement contract

Compare three paths: v1, bridged v2, and direct-read v2.
The two v2 paths isolate renderer integration from changes in physics behavior.
Until feature parity passes, a faster v2 result does not prove a faster equivalent game.

Keep the scene, seed, grid size, camera, viewport, resolution and graphics settings identical.
Use the smooth renderer. Do not lower quality or remove physics features to reach a speed target.

Record raw samples and p50/p95 for:

- Full-frame wall time, including submission and completion.
- Unsplit GPU pass time, including derived fields, shadows, GI, drawing and post-processing.
- A separate split-pass diagnostic, if needed to identify costs.
- Active sand and water, settled scenes, continuous edits, and completed fire/blast workloads.
- Memory use, awake bricks, simulation ticks, adapter, browser and exact settings.

A simulated frame uses four v1 steps or one v2 tick at the nominal 60 Hz presentation rate.
This matches the existing clock contract, not identical trajectories between different physics models.
A live playback check must also confirm that simulation speed does not depend on presentation rate.

Reject software-adapter results as Mac performance evidence.
Do not bypass the headless player-activity guard without the user's permission.

## Test integrity

The app adapter previously used `engine=v2`, although physics selection uses `physics=v2`.
It also read the v1 activity map and clock without checking which engine ran.
The adapter now rejects a requested v2 scene when the app falls back to v1.
It reads v2 activity and fractional liquid mass when v2 is active.

`node tools/v2/check-app-adapter.mjs` checks engine identity, clock selection and fallback rejection without a GPU.

`node tools/outcomes.mjs --engine v2 --strict` requires passes, not expected failures or unsupported-feature skips.
The outcome suite alone is not complete coverage of the table above.

## Validation status

The initial app check could not acquire the GPU. The player-activity guard measured 100% utilization.
A later guarded run used the Apple M5 successfully.

Pre-integration sand baseline: 128³ cells, 1280×720 viewport, Quality rendering at 2/3 scale, and automatic resolution disabled.
Each engine ran eight warmup frames and 24 measured frames from the same seeded fixture.

| Engine | Full-frame wall p50 | Full-frame wall p95 |
| --- | ---: | ---: |
| v1 | 31.2 ms | 38.7 ms |
| Existing bridged v2 | 11.0 ms | 15.9 ms |

Raw report: `/tmp/tpt-v2-bridge-sand.json`.
These are serialized frame latencies, not live gameplay FPS.
This baseline does not measure the direct-read change or equivalent complete physics.
GPU pass durations overlapped, so their sum is not elapsed frame time.

CPU adapter checks, benchmark self-checks, the production build and browser-launch policy checks passed before renderer integration.
No feature-completeness claim or default-engine change is justified.

### Native-read milestone results

The implementation now uses compact cells for presentation without a per-tick export.
The GPU integration check passed on the M5:

- Direct and legacy-projected cell reads agree.
- Picking, brick occupancy and Plain mesh face counts agree.
- Paused edits appear without another physics tick.
- Legacy dirtiness survives sleep.
- V2 undo restores every compact word, including fractional fill and flux.
- Cross-mode history tags select the correct restoration path.
- Ambient-temperature flag refresh does not replace compact state.

CPU checks found and fixed a missing `format` field in the actual parameter packer.
Review also found unnecessary redraws from awake-but-unchanged bricks.
The rule writers now report visible changes separately from activity.

The paired frame run used the same settings as the baseline above.
Each case had eight warmup frames and 24 measured frames.
Chromium version: `153.0.8010.12`. Adapter: Apple M5.

| Scene | Direct p50 / p95 | Compatibility p50 / p95 |
| --- | ---: | ---: |
| Moving sand | 11.1 / 15.3 ms | 11.2 / 16.0 ms |
| Moving water | 110.6 / 131.0 ms | 110.6 / 129.7 ms |
| Settled architecture, forced draws | 6.5 / 12.0 ms | 6.2 / 12.2 ms |

Direct samples recorded zero bridge dispatches. Compatibility samples recorded one per frame.
**This run does not establish a meaningful frame-time improvement from bridge removal.**
The compatibility path uses the same new invalidation policy, not the historical bridge implementation.

Raw reports:

- `/tmp/tpt-v2-direct-comparison.json`
- `/tmp/tpt-v2-water-profile.json`

The split water diagnostic places roughly 100 ms in the scene rendering interval.
The `scene` and `motion` timestamp intervals overlap. They must not be added as separate elapsed costs.
Individual physics passes were much smaller, with the three flux passes totaling roughly 0.9 ms.
Removing another physics conversion cannot by itself solve this renderer-dominated fixture.

The broader app check passed movement, mass, edits, presets, exact undo and mode switching.
Its original idle fixture retained the Lab enemy spawner and legacy foam from a v1 run.
That is not an actor-free idle box. The rest check now creates a separate heap-and-puddle scene.

The new fixture exposed an empty legacy particle scan that kept the CPU loop awake.
The busy check now ignores that pending scan only in v2 when no particles exist.
Actual particles still keep the loop awake. V1 still performs its pending scan.
After this fix, the actor-free loop slept within 0.5 seconds.
The check still counted four late submissions in its measurement interval, so the zero-submission assertion remains unverified.
The test now drains recorded GPU work before sampling. That final test adjustment has not run on the GPU.
Legacy foam and particles across runtime engine transitions remain integration limitations.

The branch also includes deployed weather commit `3dba791`.
The merge preserves weather's host-step source and the lightning job capture.
V2 still does not run the world weather simulation.

### Remaining acceptance blockers

1. Demonstrate a repeatable full-frame improvement without lowering quality.
2. Fix the app-wide idle failure without hiding active subsystems.
3. Implement the missing physics and integration requirements listed above.
4. Validate exact compact saves and cross-mode runtime transitions on the GPU. The CPU-checked implementation and remaining app acceptance plan are in [persistence.md](persistence.md); multiplayer remains separate.
5. Validate continuous edits and live playback, then deploy and check the live site.

This work remains experimental on `feat/physics-v2-finish`. It is not a completed engine replacement.

### GPU test budget update

The user now requires at most 10 seconds of total GPU occupancy per run, including setup, compilation and cleanup.
Earlier runs did not use this limit. One app check waited over 60 seconds for idle.
Exact historical slot boundaries were not recorded, so those runs cannot claim compliance.
All test commands ended and their cleanup closed the browsers.
Port 19473 and processes associated with this worktree were absent at the final process check.

Further GPU validation waits for the separately maintained launcher revision that enforces the total limit.
No launcher edit, guard bypass or GPU rerun is part of this checkpoint.
