# Grimorium vs ours: detail made in the shader, nothing stored per cell

Source: `text/Y8HRCXxI0BY.txt` (timestamps below are into it). Our code was read in the worktree at base ff1d35e6.
Nothing was run. Every distance and cost below is arithmetic from constants or a figure someone else measured,
and says so.

## 1. What Grimorium does

**(a) Grass and the like built inside the cell.**
- "Grass, for example, doesn't render as a cube. When a ray enters it, the shader builds a little cluster of
  individual blades inside the voxel space and checks the ray against those instead." (07:02)
- "That geometry is generated on the spot the moment the ring needs it using deterministic logic seeded by the
  voxel's coordinates to ensure it's the same each time." (07:02)
- "Leaves, flowers, and hanging vines all work the same way, as are some creature shaders for things like fur."
  "This allows more variety in appearance without storing any extra information per voxel aside from its ID." (07:02)

**(b) Gas and goo as a density field.**
- "Gas voxels are smoothed out by treating them as a density field rather than discrete voxels, allowing them to
  appear more like rounded blobs." (03:00)
- "The same technique can be applied to creatures to round edges and give a gooey appearance, which I do with the
  slime creatures." (04:07)

**(c) Material properties by ID.**
- "Each surface's material has color, roughness, emissivity, and transparency. For voxels, these values are
  maintained in the shaders for rapid lookup based on the material's ID." (05:03)

**(d) Lensing.**
- "This basically changes the trajectory of the ray at the point it hits the sphere of the spell, but it
  otherwise acts exactly the same." (07:37)
- Also named as distortion effects: "black hole spell, tornado spell, and creature summons." (07:02)

Not said: the blade count, the shape of a blade, what the test costs, how far away it stops, whether blades
cast or receive shadows or ambient occlusion. Their shadow rays are "a second ray from that surface towards each
light source, traversing exactly as the initial ray does" (06:24), so a blade-shaped hit could shadow only if the
shadow ray ran the same shader. The video does not say it does.

## 2. What we do

### (a) Grass, leaves, flowers, vines

**Plant cells are not cubes and not blade geometry. They are a smoothed surface with a drawn texture.**
- `PLANT` is in the `ORGANIC` smooth-surface channel (`src/gfx/materials.js:300`, channel list `:141-146`), the same
  blurred-field surface as rock and wood. The march finds where the blurred field crosses `SURF_ISO` inside
  the cell (`src/shaders/render.js:1448-1493`, `surfCross`), stops (`render.js:1559-1561`, `HIT_SMOOTH`) and
  shades afterwards.
- Shading gathers the 8 cells around the hit to pick the material (`gatherPlan`, `src/shaders/gfx/surface.js:1840-1905`).
  If none match, it opens a 27-cell search.
- **Grass** (`AP_GRASS`): the "leafy_grass" photo and its normal map (`surface.js:1034`, `matTextured` `:1043`).
  The blades are only a highlight widening and some light through them: `m.slopeVar = GRASS_BLADE_SLOPE_VAR *
  unresolvedShare(...)`, `m.sssCol = LEAF_DEEP_TINT`, `m.trans = 1.0` (`surface.js:1048-1053`). Blade size
  `GRASS_BLADE_M = 0.005` m (`:424`). The texture fades with `lodFade(GRASS_BLADE_F, fp)` (`:1049`).
- **Leaves** (`AP_LEAVES`, tree crowns are smooth balls: e.g. `src/world/scenes/descent/scenes.js:477`):
  not geometry, but a per-pixel pattern. `mCell` finds a seed; each cellular cell is a leaf ellipse with its own
  tilt, hue, midrib and wax, and between leaves the shader paints "the shaded depth of the clump"
  (`surface.js:1424-1473`, `LEAF_M = 0.035` m). Tilt becomes a bumped normal (`m.g`, `:1478`), clump-scale
  noise adds lumps and hollows (`leafClumps`, `:417-428`, `:1480-1482`). It fades with
  `lw = lodFade(LEAF_F * LEAF_LOD, fp)` (`:1458`); at `lw <= 0` it skips the neighbour search (`:1459-1463`).
  So the leaf pattern is a function of the surface point, not stored per cell. This is the same "no data per cell"
  property, but it makes no silhouette, no parallax and no gaps a ray can pass through.
- **Flowers and vines:** no such element or appearance. Plant appearances are `AP_GRASS`, `AP_LEAVES`, `AP_PLAIN`
  (`src/appearance.js:95`). (Nothing found by search for a flower/vine element; I did not check the Cozy or
  Noita look files for one.)
- The other two looks draw plants their own way (`src/shaders/gfx/cozy.js:181`, `:276`). Not read in detail.

**We already do in-cell geometry, for stone and crystals. This is the closest precedent.**
- Rubble cells are filled with real chip geometry: "Rays walk the sub-lattice through the gravel cells they cross
  and test only the eight sites nearest each stretch of the ray (exact ray-ellipsoid hits)" (`src/shaders/gfx/grains.js:2-30`).
  Seeded by the cell, nothing animated, "a hash of the cell's seed and nothing else" (`grains.js:34-37`).
- It hooks the march per cell: `grainEvent(...)` (`render.js:1513-1517`), and a hit becomes `EV_GRAIN` (`render.js:1558`).
  It can come first in a cell before the smooth surface (`grains.js:669-760`).
- Caps: `PEB_MAX_STEPS = 24` sub-lattice steps a ray, `PEB_SUN_STEPS = 8` for chips' own sun shadow
  (`grains.js:184-185`). Contact darkening from the touching chips and sun shadow from the chips between it and the sun,
  "the shadow map is far too coarse for them" (`grains.js:21-22`, `:786-810`).
- Fade is by screen-space error, not by mip rule: `grainW` = `1 - smoothstep(PEB_FP_FULL, PEB_FP_NONE, fp)`
  (`grains.js:232-235`, `:170-171`), 4 px to 8 px of error (`lodFade.js:17-28`). In the band both paths are traced
  and crossfaded (`gAlt*`, `grains.js:669-674`, `:709-746`).
- Crystals are another: a prism seeded by its cell, hit analytically in the march by `crispHit` -> `crystalHit`
  (`surface.js:1998-1999`, `src/shaders/gfx/crystal.js:20-31`, `render.js:1233`); "the shadow map does too".
- Our own recorded cost for this kind of thing: pebbles "high: volcano eyeSummit +17, eyeFlank +12 ms", clods
  "volcano eyeFlank +14, lab +9 ms" (`src/gfx/detail.js:72-79`; M-series, 1280x800, 2026-10-08, shared GPU, so rough).
- Detail Off / Balanced / Full: `high` cost tier is on only at Full (`detail.js:27-31`, `:187`). Grain variants also
  give up the split march stages (`src/shaders/world/march.js:481` `marchSplits`), and lose the brick-surface
  certificate in gravel (`march.js:309`).

**Shadow and AO for plants today.**
- Sun: cascaded shadow map with PCSS, traced from the cells and fields (`src/shaders/world/lightWriters.js:54`,
  `light.js:441-470`). A cascade texel is far bigger than a 5 mm blade or a 3.5 cm leaf, so neither shadows
  anything at their own scale. Dappled light under trees is faked (`sssCol`, `trans`, and the
  constants at `surface.js:2219-2225`, which I did not read further).
- AO: `fieldAO` probes the smooth field along the normal at 1.5, 3 and 5 cells (`src/shaders/gfx/lighting.js:620-640`).
  That sees creases at cell scale, not between blades.
- `light.js:466` records that the old cascade pick (about 100 reads a pixel over foliage) "was most of the world
  march's per-pixel cost". That is already fixed (single exit, one tag pair). It says foliage pixels were the
  dearest because the sun lookup is inlined at each tracer call and foliage is where there are many.

### (b) Gas and goo

- Gas is not rounded blobs; it is a volume. Smoke, steam and fire are blurred density fields (`MEDIA`,
  `src/gfx/materials.js:161-166`) marched with jittered samples, noise displacement, Henyey-Greenstein phase and
  multiple-scatter octaves (`src/shaders/gfx/media.js:1-40`). Costs are tiered: fire "+16", smoke/steam "+9 ms" as
  `high` options (`detail.js:80-103`).
- Goo and liquid: the `LIQUID` and `GRANULAR` channels are blurred fields drawn as surfaces, with a cubic
  (B-spline) reading up close so they come out round (`materials.js:141-146`, `detail.js` cubicClose, `:110`).
  So the "density field makes it rounded" idea is how all our non-crisp matter already works.
- The plain "blocks" look draws gas as soft faces with noise, `BK_GAS_*` (`src/shaders/blockPlainShared.js:83-90`).
  That is the non-raymarched fallback, not the main look.
- Creatures: no slime or creature goo shader found; enemies are meshes (I did not search the NPC code for a soft look).

### (c) Material table by ID

- One struct per element in the element tables, read through accessors by element ID (`materials.js:706-722`,
  `MATERIAL_FIELDS`: albedo, surface channel, texture map, macro variation...). Same idea as theirs, with more
  fields; roughness, emission and transparency are in `LOOK` (`materials.js:579`). No gap here.

### (d) Black hole and SING

- Wand black hole: a drawn sphere. Style `void` is a black heart with a swirling band and bright rim, premultiplied
  blend so one draw both darkens and glows (`src/pov/wands/visuals.js:11-14`, `:64`, `:148-155`, `VOID_ALPHA 0.92` `:71`). It is a mesh over the frame, depth-tested, with no bending of what is behind it.
  The spell itself "opens an excavating sphere" (`src/pov/wands/catalog.js:94`).
- `SINGULARITY` (TPT's SING) is an ordinary powder cell: `materials.js:445` is albedo `#000000`, rough 1;
  `elements.js:870-876` is the physics (matter-consuming). It is drawn as a black granular cell, no lens.
- **The march can already restart a ray along a new direction.** Glass and liquid bend rays by resetting
  `ro`, `rd`, the DDA and `tEnter` (`render.js:1395-1425`, `bends`, `MAX_BENDS = 6` at `:840`, gated by
  `FU.bending`; crystal interfaces at `:1211`). A "curved" march variant warps the walk for the rolling-log
  presentation (`render.js:220-248`, `gfx/presentation.js`). So the machinery Grimorium describes for lensing exists.
  Nothing uses it for spells. The far field: whether the far pass can take a restarted ray I did not check.

## 3. Side by side

| Thing | Grimorium | Ours | Verdict |
|---|---|---|---|
| Grass blades | Ray tests a cluster of blades inside the cell (07:02) | Photo + normal map on the smooth surface; blades only widen the highlight (`surface.js:1048-1053`) | Gap. Real blade shapes absent |
| Leaves | Same, in-cell (07:02) | Per-pixel leaf pattern with tilt and shaded gaps, no silhouette (`surface.js:1424-1482`) | Partial: reads as leaves, flat edge and no see-through |
| Flowers, vines | In-cell, same trick (07:02) | None exist | Gap (needs elements first; the shape trick is separate) |
| Fur | In-cell, creature shaders (07:02) | Not found | Not checked |
| Seeded by cell, nothing stored | Yes | Yes for gravel, crystals, leaves (`grains.js:34-37`, `crystal.js`, `surface.js:1467`) | Same |
| Distance fade | Not said | Mip rule for textures (`lodFade.js`); footprint error band for geometry (`grains.js:232`) | Ours is defined; theirs unknown |
| Shadow/AO on tiny shapes | Not said | Gravel has its own contact AO + 8-step sun walk (`grains.js:786-810`) | We have a pattern to copy |
| Gas | Density field, rounded blobs (03:00) | Full volume march, scattering, flames | We are ahead |
| Goo | Density field on slimes (04:07) | Blurred field surfaces with cubic reading for liquid/powder (`materials.js:141`) | Same idea for matter; no creature goo |
| Material by ID | Table in shader (05:03) | Same, bigger (`materials.js:706`) | Same |
| Black hole lens | Bend ray at the sphere (07:37) | Drawn sphere, no bend (`visuals.js:148`); bend machinery exists (`render.js:1395`) | Gap, cheap to close in the march |

## 4. Anything worth trying

Ranked by look gain against frame-time risk.

### 1. Black-hole lens (best value, lowest risk)
- What the player sees: the sky, terrain and creatures behind a black hole bend around it, instead of a dark ball
  with a swirl. It is the one effect that makes it read as a black hole. Touchstones: Noita, Halo 3.
- Where: the same restart the glass uses (`render.js:1395-1425`): once per ray, test the ray against a spell sphere
  (positions from a uniform array of at most a few), set `rd` to a bent direction, restart at the sphere's rim,
  count it in `bends`. Costs a ray-sphere test per ray plus nothing for pixels that miss it. It must reach the
  world march and the far field and every map ("same features in every world"). The wand `void` shell at
  `visuals.js:148` would shrink to a rim and swirl, or go away (the lens draws its black core).
- Risks: rays crossing it count toward `MAX_BENDS`; TAA and temporal upscaler history near the edge; the
  sun-shadow map does not bend (acceptable, it is a spell). The cost view should show the lensed pixels as ordinary.
- Test needs: a CPU fixture that bends a ray analytically and checks it exits where the maths says; then one pose
  with the black hole in frame on the profiler, with the hole present and absent, same camera: it should show
  nothing outside the circle's pixels, and the pass table should show the march moving by under the profiler's noise.
  Hypothesis to state before a GPU run: only pixels inside the lens disc take any extra work.
  (No GPU ask here; this is the sketch.)

### 2. Grass blades as real shapes, near the camera only (big look gain, real cost)
Plain version: from a few steps away, a meadow stops being a textured sheet and becomes upright strokes with
see-through gaps.
- Why it is not a copy of theirs: their plant cell is a cube, so the blades fill the cell. Ours is a blurred surface.
  The blades must stand on the surface wherever it crosses the cell, not on the cell's floor. Grains already solved
  the same shape: `fillCand`/`gPebInside` lets an empty cell above the surface hold the neighbour's chips
  (`grains.js:683-690`, `:735-746`).
- Where: a new `blades` branch beside the grain hook (`render.js:1513-1517`, `grains.js:675`), a `DETAIL` entry
  (`detail.js:73`), cost tier `high` (on at Full only). A blade belongs to a 2D lattice of sites (5 mm = about
  60 per cell, so use a coarser lattice of tufts, a few blades each, as pebbles do with `PEB_N`), rooted on the
  field's surface (root = the iso-point, found with the same `surfCross` already run for the cell). Test the
  ray against a thin shell above the root. Hit = a capsule or tilted quad; seed = hash of the lattice site,
  as `grains.js:34-37`.
- Reads already done in that cell: the 3 surface samples (`render.js:1459-1469`, phiA/phiM/phiB), `fetchA` only for
  grain elements (`render.js:1515`). A blade branch would add `fetchA(cell)` for plant cells, and in empty cells above
  a surface one `surfField` read (what `gPebInside` does, `grains.js:683`).
- Stop it from floating (this is the hard part): (1) root every blade on the iso-point, so it cannot detach;
  (2) darken toward the root analytically (no reads), like fur shells, which stands in for ambient occlusion; (3) blade
  sun shadow: a short walk toward the sun in the tuft lattice, capped like `PEB_SUN_STEPS = 8` (`grains.js:185`), or
  just use the soil's shadow-map result for the whole tuft plus the root darkening (cheaper, probably enough at
  5 mm); (4) the blades add no cascade-shadow data, so a tuft's shadow on the ground is the cell-scale shadow as
  today. I cannot say whether (3) is needed without looking at it.
- Fade out: blades are 60 per cell, so by the mip rule (`lodFade(60, fp)`, `surface.js:109`) full at `f*fp <= 0.5`
  and gone at `1.0`. At 75-degree vertical FOV and 1080 lines (the numbers `lodFade.js` uses) that is **about
  1.8 m full, 3.5 m gone** (my arithmetic: `fp = dist * pixAng`, `pixAng ~ 0.0014` rad/px, cells are 0.3 m). That is
  a very short range, which is the point: the geometry only matters where the texture's blades are resolved
  anyway. Past it the texture stays. To avoid grains' double trace in the band (`gAlt*`), test blades only for pixels
  whose per-pixel hash is below the fade weight and let TAA average it (stochastic LOD, no second path).
- Cost, honestly: the nearest thing we measured is pebbles at +12 to +17 ms in the worst camera (`detail.js:72`).
  Grass would be a thinner shell and a smaller range, so likely less, but that is a guess. It also would give up
  the split march stages like the grain variants do (`march.js:481`), a hit on every variant that has it.
  Foliage pixels were once the dearest in the march (`light.js:466`), so the plant-cell branch must not
  add loads to the cascade pick; it should reuse `hp`, the normal and the three phi values.
- Test needs: a CPU-only check of the blade test (ray vs capsule) and seeding (same cell, same blades; moves with the
  sim); a visual pose at ~1 m over a lawn at Full vs Balanced; the profiler's `--compare` at three poses (lawn
  down, lawn horizon, forest) to show the cost is only in the near-lawn pose; the cost view should show blade
  pixels with a bounded count. State the hypothesis first: "cost scales with pixels within 3.5 m of grass".
  Per project rule the full-GPU run waits on a stated estimate.

### 3. Leaves as real shapes in tree crowns
Bigger visual gain than grass at distance (leaves resolve out to about 8 m full, 16 m gone, with `LEAF_LOD = 1.5`;
arithmetic as above, `surface.js:1448`, `:1458`) but harder: the crown is a solid in the shadow map and the AO,
so leaves with see-through gaps would need the ray to continue behind the gap and the interior to look lit
there, or the gaps show unlit sky-coloured crown. The current shaded-gap pattern is an answer to exactly that.
Hold until grass shows the approach works. A cheaper step first: add an alpha cut to the existing pattern
(let rays pass through gap pixels, `pm == 0`, and re-enter the march) without any new geometry. That keeps the
solid in the shadow map. Not measured; recommend only after #2.

### 4. Nothing for gas, goo, or the material table
Our gas is already a volume and costs are already tiered; the material table is the same design. No change.
Creature goo (slimes) is blocked on there being a slime; not a rendering fix.

## 5. What the video can't tell us

- How a blade looks (count, width, bend, wind) and whether the whole thing animates.
- What the test costs per ray, how far from the camera it runs, and how they fade it.
- Whether blades are in the shadow rays and ambient occlusion pass, or only in the primary ray (so whether theirs
  float). The video shows no close-up of that.
- What an "ID" cell is when grass sits on a slope: a cube-stepped surface, we assume (their world is blocks; ours
  is a smoothed iso-surface, so the layout above is not theirs).
- Whether the black-hole lens is applied to the far rings, shadow rays, or reflections.
- Any frame time at all. The video gives resolution (1/3 of the window, 07:52) and one GPU (RTX 4060), nothing for
  a single feature.
- Whether flowers and vines exist as elements or only as shader looks of a cell ID.

## Notes on what I did not read

- `surface.js:2219-2225` (the light-through-leaves constants), `cozy.js` and `noita.js` plant looks, the far field's
  grass (`src/shaders/far.js:131`, `:530`), and the NPC code for creature softness.
