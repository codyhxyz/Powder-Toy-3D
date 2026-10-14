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
not proof of visible particles. `physgun` reports the real controller described below, independently of draw readiness.

`renderState` exposes `particles`, `control`, readiness, and exact record ABI:

- Fixed65536 slots,48B each. Slot ID zero is free.
- byte0 position.xyz f32 **world cells**, byte12 stable u32 ID.
- byte16 velocity.xyz f32 **m/s**, byte28 core.word0 u32.
- byte32/36/40 core.word1/2/3, byte44 signed i32 bank.
- Particle-only tag254 photon,255 neutron; never write these into the grid.
  Photon core0 bits8..23 hold life, bits24..31 the last optical medium; words1–3 hold RGB f32 energy.
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
NOT a claim of dense-explosion timing parity. Empty batch work is indirect-dispatched at zero workgroups; selection still scans events. Fixed-cap allocation scans and active full-grid plans remain a performance risk requiring parent-owned GPU evidence. Plans and claims each cost16B/cell, below128MiB/binding at6.3M cells.

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

## Correctness refinements after first tranche

- Packet enthalpy excludes the stationary `AIR_CAPACITY_Q*cTq` carrier.
  Extraction leaves EMPTY at source actual temperature, bank0. Landing adds
  the packet's material-only enthalpy to ALL destination energy, including a
  nonzero empty bank. `energyFits` gates landing and all ray heat. Fractures
  re-encode the old exact energy under the debris capacity. Source packet
  payload is bit-exact throughout flight; landing can change thermal encoding
  to mix with the destination carrier without losing energy.
- Blast energy scales with liquid fill, including compressed/partial charges.
  Product heat is the declared quarter of scaled chemical J, plus all source
  thermal energy; selection gates its representation before ANY blast work.
  Acoustic pressure uses `sqrt(oldP²+addedP²)`, not additive sqrt kicks.
  Material heat from products and accepted rays uses foundation source ledgers.
- Photon core0 bits8..23 are life, bits24..31 last medium; its reserved bank
  word stores the last crossed axis, so attenuating through a slab does not
  skip refraction on exit. This tag-specific metadata is not a material bank.
- DDA has an analytical nx+ny+nz+3 bound for in-box crossings; non-progress
  retains the packet (or shields a blast), never skips a wall. Closed boxes
  land matter at boundaries; ray outflow is explicitly counted at control[16].
  World-window outflow retains every particle unchanged for future re-entry.
- API inputs must fit finite f32-safe arithmetic (absolute magnitude<=1e12).
  Restore validates live particle coordinates/energy and air floats before
  any writes. Snapshot carries pending shock terms and held-membership storage.


## Physgun and native special sources

`applyPhysgun({mode:'hold'|'fling'|'punt',position,target?,direction,radius,dt,strength})`
accepts world-cell coordinates. Hold selects loose matter (including existing
flight records), tracks membership separately without consuming any Material
bits, computes mass-weighted COM in canonical slot order, and applies a
critically damped COM spring plus relative velocity damping. Held particles
keep their offsets, do not deposit, and receive gravity compensation; they
still sweep/collide. Hold strength is stiffness in1/s (default12, bounded1..60).
The controller runs at native60Hz, not render cadence. Refresh hold requests
while held; after8 ticks without refresh it releases. Fling/punt strength is
delta-v m/s. `releasePhysgun()` explicitly releases without an impulse. Selection
and controller metadata survive snapshots and shifts. A full pool leaves grid
material intact and reports cumulative fallback attempts, never erases it.

DUST and SINGULARITY are recognized special events despite having no normal
`element.blast` row. They use the existing gunpowder calibration:
`E(P)=121500*(clamp(P,0,200)/60)^2` J. Thus DUST P30 gives30375J and FIRE
(nominal1700C); SING mass=rawlife/256 gives P=mass capped200 and FIRE
(nominal3000C), including tiny positive mass. Temperature remains bounded by
actually accounted thermal energy. Only ZERO mass is terminal evaporation:
EMPTY retains the original carrier, and removed material enthalpy is ledgered.
The explicit compatibility pressure scale is
`sqrt(Egp*0.25*2*rho*c²/brickVolume)/Pgp`, not an independent Pa/J guess.
`legacyPressureToPa()` is exported for legacy brush adapters; native requests
already use Pa. The singularity vacuum uses max(-50,-2.5mass) and the0.6
open-neighbour ring, with the same conversion, and wakes adjacent bricks.

Partial liquid ejection conserves exact fill, extensive fuel (or the intact
conductive spark union), signed64 enthalpy and the stationary air carrier.
Current jet detection samples fast unsupported flux AFTER liquid substeps;
this is conservative but is NOT yet exact pre-gather face-outflow diversion.
That timing hook belongs to the foundation liquid driver and remains an
integration limitation, not a claimed completed transport proof.

`validateDynamicState(snapshot,g)` is pure and exported. App/save callers should
preflight it before mutating ANY app or GPU state, then call restore. It includes
held memberships, queued rays, pending shock and source obligations.

## Modes / shared producer integration

DynamicParams carries the shared native mode fields; gravity is SI from
`nativeModes(sim)` (`setting/.025*19.6`). Particle acceleration is `mGravity`;
wind drag respects air velocity modes. Radial/open/loop powders use real
particle flight: a canonical walk toward `mDown` promotes an entire unsupported
run, never a one-cell-per-tick fallback. Capacity refusal leaves each source
unchanged/busy. The CPU census includes67237 simultaneous candidates and exact
refused-bank totals, not a reduced fixture.

Air honors pressure-off, velocity-off, off, no-update, ambient heat, loop faces
and void reservoirs. No-update freezes velocity/pressure transport/decay, not
explicit source/tool writes. Gas drift wakes on possible motion even when a
probabilistic move did not win that tick. Void matter/gas outflow is ledgered
and counted; world-window exits remain retained. Loop particles sweep every
crossed cell before wrapping; the analytical progress bound scales with the
segment, not the box size. `sweepRetries` reports a numerical non-progress guard.

The special source/nuclear helpers are imported from the contact owner's
`specialContactWGSL`: molten Pu/uranium retain their nuclear ctype. Deferred
unrepresentable capture/fission stores the exact interaction in the neutron
record at world coordinates, freezes life, and never spawns fission children
before its heat is accepted.

`P.nativeJets` comes from `owner.jets?.isReady`. The after-gather jet heuristic
is disabled ONLY when the actual exact-diversion owner is ready; wind/tools
still use conservative extraction. The exact jet owner shares the fixed48B
records and control/free-list ABI (free list begins at control word32).
