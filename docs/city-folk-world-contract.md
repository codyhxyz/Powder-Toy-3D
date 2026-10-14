# City Folk world: completion contract

The user approved the full feature list below.
This is one complete world update, not a prototype or a first pass.
The base is production commit `cd5d7a4876e11dd06888bd6f4e0e3b21d3baa30a`.
The integration worktree is `/Users/codyhergenroeder/code/claude/tpt-city-folk-world`.

## Finished world

- Upper and lower neighborhoods, winding cliffs, and broad ramps.
- A meandering river, a fork, a small river island, and connected waterfalls.
- Separate small ponds in clearings.
- A southern beach with coves and river mouths.
- Open meadows between landmarks.
- The existing 552 m straights and 1.14 km closed sprint circuit.
- Scenic branches through woods, beside rivers, and along cliffs.
- Additional bridges, alternate loops, and neighborhood shortcuts.
- Dirt paths and worn grass around busy places.
- Upper cedar woods and lower hardwood groves.
- Native-fruit trees, small orchards, and flower patches.
- Beach palms, scattered rocks, shells, and buried discovery spots.
- A town hall, event square, and bulletin board.
- A shopping area with distinct Nook-inspired and Able Sisters-inspired buildings.
- A museum with a café entrance.
- Additional cottages in upper and lower neighborhoods.
- Vacant house plots.
- A northern town gate and bus stop.
- A separate city district with a working bus connection and return trip.

The landmarks need clear identities, entrances, and physical access.
The city needs a square and distinct commercial façades.
Shop economies, fishing systems, new resident AI, and museum collections are outside this world-generation request.
Do not turn those unrelated systems into delivery dependencies.

## Invariants

- Keep Tinker Creek's key, aliases, Animal Crossing mode, and rolling-log presentation.
- Keep the world at `3072 × 128 × 1024` cells.
- Keep the simulation window at its current size.
- Keep both sprint straights flat, dry, and clear across their full body width.
- Keep the four existing cottages, their doors, furniture coordinates, and village behavior.
- Keep the old `1024 × 128 × 1024` save geometry exact.
- Keep solo and co-op loading of both supported world sizes.
- Keep generated scenery consistent across streaming, the far field, and the CPU twin.
- Keep voxel edits when the player takes the bus or returns.
- Use deterministic, bounded generation without per-cell asynchronous work.
- Use the existing shared-source scene machinery and installed dependencies.
- Use original artwork and building shapes, not copied Nintendo assets.

## Parallel ownership

Each implementation lane uses its own managed worktree.
Each lane commits only its own work and reports its commit, files, checks, and remaining integration needs.
No implementation lane pushes or deploys.
No implementation lane launches another agent.
All implementation lanes use CPU checks only.
The parent controls GPU checks and release.

### Terrain and routes

Own `src/world/scenes/willowCove.js` and new terrain helpers under `src/world/scenes/cityFolk/`.
Own tests specific to terrain and route geometry.
Implement all terrain, water, and route requirements.
Provide `cfPath(x, z)` in the shared source for all protected paths.
Publish additional route samples and landmark access points for the other lanes.
Preserve legacy geometry and the long sprint circuit.
Do not wire unfinished landmark or nature modules.
The integration lane joins those modules later.

### Town landmarks

Own `src/world/scenes/cityFolk/town.js` and landmark tests.
Implement all town buildings, the square, board, gate, and additional cottage plots.
Do not edit `willowCove.js`, village mechanics, or transport wiring.
Export `CITY_FOLK_TOWN` with `ints`, `salts`, `src`, and `landmarks`.
Use the `TOWN` prefix for constants.
The source defines `cfTownCell(x, y, z, h, id)` and `cfTownReserved(x, z)`.
Return `id` outside owned geometry.
Here, `h` is terrain height and `id` is the existing cell.
Publish door and walkway samples.

### Nature

Own `src/world/scenes/cityFolk/nature.js` and nature tests.
Implement all vegetation, natural objects, discovery scenery, and worn-ground requirements.
Do not edit `willowCove.js`, other scene modules, or village mechanics.
Export `CITY_FOLK_NATURE` with `ints`, `salts`, `src`, and `landmarks`.
Use the `NATURE` prefix for constants.
The source defines `cfNatureCell(x, y, z, h, id)`.
Return `id` outside owned geometry.
Exclude `cfPath(x, z)` and `cfTownReserved(x, z)` from vegetation and obstacles.
Do not replace buildings, water, bridges, or the four original cottages.
Static worn dirt satisfies the world-generation requirement.

### City and bus

Own `src/world/scenes/cityFolk/city.js`, a bus helper, and transport tests.
This lane can edit village interaction wiring and narrowly scoped app wiring.
Do not edit `willowCove.js`, town geometry, or nature geometry.
Export `CITY_FOLK_CITY` with `ints`, `salts`, `src`, and `landmarks`.
Use the `CITY` prefix for constants.
The source defines `cfCityCell(x, y, z, id)`.
Return `id` outside the city.
Place the separate city outside the main town and sprint circuit, within the current world bounds.
Implement discoverable bus boarding, a safe arrival, and a return trip.
Reuse streaming and preserve the world's edit store.
Do not reload the scene to simulate a bus journey.

### Acceptance tests

Own a new independent CPU acceptance suite and a requirement-to-evidence checklist.
Do not edit implementation modules or existing tests while other lanes work.
Start from the finished-world list, not from the current implementation.
Cover terrain access, every landmark entrance, nature exclusions, both sprint straights, route connectivity, and bus round trips.
Cover deterministic generation, legacy saves, co-op sizes, edit persistence, cancellation, and other-mode isolation.
Report any requirement without evidence.

## Integration and release

The integration lane owns the final composition, existing test updates, metadata, and documentation.
It merges all lane commits into the integration worktree.
It fixes integration gaps rather than accepting unwired modules as complete.
Nature runs before town geometry so that buildings take priority.
The city override must not replace the original town or old save geometry.

Completion needs independent review and an evidence entry for every finished-world bullet.
Tests must inspect the composed scene, not only isolated helpers.
CPU checks, the production build, and deployment checks must pass.
The parent audits the result, fetches and merges current production, then pushes `main`.
The GitHub deploy must succeed.
The parent checks the live site and reports any check that remains unverified.

GPU slots remain limited to 10 seconds total, including startup and cleanup.
Do not bypass player detection or repeat failed GPU runs without parent approval.

## Coordinated interfaces and sites

These decisions resolve the parallel lanes' supervisor requests.
All coordinates below are island-local.

- Terrain supplies `cfHeight(x, z)`, `cfTerrainCell(x, y, z)`, and `cfPath(x, z)`.
- `cfTerrainCell` returns base terrain before new town, nature, and city overlays.
- Nature support checks must not call the composed cell recursively.
- Landmark records use `at`, `entry` where applicable, `floor`, and `half` for footprint dimensions.
- Enterable landmarks publish their doors and approach routes.
- Terrain publishes route polylines, water samples, and meadow samples.
- Nature publishes representative objects and their kinds.

| Feature | Center or arrival | Floor |
| --- | --- | --- |
| Town hall | `[-280, 12]` | 24 |
| Event square | `[-326, 12]` | 24 |
| Bulletin board | `[-326, 0]` | 24 |
| Shops | `[-380, 12]`, `[-430, 12]` | 24 |
| Museum | `[300, -80]` | 36 |
| Café annex | `[264, -80]` | 36 |
| Upper cottages | `[-400, -112]`, `[-680, -112]` | 48 |
| Lower cottages | `[-400, 80]`, `[-680, 80]` | 24 |
| Vacant plots | `[-500, -112]`, `[-500, 80]` | 48, 24 |
| Town gate | `[-260, -124]` | 48 |
| Gate approach | `[-260, -116]` | 48 |
| Town bus stop | `[-236, -116]` | 48 |
| Town bus arrival | `[-220, -116]` | 48 |
| City square | `[0, -352]` | 48 |
| City bus stop and arrival | `[0, -304]` | 48 |

The separate city occupies `x = -160..160`, `z = -440..-280`.
Its main façades are the Emporium, Tailor, and Theatre.
Their entries are `[-88, -376]`, `[0, -384]`, and `[88, -376]`.
The gate and town bus apron must remain clear after all overlays.

The transport lane supplies `createCityBus` with injected app adapters.
Its `withVillageFocus(at, valid, visit)` adapter streams without replacing the world.
The focus remains active during arrival-clearance checks.
The village E action boards the bus and supports cancellation.

## Delivery tracking

The first workflow wrapper stopped after a bookkeeping error.
Its five implementation workers remained active.
The parent tracks their exact runs and will integrate them after completion.
Do not restart an active lane or accept partial work as completion.

| Lane | Active run |
| --- | --- |
| Terrain and routes | `a16bc4ca` |
| Town landmarks | `3787400b` |
| Nature | `b10a34e9` |
| City and bus | `7ce70b0b` |
| Acceptance tests | `c4d09a48` |

If a child lacks an `apply_patch` tool, it uses its native file edit tools.
No child invokes a nonexistent patch executable through the shell.
