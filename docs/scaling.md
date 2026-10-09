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

### D9. Derived passes are incremental where they can be
Fields, bricks and light are rebuilt only for bricks that changed within their settle window (EMA), dilated by
each kernel's reach. Shadow and GI keep their own cadence. Converged regions cost nothing.

As implemented (`sim.updateDirty`, `shaders/passes.js` dirtyFrag, `gfx/regions.js`):
- **What changed.** A brick may have changed since the last `updateBricks` if a step's quiet map didn't skip
  it: every map a step used is noted (`noteAwake`: 1 − quiet into `actChanged`, the first map after an update
  overwriting it and later ones blending with MAX, so nothing has to clear it), including a map still current at
  the last update that later steps reuse. A write that isn't a step changes every brick,
  unless it declared its box first with `sim.touch(lo, hi)`; the brush does. Loads, undo, network frames, stamps
  and first-person tools rebuild everything for a settle period.
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
  nothing is read back. The region size (8 bricks) and the share (0.75) are provisional: picking them by
  measurement (`tools/derived-bench.mjs` over builds with other values) is still owed.
- **Brick map** rebuilds FIELDS bricks only (the rest discard). The empty-space distance and the glow volume are
  cheap brick-resolution passes and stay full.
- **Shadow and GI** stay full every derived frame.
  - The shadow map's texels each depend on every brick their sun ray crosses. With the sun held (`DAY.running`
    is off by default) an exact incremental map would re-trace every ray through a brick whose state, fields or
    empty-space distance changed. The distance matters because `skipEmpty`'s jumps set `tEnter` where a cell step
    would accumulate `tMax`, so the stored depths change in their last bits; a brick filling or emptying changes the
    distance of every brick within `BRICK_DIST_MAX` (8) of it. How much of the map that leaves untouched in running
    scenes is still to be measured; not done.
  - GI blends its probes every frame, each traced every other frame, and its sources read the previous probes for
    bounce light, so its values keep moving everywhere the blend hasn't settled in half floats, and a change
    reaches every probe whose rays (up to about 18 bricks) cross it. Nothing local stays fixed to skip.
- **Proofs:** `tools/regress.mjs` against `scale`, settled and `--motion`, with detail off and on: all 26 views
  AE 0. `tools/derived-check.mjs` (every derived target bit for bit against `sim.incremental = false`, over steps,
  painting, the heat tool, undo, a pause and 1, 3 or 4 steps per frame): identical at 128³, 96³, 64³ and wide.
  Both ran before the last two changes (no clearing pass for the changed map; a touch box covers the next pass
  only), which are still to be re-run. Timings (`tools/derived-bench.mjs`): owed; the GPU was saturated by other
  runs, then live tests paused for battery.

### D10. Undo (deferred)
Copying only the bricks a stroke touches isn't a correct undo: matter flows out of those bricks afterwards.
The exact version copies each brick when it first wakes after the snapshot (a sleeping brick hasn't changed), so
it needs D8's activity machinery. Until then, snapshots stay full copies: packing (D7) halves them, and window
moves (D11) clear the history.

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
    exact. Snow and the frozen rock under it drift past them while the sim runs (no cold air yet), so they are
    stored as they drift.
  - Render history moves with the cells rather than starting over: the first frame after a move differs from the
    one before in 0.4% of its pixels (starting over: 2.4%; drawn without world anchoring: 43%).
  - Measured per move under other sessions' GPU load: ~4–6 ms GPU (shift 0.8, flow field 0.6, GI 0.3, stage 0.6,
    flags 0.7, columns and fill 0.8, copy sync 0.5; stored bricks +0.9, first-visit trees +1.6–2.8) and 2–3 ms CPU
    (+3 ms placing and baking trees on new ground); when the slab lands, 1.1 ms copying ~450 bricks and 2.2 ms
    coding them. The store after a loop more than 3 window widths out: ~13,000 bricks, 4.8 MB, mostly trees.
  - Not yet: undo is cleared by every move and reload; signs, construction previews, POV tool holds and
    multiplayer guests don't follow the window (W5); nothing outside the window is drawn or casts light (W4).

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
