# GPU architecture: what the sources say, and what it means for the ray loop

Sources (see `sources.md`): **[KF]** Fatahalian, "From Shader Code to a Teraflop", SIGGRAPH 2010 (slide numbers);
**[CS149]** Fatahalian, Stanford CS149 Fall 2021 lecture 7 (slide numbers); **[FG n]** Giesen, "A trip through the
Graphics Pipeline 2011", part n (section heading); **[A-M3]** Apple Tech Talk 111375 "Explore GPU advancements in M3
and A17 Pro"; **[A-PROF]** Apple Tech Talk 111374 "Discover new Metal profiling tools for M3 and A17 Pro";
**[A-OPT]** WWDC23 10127 "Optimize GPU renderers with Metal". Apple items cite `[mm:ss]` from the transcript
files. Code is cited at origin/main as checked out in `tpt-swp` (8251d9d2), and branch `arch/wavefront` (4a454396)
in `tpt-split`, read only.

The question: our march costs about 800 lane-cycles per loop iteration on water, glass, smoke and crystal
pixels. Which of these causes is it: lanes in a 32-wide group waiting on each other (divergence), memory latency not
hidden because too few groups fit (occupancy, from register pressure), texture latency, or chains of dependent
memory reads? How do we tell them apart, and what does it mean for the per-material split?

---

## 1. What the sources say

### 1.1 One instruction stream for many lanes; branches and loops cost the union

- Groups of lanes share one instruction stream. "In practice: 16 to 64 fragments share an instruction stream."
  [KF 31]. NVIDIA: "A group of 32 threads in thread block is called a warp." [CS149 48]. Each clock the core "runs
  next instruction for the CUDA threads in the warp (this instruction may apply to all or a subset of the CUDA
  threads in a warp depending on divergence)" [CS149 52].
- A branch that splits the group runs both sides for everyone: "Not all ALUs do useful work! Worst case: 1/8 peak
  performance" (for an 8-wide group) [KF 29]. "If the 32 CUDA threads do not share the same instruction,
  performance can suffer due to divergent execution." [CS149 49].
- Giesen states it for ifs **and loops**: "If any of the threads want to execute the 'then'-branch of an if, all of
  them have to … Worst case, you'll always execute both branches of every if. Ouch. Loops work similarly – as long
  as at least one thread wants to keep running a loop, all of the threads in that batch/Warp/Wavefront will."
  [FG 8, "The actual shader body"]. Same for compute: "if at least one thread in such a bundle wants to execute a
  certain piece of code, it gets processed by all the threads in the bundle" [FG 13, "Execution environment"].
- Summary of shader units: "very good at executing straight-line code, bad at branches (especially if they're not
  coherent)" [FG 3, "Shader Unit internals"].
- Apple names the same effect for ray traversal: "not all traversals will take the same amount of time … This
  creates what is called execution divergence, which causes each thread in a SIMDgroup to wait for the longest
  traversal from that SIMDgroup before proceeding … Execution divergence causes each type of intersection function
  to run one after another" [A-M3 20:32–21:14]. Apple's fix in hardware is to regroup: "it is free to group together
  the intersection function calls from rays that originated from separate SIMDgroups. This is the role of the reorder
  stage … the intersection function calls will be grouped into coherent SIMDgroups" [A-M3 22:17–22:38]. And its
  advice: "avoid creating one uber function that is capable of executing many different logical intersection
  routines. Instead, create one Metal intersection function for each logical intersection routine. This increases the
  benefits of the reorder stage." [A-M3 23:21–23:42].

**Rule of thumb:** a 32-lane group pays, per loop trip, for every body that *any* of its lanes takes, and it keeps
looping until its *longest* lane is done.

### 1.2 Latency is hidden by switching groups; how many groups fit decides how much

- "Stalls occur when a core cannot run the next instruction because of a dependency on a previous operation. Texture
  access latency = 100's to 1000's of cycles" [KF 32]. "Idea #3: Interleave processing of many fragments on a single
  core to avoid stalls caused by high latency operations." [KF 33]. "Increase run time of one group to increase
  throughput of many groups" [KF 38].
- The number of groups is set by context storage: "Pool of context storage 128 KB" [KF 39]; "Eighteen small contexts
  (maximal latency hiding)" … "Four large contexts (low latency hiding ability)" [KF 40–42]. A modern SM: "256 KB
  registers in total per SM … Registers divided among (up to) 64 'warps' per SM" [CS149 51].
- Giesen ties registers to stalls: "keeping multiple batches … running at the same time requires more registers. If a
  shader needs a lot of registers, a shader unit can keep less warps around; and if there are less of them, the
  chance that at some point you'll run out of runnable batches that aren't waiting on texture results is higher. If
  there's no runnable batches, you're out of luck and have to stall" [FG 8, "The actual shader body"]. His numbers:
  GTX 480 "memory access latency of 400-800 clocks" [FG 2, "The memory subsystem"]; "memory accesses and texture
  samples on GPUs have long latencies – think more than 600, and often above 1000 cycles" [FG 13, "Thread Groups"];
  ALU latency "18+ cycles per operation … you need 18 warps running concurrently on a shader unit to not ever hit
  instruction dependency stalls … while a warp is waiting on a texture fetch, it temporarily drops out of the
  rotation, so you need correspondingly more runnable warps to fill the gap." [FG 8, author's reply in comments].
- Texture units are built for one memory miss per request: "texture sampler pipes are long enough to not stall for a
  memory read even though it takes 400-800 cycles" [FG 4, "Texture cache"]; on a sample "a shader unit will just
  quietly switch to another thread/batch … Works just fine as long as there's enough independent work" [FG 4, "But
  who asks for a single texture sample?"]. L1 texture cache is "on the order of 4-8kb per sampler" and mip-mapped
  bilinear misses "around 1.25 misses/request" whatever the size [FG 4, "Texture cache"].
- Bandwidth is a separate limit that latency hiding cannot fix: "If processors request data at too high a rate, the
  memory system cannot keep up. No amount of latency hiding helps this." [KF 64].

### 1.3 Apple M3-class shader cores: registers are allocated as the program runs, not for its worst case

This is where Apple departs from the textbook model above.

- Before M3: "a SIMDgroup could not begin execution on a shader core until it allocated registers from the on-chip
  register file. The amount allocated would be equal to the maximum register usage at any point in the program. The
  SIMDgroup would keep that many registers allocated for the entire duration of the SIMDgroup" [A-M3 09:41–10:03].
  Apple's example is exactly ours: a ray-tracing kernel that "executes a different shading function based on the
  material … In this particular example, the implementation of the shadeGlass function uses many more registers than
  the rest of the program." [A-M3 09:00–09:41].
- On M3 (Apple family 9): "the maximum register usage no longer dictates how many SIMDgroups can be run. On-chip
  register memory is now dynamically allocated and deallocated over the lifetime of the shader according to what each
  part of the program actually uses." [A-M3 10:23–10:45]. "the register file is now a cache instead of the permanent
  storage for the registers" [A-M3 11:05–11:25]. Registers, threadgroup, tile, stack and buffer data now share "fewer
  larger caches" [A-M3 11:25–11:46].
- What limits occupancy instead: "if your app still uses more memory than there is on-chip storage for? Unmitigated,
  that data will spill to the next cache level or even to main memory. Fortunately, the shader core will dynamically
  monitor your shader's behavior and adjust the occupancy level to prevent this … your shader's occupancy will be
  impacted by how your shader's access threadgroup, tile, stack, and buffer memory in addition to its dynamic register
  usage." [A-M3 12:50–13:30].
- FP16: "FP16 math instructions execute at peak throughput. They use fewer registers than their FP32 equivalents."
  [A-M3 14:36]. FP32, FP16 and integer can overlap "In order to take advantage of this extra parallelism, instructions
  must be executed from multiple SIMDgroups" [A-M3 14:58–15:19].
- Spill versus occupancy, measured by Apple on Blender Cycles: "After finding the sweet spot, the spill increases a
  little, but increased overall occupancy has led to significantly better kernel performance." [A-OPT 15:31–15:55].
  "The optimal value is not always necessarily the maximum number of threads per threadgroup a GPU supports." [A-OPT
  14:48]. (That knob, maxTotalThreadsPerThreadgroup, is a compute-pipeline hint [A-OPT 13:45]; WebGPU does not expose
  it, and our march is a fragment pass.)

### 1.4 Big shaders with many branches: specialise, don't branch

- "An uber shader is an example of a long and complex shader … These types of shaders have lots of branches …
  uber shaders are not optimal since they have to account for all the possible options." [A-OPT 01:47–02:28].
  Function constants remove the dead paths: "Branch expressions that resolve to false will be optimized out … Memory
  loads and branches have been removed" [A-OPT 04:14–04:34].
- Apple's measurement: "The original uber shader shows a high number of ALU instructions and a large amount of
  spill. The number of memory waits is also large. Specialized approach gives immediate relief on the ALU and spill
  … the number of memory waits is significantly smaller." [A-OPT 06:26–06:46]; "it takes 58 milliseconds to render
  the material pass using the uber shader. And only 12.5 milliseconds to render with specialized versions."
  [A-OPT 07:26]. Note what this example removes: whole material features per pipeline, so every lane of a draw runs
  one material. That is specialisation **plus** coherence, not register savings alone.

### 1.5 How to tell the causes apart (Apple's counters and tools)

- **Divergence, directly:** "the Thread Divergence Heat Map. It visualizes the amount of GPU thread divergence in the
  SIMD groups. Divergence increases with control flow differences among threads, which can occur with conditional
  branches or inactive threads due to the shape of the geometry." [A-PROF 05:29–05:50]. Also an Instruction Count
  heat map per pixel or SIMD group [A-PROF 06:11–06:31] and Shader Execution History, which shows one SIMD group's
  timeline and detects loops ("a loop with 12 iterations, and is 79% of the total SIMD group execution time")
  [A-PROF 08:23–09:29].
- **ALU-bound versus occupancy-bound:** "While the total occupancy is low, you can see performance limiter for FP16
  … is around 100% … if you try to increase the occupancy, you may not see any performance improvement" [A-PROF
  17:01–17:22]; "Here is a different workload, where you can see both occupancy and all ALU limiters are low. And
  that means the occupancy is not high enough to avoid ALU starvation." [A-PROF 17:42]. Utilization counts work;
  the limiter counts work plus stalls [A-PROF 15:58–16:40].
- **Why occupancy is low:** Shader Launch Limiter low = workload too small [A-PROF 18:25–19:10]; threadgroup memory
  [A-PROF 19:55]; "Occupancy Manager Target Counter is lower than 100%. This indicates that occupancy manager is
  engaged by the GPU to keep various shader data memory types to stay on-chip" [A-PROF 21:02–21:24]; then "L1
  eviction rate … L1 load and store bandwidth … L1 residency" broken down by memory type (registers, threadgroup,
  tile/image block, stack) [A-PROF 21:46–23:10]. Their example: "image block L1 has the highest … you can reduce the
  L1 eviction rate by using smallest pixel formats" [A-PROF 22:48–23:32].
- **Memory system:** "If you see GPU last level cache limiter is much higher than its utilization, then that
  indicates it is getting stalled a lot due to cache thrashing … if you see MMU limiter is much higher than MMU
  utilization, then device buffer accesses are causing TLB misses and MMU is thrashing. Reducing incoherent memory
  accesses to buffers can help reduce these stalls." [A-PROF 24:59–25:44].
- **Ray-tracing analogue of our event split:** ray occupancy and the reorder stage [A-PROF 27:25–28:30].

### 1.6 Fragment-pass details that matter for a full-screen march

- Pixel work is dispatched in 2×2 quads, and dead pixels in a quad still occupy lanes: "for each shading batch we
  issue, we need to grab 8 incoming quads from the rasterizer before we can send off a batch" (32-wide) and "all
  pixels in a quad, even the masked ones, get shaded" [FG 8, "You need to go wider!"].
- `discard`: "if all pixels inside a batch get discarded, the shader unit can stop and go to another batch; but if
  there's at least one thread left standing, the rest will be dragged along." [FG 8].
- Writing depth from the shader: "an excellent way to shoot down early-Z, hierarchical Z and Z compression" [FG 8];
  early Z needs the shader not to write depth [FG 7, "Early Z/Stencil"].
- Early Z runs after the rasterizer and before shading, rejecting pixels "early, without wasting a lot of computation
  on them" [FG 7]. Giesen describes desktop "sort-last" GPUs and says tile-based renderers "work differently" and he
  does not cover them [FG 6, "Caveats"]. So how an Apple tiler packs early-Z survivors into SIMD groups is **not**
  in these sources.
- A good GPU workload "Has thousands of independent pieces of work … Is amenable to instruction stream sharing …
  Is compute-heavy" [KF 71].

---

## 2. Our renderer against it

| # | Source point | Our code | Verdict |
|---|---|---|---|
| a | Group pays for the union of bodies per trip, and loops until the longest lane ends (1.1) | The main loop `traceView` (shaders/render.js:941-1455) runs, per cell, crisp hits, crystals (`crystalHit`), panes, films (`filmHit` :1367), media (`mediaSegment` :1404), liquid surfaces, and four inlined `sunShadowAt` sites (:1152, :1182, :1239, :1395). Rays end at very different trip counts (air vs water vs smoke). | **Violates** wherever a 32-pixel group straddles kinds (tank edges, smoke edges, water depth changes). Never measured: our counters (docs/profiler.md "Counters") count trips per pixel, not per group. |
| b | Heavy body in the loop once, via a funnel (1.1, 1.4) | The `ifPend` block puts the liquid interface, normal, ripple and detail at one site at the loop head (render.js:874-993); `lightRefAt` defers one sun lookup (render.js:845-852). | **Follows** for code size (one inlined copy). It does not change divergence: a lane at a surface still makes its whole group run that block. |
| c | Registers set occupancy; carry little across the loop (1.2, static model) | Comments state the static model: "every value the loop carries costs every pixel registers, glass or not" (render.js:840-842); "state kept across the tracer's loop costs registers, and so occupancy, for the whole shader" (gfx/media.js:254). | **Partly outdated for M3-class Apple GPUs** (1.3): the worst-case allocation they describe is the pre-M3 rule. Matches our data: the lean march cut spill 544 → 112 B and was "not much faster per step" (arch/wavefront docs/march-spill.md, "Time"). |
| d | Uber shader → specialised pipelines (1.4) | Main: one march pipeline per detail variant, every material in it (shaders/world/march.js:338-361, the three-stage cut). Branch: lean march + one kernel per event kind, each "the resumed loop with only the rich bodies it keeps", plus a fat fallback (arch/wavefront march.js:373-405, `EVENT_KINDS`). | Main **violates**; branch **follows** Apple's advice in structure. Its gain depends on coherence (row g). |
| e | Derivatives only in uniform control flow (1.6) | Taken once at the fragment entry; every later read is `textureSampleLevel`/`textureLoad` (render.js:66-70). | **Follows.** No helper-lane derivative work inside divergent code. |
| f | Dependent memory chains need many groups to hide (1.2) | Per trip: brick info → occupancy mask → cell id (render.js:1013-1036). Measured: 4-5× fewer cell reads changed nothing (brief). | **Not the cause** for the lean traversal. The shadow map, though, is read from a storage buffer at scattered places with two tag reads first (shaders/world/light.js:477-486, 563-582): incoherent buffer reads, the case Apple's MMU/LLC counters flag (1.5). Not measured. |
| g | Coherence needs regrouping, not just separate code (1.1, Apple's reorder stage) | Branch gates each kernel with an early-depth test: lean march writes a per-kind depth, kernels draw a full-screen triangle tested `equal` (arch/wavefront march.js:383-430, :918-929). | **Unknown** whether this packs surviving pixels into full SIMD groups on Apple's tiler, or leaves them as idle lanes in place (1.6). If the latter, a kernel's group still pays for its slowest event pixel and saves only groups with no event pixel at all. |
| h | Shader-written depth disables early Z (1.6) | Main split: march, reflect, shade write colour only; composite writes `frag_depth` (march.js:607-623). Branch: the lean march writes the gate via `frag_depth` (arch/wavefront march.js:709-718); kernels only test. | **Follows** where it matters: the passes that rely on early Z (the kernels) do not write depth. |
| i | Bandwidth is its own limit (1.2) | G-buffer per pixel: 100 B (main) and 150 B (branch) (arch/wavefront docs/march-spill.md "Design"). At 1.82 M traced pixels that is about 182-273 MB written per frame, read back by later stages. | **Probably minor** but never priced: divide by the chip's bandwidth. Matters for any design that round-trips loop state per bounce. |
| j | Tile/image-block memory competes for L1 on M3-class cores (1.3, 1.5) | The march stage renders two `rgba32uint` targets, "all 32 bytes a sample may have" (docs/profiler.md "Counters" notes); the branch adds `X` (r8uint) and the depth16 gate to the lean pass. | **Unmeasured.** Apple's own example of an occupancy limiter is image-block L1 pressure. |

---

## 3. What we missed (ranked by likely frame-time impact)

1. **We have never measured lane efficiency (divergence).** Our cost counters count loop trips and taps per pixel;
   a group's time follows its slowest lane and the union of its bodies (1.1). If the ~800 lane-cycles per trip was
   computed as time × lanes ÷ (sum of per-pixel trips), it already includes this waste, and we cannot tell "the
   bodies are expensive" from "the bodies run for lanes that don't need them" without it. Two ways, both cheap:
   - In the counted twin (src/shaders/costView.js), add a counter that, at the loop head, adds the number of active
     lanes in the subgroup (subgroup ballot; `subgroups` is already a device feature, src/gpu/features.js). Lane
     efficiency = Σ active lanes ÷ (subgroup size × Σ group trips). Also per body: how many lanes wanted it when the
     group ran it. (My suggestion, not from the sources; check that Dawn allows subgroup ops in fragment shaders.)
   - Or, CPU only: read back the raw per-pixel `march` counts and compute, over 32-pixel blocks, (32 × max) ÷ Σ.
     Try 8×4, 4×8 and 16×2 blocks, since Apple's fragment group shape is not in these sources.
   - Apple's Thread Divergence heat map gives the same answer in Xcode [A-PROF 05:29].
   **Why first:** it decides the per-material split. Low efficiency (say under 40%) means regrouping by kind can pay
   up to the inverse; high efficiency (over ~80%) means the split cannot help and only cheaper bodies will.

2. **Occupancy and limiters have never been read** (docs/profiler.md:279, :315-321: null from the command line).
   One Instruments run with the Performance Limiters counter set on the Chrome GPU process answers the brief's
   question by Apple's flow chart (1.5): ALU limiter near 100% → ALU-bound, cut math; occupancy low and every limiter
   low → occupancy starvation, then look at Occupancy Manager Target, L1 eviction and L1 residency by type
   (registers vs stack vs image block); LLC or MMU limiter well above utilization → incoherent memory (the shadow-map
   buffer reads are the first suspect, row f).

3. **Register spill is the wrong lever on this GPU class.** On M3-class cores the worst-case register count no
   longer fixes occupancy (1.3); Apple even shows more spill with higher occupancy running faster [A-OPT 15:31].
   Our own data agrees (lean march 112 B spill, not faster per step). Further spill work should wait for evidence
   from item 2 (Occupancy Manager engaged and L1 residency dominated by registers or stack).

4. **The early-depth gate may not compact anything.** The sources only cover desktop quad packing (1.6). If Apple's
   tiler keeps rejected pixels as idle lanes in place, every event kernel pays for its slowest event pixel per group
   and saves only fully-empty groups. Test (one GPU run, hypothesis stated): the liquid kernel over the same number
   of event pixels laid out as a solid block versus a checkerboard of 2×2 quads versus single pixels. Equal times →
   packing happens; 2-4× slower checkerboard → no packing, and the split needs a compute pass over a compacted list
   (append via atomics, which Giesen describes as how append buffers work [FG 13, "Structured buffers and
   append/consume buffers"]), sorted or bucketed by kind, as Apple's reorder stage does in hardware [A-M3 22:17].

5. **Loop-length divergence survives a per-kind split.** Within one kind (water), trips still vary with depth and
   bounces, and "as long as at least one thread wants to keep running a loop, all of the threads … will" [FG 8].
   Laine-style designs re-sort after a bounded number of trips; the branch rejected bounded rounds because each would
   move ~85 carried words per pixel (arch/wavefront docs/march-spill.md "Design"). The record it actually stores (K)
   is 12 words; pricing a round at 12 words, against item 1's efficiency number, is the comparison to make.

6. **The heavy bodies are where the time is, so their per-call cost matters most if item 2 says ALU.**
   `sunShadowAt` is a cloud-shadow loop of texture taps plus a cascade pick, four buffer texels, two tag reads and a
   five-tap caustic ripple (light.js:347-368, :563-597; gfx/clouds.js:151-159); `mediaSegment` runs up to
   `MEDIA_SEG_SAMPLES` samples, each with density, sun, ambient and lamps (gfx/media.js:249-325). Apple: FP16 runs
   at peak and uses fewer registers [A-M3 14:36] (a march-wide f16 attempt gave nothing; per-body f16 in these math
   loops is untested).

7. **Image-block and G-buffer size.** Smaller target formats are Apple's first fix when image-block L1 drives
   evictions [A-PROF 23:10-23:32]; the G-buffer's bandwidth (row i) is the same question for device memory. Low
   priority until item 2 shows L1 or bandwidth pressure.

---

## 4. Implications for the per-material split (arch/wavefront)

- The split can only win by **coherence**: putting lanes that need the same body, for about the same number of trips,
  in the same 32-lane group. The sources give no reason to expect a gain from smaller per-kernel register footprints
  on M3-class cores (1.3), and our lean-march result confirms that.
- Apple's own answers match the design: one function per logical routine, not an uber function [A-M3 23:21];
  specialised pipelines, not runtime branches [A-OPT 02:48-03:09]. The `EVENT_KINDS` list with dead-code-free
  kernels is the right shape.
- **But regrouping is the half that does the work**, and the early-depth gate may not regroup at all on a tiler
  (item 4). Measure that before adding kinds.
- Measure lane efficiency (item 1) on Lab and Island first. It gives the split's ceiling for free: the most a perfect
  split can save on event pixels is roughly (1 − efficiency) of their cost. If that ceiling is small, the effort goes
  to the bodies themselves (item 6), which is where the branch's own notes already point ("The lever is the cost of
  those bodies themselves", arch/wavefront docs/march-spill.md).

---

## 5. Open questions the texts could not settle

1. **How was "~800 lane-cycles per iteration" computed?** Over active lanes or all lanes of each group, and with
   which clock and lane count? The answer changes how much of it is divergence.
2. **Apple's fragment SIMD group:** its pixel shape, and whether early-Z or depth-test survivors from different
   places in a tile are packed together. Not in these sources (Giesen excludes tilers [FG 6, "Caveats"]).
3. **Does the M5 keep M3's dynamic register allocation and occupancy manager?** The talks cover Apple family 9
   (M3, A17 Pro) only.
4. **Why did removing a never-taken branch once make the single-pass march much faster** (shaders/world/march.js:
   339-341: Island 71 ms vs 311 ms)? Under 1.3 the unused branch's registers should not have cost occupancy. Possible
   causes the sources point at: the occupancy manager reacting to on-chip memory pressure from the stack or spill
   [A-M3 13:10]. Instruction-cache pressure from ~455 k characters of inlined WGSL is another candidate the sources
   do not discuss.
5. **Apple's SIMD width and register file size** for these chips: not stated in the three Apple items (the Metal
   Feature Set Tables were not fetched; see sources.md).
6. Whether Dawn compiles WGSL pipeline-overridable constants into Metal function constants or folds them itself.
   Either way, dead code goes; the question only matters for compile time.
