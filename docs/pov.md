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
- **Physical, finite tools in Half-Life 2 / Garry's Mod weapon slots** (see "Inventory" below): keys `1`–`5`
  are slots (Dig, Build, Guns, Explosives, Gadgets); pressing one again steps to the next tool in it, and the
  wheel steps through everything carried. God powers (infinite painting) stay in god view, one `F` away. The
  list below is the original ten; the guns and the rocket launcher are under "Guns" below.
  1. **Shovel**: digs powder, or breaks solids into their debris (slower the harder they are; WALL
     refuses), into the **pack** (the inventory, `transfer.js` `pack()`, 1,000 cells). Right-click throws a
     bladeful from it where you aim.
  2. **Bucket**: scoops a load of liquid, and right-click pours it out. A bucket of lava is allowed.
  3. **Axe**: a short-range swing that breaks breakable solids in a wide, shallow patch into debris. It's
     weaker and less focused than the gun, and chops trees and smashes windows.
  4. **Pistol** (key `GUN`): see "Guns" below. (It used to fire a SCRAP slug that stayed in the world;
     the slugs plugged the holes they made, so rounds now add nothing.)
  5. **Physgun**: a force beam on loose matter (powders, liquids, gases). Hold left-click to grab a ball of
     stuff at the aim point and carry it around floating, right-click to fling it, release to drop it.
     Right-click with nothing held blasts the loose matter in a cone along the aim (one impulse, so light
     stuff flies farther). It can't lift or knock over solids (no rigid bodies).
  6. **Trowel**: builds Minecraft-style 1 m blocks (3³ cells on a fixed lattice) from the pack against the
     face you aim at; right-click picks the material. The cells are the pack's own, so a sand block slumps.
  7. **Scanner**: the god view's hover readout at the crosshair, at any range: material, temperature,
     pressure, distance.
  8. **Flamethrower** (was the blowtorch): see "Light and fire" below.
  9. **Bomb**: a thrown pipe bomb (18 m/s plus yours, 1 g, on the shared projectiles) that becomes a 5³
     charge of gunpowder where it lands, lit by one detonator cell so the burn runs through it as a wave
     and the blasts stack; the blast is the engine's.
  10. **Pickaxe** (key `0`): the axe's swing with a heavier, pointed head (melee.js, shaders/povTools.js
      `PICK`): a slower blow with more energy in a narrower, deeper patch. It mines rock, a 3×3 face two
      cells deep a swing, into STONE in place for the shovel to pick up. Metal still turns it away.
- Mouse look with pointer lock. `V` toggles first and third person. A crosshair, health and breath bars, and
  screen effects for what the body feels: heat glow at the edges, frost, a red flash
  when hurt.
- Cut for now: crafting, ammo, multiplayer POV (guests get a toast), physgun on solids.

## Inventory (2026-10-10): Garry's Mod's slots and spawn menu

- `src/pov/tools/catalog.js` is the list of tools (plain data: key, slot, start, name, model, desc), so the
  palette lists them without loading the tools. Each `*.tool.js` spreads `...gear('KEY')` into its definition.
- Slots are Half-Life 2's weapon buckets: `SLOTS = ['Dig', 'Build', 'Guns', 'Explosives', 'Gadgets', 'Light']`,
  one number key each. A key picks the tool last held in its slot; pressed again with that slot in hand it steps
  to the next (HL2's `hud_fastswitch`). The bar stays six wide however many tools there are, with a pip per
  tool in a slot and the slot's names shown after a switch.
- `src/pov/tools/inventory.js` is what the player carries: the catalog's `start` tools plus every tool given
  since, kept in localStorage (`tpt3d.pov.given`). It lives outside the toolbelt, so a tool given in the god
  view is in hand at the next drop-in.
- Giving: the palette's Tools group lists every tool (elements.js `GEAR_ITEMS`, ids −300…). A click gives it
  (app.js `giveGear`). In first person, `Q` frees the mouse and shows the palette at those tiles: GMod's
  spawn menu. The SMG, sniper rifle and rocket launcher start out there.

## Guns (2026-10-10)

`tools/firearm.js` is the shared gun (as `melee.js` is the shared swing): the pistol, SMG and sniper are
specs of it. Rounds fly on the shared projectiles (`ballistics.js`) and where they strike,
`shaders/povTrace.js strikeFrag` walks on along the path spending the round's energy by the engine's
projectile rule (each solid broken costs its hardness; powder and liquid cost DENS · DRAG; a solid it can't
break stops it). Nothing is added: struck cells become their own debris or are shoved.

| Gun | Fire | Round energy (sim KE) | Borrowed from |
|---|---|---|---|
| Pistol | every click, up to 10/s; 0.5 s held; spread 1°→6° as you spam | 39: glass, wood, rock's face | HL2/GMod pistol (`weapon_pistol.cpp`) |
| SMG | held, 0.075 s; spread 2°→7° | 22: glass, wood, not rock | HL2 SMG1 |
| Sniper rifle | a click per 1.2 s; right-click scope ×4 | 300, 48 cells deep: ~10 rock or 5 metal | HL2 crossbow's zoom |
| Rocket launcher | a click per 0.8 s; 21 m/s, no drop | `rocketFrag`: crater (ENERGY 90 in 4 cells), fire, pressure 140 out to 9 cells | TF2's Soldier |

- `action.js trigger(interval, { hold })`: `hold` may be a number, the seconds between held repeats (the
  pistol's clicks outpace its held fire).
- A scope: the tool's `zoom()` → `toolbelt.zoom` → `povCam.zoom`; FOV ÷ zoom, look sensitivity scaled with it.
- Your own blast (a `blast` event with no `by`) hurts you at `vitals.js SELF_BLAST_SHARE` for a second
  (Quake III halves self-splash): a rocket at your feet throws you ~5 m and costs about a quarter of your
  health.
- `tools/weapons-check.mjs` checks all of it end to end.

## Light and fire (2026-10-10)

- **Flamethrower** (the blowtorch's key, `BLOWTORCH`; `shaders/povTools.js FLAMER`): Team Fortress 2's Pyro's
  reach, 20 cells (6 m). Every frame the whole cone to what it hits becomes engine FIRE (SPAWN 1), blown along
  the aim, and vfx.js draws it as one stream (the `flame` event). The flame pass is a factory
  (`flameFrag(P)`) shared with a lying torch's `TORCH_FIRE`.
- **Hand lamps** (`tools/lamp.js`, the torch and the lantern, slot 6 'Light'): a point light in the world shader
  (`shaders/gfx/lighting.js lampLight`: inverse-square from LAMP_UNIT, faded to its reach, a traced shadow ray,
  so light doesn't leak through walls). `src/pov/lamps.js` keeps the lit ones and writes `gfxUniforms`
  (`uLampCount`, `uLampPos`, `uLampCol`); at most `gfx/lamps.js LAMP_MAX` at once, a held lamp first. No lamps,
  no cost.
  - Torch: warm and flickering, 18 cells. Left-click touches its flame to what you aim at; right-click throws
    it, and it lies lit where it lands for two minutes, licking a small flame that lights what burns.
  - Lantern: white and much brighter, 40 cells. Left-click switches it; right-click throws it, and it lands
    unbroken and shines until it's one too many (PROPS_MAX per tool).
- Tools may have `tick(ctx)` (every frame in first person, held or not) and `worldReplaced()` (a scene load,
  undo or new grid: what they left in the world goes).
- `tools/lights-check.mjs` checks it at midnight on the GPU.

## Physics rules (non-negotiable, see feedback in project memory)

- Everything obeys the engine. No visual fakes. The world never gets scripted exceptions: a perk (see
  "Perks") may change only what a body can take and do (its tolerances, moves and hands), and when it reaches
  into the world it does so through the engine (cooling cells, adding air pressure). Matter is conserved: a tool that
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
toolbelt = createToolbelt(env) → { update(ctx), select(key), pressSlot(i), zoom, setVisible(bool), windowShifted(dx, dz), dispose() }
// The shell calls setVisible(true/false) on entering/leaving POV, and update(ctx) every POV frame.
// In World the grid is a window that moves over the world (docs/scaling.md D11): the shell calls
// windowShifted when it does, and the toolbelt passes it to every tool.
// The toolbelt listens for the number keys itself (1–5, one per catalog slot) (only while env.isActive()). The wheel comes in ctx.wheel:
// it steps through the tools carried unless the selected tool's wantsWheel?.() returns true, then it goes to the tool.
```

The toolbelt finds tools with `import.meta.glob('./*.tool.js', { eager: true })`. Each tool file
default-exports:

```js
export default {
  ...gear('GUN'),        // key, name, model (models.js: its hotbar icon is a sprite of it), desc: catalog.js
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
- `tools/melee.js` `meleeTool(spec)`: a whole swung tool (the axe, the pickaxe, the knife) from its blow's tuning, pass,
  `HIT` row, refire, body damage and held pose. A new swung tool is a config file; add its impact source to
  `constants.js` `MELEE_SOURCES` so sparks and ricochets treat it as a blow, not a round. Optional: `reach`,
  `bodyBlow(ctx, target)` (this blow on this body: damage, cause, `HIT` row, `lethal`), `tell(ctx, target)`
  (the held model eases to `pose.ready`/`readyPos` while it holds: a lined-up special blow), `pose.thrust`
  (a stab drives forward instead of only turning) and `pose.lethal` (a lethal blow's own motion).
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
  player: { pos, vel, onGround, inLiquid, applyImpulse(dv /* cells/s */), holdPogo() },
}
```

### Knife and pogo stick (2026-10-10, Big Team Battle)

| Tool | Key | What | Where the rules come from |
|---|---|---|---|
| Knife (`KNIFE`, Dig slot with the axe) | `knife.tool.js` | `meleeTool` with a thrust. From behind a body it kills outright, through any shield (`hurt(..., { lethal: true })`); anywhere else a stab of 0.34 × 40/65 ≈ 0.21 (the axe's blow × TF2's knife over its Fire Axe). While a backstab is lined up the knife comes up (the tell), and a backstab plunges with its own motion. Reach 4.4 cells (TF2's 48 HU trace + 18 HU hull, scaled from an 82 HU player to this body); 0.8 s refire. Its cell blow (`povTools.js` `KNIFE`, energy 7) cuts a plant or chips ice where it lands, nothing harder. | TF2: `CTFKnife::IsBehindAndFacingTarget` on the ground plane: `dot(myFwd, toTarget) > 0.5`, `dot(itsFwd, toTarget) > 0`, `dot(myFwd, itsFwd) > −0.3`. A target needs `facing(out)` (targets.js; the player and NPCs have it) to be backstabbed. |
| Pogo stick (`POGO`, Gadgets slot) | `pogo.tool.js` + player.js | While held (`ctx.player.holdPogo()` every frame) every landing bounces. A press of jump within 0.21 s of a landing (before or after) climbs a step; a landing without one drops back. Heights, as shares of the body's 1.9 m jump: 0.67, then +0.68 a step, three steps (≈ 1.3, 2.6, 3.9, 5.3 m). Not off liquid (swimming stops it). The spring takes landings and head bonks up to the top bounce's speed (no 'land', no slam). A tap is a bounce, holding jump past the window flies the jetpack. Body event `pogo` `{ step, timed, late?, speed }` (late: a press just after the bounce stepped the same bounce up). | Commander Keen 4 (Omnispeak `ck_keen.c`, `ck_phys.c`, 70 tics/s): a bounce leaves at −48 against a jump's −40 and heeds the button for its timer's first 15 of 24 tics; simulated, Keen's jump rises 1124 units, a released bounce 750, a held one 1518. Super Mario 64's triple jump for the three timed steps. |

Both are catalog `GEAR` entries (`...gear('KNIFE')`, `...gear('POGO')`), not start tools: the palette's Tools
group, Q in first person, or a class (classes.js: the Scout's pogo, the Spy's knife) gives them.

## Gunplay v2 (2026-10-08): events and ownership

Gunplay v2 follows the Gunplay Feel Lab's recommendations: ballistic rounds handed to the sim at impact,
ZzFX sound through PositionalAudio, CC0 glTF viewmodels with spring recoil and sway, three.quarks VFX,
camera kick, trauma shake and a hitmarker, plus an optional realistic body (Quaternius) next to the stickman.

### Events (`src/pov/events.js`)

`povEvents.emit(name, payload)` / `povEvents.on(name, fn)`. Positions are **grid cells** (Vector3) unless they
say world. Emitters own their event names. Listeners never mutate payloads.

| Event | Emitted by | Payload |
|---|---|---|
| `blast` | bomb, rocket | `{ point }` grid. A charge or rocket went off there (sound, shake, fireball; with no `by`, the player's own: less blast damage). |
| `punch` | `rig.hit` (viewmodel.js `HIT`) | `{ pitch, yaw }` rad, + up and + left. Throws the view punch (feel.js). |
| `gun:fire` | pistol, SMG, sniper, rocket | `{ origin, dir, muzzleWorld, gun, sound }`. The round left the muzzle (origin grid, dir unit; muzzleWorld is the viewmodel muzzle in world space, for the flash; gun the tool key; sound `{ rate, gain, thump, voice }` scales the pistol's shot). |
| `gun:dry` | gun | `{}`. The trigger clicked but nothing fired (muzzle blocked). |
| `round:move` | guns, bomb, rocket | `{ id, kind, from, to }` (kind 'round', 'bomb' or 'rocket'). A round in flight moved this frame (grid), for tracers and the rocket's smoke. |
| `round:end` | guns, bomb, rocket | `{ id, kind }`. The round is gone (impact or out of the box). |
| `impact` | gun, axe, pickaxe, knife | `{ source: 'gun'\|'axe'\|'pickaxe'\|'knife', point, normal, id, energy, broke, body?, backstab? }` (body: a target, not a cell, was hit; id −1; backstab: the knife's lethal blow). Something was struck. id is the element hit, energy is ½·DENS·v² in sim units, and broke is true/false when the striker knows, else null. |
| `tool:action` | shovel, bucket, axe, pickaxe, knife, physgun, trowel, blowtorch, bomb | `{ tool, action, id?, point?, amount? }`. tool is 'shovel'\|'bucket'\|'axe'\|'pickaxe'\|'knife'\|'physgun'\|'trowel'\|'blowtorch'\|'bomb'; action is 'dig'\|'place'\|'on'\|'off'\|'throw'\|'dump'\|'scoop'\|'pour'\|'swing'\|'refuse'\|'grab'\|'fling'\|'release'\|'blast'. Physgun 'hold' state is read from the tool, not an event. |
| `player:step` | shell (camera bob cycle) | `{ speed, inLiquid }`. A footfall. |
| `player:jet` | player | `{ on }`. The jetpack lit or went out. |
| `perk:take` | shell | `{ key, keys, point, by? }`. A body took a perk orb: key is the orb's, keys what it gained (Gamble's two). |
| `perk:revive` | shell | `{ point }`. Extra Life brought the player back. |

The player's own events (`player.on('hurt'|'death'|'land'|'splash'|'revive'|'revenge')`) stay as they are; listeners subscribe there too.

### Ownership (v2)

| Area | Owner | Files |
|---|---|---|
| Ballistic rounds, GPU segment trace, impact handoff | gun | `src/pov/tools/gun.tool.js` (all but `buildModel`), `src/pov/ballistics.js`, `src/shaders/povTrace.js` |
| Viewmodels (procedural RuneScape-style models), viewmodel rig (spring recoil, sway), overlay render pass, tool emits | viewmodels | `src/pov/models.js`, `src/pov/viewmodel.js`, the model-building code in every `*.tool.js` (and `buildModel` in gun.tool.js), `tool:action` emits in shovel/bucket/axe/physgun, the overlay hook in `src/app.js` |
| Camera kick, trauma shake, hitmarker, crosshair bloom, three.quarks VFX (flash, sparks, dust, tracer), footsteps | feel | `src/pov/feel.js`, `src/pov/vfx.js`, `src/pov/camera.js`, `src/pov/hud.js`, `src/pov/pov.css`, `src/pov/index.js` |
| Sound (ZzFX + PositionalAudio) for every POV event | audio | `src/pov/audio.js` (+ one wiring line in `src/pov/index.js`) |
| Realistic body (Quaternius, AnimationMixer) behind a Stickman/Realistic setting | character | `public/models/character/**`, `src/pov/figureReal.js`, the settings row in `src/app.js`, a figure switch in `src/pov/index.js` |

## NPCs (2026-10-09): enemies that use every tool

NPCs come from **spawners** (`src/spawners.js`), the palette's Entities group: an **Axeman**, **Gunner** or
**Worm** or **Giant worm spawner** (kinds `enemy`, `gunner`, `worm`, `giantworm`; an old `enemy` spawner is an axeman) keeps one creature of
its kind alive on its spot while in POV (it appears there and comes back 8 s after dying; up to 8 of each), and
a **Player spawn** is where F drops you in (the one nearest the cursor) and where you respawn. Click a spawner
again with its tool to remove it. Spawners stand on world cells like signs; a new scene clears them, and the lab
comes with one axeman spawner on its open south floor. Gunners and worms are spawnable only: no scene or world
places them. Not in worlds (the window): NPCs don't follow it yet.
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

### Creatures (2026-10-10): Noita's worms and jetpack gunners

**Worm** (`src/pov/worm.js`, Noita's Mato, `data/entities/animals/worm.xml`). Noita's numbers scaled as the
player's are (Mina's 11 px = the body's 5.5 cells): hit radius 5 px = 2.5 cells, parts 10 px apart, hp 10 =
2.5 of the player's lives, hunt box 256 px = 128 cells, hunting at Mina's run (Noita's speed 2 : speed_hunt 4, so
a unit of Noita's worm speed is a quarter of Mina's run). The **giant worm** (`WORM_SIZE.giant`, worm_big.xml,
Jättimato): hit radius 9 px = 4.5 cells, parts 16 px apart (64 cells, 19 m, long), hp 70 (17.5 lives), speed 4 :
speed_hunt 5, and a wider bite (`WORM_GIANT_BITE`, its own pass) for its 9 px eating disc.

| Sub-problem | How |
|---|---|
| Body | a chain of segments a fixed arc length apart along the head's trail (the classic snake), so the body follows the head into its hole and out of its breach; one `InstancedMesh` plus a head with hinged jaws, lit like the volume (`figure.js` `figureFrag`) |
| Steering | the head is a Yuka `Vehicle`: seek, pursuit and wander in 3D, its turn bounded by the steering force (`maxForce` = 4 rad/s × speed) |
| In matter or not | the CPU world model (`ai/world.js`) at the head and every segment: while the head or ¾ of the body is in matter it steers (the buried body is what it pushes off); past that it flies ballistic at the world's gravity (`ROUND_GRAVITY`), so it breaches in an arc and falls back in |
| The hunt | Noita's pass: stalk under the body (deep enough to turn up), lunge up at it (pursuit until level, then straight on through, fast enough for a 3-body-height leap), dive on ahead and down, come round again |
| Digging | every 2 cells the head moves (at most 30 a second), the pickaxe's GPU blow (`shaders/povTools.js` `blowFrag` with `WORM_BITE`: energy 45 in a 4-cell ball) breaks what its energy beats into its debris in place (rock → stone, wood → sawdust) and, with `PART`, pushes powder and liquid out from its axis. Nothing is deleted: it leaves a tunnel of rubble. WALL, CLONE, METAL and the box stop the head (it slides along them, axis by axis) |
| Senses | the nearest live body (the player or an NPC: `targets.js` `allTargets`) within 128 cells, through the ground; else the last gunshot (`gun:fire`, 256 cells) or blast (`blast`, 384 cells) for 4 s; else it roams 8 cells under the surface near home |
| Bite | a body's box within 1.2 head radii: `target.hurt(0.5, 'Eaten by a worm', heading)` (the player takes half: Noita's 25 of Mina's 100), once a second, inside `povEvents.as` so `player:hit` carries the worm's id; an `impact` with source `worm` |
| Hurt | every segment is a target (`creature: 'worm'`), so the axe, guns, knife and blasts hit it where it is; heat over 300 °C at the head burns it. Its own `on('hurt')` gives `{ amount, cause, point }` (where bleeding plugs in), and `on('death')` |
| Stranded | out of matter and nearly still (on a WALL floor), its body slumps under gravity; dead, it drops and stays 4 s |

**Jetpack gunner** (`npc.js` with `style: 'gunner'`, mind `ai/gunner.js`, Noita's jetpack Hiisi): the axeman's
body, kit and `Agent` with another set of strategies: **Engage** (it sees you), then brain.js's Hunt, Extinguish
and Wander. Engage keeps its range (backs off inside 16 cells, closes beyond 40, strafes in between, switching
side every 1.2–2.8 s), flies (jumps, then holds the jet under a vantage two body heights over your feet and lets
it go above, so it hovers) and lands when the tank is under 20% until it's 95% full again (the tank refills in
0.5 s on the ground: player.js), and shoots: the pistol, SMG (0.6 s bursts) or sniper rifle, by Raven's fuzzy
distance rules, with the axeman's reaction delay, warning shot and aim ramp. It wears olive with amber eyes.
`npc.debug` adds `style`, `range` (strafe, back off, close in), `flight` (take off, hover, refuel, ground), `fuel`.

Check: `node tools/creatures-check.mjs [--port …] [--shot file.jpg]` (a dev server; AC power): a worm spawned on
rock tunnels toward you, breaches and bites, its tunnel is stone rubble (rock + stone conserved), WALL stops it,
the pistol kills it; the gunner flies, refuels, shoots and backs off when you close in. The worm's movement also
runs on the CPU against a fake world model, no GPU or browser: `node tools/worm-cpu-check.mjs [wall] [giant]`.

## Perks (2026-10-10): Noita's, in a falling-sand world

Perks come from shrines, Noita's Holy Mountain: the Shrine construction (`constructions/builtins.js` `shrine`, a
fixed-size stone pavilion with three plinths) with a random perk orb floating over each plinth
(`SHRINE_ALTARS`; `constructions.js` hands their grid cells to `onPlaced`, and app.js sets the orbs). The orbs
(`src/perkOrbs.js`) are markers pinned to world cells, like the spawners: the perk's icon at chest height over a
pad. A body (the player's or an NPC's) that walks into one, or stands against its plinth, gains the perk
(`pov/index.js` `takePerks`), and the shrine's other orbs vanish. Undoing a placed shrine takes its orbs too (the
undo snapshot's `note`). A new scene clears the orbs.

Every world gets a shrine (app.js `worldShrine`) once its first window loads: on flat dry ground near the window's
middle, where the god view starts, scored by rise, trees in the way and distance. The island's trees around it
are felled (each regenerated and stamped over with air, `runtime.js` `bakedAir`), so it stands in a clearing. It is
stamped into the window like a placed construction, so the window keeps it as an edit.

Every perk stacks. The list and its sizes are in `pov/perks.js`; a body's set is `player.perks`
(`createPerkSet`: `count`, `has`, `add`, `take`, `list`, and what the stacks add up to). Death takes them, unless
Extra Life brings the body back where it fell.

| Perk (Noita's) | Here | Where | Another stack |
|---|---|---|---|
| Breathless | breath never drains | vitals.js | — |
| Fire Immunity | the skin never burns (you float on lava: 9.8 < 25) | vitals.js | — |
| Explosion Immunity | no blast or slam damage; blasts still throw you | vitals.js | — |
| Freeze Field | liquids and fire within reach lose 600 °C/s down to −20 °C; the engine freezes water, sets lava, puts fire out. A column from your feet up is left alone, so you stand on the ice | player.js + povBody.js `povFieldFrag` | reaches further |
| Lukki Mutation | while a wall or ceiling is within reach, the jet fires on an empty tank and the tank holds | player.js `clinging` | — |
| Sand Swimmer (Dissolve Powders) | powders don't block the body; it swims in them at neutral buoyancy (matter stays conserved: the grains are pushed aside, not deleted). Still chokes: take Breathless | player.js | — |
| Revenge Explosion | a hurt adds air pressure in a shell around the body (it sits in the eye), once a second | player.js + `povFieldFrag` | harder, wider |
| Saving Grace | a blow that would kill from above 1% leaves 1% | vitals.js | — |
| Extra Life | death brings you back where you fell, full health, perks kept | vitals.js (`revive`) | one more life |
| Extra Health | every hurt is divided by 1 + 0.5 per stack (health stays 0..1) | vitals.js | +50% |
| Faster Tools (Faster Wands) | every tool's clock runs 2× (`tools/action.js` `toolDt`: refire waits, swings, digging, pouring, the torch's heat, the physgun's blast cooldown), via `ctx.toolRate` | action.js | 2× again, up to 16× |
| Gamble | two random other perks, not kept itself | perks.js `grant` | — |
| Energy Shield (Halo 3's) | a shield of 70/45 of a life over health. Blows, blasts and slams hit it first and what's left goes on to health; heat, cold, acid and choking get past it; a lethal blow (a backstab) ignores it. Any hurt holds the refill off 5 s, then it fills in 2 s. Body event `shield` `{ state: 'hit'\|'break'\|'recharge'\|'full' }`; the HUD's bar above health flashes, pops, blinks red while empty and sweeps as it refills; sounds for each and an empty alarm | vitals.js, hud.js, audio.js | +70/45 of a life |
| Fleet Foot | sprint ×2 | player.js | ×2 again, capped at 60 cells/s (a blast's throw: the probe keeps up) |
| Rocket Boots | jet climb and fly speed ×2 | player.js | ×2 again, capped at 60 cells/s sideways and 175 up (Noita's fastest fall) |
| Big Tank | jet fuel ×2: twice the time aloft (the refill rates are Noita's, so it fills slower too) | player.js | ×2 again |

A new tool gets Faster Tools for free by timing its actions with `trigger` and `toolDt(ctx)` instead of `ctx.dt`.
NPC bodies carry perks too (npc.js passes `toolRate` into its kit's ctx).

Check: `node tools/perks-check.mjs [--port …] [--shot file.jpg] [--worldshot file.jpg]` (a dev server; AC power).
Combat (shield, movement perks, knife, pogo): `node tools/combat-check.mjs [--port …] [--shot file.jpg]`.

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
