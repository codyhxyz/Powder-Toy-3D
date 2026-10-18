# Native startup preparation

`Simulation` defaults to eager legacy startup (`nativeStartup: false`). Native
app hosts (`?physics=v2`, excluding guests) and the v2 outcome adapter opt into
`nativeStartup: true`. Only the eight legacy stepping/activity kernels
`move`, `react`, `inertList`, `inert`, `quiet`, `drawn`, `move1`, and `args`
use `build: 'manual'` and are excluded from the initial `sim.ready` wait.

Initial blank-state loading, editing, import/bridge support and other startup
passes remain required. Native pipelines, heat, reactions, dynamics and physics
are not deferred or removed. This saves pipeline builds, not shader-source
construction or buffer allocation; no timing improvement is claimed here.

Call `await sim.prepareLegacy()` before activating legacy stepping. It starts
all eight builds and awaits them plus initial simulation readiness. An
unprepared legacy `sim.step()` throws; an active native owner still steps
normally. Preparation failures reject and leave legacy stepping disabled.

The app's `setPhysics('v1')` retains the published native mode until preparation
succeeds, including when loading a persisted legacy mode. If the map changes
while preparation is pending, the replacement simulation is prepared before
publishing v1. Default legacy and render-only guest startup stay eager.

CPU regression: `node tools/v2/native-startup-check.mjs`. It instantiates the
real `Simulation` and `Kernel` with controllable mock pipeline promises, checks
initial loading, exactly eight deferred builds, delayed/failed activation,
unchanged v1 readiness, and map replacement. It executes the actual app switch
method with injected state. Commands are recorded, not executed as WGSL; no
browser or GPU evidence is provided by this test. The PhysicsV2 initialization
readiness regression is a separate change and must be integrated alongside this
startup optimization.
