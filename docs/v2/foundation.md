# Native state/liquid foundation (format 2)

CPU-checked; this is not a GPU-validation or feature-parity claim.

## Ownership and seams

`PhysicsV2` allocates core 16, signed bank 4, transient liquid snapshot 16 and
request 4 bytes per slot: **20 authoritative / 40 resident bytes**, before
activity, dynamics, legacy compatibility and renderer storage. Disposal destroys
all four; undo/full restoration clears transient storage. Explicit legacy-owned
imports zero the bank even when imported core words compare equal.

Bindings are per family: base 3, material 4, liquid/contact 5 native storage
buffers. Import adds three legacy buffers plus the element table: eight total.
Import reads legacy A/B and marks, not F. Bridge retains the old four legacy
buffers but does not bind banks. Dynamics' adapter has only core/bank/activity
in group 0, with baked material tables, leaving five group-1 storage bindings.

`PhysicsV2(sim, {contactWGSL, Dynamics})` is an explicit injection seam. Empty
options do not advertise those capabilities. `v2BlockWGSL(g, contactWGSL)` loads
local core/bank arrays and zero requests, calls the contracted `contactBlock`,
then stores all material and ORs requests. `nativeDynamicsHead(g)` supplies the
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
E = C * temperatureQuarterK + signedBank
```

For a nonliquid, fill in the capacity formula is 65536, except empty cells have
zero material fill. The base 65536 capacity always remains with the cell's air
carrier during liquid transfer. Core/bank whole-material moves preserve total
energy by moving both words together. JS uses BigInt; WGSL uses two unsigned
32-bit limbs for signed two's-complement energy. Arithmetic never converts
integer energy to f32.

A source sends `amount*capacityPerQuantum*Tq`, plus its bank's cumulative integer
share. Each face uses `trunc(bank*(prefix+amount)/fill)-trunc(bank*prefix/fill)`;
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
round-trips raw core and signed-bank bit patterns exactly.

## Evidence

- `node tools/v2/foundation-check.mjs`: numerical/property, packing, migration,
  mocked real-driver allocation/bind/reset/rest/disposal tests.
- `node tools/v2/saves-check.mjs`: codec and real save-section/container tests.
- `node tools/v2/compact-wgsl-check.mjs`: all discovered WGSL Naga validation.
- `node tools/check-sampler-budget.mjs`: every grid's binding budget.

Contact phase tags extend the energy formula and migration validation; that
integration is tracked separately until the supplied helper is connected.
