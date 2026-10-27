# Working lab electronics

This is the first machine-control release, not the complete machinery roadmap.
Circuits use the existing TPT-style pulse simulation.
They do not simulate analog voltage, load current, battery discharge, or motor efficiency.

## Use the controls

Load a fresh `/?map=preservationLab`.
Saved snapshots keep their old terrain and machines.

Aim at an exposed BUTTON or SWITCH and press **E**.
First-person use has normal hand reach.
God-view use follows the pointer.
Strikes also activate controls before their normal impact damage.
A strong impact can break the component.

- **BUTTON:** closes briefly. It passes an existing supply; pressing it creates no electricity.
- **SWITCH:** maintains its mechanical ON/OFF state.
- **CONTACTOR:** enables a machine while native supply pulses arrive at its input.
- **LAMP:** reports the signal at its own position, with native afterglow.

The lamp does not measure water flow or prove that a machine is safe.
The Start/Stop cabinet uses PSCN and NSCN to set and reset a native SWITCH.
Stop wins when both commands arrive together.
Its drive battery is separate from the two control supplies.
An ON command cannot replace a missing drive supply.

## Installations

| Installation | Actual mechanism |
| --- | --- |
| Light wave | A powered momentary contact sends travelling sparks to ceiling lamps. |
| Sorting tower | A finite sand/gold charge crosses native decks and a separator. Both bins retain material. |
| Gold casting | Conveyors feed cold nuggets to a coal hearth. Native heat melts gold; cooling can leave physical deposits. |
| Water lift | Eight registered pumps move existing water upward. Gravity returns it to the finite lake. |
| Reaction bay | A coal hearth heats a finite thermite charge. No timer triggers its reaction. |

OFF stops powered actuation. It does not stop gravity, extinguish burning fuel, or reverse a hot reaction.
These installations are not blast-proof or validated long-term containment.
The ice exhibit remains passive and unrefrigerated.
Compressors, refrigerant loops, energy-accounted heat pumps, and analog circuits remain future work.

## Shared implementation

- `src/electricity.js` defines contact timing and conduction rules.
- `src/v2/contact.js` supplies the native CPU/GPU electrical rules.
- `src/pov/electronicsInteractions.js` owns physical activation and transaction fences.
- `src/net/controlActivation.js` validates remote control intents.
- `src/industry/signal.js` supplies the shared machine-input rule.
- `src/lab/preservation/circuits.js` stamps ordinary circuit materials during generation only.

There is no runtime map callback that turns these machines on.
Breaking a wire changes the native circuit.
Control writes preserve unrelated cell state.
Saves carry native contact timers and switch states without a new save format.
Pending contacts are fenced across scene changes, undo, disposal, and World-window movement.
Co-op guests send validated intents; the host owns terrain mutation.

Generic electrical elements and controls work in box and streamed maps.
Registered Industry actors keep their existing finite-map support restriction.
This release does not add streamed-world actor registration or expand Factory purchase permissions.

### Read-only machine evidence

`await __app.industry.observe(deviceId)` returns a bounded native observation.
Unknown or unavailable registrations return `null`.
`transferHistory` contains an actual confirmed transfer, not an estimate from the ON command.
`running: 'confirmed-transfer-observed'` means a transfer was observed; it is not a continuous-flow measurement.
Check the observation time, present control state, and material regions separately.

Native hearths commit fuel and heat together in integer energy units.
Their capacity and heat bank are included.
A fuel debit too small to represent cannot grant heat.
Per-call quantization can discard fractional rate allowance; this is not an exact continuous-rate model.
The paid starter can overshoot its minimum ignition target, but cannot exceed the hearth's heat ceiling.
Legacy V1 hearth behavior is unchanged.

## Checks

CPU and shader validation:

```sh
npm run check:electronics
npm run check:lab
node --js-float16array tools/v2/native-hearth-check.mjs
node tools/lab-electronics-browser-check.mjs --thermal --preflight
```

Node 22 needs its Float16Array flag for the native-hearth tool.
These tests do not execute GPU shaders or establish long-term containment.

After checking `node tools/gpu-log.mjs`, run each browser command in its own 25-second-total slot:

```sh
node tools/lab-electronics-browser-check.mjs
node tools/lab-electronics-browser-check.mjs --thermal --screenshot
node tools/preservation-browser-check.mjs --ui-only --controls --port 54989
```

The first checks real E input, contact release, pump transfers, drive-supply removal, and Stop.
The second checks actual sorting and hot products without placing products or forcing heat.
Both use the full map and production native callbacks.
The manual driver flushes asynchronous GPU transfers between batches.
Casting checks read the flying-matter owner as well as the voxel grid.
The hand-use check uses the existing headless pointer-lock shim, but sends real keyboard input.

### Recorded local evidence

On Apple M5, separate full-map checks verified:

- Native light pulse, eight pump transfers, high-outlet water, drive-battery removal, and Stop: 11.36 seconds total GPU occupancy.
- First-person E, indoor entry, and material inspection: 6.79 seconds total.
- Gold casting: a real airborne molten packet carrying GOLD identity, with cold starting charge and remaining fuel: 9.22 seconds total.
- Real grains in both sorter bins and lava in the thermite bay: observed in the bounded thermal run.

These establish the observed behaviors, not complete charge processing or indefinite operation.
Co-op protocol and transaction checks are CPU integration tests; a new live WebSocket session was not exercised.
