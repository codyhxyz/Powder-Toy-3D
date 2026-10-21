# Vehicles: jeep, hoverbike and motorboat

Halo's Big Team Battle in the falling-sand world: a Warthog-style **jeep**, a drifty **hoverbike**, and a small **motorboat**,
rigid bodies in [Rapier](https://rapier.rs) (`@dimforge/rapier3d-simd`, the WASM SIMD build, pinned at
0.21.0) that drive on the sim's own cells. Code: `src/pov/vehicles/`. Every map has them: the boxes and the scrolling
World maps (Island, Volcano Isles, Lab Complex, Giant Volcano, Tinker Creek, Descent; see World maps below).

The same palette rule applies to **Axeman**, **Gunner**, **Worm**, **Giant worm** and **Bird flock**:
one click creates one creature (or flock), not a permanent spawner. Dead placements do not return on load.
Flocks save only their surviving count. **Player spawn** remains a toggleable spawn marker.
Vehicles, NPCs and bird flocks work in scrolling World maps as in a box. A World's vehicle or NPC appears once the
window covers its placement, stays put in the world as the window moves, and waits unsimulated while outside it, as a
Cruelty Squad mission's actors do.

## Playing

- **Get one**: the palette's Entities group has **Jeep**, **Hoverbike** and **Boat** (spawners.js). Like GMod,
  each click adds one real entity immediately in god view, even next to another: no pad, no toggle and no respawn.
  Vehicles keep their identity across POV/god switches, move in unpaused god view, and save their current pose/health.
  Destroyed one-shots are omitted from saves. For the boat, click an **open water surface** with at least 3.6 m of room,
  then press **V**, swim up and **E** to board. Boats placed on land cannot drive. Arena `spawnLayout` vehicles and legacy saved pads still replenish after 8 s (below).
- **E** near a vehicle (within 1.8 m of its hull): get in. **E** again: get out, set down beside the driver's
  door (else the other side, behind, in front, on top, wherever the body fits). You keep its momentum.
  **E** at an overturned vehicle rights it (Halo's flip).
- **Jeep/hoverbike controls**: W/S throttle (jeep S brakes first, then reverses), A/D steer, **Space** handbrake (jeep: the rear
  wheels lock and the tail swings out) or hop (hoverbike), **Shift** boost (the hoverbike's tank lasts 3 s).
  The mouse orbits Halo's third-person chase camera; when it rests 1.2 s the camera swings back behind.
  Tools are put away while you drive; the HUD shows health and speed (plus hoverbike boost).
- **Boat controls**: W forward, S reverse (slows forward travel first), A/D steer; release to coast.
  No hop, handbrake or boost. The stern motor must be in liquid. The **Jeep sinks in deep water**
  (its open hull floods); shallow water still permits wading along the bottom.
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
| Rigid bodies | Rapier in metres/kg/s, fixed 1/60 s steps (≤ 4 a frame), stepped in the POV frame loop. Loaded on the first vehicle: a 0.3 MB chunk and its 3.3 MB `.wasm` (0.84 MB brotli, 1.15 MB gzip), compiled as it streams in (`vite-plugin-wasm`, `vite.config.js`) | `physics.js` |
| What the hulls hit | one **Voxels** collider (Rapier ≥ 0.19's sparse voxel shape): voxel (x, y, z) at size 0.30 m is exactly cell (x, y, z). Solids and powders are voxels, liquids aren't. Only a region (48 × 28 × 48 cells) around each vehicle is filled, from the CPU copy of the cells (`ai/world.js`: the multiplayer packer's readback, ≤ 0.5 s old); each refresh toggles only the cells that changed (`setVoxel`), so a dug pit or a new wall shows up within half a second. The box's walls and floor are voxels too. The sync is incremental: a region that moves reads only the cells entering it (a per-cell count of the regions covering it empties the ones that leave all of them), a readback re-reads each covered cell once, and a vehicle's heightfield is rebuilt only when its corner or a column top under it changed. With Dam Valley's six vehicles a readback costs ~3 ms parked, a moving vehicle's re-centring ~3 ms (both ~40 ms before). | `physics.js` |
| What the wheels see | **not** the voxels: a raycast wheel sees only the ground straight under its axle, so the grid's 0.3 m risers are walls it bottoms out on. Each vehicle gets a heightfield (40 × 40 cells around it) of the column tops **dilated by the tyre's circle** (a rigid wheel of radius r touches a step's edge √(r² − (r − h)²) ahead of its axle); a step higher than r is a wall, left to the voxels. It collides with nothing; only that vehicle's rays query it. The jeep climbs 27° stairs this way; before, it stopped dead at 18°. | `physics.js` `buildGround` |
| Jeep | Rapier's `DynamicRayCastVehicleController` (Bullet's btRaycastVehicle port), 4 wheels, 4WD | `jeep.js` |
| Hoverbike | four ray springs (spring–damper, 1.6 Hz, ζ 0.45) on the same kind of heightfield, whose tops include liquids': it skims lakes. Yaw rate steering, thrust along the nose, low sideways grip (3 /s, 2 /s boosting): hard turns at speed drift ~30–40° | `hoverbike.js` |
| Boat | 650 kg, 3.6 m single-seat motorboat; 1.8 m³ buoyancy sampled through the hull, low COM, free roll/pitch, water-only outboard and steering. Minecraft-simple controls, Rust motorboat feel; no fuel system. Slender-hull drag C_d 0.08 with extra heave/side resistance, rather than changing other vehicles' drag | `boat.js` |
| Matter | hull sample points: Archimedes in liquids (ρ = elements.js dens × 100 kg/m³: a jeep sinks in deep water and floats on denser lava), quadratic drag in them (C_d 1.05, a cube's), heat damage above 300 °C; under each wheel, rolling resistance and grip by surface | `matter.js`, `jeep.js` |
| Look | chunky primitives lit like the Castle Crashers wizard (`figure.js` `figureFrag` with `FIG_TOON`: the volume's sun, shadows, GI) with black inverted-hull outlines; team stripe red/blue; a seated wizard drives | `look.js`, `jeep.js`, `hoverbike.js`, `boat.js` |
| Spawning, seats, run-overs, blasts, wrecks, HUD | | `index.js`, `vehicles.css` |

### World maps

A World simulates a 128-cell window that follows you over a bigger world (`docs/scaling.md` D11). The vehicles
live in the world's coordinates, as Minecraft's entities keep theirs while chunks load and unload around the player:

- Rapier's bodies, the Voxels collider and the wheels' heightfields are in world cells' metres (`worldCells.js`
  shifts each query by the origin of the window the cells' copy was read from), so the window moving moves nothing
  in Rapier. What the vehicles meet in the window's grid (the seated body, targets, blasts, the sim's cells for the
  wreck's gunpowder and fire, the meshes, the chase camera) is converted at the edge (`toWin` / `fromWin`, `index.js`).
  A box's world is its grid (origin 0), so a box runs exactly as before.
- The voxel mirror covers the copy's window. When a copy of a moved window lands it rebases: the regions' cells it
  leaves are emptied, what both windows hold keeps its voxels, and each region is re-read once (~4 ms with two vehicles,
  `vehicles-terrain-check`).
- A moved window asks for its copy at once (`ai/world.js` `update(dt, soon)`) instead of waiting out the 0.5 s
  refresh, so a boosted jeep (37 m/s) doesn't outrun the cells ahead of it. Past the copy's window the cells are open
  air (never a phantom wall), except the world's own edge and the floor, which are solid as the sim's are.
- A vehicle whose hull isn't 2 cells inside both the window and the copy (the NPCs' `RESIDENT_MARGIN`) is
  **parked**: its body is disabled in Rapier (its velocities kept), hidden, and out of the terrain sync, run-overs,
  blasts and E. It resumes as it was once the window covers it again. The one you drive never parks: the window
  follows you. A placement or a loaded save outside the window waits to appear.
- Saves store world cells (`world`) and world metres (`state.position`).

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
  { kind: 'jeep' | 'hoverbike' | 'boat', team: 'red' | 'blue' | null, at: [x, y, z] /* grid cells, the ground under it */, yaw /* rad, 0 faces +z */ },
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
toolbelt are hidden; leaving first person gets you out without resetting or hiding scene entities. God view steps
vehicles and NPCs only while unpaused; zero-time frames can create/pose them without advancing physics.

## Checks

- `node tools/entities-node-check.mjs`: CPU registry/vehicle lifecycle: no toggle or marker, limits, World NPCs and vehicles,
  active pose/health saves, permanent one-shot death, camera reset preservation, legacy pads and arena respawn. Then a
  jeep in a World: placed on a plateau, it stays put in the world (and is drawn and hit where it is) as the window moves
  twice, drops to the floor when the plateau's world cells are dug, parks (held still, unseen, its terrain let go)
  when the window leaves it and resumes when it comes back, and saves and loads at its world position.
- `node tools/entities-npc-node-check.mjs`: CPU NPC creation/death/reset decisions, legacy respawn, no god-view player target and World window shifts.
- `node tools/entities-check.mjs --url <site>` (or `--port <yours>`): browser smoke for palette names, immediate god-view
  entities, pause, camera identity, permanent boat death/save-load and arena respawn. No dev-only page imports.

- `node tools/boats-node-check.mjs`: CPU boat flotation/roll-pitch recovery, uneven liquid response, motor, coast, steering and
  reverse, dry/airborne/dead motor gating, shoreline collision, Jeep sinking/drag/heat, palette and pad save roundtrip.
- `node tools/boats-check.mjs --port <yours>`: UI-mode browser smoke for normal water-surface entity
  placement, boarding, driving/steering/reverse and exit (GPU budget rules apply).

- `node tools/vehicles-node-check.mjs`: CPU only (Rapier in node, a stand-in for the cells' copy): the jeep
  climbs 27° stairs, the hoverbike 18°, sand slows the jeep ≥ 3× harder than stone.
- `node tools/vehicles-terrain-check.mjs`: CPU only, Dam Valley with six vehicles driving, circling and
  parked while the cells are dug, walled, sanded and flooded: after every sync the incremental collider
  equals a from-scratch one (voxels, through a shadow of the `setVoxel` calls, and every ray ground), with
  no wasted `setVoxel`; then the same through a World's window moving after a driving jeep (copies landing a few
  frames late, a pit dug ahead), also against the world's own cells; then times the syncs. Both node checks load the game's Rapier package through
  `tools/rapier-node.mjs` (node hooks for its bundler-style imports and `.wasm` module).
- `node tools/vehicles-check.mjs --port <yours> [--shot prefix]`: the real app on the GPU (a dev server; AC
  power). A test yard (a stone run into a rock ramp, a sand lane, a walled lake); E in and out; W drives;
  a body walked into a hull is pushed out; D steers right; the ramp; sand vs stone; a run-over hurts an enemy and not a teammate; a blast shoves it;
  the hoverbike skims the lake at speed and drifts; 0 health explodes into a burning wreck (FIRE in the sim)
  and a new jeep comes back; the palette's pads. Rates are per simulated second (`physics.clock`), so a slow
  headless frame rate doesn't fail them.

## Not yet

- The gunner seat and turret on the jeep (the model has the turret), passengers, multiplayer sync, NPC drivers.
- The body only meets a hull by being pushed back out sideways (`shoveOut`): you can't stand on a jeep's
  roof. Vehicles don't push cells (sand isn't ploughed, water isn't splashed by them).
- Boats respond to actual liquid cells (the CPU copy can lag by 0.5 s), not decorative rendered waves.
  The hull uses a sampled displaced volume, not a fluid solver; no wakes, planing or visual-wave coupling.
- Vehicle-on-vehicle crashes don't hurt; the hoverbike's fans don't blow dust.
