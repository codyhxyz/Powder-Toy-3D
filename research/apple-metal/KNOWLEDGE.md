# Apple Metal profiling: what the sources say, and what it means for our profiler

Sources and cache paths: `sources.md`. Quotes give a location: WWDC transcripts as `[session m:ss]`, Apple docs
by page title, local tools by man page section. Code references are to the live code in
`/Users/codyhergenroeder/code/claude/tpt-swp` (origin/main 8251d9d2) unless marked otherwise. Nothing here was run
on the GPU; the only commands run were CPU-only (`man`, `xctrace … --show-recording-options`, which records nothing).

The question: Metal's per-encoder times put the world march 2–3× below what knockout (the frame without it) shows.
Why, which counters would say directly why the march is slow, can we capture them from Chrome, and what should
the profiler change?

**Short answer.** Two of our own rules make the numbers disagree, and the sources show both. (1) Apple GPUs run
vertex, fragment and compute work at the same time, and `tools/gpu-counters.mjs` splits every overlapping instant
evenly between the encoders running then. A heavy pass sharing the GPU with light work gets only part of its
time. (2) Knocking out the march also blanks the G-buffer, so the reflect and shade passes discard every pixel.
The knockout figure then includes their cost too. Apple's own answer to "what does one pass cost" is the Metal
debugger replaying the frame with "only one pass" at a time ("Serial" mode). On M3 and later Macs that replay also
gives a per-line shader cost graph, per-pixel cost, divergence and instruction-count heat maps, occupancy and
limiter counters. Xcode 27.1 ships two command-line tools, `gpucapture` and `gpudebug`, that do this without the
Xcode window, for any process started with `MTL_CAPTURE_ENABLED=1`. That is the path to use on Chrome's GPU process.

---

## 1. What it says

### 1.1 Apple GPUs overlap passes; "a pass's time" is not a sum

- Independent hardware channels. "Apple GPUs process vertex, fragment and even compute workloads in parallel
  using independent hardware channels. Overlapping these workloads maximizes GPU utilization" [10632 4:22].
- Render pass order. "Apple GPUs process all vertices of a render pass before any fragments, so stages from the
  same pass must execute serially. But vertex processing of the next pass should overlap with fragment processing
  of the current pass. This even occurs across frame boundaries" [10632 4:54]. The TBDR doc says the same: "While
  the GPU runs the final stages of a render pass to tile memory, it can start the vertex stage of a future render
  pass" (Tailor your apps for Apple GPUs…).
- Metal reorders and overlaps by itself where no resource dependency exists. "Metal automatically overlaps your
  workloads whenever there are no data dependencies" [10632 4:22]. "Metal only tracks dependencies at the resource
  level and not the data itself" [10632 5:58]. "Metal will also reorder independent passes when it can" [10632 7:35].
- The debugger's "Concurrent" vs "Serial" modes. "By default, the Metal debugger profiles the workload in
  Concurrent mode. This allows the GPU to overlap the vertex, fragment, and compute tasks… In Serial mode, the
  Metal debugger forces each pass to run only after the previous pass finishes, which adds precision to the data
  report for each pass without overlap, but it doesn't represent runtime performance" (Optimizing GPU performance,
  "Gather performance data").
- Per-pass counters are taken in isolation. "The Metal debugger collects data from the passes running without
  overlap, so only one pass runs at a time on the device when the profiler measures the performance" (Analyzing
  Apple GPU performance using counter statistics). "The Metal debugger derives the shader profiler time by tracing
  the shader instructions when running the workload with overlap… In addition, the Metal debugger measures the
  detailed counters from each pass or command in isolation" (Optimizing GPU performance, "Get detailed performance
  metrics").
- Occupancy is a sum over stages running together. "This counter is actually the sum of other counters. It's the
  sum of Compute, Vertex, and Fragment Occupancy" [10603 24:35]; "The sum of these percentages is the total
  percentage of the GPU's capacity in use" (Finding your Metal app's GPU occupancy).

### 1.2 GPU timestamps on Apple silicon

- Only stage boundaries. "Typically, a GPU supports one of these boundary types. For example, Apple silicon
  supports sampling at the stage boundary because it processes fragments after processing every primitive for a
  render pass. However, a typical immediate-mode GPU supports sampling between commands" (Sampling GPU data into
  counter sample buffers, Overview).
- What a stage boundary is. `atStageBoundary`: "Counter sampling is allowed at the start and end of a render
  pass's vertex and fragment stages, and at the start and end of compute and blit passes" (MTLCounterSamplingPoint).
  The render pass descriptor has `startOfVertexSampleIndex`, `endOfVertexSampleIndex`, `startOfFragmentSampleIndex`,
  `endOfFragmentSampleIndex`; compute passes have `startOfEncoderSampleIndex` / `endOfEncoderSampleIndex` (same page,
  table).
- Barriers buy accuracy. For command-boundary sampling, "The `barrier` parameter … controls whether the pass waits
  for the GPU to complete all the previous commands… Each barrier typically reduces performance, but can be useful
  during development to get accurate and consistent data across multiple runs" (same page). Stage-boundary
  sampling has no such option.
- Clock conversion. GPU and CPU clocks differ; sample both at least twice to convert (Converting GPU timestamps
  into CPU time). Not our problem: we compare GPU timestamps with each other.

Dawn's mapping (Dawn source, `src/dawn/native/metal/CommandBufferMTL.mm` lines 112–148, cached in raw/dawn-src): a
WebGPU render pass's begin timestamp is written to `startOfVertexSampleIndex`, its end to `endOfFragmentSampleIndex`;
a compute pass's to `startOfEncoderSampleIndex` / `endOfEncoderSampleIndex`. So one WebGPU render-pass timestamp
pair spans "this pass's vertex stage starts" to "this pass's fragment stage ends". With 1.1, the next pass's vertex
stage can start before this pass's fragments end. Spans then overlap and their sum can pass the frame, which is
what our profiler sees on render passes (docs/profiler.md, "Trusted per-pass ms").

### 1.3 The counters and what each says

- Limiter vs utilization. "Work is the number of items processed in the hardware block… Stall is the number of
  times an available item is held off by a downstream block… Utilization is the work done in the sample period by
  the hardware block, as the percentage of the hardware block's peak processing rate times the sample period.
  Limiter is calculated similarly, it includes both work and stalls" [111374 15:48–16:52]. Same in the docs: "A
  utilization counter shows how much time the GPU subsystem is doing work, excluding stall time. A limiter counter
  shows how much time the GPU spends doing work, including stall time" (Reducing shader bottlenecks).
- Look at limiters first. "Limiters… arguably the GPU counters you should always look at first… the GPU is only as
  fast as the slowest part" [10603 5:45–6:18]. The full limiter list: GPU memory read/write, MMU, last level cache,
  tile memory read/write, ALU, F16 (utilization only), F32 (utilization only), texture sampling, texture filtering,
  texture read cache, texture write, buffer read, buffer write, fragment input interpolation (Reducing shader
  bottlenecks, table).
- High is not efficient. "a high limiter value does not mean that the workload is efficient… we can be 100% ALU
  limited but only stay at 50% utilization if all we are doing are FP32 operations" [10603 13:02].
- Register pressure signature. "A high ALU limiter alone does not indicate a performance bottleneck… However, when
  combined with low shader occupancy, this may be an indicator of a shader experiencing register pressure"
  [10148 27:17]. In that demo, mixing F16 in made the region 3.7 → 2.6 ms and "shader occupancy has improved by
  almost double" [10148 28:21–30:24].
- Spills show up as buffer traffic. "GPU functions can increase the read-and-write activity when they use a lot of
  thread memory or access it with dynamic indexing… forces the GPU to store data to device memory and then read it
  at a later time" (Reducing shader bottlenecks, "Reduce the workload for buffer operations"). "Avoid
  implementations that randomly index into thread-scoped arrays" (same).
- M3-and-later memory model. "Registers, threadgroup, tile stack, and other shader core memory types are assigned
  dynamically from L1 cache, which is then backed by GPU last level cache and device memory… With the increase in
  number of SIMD groups, they may come a point when your workload uses more memory than what is available in
  on-chip storage, which causes spills to next cache levels. The shader cores balance thread occupancy and cache
  utilization to prevent memory cache thrashing" [111374 13:43–14:15].
- The occupancy triage on M3 and later [111374 16:52–25:47], in order:
  1. Occupancy low and an ALU sub-limiter (e.g. FP16) near 100%: more occupancy won't help; cut that work.
  2. Occupancy and all ALU limiters low: occupancy is starving the ALUs. Check "Shader Launch Limiter": "A low
     value for this counter indicates that not enough threads are getting launched due to small workload size"
     [18:25].
  3. Launch limiter high: check threadgroup memory per dispatch, then "Occupancy Manager Target": "lower than 100%.
     This indicates that occupancy manager is engaged by the GPU to keep various shader data memory types to stay
     on-chip" [21:02].
  4. Then "L1 eviction rate", "L1 load and store bandwidth" and "L1 residency" broken down by memory type
     (registers, threadgroup, imageblock, stack, ray-tracing scratch) say which on-chip memory is thrashing [21:34–23:10].
  5. If L1 eviction is low, compare "Last level cache limiter" with its utilization, and "MMU limiter" with its
     utilization: limiter much higher than utilization means cache thrashing or TLB misses [24:44–25:15].
- Divergence. "Each SIMD lane has 32 threads but a single program counter… The threads that don't take the branch
  will mask out the execution, but still spend the cycles… the total cost will be 70 cycles" instead of 40
  [10603 11:29–12:29]. "There are some cases where only a few threads of a SIMD will actually need to run… most of
  the threads are wasting cycles" [10603 12:29].
- Uber shaders. "Shaders that need to handle many different conditions can reserve more registers than necessary,
  and this can reduce the number of threads that run in parallel. Splitting your workload into smaller, more
  focused shaders, which need fewer registers, can improve the utilization of the shader cores" [10148 6:36]. Their
  split: "instructions reduced by 84%, branches reduced 90%, registers reduced 25%… reduce this shader by eight
  milliseconds" [10148 7:38–8:08]. Blender: "The original uber shader shows a high number of ALU instructions and
  a large amount of spill. The number of memory waits is also large… 58 milliseconds… only 12.5 milliseconds to
  render with specialized versions" [10127 6:26–7:31].
- Occupancy hint (compute only). "Max-Total-Threads-Per-Threadgroup… The higher the value, the higher occupancy you
  hint the compiler to aim for… The optimal value is not always necessarily the maximum… the spill increases a
  little, but increased overall occupancy has led to significantly better kernel performance" [10127 13:45–15:19].
- 16-bit types. "Using 16-bit data types instead of 32-bit data types, your shaders will require less registers
  leading to an increase in shader core occupancy" [10632 37:59]. "16-bit floating point operations… run at double
  rate… 32-bit integer and complex operations… half rate or less" [10603 10:28].
- Shader code pitfalls [10632 40:04–43:10]: dynamically indexed stack arrays "spill to memory"; unsigned loop
  indices force wrap handling so "the shader compiler cannot vectorize the loads together"; non-adjacent struct
  fields can't be loaded together.
- Fast math. Metro Exodus' translation layer had it off; turning it on gave "a 21% frame time decrease" [10148
  20:03]. Dawn (ShaderModuleMTL.mm lines 440–450, 539–544) compiles with `#pragma METAL fp math_mode(relaxed)` unless
  strict math is asked for, so WebGPU on Chrome already gets it.
- GPU performance state. "the GPU performance state is a very important factor. It's managed by the operating
  system, which will lower or raise the state depending on device thermals, system settings, GPU utilization… These
  state changes can affect profiling results" [10157 7:47]. Instruments can "induce a specific GPU performance state
  when you are recording a trace… Simply go to Recording Options, and choose a performance state" [10157 8:53–9:23].

### 1.4 The tools that give these counters

- Metal System Trace (Instruments) is the over-time view. Counters are off by default: "Click and hold the Record
  button and choose Recording Options… choose the Performance Limiters option from the Counter Set menu"
  (Analyzing the performance of your Metal app). The 10603 demo: "make sure that Performance Limiters is selected
  under the GPU Counter Set. I'm also going to enable the new Shader Timeline" [10603 6:49–7:23]. The Shader Timeline
  "shows you which shaders are running at sampled times… along with how many samples they were running for and an
  approximate GPU time" [10603 8:25–8:57].
- The Metal debugger (a GPU capture replayed) is the deep view; "your workload will be unaffected by thermals or
  dynamic system changes. Xcode also supports GPU performance counters and exposes every single one of them at
  encoder granularity" [10603 5:15].
- Shader cost graph (M3/A17 Pro and later): a flame graph of shader functions plus per-line cost, "exactly how
  many instructions were executed by the GPU, and the cost of different instruction categories" [111374 4:12]. Per
  line: Instructions Executed (Total and Active), Divergence, ALU Cost, Non-ALU Cost, and a breakdown by instruction
  type (Math, Control Flow, Sample, Load, Store, Synchronization…) and data type (Float16, Float32, Integer) (Analyzing
  Apple GPU performance using the shader cost graph).
- Performance heat maps (M3 and later): Shader Execution Cost ("combining shader execution time and latency
  hiding"), ALU Cost, Non-ALU Cost, Thread Divergence, Control Flow Divergence, Inactive Threads, Overdraw,
  Instruction Count, per pixel for fragment shaders (Analyzing Apple GPU performance with performance heat maps).
- Shader execution history: click a pixel to see its SIMD group's timeline; "Metal Debugger also automatically
  detects loops… there's a loop with 12 iterations, and is 79% of the total SIMD group execution time" [111374 8:55–9:29].
- Per-line "Synchronization (wait memory)": "time that the GPU spends waiting for dependent memory accesses, such as
  texture sampling or buffer read/write" (Inspecting shaders).
- `gpucapture` (local man page): "a command line tool for creating GPU Trace files for any App, process or service…
  the user is responsible to launch their target process with MTL_CAPTURE_ENABLED=1". Boundaries are Device, Queue,
  Layer and Scope; for Device and Queue, `--count` "is the number of complete MTLCommandBuffers captured".
- `gpudebug` (local man page; also Apple's "Debugging with interactive command-line tools"): opens a `.gputrace`;
  `profile run [--gpu-state default|low|medium|high] [--exec overlapping|serial] [--embed]` "collect profiling
  data from device (M3/A17+ required)". After that the tree has `performance/encoders` ("encoder cost ranking"),
  `performance/commands` ("draw/dispatch cost ranking"), `performance/shaders` ("shader cost ranking"),
  `performance/timeline/counters` ("GPU counter time-series", "fetchable as JSON"), and per-draw heat maps ("Heatmap
  cost types under performance/commands are fetchable as PNG"). `--json` makes every command's output machine
  readable.
- Capture in general: "in macOS 14 and later, you can set the environment variable on your Metal app:
  `MTL_CAPTURE_ENABLED=1`" (Capturing a Metal workload programmatically). Replaying needs "the same type, the same
  GPU, and the same operating system" (Replaying a GPU trace file); exported with performance data embedded, a trace
  opens "on any Mac" (Optimizing GPU performance).
- Chrome specifics (not Apple). Dawn: `use_user_defined_labels_in_backend` forwards labels "so that they can be seen
  in native debugging tools like… Mac Instruments"; `DAWN_TRACE_FILE_BASE` makes the Metal backend save "a .gputrace
  file that can be loaded into XCode's Metal Debugger. `MTL_CAPTURE_ENABLED=1` must also be set", tracing "from
  device creation until device destruction" (Dawn debugging.md). Toji: in Xcode's scheme add `--disable-gpu-sandbox`,
  `--enable-dawn-features=use_user_defined_labels_in_backend` and `MTL_CAPTURE_ENABLED=1`; attach to the GPU
  process by pid ("set Debug Process As to root"); capture a Command Queue or the Device, not "Frames", because
  Chrome "doesn't end up calling present in the way that Xcode expects"; and "once you've snagged a Metal capture
  from Chrome with Xcode the browser always hangs indefinitely and needs to be restarted" (toji.dev, "Capturing a
  WebGPU page"). He also says stock Chrome builds "have been codesigned in a way that generally prevents debuggers
  like Xcode from attaching".

---

## 2. Our renderer and profiler against it

| Point (source) | Ours | Verdict |
|---|---|---|
| Overlapping work can't be split by a rule; Apple isolates passes to cost them (1.1) | `exclusiveShares` gives each encoder `1/k` of every instant `k` encoders share (`tools/gpu-counters.mjs:335–352`); that share is `gpuMs`/`totalMs` (`:375`, `:400`), and `metalTimes` builds the per-pass ms from it (`src/gfx/profileCauses.js:100`). The longest-channel duration, which counts shared time, is computed (`ownMs`, `:377`, `:405`) but not used for passes. | **Violates.** A long fragment pass overlapped by light compute (sim kernels) or by the next pass's vertex stage gets half its time or less. This is a likely cause of the 2–3× gap. |
| Knockout as truth | Knockout drops a pass's draws but keeps its load/store (`src/gpu/timing.js:18–30`). The march pass clears its G-buffer; `world reflect` and `world shade` then `discard` on every pixel because the hit bit is 0 (`src/shaders/world/march.js:580`, `:592`). | **Confounded** (our code, not a source claim). Knocking out the march also removes reflect + shade work, so "knockout ms" is an upper bound for the march alone. |
| WebGPU render-pass timestamps on Apple = start of vertex → end of fragment (1.2, Dawn source) | `docs/profiler.md` notes render-pass timestamps "can span whole submissions" and are untrusted. | **Follows** in effect; the mechanism is now documented. Compute-pass timestamps (start/end of encoder) are the reliable ones. |
| Limiters/occupancy are the first thing to read (1.3) | `tools/gpu-counters.mjs` asks for them but gets only "RT Unit Active" from the `xctrace` command line (`:23–27`, `:431–434`). | **Missing in practice.** The fields are null on this Mac. |
| GPU performance state controls the numbers (1.3, 10157) | Not recorded or controlled. `docs/march-spill.md` saw the same march at 10.51 and 6.66 ms 25 minutes apart. | **Missed.** The trace has a `gpu-performance-state-intervals` table (Instruments GPU package docs) that we never export. |
| Spill is "stack" memory backed by L1; occupancy manager trades threads for it (111374) | The march spills 752 B/thread (`docs/march-spill.md`); our tool reads the spill events (`gpu-counters.mjs:274–282`). | **Partly.** We see the spill size, not its cost: occupancy, Occupancy Manager Target, L1 residency (stack) and L1 eviction would show it. |
| Divergence: a SIMD group pays for its slowest lane (10603 11:59) | Brief: cost "tracks loop iterations on water/glass/smoke/crystal pixels (~800 lane-cycles per iteration)"; the march is a full-screen fragment shader (`march.js:564`). | **Applies directly.** Mixed SIMD groups (a few water pixels among dry ones) run every iteration for all 32 lanes. The Thread/Control Flow Divergence heat maps would show where. |
| Uber shader → split into focused shaders (10148, 10127) | The march inlines every material body (`docs/march-spill.md`: ~430 k characters of WGSL); the `arch/wavefront` branch (4a454396) splits it into a lean pass plus per-material event passes. | **Follows** on the branch. Apple's numbers (8 ms; 58 → 12.5 ms) back the direction. |
| Fast math (10148) | Dawn compiles in `relaxed` math mode by default (ShaderModuleMTL.mm). | **Follows** automatically. |
| 16-bit types for registers (10632, 10603) | f16 shaders on (`--gpufeatures`); an f16 march was tried with no gain (project notes). | Follows; no further claim. |
| Avoid dynamic indexing of private arrays, unsigned loop indices (10632 40:04–42:08) | `docs/march-spill.md` lists "dynamic vector indexing" in the 176 B left over; loops like `for (var z = -1; …)` are signed (`march.js:213`). | Partly. The dynamic indexing is a named lead. |
| Debug groups organise a capture (Toji) | No `pushDebugGroup` in `src/gpu/timing.js`. | Minor gap for captures. |
| Overlap is good: keep independent work concurrent (10632, timeline doc) | Profiler's split mode turns every dispatch into its own pass (docs/profiler.md). | Note: split mode changes overlap; it is stated in reports. |

---

## 3. What we missed, ranked by likely frame-time impact

1. **We may be timing the wrong thing.** Both of our "trusted" numbers are biased for the march: Metal shares
   under-count it (even split of overlap) and knockout over-counts it (reflect and shade go idle with it). The 2–3×
   gap can come from either, and any decision about how much the march costs inherits that. Evidence: 1.1 quotes;
   `gpu-counters.mjs:335–352`, `march.js:580/592`. Apple's measure for "this pass alone" is a Serial replay
   (Optimizing GPU performance), and for "what it costs the frame" the Concurrent replay's shader profiler time.
2. **SIMD divergence on water/glass/smoke/crystal pixels.** Our cost tracks loop iterations on those pixels; Apple's
   model says every lane in a mixed 32-thread group pays for them [10603 11:59–12:29]. The heat maps (Thread
   Divergence, Control Flow Divergence, Instruction Count) and the execution history's loop detection [111374 8:55]
   are the direct measure. The wavefront split helps only if the event passes run with full groups, which is what
   the Inactive Threads heat map shows.
3. **Spill cost via occupancy, not spill bytes.** 752 B/thread is stack memory in L1 on this GPU family [111374 13:43].
   The cost shows as a low "Occupancy Manager Target", high L1 eviction and a large stack share of L1 residency.
   Without these we can't tell a spill that costs 1 ms from one that costs 10.
4. **Run-to-run drift from the GPU performance state.** A 37% change in the same pass between two runs (march-spill.md)
   is larger than most A/B effects we test. The sources say the state varies with thermals and load and can be
   induced in Instruments and the Metal debugger [10157 7:47–10:26]; `gpudebug profile run --gpu-state high` does it
   from the command line.
5. **The uber-shader cost is mostly memory waits, per Apple's own case** [10127 7:01]. The per-line "wait memory"
   share (Inspecting shaders) would say whether the march's time goes to spill and texture reads or to ALU, which
   decides between "fewer live values" and "fewer reads". Our "4–5× fewer cell reads changed nothing" fits a
   spill- or divergence-bound shader, not a read-bound one, but only the counters can confirm it.

---

## 4. Getting the counters for Chrome's WebGPU (Dawn on Metal)

What the sources support, as exact steps. Every step that needs the GPU uses one headless slot under our rules
(`tools/browser.mjs`); none was run for this report.

### A. Command line: `gpucapture` + `gpudebug` (preferred; no Xcode window)

1. Launch the browser with `MTL_CAPTURE_ENABLED=1` in its environment (gpucapture man page; Apple "Capturing a Metal
   workload programmatically", macOS 14+) and the switches
   `--enable-dawn-features=use_user_defined_labels_in_backend --disable-gpu-sandbox` (Dawn doc; Toji). The GPU
   process is a child of the browser and inherits its environment (Toji set the variable on the Chrome executable
   and captured in the GPU helper). In Playwright that means passing `env` to `chromium.launch` (not from these
   sources: check Playwright's docs).
2. `gpucapture list` shows capturable processes; pick the Chrome GPU helper (our `findGpuProcess`).
3. `gpucapture boundaries --pid <PID>` lists Device / Queue / Layer / Scope boundaries. Chrome does its own
   scheduling and doesn't present the way capture tools expect (Toji), so use Dawn's **Queue** (or the Device).
4. `gpucapture start --pid <PID> --boundary <QUEUE_ID> --count <N> --output <dir>/frame.gputrace`, with N the command
   buffers of about two frames (for a Queue, count = "complete MTLCommandBuffers captured").
5. Close the browser (Toji: after an Xcode capture Chrome hangs; whether `gpucapture` does the same is unknown).
6. `gpudebug -q -t frame.gputrace -c "profile run --gpu-state high --exec serial --embed"` gives one pass at a time at
   a fixed GPU state. Then, in the same session (`-s <id>`):
   `go performance/encoders` (per-pass cost), `go performance/shaders` (shader ranking), `go :l` from a shader (its
   source), `go performance/commands/<draw>/heatmap/fragment` + `fetch cost` (and the other heat-map types),
   `go performance/timeline/counters` + `fetch` (counter time series as JSON). Add `--json`. Run
   `profile run --exec overlapping` as well for the runtime picture. `profile run` needs an M3/A17 or later; the M5
   qualifies. `gpudebug --terminate <id>` at the end.

### B. Xcode window (Toji's recipe, if A fails)

Debug > Debug Executable… → the Chrome binary; Info: untick "Debug executable"; Arguments: `--disable-gpu-sandbox`,
`--enable-dawn-features=use_user_defined_labels_in_backend`, env `MTL_CAPTURE_ENABLED=1`; Options: GPU Frame
Capture = Metal. Run, find the GPU process pid (Chrome Task Manager), Debug > Attach to Process by PID (as root),
press the Metal capture button, Source = a Command Queue or the Device with 4–5+ command buffers, Capture. Then
Profile, and in the debug bar's GPU Profiler button choose Serial and a performance state (Optimizing GPU performance).
Export with "Embed performance data" to keep it.

### C. Instruments.app (counters over time, no replay)

Metal System Trace (or Game Performance), Recording Options → GPU Counter Set: Performance Limiters, Shader Timeline
on, performance state set, attach to the GPU process [10603 6:49–7:23; Analyzing the performance of your Metal app;
10157 9:23]. This gives the limiter and occupancy tracks the command line doesn't.

### D. Dawn's own trace

`DAWN_TRACE_FILE_BASE=<path>` plus `MTL_CAPTURE_ENABLED=1` saves a `.gputrace` from device creation to destruction
(Dawn doc). Whole-session traces of a big map will be very large; it's a fallback for when no boundary works.

---

## 5. What the profiler should change

In order of value:

1. **Stop calling the even-split Metal share "the pass's time".** Report both numbers per pass: the share
   (`gpuMs`, a lower bound) and the pass's own channel duration with overlap (`ownMs`, an upper bound for its
   wall-clock occupancy of the GPU), and say which other encoders overlapped it and for how long. This needs no GPU
   run to try: re-read a kept trace (`TPT_XCTRACE_KEEP=1`, `node tools/gpu-counters.mjs --trace … --pid …`) and put
   the march's `ownMs` beside its share and the knockout figure.
2. **Make knockout honest about dependents.** Knocking out the march also idles reflect and shade. Either knock out
   `{reflect, shade}` and `{march, reflect, shade}` and take the difference, or report "knockout(world march)
   includes reflect + shade". A pass whose output gates later passes needs its dependents listed in the report.
3. **Add a capture mode built on `gpucapture` + `gpudebug`** (section 4A): per-pass Serial costs at a fixed GPU
   state, the shader cost ranking, the march's heat maps (cost, instruction count, thread divergence, inactive
   threads) saved beside `cost.png`, and the counter time series (occupancy, Occupancy Manager Target, L1 residency
   and eviction, limiters and utilizations). This is Apple's one-run answer to "why is this pass slow", and it
   matches the profiler's "one run" rule. Keep the `.gputrace` with embedded performance data, which opens on any Mac.
4. **Record the GPU performance state** in every report: export `gpu-performance-state-intervals` from the trace
   (Instruments GPU package schema). Refuse to compare two runs at different states. Try inducing a state through
   the template's `gpuperformancestate` key (present in Apple's template, untested).
5. **Try the separate "Metal GPU Counters" instrument.** `xctrace list instruments` lists it (package
   `com.apple.gpu-counters`, table `metal-gpu-counter-intervals` with name, value and percent value), and Apple's
   Metal System Trace template doesn't include it. Adding `--instrument 'Metal GPU Counters'` may be why the command
   line streams only "RT Unit Active" today. Untested; if it fails, `xctrace --show-recording-options` confirms the
   GPU instruments expose no JSON options, so the template patch or section 4A stays the route.
6. **Put the render-pass timestamp rule in the report**: on Apple, a WebGPU render pass's timestamps are its vertex
   start to fragment end (Dawn, 1.2), so they overlap neighbours. Trust compute-pass timestamps; use render-pass ones
   only as a span.
7. Minor: wrap each phase in `pushDebugGroup` so a capture is navigable.

---

## 6. Open questions the text could not settle

- Does `MTL_CAPTURE_ENABLED=1` reach the GPU process of Playwright's Chromium, and does `gpucapture` connect without
  `--disable-gpu-sandbox`? Toji needed the switch with Xcode; no source covers `gpucapture` and Chrome.
- Does `gpucapture` leave Chrome hung after a capture, as Toji reports for Xcode?
- Will `gpudebug profile run` replay a Dawn trace correctly (IOSurface-backed canvases, shared textures)? The docs
  only require the same Mac, GPU and OS.
- What exactly is a Metal System Trace interval's duration: time the encoder had any thread resident, or time it
  issued work? None of the sources defines it, which is why "own" is only an upper bound.
- Why the `xctrace` command line streams only "RT Unit Active" on the M5 when the template asks for Performance
  Limiters. No source says the command line can or can't choose the counter set.
- How much of the knockout figure is reflect + shade: needs the two-knockout difference (section 5.2).
- Whether the Occupancy Manager is engaged for the march (fragment) or for concurrent sim compute: only the counters
  will say. Apple's triage applies to both.
- Apple's docs say "Max Theoretical Occupancy" per shader is shown in the timeline's compiler statistics (Analyzing…
  visual timeline). Whether `gpudebug` exposes it (`info` on a shader) isn't in the man page.
