# Native application integration checkpoints

CPU checked; WebGPU, visual and parity/performance acceptance remain parent-owned. V1 remains the production default.

## Recovered integration slice

- The application constructs `PhysicsV2(sim, {contactWGSL, Dynamics: NativeDynamics})` when v2 is explicitly selected. `owner.nativeDynamics` remains the foundation's WGSL/bind-group adapter; application calls target **`owner.dynamics`**.
- World/POV readiness consumes `owner.contactReady`, actual `dynamics.isReady` and `dynamics.capabilities.physicsReady`. Ray tools additionally require `capabilities.drawReady`. No nonexistent `d.rays` interface or method-name-only readiness claim.
- The rays wire attaches `NativeParticles` to that actual instance, updates world-origin view coordinates and records `prepareDraw()` before the scene pass, then draws into the scene target. Detach disposes the presentation adapter before physics. Legacy v1 rays retain their existing path.
- `NativeIntegration.beginShift(dx,dz,commit)` awaits `dynamics.shiftWindow([dx,0,dz])` before the synchronous native core/bank + legacy cache + origin + entering-slab commit. `sim.nativeTransition` blocks native ticks, tools and external edits. World-wire coordinate notifications occur only after commit. World-coordinate particle records are not rebased by application code. Failed transitions halt further stepping/streaming rather than falling back to v1.
- `WorldWindow.shift` returns a promise for native worlds, remains synchronous for v1. `WorldWindow.update` correspondingly returns either a move, a promise of a move, or null. Direct native `sim.shift` requires a prepared transition; callers must use `beginShift` or the world window.

Evidence: `tools/v2/integration-check.mjs` uses the actual PhysicsV2 driver and foundation adapter with command-recording/coordinate reference mocks; it checks adapter identity, capability gates, asynchronous shift freezing, exact core/bank shifts, bounded host clocks, transfers and host/guest codec routing. This is not GPU execution. Native window/transfer shaders pass twelve Naga grid variants; native presentation has its independent nine-test CPU suite.

## Next slice

Dynamic persistence/undo must include live particles, air, queued requests, held/shock state, sparse pending events and archived air, with all snapshot copies queued synchronously alongside core/aux/activity. Dynamic validation must run before any core/legacy scene mutation. This remains an explicit required follow-up, not a completed snapshot claim.
