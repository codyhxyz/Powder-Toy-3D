# World rendering and LOD

The simulation window controls physics, not the limit of visible detail.

- `world/detail.js` selects visible 32-cell columns by projected size.
- A worker builds one-cell surface meshes outside the simulation window.
- Live cells override stored edits. Stored edits override generated cells and trees.
- A depth pass stops coarse rays at cached geometry. Coarse liquid rendering remains active.
- A chunk mask changes ownership only after its mesh is ready.
- Edits invalidate affected chunks and their padding. Revision checks reject old worker results.
- Uncached chunks retain the coarse field while the worker builds their geometry.
- The cache retains at most 96 chunks and 96 MiB of geometry arrays.
  GPU geometry duplicates those arrays. Worker storage and render targets are additional memory.
- The coarse and fine boundaries can have small shape differences. Surface nets can have non-manifold diagonal contacts.

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
node tools/detail-worker-check.mjs
node tools/far-lod-check.mjs
node tools/material-lod-check.mjs
node tools/resolution-check.mjs
node tools/check-shaders.mjs     # WebGPU port: replaced by check-imports.mjs here and check-wgsl.mjs,
                                 # which validates WGSL in headless Chromium (see docs/webgpu.md I1)
node tools/gpu-readback-check.mjs
```

Start a dedicated server:

```sh
npm run dev -- --port 5493 --strictPort
```

Run the browser checks:

```sh
node tools/idle-check.mjs 5493
node tools/world-detail-check.mjs 5493 /tmp/world-detail
node tools/gpu-failure-check.mjs 5493
node tools/gpu-process-loss-check.mjs 5493
```

The detail check measures coarse versus cached rendering, saves screenshots, and checks edit preservation after a window shift.
`lod-frame-bench.mjs beforePort afterPort` compares complete frames between two builds at the same output and internal resolution.

## Local measurements

The default Island view used 13.2 MB of indexed geometry, down from 43 MB with marching tetrahedra.
A planar surface uses 75% fewer triangles.
Cached geometry added approximately 2–3 ms to isolated rendering in the final local comparison.
Complete moving-camera comparisons improved by 4–18%, because settled simulation work stopped.
These shared-GPU measurements are directional, not a frame-rate guarantee.
