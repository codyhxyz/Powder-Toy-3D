# World render atlas ABI v1 (isolated PHASE3a primitives)

This is **not** a renderer switch or completion of the unified-world plan.
Physics, Source/window/stamp, FieldDeriver, Derived, Three and application
rendering are untouched. No visible quality policy is introduced.

## Addressing / resources

- A brick is world-aligned 4³. Book index is `bx + BX*(by + BY*bz)`;
  dimensions must be positive multiples of four, origin is world zero. Signed,
  fractional, out-of-world and overflowing addresses are rejected on CPU.
- One book u32 per brick: 0 means **UNKNOWN**, otherwise physical page ID + 1.
  `[3072,128,1024]` uses 24 MiB; height 384 uses 72 MiB. Book and feedback
  bindings must individually fit both the actual device and 128 MiB.
- Physical page cell slot is the **original**
  `x + 4*(y&1) + 8*(z + 4*(y>>1))` with local coordinates 0..3, stored as an
  8×8 tile. Never reinterpret source buffers as xyz-linear.
- A/B are `rgba32uint`, read with float32 bitcast. All state bits, NaN payloads,
  signed zero, ctype and seeds survive upload and copies without conversion.
- Three final field textures are `rgba16float`; view storage has no EMA/tmp.
  Persistent packed EMA remains a later FieldDeriver responsibility.
- Four SH bands and glow are `rgba16float`, one texel per physical page.
  Probe world centres are `4*brick + 2`, independent of construction chunks.
- Aux is ONE `rgba32uint` 2D-array texture. Linear texel number is
  `physicalPageID*132 + record`, flattened across width, height, then layers.
  No extra sampled binding for each auxiliary plane.
- Aux records: 0 = `[readyBits, epoch, sourceRevision, fieldTick]`;
  1 = all four original BrickInfo words (`emit.xyz` float32 **bits**, `info`);
  2 = `[occLo, occHi, distancePlus1, age]`; 3 = reserved zero words.
  Records `4 + 2*slot` are `[flow.x,flow.y,aer.x,aer.y]` (original packed-half
  vec2u words); next record is `[cellPaintRGBA8,0,0,0]`. Decoration is NOT the
  particle pool. Distance zero decodes to -1 (unknown distance, not empty).
- Readiness bits: RAW=1, FIELD=2, AUX=4, LIGHT=8. Every publication requires
  aux metadata even when its declared read set is RAW only. A replacement may
  not drop a previously ready subset. Source revisions are u32 and monotonic;
  same-revision field ticks cannot regress. Revision/epoch wrap is not allowed.

The explicit reader has **exactly 16 sampled textures**, two storage buffers
(book/read and requests/read-write), zero samplers, four bind groups:

| group | resources in binding order |
|---|---|
| 0 | immutable WorldParams uniform; immutable book storage |
| 1 | stateA, stateB, field0, field1, field2, aux |
| 2 | GI0..3, glow, sunDepth, sunOptical, mediaNoise, sourceAppearance, packedMesh |
| 3 | atomic missing-brick bitset storage |

This standalone ABI originally used caller-owned `r32float` depth/optical copy
planes. The integrated full reader now uses sun1 `r32float` and sun0
**`rgba32float`** 2D arrays, respectively, with the independent immutable SunBook,
fixed pitch and final 128-byte SunParams specified in
[world-shader-backend.md](world-shader-backend.md). The historical two-r32float
copy helper is NOT a full optical sun producer. mediaNoise is
float 3D; imported sourceAppearance is uint 3D; packedMesh is `rgba32uint` 2D.
They are required bindings, never silently omitted/dummied by this module.
The atlas owns only state/fields/aux/GI/glow, book and params. Shadow tiling,
optical tracing, imported source provisioning and mesh capture remain later
backends. Native actors may later bind a lighting-only subset alongside their
own Three material textures. Do not append anything to local VOLUME_LAYOUTS.

Separate writer layouts assert 8 storage buffers / 4 storage textures / 16
sampled textures / 4 groups. Raw writer uses 3 storage outputs and 3 input
buffers; field writer 3 outputs/inputs; GI 4; glow 1. These never sample their
output resources. Page-writer inputs are slot-ordered vec4u for raw/aux and
vec4f for half-float field/light outputs. WriterParams is 64 bytes; raw dispatch
is 3 groups of 64 (132 aux records), other page writers need one group.

## Producer / publication contract

`new WorldRenderAtlas(deviceOrGpu, {worldSize, initialCapacity=64, retire,
onChange, feedbackExtraWords=0})` allocates a dense book but **only a small resident atlas**, not a
world Simulation. Allocation is lazy on explicit `allocate(brick, version)`
demand. `require(bricks)` replaces the wanted set and returns missing indices;
this set protects pages from `remove`. Allocation itself is an explicit request,
not an automatic walk over the book. No eviction/quality budget is implemented.

1. `allocate(brick,{sourceRevision,fieldTick,readyBits})` returns a frozen opaque
   job identity, including epoch and physical ID. An update to a cached brick
   reserves a DIFFERENT physical page. Only one pending job per brick.
2. `update(job,{stateA,stateB,...})` accepts exact full-page Uint32Array packets
   for uint formats, Uint16Array half **bits** for final fields/GI/glow. Every
   supplied channel is validated before upload. Metadata must match the job.
   Source/Field providers need not inherit any class or use a Simulation.
3. GPU producers instead call `recordPageWrite(job,kind,{auxMetadata,record})`.
   The callback receives a fresh encoder plus `writerBindings` (64-byte param
   words and private output views). It must bind the matching writer input
   buffers and encode the FULL declared channels. Raw metadata input must be
   exactly the supplied four metadata words. The atlas owns submission so
   readiness cannot precede the producer's queued commands. The callback is a
   trusted GPU producer, not an adversarial shader sandbox.
4. `publish(jobOrArray)` validates ALL declared channels for ALL jobs first;
   it never exposes partial replacement content. Jobs whose resource set became
   old during growth are repacked after their writes. Book/params and resource
   views switch together, queue-ordered after copies. Batch jobs to avoid a
   dense book upload per brick. Current reference implementation clones the
   book per publication (correctness first; batch/COW optimisation is future).
5. Take `snapshot()`, then `snapshot.bindings(externalViews, feedbackBuffer)`.
   Snapshots capture old book, params, views and page pins. Their bindings do not
   change during replacement, grow, remove, reset or dispose. Release a snapshot
   **after submitting its final use**. Retain it while any unsubmitted encoder
   refers to it. Released snapshots must not be used again.
6. `retire(fn)` MUST invoke fn only after all submitted uses are GPU-safe. The
   default is `queue.onSubmittedWorkDone()`. Snapshots additionally pin resources
   through future submissions. Retired physical IDs are reused only after
   neither public/pending mappings nor snapshots own them. Removing a requested
   or pending page is rejected. A replaced page can retire once the requested
   brick has its new public page. `cancel(job)` invalidates pending work;
   reset increments epoch; disposed/stale/forged jobs are rejected.
7. `grow(capacity)` repacks every public cell/aux/probe channel with GPU texture
   copies; physical IDs do not change, including after width/height/layer growth.
   Old views and params stay valid while snapshots or pending providers hold
   them. Dimensions and layers honour actual device limits; allocation failure
   is an error, never a reduced-quality fallback. No performance claim is made.

`onChange` fires after complete publication, growth, remove or reset. External
providers must associate all output channels with one source revision/tick;
these primitives do not derive fields, advance histories, trace GI, or resolve
source authority. Their input buffers stay provider-owned.

## Reader requirements (mandatory)

`worldAccessWGSL()` declares this layout directly, no regex rewrite of an old
shader. Raw access bitcasts uint to float. Fields explicitly sample eight
trilinear or 64 B-spline control points, resolving each tap in GLOBAL cells.
The B-spline is the reference equivalent of existing Sigg folding. Interpolation
extends only genuine world edges; tiles/pages/chunks are never clamp bounds.
Probe/glow interpolation uses spacing four with the same global phase.

For **each full dependent query**, call `worldBeginQuery`, then after all raw,
field, aux and light reads check `worldQueryIncomplete()`. Missing/unready or
wrong-epoch pages set a private incomplete flag and atomically OR bit
`globalBrickIndex` into feedback. A zero placeholder is returned ONLY so the
query can finish collecting feedback; it is NOT an AIR/sky result. Production
must withhold the ENTIRE incomplete frame. Resetting the flag in a nested
query would erase its parent's misses; begin only at the complete-query root.
Raw access beyond genuine world bounds marks incomplete without an invalid
request bit: the caller must handle world exterior before raw access.

`feedbackExtraWords` reserves aligned u32 words AFTER the unchanged geometry
bitset. `feedbackBytes` exposes the complete extent and snapshots bind it in
full. The integrated backend reserves one status word plus virtual sun request
words; see its caller protocol. Standalone defaults/layouts remain unchanged.

Clear feedback before dispatch (not concurrently), read after completion,
decode `requestedBricks`, and merge these requests into `require` before
removing content. A known published all-zero page remains distinguishable from
UNKNOWN. No unknown/all-producer region is classified as Empty by this API.

## Packed opaque mesh

Two u32 words contain four original RGBA16 half words, one u32 contains the
exact depth32 float bits, one contains coverage flags (bit0 = covered). CPU
`packMeshWords`/`unpackMeshWords` preserve EVERY half payload, HDR and signed
zero. The optional compute packer reads existing RGBA16 scene colour and
`texture_depth_2d`, keeps finite half values/depth and sets coverage for standard
non-reversed depth `<1`. Custom/reversed depth conventions must use the provided
`packWorldMesh` helper with explicit coverage. Float texture loads cannot retain
NaN half payloads; use raw words if those matter. Coverage is NOT inferred from
RGB/alpha, and depth zero is valid. This combines the old separate colour+depth
reader slots: keeping them separate would exceed the world reader's limit (17).

## Validation / intentionally unfinished

`node --test tools/world-atlas-cpu-check.mjs` uses real helpers and a command-
recording GPU double, and runs Naga on actual new reader and all writer modules.
It checks bounds/sizes, slot bijection, page/layer geometry, uint/half copies,
replacement/stale jobs, snapshots and ownership, interpolation/gradients vs
Sigg, SH phase, unknown feedback, and all 65,536 half patterns in packed mesh.
CPU/Naga checks do NOT prove GPU appearance, memory affordability or speed.

Still required: Source capture/population wiring; FieldDeriver output and EMA
ownership; production connection of the disabled shared full primary/secondary shader
backend (see world-shader-backend.md); shared optical/GI producers and dependency closure; complete-frame scheduling; imported resources;
picks/actors/Three/presentation/paused/replica/stills integration; GPU invariance,
review and eventual full-path deployment. This phase enables none of that path.
