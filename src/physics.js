// Engine constants. The GPU passes get them as GLSL #defines (physicsGLSL, in
// the shared prelude) and the CPU port that runs the dock tiles
// (src/ui/tiles/engine.js) imports the same object, so the two can't drift.
// Per-element numbers live in elements.js; these are the rules around them.
export const PHYS = {
  AMBIENT: 20,               // °C, room temperature
  KELVIN: 273.15,            // °C to K

  // heat (react.js)
  AIR_AMBIENT_PULL: 0.002,   // per step, the open world above the box pulls air back to ambient
  L_FUSE: 80,                // latent heat of melting/freezing, cap·°C
  L_BOIL: 540,               // latent heat of boiling/condensing, cap·°C
  CELL_TEMP_MIN: -273.15,
  CELL_TEMP_MAX: 6000,
  // Each face moves at most this share of the energy that would bring the
  // smaller-capacity cell of the pair to the other's temperature, per step:
  // |flux| ≤ |ΔT|·min(Ca, Cb)·COND_FLUX_SHARE. With one share per face (1/6),
  // a cell's new temperature is a weighted mean of its own and its
  // neighbours', so conduction can't overshoot whatever cond/cap an element
  // has. This is elements.js's stability rule (6·cond/cap < 1) enforced per
  // face, so no current pair reaches it.
  COND_FLUX_SHARE: 1 / 6,

  // air (common.js, react.js)
  AIR_DENS_SPAN: 2000,       // °C over which air thins...
  AIR_DENS_LO: -0.2,         // ...clamped to these offsets from 1
  AIR_DENS_HI: 0.45,
  AIR_BUOY_LO: -0.5,         // buoyancy of air, in g, per (T - ambient) / ambient K
  AIR_BUOY_HI: 2,

  // pressure (react.js)
  P_DIFFUSE: 0.12,           // Laplacian diffusion per step
  P_FRONT: 0.88,             // a shock front keeps this much per cell travelled
  P_DECAY: 0.97,             // per step
  P_ACCEL: 0.06,             // a = -∇P · P_ACCEL / ρ
  RHO_SCALE: 0.1,            // density to inertia
  RHO_MIN: 0.25,
  P_MIN: -50,
  P_MAX: 200,

  // forces (react.js)
  V_MAX: 1,                  // cells/step
  FLOW_SURFACE: 0.6,         // a pool's surface flows at this share of FLOW
  FLOW_KICK: 0.5,            // re-pick a flow direction below this share of the target speed
  FILM_KEEP: 0.5,            // a film on dry ground keeps this share of its velocity...
  FILM_COHESION: 0.3,        // ...and is pulled toward neighbouring liquid by this share of FLOW
  DROPLET_WANDER: 0.1,       // chance per step an isolated droplet picks a new direction
  DROPLET_SPEED: 0.5,        // share of FLOW it wanders at

  // rest states (react.js, move.js, activity.js). Resting matter is a true
  // fixed point of the step, so the activity map can skip it without
  // changing the physics; these say how still "resting" is.
  // cells/step: a held cell's velocity components below this snap to 0 (drag
  // decays them but never to 0). It has to beat the most a cell can pick up
  // per step from pressure that counts as none: P_ACCEL·REST_P/RHO_MIN = 2.4e-4.
  REST_V: 0.001,
  REST_P: 0.001,             // pressure this small counts as none (it decays geometrically, never quite to 0)
  REST_V_SLOP: 0.0001,       // cells/step, float slop on air's jitter-speed bound (activity.js)
  // °C: air within this of ambient can sleep, and so can matter touching air.
  AIR_REST_T: 1,
  // °C: other matter can sleep within this of each face neighbour. Chosen so
  // a matter face at the tolerance carries no more heat per step than an air
  // face at its tolerance: metal, the best conductor, 0.1·0.01 = 0.001, the
  // same as air's 0.0005 across 2·AIR_REST_T.
  //
  // Energy bound. A sleeping region changes nothing inside, so the only heat
  // skipping fails to book crosses its boundary, one-sided: the awake side
  // conducts with a frozen cell that doesn't book its half. Both sides are
  // inert (a quiet brick's 26 neighbours are), so each boundary face carries
  // at most 0.001 cap·°C per step by the two tolerances above. That transfer
  // pulls the awake cell toward the frozen one, so a face books at most
  // cap·tolerance before they agree; if anything drives the awake cell past
  // its tolerance instead, it stops being inert and the region wakes at the
  // next activity map (activity.js ACTIVITY_PERIOD). Sleeping air also skips
  // AIR_AMBIENT_PULL, so it keeps up to cap·AIR_REST_T (0.02 cap·°C per cell)
  // that stepping would have handed to the world outside the box.
  MATTER_REST_T: 0.01,

  // movement (move.js)
  GAS_DENS_TOL: 0.02,        // gases only stratify past this density difference
  DRAG_LIQUID_MIN: 0.25,     // moving through liquid is slower: MIN + SPAN·clamp(DENS·Δρ/ρ)
  DRAG_LIQUID_SPAN: 0.75,
  DRAG_LIQUID_DENS: 2,
  LAND_SPLASH_V: 0.15,       // liquids hitting harder than this splash sideways...
  LAND_SPLASH_FLOW: 0.25,    // ...unless already flowing faster than FLOW·sqrt(this)
  LAND_SPLASH_GAIN: 0.3,     // share of the impact speed turned sideways
  LAND_POWDER_KEEP: 0.3,     // grains keep this share of sideways speed on landing...
  LAND_POWDER_SCATTER: 0.12, // ...and scatter by this share of the impact speed
  BOUNCE_LIQUID: -0.7,       // velocity kept bouncing off a wall
  BOUNCE_GAS: -0.5,
  COLLIDE_V: 0.15,           // relative speed for a momentum-exchanging impact
  RESTITUTION: 0.3,
  DIAG_NOISE: 0.6,           // tie-break noise between diagonal candidates

  // reactions (react.js)
  STEAM_BOIL_PUFF: 1.5,      // pressure from water flashing to steam
  // ...which is STEAM_EXPANSION volumes of steam (at 100 °C, 1 atm) per volume
  // of water. Gas set free by other reactions (elements.js fizz: acid on
  // limestone) puffs in proportion to its volume: STEAM_BOIL_PUFF·fizz/STEAM_EXPANSION.
  STEAM_EXPANSION: 1700,
  // Cloud (react.js): droplets of condensed water riding in air. Steam that
  // condenses in open air becomes cloud; onto a surface (a solid, powder or
  // liquid, or the floor), water.
  CLOUD_RAIN: 4e-5,          // chance per step per cloud neighbour past CLOUD_RAIN_NB that it coalesces into a raindrop
  CLOUD_RAIN_NB: 3,          // cloud neighbours a cell needs before it can rain (a dense core, not a wisp)
  CLOUD_EVAP: 3e-5,          // chance per step per air neighbour past CLOUD_EVAP_NB that it evaporates, at ambient...
  MAGNUS_A: 17.625,          // ...scaled by the saturation vapour pressure e_s(T) / e_s(ambient), Magnus form
  MAGNUS_B: 243.04,          // (°C; Alduchov & Eskridge 1996): warm mist vanishes fast, cold fog lingers
  CLOUD_EVAP_NB: 3,          // air neighbours a cell can have and stay (air inside and along a cloud is saturated: wisps and protrusions go)
  CLOUD_EVAP_COOL: 1,        // °C the evaporating cell's air cools by (the latent heat of a real cloud's ~0.5 g/m³)
  PLANT_GROW: 0.006,         // chance per step per neighbouring plant that water becomes plant
  LAVA_FREEZE_BELOW: 150,    // °C under the melting point where lava sets
  FIRE_BURN: 0.02,           // flame life lost per step: BURN + BURN_SPREAD·rnd
  FIRE_BURN_SPREAD: 0.02,
  FIRE_MIN_T: 350,           // °C, flames cooler than this go out
  FIRE_TO_SMOKE: 0.35,       // share of dying flames that leave smoke
  FIRE_LIFE_MIN: 0.5,        // new flame life: MIN + SPREAD·rnd
  FIRE_LIFE_SPREAD: 0.5,
  SMOKE_FADE: 0.003,         // life per step
  ACID_USE: 0.03,            // acid life per victim per step, and chance per acid neighbour to dissolve
  ACID_TO_SMOKE: 0.3,
  FLAME_SPREAD: 0.25,        // chance per burning neighbour that air catches
  FLAME_T_MIN: 0.85,         // new flame temperature: flameT·(MIN + SPREAD·rnd)
  FLAME_T_SPREAD: 0.15,
  CLONE_RATE: 0.06,          // chance per step Clone fills a neighbouring empty cell
  SPAWN_DROP_V: -0.3,        // cells/step: spawned powders and liquids start falling
  GUNPOWDER_FIRE: 0.7,       // chance per step a flame next to gunpowder sets it off
  GUNPOWDER_T: 2200,         // °C of the blast
  GUNPOWDER_P: 60,           // pressure of the blast
  BURN_P: 0.02,              // pressure per step from burning
  ASH_SHARE: 0.5,            // share of burnt-out cells that leave ash
  BURNT_MIN_T: 600,          // °C, a burnt-out cell is at least this hot

  // impacts and breaking (react.js, move.js). Hardness (elements.js hard) is in
  // the sim's kinetic-energy units, ½·dens·|v|² with v in cells/step.
  // Kinetic energy an impact dissipates becomes heat: ΔT = E·KE_TO_HEAT / cap
  // (cap·°C per unit of kinetic energy). Taken literally (a cell is ~30 cm and a
  // step 1/240 s, so 1 cell/step ≈ 72 m/s; dens 10 = 1000 kg/m³; cap 1 = water)
  // the factor would be ≈ 0.12, but a 30 cm cell can't resolve the hot spot at
  // a contact patch, which is what really lights powder, so this stands in for
  // it. Two cases set it. A slug breaking a keg's wood (hard 20) leaves sawdust
  // (cap 0.3) 20·3/0.3 = 200 °C hotter: past gunpowder's 200 °C ignition, so the
  // keg goes off, but under sawdust's own 250 °C, so a shot plank doesn't
  // smoulder. And sand dropped 10-50 cells onto rock warms the floor layer by
  // ~10 °C (each grain lands once at ≤ 0.6 cells/step, E ≤ 2.9, and passes on
  // the knocks of the grains landing on it), which conduction soon spreads.
  KE_TO_HEAT: 3,
  // A solid breaks when the air pressure difference across it, along any axis,
  // exceeds hard·P_BREAK_PER_HARD (pressure per unit of hardness; a solid
  // neighbour holds no air and counts as 0). One gunpowder cell's blast is
  // GUNPOWDER_P (60) and loses ~15% per cell, but a pile lit by a flame goes off
  // in a wave that stacks its blasts: ~140 at the edge of a 3³ pile, ~200 at a
  // 5³ one, still ~100 four cells out. So glass (8 → 40) and ice and plants
  // (6 → 30) smash a few cells from even one cell's blast, wood (20 → 100) a few
  // cells from a lit pile, rock (30 → 150) chips only right next to a big one,
  // and metal (60 → 300) never does: no pressure difference in the sim exceeds
  // P_MAX - P_MIN = 250.
  P_BREAK_PER_HARD: 5,

  // tools (passes.js), applied once per frame
  TOOL_HEAT: 30,             // °C at the brush centre
  TOOL_PRESSURE: 6,
  TOOL_FALLOFF: 0.6,         // full strength inside this share of the radius
};

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const physicsGLSL = () =>
  Object.entries(PHYS).map(([k, v]) => `#define ${k} ${v < 0 ? `(${f(v)})` : f(v)}`).join('\n');
