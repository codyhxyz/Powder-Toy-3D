# Grimorium's graphics, and what it means for ours

Source: [1] in sources.md, the developer's own 10-minute explainer. Timestamps are into the video
(`text/Y8HRCXxI0BY.txt`). It is the nearest game to ours in kind: a fully simulated microvoxel world,
Noita-like, drawn by tracing rays through the simulation's own cells. It gives no timings, so it can tell us
what a peer chose, not what anything costs.

## What it says

1. **No meshes: trace the simulation's cells.** "Every one of those changes would mean rebuilding meshes …
   With ray casting, the renderer works directly on the same voxel data the simulation uses" (01:55–02:30).
   One compute-shader ray per pixel, stepped cell by cell (DDA, 02:30–02:50).
2. **Skip empty space with the chunk flags.** "the chunk system allows holding information at higher levels
   with flags at different orders of grouping … The voxel by voxel walk is only done when it's genuinely close
   to solid material, bringing the number of checks to only a handful" (03:16–03:41).
3. **A per-pixel cost view.** "a debug view that colors every pixel by how much work its ray had to do"
   (03:41–03:53).
4. **Transparency accumulates; gas is a density field.** Transparent materials "accumulate the colors they
   pass through"; "Gas voxels are smoothed out by treating them as a density field rather than discrete voxels,
   allowing them to appear more like rounded blobs." The same is used on slime creatures for a "gooey
   appearance" (03:53–04:11).
5. **Two coarser rings past the simulated window**: "a mid- ring where voxels are approximated at twice their
   size and a far ring at quadruple size"; a ray that leaves the full-detail region "continues into these rings
   with the same walk" (04:11–04:32).
6. **Four light kinds**: sun (one shadow direction), ambient (a floor "regardless of other light sources"),
   point lights (player, items, glowing cells), and emission that lights nothing else. Emission alone is used
   on purpose: "for some places like creature's eyes, I give a slight emissivity to show them in the dark
   without making the creatures act as light sources themselves" (04:39–05:23).
7. **Every hazard glows.** "I added emissivity to every dangerous voxel type so the player doesn't get
   frustrated by accidentally walking through acid or toxic sludge with little visual cue" (05:52–06:03).
8. **Thousands of glowing cells become a few lights.** "Each chunk is divided into eight octants, and the
   emissive voxels in each octant merge into a single point light. Its brightness scales with how much glowing
   material is there. Each chunk then keeps a list of which lights can reach it", so a shaded point "only
   considers the handful of lights that matter locally" (06:03–06:32). Each light then gets a shadow ray that
   "traverses exactly as the initial ray does" (06:32–06:43).
9. **Soft sun shadows from jittered shadow rays blended over frames** (06:43–06:55). AO "samples the corners
   around each surface point" (05:41–05:52).
10. **Plants are generated inside the cell, not drawn as a cube.** "Grass … doesn't render as a cube. When a
    ray enters it, the shader builds a little cluster of individual blades inside the voxel space and checks the
    ray against those instead. That geometry is generated on the spot … using deterministic logic seeded by the
    voxel's coordinates." Leaves, flowers, hanging vines and creature fur work the same way, "without storing
    any extra information per voxel aside from its ID" (06:55–07:33).
11. **Spell lensing bends the ray.** The black-hole spell's gravitational lens "changes the trajectory of the
    ray at the point it hits the sphere of the spell, but it otherwise acts exactly the same" (07:33–07:52).
12. **One ninth of the pixels.** "The game renders at 1/3 of window resolution, which means tracing 1 ninth as
    many rays", the most a laptop RTX 4060 holds; jittered camera + TAA history; then dither "to hide color
    banding", contrast and brightness (07:52–08:38).

## Our renderer against it

| # | Point | Us | Where |
|---|---|---|---|
| 1 | Trace the sim's cells, no meshes | Same choice | `src/shaders/render.js`, `src/shaders/dda.js` |
| 2 | Empty-space skipping by hierarchy | Same, with bricks and the world march's split stages | `src/shaders/world/march.js`, `docs/march-spill.md` |
| 3 | Cost view | Have it, and more: exact per-pixel counters, read back, with a legend | `src/gfx/costView.js`, `docs/profiler.md` "Cost view" |
| 4 | Gas and goo as a smooth field | Same idea: smooth-surface fields, soft gas | `src/shaders/world/fields.js`, `src/shaders/blockPlainShared.js:83` |
| 5 | Coarser rings past the window | Same idea, one far field at brick size instead of 2× and 4× rings | `src/shaders/far.js` header |
| 6 | Emission that lights nothing | Have it for materials; not checked for enemy eyes | `src/gfx/materials.js` `emit:` |
| 7 | Every hazard glows | Already: acid, toxic sludge and the magic liquids glow faintly in their own colour (borrowed from Noita) | `src/gfx/materials.js:93-100`, `:291`, `:466-474` |
| 8 | Glowing cells clustered into point lights + per-chunk light lists + shadow rays | We went another way, and on purpose: a glow light volume read at the surface, its gradient for direction, three occlusion taps. Our comment records that one shadow ray a pixel to a picked emitting brick "used to flicker under TAA" | `src/shaders/gfx/lighting.js:893-955` |
| 9 | Jittered sun shadow rays + temporal blend | Not applicable: we use cascaded shadow maps with PCSS soft edges sized by the sun's disc | `src/shaders/gfx/lighting.js:162-166`, `src/shaders/world/light.js:460-470` |
| 10 | Grass blades, leaves, vines built inside the cell | **We don't.** Grass is the meadow photo plus a normal map on the cell's faces, with the blades' tilt widening the highlight; leaves likewise | `src/shaders/gfx/surface.js:1032-1053` |
| 11 | Black hole bends the ray | **We don't.** Ours is a drawn sphere with a dark heart (premultiplied blend), no lensing | `src/pov/wands/visuals.js:8-16`, `:71` |
| 12 | 1/9 of the pixels traced + TAA + dither | Similar pipeline (TAAU, dither) but we trace far more: our automatic resolution floor is 1/3 of the pixels, and it steers on a 12 ms GPU budget | `src/gfx/post.js:213` (UPSCALE_FLOOR), `src/gfx/autoResolution.js`, `src/gfx/post.js:933-936` |

## What we missed, ranked

1. **Grass, leaves, flowers and vines as shapes inside the cell (point 10).** The biggest look gain they have
   that we don't: a meadow or a hedge stops reading as a textured block from up close, with no new data per
   cell (shape seeded by the cell's position). It fits "nicer shaders = a better raymarched look". Cost risk:
   foliage pixels are already among our dearest (`src/shaders/world/light.js:466` records ~100 cascade-pick
   reads a pixel over foliage before the fix), and a per-cell blade test adds work on every plant cell a ray
   enters. So: only near the camera, faded out by our existing mip rule (`gfx/lodFade.js`, detail
   Balanced/Full), and the shadow and AO taps must see the same blades or the grass will float. Needs a
   stated cost estimate before any GPU run.
2. **Ray-bending lens for the black-hole wand and SING (point 11).** Cheap in a tracer: one ray-sphere test,
   then a bent direction, the march otherwise unchanged. It would make the black hole read as a black hole
   (Halo/Noita-grade spectacle) rather than a dark ball. Has to go through the world march and the far field
   alike, in every map.
3. **Eyes that glow without lighting (point 6).** Enemies in dark caves could show faint eye glints, an
   emission-only touch, so you can spot them without them lighting the cave. Small, cheap, a readability win
   in Descent and the island caves.

Already ahead or equal: the cost view, the glow lighting (theirs is the approach our own history replaced
for flicker), shadows, the far field, hazard glow.

## A data point, not a recommendation

They trace one ninth of the screen's pixels on a laptop RTX 4060 and call that the ceiling. Our floor traces
three times that share. It says a peer accepts a far chunkier image for frame rate; our recent detail-loss
work went the other way, so this is context for the resolution floor, not a reason to lower it.

## Open questions the video can't settle

- What the blades cost them per pixel, and whether they shadow and occlude (it shows them, doesn't say).
- How their per-chunk light lists are kept current as glowing material flows, and whether their lights flicker
  under TAA as ours did.
- How far the 2× and 4× rings reach, and whether the seam between rings shows.
