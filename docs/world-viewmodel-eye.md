# WORLD one-eye viewmodel consumer

Implemented consumer seam only; App/readback/scene routing is **not wired**.
This is the original eye LightProbe + directional key light for hands, not
WORLD per-fragment figure lighting. No GPU/visual proof is claimed.
BOX's four-argument call is unchanged (local async reads, hemisphere fallback,
scalar Sun, original easing, native targets, partial-mesh guard semantics).

## Explicit fifth argument

```js
const hands = renderViewmodels(renderer, scene, capturedCamera, post, {
  worldLighting: {
    publication: candidate.publication, // exact object identity, not live Atlas
    position: [globalX, globalY, globalZ],
    frame: {
      identity: frozenFrameToken,      // exact same token in decoded sample
      scene: frozenSceneToken,
      epoch, domain: 'world',
      order,                          // safe integer, globally increasing per consumer
      time,                           // finite monotonic seconds, frozen frame time
      sunDirection: [sx, sy, sz],
      sunColor: [r, g, b],             // frozen uSunCol
      keyLight: [kr, kg, kb],          // frozen uKeyLight, from SAME frame/cut
      settings: {exposure, raw},      // optional defaults 0/false, NOT live Post
    },
    sample: {
      identity: decodedSampleToken,    // stable unique readback identity
      publication: candidate.publication,
      frameIdentity: frozenFrameToken,
      position: [globalX, globalY, globalZ],
      words, // exactly 20 decoded finite floats: c0,cx,cy,cz,SunRGB,+1
    },
  },
});
```

Identity tokens are opaque, compared by reference/value; preserve their identity
and do not mutate/reconstruct publications. The caller pairs position and frame
metadata under the native candidate pin. It must associate the sample with the
frozen frame used to record that point, not manufacture metadata from latest App.
All numerical arrays and exposure/raw settings are copied synchronously on entry.
Frame/scene/epoch/domain/sample tokens must be non-null; Sun direction nonzero.
Malformed values, incomplete w (including untouched zero), metadata mismatch or
stale order/time return `{ready:false, code:'WORLD_EYE_INCOMPLETE', reason}` before
any hand draw. Explicit `{worldLighting:null}` is WORLD/not-ready, never BOX.
Whole scene feedback completeness remains the caller's admission responsibility.

## Result and transaction

Success is `{ready:true, viewmodel, glow, lighting, images}`. Images can be null
when no viewmodel is visible. `lighting` is a frozen ticket:

- `frame`: owned frozen capture, including all 20 original sample words.
- `bands`: 16 tentative SH words, including all four alpha words.
- `sunRGB`: three tentative transmission components.
- `sunColor`: frozen Sun color * frozen key light * eased transmission, once.
- `status`: `staged`, `committed`, or `discarded`.
- `canCommit()`: no side effects; baseline still accepted and order newer.
- `commit()`: returns boolean; adopts easing only if `canCommit()` is true.
- `discard()`: invalidates an uncommitted ticket without changing accepted light.

The original Three mapping is bands 0=c0.rgb, 1=cy.rgb, 2=cz.rgb, 3=cx.rgb.
Easing uses the original 0.3 second tau and dt capped at one second, measured
from the last **accepted** frame. First sample or epoch/domain change initializes
directly. Origin shifts, residency/publication generation and scene identity do
not reset known light. A rejected new epoch does not change the accepted epoch.
A commit invalidates every concurrently staged baseline: restage, do not commit
old tentative light after another frame. Older order/time cannot draw or commit.
The owner must serialize Post admission/final confirmation: `canCommit()` is a
check, not a reservation, and `commit()` is deliberately not called before Post.

`images` is candidate-owned metadata `{identity, copyBeforeNextDraw:true,
isCurrent()}`. The actual targets are the existing reusable native VM targets,
**not owned persistent copies**. Copy them into staged Post immediately, before
another WORLD/BOX draw or resize. `isCurrent()` is a synchronous validity check
for copying, not a GPU completion fence. Do not retain the shared textures as
accepted images; Post already copies/pins viewmodel/glow per scene ticket.
Cache reuse requires native frame, scene, camera pose/lens, frozen frame/sample/
publication identities and all captured values. Cache reuse never reanimates a
discarded ticket. Different requests in one native frame draw independently.

If any intended visible hand/glow mesh is waiting for `guardMeshes`, WORLD
returns not-ready without rendering either target. The existing guard schedules
compilation and requestRender; it owns the temporary pending layers and restores
them on readiness. Visibility/frustum changes are restored by real prepareMesh,
and the temporary glow camera layer is restored on return/failure. BOX retains
its existing partial-image behavior. Existing material/model/glow rendering is
unchanged; the scene owner must supply the frozen rig/model pose and manage
existing material animation/time through its frame hooks, not latest App state.

## Concrete parent App integration (not implemented here)

1. Capture the scene/camera/eye/Sun/key color/settings/time from one Source cut.
   Allocate monotonic consumer order. Keep the exact publication and frame tokens.
2. Under that native candidate pin, record the existing 80-byte point endpoint at
   the exact global eye position. Await the caller's real readback outside open
   passes; decode it to 20 floats and retain paired metadata. No local readProbe,
   shadow texture read, hemisphere, outside substitute or extra cloud/tint factor.
3. Call this fifth-argument seam with the captured camera/rig. On not-ready retain
   Post's last accepted frame or explicit loading; retry after readiness. Do not
   call the four-argument BOX path as a WORLD fallback.
4. Check `hands.images.isCurrent()` then immediately call staged
   `post.recordScene(..., {viewmodel:hands.viewmodel, glow:hands.glow, ...})`, whose
   copy happens synchronously after hooks. Do not redraw VM inside those hooks.
   Pass matching frozen presentation/image settings to Post's existing capture.
5. Before `post.commitScene` (before TAA), check `hands.lighting.canCommit()` and
   complete entire candidate feedback/submission prerequisites. If false, discard
   scene + lighting and restage from the current accepted baseline.
6. Only final successful Post `onCommit` calls `hands.lighting.commit()`; assert
   its return. Serialize admissions until confirmation. All failure/discard,
   stale, incomplete, resize/reset and final-submit rejection paths must call
   `discard()`. Retain native candidate/output/publication pins through final
   submitted use and queue completion independently of the lighting ticket.

`npm run check:world-viewmodel-eye` executes actual pure staging/application and
an in-memory import of the actual viewmodel pass with real Three objects and
real guardMeshes/prepareMesh. Renderer/browser/model edges are fake; no browser,
GPU, App route, performance or visual acceptance is asserted.
