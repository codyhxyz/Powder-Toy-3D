# World render atlas ABI v2 — independent lighting residency

**Disabled foundation, not an application renderer switch.** The concrete
[Source/Field/classified CELL adapter](world-cell-adapter.md) and
[full optical Sun producer](world-sun-producer.md) now connect separate disabled
pieces. GI/glow scheduling, history initialization/replay, application integration,
compression, procedural recipes and any outside quality tier are not added here. Box material/optical
math and importer ABI remain unchanged. CPU/Naga evidence is not GPU acceptance.

## Breaking migration from v1

`WORLD_ATLAS_ABI = 2`. Migrate layouts, WorldParams reserved words, readiness
masks, allocations and feedback together. Old `LIGHT=8` meant every lighting
channel; v2 bit8 means **GI_SOURCE only**. `allocate()`/`lookup()` and legacy
`require(bricks)` now default to CELL=7. Use `allocateLight()` for lighting.
The separate LIGHT book is mandatory; never bind a v1 book/params combination
as v2. WGSL checks ABI and pool capacity; epoch and publication are the CPU's
invariant (a snapshot's books name only pages of its epoch that it published),
and native candidates reject old ABI and reset epochs. Retained old resources remain pinned until release, not destroyed
or reinterpreted on reset. The CPU CI Atlas gate explicitly asserts ABI2.

## Addressing and sizes

- World-aligned 4³ brick index: `bx + BX*(by + BY*bz)`. Both immutable books
  contain one u32 per GLOBAL brick: zero UNKNOWN, otherwise pool ID + 1 in
  bits 0–28 and the page's readiness in bits 29–31 (LIGHT's shifted down by 3;
  `bookEntry`/`bookPage`), so a shader lookup is one load, not also the aux
  record 0 read (~3 s of the World volume shader's cold build).
  Each book separately costs **24/72 MiB** at world `[3072,128/384,1024]`.
  Do not combine them: height384 would exceed the 128 MiB binding limit.
- A commit never uploads or scans a whole book. An unchanged book (a pool
  growth) is the current snapshot's buffer, shared and refcounted (books are
  read-only to every reader). A changed one is a GPU copy of the current book
  plus the 64 KiB chunks (`BOOK_CHUNK_WORDS`) that hold the commit's changed
  entries. A reset or private producer book starts from a fresh, zeroed buffer.
  Descent's 125 MiB books were re-sent several times a second during a load
  (2026-10-21).
- `atlas.live.cell`/`atlas.live.light` map each nonzero book index to its page.
  A commit checks only its changed indices, never all 33M entries of a Descent
  book. `bookPages(kind)` lists them in book order.
- A snapshot state does not pin each page its books name: a page is public
  from `p.since` (the commit that published it) until the commit that
  supersedes it, and only then is it pinned by every live state whose
  generation lies in that span, until that state retires. Pinning every live
  page per commit grew a World load's CELL batches with all it had loaded
  (Island, 2026-10-22). A publish under an unchanged dependency manifest
  revalidates only its own LIGHT pages; every retained one passed under it.
- `reserve(kind, count)` grows a pool once for a batch's pages, not a doubling
  per overflow (each growth copies every public page).
- **Cell PID**, **light descriptor ID**, and **probe PID** are independent
  namespaces, not interchangeable. Source-only descriptors allocate no cell or
  probe slot. GI/glow-only descriptors allocate no cell slot. GI/glow share a
  probe slot namespace but have distinct readiness, ticks and dependencies.
- State A/B are lossless rgba32uint. Three final fields are rgba16float. Only
  cell capacity sizes these five textures and the cell region of auxiliary.
- Cell slot order is the original `x + 4*(y&1) + 8*(z + 4*(y>>1))`, NOT xyz
  linear. A cell page is an 8×8 tile. All pressure/ctype/seed/NaN/signed-zero
  words survive exact uint transport.
- Four SH bands and glow are rgba16float, one texel per **probe PID**. Only
  probe capacity sizes them. World probe centres remain `4*brick + 2`.
- Auxiliary remains ONE rgba32uint 2D-array texture. Linear texels flatten
  width, height, layers. Cell region: `cellPID*132 + record`. Descriptor region:
  `descriptorBase + lightID*5 + record`, where `descriptorBase=cellCapacity*132`.
  Region growth/repacking uses COW; raw uploads never address the source region.
- Every size honours device dimensions/layers and u32 linear addressing.
  `worldPoolMax` and `worldPoolGrowth` cap doubling to a sufficient legal size;
  e.g. cell capacity 2^24 grows to 32,537,630 with one descriptor, not the
  illegal unchecked 2^25. Allocation failure is an error, never reduced quality.

### Cell auxiliary (132 vec4u, unchanged payload)

| record | words |
|---|---|
| 0 | readyBits, epoch, sourceRevision, fieldTick |
| 1 | original BrickInfo emission.xyz float32 **bits**, info |
| 2 | occupancyLo, occupancyHi, distancePlus1, age |
| 3 | reserved **zero**, NOT a GI-source record |
| 4+2*slot | original packed-half flow.xy, aeration.xy |
| 5+2*slot | cell paint RGBA8, 0, 0, 0 |

Distance zero means unknown (-1), not empty. Decoration is cell paint, not the
particle pool. Even RAW-only publication needs its cell metadata packet.

### Lighting descriptor (5 vec4u = 80 B)

| record | words |
|---|---|
| 0 | readyBits, epoch, sourceRevision, sourceTick |
| 1 | GI probePID+1, glow probePID+1, giTick, glowTick |
| 2 | source dependency ID/version, GI dependency ID/version |
| 3 | glow dependency ID/version, ABI=2, publication generation |
| 4 | **actual original giSrcPack vec4u** |

Absent probe/glow references are zero. Record4 is only ready when GI_SOURCE
is declared and completely written. No fake air is synthesized. Original air
is `[0,0,0,0x1ff7fdff]` (direction 511 in each ten-bit component), NOT vec4u(0).
The original `giSrcWGSL` packing is shared/exported from `shaders/gi.js`.

Readiness: RAW=1, FIELD=2, AUX=4, GI_SOURCE=8, GI=16, GLOW=32;
CELL=7, LIGHT=56, ALL=63. Source/GI/glow readiness never implies another channel.

## WorldParams — 112 bytes, all vec4u

| byte offset | field | words |
|---|---|---|
| 0 | world | world size xyz, epoch |
| 16 | bricks | brick dimensions xyz, publication generation |
| 32 | tiles | cell tiles x/y, cell capacity, ABI |
| 48 | aux | width/height/layers, 132 |
| 64 | probes | width/height/layers, probe capacity |
| 80 | light | descriptorBase, descriptor capacity, 5, dependency manifest version |
| 96 | feedback | words/plane, status word offset, sun suffix word offset, 0 |

## Bindings

Standalone reader: **16 sampled textures, three storage buffers, four groups,
zero samplers**. Integrated full reader: five storage buffers (six for
pick/native point output), same 16 sampled textures/four groups.

| group | standalone bindings |
|---|---|
| 0 | params0, cell Book1, LIGHT Book2 |
| 1 | stateA0, stateB1, field0/1/2 at2/3/4, aux5 |
| 2 | GI0..3 at0..3, glow4, sunDepth5, sunOptical6, mediaNoise7, sourceAppearance8, packedMesh9 |
| 3 | requests0 |

Integrated group0 adds Tables0/Header1/Frame2, then params3/cell Book4/**LIGHT
Book5**. Integrated group3 is params0/requests1/linearClamp2/linearRepeat3/
WorldSunParams4/**separate SunBook5**/optional output6. SunParams remains exactly
128 B, pitch **0.416531224**; sun0 remains rgba32float, sun1 r32float arrays.
External noise/appearance/packed opaque mesh remain required, not omitted.
See [world-shader-backend.md](world-shader-backend.md).

Writer layouts remain separate, at most four storage textures/eight storage
buffers. `worldPageWriterWGSL('source')` is a real one-record uint source writer
into existing aux, with one vec4u input and no sampled output alias. Its 64-byte
WriterParams uses reserved.x (byte48) for the absolute source texel index.
Other writers retain raw3/fields3/GI4/glow1 output counts; GI/glow WriterParams
page.x is **probe PID**, not descriptor ID. Raw dispatch is 3×64; others 1×64.
These transport writers are NOT the phase4 optical/source/gather algorithms.

## CPU producer/publication API

`new WorldRenderAtlas(gpu,{worldSize,initialCapacity=64,initialLightCapacity=0,
initialProbeCapacity=0,retire,onChange,feedbackExtraWords=0})` owns two dense
books and small resident textures. Global metadata never allocates world-dense
cell/lighting/history payloads. Zero logical capacities still require minimal
bound textures (existing geometry rounds to 64 cell tiles/64 probe texels).

- `allocate(brick,{sourceRevision,fieldTick=0,readyBits=CELL})`: frozen opaque
  `{kind:'cell',physicalPageID,...}`. `allocateLight(brick,{sourceRevision,
  sourceTick=0,giTick=0,glowTick=0,readyBits=LIGHT,dependencies:{source,gi,glow}})`:
  frozen `{kind:'light',lightDescriptorID,probePID,...}`. Dependencies are
  `{id,version}`; `{0,0}` is an explicit untracked dependency assertion.
- `update(cellJob,{stateA,stateB,field0,field1,field2,aux})` and
  `updateLight(lightJob,{source,gi0,gi1,gi2,gi3,glow})` accept exact Uint32Array
  words/Uint16Array half bits. Only declared channels are legal. All packets
  validate before any upload. Source is exactly four u32 words, not cell aux.
- `recordPageWrite`/`recordLightWrite(job,kind,{auxMetadata,record})` give a fresh
  encoder and immutable private output identities via `writerBindings`.
  Callbacks must be synchronous and non-reentrant; the Atlas owns submission.
  Complete output is a trusted producer assertion, not a shader sandbox.
- `publish({cellJobs,lightJobs,dependencyToken,sunManifest})` validates the whole
  transaction, repacks pending old-resource jobs and switches **both books,
  params, views and manifests atomically**. Legacy `publish(jobOrArray)` works.
  Missing writes, source-revision mismatch between co-resident cell/light,
  dependency mismatch or allocation failure leave the prior snapshot public.
  Replacements may not drop readiness; sourceRevision cannot regress. Logical
  lighting clocks cannot regress across source changes. Cell field ticks retain
  the existing same-source monotonic rule. ID/epoch/generation wrap is rejected.
- `dependencyToken={version,sets:[{id,version}]}` is deeply captured. Every ready
  retained/new descriptor's declared nonzero dependency must match. Changed
  sets require a newer manifest version. This validates provenance declarations,
  **not** the producer's mathematical dependency closure.
- `sunManifest={epoch,basisRevision,publishRevision,dependencySetID,
  dependencyVersion,book,sun0,sun1,params}` captures versions, external resource
  identities and a deep immutable copy of complete WorldSunParams values.
  Native preparation rejects mismatched sun versions/resources/parameter bytes.
  Sun resources remain externally owned/pinned by the caller through final use.
- `snapshot()` captures ABI/epoch/generation, both books, params, pool addresses,
  all resource views, dependency token and sun manifest. Each pool has separate
  ID ownership/pins/retirement. Unchanged textures share ownership on independent
  growth; moving descriptorBase always COWs auxiliary even if geometry is equal.
  Pending providers retain their old set until publication/cancellation.
- `grow(capacity)` grows cells; `growPool('cell'|'light'|'probe',capacity)` grows
  independently. Existing public contents copy bit-exactly; immutable old
  snapshots survive growth/replacement. `cancel`/`reset` reject delayed jobs.
  Reset increments epoch, clears books/manifests, **not arrival-based history**.
- `retire(fn)` must wait for GPU-safe completion. Retain snapshots through any
  unsubmitted encoder and release after final submitted use. Native candidates
  require final GPU completion before release. Reset-era binding/record attempts
  reject; already submitted old resources still retire safely. `remove(bricks,
  channels=ALL)` removes selected pool domains, never requested/pending bricks.

## Typed requirements and incomplete-frame protocol

`require([{brick,channels}])` replaces the wanted set and returns missing channel
subsets, including **partially published entries**. Results contain
`{brick,index,channels}` and can be passed back to require. Legacy brick arrays
return missing global indices and demand CELL only. `lookup(brick,mask)` reports
`missingChannels`. No missing request contains a physical ID.

The existing requests storage contains **six aligned bitset planes** in order
RAW/FIELD/AUX/GI_SOURCE/GI/GLOW, then one mandatory incomplete-status word, then
the Sun suffix. For global N, `P=ceil(N/32)`: plane k begins at k*P, status=6*P,
sun=6*P+1. At height128/384 the six planes cost **4.5/13.5 MiB**. Reserve only
`feedbackExtraWords=worldSunFeedbackWords(tiles)`; status is now mandatory, not
an optional extra. WorldSunParams.version.w must equal `bookLayout.sunWord`.

`worldRequest(index,mask)` ORs **all** needed planes. Ready partial pages request
only missing channels. `worldLightDescriptor`, `worldGISource`, `worldProbeLoad`
and `worldProbeTex(t,p,ready)` resolve LIGHT independently of cell metadata;
GI and glow leafs demand only their own readiness. Classification still requires
RAW|FIELD|AUX before skipping. Probe/field interpolation retains global support,
world-only edge extension and spacing-four phase.

Begin once at the **entire** ray/shading/pick/point root. Missing or invalid
reads return placeholders solely to collect dependencies and latch incomplete.
Secondary/nested reads never clear it; unknown is not AIR, valid empty, a profile
or sky. End after ALL shading, write status, copy/read the ENTIRE feedback buffer,
and withhold the **whole** candidate when incomplete. `decodeWorldFeedback`
returns typed `requirements`, geometry union (cell planes), Sun requests/status.
Pass requirements to `atlas.require` before eviction. CPU helpers
`requestChannels`/`requestedChannels` use the same global addressing.

## CPU allocation accounting (not measured memory/performance)

Logical bytes are **5696*cellCapacity + 80*descriptorCapacity +
40*probeCapacity**, not 5736 times a coupled capacity. `worldAllocationBytes`
accounts actual rounded texture geometries; both books/feedback are additional.

| capacities cell/descriptor/probe | rounded texture bytes |
|---|---:|
| 0/1/0 (minimal binding textures included) | 232,960 |
| 64/64/64 | 494,080 |
| 1024/1024/1024 | 7,905,280 |
| 6,291,456 each (H128 dense upper bound) | 36,842,766,336 |
| 18,874,368 each (H384 dense upper bound) | 110,863,843,328 |

Dense rows are upper-bound diagnostics, NOT allocations performed by the
factory, GPU peak/affordability/performance claims, or a requirement to fill the
world. Source cache, histories, staging, sun and retained/growth overlap excluded.

## Validation and remaining phase4 work

`node --test tools/world-atlas-cpu-check.mjs`: 21 real-helper/fake-device/Naga
checks including unequal IDs, source-only demands, independent growth/repacking,
old snapshots, transactional failures, stale/cancel/reset jobs, synchronous
writers, typed high-Y384 feedback, canonical packed source transport, all half
mesh patterns, interpolation and legal address ceilings. Full world gate retains
136 Box golden hashes and 132 actual world modules; four native point modules
also compile. These tests do NOT execute material/GI/optical WGSL on a GPU.

The concrete CELL adapter now captures shared fields/classification and packs
lossless native pages. Atlas publication supports atomic pool invalidations for
required pages (replacements win), and field record callbacks expose scoped native
half-copy destinations without changing submission ownership. See its linked
contract for ordered-orphan quarantine and conservative lighting invalidation.

Phase4 still owns exact lighting source reduction, continuous GI gather/glow
producers, dependency closure, source-before-gather
barriers, world-owned probe history and reset/replay. No residency arrival may
reset a probe or substitute sky; late cold demand must retain/replay the original
logical tick history. No aliases/procedural profiles are claimed. Native figures,
hands, point scheduling, presentation gating and the application switch remain
unfinished; do not deploy this checkpoint as the completed renderer.
