# Unified world renderer: implementation contract

Status: implementation in progress. The water/shadow checkpoint is not completion.

## Required result

Physics stays local. Graphics do not select quality from physics residency.
Use the existing full surface, liquid, glass, media, material, and lighting rules
throughout the world. Do not replace them with outside-only proxy shading.
Keep world-space artwork, mixtures, temperatures, cell types, seeds, and histories.
Keep culling and texture anti-aliasing. Add no coarse visible fallback, fog,
distance cutoff, frame-rate change, or geometry-resolution tier.

Chunks own data and derivation work. They are not independent optical domains.
Primary and secondary rays must continue across chunk boundaries.

## Architecture

1. `WorldRenderSource` owns full-state, world-addressed source chunks.
   Use fixed 32-cubed construction chunks and 4-cubed residency bricks.
   Current live cells override captured outgoing cells, which override saved
   cells, which override generated cells and unvisited tree stamps.
2. Capture departing GPU state before the physics window shifts. Keep it until
   persistence catches up. Reject late results by epoch and source revision.
   Restore authoritative captured state on re-entry when persistence is pending.
3. Preserve the original A/B bit patterns. Do not use the old ID/half-heat staging
   format. Preserve render-relevant flow, aeration, and decoration state.
   Share actual cell initialization and tree stamp/footing rules with physics.
4. Extract render field derivation without creating another physics simulation.
   Use the existing EMA, Gaussian weights, intermediate packing, peak, thin-film,
   and aeration calculations. A conservative 16-cell raw halo gives a 64-cubed
   scratch domain. Prove support; do not infer it from mesh padding.
5. Each world's cell history has one owner. Halo readers must not independently
   advance duplicated EMA. Keep history across physics shifts and atlas moves.
6. Add explicit sparse world layouts and accessors. A/B can use lossless uint
   atlases; fields use their existing final formats. Manually interpolate across
   page boundaries first. Missing data is not empty space.
7. Compile the existing full ray renderer and shading library against world
   accessors. Use one world camera/model. Physics origin belongs to capture
   parameters, not to rendering policy. Remove physics-edge fades and tails.
8. World-address GI, glow, AO, local lights, reflection/refraction, and optical sun
   shadows too. Do not stop those rays at a construction chunk's edge.
9. World view draws one shared volume path, not a live volume plus proxy meshes.
   Integrate picks, presentation, figures, hands, paused/replica scheduling,
   stills, imported appearances, and data views before enabling that path.

## Default limits

Do not append resources to the already-full local volume layout.
Define separate world reader/writer layouts and validate every variant:
eight storage buffers, sixteen sampled textures, four bind groups, and a
128 MiB storage-buffer binding maximum. Imported source appearances need a slot.

A dense 4-cubed page table needs 24 MiB for 3072x128x1024, or 72 MiB at height
384. Sparse allocation is necessary; allocating a whole-world Simulation is
not this plan. Grow resident storage without reducing wanted data resolution.

## Mechanical phases

1. Full-state source cache, GPU live/outgoing capture, generated/store/tree
   equivalence, delayed-persistence protection, epoch/revision tests.
   Do not change visible rendering in this phase.
2. Shared field derivation and persistent world EMA; partition-versus-contiguous
   numerical tests, including quantized intermediate stages and halos.
3. Explicit atlas layouts/world access and continuous primary full-quality rays.
4. Continuous secondary rays, full materials, shared optical shadows and GI.
5. Application integration and removal of the remaining world proxy draw split.
6. Independent review, invariance validation, deployment, and live-site checks.

Do not deploy an incomplete phase as the requested fix.

## Acceptance

Keep camera, contents, clock, jitter, lighting, and random frame fixed. Move
physics origin from [1536,0,512] to [1552,0,512] without stepping.

- Compare complete source words and histories across the departing slab.
- Sample either side of physics, 32-cell construction, and 4-cell page borders.
- Compare partitioned fields to the same contiguous, quantized calculation.
- Compare hits, normals, full material state, deterministic HDR, and depth.
- Cross multiple pages with water, glass, smoke, reflections, and GI rays.
- Include offscreen casters, world corners, height 384, delayed storage, edits,
  curved presentation, reversed job order, and imported source materials.
- A physics-origin change alone must not change graphics policy or artwork.

CPU and WGSL checks do not prove GPU appearance or speed. Use guarded GPU tests
within the current repository slot limit; report total measured occupancy.
Do not override player detection. No performance claim without measurements.
