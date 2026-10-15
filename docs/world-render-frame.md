# WORLD App main route — local integration, not release approval

App now selects the WORLD transaction driver in its existing presentation branch.
`world.prepareRender` installs the actual Source/Producer data owner after load,
awaits immutable media noise/Post/native readiness, and stores `win.renderFrame`
(the frozen `win.render` remains the data API). BOX retains its original branch.

## Boundaries

- Physics, actor `afterStep`, and pacer due/present remain in the normal tick.
  The driver reserves derived/view settling once per pending transaction.
  Ordinary newer physics/camera state coalesces implicitly in App; it cannot
  replace the pending cut or frozen view. Promise completions only store/wake.
- `freezeWorldView` captures global model/camera/projection/view style and Post /
  presentation settings before the native eye query. Source time, artwork,
  lighting and captured physics origin remain publication-owned.
- Actual scene encoding runs only from the normal tick, after actor updates.
  The then-current scene is encoded synchronously: mesh preflight, VM, opaque
  Three, actual HDR/depth/coverage packing, full WorldVolume, after wires,
  transparent meshes, overlays and final sign/feedback boundary. No pose clones,
  skeleton snapshots, yields or per-object SH are introduced.
- Native graph preflight owns query-layout bindings while tracked compilation
  promises settle. `guardMeshes.onPending` exposes the same compilation on
  repeated checks; strict failures remain parked/fail closed. Retirement waits
  compilation and final queue completion. Default BOX preparation behavior is
  preserved.
- Complete eye + scene + signs precede TAA. Misses extend the SAME active cut
  and view, with current actors chosen on the next attempt. Only confirmed Post
  acceptance advances owner history, VM/sign UI and App screenshot/frame waiters.
  `advance:false` camera births use accepted-compatible source settings, not
  direct inactive `current()` admission. World GI age/phase policy stays in the
  existing history owner, independent of Fields age and view/origin changes.
- Pending work presents only exact `post.presentLast` with a real final ticket,
  or explicit loading when no accepted image exists. No Far/local union fallback.

## Ownership and seams

`probeWorldFrameEye(app,state,data,frozenView)` and `recordWorldFrame` share the
same frozen view. Scene geometry binds only the actual Post target's packed
opaque texture. The stable 1x1 query pack is LAYOUT ONLY. Absent artwork has an
explicit empty binding; each cut's real artwork overrides it, including null.
Native table buffer, Sun textures and appearance are borrowed under candidate
pins. Data/eye/scene publications intentionally have different reference identities.

App exposes actual `threeMeshes`, `prepareWorldAfter`, `drawWorldAfter`, and
`drawWorldOverlay`. Existing local sprites/cursors keep their coordinate ABI:
App derives their local transform from the frozen global model and the current
scene origin; source lamp/wand conversions use the separately captured source
origin. Scoped view/settings overrides restore synchronously after encoding.

Post's additive synchronous `onPublicationTransferred` notification separates
null/early failure (caller still owns) from registered-ticket failure (Post owns
and retires through real final/queue fences). The frame helper also closes
partial native/sign allocation prefixes before deferred cleanup. Unknown open
suffix failure deliberately does not falsely settle.

## Explicit limitations — DO NOT SHIP YET

WORLD pickRay rejects with `WORLD_CONSUMER_NOT_READY`, pointer visual picking is
parked, and legacy thumbnail/still rendering returns not-ready. Parent owns
those native consumer followups. BOX picking/thumbnails are unchanged.

CPU evidence executes the actual driver, actual Source/data owner and actual
Post admission with explicitly mocked native math/scenegraph encoding. It also
checks delayed/rejected mesh compilation, Post transfer failures/backpressure,
frozen view overrides and actual App hook selection. It is NOT GPU, visual,
full actor-scene rendering, performance, or other-consumer proof. Asset prewarms
outside the guarded scene, resize/dispose stress across every native allocation
site, and real native layout/readiness remain review/GPU risks. No deployment or
global activation claim follows from this local integration.

Run `npm run check:world-main-route` for CPU tests; `check:world-render-frame`
retains native-value/feedback/final-admission tests. No browser/server is needed.
