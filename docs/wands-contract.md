# Wand sandbox implementation contract

This branch adds composable wands without removing the ten existing tools.
It starts from `551fafa`; other sessions' uncommitted work stays untouched.

## Runtime boundary

Use JavaScript for card compilation and bounded CPU spell scheduling. Keep
world mutations in the existing GPU simulation. Compile only when cards change.
Do not run an interpreter per voxel, introduce Wasm, or replace the physics engine.
Bound expansion, work per frame, live projectiles, fields, and deferred events.
Effects cross the CPU/GPU boundary in batches, not one full-grid pass per pellet.

## Core (catalog.js, compiler.js)

All files live in `src/pov/wands/` unless stated otherwise.

`catalog.js` exports:

- `SPELLS`: array of `{ id, name, category, description, ... }`.
- `SPELL_BY_ID`: object keyed by id.
- `PRESETS`: array of `{ id, name, description, slot, cards, config }`.
  `slot` is the existing tool's 1-based hotbar slot (1–10).
- `DEFAULT_CONFIG`: numeric manaMax, manaRegen, castDelay, recharge, capacity.

Cards are spell-id strings. No arbitrary code or text language.
`compileWand(cards, config)` returns `{ casts, errors, stats, config }`.
Invalid/unfinished decks have errors and cannot fire. Compilation validates
unknown IDs, finite/clamped configuration, depth, expansion, and card count.

Each compiled node has:

```
{ op, id, effect, params, children?, payload?, trigger? }
```

- Leaf `op`: projectile, beam, touch, field, self.
- Leaf `effect`: spark, dig, emit, absorb, heat, cool, pressure, erase, light,
  teleport, ignite, place, attract, repel, scan.
- Composite `op`: multi or burst; `children` are compiled nodes.
- `params`: radius (cells), power, speed (cells/s), lifetime (s), gravity,
  spread (radians), recoil (cells/s), material (element KEY string), stored
  (boolean), collect (boolean), interval (burst seconds), mana, damage,
  castDelay (additive seconds), recharge (additive seconds), bounces, pierce,
  homing, trail (material KEY or null). Only applicable fields need exist.
- A projectile can have `payload` (another node) and `trigger: 'impact'|'timer'|
  'expiry'`; `params.delay` supplies timer seconds.

Modifiers consume the next complete expression. Multi consumes N expressions.
Trigger and timer cards consume carrier then payload, with modifier scopes
separate. A sequence of roots means successive casts. No deck wrapping or
shuffle in this version. Compilation resolves modifiers and precomputes costs;
runtime does not look up or reparse cards every frame.

Required usable recipes: mining vacuum; tunnel cutter; acid shotgun; spark
machinegun; stored scrap machinegun; recoil flying; water extinguisher;
liquid sponge; stored lava mortar; remote black hole; double explosion;
delayed second explosion; ice bridge; cave lantern; powder placement and
remote ignition; teleport. Include recognizable useful base spells and
multicast/scatter/timer/impact/modifier cards, not placeholder UI entries.

## GPU world adapter (world.js, src/shaders/wands.js)

`createWandWorld(env)` receives renderer, getSim, getVolume, getScale.

- `begin(ctx)`: current sim/dt/stepsPerFrame, resets frame counters.
- `queue(command)`: bounded queue, returns accepted boolean.
- `flush()`: apply queued effects in bounded batches; reset queue.
- `trace(segments)`: Promise of corresponding hit/null entries. Segment:
  `{ from: Vector3, to: Vector3 }`; hit: `{ point, normal, cell, id, fraction }`.
  Batch up to 128 rays; bounded readbacks; reject or return null safely on
  disposal/world replacement. No synchronous whole-world readback.
- `clearance(feet)`: Promise<boolean> for full player box, not a point.
- `setLights(lights)`: bounded transient cold lights in grid coordinates:
  `{ position: Vector3, color: [r,g,b], radius, intensity }`.
- `windowShifted(dx,dz)`, `dispose()`, `stats`.

World command:
`{ effect, center: Vector3, dir: Vector3, radius, power, material, temperature,
velocity: Vector3, dt, shape }`. Effects supported: dig, emit, heat, cool,
pressure, erase, ignite, attract, repel, place.
`shape` sphere by default; beam runtime places bounded samples. Material
uses element KEY strings. Emit/place only replace air/gas, not solid.
Dig respects hard/breakInto and leaves debris; erase respects WALL/CLONE.
Temperature/velocity/pressure values must be finite and bounded.
Effects mark touched regions correctly for sleeping simulation.
Generation-check async results. Rays/clearance must not apply across sim
replacement; coordinate handling must account for moving world windows.

Exact stored-material absorb/release uses existing sharedTransfer/Load in
runtime, not a lossy shader approximation. World adapter does not own inventory.

## Runtime (runtime.js, visuals.js)

`createWandRuntime(env)` uses world adapter, compiled nodes, shared transfer,
player actor and lightweight batched visuals. API:

- `equip(presetOrDefinition)` compile/update wand, preserve active flights.
- `update(ctx)` advances effects and handles primary-held casting.
- `tick(ctx)` advances flights/fields without firing while old tools selected.
- `deselect()` stops continuous casting, not flights.
- `windowShifted(dx,dz)`, `dispose()`.
- `definition` (current cards/config/name), `compiled`, `stats`, `status()`.
- `setDefinition(def)` validates/applies edits; returns compilation result.

Pay/reserve a whole cast including payloads once, at firing. Bounded cooldown
catch-up, no negative/zero-delay loops. Timers advance on simulation time and
pause. Projectile collision must include actors and terrain. Capture owner and
payload at firing; later edits never mutate flights. Self-recoil applies through
applyImpulse. Teleport needs full clearance and non-resetting player relocation.
Per-wand storage must not duplicate matter. Sandbox can seed clearly labeled
starter reservoirs, separate from Create cards.

## UI integration (editor.js/css, existing tools and POV shell)

Preserve old tool slots/keys. Add wand variants associated with existing tool
slots (mining 1/10, liquids 2, combat 4/9, manipulation 5, building 6, utility 7,
heat 8). Provide a discoverable chooser, no replacement of old tools.
One shared wand runtime is driven even when old tools are selected.
Editor has all implemented spells, categories/search, ordered deck, add/remove/
move buttons, preset picker, wand statistics, readable validation and cast
preview. Keyboard and pointer usable; not drag-only. Save/Cancel and local
persistence with guarded parsing. Opening suppresses movement/firing and releases
pointerlock; closing doesn't accidentally shoot. Editing available via visible
button and keyboard shortcut. Preserve app visual language.

## Validation

Node checks for compiler scoping/arity/limits/costs/all recipes; runtime logic
with fake adapter; a compiler/scheduler benchmark. Real-browser checks must
compile GPU shaders and verify material/state changes for representative
recipes, editor behavior, old tools, teleport state, pause, and bounded work.
Do not claim GPU behavior from JS-only tests. No deployment.
