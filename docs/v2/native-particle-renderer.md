# Native particle presentation — CPU checked, not GPU/visual certified

`NativeParticles` (`src/gfx/nativeParticles.js`) attaches to `NativeDynamics`,
reads its `renderState` ABI version1 directly, and never owns, destroys, sorts,
rebases or reads back its physics buffers. Requires phase foundation371e8f4
and dynamics9e7cc63 (or descendants). It does not alter the smooth world renderer.

## Exact wire hooks (parent-owned integration; five lines)

```js
import { NativeParticles } from '../gfx/nativeParticles.js'; // wire module
// attach: app.nativeParticles = new NativeParticles(app.sim.gpu, dynamics); await app.nativeParticles.ready;
// beforeView (after physics, before scene pass): app.volume.updateMatrixWorld(); app.nativeParticles.updateView(app.camera, app.post.sceneTarget.height, app.volume.matrixWorld, app.sim.origin); app.nativeParticles.prepareDraw();
// scene (after volume/opaque meshes): app.nativeParticles.draw(rp, app.post.sceneTarget);
// detach (before physics disposal): app.nativeParticles.dispose(); app.nativeParticles = null;
```

Here `dynamics` is the actual native dynamics owner, not a copied render-state
snapshot. `attachSource` calls its `attachDrawAdapter`; `isReady` combines actual
source readiness, both render pipelines and the count pipeline. Gate ray tools
on the dynamics capability's `physicsReady && drawReady`, not merely a simulation
flag. A failed pipeline rejects `ready`. Integrators must schedule a view when
`ready` settles (existing wake mechanism). No particle simulation/emit tool is
implemented by this adapter, and no hooks are installed automatically.

`updateView(camera,targetHeight,volumeMatrix,origin,{sample=0})` only computes
CPU camera/matrix data. Projection uses the current shared, jittered
FrameUniforms and draw viewport, not a cached FOV approximation. WORLD-CELL
particle positions subtract the current origin *before* the volume transform;
origin shifts do not modify any particle record. Nonuniform volume transforms
are supported through local-space intersection and inverse-transpose normals.

`prepareDraw(gpu.frame)` is mandatory before the open scene pass, after the
last native simulation write. It records one one-thread compute dispatch:
GPU `control[0] == 0` produces `[6,0,0,0]` indirect arguments, otherwise
`[6,capacity,0,0]`. An idle source records neither compute nor draws. `draw`
only records into the caller's existing pass, rejects unprepared/stale frames,
and returns whether draws were recorded, **not** whether the GPU count was
nonzero. Bind groups refresh if source buffers change. Only one16B indirect
buffer is owned; disposal flushes pending commands before destroying it.

## Appearance and transparency

- Exact48B records: three vec4u; position/stable ID, velocity/core0,
  core1/core2/core3/bank. No64B legacy list or bridge. IDs254/255 select the
  dedicated additive photon/neutron pass. Photon RGB floats are words8–10;
  neutron energy MeV is word9. Existing ray palette/glow constants are reused.
- Matter is drawn as pieces, never one ball (`MATTER_LOOK` in
  `shaders/v2/particleRender.js`; 2026-11-21, after clear liquids flew as black
  dotted spheres up to a metre across). The ball of a packet's volume, radius
  `(3*amount/(4*pi))^(1/3)` cells (liquid amount is core1.low24/65536, otherwise
  one cell), only sizes it. Grit and debris are a clump of up to 8 tumbling clods,
  glass and ice are shards, a liquid is a burst of drops stretched along its
  flight, each an ellipsoid hit analytically (depth-correct). A packet small on
  screen shows fewer pieces, one at the least. Rays use the existing 0.7-cell
  marker diameter (without the legacy pixel-size clamps).
- Material albedo, roughness, metalness, IOR, extinction/scattering and emission
  come from existing LOOK/ELEMENTS/MEDIA tables; sky, sun and ambient come from
  existing FrameUniforms. Existing Planck-table incandescence uses actual
  phase thresholds from PHASE_ROWS, never raw latent tags as temperatures.
  This small-particle lighting is not the world renderer's full shadow/GI or
  refraction solver; it does not modify that solver or graphics settings.
- Nothing is dithered. Every look that covers (clods, shards, drops; the opaque
  cubes of Plain and the data views) writes depth and an opaque colour in the
  matter pass. A drop or shard shows the light bent through it, dyed along the
  ray's path inside (Beer-Lambert), mixed with its own lit colour (never under
  `DROP_TINT`), under its Fresnel mirror of the surroundings and the sun's
  glint; the surroundings are the bound light's probes or the open sky, and
  nothing behind it is read.
- Every see-through look (gas and fire; the translucent cubes of Plain and the
  data views: `softLook`) is drawn by the soft pass: the matter pass's own
  shader module with premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA) and no
  depth writes, after the matter pass. A gas or flame packet is a puff, densest
  through its middle and gone at its rim. Puffs are not sorted.
- Rays draw last with premultiplied radiance, ONE/ONE RGB, unchanged target
  alpha and no depth writes. All three passes test depth32float LESS_EQUAL
  against the existing scene, including opaque volume/meshes.

## Cost and optimization seam

Nonzero count currently costs three draws of 6*capacity vertices (65536 slots,
1179648 total vertex invocations before implementation-dependent optimization).
Each pass rejects dead or wrong-family slots in the vertex stage. Zero count
costs the tiny count dispatch and three zero-instance indirect draw commands;
there is no particle readback or per-frame full-buffer CPU copy. This is a
bounded correctness baseline, **not measured GPU performance**. A later
render-only compact index + per-family indirect arguments can remove sparse
slot overhead without modifying authoritative slot order. The soft pass is
not depth-sorted. Neither compaction nor a performance improvement is
claimed here.

## Evidence / outstanding gate

- `node --test tools/v2/particle-render-check.mjs`:9 CPU tests for record/payload
  ABI, origin/projection, phase temperatures, amount/radius, moving surface
  depth, no dithering and the three passes' blend state, the pieces' bound, GPU-zero-count
  command oracle, readiness/stale bindings, ABI guards and resource lifetime.
- `node tools/v2/particle-render-wgsl-check.mjs`: Naga validates count, matter,
  ray modules. All three export normal `WGSL_CHECK` discovery entries.
- These are CPU references/recording mocks and WGSL static checks, not WebGPU
  runtime or pixel evidence. Parent must validate actual scene-pass attachments,
  opaque occlusion, stacked liquids, near camera/world shifts and ray tools in
  its explicitly budgeted GPU slot. No GPU runs or performance claims here.
