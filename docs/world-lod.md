# Full-detail world rendering

The simulation window controls physics, not the limit of visible detail.

- `world/detail.js` selects every view-intersecting 32-cell column, nearest first, at step 1. There is no projected-size or distance cutoff.
- Flat and bent views retain frustum culling. Bent views use conservative warped bounds, including the parabola's interior peak.
- A pool of one to four workers builds one-cell surface meshes. The pool leaves two logical CPU cores free, where possible.
- Missing exposed meshes come first, then missing meshes fully covered by the live window, then stale replacements. Each group uses nearest-first order.
- Coverage requires the whole column: X, Z, and the full world height. Covered meshes prepare the cache for later window moves.
- Camera turns and simulation-window moves retain cached geometry. The shaders hide its fragments inside the live window.
- Live cells override stored edits. Stored edits override generated cells and trees.
- A depth pass stops liquid rays at cached geometry, preventing exterior ocean from flooding dry pits. Coarse liquid rendering, including shallow mixed occupancy, remains active.
- The fullscreen pass never shades opaque terrain, whether a mesh is ready or not, in normal/cut or flat/bent views. Far fields remain for shadows, GI, sky, haze, water and underwater bed lookup.
- Mesh vertex IDs own visible materials. Underwater bed lookup uses unwarped brick IDs; there is no far material-address jitter or temporal ID dither.
- A chunk mask changes ownership only after its mesh is ready.
- Simulation writes mark chunks and their padding stale. Summaries request replacements without removing the old meshes.
- Window transfers do not mark unchanged geometry stale. Revision checks still reject jobs from before an edit or world reset.
- Completed off-screen jobs remain cached when space permits. Empty chunks also retain their completed state.
- Uncached opaque chunks have loading gaps until their full-detail meshes arrive. They never use coarse substitutes. Camera turns and bent views can expose more gaps.
- Each worker slot holds one job through GPU readback and meshing. Every cells dispatch records its staging copy before the next dispatch.
- Jobs own separate cell and planted snapshots. Epoch, revision, and version checks prevent old results from replacing newer jobs.
- World reset rejects old results but keeps their slots occupied until completion. A fatal detail error terminates the pool and stops new jobs.
- The three detail pipelines start with the far-view pipeline at boot or view switch. Build completion wakes paused rendering without polling.
- Wanted meshes cannot be evicted by late offscreen completions. Offscreen spares keep a look-around working set, rather than shrinking it to 192 chunks or 96 MiB on a turn. Spare limits start at those values and grow to the largest wanted-view chunk count and resident bytes, multiplied by the number of horizontal views in a full turn. Chunk count cannot exceed the world. This includes intermediate views during normal mouse turns, not only opposite directions. Camera use refreshes eviction order. World reset releases the allowance. Memory use increases: the current view plus this panorama allowance can remain resident; visible geometry remains unbounded. GPU buffers, worker/readback storage and render targets also consume memory.
- Hard-only chunks skip the loose-ground normal blur, and hard faces do not sample it. Cell geometry, material IDs and normals remain unchanged.
- Completion, rejection, failure, drop and reset wake the app through the world wire. Runnable detail work prevents deep sleep even after the far lighting queue ends. Pipeline, worker/readback and window-transfer waits wake on completion instead of continuously polling, including when simulation is paused. Replicas tick render-only far/detail work without moving or simulating their window. A detail failure stops further detail submissions rather than retrying forever; remaining gaps require reload.
- Chunk padding and the common cell lattice retain mesh seams. Surface nets can have non-manifold diagonal contacts. Liquid surfaces and underwater beds still use the coarse field and may differ from the cell geometry.

The canvas size stays fixed during automatic resolution changes. Only the internal scene scale changes.
Before render-idle, the controller restores the selected quality once.
The simulation stops GPU passes only after an asynchronous read confirms that all activity channels are zero.
External writes and relevant settings invalidate that confirmation.

## Cache decision and next task

The original goals are faster underground loading and reuse after camera turns.
Commit `1f0c1738` improves hard-material meshing and passes stationary look-around reuse checks.
Cold-loading gaps remain. In-game loading latency and real memory pressure are not measured.

**Decision:** Keep the reuse fix. Do not restore the small fixed spare cache or add an arbitrary replacement cap.
The panorama allowance is a temporary policy, not a validated device-memory budget.
The review's 2 GiB example uses mocked chunk sizes. It does not establish normal usage or a safe limit.

**Next task:** Measure representative underground, outdoor, dense-terrain, travel, and return-view sequences before changing cache policy.
Record visible and spare bytes, cache misses, eviction-driven rebuilds, and time until terrain becomes visible.
Include simulation, render targets, in-flight jobs, and retired buffers when estimating total memory.
Use supported-device headroom and measured reuse to choose a budget.
Compare eviction candidates against those same sequences before deployment.
Keep world edits independent of disposable render caches.
If visible geometry alone exceeds the budget, spare eviction cannot solve the problem.
No general cache framework, additional cache tier, or benchmark platform is approved by this decision.

## GPU failures

A context loss or shader link failure stops rendering and simulation.
Browser context restoration does not restore GPU simulation contents or custom framebuffer attachments.
WebGPU port: a lost device, an uncaptured WebGPU error or a pipeline that fails to build stops them the same way.
A lost WebGPU device has no restore at all (see docs/webgpu.md B9).
The app therefore requires an explicit reload instead of continuing with invalid state.
Pending results cannot overwrite surviving CPU edits, and failed uploads retain their stored edits.
An optional bird probe stops after one readback failure instead of retrying indefinitely.
These safeguards do not identify the cause of a driver reset.

A dead GPU process first shows up as a link failure with empty logs, not as a lost context.
The context-lost event arrives a task later, and whichever program is linked next takes the blame.
The October 2026 birdProbe report was this case.
Chrome's exit code 512 is the raw wait status of exit(2), the hung-GPU code.
At the time, the react pass's cold pipeline build took 62 s on ANGLE/Metal (c0a65ed).
`src/gfx/gpuLoss.js` reports such a failure as a lost GPU process.
The report gives the wait since the last finished frame and the programs first used in that time.
It is kept as `__app.lastGpuFailure` across reloads.
`tools/program-bench.mjs --budget-s 8` fails when any program's cold build exceeds the budget.

## Checks

Run the CPU checks:

```sh
node tools/surface-mesh-check.mjs
node tools/detail-residency-check.mjs
node tools/detail-worker-check.mjs
node tools/detail-loading-cpu-check.mjs
node tools/far-lod-check.mjs
node tools/detail-culling-cpu-check.mjs
node tools/check-presentation.mjs
node tools/check-imports.mjs
node tools/resolution-check.mjs
```

GPU checks must use `tools/browser.mjs` and stay within the total slot budget in `CLAUDE.md`.
`world-detail-check.mjs` historically compared coarse versus cached rendering.
Its old fallback assertions need revision before it can validate this path.
Historical browser scripts and `lod-frame-bench.mjs` are not evidence for the new renderer.

## CPU loading check

The hard-material optimization was compared with production `2c5cb27d` in one process.
Four padded 32×96×32 fixtures alternated old and new builders for 20 rounds, discarding the first six.
Median rock time changed from 8.68 to 5.57 ms; brick changed from 7.69 to 4.95 ms.
Sand and mixed-material times were essentially unchanged.
Positions, normals, material IDs, appearances and indices matched byte-for-byte.
These are CPU mesh times, not measurements of in-game loading latency or GPU memory use.
The residency check also fills views during a continuous 360° turn and verifies that returning requires no new jobs.

## Historical local measurements

These measurements predate full-detail-only world rendering. Loading latency, total visible-memory use and rendering speed of the new path have not been benchmarked or browser-validated by this change.

The default Island view used 13.2 MB of indexed geometry, down from 43 MB with marching tetrahedra.
A planar surface uses 75% fewer triangles.
Cached geometry added approximately 2–3 ms to isolated rendering in the final local comparison.
Complete moving-camera comparisons improved by 4–18%, because settled simulation work stopped.
These shared-GPU measurements are directional, not a frame-rate guarantee.
