# POV mode: design and module contract

## The experience

"I made this world, now I'm standing in it, and it can kill me." TPT's stickman in 3D.

- **Drop in / pop out** (`F`). From the god view, `F` drops a body onto the surface under the cursor (or the
  middle of the box). The camera swoops from orbit into the eyes. `F` again swoops back out to the orbit pose
  you left. The sim keeps running in both modes.
- **You are small**: about 5.5 cells tall in a 128-cell world (one cell ≈ 30 cm). Lava flows are rivers and
  houses are buildings.
- **A real, mortal body**. You walk, sprint, jump and swim, and you float or sink by density. Blasts shove you
  (the same a = −∇P/ρ the sim uses). Heat, cold, acid, lava, drowning, being buried and being thrown into walls hurt; landings never do (Noita has no fall damage).
  You die, the camera pulls back with the cause ("Killed by lava, 1,140 °C"), and you respawn at the drop-in
  point.
- **Jetpack** (Noita's levitation): hold `Space` in the air to fly. Movement is Noita's player (player.xml values scaled by body height: 5.4 g, a 1.9 m jump, an 8.6 m/s run): velocity eases a fixed share per frame toward the wished speed instead of being pushed by forces. The jet eases the climb toward 14 m/s with gravity off while it fires,
  the tank holds 3 s of thrust and recharges as Noita's does (its player.xml values): full in 0.5 s on the ground, and in the air at 0.4 s per s once the jet has been off for 0.63 s; every tap burns at least 8 frames. The fuel bar
  shows under health while it isn't full. Swimming strokes take over in deep liquid. The exhaust is cosmetic
  (vfx.js `jet`), with a roar loop (audio.js `jetLoop`).
- **The body** (setting: Wizard | Realistic | Stickman, key `character`): Wizard is the default, drawn the
  way Castle Crashers draws its people (figureCrasher.js): a huge round head lost in a floppy pointed hood,
  the face a black shadow with two glowing eyes (the game's Evil Wizard), a stubby robed body with mittens,
  a brass jetpack that flames while it fires, inverted-hull outlines and two-tone cel shading. It is the
  stickman's rig and animation with another look (`createFigure(build)`; a look can ask for `outline`,
  `toon`, glowing parts, `flames` and its own `nozzles` for the exhaust). Realistic is the skinned
  mannequin dressed as a wizard, a pointed hat and a robe skinned to its skeleton (garb.js: the robe's
  weights are transferred from the nearest body vertices and eased toward the pelvis below the hips).
  Stickman stands in while it loads. The jet exhaust leaves from the small of the back (`JET_NOZZLES`).
- **Physical, finite tools on a Minecraft-style hotbar** (keys `1`–`9` and `0`, and the scroll wheel in POV). God powers
  (infinite painting) stay in god view, one `F` away.
  1. **Shovel**: digs powder, or breaks solids into their debris (slower the harder they are; WALL
     refuses), into the **pack** (the inventory, `transfer.js` `pack()`, 1,000 cells). Right-click throws a
     bladeful from it where you aim.
  2. **Bucket**: scoops a load of liquid, and right-click pours it out. A bucket of lava is allowed.
  3. **Axe**: a short-range swing that breaks breakable solids in a wide, shallow patch into debris. It's
     weaker and less focused than the gun, and chops trees and smashes windows.
  4. **Gun**: fires a SCRAP (metal) slug at V_MAX from the eye. It's a real cell in the sim: it drops, slows
     in water, and breaks what it hits if its kinetic energy beats the target's hardness. The impact turns
     kinetic energy into heat, so shooting a powder keg sets it off. Recoil conserves momentum.
  5. **Physgun**: a force beam on loose matter (powders, liquids, gases). Hold left-click to grab a ball of
     stuff at the aim point and carry it around floating, right-click to fling it, release to drop it.
     Right-click with nothing held blasts the loose matter in a cone along the aim (one impulse, so light
     stuff flies farther). It can't lift or knock over solids (no rigid bodies).
  6. **Trowel**: builds Minecraft-style 1 m blocks (3³ cells on a fixed lattice) from the pack against the
     face you aim at; right-click picks the material. The cells are the pack's own, so a sand block slumps.
  7. **Scanner**: the god view's hover readout at the crosshair, at any range: material, temperature,
     pressure, distance.
  8. **Blowtorch**: hold for a roofing torch's flame: engine FIRE at 1,900 °C blown along the aim, and what it
     touches heats toward that (shaders/povTools.js TORCH). The engine lights wood, sets off gunpowder,
     melts metal.
  9. **Bomb**: a thrown pipe bomb (18 m/s plus yours, 1 g, on the shared projectiles) that becomes a 5³
     charge of gunpowder where it lands, lit by one detonator cell so the burn runs through it as a wave
     and the blasts stack; the blast is the engine's.
  10. **Pickaxe** (key `0`): the axe's swing with a heavier, pointed head (melee.js, shaders/povTools.js
      `PICK`): a slower blow with more energy in a narrower, deeper patch. It mines rock, a 3×3 face two
      cells deep a swing, into STONE in place for the shovel to pick up. Metal still turns it away.
- Mouse look with pointer lock. `V` toggles first and third person. A crosshair, health and breath bars, and
  screen effects for what the body feels: heat glow at the edges, frost, a red flash
  when hurt.
- Cut for now: NPCs, inventory or crafting, ammo, multiplayer POV (guests get a toast), audio,
  physgun on solids.

## Physics rules (non-negotiable, see feedback in project memory)

- Everything obeys the engine. No visual fakes, no scripted immunities. Matter is conserved: a tool that
  takes cells puts the same cells (element, temperature, life, ctype) back when it dumps them, or it keeps
  them.
- **No magic numbers.** Every threshold, rate or size is a named constant with a unit comment. GLSL gets
  `#define`s generated from the JS constant.
- Hardness: `ELEMENTS[i].hard` and `.breakInto` (elements.js), and in GLSL `HARD[NE]` (float) and
  `BREAKINTO[NE]` (int, −1 = unbreakable). Units are the sim's kinetic energy, ½·DENS·|v|² with v in
  cells/step. Only solids break. Powders, liquids and gases have hard 0: tools take them freely.

## Engine facts you need

- The grid is NX×NY×NZ cells, stored as a 2D atlas that only shaders/common.js knows the layout of.
  Shaders read a cell with `fetchA(cell)` / `fetchB(cell)` and never sample `tA`/`tB` directly
  (`node tools/check-state-access.mjs` checks):
  - State A = (element id, temperature °C, life, ctype + seed fraction).
  - State B = (velocity xyz in cells/step, air pressure).
- `sim.pass(mat)` ping-pongs a full-grid RawShaderMaterial (uniforms `tA`/`tB`) that writes the state with
  `writeState(a, b)` from `stateOutGLSL`. A pass that changes a few cells and copies the rest supplies an
  update function to `copyThroughMain`; every brush and tool change goes through one, see `paintFrag` in
  shaders/passes.js. `sim.run(mat, target)` renders into any target, e.g. a small readback target.
- CPU side: `sim.cellTexel(x, y, z)` indexes the arrays `sim.blankState()` / `sim.readState()` use;
  `sim.readCell(x, y, z)` reads one cell back (tests only).
- GPU→CPU: `renderer.readRenderTargetPixelsAsync(target, ...)` (see `requestPick` in app.js). Keep readbacks
  small (a few hundred texels).
- Grid ↔ world: `world = volume.position + grid * scale` (`window.__app.volume`, `.scale`). Grid y is up,
  y = 0 is the floor.
- The sim runs `settings.steps` steps per rendered frame (default 4, so about 240 steps/s). V_MAX = 1
  cell/step.
- Rendering is on demand (gfx/pacing.js). Anything that changes the view must change the camera or call
  `pacer.wake()` (`__app.requestRender()`).

## Modules and ownership (one owner per file, to keep merges clean)

| Area | Owner | Files |
|---|---|---|
| Hardness physics: impact and blast breaking, KE→heat, debris behaviour, acid-proof shards, CPU tile port | engine | `src/elements.js` (values only), `src/physics.js`, `src/shaders/react.js`, `src/shaders/move.js`, `src/ui/tiles/*` |
| Body physics: probe readback, collisions, swimming, pressure push, vitals and damage, body→sim coupling pass | player | `src/pov/player.js`, `src/pov/vitals.js`, `src/shaders/povBody.js` |
| Camera, drop-in swoop, pointer lock, first/third person, body mesh, HUD, input, app integration | shell | `src/pov/index.js`, `src/pov/camera.js`, `src/pov/figure.js`, `src/pov/hud.js`, `src/pov/pov.css`, `src/app.js`, `src/camera.js`, `src/ui/hud.js` (help list) |
| Hotbar, tool registry, shovel, bucket, exact cell transfer | tools-a | `src/pov/tools/index.js`, `src/pov/tools/hotbar.js`, `src/pov/tools/transfer.js`, `src/shaders/transfer.js`, `src/pov/tools/shovel.tool.js`, `src/pov/tools/bucket.tool.js`, `src/pov/tools/hotbar.css` |
| Axe, gun, physgun | tools-b | `src/pov/tools/axe.tool.js`, `src/pov/tools/gun.tool.js`, `src/pov/tools/physgun.tool.js`, `src/shaders/povTools.js` |

Shared, read-only for everyone: `src/pov/constants.js`, this doc.

### The player contract (player → shell)

```js
// src/pov/player.js
createPlayer({ renderer, getSim }) → player
player.spawn(feet /* Vector3, grid */)   // stand the body here, full health and breath
player.update(dt, input)                  // every POV frame; input = {
                                          //   move: { x, z },  // grid-space wish direction, length ≤ 1 (shell applies yaw)
                                          //   jump, sprint, down }  // down = swim down
                                          // Runs the probe readback, collisions, buoyancy, pressure push,
                                          // vitals and the body→sim coupling pass.
player.pos, player.vel                    // feet position (grid), velocity (cells/s)
player.onGround, player.inLiquid, player.headInLiquid, player.liquidId
player.health, player.breath              // 0..1
player.jetFuel, player.jetting            // jetpack tank 0..1, firing this frame
player.feel = { heat, cold, acid, hurt }  // 0..1 intensities for screen effects (hurt decays after a hit)
player.dead, player.cause                 // cause: 'Killed by lava, 1,140 °C'
player.applyImpulse(dv /* cells/s */)
player.on(name, fn)                       // 'hurt' {amount, cause}, 'death' {cause}, 'land' {speed}, 'splash' {speed}
player.dispose()
```

The shell owns respawning (it calls `spawn` again after the death screen).

### The tool contract

`src/pov/tools/index.js` exports `createToolbelt(env)`. The body module calls it when POV starts, if the
module exists (optional `import.meta.glob`, the same pattern app.js uses for signs and constructions).

```js
env = {
  renderer, scene,
  getSim: () => sim, getVolume: () => volume, getScale: () => scale,
  hud,                 // ui/hud.js: hud.toast(text)
  viewmodel,           // THREE.Group attached to the POV camera; tools may add meshes (held item)
  isActive: () => bool // true while in POV (gate your own key/wheel listeners on it)
}
toolbelt = createToolbelt(env) → { update(ctx), select(index), setVisible(bool), windowShifted(dx, dz), dispose() }
// The shell calls setVisible(true/false) on entering/leaving POV, and update(ctx) every POV frame.
// In World the grid is a window that moves over the world (docs/scaling.md D11): the shell calls
// windowShifted when it does, and the toolbelt passes it to every tool.
// The toolbelt listens for the number keys itself (1–9, 0 for slot 10) (only while env.isActive()). The wheel comes in ctx.wheel:
// it switches slots unless the selected tool's wantsWheel?.() returns true, then it goes to the tool.
```

The toolbelt finds tools with `import.meta.glob('./*.tool.js', { eager: true })`. Each tool file
default-exports:

```js
export default {
  key: 'GUN', name: 'Gun', slot: 4, model: 'gun' /* models.js key: its hotbar icon is a sprite of it */,
  desc: 'one line for the hotbar tooltip',
  create(env) → {
    update(ctx),          // every frame while selected
    deselect?(),          // when switching away (drop what the physgun holds, etc.)
    status?(),            // short text for the hotbar slot, e.g. 'SAND ×37' (or null)
    wantsWheel?(),        // true while the tool uses the wheel (physgun distance)
    windowShifted?(dx, dz), // the window moved (dx, 0, dz) cells over the world: move every grid position
                          // the tool keeps by (-dx, 0, -dz), so it stays put in the world (the gun's rounds
                          // in the air, the physgun's hold point). A point an async result reports later
                          // is pinned at the time with transfer.js pinned(point, sim).
    readout?(ctx),        // { name, color, T?, P?, note? } shown beside the crosshair (ui/hud.js showReadout), or null
    dispose?(),
  }
}
```

**Shared feel: use these, don't hand-roll per tool**, so every tool (and a new one) acts and responds the same:

- `tools/action.js` `trigger(interval, { hold, button })`: when a button acts. HL2's weapon timing: acts on
  the frame the button goes down, then every `interval` while held (`hold: false` for one per click), and
  a click during the wait is buffered. `swing(spec)`: a melee blow's eased pose, stopping short on a hit and
  following through on a miss.
- `tools/melee.js` `meleeTool(spec)`: a whole swung tool (the axe, the pickaxe) from its blow's tuning, pass,
  `HIT` row, refire, body damage and held pose. A new swung tool is a config file; add its impact source to
  `constants.js` `MELEE_SOURCES` so sparks and ricochets treat it as a blow, not a round.
- `viewmodel.js` `HIT` and `rig.hit(HIT.X)`: a tool's shot, blow or fling, as the hand's spring kick plus
  the view punch (feel.js, Source's ViewPunch spring). Add a row to `HIT` for a new tool.
- `env.feedback.notice(text)` / `refuse(text, { id, point })`: the throttled "can't" toast, slot shake and
  `tool:action 'refuse'`.
- `readout?(ctx)`: text beside the crosshair, in the god view's hover chip (the scanner, the trowel's material).
- `env.ballistics`: the shared projectiles; `fire(origin, dir, gravityScale(sim), { speed, carry, kind,
  onStrike })` flies anything ballistic (the gun's rounds, the bomb) and the toolbelt keeps it flying.
- `transfer.js` `muzzleCell()`: where something leaves the hand (the first cell clear of the body).
- `transfer.js` `pack()`: the shared inventory of loose matter; `put(load, { id })` places one element of it.

`ctx` is built by the body module every frame in POV:

```js
ctx = {
  sim, dt,                        // seconds
  stepsPerFrame,                  // settings.steps (0 while paused)
  eye: THREE.Vector3,             // grid cells
  dir: THREE.Vector3,             // unit aim direction (grid space = world axes)
  primary, secondary,             // mouse buttons held
  primaryPressed, secondaryPressed, // went down this frame
  wheel,                          // wheel notches this frame (+1 = scrolled down/away), 0 if none
  aim: { valid, cell: Vector3, face, id, T, P, dist },   // the cell under the crosshair (pick pass)
  player: { pos, vel, onGround, inLiquid, applyImpulse(dv /* cells/s */) },
}
```

## Gunplay v2 (2026-10-08): events and ownership

Gunplay v2 follows the Gunplay Feel Lab's recommendations: ballistic rounds handed to the sim at impact,
ZzFX sound through PositionalAudio, CC0 glTF viewmodels with spring recoil and sway, three.quarks VFX,
camera kick, trauma shake and a hitmarker, plus an optional realistic body (Quaternius) next to the stickman.

### Events (`src/pov/events.js`)

`povEvents.emit(name, payload)` / `povEvents.on(name, fn)`. Positions are **grid cells** (Vector3) unless they
say world. Emitters own their event names. Listeners never mutate payloads.

| Event | Emitted by | Payload |
|---|---|---|
| `blast` | bomb | `{ point }` grid. A charge was set off there (sound, shake). |
| `punch` | `rig.hit` (viewmodel.js `HIT`) | `{ pitch, yaw }` rad, + up and + left. Throws the view punch (feel.js). |
| `gun:fire` | gun | `{ origin, dir, muzzleWorld }`. The round left the muzzle (origin grid, dir unit; muzzleWorld is the viewmodel muzzle in world space, for the flash). |
| `gun:dry` | gun | `{}`. The trigger clicked but nothing fired (muzzle blocked). |
| `round:move` | gun, bomb | `{ id, kind, from, to }` (kind 'round' or 'bomb'). A round in flight moved this frame (grid), for tracers. |
| `round:end` | gun, bomb | `{ id, kind }`. The round is gone (impact or out of the box). |
| `impact` | gun, axe, pickaxe | `{ source: 'gun'\|'axe'\|'pickaxe', point, normal, id, energy, broke, body? }` (body: a target, not a cell, was hit; id −1). Something was struck. id is the element hit, energy is ½·DENS·v² in sim units, and broke is true/false when the striker knows, else null. |
| `tool:action` | shovel, bucket, axe, pickaxe, physgun, trowel, blowtorch, bomb | `{ tool, action, id?, point?, amount? }`. tool is 'shovel'\|'bucket'\|'axe'\|'pickaxe'\|'physgun'\|'trowel'\|'blowtorch'\|'bomb'; action is 'dig'\|'place'\|'on'\|'off'\|'throw'\|'dump'\|'scoop'\|'pour'\|'swing'\|'refuse'\|'grab'\|'fling'\|'release'\|'blast'. Physgun 'hold' state is read from the tool, not an event. |
| `player:step` | shell (camera bob cycle) | `{ speed, inLiquid }`. A footfall. |
| `player:jet` | player | `{ on }`. The jetpack lit or went out. |

The player's own events (`player.on('hurt'|'death'|'land'|'splash')`) stay as they are; listeners subscribe there too.

### Ownership (v2)

| Area | Owner | Files |
|---|---|---|
| Ballistic rounds, GPU segment trace, impact handoff | gun | `src/pov/tools/gun.tool.js` (all but `buildModel`), `src/pov/ballistics.js`, `src/shaders/povTrace.js` |
| Viewmodels (procedural RuneScape-style models), viewmodel rig (spring recoil, sway), overlay render pass, tool emits | viewmodels | `src/pov/models.js`, `src/pov/viewmodel.js`, the model-building code in every `*.tool.js` (and `buildModel` in gun.tool.js), `tool:action` emits in shovel/bucket/axe/physgun, the overlay hook in `src/app.js` |
| Camera kick, trauma shake, hitmarker, crosshair bloom, three.quarks VFX (flash, sparks, dust, tracer), footsteps | feel | `src/pov/feel.js`, `src/pov/vfx.js`, `src/pov/camera.js`, `src/pov/hud.js`, `src/pov/pov.css`, `src/pov/index.js` |
| Sound (ZzFX + PositionalAudio) for every POV event | audio | `src/pov/audio.js` (+ one wiring line in `src/pov/index.js`) |
| Realistic body (Quaternius, AnimationMixer) behind a Stickman/Realistic setting | character | `public/models/character/**`, `src/pov/figureReal.js`, the settings row in `src/app.js`, a figure switch in `src/pov/index.js` |

## NPCs (2026-10-09): enemies that use every tool

NPCs come from **spawners** (`src/spawners.js`), the palette's Entities group: an **Enemy spawner** keeps one
NPC alive on its spot while in POV (it appears there and comes back 8 s after dying; up to 8), and a **Player
spawn** is where F drops you in (the one nearest the cursor) and where you respawn. Click a spawner again with
its tool to remove it. Spawners stand on world cells like signs; a new scene clears them, and the lab comes
with one enemy spawner on its open south floor. Not in worlds (the window): NPCs don't follow it yet.
Each NPC (`src/pov/npc.js`, loaded on first use) hunts the player. It has the
player's body, the player's tools and a mind built from textbook game AI, each a solved problem:

| Sub-problem | How | Where |
|---|---|---|
| Body | a second `createPlayer({ quiet: true })`: same movement, swimming, burning, drowning | `npc.js` |
| Hands | `createKit(env)`: every tool, headless, its own pack and bucket (`env.owner`), the shared projectiles | `tools/index.js` |
| What's in the world | the multiplayer packer reads the cells back to the CPU every 0.5 s (id + temperature) | `ai/world.js` |
| Seeing and aiming | Amanatides & Woo voxel traversal (1987) over that copy; the tools' `ctx.aim` comes from it | `ai/world.js` |
| Getting there | a height map on a 2-cell grid as a Yuka `Graph`, searched with Yuka's `AStar` | `ai/nav.js` |
| What to do | Buckland's goal-driven agent (Yuka `Think` + `GoalEvaluator`s, composite `Goal`s) | `ai/brain.js` |
| Which weapon | Buckland/Raven fuzzy weapon selection (Yuka `FuzzyModule` over distance), gated by sight and ammo | `ai/brain.js` |
| Where it saw you | Yuka `MemorySystem` (12 s), plus touch within 4 cells | `ai/brain.js` |
| Steering | Yuka pursuit, seek and wander; the vehicle keeps its own velocity, only its position follows the body | `ai/brain.js` |

Strategies (evaluators → goals): **Attack** (fuzzy weapon: axe and blowtorch close, gun at any range, bomb at
mid range with the low-arc launch-angle formula, physgun flinging nearby loose matter, a bucket of lava poured
from close), **Hunt** (A* to where it last saw you), **Breach** (no path and a wall between: shovel through
powder, axe through wood/glass/plants/ice, pickaxe through rock, bomb what's left), **Climb** (you're up out of reach: dig material, walk
to your column, pillar up by jumping and setting a trowel block under its feet), **Cover** (hurt and under
fire: two trowel blocks between you), **Extinguish** (on fire: run to water), **Gather** (idle: dig sand for
building), **Wander**. A strategy that fails is put on a 4 s cooldown. Reflexes in `npc.js`: jump when blocked,
swim up to breathe, dive after a player below, jet out of water at a wall. The scanner is the one tool it never
uses: it only reads out a cell, and the world model already knows.

Yuka gotcha: a `CompositeGoal` runs its subgoals in the order they were **added** (Yuka's `addSubgoal`
unshifts and `currentSubgoal()` takes the last), the reverse of Buckland's C++.

**Who did it.** Tools emit on the global bus, so an NPC's tools run inside `povEvents.as({ id, at }, fn)`:
every emit then carries `by` (the NPC's id) and `from` (its eye), and `punch` (the player's view kick) is
dropped. Rounds remember who fired them (`ballistics.js` `r.actor`) and emit as them. Listeners that are the
player's own (hitmarker, gun kick, the torch/pour/physgun loops) skip `by` events; sounds play at `point`
or `from`. `targets.js` holds everything weapons can hit that isn't cells (the player, id `'player'`, and
each NPC); a weapon never hits its own wielder. The player takes half damage from NPC weapons.

Checks: `__app.pov.npc.debug` (goal, weapon, tool, sees, pack, last refusal), `__app.pov.npc.agent`,
`__app.pov.events`.

**Fair and fun (2026-10-09).** The standard shooter-AI rules, in `ai/brain.js`: a 0.7 s reaction before it
attacks something it just saw (Halo and Doom AI); its first shot after spotting you is a deliberate near miss
and its gun's spread narrows from 0.16 to 0.05 rad over 4 s in sight (Naughty Dog's accuracy ramp); every
dangerous action has a tell (axe raised 0.6 s, arm up 0.6 s before a bomb, the torch aimed 0.4 s before it
lights, then 1 s bursts with rests); a hit staggers it out of a wind-up; after it hurts you it takes a 0.9 s
breather. It takes 60% damage (four gunshots or five axe blows); you take 50% from its weapons. Bomb blasts
and burns are the sim's physics and aren't scaled, so it uses those sparingly.

Playtest: `node tools/npc-playtest.mjs [--url …] [--styles afk,gunner,brawler,runner] [--matches 3]` (AC power).
Scripted players fight it with real input; it reports wins, time to kill both ways, damage by cause and the
worst second. Targets: an AFK player lasts 20–60 s; a fighting player wins most duels but loses some health;
no second takes more than half your health; a runner gets away.

## Verifying (headless GPU)

- Use playwright's Chromium with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` against your own
  vite dev server. Each agent has its own port; kill only your own PIDs and never `pkill` chrome.
- Put scripts inside the project dir so `playwright` resolves, e.g. `tools/pov-*.mjs`. Committing a small
  reusable check is welcome.
- `window.__app` exposes sim, settings, camera, volume, scale, renderer, hover and more.
  `sim.census()` returns per-element counts and temperatures, which is good for conservation checks.
- Tools can be exercised without the body module: `await import('/src/pov/tools/gun.tool.js')` in
  `page.evaluate`, then drive `update(ctx)` with a hand-built ctx.
- Screenshots are heavy on the user's battery. Take few, downscale them, batch them into one run, and don't
  loop on re-shoots.
- Run `node tools/check-shaders.mjs` (add your new shader modules to it) and `node scripts/check-tile-engine.mjs`.
- Never `git stash` (the stash is shared across worktrees). Commit work in progress often on your branch.
