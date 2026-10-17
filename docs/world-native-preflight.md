# Native mesh preflight completion (Three r186)

`src/gpu/three.js:trackNativeRenderPipelines` installs **renderer-instance-only**
interop after renderer initialization. It records the backend's original native
creation completion per real `RenderObjectPipeline`. For synchronous draw-created
pipelines it also captures completion of Three's **existing** `popErrorScope`
validation promise: a temporary forwarding Proxy replaces only `backend.device`
during that synchronous call, binding native methods/getters to the same real
device. `try/finally` restores the backend device before returning or throwing.
No await occurs while the facade is installed; no native device/prototype/global
is modified, and no scopes are added or reordered. Completion handlers are enrolled
only after the original call returns, after Three registers its validation handler.
The asynchronous branch retains its original native creation/diagnostics promise
and never installs a facade.

Every asynchronous `Pipelines.getForRender` enrolls that same completion, including
sync-created program/pipeline cache hits and unchanged RenderObjects. Untracked
entries fail closed even if a native handle exists. After settlement, certification
requires an actual `backend.get(pipeline).pipeline` handle and no backend validation
error.
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
compile/queue detach fences. Delayed synchronous validation tests additionally
check healthy cached-unlit reuse without recompilation, strict failure parking,
default warning/resolve behavior, shared completion identity, device restoration
on success/throw, native receiver/getter binding, unchanged native object identity,
exact existing scope order, synchronous draw return, and untracked-handle rejection.
This is production interop logic proof, **not** GPU, visual, device validation,
performance or full application rendering evidence.

`check:world-main-route` separately executes actual frame preflight/retirement,
Post/owner/driver seams. It imports frame/owner test modules, so their registered
CPU tests are included in its reported union (40 at this checkpoint); that count
is not 40 isolated main-route tests. `check:world-mesh-light` retains the BOX WGSL
byte hash, actual BOX→WORLD→BOX node graph / buffer identity coverage and CPU Naga
validation. Allocation-prefix and boot/pacing fixes in App/worldRenderFrame belong
to the parent and are intentionally outside this patch.
