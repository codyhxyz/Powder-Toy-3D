# Sandustry-inspired industry: implementation contract

Approved direction: physical grains, direct construction, spills and gravity,
progression, and the same machines in Sandbox. No E machine interactions or
inventory-recipe dialogs. Existing Sandbox and its electricity stay intact.

## Ownership

- Physics lane: `src/industry/physics.js`, `src/shaders/industry.js`, optional
  backwards-compatible atomic transfer filters, and physics checks.
- Construction lane: `src/industry/index.js`, `view.js`, `industry.css`,
  `src/wire/industry.js`, wire registry/app/POV integration, save section.
- Quarry lane: `src/industry/progression.js`, `src/industry/quarry.js`,
  `src/presets.js`, `src/maps.js`, and CPU progression/map checks.
- Parent owns `catalog.js`, integration, final browser validation, deployment.
  No child pushes or deploys. Each lane uses its own worktree and commits.

## Shared API

`catalog.js` defines the device types, geometry helpers, and starter placements.
A device is `{id, type, x, y, z, rotation, filter, powered}`:
integer grid-space minimum corner of a 4x4 base, feet at y; rotation 0..3.
Local forward is +Z. `powered` true opts into existing TPT spark control;
false means the machine's built-in drive. No abstract electricity currency.
`filter` is a permitted element ID for the separator, default NUGGETS.
Optional transient fields belong to the physics lane, not serialized UI state.

`createIndustryPhysics({getSim, onShip, onError})` returns
`{ready, step(dt, devices), pending, reset(), dispose()}`.
`ready` resolves compiled pipelines; `step` is called ONLY during actual
simulation advancement, with dt capped, never on paused/menu-only frames.
`onShip({id, count, temperature})` credits only GPU-confirmed physical extraction.
Physics must not import progression/UI. Rebinding/reset invalidates stale
readbacks and releases old load objects; in-flight matter must not duplicate.
Bound machine count at 128; do not synchronously read the full grid per frame.

`createProgression(saved?)` returns
`{snapshot(), canBuild(type), build(type), refund(type), ship({id,count,temperature})}`.
`canBuild` returns `{ok, reason}`. `build` charges once and returns that result.
`snapshot` is validated JSON, including `credits`, `earned`, `stage`, `goal`,
`hint`, `unlocked` (type keys), `delivered`, `complete`.
The UI uses catalog prices and names; successful dismantling refunds full price.
Sandbox bypasses economics but uses exactly the same device physics.
Progression is only for `factory` mode on map/preset `quarry`.

`buildQuarry({g,set,box})` writes ordinary cells using the existing preset
builder callbacks (box upper bounds exclusive), with existing materials.
Always 128³. No new global material rules unless the parent approves.

`createIndustry(app)` returns
`{update(dt, stepping), reset(), dispose(), toJSON(), fromJSON(data),
  place(spec), remove(id), get state(), get building()}`.
`state` includes devices, progression snapshot (null in Sandbox), active and
selected type; expose this via `__app.industry` for tests.
`place` and `remove` validate bounds, mode, affordability, occupancy,
maximum count, and return `{ok, reason, id?}`. They never overwrite matter.
All serializable external data is validated before mutation.

## Physical behavior

- Belt: supports and pushes touching loose grains forward. Not an inventory.
- Lift: pushes loose grains upward, allowing multi-level chutes and catches.
- Separator: chosen material goes forward, other loose grains go right;
  physically redirected, not destroyed or converted into money.
- Miner: a visible automated drilling agent works forward into a finite
  nearby face; breaks solids into their existing debris in the world.
  No remote extraction or invented ore.
- Pump: moves real liquid from an adjacent inlet to a visible elevated outlet.
  Blocked outlet preserves cargo, full inlet/outlet show a useful state.
- Heater: heats actual material in its working volume so ordinary melting
  and cooling apply. TUNGSTEN lining tolerates metal-smelting temperatures.
- Shipping intake: takes qualifying valuable material only at its mouth.
  Gold nuggets start the economy; cooled metal earns more later.
- Spark-controlled devices use the existing conductor/battery/switch system.
  Define the exact connection point in catalog/UI and test it.
- Destroyed bases cannot continue working invisibly. Dismantling does not
  erase or refund surrounding ore. Shipping cannot credit unconfirmed reads.

## Experience

Default build controls: B toggles industry construction, click places,
R rotates, right click dismantles, Escape cancels. Native buttons mirror
keyboard actions. Drag belts only if safe; prevent duplicate placements.
Support both orbit/god view and first person. No duplicate E handler.
The placement ghost clearly shows inlet/output/direction and invalid placement.
Use existing typography/panels. Machines have distinct unlit/baked silhouettes
and visible moving parts (no dark MeshStandardMaterial in the unlit scene).
Keep HUD small, show next objective and useful bottleneck cues.
In Factory, prevent free Sandbox spawning/infinite bucket/undo from bypassing
the economy, while retaining excavation and construction-camera movement.
Other modes must keep all existing controls.

Starter quarry: layered open-cut terrain, a shallow sand+nugget seam, deeper
metal and coal, a finite reservoir, safe spawn and walking routes. A starter
line visibly handles a small mixed batch and ships it, but expansion/mining
needs the player. Gold must physically reach the shipping intake.
Unlock sequence: catch/sort -> automated mining/lifts -> water/pumps -> heat
and cooled metal. Milestones should arrive in minutes, not hours.
Keep playing after completion. Document limits honestly; no offline progress.

## Validation and release

Each worker leaves a runnable CPU or targeted GPU check and records commands.
Workers do NOT run GPU browsers concurrently; parent owns final GPU checks.
Use tools/browser.mjs, manual/ui mode, ready(), render(), finally close.
Preserve pause, mode switch, map reset, save/load, and Sandbox behavior.
Parent runs a full playable path, shader checks, build, fresh reviews, then
fetches/merges current origin/main and pushes HEAD:main; watches GitHub deploy
and checks the live site. Do not touch the user's dirty original checkout.
