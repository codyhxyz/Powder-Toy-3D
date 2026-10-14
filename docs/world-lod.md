# Full-detail world rendering

The simulation window controls physics, not the limit of visible detail.

- `world/detail.js` selects every view-intersecting 32-cell column, nearest first, at step 1. There is no projected-size or distance cutoff.
- Flat and bent views retain frustum culling. Bent views use conservative warped bounds, including the parabola's interior peak.
- A worker builds one-cell surface meshes, including visible chunks inside the simulation window.
- Camera turns and simulation-window moves retain cached geometry. The shaders hide its fragments inside the live window.
- Live cells override stored edits. Stored edits override generated cells and trees.
- A depth pass stops liquid rays at cached geometry, preventing exterior ocean from flooding dry pits. Coarse liquid rendering, including shallow mixed occupancy, remains active.
- The fullscreen pass never shades opaque terrain, whether a mesh is ready or not, in normal/cut or flat/bent views. Far fields remain for shadows, GI, sky, haze, water and underwater bed lookup.
- Mesh vertex IDs own visible materials. Underwater bed lookup uses unwarped brick IDs; there is no far material-address jitter or temporal ID dither.
- A chunk mask changes ownership only after its mesh is ready.
- Simulation writes mark chunks and their padding stale. Summaries request replacements without removing the old meshes.
- Window transfers do not mark unchanged geometry stale. Revision checks still reject jobs from before an edit or world reset.
- Completed off-screen jobs remain cached when space permits. Empty chunks also retain their completed state.
- Uncached opaque chunks have loading gaps while the worker builds full-detail geometry, never a coarse substitution. Initial streaming is sequential; turning the camera or bending the view can expose more gaps.
- Wanted meshes are not limited by 192 chunks or 96 MiB and cannot be evicted by late offscreen completions. Those bounds apply only to offscreen spares, oldest first. Total visible geometry memory is therefore not bounded by these cache limits. GPU buffers, worker/readback storage and render targets also consume memory.
- Completion, rejection, failure, drop and reset wake the app through the world wire. Runnable detail work prevents deep sleep even after the far lighting queue ends. Pipeline, worker/readback and window-transfer waits wake on completion instead of continuously polling, including when simulation is paused. Replicas tick render-only far/detail work without moving or simulating their window. A detail failure stops further detail submissions rather than retrying forever; remaining gaps require reload.
- Chunk padding and the common cell lattice retain mesh seams. Surface nets can have non-manifold diagonal contacts. Liquid surfaces and underwater beds still use the coarse field and may differ from the cell geometry.

The canvas size stays fixed during automatic resolution changes. Only the internal scene scale changes.
Before render-idle, the controller restores the selected quality once.
The simulation stops GPU passes only after an asynchronous read confirms that all activity channels are zero.
External writes and relevant settings invalidate that confirmation.

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

## Historical local measurements

These measurements predate full-detail-only world rendering. Loading latency, total visible-memory use and rendering speed of the new path have not been benchmarked or browser-validated by this change.

The default Island view used 13.2 MB of indexed geometry, down from 43 MB with marching tetrahedra.
A planar surface uses 75% fewer triangles.
Cached geometry added approximately 2–3 ms to isolated rendering in the final local comparison.
Complete moving-camera comparisons improved by 4–18%, because settled simulation work stopped.
These shared-GPU measurements are directional, not a frame-rate guarantee.
