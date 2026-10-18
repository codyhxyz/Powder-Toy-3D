# Native WORLD fragment lighting

This is a mesh-lighting bridge, not the application switch. BOX remains the default. WORLD uses per-fragment global SH/glow and the original four-tap optical Sun calculation, including colored absorption, water caustics and one cloud attenuation. It does not bind the full voxel reader or sample one light value per object or vertex.

## Scene caller protocol

Import `createNativeWorldMeshLightContext` from `gfx/meshLight.js`.

Create a context with:

- `publication`: an **owned** bundle with `atlas`, pinned `sun`, `identity`, `textures`, and `release()`. The bundle must retain every borrowed native resource until released.
- `textures`: native Atlas `aux`, `gi` (four textures), and `glow`. Capture these with the Atlas snapshot, while its views still match the current resources. Do not retrieve latest Atlas textures later for an older snapshot.
- `sun`: a retained WorldSun handle. Its `bindings()` must match the Atlas Sun manifest. Its guarded `textures()` supplies the native optical texture under that same pin. An explicitly owned bundle may instead provide `textures.sunOptical`; if both are present they must agree.
- `worldSize`: the full finite world, not the physics window.
- `frameValues`: the candidate's frozen, globally converted frame values. `model` maps global world cells into scene coordinates. Lamp/wand coordinates must already have been converted exactly once.
- `feedback`: the candidate's shared typed GPU feedback buffer, including the Sun suffix.
- `noise`: the immutable native 3D cloud-noise texture.
- `isCompatible(publication)`: the caller's scene/epoch/configuration check. It must not reject a coherent cut merely because physics or the camera advanced.

Creation transfers bundle ownership, including validation failures. Creation itself records no GPU commands.

Before drawing a WORLD scene, call `updateMeshLight({worldMeshLightContext: context})`, or `setMeshLightDomain(context)`. Both bind the same frozen inputs. Clear shared feedback **before all scene readers**, then read it only after the last mesh/volume reader. Any typed miss or status bit rejects the entire scene through the existing frame gate. Placeholder return values are not complete lighting.

Switching domains changes existing material graphs. `prepareMesh` tracks material program keys; `guardMeshes` waits for asynchronous recompilation. The domain revision is captured when compilation starts, so a late BOX compile cannot certify WORLD readiness. The caller must prewarm/guard materials before opening the draw pass. No BOX/WORLD texture-binding union is generated.

`gridPosition` selects the frozen global model in WORLD, even for existing figures with their own old window matrix. Normal maps, material colors, skinning, morphs and artwork stay in their original graphs. The normal is transformed into global cell axes before the original normal lift and SH evaluation.

After the context's **last native use**, call `context.retireAfter(finalSubmissionPromise)`. The promise must settle only after all final uses are submitted, or the suffix is definitively discarded/device-lost. The context still waits for queue completion after either fulfillment or rejection, because rejection does not undo earlier submitted prefixes. Until that fence, the bundle stays pinned. Intentionally unsettled tickets retain resources. `cancel()` releases only a context which has never been bound.

For BOX, call the normal `updateMeshLight(app)` to restore its resources and values; `setMeshLightDomain(null)` selects its graph. Do not render using a retired context, or assume graph selection alone refreshes BOX uniforms. Do not overlap contexts' synchronous recording scopes.

## Native resource ABI

The compact fragment graph has two readonly storage books and one atomic feedback buffer. It shares the native array textures and keeps global book addresses; it makes no CPU readback or full-world metadata mirror.

`gpu/three.js` contains the r186 external-storage adoption seam. The one-word CPU attribute is a uint type witness, not uploaded data. Do not attach it to geometry, mutate its array, or ask Three to destroy it. Native ownership stays with the publication bundle. Three's actual storage bindings follow attribute identity when a new context is bound.

The leaf's storage identifiers come from the actual Three builder. It uses global storage symbols rather than storage-pointer function arguments, which are not baseline WGSL. Texture and uniform arguments remain parameterized.

The guarded `WorldSun` snapshot `textures()` accessor returns borrowed `{sun0, sun1}` GPUTextures. It adds no reference or release method. Access after snapshot release throws.

## Evidence and limits

`npm run check:world-mesh-light` uses real Three node generation, Naga, fake native ownership and CPU WGSL execution. It covers BOX/WORLD/BOX transitions of already-created graphs, actual figure matrices, normal maps, PBR/artwork, skinning, morphs, native binding repointing, full-world book sizing, frozen inputs, delayed/rejected final submissions, global trilinear/SH boundaries, optical tint/caustics/clouds and sticky misses. Its interpreter has explicit uint, vector-select and void-call adapters; these are not GPU execution.

The pre-edit BOX lighting WGSL is compared byte-for-byte. Generated variants stay within 16 sampled textures, eight storage buffers and four bind groups. These checks do not prove driver compilation, numerical GPU equality, visual correctness or throughput. The application must still provide the pinned bundle, synchronous material readiness, whole-scene feedback admission and final-use fences. No App, hands, signs, Plain, Source or scheduler migration is included here.
