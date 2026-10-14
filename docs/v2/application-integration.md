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

## Dynamic persistence slice

`src/v2/dynamicState.js` exports:

- `captureNativeSnapshot(owner, mode) -> Promise<{core:Uint8Array,dynamic:object|undefined}>`: starts the existing core/aux/activity/args readbacks and the actual dynamics' four readbacks synchronously, before awaiting either owner.
- `encodeDynamicState(snapshot)` / `decodeDynamicState(bytes,{dims,origin})`: versioned raw-word section preserving every Uint32Array, including nested archived-air records and future owner extensions. Queued tool descriptors, sparse world events, clocks/controller metadata remain structured metadata. Origin must match the saved/current core window.
- `validateDynamicSnapshot(snapshot,{dims,origin})`: calls the actual dynamics validator with a dimension-derived grid, without requiring or mutating a live owner.
- `restoreNativeSnapshot(owner,snapshot)`: validates both sections and matching origin before either owner writes.
- `resetNativeDynamics(owner)`: full scene replacement resets dynamic obligations and anchors empty air at the new world origin; pending compilation blocks stepping, not generator fills.

`NativeDynamics` now exports its mechanically extracted `validateDynamicState(snapshot,g)`; live restore calls precisely the same validator. No simulation algorithm changed in this extraction. The dynamics lane must preserve any new physgun/controller field validation when extending it.

The strict `physicsV2Dynamics` save section is captured from the same batch as `physicsV2`. All sections validate before `app.prepare` or legacy/core mutation. New app saves mark `nativeDynamicsVersion:1`, preventing an omitted dynamics section from being silently accepted. Older saves intentionally clear dynamic state instead of reviving current particles. World attachment/reset fixes the initial air origin before native stepping.

Native undo queues the combined snapshot alongside existing GPU history copies. Same-origin undo waits for pending copies and restores native core/aux/activity/clocks plus all dynamic state. World entries also capture COW indices of immutable native/legacy/decorative retained brick payloads, copied planted columns and the world origin at the same epoch. If a previous leaving-slab readback is still landing, the world blocks further shifts until the history's store indices are captured; GPU core/dynamic copies are still queued immediately before the edit. The existing three-entry undo limit bounds retained versions; bytes are shared, not deeply cloned per entry.

Full world undo preflights core/dynamic/held-controller state and both store versions before mutation. It replaces the complete saved window and both retained stores, restores the saved origin before native GPU writes, then restores global particles/air/queued obligations. Post-snapshot deposits outside the old overlap are removed, so rewinding old flight particles cannot duplicate them. Decoration, planted columns, body/hover coordinates and far/derived fields follow the same restored origin. Pending outgoing readbacks are awaited before undo; failed validation preserves both the current world and the history entry. Legacy-format entries lacking the paired world history retain their prior overlap semantics; earlier incomplete native entries still reject a shifted restore explicitly.

Body acceleration now consumes `nativeBodyGravity` (the shared native Off/Vertical/Radial vector in cells/s²), rather than the separate legacy body calibration. Existing upright controls, buoyancy and Noita jet support remain. Native physgun hold uses the dynamics owner's default spring frequency; only fling converts legacy speed to m/s, and releasing the tool releases the native controller at the next safe recording boundary.

Additional CPU evidence: `node tools/v2/dynamic-persistence-check.mjs` constructs real PhysicsV2 with actual contactWGSL and NativeDynamics. It verifies eight synchronous readbacks, mixed matter/photon/neutron records, negative banks, air, queued rays, sparse events, archived air, actual save registrations, exact same-origin and full shifted-world undo, three-entry COW retention, deferred-store capture, physgun held/shock/controller fields, and pre-mutation corruption/origin rejection. No GPU was launched.

### Body pressure and lossless native coupling boundary

All native `Simulation.probe` calls now bind the dynamics owner's **current** ping-pong coarse air buffer in the existing B slot. Format3 `fetchB` samples that cell's4³ brick and returns velocity/reference-step and compatibility pressure using the actual gunpowder/acoustic-calibrated `LEGACY_PRESSURE_PA`; format2 renderer behavior remains unchanged. Body acceleration converts the compatibility gradient per cell to Pa/m, divides by the body's980kg/m³ density and integrates committed60Hz time before converting to cells/s. No additional storage binding or legacy pressure cache is involved.

`src/v2/body.js` routes the existing AABB body/cloud coupling to `dynamics.applyBodyCoupling({lo,hi,velocity,pushFluid,pushPowder,lift,ahead,only})`. Bounds are world cells; velocity and both push speeds are m/s; lift/ahead are direction shares. Body-authored velocity is normalized at the legacy tuning reference240Hz before conversion, never at the measured native60Hz. The dynamics lane owns the actual bodyPlan/allocator implementation; until that real hook is ready, the route explicitly returns false. It can **never** fall through to the legacy B-only edit (which would otherwise refill partial cells/reset banks while discarding the velocity). Tests cover both actual air-buffer selections, unchanged legacy probe routing, SI pressure/velocity factors, missing capability and allocation-refusal preservation at the real POV edit entrypoint. No GPU execution is claimed by the CPU mock.
