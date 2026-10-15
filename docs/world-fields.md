# World fields — phase 2 numerical writer

**Not an enabled world renderer.** Atlas readers, continuous primary/secondary
rays, glow/GI/optical shadows, application integration, visual validation and
shipping remain later phases. Nothing here draws, changes quality policy, or
constructs a physics simulation. Do not deploy this phase as the completed fix.

## Shared Box arithmetic

`src/gfx/fieldDeriver.js` owns field specifications, weights, layouts, groups,
kernel construction, separate EMA/spatial recording and lazy Box test/shift
factories. Resources are borrowed by `FieldDeriver`; their allocator destroys
them. `Derived` still owns Box scheduling, ages, dirty lists, shifts, tests,
public aliases and `tmpB` (including GI reset/shift's fourth plane).
`fieldWeights` is still exported from `src/derived.js`.

Default Box shader text is hash-checked against
`bb2b07d85016b6ab58701e2cabb3d9720522bdee` at 32/64/128. The world variant
only extends group-3 parameters and replaces ownership/demand/boundary guards;
it shares the arithmetic and every packed store. No full-float intermediate
substitution: EMA/blur/boost use RGBA8 words, normalized planes use half pairs,
and final surface/media/thin fields remain rgba16float.

## World ownership and lifetime

`WorldFields` uses world-aligned 32³ construction cores, 4³ history owners,
and one reusable 64³ scratch allocation (raw halo16). History slabs allocate
512 pages lazily, 768 bytes/page, well below the 128 MiB binding limit.
There is no dense world allocation and no Y-truncated packed world key.
The field resources use exactly 20,971,520 bytes at 64³; age/list bookkeeping
adds 98,432 bytes. Authoritative A/B/aeration staging is another 10,485,760
bytes, separate from that field subtotal. B preserves the existing read-only
state layout; unused flow/deco remain source/publication dependencies rather
than unnecessary field scratch allocations. Writer layouts stay at <=8 storage
buffers, <=4 storage textures, <=16 sampled textures, four groups.

`plan({fieldTick, sourceSnapshot, wantedCores, changedBricks, smoothing, full})`
requires explicit logical FIELD ticks, not physics steps, camera jobs, atlas
moves, or origin revisions. Settling owners continue advancing without visible
jobs. Missing dynamic ticks are rejected: replay pinned historical source
snapshots instead of blending the latest target repeatedly. Settled unchanged
owners may skip arithmetic. Newly encountered owners initialize from targets;
existing owners do not reset on physics/residency changes. `changedBricks`
contains world **brick coordinates**, not cell coordinates, and must describe
all raw/aux changes since the preceding committed tick. Aeration dirty support
is expanded by JOIN4 before selecting target owners. Explicit aeration toggles
invalidate all existing targets and cannot change during a committed tick.

Every selected owner appears once. Owner batches gather history, record only
owned EMA, and scatter to copy-on-write packed pages. **All owner scatters
precede every spatial halo gather.** Scratch spatial jobs never advance EMA.
Recording failure leaves authoritative pages unchanged; retrying the same plan
is safe. History version/epoch checks reject stale plans and late publications.
Epoch reset never reuses old-epoch pages: old slabs stay alive until adapter
`dispose()`, which the caller performs only after its queued work completes.
This deliberately trades rare epoch-reset retention for safe command lifetimes;
ordinary residency/origin changes must not call reset.

Previously published spatial validity is invalidated by unseen settling or
edits, so re-entry cannot reuse stale fields after histories settle offscreen.
Smoothing rebuilds spatial outputs without a second same-tick history advance.

## Source injection contract (phase 1 connection still required)

No import of an in-progress source class is used. The caller supplies tables
and their layouts (or standard TABLES/STATE_RO defaults), world bounds, and a
pinned immutable source snapshot:

```js
{
  epoch, sourceRevision,
  jetValidity: 'producer-bounded-v1',
  aerationActive: true, // false disables jet input explicitly
  isCurrent(),
  assertComplete(regions), // throws for ANY unavailable in-world neighbor
  recordGatherRaw(frame, {
    resources: { A, B, aeration }, g, scratchOrigin, worldBounds,
    sourceRevision, stateCopy: 0, aerationCopy: 0,
  }),
}
```

All callbacks are synchronous GPU **recorders**, not promises. `assertComplete`
checks the complete requested scratch/world intersections before encoding.
`recordGatherRaw` must record complete GPU-to-GPU gathers of original A/B bit
patterns and current auxiliary aeration, honoring live/outgoing/saved/generated
source authority. Copy indices are immutable and independent: source state=0,
aeration=0 in single-copy scratch, therefore shader `H.src=0`, `P.aer=1` when
enabled. No CPU readback may route dynamic data. Source flow/deco/appearance and
auxiliary versions remain attached to the source snapshot for later consumers.
The caller pins source allocations until queue completion. Missing data is
never AIR. A pure physics-origin move must retain the same content revision and
field tick; origin metadata is not a field derivation input.

`jetValidity` is an authority assertion, not an unchecked import mode: all wake
components must be finite with |x,z,w| <=1 **after half packing**. The actual
producer normalizes velocity and scales by 1 or .5; high speed does not enlarge
JOIN reach. Arbitrary malformed/unbounded wake imports must be rejected before
issuing this descriptor. No shader arithmetic is silently clamped to manufacture
a halo proof.

## Demand / support

For final interval F=[16,48)³, stage expansions are:

| Result | x,y,z |
|---|---|
| peak/final | 0,0,0 |
| boost z | 1,1,1 |
| boost y | 1,1,2 |
| boost x | 1,2,2 |
| normalized blur z | 2,2,2 |
| blur y | 2,2,4 |
| blur x | 2,4,4 |
| authoritative EMA | 4,4,4 |
| conservative raw/aeration | 8,8,8 |

Full demanded intermediates are rebuilt in each selected scratch job. The Box
COVER optimization relies on persistent normalized halos and is **not** used.
Only genuine world bounds skip Gaussian/peak taps or clamp boost taps; scratch
and construction edges are not world boundaries. In-world support must exist.

Gaussian2 + lattice1 + peak1 = FIELD4. Valid normalized half-stored wake
components bound every rounded JOIN4 offset by four per axis. Cubic controls
at i-1..i+2 for displaced normal samples (|h|<=.55) lie within c-3..c+3.
Total raw L-infinity support is therefore 4+4+3=11 <16, even at corners.
The optional numerical guard3 uses F=[13,51)³ and raw [5,59)³. It creates
no extra history owner. **This proves neither glow nor GI reach**; their
contracts and integration remain separate later work.

## Publication / integration

The injected publisher implements:

- `recordOwnedFields(frame, {token, scratchOrigin, ownedWorldBricks,
  validBounds, textures, sourceSnapshot})`: record copies of owned outputs
  **before scratch reuse**, returning an opaque numerical/atlas handle. Never
  retain borrowed scratch textures for a deferred read.
- `publish({token, outputs})`: atomically apply the complete batch to the
  retained world snapshot. Numerically unchanged cores retain their previous
  fields; this is an incremental patch batch, not a claim that the batch alone
  is a complete standalone atlas.

Tokens contain epoch, field tick, source revision, history version, smoothing
and publication generation. `isCurrent(token)` rejects superseded generations.
The caller keeps publication/source lifetime discipline and later atlas
addressing outside this module. `record` returns `retire()` for CPU metadata
upload buffers; call it **only after frame submission and queue completion**.
A recording exception attaches `retireWorldFieldUploads()` with the same rule.
No global GPU wait or CPU dynamic readback is introduced.

## CPU checks and limits of evidence

`npm run check:fields` runs:

- Actual shared resource/layout/kernel/group/recording and real Derived Box
  adapter checks, public aliases/dirty order/shift helpers/GI scratch ownership.
- Exact Box shader hashes, all 2,392,064 slot round trips and writer binding
  budgets at 32/64/128; actual Box/world WGSL Naga validation (42 modules) when
  the CPU CLI is available. CI does not require installing a GPU or Naga.
- f32 quantized scalar references, exhaustive binary16 finite-word round trips,
  unorm/half ties, all packed stages across a complete odd three-core domain,
  plus material/film/wall/media/aeration fixtures, faces/corners/world edges,
  height384, epsilon sampling, cubic/normal stencils and support failures.
- Actual world recording/native-copy ownership paths on a fake encoder, including
  reversed owners/jobs, duplicate ticks, retries, invisible settling, stale
  sources/epochs/publications, source readiness, origin metadata invariance,
  height384 planning, and late reset resource-reuse protection.

The scalar reference is an independent CPU arithmetic model using the actual
material table getters and shared weight/demand helpers; it does **not execute
WGSL spatial arithmetic**. Fake-GPU history tests execute CPU EMA arithmetic and
actual recording/copy control flow, not real GPU pipelines. These gates do not
prove GPU floating-point agreement, texture-copy publication, source-class
integration, visual quality, performance, GI/shadows, or the complete renderer.
Browser/GPU/server/deploy were intentionally not run for this phase.
