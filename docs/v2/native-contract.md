# Native physics implementation contract

This contract supersedes the prototype packing where noted.
It preserves the smooth renderer and forbids a per-tick legacy conversion.

## State ownership

- `PhysicsV2.cells`: 16 bytes per cell, existing brick-major slot order.
- `PhysicsV2.aux`: one signed i32 energy bank per cell, stored in a GPUBuffer.
- `PhysicsV2.liquidScratch`: 16 transient bytes per cell. Never save this buffer.
- `PhysicsV2.events`: one transient u32 request word per cell. Never save this buffer.
- Core and bank are authoritative. Activity and clocks also require exact continuation snapshots.
- Banks move with material, including column moves, block swaps, particles, shifts and tools.
- Visible, authoritative, legacy-cache and possible-rule changes are separate signals.

These allocations cost 20 bytes of authoritative state and 40 bytes of resident native cell storage.
This excludes particles, air, compatibility caches and render fields. Do not claim 16 bytes total.

## Core packing

| Word | Liquid | Other materials |
| --- | --- | --- |
| 0 | ID u8, quarter-K temperature u16, foam u8 | ID u8, temperature u16, fall/gas age u8 |
| 1 | Fill u24, material ctype u8 | Life/fuel u16, material ctype u8, persistent flags u8 |
| 2 | Face flux x/y, two f16 | Powder fall fraction, otherwise mechanism state |
| 3 low16 | Face flux z, f16 | Spark code u12 plus device flags |
| 3 high16 | Spark/device state for conductors, fuel/life for other liquids | Color seed u16 |

The auxiliary bank stores signed thermal energy, quantization remainders and latent energy.
It is not scratch or a generic flag word.
The contact module defines the integer energy unit and capacities in shared JS/WGSL tables.
Conduction and advection must conserve that defined integer energy.

Conductive and combustible liquid payloads are a tagged union by element.
Reject a future element that requires both meanings.
Do not truncate existing spark codes, which reach 3608.

## Shared native functions

The state foundation supplies these WGSL functions:

```
loadMaterial(slot: u32) -> Material
storeMaterial(slot: u32, before: Material, after: Material)
makeMaterial(id: u32, temperature: f32, amount: u32, ctype: u32) -> Material
```

`Material` contains `core: vec4u` and `bank: i32`.
Existing `cid`, `cTq`, `cAge`, `cFill`, `cls`, `slotOf` and `cellOf` remain available.
Standalone rule modules use expanded local block arrays rather than accessing neighboring global state during writes.
`storeMaterial` reports changes. Rule modules also call `markBusy(position)` when a future action remains possible.

## Contact module

Ownership: `src/shaders/v2/contact.js`, `src/v2/contact.js` and dedicated tests.

Export `contactWGSL`, a WGSL declaration string with:

```
contactBlock(
  cores: ptr<function, array<vec4u, 8>>,
  banks: ptr<function, array<i32, 8>>,
  positions: array<vec3i, 8>,
  requests: ptr<function, array<u32, 8>>
)
```

The caller supplies `P.tick`, the shared element tables and native state accessors.
The module operates on disjoint 2×2×2 blocks.
The caller loads banks beside cores, initializes requests to zero, then stores both material and requests.

Implement heat, phases, reactions, ignition, fuel, smothering, sparks and existing element mechanisms.
Reuse current element/reaction/electricity content. Do not invoke the legacy react pass.
Thermal gas density belongs here or in the shared motion helper, not in a second incompatible material table.

## Dynamics requests

The request buffer has one word per slot:

- Bit 0: detonate the explosive currently at this slot.
- Bit 1: phase change or burning added gas at this slot.
- Bit 2: request neutron emission from this slot.
- Remaining bits are reserved until a tested producer/consumer pair needs them.

Detonation detection does not consume the source material.
The dynamics consumer applies shielding, impulse, products and source consumption.
Failed capacity allocation leaves the source unchanged and busy for deterministic retry.
Consumers clear requests only after accounting for them.
Gas requests are source terms for the air model, not permission to inject unbounded pressure.
Do not reuse the liquid scratch as an event buffer across unrelated ownership partitions.

## Dynamics module

Ownership: `src/v2/dynamics.js`, `src/shaders/v2/{particles,air,blasts}.js` and dedicated tests.

Provide a `NativeDynamics` class constructed with the `PhysicsV2` owner:

```
ready
advanceParticles(tick)
consumeMaterialEvents(tick)
advanceAir(tick)
applyToolImpulse(request)
snapshotDynamicState()
restoreDynamicState(snapshot)
dispose()
```

All recording methods use the owner's current GPU frame. They do not submit or wait.
Snapshot methods may perform explicit readback at persistence boundaries.
Actual active particles and air must prevent a false idle certificate.

Use 48-byte particle records at the fixed 64K cap:

```
position.xyz, stable ID
velocity.xyz, core.word0
core.word1, core.word2, core.word3, bank
```

ID zero denotes an unused record. Do not lose material fields during flight.
Use deterministic claims, swept collision, conservative deposition and capacity fallback.
Air uses brick-sized cells with explicit stable fixed-step coefficients and conservative face exchange.
Blasts use line-of-sight shielding. Liquid impacts cannot destroy solids.

## Liquid scratch

Each source snapshot contains:

1. Limiter u16, remainder/face tag u8, source material ctype u8.
2. Source ID u8, source temperature u16, low byte of source payload.
3. Source fill u24, high byte of source payload.
4. Source signed energy bank.

Flux updates only face fluxes.
Limit initializes snapshots before gather.
Gather reads immutable snapshots and fluxes, then updates only destination material fields.
It must not overwrite flux words that neighboring invocations still read.
If foam moves, snapshot foam after material gather and use a separate gather.
Do not introduce concurrent reads and writes of neighboring foam.

## Driver order

1. Import explicit external writes.
2. Build awake lists.
3. Advance existing particles.
4. Move columns and blocks, including contact rules.
5. Consume material requests.
6. Advance liquid substeps.
7. Advance air and account for sources.
8. Publish dirty signals and idle state.

Integration must connect actual methods before advertising capabilities.
World shifts, save/network snapshots and native tools include core, bank and dynamic state.
Weather runs once per native tick when world support is enabled.

## Validation and coordination

Each lane adds CPU reference/packing tests and CPU Naga/binding-budget checks.
The target permits eight storage buffers per shader stage. Use family-specific layouts.
Only the parent launches GPU validation.
The total GPU occupancy limit is 10 seconds, including startup, compilation and cleanup.
Do not lower quality, shrink established fixtures, bypass the guard or silently retry.
