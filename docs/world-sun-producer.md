# Full optical world sun producer (disabled assembly)

This phase-4 piece is **not enabled by the application**. It implements the full
shared optical sun kernel and immutable candidate/publication runtime. It does
not implement GI/glow, Source→Field→Atlas adapters, application presentation,
figures/hands, or the completed unified renderer. No deployment is implied.

## Actual resource ABI

`src/shaders/worldSunWriter.js` assembles `lib(..., LIGHTING_SHADOW, world)` and
**the original `shadowOpticsWGSL`**, not an opaque-only/heightfield prototype.
Shared raw IDs, material extinction, smooth roots, thin cubic films, crystal
prism chords, liquid trapezoids and media transport extinction all remain in
that body. The original mixed-media/tint approximation and caustic records are
preserved. The writer does not compute caustic gain: the existing reader decodes
that record and applies the original gain. Physical rays are never bent by
presentation, nor perturbed by `safeDir`.

| Group | Actual bindings |
|---|---|
| 0 | 0 Tables storage; 1 zero-origin Header uniform; 2 FrameUniforms uniform; 3 WorldParams uniform (112 bytes); 4 geometry Book storage |
| 1 | 0 A uint array; 1 B uint array; 2 surface float array; 3 media float array; 4 thin float array; 5 auxiliary uint array |
| 2 | **0 job uniform (32 bytes); 1 WorldSunParams (128 bytes); 2 sun0 storage rgba32float array; 3 sun1 storage r32float array** |
| 3 | **1 request/status storage buffer**, using the supplied feedback layout |

Six sampled textures, three storage buffers, two storage images, four groups;
no samplers. There is room for the separate future LIGHT book. Raw/field/aux
views and global uniforms come from a pinned published snapshot. Neither sun
input, GI, appearance, noise, nor packed mesh is declared/reachable. A full
reader binding callback must explicitly select G0/G1 entries, not pass unused
reader groups. Native output allocations are created privately **after** acquiring
the input snapshot, never given to the input provider, and never alias previous
reader textures. The writer does not need imported appearance: extinction and
crystal shape use the same original material/source fields as the full reader.

The minimal `worldAccessWGSL({backend:'world', opticalWriter:true})` option only
omits unused group-2 reader declarations and probe/glow/mesh functions. Default
standalone/world-reader output is unchanged. The parent must reconcile this
leaf option with concurrent typed-feedback/LIGHT access changes; it does not
freeze the older geometry-only request-bit layout. The writer uses the same
shared `worldRequest` leaf and latches `worldQueryIncomplete`.

`WorldSunParams`, physical pitch **0.416531224**, column-major physical matrix,
pole-safe basis, signed 256² virtual tiles, 2048² arrays and 64 tiles/layer are
unchanged from `world/worldSun.js`. The ray origin is
`U*(pixel.x+.5)*pitch + V*(pixel.y+.5)*pitch + Sun*depthHi` and direction `-Sun`.
Its parametric t equals the reader's depth `depthHi-dot(p,Sun)` (within float
arithmetic). `sun0=(opaqueDepth,transStart,transEnd,tintId*256+min(tau,255))` is
always f32; `sun1` is exactly that same invocation's `sun0.x`. No half packing.
Parallel DDA/slab axes are handled explicitly without 0/0. Traversal derives
from all world dimensions; exhaustion marks incomplete. Actual exterior y=0
floor handling also works for rays missing the finite world box; non-hits remain
`(1e5,1e5,1e5,0)`, never a fabricated tint.

Each SunBook entry is the public eight-u32 descriptor:
`slot,epoch,basisRevision,publishRevision,dependencySetID,dependencyVersion,flags,reserved`.
Only built/copied complete tiles receive `flags=1`; absent entries stay zero.
Dependency references are supplied explicitly by the pinned-input provider and
must identify its actual full ray/field/raw closure, including offscreen casters.
They are not residency IDs or fabricated per-page provenance.

## Runtime / callback contract

```js
createWorldSunLighting(gpu, {
  g, sourceFieldSnapshotProvider, readerBindingProvider, feedbackProvider
});
```

The GPU wrapper is the existing `gpu.frame` convention. No private command
encoder or queue submission exists in this module. The caller owns frame flush,
feedback readback machinery and eventual complete-frame presentability.

`sourceFieldSnapshotProvider.acquire()` asynchronously returns a **pinned,
immutable published snapshot**, not field scratch output:

- `worldSize: [nx,ny,nz]` (must equal g), `epoch` (nonzero u32),
  `source: {contentToken, sourceRevision}`;
- `field: {publishedToken, complete:true, sourceRevision, logicalFieldTick}`;
- `dependencySetID`, `dependencyVersion` (u32 provenance references);
- `release()` and any adapter-specific resources needed by the binding callback.

Both source revisions must match. Tokens are stable semantic identities (primitive
values or immutable objects compared by identity), not allocation/ownership
versions. Moving a physics window or relocating a page must not change content
identity. A legitimate settling field tick must change its publication token.
`sourceFieldSnapshotProvider.isCurrent(snapshot)` must reject edits, new scenes,
field publications, and epoch changes even when they occur during an await.
The provider must pin **all** borrowed G0/G1 resources, including global tables,
zero-origin Header, global FrameUniforms and full world book/atlas, through
release. `readerBindingProvider(snapshot)` asynchronously returns exactly two
arrays of native bind-group entries matching G0 and G1 above.

`feedbackProvider.layout({snapshot,tileCount,sunTileCount})` returns:

- `wordCount`: entire feedback buffer extent, including all typed source/field
  request bitsets and shared status required by the current access factory;
- `requestWordOffset`: explicit public sun request-suffix offset; written into
  WorldSunParams.version.w (never inferred as geometryWords+1);
- `jobStatusWordOffset`: **additional nonoverlapping range of tileCount u32s**,
  beyond every access-factory request/status word and sun suffix;
- `decode(Uint32Array) -> {incomplete, ...typedRequests}` using the current
  shared helper contract. It must propagate every request/status channel.

The layout provider owns validating all common/typed ranges; the producer also
checks extents, limits, and the sun/job suffix separation. The buffer starts
zero. Every writer ray atomically ORs its tile word with **1 (finished complete)**
or **3 (finished incomplete)**. Thus clean no-hit is 1, missing is 3, and an
unrun/failed tile remains 0. Every job's exact word must equal 1 and the shared
decoder must be complete before publication. Job word = jobStatusWordOffset +
physical slot. Copied complete tiles do not dispatch or require new job status.
`decode` is also returned with missing candidates so the caller can request
missing source/field data and retry. No geometry CPU readback is used.

`feedbackProvider.reserve(frame)` is called **before the first queued reference**
and returns `{submitted: Promise, record(frame, feedbackBuffer)}`:

1. `record` records the full feedback copy/read at call time, **after** all jobs
   and native texture copies; returns `Promise<Uint32Array>`.
2. `submitted` resolves only after the **final encoder containing those uses and
   feedback copy has actually been submitted**, including any frame auto-flushes.
   It may reject only once those encoders have been discarded (or device loss
   guarantees no pending use). It must settle on encode failures too; record is
   called even after partial encoding. If record throws, the reserved ticket
   still owns tracking final submission/discard.
3. The producer calls `queue.onSubmittedWorkDone()` **after** submitted resolves,
   then awaits feedback and checks staleness before publication. A read resolving
   early cannot release pins. A never-submitted encoder deliberately retains its
   resources; callers must submit/discard it, not abandon the ticket.

`prepare({direction,basisRevision,configVersion,sceneToken,receiverBounds,
changedWorldBounds?,changeBaseToken?})` returns a prepared candidate, a cached
snapshot, a stale result, or no-receivers result. Bounds are `{min:[x,y,z],max:[]}`
in global physical coordinates, not a camera/frustum's caster list. Basis,
config, scene, source content and field publication identities are cache keys;
physics origin, job order, camera matrices and presentation curvature are not.
A newer prepare invalidates older uncommitted candidates, including coverage
changes. Call `candidate.record(gpu.frame)` only once, then await its returned
completion (or `candidate.completion`). Results distinguish published,
incomplete/failed/stale with retry and failed tile IDs. `cancel()` is only legal
before recording. Reset/dispose cancel unrecorded candidates and invalidate
queued ones **without releasing queued references early**.

Receiver tiles include the original cubic sample support, two texels of filter
expansion and the maximum physical full-depth PCSS radius. Changed bounds use
the same matrix plus original two-cell sample support, two texels and a
conservative six-cell crystal-neighbor dependency expansion. Changes must include
all derived-field changes, not just raw edits. Reuse is allowed only with
`changeBaseToken === previousSunSnapshot.token` and a **complete cumulative
source+field delta from that publication**; omitted/mismatched delta rebuilds
all wanted tiles on content changes. Old complete tiles are native-copied to
fresh arrays; their source arrays remain pinned through submission/completion.
The complete ray through each receiver texel supplies full-depth/offscreen
caster closure and requests missing inputs, not camera-frustum streaming.

Physical layers grow at fixed pitch with coverage, subject to actual device
array limits. Coverage beyond legal capacity fails explicitly; it never lowers
texel density or silently omits a requested tile. No buffer exceeds 128 MiB.
Only requested receiver coverage needs initialization; this is not a whole-world
empty-map readiness gate. Missing/failed/stale candidates publish **nothing**;
the previous complete immutable publication stays available.

`snapshot()` returns an independently reference-counted immutable SunBook /
texture / token handle (or null if no completed publication exists).
`bindings(handle)` or `handle.bindings()` returns `{params,book,sun0,sun1,token}`
for existing world readers. Every consumer must hold its own handle until its
**final submission AND GPU completion**; release-after-draw is insufficient.
Cached/no-receivers results containing a snapshot also own a reference. Reset,
dispose and newer publications do not invalidate retained handles. Publication
metadata survives independently of the producer's temporary source/field pin.

## Checked evidence / limits

`npm run check:world-sun` is CPU-only: actual factory Naga compilation at heights
128/384 with imported-source capability on/off, exact physical pole/low/zero-axis
projection fixtures, independent numerical optical/glass/multiray/film/media/
liquid/caustic/crystal/opaque references and an offscreen roof shadow, plus fake
native-device resource/layout/recording/publication/feedback/lifetime/growth
fixtures. These are **not execution of WGSL on GPU**, pixel equality, visual,
performance or memory-affordability evidence. The independent CPU reference
explicitly does not claim CPU == GPU. Existing 136 Box shader hashes and layouts
remain unchanged; existing 132 world backend modules must continue to pass.

Remaining integration: reconcile shared typed feedback leaf hooks; supply real
Source/Field/Atlas pinned callbacks; full GI/glow/fieldAtlas production and
cross-channel publication; consumers and complete-frame application presentation;
application switch/removal of proxies; later parent-authorized GPU numerical,
origin-shift, appearance and performance acceptance. No GPU/browser/server or
application switch is part of this checked producer change.
