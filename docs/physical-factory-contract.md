# Physical factory implementation contract

This contract defines the approved implementation, not existing behavior.
The parent integrates all feature modules into the current Industry controller.

## Shared rules

- Preserve the existing `heater` type and its saved behavior.
- Add a separate `hearth` type for finite-fuel industrial heat.
- Add a `gate` type for a physical shutter.
- Keep old saves and Sandbox spark controls working.
- Do not change global coal chemistry, steel melting points, or existing electronics.
- Use existing credits for construction and control parts.
- Never overwrite foreign material or count unconfirmed GPU work as success.
- Do not introduce item inventories, recipe menus, or another E handler.
- Cite the relevant Minecraft, TPT, or Sandustry rule in new behavior comments.

## Work ownership

The first implementation wave adds independent modules.
Agents do not change shared integration files in this wave.

| Lane | Owned files |
| --- | --- |
| Thermal | `src/industry/hearth.js`, `src/shaders/hearth.js`, new hearth-specific tests |
| Gates and controls | `src/industry/gates.js`, `src/industry/controlParts.js`, new gate/control-specific shaders and tests |
| Diagnostics | `src/industry/diagnostics.js`, new diagnostic-specific shaders and tests |
| Parent/integration | Catalog, validation, controller, existing physics/shader, progression, view, icons, documentation, deployment workflow |

Each implementation lane commits only its owned files.
Each agent returns its commit, exact exports, validation results, and unresolved requirements.
The parent integrates modules after that wave.

## Hearth

The new `hearth` shares the heater's four-cell footprint and working region.
It has a tungsten base and ordinary physical fuel and charge cells.
It does not change the behavior of the legacy `heater`.

`src/industry/hearth.js` exports documented constants and pure geometry/budget helpers.
`src/shaders/hearth.js` exports WGSL helpers compatible with the existing Industry edit kernel.
The Industry shader will call a hearth-specific update after its existing base/control guard.
New uniform fields must be listed explicitly in the handoff.

The industrial heat rule is an abstraction, not a claim about ordinary coal combustion.
Finite physical fuel consumption must bound the total added heat.
Residual hot walls can continue transferring stored heat after the fuel expires.
An empty or disabled hearth must not create heat.
The device must ignite real fuel without requiring free Sandbox spawning.
The charge still melts and cools through native phase-change rules.
Do not directly convert scrap to molten metal.

The agent defines an explicit fuel region, charge region, and safe output direction.
The geometry must be buildable with existing refractory blocks.
Fuel cells retain authoritative temperature and remaining life in terrain saves.
No hidden fuel counters are approved.

## Physical gate

Use a shutter inside a reserved four-cell footprint.
Define one rotated aperture and its exact ownership marker.
The marker must not alter the native behavior of its material.
The approved aperture is local x=0..3, y=1..3, z=2 inside a 4×4×4 reservation.
The approved marker is `WALL` with `a.z = 1048573`.
Ownership also requires the exact registered shutter coordinates.
Opening preserves the seed and removes only cells with both the correct material and marker.
Native movement, reaction, rest, and save paths must preserve this marker.

Export `createGatePhysics({getSim, onError, onState})`.
Provide `ready`, `step(dt, devices)`, `remove(device)`, `pending`, `status(id)`, `reset()`, and `dispose()`.
Document any additional pure geometry or validation helpers.

Device fields are `gateMode: 'open' | 'closed' | 'signal'` and `gateClosed: boolean`.
The default for a newly placed gate is open.
The controller saves desired mode and last confirmed physical closure.
`onState(id, result)` reports confirmed changes to the controller.
Pending transitions prevent a save or removal race.

In signal mode, the existing real control port commands open while energized.
Without a signal, the gate requests closure.
A blocked closure leaves the gate open.
A damaged owned shutter reports damage and does not silently regenerate.
Opening and removal erase only the gate's tagged material.
No gate operation stores grains or liquids outside the simulation.
All transitions are atomic and bounded.

## Factory control parts

Use real existing materials: switches, temperature sensors, batteries, and required conductors or insulation.
Keep placement separate from the unrestricted Sandbox element dock.
Parts occupy actual cells and can burn, melt, or otherwise react normally.

Export the allowed part descriptions and pure specification validation from `controlParts.js`.
Export `createFactoryControlParts({getSim})` with `place(spec)`, `toggle(spec)`, `pending`, and `dispose()`.
The parent handles credits before or after confirmed placement, with rollback on failure.
The GPU backend never charges credits.
Placement succeeds only in an empty cell.
Toggling operates only on a real switch at the requested position.
Temperature-sensor configuration must use the native threshold convention.
TSNS thresholds use `PHYS.CELL_TEMP_MIN` through `PHYS.CELL_TEMP_MAX`, currently −273.15°C through 10000°C.
The default threshold is 200°C.
Other parts reject threshold fields.

Approved part prices are TSNS 3 credits, SWITCH 2 credits, and BATTERY 5 credits.
METAL, PSCN, NSCN, and INSULATOR each cost 1 credit.
These are construction prices, not stored electrical energy.

The controller persists consumed credit expenditure as `partsSpent`.
Old saves default to zero.
Part purchases are irreversible because their material can change through ordinary physics.
The interface must state this policy.
No refund can duplicate matter or money.

## Diagnostics

Export `createIndustryDiagnostics({getSim})`.
Provide `inspect(device)`, `snapshot(device)`, `pending`, `reset()`, and `dispose()`.
`inspect` returns the bounded asynchronous observation.
`snapshot` returns cached data or an explicit unknown/pending state.
Export pure presentation/status helpers for CPU tests.

Inspect only the currently selected or hovered machine.
Keep at most one observation in flight.
Throttle observations and invalidate stale results after device or simulation changes.
Use a compact GPU result, not `sim.readState()` or full-grid CPU scans.
Reuse base, port, and material semantics from existing Industry code.
Do not report a plausible guess as confirmed throughput.
Use `ready`, `empty inlet`, `outlet occupied`, `control off`, `base damaged`, and `unknown` as appropriate.
Gate-specific feedback comes from confirmed gate transitions.
Hearth fuel and temperature feedback uses the documented hearth regions.

## Integration and acceptance

The integration lane adds palette entries, models, icons, inspection controls, ports, and visible operating guidance.
It retains existing typography, camera input, placement behavior, and the Factory-only builder.
It adds migrations for new catalog ownership keys and optional fields.
It does not insert starter machines into an unrelated or old saved scene.

CPU tests cover logic, bounds, state transitions, migrations, and economy.
GPU tests cover atomic material operations and actual shader behavior.
An end-to-end fixture covers physical fuel, scrap, melt, cooling, and confirmed shipment.
The report must distinguish module tests from a complete production-line test.

No first-wave implementation agent starts a browser.
The parent schedules GPU validation after integration.
Each slot includes startup, compilation, assertions, and cleanup within ten seconds.
If a required fixture cannot fit, report that limitation before changing its scope.
