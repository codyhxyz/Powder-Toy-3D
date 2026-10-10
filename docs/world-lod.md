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

## Checks

Run the CPU checks:

```sh
node tools/surface-mesh-check.mjs
node tools/detail-worker-check.mjs
node tools/far-lod-check.mjs
node tools/material-lod-check.mjs
node tools/resolution-check.mjs
node tools/check-shaders.mjs
```

Start a dedicated server:

```sh
npm run dev -- --port 5493 --strictPort
```

Run the browser checks:

```sh
node tools/idle-check.mjs 5493
node tools/world-detail-check.mjs 5493 /tmp/world-detail
```

The detail check measures coarse versus cached rendering, saves screenshots, and checks edit preservation after a window shift.
`lod-frame-bench.mjs beforePort afterPort` compares complete frames between two builds at the same output and internal resolution.

## Local measurements

The default Island view used 13.2 MB of indexed geometry, down from 43 MB with marching tetrahedra.
A planar surface uses 75% fewer triangles.
Cached geometry added approximately 2–3 ms to isolated rendering in the final local comparison.
Complete moving-camera comparisons improved by 4–18%, because settled simulation work stopped.
These shared-GPU measurements are directional, not a frame-rate guarantee.
