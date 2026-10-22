# Audit: physics feel (everything but liquids)

Scope: the Margolus move with per-cell velocity (`src/shaders/move.js`), the react pass (`src/shaders/react.js`: heat,
pressure, forces, breaking, explosives, reactions, phase changes, electricity hook), the element table
(`src/elements.js`), the constants (`src/physics.js`), the rest/sleep rules (`src/shaders/common.js` inertSelf,
`src/shaders/activity.js` inertNear, `docs/scaling.md` D2, `docs/webgpu.md` D5), the simulation modes
(`src/simModes.js`) and the brush tools (`src/shaders/passes.js` paintUpdateWGSL, `src/editing.js`).
Liquids are `audit-liquids.md`'s; they appear here only where a rule is shared.

Tree: branch `claude/webgpu-port` @ 42f4039, read only. Line numbers are that commit's.

Evidence comes from three places:
- **GPU runs**, 3D, 32³, in the sim-check harness page on SwiftShader WebGPU, from a private copy of the tree
  (`scratchpad/v2/phys/tree`). They use the loop form of the move (`form: 'loop'`), which sim-check's moves stage
  asserts gives the same state as the shipping unrolled form, and `debug: false`. Script: `phys/exp.mjs`; raw output:
  `phys/exp.out.json`, `phys/exp-noheat.out.json`. One control ran on a copy with `KE_TO_HEAT: 0`
  (`phys/tree-noheat`, `phys/exp-noheat.mjs`).
- **Arithmetic on the tables** (`phys/tables.mjs`): terminal speeds, fall energies and what they break.
- **The code and main's history** (the repo is shallow from 2026-10-08; `docs/elements.md` "Follow-ups" is the team's
  own open-bug list).

---

## 0. Verdict

The foundation under the physics is good and should stay: exact mass conservation (a block is only ever permuted),
deterministic hashed randomness that doesn't depend on dispatch order, race-free pair rules, energy-conserving
conduction, and an exact sleeping contract. The physics on top of it is a stack of local patches on a per-cell
velocity that the cellular automaton can't actually carry out. There are four structural problems, and each one
shows up as "feel".

1. **Velocity isn't motion.** A cell moves one cell along an axis with probability |v|, only inside its 2×2×2 block,
   only on the steps when the block's parity puts the neighbour in its block, and at most once per step. Measured:
   - a 1-cell slab of sand dropped from y = 28 is smeared over **21 cells** after 60 steps, and its centre has fallen
     **65 %** as far as its own velocity integrates to;
   - a grain thrown sideways at 0.5 cells/step lands **57 %** as far as its velocity says (scrap: **33 %**), anywhere
     from 3 to 11 cells out.

   Liquids got a separate fix for this (R3 pacing, `move.js:130-170`); powders, gases and debris didn't
   ("its rules were tuned to them", `move.js:142-143`). The grid also runs on its own clock, ~44 g in real time,
   capped at 1 cell/step (72 m/s). So the first-person code flies bullets, kicked sand and rockets outside the
   grid at a real 1 g (`pov/ballistics.js:11-18`, commit 1b68d53).
2. **Air pressure isn't air.** Each cell takes the larger of its own diffused pressure and 0.88× its strongest
   neighbour's, then everything decays 3 % a step (`react.js:439`). That is a max-plus "influence" field, not a
   gas. It has four consequences:
   - blasts are octahedra: at 8-12 cells they are **3-4× weaker** along a body diagonal than along an axis, and
     arrive 1.7× later;
   - a one-cell blast of 60 becomes **680× as much pressure** summed over the box;
   - a vacuum is erased in one step;
   - a sealed box loses **95 % of its pressure in 100 steps**.

   And one blast keeps **every brick of the 32³ box awake** from step 29 to step 260; the box is idle only at step 300.
3. **Real-world numbers feed rules that the cellular automaton's artefacts decide.** The element rows cite CRC,
   ASHRAE and Eckhoff, but the outcomes come from the automaton:
   - every powder settles into the same square, terraced heap whatever its `slide` (sand 0.9 and dust 0.3 give the
     same 6-high heap);
   - terminal speed is a per-element `drag` pick (dust 0.14, sand 0.6, scrap 1.0 cells/step), and liquids skip drag,
     so water falls 1.7× faster than sand;
   - `dens` is used as a mass, so **24 gold nuggets dropped 6 m punch clean through a steel plate**;
   - impact heat is 25× its literal value;
   - fire is purely thermal: **two 1000 °C flames against a wooden block don't light it**, which is why the Campfire
     construction pre-heats its logs to 450 °C.
4. **Sleep leaks where the rest test and the move disagree.**
   - The rest test assumes a grain can topple into any of its 8 lower neighbours. The 2×2×2 move can only ever reach
     3 of them from a given cell (one quadrant, fixed by the cell's coordinate parities). So **a settled sand heap
     with every velocity exactly 0 keeps 159-172 of 512 sleeping units awake forever**. This is not the impact heat:
     with `KE_TO_HEAT = 0` it is the same. The impact heat is a second, independent blocker: the heap lands ~2 °C
     warm and is still over AIR_REST_T after 1,500 steps.
   - One grain beside an overhang keeps 48 units awake forever.
   - No gas ever rests.
   - Radial gravity and void or loop edges switch sleeping off altogether.

   Content has been bent around these. One example: per-scene ambient air and brine lakes so that Descent rests
   (commits 22692b4, 1def559).

**Recommendation:** keep the engine contract (exact mass, determinism, exact sleep, data-driven elements), and
replace the motion and air models rather than tune them further. Section 9 has a concrete shape:
- settled matter stays in the cellular automaton, and airborne matter becomes ballistic particles, as in Noita;
- a coarse compressible air grid with real containment and vacuum, as in TPT's air map but conservative;
- one clock for everything;
- rest tests derived from the same predicate the move uses;
- fire and heat by energy, not by thresholds multiplied in °C.

---

## 1. How the non-liquid physics works today

| Stage | Where | What it does |
|---|---|---|
| Velocity | `react.js:454-638` | gravity `v.y -= g·GRAV` (480); pressure push `v -= ∇P·P_ACCEL/ρ` (459); normal force `held` (496-498); drag `v *= 1-DRAG` for everything but falling liquid (503-504); friction on grains resting on solid or powder (506-511); gas jitter (623-628); `dvBreak` (629); clamp to ±V_MAX = 1 (630); snap below REST_V (635) |
| Move | `move.js:279-430` | 2×2×2 Margolus block at offset `frame & 1`. Vertical exchange: swap with probability `|v_y|·dragF` (301-302). Collide: momentum exchange above COLLIDE_V 0.15 with restitution 0.3, else cancel (242-258). Land: grains keep 0.3 of sideways v and get a random kick of 0.12·impact speed (751-756). Diagonal topple: only for a "stopped" top cell, with probability SLIDE, into one of the 3 other bottom cells of its block (323-352). Horizontal exchange: only between cells neither of which moved this step (356). Bounce or stop at solids (370-378). Impact heat (261-267) |
| Breaking | `react.js:293-330` | `½ρv_n² ≥ hard` breaks a solid into `breakInto`, costs the projectile `hard`; or the pressure difference across it exceeds `5·hard` |
| Explosives | `react.js:332-362`, `895-914` | the shock KE between closing cells, `crushP`, ignite/hot touch, a flame with chance `blast.flame`; going off sets `P += blast.P` and turns the cell into FIRE at `blast.T` |
| Pressure | `react.js:423-452` | `P' = max(P + 0.12·∇²P, 0.88·max_n P_n)·0.97`; solids reflect; clamp −50…200 |
| Heat | `react.js:412-421` | per face, `min(cond)·ΔT` clamped to `|ΔT|·min(cap)/6` (exactly conservative); then air relaxes to ambient 0.2 %/step and gases by their `rad` |
| Burning | `react.js:747-777`, `915-927` | fuel at ≥ `ignite` touching air burns down `life`, heats itself toward `flameT`, adds `BURN_P`; air beside a burning cell becomes FIRE with chance 0.25 per burning neighbour; FIRE is a buoyant gas living 12-50 steps |
| Phase changes | `react.js:707-746`, `838-876` | water, ice, steam and cloud by hand; the rest from the table, with latent heat banked in `life` or as a chance |
| Reactions | `react.js:364-410` | one partner per step along axis `frame % 3`, both sides evaluating one predicate on one stream |
| Electricity | `electricity.js`, `react.js:641` | TPT's spark automaton in `ctype` |
| Rest flags | `common.js:648-690` inertSelf, `activity.js:99-184` inertNear | a cell is inert if nothing about it can change; a brick is quiet if all 27 bricks around it are inert |
| Tools | `passes.js:156-220` | spawn at density `spawn·rate`, ±30 °C, +6 pressure, wind and cyclone push, gravity wells, mix, property |
| Modes | `simModes.js`, `move.js:73-78`, `react.js:465-488` | radial gravity by rotating each block to its dominant axis; void and loop edges; air modes; ambient heat |

---

## 2. Experiments (GPU, 3D, 32³)

| # | Test | Setup | Result |
|---|---|---|---|
| E1 | **Throw** | 10 sand grains, each in its own z column, at (2, 26) with v = (0.5, 0, 0) | ideal (the react pass's own velocity integrated): lands at x = 13.7 after 66 steps. Measured: **x = 5…13, mean 8.7 (57 % of the travel)**, after **72…104 steps, mean 89**. Thrown up-and-out (0.5, 0.5) from y = 12: ideal travel 11.5, apex 15.6; measured travel **3…9 (mean 45 %)**, apex 13-16. Scrap (drag 0.01): ideal travel 19.8; measured **2…12, mean 33 %** |
| E2 | **Falling slab** | a 24×1×24 layer at y = 28 | sand at step 60: centre fallen **14.6 cells, ideal 22.3 (65 %)**; the layer spans **y = 3…24 (21 cells)**. Stone (dens 26) is bit-identical to sand (dens 16). Uranium at step 40: 11.8 vs 17.1 (69 %), 18 cells thick. Dust: 4.0 vs 7.6 |
| E3 | **Heap** | 432 grains (6×12×6) dropped onto the floor; sand (slide 0.9) vs dust (slide 0.3) | both: peak **6**, footprint **152 vs 157 cells**, the same **square, terraced** plan (maps below). Slide changes only the settling time (150 vs 450 steps). **Neither sleeps**: 0 grains moving from step 150/450 to 1200, but **172 (sand) / 159 (dust) of 512 units awake** to the end |
| E3b | **The heap's impact heat** | E3 (sand), temperatures | the heap lands warm: mean 21.8 °C, max 22.4 at step 200; **every one of the 432 grains is still > 1 °C over ambient at step 1500** (mean 21.2), so their air faces fail AIR_REST_T for thousands of steps. 151-172 air cells > 1 °C over ambient at steps 200-600 |
| E3c | **Why the heap is awake** | E3 at step 400; every non-inert brick's cells, against the move's rule | 15 bricks not inert, holding 43 non-inert cells. In all of them the only reason is a grain with an **empty lower-ring cell whose path is empty too, in a direction the 2×2×2 block can never reach from that cell** (B1). Same with `KE_TO_HEAT = 0` (sand at exactly 20 °C, 159 units awake) |
| E4 | **Blast** | one air cell at P = 60 in a still 32³ box | front arrives at each cell at its **L1** distance, peak `60·0.8536^L1`: axis 4/8/12 → 31.9/16.9/9.0; body diagonal at L2 8.66 → **5.6, at step 15**; at L2 12.1 → **2.2, at step 21**. Every brick awake from step 29 to 260; idle at **step 300** |
| E4b | **Buried charge** | 3×3×3 gunpowder at 250 °C under 8 cells of a 20-deep sand bed | the heave at step 15 is a **diamond** in plan (map below); by step 300 the crater is 2-3 cells deep and the thrown sand lies as **single grains scattered over the whole 32×32 bed**; 510 of 512 units still awake at step 300 |
| E4c | **Pressure bookkeeping** | as E4; and a one-cell vacuum of −40 | ΣP over the box: 60 → 324 (step 1) → 3,358 (4) → 12,280 (8) → **40,839 (24)**, then falling as P_DECAY wins; every cell > REST_P by step 48. The vacuum: −40 → **0 at step 1** (ΣP 0) |
| E5 | **Sealed vessel** | a 10³ air space inside 1-cell WALL, P = 100 and 200 °C | P: 100 → 73.7 (10 steps) → 21.8 (50) → **4.8 (100)** → 0.001 (400); nothing outside the box ever exceeds 0. T: 200 → **75 °C after 100 steps**, 27 °C after 400 (the insulated box's air is pulled to ambient and soaks into the walls) |
| E6 | **Falling grains on a plate** | 24 grains (2×2×6) from y = 24-29 onto a 1-cell floor at y = 3 | **gold nuggets and uranium go through a steel (METAL, hard 60) plate**: 17-18 of its cells broken, 23-24 grains below it. Scrap goes through glass (18 broken) and wood (17), not steel. Sand and stone break nothing (stone's count of 1 is the neighbouring scrap column's damage inside its count window) |
| E6b | **Drips** | two water cells falling 26 cells onto lamp, wall torch, ember, glass | **2 cells broken each of LAMP, WALL_TORCH and EMBER**; glass 0 |
| E7 | **Flame against wood** | 6³ WOOD block; two FIRE cells at 1000 °C touching one corner | **no ignition**: the wood's hottest cell reached 39 °C, the flames were smoke by step 100, nothing burnt by step 400 |
| E7b | **Pre-heated edge** | a 4³ WOOD block in a 16×24×16 box, one edge column at 450 °C (as `builtins.js:317` lights the Campfire) | **all-or-nothing**: by step 200 every one of the 64 cells is past 300 °C and 52 are burning, at 900 °C. Up to **865 smoke cells** (14 % of the box) from 64 cells of wood (flames are made from air cells). Burnt down to 4 cells by step 1400; those 4, buried under 28 cells of ash, stop burning and cool. The whole box (96 of 96 units) is awake through step 2000 |
| E8 | **Grain on a ledge** | one sand grain on a wall ledge, its only empty lower neighbour behind a wall overhang | **48 of 512 units awake through step 800**; the control (hole filled) is idle by step 50 |
| E9 | **Radial gravity** | 1,284 grains scattered through the box, 600 steps | settles into a **cube** (the y = 16 slice is a 12×12 square; outermost grain 6.8 cells out along an axis, 8.4 along diagonals); every unit awake (sleeping is off in this mode) |
| E10 | **Pool of CO₂** | a walled 14×14 basin, 3 layers of CO₂ (588 cells) | it stays put: all 588 cells in the bottom 3 layers at steps 100-1000 (stratification works). But **147 of 512 units awake at every checkpoint through step 1000**: a still pool never sleeps |

The heap of E3 (height in cells, seen from above; sand left, dust right). Note the square plan and the terraces:
```
......111222111111......        ......111222111211......
......122333233221......        ......122333222221......
......123344344332......        .....1223344433321.1....
......133445544331......        ......1334455443321.....
......134455445432......        ....1.2344556654221.....
....11234555555432......        .....1234565655432......
......234455555432......        ......234555555432......
......2245565444321.....        .....1233445544432......
.....12334455443211.....        .....1223444543321......
......223344443321......        ......123344443321......
......123333332221......        ......122233333221......
......111122222211......        ......111121222111......
```
E4b, the buried charge 15 steps after it goes off: sand heaved above the bed (`+`), a diamond in plan, the
pressure front's L1 shape:
```
...............++...............
..............++++..............
.............++++++.............
............+++++++.............
...........+++++++++++..........
..........+..++++.++++..........
...........+.++++++++++.........
..........++.+++.+++++..........
............+++++++++...........
.............++++++++...........
.............+++++..............
..............+++...............
```
E9, radial gravity, the y = 16 slice: a square, not a disc.
```
.......##########.......
.......###########......
......############......
......############......
......############......
......###########.......
.......##########.......
```

---

## 3. Bugs, with evidence

**B1. The rest test assumes a grain can reach all 8 lower neighbours. The move can reach 3, so settled heaps never
sleep.** (`activity.js:175-183` against `move.js:323-352` and the block parity)
- A grain can descend only on the step whose parity makes the cell below it its block-mate:
  `base_y = y − 1`, so `p = (y − 1) & 1`. At that parity its block's bottom row holds the cell straight below and
  exactly three others, one quadrant of the lower ring, picked by the parities of x and z.
- `inertNear` instead asks `canMove` of all 8 lower-ring cells, and ignores the topple's path test too. A grain with
  an empty lower neighbour outside its quadrant can never fall into it, yet it is never inert.
- E3c: all 43 non-inert cells of a settled heap are such grains. Between them they have 76 empty lower neighbours,
  every one with an empty path, and **0 of the 76 are reachable** by the parity rule above. The heap has 0 grains
  moving and every velocity exactly 0, yet 159-172 of 512 units stay awake past step 1200.
- The same mismatch, through a blocked path, is E8: one grain beside an overhang keeps 48 units awake forever.
- `docs/scaling.md` D2 and `activity.js:13-15` claim the rest test equals the move's rule. It doesn't.
- In the shipping game every poured heap keeps itself and its 26-brick halo stepping. That is power on every
  device, and the opposite of what D2/D8 were built for.

**B2. Fall and throw speeds are not the velocity.** (`move.js:301-302`, `355-367`; E1, E2)
- A cell is the top of its column's block only on alternate steps, and a failed draw costs it the next step too, so a
  cell falling at v moves on average **v/(2 − v)** cells a step (0.43 at sand's terminal 0.6, 71 %). E2: 65 %.
- Sideways it is worse. The horizontal exchange skips any cell that moved this step (`move.js:356`; liquid jets are
  exempt), so a grain falling at 0.6 gets a sideways chance only on the steps it didn't fall. E1: a throw goes
  33-57 % as far as its velocity says.
- The velocity is kept, so the grain flies a straight-down "drop" with its sideways speed unspent until drag eats it.
  That is why explosion debris and thrown sand drop nearly straight down once they fall fast: the arc is flattened
  into a short hop and a drop.

**B3. A falling or thrown group disperses into a cloud.** (`move.js:301-302`; E2)
- Every grain draws its own coin per step, so positions are a random walk around the velocity. A 1-cell slab is
  21 cells thick after a 15-cell fall.
- The fix exists for liquids only: R3 pacing by fall age (`move.js:130-170`). It was added because pours "fan out";
  sand pours, explosion debris and avalanches still do.

**B4. Blasts are octahedral.** (`react.js:431-439`; E4, E4b)
- The front copies 0.88 of the strongest *face* neighbour, so pressure travels in the L1 metric: one cell of L1 per
  step and 0.8536× per cell of L1.
- Along a body diagonal, 8.7 cells out, a blast is 3× weaker and 1.7× later than along an axis (5.6 vs 16.9; step 15
  vs 8). At 12 cells it is 4.2× weaker.
- Breaking by pressure (`P_BREAK_PER_HARD`), crushing and setting off explosives (`crushP`) all read this field,
  so what a charge breaks is a diamond around it. E4b's heave is visibly one.

**B5. Pressure is created and destroyed at will; containment is impossible.** (`react.js:439`, `physics.js:64-66`; E4c, E5)
- The front takes `max`, so one cell's 60 is copied (×0.85 per cell) into every cell around it. ΣP over the box
  goes 60 → 40,839 in 24 steps (E4c), 680× what was put in; in an unbounded grid the sum of `60·0.8536^L1` over
  the L1 shells is ~2,000×.
- Then the global `P_DECAY` 0.97 deletes 3 % a step everywhere, sealed or not. A sealed WALL vessel at 100 is at 4.8
  after 100 steps (E5), so a boiler, a pressure cooker or a sealed bomb casing can't build or hold pressure.
- TPT keeps 0.9999 a frame (Air.cpp AIR_PLOSS), a half-life of ~7,000 frames against 23 steps here.
- Boiling water adds its puff once (`react.js:714`) and it is gone in ~0.1 s.

**B6. Vacuum is erased in one step.** (`react.js:439`; E4c)
- `max(P0 + diffusion, 0.88·max_n P_n)`: any cell next to an ambient one takes 0.85 × 0 = 0 as its floor, so a −40
  cell is at 0 the next step (E4c: min P −40 → 0, ΣP 0).
- The team's own doc says so ("Vacuum's negative pressure fades in one step (react.js spreads only positive
  pressure), so it pulls only while held", `docs/elements.md` Tools). There's no suction, no implosion, no
  rarefaction behind a blast.
- The singularity works only because it re-imposes its vacuum every step (`react.js:447-452`).

**B7. Density is used as mass, so heavy grains shatter anything on a short fall.** (`common.js:557-577`,
`react.js:296-330`; E6; commit 1def559)
- A gold nugget (dens 193) or uranium (191) has drag 0.01, so it reaches V_MAX = 1 in 26 cells and carries
  ½·193·1² ≈ 96 > METAL's 60. 24 nuggets from 6 m go through a steel plate.
- The table (`phys/tables.mjs`): nuggets, uranium, plutonium and the singularity (dens 1000) break every breakable
  element by falling.
- This shipped. Commit 1def559 says Descent's crates spilled nuggets that "fell a storey, broke the moss they hit
  into sawdust and landed with ~100 units of kinetic energy: 50-100 °C of impact heat". It was fixed in the *level
  kit* (settle passes, no scatter near doorways), not in the physics.

**B8. Falling liquid breaks fragile solids.** (`react.js:297`, liquids skip drag `react.js:503-504`)
- A liquid in free fall has no drag, so after ~18 cells it is at V_MAX and carries ½·dens: water 5, lava 12.5,
  mercury 67.5.
- That is past LAMP and EMBER (3) and WALL_TORCH (4): a drip from a cave ceiling smashes a torch or a lamp.
  E6b: two drops from 26 cells broke 2 cells each of lamp, wall torch and ember.
- Mercury falling smashes steel.

**B9. A flame doesn't light wood.** (`react.js:915-917`; E7; `constructions/builtins.js:317,331`)
- Ignition is purely a temperature threshold (or `flash`, which defaults to `ignite`). Flames are buoyant,
  jittering gas cells that live 12-50 steps.
- Two 1000 °C flames placed against a wooden block warm it to 39 °C and are gone. Nothing burns.
  (2026-10-22: that scene is a one-frame dab of fire. A player holds the brush, and held fire lights wood, V1's
  too; the bench's `flameWood` now holds it. V2 also lights fuel by touch: docs/v2/contact.md TH-04.)
- The Campfire construction works around it by spawning its logs at 450 °C ("a lit fire starts above its ignition
  point").
- Once a fuel *is* past its point, the opposite happens. E7b: one 450 °C edge column sets a whole 4³ block
  burning at 900 °C within 200 steps, by conduction from cells that jump to their `flameT`. So ignition is a
  cliff: nothing, or everything at once.
- In TPT and Noita, fire touching a flammable lights it by a chance per contact (TPT's flammability, Noita's
  fire_hp). That is the behaviour a player tests first.

**B10. Cell 0's bounce and impact heat are missing, on purpose.** (`move.js:218-224`, `293`, `371`, `520`, `615`)
- In the GLSL a block-local `vec3 v0 = v0;` shadowed cell 0's register. So a cell at block corner 0 that rises into a
  solid keeps its velocity and takes no impact heat, and one moving +x or +z into a solid doesn't bounce.
- The port reproduces it for bit-parity ("fixing it is a physics change"). It's a real direction- and
  parity-dependent asymmetry: one cell position in 8 doesn't bounce off walls on alternate steps.

**B11. No gas ever rests.** (`common.js:657`; E10)
- `if (k == K_GAS) return false`, and every gas jitters (0.01 for cloud, 0.06-0.25 for the rest, `elements.js`).
- So a CO₂ or propane pool in a basin, a cloud that "holds together for minutes" (commit 9f8bd42), or a room with
  smoke in it keeps its bricks and their 26-brick halos stepping for as long as it exists. E10: a still 588-cell
  CO₂ pool that never leaves its basin keeps 147 of 512 units awake through step 1000.

**B12. Radial gravity makes a cube and turns sleeping off.** (`simModes.js:132-137`, `move.js:73-78`,
`sim.js:433`; E9)
- Each block is rotated so −y is its pull's dominant axis, so matter settles on six flat faces: a cube planet.
- `quietOk` turns sleeping off in radial mode and with void or loop edges, so those modes step every brick every
  step. E9: 512 of 512 units awake after 600 steps.

**B13. The simulation's speed is the frame rate.** (`app.js:1942`, `gfx/pacing.js:19`)
- Each rendered frame runs `settings.steps` (default 4) steps. A device that drops to 30 fps (Low Power Mode, Chrome
  Energy Saver: commit 82814c5 detects it) runs the world at half speed.
- Meanwhile `pov/ballistics.js` and the player integrate real `dt`. On the phone, falls, fire and fuses would slow
  under the player's feet while bullets don't.

**B14. Impact heat on the box floor is lost.**
- Outside the grid is a WALL at ambient that takes `1 − share` of every grain's impact energy (`move.js:261-267`,
  `400`), and it is never written. So the energy is not conserved, unlike conduction.
- Small, but it is the one leak in an otherwise exact energy budget.

**B15. Open bugs the team has logged** (`docs/elements.md` "Follow-ups"); the code paths they describe are unchanged
on this branch (read, not re-measured):
- liquid nitrogen boils ~100× too fast (no film-boiling limit);
- reaction products stack heat past real flame temperatures (H₂–O₂ peaks near 5,300 °C);
- reactions are capped at 1/6 per step by the pairing (`react.js:13-17`);
- storms never start (air is 20 °C at every height);
- plasma lasts ~7 steps;
- there is no drag for matter sinking through a liquid, so nitroglycerin poured into a pool can go off;
- dust clouds ignore oxygen and CO₂.

---

## 4. Rules that make it feel wrong or arbitrary

### 4.1 Falls and throws
- **One velocity cap for everything:** V_MAX = 1 cell/step (`physics.js:74`), about 72 m/s. A blast, a gold nugget
  and a dropped grain all top out there.
- **Two clocks.** The grid's gravity, 0.025 cells/step² at 240 steps/s and 0.3 m cells, is ~44 g in real time
  (`scale.js:13-17`, `pov/ballistics.js:11-15`). So the world plays ~6.6× fast for falls and much faster for heat.
  First-person rounds, kicked grains (1b68d53: "on the sim's fast clock a real kick's few m/s would stop within a
  cell") and rockets fly outside it at real 1 g. A kicked clump arcs 25 cells; sand thrown by a blast hops and drops
  (B2) and lands as scattered single grains (E4b).
- **Terminal speed is a per-element knob, not physics:** `drag` 0.01-0.15. `phys/tables.mjs` gives:
  - dust 0.14, ash and sawdust 0.23, snow 0.29, clay 0.39 cells/step;
  - every grain at drag 0.04 (sand, stone, salt, gunpowder…) 0.6;
  - scrap, nuggets, uranium and lithium 1.0;
  - every liquid 1.0, because liquids in free fall skip drag (`react.js:499-504`).

  So stone and sand fall identically (E2, bit for bit), and water outruns sand 1.7×. Lithium, lighter than water,
  falls like gold.
- **Drag is linear and per step** (`react.js:504`), so it also eats horizontal speed: a grain thrown at 0.5 cells/step
  can't travel more than 0.5/0.04 = 12.5 cells sideways however high it starts; its path bends to vertical within
  ~25 steps.
- **Landing scatter is noise**, not momentum: a random angle at 0.12× the fall speed (`move.js:751-756`).

### 4.2 Heaps
- **The angle of repose is the automaton's, the same for every powder.** A grain topples into a lower diagonal cell
  whose path is open, so a heap rests at "one cell of rise per cell" to its block's quadrant. The world generator
  bakes that same rule in (`world/generator.js:44-47`, `335`: "the cellular automaton's angle of repose").
  - `slide` (0.3-0.9) only sets how often a grain tries (`move.js:344`). E3: sand and dust give the same heap; dust
    takes 3× longer to get there.
  - The comments promise otherwise: "pile like gravel (angle of repose ~38°)" (`elements.js:522`), "Flour is
    cohesive (repose ~45°+)" (`808`), "Chunks pile steeply" (`1088`).
- **Heaps are square and terraced.** The xz-diagonal candidate moves a grain to the block's opposite corner, and each
  grain can only fall toward one quadrant (B1). E3's plan view is a square with steps.
- **Grains never sink into grains** (`common.js:588`), whatever their densities. Uranium poured on sawdust sits on
  top; TPT decides displacement by element Weight (`Simulation::init_can_move`).
- **A heap has no internal pressure.** Grains can't push grains sideways, so a column doesn't slump under its own
  weight. It only sheds its surface.

### 4.3 Collisions and impacts
- Fast contact exchanges momentum with restitution 0.3; slow contact (< COLLIDE_V 0.15) just cancels
  (`move.js:242-258`). Inside a falling column this is a Newton's cradle that pushes resting grains *down* into the
  floor (an equal-mass hit at 0.6 sends the resting grain down at 0.39 and leaves the falling one 0.21).
  Every landing restarts a chain of collisions in the heap, which is why heaps take 150-450 steps to settle (E3).
- **KE_TO_HEAT = 3**, where the literal conversion is ≈ 0.12 (`physics.js:303-316`, its own comment): 25×, set by
  two cases (a keg should go off when shot; a sand drop should warm the floor ~10 °C). It caused 1def559's Descent
  hot spots. E3b: a 432-grain heap lands at 21.8 °C on average and is still 1.2 °C over ambient after 1,500 steps,
  past AIR_REST_T (1 °C) on every grain. So even with B1 fixed, a fresh heap would stay awake for well over 1,500
  steps through its own impact heat.
- **Breaking uses kinetic energy in "dens·cells²/step²"**, with `hard ≈ strength/5 MPa` (`elements.js:540-548`).
  Mixing real strengths with fictitious masses and the capped speed gives a ladder (B7, B8):
  - water drips smash lamps;
  - a cell of scrap at full speed (39) breaks rock (30) but not steel (60);
  - a gold nugget (96) breaks steel;
  - titanium, tungsten and diamond have no debris (no `breakInto`), so nothing breaks them at all.

### 4.4 Explosions and pressure
- Gunpowder `P 60`. C-4, NITRO and TNT scale by detonation pressure, and C-4 takes `P_MAX` 200 (`elements.js:283-291`).
  - Any blast saturates locally, and the field clamps at 200 (`react.js:965`).
  - There is no energy or gas volume released. Bigger charges are bigger only through stacking: a cell going off
    adds its P onto the pressure already there (~140 at the edge of a 3³ gunpowder pile, `physics.js:317-326`),
    and everything saturates at P_MAX.
- The push is `a = −∇P·0.06/ρ` with `ρ = max(dens·0.1, 0.25)` (`react.js:456-459`). Air cells (ρ clamped to 0.25)
  accelerate hard but carry nothing: air moving into sand can't move it (`canMove` air→sand is false), so wind
  needs the tools to push matter directly (`passes.js:69-74`).
- Thrown debris is subject to B2 and B3. In E4b the crater is shallow (2-3 cells for 27 cells of gunpowder 8 deep)
  and the ejecta lands as isolated single grains spread over the whole bed: no rim, no ejecta blanket, no arcs.
- A blast's pressure decays in ~300 steps and wakes the whole box while it does (E4: 512/512 units). In a 128³ World
  window a single gunpowder cell's front stays above REST_P for ln(60/0.001)/0.158 ≈ 70 cells of L1.

### 4.5 Fire
- **Ignition is a hard threshold** (`react.js:915-917`). With `flash` defaulting to `ignite`, flames touching a fuel
  only matter once the fuel is already at its ignition point (B9).
- **Burning heats the fuel itself** to its `flameT` (`react.js:919`), and flames spawn in adjacent air with chance
  0.25 per burning neighbour per step (`react.js:768`).
  - The flame's temperature is `flameT × (0.85…1.0)` (`react.js:770`, `809`). That scales a *Celsius*
    temperature, so the spread is unit-dependent (oxyFlameT converts to kelvin for its gain, then the same °C
    multiplier is applied).
- **Flames are gas cells** with grav −1.4 and jitter 0.25, living 12-50 steps (`elements.js` FIRE, `physics.js:194-199`).
  They drift off what lit them, so fire spreads up and only weakly sideways or down. FIRE_MIN_T 350 kills any flame
  that cools.
- **BURN_P 0.02 per burning cell per step** feeds pressure that P_DECAY eats at once. It is never felt, but it
  keeps the air "busy" (REST_P) and awake.
- **Flames and smoke are made from air cells**, not from the fuel: a 4³ wood block put up to 865 cells of smoke
  (E7b), 14× its own volume, and smoke lives ~330 steps (SMOKE_FADE 0.003).
- **CO₂ smothers by a share of gas faces** (`react.js:694`) and oxygen boosts by face count (`react.js:199-210`):
  both reasonable, and both local to one cell's six faces.

### 4.6 Heat
- **Conduction is the best part**: symmetric, exactly conserving, unconditionally monotone (`react.js:188-197`,
  `physics.js:47-54`). Keep it.
- **Two global heat sinks.** Air relaxes to ambient 0.2 % a step everywhere (`react.js:421`, `physics.js:42`:
  "the open world above the box"), even in a sealed insulated box: E5's air fell from 200 to 75 °C in 100 steps.
  Gases also relax to ambient by their `rad` (steam 3 %/step).
  - Energy leaves through magic rather than through boundaries.
  - Sleep is defined against ambient (AIR_REST_T: air within 1 °C of ambient), so cold or hot levels can't rest.
    That forced a per-scene ambient (22692b4: "Snowy Depths spawn everything at −15 °C, so the air warmed back
    toward 20 °C every step and the whole window stayed awake"). It also turned Snowy Depths' lakes into brine
    (1def559: "so they rest instead of freezing").
- **Heat spreads unphysically fast.** Metal's cond/cap is 0.118 cells²/step: × 0.09 m² × 240 steps/s ≈ 2.5 m²/s of
  diffusivity, ~2·10⁵× real steel's 1.2·10⁻⁵; air's is ~2.5·10⁴× real air's ("as in The Powder Toy",
  `scale.js:15-16`). That is fine for a toy, but it is a third clock beside the grid's gravity and the POV's real
  time.
- **Rest tolerances are flux-based** (REST_FLUX 0.001 per face, `physics.js:98-125`): a careful, documented bound.
  But they exist to make sleep work around the sinks above.

### 4.7 Reactions and phase changes
- **Pairing** (one face partner per step on axis `frame % 3`, `react.js:364-410`) is race-free and deterministic,
  which is good. It caps any reaction at 1/6 per step (`elements.js:120-122`), so "chance 1" means "1/6",
  and fast flame fronts (H₂ in O₂) run slower than their cited speeds.
- **Reaction heat is added on top of the products' temperatures** (`react.js:406`, `697`): an H₂–O₂ flame reaches
  ~5,300 °C (B15).
- **Latent heat has two mechanisms:**
  - a signed bank in `life` (water, ice, steam, cloud, by hand, `react.js:707-742`; others from the table);
  - a chance per step when `life` is taken (`react.js:215-221`).

  The second is right on average but noisy per cell. On top of these, `HOT(id).y == 0` flips instantly.
- **Lava remembers its source in `ctype`** and sets at melt − 150 °C (`react.js:743-746`): good, TPT's model.
- **Steam condenses into water on any non-gas face, else into cloud** (`react.js:720`). The box floor counts as a
  surface, its sides and lid don't (`react.js:676`).

### 4.8 Gases
- **Brownian jitter forever** (0.01-0.25 per step, `react.js:623-628`), and gases never rest (B11).
  - A CO₂ pool is a permanently boiling layer, not a still one.
  - Smoke and steam diffuse into fog within seconds.
- **Gases don't make pressure.** 1,000 cells of steam in a sealed box press on nothing. Pressure is a separate scalar
  that boiling bumps once (`react.js:714`) and that decays in 0.1 s (B5).
- **Gas stratification** uses `GAS_DENS_TOL` 0.02 and thinning with temperature (`common.js:544-551`): sound, and it
  gives buoyant plumes.

### 4.9 Electricity
- TPT's spark automaton, compact and data-driven: σ in S/m, Joule heating, a P-N junction, switches, sensors
  (`electricity.js:1-80`). One hop per step is 240 cells/s.
- It reads well and has none of the problems above, except that a powered circuit never rests (inherent).

### 4.10 Brush tools
- **Element brushes fill a random 30-35 % of the brush** (`spawn`, `passes.js:180`), as TPT's do. In 3D that makes a
  speckled cloud that collapses, not a solid dab. `editing.js:247` compensates for one-shot fills with
  `rate / spawn`.
- **Heat and Cool** add ±30 °C per frame at the centre (`physics.js:338`). **Pressure** adds 6 per frame
  (`physics.js:339`), which the max-plus front then copies outward (B4/B5). **Vacuum** is undone the next step
  unless held (B6).
- **Wind and Cyclone push the cells themselves**: air in full, matter by 1/ρ (`passes.js:69-74`, `103-107`). This is
  because there is no air flow for matter to follow. Air moved by the wind doesn't carry anything.
- **Tools apply per frame, not per step** (`physics.js:30-36`). So a brush's strength per simulated step depends on
  `settings.steps` (1-12), and per wall-clock second on the frame rate.
- **Mix** (block XOR pairing, `passes.js:69-90`) is a clean, conserving, race-free design. Keep the pattern.

### 4.11 Simulation modes
- **Radial gravity**: a cube (B12), and every brick stepped.
- **Void and loop edges** disable sleeping (`sim.js:430-433`). Loop edges also need the margin dispatch dropped and
  a single-owner rule (`move.js:55-72`).
- **The air modes** are TPT's names on a different model:
  - "Velocity off" stills air *and* stops matter feeling pressure (`react.js:457-459`, `632`), since there is no air
    velocity for matter to follow;
  - "No update" freezes P and the air's v.
- **Ambient heat off** pins air at ambient and stops matter trading heat with it (`react.js:415-417`, `961`). That
  is consistent.

---

## 5. Hacks and magic constants (the slop list)

| Constant or hack | Where | What it papers over | Cost |
|---|---|---|---|
| `P_FRONT` 0.88 + `P_DECAY` 0.97 + `max()` | `physics.js:64-66`, `react.js:439` | plain diffusion needs L² steps to cross a pile, so a max-plus front was added | octahedral blasts, pressure made from nothing, no vacuum, no containment, the whole box awake per blast (B4-B6) |
| `V_MAX` 1 cell/step | `physics.js:74` | the 2×2×2 block can't move a cell further | everything caps at 72 m/s; projectiles leave the grid (POV ballistics) |
| `SIM_GRAVITY` 0.025 at 240 steps/s | `physics.js:13`, `sim.js:49` | falls had to look fast at the box's size | 44 g; three clocks (grid falls, heat, POV real time) |
| Per-element `drag` | `elements.js` rows | there is no terminal-velocity model | arbitrary fall speeds; water outruns sand; heavy grains reach full speed and break steel |
| Liquids skip drag in free fall | `react.js:499-504` | jets fell short | inconsistent with powders; drips break torches (B8) |
| R3 `PACE` for liquids only | `move.js:130-170` | pours fanned out | powders still smear (B3); two movement disciplines in one kernel |
| Jet exemption from the one-move-per-step rule | `move.js:356` | a falling jet couldn't move sideways | powders still can't (B2) |
| `SLIDE` | `elements.js`, `move.js:344` | a stand-in for friction and repose | changes only the time to settle (E3) |
| `LAND_POWDER_KEEP` 0.3, `LAND_POWDER_SCATTER` 0.12 | `physics.js:135-136`, `move.js:751-756` | landings looked dead | random sideways noise, not momentum |
| `COLLIDE_V` 0.15, `RESTITUTION` 0.3 | `physics.js:139-140` | an impact vs resting contact | cradle chains in heaps; heaps settle slowly |
| `KE_TO_HEAT` 3 (25× literal) | `physics.js:316` | a 30 cm cell can't resolve the hot spot | hot spots from falls; one-sided loss at the box floor (B14) |
| `hard ≈ strength / 5 MPa` with `dens` as mass | `elements.js:540-548`, `27-29` | a breaking rule from real data | the B7/B8 ladder |
| `FLAME_T_MIN/SPREAD` multiplying °C | `react.js:770`, `physics.js:204-205` | flames needed variety | unit-dependent flame temperatures |
| `FIRE_MIN_T` 350, life 0.5-1, burn 0.02-0.04 | `physics.js:194-199` | flames had to die | flames too short and buoyant to light anything (B9) |
| Campfire logs spawned at 450 °C | `constructions/builtins.js:317,331` | B9 | every "lit" construction must cheat |
| `AIR_AMBIENT_PULL` 0.002 and `rad` | `physics.js:42`, `react.js:421` | there is no boundary heat loss | a heat sink in sealed rooms; sleep tied to ambient |
| Per-scene ambient `airT` | 22692b4, `common.js:455` | cold levels never slept | a global constant made scene state |
| Brine lakes in Snowy Depths | 1def559 | water at −15 °C never rested | content chosen for the sleeper, not the player |
| Kit settle passes, no scatter near doors | 1def559 | B7 hot spots and debris | world generation works around the physics |
| `REST_V`, `REST_P`, `REST_V_SLOP`, `AIR_REST_T`, `REST_FLUX`, `MATTER_REST_T` | `physics.js:87-125` | float drift never reaches 0 | six tolerances to tune; each wrong one costs sleep or correctness |
| `AIR_JITTER_V` and air's own jitter | `common.js:647`, `elements.js:376` | brownian air | a tolerance to exempt it from rest |
| `GAS_DENS_TOL` 0.02 | `physics.js:128` | gases swapping forever | fine, but gases jitter forever anyway (B11) |
| The cell-0 QUIRK kept | `move.js:218-224` | bit-parity with WebGL | B10 |
| Rest test with 8 lower neighbours | `activity.js:175-183` | "can it topple?" | B1: heaps never sleep |
| The CPU twin of every rule | `ui/tiles/engine.js` (1,079 lines), `scripts/check-tile-engine.mjs` | dock tiles and CPU checks | every rule is written twice; the checks run on the twin, not the GPU (boom-check, chem-check...) |

---

## 6. TPT and Noita semantics, half-copied

| Feature | TPT / Noita | Here |
|---|---|---|
| Particle motion | TPT: float position and velocity, ray-cast move up to many cells a frame. Noita: settled cells in a cellular automaton, airborne ones become free particles until they land | per-cell velocity in a 2×2×2 block, a coin per axis per step, at most 1 cell (B2, B3) |
| Air | TPT: a coarse (4×4 px) pressure + velocity field, nearly conservative (AIR_PLOSS 0.9999); particles follow the air's velocity (advection) | a per-cell max-plus scalar with 3 % decay; matter pushed by −∇P directly; air cells' velocity carries nothing |
| Vacuum tool | TPT: lowers pressure; the air flows in | erased the next step (B6) |
| Wind tool | TPT: sets air velocity; particles drift with it | pushes the cells themselves |
| Burning | TPT: flammability = chance per frame next to fire. Noita: fire_hp burns down by contact | temperature thresholds only (B9) |
| Explosions | TPT: pressure into the air map, which then flows and propagates as a wave | pressure into a max-plus front (B4) |
| Powders | TPT: element Weight decides displacement (`init_can_move`); repose from its random diagonal rule. Noita: per-material settle | grains never displace grains; one repose for all (4.2) |
| Gravity modes | TPT: radial is a smooth field, its particles move freely | each block rotated to its dominant axis: a cube (B12) |
| Heat | TPT: ambient heat is its own coarse field, optional | air cells are the ambient field, with a global pull to ambient |
| Sleep | TPT doesn't sleep; Noita sleeps chunks with dirty rects | an exact sleep contract (better than both), undercut by B1 and B11 |

---

## 7. Sleeping, performance and the rest rules

The sleeping machinery (D5 run counter, brick lists, indirect dispatch, box-scoped edits) is sound, and the
invariant "a brick not DRAWN holds the same A, B and F in both copies, settled" is checked by
`tools/skip-model.mjs` with negative controls. What leaks is the *rest test*, and it leaks in places that matter for
power:

| Case | Units awake (32³ = 512) | Cause |
|---|---|---|
| a settled sand or dust heap, nothing moving | 159-172, forever (E3) | B1 |
| one grain beside an overhang | 48, forever (E8) | B1 (path) |
| a still pool of CO₂ (588 cells) | 147, forever (E10) | B11 |
| one blast | all 512 from step 29 to 260, idle at 300 (E4) | B5 |
| a buried 27-cell charge | 510 at step 300 (E4b) | B5 and scattered grains |
| radial gravity, void or loop edges | 512, always (E9) | `quietOk` |

The rest test is a hand-written mirror of the move and react rules (`activity.js:99-184`, `common.js:648-690`). Every
rule added to react or move must be mirrored there by hand. B1 shows the mirror is already wrong, and the history
shows tolerances tuned per incident (REST_FLUX in 1def559, per-scene ambient in 22692b4).

---

## 8. Keep (must stay in v2)

- **Exact mass conservation by construction.** The block permutes; nothing is created or lost by moving.
- **Determinism and order independence.** Hashed streams seeded by world cell, frame and salt (`common.js:518-541`),
  correctly rounded `rnd` (D8.3), and no float atomics, so dispatch order and list order can't change results.
  This is what makes the sleeping exact and multiplayer possible.
- **Race-free pair rules.** Reactions and breaking are evaluated by both cells on the same input with one
  stream (`react.js:364-410`, `293-330`); Mix uses XOR blocks (`passes.js:69-90`). It is the right pattern for
  every two-cell interaction.
- **Exactly conserving, monotone conduction** with the per-face limiter (`react.js:188-197`).
- **Latent heat banking** (`react.js:235-246`) and lava remembering what it was (`ctype`).
- **The exact sleep contract** (webgpu.md D5): bricks, the run counter, GPU-built lists, indirect dispatch,
  `skip-model.mjs` with negative controls. Keep the contract, rebuild the rest test (section 9).
- **Box-scoped edits with marks** (D6) and the one-writer-per-cell rule (D8.8).
- **Data-driven elements**: phase rows, reaction rows, blast rows and the "adding an element is data only" rule
  (`elements.js:130-163`), and citing sources. But tie the numbers to a model in which they mean what the comment
  says (section 9).
- **TPT's tool set and simulation options** as features: Property, line, box and fill, deco. Their
  semantics should follow the new air model.
- **The spark automaton** (`electricity.js`).

---

## 9. Direction for v2 (proposal)

The user is open to a new approach. What follows removes B1-B13 at the root rather than patching them, and is
aimed at Apple-Silicon performance per watt.

1. **Two states of matter in motion: settled and flying.** This is Noita's split, and it fixes B2, B3 and B7 and the
   two-clock problem.
   - **Settled** matter stays in the grid, and the cellular automaton only handles contact: topple, slide, sink,
     flow.
   - A cell that leaves contact (|v| above a threshold, nothing under it, thrown, blasted, kicked) is taken out of
     the grid into a GPU particle list with float position and velocity. It is integrated ballistically at the real
     gravity of the world's clock, and swept against the grid (DDA) each step.
   - It lands by claiming an empty cell: every particle landing this step does an `atomicMin` of its id into its
     target cell, the winner writes, and the losers retry next step from where they are. Mass stays exact, and the
     result doesn't depend on arrival order.
   - The rays layer (`raysLayer.js`) is already a GPU particle list, and the POV projectiles (`pov/ballistics.js`,
     kick, transfer) are CPU ones. Merge them into one system, so a kicked clump, a blast's debris and a bullet fly
     by one law.
   - Falling slabs stay slabs, throws arc, debris makes an ejecta blanket, and speed has no 1 cell/step cap.
2. **One clock.** Pick a real-time gravity in cells/s² and drive the step count from wall time with a fixed-step
   accumulator, not from frames. Heat diffusivity, fuses, flame lives and tool strengths all go on that clock.
   TPT's per-frame feel can be a "sim speed" multiplier, applied once.
3. **Air as a coarse conservative gas.** For example, one air cell per 4³ brick, the sleeping unit we already have:
   - density (or pressure), velocity and temperature, with a simple explicit compressible or acoustic solver
     (TPT's Air.cpp on a 3D coarse grid), with solid bricks as walls;
   - blasts and burning add gas mass and heat; containment, vacuum and rarefaction come for free;
   - matter feels the air through drag toward the air's velocity (TPT's advection) plus buoyancy;
   - the pressure difference across a solid's faces still breaks it (keep P_BREAK_PER_HARD's idea, on the coarse
     field, interpolated);
   - the coarse grid is 1/64 the cells, so a blast that wakes the air costs far less than waking every fine brick.
4. **Rest tests that are the move's own predicate.**
   - Generate `inertNear` from the same rule table the move uses, including parity reachability and paths, or make
     sleep conservative per brick by "nothing changed in two full parity cycles" (state hash compare, which the
     run counter half does already).
   - Let a gas rest when nothing drives it: do its diffusion on the coarse air grid as a concentration, not as
     per-cell brownian swaps that never stop.
   - Make radial and edge modes rest-compatible.
5. **Heaps with real repose.** A powder topples only when the height difference to a neighbouring column exceeds its
   material's `tan(repose)`. Draw the partition offset per axis independently each step (8 offsets, not 2), so blocks
   stay disjoint but a grain can reach every lower neighbour over a few steps: no quadrant lock. Then `slide`
   becomes an angle you can cite.
   Allow grains to displace much lighter grains (as TPT's Weight does).
6. **Fire and heat by energy.**
   - Ignition by contact chance (TPT flammability) plus temperature.
   - Flames as short-lived *heat sources attached to the fuel's surface*, not free buoyant gas that wanders off.
   - Product temperatures from energy (fixes B15's 5,300 °C).
   - No global ambient pull: heat leaves through the box's open boundaries and the sky.
   - Rest defined relative to neighbours, not to a global ambient, so cold levels need no per-scene hack.
7. **Masses and strengths in one unit system.** Use real kg per cell, real m/s and real energies (J), and convert
   once. Keep `hard` as a real strength × cell area and stop using `dens` as a mass in a capped-speed
   world. Then "gold breaks steel" happens only where it should, and the citations in the table mean what they say.
8. **One implementation.** Retire the CPU twin. Run the CPU checks (`boom-check`, `chem-check`…) on the GPU harness
   or on a WGSL-derived reference, so rules are written once.

---

## Appendix A. Scripts and outputs (`scratchpad/v2/phys/`)

- `exp.mjs name[,name]` (`--port N`): experiments `throw`, `slab`, `pile`, `pileheat`, `piledebug`, `blast`,
  `blastsum`, `boom`, `vessel`, `impact`, `drip`, `fire`, `fire2`, `fire3`, `overhang`, `gaspool`, `radial`. Results go to
  `exp.out.json`; logs are in `exp.log`, `exp2.log` and `exp3.log`. `exp-b.mjs` is the same script writing
  `exp-b.out.json` (`pileheat`, run alongside; log `exp4.log`); `exp-c.mjs` writes `exp-c.out.json` (`fire3`, the
  E7b run; log `exp5.log`). Long runs need `TPT_TEST_TIMEOUT_MS` raised past the launcher's 10 minutes.
  `fire2` (a 6³ block in 32³) ran out of time twice and was stopped; `fire3` replaces it.
- `exp-noheat.mjs`: the same on `tree-noheat` (`KE_TO_HEAT: 0`), results in `exp-noheat.out.json`.
- `tables.mjs`: terminal speeds, fall energies, what each loose element breaks by falling, slides, gas rows.

## Appendix B. File and line index

| Topic | Lines |
|---|---|
| Margolus block, rules | `move.js:225-430` (unrolled), `438-628` (loop form) |
| one move per cell per step (jets exempt) | `move.js:356`, `600` |
| R3 pacing (liquids only) | `move.js:130-170` |
| cell-0 quirk | `move.js:218-224`, `293`, `371`, `520`, `615` |
| land, bounce, drag in liquid | `move.js:725-765` |
| canMove (grains never sink into grains) | `common.js:580-592` |
| hitKE, shockActs, impactActs | `common.js:557-577` |
| inertSelf (gases never rest) | `common.js:648-690`, `657` |
| inertNear (8-cell lower ring) | `activity.js:99-184`, `175-183` |
| breaking, explosives triggers | `react.js:293-362` |
| pressure front | `react.js:423-452`, `439` |
| forces, held, drag, friction, jitter, clamp | `react.js:454-638` |
| conduction, ambient pull | `react.js:412-421`, `188-197` |
| burning, flames | `react.js:747-777`, `915-927` |
| reactions pairing | `react.js:364-410` |
| constants | `physics.js:37-370` |
| repose in the generator | `world/generator.js:44-47`, `335-339` |
| campfire pre-heat | `constructions/builtins.js:311-337` |
| sim speed per frame | `app.js:1940-1944`, `gfx/pacing.js:19` |
| sleep off in radial and edge modes | `sim.js:430-433` |
