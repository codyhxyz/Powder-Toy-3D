# WebGPU: the port's design contract

Contract for the `claude/webgpu-port` branch. Every agent porting a subsystem reads it first, and it ships in the PR
for review. It supersedes docs/scaling.md D1 ("we stay on WebGL2"); everything else in scaling.md (D2–D11) still
holds and is referred to by number ("scaling.md D8"). Where this file and a subsystem map or an older comment
disagree, this file wins. Line references are to `main` at 9b075ae, the commit the branch started from.

Revision 2, after three adversarial reviews (performance per watt, semantics of the sim port, executability by porting
agents). The **Review log** at the end records every finding and what became of it.

The user's goal: "Port from WebGL2 to WebGPU. Our goal: insane performance-per-watt, fully optimized for Apple Silicon
and similar modern devices."

**What the user's machine actually runs.** The default desktop session is World mode on the island (`app.js:104`).
Its birds call `pacer.wake()` every tick (`app.js:1412-1415`), so the full view frame is presented at 60 Hz all the
time, and Whitewater is on by default on desktop (`gfx/detail.js:32, 93-99`). The per-frame scene and post passes, the
window-move costs and aeration are what that session pays; the sim's sleeping and the settled-scene path are what a
box session and a quiet world pay. Both matter, and the targets below name both.

## A. Goals, non-goals and decisions

### Goals
1. **Everything that draws or simulates runs on one WebGPU device.** No WebGL context remains in `src/`.
2. **Behaviour parity.** Same rules, same rest states, same sleeping, same look. Within the WebGPU build the
   simulation is deterministic and its skip machinery is exact (I2). Against the WebGL2 build it is equivalent
   statistically (I4), not bit for bit.
3. **Less energy per simulated step and per presented frame.** Measured on the user's Mac against the frozen WebGL2
   build (I4, I5), with Whitewater both on (the default) and off. Targets at 128³ (lab, island, volcano): sim step
   ≤ 0.6× the legacy time; an asleep world's step ≤ 0.25× (legacy 0.18 ms, almost all of it the activity rebuild);
   `updateBricks` ≤ 0.8×; a view frame no slower; energy per step ≤ 0.7×; the default World island scene's energy per
   presented frame ≤ 0.8×; a settled box scene with zero submits and zero `requestAnimationFrame` callbacks, at lower
   package power than legacy's settled scene (legacy already makes no GL calls there; post-frame map 1.9). Targets
   are reported in the PR; missing one doesn't block parity, but the reason is written down.
4. **No main-thread compile stalls, no compile work the session doesn't need.** Every pipeline of ours is created
   asynchronously, three.js's mesh pipelines through `compileAsync`. No task longer than 100 ms on the main thread
   while pipelines build. Boot builds only what the current mode draws (B5).
5. **The test suite keeps working.** Tools keep their names and their assertions; synchronous readbacks become
   `await`s.

### Non-goals (this PR)
- Physics-changing optimizations: D7 packed state, f16 state, coarser pressure, a new GI cadence. They are in the
  Phase 2 list (K3) with the hooks this design leaves for them. (Brick-granular sleeping is **not** physics-changing:
  skipping is exact at any unit size, D5. It is in v1.)
- Cross-API bit-exactness. Floats differ between ANGLE→MSL and Tint→MSL (FMA contraction, fast math, transcendentals).
- A WebGL2 path in `src/`. The fallback is a frozen build of the last WebGL2 commit (W5).
- Toroidal world windows, compute raymarching, reusing the converged volume while only meshes move (K3).
- New features, new looks, HDR/EDR output, 120 Hz.

### Decisions

**W1. Raw WebGPU and hand-written WGSL for all simulation, derived, volume, world, POV/tool, post and codec work;
three.js only for meshes.** One `GPUDevice`, created by `src/gpu/device.js`. three.js r186 `WebGPURenderer`
(constructed with `{ device }`) draws the mesh scene only: figures (stickman, GLTF skinned mannequin, NPC wizards,
worms), viewmodels, vehicles, birds, markers, constructions ghost, billboards. The floor grid, the box edges and the
brush cursor are small pipelines of ours in the scene pass (F1), so a box-mode frame never needs three. Its materials
become TSL node materials. three.quarks goes (no WebGPU path; misc-three map 7.12). The raymarcher, post and sim stay
hand-written because TSL adds nothing to 13k lines of branchy GLSL and would hide them behind three's node builder and
its per-call submits (`WebGPUBackend.js:1565, 1855-2001`).

**W2. WGSL replaces GLSL in place, under the same names.** Same JS modules, same exported names: generators
(`reactFrag`, `prelude`, `volumeFrag`, even where "Frag" is now a compute kernel) and snippet exports
(`physicsGLSL`, `elementsGLSL`, `brickGLSL`… keep their `GLSL` suffix while they return WGSL), and the same WGSL
function names (`fetchA`, `eid`, `canMove`, `inertNear`, `land`, `packSlot`, `sunShadow`…), so a reviewer compares old
and new function by function in the diff. U16 renames every `*GLSL` export to `*WGSL` in one mechanical commit that
changes nothing else. An export another unit's file imports is never deleted or renamed during the port; it becomes a
stub (J3). Delete GLSL as you replace it; nothing in `src/` keeps both.

**W3. Core WebGPU only.** No required optional feature. v1 uses none of `subgroups`, `shader-f16`,
`texture-formats-tier1/2`, read-write storage textures or `float32-filterable`. Every kernel runs on the SwiftShader
adapter in the test container and on Safari 26. `timestamp-query` is used when present, for profiling only. Optional
fast paths come later (K3), each behind a feature check with the core path kept and tested.

**W4. Behaviour parity first.** Structural wins that compute makes possible are in scope: the fused in-place Margolus
move, GPU-built brick lists with indirect dispatch (brick-granular sleeping, incremental inert rebuild, aeration over
its own list), box-scoped writers instead of full-grid copy-through passes, few command buffers per frame, async
pipelines, 3D textures for render fields, timestamp profiling, a readback ring, deep idle. Integer, hash and generation
logic is ported verbatim so it stays exact.

**W5. WebGPU only, no fallback (the user's decision).** `src/main.js` probes WebGPU before importing the app (B2);
a browser with no usable adapter gets a page that says the game needs WebGPU and why this browser can't start it
(G5). Nothing is redirected and no WebGL2 build is deployed. Every target device has WebGPU on by default: Chrome and
Edge on macOS, Windows, ChromeOS and Android, and Safari 26 on macOS, iOS, iPadOS and visionOS (every iOS 26 browser
is WebKit, so iPhone 11 and later). What this gives up, knowingly: most Linux desktops (WebGPU in about 18% of Linux
reports) and Firefox on Linux (webgpu-research map 7.5). WebGPU needs a secure origin, so LAN dev over plain `http`
(an iPad on the dev server) has no `navigator.gpu`; the error page says so. The last WebGL2 commit is still checked out
*locally* for the Mac's cross-build comparisons (I4), never deployed.

**W6. Every GPU→CPU read is asynchronous.** One readback service (B7). `readState`, `readCell`, `census`, `gpuSync`
return promises. The laser's synchronous reach read goes away (G2). No sync read remains in `src/` or `tools/`;
`tools/check-async-reads.mjs` lints for un-awaited calls (J4).

**W7. We create the device; three.js sizes the visible canvas, we present to it.** three.js gets `{ device }` and the
page's canvas, so `renderer.domElement`, `setSize`, `setPixelRatio` and `getDrawingBufferSize` keep working at their
call sites (signs, detail, profiler, detailGate, post, viewmodel, tools). three renders only into render targets. Our
`src/gpu/present.js` configures the canvas's context with exactly the parameters three's lazy `context` getter would
use (`WebGPUBackend.js:331-367`: preferred format, `RENDER_ATTACHMENT | COPY_SRC`, `alphaMode` from three's `alpha`
parameter, tone mapping `standard`), so an accidental default-target render reconfigures nothing; a debug assertion
catches one (B10).

**W8. Few command buffers per frame, recorded by everyone into one open encoder.** A presented frame is one command
buffer of ours when three has nothing visible (every box-mode frame), else ours before three, three's own, ours after
(B3). No module calls `queue.submit` itself.

**W9. Per-dispatch values travel in a fixed-size dynamic-offset uniform ring.** A header (copies, origin) and a params
struct per dispatch, uploaded once per flush (B4). The ring never grows inside an encoder: a full ring flushes. Never
`writeBuffer` one shared uniform between commands of one encoder that read it.

**W10. State lives in three storage buffers, A, B and F, each holding both ping-pong copies, in brick-major slot
order.** A cell's slot is its brick's 64-cell run; bricks run supertile by supertile (C2). Flags are one `u32` per
cell (C3). Physical indices come only from `brickId`, `slotOf`, `brickCoord` and `cellOf`, which keeps toroidal
windows (K3) a change to those four functions. Every CPU-facing contract (`cellTexel`, `readState`, `load`, the codec
bytes, `readCells`) keeps today's atlas order through two conversion kernels.

**W11. The move is one kernel, in place, one thread per Margolus block; react stays ping-pong.** No slot array, no
gather pass, no flow pass (D2). With Whitewater on, the same pipeline runs out of place (a uniform switch) so aeration
can read the pre-move copy.

**W12. Sleeping is brick-granular, as GPU-built brick lists with indirect dispatch.** D8's channel semantics carry
over at brick resolution: AWAKE, DRAWN, per-parity MOVE lists. Supertiles existed only because the fragment path drew
one instanced quad per supertile (scaling.md D8); a list entry costs one workgroup whatever the unit size, and one
awake brick now forces its 2×2×2 brick neighbourhood (512 cells) instead of a 1024-cell supertile and up to 7
neighbours. BLOCKS and STEPS are retired. A per-brick settle counter replaces `uPrevSettled` and its `wroteSinceStep`
clause (D5). The unit is a generated constant (`SLEEP_UNIT`), so D8's supertile granularity stays one constant away
for an A/B. The inert rebuild is incremental (D4).

**W13. External writers are box-scoped dispatches, one per edit, in call order.** A writer reading only its own cell
writes the current copy in place. A writer reading other cells computes into scratch, then copies scratch into the
current copy (two-phase). Every writer marks the bricks it changes, on the GPU (D6). Edits are never batched into one
dispatch unless their boxes are provably disjoint.

**W14. Render-facing volumes are 3D textures; sim-facing and brick data are storage buffers.** Fields, light and GI
are `rgba16float` 3D textures sampled with hardware trilinear filtering (E).

**W15. The volume raymarcher and the far view are fragment shaders in our scene render pass, before three.js's
meshes.** They write `frag_depth`; three then renders every mesh into the same colour and depth with `loadOp: load`,
only on frames where it has something visible (F1). The volume map argued for compute; fragment wins for this PR
because it keeps today's composition and `frag_depth` contract with TAA, keeps `surfView`'s screen-space derivatives
exact, rasterizes only the pixels the box covers with no classification pass, and keeps colour and depth as
compressed attachments on M1–M4. Compute raymarching is Phase 2.

**W16. Post keeps the full- and half-resolution image passes as fragment passes and runs the small mips and the
reductions in one compute pass.** TAA/TAAU, the bloom prefilter into `down[0]`, the final `up[0]` and the canvas
composite are fragment passes into compressed attachments. Bloom levels 1–5 down and 4–1 up, the histogram,
adaptation and meter run in a single compute pass between them: mips at 1/8 to 1/64 resolution gain nothing from
compression, and each render pass is a full Metal render encoder (F7).

**W17. Grid and layout numbers are generated WGSL `const`s.** Element, material and mechanism tables are data in one
read-only storage buffer generated from `src/elements.js` and `src/gfx/materials.js`, so table edits don't change
shader text (C6). Variants that change code size (views, detail levels) are separate modules made by JS templates;
`override` constants are for small switches only (F2).

**W18. Every pipeline is created with `create*PipelineAsync` and an explicit layout, and only when its mode is in
use.** The start menu builds the selected map's set while it is up (B5, "Warm on the menu"), so the loading screen
shows only if Start comes first; the near-detail variant is prefetched; other
views, world kernels and POV families build on first use with the existing toast. three's mesh pipelines go through
`renderer.compileAsync`. `gfx/coldShader.js`'s hold, `detailGate`'s warm draw and `gfx/programs.js` go away (B5).

**W19. Failure keeps today's contract.** `device.lost`, uncaptured errors (ours and three's) and pipeline failures go
to `stopGraphics`; every state-mutating entry point throws `GraphicsFailure` afterwards (B9).

**W20. Rays sprites are drawn by us, after three.js, in an overlay pass; figures read our textures through
`THREE.ExternalTexture`.** That is the whole of the three.js interop surface besides the scene render target (B10).

**W21. Determinism rules.** No float atomics anywhere. Integer atomics only for counts, list appends (order-free
consumers), fixed-point ray deposits and brick marks. Every per-cell result is a pure function of its inputs and the
dispatch's params, so list order and workgroup shape can't change results (sim-core map 7.3); a test knob permutes
the lists to prove it (I2.1). Random draws keep their order. Full-range integer→float conversions go through
`u32ToF32`/`i32ToF32`, because WGSL lets a conversion round either way (H1.28).

**W22. Apple Silicon and power rules.** Workgroups are 64 threads (2 SIMD groups) unless a kernel says why. Read
buffers directly; use workgroup memory for reductions and separable filters, not as a cache (M3+ Dynamic Caching).
Render passes clear or overwrite instead of loading; MSAA and depth that aren't read later are not stored. No adapter
`powerPreference` (the browser picks by power source; `?gpu=high` opts into `'high-performance'`). At most 2 frames in
flight, 1 on WebKit. No work at all when nothing changes, down to no `requestAnimationFrame` callbacks (deep idle,
F7). The 60 Hz cap stays (`gfx/pacing.js MAX_FPS`).

**W23. Every kernel builds on the test device within a budget, or it is split.** On SwiftShader, pipeline creation
time grows about quadratically with straight-line kernel size, and a ~1,200-statement kernel lost the device in a
probe (review log, P-B2). A kernel ships only if `createComputePipelineAsync`/`createRenderPipelineAsync` resolves on
SwiftShader within `PIPELINE_BUDGET_MS` (30 s) at the smallest grid, or it is on an explicit `WGSL_MAC_ONLY` list with
a reason and a container-side substitute (I1). The sim's kernels (move, react, activity, derived) may not be on that
list. U2's first deliverable measures react and the move and fixes the move's code form (D2).

## B. The GPU foundation layer (`src/gpu/`)

### B1. Modules

| Module | Exports | Owns |
|---|---|---|
| `src/gpu/device.js` | `probeWebGPU()`, `createGpu(opts)`, `wantedLimits(adapter)` | adapter and device request, limits, `lost`, uncaptured errors, `gpu.fits(g)` |
| `src/gpu/frame.js` | `GpuFrame` (via `gpu.frame`) | the open command encoder, pass switching, flushes, frames in flight, `gpu.stats` |
| `src/gpu/params.js` | `uniformStruct(name, fields)`, `ParamRing` | WGSL struct text and JS packers kept in sync; the dynamic-offset ring |
| `src/gpu/kernels.js` | `gpu.kernel(desc)`, `gpu.renderPipeline(desc)`, `gpu.layout(name, entries)`, `fold(n)` | shader module and pipeline caches, async creation, dispatch-size checks, diagnostics |
| `src/gpu/readback.js` | `gpu.readback` | MAP_READ staging pool, copies recorded at the request, GPU-side result rings, de-padding |
| `src/gpu/timing.js` | `gpu.timing` | timestamp queries, split-pass profiling mode |
| `src/gpu/present.js` | `createPresenter(gpu, canvas)` | the visible canvas's context, `getCurrentTexture`, screenshots |
| `src/gpu/three.js` | `createThreeRenderer(gpu, canvas)`, `gpuTextureOf(three, tex)`, `externalTexture(gpuTex, opts)`, `threeHasVisible(scene, camera)` | every use of three.js internals (B10) |
| `src/gpu/errors.js` | `GraphicsFailure`, `shaderFailure(name, module)` | message formats that tools assert |
| `src/gpu/wgsl.js` | WGSL snippets that aren't the sim's: `glslMod`, `saturate`, `luma`, the full-screen triangle | shared language helpers |
| `src/gpu/index.js` | re-exports | |

Modules import nothing from `three` except `src/gpu/three.js`, and nothing touches `navigator.gpu` at import time
(Node tools import shader generators; `tools/check-imports.mjs` proves every generator module imports in Node, J4).

### B2. Adapter and device

```js
const probe = await probeWebGPU();               // { ok, reason, adapter }; no device yet (main.js)
const gpu = await createGpu({ adapter: probe.adapter, label: 'tpt3d' });
```

- `requestAdapter()` with no `powerPreference`, core feature level. Chrome then picks the integrated GPU on battery
  and the discrete one on AC (webgpu-research map 7.1); on Apple Silicon there is one GPU. `?gpu=high` passes
  `'high-performance'`.
- **Fallback (software) adapters** (`adapter.info.isFallbackAdapter`) are rejected unless the page is in test mode
  (`?test=` or `__TPT_TEST_MODE__`), running under the Vite dev server, or has `?software=1`. A user whose GPU is
  blocklisted for WebGPU gets the error page (G5), which offers `?software=1`, rather than a CPU rasterizer by surprise.
- **Required limits: the spec defaults only.** Nothing is required above them, so every WebGPU device qualifies.
- **Requested limits.** `maxStorageBufferBindingSize` and `maxBufferSize` = `min(adapter limit, 1 GiB)`: they decide
  which grids fit, not which kernels compile. Everything else is requested at the spec default on purpose, so a
  kernel that would need more fails here, on SwiftShader, and not on a user's 8-buffer device:
  `maxStorageBuffersPerShaderStage` 8, `maxStorageTexturesPerShaderStage` 4, `maxSampledTexturesPerShaderStage` 16,
  `maxBindGroups` 4, `maxComputeWorkgroupStorageSize` 16384, `maxComputeInvocationsPerWorkgroup` 256,
  `maxComputeWorkgroupsPerDimension` 65535, `maxColorAttachmentBytesPerSample` 32. Raise one only with a decision here.
- **Grids gate on the device.** `gpu.fits(g)` = both copies of A (`2·SLOTS·16` bytes) ≤ `maxStorageBufferBindingSize`
  and ≤ `maxBufferSize`. Every grid but the giant volcano's window (128×384×128: 201 MB) fits the 128 MiB default:
  A is 64 MiB at 128³ (the box default, the phones' box and the world window) and 79 MB at 160×96×160. A scene or size that doesn't fit is greyed out in the menus
  with the reason ("needs a 256 MiB storage binding; this device allows 128 MiB"); `openMap`/`setSize` refuse it.
  Recorded limits for Chrome on macOS and Safari 26 go in I4.8.
- **Optional features requested when present:** `timestamp-query`. Nothing else in v1.
- `probeWebGPU` fails when `navigator.gpu` is missing, the adapter is null, or the adapter is a rejected fallback;
  `requestDevice` rejecting is a failure too. main.js then redirects or shows the error page (G5). A device lost
  later doesn't redirect (B9).
- `gpu.adapterInfo` records vendor and architecture (SwiftShader reports `architecture: 'swiftshader'`,
  `isFallbackAdapter: true`); tools print it. `gpu.isWebKit` (Safari: no `navigator.userAgentData`, `AppleWebKit`
  without `Chrome/`) selects the WebKit frame budget (B3).

### B3. The frame model

There is always at most one open encoder, `gpu.frame`. Modules record into it; they never create encoders.

```js
const f = gpu.frame;                      // opens an encoder lazily
const pass = f.compute('sim');            // continues the open compute pass, or begins one
kernel.dispatch(f, [x, y, z], { bind, header, params });   // records into f.compute()
const rp = f.render(descriptor, 'scene'); // ends any open compute pass, begins a render pass
rp.end();                                 // back to the frame
f.copy(src, srcOffset, dst, dstOffset, size);   // ends an open pass, records the copy now
gpu.flush('before three');                // finish + submit; the next record opens a new encoder
gpu.endFrame();                           // flush, then count the frame in flight
```

A presented tick is:

```
E1 (ours)   compute: POV edits, paint, N × step, lightning, window move, rays,
                     derived passes, shadow, GI, far-field upkeep, pick
            render:  scene pass: far field | floor grid, detail meshes, volume, box edges, brush cursor
            ── only if three has something visible: flush; three.render(scene) into the scene target (its own
               submit); in POV three.render(viewmodels) into their MSAA target (its own submit) ──
E2 (ours)   render:  rays overlay (only while rays are active; depthReadOnly)
            render:  TAA/TAAU → history[next]; render: bloom prefilter → down[0]
            compute: bloom down 1–5, up 4–1; luminance grid, histogram, adaptation, meter
            render:  bloom up[0]
            render:  canvas pass (composite over the sky gradient, viewmodel composite, glow)
            copies:  GPU result rings used since the last flush → endFrame
```

E1 and E2 are one command buffer when three has nothing visible (`threeHasVisible` is false: every box-mode frame,
since the grid, edges and brush are ours). A tick that doesn't present records E1's compute part only and ends there.
A tick with nothing to do records nothing and submits nothing, and a settled app stops scheduling ticks (deep idle,
F7).

- **Ordering.** Queue order is submit order, so three sees E1's results and E2 sees three's. Within a compute pass
  every dispatch is its own usage scope: dispatch N+1 sees N's storage writes without barriers.
- **Frames in flight.** `endFrame` increments `gpu.inFlight` and decrements it on `queue.onSubmittedWorkDone()`.
  `frame()` in app.js treats a tick as not due while `gpu.inFlight >= MAX_FRAMES_IN_FLIGHT` (2; 1 when
  `gpu.isWebKit`: more than one in-flight command buffer with many passes hung iOS 26.3's queue, webgpu-research
  [S5]), before `clock.update`, exactly like `pacer.due` returning false. WebGPU never blocks `submit`, so without
  this a GPU-bound sim queues unbounded work (post-frame map 7.9). `test.render()` and `test.step()` are not throttled.
- **Work outside a tick** (tools calling `sim.step()`, `__app.test.step(n)`, the hidden toolbelt's `drive()` loop,
  promise callbacks): the first record outside a tick schedules `queueMicrotask(() => gpu.flush())`. Every readback
  API flushes before it maps. A frame holding `FLUSH_DISPATCHES` (2048) dispatches and draws of ours flushes, so
  `test.step(10000)` becomes a few hundred-step submits, not one giant command buffer, and the param ring (B4) never
  overflows.
- **FrameUniforms writes** (`gpu.frameUniforms.write(values)`, F6) flush first when the open encoder already holds a
  command that reads FrameUniforms, so every command sees the value current when it was recorded (`renderThumb`'s six
  views become six submits). It is written on every tick that records a FrameUniforms reader, including derived-only
  ticks that run shadow and GI without presenting.
- **Stats.** `gpu.stats` counts `submits, computePasses, renderPasses, dispatches, indirectDispatches, draws,
  workgroupsDirect, pipelinesCreated, pipelinesPending, bytesAllocated, bytesReadBack, bytesUploaded`. `dispatches`
  counts each indirect dispatch twice: Chrome injects a one-workgroup validation dispatch before every
  `dispatchWorkgroupsIndirect` and doesn't batch them (Dawn `ComputePassEncoder.cpp`
  `TransformIndirectDispatchBuffer`), and on Metal's serial compute encoder each is a drain. In test mode each
  indirect dispatch also records its `(buffer, offset)` so `tools/budget-check.mjs` can read the args back. The
  stats replace the `renderBufferDirect` hooks and `renderer.info.programs` in tools.

### B4. Per-dispatch values: header and params

Group 3 of every pipeline of ours is the params group: binding 0 the header, binding 1 the kernel's params, both
`uniform` with `hasDynamicOffset`. `ParamRing` hands out 256-byte slots, packs them in JS and uploads the used range
with one `queue.writeBuffer` just before each flush. It is allocated once at `FLUSH_DISPATCHES × 2 × 256` bytes
(1 MiB) and never grows: the frame flushes when it has recorded `FLUSH_DISPATCHES` dispatches and draws, so a bind
group recorded earlier in the encoder always points at the buffer the upload fills. A submitted encoder never sees a
later write (queue order), so the ring is reused after every flush. `gpu-foundation-check` records more than 2048
dispatches in one tick and checks every step's `frame` and `parity`.

```js
export const PaintParams = uniformStruct('PaintParams', {
  center: 'vec3f', radius: 'f32', shape: 'u32', tool: 'i32', rate: 'f32', replace: 'u32', frame: 'u32',
});
PaintParams.wgsl;                 // "struct PaintParams { center: vec3f, radius: f32, ... }" with WGSL uniform layout
paint.dispatch(f, size, { bind: [tables, sim.bindRW, paintGroup], header: sim.header(), params: { center, radius, ... } });
// (sim.edit() wraps exactly this for state writers, D6)
```

- `uniformStruct` computes WGSL uniform-address-space offsets and alignment (vec3 → 16-byte align, `bool` → `u32`,
  arrays → 16-byte stride) and is the only place both sides of a struct are written. Never hand-write a uniform
  struct twice.
- The sim header (C5) is `{ origin: vec3i, src: u32, dst: u32 }`: the window's origin (D11's `uOrigin`) and which
  state copies the dispatch reads and writes. Every pipeline of ours has the binding; kernels that don't read the
  state still get `sim.header()` (or `gpu.nullHeader`).
- Values that change per step (`frame`, `parity`, `gravity`, `fresh`, `rays`, `outOfPlace`) are params, one slot per
  step. Several steps in one encoder each read their own slot. GPU-resident counters could carry `frame` and
  `parity`, but not `fresh`, `gravity` or `rays`, which the CPU decides per step; one mechanism for all is simpler.

### B5. Kernels, pipelines, layouts and cold start

```js
const react = gpu.kernel({
  name: 'react',                                   // label, profiler pass name, error text
  code: reactFrag(g),                              // WGSL string (generated)
  layouts: [L.TABLES, L.STATE_RW, L.REACT, L.PARAMS],
  params: ReactParams,                             // uniformStruct for binding 1 of group 3
  constants: {},                                   // override values (small switches only, W17)
  workgroupSize: [64, 1, 1],                       // documentation and dispatch-size math
});
await react.ready;                                 // createComputePipelineAsync resolved
react.dispatch(f, { indirect: sim.args, offset: ARGS.REACT }, { bind, header, params });
```

- Layouts are explicit `GPUBindGroupLayout`s named in `L` (C4), never `'auto'`, so bind groups are shared across
  pipelines and created once per grid.
- Shader modules are cached by source text; pipelines by module, entry, layouts, constants and target formats.
  A rebuilt grid of the same size reuses every pipeline (today's `retire`/`claimPrograms` dance goes).
- **Dispatch sizes.** `kernel.dispatch` asserts every dimension ≤ `device.limits.maxComputeWorkgroupsPerDimension`.
  Whole-grid and per-brick kernels use `fold(n)` = `[ceil(n / y), y, 1]` with `y = ceil(n / 65535)` (fewer than `y`
  spare workgroups) and compute their index as `wg.x + wg.y · num_workgroups.x` (`@builtin(num_workgroups)` works
  for indirect dispatches too), returning if it is past the end. The giant volcano has 98,304 bricks; a 1-D dispatch of them is invalid. Indirect args are folded the
  same way by the kernel that writes them.
- **Compile budget (W23).** `tools/check-wgsl.mjs --time` reports each pipeline's creation time on SwiftShader. A
  kernel over `PIPELINE_BUDGET_MS` is split (separate entry points, a loop over a rule table instead of unrolled
  code, fewer inlined variants) before it ships, or, for render-only modules, put on `WGSL_MAC_ONLY` with a reason.
- **Warm on the menu** (the user's call: compile while the player is busy choosing, the way a catalogue site loads
  behind its first page). `src/preload.js`, once the menu is idle, creates the device (B2) and starts building the
  selected map's set (the list below) for its grid; selecting or hovering a map with another grid starts that grid's
  set too, before the click. The default box and the world's window are both 128³, so one warm-up covers most play.
  Pipelines are cached by source and descriptor (above), so `new Simulation` and the renderer then find them built.
  The set per grid comes from each module's `WGSL_CHECK` list, the same one `check-wgsl` builds. Start awaits only
  what is still pending, behind today's loading screen. Nothing here blocks the menu: creation is asynchronous, at
  most `PIPELINE_CONCURRENCY` at a time. The device made here is the one app.js uses (`launch.gpu`).
- **Cold start.** Boot builds the current mode's set (already warm from the menu, above) and awaits what remains: the sim step and
  activity kernels, the derived kernels, shadow and GI only if the current view uses them, the current view's base
  volume module, the scene overlays, post, pick. Then, in the background, the current view's near-detail variant
  (`detailGate`'s prefetch). Everything else builds on first use, with the existing toast: another view, the world's
  kernels on entering a world, the POV families on entering POV, a POV tool on first equip. Background work is
  scheduled with `detailGate.js:64`'s `idle()` (`requestIdleCallback`, else `setTimeout`: Safari 26 has no
  `requestIdleCallback`), at most `PIPELINE_CONCURRENCY` (2) at a time; a mode the player just entered builds all of
  its pipelines at once. A pipeline still pending when needed: the view keeps the previous variant or draws without
  the volume and keeps `pacer.wake()`ing; a POV tool's use waits.
- **three's pipelines.** three creates a mesh's pipeline synchronously at its first draw (`WebGPUPipelineUtils.js:262`)
  unless it was compiled with `compileAsync` (`:291`). Every module that adds a new kind of mesh to the scene
  (figure, vehicle, billboard pool, ghost, marker) first awaits `three.compileAsync(object, camera, scene)`
  (wrapped as `gpu.three.prepare(object)`), and the object joins the scene when it resolves.
- `__app.test.ready()` resolves when every pipeline the current settings need is ready, ours and three's.
  `tools/browser.mjs` `render(page)` awaits it instead of polling `detailGate.pending`. In test mode `?view=plain`
  (honoured by `test.ready()`) boots the cheapest view, so app-level tests don't depend on the realistic module
  building on SwiftShader.
- Dawn's persistent pipeline cache makes a second visit warm; its key includes the WGSL text, so a deploy that
  changes a module makes that module cold again. Cold means a fresh browser profile. Compile time on the Mac is
  measured early (Mac checkpoints M1, M2 in I4), not at the end.

### B6. Bind groups

- Created once per grid (or per resize for screen-sized targets) and cached on their owner. Never per frame.
- The two state copies are halves of one buffer (C1), and so are aeration's two copies, so neither has ping-pong
  bind groups: the header's `src`/`dst` (or a param) choose. Textures that ping-pong (TAA history, bloom levels, blur
  scratch) get one bind group per parity, made up front.
- A buffer is never bound writable twice, or writable and read-only, in one dispatch (a usage-scope error). The same
  holds for a texture bound as a storage texture and as a sampled texture: writer kernels use the layout variants of
  F6. Indirect argument buffers are separate from any buffer the consuming dispatch writes.

### B7. Readback

```js
const bytes = await gpu.readback.buffer(src, offset, size);          // ArrayBuffer (a copy; safe to transfer)
const px = await gpu.readback.texture(tex, { origin, size, format }); // TypedArray, rows de-padded
const ring = gpu.readback.ring('actCounts', 16, 64);                 // GPU-side result ring: 64 slots of 16 B
const counts = await ring.read(slot);                                // after the flush that copies it
```

- **A copy is recorded at the request, not later.** `readback.buffer`/`readback.texture` end any open pass and record
  `copyBufferToBuffer`/`copyTextureToBuffer` at the call, into the current flush's staging buffer (MAP_READ |
  COPY_DST, pooled by size class), mapped once after that submit. The bytes are the state at the call, whatever is
  recorded after it in the same encoder (`readCells`, `readState`, state-hash's per-stage checkpoints).
- **Results produced inside a pass** (an activity build's counts, idle counts, pick results, probes) are written by
  the kernel into a slot of a GPU-side ring, indexed by a CPU counter passed in the dispatch's params. Each ring's used
  range is copied once at the flush. A slot's index says which build or request the value belongs to. Nothing copies
  from inside a compute pass (`copyBufferToBuffer` can't be recorded there).
- The mapped range is copied into a pooled `ArrayBuffer` before resolving: mapped memory can't be transferred to a
  worker, and the staging slot must go back to the pool.
- Callers keep their own staleness tokens (`epoch`, `generation`, `sim.id`) exactly as today; the service only
  rejects on device loss or destroy.
- Texture copies use 256-byte `bytesPerRow`; the service de-pads. Small GPU results are written to storage buffers,
  not textures.
- Large one-offs (`readState` 67 MB, codec 8 MB) use the same API; the pool keeps at most `READBACK_POOL_BYTES`
  (64 MiB) of idle staging and destroys the rest.

### B8. Timing

- With `timestamp-query`, `gpu.timing.enabled = true` adds `timestampWrites` to every pass of ours and resolves them
  through the readback service. Results land 1–3 frames late in `gpu.timing.last` (`{ passName: ms }`).
- **Split mode** (while the in-app profiler is on): each dispatch gets its own compute pass so it gets its own
  timestamps, and `gfx/profiler.js` keeps its `PHASES` and `passes[]` report shape. Off by default; it costs passes.
- Chrome quantizes timestamps to 100 µs unless WebGPU developer features are on; the test launcher turns them on (I3).
- `gpu.fence()` = `queue.onSubmittedWorkDone()` after a flush: the real fence that replaces every sync 1×1 read.

### B9. Errors and device loss

- `device.lost.then(info => fail(new Error(`The browser lost the WebGPU device (${info.reason}): ${info.message}`)))`.
- `device.addEventListener('uncapturederror', e => fail(e.error))`, not `onuncapturederror`: three's
  `WebGPUBackend.init` assigns `device.onuncapturederror` (`WebGPUBackend.js:281`), which would replace an assigned
  handler but not a listener. After `renderer.init()`, `renderer.onError` and `renderer.onDeviceLost` forward to
  `fail` too (three's defaults only `console.error`). `fail` is idempotent. The message includes the label of the
  object involved (every buffer, texture, bind group, pipeline and pass gets a label).
- A pipeline promise that rejects calls `module.getCompilationInfo()` and fails with
  `GPU shader failed: <kernel name>.\n<line:col message>…` (the format `tools/gpu-failure-check.mjs` asserts, with the
  offending identifier in the text).
- `fail` is app.js's `stopGraphics`, registered with `gpu.onFailure`. After it, `gpu.frame` throws `GraphicsFailure`,
  so `sim.step`, `sim.paint`, `openMap`, `setSize`, `loadPreset`, `worldLoad` and `test.step` throw as today. The old
  `renderer.render = () => { throw }` monkeypatch (app.js:201) goes.
- `?gpudebug=1` wraps each dispatch and draw in `pushErrorScope('validation')`/`popErrorScope` to attribute errors to
  a kernel, and builds the prelude with `debug: true` (out-of-grid access counter, C5). Off by default (it costs a
  promise per dispatch).
- Test hook: `__app.gpu.lose()` calls `device.destroy()`; the lost reason is `'destroyed'`. It replaces
  `WEBGL_lose_context`. There is no restore, as today (app.js:210-214): GPU-only state can't come back.
- `gpu-foundation-check` injects a validation error after three is initialised and asserts it reaches `fail`.

### B10. three.js interop (`src/gpu/three.js`, the only module touching three internals)

- `createThreeRenderer(gpu, canvas)` → `new WebGPURenderer({ device: gpu.device, canvas, antialias: false, alpha:
  false })`, `await renderer.init()`, `autoClear = false`. three sizes the canvas (`setSize`, `setPixelRatio` as
  today) and renders only into render targets. `alpha: false` matches the opaque canvas (F7). In test and dev
  builds `renderer.render` asserts `getRenderTarget() !== null`.
- `__app.renderer` is this renderer. Tools may use `domElement`, `setSize`, `setPixelRatio`, `getPixelRatio`,
  `getSize`, `getDrawingBufferSize` and `compileAsync`; nothing that reads pixels (`readRenderTargetPixels*`) or
  renders to the canvas. `renderer.info.programs` is replaced by `gpu.stats`.
- `threeHasVisible(scene, camera)`: any visible renderable in a layer the camera sees (no frustum test). When false,
  app.js skips `three.render` and the flush before it.
- Cameras we draw with get `camera.coordinateSystem = THREE.WebGPUCoordinateSystem` and `updateProjectionMatrix()`
  at creation, so our passes and three agree on clip depth [0, 1] from the first frame.
- `gpuTextureOf(three, texture)` = `three.backend.get(texture).texture`, after `three.initRenderTarget(rt)` or
  `three.initTexture(tex)`. Used for the scene render target (F3) and the viewmodel target. Callers compare the
  returned identity on every use and rebuild the bind groups holding it when it changed: three recreates the
  `GPUTexture` on resize, on a `samples` change and after `dispose`.
- `externalTexture(gpuTexture, { dimension, format, type, width, height, depth })` → `THREE.ExternalTexture` with
  `is3DTexture` set for 3D, so TSL emits `texture_3d<f32>` (`WGSLNodeBuilder.js:2212`) and the backend adopts our
  texture without copying or ever destroying it (`WebGPUTextureUtils.js:320, 486`). **An ExternalTexture can't be
  repointed**: changing `sourceTexture` and bumping its version makes `Textures.updateTexture` call `createTexture`
  again, which throws "Texture already initialized" (`Textures.js:306`, `WebGPUTextureUtils.js:306-316`). When our
  GPUTexture is recreated (a new grid), make a new ExternalTexture, set the TSL texture node's `.value` to it and
  dispose the old one.
- three types a `FloatType` texture `unfilterable-float` when the device lacks `float32-filterable`
  (`WebGPUBindingUtils.js:547-557`), which ours does by design, but still binds a filtering sampler for TSL
  `texture()`. So float textures (the shadow maps) are read in TSL with `textureLoad` only, as `lighting.js:256-336`
  already reads them with `texelFetch`.
- **Never dispose a `THREE.Sprite`'s geometry.** It is the one quad every Sprite shares (three's `Sprite.js`), and
  r186's WebGPU backend destroys its interleaved buffer but keeps it cached (`WebGPUAttributeUtils.destroyAttribute`
  forgets the attribute, not its `InterleavedBuffer`), so the next sprite drawn submits a destroyed buffer and graphics
  stop (Sync 4). Dispose a sprite's material and textures only.
- A boot self-test (`tools/gpu-foundation-check.mjs`) renders a three mesh into a target we then read, samples an
  external 3D texture from a TSL material, swaps the external texture's source once, and checks error routing. All
  rely on internals, so they must fail loudly on a three upgrade.

## C. Simulation state

### C1. Buffers

| Buffer | WGSL | Bytes per cell | Contents |
|---|---|---|---|
| `A` | `array<vec4f>`, length 2·SLOTS | 16 per copy | (id, °C, life/latent/fuel, ctype + seed) as today (D5) |
| `B` | `array<vec4f>`, length 2·SLOTS | 16 per copy | (velocity xyz in cells/step, pressure) |
| `F` | `array<u32>`, length 2·SLOTS | 4 per copy | activity flags (C3) |
| `flow` | `array<vec2u>`, SLOTS | 8 | flow field, 3 × f16 + 0 via `pack2x16float` (one copy; RMW only by the cell's owner; shifts run out of place) |
| `moveSrc` | `array<u32>`, SLOTS | 4 | the source index 0..7 of each cell's content after the move (Whitewater only; a 4-byte dummy otherwise) |

Per-brick and bookkeeping buffers (generated offsets, one binding each):

| Buffer | Holds | Written by |
|---|---|---|
| `marks` | `array<atomic<u32>>`: bitsets `act` and `derived` (one bit per brick, D6), `foams` (one word per brick, D3, G4) | writers (`atomicOr` of both bits, `atomicStore` of `foams = 1`), react (`atomicStore` of its brick's `foams`), the build (clears `act`), the age pass (clears `derived`) |
| `act` | `inert`, `quiet`, `changed`, `map` (AWAKE, DRAWN, run counter), `aerSeen` (AER history), one `u32` per brick each; the DRAWN, MOVE1, INERT and AER lists; append counters; indirect args; the counts ring | the activity build (D4) and the AER list kernel (G4), with `act` read_write in their own group-1 layout; one writer per word per dispatch |
| `rayDeposit` | `array<i32>`, two per slot | rays (G3) |

Copy `c` of a cell at slot `s` is element `c·SLOTS + s`. Both copies in one buffer halve the state's storage
bindings, which keeps react within 8 storage buffers (C4). `SLOTS = NX·NY·NZ` (no padding in slot order).

### C2. Slot order (decision: brick-major)

The maps proposed keeping the atlas texel index as the buffer index. Coalescing would be fine (a brick tile row is
8 texels = 128 bytes, one Apple cache line), but an atlas row is 32 KB at 128³, so a brick spans 8 pages and a
supertile 32 pages of A, 32 of B and 16 of F. Workgroups here are bricks, and they run by the thousand from indirect
lists. Brick-major order makes a brick one 1 KB run of A and a supertile one 16 KB run, for the cost of two small
conversion kernels at the CPU boundary.

```wgsl
const SB = vec3i(4, 2, 2);                       // bricks per supertile (SUPER)
fn brickId(b: vec3i) -> u32 {                    // supertile-major brick number
  let s = b / SB;  let k = b - s * SB;
  let st = s.x + STX * (s.z + STZ * s.y);        // supertile number, as atlas() numbers it
  return u32(st * 16 + k.x + 4 * (k.z + 2 * k.y));   // its tile's row-major place in the supertile square
}
fn slotOf(p: vec3i) -> u32 {                     // a brick's 64 cells in D6 tile order
  let l = p & vec3i(3);
  return brickId(p >> vec3u(2u)) * 64u + u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1)));
}
```

`cellOf(slot)` and `brickCoord(id)` invert them exactly as `cellFromFrag` inverts `atlas()` (`common.js:120-128`).
Within a brick the order is the D6 tile's row-major texel order, so a brick of slots is "the same 8×8 tile, stored
contiguously". A supertile is `slot >> 10`, a brick `slot >> 6`. Brick-resolution buffers use `brickId` order too.

**Physical indices come only from these four functions** (and `slot >> 6`, `slot >> 10`): no kernel computes a
buffer index from coordinates any other way. `tools/check-state-access.mjs` enforces it for the state. Toroidal
windows (K3) then change `brickId`/`brickCoord` and `world/window.js` only.

`slotOf` of an out-of-grid cell is a valid slot of another cell (`slotOf(-1, 6, 7) = 763`): bounds are the caller's
job (D8.9, H1.29).

JS mirrors in `src/sim.js`: `cellSlot(g, x, y, z)`, `slotCell(g, s)`, beside the unchanged `gridLayout`, `cellTexel`,
`texelCell`. The CPU contract stays atlas order:

| API | Order | How |
|---|---|---|
| `await sim.readState()` → `[A, B]` | atlas (`cellTexel`), length `width·height·4` | `toAtlas` kernel into scratch, then readback |
| `sim.load(A, B)` | atlas | `writeBuffer` into scratch, `fromAtlas` kernel into the current copy, `fresh` flags, `forceAll` |
| `await sim.readCopies()` | atlas, both copies, flags included | for state-hash's `copies` line |
| `createPacker(gpu).pack(sim)` bytes, `readCells` | atlas RGBA8 per texel | the pack kernel writes texel order directly |
| `await sim.readMaps()` | brick coordinates `bx + BX·(by + BY·bz)`: `{ inert, quiet, awake, drawn }` | tools only; activity-check, state-hash `maps`, I2 |

The multiplayer wire format is therefore unchanged, and WebGL2 and WebGPU peers still read each other's frames.

### C3. Activity flags

One `u32` per cell, bits as today (`common.js:62`: SELF 1, NEAR 2, MATTER 4, DIRTY 8); every other bit is zero and
stays zero. Packing 4 cells per word would cut a full inert rebuild's read from 8 MB to 2 MB at 128³, but at parity 1
a Margolus block's x-pair straddles two bricks' words, and every one of ~20 writer kernels writes single cells: each
word would need atomics or x-run ownership everywhere. Every flag word has exactly one writer per dispatch, so no
atomics are needed. The cost of the wider flags is paid only where flags can have changed: the inert rebuild is
incremental (D4), so an asleep world reads almost none of them. Packing comes back with D7 (K3).

### C4. Bindings and limits

Group convention for every pipeline of ours:

| Group | Sim and tool kernels | Render kernels (volume, far, shadow, GI, probes) |
|---|---|---|
| 0 | `L.TABLES`: tables (storage, read) | `L.FRAME`: tables + `FrameUniforms` (uniform) |
| 1 | `L.STATE_RW`: A, B, F, marks (read_write), act (read); or `L.STATE_ACT`: A, B, act (read) for sim-side kernels that only read (aeration, probes) | `L.STATE_RO`: A, B (read) |
| 2 | the kernel family's own resources | `L.LIGHTING` or one of its writer variants (F6) |
| 3 | `L.PARAMS`: header, params (dynamic uniform) | same |

Budget per kernel: **8 storage buffers, 4 storage textures, 16 sampled textures** (B2). Bindings declared in a layout
count even if a kernel doesn't use them, so families get the smallest layout that fits. `tools/check-wgsl.mjs` prints
every pipeline's per-stage storage buffer and storage texture counts against 8/4: SwiftShader allows 10 storage
buffers, so only the requested limit catches an overrun.

| Kernel | Storage buffers |
|---|---|
| react | tables, A, B, F, marks, act, rayDeposit = 7 |
| move (one pipeline, both modes) | tables, A, B, F, marks, act, flow, moveSrc = 8 |
| activity build kernels | tables, A, B, F, marks, act (group 1 of their own: act read_write) = 6, + rayBricks = 7 |
| aeration (and its list kernel's reader side) | tables, A, B, act (`L.STATE_ACT`: the quiet map and the AER list), moveSrc, aeration (both copies) = 6 |
| volume fragment | tables, A, B (`L.STATE_RO`), brick, brickDist, flow, aeration = 7 |
| GI gather (`L.LIGHTING_GI`) | tables, A, B, brick, brickDist, giSrc, probe history = 7, and 4 storage textures |

`act` holds every activity array and list (C1), which is what keeps the build at one binding for all of them.
`src/shaders/common.js` exports `LAYOUT` (the entries of `L.*` for the state) so every family builds on the same
binding numbers. A writable buffer is never also bound read-only in the same dispatch (B6), which is why the activity
builder's group 1 is its own layout with `act` read_write.

### C5. The WGSL prelude (`src/shaders/common.js`)

`prelude(g, opts)` returns WGSL with, in order:
1. Generated `const`s replacing every `#define` (`NX`, `NY`, `NZ`, `BS`, `STX`, `STY`, `STZ`, `BX`, `BY`, `BZ`,
   `SLOTS`, `NBRICKS`, `NSUPER`, `SLEEP_UNIT`, `CELL_M`, `SEED_MAX`, `FLAG_*`, `AIR_T_IN_NEAR`), each with an explicit
   type (`i32`, `u32`, `f32`, `bool`). `STW`, `FTX`, `BTX` and the block atlas are gone: nothing on the GPU uses atlases.
2. `physicsGLSL()` (`src/physics.js`; name kept, W2): `const NAME: f32 = <String(x)>;` for every PHYS entry.
3. `elementsGLSL()` (`src/elements.js`): `const NE: i32`, `K_*`, `R_*`, `E_*`, `T_*` as `const i32`; the `Tables`
   struct and its binding; accessor functions with the table's old names (C6).
4. The header binding (`@group(3) @binding(0) var<uniform> H: Header`) and the state bindings for `opts.state`
   (`false` | `'read'` | `'read_write'`), with `opts.flags`, `opts.marks`, `opts.act` to include F, the marks and the
   activity arrays.
5. Layout: `brickId`, `brickCoord`, `slotOf`, `cellOf`, `inGrid`, `supertileOf`, `fold` index helpers.
6. Accessors, the only code that indexes A, B, F (D5, enforced by `tools/check-state-access.mjs`):
   ```wgsl
   fn fetchA(p: vec3i) -> vec4f { return A[H.src * SLOTS + slotOf(p)]; }
   fn fetchB(p: vec3i) -> vec4f { return B[H.src * SLOTS + slotOf(p)]; }
   fn fetchF(p: vec3i) -> u32   { return F[H.src * SLOTS + slotOf(p)]; }
   // the caller has established inGrid(p) (H1.29)
   fn writeState(p: vec3i, a: vec4f, b: vec4f, f: u32) { let i = H.dst * SLOTS + slotOf(p); A[i] = a; B[i] = b; F[i] = f; }
   // writers (D6): false and no store outside the grid; else store only if something changed, and mark the brick
   fn writeCell(p: vec3i, a: vec4f, b: vec4f, f: u32, oA: vec4f, oB: vec4f) -> bool
   ```
   Slot-taking twins (`fetchAs(s)`, `writeStateS(s, …)`) exist for kernels that start from a slot, so they don't
   recompute `slotOf`. With `opts.debug` (`?gpudebug=1`, the harness, sim-check), every accessor tests `inGrid` and
   counts violations in a debug buffer (`dbgOob`); sim-check asserts the count is 0 (I2.8).
7. `eid`, `pcg`, `seedWorld`, `seed3` (hashing `p + H.origin` with `bitcast<u32>`), `u32ToF32`, `i32ToF32`,
   `rnd(rs: ptr<function, u32>)`, `airDensity`, `densityOf`, `isGasLike`, `isFluid`, `movable`, `hitKE`, `shockActs`,
   `impactActs`, `canMove`, `blackbody`, `electricityGLSL()`, `incandescenceGLSL()`, then `inertSelfGLSL`, `ownFlags`,
   `nearChange`, `freshFlags`, `writtenFlags`.
8. `editMain(update, opts)` (D6), the template every box writer's `main` comes from.

```wgsl
// Correctly rounded u32 → f32 on every device. WGSL lets f32(u) round either way when u isn't representable
// (SwiftShader doesn't round to nearest even; Metal does): both terms here are exact, so the one add rounds.
fn u32ToF32(s: u32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255u); }
fn i32ToF32(s: i32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255); }
fn rnd(rs: ptr<function, u32>) -> f32 { *rs = pcg(*rs); return u32ToF32(*rs) * (1.0 / 4294967296.0); }
```

Every random stream is a function-scope `var rs: u32` passed down as `ptr<function, u32>`. WGSL has no address-space
polymorphism, so `rnd(&rs)` on a `var<private>` is a type error (Tint: "expected 'ptr<function, u32, read_write>',
got 'ptr<private, u32, read_write>'"). The move kernel declares `var rs` in its `main` and passes it into `land()`
and the generated block code (`move.js:202`'s global `uint rs` goes).

### C6. Tables

- One read-only storage buffer per grid-independent table set, built once per page from `src/elements.js` and
  `src/gfx/materials.js`: `struct Tables { elem: array<Element, NE>, rx: array<u32, NE * NE>, rxDef: …, out: …,
  spec: …, mat: array<Material, NE>, incand: array<vec4f, 32> }`. Fixed sizes, so one binding holds it all. `Element`
  includes `foams` (`AER_FOAMS`, `liquidDetail.js`), which react needs for the aeration list (D3).
- The generator emits the WGSL struct and an `ArrayBuffer` from the same field list (`uniformStruct`-style layout
  rules for storage), so the two can't drift. `tools/tables-check.mjs` reads every field back through a kernel and
  compares it to the JS value: exact.
- Array-of-struct, so react's many reads of one element share cache lines; Apple serves small read-only buffers well.
  Don't emit WGSL `const` arrays indexed by a runtime id: Tint may copy them per invocation (webgpu-research map,
  [S24]).
- **Accessors keep the old names as functions**: `KIND[id]` becomes `KIND(id)`, `HOT[id].x` becomes `HOT(id).x`,
  `INTO[id][PH_HOT]` becomes `INTO(id)[PH_HOT]`. Booleans are `u32` in the buffer; their accessors return `bool`.
  The port of a use is mechanical: `NAME[` → `NAME(`.
- Values are `Float32Array` copies of the JS numbers, equal to `Math.fround`, which is what `String(x)` in WGSL
  becomes too (one more rounding than GLSL's direct decimal parse; irrelevant within WebGPU).
- Small fixed tables used in code (`FACES`, `DIRS`, the 32 GI directions, Vogel disks) become functions or
  arithmetic on the index, or `var<private>` arrays when ≤ 8 entries. Never a dynamically indexed big `const` array.

### C7. Contracts kept for other modules and tools

`Simulation` keeps its JS surface (sim-core map 8) except where W6 makes it async or the material plumbing disappears:

| Today | WebGPU |
|---|---|
| `new Simulation(renderer, nx, ny, nz, opts)` | `new Simulation(gpu, nx, ny, nz, opts)`; `await sim.ready` before the first step |
| `stateA/B/F`, `targets`, `cur` | `sim.state` = `{ A, B, F, flow, cur, slots }` (GPUBuffers); `sim.bindRO`, `sim.bindRW`; `sim.header(src, dst)` |
| `run(mat, target)`, `pass(mat)`, `rawMat`, `makeFieldTarget`, `makeStateTarget`, `quad/scene/camera` | removed (stubs during the port, J3); `sim.edit()`, `sim.editKernel()`, `sim.probe()` (D6), `gpu.kernel()` |
| `touch(lo, hi)`, `touchCentres` | kept as dispatch-box helpers; marking is automatic (D6) |
| `readState`, `readCell`, `census`, `gpuSync` | same names, async |
| `actQuiet`, `actInert`, `superShare`, `superU.uFullShare` | `await sim.readMaps()`; `skipSleeping = false` feeds every kernel a list of every brick (internally `listAll`) |
| `skipQuiet`, `skipSleeping`, `incremental`, `idleCertified`, `actDirty`, `wake()`, `version`, `frame`, `paints`, `gravity`, `origin` | unchanged |
| `sim.g` (`gridLayout`) | unchanged fields (tools read `width`, `height`, `bwidth`…), plus `slots`, `nbricks`, `nsuper` |
| `flowV`, `flowTexture` | `sim.state.flow`; `await sim.readFlow()` (half-float words, atlas order) |
| `updateBricks`, `updateGI`, `fields`, `light`, `brick`, `brickDist`, `giProbes`, `giTextures` | delegated to `src/derived.js` (E); `sim.resetGI()` replaces raw GL clears |
| `onPass(name, target)` | `onPass(name, { kind, gpuMs })` |
| `mats.giGather.uniforms…` (far attach) | `derived.attachFar(far)` (called by `src/wire/world.js`) |
| `this.rays = new Rays(…)` (`sim.js:23`), `sim.aeration` | `sim.attachRays(rays)`, `sim.attachAeration(aer)`; U2 ships inactive stubs, `src/wire/rays.js` and `src/wire/foam.js` attach the real ones |
| (new) | `sim.test` knobs, test mode only: `listOrder` (`'reverse'`, `'shuffle:<seed>'`), `blockOrder` (`'reverse'`), `raceProbe` (bool), `syncAfterShift` (bool) (I2) |

Tool contract: everything above is reachable from `page.evaluate` through `__app.sim` and `__app.gpu`. Nothing a
tool needs requires importing three.

## D. The step

### D1. What a step records

```
sim.step():
  frame++
  if idle-certified (sim.js:658 rule): aeration idle step over its list; return     (records nothing else)
  rays.step()                                    (if active; U12)
  if actDirty || actAge >= ACTIVITY_PERIOD: activity build (D4)
  params slot: { frame, parity = frame & 1, gravity, fresh, rays, outOfPlace }
  move      indirect over MOVE[parity]            (in place: {src: cur, dst: cur})
  margin    direct, parity 1 only                 (same header)
  aeration  list, then indirect over it           (Whitewater only; reads the pre-move copy, D2)
  react     indirect over DRAWN                   ({src: cur, dst: 1-cur}); cur = 1 - cur
  rays.settle()
```

`version` advances as today (the app's derived pacing keys on it). With Whitewater on, the move runs out of place
(`{src: cur, dst: 1-cur}`, then react `{src: 1-cur, dst: cur}`), which is today's order exactly: after a step, `cur`
holds the post-react state and the other copy the post-move state in both modes. A step records 2 indirect dispatches
(3 with Whitewater), plus 1 per activity build, each counted twice in `gpu.stats.dispatches` (B3).

### D2. Move: one thread per Margolus block, in place

`moveBlockFrag(g)` becomes the fused kernel; `moveGatherFrag`, `moveFlowFrag`, `slotGLSL`, the block atlas,
`Simulation.slots`/`blocks`/`attachSlots` and `gfx/regions.js` are retired (as stubs while another unit's file still
imports them, J3).

- **Dispatch.** Workgroups of 64 threads. A sleep unit has `8·|U|` home blocks (U = `SLEEP_UNIT` in bricks; a brick
  has 8): with bricks, one workgroup covers 8 list entries × 8 home blocks; with supertiles, 2 workgroups cover one
  entry. Args are `fold(ceil(n · 8|U| / 64))`. Thread → block: list entry from the workgroup index and
  `local_invocation_index / (8|U|)`, local block `k` → base cell `4·brickCoord(entry) + 2·(k & 1, (k >> 1) & 1, k >> 2)
  + parity` (generalised per unit). At parity 1 the low-margin blocks (a base coordinate of −1) are a separate
  direct dispatch over all of them: with `h = N/2` per axis, `(h.y+1)(h.z+1) + h.x(h.z+1) + h.x·h.y` blocks in
  `blockAtlas`'s order (`common.js:157-161`), 12,481 at 128³.
- **Which blocks run.** A block runs if any of its in-grid cells lies in a DRAWN brick; every other thread returns at
  once. **MOVE per parity:** at parity 0 every block lies inside one brick (bricks are 4 cells, blocks start at even
  coordinates), so `MOVE0 = DRAWN` and the move reads the DRAWN list. At parity 1, `MOVE1` = DRAWN dilated by one brick
  toward −x, −y, −z (D4), a superset that the per-block test trims.
- **Quiet base** (`quietCell(base)` as `move.js:256`): the block stays put. Write only flags: `f & ~DIRTY` when
  `fresh`. Update flow for its cells in non-quiet bricks: `flow = mix(flow, 0, FLOW_BLEND)`.
- **Otherwise:** load the 8 cells (A, B, F) from `src`, run the block solve (`vertical`, `diagonal`, `horizontal`,
  random draws in today's order), then for each in-grid cell `p` with source `q`:
  - first re-read `A_old(p)`, `B(p).w` and `F(p)` from `src`: the thread's own cells, untouched until it writes them.
    The solve doesn't carry them in registers (about 112 live scalars already; Apple would spill);
  - `A = A(q)`, warmed by the impact heat exactly as `postMove` does (`move.js:328-335`): the heat quantized as
    `packSlot` quantizes it (`move.js:241-243`), and `if (heat > 0.0) a.y = min(a.y + heat·KE_TO_HEAT/CAP, CELL_TEMP_MAX)`
    — the guard is kept verbatim: an unconditional `min(a.y + 0, …)` turns −0 into +0 and clamps every cell;
  - `B = (v_slot, B(p).w)`: velocity moves with the content, pressure stays with the position (`move.js:334`);
  - `F = F(p)` (flags are positional, `move.js:354-357`), `& ~DIRTY` if `fresh`, `| DIRTY` if
    `nearChange(A_old(p), A_new(p))`;
  - flow for cells in non-quiet bricks: `mix(flow, vec3f(p − q), FLOW_BLEND)`, in f32, stored f16.
- Every read is of the thread's own 8 cells; no other thread writes them. Race-free in place.
- **Out of place** (Whitewater): the same pipeline, switched by the uniform param `outOfPlace`, writes to `dst`,
  copies quiet-base blocks' A and B through, and writes `moveSrc[slot] = source index 0..7`. `moveSrc` is always bound
  (a 4-byte dummy when Whitewater is off). One pipeline for both modes, so I2.5's "identical state" can't fail on the
  Mac because Apple's compiler contracted two pipelines' shared math differently (scaling.md D8's BLOCKS note saw any
  shader change move blended values by 1 ULP). The aeration kernel reads the pre-move copy and `moveSrc` exactly
  where `aerationFrag` read `targets[1-cur]` and `slotOf` (`liquidDetail.js:362-404`). Quiet-base blocks are identity
  for aeration, as today.
- **Code form (W23).** Today's block code is 2,377 generated straight-line lines at 64³. U2's first deliverable ports
  react and the move mechanically and times them on SwiftShader. If the unrolled form misses the budget, the move
  emits its rules as a loop over a small rule table with runtime indices (registers as a `var` array), or as separate
  `vertical`/`diagonal`/`horizontal` functions that Tint keeps out of line. Exactly one form ships in v1 and runs
  everywhere; an Apple-only unrolled variant is K3 and must then pass I2 on the Mac.
- Wherever the old code wrote a slot for a cell outside the grid, the fused kernel writes nothing.

### D3. React: one thread per cell, ping-pong

- Workgroup = one brick (64 threads); indirect args `fold(nDRAWN · |U|)`. Every cell of a DRAWN brick is written to
  `dst` (the copy-through that keeps both copies right).
- A quiet brick is a uniform branch for the whole workgroup: cells with no ray deposit write
  `(a, b, ownFlags(a, b) | NEAR | dirty)` (`react.js:208`).
- At the end, a workgroup OR of `foams(id)` over the brick's 64 output cells; thread 0 stores it into
  `marks.foams[brick]` (`atomicStore`; the brick's own word). That is the input of the aeration list (G4).
- Face loops keep a runtime bound (`P.faces`, today's `uFaces`, `react.js:85-88`) so the compiler doesn't unroll and
  inline six times; re-measure compile time before changing it.
- No workgroup-memory staging in v1: the 6-neighbour and lower-ring reads hit the brick's 1 KB run and its
  neighbours' (sim-core map 9.2).
- The ray deposit is `array<i32>`, two per slot (heat, pressure) in fixed point, scale `RAY_DEPOSIT_SCALE`
  (a new PHYS constant, 1024 per unit; range ±2·10⁶ units). React reads `i32ToF32(d) / RAY_DEPOSIT_SCALE`.

### D4. Activity build (every `ACTIVITY_PERIOD` = 2 steps, or after a write)

Eight fragment passes become six dispatches in the step's compute pass, one of them indirect:

| Kernel | Grid | Does |
|---|---|---|
| `inertList` | one thread per brick (`fold`) | lists brick b if any brick of `b + {−1,0,1}³` was DRAWN under the last map or is in `marks.act`, or if a full rebuild is due (after `load`, `shift`, `forceAll`, a `skipQuiet` toggle, a new grid). Flags change nowhere else, and one brick of dilation covers the 152-cell halo and `inertNearHere`'s reach |
| `inert` | indirect over INERT: a workgroup per brick, a thread per cell | AND/OR of the 64 flags in workgroup memory; the halo DIRTY scan split across threads; if undecided, each MATTER cell re-tests `inertNearHere` from the state; AND. Merges `inert`, `inertRows`, `inertJoin` (`activity.js:184-260`); same predicate. Bricks not listed keep last build's bit |
| `quiet` | one thread per brick | first the carry note (below) from the outgoing `quiet[b]`, then `quiet = enabled && all 27 neighbours inert && no ray brick among them` (`activity.js:307`), then the fold `changed[b] = noted ? changed[b] \| !quiet : !quiet` (noteAwake, the old MAX blend) |
| `drawn` | one thread per brick | AWAKE(b) = any non-quiet brick in `b − {0,1}³`; forced = `marks.act[b]` or `forceAll`; the run counter and DRAWN (D5.3); writes `map[b]`; appends DRAWN |
| `move1` | one thread per brick | MOVE1 = any of `b + {0,1}³` DRAWN; appends MOVE1; clears `marks.act` |
| `args` | one thread | writes `fold`ed args for react (DRAWN), move parity 0 (DRAWN), move parity 1 (MOVE1); `counts = (nAWAKE, nDRAWN)` into the counts ring slot; resets the append counters |

- List appends aggregate per workgroup: a workgroup counts its entries in workgroup memory, one thread does one
  `atomicAdd` on the global counter, then each thread writes its entry. List order is free (W21) and is permuted by
  `sim.test.listOrder` in I2.1. A workgroup's early exit on a list count uses `workgroupUniformLoad` (H1.30).
- `skipSleeping = false` makes `drawn` mark every brick DRAWN (and every list hold every brick), through the same
  kernels. `skipQuiet = false` makes `quiet` write 0 everywhere, as `uEnabled` does today, and triggers a full inert
  rebuild when toggled.
- **Idle check** (`checkIdle`, `sim.js:477-487`): the counts go through the counts ring (B7); `nAWAKE == 0 &&
  nDRAWN == 0` certifies idle under the same epoch rules. A certified idle world records nothing per step (aeration
  aside).
- **Carry note.** `updateActivity` notes the outgoing map before replacing it when steps used it since the last
  `updateBricks` (`sim.js:599`). The `quiet` kernel does it in the same thread before overwriting `quiet[b]`:
  `if (P.carry) { changed = noted ? changed | !quietOld : !quietOld; noted = true }`, then the fold for the new map
  (which therefore ORs). `P.noted` is `actNoted` before the build; the CPU sets `actNoted = true` after it.
  `noteAwake` stays a per-brick kernel of its own only for `updateDirty`'s carry (`sim.js:791`).
- `inertRefFrag` stays, as the compute kernel `sim.passes.inertRef` (a full, non-incremental rebuild), so
  `tools/activity-check.mjs` and friends don't author shaders; activity-check's 0-bricks-differ over 300 maps is the
  proof of the incremental rebuild.

### D5. The sleeping rules, restated for WebGPU

D8's argument carries over with these changes, each forced or allowed by the new design:
1. **BLOCKS and STEPS are gone.** The fused move runs every block with a cell in a DRAWN brick. A quiet-base block
   reaching into a non-quiet brick (BLOCKS's reason) is covered: that brick is AWAKE, hence DRAWN. Flow is written for
   cells in non-quiet bricks (STEPS's reason) by whichever block owns them.
2. **The unit is a brick.** Skipping is exact at any unit size whose cell extent is even and aligned (a Margolus block
   reaches one cell; scaling.md D8:153-174). A non-quiet brick n changes cells only in `n + {0,1}³` (its blocks at
   parity 1 reach one cell up each axis), so AWAKE(b) = any non-quiet brick in `b − {0,1}³`. **Skipped blocks are
   exact:** a block with no cell in a DRAWN brick has a quiet base (a non-quiet base brick makes every brick its cells
   lie in AWAKE), no cell in a non-quiet brick, and cells whose flags are settled with DIRTY clear in both copies (the
   invariant below). Running it would change nothing. `SLEEP_UNIT` set to `SUPER_B` reproduces D8's supertile rule
   (AWAKE over its bricks and the ones just below, `activity.js:412-421`), and `tools/skip-model.mjs` checks both.
3. **A per-brick settle counter replaces `uPrevSettled`.** Old rule: `uPrevSettled = actSteps >= 2 || (actSteps > 0
   && wroteSinceStep)` (`sim.js:626`). The second clause was right only because every WebGL writer copied the whole
   current state into the other copy. Box-scoped writers don't, and dropping the clause alone leaves `actSteps >= 2`,
   which never holds when every map gets one step and something writes every frame (Speed 1, which the UI allows;
   the brush; POV body coupling W1 every frame; the physgun; the burrower): DRAWN would only grow, and after a window
   move every brick would stay drawn for the session. The new rule, per brick, in `drawn`:
   ```
   run[b]   = forced ? 0 : (prevDRAWN && !prevAWAKE) ? min(run[b] + P.nPrev, 255) : 0   // nPrev = steps under the last map
   DRAWN[b] = AWAKE || forced || (prevDRAWN && run[b] < SUPER_SETTLE_STEPS)
   ```
   Exact: a brick's drawn-not-AWAKE steps leave its cells as they are; its first one is always a map's first step
   (AWAKE is constant within a map, and a write ends a map), which clears DIRTY (`fresh`); after any two such steps,
   in one map or two, both copies hold the same A, B and F, settled. Writes elsewhere don't touch the brick; a write
   into it resets `run` (forced). Bounded: at Speed 1 with a write every frame, a brick that stops being AWAKE leaves
   DRAWN after two maps. A build with no steps since the last (`nPrev = 0`, a tool building maps by hand) carries
   DRAWN on, as `prevDRAWN` did. A brick AWAKE under the last map (it was moving at that map's last step) gets
   `run = 0` and stays DRAWN for at least one more map: the role `prevAWAKE` played in the old rule. `forceAll` resets
   every brick's `run`.
4. **Forced bricks come from GPU marks**, not a CPU union box: exactly the bricks some writer changed. A writer that
   wrote a cell's old value didn't change anything there, so not forcing it is exact. This includes life-only and
   B-only edits, where `writtenFlags` sets no DIRTY (`common.js:361-365`).
5. **`wroteSinceStep` is gone** (D5.3 makes it unnecessary, and box-scoped writers make it wrong).

**The invariant every pass must keep:** in a brick that is not DRAWN under the current map, both copies hold the same
A, B and F, and F is settled (`ownFlags | NEAR`, DIRTY clear).

**`tools/skip-model.mjs`** is rewritten to model the step as it will be, at both unit sizes: the move in place on
`cur` (react writing the other copy; the out-of-place variant too), quiet-base blocks writing only flags, a block
running iff one of its cells' units is DRAWN, margin blocks, MOVE per parity, box-scoped in-place writers with marks,
the run counter. It must pass, and each of these negative controls must fail: the old `wroteSinceStep` clause with
in-place writers; MOVE1 without the −x−y−z dilation; MOVE0 with blocks that cross a unit face (an odd unit); the
per-block test on the base cell only; forced marks dropped; `run` not reset by a write; `run` counting steps of maps
where the unit was AWAKE. It also asserts that DRAWN stays bounded with one-step maps and a write every step.

### D6. External writers

```js
const paint = sim.editKernel('paint', {
  update: paintUpdateWGSL,        // fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>)
  params: PaintParams,
  reads: 'own',                   // 'own': in place; 'neighbours': two-phase through scratch
});
sim.edit(paint, { lo, hi }, { center, radius, … });   // box inclusive, grid cells; clipped to the grid
```

- `editMain` (C5) dispatches one 64-thread workgroup per brick the box overlaps (4×4×4 threads, brick-aligned);
  threads outside the box skip. Each thread reads its cell, calls `update`, then `writeCell`: `writtenFlags` as
  `common.js:361-365`, and if A, B or F differ, the store. The workgroup ORs "changed" in workgroup memory and one
  thread does one `atomicOr` of the brick's bit into each mark set (`marks.act` for D5, `marks.derived` for E's age
  pass) and stores `marks.foams[b] = 1` (the write may have poured a foaming liquid; react recomputes the word when it
  next writes the brick, G4). Every writer marks this way, the rays' paint kernel included.
- **Each `sim.edit` is its own dispatch, recorded in call order**, so edit N+1 sees edit N's result, as today when
  each body's pass read the last one's output. Two edits are batched into one dispatch only if their boxes are
  provably disjoint; overlapping boxes in one dispatch would give a cell two writers (a race, D8.8). This overrides
  the POV map's "batch all bodies / one dispatch for all drills" advice (pov map W1, P5) for writers; read-only probes
  may still batch.
- `reads: 'neighbours'`: phase 1 runs `update` reading the current copy and writes `(oA, oB, f)` into a box-sized
  scratch buffer; phase 2 copies scratch into the current copy with `writeCell`. Every read sees the pre-pass state,
  exactly as copy-through did. Use it for any writer that reads a cell it might write.
- `sim.edit` also does what `noteWrite` did on the CPU: `version++`, `wake()`, `actDirty = true` (the next step
  rebuilds the map), `changedAll`/`forceAll` only for whole-grid writes. No `cur` flip: writers write the current copy.
- **Whole-grid writers** are not edits, and each sets `forceAll` and `changedAll`: `load`, `undo`, `clear`, the
  codec's unpack (current copy, then `fresh` flags), `shift` (reads `cur` at `p + shift`, writes the other copy with
  fresh flags, flips; out of place, as every shift kernel, E). With `forceAll`, the next map draws every brick, so the
  first step's react rewrites every cell of the other copy before anything reads it (the in-place move reads and
  writes `cur`; out of place, it writes every cell of the other copy first). That makes a sync after them pointless:
  `world/window.js` stops calling `syncCopies` after a shift and fill and after a world load (G1).
- `syncCopies` stays for tools: three `copyBufferToBuffer`s of the current halves of A, B and F into the other halves.
  An exact copy keeps the invariant, so it needs no forcing. `snapshot` is `copyBufferToBuffer` of A and B.
- `sim.probe(kernel, size, params) → Promise<ArrayBuffer>` is the read-only counterpart: a kernel writes into a
  per-frame result ring slot that the readback service returns (B7).

### D7. Every state writer and its form

| Writer (today) | Reads | Form |
|---|---|---|
| paint (`passes.js:21`) | own | edit, in place; `frame = sim.paints` |
| bolt (`shaders/lightning.js:13`) | own | edit over the bolt AABB |
| stamp, stampMany, the world's tree stamps (`stamp.js`) | footing reads cells below | edit, two-phase, over the stamp box plus footing |
| sceneFill, stored-brick restore (world) | own (+ `sceneCell`) | edit over the entering slab, in place |
| unpack (`codec.js:81`) | none | whole-grid kernel into the current copy, `forceAll` |
| POV W1–W3, W5–W16, W19 (pov map 2.1) | own | edits; one pipeline per family (blow, flame, radial…), params per tool; one dispatch per body, drill or tool use, in call order |
| W4 strike | the walk's cells | edit, two-phase (v1); serial walk later |
| W17 laser | the beam's cells | reach kernel → buffer + indirect args, then apply in place (G2) |
| W18 transfer apply | every slot's cell | one 256-thread workgroup: qualify, prefix-sum ranks, then apply; probe and apply read the same pre-state |
| rays paint | the particle list only | list kernel in place |

### D8. Invariants a porting agent must not break

1. State is read only through `fetchA/fetchB/fetchF` (and slot twins) and written only through `writeState`/`writeCell`.
2. Random streams: same seeds (`seed3(p, frame, salt)` at world coordinates), same salts (move `0x51`, react `0x7a`,
   reactions `0x52`, singularity `0x5a`, paint `0xb7` with `sim.paints`), same draw order. No `select()` around a draw.
3. `rnd = u32ToF32(s)·2^-32`: correctly rounded, so it returns exactly 1.0 for `s ≥ 0xFFFFFF80` on every device, as
   Metal's and JS's round-to-nearest-even do. Every full-range hash → float uses `u32ToF32`/`i32ToF32` (H1.28).
4. Exact float comparisons stay exact comparisons: `b.xyz != vec3(0)` is `any(b.xyz != vec3f(0))`, `T == HOT(id).x`,
   `v.y == 0.0`, `a.z >= 1.0`.
5. Summation orders stay: conduction over faces in FACES order, the pressure Laplacian, collide, heat share.
6. Flags are positional. Every writer leaves `writtenFlags` (or `freshFlags` for whole-grid writes) on what it wrote.
7. The sleeping invariant in D5, and the rule that every pass writing a subset of the grid either keeps it or forces.
8. Within a dispatch, a cell (and its flag word, flow, deposit) has one writer. Cross-thread accumulation only with
   integer atomics, and only where the consumer doesn't depend on order. Edits are one dispatch each (D6).
9. Margin and padding: cells outside the grid read as `E_WALL` at `AMBIENT` (move) or as the box's insulating,
   pressure-reflecting wall (react); nothing outside the grid is written. An out-of-grid `slotOf` is another real cell
   and robustness clamps a truly out-of-range index onto some element (on SwiftShader, the last cell of copy 1), so
   every `writeState` is dominated by an `inGrid` test and the dispatch's box test; `writeCell` tests `inGrid` itself.
10. Within the WebGPU build: same seed and inputs give the same hashes, and turning sleeping off
    (`skipSleeping = false`) changes none of the `state`, `flow`, `copies` and `maps` (inert, quiet, awake) lines.
    `drawn` differs by design (I2.2).
11. Variants that tests compare bit for bit are the same pipeline: in-place vs out-of-place move (a param),
    `skipSleeping = false` and `incremental = false` (lists of everything through the same kernels, as `fullOnly`
    did), aeration over its list vs every brick. Never a template or `override` variant of shared math.
12. Every `onShift` kernel (state, flow, aeration, field EMA history, GI probes) runs out of place: read the source
    at `p + shift`, write a scratch or the other copy, then swap or copy back. In place, a thread would overwrite a cell
    another thread still has to read.

## E. Derived passes, fields, light, GI, shadow

`src/derived.js` (new) holds what `sim.js:737-874` did: `updateDirty`, `updateFields`, `updateBricks`, `updateGI`.
`sim.updateBricks()` and `sim.updateGI()` delegate to it, so callers don't change. All of it is one compute pass of E1.
Dispatch sizes the CPU knows (light blur, brickDist, giSource, the shadow map) are direct; only the brick lists (EMA,
WORK, FIELDS) are indirect: 9 indirect dispatches per derived frame (EMA 1, blur 3, boost 0–2 3, fused boost 1,
brick 1), counted twice each (B3).

| Resource | Type | Size (128³) | Written by | Read by |
|---|---|---|---|---|
| `age` | `array<u32>` per brick | 32K | age kernel, in place: 0 if `(P.steps && changed[b]) \|\| marks.derived[b] \|\| P.all`, else min(age+1, 255) | dirty kernel |
| EMA / FIELDS / WORK lists + args | `array<u32>`, 3 lists | ≤ 32K each | dirty kernel (same sets as D9: age < FIELD_EMA_SETTLE; within 1; within 2 bricks) | field and brick kernels (indirect) |
| field EMA history | `array<u32>`, 3 words per cell (`pack4x8unorm` each) | 12 B/cell | EMA kernel, in place, only with no shift pending (each cell reads only its own history); shifts by its own out-of-place kernel | blur |
| field scratch | `pack4x8unorm` words wherever today's target is RGBA8 (`fieldTmp`, the blur and boost intermediates, `sim.js:252-253`), holding only the channels the next stage reads; `fieldsBlurred` (today half float) as `pack2x16float` words; two ping-pong sets | per channel set as today | blur x/y/z, boost stages 0–2 | next stage |
| `fieldSurf`, `fieldMedia`, `fieldThin` | `texture_3d<f32>`, `rgba16float`, written as `texture_storage_3d<rgba16float, write>` | NX×NY×NZ | fused boost kernel over FIELDS | volume, shadow |
| `brick` | `array<BrickInfo>` (F6) | 32K × 16 B | brick kernel over FIELDS (workgroup = brick, 64 threads, reduction) | volume, shadow, GI, light, signs |
| `brickDist` | `array<u32>` per brick (F6 encoding) | 32K | 3 axis dispatches (17-tap min, `passes.js:231`), direct | volume, shadow |
| `light` | `texture_3d<f32>` `rgba16float` + 2 scratch buffers | BX×BY×BZ | 6 blur dispatches x,y,z,x,y,z (`LIGHT_BLUR_PASSES`, same order, gain 1.15), direct; the last stores the texture (H2) | volume (`sampleLight` = 1 trilinear sample), figures |
| `giSrc` | `array<vec4u>` per brick (packed rad/cov/dir) | | giSource, workgroup per brick | giGather |
| GI probes | history: 4 bands × `array<vec2u>` (rgba f16 packed) + 4 × `texture_3d` `rgba16float` | BX×BY×BZ | giGather: half the probes per frame (parity computed, not discarded), `mix(old, new, GI_BLEND)` in f32 into the buffer, `textureStore` of the 4 bands | volume, figures, next giSource |
| shadow map | `texture_2d` `rgba32float` + `r32float` copy of `.x`, both storage writes in one dispatch | `min(1024, 4·max n)`² | shadow kernel, 8×8 workgroups, each texel's DDA | volume, GI, figures (`textureLoad`) |
| aeration | `array<vec2u>`, 2 copies in one buffer (f16 packed) | per slot | aeration kernel over its list (Whitewater, G4) | volume (`aerationAt`, still 8 manual taps: liquid-weighted) |

- **Incremental is exact or it isn't done.** `tools/derived-check.mjs` (incremental vs `sim.incremental = false`,
  bit for bit, every derived resource) is the proof, as it is today. `incremental = false` feeds the same kernels
  lists of every brick (D8.11). The EMA's 8-bit fixed point (`FIELD_EMA_SETTLE`, `gfx/pacing.js blendFixedFrames`)
  holds for round-half-up and half-even alike.
- **The age pass keeps `uSteps`** (`passes.js:296`, `sim.js:803`): `changed` holds the bricks of the maps used since
  the last derived frame only if steps ran since (`P.steps` = `actNoted`). Without the gate, every derived frame with
  no steps since (paused with a sun, view or smoothing change; pacer settle frames) would re-dirty the last map's
  awake bricks: exact values, wasted work. `actNoted` and `marks.derived` are cleared after the age pass.
- **Boost.** Stages 0–2 (lattice smoothing) as today. Stages 3–5 (separable local max, then the last stage's boost)
  become one kernel over FIELDS: a 3×3×3 max of stage 2's output followed by the last stage's arithmetic. Exactly
  equal: max is order-free, and per-axis `inGrid` skipping (`fields.js:166-167`) gives the max over the box ∩ grid,
  which the 27-tap loop computes with one `inGrid` test per tap. `occ` passes through from stage 2 as today. The
  unused third attachment of the boost temporaries (`fields.js:150`) goes. Fusing blur x and y through a workgroup tile
  that keeps the 8-bit quantization between them is allowed in U4 if derived-check stays bit-exact; otherwise K3.
- Region quads, `regionMap`, `regionShare`, `FIELD_FULL_SHARE` and the boost stage 5 discard go: the kernels run over
  exactly the listed bricks. "Scratch outside this frame's regions holds other passes' output" becomes "scratch
  outside WORK holds stale values no listed brick reads" (D9's dilation argument, now per brick).
- **Filtering.** Fields, light and GI move from 2D atlases with manual cross-slice lerps or 8-tap `texelFetch`
  trilinear to one hardware trilinear `textureSampleLevel`, with the same edge clamps applied to the coordinate first
  (`clamp(p/BS, 0.5, B − 0.5)` for probes, `[0.5, N − 0.5]` for fields). Hardware weights have less precision than the
  f32 manual blend: a render-only change, re-baselined (I4).
- **Shadow PCSS reads the `r32float` copy.** The blocker search and filter take 16 taps that use only `.x`
  (`lighting.js:296, 313`) on every shaded hit, near-field hit and media sample: they read the 4-byte texture. The
  4-tap bilinear and volume-point paths (`lighting.js:256, 336`) keep the vec4. Same values, render-only.
- **GI far branch:** `derived.attachFar(far)` binds the far textures. The branch stays a runtime `u32`
  (`FrameUniforms.far`), not an override, so box and world share pipelines (scaling.md D11 W4: switching to a world
  compiles nothing big). GI reads FrameUniforms written on its tick (B3) and passes literal zeros where `giUniforms`
  omitted `uCaustics`, `uTime`, `uFrame` (gi-light map 5.13), not the shared fields.
- **Window shifts** register with `sim.onShift`; every shift kernel runs out of place (D8.12). The field EMA history,
  GI probes (buffer and textures), flow and aeration move with the cells (`window.js` `giShiftFrag`/`flowShiftFrag`
  semantics). The shift also moves, by whole bricks, the per-brick `age`, `brick` and `brickDist` buffers and the
  three final field textures (`copyTextureToTexture` through a scratch texture: a same-texture overlapping copy isn't
  allowed). Then `age = 0` only for the entering slab and for bricks within `FIELD_REACH` of either grid face on the
  moving axis (the grid-edge clamps make those differ); every other brick is a fixed point of the same inputs, so it
  keeps its age and its fields. Today `changedAll` rebuilds every brick for ~13 derived frames after each move.
  derived-check gets a shift case (incremental after a shift == full).

## F. Rendering

### F1. A view frame

```
[E1 render] scene pass — colour = scene target (rgba16float), depth = depth32float; clear (0,0,0,0), 1.0
    1 far view (world mode): full-screen triangle, depthCompare always, writes frag_depth
    2 floor grid (box mode): our line pipeline, depth test, transparent as today (renderOrder −1)
    3 detail meshes (world mode): our pipeline, depth test less-equal
    4 volume: the window box drawn back faces (cullMode 'front'), depthCompare less-equal,
      writes frag_depth, blend one / one-minus-src-alpha (premultiplied over), discard on a miss
    5 box edges (box mode) and the brush cursor: our line/mesh pipelines, after the volume, as today
[three]   only if threeHasVisible: flush; renderer.render(scene, camera) into the same target, loadOp load
[E2 render] overlay (rays sprites, while rays are active): load colour, depthReadOnly, additive, depth test
[E2]      post (F7) → canvas pass
```

- **Why the volume before three.** three's render is its own render pass and submit, so the volume can't sit between
  three's opaque and transparent lists without splitting the scene. Drawn first, the volume is depth-tested against
  the far field only, and three's meshes are depth-tested against the volume. A mesh in front of the volume's
  first-hit depth shows, a mesh behind it doesn't; today the volume drawn over the meshes with its `gl_FragDepth`
  gave the same answer in both cases (volume-render map 1, "Limitation (by design today)"), including legs under a
  water surface. What changes is a mesh behind a low-alpha first hit with nothing behind it (a pane of glass against
  the sky): hidden instead of faintly visible. Accepted (K2.1).
- The floor grid, box edges and brush cursor keep today's order relative to the volume (grid before it, edges and
  brush after it), because they are ours (`src/gfx/overlays.js`, `src/brush.js`). In box mode three has nothing
  visible, so the frame is one scene pass and one command buffer.
- The rays overlay now draws after three's transparents (the constructions ghost): additive sprites over it. Accepted.
- Render passes per presented frame: 1 (scene) + three's (0 in box mode) + 0–1 (overlay) + 3 post (TAA, prefilter,
  `up[0]`) + 1 (canvas); compute passes: E1's + 1 (post).

### F2. The volume pass

- `volumeVert`/`volumeFrag(g, haze)` become one WGSL module with a vertex and a fragment entry. The vertex shader
  takes the box's positions (grid space) and `FrameUniforms.viewProj · model` (jittered); the fragment computes `rd`
  from the interpolated grid position and `uCam` exactly as `render.js:681-682`.
- `frag_depth = clip.z / clip.w` from the same jittered matrix, no `·0.5 + 0.5` ([0, 1] in WebGPU). Same "first hit"
  semantics (`render.js:896-900, 1023-1024`): TAA's only motion signal is this depth.
- **Derivatives.** `surfView`'s `dpdx/dpdy(rd)` stay at the top of `main`, in uniform control flow, before any branch
  or `discard`. Every derivative or implicit-LOD sample in non-uniform flow becomes analytic: `fwidth(q)` of the floor
  lines from the pixel footprint (`gPixAng · t / max(|rd.y|, ε)`), and every `texture()` becomes
  `textureSampleLevel(…, 0)` (nothing has mips).
- **Variants are separate modules.** `volumeFrag(g, { view, near, detail })` is a JS template that emits only the
  selected view's code path: realistic (base and near detail variants, `detailGate`), heat, pressure, flow, X-ray,
  plain. Not `override VIEW`: Tint keeps an `if (VIEW == …)` branch's callees in the module, so each override pipeline
  would likely hand Metal the whole tracer. (If a later measurement with Dawn's `dump_shaders` shows override
  pipelines' MSL is pruned, that is a K3 simplification.) Detail blocks that only gate a few lines may be `override`
  bools; blocks that add bindings, globals or more than ~50 lines (grains, relief, `tAer`) are template conditionals,
  as `#ifdef` was. The world's far parts stay compiled in, switched by `FrameUniforms.far`, so box and world share
  every view pipeline.
- Loop bounds that came from `${g.maxSteps}` are `const`s; `uFaces`-style runtime bounds stay runtime.
- The box is rasterized only where it covers the screen; one fragment per covered pixel, inside or outside the box.
  Check the cull winding empirically in the smoke test (camera inside and outside the box).
- If the realistic modules miss the compile budget on SwiftShader they go on `WGSL_MAC_ONLY`; the container tests use
  `?view=plain` and Tint-only validation of the rest (I1).

### F3. The scene target and three.js

- three owns the scene target: `RenderTarget(w, h, { type: HalfFloatType, depthTexture: DepthTexture(FloatType) })`.
  `gpuTextureOf` gives us both `GPUTexture`s (B10). Resized (and re-fetched) when the render scale changes, as today
  (`post.js:838-844`); allocating once at maximum size with a viewport is Phase 2.
- The viewmodel target (MSAA 4, rgba16float) is three's too, with `storeMultisampledColorBuffer = false` and
  `storeMultisampledDepthBuffer = false` so three uses transient attachments (`WebGPUTextureUtils.js:362-388`).
- The glow layer (layer 6) renders into its own 1× rgba16float three target, cleared to 0, composited additively in
  the canvas pass. Additive blending is associative, so this equals drawing it on the canvas (`flame.js` overlay mode
  keeps its own tone mapping).

### F4. Conventions

- **Clip depth [0, 1].** Every projection we build or read comes from a camera in `WebGPUCoordinateSystem`.
  Remove every `*0.5+0.5` and `*2.0-1.0` on depth (volume, far, TAA reprojection, `net/cursors.js` ndc test → view-z
  test). Depth compare `less-equal`, clear 1.0. No reversed Z in v1.
- **Y down.** Framebuffer and texture coordinates are top-left in WebGPU. Image passes use
  `uv = (pixel + 0.5) / size` with `uv.y = 0.5 − 0.5·ndc.y`. Per-pixel noise hashed from `position.xy` flips vertically
  against WebGL: accepted, not emulated. `renderThumb`'s CPU row flip (`app.js:1057-1060`) goes.
- **Jitter.** Post keeps mutating `camera.projectionMatrix` in place (`post.js:884-900`): row 0 += `jx_ndc`·row 3,
  row 1 += `jy_ndc`·row 3, with `jx_ndc = 2·jx/w` and `jy_ndc = −2·jy/h` for a pixel offset `(jx, jy)` measured with y
  down. TAA's `uJitter` is that pixel offset. three reads the matrix at render time, so the meshes jitter with the
  volume.

### F5. Shadow map, pick, thumbnails, screenshots

- **Shadow:** compute over `res²` in 8×8 workgroups; writes the `rgba32float` map and its `r32float` `.x` copy in the
  same dispatch (2 storage textures). `sunBasis` stays one shared WGSL function (writer and five readers must agree
  bit for bit); `w = tintId·256 + τ` stays in f32. Full every derived frame with shadows (D9). The per-`DETAIL_*`
  shadow variants go (no detail code reaches it; volume-render map 2).
- **Pick:** one compute thread per queued ray (hover and every `pickRay`), exact cell DDA without brick skipping
  (`render.js:1031-1080`), both result texels' 8 floats per ray into the pick result ring (B7) (today two fragments ran
  the same DDA, one per output texel). `pickPending` and `pickedNow` stay; `pickRay` gets its own slot per call.
- **Thumbnails** (`renderThumb`): `post.renderStill` into a 320×200 `rgba8unorm` target with alpha (the still
  composite keeps alpha; only the canvas is opaque), `gpu.readback.texture`, un-premultiply, `putImageData`. Async;
  `ui/topbar.js` awaits it.
- **Screenshots:** `drawImage(canvas)` in the same task as the frame's submit (as `app.js:1329`). The canvas is
  configured with `COPY_SRC`, so the fallback is `readback.texture` of the current texture (swizzle B and R for
  `bgra8unorm`). U8 checks which works in Chrome and Safari.

### F6. Shared bindings (`src/shaders/bindings.js`)

One module, written by U1 in wave 0 and read by every render-side unit, holds every declaration the render library
shares, so two modules never declare the same binding and numbers can't disagree:

- **`FrameUniforms`** = `uniformStruct('FrameUniforms', …)` with every uniform today's render code declares
  (`gfx/core.js:8-26`; `gfx/lighting.js:20-40, 84, 419-421`; `gfx/clouds.js`, `gfx/surface.js`, `gfx/liquidDetail.js`;
  `render.js`; the far snippets' `uSea`), plus `viewProj`, `invViewProj`, `cam`, `jitter`, `far: u32`. Each field
  names its `gfxUniforms` source key. `gfx/uniforms.js` keeps `gfxUniforms` as CPU-side `{ value }` objects (lamps,
  wand lights and birds already write and read them) and writes FrameUniforms from them (B3's rule).
- **`L.LIGHTING`** (group 2 of render kernels), fixed binding numbers:

  | b | Resource | Type |
  |---|---|---|
  | 0–2 | `fieldSurf`, `fieldMedia`, `fieldThin` | `texture_3d<f32>` (filterable) |
  | 3 | `light` | `texture_3d<f32>` |
  | 4–7 | `gi0`..`gi3` | `texture_3d<f32>` |
  | 8 | `shadow` | `texture_2d<f32>`, unfilterable (`textureLoad` only) |
  | 9 | `shadowX` | `texture_2d<f32>` (`r32float`), unfilterable |
  | 10 | `mediaNoise` | `texture_3d<f32>` (64³ `rgba8unorm`) |
  | 11 | `farGrid` | `texture_3d<u32>` (`rgba16uint`, G1) |
  | 12, 13 | `farTop`, `farShadow` | `texture_2d<f32>` (filterable) |
  | 14, 15 | `linearClamp`, `linearRepeat` | `sampler` (filtering) |
  | 16 | `brick` | storage, read: `array<BrickInfo>` |
  | 17 | `brickDist` | storage, read: `array<u32>` |
  | 18 | `flow` | storage, read |
  | 19 | `aeration` | storage, read |

  `lightingBindings({ far, aeration })` emits the declarations; a resource that is absent (box mode's far textures,
  aeration with Whitewater off) is bound to a dummy 1×1(×1) texture or a 16-byte buffer, never left out, so one
  layout serves every pipeline.
- **Writer variants** with the same numbers: `L.LIGHTING_SHADOW` (the shadow kernel: bindings 8 and 9 become
  `texture_storage_2d<rgba32float, write>` and `<r32float, write>`); `L.LIGHTING_GI` (giGather: 4–7 become
  `texture_storage_3d<rgba16float, write>`, 18–19 are dropped and 20–21 hold `giSrc` and the probe history, both
  storage); `L.LIGHTING_GISRC` (giSource: adds 20, `giSrc`, read_write). A texture is never sampled and
  storage-written in one dispatch.
- **`BrickInfo`** = `struct BrickInfo { emit: vec3f, info: u32 }` with named bit constants: `BRICK_MEDIA` 1,
  `BRICK_SURF` 2, `BRICK_OPAQUE` 4, `BRICK_THIN` 8, `BRICK_MIXED` 16 (bits 0–4, `passes.js:9`), `AIR_HOT/PRESSURE/FLOW`
  at bits 5–7, the brick's steam/smoke cell count (0–64) at bits 8–14, `BRICK_MATTER` bit 15. Matter bricks set bit
  15; air-only bricks only bits 5–7; empty bricks are 0. Decoders `brickBits`, `brickAir`, `brickGas` (`f32(count) /
  64.0`, exactly today's `gas/BRICK_GAS_DIV`), `brickMatter`. This replaces the float code of `passes.js:5-18`.
  Light blur pass 0 reads `emit` through an `array<vec4f>` view of the same buffer (H2).
- **`brickDist`**: the integer today's 8-bit channel holds (`core.js:96` decodes `int(x·BRICK_DIST_SCALE + 0.5) −
  1`), stored as `u32`; decode `i32(v) − 1`.

Library code references only these names. U1 enumerates every field and binding from today's declarations, so later
units shouldn't need additions; one that does appends (never reorders or renames) and says so in its hand-back. Bound
by the volume, shadow (writer variant), GI gather (writer variant), GI source, sign probe and far view.

### F7. Post, pacing and the canvas

- **Fragment passes** on a full-screen triangle, `loadOp: 'clear'` (they overwrite every pixel), into textures with
  `RENDER_ATTACHMENT | TEXTURE_BINDING` only: TAA/TAAU → `history[next]`; the bloom prefilter → `down[0]` (half
  resolution); after the compute pass, `up[0]` (half resolution, reading `up[1]` and `down[0]`).
- **One compute pass**: bloom down 1–5 and up 4–1 (each a dispatch reading the previous level with the same taps
  and weights as today's fragment filters, writing its own `rgba16float` storage texture; those levels are separate
  textures, so adding `STORAGE_BINDING` never touches `history`, `down[0]` or `up[0]`, which keeps them compressible),
  then, in one workgroup, the luminance grid, the 64-bin histogram (fixed-point `atomicAdd` in workgroup memory,
  weight·2²⁰, replacing f16 additive points), the adaptation update in place in a 16-byte storage buffer (no 1×1
  ping-pong), and the meter (16×16 tile sums reduced on the GPU). `post.adapting`, `post.adaptation` and
  `post.sceneLuma` read the result ring 1–3 frames late, as today.
- Post is 3 render passes + 1 compute pass, plus the canvas pass (legacy: about 17 passes).
- **Canvas pass** (ours): `context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode:
  'opaque', usage: RENDER_ATTACHMENT | COPY_SRC, toneMapping: { mode: 'standard' } })`, the parameters three's own
  getter would use for `alpha: false` (W7). A non-sRGB format: the composite encodes sRGB and dithers itself
  (`post.js:530-684`). The canvas is **opaque**: the composite draws the page's sky gradient (`ui/styles.css:30-33`:
  the radial warm glow over the three-stop linear gradient, colours read once from the computed CSS variables) where
  the scene's alpha is below 1, so the compositor no longer blends a full-window transparent layer every frame and
  the canvas can take direct-scanout paths. The only visible difference is the gradient's dithering. In one pass:
  sky, composite, viewmodel composite (unpremultiply → the same WGSL `tonemap()` → sRGB → premultiply; it keeps "no
  adaptation gain"), glow composite. The viewmodel composite outputs 0 instead of `discard` where alpha is 0.
- `getCurrentTexture()` is called only on presented frames; otherwise the canvas keeps its last image (today's
  render on demand).
- All constants in post-frame map 10 carry over unchanged.
- **View key.** `createViewKey()` (the perf-audit session's diff; U7 receives it with its task) replaces app.js's
  per-tick string of camera matrices, three `JSON.stringify`s and `sceneKey`'s traversal (`pacing.js:110-115`,
  `app.js:1434-1438`) with a counter that changes exactly when that string would have. The `pacer.view(key, …)`
  contract doesn't change.
- **Deep idle.** When the view is settled, the sim is idle-certified or paused, nothing is pending (pipelines,
  readbacks, eye adaptation, auto-resolution recovery, a derived frame) and nothing animates (no birds, POV,
  multiplayer, rays), app.js stops scheduling `requestAnimationFrame`. `pacer.wake()`, every input listener, resize,
  `requestRender`, `sim.wake()`/`sim.edit`, a settings change and a resolving readback or pipeline restart it. A
  settled box scene then costs no CPU at all. The default World scene never settles: its birds wake the view every
  tick and the full march re-runs at 60 Hz for a few small bird meshes. That is its dominant idle cost, left for K3
  (now K3's mesh-only frames: the march's scene is kept while only the birds move).

### F8. Mesh materials (three, TSL)

- Figures, the skinned mannequin, worms and vehicles (`figureFrag` via `lib(g)` today) get a TSL `NodeMaterial` whose
  colour is `albedo·(sun·ndl·shadow + giIrradiance + glow) + emit`, reading `externalTexture`s of the shadow map
  (`textureLoad`, B10), the four GI bands and the light volume, with sun and sky values as `uniform()` nodes updated
  from `gfxUniforms` each frame. When derived recreates those textures (a new grid), the material's texture nodes get
  new ExternalTextures (B10). Toon, team tints, outlines (`positionNode = positionLocal + normalLocal·width`), contact
  shadows (multiply blend), flame cards, ember, physgun rim: TSL ports. Skinning and instancing come with the node
  pipeline.
- Figure materials stop baking the grid size; one material per albedo, not per grid.
- Every new mesh kind is compiled with `gpu.three.prepare(object)` before it joins the scene (B5).
- `gfx/billboards.js` replaces three.quarks for `pov/vfx.js` and `birds/render.js`: fixed pools, one instanced draw
  per (texture, blend, mode); each spawn writes one record (p0, v0, g, drag, size0, colour0, birth, life); the vertex
  stage evaluates the ballistic path with linear drag analytically (misc-three map 7.12). Keep `vfx.js`'s event API
  and a `burst(n, init)` call shape.
- **Icons and portraits are baked at build time**, not rendered at runtime (misc-three map 7.10, option 1; their
  inputs are deterministic tables). `tools/bake-icons.mjs` renders every `MODELS[*].icon` and the class × held-tool
  portraits once in headless Chromium through the real TSL materials and writes `public/icons/atlas.png` plus a
  manifest holding a hash of its inputs; both are committed. `modelIcon(key)` stays synchronous (it returns the atlas
  sprite), so `ui/dock.js`, `pov/tools/hotbar.js` and `pov/classPicker.js` don't change. `bake-icons --check` (CPU
  only: input hash vs manifest) runs in CI next to `check-browser-launch`, so a model edit without a re-bake fails.
  No runtime GPU work, no extra pipelines at boot.

## G. Per-module port notes

### G1. World (`src/world/*`, `shaders/far.js`, `generate.js`, `stamp.js`, `window.js`)
- A move keeps shift-by-copy (scaling.md D11), the CPU brick store and the "no move while a slab is unread" gate.
  Toroidal windows are K3; W10's index rule keeps them cheap later.
- **Leaving slab** (`stage` + `sceneDiff` + `gather`) becomes one kernel, workgroup = brick: evaluate `sceneCell`
  per cell, workgroup OR of `cellDiffers`, and differing bricks append themselves (`atomicAdd`) with their 64 cells in
  the store's `slabCell` order (x fastest, then y, then z) and their world key. One readback of a count-sized prefix
  (estimated from the last K, re-read if short) instead of two.
- **Entering slab:** after `sim.shift`, `sceneFill`, the stored-brick restore (one persistent upload buffer +
  index, `writeBuffer` instead of new `DataTexture`s per move) and tree stamps (a persistent tree-shape cache keyed
  like `bakeTree`, a parameter table instead of 32-entry uniform arrays) are edits over the slab only. **No
  `syncCopies` after them** (`window.js:224`), nor after a world load (`window.js:164`): the shift and the load set
  `forceAll`, so the next step rewrites the other copy (D6). I2.9 proves the state is identical with and without it.
- **Derived after a move:** the shift moves age, bricks and final fields by whole bricks and re-ages only the slab and
  the edge bricks (E), instead of `changedAll`. `forceAll` stays (not waking the whole grid would change quiet-skip
  drift: a K3 decision).
- **`sceneCell` source.** The GLSL subset (`scenes/themedShared.js`) stays canonical: it is the CPU twin's source.
  Add `toWgsl` beside `toJs`: `int/float/uint` → `i32/f32/u32`, `float(<uint expr>)` → `u32ToF32(…)` and
  `float(<int expr>)` of a full-range int → `i32ToF32(…)` (H1.28: `themedShared.js:89`, `island.js:99`,
  `labWorld.js:377`, `volcanoWorld.js:445`, `giantVolcano.js:332`, `placeholder.js:17`, `far.js:346`), ternaries →
  hoisted `var` + `if` (never `select`, because `thNoised` writes globals), uniforms → one UBO struct per scene,
  `texelFetch` → `textureLoad`, prototypes dropped, `out` params → a returned struct, the mutable global →
  `var<private>`. Hand-port the rest. Fill and diff must compile the identical WGSL function (the diff compares
  `a.w != gen.w` exactly).
- **Far field:** the raw grid becomes an `rgba16uint` 3D texture (exact integers, no half-float encoding), the field
  `rgba8unorm` 3D with hardware trilinear, L1/L2 occupancy one bitmask buffer built in one dispatch; region draws
  become dispatches over brick boxes (`discard` masks become early returns); chunks, tree maps, tops and shadow heights
  compute. The view stays a fragment pass (F1), with `inverse(...)` precomputed on the CPU (`far.js:990`). The layout,
  haze, casters and GI snippets live in `src/shaders/farShared.js` (U3), which far.js imports.
- **Detail meshes** leave three: our pipeline draws them in the scene pass with the far module's mesh entry, and the
  depth prepass is our own depth-only pass (replacing the nested `onBeforeRender` render, `detail.js:61, 246-259`).
  Worker output goes into our vertex buffers.
- **Structures** textures become storage buffers.
- A test-only `?win=<x>[,<y>,<z>]` overrides the window size (x and z; y only where the scene's world allows), so
  container tests run world scenes at 64 wide (U8 parses it, U10 honours it).
- Exactness to keep: `gen-check` (GPU vs twin, 0 cells differ), `world-check` steps 1–3, `island-dump --compare`,
  `scene-check` diff 0, far trees 350/350.

### G2. POV (`src/pov/**`, `shaders/pov*.js`, `transfer.js`, `wands.js`)
- Every writer is an edit (D7), one dispatch per body, drill or tool use, in call order (D6). Variants collapse into
  one pipeline per family keyed on grid size, never `sim.id` (`povTools.js:489-501` recompiled every tool per
  simulation).
- **Probes** go through `sim.probe` into the result ring; each keeps its own `seq`, `generation` and window-shift
  correction. P1 body probes: one dispatch per body, workgroup = brick. P2 ballistic trace: one thread per round
  writing all three rows, with a state-only DDA (the presentation brick map can be stale, pov map 4.1). P4 physgun
  COM: a workgroup reduction into a storage buffer the physgun edit reads in the same pass; `readCom()` becomes async.
- **Laser:** a one-thread reach kernel writes `reach`, `stopId` and indirect args for a slab apply; the apply reads
  `reach` from the buffer and only its own cell. The CPU gets `reach` through the ring 1–3 frames later for damage,
  the beam's vfx and `lastShot` (the vfx fades over 0.35 s). The edit marks what it changes, so no CPU box is needed.
- **Transfer:** the probe and apply read the same state in one workgroup (D7); conservation stays exact; the sync
  fallback (`transfer.js:249`) goes; on device loss in-flight loads are refunded.
- The hidden toolbelt's `drive()` rAF keeps working through the out-of-tick flush (B3).
- POV pipelines build on entering POV (B5).

### G3. Rays (`raysLayer.js`, `shaders/rays.js`, `src/rays.js`)
List as `array<Particle>` (64 B each); advance, spawn, paint in compute (spawn keeps its ping-pong unless proven safe in
place); deposits `atomicAdd` fixed point (D3) zeroed by `settle`; occupied bricks an `atomicOr` bitset read by
`quiet`; live and seen counts as atomics read back once per sweep (replacing `rows`/`total`). The emitter sweep walks
slots, one cycle per `ceil(SLOTS/N)` steps. The overlay draws only live particles: a compaction kernel after each step
appends live indices and writes `drawIndirect` args, so a nearly empty list costs nothing (today 65,536 instances
every view frame while active). Instanced quads (no point size in WebGPU), `size = clamp(uPointPx·0.7/viewZ, 1.5,
24)` px, disc mask in the fragment.

### G4. Lightning, signs, birds' probe, codec, constructions, foam
- **Lightning (`lightning.js`, `src/bolt.js`):** the bolt is an edit; the storm search is one dispatch reducing per
  workgroup, then `atomicMax` of a packed (charge, inverted scan index) key, then the 16-column scan; both read back
  through the ring.
- **Signs:** one workgroup of 64 threads (a sign each), sign data via `writeBuffer`, results through the ring.
- **Birds' probe:** a thread per probed column, results through the ring; `isContextLost()` becomes the gpu's
  `lost` flag.
- **Codec:** `pack` writes atlas-order RGBA8 (C2); up to 3 captures in flight; `unpack` = `writeBuffer` + kernel.
  **`readCells` (draft PR #5, not on main):** `readCells(renderer, sim)` is a thin wrapper over the pack and the
  readback service: `null` when no buffer is free, else `Promise<{ bytes, g, dims, release }>` with bytes in atlas
  order (byte 0 element id, byte 1 temperature code), the snapshot taken at the call (the pack and its copy are
  recorded then, B7), the mapped range copied into a pooled `ArrayBuffer` before resolving (mapped memory can't be
  transferred), `release(back?)` exactly once. Port against main; reconcile with PR #5 at merge time.
- **Constructions:** the stamp is a two-phase edit with its box plus footing; the ghost is TSL (F8).
- **Foam** (`gfx/foam.js`, `aerationFrag`): aeration runs over a brick list, not every cell. It is exact: the output
  is zero wherever the source cell's pre-move content doesn't foam (`liquidDetail.js:362-367`). The AER list, built
  each step after the move by a per-brick kernel (`act` read_write, like the activity build): bricks whose pre-move
  content foams (`marks.foams`: written by react for the bricks it wrote, set to 1 by every writer for the bricks it
  changed, D6; untouched bricks keep theirs), dilated by one brick in every direction (a block's source cell can be one
  brick away either way at parity 1); plus every brick listed in either of the last two steps (`aerSeen`), so both
  copies of the field are zeroed before a brick drops out; every brick after a whole-grid write. Idle (`uStill`)
  steps use the same list. Aeration reads the quiet map as `aerationFrag` does (a block with a non-quiet base always
  ran, so its `moveSrc` is current; a quiet-base block is identity). The every-cell reference is the same kernel fed a list of every brick (D8.11); I2.6 compares them bit for
  bit at every step of a pour. Shift kernel on window moves (out of place). Aeration's two copies are halves of one
  buffer (C4).

### G5. Profiler, UI, boot
- `gfx/profiler.js` reads `gpu.timing` (split mode while on) and keeps its report shape; `ui/profiler.js` unchanged.
  `gpuName` from `adapterInfo`; memory from a registry of our buffers and textures. `awakeShare` and `drawnShare` read
  `sim.readMaps()`/the counts ring, both now at brick level.
- **`src/main.js` boot.** `probeWebGPU()` before `import('./app.js')`; the menu doesn't wait for it. On failure, or
  when app.js's `createGpu` is refused (app.js stores that rejection in `launch.deviceError` before rethrowing, so
  main.js can tell it from an ordinary bug, which keeps today's stack-trace page), main.js closes the menu and shows a
  WebGPU error page naming the cause: no `navigator.gpu` (with "WebGPU needs a secure origin: use https or localhost"
  when `!isSecureContext`, the LAN-dev case), no adapter, a software adapter (`?software=1` to use it anyway), a refused
  device, or "run Chromium with `--enable-unsafe-webgpu`" under test. No redirect anywhere (W5). The `WEBGL_OFF`
  message becomes a WebGPU one for errors after the probe. `index.html`'s `<noscript>` names WebGPU.
- Menus grey out scenes and sizes `gpu.fits` rejects (B2).

## H. GLSL → WGSL porting guide for this codebase

### H1. Semantic traps (check every one in every function you port)
1. **Vector equality.** GLSL `a == b` / `a != b` on vectors is one `bool`; WGSL gives `vecN<bool>`. Write
   `all(a == b)` / `any(a != b)`. `inertSelf` (`b.xyz != vec3(0.0)`) and `writtenFlags` (`oA.xyw != a.xyw`,
   `oA != a`) depend on it.
2. **`mod`.** GLSL `mod(x, y) = x − y·floor(x/y)`; WGSL `%` on floats truncates. Use `glslMod` (`src/gpu/wgsl.js`)
   wherever GLSL had `mod` (`ign`, `gasNoise`, `detailNoise`, `mediaSegment` with negative arguments).
3. **Integer `/` and `%`.** Both truncate toward zero; WGSL defines a negative `%` (sign of the dividend) and `x / 0 =
   x`, `x % 0 = 0`, where GLSL is undefined. Keep the existing non-negative guards. A division by a `const` folds.
4. **Signed ↔ unsigned.** WGSL `u32(i)` of an `i32` and `i32(u)` of a `u32` already reinterpret the bits, as
   `bitcast` does; either spelling is fine where GLSL wrote `uint(i)` of a possibly negative int (`seedWorld`, window
   origins). WGSL `u32(f)`/`i32(f)` of a float saturate and truncate; GLSL is undefined out of range.
   `i32(floor(a.x + 0.5))` for `eid`.
5. **Wrapping.** `u32` and `i32` arithmetic wraps in WGSL. `pcg` ports verbatim. Shift amounts are `u32` and taken
   modulo 32 at runtime (a shader-creation error when constant and ≥ 32).
6. **No implicit conversions.** `f32(i)`, `vec3f(iv)`, `u32(x)`. Literals: `1.0`, `1i`, `1u`; abstract literals
   adapt to context.
7. **Constant folding.** WGSL folds abstract-float expressions in at least f64, GLSL in f32. Give every module-scope
   `const` an explicit type (`const X: f32 = …;`), and compute derived constants either at runtime from typed values or
   in JS with `Math.fround` at each operation when a CPU twin must match.
8. **`round`** is half-to-even in WGSL. Keep `floor(x + 0.5)` where the GLSL has it; never swap one for the other.
9. **`select(f, t, cond)`** evaluates both sides and takes the false value first. Never put a `rnd` draw, a write or
   a `thNoised` call in it; use `if`/`else`. GLSL `mix(a, b, bvec)` is `select(a, b, bvec)`.
10. **Swizzle assignment.** Single components only: `v.y = 0.0` works, `v.xz = h` doesn't
    (`v = vec3f(h.x, v.y, h.y)`; `land()`, `move.js:226, 230`).
11. **`out`/`inout`** → `ptr<function, T>`; pass `&x`, use `*p`. Address spaces aren't polymorphic: a
    `ptr<function, T>` parameter rejects `&` of a `var<private>`, so keep mutable state passed by pointer (random
    streams) in function-scope `var`s (C5). No pointers to a vector component or into storage: use a temporary and
    copy back. Array out-params (`clodBuild`) are pointers to function arrays.
12. **No `?:` on anything; no overloads.** Rename overloaded GLSL functions with a type suffix; structs and arrays
    can't be compared or used in `select`.
13. **Braces, statements.** `if` bodies need braces; `i++` is a statement, not an expression; no comma operator; no
    chained assignment; every path of a value-returning function returns; `switch` needs `default` and has no
    fall-through.
14. **Locals.** Mutated locals are `var`, others `let`; function-scope GLSL `const` becomes `let` unless its value
    is a const-expression.
15. **Booleans in buffers.** `bool` isn't host-shareable: `u32` in uniforms and storage, converted by accessors.
    Uniform arrays need a 16-byte stride: `uniform float uW[5]` becomes `array<vec4f, 5>`, `vec2 uCols[16]`
    `array<vec4f, 16>` with `.xy`.
16. **Constant tables.** Small direction tables become functions or `var<private>` arrays; element and material
    tables come from the `Tables` buffer through accessor functions (C6). Never index a large `const` array with a
    runtime value.
17. **`#define` and `#ifdef`.** Numbers → typed `const` (JS template); feature switches → `override` (small) or JS
    template conditionals (structural, big or binding-changing; F2); function-like macros → `fn`.
18. **Textures.** `texelFetch` → `textureLoad(t, coord, 0)` (or a buffer index); `texture()` →
    `textureSampleLevel(t, s, uv, 0.0)` everywhere (implicit-LOD sampling is rejected outside uniform control flow
    and nothing has mips); `textureSize` → `textureDimensions`. Keep explicit coordinate clamps: an out-of-bounds load
    returns 0 or some in-bounds texel.
19. **Derivatives** (`dpdx`, `dpdy`, `fwidth`) only in fragment shaders, only in uniform control flow (F2).
20. **`discard`** demotes the invocation to a helper: no writes after it, derivatives in neighbours stay valid. Not
    in compute; there, skip the store.
21. **Barriers** (`workgroupBarrier`, `storageBarrier`) only in uniform control flow: no early `return` before a
    barrier; use a flag and still reach it, or `workgroupUniformLoad` to make a value uniform.
22. **Builtins renamed.** `atan(y, x)` → `atan2`, `inversesqrt` → `inverseSqrt`, `bitCount` → `countOneBits`,
    `findLSB/findMSB` → `firstTrailingBit/firstLeadingBit`, `floatBitsToUint` → `bitcast<u32>`, `packHalf2x16` →
    `pack2x16float`, `lessThan(a, b)` → `a < b`, `greaterThanEqual` → `>=`, `gl_FragCoord` → `@builtin(position)`
    (pixel centre, top-left), `gl_FragDepth` → `@builtin(frag_depth)` ([0, 1]).
23. **Precision qualifiers** go; everything is f32. `highp` int is i32.
24. **Reserved words.** WGSL reserves many identifiers GLSL doesn't. Probed on Tint, the ones this codebase is likely
    to hit: `of` (`react.js:117`, `ctypeOf(int prod, int of, int self)`), `mod`, `move`, `set`, `get`, `new`, `pass`,
    `common`, `from`, `smooth`, `shared`, `super`, `use`, `with`, `where`, `as`, `do`, `ref`, `target`, `filter`,
    `meta`, `module`, `layout`, `active`, `self`, `type`, `match`, `final`, and the keywords `alias`, `default`,
    `override`, `enable`, `requires`. (`sample` and `texture` are fine.) Rename with a trailing `_`; names may not begin
    with `__`. check-wgsl reports the rest.
25. **Clamp and smoothstep.** For floats WGSL `clamp(x, lo, hi)` may be computed as `min(max(x, lo), hi)` or as the
    median of the three; they agree when `lo ≤ hi`. Never rely on `lo > hi` (with constant arguments it is a
    creation error). `smoothstep` with `low == high` divides by zero, as in GLSL.
26. **Fast math.** Dawn compiles MSL with fast math. Don't write NaN tests as `x != x`; test bits
    (`(bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u`), as post's `sanitize` does (`post.js:188-202`).
27. **The GLSL subset** shared with JS twins (`world/scenes/themedShared.js`) is never hand-edited into WGSL: it goes
    through `toWgsl` (G1).
28. **Integer → float rounding.** WGSL lets `f32(u)` of a `u32` (or `i32`) that isn't exactly representable round to
    either neighbour. SwiftShader doesn't round to nearest even: on 65,536 LCG values `f32(u) ≠ Math.fround(u)` in
    5,462 cases, all ≥ 2^31 (`f32(0xffffff7fu)` gave 2^32, so `rnd` gave 1.0 where round-to-nearest-even gives
    0.99999994). Every conversion of a value that can reach 2^24 uses `u32ToF32`/`i32ToF32` (C5), which reproduce
    round-to-nearest-even everywhere (65,536/65,536 on SwiftShader). Sites: `common.js:217-220` (`rnd`), and the
    `toWgsl` sites of G1.
29. **Out of bounds.** A storage index past the end doesn't fault: robustness clamps it (on SwiftShader an
    out-of-bounds read returned the last element and an out-of-bounds write landed in it). Worse, `slotOf` of an
    out-of-grid cell is a real cell. GLSL fragment outputs were positional, so this class of bug couldn't write a
    wrong cell before. Every `writeState`/`writeCell` must be dominated by `inGrid` and the box test (D8.9); the debug
    prelude counts violations.
30. **Uniformity of loaded values.** A value loaded from a `read_write` storage buffer is non-uniform for the
    uniformity analysis. A workgroup-wide early exit or barrier condition derived from a list count or flag word
    loads it with `workgroupUniformLoad` (or reads it from a read-only binding).

### H2. Template: a converted pass

The light blur (`passes.js:198-220`), one axis per dispatch at brick resolution: today a full-screen fragment pass
over the brick atlas, now a compute kernel with one thread per brick, in `brickId` order, ping-ponging two buffers.

GLSL today:

```glsl
#define LIGHT_BLUR_W 0.10, 0.22, 0.36, 0.22, 0.10
#define LIGHT_BLUR_GAIN 1.15
uniform sampler2D tSrc;
uniform int uAxis;
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  ivec3 dir = uAxis == 0 ? ivec3(1, 0, 0) : (uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
  ivec3 hi = ivec3(BX, BY, BZ) - 1;
  const float W[5] = float[5](LIGHT_BLUR_W);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    ivec3 q = bc + dir * (i - 2);
    if (any(lessThan(q, ivec3(0))) || any(greaterThan(q, hi))) continue;
    s += texelFetch(tSrc, brickAtlas(q), 0).rgb * W[i];
  }
  oC = vec4(s * LIGHT_BLUR_GAIN, 1.0);
}
```

WGSL in the same module, same export name; `last` makes the variant that stores the `light` texture:

```js
export const BlurParams = uniformStruct('BlurParams', { axis: 'u32' });
export const blurFrag = (g, { last = false } = {}) => /* wgsl */ `
${prelude(g, { state: false })}          // consts, Tables, header, brickId/brickCoord; no state bindings
// tent-ish 5-tap weights (sum 1), and a gain that makes up for light spread past the box
const LIGHT_BLUR_GAIN: f32 = 1.15;
var<private> W: array<f32, 5> = array<f32, 5>(0.10, 0.22, 0.36, 0.22, 0.10);   // small table: private (H1.16)
${BlurParams.wgsl}
@group(2) @binding(0) var<storage, read> src: array<vec4f>;          // one per brick, brickId order (pass 0: BrickInfo as vec4f, .rgb = emit)
${last
  ? '@group(2) @binding(1) var dstTex: texture_storage_3d<rgba16float, write>;   // the light volume'
  : '@group(2) @binding(1) var<storage, read_write> dst: array<vec4f>;'}
@group(3) @binding(1) var<uniform> P: BlurParams;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let i = (wg.x + wg.y * nwg.x) * 64u + li;            // fold()ed dispatch (B5)
  if (i >= NBRICKS) { return; }                        // no barrier below, so an early return is fine (H1.21)
  let bc = brickCoord(i);
  var dir = vec3i(0);
  dir[P.axis] = 1;                                     // the GLSL's nested ?: as an index assignment
  let hi = vec3i(BX, BY, BZ) - 1;
  var s = vec3f(0.0);
  for (var k = 0; k < 5; k++) {
    let q = bc + dir * (k - 2);
    if (any(q < vec3i(0)) || any(q > hi)) { continue; }   // skipped, not renormalised, as before
    s += src[brickId(q)].rgb * W[k];                       // same operand order as the GLSL
  }
  ${last ? 'textureStore(dstTex, bc, vec4f(s * LIGHT_BLUR_GAIN, 1.0));' : 'dst[i] = vec4f(s * LIGHT_BLUR_GAIN, 1.0);'}
}
`;
```

```js
// derived.js: two pipelines, four bind groups made once per grid
const blur = gpu.kernel({ name: 'blur', code: blurFrag(g), layouts: [L.TABLES, L.EMPTY, L.BLUR, L.PARAMS],
  params: BlurParams, workgroupSize: [64, 1, 1] });
const blurLast = gpu.kernel({ name: 'blurLast', code: blurFrag(g, { last: true }),
  layouts: [L.TABLES, L.EMPTY, L.BLUR_OUT, L.PARAMS], params: BlurParams, workgroupSize: [64, 1, 1] });
// brick → L0, L0 → L1, L1 → L0, and L0 → the light texture (LIGHT_BLUR_PASSES = 6: passes 1, 3, 5 read L0)
const [fromBrick, l0ToL1, l1ToL0, l0ToLight] = blurGroups;
const size = fold(Math.ceil(g.nbricks / 64));
for (let k = 0; k < LIGHT_BLUR_PASSES; k++) {
  const last = k === LIGHT_BLUR_PASSES - 1;
  const group = last ? l0ToLight : k === 0 ? fromBrick : k & 1 ? l0ToL1 : l1ToL0;
  (last ? blurLast : blur).dispatch(f, size, {
    bind: [tables, gpu.emptyGroup, group], header: gpu.nullHeader, params: { axis: k % 3 } });
}
```

What changed and what didn't: the names (`blurFrag`, `LIGHT_BLUR_GAIN`, `W`), the taps, their order and the edge rule
are the GLSL's; `brickFromFrag`/`brickAtlas` became `brickCoord`/`brickId`; `texelFetch` became a buffer index; the
padding-tile `return` went (brick ids have no padding); `lessThan`/`greaterThan` became `<`/`>` inside `any`; the
nested `?:` became an index assignment. Pass 0 reads the brick map's emission through an `array<vec4f>` view of the
`BrickInfo` buffer (`.rgb` = `emit`); the last pass is its own pipeline that stores the `light` 3D texture with
`textureStore`. Every dispatch passes a header (B4). The size is CPU-known, so the dispatch is direct (E).

## I. Tests and verification

### I1. Runs in this container (Chromium 141 headless, SwiftShader WebGPU)
- WebGPU exists here only with `--enable-unsafe-webgpu` and only on a secure origin (`http://localhost`). The adapter
  is a fallback adapter (`isFallbackAdapter: true`, architecture `swiftshader`) with `subgroups`, `timestamp-query`,
  `float32-filterable`, but not `shader-f16`; 10 storage buffers per stage. Test mode accepts it (B2).
- Cost: a 64³ 7-point stencil pass takes ~12 ms; 128³ is 8× that. Pipeline creation is the other cost (W23): a
  211-line branchy switch kernel took 4.7 s, straight-line kernels of 621, 921 and 1,021 lines 2.2, 4.9 and 5.8 s,
  and a 1,221-line one lost the device ('A valid external Instance reference no longer exists', `device.lost` reason
  `unknown` at ~8.7 s, also with `--disable-gpu-watchdog`). Tint-only validation of the same modules took 7–57 ms.
  Generated today at 64³: `reactFrag` 1,489 lines, `moveBlockFrag` 2,377, `volumeFrag` 6,384. Simulation tests run at
  32³ and 64³; each tool has a step budget set from U2's measured ms/step per kernel. The WebGL2 build doesn't run here
  at all (SwiftShader GL has 6 draw buffers; `moveBlock` writes 8), so there is no A/B in the container.
- Two agents share 4 CPUs and the launcher stops a browser at 10 minutes: a tool run stays under ~3 minutes, split
  into stages when it would not.
- New tools start their own Vite through `tools/vite-server.mjs` (Vite's JS API, a free port, `strictPort`, closed in
  `finally`); existing tools keep their `--port` convention. All launch through `tools/browser.mjs`.

| Tool | What it proves |
|---|---|
| `tools/check-wgsl.mjs` (new; replaces `check-shaders`, `check-scenes` and the GLSL parts of `rays-check`, `elements-core-check`) | **(a) validate**: every module variant × grid (32³, 64³, 128³, 160×96×160, the world window, the giant volcano window) through `createShaderModule` + `getCompilationInfo` (Tint only, cheap): no errors or warnings; each module's `@group/@binding` declarations parsed and matched against its layouts (type, access, format); per-stage storage buffer/texture counts printed against 8/4; every kernel's dispatch sizes computed for the giant-volcano layout, ≤ 65,535 per dimension. **(b) build**: `create*PipelineAsync` once per distinct module at the smallest grid, each with a `PIPELINE_BUDGET_MS` timeout, `--time` prints creation times; modules on `WGSL_MAC_ONLY` are skipped with their reason. Modules declare their pipelines in an exported `WGSL_CHECK` list (and `WGSL_MAC_ONLY`), so no shared registry file is edited by every unit |
| `tools/check-imports.mjs` (new) | every module under `src/shaders/**` and `src/gfx/**` imports in Node (the generators are callable without a GPU or DOM); a module that can't is listed with its reason |
| `tools/check-async-reads.mjs` (new) | CPU lint: no call to `readState(`, `readCell(`, `census(`, `gpuSync(`, `readCopies(`, `readMaps(`, `readFlow(` in `tools/` or `scripts/` that isn't `await`ed or `.then`ed (a missed `await` turns `check(cell()[0][0] === E.ROCK, …)` into an assertion that always passes). Runs in CI next to `check-browser-launch` |
| `tools/budget-check.mjs` (new) | per scripted frame, `gpu.stats`: submits, render and compute passes, dispatches (indirect ×2), workgroups dispatched against list lengths (indirect args read back), bytes allocated, pipelines created. Scenarios live in `tools/budgets/<unit>.mjs` (each unit owns its own file): a settled box scene (0 submits, 0 rAF callbacks over 1 s), a box view frame (1 submit), the lab at 4 steps per frame, POV, a world move. A unit that changes a number says why |
| `tools/gpu-foundation-check.mjs` (new) | params packing vs WGSL layout; > 2048 dispatches in one tick with every step's frame and parity right; readback recorded at the request (a write after the request isn't seen); de-padding; async pipeline failure text; `lose()` → `GraphicsFailure`; a validation error after three's init reaches `fail`; three interop (B10) incl. one ExternalTexture source swap; the walking skeleton (U0) |
| `tools/tables-check.mjs` (new) | every table field read back through a kernel equals JS; `pcg`/`seedWorld`/`u32ToF32`/`i32ToF32`/`rnd` for 65,536 inputs equal a JS reference (`Math.fround`) bit for bit |
| `tools/sim-check.mjs` (new, harness page `tools/harness/`, no app) | the I2 invariants below, in stages (`--stage determinism|sleep|conservation|behaviour|moves|aeration|io|shift`), each within the budget above |
| `tools/activity-check.mjs` | flag-built inert and quiet maps (incremental) equal the reference kernel (`sim.passes.inertRef`, a full rebuild) in 0 bricks, 300 maps, every writer. `--harness` runs it without the app at 64³ with lab and volcano built by CPU `buildPreset` (`presets.js:12`) |
| `tools/derived-check.mjs` | incremental == full, bit for bit, every derived resource, including after a window shift |
| `tools/idle-check.mjs` | a settled world reaches 0 submits/s and 0 rAF callbacks (`gpu.stats`, the app's tick counter, not a replaced rAF), every waker wakes, stale idle reads are rejected |
| `tools/state-hash.mjs` | within WebGPU: repeat runs identical; normal vs `--nosleep`: every line but `drawn` (`--noskip` is different physics by design, D2: quiet skipping leaves out sub-tolerance drift, so it isn't compared bit for bit). Cross-build through `tools/page-gpu.mjs` (I4) |
| `tools/headless-check.mjs` | modes keep physics identical, preview presents at 10 Hz, a parked page submits nothing, picks read the state |
| `tools/gpu-failure-check.mjs` | device loss and a bad WGSL module stop graphics with today's messages and throws |
| `tools/smoke.mjs` (new) | boot box presets at 64³ and every world scene at `?win=64` (the giant volcano only through check-wgsl (a): its window is 384 tall) in a 400×250 viewport with `?view=plain`, `test.renderOnce()`, no GPU errors (until U13 lands, an allowlist of three's "NodeBuilder: Material "ShaderMaterial" is not compatible" warnings for the meshes U13 ports), non-blank screenshot (pixel variance above a floor); shots saved for review. Views other than plain are built when they fit the budget, else covered by (a) |
| world, POV, rays and codec tools | `gen-check`, `world-check`, `caves-check`, `scene-check` (exact twins), codec round trip, `pov-engine-check`, `pov-tools-a/b`, `rays-gpu`, `burrower-laser-check` at small grids |

### I2. The sim invariants (`tools/sim-check.mjs`)
1. **Determinism:** two runs, same seed, 300 steps with painting between: identical `state`, `flow`, `copies`, `maps`.
   Also normal vs `sim.test.listOrder = 'reverse'` and `'shuffle:<seed>'` (a tiny kernel permutes the DRAWN, MOVE1,
   INERT and AER lists after each build) and `blockOrder = 'reverse'` (reversed thread → block map in the move):
   identical. SwiftShader appends atomics and schedules workgroups in a near-fixed order, so without the permutation
   an order dependence passes here and shows up only on the Mac.
2. **Sleep exactness:** normal vs `skipSleeping = false` (every brick dispatched): `state`, `flow`, `copies` (flags
   included) and `maps` (inert, quiet, awake; not `drawn`, which differs by design) identical at every checkpoint.
   Scenes: lab, a settling sand pile, a pool, an idle box, plus writes between single steps (the case D5.3 exists
   for). One-step maps with a write every step: DRAWN stays bounded (≤ the AWAKE and forced bricks plus those within
   two maps of leaving AWAKE). (`skipQuiet = false` isn't compared: quiet skipping leaves out sub-tolerance drift by
   design, D2.)
3. **Conservation:** cells per element exact over 300 steps where the rules conserve them (sand, water, stone, wall,
   oil); Σ cap·T in a closed metal box with a hot spot within 1e−5 relative.
4. **Behaviour:** sand falls and piles (centre of mass down, all grains resting on the floor or a grain by 300 steps);
   water levels (top surface within 1 cell); wood burns (wood count down, fire and smoke appear); heat diffuses
   (variance of T falls monotonically); a block of powder in a box comes to rest and the world certifies idle.
5. **In-place vs out-of-place move** (Whitewater's mode, the same pipeline): identical `state` and `flow`.
6. **Aeration over its list vs every brick:** identical aeration field at every step of a pour and of the idle steps
   after it.
7. **readState/load round trip** exact; `readCopies` after `syncCopies` shows equal copies; undo restores exactly.
8. **No out-of-grid access:** the debug prelude's counter is 0 after every stage.
9. **Shift:** after `shift` + an edit over the entering slab + 50 steps, `state` and `flow` are identical with and
   without `syncCopies` after the fill (`sim.test.syncAfterShift`).
10. **Race probe:** `sim.test.raceProbe = true` swaps in a test-only move variant whose solve also reads a cell of the
    neighbouring block. I2.1 must then fail on the Mac (I4.0), which shows the check can see a race; here it is
    reported, not asserted.

### I3. Headless launcher (`tools/browser.mjs`)
`GPU_ARGS` per platform: always `--enable-gpu`, `--ignore-gpu-blocklist`, `--enable-unsafe-webgpu`,
`--enable-webgpu-developer-features` (un-quantized timestamps); on macOS also `--use-angle=metal`, which only matters
for the legacy WebGL build in cross-build runs and is harmless otherwise. Tools that pass `args` append to `GPU_ARGS`
instead of replacing them (`gp-audio`, `gp-integration`, `wand-editor-check`). Export `gpuInfo(page)` so every report
records the adapter, and `--real-gpu` (default on macOS) makes a tool fail on a fallback adapter. `render(page)` awaits
`__app.test.ready()` when it exists (U8 adds it). `check-browser-launch.mjs` is unchanged.

### I4. On the user's Mac

The legacy checkout is `git worktree add ../tpt-legacy <LEGACY_SHA>` with its own `npm ci`. Every cross-build tool goes
through `tools/page-gpu.mjs` (`readState`, `fence`, `drawCount`, `gpuName`, branching on `__app.gpu`), so one script
drives the legacy build's sync APIs and this build's async ones.

**Mac checkpoints.** The user reviews the finished PR rather than following the port, so these don't gate any wave:
they are the first items of the PR's Mac checklist, in the order the units landed, and each names what it would have
caught. **M1** (after U2 and U3): `npm run harness` → the sim bench page (ms per step per kernel at 64³ and
128³, pipeline creation times of react and the move, timestamp queries) next to scaling.md's legacy numbers. **M2**
(after U6): view pipeline creation times and MSL sizes per view (Dawn `dump_shaders`). **M3** (after U8): I4.0.

0. **Correctness on the Apple GPU, before anything cross-build.** `tools/sim-check.mjs` (all of I2) at 64³ and 128³;
   `activity-check`, `derived-check`, `idle-check`; `state-hash` twice and with `--nosleep` at 128³ for lab and
   volcano. Every tool prints `gpuInfo` and runs with `--real-gpu`. I2.10's race probe must make I2.1 fail. This is
   the only place the in-place move, the list appends, the ray deposits and the writer marks run on a GPU that
   schedules like one.
1. `node tools/bench.mjs --census --a <legacy> --b <branch>`: identical at load; after 200 steps cells per element
   exact where conserved, energy and quiet share and mean |v| within the stated bounds.
2. `tools/state-hash.mjs` `load` lines equal across builds (no physics yet); later lines are expected to differ. This
   needs `blankState` to draw from its own seeded PRNG in both builds (K2.4); until then a difference at load can be
   three's UUIDs drawing from `Math.random` between the reseed and `blankState`.
3. `tools/island-dump.mjs` on both, `--compare`: generation exact.
4. `tools/regress.mjs`: before/after sheets for review (cross-API AE isn't 0), then freeze WebGPU baselines; later
   WebGPU refactors must be AE 0 at 1% fuzz.
5. `tools/bench.mjs` timing: ms/step at 128³ (empty, island, lab, volcano), `updateBricks` ms, view frame ms, wall and
   GPU (timestamp) times, interleaved A B B A, with Whitewater on and off. The legacy profiler's `awakeShare` (brick
   level, `profiler.js:144`) against `drawnShare` (supertile level, `:156`) on lab, island and volcano sizes the
   brick-granularity gain; the branch reports both at brick level.
6. Cold start: `tools/cold-start.mjs` (new) with a fresh profile: time to first frame, longest main-thread task
   during pipeline creation; warm second run; the same after a deploy that changes one module. `preload-check`,
   `world-load-time`.
7. `tools/lod-frame-bench.mjs` end-to-end frame times on the island.
8. **Safari 26 smoke** (manual): boot, every view, a world, POV, a window move; confirm no redirect; record
   `adapter.limits` and features. Record Chrome's on the Mac too.

### I5. Performance per watt (`tools/power.mjs`, new, Mac only)
Scenarios of 60 s each per build, the same seed: a settled box scene (nothing changing), the lab running at 4 steps
per frame, the default World island scene (birds, Whitewater on) with the camera still, an island POV walk, a world
camera flight; the lab and island with Whitewater on and off. Samples `sudo powermetrics --samplers
gpu_power,cpu_power -i 500` (the tool prints the command when `sudo -n` isn't allowed) and the `IOAccelerator`
utilization. Reports mean GPU, CPU and package mW, mJ per sim step, mJ per presented frame, submits/s and rAF
callbacks/s from `gpu.stats`. The settled box scene is judged on package mW against legacy (both make no GPU calls;
the branch also stops its rAF loop), not on submits.

## J. Work breakdown

### J1. Units

Each unit lives on its own branch off `claude/webgpu-port`, merges back when its acceptance passes, and runs the J4
gates before handing back. "GLSL" is the GLSL being replaced (measured from the sources); JS changes come on top.
"GPU" marks units whose tests load SwiftShader heavily (used for wave pairing, J2).

| Unit | Owns (only it edits these while it runs) | Depends | GLSL | Accept (what it can verify alone) |
|---|---|---|---|---|
| **U0 Foundation** (GPU) | `src/gpu/*` (new), `tools/browser.mjs`, `tools/vite-server.mjs`, `tools/check-wgsl.mjs`, `tools/check-imports.mjs`, `tools/budget-check.mjs`, `tools/budgets/foundation.mjs`, `tools/gpu-foundation-check.mjs`, `tools/harness/` core (new; units add their own page files there), `vite.config.js`, `package.json` scripts, `package-lock.json` | — | 0 | device on SwiftShader; foundation check passes (I1 row); **walking skeleton** in the harness: the presenter configures the canvas, one render pass of ours, three renders a mesh into the scene target after it with `loadOp: load`, a composite to the canvas; **compile-time curve** of synthetic kernels on SwiftShader with the device-loss cause from the GPU process log (`--enable-logging=stderr`) recorded; check-wgsl (a) and (b) on a sample module |
| **U1 Prelude, tables, bindings** | `src/shaders/common.js`, `src/shaders/bindings.js` (new), `src/elements.js`, `src/physics.js`, `src/electricity.js`, `src/gfx/incandescence.js`, `src/gfx/materials.js`, `src/gfx/sky.js`, `tools/check-state-access.mjs`, `tools/elements-core-check.mjs`, `tools/tables-check.mjs` (new), `scripts/check-tile-engine.mjs` | U0 (to validate) | ~600 + generators | tables-check exact (incl. `u32ToF32`, 65,536 inputs); prelude validates; check-state-access passes on WGSL; bindings.js emits every layout variant of F6 and they validate |
| **U2 Sim core** (GPU) | `src/sim.js`, `src/shaders/move.js`, `react.js`, `activity.js`, `passes.js` (paint, copy, fresh, awake), `window.js` (shift, undoShift, flowShift), `src/gfx/regions.js` (retire), `tools/sim-check.mjs` (new), `skip-model.mjs`, `activity-check.mjs`, `sleep-crossover.mjs`, `tools/harness/sim-*` (new), `tools/budgets/sim.mjs` | U0, U1 | ~1350 | **first**: react and the move ported mechanically and timed on SwiftShader; the move's code form fixed (D2) and recorded; then I2 stages at 32³/64³ in the harness with recorded ms/step per kernel and per-tool step budgets; activity-check `--harness` 0; skip-model with its negative controls; the sim bench page for checkpoint M1 |
| **U3 Render library core** | `src/shaders/gfx/core.js`, `noise.js`, `lighting.js`, `crystal.js`, `clouds.js`, `src/shaders/gfx/lib.js` (new: `lib(g)` assembly), `src/shaders/farShared.js` (new: far layout, haze, casters and GI snippets, moved from `far.js`), `tools/lib-check.mjs` (new) | U0, U1 | ~1290 + ~150 far | a probe kernel calling every exported function validates and builds; spot values of noise, `sunBasis`, SH evaluation vs JS |
| **U4 Derived** (GPU) | `src/derived.js` (new), `src/shaders/fields.js`, `src/shaders/passes.js` (brick, blur, brickDist, age, dirty), `tools/derived-check.mjs`, `derived-bench.mjs`, `tools/budgets/derived.mjs` | U2 | ~340 (+ ~400 JS from sim.js) | derived-check bit for bit in the harness, including a shift case; brick bits decode test; allocates the GI probe and light textures (zeros until U9) so the volume can bind them |
| **U5 Render materials** | `src/shaders/gfx/surface.js`, `liquid.js`, `liquidDetail.js` (render part), `media.js`, `mediaDetail.js`, `relief.js`, `grains.js`, `plain.js`, `tools/material-lod-check.mjs` | U3 | ~3350 | every detail combination validates (check-wgsl a) in a probe kernel, builds where within budget; material-lod-check |
| **U6 Volume, shadow, pick, scene overlays** (GPU) | `src/shaders/render.js`, `src/views.js`, `src/gfx/uniforms.js`, `src/gfx/detail.js`, `src/gfx/detailGate.js`, `src/gfx/mediaNoise.js`, `src/gfx/coldShader.js`, `src/gfx/overlays.js` (new: floor grid, box edges), `src/brush.js`, `tools/compile-bench.mjs` (→ pipeline bench), `tools/detail-bench.mjs` | U3, U4, U5 | ~840 + brush | harness scene pass renders the plain view at 64³ and every view module that fits the budget (the rest on `WGSL_MAC_ONLY`, validated); shadow (both textures) and pick kernels against a known scene; grid, edges and brush drawn in the scene pass |
| **U7 Post, pacing, profiler** | `src/gfx/post.js`, `src/gfx/pacing.js`, `src/gfx/profiler.js`, `src/ui/profiler.js`, `src/gfx/programs.js` (delete), `tools/resolution-check.mjs`, `profile-check.mjs`, `tools/budgets/post.mjs` | U0 | ~500 | post on a synthetic scene target in a 400×250 viewport: TAA converges, adaptation reads back, 3 render + 1 compute pass, the opaque canvas presents the sky gradient; createViewKey's counter changes exactly when the old string would (a test over recorded inputs); resolution-check |
| **U8 App integration** (GPU) | `src/app.js`, `src/main.js`, `src/launch.js`, `src/preload.js`, `src/ui/topbar.js`, `index.html`, `src/wire/*.js` (new: creates every wire module, J3), `tools/headless-check.mjs`, `tools/gpu-failure-check.mjs`, `tools/idle-check.mjs`, `tools/regress.mjs`, `tools/smoke.mjs` (new), `tools/budgets/app.mjs` | U2, U4, U6, U7 | 0 | the box app boots (`?view=plain` in the container; other views as U6 built them); `__app.test.ready()`, `test.renderOnce()`, `__app.view`, `?win=`; deep idle: 0 submits and 0 rAF callbacks when settled (idle-check); headless-check, gpu-failure-check, smoke (box presets) with the allowlist; budgets for the settled box scene and a box view frame (1 submit) |
| **U9 GI** (GPU) | `src/shaders/gi.js`, `src/derived.js` (updateGI; takes over from U4) | U4, U6 | ~110 | probes converge in a lit test scene; checkerboard parity; buffer and textures agree; GI gather within 4 storage textures (`L.LIGHTING_GI`) |
| **U10 World** (GPU) | `src/world/**`, `src/shaders/far.js`, `generate.js`, `stamp.js`, `window.js` (stage, edit, gather, giShift; from U2), `src/wire/world.js`, world tools (`world-check`, `gen-check`, `island-dump`, `caves-check`, `landforms-gpu`, `scene-check`, `far-check`, `far-regress`, `far-lod-check`, `world-detail-check`), `tools/budgets/world.mjs` | U8, U9 | ~1530 + emitter for ~1400 subset lines | twins exact; world-check 1–3; world scenes in smoke at `?win=64`; world-move budget (no `syncCopies`, derived shift instead of `changedAll`) |
| **U11 POV compute** (GPU) | `src/pov/**` except the U13 files below, `src/shaders/povBody.js`, `povBore.js`, `povKick.js`, `povTools.js`, `povTrace.js`, `transfer.js`, `wands.js`, `src/wire/pov.js`, POV tools (`pov-tools-a/b`, `burrower-laser-check`, `pov-engine-check`, `pov-player-check`, `perks-cpu-check`, `kick-hook-check`, `flask-check`, `gibs-check`), `scripts/check-wand-*.mjs`, `tools/budgets/pov.mjs` | U8 | ~820 | conservation checks exact; laser without sync read; one dispatch per edit; POV in smoke |
| **U12 Small compute subsystems** | `src/raysLayer.js`, `src/rays.js`, `src/shaders/rays.js`, `src/lightning.js`, `src/bolt.js`, `src/shaders/lightning.js`, `src/signs.js`, `src/shaders/probe.js`, `src/birds/probe.js`, `src/birds/index.js`, `src/net/codec.js`, `src/net/multiplayer.js`, `src/gfx/foam.js`, `src/shaders/gfx/liquidDetail.js` (aeration part; from U5), `src/wire/{rays,lightning,signs,birds,mp,foam}.js`, `tools/rays-gpu.mjs`, `rays-check.mjs`, `elec-gpu-check.mjs`, `nt-mat-gpu.mjs`, `gpu-readback-check.mjs` | U8 | ~630 | rays-gpu (overlay through `drawIndirect`); codec round trip; lightning strike in a test scene; aeration determinism and I2.6 (list == every brick) |
| **U13 Mesh layer** | `src/pov/figure.js`, `figureReal.js`, `flame.js`, `models.js`, `viewmodel.js`, `vfx.js`, `classPortraits.js`, `vehicles/look.js`, `worm.js` (material; from U11), `src/pov/tools/physgun.tool.js` (rim; from U11), `src/pov/tools/hotbar.js`, `src/pov/classPicker.js`, `src/ui/dock.js`, `src/birds/render.js`, `src/net/cursors.js`, `src/constructions.js`, `src/gfx/billboards.js` (new), `src/wire/mesh.js`; `src/spawners.js`, `src/perkOrbs.js`, `src/game/markers.js`, `src/arenas/markers.js` only if their built-in materials need a change; `package.json` and `package-lock.json` (remove three.quarks), `tools/bake-icons.mjs` (new), `public/icons/*` (new), `tools/pov-character.mjs`, `pov-viewmodels.mjs`, `torch-look.mjs`, `birds-shots.mjs` | U8, U11 | ~550 → TSL | figures lit, viewmodel composited, particles and ghost in smoke shots; every new mesh kind compiled through `prepare`; icons baked and `bake-icons --check` clean; no three.quarks import; the smoke allowlist emptied |
| **U14a Async tools** | `tools/page-gpu.mjs` (new), `tools/check-async-reads.mjs` (new), and the ~25 ASYNC-only tools no other unit owns (the codemod list in the tools-tests map 8) | U0 (API in this doc) | 0 | check-async-reads clean over `tools/` and `scripts/`; converted tools use page-gpu; those runnable in the container at that point run, the rest say why |
| **U14b Cross-build and performance tools** | `bench.mjs` (build-agnostic through page-gpu), `state-hash.mjs` (from U2's sim API), `headless-cost`, `lod-frame-bench`, `world-load-time`, `preload-check`, `check-browser-launch` LEGACY list, `program-bench`/`app-compile-probe` (retire), `check-shaders`/`check-scenes` (delete), `tools/power.mjs` (new), `tools/cold-start.mjs` (new) | U8, U14a; U10, U11 for their scenarios | 0 | every tool runs in the container or says why it is Mac-only; a cross-build dry run (the legacy build here stops at its known GL failure, but page-gpu must pick the legacy path); no `readRenderTargetPixels`, `getContext()` or GLSL left in `tools/` |
| **U15 Deploy and docs** (done) | `.github/workflows/deploy.yml`, `docs/scaling.md` (D1 note), `docs/headless-testing-cost.md`, `docs/world-lod.md`, `docs/particles.md` (where they describe WebGL); a local branch against `main` for `blankState`'s own PRNG (K2.4) | — | 0 | Landed with a `/legacy/` build step; the user then chose no fallback (W5), so the deploy is back to building `dist/` alone. The docs notes and the PRNG branch stand |
| **U16 Final integration** | `src/app.js` (second pass), `src/wire/index.js` (`ready` flags removed), the stubs (J3), the `*GLSL` → `*WGSL` rename commit, `docs/webgpu.md` ("as implemented" notes) | all | 0 | I1 in full; the Mac checklist (I4, I5) written out for the user with exact commands |

### J2. Waves (two agents at a time)

| Wave | Units | Why this order and pairing |
|---|---|---|
| 0 | U0, U1 | U1 writes WGSL text without a device (light on the CPUs); it validates once U0 lands |
| 1 | U2 (GPU), U3 | the sim and the render library only share the prelude; U3 is mostly Tint validation |
| 2 | U4 (GPU), U5 | derived needs the sim; materials need the library core; U5 is mostly validation |
| 3 | U6 (GPU), U7 | the volume needs both libraries and the derived textures; post needs only U0 and tests at 400×250 |
| 4 | U8 (GPU), U15 | first boot of the box app (U15 ran early, beside wave 0) |
| 5 | U9 (GPU), U14a | GI plugs into derived and the volume's lighting group; the async codemod is CPU-only |
| 6 | U10 (GPU), U12 | world needs the booting app and GI; the small subsystems need only the app |
| 7 | U11 (GPU), U14b | POV; the cross-build tools are mostly Mac-run |
| 8 | U13 | the mesh layer after POV's sim side |
| 9 | U16 | integration, the full container suite, the Mac checklist |

The critical path is U0 → U1 → U2 → U4 → U6 → U8. Anything in a later wave may start early on a branch, but merges only
after its dependencies. Mac checkpoints M1–M3 (I4) are run by the user at review, not waited on during the port.

**How units run.** The orchestrator creates one git worktree per unit (`../wt/<unit>`, branch `webgpu/<unit>` off
`claude/webgpu-port`, its own `npm ci`). The unit's implementer commits there; an adversarial reviewer then reads the
diff against this document and runs the acceptance tools in the same worktree; the implementer fixes what the review
confirms. The orchestrator merges the branch into `claude/webgpu-port` after re-running the J4 gates, and the next
wave's worktrees branch from the merged result.

### J3. Files many units touch, and how edits are sequenced
- **Exports across units.** During the port no unit deletes or renames an export that a file owned by another unit
  imports (ES modules fail at link time, before any flag is read, and Vite's build fails with `MISSING_EXPORT`).
  A removed function becomes a stub that throws `Error('<name> removed in the WebGPU port: docs/webgpu.md <section>')`
  when called; a removed string or value constant becomes a placeholder (`''` or `null`); either carries the comment
  `// WEBGPU-STUB (docs/webgpu.md J3)`, and U16 deletes every stub. A module that calls a stub at import time is a bug
  in that module's unit. Known cases: `common.js` `quadVert`, `stateUniforms`, `stateOutGLSL`, `copyThroughMain`
  (14–15 importers each, in U2, U8, U10–U13); `move.js` `slotGLSL` (`liquidDetail.js`); `sim.js` `rawMat`,
  `makeFieldTarget`, `brickTexel` (world, foam); `RegionQuads`. Names are kept otherwise (W2), so there is no rename
  table.
- **`src/app.js`**: U8 rewrites it once against the APIs in this document and **moves every subsystem's wiring out of
  it** into `src/wire/<name>.js` (today's code moved verbatim, unreachable until ported): `world`, `pov`, `rays`,
  `lightning`, `signs`, `birds`, `mp`, `mesh`, `foam`. `src/wire/index.js` (U8) lists them; app.js calls each one's
  hooks at fixed points and never names a subsystem again. Each wire module then belongs to its subsystem's unit
  (J1), so U10–U13 boot and test their subsystem in the real app without editing app.js:
  ```js
  // src/wire/<name>.js
  export default {
    name: 'world',
    ready: false,                 // true when its unit lands; app.js greys out what a not-ready wire serves
    attach(app) {},               // after build(); app = { gpu, three, sim, derived, scene, camera, settings, pacer, post }
    beforeStep(app, dt) {},       // POV edits, window move
    afterStep(app, dt) {},        // lightning, birds' probe
    beforeView(app, dt) {},       // signs, far upkeep, figures' uniforms, external textures
    scene(app, rp) {},            // draws into our scene pass, in the wire's `order` (far before volume, detail…)
    order: 0,
    detach(app) {},               // before a rebuild or a grid change
  };
  ```
  A change app.js itself needs is written into the hand-back notes for U16.
- **`src/sim.js`**: U2 only. Later subsystems plug in through `sim.attachRays(rays)` (the rays interface: `active`,
  `step(f)`, `settle(f)`, `bricks`, `deposit`, `stepped`; U2 ships an inactive stub and drops `sim.js:23`'s import),
  `sim.attachAeration(aer)` (same idea), `sim.onShift`, and `derived.js`. The wire modules call them.
- **`src/shaders/bindings.js`**: U1; later units only append (F6). **`src/shaders/farShared.js`**: U3; read by U6, U9,
  U10. **`src/shaders/passes.js`**: U2 (wave 1, its sim part), then U4 (wave 2). **`src/shaders/window.js`**: U2,
  then U10. **`src/derived.js`**: U4, then U9. **`src/shaders/gfx/liquidDetail.js`**: U5, then U12. **`src/pov/worm.js`,
  `src/pov/tools/physgun.tool.js`**: U11, then U13. **`package.json`, `package-lock.json`**: U0, then U13 (the
  lockfile always in sync: `npm ci` in the deploy needs it). **`tools/harness/`**: U0's core; other units add only new
  page files. **`tools/budgets/`**: one file per unit.
- **`docs/webgpu.md`**: only U16 edits it during the port; units put their "as implemented" notes in their merge
  commit messages.

### J4. Hand-back rules for every unit
- `node tools/check-wgsl.mjs` (a) clean for everything; (b) clean for the unit's modules, each within the budget or on
  `WGSL_MAC_ONLY` with a reason (never a sim kernel).
- `npm run build` succeeds (no `MISSING_EXPORT`); `node tools/check-imports.mjs` clean.
- `node tools/check-async-reads.mjs` clean once U14a has landed (before that, the unit checks its own tools by eye).
- `node tools/budget-check.mjs` passes the unit's scenarios and those of units it touches.
- The unit's acceptance tools pass in the container; numbers recorded (ms per step, pipeline creation times).
- No GLSL left in the files the unit owns except J3 stubs; no `three` import in sim or derived code; no new
  `navigator.gpu` use outside `src/gpu/`.
- Follow CLAUDE.md: own Vite port with `--strictPort`, stop your processes, commit only your files, never deploy.
- A decision this document didn't make is written into the hand-back notes for U16, not invented silently.

## K. Risks and open questions

### K1. Risks
1. **Compile time and register pressure of the big kernels** (react, the move, the realistic volume at ~6k lines).
   Tint→MSL may allocate worse than ANGLE→MSL, and SwiftShader may not build them at all (W23). Mitigations: tables
   out of the source, per-view modules, async creation of only what is used, the compile budget, U2's first-deliverable
   measurement, Mac checkpoints M1 and M2.
2. **The GPU vs CPU twin of world generation** must stay exact under Dawn's fast math. A mismatch makes every
   regenerated brick look edited. Mitigation: `u32ToF32` in `toWgsl`, `gen-check` in wave 6, and integer seed
   derivation where needed.
3. **three.js internals** (`backend.get`, `ExternalTexture` with `is3DTexture`, the lazy canvas context) are not
   public API. All use is in `src/gpu/three.js` with a self-test; pin three at 0.186.1 for the PR.
4. **Visual drift** from hardware trilinear, f16 storage of light, y-down noise, the volume-first composition and the
   opaque canvas's gradient. All render-only; the Mac review of the regress sheets decides.
5. **SwiftShader is the only device here, and it schedules almost serially.** Races in the in-place move, list
   appends, deposits and marks can only show on a real GPU: I2.1's permutation knob narrows the gap, I4.0 closes it.
   Safari 26 is a target tested only by I4.8.
6. **Brick-granular sleeping is new code on the critical path.** skip-model at both unit sizes, I2.2 bit for bit and
   activity-check are the proof; `SLEEP_UNIT` gives a one-constant fallback to supertiles.

### K2. Open questions for the user
1. Is the volume-first composition acceptable (F1: a mesh behind glass with nothing behind it disappears)? The
   alternative splits three's scene into two renders. (The grid and edges keep today's order now.)
2. ~~Should `/legacy/` stay deployed?~~ Answered: no fallback at all (W5).
3. The giant volcano needs a 256 MiB storage binding (201 MB of state). Devices that allow less (the spec default,
   128 MiB, is common on Android) get it greyed out with the reason; every other scene and size runs. Acceptable?
4. Cross-build `load` hashes need `blankState` to use its own seeded PRNG instead of `Math.random` (tools-tests map
   7.7.5). U15 prepared it as a local branch against `main` (not pushed); merging it before the port merges makes
   I4.2 exact against the last WebGL2 commit (it re-baselines state-hash once). Merge it?

### K3. Phase 2 (after parity is pinned; each with its proof)
The user's rules for this list: an optimization lands when a Mac profile shows it matters and the change is simple;
a second code path (subgroups, `shader-f16`) has to be a clear win to earn its test burden. First in line:
- **D7 packed state, A/B'd in compute before committing** (the user's priority once parity is pinned). On WebGL2 it
  measured 8–10% slower per step (react's decode); in compute it may differ. It also halves the state's memory
  (69 → ~35 MB a copy at 128³, undo snapshots and window moves with it), which matters on phones. Ship it if it wins on
  time or on memory without losing the D7 statistics.
- **GPU-side diffs instead of whole-world snapshots**: the multiplayer host diffs 8.4 MB in JS at 10 Hz today; diff
  bricks on the GPU and read back only changed ones. No zero-copy access is needed for this (W6 stands).
- **Mesh-only frames.** When only three's meshes move (the default World scene's birds, with camera and sim still),
  keep the converged pre-mesh scene (colour and depth) and re-run only the mesh layer and post instead of the volume
  and far march at 60 Hz: the dominant power cost of the default scene. Render-only. Landed (`src/gfx/meshFrames.js`):
  a capture of the TAA settle count accumulates the uncut scene at output size, as TAAU reconstructs it, and later
  frames restore it at their jitter, three's meshes depth-tested over it (behind translucent water they are hidden
  rather than tinted: S1's cut only on full frames); the sim clock's animation holds meanwhile, as in deep idle.
- **Toroidal world windows** (x and z ring addressing in supertile units): a move rewrites only the entering slab,
  with no shift and no full derived rebuild. W10's index rule keeps it to `brickId`/`brickCoord`, `world/window.js` and
  the 3D-texture samplers (clamp the logical coordinate, then wrap with `repeat`). Not waking the whole grid after a
  move changes quiet-skip drift: decide then.
- **Compact id volume for the march**: ids packed 4 per `u32` in brick order, written where the derived pass knows
  bricks changed; the DDA's hot fetch drops from 16 B and ~15 integer operations to 1 B. Same for pick, shadow and the
  sign probe. Render-only.
- D7 packed state and packed flags; with it, `moveSrc`'s 3 bits move into the flow word's unused f16 lane (one buffer,
  one binding and 4 B per cell per step less on the Whitewater path).
- `shader-f16` paths for fields, light, GI, post and the volume's shading; subgroup reductions and ballot compaction.
- An Apple-only unrolled move variant, if the v1 form (D2) costs measurably on the Mac; it must pass I2 there.
- Compute raymarching with tile classification, mesh depth as `tMax` and RGB transmittance.
- A GPU brick pool for the world store (removes the readback gate on moves); incremental codec and world-model
  readback.
- TAA and prefilter fused; a maximum-size scene target with a viewport; reversed Z; blur x/y fusion if U4 didn't.
- If Dawn's `dump_shaders` shows override pipelines are pruned, fold the per-view modules back into `override VIEW`.

## Sync log (main merged into the port while it runs)

The user chose not to freeze `main` (no freeze, the port keeps up). At each wave boundary the orchestrator merges
`origin/main` into the port on a `webgpu/syncN` branch: a GPU file the port already rewrote keeps its WGSL side, and
`main`'s change to it (a diff from the last synced `main` commit) is re-applied by a delta-port unit, reviewed like any
unit. Files the port hasn't reached yet take `main`'s version, and their unit ports that. Every new unit branches from
the latest sync.

### Sync 2 (`main` 82157d5 → ff7ee51)
Delta-port units: **DP-A** (U1's files: elements, physics, electricity, materials), then **DP-B** (U2's: sim, move,
react, activity, passes' sim part, shaders/window, and the new `src/simModes.js`, `src/editing.js`'s paint side) and
**DP-C** (U3's: gfx/core, gfx/lighting, and the parts of far.js that live in farShared.js) in parallel. U4 and U5 were
running on the pre-sync base; their files' deltas (fields, passes' derived part, liquid, liquidDetail, plain, surface)
get a delta-port when they land. What else `main` brought, and where it goes:
- **S1. Meshes before the volume** (`src/gfx/meshCut.js`; supersedes W15's and F1's order, and answers K2.1). `main`
  now draws the opaque meshes first; the volume copies the depth they left and stops each ray there (`meshCutT`), so
  water in front of a body tints it instead of painting over it. WebGPU order per view frame: E1 compute → three renders
  the opaque meshes into the scene target (colour + depth) → our scene pass loads that colour, samples three's depth
  (a `texture_depth_2d` binding of the scene target's depth, never the attachment it writes), and marches each ray to it,
  writing premultiplied colour over and `frag_depth` = the nearer of its hit and the mesh → transparent meshes and
  overlays. U6 implements the volume side, U8 the order, U7's `post.render` hook order follows (meshes before draw).
- **S2. Simulation modes** (`src/simModes.js`: TPT's gravity mode (radial gravity turns each block into its pull's
  frame), air mode, ambient heat, edge mode wall / loop / void): uniforms of the move and react, ported in DP-B. With
  loop edges a block straddling an edge is reachable from both sides; the WebGL pass solved it twice harmlessly (each
  fragment wrote its own slot), but the in-place move must give it **exactly one owner** (D8.8), or two threads write
  the same cells.
- **S3. Decoration** (`src/deco.js`, `shaders/deco.js`, `shaders/gfx/deco.js`: TPT's dcolour, an RGBA8 colour per cell
  in a ping-pong pair that rides the move, survives element changes, is scrubbed when a cell empties or a writer gives
  it a new element). New unit **U17** after DP-B: a `u32` per cell per copy; the move permutes it with the block's cells
  (within the 8 storage-buffer budget, C4); its paint, undo, scrub, stage and edit kernels; the volume's drawing goes
  with U6.
- **S4.** The console's script write pass (`shaders/script.js`, `src/console/gpu.js`) and game saves
  (`src/saves/game.js`, a full-state readback like the codec): **U12**. Editing tools (`src/editing.js`: PROP, line,
  box) are brush writers: DP-B for the kernels, U6 for the cursor.
- **S5.** New three.js material users: the held tool (`src/pov/held.js`) → **U13**; the camera spring arm's GPU trace
  and readback (`src/pov/cameraArm.js`) → **U11**.
- **S6.** New world scenes in the shared GLSL subset (`world/scenes/descent/*`, `world/wang/*`) → **U10**.

### Sync 3 (`main` ff7ee51 → 5551bd7)
Delta-port units: **DP-E1** (the simulation: move pacing (`PACE`), diagonal moves and contact, `ORIFICE_CV`,
`REST_FLUX`, `inertNear`'s single exit, and the sim, passes and window deltas) and **DP-E2** (pours as a field jet,
liquid's thin-body segment, liquidDetail's spray, surface `kL`, cave ambient and fixed lamps, and the volume's
matching changes). `liquid.js` took the port's side by hand: git's auto-merge had put `main`'s GLSL into its WGSL.

### Sync 4 (`main` 5551bd7 → d9d07a6)
Delta-port units: **DP4-P** (the presentation layer) and **DP4-W** (Willow Cove, the jetpack, the deploy gate), in
parallel.
- **S7. Presentation effects** (`gfx/presentation*.js`: a gamemode picks an effect by name, `GAMEMODES.effect`; Animal
  Crossing's rolling log bends the shown world, physics stays flat). `main` patched three's materials with
  `onBeforeCompile`, which WebGPURenderer never runs. The port bends meshes through TSL instead: a bend chained onto each
  node material's clip position. The volume, the pick, the far view and the plain view get curved variants (the
  displayed ray walked as chords of its parabola), and TAA reprojects through unwarp and the last frame's warp, within
  `TaaParams`' 256 B. The mesh cut is off while curved, as in `main`. Boot, `openMap` and the menu warm-up select the
  mode's effect before the grid is built, so the curved variants compile behind the loading screen. Still unbent:
  remote cursors, the rays' sprites, the floor grid, the box edges and the brush shapes (a box only shows the last three
  when the effect is forced on it).
- **S8. Willow Cove** (`world/scenes/willowCove.js`) in the shared GLSL subset, converted by `toWgsl` like the other
  themed scenes. `game.start` regained the `try/finally` that `main`'s b72b890 dropped (a second match never started).
- **S9. The deploy gate.** `tools/check-sampler-budget.mjs` counted GLSL texture units (ANGLE's way) and crashed on
  WGSL. It now counts every `WGSL_CHECK` pipeline's per-stage bindings (sampled textures, samplers, storage textures,
  storage buffers, uniform buffers; external textures as 4 + 1 + 1) against WebGPU's limits, in Node with no GPU, and
  fails when it finds no pipeline at all. `check-shaders.mjs` and `sampler-count.mjs` are gone.
- **A port bug found by the sync's tests** (present since U13): disposing a `THREE.Sprite`'s geometry destroys the one
  quad every Sprite shares, and three r186's WebGPU backend keeps binding the destroyed buffer (it forgets the
  interleaved attribute, not its `InterleavedBuffer`). A world switch's perk-orb clear then stopped graphics at the next
  world's first orb. Nothing disposes a sprite's geometry now (`perkOrbs.js`, Descent's shop, the physgun's glow), and
  smoke's world stage draws the orbs after every switch.

## Review log

Three reviews of revision 1: **P** = performance per watt on Apple Silicon and tile-based GPUs, **S** = semantics
of the sim port, **X** = executability by porting agents. B = blocking, I = important, M = missing. "Adopted" means
the doc now says what the item asked, in the section named.

| Item | Decision | Where, and why |
|---|---|---|
| P-B1 brick-granular sleeping | Adopted | W12, D2–D5, I2.2, I4.5: skipping is exact at any even, aligned unit; supertiles were a fragment-path artefact. `SLEEP_UNIT` keeps supertiles one constant away; skip-model runs both |
| P-B2 256 MiB required limit | Adopted | B2, K2.3: spec defaults required; binding size requested up to the adapter's; the giant volcano is gated per scene, not per browser |
| P-I1 aeration over every cell | Adopted | G4, D3, I2.6: a brick list fed by react's `foams` word, dilated, with two steps of history; proven against the every-brick list |
| P-I2 post's 13 render passes | Adopted | W16, F7: 3 render + 1 compute pass; storage-written mips are separate textures |
| P-I3 three's extra pass and submit | Adopted | W1, W8, F1, B10: grid, edges, brush are ours; three skipped when nothing visible; overlay `depthReadOnly`; F1's grid deviation removed |
| P-I4 window-move cost | Adopted | E (window shifts), D6, G1, I2.9: derived shifted by bricks and re-aged at the slab and edges; no `syncCopies`; `forceAll` kept |
| P-I5 full inert scan every 2 steps | Adopted | D4, C3: incremental inert over DRAWN ∪ marked, dilated a brick; full rebuild after load/shift/forceAll/skipQuiet; workgroup-aggregated appends |
| P-I6 f16 field scratch | Adopted | E: `pack4x8unorm` where today is RGBA8, only read channels; boost 3–5 fused (exact); blur x/y fusion optional |
| P-I7 indirect validation dispatches | Adopted | B3 (stats count ×2), E and D1 (direct where CPU-known; counts stated) |
| P-I8 16-byte shadow taps | Adopted | E, F5, F6: `r32float` copy written in the same dispatch; PCSS reads it |
| P-I9 cold start | Adopted | W18, B5, F2: only the current mode at boot; per-view modules (not `override`); three `compileAsync`; `idle()` fallback; Mac checkpoints M1/M2 |
| P-I10 deep idle and view key | Adopted | A goal 3, F7, I5: rAF stops when settled; createViewKey in v1; settled scene judged in mW; birds named as the default scene's idle cost (K3) |
| P-I11 no container budget | Adopted | I1 `budget-check` + `tools/budgets/*`, J4; Mac harness page at M1 |
| P-I12 powerPreference, frames in flight | Adopted | B2, B3, W22: no `powerPreference` (opt-in `?gpu=high`); 1 frame in flight on WebKit; one command buffer when three has nothing |
| P-M toroidal windows | Deferred to K3 | It touches every render sampler and needs a drift decision; W10's rule (physical indices only via four functions, enforced) keeps it as cheap later as now |
| P-M compact id volume | Deferred to K3 | Render-only; described there |
| P-M opaque canvas | Adopted | F7, B10: sky gradient drawn in the composite; three's `alpha: false` matches |
| P-M pre-baked icons | Adopted | F8, U13: `tools/bake-icons.mjs`, committed atlas, CPU `--check` in CI |
| P-M rays overlay instances | Adopted | G3: compacted live list + `drawIndirect` |
| P-M mesh-only frames | Deferred to K3 | Render-only Phase 2, named as the default scene's dominant cost |
| P-M moveSrc in the flow word | Deferred to K3 | Needs D7's word layout |
| P-M MOVE dilation only at parity 1 | Adopted | D2, D4: `MOVE0 = DRAWN` |
| P-M one mark atomic per workgroup | Adopted | D6: brick-aligned edit workgroups |
| S-B1 u32→f32 rounding | Adopted | C5 `u32ToF32`/`i32ToF32`, D8.3, H1.28, G1 `toWgsl`, I1 tables-check |
| S-B2 unbounded DRAWN at one step per map | Adopted | D5.3 per-brick run counter; skip-model and I2.2 bounded case |
| S-I1 `rnd` pointer address space | Adopted | C5, H1.11: streams are function `var`s |
| S-I2 out-of-bounds writes | Adopted | C2, C5 (debug counter), D8.9, H1.29, I2.8 |
| S-I3 batching overlapping edits | Adopted | W13, D6, D7, G2: one dispatch per edit, in call order |
| S-I4 in-place shift kernels | Adopted | D8.12, E: every onShift kernel out of place; EMA in place only without a shift |
| S-I5 ParamRing growth mid-encoder | Adopted | W9, B4: fixed 1 MiB ring, flush when full; foundation check > 2048 dispatches |
| S-I6 age gate and carry order | Adopted | E (age pass keeps `uSteps`), D4 (carry note in `quiet` before overwrite, OR fold) |
| S-I7 skip-model scope | Adopted | D5: models the fused in-place move; negative controls listed |
| S-I8 order independence untested here | Adopted | C7 `sim.test` knobs, I2.1 |
| S-I9 variant pipelines on Apple | Adopted | D2 (one pipeline, a param), D8.11, E (`incremental=false` through the same kernels) |
| S-I10 readback timing | Adopted | B7: copy recorded at the request; in-pass results through rings |
| S-I11 write phase (heat guard, registers) | Adopted | D2: guard verbatim; own cells re-read in the write phase |
| S-I12 aeration bindings, `act` contents | Adopted | C1, C4: aeration halves in one buffer on `L.STATE_RO`; `act` contents listed; check-wgsl prints counts |
| S-I13 syncCopies forcing | Adopted | D6: exact copy of A, B and F (no forcing needed); no longer called after forceAll writes |
| S-I14 H1 inaccuracies | Adopted | H1.4, H1.24, H1.25 corrected from the Tint probe |
| S-I15 H2 template | Adopted | H2: three ping-pong groups plus the texture pass, header passed, folded dispatch |
| S-M (all) | Adopted | Each is covered by the S-B/S-I rows above |
| X-B1 deleted exports across waves | Adopted | W2, J3 (stubs, names kept, U16 renames once), J4 (`npm run build`, check-imports) |
| X-B2 SwiftShader compile limits | Adopted, with one change | W23, B5, D2, F2, I1 (check-wgsl a/b, `WGSL_MAC_ONLY`), `?view=plain`. The real react/move spike is U2's first deliverable, not U0's: it needs U1's prelude and tables; U0 delivers the timing tool, the synthetic curve and the crash cause |
| X-B3 app.js single owner vs later units | Adopted | J3 `src/wire/*`, J1 ownership; far snippets moved to `farShared.js` (U3, wave 1); `sim.attachRays`/`attachAeration` |
| X-B4 undefined shared bindings | Adopted | F6 `src/shaders/bindings.js` (U1, wave 0): FrameUniforms, L.LIGHTING numbers, writer variants, BrickInfo, brickDist |
| X-B5 correctness only on SwiftShader | Adopted | I4.0, I2.10 race probe, I3 `--real-gpu`, checkpoint M3 |
| X-I1 three replaces our error handler | Adopted | B9: `addEventListener`; three's `onError`/`onDeviceLost` forward; tested |
| X-I2 copies at end of encoder | Adopted | B7, D4, G4 |
| X-I3 detached canvas breaks call sites | Adopted, option (a) | W7, B10: three gets the visible canvas and sizes it; our presenter configures it with three's own parameters; debug assertion on default-target renders |
| X-I4 ExternalTexture repointing, unfilterable float | Adopted | B10, F8 |
| X-I5 ring growth, FrameUniforms timing | Adopted | B3, B4 |
| X-I6 redirect loop | Moot | No fallback and no redirect (W5, the user's decision) |
| X-I7 fallback adapters, per-map gating | Adopted | B2; I4.8 records Safari 26 and Chrome Mac limits (not measurable here) |
| X-I8 dispatch > 65,535 | Adopted | B5 `fold`, assertion in `dispatch`, check-wgsl (a) |
| X-I9 test sizes and runtime | Adopted | I1 budgets and stages, activity-check `--harness`, `?win=`, readMaps without `drawn` in I2.2 |
| X-I10 cross-build tools | Adopted | I4 `tools/page-gpu.mjs`, U14b owns state-hash and bench; blankState PRNG PR (K2.4, U15) |
| X-I11 missed awaits | Adopted | W6, I1 `check-async-reads`, J4; U14 split into U14a/U14b |
| X-I12 `__app.volume`, `__app.renderer` | Adopted | B10 (renderer methods); U8: `__app.volume` stays a three `Object3D` (the transform only) and `__app.view = { time, frame, detailShown }` replaces `volume.material.uniforms`/`defines` in tools |
| X-I13 Safari 26 | Adopted | I4.8; B5 `idle()` fallback |
| X-M owners for rays.js, bolt.js, lockfile, vite.config | Adopted | J1 (U12, U12, U0→U13, U0) |
| X-M deploy early | Adopted, then moot | U15 ran beside wave 0; its `/legacy/` build was removed when the user chose no fallback (W5) |
| X-M wave pairing | Adopted | J2: each GPU unit paired with a light one where dependencies allow |
| X-M GLSL ShaderMaterials at U8 | Adopted | I1 smoke allowlist until U13; brush moved to U6 (ours) |
| X-M walking skeleton | Adopted | U0 acceptance |
| X-M `gpuTextureOf` identity | Adopted | B10 |
| X-M LAN dev over http | Adopted | W5, G5 |
| X-M FrameUniforms on derived ticks, GI zeros | Adopted | B3, E |
