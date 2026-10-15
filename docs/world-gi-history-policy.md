# Explicit world GI initialization

## Approved guarantee

This policy replaces the internal late-initialization prohibition in plan `7daa5101`.
It does not enable the world renderer.

The renderer uses the same GI arithmetic at every world position.
Existing probe histories survive physics-origin changes, page allocation, residency changes, and camera movement.
A genuinely never-owned probe can receive an explicit first initialization.
This initialization is not historical replay.

The guarantee covers frozen-input and physics-origin invariance for accepted dependencies.
It does not guarantee tick0-reference equivalence, visit-order independence, or invisible first-use lighting transients.
Thirty-two warm ticks do not prove convergence.
The dependency closure can include the whole world.
Memory cost and runtime cost remain unmeasured.

## Initial conditions and missing data

Only `createWorldLightingHistory` issues authentic initialization manifests.
Each manifest declares an immutable identity, `birthTick`, committed cut identity, exact previous-generation identity, and never-owned probe IDs.
A copied or forged manifest has no initialization authority.
Expansion invalidates the old manifest and its private staged outputs.
Authoritative history remains unchanged.

For declared new IDs, the original packed-zero previous GI is an initial condition.
This seed does not make a probe ready.
Each new probe needs its first full 32-ray gather with the original reset blend1.
Existing gathers retain their normal `.4` or background coefficients.
No batch-wide late reset affects mature probes.

Missing raw data, fields, Sun data, and GI sources remain unknown.
Canonical air source remains `[0,0,0,0x1ff7fdff]`.
The seed is never a substitute for that source record.

Opaque and crystal sources read their own previous probe.
An undeclared missing previous probe produces ordinary typed GI feedback.
The caller can expand the cohort with that never-owned probe.
The source retry then uses its declared initial condition.
The cohort still needs the first full gather before adoption.
Air and liquid-only source paths return before this previous-probe read.
They do not require invented probe owners.

## Real ledger API

`begin()` still plans the exact next logical tick.
Its optional `initialization` declaration adds births to that ordinary transaction:

```js
const plan = history.begin({
  lightingTick, globalKey, records,
  initialization: { cutToken, sourceBricks, probeBricks, records: birthRecords },
});
```

`records` must include every owned offscreen probe.
Records supply actual age, matter, and lighting-near declarations.
They do not supply a physics-distance quality tier.
Birth age stays world-keyed in the ledger.
Normal selection retains the original checkerboard, settling, and background rules.

`beginBirth()` augments the committed clock without advancing it:

```js
const plan = history.beginBirth({
  cutToken, sourceBricks, probeBricks, records: birthRecords,
});
```

The cut identity must equal the committed cut.
This operation rejects existing probe IDs and previously computed source IDs.
Known tick-T sources remain exact retained native records.
They are not recomputed from H(T) and labelled as H(T-1).
The ledger retains the actual previous generation for new source evaluation.
`history.captureSources({indices})` pins retained source buffers and their original tokens.
`bindingsFor(index)` exposes the buffer and byte offset without readback or retagging.

`plan.expand({sourceBricks,probeBricks,records})` adds never-owned dependencies.
Duplicate probe declarations and existing owners reject initialization.
Expansion validates every record before it changes worklists or ownership.
A rejected expansion preserves the previous manifest and staged native outputs.
`plan.expandFeedback(feedback)` interprets typed GI_SOURCE/GI misses.
Its `restore` result names known dependencies that need residency restoration, not reinitialization.
Its `requirements` result preserves raw, field, auxiliary, and glow misses.
Sun misses remain caller-owned dependencies.
The caller supplies actual birth records before sealing.

`plan.initialization` is the current authentic manifest.
`plan.sourceBricks` and `plan.gatherBricks` expose owned sorted worklists.
Each expansion changes the manifest identity.
Retries use the same previous declaration, not a candidate result.

## Producer and source barrier

The actual producer accepts the manifest:

```js
const candidate = await gi.prepare({
  lightingTick: plan.lightingTick,
  reset: plan.lightingTick === 0,
  configVersion,
  sourceBricks, gatherBricks,
  initialization: plan.initialization,
});
```

The input provider must return the same manifest as `input.initialization`.
`input.previous.initialization` must also identify that manifest.
`plan.capturePrevious({indices})` supplies the real previous-history pin and synchronous copy recorder.
It copies known packed bands and clears only declared never-owned slots.
Its previous clock is exactly `lightingTick-1`.
The provider separately binds exact previous bands for known reflective source reads.
`bindingsFor(index)` exposes captured previous native backing for those bindings.
Unknown source self-reads remain unmapped and produce feedback.

Job flag bit0 remains the background flag.
Bit1 authorizes the declared birth initial condition and first-gather blend1.
Only the ledger manifest supplies that bit.
The full source and gather factories retain their original arithmetic and resource limits.
Default Box emission remains unchanged.

A combined batch can contain the entire source phase followed by gather.
Multiple source slabs require a separate complete private source phase.
No gather slab can start while a source slab is missing.
The caller records and completes each source-only batch before `plan.stage(output)`.
Stage accepts actual completed producer handles and retains their native output.
It rejects duplicate jobs and incompatible cut, dependency, or previous-generation provenance.

`plan.captureStagedSources()` pins all completed source-only outputs.
Its `token` is the manifest source-phase identity.
Its `outputs` are real producer handles with native bindings and transport endpoints.
The caller builds a private source publication from those exact outputs.
No partial source phase becomes a public Atlas publication.
A gather-only input must bind that private publication and return its identity as `input.sourcePhaseToken`.
A token alone does not replace the required native publication.

## Admission procedure

1. Freeze the cut and pending camera.
2. Begin the ordinary transaction or same-clock birth transaction.
3. Resolve all raw, field, and Sun requirements against that cut.
4. Complete and stage every selected source output.
5. Construct the private source publication from retained completed outputs.
6. Complete and stage all gather outputs.
7. If feedback finds dependencies, expand the cohort before another attempt.
8. Reconstruct private outputs after expansion.
9. Supply actual records for every new probe.
10. Seal the complete closure with `plan.seal({cutToken,feedback})`.
11. Publish the coherent renderer channels through their existing owner.
12. Call `plan.commit()` after that publication succeeds.
13. Retain consumer pins through final submission and queue completion.

Sealing requires complete source and gather coverage.
It also requires `feedback.incomplete === false`, no typed requirements, and no Sun misses.
A seed-only or source-only reflective probe cannot pass this gate.
Publication failure does not advance history.
`plan.abort()` discards private outputs and changes no authoritative history.
The caller can retry the same logical tick.

Completed birth owners participate in every later ordinary selection, including offscreen selection.
Draw calls and source acquisition never advance the logical clock.
A pending cohort must finish before the caller replaces its camera demand.
This rule prevents camera motion from continually cancelling initialization.

Each history object owns one scene epoch.
After an epoch reset, the caller creates a new ledger and disposes the old ledger.
Old manifests reject new work.
Existing captured native handles remain owned until their consumers release them.

## Evidence boundary

The CPU gate uses the real ledger and GI producer factories with delayed fake native resources.
It covers paused augmentation, recursive feedback, source slabs, adoption, retained sources, and known packed-history preservation.
Executed production leaf tests cover zero-previous eligibility, missing-source feedback behavior, and blend1 versus mature blending.
Naga validates the actual source/gather modules and default resource limits.
Seven original Box shader hashes remain unchanged.

These checks are not GPU numerical parity, visual acceptance, performance evidence, or completed App integration.
The caller still owns native private-publication construction, complete feedback, channel admission, and final submission tickets.

## Authenticated retained transport (disabled owner prerequisite)

Construct the ledger with `{worldSize,epoch,sourceOwner,configuration:cut.configuration}`.
This binds the real Source owner and scene/schema configuration, not changing
light uniforms. `history.captureRestore({cut,configVersion,sourceIndices,
probeIndices})` pins exact retained channels. Real frozen recordCut handles are
required: cloned, foreign, released, reset or incompatible configuration cuts
reject. Ordinary physics after capture does not invalidate the owned cut.
The packed schema is `world-packed-source-gi-v1`; incompatible scene/schema
configuration requires a new ledger/epoch, not silent mature-history reseeding.
Changing ordinary light `configVersion` is deliberately permitted: previous
SOURCE/GI are causal temporal inputs with their ORIGINAL config/compute tokens.

The bundle has frozen `.publication` (explicitly `current-cut-validation`) and
`.leases`. Allocate each Atlas job with `publication:bundle.publication`, current
`sourceRevision`, ORIGINAL per-channel sourceTick/giTick and dependency IDs.
`createLightingTransport(gpu.device,['source','gi']).restore(gpu,atlas,entries)`
accepts `entries=[{job,lease},...]`. It prevalidates all requested prepared
channels, batches exact packed native copies on normal gpu.frame, flushes once,
then invokes unchanged Atlas native writers. GLOW is never restored here.
Keep the bundle alive through publish (and every consumer through final submit
and queue completion); release it afterwards. Transport's independent pins
survive failed/partial writes, suffix closure and queue completion. An uncertain
still-recordable failed suffix deliberately retains allocations until terminal
retirement. The default output.writeAtlas provenance guard remains strict.

`snapshot.lightingProvenance(brick)` returns a frozen per-channel manifest with
original compute token, previous history token, ledger ownership token, native
buffer/ranges, packed schema and separate current-cut validation publication.
Native descriptor sourceTick/giTick are original compute clocks, never restored
publication clocks. Atlas still requires every ready payload actually written.
Neither transport nor private publication advances ledger history.

For gathers, `plan.captureRestore({...args,sourcePhase:true})` requires ALL
selected SOURCE slabs staged, overrides retained sources with those actual
current outputs, and takes GI from the plan's exact previous map. Its requested
sourceIndices must include ALL selected sources plus retained dependencies.
After restoring jobs, `atlas.prepareProducerSnapshot({lightJobs,
sourcePhaseToken:bundle.publication.sourcePhaseToken,dependencyToken})` creates
an independently pinned private LightBook with SOURCE and previous GI together.
It does not replace Atlas.current, generation, readiness or presentable demand;
its direct bindings reject. Pass it as `previousAtlas` to existing lighting
inputs/producerBindings, with the current CELL snapshot as `atlas`. Keep that
private snapshot, bundle and jobs pinned until gathers' final completion; then
release snapshot, cancel private jobs and release bundle. Final publication
uses separate jobs containing final GI and current computed GLOW.

The dependency-free restore registry is trusted internal engine issuance, not a
security sandbox against malicious code importing private implementation APIs.
Only the real ledger calls its internal issuer; caller clones/objects have no
WeakMap brand. Import-order tests prevent the Atlas/history/shader TDZ cycle.
These delayed fake-native tests establish transport/provenance/lifetime evidence,
not GPU numerical parity, owner integration, visual parity or affordability.
