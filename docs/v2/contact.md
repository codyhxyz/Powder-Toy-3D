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
- The foundation calls `contactBoundary` only for actual faces past a void edge
  (sides, top and floor: V1 react.js reads every face beyond the grid as still air
  at ambient there, `VOID_AIR_A`), with its ambient-heat setting. Closed sides and
  periodic seams must not silently exchange with an ambient reservoir.
- Motion must use `contactDensity`, or an equivalent shared ideal-gas rule,
  and own gas diffusion age. Contact owns FIRE/SMOKE life; PLASMA has no life rule
  (V1 react.js: it leaves only by cooling past its 4700 °C cold change), and the old
  prototype fade for STEAM/CAUSTIC_GAS/PLASMA must not run.

CPU `contactReference(cores, banks, tick, positions, pending, valid, outside)`
accepts optional eight-entry valid and outside-count arrays. Each outside entry
is `[air, oxygen, CO2, gas, clones, word]` for the three non-owned faces, frozen
before **any** block runs (`word`: `contactOutsideWord`, below); standalone patches
default to closed outside (all zero). It returns updated material, requests, busy
indices and exact BigInt `sources`/`sinks`. `ctStep(input, ns, seed)` retains its
three-argument closed-outside behavior, delegating to
`ctStepAtmosphere(input, ns, seed, outAir, outOxygen, outCo2, outGas, onFloor,
ambientQ, touch, outClones, outFaces)`. Its `ns` are the three partners in axis
order (x, y, z): `contactBlock` places each by where it lies, since the block's
corner order rotates with gravity (`mBlockOffset`).

**The outside word** (`outFaces`, `CT_OUT_*`) is the rest of what V1 react.js reads
on all six faces that the three partners don't show a cell: counts (0–3) of
in-grid non-gas faces (V1's surface to condense onto), flames (V1 `nFire`: FIRE
cells only), air (`nAir`), cloud (`nCloud`) and dust (the dust cloud's `nFuel`);
the dampest face's damp for a grower (V1 `dampOf`); and an axis bit each for damp
moss and moss bed (V1 `mossSite`). Out-of-grid faces count as none. `CT_OUT_UP`
is the block's, not Support's: 1 + the index of the partner upstream along
gravity (the block's corner bit 2, `mBlockOffset`), for snow falling onto a cloud.
`contactOutsideWord(faces)` is the CPU twin; `outsideFacesWGSL` (`ctOutsideFace`)
is Support's and the flying packets' WGSL, checked equal to it over every element.

Support freezes the counters in `liquidScratch.x` low ten bits (four two-bit
counts and the clone count), preserving its upper bits, and writes the outside word
whole in `liquidScratch.y`: no consumer reads `.y` between Support and the block
pass, and the runs rebuild their records (and radial demand words) from the cells
after it. Its 64 invocations cover exactly R5's
eight shifted cubes, **including the one-cell halo outside the awake brick**,
not simply the brick's own cells. Gravity only permutes cube corners; periodic
wrapping preserves disjoint ownership. Core reads happen only in Support;
R5 reads the frozen counters plus its three local partners. Full exposure,
CO2 fraction and combustion oxygen ratio/ceiling use all six faces. Heat,
reactions, plume, phase and sampled cloud/growth contacts still use owned faces.
Out-of-grid faces retain `cellAt`'s WALL sentinel even at open outflow edges.

One proven zero-work domain lets R5 return before motion/contact: all eight
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

A separate exact-production-only identity covers **eight full WATER cells at
20°C**: every resolved position is valid, core word 0 is exactly
`(1173 << 8) | WATER` (no aeration), word 1 is exactly `65536` (zero ctype),
word 3's upper half is zero (no life/voltage), and all banks/requests are zero.
`P.ambient` must be exactly `20.0`, even with closed edges or ambient heat off.
All 48 packed flux bits (word 2 and word 3's low half) are allowed and preserved
verbatim. Uniform WATER cannot topple, exchange equal density, age as gas, or
activate contact/boundary rules in this narrow state. Mixed AIR/WATER blocks,
other temperatures, partial fills and other payloads still execute every rule.
Support snapshots and the later liquid passes are **not** skipped.
`tools/v2/block-water-zero-check.mjs` executes the emitted predicate and real
production contacts/boundaries, checks mechanical/store guards and pins the
WATER rule rows. It is a CPU identity proof, not a full native-block interpreter,
GPU replay or performance measurement.

The low byte is transient: no liquid consumer runs between Support and Limit.
Limit fully rewrites each active cell's scratch for **both** liquid and nonliquid
before jets/gather. Sleeping halo cells can retain transient low bits, but
jets/gather reject sleeping faces before consuming limiter bits. There is no
ACT resize, persistent-state or save-format change.

R13 transport separately preserves fractional stored f16 weights through limiting,
truncating only after scaling. Limiter sums and canonical gather/jet packets use
one exact accepted-amount helper with the existing K/tag layout. This is numerical
transport calibration, not a contact-kernel change or a byte-equivalent transport
optimization. Canonical admission also rejects a packet exceeding one sixth of
frozen destination headroom before any debit; rejected mass, heat and fuel remain
at the source. See `docs/v2.md` §4.1 for scope.
Original native U-tube, partial-pool, still-tank and yield gates pass at `064728ef`.
The U-tube margin is narrow: 0.9992980957 cm against the unchanged 1 cm limit.

### Production block compaction

With the **exact** production `contactWGSL`, the driver now records:

1. Unchanged Support over **all original targets**, including identity blocks.
2. Clear only the 16-byte scratch-tail counter header (ending the compute pass).
3. Small classifier, indirectly dispatched from original args words 6–8, using
   the exact AIR/WATER predicates above. Nonidentity blocks append their original
   `t = 64 * foldId + li`, not material-sorted or staged cells.
4. Direct one-thread finalizer, binding only scratch and args, writing folded
   survivor dispatch to existing args words 9–11 (byte **36**). Zero survivors
   produce `[0,1,1]`. No new indirect buffer or argument copy is needed.
5. Heavy block kernel indirectly dispatched at byte 36, recovering
   `e = t / 8`, `j = t % 8`; original coordinates, corner order, RNG, motion,
   production contact, boundary and final material/request stores are unchanged.

Only one heavy variant compiles per instance. The reference emitter's default
and custom/nonproduction WGSL keep their original emission and dispatch; they
never enter production classification. There are no new user/debug controls.

The original liquid scratch is exactly `slots * 16` bytes, with **no spare
space**. Production extends it by a dedicated 16-byte counter header plus
`8 * nbricks = slots / 8` original `u32` IDs: **1,048,592 extra bytes at 128³**.
Allocation checks safe integer/u32 indexing, alignment, max buffer size and max
storage binding size before allocating.
If the tail exceeds a device limit, the driver retains the original scratch and
block dispatch. This keeps otherwise supported native grids available.
The classifier uses an atomic-word view
for independent append writes; heavy reads the same tail normally. Only the
header is cleared per partition; cell-indexed support atmosphere is untouched.
Liquid layouts gain no bindings (still at most eight storage buffers including
the shared table). The classifier never writable-binds its indirect args.

Unordered append is safe **only for this production contract**: resolved 2³
blocks own disjoint cells (including periodic wrapping), outside occupancy and
atmosphere are frozen before classification, pair operations remain block-local,
and shared effects are idempotent activity/dirty marks and commuting integer
ledger additions. Original closed/open excluded boundary stripes remain excluded.
No pack/reload, material sorting, flux interpretation, ownership/capture or jets
allocation/preparation ordering changes are involved. Future contact changes
must re-prove these assumptions; arbitrary custom contact need not satisfy them.

`node tools/v2/block-compact-check.mjs` checks emitted predicate equivalence,
41,094 AIR/896 WATER cases and strict negatives, 168 offset/edge/gravity geometry
cases, shuffled full-contact plus emitted-motion replay (including SMOKE through
tick 48), partial wake and zero/full/fold/tail bounds, real driver order and
bindings, minification, grouping and CPU Naga validation. Existing AIR/WATER
checks retain the exact store/visibility identity proofs. The replay compares
cores, banks, pending requests, opaque words, activity and energy ledgers; its
changed-core visibility marks are conservative CPU checks, not a renderer oracle.
The real benchmark fixture's **initial CPU import only** is 73.231–82.636%
identity-eligible across eight offsets (first offset: 26,131 AIR, 28,380 WATER,
18,193 survivors). These are not evolved/native GPU coverage or performance
measurements. The native 16³ census at `87aa3328` passes 120 ticks and 20 checks:
zero water, sand or wall drift. Both new pipelines compiled and ran.
Total GPU occupancy was 10.721 s (`/tmp/v2-native-census-87aa3328.jsonl`).
Dense nonidentity scenes may regress from the extra scan/dispatch.
The clean two-frame split at `60fa5165` measures contact kernels at 4.744 ms
including classification and finalization, versus 10.739 ms before compaction.
Fixture, quality and tick windows match. Total occupancy is 3.438 s.
At tick 5, the heavy list has 38,166 of 96,512 blocks.
Full-frame medians from one clean 12-frame pair at `60fa5165` are native 131.5 ms and
v1 145.5 ms. This is not a repeatability or equivalent-work claim.
The original flame-to-wood gate passes 6/6 after the separate R8 addition at `9e027c71`.
This is not an ignition effect of compaction. The hole-jet gate remains failed; see `completion.md`.

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

Ignition is V1's (react.js combustion), **thermal only**, re-tested every tick: a
fuel burns while it is at its ignition point, or past its flash point with a flame
(a FIRE cell, `nFire`) on one of its six faces, touching air, oxygen or a flame,
and not smothered (CO₂ at 30% of its gas). Cooling it under its ignition point
(water, ice, a cold heat sink, LN₂) or taking its air puts it out; the `burning`
flag says it burned this tick. There is no contact ignition: no random
`fire/60` flame-touch chance, no deterministic "hot front" from a burning
neighbour, and a burning fuel is no flame to its neighbours (V1's `nFire` counts
FIRE). Heat reaches a fuel by conduction and flames lick into the air beside a
burning one (`ctLick`), as in V1. An explosive's flame roll is `blast.flame` a
step, the tick's four steps, when any of its six faces holds a flame.

*Decision record (2026-10-21, V2 finish push):* the hot front (added at
`9e027c71` to pass the six-bay `flameWood` GPU gate) and the `fire/60` chance were
an agent's design additions; no record of the user approving them was found in
docs, code or history. The finish push matches V1 wherever no user approval is
recorded, so both are gone.

Burning adds V1's `BURN_P` a step to its cell, the tick's as its GAS request's puff
(`CT_BURN_PUFF_PA`), its burnout step too. Matter becoming gas adds no pressure of
its own: only a rule's puff does (a reaction's, a phase change's, acid eating
something that fizzes: `ctAcidFizz`, `puffP(FIZZ)`), as in V1.

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
- FIRE→SMOKE, smoke removal, cloud-edge evaporation, VOID, and escaped
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
| FIRE, SMOKE, PLASMA | FIRE/SMOKE finite life, carrier/residual-preserving sink; PLASMA lasts while hot |
| WATER/PLANT, MOSS, FUNGUS/rots rows | actual growth/rot witnesses, six-face damp and moss site, drying, explicit ledger |
| CLOUD | boiling/freezing, six-face rain and evaporation, charge from snow falling onto it (grid and flying) |
| ACID, CAUSTIC_GAS | generic acidic pair dispatch, victim eligibility, finite acid life, fizz |
| CLONE/PCLN | memory sampling, actual emission, powered on/off control |
| All 15 conductors | full spark codes, crossing costs, all diode/switch direction pairs |
| BATTERY, PSCN/NSCN, SWITCH, TSNS, LAMP | real source/control/sensor/hold/DC behavior and rest |
| FUSE | air-independent countdown, handoff, terminal heat/product |
| DUST | suspension speed (V1 `DUST_LIFT_V`), six-face dust and air faces, source-preserving request |
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
node tools/v2/contact-hot-ignition-check.mjs
node tools/v2/contact-build-check.mjs
```

The first check currently has 31 passing groups, including 250 mixed-block
source/sink property cases, all phase products, edge valid-mask conservation,
requests, and finite thermal rest. Naga validates both an explicit shared ABI
fixture and the actual foundation `v2BlockWGSL` with contact installed.
The hot-ignition check covers V1's thermal-only ignition: no flame-touch or
hot-front ignition from any source (partner, outside, flying), ignition-point and
flash-point boundaries, burning re-tested (cooling and smothering put it out),
explosives' per-tick flame roll, finite fuel and the burning puff, exact ledgers,
shuffled disjoint-block replay, custom contacts and AIR/WATER identities.
`contact-rates-check` pins V1's per-step rates (clone, plant, fungus, six-face
moss, acid, six-face cloud, reaction pairings, singularity evaporation, storm
charge, burning puff, explosive flame roll); `contact-atmosphere-check` the outside
word (six-face damp at every block offset, dust faces, puffs, the void floor, and
the emitted `ctOutsideFace` against `contactOutsideWord`).
The build check minifies a Vite library and verifies byte-identical WGSL plus
Naga validity. Runtime never depends on `Function.toString()` surviving a
minifier: scalar WGSL is a checked generated artifact.

Also checked: foundation's 1534 conservative advection cases and 10000 wide
products, save round trips, production build and shader binding budgets.
These are CPU/integration evidence, **not** runtime GPU, visual, performance or
live-site acceptance. Parent integration owns those gates and deployment.
