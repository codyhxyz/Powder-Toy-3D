# GPU startup safety

The original source-texture renderer increased native shader compilation work.
The browser can retain a failed graphics state after a tab reload.
An unavailable adapter alone does not prove a particular browser or driver fault.

## Protections

- Menu hover and idle time only prefetch files. They do not create GPU devices
  or compile shaders. Explicit diagnostic warm-up remains available to tools.
- Ordinary maps compile without source triangle, texture or lighting functions.
  Imported source maps retain the optimized original-art renderer.
- Our pipeline cache permits two active builds per device, across foreground
  and idle work. Three.js manages its own pipelines separately.
- Each active pipeline build has a 30-second deadline. This includes layout
  error-scope responses, but excludes queue time.
- The first fatal error rejects queued and pending builds, cancels idle jobs,
  prevents late completion from restarting work and releases our device.
  The game does not automatically request another device after startup failure.
- Optional source-map registration has a separate 10-second deadline. It aborts
  requests and prevents late registration after the menu is initialized.
- Startup after an explicit Start has a 45-second deadline. It ends when the
  first world and selected mode are ready, not when the app module downloads.
  Adapter waits, file downloads, renderer initialization and world setup are
  covered. Late completion cannot hide the error or resume the boot.

These deadlines bound our waits when browser JavaScript remains responsive.
They **cannot interrupt native driver compilation**, reset browser crash
protection or guarantee that another tab stays responsive during a driver fault.

## Safe restart

A startup failure offers **Restart with safe graphics**. This is an explicit
user action, not an automatic retry.

`?gpuSafe=1` disables source-art shaders, downloads and allocations before GPU
work starts. It also selects the Plain view, including mode-default selection.
The recovery link preserves the selected map and mode. It does not reduce
level dimensions, physics fixtures, collision or actor counts.

Example:

```text
https://tpt3d.codyh.xyz/?map=paradise&mode=crueltySquad&gpuSafe=1
```

Safe mode still needs a usable WebGPU adapter. It cannot bypass a browser GPU
block or recover a device that the browser refuses to provide.

## Verification

```sh
cargo install naga-cli --version 30.0.1 --locked
node --test tools/pipeline-safety-cpu-check.mjs
node --experimental-vm-modules --test tools/startup-safety-cpu-check.mjs
node --test tools/check-source-appearance.mjs
```

Tests use fake devices, controlled clocks and the actual entry-module source.
They cover stalled compilers, concurrency, cancellation, late results, cache
reuse, metadata waits, safe-mode shader generation and unchanged binding layouts.
Deployment installs and caches Naga 30.0.1. Native WGSL validation is required
for source and ordinary variants; it is not skipped when the tool is absent.

No GPU/browser tests were launched for these changes while the user used the
browser. CPU checks do not establish native compiler performance or stability.
