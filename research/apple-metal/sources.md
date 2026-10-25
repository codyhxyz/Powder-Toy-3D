# Apple Metal profiling: sources

All retrieved 2026-10-25 with `curl` (network, CPU only). WWDC transcripts come from Apple's own session
pages (the `transcript-content` section, with Apple's timestamps kept as `[m:ss]`). Apple documentation
pages come from developer.apple.com's DocC JSON (`/tutorials/data/documentation/<path>.json`), the same
data the web page renders, converted to text. All are free, publisher-hosted copies.

## Required sources

| # | Source | URL | Cached as |
|---|---|---|---|
| 1 | WWDC20 10632 "Optimize Metal Performance for Apple silicon Macs" (Imbrogno, Don) | https://developer.apple.com/videos/play/wwdc2020/10632/ | raw/wwdc2020-10632.html, text/wwdc2020-10632.txt |
| 2 | WWDC20 10603 "Optimize Metal apps and games with GPU counters" (Vinals Gangolells, Colbran) | https://developer.apple.com/videos/play/wwdc2020/10603/ | raw/wwdc2020-10603.html, text/wwdc2020-10603.txt |

## Shader profiler / shader cost graph / Metal System Trace sessions (the three chosen)

| # | Source | URL | Why chosen | Cached as |
|---|---|---|---|---|
| 3a | Tech Talk 111374 "Discover new Metal profiling tools for M3 and A17 Pro" (Nov 2023) | https://developer.apple.com/videos/play/tech-talks/111374/ | Introduces the shader cost graph, performance heat maps, shader execution history and the M3+ occupancy counters (occupancy manager, L1 residency/eviction). Our M5 is this family's successor. | raw/tech-talks-111374.html, text/tech-talks-111374.txt |
| 3b | WWDC21 10148 "Optimize high-end games for Apple GPUs" (Metzgar, Dustin) | https://developer.apple.com/videos/play/wwdc2021/10148/ | Metal System Trace + GPU Timeline workflow; register pressure read as "high ALU + low occupancy"; per-line shader profiler; uber-shader split (Baldur's Gate 3), fast math (Metro). | raw/wwdc2021-10148.html, text/wwdc2021-10148.txt |
| 3c | WWDC23 10127 "Optimize GPU renderers with Metal" (Jog) | https://developer.apple.com/videos/play/wwdc2023/10127/ | Uber shader vs specialised variants measured with the GPU debugger: spill, memory waits, 58 → 12.5 ms; occupancy hint (maxTotalThreadsPerThreadgroup). Closest to our march. | raw/wwdc2023-10127.html, text/wwdc2023-10127.txt |

Also fetched and read, used only for single facts and marked as supplementary in KNOWLEDGE.md:
- WWDC20 10605 "Gain insights into your Metal app with Xcode 12": https://developer.apple.com/videos/play/wwdc2020/10605/ (text/wwdc2020-10605.txt). Shader Timeline and limiter tracks in MST recording options.
- WWDC21 10157 "Discover Metal debugging, profiling, and asset creation tools": https://developer.apple.com/videos/play/wwdc2021/10157/ (text/wwdc2021-10157.txt). GPU performance state, read and induced.

## Apple documentation (GPU timestamps / counter sampling, item 4, plus the Xcode profiling pages)

Each is `raw/doc-<area>-<page>.json` and `text/doc-<area>-<page>.md`.

| Page | URL |
|---|---|
| Sampling GPU data into counter sample buffers | https://developer.apple.com/documentation/metal/sampling-gpu-data-into-counter-sample-buffers |
| GPU counters and counter sample buffers | https://developer.apple.com/documentation/metal/gpu-counters-and-counter-sample-buffers |
| Converting GPU timestamps into CPU time | https://developer.apple.com/documentation/metal/converting-gpu-timestamps-into-cpu-time |
| Confirming which counters and counter sets a GPU supports | https://developer.apple.com/documentation/metal/confirming-which-counters-and-counter-sets-a-gpu-supports |
| MTLCounterSamplingPoint (+ atStageBoundary, atDispatchBoundary, atDrawBoundary, atBlitBoundary, atTileDispatchBoundary) | https://developer.apple.com/documentation/metal/mtlcountersamplingpoint |
| MTLCommonCounterSet, MTLCommonCounter, fragmentCycles | https://developer.apple.com/documentation/metal/mtlcommoncounterset |
| MTLComputePassDescriptor, MTLComputePassSampleBufferAttachmentDescriptor | https://developer.apple.com/documentation/metal/mtlcomputepasssamplebufferattachmentdescriptor |
| Tailor your apps for Apple GPUs and tile-based deferred rendering | https://developer.apple.com/documentation/metal/tailor-your-apps-for-apple-gpus-and-tile-based-deferred-rendering |
| Optimizing GPU performance (execution modes, Concurrent vs Serial) | https://developer.apple.com/documentation/xcode/optimizing-gpu-performance |
| Analyzing Apple GPU performance using counter statistics | https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-counter-statistics |
| Analyzing Apple GPU performance using a visual timeline | https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-a-visual-timeline |
| Analyzing Apple GPU performance using the shader cost graph | https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-shader-cost-graph-a17-m3 |
| Analyzing Apple GPU performance with performance heat maps | https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-performance-heatmaps-a17-m3 |
| Finding your Metal app's GPU occupancy | https://developer.apple.com/documentation/xcode/finding-your-metal-apps-gpu-occupancy |
| Reducing shader bottlenecks | https://developer.apple.com/documentation/xcode/reducing-shader-bottlenecks |
| Measuring the GPU's use of memory bandwidth | https://developer.apple.com/documentation/xcode/measuring-the-gpus-use-of-memory-bandwidth |
| Analyzing the performance of your Metal app (Instruments) | https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-metal-app |
| Inspecting shaders | https://developer.apple.com/documentation/xcode/inspecting-shaders |
| Capturing a Metal workload in Xcode / programmatically | https://developer.apple.com/documentation/xcode/capturing-a-metal-workload-programmatically |
| Replaying a GPU trace file | https://developer.apple.com/documentation/xcode/replaying-a-gpu-trace-file |
| Debugging with interactive command-line tools (`gpudebug`) | https://developer.apple.com/documentation/xcode/debugging-with-interactive-command-line-tools |
| Investigating GPU issues with AI agents (`gpudebug`) | https://developer.apple.com/documentation/xcode/investigating-gpu-issues-with-ai-agents |
| Metal debugger, Analyzing your Metal workload, Metal developer workflows, per-command counters / pipeline statistics | https://developer.apple.com/documentation/xcode/metal-debugger |

## Local Apple documentation (Xcode 27.1, build 27A9275, on this Mac)

| Source | How obtained | Cached as |
|---|---|---|
| `man gpucapture` (gpucapture 300.20): command-line GPU trace capture of any process started with `MTL_CAPTURE_ENABLED=1` | `man gpucapture \| col -b` | text/man-gpucapture.txt |
| `man gpudebug` (v1.0): command-line GPU trace replay, profiling (`profile run --exec serial --gpu-state high`), cost rankings, heat maps, counter time series | `man gpudebug \| col -b` | text/man-gpudebug.txt |
| `man xctrace`, `xctrace help record` | `man`, `xcrun xctrace help record` | text/man-xctrace.txt, text/xctrace-help-record.txt |
| `xctrace record --show-recording-options` for Metal System Trace, Game Performance, Game Performance Overview and the GPU instruments (prints JSON, records nothing) | `xcrun xctrace record --template … --show-recording-options` | text/xctrace-recording-options.txt |
| Instruments package docs: GPU.instrdst (table schemas incl. `metal-gpu-intervals`, `gpu-performance-state-intervals`, `metal-shader-profiler-intervals`) and GPUCounters.instrdst ("Metal GPU Counters" instrument, `metal-gpu-counter-intervals`) | copied from `/Applications/Xcode.app/Contents/Applications/Instruments.app/Contents/Packages/*/Contents/Documentation/fulldoc.html` | raw/instruments-gpu-fulldoc.html, raw/instruments-gpucounters-*.html, text/instruments-gpu*.txt |

## Non-Apple, for the Chrome side

| Source | URL | Cached as |
|---|---|---|
| Dawn "Debugging Dawn" (Google, BSD): toggles incl. `use_user_defined_labels_in_backend`, `DAWN_TRACE_FILE_BASE` Metal .gputrace, `MTL_CAPTURE_ENABLED=1` | https://github.com/google/dawn/blob/main/docs/dawn/debugging.md (raw.githubusercontent.com copy; dawn.googlesource.com serves the same file base64) | raw/dawn-debugging.md, text/dawn-debugging.md |
| Dawn source, Metal backend (BSD): which Metal sample points WebGPU timestamps use, math mode | https://github.com/google/dawn/blob/main/src/dawn/native/metal/CommandBufferMTL.mm, …/ShaderModuleMTL.mm | raw/dawn-src/ |
| Brandon Jones (Toji), "Profiling WebGPU with Xcode's Metal Debugger" (last updated 2025-03-11): the only step-by-step for capturing Chrome's GPU process in Xcode | https://toji.dev/webgpu-profiling/xcode | raw/toji-webgpu-profiling-xcode.html, text/toji-webgpu-profiling-xcode.txt |

## Not obtained

- Apple's "Converting a GPU's counter data into a readable format" and "Creating a counter sample buffer…" articles:
  the guessed JSON paths returned 404. The parent article lists them; nothing in this report depends on them.
- Apple's Metal System Trace / Instruments user guide pages for the counter set picker (the old Instruments Help
  book is gone); the WWDC20 10603 demo and the Xcode docs above cover the same steps.
- No source documents the M5's counter list or whether the `xctrace` command line can switch the counter set
  (see KNOWLEDGE.md, open questions).
