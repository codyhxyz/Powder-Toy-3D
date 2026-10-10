# Vehicles: a jeep and a hoverbike (Big Team Battle)

Halo's Big Team Battle in the falling-sand world: a Warthog-style **jeep** and a drifty **hoverbike**,
rigid bodies in [Rapier](https://rapier.rs) (`@dimforge/rapier3d-compat`, pinned at 0.21.0) that drive on
the sim's own cells. Code: `src/pov/vehicles/`. Boxes only for now (not World's moving window).

## Playing

- **Get one**: the palette's Entities group has **Jeep pad** and **Hoverbike pad** (spawners.js). Click open
  ground; in first person a vehicle waits there, and a new one comes 8 s after it's destroyed (a wreck on the
  pad is cleared away). An arena places its own with `spawnLayout` (below).
- **E** near a vehicle (within 1.8 m of its hull): get in. **E** again: get out, set down beside the driver's
  door (else the other side, behind, in front, on top, wherever the body fits). You keep its momentum.
  **E** at an overturned vehicle rights it (Halo's flip).
- **Driving**: W/S throttle (S brakes first, then reverses), A/D steer, **Space** handbrake (jeep: the rear
  wheels lock and the tail swings out) or hop (hoverbike), **Shift** boost (the hoverbike's tank lasts 3 s).
  The mouse orbits Halo's third-person chase camera; when it rests 1.2 s the camera swings back behind.
  Tools are put away while you drive; the HUD shows the vehicle's health, speed and boost.
- **Running people over** hurts them from 3 m/s and kills at 10 m/s (Halo's splatter), never your own team
  (`target.team` vs the driver's `player.team`, else the vehicle's team).
- **Damage**: gun rounds and melee hit the hull (it's a `targets.js` target), blasts hurt and shove it, hot
  cells (lava, fire, a torch's mark) burn it. At 0 health it **explodes**: its tank becomes a gunpowder
  charge with a detonator (the bomb's own mechanism, so the blast is the engine's), and it leaves a charred
  **burning wreck** that puffs FIRE cells into the sim for 14 s and is cleared after 24 s. A driver inside
  is thrown out and hurt.

## How it works

| Part | How | Where |
|---|---|---|
| Rigid bodies | Rapier in metres/kg/s, fixed 1/60 s steps (≤ 4 a frame), stepped in the POV frame loop | `physics.js` |
| What the hulls hit | one **Voxels** collider (Rapier ≥ 0.19's sparse voxel shape): voxel (x, y, z) at size 0.30 m is exactly cell (x, y, z). Solids and powders are voxels, liquids aren't. Only a region (48 × 28 × 48 cells) around each vehicle is filled, from the CPU copy of the cells (`ai/world.js`: the multiplayer packer's readback, ≤ 0.5 s old); each refresh toggles only the cells that changed (`setVoxel`), so a dug pit or a new wall shows up within half a second. The box's walls and floor are voxels too. | `physics.js` |
| What the wheels see | **not** the voxels: a raycast wheel sees only the ground straight under its axle, so the grid's 0.3 m risers are walls it bottoms out on. Each vehicle gets a heightfield (40 × 40 cells around it) of the column tops **dilated by the tyre's circle** (a rigid wheel of radius r touches a step's edge √(r² − (r − h)²) ahead of its axle); a step higher than r is a wall, left to the voxels. It collides with nothing; only that vehicle's rays query it. The jeep climbs 27° stairs this way; before, it stopped dead at 18°. | `physics.js` `buildGround` |
| Jeep | Rapier's `DynamicRayCastVehicleController` (Bullet's btRaycastVehicle port), 4 wheels, 4WD | `jeep.js` |
| Hoverbike | four ray springs (spring–damper, 1.6 Hz, ζ 0.45) on the same kind of heightfield, whose tops include liquids': it skims lakes. Yaw rate steering, thrust along the nose, low sideways grip (3 /s, 2 /s boosting): hard turns at speed drift ~30–40° | `hoverbike.js` |
| Matter | hull sample points: Archimedes in liquids (ρ = elements.js dens × 100 kg/m³: a jeep wades in water and floats on lava), quadratic drag in them (C_d 1.05, a cube's), heat damage above 300 °C; under each wheel, rolling resistance and grip by surface | `matter.js`, `jeep.js` |
| Look | chunky primitives lit like the Castle Crashers wizard (`figure.js` `figureFrag` with `FIG_TOON`: the volume's sun, shadows, GI) with black inverted-hull outlines; team stripe red/blue; a seated wizard drives | `look.js`, `jeep.js`, `hoverbike.js` |
| Spawning, seats, run-overs, blasts, wrecks, HUD | | `index.js`, `vehicles.css` |

### Tuning, and where it comes from

Every number is a named constant with its source in the file. The main ones:

- **Jeep** (`jeep.js`): the M12 Warthog's size and mass (4.5 m, ~3 t). Suspension from Kester Maddock's
  *Vehicle Simulation With Bullet*: stiffness 10 (his off-road buggy), damping 0.2 / 0.3 of critical
  (2k·√stiffness), on 0.6 m rest and 0.5 m travel (Halo's floaty long travel). Grip μ 1.6 (forgiving, above a
  real tyre's ~1), 0.55 of it on powder. Rolling resistance 0.015 on rock (car tyre on concrete) and 0.3 on
  powder (car tyre on sand; Wikipedia, *Rolling resistance*), so sand stops it ~15× faster than stone.
  0–20 m/s in ~4 s, 25 m/s top (×1.5 boosted), speed-sensitive steering (0.6 → 0.2 rad). The tub is a convex
  hull with a chamfered skid plate (it rides up an edge instead of snagging) and a low centre of mass.
- **Hoverbike** (`hoverbike.js`): 2.5 m, 280 kg, a capsule hull (rounded ends ride over steps), hover at
  0.9 m, 20 m/s (31 boosted), yaw 1.9 rad/s. The body only turns about the vertical (no flips); the model
  banks and pitches for show.
- **Combat** (`index.js`): jeep 6 body-healths (12 rounds), hoverbike 3. Blasts: 14,000 N·s at the middle,
  quadratic falloff to 7 m, at most 14 m/s, landing 0.6 m off the centre of mass toward the blast (so it
  spins), and up to 5 body-healths of damage. Splatter: 3 → 10 m/s, 2.2 body-healths at the top (past the
  player's and the NPCs' damage shares). Heat: 1 body-health a second.

## API

```js
const vehicles = __app.pov.vehicles;    // created by the POV shell (pov/index.js)
vehicles.spawnLayout({ vehicles: [      // an arena's vehicles; each is kept alive and respawns 8 s after it's destroyed
  { kind: 'jeep' | 'hoverbike', team: 'red' | 'blue' | null, at: [x, y, z] /* grid cells, the ground under it */, yaw /* rad, 0 faces +z */ },
] });                                   // → how many; spawnLayout(null) clears them
vehicles.list                           // live vehicles and wrecks: { id, kind, team, health, alive, driver, impl: { body (Rapier), state, speed } }
vehicles.seated                         // the vehicle the player drives, or null
vehicles.use(player)                    // what E does: 'enter' | 'exit' | 'flip' | null
vehicles.damage(v, amount, cause)       // as a weapon would
vehicles.ready, vehicles.physics.clock, vehicles.stats.ms   // checks
```

Vehicles are `targets.js` targets (id `vehicle:N`, with `team`), so weapons that test targets hit them.
`targets.js` gained `targetsInBox(min, max, exclude)` for the run-over test.

### Events (povEvents)

| Event | Payload |
|---|---|
| `vehicle:enter` / `vehicle:exit` | `{ id, kind }` the player got in / out |
| `vehicle:splat` | `{ id, target, speed, point }` a vehicle ran a body over |
| `vehicle:destroyed` | `{ id, kind, team, point, cause }` it went up (then a `blast` at `point`, emitted as the vehicle: `by` = its id) |

Vehicles listen to `blast` (the bomb, the rocket, Revenge Explosion, their own) and `explosion` (any other
emitter's name for the same).

### Shell hooks (pov/index.js)

`E` (`VEHICLE_KEY`) calls `use`; each frame `beforeBody(player)` sits the body in the seat, the body
updates (so drowning, burning and the body→sim coupling still apply to a seated driver), `update(dt, …)`
steps the physics, `afterBody(player)` moves the body with the seat (velocity included), and `chase(camera,
dir)` places the chase camera, pulled in when a wall is behind it. While seated the figure, the hand and the
toolbelt are hidden; leaving first person gets you out and hides the vehicles (the god view doesn't step
them), as it resets the NPCs.

## Checks

- `node tools/vehicles-node-check.mjs`: CPU only (Rapier in node, a stand-in for the cells' copy): the jeep
  climbs 27° stairs, the hoverbike 18°, sand slows the jeep ≥ 3× harder than stone.
- `node tools/vehicles-check.mjs --port <yours> [--shot prefix]`: the real app on the GPU (a dev server; AC
  power). A test yard (a stone run into a rock ramp, a sand lane, a walled lake); E in and out; W drives;
  a body walked into a hull is pushed out; D steers right; the ramp; sand vs stone; a run-over hurts an enemy and not a teammate; a blast shoves it;
  the hoverbike skims the lake at speed and drifts; 0 health explodes into a burning wreck (FIRE in the sim)
  and a new jeep comes back; the palette's pads. Rates are per simulated second (`physics.clock`), so a slow
  headless frame rate doesn't fail them.

## Not yet

- The gunner seat and turret on the jeep (the model has the turret), passengers, multiplayer sync, NPC drivers.
- World mode: the window moves under the vehicles (needs `windowShifted` to move the bodies and the voxels).
- The body only meets a hull by being pushed back out sideways (`shoveOut`): you can't stand on a jeep's
  roof. Vehicles don't push cells (sand isn't ploughed, water isn't splashed by them).
- Vehicle-on-vehicle crashes don't hurt; the hoverbike's fans don't blow dust.
- Rapier's `-compat` build inlines its WASM as base64 (a 4.3 MB chunk, 1.65 MB gzipped, loaded on the first
  vehicle). The plain `@dimforge/rapier3d` package ships a binary .wasm (~1 MB gzipped) but needs a Vite
  WASM plugin.
- The vehicles read the cells through their own copy (an `ai/world.js` model, one readback every 0.5 s)
  beside the NPCs' one: sharing a single readback would halve that cost.
