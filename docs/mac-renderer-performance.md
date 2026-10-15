# Hybrid performance: current evidence

## Measured

No legacy-versus-hybrid timing result exists yet.
The first benchmark attempt stopped at the GPU safety check because utilization was 56%.
The launcher released its slot without starting a browser.
Total check and cleanup time was 2.08 seconds. The benchmark collected no samples.

Earlier native checks establish work reuse, not speed:

- A temperature-only change rebuilt zero bricks.
- Removing one boundary cell rebuilt seven of 32,768 bricks.
- The app check recorded one new shadow pass and 28 cache reuses.

The earlier 2.72-second and 15.79-second figures are complete validation-slot times.
They are not frame times or speedups.

## Cost model

The current prototype adds work before the existing volume renderer:

```text
legacy = common rendering + original volume
hybrid = common rendering + surface updates + extra shadows
       + raster surfaces + depth transfer + residual volume

hybrid wins only if:
original volume - residual volume
  > surface updates + extra shadows + raster surfaces + depth transfer
```

Static opaque surfaces offer the best opportunity.
Cached geometry removes repeated opaque hit shading. Camera motion does not rebuild the mesh.
The current depth cut does not remove the entire volume traversal.

Smooth sand, water, and smoke remain volume-rendered.
A scene with no opaque crisp surfaces has no new shading savings.
The prototype still records an empty opaque pass and depth transfer in that case.

Changing scenes can cost more.
Every new simulation version compares all 2,097,152 cells, even if material identity stays unchanged.
The GPU rebuilds only affected brick faces, but the comparison and prefix scan are not sparse.
The new shadow cache also keys on simulation version, not solely on topology.
The existing shadow and GI paths remain active.

Apple GPUs favor bandwidth-efficient rasterization and reduced unnecessary shading.
That supports the architecture, not a speed multiplier.
Extra render-pass boundaries and depth copies can consume part of that advantage.
WebGPU does not expose every native Metal tile-memory feature.

At 128³, buffer and texture sizes imply these additional resource allocations:

| Resources | Size |
| --- | ---: |
| Geometry, comparison state, and metadata | 104.50 MiB |
| 2048² raster shadow depth | 16.00 MiB |
| Material rows and mipmapped detail | 0.30 MiB |
| Subtotal | 120.80 MiB |
| Depth-copy texture at 1280×800 | 3.91 MiB |

These are resource sizes, not measured resident memory or memory traffic.
The subtotal excludes small uniforms, staging allocations, and allocator overhead.

## Benchmark procedure

The new runner is `node tools/hybrid-bench.mjs`.
Its statistics self-check passes with `--self-test`. Native execution remains unverified.

The runner uses one app and device, a 128³ grid, and fixed 1280×800 output.
Legacy trials bypass the hybrid update in the same build.
Trials use ABBA ordering, a moving camera, and normal visual cadence.
Compute passes remain unsplit. Timestamp coverage must be complete.
Compilation during measured intervals invalidates a trial.

The workloads are opaque walls, a smooth-sand control, and changing walls.
The changing-wall workload uses synthetic edits, not explosion physics.
Physics stays paused in both paths. No global frame-rate limit changes.

GPU pass time excludes copies, browser composition, and other devices.
CPU figures cover the post/render encoding call, not the entire application frame.
This short probe does not establish sustained FPS, thermals, or battery life.

The two images are not quality-equivalent.
The prototype uses sharp faces and a simpler opaque lighting model.
World rendering still falls back to the existing renderer.
Performance and image-quality comparisons remain required before deployment.

Reference: [Apple GPU and tile-based rendering guidance](https://developer.apple.com/documentation/metal/tailor-your-apps-for-apple-gpus-and-tile-based-deferred-rendering).
