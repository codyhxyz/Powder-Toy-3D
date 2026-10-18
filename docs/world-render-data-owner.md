# WORLD data owner (explicit installation; not activated)

`installWorldRender(win, options)` in `src/wire/worldRender.js` constructs the
real Atlas, CELL/Fields adapter, lighting metadata ledger and GI history. It
uses real GI, six-pass Glow, sparse optical Sun and native reader/feedback
providers, not a renderer callback interface. No existing game call site selects
it. Parent still owns opaque pixel capture, all actual scene/native consumers,
feedback readback, Post and production activation.

## Parent hooks

After the real Source/Producer and native external publications are ready:

```js
const data = installWorldRender(win, { gpu, source, producer, tables, tableBuffer, wake });
const candidate = await data.request({
  sceneVersion, schemaVersion, configVersion,
  values: frozenFrameUniformValues, physicsOrigin: capturedOrigin,
  params: frozenVolumeSettings, globalKey: lightKeyWords, lamps: worldLamps,
  sun: { direction, basisRevision },
  external: { mediaNoise, sourceAppearance: nativeUnusedAppearance, packedMesh },
  pins: [tablesPublication, noisePublication, packedMeshPublication],
  advance: true,
}, typedRequirements);
```

`tables` is the normal kernel's TABLES **bind group** (default: `sim.tables`).
`tableBuffer` is its matching native **buffer** (default:
`gpu._simTables.buffer`). These are not interchangeable. Native reader bindings
use the buffer; CELL/Fields dispatches use the group. Neither option copies or
freezes mutable table contents by itself. The actual Source cut now captures
the native bytes. The owner uses that snapshot for generation, CELL/Fields and
native lighting. `candidate.tables` borrows its `{group,buffer}` under candidate
retention. Pass `tableBuffer:candidate.tables.buffer` to every volume/query
`prepare()` call, including calls through a cached factory. A lifetime pin alone
would not freeze Simulation's `airT` word.

All pins implement `retain()->{release()}` and must cover the supplied native
values; they are not readiness callbacks. Tables and external views must stay
immutable under those pins. The independent artwork texture is made from the
real owned cut's synchronously copied `scene.appearanceWords`. Far.grid is not
borrowed. Use `candidate.frame.values`, `.physicsOrigin`, `.params`, `.external`
and the original caller's pinned native resources, not newly mutable App state.
`candidate.appearance` is the independent artwork handle. Compile the volume
with its fixed `.sourceGrid`/sourceAppearance feature; `candidate.frame.values`
already contains this cut's actual appearance uniform and `.external` its actual
view. Do not install a previous candidate's artwork as a long-lived mutable
factory default. `candidate.snapshot` is the exact final Atlas handle: pass
`snapshot.retain()` to a consumer that transfers snapshot ownership (such as
volume.prepare), not this borrowed handle itself. `candidate.lighting` is its
matching native Sun publication.
`candidate.sunTextures` borrows the actual `{sun0,sun1}` GPUTextures from the
retained Sun snapshot. Native Three lighting must use these, not unwrap views.
Pass `appearance:candidate.appearance` to `volume.prepare()` as well. Reused
factories must not replace a new cut's artwork with their first handle.

A successful `request()` returns a **probe-ready** owned handle, not an accepted
image. It exposes `identity`, `cut`, `lightingTick`, `logicalFieldTick`, `frame`,
`snapshot`, `lighting`, `appearance`, `retain()` and `release()`. Parent must hold
its handle through final submission AND queue completion. Release every returned
handle; a superseded queued request resolves `null`.

Record real actors/opaque coverage/volume/points/picks/signs/mesh-light readers
and staged Post using this exact handle. Post receives `publication:
candidate.retain()` and an immutable `feedbackIdentity`. Decode and combine ALL
native/scene feedback into `{incomplete, requirements, sun}`. Misses call:

```js
const expanded = await data.extend(candidate, decodedFeedback);
candidate.release(); // after that candidate's final consumers settle
```

Extension keeps the original cut, GI seed/clock and Fields capture clock. A
complete producer closure still does not assert complete scene dependencies.
Only after real `post.commitScene()` and its final confirmation:

```js
await data.accept(candidate, { feedback: completeDecodedFeedback,
  feedbackIdentity, postTicket });
```

`accept` checks exact candidate/publication, scene identity, feedback identity,
empty typed/Sun misses, committed Post status and `confirmation === true`.
Incomplete feedback or a callback cannot bypass this gate. Acceptance is locked
against extension while confirmation is pending. A rejected final Post leaves
both ledgers unchanged and the previous accepted bundle usable. Parent may
resubmit the same candidate, extend it, or explicitly `discard(candidate)`.
`current()` returns the last accepted handle; `probe()` returns only the current
probe-ready candidate. Neither exposes intermediate CELL/private publications.
`atlas`/`cells` are producer internals, not App scene admission endpoints.

## Scheduling, clocks and rejection

Only one cut is active. Ordinary newer physics/cameras coalesce the *next*
request; they never cancel the pending cut. Normal advancement plans exactly
`history.lightingTick+1`. `advance:false` is camera-only birth: it requires the
accepted cut and unchanged global lighting key/configuration. All genuinely
never-owned submitted metadata records form the full birth cohort, with complete
first gathers. Known SOURCE/probe ownership and metadata include offscreen data.

SOURCE slabs are grouped by the existing 32-cell construction cores and split
further at native/128-MiB limits. ALL source slabs finish and stage before ANY
gather. Authenticated staged SOURCE plus the exact previous packed GI are
restored into separate private jobs. Capacity is preallocated before the whole
private closure, and CELL snapshots reacquired afterward. Final jobs are
separate. Final LIGHT and Sun install together. Known channels retain original
per-channel tokens/ticks/dependencies across current-cut validation.

Fields capture clock and accepted GI/metadata clock are intentionally distinct
(supervisor-approved contract). CELL publishes Fields while an image is still
BUILDING. A new frozen cut reserves `fields.lastTick+1` (initially zero); retries
and camera births keep its original capture tick. Rejected Post does not advance
GI/metadata. Explicitly discarding that cut permits the next queued cut to use
the next Fields capture tick, without skipping offscreen dynamic EMA owners or
relabeling GI's accepted clock. Both stamps are exposed in the bundle.

Metadata comes from actual submitted classifier words and native raw/aux delta,
not conservative revision bounds or capped Fields age. Current near is exact
change dilation2; history adds accepted recent22 and lamp support. Original age
caps at255. Metadata and GI adopt only once after confirmed complete Post. The
owner currently recomputes all demanded/retained Glow construction cores from
full submitted halo4 emission on every attempt: exact offscreen Glow changes
cannot be dropped, and no GLOW restore/approximation is invented. This is not a
measured optimization.

`retry()` is only for a definitively rejected normal final suffix, and retries
the same cut and original seeds. `failure`, `state`, `busy`, and `wake` expose
progress. A still-recordable failed suffix instead reports `blocked`, rejects
new admission and retains unresolved native pins, including metadata pins. It
cannot retry/reset over the orphan. Terminal graphics reclamation is deliberately
not implemented; retire the graphics owner/device. A blocked `dispose()` does
not falsely resolve cleanup.
Retry and discard reserve their transitions before waiting. A concurrent
duplicate cannot restart the same work or clear a replacement queued cut.

`reset({sceneVersion,schemaVersion})` requires Source to have authoritatively
advanced exactly one epoch. It stops admission, waits old normal suffix/queue
settlement, clears owner ledgers, binds a real new-epoch cut and resets CELL/
Fields/Atlas. Do not use reset for ordinary physics, camera, origin or residency.
`dispose()` closes admission immediately and waits normal settlement. Retained
image handles continue owning their independent native resources until released.

## Evidence and remaining integration

`npm run check:world-render-owner` uses actual Source/Cut/Producer/Fields/CELL/
Atlas/history/GI/Sun/Glow/metadata/provider classes with delayed fake native
execution. Lighting kernel math and the Parent Post ticket are explicitly
mocked; production delta WGSL runs in the CPU interpreter. Existing union tests
cover original numerical WGSL leaves/Naga and partial native transport.

Covered: unknown Sun/CELL/SOURCE feedback, same-cut expansion, two source core
slabs before any gather, offscreen retained histories, mixed SOURCE2/GI1 tokens
on cut R+1, 384-height last brick, queued newer physics, explicit abandonment and
separate Fields clock, same-clock birth, final prefix rejection/retry, out-of-order
scene identities/reset, accepted-only metadata/history adoption and external pin
lifetime, unknown-recordable metadata suffix blocking.

No App activation, actual Post/opaque/native-consumer route, GPU execution,
visual parity or performance proof is claimed. Independent review and Parent's
real all-consumer/Post wiring remain required before activation.
