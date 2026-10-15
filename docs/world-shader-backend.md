# Shared world shader backend — PHASE3b-1

This is a **disabled assembly**, not an application switch or a completed world
renderer. No second reduced shader library, whole-world Simulation, lighting
producer, scheduler, fog/quality/distance cutoff, or frame cap is introduced.
Source/Field providers and full-world lighting/publication/application wiring
remain required. Do not deploy this checkpoint as the requested complete fix.

## Shared code and addressing

`volumeFrag`, `pickFrag`, `lib`, `libLayouts`, `coreGLSL`, `ddaGLSL`,
`VOLUME_LAYOUTS` and `PICK_LAYOUTS` take an explicit default `backend: 'box'`.
Existing exported string providers remain Box wrappers. World leaf providers
replace state, fields, aux, occupancy, probes/glow, sun, appearance and mesh
transport below the existing surface/material/tracer bodies. The shared
`shadowOpticsWGSL` body is used by the Box sun writer and the world tangent
fallback; it is not a second reduced optical tracer.

World `g` is metadata, e.g. `{nx:3072,ny:384,nz:1024}`. The walk budget ignores
local `g.maxSteps`: `nx+ny+nz+8`. Material/root/AA/reflection/bend budgets remain
shared. Pages and construction cores do not terminate/restart rays, media,
interfaces, TIR, bends or first-depth tracking. Only genuine world bounds
invoke exterior rules. World compilation omits the local underwater edge fade
and homogeneous water tail, far casters and coarse beacon visibility.

Virtual keys are `bx + BX*(by + BY*bz)` with a matching inverse, never physical
page IDs or the local supertile key. Occupancy uses conservative all-candidate
masks and **exact raw IDs**, avoiding conflation of occupancy `x+4y+16z` with
source raw slot order. Brick classification/distance still come from published
aux metadata. Integrated brick classification requires RAW|FIELD|AUX before
skipping; producers must publish correct field-support flags and conservative
empty-space distances. Unknown/unready pages remain incomplete even if a
placeholder temporarily takes an empty/sky branch.

### Dedicated layout

| group | bindings |
|---|---|
| 0 | Tables0, zero-origin Header1, world FrameUniforms2, WA3, geometry Book4 |
| 1 | A0, B1, surface2, media3, thin4, aux5 |
| 2 | GI0..3, glow4, sun1 depth5, sun0 optical6, noise7, appearance8, packed opaque mesh9 |
| 3 | operation params0, requests1, linearClamp2, linearRepeat3, WorldSunParams4, SunBook5, pick output6 only for picks |

Exactly 16 sampled textures; four storage buffers (five for picks); four
bind groups. Book bindings are 24/72 MiB at height128/384. Standalone Atlas
reader/writer layouts retain their existing defaults. Integrated declarations
use the dedicated map, not emitted-WGSL regex rewriting or appended Box slots.

## Sun reader/writer ABI (finalized here)

`src/world/worldSun.js` owns host layout, pole-safe basis, full-world caster
projection, fixed pitch, signed tile/slot addressing and CPU diagnostics.
`src/shaders/gfx/worldSun.js` exposes `worldSunProject`, `worldSunTap` and
`worldSunDepthTap`. Phase4 writers must use this same projection/publication ABI.

External textures: **sun0 rgba32float 2D array** holds the original optical
payload `(opaque depth, translucent start, translucent end, tint ID*256+tau)`;
**sun1 r32float 2D array** holds sun0.x. Both are unfilterable loads. Physical
extent is 2048² per layer, 8×8 virtual tiles of 256² per layer, 64 tiles/layer.
Physical pitch is **0.416531224 world cells**, independent of world dimensions.

`WorldSunParams` is exactly 128 bytes:

| offset | field/type | meaning |
|---|---|---|
| 0 | worldToLight mat4x4f | world → light texel XY / physical depth |
| 64 | depth vec4f | depthHi, depthLo, pitch, inversePitch |
| 80 | tiles vec4i | minTileX, minTileY, countX, countY |
| 96 | physical vec4u | 256, 8, 64, physicalLayers |
| 112 | version vec4u | epoch, basisRevision, publishRevision, requestWordOffset |

Depth increases away from the sun: `depthHi-dot(world,sun)`. Texel i's centre
is i+.5. Coverage is the entire world-caster projection, not the camera or
physics window; outside this rectangle is legitimately clear. Signed floor
and nonnegative local remainder resolve negative virtual coordinates.

`SunBook` is **separate immutable storage**, 8 u32 words per virtual tile:
physicalSlot, epoch, basisRevision, publishRevision, dependencySetID,
dependencyVersion, flags, reserved. flags bit0 means valid; zero is unknown.
Dependency provenance is the writer's closure assertion, not a geometry page
ID. Epoch/basis/publication/validity/slot mismatches request the virtual tile
and latch the shared incomplete flag. Texture dimensions/layers, epoch,
publication, pitch and physical geometry are checked too. Never publish an
absent/unbuilt map as clear; unbuilt lighting can bind real resources with an
invalid publication and will invalidate the candidate.

Receiver-plane depth uses the **actual quantized texel centre** for hard,
blocker-search and PCSS filter taps, including across virtual tile boundaries.
No n.dot(sun) floor or slope-sized constant bias is used for the world reader.
The original optical decoding, caustics, Vogel weights and SH/glow/AO/material
lighting bodies remain shared; the world reader retains rotation/PCSS structure. Tangent cases trace the
full world with `shadowOpticsWGSL` in the producer's light→receiver orientation,
including glass/crystal/liquid/media payload math. Secondary helpers restore
crystal/thin private context but **never** restore/reset the incomplete latch.

The standalone Atlas's historical two-r32float copy helper is NOT this full
sun writer. Phase4 must build full optical producers, dirty-tile dependency
closure and independent immutable SunBook publications, not use that copy seam
as a substitute. GI producer `farBeyond` removal also belongs to Phase4 and is
not claimed here.

## Assembly and caller protocol

`createWorldVolume(gpu,{g,atlas,tables,lighting,appearance})` uses actual native
async render/compute pipelines and explicit layouts, independent of the local
GPU wrapper's hard-coded group3 params ring. It does not take a Simulation.
It exposes `pipeline`, `ready` (pick pipeline) and `prepare`.

- `lighting = {sun0,sun1,book,params}`: immutable texture views, SunBook buffer,
  and complete `WorldSunParams` host values. Missing bindings are rejected;
  bound but unbuilt/invalid lighting marks incomplete in WGSL. GI/glow are the
  pinned atlas snapshot's channels and require LIGHT readiness.
- `createWorldAppearance(gpu,{words,width,depth})` uploads original importer ABI
  v1 words losslessly to an independent rgba16uint 3D texture, reusing existing
  pair packing and source shading. Shader capability exclusion and
  `FU.sourceStyle` remain authoritative. No far-grid allocation is required.
- `prepare({snapshot,frameUniforms,physicsOrigin,params,external,lighting})`
  consumes one atlas snapshot pin (including on failure). `frameUniforms`
  contains a **global** eye/model/viewProj; `params` are `VolumeParams` values
  including clip→world `meshInv`. `external` supplies mediaNoise, packedMesh
  and a sourceAppearance view when not using the owned appearance adapter.
- Lamp/wand/dig fields are native local inputs translated exactly once from
  the supplied frozen physics origin into a new immutable frame buffer.
  Eye/model, beacon/cell, clouds, sun, artwork and warp are already global;
  shared uniforms/values are not mutated. Header.origin is always zero.
- The packed rgba32uint mesh must contain **opaque-only** scene colour/depth,
  not alpha/glass/liquid proxy depths. Its half-HDR/depth/coverage decoding is
  shared with the Atlas ABI. Coverage bit0, not RGB/alpha/depth-zero, controls
  the cut. Capturing/ordering Three's opaque pass remains integration work.
- Await `pipeline(...)` before recording when synchronous frame recording is
  needed. A candidate's async `draw(pass,{view,detail,curved})` records only
  this full shader, and always returns `requiresFeedback:true`, not complete.
  `recordPick(encoder,{params,output})` accepts global rays and the existing
  batch/slot params. Result format stays 32 bytes; face -1 is miss, **-2 is
  incomplete**. Pick resource lifetimes follow the candidate too.

Reserve Atlas requests using `feedbackExtraWords = 1 +
worldSunFeedbackWords(sunParams.tiles)`. Geometry's bitset is unchanged. The
first extra word is the candidate incomplete-status word; sun requests begin
at `bookLayout.requestBytes/4+1` (WorldSunParams.version.w). Snapshot bindings
expose the full allocated feedback extent; invalid reservation/offset/binding
sizes are rejected. Storage bindings must still fit the device and 128 MiB.

**Required protocol, not yet wired into presentation:**

1. Freeze/pin consistent source, derived, lighting, appearance and mesh
   publications. Atlas page writers use `recordPageWrite`, which owns queue
   submission. Do not pass unsubmitted field scratch output or retain borrowed
   scratch textures beyond their recording lifetime.
2. Create a candidate (fresh zeroed feedback, immutable buffers). Begin the
   WGSL query only once at the full fragment/pick root; nested queries must not
   clear it. Draw to a separate **unpresented** candidate target. Keep the last
   complete frame or loading presentation meanwhile.
3. Record/copy the **entire** feedback buffer to readback after all candidate
   consumers, submit, and await its completion. `candidate.decodeFeedback`
   returns exact status, global geometry requests and virtual sun requests.
   Withhold the **entire** candidate if incomplete; discarding individual
   fragments alone does not make a complete frame. Serve secondary misses too.
4. Merge geometry demand into `atlas.require` before eviction. Request sun
   dependencies from the lighting owner. Retry against a new consistent
   publication; no unknown-as-sky, local water tail or fully-lit fallback.
5. `candidate.release()` destroys candidate buffers and releases its atlas pin
   **only after final submission AND GPU completion**. Retain external resources
   for the same interval. Volume disposal does not destroy borrowed resources
   or prematurely release candidates. No binding getter submits source work.

## Checked evidence and limits

`npm run check:world-backend` is a required CPU CI gate (Naga CLI required;
CI installs pinned 30.0.1). It checks 136 pre-edit Box shader hashes from
35450775 plus original Box layouts, explicit Box defaults, **132 actual world
modules** (all registered views/detail levels, curved twins, source capability
on/off and heights128/384), native binding types/default limits, the real
assembly with a fake device and command encoder, immutable global conversion,
feedback/lifetime contracts, appearance words, sun layout/tile/epoch/pole and
receiver-plane scalar fixtures, and long CPU DDA/address references. Existing
source, quantized field and Atlas checks cover full state/pressure/seed/history,
films/media/paint/interpolation and packed mesh bits. They remain separate gates.

These are CPU/reference/static/fake-device and actual Naga compilation results,
**not execution of WGSL material/ray arithmetic on a GPU**, HDR/depth invariance,
visual/performance/memory-affordability evidence or shader driver compilation
measurements. No browser/GPU/server/deployment was run.

Still required: authoritative Source→Field→Atlas adapters and aux flags/distance;
full sun/GI/glow producers, ages/history and dependency closure; immutable
cross-channel publication; complete-frame presentation gating; full picks/edit
consumer staleness handling; figures/hands/native lighting readers; opaque mesh
capture, camera/model/post/paused/replica/stills/data-view/source-provider
integration; application single-path switch and removal of proxy composition;
GPU origin-shift/ray/material/lighting invariance and performance validation.
