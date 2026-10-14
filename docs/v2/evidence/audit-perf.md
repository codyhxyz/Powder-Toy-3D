# Audit: PERFORMANCE of the WebGPU port (v2 input)

Scope: what the port costs per simulated step and per presented frame at 128³, where the time, the memory
and the memory bandwidth go, which costs are structural (a redesign removes them; tuning doesn't), and
what v2 should budget on a MacBook Pro (M-series, 60/120 Hz) and an iPhone 17 Pro Max (Safari 26, 60 Hz).

Tree: `claude/webgpu-port` @ 42f4039 (read-only). Line numbers are that commit's. Where I ran something, I ran
it on an exported copy (`v2/perf/tree`, same commit plus the `fengari` package the read-only checkout's
`node_modules` lacks). Everything I wrote is under `v2/perf/` (scripts, logs, JSON).

How to read the numbers: three kinds, never mixed in one claim.
- **Mac** = numbers the repo already recorded on the user's M5 MacBook (legacy WebGL2 build, ANGLE/Metal,
  `docs/scaling.md`, `docs/particles.md`, `src/gfx/detail.js`, commit messages). They are the only real-GPU
  timings that exist. They are the legacy build's, but the port kept the same algorithms, so they are the
  best predictor of the port's cost on the Mac until M1-M3 (`docs/webgpu.md` I4) are run.
- **SS** = SwiftShader in this container (a CPU rasterizer, 4 shared cores at load 13-23 while I ran).
  Good for counts, orders of magnitude and compile-time trends; useless for ranking GPU kernels (the unrolled
  move is 3× slower than the loop form *on SwiftShader* and that says nothing about Apple).
- **est** = my arithmetic from the code (bytes per cell, passes, workgroups). Every estimate shows its
  derivation so it can be checked.

---

## 0. Verdict

1. **The port is efficient at the API level and inefficient at the algorithm level.** One submit, two compute
   passes, five render passes and ~76 dispatches per presented frame (`tools/budgets/*.mjs`), async
   pipelines, deep idle with 0 rAF and 0 submits. That foundation is good and stays. But the work it
   schedules is the legacy work, and the legacy work could not hold 60 Hz on the user's M5 in an active
   scene: a lab frame at the default Speed 4 is **~18-28 ms of GPU** on the Mac (section 5). The Descent
   levels, headless at 1280×800 on that Mac, ran at **17-27 fps with only 3-21 % of bricks awake** after
   their heat fix (commit 1def559; 12 fps before it), the Snowy Depths at **5 fps** with 91 % awake
   (commit 22692b4). Only a world at rest (the island, 0 % awake) held 60.
2. **The five structural costs**, biggest first (section 7):
   (a) **4 sim steps per presented frame** (240 steps/s, `app.js:137`) because a Margolus move can only move
   a cell one cell per step; every byte of sim traffic is paid 4× per frame;
   (b) **~167 B of memory traffic per awake cell per step** over two full passes (move, react) of a
   72 B/cell fp32 double-buffered state (section 3), so a fully awake 128³ world wants **~84 GB/s**,
   more than an iPhone has and over half an M5's;
   (c) **every derived product is recomputed every frame anything moves**, whatever moved: the 512²-ray
   shadow map, GI source over every matter brick, GI gather over half the probes, 9 full-grid brick
   passes, and the field pipeline over a **125-brick (5³) neighbourhood of each changed brick for 13
   frames** (section 4), because the derived key is the sim's step counter (`app.js:1962`);
   (d) **the view re-marches every pixel every frame** while anything changes, and keeps doing it for
   **109 frames (1.8 s) after the last change** under TAAU (`post.js:202`, section 6);
   (e) **~400-650 MB of GPU memory at 128³** (408 MB measured at boot, section 2): two fp32 state copies,
   160 MB of derived field scratch, and 201 MB of whole-grid undo snapshots taken on every stroke.
3. **The sim is tied to the display.** `MAX_FPS = 60` caps presentation because the sim steps per frame
   (`gfx/pacing.js:3-5, 19`): a 120 Hz MacBook can't present at 120 without running the world twice as
   fast, and an iPhone that drops to 30 Hz halves the world's speed.
4. **Compile size is a cold-start tax.** 98 pipelines, 7.2 MB of WGSL at 128³, ~1.7 MB of it built by a
   lab session; every compute kernel
   carries a ~30-35 KB prelude (~330 constants, ~115-135 functions) even a 6-tap blur; the realistic view is
   263 KB / 5,400 lines / 1,074 constants; the shipping move is 125 KB / 3,329 lines and takes 11-14 s to
   build on SwiftShader (section 8).
5. **Realistic v2 budgets** (section 10): on an M5 at 60 Hz, a typical active frame ≤ 4.5 ms GPU and
   ≤ 120 MB of DRAM traffic (today ~18-28 ms and ~0.7-1 GB est); at 120 Hz ≤ 4 ms per presented frame with the
   sim on its own 60 Hz tick; on an iPhone 17 Pro Max at 60 Hz ≤ 6.5 ms and ≤ 50 MB per frame, ≤ 200 MB
   resident, ≤ 2 W sustained GPU. They are reachable only with the structural changes in section 9, not
   by tuning kernels.

---

## 1. What runs, per step and per presented frame

### 1.1 A step (`src/sim.js:571-623`)

```
step():                                                   dispatches (gpu.stats, B3)
  if idle-certified: return (aeration idle only)          0
  activity build every 2 steps (ACTIVITY_PERIOD)          6 (1 indirect)  → 7 counted
  move    indirect over DRAWN (parity 0) / MOVE1 (1)      1 indirect      → 2
  margin  direct, parity 1 only (12,481 blocks at 128³)   1
  [aeration over its list, Whitewater only]               2 (U12, not merged here)
  react   indirect over DRAWN, a workgroup per brick      1 indirect      → 2
  version += 2                                            (the derived passes key on it)
```

`tools/budgets/sim.mjs`: the lab at 4 steps per frame is 1 submit, 1 compute pass, 32 dispatches
(10 indirect). The app runs `settings.steps` = **4** steps per tick (`app.js:137, 1942`) at up to 60 ticks/s:
**240 steps per second**.

### 1.2 A presented frame (`app.js:1895-2008`, `1841-1867`)

| Stage | What | Size at 128³ | When |
|---|---|---|---|
| sim | 4 steps (above) | DRAWN bricks × 4 | every tick that isn't paused or idle-certified |
| derived: dirty | age, dirty, dirtyArgs | 32,768 bricks, direct | **every presented frame whose derived key changed**: the key is `sim.version` + sun + view + settings (`app.js:1961-1962`), and `version` moves on every step (`sim.js:622`); then 22 more frames (`app.js:1700`: GI's settle) |
| derived: fields | EMA (EMA list), blur ×3 + boost ×3 (WORK list), peak (FIELDS list) | up to 2M cells | same |
| derived: bricks | brick map (FIELDS), brickDist ×3, light blur ×6 | brickDist and light over **all 32,768 bricks** | same (`derived.js:340-353`) |
| shadow | one DDA ray per texel | **512² = 262,144 rays** at 128³ (`render.js:1344`: min(1024, 4·max n); 1024² for the giant volcano) | same, every derived frame of a view with shadows (`app.js:1850-1853`) |
| GI | giSource over every brick with matter; giGather over half the probes | 32,768 / 16,384 probes × 32 rays × ≤12 brick steps | same, realistic view (`derived.js:381-410`) |
| pick | hover ray | 1 ray | every presented frame (`app.js:1989`) |
| scene pass | floor grid, volume march (fragment), edges, brush | every covered pixel | every presented frame |
| three | opaque meshes before, transparent after | | only when three has something visible |
| post | TAA/TAAU, prefilter, bloom 9 mips + reduction (1 compute pass), up[0], canvas | | every presented frame |

Counts per presented frame of the lab (budgets): sim 32 + derived 30 (9 indirect) + GI 2 + shadow 1 + pick 1
+ post 10 = **~76 dispatches** (19 indirect, each with Chrome's own validation dispatch), **2 compute passes,
5 render passes, 1 submit** (box mode). This part is already lean; it is not where the time goes.

### 1.3 How long the frame keeps running after a change

| Trigger | Derived frames | View frames | Source |
|---|---|---|---|
| any step that ran (anything awake) | every frame, + 22 after | every frame (a derived frame forces the view) | `app.js:1700, 1961-1967` |
| camera moved, world asleep | 0 | 109 with TAAU (77 with TAA) | `post.js:195, 202`, `pacing.js:29` `settleFrames` |
| birds in the default World scene | 0 | **every frame, forever** (they `pacer.wake()` each tick) | `docs/webgpu.md` intro, F7 |

So the cost model is nearly binary: **a world with one falling grain pays what a world on fire pays** for the
shadow map, the GI, the nine full-grid brick passes, the view and post. Only the sim's lists and the field
passes scale with what changed, and the field passes with a 125-brick × 13-frame amplification (section 4).

---

## 2. Memory at 128³

### 2.1 Computed from the code (N = 2,097,152 cells, 32,768 bricks)

| Owner | Resource | Bytes per cell | MB | Source |
|---|---|---|---|---|
| sim | A: (id, °C, life, ctype+seed) f32×4, **2 copies** | 32 | 67.1 | `sim.js:288` |
| sim | B: (velocity, pressure) f32×4, 2 copies | 32 | 67.1 | `sim.js:288` |
| sim | F: activity flags u32 (4 bits used), 2 copies | 8 | 16.8 | `sim.js:288`, C3 |
| sim | flow: 3×f16 + pad (render-only) | 8 | 16.8 | `sim.js:289` |
| sim | moveSrc (Whitewater) + decoration plane | 4 + 4 | 8.4 + 8.4 | `sim.js:1369-1381` |
| sim | **undo: whole A+B current copy, up to 3** | 32 × 3 | **201.3** | `sim.js:63, 908-921`; taken on every stroke (`app.js:1480, 1495`) |
| sim | atlas scratch (load / readState; kept in test mode) | 32 | 67.1 | `sim.js:872-890` |
| derived | field EMA, 3 × pack4x8 | 12 | 25.2 | `derived.js:57-75` |
| derived | blur/boost scratch A and B, 3 × pack4x8 each | 24 | 50.3 | same |
| derived | normalised blur, 4 × pack2x16 | 16 | 33.6 | same |
| derived | fieldSurf, fieldMedia, fieldThin (rgba16f 3D) | 24 | 50.3 | same |
| derived | per-brick: age, lists, brick, brickDist, light, GI (×4 bands + history), giSrc | — | ~4.5 | same |
| aeration | 2 copies × vec2u (Whitewater) | 16 | 33.6 | `docs/webgpu.md` E |
| volume | shadow map rgba32f 512² + r32f copy (1024² in the giant volcano) | — | 5.2 | `gfx/volume.js:66-68` |
| post | at 1512×982 output, TAAU 1/1.5: scene colour+depth, 2 history, bloom | — | ~40 | `post.js:1095, 1190`; 3.3 MB at 400×250 (`budgets/post.mjs`) |
| readback | staging pool kept idle | — | ≤ 67 | `READBACK_POOL_BYTES`, B7 |

Totals (est): resident steady state **~355 MB** (sim 168 + derived 164 + volume 6 + post) + Whitewater 42
+ deco 8 + **undo 201 after three strokes** + a 67 MB scratch around loads and reads + staging.
**Per cell: 80 B of sim state and 76 B of derived fields, 156 B before undo.** A packed state needs 8-12.
And most of those cells are air: at load the lab is 6.0 % matter cells (7.5 % of bricks hold any matter),
the volcano 10.5 % (11.8 % of bricks) (`v2/perf/occupancy.txt`, the presets built on the CPU as the app builds
them; at 64³ the GPU's own brick map agrees: 464 of 4,096 lab bricks, 11.3 %, carry `BRICK_MATTER` against
10.6 % on the CPU, `frame-64-lab-v0.json`). Air carries temperature, pressure and velocity here, but TPT keeps exactly those on a grid 4× coarser
per axis (`CELL = 4`: `pv`, `vx`, `vy`, ambient heat `hv`), which in 3D is 1/64 of the cells.

### 2.2 Measured

`v2/perf/frame128.mjs` booted the app (`?size=128&preset=lab`, realistic view, manual test mode, 400×250
viewport) and read `gpu.memory()` (our buffers and textures; three's scene target is extra). Log:
`v2/perf/census-128.log`, JSON: `v2/perf/census-128-lab-realistic.json`.

| | MB | of which |
|---|---|---|
| at boot (pipelines ready, nothing drawn) | **407.7** (33 buffers, 16 textures) | A 67.1, B 67.1, **atlas scratch 67.1** (test mode keeps it; a session drops it after the load), field blur 33.6, EMA 25.2, field scratch A 25.2, B 25.2, F 16.8, flow 16.8, fieldSurf/Media/Thin 16.8 each, shadow map 4.2 + 1.0, activity 1.2, GI history 1.0, media noise 1.0, the rest < 0.6 each |
| after 2 frames | 409.8 (33 textures) | + TAA history 2 × 0.8 at 400×250 |

So a real session at 128³ starts at ~340 MB of our own allocations before undo, Whitewater, the decoration
or a full-size canvas, and grows by 67 MB per undo snapshot up to 201 MB. The computed table above matches
the measurement to the megabyte.

Time, for the record: this boot took 129 s on SwiftShader (load average 13-23), and the warm-up (4 steps,
then 2 presented frames with the derived passes, the 512² shadow map, GI and the realistic march at 400×250)
took **414 s**, so the measured frame at 128³ didn't fit the launcher's 10-minute lifetime. Section 5.1 has
the frame at 64³.

---

## 3. The step: bytes per awake cell

Accesses per cell of a DRAWN brick, from the kernels (all state is fp32 in brick-major order, so a brick's
cells are 1 KB of A, 1 KB of B, 256 B of F):

| Kernel | Reads | Writes | Source |
|---|---|---|---|
| move, block load | A, B of the block's 8 cells: 32 B/cell | | `move.js:636` (`f.load`) |
| move, write phase | **re-reads** own A, B, F (36 B/cell; L1 hits if the line survived the solve) | A, B, F: **36 B/cell, unconditionally**, even for a cell that didn't move | `move.js:690-705` |
| move, flow | 8 B (RMW) | 8 B | `move.js:709, 797-803`: every cell of every non-quiet brick, every step, also in quiet-base blocks (`move.js:874`) |
| move, deco / Whitewater | +4 B (deco plane, if any) | +4 (moveSrc) +36 (out-of-place copy of quiet blocks) | `move.js:707-708, 864-866` |
| react | own A, B, F 36 B; 6 face neighbours' A, B (192 B, ~25 % outside the brick) | A, B, F of the other copy: 36 B | `react.js:249-291, 971` |
| react, liquid head scan | ≤ `headScan` = NY cells' A up the column (stops when the Torricelli speed reaches the flow cap: a few cells) | | `react.js:545-553` |
| activity build (every 2 steps, over DRAWN ∪ marks dilated a brick) | 64 flags + **152 scattered halo flag words per brick** (6³ − 4³), then 7 A reads per matter cell when undecided | 1 word per brick | `activity.js:390-414` |

**DRAM-unique traffic per awake cell per step (est):** move 44 R + 44 W, react 36 R + 36 W, build ~7
amortised → **~167 B** (more at brick faces, with Whitewater ~+50 B: the out-of-place copy and the
aeration field). The L1/L2 traffic is about twice that (the move's re-read, react's 192 B of neighbours).

| 128³ world | awake share (Mac, scaling.md:218-221) | MB per step (est) | per frame at 4 steps | GB/s at 60 Hz |
|---|---|---|---|---|
| empty / asleep | 0 % | build only, ~0 when certified | ~0 | ~0 |
| island | 26 % | 91 | 364 | 22 |
| lab (legacy supertile share) | 39-42 % | 137-147 | 550-590 | 33-35 |
| lab, brick-level DRAWN (measured at 64³, section 5.1) | 25 % | 88 | 350 | 21 |
| volcano | 45 % | 158 | 630 | 38 |
| everything awake (fire, explosion, Snowy Depths) | 91-100 % | 320-350 | 1,280-1,400 | **77-84** |

Reference bandwidths (approximate; Apple publishes the Macs', not the iPhone's): M5 ~153 GB/s, M4 120,
M3/M2 100, M1 68; A19 Pro (iPhone 17 Pro Max) LPDDR5X, ~60-77 GB/s. A fully awake 128³ world at today's
step rate needs over half an M5's peak bandwidth for the sim alone and more than an iPhone has.

The Mac numbers agree the step is expensive per cell, and that it is not purely bandwidth-bound: react
alone is 1.2 ms on the settled lab and **3.6 ms with every cell stepped** (commit 5551bd7), i.e. 151 MB of
react traffic (est) in 3.6 ms = ~42 GB/s effective. React is long, branchy per-cell code (1,572 code lines,
section 8): it pays in ALU and divergence as well as bytes. Both need to shrink.

### 3.1 Why 4 steps per frame is a physics-architecture cost

A Margolus block moves a cell at most one cell per step. With 30 cm cells (`src/scale.js:18`), falling
and pouring speeds come from stepping often: 240 steps/s is 72 m/s of maximum displacement. TPT gets its
speed differently: each particle carries a velocity and `Simulation::UpdateParticles` walks it across
several cells in **one** update per frame (60 updates/s). Noita (GDC 2019, Purho) also updates its world
once per frame, in dirty rectangles per 64×64 chunk. So the 4× multiplier on every sim byte and every
version bump (which triggers the derived frame) is a consequence of the move rule, not of the GPU. Whether v2
keeps Margolus is the physics audit's call; the perf audit's point is that **steps per second is the
largest single multiplier in the frame** and has to be a budgeted, explicit number (section 10).

---

## 4. Derived passes per frame

### 4.1 What a derived frame touches

| Pass | Over | Bytes per listed cell (est) | Source |
|---|---|---|---|
| EMA | EMA list (bricks changed in the last 13 frames) | A 16 + EMA 12 RMW + aeration | `fields.js:76`, `derived.js:319-322` |
| blur x, y, z | **WORK = EMA dilated 2 bricks** | 24, 24, 28 | `fields.js:100-101`, `derived.js:323-326` |
| boost x (+ state A), y, z | WORK | 44, 24, 24 | `derived.js:327-330` |
| peak → 3 rgba16f textures | FIELDS = EMA dilated 1 brick | 52 | `derived.js:331` |
| brick map | FIELDS | ~45 (A, 2 field textures, open faces) | `passes.js:553-630`, `derived.js:344` |
| brickDist ×3, light blur ×6 | **all 32,768 bricks** | per brick, small (~1-2 MB a pass) | `derived.js:346-353` |
| shadow | **all 262,144 texels** (512² at 128³): a DDA through the box with brick skipping, field samples in surface bricks | 20 B written per texel (5.2 MB) + the march | `render.js:1344-1466`, `app.js:1850-1853` |
| giSource | every brick with matter (a workgroup each, a thread per cell) | A 16 + neighbours + 4 GI band loads | `gi.js:131-240`, `derived.js:395` |
| giGather | half the probes (16,384) × 32 rays × ≤ 12 brick steps = 6.3 M ray-steps | 16 B per step (giSrc) | `gi.js:46-63, 94`, `derived.js:403` |

**The field pipeline is ~305 B per WORK cell per derived frame (est).** One changed brick puts 1 brick on
EMA, 27 on FIELDS and **125 on WORK** (8,000 cells), and keeps them there for **13 derived frames**
(`FIELD_EMA_SETTLE`, the liquid channel's 0.35 blend reaching its 8-bit fixed point). A single grain falling
through air, crossing about a brick per frame at 4 steps/frame, keeps ~13 bricks on EMA and ~400 on WORK:
**~8 MB of field traffic per frame for one grain** (est), against ~1 MB for its sim. And "changed" means
*not quiet* in the activity map or written (`passes.js:438-460`, the age kernel: `ACT_CHANGED` or a writer mark), not "looks different": resting matter in the quiet
halo and sub-tolerance air drift keep the tail going (`docs/scaling.md:595-596` says so itself).

### 4.2 Mac and SwiftShader numbers

- Mac, legacy (scaling.md:577-594): `updateBricks` 3.0-4.1 ms per frame while the sim runs (lab 3.82,
  island 3.00, volcano 4.14), a full rebuild 4.1-4.6; WORK regions 54-92 % of the grid; **shadow and GI
  another 2.6-4.3 ms**. So the derived side is **5.6-8.4 ms of every frame in which anything moves**.
- SS (commit 164ecae, U9): a derived frame 224 ms at 32³ (GI 30 ms), **2,186 ms at 64³ (GI 470 ms)**;
  a 64³ lab step is 640 ms (commit db845aa). My 64³ frame (section 5.1): derived (full rebuild) + GI +
  shadow 6.4 s against 4.3 s a step. SwiftShader agrees with the Mac on the shape: **a derived frame with its
  shadow and GI costs about 1.5-3 sim steps**, and it runs every frame anything moves.

---

## 5. The frame on the Mac, assembled from the repo's own numbers

Legacy WebGL2 on the user's M5 at 128³ (sources in section 13). The port's targets (`docs/webgpu.md` A.3)
are step ≤ 0.6×, updateBricks ≤ 0.8×, view no slower.

| Frame part | Legacy M5, lab at Speed 4 | Port, if it meets every A.3 target |
|---|---|---|
| 4 steps | 4 × 1.81-2.6 = 7.2-10.4 ms | 4.3-6.2 |
| updateBricks | 3.8 | 3.1 |
| shadow + GI | 2.6-4.3 | 2.6-4.3 |
| view (realistic, god view at the default render scale; 9 ms close up at 1280×800) | ~3-9 | ~3-9 |
| post | ~1 (est) | ~1 |
| **total** | **~18-28 ms → 36-55 fps** | **~14-24 ms** |

Even a port that hits every target it set can't hold 60 Hz in the default box scene on the user's best
device, has no 120 Hz headroom, and an iPhone 17 Pro Max (roughly half an M5's GPU and bandwidth, est)
would land at ~20-35 fps before thermal throttling (its plain look and low resolution shrink the view, not
the sim or the derived passes). Everything awake is worse: 1M cells of water with
neutrons were 12-14 ms per *step* (particles.md:121-123), i.e. 50 ms of sim per frame at Speed 4. And the Descent levels, measured headless at 1280×800 on the
same Mac after their heat fix (commit 1def559): Mines 3 % awake 20-27 fps (~3.5 ms a step), Coal Pits 12 %
22 fps, Snowy Depths 21 % 17-19 fps; only the island at rest held 60.

### 5.1 Measured here (SwiftShader, 64³ lab)

`v2/perf/frame128.mjs --size 64` (log `v2/perf/run64.log`, JSON `v2/perf/frame-64-lab-v0.json`): the app at
`?size=64&preset=lab`, realistic view (SwiftShader leaves out relief, grains and clods), manual test mode,
400×250 viewport (TAAU at 2/3: ~267×167 = 44.5 K scene pixels). After the boot, 2 warm-up steps and 2 frames,
one measured frame = `test.step(4)` + `test.renderOnce()` with split timestamps (a pass per dispatch).

**What the frame recorded** (`gpu.stats` delta): 2 submits (the steps' own flush, then the frame), 75 dispatches
(19 indirect), 5 render passes, 7 draws, 7,749 direct workgroups, 18.6 KB uploaded, nothing allocated but the
timing's own resolve buffer. The API shape is exactly the budgets' (section 1.2).

**Brick-level activity of the lab at 64³** (`sim.readCounts()`): AWAKE 1,034 and DRAWN 1,037 of 4,096 bricks
(**25 %**), MOVE1 1,454 (35 %), the INERT list 1,939 (**47 %**: the build reads ~1.9× the bricks the step
runs). Brick-level sleeping does what W12 promised: the legacy supertile share for the lab was 39 %
(scaling.md:220). Matter is 11 % of the bricks: three quarters of what the sim runs is air near matter.

**Indirect workgroups** (args read back after the frame): react 4,148 (4 steps × ~1,037 bricks), move 624; and
every field pass and the brick map ran over **4,096 bricks, the whole grid**, because the frame fell inside
the load's rebuild window (the derived passes had run 3 times; the EMA tail is 13). So this frame shows the
derived passes' full-rebuild cost, which is also what every frame pays for 13 frames after a load, an undo,
a smoothing change or Whitewater toggling (`derived.js:276-292`).

**Split timestamps, SwiftShader ms for the one frame** (useless for ranking against a GPU; the shares say
where the *instructions* are):

| Stage | Kernels | SS ms | share |
|---|---|---|---|
| view | the realistic march + shading (`scene` pass) | 28,937 | **54.9 %** |
| sim, 4 steps | move 9,333 (4 × 2,333), react 5,249 (4 × 1,312), inert 2,412 (2 builds), inertList/quiet/drawn/move1/args 55 | 17,049 | **32.3 %** |
| derived (full rebuild) | brick 2,398, fieldPeak 564, fieldBlur ×2 263, boost0 193, boost ×2 128, fieldFinal 126, EMA 86, dirty/age/args 20, brickDist + light 8 | 3,785 | 7.2 % |
| GI | giSource 1,270, giGather 440 | 1,710 | 3.2 % |
| shadow | 256² rays at 64³ | 859 | 1.6 % |
| post | canvas 273, TAA 62, bloom + reduction 31 | 366 | 0.7 % |
| **total** | | **52,706** | |

Reading it with the caveats: SwiftShader runs every fragment on a CPU core, so the view's share is inflated
relative to a GPU; but even so, **44.5 K pixels of the realistic shader cost more than four steps of a 64³
simulation**, ~0.65 ms of CPU per pixel: the per-pixel work (section 6, `v2/audit-render.md` 2.8) is large
in absolute terms. Within the sim, the unrolled move costs 1.8× react here (SwiftShader penalises its
straight-line form, P9), and the activity build is 14 % of the sim. The brick map is the most expensive
derived pass, as on the Mac (scaling.md:586: 1.6-2.3 ms, "the brick pass is the biggest").

---

## 6. View and post

- The march is a fragment pass over the box's back faces: a brick-skipping DDA (`render.js:859-1090`), up
  to `MAX_STEPS = nx + ny + nz + 8` = 392 cell steps at 128³ (`core.js:301`) plus 128 after refraction.
  Each step in a non-empty brick reads 16 B of state (`fetchA`, `slotOf`'s ~15 integer ops) and, in
  surface bricks, two trilinear rgba16f field samples. Per pixel the realistic shading adds up to four
  secondary DDA walks, two traced reflections and PCSS (`v2/audit-render.md` 2.8; I don't repeat it).
- Pixels: `pixelRatio = min(devicePixelRatio, 1)` (`app.js:296`), TAAU 'quality' = 1/1.5 per axis on
  desktop: a 1512×982 CSS window renders ~1008×655 = 660 K pixels. Phones: 'performance' 1/2, the plain
  look, no near GI, glow lights, caustics or detail (`app.js:148-153`): ~105 K pixels on a 440×956 phone.
- Mac (detail.js:61-113, scaling.md:519-520): the base realistic view of a bark wall face-on 9 ms at
  1280×800; relief +39 ms, grains +17, clods +14, smoke filaments +16, Whitewater +1.4 ms in the view plus
  ~0.4 ms a step (~1.6 ms a frame at Speed 4); the world's far field 1.5-3 ms in the god view, 4-9 ms at
  native 1280×800.
- **Convergence is long.** TAAU's stable weight 0.05 means 109 frames to settle (77 with TAA; `post.js:195,
  202`, `pacing.js:29`). Every pointer move wakes the pacer (`app.js:1708-1709`) and buys 1.8 s of full-quality
  marching at 60 Hz (bug P6). A static camera over a changing world never settles at all.
- Post itself is cheap and well-shaped (3 render + 1 compute pass, `budgets/post.mjs`); ~40 MB of targets
  at 1512×982.
- CPU side of a presented tick (not measured; listed because phone CPU power counts too): the scene graph is
  walked up to four times (`createViewKey`'s scene watch, `pacing.js` `createSceneWatch`; `threeHasVisible`;
  `threeMeshes` for the opaque and the transparent pass, `app.js:1792-1813`), three settings objects are
  compared field by field as JSON would print them (`pacing.js` `jsonValue`/`sameJSONEntry`), and a hover
  pick is recorded and mapped back every presented frame (`app.js:1989`). Cheap at today's object counts; it
  grows with POV meshes, NPCs and birds.

---

## 7. The structural costs, ranked

Ranked by (share of a typical active frame) × (how much a redesign removes). "Typical" = the lab at Speed 4.

| # | Cost | Share today (est, Mac) | What it is | What removes it |
|---|---|---|---|---|
| S1 | **Step rate × step bytes** | 7-10 ms (35-40 %) | 240 steps/s × ~167 B per awake cell; two full passes per step plus a list build every second step | Velocity-carried multi-cell moves at 60 (or fewer) updates/s (TPT); one fused pass per update over workgroup tiles; packed state (§9.2) |
| S2 | **Derived work not scaled by change** | 5.6-8.4 ms (30 %) | shadow 262 K rays, GI over all bricks, 9 full-grid passes, fields over 125 bricks × 13 frames per changed brick, keyed on the step counter | One "visibly changed" brick set per tick drives every derived product; shadow and GI incremental and time-sliced (§9.1) |
| S3 | **Full re-march every presented frame** | 3-9 ms (20-30 %) | fragment march + heavy shading of every pixel while anything changes, 109 frames after | Raster for opaque matter from per-brick meshes rebuilt on change (Minecraft), march only media and liquids, converge-and-stop (§9.3) |
| S4 | **Memory footprint** | 400-650 MB | fp32 double-buffered state (72 B/cell), 76 B/cell of field scratch, whole-grid undo | Packed state, sparse brick pool (most bricks are air), fields at brick resolution or computed on the fly, brick-diff undo (§9.4) |
| S5 | **Sim locked to presentation** | (blocks 120 Hz) | `MAX_FPS` 60 caps the display because the sim steps per frame | A fixed sim tick, presentation at display rate with view-only frames between ticks (Minecraft's 20 TPS game tick) (§9.5) |
| S6 | **Shader size** | cold start; register pressure | 7.2 MB WGSL, ~33 KB prelude per kernel, 263 KB view, 125 KB unrolled move | Table-driven rules, small per-family preludes, ≤ 1,000-line kernels (§9.6) |
| S7 | **1 frame in flight on WebKit** | iPhone throughput | `device.js:153`: CPU and GPU serialize on Safari (workaround for an iOS 26.3 queue hang with many passes) | Fewer passes per frame, then 2 in flight; re-test on iOS 26.x (§9.5) |

---

## 8. Pipelines, shader size and compile time

`v2/perf/sizes.mjs` generated every `WGSL_CHECK` pipeline at 128³ in Node (no GPU): **98 pipelines, 7.77 MB
of WGSL (7.20 MB excluding tool-only ones)**; full list in `v2/perf/sizes.txt`. World, POV, rays and mesh
modules aren't merged at 42f4039, so the shipping total is larger.

| Pipeline | KB | lines | code lines | fns | consts | build time |
|---|---|---|---|---|---|---|
| volume realistic Full (`WGSL_MAC_ONLY`) | 314 | 6,499 | 5,009 | 368 | 1,177 | SS 15.2 s (U6) |
| volume realistic Balanced (default) | 263 | 5,400 | 4,150 | 320 | 1,074 | SS 9.3 s |
| volume plain / heat / pressure / flow / X-ray | 245-251 | 5,030-5,191 | 3,902-4,034 | 313-328 | ~1,060 | SS 0.1-0.8 s (Tint drops the dead library) |
| **move (unrolled, ships)** | **125** | **3,329** | 3,083 | 151 | 350 | **SS 11.6-14.4 s** (U2) |
| move (loop form, tool only) | 55 | 1,346 | 1,124 | 166 | 351 | SS 1.2-1.5 s |
| GI gather / source | 109 / 108 | ~2,470 | ~1,920 | ~220 | ~520 | |
| shadow | 101 | 2,281 | 1,777 | 211 | 521 | SS 0.5 s |
| react | 85 | 1,966 | 1,572 | 165 | 346 | SS 2.5-2.7 s; Mac (legacy) 2.3 s cold |
| paint, inert, brick, pick, fieldEma | 36-44 | 900-1,070 | | | | |
| **copy, blur, dirtyArgs, fieldShift, flowShift** (tiny kernels) | **30-34** | ~780-860 | ~660-740 | ~111-133 | ~305-331 | |
| post (all), overlays, brush | 0.6-13 | ≤ 276 | | | | |

- **A lab session in the realistic view builds ~1.7 MB of WGSL** (~40 pipelines: the sim's 13 = 619 KB, the
  derived passes' 13 = 427 KB, view + shadow + pick + GI = 619 KB, post and overlays 50 KB), plus 263 KB for
  the near-detail variant the detail gate prefetches.
- The **prelude tax**: every sim-side kernel includes `prelude()` (constants for every PHYS entry and element
  id, the tables struct and accessors, layout helpers, `canMove`, `inertSelf`, electricity, incandescence):
  a 6-tap blur is 30.5 KB and 669 code lines. Tint has to parse, resolve and DCE all of it per module;
  Safari does the same in WebKit's WGSL compiler before Metal compiles the MSL.
- **The unrolled move ships on a guess.** On SwiftShader the loop form runs 3× faster (30.1 vs 101.5
  ms/step at 32³, commit 06e9c88) and builds 9× faster, but the unrolled form ships because "a GPU is likely
  to spill" the loop form's arrays (commit db845aa). The Mac A/B (checkpoint M1) hasn't been run.
- Mac cold compile (legacy, commit 5551bd7): react 17-20 s before its single-exit fix, 2.3 s after;
  moveBlock 1.06 s; the view ~8 s (another session's report, `maps/external-perf-audit.md`, unverified).
  Dawn's and WebKit's pipeline caches make a second visit warm, but **every deploy that changes a module
  re-pays its compile**, and the element tables moved to a buffer (C6) helps only content-only deploys.
- SwiftShader can't draw relief, grains or clods at all (GPU process SIGSEGV at the first draw,
  `detail.js:117-125`): a signal that those modules are at the edge of what a shader compiler handles well.

---

## 9. What a redesign could remove

Each item: the change, what it saves (est), and where the idea comes from (CLAUDE.md touchstones first).

### 9.1 One change currency for everything after the sim (S2)

- The tick produces a per-brick **"visibly changed"** bit: id changed, or a quantised render-relevant value
  crossed a step (temperature band for glow, a phase, density). Sub-tolerance drift and settling flags don't
  count. Noita's per-chunk dirty rectangles are exactly this (GDC 2019).
- Fields, brick map, light: only those bricks + their reach, once (no 13-frame EMA tail: if the look needs
  temporal smoothing, smooth in the view's TAA, not in a 76 B/cell field pipeline). **Saves most of
  3-4 ms**; per changed cell ≤ 64 B (budget §10).
- Shadow: re-trace only texels whose sun ray crosses a changed brick (project the changed bricks' AABBs into
  sun space: a handful of dirty rectangles), or replace the map with a per-column sun-space height/opacity
  structure updated per brick. Full re-trace only when the sun moves (it moves slowly: `day.clock`).
  **Saves ~1-2 ms** of the 2.6-4.3 ms.
- GI: fixed per-frame probe budget (e.g. 1/8 of probes), prioritised by distance to changed bricks and to
  the camera; giSource only for changed bricks. **Saves ~1 ms.**
- brickDist and the light blur: incremental by changed bricks (they are separable 1-D passes with known
  reach). Small today at 128³, but they scale with the grid, not the change.

### 9.2 One fused update over packed state (S1, S4)

- **Packed cell**: 8-12 B instead of 72 B (two copies) + 8 (flow): e.g. id 9 bits, ctype 9, life 14, seed
  folded into a hash of position and tick, temperature f16 or 16-bit fixed, particle velocity 3 × 8-bit
  fixed point. **Pressure and air velocity at brick resolution**, as TPT keeps its air (`pv`, `vx`, `vy`)
  on a grid 4 times coarser per axis (`CELL = 4`); in 3D that is 1/64 of the cells. The `D7` branch
  (`origin/scale-pack-d7`, 16 B/cell) measured 8-10 % slower on WebGL2 because react decoded every
  neighbour (maps/external-perf-audit.md): decode once per tile in workgroup memory instead.
- **One pass per update**: a workgroup loads a tile (8³ cells + a 1-cell halo = 1,000 cells × 8-12 B,
  8-12 KB of workgroup memory) once, runs reactions then movement inside it, writes its 512 owned cells once.
  No second state copy (the halo snapshot is the "old" state), no separate list build pass (the tile knows
  whether it changed and appends itself for the next tick). Traffic per awake cell per update: read
  ~2 × 10 B (halo amplification ~1.95 at 8³), write 10 B: **~30 B, against ~167 B × 4 steps = 668 B per
  frame today: ~20× less per presented frame**, if the update rate drops to 1 per frame (S1).
- Flow, aeration, moveSrc: render-side quantities produced at the derived rate from the update's own
  displacement, not RMW'd for every non-quiet cell every step.

### 9.3 Stop re-marching what didn't change (S3)

- **Opaque matter as rasterised brick meshes** (Minecraft's chunk meshes, rebuilt only for changed chunks;
  here a compute pass emits faces for changed bricks into a GPU buffer, drawn indirectly). Apple's TBDR does
  hidden-surface removal before shading and keeps colour and depth in tile memory: rasterised opaque
  geometry is the most energy-efficient thing it draws. Liquids and gases, which need a volume look, keep a
  march, bounded to their bricks' screen footprint and started at the raster depth (the meshes-first
  `meshCut` already does this for three's meshes).
- **Converge and stop**: when camera and world are still, 2-4 frames to a final image (e.g. one
  un-jittered native-resolution frame), not 109. When only meshes move (the World's birds), re-composite
  the cached scene colour and depth and draw the meshes (`docs/webgpu.md` K3 "mesh-only frames").
- **Per-pixel budget**: no stochastic secondary DDAs that need 70-100 frames of TAA to converge; lighting
  comes from the (incremental) light/GI volumes. That is the render audit's subject; here it matters because
  it is what keeps the view running.

### 9.4 Memory (S4)

- **Sparse brick pool**: most bricks of a box or a world window are air. Built on the CPU exactly as the app
  builds them (`v2/perf/occupancy.mjs`, `presets.js`), at 128³ the lab is **6.0 % matter cells and 7.5 % of
  4³ bricks hold any matter** (10.6 % of 8³ tiles); the volcano 10.5 % cells, 11.8 % of bricks. Today every
  one of the 2,097,152 cells costs 156 B of state and fields; a pool of matter bricks plus air at brick
  resolution would hold ~1/8 of them. Allocate cell storage only for
  bricks with matter, behind a brick→pool indirection (which is also the toroidal window, `docs/webgpu.md`
  K3: a move rewrites the indirection, not 72 MB of state; legacy moves cost 4-6 ms GPU, scaling.md:412).
- **Undo as brick diffs**: the writers' GPU marks already know which bricks a stroke touched; save those
  bricks (a stroke of radius 5 touches ~30 bricks = 30 KB packed), not the whole grid (134 MB of copy
  traffic and 67 MB per snapshot today).
- **Fields**: either at brick resolution with analytic in-brick shape, or sampled on the fly from the packed
  state in the march; not 76 B/cell of persistent scratch.

### 9.5 Time base (S5, S7)

- A fixed sim tick (60 Hz on Mac, 30-60 on phone, a setting), presentation at the display's rate. Frames
  between ticks are view-only (camera, meshes, TAA), so 120 Hz on the MacBook doubles only view + post.
  Minecraft runs its world at 20 ticks/s and renders at any frame rate; TPT ties one update to each frame
  at 60 fps; either way the world's speed doesn't depend on the display.
- With fewer passes per frame (§9.1-9.3), re-test 2 frames in flight on WebKit; one in flight costs the
  iPhone the CPU/GPU overlap.

### 9.6 Shaders (S6)

- Element behaviour as data the kernel interprets (rule tables, as the tables buffer started, C6), not
  generated straight-line code: the move's 3,329 lines and react's 1,572 come from unrolled per-element
  code.
- A prelude per kernel family with only what the family calls; no kernel over ~1,000 lines; one realistic
  view module ≤ ~1,500 lines (render audit 2.8).
- Budget compile time on the Mac in CI-able form: `tools/compile-bench.mjs` already measures it.

### 9.7 What it adds up to (the lab frame on the M5, est)

| Step | Frame GPU ms | Why |
|---|---|---|
| today (legacy-measured algorithms, section 5) | 18-28 | |
| + the derived products driven by visible change (§9.1) | 13-21 | fields without the 125 × 13 tail, shadow by dirty texels, GI time-sliced |
| + one fused, packed update per frame (§9.2, §9.5) | 6-11 | 4 steps × 1.8-2.6 ms → one update at ~1/5 of a step's bytes |
| + raster for opaque matter, converge-and-stop (§9.3) | 4-7 | the march only where media and liquids are; no 109-frame tails |
| v2 budget (§10) | ≤ 4.5 typical | |

Each line is an estimate from the byte counts above and the Mac's measured split; the order of the rows is
the order of payoff per unit of work, not a plan.

---

## 10. v2 budgets

Assumptions: 128³ simulated cells on the Mac (the box default and the world window), 128×64×128 or 96³ on the
phone; the lab at the default speed as "typical active", an explosion or the Snowy Depths (≥ 90 % awake)
as "worst"; GPU time at the clocks the device sustains. Bytes = DRAM traffic (what costs energy; est. order
30 pJ/byte for LPDDR5X, so 10 GB/s ≈ 0.3 W).

### 10.1 Per presented frame

| Budget | M5 MacBook Pro, 60 Hz | M5, 120 Hz (sim tick 60 Hz) | iPhone 17 Pro Max, 60 Hz |
|---|---|---|---|
| internal pixels | ~660 K (1008×655) | ~660 K | ~110-420 K |
| **GPU ms, typical active** | **≤ 4.5** (27 % of the frame) | **≤ 4.0** per presented frame | **≤ 6.5** |
| GPU ms, worst case | ≤ 9 | ≤ 7 | ≤ 13 (then the tick halves, never the frame) |
| sim (amortised per presented frame) | ≤ 0.6 typical / 1.5 worst | ≤ 0.3 / 0.8 | ≤ 1.2 / 3 |
| derived: fields, bricks, light | ≤ 0.4 / 1.2 | ≤ 0.2 / 0.6 | ≤ 0.6 / 1.5 |
| shadow + GI | ≤ 0.5 / 1.0 | ≤ 0.3 / 0.6 | ≤ 0.6 (GI optional) |
| view | ≤ 2.5 / 4.5 | ≤ 2.6 / 4.0 | ≤ 3.0 / 6 |
| post | ≤ 0.5 | ≤ 0.5 | ≤ 0.6 |
| **DRAM bytes, typical** | **≤ 120 MB** (7 GB/s) | ≤ 70 MB (8 GB/s) | **≤ 50 MB** (3 GB/s) |
| DRAM bytes, worst | ≤ 300 MB | ≤ 160 MB | ≤ 150 MB |
| camera moving, world asleep | view + post only, ≤ 3 ms | ≤ 3 ms | ≤ 3.6 ms |
| camera still, world asleep | **0 submits, 0 rAF** (kept) | same | same |
| camera still, world changing | only the changed screen tiles re-shaded | same | same |
| sustained GPU power, typical | ≤ 5 W | ≤ 6 W | **≤ 2 W** (no throttling over 30 min) |

Today (est, from sections 3-5): ~18-28 ms and ~0.7-1.0 GB per lab frame on the M5.

### 10.2 Per simulation tick and per changed cell

| Budget | v2 | today (est) |
|---|---|---|
| DRAM bytes per awake cell per update | **≤ 32 B** | ~167 B per step × 4 steps per frame |
| updates per presented frame at 60 Hz | 1 (or a fixed tick independent of the frame) | 4 |
| asleep world, per tick | ≤ 0.02 ms, ≤ 64 KB (the tile list), 0 when certified | 0 when certified; a build every 2 steps otherwise |
| derived bytes per visibly changed cell | **≤ 64 B**, once (no settle tail) | ~305 B × 125-brick dilation × 13 frames, + full-grid shadow/GI |
| shadow texels re-traced per changed brick | its sun-space footprint (the map is 4 texels a cell at 128³, so a brick projects to ~16×16 texels plus its slant: ~300-500 texels) | all 262,144 |
| GI probes traced per frame | fixed slice, ≤ 4,096 at 128³ | 16,384 |

### 10.3 Memory and compile

| Budget | Mac | iPhone |
|---|---|---|
| GPU resident at 128³ (iPhone: its grid) | ≤ 400 MB | ≤ 200 MB |
| state per cell, all copies | ≤ 12 B (today 80) | ≤ 12 B |
| derived per cell | ≤ 16 B (today 76) | ≤ 8 B |
| undo | brick diffs, ≤ 32 MB ring (today ≤ 201 MB) | ≤ 16 MB |
| WGSL compiled per session | ≤ 600 KB (today **~1.7 MB** for a lab session in the realistic view: sim 619 KB, derived 427 KB, view + shadow + pick + GI 619 KB, post and overlays 50 KB; +263 KB for the prefetched near-detail variant) | same |
| largest kernel | ≤ 1,000 code lines | same |
| cold boot to first interactive frame, fresh pipeline cache | ≤ 3 s | ≤ 5 s |
| any one pipeline's Metal build | ≤ 300 ms | ≤ 500 ms |

### 10.4 Making them enforceable

`tools/budget-check.mjs` and `tools/budgets/*.mjs` already assert dispatch, pass, submit and allocation
counts per scripted frame; keep that and add, for v2: bytes allocated per cell (memory), workgroups per
changed brick (change-scaling: one grain must not cost what a flood costs), view frames after a still
camera (≤ 4), derived frames after the last change (≤ 1), and a Mac/iPhone timestamp run of the same
scenarios (`tools/power.mjs`, I5) as the real judge.

---

## 11. Perf bugs found (not design choices; fixable in v1 too)

| # | Severity | Bug | Evidence |
|---|---|---|---|
| P1 | high | **The derived frame is keyed on the step counter, not on change.** Any step that ran (one grain, air drifting below every render tolerance) re-runs the whole derived frame, shadow and GI, and forces the view; then 22 more frames after the last step. | `app.js:1961-1962` (key `${sim.id}:${sim.version}`), `sim.js:622` (`version += 2` on every non-idle step), `app.js:1700, 1846-1858, 1963-1967` |
| P2 | high | **The shadow map is re-traced in full on every derived frame**: 262,144 DDA rays (512² at 128³) and 5.2 MB of writes, whether the sun moved or one brick changed (and with the day cycle on, `daylight.js` `DAY.running`, off by default, the sun is in the derived key and moves every tick, so the whole derived frame runs every frame even in a sleeping world). | `render.js:1344, 1450-1465`, `app.js:1850-1853`, `gfx/volume.js:66-68` |
| P3 | high | **The field pipeline's tail and reach multiply every change ~125 × 13**: WORK is the EMA set dilated 2 bricks, kept for 13 frames, and "changed" is activity (non-quiet), not a visible change. | `fields.js:76, 100-101`, `derived.js:314-332`, `docs/scaling.md:595-596` |
| P4 | medium-high | **Undo snapshots copy the whole grid on every stroke** (A and B current copies: 67 MB copied, 134 MB of traffic per click at 128³) and keep up to 3 (201 MB). The writers' marks already know which bricks a stroke touched. | `sim.js:63, 908-921`; `app.js:845, 942, 1458, 1480, 1495` |
| P5 | medium-high | **One frame in flight on WebKit** serialises CPU and GPU on Safari, the iPhone's only engine. It works around an iOS 26.3 queue hang with many passes per command buffer; it was never re-measured. | `gpu/device.js:39, 153`, `docs/webgpu.md` B3 |
| P6 | medium | **Every pointer move buys 109 frames of full march.** `pointermove` wakes the pacer (`app.js:1708-1709`), the brush is drawn inside the scene pass (`app.js:1837`) and is part of the view key (`app.js:1965`), so moving the cursor re-marches every pixel and re-converges TAAU from scratch (`post.js:202`). | as cited |
| P7 | medium | **The move rewrites every cell of every non-quiet block** (A, B, F: 36 B) even when nothing in the block moved, and read-modify-writes the render-only flow field (16 B) for every cell of every non-quiet brick every step, quiet-base blocks included. | `move.js:690-710` (`writeState` unconditional), `move.js:797-803, 874` |
| P8 | medium | **giSource runs over every matter brick every derived frame** and giGather over half of all probes, with no change test: GI is the realistic view's fixed per-frame tax. | `derived.js:381-410`, `gi.js:92-94, 174-183` |
| P9 | medium | **The unrolled move ships unmeasured on the target.** On SwiftShader it builds in 11.6-14.4 s against 1.2-1.5 s for the loop form and runs 3× slower; the choice rests on "a GPU is likely to spill" the loop form; Mac checkpoint M1 hasn't run. | commits 06e9c88, db845aa, e4f2333; `move.js:907-912` |
| P10 | low-medium | **Every compute kernel carries the full prelude** (~30-35 KB, ~330 consts, ~115-135 fns): a 6-tap blur is 30.5 KB. 98 pipelines, 7.2 MB of WGSL to parse and resolve at boot and on every deploy that changes `common.js`. | `v2/perf/sizes.txt`; `shaders/common.js` `prelude()` |
| P11 | low | **brickDist (3 passes) and the light blur (6 passes) run over all bricks** every derived frame. Small at 128³ (~1-2 MB a pass), but they scale with the grid (98,304 bricks in the giant volcano), not the change. | `derived.js:346-353` |
| P12 | low | **The inert build's halo scan** reads 152 flag words per listed brick from six neighbouring bricks' runs (poorly coalesced: each word sits in a different 64-cell run), every second step. | `activity.js:393-401` |
| P13 | low | **Boot writes a blank state through the CPU**: `blankState()` builds two 33.5 MB `Float32Array`s and uploads them through the 67 MB atlas scratch, which test mode keeps for the session (part of the 408 MB measured at boot). | `sim.js:366-367, 850-890, 867-869, 1030-1050` |

---

## 12. Keep

- `src/gpu/*`: one device, one open encoder, flush rules, the dynamic-offset param ring, async pipelines with
  explicit layouts, readback rings recorded at the request, `gpu.stats`, timestamp split mode, device-loss
  routing. API overhead per frame is already low (1 submit, ~76 dispatches).
- Brick-major slot order and the rule that physical indices come only from `brickId/slotOf/cellOf/brickCoord`
  (C2): it is what makes a brick pool or a toroidal window a local change.
- GPU-built brick lists with indirect dispatch, exact skipping and its proofs (skip-model, I2.2,
  activity-check), and box-scoped edits that mark their bricks on the GPU: the right primitives for a
  change-driven v2.
- The fused in-place Margolus move as an idea (one pass, one copy) if v2 keeps Margolus at all.
- Deep idle: 0 submits, 0 rAF when settled; `createViewKey`.
- "Incremental is exact or it isn't done" and the A/B tools (derived-check, sim-check's sleep stage).
- Post's shape (3 render + 1 compute pass), the opaque canvas, on-demand pipeline building, warm-up on the
  menu.
- The measuring tools: sim-bench, derived-bench, compile-bench, detail-bench, budget-check, power.mjs (I5).

---

## 13. Evidence index

Run here (all under `v2/perf/`):
- `sizes.mjs` → `sizes.txt`: every `WGSL_CHECK` pipeline generated at 128³ in Node (size, lines, functions,
  constants).
- `occupancy.mjs` → `occupancy.txt`: matter share of the empty, lab and volcano presets at 128³ per cell and
  per 4³/8³/16³ unit, built on the CPU by `presets.js` as the app builds them.
- `settle.mjs`: the settle counts (`FIELD_EMA_SETTLE` 13, per-channel 0-13, GI 22, dilations 1 and 2 bricks).
- `frame128.mjs` → `census-128.log`, `census-128-lab-realistic.json` (memory at 128³), `run64.log`,
  `frame-64-lab-v0.json` (the 64³ frame: stats, per-pass split timestamps, indirect workgroups, counts).
  Launched through `tools/browser.mjs` `launchBrowser`/`newTestPage` (manual mode) and `tools/vite-server.mjs`
  on port 5947 with `strictPort`; every browser and server closed in `finally`.

Mac numbers quoted (legacy WebGL2 build, the user's M5, ANGLE/Metal, 128³ unless said):
- `docs/scaling.md:216-229` step times by scene and awake share (empty 0.182, island 1.43, lab 1.81,
  volcano 1.96 ms; drawing everything 0.90-2.51); `:561-562` lab step 2.6 ms with 42 % skipped, 3.75 with
  none, derived ~3.4 ms; `:577-594` updateBricks per scene, brick pass 1.6-2.3 ms, shadow + GI 2.6-4.3 ms;
  `:412-414` a window move 4-6 ms GPU; `:519-521` the far field's cost.
- `docs/particles.md:121-123`: 65,536 neutrons in 1M water cells, 12-14 ms per step.
- `src/gfx/detail.js:61-113`: per-feature view costs at 1280×800 (base 9 ms face-on bark wall; relief, grains,
  clods, filaments, Whitewater).
- Commit 5551bd7: react cold build 17-20 s → 2.3 s; react 1.2 ms per step settled, 3.6 ms every cell.
- Commit 1def559: Descent fps and ms per step by level; commit 22692b4: Snowy Depths 5 fps at 91 % awake.

SwiftShader numbers quoted (units' commits on this branch):
- db845aa (U2): 32³ lab 192 ms/step = inert 21 + move 97 + react 72; 64³ lab 640 = 88 + 321 + 225.
- 06e9c88, e4f2333, 7c0d306 (U2): move loop vs unrolled 30.1 vs 101.5 ms/step at 32³; pipeline builds
  loop 1.2-1.5 s, unrolled 11.6-14.4 s, react 2.5-2.7 s; aeee074: sleeping/all-drawn 0.87 at 72 % DRAWN,
  1.06 at 100 %.
- df3356a, 64ade15 (U6): view module builds (realistic full 15.2 s, balanced 9.3, off 8.4, data views and
  plain 0.1-0.8, shadow 0.5, pick 0.15 s); relief/grains/clods crash SwiftShader's GPU process at first draw.
- 164ecae (U9): derived frame 224 ms at 32³ (GI 30), 2,186 ms at 64³ (GI 470).

Hardware figures (approximate, public): M5 unified memory ~153 GB/s, M4 120, M3/M2 100, M1 68; A19 Pro
LPDDR5X, bandwidth unpublished, ~60-77 GB/s by its memory type; LPDDR5X energy order 30 pJ/byte. Treat
them as orders of magnitude; `tools/power.mjs` (I5) on the user's devices is the judge.

Touchstones cited: TPT (one particle update per frame, velocity walked across cells in
`Simulation::UpdateParticles`; air pressure, velocity and ambient heat on the `CELL = 4` grid); Noita
(GDC 2019, Purho: 64×64 chunks with dirty rectangles, the world updated once per frame); Minecraft (20 game
ticks per second independent of the frame rate; 16³ chunk-section meshes rebuilt only when a block in them
changes).
