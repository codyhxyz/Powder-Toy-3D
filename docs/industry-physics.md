# Industry physics API

`createIndustryPhysics({getSim, onShip, onError})` returns:

- `ready`: promise for the current simulation's industry/transfer pipelines.
- `step(dt, devices)`: call only during actual simulation advancement.
- `pending`: number of in-flight GPU transactions, including reserved takes and
  unconfirmed puts. Buffered cargo alone does **not** make a transaction pending.
- `buffered`: number of owned cargo cells currently held outside the terrain.
  Cells already submitted by a put are excluded; that transaction is pending.
- `toJSON()`: synchronous, deep-owned snapshot; throws while pending, after
  disposal, or if the simulation changed without rebinding.
- `fromJSON(data, devices)`: validates everything, then replaces the owned pump
  loads. Throws while pending or after disposal. It never writes/clears terrain.
- `reset()`: discard old-world state, for world replacement only.
- `dispose()`: release ownership permanently.

## Coordinated terrain/cargo saves

Pause machine stepping, wait for `pending === 0`, and capture the terrain,
construction/progression state, and `physics.toJSON()` together. Do not reset or
force a running/blocked pump to drain: its owned liquid can be saved directly.
On load, prevalidate all sections before mutating the world, restore the matching
terrain, then call `physics.fromJSON(snapshot, validatedDevices)`. Resume only
when ready. A cargo snapshot without its matching terrain is not a complete save.

Snapshot format:

```json
{
  "version": 1,
  "pumps": [
    {
      "id": "pump-1",
      "device": {"id":"pump-1","type":"pump","x":24,"y":8,"z":32,"rotation":0},
      "cells": [[7, 20, 0, 0.125]]
    }
  ]
}
```

Each cell is `[elementId, temperatureC, life, ctypeAndSeed]`; its element must be
an existing liquid. Only nonempty loads appear. `device` includes permitted
optional `filter`/`powered` values. Dismantled pumps are included until their
cargo spills; their retained geometry provides the spill location.

`validateIndustryPhysics(data, devices, bounds?)` throws on invalid input and returns a
deep-owned canonical snapshot otherwise. It accepts at most 128 unique pump
IDs (including orphan IDs) and 16 cells/load. IDs contain 1–64 letters, digits,
underscores or hyphens; new placements use UUIDs. Coordinates are nonnegative
integers with the entire device footprint inside `bounds` (`{nx, ny, nz}`),
defaulting to a 4096³ envelope. Save preflight supplies the header dimensions;
`fromJSON` supplies the actual grid dimensions before replacing any loads.
Cell state must be finite and representable as finite f32 values. If a saved id
is present in `devices`, its type/position/orientation must match exactly. If
absent, it is detached cargo and spills without a machine/base/control guard on
subsequent advancing steps. Neither validation nor restoration modifies callers'
objects, terrain, or the simulation clock.

Cargo uses the existing exact-transfer Load: it retains its captured temperature
without heat exchange while buffered. Shipping accepts metal at **400°C or below**;
this limit is tested atomically with removal, not from a stale CPU temperature.
