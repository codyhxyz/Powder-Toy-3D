# Native dynamics integration (CPU-checked; GPU validation owned by parent)

`new NativeDynamics(owner)` in `src/v2/dynamics.js` requires the foundation's
`owner.nativeDynamics = {head(g), layout, group}` and `owner.events`. Native
Material/core/aux/activity helpers occupy group0 (three storage buffers).
Each dynamics family occupies group1 (five buffers); group3 is normal Header
binding0 / DynamicParams binding1. There is no legacy state conversion.

## Recording / idle

Await `ready` once. Driver order:

1. `advanceParticles(tick)` after native import / awake-list build.
2. Column/block/contact rules.
3. `consumeMaterialEvents(tick)` before liquid substeps.
4. `advanceAir(tick)` after liquid substeps.
5. Native dirty publication / idle counts.

These methods only record on `owner.gpu.frame`. They never submit or wait.
At the owner's idle-read boundary enqueue `readActivity()` beside its args
read; `isIdle` is conservatively false until an epoch/serial-checked read says
particles, air, event obligations and queued emissions are all zero. A single
particle outside the current world window still counts. Checking `isIdle`
without ever calling `readActivity()` intentionally cannot certify sleep.

Contact events are ORed, not assigned: bit0 detonate, bit1 gas source, bit2
neutron emission. Detonation material remains at the source until products,
shielded damage/impulse and air shock have been recorded. Neutron requests
remain set when full. Sources and their 26-neighbour brick halo stay busy.

## Tool / renderer ABI

`applyToolImpulse({kind,position,direction,radius,strength,count?})` accepts
`impulse|photon|neutron|wind|pressure|vacuum|cyclone`. Position is **world cells**;
radius is cells; direction is normalized internally. Impulse/wind/cyclone
strength is already-integrated delta-v (m/s), pressure/vacuum strength is Pa.
Continuous-tool callers do their own dt scaling. Rays use count1..65536 and a
bounded64-request queue. Return `{status:'queued',requestId}` means recorded,
not falsely guaranteed immediate capacity; invalid/full-queue calls return
`{status:'rejected',reason}`. Capacity fallback retains grid matter and is
reported by `readActivity().capacityFallbacks`. Pending ray emissions retry.

`capabilities` separates `physicsReady` from `drawReady`; `attachDrawAdapter`
sets the latter only from an actual adapter's `isReady`. Physics capability is
not proof of visible particles. `physgun` remains false until a real hold
controller exists; a uniform impulse is not advertised as hold.

`renderState` exposes `particles`, `control`, readiness, and exact record ABI:

- Fixed65536 slots,48B each. Slot ID zero is free.
- byte0 position.xyz f32 **world cells**, byte12 stable u32 ID.
- byte16 velocity.xyz f32 **m/s**, byte28 core.word0 u32.
- byte32/36/40 core.word1/2/3, byte44 signed i32 bank.
- Particle-only tag254 photon,255 neutron; never write these into the grid.
  Photon core0 upper24 holds remaining life; words1–3 hold RGB f32 energy.
  Neutron words1–3 hold life, energy f32(MeV), pending children u32.
- `control` byte0 is live count, not a compacted draw list. A renderer can draw
  instanced65536 and reject ID0, or build its own draw-indirect list. No
  particle reorder: stable slots/IDs are part of continuation snapshots.

## Determinism / costs / limits

Flight uses swept DDA with no displacement cap. Deposition uses hashed stable
IDs plus deterministic tie election. Entire core+bank land unchanged in empty
cells; losers retain their payload. Spawn allocation is canonical brick/slot
prefix order into a deterministic free list, not dispatch-arrival atomics.
Liquids never break solids. Fracture consumes an explicit KE budget.

Blasts use immutable LOS plans before any target writes, blocked by intervening
solid cells. Global demand normalization bounds damage/KE to half the scaled
chemical energy; one quarter drives air, one quarter is reserved for products.
`BLAST_SCALE=0.001`. Existing TPT hardness is interpreted as gameplay toughness
in J; density uses the existing element density table (100kg/m³ per unit).
Default batch8, configurable1..64, bounds recording work. For1000 immediately
eligible sources, ideal service latency is125 ticks (2.0833s) at default,
16 ticks (0.2667s) at64; real chains/blocked capacity can take longer. This is
NOT a claim of dense-explosion timing parity. Full-grid plans and fixed-cap
allocation scans remain a performance risk requiring parent-owned GPU evidence.

Air is32B per4³ brick in two copies. Eight60Hz substeps use50m/s acoustic
Rusanov exchange plus bounded conservative upwind/diffusive heat/gas transport.
Face openness comes from the actual two cell faces. The CFL budget is explicit;
0.9999 loss and stated p/v quanta are intentional losses, not scalar leaks.
Gas events add one bounded1/64-brick source exactly once. Heat/gas scalars are
not erased at sleep. Native gas drift swaps the complete Material in disjoint
pairs. Surface wind lift and unsupported liquid jets feed the same allocator.

## Save / shift

Call `snapshotDynamicState()` synchronously alongside core/aux/activity
readbacks, then await the promises together. It queues all copies before its
first await. Snapshot includes particles, canonical current air, clock/queue
metadata, queued user emissions and sparse unaccounted material obligations
`[{worldCell,bits}]`; transient claims/plans are not saved. Restore validates
before writing and ORs duplicate obligations, preserving out-of-window ones.

`await shiftWindow([dx,dy,dz])` (alias `shiftOrigin`) is an explicit paused
world/persistence boundary, not a tick operation. Shifts must be multiples of4
cells. Particle world positions/payloads do not change. Exact air words leaving
the window are archived by world brick coordinate, restored on return, and
included in saves. Unprocessed material obligations outside the window are
also retained. There is no silent particle/air deletion on shift. Archive
memory grows with explored active air; compression/eviction is not implemented.

## Checks

- `node --test tools/v2/dynamics-check.mjs`: packing, range, DDA, claims,
  capacity conservation, shielded budgets, toughness/liquid exclusion,
  scalar conservation/CFL/sleep/wake, recording ABI, atomic restore, shift.
- `node tools/v2/dynamics-wgsl-check.mjs`: all stages against the real
  foundation adapter, square/rectangular grids, Naga, eight-buffer ceiling.
- Each family exports `WGSL_CHECK` for the repo's discovery validator.
- No GPU/browser runs were performed in this lane.
