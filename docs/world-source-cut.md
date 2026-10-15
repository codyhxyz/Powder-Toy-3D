# Owned native world Source cuts

Disabled foundation only: no application wiring, renderer switch, scheduler,
GI/Glow policy, physics pause or deployment. `WorldRenderSource.recordCut`
adds owned input versions to the existing Source/Producer/CELL pipeline. A
semantic content token alone still does **not** own native bytes.

## Capture and bind

```js
await win.sourceProducer.ready;
await cells.ready;
const cut = win.renderSource.recordCut(gpu.frame, {
  previousCut,                 // optional, still-valid same-parent handle
  sceneVersion, configVersion // explicit immutable primitive versions
});
cells.bindCut(cut);            // same adapter, WorldFields and history objects
const batch = cells.record(gpu.frame, { fieldTick, requirements });
gpu.flush('owned source/cell captures');
const publication = cells.commitAfterSourceFlush(batch);
publication.previousLightingSnapshot.release(); // if unused
const provider = cells.sourceFieldSnapshotProvider;
const snapshot = provider.acquire();
```

Capture requires the loaded authoritative world, its actual ready
`RawWorldSourceProducer` and `SceneGpu`, and the normal engine `gpu.frame`.
It is synchronous and records copies only: it neither submits nor waits. Later
physics work must follow normal Frame/ordered-write rules. Direct out-of-band
queue writes to borrowed engine buffers are not supported.

`bindCut` retains its own handle and rejects pending CELL work. The adapter's
mutable mode remains unchanged. Binding a newer raw revision requires an
appropriate next logical `fieldTick`, as before; this API does not decide when
to admit a build, advance a tick, replay history or replace an active renderer.
After a world reset, bind the new cut then call the existing adapter `reset`.

## What the cut owns

* Native single-copy A/B words, selected flow, aeration **copy**, deco **offset**,
  validity/provenance, ranks, revisions and pending-save authority for known
  saved/captured/live 32³ cores. No dynamic CPU readback or float conversion.
* Independent encoded saved/deco-store bytes, planted target masks, frozen
  original generator parameters and immutable built-in tree generator identity.
  The copied stores are sparse encoded state, not a dense world image.
* Packed SceneGpu uniform bytes and native scene data, including mutable
  imported/interactive geometry. A private scene prepass group writes only the
  cut's data, using frozen prepass margins/capacity and compiled engine kernel.
* Frozen scene/import metadata and a copied appearance configuration mirror.
  Ordinary engine tables and compiled kernels are immutable borrowed engine
  inputs; this API does not invent replacement tables or global frame state.

Future dependency feedback uses `cut.producer`/`cut.source`, never newest live
buffers or current window stores/parameters. Original full-height tree order,
footing/support and planted target masking remain the shared production path.
Unknown mutable CPU tree hooks, resource owners or scene binding shapes reject
capture rather than silently reading current inputs. Detected scene uniform/
resource changes without Source/configuration invalidation reject reuse.
Caller scene/configuration versions must change when those inputs change;
normal semantic SceneGpu data callbacks already invalidate Source globally.

With a compatible previous cut, unchanged cores (including lazily generated
cores) and unchanged scene resources share owned versions. A later producer
write first COWs a shared core, including all auxiliary and authority metadata.
Changed semantic cores receive new native copies. Merely moving physics origin,
changing raw ownership or acknowledging a pending save is not a content change.
Static-only discovery is regenerated from the frozen generation context rather
than eagerly copying the entire mutable generated cache.

## Lifetime and validity

Handles expose `identity`, `configuration`, `contentToken`, `retain`, idempotent
`release`, `isValid`, `isLatest` and `snapshotForFields`. `isValid` deliberately
survives later physics/source revisions; `isLatest` does not. Parent reset,
disposal or a changed scene/configuration version invalidates old cuts. Owned
snapshot completeness/gather and production reject invalidated input.
`source`/`producer` expose the actual engine classes for the adapter, not mutable
application surfaces: do not mutate their owned context or dispose/reset them;
release the handle instead.

A CELL provider acquisition owns both an Atlas snapshot and its Source cut.
For owned snapshots `provider.isCurrent` means valid provenance, **not latest
physics or latest CELL publication**. Older coherent Atlas/field values remain
valid while pinned; mutable-mode latest-publication checks remain unchanged.

Keep every handle/snapshot until its reader's final submission **and queue
completion**. A Source-only convenience reserves a pin **before** recording:

```js
const completion = cut.retainUntilSubmitted(finalSubmissionPromise);
// Record all consumers, including possible automatic-prefix submits.
// Resolve finalSubmissionPromise only AFTER their final suffix is submitted.
// Rejection means aborted/orphaned work; close the normal Frame normally.
await completion; // actual onSubmittedWorkDone, then releases the Source pin
```

This does not pin unrelated Atlas/lighting resources; retain those snapshots
separately. A completed automatic prefix is never the final fence. On last
release or capture failure, native destruction waits until no open normal
Frame can contain an unsubmitted suffix, then waits for submitted work. Failed
unclosed graphics encoding is conservatively retained, not recycled. Release
cannot manufacture a new Frame, force a flush or prevent ongoing simulation.

## Evidence and limits

`npm run check:world-source-cuts` runs delayed-command CPU/fake-native tests with
actual SceneGpu, Source, RawProducer, Fields and CELL/Atlas classes. It covers
full A/B and auxiliary bit transport (signed zero/NaN payloads included), old-cut
late saved/generator feedback during newer physics, pending-save ownership,
core sharing/COW, private prepass bindings, provider pins, configuration/reset
invalidation and failed automatic-prefix/unsubmitted-suffix retirement.
Tree placement/shape tests execute the original CPU generator. Fake native
shader outputs are synthetic: these are **not GPU numerical/visual parity or
performance evidence**. Existing shared shader checks remain applicable.

Costs are unmeasured. First capture copies known authority, not dense world
volume; changed cuts copy dynamic authority cores, while immutable versions can
share. Encoded CPU stores/configuration are copied per capture; mutable native
scene data is copied on initial/global capture. Live cut counts, scene-data size,
CPU copy cost, memory pressure and admission limits remain caller concerns. No
claim of practical full-world renderer affordability is made.
