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
  This must not stop a falling column: a cell moving down is not "at rest". Snap a supported cell's tiny speeds
  to exactly 0 below a named epsilon.
- **Liquids flow only where they can.** A pool's flow is re-kicked (react.js FLOW_KICK) only when the cell has
  somewhere to go: an open or lighter side neighbour, or an open lower diagonal. Otherwise its velocity decays
  and snaps to 0. Measured today: water that can't move carries 0.77 cells/step forever.
- **Inert means nothing can change.** This replaces "air at 20 °C or a solid at 20 °C". A cell is inert when:
  - it can't move: it is at rest, and for powders and liquids every place it could move into is blocked,
    including the diagonals the move pass topples into;
  - nothing can react: no ignition, melting, acid, plant growth, clone emission, fire, smoke or gas;
  - it is thermally quiet: air within AIR_REST_T (1 °C) of ambient, and matter within MATTER_REST_T of every
    neighbour.

  A brick is quiet (skipped) when it and its 26 neighbours are inert. Measured: a 1 °C air tolerance alone
  takes the skipped share from about 45% to 64% (lab, volcano).
- **Energy bound.** The halo rule means heat flows into or out of a sleeping region only below the tolerance,
  and any drift past it wakes the brick. State this bound in a comment where the tolerance is defined.
- **Heat that can't overshoot.** Cap each face's exchange at 1/6 of the energy that would bring the pair to
  the same temperature. The limiter is symmetric in the pair, so conduction stays exactly conservative and
  becomes unconditionally monotone.
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
Two integer textures per copy, 20 bytes per cell instead of 32:
- **A = RGBA32UI**
  - x: id 8 | ctype 8 | seed 16 (the seed field may become the rest position; keep it 16 bits)
  - y: temperature as f32 bits
  - z: life f16 | pressure f16
  - w: vx f16 | vy f16
- **B = R32UI**
  - x: vz f16 | flags 16. Bit 0 = inert (written by react). The other bits are reserved.

The accessors decode to the D5 floats, so readers don't change. Temperature stays f32 (conduction fluxes are
tiny and must not round away). This is a precision change: prove it statistically (census, conservation,
settling), not pixel-wise.

### D8. Two passes per step, and skipping sleeping bricks
- **Gather fused into react.** A step is a block pass (one fragment per Margolus block, 8 slot results), then a
  react pass that reads each cell's post-move state through the block results for itself and its 6 neighbours.
  Slot result = RG32UI: source 3 bits + impact heat 13 bits + vx f16, then vy f16 + vz f16.
- **Activity comes from react's inert bit.** A brick reduction reads 4 bytes per cell, not 32.
- **Sleeping bricks are not touched.** How depends on the benchmark in "Measured" below: instanced brick quads
  if untouched hardware tiles cost nothing, otherwise chunk pages.
  - A brick that has been quiet for two activity maps in a row is identical in both state copies, so no pass
    needs to write it.
  - Every pass that writes only active bricks must keep that two-map rule.

### D9. Derived passes are incremental where they can be
Fields, bricks and light are rebuilt only for bricks that changed within their settle window (EMA), dilated by
each kernel's reach. Shadow and GI keep their own cadence. Converged regions cost nothing.

### D10. Undo stores changed bricks
Snapshots copy only the bricks a stroke or scene change touches, not three full copies of the state.

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

## Measured (M5, headless Chrome, ANGLE Metal, 128³)
- Lab step: 2.6 ms with 42% of bricks skipped, 3.75 ms with none skipped. An empty box still costs 2.1–2.8 ms.
- Derived passes: about 3.4 ms per frame.
- Partial-target draw cost (D8): *pending, filled in by the lead.*

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
