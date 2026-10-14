# Judge 0: player experience

Lens: a demanding player and game designer who loves Noita, The Powder Toy, Minecraft and Teardown. I'm judging what
each v2 pitch would be like to *play* in a browser on a MacBook Pro and an iPhone 17 Pro Max. That covers how it
looks still and in motion, how legible and emergent the sandbox is, and whether it fixes the user's four complaints:
look, liquids, physics feel and performance per watt. Engineering elegance counts only where a player would notice
it.

Inputs: the three pitches, the four audits, today's shots (`evidence/`, `shots-64/`), each pitch's evidence (`crisp/`,
`fid/`, `lean/`), and two checks of my own:
- **I reran lean's CPU prototype** (`lean/lean-sim.mjs slab utube partial heap`). It reproduces the logged numbers exactly:
  - the slab stays 1 cell thick on the ideal fall curve;
  - the U-tube ends 12.35 / 12.28 and is idle at tick 384;
  - the partial layer is flat to 0.02 and idle at tick 256;
  - the sand heap has a diagonal/axis ratio of 1.02 and is idle 1.55 s after the pour.
- **I put the three looks side by side** on the same cameras: `v2/judge0/compare-looks.png` (today | crisp mock | fidelity
  prototype; volcano god view, flank at 64³ and 128³, lab tank).

---

## 0. Verdict

| pitch | look | feel | perf/W | simplicity | risk/effort (10 = safe) | fixes pain points |
|---|---|---|---|---|---|---|
| **CRISP** (raster blocks, MSAA, Minecraft light, TPT rules) | 7 | 8 | 8 | 7 | 6 | **8** |
| **FIDELITY** (traced voxels, radiance cache, Teardown lineage) | 8 | 7 | 5 | 4 | 3 | 7 |
| **LEAN** (budgets as law, raster + TAAU, gases off the grid) | 6 | 6.5 | 9 | 8 | 7 | 7.5 |

**Recommendation: CRISP as the base, rebuilt with LEAN's discipline and three of its mechanisms, plus four ideas from
FIDELITY** (section 5). In one sentence: blocks you can read, a frame that is final the moment it is drawn, gas and
fire as cells you can paint, and the per-watt engineering and the proven liquid/heap prototype from lean.

The good news first: **the three pitches agree on almost all of the simulation.** They share:
- liquids as fill plus face flux, weakly compressible;
- ballistic particles for anything flying (Noita);
- one fixed 60 Hz clock;
- rest reported by the rules themselves;
- a coarse TPT air grid;
- real units with declared game multipliers;
- contact ignition;
- repose classes;
- brick-diff undo.

Every audit's top bugs die under any of them, so the sim direction is settled. The real choices are the renderer and
five forks inside the sim. My call on each fork is in section 4.

---

## 1. CRISP: "every cell is a block you can read"

**What it would be like to play.**
- **God view on the Mac.** You paint sand and see sand blocks, each cell a slightly different tone (TPT's per-particle
  jitter). Every crease has corner AO and every tower casts a sharp sun shadow. The frame is final when drawn: no TAA
  smear, no 109-frame shimmer settle, nothing crawling when you stop. Moving the brush costs one scene pass.
- **Data views.** Heat, pressure, flow and X-ray are kept as cheap variants of the same face shader. That is TPT's
  identity, and I'd use them constantly.
- **First person.** At 50 px per cell you get 16×16 nearest-filtered pixel art with Minecraft smooth lighting. It is
  the most readable look of the three and the one a Minecraft or Noita player instantly understands.
- **iPhone.** The same picture at 1.5× CSS with 4× MSAA: the sharpest phone image of the three pitches.

**What I'd enjoy.**
- Legibility. In the god view you can tell sand from salt from gunpowder by palette alone, and you can count a heap's
  steps.
- **Gases and FIRE stay cells.** Hydrogen pockets, caustic gas, steam and plasma keep their TPT and Noita play, and
  with aging diffusion they finally rest.
- Real-unit breaking: a gold nugget no longer punches through steel.
- The lava block in `crisp/shots/volcano-summit.png` reads instantly as hot: a glowing crack pattern plus block light.

**What I wouldn't.**
- **The light grid is 2 cells (60 cm).** The lab tank's glass, Descent's corridors and every player-built 1-cell wall
  sit inside one light texel. The result is either leaks or wrongly dark air beside walls. Lean is right that light
  needs one value per cell.
- **Every unsupported non-solid cell becomes a particle.** Painting sand in mid-air, the commonest act in a
  falling-sand game, turns every dab into particles. A collapsing cliff is a claim storm against a 64K cap, and the
  pitch's own mitigation ("cells wait a tick") means sand visibly hanging in the air.
- **Liquid particles are ½-cell cubes.** A pour is a stream of little cubes; it reads as voxels, not water. The pitch
  admits that in P1 pours are "still dotted cubes".
- **Gases are camera-facing puffs inside one MSAA pass**, which cannot read depth. Smoke filling a room will show hard
  lines where puffs cut through walls and floors. Smoke plumes are a centrepiece of fire and explosion play, so this
  is the cheapest-looking part of the pitch.
- **Water absorption uses a run length baked into each face.** A swimmer near the surface gets the tint of the
  floor's depth, not their own.
- **Real g.** A god view of a 38 m site at 1 g reads as slow motion after today's 6.6× world. The pitch knows this
  (risk 6), but its fix, Sim speed 2×, doubles the sim cost.
- **The mock is bland.** It shows a grey floor and default palettes, and 3×3 green blocks for trees. "Minecraft
  clone" is a live risk, and only art direction decides it.

**Pain points.**
- **Look:** fixed in kind (B1–B4, B11 by construction), but its quality depends on art.
- **Liquids:** fixed in model, weakest liquid look of the three.
- **Physics:** fixed.
- **Performance:** about 2 ms on the Mac and 4 ms on the iPhone, a still world costs nothing, and no TAA tail.

## 2. FIDELITY: Teardown lineage

**What it would be like to play.**
- **Mac, best case:** the most beautiful of the three. You get traced hard sun shadows and a per-face radiance cache
  (sky, bounce, emitters), so lava lights a cave orange and a pool in a cave mirrors the cave. Water refracts with
  Fresnel and TIR. Pours are screen-space fluid ropes, and smoke is volumetric and lit from inside. The `leaf` shape
  family makes canopies you can see through with dappled shadows, and it is lovely (third column of
  `compare-looks.png`).
- **iPhone:** about 250K internal pixels (0.6× CSS) upscaled by TAAU, with a cache that updates 1/16 of pixels a
  frame. The phone gets a soft image whose light catches up with the action slowly.

**What I'd enjoy.**
- Water: the only pitch whose pours would look like liquid rather than voxels in flight.
- **Teardown-style immediate cell damage** inside a blast radius, with walls shielding by line of sight, plus air
  slowed to about 50 m/s so a shock visibly crosses the box in 0.7 s. That is the best blast design in the three
  pitches; the other two would make brick-quantised (1.2 m) craters from small charges.
- One law for a kicked clump, debris and a bullet. Flyers interpolated between ticks, so 120 Hz ProMotion is smooth.
  Flyers cast shadows.

**What I wouldn't.**
- **A falling-sand world changes every frame, and caches lag.** A changed brick resets its light, which reconverges in
  about 10 frames, more on the phone. Burning forests and explosions are exactly when the light is wrong.
- **TAA has to drop history wherever voxels teleported**, which in this game is everywhere sand is moving. Moving
  matter goes un-antialiased and sparkly, the opposite of crisp's "final when drawn".
- **The micro-shaper evidence looks worse, not better.** At 128³ the flank is salt-and-pepper gravel
  (`fid/shots/volcano-flank-all.png`), noisier than cells-only. The pitch admits the carve rates are guesses.
- **Step-corner ramps are render-only.** What you see is up to 7.5 cm away from what you collide with. For a sandbox,
  honesty about the cell is part of legibility.
- **Cold start.** The prototype megakernel built in 20–376 s on SwiftShader. Safari compiling a big tracer is a
  first-load stall the player feels.
- **Performance per watt.** Per-pixel tracing every frame the camera moves is the least efficient way to draw blocks on a
  TBDR GPU, and the phone go/no-go isn't measured yet. On the user's own top priority it scores lowest.

**Pain points.**
- **Look:** highest ceiling, but unproven where it counts (the cache in motion, the phone).
- **Liquids:** best look.
- **Physics:** same as crisp, plus better blasts.
- **Performance:** weakest, and riskiest on the iPhone.

## 3. LEAN: "do less, do it once"

**What it would be like to play.**
- **Mac at 120 Hz:** about 1.3 ms a frame, crisp-family blocks and lighting at 2/3 resolution per axis, brought to
  output by TAAU.
- **iPhone:** about 2.8 ms, with a runtime governor holding 60 Hz and never throttling. It is the only pitch that
  treats the phone as the reference and enforces it.
- **"Crunch mode"** (Cruelty Squad, 1/3 resolution, nearest-neighbour upscale) is a delightful, on-brand toggle and
  the cheapest phone mode.

**What I'd enjoy.**
- **It has evidence.** It is the only pitch that ran its rules, and the numbers reproduce:
  - slabs stay slabs;
  - heaps are round and come in different angles per material (sand 0.89, flour 1.79 rise per run), then sleep 1.5–2.7 s
    after the pour;
  - the U-tube levels within 2 cm;
  - a partial layer goes flat;
  - a puddle rests;
  - a hole pours one parabolic arc.

  Those are the experiments every player tries first.
- **Column fall:** vertical runs move as runs, a slab stays a slab, and no particles are spent on a brush dab.
- **The dead band and Bingham yield are one knob:** slime and lava hold slopes with no second mechanism.
- **The vertex shader reads the cell,** so a changing water level or glow costs no remesh.
- **The light grid is per cell,** so nothing leaks through 1-cell walls.
- **Reactions see 3 in-block partners**, not 1 (today's 1/6 cap), so chemistry gets livelier.
- **TF2's 2 g** for everything, POV included: snappier at no tick cost.

**What I wouldn't.**
- **Gases are not cells.** The 11 gas elements become 5 species on a 1.2 m air grid:
  - CAUSTIC_GAS (Noita's toxic gas), MERCURY_VAPOR, PLASMA and CLOUD lose their identity, and FIRE becomes a sprite;
  - a 1-cell hydrogen line becomes a smudge in a 4³ brick, and a 3-cell glass gas tank leaks through the coarse grid;
  - one fuel "kind" byte per air cell means two fuel gases can't share a cell.

  For a TPT and Noita player that is the heart of the emergent chemistry, cut to save bytes.
- **TAAU at about 44 % of the pixels** in a game of constant motion. Falling sand gets motion vectors, but waves,
  fire and flowing liquid tops don't, so they smear. Crisp's MSAA is sharper and has no settling.
- **X-ray, radial gravity and loop edges are cut.** The cutaway plane is a good idea, but in a 3D sandbox I want both.
- **Liquid particles are "small discs after TAAU",** better than cubes but not a stream.

**Pain points.**
- **Performance:** best.
- **Liquids:** best evidence; good look, with refraction and a per-pixel absorption walk.
- **Physics:** fixed, minus the gas cuts.
- **Look:** the same family as crisp, but softer.

---

## 4. The forks, and my call as a player

| fork | options | my call | why a player cares |
|---|---|---|---|
| draw the world | raster faces (crisp, lean) vs per-pixel trace (fidelity) | **raster** | cheapest on Apple TBDR; immediate; no cache lag; small shaders, so no first-load stall |
| anti-aliasing | MSAA 4× at full res (crisp) vs TAAU at 2/3 (lean) vs TAA + cache (fid) | **MSAA 4×**, crunch mode as a style option | in a world that moves every frame, "final when drawn" beats "converges in 8 frames"; blocks and pixel art want crisp edges; alpha-to-coverage gives leaves soft edges for free |
| light resolution | 2-cell (crisp) vs per cell (lean) | **per cell** | 1-cell walls are everywhere players build |
| falling matter | every unsupported cell a particle (crisp, fid) vs column fall plus lateral particles (lean) | **column fall + particles for lateral motion** | painting in the air and cliff collapses are the common case; no claim storms, no sand hanging mid-air |
| gases | cells (crisp, fid) vs 5 species on the air grid (lean) | **cells**, with aging diffusion so they rest | TPT and Noita chemistry lives in gas cells |
| gas look | puffs (crisp) vs 1/4-res march (lean) vs full volumetric (fid) | **1/4-res march over a per-cell gas density texture**, composited with depth | puffs cut through walls with hard lines; smoke is the showpiece of fire play |
| fire look | FIRE cells as additive puffs (crisp) vs flame sprites on burning faces (lean) | **both**: FIRE stays a paintable cell; burning faces also spawn flipbook flames (Halo 3, TF2) | fire is matter you can paint *and* it should look like flame |
| liquid in the air | ½-cell cubes (crisp) vs discs (lean) vs screen-space fluid (fid) | **velocity-stretched round droplets first; screen-space fluid as the P3 upgrade if it fits the phone** | a pour must read as water, not as voxels in flight |
| gravity | 1 g plus a Sim speed setting (crisp, fid) vs TF2's 2 g (lean) | **start at 2 g, keep Sim speed**, decide on the motion shot list | snappier at no tick cost; note that terminal speed (lean's 12 m/s for sand), not g, sets the pace of a long fall in god view |
| blasts | coarse air only (crisp, lean) vs air plus immediate radial damage (fid) | **fid** | otherwise small charges dig 1.2 m cubic craters |

---

## 5. Recommended hybrid: CRISP base + grafts

**Base (keep from CRISP):**
- raster face slabs per chunk, 4× MSAA in tile memory, no TAA, and 0 submits when nothing changed;
- one material row per element: palette, 16×16 RGBA pixel-art pattern with sparkle and emissive masks, surface class,
  `emit`, extinction;
- one light function: sun shadow map with hardware PCF, max-plus sky and block light, mesher corner AO, one sky
  drawn and lit with, and `f/(4−3f)`;
- the multiply-then-add coloured transmittance;
- gases and FIRE as cells;
- the TPT data views (heat, pressure, flow, X-ray);
- mass-plus-flux liquids with `holds` slopes;
- the swap pass with random per-axis Margolus offsets;
- self-reported rest;
- the TPT air grid;
- SI rows;
- the phased plan judged side by side.

**Graft from LEAN:**
1. **Budgets as law.** Make the iPhone the reference device and add a runtime resolution governor, per-tick caps and
   time dilation. Enforce ≤ 30 pipelines and ≤ 300–400 KB of WGSL in CI.
2. **4-byte faces in per-brick pages, with the vertex shader reading the cell.** Then liquid level, temperature and
   glow changes cost no remesh; crisp re-meshes 16³ chunks on glow-band crossings and level changes. Only occupancy
   changes remesh.
3. **A per-cell light grid** (rgba8, 8 MB) with lean's 26-neighbour weighted max for rounder pools of light. It
   replaces crisp's 2-cell grid.
4. **Column fall** for vertical runs of powders and debris. Particles carry only lateral or ballistic motion: throws,
   blasts, jets, splashes, wind lift.
5. **The prototype as the tuning bench.** Port `lean-sim.mjs`'s tests to the GPU harness in P0, and use the
   dead-band-is-yield unification.
6. **A per-column liquid-top map** (128², written by the mesher). It tints sunlight under water without a translucent
   shadow pass, and lets the three.js mesh composite tint a swimmer by their own depth below the surface. That fixes
   crisp's baked-run-length error for bodies in water.
7. **A quarter-resolution gas march with a depth-aware composite.** To get depth out of the MSAA pass, write linear
   depth to a second colour attachment.
8. **Flame sprites** on burning exposed faces, alongside FIRE cells.
9. **Crunch mode** (Cruelty Squad): 1/3 resolution, nearest-neighbour, no AA.
10. **A cutaway clip plane** as a sixth view, alongside X-ray.
11. **Reactions over all 3 in-block partners per tick, and integer heat quanta with a dead band.** Hot matter cools
    and then sleeps exactly.
12. **2 g (TF2) as the starting world gravity**, one constant for the grid, particles and the player.
13. **Window shift by copy**, since the state is about 5× smaller: no toroidal complexity.

**Graft from FIDELITY:**
1. **Teardown-style immediate cell damage** inside a blast radius, with walls shielding by line of sight, so small
   charges make crisp craters. The air grid carries the shock, slowed to about 50 m/s so it visibly crosses the box
   (and reads in the pressure view).
2. **Particles interpolated between ticks**, for 120 Hz ProMotion presentation, and **particles cast shadows**: a
   falling slab's or ejecta's shadow is how you read 3D motion from the god view.
3. **The `leaf` idea as alpha-cutout foliage patterns** with alpha-to-coverage. Canopies let light through and cast
   dappled shadows, so trees stop being 3×3 green cubes.
4. **Weathering by facing.** Sky-facing faces of crag rock read paler: one term in the material function, and terrain
   reads as terrain.
5. **Screen-space fluid for airborne liquid** (depth and thickness splats, narrow-range filter) as a P3 option, gated
   on the phone budget.
6. **Process ideas:**
   - an `?engine=v1` switch kept until the next phase lands;
   - a timestamp go/no-go on the actual iPhone in week 1 of the renderer phase;
   - flyer ids from (spawn cell, tick, rule), never buffer slots, for multiplayer.

**Not taken:**
- the radiance cache, the per-pixel tracer, and render-only step ramps (fidelity);
- gases as species, cutting FIRE, X-ray and radial gravity, and TAAU as the default AA (lean).

## 6. What I'd require before calling any phase "better" (player acceptance)

1. **Action shots, not still lifes.** Not one of the three pitches showed smoke, fire, an explosion, or water in
   motion; every image is a still diorama. The P0 shot list must include:
   - a burning forest;
   - a smoke-filled room;
   - a buried charge mid-blast;
   - a dam break;
   - a pour from a hole;
   - a sand avalanche;
   - lava meeting water;
   - a POV swim.

   Each needs 5 s captures on the user's MacBook and iPhone, side by side with today.
2. **Look gate before tearing out the sim.** Run P1 behind `?engine=v2` for the user's look review, but make the
   *first default-on* release P1 plus the new core and liquids v0. Don't show the user today's beaded liquids redrawn
   as cubes; the user's first impression of v2 should be the new water.
3. **An art pass is a deliverable, not a P6 afterthought.** The sky, the ground plane, 91 palettes and about 16
   patterns, picked by the user on a sheet. Both mocks currently stand on a grey void floor, which reads as "default
   engine".
4. **Compression must be invisible to the player.** The hidden mass at depth differs a lot between the pitches:
   fidelity about 3 % at 30 cells deep, crisp ≤ 7 %, lean about 12 %. A bucket or POV tool that scoops a compressed
   cell must take *mass*, not a cell, or deep lakes duplicate water. Pick the stiffest stable setting
   (fidelity's ε = g_c, or 4 substeps).
5. **The four outcome tests a player tries in the first minute must pass on the GPU:**
   - a U-tube levels;
   - a spill becomes a puddle and stops;
   - a heap has an angle and sleeps;
   - a flame lights wood.

   Also: a settled world certifies idle, so the fan stops.
