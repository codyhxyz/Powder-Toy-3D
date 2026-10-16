# Mac-first realistic renderer

## Scope

Build the approved raster-first hybrid renderer on the existing WebGPU engine.
Keep simulation rules, saves, imported artwork, data views, and the existing
renderer intact. The parent integrates the new path behind `?renderer=hybrid`
until native-GPU validation proves it can replace the default.

Fetched production base: `375301e7bd4a05afab9ebf130c6f90e930bd2309`.
Integration checkout: `/Users/codyhergenroeder/code/claude/threejs-tpt-gpu-mac-build`.
The recovery checkout is not a source, dependency, build, or deployment directory.
Children work only in their tool-assigned managed worktrees based on this checkout.

## Implementation status: October 16, 2026

**All 12 features now have application wiring and CPU checks. Native acceptance is incomplete.**
Production still uses the existing renderer. This is not a completed or deployed rewrite.
Correctness-only GPU work resumed when the shared lease became free.
Use the normal safety guard. Do not override a busy player or another agent's lease.
Performance measurement remains deferred.

The first eleven workers and six recovery workers timed out.
Their work was preserved. Focused follow-ups completed the missing producers.
The earlier opaque-only delivery did not meet the approved scope.

Use `?renderer=hybrid&view=realistic` to select the experimental path.
Normal sand, terrain, water, glass, smoke, and isolated matter have dedicated owners.
The GPU gives the legacy volume zero instances when the new scene is accepted.
Capacity failures select an exceptional legacy draw in that same frame.
Particle draws remain paired with their field exclusion during that fallback.

| Approved feature | Application implementation | CPU evidence |
| --- | --- | --- |
| 1. Surface change tracking | Exact ID comparison and neighbouring-brick invalidation | `hybrid-core-check.mjs` |
| 2. Opaque meshes | Persistent packed faces and one indirect draw | `hybrid-core-check.mjs` |
| 3. PBR materials | Shared rows, world-stable mipmapped detail, explicit texture LOD | `hybrid-core-check.mjs`, `hybrid-shading-check.mjs` |
| 4. Raster sun shadows | One cached map with opaque, smooth, and particle casters | `hybrid-core-check.mjs`, `hybrid-particles-check.mjs` |
| 5. Shared lighting/GI | Shared sun, sky, lamps, emission, and existing world-space probes | `hybrid-shading-check.mjs` |
| 6. Smooth terrain | Dirty-field extraction into compact cached vertices | `hybrid-smooth-check.mjs` |
| 7. Water/glass | Dedicated bounded transport, mixed IOR, absorption, hidden-surface shading | `hybrid-optics-check.mjs` |
| 8. Smoke/steam/fire | Bounded lower-resolution integration and depth-aware composition | `hybrid-media-check.mjs` |
| 9. Grains/droplets/debris | Four-channel isolated-cell instances; separate optical droplet billboards | `hybrid-particles-check.mjs`, `hybrid-optics-check.mjs` |
| 10. Temporal reconstruction | Camera/model motion, identity-checked particles, current/previous translucent coverage | `hybrid-motion-check.mjs`, `hybrid-temporal-check.mjs` |
| 11. Adaptive rendering | Completed render-pass timings, generation checks, effects-first policy, full-quality idle recovery | `hybrid-resolution-check.mjs`, application composition checks |
| 12. Selective reflections | Bounded roughness/coverage gating and nonrecursive shared hit shading | `hybrid-shading-check.mjs` |

These checks include numerical references, recording mocks, resource limits, and Naga semantic compilation.
They do not prove native pixels, equal image quality, frame rate, thermals, or battery use.

Known limits remain:

- Crisp opaque faces are sharp, not bevelled.
- Source artwork, visible decoration, data views, and curved presentation retain the existing renderer.
- Straight world windows use the new local producers. Far-terrain LOD remains the existing subsystem.
- The raster sun map has local opaque casters, not off-window terrain or coloured transparent shadows.
- Unknown deformation and external animation reject history rather than invent motion.
- Visible transparent Three meshes conservatively reject history for the whole frame.
- Adaptive trials require a held camera and comparable producer diagnostics. Paused frames freeze adaptation.
- Reflection resolution policy changes the tracing budget; reflections have no separate half-resolution image.
- Unsupported hardware capacity is explicit. The new path does not silently truncate a producer.
- Exceptional fallback traces complete optical paths without reusing legacy-composited snapshot radiance.

### Validation

Validate correctness first. Run performance comparisons only after correctness and visual acceptance.

CPU checks (no browser or physical GPU):

```sh
node tools/hybrid-check.mjs
node tools/hybrid-readback-cpu-check.mjs
node tools/check-sampler-budget.mjs
node tools/post-reuse-cpu-check.mjs
node tools/view-inputs-check.mjs
node tools/resolution-check.mjs
node tools/check-ready-volume-view.mjs
node tools/render-read-cpu-check.mjs --naga
node tools/pipeline-safety-cpu-check.mjs
node --experimental-vm-modules --test tools/startup-safety-cpu-check.mjs
node tools/check-imports.mjs
node tools/check-state-access.mjs
node tools/check-async-reads.mjs
node tools/check-browser-launch.mjs
npm run build
```

The hybrid runner passes all nine suites. Its actual composition and shader/layout checks cover
32³, 64³, 128³, 160×96×160, 256×96×128, and 128×384×128 grids.
It now runs in the deployment workflow.

The broader CPU pass also passed these regression groups:

- Startup, compiler cancellation, GPU deadlines, readback failure, and input wake-up.
- Post-only reuse, resolution handoff, retained-view readiness, reflection roots, and opaque transitions.
- Terrain loading, residency, workers, culling, far LOD, surface seams, and packed terrain shader validation.
- Material, source artwork, crystal transmission, and straight/curved presentation invariants.
- Element mechanisms, imports, state access, the build, and shipped local maps.

With upstream `3c1129cb` merged, the engine resource catalog passes 467 pipelines and 1,376 grid variants.
The hybrid composition is checked separately by the hybrid runner.
The async-read lint reports eight pre-existing pending reads in four unrelated legacy tools.
After the latest upstream merge, it also fails on six calls inside deadline wrappers in upstream industry fixtures.
It reports no hybrid-file violations. No new hybrid file is exempted.

Correctness-only native checks use separate, serialized GPU slots. They are not benchmarks:

```sh
node tools/hybrid-gpu-check.mjs
node tools/hybrid-app-check.mjs
node tools/hybrid-full-check.mjs
node tools/hybrid-full-check.mjs --readback-only
node tools/hybrid-full-check.mjs --readback-controls
node tools/hybrid-full-check.mjs --mixed-readback-controls
```

The earlier opaque-only M5 native core check passed with a 128³ grid.
Heating a cell rebuilt zero bricks. Removing a boundary cell rebuilt seven bricks.
The overflow fixture suppressed the entire mesh. Covered-pixel checks passed.
The successful slot occupied 2.72 seconds, including startup and cleanup.

The earlier app check passed opaque hybrid rendering, residual volume composition, data-view fallback, and default rendering.
It advanced no physics steps. The successful slot occupied 15.79 seconds.
The local account/AI relay was offline. The check records that specific network error separately.
Other native attempts exposed a barrier error, a fixture error, and a layout-name collision.
Those errors are corrected. This evidence does not cover the later full composition.

The correctness-first full-scene attempt was refused at 56% GPU utilization.
No browser launched. Guard and cleanup occupancy was 2.043 seconds.
The full-scene check includes visible optics/media, smooth vertices, isolated droplets,
motion and reactive pixels, finite HDR, temperature-only reuse, and zero legacy instances.
It also injects a GPU capacity flag and checks molten matter transmitted through glass.

Native correctness and visual review remain pending. They precede performance measurement.
No benchmark was run during this correctness-first pass.

#### Native follow-up: failed checks and readback controls

- A guarded attempt was refused at 69% utilization; no browser launched (2.088 seconds total).
- A busy-player override run was stopped by the watchdog. Its verified occupancy was 21.116 seconds, including cleanup.
- A diagnostic run reached scene rendering, then failed the cached-smooth assertion (10.014 seconds total).
- Direct GPU probes returned empty fixture cells and zero producer/indirect buffers (10.077 seconds total).
  Later known-value probes showed that some post-render readbacks were stale.
  Those early zero reads do not establish that the actual simulation state was empty.
- These are failed checks, not native acceptance or performance results. No visual acceptance was obtained.
- Startup phases and fatal errors now stream immediately; CPU tests cover the fail-fast observer.
- The fixture now waits for startup and the queued preset clear before painting.
- Required cells use density-compensated paint rates. Normal water painting has a 35% spawn chance.
- Its glossy solid uses CLONE's metallic material, with roughness 0.25.
  Ordinary METAL has roughness 0.32, outside the default traced-reflection cutoff of 0.30.
  The runner validates this material condition before acquiring a GPU slot.
- After the shared slot became free, correctness-only checks resumed without a busy-player override.
- Concurrent uploaded and compute-written readback sentinels passed natively before scene rendering (5.116 seconds total).
- Empty legacy/hybrid readback controls passed (6.425 seconds total).
  The same mixed fixture passed paired readback controls (7.950 seconds total).
  These checked reads around two frame attempts, not accepted images.
- Some full-check attempts returned stale pooled bytes after rendering.
  Fresh staging also returned incorrect zeros. No pooling-only fix is justified.
  Validation scopes and native stderr did not identify the cause.
  The real frame/readback CPU regression passes, including concurrent copies and staging reuse.
- The checker no longer replaces post or shadow methods to inspect a frame.
  Post exposes a read-only snapshot of its selected temporal inputs instead.
  Later native runs returned valid fixture cells and GPU producer buffers.
  This does not prove that the earlier intermittent readback failure is fixed.
- The latest pixel check still failed (5.671 seconds total).
  It read 71,004 smooth vertices, four particle instances, and zero normal legacy instances.
  Optical-entry and glossy-solid pixels were present. Media, motion, reactive, and droplet checks did not pass.
- Its diagnostic screenshot showed a black canvas and the close-up-detail preparation message.
  Two manual frame attempts are not proof of two completed scenes.
  The checker now waits for cold pipeline requests between bounded attempts.
  This readiness change still needs native validation.
- The full numerical check is not a converged visual check.
  Failure screenshots remain diagnostic artifacts, not image-quality acceptance.
- Every completed slot closed its own browser and test server. No benchmark samples were collected.

Independent review found five integration defects and a later mid-frame flush defect.
The following CPU regressions cover their fixes:

- Smooth camera/shadow vertices have their own vertex-readable state layout and matching bind group.
- CPU composition checks compare reflected entry-point resources with actual stage visibility.
- Overflow keeps the complete optical layer, including particles behind glass/water.
  Its background remains legacy. No extra droplet-only fullscreen composition pass is needed.
- Optics receives depth captured before legacy transmitting/media surfaces write depth.
  Unmeshed opaque world surfaces still stop fallback rays.
- Output retirement protects the last open consumer encoder, even after automatic submission.
  A legal mid-frame encoder change is not a stale-frame error.
- Motion/coverage capture follows transparent Three meshes and rejects their unknown blended motion.
- Resolution submissions capture pause state and workload epochs. Changed views cannot validate old trials.
- Legacy thumbnails temporarily build complete fields, then restore particle exclusion even after an error.

Follow-up review found no remaining concrete P1/P2 defects in these fixes.
Native acceptance is still required.
Performance evidence and the blocked benchmark attempt are recorded in
[`mac-renderer-performance.md`](mac-renderer-performance.md).

## Ownership

| Lane | Owns | Initial delivery |
| --- | --- | --- |
| geometry | `src/gfx/hybrid/geometry.js`, `src/shaders/hybrid/geometry.js`, lane tests | GPU surface-change tracking, persistent per-brick opaque faces, indirect drawing |
| materials | `src/gfx/hybrid/materials.js`, `src/shaders/hybrid/materials.js`, lane tests | Shared PBR material rows and mipmapped texture detail |
| shadows | `src/gfx/hybrid/shadows.js`, `src/shaders/hybrid/shadows.js`, lane tests | Cached raster sun shadow with multiple surface casters |
| lighting | `src/gfx/hybrid/lighting.js`, `src/shaders/hybrid/lighting.js`, lane tests | One shader library using the current sun, sky, lamps, emission, and GI probes |
| smooth | `src/gfx/hybrid/smooth.js`, `src/shaders/hybrid/smooth.js`, lane tests | GPU surface extraction from existing granular/organic fields |
| optics | `src/gfx/hybrid/optics.js`, `src/shaders/hybrid/optics.js`, lane tests | Dedicated water/glass surfaces and bounded optical traversal |
| media | `src/gfx/hybrid/media.js`, `src/shaders/hybrid/media.js`, lane tests | Depth-bounded, reduced-resolution volume integration and depth-aware composition |
| particles | `src/gfx/hybrid/particles.js`, `src/shaders/hybrid/particles.js`, lane tests | GPU instances for isolated existing matter, not new simulation |
| temporal | `src/gfx/post.js`, `src/gfx/hybrid/temporal.js`, lane tests | Optional explicit object motion/reactive rejection in existing TAAU |
| resolution | `src/gfx/hybrid/resolution.js`, lane tests | Measured-cost resolution control preserving user quality and idle behavior |
| reflections | `src/gfx/hybrid/reflections.js`, `src/shaders/hybrid/reflections.js`, lane tests | Roughness/coverage-gated bounded reflections with sky fallback |
| parent | `src/app.js`, `src/gfx/hybrid/index.js`, shared build/check wiring | Lifecycle, pass order, application selection, cross-lane integration and review |

No child changes another lane's files or the shared app integration.
Tests use `tools/hybrid-<lane>-check.mjs`; additional test files keep that prefix.
Send required out-of-lane edits to the parent as a concrete patch recommendation.
Do not create placeholder subsystems or claim a shader-string check is a GPU test.

## Integration conventions

- Reuse `gpu.kernel`, `gpu.renderPipeline`, `gpu.frame`, explicit bind layouts,
  asynchronous pipeline creation, and `FrameUniforms`. Do not add an engine.
- Grid coordinates are cell coordinates. Use `FU.model` and `FU.viewProj`
  for display; preserve the physical-world positions used for lighting.
- HDR is linear, premultiplied `rgba16float`; depth is WebGPU `[0, 1]`.
- GPU work stays GPU-resident. No full-volume CPU readback, synchronous GPU wait,
  or submission in a render hook. No pipelines built inside a draw loop.
- Modules own and dispose their allocations. Public lifecycle:
  `createHybridX(gpu, sim, options)`, `.ready`, `.isReady`, `.stats`,
  `.update(frame)`, appropriate `.draw(...)` / `.record(...)`, `.dispose()`.
  Pure shader/math modules may use a smaller API.
- A frame argument can contain `{ sun, model, camera, size, dt, revision,
  meshDepth, color, depth, shadow, materials, lighting }`. Only use required
  fields; document exact resource types at the consuming method.
- Mesh producers expose a caster hook `drawShadow(rp, { matrix })`, or document
  the descriptor that a shadow owner needs to draw their existing buffers.
- Material and lighting shader snippets accept configurable bind group/binding
  indices. Export their binding descriptors and bind entries alongside WGSL.
  Do not silently change the shared engine's binding ABI.
- Geometry/smooth/particles first deliver usable geometry and a working baseline
  draw path. Accept optional material/light shader snippets or expose enough
  geometry resources for the parent to wire the shared shading.
- Preserve decoration and source appearance, or explicitly exclude unsupported
  cases from the hybrid path and fall back to the current renderer.
- Reset caches on grid replacement, window shifts, edits, undo/load, and device
  loss. A resting world must not acquire perpetual rendering or dispatch work.
- Geometry capacity overflow must be visible and safe, not missing surfaces.
  Retain the legacy renderer as fallback when the new path cannot cover a case.
- Each pass draws a disjoint matter class. Smooth/grain/optics classification
  must not silently hide thin features or draw the same matter twice.
- Native Metal ray tracing and tile shaders are not assumed available in WebGPU.
- Keep the baseline path deterministic. Use temporal accumulation to improve
  resolution, not to make a noisy baseline acceptable.

## Parallelism and validation

Each lane implements and CPU-tests in its own worktree. No child launches a
browser, GPU compiler, GPU benchmark, persistent server, or deployment.
The parent owns serialized GPU validation under the repository's 25-second
total occupancy limit, including startup, warmup, checks, and cleanup.
Children can add a browser check for the parent but must not execute it.

Use small pure tests and mocked GPU lifecycle/command checks where appropriate.
Report source generation, parser checks, numerical tests, and native GPU tests
separately. Do not assert performance improvements without measurements.

The parent reviews every lane, resolves integration requirements, and compares
the combined rebuild-and-render cost against the existing marcher in static,
close-up, and high-change scenes. Deployment follows successful integration
and regression checks; an unvalidated rewrite does not replace production.

## Current contracts

- The geometry producer compacts persistent face references on the GPU.
  Camera frames use one indirect draw per producer, not one draw per brick.
- The material entry point is
  `hybridMaterial(id:i32, seed:f32, gridPosition:vec3f, normal:vec3f, temperature:f32)`.
  The seed is in `[0, 1)`. Temperature is in Celsius.
- `HybridMaterial` contains `baseColor`, `roughness`, `metalness`, `emission`,
  and `opacity`. It can also contain `normal` and `f0`.
- Shared lighting uses
  `hybridShade(material, gridPosition, geometricNormal, shadingNormal, viewDirection, sunVisibility, ao)`.
  It returns premultiplied HDR color. `sunVisibility` is an explicit RGB argument.
  Physical grid axes define all directions. The view direction points toward the eye.
- Shared resources use configurable binding offsets. The opaque pipeline uses
  group 2 binding 0 for faces, 1–4 for materials, 5–10 for lighting,
  11–13 for shadows, 14 for reflection controls, and 15 for scene acceptance.
  Each final pipeline must pass the engine's resource-limit checks.
- Shadow casters expose `drawShadow(rp, { matrix })`, `isReady`, and `revision`.
  The matrix maps physical grid coordinates to light clip coordinates.
  The shadow texture uses `depth32float`. An unavailable caster returns `false`.
- Optics and reflections use compact, nonrecursive world-hit shading callbacks.
  The parent composes those callbacks from shared materials and lighting.
  Screen-color reprojection is valid only when scene depth confirms the hit.
- Particles now own isolated liquid, molten, granular, and organic cells.
  The ownership predicate checks all 26 neighbouring cells across brick boundaries.
  Derived fields remove those same cells after history blending.
  Liquids and molten droplets use instanced optical transport, not opaque spheres.
  Glass remains with bulk optics. The tight instance bound is half the cell count.
- Media can expose `hybridMediaSegment(ro, rd, tNear, tFar)` for refracted paths.
  This function returns premultiplied radiance with opacity in alpha.
  A front-media pass must stop at the nearest optical interface when optics uses this hook.
  The composed optics and media passes now use this ordering.
- Temporal inputs are frame-local. Explicit motion includes camera and presentation motion.
  Unknown simulation correspondence rejects history instead of inventing motion.
  Hybrid rendering does not reuse the old color/depth-only mesh-frame cache.
