# WORLD Plain shader checkpoint

This is shader support, **not application activation or renderer completion**.
BOX still uses its existing block mesher, face pool, draws and picker.

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
facade must explicitly cache/select this picker; its existing cache is unchanged.

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
optical attenuation, order-free composition, 18 global raw picks, and flat/curved
traces through covered HDR meshes, raw opaque cells and unknown dependencies.
A colored-glass/nonuniform HDR-destination numerical control (also illustrating
the hypothetical colored-SKY case) proves why a scalar-over replacement is
insufficient for the existing opaque HDR scene. Unknown AO feedback is observable in trace tests.

The interpreter adapter corrects documented package issues (private bool
layouts, short-circuit logic, half RNE, integer vectors/texture loads and void
call scopes) without rewriting emitted WGSL. Its bool/short-circuit behavior has
a control test. Leaf raw/Sun inputs and test camera are mocks, not GPU execution
or an independent whole-renderer numerical reference.

The focused existing 136-BOX-hash check also passes, as do static imports,
sampler budgets and the build. The unrelated 132-WORLD-module suite was not
repeated. Driver compilation, visuals, performance, facade prewarm/record/picker
selection and App activation with the existing Post background semantics remain
parent integration work.
No `worldVolume`, Post, gpuThree or App files were changed.
