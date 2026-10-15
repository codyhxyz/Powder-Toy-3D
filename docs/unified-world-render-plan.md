# Unified world renderer: implementation contract

Status: implementation in progress. Phase 1 raw source authority is connected;
CPU/Naga validation is not GPU numerical or visual acceptance. The existing
visible renderer is unchanged. Neither this phase nor the water/shadow
checkpoint completes the unified renderer.

PHASE3b-1 now provides the disabled shared full world shader backend and native
world-volume assembly: [interface, finalized sun ABI, caller protocol and CPU
limits of evidence](world-shader-backend.md). Box shader/layout hashes remain
unchanged. Source/Field→Atlas providers, full lighting producers, complete-frame
presentation and application switching are NOT implemented by that assembly.

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

## Phase 1 source handoff

`src/world/renderSource.js` owns lazy world-aligned 32³ raw cores using the
original 4³ supertile/tile cell layout. A/B transport is native, lossless GPU
buffer copying; generated sources run the actual sceneCell WGSL. Each cell has
explicit authority/revision/validity, so partial intersections do not imply
empty space or permit a late static result over live/captured/saved state.

Public recording API (all bounds are half-open WORLD cells):

- `recordLiveCopy(frame, sim, bounds = sourceBounds(sim))`
- `recordLeavingCopy(frame, sim, bounds, oldOrigin)` returns an epoch/revision token
- `recordPopulate(frame, rawDescriptor, token)`; descriptor supplies
  `g, origin, A, B, copy`, optional `bounds`, and `kind: generated|saved`.
  Capture `token()` **before** awaiting asynchronous work.
- `recordStore(bounds, token)`, `commitStoreRevision(keys, token)`,
  `restoreCaptured(frame, sim, bounds)`, `needsLiveCopy(sim)`, `getSource(cell)`, `bindings`,
  `reset(epoch)`, `dispose()`.
- `contentRevision`, `contentToken()` => `{epoch, sourceRevision}`: semantic
  content/dependency identity, distinct from ownership/store-ordering `revision`.
  Pure generated/saved/captured/live copies, origin and buffer transfers leave
  this token unchanged. Actual edits/steps, flow resets, aeration writes/resets/
  drops, deco writes/resets/undo, and scene-data changes advance it immediately.
  Direct writers outside Simulation (POV transfers, industry, v2) hook it too.
  Only individual residency fill/restore/fresh/plant writers opt out; no mutable
  suppression flag spans callbacks or awaits. New semantic writers must call
  `noteContentChange()`; `sim.version` alone mixes residency and edits.
- `snapshotForFields({jetValidity})` pins that content token as `sourceRevision`,
  provides `isCurrent()`, complete in-world bounds checks, and native raw/aux
  gather helpers. It refreshes live data before pinning, never reads GPU state
  back to CPU, and rejects semantic changes/epoch resets. Pure residency can
  preserve the pinned snapshot. Missing raw neighbors throw before encoding;
  absent aux is explicitly zero. Allocations remain source-owned until epoch
  reset/disposal; callers must retain them through queue completion.

The parent provider adapter still owns field epoch/tick/dirty scheduling and
wake-provenance validation. `jetValidity` has **no default attestation**: raw
storage does not prove bounded imported jets. WorldFields must reject this
snapshot until the adapter supplies the validated `producer-bounded-v1` claim.
Use content `sourceRevision`, never `bindings.revision`, for field identity.

`WorldWindow` records outgoing copies before origin/cur mutation and restores
captured authority after incoming fill/store but before tree population/live
publication. Native re-entry restores run the existing prewarmed fresh-flags
pass before the next simulation map. Actual simulation steps refresh raw source; window updates also
capture non-step version changes and auxiliary resource/copy/reset changes.
Disabled-but-kept aeration is discovered through a read-only ownership accessor;
its history is not confused with an absent/dropped field. A later consumer recording after edits but
before a window update must explicitly call `recordLiveCopy` first. Binding
getters do not secretly submit work. Copies snapshot buffer selection, origin,
and offsets, never a mutable shared header.

`RawWorldSourceProducer.record(frame, [coreX,coreZ], token, {physicsBounds})`
is synchronous command recording **after** `ready`; async callers keep the
pre-await token. It constructs 64×worldHeight×64 scratch columns (16-cell x/z
halo), not a Simulation. The entire world-height column proves vertical footing
support; shared `stampLib` reads no adjacent x/z columns. Tree candidates include
roots outside the core, retain original world brick order, and use actual baked
rotation/base/footing. Masks are by **target column**, never visited root: a
planted root cannot suppress an unvisited crown. Exact saved/captured/edited
cells support stamps but are protected from stamp writes. The window consumes
the same stamped raw producer, applying only actual fresh-column stamp/footing
writes and noting the write before publishing complete live authority.

Persistence selection now compares complete bitcast A/B, including air seed,
velocity, pressure, signed zero, and small heat/life differences. BrickStore's
existing codec is byte-lossless. This can increase save size; cost is unmeasured.
Out-of-order leaving reads use protected output buffers and per-key store
revisions. Store acknowledgement releases pending A/B protection, **not** aux
ownership. Flow/aeration/deco snapshots stay separately owned in raw cores;
saved deco is decoded too. No source eviction policy has been introduced.
Growing source residency and native-copy/metadata overhead remain unmeasured.

Aux history extension: `auxContract` declares exact packed flow/aeration/deco
formats and their available bits (absent/dropped live aux is explicitly cleared,
not resurrected from an older owned buffer). A/B acknowledgement does not persist flow or
aeration. EMA/GI and renderer-owned temporal fields are intentionally not copied:
phase 2 must establish persistent world history and single-tick ownership.
Imported `importManifest`/`appearanceWords` and scene identity stay in bindings;
SourceStyle remains view policy, never physics-residency policy.

CPU gate: `node tools/world-render-source-cpu-check.mjs`.
CPU-only actual WGSL validation (requires Naga):
`node tools/world-render-source-wgsl-cpu-check.mjs`.
These exercise copy/authority/producer command wiring and assembled production
scene/stamp/persistence modules; they do not execute GPU tree math or establish
partitioned field, HDR, visual invariance, memory affordability, or performance.
Phases 2–6 remain required; no atlas, field derivation or optical renderer is
enabled here. Do not deploy this phase as the requested completed fix.

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
