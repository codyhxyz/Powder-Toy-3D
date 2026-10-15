# Hybrid performance: current evidence

## Measured

No legacy-versus-hybrid timing result exists yet.
The first benchmark attempt stopped at the GPU safety check because utilization was 56%.
The launcher released its slot without starting a browser.
Total check and cleanup time was 2.08 seconds. The benchmark collected no samples.
The later full-scene correctness check was also refused, at 55% utilization.
It used 2.09 seconds and did not launch a browser.

Earlier native checks establish work reuse, not speed:

- A temperature-only change rebuilt zero bricks.
- Removing one boundary cell rebuilt seven of 32,768 bricks.
- The app check recorded one new shadow pass and 28 cache reuses.

The earlier 2.72-second and 15.79-second figures are complete validation-slot times.
They are not frame times or speedups.

## Cost model

The integrated path replaces normal primary volume traversal:

```text
legacy = common rendering + original primary volume
hybrid = common rendering + producer updates + raster shadows
       + opaque/particle raster + dedicated optics + reduced-resolution media
       + composition, depth transfer, and motion capture

hybrid wins only if:
removed primary work > the replacement work
```

Static opaque surfaces offer the best opportunity.
Cached geometry removes repeated opaque hit shading. Camera motion does not rebuild the mesh.
Normal accepted frames give the legacy primary draw zero GPU instances.
Capacity failures can enable it in the same frame.
Smooth sand has cached vertices. Water/glass have dedicated transport.
Isolated liquids use instanced optical billboards.
Smoke, steam, and fire use a bounded lower-resolution integration.
Empty optical/media bounds skip their expensive traversal, but not all fullscreen overhead.

Changing scenes can cost more.
Every new simulation version compares all 2,097,152 cells, even if material identity stays unchanged.
The GPU rebuilds only affected brick faces, but the comparison and prefix scan are not sparse.
The new shadow cache also keys on simulation version, not solely on topology.
The existing shadow and GI paths remain active.
The old shadow map still serves the shared GI backend.
The new raster map serves direct surface shading.
Motion capture also compares previous cell identities when raw state changes.
Adaptive trials freeze while paused and cancel evidence across changed camera workloads.
They retain the last accepted allocation during camera motion.

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
| Two default smooth vertex arenas | 64.00 MiB |
| Default four-channel particle arena | 32.00 MiB |
| Previous cell identities for motion | 16.00 MiB |
| Listed subtotal | 232.80 MiB |

These are resource sizes, not measured resident memory or memory traffic.
The subtotal excludes field bounds, smooth metadata, uniforms, staging, and allocator overhead.
It also excludes output-sized optics, media, motion, coverage, and depth textures.
Those targets grow with the selected rendering resolution.
Unified memory does not make these allocations or their bandwidth free.

## Benchmark procedure

The new runner is `node tools/hybrid-bench.mjs`.
Its statistics self-check passes with `--self-test`. Native execution remains unverified.

The runner uses one app and device, a 128³ grid, and fixed 1280×800 output.
Legacy trials bypass hybrid preparation before Derived assigns field ownership.
Trials use ABBA ordering, a moving camera, and normal visual cadence.
Compute passes remain unsplit. Timestamp coverage must be complete.
Compilation during measured intervals invalidates a trial.

The workloads are opaque walls, smooth sand, and changing walls.
The changing-wall workload uses synthetic edits, not explosion physics.
Physics stays paused in both paths. No global frame-rate limit changes.

GPU pass time excludes copies, browser composition, and other devices.
CPU figures cover the post/render encoding call, not the entire application frame.
This short probe does not establish sustained FPS, thermals, or battery life.

The two images are not quality-equivalent.
The prototype uses sharp faces and shared compact lighting.
Straight world windows are eligible; curved presentation still falls back.
Far-terrain LOD remains the existing subsystem.
Performance and image-quality comparisons remain required before deployment.

Reference: [Apple GPU and tile-based rendering guidance](https://developer.apple.com/documentation/metal/tailor-your-apps-for-apple-gpus-and-tile-based-deferred-rendering).
