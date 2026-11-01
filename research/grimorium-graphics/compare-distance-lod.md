# Lower detail past the simulated area: Grimorium vs ours

Source: `research/grimorium-graphics/text/Y8HRCXxI0BY.txt`. Our code read in worktree `threejs-tpt-gpu-wt-grimcmp` (base ff1d35e6). CPU and reading only; nothing was run.

## 1. What Grimorium does

- "Above ground, you can see much further than the voxel simulation window. So beyond the main rendering area, there are two rings of terrain at reduced level of detail. A mid- ring where voxels are approximated at twice their size and a far ring at quadruple size." (04:07)
- "When a ray gets to the edge of the full detail region without hitting anything, it continues into these rings with the same walk." (04:07, the same paragraph, about 04:30)
- Context for "the same walk": the ray steps voxel by voxel (DDA), skipping empty space by chunk flags "at different orders of grouping" (00:03:00). So the rings are the same chunk-skipping DDA over coarser voxels, one march, three resolutions (1x, 2x, 4x).
- Not said: the ring sizes, the reach, how the rings are built or kept current when terrain changes, and any seam handling. "Above ground" suggests the rings are only terrain, not caves.

## 2. What we do, exactly

Cell = 0.3 m (`src/scale.js:18`). The simulated area (physics window) is a 128-cell cube (38 m) that follows the player in 16-cell steps (`src/world/window.js:82-83`; `docs/scaling.md` D11). Small maps have no distant land at all: the whole box is the picture (`src/shaders/world/reach.js:7-8`, "a small map's march draws all of it"). Everything below is big maps only.

**Two passes, split at the window's box.** The cell-level march draws a ray only inside the window's box; the distant view draws outside it; both write depth and the nearer hit wins (`src/shaders/world/reach.js:1-6`; `src/shaders/world/march.js:337-355`). Both cut the ray with the same function, `windowSpan` (`reach.js:12-20`). This is "one full-screen pass after the sky" in `src/world/far.js drawBehind` (`:480`).

**Distant land is not at one coarse level; it is three things stacked.**
1. A brick grid, 4-cell bricks (`src/shaders/common.js:31`), one texel per brick holding the share of an 8-cell cube (two bricks) that is solid, liquid share, dominant material, glow (`src/shaders/farShared.js:30-62, 88-98`; `src/shaders/far.js:25-60`). That is 4x the cell size, like Grimorium's far ring, but it reaches the whole world (1024 wide on most maps; Descent 2560: `docs/seamless-world.md` census).
2. Skip structure over that grid: occupancy nodes at 16 cells and 64 cells (`far.js:62-70`, `farShared.js:68-70`), plus "skip tops", a maximum mipmap of the ground at 4, 16, 64 and 256 cells (`far.js:735-745, FAR_GROUND.SKIPS: 4` at `:745`; march uses it at `:1417-1420`). Rays cross air above land in big jumps, and walk set nodes brick by brick root-finding a smooth field (`docs/scaling.md` W4, "Drawn by one full-screen pass").
3. A ground map at full cell resolution: one word per cell column (top run of solid matter plus its top material), with 3 coarser "ground mips" (4, 16, 64 cells; `far.js:735-760, FAR_GROUND.MIPS: 3`). After the coarse march finds land, the ray is walked across this map to the cells' own faces, so far land shows real cell shapes and real materials (commits 2c6c98f9 and 1158ddda, 2026-10-26). The shaded footprint picks a mip, so crisp faces fade to the columns' slope once a cell is under a pixel (`far.js:1340-1348`, `src/gfx/lodFade.js:1-12`).

So between the cell and the farthest land we have: cell (ground map level 0), then ground mips at 4, 16 and 64 cells for shading, and the brick grid at 4 cells for marching, with occupancy at 16 and 64 and skip tops up to 256. There is no 2x level, and no fixed ring boundaries: the level a pixel gets follows its footprint.

**The seam.** A hard cut at the window's box. The doc lists "no blend band at the window's sides" as not done (`docs/scaling.md` W4 "Not yet"). The distant view's pixels are redrawn at full size near the box's faces (silhouette and the box faces), because the distant view draws at quarter pixel count and only keeps the cheap result where four neighbouring samples agree in distance within 1/16 (`far.js:1118-1135 FAR_MIXED`, commit e10527ec).

**Updates as terrain changes.** The brick grid is built from the world copy, per chunk and per change, with the ground map built in the same pass (commit 2c6c98f9; `src/shaders/world/farFromCopy.js:1-50`). The slab leaving the window is summarised at the move; while the simulation changes the window, a 16-cell slab is re-summarised each frame every 120 frames (`docs/scaling.md` W4, "Updated from the window"). Then the occupancy, column tops and shadow heights are rebuilt. So distant land follows edits within about a second or two on average, and exactly at the moment the window leaves them.

**Cost of the distant march** (from docs, not re-measured here): the far pass 1.5-3 ms in the god view, 2.2-4.9 ms in a low view at default render scale, about a third of it the march and the rest shading (`docs/scaling.md` W4 "Measured", M5, noisy). Commit e10527ec reports the whole-frame GPU span on the Island at balanced detail going 20.19 to 17.89 ms (default pose) and 11.07 to 8.93 ms (horizon) from the quarter-pixel pass. The new ground-map walk (2c6c98f9) has no recorded GPU timing in what I read.

Also relevant: the material fields near the camera are clipmaps, 128 texels wide per level, level 0 at one cell, each next level half the resolution and twice the reach (`src/shaders/world/fields.js:7, 39-45`). That is a 2x/4x/8x... ladder, but only for the smooth-surface and media fields inside the window, not for distant land.

Note: `docs/seamless-world.md` describes a target where the distance pass is deleted and one march reads coarser levels of the world copy. The code on this base is the two-pass arrangement above (`mapKind.js:4-7`, `reach.js`). The doc is a plan, not the current state.

## 3. Side by side

| | Grimorium | Ours |
|---|---|---|
| Levels past full detail | two rings: 2x and 4x (04:07) | no rings. 4-cell bricks for marching, cell-resolution ground map with 3 mips for hits |
| Reach of coarse levels | not stated | whole world (1024, Descent 2560) |
| One walk or two | one: "continues into these rings with the same walk" | two passes, two shaders; the window's march and the distant march meet at a box, depth decides |
| Seam | not stated | hard cut at the window box; no blend band (documented gap) |
| Skipping empty space | chunk flags at several orders (00:03:00) | occupancy 16/64 plus skip-top maximum mipmap to 256 |
| Underground | "above ground" only (04:07) | brick field holds caves, but the ground map is the top run only, so caves use the blurred field surface |
| Update | not stated | per chunk and per change from the world copy, slab sweep every 120 frames |

Where we are the same: coarse voxels beyond the full-detail area, marched by the same skip-then-step idea, and our 4-cell brick is Grimorium's far ring size.

Where we are ahead (as far as the video says): the distant land has real cell shapes and materials at any distance via the ground map, with a footprint-based fade; skip tops give exact big jumps; a quarter-resolution pass with edge re-draw; reach to the whole world; shadows and sky light tied into it.

Where they might be ahead: (a) a single walk, so no box seam, no second shader, no duplicated shading code and no depth-merge; (b) a 2x middle level, which we lack as a marched level; our step from a cell to a 4-cell brick is one jump; (c) rings built from the same voxel store, which may mean no separate "summary" to keep current. We cannot tell from the video whether any of these matter to them.

## 4. Anything worth trying (ranked)

1. **A blend band at the window's box (look).** Evidence: our own doc lists it as not done (`docs/scaling.md` W4 "Not yet: no blend band at the window's sides"), and the seam is a place where the window's exact shapes meet the distant view's footprint-faded shapes. The distant view already re-draws full size near the box, so the cost is the blend, not a new pass. A test would be a still at a pose looking across the box edge, plus a two-pose comparison for a visible step in shading or silhouette. This is a look fix, not a frame-time fix, and the video gives no hint about how they solve it.
2. **A 2x marched level between the cell and the 4-cell brick (frame time, uncertain).** Reason from the code: past the window the march goes straight from the 4-cell brick field to the cell ground map walk, and the ground-map walk is bounded by `REFINE_SPAN: 64` cells and `REFINE_COLS: 40` columns (`far.js:745-760`). If the profiler's distant-view waterfall shows the walk step is a large share on rough land, a middle level could shorten it. Without that measurement this is only a guess; do not build it first. A test would be one profiler run (`tools/profile.mjs`, exclusive slot) on a rough big map at the default and horizon poses, reading the distant view's march versus shading split. Our docs say about a third is the march, so shading is the larger part and a 2x level would not help that.
3. **Nothing else.** The one-walk design is a different architecture; the seamless-world plan already aims at it. Copying their 2x/4x ring numbers would not improve what we have.

## 5. What the video can't tell us

- Ring widths, how far the far ring reaches, and whether the rings cover only terrain or also caves.
- Whether the ring voxels are rebuilt when terrain changes, and how fast.
- How the mid ring and window blend (or don't); whether they have a visible seam.
- The cost of the rings, in ms or relative to the window march. The video gives no timings.
- Whether the rings carry material identity (their grass shader is described only for near voxels, 07:02: "that geometry is generated on the spot the moment the ring needs it", where "ring" in that sentence may mean the full-detail region or the reduced one; it is ambiguous).
- Whether the render is rays-per-pixel at a third of window size (07:37) is why the rings are affordable; that resolution factor, not the rings, may be their main saving.
