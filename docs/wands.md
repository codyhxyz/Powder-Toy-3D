# Sandbox wands

Wands add editable tools. They do not replace the existing ten tools.
The sandbox exposes every implemented spell without a discovery requirement.

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
explicit expression scope, with no wrapping or shuffle.

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
