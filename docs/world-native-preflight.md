# Native mesh preflight completion (Three r186)

`src/gpu/three.js:trackNativeRenderPipelines` installs **renderer-instance-only**
interop after renderer initialization. It records the backend's original native
creation completion per real `RenderObjectPipeline`. Every asynchronous
`Pipelines.getForRender` enrolls that same completion, including program/pipeline
cache hits and unchanged RenderObjects. After settlement, certification requires
an actual `backend.get(pipeline).pipeline` handle and no backend validation error.
This closes r186's cache-hit early resolution and swallowed-native-error paths.
When Three discarded the native error, the rejection describes the missing or
invalid native handle and points at Three/WebGPU diagnostics; it does not invent
an original cause. No new device error scopes, prototype/global monkeypatches,
dependency edits, renderer abstraction or synchronous draw changes are involved.

`prepareMesh` retains default warn/resolve semantics and certifies `preparedWith`
only on success. Guards retain one pending record/promise. Any `onPending`
subscriber upgrades that record to strict failure policy, even if BOX initiated
it. Failed strict records stay parked, remain observable by the same promise,
and do not recompile/reallocate on repeated checks. Default-only guards still
restore layers and invoke `onReady` after warning. WORLD's existing preflight
retirement waits this compilation fence and then context queue retirement; a
cache hit cannot release the publication early on detach.

Run `npm run check:world-native-preflight`: CPU tests execute the actual installed
Three `Pipelines`, `WebGPUBackend.createRenderPipeline`, and
`WebGPUPipelineUtils.createRenderPipeline`, with a stub native device and minimal
RenderObject/traversal fixtures. Tests reproduce the unbridged bug, check
concurrent cache-hit fences, swallowed native rejection, actual handle success,
validation-error rejection, default-to-strict upgrades, repeat identity and
compile/queue detach fences. This is production interop logic proof, **not** GPU,
visual, device validation, performance or full application rendering evidence.

`check:world-main-route` separately executes actual frame preflight/retirement,
Post/owner/driver seams. It imports frame/owner test modules, so their registered
CPU tests are included in its reported union (21 at this checkpoint); that count
is not 21 isolated main-route tests. `check:world-mesh-light` retains the BOX WGSL
byte hash, actual BOX→WORLD→BOX node graph / buffer identity coverage and CPU Naga
validation. Allocation-prefix and boot/pacing fixes in App/worldRenderFrame belong
to the parent and are intentionally outside this patch.
