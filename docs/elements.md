# Elements: what to add from The Powder Toy, and in what order

The Powder Toy (TPT) shows 175 elements in 11 menu groups (from its source, `src/simulation/elements/*.cpp`, read
2026-10-10), plus separate Walls, Tools and Life menus. We had about 21 of them on 2026-10-10, plus our own Ash, Cloud,
Crystal, Sandstone and Limestone. This page ranks the rest, says how each one gets built, and tracks the fan-out that is
building them.

Physics comes first, as everywhere in this project. Where TPT bends physics for fun, we use the real behaviour (see
[Where we differ from TPT](#where-we-differ-from-tpt)) and cite the source in the element's comment, as the rocks do.

## Element ids are not scarce

Element ids must hold at least 256 elements everywhere: there are about 100 on this page alone.
- The live state stores the id as a float, so it has no cap.
- The far field's id channel was 8 bits (32 ids). Branch `farids` widens it to 256.
- The parked 16-byte state layout (docs/scaling.md D7) gave the id 6 bits. It must give id and ctype 8 bits each
  before it is built.
- Anything else that packs an id (shadow tint, network stream, saves, tile engine) gets checked by `el-core`.

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
shader stops growing per element, which matters because a cold compile already takes 9–13 s. Field names (el-core owns
the final semantics and writes them into the elements.js header):

**Phase changes**: TPT's low- and high-temperature transitions, with our latent heat.
```js
cold:  { T, into, of, latent, puff }   // at or below T °C it becomes `into`
hot:   { T, into, of, latent, puff }   // at or above T °C it becomes `into`
crush: { P, into }                     // above this air pressure it becomes `into` (TPT's high-pressure transition)
//  into    an element key ('EMPTY' = plain air), or a weighted list: [['STEAM', 0.97], ['SALT', 0.03]]
//  of      when into is 'LAVA': what the melt sets back into (its ctype)
//  latent  latent heat, banked through react.js latent() (omitted: instant)
//  puff    volumes of gas set free per volume (a pressure puff, as `fizz` does)
```
`melt`/`meltInto` stay as they are for rock and metal (melting into LAVA that remembers what it was).

**Reactions**: Noita's `materials.xml` reaction format, as a table `REACTIONS` next to the elements.
```js
{ a: 'SALT', b: 'WATER', into: ['EMPTY', 'SALTWATER'], chance, minT, maxT, heat, puff }
//  a, b     element keys; b '*' = any matter (not air), less `except: [...]`
//  into     what a and b each become ('SAME' keeps it; weighted lists allowed)
//  chance   probability per step that a touching pair reacts
//  minT, maxT  temperature gate (°C)
//  heat     energy released (+) or absorbed (−), shared between the pair
//  puff     gas set free
```
Both cells of a pair must agree in the same step without a race, and a cell reacts with at most one partner per step,
so matter is conserved.

**Explosives**: gunpowder's code, generalized.
```js
blast: { P, T, into, of, shock, crushP }
//  P       air pressure added when it goes off (gunpowder is the reference)
//  T       temperature of what it leaves
//  into    what it leaves (default FIRE); `of` as above
//  set off by its `ignite` temperature or touching fire (as now), plus
//  shock   kinetic energy of a hit that sets it off (the units of `hard`)
//  crushP  air pressure that sets it off (a nearby blast)
```

`conducts: true` marks electrical conductors (the electricity project defines what it does). Batch rows set it on
metals and saltwater.

## The fan-out (2026-10-10)

Every branch starts from main 9624a75. Its worktree is `../tpt-el-<name>`.

| Branch | Port | Builds |
| --- | --- | --- |
| `el-core` | 5411 | Batch 0: the three mechanisms, gunpowder moved onto `blast`, the id-width audit |
| `el-chem` | 5413 | Batch 2: liquid nitrogen, salt, saltwater, CO₂, dry ice, hydrogen, oxygen, caustic gas, lithium |
| `el-boom` | 5412 | Batch 1: C-4, nitroglycerin, TNT, thermite, propane, fuse; an Explosives palette group |
| `el-mat` | 5414 | Batch 3: void, brick, titanium, tungsten, plasma, gold, mercury, diamond; the Lightning tool |
| `el-fun` | 5415 | Batch 4: dust, antimatter, singularity, clay (and the mud and ceramic it makes) |
| `el-elec` | 5416 | Electricity project, v1 (docs/electricity.md) |
| `el-rays` | 5417 | Fast-particle project, v1 (docs/particles.md) |

Merge order sets element ids: core, chem, boom, mat, fun, then elec and rays as they verify.

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
- **Propane** is 1.5 times as dense as air, so it pools. TPT's GAS just diffuses.
- **Caustic gas** is hydrogen chloride: denser than air, and it dissolves back into water as acid.

## Noita materials (branch `nt-mat`)

Noita's materials as simulation elements, appended after the TPT fan-out's rows: blood, toxic sludge, slime, whiskey,
moss, fungus, and six magical liquids (Teleportatium, Levitatium, Healthium, Berserkium, Polymorphine, Pheromone) in a
Potions palette group. Their sources are in each row's comment in `src/elements.js`. What they do to bodies is other
branches' work (`nt-status` stains, `nt-flask` drinking). Two mechanisms came with them:

- **`flash`** (an element field): the flash point. With a flame touching it, a fuel burns from this temperature, and air
  touching both a flame and a fuel past its flash point catches, so a flame runs across warm whiskey. On its own, a
  fuel lights only at `ignite`. Whiskey at room temperature (20 °C, under its 26 °C flash point) often fails to take a
  small flame, as cold spirit does; warmed, it always takes it.
- **Growers** (`react.js`, `activity.js`; constants in `physics.js`): moss and fungus keep their damp in their ctype.
  It is `DAMP_REACH` (4) beside liquid water, else one less than the dampest moss or fungus beside it, and 0 at or above
  100 °C. Moss creeps into an air cell that touches damp moss and bare rock (ROCK, STONE, LIMESTONE, SANDSTONE) on a
  face across from the moss's axis, so it makes a one-cell mat on the rock and never grows out into open air. Damp
  fungus rots WOOD, SAWDUST and PLANT into fungus. Both are rare random events (`MOSS_GROW`, `FUNGUS_GROW`). They stop
  for good once there's nowhere left to grow, and the activity map lets them sleep.

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

### Deferred rows, for el-core's tables

These are in the contract shapes above. They become rows when `cold`/`hot` and `REACTIONS` land. Until then, the
liquids don't boil or freeze.

```js
// Phase rows (cold / hot), in °C, latent as L_FUSE / L_BOIL (physics.js)
BLOOD:   { cold: { T: -0.5, into: 'ICE', latent: L_FUSE },     // plasma, ~290 mOsm/kg: ΔTf = 1.86 × 0.29
           hot:  { T: 100.5, into: [['STEAM', 0.8], ['ASH', 0.2]], latent: L_BOIL, puff: STEAM_EXPANSION } },  // ~80 % water; the solids char
           // optional: coagulation at ~70 °C (albumin and haemoglobin denature at 60-70 °C) needs a cooked-blood element
WHISKEY: { cold: { T: -27, into: 'ICE', latent: L_FUSE },      // 40 % ethanol freezes near -27 °C (to a slush)
           hot:  { T: 83, into: 'STEAM', latent: L_BOIL } },   // the mixture's bubble point; its vapour is flammable: an ethanol-vapour gas would be truer
TOXIC:   { cold: { T: -2, into: 'ICE', latent: L_FUSE },       // salts and fines depress it a little
           hot:  { T: 101, into: [['STEAM', 0.7], ['STONE', 0.3]], latent: L_BOIL } },   // the water boils off, the solids stay
SLIME:   { cold: { T: 0, into: 'ICE', latent: L_FUSE }, hot: { T: 100, into: 'STEAM', latent: L_BOIL } },
// the six potions: water's, as tinctures
TELEPORTATIUM ... PHEROMONE: { cold: { T: 0, into: 'ICE' }, hot: { T: 100, into: 'STEAM' } },

// NT_REACTIONS: Noita's materials.xml reactions that map onto our elements.
// Noita's rate is per 100 frames; chance = rate / 100 here is a game choice.
const NT_REACTIONS = [
  { a: 'TOXIC', b: 'WATER', into: ['WATER', 'SAME'], chance: 0.13 },        // Noita: water dilutes sludge away (game: dilution, not cleaning)
  { a: 'SLIME', b: 'WHISKEY', into: ['SMOKE', 'SAME'], chance: 0.3 },       // Noita: whiskey dissolves slime (game magic)
  { a: 'LEVITATIUM', b: 'SLIME', into: ['FIRE', 'STEAM'], chance: 0.5 },    // Noita: [slime] + [magic_faster] → blue fire + steam (game magic)
  { a: 'POLYMORPHINE', b: 'TOXIC', into: ['SAME', 'SAME'] },                // Noita makes chaotic polymorphine: needs that element
  { a: 'TELEPORTATIUM', b: 'WHISKEY', into: ['SAME', 'SAME'] },             // Noita makes unstable teleportatium: needs that element
  { a: 'FUNGUS', b: 'TOXIC', into: ['SAME', 'FUNGUS'], chance: 0.5 },       // Noita: fungus feeds on sludge (game)
  { a: 'BLOOD', b: 'LAVA', into: ['STEAM', 'SAME'], chance: 0.7 },          // Noita: blood on lava → steam (heat does most of it already)
];
// Whiskey's burn residue: a burnt-out whiskey cell is 60 % water by volume.
// Needs a burn-residue field (e.g. burnt: [['WATER', 0.6]]); today it burns away to fire.
```
