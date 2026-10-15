# Native contact rules

This lane implements R5–R8/R11 and material-side event detection in disjoint
2×2×2 blocks. It does **not** call the legacy react pass or project through A/B.
The foundation, dynamics, world/topology and renderer remain separate owners.

## Integration ABI

`src/shaders/v2/contact.js` exports `contactWGSL`, containing:

```wgsl
contactBlock(
  cores: ptr<function, array<vec4u, 8>>,
  banks: ptr<function, array<i32, 8>>,
  positions: array<vec3i, 8>,
  requests: ptr<function, array<u32, 8>>
)
contactDensity(core: vec4u) -> f32
contactBoundary(material: Material, openFaces: u32, ambientQ: u32,
                position: vec3i) -> Material
```

Required foundation declarations: `Material`, `P.tick`, `inGrid`, `markBusy`,
`energyOf`, `withEnergy`, `energyFits`, `energyAdd/Sub/Signed/Mul`,
`lifeOf/withLife/payloadOf`, `slotOf`, the phase helpers below, and
`noteEnergySource/Sink(position, vec2u)`. Contact group 2 also binds the existing
`liquidScratch` at binding 5; no buffer is added. The largest native layout
(`v2externalEvents`) uses eight storage buffers.

- Positions are local grid positions used by `inGrid` and activity reporting.
  Topology must resolve periodic neighbors before passing their positions.
- Preload pending requests **after** material motion. Contact ORs new requests;
  it does not clear old ones. DETONATE/NEUTRON sources retain their identity
  while their allocation/consumption is pending. Thermal exchange still conserves
  their energy. Movement must carry requests with their material.
- Out-of-grid slots are completely excluded from pair, neighbor, self, plume,
  activity and ledger operations. Sentinel WALL at raw Tq=0 is **not** a thermal
  reservoir. Real in-grid WALL retains its normal conductivity.
- The foundation calls `contactBoundary` only for actual open side/top faces,
  with its topology/ambient-heat settings. Closed sides, periodic seams and the
  floor must not silently exchange with an ambient reservoir.
- Motion must use `contactDensity`, or an equivalent shared ideal-gas rule,
  and own gas diffusion age. Contact owns FIRE/SMOKE/PLASMA life; the old prototype
  fade for STEAM/CAUSTIC_GAS must not run.

CPU `contactReference(cores, banks, tick, positions, pending, valid, outside)`
accepts optional eight-entry valid and outside-count arrays. Each outside entry
is `[air, oxygen, CO2, gas]` for the three non-owned faces, frozen before **any**
block runs; standalone patches default to closed outside (all zero). It returns
updated material, requests, busy indices and exact BigInt `sources`/`sinks`.
`ctStep(input, ns, seed)` retains its three-argument closed-outside behavior,
delegating to `ctStepAtmosphere(input, ns, seed, outAir, outOxygen, outCo2, outGas)`.

Support freezes those counters in `liquidScratch.x` low eight bits (four two-bit
counts), preserving its upper 24 bits. Its 64 invocations cover exactly R5's
eight shifted cubes, **including the one-cell halo outside the awake brick**,
not simply the brick's own cells. Gravity only permutes cube corners; periodic
wrapping preserves disjoint ownership. Core reads happen only in Support;
R5 reads the frozen counters plus its three local partners. Full exposure,
CO2 fraction and combustion oxygen ratio/ceiling use all six faces. Heat,
reactions, plume, phase and sampled cloud/growth contacts still use owned faces.
Out-of-grid faces retain `cellAt`'s WALL sentinel even at open outflow edges.

R5 can return before motion/contact only for a proven zero-work block: all eight
resolved positions are in-grid, all cores are exactly `vec4u(rawTq << 8, 0, 0, 0)`
with the same normal `rawTq <= 41093`, and every bank and pending request is zero.
This excludes opaque history, high flags, life, velocity, latent codes and heat
gradients; it is **not** a generic all-AIR skip. Open edges with ambient heat also
require equality with the boundary wrapper's identical f32 round/clamp ambient
encoding (even for interior blocks). Closed/periodic edges and disabled ambient
heat need no ambient equality. Uniform AIR cannot topple, swap density or age,
and production contact/boundary emit no changes, requests, busy marks or energy
ledgers; equal material stores only rewrite identical values, preserving existing
legacy/dirty marks. The specialization is emitted only for the exact production
`contactWGSL` string: custom injections and the side-effectful ABI probe retain
full execution. Support still snapshots every target, including AIR halo cells
that other material may occupy after motion. `tools/v2/block-air-zero-check.mjs`
checks all 41,094 normal temperature codes against full production contacts.

The low byte is transient: no liquid consumer runs between Support and Limit.
Limit fully rewrites each active cell's scratch for **both** liquid and nonliquid
before jets/gather. Sleeping halo cells can retain transient low bits, but
jets/gather reject sleeping faces before consuming limiter bits. There is no
ACT resize, dispatch-argument change, persistent-state or save-format change.

### Dynamics-only helpers

`specialContactWGSL` is a small standalone declaration string, without the
contact kernel or its bindings. It exports:

- `contactNuclearMaterial(core) -> u32`: LAVA retains its fissile source ctype,
  matching legacy `rays.matOf`; use this for neutron cross sections as well as
  spontaneous emissions.
- `contactVacuum(core) -> f32`: SING mass is raw life/256; target pressure is
  `max(PHYS.P_MIN, -PHYS.SING_P_PER_MASS * mass)` = max(-50, -2.5·mass).
  The air owner applies the existing 0.6 neighboring-open-cell ring and shielding.
- `contactSpecialExplosion(core, gunpowderEnergyJ) -> vec4f`: energy J, product ID,
  product Celsius temperature, product ctype. Recognize DUST/SING by ID, **not**
  positive energy: a zero-mass singularity has a valid zero-energy retirement.

JS equivalents are `contactNuclearMaterial`, `contactVacuum`, and
`specialExplosion(core, gunpowderEnergyJ)` (null for other IDs).

DUST and SING have no `element.blast` row. Their budget is calibrated to existing
GUNPOWDER pressure, not an invented TNT charge:

```
E(P) = gunpowderEnergyJ * (min(P, PHYS.P_MAX) / gunpowder.blast.P)^2
```

This follows the dynamics acoustic compression energy proportional to p².
With the current 121,500 J gunpowder cell and reference pressure 60:

| Source | Pressure | Energy | Product |
| --- | --- | --- | --- |
| Suspended DUST | 30 | 30,375 J | FIRE, max(source T, 1700°C) |
| Positive-mass SING | min(mass, 200) | capped 1,350,000 J | FIRE, 3000°C |
| Zero-mass SING | 0 | 0 | EMPTY, source carrier T |

Starved positive mass below one produces less than 33.75 J, not a full charge.
Dynamics must budget hot products, shielding, impulses, source consumption and
capacity retry; a descriptor is not permission to create unaccounted heat.

## State and exact energy

The authoritative foundation capacity is
`FULL + materialAmount * round(element.cap * 64)` (minimum coefficient one).
The permanent `FULL=65536` carrier remains when liquid leaves a slot. Total
enthalpy is signed 64-bit; the auxiliary bank is signed i32.

`phase.js` / `shaders/v2/phase.js` supply formation offsets and exact tagged
latent progress, without depending on the contact kernel:

- normal temperature codes: 0…41093 (through 10,000°C);
- HOT progress: 41094…53314;
- COLD progress: 53315…65535;
- 12,220 progress intervals, with the **exact remainder** in the bank.

`phaseTemperatureQ` / `phaseTq` return actual temperature. `phaseLatentEnergy`
returns signed wide latent energy. `encodePhaseEnergy` / `phaseEncode` encode
without f32 energy arithmetic or discarding excess. Invalid material/temperature
or phase tags must be rejected by load/migration validation.

**Lava offsets are source-specific.** JS
`phaseOffsetEnergy(id, amount, ctype=0)` (also `phaseMaterialOffsetEnergy`) and WGSL
`phaseMaterialOffsetEnergy(id, amount, ctype)` are the material-energy accessors.
For LAVA:

```
offsetPerQuantum = sourceOffset + (sourceCapacity - lavaCapacity) * sourceMeltQ
```

Thus iron, gold and glass do not jump temperature at melting merely because
LAVA has another heat capacity. Solidification uses that source's melting point
minus the existing 150°C hysteresis, conserving enthalpy. `meltInto` remains the
content-selected solid product. Ctype zero retains the historical STONE default;
other lava source types must name an existing meltable element.

Foundation `energyOf`, `withEnergy`, `energyFits`, advection energy bounds and
parcel arithmetic must use the **type-aware** offset, including lava ctype.
Id-only offsets are insufficient. Mixing incompatible lava subtypes must not
silently relabel their formation energy.

When a selected phase product cannot hold all energy by itself, contact tries
an unchanged in-block neighbor as a conservative heat reservoir. This is needed
for ACID's CAUSTIC_GAS branch. If no pair fits, source and bank remain intact for
retry; no gas request is emitted before conversion succeeds.

### Fuel, devices and burning

- Fuel/life is an extensive integer at foundation `FUEL_Q=2048`. Compressed
  liquid fuel scales with fill; sixteen full cells fit the u16 payload.
- Switch/PCLN logical life 10 is raw 20480; TSNS logical life 1 is raw 2048.
  The kernel calls the foundation logical life getters/setters.
- Singularity mass alone uses scale 256 (mass 200 fits raw 51200).
- Nonliquid burning is **word1 bit24**, never the fall/diffusion age byte.
- Combustible liquid burning uses ctype bit7. Shared getters/projectors mask it
  only for combustible liquids. Foam and face fluxes are preserved.
- Conductive liquids are identified by `elec > 0`, not just `e.conducts`:
  fresh WATER explicitly has `conducts:false, elec:0.05` in legacy content.
  Spark codes through 3608 and reserved device bits survive packing.
- Conductive + fuel/life liquid payload collisions are rejected.

## Conservation and declared open-system paths

Every CPU block checks the accounting identity:

```
H_after + sinks - sources = H_before
```

Closed transfers: conduction, thermal phase changes/latent cycling, magma
changes, cloud coalescence, acid dissolution and singularity swallowing.
Chemical pairs add/subtract their declared reaction energy; released energy is
bounded by product flame temperature, not an unbounded legacy temperature kick.
`energyFits` failure leaves the original pair intact.

Explicit sources/sinks, not hidden clamps:

- finite fuel heat, Joule heat, and the fuse's terminal powder heat;
- plume formation/heating paid for by finite fuel at the content
  `burnHeat/burnRate` ratio; terminal vaporization can also cool the donor fuel
  through a conservative local transfer, never below its zero-K sensible bound;
- FIRE→SMOKE, smoke/plasma removal, cloud-edge evaporation, VOID, and escaped
  burnout material remove their material enthalpy while retaining actual carrier
  temperature and residual. A trace fuel parcel cannot create a larger residue
  with free heat;
- Noita/TPT biological growth/rot and cloning are explicit game material
  conversions/sources at actual source/spawn temperature. They do not use the
  thermal-phase conservation exemption to hide a failed phase or pair reaction.

Smothered fuel spends no fuel and emits no plume. FIRE requires oxygenated
exposure; CO2 extinguishes it. Durable STEAM, CAUSTIC_GAS and CO2 never disappear
through an arbitrary prototype lifetime.

Heat uses harmonic conductivity and pairwise integer transfers. The sensible
bank remainder participates in the sub-quarter temperature gradient; tagged
latent energy does not. Ignoring that distinction produced a two-tick heat
limit cycle. With the corrected rule the checked closed metal block sleeps
at tick 53, conserves every energy unit, and stays quiet for a full offset cycle.
A stochastic reaction/growth/source remains busy only while it has an eligible
future action; static latent banks and steady DC lamps can sleep.

## Dispatch coverage, not just an element checklist

`contact-check.mjs` executes the following current content paths:

| Content/mechanism | Implementation and witness |
| --- | --- |
| All 91 materials | every material pair's heat conservation; payload round trips |
| 47 hot/cold weighted product paths | actual transition or conservative overflow-reservoir conversion |
| 26 melt rows, LAVA identity | every melt; iron/glass/gold heating–cooling–remelting cycles |
| All 14 reaction rows, wildcard exclusions | actual products, temperature gates, energy/caps |
| All 13 ordinary fuels | actual burn or low-flash ignition; extensive fuel; finite plume debit; burnout |
| FIRE, SMOKE, PLASMA | finite life, hot plume, carrier/residual-preserving sink |
| WATER/PLANT, MOSS, FUNGUS/rots rows | actual growth/rot witnesses, damp propagation/drying, explicit ledger |
| CLOUD | boiling/freezing, rain, evaporation, falling-snow charge; stationary snow does not charge |
| ACID, CAUSTIC_GAS | generic acidic pair dispatch, victim eligibility, finite acid life, fizz |
| CLONE/PCLN | memory sampling, actual emission, powered on/off control |
| All 15 conductors | full spark codes, crossing costs, all diode/switch direction pairs |
| BATTERY, PSCN/NSCN, SWITCH, TSNS, LAMP | real source/control/sensor/hold/DC behavior and rest |
| FUSE | air-independent countdown, handoff, terminal heat/product |
| DUST | suspension-age threshold, concentration/exposure, source-preserving request |
| SINGULARITY | swallow/merge/evaporation, full/starved request, calibrated descriptor and vacuum target |
| PLUTONIUM and its LAVA | actual stochastic neutron request; URANIUM does not invent a spontaneous rate |
| VOID | material removal with accounted enthalpy |
| WALL_TORCH/EMBER | existing fixed visual emitters, not missing legacy fire state machines |

Pressure/shock explosive triggers, blast execution/products, singularity vacuum
execution, neutron transport/moderation/fission/capture, storm discharge, and
breaking by impact/pressure belong to dynamics/world. They must consume the
provided requests/material identity/targets before overall parity is claimed.
There are no current `element.crush` rows; this lane does not advertise a new
untested pressure-transition schema.

Weighted composition changes and fractional/compressed liquid-to-nonliquid
conversions still select a cell-sized content product. They conserve the defined
enthalpy but do not promise an unchanged product temperature or a continuum
stoichiometric mass model. This is not an excuse to drop bank energy.

## Validation

CPU only; no GPU or browser was launched in this lane:

```
node tools/v2/contact-kernel.mjs --write   # after changing scalar kernels
node tools/v2/contact-kernel.mjs           # stale-artifact check
node tools/v2/contact-check.mjs
node tools/v2/contact-build-check.mjs
```

The first check currently has 31 passing groups, including 250 mixed-block
source/sink property cases, all phase products, edge valid-mask conservation,
requests, and finite thermal rest. Naga validates both an explicit shared ABI
fixture and the actual foundation `v2BlockWGSL` with contact installed.
The build check minifies a Vite library and verifies byte-identical WGSL plus
Naga validity. Runtime never depends on `Function.toString()` surviving a
minifier: scalar WGSL is a checked generated artifact.

Also checked: foundation's 1534 conservative advection cases and 10000 wide
products, save round trips, production build and shader binding budgets.
These are CPU/integration evidence, **not** runtime GPU, visual, performance or
live-site acceptance. Parent integration owns those gates and deployment.
