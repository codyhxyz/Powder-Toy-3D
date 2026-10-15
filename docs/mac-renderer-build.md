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

## Implementation status: October 15, 2026

**This renderer is incomplete. Production still uses the existing renderer.**
All eleven first-wave workers and six recovery workers timed out.
Their partial implementations are preserved. Worker completion labels are not evidence that the features work.

The parent completed one runnable path for straight, undecorated boxes:

- Exact GPU material-ID comparison and neighbour invalidation.
- Persistent opaque faces with one indirect camera draw.
- Shared material rows, mipmapped detail textures, lighting, and existing GI probes.
- A cached raster shadow map for those opaque faces.
- Depth transfer to the existing volume renderer.
- Conservative temporal rejection after simulation or presentation changes.

Use `?renderer=hybrid&view=realistic` to select this experimental path.
Smooth surfaces, optics, smoke, and particles still use the existing volume renderer.
Data views, worlds, source artwork, visible decoration, and curved presentation retain the existing renderer.

The remaining modules are not integrated:

| Feature | Current state |
| --- | --- |
| Smooth surfaces | Runtime and shader prototype. Extraction, capacity, appearance, and field revision checks need native tests. |
| Water and glass | Optical runtime and shader prototype. Legacy fallback composition needs integration and native tests. |
| Smoke, steam, and fire | Shader prototype. The resource owner and pass integration are missing. |
| Grains and droplets | Runtime and shader prototype. Particle ownership is disabled until smooth-field exclusion is correct. Liquids remain excluded. |
| Temporal reconstruction | Optional motion/reactive inputs have CPU checks. Dynamic surfaces do not yet produce reliable motion buffers. |
| Adaptive resolution | Pure controller prototype. Timing integration and controller tests are missing. |
| Selective reflections | Shader/helper prototype. Shared hit shading and application integration are missing. |

The opaque path also has limits. It uses sharp cell faces, not bevelled or smooth geometry.
Its new shadow map contains only opaque crisp casters.
Static landscapes, close-up sand, and explosions still need combined rebuild-and-render benchmarks.
No speed improvement or image-quality equivalence is established.

### Validation

CPU checks:

```sh
node tools/hybrid-core-check.mjs
node tools/hybrid-temporal-check.mjs
node tools/post-reuse-cpu-check.mjs
node tools/check-imports.mjs
node tools/check-state-access.mjs
node tools/check-browser-launch.mjs
npm run build
```

Native checks use separate, serialized GPU slots:

```sh
node tools/hybrid-gpu-check.mjs
node tools/hybrid-app-check.mjs
```

The M5 native core check passed with a 128³ grid.
Heating a cell rebuilt zero bricks. Removing a boundary cell rebuilt seven bricks.
The overflow fixture suppressed the entire mesh. Covered-pixel checks passed.
The successful slot occupied 2.72 seconds, including startup and cleanup.

The app check passed hybrid rendering, legacy volume composition, data-view fallback, and default rendering.
It advanced no physics steps. The successful slot occupied 15.79 seconds.
The local account/AI relay was offline. The check records that specific network error separately.
Other native attempts exposed a barrier error, a fixture error, and a layout-name collision.
Those errors are corrected. No GPU benchmark ran.

`tools/hybrid-check.mjs` still reports undelivered lane checks.
It is not a passing acceptance suite for the full renderer.
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

## Decisions from the first build wave

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
  and 11–13 for shadows.
  Each final pipeline must pass the engine's resource-limit checks.
- Shadow casters expose `drawShadow(rp, { matrix })`, `isReady`, and `revision`.
  The matrix maps physical grid coordinates to light clip coordinates.
  The shadow texture uses `depth32float`. An unavailable caster returns `false`.
- Optics and reflections use compact, nonrecursive world-hit shading callbacks.
  The parent composes those callbacks from shared materials and lighting.
  Screen-color reprojection is valid only when scene depth confirms the hit.
- Particles initially own only isolated granular or organic cells.
  The ownership predicate checks all 26 neighbouring cells across brick boundaries.
  Liquids, molten matter, and glass remain with optics.
  Particle rendering stays disabled until the smooth-field exclusion is proven.
- Media can expose `hybridMediaSegment(ro, rd, tNear, tFar)` for refracted paths.
  This function returns premultiplied radiance with opacity in alpha.
  A front-media pass must stop at the nearest optical interface when optics uses this hook.
  Optical/media overlap stays unsupported until both paths use the same ordering.
- Temporal inputs are frame-local. Explicit motion includes camera and presentation motion.
  Unknown simulation correspondence rejects history instead of inventing motion.
  Hybrid rendering does not reuse the old color/depth-only mesh-frame cache.
