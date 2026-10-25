# Wavefront vs one big shader: what the papers say, and our march against them

Sources (sources.md): **[LKA13]** Laine, Karras & Aila 2013, "Megakernels Considered Harmful". **[AL09]** Aila &
Laine 2009, "Understanding the Efficiency of Ray Traversal on GPUs". **[ALK12]** its Kepler/Fermi addendum.
**[W11]** Wald 2011, "Active Thread Compaction for GPU Path Tracing". **[PWK26]** Padilla et al. 2026, arXiv (weak
evidence).

Code read (read-only, no GPU runs):
- Live: `/Users/codyhergenroeder/code/claude/tpt-swp` at 8251d9d2. `src/shaders/render.js` is byte-identical to the
  branch's base a455edbf.
- Split: branch `arch/wavefront` at 4a454396 in `/Users/codyhergenroeder/code/claude/tpt-split`. Line numbers are
  from `git show arch/wavefront:<file>`. The worktree also holds an uncommitted change that swaps the X done-mark
  target for a stencil mark and makes a kernel `discard` on abort. It is noted where it matters.

---

## 1. What the sources say

### 1.1 Why one big shader is slow ([LKA13] §1, §4.1)

The paper names three costs, and no others:

- **Divergence.** "some threads are masked out when executing a branch they should not participate in. This
  incurs a performance loss, as masked-out threads are not performing useful work" (§1). The main case is
  materials: "When paths in a warp hit different materials, the execution is serialized over all materials
  involved. According to our tests, this is the main source of performance loss in scenes with multiple complex
  materials" (§4.1).
- **Registers.** "even a single hot spot that uses many registers will drive the resource usage of the entire
  kernel up, reducing the latency-hiding capabilities" (§1). "Ray casts suffer from this especially badly, as they
  perform relatively many memory accesses compared to math operations" (§4.1).
- **Instruction cache.** "the instruction caches on a GPU, while being adequate for moderately sized or tightly
  looping kernels such as ray casts, cannot accommodate the entire megakernel" (§4.1).
- Rays that finish early. "terminated paths leave threads idling until all threads in the 32-wide warp have been
  terminated". Regenerating paths in their place gave only "Some 1–5% improvement" (§4.1).

### 1.2 The design ([LKA13] §4.2–4.4)

- **A pool, one segment per pass.** "keeping a pool of 1M (= 2^20) paths alive at all times. On each iteration,
  every path is advanced by one segment" (§4.2). Each kernel does a bounded piece of work and hands the path on.
  No kernel runs a path to its end.
- **Three stages.** A logic kernel on every path, then material kernels, then ray-cast kernels (Fig. 2). "Each
  kernel that is not executed for all paths in the pool has an associated queue that is filled with requests by
  the preceding stage" (§4.2).
- **How materials are grouped.** "In practice, we place each 'expensive' material into its own material kernel,
  and combine the 'simple' materials into one kernel ... optimizing the assignment of materials into kernels is an
  interesting open problem requiring more detailed analysis of the costs associated with control flow divergence
  versus kernel switching" (§4.2). Why not one kernel per material: "kernel launches and managing multiple queues
  have nonzero costs" (§4.2). **The paper gives no number for launch overhead.**
- **Ray casts stay lean.** "ray casts that consume a major portion of execution time can be executed using highly
  optimized, lean kernels that require few registers, without being polluted by high register usage in, e.g.,
  material evaluators" (§1).
- **No full-program fallback.** Every path goes through the specialised kernels. The megakernel is only the
  baseline they compare against (§4.1).
- **Queues buy compaction.** "By producing compact queues of requests for the material and ray cast stages, we
  ensure that each launched kernel always has useful work to perform on all threads of a warp" (§4.4).
- **Queue order matters.** Separate atomics from each thread "become intermixed in their execution order ...
  it results in decreased coherence". Combining them across the warp first gave "40% in the total rendering speed
  ... The effect of improved coherence is witnessed by the speedup of ray cast kernels by 32%, which can be
  attributed entirely to improved ray coherence" (§4.4).

### 1.3 State per ray and memory layout ([LKA13] §4.2–4.3)

- "Path state is stored in global memory ... and consumes 212 bytes per path, including extension and shadow rays
  and space for the results of ray casts" (§4.2). 1M paths come to 212 MB. Each queue is 4 MB.
- "The main drawback of the wavefront formulation compared to the megakernel is that path state has to be kept in
  memory instead of local registers. However, we argue that with a suitable memory layout this is not a serious
  problem" (§4.3).
- Structure-of-arrays matters: "the SOA memory layout provides a total speedup of 80% over the simpler
  array-of-structures (AOS) layout ... new path kernel speedup is a whopping 790%" (§4.3).
- A bigger pool helps only a little: "∼5% when going from 1M to 8M paths" (§4.2).

### 1.4 Results, and when it pays ([LKA13] §5, Tables 1–2)

- Speedups over the one-big-kernel version: CARPAINT (one material) **+36%**, CITY **+79%**, CONFERENCE **+221%**
  (Table 1).
- Even with one material it wins, because of the lean ray casts: "The overhead of storing the path state in GPU
  memory is more than compensated for by the faster ray casts enabled by running the ray cast kernels with low
  register counts ... while the entire ray cast code fits comfortably in the instruction caches" (§5).
- Measured lane use in CONFERENCE: "thread utilization of the megakernel is only 23%, whereas the wavefront variant
  has 53% overall thread utilization (60% in logic, 99% in new path generation, 71% in materials, lowered by
  variable iteration count in Mandelbrot shader, and 35% in ray casts)" (§5). Even one material kernel loses lanes
  when its own loop runs a different number of times per thread.
- Ray casts are still 44–56% of the time (§5, Table 2). Splitting doesn't make a material cheaper. It only stops
  the material's work being paid by idle lanes.
- The condition for the gain: "our performance [is] practically independent of the number of materials **as long
  as enough rays hit each material to allow efficient bulk execution**" (§2).
- Volumes: "Monte Carlo rendering of participating media ... consisting of short steps in a possibly separate data
  structure, differs considerably from the rest of the computation, suggesting that a specialized volume marching
  kernel would be advantageous" (§6). This is future work there, not measured.
- Conclusion: "While there are overheads associated with storing path data in memory between kernel launches,
  management of the queues, and launching the kernels, these are well outweighed by the benefits" (§6).
  **[LKA13] reports no case where wavefront loses.**

### 1.5 Compaction vs leaving idle lanes masked ([W11])

This is the paper that tested the question our branch faces.

- The idea: "taking multiple partially-filled warps and compacting them to fewer but fully utilized warps"
  (Abstract).
- In theory it worked: by bounce 8, the one-kernel version's live warps hold "a mere 3.2 active paths (or a mere
  10% warp utilization) ... averaged across all bounces ... 43%". Compaction gives "2.3× fewer active warps"
  (§4.2.1, Table 2).
- In practice it gave **+12–16%** (Table 1). The tiled shared-memory version was **3× slower**, because of an
  occupancy collapse: "for a complex kernel that uses 64 registers ... maximum 33% device occupancy ... as few as 8%
  for the 24KB of shared memory" (§4.1).
- The compaction itself is cheap: "less than 1% of total runtime is spent in compaction" (§4.2.2). Saving and
  reloading paths: "fairly constant at 7–8%" (§4.2.3).
- **Why the gain vanished.** A full warp cost far more than a mostly empty one: "fully utilized warps are about 5×
  slower than low-utilized ones" (Table 3). The cause was memory: "for as incoherent memory accesses the underlying
  hardware is far less capable of hiding memory latencies than expected" (§4.2.4).
- **When the work is arithmetic, compaction pays.** "if we add enough computations to roughly double the render
  time of the reference naive kernel, the full-frame compaction kernel's speedup increases to ∼80%" (§4.2.5).
- When it doesn't pay: "for less-scattering BRDFs like specular reflection/refraction paths would diverge
  significantly less, and often all threads in a warp would either all terminate or all survive". On a car model:
  "hardly any speedups for outside views" (§4.2.7).
- Keep the state small: "we actually store only the data that has to be maintained among bounces ... all local
  surface data, material data, reciprocals of ray direction, etc, do not ... storing pixel coordinates as 16-bit
  shorts, bools as bits". That came to "88 bytes per path node (plus 16 bytes for accumulated radiance)" (§3.1,
  §3.5).

### 1.6 Loop shape, persistent threads and divergence ([AL09], [ALK12])

- **while-while** (inner loops: traverse while at inner nodes, then intersect while there are primitives) against
  **if-if** (one traversal step and/or one test per trip round the loop) (§3.2). The simulation favours
  while-while, yet "we see almost equal performance". if-if "has better efficiency in traversal ... if-if leads to
  fewer exceptionally long-running warps ... the slowest warps are about 30% faster in if-if" (§3.2).
- **Persistent threads.** Launch only enough threads to fill the machine and have them pull work from a global
  pool through an atomic counter (§3.3, Appendix A). This was a 1.5–2.2× gain on GTX285 (§3.4). The reason was the
  hardware's work distributor: "long-running rays or warps keep distribution slots hostage" (§3.3).
  [ALK12] Table 2: on Fermi "Not beneficial due to a better hardware work distributor". On Kepler, "Can replace all
  terminated rays once fewer than 60% of the warp's lanes have work ... +10%". **The gain depends on the GPU.**
- **Replacing finished rays.** "It often happens that a few long-running rays keep the entire warp hostage ...
  one should avoid the while-while loop organization here ... limiting the while loops to max N iterations, we used
  N = 4" (§5.1). No consistent gain on GTX285 (§5.1). A small win on Kepler ([ALK12]).
- **Speculative traversal.** "if a warp is going to execute node traversal anyway, why not let all the rays
  participate?" (§4). It gave up to +5% on primary rays and +10% on AO, and nothing on diffuse rays (§4).
- **Work queues** of 64 rays per 32 lanes, so that 32 lanes always share one operation. Simulated at +40–80%, but
  "very slow on GTX285 in practice" without prefix-sum and popcount instructions (§5.2). Our hardware has those
  (subgroup ops) today.
- **Arithmetic is the limit, not memory.** "ray tracing is still, even with incoherent rays and more complex
  scenes, almost entirely limited by the available FLOPS" ([ALK12] Abstract). Also: "avoid dependent fetches
  whenever possible, even at the cost of fetching data that has a low probability of being useful" ([ALK12] p.1).

### 1.7 A modern data point ([PWK26], weak)

- One scene on an RTX 3060 Ti: wavefront **+16%** (13.58 vs 15.47 ms, Table 1). Credited to "improved memory
  behavior and cache locality" (§5).
- "neither approach saturated any major GPU execution unit" (§4).
- One big kernel "minimizes explicit synchronization and kernel launch overhead, making it attractive for smaller
  scenes, simpler shaders, or latency-sensitive implementations" (§5).
- They also compact per bounce, with indirect dispatch: "Dispatching W x H number of threads when only a small
  fraction perform useful work wastes GPU resources" (§3.1).

---

## 2. Our renderer against the sources

### 2.1 What the march is

- Each pixel runs one fragment shader through the whole ray. The loop is a single `for` over at most
  `MAX_STEPS + BEND_EXTRA_STEPS` trips (`render.js:941`, `BEND_EXTRA_STEPS = 128` at `render.js:128`,
  `MAX_BENDS = 6` at `render.js:789`).
- **Each trip does one thing.** It skips an empty brick (`render.js:1025–1030`), passes an empty cell
  (`1044–1054`), handles a crisp voxel such as a crystal, an opaque voxel or glass (`1056–1291`), or handles a
  smooth segment (`1292–1453`). The smooth segment tests surface crossings, a film, the liquid's absorption
  (`1381–1402`), media (`1403–1410`) and the event (`1414–1450`). A liquid interface left pending runs at the top
  of the next trip (`942–994`). **That is [AL09]'s if-if shape.**
- **Inside liquid, every cell pays the heavy body.** Each cell does `absorbDeco`, which calls `decoAt`, two
  `exp`s and `interiorLight` (`gfx/deco.js:81–87`). It also does a `mediumLight` `exp` (`render.js:1397`) and
  usually a field sample with 4 crossing tests (`1307–1354`), unless the brick is a certified interior.

### 2.2 The branch's split (arch/wavefront 4a454396)

- **The lean march** (`march.js` stage `march`; `render.js` `STOP` at line 789) stops at the first "rich" body,
  one of `RICH_BODIES = ['liquid','crystal','glass','media','film']` (`render.js:756`). It writes a 12-word
  (48 B) record into K, a 3-layer `rgba32uint` texture (`rsStore`, `march.js:484`). It also writes a gate depth
  per kind (`march.js:718`).
- **One kind kernel**, `{ key: 'liquid', takes: ['liquid'], keep: ['liquid'] }` (`march.js:389–390`). It runs on
  its pixels only, through an early depth test at `KIND_Z` with compare `equal` (`march.js:397`, `748`). It
  **traces the rest of the ray itself**. At any body it doesn't keep, it aborts and leaves the pixel to the fat
  stage (`EVK_ABORT`, `march.js:482`; `render.js:789`).
- **The fat event stage** is the whole loop, resumed from K (`march.js:726`; `render.js:763`). It runs on every
  other event pixel and every aborted one (depth `greater`, `march.js:430`).
- **Rounds.** "Bounded rounds of lean and event passes were ruled out" because smoke has an event in every cell
  and each round would move "~85 carried words through memory" (branch `docs/march-spill.md:174–176`). So there
  is **one round**: lean, then kind kernels, then the fat stage. Each runs its rays to the end.
- **Measured.** These come from the brief and from branch `docs/march-spill.md:205–211`, measured by knockout. Lab
  went from about 28 ms to lean 6.2 + event 17.5 ≈ 23.7 ms, about 4 ms better. Island went from about 15 ms to
  lean 10.6 + event 12.4 ≈ 23 ms, about **8 ms worse**. "The event stage costs what the old march cost". "The lean
  march is not much faster per step". Cost tracks loop trips on water, glass, smoke and crystal pixels, at about
  800 lane-cycles per trip. Turning off the cubic filter, or reading 4–5× fewer cells, changed nothing.

### 2.3 Point by point

| Source point | Us | Verdict |
|---|---|---|
| Split expensive materials into their own kernels, combine the cheap ones ([LKA13] §4.2) | One kind kernel (liquid). Crystal, glass, media and film all go to the fat stage (`march.js:389–390`) | **Partly follows.** Lab's expensive pixels sit behind the tank's glass, so their first body is glass and they skip the liquid kernel |
| No full-program fallback: every path goes through specialised kernels ([LKA13] Fig. 2) | The fat event stage is the old one-big-shader loop, run on every pixel that needs more than one kind (`march.js:726`) | **Violates.** The fallback keeps the megakernel's divergence and registers on exactly the expensive pixels. That fits "the event stage costs what the old march cost" |
| One segment per pass. A kernel hands the path on and never discards work ([LKA13] §4.2) | A kind kernel runs the ray to its end. On abort, its work is thrown away and the fat stage redoes the ray from the lean record (`march.js:748–762`, `EVK_ABORT`) | **Violates.** A ray that aborts late pays twice. The papers have nothing like abort-and-redo |
| Ray casts in lean, low-register kernels ([LKA13] §1, §5) | The lean march does follow this (112 B spill against 544 B). But each kernel and the fat stage carry their own traversal at the heavy kernel's register cost | **Follows for the first leg only.** Our own result ("lean not much faster per step") says registers matter less on the M5 than on Kepler, which fits [ALK12]'s "limited by the available FLOPS" |
| Compact queues, so every launched lane has work ([LKA13] §4.4) | The gate is an early depth test per kind: pixels that fail never launch (`march.js:397`, `430`, `748`) | **Follows in spirit**, at a granularity the papers don't cover (see open questions 1–2). It keeps screen order, which avoids the ordering loss [LKA13] §4.4 fixed (32% on ray casts). That part is in our favour |
| Small state, laid out for coalesced access ([LKA13] §4.3, 212 B, SoA +80%; [W11] 88+16 B) | The lean-to-event record is 48 B, one texel per pixel per layer, read by the pixel that wrote it (`march.js:484–494`). No indirection | **Follows.** Smaller than either paper. Mid-ray state (~85 words + ~76 private words, `docs/march-spill.md:50–54`) has never been handed off, so it has never been trimmed |
| Launches cost something, so don't make too many kernels ([LKA13] §4.2) | Each kind and the fat stage is a full-screen pass that loads and stores G0/G1 (32 B/pixel) and the depth for the **whole screen**, not just its pixels (`worldView.js:162–167`; `STAGE_LOADS`, `march.js:927`) | **Real cost, not budgeted.** It grows with screen area times the number of kinds. Part of Island's +8 ms is probably this, plus the redo (unmeasured) |
| Lanes idle when loops run different numbers of trips: 71% in materials "lowered by variable iteration count" ([LKA13] §5); [W11] Table 2 | Each kernel and the fat stage loops up to 1 + MAX_STEPS + 128 trips, with ray lengths differing per pixel | **Not addressed.** Nothing bounds a launch's trip count or regathers the survivors |
| Compaction pays when the work is arithmetic, not when it waits on memory ([W11] §4.2.4–4.2.5) | Our per-trip cost is arithmetic in the bodies (800 lane-cycles a trip; fewer cell reads changed nothing) | **Compaction would fall on the paying side of [W11]**, if lane utilisation is low. Not measured |
| Little gain when neighbouring rays do the same thing ([W11] §4.2.7; [LKA13] §2's "enough rays hit each material") | Water and glass pixels form solid screen regions. Neighbours mostly meet the same bodies in the same order | **Likely cuts our gain from per-kind splitting**: there may be little mixing of kinds inside one SIMD group to remove. Not measured |
| if-if: fewer long-running warps ([AL09] §3.2) | Already if-if (§2.1) | **Follows.** A while-while rewrite isn't indicated: [AL09] measured them about equal |
| Persistent threads ([AL09] §3.3–3.4; [ALK12] Table 2) | Not possible: the march is a fragment shader | **Doesn't apply** as built. The gain depends on the GPU (2× on GTX285, none on Fermi, +10% on Kepler). No Apple data |
| Speculative traversal ([AL09] §4) | No analogue | Doesn't apply: it is a fix for tree traversal |
| Separate volume-marching kernel for media ([LKA13] §6) | Media and liquid are walked cell by cell inside the shared loop (`render.js:1381–1410`) | **Not done.** It is suggested by the source but unmeasured there |

---

## 3. What the branch is likely missing, ranked by likely frame-time effect

"Likely" because none of this has been measured: each item says what would confirm it.

1. **The fat fallback is the old shader, and it takes most of the expensive pixels.**
   - The evidence: [LKA13]'s gain comes from never letting several materials share a warp, and its design has no
     fallback (Fig. 2, §4.1).
   - On our side: Lab's tank pixels meet the glass pane before the water, so their first body is glass. No
     kernel takes glass (`march.js:389–390`), so all of them run the fat stage. That matches "the event stage costs what the old march cost" (Lab 8.7–9.4 ms against
     9.4–11.2).
   - The fix: kinds should be the sets of bodies rays actually meet in a row. For Lab that means a glass+liquid
     kernel, for the tank. Put cheap bodies (film, crystal) into whichever kind they show up with ([LKA13]:
     "combine the 'simple' materials into one kernel").
   - To confirm first: count each pixel's route (lean only, kind kernel finished, kind kernel aborted, fat) with
     the cost view's counters (`gfx/costView.js`), per map. This is a CPU-readable count, not a timing run.
2. **Abort-and-redo pays twice.**
   - The evidence: no source discards a ray's work. [LKA13] hands the state on, and [W11] measured the cost of
     saving and reloading paths at only "7–8%" (§4.2.3).
   - The fix: on abort, write a resume record at the abort trip so the fat stage continues instead of restarting.
     That needs the mid-ray state, which item 3 makes smaller.
   - Or abort only at points where the state is still the lean record's (before anything is gathered).
   - Island's +8 ms is the strongest hint. A sea ray that meets a film, smoke or crystal after the liquid kernel
     has done its work is traced again from the surface. The abort count from item 1 settles it.
3. **Bounded rounds were ruled out on the size of today's state, not on a trimmed one.**
   - The evidence: [LKA13] carries 212 B a path, and [W11] 88 + 16 B, by keeping "only the data that has to be
     maintained among bounces" and packing it (16-bit, bits for bools).
   - Our ~85 words (340 B) is the loop's live set at an arbitrary trip. But the loop already has **restart
     points**. After a liquid interface it re-derives the DDA from the new origin and direction (`ddaInit`,
     `tEnter = 0`, `lastB = -1`, `phiA = surfSample(ro)`, `render.js:972–983`).
   - A hand-off at a restart point needs roughly the following: origin and direction; colour and transmission as
     f16; the liquid id; bends; trip count; tCut; lightRef, mediumLight and lightY; gSkyIn; anyHit and hitPos;
     mOp and mNext; filmKey; and the pending reflection (gRefl*, about 15 words).
   - That is about 40–50 words (160–200 B), in [LKA13]'s range (my count from the code, not built).
   - Hand-offs only at bends (at most `MAX_BENDS = 6`) would bound the rounds for liquid and glass. Smoke still
     needs its own kernel that walks the whole gas run in one go (item 5), not a round per cell.
4. **Nothing gathers live lanes back together during a long run.**
   - The evidence: [LKA13] reports 71% material utilisation "lowered by variable iteration count" even with one
     material per kernel. [W11] reports 43% average utilisation, with ~80% gains once the work is arithmetic
     (§4.2.5), which ours is.
   - Our kernels loop up to MAX_STEPS + 128 trips. A pixel group launched together finishes when its longest ray
     does.
   - With item 3's hand-off, a bounded round becomes possible: N trips or one bend per pass, re-gated on the
     survivors. [AL09] §5.1 bounded its loops to N = 4. [ALK12] Kepler replaced rays below 60% lane use.
   - To confirm first: measure lane use in the fat stage. If the counters can't give it, histogram trips per
     pixel within 8×4 blocks from the cost view. If blocks are uniform, this item drops to the bottom.
5. **Media and liquid are walked cell by cell with the heavy body every cell.**
   - The evidence: [LKA13] §6 suggests "a specialized volume marching kernel ... short steps in a possibly
     separate data structure".
   - On our side: 800 lane-cycles a trip, in liquid every cell (`render.js:1381–1402`). [LKA13] Table 2 shows that
     splitting never made material work cheaper. Only cutting the work does.
   - A liquid or media kernel that steps per brick through certified interiors, with one absorption per run, cuts
     trips rather than divergence. It would change the picture (paint and mixed ids per cell), so it needs a
     picture check, as branch `docs/march-spill.md` already says of the heavy bodies. This may be the biggest
     lever of all, but it is outside what the wavefront papers measured.
6. **Per-pass fixed costs.**
   - The evidence: [LKA13] §4.2 and [PWK26] §5 both say launches and synchronisation cost something, and that
     smaller or simpler workloads favour one kernel.
   - Each extra kind costs a full-screen G0/G1/depth load and store. Keep kinds few, as items 1 and 2 say. Better
     still, check whether a kind's pass can cover only its pixels' tiles instead of the whole screen (open
     question 2).
7. **(Low) Registers on traversal inside heavy kernels.**
   - This is [LKA13]'s main point, but our own measurement (112 B spill against 544 B was "not much faster per
     step") and [ALK12] ("limited by the available FLOPS") say it is a small effect on this GPU.
   - Don't restructure for it alone.

## 4. Questions the sources could not settle

1. **Does an early depth test pack the surviving pixels into full SIMD groups on Apple's GPU?** If so, how
   finely: 2×2 quads, or only within a tile? The sources predate tile-based GPUs and use compute queues. Our
   gating is only "compaction" as far as the hardware packs survivors. Check the apple-metal topic.
2. **Does a discarding kernel lose its early depth reject?** The uncommitted stencil version makes a kind kernel
   `discard` on abort while writing the stencil (`increment-clamp`). On many GPUs, discard plus a depth or stencil
   write moves part of the test after the shader. If Apple then runs the shader on every pixel before rejecting,
   the gate stops gating. The committed X-target version didn't discard. Settle this from Apple documentation (the
   apple-metal topic) before relying on it.
3. **What is lane utilisation in the fat stage today?** None of the papers' gains apply unless it is low.
   [LKA13] measured 23% for its megakernel; we have no number. That makes items 1 and 4 hypotheses.
4. **Do long-running pixel groups hold up others on this GPU** ([AL09]'s "distribution slots hostage")? Answering
   that would need a compute-shader march, which the sources can't predict for Apple.
5. **How much of Island's +8 ms is redo, how much per-pass cost, and how much the lean pass doing the whole screen
   up to the sea?** It can be split with the route counts from item 1 plus the existing knockout measure.
6. [W11]'s "full warps 5× slower" came from memory latency on a GTX480. Our measurements point to arithmetic,
   which favours compaction. But nothing here has measured how Apple's GPU hides latency with full groups against
   sparse ones.
