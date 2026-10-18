# Native state/liquid foundation (format 2)

CPU-checked; this is not a GPU-validation or feature-parity claim.

## Ownership and seams

`PhysicsV2` allocates core 16, signed bank 4, transient liquid snapshot 16 and
request 4 bytes per slot: **20 authoritative / 40 resident bytes**, before
activity, dynamics, legacy compatibility and renderer storage. Disposal destroys
all four; undo/full restoration clears transient storage. Explicit legacy-owned
imports zero the bank even when imported core words compare equal. Suspended
imports pass `preserveLegacyMarks=1`: capturing retained v2 while v1 owns
physics does not consume v1's pending edit wake marks.

Bindings are per family: base 3, material 4, contact 5 and liquid 6 native storage
buffers. Import adds three legacy buffers plus the element table: eight total.
Import reads legacy A/B and marks, not F. Bridge retains the old four legacy
buffers but does not bind banks. Dynamics' adapter has only core/bank/activity
in group 0, with baked material tables, leaving five group-1 storage bindings.

`PhysicsV2(sim, {contactWGSL, Dynamics})` is an explicit injection seam. Empty
options do not advertise those capabilities. `v2BlockWGSL(g, contactWGSL)` loads
local core/bank arrays and zero requests, calls the contracted `contactBlock`,
then stores all material and ORs new requests with pending requests that moved
alongside the local material. Column and block swaps also move pending requests.
A boundary pass retires requests only on externally owned replacement slots before
import consumes those ownership bits. Liquid faces close while a detonation is
pending, so a failed allocation retains one source for retry instead of splitting. `nativeDynamicsHead(g)` supplies the
shared Material/accessors, grid, random and energy API, without a table buffer;
its family supplies `P.tick`. Dynamics must provide a positive `isIdle` certificate
before the foundation permits whole-engine sleep. Parent integration owns module
installation and exact dynamic persistence.

## Integer energy and advection

One capacity quantum is 1/(64*65536) of a water cell's capacity. One energy
quantum heats that capacity by **one quarter kelvin**. Material capacity per fill
quantum is `max(1, round(element.cap*64))`. For a liquid,

```
C = 65536 + fill * capacityPerQuantum(id)
E = C * temperatureQuarterK + phaseOffset(id)*amount + latentProgress + signedBank
```

For a nonliquid, fill in the capacity formula is 65536, except empty cells have
zero material fill. The base 65536 capacity always remains with the cell's air
carrier during liquid transfer. Core/bank whole-material moves preserve total
energy by moving both words together. JS uses BigInt; WGSL uses two unsigned
32-bit limbs for signed two's-complement energy. Arithmetic never converts
integer energy to f32.

A source sends the cumulative integer share of
`E - 65536*Tq` (material heat, reference-phase offset, latent progress and bank).
Each face uses `trunc(carried*(prefix+amount)/fill)-trunc(carried*prefix/fill)`;
the face order is +x,-x,+y,-y,+z,-z. The sender and receiver evaluate identical
transfers from immutable snapshots. Cumulative shares telescope, so full drainage
transfers every signed remainder, including the last quantum. Temperature
reconstruction divides exact energy by the destination capacity and retains the
remainder in its bank. Starting with zero banks and a uniform temperature,
capacity change times Tq exactly equals transferred heat. Thus every destination
and the newly dry source keeps that temperature; no 0-K vacancy is created.

Fuel/life is a **total integer**, in 1/2048 full-life units, not half-float or
concentration. A full initialized fuel cell contains 2048; sixteen compressed
cells contain 32768, below u16. Fuel uses the same telescoping integer shares.
Material ctype is retained by existing liquid; a newly wet receiver chooses its
largest incoming face, with fixed face-order ties. It is a categorical label,
not a conserved concentration. Conductive liquids use upper16 for spark/device
state instead of fuel; element-table validation rejects overlapping meanings.
All twelve spark bits (including code 3608) survive import and projection.

Flux leaves persistent upper payload and foam alone. Limit writes only snapshot
storage. Gather reads source ID, raw temperature, fill, ctype, payload and bank
from snapshots. Its core-w view is atomic because upper payload and lower
z-flux share a word: neighboring flux reads and upper-payload writes are atomic,
and the lower16 flux bits never change in gather. x/y/bank writes are strictly
destination-local; neighbors do not read them. There is no concurrent foam gather.

Gather skips two exact fixed points before it constructs packets. A normal,
zero-bank AIR cell with no usable liquid neighbor and zero face flux stays
unchanged. Homogeneous liquid requires seven equal frozen snapshots, zero bank,
payload, age and jet masks, full limiters, and paired face fluxes that cancel.
Strict phase guards exclude latent endpoints. Equal packets preserve mass and
heat, and normal-temperature admission cannot reject them. Moving liquid still
marks its cell busy. Flux lanes remain unchanged, and all other cases use the
full gather path. `node tools/v2/gather-identity-check.mjs` checks the production
predicate, exact integer packets, old gated advection, and minified WGSL on CPU.

Each incoming face is capped to one sixth of the receiver's remaining sixteen-
cell compression headroom, minus a half-float rounding guard. This conservative
cap may slow near-limit compression; it never discards an arrival to fit storage.
Sleeping faces are closed and explicitly wake their neighbors before transferring.

## Saves and migration

The binary envelope and metadata both carry version 2. Version 1 migration is
explicit: preserve flux, remove the old limiter/remainder from upper word3/age,
convert nonliquid f16 life to integer units, initialize formerly unrepresented
liquid life from the element and exact fill, and wake activity. Invalid prototype
life/compression is rejected. Old nonzero opaque auxiliary words are rejected:
there was no defined energy unit to migrate. Old truncated conductor codes
cannot be recovered; migration does not invent the missing bits. Version 2
round-trips valid raw core and signed-bank bit patterns exactly. Invalid phase
tags are rejected before upload; prototype temperatures over 10000 C are rejected
with an explicit conversion error, never reinterpreted as phase progress.

## Evidence

- `node tools/v2/foundation-check.mjs`: numerical/property, packing, migration,
  mocked real-driver allocation/bind/reset/rest/disposal tests.
- `node tools/v2/saves-check.mjs`: codec and real save-section/container tests.
- `node tools/v2/compact-wgsl-check.mjs`: all discovered WGSL Naga validation.
- `node tools/check-sampler-budget.mjs`: every grid's binding budget.

## Phase tags and range safety

The contact-owned pure phase helpers are integrated. Supported sensible raw Tq
is 0..41093 (through 10000 C). Hot tags 41094..53314 and cold tags 53315..65535
have 12221 codes / 12220 intervals. `cTq` and `compactTq` decode their physical
threshold temperature; `cRawTq` exposes the stored tag. `energyOf` includes phase
reference offset and latent progress in wide integer units. `withEnergy` first
encodes an exact latent plateau, then sensible heat plus a signed residual.
`energyFits` is the required exact admission check before a rule commits an
extreme total that may not fit. The grid WGSL predicate no longer encodes and
decodes merely to test representability. It checks hot/cold latent intervals
first (cold STEAM can lie below the normal interval), then checks signed sensible
energy in `[-2^31, capacity*41093 + (2^31-1)]`. All subtraction/addition wraps
modulo u64 and comparisons use signed two-limb `phaseLess`, matching the original
WGSL round trip even at signed-64 extremes. Latent bases use ctype zero, as grid
encoding does; normal offsets use the material's actual ctype. Packet admission,
encoding and residual bookkeeping are unchanged. The JS helper still throws on
bank overflow.

`node tools/v2/thermal-admission-check.mjs` computes the necessary domain proof
from all 91 rows and valid fill extremes (0, minimum nonzero, FULL, MAX_FILL):
maximum capacity **67,174,400 < 2^31**, maximum latent bucket
`ceil(totalLatent/12220)` **20,978,385 < 2^31**, and maximum
`totalLatent*12220` **3,132,668,615,065,600 < 2^64**. It asserts that every
latent-bearing offset is ctype-independent and LAVA has no latent side; changes
to these facts fail the CPU check instead of silently permitting truncation.
An independent old-WGSL oracle masks u64 arithmetic and casts banks to i32,
without calling JS `withEnergy`. Its **6,183,436 cases / zero mismatches** cover
all rows, all 256 LAVA ctypes, fill extremes, latent endpoints ±1, bank boundaries,
signed-64 boundaries, random64 energies and every raw normal/hot/cold code. The
check also pins the actual production predicate to the tested model. This is
CPU correctness evidence, not measured GPU speedup; the parent owns native
performance validation.

Liquid admission reserves a sixth of destination fuel and energy headroom for
each face. Its energy bounds are affine over amount for the destination's current
normal/phase interval, and reserve headroom both before and after possible local
drainage. A refused packet remains at its source and marks activity busy; it is
not discarded. Raw cumulative face prefixes remain fixed even when another face
is refused, so energy/fuel shares are still identical at sender and receiver.
This intentionally conservative saturation policy can stall extreme-bank or
full-payload mixtures rather than lose state.

The authoritative dirty word is separate from visible, legacy projection and
rule-busy words. Flux-only and bank-only changes mark authoritative state, not a
spurious visible change. Version-1 migration expands the previous activity layout.

## Pending parent-only GPU regression

Under the shared 10-second **total** slot budget after launcher adoption: settle
a v1 brick, edit a moving material into it, save/capture the retained suspended
v2 owner before the v1 activity rebuild, then compare the next v1 step with a
no-save control. Assert MARK_ACT survives capture and the edited material moves
identically; verify neighboring retained fractional liquid is unchanged. The CPU
regression records actual capture/import dispatch flags and checks the guarded
kernel write, but does not substitute for this GPU assertion. No GPU run was
performed by this implementation lane.
