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
- Completion notifications wake the loop without refilling temporal settling.
  WORLD allows the original 32 GI settling advances; BOX keeps its existing count.
- App supplies an initial CELL demand at the nearest valid brick to the eye.
  An outside-world eye does not imply empty world data.
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
- Frozen camera clones carry the original camera identity into Post.
  A new clone alone does not reset TAA history.
- Pending work presents only exact `post.presentLast` with a real final ticket,
  or explicit loading when no accepted image exists. No Far/local union fallback.
- WORLD startup keeps physics and local raw picks ready. It does not compile
  unused BOX volume views, local shadows, block views, or local GI. Native WORLD
  preflight still waits for every pipeline it actually draws.
- WORLD enables all selected detail defines. Camera distance from the physics
  box does not select a cheaper variant. Original shader feature fades remain.
- The loading screen waits for a confirmed MAIN publication in WORLD, even
  after the old startup timeout. A timer cannot turn missing data into readiness.

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

WORLD pointer/requestPick and visible pickRay/pickScreenRay now use native global
picks against `driver.displayedMainFrame = {data, view, frameIdentity}` retained on
confirmed main-image acceptance. `pickRay(..., false)` remains local physics;
BOX picking is unchanged. WORLD view-menu thumbnails now enqueue concrete
`driver.queueStill({view,target})` jobs (`requestStill` is the same API). The UI
owns a childless camera at 320×200 aspect and one RGBA8 target per job through
readback. Initial loading without an accepted main image returns not-ready;
there is never a local-volume fallback.

The existing single transaction slot chooses stills only between MAIN requests.
After one STILL, normal/pick-demand work gets a scheduling opportunity before
another STILL. Stills do not reserve or refill pacer counters. They request an
accepted-compatible `advance:false` source frame with an explicit eye CELL seed;
scene misses extend that same cut/view monotonically. Actual actors are selected
only in the synchronous normal-tick scene attempt after preparation. Shared native
mesh preflight, opaque HDR/depth pack, full volume, transparent meshes and whole
final feedback remain mandatory. Flat presentation and captured view/post style
are scoped synchronously; stills skip hands/eye sampling, signs and MAIN gizmos.
Only confirmed Post final submission permits source-history acceptance and UI
readback. STILL acceptance never replaces `accepted` or `displayedMainFrame`,
advances TAA/view clocks/VM/DOM, or satisfies MAIN frame/screenshot waiters.
Dispose rejects queued jobs and drains active preparation, compilation and native
prefix uses before returning their targets. Unknown open final suffixes remain
blocked, not falsely clean. The existing MAIN screenshot capture is unchanged.

`driver.pick({ray,skipLiquids})` freezes global ray/warp/slot before compilation,
records actual WorldVolume into the normal Frame, and reads whole typed feedback
plus all 32 output bytes through the real final provider. Pins survive both
submission outcomes and queue completion. Hits carry global cells/publication /
displayed identity; incomplete and obsolete return explicit `ready:false` codes.
Raw picks must not request Sun. Unknown feedback never means empty space.

Missing requirements coalesce in `queuePickDemand(feedback,display)` for the NEXT
initial main request, never an inactive accepted candidate or a different active
cut. Demand forces a view even with a quiet pacer; compatible camera/dependency
births use the existing advance:false capture path. No further query dispatch
occurs against an incomplete displayed identity. App retries after acceptance,
discards stale pointer/tool/effect/scene/display results, and exposes global
visual hover separately from its explicitly converted current-local cell.
Physical mutation guards recheck current origin/window and reject outside hits
without clamping them into edge cells. Driver disposal drains query uses before
retiring the owner/Atlas.

The App tool-ray adapter keeps its existing local-cell return ABI and also
returns `globalCell`. Native driver results and visual hover remain global.
Delayed erase/touch actions revalidate the global cell against the current
origin, tool and displayed frame before mutation.

`npm run check:world-pick` exercises actual WorldVolume and normal GpuFrame/final
provider with explicit mocked compute output words (not native math/GPU proof).

CPU evidence executes the actual driver, actual Source/data owner and actual
Post admission with explicitly mocked native math/scenegraph encoding. It also
checks delayed/rejected mesh compilation, Post transfer failures/backpressure,
frozen view overrides and actual App hook selection. It is NOT GPU, visual,
full actor-scene rendering, performance, or other-consumer proof. Asset prewarms
outside the guarded scene, resize/dispose stress across every native allocation
site, and real native layout/readiness remain review/GPU risks. No deployment or
global activation claim follows from this local integration.

The CPU regressions also cover bootstrap, settling to idle, stable-camera TAA,
and cleanup at each of the 15 initialization failure sites tested.

Run `npm run check:world-still` for serialized still births, target ownership,
MAIN isolation, lifecycle failures, actual shared scene recording and executable
App thumbnail-hook tests (explicit native math/scenegraph transport mocks).
Run `npm run check:world-main-route` for CPU tests; `check:world-render-frame`
retains native-value/feedback/final-admission tests. No browser/server is needed.
