# Physics v2 completion gates

Original audit base: `b64183051da3ba978ab85f1e38399756fc842daf`, fetched from `origin/main` on 2026-10-14.

**Status: incomplete.** Renderer integration is one milestone, not completion of physics v2.
The current smooth renderer stays. The block-renderer proposal in `docs/v2.md` was superseded.

## Current evidence — 2026-10-16

Latest remote-main integration: `908c7a24`, including fetched `origin/main` at `3c1129cb`.
This feature checkpoint is 158 commits ahead and none behind that production base.
Work remains in `/tmp/tpt-physics-v2-finish`; the recovery checkout is untouched.
Physics results describe the feature branch, not the live site.
The separate test-safety and measurement-guard fixes are deployed.

The native engine now includes contact rules, heat, phases, particles, air,
jets, modes, exact persistence, and direct rendering.
CPU coverage does not establish complete GPU feature parity.

Earlier integration `afc6ef4f` adds four materials from production main.
Contact and phase checks cover all 95 materials.
All 51 applicable CPU scripts pass after the phase prototype and Factory boundary checks.
Terrain, adapter and build checks also pass.
The new folded-terrain cache cannot yet preserve exact native core and bank state.
Native capture and restore refuse before touching legacy stores, rather than losing that state.
Independent merge review `8d642dea` finds no scoped blocker.

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
Both were reverted. Full row snapshots remain.

**Material-row experiment (`f05eef58`, reverted by `fe9c7071`):**
Production R5 reused the existing table through a 14,656-byte uniform view.
All 49 CPU scripts and the build passed.
Independent review `a253087d` found no scoped blocker.

The first census attempt at `c325250c` did not launch because player detection found the GPU 56% busy.
The launcher released its slot after 2.080 s.
No simulation or GPU backend compilation started, and no outcome returned.
No override or automatic retry occurred.

After the user confirmed availability, one census ran at frozen checkpoint `1e846753`.
The uniform path was selected.
All 20 mass checks passed over 120 ticks, with zero drift.
Total occupancy was 14.285 s, with clean release and no ownership errors.
R5 backend compilation took 10.942 s.

The historical same-fixture storage trace compiled R5 in 7.779 s.
These runs are not a controlled benchmark, but they establish no compile benefit.
The extra binding infrastructure was removed.
Current main is merged, and full material snapshots use the original storage path.
One current 95-material census ran at `afc6ef4f` with the storage path selected.
All 20 checks passed over 120 ticks, with zero water, sand or wall drift.
Total occupancy was 11.547 s, with clean release and no ownership errors.
R5 backend compilation took 8.070 s.
This scoped pass does not establish complete feature parity or a repeatable frame-time gain.

**Phase-lookup prototype:** seven scalar lookup helpers read existing signed EV metadata.
No buffer, upload, binding, pass or packed-table change is added.
Full contact snapshots, rule bodies, default/custom emitters and prefix-only dynamics remain unchanged.
The unguarded `MATERIAL_CAP` array remains untouched because unknown-ID equivalence is unresolved.

The actual emitted helpers pass 3,626 comparisons, including negative offsets, absent transitions, lava formations and unknown IDs.
The existing thermal-admission oracle passes 6,449,452 cases across all 95 materials.
All 50 applicable CPU scripts, minified full-shader Naga checks and the build pass.
CPU evidence alone does not establish Metal compilation, runtime cost or a speedup.
Independent review `db8c3425` finds no concrete blocker and repeats all 3,626 helper comparisons successfully.

The guarded census attempt at `5d417d93` did not launch because player detection found the GPU 70% busy.
The slot released after 2.104 s.
No browser, simulation or backend compilation started.
No override or automatic retry occurred.
That refused attempt establishes no hardware result.

The prototype first passes CPU validation on frozen base `b119bff1`.
Integration `908c7a24` then incorporates the newer Factory and world presentation changes.
It leaves the v2 shaders, packed tables, physical rules and dependencies unchanged.
Full phase-feature acceptance and repeatable compile benefit remain open.

After the user confirms availability, two guarded GPU cases run with player detection enabled:

| Checkpoint | Selected path | Result | Total occupancy |
| --- | --- | --- | ---: |
| Census, `32312bea` | Compact runtime, phase metadata from EV | 120 ticks, 20 checks, zero water, sand or wall drift | 11.240 s |
| Thermal, `a46fdf3a` | Noncompact runtime fallback, phase metadata from EV | 32 ticks, two metal cells, exactly 2,535,663,075,328 energy units retained | 10.289 s |

Both slots release normally, without ownership failures or GPU validation errors.
The thermal fixture retains its original temperatures, dimensions, ticks and assertions.
Its test now calls the actual runtime emitter instead of the original reference emitter.
Hot metal loses heat and cold metal receives heat.
Census R5 backend compilation takes 7.698 s.
The thermal test reports 7.601 s for its combined kernel compilation interval.
These single runs do not establish a repeatable compile improvement or full-frame gain.
They do not cover all phase transitions or app-level Factory integration.
The estimated pipe runtime still leaves insufficient early-stop margin, so no pipe retry occurs.
No further GPU run occurs in this batch.

**Factory integration boundary:** new molten-charge guidance writes legacy B velocity.
That velocity does not define native particle momentum.
Factory's “native step” hook means the legacy TPT cadence, not the 60-Hz v2 host.
The merge retains that hook only beside legacy simulation steps.
It does not multiply fuel consumption or invent a momentum conversion.

V2 readiness refuses Factory mode and registered or pending machine operations.
The controller refuses machine work while v2 is requested, including waits before a retained owner reactivates.
It reports the unsupported operation rather than silently stepping V1.
A retained, suspended native owner does not disable V1 Factory.
Engine activation refuses pending machine transfers, including transfers that start during module loading.
Concurrent engine-change requests refuse until the current change finishes.
The serialization guard clears on success and preparation failure.

Registration and cargo snapshots remain restorable while machine operation is unavailable.
Save headers retain Factory or Sandbox mode despite the runtime refusal.
Construction retains the new hearth shell, tagged pump backplate and selective demolition.
Explicit ownership claims apply only inside admitted replacement branches.

The real-controller and app-method CPU fixtures check refusal, unchanged words, metadata, asynchronous activation and V1 dispatch.
The 17 Factory orchestration checks, diagnostics, surface-mesh checks, CPU Naga validation and production build also pass.
These checks do not establish Factory physics parity under v2.
Review `c4a72bcc` finds a retained-owner admission race in merge `908c7a24`.
A deterministic CPU interleaving reproduces machine removal during the activation wait.
Fix `f7ee74f9` closes admission through the requested engine mode and serializes engine changes.
The same regression now passes, alongside all 51 CPU suites and the build.
Independent re-review `99157fc7` finds no scoped blocker and repeats all seven boundary groups successfully.
It confirms the real wiring, requested-mode admission, stable V1 behavior and serialization cleanup.
CPU and VM coverage do not establish Factory hardware acceptance or physics parity.

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

| Earlier `f86a20c8` reference | Median frame | p95 frame | Total occupancy |
| --- | ---: | ---: | ---: |
| v1 | 168.4 ms | 259.4 ms | 11.028 s |
| Native direct | 192.8 ms | 209.3 ms | 16.160 s |

At that checkpoint, the native median is 14.5% slower.
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
The 12-frame Metal window at `6f3383d5` completes at 181.9 ms median and 206.5 ms p95.
Total occupancy is 13.876 s. This is an observed reduction from the 192.8 ms reference, not a robust speedup claim.
It still trails the v1 reference median; the performance target remains unmet.

Production block compaction is integrated at `5c79d173`.
It keeps support snapshots for all targets and dispatches original IDs only for nonidentity blocks.
The scratch tail adds 1,048,592 bytes at 128³; existing args supply its indirect dispatch.
Devices without tail capacity retain the original native scratch and dispatch.
CPU tests cover the full heavy-body identity, shuffled invocation order, custom fallback and exact-limit resource behavior.
The native census at `87aa3328` passes 120 ticks and 20 checks with zero mass drift.
Both new pipelines ran; total GPU occupancy was 10.721 s.

The clean two-frame split at `60fa5165` reduces contact kernels from 10.739 to 4.744 ms, including classification and finalization.
Fixture, camera, quality and tick windows match; total occupancy was 3.438 s.
At tick 5, 58,346 of 96,512 blocks skip the heavy kernel.
At tick 15, 49,491 of 113,472 skip it: evolved coverage is lower than the initial CPU estimate.

A fast cached boot exposed another optional timer: POV's two-second avatar prewarm compiled during samples.
Those two cases are invalid, not performance evidence; occupancies were 3.267 s and 3.457 s.
Headless modes now skip that background timer. Normal prewarm and awaited POV entry remain unchanged.
The compile guard still rejects the whole case and now records pipeline labels.

| Latest clean pair, `60fa5165` | Median frame | p95 frame | Total occupancy |
| --- | ---: | ---: | ---: |
| v1 | 145.5 ms | 210.7 ms | 9.993 s |
| Native direct | 131.5 ms | 158.0 ms | 10.702 s |

Each case has three warmups and 12 samples, identical CPU fixture and quality keys, and no measured compilation.
Native records zero bridges. Means are 150.15 ms for v1 and 135.16 ms for native.
This pair predates the hot-contact, full-f16 limiter and jet-restoration changes.
It is not a speed result for the current physics.
This one window has a 9.6% lower native median; it is not a repeatable equivalent-work speedup claim.
Independent review `afa9f325` found no blocker in compaction, scalar IDs, resource fallback or headless prewarm.

**Repaired ignition gate:** original `flameWood` at `60fa5165` lights 0 of 6 bays; at least 5 are required.
It completes 120 ticks normally with 9.489 s total occupancy; this is not a timeout.
Contact activation already exists, but its stochastic hazard is insufficient for this short flame exposure.
`9e027c71` adds deterministic activation by a live, sufficiently hot contact source.
It retains existing thresholds, stochastic fallback, fuel spending and energy accounting. This is an explicit R8 behavior addition.
The unchanged GPU fixture now lights 6 of 6 bays by 0.25 game seconds; total occupancy is 10.347 s.
The original preheated-wood control also passes at 60 ticks; total occupancy is 10.405 s.
CPU validation covers 12 new groups, exact ledgers, excluded sources, frozen snapshots and unchanged AIR/WATER identities.

**U-tube gate:** original `utube` at `cab5525f` ends 1.144867 cm apart, exceeding the unchanged 1 cm limit.
That failed run conserves mass and rests, with 10.204 s total occupancy.
`064728ef` preserves fractional stored flux until after proportional limiting, matching the prototype's ordering.
It also adds canonical receiver-headroom admission before any debit.
Deadbands, snapping, damping, yield and substeps are unchanged.
The original GPU gate now passes at **0.9992980957 cm**, with exact mass and rest at 6 game seconds.
It completes 600 ticks with 11.944 s total occupancy. The passing margin is narrow, not a general accuracy guarantee.
Original partial-pool, still-tank and yield regressions also pass, with occupancies of 10.532 s, 9.413 s and 5.192 s.
Independent review `46f65d5d` found no R8/R13 blocker; it did not attest feature completeness or stable performance.

**Remaining jet failure:** original `hole` at `1cd24b54` has 94.05% reach error against the unchanged 5% limit.
Mass and stream continuity pass; total occupancy is 10.392 s.
Existing-readback diagnostics at `533da63c` reproduce the failure with 9.806 s occupancy.
All three checkpoint reads contain zero airborne WATER; the measured stream is resident liquid.
The outlet and cell below it contain WATER. This does not prove that no particles were ever born.
`d1897f8e` restores bounded static-head launch and the prototype's thin-stream predicates.
Jets now form: checkpoint reads contain 222, 400 and 573 WATER packets.
Mass and continuity pass, but reach errors are 1.89%, 13.66% and 12.67%.
The unchanged 5% gate still fails; occupancy is 11.625 s.
The same original test on the unmodified CPU prototype also fails, at 12.78% worst reach error.
This remaining hydraulic-model gap is not established as a native port regression.

A bounded CPU experiment compared the original World with one outlet-only pressure-work closure.
Worst reach errors were 12.7776% and 13.1370%. Both failed the 5% gate.
Both retained exact mass and continuity 1. The experiment retained no candidate code.
Its scalar energy identity does not establish global conservation or accepted-packet work.

Independent review `c725db97` confirms the approved R14 rules, but also proves a liquid handback trap in a fixed-grid CPU witness.
Matching film traversal can leave a stopped packet without an admissible deposition target.
`142e6114` implements canonical whole-packet liquid handback. It does not change launch head or claim to fix jet accuracy.

**Repaired throw settlement:** at `c6625d49`, the original throw lands four resident grains at the exact predicted centre, with passing spread.
Its final eight-resident-grain gate fails. Total occupancy is 12.997 s.
Readback diagnostics at `e176248a` retain all eight grains: four resident and four stationary particles overlapping that row.
Diagnostic occupancy is 1.336 s. This is settlement failure, not measured mass loss.
Setup now counts seeded whole particles; the final landing count remains resident-only.

`142e6114` adds bounded matching-powder recovery and single-winner liquid admission.
Its 48 CPU check scripts pass, including 11 emitted-body deposition groups and 78 Naga dynamics modules.
The unchanged GPU throw now passes: all eight grains are resident, centre x=19, spread 0.5.
Total occupancy is 9.986 s. No packets are counted as landed grains.

The original mixed-material census also passes 120 ticks and 20 checks with zero drift.
Water remains 72 cells, sand 528 and walls 156; occupancy is 8.846 s.
Water in flight falls from 0.227 cells at 0.5 s to zero by 1 s.
The earlier independent handback review timed out and does not count as completed review.
Fresh source-only review `2acb0bd4` finds no scoped blocker.
Four-cell recovery and OTHER-material refusals remain intentional limits.

**Open splash observable:** source review `5025fae4` finds no resident-liquid kinetic state in native authority.
The unchanged benchmark requires resident-plus-flight energy.
Unknown velocity could silently understate peak upward energy.
A GPU run cannot supply the missing model definition.
The original fixture, 0.3 cap and mass criterion remain binding.
This gate remains open.

`9a341a1c` and `6398bdda` reject unknown samples and nonfinite inputs or derived energy.
Native adapters now report that complete cell velocities are unavailable.
Unsupported `n/a` is not a pass.
Seven CPU observer groups execute the actual outcome, including guard-removal and overflow counterexamples.
They test measurement reliability, not splash physics.

All 50 CPU check scripts and six adapter groups pass, along with the production build.
Independent review `3b5410d1` finds no scoped blocker.
The shared test-guard backport `6d239845` is deployed separately from native physics.

Deploy run `38812593514` succeeds, and the live site returns HTTP 200.
Its three files contain only the shared guard, contract comment and CPU regression.
The native feature branch and material-row candidate are not deployed.
V1 remains the default.

**Historical safety interruption:** the `142e6114` pipe attempt returned no assertions.
Its trace ends during startup and lease `19727-19749` lacks a final report.
Occupancy cannot be established; this is neither a pipe pass nor a physics failure.
Later inspection finds no surviving tagged test processes or listener on port 19623.
GPU tests stopped while the deadline audit was investigated.

The CPU watchdog audit first fails its 1500 ms fixture deadline assertion.
A diagnostic rerun passes six cases, then times out before reporting the slow-inspection case.
That fixture budget is below the launcher's 4000 ms minimum and does not prove a production deadline miss.
Source review separately identifies unsafe age-only dead-holder reclamation and a guard vulnerable to external process-group termination.
Neither is established as the cause of this interruption.

**Deployed safety repair:** `c59bbdf0` preserves unverified leases and rejects reused self-PID adoption.
Its detached guard alone unlinks guarded leases after cleanup verification.
Independent review `148647b5` found no blocker in the fixes.
All nine CPU process scenarios pass within their legal 6000 ms budgets.
Deploy run `38800891337` succeeded, and the live site returned HTTP 200.
This deployment changes test tooling, not v2 physics or the default engine.

The guarded launcher/close smoke passes with 2.470 s total occupancy.
The unchanged pipe retry at `a2e7afe4` reaches 40 game seconds, then stops before assertions.
Its guard verifies forced cleanup at 21.113 s total occupancy, with no ownership errors.
No tagged test processes or listener on port 19623 remain.
This attempt supplies safety evidence, not pipe acceptance.

The pipe trace measures 8.367 s backend compilation for `v2block`.
Engine readiness follows at 8.507 s within the page trace.
Other compilation intervals overlap, so their durations are not additive.
Completed advances take 5.569 s through 2400 ticks.
The current investigation targets compilation overhead without changing the fixture, physics, or 25-second cap.

V2 remains incomplete and non-parity, and must not become the default yet.

Other unchanged numeric controls pass after compaction.
The first five rows use `cab5525f`; heaps and vessel use `5ddd0932`.

| Control | Ticks | Result | Total occupancy |
| --- | ---: | --- | ---: |
| `tankStill` | 240 | Flat, exact mass, rest at 2.4 s | 9.538 s |
| `partial` | 480 | 0.11 cm variation, exact mass, rest at 4.5 s | 2.046 s |
| `yield` | 300 | Mud peak 2.49 cells, water peak 0.25 | 5.358 s |
| `puddle` | 360 | Exact mass, bounded edge, rest at 4 s, zero awake bricks | 10.726 s |
| `sandFalls` | 90 | All 64 grains fall and land; all retained | 8.788 s |
| `heapSand` | 314 | 432 grains, roundness 0.95, slope 0.97; rest 1.2 s after pouring | 12.725 s |
| `heapFlour` | 314 | 432 grains, roundness 0.96, slope 1.67; rest 1.7 s after pouring | 1.960 s |
| `vessel` | 615 | 94.17% pressure kept after 10 s; outside pressure zero; all 296 walls intact | 11.635 s |

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
- `/tmp/v2-water-native-id-6f3383d5.json`
- `/tmp/v2-native-census-87aa3328.jsonl`
- `/tmp/v2-water-native-compact-f41c15e0.json`
- `/tmp/v2-water-native-compact-split-60fa5165.json`
- `/tmp/v2-water-v1-60fa5165.json`
- `/tmp/v2-water-native-60fa5165.json`
- `/tmp/v2-native-flameWood-60fa5165.jsonl`
- `/tmp/v2-native-flameWood-9e027c71.jsonl`
- `/tmp/v2-native-woodBurns-9e027c71.jsonl`
- `/tmp/v2-native-utube-cab5525f.jsonl`
- `/tmp/v2-native-tankStill-cab5525f.jsonl`
- `/tmp/v2-native-partial-cab5525f.jsonl`
- `/tmp/v2-native-yield-cab5525f.jsonl`
- `/tmp/v2-native-puddle-cab5525f.jsonl`
- `/tmp/v2-native-sandFalls-cab5525f.jsonl`
- `/tmp/v2-native-utube-064728ef.jsonl`
- `/tmp/v2-native-partial-064728ef.jsonl`
- `/tmp/v2-native-tankStill-064728ef.jsonl`
- `/tmp/v2-native-yield-064728ef.jsonl`
- `/tmp/v2-native-hole-1cd24b54.jsonl`
- `/tmp/v2-native-hole-probe-533da63c.jsonl`
- `/tmp/v2-native-hole-d1897f8e.jsonl`
- `/tmp/v2-hole-lean-d1897f8e.json`
- `/tmp/v2-native-heapSand-5ddd0932.jsonl`
- `/tmp/v2-native-heapFlour-5ddd0932.jsonl`
- `/tmp/v2-native-vessel-5ddd0932.jsonl`
- `/tmp/v2-native-throw-c6625d49.jsonl`
- `/tmp/v2-native-throw-probe-e176248a.jsonl`
- `/tmp/v2-native-throw-142e6114.jsonl`
- `/tmp/v2-native-census-142e6114.jsonl`
- `/tmp/v2-native-pipe-142e6114.jsonl`
- `/tmp/v2-native-pipe-142e6114-run.log`
- `/tmp/v2-deadline-cpu-diagnostic-142e6114.log`
- `/tmp/v2-lease-smoke-c59bbdf0.log`
- `/tmp/v2-native-pipe-a2e7afe4.jsonl`
- `/tmp/v2-native-pipe-a2e7afe4-run.log`
- `/tmp/v2-native-census-c325250c.jsonl`
- `/tmp/v2-native-census-c325250c-run.log`
- `/tmp/v2-cpu-6398bdda.log`
- `/tmp/v2-native-census-1e846753.jsonl`
- `/tmp/v2-native-census-1e846753-run.log`
- `/tmp/v2-native-census-afc6ef4f.jsonl`
- `/tmp/v2-native-census-afc6ef4f-run.log`
- `/tmp/v2-cpu-main-merge-final.log`
- `/tmp/v2-build-main-merge-final.log`
- `/tmp/v2-phase-table-cpu.log`
- `/tmp/v2-phase-table-build.log`
- `/tmp/v2-native-census-5d417d93.jsonl`
- `/tmp/v2-native-census-5d417d93-run.log`
- `/tmp/v2-factory-merge-all-cpu.log`
- `/tmp/v2-factory-integration-cpu.log`
- `/tmp/v2-factory-physics-cpu.log`
- `/tmp/v2-factory-diagnostics-cpu.log`
- `/tmp/v2-factory-surface-cpu.log`
- `/tmp/v2-factory-merge-build.log`
- `/tmp/v2-factory-admission-all-cpu.log`
- `/tmp/v2-factory-admission-physics-cpu.log`
- `/tmp/v2-factory-admission-build.log`
- `/tmp/v2-native-census-32312bea.jsonl`
- `/tmp/v2-native-census-32312bea-run.log`
- `/tmp/v2-native-thermal-runtime-32312bea.json`
- `/tmp/v2-native-thermal-runtime-32312bea-run.log`
- `/tmp/v2-thermal-runtime-wrapper-cpu.log`

Remaining gates include native Factory support, lossless folded-terrain handoff, full GPU feature coverage, and reliable matched performance.
Fresh production checks, independent review, deployment, and a live-site check also remain open.
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
