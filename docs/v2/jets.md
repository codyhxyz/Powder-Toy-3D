# Native accepted-face jets and compact foam (CPU checked)

`PhysicsV2` creates `NativeJets` only with an injected Dynamics particle/control owner. The application injects the real `NativeDynamics`; there is no hidden dynamics constructor, shadow particle pool, or legacy bridge. Injection-only foundation tests retain grid transport. Owner readiness includes every jet pipeline; pending/failed readiness cannot tick. Disposal releases the transient mask exactly once, including disposal before readiness.

Each native liquid substep records **flux → limit/snapshot → jet candidate/count/allocate/spawn → material/foam gather**. Production uses three substeps at 60 Hz (180 Hz), not the aspirational four in §4.1. Jet velocity uses that rate and the face flux's cell-volume units. There is no static-head scan or ORIFICE_CV coefficient. GPU evidence for the 5% Torricelli outcome remains outstanding.

`liquidTransportWGSL` is the single source for `TransportPacket` and `sendOf`, including integer energy/fuel apportionment and destination representability gates. Candidates are horizontal accepted outgoing packets into empty cells above empty cells at speed >1 m/s. A candidate whose material-only particle bank cannot be represented is not diverted. Material retains original phase/temperature code, dtype, raw BURN bit, foam and conductive spark union. Particle energy is `energyOf(packet) - FULL*cTq(packet.core)`.

Allocation ranks brick, slot, then face; the native 65536-slot free list is rebuilt in slot order at canonical control **word 32**, shared with actual NativeDynamics. Requested counts are not clamped to capacity. Only ranks below actual free capacity spawn; every refused candidate remains an ordinary destination grid arrival, and overflow increments native `control[7]`. Gather subtracts accepted source outflow once regardless of allocation. It suppresses the matching destination incoming packet only when allocation succeeded. No atomic arrival-order allocation.

## Storage and ownership

`jetMask` costs **4 transient bytes/cell** (8 MiB at 128³); native cell allocations total 44 B/cell, not 16 B total. It is neither persisted nor shifted as authoritative state. Limit resets every awake cell each substep:

- bits 0–5: allocated faces;
- bits 8–13: immutable candidate faces;
- bits 24–31: immutable pre-gather foam byte.

The mask is atomic because spawn reads neighbouring candidate masks while publishing its own accepted bits. Source snapshots keep the raw liquid ctype byte, including BURN. Phase energy still uses masked `ctypeOf`. Burning state reaches a destination only with actual incoming mass, or stays with actual retained source mass; drying clears it. Face reads reject sleeping cells before reading snapshots and use wrapped neighbour coordinates. Restores clear both scratch and mask; each subsequent substep refreshes them before use.

Jet stages bind native core/bank/activity plus scratch/mask/particles/control: **7 storage buffers**. Liquid stages including shared tables remain at **8**. Native particle records remain 48 B at fixed 65536 capacity. No new persistent particle metadata.

## Foam and rendering

Every liquid has an explicit `FOAM_ROWS` gain/lifetime. Gather transports foam upwind weighted by accepted face volumes and generates bounded local agitation foam. Immutable mask foam and immutable face flux eliminate neighbouring material read/write races. Foam is decoration, not conserved matter/heat.

After all substeps a native 60 Hz pass decays the byte using deterministic integer dithering at Monahan lifetimes (fresh 2.54 s, salt 3.85 s, rounded to native ticks). Nonzero foam keeps its brick busy; zero does not. No render-frame timestep or everlasting minimum-byte residue.

`src/v2/foam.js` exposes pure CPU/WGSL `impactFoam`: the dynamics accepted liquid-deposit path calls it once per accepted packet, mixing resident/incoming coverage and bounded incoherent speed²-driven entrainment above 1 m/s. The dynamics lane owns deposit acceptance and heat/splash accounting; the helper is not another energy source.

The existing smooth surface's trilinear `aerTap` reads compact core high 8 bits directly for native headers; its legacy branch still reads legacy aeration. Native foam is compiled even with the legacy Whitewater switch off. The transparent-liquid interface retains its existing optics; native molten liquid surfaces (including lava and mercury) layer foam over reflected light while retaining temperature, emission and base material shading. Legacy eligibility, ripples and meniscus switches are unchanged. No conversion pass or quality reduction was added. Physical reads use header format 3; renderer reads use format 2.

## Evidence / remaining acceptance

CPU-only commands (no browser or GPU):

- `node --test tools/v2/jets-check.mjs tools/v2/jets-driver-check.mjs tools/v2/foam-render-check.mjs`: exact packet reference, canonical allocator/source gates, immutable snapshots, foam decay/impact, square/rectangular compute Naga checks; actual PhysicsV2/NativeDynamics/NativeJets orchestration, all modes/edges, live pool bindings, restore/switch/read-header behavior, deferred/failed readiness and exactly-once disposal; actual smooth-render module Naga checks at off/default/full/curved quality for both liquid channels.
- `node tools/v2/foundation-check.mjs`: 1534 conservative advection cases, 10000 exact wide products, ownership/rest/restore/disposal.
- `node tools/v2/integer-transport-check.mjs`: 508380 exact arithmetic oracle checks and shared-helper assertions.

These are not GPU execution or performance evidence. GPU packet readback under real pool exhaustion, Torricelli/parabola trajectories, foam pixel/temporal checks, legacy pixel parity, and canonical free-list/full-grid work profiling remain outstanding. Actual renderer shader compilation in Naga does not establish device pipeline or pixel acceptance. No GPU launch was attempted: the player owns the GPU.
