# Elements: what to add from The Powder Toy, and in what order

The Powder Toy (TPT) shows 175 elements in 11 menu groups (from its source, `src/simulation/elements/*.cpp`, read
2026-10-10), plus separate Walls, Tools and Life menus. We had about 21 of them on 2026-10-10, plus our own Ash, Cloud,
Crystal, Sandstone and Limestone. This page ranks the rest, says how each one gets built, and tracks the fan-out that is
building them.

Physics comes first, as everywhere in this project. Where TPT bends physics for fun, we use the real behaviour (see
[Where we differ from TPT](#where-we-differ-from-tpt)) and cite the source in the element's comment, as the rocks do.

## Element ids are not scarce

Element ids must hold at least 256 elements everywhere: there are about 100 on this page alone. Audited
2026-10-10 (`el-core`):
- The live state stores the id and ctype as floats (RGBA32F), so they have no cap. Saves and the off-window world
  store (`world/store.js`) keep those floats; constructions keep ids in Uint8 or Int16 grids, and bake id + 1
  into a float texture.
- The far field's id channel was 8 bits (32 ids), and `shaders/far.js` throws past 32 elements. Branch `farids`
  widens it to 256.
- The shadow map packs tint id × SHADOW_TINT_ID_SCALE + optical depth into a float32. The scale went from 1000
  to 256, so at id 255 the depth keeps 2^−8 (gfx/lighting.js).
- The network stream (`net/codec.js`) sends id and ctype as one byte each: 0–255.
- The dock tiles' CPU twin keeps id and ctype in Uint8 arrays (0–255). Its MELTINTO and BREAKINTO tables were
  Int8 and wrapped at 128; they are Int16 now.
- The parked 16-byte state layout (docs/scaling.md D7) now gives id and ctype 8 bits each.

## Categories, ranked

| # | TPT group | We have | Plan |
| --- | --- | --- | --- |
| 1 | Explosives (20) | Gunpowder, Fire | Batch 1. Pressure, breaking and guns already exist; first person wants charges. |
| 2 | Liquids (20) | Water, Oil, Acid, Lava | Batch 2. Chemistry and phase changes are where real physics shows. |
| 3 | Gases (12) | Steam, Smoke, Cloud | Batch 2. Oxygen, hydrogen, CO₂ and flammable gas are the reactions people try first. |
| 4 | Solids (25) | Wall, Rock, Metal, Glass, Ice, Wood, Plant, Clone, rocks, Crystal | Batch 3. Building and mining materials. |
| 5 | Powders (19) | Sand, Stone, Snow, Ash, debris, Coal | Batches 2 and 4: salt, dust, clay. The rest are byproducts. |
| 6 | Special (16) | Clone, Erase, player, NPC, spawn | Void (batch 3). Portals are a later project. Stickman, Fighter and spawn are covered by first person. |
| 7 | Electronics (20) | Metal | Electricity project. It gates Powered and Sensors. |
| 8 | Radioactive (17) | none | Fast-particle project: photons and neutrons need a layer of their own. |
| 9 | Force (9) | Pressure tool | Later. Accelerator and repeller are cheap; pistons and pipes are hard in 3D. |
| 10 | Powered (10) | none | After electricity. |
| 11 | Sensors (7) | none | After electricity. |
| 12 | Tools | Heat, Cool, Erase, Pressure | Vacuum and wind are cheap brushes. Lightning comes in batch 3. |
| 13 | Walls | Wall | Skip. TPT's walls are a separate coarse layer (fans, e-walls). |
| 14 | Life | none | Skip. It is 2D Game of Life. |

## Shared mechanisms (batch 0, branch `el-core`)

Most of TPT is a few generic rules applied with different numbers. Three shared mechanisms turn most of this page into
rows in `src/elements.js`, read by both `shaders/react.js` and the dock tiles' CPU twin (`ui/tiles/engine.js`). The
shader stops growing per element, which matters because a cold compile already takes 9–13 s. The elements.js header
has the full semantics; in short:

**Phase changes**: TPT's low- and high-temperature transitions, with our latent heat.
```js
cold:  { T, into, of, latent, puff }   // at or below T °C it becomes `into`
hot:   { T, into, of, latent, puff }   // at or above T °C it becomes `into`
crush: { P, into, of }                 // above this air pressure it becomes `into` (TPT's high-pressure transition)
//  into    an element key ('EMPTY' = plain air), or a weighted list: [['STEAM', 0.97], ['SALT', 0.03]]
//  of      when into is 'LAVA': what the melt sets back into (its ctype); omitted = the element itself
//  latent  latent heat in cap·°C per cell (water's L_FUSE is 80); omitted: instant. The cell holds at T while
//          the heat crossing T goes into the change. Where life holds nothing else it banks there (signed,
//          as water's, through react.js latent()). Where life is taken (acid's strength, a fuel) there is no
//          bank: each step the heat crossing T over latent is the chance it changes (react.js latentChance),
//          the same on average, and life is left alone.
//  puff    volumes of gas set free per volume (a pressure puff, as `fizz` does)
```
`melt`/`meltInto` stay as they are for rock and metal (melting into LAVA that remembers what it was). A `hot` change
into LAVA is a melt too: lava sets back at its T, less LAVA_FREEZE_BELOW. An element can't have both. Water, ice,
steam and cloud keep their own code for now.

**Reactions**: Noita's `materials.xml` reaction format, as a table `REACTIONS` next to the elements.
```js
{ a: 'SALT', b: 'WATER', into: ['EMPTY', 'SALTWATER'], chance, minT, maxT, heat, puff }
//  a, b     element keys; b 'EMPTY' is air (hydrogen burning in air); b '*' = any matter (not air, not a
//           itself), less `except: [...]`
//  into     what a and b each become ('SAME' keeps it). Either side may be a weighted list, SAME included:
//           [[['SALTWATER', 0.28], ['SAME', 0.72]], 'SALTWATER']
//  chance   probability per step that a touching pair reacts (at most 1/6: see below)
//  minT, maxT  temperature gate (°C) on the pair's hotter cell: either cell hot enough lights it
//  heat     energy released (+) or absorbed (−), cap·°C, split in proportion to the products' heat
//           capacities, so both warm alike: ΔT = heat / (cap_a' + cap_b')
//  puff     gas set free, half in each cell
```
How a pair agrees: every step each cell's partner is one face neighbour, along axis `frame % 3`, toward + or − by
the parity of its world coordinate plus `(frame / 3) % 2`. Partners are mutual, the pairs tile the grid like the
move pass's Margolus blocks, and both cells evaluate the same predicate on the pass's input state with a random
stream seeded at the pair's base cell. So both cells change in the same step, without a race, and each reacts
with at most one partner: matter is conserved. A pair is partners one step in six, so `chance` is applied as
6·chance per pairing. A reaction takes precedence over anything else the two cells would do that step. The table
is baked into an NE × NE lookup texture (2 bytes per pair), so a reaction costs one texel fetch whatever the
number of rows. Explicit pairs win over `'*'` rows; each pair of elements has one reaction.

**Explosives**: gunpowder's code, generalized. Gunpowder is `blast: { P: 60, T: 2200, flame: 0.7 }`.
```js
blast: { P, T, into, of, flame, air, shock, crushP }
//  P       air pressure added when it goes off (required)
//  T       temperature of what it leaves (required)
//  into    what it leaves (default FIRE); `of` as above
//  set off by its `ignite` temperature, or touching matter (not gas) that hot, plus
//  flame   chance per step that a touching flame sets it off (default 0: only heat does)
//  shock   kinetic energy of a hit that sets it off (the units of `hard`): matter and it closing at speed u,
//          ½·μ·u² with μ the reduced mass (against a solid, the mover's). A neighbour running into it, and it
//          landing on or running into anything, both count; cells of its own element don't. A liquid flowing
//          at FLOW into a wall carries ½·dens·FLOW², one falling h cells about dens·g·h (g = 0.025), so set
//          shock above what it does to itself.
//  crushP  air pressure on it that sets it off (a nearby blast): its own and its open neighbours' (a solid
//          holds none, so it reads theirs)
//  air     true: it goes off only where it touches air (an EMPTY neighbour), by any trigger (propane)
```
The move pass leaves a hit that would set off an explosive as it was (no bounce, no collision), as it does for
breaking, so the react pass sees it. A blast row never takes the ordinary burn path, and a hit or pressure that
sets it off wins over breaking it. (`el-boom`'s fuse keeps its own rule with `&& id != E_FUSE` on react.js's
combustion line, the `else if` after the blast block.)

**Resting.** A cell stays awake (shaders/activity.js inertNear, common.js inertSelf) while a reaction partner beside
it passes the gate, while it is past a phase point or has latent heat banked, and while an explosive touches matter
past its ignition point. A cell whose only partner is below the gate can rest.

`conducts: true` marks electrical conductors (the electricity project defines what it does). Batch rows set it on
metals and saltwater.

`node tools/elements-core-check.mjs` runs test rows of each mechanism through the CPU twin and compiles the GPU
passes with them.

## The fan-out (2026-10-10): shipped

Seven branches (`../tpt-el-<name>` worktrees, from main dfede10) built this page's batches and projects in parallel.
They were merged and deployed in the order below, which set the element ids. Main went from 31 elements to 73.

| Order | Branch | Built | Main |
| --- | --- | --- | --- |
| 1 | `el-elec` | Electricity v1 (docs/electricity.md): spark, battery, P/N silicon, switch, insulator, temperature sensor, powered clone | 2e5ea95 |
| 1 | `el-rays` | Fast particles v1 (docs/particles.md): photon and neutron list, uranium, plutonium | 2e5ea95 |
| 2 | `el-core` | Batch 0: the three mechanisms, gunpowder on `blast`, ids up to 255 everywhere | b103ead |
| 3 | `el-mat` | Batch 3: void, brick, titanium, tungsten, plasma, gold, mercury, diamond; Lightning tool, storms | 728ae84 |
| 4 | `el-chem` | Batch 2: liquid nitrogen, salt, saltwater, CO₂, dry ice, hydrogen, oxygen, caustic gas, lithium | 979791d |
| 5 | `el-fun` | Batch 4: dust, antimatter, singularity, clay, mud, ceramic | 31c458f |
| 6 | `el-boom` | Batch 1: C-4, nitroglycerin, TNT, thermite, propane, fuse; Explosives group | 77f1a16 |

Each batch has a CPU check through the dock tiles' twin (`tools/{chem,boom,mat,fun,elec,rays}-check.mjs`).
`tools/elements-gpu-check.mjs` runs one small Lab scene per batch on the GPU, then loads World. On main 71079bf
(85 elements, with the Noita batch), 11 of its 12 checks passed with no console errors. The one that fails is
liquid nitrogen freezing water, the first follow-up below.

### Follow-ups

- **Liquid nitrogen doesn't freeze a pool.** On the GPU, 1,600 cells of it on a 6,400-cell pool boil off in about
  100 steps, cooling the whole pool from 20 to 11 °C, and no ice forms. The energy is right: its latent heat is
  spent on the water. The rate is not. Liquid nitrogen on water film-boils (the Leidenfrost effect), and the vapour
  layer limits the heat flux to roughly 10⁴–10⁵ W/m². Here it conducts liquid to liquid, so it boils about 100× too
  fast, and the water spreads the cold through the pool before any cell reaches 0 °C. Real liquid nitrogen leaves a
  crust of ice. The fix is a film-boiling limit on the conductance between a cryogen and anything far above its
  boiling point.
- **Reaction heat stacks past real flame temperatures.** Products keep their temperature and then add the
  reaction's ΔT, so a hydrogen–oxygen flame peaks near 5,300 °C. Product temperatures should come from energy.
- **Reactions are capped at 1/6 per step,** so hydrogen–oxygen burns slower than its real flame speed.
- **Storms never start without help,** because air is 20 °C at every height. They need a colder upper atmosphere.
- **Plasma lasts only about 7 steps,** so a bolt may show for a frame or two.
- **Tungsten, titanium and gold glow dim:** the hot-skin glow treats only METAL as a metal.
- **No buoyancy or drag for matter sinking through a liquid,** so nitroglycerin poured into a pool can go off.
- **Dust clouds ignore oxygen and CO₂ beside them.**
- **Not built yet:** shooting a charge (needs a hook in the weapons code); polonium, refraction, and particles for
  multiplayer guests; spark glow on liquids, in GI and in the far field; the rest of the Electronics, Powered and
  Sensors groups (docs/electricity.md).

## Projects

**Electricity.** TPT's electronics are a cellular automaton, which suits the GPU. A spark is a short-lived state on a
conductor cell (TPT's SPRK keeps the conductor in its ctype and counts down its life), and it hops to neighbouring
idle conductors. On top of it:
- sources and logic: battery, P- and N-type silicon, switch, insulated wire, insulator, thermistors, wifi, instant
  conductor;
- effects: Tesla coil, electrode, EMP, Joule heating;
- 10 powered materials: powered clone and void, pump, heat switch, delay, liquid crystal, storage, powered pipe,
  gravity pump;
- 7 sensors: temperature, pressure, detector, velocity, life, linear detector, invisible wall.

v1 is the spark itself, a few sources and gates, a sensor, and a design that the rest slots into.

**Fast particles.** TPT keeps photons, neutrons, electrons and protons in a separate map, so they can share a cell
with matter and fly straight through it. We need the same: a second layer, or a particle list, that moves in straight
lines and interacts with the cells it passes. On top of it:
- photons: reflect off metal, pass through glass and water, heat what absorbs them;
- neutrons and fission: uranium, plutonium, polonium, deuterium, with water as a moderator;
- the rest: electrons, protons, gravitons, isotope-Z, warp, exotic matter, vibranium, filter, quartz, resist, glow,
  and the ray emitters.

v1 is the layer plus photons, neutrons, uranium and plutonium.

**Gravity (not scheduled).** Black hole, white hole, gravity bomb, gravitons. These need a Newtonian gravity field
(TPT solves one on a coarse grid).

**Force (not scheduled).** Accelerator, decelerator and repeller act on the velocity we already store. Pistons, frames
and pipes push or carry rows of cells, which is hard in 3D.

**Transport (not scheduled).** Portals and wifi move matter or charge between far-apart cells. On the GPU that is a
gather or scatter across the whole grid.

## Every element, ranked

The tag says what each needs: **row** = a line in the element table; **phase**, **react**, **blast** = the matching
shared mechanism; anything else names its own code.

1. **C-4** (blast): a solid charge that sticks where you put it.
2. **Liquid nitrogen** (phase): −196 °C; boils into plain air with a pressure puff.
3. **Salt** (react): dissolves into water.
4. **Saltwater** (phase): freezes at −21 °C, and boiling leaves the salt behind.
5. **Thermite** (blast): burns at about 2,500 °C into molten iron.
6. **Nitroglycerin** (blast): a liquid that goes off when jolted.
7. **Propane** (blast): heavier than air, pools in low spots, then goes up all at once.
8. **Hydrogen** (react): with oxygen and a flame, water and a lot of heat.
9. **Oxygen** (react): fire burns hotter and faster in it.
10. **CO₂ and dry ice** (phase): a heavy gas that smothers fire; dry ice sublimates at −78.5 °C.
11. **Void** (own code): deletes what touches it.
12. **TNT** (blast).
13. **Brick** (row): breaks into stone.
14. **Titanium** (row): very hard, high melting point.
15. **Tungsten** (row): melts at 3,422 °C.
16. **Plasma** (row): the hottest gas.
17. **Lightning** (tool): drawn by hand, and later thrown by storm clouds; leaves plasma.
18. **Dust** (blast): a light flammable powder; a cloud of it explodes.
19. **Fuse** (row): a wick that carries its own oxidizer.
20. **Mercury** (row): steel floats on it, gold sinks.
21. **Lithium** (react): in water it gives off hydrogen and heat.
22. **Gold** (row): heavy, acid-proof, conducts.
23. **Antimatter** (react): annihilates what it touches.
24. **Singularity** (own code): sucks in air and eats matter.
25. **Clay** (react): with water it makes mud; fired mud makes ceramic.
26. **Wax** (phase): melts around 60 °C and burns.
27. **Concrete** (row): stands in near-vertical piles and sets.
28. **Base (lye)** (react): neutralizes acid into salt water.
29. **Sponge** (react): soaks up water.
30. **Seed and vine** (react): a seed on wet sand grows a tree with our tree generator.
31. **Virus and soap** (react).
32. **Fireworks** (blast, plus per-cell colour).
33. **Portals** (transport).
34. **Diamond** (row): a clear, unbreakable gem.
35. **Caustic gas** (phase, react): hydrogen chloride, given off by hot acid, eats like acid, and dissolves back into
    water as acid.

**After these, by what they need:**
- Electricity: spark, battery, P- and N-type silicon, insulator, switch, wifi, insulated wire, Tesla coil, thermistors,
  instant conductor, electrode, EMP. Then the powered materials and sensors listed under Projects.
- Fast particles: uranium, neutron, plutonium, photon, polonium, deuterium, electron, proton, isotope-Z, warp, exotic
  matter, vibranium, graviton, filter, quartz, resist, glow, ray emitters.
- Gravity: black hole, white hole, gravity bomb.
- Force: accelerator, decelerator, repeller, vent, vacuum, damage, force emitter, pipe, piston, frame.
- Later chemistry and materials: liquid oxygen, nitrogen ice, diesel, carbonated water, gel, goo, iron and rust,
  platinum, heat conductor, rime, fog, refrigerant, Boyle gas, yeast, freeze powder, silicon, anti-air, shield, bomb,
  destroyer, C-5, cold flame, ignition cord, rubidium.

**Skip:**
- Covered already: stickmen, fighter and spawn points (first person, the NPC and Player spawn do this); None (Erase).
- 2D only: Game of Life, WireWorld, Tron.
- Jokes and internal states: Bizarre, gravity dust, Lolz, Love, embers, dead yeast, and the hidden virus, paste and
  shield forms.

## Where we differ from TPT

- **Liquid nitrogen** boils into air (nitrogen *is* air) with a pressure puff of about 690 volumes. In TPT it just
  vanishes.
- **Saltwater** freezes at the NaCl eutectic, −21.1 °C, and boiling it leaves the salt behind.
- **Lithium** fizzes off hydrogen and heat in water, so any bang comes from the hydrogen. In TPT, lithium itself
  explodes.
- **Propane** is 1.5 times as dense as air, so it pools. TPT's GAS just diffuses. It goes off only beside air or a
  flame (the flame front is where fuel and air mix), and its front crosses a pool at the real propane-air flame speed.
- **Fuse** burns at a real safety fuse's 1 cm/s on the sim's clock (about 4.5 s a cell), with or without air. TPT's
  is much faster.
- **Thermite** lights at ~1,220 °C, so a wood fire won't do it, and leaves molten iron at 2,500 °C holding about the
  reaction's real heat. It eats through wood, glass and stone floors; a cell of metal floor (30 cm of steel) takes a
  pile about 6 cells deep. TPT's holds 3,500 K and goes through anything.
- **C-4, nitroglycerin and TNT** blast in proportion to their detonation pressure (C-4 the most). C-4 going off from
  heat or a hit is a game choice: real C-4 only burns without a detonator.
- **Caustic gas** is hydrogen chloride: denser than air, and it dissolves back into water as acid.
- **Diamond** burns in air above ~780 °C (thermogravimetric onset of oxidation), leaving no ash, but only while
  something keeps it hot: in air the burning doesn't sustain itself. Nothing in the sim can break it. In TPT it is
  indestructible.
- **Brick** breaks into brick rubble (TPT: stone) and melts at ~1,300 °C, the refractoriness of a common red-brick
  clay (TPT: 950 °C, below its own firing temperature).
- **Tungsten** is unbreakable, like titanium: its ~1,000 MPa strength is past anything the sim carries. TPT makes it
  shatter at pressure jumps.
- **Lightning** steers its main channel to the surface under the cursor (or, from a storm, to the nearest point below
  the charged cloud, conductors first) and fuses sand where it lands, as real fulgurites form. TPT's falls along
  gravity.
- **Storms**: cloud charges where snow falls through freezing cloud (non-inductive graupel-ice charging). TPT has no
  storms.
- **Dust** explodes when suspended in air: a flame runs through the cloud, and its blast lifts settled dust for a
  second explosion. A settled heap only smoulders. In TPT, dust is just flammable.
- **Antimatter** makes a blast and heat (E = mc², capped at the engine's limits). TPT's lowers the pressure. Ours is a
  powder that rests on air; TPT's is a sinking gas.
- **Singularity** evaporates when starved (Hawking: faster as it shrinks), bursts when full, and never seeds new
  singularities. TPT's full singularity turns its neighbours into new ones, which can eat a whole save.
- **Mud** (TPT's paste) doesn't harden under pressure: that is cornstarch. A clay slurry thins as it is worked.
  Fired clay sinters into ceramic at ~1000 °C instead of melting.

## Noita materials (branch `nt-mat`)

Noita's materials as simulation elements, appended after the TPT fan-out's rows: blood, toxic sludge, slime, whiskey,
moss, fungus, and six magical liquids (Teleportatium, Levitatium, Healthium, Berserkium, Polymorphine, Pheromone) in a
Potions palette group. Their sources are in each row's comment in `src/elements.js`. What they do to bodies is other
branches' work (`nt-status` stains, `nt-flask` drinking). Two mechanisms came with them:

- **`flash`** (an element field; el-core's combustion has no flash point of its own): the flash point. With a flame touching it, a fuel burns from this temperature, and air
  touching both a flame and a fuel past its flash point catches, so a flame runs across warm whiskey. On its own, a
  fuel lights only at `ignite`. Whiskey at room temperature (20 °C, under its 26 °C flash point) often fails to take a
  small flame, as cold spirit does; warmed, it always takes it.
- **Growers** (`react.js`, `activity.js`; constants in `physics.js`): moss and fungus keep their damp in their ctype.
  It is `DAMP_REACH` (4) beside liquid water, else one less than the dampest moss or fungus beside it, and 0 at or above
  100 °C. Moss creeps into an air cell that touches damp moss and bare rock (ROCK, STONE, LIMESTONE, SANDSTONE) on a
  face across from the moss's axis, so it makes a one-cell mat on the rock and never grows out into open air. Damp
  fungus rots WOOD, SAWDUST and PLANT into fungus. Both are rare random events (`MOSS_GROW`, `FUNGUS_GROW`). They stop
  for good once there's nowhere left to grow, and the activity map lets them sleep.
  Electricity keeps a conductor's spark in its ctype too (src/electricity.js), so a grower must never conduct (no
  `elec`): `tools/nt-mat-check.mjs` checks it. Damp is read only off moss and fungus cells, never a conductor's.

**Placing growers at rest** (for world generation; `tools/gen-check.mjs` wants 0 changed cells):
- Moss is at rest when no air cell touches both damp moss (ctype ≥ 1) and bare rock on a face off the moss's axis. That
  means the mat covers the damp rock, or the moss is dry (more than `DAMP_REACH` cells from water along the mat).
  Fungus is at rest when no WOOD, SAWDUST or PLANT touches damp fungus.
- The simplest layouts are these: moss more than `DAMP_REACH` mat-cells from any water; or a mat that covers every
  rock-faced air cell within `DAMP_REACH` of the water along the mat; and fungus that has no wood beside it where it is
  damp. A whole rotted log made of fungus is at rest.
- Set ctype to the settled damp: `max(DAMP_REACH - distance to water along the mat, 0)`. Otherwise it settles in the
  first `DAMP_REACH` steps. Only ctype changes then, never the element, but a mat placed dry beside water may then grow.
- Moss can't round an outside corner (a ridge's edge) using only face neighbours. It climbs inside corners and stops at
  the edge.

### Phase rows and reactions

They are rows in el-core's tables now (`src/elements.js`):
- **Phase rows** (`cold`/`hot`, built from what each liquid holds per cm³ by `freezeOf`/`boilOf`):
  - Blood freezes at −0.54 °C and boils at 100.15 °C. Its 0.86 g of water goes to ice or steam, and its solids dry
    to ash (`BLOOD_MIX`).
  - Whiskey freezes at −23 °C and boils at 84 °C, taking ethanol's and water's latent heats (`WHISKEY_MIX`).
  - Sludge freezes at −0.5 °C and boils at 100 °C, leaving its fines as sand (`SLUDGE_MIX`).
  - Slime and the potions take water's.
- **REACTIONS**, at Noita's rates (`NT_RATE`). These are game rules:
  - water washes sludge away;
  - whiskey dissolves slime to smoke;
  - Levitatium flashes slime to fire and steam.

Still not modelled:
- Blood's coagulation at ~60–70 °C needs a cooked-blood element.
- Frozen blood and frozen whiskey are plain ice, and thaw to water.
- Whiskey's vapour is steam; an ethanol-vapour gas would be truer.
- A burnt-out whiskey cell should leave its 60 % water. That needs a burn-residue field.
- Noita's reactions that make elements we don't have (chaotic polymorphine, unstable teleportatium, mystery
  fungus) aren't rows.
- Blood on lava needs no row: lava's heat boils it.
