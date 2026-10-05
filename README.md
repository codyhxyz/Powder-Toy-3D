# Powder Toy 3D

![Powder Toy 3D: a volcano erupts on a voxel island, lava runs down the slopes and sets the trees on fire](docs/hero.jpg)

A GPU-native, 3D falling-sand sandbox in the spirit of The Powder Toy, built on three.js (WebGL2).
Every cell of a 128³ grid (2.1M cells, up to 160×96×160) is simulated and raymarched on the GPU, at ~240 sim steps/s.

```sh
npm install
npm run dev        # http://localhost:5173  (?preset=lab|volcano|empty&size=64|96|128|wide)
```

## Controls

Press `?` in the app for the full list.

| Painting | |
|---|---|
| Left-drag | paint with the selected element or tool (the brush stays at the height where you clicked) |
| `[` `]` or Shift + scroll | brush size |
| `B` / `X` | sphere or cube brush / paint over existing material |
| `I` | pick the element under the cursor |
| ⌘Z / Ctrl+Z | undo the last stroke, clear or scene change |
| `/` | find an element |

| Camera | |
|---|---|
| Right-drag or ⌥-drag | orbit |
| Shift + right-drag or middle-drag | pan |
| Scroll | zoom |
| `W` `A` `S` `D`, `Q` `E` | move, down/up (hold Shift to go faster) |
| `R` | reset the camera |

| Everything else | |
|---|---|
| Space / `.` | pause / step one frame |
| `1`–`5` | switch view |
| `T` | show or hide the element dock |
| `,` | settings |
| `P` | save a screenshot |

Hovering shows the element, temperature and air pressure under the cursor. Settings are remembered between visits.

## Elements

The dock groups elements like a periodic-table strip, each tile in the element's colour with a TPT-style abbreviation:

- **Powders:** SAND, STNE, GUNP, ASH, SNOW
- **Liquids:** WATR, ACID, OIL, LAVA
- **Gases:** WTRV (steam), SMKE, FIRE
- **Solids:** WALL, METL, GLAS, ICE, WOOD, PLNT, CLNE
- **Tools:** HEAT, COOL, ERAS, PRES (pressure), SIGN
- **Constructions:** HOUS (cottage, log cabin, brick, greenhouse), TREE (oak, pine, birch, palm, willow, dead), CAMP, IGLO, BRRL (oil drum, powder keg), AQUA, FNTN

All element properties live in one table (`src/elements.js`) that is baked into the shaders as GLSL constants.

## Constructions

Constructions are whole structures placed with one click (`src/constructions.js`). Unlike TPT's stamps they are generators:
each one is built from a seed, a size (the brush size) and a variant, so every tree is different. With *Shuffle* selected a
random variant is picked per placement, and *New seed* rolls a different one. A ghost of the exact model follows the cursor
and turns its front (the door) toward the camera.

They are made of ordinary elements and behave like them: wooden walls burn, the stone chimney draws smoke up from the fireplace,
an igloo melts, a powder keg goes off. Placing one uploads it as a small 3D texture that a single GPU pass (`src/shaders/stamp.js`)
writes into the grid. Solid bases grow a footing straight down to the first thing that can bear weight (up to 32 cells), so a house
on a ledge gets a plinth and one in a lake stands on stilts.

## How the physics works

Per simulation step there are three GPU passes over the state (two RGBA32F textures packed as a 2D atlas of Y-slices):

**1. Movement: a Margolus block cellular automaton** (`src/shaders/move.js`).
The grid is split into 2×2×2 blocks whose partition shifts by one cell every step.
Each block is solved once (one fragment per block, written to 8 MRT attachments as "which cell lands here and with what velocity").
A gather pass then rebuilds the grid. Blocks only permute their cells, so mass is conserved exactly
and two particles can never race for the same cell, which is the usual problem with GPU falling sand.

Movement is velocity-driven. Each particle carries a velocity (cells/step) and tries to move along each axis with probability |v|.
Density decides whether it can displace its neighbour, so sand sinks through water, oil floats, steam bubbles up, and snow and ash float.
- Collisions between particles exchange momentum (density as mass, restitution 0.3), so impacts and blasts travel through piles.
  Slow contact acts as support.
- Blocked powders topple diagonally, which gives conical piles. Grains only feel friction while resting on something.
- Falling liquids turn their momentum into sideways splash. Liquid with a hydrostatic head keeps flowing until it levels out.
  Thin films on dry ground feel surface tension (cohesion toward neighbouring liquid), so they gather into puddles with clean edges.
- Gases are buoyant and brownian. Trapped gas slides along ceilings.

**2. React** (`src/shaders/react.js`): everything local.
- **Heat conduction** uses a symmetric pairwise flux (`min(cond_a, cond_b)·ΔT`) divided by volumetric heat capacity, so energy is conserved.
  Conductances are in realistic ratios: air insulates (~1/60 of rock), and metal conducts.
- **Latent heat.** Water, ice, snow and steam pin their temperature at 0 °C or 100 °C while banking energy until a full latent heat
  (80 for fusion, 540 for vaporisation, in water-heat-capacity units) has been absorbed or released.
  That's why ice keeps water at 0 °C, why boiling takes a while, and why lava hitting the sea makes a burst of steam and a rock crust.
- **Convection.** Air density depends on temperature, so hot air rises and carries heat.
- **Combustion.** Flammables above their ignition temperature that touch air burn their fuel, release heat and spawn flames into
  neighbouring air. Fire spreads purely through temperature. Gunpowder detonates.
- **Phase changes.** Melting turns material into lava that remembers its origin: stone becomes stone again, sand becomes glass, metal becomes metal.
  Acid dissolves things, plants grow into water, and clone emits forever.
- **Air pressure.** Pressure diffuses, and a shock front also propagates one cell per step with exponential falloff, blocked by solids.
  Its gradient accelerates matter (a = −∇P/ρ), so explosions throw things and walls shield them.
- **Forces.** Gravity, buoyancy, drag and jitter.

**3. Brush** (only while painting).

## Rendering

`src/shaders/render.js` raymarches the voxel grid directly with an Amanatides–Woo DDA:
- A 4×4×4 brick occupancy map skips empty space.
- A per-frame voxel shadow map is traced from the sun. It records the opaque depth plus optical depth through liquids, glass and gas,
  so water casts tinted shadows and smoke casts soft ones. Where the map's filter taps disagree (within a texel of a shadow edge),
  an exact DDA ray toward the sun settles it. Edges stay crisp and match per-pixel ray-traced shadows to within 0.3%,
  for a fraction of the cost.
- Opaque faces get smooth per-corner AO.
- Liquids and glass get Beer–Lambert absorption, a Fresnel reflection with a smoothed surface normal, and in-scattering.
- Steam and smoke are participating media, rendered as soft blobs whose opacity scales with local gas density, so plumes read as clouds.
- Anything above ~500 °C glows with blackbody incandescence (hot metal turns red, lava yellow-white).
  That glow is blurred into a coarse light volume that lights the surroundings.
- The raymarcher writes depth, so three.js lines and the brush composite correctly.

### Views

Number keys switch between five views (the views menu shows a live thumbnail of each). Colormaps live in `src/views.js` and are baked
into the shader, so the on-screen legend always matches.

| Key | View | Shows |
|---|---|---|
| `1` | Realistic | sunlight, shadows, see-through water, glowing hot things |
| `2` | Heat | temperature, from blue below freezing through grey at room temperature to white-hot; warm air glows |
| `3` | Pressure | the air pressure field as a cloud, and where blasts hit surfaces |
| `4` | Flow | what's moving and which way: falling, sliding, rising, plus moving air |
| `5` | X-ray | everything see-through in its own colour, denser materials more solid |

## Signs

Pick the SIGN tool and click any surface to pin a label (Enter to save, Escape to cancel, click a sign to edit, × to delete).
Signs can show live values from the cell they're attached to: `{t}` temperature, `{p}` pressure, `{e}` element.
A small GPU probe pass reads those values and dims signs that are hidden behind voxels.

## Known simplifications

- Ice and other solids are static (no rigid bodies), so ice doesn't float.
- No incompressible pressure solve for liquids, so communicating vessels don't equalise.
- A buried clone can't erupt: there's no magma pressure, and it only emits into empty neighbours.
- The latent heat of vaporisation is real, but steam doesn't expand ~1600×. One cell of water makes one cell of steam.
