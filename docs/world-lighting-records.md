# WORLD lighting records (CPU metadata protocol, not App activation)

`createWorldLightingRecords(gpu, {worldSize, sourceOwner, submissionProvider?})`
from `src/world/worldLightingRecords.js` owns world-keyed metadata independently
of Atlas residency. Await `ready`. The optional submission provider is the
existing final-boundary `reserve(frame)->{submitted,record(frame,buffer,words)}`
protocol. Default is the concrete normal-Frame feedback provider. No private
encoder/queue submission, raw CPU readback or fake Simulation is used.

## Exact owner integration

1. Retain the current **real owned cut**. Bind it to CELL, expand actual CELL
   requirements for every retained probe/source index plus births, and finish
   the normal submitted CELL publication. Acquire
   `adapter.acquireClassification({bricks})` from that installed publication.
2. Call `record(gpu.frame,{cut,previousCut?,classification,derivedTick})`.
   The helper takes ownership of the classification lease only after synchronous
   preflight succeeds. On preflight failure the caller must release it. On
   success do not release it yourself. `previousCut` is optional identification
   of the committed baseline, not an input lifetime requirement: the helper
   already retains its own immutable baseline, so the old caller handle may
   have been released. Current cut and classifier publication must still be
   valid and match exact cut identity, epoch, configuration and semantic stamp.
3. Await `batch.completion`. This waits for matching final submission, all
   submitted work (including automatic prefixes), and **only tiny metadata**
   readback. `batch.records(indices,{derivedTick})` returns pending
   `{brick,age,matter,near:false}`; `batch.changes` gives exact `changedBricks`,
   `emissionChangedBricks`, and `glowDirtyIndices` (complete clipped Chebyshev
   halo of four bricks, not only resident pages). Changes are not published yet.
4. For the same-tick private GI plan, combine these records with the original
   current-change dilation2: set `near` for records within two bricks of
   `batch.changes.changedBricks`. The history ledger supplies **previous accepted**
   recent22/dilation2 and lamps itself. Do not mutate `history.noteChanged` for
   a plan that might be rejected. On full scene acceptance, synchronously commit
   this batch and the matching history transaction; call
   `history.noteChanged(changes.changedBricks, changes.derivedTick)` for accepted
   changes. Pass all owned offscreen probe/source records to `history.begin`,
   not an Atlas-resident subset. Feed halo indices to exact Glow dirty scheduling.
5. If feedback expands, keep this batch and same logical clock while staging the
   scene. If additional metadata is required, discard and re-record the union
   on that same tick. On full rejection call `batch.discard()`; committed ages
   and stamps remain unchanged. One pending batch at a time. `records()` on the
   owner returns committed records, while `indices` lists **all** known owners.
   Unknown indices throw `error.requirements=[{brick,index,channels:READY.CELL}]`.
   A newer cut must supply every previously known index or throws those same
   typed requirements; no offscreen data is silently declared mature.

`reset()` discards pending publication and baseline, clears metadata and clock;
use on epoch or scene/configuration/schema change, never camera/origin/residency.
`dispose()` also closes admission. Pending native resources remain pinned until
completion even after reset/disposal/discard. A recordable graphics-error suffix
follows the existing feedback provider's blocked contract: keep pins, retire the
graphics device/owner, do not admit retries over an unknown encoder disposition.
This is an internal trusted-caller contract, not hostile-code authentication.

## Native and readback layout

`WORLD_LIGHTING_RECORD_LAYOUT`, `batch.indices`, `wordCount=5*N`,
`metadataWordOffset=0`, `changeWordOffset=4*N` describe the native `batch.buffer`:

* words `[4*i..4*i+2]`: original F32 emission xyz/64 **bit words**;
* word `4*i+3`: original UINT BrickInfo (decode original `BRICK_INFO.MATTER`);
* word `4*N+i`: exact raw/aux changed flag (0/1), or explicit new-record birth.

Order is exactly `classification.records`, not world xyz-linear source storage.
`batch.buffer` and immutable per-core jobs are batch-owned, transient until
completion and destroyed after its fence; callers must not retain/use them as
GPU histories. `batch.readback` is an immutable tiny CPU word array available
while pending acceptance. `completion` resolves to the batch; commit returns
changes and consumes it, discard consumes without publication. Status is
`recorded`, `pending-acceptance`, `committed` or `discarded`.

## Age and change semantics

Original `ageFrag` consumes writers' MARK_DERIVED and gated ACT_CHANGED (plus
reset/shift marks); its age is derived logical frames since changes, capped255.
Source cuts expose no frozen original mask. Its journal bounds can cover the
whole live window every physics step and are therefore **candidates only**.
This protocol compares actual owned previous/current A/B u32 words within those
candidate bricks and all flow/aer/deco words whose per-cell provenance/presence
flags say they are present. Stable NaNs remain stable; signed-zero changes are
real word changes; absent stale auxiliary bytes never manufacture changes.
This is precise source-word invalidation, not replay of conservative activity
wake marks, and introduces no floating thresholds or physics-domain tier.

Original source-grid brickId/slot offsets are used. Raw and aux passes are split
at six/eight storage bindings. One immutable jobs buffer pairs old/new slots and
per-cell aux flags, with no ninth storage binding. All work shares the normal
Frame final boundary. Metadata can change during Fields settling without raw
change: emission comparisons still invalidate Glow exactly, but never reset raw
age. Ages use `min(255, derivedTick-lastActualChangeTick)`, not the Fields EMA
settling age13. Unknown previous data is explicit birth age0. Same-tick retries
and camera births do not advance known ages. Base `near:false` is intentional:
the history/current-change integration above supplies original recent22,
dilation2, lamps and original selector without all-near or forever-changed hacks.

Validation is CPU fake native transport, production delta WGSL interpretation,
and Naga leaf validation; it is **not GPU parity**, performance evidence or a
completed `win.render`/App switch.
