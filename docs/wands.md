# Sandbox wands

Wands add editable tools. They do not replace the existing ten tools.
The sandbox exposes every implemented spell without a discovery requirement.

## Play and edit

1. In the material dock, open **Tools**.
2. Select a starter wand to enter first person.
3. Click the world to capture the pointer.
4. Hold the primary mouse button to cast.
5. Press **B**, or select **Edit wand**, to open the editor.
6. Add, remove, or move cards. Select **Save & equip** to apply the deck.

The tool chooser groups wands with the existing hotbar tools.
Keys **1–9** and **0** and the wheel cycle wands like tools: a slot's wands follow its tools.
Mana is a bar under health while a wand is in hand.
Escape cancels editor changes. Closing the editor does not fire the wand.
The editor saves one custom deck, its settings, and its tool slot locally.
World matter and inventory are not part of that saved deck.

All 16 recipes are available in the chooser and editor:

| Recipe | Function |
| --- | --- |
| Mining vacuum | Fracture terrain and collect debris |
| Tunnel cutter | Narrow, powerful drill with a cold work light |
| Acid shotgun | Three acid projectiles in a cone |
| Spark machinegun | Rapid bursts of spark bolts |
| Stored scrap machinegun | Fire finite stored scrap |
| Recoil flying | Aim downward for upward propulsion |
| Water extinguisher | Create water and cool the target |
| Liquid sponge | Absorb liquids, then release them on the next cast |
| Stored lava mortar | Throw finite stored lava along an arc |
| Remote black hole | Open an excavating sphere after a carrier timer |
| Double explosion | Two pressure blasts at impact |
| Delayed second explosion | Two blasts at one point, 0.35 seconds apart |
| Ice bridge | Create a connected ice span and cool it |
| Cave lantern | Deploy a cold light in open air |
| Powder placement and remote ignition | Place fuel, then ignite it on the next cast |
| Teleport | Move to a destination with full-body clearance |

## Architecture

JavaScript compiles spell cards when the deck changes. A bounded scheduler
executes the compiled plan. GLSL batches material changes in the existing
WebGL simulation. Fast projectiles travel outside the voxel state and use
asynchronous GPU collision queries.

This split keeps card evaluation outside the expensive voxel loop. It also
avoids a JavaScript-to-Wasm call for each spell or collision.

The compiler has limits of 64 cards, 16 expression levels, and 256 expanded
nodes. The minimum cast and recharge delays are 0.02 seconds.
The runtime also bounds active effects and work per frame.

World effects share one bounded state pass instead of a pass per pellet.
The pass preserves the full ping-pong state and marks changed regions.
Exact inventory transfers can add at most two separate transfer passes per frame.
Sparse state writes require synchronization of both state targets; they are
not a safe drop-in optimization.

Stored material uses the existing exact transfer system. Creating matter and
releasing stored matter are different operations. Starter scrap and lava
reservoirs are finite sandbox supplies, not infinite ammunition.

## Card semantics

- A modifier affects the next complete expression.
- A multicast consumes several expressions.
- Scatter copies one expression into a cone.
- Burst copies one expression and staggers its execution.
- Impact, Timer, and Expiry consume a projectile and its payload.
- Payload modifiers do not affect the carrier, or vice versa.
- Successive top-level expressions become successive wand casts.
- The wand pays for the full cast, including its payload, before launch.
- Editing a deck does not change projectiles already in flight.

This is not a byte-compatible Noita evaluator. In Noita, modifiers share a
casting block, and deck wrapping adds more interactions. This version uses
explicit expression scope, with no wrapping.

Two of Noita's wand settings exist: `shuffle` (0/1, Noita's
`shuffle_deck_when_empty`: the order of the top-level expressions is reshuffled at
every recharge) and `spellsPerCast` (Noita's `actions_per_round`: one cast fires that
many top-level expressions together, paying for all of them up front, stopping at the
deck's end, then the wand recharges). Defaults keep every preset as before: 0 and 1.
Mana stays prepaid: a cast that can't be paid waits for mana (Noita instead skips the
spells it can't afford). Procedural wands (Descent's loot and shop): `generate.js`.

## Why not Rust or Go?

The spell compiler handles small decks, not millions of cells. Moving it to
Wasm does not reduce GPU passes, memory bandwidth, draw calls, or readback
latency. A second toolchain adds cost without evidence of a bottleneck.

Measure compilation, scheduling, GPU effect passes, collision latency, and
rendering separately. `scripts/bench-wands.mjs` measures compilation and plan
traversal only. It does not establish gameplay frame rate.

If profiling later identifies a large CPU numeric workload, move that whole
batch behind the world-adapter boundary. Rust/Wasm is an option for that
measured case. Do not cross the language boundary once per spell.

Further GPU optimization can bin commands by affected region. Keep the bounded
command format and state-write rules when introducing that optimization.

## Checks

Run these commands from the worktree:

```sh
node scripts/check-wand-compiler.mjs
node scripts/check-wand-runtime.mjs
node scripts/check-wand-generate.mjs
node scripts/bench-wands.mjs
node scripts/check-wand-world.mjs --port 53241
node scripts/check-wand-recipes.mjs --port 53243
node tools/wand-editor-check.mjs --port 53245
node tools/check-shaders.mjs
npm run build
```

The browser checks start and stop their own strict-port servers and browsers.
The world check tests actual shader effects, full-body clearance, and surface
illumination. The recipe check tests all starter recipes in a small GPU world.
Its CPU timings measure scheduling and GPU submission, not GPU execution.
The editor check covers old slots, editing, persistence, input guards, and
desktop/mobile layouts.

On the development machine, the compiler benchmark measured about 2.7 µs per
deck. Most recipe checks averaged 0.05–0.17 ms per runtime update on a
64×32×32 grid. The first mining run included a 268 ms cold-start spike.
These measurements include idle frames and exclude full-game rendering.
They do not prove sustained performance in a large world.
Shader warmup and large-world GPU profiling remain follow-up work.

Cold lights are unshadowed in this version. Force fields move loose voxel
matter, not rigid buildings. The runtime keeps effects inside the active
simulation window. There is no electrical propagation system.

## Noita research and provenance

The research pass inspected these public game-data mirrors:

- [gun.lua](https://github.com/vexx32/noita-data/blob/master/scripts/gun/gun.lua)
- [gun_actions.lua](https://github.com/vexx32/noita-data/blob/master/scripts/gun/gun_actions.lua)
- [Wand mechanics](https://noita.wiki.gg/wiki/Guide:_Wand_Mechanics)

The Lua source exposes recursive draws, mutable casting-block state, and
separate trigger payload evaluation. Its callbacks cross into native code.
It does not expose the native physics engine's internal scheduler or memory
layout. Mirror parity with the current game was not established.

Public visibility is not a license to redistribute game code. This branch
implements the mechanics independently. It does not import Noita Lua, generated
translations, assets, or a third-party wand simulator.
