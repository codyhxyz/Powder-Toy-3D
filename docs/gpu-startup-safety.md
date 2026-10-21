# GPU startup safety

The original source-texture renderer increased native shader compilation work.
The browser can retain a failed graphics state after a tab reload.
An unavailable adapter alone does not prove a particular browser or driver fault.

## Protections

- Menu hover and idle time only prefetch files. They do not create GPU devices
  or compile shaders. Explicit diagnostic warm-up remains available to tools.
- Ordinary maps compile without source triangle, texture or lighting functions.
  Imported source maps retain the optimized original-art renderer.
- Our pipeline cache permits a bounded number of active builds per device,
  across foreground and idle work: the logical cores less four, at least two
  and at most eight (`pipelineConcurrency`, src/gpu/kernels.js). The user chose
  speed on 2026-10-20 ("MAKE IT LOAD FAST"): until then it was always two, and
  Metal's compiles scale almost linearly with cores. A machine with six cores
  or fewer keeps two. Three.js manages its own pipelines separately.
- Each active pipeline build has a 30-second deadline. This includes layout
  error-scope responses, but excludes queue time.
- The first fatal error rejects queued and pending builds, cancels idle jobs,
  prevents late completion from restarting work and releases our device.
  The game does not automatically request another device after startup failure.
- Optional source-map registration has a separate 10-second deadline. It aborts
  requests and prevents late registration after the menu is initialized.

These deadlines bound our waits when browser JavaScript remains responsive.
They **cannot interrupt native driver compilation**, reset browser crash
protection or guarantee that another tab stays responsive during a driver fault.

## Startup behavior

There is no overall startup deadline or alternate safe-graphics mode.
The game uses the selected view and the normal map and mode defaults.
An elapsed 45 seconds alone does not abort a healthy startup.
Actual graphics failures still stop queued builds and show their cause.
Late completion cannot hide a fatal startup error or resume failed work.

## Verification

```sh
cargo install naga-cli --version 30.0.1 --locked
node --test tools/pipeline-safety-cpu-check.mjs
node --experimental-vm-modules --test tools/startup-safety-cpu-check.mjs
node --test tools/check-source-appearance.mjs
```

Tests use fake devices, controlled clocks and the actual entry-module source.
They cover stalled compilers, concurrency, cancellation, late results, cache
reuse, metadata waits, ordinary/source shader selection and unchanged binding layouts.
Deployment installs and caches Naga 30.0.1. Native WGSL validation is required
for source and ordinary variants; it is not skipped when the tool is absent.

No GPU/browser tests were launched for these changes while the user used the
browser. CPU checks do not establish native compiler performance or stability.
