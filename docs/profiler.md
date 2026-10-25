# Profiler

## GPU counters

`tools/gpu-counters.mjs` records Xcode's Metal System Trace (`xctrace`) of one
process, Chrome's GPU process, and reports it per Metal encoder. That is one
WebGPU pass when Chrome runs with
`--enable-dawn-features=use_user_defined_labels_in_backend`
(`COUNTER_CHROME_ARGS`). Without that switch Dawn leaves Metal's default names,
such as "Compute Command 3", and the rows can't be matched to our passes.

```js
import { startCounters, findGpuProcess, COUNTER_CHROME_ARGS } from './gpu-counters.mjs';
const c = await startCounters({ pid: findGpuProcess({ parentPid: process.pid }), seconds: 4 });
// ...frames run...
const { byEncoder, summary } = await c.stop();
```

From the command line: `node tools/gpu-counters.mjs [--pid N] [--seconds 4] [--json out.json] [--keep]`.
With no pid it uses the only Chrome GPU process that is running.

`stop()` sends SIGINT to xctrace straight away and then parses the trace. That
parse is CPU-only and takes 10–60 s, so close the browser before you await it.
Traces go to `$TPT_XCTRACE_DIR` (default `$TMPDIR/tpt-gpu-counters`) and are
deleted afterwards unless you pass `keep`. When something goes wrong it says
so: xctrace missing, template missing, permission refused (with the
`DevToolsSecurity` fix), no or several GPU processes, a second xctrace already
recording, or a start or save timeout. It kills xctrace and never hangs.

### What each field means

| field | meaning |
|---|---|
| `label` | the Metal encoder label, which is the WebGPU pass label when the Dawn switch is on |
| `count` | how many times that encoder ran during the capture |
| `gpuMs` | mean GPU time per run: the longest of its channels, because vertex and fragment work overlap on Apple's tiler |
| `channels.Vertex / Fragment / Compute` | mean GPU ms per run in each hardware channel. A render pass whose Fragment time dwarfs Vertex is pixel-bound |
| `spills.bytesMax` | the largest register spill reported for one shader run in this encoder (driver "compiler spill events"). Not zero means the shader ran out of registers and spills to memory |
| `spills.pipelinesPerEncoder` | spilling pipeline uses per encoder run. In timing split mode each dispatch is its own pass, so this names the kernel |
| `occupancy`, `limiters` | hardware occupancy and ALU / texture / memory limiter percentages. These stay **null on this Mac**, see below |
| `summary.top` | the most expensive encoders and their share of this process's GPU time |
| `summary.spilling` | encoders whose shaders spill, worst first |
| `summary.counterNote` | which counters the device streamed and why some fields are null |

### What a register-pressure / occupancy problem looks like

- **Spills:** `spills.bytesMax` is above zero on the slow pass. A few hundred
  bytes per thread is already a lot, and kilobytes means the shader is
  memory-bound on its own scratch. This is the direct signature of the cliff
  we suspect. Fix it by cutting live values: split the shader, recompute
  instead of keeping values, and shrink arrays held in registers.
- **Occupancy** (when available): a low "Occupancy" or "Fragment Occupancy"
  percentage alongside a high `gpuMs` and low ALU or texture limiters means
  too few threads fit on each core, so latency is not hidden. Registers are
  the usual cause.
- **Limiters** (when available): the highest limiter names the bottleneck.
  ALU means arithmetic, Texture Sample / Filtering means texture fetches,
  Buffer / Memory read means bandwidth, and "Last Level Cache" means misses.
  If every limiter is low but the pass is slow, the shader is
  occupancy-bound or stalled.

### What this Mac can't give (M5, Xcode 27.1, 2026-10-24)

`xctrace` sends only the "RT Unit Active" counter, whatever counter set the
template asks for. We patch Apple's template to "Performance Limiters" (raw
profile 3) and to this GPU's registry id, and the recorded settings confirm
both. Shader Timeline also records nothing from the command line. Occupancy
and limiters therefore need **Instruments.app** (Metal System Trace, set
GPU > Counter Set to Performance Limiters, attach to the Chrome GPU process)
or an Xcode GPU capture. The tool's spills and channel times are real and
come from the same trace.

Attaching and recording all processes give the same Metal tables, which are
system-wide either way, so the tool always filters to the pid.
