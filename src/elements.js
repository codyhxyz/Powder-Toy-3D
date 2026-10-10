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
//   flash  flash point: with a flame touching it, it burns from this
//          temperature (whiskey: its vapour lights long before the liquid
//          would on its own); omitted = ignite
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
//   acid   it eats matter as acid does (react.js): what touches it and isn't
//          acidProof dissolves, using it up. Acid, and caustic gas (HCl)
//   fizz   gas that acid sets free as it dissolves it, as volumes of gas (at
//          ambient) per volume of the solid: a pressure puff, scaled from
//          water flashing to steam (physics.js STEAM_BOIL_PUFF, STEAM_EXPANSION)
//   ash    whether a burnt-out cell can leave ash (physics.js ASH_SHARE);
//          false for fuels that burn clean
//   sound  what it sounds like struck, in first person (pov/audio.js
//          families); omitted = by kind (solids crack, powders puff,
//          liquids splash)
//   conducts  an electrical conductor (src/electricity.js; see elec)
//   elec   electrical conductivity σ, S/m (real values): it carries sparks
//          (src/electricity.js, docs/electricity.md), losing SPARK_DROP / σ
//          of a spark's levels per cell. conducts: true without elec means a
//          metal (ELEC_METAL); a poor conductor (water, saltwater) gives its σ.
//          A conductor's ctype holds its spark: give it no other use.
//   hot    { T, into, of, latent, puff }: at or above T °C it becomes `into`
//          (an element key; 'EMPTY' = air), TPT's high-temperature
//          transition. of: when into is 'LAVA', what it sets back into
//          (ctype). latent: heat banked first, in life, as ice banks its
//          melting (cap·°C, physics.js L_FUSE's units; omitted: instant).
//          puff: volumes of gas set free per volume, a pressure puff as fizz.
//          el-core's documented shape (docs/elements.md); read here, ahead of
//          el-core, with a single `into` key (no weighted lists yet).
//
// The shared mechanisms (docs/elements.md; react.js runs them, ui/tiles/
// engine.js mirrors them, activity.js and common.js inertSelf let them rest)
//   An `into` below is an element key ('EMPTY' = plain air) or a weighted
//   list [['STEAM', 0.97], ['SAND', 0.03]], from which each cell draws one.
//   `of`: what a LAVA product sets back into as it cools (its ctype);
//   omitted = the element it came from. Gas set free (`puff`, as `fizz`) is
//   volumes at ambient per volume, a pressure puff of
//   STEAM_BOIL_PUFF·puff/STEAM_EXPANSION.
//   cold   { T, into, of, latent, puff }: at or below T °C it becomes into
//   hot    { T, into, of, latent, puff }: at or above T °C it becomes into.
//          A hot change into LAVA is a melt: lava sets back at T less
//          LAVA_FREEZE_BELOW (and an element can't have both melt and hot).
//          latent: the latent heat in cap·°C per cell (water's L_FUSE = 80:
//          334 J/g / 4.18 J/(g·K); per volume, J/cm³ / 4.18). With it the
//          cell holds at T and the heat crossing T goes into the change:
//          - an element whose life holds nothing else (no spawn life, no
//            burnRate) banks it in life, signed as water's (+ toward hot,
//            − toward cold), and changes once it has banked latent;
//          - one whose life is taken (acid's strength, a fuel) keeps no
//            bank: each step the heat crossing T over latent is the chance it
//            changes, so on average it takes the same latent heat (stochastic
//            rounding of the bank), and its life is left alone.
//          Omitted: instant. The product takes T and its own spawn life.
//   crush  { P, into, of }: when the air pressure on it (the highest of its
//          own, none for a solid, and its open neighbours') exceeds P it
//          becomes into (TPT's high-pressure transition)
//   blast  { P, T, into, of, flame, air, shock, crushP }: an explosive.
//          Going off it becomes into (FIRE if omitted) at T °C and adds P of
//          air pressure (gunpowder: P 60, T 2200, flame 0.7). P and T are
//          required; each trigger is optional. It goes off:
//          - at its ignite temperature, or touching matter (not gas) that hot;
//          - beside a flame, with chance `flame` per step (default 0: only
//            heat sets it off, so a plain fire's heat must reach ignite);
//          - hit with at least `shock` kinetic energy (the units of hard):
//            matter and it closing at speed u carry ½·μ·u², μ the reduced mass
//            (against a solid, the mover's). That counts a neighbour running
//            into it and it landing on or running into anything; the move pass
//            leaves both speeds as they were so the react pass sees the hit.
//            Cells of its own element never count (a pool's flow isn't a hit),
//            but a liquid flowing at FLOW into a solid carries ½·dens·FLOW²,
//            and one falling h cells lands with about ½·dens·2·g·h (g = 0.025
//            cells/step²), so set shock above what it does to itself;
//          - under more than `crushP` air pressure: its own, and its open
//            neighbours' (a solid holds none, so it reads theirs);
//          - only where it touches air (an EMPTY or OXYGEN neighbour) or a flame, all
//            of the above, when `air: true` (a fuel that needs oxygen:
//            propane). A flame counts because the flame front is where fuel
//            and air mix (a fireball draws air in), so a front can sweep
//            through a pool of it; heat alone lights it only beside air.
//          A blast row never takes the ordinary burn path (burnRate, flames
//          licking into the air), and a hit or pressure that sets it off
//          wins over breaking it.
//   REACTIONS (below the table): Noita materials.xml-style rows
//          { a, b, into: [a's, b's], chance, minT, maxT, heat, puff, except }
//          a, b    element keys. b '*' = any matter but air, a itself and
//                  `except: [...]`. Explicit pairs win over '*' rows, then
//                  earlier rows; one reaction per pair of elements.
//          into    what a and b become: 'SAME' keeps one, weighted lists ok.
//                  A row with a = b needs the same into for both.
//          chance  probability per step that a touching pair reacts (default
//                  1). A pair is partners one step in RX_PAIRINGS (6, react.js),
//                  so past 1/6 the rate is that.
//          minT, maxT  °C gate on the pair's hotter cell (a hot spot lights it)
//          heat    energy released (+) or absorbed (−), cap·°C, shared so both
//                  products warm alike: ΔT = heat / (cap_a' + cap_b')
//          puff    gas set free, split between the two cells
//          Each cell reacts with at most one partner per step, and the
//          reaction takes precedence over anything else it would do then.
//
// Adding an element
//   Data only, nothing else to touch:
//   1. Append a row to defs below (at the end: ids are saved in scenes and
//      presets). Everything above is data: phase changes by melt/meltInto and
//      cold/hot/crush, reactions by a REACTIONS row, explosions by blast,
//      burning by ignite/burnRate/burnHeat/flameT/life, breaking by
//      hard/breakInto, acid by acidProof/fizz, the struck sound by sound.
//      Cite the published numbers in a comment above the row (as COAL and
//      LIMESTONE do); node tools/elements-core-check.mjs checks the
//      mechanisms, and the table's own checks throw on a bad row.
//   2. Add it to a PALETTE group below.
//   3. Give it a LOOKS row in gfx/materials.js: albedo, roughness, smooth
//      channel, and surf for a shared texture (surf 'CRAG': natural rock,
//      with per-element crag parameters).
//   The GLSL arrays, the dock tile (ui/tiles/engine.js reads the same table),
//   the first-person tools (hardness), the AI's prompt (ai/prompt.js), the
//   info card and the World's far field (shaders/far.js: up to 256 elements;
//   a render R.LIQUID element is a far liquid with its own optics) all follow
//   from those rows.
//   Still needs code:
//   - A behaviour no field covers (one a reaction row can't say, like plant
//     growth or clone)
//     goes in shaders/react.js, mirrored in ui/tiles/engine.js
//     (scripts/check-tile-engine.mjs lists elements the port misses) and, if
//     it keeps a cell from resting, in shaders/activity.js inertNear.
//   - A texture of its own, beyond its albedo and the shared surf textures, is
//     a branch of shaders/gfx/surface.js matOf (and reliefHeight, plus
//     gfx/relief.js, for relief up close).

import { SHRINE_OFFERS } from './pov/perks.js';
import { GEAR, SLOTS } from './pov/tools/catalog.js';
import { PHYS, SIM_GRAVITY, simSteps } from './physics.js';
import { CELL_M } from './scale.js';

// Photon reflectance of steel at normal incidence: F0 from its measured
// complex refractive index, 0.56-0.58 across the visible (gfx/materials.js
// METAL). What a metal doesn't reflect it absorbs as heat (rays.js, reflect).
const METAL_REFLECT = 0.58;

export const K = { EMPTY: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
export const R = { NONE: 0, OPAQUE: 1, LIQUID: 2, GLASS: 3, GAS: 4, FIRE: 5 };

// Clay's porosity: the share of a dry heap's volume that water fills when it
// makes mud (elements CLAY, MUD), 1 − bulk/grain density = 1 − 1.2/2.6.
const CLAY_WATER = 0.54;

// ---- Real material data in the sim's units (the chemistry rows) ----
// Heat capacity per volume over water's 4.18 J/(cm³·K): cap = ρ·c_p / 4.18.
// Latent heats and heats of reaction per volume the same way, in cap·°C:
// water's 334 and 2257 J/g give physics.js L_FUSE (80) and L_BOIL (540).
const WATER_VOL_HEAT = 4.18;                                                       // J/(cm³·K)
const capOf = (rho, cp) => +(rho * cp / WATER_VOL_HEAT).toFixed(3);                // g/cm³, J/(g·K)
const latentOf = (L, rho) => +(L * rho / WATER_VOL_HEAT).toFixed(1);               // J/g, g/cm³
const heatOf = (kJmol, molcm3) => +(kJmol * 1000 * molcm3 / WATER_VOL_HEAT).toFixed(1);   // kJ/mol, mol/cm³
// Conductance from thermal conductivity, from water's (cond 0.03 at
// 0.6 W/(m·K)) for liquids, from air's (EMPTY: 0.0005 at 0.026) for gases.
// Each is held under the stability limit, 6·cond/cap < 1 (COND_STABLE of it).
const WATER_K = 0.6, WATER_COND = 0.03, AIR_K = 0.026, AIR_COND = 0.0005, COND_STABLE = 0.95;
const FACES = 6;
const stableCond = (cond, cap) => +Math.min(cond, COND_STABLE * cap / FACES).toPrecision(2);
const condOf = (k) => +(WATER_COND * k / WATER_K).toPrecision(2);
const gasCondOf = (k) => +(AIR_COND * k / AIR_K).toPrecision(2);
// Gases. Per volume an ideal gas holds the same moles whatever it is, so its
// cap goes as its molar heat capacity, from air's (EMPTY: 0.02 at
// 29.1 J/(mol·K)), and its dens is its molar mass over air's. grav is what
// still air does to a parcel of it: buoyancy over its own mass plus its added
// mass (half the air it displaces, as for a bubble or a balloon),
// (ρ − 1)/(ρ + ½) of g, positive sinks. Its jitter goes as √D (a random walk's
// spread), from steam's 0.15 at water vapour's diffusivity in air, 0.25 cm²/s.
const AIR_CAP = 0.02, AIR_CPM = 29.1, AIR_M = 28.96, ADDED_MASS = 0.5, D_STEAM = 0.25, JITTER_STEAM = 0.15;
const gasCapOf = (cpm) => +(AIR_CAP * cpm / AIR_CPM).toPrecision(3);
const gasDensOf = (M) => +(M / AIR_M).toFixed(3);
const buoyancy = (dens) => +((dens - 1) / (dens + ADDED_MASS)).toFixed(3);
const jitterOf = (D) => +(JITTER_STEAM * Math.sqrt(D / D_STEAM)).toFixed(3);
// Volumes of gas, at ambient and 1 atm (molar volume 24.06 L at 20 °C), per
// volume of what gave it off: what a puff or a fizz counts.
const MOLAR_VOLUME = 24055;                                                        // cm³/mol
const gasVolumes = (molcm3) => Math.round(molcm3 * MOLAR_VOLUME);
// ...and at temperature T (°C): steam's STEAM_EXPANSION is water's at 100 °C.
const vapourVolumes = (molcm3, T) => Math.round(molcm3 * MOLAR_VOLUME * (T + PHYS.KELVIN) / (PHYS.AMBIENT + PHYS.KELVIN));
// A weighted `into` from the volumes of what a cell turns into: [[key, vol], ...] → shares.
const shares = (parts) => {
  const sum = parts.reduce((s, [, v]) => s + v, 0);
  return parts.map(([k, v]) => [k, +(v / sum).toFixed(3)]);
};

// Our acid is constant-boiling hydrochloric acid, the HCl–water azeotrope
// (CRC): 20.2 % HCl by mass, 1.10 g/cm³ (ACID's density), boiling at 108.6 °C
// into a vapour of the same make-up. Per cm³: 0.221 g HCl (36.46 g/mol) and
// 0.875 g water (18.02 g/mol), so the vapour is 11 % HCl by moles. Boiling
// takes water's latent heat plus the HCl's heat of solution given back
// (74.8 kJ/mol).
const HCL_M = 36.46, WATER_M = 18.015;
const AZEO = { T: 108.6, hclG: 0.2214, waterG: 0.8746 };
const HCL_SOLUTION = 74.8;                   // kJ/mol given off as HCl dissolves in water
const AZEO_HCL = AZEO.hclG / HCL_M, AZEO_WATER = AZEO.waterG / WATER_M;   // mol/cm³
const ACID_BOIL = {
  T: AZEO.T,
  into: shares([['STEAM', AZEO_WATER], ['CAUSTIC_GAS', AZEO_HCL]]),
  latent: +(latentOf(2257, AZEO.waterG) + heatOf(HCL_SOLUTION, AZEO_HCL)).toFixed(1),
  puff: vapourVolumes(AZEO_HCL + AZEO_WATER, AZEO.T),
};

// Saltwater is saturated brine (CRC, 20 °C): 26.4 % NaCl, 1.197 g/cm³, so a
// cm³ holds 0.881 g of water and 0.316 g of salt. Not sea water (3.5 %, which
// freezes at −1.9 °C): saturated, it takes up no more salt, and it freezes at
// the NaCl–water eutectic. A pile of salt is 1.3 g/cm³ (SALT), and ice
// 0.917 g/cm³, so what it leaves by volume is:
// Its electrical conductivity (CRC, aqueous NaCl at 20 °C) is ~22 S/m, ~4×
// sea water's 5: ions carry the current, so it conducts, but nothing like a metal.
const BRINE = { rho: 1.197, water: 0.881, salt: 0.316, cp: 3.3, k: 0.57, boilT: 108.7, elec: 22 };
const SALT_PILE = 1.3;                       // g/cm³: halite's 2.165 packed as sand is (60 % solid: 2.65 → SAND's 1.6)
const ICE_RHO = 0.917;
const EUTECTIC_T = -21.1;                    // °C, NaCl–H₂O at 23.3 % NaCl
const BRINE_FREEZE = {
  T: EUTECTIC_T,
  into: shares([['ICE', BRINE.water / ICE_RHO], ['SALT', BRINE.salt / SALT_PILE]]),
  latent: latentOf(334, BRINE.water),
};
const BRINE_BOIL = {
  T: BRINE.boilT,
  into: shares([['STEAM', BRINE.water], ['SALT', BRINE.salt / SALT_PILE]]),
  latent: latentOf(2257, BRINE.water),
  puff: Math.round(PHYS.STEAM_EXPANSION * BRINE.water),
};

// Lithium (CRC): 0.534 g/cm³ and 6.94 g/mol, so 0.077 mol/cm³. With water,
// 2Li + 2H₂O → 2LiOH(aq) + H₂, giving 508.5 − 285.8 = 222.7 kJ per mole of
// lithium (the heats of formation of LiOH(aq) and H₂O(l)) and half a mole of
// hydrogen: 925 volumes of gas per volume of lithium. Acid sets free the same.
// Electrical conductivity 1.08e7 S/m (resistivity 92.8 nΩ·m at 20 °C).
const LI = { rho: 0.534, M: 6.94, cp: 3.58, melt: 180.5, dH: 222.7, elec: 1.08e7 };
const LI_MOL = LI.rho / LI.M;                // mol/cm³
const LI_H2_VOLUMES = gasVolumes(LI_MOL / 2);
const METAL_COND = 0.1;                      // METAL's (iron, 80 W/(m·K)); lithium's 85 is the same

// Carbon dioxide (CRC): 44.01 g/mol. Dry ice is a pressed block of it,
// 1.56 g/cm³, that sublimes at −78.5 °C (1 atm) taking 571 J/g.
const CO2_M = 44.01, DRY_ICE_RHO = 1.56, SUBLIME_T = -78.5;
const DRY_ICE_SPAWN_BELOW = 1.5;             // °C under the sublimation point it is made at
const CO2_SUBLIME = latentOf(571, DRY_ICE_RHO);

// Liquid nitrogen (CRC, NIST WebBook, at its boiling point, 1 atm): boils at
// −195.8 °C taking 199 J/g; 0.807 g/cm³ and 28.01 g/mol.
const LN2 = { rho: 0.807, M: 28.013, cp: 2.04, k: 0.14, bp: -195.8, L: 199 };
const LN2_SPAWN_BELOW = 0.2;                 // °C under its boiling point it is poured at
// ---- explosives' numbers (rows at the end of defs; sources there) ----
// Gunpowder's blast, the reference the others scale from (its row's).
const GUNPOWDER_BLAST = { P: 60, T: 2200, flame: 0.7 };
// Chapman–Jouguet detonation pressure, GPa, from density (g/cm³) and
// detonation velocity (km/s): P_CJ ≈ ρD²/4.
const detonationP = (rho, D) => (rho * D * D) / 4;
const PCJ = { C4: detonationP(1.59, 8.04), NITRO: detonationP(1.59, 7.7), TNT: detonationP(1.6, 6.9) };
// blast.P: C-4, the most brisant, fills the pressure field (P_MAX); the others by P_CJ
const EXPLOSIVE_P = Object.fromEntries(Object.entries(PCJ).map(([k, p]) => [k, Math.round((PHYS.P_MAX * p) / PCJ.C4)]));
const HE_BLAST_T = 3000;        // °C: high explosives' detonation products (~3,000-4,500 K)
// Kinetic energy (hard's units) of a cell of density dens landing after
// falling h metres from rest, stepped as react.js does: v ← (v + g)·(1 − drag).
function fallKE(dens, drag, h) {
  let v = 0, y = 0;
  while (y < h / CELL_M) { v = (v + SIM_GRAVITY) * (1 - drag); y += v; }
  return +(0.5 * dens * v * v).toFixed(2);
}
const NITRO_DENS = 15.9;        // 1.593 g/cm³
const NITRO_DRAG = 0.02;
const NITRO_FALL_M = 5;         // m: a fall that sets nitroglycerin off (game scale)
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
const PROPANE_P = +((GUNPOWDER_BLAST.P * PROPANE_HEAT) / GUNPOWDER_HEAT).toFixed(2);
// The flame front: propane-air burns at S_L ≈ 0.43 m/s (stoichiometric;
// Law, Combustion Physics, 2006), and its burnt gas expands ~7.5× (2,250 K
// over 300 K), so the front crosses the unburnt mix at ~3.2 m/s. On the sim's
// clock (physics.js simSteps) that is one cell per PROPANE_FRONT_STEPS steps,
// so a touching flame lights a cell with this chance per step.
const PROPANE_S_L = 0.43;       // m/s
const PROPANE_EXPANSION = 7.5;
const PROPANE_FRONT_STEPS = simSteps(CELL_M / (PROPANE_S_L * PROPANE_EXPANSION));
const PROPANE_FLAME = +Math.min(1, 1 / PROPANE_FRONT_STEPS).toFixed(3);

// A liquid's flow and drag from its viscosity in mPa·s, on a log scale
// through two rows: water (1 mPa·s: flow 0.9, drag 0.01) and lava (basaltic,
// ~100 Pa·s: flow 0.3, drag 0.2). Rows older than this set theirs by hand.
const VISC = { WATER_MPAS: 1, LAVA_MPAS: 1e5, WATER_FLOW: 0.9, LAVA_FLOW: 0.3, WATER_DRAG: 0.01, LAVA_DRAG: 0.2 };
const VISC_DIGITS = 4;   // decimal places of the derived flow and drag
function viscous(mPas) {
  const t = Math.log10(mPas / VISC.WATER_MPAS) / Math.log10(VISC.LAVA_MPAS / VISC.WATER_MPAS);
  return {
    flow: +(VISC.WATER_FLOW + (VISC.LAVA_FLOW - VISC.WATER_FLOW) * t).toFixed(VISC_DIGITS),
    drag: +(VISC.WATER_DRAG * (VISC.LAVA_DRAG / VISC.WATER_DRAG) ** t).toFixed(VISC_DIGITS),
  };
}

// Noita's liquids' phase changes (elements.js cold/hot), from what each is
// made of per cm³: its water freezes to ice and boils to steam, with water's
// latent heats for that share, and what else it holds stays behind.
// Blood: ~81 % water by mass (0.86 g/cm³); the rest, proteins and cells,
// dries to a crust (dry protein ~1.3 g/cm³; ash stands in for it). Plasma's
// ~290 mOsm/kg lowers its freezing point by 1.86 K·kg/mol × 0.29 = 0.54 K,
// and raises its boiling point by 0.512 × 0.29 = 0.15 K. Coagulation
// (~60-70 °C, as an egg sets) would need a cooked-blood element: not modelled.
const BLOOD_MIX = { water: 0.86, solids: 0.2, solidsRho: 1.3, freezeT: -0.54, boilT: 100.15 };
// Whiskey, 40 % ethanol by volume: 0.316 g of ethanol (46.07 g/mol, 841 J/g
// to boil) and 0.632 g of water per cm³ (33 % ethanol by weight). It freezes
// to a slush near -23 °C (CRC freezing-point table, 30-40 % by weight: -20 to
// -29 °C) and boils at the mixture's bubble point, ~84 °C (ethanol-water VLE,
// mole fraction 0.16). Its vapour is ethanol and steam; with no ethanol
// vapour element it goes up as steam.
const WHISKEY_MIX = { ethanol: 0.316, ethanolM: 46.07, ethanolL: 841, water: 0.632, freezeT: -23, boilT: 84 };
// Toxic sludge: 1.2 g/cm³ of water and fines (2.65 g/cm³ grains: 12 % by
// volume, 0.32 g, with 0.88 g of water). Its dissolved salts (tailings water
// carries a few g/L) lower its freezing point a little. The fines settle out
// as sand (SAND's pile, 1.6 g/cm³).
const SLUDGE_MIX = { water: 0.88, fines: 0.32, finesPile: 1.6, freezeT: -0.5, boilT: 100 };
// Slime (a PVA-borax gel, ~97 % water) and the potions (tinctures): water's
// phase changes for their water.
const GEL_WATER = 0.97, TINCTURE_WATER = 1;
const freezeOf = (T, water, into = 'ICE') => ({ T, into, latent: latentOf(334, water) });
const boilOf = (T, water, rest = []) => ({
  T, into: rest.length ? shares([['STEAM', water], ...rest]) : 'STEAM',
  latent: latentOf(2257, water), puff: vapourVolumes(water / WATER_M, T),
});
const WHISKEY_BOIL = {
  T: WHISKEY_MIX.boilT, into: 'STEAM',
  latent: +(latentOf(WHISKEY_MIX.ethanolL, WHISKEY_MIX.ethanol) + latentOf(2257, WHISKEY_MIX.water)).toFixed(1),
  puff: vapourVolumes(WHISKEY_MIX.ethanol / WHISKEY_MIX.ethanolM + WHISKEY_MIX.water / WATER_M, WHISKEY_MIX.boilT),
};

const defs = [
  { key: 'EMPTY', abbr: 'AIR', name: 'Air', kind: K.EMPTY, render: R.NONE, color: '#000000',
    dens: 1, cond: 0.0005, cap: 0.02, drag: 0.1, jitter: 0.02, desc: 'Air. Carries heat and pressure; hot air rises.' },
  { key: 'WALL', abbr: 'WALL', name: 'Wall', kind: K.SOLID, render: R.OPAQUE, color: '#59606e', var: 0.05,
    cond: 0.001, cap: 1.0, acidProof: true, desc: 'Indestructible and insulating. Build containers and barriers with it.' },

  { key: 'SAND', abbr: 'SAND', name: 'Sand', kind: K.POWDER, render: R.OPAQUE, color: '#dcbc74', var: 0.22,
    dens: 16, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.9, melt: 1700, meltInto: 'GLASS', spawn: 0.3,
    desc: 'Grains that pile into slopes and sink in water. Melts into glass above 1700 °C.' },
  { key: 'STONE', abbr: 'STNE', name: 'Stone', kind: K.POWDER, render: R.OPAQUE, color: '#78726c', var: 0.18,
    dens: 26, cond: 0.03, cap: 0.5, drag: 0.04, slide: 0.55, melt: 1200, spawn: 0.3, sound: 'crack',
    desc: 'Heavy rubble that sinks through anything lighter. Melts into lava at 1200 °C.' },
  { key: 'SNOW', abbr: 'SNOW', name: 'Snow', kind: K.POWDER, render: R.OPAQUE, color: '#eef4ff', var: 0.06,
    dens: 9, cond: 0.005, cap: 0.2, drag: 0.08, slide: 0.35, temp: -10, spawn: 0.3,
    desc: 'Light powder that floats on water. Melts at 0 °C, soaking up heat as it goes.' },
  { key: 'GUNPOWDER', abbr: 'GUNP', name: 'Gunpowder', kind: K.POWDER, render: R.OPAQUE, color: '#3d3d47', var: 0.35,
    dens: 15, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.8, ignite: 200, spawn: 0.3, blast: GUNPOWDER_BLAST,
    desc: 'Explodes when it touches fire or gets hotter than 200 °C.' },
  { key: 'ASH', abbr: 'ASH', name: 'Ash', kind: K.POWDER, render: R.OPAQUE, color: '#9b968d', var: 0.2,
    dens: 4, cond: 0.003, cap: 0.2, drag: 0.1, slide: 0.5, spawn: 0.3,
    desc: 'Fluffy leftovers from burnt wood. Light enough to float on water.' },

  { key: 'WATER', abbr: 'WATR', name: 'Water', kind: K.LIQUID, render: R.LIQUID, color: '#2a78d4',
    dens: 10, cond: 0.03, cap: 1.0, drag: 0.01, flow: 0.9, spawn: 0.35, acidProof: true,   // dilutes acid, isn't eaten
    // fresh water conducts, weakly: ~0.005-0.05 S/m from its dissolved ions
    // (USGS, Specific conductance; pure water 5.5·10⁻⁶), 10⁸ times less than steel
    elec: 0.05,
    sigma: [0.052, 0.014, 0.01], desc: 'Flows and levels out. Freezes at 0 °C and boils at 100 °C, with real latent heat.' },
  { key: 'OIL', abbr: 'OIL', name: 'Oil', kind: K.LIQUID, render: R.LIQUID, color: '#5a3c12',
    dens: 8, cond: 0.008, cap: 0.45, drag: 0.03, flow: 0.55, ignite: 220, burnRate: 0.008,
    burnHeat: 5, flameT: 1000, life: 1, spawn: 0.35, ash: false,
    sigma: [0.4, 0.65, 1.8], desc: 'Lighter than water, so it floats on top. Catches fire at 220 °C.' },
  { key: 'ACID', abbr: 'ACID', name: 'Acid', kind: K.LIQUID, render: R.LIQUID, color: '#86f23c',
    dens: 11, cond: 0.03, cap: 1.0, drag: 0.015, flow: 0.8, life: 1, spawn: 0.35, acidProof: true, acid: true,
    hot: ACID_BOIL,   // boils at 108.6 °C into steam and caustic gas (the azeotrope, above)
    sigma: [0.24, 0.06, 0.3], desc: 'Eats through most things except glass and walls, using itself up as it goes. Boils at 108.6 °C into steam and caustic gas.' },
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
  // Steel: carbon steel's resistivity ~1.43·10⁻⁷ Ω·m, σ ≈ 7·10⁶ S/m (CRC Handbook).
  { key: 'METAL', abbr: 'METL', name: 'Metal', kind: K.SOLID, render: R.OPAQUE, color: '#a9afba', var: 0.04,
    cond: 0.1, cap: 0.85, melt: 1500, hard: 60, breakInto: 'SCRAP', sound: 'ping', conducts: true, elec: 7e6, reflect: METAL_REFLECT,
    desc: 'Conducts heat fast and glows when hot. Carries electricity. Melts at 1500 °C.' },
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
    dens: 78, cond: 0.1, cap: 0.85, drag: 0.01, slide: 0.5, melt: 1500, meltInto: 'METAL', spawn: 0.3, sound: 'ping', reflect: METAL_REFLECT,
    conducts: true, elec: 7e6,   // the same steel (TPT's BRMT conducts as METL does)
    desc: 'Heavy bits of metal: what metal breaks into, and the slugs the gun fires. Carries electricity. Melts and recasts as solid metal.' },
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
  // ---- Electronics (src/electricity.js, docs/electricity.md): TPT's BTRY,
  // PSCN, NSCN, SWCH, INSL and TSNS. ----
  // Battery: a sealed lithium-ion cell, a source that sparks every conductor
  // touching it whenever that conductor is ready. Its can is steel. Thermal
  // runaway: past ~150-200 °C the separator melts and the cathode gives up
  // oxygen, so it burns on its own at ~700-900 °C (Feng et al. 2018, Energy
  // Storage Materials 10, 246). Through its jelly roll it conducts heat like
  // rock (~1-3 W/m·K); ρ·c ≈ 2.5 g/cm³ × 1.0 J/g·K → cap 0.6.
  { key: 'BATTERY', abbr: 'BTRY', name: 'Battery', kind: K.SOLID, render: R.OPAQUE, color: '#858505', var: 0.04,
    cond: 0.03, cap: 0.6, ignite: 200, burnRate: 0.01, burnHeat: 4, flameT: 900, life: 1, ash: false,
    hard: 20, breakInto: 'SCRAP', sound: 'ping',
    desc: 'Endless electricity: it sparks every conductor it touches. A lithium cell: past 200 °C it bursts into flame.' },
  // P- and N-type silicon: doped silicon, the two halves of a diode. Heavily
  // doped (~10¹⁹ cm⁻³) it conducts ~10⁴ S/m, losslessly here. Silicon melts
  // at 1414 °C (TPT's 1687 K too), 2.33 g/cm³ × 0.71 J/g·K → cap 0.4, and
  // 150 W/m·K, more than steel: cond 0.06, the most 6·cond/cap < 1 allows.
  // The junction: N never sparks P (a p-n junction conducts from P to N).
  { key: 'PSCN', abbr: 'PSCN', name: 'P-type silicon', kind: K.SOLID, render: R.OPAQUE, color: '#805050', var: 0.04,
    cond: 0.06, cap: 0.4, melt: 1414, elec: 1e4,
    desc: 'Carries sparks to any conductor, but takes none from N-type silicon: together they make a diode. A spark from it turns a switch on.' },
  { key: 'NSCN', abbr: 'NSCN', name: 'N-type silicon', kind: K.SOLID, render: R.OPAQUE, color: '#505080', var: 0.04,
    cond: 0.06, cap: 0.4, melt: 1414, elec: 1e4,
    desc: 'Carries sparks to any conductor except P-type silicon. A spark from it turns a switch off.' },
  // Switch: a relay. Copper contacts (σ 5.96·10⁷ S/m, CRC) in a steel frame
  // (steel's heat numbers and melting point). life: SWITCH_ON while on.
  { key: 'SWITCH', abbr: 'SWCH', name: 'Switch', kind: K.SOLID, render: R.OPAQUE, color: '#103b11', var: 0.04,
    cond: 0.1, cap: 0.85, melt: 1500, meltInto: 'METAL', hard: 60, breakInto: 'SCRAP', sound: 'ping', elec: 5.96e7,
    desc: 'Passes sparks only while it is on. A spark from P-type silicon turns it on, one from N-type turns it off; touching switches go together.' },
  // Insulator: TPT's INSL, which blocks heat and electricity, with silica
  // aerogel's numbers: 0.015 W/m·K, about half still air's 0.026 (cond 0.0003
  // to air's 0.0005); 0.1 g/cm³ × 1 J/g·K → cap 0.03; a dielectric. It is
  // silica, so acid can't touch it and it sinters into glass at ~1200 °C.
  { key: 'INSULATOR', abbr: 'INSL', name: 'Insulator', kind: K.SOLID, render: R.OPAQUE, color: '#9ea3b6', var: 0.03,
    cond: 0.0003, cap: 0.03, melt: 1200, meltInto: 'GLASS', acidProof: true,
    desc: 'Blocks electricity and almost all heat. Put it between wires that must not touch. Melts into glass at 1200 °C.' },
  // Temperature sensor: TPT's TSNS. It holds no heat (cond 0, as TPT's), so
  // its own temperature is the threshold: set it with Heat and Cool.
  { key: 'TSNS', abbr: 'TSNS', name: 'Temperature sensor', kind: K.SOLID, render: R.OPAQUE, color: '#fd00d5', var: 0.03,
    cond: 0, cap: 1.0,
    desc: 'Sparks the conductors it touches while anything beside it is hotter than itself. Heat or cool it to set its temperature.' },
  // Powered clone: TPT's PCLN, Clone switched on by P and off by N (life:
  // SWITCH_ON while on). Clone's numbers: a game block, not a material.
  { key: 'PCLN', abbr: 'PCLN', name: 'Powered clone', kind: K.SOLID, render: R.OPAQUE, color: '#3b3b0a', var: 0.05,
    cond: 0.001, cap: 1.0,
    desc: 'A clone you switch: it copies the first element that touches it, but only while it is on. A spark from P-type silicon turns it on, one from N-type off.' },
  // Radioactive (docs/particles.md; neutron data in rays.js NUCLEAR). Both
  // are metals painted as heavy powders, as TPT has them, so a runaway's
  // pressure can throw a lump apart.
  // Uranium: natural uranium metal, 19.1 g/cm³; 0.116 J/(g·K) → cap 0.53;
  // 27.5 W/(m·K), a poor metal (cond between crystal's and metal's); melts at
  // 1132 °C. Barely radioactive (U-238's half-life is 4.5 billion years), so
  // unlike TPT's it doesn't heat by itself: neutrons scatter off it, it
  // captures some and fissions a few.
  { key: 'URANIUM', abbr: 'URAN', name: 'Uranium', kind: K.POWDER, render: R.OPAQUE, color: '#707a5c', var: 0.1,
    dens: 191, cond: 0.08, cap: 0.53, drag: 0.01, slide: 0.5, melt: 1132, spawn: 0.3, sound: 'ping',
    desc: 'Natural uranium: the heaviest powder, sinking through anything. Barely radioactive by itself; neutrons bounce off it, and it fissions a little when they hit.' },
  // Plutonium: Pu-239 metal, 19.8 g/cm³; 0.132 J/(g·K) → cap 0.62; 6.7
  // W/(m·K), the worst-conducting metal (cond near crystal's); melts at only
  // 640 °C, into lava that stays fissile. A neutron splits it (rays.js
  // NUCLEAR), freeing 2-3 more, so a lump past critical size runs away.
  { key: 'PLUTONIUM', abbr: 'PLUT', name: 'Plutonium', kind: K.POWDER, render: R.OPAQUE, color: '#55703c', var: 0.1,
    dens: 198, cond: 0.045, cap: 0.62, drag: 0.01, slide: 0.5, melt: 640, spawn: 0.3, sound: 'ping',
    desc: 'Fissile Pu-239. A neutron splits it into heat and 2-3 more neutrons, so a big enough heap runs away and blows itself apart. Water around it makes it go critical sooner.' },

  // ---- Batch 3 (el-mat): materials and weather. docs/elements.md.
  // Electrical conductivity (elec, S/m, at 20 °C; CRC Handbook): titanium
  // 2.38e6, tungsten 1.79e7, gold 4.10e7, mercury 1.04e6 (liquid), 4.4e6
  // frozen (its resistivity drops ~4× on freezing).
  // Heat, for the rows below: cond follows the rocks' and coal's calibration,
  // cond ≈ 0.03·(k / 2.5 W/m·K)^0.4 (rock 2.5 → 0.03, coal 0.26 → 0.012, steel
  // 50 → 0.1), but never past cap/6, the stability limit react.js enforces per
  // face (physics.js COND_FLUX_SHARE). cap = ρ·c over water's 4.18 J/(cm³·K).
  // Conductivities and heat capacities: CRC Handbook of Chemistry and Physics.
  // Strength: hard ≈ strength / 5 MPa, the rocks' rule (UCS for rock and
  // brick, tensile strength for metals: METAL's 60 is a ~300 MPa structural
  // steel).
  //
  // Void: TPT's VOID ("hole, will drain away any particles"). A solid that
  // deletes whatever can move (powders, liquids, gases) the step it touches
  // it; air passes, and solids beside it stay, as in TPT, where only a
  // particle moving into VOID is drained (Simulation.cpp eval_move). With
  // Clone upstream, a stream runs forever without flooding. Insulating, like
  // Wall; acid can't eat it (TPT: VOID's Hardness 0).
  { key: 'VOID', abbr: 'VOID', name: 'Void', kind: K.SOLID, render: R.OPAQUE, color: '#790b0b', var: 0.04,
    cond: 0.001, cap: 1.0, acidProof: true,
    desc: 'Deletes any powder, liquid or gas that touches it. Pair it with Clone for waterfalls that never flood.' },
  // Brick: fired clay brick, 1.9 g/cm³ (0.84 J/g·K: cap 0.38; k ≈ 0.7 W/m·K:
  // cond 0.018). Compressive strength 20–100 MPa (ASTM C62 asks ≥ 17; a modern
  // facing brick tests ~60): hard 12, so a gunpowder blast a cell away (60)
  // cracks it, the axe chips it and the pickaxe mines it. It breaks into
  // brick rubble, not stone: crushed brick is a material of its own (grog,
  // the red of a clay tennis court) and keeps brick's colour and density.
  // It melts, at ~1,300 °C: common red-brick clays are rich in iron and alkali
  // fluxes, so their refractoriness is under 1,350 °C (fire clays, with less
  // flux, stand 1,500 °C+). A wood fire (900 °C) never touches it, lava
  // (1,600) does. The melt is a glassy aluminosilicate slag that sets as stone.
  // Fired ceramic shrugs off acids (only hydrofluoric attacks it).
  { key: 'BRICK', abbr: 'BRCK', name: 'Brick', kind: K.SOLID, render: R.OPAQUE, color: '#a4553d', var: 0.1,
    cond: 0.018, cap: 0.38, melt: 1300, meltInto: 'STONE', hard: 12, breakInto: 'RUBBLE', acidProof: true, sound: 'crack',
    desc: 'Fired clay brick. A blast breaks it into rubble; it stands any wood fire and melts only past 1300 °C. Acid-proof.' },
  { key: 'RUBBLE', abbr: 'BRBL', name: 'Brick rubble', kind: K.POWDER, render: R.OPAQUE, color: '#b0705a', var: 0.2,
    dens: 19, cond: 0.01, cap: 0.38, drag: 0.04, slide: 0.6, melt: 1300, meltInto: 'STONE', spawn: 0.3, acidProof: true, sound: 'crack',
    desc: 'Crushed brick, what a blast leaves of a brick wall. Sinks in water; melts past 1300 °C.' },
  // Titanium: 4.51 g/cm³, melts at 1,668 °C; k 21.9 W/m·K (cond 0.07), 0.52
  // J/g·K (cap 0.56). Ti-6Al-4V, the structural alloy, has a tensile strength
  // of ~950 MPa: hard 190, so no blast in the sim cracks it (P_BREAK_PER_HARD:
  // it would need 950 across it; P_MAX - P_MIN is 250) and no projectile does.
  // So it needs no debris: it is the blast-proof wall that still melts. Hot
  // hydrochloric and sulfuric acid attack it, so acid eats it.
  { key: 'TITANIUM', abbr: 'TTAN', name: 'Titanium', kind: K.SOLID, render: R.OPAQUE, color: '#9a9ca3', var: 0.03,
    cond: 0.07, cap: 0.56, melt: 1668, hard: 190, conducts: true, elec: 2.38e6, sound: 'ping',
    desc: 'The blast-proof metal: no explosion or bullet breaks it. Melts at 1668 °C.' },
  // Tungsten: 19.3 g/cm³, melts at 3,422 °C, the highest of any metal; k 173
  // W/m·K and 0.13 J/g·K (cap 0.61, cond at the cap/6 limit). Worked rod has a
  // tensile strength of ~1,000 MPa: hard 200, unbreakable here like
  // titanium (TPT makes it brittle to pressure jumps; real tungsten
  // penetrators don't shatter). It glows white past ~2,500 °C, with the
  // generic incandescence (gfx/incandescence.js). Only hydrofluoric-nitric
  // mixtures dissolve it: acid-proof.
  { key: 'TUNGSTEN', abbr: 'TUNG', name: 'Tungsten', kind: K.SOLID, render: R.OPAQUE, color: '#7b7d82', var: 0.03,
    cond: 0.1, cap: 0.61, melt: 3422, hard: 200, acidProof: true, conducts: true, elec: 1.79e7, sound: 'ping',
    desc: 'Melts at 3422 °C, higher than any other metal, and glows white-hot long before. Unbreakable and acid-proof.' },
  // Plasma: air ionised by heat, TPT's PLSM (10,000 °C). At 10,000 K an ideal
  // gas has 293/10,273 of its room density: dens 0.03, the lightest thing in
  // the sim. Dissociation and ionisation raise c_p about as much as the
  // density falls (Boulos, Fauchais & Pfender, Thermal Plasmas, 1994), so its
  // cap is about air's; its conductivity (~2 W/m·K, the dissociation peak)
  // is held to the cap/6 limit. It radiates fast (rad: from 10,000 to
  // recombination in ~40 steps, ~0.15 s, a lightning channel's afterglow)
  // and recombines into plain air below ~5,000 K, where air's ionisation
  // collapses (Saha; arcs in air go out at 4,000–5,000 K).
  { key: 'PLASMA', abbr: 'PLSM', name: 'Plasma', kind: K.GAS, render: R.FIRE, color: '#c7b4ff',
    dens: 0.03, cond: 0.003, cap: 0.02, grav: -1.4, drag: 0.08, jitter: 0.25, temp: 10000, rad: 0.02, life: 1,
    spawn: 0.3, cold: { T: 4700, into: 'EMPTY' },
    desc: 'Ionised air at 10,000 °C, the hottest thing there is. Glows, heats whatever it touches, and cools back into air in a blink.' },
  // Gold: 19.3 g/cm³ (dens 193 for its nuggets), melts at 1,064 °C; k 318
  // W/m·K, 0.129 J/g·K (cap 0.6, cond at the limit). Annealed gold has a
  // tensile strength of ~120 MPa: hard 24, the softest metal here (the axe
  // just breaks it, a bullet dents it out). Only aqua regia dissolves it:
  // acid-proof. It breaks into nuggets, which recast as gold.
  { key: 'GOLD', abbr: 'GOLD', name: 'Gold', kind: K.SOLID, render: R.OPAQUE, color: '#dcad2c', var: 0.04,
    cond: 0.1, cap: 0.6, melt: 1064, hard: 24, breakInto: 'NUGGETS', acidProof: true, conducts: true, elec: 4.1e7, sound: 'ping',
    desc: 'Soft, heavy and acid-proof. Tools and blasts break it into nuggets; it melts at 1064 °C.' },
  { key: 'NUGGETS', abbr: 'NUGT', name: 'Gold nuggets', kind: K.POWDER, render: R.OPAQUE, color: '#e7bd45', var: 0.15,
    dens: 193, cond: 0.1, cap: 0.6, drag: 0.01, slide: 0.5, melt: 1064, meltInto: 'GOLD', spawn: 0.3, acidProof: true,
    conducts: true, elec: 4.1e7, sound: 'ping',
    desc: 'Lumps of gold. They sink through everything, mercury included, and melt back into gold at 1064 °C.' },
  // Mercury: 13.53 g/cm³ (dens 135: stone, steel scrap and brick float on it,
  // gold and tungsten sink). Freezes at −38.83 °C and boils at 356.73 °C.
  // Latent heats over water's (L_FUSE 80 is 334 J/cm³): fusion 11.4 J/g ×
  // 13.53 = 154 J/cm³ → 37; vaporisation 295 J/g → 3,990 J/cm³ → 955. Boiling,
  // 0.0675 mol/cm³ makes ~1,620 volumes of vapour at ambient (the puff).
  // k 8.3 W/m·K (cond 0.05), 0.14 J/g·K (cap 0.45). Viscosity 1.5 mPa·s,
  // water's is 0.9: it flows a little slower. Its vapour is toxic (ignored).
  { key: 'MERCURY', abbr: 'MERC', name: 'Mercury', kind: K.LIQUID, render: R.OPAQUE, color: '#b7b9bd', var: 0.03,
    dens: 135, cond: 0.05, cap: 0.45, drag: 0.01, flow: 0.8, spawn: 0.35, conducts: true, elec: 1.04e6, sound: 'splash',
    cold: { T: -38.83, into: 'SOLID_MERCURY', latent: 37 },
    hot: { T: 356.73, into: 'MERCURY_VAPOR', latent: 955, puff: 1620 },
    desc: 'Liquid metal, so dense that stone and steel float on it while gold sinks. Freezes at −39 °C and boils at 357 °C.' },
  // Frozen mercury: 14.18 g/cm³, k ~30 W/m·K (cond at the cap/6 limit),
  // cap 0.46. Soft as lead, but it never meets a blow here: no debris.
  { key: 'SOLID_MERCURY', abbr: 'HGIC', name: 'Frozen mercury', kind: K.SOLID, render: R.OPAQUE, color: '#c9cbcf', var: 0.03,
    cond: 0.07, cap: 0.46, temp: -60, conducts: true, elec: 4.4e6, sound: 'ping',
    hot: { T: -38.83, into: 'MERCURY', latent: 37 },
    desc: 'Mercury frozen solid below −39 °C. It melts back into mercury as soon as it warms.' },
  // Mercury vapour: 200.6 g/mol over air's 28.96, at 360 °C: 6.93 × 293/633 =
  // 3.2 times ambient air, so it sinks (grav: (ρ − ρ_air)/ρ ≈ 0.7 g). Monatomic,
  // a third of air's heat capacity per volume; k 0.009 W/m·K. It mixes its
  // heat into the air (rad, like steam) and condenses back into mercury at
  // its boiling point.
  { key: 'MERCURY_VAPOR', abbr: 'HGVP', name: 'Mercury vapour', kind: K.GAS, render: R.GAS, color: '#c8ccd2',
    dens: 3.2, cond: 0.0003, cap: 0.01, grav: 0.7, drag: 0.05, jitter: 0.1, temp: 360, rad: 0.03, spawn: 0.3,
    sigma: [0.08, 0.08, 0.08], cold: { T: 356.73, into: 'MERCURY', latent: 955 },
    desc: 'Boiled mercury. A heavy gas that sinks and condenses back into droplets below 357 °C.' },
  // Diamond: 3.51 g/cm³, 0.509 J/g·K (cap 0.43). It conducts heat better
  // than any bulk material (~2,200 W/m·K, five times copper): cond is at its
  // cap/6 limit. The hardest natural material: by the strength rule it is
  // far past anything the sim carries (hard 560 for its ~2.8 GPa tensile
  // strength), so it needs no debris. TPT makes it indestructible, but it is
  // carbon and burns in air: thermogravimetry puts the onset of oxidation at
  // 700–780 °C (NASA, CVD films; uncoated grit 781 °C). In air the burning
  // doesn't keep itself alight (Lavoisier needed a burning glass; in pure
  // oxygen it does), so burnHeat 0: it burns away only while something keeps
  // it hot, and leaves no ash (CO₂). It burns half as fast as coal (dense,
  // no volatiles to flame off). n = 2.417.
  { key: 'DIAMOND', abbr: 'DMND', name: 'Diamond', kind: K.SOLID, render: R.GLASS, color: '#d6f4fb',
    cond: 0.07, cap: 0.43, ignite: 780, burnRate: 0.00025, burnHeat: 0, flameT: 780, life: 1, ash: false,
    hard: 560, acidProof: true, sigma: [0.006, 0.006, 0.008], sound: 'shatter',
    desc: 'Clear, brilliant and harder than anything: nothing breaks it and acid can\'t touch it. But it is carbon: above 780 °C it burns away.' },
  // ---- Batch 2, chemistry and cold (el-chem; the data above defs) ----
  // Liquid nitrogen: c_p 2.04 J/(g·K), k 0.14 W/(m·K). It floats on water
  // (0.807) and boils away into plain air (nitrogen *is* air; TPT's just
  // vanishes), as cold as it was, with a puff of 0.807 / 28.01 mol × 24.06 L
  // = 693 volumes. Water it touches loses heat to it faster than it can boil
  // it off, and freezes. It reacts with nothing: acid freezes on it.
  { key: 'LIQUID_NITROGEN', abbr: 'LN2', name: 'Liquid nitrogen', kind: K.LIQUID, render: R.LIQUID, color: '#bcd9f0',
    dens: LN2.rho * 10, cond: condOf(LN2.k), cap: capOf(LN2.rho, LN2.cp), drag: 0.01, flow: 0.9,
    temp: LN2.bp - LN2_SPAWN_BELOW, spawn: 0.35, acidProof: true,
    hot: { T: LN2.bp, into: 'EMPTY', latent: latentOf(LN2.L, LN2.rho), puff: gasVolumes(LN2.rho / LN2.M) },
    sigma: [0.012, 0.011, 0.01],
    desc: 'Nitrogen cold enough to pour, at −196 °C. Floats on water and freezes it, and boils away into cold air with a big puff.' },
  // Salt: rock salt, NaCl (CRC), c_p 0.864 J/(g·K), a pile packed as sand's
  // (SALT_PILE: 1.3, so it sinks even in brine) that conducts like sand. It
  // melts at 801 °C (into lava that sets back into salt, as TPT's does). Water
  // dissolves it (REACTIONS): 359 g per litre, so a cell of it salts 3.6 cells
  // of water into brine.
  { key: 'SALT', abbr: 'SALT', name: 'Salt', kind: K.POWDER, render: R.OPAQUE, color: '#f0eee8', var: 0.08,
    dens: SALT_PILE * 10, cond: 0.01, cap: capOf(SALT_PILE, 0.864), drag: 0.04, slide: 0.85, melt: 801, spawn: 0.3,
    desc: 'White grains that dissolve in water and turn it into saltwater. Melts at 801 °C.' },
  // Saltwater: saturated brine (BRINE above), c_p 3.3 J/(g·K), k 0.57 W/(m·K).
  // It sinks under fresh water, freezes at the eutectic, −21.1 °C, into ice
  // and salt, and boils at 108.7 °C into steam, leaving its salt behind.
  { key: 'SALTWATER', abbr: 'SLTW', name: 'Saltwater', kind: K.LIQUID, render: R.LIQUID, color: '#3f8ccc',
    dens: +(BRINE.rho * 10).toFixed(2), cond: condOf(BRINE.k), cap: capOf(BRINE.rho, BRINE.cp), drag: 0.012, flow: 0.85,
    spawn: 0.35, acidProof: true, conducts: true, elec: BRINE.elec, cold: BRINE_FREEZE, hot: BRINE_BOIL,
    sigma: [0.052, 0.014, 0.01],
    desc: 'Water saturated with salt. Heavier than water, freezes only at −21 °C, and boiling it leaves the salt behind. Conducts electricity.' },
  // Carbon dioxide: 1.52× air, so it sinks and pools in low places, and puts
  // out flames where it makes up CO2_SMOTHER of the air (react.js). Below
  // −78.5 °C it settles out as dry ice. c_p,m 37.1 J/(mol·K), k 0.0166 W/(m·K),
  // diffusivity in air 0.16 cm²/s.
  { key: 'CO2', abbr: 'CO2', name: 'Carbon dioxide', kind: K.GAS, render: R.GAS, color: '#959aa3',
    dens: gasDensOf(CO2_M), cond: gasCondOf(0.0166), cap: gasCapOf(37.1), grav: buoyancy(gasDensOf(CO2_M)), drag: 0.05,
    jitter: jitterOf(0.16), rad: PHYS.AIR_AMBIENT_PULL, spawn: 0.3,
    cold: { T: SUBLIME_T, into: 'DRY_ICE', latent: CO2_SUBLIME },
    sigma: [0.02, 0.02, 0.02],
    desc: 'A heavy, invisible gas that sinks and pools in low places. It smothers fire, and freezes into dry ice at −78.5 °C.' },
  // Dry ice: c_p ~1.2 J/(g·K) near −80 °C (Giauque & Egan 1937), k ~0.28 W/(m·K).
  // It sublimes straight into CO₂ at −78.5 °C, setting free
  // 1.56 / 44.01 mol × 24.06 L = 853 volumes of gas.
  { key: 'DRY_ICE', abbr: 'DRIC', name: 'Dry ice', kind: K.SOLID, render: R.OPAQUE, color: '#e6ebf0', var: 0.04,
    cond: condOf(0.28), cap: capOf(DRY_ICE_RHO, 1.2), temp: SUBLIME_T - DRY_ICE_SPAWN_BELOW, acidProof: true,
    hot: { T: SUBLIME_T, into: 'CO2', latent: CO2_SUBLIME, puff: gasVolumes(DRY_ICE_RHO / CO2_M) },
    desc: 'Frozen carbon dioxide at −80 °C. It never melts: it turns straight into heavy CO₂ gas, chilling what it touches.' },
  // Hydrogen: 2.016 g/mol, 0.07× air, so it shoots up; it diffuses faster than
  // any other gas (0.61 cm²/s in air) and conducts heat 7× better than air
  // (0.187 W/(m·K), held to the stability limit). c_p,m 28.8 J/(mol·K). It
  // burns into steam with the oxygen in air or pure oxygen once it is past its
  // autoignition point, which a flame's heat gets it to in a few steps
  // (REACTIONS: a flame doesn't light pure hydrogen, which has no oxygen).
  { key: 'HYDROGEN', abbr: 'HYGN', name: 'Hydrogen', kind: K.GAS, render: R.GAS, color: '#a3b4ff',
    dens: gasDensOf(2.016), cond: stableCond(gasCondOf(0.187), gasCapOf(28.8)), cap: gasCapOf(28.8),
    grav: buoyancy(gasDensOf(2.016)), drag: 0.05, jitter: jitterOf(0.61), rad: PHYS.AIR_AMBIENT_PULL, spawn: 0.3,
    sigma: [0.012, 0.012, 0.012],
    desc: 'The lightest gas: it rises fast. A flame sets it burning with the air into steam, and with oxygen it goes up all at once.' },
  // Oxygen: 32.00 g/mol, 1.105× air (which is 21 % oxygen); c_p,m 29.4 J/(mol·K),
  // k 0.0266 W/(m·K), 0.20 cm²/s. It doesn't burn by itself, but fuel next to
  // it burns faster and hotter (react.js, physics.js O2_PER_AIR).
  { key: 'OXYGEN', abbr: 'OXYG', name: 'Oxygen', kind: K.GAS, render: R.GAS, color: '#accbff',
    dens: gasDensOf(32.0), cond: gasCondOf(0.0266), cap: gasCapOf(29.4), grav: buoyancy(gasDensOf(32.0)), drag: 0.05,
    jitter: jitterOf(0.2), rad: PHYS.AIR_AMBIENT_PULL, spawn: 0.3,
    sigma: [0.015, 0.015, 0.015],
    desc: 'Pure oxygen. It doesn\'t burn by itself, but anything burning next to it burns several times faster and hotter.' },
  // Caustic gas: hydrogen chloride, 36.46 g/mol, 1.26× air, so it sinks;
  // c_p,m 29.1 J/(mol·K), k 0.0145 W/(m·K), ~0.175 cm²/s (Fuller, from CO₂'s).
  // Boiling acid gives it off (ACID_BOIL). A cell of it eats as a cell of acid
  // does (acid: true), and water takes it back up as acid (REACTIONS).
  { key: 'CAUSTIC_GAS', abbr: 'CAUS', name: 'Caustic gas', kind: K.GAS, render: R.GAS, color: '#b4efb8',
    dens: gasDensOf(HCL_M), cond: gasCondOf(0.0145), cap: gasCapOf(29.1), grav: buoyancy(gasDensOf(HCL_M)), drag: 0.05,
    jitter: jitterOf(0.175), life: 1, rad: PHYS.AIR_AMBIENT_PULL, spawn: 0.3, acidProof: true, acid: true,
    sigma: [0.05, 0.05, 0.05],
    desc: 'Hydrogen chloride, the fumes of boiling acid. Heavier than air, it eats through things as acid does, and turns back into acid in water.' },
  // Lithium (LI above): the lightest metal, so it floats on water, and even on
  // oil. Lumps of it, as scrap is of metal, so it can float. c_p 3.58 J/(g·K);
  // it melts at 180.5 °C. In water it fizzes off hydrogen and heat
  // (REACTIONS): any bang comes from the hydrogen. Acid dissolves it into the
  // same hydrogen (fizz). Soft: it doesn't ring.
  { key: 'LITHIUM', abbr: 'LITH', name: 'Lithium', kind: K.POWDER, render: R.OPAQUE, color: '#c3bdc9', var: 0.06,
    dens: LI.rho * 10, cond: stableCond(METAL_COND, capOf(LI.rho, LI.cp)), cap: capOf(LI.rho, LI.cp), drag: 0.02,
    slide: 0.5, melt: LI.melt, spawn: 0.3, fizz: LI_H2_VOLUMES, conducts: true, elec: LI.elec,
    desc: 'A metal so light it floats on water. In water it fizzes out hydrogen and heat, enough to set the hydrogen alight. Melts at 180 °C.' },
  // ---- Batch 4 (docs/elements.md): dust, antimatter, singularity, clay, mud, ceramic ----
  // Dust: grain dust (wheat flour), TPT's DUST. A loose heap is 0.5-0.6 g/cm³
  // (dens 5.5: it floats on water), c ≈ 1.7 J/(g·K) (cap 0.55·1.7/4.18 ≈ 0.22),
  // and conducts like ash. A 50 µm grain settles at ~0.1 m/s in still air
  // (Stokes): far under a cell per step, but a cell of it is a puff, not a
  // grain, so it falls slowly (drag: ~0.14 cells/step at the default gravity,
  // a quarter of sand's) yet faster than physics.js DUST_LIFT_V, so a falling
  // cloud counts as suspended. Flour is cohesive (repose ~45°+).
  // Heat of combustion ~15.5 MJ/kg, 8.5 MJ per litre of heap: burnHeat /
  // burnRate ≈ 1330 on the scale where wood's 11 MJ/L is 1670. Settled, it
  // smoulders: a dust layer glows at 450-700 °C rather than flaming (flameT).
  // Its cloud lights at 380-440 °C (minimum ignition temperature, wheat
  // flour; Eckhoff 2003): ignite 400. Suspended in air it goes off as one
  // (react.js dust clouds, physics.js DUST_*).
  { key: 'DUST', abbr: 'DUST', name: 'Dust', kind: K.POWDER, render: R.OPAQUE, color: '#efdcae', var: 0.12,
    dens: 5.5, cond: 0.004, cap: 0.22, drag: 0.15, slide: 0.3, ignite: 400, burnRate: 0.0015, burnHeat: 2, flameT: 600,
    life: 1, spawn: 0.3,
    desc: 'Fine flour dust. A heap only smoulders, but blown into the air it explodes: a flame runs through the cloud and its blast stirs up more dust.' },
  // Antimatter (TPT's AMTR): annihilates any matter it touches, both cells
  // gone in a flash (REACTIONS). E = mc²: a cell of water (27 kg at a
  // 0.30 m cell) and as much antimatter give 2·27 kg·c² ≈ 4.9e18 J, about a
  // gigaton of TNT, and even a cell of air ~1e16 J. Nothing in the engine
  // holds that, so each annihilation is capped at its limits: the pressure
  // and temperature clamps (physics.js P_MAX, CELL_TEMP_MAX). TPT's AMTR is a
  // gas that sinks and spreads; ours is a powder, so it can be poured where
  // it's wanted, and it spares air (a game liberty: real antimatter would
  // annihilate air too, more slowly by its density, ~1/800 of water's).
  { key: 'ANTIMATTER', abbr: 'AMTR', name: 'Antimatter', kind: K.POWDER, render: R.OPAQUE, color: '#c4bce4', var: 0.1,
    dens: 15, cond: 0.01, cap: 0.35, drag: 0.04, slide: 0.8, spawn: 0.3, acidProof: true,   // it annihilates acid instead
    desc: 'Annihilates whatever matter it touches into a blast of pressure and heat. Only walls, clone and singularities are safe; it rests on air.' },
  // Singularity (TPT's SING): a tiny black hole (react.js, physics.js SING_*).
  // It holds a deep vacuum, so air and matter rush in, swallows what touches
  // it, gaining its mass (life, in cells of water), and bursts when it is
  // full; starved, it evaporates and winks out. Denser than anything, it
  // sinks through every liquid. Nothing gets out: it conducts no heat.
  { key: 'SINGULARITY', abbr: 'SING', name: 'Singularity', kind: K.POWDER, render: R.OPAQUE, color: '#1c1c20',
    dens: 1000, cond: 0, cap: 1, drag: 0.04, life: PHYS.SING_MASS0, spawn: 0.02, acidProof: true,   // it swallows acid instead
    desc: 'A tiny black hole. It sucks in the air around it, swallows everything it touches and grows; full, it bursts. Starved, it evaporates.' },
  // Clay: kaolin, white china clay. Grains of kaolinite are 2.6 g/cm³; a dry
  // heap ~1.2 (dens 12, porosity 1 − 1.2/2.6 ≈ 0.54: CLAY_WATER), with
  // c ≈ 0.92 J/(g·K) (cap 1.2·0.92/4.18 ≈ 0.26), conducting like dry sand.
  // Water soaks into its pores and makes mud (REACTIONS). Fired, it turns
  // to ceramic: kaolinite loses its water at 450-600 °C and sinters into
  // spinel and then mullite from ~980 °C (Brindley & Nakahira, J. Am. Ceram.
  // Soc. 42, 1959); earthenware is fired at 1000-1150 °C. It never slakes again.
  { key: 'CLAY', abbr: 'CLST', name: 'Clay', kind: K.POWDER, render: R.OPAQUE, color: '#d9d2c3', var: 0.1,
    dens: 12, cond: 0.01, cap: 0.26, drag: 0.06, slide: 0.35, spawn: 0.3,
    hot: { T: 1000, into: 'CERAMIC' },
    desc: 'Kaolin powder. Water soaks into it and makes mud; fired past 1000 °C it bakes into ceramic.' },
  // Mud: clay with its pores full of water (CLAY_WATER of its volume):
  // 1.2 + 0.54 = 1.74 g/cm³ (dens 17.4: it sinks in water), cap
  // (1.2·0.92 + 0.54·4.18)/4.18 ≈ 0.8, conducting like wet soil (~1.2 W/(m·K),
  // water's 0.03). A clay slurry this thick is a Bingham plastic, viscous like
  // lava (Coussot, Mudflow Rheology and Dynamics, 1997); its yield stress
  // holds only a few cm, under a cell, so here it creeps level. TPT's paste
  // hardens under pressure, as cornstarch in water does (shear thickening); a
  // clay slurry thins as it's worked instead, so ours doesn't. Past 100 °C its
  // water boils off, taking that share of water's latent heat and setting the
  // steam free as a puff, and it dries back into clay.
  { key: 'MUD', abbr: 'MUD', name: 'Mud', kind: K.LIQUID, render: R.OPAQUE, color: '#9a8f7b', var: 0.08,
    dens: 17.4, cond: 0.03, cap: 0.8, drag: 0.2, flow: 0.2, spawn: 0.35,
    hot: { T: 100, into: 'CLAY', latent: CLAY_WATER * PHYS.L_BOIL, puff: CLAY_WATER * PHYS.STEAM_EXPANSION },
    desc: 'Wet clay. Thick and slow, it sinks in water. Heated past 100 °C its water boils off and it dries back into clay.' },
  // Ceramic: fired kaolin, unglazed porcelain. ~2.3 g/cm³, c ≈ 0.85 J/(g·K)
  // (cap 2.3·0.85/4.18 ≈ 0.47), ~1.5 W/(m·K), a little over glass (cond 0.02).
  // Hard to scratch (Mohs ~7) but brittle: its fracture toughness, ~1-1.5
  // MPa·√m, is a little over glass's (0.75, hard 8), so hard 9. It breaks
  // into sharp, acid-proof fragments much as glass does (SHARDS), and shrugs
  // off acid (HF aside: lab ware is porcelain). Kaolin fuses at ~1750-1785 °C
  // (pyrometric cone 35), and its melt cools into a glass.
  { key: 'CERAMIC', abbr: 'CRMC', name: 'Ceramic', kind: K.SOLID, render: R.OPAQUE, color: '#ece7dd', var: 0.04,
    cond: 0.02, cap: 0.47, melt: 1750, meltInto: 'GLASS', hard: 9, breakInto: 'SHARDS', acidProof: true, sound: 'shatter',
    desc: 'Fired clay: hard, acid-proof and brittle. A hard knock or a blast shatters it into sharp fragments. Melts into glass at 1750 °C.' },
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
  // (GUNPOWDER_BLAST.P): a gunpowder cell stands in for the blasting cap
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
    blast: { P: EXPLOSIVE_P.C4, T: HE_BLAST_T, shock: 20, crushP: GUNPOWDER_BLAST.P },
    desc: 'Plastic explosive: paint it on and it stays put. The biggest blast here. Goes off at 263 °C, from a nearby blast or a hard hit.' },
  // Nitroglycerin: a pale yellow oily liquid, 1.593 g/cm³ (it sinks in water,
  // which it hardly mixes with), refractive index 1.479. It explodes above
  // 218 °C (Wikipedia). Very shock-sensitive: 0.2 J in the BAM fall-hammer
  // test against TNT's 15 J (Meyer, Köhler & Homburg, Explosives). Here a fall
  // of NITRO_FALL_M sets it off (shock = the kinetic energy of that fall in
  // the sim's gravity and its drag), so poured gently it is safe. Freezing
  // (13 °C) isn't modelled: it would take a second element.
  // Viscosity ~36 mPa·s, oil-like (flow); ~0.2 W/m·K; 1.6 g/cm³ × 1.36 J/g·K → cap 0.52.
  { key: 'NITRO', abbr: 'NITR', name: 'Nitroglycerin', kind: K.LIQUID, render: R.LIQUID, color: '#e8dc8e',
    dens: NITRO_DENS, cond: 0.01, cap: 0.52, drag: NITRO_DRAG, flow: 0.5, ignite: 218, spawn: 0.35,
    blast: { P: EXPLOSIVE_P.NITRO, T: HE_BLAST_T, shock: fallKE(NITRO_DENS, NITRO_DRAG, NITRO_FALL_M), crushP: GUNPOWDER_BLAST.P / 3 },
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
    blast: { P: EXPLOSIVE_P.TNT, T: HE_BLAST_T, crushP: 2 * GUNPOWDER_BLAST.P },
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
  // them, or a flame, which draws air in: blast.air), and a flame front crosses the pool at the propane-air
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
  // ---- Noita's materials (docs/elements.md, "Noita materials") ----
  // Names and colours are Noita's (materials.xml ids and the wiki's
  // descriptions, noita.wiki.gg, read 2026-10-10); flow, density and heat are
  // real. Liquids take flow and drag from their viscosity (viscous, below).
  // They freeze and boil by what they hold (BLOOD_MIX and the rest, above
  // defs); Noita's reactions between them are REACTIONS rows (NT_ below).
  // Blood: whole blood, 1.06 g/cm³; 3-4 mPa·s at high shear (it thins as it
  // flows; Baskurt & Meiselman 2003); 3.6 J/(g·K) × 1.06 → cap 0.91 of
  // water's; ~0.5 W/(m·K), 0.85 of water's. It is ~80 % water: its freezing
  // point (-0.5 °C) and boiling point sit close to water's (BLOOD_MIX).
  { key: 'BLOOD', abbr: 'BLOD', name: 'Blood', kind: K.LIQUID, render: R.LIQUID, color: '#8a0f12',
    dens: 10.6, cond: 0.025, cap: 0.91, ...viscous(3.5), spawn: 0.35,
    cold: freezeOf(BLOOD_MIX.freezeT, BLOOD_MIX.water),
    hot: boilOf(BLOOD_MIX.boilT, BLOOD_MIX.water, [['ASH', BLOOD_MIX.solids / BLOOD_MIX.solidsRho]]),
    sigma: [0.9, 8, 8], desc: 'Thicker than water and a little heavier, so it settles under it.' },
  // Toxic sludge (Noita's radioactive_liquid): an industrial slurry or mine
  // tailings, water carrying 20-30 % fine solids: ~1.2 g/cm³ and 0.1-1 Pa·s
  // (take 0.3). It sinks below water; Noita's floats (density 3, water's 4).
  // Its faint green glow is game magic (gfx/materials.js TOXIC_GLOW); what it
  // does to bodies is the status effects' (nt-status).
  { key: 'TOXIC', abbr: 'TOXC', name: 'Toxic sludge', kind: K.LIQUID, render: R.LIQUID, color: '#3fb52c',
    dens: 12, cond: 0.03, cap: 0.85, ...viscous(300), spawn: 0.35,
    cold: { T: SLUDGE_MIX.freezeT, into: shares([['ICE', SLUDGE_MIX.water / ICE_RHO], ['SAND', SLUDGE_MIX.fines / SLUDGE_MIX.finesPile]]),
      latent: latentOf(334, SLUDGE_MIX.water) },
    hot: boilOf(SLUDGE_MIX.boilT, SLUDGE_MIX.water, [['SAND', SLUDGE_MIX.fines / SLUDGE_MIX.finesPile]]),
    sigma: [1.6, 0.5, 2.5], desc: 'Thick green industrial sludge that sinks below water and glows faintly. Poisons whoever wades in it.' },
  // Slime: Noita's pink-purple slime, taken as a hydrogel like PVA-borax
  // slime: mostly water (~1.05 g/cm³, cap and cond near water's) and about as
  // thick as honey, ~10 Pa·s at the shear rates of a pour.
  { key: 'SLIME', abbr: 'SLIM', name: 'Slime', kind: K.LIQUID, render: R.LIQUID, color: '#b45cae',
    dens: 10.5, cond: 0.028, cap: 0.95, ...viscous(1e4), spawn: 0.35,
    cold: freezeOf(0, GEL_WATER), hot: boilOf(100, GEL_WATER),
    sigma: [0.25, 0.7, 0.3], desc: 'Sticky pink goo, a little heavier than water. It oozes rather than flows.' },
  // Whiskey (Noita's alcohol): 40 % ethanol by volume. 0.948 g/cm³ at 20 °C;
  // ~2.8 mPa·s (ethanol-water peaks near 2.9 at 40 % by weight; CRC
  // Handbook); 3.9 J/(g·K) → cap 0.89; ~0.45 W/(m·K). Its flash point is
  // ~26 °C (closed cup, 40 % ethanol by volume): above it the vapour over it
  // lights from a flame touching it (flash). Alone it lights only at
  // ethanol's autoignition point, 363 °C (ignite). Its heat per volume is
  // ~9 MJ/L (the ethanol's, 29.7 MJ/kg × 0.32 kg/L) against oil's ~36, a
  // quarter (burnHeat / burnRate), with no soot (ash: false). It burns low:
  // the water in it holds the flame cooler than ethanol's 1900 °C. It boils
  // at ~84 °C and freezes near -23 °C (WHISKEY_MIX).
  { key: 'WHISKEY', abbr: 'WHSK', name: 'Whiskey', kind: K.LIQUID, render: R.LIQUID, color: '#c27a2c',
    dens: 9.48, cond: 0.022, cap: 0.89, ...viscous(2.8), flash: 26, ignite: 363, burnRate: 0.008, burnHeat: 1.3,
    flameT: 700, life: 1, spawn: 0.35, ash: false,
    cold: freezeOf(WHISKEY_MIX.freezeT, WHISKEY_MIX.water), hot: WHISKEY_BOIL,
    sigma: [0.05, 0.16, 0.55], desc: 'Forty per cent alcohol. Floats on water, and any flame lights it: it burns with a low, clean flame.' },
  // Moss: a living mat that creeps over damp rock (react.js, physics.js
  // DAMP_REACH, MOSS_GROW): an air cell on bare rock (ROCK, STONE, LIMESTONE,
  // SANDSTONE) beside damp moss becomes moss. Damp is liquid water within a
  // few cells along the moss (its ctype). It holds still once it covers the
  // damp rock, so a world can be generated with moss at rest. Dry moss is
  // tinder: like dry leaves and peat it lights at ~250 °C (Babrauskas,
  // Ignition Handbook 2003) and burns fast (sawdust's rate); damp moss must
  // first dry (above DAMP_DRY_T its water is gone; its latent heat isn't
  // modelled). Soft as plant (hard), and breaks into plant debris.
  { key: 'MOSS', abbr: 'MOSS', name: 'Moss', kind: K.SOLID, render: R.OPAQUE, color: '#4d7a2c', var: 0.22,
    cond: 0.006, cap: 0.6, ignite: 250, burnRate: 0.006, burnHeat: 2, flameT: 800, life: 1,
    hard: 6, breakInto: 'SAWDUST', sound: 'thunk',
    desc: 'Creeps slowly over damp rock wherever water is near, and stops when it has covered it. Burns once dry.' },
  // Fungus: foxfire, the glow of wood-rotting fungi (Armillaria, Panellus
  // stipticus) whose luciferin emits at 520-530 nm (Kotlobay et al. 2018,
  // PNAS). It spreads into WOOD, SAWDUST and PLANT beside damp fungus and
  // rots them into itself (react.js FUNGUS_GROW): decay fungi need wood above
  // ~20 % moisture (USDA Wood Handbook, ch. 14), so it is damp the way moss
  // is. Dark isn't a rule: fungi need no darkness, only the damp that shade
  // keeps, and the sim has no sunlight on cells. The glow is real but far
  // dimmer than drawn (gfx/materials.js FOXFIRE_BAND). It burns like
  // punk wood: lights at ~250 °C and smoulders.
  { key: 'FUNGUS', abbr: 'FUNG', name: 'Fungus', kind: K.SOLID, render: R.OPAQUE, color: '#b5e08a', var: 0.2,
    cond: 0.008, cap: 0.6, ignite: 250, burnRate: 0.003, burnHeat: 2, flameT: 700, life: 1,
    hard: 6, breakInto: 'SAWDUST', sound: 'thunk',
    desc: 'Glowing fungus, like foxfire. It slowly rots damp wood, sawdust and plants into more of itself. Burns.' },
  // Noita's magical liquids. What they do to bodies is game magic and other
  // branches' (nt-status stains, nt-flask drinking). As matter they are
  // tinctures: water-thin (~1.5 mPa·s; Healthium a light syrup, 10), with
  // water's heat, and densities in Noita's order (materials.xml: Levitatium
  // 1.11, Berserkium 2.41, Pheromone 3.51, water 4, Polymorphine 4.14,
  // Teleportatium 4.21, Healthium 5.53) inside the span real solutions have,
  // an alcohol's 0.8 g/cm³ to a heavy syrup's 1.35. Their faint glow is game
  // magic (gfx/materials.js MAGIC_GLOW_LUM); colours as the wiki gives them.
  { key: 'TELEPORTATIUM', abbr: 'TLPT', name: 'Teleportatium', kind: K.LIQUID, render: R.LIQUID, color: '#3cc6e8',
    dens: 10.5, cond: 0.03, cap: 1.0, ...viscous(1.5), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.45, 0.06, 0.04], desc: 'A glowing cyan potion from Noita. Whoever touches it is flung somewhere else.' },
  { key: 'LEVITATIUM', abbr: 'LEVI', name: 'Levitatium', kind: K.LIQUID, render: R.LIQUID, color: '#a7ad7a',
    dens: 8, cond: 0.03, cap: 1.0, ...viscous(1.5), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.12, 0.08, 0.3], desc: 'A pale olive potion from Noita, lighter than every other liquid. It makes whoever is soaked in it float faster.' },
  { key: 'HEALTHIUM', abbr: 'HLTH', name: 'Healthium', kind: K.LIQUID, render: R.LIQUID, color: '#c8f26a',
    dens: 13.5, cond: 0.03, cap: 1.0, ...viscous(10), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.25, 0.03, 0.5], desc: 'A glowing lime potion from Noita that heals. Heavy and a little syrupy: it sinks under water.' },
  { key: 'BERSERKIUM', abbr: 'BRSK', name: 'Berserkium', kind: K.LIQUID, render: R.LIQUID, color: '#ef5a26',
    dens: 8.8, cond: 0.03, cap: 1.0, ...viscous(1.5), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.03, 0.35, 0.9], desc: 'A red-orange potion from Noita that drives whoever it touches berserk. Floats on water.' },
  { key: 'POLYMORPHINE', abbr: 'PLYM', name: 'Polymorphine', kind: K.LIQUID, render: R.LIQUID, color: '#ee6fcf',
    dens: 10.4, cond: 0.03, cap: 1.0, ...viscous(1.5), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.04, 0.45, 0.12], desc: 'A pink potion from Noita, and a dangerous one: it turns whoever it touches into something else.' },
  { key: 'PHEROMONE', abbr: 'PHRM', name: 'Pheromone', kind: K.LIQUID, render: R.LIQUID, color: '#ff3d62',
    dens: 9.6, cond: 0.03, cap: 1.0, ...viscous(1.5), spawn: 0.35,
    cold: freezeOf(0, TINCTURE_WATER), hot: boilOf(100, TINCTURE_WATER),
    sigma: [0.03, 0.6, 0.35], desc: 'A sparkling red potion from Noita. Creatures soaked in it become your friends.' },
  // Meat: what a body bursts into when it's killed by overkill (pov/vitals.js
  // GIB_HEALTH): chunks of lean muscle, ~75% water. Thermal properties of lean
  // beef above freezing (ASHRAE Handbook, Refrigeration, "Thermal Properties
  // of Foods"): 1.05 g/cm³ (it sinks, barely), ~0.48 W/(m·K), 4/5 of water's
  // 0.6 (cond: water's 0.03 × 0.8), 3.5 J/(g·K) (cap: 3.5 × 1.05 / 4.18).
  // Raw, it's too wet to burn. It cooks at 71 °C, USDA's safe minimum for
  // ground meat (160 °F; whole cuts 63 °C), past actin's denaturation (DSC,
  // Wright, Leach & Wilding 1977), taking the proteins' denaturation heat
  // first: ~3.5 J/g in beef (3.0-3.8, Oklahoma State beef DSC, 1992),
  // 3.5 × 1.05 / 4.18 ≈ 0.9 cap·°C, about a degree's worth of heating. Chunks
  // pile steeply (slide like snow's).
  { key: 'MEAT', abbr: 'MEAT', name: 'Meat', kind: K.POWDER, render: R.OPAQUE, color: '#d65a64', var: 0.15,
    dens: 10.5, cond: 0.024, cap: 0.88, drag: 0.04, slide: 0.35, spawn: 0.3, sound: 'thunk',
    hot: { T: 71, into: 'COOKED_MEAT', latent: 0.9 },
    desc: 'Raw chunks of a body. Too wet to burn: heat it past 71 °C (fire, lava, steam, the flamethrower) and it cooks. Raw meat does nothing for you.' },
  // Cooked meat: the same chunks, cooked through. Cooking drives out some
  // water: ~3.0 J/(g·K) and ~0.4 W/(m·K) cooked (ASHRAE, as above). Its fat
  // flashes at ~320 °C (beef tallow's flash point, 319 °C, Sigma-Aldrich), so
  // overheated in air it chars and burns, through the same fields as wood,
  // leaving ash. Heat per volume goes as burnHeat / burnRate: cooked beef
  // holds ~10.5 kJ/g (food energy, ~250 kcal/100 g) × 1.05 g/cm³ ≈ 11 MJ/L,
  // dry wood's (0.6 × 18), so it burns at wood's pace; its water keeps the
  // flame cooler than wood's.
  { key: 'COOKED_MEAT', abbr: 'CMET', name: 'Cooked meat', kind: K.POWDER, render: R.OPAQUE, color: '#8a5530', var: 0.15,
    dens: 10.5, cond: 0.02, cap: 0.75, drag: 0.04, slide: 0.35, ignite: 320, burnRate: 0.0018, burnHeat: 3, flameT: 800,
    life: 1, spawn: 0.3, sound: 'thunk',
    desc: 'Meat cooked through. In first person, walk into it to eat it: every chunk heals you. Past 320 °C it chars and burns to ash.' },
];

// σ (S/m) of a conductor given as conducts: true with no elec: a metal. The
// poorest common one, mercury (1.04·10⁶), already loses nothing to speak of.
const ELEC_METAL = 1e6;
// A row of defs with every field filled in (the check scripts add test rows
// the same way: tools/elements-core-check.mjs).
export const elementRow = (d, id) => ({
  id, var: 0, dens: 1000, grav: 0, drag: 0, friction: d.kind === K.POWDER ? 0.25 : 0, jitter: 0, flow: 0, slide: 0, melt: 0, ignite: 0,
  flash: d.ignite ?? 0, burnRate: 0, burnHeat: 0, flameT: 0, temp: 20, life: 0, rad: 0, spawn: 1, sigma: [0, 0, 0], desc: '',
  hard: 0, breakInto: null, meltInto: null, acidProof: false, acid: false, fizz: 0, ash: true, sound: null,
  cold: null, hot: null, crush: null, blast: null, conducts: false,
  ...d,
  grav: d.grav ?? (d.kind === K.POWDER || d.kind === K.LIQUID ? 1 : 0),
  elec: d.elec ?? (d.conducts ? ELEC_METAL : 0),
});
export const ELEMENTS = defs.map(elementRow);

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
  { id: -6, key: 'ENEMY', abbr: 'NPC', name: 'Axeman spawner', color: '#e0453a',
    desc: 'Click a surface: in first person (V) an enemy with every tool appears here, and comes back after it dies. Click it again to remove it.' },
  { id: -30, key: 'GUNNER', abbr: 'GUNR', name: 'Gunner spawner', color: '#e08a2a',
    desc: 'Click a surface: in first person (V) a jetpack gunner appears here. It keeps its distance, flies to high ground and shoots. Click it again to remove it.' },
  { id: -31, key: 'WORM', abbr: 'WORM', name: 'Worm spawner', color: '#b0607a',
    desc: 'Click a surface: in first person (V) a worm burrows in here. It tunnels through rock, bursts out under you and bites; loud noises draw it. WALL and metal stop it. Click it again to remove it.' },
  { id: -32, key: 'GIANTWORM', abbr: 'GWRM', name: 'Giant worm spawner', color: '#7a3550',
    desc: 'Click a surface: in first person (V) a giant worm burrows in here, Noita\'s Jättimato: twenty metres long, seven times as tough as the worm and faster. Click it again to remove it.' },
  { id: -7, key: 'SPAWN', abbr: 'SPWN', name: 'Player spawn', color: '#3fa7ff',
    desc: 'Click a surface: V drops you in at the spawn nearest the cursor, and you respawn there. Click it again to remove it.' },
  { id: -20, key: 'JEEPPAD', abbr: 'JEEP', name: 'Jeep pad', color: '#8fa04a',
    desc: 'Click open ground: in first person (V) a jeep waits here (E to drive it), and a new one comes a few seconds after it is destroyed. Click it again to remove it.' },
  { id: -21, key: 'BIKEPAD', abbr: 'HOVR', name: 'Hoverbike pad', color: '#5fd0e0',
    desc: 'Click open ground: in first person (V) a hoverbike waits here (E to ride it; it skims water), and comes back after it is destroyed. Click it again to remove it.' },
  // TPT's SPRK brush: sparks the conductors inside it (src/electricity.js
  // sparkCell). -8 is left for the Lightning tool (branch el-mat).
  { id: -9, key: 'SPARK', abbr: 'SPRK', name: 'Spark', color: '#ffff80',
    desc: 'Sparks the conductors inside the brush: metal, silicon, water, and switches that are on. Everything else ignores it.' },
  // Fast particles (rays.js RAY_TOOLS): painted into the particle list, not the grid.
  // (Ids from -40: the spawner pads hold -20 and -21.)
  { id: -40, key: 'PHOTON', abbr: 'PHOT', name: 'Photon', color: '#fff6c8',
    desc: 'Packets of light flying straight. Glass, water and ice let them through, metal reflects them, and anything else soaks them up as heat: enough to light wood.' },
  { id: -41, key: 'NEUTRON', abbr: 'NEUT', name: 'Neutron', color: '#20e0ff',
    desc: 'Fast neutrons. They pass through most things; water slows them, and slow ones split plutonium far more readily.' },
  // Lightning is handled by the app too (src/lightning.js): a click strikes a
  // bolt from the top of the box down to the surface under the cursor.
  { id: -8, key: 'LIGHTNING', abbr: 'LIGH', name: 'Lightning', color: '#fff6b0',
    desc: 'Click a surface: a branching bolt strikes it from above, leaving a column of plasma, scorching heat and a pressure crack where it lands. Brush size sets how wide the strike is.' },
  // Magical birds (src/birds/): a flock that lives on this spot. (-30 to -32 are the creature spawners.)
  { id: -33, key: 'FLOCK', abbr: 'BIRD', name: 'Bird flock', color: '#b58cff',
    desc: 'Click a surface: a flock of magical birds lives here. They perch in trees and on roofs, take off when you come near or fire, roost and glow at night, and burn and fall like anything else. Click it again to remove it.' },
];
export const LIGHTNING_TOOL = -8;
export const isSpawnerTool = (id) => id === -6 || id === -7 || id === -20 || id === -21 || id === -30 || id === -31 || id === -32 || id === -33;

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
    desc: `Noita's Holy Mountain: a stone pavilion with ${SHRINE_OFFERS} random perks floating over its plinths. In first person (V), walk into one to take it, and the others vanish. Every world has one near where you start.` },
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
  { id: -115, key: 'BRIDGE', abbr: 'BRDG', name: 'Bridge', color: '#8f6a43',
    variants: [['short', 'Short'], ['long', 'Long']],
    desc: 'A timber footbridge on stone abutments, its trusses for railings. Place it across a gap: only the abutments reach down.' },
];
const GEAR_ID0 = -300;   // the first-person tools' ids (GEAR_ITEMS below), past the constructions'
export const isBuild = (id) => id <= -100 && id > GEAR_ID0;

// First-person tools (src/pov/tools/catalog.js), listed in the palette's Tools
// group: Garry's Mod's spawn menu. Every tool is carried (pov/tools/inventory.js);
// a click puts it in hand; nothing is painted.
export const GEAR_ITEMS = GEAR.map((g, i) => ({
  id: GEAR_ID0 - i, key: `GEAR_${g.key}`, abbr: g.abbr, name: g.name, color: g.color, gear: g.key, model: g.model,
  desc: `${g.desc} First person, key ${g.slot + 1} (${SLOTS[g.slot]}).`,
}));
export const isGearTool = (id) => id <= GEAR_ID0 && id > GEAR_ID0 - 100;

// How the palette is laid out in the UI. Within each group, elements are
// ordered so related materials sit together and the colours run smoothly.
export const PALETTE = [
  { name: 'Powders', items: ['SAND', 'CLAY', 'STONE', 'BROKENCOAL', 'DUST', 'ASH', 'SNOW', 'SALT', 'SHARDS', 'CRYSTAL_DUST', 'SAWDUST', 'COOKED_MEAT', 'MEAT', 'SCRAP', 'RUBBLE', 'NUGGETS', 'LITHIUM'] },
  { name: 'Liquids', items: ['WATER', 'SALTWATER', 'WHISKEY', 'LIQUID_NITROGEN', 'ACID', 'TOXIC', 'OIL', 'SLIME', 'BLOOD', 'MUD', 'LAVA', 'MERCURY'] },
  // Noita's magical liquids
  { name: 'Potions', items: ['TELEPORTATIUM', 'LEVITATIUM', 'HEALTHIUM', 'BERSERKIUM', 'POLYMORPHINE', 'PHEROMONE'] },
  { name: 'Gases', items: ['STEAM', 'CLOUD', 'HYDROGEN', 'OXYGEN', 'CO2', 'PROPANE', 'CAUSTIC_GAS', 'SMOKE', 'FIRE', 'PLASMA', 'MERCURY_VAPOR'] },
  { name: 'Solids', items: ['WALL', 'COAL', 'ROCK', 'LIMESTONE', 'SANDSTONE', 'METAL', 'GLASS', 'CERAMIC', 'ICE', 'DRY_ICE', 'CRYSTAL', 'WOOD', 'FUNGUS', 'PLANT', 'MOSS', 'CLONE', 'BRICK', 'TITANIUM', 'TUNGSTEN', 'GOLD', 'SOLID_MERCURY', 'DIAMOND', 'VOID'] },
  // TPT's Explosives menu (propane stays a gas)
  { name: 'Explosives', items: ['GUNPOWDER', 'FUSE', 'THERMITE', 'NITRO', 'TNT', 'C4'] },
  { name: 'Electronics', items: ['SPARK', 'BATTERY', 'METAL', 'PSCN', 'NSCN', 'SWITCH', 'INSULATOR', 'TSNS', 'PCLN'] },
  { name: 'Radioactive', items: ['PHOTON', 'NEUTRON', 'URANIUM', 'PLUTONIUM'] },
  { name: 'Exotic', items: ['ANTIMATTER', 'SINGULARITY'] },
  { name: 'Tools', items: ['HEAT', 'COOL', 'ERASE', 'BLAST', 'LIGHTNING', 'SIGN', ...GEAR_ITEMS.map((g) => g.key)] },
  { name: 'Entities', items: ['ENEMY', 'GUNNER', 'WORM', 'GIANTWORM', 'SPAWN', 'JEEPPAD', 'BIKEPAD', 'FLOCK'] },
  { name: 'Constructions', items: ['HOUSE', 'TREE', 'CAMPFIRE', 'IGLOO', 'BARREL', 'AQUARIUM', 'FOUNTAIN', 'SHRINE', 'DOCK', 'TOWER', 'STONES', 'WELL', 'MINE', 'WRECK', 'BRIDGE', 'PROMPT'] },
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

// ---- the shared mechanisms: phase changes, reactions, explosives ----
// (fields in the header; docs/elements.md "Shared mechanisms")

// Reactions between two touching cells, in the style of Noita's materials.xml
// <Reaction> rows (see the header). New rows go at the end.
// Clay draws water into its pores by capillary suction: a clay cell and a
// water cell make one of mud and leave air (the water fills CLAY_WATER of the
// clay's volume, the rest of the cell is lost to the pores' slack). A cell's
// worth soaks in over a few seconds (TPT's CLST: 1 in 1500 per frame per
// water cell within two).
const CLAY_SOAK = 0.005;   // chance per step per touching pair
// Antimatter annihilates both cells, each capped at the engine's limits
// (elements ANTIMATTER: E = mc²): enough heat to take the pair, left as air,
// to the temperature clamp (ΔT = heat / (cap_a' + cap_b')), and gas enough
// that each cell's half reaches the pressure clamp by itself.
const ANNIHILATION_HEAT = 2 * ELEMENTS[E.EMPTY].cap * (PHYS.CELL_TEMP_MAX - PHYS.AMBIENT);
const ANNIHILATION_PUFF = 2 * PHYS.P_MAX * PHYS.STEAM_EXPANSION / PHYS.STEAM_BOIL_PUFF;
// On contact (a pair is partners once every RX_PAIRINGS steps: chance 1
// takes it at the first pairing).
const ANNIHILATION_CHANCE = 1;
// What it spares: the wall (the box itself), clone (a device: it copies
// antimatter instead), void (a device: it drains antimatter quietly, as it
// drains anything that moves), itself (a '*' row never pairs an element with
// itself) and a singularity, which swallows it. Diamond is carbon, matter
// like any other: it annihilates (TPT's AMTR spares it).
const ANTIMATTER_SPARES = ['WALL', 'CLONE', 'VOID', 'SINGULARITY'];

// Real speeds go through the sim's clock (physics.js simSteps: a cell is
// CELL_M, and the sim runs SIM_TIME_SCALE× faster than real time, as its
// gravity is real only for ~7 mm cells).
// chance per step that a flame front moving at S (m/s) crosses a cell
const frontChance = (S) => +Math.min(1, 1 / simSteps(CELL_M / S)).toFixed(3);
const capAfter = (into) => (Array.isArray(into) ? into.reduce((s, [k, w]) => s + w * capAfter(k), 0) : ELEMENTS[E[into]].cap);
// heat that brings the products (expected, over a weighted into) from ambient to T
const flameHeat = (T, a, b, into) => {
  const cap = (k, own) => capAfter(Array.isArray(k) ? k.map(([kk, w]) => [kk === 'SAME' ? own : kk, w]) : k === 'SAME' ? own : k);
  return Math.round((T - PHYS.AMBIENT) * (cap(into[0], a) + cap(into[1], b)));
};

// Salt dissolves into water at TPT's pace (WATR.cpp: 1/50 per step). Each
// touch salts the water into brine and, one time in SALT_WATER_CELLS (the
// cells of water a cell of salt saturates: 1.3 / 0.359 g/cm³), uses the salt
// up: it turns into brine too, rather than leave a bubble of air in the water.
// Dissolving takes 3.88 kJ/mol (CRC), so the brine comes out a few degrees
// cooler. Brine is saturated, so it takes up no more. Ice and snow it melts
// down to the eutectic, taking their latent heat (salted roads, the ice-cream
// churn's −21 °C).
const SALT_DISSOLVE = 0.02;
const SALT_SOLUBILITY = 0.359;               // g of NaCl a cm³ of water takes up at 20 °C (CRC)
const SALT_WATER_CELLS = SALT_PILE / SALT_SOLUBILITY;
const SALT_USED = +(1 / SALT_WATER_CELLS).toFixed(3);
const SALT_INTO = [['SALTWATER', SALT_USED], ['SAME', +(1 - SALT_USED).toFixed(3)]];
const SALT_SOLUTION_HEAT = +(heatOf(3.88, SALT_PILE / 58.44) / SALT_WATER_CELLS).toFixed(2);   // per cell of water salted

// Hydrogen burns into steam once past its autoignition point (~570 °C in air;
// Wikipedia, Oxyhydrogen), which a flame's heat gets it to in a few steps
// (0.02 mJ lights it). With air: adiabatic flame 2254 °C, laminar flame speed
// 2.1 m/s (Law, Combustion Physics, 2006); the air it burns with becomes the
// flame. With pure oxygen: ~2800 °C, ~10 m/s, both cells turning to steam (a
// cell of oxygen could burn two of hydrogen, 2H₂ + O₂ → 2H₂O, but a leftover
// half cell of oxygen would leave the pair's heat in too little to hold it:
// one for one keeps the steam at the flame temperature). A flame's touch
// lights it at once (0.02 mJ will): it burns with the flame's own air, both
// turning to steam at hydrogen's flame temperature in air, so one flame burns
// one cell of hydrogen and its heat lights the hydrogen that has air or oxygen
// beside it; hydrogen with nothing to burn with stays hydrogen. The burning gas
// swells with its heat: the products' volume at the flame temperature, less
// what went in, is the puff. 241.8 kJ per mole into steam (LHV); the steam's
// condensing gives the rest of the 286.
const H2_AUTOIGNITE = 570;
const H2_AIR = { T: 2254, S: 2.1 }, H2_O2 = { T: 2800, S: 10 };
const hotPuff = (T, before, after) => Math.round(after * (T + PHYS.KELVIN) / (PHYS.AMBIENT + PHYS.KELVIN) - before);
const H2_AIR_INTO = ['STEAM', 'FIRE'];
const H2_O2_INTO = ['STEAM', 'STEAM'];
const H2_FLAME_INTO = ['STEAM', 'STEAM'];
const H2_FLAME_LIGHTS = 1;                   // chance per step a flame's touch lights it

// Lithium fizzes in water as fast as acid eats (a surface reaction; a real
// 30 cm lump would fizz for many minutes), giving its heat and its hydrogen.
// The water keeps the lithium hydroxide dissolved in it. Saltwater too.
const LI_WATER_RATE = PHYS.ACID_USE;
const LI_WATER_HEAT = heatOf(LI.dH, LI_MOL);

// Hydrogen chloride dissolves into water as it touches it (720 g/L, the most
// soluble common gas), back into acid, giving its heat of solution: a cell of
// gas holds 1/24.06 mol per litre.
const HCL_ABSORB = 1;

// Noita's reaction rates (materials.xml probability) are percentages: chance per step.
const NT_RATE_FULL = 100;
const NT_RATE = (rate) => rate / NT_RATE_FULL;

export const REACTIONS = [
  { a: 'SALT', b: 'WATER', into: [SALT_INTO, 'SALTWATER'], chance: SALT_DISSOLVE, heat: -SALT_SOLUTION_HEAT },
  { a: 'SALT', b: 'ICE', into: [SALT_INTO, 'SALTWATER'], chance: SALT_DISSOLVE, minT: EUTECTIC_T,
    heat: -(PHYS.L_FUSE + SALT_SOLUTION_HEAT) },
  { a: 'SALT', b: 'SNOW', into: [SALT_INTO, 'SALTWATER'], chance: SALT_DISSOLVE, minT: EUTECTIC_T,
    heat: -(PHYS.L_FUSE + SALT_SOLUTION_HEAT) },
  { a: 'HYDROGEN', b: 'EMPTY', into: H2_AIR_INTO, chance: frontChance(H2_AIR.S), minT: H2_AUTOIGNITE,
    heat: flameHeat(H2_AIR.T, 'HYDROGEN', 'EMPTY', H2_AIR_INTO), puff: hotPuff(H2_AIR.T, 2, 2) },
  { a: 'HYDROGEN', b: 'OXYGEN', into: H2_O2_INTO, chance: frontChance(H2_O2.S), minT: H2_AUTOIGNITE,
    heat: flameHeat(H2_O2.T, 'HYDROGEN', 'OXYGEN', H2_O2_INTO), puff: hotPuff(H2_O2.T, 2, 2) },
  { a: 'HYDROGEN', b: 'FIRE', into: H2_FLAME_INTO, chance: H2_FLAME_LIGHTS,
    heat: flameHeat(H2_AIR.T, 'HYDROGEN', 'FIRE', H2_FLAME_INTO), puff: hotPuff(H2_AIR.T, 2, 2) },
  { a: 'LITHIUM', b: 'WATER', into: ['HYDROGEN', 'SAME'], chance: LI_WATER_RATE, heat: LI_WATER_HEAT, puff: LI_H2_VOLUMES },
  { a: 'LITHIUM', b: 'SALTWATER', into: ['HYDROGEN', 'SAME'], chance: LI_WATER_RATE, heat: LI_WATER_HEAT, puff: LI_H2_VOLUMES },
  { a: 'CAUSTIC_GAS', b: 'WATER', into: ['EMPTY', 'ACID'], chance: HCL_ABSORB, heat: heatOf(HCL_SOLUTION, 1 / MOLAR_VOLUME) },
  { a: 'CLAY', b: 'WATER', into: ['MUD', 'EMPTY'], chance: CLAY_SOAK },
  { a: 'ANTIMATTER', b: '*', except: ANTIMATTER_SPARES, into: ['EMPTY', 'EMPTY'], chance: ANNIHILATION_CHANCE,
    heat: ANNIHILATION_HEAT, puff: ANNIHILATION_PUFF },
  // Noita's materials.xml reactions between its materials (nt-mat), at Noita's
  // rates (NT_RATE). Game rules, not chemistry: water washes sludge away
  // (Noita's purification; really it would only dilute it), whiskey dissolves
  // slime to smoke, and Levitatium ([magic_faster]) flashes slime to fire and
  // steam.
  { a: 'TOXIC', b: 'WATER', into: ['WATER', 'SAME'], chance: NT_RATE(13) },
  { a: 'SLIME', b: 'WHISKEY', into: ['SMOKE', 'SAME'], chance: NT_RATE(30) },
  { a: 'LEVITATIUM', b: 'SLIME', into: ['FIRE', 'STEAM'], chance: NT_RATE(50) },
];

// `into` 'SAME' (reactions): the cell stays as it is.
export const SAME = 'SAME';
const SAME_ID = -1;
// Field defaults: a reaction with no temperature gate, a phase change with no
// latent heat (instant) and no gas set free.
const RX_DEFAULTS = { chance: 1, minT: -Infinity, maxT: Infinity, heat: 0, puff: 0, except: [] };

// The temperature at which an element's melt (LAVA) sets back into it: its
// melt point, or the T of a hot phase change into LAVA.
export const meltPoint = (e) => e.melt || (e.hot && [].concat(intoList(e.hot.into)).every(([k]) => k === 'LAVA') ? e.hot.T : 0);
// An `into` as a weighted list [[key, weight], ...].
function intoList(into) {
  if (typeof into === 'string') return [[into, 1]];
  if (Array.isArray(into) && into.length && into.every((o) => Array.isArray(o) && typeof o[0] === 'string' && o[1] > 0)) return into;
  throw new Error(`into ${JSON.stringify(into)}: an element key, or a weighted list [[key, weight], ...]`);
}

// Everything the shared mechanisms need, baked from ELEMENTS and REACTIONS
// into flat tables that the GLSL arrays (elementsGLSL) and the dock tiles' CPU
// twin (ui/tiles/engine.js) both read:
//   outs   every product of every `into`: [id (-1 = SAME), cumulative weight]
//   specs  each `into` as [first out, count]: a cell draws one in proportion
//          to its weight (no draw when there is only one)
//   into   per element, the spec of its cold, hot, crush and blast products
//          (-1 = none), in PH order
//   of     per element, what a LAVA product of each sets back into (-1: the element itself)
//   lifeBank  per element: its latent heat banks in life (life holds nothing
//          else: no spawn life, no fuel); else it changes stochastically
//   cold, hot  per element [T, latent, puff]; crushP the crush pressure;
//          blast [P, T, shock, crushP]; blastLit [flame, air (1 or 0)]
//   rx     per reaction [chance, minT, maxT, heat, puff, spec a, spec b]
//   lookup NE × NE: entry a·NE + b is 0 when a cell of a has no reaction
//          with a neighbour of b, else 2·r + role + 1 (reaction r, role 0 =
//          the cell is the row's a, 1 = its b). Explicit pairs take
//          precedence over wildcards, then earlier rows over later ones.
export const PH = { COLD: 0, HOT: 1, CRUSH: 2, BLAST: 3 };
let baked = null, bakedFor = [];
export function mechanisms() {
  // (baked once per table: the rows themselves, compared by identity)
  const rows = [...ELEMENTS, ...REACTIONS];
  if (baked && rows.length === bakedFor.length && rows.every((r, i) => r === bakedFor[i])) return baked;
  const NE = ELEMENTS.length;
  const outs = [], specs = [];
  const id = (k, ctx) => {
    if (k === SAME) return SAME_ID;
    if (!(k in E)) throw new Error(`${ctx}: unknown element '${k}'`);
    return E[k];
  };
  const spec = (into, ctx) => {
    const list = intoList(into), total = list.reduce((s, [, w]) => s + w, 0);
    specs.push([outs.length, list.length]);
    let cum = 0;
    for (const [k, w] of list) { cum += w / total; outs.push([id(k, ctx), cum]); }
    outs[outs.length - 1][1] = 1;   // the last product closes the draw exactly
    return specs.length - 1;
  };
  const into = [], of = [], cold = [], hot = [], crushP = [], blast = [], blastLit = [], lifeBank = [];
  for (const e of ELEMENTS) {
    const ctx = (f) => `${e.key}.${f}`;
    if (e.melt && e.hot) throw new Error(`${e.key}: melt and hot both set (a hot phase change into LAVA is a melt)`);
    const ph = (p, f) => [p?.into ? spec(p.into, ctx(f)) : -1, p?.of ? id(p.of, ctx(f)) : -1];
    const rows = [ph(e.cold, 'cold'), ph(e.hot, 'hot'), ph(e.crush, 'crush'), ph(e.blast ? { into: 'FIRE', ...e.blast } : null, 'blast')];
    into.push(rows.map((r) => r[0]));
    of.push(rows.map((r) => r[1]));
    const phase = (p) => (p ? [p.T, p.latent ?? 0, p.puff ?? 0] : [0, 0, 0]);
    cold.push(phase(e.cold));
    hot.push(phase(e.hot));
    crushP.push(e.crush ? e.crush.P : 0);
    lifeBank.push(!(e.life || e.burnRate));
    if (e.blast && !(e.blast.P >= 0 && Number.isFinite(e.blast.T))) throw new Error(`${e.key}.blast: P and T are required`);
    blast.push(e.blast ? [e.blast.P, e.blast.T, e.blast.shock ?? 0, e.blast.crushP ?? 0] : [0, 0, 0, 0]);
    blastLit.push(e.blast ? [e.blast.flame ?? 0, e.blast.air ? 1 : 0] : [0, 0]);
  }
  const rx = [];
  const lookup = new Uint16Array(NE * NE);
  const claim = (a, b, r, wild) => {
    if (lookup[a * NE + b]) {
      if (wild) return;
      throw new Error(`REACTIONS[${r}]: ${ELEMENTS[a].key} and ${ELEMENTS[b].key} already react (one reaction per pair)`);
    }
    lookup[a * NE + b] = 2 * r + 1;
    lookup[b * NE + a] = 2 * r + (a === b ? 1 : 2);
  };
  const order = [...REACTIONS.keys()].sort((i, j) => (REACTIONS[i].b === '*') - (REACTIONS[j].b === '*'));
  REACTIONS.forEach((row, r) => {
    const x = { ...RX_DEFAULTS, ...row }, ctx = `REACTIONS[${r}] (${x.a} + ${x.b})`;
    if (!Array.isArray(x.into) || x.into.length !== 2) throw new Error(`${ctx}: into is [what a becomes, what b becomes]`);
    if (!(x.chance > 0 && x.chance <= 1)) throw new Error(`${ctx}: chance is a probability per step, in (0, 1]`);
    if (x.a === x.b && JSON.stringify(x.into[0]) !== JSON.stringify(x.into[1]))
      throw new Error(`${ctx}: a cell reacting with its own element can't tell a from b: give both the same into`);
    rx.push([x.chance, x.minT, x.maxT, x.heat, x.puff, spec(x.into[0], ctx), spec(x.into[1], ctx)]);
  });
  for (const r of order) {
    const x = { ...RX_DEFAULTS, ...REACTIONS[r] }, ctx = `REACTIONS[${r}]`;
    const a = id(x.a, ctx);
    if (x.b !== '*') { claim(a, id(x.b, ctx), r, false); continue; }
    // '*': any matter (not air) but itself and the exceptions
    const except = new Set([E.EMPTY, a, ...x.except.map((k) => id(k, ctx))]);
    for (let b = 0; b < NE; b++) if (!except.has(b)) claim(a, b, r, true);
  }
  baked = { outs, specs, into, of, cold, hot, crushP, blast, blastLit, lifeBank, rx, lookup };
  bakedFor = rows;
  return baked;
}

const fl = (x) => (x === Infinity ? '1e30' : x === -Infinity ? '-1e30' : f(x));
// The mechanisms' tables as GLSL arrays (each at least one entry long: GLSL
// has no empty arrays).
function mechanismsGLSL() {
  const m = mechanisms();
  const pad = (arr, empty) => (arr.length ? arr : [empty]);
  const outs = pad(m.outs, [SAME_ID, 1]), specs = pad(m.specs, [0, 1]), rx = pad(m.rx, [0, 0, 0, 0, 0, 0, 0]);
  const ivec4s = (rows) => rows.map((r) => `ivec4(${r.join(', ')})`).join(', ');
  return [
    ...Object.entries(PH).map(([k, v]) => `#define PH_${k} ${v}`),
    `#define NOUT ${outs.length}`,
    `#define NSPEC ${specs.length}`,
    `#define NRX ${rx.length}`,
    `#define RX_ANY ${m.rx.length > 0}`,
    `const vec2 OUT[NOUT] = vec2[NOUT](${outs.map(([i, c]) => `vec2(${f(i)}, ${fl(c)})`).join(', ')});`,
    `const ivec2 SPEC[NSPEC] = ivec2[NSPEC](${specs.map(([a, n]) => `ivec2(${a}, ${n})`).join(', ')});`,
    `const ivec4 INTO[NE] = ivec4[NE](${ivec4s(m.into)});`,
    `const ivec4 OF[NE] = ivec4[NE](${ivec4s(m.of)});`,
    `const vec3 COLD[NE] = vec3[NE](${m.cold.map((c) => `vec3(${c.map(fl).join(', ')})`).join(', ')});`,
    `const vec3 HOT[NE] = vec3[NE](${m.hot.map((c) => `vec3(${c.map(fl).join(', ')})`).join(', ')});`,
    `const float CRUSH_P[NE] = float[NE](${m.crushP.map(fl).join(', ')});`,
    `const vec4 BLAST[NE] = vec4[NE](${m.blast.map((c) => `vec4(${c.map(fl).join(', ')})`).join(', ')});`,
    `const bool LIFE_BANK[NE] = bool[NE](${m.lifeBank.join(', ')});`,
    `const vec2 BLAST_LIT[NE] = vec2[NE](${m.blastLit.map((c) => `vec2(${c.map(fl).join(', ')})`).join(', ')});`,
    `const vec4 RX[NRX] = vec4[NRX](${rx.map((r) => `vec4(${r.slice(0, 4).map(fl).join(', ')})`).join(', ')});`,
    `const float RX_PUFF[NRX] = float[NRX](${rx.map((r) => fl(r[4])).join(', ')});`,
    `const ivec2 RX_INTO[NRX] = ivec2[NRX](${rx.map((r) => `ivec2(${r[5]}, ${r[6]})`).join(', ')});`,
  ];
}

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
    `const float MELT[NE] = float[NE](${ELEMENTS.map((e) => f(meltPoint(e))).join(', ')});`,
    floatArr('IGNITE', 'ignite'),
    floatArr('FLASH', 'flash'),
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
    boolArr('ACIDIC', 'acid'),
    floatArr('FIZZ', 'fizz'),
    boolArr('LEAVES_ASH', 'ash'),
    vec3Arr('COLOR', (e) => hexToLinear(e.color).map((v) => +v.toFixed(4))),
    vec3Arr('SIGMA', (e) => e.sigma),
    ...mechanismsGLSL(),
  ].join('\n');
}
