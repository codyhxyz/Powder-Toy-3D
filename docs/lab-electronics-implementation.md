# Electronics and spectacle: integration contract

This document records the implementation handoff.
See [Working lab electronics](lab-electronics.md) for the maintained feature guide.

Implementation approved by the user's request to dispatch parallel builders.
Task: `/Users/codyhergenroeder/code/claude/tpt-lab-electronics`.
Verified fetched base: `19118711a84aeabfe0d9e6e7688fa7641007c236`.

Use the existing native game-circuit model, not a replacement analog solver.
Inputs change physical contacts. They do not create electrical power.
The parent is the only writer in this worktree. Children return source proposals.
No child runs GPU tests, servers, other subagents, or deployment.

## Shared engine interface

- Append `E.BUTTON`: solid, normally open momentary electrical contact.
- Export `BUTTON_HOLD = 15` from `src/electricity.js`.
  Pressing sets its logical life to that value; it decreases each electrical step.
  Existing packed electrical life supports this without a save-format change.
- A button conducts only while pressed and only receives existing electrical offers.
  An unpowered press produces no spark.
- Existing `E.SWITCH` remains a maintained latch with unchanged P/N semantics.
- Append `E.CONTACTOR`: non-transmitting machine-input receiver.
- Export `CONTACTOR_HOLD = LAMP_HOLD` from `src/electricity.js`.
  A battery/live-conductor offer renews its life; otherwise it expires.
  This bridges the native spark gaps without making an unpowered latch a supply.
- Machine signal consumers recognize CONTACTOR life > 0.
  Preserve existing Factory control semantics for old devices.
- Physical controls use `createFactoryControlParts().activate({x,y,z,material})`.
  Extend the shared writer; do not implement map-owned state or a second circuit engine.
  Material validation occurs on the GPU when the mutation commits.
- Activation toggles SWITCH or presses BUTTON; unrelated cells are rejected.
- Shared input routing must cover use, melee, ballistic contact, god-view activation,
  host authority, save synchronization, stale scenes, and shifting world windows.

## Authored machine contract

Chapter builders keep the current `{box,set}` interface and return:

```js
{
  plaques, landmarks,
  devices: [{id,type,x,y,z,rotation,powered:true, ...nativeDeviceFields}],
  stations: [{id,at:[x,y,z],devices:['device-id'],label,initialOn:false,pulse:false}]
}
```

All positions are chapter-local. Parent translates to global coordinates.
Device IDs must be unique across chapters and valid native Industry IDs.
Stamp the actual native machine structure/deck, not decorative stand-ins.
Parent registers devices after generation and supplies shared station wiring.
Reserve a station space 8 cells wide, 6 high, and 4 deep around each `at`.
Reserve a wire column two cells left of each native control port to the ceiling.
The parent owns `src/lab/preservation/circuits.js` and scene registration.

Preserve the 80×50×108 chapter envelope, shared floors/roof and inter-chapter gates.
Keep named existing route landmarks reachable, including reservoir escape stairs.
Every primary specimen plaque remains unique; infrastructure can reuse materials.
No automatic restoration of destroyed matter or hidden temperature/lifetime clamps.

## Spectacles

1. Public power gallery: visible light pulses and a finite grain-sorting installation.
2. Waterworks: a tall pumped cascade with visible finite reservoirs and real return flow.
3. Foundry: material transport, finite fuel/real heating, visible melt and quench effects.
4. Reaction bay: physically initiated finite reaction behind observation geometry.
5. Shared control stations: functional switch/button, actual downstream ENABLE lamp.

Parent will integrate geometry, registration, power routing, tests, and reviews.
The initial implementation does not claim full refrigerant-cycle or analog electrical simulation.
