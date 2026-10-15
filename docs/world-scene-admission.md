# World scene admission (phase 5a)

These APIs are implemented but **not selected by the application**. They do not
supply Source cuts, complete lighting, mesh-light readers, Plain, or a finished
world renderer. CPU/native-recorder tests are not GPU or visual acceptance.

## Synchronous world volume

`createWorldVolume()` now exposes:

- `pipelineState(view, detail, curved)`: a stable record with `state`
  (`pending`, `ready`, or `failed`), `ready`, `pipeline`, and `error`.
- `viewReady(view, detail, curved)`: the cached native pipeline promise.
- `pickState` and `ready`: the same state/promise for picking.
- `candidate.recordDraw(pass, options)`: returns `false` without recording if
  its pipeline is not ready; otherwise records the entire draw synchronously.
- `candidate.recordPickReady(frameOrEncoder, {params, output})`: likewise;
  it checks readiness before opening a compute pass. A Frame uses `direct()`.

Check readiness **before opening** a scene pass. The existing asynchronous
`draw()` and `recordPick()` share these recording bodies, but are only for
callers that can await without closing/submitting the supplied encoder. Pick
inputs are validated and packed into owned bytes before their first await.

`frameUniformValues(frame)` builds owned packer values without GPU writes.
Update the input camera matrices first. `writeFrameUniforms()` uses this same
helper while retaining the existing shared `last` matrices for BOX consumers.

For WORLD, build `worldModelMatrix(localVolumeModel, capturedPhysicsOrigin)`;
this is `localVolumeModel * T(-origin)`. Pass that model to
`frameUniformValues()`, then call `worldFrameValues(values, origin)` **once**.
The camera is then global. Lamp/wand/dig coordinates are converted once;
beacon, cloud, artwork, presentation coordinates and world camera are not
translated again.

## Staged Post

The existing BOX `render()` and `renderStill()` remain immediate. The WORLD
caller instead uses these methods:

```js
await post.sceneReady;
const ticket = post.recordScene(hooks, camera, {
  identity: {epoch, sceneToken, configVersion},
  publication,                 // owned handle with release()
  feedbackIdentity,            // stable identity of the complete readback
  submission: {submitted},     // caller-owned final-submit promise
  dt, viewmodel, glow, onCommit,
});
```

The first recording registers the current identity without changing temporal
history. Call `setSceneIdentity(identity)` explicitly when the scene, epoch or
configuration changes; a mismatched recording is rejected rather than resetting
committed history as a side effect of a candidate.

`null` means pipelines or the bounded pool are busy; no publication ownership
was acquired. A successful recording, or a failure after recording starts,
transfers the publication handle. The default pool limit is three; configure
`maxPendingScenes` from one through eight. Allocation does not change FPS.

All hooks must be synchronous. Native async functions are rejected before
invocation; returning a thenable is an error. The order is:

```text
prepare -> compute -> opaque -> capture -> volume draw -> transparent meshes -> overlays
```

`capture` is the seam for the real opaque HDR/depth/coverage packer, not a
fabricated depth-only image. No TAA, adaptation, composite, screenshot callback,
or committed-camera update occurs during recording. Projection/view offsets
and temporary pixel scale are restored in `finally`, including on failures.
The ticket freezes its camera, matrices, jitter, presentation, sky, image
settings, dimensions and time. Viewmodel/glow images are copied after the scene
hooks; supplied images must support `COPY_SRC`.

After every scene reader (including mesh lighting) has finished, the caller
records and reads the **complete** feedback, flushes the final encoder prefix,
and resolves `submitted`. Automatic prefix submissions are not final submission.
Then:

```js
const accepted = post.commitScene(ticket, {
  feedbackIdentity,
  feedback: {incomplete: false},
  submission: {submitted: finalPostSubmission},
});
```

Feedback identity must match. A false/missing completeness result discards the
scene. An unconfirmed source submission returns `false`; retry after it has
been confirmed. Changing scene/epoch/configuration, reset, resize, disposal or
nonmonotonic normal-scene order rejects old tickets. Ordinary newer physics or
camera movement does **not** reject a consistent older scene.

Acceptance records motion/TAA/history/depth, adaptation and postprocessing.
The ticket becomes `admitted` until `finalPostSubmission` settles.
`ticket.confirmation` resolves to `true` only after that submission succeeds.
Then the ticket becomes `committed`, and Post calls `onCommit`.
The retained last image changes at this boundary, not during recording.
`ticket.completion` also waits for GPU completion and input retirement.

While a final Post submission is unresolved, another commit returns `false`.
Retry after submission settles. This prevents temporal dependencies on an
encoder that might be discarded. It does not wait for GPU idle.

Three's actual TAAU jitter hooks have a reversible reservation:
recording and rejection do not advance its committed index. Acceptance installs
the captured sample and advances once. Already queued scenes may share the
currently committed sample; reprojection uses each scene's captured jitter.
If the final submission fails, the ticket becomes `failed`.
`ticket.error` records the error, and `ticket.confirmation` resolves to `false`.
Post invalidates tentative temporal history and preserves the previous complete
image. A late failure from an old scene identity cannot invalidate new history.
An already submitted prefix cannot be rolled back.

The accepted final composite is retained in a separate texture.
`post.presentLast({submission})` blits that exact image without another temporal,
adaptation, or time step. It returns false before any admitted image, after a
scene identity change, or when the canvas size differs. The caller may instead
show explicit loading. No missing scene is admitted as lower-quality geometry.

`post.discardScene(ticket)` explicitly rejects a queued candidate. Do not make
screenshot or mesh-cache commits from record hooks; use `onCommit`.
`recordStill(hooks, camera, target, options)` / `commitStill(ticket, options)`
provide the same validation split for stills, without changing normal temporal
history or jitter. Stills skip `compute` as the existing still path does.

## Submission and lifetime rules

A submission promise resolves only after **all final uses it covers** are really
submitted. It rejects only after their encoder has been discarded or the device
is lost. It must settle on partial recording errors too. Post then waits for
queue completion asynchronously before releasing publication pins, image copies
and pool leases, whether submission succeeds or fails. A rejected final ticket
does not cancel automatic prefix submissions.
No recording method blocks for GPU idle or privately submits.

Commit and `presentLast` require their own final-use submission tickets. The
last image outlives the scene's input pins and retires only after all its queued
presentations complete. Reset/disposal stop new admission immediately; queued
inputs survive their fences. A history resize waits for older admitted uses
rather than resizing Three's targets under queued commands.

A native exception *after acceptance begins* cannot roll back already submitted
Three/Frame work. The scene is failed, its pins remain fenced, and temporal
history is invalidated before reuse. Feedback rejection occurs before that
boundary and leaves committed temporal state untouched.

## Remaining work

The application must supply an immutable Source cut and a real complete
Source/Fields/Sun/GI/glow publication, record feedback, settle submission tickets,
wire fragment-accurate mesh lighting/hands, pack opaque meshes, implement WORLD
Plain and non-main consumers, and select the new path. Cold-history proof,
guarded GPU numerical/visual checks, affordability and deployment remain outside
this phase.
