# v2 pitch: high-fidelity voxels (Teardown lineage)

Philosophy: show the cell honestly as a voxel, and spend the GPU on light, not texture. There is one traced voxel
scene, one material function, one lighting function and one radiance cache. Liquids move by pressure and rest
exactly. Anything flying is a particle, and there is one clock. Everything above `src/gpu/` is redesigned. The
foundation, the app shell and the engine contracts that work (brick-major state, GPU-built brick lists, box-scoped
edits, determinism, deep idle) stay.

Inputs: the four audits in `v2/`, `docs/webgpu.md` A-F, and a prototype built for this pitch (`v2/fid/`,
appendix A). It traces the real `lab` and `volcano` presets through the proposed hierarchy and counts what every ray
costs. Teardown, the renderer's lineage, isn't on the README's list. Every other rule cites a touchstone (Minecraft,
Noita, The Powder Toy, Halo 3) or a physical source.

## 0. The pitch in twelve lines

1. **The cell is the voxel.** No blurred isosurfaces: 30 cm voxels with per-voxel palette variation (Teardown,
   Minecraft). Exposed cells are sculpted into 4³ **micro-voxels** (7.5 cm) by a deterministic shaper.
2. **One compute tracer** over a 4-level occupancy hierarchy (16³ sector → 4³ brick, 64-bit masks → cell → micro
   mask), with one `trace()` call site per kernel.
3. **One lighting function** for every hit: a **traced hard sun shadow per pixel** and a **radiance cache keyed by
   (cell, face)** for sky, bounce and emitters. No stochastic per-pixel term on the default path, so no shimmer.
4. **One sky**, drawn and lit with. Box mode stands on a ground plane under it.
5. **Water and glass**: traced mirror reflection + refraction march with RGB Beer-Lambert. The surface comes from fill.
6. **Liquids are fill + per-face flux with pressure** (weakly compressible virtual pipes): U-tubes, pipes, dams and
   waves work, and puddles reach an exact integer rest, so their bricks sleep.
7. **Anything airborne is a particle** (Noita's split): pours, thrown sand, debris, rounds and rays in one system.
8. **Air is a coarse conservative gas per brick** (TPT's `CELL = 4` air map in 3D): round blasts, containment, vacuum.
9. **One clock**: a 60 Hz tick at real gravity, independent of the display. Speed ×½-×4 is a paid-for tick rate.
10. **Rest flags are emitted by the rules themselves**, not a hand-written mirror, so heaps, pools and gas sleep.
11. **8 B cells** (72 B today), +8 B per liquid cell, air per brick: ~70 MB of DRAM per frame instead of ~0.7-1 GB.
12. **M5 ~2-4 ms per frame** (today 18-28) and **iPhone 17 Pro Max ~2-3.6 ms** (est., traversal measured), with the
    same look on both. Tiers change resolution and convergence, never materials or the light model.

## 1. The renderer

### 1.1 What is drawn: the voxel scene

The **bake** kernel builds the scene from the sim state, only for bricks whose *visible* state changed (an id, a
glow band, a fill step of 1/16, a media density step): Noita's dirty rectangles, where today the derived passes key
on `sim.version` (perf P1). The result is under 10 MB, against 160 MB of field scratch today plus shadow and GI.

| Level | Per | Holds | Size at 128³ |
|---|---|---|---|
| sector | 16³ cells (4³ bricks) | 2 bits: any / opaque | 64 B |
| brick | 4³ cells | `any` 64b, `opaque` 64b, `shaped` 64b, `flyers` 64b, pool offset, flags (media, liquid surface, emitter, hot) | 40 B × 32,768 = 1.3 MB |
| cell | via the state | id, temperature, deco (the sim's own words; no copy) | - |
| micro | shaped cells only | 64-bit mask of 4³ micro-voxels, indexed by `popcount(shaped & below(bit))` | 8 B × shaped cells (~0.1-0.3 M) ≤ 2.4 MB |
| media | media bricks | density + temperature, `rg8unorm` 3D texture at cell resolution, filtered | 4 MB, written only for media bricks |
| liquid surface | liquid bricks | fill per cell (the sim's liquid page) | - |

**The shaper** (one function in the bake, deterministic from the world cell hash, the cell's 26 neighbours and
the element's `shape` family). It decides which of an exposed cell's 64 micro-voxels are solid:

| Family | Elements (examples) | Rule |
|---|---|---|
| `cube` | WALL, METAL, GLASS, ICE, BRICK, CLONE | full cell, never shaped |
| `crag` | ROCK, BASALT, SANDSTONE, LIMESTONE, COAL, WOOD | outer micro layer on exposed faces: keep 60 %, edges 30 %, corners 12 % (hash). Craggy silhouettes; a 1-cell wall can never be holed (only the outer layer is carved) |
| `grain` | every powder | an exposed top becomes a micro heightfield: 1 micro lower where the hash says, 1 lower at exposed side edges. Heaps read as grains up close |
| step corners | (crag and grain terrain) | an *air* cell sitting on a crag/grain step beside a crag/grain neighbour gets a micro ramp rising toward that neighbour. Terraces read as slopes and heaps as cones. It is render-only: the physics cell stays air (≤ 7.5 cm of mismatch with collision) |
| `leaf` | PLANT, MOSS, FUNGUS | half of all micro-voxels, interior too: canopies let light and rays through |
| `liquid` | liquids | not shaped: an analytic surface at height `y + fill` (§2.4) |
| `media` | gases, fire | not in the masks: the media texture (§1.4) |

**Micro LOD.** Micro masks are used only while the ray's footprint is under ~1.5 micro-voxels, with a blue-noise
crossfade. From the god view (39-103 m, 3-8 px per cell) you see crisp cells with per-cell palette variation, TPT's
per-particle colour jitter. Inside ~10 m the micro shapes appear. Today 13 material branches paint millimetre noise
that is gone beyond 1-10 m (render audit 2.3).

### 1.2 The frame

```
[compute] sim tick(s)                         (only on ticks; §3.3)
[compute] bake      over visibly changed bricks → masks, micro pool, media, emitters, cache invalidation
[render]  raster    three's opaque meshes (TSL mrt) + flyers (instanced cube / sphere impostors) → G-buffer + depth
[compute] trace     primary rays, tMax = raster depth → visibility buffer (t, cell, face, micro, kind: 8 B/px)
[compute] light     one kernel: every pixel's hit (voxel or G-buffer) → sun ray, cache lookup, water/glass,
                    metal gloss, media march, emission → HDR (rgba16f)
[compute] cache     update rays for a rotating 1/K of pixels → atomic fixed-point accumulate; resolve touched entries
[render]  TAA/TAAU, bloom, adaptation, AgX, canvas composite (today's post, minus the three stacked look curves)
[render]  transparent three objects, overlays (forward, after)
```

- **Compute traces and lights; render passes keep full-screen images.** The visibility buffer is 8 B/px, ~5 MB at
  660 K px: cheap even without the TBDR compression that storage textures lose on M1-M4 (webgpu-research 7.1).
  TAA, bloom and the composite stay fragment passes, as post does today.
- **Wavefront split, one call site per ray kind.** `trace` is traversal only (~300 lines). `light` holds the
  material, the cache and a per-pixel ray state machine that issues every secondary ray from one `trace()` call.
  On SwiftShader the prototype with five inlined call sites built in 376 s, and with one in 20-100 s (load-dependent).
- **Raster where raster wins.** Meshes and flyers are rasterized (TBDR removes hidden surfaces for free). The voxel
  world is traced: no mesh to rebuild when a cell changes, and one traversal serves shadows, bounce and reflections.
- **Voxels teleport, so TAA must know.** `trace` flags pixels whose hit brick changed this frame and TAA drops their
  history instead of ghosting a moved grain. Flyers and meshes carry real motion vectors.
- **Converge and stop.** Camera and world still: ≤ 8 frames (nothing stochastic is left to average), then deep idle.
  Today TAAU settles for 109 frames and every pointer move buys 1.8 s of marching (perf P6). The brush cursor
  becomes an overlay on the cached frame.

### 1.3 The material model (one function)

Every element row gets a `look` block (§3.9): a palette of 2-6 linear tones with weights, roughness, metalness,
luminescence, transmission (σ in m⁻¹ RGB, IOR, scattering albedo), the shape family and an optional stable `grain`
sparkle. Albedo at a hit is `palette[pick(hash(cell), hash(micro), facing)] × deco paint × weathering`. Weathering
brightens the sky-facing faces of `crag` rock, the one idea worth keeping from today's crag shader (render audit
4.11). There is no per-element code. `matOf` (~560 lines), `relief`, `grains`, `clods`, `crystal.js` and the
Worley searches go. Gold, Clone, Scrap, Nuggets and Titanium differ only by palette and roughness (B10).

**One emission function**, `emit(id, T)`: the game's blackbody table (`incandescence.js`, kept), Kirchhoff
emissivity `1 − albedo` and the skin-temperature drop for non-metals. Primary hits, reflections, refraction, the
cache and the emitter list all call it. Today hot matter glows 3-6× brighter in reflections than in direct view (B2).

### 1.4 Lighting

| Term | How | Per pixel | Phone |
|---|---|---|---|
| Sun | one **hard** traced shadow ray (micro masks inside the LOD range, flyer masks, capsule proxies for figures), RGB transmittance through water, glass and media | 1 ray, deterministic | same |
| Sky, bounce, emitters | **radiance cache** lookup, smooth across faces (below) | 4 hash lookups | same |
| Contact | **micro AO** from the baked micro masks: Minecraft's corner AO at 7.5 cm, bit tests, no rays | ~12 bit tests | same |
| Water and glass | mirror reflection ray (shaded from the cache plus the face's cached sun visibility) + refraction march, both always (Fresnel-weighted, not Russian roulette) | 1 ray + march | same |
| Metal, gloss < 0.35 | one GGX-sampled reflection ray at half resolution, temporally accumulated | 0.25 ray | coarse-cache lookup along the reflection direction |
| Media (smoke, steam, fire) | march through media bricks only, 2 samples/cell (1 on phone), lit by a brick-resolution sun-transmittance volume and the coarse cache, fire emitting by blackbody | within media only | half resolution |

**Why a hard sun:** the sun is 0.53° wide, so its penumbra is 3 cm behind a 3 m tree and 35 cm behind a 38 m cliff.
A soft-shadow estimator buys nothing visible here and costs noise. Today 2.3 % of the flank's pixels jump by more
than 16 levels between raw frames. Softness comes from skylight in the cache, as in real light.

**The radiance cache** is the only indirect light. It replaces SH probes, the glow volume and its blurs, glow-light
RIS, near-field GI, field AO, `caveAmbient` and the lamp loops. It is SHaRC (NVIDIA's spatially hashed radiance cache)
keyed on voxel faces.
- *Keys:* `(world cell, face)` in 2¹⁸ entries (RGB9E5 irradiance, sun visibility, count, age, plus a fixed-point
  accumulator). There is a coarse `(brick, face)` level, then sky × coarse sky visibility. World-keyed, so a moving
  window keeps its light.
- *Lookup:* bilinear over the four coplanar neighbour faces, skipping occluded ones: Minecraft's smooth lighting,
  traced. It is leak-free, because a wall's two faces are different keys.
- *Update:* a rotating 1/K of pixels (K = 4 desktop, 16 phone) trace one cosine ray each. The hit returns `emit +
  albedo × (its cached irradiance + sun × its cached sun visibility)` (infinite bounce over frames) or the sky, and
  that is `atomicAdd`ed into the source face. Primary sun rays feed sun visibility. A resolve blends touched entries
  (`α = max(1/n, 0.06)`) and evicts after 600 idle frames. Integer sums are order-free (W21).
- *Emitters:* the bake clusters emissive bricks (lava, fire, lamps, torches, embers, sparks, hot metal). Each update
  ray also shadow-tests one cluster from a per-sector top-16 list (next-event estimation). Torch noise dies in the
  EMA, pixels read a smooth value, and lava light stops flickering (B4).
- *Change:* a visibly changed brick resets nearby counts, so its light reconverges in ~10 frames.

### 1.5 What a pixel costs (measured traversal, estimated time)

Traversal iterations per ray, measured by the prototype on the real presets at 128³. One iteration is a sector,
brick or cell step. Micro steps are counted separately. Full numbers are in appendix A.

| View (128³ preset, 400×250, 32 frames) | Box coverage | Primary | Sun | Cache ray + its sun ray | Water/glass secondaries | Micro steps | Medium steps |
|---|---|---|---|---|---|---|---|
| volcano, default god view (75 m) | 19 % | 32.5 | 13.6 | 8.1 | 9.2 | 5.3 | 6.5 |
| volcano flank (5.8 m) | 89 % | 20.2 | 15.4 | 15.5 | 0.1 | 12.0 | 0.1 |
| lab, default god view | 13 % | 44.9 | 24.9 | 5.5 | 11.1 | 1.4 | 15.7 |
| lab tank, through the glass (6.7 m) | 100 % | 7.1 | 7.9 | 1.0 | 15.8 | 0.6 | 28.2 |

These are iterations per *covered* pixel per frame. In the god views they also carry the uncovered pixels' work
(box-clipped rays, ground shadow rays), so the frame totals below are the honest figures. A primary ray costs 7-45
iterations, a hard sun ray 8-25, a one-bounce ray 1-16. Micro shaping adds 1-12 cheap steps up close. Crossing
uniform liquid bricks in one step cut the tank's medium march from 68.6 to 28.2 steps per pixel.

**Time model (est).** One iteration is ~40 instructions (floor, 2 mostly-L1 loads, a bit test, slab exits). An Apple
core issues 128 lanes/clock. At 50 % divergence efficiency that is ~20 G iterations/s on an M5 (10-core) and
~10 G/s on an A19 Pro. `light` is ~400 instructions/px.

| View | Trace, M5 (660 K px) | Trace, A19 Pro (250 K px) |
|---|---|---|
| volcano god view | 0.41 ms | 0.31 ms |
| volcano flank | 1.31 ms | 0.93 ms |
| lab god view | 0.41 ms | 0.31 ms |
| lab tank (two interfaces, 50 cells of water) | 1.73 ms | 1.31 ms |
| volcano, 37 m | 1.14 ms | 0.84 ms |
| lab, 37 m, down into the tank | 1.60 ms | 1.20 ms |
| lab tank from a 37 m-class camera, through the glass (worst measured) | 1.91 ms | 1.44 ms |

"Trace" is primary + sun + water/glass secondaries + K × (cache ray + its sun ray) + micro and medium steps, at the
device's internal resolution and this view's coverage (`v2/fid/analyze.mjs`). Add `light`: ~0.2 ms (M5), ~0.15 ms
(iPhone). The worst measured case, a close-up through deep water, is 1.9 ms on the M5: inside the perf audit's
2.5 ms view budget, but not by much. Phase 1's first job is to replace this model with device timestamps.

### 1.6 Tiers: same look, different convergence

| | iPhone 17 Pro Max (default) | MacBook M-series (default) | "Ultra" (opt-in) |
|---|---|---|---|
| internal pixels | ~250 K (0.6 × CSS, TAAU to CSS) | ~660 K (1/1.5 TAAU) | native |
| cache update rate K | 1/16 px | 1/4 px | 1/2 px + 2 emitter samples |
| metal gloss | coarse cache | 1 ray at ½ res | 1 ray full res |
| media | 1 sample/cell, ½ res | 2 samples/cell | 4 samples/cell, sun shadow rays |
| micro shapes, palette, sun shadows, water optics, emission | **same** | **same** | **same** |

The phone gets the same picture, converging more slowly. Today it is a different game (B11). **Views:** heat,
pressure, flow and X-ray (TPT's identity) become `light` variants over the same visibility buffer; X-ray is a `trace`
mode. A **Flat** view (palette × (sun N·L + constant)) replaces the second renderer `plain.js`.

## 2. Liquids

### 2.1 Bulk: fill and per-face flux with pressure

The state of a liquid cell lives in the sim's *liquid page*, allocated per liquid brick: `fill` (u16 fixed point,
1.0 = 4096) and the flux on its +x, +y and +z faces (3 × f16, cell volumes per substep). The kernel is one Jacobi
gather per substep, 2 substeps per 60 Hz tick, on awake liquid bricks only:

1. **Head.** `h = fill` for a cell with air above. Under liquid it is `h = 1 + (fill − 1)/ε`, so the excess fill
   *is* the pressure head (W-Shadow's compressible CA). The wave speed is `c² = g_c/ε` cells²/substep² (with
   `g_c = g·Δt²/Δx`), so `ε = g_c` makes a pressure wave cross one cell per substep. That is 36 m/s at 120
   substeps/s, faster than any gravity wave in the box (√(g·h) is 9.9 m/s at 10 m depth). The price is hidden
   mass: ε ≈ 0.0023 per cell of depth, so a 30-cell-deep lake holds 3.4 % more than its visible volume and a
   full-height 128-cell column 15 %. Only the top cell's fill is drawn, and the census counts fill.
2. **Accelerate** each face's flux by the head difference across it (vertical faces add the cell's own weight),
   minus a viscous damping `k_visc(η)`. **Yield** (Bingham: mud, lava, slime) is a minimum head difference before a
   face flows. Viscosity data in Pa·s comes from today's element rows.
3. **Limit** a cell's total outflow to its fill (virtual pipes' K factor, Mei et al. 2007). Mass is exact in
   integers.
4. **Gather** `fill += Σ in − Σ out`.

That is the whole bulk rule: no Margolus for liquids, no randomness, no pacing, no head scans. U-tubes equalize
because pressure has a path upward, and pipes drain because pressure passes under lids. A 100-cell dam pours
√(2gh) faster than a 16-cell one (B14). Gravity waves come free: a dropped rock rings the pond at cell scale.

**Contact line:** a face won't flow onto dry ground below `fill_min` = 1/16 cell (1.9 cm), so a puddle stops at a
finite depth (Minecraft's flow levels end too, and settle in a few ticks). **Rest is exact:** with every |flux| under
a quantum and no fill change for 8 ticks, fluxes snap to 0. Integer fills make that a true fixed point, so the brick
reports no change (§3.8) and sleeps, and a pool of any volume rests flat with a fractional top (B3, B4).
**Mixing:** a cell holds one liquid or something else. Powders and other liquids exchange with it by whole-cell
density swaps (the fill moves with the swap). A part-filled cell under a different liquid or a powder swaps upward,
so trapped air rises (B15).

### 2.2 Airborne: particles

- **Grid → particle:** flux into an unsupported air cell above `v_eject` (0.15 cells/tick), a sub-`fill_min` cell
  over air, and any liquid a blast, kick or tool throws. Emission is continuous: a Torricelli jet at the flux's own
  speed, one particle per ½ cell of travel. No lockstep pacing (B8), no dotted lines (B7).
- **In flight:** ballistic at real g, with quadratic drag toward the coarse air velocity (§3.6), swept against the
  occupancy masks each tick.
- **Particle → grid:** the volume is deposited into the cell above the hit (fixed-point `atomicAdd`, gathered by the
  flux pass). Above `v_splash`, splash particles leave in a cone around the reflected direction with total kinetic
  energy ≤ 0.3 × incoming. Landings never create energy (B5), and liquid on liquid never "lands" in mid-air (B6).

### 2.3 Foam

One u8 per surface cell, advected upwind by the flux in the same pass. Sources are particle impacts above Ervine and
Chanson's 1-4 m/s onset, plus flux divergence and shear (hydraulic jumps, wakes). It decays with Monahan's τ (2.5 s
fresh, 3.9 s salt). A `foam` column per liquid lets all 19 foam, saltwater included. There is no moveSrc plane, no
out-of-place move and no whitewater pass.

### 2.4 Look

- **Surface:** the ray meets a plane at `y + fill`, its normal bilinear over the neighbouring columns' heights. The
  surface is continuous, needs no EMA (fill moves continuously) and shows real waves from the sim. Sub-cell ripples
  are a world-anchored procedural normal scaled by a decaying agitation scalar. Meniscus and capillary octaves go.
- **Optics:** Fresnel with TIR. The mirror ray is lit from the cache, so a pool in a cave mirrors the cave
  (`envReflectGI`'s idea). Refraction marches RGB Beer-Lambert with single scattering lit by the coarse cache. Meshes
  behind water get RGB transmittance (B3). Analytic caustics are kept, on the fill heightfield.
- **Particles:** depth and thickness splats at half resolution, a narrow-range filter (Truong & Yuksel 2018), normals
  from depth, shaded by `light` as the liquid at its real thickness. Noita's "liquid in the air shows its colour"
  becomes one parameter, a minimum optical thickness for spray, in place of the 24-cell fudge (B9). Halo 3 splits
  water the same way: a refractive surface plus splash particles.

### 2.5 Acceptance tests (outcomes, from the liquids audit 9.5, all GPU)

U-tube within one quantum. A 30-cell pipe drains the tank to the pipe's level. A hole pours one unbroken stream
whose exit speed is √(2gh) for every h, with the landing point on the parabola. A puddle rests, then AWAKE = 0.
Any-volume pool rests flat. Mud, lava and slime keep slopes that rise with yield. Splash KE ≤ incoming. Liquid +
particle mass is exact. A settled world containing water certifies idle.

## 3. Physics model and rules

### 3.1 One clock, real units

- A fixed **60 Hz tick** at **real gravity** (32.7 cells/s²), independent of the display. Frames between ticks are
  render-only with interpolated flyers, so a 120 Hz MacBook presents at 120 and Low Power Mode at 30 fps doesn't
  slow the world (physics B13, perf S5).
- **Speed** ×½-×4 is the tick rate (30-240/s). POV locks to ×1, so bullets, body and world share one law. Today's
  world runs 6.6× real time, and its liquids "buzz" (liquids audit §6).
- **Heat runs on one declared accelerated clock** (`THERMAL_SCALE`, ~1000× real diffusivity), as Minecraft's day is
  20 minutes: lava that took days to cool would be no fun.
- **SI rows** (kg/m³, J/(kg·K), W/(m·K), Pa·s, J), converted once. A gold cell is 521 kg, an impact is ½mv² joules,
  and a target breaks when that exceeds its toughness (J per cell). Nuggets stop smashing steel (B7), and a 0.2 J
  drip can't break a torch (B8).

### 3.2 State (kept: brick-major order and the four index functions, C2)

| Plane | Per | Bytes | Contents |
|---|---|---|---|
| cell | cell, ×2 copies | 8 | `id` u10, rest flags u6, `aux` u16 (life, ctype, spark, latent bank: per-element meaning), `T` f32 |
| liquid page | liquid cell, ×2 | 8 | `fill` u16, flux +x +y +z 3 × f16 |
| air | brick, ×2 | 16 | gas density, momentum 3 × f16, temperature f16, openness, smoke tracer |
| deco | cell | 4 | TPT dcolour, lazy plane (U17, kept) |
| flyers | particle | 32 | position 3 × f32, velocity 3 × f16, id, T f16, volume, hash id, age |
| per brick | brick | ~16 | run counter, change and pending bits, list membership |

That is 16 B/cell for both copies, against 80 today. The per-cell flag plane F and the flow plane go: change is
reported per brick, and voxels teleport. At 128³: 32 MB of cells, ≤ 4 MB of liquid pages, 1 MB of air, 8 MB of
flyers. A sparse brick pool (perf 9.4) waits for Phase 5, where the world window needs it.

### 3.3 The tick

```
60 Hz, over GPU-built lists with indirect dispatch (as today):
  1 flyers  integrate, sweep vs masks, land by claim, deposit, splash                       [1 kernel]
  2 air     conservative gas step over awake air bricks                                     [1 kernel]
  3 react   per cell: conduction, phases, burning, reactions, sparks, heat to/from the brick's air, lift [1 kernel]
  4 move    Margolus 2×2×2, offset from an 8-tick cycle, ping-pong                         [1 kernel]
  5 flux    liquid pages of awake liquid bricks                                             [2 substeps]
  6 lists   change/pending bits → AWAKE/DRAWN lists + indirect args                         [3 small kernels]
```

That is 9 dispatches per tick (today 32 per frame at Speed 4). There is no rest-predicate pass: kernels 1-5 OR their
own change and pending bits into their bricks' words.

### 3.4 Settled matter (the cellular automaton, contact only)

- **Margolus with 8 offsets:** the partition offset walks all of {0,1}³ every 8 ticks, so a grain reaches every
  lower neighbour. The quadrant lock that keeps 159-172 of 512 units of a settled heap awake goes (physics B1).
  The move reads one copy and writes the other, so a rule may *look* beyond its block without racing.
- **Rules are a table the kernel interprets**, not 3,329 lines of unrolled code. A grain with air below detaches
  into a flyer. Over a lighter fluid it sinks by swap, and grains displace much lighter grains (TPT's weight rule).
  Grains topple, and gases stratify.
- **Repose angles the grid can express:** 45° (one free diagonal), 27° (the lookahead sees a second), and
  `cohesive` (only undercut faces fall). A row's `repose` in degrees snaps to a class, so sand and flour stop
  making the same heap (physics E3).
- **Ties break by world-cell hash.** A rule that could fire but lost its draw sets `pending` (§3.8).

### 3.5 Flying matter (one particle system)

A cell that loses support or is thrown by a blast, kick, shovel or physgun becomes a flyer, as does a liquid jet. It
flies ballistically with drag toward the air velocity and no speed cap. It **lands by claim**: each flyer landing
this tick does `atomicMin(hash id)` on its target cell, the winner writes, and the losers fly one more tick. That is
order-free and mass-exact. Slabs fall as slabs, throws follow their arcs, ejecta forms a blanket (physics B2, B3).
The gun's rounds (`pov/ballistics.js`) and the rays layer join it: a kicked clump, debris and a bullet obey one
law. Flyers draw as instanced voxel impostors in their element's palette, and they splat into the bricks' `flyers`
masks each tick, so they cast shadows.

### 3.6 Air

One gas cell per brick (1.2 m): TPT's air map in 3D, holding density, momentum and temperature. An explicit
conservative compressible step (Rusanov flux) uses face openness from the bake. Sound is slowed to ~50 m/s, so the
60 Hz tick is stable and a shock visibly crosses the box in ~0.7 s (TPT's front also moves about a cell a frame).
- **Blasts** add gas mass and energy (`blast.energy`, J), so fronts are round, a sealed boiler holds pressure and a
  vacuum pulls (physics B4-B6). Teardown-style **cell damage** is applied at once inside the radius (break by
  energy/r², launch flyers, walls shield by line of sight), so small charges stay crisp below 1.2 m.
- **Pressure difference across a solid face** breaks it (P_BREAK's idea, on a real field).
- **Wind and convection:** flyers feel drag, loose powder lifts into flyers above a threshold, gas cells drift with
  the air, and hot air rises carrying smoke. WIND, CYCL and VAC set air velocity or density, as TPT's do.
- **Rest:** air bricks sleep on their own. A blast wakes 1/64 of the cells, where today it wakes every brick for
  260 steps (physics E4).

### 3.7 Heat, fire, reactions

- **Conduction stays exactly as today** (symmetric, per-face limited, conserving). Plain air has no cell
  temperature: exposed faces exchange `h·A·ΔT` with their brick's air, gathered in the same workgroup, so the
  exchange is exact. The global pull to ambient goes. Heat leaves through open faces and the sky, and rest is relative
  to neighbours, so cold levels need no per-scene ambient or brine lakes (22692b4, 1def559).
- **Fire:** ignition is a chance per contact per second (TPT's flammability, Noita's fire_hp), rising toward
  autoignition, where it is certain. Burning is a state of the fuel. It spends `life`, releases `burn.heat` into
  itself, its neighbours and its air, caps at the adiabatic flame temperature (no more 5,300 °C hydrogen) and sheds
  short-lived FIRE media. A flame lights wood (physics B9), and the Campfire's 450 °C preheat goes.
- **Reactions** keep Noita-format rows with `chance` as a rate per second and product temperatures from the energy
  balance. Latent heat banking, lava's ctype and the electricity automaton stay.

### 3.8 Rest and sleep: flags emitted by the rules

Each kernel knows whether it changed a cell (`changed`) and whether a stochastic rule had a nonzero chance it didn't
take (`pending`). It ORs both into its brick's word in one workgroup reduction. A brick is quiet after **8 ticks**
(one full offset cycle) with neither bit set in it or its 26 neighbours. Continuous rules carry their deadband
inside the rule: a conduction or liquid flux under its quantum is not applied. So the state *is* a fixed point, and
the rule and its rest test are one code path that can't disagree. The hand-written mirror (`inertNear`,
`inertSelf`, six tolerances) goes, and with it the bug class behind physics B1 and E8. Writers still mark bricks
(D6). `skip-model.mjs` is rewritten for this rule with negative controls. Radial gravity and void or loop edges
keep sleeping on.

### 3.9 The element row

```js
SAND:  { kind: 'powder', density: 1600, heat: { cp: 830, k: 0.27 },        // kg/m³, J/(kg·K), W/(m·K) (CRC)
         powder: { repose: 34 },                                             // ° → the 27° class; weight rule from density
         phases: [{ T: 1700, into: 'LAVA', of: 'GLASS', latent: 1.4e5 }],     // °C, J/kg
         look: { palette: ['#c9ab7e', '#bf9f70', '#d4b88d', '#a88a5e'], weights: [5, 3, 2, 1], rough: 0.9, shape: 'grain' } },
WATER: { kind: 'liquid', density: 1000, heat: { cp: 4186, k: 0.6 },
         liquid: { viscosity: 1.0e-3, yield: 0, foam: 1 },                   // Pa·s, Pa
         phases: [{ T: 0, cold: 'ICE', latent: 3.34e5 }, { T: 100, into: 'STEAM', latent: 2.26e6 }],
         look: { transmission: { sigma: [0.35, 0.06, 0.015], ior: 1.333 } } },  // m⁻¹ at 650/550/450 nm (Pope & Fry 1997)
WOOD:  { kind: 'solid', density: 600, heat: { cp: 1700, k: 0.12 }, solid: { toughness: 2e4, debris: 'SAWDUST' },  // J/cell
         burn: { flammability: 0.08, autoignite: 300, life: 40, heat: 1.6e7, flameT: 1100, products: [['ASH', 0.2]] },
         look: { palette: ['#5a3a22', '#4e321d', '#6b4529'], rough: 0.8, shape: 'crag' } },
```

Gone from the row: `drag`, `flow`, `slide`, `friction`, `jitter`, `hard` in fictitious units, `dens` as mass,
`sigma` per cell, and the LOOKS `surf`, `crag`, `sss`, `glint` and `bevel` knobs. Adding an element stays data
only. The checklist's "still needs code: a branch of `matOf`" disappears.

## 4. Performance budgets

### 4.1 Per tick (sim; est. from bytes and today's measured per-cell ALU)

Per awake cell per tick: react ~18 B (8 B read with ~1.3× halo, 8 B written), move ~18 B, and liquid cells ~18 B per
substep. That is **~36-54 B**, against today's 167 B × 4 steps per frame. ALU: today's react costs 1.7 ns/cell on the
M5 (3.6 ms for all of 128³, commit 5551bd7). v2's air cells exit early, so cost follows matter (~35 % of awake cells).

| Per tick (est) | M5, lab typical (25 % of bricks awake, 524 K cells) | M5, everything awake (2.1 M) | iPhone, 128×64×128 typical (262 K) |
|---|---|---|---|
| react (matter cells × 1.7 ns, air cells × 0.15 ns) | 0.36 ms | 1.45 ms | 0.40 ms |
| move (contact-only table rules, ~0.5 ns/cell) | 0.26 ms | 1.05 ms | 0.29 ms |
| flux (2 substeps over awake liquid cells) | 0.10 ms | 0.40 ms | 0.11 ms |
| flyers (50 K), air, lists | 0.10 ms | 0.30 ms | 0.10 ms |
| **total** | **~0.8 ms**, ~24 MB | **~3.2 ms**, ~80 MB | **~0.9 ms**, ~12 MB |
| today | 4 steps × 1.8-2.6 ms = 7.2-10.4 ms, ~350-590 MB | ~20 ms+, ~1.3 GB | not measured |

The iPhone column assumes an A19 Pro sustains ~0.45× an M5 (est.), with half the cells. Worst case on the M5, a
fire or explosion with everything awake, is ~3 ms per tick, which fits a 16.6 ms frame. On the phone the tick
rate halves before the frame rate does.

### 4.2 Per presented frame

| Per presented frame (est) | M5, 60 Hz, 660 K px | iPhone 17 Pro Max, 60 Hz, 250 K px |
|---|---|---|
| sim tick (§4.1) | 0.8 | 0.9 |
| bake (visibly changed bricks only) | 0.05 | 0.05 |
| raster G-buffer (three meshes, flyers) | 0.1-0.3 | 0.1-0.2 |
| trace (§1.5: god view → close-up through water) | 0.4-1.9 | 0.3-1.4 |
| light (shading, cache lookups, media) + cache resolve | 0.25-0.5 | 0.2-0.4 |
| post (TAA/TAAU, bloom, adaptation, composite; today's) | 0.5 | 0.6 |
| **total** | **~2.1-4.1 ms** (perf audit's budget: ≤ 4.5) | **~2.2-3.6 ms** (budget ≤ 6.5) |
| at 120 Hz (sim still 60 Hz) | ~1.7-3.7 ms per presented frame | n/a |
| DRAM per frame | ~60-80 MB (sim ~24, screen buffers ~35, scene and cache ~5) vs ~0.7-1 GB today | ~30 MB |
| camera moving, world asleep | trace + light + post: ~1.2-2.9 ms | ~1.1-2.4 ms |
| camera and world still | 0 submits, 0 rAF after ≤ 8 frames | same |

Today's lab frame is 18-28 ms on the M5 (perf §5). The gap is structural: 1 tick of 8 B cells instead of 4 steps of
72 B cells, rays and a fixed-slice cache instead of a derived pipeline, and a frame that stops when nothing changes.

### 4.3 Memory and compile

| | Today (perf §2, §8) | v2 (est) |
|---|---|---|
| GPU resident at 128³ | 408 MB at boot, +201 MB undo | **~90 MB** (state 32, liquid ≤ 4, air 1, flyers 8, scene ≤ 10, cache 8, screen ~30) |
| undo | whole-grid snapshots, 67 MB each | brick diffs from the writers' marks, ≤ 32 MB ring (16 MB phone) |
| WGSL per session | ~1.7 MB, 98 pipelines, a 263 KB view module | ≤ 400 KB. `trace` ~300 lines, `light` ≤ 1,200, every sim kernel ≤ 600, per-family preludes |
| largest kernel build on SwiftShader | move 11.6-14.4 s, realistic view 9.3 s, relief/grains crash | the prototype's single megakernel (trace + whole path): 20-100 s with one call site, 376 s with five. The shipping `trace`/`light` split must beat today's 9.3 s, so it gets measured on the Mac in Phase 1 week 1 |

## 5. What of the WebGPU port is kept, and what is replaced

**Kept unchanged:** `src/gpu/*` (device, frame model, param ring, async kernels with explicit layouts, readback rings,
timing, present, three interop, errors); the app shell (`main`, `launch`, `preload` with the menu warm-up, `wire/*`,
the UI, the pacer, `createViewKey`, deep idle); post minus its look curves; the profiler and measuring tools;
constructions and their AI API, signs, saves, the console, POV gameplay, world generation (`toWgsl` and its CPU twin),
maps and menus.

**Kept as contracts, new contents.**

| Contract | v2 |
|---|---|
| Brick-major slot order; `brickId/slotOf/cellOf/brickCoord` the only index functions (C2) | same functions, 8 B cells; the toroidal window and brick pool stay a change to those four (Phase 5) |
| GPU-built brick lists + indirect dispatch, the run counter (D4, D5) | same lists; the inert predicate becomes emitted change/pending bits (§3.8) |
| Box-scoped edits with GPU marks (D6), `sim.edit` / `sim.probe` | same API; update functions rewritten for the packed cell; POV writers port onto it |
| Determinism (W21): hashed streams, no float atomics, integer atomics only for counts, appends, fixed-point deposits | same, plus flyer claims by `atomicMin(hash id)` and cache accumulators in fixed point |
| Exact mass, race-free pair rules, conserving conduction, latent banking, lava ctype, electricity | kept verbatim where the state allows |
| Element tables → one storage buffer generated from the rows (C6) | same generator, new row schema (§3.9) |
| Deco plane (U17) | kept; read by the material function |

**Replaced:** move and react (table-driven rewrites), the `activity.js` predicate, `derived.js`, fields, light, GI, the
shadow map, `render.js`'s volume and `gfx/{surface,grains,relief,crystal,liquid,liquidDetail,media,mediaDetail,
lighting,plain,clouds}` (by bake, trace, light and the cache), foam and aeration, rays and `pov/ballistics.js`' flight
(into flyers), the far field (a coarse voxel LOD in the same tracer, Phase 5), and the CPU twin `ui/tiles/engine.js`
(dock tiles become loops baked by the real engine, like `bake-icons.mjs`).

## 6. Kill list

| # | Feature or hack | Where | Why it goes |
|---|---|---|---|
| K1 | Blurred-occupancy fields: EMA, blur, boost, peak, thin masks, cubic B-spline, ISO root-finding | `fields.js`, `core.js:159-251`, `materials.js` CHANNELS | the "clay" (render 2.1); 76 B/cell; the 125-brick × 13-frame tail (perf P3) |
| K2 | 13 `matOf` branches, `relief`, `grains` (734 lines), clods, `crystal.js` (quartz drawn for cubic fluorite), Worley loops, far "means" | `surface.js:661-1219` et al. | invisible beyond 1-10 m, 9→48 ms relief, crash SwiftShader; uneven detail |
| K3 | Nine of ten lighting models | render audit 2.4 | one `light` |
| K4 | Shadow map, PCSS, exact edge ray | `lighting.js`, `render.js:1344-1466` | 262 K rays every derived frame (P2); per-pixel sun ray instead |
| K5 | L1 SH probes, glow volume + 6 blurs, glow-light RIS, near-field GI ("Contact Shadows"), field/face AO computed then dropped, lamp ray loops | `gi.js`, `lighting.js` | the radiance cache; B4, B5, B12 |
| K6 | Fudge gains: `LAMP_ROOM_GAIN 12`, `TORCH_SHED 20`, `EMBER_SHED 10`, `THIN_BODY_CELLS 24`, `SUN_GLINT_GAIN 6`, `SKY_IN_FLOOR`, `SUN_IN_GAIN`, `LOCAL_AO_MIN`, `SUN_CAV_MIN`, `GLOW_SCATTER`, `SKY.multi 2` | `materials.js`, `liquid.js` | they existed to undo blur and noise that are gone |
| K7 | +0.7 EV "old ACES" exposure, Punchy blend, warm roll-off | `post.js:98-103, 771-818` | AgX + one chosen grade |
| K8 | Detail matrix (1024 combos), `detailGate`, Full/Balanced, `WGSL_MAC_ONLY` realistic, material-lod-check | `gfx/detail.js` | tiers change convergence, not code |
| K9 | `plain.js` as a second renderer; night vision in the composite; `mobileVel`, liquid id dither, `hazeBend` (a no-op), `albedoOf` (dead) | | the Flat view; NV as its own pass; the renderer stops filtering the sim's noise |
| K10 | Four emission functions | render audit 2.4 | `emit()` |
| K11 | Derived key on the step counter, 22-frame GI settle, 109-frame TAAU settle | `app.js:1700, 1961`, `post.js:202` | change-driven bake; converge and stop |
| K12 | Max-plus pressure front, `P_DECAY`, `REST_P`, the ±50..200 clamp | `react.js:423-452` | coarse air (§3.6) |
| K13 | `V_MAX` 1 cell/step; per-element `drag`, `flow`, `slide`, `friction`, `jitter`; liquids skipping drag | `physics.js`, `elements.js` | flyers, SI rows, repose classes |
| K14 | The pour stack: PACE/R3, `fallAge`, the jet diagonal exemption, no-topple-toward-heading, pipe renormalization, `ORIFICE_CV` head scan, FLOW_SURFACE/KICK, FILM_*, DROPLET_*, `land()` splash, `BOUNCE_LIQUID`, `DIAG_NOISE` | `move.js:130-170, 279-381, 735-758`, `react.js:513-621` | fill + flux + particles |
| K15 | Whitewater: aeration kernel, moveSrc, out-of-place move switch, wakes, pour parcels, `jetWGSL` | U12 `liquidDetail.js`, `gfx/foam.js` | foam scalar in the flux pass |
| K16 | Powder landing scatter, `COLLIDE_V`/restitution cradle chains, `KE_TO_HEAT` 25×, the cell-0 quirk kept for parity | `move.js:218-267, 751-756` | flyers land by claim; SI impact energy; a real asymmetry |
| K17 | `AIR_AMBIENT_PULL`, per-scene `airT`, brine lakes, Campfire 450 °C preheat, kit settle passes | | workarounds for physics that is fixed |
| K18 | Six rest tolerances + hand-mirrored `inertNear`/`inertSelf`; per-cell flag plane F | `activity.js`, `common.js:648-690` | emitted change/pending bits |
| K19 | 4 steps per frame; `MAX_FPS` tied to the sim | `app.js:137`, `pacing.js` | 60 Hz tick |
| K20 | The CPU twin (1,079 lines) and `check-tile-engine` | `ui/tiles/engine.js` | baked tile loops; checks on the GPU harness |
| K21 | Whole-grid undo snapshots | `sim.js:908-921` | brick diffs |
| K22 | Flow plane (render-only RMW every step) | `move.js:797-803` | none needed |
| K23 | The unrolled 3,329-line move | `move.js` | table-driven rules |
| K24 | Tests that pin hacks (`jets` exact vx, the ±1 level acceptance) | `sim-check.js:415, 1476-1596` | outcome tests (§2.5, §7) |

## 7. How it fixes the four pain points and the worst bugs

| Pain point / bug | Root cause today | v2 mechanism | Proof (side by side or test) |
|---|---|---|---|
| **Look: clay, plastic, uneven** | blur isosurface at 30 cm + mm textures that LOD away | honest voxels, palette, micro shaper with footprint LOD, one material function | `v2/fid/sbs-64.png`, `sbs-128.png` (appendix A) |
| Render B1 navy void vs blue lighting sky | two skies | one sky + ground plane | any box shot |
| B2 glow 3-6× brighter in reflections | four emission functions | `emit()` | lava beside the sea, reflected vs direct ratio = 1 |
| B3 grey transmittance | alpha = 1 − mean(T) | per-pixel RGB throughput from the march | red mesh under 3 m of water reads dark teal |
| B4 lava light ±20 % flicker | Bernoulli shadow ray × TAA 0.07 | emitter NEE into the cache; pixels read the EMA | frame-to-frame diff in a lava cave < 0.5/255 |
| B9 drops drawn as 7 m of water | `THIN_BODY_CELLS 24` | real thickness + min optical thickness | pour shot |
| B11 phones get a different game | features cut on mobile | tiers change convergence only (§1.6) | Mac vs iPhone shot diff |
| **Water: beads, churn, no levels** | powder CA with velocity kicks | fill + flux + pressure; particles in the air | U-tube, pipe, puddle, pool, hole tests (§2.5) |
| Liquid B1, B2, B14 vessels, pipes, head cap | no pressure through lids | head from compression | U-tube within 1 quantum; 30-cell pipe drains |
| B3, B4 puddles and partial layers never rest | kicks fire on any open side | contact line + flux snap; exact integer rest | AWAKE 0 after N ticks |
| B5, B6, B7, B8 splashes make energy; dotted pours | Margolus parcels + random kicks + global pacing | ballistic particles, energy-bounded splashes | splash KE ≤ incoming; stream continuity ≥ 95 % |
| B9 no yield | viscosity only sets speed | Bingham yield per face | slope vs yield monotone |
| B12/B13 foam for 3 liquids, NaN-latent, stub | per-liquid hard-coding | `foam` column, foam in the flux pass | every liquid foams by its row |
| B15 air doesn't rise | E_EMPTY has no buoyancy | partial cell under liquid swaps upward | air bubble reaches the top |
| **Physics feel: floaty, arbitrary** | velocity carried by a coin-flip CA, 44 g clock | flyers at real g, one clock, SI rows | throw lands at the integrated distance ±1 cell |
| Physics B1 settled heaps never sleep | rest mirror ≠ move | emitted bits, 8-offset cycle | E3 heap: AWAKE 0 |
| B2, B3 throws 33-57 %, slabs smear | 1 cell/step, a coin per axis | flyers | slab stays one layer; throw distance exact |
| B4, B5, B6 octahedral blasts, pressure from nothing, no vacuum | max-plus front + 3 % decay | conservative coarse gas | diagonal/axis peak ratio > 0.8; ΣP conserved in a sealed box |
| B7, B8 gold breaks steel, drips break torches | dens as mass, capped speeds | SI masses and toughness | E6/E6b reruns break nothing |
| B9 flame doesn't light wood | thresholds only | contact chance | E7 lights |
| B11 gases never rest | brownian jitter | no jitter in still air; stratification is deterministic | CO₂ pool sleeps |
| B12 radial cube, sleeping off | blocks rotated; rest assumes −y | flyers feel the true field; the emitted-bit rule doesn't care about gravity | sleeping stays on in radial mode (the settled shape is still axis-quantized: a voxel planet) |
| B13 sim speed = frame rate | steps per frame | 60 Hz tick | 30 fps device keeps world speed |
| **Perf: 18-28 ms/frame, never idles** | 4 steps/frame × 167 B/cell; derived keyed on activity; full re-march | 1 tick, 8 B cells; change-driven bake; converge-and-stop | §4 budgets, `budget-check` extensions (perf 10.4) |
| Perf P1-P3, P6, P8 derived and view tails | step-counter key; full shadow/GI every frame | bake per visible change; cache updates are a fixed per-frame slice | derived ≤ 1 frame after last change; view ≤ 8 frames after still |
| P4 undo copies 134 MB per click | whole-grid snapshot | brick diffs | ≤ 64 KB per stroke |
| P5 1 frame in flight on WebKit | many passes per command buffer | 7-8 dispatches per tick; 2 in flight re-tested on iOS 26.x | |
| P9, P10 compile size | unrolled move, 33 KB prelude per kernel | table-driven rules, per-family preludes, one call site per ray kind | ≤ 400 KB WGSL per session |

## 8. Phased build plan

Every phase ships to tpt3d.codyh.xyz and is judged side by side with the current game on a fixed shot list (the
audits' scenes: lab-home, lab-tank, volcano-home, volcano-flank, the hole pour, the 6³ puddle, the E3 heap, the E4b
charge, Descent's Mines): stills from the same cameras plus 5 s captures on the user's Mac and iPhone
(`tools/power.mjs`). A phase ships when the user prefers it and its tests pass. `?engine=v1` keeps the old path
until the next phase lands.

| Phase | Ships | Visibly better because | Acceptance |
|---|---|---|---|
| **0. Yardstick** (1 week, no user change) | the shot list as `tools/side-by-side.mjs`; the audits' outcome tests as failing GPU tests; Mac and iPhone timing scripts | (none; it makes every later "better" checkable) | tests run red on v1 for the right reasons |
| **1. New eyes** | bake, trace, light, radiance cache with emitters, one sky + ground, water/glass optics on cell faces, Flat and data views, converge-and-stop, on the *current* sim (the bake reads today's state) | crisp voxels instead of clay, real sun shadows, a sky that matches, lava light without flicker, the same look on phone | render bugs B1-B12; view ≤ 8 frames after still; Mac trace + light ≤ 2.5 ms at 660 K px |
| **2. Water that rests** | liquid pages + flux, flyers (liquid only), fill surfaces, screen-space fluid, foam | pours are streams, lakes level and rest, U-tubes, pipes, waves | §2.5 tests; a settled lake certifies idle |
| **3. Things that fly** | 60 Hz clock, flyers for powders/debris/rounds/rays, Margolus 8-offset table rules, repose classes, packed 8 B state, emitted rest bits, brick-diff undo | throws arc, slabs stay slabs, heaps have angles and sleep, 120 Hz presentation | physics B1-B3, B7, B8, B13; perf ≤ 36-54 B/cell/tick |
| **4. Air and fire** | coarse air, blasts (radius + gas), vacuum, wind, convection, fire by contact and energy, media volumetrics lit by fire | round blasts, fireballs, smoke plumes lit from inside, boilers that hold pressure | physics B4-B6, B9, B11, B15 |
| **5. World and phones** | voxel LOD far field in the tracer, sparse brick pool + toroidal window, iPhone 17 Pro Max tuning, the CPU twin and v1 deleted | the world reads as one voxel world out to the horizon; the phone holds 60 | world window move ≤ 1 ms; phone ≤ 6.5 ms/frame, ≤ 2 W for 30 min |

Phase 1 comes first: it is the largest visible change, and it is independent of the sim (a bake from today's state is
a few hundred lines). Phases 2-4 each change one physical system and keep the others.

## 9. Risks

1. **Tracing cost on phones** (grazing-angle divergence, micro steps near the camera, two rays per water pixel).
   Mitigations: footprint micro LOD, render scale, K = 1/16. Go/no-go in Phase 1 week 1: timestamps of `trace` and
   `light` on the iPhone 17 Pro Max before anything is built on them. SwiftShader can't answer this.
2. **Radiance-cache artifacts**: lag after big changes, hash collisions, eviction pops, torchlight at cell-face
   granularity (Minecraft-like by design). Mitigations: change-driven count resets, the coarse level, and a GPU test
   against a brute-force path-traced reference of the shot list.
3. **The voxel look could read as crude from the god view.** The palettes are 91 rows of real art direction. The
   shot list is the gate, and appendix A already lets the user veto before Phases 2-5.
4. **three.js MRT G-buffer** (TSL `mrt()` into our targets) leans on the same internals as the port's interop
   (webgpu.md B10). Fallback: forward-shade meshes in TSL from a brick-resolution irradiance texture and a sun-visibility volume.
5. **Weakly compressible flux**: stability with viscosity and yield, partial cells shared by two liquids, deposit
   spikes at the particle handoff, hidden mass at depth (§2.1). The §2.5 tests run from day one of Phase 2.
6. **Content breaks**: the constructions' physics lint, Descent, presets, the AI prompt, Lua scripts reading
   `vx`/`vy`, and the codec and multiplayer (a format version bump). Each phase lists what it breaks.
7. **Flyer determinism in multiplayer**: claims and deposits are order-free, but flyer ids must come from (spawn
   cell, tick, rule), never from buffer slots. The list-permutation knob (I2.1) tests it.
8. **Scope**: everything above `src/gpu` is rewritten. The phases keep it shippable, and the kept contracts (C2,
   D4-D6, W21) keep each phase local.
9. **Time scale**: real g makes a 38 m box feel big and slow from the god view, the opposite of today's buzz. ×2 may
   be the right god-view default: one setting, decided on the shot list.

## Appendix A. Prototype evidence (`v2/fid/`)

**What it is.** `proto.js` is one WebGPU compute kernel plus a resolve. It traces the real presets, built on the CPU
exactly as the app builds them (`build.mjs` → `presets.js`), through the proposed hierarchy: 16³ sectors, 4³ bricks
with 64-bit any/opaque masks, cells, and 4³ micro-voxels from the shaper (crag, grain, leaf, step wedges). Per pixel
per frame it traces a primary ray, a sun ray with RGB transmittance through water and glass, one cosine bounce ray
plus its sun ray, and a Fresnel-weighted mirror reflection plus refraction march (uniform liquid bricks crossed in
one step). It uses today's albedo table and incandescence, one analytic sky with a ground plane, and AgX.
Accumulating 32 frames stands in for TAA and the radiance cache's convergence. `run.mjs` drives it through the
repo's `launchBrowser` on its own port, `analyze.mjs` makes §1.5's tables, and `montage.py` makes the sheets. Every
browser and server it starts is closed.

**Not in it:** the sim, media, flyers and meshes; the cache itself (the per-pixel bounce stands in for its converged
value); micro AO; footprint LOD (micro is always on, and is evaluated on the fly instead of baked); a hard sun (it
jitters over 1°); palettes (today's single albedos, so basalt at 0.076 reads charcoal).

**Sheets.** `fid/sbs-64.png`: today (the render audit's 64³ shots) beside the prototype from the same cameras, for
the volcano god view, the flank, the lab god view and the tank. `fid/sbs-128.png`: the prototype at the shipping 128³,
with the god views, 37 m, and the flank with the micro shaper off and on. What they show:
- Clay becomes crisp voxels with per-voxel variation. The brown pudding dome is a dark stepped cone, the lollipop
  trees are leafy canopies that let light through and cast real shadows, and the snow cap is a white terraced cap.
- One sky: the box stands on a sunlit ground under the sky it is lit by, not in a navy void (B1).
- The tank refracts cleanly through the glass, with an oil layer, a teal body and a sharp floor shadow, and none
  of today's speckled fringe (`evidence/lab-tank-fringe.png`).
- Honest weak spot: the shaper's carve rates are first guesses. At 5.8 m the carved rock is busier than it should
  be, and cells-only reads as Minecraft terraces. The answer lies between (fewer, larger chips, more wedge shapes)
  and is Phase 1 art tuning on the shot list.

**Numbers** (SwiftShader, 4 shared cores at load 15-21; only orders of magnitude transfer to a GPU):

| | Today | Prototype |
|---|---|---|
| shader build | realistic view 9.3 s (perf §8) | one megakernel: 376 s with five `trace()` call sites; 20-100 s with one |
| one frame, lab god view | view pass 28.9 s at 44.5 K px (64³, perf §5.1) | 1.1 s at 100 K px (64³), primary + sun + bounce + water |
| one frame, volcano flank | 541 s for 4 TAA frames incl. its passes (64³, render audit) | 2.8 s (64³); 3.5 s cells-only vs 6.9 s micro at 128³ (on-the-fly shaping; the bake removes that) |

A 25-50× per-frame gap on the same CPU rasterizer is a weak signal (different load, no media or meshes in the
prototype), but it points the same way as §1.5's traversal counts and §4's bytes.

