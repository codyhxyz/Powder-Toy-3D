# Test renderer: Metal correction

## Changes

The opaque shader uses one full-PBR call site for primary and reflected surfaces.
This avoids the native Metal compiler abort on Chrome 155 and Apple M5.
The shader retains material state, GI, shadows, lamps, reflection limits, and material LOD.

Bulk optics uses an 8×8 compute entry instead of a fullscreen fragment entry.
Both entries call the same `opticsTrace` function at pixel centers.
The compute entry writes color, metadata, and fallback flags for every pixel.
It retains field reconstruction, live-source selection, lighting, reflections, and traversal limits.
Droplets retain their fragment pipeline and a separate input-only bind group.

The compute layout uses 16 sampled textures, 8 storage buffers, and 3 storage textures.
Standalone `createHybridOptics` calls retain the fragment default.
The `bulkCompute: true` setting requires compute-compatible hooks.

Refraction uses one discriminant for total internal reflection and the transmitted direction.
This prevents a zero refracted vector from producing NaNs near the critical angle.

## Native evidence

Hardware: Apple M5, Metal 3, macOS 27.0 build 26A428.
Browser: installed Google Chrome 155.0.8059.80.
The fixture uses a physical 128³ grid and an 800×600 scene target.
Physics remains paused.

| Scene | Legacy instances | Molten-through-glass pixels | Non-finite HDR pixels |
| --- | ---: | ---: | ---: |
| Opaque-only control | 0 | 0 | 0 |
| Complete mixed scene | 0 | 324 | 0 |
| Forced-capacity fallback | 1 | 324 | 0 |
| Isolated emitter off | 0 | 0 | 0 |
| Isolated emitter off, forced fallback | 1 | 0 | 0 |

The mixed scene also covers smooth geometry, optical droplets, smoke, motion rejection, and temperature-only edits.
Leaving Test disposes its renderer and restores the normal view.
These runs completed without WebGPU errors or device loss.

The molten probe requires a glass surface, red radiance greater than 1, and red radiance greater than twice green.
The old cutoff of 2 exceeded the measured transmitted signal of 1.47.
Removing only the isolated emitter reduces maximum glass red radiance to 0.326 and removes every red-dominant glass pixel.
The larger lava source remains in that negative control.

## Repeat the checks

Run each native command separately.
The browser helper enforces the normal player guard and a 25-second total deadline.

```sh
node tools/hybrid-check.mjs
node tools/hybrid-metal-check.mjs --cpu
node tools/hybrid-full-check.mjs --chrome --test-view
node tools/hybrid-full-check.mjs --chrome --test-view --no-isolated-emitter
node tools/hybrid-full-check.mjs --chrome --test-view --control=opaque
```

The emitter-off command checks absence in both normal and forced-fallback paths.
Its result reports `passed: false` because a negative control is not rendering acceptance.

CPU checks include 201 executed WGSL refraction cases and 20 executed comparisons of old and new opaque shading.
They also cover compute layouts, pixel coverage, droplet binding separation, output retirement, and timing isolation.
Naga checks the real root shaders across six grid shapes.

These checks establish numerical correctness on this adapter, not universal driver compatibility.
Screenshots are diagnostics, not converged visual acceptance.
No benchmark or throughput claim accompanies this correction.
