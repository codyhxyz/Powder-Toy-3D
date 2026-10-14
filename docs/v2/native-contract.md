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
The foundation defines integer energy helpers in `layout.js` and `state.js`.
Conduction and advection conserve that defined integer energy.

`FULL` is 65,536 fill quanta. Each slot retains an air carrier capacity of `FULL`.
Material capacity per amount quantum is `max(1, round(element.cap * 64))`.
Total capacity is the carrier plus material capacity times amount.
Amount is the liquid fill, `FULL` for other matter, and zero for empty air.
This additive definition preserves uniform temperature when liquid enters or leaves a slot.
CPU energy uses `BigInt`; WGSL uses signed two-limb integer energy.
One legacy `cap · °C` corresponds to `FULL * 64 * 4` energy quanta.

### Latent progress

The supported normal temperature maximum remains `PHYS.CELL_TEMP_MAX`, 10,000 °C.
Normal temperature codes end at 41,093.
Codes 41,094–53,314 encode hot-phase progress; 53,315–65,535 encode cold-phase progress.
Each interval contains 12,221 codes, or 12,220 progress intervals.
During a phase change, the displayed temperature comes from the material's phase threshold.
The bank retains the exact residual between progress codes.

`cTq` and renderer projection must decode phase tags. Raw temperature bits are not a temperature.
Total energy includes phase offsets and latent progress, not only sensible heat and the bank.
The phase module supplies pure JS/WGSL helpers; it does not depend on contact execution.
Reject invalid phase tags during loading. Migrate old layouts explicitly.
Unrepresentable transfers must remain at their source or be accounted for elsewhere.
Do not wrap or discard an energy residual.

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
Particle positions use world-cell coordinates; velocities use metres per second.
Window shifts leave those world positions unchanged and reindex local air and claim data.
Particle-only tags 254 and 255 identify photons and neutrons, respectively.
They must not enter the grid as ordinary element IDs.

The dynamics family consumes a three-buffer native adapter at group 0:
core, bank and activity. Family-specific group 1 has at most five storage buffers.
The existing header occupies group 3 binding 0; dynamics parameters occupy binding 1.
The adapter supplies material accessors, integer energy operations and dirty/activity reporting.

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

### Legacy edit intent (CPU-checked)

`H.capture=1` records sticky coordinate ownership for every changed retained-v1
write, including changed-away-and-back. `capture=2` is active-native editing:
only element changes automatically replace material. Eligible brush replacement,
erase, TYPE, successful Mix, stamp voxels/footings, generation, script SPAWN/TYPE,
transfer and construction branches explicitly call `ownLegacy`. Generic
`writeCell` does **not** claim unchanged/rejected dispatch-box cells.

Native edits export `compactProbeA` so hidden fractional liquids participate in
material filters and property predicates. The compatibility cache tracks this
physical edit projection separately from visual `compactA`; mode transitions
refresh the entire projection with capture disabled. Legacy snapshots/readback,
v1 suspension and forced compatibility rendering request the visual projection.
Native authoritative snapshots are unchanged.

Unowned property edits merge only differing temperature/life/ctype in marked
bricks. Temperature adds sensible energy using native capacity and phase helpers;
unchanged mass, residual energy, fuel, burn bits and conductor unions are not
reset by unrelated property, pressure or momentum writes. Explicit replacement
retains the full import/reset semantics. Momentum/air forcing is a separate API.

`node tools/v2/edit-intent-check.mjs` executes production brush/stamp/partial-import
branch bodies with CPU adapters and spies on the real export cache protocol.
It is CPU evidence, not WebGPU execution evidence.

Flood fill opts into `readStateAAsync({physical:true})` (also supported by
`readState`/`readCell`); default readback stays visual. Physical probe bindings
and `readHeader({physical:true})` ignore renderer-only `forceCompatibility`,
retaining canonical core and current native air. CPU regressions cover hidden
WATER seed/connected-region classification and both cache/probe modes.
