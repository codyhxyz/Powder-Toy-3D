# WORLD frame recording checkpoint (inactive, incomplete)

`src/wire/worldRenderFrame.js` contains concrete native frame functions. They
are **not selected by App**. This checkpoint does not finish the WORLD renderer
or change BOX. Do not activate merely because CPU tests/build pass.

## Implemented functions

- `createWorldFrameState(app,data,noise)` requires an already loaded actual
  `win.render` data owner and awaits real Post/noise readiness. Allocates a real
  stable 1x1 query-layout packed texture and actual opaque recorder. It is never
  scene geometry. No Far grid is borrowed.
- `prewarmWorldFrame(app,state,candidate,{view,detail,curved})` constructs actual
  WorldVolume using the cut's artwork/grid and native table **buffer** (not its
  TABLES group). Awaits actual view/all Plain phases, point/sign/opaque/Post
  pipelines. Native material guard also gates scene recording before passes.
- `probeWorldFrameEye(app,state,candidate)` dispatches the real 80-byte reader at
  the frozen global eye and reads its entire feedback plus point output through
  the existing normal-Frame feedback provider. Returns exact native publication
  metadata, 20 floats and decoded feedback. Output/native/cut pins wait both
  decode and final submission/queue completion, including blocked suffixes.
- `recordWorldFrame(app,state,candidate,options)` requires captured camera,
  view/detail/curved, exact frame identity, monotonic VM order, complete native
  eye and optional real sign request. Calls actual viewmodels with explicit
  WORLD lighting, then synchronous staged Post hooks: actual Three opaque,
  actual HDR/depth/coverage packing, WorldVolume, after wires, transparent,
  overlays. Requires real `app.threeMeshes`, `drawWorldAfter`,
  `drawWorldOverlay`; these are **not yet exposed by App**. No fake callbacks or
  fallback implementation is installed. Returns null on VM/Post backpressure.
- `finishWorldFrame(app,state,recorded,eyeFeedback)` reads scene/sign feedback;
  rejects entire misses before TAA; checks sign generation and VM baseline;
  commits actual Post with another normal final ticket; awaits real data
  acceptance of that confirmed Post; then commits VM smoothing and sign DOM.
  All other outcomes discard VM/Post. Inputs stay pinned through final uses.
- `disposeWorldFrame(state)` stops new recording and waits registered native
  uses before destroying the stable query binding. Unknown recordable suffixes
  deliberately keep disposal pending, not falsely settled.

Candidate caller handles remain caller-owned. Scene/query native handles are
independent, with distinct publication references. The real data candidate must
provide `tables.buffer`, `sunTextures`, `appearance`, `snapshot`, `lighting`,
`frame` and `retain`; Parent's immutable-table/native-Sun seam supplies those.
`worldSceneValues` replaces only camera/projection/jitter under actual Post
capture, preserving frozen numerical settings/time. `worldSceneParams` derives
inverse(VP*globalModel), actual input size and actual packed scene binding.

## Required before App activation

1. Connect real loaded Source/Producer/native readiness and `installWorldRender`
   in world wire. Do not construct another callback data owner.
2. Connect the main-loop branch and actual mesh/after/overlay functions; suppress
   Far/detail/haze/local-volume union entirely while building and use exact
   `post.presentLast` (normal final ticket) or explicit loading.
3. Implement frozen camera, Post/presentation settings and actor/VM pose capture
   and restore. Existing functions require these and do not capture mutable App.
4. Preserve original derived/GI settling scheduling and GI_SETTLE age contract;
   hold/coalesce next physics/camera while resolving request -> typed misses ->
   same-cut extend. Camera-only births use advance:false and unchanged key/cut.
5. Dispose/scene/schema obsolescence must settle or block known final suffixes,
   discard VM, invalidate sign requests and release caller candidate handles.
6. World pick/edit/local physics, still/thumbnail and query ownership are Parent
   followups; explicitly gate unsupported consumers, not local visual fallback.
7. Validate actual recording (including partial allocation/recording failures),
   continuous scheduling, resize/disposal and frozen rig integration. Current
   tests do not execute the full App or full native recording functions.

## Evidence

`npm run check:world-render-frame`: four CPU tests call actual new frame value,
feedback and final-admission functions. Admission uses actual Post and existing
normal feedback provider with fake native execution; owner acceptance and scene
native feedback decoding are explicitly synthetic. Tests demonstrate scene,
point and sign misses do not invoke TAA; actual final Post confirmation precedes
owner/VM commit. No whole-App, GPU, visual or performance evidence is claimed.
