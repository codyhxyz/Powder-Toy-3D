# v2 pitch: LEAN. Do less, do it once, do it only where it shows.

Philosophy: performance first, then the smallest set of mechanisms that still looks and feels right. The iPhone 17
Pro Max at 60 Hz and low power is the reference device. The MacBook Pro runs the same game at more pixels and 120 Hz.
Every pass has a budget in milliseconds and megabytes, and a runtime governor and CI enforce it. Anything that costs
more than it shows is cut. Where two mechanisms do one job, one of them goes.

Inputs: the four audits, `docs/webgpu.md` A–F and the Sync log, the subsystem maps, and `claude/webgpu-port` 42f4039.
Evidence (section 11): `v2/lean/lean-sim.mjs`, a 3D CPU prototype of the rules below, reruns the audits' failing
experiments (slab, heap, U-tube, puddle, partial layer, pipe, hole). Every number marked "prototype" comes from it.

---

## 0. The pitch in twelve lines

1. **Budgets are law.** iPhone at 60 Hz: ≤ 6 ms GPU and ≤ 60 MB DRAM per typical frame. Mac at 120 Hz: ≤ 4 ms and
   ≤ 70 MB. A resolution governor and per-tick work caps hold them at runtime, and CI checks them on scripted scenes.
2. **Raster, don't march.** A GPU mesher turns exposed cell faces into 4-byte instances and rebuilds only the bricks
   whose occupancy changed (Minecraft's chunk meshes). They're drawn at 2/3 resolution per axis, and TAAU brings that
   to output in one fused present pass.
3. **One material function** (4 palette tones, one cell-scale pattern texture and a surface class) and **one light
   function** (a rasterised sun shadow, a per-cell sky and block light grid, corner AO, one sky and one emission
   table). No term needs more than one frame to be right.
4. **One clock**: a fixed 60 Hz tick at 2 g, which is TF2's gravity, for every system including the player. It's
   decoupled from presentation.
5. **One state copy, 16 B per cell, updated in place.** Today it's 80 B per cell plus 76 B of render fields.
6. **Three motion paths, each the cheapest for its job.** *Column fall* moves vertical runs of any length (slabs stay
   slabs). The *block pass* handles contact: topple, sink, heat, reactions, fire and sparks. *Particles* carry anything
   with sideways speed (Noita). There is no per-cell velocity.
7. **Liquids are integer fill plus face flux** (weakly compressible pipes), and jets leave as particles at Bernoulli
   speed. Prototype: the U-tube levels within 2 cm, a partial top layer comes out flat, every case rests and sleeps,
   and mass is exact.
8. **Gases are not cells.** They're 5 species on TPT's coarse air grid (one air cell per 4³ brick, 1/64 of the cells),
   with real pressure and wind. FIRE, SMOKE and STEAM cells, which never rest today, go away.
9. **Rest is reported by the rules** (`possible`), not mirrored in a second predicate. A settled world costs nothing:
   0 dispatches, 0 submits, 0 rAF.
10. **Everything after the sim keys on occupancy change**: the mesher, the light grid and the shadow. Nothing keys on
    the step counter, and fill, temperature and glow are read live, so they don't cost a remesh.
11. **A kill list of ~80 items** (section 7): the raymarched volume, the field pipeline, GI probes, the 13 `matOf`
    branches, relief, grains and clods, whitewater, the far marcher, the plain view, X-ray, radial gravity, gas
    cells, and the CPU twin.
12. **The foundation stays:** `src/gpu/*`, the app shell, brick-major order and its four index functions, GPU-built
    lists with indirect dispatch, box-scoped edits, the determinism rules, the tables buffer, AgX, bloom and the
    histogram, deep idle, and the measuring tools.

## 1. House rules

- **The iPhone is the reference.** A feature that doesn't fit the phone budget doesn't ship as a default anywhere.
  The Mac gets more pixels and 120 Hz, not a different look. That fixes audit-render B11 by construction.
- **Change-scaled or not done.** One falling grain costs the bricks it touches, never the world. CI asserts the
  workgroups per changed brick.
- **One of everything:** one clock, one sky, one emission function, one material function, one light function, one
  motion law per regime, and one implementation (no CPU twin).
- **TAAU accumulates resolution, not noise.** No Bernoulli estimators or random secondary rays, and nothing that needs
  100 frames to converge. A still view is final after 8 jittered frames, and then the app stops.
- **Real units in, one declared multiplier out.** kg, J, m/s, °C. Where play needs unreality (2 g, heat ×10⁴, blasts
  ×10⁻³), it is one named constant with its factor printed beside it.
- **Borrow and cite** a touchstone in a comment wherever a rule needs a number (CLAUDE.md).

## 2. Renderer

### 2.1 The frame

```
per tick (60 Hz, compute, only when its input changed)
  1 mesher    remesh list = bricks whose ids changed + their 6 face neighbours → face pages        ≤ 512 bricks/tick
  2 light     dirty boxes of the per-cell light grid: change ⊕ light radius, recomputed by flood     ≤ 256K cells/tick
  3 shadow    depth-only raster of opaque faces from the sun, 1024²; when the sun moved or a
              remeshed brick is in its frustum; ≤ 30 Hz
per presented frame
  4 cull      compute over non-empty bricks: frustum + per-direction backface → page list, indirect args
  5 scene     render pass at internal res: opaque faces (one pipeline), three's opaque meshes → rgba16f + depth32
  6 liquid    only if liquid or glass faces are visible: copy the covered rect of colour, then liquid and glass faces
              (depth-tested) read colour + depth and write colour (the same render pass as 5 when none are visible)
  7 gas       only if gas bricks are visible: march at 1/4 internal res into a small rgba16f
  8 present   render pass at output res, MRT {canvas, history}: one triangle does TAAU + gas composite + bloom
              (last frame's) + exposure + AgX + dither; then, canvas only, particles, flame sprites, birds, cursor,
              brush and box edges, depth-tested by hand against the scene depth
  9 bloom     compute: bloom pyramid from the scene colour at 1/2 internal res (5 levels), histogram, adaptation
```

That is 2–4 render passes (three's opaque meshes are their own pass in POV and World) and 2–3 compute passes per
frame, where the port records 5 render passes and ~76 dispatches. On TBDR the opaque pass is the cheapest thing Apple
draws: hidden-surface removal runs before shading, and colour and depth live in tile memory.

### 2.2 Geometry: face pages (4 bytes per face)

- Every non-empty brick (4³) owns a run of 64-face pages in one pool. A face is a `u32`: local xyz (6 bits), direction
  (3), corner AO 4×2 (8), and flags for liquid top, glass and LOD. The brick coordinate sits in the page header.
- The vertex shader reads the face's cell from the state, 16 B shared by its 6 vertices through the cache. From it
  come the id, the temperature (for glow), the fill (liquid top height, averaged over the 4 columns at each corner,
  so water is smooth) and the fall age (for the motion vector). **Changing fill, temperature or glow costs no remesh.**
- What gets a face: opaque against non-opaque, liquid against air, gas or glass, and glass against non-glass.
- Size: the crisp pitch's `faces.mjs` counts the real presets at lab 41K faces, volcano 36K and Dam Valley 136K. That
  is ≤ 0.6 MB at 4 B a face. The pool holds 1M faces (4 MB).
- **Far field (World):** the same mesher runs on the far brick grid the generator already summarises (LOD1: one
  1.2 m block per brick) and on 4³-brick groups (LOD2: 4.8 m), per far chunk, when it's generated or summarised.
  Shading is the same function. This replaces the 400-line far marcher, the CPU surface-nets worker and its detail
  chunks, the far shadow heights and `farTop`.

### 2.3 The material function

- **Per element, one row:** 4 palette tones, a pattern id, a surface class (matte, gloss, metal, glass, liquid,
  foliage, emissive) and a roughness.
- **The pattern** comes from one `texture_2d_array` of 16 hand-authored 32×32 R8 patterns with mips: rock, bark,
  planks, brick, grain, ore, leaves, crust and so on. It is mapped one tile per cell face. At the default god view
  (39–103 m) a cell covers 3–10 px, so the mips land on 4–8 texels per cell and the pattern still reads. Today's
  millimetre detail is gone by 4 m (audit-render 2.3). This is how Minecraft and Noita make materials readable at
  their own scale.
- **Per pixel:** `tone = palette[hash(cell) & 3]` (per-cell variation, TPT and Noita); `albedo = mix(tone,
  tone.next, pattern(uv))`; a metal's F0 is its tone; emission is `blackbody(T) · (1 − F0)`. That's today's
  incandescence table and Kirchhoff idea, now used by every pass (fixes B2's four emission models).
- No per-element branches. Lava is a liquid row whose crust pattern weight falls with T. Adding an element means
  adding a row and, optionally, a pattern.

### 2.4 The light function (used by opaque, liquid, gas, particles and three's meshes)

```
L = albedo · ( sun · max(n·l, 0) · shadow  +  (skyRGB(n) · sky + block) · ao )  +  emission
    + specular (gloss / metal / liquid): GGX sun lobe + skyRGB(r) · sky (Fresnel–Schlick)
then fog toward skyRGB(view)
```

- **shadow:** one `textureSampleCompare` of a 1024² depth map (hardware 2×2 PCF; 8 texels per cell at 128³). The
  map is rasterised from the face pool, depth only, which costs ~0.1 ms on an M5 (est.). No PCSS, no exact sun DDA, no
  per-frame re-trace (fixes perf P2).
- **sky, block:** one trilinear sample of a **per-cell light grid** (rgba8: sky 0–1 and RGB block light, 8 MB at
  128³) at `p + 0.5n`. The semantics are Minecraft's sky light and block light, propagated as a 26-neighbour max
  with distance weights (rounder than Minecraft's diamonds). One value per cell means no leaks through 1-cell walls,
  and the lab tank and the Descent corridors are full of those. A change triggers a recompute of its box dilated by
  the light radius (16 cells), and for sky light the columns under it too. This is exact: light dies within the
  radius, so nothing outside the box ever saw the changed cells.
  Emitters are blackbody(T) above ~700 K (lava, embers, hot steel), lamps, and burning cells.
- **ao:** per-vertex corner AO baked by the mesher (Lysenko, "Ambient occlusion for Minecraft-like worlds", 2013).
  Contact darkening comes for free and is noise-free.
- **One sky:** an art-directed analytic gradient with a sun disc. The same function draws the backdrop, lights
  (projected to 4 L1 SH coefficients once per frame) and reflects (fixes B1: navy backdrop, blue-lit scene).
- **Under water:** sunlight is tinted by `exp(−σ·d)`, where `d` is the depth below that column's liquid top, from a
  128×128 r16 map written by the mesher. That gives coloured light in a tank without the translucent shadow map.
- **Optional, phase 3, only if it fits the phone:** sun bounce injected into the light grid from sunlit faces
  (one-bounce fill light), and half-resolution screen-space reflection on liquid pixels only.

### 2.5 Liquids, glass, gas, particles and fire on screen

- **Liquid and glass faces** are depth-tested against the opaque depth. Each pixel walks the state from the surface
  to the opaque depth and adds `σ(id) · length` for RGB Beer–Lambert, with the top cell's length scaled by its fill.
  The walk is ≤ 16 steps, and a brick flagged "one full liquid" is crossed in one analytic step. Refraction offsets
  the lookup into the copied opaque colour; there are Fresnel, sky reflection and the sun lobe; foam whitens with
  `|flux|` at the surface and recent particle impacts. The scene behind is attenuated per RGB channel, so a body in
  3 m of water goes dark teal (fixes B3). Water tints bodies because three's opaque meshes are already in the colour.
- **Liquid in the air** is particles (§3), drawn after TAAU as small discs in their body colour, with a minimum
  optical depth as an art parameter (Noita readability). That replaces `THIN_BODY_CELLS = 24` (B9).
- **Gas** is one march at 1/4 internal resolution through the air grid's 32³ species texture (trilinear, ≤ 24 steps)
  plus a tiling 32³ noise texture for wisps. It's lit by the light grid and by a per-air-cell sun visibility computed
  once a tick from the shadow map, and hot air glows by blackbody(T) (plasma, fire plumes). It's composited in the
  present pass with a depth-aware upsample.
- **Flames** are HDR sprites with a flipbook, spawned on burning exposed faces (≤ 1 per face, a pool of 8K, 4K on the
  phone), as Halo 3 and TF2 draw fire. Light comes from the light grid, not from the sprite.
- **Flying matter** is drawn as instanced cubes with the same material function, so a thrown clump looks like sand.

### 2.6 Resolution, TAAU, convergence, governor

- **Internal resolution:** Mac 1008×655 for a 1512×982 output (1/1.5 per axis, today's "quality"); iPhone 440×956
  internal for a 660×1434 output (1.5× CSS pixels on a 3× display). The governor moves the scale between 0.5 and 0.8
  per axis to hold the GPU budget. It reads timestamp queries where they exist and rAF lateness otherwise.
- **TAAU:** Halton(2,3) 8-phase jitter and depth reprojection for the static world. Falling cells get per-face motion
  vectors from their fall age (their displacement this tick is known). It uses a 3×3 YCoCg clamp and Catmull-Rom
  history, with the sharpen folded in. Sprites, particles, birds and the cursor are drawn after TAAU, so they don't
  ghost, and moving the mouse costs one present pass (~0.3 ms), not a 109-frame re-converge (fixes perf P6).
- **Converge and stop:** with the camera and the world still, the view is final after 8 frames, then 0 submits and 0
  rAF (deep idle, kept). The World scene's birds now cost a present pass, not a full march (perf K3 "mesh-only
  frames", for free).
- **Crunch mode (Cruelty Squad):** 1/3 internal resolution, nearest-neighbour upscale, no TAAU. It's a style choice
  and also the cheapest phone setting.

### 2.7 What a pixel and a frame cost (est.: arithmetic from the passes above; P0 measures it)

| pass | pixels Mac / iPhone | per pixel | DRAM MB/frame Mac / iPhone | GPU ms Mac / iPhone |
|---|---|---|---|---|
| cull + vertex | 40–140K faces | ~80 ALU per vertex, one 16 B state read per face | 2 / 2 | 0.05 / 0.1 |
| opaque | 660K / 420K | 3 fetches (pattern, shadow compare, light), ~150 ALU, 12 B stored | 8 / 5 | 0.25 / 0.4 |
| liquid + glass (25 % of pixels) | 165K / 105K | ≤ 16 state reads (brick-local, cached), 2 fetches, ~300 ALU | 4 / 3 | 0.15 / 0.25 |
| gas (when visible) | 165K / 105K | ≤ 24 × 2 trilinear fetches, ~400 ALU | 1 / 1 | 0.1 / 0.15 |
| present (TAAU + composite + sprites) | 1.48M / 946K | ~14 fetches (mostly cached), ~200 ALU | 38 / 24 | 0.35 / 0.5 |
| bloom + exposure | 1/2 internal | 5 mips, one workgroup histogram | 7 / 4 | 0.1 / 0.15 |
| **render total, typical** | | | **~60 / ~39** | **~1.0 / ~1.6** |

For comparison, today's realistic module is 5,400 lines with up to 4 secondary DDA walks, 2 traced reflections,
PCSS and 4 `matOf` calls per pixel (audit-render 2.8). The view alone was 3–9 ms on the M5, and SwiftShader spent
55 % of a 64³ frame there (audit-perf 5.1).

### 2.8 Views and overlays

- **Heat view:** the same opaque pipeline with colour from T (TPT's palette) through an override switch. **Pressure and
  wind views:** a slice plane through the air grid, plus a face tint. Both are cheap and keep TPT's identity.
- **X-ray is replaced by a cutaway** clip plane: faces in front of it are discarded and the cut is capped flat.
- **The plain view goes.** The lean look is the cheap look, so a second renderer has no job (audit-render 2.7).

## 3. Liquids

**Bulk: integer fill plus per-face flux (virtual pipes in 3D, weakly compressible).** A liquid cell holds `fill` as a
`u24` with 1.0 = 2¹⁶ and headroom for compression, plus a flux on its +x, +y and +z faces (3 × f16). Each substep runs
two dispatches:
1. **Flux.** Each face's flow is accelerated by the head difference: `q += g·dt²·(p_i − p_j − [vertical])`, with
   `p = fill` for a free surface and `p = 1 + (fill − 1)/COMP` once compressed. Compression is what carries pressure
   through lids, pipes and U-bends, with no special case. The flow is damped by viscosity. Each cell also computes
   its −faces redundantly with the same inputs, so its outflow limit K (never send more than you hold) is known in
   this pass.
2. **Gather.** `fill += Σ in · K_src − Σ out · K_self` in integers. Mass is exact by construction.

Stability is the one hard constraint: an explicit step needs `COMP ≥ 3·g·dt²`. At 60 Hz with 3 substeps that is
0.6 %, and the prototype uses 0.8 % per cell of depth. A 30-cell-deep tank then holds ~12 % more mass than its
volume. 4 substeps halve that if it shows.

**Rest, exactly, and yield from the same knob.** A face's head difference below a dead band drives nothing and its flow
decays fast. The dead band is worth 2 quanta of fill, and never less than the drive whose damped steady flow would
stall under one quantum. Integer fills then reach a true fixed point instead of a ±1-quantum limit cycle, and the
brick sleeps. An earlier revision of the prototype showed the other side of the same knob: with a dead band of 0.05
cell of head per face, a puddle rested as a mound 0.9 cell high and 12 cells in radius, and a partial layer kept a
0.8-cell tilt. **That is a Bingham yield stress.** So mud, lava and slime keep their slopes through a
per-element dead band in head units, and viscosity is the per-element damping (fixes liquids B9). It's one mechanism,
not two.

**Films:** no lateral outflow onto dry ground from a cell under 1/8 full, so a spill stops as a puddle with an edge.

**Airborne: particles.** A lateral outflow faster than 1 m/s into a cell over open air (the cell under it is air or
under 1/16 full) leaves the grid as a particle. It carries exactly the transferred fill, at the Bernoulli speed of the
static head behind the orifice. Mass comes from the flux and speed from the head, because a pipe model's face flow is
not a velocity. The particle flies on the world clock, passes through thin spray and its own trail, and lands on
solids and supported liquid surfaces, depositing its fill. Splashes are particles too, spawned on impact with total
kinetic energy ≤ the incoming (fixes B5 and B6, the energy-creating splash). One rule replaces the whole pour stack:
PACE/R3, `fallAge`, the jet's diagonal exemption, pipe-flow renormalisation, the Torricelli column scan, the wakes,
pour parcels, `jetWGSL` and `thinBodySeg`.

**Two liquids:** one liquid per cell, as today. Flux flows only between cells of the same id or into air. A denser
cell over a lighter one swaps in the block pass (rule R3), so oil and water still invert.

**Foam:** a `u8` per liquid cell (in `aux`). Particle impacts raise it, and so do flux shear and divergence (hydraulic
jumps, wakes). It's advected with the gather and decays at Monahan's 2.5 s (3.9 s in salt water). There's no
aeration pass, no `moveSrc` and no out-of-place move, and every liquid can foam (fixes B12, B13).

**Prototype results** (`v2/lean/lean-sim.log`; 60 Hz, 2 g, 3 substeps; today's numbers from audit-liquids 2.1):

| test | today (GPU, 32³) | lean prototype |
|---|---|---|
| U-tube, 4×4 arms, left filled to 25 | left 25, right 5, *certified idle* | left 12.35, right 12.28 (Δ 2 cm); idle at 6.4 s; mass exact |
| partial top layer (3 layers + 150 cells, 24×24 tank) | 150 beads churn forever, 38 % of the grid awake | flat to 0.02 cell; idle at 4.3 s |
| puddle (6³ dropped on a 64×64 floor) | 1-cell speckle, never rests | a round puddle of 2,526 cells, 2.2–3.1 cm deep; idle at 14.5 s |
| tank → 13-cell pipe, 27 deep | flow stops by step 300 with 922 of 972 cells left | drains 972 → 150 cells in 60 s, still draining |
| 1-cell hole, tank on a 12-cell pedestal | single cells scattered over 20 cells of floor | one parabolic arc of particles; exit speed 0.80 × √(2gh); lands on the parabola within ~3 cells |

The jet at 2 s (x–y slice through the hole, `*` particles, `~` water at least half full):
```
   |#~~~~~~~~****                           |
   |#~~~~~~~#  *****                        |
   |#########      *****                    |
   |#########         ****                  |
   |#########           ***                 |
   |#########             ** *              |
   |#########               **              |
   |#########                ***            |
```

## 4. Physics model and rules

### 4.1 What changes, and why

| today | v2 lean | why |
|---|---|---|
| 240 steps/s at 44 g; sim speed = frame rate (B13) | one 60 Hz tick at 2 g (TF2's sv_gravity 800 u/s² ≈ 20 m/s²), wall-clock accumulator; past 2 ticks per frame, time dilates (Minecraft's lag) | one clock for the grid, the player and particles; the 4× multiplier on every sim byte goes |
| per-cell velocity moved by coin flips in a 2×2×2 block, capped at 1 cell/step (B2, B3) | column fall for vertical runs, particles for sideways motion, no per-cell velocity | slabs stay slabs and throws arc; prototype slab: 1 cell thick at every tick, on the ideal fall curve |
| A, B, F ping-pong + flow: 80 B/cell (S4) | one copy, 16 B/cell, every pass in place | ~5× less memory, ~5× less traffic per awake cell |
| max-plus pressure + 3 %/step decay (B4–B6) | TPT's air map on 4³ bricks, conservative, 0.9999/tick loss | round blasts, containment, vacuum, wind |
| gas cells with brownian jitter, never rest (B11) | 5 species on the air grid | gases rest when the air rests; 1/64 of the cells |
| fire = temperature threshold only (B9) | contact ignition at `flammability · dt` per burning neighbour (TPT), plus temperature | a flame lights wood, and the Campfire's 450 °C pre-heat goes |
| `dens` as mass, KE in dens·cells²/step² (B7, B8) | kg and J: `m = ρ · 0.027 m³`, `toughness` in J | gold breaks steel only when it should; drips break nothing |
| a hand-written rest mirror with 6 tolerances (B1) | each rule reports `possible`; integer state reaches exact fixed points | heaps, pools, gases and hot matter all sleep |

### 4.2 State: 16 B per cell, one copy, brick-major (C2 kept)

```
word0  id u8 | T u16 (1/8 K steps, 0–8191 K) | age u8 (fall age; burn stage for burning cells)
word1  aux:  liquids: fill u24 + foam u8 | others: fuel / life / ctype / latent bank / spark state
word2  liquid flux qx, qy (f16 × 2)          | others: free (charge, wire state)
word3  liquid flux qz (f16) + 16 bits free   | others: free
```

Kernels use a `loadCell`/`storeCell` API over the four index functions, as `fetchA`/`writeState` are used today. The
packing can then change without touching the ~40 POV, world and tool kernels. Alongside the cells: a lazy 4 B
decoration plane (TPT dcolour), an occupancy bit snapshot (256 KB), the air grid (32 B per brick, 2 copies: 2 MB) and
a 32 B particle record (128K on the Mac, 32K on the phone). The giant volcano (6.3M cells) now needs 101 MB and fits
the spec-default 128 MiB storage binding (closes K2.3).

### 4.3 The tick (≈ 20 dispatches when the world is busy, 0 when it sleeps)

```
1 particles   integrate (g, quadratic drag toward the air velocity), swept DDA, land by claim:
              atomicMin of a deterministic particle key in the target's aux word; losers retry next tick
2 column      a thread per (x, z) column over its awake brick range, bottom up: falling runs move by
              d(age) = ⌊s(age)⌋ − ⌊s(age − 1)⌋ cells (s: fall from rest at g, capped at v_t); landings emit impacts
3 block       the fused in-place 2×2×2 kernel from the port, rules rewritten: topple, sink, heat, phase,
              reactions, fire, sparks, breaking (R2–R9); partition offset from a shuffled cycle of all 8
4 liquid ×3   flux, then gather (§3), over awake liquid bricks
5 air         TPT Air on the coarse grid: pressure, velocity, advection of T and species; exchange with exposed faces
6 activity    OR of every pass's `possible | changed` per brick → AWAKE/DRAWN with the run counter (D5 kept), lists, args
7 derived     remesh list, light dirty boxes, shadow dirty flag (§2.1, budgeted queues)
```

### 4.4 The rules (complete list)

- **R1 Fall.** Powders and debris with air or gas below fall as runs in the column pass. A run landing on a slower
  run takes its age, so they move together. A landing emits `KE = ½mv²` for R8. Nothing creates heat on landing:
  `KE_TO_HEAT` (25× the literal value) goes.
- **R2 Topple.** A supported powder in a block's top layer moves to an empty bottom cell if the cell above it is
  empty, the move is reachable, and its class's drop test holds. Reachable means an axis move, or a diagonal one where
  the position hashes to a Moore neighbourhood (50 %). The drop classes are 1 (45°, free-flowing), 2 (63°, cohesive)
  and 3 (72°, clay and snow). The cells below the target are checked in the occupancy snapshot, which keeps the
  kernel race-free. Prototype: round heaps (diagonal/axis radius 1.02, where an all-Moore rule gives a squarish 1.22),
  sand at 0.89 and flour at 1.79 rise per run, certified idle 1.6 s and 2.7 s after an 870-grain pour ends. Today:
  one square, terraced heap for every powder, and it never sleeps (E3, B1).
- **R3 Sink/float.** A denser movable over a less dense fluid swaps vertically at the rate `v_sink(ρ, μ)`. Grains
  displace grains when the density ratio is over 2 (TPT's Weight): uranium sinks through sawdust, oil rises through
  water.
- **R4 Heat.** Each of a block's 12 internal faces exchanges `⌊k·ΔT·dt⌋` in integer quanta, with the harmonic-mean
  conductivity × `HEAT_SPEED` (10⁴, declared). Exposed faces exchange with their air cell. The box's open sides and
  top have an ambient conductance. There's no global pull to ambient and no per-scene `airT`, and a sub-quantum ΔT
  moves nothing, so hot matter cools and then sleeps exactly. Conservation holds to the 1/8 K rounding per exchange.
- **R5 Phase.** Table thresholds with the latent bank in `aux`, kept. Boiling feeds the air cell's vapour; vapour
  condenses onto cold faces as liquid fill (rain, condensation).
- **R6 Reactions.** The NE×NE pair table, evaluated on the block's 3 in-block partners per tick (today: 1, which caps
  every reaction at 1/6). Product temperature comes from energy, capped at the products' flame T (fixes the
  5,300 °C H₂–O₂ flame).
- **R7 Fire.** A fuel ignites by temperature, or by contact with a burning cell at `flammability · dt` per pair
  (TPT). Burning spends `fuel` J from `aux`, heats the cell and its air cell, and releases smoke and CO₂. It ends as
  ash or air, and is smothered by CO₂ in its air cell or by having no exposed face. Flames are sprites; the FIRE
  element goes.
- **R8 Break.** An impact KE ≥ `toughness` J, or an air-pressure difference across a solid face × its area ≥
  `strength`, turns the cell into its `breakInto`. Liquids don't break solids by impact.
- **R9 Sparks.** TPT's electricity automaton over block pairs, kept as is.
- **R10 Liquid flux.** §3.
- **R11 Particles.** Ballistic, with drag toward the air velocity (TPT's advection). Spawned by jets, splashes, blasts
  and wind: a loose surface cell whose air speed exceeds the element's `lift` detaches (saltation). Also by kicks,
  the physgun and POV projectiles, so one law replaces `pov/ballistics.js`'s separate 1 g world. Past the cap, a
  source falls back to the grid: blast debris becomes loosened powder in place.
- **R12 Air.** TPT Air.cpp in 3D on 4³ bricks:
  - `v −= ∇p·dt/ρ`, `p −= κ·∇·v·dt`, semi-Lagrangian advection of v, T and 5 species (smoke, vapour, fuel gas with a
    kind byte, CO₂, O₂);
  - an open-face fraction per brick face, from its fine cells;
  - a loss of 0.9999 per tick (TPT's `AIR_PLOSS`);
  - buoyancy from T and molar mass;
  - blasts add gas and energy (`E · BLAST_SCALE`), and wind and vacuum tools set the air.

**Rest.** Each rule is written `if (possible) { busy = true; if (draw < chance) apply(); }`. A brick sleeps after one
full aligned 8-tick offset cycle in which nothing was possible in it or its 26 neighbours. That uses the port's
AWAKE/DRAWN lists and run counter unchanged. Integer temperature, integer fill and the dead bands make "nothing
possible" reachable: the prototype certifies idle in every case above but the pipe, which is still draining. The
air grid sleeps per cell under quanta of p and v. While any air cell is awake, its 32K cells run as one direct
dispatch, which costs less than building a list for them.

### 4.5 Element table shape

```js
SAND:  { kind: 'powder', look: { tones: ['#dcbc74', '#d3b16a', '#e6c886', '#c4a35e'], pattern: 'grain', surface: 'matte' },
         rho: 1600, cp: 830, k: 0.25, drop: 1 /* 45°, measured 34° */, vt: 12 /* m/s */, lift: 7 /* m/s */,
         toughness: 0, hot: { T: 1700, into: 'GLASS', latent: 0 } },
WATER: { kind: 'liquid', look: { tones: ['#2a78d4'], surface: 'liquid' }, rho: 1000, cp: 4186, k: 0.6,
         sigma: [0.35, 0.047, 0.033] /* 1/m */, ior: 1.33, visc: 0.001 /* Pa·s */, yield: 0 /* Pa */, foam: 1,
         cold: { T: 0, into: 'ICE', latent: 334e3 }, hot: { T: 100, into: 'vapour', latent: 2257e3 } },
WOOD:  { kind: 'solid', look: { tones: [...], pattern: 'bark', surface: 'matte' }, rho: 600, cp: 1700, k: 0.15,
         toughness: 5e4 /* J */, strength: 4e7 /* Pa */, breakInto: 'SAWDUST',
         fire: { flammability: 0.5 /* 1/s */, fuel: 1.5e7 /* J/kg */, flameT: 900, smoke: 0.02, into: 'ASH' } },
// gases are species, not rows:
GAS_SPECIES: { smoke: { M: 29, opacity: 1 }, vapour: { M: 18, condenses: { T: 100, into: 'WATER' } },
               fuel: { kinds: { H2: { M: 2, energy: 1.2e8 }, PROPANE: { M: 44, energy: 4.6e7 } } }, co2: { M: 44 }, o2: { M: 32 } }
```

That's about 18 fields, each with a unit (the values above are illustrative; tuning happens on the shot sheets). Retired fields: `drag`, `friction`, `jitter`, `flow`, `slide`, `spawn`,
`hard` in dens·cells²/step², `rad`, and `dens` used as a mass. Of today's 91 elements, the 37 solids, 23 powders
and 19 liquids stay as rows, migrated by a script that flags what it can't convert. The 11 gases become species and
brush tools: painting "Hydrogen" adds fuel gas to the air cells under the brush, and "Fire" ignites and heats.

## 5. Performance budgets (est.; derivations inline; P0 replaces them with Mac and iPhone timestamps)

Device assumptions: M5 MacBook Pro, ~150 GB/s and ~4–5 TFLOPS FP32. iPhone 17 Pro Max (A19 Pro), ~0.45× of that in
both, per the perf audit's "roughly half an M5". The ALU anchor is today's react at 3.6 ms for all 2M cells on the M5
(commit 5551bd7), about 1.7 ns per cell. I assume the block pass does a third of react's work per cell: it has no
pressure, velocity, drag, friction, jitter, liquid kicks or head scans. So ≈ 0.6 ns per cell on the Mac and ~1.3 ns
on the phone.

### 5.1 Per tick (60 Hz)

| | today, per presented frame (4 steps) | lean typical tick | lean worst tick |
|---|---|---|---|
| awake share | lab 25 % of bricks; leaks keep heaps, pools and gases awake | 5–10 % (no leaks) | 100 % (blast, Snowy Depths) |
| DRAM per awake cell | 167 B × 4 steps = 668 B | ~32 B block + share of column/flux ≈ 40 B | ~60 B |
| block + column | 7.2–10.4 ms (4 steps) | 0.15 / 0.35 ms (Mac / iPhone) | 1.3 / 3.0 ms |
| liquids (3 substeps × 2) | inside the steps | 0.1 / 0.25 ms (~500 awake liquid bricks) | 0.8 / 1.8 ms (a flood) |
| particles | n/a | 0.02 / 0.05 ms (≤ 10K) | 0.3 / 0.3 ms (cap 128K / 32K) |
| air grid (32K cells) | per-cell pressure in react | 0.05 / 0.1 ms | 0.05 / 0.1 ms |
| activity + lists | ~1/7 of the sim | 0.05 / 0.1 ms | 0.1 / 0.2 ms |
| derived: remesh, light, shadow | 5.6–8.4 ms (fields, brick map, shadow 262K rays, GI) | 0.12 / 0.3 ms | 0.5 / 1.0 ms (queues capped) |
| **tick total** | **~13–19 ms** | **~0.5 / ~1.2 ms** | **~3 / ~6.4 ms** |
| DRAM per tick | ~0.7–1 GB per frame, all passes | ~20 MB | ~250 MB |

Worst case on the phone hits the 6 ms tick cap; past it the world slows down, the frame never does. Prototype
activity during a 870-grain pour: 20 busy bricks per tick on average (max 38) and 16 remeshed (max 38). A 1-cell jet
keeps 28 busy and remeshes 6 per tick with ~220 particles in flight. So the remesh cap of 512 bricks per tick only
binds in explosions.

### 5.2 Per presented frame

| | Mac 120 Hz (8.3 ms) | iPhone 60 Hz (16.7 ms) |
|---|---|---|
| render (2.7) | ~1.0 ms | ~1.6 ms |
| sim, amortised | ~0.25 ms (a tick every other frame) | ~1.2 ms |
| **GPU per frame, typical** | **~1.3 ms (budget ≤ 4)** | **~2.8 ms (budget ≤ 6)** |
| GPU per frame, worst | ~3 ms (budget ≤ 6) | ~9 ms (budget ≤ 10; tick capped) |
| DRAM per frame, typical | ~70 MB (8 GB/s) | ~60 MB (3.6 GB/s) |
| camera moving, world asleep | ~1 ms | ~1.6 ms |
| camera still, world asleep | 0 submits, 0 rAF after 8 frames | same |
| today, same scene | 18–28 ms on the M5 (36–55 fps at most) | ~20–35 fps, est. (audit-perf 5) |

**Energy.** Today the lab saturates the M5's GPU at 36–55 fps (18–28 ms a frame). Lean at 120 Hz spends ~150 ms of
GPU per second (120 renders of ~1 ms and 60 ticks of ~0.5 ms), so the GPU is busy ~15 % of the time. At 60 Hz it is
~9 %. On the phone ~2.8 ms per 16.7 ms frame keeps the GPU under a fifth busy. With Apple's race-to-idle that is,
est., ≤ 1.5 W for GPU and DRAM in a typical scene; DRAM at 3.6 GB/s × ~30 pJ/B is ≈ 0.1 W of it. `tools/power.mjs` on
the Mac and Xcode's Instruments on the phone are the judges.

**Presentation:** Chrome on macOS delivers 120 Hz rAF on ProMotion; Safari caps rAF at 60 Hz by default (a WebKit
setting) on the Mac and the iPhone, and Low Power Mode drops it to 30. The tick stays at 60 Hz either way.

### 5.3 Memory and compile (128³)

| | today | lean Mac | lean iPhone |
|---|---|---|---|
| state | A + B + F + flow, 2 copies: 168 MB | 33.5 MB | 33.5 MB |
| render fields, light, GI | 164 MB | light grid 8.4 MB + faces 4 MB + shadow 4 MB | same |
| air, particles, deco (lazy) | — | 2 + 4 + 8.4 MB | 2 + 1 + 8.4 MB |
| post | ~40 MB | ~40 MB | ~25 MB |
| undo | 67 MB per stroke, up to 201 MB | brick-diff ring ≤ 16 MB | ≤ 8 MB |
| **total** | **408 MB at boot, ≤ 650 MB** | **~120 MB** | **~95 MB** |
| WGSL per session | ~1.7 MB, 98 pipelines in the tree, 7.2 MB | ≤ 300 KB, ≤ 30 pipelines | same |
| largest kernel | move 3,329 lines, view 5,400 | ≤ 600 lines (block pass) | same |

Every kernel family gets its own small prelude (perf P10). The element tables stay in the storage buffer (C6), so
content edits never change shader text.

### 5.4 Enforcement

- **At runtime:** the resolution governor; per-tick caps on remesh, light cells, particles and shadow redraws, with
  priority queues by screen size; time dilation past the tick cap.
- **In CI** (extending `tools/budget-check.mjs` and `tools/budgets/*`): bytes allocated per cell ≤ 20; workgroups per
  changed brick (one grain must not cost what a flood costs); ≤ 8 frames after a still view; derived work for one
  tick after the last change; WGSL per session ≤ 300 KB, ≤ 30 pipelines, no kernel over 600 lines; the §3 and §4
  outcome tests on the GPU harness, including "certified idle".
- **On the user's devices, every phase:** the Mac timestamp and power run, and an iPhone Safari timeline, on the same
  six scenes.

## 6. What of the WebGPU port is kept, and what is replaced

| kept as is | kept, retargeted | replaced |
|---|---|---|
| `src/gpu/*`: device, frame and flush rules, param ring, kernels, readback, timing, present, three interop, errors | brick-major slot order and the four index functions (C2), behind `loadCell`/`storeCell` | move, react and the inert/activity rest test → column, block, flux, particle and air kernels |
| app shell: main, launch, preload with menu warm-up, settings, UI, pacing, view key, deep idle | GPU-built AWAKE/DRAWN lists, indirect dispatch, the run counter and its invariant (D5), fed by `possible` bits | derived.js (EMA, blur, boost, brick map, brickDist, light blur, GI) → mesher, light flood, shadow raster |
| determinism rules (W21), hashed streams, no float atomics | box-scoped edits with marks (D6) and `editMain`, writing 16 B cells | the volume raymarcher and all view modules → raster pipelines (§2) |
| tables buffer (C6), generated from the element rows | the fused in-place block kernel shape (D2), with new rules | the far marcher and CPU detail chunks → LOD face pages |
| AgX, bloom pyramid, histogram and adaptation (post's compute pass) | TAAU (fused into the present pass; post-TAAU overlays) | whole-grid undo → brick diffs; codec and saves → a v2 format plus a converter |
| three.js mesh layer, billboards, baked icons | POV and world edit/probe kernels (~40, est.), via the cell API | aeration, foam field, `moveSrc`, flow field → foam byte in the liquid cell |
| tools: browser.mjs, budget-check, sim/derived benches, power.mjs, skip-model's method | world generation's `sceneCell` (same output, packed into 16 B) | CPU twin (`ui/tiles/engine.js`) → dock tiles from baked images; checks on the GPU harness |

The window shift keeps shift-by-copy: the state is 5× smaller, so a move costs ~0.5 ms instead of 4–6 ms, and the
toroidal-window complexity isn't needed.

## 7. Kill list

| killed | where today | why | replaced by |
|---|---|---|---|
| fragment raymarcher of opaque matter | `render.js`, `core.js` | 3–9 ms on the M5 view; re-marches every pixel for 109 frames | raster face pages |
| blurred-occupancy isosurface ("clay") | `materials.js` CHANNELS, `core.js:159-251` | the root of "it doesn't look good" (audit-render 2.1) | honest cells; smooth liquid tops from fill |
| field pipeline: EMA, blur ×3, boost ×3, peak, 3 field textures | `fields.js`, `derived.js` | 76 B/cell; 125-brick × 13-frame tail per change (P3) | nothing (the raster reads the state) |
| 13 `matOf` branches, 1,070 constants, Worley loops | `surface.js:661-1219` | detail gone by 4 m; uneven per element | palette + pattern texture |
| relief, grains, clods, crystal optics, meniscus, ripple octaves, glints | `relief.js`, `grains.js`, `crystal.js`, `liquidDetail.js` | +14 to +39 ms each on the M5; SwiftShader can't build them | none, or the pattern texture |
| glow-light RIS, near-field GI rays, PCSS, exact sun DDA, traced reflections, caustics | `lighting.js`, `liquid.js` | Bernoulli noise (B4), 2 DDA rays a pixel, B5, B6 | light grid, shadow raster, sky reflection |
| SH GI probes (giSource, giGather) | `gi.js` | a fixed per-frame tax (P8) | the light grid's sky and block channels |
| 10 lighting models, 4 emission models | audit-render 2.4 | inconsistency (B1, B2) | one light, one emission |
| stacked tone curves ("Punchy", warm roll-off, +0.7 EV) | `post.js:771-818` | three curves for an unchosen look | AgX and one grade |
| the heat-shimmer stub, night-vision tube sim in the composite, `albedoOf` | `media.js:206`, `post.js:851` | dead or misplaced | — (night vision as a POV overlay if wanted) |
| plain view, X-ray view | `plain.js`, `render.js` | a second renderer | the lean look; a cutaway plane |
| media march with Wrenninge octaves, filaments, flow-advected noise | `media.js`, `mediaDetail.js` | +6 to +16 ms close up | gas march on the 32³ air texture |
| far-field marcher, detail chunks, surface-nets worker, far shadow and top maps | `far.js`, `world/detail*.js` | a whole second renderer | the same mesher at LOD1/LOD2 |
| Margolus move with per-cell velocity, `V_MAX`, per-element `drag`, `slide` | `move.js`, `react.js` | B2, B3, square heaps | column fall, particles, drop classes |
| PACE/R3, `fallAge`, jet exemption, pipe-flow renorm, Torricelli scan, film cohesion, droplet wander, landing splash, FLOW kicks | `move.js`, `react.js` | six layers hiding the Margolus parcel spacing | fill + flux + particles |
| whitewater: aeration, wakes, pour parcels, `jetWGSL`, `thinBodySeg`, `mobileVel`, out-of-place move | `liquidDetail.js`, `fields.js`, `liquid.js` | six attempts in three days at one pour | particles + foam byte |
| max-plus pressure front, `P_DECAY`, per-cell pressure and velocity (B plane) | `react.js:423-452` | octahedral blasts, pressure from nothing, no vacuum | air grid |
| gas cells (11 elements) and their jitter; FIRE and plasma cells; smoke made from air cells | `elements.js`, `react.js:623-628, 747-777` | never rest (B11); 865 smoke cells from 64 wood | species; flame sprites |
| `KE_TO_HEAT` ×25, `COLLIDE_V`/`RESTITUTION` cradles, `LAND_POWDER_SCATTER` | `physics.js` | hot spots, slow heaps, noise | real KE for breaking; nothing else |
| `AIR_AMBIENT_PULL`, per-scene ambient, brine-lake workaround, kit settle passes | `physics.js:42`, 22692b4, 1def559 | heat sinks and content bent around the sleeper | boundary conductance, exact rest |
| six `REST_*` tolerances, `inertNear` and `inertSelf` mirrors | `activity.js`, `common.js` | B1: the mirror is wrong | rules report `possible` |
| the cell-0 quirk | `move.js:218-224` | a bug kept for parity (B10, B11) | gone with the move |
| radial gravity mode, loop edges | `simModes.js` | a cube planet and no sleep (B12); niche | — (void edges stay) |
| 4 steps per frame, `MAX_FPS` tying sim to display | `app.js:137`, `pacing.js` | B13, S1, S5 | 60 Hz tick |
| whole-grid undo snapshots; 67 MB atlas scratch kept in test mode | `sim.js` | P4, P13 | brick-diff ring |
| the unrolled move, the 33 KB prelude in every kernel | `move.js`, `common.js` | P9, P10 | small kernels with family preludes |
| the CPU twin of every rule | `ui/tiles/engine.js` (1,079 lines) | drifts (liquids B10); rules written twice | the GPU harness; baked dock images |

## 8. How this fixes the four pain points, and the worst audit bugs

| pain point | lean answer | evidence it works |
|---|---|---|
| **1. The look and the materials** | cells you can read, authored at the scale you see them (a pattern at 4–8 texels per cell from the god view), per-cell colour variation, one consistent light (sun shadow, sky and block light, AO, one sky, one emission), fog and bloom. No clay, no plastic far-mean, no navy void, no shimmer. | the crisp pitch's CPU mock renders this shading family on the real presets (`v2/crisp/shots/side-by-side-64.png`); lean differs in TAAU instead of MSAA, a per-cell light grid, and particles and flames drawn after TAAU |
| **2. Water and liquids** | fill + flux with compression: levels, pressure through lids, rest, fractional surfaces, yield. Jets and spray are particles; foam comes from flux and impacts. | prototype table (§3): U-tube Δ 2 cm, flat partial layer, round puddle that rests, pipe drains, parabolic jet, mass exact |
| **3. Physics feel** | one clock at 2 g shared with the player; slabs fall as slabs; throws and debris arc; round heaps with angles per material; round blasts with containment and vacuum; fire spreads by contact; wind blows sand | prototype: slab 1 cell thick on the ideal curve; heaps round at 45° and 63°, asleep 1.6–2.7 s after the pour |
| **4. Performance** | one 60 Hz tick of ~40 B per awake cell instead of 4 steps × 167 B; nothing derived unless occupancy changed; raster at 2/3 resolution; ≤ 4 render + 3 compute passes; a settled world costs 0 | §5: ~1.3 ms per Mac frame and ~2.8 ms per phone frame typical, against 18–28 ms today; 120 MB instead of 408–650 MB |

| worst audit bugs | fixed by |
|---|---|
| render B1 sky mismatch, B2 reflections glow 3–6×, B3 grey transmittance, B4 lava flicker, B9 7 m drops, B11 phones get another game | one sky; one emission function; RGB transmittance in the liquid pass; no stochastic terms; particle colour by an art parameter; one pipeline everywhere |
| liquids B1 U-tube, B2 pipes clog, B3 puddles, B4 partial layer, B5/B6 energy-making splashes, B7 dotted pours, B8 lockstep pacing, B9 no yield | §3 rules; prototype results |
| physics B1 heaps never sleep, B2/B3 throws and slabs, B4–B6 pressure, B7/B8 density as mass, B9 fire, B11 gases never rest, B13 two clocks | R1–R12 and exact rest |
| perf P1 derived keyed on the step counter, P2 full shadow re-trace, P3 field tail, P4 undo, P5 one frame in flight, P6 pointer re-converge, P8 GI tax, P9/P10 compile size | occupancy-keyed remesh/light/shadow; fields and GI gone; brick diffs; ≤ 7 passes per frame (re-test 2 in flight on iOS 26.x); overlays after TAAU; small kernels |

## 9. Phased build plan

Every phase ships, and ends with a side-by-side review against today's build: the same six scenes (lab, volcano,
island World, Snowy Depths, tank pour, buried charge) from fixed cameras, plus the outcome tests, a Mac timestamp and
power run, and an iPhone Safari timeline.

**P0, baseline and gates (small).**
- Run today's port on the Mac and the iPhone for the six scenes (perf I4/I5), recording timestamps, power and shots.
- Land the budget checks of §5.4 as reporting-only.
- Port the prototype's outcome tests to the GPU sim-check harness as failing tests (U-tube, puddle, partial layer,
  pipe, hole, heap, slab, throw, blast, flame against wood, certified idle).
- Exit: the baseline sheet exists and every number in §5 has a measured "today" beside it.

**P1, the lean renderer on today's sim (medium-large).**
- The mesher reads ids from today's A buffer. Face pages, the one material and one light function, the shadow
  raster, the per-cell light grid, cull, TAAU, the fused present pass, overlays after TAAU, crunch mode.
- Liquids and glass as whole-cell faces with the RGB Beer–Lambert walk; gases drawn from today's gas cells
  summarised per brick into the 32³ texture; flames as sprites on cells at flame temperature.
- The far field as LOD face pages; heat view and cutaway.
- Delete: the volume modules, the field pipeline, GI, the shadow trace, the far marcher and detail chunks, the plain
  view, X-ray.
- Visible gain: the look (pain point 1) everywhere, phone included, and the view plus derived cost drops from
  ~9–17 ms to ~1.5 ms on the M5, so the lab reaches 60 fps even with today's 4-step sim.
- Exit: shot review accepted, render budget met on both devices, deep idle intact.

**P2, the lean sim (large; staged internally, ships once).**
- P2a: the 16 B state, `loadCell`/`storeCell` with every POV, world and tool writer and probe retargeted, the one
  clock, column fall, the block pass (R2–R9), integer heat, exact rest.
- P2b: liquids (§3) and the particle system, with POV projectiles and the physgun merged into it.
- P2c: the air grid with species, wind, vacuum, blasts and fire's air coupling.
- Then: the save and codec v2 with a converter, brick-diff undo, the multiplayer wire format bump.
- Delete: move, react, the activity mirror, the B and F planes, flow, aeration, whitewater, gas cells, the CPU twin,
  radial gravity, loop edges.
- Visible gain: pain points 2 and 3. The sim cost per frame drops from ~13–19 ms to ~0.5 ms (Mac) and memory from
  408 MB to ~120 MB.
- Exit: every P0 outcome test passes on the GPU, including "settled world certifies idle", and the tick budget is met.

**P3, phone first-class and finish (medium).**
- iPhone defaults identical to the Mac's apart from resolution; governor tuning; Low Power Mode at 30 Hz rAF with a
  60 Hz tick; a re-test of 2 frames in flight on WebKit.
- Art pass on palettes and the 16 patterns; foam and splash-crown polish.
- Optional: sun bounce into the light grid and water SSR, each shipped only if it fits the phone budget.
- Pressure and wind views; a cut of everything left on the kill list.
- Visible gain: the phone gets the whole game at 60 Hz without heat.
- Exit: a 30-minute iPhone session without throttling (Instruments), and the CI budgets switched to enforcing.

## 10. Risks

1. **"Minecraft clone."** Visible cubes are a strong identity, and a mis-set palette reads as a toy. *Mitigation:* the
   P1 shot review is the gate; art-direct the 16 patterns and the palettes early. Liquids, gas, glow and the sky carry
   much of the look. A ~5-ALU edge bevel (bend the normal near face edges by face UV) is held in reserve.
2. **TAAU at ~44 % of the pixels** can ghost on fast falls, fire and water. *Mitigation:* motion vectors from fall age,
   overlays after TAAU, the governor's 0.8 ceiling, and crunch mode as the no-temporal fallback.
3. **Compressible liquids.** Deep tanks hold extra mass (~12 % at 30 cells deep), pipe friction comes from one damping
   constant, and the dead bands trade flatness against rest. *Mitigation:* 4 substeps halve the compression,
   `FULL = 2¹⁶` keeps the dead bands sub-millimetre at a free surface, and the prototype is the tuning bench.
4. **Gas at 1.2 m resolution** loses thin plumes and 1-cell gas pipes, which TPT players do build. *Mitigation:* noise
   detail in the render and open-face fractions; the fallback is a 2-cell air grid (8× the cost, still 1/8 of the
   cells).
5. **Particle determinism and caps.** Claims use `atomicMin` on a deterministic key, so they're order-free. But a
   device-dependent particle cap would change outcomes between peers. *Mitigation:* a fixed cap per session in
   multiplayer, and fall-back-to-grid behaviour that is itself deterministic.
6. **Safari.** One frame in flight (P5), rAF capped at 60 Hz, `timestamp-query` availability, and WebKit's WGSL
   compiler. *Mitigation:* the iPhone in every phase's review from P1, fewer passes, and a rAF-lateness governor.
7. **Scope.** P2 rewrites the sim and touches every POV and world writer. *Mitigation:* the cell API first, the
   outcome tests first (P0), the edit template and lists kept, and no parity goal with today's behaviour.
8. **The kill list cuts things someone likes:** X-ray, radial gravity, the plain view, the named gas elements as
   cells. *Mitigation:* the user signs off item by item; brushes keep the gas names, and the cutaway replaces X-ray.
9. **"Same game on the phone"** means the Mac gets no showcase tier. *Mitigation:* extras that fit the phone budget
   ship for both; nothing ships for the Mac alone.

## 11. Evidence (`v2/lean/`)

- `lean-sim.mjs`: the CPU prototype of R1, R2, R10 and R11 with exact rest in 3D. It keeps the GPU's ownership
  discipline: a thread per column; a thread per 2×2×2 block reading only its own cells plus an occupancy snapshot;
  faces owned by their −side cell; integer transfers. Tests: `slab heap heapFlour utube puddle partial pipe hole
  throw`. `node lean-sim.mjs [tests]` runs in ~90 s on this container.
- `lean-sim.log`: the full output, including the heap height maps, the puddle map and the jet slices.
  `lean-sim.out.json` holds the same results as JSON.
- Constants used: 60 Hz, 0.3 m cells, 19.6 m/s², 3 substeps, `FULL` = 65,536, `COMP` = 0.0081, `DAMP` = 0.01 per
  substep, dead band 2 quanta, film 1/8, jet threshold 1 m/s, Moore share 0.5.
- Caveats: the prototype is sequential, so it can't show races (the GPU harness must). Heat, reactions, fire, the
  air grid and blasts are not prototyped. The pipe hadn't finished draining at 60 s. The "throw" test is ballistic by
  construction and shows only that nothing caps the speed. The jet's landing average mixes particles from different
  heads, so "within ~3 cells" is loose.
- Borrowed: the exposed-face counts of the real presets (`v2/crisp/faces.txt`) and the shading-family mock
  (`v2/crisp/shots/`), both from the crisp pitch. (Repository note, 2026-10-16: see `pitch-crisp.md`'s note for where
  those files are now.)
