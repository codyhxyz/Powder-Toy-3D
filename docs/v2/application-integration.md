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

Native undo queues the combined snapshot alongside existing GPU history copies. Same-origin undo waits for pending copies and restores native core/aux/activity/clocks plus all dynamic state. Corrupt snapshots reject before mutation. **Intermediate safety gate approved by parent:** shifted undo with dynamic history explicitly rejects and preserves the history entry; restoring old global particles into only partially rewound world material would duplicate deposited matter. Completing shifted undo still requires a matching world-history owner: versioned/copy-on-write native and legacy retained stores, planted columns, origin/window residency and archived-air/global dynamic state captured at one epoch. That is not claimed complete by this checkpoint.

Additional CPU evidence: `node tools/v2/dynamic-persistence-check.mjs` constructs real PhysicsV2 with actual contactWGSL and NativeDynamics. It verifies eight synchronous readbacks, mixed matter/photon/neutron records, negative banks, air, queued rays, sparse events, archived air, actual save registrations, exact same-origin undo and pre-mutation corruption/origin rejection. No GPU was launched.
