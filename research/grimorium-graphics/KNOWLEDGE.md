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
| 10 | Grass blades, leaves, vines built inside the cell | **Half.** We already build shapes inside the cell for rubble (seeded chips the march tests, with contact occlusion and a short sun-shadow walk; Full detail only, measured +9 to +17 ms in the worst cameras) and for crystals. Plants are not: grass is the meadow photo plus a normal map on the cell's faces; leaves a per-pixel pattern on a blurred surface. No blade silhouettes, no gaps | `src/shaders/gfx/grains.js`, `src/shaders/gfx/surface.js:1032-1053`, `:1424-1482` |
| 11 | Black hole bends the ray | **We don't.** Ours is a drawn sphere with a dark heart (premultiplied blend), no lensing | `src/pov/wands/visuals.js:8-16`, `:71` |
| 12 | 1/9 of the pixels traced + TAA + dither | Same pipeline, and our floor is theirs: 1/3 per axis = 1/9 of the pixels (Quality's 1/1.5 × AUTO_RES.MIN 0.5). Our default (Quality) traces ~44 %, and drops toward the floor only when a view runs over the 12 ms GPU budget | `src/gfx/post.js:213` (UPSCALE_FLOOR), `src/gfx/autoResolution.js:40`, `src/gfx/post.js:933-936` |

## What we missed, ranked (after the six comparisons below)

1. **A black-hole lens (point 11).** Best value for the least risk. The march already restarts a ray where
   glass and liquids bend it (`src/shaders/render.js:840` MAX_BENDS, `:1307`), so the lens is one ray-sphere
   test per active black hole and a bent direction; pixels that miss pay only the test. Must go through the
   far view and every map. Applies to the black-hole wand and SING.
2. **Grass blades as shapes near the camera (point 10).** The biggest look gain, and the pattern exists
   (rubble's chips in `grains.js`). A Full-detail hook beside the grain test, rooted on the surface crossing so
   blades can't float, faded by the mip rule (about 1.8 m full, gone by ~3.5 m by `compare-cell-detail.md`'s
   arithmetic). Cost unknown; rubble's +9 to +17 ms worst case says measure before shipping. Leaves only
   after grass shows it works.
3. **Eyes that glow without lighting (point 6).** Small and cheap; readability in dark caves.
4. **Check, don't fix: the edge of full detail on big maps.** Full detail is drawn inside the physics box and
   the distant view outside it, the nearer hit winning, with no blend band (`src/shaders/world/reach.js:1-7`,
   `docs/scaling.md:528`). Grimorium's rings at 2× and 4× don't settle whether ours shows a line; one
   screenshot looking across the box edge would.

Nothing to borrow for frame time: empty-space skipping, light from glowing cells, shadows, AO and resolution
are all equal or ahead (each file below says why, with the measurements).

Possible look nits, only if seen: light from lava leaking through a thin wall right beside it (the glow's
blocking taps reach 5 cells, `lighting.js` GLOW_TAP_D; retune that first), wand lights cast no shadows, and
far sun-shadow edges are coarse (the world cascade's 2 cells a texel).

## The comparisons

| File | Topic | Verdict |
|---|---|---|
| `compare-empty-space.md` | Skipping empty space, the cell walk, see-through media | Ahead (3 occupancy levels, beam pre-pass, gas-only bricks in one jump). The cost left is glass/water/smoke pixels, not skipping |
| `compare-glow-lights.md` | Light from thousands of glowing cells | Ahead on cost and steadiness; their per-light shadow rays are sharper. Ours replaced a random-pick shadow ray that flickered ±20 % (faccbb129, 2026-10-14) |
| `compare-distance-lod.md` | Lower detail past the simulated area | Different: two passes and a hard cut vs their one walk through 2×/4× rings. A middle level isn't worth it unless measured |
| `compare-resolution-taa.md` | Fewer pixels, TAA, dither | Same floor (1/9); ahead on automatic steering, history rejection, sharpening |
| `compare-shadows-ao.md` | Sun and lamp shadows, AO | Ahead: cached shadow cascades (~0.6 ms of a 15.6 ms span), PCSS edges; per-pixel sun rays were tried and removed |
| `compare-cell-detail.md` | Shapes in the cell, gas fields, materials by ID, lensing | Rubble and crystals already; plants and the lens are the gaps (items 1–2 above) |

## A data point

Their fixed setting, 1/9 of the screen's pixels on a laptop RTX 4060, is our automatic floor. (The first pass
of these notes said our floor traced three times that share; it was per axis, not per pixel. Corrected.)

## Open questions the video can't settle

- What the blades cost them per pixel, and whether they shadow and occlude (it shows them, doesn't say).
- How their per-chunk light lists are kept current as glowing material flows, and whether their lights flicker
  under TAA as ours did.
- How far the 2× and 4× rings reach, and whether the seam between rings shows.
