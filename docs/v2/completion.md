# Physics v2 completion gates

Audit base: `b64183051da3ba978ab85f1e38399756fc842daf`, fetched from `origin/main` on 2026-10-14.

**Status: incomplete.** Renderer integration is one milestone, not completion of physics v2.
The current smooth renderer stays. The block-renderer proposal in `docs/v2.md` was superseded.

## What exists

`src/v2/physics.js` drives `src/shaders/v2.js` behind `?physics=v2`.
The implementation contains:

- A fixed 60 Hz clock for boxes, with bounded catch-up.
- One 16-byte compact cell array, alongside the legacy simulation allocation.
- Column falling, material-specific heaps, basic density swaps, gas motion and gas decay.
- Integer liquid fill, face flux, outflow limits, and three liquid substeps.
- Rule-reported activity and an idle certificate.

The complete legacy allocations still exist. Sixteen bytes per compact cell does not describe total memory use.
The quoted traffic reduction is an estimate, not a measured frame-time improvement.

The fetched branches contain no later committed implementation of these v2 modules.
The historical `origin/claude/v2` and `origin/ship-physics` branches do not contain a completed physics engine.

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
4. Preserve exact compact state in saves and cross-mode runtime transitions.
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
