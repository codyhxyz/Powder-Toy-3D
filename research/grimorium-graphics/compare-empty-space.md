# Empty-space skipping and the voxel walk: Grimorium against us

Sources: the transcript `text/Y8HRCXxI0BY.txt` (timestamps below), and the code and docs in this worktree
(base ff1d35e6). CPU and reading only. Nothing was run.

## 1. What Grimorium does (quoted)

- One ray per pixel, cell by cell. "For every pixel on the screen, a compute shader fires a ray from the
  camera into the world and walks it forward voxel by voxel until it hits something ... Then step across
  whichever boundary is closest and check what's in the voxel you just entered ... This method is called DDA"
  (02:19-03:00).
- The problem they name: "on its own this can quickly blow up into thousands of operations per ray. A single
  ray looking at a distant object might cross over thousands of voxels" (03:00).
- Their fix: "the chunk system allows holding information at higher levels with flags at different orders of
  grouping to quickly provide information about what's inside of larger areas. This is crucial for the graphic
  system as it allows quick skips for vast regions where there are no voxels. The voxel by voxel walk is only
  done when it's genuinely close to solid material, bringing the number of checks to only a handful" (03:00).
- A cost view: "a debug view that colors every pixel by how much work its ray had to do, so I can spot areas
  where rays are doing excessive checks" (03:00).
- Transparent materials: "they accumulate the colors they pass through, and the ray continues through them
  until it hits something else" (03:00; the task brief's 03:53 is the same paragraph in the caption track).
- Gas "is smoothed out by treating them as a density field rather than discrete voxels" (03:00).
- Past the window, a ray "continues into these rings with the same walk" (04:07): a mid ring at twice the
  voxel size, a far ring at four times.
- Shadow rays "traverse exactly as the initial ray does" (06:24).

That is everything they say. No level count, no sizes, no step caps, no timings.

## 2. What we do, exactly

**Cells and bricks.** The world is stored as sparse 4x4x4-cell bricks (`src/shaders/common.js:31`
`BRICK = 4`; `src/shaders/world/copy.js:1-8, 14-21`). Each brick has an info word of flags (media, smooth
surface, opaque, thin, mixed, film, glass cells, liquid interior, matter: `src/shaders/bindings.js:119`, flag
constants `:135-143`). An all-air brick has info 0.

**Hierarchy.** Three occupancy levels, one bit each: brick (4 cells, bit MATTER), a 16-cell node
(`WC_NODE1 = 4` bricks, `copy.js:37`) and a 64-cell node (`WC_NODE2 = 4`, `copy.js:38`). A bit is set where
any brick inside has matter (`copy.js:20-21`). The walk reads them through `wcOccupied(level, cell)`.

**How a ray picks big or small.** In the main loop (`src/shaders/render.js:1088-1125`), on entering a brick
the loop reads its info. If the info is 0 (`flags == 0u`), it calls `skipEmpty` (`render.js:1112`;
`src/shaders/world/march.js:234-244`). `skipEmpty` tests the 64-cell level first, then 16, else uses the
brick itself, and jumps the ray out through the far face of the largest empty box (`ddaJumpBox`,
`src/shaders/dda.js:58-72`). A run of empty bricks is walked in an inner loop, one jump per brick entered,
without going back to the loop head (`render.js:1088-1100`). Only a brick with flags non-zero falls through
to the per-cell step (`render.js:1141+`).

**Per-cell walk inside a brick with something in it.** Each cell is classified from the brick's occupancy mask
(`occCellId`, `render.js:1138`). An empty cell of a brick that holds only crisp matter takes a fast path:
a plain DDA step with no reads (`render.js:1145-1153`), and an "airWalk" runs the whole rest of an own-matter-
free brick in a tight loop (`src/shaders/world/march.js:312-330`). Plain DDA step is `ddaStep`
(`src/shaders/dda.js:46-53`), Amanatides & Woo.

**The dilation problem.** Smooth surfaces (liquids, fields) are not on cell boundaries, so a brick is marked
SURF/MATTER if any brick within one brick holds a smooth-surface cell (`copy.js` dilation; recorded in
`research/voxel-traversal/KNOWLEDGE.md:197-198`). That is why many bricks near water are not "empty" to the
walk. `brickSurfCert` (`march.js:253-259`) drops SURF where the field provably holds no surface, so such bricks
take the fast path.

**Transparent media in the loop.** The ray does not stop at transparent cells: `trans` (transmittance) starts
at 1 (`render.js:882`), each crisp transparent cell, glass pane, film, liquid segment or gas segment
multiplies it (`trans *= 1.0 - al`, e.g. `render.js:420, 469, 631, 720`), colour is added weighted by it,
and the loop ends when it falls under `RAY_MIN_TRANS = 0.01` (`render.js:165, 281`). Same idea as Grimorium.
Extras we have: up to `MAX_BENDS = 6` refracted surfaces (`render.js:840`) and `BEND_EXTRA_STEPS = 128`
(`render.js:129`) added to the step cap `W + H + D + spare` (`march.js:126`).

**Gas shortcuts.** A brick that holds gas alone (flags equal BRICK_MEDIA with nothing else), out of liquid, is
integrated as ONE media segment and ONE jump (`render.js:1115-1128`). The doc records 41.7 to 31.7 ms on the
Lab smoke box from that change (`docs/march-spill.md`, "Smoke: the efficient media march"). Deep liquid is
likewise crossed a brick at a time at Off and Balanced (`render.js:1153-1177`).

**The beam pre-pass (38695ec0).** First stage of the split march (`src/shaders/world/beam.js`). One fragment per
8x8-pixel tile (`BEAM_TILE`, `beam.js:~34`) walks a cone around the tile's four corner rays through the same
three occupancy levels (`beamMarch`, `beam.js:~100-135`), at most `BEAM_STEPS = 64` steps, and writes the
distance up to which nothing in the cone meets a brick with matter. Conservative: every ray of the tile may
start there. The lean march then puts each ray at the empty node holding that point, in the exact state its
own walk would have reached (`beamStartAt`, `beam.js:~165-198`; called at the loop's entry, `march.js:297`).
From L&K 2010 §6.2 (`beam.js:1-4`). Recomputed every frame.

**What it bought** (`docs/march-spill.md`, "The beam pre-pass"): main-loop trips 11.7 to 6.4 per pixel on the Lab
default; empty-region jumps 7.2 to 1.9; cells stepped unchanged at 5.4. Whole-frame GPU span: Lab 15.36/15.37 to
15.04/14.99 ms, Island 17.29 to 16.98, Island horizon 8.75 to 8.85 (noise). The pass costs 0.24 ms (Lab), 0.39 ms
(Island). Doc's own reading: "the empty jumps were ~250 operations each and cheap next to the surface trips and
the shade, reflect and event stages."

**What the spill doc measured about where cost tracks loop work.** After the beam and the cheaper jumps, the
remaining march time is not in empty space:
- Lab default: "Lab's time is in the pixels that meet the glass tank and its water" (`docs/march-spill.md`,
  "Time" section after the split); the fat stage costs 8.9 ms there because "the tank's rays meet glass first,
  smoke is media" (same doc, "Event kernels").
- Island default: the liquid kernel 4.7 ms, "the sea is all liquid-first".
- Smoke: even with the integration removed, about 7-8 ms stayed as "the fixed cost of those pixels leaving the
  lean march for the fat stage" (same doc, "Smoke").
- Splitting the traversal from the events did not make traversal itself much faster: Island lean march 2.3 ms
  against 3.4 ms for the old whole ray (same doc).
- Empty-brick jump cost was cut about 430 to 250 operations a jump and the frame moved 3 percent
  (17.35 to 16.77 ms Lab).

**Past the window.** One far field at brick size, not two rings (`src/shaders/far.js` header, per
`KNOWLEDGE.md` row 5). Not re-read here.

## 3. Side by side

| | Grimorium | Us |
|---|---|---|
| One ray per pixel, DDA | Compute shader, cell by cell (02:19-03:00) | Fragment shaders (full-screen triangle, `march.js:~370`), Amanatides & Woo (`dda.js:1-2`) |
| Hierarchy for empty space | "flags at different orders of grouping", count unstated (03:00) | Three levels: 4, 16, 64 cells (`march.js:234-244`), picked per jump, largest empty first |
| Walk cell by cell only near solids | Yes (03:00) | Yes, plus a no-read fast path for empty cells of crisp-only bricks and airWalk (`render.js:1145`, `march.js:312`) |
| Per-ray head start | Not mentioned | Beam pre-pass, 8x8 tiles, L&K 2010 (`beam.js`) |
| Transparent material | Accumulate colour, ray continues (03:00) | Same, plus up to 6 bends, panes, films, Beer-Lambert segments (`render.js:840, 420-720`) |
| Gas | Density field, rounded blobs (03:00) | Smooth fields plus one segment per gas-only brick (`render.js:1115`) |
| Cost view | Per-pixel work colour (03:00) | Same, exact counters (`docs/profiler.md`) |

**Same:** DDA over the sim's own cells; hierarchical empty-space flags; walk cell by cell only near material;
transparent cells accumulate and the ray continues; a per-pixel work view.

**Different:** we skip empty space with an explicit three-level pyramid and a per-tile cone pre-pass. They don't
say they have a pre-pass. We also march smooth (sub-cell) surfaces for liquids, which forces a dilated "maybe
surface" flag onto bricks around water. They treat gas as a density field but nothing says they have sub-cell
liquid surfaces, glass panes that bend rays, or films; we do (`render.js:840`).

**Where we are ahead (from what they said):** the pre-pass; a fast path for empty cells inside mixed bricks; a
one-jump answer for gas-only bricks; a certificate that drops the dilated SURF flag in empty-looking bricks
(`march.js:253-259`); documented per-trip instruction counts.

**Where they might be ahead:** nothing they said is a technique we lack. They say "only a handful" of checks,
but we don't know their scenes, and our "handful" is not the whole cost: after the beam the Lab is 6.4 trips a
pixel and 5.4 cell steps, and the doc says time sits in event pixels, not in these trips. The honest reading is
that their claim is about empty-space cost and we have already taken that lever.

## 4. Anything worth trying, ranked

**Nothing from this video is worth trying on the walk itself.** Reasons, from our own measurements:

1. More empty-space skipping is the lever already pulled three times (the cheaper jump, the airWalk, the beam).
   Each cut loop work and each moved the whole frame by 0 to 3 percent (`docs/march-spill.md`: -3 percent for
   the jump cost, -0.35 ms for the beam). The remaining frame time is in the shade, reflect and event stages and
   in pixels that leave the lean march for the fat stage (7-8 ms fixed cost on smoke, 8.9 ms of the Lab's fat
   stage).

2. The one idea in the same family that the docs have not closed is a **glass kernel and a media kernel**
   ("Next by measured cost: a glass kernel ... and a media kernel", `docs/march-spill.md`, "Event kernels").
   It is ours, not Grimorium's, and the video doesn't speak to it. Mentioned only because it is the item on
   the traversal side that the docs rank by measured cost. Test: Lab default, same pose, back to back with
   `tools/profile.mjs --no-cost --no-counters --frozen`, expecting the fat stage (8.9 ms) to shrink, with the
   same byte-identical converged frames the earlier kernels used. Worth doing only if it is already on the plan;
   this comparison gives no new reason.

3. A possible small thing, from their wording only: "only a handful" of checks near solids. Our Lab has 5.4 cell
   steps a pixel after the beam. If a per-pixel histogram (not the mean) shows a long tail of pixels at the
   step cap (`marchMaxSteps() + BEND_EXTRA_STEPS`, `march.js:126`, `render.js:129`), those would be the ones to
   look at. The existing cost view already shows this; no new run is justified from the video alone.

## 5. What the video can't tell us

- How many levels they have, how big a group is, how a ray chooses a level, whether they have a pre-pass.
- Whether their skipping beats ours; they give no step counts, no ms, no scene description for "a handful".
- How they handle sub-cell surfaces (liquids): they only mention gas as a density field. Our dilated SURF flag
  exists because of ours, so the comparison is not like for like.
- How expensive their transparent materials are per pixel, or whether they cap bends or refraction.
- Whether the walk happens in a compute shader with a work queue (they say "compute shader") or one thread per
  pixel with the same divergence we see; our docs found divergence matters (`docs/march-spill.md`, "Packing":
  scattered pixels cost about 40 percent more in a gated fragment pass, and a compute list "would recover it",
  blocked by the tracer's derivatives).
- Timings of any kind.
