# Judge 1 (engineering): CRISP vs FIDELITY vs LEAN

Lens: a senior GPU engineer who has shipped WebGPU and Metal games. The questions: does it run on WebGPU core in Chrome
and Safari 26? What is the real performance per watt on Apple Silicon (bandwidth, passes, register pressure, compile
time)? How big is the bug surface, how much effort and risk, how much of the port's foundation is reused, and are the
budgets believable?

Inputs: the three pitches; the four audits; `docs/webgpu.md` A-F, K and the Sync log; the code on
`claude/webgpu-port` (head 976f008; the pitches cite 42f4039). I also re-read each pitch's evidence: Crisp's face
counts and CPU mock, Fidelity's WebGPU prototype and traversal counts, and Lean's CPU sim prototype and its log.
Every number marked "est." is my own arithmetic.

---

## 0. Verdict

**Recommendation: a hybrid. Lean's engine, drawn by Crisp's frame, with three grafts from Fidelity.**

- **Take from Lean:**
  - the sim: 16 B per cell, one copy, updated in place;
  - three motion paths: column fall, the block pass, and particles for sideways motion;
  - the liquid model its CPU prototype validated;
  - the iPhone as the reference device, the runtime governor and the CI budgets;
  - 4 B faces that read T, fill and glow live, so those changes never trigger a remesh;
  - a per-cell light grid.
- **Take from Crisp:**
  - native resolution with 4× MSAA kept in tile memory, and no TAA, so a frame is final the first time it is drawn;
  - the max-plus light update with its exact convergence argument;
  - gases kept as cells that can rest;
  - the phasing, where every system ships on its own.
- **Take from Fidelity:**
  - per-brick occupancy masks as the one shared acceleration structure;
  - immediate cell damage for charges smaller than an air cell;
  - its GPU prototype harness as the P0 measuring tool.

Why not one pitch whole:
- **Crisp** is the best-balanced design, but it has four verified defects (§3.1) and its sim pushes all vertical motion
  through particles.
- **Lean** has the cheapest and best-evidenced sim, but its renderer uses TAAU at 2/3 resolution and a copy pass.
  For cheap raster shading on a tile-based GPU (TBDR), that combination costs more DRAM than native MSAA, not less
  (§2.1), and it softens exactly the crisp blocks the look depends on.
- **Fidelity** has the highest visual ceiling and the worst performance per watt, complexity and risk. Its best ideas
  (masks, sub-air-cell blast damage, an optional reflections tier) graft onto a raster base.

### Scores (1-10, higher is better; `risk_effort` 10 = least risk and effort)

| pitch | look | feel | perf/W | simplicity | risk/effort | fixes pain points |
|---|---|---|---|---|---|---|
| CRISP | 7 | 7 | 7 | 7 | 6 | 8 |
| FIDELITY | 8 | 7 | 4 | 3 | 3 | 7 |
| LEAN | 6 | 7 | 8 | 6 | 7 | 8 |
| **recommended hybrid** (est.) | 7-8 | 7-8 | 8-9 | 6 | 6 | 9 |

---

## 1. What I checked against the code

| claim or assumption | finding |
|---|---|
| Crisp: "the in-place, race-free kernel from the port carries over unchanged" | `docs/webgpu.md` D2: the fused move is race-free **only because every read is of the thread's own 8 cells**. Crisp's repose rule reads outside the block: a 2-cell drop for *steep*, a 2-cell run for *flowing*. In place, that is a read/write race against the neighbouring block's thread. Lean (an occupancy snapshot) and Fidelity (ping-pong) handle it; Crisp doesn't. |
| All: 2 frames in flight | `src/gpu/device.js:153`: `maxFramesInFlight = isWebKit ? 1 : 2`. Safari serialises CPU and GPU today. Every pitch lists "re-test 2 in flight" as a risk; none budgets for it staying at 1. |
| All: indirect dispatch cost | B3: Chrome injects a validation dispatch before every `dispatchWorkgroupsIndirect`, and Metal's serial compute encoder drains each one. Lean's ~20 dispatches per busy tick are really ~30-35. Fidelity's "9 dispatches per tick" is an undercount, because the flux needs at least 2 dispatches per substep. Fine at 60 Hz either way. |
| Raster pitches need MSAA and indirect draws | `src/gpu/kernels.js:343-385`: `gpu.renderPipeline` already takes `multisample` and records `drawIndirect` and `drawIndexedIndirect`. The foundation supports both raster pitches as is. |
| Optional features | `device.js:37`: only `timestamp-query` is requested. `indirect-first-instance`, `dual-source-blending` and `rg11b10ufloat-renderable` aren't, so the designs must work without them (§2.7). |
| MSAA without transient attachments on Safari | three 0.186.1 feature-detects `GPUTextureUsage.TRANSIENT_ATTACHMENT` (`WebGPUTextureUtils.js:359`). Where a browser lacks it, MSAA samples stay allocated. With `storeOp: 'discard'` they still cost memory, not bandwidth. |
| three interop for each frame shape | Sync S1 already renders three's opaque meshes first into the scene target; our pass loads that colour and samples three's depth. Both raster pitches fit this. Fidelity's G-buffer needs three's `MRTNode` (present in 0.186.1), and every mesh material must then write our G-buffer encoding. That is more surface than the pitch admits. |
| Face counts | Crisp's `faces.txt` is consistent with Lean's quote: lab 41,148, volcano 36,152, Dam Valley 135,930 exposed faces. These are trivial loads for a TBDR raster. |
| Fidelity traversal | `fid/results-128.json`: **6-18 iterations per primary ray** at 128³, measured. The hierarchy works. The *time* per iteration is an ALU-bound model (§3.2). |
| Lean sim outcomes | `lean/lean-sim.log` on its CPU prototype: the slab is 1 cell thick on the ideal curve; heaps are round and sleep 1.6-2.7 s after the pour; the U-tube ends within 0.07 cell; the partial layer is flat to 0.02; the puddle rests at 14.5 s; mass drift is 0. The pipe is still draining at 60 s (tank level 5.1) and the jet leaves at 0.80×√(2gh). Sequential CPU code, so it can't show races, but it is the only sim evidence any pitch has. |

---

## 2. Cross-cutting engineering findings (they apply to whichever design is built)

### 2.1 Native resolution with 4× MSAA beats TAAU at 2/3 on Apple TBDR, for shading this cheap

Both raster pitches shade a face pixel with ~150-200 ALU and 3-5 texture taps.
- **ALU.** At native resolution that is ≈ 0.3 G ops per frame on the Mac (1.48 M px) and ≈ 0.19 G on the iPhone
  (0.95 M px). That is about 0.1 ms on an M5 and about 0.15 ms on an A19 Pro (est.). TAAU at 2/3 saves at most
  ~0.1 ms of ALU.
- **DRAM per frame at the Mac's output** (est.):

  | path | stores the scene (colour, depth, motion) | present pass | total |
  |---|---|---|---|
  | TAAU 2/3 (Lean) | 0.66 M × 16 B = 10.6 MB | reads 7.9 MB of scene + 11.9 MB of history; writes 11.9 MB of history + 5.9 MB of canvas | **≈ 48 MB** (Lean's own table: 46) |
  | native 4× MSAA, resolved in tile | 1.48 M × 8 B colour + 2-4 B linear depth ≈ 15 MB; the MSAA samples are discarded | reads 12 MB, writes 5.9 MB of canvas | **≈ 33 MB** |

  The iPhone at output size: ≈ 31 MB (TAAU) against ≈ 21 MB (MSAA).
- **Time to a final image.** TAAU needs about 8 jittered frames after every camera stop. MSAA needs 1.
- **Image quality.** TAAU ghosts falling cells and blurs nearest-filtered pixel-art patterns. MSAA does neither.

So for this shading cost, TAAU is a carry-over from the expensive-shader world. Keep render scale as the governor's
knob (lower native resolution with a sharp upscale, plus Lean's Crunch mode), not temporal accumulation.

### 2.2 Never break the MSAA pass mid-frame

Ending an MSAA render pass to copy colour, as Lean's liquid pass does, forces the MSAA attachments to be stored:
1.48 M × 4 samples × 12 B ≈ **71 MB** on the Mac (est.).

The design that keeps MSAA in tile memory has two passes:
1. **Opaque pass (MSAA):** faces, then the three composite, resolved in tile to colour plus a linear-depth colour
   attachment. rgba16f plus r32f is 12 B per sample, under the 32 B `maxColorAttachmentBytesPerSample` limit.
2. **Liquid pass (1×):** liquid and glass faces depth-test by hand against the resolved depth, and read the resolved
   colour as a texture. No copy and no aliasing hazard, because the target is a different texture. This keeps Lean's
   refraction and Lean's per-pixel RGB Beer-Lambert walk through the state.

Crisp's alternative is two blended draws (multiply, then add). It is cheaper, but it absorbs by a run length baked
into the face: `run / |rd·n|` measured to the far wall or floor. So a body standing in a pool is tinted as if it
were at the pool's floor, and oblique views through corners are wrong. With `dual-source-blending` (optional) the
two draws become one, which makes it a fine cheap path for thin glass, but not for bodies of liquid.

### 2.3 Partial render-target updates aren't free on TBDR

Crisp re-renders the shadow map "only inside the sun-space rectangle" with a scissor. Metal has no render area, so
expect a `load`/`store` pass to move the whole attachment: 2 × 8 MB for a 2048² depth16 map per update, at up to
60 Hz while anything moves. That is ≈ 1 GB/s against the iPhone's ~3 GB/s budget (est.; measure in P0).

Two fixes:
- Lean's 1024² map at ≤ 30 Hz: about 0.24 GB/s.
- A shadow map split into a texture array of tiles, re-rendering only the dirty tiles, each as its own small pass.

For underwater sun, Lean's 128×128 per-column liquid-depth map tints sunlight without a translucent shadow target.

### 2.4 Sleep must be certified over a full cycle of Margolus offsets

Crisp draws the partition offset at random per axis each tick, and sleeps a brick after **two** quiet ticks. A grain
whose only open lower neighbour is an edge diagonal shares a block with it on 1/4 of offsets. Two random ticks miss
it with probability (3/4)² ≈ 0.56; for a corner diagonal, (7/8)² ≈ 0.77.
- The result: premature sleep is the *common* case, heaps freeze at the wrong angle, and sleeping on and sleeping off
  diverge, which breaks D8.10.
- The fix: Lean's and Fidelity's rule. Cycle through all 8 offsets deterministically, and certify quiet only after a
  full 8-tick cycle (133 ms of extra awake time, which is nothing).

### 2.5 Vertical motion belongs in the grid, not in particles

In Crisp and Fidelity, *every* non-solid cell with air below leaves the grid as a particle, and Crisp's liquids leave
as up to 8 droplets of ⅛ cell each. So particle counts scale with the size of the event:
- a collapsing sand block of a few thousand cells is a few thousand particles;
- a 20³ water blob painted in mid-air is 8,000 cells × 8 = **64,000 droplets, Crisp's whole cap**, after which cells
  "wait a tick" (visible stalls);
- a dam break is a particle storm.

Lean's column pass moves vertical runs of any length exactly (its slab stays 1 cell thick on the ideal curve), and
its flux moves falling liquid in the grid. Particles are left for what actually has sideways speed: jets, throws,
splashes, debris. That keeps particle counts proportional to *spray*, not to *mass*, and the column pass is
race-free by construction, since one thread owns a column.

### 2.6 In-place kernels can only read their own block

This follows from §1. Lean's occupancy-bit snapshot (256 KB at 128³) is the cheapest fix: a stale snapshot only
changes a decision, never conservation or determinism. Particle claims and deposits need words of their own, or a
claim field in an empty cell's word. Crisp's `atomicAdd` of mass into a word that packs `mass u16` with flux bits
would carry into the flux; give deposits a separate u32 accumulator gathered by the flux pass.

### 2.7 Pitfalls of WebGPU core for whichever design is built

- **`drawIndirect` with `firstInstance ≠ 0`** needs the optional `indirect-first-instance` feature. Cull into one
  compacted list per pipeline and draw with `firstInstance = 0`, as Crisp's single draw list does. Don't issue one
  indirect draw per chunk.
- **Storage buffers in the vertex stage:** core allows them, and Lean's vertex pulling and Crisp's instance pulling
  both depend on them. Count them against the 8 storage buffers per stage.
- **f16 in storage without `shader-f16`:** `pack2x16float`/`unpack2x16float` are core. 64-bit masks are `vec2u` with
  `countOneBits`.
- **Optional fast paths, detected at runtime:** `dual-source-blending` (one translucent draw),
  `rg11b10ufloat-renderable` (a 4 B colour target), and transient attachments (MSAA memory on the phone).
- **One frame in flight on WebKit:** design for 1 and celebrate 2. Fewer passes per frame (§4) is the precondition
  for retrying 2 on iOS 26.x.
- **Rule interpreters:** the move today holds ~112 live scalars and is "likely to spill" on Apple (D2). Keep each
  kernel ≤ ~600 lines with runtime-bounded loops over the tables buffer, and measure Metal compile per pipeline early
  (`tools/compile-bench.mjs`).

---

## 3. Pitch by pitch

### 3.1 CRISP: "every cell is a block you can read"

**Strong.**
- It is the most coherent whole design, and the frame shape is right for TBDR:
  - one MSAA scene pass with an in-tile resolve and no TAA, so a frame is final when first drawn;
  - one material function, one light function, one emission function, and one sky;
  - ≤ 700-line view kernels.
- The max-plus light update comes with a correct convergence proof. The levels are bounded, so a Jacobi warm start
  reaches the full-recompute answer within 15 iterations, which makes the incremental update testable against the
  full one.
- Gases stay cells, with aging diffusion so they can rest, and draw as puffs. That keeps TPT's identity.
- The phasing is the best of the three: P1 is the renderer on today's sim, and core, water and air each ship
  separately.
- Its CI budget list is concrete: workgroups per changed brick, view frames after the camera stops = 0, and bytes
  allocated per cell.

**Defects, verified:**
1. **Premature sleep** with random offsets and a 2-tick window (§2.4).
2. **Data race** in the in-place swap pass's repose lookahead (§1, §2.6).
3. **The 2-cell light grid leaks** through 1-cell walls, which the lab tank and the Descent corridors are made of
   (Lean's point, and correct).
4. **Liquid absorption** uses a run length baked into each face, which is wrong for bodies in water and for oblique
   views (§2.2).
5. **Particles for all unsupported matter** (§2.5).
6. **The scissored shadow update** costs more than estimated on TBDR (§2.3).
7. **The glow band lives in the face**, so cooling lava re-meshes its chunks continuously. Lean's live read of T
   avoids that.

**Budgets.**
- The scene pass (~1 ms on the Mac) and the tick (~0.5 ms) are believable.
- The shadow, the light halo and particle-storm cases are understated.
- Memory of ~200 MB on the Mac is fine.
- Without transient attachments on Safari, MSAA adds ~45 MB on the phone, which is acceptable.

**Reuse.** High: `src/gpu/*`, post's AgX, bloom and histogram, the edit kernels, the lists, the run counter, the
world generator, conduction, latent heat and electricity.

**Risk.** Medium. Every defect has a known fix, but the pitch has no sim evidence: its mock is only a render.

### 3.2 FIDELITY: high-fidelity voxels (Teardown lineage)

**Strong.**
- The highest ceiling of the three: per-pixel hard sun, bounce light, mirror reflections and refraction, and light
  through canopies.
- The only pitch with **real WebGPU code**, and its 6-18 iterations per primary ray at 128³ are a measured, encouraging
  number.
- The hierarchy (sector bits, then per-brick 64-bit any/opaque masks, then cells) is small (~1.3 MB) and generally
  useful.
- Ping-pong Margolus with an 8-tick offset cycle is correct.
- The Teardown-style immediate cell damage inside a small blast radius is the right complement to a 1.2 m air grid.
- It defines a go/no-go on iPhone timestamps in week 1, which is the right control.

**Problems.**
1. **Performance per watt is structurally the worst.**
   - Every pixel is traced in compute whenever the camera moves, plus 1/K of pixels trace a cache-update ray, plus two
     rays and a march per water pixel. The outputs are storage writes that bypass tile memory.
   - The time model assumes ALU-bound traversal at 50 % lane efficiency, 20 G iterations/s on an M5. Hierarchical
     DDA with dependent loads is latency-bound, and the `light` kernel's ray state machine (material, cache, media,
     water) will be register-heavy, so occupancy drops.
   - Expect 2-4× its estimates (est.): a close-up through water at ~3-8 ms on the M5, against its 1.9 ms.
   - Its phone budget is bought by rendering ~250 K internal pixels (about 0.6× CSS per axis), upscaled with TAAU.
     That is soft on a 460 ppi display.
2. **Internal contradictions.**
   - The radiance cache *is* a stochastic estimator: 1/K pixels with one cosine ray each, blended with α = 0.06, which
     is ~50 frames to converge. That contradicts both "no stochastic per-pixel term, so no shimmer" and "converge and
     stop in ≤ 8 frames".
   - Expect cell faces to flicker and lag independently when sparsely sampled (far faces, phone K = 1/16).
3. **The largest bug surface:**
   - bake and the micro shaper (render-only ramps in *air* cells that the POV body can't stand on);
   - the trace/light wavefront and the cache's hash insert, eviction and emitter clustering;
   - TAA with disocclusion, three's MRT G-buffer, and screen-space fluid splats;
   - the media march with a sun-transmittance volume.
4. **Compile time.** The prototype megakernel built in 20-100 s on SwiftShader with one `trace()` call site and
   376 s with five. A ≤ 1,200-line `light` kernel will likely take several seconds to compile on Metal. Warm-on-menu
   hides it, but every deploy pays it.
5. **The look evidence** shows the micro shaper making the 5.8 m flank busy (the pitch admits it). The palette work
   hasn't started.

**Reuse.** Medium: TAA/TAAU (a cost, §2.1), post, sky, and the DDA idea. The renderer is all new compute.

**Risk.** High. Each of the five problems needs a hardware measurement before building on it.

### 3.3 LEAN: "do less, do it once, do it only where it shows"

**Strong.**
- It is the only pitch with **sim evidence**, from a 3D CPU prototype that keeps GPU ownership discipline (a thread
  per column, a thread per block reading only its own cells plus a snapshot, integer transfers). It validates the
  liquid, heap, slab and jet outcomes the audits showed failing.
- **Single-copy 16 B in-place state:** ~40 B per awake cell per tick, the best of the three.
- **The column pass** (§2.5) keeps particle counts proportional to spray, not mass.
- **4 B faces with live state reads:** fill, temperature and glow never re-mesh, so cooling lava or a rising lake
  costs no mesher work.
- **The per-cell light grid** doesn't leak.
- **Budgets enforced at runtime** (the governor) and in CI. The iPhone is the reference device and the phone gets
  the same game.
- The kill list's discipline cuts bug surface: radial gravity's cube, the plain view, the far marcher, the CPU twin.

**Problems.**
1. **TAAU at 2/3 resolution plus a copy pass** costs more DRAM than native MSAA for this shading (§2.1, §2.2), and
   softens the blocks and patterns the look rests on. The copy-pass bytes aren't in its table (~15-20 MB a frame
   whenever water is visible, est.).
2. **"Gases are not cells"** is cheap but changes the game's identity for a TPT descendant: no gas pipes, no painted
   hydrogen pockets, smoke as 1.2 m blobs. How species react with cells (an H₂/O₂ blast, CO₂ smothering) is only
   sketched. The pitch lists it as risk 4 and 8; I'd not take it.
3. **Recomputing the light from scratch over dirty boxes** (box dilated 16 cells, then a flood) is heavier per change
   than Crisp's warm-start max-plus, and the per-tick cap makes "exact" lag under load. Use the warm start on Lean's
   grid.
4. **Face pages per brick** need a GPU free-list allocator. A fixed worst-case slab per 16³ chunk is 12,288 faces ×
   4 B = 48 KB, or ~25 MB at 128³: that removes the allocator entirely.
5. **P2 "ships once"** (a, b and c together) is a big-bang sim swap. Ship core, water and air separately, as Crisp
   phases it.

**Budgets.** The most believable of the three for the sim (the arithmetic is sound and the outcomes are prototyped).
The render budget is believable except for the copy pass.

**Reuse.** High, same as Crisp.

**Risk.** Lowest on the sim, medium on the renderer.

---

## 4. The recommended hybrid, concretely

**The frame** (box mode is one command buffer, three passes):

```
compute  tick (60 Hz, only when awake) → derived upkeep for visibly changed bricks:
         remesh chunks (Lean's 4 B faces, fixed per-chunk slabs), light grid (per cell, max-plus warm start,
         ≤ 4 iterations a tick), shadow tiles (dirty tiles only, ≤ 30 Hz), cull → one compacted list per pipeline
render   opaque pass, MSAA 4×, native or governor scale: sky → faces → particles (cubes) → three composite
         (Sync S1 order) → gas puffs → flame sprites; resolve in tile to colour + linear depth
render   liquid/glass pass, 1×: front liquid surface per pixel, manual depth test against the resolved depth,
         refraction from the resolved colour, RGB Beer-Lambert walk through the state that crosses uniform liquid
         bricks in one step (Fidelity's masks), foam, Fresnel against the one sky
compute  bloom (≤ ½ res), histogram, adaptation (post as today)
render   canvas: AgX, exposure, bloom, overlays after tone mapping (cursor, brush, edges: no re-render on pointer move)
```

**The tick:**
1. particles (integrate, sweep against the masks, claim/deposit into their own words);
2. column fall;
3. block pass (in place, snapshot for lookahead; a deterministic 8-offset cycle);
4. liquid (flux + gather) × 3 substeps;
5. air grid (TPT, conservative, sleeps per cell);
6. activity (`possible | changed` OR'd per brick, quiet only after a full 8-tick cycle, D5's run counter unchanged).

Gases stay cells, with aging diffusion and drift with the air grid. FIRE becomes a burning state of the fuel, drawn
as sprites (as the physics audit asks).

**Formats:**

| data | size | notes |
|---|---|---|
| cell | 16 B, one copy | |
| deco | 4 B, lazy | |
| occupancy snapshot | 1 bit per cell | |
| brick masks | 2 × 64 bits per brick | |
| air | 32 B per brick | |
| particle | 32 B | |
| face | 4 B | |
| light | rgba8 per cell | |
| shadow | tiled depth | |

Target memory ≈ 120-150 MB on the Mac at 128³ (est.).

**Budget (est.):**

| device | GPU per frame, typical | DRAM per frame, typical | GPU per frame, camera moving over a sleeping world | camera and world still |
|---|---|---|---|---|
| Mac | ~1.5-2.5 ms | ~40-60 MB | ~1 ms | 0 submits |
| iPhone | ~3-4 ms | ~30-45 MB | ~1.5 ms | 0 submits |

Both sit inside the perf audit's §10 budgets (4.5 ms and 120 MB on the Mac; 6.5 ms and 50 MB on the iPhone), with
the iPhone's DRAM closest to its line.

**Phasing.** Crisp's order with Lean's gates:
- **P0:** the judge kit, plus the gates in §6.
- **P1:** the renderer on today's sim (the mesher reads today's A buffer).
- **P2:** the core sim (state, cell API, clock, column fall, block pass, particles, rest).
- **P3:** water.
- **P4:** air, blasts and fire.
- **P5:** the world far field as LOD faces, and the phone.
- **P6:** polish and optional Mac extras.

Each phase ships and is judged side by side against the live build.

---

## 5. Grafts

**From Crisp:**
- native 4× MSAA with no TAA, final on the first frame;
- the max-plus warm-start light update and its full-recompute test;
- the chunk×direction cull compacted into one draw per pipeline (`firstInstance = 0`);
- gases as cells with aging diffusion, drawn as puffs;
- phase-by-phase shipping with P1 on today's sim;
- the Sim speed setting;
- the CI budget list (workgroups per changed brick, 0 view frames after a still camera, bytes per cell);
- X-ray kept as additive faces (nearly free in raster) rather than killed;
- dual-source blending as the one-draw path for thin glass where the feature exists.

**From Fidelity:**
- brick occupancy masks as the shared acceleration structure (the liquid walk, POV traces and picks, particle
  sweeps, sound and AI line of sight);
- immediate Teardown-style cell damage inside small blast radii, shielded by line of sight;
- one `emit()` used by every path, including reflections;
- weathering by facing as a material-function term;
- its prototype harness (`proto.js`, `run.mjs`, `analyze.mjs`) as the template for P0's per-pass measurements;
- an optional Mac "Ultra" tier later: traced reflections on liquid pixels only, over the masks.

**From Lean** (the base, listed for completeness):
- 16 B single-copy state behind `loadCell`/`storeCell`;
- column fall, the block pass with snapshot lookahead, particles only for sideways motion;
- the liquid model and constants from `lean-sim.mjs` as the tuning bench;
- rest reported by the rules over a full offset cycle;
- 4 B faces with live T/fill/glow;
- the per-cell light grid;
- the per-column liquid-depth map for underwater sun;
- flames as sprites on burning faces;
- the governor;
- Crunch mode;
- the iPhone as the reference device.

---

## 6. P0 gates (measure on the Mac and the iPhone before building on them)

1. **The MSAA opaque pass** at native resolution on the iPhone, with and without transient attachments: time, and
   bytes from GPU counters. The kill criterion: if it is > 1.5× the cost of TAAU 2/3 on the same scene, fall back to
   Lean's TAAU.
2. **Shadow update cost:** a full `load`/`store` 1024² pass against a dirty-tile array.
3. **Light grid upkeep** during the lab pour and a fire, per tick.
4. **The tick with 0, 10 K and 64 K particles**, and the column pass on a 50³ collapse.
5. **Metal compile time** per pipeline, cold, on both devices; each must stay ≤ 500 ms.
6. **2 frames in flight on Safari 26.x** with the new pass count.
7. **`skipSleeping = false` against `true` bit for bit** on the heap, puddle and U-tube scenes (catches §2.4 and §2.6
   on a real GPU).

## 7. The user's calls, not engineering's

- **The blocky look.** Both mocks show it reads far better than today's clay. It is still the bet; P1's side-by-side
  shots are the gate.
- **Gravity:** real g with a Sim speed setting (Crisp, Fidelity), or 2 g after TF2 (Lean). Engineering is
  indifferent: it is one constant, and liquid compression scales with g·dt².
- **The kill list:** gases as cells (I keep them), radial gravity, X-ray (I keep it, since it costs nothing in
  raster), and the plain view (goes either way).
- **A Mac-only Ultra tier**, or the same picture everywhere. Lean's "nothing for the Mac alone" is a product choice.
