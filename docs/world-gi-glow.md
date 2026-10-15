# World GI/glow producers (disabled phase 4b)

These producers are **not enabled in the application**. They do not complete the
unified renderer, implement SourceCuts, or replace complete-frame admission.
Physics/source/fields/Atlas/application ownership stays with their existing
owners. CPU interpretation, reference tests, fake native devices and Naga are
not GPU execution, visual correctness, affordability or performance evidence.

## Shared arithmetic and actual layouts

`giSourceFrag` and `giGatherFrag` now have a default `backend:'box'` and explicit
world leaf composition. Default Box emission is byte-identical, including the
original selectors. World source keeps the actual 64-cell opaque mask/projected
coverage, extinction sum, fixed reduction tree, previous-probe irradiance,
material/metal diffuse/emission, exposed-face sun/lamps, normal weighting and
`giSrcPack`. Canonical air is `[0,0,0,0x1ff7fdff]`, not zero. Liquid/media-only
sources return before reading previous GI; opaque/crystal sources eagerly load
all four previous bands exactly as before. Sun uses the shared complete optical
world reader, with original GI zero-time/frame/caustics uniforms.

World gather keeps 32 Fibonacci rays, two probes per 64-thread workgroup,
`.99` burial, `.02` transmission cutoff, first six stride-one steps then stride
two, facing, SH reduction, normal `.4` blend and original background blend
`1-(1-.4)^4`. Rays continue until genuine world exit/extinction, not step12,
construction/physics edges or `farBeyond`. Exhaustion fails incomplete. Blending
is f32; the exact packed half pairs are retained and those unpacked halves are
stored to the four rgba16float outputs.

`worldGILayouts` starts from the actual full world reader: 16 sampled textures,
five storage buffers, four groups, separate cell/LIGHT/Sun books. Group3 adds:

| binding | source | gather |
|---|---|---|
| 6 | original GiParams uniform | same |
| 7 | 32-byte WorldGIParams uniform | same |
| 8 | source-first sorted global jobs, read-only vec4u | same |
| 9 | private packed GI-source buffer, read-write vec4u | same |
| 10 | absent | COW band-major packed vec2u history |
| 11..14 | absent | four write-only rgba16float 2D-array outputs |

Thus source uses seven storage buffers; gather uses eight and four storage
images. Outputs never alias sampled previous bands. Job words are global brick
index, background flag bit0, zero, zero. WorldGIParams contains source count,
probe count, absolute first status word, logical tick, epoch and three zeros.
The fixed output row width is256; probe slot `i` is `(i%256,floor(i/256),0)`.
Source records are16 bytes; history is `8*(band*probeCount+slot)` bytes. Each
allocation/binding is capped at the device limit and128MiB, not dense whole-world
source/history. Large worklists must be split without violating the barrier.

`worldGlow` composes the **original exported** `glowBlurWeightsWGSL` /
`glowBlurWGSL` from passes.js; the default Box blur bytes are unchanged. Exact
passes are x,y,z,x,y,z, weights `.10,.22,.36,.22,.10`, gain1.15 **each pass**,
f32 intermediate buffers and final rgba16float. Skipped true-exterior taps are
not renormalized. Missing in-world halo marks incomplete, never valid zero.
`worldGlowPlan(worldSize,core)` takes a global32-cell construction-core triple.
It requires four emission bricks/axis of support, hence17 raw cells including
original open-face neighbors (26 cells for arbitrary shading queries). Each
pass shrinks only its axis's remaining support. No low-resolution tier exists.
Glow uses one group: 96-byte uniform0, f32 input1/output2 storage buffers,
status storage3, final storage image4 only.

## Pinned input / history contract

`createWorldGI(gpu,{g,snapshotProvider,readerBindingProvider,feedbackProvider})`
uses the existing `gpu.frame`. `prepare({lightingTick,sourceBricks,gatherBricks,
reset,shadows,configVersion})` accepts global4-brick triples; gather entries may
be `{brick,background:true}`. Each phase is copied, sorted and deduplicated.

`await snapshotProvider.acquire({lightingTick,reset,sourceIndices,probeIndices})`
returns a pinned **owned immutable cut**, not mutable source or field scratch:

- `worldSize`, nonzero u32 `epoch`, `source:{contentToken,sourceRevision}`;
- `field:{complete:true,publishedToken,sourceRevision,logicalFieldTick}`;
- actual closure `dependencySetID/dependencyVersion` and `release()`;
- `previous:{complete:true,token,lightingTick:requestedTick-1,recordHistory}`.

`previous.recordHistory(frame,{indices,destination,format,lightingTick})` records
synchronously at call time, format `band-major-4x-vec2u`: native copies of the
EXACT four packed previous bands into the new private destination. No readback,
unsubmitted scratch alias, async recorder, or old-history overwrite is allowed.
Reset is explicit scene tick0 only: previous tick-1 has `resetSeed:true` and the
original zero histories/previous GI textures. The provider must separately bind
that complete previous probe snapshot for source reads. Cold unknown history
must be retained/replayed or explicitly initialized at the original reset; the
producer never silently restarts an existing probe on arrival.

`readerBindingProvider(cut)` returns exact native entry arrays G0..G3 for that
cut's full world reader, no pick output. Its bound A/B/fields/aux/books, previous
GI bands, Sun, uniforms, appearance and external resources must remain pinned.
Binding1 of G3 is replaced by this batch's feedback buffer. No live source is
consulted after capture or feedback. `snapshotProvider.isCurrent(cut)` means the
owned cut remains coherent and monotonic-admission compatible: **not** “latest
physics revision still equals this revision.” Newer physics alone must not
cancel queued coherent lighting. Epoch reset or explicitly superseded admission
may invalidate it. SourceCut capture/admission implementation is caller-owned.

All selected source jobs see the SAME previous snapshot. The source dispatch
finishes before the gather dispatch. A private sorted-key overlay resolves all
new selected source records; nonselected records use the cut's source book.
There is NO public partial Atlas publication between source and gather.
For multiple bounded source slabs, retain all source-only outputs, construct an
explicit PRIVATE source publication/overlay containing the complete selected
source phase, then run gather-only slabs against that private publication and
the SAME previous history. The caller owns that private cross-slab publication;
calling source+gather independently per chunk is NOT valid. No full-world dense
history buffer or hidden global staging framework is supplied.

## Glow provider

`createWorldGlow(gpu,{g,emissionProvider,submissionProvider})` has
`prepare({core,lightingTick,configVersion})`. `emissionProvider.acquire({plan,
lightingTick})` returns the same pinned cut metadata plus:

`emission:{complete:true,buffer,byteOffset,byteLength,min,size,
format:'xyz-linear-f32-vec4-emission-div64'}`.

This is the ORIGINAL brickFrag emission/openFaces result, already averaged by64,
not GI-source reflected radiance, a coarse substitute or another emission model.
It must cover the exact clipped plan.input bounds, x-fastest,16 bytes/brick,
256-byte aligned buffer offset. Parent's Source/Field/classification adapter
supplies it; this lane does not duplicate brickFrag. The provider owns/pins the
input buffer and uses the same owned-cut `isCurrent` semantics.

## Recording, lifetime and exact Atlas endpoint

Both candidates have `record(frame)`, `completion`, status, and pre-record-only
`cancel()`. No producer has a private encoder/queue.submit or Simulation.
GI `feedbackProvider.layout({snapshot,jobCount})` returns `wordCount`,
`reservedWords` (ENTIRE existing typed/Sun range), `jobStatusWordOffset` after
that range and `decode(allWords)`. Every source/probe has status1 success,
3 incomplete,0 unrun. Typed secondary misses or ANY failed status withhold the
whole output. Glow uses six status words, one per pass.

The submission provider `reserve(frame)` is called BEFORE any queued reference;
it returns `{submitted:Promise,record(frame,feedbackBuffer,wordCount)}`. Record
closes the complete readback boundary AFTER all jobs, even after partial encode
errors. `submitted` resolves only after the FINAL encoder/readback is submitted
(including auto-flushes), rejects only after discard/device loss, and MUST settle
on every failure. Only then is queue completion awaited. Early readback cannot
release input/output resources. Failed work stays unpublished orphan work,
retired after final submission AND completion; Frame rollback is never assumed.

Producer `published` means an immutable **producer output**, NOT application
admission or history advancement. Failed/stale candidates retain the previous
complete producer output. `snapshot()` returns a refcounted handle with
`retain()/release()/bindings()`. Source/field/config/tick/previous-history and
closure tokens are immutable. A same-tick retry/slab seeds from tick-1 again;
it does not blend twice. Existing complete cached handles are independent.
Every consumer retains a handle through its final submission AND completion.
Reset/dispose invalidate admission and cancel only unrecorded work; queued pins
remain until the reserved ticket settles safely.

GI handle `writeAtlas(atlas,job,'source'|'gi')` and glow handle
`writeAtlas(atlas,job)` are concrete async transport endpoints, usable AFTER batch
completion. They validate brick/epoch/source revision/channel tick/dependency
provenance and invoke actual `Atlas.recordLightWrite` (that API owns submission).
Source copies exact uint words; GI copies the four strided packed half pairs
into private32-byte scratch and unpacks them with the original texture-store
pattern; glow transports the final f32 result to the original rgba16float writer.
Original packed history remains uint-backed; no claim is made that arbitrary
NaN payloads survive floating-point texture transport. Scratch and output pins
survive Atlas submission/completion. These endpoints never publish the Atlas.

`createWorldLightingHistory` supplies world-keyed attachments plus original
selector rates, changed-lamp spheres, two-brick/22-tick recent-change dilation
and32-tick global settling. Records must supply actual masked age/matter/near,
not physics distance. `begin()` plans one exact next logical tick; `commit()`
adopts one completed output or compatible disjoint bounded slabs covering the
ENTIRE selection exactly once, only after caller's coherent publication.
`abort()` advances nothing. Capture pins and native-copies exact prior bands.
Known histories remain owned across page/physics transfers; missing history
throws. It does not manufacture cold replay or an arrival-based reset seed.

## Checked gate and remaining scope

`npm run check:world-gi-glow` checks seven pre-edit Box hashes, actual production
Naga/budgets (heights128/384, source capability on/off), controlled CPU production
source packing, source overlay,96 full-world rays including beyond-step12 hits
and secondary misses, multi-tick packed blend, actual six-pass glow versus a
contiguous f32/half reference, and fake-native resource/order/lifetime/retry/
history tests. The interpreter explicitly adapts its lexical-call scoping,
generic integer vectors, scalar workgroup-size AST, fresh-dispatch bindings and
IEEE half builtin. Those are CPU harness limitations, not GPU parity evidence.

Still caller-owned: real immutable SourceCut/Field/Atlas callbacks, private
cross-slab source publication, exact late cold-history replay, bounded source/
history eviction policy, coherent all-channel admission, figures/hands/readAt,
application switching/proxy removal, GPU numerical/origin-shift/visual and
performance acceptance. Do not deploy this disabled checkpoint as completion.
