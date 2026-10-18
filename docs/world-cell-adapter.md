# Concrete Source → Fields → classified CELL Atlas

**Disabled foundation, not the completed renderer or an application switch.**
`WorldCellAtlasAdapter` connects the actual `WorldRenderSource`,
`RawWorldSourceProducer`, `WorldFields` and ABI-v2 `WorldRenderAtlas` classes.
There is no second Simulation, CPU dynamic-data readback, outside quality tier,
GI/glow producer, application/consumer integration, or deployment in this change.

## API and ordering

```js
const cells = new WorldCellAtlasAdapter({
  gpu, source, producer, atlas, tables, worldBounds, // all real engine objects
});
await cells.ready; // pipeline readiness, no mutable source held over this await

const demand = cells.sourceDemand({
  fieldTick, requirements, changedBricks, smoothing,
}); // exact shared Fields demand + deduplicated missing core-XZ columns

const batch = cells.record(gpu.frame, {
  fieldTick, requirements, changedBricks, smoothing,
}); // synchronous, opaque frozen handle
// The caller owns normal Frame submission, never a per-core submit:
gpu.flush('world cell captures');
const { generation, token, previousLightingSnapshot } =
  cells.commitAfterSourceFlush(batch, {
    lightJobs, invalidations, dependencyToken, sunManifest,
  });
// Release UNUSED old-history snapshots immediately. If consumed by queued
// work, retain through that consumer's FINAL submission AND completion:
previousLightingSnapshot.release();
```

`record` rejects until ready and permits one pending batch. It explicitly
captures any changed live state before obtaining a fresh producer authority
token. Exact `WorldFields.requiredSourceRegions` shares planning mathematics;
no approximate duplicate halo planner exists. Every missing core-XZ column is
produced at **full world height**, preserving tree footing, world tree order,
planted target masks and saved/captured/live protection. Population is not a
semantic mutation or a field tick. Completeness and wake provenance are checked
before the actual field plan/record. Caller inputs and owned capture handles
are copied/frozen; mutating the original demand after recording cannot change
native page addressing.

The caller supplies an explicit logical field tick; edits, idle aeration and
continued EMA settling can require one. Draws, requests and origin movement
cannot advance it. Skipped unsettled ticks still require replay, as before.
No await or source mutation is allowed between source flush and synchronous
`commitAfterSourceFlush`. It rejects an open Frame or stale source/epoch, freezes
native buffer selections, submits all consuming Atlas work synchronously, then
publishes. Source buffers themselves remain source-owned and mutable: the CPU
identity token does not make their bytes immutable. The optional
[`recordCut` / `bindCut` ownership path](world-source-cut.md) instead pins native
Source versions and frozen generation context for delayed dependency feedback,
without replacing `WorldFields`/history or pausing physics.

`abort(batch)` requires the source Frame flushed. It abandons Atlas packing,
not a successfully committed Fields tick: valid captures remain cached for a
later pack without a second EMA advance. Packing/publication failure cancels
unpublished Atlas jobs and leaves that same captured batch retryable. Caller
supplied `lightJobs` remain owned by their lighting owner; it must cancel or
retry them when the combined publication rejects.

## Exact fields and classification

All original quantized EMA/spatial stages remain shared. Every owner's scatter
precedes every spatial gather. While each 64³ scratch is still valid, record:

* the **original** `brickFrag` classification/emission reduction against A/B and
  the three final fields (no F or fabricated all/zero flags);
* 512 original 16-byte BrickInfo records in an owned 8 KiB buffer;
* three native 32³ RGBA16F captures at `[16,16,16]`, `bytesPerRow=256`,
  `rowsPerImage=32` (262,144 bytes each).

That is 794,624 bytes/core, excluding job uploads/bookkeeping; no affordability
claim. Pressure/velocity use the original 2³ core samples, liquids/gases/thin
fields use original flags, and emission uses the identical fixed reduction tree.
Only world ownership/exterior differs: `scratchOrigin+neighbor` below the true
world floor is closed; other genuine exterior faces are open. Scratch/core edges
are never sky. Default Box classifier text is byte-identical at 32/64/128.

The incremental publisher receives `{token,outputs,invalidatedCoreKeys}` before
Fields mutates authoritative state, including zero-output unseen settling.
Validation builds a replacement CPU manifest then installs it once. New outputs
win over same-core invalidation. A rejection restores both manifests and the
old history; valid retained captures are not repeatedly rejected because their
creation generation/source token is old. Their creation token records computed-at
provenance, while incremental validity records validated-through provenance.

## Native CELL packing and Atlas seams

Only requested CELL bricks allocate pages; typed LIGHT-only demand allocates no
cell. Raw/AUX packing has **seven storage buffers, three storage images, two
native groups**: A/B, flow, aeration, deco, classification and immutable jobs.
It copies exact uint words (including signed zero/NaN payloads) and original aux
planes. Absent planes explicitly become zero. Original tiled raw slot order is
not XYZ occupancy-bit order. AUX record3 is zero; distancePlus1=0 means unknown
(-1), never fabricated empty-space distance.

`recordPageWrite(job,'fields',...)` exposes callback-scoped unpublished
`destinations: [{texture,origin}, ...]`, retaining Atlas-owned submission.
One integer-only pass rearranges captured field words for each existing batch
of up to 64 pages. Each page then needs three native buffer-to-texture copies,
not 48. The pass uses five storage buffers and no storage images. Its temporary
output is at most 393,216 bytes per batch and retires after queue completion.
Every half bit is preserved: there is no float conversion or requantization.
Copies use `bytesPerRow=256`; the original row-copy helper remains the test
reference. The existing float writer is unchanged.

`atlas.publish({cellJobs,lightJobs,invalidations,...})` validates complete pool
invalidations (`CELL`, `LIGHT`, `ALL`), clears mappings and installs replacements
in one immutable-book commit. Required pages may be invalidated, the wanted set
is preserved, old snapshots stay pinned, and replacements win. Partial-channel
readiness downgrades are not supported by invalidation.

The adapter cannot invent lighting closure proofs. On actual source/field
change it conservatively invalidates potentially affected LIGHT mappings and
clears retained Sun manifest unless owner-produced replacements are supplied.
This includes untracked dep0/offscreen dependencies and LIGHT-only entries.
No-op/pure-ownership batches retain lighting. Old temporal values remain in the
explicitly owned `previousLightingSnapshot`, never retagged as recomputed or
advanced. This conservative invalidation cost is **unmeasured**. The eventual
application must withhold the whole incomplete candidate until Sun/GI/glow are
ready, not display geometry with missing lighting.

## Semantic journal, trusted wakes and failure lifetimes

`source.changesSince(contentToken)` unions regional world bricks or reports a
conservative global scene mutation. Existing engine no-argument writers mutate
only the live simulation box; callers knowing smaller bounds may pass `{lo,hi}`
or `{min,max}`. Unknown/global scene writers explicitly pass `{global:true}`.
Generation, store acknowledgement, capture and origin transfer never journal a
semantic edit. Journal/cache residency is retained (no eviction policy here).
Each edit owns one frozen record of scalar bounds, not nested bounds arrays.
Cuts share these immutable records but copy journal membership. Invalid bounds,
including sparse arrays, conservatively invalidate the whole world.

Reused column, baked-shape, touched-mask and saved A/B/deco writes now use
immutable mapped upload buffers and ordered Frame copies, not `gpu.write` or
`ordered:false`. Existing `Simulation._retire` waits for the copy's submission
and GPU completion. There is no explicit per-core flush/private Source submit.
Normal Frame ring/debug/microtask automatic submissions remain legal.

Wake trust is internal producer ownership, not CPU validation of arbitrary GPU
bytes: `isProducerBoundedAeration` recognizes actual original `Aeration`
instances, whose producer/reset/copy paths are bounded. Source propagates trust
per captured cell, including disabled-but-retained aeration. Absent/cleared wake
is valid; present untrusted/generated/imported planes reject before derivation.
As with Source authority itself, this assumes no out-of-band engine GPU-buffer
writes; class identity does not validate arbitrary buffer restoration.

Frame has no production discard/rollback API. Recording failure keeps old
history/manifests, quarantines new COW pages, and flushes the orphan suffix through
normal `gpu.flush`. Completion callbacks retire captures/uploads and release
quarantine only into its matching epoch. An already submitted prefix never
reuses a failed COW page early. The same exact plan can retry. Fake truly
discardable encoders remain supported. A flush failure intentionally retains
uncertain resources rather than destroying an unsubmitted reference.

Reset requires an advanced source epoch and no pending batch; Atlas is reset to
the same next epoch if needed. Old queued resources retire safely. Pure origin
movement must never reset. Dispose requires no pending/open Frame; owned Fields
resources are released after queue completion. The adapter owns its Fields.

## Submitted Source/Field provider

`cells.acquire()` pins the actual Atlas snapshot and returns immutable
`source:{contentToken,sourceRevision}`, `field:{publishedToken,complete:true,
sourceRevision,logicalFieldTick}`, world size/epoch, changed bricks, invalidated
cores and the concrete publication dependency-set identity/version.
`cells.isCurrent(snapshot)` rejects edits, superseded field publications,
resets/disposal and released handles. Pass the adapter directly as the optical
owner's snapshot provider; it already supplies both methods. The field batch is
complete, **not a claim all world cells exist**: unknown Atlas reads still latch
feedback and withhold Sun/render candidates. Tables/global Header/Frame bindings
and feedback/submission tickets remain the application integration's ownership.
The supplied dependency identity names this actual retained cell manifest; a
combined Atlas/Sun publish must explicitly include it in its dependency token.

This checkpoint still uses **mutable latest Source** during capture and currentness
checks. It is NOT the final application's owned immutable Source cut: an ordinary
later physics write correctly makes an old provider snapshot stale and can prevent
old asynchronous lighting from finishing. The next integration phase must own a
native-copy/COW Source cut (authoritative changed/live cores, aux, saved/pending
state and scene/tree configuration) so feedback/lighting retries stay on one cut
and cannot be starved by newer physics. That next-phase dependency is explicit;
no such cut, application activation, or world-renderer completion is claimed here.

## Checked CPU evidence / limits

`npm run check:world-cells` covers real Source/Producer/Fields/Atlas instances on
a delayed native fake, two-core scratch reuse, ordering, unseen settling,
required-page atomic invalidation, partial auto-submit quarantine and exact same
plan retry, pack retry without EMA, retained numerical validity, journal/store
transport, wake trust, unknown offscreen lighting/no-op/replacement/history pins,
all 65,536 native half patterns and original slots. Actual classifier and raw
packer assemblies pass Naga/default layouts; the production changed openFaces
leaf executes on a CPU WGSL interpreter against an independent world reference.
The full unchanged Box classification body is byte-golden checked; fake material
classification/field outputs are explicitly synthetic and NOT WGSL execution.
Existing quantized/partitioned Fields, Source, Atlas/backend, Sun, import,
sampler and build gates also pass.

This does not establish full classifier/spatial GPU execution, GPU==CPU,
visual invariance, driver compilation speed, throughput, peak memory or shipping
acceptance. Independent reviewer acceptance and eventual real integration/GPU
checks remain required.
