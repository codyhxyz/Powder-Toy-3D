# Electronics-operated lab: proposed direction

Historical design proposal. The first implementation follows option A.
See [Working lab electronics](lab-electronics.md) for current behavior and limits.
Inspected base: `19118711a84aeabfe0d9e6e7688fa7641007c236`.

## User requirement

The lab must run through physical electronics.
Buttons, indicators, wires, and machine inputs must use simulation state.
Map scripts must not substitute for circuits or their physical consequences.
Controls must also work outside Preservation.

## Decision: how much electrical realism?

### A. Extend the current game-circuit model — recommended first

Keep the native Powder Toy-style pulse automaton.
Add physical momentary contacts and reusable activation.
Use existing latches, conductors, and lamps where their semantics fit.
Separate machine commands from a supply-dependent operating permit.

This is functional electronics, but not an analog circuit solver.
It does not establish Kirchhoff-law currents, battery discharge, or load-dependent voltage.
Those behaviors must not be claimed merely because a wire glows.

### B. Introduce analog electrical networks

Use a proven modified-nodal-analysis approach, as Electrical Age and CircuitJS do.
This can model terminal voltages, currents, resistance, and time-dependent components.
It requires a circuit topology representation and explicit component terminals.

The published implementations establish the method, not its performance in this engine.
Moving conductive liquids, broken wires, streaming worlds, and GPU ownership require separate prototypes.
Existing pulse circuits need an explicit compatibility policy.

## Existing foundations

- `src/v2/contact.js`: native electrical rules, emitted into WGSL.
- `src/v2/electric.js`: CPU twin with synchronous gather and commit.
- `src/electricity.js`: signal timing, conductivity, switch and lamp constants.
- `src/industry/controlParts.js`: real native switch mutations.
- `src/industry/physics.js`: conserved liquid transfer through pumps.
- `src/shaders/industry.js`: machine control-port interpretation.
- `src/pov/importedInteractions.js`: window-held mutation transactions.

The electrical CPU suite passes all 12 existing checks:

```sh
node tools/v2/electric-check.mjs
```

No GPU run was used for this investigation.

## Gaps that cannot be papered over

1. Switches and powered clones are latches.
   Removing a control signal does not reset their memory.
2. A machine currently accepts an ON switch as an enable.
   This does not independently prove a connected electrical supply.
3. Live sparks are intermittent.
   They cannot be treated as a stable motor-enable signal without defined timing.
4. Lamps have afterglow; battery-adjacent lamps use a special direct-supply state.
   An indicator must read its downstream circuit, not a UI toggle.
5. A button is a contact, not an ideal battery.
   Pressing an unpowered button must not create electrical power.
6. Existing physical-use interactions are disabled in co-op.
   Activation needs host-authoritative validation, not replica mutation.
7. Existing control-part writes do not hold the streaming world's window.
   Reuse the established world-coordinate transaction pattern.
8. Melee and projectile contacts need explicit activation ordering.
   An audiovisual impact notification is not an authoritative control event.

## First complete playable milestone

Build one visible, finite-water transfer loop in Preservation:

```text
Supply → physical Start/Stop controls → relay/operating permit
                                      ├→ ENABLE indicator
                                      └→ pump → elevated receiving basin
```

- A momentary button and a maintained switch have distinct behavior.
- Pressing, striking, or shooting a control uses the shared cell-action path.
- Exact target, reach/contact, map identity, and duplicate actions are checked.
- Control state belongs to the material; no JS registry owns circuit truth.
- A supply interruption prevents new pump intake.
- A blocked outlet conserves retained liquid.
- The ENABLE lamp does not claim that water is actually flowing.
- Previously stored heat and liquid momentum remain after shutdown.
- Save/load, undo, co-op, and window shifts preserve the same behavior.
- The same components are available in other maps, not just the authored lab.

This is a proposed milestone, not a description of completed functionality.

## Acceptance tests

- Unpowered press: no electrical output or machine intake.
- Start, stop, repeated hits, and held input: defined, reproducible behavior.
- Power removed while commanded ON: permit expires without resetting latch memory.
- Cut wire: downstream signal stops according to the declared timing.
- Lamp state follows its circuit, including documented afterglow.
- Pump reservoir, receiver, and retained cargo conserve material.
- Broken control or machine base: no invisible fallback activation.
- Stale action after scene replacement: rejected.
- Window movement during queued activation: cannot target another cell.
- Guest activation: host validates and commits once.
- Native CPU/GPU agreement and all-view indicator rendering.

## References and adaptation limits

- [The Powder Toy: SWCH implementation](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/SWCH.cpp)
  establishes persistent switch state and separate set/reset signals.
  Our six-face 3D topology is an existing adaptation, not TPT's original stencil.
- [The Powder Toy: SPRK implementation](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/SPRK.cpp)
  establishes conductor-specific signal propagation.
  It is not evidence of an analog voltage solver.
- [Electrical Age: modified nodal analysis](https://github.com/age-series/ElectricalAge/wiki/Modified-Nodal-Analysis)
  documents an established analog approach in a voxel game.
- [Electrical Age: subsystem implementation](https://github.com/age-series/ElectricalAge/blob/master/src/main/java/mods/eln/sim/mna/SubSystem.java)
  provides working source for topology invalidation and subsystem solves.
- [CircuitJS internals](https://github.com/sharpie7/circuitjs1/blob/master/INTERNALS.md)
  describes circuit matrix assembly and time-dependent components.

These are behavioral and architectural references, not a proposal to copy their code without license review.
