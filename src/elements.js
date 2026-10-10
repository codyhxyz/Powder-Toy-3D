// Element definitions. This table is the single source of truth: it drives the
// UI palette and is baked into every shader as GLSL const arrays.
//
// Units
//   dens   relative density (air = 1, water = 10). Only ordering + ratios matter.
//          Gases give it at their spawn temperature and thin with heat like air.
//   cond   thermal conductance per face (pairwise flux uses min(cond_a, cond_b))
//   cap    volumetric heat capacity (water = 1). Stability needs 6*cond/cap < 1.
//   temp   spawn temperature, °C
//   grav   gravity multiplier (negative = buoyant, rises)
//   drag   per-step velocity damping
//   friction extra damping of horizontal velocity (grains resting on each other)
//   jitter per-step random velocity (brownian motion for gases)
//   flow   horizontal flow speed liquids pick up when they hit something
//   slide  probability a supported powder grain topples diagonally per step
//   melt   temperature above which it becomes LAVA (remembering what it was)
//   ignite temperature above which it burns (if it touches air)
//   rad    radiative cooling rate toward ambient
//   sigma  render only: light extinction per cell (RGB), absorption + scattering
//          (the scattering part is in gfx/materials.js); also tints shadows
//   hard   energy that breaks one cell of a solid, in the sim's kinetic-energy
//          units (½·dens·|v|², v in cells/step). A metal slug at V_MAX carries
//          ½·78 ≈ 39. Impacts, blasts and the player's tools all read it.
//   breakInto  key of the element a broken solid turns into (its debris);
//          omitted = unbreakable (WALL, CLONE). Only solids break.
//   meltInto  key of the element its melt (LAVA) sets into as it cools;
//          omitted = itself
//   acidProof  acid doesn't eat it (it eats all other matter; gases and air
//          never count)
//   fizz   gas that acid sets free as it dissolves it, as volumes of gas (at
//          ambient) per volume of the solid: a pressure puff, scaled from
//          water flashing to steam (physics.js STEAM_BOIL_PUFF, STEAM_EXPANSION)
//   ash    whether a burnt-out cell can leave ash (physics.js ASH_SHARE);
//          false for fuels that burn clean
//   sound  what it sounds like struck, in first person (pov/audio.js
//          families); omitted = by kind (solids crack, powders puff,
//          liquids splash)
//
// Adding an element
//   Data only, nothing else to touch:
//   1. Append a row to defs below (at the end: ids are saved in scenes and
//      presets). Everything above is data: phase changes by melt/meltInto,
//      burning by ignite/burnRate/burnHeat/flameT/life, breaking by
//      hard/breakInto, acid by acidProof/fizz, the struck sound by sound.
//   2. Add it to a PALETTE group below.
//   3. Give it a LOOKS row in gfx/materials.js: albedo, roughness, smooth
//      channel, and surf for a shared texture (surf 'CRAG': natural rock,
//      with per-element crag parameters).
//   The GLSL arrays, the dock tile (ui/tiles/engine.js reads the same table),
//   the first-person tools (hardness), the AI's prompt (ai/prompt.js) and the
//   info card all follow from those rows.
//   Still needs code:
//   - A behaviour no field covers (a new reaction, like plant growth or clone)
//     goes in shaders/react.js, mirrored in ui/tiles/engine.js
//     (scripts/check-tile-engine.mjs lists elements the port misses) and, if
//     it keeps a cell from resting, in shaders/activity.js inertNear.
//   - A texture of its own, beyond its albedo and the shared surf textures, is
//     a branch of shaders/gfx/surface.js matOf (and reliefHeight, plus
//     gfx/relief.js, for relief up close).
//   - A liquid that the world's far field (past the box) should draw goes in
//     shaders/far.js FAR_LIQUIDS.

import { SHRINE_OFFERS } from './pov/perks.js';
import { GEAR, SLOTS } from './pov/tools/catalog.js';
import { PHYS, SIM_GRAVITY, simSteps } from './physics.js';
import { CELL_M } from './scale.js';

export const K = { EMPTY: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
export const R = { NONE: 0, OPAQUE: 1, LIQUID: 2, GLASS: 3, GAS: 4, FIRE: 5 };

// ---- explosives' numbers (rows at the end of defs; sources there) ----
// Chapman–Jouguet detonation pressure, GPa, from density (g/cm³) and
// detonation velocity (km/s): P_CJ ≈ ρD²/4.
const detonationP = (rho, D) => (rho * D * D) / 4;
const PCJ = { C4: detonationP(1.59, 8.04), NITRO: detonationP(1.59, 7.7), TNT: detonationP(1.6, 6.9) };
// blast.P: C-4, the most brisant, fills the pressure field (P_MAX); the others by P_CJ
const EXPLOSIVE_P = Object.fromEntries(Object.entries(PCJ).map(([k, p]) => [k, Math.round((PHYS.P_MAX * p) / PCJ.C4)]));
const HE_BLAST_T = 3000;        // °C: high explosives' detonation products (~3,000-4,500 K)
// Kinetic energy (hard's units) of a cell of density dens landing after
// falling h metres from rest in the sim's gravity, drag aside: ½·dens·2gh.
const fallKE = (dens, h) => +(dens * SIM_GRAVITY * (h / CELL_M)).toFixed(2);
const NITRO_DENS = 15.9;        // 1.593 g/cm³
const NITRO_FALL_M = 3;         // m: a fall that sets nitroglycerin off (game scale)
// Thermite's puff: its iron vapour, 78.4 g per kg (Wikipedia), at ~1.8 g/cm³
// poured: 0.141 g = 2.5 mmol of Fe per cm³, ~62 cm³ of gas at ambient. Puffs
// go as steam's (physics.js STEAM_BOIL_PUFF per STEAM_EXPANSION volumes).
const THERMITE_VAPOUR = 62;     // volumes of gas per volume
const THERMITE_P = +((PHYS.STEAM_BOIL_PUFF * THERMITE_VAPOUR) / PHYS.STEAM_EXPANSION).toFixed(3);
// Propane: 1.808 kg/m³ against air's 1.184 at 25 °C.
const PROPANE_DENS = 1.53;
// Its blast pressure: heat of combustion per volume against gunpowder's.
// Propane 50.33 MJ/kg × 1.808 kg/m³ = 91 J/cm³ of gas; black powder ~3 MJ/kg
// (Wikipedia) × 1.5 g/cm³ (GUNPOWDER dens) = 4,500 J/cm³.
const PROPANE_HEAT = 91;        // J/cm³
const GUNPOWDER_HEAT = 4500;    // J/cm³
const PROPANE_P = +((PHYS.GUNPOWDER_P * PROPANE_HEAT) / GUNPOWDER_HEAT).toFixed(2);
// The flame front: propane-air burns at S_L ≈ 0.43 m/s (stoichiometric;
// Law, Combustion Physics, 2006), and its burnt gas expands ~7.5× (2,250 K
// over 300 K), so the front crosses the unburnt mix at ~3.2 m/s. On the sim's
// clock (physics.js simSteps) that is one cell per PROPANE_FRONT_STEPS steps,
// so a touching flame lights a cell with this chance per step.
const PROPANE_S_L = 0.43;       // m/s
const PROPANE_EXPANSION = 7.5;
const PROPANE_FRONT_STEPS = simSteps(CELL_M / (PROPANE_S_L * PROPANE_EXPANSION));
const PROPANE_FLAME = +Math.min(1, 1 / PROPANE_FRONT_STEPS).toFixed(3);

const defs = [
  { key: 'EMPTY', abbr: 'AIR', name: 'Air', kind: K.EMPTY, render: R.NONE, color: '#000000',
    dens: 1, cond: 0.0005, cap: 0.02, drag: 0.1, jitter: 0.02, desc: 'Air. Carries heat and pressure; hot air rises.' },
  { key: 'WALL', abbr: 'WALL', name: 'Wall', kind: K.SOLID, render: R.OPAQUE, color: '#59606e', var: 0.05,
    cond: 0.001, cap: 1.0, acidProof: true, desc: 'Indestructible and insulating. Build containers and barriers with it.' },

  { key: 'SAND', abbr: 'SAND', name: 'Sand', kind: K.POWDER, render: R.OPAQUE, color: '#dcbc74', var: 0.22,
    dens: 16, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.9, melt: 1700, meltInto: 'GLASS', spawn: 0.3,
    desc: 'Grains that pile into slopes and sink in water. Melts into glass above 1700 °C.' },
  { key: 'STONE', abbr: 'STNE', name: 'Stone', kind: K.POWDER, render: R.OPAQUE, color: '#868a92', var: 0.18,
    dens: 26, cond: 0.03, cap: 0.5, drag: 0.04, slide: 0.55, melt: 1200, spawn: 0.3, sound: 'crack',
    desc: 'Heavy rubble that sinks through anything lighter. Melts into lava at 1200 °C.' },
  { key: 'SNOW', abbr: 'SNOW', name: 'Snow', kind: K.POWDER, render: R.OPAQUE, color: '#eef4ff', var: 0.06,
    dens: 9, cond: 0.005, cap: 0.2, drag: 0.08, slide: 0.35, temp: -10, spawn: 0.3,
    desc: 'Light powder that floats on water. Melts at 0 °C, soaking up heat as it goes.' },
  { key: 'GUNPOWDER', abbr: 'GUNP', name: 'Gunpowder', kind: K.POWDER, render: R.OPAQUE, color: '#3d3d47', var: 0.35,
    dens: 15, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.8, ignite: 200, spawn: 0.3,
    desc: 'Explodes when it touches fire or gets hotter than 200 °C.' },
  { key: 'ASH', abbr: 'ASH', name: 'Ash', kind: K.POWDER, render: R.OPAQUE, color: '#9b968d', var: 0.2,
    dens: 4, cond: 0.003, cap: 0.2, drag: 0.1, slide: 0.5, spawn: 0.3,
    desc: 'Fluffy leftovers from burnt wood. Light enough to float on water.' },

  { key: 'WATER', abbr: 'WATR', name: 'Water', kind: K.LIQUID, render: R.LIQUID, color: '#2a78d4',
    dens: 10, cond: 0.03, cap: 1.0, drag: 0.01, flow: 0.9, spawn: 0.35, acidProof: true,   // dilutes acid, isn't eaten
    sigma: [0.052, 0.014, 0.01], desc: 'Flows and levels out. Freezes at 0 °C and boils at 100 °C, with real latent heat.' },
  { key: 'OIL', abbr: 'OIL', name: 'Oil', kind: K.LIQUID, render: R.LIQUID, color: '#5a3c12',
    dens: 8, cond: 0.008, cap: 0.45, drag: 0.03, flow: 0.55, ignite: 220, burnRate: 0.008,
    burnHeat: 5, flameT: 1000, life: 1, spawn: 0.35, ash: false,
    sigma: [0.4, 0.65, 1.8], desc: 'Lighter than water, so it floats on top. Catches fire at 220 °C.' },
  { key: 'ACID', abbr: 'ACID', name: 'Acid', kind: K.LIQUID, render: R.LIQUID, color: '#86f23c',
    dens: 11, cond: 0.03, cap: 1.0, drag: 0.015, flow: 0.8, life: 1, spawn: 0.35, acidProof: true,
    sigma: [0.24, 0.06, 0.3], desc: 'Eats through most things except glass and walls, using itself up as it goes.' },
  { key: 'LAVA', abbr: 'LAVA', name: 'Lava', kind: K.LIQUID, render: R.OPAQUE, color: '#ff5a1a', var: 0.1,
    dens: 25, cond: 0.03, cap: 0.6, drag: 0.2, flow: 0.3, temp: 1600, spawn: 0.35, sound: 'sizzle',
    desc: 'Molten rock at 1600 °C. Cools back into whatever melted to make it.' },

  { key: 'STEAM', abbr: 'WTRV', name: 'Steam', kind: K.GAS, render: R.GAS, color: '#e6edf5',
    dens: 0.6, cond: 0.02, cap: 0.5, grav: -0.6, drag: 0.05, jitter: 0.15, temp: 110, rad: 0.03,
    spawn: 0.3, sigma: [0.16, 0.16, 0.16], desc: 'Water vapour. Rises and spreads. Below 100 °C it condenses: into cloud in open air, into water on a surface.' },
  { key: 'SMOKE', abbr: 'SMKE', name: 'Smoke', kind: K.GAS, render: R.GAS, color: '#38383d',
    dens: 0.85, cond: 0.0005, cap: 0.02, grav: -0.25, drag: 0.05, jitter: 0.12, life: 1, rad: 0.01,
    spawn: 0.3, sigma: [0.3, 0.3, 0.3], desc: 'Drifts upward and slowly fades away.' },
  { key: 'FIRE', abbr: 'FIRE', name: 'Fire', kind: K.GAS, render: R.FIRE, color: '#ff8a2a',
    dens: 0.5, cond: 0.04, cap: 0.3, grav: -1.4, drag: 0.08, jitter: 0.25, temp: 1000, life: 1,
    rad: 0.01, spawn: 0.3, desc: 'Hot, short-lived and rising. Ignites anything flammable it heats up.' },

  { key: 'WOOD', abbr: 'WOOD', name: 'Wood', kind: K.SOLID, render: R.OPAQUE, color: '#7a4a26', var: 0.12,
    cond: 0.008, cap: 0.3, ignite: 300, burnRate: 0.0018, burnHeat: 3, flameT: 900, life: 1,
    hard: 20, breakInto: 'SAWDUST', sound: 'thunk', desc: 'Burns slowly above 300 °C and leaves ash behind.' },
  { key: 'PLANT', abbr: 'PLNT', name: 'Plant', kind: K.SOLID, render: R.OPAQUE, color: '#3da236', var: 0.25,
    cond: 0.008, cap: 0.5, ignite: 250, burnRate: 0.004, burnHeat: 2, flameT: 800, life: 1,
    hard: 6, breakInto: 'SAWDUST', sound: 'thunk', desc: 'Grows into neighbouring water. Burns easily.' },
  { key: 'METAL', abbr: 'METL', name: 'Metal', kind: K.SOLID, render: R.OPAQUE, color: '#a9afba', var: 0.04,
    cond: 0.1, cap: 0.85, melt: 1500, hard: 60, breakInto: 'SCRAP', sound: 'ping', desc: 'Conducts heat fast and glows when hot. Melts at 1500 °C.' },
  { key: 'GLASS', abbr: 'GLAS', name: 'Glass', kind: K.SOLID, render: R.GLASS, color: '#d2ecf2',
    cond: 0.015, cap: 0.5, melt: 1400, sigma: [0.05, 0.025, 0.03], hard: 8, breakInto: 'SHARDS', acidProof: true, sound: 'shatter',
    desc: 'Clear and acid-proof. Melts at 1400 °C.' },
  { key: 'ICE', abbr: 'ICE', name: 'Ice', kind: K.SOLID, render: R.GLASS, color: '#a9d8f2',
    cond: 0.04, cap: 0.5, temp: -20, sigma: [0.055, 0.031, 0.028], hard: 6, breakInto: 'SNOW', desc: 'Frozen water. Melts at 0 °C and chills whatever it touches.' },
  { key: 'CLONE', abbr: 'CLNE', name: 'Clone', kind: K.SOLID, render: R.OPAQUE, color: '#d9b81e', var: 0.05,
    cond: 0.001, cap: 1.0, desc: 'Copies the first element that touches it, forever.' },
  // New elements go at the end so existing ids (saved scenes, presets) stay stable.
  { key: 'ROCK', abbr: 'ROCK', name: 'Rock', kind: K.SOLID, render: R.OPAQUE, color: '#6a6560', var: 0.12,
    cond: 0.03, cap: 0.5, melt: 0,
    hard: 30, breakInto: 'STONE', desc: 'Natural bedrock for terrain and mountains. Never moves and never melts; conducts heat like stone.' },
  // Debris: what breakable solids turn into when they break (see hard/breakInto).
  { key: 'SHARDS', abbr: 'BGLA', name: 'Broken glass', kind: K.POWDER, render: R.OPAQUE, color: '#b9dbe3', var: 0.15,
    dens: 25, cond: 0.015, cap: 0.5, drag: 0.04, slide: 0.6, melt: 1400, meltInto: 'GLASS', spawn: 0.3, acidProof: true, sound: 'shatter',
    desc: 'Shattered glass. Acid-proof like glass, and melts back into clear glass at 1400 °C.' },
  { key: 'SAWDUST', abbr: 'SAWD', name: 'Sawdust', kind: K.POWDER, render: R.OPAQUE, color: '#c99a62', var: 0.2,
    dens: 4, cond: 0.006, cap: 0.3, drag: 0.1, slide: 0.45, ignite: 250, burnRate: 0.006, burnHeat: 3, flameT: 900,
    life: 1, spawn: 0.3, sound: 'thunk', desc: 'Chips and splinters of wood or plant. Floats on water and burns faster than a log.' },
  { key: 'SCRAP', abbr: 'BRMT', name: 'Scrap metal', kind: K.POWDER, render: R.OPAQUE, color: '#8e939c', var: 0.1,
    dens: 78, cond: 0.1, cap: 0.85, drag: 0.01, slide: 0.5, melt: 1500, meltInto: 'METAL', spawn: 0.3, sound: 'ping',
    desc: 'Heavy bits of metal: what metal breaks into, and the slugs the gun fires. Melts and recasts as solid metal.' },
  // Cloud: condensed water droplets riding in air. It moves as air does (buoyant
  // when warm; droplets this small barely settle), holds the water and heat
  // capacity of the steam it condensed from, and mixes its heat into the air
  // around it as steam does (rad).
  { key: 'CLOUD', abbr: 'CLOD', name: 'Cloud', kind: K.GAS, render: R.GAS, color: '#f2f5f9',
    dens: 1, cond: 0.02, cap: 0.5, grav: 0, drag: 0.05, jitter: 0.01, rad: 0.03, spawn: 0.3,
    sigma: [0.16, 0.16, 0.16],
    desc: 'Droplets of water in the air: what steam becomes as it cools. Floats when warm, rains where it is thick, thins away at its edges, boils back to steam at 100 °C and snows below 0 °C.' },
  // Crystal: purple fluorite (CaF₂), the mineral fluorescence is named after.
  // Real: n = 1.434, its colour, Mohs hardness 4 (the scale's reference),
  // melting point 1418 °C, 3.18 g/cm³, 0.85 J/(g·K) (cap: 2.7 J/(cm³·K) over
  // water's 4.18) and 9.7 W/(m·K), high for a mineral (~4× rock's: cond between
  // rock's and metal's). It is brittle, with perfect octahedral cleavage: its
  // fracture toughness, ~0.5 MPa·√m, lies between ice's (~0.1) and glass's
  // (~0.75), and so does hard. The glow is a game liberty: real fluorite
  // fluoresces only under ultraviolet light (gfx/materials.js FLUORITE_BAND).
  { key: 'CRYSTAL', abbr: 'CRYS', name: 'Crystal', kind: K.SOLID, render: R.OPAQUE, color: '#9466cf', var: 0.08,
    cond: 0.05, cap: 0.65, melt: 1418, hard: 7, breakInto: 'CRYSTAL_DUST', sound: 'shatter',
    desc: 'Fluorite. Glows blue-violet by itself, enough to light a dark cave. Brittle: it shatters into glowing dust. Melts at 1418 °C.' },
  // Its debris. Crushed, it keeps the crystal's glow (as powdered phosphors do)
  // and its grains' density; molten and cooled it grows back into crystal.
  { key: 'CRYSTAL_DUST', abbr: 'CDST', name: 'Crystal dust', kind: K.POWDER, render: R.OPAQUE, color: '#c3aee0', var: 0.15,
    dens: 32, cond: 0.05, cap: 0.65, drag: 0.04, slide: 0.6, melt: 1418, meltInto: 'CRYSTAL', spawn: 0.3, sound: 'shatter',
    desc: 'Crushed fluorite crystal. It still glows, so pour it wherever you need light. Melts back into crystal at 1418 °C.' },
  // Rocks beside ROCK (a weathered basalt), for the island's strata.
  // Hardness follows strength: the specific energy of cutting or drilling
  // rock comes out close to its uniaxial compressive strength (Teale 1965),
  // so with ROCK's 30 standing for a ~150 MPa basalt, hard ≈ UCS / 5 MPa.
  // Typical strengths (Goodman, Introduction to Rock Mechanics, 1989):
  // sandstone 20-170 MPa (Berea ~74), limestone 50-200 (~100), bituminous
  // coal ~30 as lab cubes. So the pickaxe (52) mines all three in wide bites,
  // the axe (24) chips sandstone and limestone where it lands, and coal
  // crumbles under either.
  // Heat (CRC Handbook; Robertson 1988, USGS OF 88-441): conductivity
  // sandstone ~2.5 and limestone ~2.3 W/m·K, like basalt (ROCK's 0.03); coal
  // ~0.26, like dry sand (0.01). Heat capacity ρ·c over water's 4.18 J/cm³·K:
  // sandstone 2.3 g/cm³ × 0.92 J/g·K → 0.5, limestone 2.6 × 0.91 → 0.55,
  // coal 1.35 × 1.26 → 0.4.
  // Sandstone is quartz sand and a little cement: it fuses where sand does
  // (quartz, ~1700 °C, past lava's 1600) and breaks back into sand.
  { key: 'SANDSTONE', abbr: 'SDST', name: 'Sandstone', kind: K.SOLID, render: R.OPAQUE, color: '#c39a64', var: 0.12,
    cond: 0.03, cap: 0.5, melt: 1700, meltInto: 'GLASS', hard: 15, breakInto: 'SAND',
    desc: 'Sand cemented into rock. Softer than rock: it breaks back into sand, and fuses into glass above 1700 °C.' },
  // Limestone is calcite, CaCO₃, the rock caves are dissolved out of. Acid
  // eats it with a fizz of CO₂: 2.71 g/cm³ / 100.1 g/mol = 0.027 mol per cm³,
  // ~650 cm³ of gas at 20 °C. It never melts: past ~900 °C it calcines to
  // quicklime instead (not modelled), and the lime melts only at 2570 °C.
  { key: 'LIMESTONE', abbr: 'LMST', name: 'Limestone', kind: K.SOLID, render: R.OPAQUE, color: '#c9c3b2', var: 0.08,
    cond: 0.03, cap: 0.55, hard: 20, breakInto: 'STONE', fizz: 650,
    desc: 'Pale calcite rock, the rock caves form in. Acid dissolves it in a fizz of gas. Never melts.' },
  // Coal: a bituminous seam, burning through the same fields as wood. It
  // lights at ~450 °C (bituminous coal's ignition point, 400-500 °C in fuel
  // handbooks) and its bed burns at ~1100 °C in still air (an orange glow:
  // a forge needs a draught to go hotter). Heat per volume goes as
  // burnHeat / burnRate: coal holds ~3.5× wood's (1.35 g/cm³ × ~29 MJ/kg =
  // 39 MJ/L against dry wood's 0.6 × 18 = 11) and gives it off at wood's
  // burnHeat, so it burns ~3.5× as long. It chars rather than melts.
  { key: 'COAL', abbr: 'COAL', name: 'Coal', kind: K.SOLID, render: R.OPAQUE, color: '#2c2b2f', var: 0.1,
    cond: 0.01, cap: 0.4, ignite: 450, burnRate: 0.0005, burnHeat: 3, flameT: 1100, life: 1,
    hard: 6, breakInto: 'BROKENCOAL',
    desc: 'Black seam rock that burns long and hot: it lights at 450 °C and burns at 1100 °C, several times longer than wood.' },
  // Broken coal, what the pickaxe makes of a seam: lumps of the same coal
  // (1.35 g/cm³: they sink in water) that pile like gravel (angle of repose
  // ~38°, between sand's and stone's). Like sawdust from wood, the bared
  // surface burns ~3.3× faster; a heap holds 0.85 / 1.35 of the seam's heat
  // (bulk over solid density), so burnHeat = 3 × 3.3 × 0.63 ≈ 6.
  { key: 'BROKENCOAL', abbr: 'BCOL', name: 'Broken coal', kind: K.POWDER, render: R.OPAQUE, color: '#39383c', var: 0.2,
    dens: 13.5, cond: 0.01, cap: 0.4, drag: 0.04, slide: 0.7, ignite: 450, burnRate: 0.0017, burnHeat: 6, flameT: 1100,
    life: 1, spawn: 0.3, sound: 'crack',
    desc: 'Lumps of coal, as the pickaxe breaks them from a seam. Sinks in water and burns faster than the seam.' },

  // ---- Explosives (batch 1, docs/elements.md): blast rows read by the shared
  // blast mechanism (el-core); the fuse has its own case in react.js.
  // Data: Wikipedia's TNT-equivalent table (density, detonation velocity D,
  // RE factor): TNT 1.60 g/cm³, 6,900 m/s, 1.00; C-4 1.59, 8,040, 1.34;
  // nitroglycerin 1.59, 7,700, 1.54; black powder 1.65, 400 (it deflagrates).
  // blast.P: what shatters walls is the detonation pressure, P_CJ ≈ ρD²/4
  // (C-4 25.7 GPa, NG 23.6, TNT 19.0). The sim's pressure field tops out at
  // P_MAX, which C-4 takes; the others scale by P_CJ (EXPLOSIVE_P below).
  // blast.T: detonation products of military high explosives come out at
  // ~3,000-4,500 K by thermochemical codes; what matters here is that they
  // are far hotter than any flame (HE_BLAST_T).
  // blast.crushP is a game scale, in multiples of a gunpowder cell's blast
  // (physics.js GUNPOWDER_P): a gunpowder cell stands in for the blasting cap
  // real high explosives need, and the order follows their gap-test
  // sensitivity: nitroglycerin < C-4 < TNT.
  // blast.shock is in hard's units (½·dens·|v|², v in cells/step).
  //
  // C-4: 91% RDX in a plastic binder (Wikipedia). Real C-4 only burns when
  // lit: just a detonator's shock sets it off (0.2 g of lead azide), and it
  // shrugged off the US Army's rifle-bullet test (20% burned, none exploded).
  // Game choice: heat past its 5-second explosion temperature (263-290 °C,
  // same source), a nearby blast or a hit that would smash wood (shock = WOOD's
  // hard) set it off. A putty, it sticks where it is painted (a solid). It has
  // no debris: blasts set it off rather than break it.
  // Heat: ~0.25 W/m·K like other plastics (cond, on water's 0.6 → 0.03 scale);
  // 1.72 g/cm³ × ~1.1 J/g·K over water's 4.18 → cap 0.45.
  { key: 'C4', abbr: 'C-4', name: 'C-4', kind: K.SOLID, render: R.OPAQUE, color: '#e3ddcb', var: 0.04,
    cond: 0.012, cap: 0.45, ignite: 263,
    blast: { P: EXPLOSIVE_P.C4, T: HE_BLAST_T, shock: 20, crushP: PHYS.GUNPOWDER_P },
    desc: 'Plastic explosive: paint it on and it stays put. The biggest blast here. Goes off at 263 °C, from a nearby blast or a hard hit.' },
  // Nitroglycerin: a pale yellow oily liquid, 1.593 g/cm³ (it sinks in water,
  // which it hardly mixes with), refractive index 1.479. It explodes above
  // 218 °C (Wikipedia). Very shock-sensitive: 0.2 J in the BAM fall-hammer
  // test against TNT's 15 J (Meyer, Köhler & Homburg, Explosives). Here a fall
  // of NITRO_FALL_M sets it off (shock = the kinetic energy of that fall in
  // the sim's gravity, drag aside), so poured gently it is safe. Freezing
  // (13 °C) isn't modelled: it would take a second element.
  // Viscosity ~36 mPa·s, oil-like (flow); ~0.2 W/m·K; 1.6 g/cm³ × 1.36 J/g·K → cap 0.52.
  { key: 'NITRO', abbr: 'NITR', name: 'Nitroglycerin', kind: K.LIQUID, render: R.LIQUID, color: '#e8dc8e',
    dens: NITRO_DENS, cond: 0.01, cap: 0.52, drag: 0.02, flow: 0.5, ignite: 218, spawn: 0.35,
    blast: { P: EXPLOSIVE_P.NITRO, T: HE_BLAST_T, shock: fallKE(NITRO_DENS, NITRO_FALL_M), crushP: PHYS.GUNPOWDER_P / 3 },
    sigma: [0.012, 0.016, 0.07],
    desc: 'Nitroglycerin: an oily liquid that sinks in water. A fall, a hit or 218 °C sets it off, so pour it gently.' },
  // TNT, as cast blocks: 1.654 g/cm³, "insensitive" to shock and friction; it
  // decomposes at 240 °C (Wikipedia), where it goes off here. It needs a
  // booster's pressure wave: a lit pile of gunpowder or another high
  // explosive, not one gunpowder cell. Flames set it off only by heating it.
  // It melts at 80 °C (melt-cast TNT is poured at ~85 °C); that isn't
  // modelled, as molten TNT would be a second element that explodes the same.
  // ~0.26 W/m·K; 1.65 g/cm³ × 1.37 J/g·K → cap 0.54.
  { key: 'TNT', abbr: 'TNT', name: 'TNT', kind: K.SOLID, render: R.OPAQUE, color: '#c9a24e', var: 0.06,
    cond: 0.013, cap: 0.54, ignite: 240,
    blast: { P: EXPLOSIVE_P.TNT, T: HE_BLAST_T, crushP: 2 * PHYS.GUNPOWDER_P },
    desc: 'Cast TNT blocks: shrug off hits and sparks. Go off at 240 °C or when a big blast goes off next to them.' },
  // Thermite: iron oxide and aluminium powders, 2Al + Fe₂O₃ → 2Fe + Al₂O₃.
  // Hard to light: Al–Fe₂O₃ ignites at ~1,220 °C in thermal analysis (1,130 °C
  // heated slowly; ~1,600 K in a furnace), so a wood fire won't do it but
  // lava, a gunpowder blast or burning magnesium (~3,100 °C) will. It burns
  // at up to 2,500 °C (adiabatic 2,862 °C, capped by iron boiling) into
  // molten iron and alumina, with almost no gas (Wikipedia: 3,956 J/g;
  // 78 g of iron vapour per kg). So it leaves LAVA that sets into METAL, and
  // its puff is that vapour (THERMITE_VAPOUR, below). Energy check: poured
  // at ~1.8 g/cm³ it holds 3,956 × 1.8 / 4.18 ≈ 1,700 cap·°C per volume; lava
  // (cap 0.6) at 2,500 °C holds ~1,500, close to all of it.
  // Loose powder from 0.7 to 4.2 g/cm³ (pressed); ~1.8 poured. Fe₂O₃ and Al
  // average ~0.72 J/g·K → cap 0.31; a powder conducts like sand.
  { key: 'THERMITE', abbr: 'THRM', name: 'Thermite', kind: K.POWDER, render: R.OPAQUE, color: '#8a5546', var: 0.25,
    dens: 18, cond: 0.01, cap: 0.31, drag: 0.04, slide: 0.75, ignite: 1220, spawn: 0.3,
    blast: { P: THERMITE_P, T: 2500, into: 'LAVA', of: 'METAL' },
    desc: 'Rust and aluminium powder. Hard to light (1220 °C: lava or a blast, not a wood fire), then burns at 2500 °C into molten iron that eats through floors.' },
  // Propane: 1.808 kg/m³ at 25 °C, ~1.5 times air (Wikipedia), so it pools
  // in low spots: grav (ρ - ρ_air)/ρ, as steam's and smoke's buoyancy. It
  // diffuses half as fast as steam (0.11 against 0.25 cm²/s), so it jitters
  // less. Autoignition 470 °C. Burning: a deflagration. It goes off only
  // where it meets air (the real limits are 2.1-9.5% propane in air, and a
  // cell is all propane or all air, so the mixing zone is the face between
  // them: blast.air), and a flame front crosses the pool at the propane-air
  // flame speed (PROPANE_FLAME, below). Its pressure is its heat of
  // combustion against gunpowder's (PROPANE_P). The flame, ~1,980 °C, is
  // propane's adiabatic flame temperature in air (2,250 K).
  // A gas has air's tiny conductance; ρ·c 1.81 kg/m³ × 1.67 kJ/kg·K is 2.5×
  // air's → cap 0.05. Real propane is invisible; it is drawn as a faint haze.
  { key: 'PROPANE', abbr: 'PROP', name: 'Propane', kind: K.GAS, render: R.GAS, color: '#cfd8b0',
    dens: PROPANE_DENS, cond: 0.0005, cap: 0.05, grav: (PROPANE_DENS - 1) / PROPANE_DENS, drag: 0.05, jitter: 0.06,
    ignite: 470, spawn: 0.3, sigma: [0.04, 0.04, 0.05],
    blast: { P: PROPANE_P, T: 1980, flame: PROPANE_FLAME, air: true },
    desc: 'Heavier than air, so it pools in low spots. A flame sends the whole pool up in a rolling fireball.' },
  // Safety fuse: a black-powder core in tarred jute (Bickford's, 1831). The
  // powder carries its own oxidiser (potassium nitrate), so it burns
  // underwater and sealed in, at a steady ~1 cm/s ("30 seconds per foot",
  // Wikipedia). That is physics.js FUSE_BURN: one cell (CELL_M) per ~1,100
  // steps, on the sim's clock (react.js FUSE case). It lights from a flame, a
  // lit fuse beside it or 300 °C (its sheath chars like wood), and the burnt
  // end spits a gunpowder flame that sets off whatever it touches. Jute and
  // tar: low conductance; it breaks into fibre (sawdust) like a plant stem.
  { key: 'FUSE', abbr: 'FUSE', name: 'Fuse', kind: K.SOLID, render: R.OPAQUE, color: '#2f5a26', var: 0.08,
    cond: 0.005, cap: 0.4, ignite: 300, life: 1, hard: 6, breakInto: 'SAWDUST', sound: 'thunk',
    desc: 'A slow wick that carries its own oxidiser: it burns about a cell every 4.5 s, even underwater, then spits a flame at its end.' },
];

export const ELEMENTS = defs.map((d, id) => ({
  id, var: 0, dens: 1000, grav: 0, drag: 0, friction: d.kind === K.POWDER ? 0.25 : 0, jitter: 0, flow: 0, slide: 0, melt: 0, ignite: 0,
  burnRate: 0, burnHeat: 0, flameT: 0, temp: 20, life: 0, rad: 0, spawn: 1, sigma: [0, 0, 0], desc: '',
  hard: 0, breakInto: null, meltInto: null, acidProof: false, fizz: 0, ash: true, sound: null,
  ...d,
  grav: d.grav ?? (d.kind === K.POWDER || d.kind === K.LIQUID ? 1 : 0),
}));

export const E = Object.fromEntries(ELEMENTS.map((e) => [e.key, e.id]));
// What a broken cell becomes: the debris element's id, or -1 when it can't break.
export const breakInto = (e) => (e.breakInto ? E[e.breakInto] : -1);

// Brush tools that are not elements (negative ids in the paint shader).
// SIGN is handled by the app (it pins a text label), not by the paint shader.
export const TOOLS = [
  { id: -1, key: 'ERASE', abbr: 'ERAS', name: 'Erase', color: '#e5536a', desc: 'Removes everything inside the brush.' },
  { id: -2, key: 'HEAT', abbr: 'HEAT', name: 'Heat', color: '#ff7a2f', desc: 'Warms everything inside the brush.' },
  { id: -3, key: 'COOL', abbr: 'COOL', name: 'Cool', color: '#52b6ff', desc: 'Chills everything inside the brush.' },
  { id: -4, key: 'BLAST', abbr: 'PRES', name: 'Pressure', color: '#b994ff', desc: 'Adds air pressure that pushes things outward.' },
  { id: -5, key: 'SIGN', abbr: 'SIGN', name: 'Sign', color: '#efe7d2',
    desc: 'Click a surface to pin a label. {t}, {p} and {e} show live temperature, pressure and element.' },
  // Spawners are handled by the app too (src/spawners.js): markers, not cells.
  { id: -6, key: 'ENEMY', abbr: 'NPC', name: 'Enemy spawner', color: '#e0453a',
    desc: 'Click a surface: in first person (F) an enemy with every tool appears here, and comes back after it dies. Click it again to remove it.' },
  { id: -7, key: 'SPAWN', abbr: 'SPWN', name: 'Player spawn', color: '#3fa7ff',
    desc: 'Click a surface: F drops you in at the spawn nearest the cursor, and you respawn there. Click it again to remove it.' },
];
export const isSpawnerTool = (id) => id === -6 || id === -7;

// Constructions: whole structures placed with one click (src/constructions.js
// builds and stamps them; they never reach the paint shader). Each one is
// generated fresh from a seed, a size and a variant. With more than one
// variant the UI also offers "shuffle", which picks a random variant per placement.
export const BUILDS = [
  { id: -100, key: 'HOUSE', abbr: 'HOUS', name: 'House', color: '#b9774b',
    variants: [['cottage', 'Cottage'], ['cabin', 'Log cabin'], ['brick', 'Brick'], ['greenhouse', 'Greenhouse']],
    desc: 'Built from real materials: wooden walls burn, windows are glass, and the chimney draws smoke up from the fireplace.' },
  { id: -101, key: 'TREE', abbr: 'TREE', name: 'Tree', color: '#4f9a3c', shuffle: true,
    variants: [['oak', 'Oak'], ['pine', 'Pine'], ['birch', 'Birch'], ['palm', 'Palm'], ['willow', 'Willow'], ['dead', 'Dead']],
    desc: 'A wooden trunk and plant leaves, grown from a new seed every time. Pick a kind or shuffle between them.' },
  { id: -102, key: 'CAMPFIRE', abbr: 'CAMP', name: 'Campfire', color: '#c75b30',
    variants: [['lit', 'Lit'], ['unlit', 'Unlit']],
    desc: 'A teepee of logs in a ring of stones. The lit one is already burning.' },
  { id: -103, key: 'IGLOO', abbr: 'IGLO', name: 'Igloo', color: '#cfe6f5',
    desc: 'A dome of ice at −20 °C with an entrance tunnel. Warm it and it melts.' },
  { id: -104, key: 'BARREL', abbr: 'BRRL', name: 'Barrel', color: '#8c6239',
    variants: [['drum', 'Oil drum'], ['keg', 'Powder keg']],
    desc: 'A steel drum full of oil or a wooden keg full of gunpowder. Both go up when they get hot.' },
  { id: -105, key: 'AQUARIUM', abbr: 'AQUA', name: 'Aquarium', color: '#4aa3c4',
    desc: 'A glass tank of water on a bed of sand and pebbles. Glass shrugs off acid but melts at 1400 °C.' },
  { id: -106, key: 'FOUNTAIN', abbr: 'FNTN', name: 'Fountain', color: '#93a6bd',
    desc: 'A stone basin with a spout fed by an endless water clone. It will overflow eventually.' },
  { id: -108, key: 'SHRINE', abbr: 'SHRN', name: 'Shrine', color: '#e9c46a',
    desc: `Noita's Holy Mountain: a stone pavilion with ${SHRINE_OFFERS} random perks floating over its plinths. In first person (F), walk into one to take it, and the others vanish. Every world has one near where you start.` },
  { id: -107, key: 'PROMPT', abbr: 'AI', name: 'Prompt', color: '#9b86e8',
    desc: 'Describe a construction and a model writes it, checked for leaks and loose powder before you place it. Or paste code from any chatbot.' },
  // The World's structures (constructions/structures.js, docs/structures.md): built to walk into at the default size.
  { id: -109, key: 'DOCK', abbr: 'DOCK', name: 'Dock', color: '#9a7046',
    variants: [['pier', 'Pier'], ['hut', 'Fishing hut']],
    desc: 'A wooden pier on stilts that reach down to the sea floor. Place it on a shore facing the water; the fishing hut sits on its head.' },
  { id: -110, key: 'TOWER', abbr: 'TOWR', name: 'Tower', color: '#c9ccd3',
    variants: [['lighthouse', 'Lighthouse'], ['watch', 'Watchtower'], ['ruin', 'Ruined keep']],
    desc: 'Climb the spiral stair inside for the view: a striped lighthouse with a glass lantern, a timber watchtower, or a broken stone keep.' },
  { id: -111, key: 'STONES', abbr: 'STNS', name: 'Standing stones', color: '#7d776f',
    desc: 'A ring of rock monoliths round a low altar. Natural rock: the pickaxe can quarry it.' },
  { id: -112, key: 'WELL', abbr: 'WELL', name: 'Well', color: '#6f7f99',
    desc: 'A stone well with water in it, a windlass and a little roof.' },
  { id: -113, key: 'MINE', abbr: 'MINE', name: 'Mine entrance', color: '#8a6a44',
    desc: 'A timber portal and a gallery it carves into the hillside behind it, with rails and a cart of rubble. Place it facing out of a slope.' },
  { id: -114, key: 'WRECK', abbr: 'WRCK', name: 'Shipwreck', color: '#6b4a2e',
    desc: 'A wooden hull heeled over and half sunk into the sand, her stern stove in, her mast and anchor beside her.' },
];
const GEAR_ID0 = -300;   // the first-person tools' ids (GEAR_ITEMS below), past the constructions'
export const isBuild = (id) => id <= -100 && id > GEAR_ID0;

// First-person tools (src/pov/tools/catalog.js), listed in the palette's Tools
// group: Garry's Mod's spawn menu. A click gives the tool to the player (the
// inventory, pov/tools/inventory.js) and puts it in hand; nothing is painted.
export const GEAR_ITEMS = GEAR.map((g, i) => ({
  id: GEAR_ID0 - i, key: `GEAR_${g.key}`, abbr: g.abbr, name: g.name, color: g.color, gear: g.key, model: g.model,
  desc: `${g.desc} First person, key ${g.slot + 1} (${SLOTS[g.slot]}).${g.start ? '' : ' Click to add it to your tools.'}`,
}));
export const isGearTool = (id) => id <= GEAR_ID0 && id > GEAR_ID0 - 100;

// How the palette is laid out in the UI. Within each group, elements are
// ordered so related materials sit together and the colours run smoothly.
export const PALETTE = [
  { name: 'Powders', items: ['SAND', 'STONE', 'BROKENCOAL', 'ASH', 'SNOW', 'SHARDS', 'CRYSTAL_DUST', 'SAWDUST', 'SCRAP'] },
  { name: 'Liquids', items: ['WATER', 'ACID', 'OIL', 'LAVA'] },
  { name: 'Gases', items: ['STEAM', 'CLOUD', 'SMOKE', 'PROPANE', 'FIRE'] },
  { name: 'Solids', items: ['WALL', 'COAL', 'ROCK', 'LIMESTONE', 'SANDSTONE', 'METAL', 'GLASS', 'ICE', 'CRYSTAL', 'WOOD', 'PLANT', 'CLONE'] },
  // TPT's Explosives menu (propane stays a gas)
  { name: 'Explosives', items: ['GUNPOWDER', 'FUSE', 'THERMITE', 'NITRO', 'TNT', 'C4'] },
  { name: 'Tools', items: ['HEAT', 'COOL', 'ERASE', 'BLAST', 'SIGN', ...GEAR_ITEMS.map((g) => g.key)] },
  { name: 'Entities', items: ['ENEMY', 'SPAWN'] },
  { name: 'Constructions', items: ['HOUSE', 'TREE', 'CAMPFIRE', 'IGLOO', 'BARREL', 'AQUARIUM', 'FOUNTAIN', 'SHRINE', 'DOCK', 'TOWER', 'STONES', 'WELL', 'MINE', 'WRECK', 'PROMPT'] },
];

const NON_ELEMENTS = [...TOOLS, ...BUILDS, ...GEAR_ITEMS];
export const toolById = (id) => (id < 0 ? NON_ELEMENTS.find((t) => t.id === id) : ELEMENTS[id]);
export const itemByKey = (key) => (key in E ? ELEMENTS[E[key]] : NON_ELEMENTS.find((t) => t.key === key));

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexToLinear = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
};

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const floatArr = (name, key) =>
  `const float ${name}[NE] = float[NE](${ELEMENTS.map((e) => f(e[key])).join(', ')});`;
const intArr = (name, key) =>
  `const int ${name}[NE] = int[NE](${ELEMENTS.map((e) => e[key]).join(', ')});`;
const boolArr = (name, key) =>
  `const bool ${name}[NE] = bool[NE](${ELEMENTS.map((e) => Boolean(e[key])).join(', ')});`;
const vec3Arr = (name, fn) =>
  `const vec3 ${name}[NE] = vec3[NE](${ELEMENTS.map((e) => `vec3(${fn(e).map(f).join(', ')})`).join(', ')});`;

// What a melt sets into as it cools (meltInto): sand, sandstone and broken
// glass turn into glass, scrap recasts as solid metal, crystal dust regrows as
// crystal, the rest as themselves.
export const meltInto = (e) => (e.meltInto ? E[e.meltInto] : e.id);

export function elementsGLSL() {
  return [
    `#define NE ${ELEMENTS.length}`,
    ...Object.entries(K).map(([k, v]) => `#define K_${k} ${v}`),
    ...Object.entries(R).map(([k, v]) => `#define R_${k} ${v}`),
    ...ELEMENTS.map((e) => `#define E_${e.key} ${e.id}`),
    ...TOOLS.map((t) => `#define T_${t.key} ${t.id}`),
    intArr('KIND', 'kind'),
    intArr('RCLASS', 'render'),
    floatArr('DENS', 'dens'),
    floatArr('COND', 'cond'),
    floatArr('CAP', 'cap'),
    floatArr('GRAV', 'grav'),
    floatArr('DRAG', 'drag'),
    floatArr('FRICTION', 'friction'),
    floatArr('JITTER', 'jitter'),
    floatArr('FLOW', 'flow'),
    floatArr('SLIDE', 'slide'),
    floatArr('MELT', 'melt'),
    floatArr('IGNITE', 'ignite'),
    floatArr('BURNRATE', 'burnRate'),
    floatArr('BURNHEAT', 'burnHeat'),
    floatArr('FLAMET', 'flameT'),
    floatArr('SPAWNT', 'temp'),
    floatArr('SPAWNLIFE', 'life'),
    floatArr('SPAWNDENS', 'spawn'),
    floatArr('RAD', 'rad'),
    floatArr('COLORVAR', 'var'),
    `const int MELTINTO[NE] = int[NE](${ELEMENTS.map(meltInto).join(', ')});`,
    floatArr('HARD', 'hard'),
    `const int BREAKINTO[NE] = int[NE](${ELEMENTS.map(breakInto).join(', ')});`,
    boolArr('ACIDPROOF', 'acidProof'),
    floatArr('FIZZ', 'fizz'),
    boolArr('LEAVES_ASH', 'ash'),
    vec3Arr('COLOR', (e) => hexToLinear(e.color).map((v) => +v.toFixed(4))),
    vec3Arr('SIGMA', (e) => e.sigma),
  ].join('\n');
}
