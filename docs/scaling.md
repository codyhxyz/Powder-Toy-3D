# Scaling: a faster default world, then a massive one

Contract for the `scale` integration branch (worktree `../tpt-scale`). Every agent working on this reads it first.
The plan behind it: https://claude.ai/artifact/S1AZnFvo8u3UhnBcibbVSh (stages 1–4). This file records what we
actually decided, which in places differs from that page; where they disagree, this file wins.

## Goals

1. **The default world gets measurably faster.** At 128³ on the lab preset, compare against `main` with
   `tools/bench.mjs` (A/B, interleaved):
   - sim step cost down at least 2×;
   - derived render passes down at least 1.5×;
   - no new cost when the world is idle.
2. **Massive worlds.** A world much larger than the GPU-resident region, for example 1024×256×1024 cells
   (about 300 m across in POV mode).
   - The simulation runs in a window around the player or camera. Bricks outside it are frozen, stored compactly
     and drawn at reduced detail.
   - Cost follows awake cells inside the window, not world size.
3. **No physics regressions.**
   - Mass is conserved exactly.
   - Energy stays within the bounds stated below.
   - Behaviour changes only where a rule below says it should.
4. **No visual regressions.**
   - A refactor that should be invisible is proven pixel-identical with `tools/regress.mjs`.
   - An intended visual change is shown with before/after shots.

## Decisions

### D1. We stay on WebGL2
WebGL2 and WebGPU can't share textures, so moving the simulation means moving every pass that reads it. That
covers the raymarcher, fields, shadows, GI, picking, signs, POV body/tools/trace, the transfer pass, the codec
and stamps: about 7,600 lines of shaders. It also covers post and the three.js scene (POV viewmodels, three.quarks
VFX). Other sessions build on that pipeline daily.

The measured bottleneck is memory traffic from full-grid passes, and WebGL2 can cut that (D4–D8). The artifact's
stage 3 ("WebGPU") is therefore implemented on WebGL2 here.

### D2. Rest states (stage 1)
These rules make resting matter a true fixed point, so it can sleep without changing the physics:
- **Normal force.** Gravity can't accelerate a cell downward into something it can't enter that is itself at
  rest (the floor, a solid, or a resting grain or liquid it can't displace): `v.y = max(v.y, 0)` after gravity.
  This must not stop a falling column: a cell moving down is not "at rest". That goes for the cell itself too:
  only a cell that starts the step with `v.y >= 0` is held, so a falling, landing or knocked cell keeps feeling
  gravity and the move pass lands it (splash, scatter, impact heat). Snap a held cell's tiny speeds to exactly 0
  below REST_V. The move pass only topples a cell that pressed on what's below, so a top cell held at rest
  (`v.y = 0` under gravity) counts as pressing: piles keep toppling, they just stop landing every step.
- **Liquids flow only where they can.** A pool's flow is re-kicked (react.js FLOW_KICK) only when the cell has
  somewhere to go: a side neighbour it can enter (canMove). The same gate holds back a film's cohesion pull and a
  droplet's wander, which otherwise push a boxed-in cell against its own puddle forever. A lower diagonal needs
  no push (the move pass topples into it regardless), so it is not part of the gate. Otherwise its velocity
  decays and snaps to 0. Measured before: water that can't move carries 0.77 cells/step forever.
- **Inert means nothing can change.** This replaces "air at 20 °C or a solid at 20 °C". A cell is inert when:
  - it can't move: it is at rest, and for powders and liquids every place it could move into is blocked,
    including the diagonals the move pass topples into;
  - nothing can react: no ignition, melting, acid, plant growth, clone emission, fire, smoke or gas;
  - it is thermally quiet: air within AIR_REST_T (1 °C) of ambient, and matter within MATTER_REST_T (0.01 °C)
    of every matter face neighbour. A face touching air carries heat at air's conductance, so matter there
    takes air's tolerance instead (within AIR_REST_T of ambient).

  A brick is quiet (skipped) when it and its 26 neighbours are inert. Measured after settling (128³): the
  quiet share goes from 40% to 60% (lab), 39% to 58% (volcano), and 35% to 52% on the wide volcano.
- **Energy bound.** The halo rule means heat flows into or out of a sleeping region only below the tolerance,
  and any drift past it wakes the brick. State this bound in a comment where the tolerance is defined.
- **Heat that can't overshoot.** Cap each face's exchange at 1/6 of the energy that would bring the
  smaller-capacity cell of the pair to the other's temperature: `|flux| <= |ΔT|·min(Ca, Cb)/6`. The limiter is
  symmetric in the pair, so conduction stays exactly conservative and becomes unconditionally monotone. It is
  elements.js's stability rule (6·cond/cap < 1) applied per face, so no current element reaches it; a cap of 1/6
  of the pair's equalising energy (`|ΔT|·Ca·Cb/(Ca+Cb)/6`) would slow metal by 29% and fire by 38%.
- Every new tolerance and epsilon is a named constant in `src/physics.js` (they reach GLSL as #defines).
- The CPU tile engine (`src/ui/tiles/engine.js`) gets the same rules. Run `node scripts/check-tile-engine.mjs`.

### D3. Pressure stays per cell
Breaking solids by blast (react.js, P_BREAK_PER_HARD) and blast shielding by thin walls need a per-cell pressure
difference. The artifact's coarse-air idea is dropped.

### D4. Invalidate before full-target writes
`renderer.autoClear` is false, so every full-screen pass starts by loading its whole target from memory, which
it then overwrites. A pass that writes every texel of its target calls `gl.invalidateFramebuffer` on the bound
draw framebuffer before drawing. Do it in one helper used by `Simulation.run` (and post), opt-in per pass, so a
pass that writes only part of its target never invalidates. Pixel-identical by construction; prove it with regress.

### D5. State access goes through accessors
Shaders never `texelFetch` the state textures directly. The prelude (`src/shaders/common.js`) provides:
- `vec4 fetchA(ivec3 cell)` and `vec4 fetchB(ivec3 cell)`. They keep today's meaning:
  A = (id, °C, life, ctype + seed) and B = (velocity xyz, pressure).
- matching writers for passes that output state.
- `atlas()` / `cellFromFrag()` remain the only code that knows the texel layout.

JS gets one mirror: helpers exported from `src/sim.js` for cell ↔ texel index and `sim.readState()`, which
returns the old float layout for CPU checks and tools. `tools/check-state-access.mjs` fails on any direct state
fetch outside common.js, so code merged from main can't bypass the accessors.

### D6. Brick-major layout
- A 4³ brick is one 8×8-texel tile. Local cell `(x, y, z)` maps to tile texel `(x + 4·(y & 1), z + 4·(y >> 1))`.
- Bricks are grouped into supertiles of 4×2×2 bricks (x, y, z). A supertile is one 32×32-texel square, a compact
  16×8×8-cell region, so a hardware tile of a tile-based GPU covers nearby cells.
- Supertiles are laid out row-major in the atlas. Grid sizes must be multiples of 16×8×8. All current sizes are.
- Simulation results don't depend on texel placement (randomness is hashed from cell coordinates), so this is
  pixel-identical too.

### D7. Packed state
Cost follows bytes per cell (see Measured), so the target is one RGBA32UI texture per copy, 16 bytes per cell
instead of 32:
- x: id 6 | ctype 6 | spare 1 | seed 19
  - The inert flag lives in its own R8 target written by react and every other state writer (D8), so the
    activity reduction reads 1 byte per cell.
  - Another session (`../tpt-rest-pos`, not yet on main) turns the seed into a grain's rest position: three
    6-bit axes plus a free-fall flag, scrambled, in 19 bits (`src/shaders/rest.js`). The seed field holds all 19.
- y: temperature as f32 bits. Conduction fluxes are tiny and must not round away.
- z: life f16 | pressure f16
- w: velocity, 3 × 10-bit signed fixed point over [−V_MAX, V_MAX], with 2 spare flag bits.
  - Stochastic rounding, using the cell's hash random stream, keeps the expected value exact, so gravity, drag
    and friction integrate without bias.
  - Exact zero stays exact zero, which rest states need.

The accessors decode to the D5 floats, so readers don't change. This is a precision change: prove it
statistically, not pixel-wise:
- census and conservation;
- fall times;
- pile angle;
- splash and flow;
- settling.

**Fallback.** If 10-bit velocity measurably changes behaviour, use f16 velocity: w = vx | vy, plus a second
R16UI texture for vz and the flags (18 bytes per cell).

### D8. Two passes per step, and skipping sleeping bricks
- **Gather fused into react.** A step is a block pass (one fragment per Margolus block, 8 slot results), then a
  react pass that reads each cell's post-move state through the block results for itself and its 6 neighbours.
  Slot result = RG32UI: source 3 bits + impact heat 13 bits + vx f16, then vy f16 + vz f16.
- **Activity comes from react's inert bit.** A brick reduction reads 4 bytes per cell, not 32.
- **Sleeping supertiles are not touched.** The sim passes draw one instanced quad per supertile (32×32 texels,
  4×2×2 bricks), culled in the vertex shader by a supertile activity map. Inside a drawn supertile, quiet bricks
  take today's early-out and copy themselves.
  - The block pass does the same over its own atlas.
  - When most supertiles are awake, one full-screen quad is cheaper: switch above a named share (measure it).
  - A supertile with no active brick for two activity maps in a row is identical in both state copies, so no pass
    needs to write it.
  - Every pass that writes only some supertiles must keep that two-map rule.

Sleeping supertiles as implemented (`shaders/activity.js` superMapFrag, SUPER_MAP; `Simulation.step`):
- **The supertile map.** Built with every activity map: one pass after the quiet map (and `noteAwake`), one byte
  per channel per supertile, then each channel's share of supertiles (one texel), which the vertex shaders read.
  - AWAKE: a brick of the supertile is not quiet, or one just below it along x, y or z. At partition offset 1 a
    Margolus block belongs to the brick holding its base cell and reaches one cell past it, so a block based in
    the brick below moves cells of the supertile's low faces. (This was already so: the gather tests a block's
    base brick, so a quiet brick's low faces can trade cells with an awake neighbour's. Within an inert halo
    only air moves, jittering, but a quiet brick's state is then not quite unchanged by its map's steps, as D9's
    contract asks. Noted, not changed: skipping stays bit-exact with the base.)
  - STEPS: one of its own bricks is not quiet. The flow pass draws these (it writes only cells of such bricks).
  - BLOCKS: one of its own bricks is not quiet, or one just above it. The block pass draws these: it solves the
    blocks based in bricks that aren't quiet (the gather reads them) and gives a block based in a quiet brick its
    identity slots, which the flow pass reads for that block's cells in a brick that isn't quiet. (Skipping those
    identity slots too and testing the base in the flow pass instead is exact in value, but not bit for bit: the
    flow pass's blend into the half-float field is folded into its shader by Apple's compiler, and any change to
    that shader's code moved some blended values by one unit in the last place. The flow and block shaders are the
    base's, unchanged.)
  - DRAWN: AWAKE under this map or the last one, or written since the last map by something that isn't a step.
    The gather and react draw these.
- **Why the last map too.** Under a map that leaves a supertile asleep, the gather copies its cells and react
  writes them back with their flags settled (own flags, NEAR, and the DIRTY the map's first step cleared). Once a
  map's steps have drawn it asleep, both copies hold its cells and the current one settled flags; after the
  map's second step, the same flags in both. A write that isn't a step can end a map after one step, but it copies
  the current state into both copies outside the box it declared (every `sim.pass` copies through) or wakes the
  supertile. So when the next map leaves it asleep too, its steps would write what both copies already hold.
  A map whose steps didn't settle what slept under it (none, or one with no write after it: tools build maps by
  hand) passes its DRAWN on instead. A CPU model of these passes (`tools/skip-model.mjs`: 1-D, random maps and
  writes, drawn against skipped) agrees in both copies, flags included, and in the flow field, and fails without
  the low halo, the high halo for the block pass, the last map, the written boxes or the carry.
- **Writes that aren't steps.** Each goes through `Simulation.run` into a state target, which notes it
  (`noteWrite`, as D9 does): the box declared with `touch()`, or everything, is drawn by the next map's steps.
  - The brush copies through and declares its box. So do the first-person body's coupling and the physgun now
    (`touchCentres`): each writes every frame it acts, and without a box every such frame woke everything.
  - Constructions' stamps, the axe, the gun's handoff and the pack/trowel transfer copy through without a box:
    everything wakes for one map.
  - The world window's shift (fresh flags everywhere), generator fill, stored edits, tree stamps and `syncCopies`:
    everything wakes.
  - Load, undo and the codec's unpack (multiplayer guests) rewrite the current copy alone: everything wakes.
- **Regions.** One `RegionQuads` instance per supertile, culled in the vertex shader (`stepRegionsGLSL`): its
  SUPER_TEX square of the state atlas (and the flow field, which shares it), or its 16×8 texels of home blocks in
  the block atlas, plus the block atlas's low-margin rows at partition offset 1. Above STEP_FULL_SHARE (0.9) of a
  pass's channel (a uniform, `sim.superU.uFullShare`), one full-screen quad. `sim.skipSleeping = false` draws
  full-screen always (A/B). The shares come from two small passes (row counts, then their sum): one fragment
  summing all 2048 supertiles cost ~0.03 ms a step in an empty world.
- **The threshold** (`tools/sleep-crossover.mjs`, quiet M5, 128³, the two ways alternating at the same states): a
  quad per drawn supertile costs 0.75 of one full-screen quad with 32% drawn, 0.86 at 49%, 0.91 at 73%, 0.98 at
  87%, 1.02 at 97%, 1.06 at 100%. So 0.9.
- **Proofs** (against `scale` at 562bb8b, bit for bit):
  - `tools/state-hash.mjs` hashes, after every stage, the state cell by cell, the flow field, both state copies
    texel by texel with their activity flags, and every activity map built since (inert and quiet). Identical for
    lab, volcano and island at 128³, 64³ and wide, and `--world` (load, edits, six window moves out and six back:
    shifts, fills, trees, stored edits, `syncCopies`). Stages: steps, every brush tool, replace and undo, codec
    pack/unpack, readState/load, a stamp, the first-person passes (the body's coupling and the physgun with their
    boxes, the axe, the gun's handoff), a pack/trowel take and put, and painting between single steps.
  - `tools/regress.mjs`: settled, `--motion` and `--detail on`, every shot AE 0.
  - `tools/activity-check.mjs`: lab, volcano, island, 300 maps each with every writer: 0 bricks differ.
  - `tools/world-check.mjs` (1–4): the diff exact, 76/76 edited bricks back exactly and none different, seams
    identical, a move's first frame 0.4% of pixels as before. `tools/derived-check.mjs`: every case identical.
  - The body's coupling and the physgun change no cell outside the box they declare (checked on lab).
- **Timings** (`tools/bench.mjs`, A = `scale`, B = this; ms per step, median of 7 interleaved rounds, quiet GPU):

  | 128³ after 200 steps | supertiles drawn | A | B | B/A | B drawing every supertile |
  |---|---|---|---|---|---|
  | empty | 0% | 0.835 | 0.182 | 0.22 | 0.900 |
  | island | 26% | 1.90 | 1.43 | 0.75 | 1.98 |
  | lab | 39% | 2.21 | 1.81 | 0.82 | 2.36 |
  | volcano | 45% | 2.23 | 1.96 | 0.87 | 2.51 |

  The last column is timed after the B column each round, so a little later in the scene. In the empty world,
  where nothing changes, drawing everything costs 8% more than the base (0.900 against 0.835 ms): the supertile
  map's passes and the instanced draw. Above the threshold that is what a step pays.
  What a world asleep still costs (empty, 0.18 ms a step): ~0.155 ms rebuilding the activity map every second
  step (it reads every cell's flags), ~0.03 ms the four step passes with every quad culled. Awake supertiles cost
  what they did: the gain is the early-outs of quiet bricks no longer drawn.

### D9. Derived passes are incremental where they can be
Fields, bricks and light are rebuilt only for bricks that changed within their settle window (EMA), dilated by
each kernel's reach. Shadow and GI keep their own cadence. Converged regions cost nothing.

As implemented (`sim.updateDirty`, `shaders/passes.js` dirtyFrag, `gfx/regions.js`):
- **What changed.** A brick may have changed since the last `updateBricks` if a step's quiet map didn't skip
  it: every map a step used is noted (`noteAwake`: 1 − quiet into `actChanged`, the first map after an update
  overwriting it and later ones blending with MAX, so nothing has to clear it), including a map still current at
  the last update that later steps reuse. A write that isn't a step changes every brick,
  unless it declared its box first with `sim.touch(lo, hi)`; the brush, the first-person body's coupling and the
  physgun do (`touchCentres`). Loads, undo, network frames, stamps and the other first-person tools rebuild
  everything for a settle period.
  - **Contract for D8:** whatever builds the quiet map calls `noteAwake()` after building it (and the carry check
    before replacing it), and a quiet brick's state must be unchanged by the steps that use the map.
- **Ages and dirty sets.** Each brick's age is the frames since it last changed (8-bit, ping-pong). Three sets:
  - EMA: age < `FIELD_EMA_SETTLE` = 13 frames. That is when the slowest channel's 8-bit blend (liquid,
    0.35) reaches its fixed point: one more blend rounds back to the same value, so skipping it changes nothing
    (`gfx/pacing.js blendFixedFrames`; exact, unlike `settleFrames`, which says 8 for 0.5 where 9 are needed).
  - FIELDS: an EMA brick within 1 brick. A change reaches 4 cells into the final fields along each axis: 2 from
    the 5-tap blur, 2 from the boost (6 stages, 2 per axis).
  - WORK: an EMA brick within 2 bricks. The passes between the EMA and the final fields share scratch targets,
    which outside this frame's regions hold another pass's output, so each covers what the passes after it read:
    the first blur's output is read 4 more cells away (the other blurs and the boost).
- **Field passes** draw instanced quads over regions of the field atlas: 8×8 bricks of one Y-slice (32×32 texels,
  one hardware tile), culled in the vertex shader from a region map of their set. The EMA pass and its copy use
  EMA; the blurs and boost stages 0–4 use WORK; the last boost stage uses FIELDS and discards texels outside
  FIELDS bricks, since its regions reach cells whose inputs this frame didn't compute. The EMA is no longer a
  ping-pong: it is computed into scratch and copied back over the same regions, so a skipped texel needs no
  second copy, and the targets and memory stay as they were (a ping-pong plus a third scratch target would save
  the copy, about 0.1 ms per frame at full share, for 26 MB at 128³). Above `FIELD_FULL_SHARE` of regions flagged,
  a pass draws one full-screen quad instead; the share is computed on the GPU and read by the vertex shader, so
  nothing is read back. Both were picked by measurement (below): 8-brick regions, `FIELD_FULL_SHARE` 0.95.
- **Brick map** rebuilds FIELDS bricks only (the rest discard). The empty-space distance and the glow volume are
  cheap brick-resolution passes and stay full.
- **Shadow and GI** stay full every derived frame.
  - The shadow map's texels each depend on every brick their sun ray crosses. With the sun held (`DAY.running`
    is off by default) an exact incremental map would re-trace every ray through a brick whose state, fields or
    empty-space distance changed. The distance matters because `skipEmpty`'s jumps set `tEnter` where a cell step
    would accumulate `tMax`, so the stored depths change in their last bits; a brick filling or emptying changes the
    distance of every brick within `BRICK_DIST_MAX` (8) of it. Measured while running, that is 40–64% of the bricks
    (lab 50%, island 40%, volcano 64%), whose rays cover 36–49% of the map's tiles: 58–79% of the tiles the box
    projects to. Too little left untouched to pay for the bookkeeping, so it isn't done.
  - GI blends its probes every frame, each traced every other frame, and its sources read the previous probes for
    bounce light, so its values keep moving everywhere the blend hasn't settled in half floats, and a change
    reaches every probe whose rays (up to about 18 bricks) cross it. Nothing local stays fixed to skip.
- **Proofs:**
  - `tools/regress.mjs`, settled, `--motion` and `--motion --detail on`: AE 0 on all 21 views, both for the D9 branch
    against the `scale` it came from and for `scale` after the merge (with the D7 flags and the D11 window) against
    the same tree with `sim.incremental = false`.
  - `tools/derived-check.mjs` (every derived target bit for bit against `sim.incremental = false`, over steps,
    painting, the heat tool, undo, a pause and 1, 3 or 4 steps per frame): identical at 128³, 96³, 64³ and wide, on
    the branch and on the merged `scale`. The same holds over world-window moves, whether the EMA keeps its history
    across a move or starts over (6 moves, 360 comparisons).

### D10. Undo (deferred)
Copying only the bricks a stroke touches isn't a correct undo: matter flows out of those bricks afterwards.
The exact version copies each brick when it first wakes after the snapshot (a sleeping brick hasn't changed), so
it needs D8's activity machinery. Until then, snapshots stay full copies: packing (D7) halves them. Each keeps the
window's origin it was taken at, so an undo after window moves (D11) brings back what the old and new windows
share (W5 below).

### D11. Massive world
The world is much larger than what lives on the GPU. Its size is `WORLD` cells, for example 1024×256×1024.

- **Window.** The simulation and the detailed renderer cover a window of `WIN` cells (for example 192×128×192)
  at a world-cell origin `uOrigin`. `uOrigin` is a multiple of `WIN_STEP` cells (16) on x and z, and y is fixed at 0.
  - Every pass works in window-local cells, exactly as today.
  - Anything that needs world position adds `uOrigin`. That includes the random seed (`seed3`, so results don't
    depend on where the window is), rendering and picking.
  - Today's grid sizes are a world equal to its window at origin 0. The world-coordinate plumbing must be
    pixel-identical for them.
- **Moving the window: shift by copy, not wrap-around.** When the focus (POV player, or the god view's orbit
  target) is more than `WIN_STEP` from the window centre, the window moves by `WIN_STEP` along x or z.
  - A copy pass shifts both state copies by the move, and the field EMA and GI probes too. Brick maps are rebuilt.
  - Cells uncovered by the shift are filled by the generator pass, then by stored edits.
  - The copy costs one state read and write per move (about 1 ms), and moves are seconds apart.
  - Wrap-around addressing would break the hardware filtering of fields and probes at the seam, so we don't use it.
- **Leaving slabs.**
  - Before a shift, a GPU pass compares each brick of the slab about to leave with the generator's output. Air
    counts as unchanged if it is still air within AIR_REST_T; matter needs the same id and ctype, and temperature
    within a tolerance. Velocity and air seeds are ignored.
  - It flags the bricks that differ. The slab and the flags are read back asynchronously (PBO + fence).
  - The flagged bricks go, compressed, into a CPU store keyed by world brick. That is all the world's edits.
- **Generator.** Deterministic from a world seed, evaluated per cell in a GPU pass:
  - a heightfield from fBm noise with domain warping;
  - rock under soil;
  - sand at sea level, water below it;
  - snow on peaks;
  - plants on gentle slopes.

  Trees and other structures are stamped by the CPU from the existing constructions, placed deterministically
  per brick column, when their slab loads.
- **Boundary.** Cells outside the window are a frozen boundary for the sim. They can't move, nothing moves into
  them, and they conduct no heat.
- **Far field.** A world-sized brick grid (a WebGL2 3D texture, one RGBA8 texel per world brick) holds what the
  window doesn't:
  - dominant material, solid fraction and glow;
  - occupancy mips (16³ and 64³ cells) for skipping empty space.

  Rays that leave the window, or start outside it, continue through it with simple shading: material colour, sun
  with a coarse shadow, sky ambient and aerial fog. It is built from the generator, and updated from leaving
  slabs' flags and data.
- **Undo and multiplayer.**
  - Undo stores bricks keyed by world brick (D10), so it survives window moves.
  - Multiplayer guests share the host's window.
- **Phases.**
  - W1: world-coordinate plumbing, pixel-identical for today's sizes.
  - W2: shift, fill and store, with edits persisting when you walk away and come back.
  - W3: the generator's look.
  - W4: the far field.
  - W5: UI (a "World" size), camera and POV focus, painting only inside the window, signs, multiplayer limits.
- **W1–W2 as implemented** (`src/world/window.js`, `src/world/store.js`, `src/shaders/window.js`; test mode
  `?size=world`: 1024×128×1024 through a 128³ window; checked by `tools/world-check.mjs`).
  - `uOrigin` lives in the prelude and `Simulation.run` sets it on every pass; `seed3` hashes the world cell
    (`seedWorld`). The look reads `worldPos(p)`: materials, relief, glints, ripples, caustics, liquid and media
    detail, floor lines. The shadow map's lattice snaps to whole texels of the offset. The box sits at its world
    origin in the scene, so a move leaves the camera (and TAA's history) alone.
  - A move: stage the leaving slab and flag its bricks against the generator; `Simulation.shift` (state, the field
    EMA through the EMA pass's `uShift`, GI probes, the flow field); the generator fills the uncovered slab; stored
    bricks are written back; trees are stamped into brick columns visited for the first time (one batched pass
    clipped by a column mask, a per-world planted record), so a visited tree comes back as stored bricks;
    `syncCopies`. At most one move per frame, none while the last slab is still being read back.
  - Readback in two phases: the flags, then only the differing bricks, packed. Bricks are stored byte-plane
    transposed and PackBits coded, synchronously (the uncovered slab is filled in the same frame). A brick that
    matches the generator leaves the store, and so does one that comes back into the window.
  - Store tolerances: matter within STORE_MATTER_T (0.5 °C) and STORE_LIFE_TOL of the generator, seed and ctype
    exact. Snow and the frozen rock under it drift past them while the sim runs (no cold air yet), so they were
    stored as they drifted; W5's World has no snow.
  - Render history moves with the cells rather than starting over: the first frame after a move differs from the
    one before in 0.4% of its pixels (starting over: 2.4%; drawn without world anchoring: 43%).
  - Measured per move under other sessions' GPU load: ~4–6 ms GPU (shift 0.8, flow field 0.6, GI 0.3, stage 0.6,
    flags 0.7, columns and fill 0.8, copy sync 0.5; stored bricks +0.9, first-visit trees +1.6–2.8) and 2–3 ms CPU
    (+3 ms placing and baking trees on new ground); when the slab lands, 1.1 ms copying ~450 bricks and 2.2 ms
    coding them. The store after a loop more than 3 window widths out: ~13,000 bricks, 4.8 MB, mostly trees.
  - Not yet (at W2): undo was cleared by every move; signs, construction previews, POV tool holds and multiplayer
    guests didn't follow the window (W5, below); nothing outside the window is drawn or casts light (W4).
- **W5 as implemented** (the app: `src/app.js`, signs, POV, multiplayer; the World option in Settings → Grid size).
  - World is a size of the Grid size row (`WORLDS.world`: 1024×128×1024 through 128³), saved like the box sizes;
    `?size=world` still works. Clicking it again starts the world over. In World the Scene row lists the world's
    scenes instead of the box's ("Scenes", below); the Grid size row goes back to a box. A switch disposes the
    window, its generator, the Island scene's generator (`releaseGenerator`) and the box's outline material.
  - The island world has no snow caps (`scenes/island.js`: `worldParams({ snow: false })`, `uGenSnow`): the air is 20 °C everywhere, so snow would
    melt and every melting brick would be stored. Its peaks are bare rock above the plant line, and no rock is
    frozen, so nothing it generates drifts. The box's Island scene keeps its snow.
  - The window starts on the island's shore toward the god view's camera (`worldStart`: from the island's centre
    toward the camera, a WIN_STEP at a time, to the waterline; centred a quarter of its width inland), so the first
    view is sea, beach, trees and the hills behind; the middle of the island is bare rock. The god view's home is
    framed over the window's centre, the orbit target on the ground (`homeOver`); R frames it again over where the
    camera looks instead of flying back. WASD tops out at WORLD_CAM_SPEED_MAX so the window keeps up. The floor
    grid spans the world's footprint, and the window's outline shows in the god view (where it paints), not in POV.
  - Picks remember the origin they were asked at and land in the grid as it is (`pickedNow`); a picked cell that
    has left the window doesn't count. So the brush, the construction ghost and placement, the eyedropper, signs
    and the POV crosshair act only inside the window: drag-painting past its edge shows no brush and paints
    nothing (a box's brush still stops at its walls). The HUD reads "2.1M of 134.2M cells".
  - Signs are pinned to world cells (`sign.world`) and placed in the grid from `sim.origin` every frame; outside
    the window they are hidden and left out of the probe.
  - Undo: each snapshot keeps its origin. An undo after moves copies the cells the old and new windows share
    (`undoShiftFrag`: the snapshot's cell p + shift; everything else is discarded, so it keeps what it holds), at no
    cost per move. If they share nothing it does nothing, says "Too far away to undo that", and keeps the snapshot
    for when the window is back. Out of reach: the part of a change that has left the window (it is a stored edit).
  - POV: the body's probes in flight land shifted rather than dropped, so a move never stalls it; a body outside the
    grid's columns waits (a respawn far away: the drop point stays put in the world and the window comes to it).
    `toolbelt.windowShifted` reaches every tool: the gun's rounds (positions, trace answers asked before the move,
    the last impact), the physgun's hold point, the axe's last hit; a tool's async event pins its point
    (`transfer.js pinned`). Leaving POV in World brings the god view back over the body, framed as it was.
  - Multiplayer: hosting in World is refused ("Multiplayer isn't available in World yet"), and so is World while
    hosting; a guest's grid always follows the host's box (a key frame takes a guest out of World), and an invite
    opened with World saved boots in a box.
  - `Simulation.run` gives a pass kept across grids of the same size (a POV tool's, the construction stamp) the
    current simulation's origin, instead of keeping the first one's.
  - Checked headless (under other sessions' GPU load, 11–16 fps):
    - 3 box → World → box round trips plus 64³, 160×96 and 96³: `renderer.info` geometries 5 → 5, textures
      58 → 58 (World holds 60, the same every time), programs settle at 35; no console errors; World survives a reload.
    - Boxes render as before: `tools/regress.mjs` against `scale` differs by 0 pixels at the tool's 1% fuzz, detail
      on and off (unfuzzed, two `scale` runs differ from each other by as much as `scale` and this branch do).
    - In POV across 9 window moves, signs keep their world cell and scene position, hide outside the window and show
      live values back inside; a physgun ball holds its world position over a move and back; a round fired across a
      move strikes the plate where it is (a control with the rounds left unshifted misses by the 16 cells).
    - A house walked 320 cells away and back (40 moves) comes back cell for cell; an undo after 2 moves takes a
      stroke back and changes nothing else; from 160 cells away it refuses and works on return.
    - Hosting in World, World while hosting and a World invite all end in a box with the toast.
    - A move waits for its leaving slab's readback: here ~9 frames (~320 ms) a move, so the window followed at
      ~35–100 cells/s; WORLD_CAM_SPEED_MAX (9 units/s, 115 cells/s) is what an unloaded GPU should keep up with.
  - Not yet: undo is cleared by every move and reload; signs, construction previews, POV tool holds and
    multiplayer guests don't follow the window (W5).
- **W4 as implemented** (`src/world/far.js`, `src/shaders/far.js`; checked by `tools/far-check.mjs` and, on the CPU,
  `tools/check-far-trees.mjs`).
  - The far grid is a 2D atlas of brick slices (2048×1024 RGBA8 for 1024×128×1024, 8 MB), not a 3D texture: a
    region of it is one draw, and two bilinear taps make a trilinear sample. Per brick: the opaque and the liquid
    share of the 8-cell cube centred on it, its dominant opaque element (open cells count 8×) with its liquid's kind
    and an "open" bit, and glow. A cube twice the brick makes the field linear in the ground's height between two
    centres, so its 0.5 level sits on the terrain (a brick's own share put it up to ⅓ cell off: terraces). The view
    samples a second, filtered target, the field: there matter under half a cube with no neighbouring brick at the
    surface level (trunks, walls up to 3 cells, roofs, streams) reads as full, so it shows as a blob, rod or slab
    instead of vanishing, while crowns, cliffs and the ground keep their shares (and their shapes).
  - Occupancy: L1 (16³ cells) set where some brick in it or next to it reaches 0.5, L2 (64³) where an L1 is.
  - Built at load from the generator at world scale: genColumn and genLayers per world column, then every brick
    from the layers of the columns its cube spans. The trees are in it too: a GPU twin of `treeCandidate` per brick
    column, thinned by `treesIn`'s rule, each drawn as its construction at brick scale. mulberry32's i-th draw is a
    function of seed and i, and the draws before a construction's first per-cell shape are a known count, so
    heights, oak crowns, pine tiers and palm leans are the construction's own.
  - Updated from the window: the slab about to leave is summarized in the move's step 1 (from the state, before the
    shift), so edits stay visible after they leave; while the sim changes the window, it is swept a 16-cell slab a
    frame every 120 frames (its copy casts the far field's shadows and feeds the window's GI). Then the occupancy, the brick-column tops and the
    shadow heights are rebuilt.
  - Drawn by one full-screen pass before the scene (renderOrder −10, depth func always): sky with the sun's disc, the
    open sea beyond the world (its bed at the generator's floor, so the world's edge doesn't show), and the far grid.
    Rays skip the window's box (the volume draws it), cross unset L2/L1 nodes whole and walk set ones brick by
    brick, root-finding the trilinear field. Shading: `matOf` at the pixel's footprint (its texture fades to its far
    look like the window's), sun through a shadow height field (per brick column: the max over the columns toward
    the sun of their ground's top, seen from below, less the sun ray's drop; crowns don't cast: as pillars they
    shaded whole forests and beaches), sky ambient with a two-tap field AO, glow; liquids with Fresnel
    to the sky and the sun's glint and a Beer–Lambert body down to the bed; aerial perspective from the sky model
    (12 km visibility, the sky's spectral shape). Depth is written, so the volume and scene objects composite.
  - The window takes three things from it (world mode only, `FarField.attach`): its sun shadow map the far field's
    shadows (`shadowFrag`'s casters: along a sun ray the shadow height above it only falls, so one read says whether
    a texel ray goes under it and bisection finds where; GI gets them through the map); its GI the far field past
    where a probe's ray ends (`giGatherFrag`'s far: the brick-column tops at doubling distances, so distant hills
    block the low sky and light it back with their ground's albedo, and the sea lies past the coast, instead of open
    sky and a concrete floor); and its volume the same aerial perspective (`volumeFrag`'s haze), so the window
    doesn't stand out crisper than the land around it.
  - The view's program compiles in the background (`compileAsync`); the far field shows once it's ready.
  - Switching to a world compiles nothing big (2026-10-09). The box's view, shadow and GI programs hold the three
    parts above, off behind one uniform (`uFar`, turned on by `attach`), for the one world size
    (`shaders/far.js WORLD_SIZE`); the world offset is a uniform add (`uOrigin`, 0 in a box) rather than a compile
    flag. So a world's window draws with exactly the box's 38 programs (`check-shaders.mjs` asserts the sources
    match), and `app.js build` keeps the old grid's materials alive until the new grid's have claimed their
    programs (`gfx/programs.js`), so they carry over instead of being deleted and compiled again. Before, a switch
    recompiled ~1.4 MB of GLSL synchronously (the raymarcher alone is many seconds cold on ANGLE/Metal). What is
    the world's own (the generator, the window's moves, the far passes: 18 small programs) compiles in the
    background (`WorldWindow.whenReady`); the window is empty air until then, and the world fills in around it:
    the window's terrain, then the far field when its view's program is ready.
  - When the far field landed, `regress.mjs` against `scale` wasn't deterministic run to run on a busy GPU (its hidden
    dock tiles draw from the seeded `Math.random` as wall-clock frames go by, and `sim.giFrame`'s parity depends
    on frames since boot); reseeding and zeroing those before each preset load, this branch differs from `scale`
    by less than `scale` differs from itself (summit 1 vs 5 px, volcano 10 vs 14).
  - Measured (M5, headless, other sessions holding the GPU at 70–99%, so these are high): the far pass, interleaved
    with and without it, 1.5–3 ms in the god view and 2.2–4.9 ms in a low view at the default render scale
    (853×533 for a 1280×800 canvas), 4–9 ms at 1280×800 native; about a third is the march, the rest shading
    (`matOf`, the short sun ray). The build at world load 40–75 ms GPU-synced; a move's leaving slab ~1.4 ms; a
    sweep frame the same; shadow heights 0.1–0.2 ms. A move changes 6 of the far field's pixels (window masked
    out, frame fixed). The GPU's tree placement agrees with `treesIn` (350 of 350 trees over a region).
  - Not yet: no blend band at the window's sides; no gases (smoke, steam, fire) in the far field; the far field's own
    ambient sees only a two-tap AO, not distant hills; it isn't drawn in the data views; guests don't get the host's
    edits outside the window (W5).

- **Scenes** (`src/world/scenes`; checked on the CPU by `tools/check-scenes.mjs`). What a world holds is a scene:
  the island and five more, picked in Settings → Scene while the grid is World (`settings.scene`, saved; `?scene=`
  too). Picking one starts the world over with it (`build`, as clicking World again does).
  - A scene is an object (`scenes/index.js` documents it): `params({ size, seed })` → P with at least `sea` and
    `floor`; `glsl(g)` defining `sceneCell(world cell, A, B)`, the generated state of any cell, a pure function of
    the cell and the scene's `uniforms(P)`; `start(P, win)` and `ground(x, z, P)` on the CPU (the window's first
    centre, and the god view's home over a column); optional `prepare(renderer, P)` (a Promise for GPU work before
    the first fill, e.g. baked textures) and `dispose()`. Adding one is its file plus a line in `WORLD_SCENES`.
  - The island keeps its own path (the column pass, `genLayers`, its trees, the far field from its columns, layers
    and tree map), unchanged. Every other scene fills and diffs through `sceneFillFrag` and `sceneDiffFrag`
    (`shaders/generate.js`: `fillFrag`'s and `diffFrag`'s contracts, the same store tolerances) and plants nothing.
    Its GLSL goes only into the world's own small passes (fill, diff, far build), after the prelude and nothing
    else, so the window still draws with the box's big programs. Its uniform objects are shared by all of them;
    `prepare` runs with the window's background compile (`whenReady`), which then refreshes their values, and the
    world loads once both are done. `dispose` runs with the window's; the old window's materials are retired
    until the new one has claimed their programs, so a scene switch compiles only the new scene's passes.
  - Its far field is built from `sceneCell` progressively (`world/far.js sceneBuild`): the window's region from
    its state at once, then the rest in chunks of 16×16 brick columns, one a frame, nearest the window first (about
    four seconds for the whole world at 60 fps, the ground around the window in the first few frames; each draw is
    small). A chunk is two passes: `farSceneCellsFrag`
    evaluates `sceneCell` once per cell of its columns and the two around them that its bricks' cubes reach (an
    816×768 half-float atlas of (id, °C)), and `farSceneFrag` summarizes its bricks from those cells exactly as
    `farWinFrag` does from the window's state. Brick columns the window has summarized (on load, leaving slabs,
    sweeps) are left alone (a per-column mask), so its edits win. The view draws what is built so far (the rest
    reads as empty), and redraws as chunks land; the levels, tops and shadows follow every 8 frames and at the end.
  - Sea level 0 means no open sea: the far view draws a rock plain beyond the world instead, at the median ground
    height along the world's edge (the scene's `ground`), so it meets the edge, and inside the world a ray that
    meets nothing (an empty column down to the world's bottom) ends on the bottom, not on a sea; the GI's rays read
    rock past the edge instead of sea, and the cloud deck counts its height from the plain.
  - Not yet: two live windows over the same scene (only tools make them) share its `prepare`d textures, so the
    first one's `dispose` takes them from the second.

## Measured (M5, headless Chrome, ANGLE Metal, 128³)
- Lab step: 2.6 ms with 42% of bricks skipped, 3.75 ms with none skipped. An empty box still costs 2.1–2.8 ms.
- Derived passes: about 3.4 ms per frame.
- **Partial-target draws** (raw WebGL2 micro-benchmark, a 2048×1024 target, react-like shader, two runs under
  GPU contention, so treat absolute numbers loosely):
  - **Cost follows touched 32×32 regions.**
    - One 8×8 tile: 0.04 ms.
    - The full target: 0.53 ms.
    - 3% of tiles, clustered: 0.30–0.42 ms.
    - 3% of tiles, scattered: 0.55–0.80 ms.
    - So untouched hardware tiles are skipped, and clustering matters.
  - **Instancing every tile** costs 1.3–3.4× a single full-screen quad, so draw per supertile and fall back to
    full screen.
  - **Cost follows bytes:** RGBA32UI (16 B) is roughly half of 2×RGBA32F (32 B).
  - **`invalidateFramebuffer` before a full-screen pass is 13–33% slower,** not faster, on ANGLE Metal. D4 is
    measured in the app and dropped unless it shows a gain.

- **D9, incremental derived passes** (`tools/derived-bench.mjs`: `updateBricks` per frame while the sim runs 4
  steps a frame, interleaved A/B, rounds dropped when the GPU was shared; median and IQR in ms):

  | scene | before | D9 | D9, full rebuild | D9 / before (paired) | regions E/D/W |
  |---|---|---|---|---|---|
  | lab | 4.65 (4.18–4.88) | 3.82 (3.62–4.11) | 4.59 | 0.84 | 63/68/72% |
  | island | 4.16 (3.89–4.30) | 3.00 (2.89–3.11) | 4.38 | 0.73 | 43/48/54% |
  | volcano | 4.23 (3.90–4.43) | 4.14 (3.85–4.36) | 4.11 | 0.97 | 72/86/92% |

  - Per pass (p10 over 120 frames, 0.1 ms timer steps), the brick pass is the biggest: 2.0–2.3 ms, falling to 1.6–2.0.
    It rebuilds a third to half of the bricks, but the bricks it skips are mostly cheap air, and SIMD groups that mix
    dirty and clean bricks still run the full loop. The field passes fall from about 2.4 ms to 1.5–1.9 in lab and
    island. The bookkeeping (age, dirty, regions, share, EMA copy) costs about 0.3 ms, so a full rebuild through it
    costs about what the old passes did.
  - Region size: 4- and 8-brick regions measured the same within noise, 16 a little more; 2 lost (32k instances a
    pass, and a slow share pass). Regions still beat the full-screen quad at the highest share measured (92% WORK:
    field passes 2.0 ms against 2.3).
  - Shadow and GI (unchanged): 2.6–4.3 ms more per frame.
  - What would cut more: a dirty test on what the renderer reads rather than on activity (non-quiet bricks include
    resting matter and the quiet halo, and the 13-frame tail follows every one of them), and a cheaper brick pass.

## Workstreams
Branch names are `scale-<name>`. Each lives in its own worktree `../tpt-scale-<name>`, branched from `scale`.
The lead merges finished work into `scale`.

| Stream | What | Depends on |
|---|---|---|
| rest | D2 rules + tile engine parity + awake-share measurement | — |
| foundation | D4, D5, then D6 | — |
| bench | `tools/bench.mjs` A/B harness + physics census report | — |
| profiler | in-app profiler (Settings → Developer) | — |
| pack | D7 + D8 fusion | foundation, rest |
| skip | D8 sleeping bricks + reduction | pack |
| derived | D9 | foundation, skip |
| undo | D10 | foundation |
| world | D11, in phases | foundation, skip |

## Rules for every agent
- **No magic numbers.** Every threshold, rate, size or encoding parameter is a named constant with a unit comment.
  Engine constants go in `src/physics.js`.
- **Match the code around you.** Comment density, naming, plain ES modules.
- **Proofs before handing back:**
  - refactors: pixel-identical `tools/regress.mjs` against `scale`;
  - physics changes: census before/after (mass per element, energy, awake share);
  - performance changes: `tools/bench.mjs` A/B numbers;
  - always `node tools/check-shaders.mjs`.
- **Processes.**
  - Use your own vite port with `--strictPort`, and kill only your own PIDs.
  - Never pkill shared processes.
  - Check that `ioreg -r -d 1 -c IOAccelerator | grep "Device Utilization"` is near 0 before trusting timings.
    Other sessions' tests share the GPU, so prefer interleaved A/B runs.
- **Git.**
  - Commit WIP early and often on your branch.
  - Never use `git stash`.
  - Never push, never merge into `main`, never deploy. The user tests everything live at the end.
- **Headless.**
  - Playwright's chromium with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` is the real GPU.
  - Downscale screenshots (`sips -Z 900`) before viewing them.
  - Keep runs short; the machine is a laptop.
