# WORLD owner prerequisites — INCOMPLETE checkpoint

This is **not** `win.render`, application integration, or a presentable publication.
No production route changes. The supervisor explicitly approved saving these
concrete prerequisites instead of adding a nominal/unsafe transaction owner.

## Concrete APIs

`createWorldLightingInputs(gpu, {atlas, tables, frameValues, physicsOrigin,
appearance, external, params})` allocates immutable native global uniform inputs.
`frameValues` uses the existing packed-field names/shared FrameUniforms fields;
`params` uses the original VolumeParams fields. Local lamps/wand/dig positions
are converted once with `worldFrameValues`. Original artwork's `appearance.view`
and `.uniform` are borrowed; external noise/packed mesh views are borrowed.
No `.texture` property is read from a GPUTextureView.

* `inputs.sun(input)` returns **only** writer G0 bindings 0..4 (tables, global
  zero-origin Header, immutable FU, snapshot WA, CELL book) and G1 six native
  state/field/aux views. No full sixteen-texture union/dummy Sun inputs.
* `inputs.reader(input)` returns full native reader G0..G3. Input contains
  `atlas`, optional `previousAtlas`, `sun` (real pinned Sun handle), and native
  `feedback` buffer. G0 binding5 is the exact previous LIGHT book when mixed.
  G1/G2 aux/probe layout/views use the current compatible pool prefix. G3 has
  original VolumeParams, typed feedback, two original sampler modes, packed
  WorldSunParams and actual SunBook. It allocates immutable Sun params each call.
* `inputs.release()` closes new access immediately; native uniform destruction
  waits for the normal Frame suffix to close and queue completion. Borrowed
  snapshots/artwork/noise/mesh are **not** owned by this helper: owner must pin
  them independently through final submit+completion. Uncertain fatal graphics
  failure deliberately retains native allocations.

`createWorldFeedbackProvider(gpu, {book, sunTileCount})` provides actual producer
`layout()` and `reserve(frame)` methods. The layout is six channel planes, one
shared status, the explicit Sun suffix, then per-job words. Decoder is shared
`decodeWorldFeedback`; producers still require every job word exactly **1**.
Zero/unrun is never complete. This provider reads feedback only, not geometry.

A reserved ticket's `record(frame, buffer, wordCount)` records a provider-owned
MAP_READ staging copy, then calls **normal** `gpu.flush` once at the final
boundary. It never creates an encoder/submits privately or registers a global
uncancellable readback job. Mapping starts only after successful final submit.
`submitted` settles after that final boundary, not an earlier automatic prefix.
Producers must still fence the queue on **both** outcomes (existing Sun and
`completeLightingBatch` already do). A readback/encoding error still attempts
normal flush. A closed-suffix flush rejection rejects submission/read without
awaiting unsubmitted mapping; staging retires after prefix queue completion.

If flush throws while the suffix remains recordable, the ticket becomes
`status='blocked'`, exposes `.error`, and deliberately leaves both promises and
pins unresolved. Provider `.failure` exposes the error and further `reserve`
rejects. No polling/retry/admission occurs. **Recovery is not implemented**:
the future owner must establish terminal graphics retirement before reclaiming
these uncertain allocations. Declaring completion while a suffix can later
submit would be unsafe. This fatal-graphics retention is not ordinary cut retry.

## Atlas borrowing and mixed producer readers

`snapshot.retain()` pins the **same** immutable publication.
`snapshot.textures()` borrows actual native textures from that exact pinned
resource set; released/old-epoch handles reject. It does not return latest
`atlas.resources` after an await.

`atlas.producerBindings(cellSnapshot, previousSnapshot, external, feedback)` is
producer-only. Both handles must be live, owned by this Atlas, same epoch,
non-regressing generation; CELL must use the current native pool prefix. Every
previous LIGHT descriptor must still be pinned in the same physical pool.
It substitutes only previous LightBook; aux/probe views/WA layout are current.
Growth now copies **public or pinned retired** pages, preserving those old
numeric descriptor/probe IDs across every growth/descriptor-base relocation.
Neither handle may be released before final use/completion. Default coherent
render-snapshot bindings are unchanged. This API does not authorize re-stamping
retained computation or complete temporal restoration.

## Submitted CELL classification and emission

`cells.acquireClassification({bricks})` synchronously captures and pins actual
submitted adapter captures plus their CELL/Source publication. Returned records
are `{brick,index,buffer,byteOffset}` for the original classifier's 16-byte record.
Missing classification throws an error with typed CELL `.requirements`.

* `lease.recordMetadata(frame)` batches native record copies into one buffer for
  optional small classification-only readback. No raw A/B geometry is read.
* `lease.recordEmission(frame,{min,size})` creates XYZ-linear native f32 vec4
  emission over the **entire explicitly requested in-world region**, suitable
  for `worldGlowPlan(...).input`. It prevalidates every brick before recording;
  missing interior halo returns typed requirements, never zero emission.
* Format correction: original BrickInfo is f32 emission `/64` in **xyz** and
  UINT info in **w**. Copy exactly xyz's original twelve bytes; clear only
  padding w. No half packing, CPU float conversion, or emission math duplication.
* `lease.release()` immediately rejects new access, but capture/native output,
  Source and Atlas pins retire only after normal suffix closure and queue
  completion, even if cache/configuration replacement happens earlier.

A caller must not mutate borrowed native buffers. Calls require the normal Frame
and current owned-cut validity. Later physics alone does not invalidate old-cut
leases. The full four-brick Glow halo may extend far beyond receivers.

## Sparse Sun

`sun.prepare({...existingOptions, receiverBounds: [], requestedTiles: [...]})`
accepts canonical virtual tile IDs (deduplicated/sorted and frozen before await).
Requests union receiver demand; no full-world bootstrap is introduced. Explicit
empty selection publishes a valid **empty UNKNOWN SunBook**, with a legal
minimal native layer. That is for BUILDING/offscreen dependency probes only,
never a claim of presentability. Exact selection, basis/epoch/configuration,
source/field/dependency identities participate in cache validity; overlap is
copied only under the existing complete dirty-column proof.

## Remaining blocking owner work

There is deliberately no `src/wire/worldRender.js` in this checkpoint.

1. Add a real ledger-authenticated retained-channel lease/transport seam. The
   existing `worldLightingBatch` direct-write guards remain strict and unchanged:
   output compute sourceRevision/tick/dependencies must match the Atlas job.
   Atlas also requires co-resident CELL/LIGHT publication sourceRevision equality.
   New cut R+1 cannot restore retained computation from R by changing its token,
   calling it recomputed, or bypassing these guards.
2. Supervisor approved narrowly separating current-cut LIGHT publication stamp
   from immutable per-channel original compute provenance. Only actual branded
   ledger leases may authorize restoration, validating owner/epoch/configuration,
   exact channel/index/native backing, and owned current-cut validity. Original
   source/gi/glow ticks/dependency references stay original. This is NOT yet coded.
   Preserve defaults. Add mixed-generation, forged/released/foreign/config/epoch,
   partial-restore rejection, and genuine R->R+1 no-recompute native tests first.
3. Build persistent CPU metadata/change stamps from submitted classification and
   original semantic Source changes, world-fixed clocks and original GI recent
   dilation. Do not use perpetually capped Fields EMA age as GI change age, or
   blanket age0/near=true. Maintain offscreen owned records.
4. Construct actual ordinary `win.render` state, readiness, one frozen-cut active
   transaction, queued next request, serial typed closure. Pin cut -> exact CELL
   demand/record -> one Source flush -> CELL commit -> sparse full optical closure
   -> **all** selected/private SOURCE slabs before **any** gather against exact
   previous native bands -> original six-pass Glow -> atomic LIGHT/Sun publication
   -> history adoption -> owned immutable presentable bundle. Pin old presentable
   throughout. Same-tick retries do not advance EMA/clocks twice.
5. Add authentic birth manifests/full first gather, ledger restoration for known
   histories, BUILDING-only incomplete feedback acquisition, reset/dispose safe
   retirement and final owner-specific starvation/publication tests. No fake
   complete flag or activation. App consumers/admission remain parent scope.

## Evidence and limits

`check:world-lighting-inputs` is delayed CPU/fake-native identity/transport/error
lifetime evidence. Existing focused Atlas/CELL/SourceCut/Sun suites cover shared
Naga layouts and original transport. New tests exercise old descriptors across
repeated growth, native texture borrowing/release/reset, actual shared G0..G3
binding extents, typed feedback, rejected final suffix with surviving prefix,
blocked recordable suffix, sparse/empty Sun/cache keys, original emission/info
format, missing Glow halo and capture pins through replacement/final completion.

No GPU/browser/server/deployment was run. These tests do not establish visual
parity, numerical GPU parity, affordability, full owner/App completion or acceptance.
