# Audit: water and liquids (behaviour and look)

Branch audited: `claude/webgpu-port` at 42f4039 (read only). Whitewater's WGSL kernel is in `/home/user/wt/U12`
(b61271f) and is audited from there. Line numbers are from this branch unless marked U12.

Evidence comes from three sources. All the scripts are in `scratchpad/v2/liq/`.
- **CPU twin**, 2D (`src/ui/tiles/engine.js`: the same rules and constants, run in node): `cpu-exp.mjs`, `cpu-exp2.mjs`,
  with results in `cpu-exp.out.json`.
- **GPU sim**, 3D, at 32³ in the sim-check harness page on SwiftShader, from a private copy of the repo (`scratchpad/v2/tpt`):
  `gpu-exp.mjs`, with results in `gpu-*.json`.
- Reading the code and main's commit history for liquids.

## 0. Verdict in one paragraph

The liquid model is a powder model with patches. Liquids are whole-cell particles in a 2×2×2 Margolus automaton, and they
move on a coin flip weighted by a per-cell velocity that is capped at 1 cell per step. There is no pressure and no fill
fraction. Instead, a stack of hand-written velocity "kicks" in the react pass approximates levelling, spreading, surface
tension and jets: the FLOW_SURFACE kick, the Torricelli head scan, the film cohesion pull, droplet wander, the pipe-flow
renormalisation and the splash on landing. Three more layers then hide what that model produces:
- the move paces liquid with a global quasi-random sequence by "fall age" (PACE/R3);
- the whitewater field tracks the "wakes" that parcels leave in the air and "joins" them into ropes;
- the field passes fill those wakes in, and the renderer gives every drop the colour of 7 m of water.

The basics a player tests first do not work:
- **Communicating vessels.** Two connected columns of water rest 20 cells apart in 3D, and the sim certifies the scene idle.
- **Pipes.** A tank stops draining through a pipe: on the GPU a 12-cell pipe fills and flow stops by step 300 with
  27 cells of head behind it. In the 2D twin even a 3-cell passage through a wall clogs.
- **Puddles.** A spill never comes to rest. It smears into a 1-cell film and wandering droplets across the whole floor,
  and those bricks never sleep.
- **Pools.** A pool whose volume isn't a whole number of layers keeps a broken, beaded top layer that churns forever.
- **Splashes.** A landing creates energy. A sheet dropped 1 cell gains 160–210× its kinetic energy, and a 24-cell column
  splashes across an 80-cell floor.
- **Viscous liquids.** Slime at 10 Pa·s and lava both flatten into 1–2 cell films. Viscosity only changes the speed.

Main's history shows the cost: whitewater v0 → v1 → v2 → reverted → "jet in the sim" → "pour drawn as rope via wakes" →
"liquid in the air shows its colour". That is six attempts in about three days (Oct 8–11) to make one pour from one
hole look like water, and every attempt treats a symptom of the Margolus parcel spacing. **Recommendation: don't port
this. Replace it.** Bulk liquid becomes fill fraction plus per-face flux with real pressure, solved in compute and able
to rest exactly. Airborne liquid becomes ballistic GPU particles, as in Noita. Section 9 has the shape of it.

---

## 1. How liquids work today (the map)

| Stage | Where | What it does to a liquid cell |
|---|---|---|
| Velocity integrate | `react.js:455-635` | gravity; normal force `held` (496-498); no drag when "flying" (503-504); then the liquid rules |
| Liquid rest rules | `react.js:513-599` | if `held` and something is open to the side: kick sideways at `FLOW·0.6` (surface), or at Torricelli `0.98·√(2gh)` from a column scan (539-555), or in a random direction (571-576); under a lid: nothing (577-578); on dry ground: film cohesion and droplet wander (579-598) |
| Pipe flow | `react.js:600-621` | between a solid floor and a solid lid: drop the components that point into walls, then renormalise to the speed it came in with |
| Move | `move.js:279-381` | 2×2×2 Margolus block. Vertical exchange, a diagonal topple, then horizontal exchange; each moves with probability `|v|·drag`; liquid→gas pairs are "paced" by the R3 sequence (130-170) |
| Landing | `move.js:735-758` | a liquid that hits anything at more than 0.15 cells/step gets a sideways velocity of at least FLOW in a random direction, plus 0.3·its fall speed |
| Rest test | `activity.js:168-170` | a liquid with any horizontal neighbour it could move into is never inert |
| Render fields | `fields.js` | EMA of one-hot occupancy (0.35/frame), a 5-tap Gaussian blur (σ 1), a thin-feature boost, cubic reads; "jets" fill wakes to full occupancy (200-222, 271) |
| Whitewater | U12 `liquidDetail.js:327-640`, `gfx/foam.js` | aeration per cell, carried by `moveSrc`; wakes in air cells; "pour parcels"; forces the move out of place |
| Look | `liquid.js`, `render.js:1040-1060` | refraction, Fresnel, Beer–Lambert by `sigma`; "thin" liquid absorbs as 24 cells of it (`liquid.js:63-77`) |

Constants: `physics.js:74-85, 128-141`. Viscosity maps to `flow` and `drag` through `elements.js:326-338`.

---

## 2. Experiments (numbers)

### 2.1 GPU, 3D, 32³ (`gpu-exp.mjs`, the shipping unrolled move, no debug prelude)

| Test | Setup | Result |
|---|---|---|
| **U-tube** | two 4×4 arms joined by a 20×4×4 channel; left arm filled to y = 25 | after 150, 300, 450 and 600 steps: **left 25, right 5**, every cell's velocity 0, **AWAKE 0, idle certified at step 150**. A 20-cell head difference counts as a rest state |
| **Puddle** | a 6³ block dropped 3 cells onto the floor | spread over the whole 32×29 floor as a **1-cell speckle** (map below) by step 100. **211–216 of 216 cells moving at steps 100, 200, 300 and 400; 173–184 moving sideways faster than 0.05; AWAKE 192 of 512 units; never idle.** No puddle with clean edges forms |
| **Pool, partial top layer** | a 24×24 glass tank, 3 full layers plus 150 cells on top | **exactly the 150 top cells keep moving at every checkpoint, steps 100 to 600.** They scatter as isolated singletons over the whole 24×24 surface (map below) and never clump into a partial layer. **AWAKE 192 of 512, never idle.** 38 % of the grid steps forever because of 150 cells |
| **Pool, full layers** (control) | the same tank, 3 full layers | rests by step 100: 0 moving, AWAKE 0, idle certified. Only a pool that happens to have whole layers can sleep |
| **Free-falling column** | 2×2×20 of water released in the air | free fall should keep it a 2×2 column. Instead, **76 of 80 cells move sideways by step 6**, and the widest cell is 3.5, 5.5, 7.5, 9.5 and **15.5 cells off the axis** at steps 6, 12, 18, 24 and 40: about a cell every 3 steps. Stacked falling cells "land" on each other in mid-air and splash (B6) |
| **Tank → 12-cell pipe** | 6×6 tank, 27 deep (972 cells); a 1×1 bore along its foot, 12 cells long, open at the end | tank 972 → 949 → 932 → **922 → 922** at steps 100, 200, 300, 400: **the pipe fills (12/12) and flow stops by step 300**, pipe vx 0.70 → 0.28 → 0.09, with the tank still 27 deep |
| **Tank → 1-cell hole** (control) | same tank, a bore only through its 1-cell wall | 972 → 949 → 930 → 910 → 892: keeps draining at about **0.19 cells/step**, against Torricelli's ≈ 0.53 for Cd 0.6 at v ≈ 0.88 cells/step: a parcel every ~5 steps |
| **Hole in a tank** | 7×6 tank, 19 deep, 1-cell hole at the foot of its +x wall | the jet (x–y slice through the hole below) is **single cells scattered over x 11–31** at steps 60 and 120, not a parabola, as far as the far wall |


Floor of the 3D puddle at step 400 (`~` water, a 1-cell film; 216 cells spread over 32×29, all moving):
```
..........~.........~...........
...................~~...........
..~.......................~~~~..
...............~................
.......~~...~..~....~~..........
~....~.~~..~..~~~...~~......~...
~..~~~.~~.~~~..~~~~~..~...~~~...
~...~~....~~~~.~~.~~~~~....~~...
.....~...~~~~~~~~~~~~.~....~....
..~~~.~~~~~.~~~~~.~~~...~...~~~~
~~~.~.~.....~~~~~~~~~~.~~.....~~
.....~~~~.~~.~~.~~~~~~~....~....
```
Top layer (y = 3) of the 3D tank at step 600 (`~` water; 150 cells, every one moving, none clumped):
```
#.~............~.........#
#.~.~..~..~~..~.~..~~~.~~#
#...~........~~.~.....~..#
#.~...~.~.~....~.~..~..~.#
#.~..~...~~~..~~..~....~.#
#..~~~~.~..~...~...~~~~..#
```
The 3D hole at step 120 (x–y slice through the hole, `#` wall, `~` water in the hole's plane, `,` beside it):
```
..#,,~~~~,#.....................
..#~~,~,~~.~...~.~..............
..#########..........~..........
................................
...........................~...~
................................
...............................~
................................
................................
................,.........~.....
..................,~~~...~.~~~~,
```

### 2.2 CPU twin, 2D (`cpu-exp.mjs`, `cpu-exp2.mjs`)

| Test | Result |
|---|---|
| U-tube (40×40) | left 29, right 5 at steps 1,000 to 6,000; 0 cells moving. **No equalisation, a false rest.** |
| Puddle: 36 cells dropped on a 64-wide floor | spreads over 57 columns as 1-cell film and droplets. **All 36 cells still moving at step 8,000.** `......~~~~...~~~~~....~~~..~~.~~~~~..~~~.~~~~..~~~~~~......~~~~.` |
| Levelling in a 40-wide basin (140 cells) | heights 3..4 by step 200 (passes sim-check's "hi − lo ≤ 1"), but the top layer stays beads `#..~~..~~..~~..~~..~~~..~~~..~~..~~...~~.#` with **20 cells moving forever** (steps 800 to 6,000) |
| Tank, side hole | drains as single droplets scattered over a 40-cell-wide landing zone; the tank interior turns to Swiss cheese (air cells that came in through the hole sit in the bulk) |
| **Pipe from a tank** (lengths 3, 10, 30) | **flow stops** after 43–57, 64–65 and 44–47 cells drained (two runs: the twin binds `rnd = Math.random` at import, so the scripts' seeding doesn't reach it); the pipe stays full of still water (`pipeVx` 0) with 27 cells of head behind it, through step 2,000 |
| Gentle landing: a 20-cell sheet dropped 1 cell | kinetic energy 0.013 → **2.06–2.72 (×160–210)** (two runs) |
| Splash: a 2×12 column dropped 30 cells | spreads from x 0 to 79: **the whole 80-cell floor** |
| Continuous pour (2 wide, refilled each step) | the falling stream is **14–16 % water**: a dotted column, parcels thrown sideways across the 16-cell box |
| Viscous heaps, 48 cells after 300 / 3,000 steps | water 57–61 wide; oil 53; **mud 32–42, slime (10 Pa·s) 36–46, toxic 49, lava 21 (32 cells)**; every one ≤ 2 cells tall |
| Oil under water, inverted | separates in 139 steps (fine) |
| Lone droplet on a floor | random walk 31 → 20 → 26 → 28 → 24 → 36 → 44 → 42 over 4,000 steps; never rests |

### 2.3 Shots (realistic view, Whitewater off, 32³, SwiftShader; `liq/shots/*.png`, from `liq/shots.mjs`)

These come from the volume harness in the private copy, with an `auditShot` test added there.
- `shots/column.png`: the 2×2×20 column 14 steps after release. It has torn into two mirrored lobes flying apart, with
  drops shed below. That is mid-air "landing" (B6) in a body of water that should simply fall.
- `shots/partial.png`: the tank with 3 full layers plus 150 cells, 300 steps on. The surface is a mottled field of
  lumps where the stray top cells are (B4). It never settles, so this picture keeps changing.
- `shots/pour.png`: the 1-cell hole at step 120. There is no stream: two dark beads float beside the tank and a blot
  lies on the floor. This is what a pour looks like on this branch (B7, B13).
- `shots/puddle.png`: the 6³ spill at step 300. Connected film is drawn almost clear, while every isolated droplet is a
  saturated teal dot (the 24-cell `thinBodySeg` fudge), so the floor reads as polka dots. Same water, two looks
  (section 6, B3).

The twin differs from the GPU in two places (see B10), so the 2D numbers are indicative. The U-tube result holds in
3D on the GPU.

---

## 3. Bugs, with evidence

**B1. Communicating vessels don't work, and the false state certifies as rest. (Severity: critical.)**
- No rule ever gives a liquid an upward velocity. Gravity only pulls down; the head scan only pushes sideways
  (`react.js:539-576`); `canMove` dir 1 needs `v.y > 0`.
- The rest test (`activity.js:168-170`) only looks at the cell itself and its six neighbours, so a column standing next
  to an empty arm is "inert".
- GPU 3D: left 25 against right 5, AWAKE 0, idle certified (2.1).
- Pours that should rise through siphons, fountains, U-bends, a bucket emptied into one side of a connected tank: none
  of these work.
- TPT has the same failure and ships a separate "water equalization" mode, a flood-fill teleport that is off by default.
  Even TPT had to bolt it on.

**B2. Pressure doesn't go through anything with a lid, so pipes and multi-cell holes clog. (Severity: critical.)**
- In a lidded cell, `head` is false (KIND(up) is solid) and `onLiquid` is false, so the branch at `react.js:577-578`
  does nothing. Pipe flow (`react.js:607-621`) only keeps the speed a cell came in with, and drag takes 1 % a step.
- Once a pipe is full, no cell in the system has an open side except the exit, and the exit cell is lidded.
- **GPU, 3D**: a 12-cell pipe from a 27-deep tank fills and **stops by step 300** (tank 922 of 972 at steps 300 and 400; pipe vx decays 0.70 → 0.09). The 1-cell hole control keeps draining (2.1).
- CPU: pipes 3, 10 and 30 cells long drain 43–57, 64–65 and 44–47 cells, then stop with 27 cells of head behind them.
- The one-cell hole in `jet-check` only works because the hole cell keeps emptying: "a parcel every ~7 steps"
  (commit 3c600d2).

**B3. Puddles and spills never rest. (Severity: high, for both performance and look.)**
- A film edge cell is open (air outside), so cohesion pulls it inward every step:
  `v = 0.5·v + 0.27·dir` (`react.js:588`, FILM_KEEP 0.5, FILM_COHESION 0.3, FLOW 0.9).
- It can't move into its own puddle, so `collide(flow)` shares the push with the neighbour inside (`move.js:251-253`).
  The edge keeps 0.27 cells/step of velocity forever.
- An isolated droplet re-rolls a random direction 10 % of steps (`react.js:591-597`).
- `inertSelf` needs v == 0 (`common.js:660`), and `inertNear` makes any liquid with an open side busy
  (`activity.js:168-170`). So **every brick holding a spill's edge stays awake for the session.** This contradicts
  docs/scaling.md D2's claim that "the same gate holds back a film's cohesion pull": the gate is `open`, and a film's
  edge is always open.
- README:277 says films "gather into puddles with clean edges". The twin shows the opposite: 36 cells smeared over 57
  columns, all moving at step 8,000.

**B4. A partial top layer churns forever. (Severity: high.)**
- A cell of the top layer sits on liquid, so it is `onLiquid` (`react.js:528`). If it has an open side, it is set to
  `FLOW_SURFACE·FLOW = 0.54` toward it (`react.js:556-570`).
- A partial layer always has open sides, so the beads swap with air forever: `..~~..~~..` (2.2).
- Any lake that isn't an exact number of layers stays awake and keeps re-dirtying its render fields. Every brush click
  of water into a settled lake does this.
- The behaviour stage's acceptance (`sim-check.js:415`, `hi - lo <= 1`) passes it.

**B5. A landing creates energy. (Severity: high, for feel.)**
- `land()` (`move.js:735-758`): any liquid landing at more than LAND_SPLASH_V (0.15) that is moving sideways at less
  than FLOW·0.5 gets a sideways speed of **FLOW (0.9)** in a random direction, plus 0.3·|vy|.
- A cell landing at 0.16 leaves at about 0.95, so the step adds kinetic energy. A cell landing at 1.0 leaves at 1.2,
  clamped *per component* to V_MAX (749), so diagonal splashes go up to √2·V_MAX: **anisotropic, 41 % further on
  diagonals**.
- Each cell rolls its own direction, so a splash is noise, not a crown. Twin: ×160–210 kinetic energy from a 1-cell drop;
  24 cells over 80 columns from 30 cells up.

**B6. Falling liquid stacked on falling liquid "lands" in mid-air and splashes. (Severity: high: blobs and pours
explode.)**
- `vertical()` (`move.js:303-313`): whenever a falling liquid t sits over a movable b it can't swap with (any liquid of
  the same element), the code runs `collide` and then, **unconditionally** for a liquid,
  `land(vec3f(v.x, vt, v.z))` with its pre-collision vy (`move.js:309`).
- That fires even when both fall at the same speed (rel = 0: collide changes nothing, the splash still happens).
- So inside a falling blob, every top cell that shares a Margolus block with a cell below it gets B5's random sideways
  kick of about 1 cell/step, at every other step.
- GPU: a 2×2×20 column in free fall has **76 of 80 cells moving sideways by step 6** and reaches 15.5 cells off its
  axis by step 40 (2.1). The twin's continuous pour scatters across its whole 16-cell box.
- Horizontal contact got a "flow on together" fix (`move.js:251-253`); vertical contact never did. "A falling slab
  stays one layer" (sim-check `jets`) only tests a one-cell-thick slab, which has nothing stacked to trigger this.

**B7. The Margolus block turns a falling stream into a dotted line. (Severity: high for look; it is the root of the
whitewater churn.)**
- Inside a 2-tall block a column of same-density liquid can't move. The bottom cell can only fall at the other parity,
  so a continuous column of liquid falling into air becomes about 50 % cells and 50 % gaps.
- Commit 3c600d2 documents it ("a pour was a dotted line of lenses"), and liquidDetail.js:366-368 restates it.
- The twin's continuous pour fills only 14–16 % of its stream box: the dotting plus B6's scatter. The GPU hole jet
  (2.1) is single cells spread over 20 cells of floor.
- Everything in section 4's "pour stack" exists to hide this artifact.

**B8. Pacing correlates every liquid in the world. (Severity: medium.)**
- `draw()` (`move.js:160-163`) gives every liquid↔gas pair the same R3 value
  `frac(n·PACE)`, with `n = fallAge(...)` (`move.js:166-170`).
- For anything not falling (every resting surface cell, every spreading film, every pool lip) `n = P.frame`, so **all of
  them in the whole grid draw the same number on a given step**. With the same `want` (0.54), every spreading front in
  the world advances on the same steps.
- That gives lockstep fronts and Bresenham staircases instead of noise. It was meant to keep the parcels of one pour
  together (commit ca75fdb) and is applied globally.

**B9. Viscosity has no yield. Every liquid flattens. (Severity: medium.)**
- `viscous()` (`elements.js:326-338`) maps log-viscosity only to `flow` (speed) and `drag`. Slime at 10⁴ mPa·s gets flow
  0.42, half of water's.
- Nothing stops a liquid at a slope. The `want` kick fires whenever a side is open, whatever the head, so mud, lava and
  slime level into 1–2 cell films (2.2).
- The comment at `elements.js:853` admits it ("its yield stress holds only a few cm, under a cell, so here it creeps
  level"). Lava flows read as water in orange.

**B10. The "can't drift" CPU twin has drifted. (Severity: low; it matters because dock tiles and quick experiments use
it.)**
- The GPU keeps the cell-0 quirk (`move.js:218-224`, 293, 371): cell 0 rising into a solid, or bouncing off one along +x
  or +z, keeps its velocity and takes no heat. The twin bounces cell 0 normally (`engine.js:599-601`).
- Pipe flow: the GPU renormalises to the incoming speed (`react.js:616-620`); the twin only zeroes components into walls
  (`engine.js:799-803`).
- physics.js:1-3 claims "the two can't drift".

**B11. The cell-0 quirk is a real bug kept on purpose. (Severity: low to medium.)**
- `vec3 v0 = v0;` shadowed register 0 in the GLSL. A liquid in block cell 0 pushing +x or +z into a wall doesn't bounce
  (bounceR −0.7) and keeps pushing.
- That is a direction-dependent bias, +x/+z against −x/−z, kept for parity (docs/webgpu.md K3).

**B12. Whitewater NaNs for any foaming liquid without LIQ_PROPS. (Severity: latent.)**
- `AER_SIGMA` and `AER_RHO` return 0 for anything but water, oil and acid (U12 `liquidDetail.js` perLiquidFn), so
  `we = …/0` and then `/ sqrt(0)`.
- It is safe only because FOAMS is the same three (`materials.js:492`), and tables-check guards the pairing.
- Saltwater, the sea, never foams. Neither do the other 13 liquids. Meniscus and foam are hard-coded to three liquids.

**B13. Whitewater on this branch is a stub.**
- `gfx/foam.js` here is still the WebGL code (`makeFieldTarget` and `rawMat` throw: `sim.js:136-138`), and
  `wire/foam.js:1-5` says the switch "reads an empty field".
- So on this branch pours are dotted beads with no rope (the jets depend on `P.aer != 0`, `fields.js:211`). The rope
  appears only once U12 merges, and only with Whitewater on.
- **The coherence of a pour depends on a graphics detail switch** (`detail.js:114`, cost 'medium'), so low-tier and
  phone users see beads.

**B14. The Torricelli head saturates at about 16 cells.**
- The scan stops once √(2gh) reaches FLOW (`react.js:545`), and `want` is capped at FLOW (554). A 16-cell dam and a
  100-cell dam pour identically.
- The scan is also an O(column) loop per cell per step (`headScan` = grid height), for every held liquid cell with an
  open side.

**B15. Air doesn't rise through liquid by itself.**
- E_EMPTY has `grav` 0, so a bubble only moves when liquid above falls into it, at the liquid's fall rate. In the twin's
  hole test the air that came in through the orifice sits in the tank interior: holes in the bulk.
- README:272 says "steam bubbles up", but plain air doesn't.

**B16. Radial gravity: pools never rest, by design** (README:316). The rest model has no notion of a level surface
under radial gravity.

---

## 4. Hacks layered on hacks (the "slop" stack)

**The pour stack.** It exists because of B7 and B6. In the order they landed:
1. `PACE` / R3 low-discrepancy pacing for liquid↔gas pairs (`move.js:130-163`). It replaces the random draw so the
   parcels of a pour stay in lockstep, and causes B8.
2. `fallAge` (`move.js:166-170`): pace by "steps fallen", computed back from `-vy/g`. It assumes drag-free
   free fall, so react has to switch drag off for "flying" liquid (`react.js:503-504`): one rule bent to serve another.
3. The diagonal step: a moved liquid can still move across in the same step if the pair is liquid↔gas
   (`move.js:356`). This breaks the "each pair exchanged once per axis" invariant just for jets.
4. "A liquid doesn't topple toward where it is already moving" (`move.js:335`): added so a pour leaves level.
5. Pipe-flow renormalisation (`react.js:600-621`): added so a hole's exit points straight.
6. `ORIFICE_CV` Torricelli with a column scan through "one-cell bubbles" (`react.js:531-555`): added so the exit
   speed is uniform.
7. The whitewater wake records in **air** cells, "pour parcels" (y = 2), TRAIL_JOIN_STEPS, JOIN_REACH, JOIN_COS
   (U12 liquidDetail.js; this branch's `liquidDetail.js:352-384`): a render-side tracker that guesses which drops
   belong to the same stream.
8. `jetWGSL` (`fields.js:200-222`): the field passes draw a wake as liquid at full occupancy when another "pour
   parcel" is within 4 cells behind it.
9. `thinBodySeg` (`liquid.js:63-77`): every thin liquid feature absorbs as if it were 24 cells (7 m) deep, so beads
   read as water.
10. `mobileVel` in the renderer (`render.js:511-521`) throws away the sideways velocity of liquid resting on liquid,
    "as the automaton levels it". The renderer filters the sim's noise.

**The levelling stack.** It exists because there is no pressure and no fill:
- the FLOW_SURFACE kick, the Torricelli kick, the FLOW_KICK random re-kick, film cohesion, droplet wander, and the
  REST_V snap. Each is a constant (`physics.js:75-85`), and each fires on its own neighbour test.
- The result levels to ±1 cell, cannot rest (B3, B4), and cannot carry pressure (B1, B2).

**The whitewater stack.** Six attempts in three days (commits 27dc229, 9173ffa, cb66653, 3c600d2 v1, 71a3e7a v2,
9122cde revert, e07775d wakes):
- It forces an **out-of-place move** (`move.js:48-53, 705-708`) and a `moveSrc` plane, so foam can follow cells
  through Margolus swaps.
- It adds a per-step brick list, args and kernel (U12 `gfx/foam.js`). Main measured 0.4 ms per step at 128³ with a
  pool, which is about 1.6 ms per frame at 4 steps per frame.
- It keeps the frame loop busy until foam bursts (`wire/foam.js`).
- Its pour heuristics would not exist with continuous jets.

**Constants without a single physical meaning.** `FLOW_SURFACE 0.6`, `FLOW_KICK 0.5`, `FILM_KEEP 0.5`,
`FILM_COHESION 0.3`, `DROPLET_WANDER 0.1`, `DROPLET_SPEED 0.5`, `LAND_SPLASH_V/FLOW/GAIN`, `BOUNCE_LIQUID −0.7`,
`DRAG_LIQUID_*`, `DIAG_NOISE`. All of them are tuning knobs on a model that can't converge, so no setting fixes B1
to B5.

**Tests that pin hacks instead of outcomes.**
- sim-check `jets` asserts the exact `vx` of the Torricelli rule and that "a falling slab stays one layer"
  (`sim-check.js:1476-1596`).
- `behaviour` accepts a 1-cell-bumpy surface (`sim-check.js:415`).
- No test checks that a puddle rests, that a U-tube equalises, that a pipe drains, or that a splash conserves energy.

---

## 5. Rules that fight each other

- **The kick against rest.** The react kicks fire whenever a side is `open`, and rest needs v = 0 *and* no open side.
  Any liquid surface that isn't perfectly boxed in is therefore never at rest (B3, B4). docs/scaling.md D2 tried to
  reconcile them with the `open` gate, which doesn't cover films or partial layers.
- **No drag in flight against pacing.** `fallAge` assumes exact free fall, so react turns drag off for liquid with gas
  or falling liquid under it (`react.js:503`). That also removes the air drag that would break up and slow spray.
- **Splash on landing against coherent jets.** Pacing keeps parcels apart in lockstep, and any small speed difference
  turns contact into a random splash (B6). The two are tuned against each other.
- **Film cohesion against the flow collide.** The edge pulls in, and `collide(flow)` passes the pull to the interior;
  neither damps it, so the system rings.
- **Pipe flow against head flow.** In a pipe the head rule doesn't apply (lid) and the pipe rule only conserves speed.
  The two never hand over (B2).
- **Viscosity (speed) against levelling (always on).** A viscous liquid takes longer to reach the same flat film (B9).
- **The renderer against the sim.** The EMA (`materials.js:140`, 0.35 a frame), blur and boost smooth what the sim
  churns. `mobileVel` drops the churn's velocity, and the thin boost inflates beads. The look is tuned to the sim's
  noise.

---

## 6. Look (rendering) issues

- **Beads instead of streams.** Without U12 and Whitewater on, every pour is a dotted line of 1-cell lenses (B7, B13).
  With them, the rope is a guess (JOIN_REACH 4, JOIN_COS 0.9) that fails for curved, sparse or crossing streams, and
  any wake with no "pour parcel" behind it is undrawn.
- **The 24-cell colour fudge** (`liquid.js:72`). A 1-cell drop is as saturated as 7 m of water, but a 1-cell film on
  the floor is not "thin" (its boost is about 1.6, under THIN_MASK_LO 1.8: `materials.js:448-454`) and draws clear. Two
  cells of the same water in the same light look different. The intent is right (Noita and TPT readability); the
  mechanism is a hack.
- **Temporal smearing.** EMA 0.35 a frame on occupancy, with up to 4 steps a frame of 1-cell moves, ghosts fast
  liquid. Ghosts aren't boosted, so they fade as shrinking blobs.
- **Integer surface heights.** A pool's surface sits at whole cells, and a partial layer is lumps (B4) that the blur
  turns into a moving bumpy skin. There is no fractional level, so filling a lake raises it in 30 cm steps.
- **Detail for three liquids only** (`liquidDetail.js:49-53`, `materials.js:492`). Meniscus, foam and spray exist for
  water, oil and acid. Saltwater, the sea, has no foam, and neither do the potions, blood or whiskey.
- **Foam is noise thresholded on a field from a sim that can't make waves.** No momentum means no breaking waves, no
  hydraulic jump and no wake behind a body. Foam only comes from landings (and from "spray" coverage, which v2 tried
  and reverted).
- **Hyperactive clock.** The world runs ~6.6× real time (`physics.js:7-17`, `scale.js`: g is 1,440 cells/s², about 44 g at 30 cm cells), and liquid kicks are 0.5–0.9 cells/step, so a spill crosses a 38 m site in about a second. Water reads as buzzing rather than heavy. v2 should give liquids a time scale that reads as water: substeps with a realistic g for the liquid solver, or a slower world clock.
- **Splashes are scatter, not a crown or sheet.** They are random per-cell directions (B5), so a dropped blob turns
  into an expanding ring of beads that never stops (B3).

---

## 7. Performance and power

- **Never-sleeping liquid.** Spills (B3), partial layers (B4) and droplets keep their bricks and 26 neighbours awake.
  They also keep the derived field passes (EMA, blur, boost, peak: 8 dispatches over the dirty list) re-running every
  frame. This is the opposite of the perf-per-watt goal: one spilled bucket keeps the GPU busy indefinitely. Measured at 32³:
  216 spilled cells keep **192 of 512 sleeping units (38 %) stepping forever**, and so do 150 stray cells on a pool;
  the same pool with whole layers is idle-certified by step 100.
- **Whitewater**: out-of-place move, the `moveSrc` plane, a list kernel, an args kernel and the aeration kernel every
  step, plus the jet reads in the EMA and boost passes. Main measured +0.4 ms per step at 128³ and 1.4 ms in the view
  (`detail.js:108-113`), and it is on by default on desktop.
- **Column scans.** The head loop runs up to 16 fetches per held liquid cell with an open side, every step.
- **Four steps a frame of 1-cell moves** to get liquids moving fast enough, because the move is capped at 1 cell per
  step per axis and is probabilistic.
- Every step is a Margolus pass even for still water, and still water touching anything open can't sleep.

---

## 8. How the references do it

| | Bulk | Airborne | Pressure, levelling | Rest | What to borrow |
|---|---|---|---|---|---|
| **Noita** | cells, one material each, updated sequentially by chunk on the CPU; liquids try down, then diagonal, then several cells sideways a frame | cells thrown by explosions or velocity become **free particles** (continuous position and velocity) and re-enter the grid when they hit | none; levels by fast sideways moves; no U-tubes | dirty rectangles per chunk: a region whose cells stop changing stops updating; liquids move by trying positions, not by carried velocity kicks, so a settled pool has nothing pushing it | **particles for flying liquid**; every pixel in its body colour |
| **The Powder Toy** | one particle per pixel, liquids with random sideways tries over several cells; a coarse air grid (4×4 px) of pressure and velocity advects them | none | air pressure pushes liquids; communicating vessels **fail**, so TPT has an optional **"water equalization"** mode that teleports surface particles to the lowest connected surface (flood fill), off by default for cost | per-frame; nothing sleeps | pressure from a coarse field; even TPT treated U-tubes as a special pass |
| **Teardown** | no water sim; water is static planes in volumes | particles for splashes and spray | none | n/a | particles for spray; don't simulate what you can't afford |
| **Minecraft** | source blocks plus 7 flow levels per block, a BFS toward the nearest drop | none | levels by rule, not mass; infinite sources | settles in a few ticks; cheap | **fractional levels** (8 per block) give a smooth surface; fast settling |
| **From Dust / virtual pipes** (Mei, Decaudin, Hu 2007; O'Brien and Hodgins 1995) | heightfield columns with flux per face and momentum | none | head difference accelerates flux; waves; exact mass | flux decays to 0 | **flux per face with momentum, mass-limited outflow**: GPU-trivial, conserves mass, levels in about L steps, carries waves |
| **Weakly compressible or compressible CA** (W-Shadow 2009, "Simple Fluid Simulation with Cellular Automata"; Dwarf Fortress pressure) | fill per cell, slight over-compression with depth | none | over-full cells push up and sideways, so **U-tubes and pipes work** | flows under a minimum snap to 0 | **fill fraction with compression for pressure** |
| **PB-MPM** (EA SEED 2024), FLIP | particles plus grid | same particles | full incompressible | n/a | gorgeous, but a whole-world 128³ lake would need millions of particles on a phone; for small effects only |

Halo 3 (the look reference among the touchstones) draws water as a tessellated surface with refraction, foam textures
and splash particles: surface plus particles, the same split proposed below.

---

## 9. Direction for v2 (proposal)

Split liquid into two representations, as Noita, Teardown and every shipped game in section 8 effectively does.

**9.1 Bulk: fill plus per-face flux, with real pressure.**
- A liquid cell holds one liquid id and a **fill** (u16 fixed point, 1.0 = full, up to about 1.05 for compression), so
  mass is conserved exactly in integers.
- Per cell, a **flux on its +x, +y and +z faces** (3 × f16, which replaces today's velocity for liquid cells). Per
  substep:
  1. Accelerate each face's flux by the difference in pressure head across it. Pressure is persistent per cell
     (compression of fill over 1, plus gravity on vertical faces), so pipes, U-tubes and dams transmit it.
  2. Limit the outflows so a cell never sends more than it holds (virtual pipes' K factor).
  3. Gather: `fill += Σ inflow − Σ outflow`.

  It is Jacobi, gather-only, with no Margolus, no atomics, no randomness and no global pacing.
- Run 2 to 4 substeps per sim step so a wave crosses at least a cell a substep, and the compression at depth stays a few
  percent: about g·d/c².
- **Viscosity** is flux damping per liquid. **Yield stress** (mud, lava, slime) is a minimum head difference before a
  face flows (Bingham), so they keep a slope.
- **Films and contact lines**: a minimum film fill (say 1/8) below which a face won't flow out over dry ground, so
  puddles stop at a finite depth. Optionally, sub-film remnants evaporate (a game choice).
- **Rest is exact.** When every |flux| is under a quantum and fill doesn't change, snap the fluxes to 0. Integer fill
  makes that a true fixed point, so the brick sleeps. The existing GPU sleeping machinery (lists, indirect dispatch) is
  reused unchanged.
- **Immiscible layering**: one liquid per cell as today. Density decides who displaces whom; a cell with a heavier
  liquid over a lighter one swaps (as now).
- **Interaction with powders and solids**: a cell is either one liquid (with its fill; the rest is air) or anything
  else. A powder falling into partly filled liquid displaces it, and the fill moves up. The Margolus move stays for
  powders and gases if wanted.

**9.2 Airborne: ballistic GPU particles.**
- Outflow into air above a speed threshold, outflow off a ledge, and blasts or impacts that fling liquid all become
  particles.
- A particle has a continuous position and velocity, gravity, mild air drag (which also gives spray its terminal
  speed), an aeration value and a liquid id.
- It lives in an append buffer integrated by one indirect dispatch. On contact it deposits its volume back into a
  cell's fill (atomic add on fixed-point fill, or a per-cell gather of particles binned by cell).
- **A jet from a hole becomes a continuous stream of particles at the Torricelli speed the flux already gives.** It
  doesn't need PACE, fallAge, the diagonal step, wakes, pour parcels, jetWGSL or thinBodySeg.
- Splashes conserve momentum: impact particles spray in a crown around the impact normal with energy no greater than
  the incoming. That fixes B5 and B6.

**9.3 Foam and whitewater.**
- A scalar per bulk cell (u8), advected by the same flux (upwind). Its sources are particle impacts (from impact KE,
  keeping the Ervine and Chanson onset of 1 to 4 m/s), and flux shear and divergence, which give hydraulic jumps and
  wakes. It decays at Monahan's τ (2.54 s fresh, 3.85 s salt).
- Particles carry their own aeration (Pilch and Erdman breakup can stay as a particle property).
- No out-of-place move and no moveSrc. It is one more channel in the flux pass, not a pass of its own.

**9.4 Look.**
- **Bulk surface from fill**: the surface height is `y + fill` per column (and per run, for caves), so the iso is exact
  and smooth without blur. The normal comes from the fill gradient, with no EMA, because fill moves continuously.
  Keep refraction, Fresnel, Beer–Lambert by sigma, GI-aware reflections and caustics.
- **Particles**: screen-space fluid rendering (depth splats, bilateral or narrow-range smoothing, a thickness buffer for
  Beer–Lambert at the real thickness). It is cheap at half resolution on tile GPUs. "Liquid in the air shows its colour"
  becomes one stylisation parameter (a minimum optical thickness), not a 7 m fudge.
- **Detail for every liquid** from a table: σ, contact angle, foaminess, as columns in elements.js rows, so all 17
  liquids get meniscus and foam (saltwater included).

**9.5 Acceptance tests (outcomes, not implementation).**
- A U-tube equalises to within one fill quantum.
- A tank drains through a 30-cell pipe to the pipe's level.
- A 1-cell hole pours one unbroken stream whose exit speed is √(2gh) for h up to the full tank, and whose landing point
  follows the parabola.
- A puddle rests within N steps and then sleeps (AWAKE 0).
- A pool with any volume rests flat, with a fractional top.
- Mud, lava and slime keep a slope that rises with yield.
- A splash's total kinetic energy never exceeds the incoming.
- Liquid and particle mass are exact.
- A settled world with water in it certifies idle.

**9.6 Risks and open questions (for the v2 design, not settled here).**
- **Partial cells and the rest of the sim.** Heat capacity, reactions (lava on water, acid), electricity and the POV
  body's buoyancy all assume whole cells. They need a rule per fill: scale by fill, or treat a cell under some fill as
  air for reactions. Decide this once, centrally.
- **Two liquids meeting** at partial fills: displacement by density per cell is simple, but a thin oil film on water
  needs either a minimum fill or a second liquid slot. Pick the minimum fill first.
- **Particle ↔ grid handoff**: deposit by atomics on fixed-point fill (WebGPU core has u32 atomics) or by binning
  particles per brick and gathering. The second is deterministic, and multiplayer and replays want determinism.
- **Cost on phones**: 2 to 4 substeps over the awake liquid bricks only. A resting lake costs nothing once it is
  certified, unlike today, where any lake with a partial layer is awake. Particle counts need a budget, with spray
  culling by screen size.
- **Look continuity**: the user does not want the current look kept for its own sake. Use the existing optics (section
  10) as the shading, and judge the new surface and stream look on shots.

---

## 10. Keep

- **Exact mass conservation** as a hard invariant, checked by census. Keep it with fixed-point fill.
- **Brick-granular sleeping with GPU-built lists and indirect dispatch** (src/gpu, activity). The flux pass plugs into it.
- **Density stratification of immiscible liquids.** Oil and water invert in 139 steps, and buoyancy emerges from
  density.
- **The physical constants and citations**: Torricelli and ORIFICE_CV (as a test target), Monahan's foam decay, bubble
  rise of 0.23 m/s, Ervine and Chanson's entrainment onset, Pilch and Erdman breakup, capillary length and meniscus
  height, gravity-capillary dispersion for ripple octaves, per-element `sigma` absorption and scattering, IOR. The
  real-units thinking is the best part of the current code.
- **The viscosity data per liquid** (mPa·s from real sources): feed it into flux damping and yield instead of `flow`
  and `drag`.
- **The optics pipeline**: refraction with TIR, Fresnel, Beer–Lambert, reflections that use GI sky visibility
  (envReflectGI: "a pool in a cave mirrors the cave"), sun attenuated through depth, ripple-focused caustics, and the
  mesh cut so water tints bodies.
- **The design intent** that liquid in the air reads in its body colour (Noita and TPT readability), with a real
  mechanism.
- **The latent heat and phase rules** for water, ice and steam (react.js 707-720). They are separate from motion and fine.
- **The harness** (sim-check stages, the CPU twin for quick experiments), with outcome tests (9.5) and a single source
  of truth so the twin can't drift (B10).

---

## Appendix A: file and line index

- move.js: 130-170 (PACE, jet, draw, fallAge); 218-224 (cell-0 quirk); 242-258 (collide flow); 279-315 (vertical;
  309 mid-air land); 323-352 (diagonal; 335 no topple toward heading); 355-381 (horizontal; 356 jet diagonal step);
  725-732 (dragF); 735-758 (land; 744-749 splash and per-component clamp); 48-53, 705-708 (whitewater out of place)
- react.js: 496-498 (held); 503-504 (no drag flying); 513-599 (liquid rules: 539-555 head scan, 556-576 kicks, 577-578
  lid, 579-598 film and droplet); 600-621 (pipe flow); 635 (REST_V)
- physics.js: 74-85 (flow constants); 87-95 (rest); 128-141 (movement)
- activity.js: 168-170 (liquid with an open side never inert); common.js: 580-592 (canMove), 660 (v == 0 for rest)
- elements.js: 326-338 (viscous); 396-416, 684, 725-745, 860, 912, 982-1077 (liquid rows); 853 (mud creeps level)
- liquid.js: 63-77 (thinBodySeg, 24 cells); render.js: 511-521 (mobileVel hides surface churn)
- liquidDetail.js: 49-53 (LIQ_PROPS, three liquids); 85-110 (foam constants); 322-426 (aeration model, the wake notes;
  WGSL in U12); fields.js: 33-41, 200-222, 271 (jets)
- gfx/foam.js and wire/foam.js (this branch: WebGL stub); gfx/detail.js: 108-115 (whitewater cost); materials.js:
  139-140 (liquid EMA and blur), 448-454 (thin mask), 492 (FOAMS)
- engine.js (twin): 586-603 (no cell-0 quirk); 798-804 (pipe flow differs)
- tools/harness/sim-check.js: 403-415 (levels ±1 accepted); 1476-1596 (jets pin the rules)

## Appendix B: scripts

`scratchpad/v2/liq/cpu-exp.mjs`, `cpu-exp2.mjs` (node, the 2D twin; results in `cpu-exp.out.json`, `cpu-exp2.out.json`).
`gpu-exp.mjs [utube,puddle,partial,full,column,hole,pipe1,pipe12]` (GPU 3D, sim-check harness page, private repo copy
`scratchpad/v2/tpt`, Vite on port 47311; results in `gpu-utube.json`, `gpu-puddle-tank.json`, `gpu-colhole.json`,
`gpu-pipe.json`). `shots.mjs [pour,partial,puddle,column]` (the volume harness of the private copy with an
`auditShot` test added, Vite on port 47312) writes `liq/shots/*.png`. Every process these start is stopped.
