# WORLD Plain shader checkpoint

This is shader and explicit native facade support, **not application activation
or renderer completion**. BOX still uses its existing block mesher, face pool,
draws and picker.

## Phase API

`volumeFrag(g, { backend: 'world', view: 'plain', curved })` emits one module
with `vs`, `fsOpaque`, `fsAbsorb`, and `fsScatter`. There is deliberately no
single-over `fs` entry for WORLD Plain. Do not use `volumePipeline()` for it.
Use `VOLUME_LAYOUTS({ backend: 'world' })` and
`worldPlainPipelines({ curved })` from `shaders/render.js`. The exported
`WORLD_PLAIN_PHASES` specifies the required recording order:

| Phase | Entry | Color blend | Alpha blend | Depth write |
| --- | --- | --- | --- | --- |
| opaque | fsOpaque | replace | replace | yes |
| absorb | fsAbsorb | zero / src | one / one-minus-src-alpha | no |
| scatter | fsScatter | one / one | zero / one | no |

All depth compares are `less-equal`. The blend operation defaults to `add`,
exactly as in the original BOX block descriptors. Flat draws use the existing
14-vertex box strip; curved draws use the existing 3-vertex full-screen triangle.
Prewarm all three pipelines before authorizing readiness. Record all three
against the same native HDR/depth target, immutable WORLD publication, camera,
packed opaque capture and parameters; do not repack between phases. Preserve
the existing whole-candidate feedback gate across **all** recorded work.

`pickFrag(g, { backend: 'world', view: 'plain' })` builds the raw-face picker.
Use `PICK_LAYOUTS({ backend: 'world' })` and the existing `PickParams` ABI.
The 32-byte result remains `(cell.xyz, face)` and `(id, T, pressure, life)`.
Face codes retain the original minus-step convention, including exits viewed
from inside transparent cells. A miss is `face=-1`; an incomplete query is
`face=-2`. Curvature uses the existing per-ray fields. The parent's WORLD
facade caches/selects this picker separately; omitted `view` still selects the
existing realistic picker.

## Appearance and traversal

`blockPlainShared.js` exports production block class/visibility rules, corner
AO, 8-bit seed tint, ctype spark/lamp bits, half-packed temperature/life,
thermal emission, Minecraft face shade, gas rim/noise and translucent look.
BOX interpolates these fragments without changing any generated shader bytes.
WORLD uses the same math with full RGB attenuation from four fixed-world optical
SunBook taps. Original Plain adds no cloud shadow, caustic, GI or glow-volume
multiplier. It ignores source artwork as the original block view does; source
capability and curved variants still compile with the existing resource layout.

Render phases and picking share raw cell walks built on the physical WORLD DDA
and quadratic presentation helpers. They cross pages without restarting material
state. Coordinates are global integers, not 10-bit face-pool positions. Actual
exterior cells are air; the physical lower boundary retains opaque bedrock AO.
There is no synthetic WORLD floor quad, matching `floor: !win`. Missing raw
neighbors (including AO), optical dependencies or invalid query headers reject
the whole candidate; placeholder values cannot authorize a frame or pick.

## Opaque capture, transparent faces and SKY

Pack the actual opaque scene HDR/depth/coverage before these passes and enable
`VolumeParams.meshCut`. Only covered opaque fragments stop a ray. Uncovered
packed color/depth never invents a mesh. Opaque emits only a nearer raw opaque
face, never re-emits the packed native mesh: native HDR/depth/coverage otherwise
stay untouched. Transparent phases stop at the nearer raw/native opaque surface,
never write depth, and transparent-only rays keep depth 1.

Both visible sides of transparent cells and both faces at eligible class
interfaces contribute to the original order-free target operations:

`destination.rgb = destination.rgb * product(face.tr) + sum(face.scatter)`

`destination.a = (1 - product(1 - face.coverage)) + product(1 - face.coverage) * destination.a`

A single premultiplied RGBA blend cannot encode independent RGB attenuation of
the existing nonuniform HDR mesh/opaque destination. The three phases preserve
the actual original BOX operations on that target, with its original coverage.
The original Post then tone-maps and composites the CSS/sRGB page-gradient SKY
using scalar uncovered coverage; that SKY is **not** an HDR scene backplate.
Its inherited scalar-coverage limitation remains intentionally unchanged in
WORLD. No physically colored CSS-sky attenuation, inverse tone mapping, SKY
sampling, fake sky opacity, sorted-over, fog, cutoff or realistic liquid shader
is introduced. Parent App should retain the original Post background stage.

## Checked evidence and remaining integration

`npm run check:world-plain` runs CPU interpretation and Naga only. It checks nine
original BOX block hashes; 12 actual WORLD modules spanning both heights,
presentations and source-capability flags; all three actual phase entries and
original BOX blend/depth descriptors; executed shared shading/AO/metadata,
optical attenuation, order-free composition, 22 global raw picks, and flat/curved
traces through covered HDR meshes, raw opaque cells and unknown dependencies.
WORLD starts a flat cell walk with exact boundary-time ownership, not BOX's
legacy positional nudge. Both-sign picks within 0.00005 cells of 4/32 boundaries
must still see the approaching opaque face.
A colored-glass/nonuniform HDR-destination numerical control (also illustrating
the hypothetical colored-SKY case) proves why a scalar-over replacement is
insufficient for the existing opaque HDR scene. Unknown AO feedback is observable in trace tests.

The interpreter adapter corrects documented package issues (private bool
layouts, short-circuit logic, half RNE, integer vectors/texture loads and void
call scopes) without rewriting emitted WGSL. Its bool/short-circuit behavior has
a control test. Leaf raw/Sun inputs and test camera are mocks, not GPU execution
or an independent whole-renderer numerical reference.

## Explicit native facade (not App activation)

`createWorldVolume(...).pipelineState('plain', detail, curved)` starts all three
actual pipelines. Its aggregate `state` is `pending`, `failed` if any compilation
fails, or `ready` only when all three **and the explicit Plain picker** are ready.
`ready` / `viewReady('plain', detail, curved)` resolves to the ordered three
pipelines; `pipelines` and `error` expose synchronous inspection. Other views
retain their existing single-pipeline API. `plainPickState` and
`pickPipelineState(view)` expose the separate picker; `ready` on the facade
itself retains its existing default-realistic-pick meaning.

Await `viewReady` **before opening the scene pass**, then call
`candidate.recordDraw(pass, {view:'plain', curved})` synchronously. A pending or
failed aggregate returns `false` without touching the pass. A ready draw records
OPAQUE -> ABSORB -> SCATTER on that same caller-owned native pass, binding the
same immutable groups for every phase (14 vertices each flat, 3 each curved).
There is no async pass callback, hidden scene pass, repack, source change or
queue submission. The legacy async `draw` convenience freezes options before
awaiting, but must not be used as an async render-pass callback.

`recordPickReady(frame, {view:'plain', params, output})` selects the raw picker;
`recordPick` freezes view, output identity, n, slots and all packed bytes before
its first await. Both retain the existing 32-byte result and shared feedback
protocol. The candidate owns its params/feedback and transferred/default
snapshot; the caller pins all borrowed publications and outputs until the last
submitted use completes, including rejected candidates. See
[world-point.md](world-point.md) for the native point consumer of that same
publication and feedback.

`npm run check:world-volume-consumers` adds actual fake-native descriptors,
aggregate readiness/failure, exact blend/depth/order, immutable async view/pick/
point inputs, output lifetimes, executed point output ABI and actual emitted
Naga/resource-count checks. CPU evidence is not driver compilation, visuals,
performance or App activation. App's opaque capture/Post wiring and final
submission/queue pins remain parent integration work; Post, gpuThree, native
mesh lighting and App are unchanged by this facade lane.
