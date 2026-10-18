# v2 pitch: CRISP. Every cell is a block you can read.

Philosophy: The Powder Toy and Noita, in 3D. Every cell is a little block with a palette colour. A few surface classes
and one simple lighting model that is good at what voxels need: sun shadows, sky and block light, corner AO,
emissive glow and fog. Powders, liquids and gases are clean cellular automata with TPT semantics. Anything flying is
a particle. There are few rules and they apply everywhere, so play is legible. Performance comes from doing little,
and from doing it only when something visibly changed.

Inputs: the four audits (`v2/audit-{render,liquids,physics,perf}.md`), `docs/webgpu.md` A–F and the Sync log, the
subsystem maps, and the code at `claude/webgpu-port` 42f4039. Evidence I produced is in `v2/crisp/` (section 11).
(Repository note, 2026-10-16: the scripts later lived in `tools/v2/crisp/` and were removed after `a700d765`;
read them with `git show a700d765:tools/v2/crisp/<file>`. The shots are in `docs/v2/evidence/`.)

**See it first:** `v2/crisp/shots/side-by-side-64.png` puts today's realistic view next to a CPU mock of this
pitch's shading model, with the same presets, the same grid (64³) and the same cameras. `v2/crisp/shots/mock-128-montage.png`
is the mock at 128³ (god view, flank, lab, tank, summit lava, wood tower). The mock is a stand-in. It is not the
renderer, and section 11 lists its caveats. It shows the target: blocks with edges, colour variation per cell,
contact shadows in every crease, water that reads as water, a glowing lava block, and one sky.

---

## 0. The pitch in twelve lines

1. **Raster the voxels, don't raymarch them.** A GPU mesher turns exposed cell faces into 8-byte instances. They are
   drawn in one render pass with 4× MSAA kept in tile memory, with no TAA. On Apple's TBDR, rasterised opaque
   geometry is the cheapest thing you can draw.
2. **One material function.** Each element has a palette of four tones, a 16×16 pixel-art face pattern (Minecraft),
   a surface class (matte, gloss, metal, glass, liquid, emissive, foliage) and an emission. There are no per-element
   shader branches.
3. **One lighting function, used by every pixel:** sun with a shadow map, Minecraft light levels (sky light plus
   coloured block light, flood-filled on a 2-cell grid), 3-neighbour corner AO baked into the faces, emission from
   one blackbody table, and fog from the same sky you see.
4. **One clock:** a fixed 60 Hz tick at real gravity (9.81 m/s²). Today's world runs at 240 steps/s and about 44 g.
5. **Settled matter is a cellular automaton; flying matter is a particle** (Noita). There is no per-cell velocity.
   Throws arc, slabs fall as slabs, debris lands as an ejecta blanket.
6. **Liquids are mass plus face flux** (virtual pipes in 3D, weakly compressible). U-tubes and pipes work, pools have
   fractional levels and rest exactly, and jets leave holes at the Torricelli speed as particle streams.
7. **Air is TPT's coarse grid** (one air cell per 4³ brick: pressure plus velocity, conservative). Blasts are round,
   vessels hold pressure, vacuum pulls, and wind blows sand.
8. **Fire spreads by contact** (TPT flammability, as a rate) and by heat. Heat leaves through the box's
   boundaries, not through a global pull toward ambient.
9. **Rest is self-reported.** Every rule is written as `possible → chance → apply`. A brick sleeps when no rule
   could fire in it and nothing around it changed. The hand-written rest mirror, and its bugs, go away.
10. **Everything after the sim keys on "visibly changed" bricks.** That covers the mesher, the light grid and the
    shadow-map scissor. Each frame is final the first time it is drawn, so a still world with a still camera costs 0 submits.
11. **The phone gets the same game.** The defaults are built for the iPhone 17 Pro Max, and the Mac only renders more pixels.
12. **The foundation stays:** `src/gpu/*`, the app shell, brick-major state with GPU-built lists and indirect
    dispatch, box-scoped edits, determinism rules, the tables buffer, post's AgX and bloom, and the data views.

## 1. House rules (what every later decision follows)

- **The cell is the unit of meaning.** Nothing is drawn below the scale of a cell unless it is a texel of the cell's
  own pattern. There is no blurred isosurface and no millimetre texture. Liquids are the one smooth thing, because
  they have a level.
- **Data, not branches.** An element is a row; what a row can't say becomes a *general* rule for every row.
- **Real units in, game constants declared.** Masses in kg, energies in J, speeds in m/s, temperatures in °C. Where
  play needs something unreal (heat spreads like TPT's, explosives scaled down, viscous liquids hold a slope),
  it is one named constant with its multiple of reality printed beside it.
- **No estimator that needs 100 frames of TAA to converge.** If a term is noisy, it isn't in the default.
- **Change-scaled work.** One falling grain must not cost what a flood costs (a CI budget assertion, 5.4).
- **Incremental is exact or it isn't done** (kept from the port): mesher, light grid and sleep each have a
  full-recompute twin and a bit-exact test.

Scale stays at 0.30 m per cell. The player is 5.5 cells tall and a 128³ box is a 38 m site, so POV, the world, the
arenas and every authored scene keep their size. A cell covers 3–8 px in the default god view at 1280×800 and 50 px or
more in first person. That is enough for a flat palette tone at range and a 16×16 pattern up close (2 cm texels,
Minecraft's density).

## 2. Renderer

### 2.1 Pipeline (one tick, one frame)

```
tick (60 Hz, only if the world is awake)                 [compute, one pass]
  sim passes (section 4)        → marks.act (sleep), marks.vis (visibly changed bricks)
if marks.vis ≠ ∅:                                         [compute, same pass]
  mesh   : re-mesh the 16³ chunks holding vis bricks into their face slabs
  light  : re-source vis bricks; 4 max-plus iterations over vis ∪ 15-texel halo (2-cell grid)
  shadow : sun-space rect of vis bricks → scissored depth (+ tint) re-render (render pass)
if camera moved or slabs changed:
  cull   : chunk×direction buckets vs frustum → compacted face list + indirect args
frame (display rate, only if something changed on screen) [one render pass, MSAA 4×, store resolve only]
  sky (full-screen tri, depth = far) → opaque faces → particles (cubes/droplets)
  → translucent faces ×2 (multiply, then add) → gas puffs (premultiplied/additive) → overlays
  post: bloom chain (compute, ≤ 1/2 res) → canvas (AgX, exposure, bloom, UI composite)
```

When three.js has meshes visible (POV figures, birds, vehicles), it renders them first into its own colour and depth target.
Our pass then composites them with one depth-tested full-screen draw that writes `frag_depth` (one triangle loses
early-Z, nothing else does). Box mode has no three meshes, so a frame is one scene pass, one bloom compute pass and one
canvas pass, in one command buffer.

### 2.2 The mesher (GPU, compute)

- **Face instance, 8 B (opaque):** cell position in the window (7+9+7 bits, so the 384-tall giant volcano fits), face
  direction (3), exposed-edge mask (4), element id (8), 4 corner AO levels (4×2), glow level (4), LOD scale (2).
  **Translucent and liquid faces, 16 B:** add 4 corner heights (6 bits each, Minecraft's averaged water corners),
  run length behind the face (8 bits, for absorption), foam (8).
- **Faces live in per-chunk slabs** (16³ cells = 64 bricks). Each slab holds 4,096 faces, with overflow into a
  shared pool. Only chunks whose bricks are in `marks.vis` are re-meshed. One thread per cell checks 6 neighbours,
  computes corner AO from the 3-neighbour rule (Lysenko, 0fps.net 2013) and appends with a workgroup-aggregated
  atomic. A per-view cull pass compacts visible chunk×direction buckets into one draw list. It runs only when the
  camera moves or slabs change.
- **Counts, measured on today's presets** (`v2/crisp/faces.txt`, CPU build exactly as the app builds them):

  | preset | opaque faces | liquid faces | glass faces | facing the god-view camera | slab bytes |
  |---|---|---|---|---|---|
  | lab 128³ | 10,972 | 10,752 | 19,424 | 58 % | 0.57 MB |
  | volcano 128³ | 22,200 | 13,952 | 0 | 70 % | 0.40 MB |
  | Dam Valley 256×96×128 | 133,962 | 1,372 | 596 | 62 % | 1.10 MB |

  So a normal scene is 10K–150K faces. The budget below allows 400K faces in view (scattered sand, debris
  everywhere) plus 64K particle cubes. Minecraft's 16³ chunk meshes, rebuilt only when a block inside them
  changes, are the model (cited in `audit-perf.md` §9.3).

### 2.3 Material model (one row per element, no shader branches)

| field | meaning | example (SAND) |
|---|---|---|
| `palette` | 2–4 sRGB tones; a cell picks one by a stable hash of its world coordinate (TPT's per-particle colour, Noita's per-pixel variance) | `#dcbc74 #d3b16a #e6c886 #c4a35e` |
| `pattern` | one of ~16 authored 16×16 RGBA8 face patterns: R luminance, G pseudo-bump, B sparkle mask, A emissive mask; one `texture_2d_array` with mips (~16 KB) | `grain` |
| `surface` | `matte · gloss · metal · glass · liquid · emissive · foliage`: sets roughness, F0, wrap, transmittance path | `matte` |
| `emit` | constant emission (lamps) or `blackbody` (from T, one table, `gfx/incandescence.js`) | `blackbody` |
| `extinction` | liquids and glass only: rgb per metre (Beer–Lambert), with a stylised floor so a drop reads in its body colour | — |

Patterns are pixel art, drawn by hand (rock strata, planks, brick, leaves, ore flecks, metal plate, ice, coal,
lava crust with an emissive crack mask). Nearest-filtered when magnified, trilinear mips when minified, so they are
crisp at 1 m and resolve to the palette tone at 40 m. That is the scale problem the render audit found (2.1), fixed
by authoring at the scale the player sees. Decoration (TPT's dcolour) replaces the palette tone for a cell; the
mesher emits a 16 B face that carries the colour.

### 2.4 Lighting (one function, every pixel, no stochastic terms)

- **Sun:** a shadow map rasterised from the same face slabs. 2048² depth16 on Mac, 1024² on iPhone, for the 128³
  window. It is re-rendered only inside the sun-space rectangle of `marks.vis` bricks, or in full when the sun moves
  more than 0.25°. Translucent casters (water, glass, oil) write a multiplicative rgba8 tint target in the same pass,
  so sunlight under water is coloured and dim. Lookup is one `textureSampleCompare` (hardware 2×2 PCF), plus one
  tint tap only where a translucent caster exists. No PCSS, no blocker search, no exact edge ray.
- **Sky light and block light (Minecraft).** Levels 0–15 on a 2-cell grid (64³ texels at 128³, `rgba16float`, 2 MB):
  sky in `.a`, block light per channel in `.rgb`. Propagation is max-plus: `L = max(E, max₆(L_n) − cost)`, cost 1 per
  texel in air and 2 in liquid, with blocked texels holding 0. It is the Bellman–Ford fixed point, so **any start
  converges exactly within 15 iterations.** Stale light decays by at least one level per iteration, which makes the
  incremental result equal the full recompute (testable). Sky sources are texels above each column's highest
  blocker. Lava is (15, 11, 6), so its light reddens with distance. A held torch is a moving block-light source,
  and occlusion comes for free. Brightness uses Minecraft's curve `f/(4−3f)`. One trilinear tap per pixel.
- **AO and ambient:** per-vertex AO from the mesher, free at shading time (it replaces `fieldAO`, `faceAO` and the
  near-field GI rays). Ambient is `(skyIrradiance(n) × skyLight + blockLight) × AO`, from the one analytic sky.
- **Specular:** one GGX lobe for the sun. Environment specular is the sky colour in the reflected direction times sky light,
  so a cave pool reflects the dark. Metals tint it by F0. Sparkle (snow, sand, crystal) is the pattern's B mask times
  the sun lobe. It is fixed to texels, so it is stable with no TAA.
- **Emission:** one function, `emission(id, glowLevel)`, used for faces, particles, puffs and light sourcing alike.
  The mesher quantises T to a 4-bit glow level, and a band crossing counts as a visible change. That fixes render B2
  (reflections 3–6× brighter than direct view) by construction.
- **Fog and sky:** one analytic sky (gradient, sun disk, a scrolling 2D cloud layer) for the background, ambient, fog,
  reflections and the underwater tint. It fixes B1 (the navy CSS backdrop lit by an invisible blue sky). Height and
  distance fog use the horizon colour. When the camera is in a liquid cell, that liquid's extinction is the fog.

### 2.5 Liquids, glass, gases and particles on screen

- **Liquid surfaces** are faces at `y + level`, with corners averaged from neighbouring columns (Minecraft), so
  pools are smooth and sloshing surfaces are continuous. The normal comes from the corner heights plus a scrolled
  16×16 ripple normal map. Absorption uses `run / |rd·n|`, with the run length baked into the face. It is drawn twice:
  the first draw multiplies the destination by the coloured transmittance (`dstFactor: 'src'`) and the second adds
  the Fresnel sky reflection, the sun glint and in-scatter. **That gives coloured transmittance with core blending
  only and no extra pass** (it fixes B3, where water tinted bodies grey). Foam whitens the top face (Noita's and Halo
  3's foam is a surface texture, not a simulation of bubbles).
- **No refraction in the base look**: it costs a colour copy and a second pass. It is an optional Mac extra in P6.
- **Lava** is a liquid with the `emissive` surface: opaque, smooth top, glowing crack pattern, and block light 15.
- **Gases** are soft camera-facing puffs, one per gas cell, about 1.4 cells across, with analytic falloff and no texture.
  Smoke and steam are premultiplied with low alpha (nearly order-independent). Fire is additive and feeds bloom.
  Above 16 gas cells in a brick, a brick draws one puff per 2³ cells (LOD). Blending stays in tile memory on Apple.
- **Particles** are instanced: a powder or debris particle is a full cell-sized cube (it *is* a cell in flight). A
  liquid particle is a droplet cube of ½ cell in the liquid's body colour (Noita's "every pixel in its body colour",
  with no 24-cell absorption fudge). Sparks are emissive points.

### 2.6 Data views, far field, overlays

- **Heat, pressure, flow, X-ray** (TPT's display modes) are fragment variants of the same face shader. Heat reads T
  from the state buffer by cell, pressure the air grid's 3D texture, flow the liquid flux. X-ray draws faces additive
  with depth off. The plain view goes: it becomes the default.
- **The far field (world mode)** becomes LOD voxel meshes in the same face format (2-, 4- and 8-cell voxels, Distant
  Horizons-style), built per 32-column chunk by the existing GPU world generator plus the edit store, cached, and lit
  by the same function with a heightmap shadow. `shaders/far.js` (1,232 lines) retires: near and far are one renderer.
- Floor grid, box edges and brush cursor stay ours, drawn in the scene pass.

### 2.7 What a pixel costs

| layer | per covered pixel (after HSR) | today (realistic, Balanced) |
|---|---|---|
| opaque face | 1 fragment: 1 pattern tap, palette from the tables buffer, 1 shadow compare (+1 tint tap under water), 1 light-grid tap, AO from vertices, ~120 ALU (sun GGX, sky, fog, emission) | a DDA of ≤ 392 cell steps, then up to 4 `matOf` with 27-neighbour Worley searches, PCSS 16 taps, 2 near-field DDA rays, glow RIS DDA, probe taps, glints, then TAA |
| liquid / glass | +2 fragments: 1 ripple tap, Fresnel, analytic sky, exp() | refraction march, traced reflections, `thinBodySeg` |
| gas | n puffs × ~20 ALU, 0 taps | media march at 1 sample per cell + noise octaves |
| post | in-tile MSAA resolve; bloom ≈ 0.4 taps per pixel; composite 2 taps | TAA/TAAU (109 frames to settle), bloom, adaptation, CAS, 3 tone curves |

So a pixel costs about 4–5 texture taps and ~200 ALU, against thousands today. **The view module is budgeted at
≤ 700 lines of WGSL** (today's realistic module is 5,400 lines and 263 KB).

## 3. Liquids

### 3.1 Bulk liquid: mass plus face flux (virtual pipes in 3D)

A cell is either one liquid with a mass `m` (u16, 1/1024 of a cell, which is 0.3 mm of level) or not liquid. Each
liquid cell owns the flux on its +x, +y and +z faces (3 × i16, in mass units per substep). There are 2 substeps per
tick (120 Hz). Each substep runs three gather-only, in-place dispatches over liquid bricks:

1. **Flux:** `f += dt·(Φ_i − Φ_j)·A`, where `Φ = g·y_level + P(m)/ρ`. `P(m) = c²·max(m − 1, 0)` is weak
   compressibility. Then `f *= damp(viscosity)`. Flux is zero across a face if the head difference is below the
   liquid's **holds** slope, or if the source is at or below **MIN_FILM** over dry ground.
2. **Limit:** each cell scales its outflows so it never sends more than it holds (Mei et al. 2007's K factor). The
   factor goes to a 2 B scratch.
3. **Apply:** `m += Σ in − Σ out` in integers, so mass is exact. The face owner writes back the limited flux, which
   keeps momentum consistent with what moved.

Numbers. The acoustic speed is 1 cell per substep (36 m/s), so hydrostatic compression is
`g·Δy/c² = 32.7·(1/120)² ≈ 0.23 %` per cell of depth: ≤ 7 % at the foot of a 30-cell lake, invisible. A gravity
wave in a 6 m pool travels at √(gh) = 7.7 m/s = 0.21 cells per substep, well inside the CFL limit. **Rest is exact**:
the flux snaps to 0 when |f| and the driving term are both below 1 unit (a dead band), and integer mass then makes a
true fixed point, so the brick reports "nothing possible" and sleeps.

What it buys, by audit test (`audit-liquids.md` 9.5):

| test | today | v2 mechanism |
|---|---|---|
| U-tube | left 25, right 5, certified idle (B1) | compression carries pressure through the bottom; equalises to the dead band |
| tank → 12-cell pipe | stops at step 300 with 27 cells of head (B2) | the pipe is just liquid cells; flux keeps accelerating by the head |
| puddle | 1-cell speckle over the whole floor, never rests (B3) | spreads until every edge cell is at MIN_FILM (⅛ cell, 4 cm), then sleeps: a 1-cell spill makes an 8-cell puddle |
| partial top layer | 150 beads churn forever (B4) | fractional level; flat surface; rests |
| viscous liquids flatten (B9) | slime and lava in 1–2-cell films | `holds` slope per liquid: mud 14°, slime 45°, lava 27° hot and rising as it cools, until it sets |
| immiscible layers | works (keep) | one liquid per cell; the swap pass (4.3) stratifies by density; oil spreads on water as a film supported by it |

**The `holds` slope is a declared game property.** At 30 cm cells, a real yield stress holds less than a cell of
head (the comment at `elements.js:853` says so), so slopes are authored as angles. Noita's viscous liquids heap the
same way.

### 3.2 Airborne liquid is particles

- A liquid cell with no support (air or lighter gas below it) hands its mass to droplet particles (≤ ⅛ cell each),
  each starting with the cell's face velocity.
- Outflow through a face into an unsupported air cell (a hole in a tank wall, a pipe end, a ledge) becomes droplets
  at that face, at the flux's speed. **A jet therefore leaves at √(2gh) and follows the exact parabola.** That is
  Torricelli as an outcome, not as a rule (today's `ORIFICE_CV` head scan goes).
- Droplets land by integer `atomicAdd` of mass into an empty or same-liquid cell (addition commutes, so it is
  deterministic); otherwise they stay particles and retry.
- **Splashes conserve energy.** An impact above 1 m/s (Ervine and Chanson's entrainment onset) sends a crown of
  droplets around the impact normal. Their total kinetic energy is ≤ 0.3 of the incoming, and the rest goes to foam
  and heat. Today's splash creates 160–210× the energy (B5) and stacked falling cells "land" in mid-air (B6). Both
  are gone because falling liquid isn't in the grid.
- A pour is a continuous stream of droplets that thins as it accelerates, as real streams do. That replaces the whole
  pour stack (`audit-liquids.md` §4: PACE/R3, fallAge, wakes, pour parcels, `jetWGSL`, `thinBodySeg`, `mobileVel`).

### 3.3 Foam and look

- **Foam** is one u8 per liquid cell (the high byte of the liquid's `aux`). Particle impacts (by kinetic energy) and flux
  shear (hydraulic jumps, a wake behind a body) feed it. The flux advects it upwind, and it decays at Monahan's τ (2.54 s
  fresh, 3.85 s salt). `foams` is a column on every liquid row, so saltwater, blood and potions foam too (fixes B12).
  This is not a separate pass, there is no out-of-place move and no `moveSrc`.
- The surface is smooth from mass (no EMA, no blur), the colour is Beer–Lambert by the actual run length, and liquid
  particles are drawn in their body colour. **There is one water look, so a puddle and a drop no longer read as
  different materials** (today's polka dots, §6 of the liquids audit).

## 4. Physics model and rules

### 4.1 One clock

A fixed 60 Hz tick with an accumulator, decoupled from presentation (Minecraft runs 20 ticks per second at any frame
rate). Gravity is real: 9.81 m/s² = 32.7 cells/s². A fall from the top of a 128³ box (38 m) takes 2.8 s, where today
it takes about 0.6 s (432 m/s², capped at 72 m/s). Heat, fuses, flame lives and tools all run on this clock, and tool
strengths are per second. A **Sim speed** setting (1×, 2×, 4×) is TPT's speed option and says what it costs. If the
GPU falls behind, the world slows rather than the frame rate (at most 2 catch-up ticks per frame). POV ballistics stay
on the CPU for instant authority, with the same law and g. That fixes the three clocks (physics B13 and §4.1).

### 4.2 Cell state (brick-major order kept, per-cell bytes 80 → 26)

| plane | layout | bytes per cell |
|---|---|---|
| core (ping-pong, 2 copies) | `id u8 · ctype u8 · aux u16` (life, fuel, latent bank, burn stage, liquid foam) + `T f32` | 2 × 8 |
| liquid (single copy) | `mass u16 · flux x,y,z i16` | 8 |
| liquid scratch | limit factor u16 | 2 |
| deco (only when used) | rgba8 | 4 |
| per brick | act, vis, matter, liquid bits; run counter; lists (as today) | ~0 |
| air grid (per 4³ brick) | `p f32 · v 3×f16 · solid fraction u8 · pad` | 16 per brick |
| particles | 32 B each, 64K capacity, 2 lists | 4 MB total |

Today's A, B, F and flow planes total 80 B/cell, plus 76 B/cell of render fields. Velocity leaves the cell (it lives
in particles and liquid flux) and so does pressure (air grid). A logical `Cell { id, T, aux, ctype }` API
(`loadCell`, `storeCell`) is the only way kernels touch state, as `fetchA`/`writeState` are today (C2/C5), so the
packing can change without touching the ~40 POV, world and tool kernels.

### 4.3 The tick (≈ 12–17 dispatches, all indirect over awake bricks except the small air grid)

```
1 particles: integrate (gravity, drag toward air velocity), DDA sweep ≤ 8 cells, claim (atomicMin key) / deposit (atomicAdd)
2 particles: commit winners into cells; losers stay particles; splash/bounce spawn; compact the list
3 swap pass  (the port's fused in-place Margolus kernel, rules rewritten, no velocity):
             detach unsupported cells → particles; topple; sink; gas buoyancy/drift/diffusion; liquid stratification
4 liquid ×2 substeps: flux, limit, apply (3.1)
5 air grid: TPT Air (velocity from ∇p, pressure from −∇·v, semi-Lagrangian advection, loss 0.9999/tick)
6 react (ping-pong core): heat, phases, reactions, fire, electricity, breaking
7 activity: OR of every pass's "changed or possible" per brick → next tick's lists (dilated 1 brick, run counter kept)
```

The Margolus partition offset is **drawn per axis each tick** from the tick hash (8 offsets, not 2). Blocks stay
disjoint, but every lower neighbour is reachable within a few ticks. That ends the quadrant lock (B1) and the square,
terraced heaps (§4.2), and the in-place, race-free kernel from the port carries over unchanged.

### 4.4 Rules (the complete list)

1. **Support.** A non-solid cell (powder, liquid, loose debris) with air or a lighter gas below it leaves the grid as
   a particle, keeping its id, T and aux. Solids are anchored. Debris from breaking is powder.
2. **Topple (powders).** A supported grain moves one cell into the lower ring if its repose class's drop/run test
   holds: *steep* needs a 2-cell drop over 1 cell of run (63°), *normal* 1 over 1 (45°), *flowing* 1 over 2 (27°).
   Each element row cites the measured angle and is quantised to the class the grid can hold. `slide` becomes a rate
   per second.
3. **Sink.** A cell swaps with a less dense fluid below it, or diagonally below for powders. Density is real (kg/m³). Grains
   also displace much lighter grains (TPT's Weight): uranium sinks through sawdust.
4. **Liquid flux.** Section 3.1.
5. **Gas.** Rises or sinks against neighbours by density (ideal-gas thinning with T, kept). It drifts with the air
   grid's velocity, and it diffuses by random swaps with air only while `age < diffusion age`. A still CO₂ pool settles
   and sleeps, and smoke fades out by `life` (fixes B11).
6. **Particles.** Ballistic under real g, with drag toward the local air velocity and a terminal speed per class. They
   land by claim; above 1 m/s they splash (liquids) or bounce with restitution ≤ 0.3 (grains), within the energy
   budget. There is no speed cap, because the sweep is a DDA (continuous collision). Kicked clumps, blast debris,
   physgun loads and thrown sand all fly by this one law.
7. **Air.** TPT's air map on 4³ bricks. Solid fraction blocks flow per face, and walls conserve. Blasts add energy;
   burning and boiling add gas. Wind and vacuum tools set velocity and pressure *in the air*, and matter follows the
   air (TPT): a loose powder cell under air faster than its `windLift` detaches.
8. **Heat.** Per-face conduction with the port's exactly conserving limiter, plus a dead band so it reaches rest.
   Latent heat banks (kept). An upwind convection term follows air velocity. The box's open faces exchange heat
   with ambient through a boundary conductance: energy leaves through boundaries, so there is no `AIR_AMBIENT_PULL`
   and no per-scene `airT`.
9. **Phase change.** `hot`, `cold`, `crush` rows (kept). Crush reads the air grid.
10. **Reactions.** Noita-format pair rows (kept), with `chance` as a rate per second corrected for the pairing.
    Product temperature comes from energy: heat divided by products' capacity, capped at the products' flame
    temperature (fixes the 5,300 °C H₂–O₂ flame).
11. **Fire.** A fuel touching a flame or a burning cell ignites at `flammability` per second per burning neighbour
    (TPT), or by temperature. Burning releases `burnHeat` J/s, spawns FIRE into open air, consumes fuel, and is
    smothered by CO₂'s face share. Two 1,000 °C flames light a wooden block within a second or two (fixes B9), and the
    Campfire's 450 °C pre-heat goes.
12. **Breaking.** Impact kinetic energy (½mv² with m = ρ × 0.027 m³) against `toughness` in J. A solid also breaks when
    the air pressure difference across it exceeds its `strength`. Liquids never break solids by impact, which fixes
    the drips that smash torches (B8). Gold now breaks steel only if a 521 kg cell actually carries the energy (B7).
13. **Electricity.** TPT's spark automaton, unchanged (`electricity.js`).

**Rest:** each rule is written `if (possible) { anyPossible = true; if (rnd < chance) apply(); }`, and the kernel
ORs `anyPossible || changed` into its brick's `act` bit (a workgroup reduction, then one `atomicOr`). A brick sleeps when
it and its 26 neighbours report nothing for two ticks, which is the port's run counter and invariant. The rest
test *is* the rule, so the 8-neighbour mirror (B1), the six `REST_*` tolerances and `inertNear` all go. It works
under radial gravity and loop or void edges too (B12), because nothing assumes a mode.

### 4.5 Explosions, as a worked example of the rules

A gunpowder cell reaches its ignite temperature, or a flame touches it (rule 11 with `blast.flame`). It becomes
FIRE and products at `blast.T`, and adds `E × BLAST_SCALE` to its air cell. `BLAST_SCALE` is 10⁻³ and printed in the
table header: a 27-litre cell of real TNT would level the site. The air grid carries a **round** pressure wave
outward (no L1 octahedron, B4), reflects from walls, and is held by a sealed vessel (a 0.9999-per-tick loss is about a
2-minute half-life, B5). Behind it comes rarefaction (B6). Solids whose cross-face Δp exceeds `strength` break into
debris. Loose cells under strong acceleration detach as particles with the impulse `∇p·V·dt/m`, so they arc out and
land as a rim and an ejecta blanket instead of the single grains of E4b.

### 4.6 Element table shape

```js
SAND:  { kind: 'powder', name: 'Sand',
         look: { palette: ['#dcbc74', '#d3b16a', '#e6c886', '#c4a35e'], pattern: 'grain', surface: 'matte', sparkle: 0.3 },
         rho: 1600, repose: 34 /* ° (measured) → 'normal' */, windLift: 7 /* m/s */,
         k: 0.25, cp: 830, hot: { T: 1700, into: 'GLASS' }, desc: '…' },
WATER: { kind: 'liquid', look: { palette: ['#2a78d4'], surface: 'liquid', extinction: [0.35, 0.047, 0.033], foams: 1 },
         rho: 1000, viscosity: 0.001, holds: 0, k: 0.6, cp: 4186, sigma: 0.05,
         cold: { T: 0, into: 'ICE', latent: 334e3 }, hot: { T: 100, into: 'STEAM', latent: 2257e3 } },
WOOD:  { kind: 'solid', look: { palette: […], pattern: 'planks', surface: 'matte' }, rho: 600, k: 0.15, cp: 1700,
         toughness: 2e3, strength: 40e3, breakInto: 'SAWDUST',
         burn: { flammability: 0.5, time: 60, heat: 15e3, flameT: 900, into: 'ASH' } },
```

About 25 fields, each with a unit. Retired: `drag`, `friction`, `jitter`, `flow`, `slide` as a probability, `hard`
in dens·cells²/step², `dens` as a mass, per-cell `sigma`, `spawn`. The 91 elements and 14 reactions stay as content,
migrated by a script that flags every value it can't convert. "Adding an element is data only" now has no exceptions:
there are no `matOf` or `relief` branches to add.

## 5. Performance budgets

Devices: an M5 MacBook Pro (≈150 GB/s; the user's machine per the repo's notes) at 1512×982 CSS rendered at 1× (1.48M
pixels), and an iPhone 17 Pro Max (A19 Pro, ~60–77 GB/s) at 1.5× CSS, 660×1434 (0.95M pixels); both 4× MSAA, both a
128³ window. "Typical active" is the lab with a pour and a fire: ~200K awake cells, 50K liquid, 5K particles, 10
chunks re-meshed per tick. All values are estimates derived here; P0 measures them (`power.mjs`, timestamps).

### 5.1 Per tick (DRAM bytes, est.)

| pass | bytes per awake cell | typical | worst (1M awake, 64K particles) |
|---|---|---|---|
| swap (in place, write only if changed) | ~10 | 2.0 MB | 10 MB |
| liquid, 2 substeps × 3 dispatches | ~60 per liquid cell (incl. halo) | 4.8 MB | 30 MB |
| react (ping-pong core, neighbours from cache) | ~16 | 3.2 MB | 16 MB |
| particles | ~100 per particle | 0.5 MB | 6.4 MB |
| air grid (32K coarse cells, runs only when not calm) | — | 0–1 MB | 1 MB |
| activity | per brick | 0.1 MB | 0.3 MB |
| **tick total** | | **≈ 11 MB → 0.7 GB/s at 60 Hz** | **≈ 64 MB** |

Today, the same awake set costs ~167 B per cell per step, × 4 steps per frame, which is 130–590 MB per frame for the
sim alone (`audit-perf.md` §3). **That is 12–50× less traffic.** The time per tick is dominated by about 15
dispatches (~10 µs each on Metal's serial compute encoder) plus bytes at ~40 GB/s effective: **≈ 0.5 ms on the Mac,
≈ 1.0 ms on the iPhone** typical. In the worst case it is ≈ 2 ms on the Mac and ≈ 4.5 ms on the iPhone, where the tick
drops to 30 Hz: the sim slows and the frame doesn't.

### 5.2 Per presented frame

| part | Mac ms | Mac MB | iPhone ms | iPhone MB | today, Mac (`audit-perf.md` §5) |
|---|---|---|---|---|---|
| sim tick (amortised, 60 Hz) | 0.5 | 11 | 1.0 | 11 | 7.2–10.4 ms (4 steps) |
| visible-change upkeep (re-mesh ≤ 10 chunks, compaction, light 4 iterations on ~30K texels, shadow scissor) | 0.25 | 6 | 0.5 | 6 | 3.8 (updateBricks) + 2.6–4.3 (shadow + GI) |
| scene pass (≤ 150K visible faces, puffs, particles; MSAA resolved in tile) | 1.0 | 25 | 2.0 | 17 | 3–9 (march + shading) |
| post (bloom ≤ ½ res, AgX composite, canvas) | 0.3 | 22 | 0.5 | 14 | ~1 |
| **typical active total** | **≈ 2.1** | **≈ 64** | **≈ 4.0** | **≈ 48** | **18–28 ms, 0.7–1 GB** |
| budget (`audit-perf.md` §10) | ≤ 4.5 | ≤ 120 | ≤ 6.5 | ≤ 50 | |
| camera moving, world asleep | ≈ 1.4 | ≈ 47 | ≈ 2.6 | ≈ 31 | 3–9 + 109-frame TAAU tail |
| camera still, world asleep | **0 submits, 0 rAF** | 0 | same | 0 | same (kept) |
| worst (Dam Valley fire fight) | ≈ 5.5 | ≈ 150 | ≈ 9–12 (tick halves) | ≈ 120 | 50+ |

Derivations. Scene-pass bytes are the tiler's parameter buffer (≤ 300K triangles × ~48 B ≈ 14 MB) plus ~4 taps per
pixel at 1–2 B effective; its ALU (~200 ops × 1.5M fragments ≈ 0.3 GFLOP) is under 0.1 ms on the M5. Post is 1.48M
pixels × (resolve 4 + bloom ~3 + composite 4 + canvas 4 B) ≈ 22 MB. At ~30 pJ/B, 64 MB × 60 Hz is ~0.12 W of DRAM;
GPU busy 15–25 % puts the iPhone's sustained GPU power at **~1–1.5 W**, under the 2 W budget. **There is no TAA
tail**: a frame is final when first drawn. 120 Hz on ProMotion costs only scene + post per extra frame (off on battery).

### 5.3 Memory and compile (128³)

| | v2 Mac | v2 iPhone | today (measured at boot, `audit-perf.md` §2.2) |
|---|---|---|---|
| sim state (core 2× + liquid + scratch + claims 4 B) | 63 MB | 63 MB | 168 MB |
| derived (face slabs 16, draw lists 4, light 4, shadow 8 + tint 4) | 36 MB | 26 MB | 164 MB (fields, GI, shadow) |
| particles, air grid, lists | 6 MB | 6 MB | — |
| targets (MSAA colour rg11b10/rgba16f + depth, resolve, bloom) | ~60 MB (~10 with transient attachments) | ~40 MB | ~40 MB |
| undo (brick diffs ring) | 32 MB | 16 MB | up to 201 MB |
| **total** | **≈ 200 MB** | **≈ 150 MB** | **408 MB at boot**, 600+ after three strokes |

WGSL per session ≤ 400 KB (today ~1.7 MB). The largest kernel is ≤ 700 lines (today the unrolled move is 3,329). Rule
tables live in the tables buffer and are interpreted by small loops, never unrolled per element. Each kernel family has
its own small prelude, so a blur no longer carries 30 KB of constants.

### 5.4 Enforced, not hoped for

`tools/budget-check.mjs` already asserts passes, submits and dispatches per scripted frame. v2 adds: workgroups per
changed brick (one grain stays O(1), with a flood as the negative control), derived frames after the last change ≤ 1,
view frames after the camera stops = 0, bytes allocated per cell ≤ 30, and WGSL per pipeline ≤ 700 lines. The same
scenarios timed on the Mac and the iPhone (`power.mjs`) are the release judge.

## 6. Kept from the WebGPU port, and replaced

| area | kept as is | kept, reshaped | replaced |
|---|---|---|---|
| `src/gpu/*` | device, frame model (one open encoder, flush rules), param ring, async kernels and explicit layouts, readback rings, timing split mode, errors and device loss, present, three interop | — | — |
| app shell | `main.js` probe and error page, preload warm-on-menu, `wire/*`, UI, dock, console, saves UI, deep idle | `pacing.js`: the view key loses the TAA settle and gains "tick due" plus "vis changed" | the detail tiers, `detailGate`, `coldShader`, `programs.js` stubs |
| sim state layout | brick-major slot order and the four index functions (C2), ping-pong halves in one buffer | A/B/F → core (8 B ×2) + liquid plane + per-brick bits, behind a logical `Cell` API | per-cell velocity and pressure, per-cell flags, `flow`, `moveSrc` |
| sleeping | GPU-built lists, indirect dispatch, AWAKE/DRAWN dilation, the run counter and its invariant (D5.3), `skip-model`'s method | the inert build becomes an OR of "possible or changed" reported by the passes | `inertNear`, `inertSelf`, the `REST_*` tolerances, `quietOk` off-switches |
| edits | `sim.edit` / `editKernel` / `probe`, box-scoped writers with GPU marks, one dispatch per edit, the one-writer rule | writers write `Cell`s; kick, blow and physgun spawn particles instead of setting velocities | whole-grid undo snapshots (→ brick diffs from the marks) |
| determinism | PCG streams seeded by world cell, tick and salt; `u32ToF32`; integer atomics only | atomics now also for particle claims (min) and deposits (add), both order-free | — |
| tables | one storage buffer generated from the rows, `hostStruct`/`uniformStruct`, `tables-check` | new schema (4.6) | 39 fields with fictional units |
| sim kernels | the fused in-place Margolus kernel's skeleton (as the swap pass), conduction limiter, latent bank, reactions pairing, electricity | `react` rewritten table-driven | `move.js` rules, `react.js` liquid/pressure/force code, `fields.js`, aeration, rays as a separate system (→ a particle class) |
| render | post's AgX (one curve), energy-conserving bloom, histogram adaptation, the canvas composite, data-view colormaps (`views.js`), floor grid, edges, brush, the mesh-cut idea (meshes tinted by water) | a scene pass with MSAA instead of TAA | the volume raymarcher, all of `shaders/gfx/*` materials, GI probes, glow-volume blur, `brickDist`, shadow DDA kernel, TAA/TAAU, CAS, `far.js` |
| world | generator, scenes, window shift, store, stamps | the generator also emits LOD chunks for the far field | far heightfield marcher, detail-mesh LOD worker |
| tools | `browser.mjs` and the GPU budget rules, `budget-check`, `check-wgsl`, the regress and smoke shots, `derived-check`'s "incremental == full" idea | `sim-check` stages rewritten as outcome tests (5.4, 3.1, 4.4) | `material-lod-check` (1,024 detail combos), the CPU twin (`ui/tiles/engine.js`, `check-tile-engine`) |

## 7. Kill list

**Look**
- The realistic volume raymarcher (5,400-line module) and the Balanced/Full/relief/grains/clods matrix (2 × 1,024
  variants). `surface.js matOf`'s 13 branches: wood's pith search, fluorite's quartz prisms, concrete bug holes,
  steel grooves, sand dark grains, ash flecks, Clone's "polished gold".
- `grains.js`, `relief.js`, `crystal.js`, `liquidDetail.js` (meniscus, capillary ripples, breakup in the shader),
  `media.js` octaves, `mediaDetail.js` filaments, the volumetric cloud deck, `mediaNoise`.
- Blurred-occupancy isosurfaces and the whole field pipeline (EMA, blur, boost, peak, thin mask, the 125-brick ×
  13-frame tail).
- L1 SH GI probes, near-field GI rays, glow-light RIS, PCSS and its exact edge ray, jittered glints, ripple caustics
  (they may return as a sun-tint texture), lamp DDAs, `hazeBend` (a no-op that is still called).
- TAA/TAAU, CAS, the Punchy AgX blend, the warm roll-off and the +0.7 EV fudge (one AgX curve stays). Night vision
  moves out of the composite into a perk overlay.
- `THIN_BODY_CELLS = 24`, `LAMP_ROOM_GAIN`, `TORCH_SHED`, `EMBER_SHED`, `SUN_GLINT_GAIN`, and the rest of the ~1,070
  named constants. The CSS navy backdrop used as the sky. `MOBILE_DEFAULTS`. The plain view as a second renderer.

**Sim**
- Per-cell velocity, `V_MAX`, per-element `drag`/`friction`/`jitter`/`flow`/`slide`; the coin-per-axis move.
- 240 steps/s, `settings.steps`, ~44 g gravity, tools applied per frame.
- The liquid kick stack (`FLOW_SURFACE`, `FLOW_KICK`, `FILM_*`, `DROPLET_*`, the head scan, pipe renormalisation).
- The pour stack (`PACE`/R3, `fallAge`, no drag in flight, the diagonal jet exemption, mid-air `land()`).
- Whitewater's aeration pass, out-of-place move, `moveSrc`, `gfx/foam.js`.
- Heap collide cradles, `LAND_POWDER_*`, `KE_TO_HEAT = 3`, `dens` as mass, `hard` in fictional units.
- The max-plus pressure front, per-cell pressure, `AIR_AMBIENT_PULL`, per-scene `airT`, eternal gas jitter, the cell-0
  quirk, `quietOk`.
- Content workarounds: the Campfire pre-heat, brine lakes in Snowy Depths, kit settle passes.
- Element brushes filling a random 30–35 % (`spawn`): brushes paint solid dabs, with TPT's sparse fill kept as a
  "spray" option.
- The CPU twin (dock tiles become static baked icons), the 67 MB atlas scratch, whole-grid undo.

## 8. How this answers the four pain points and the worst audit bugs

| pain point | what changes | how it's judged |
|---|---|---|
| **1. Look and materials** | Cells shown as blocks. Palette, pattern and surface class from data, so every element has an identity (gold is no longer flat beside a textured Clone, B10). One lighting function and one sky (B1), one emission function (B2), coloured transmittance (B3), no stochastic terms (B4). Phones get the same look (B11). | Side by side at fixed cameras against today (P1). Look at `side-by-side-64.png` now. |
| **2. Water and liquids** | Mass + flux with weak compressibility (B1, B2), exact rest (B3, B4), fractional levels, `holds` slopes (B9), particles for everything airborne (B5, B6, B7: no dotted pours), energy-bounded splashes, foam for every liquid (B12), air bubbles rising through liquid in the swap pass (B15). | The outcome tests in 3.1 plus shots: pour from a hole, dam break, puddle, partial layer. |
| **3. Physics feel** | One clock at real g. Ballistic particles: throws land where their velocity says (today 33–57 %, B2), and slabs stay slabs (today 21 cells thick, B3). Round, contained blasts with vacuum (B4–B6). Real masses and toughness (B7, B8). Fire by contact (B9). Repose classes instead of one square heap (§4.2). | E1–E10 from `audit-physics.md` rerun as outcome tests: throw distance within 5 %, a slab stays ≤ 2 cells thick, blast strength along the diagonal within 15 % of the axis, a sealed vessel keeps over 90 % after 10 s, a flame lights wood in under 2 s. |
| **4. Performance** | Per-cell traffic down 12–50× (5.1). The frame goes from about 18–28 ms to about 2 ms on the Mac (5.2). Change-scaled upkeep (P1–P3, P8, P11), no TAA tail (P6), brick-diff undo (P4), and a still world that sleeps (heaps, puddles, pools and gas pools all rest; today they keep 30–40 % of units awake forever). | `power.mjs` and timestamps on the Mac and the iPhone, with the budget assertions in 5.4. |

| audit | worst bugs → fix |
|---|---|
| render | B1 sky → one sky; B2 emission → one function; B3 grey transmittance → multiply-then-add; B4 lava flicker → deterministic max-plus light; B9 7 m drops → body-colour particles |
| liquids | B1/B2 no pressure → compression; B3/B4 never rest → dead band + integer mass; B5–B7 splash energy and dotted streams → particles; B8 global lockstep, B10/B11 twin and cell-0 quirk → deleted |
| physics | B1 heap sleep leak → self-reported rest + random offsets; B2/B3 → particles; B4–B6 air → TPT grid; B7/B8 → real units; B9 → contact ignition; B11 → aging diffusion; B12 radial → rest-compatible, true radial vector for particles; B13 → fixed tick |
| perf | P1 step-counter key → `vis`; P2 → scissored shadow; P3 → no fields; P4 → brick diffs; P5 → re-test 2 in flight with 3 passes; P6 → no TAA; P7 → write if changed; P9/P10 → tables + loops, per-family preludes |

## 9. Phased build plan

Each phase ships to tpt3d.codyh.xyz on its own and is judged **side by side against the live game**: same scene,
camera and time, captured by `tools/regress.mjs` extended to run two builds (SwiftShader shots in the container, final
calls on the user's Mac and iPhone), plus the numbers named for the phase.

**P0. Judge kit.**
- Builds the scene list with fixed cameras: lab, volcano, tank pour, heap, U-tube, buried charge, campfire, puddle,
  Dam Valley, World island.
- Builds two-build capture and `power.mjs` and timestamp runs on both devices.
- Rewrites every audit experiment as an outcome test that is expected to fail today.
- Ships nothing visible. It is the ruler.

**P1. The crisp look, on today's sim.**
- Builds the mesher (reading today's A buffer: id and T; liquids as full cells with averaged corners), face raster,
  palette and pattern rows for all 91 elements, AO, shadow map, light grid, one sky, puffs, AgX, bloom, MSAA, data views.
- Kills the volume march, `gfx/*` materials, fields, GI, TAA, detail tiers, `MOBILE_DEFAULTS`.
- Exit: the user prefers it on the six pairs; view ≤ 1.5 ms on the Mac; the iPhone holds 60 Hz in god view; a still
  camera draws 0 frames.
- Watch: pours are still dotted cubes (the sim's fault). If the user hates that more than today's blobs, P3 moves
  ahead of P2.

**P2. One clock and the new core.**
- Builds packed state behind `Cell`, the 60 Hz tick at real g, self-reported rest, the swap pass with random offsets
  and repose classes, particles (support loss, throws, claims), react rewritten table-driven, gases with aging
  diffusion, and liquids v0 (mass and flux without jets or foam).
- Migrates the element rows, all POV, world and tool writers, and saves (velocities dropped, liquids at mass 1).
- Exit: the heap, throw, slab, flame, U-tube, puddle and partial-layer tests pass; a settled lab certifies idle; sim
  ≤ 0.6 ms typical on the Mac.

**P3. Water.**
- Builds flux momentum (waves, dam break), jets and droplets, energy-bounded splashes, foam, `holds` slopes, smooth
  surfaces, the multiply-then-add draw, underwater fog, ripple normals.
- Exit: a hole pours one stream landing within 5 % of the √(2gh) parabola; a dam break surges and rests; the tank,
  pour and sea pairs are preferred.

**P4. Air, blasts and wind.**
- Builds the TPT air grid: blasts, vacuum, wind and cyclone through the air, breaking by pressure, drift, convection.
- Exit: diagonal blast strength within 15 % of the axis; a sealed vessel keeps over 90 % after 10 s; craters with
  ejecta rims on the buried-charge pair.

**P5. World, POV and multiplayer.**
- Builds far-field LOD chunks (retiring `far.js`), window shifts that re-mesh only the entering slab, POV body and
  buoyancy on mass, physgun and kick as particles, codec v2 with GPU brick diffs, undo as brick diffs.
- Exit: the World island draws less power per frame than today on the Mac; the iPhone holds 60 Hz walking the island.

**P6. Ship and tune.**
- Optional fast paths behind feature checks: `shader-f16`, `rg11b10ufloat` targets, transient MSAA attachments,
  `fragment_depth`. Optional Mac refraction.
- A palette and pattern art pass with the user, a 30-minute iPhone thermal soak, CI budgets on.

The look ships first because the user sees it every second and it doesn't depend on the sim. Water gets its own phase
because it is the biggest feel win and the riskiest model. Air comes after the core because blasts only read well once
particles exist.

## 10. Risks

1. **"Blocky" may not be what the user wants.** That is this pitch's bet. P1 runs on today's sim, so it is cheap to
   judge on side-by-side pairs before anything else is torn out. Palettes and patterns are art, iterated with the user.
2. **Face counts in pathological scenes** (a sand storm, 100K scattered grains) bloat the tiler's parameter buffer.
   Mitigations: chunk×direction culling, per-chunk face caps that merge 2³ cells into one cube at a distance, the
   particle cap, and the workgroups-per-change budget test.
3. **Particle and grid handoff.** Claim storms, retrying losers, and landings in cells written the same tick.
   Mitigations: a fixed pass order, a deterministic min-key claim, back-pressure at the cap (cells wait a tick), and a
   mass census after every tick in sim-check.
4. **Weak compressibility.** Deep shafts compress visibly (27 % at 120 cells), and the dead band could ring.
   Mitigations: 2–4 substeps as a setting; the U-tube, dam-break and rest tests from P0.
5. **Coarse air leaks through 1-cell walls** that don't span a brick face, as TPT's `CELL = 4` air does. Document
   2-cell pressure walls; if it bites, a 2-cell air grid costs 8× and is still small (262K cells).
6. **Real time can feel slow in god view** after a world that ran 6.6× fast. The Sim speed setting shows its cost,
   and the default can differ per mode (2× in box mode, 1× in POV) without a second clock.
7. **three.js meshes with our MSAA pass.** The composite covers opaque meshes; transparent ones (the constructions
   ghost) draw after, unsorted against water. Accept it, or move them into our pass.
8. **Safari.** Transient attachments may not exist (MSAA then costs ~30 MB more on the iPhone), and one frame in
   flight serialises CPU and GPU. Measure in P1; MSAA 2× is the phone fallback.
9. **Multiplayer.** Particles in flight aren't in brick diffs. Stream seeded emission events and let clients
   integrate them; only claims are host-authoritative.
10. **Scope.** The sim rules, renderer and tables are rewritten. The foundation, shell, edits, sleeping machinery and
    world generator stay, the `Cell` API isolates ~40 kernels, and every phase ships.
11. **Max-plus light isn't bounce.** Colour bleeding is lost, deliberately: it is Minecraft's legible look. A
    one-bounce injection (sunlit faces seeding weak block light in their albedo) is a P6 option.

## 11. Evidence (all under `v2/crisp/`)

- `faces.mjs` → `faces.txt`: exposed faces per class, surface bricks, faces facing the god-view camera and a 16³-chunk
  direction cull for the lab, the volcano (128³) and Dam Valley, built on the CPU by `presets.js` as the app builds them.
- `export.mjs` dumps the presets (128³ and 64³). `mock.py` is a numpy voxel tracer of section 2.4's shading model:
  stepped palette, hashed 8×8 pattern, 3-neighbour corner AO, a convex-edge rim, sun shadow with coloured
  transmittance, max-plus block and sky light on a 2-cell grid with `f/(4−3f)`, one sky, fog, Beer–Lambert liquids with
  in-scatter, Fresnel, bloom, AgX.
- `shots/side-by-side-64.png` (today's audit shots against the mock at 64³) and `shots/mock-128-montage.png`
  (128³ views, including the summit lava and the wood tower up close).
- Caveats: the mock traces rays on the CPU where v2 rasterises, with a sun DDA instead of a shadow map (same model,
  different cost); 2×2 supersampling stands in for MSAA; patterns are hashed noise, not art; the ground and backdrop
  aren't art-directed; liquids are whole cells; water extinction is doubled as the stylised floor; there are no gases
  or particles.
