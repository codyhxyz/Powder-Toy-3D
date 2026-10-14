# POV mode: design and module contract

## The experience

"I made this world, now I'm standing in it, and it can kill me." TPT's stickman in 3D.

- **Drop in / pop out** (`V`, Garry's Mod's noclip: the god view is the noclip camera, the body is clipped).
  From the god view, `V` drops a body onto the surface under the cursor (or the middle of the box); `F` does
  too, for habit. The camera swoops from orbit into the eyes. `V` again swoops back out to the orbit pose you
  left. The sim keeps running in both modes.
- **Keys speak other games' language**: `V` god view or the body (Garry's Mod's noclip key; from the god
  view `F` drops in too), `F5` first or third person (Minecraft), `Z` held zooms (Minecraft's zoom mods,
  `zoom.js`, with Zoomify's defaults: ÷4 eased in over 1 s and out over 0.5 s, the wheel ×1.5 a notch while
  held, the look slowed with the view, a scope's zoom multiplied in), `C` held crouches (PUBG's and Apex's key,
  Source's duck: below), `F` kicks (in a Halo match: Halo's melee), `G` throws a frag grenade in a Halo match
  (Halo: MCC's PC key; `docs/modes.md` "Halo combat").
- **Crouch** (`C` held, player.js `crouchStep`, Source's gamemovement.cpp numbers): the body goes to half its
  height (hull 36 of 72) and the eye to 28/64 of its height, in 0.4 s down and 0.2 s up; on the ground it
  moves at a third of the speed and can't sprint. On the ground it shrinks from the top; in the air the feet
  tuck up to the head (Source's crouch-jump: the head and the rope's hand stay put). Standing back up needs
  the room: under a low ceiling it stays crouched until it's out. In liquid `C` swims down instead. The
  stickman squats (figure.js `CROUCH_POSE`, the pelvis dropped so the feet stay down); the realistic body has
  no crouch clip, so figureReal.js bends its pelvis, spine, thighs, calves and feet on top of the clips.
- **The body** (setting: Realistic | Stickman, key `character`): Realistic is the default: Quaternius's
  Superhero Male (Universal Base Characters, CC0), his muscles sculpted into the mesh and its normal map,
  playing Universal Animation Library clips retargeted onto his skeleton (`tools/character-pack.mjs`:
  each bone keeps the mannequin's world-space turn off its rest pose). A wizard in a pointed hat skinned
  to his head (garb.js) and boxers dyed the hat's purple when the model is packed. The robe was dropped
  on 2026-10-11 so the abs show. Stickman stands in while it loads.
  Player bodies and wizard NPCs carry visible jetpacks. Flames and particles leave the animated nozzle mouths,
  following the torso's pose and body size (`figure.js`, `buildJetpack`).
  The Castle Crashers wizard (figureCrasher.js: the stickman's rig with a huge hooded head, glowing eyes,
  outlines and cel shading) was a choice and the default until 2026-10-10; now it only draws the NPCs and
  the class portraits.
- **Physical, finite tools in Half-Life 2 / Garry's Mod weapon slots** (see "Inventory" below): keys `1`–`5`
  are slots (Dig, Build, Guns, Explosives, Gadgets); pressing one again steps to the next tool in it, and the
  wheel steps through everything carried. God powers (infinite painting) stay in god view, one `V` away. The
  list below is the original ten; the guns and the rocket launcher are under "Guns" below.
  1. **Shovel**: digs like Minecraft's (`tools/dig.js`): each click (or every 0.15 s held) takes the
     outlined bite, 3 cells deep behind the face you aim at and the trowel's 3×3 lattice square across it,
     into the **pack** (the inventory, `transfer.js` `pack()`, Minecraft's 36 × 64 blocks). Powder comes up in
     one dig, and so does soil (grass and plants, moss, fungus); wood is the axe's and rock the pickaxe's (`dig.js` `material`,
     Minecraft's best tool per block): they refuse with a toast naming the tool. Right-click throws a block's
     worth from it where you aim; hold to keep throwing. Third person plays its dig and toss (`holds.js` GESTURES).
     The aimed bite's outline and cracks are drawn on the surface itself (`surface.js` `digMark`, FrameUniforms
     `digMin`/`digMax`), so they follow a trunk or a slope.
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
  8. **Flamethrower** (was the blowtorch): see "Light and fire" below.
  9. **Bomb**: a thrown pipe bomb (18 m/s plus yours, 1 g, on the shared projectiles) that becomes a 5³
     charge of gunpowder where it lands, lit by one detonator cell so the burn runs through it as a wave
     and the blasts stack; the blast is the engine's.
  10. **Pickaxe** (key `0`): the axe's swing with a heavier, pointed head (melee.js `dig`), at the HL2
      crowbar's 0.4 s. Each blow digs the outlined bite (`tools/dig.js`, the shovel's) whole: rock and
      anything softer in one blow, as its debris (ROCK → STONE) into the pack. Wood it leaves to the axe;
      nothing harder than its blow's energy (`PICK.ENERGY` 52): metal still turns it away.
      Digging sounds are recorded (`public/sfx/dig`, Kenney's Impact Sounds, CC0): the blade's bite over its
      material's texture (sand, gravel, soil), strikes by material (rock, glass, metal, wood), a load's thud.
- Mouse look with pointer lock. `F5` toggles first and third person. A crosshair, health and breath bars, and
  screen effects for what the body feels: heat glow at the edges, frost, a red flash
  when hurt.
- Cut for now: crafting, ammo, multiplayer POV (guests get a toast), physgun on solids.

## Touch controls (2026-10-10)

Phones and tablets (`(hover: none) and (pointer: coarse)`, `touch.js` `TOUCH_MEDIA`) get thumb controls in
first person; nothing changes on desktop. The topbar's God / 1st / 3rd camera choices stay visible on touch
(a second row under the bar when narrow), so a phone can drop in and leave.

- **Left thumb**: a move stick, analog; pushed to its rim it sprints. Driving, it throttles and steers.
- **Right thumb**: the held tool's two buttons, named by its catalog entry (`catalog.js` `touch`: [left-click,
  right-click]; a tool with none, like the pogo stick, shows none), Nearer / Farther while the tool takes the
  wheel (the physgun holding), Kick, Vehicle (when there are any: get in or out), Crouch (Dive in liquid) and
  Jump (hold to fly; Brake when driving). Tools are picked by tapping the hotbar.
- **Look**: a one-finger drag anywhere else on the scene, as mouse movement (the Sensitivity setting applies).
  A look drag never fires a tool.
- One input path: `touch.js` only fills the inputs the keyboard and mouse fill in `index.js` (`readInput`'s
  keys, `buttons`, `wheelNotches`, `kickQueued`, `useVehicle`), so the body, vehicles and tools can't tell
  them apart. There's no pointer lock on touch (`canUse()` stands in for `isLocked()`), and a tap that starts
  and ends between two frames still holds its button for one.
- Not on touch yet: Z zoom, Q tools menu, H drink (the flask), F5 (use the 3rd camera button), early respawn.

## Inventory (2026-10-10): Garry's Mod's slots and spawn menu

- `src/pov/tools/catalog.js` is the list of tools (plain data: key, slot, start, name, model, desc), so the
  palette lists them without loading the tools. Each `*.tool.js` spreads `...gear('KEY')` into its definition.
- Slots are Half-Life 2's weapon buckets: `SLOTS = ['Dig', 'Build', 'Guns', 'Explosives', 'Gadgets', 'Light']`,
  one number key each. A key picks the tool last held in its slot; pressed again with that slot in hand it steps
  to the next (HL2's `hud_fastswitch`). The bar has six labeled slots, each with a tool-position counter.
  Switching shows a vertical list with icons, names, an Equipped marker, and a cycling hint.
  The list closes after four seconds of inactivity; the equipped name stays visible.
  With the pointer unlocked, clicking a row equips that tool. Holding a number key does not cycle repeatedly.
- `src/pov/tools/inventory.js` is what the player carries: every tool in the catalog, in its slot, from the
  first drop-in, as GMod gives you every weapon (2026-10-10; before, only `start` tools were carried and the
  rest waited in the spawn menu). A new tool needs only its catalog entry. It lives outside the toolbelt, so
  a tool picked in the god view is in hand at the next drop-in.
- Picking from the palette: the Tools group lists every tool (elements.js `GEAR_ITEMS`, ids −300…). A click
  puts it in hand (app.js `giveGear`). In first person, `Q` frees the mouse and shows the palette where it was
  last left (at first, at what's selected): GMod's spawn menu. Anything that isn't a tool loads the tool gun. `Q` does nothing in a Halo-style match
  (`docs/modes.md` "Halo rules").
- **A restricted hotbar** (2026-10-11, a Halo match's two guns): `toolbelt.restrict(keys, hold?)` lets only `keys`
  be in hand, each in a slot of its own in their order (the bar shows `1 Primary`, `2 Secondary` and hides the
  rest: `hotbar.setLabels`), so `1` and `2` hold Halo's primary and secondary; the wheel steps between them, there are no wands (`B` and `equipWand` refuse) and `select()` refuses anything else, so the palette, a
  class or the spawn menu can't put another tool in hand. `hold` (else the first key, if the tool in hand isn't
  one of them) goes in hand. `restrict(null)` gives every tool back; `toolbelt.restricted` reads the keys.
  `toolbelt.setNote(key, text)` shows text after the tool's status in the held-tool corner (a power weapon's
  shots left); null clears it. Owner: `src/game/arsenal.js`.

## Tool gun (2026-10-11): Garry's Mod's `gmod_tool`

The spawn menu used to be no use in first person: picking an element only set the god view's brush. Now
anything picked from it in first person (an element, a brush tool, lightning, a sign, a spawner, a
construction) loads the **tool gun** (`tools/toolgun.tool.js`, slot 2 Build, last in `GEAR` so the palette
ids before it stay put) and puts it in hand (app.js `loadToolGun`). This reverses v1's "no infinite
painting in POV": GMod's sandbox spawns without limit, and the user asked for it.

- The gun does what a click does in the god view, at the crosshair: app.js `toolGun` runs the same
  `clickTool()` (signs, lightning, spawners, constructions) and `startStroke()` as the god view's `press()`.
  In first person `hover` already follows the crosshair (`requestPick`), so nothing new is picked.
- Left: one-click tools act per click; an element or a brush tool paints while held, at the brush size,
  flow, shape and Replace set in the menu's options pane. Right (held): erase, The Powder Toy's right button
  (its secondary element starts as nothing). Middle: pick up the material under the crosshair, Minecraft
  creative's pick block (app.js canvas `pointerdown`).
- An element's stroke stays at the distance it started at, along the aim (`strokeDist`), as the god view's
  stays on its drag plane, so a held pour doesn't climb its own heap toward your face. Started at the sky,
  it pours `HAND_REACH` ahead. A brush tool's stroke (erase, heat, cool) follows the crosshair, so a held
  eraser tunnels into what it works on.
- The brush and the construction ghost show only while the gun is out: the tool calls `toolGun.aim()` every
  frame and `updateGunBrush` takes it once. The construction ghost has no pointer to move off what was just
  placed, so `builds.update({ crosshair: true })` drops its hold and the ghost comes straight back.
- Each stroke or click is one undo step, as in the god view. A guest's strokes go to the host (`mp.paint`).
- The gun's screen (the model's part named `screen`) shows the loaded item's colour; its readout by the
  crosshair names it. An NPC's kit has no `env.toolGun`: the gun is carried but does nothing.

## Guns (2026-10-10)

`tools/firearm.js` is the shared gun (as `melee.js` is the shared swing): the pistol, SMG and sniper are
specs of it. Rounds fly on the shared projectiles (`ballistics.js`) and where they strike,
`shaders/povTrace.js strikeFrag` walks on along the path spending the round's energy by the engine's
projectile rule (each solid broken costs its hardness; powder and liquid cost DENS · DRAG; a solid it can't
break stops it). Nothing is added: struck cells become their own debris or are shoved.

First-person bullets start at the rendered eye, along the camera direction, including recoil and head bob.
This follows Source's eye-origin rule (`CBasePlayer::Weapon_ShootPosition` in Valve's `baseplayer_shared.cpp`).
Spread surrounds that direction. Barrel animation and delayed hover results cannot steer the shot.
The flash stays on the barrel. The first tracer segment connects the barrel to the bullet's real path.
At point-blank range, the tracer starts at the eye instead of behind the hit.
NPCs and the third-person fallback use their own body-eye aim.
NPCs keep their equipped weapon visible between attacks, with the handle in the mitten and the barrel along their aim.
Their muzzle flash and first tracer segment use that visible barrel, not the head or the hidden viewmodel.
`node tools/npc-held-check.mjs` checks these poses and effects without a GPU.
`node tools/firearm-aim-check.mjs` checks alignment without a GPU.

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

## Burrower and laser cannon (2026-10-10)

Two heavy weapons, not `start` tools (palette Tools group or Q). Passes: `shaders/povBore.js`; check:
`tools/burrower-laser-check.mjs`; CPU aim regression: `tools/burrower-aim-cpu-check.mjs`. Neither adds matter.

**Burrower** (Explosives, `burrower.tool.js`): Cruelty Squad's Cerebral Bore, no health cost.
- It flies straight along the crosshair direction at launch, with no homing or steering after launch.
  In the open it flies at 12 m/s. Lead moving targets yourself.
- Speed through matter is power over work (Teale 1965: penetration rate = P / (SE·A)): `POWER` / Σ over the
  3.5-cell face disc of HARD (solids) or DENS·DRAG (powder, liquid). Sand runs at ~15 cells/s, rock ~8 and
  metal ~4. WALL on its axis stops it. A small readback pass (`burrowProbeFrag`, 12 slices ahead) tells
  the CPU what is ahead.
- `burrowFrag` turns the bored solids into their own debris. A muck conveyor along the bore carries loose
  cuttings to the mouth and throws them out in an arc (`SPOIL_LIFT`, `APRON`), so they heap well clear of
  the mouth. This is a tunnel-boring machine's belt, a game liberty: the drill acts all along its bore while
  it runs and for `CONVEY_AFTER` 2.5 s after. Tested: without the arc, the heap at the mouth dams the tunnel.
  The 2.1 m tunnel is walkable.
- On reaching a body: `hurt(1, 'Bored')` (one kills), then it stops. There is no blast. Its lifetime is 12 s;
  stuck for 1.5 s, it gives up.

**Laser cannon** (Guns, `laser.tool.js`): Halo's Spartan Laser. Halopedia gives "approximately three seconds"
of charge, an abortable charge and "approximately two seconds" of standby between shots. So: hold to charge
(`CHARGE_S` 3), it fires itself when full, releasing early cancels, and you press again after `REFIRE_S` 2.
- Energy model: heat, not impact. Every power number is in povBore.js `LASER`, so a nerf is one edit.
- The reach is the lumped heat balance of laser drilling (Steen & Mazumder, *Laser Material Processing*).
  Each cell on the axis costs CAP·(VAPOR_T − T)·π·CORE² of the beam's `ENERGY` (2.22 M), so it goes
  ~119 cells through rock, ~70 through metal and ~59 through water. WALL and the floor stop it.
- Core (r ≤ 2): vaporised. It becomes STEAM (water, ice, snow), FIRE (burnables) or SMOKE (the rest), at
  3000 °C, blown back.
- Rim (r ≤ 5): heated from 4500 down to 1600 °C, and the engine melts metal, glass and stone, boils water and
  lights wood.
- r is from the bore: the axis up to where the beam stopped, then from that point, so the hole's hot end is
  round (2026-10-11). The rim used to be cut flat there, so a surface met at a slant got only the near half of
  the ring, a crescent, and WALL hit square on got nothing.
- WALL and CLONE are heated but not vaporised (the spot the beam stops on glows), and the heat doesn't pass
  them: a cell with one between it and the bore stays as it is (`LASER.SHADOW_STEP`). Before, it heated the
  lava behind the Lab pit's wall.
- ROCK can't melt in this engine, so the rim spalls it into STONE first (thermal spallation, Rauenzahn &
  Tester 1989), which then melts into lava.
- The rim's heat isn't charged to `ENERGY`.
- Tested: with the first rim (r 3, 2400→1300 °C), the engine's conduction cooled it below stone's melt in
  under a second, leaving 21 lava cells. The hotter, thicker rim leaves ~300 that pour out of the tunnel.
- Bodies anywhere in the beam take 2 (`beamTargets`). The reach comes from `laserReachFrag`, read back
  synchronously once a shot. There is no recoil (light carries next to no momentum); `HIT.LASER` and a
  `shake` give the feel.

## Light and fire (2026-10-10)

- **Flamethrower** (the blowtorch's key, `BLOWTORCH`; `shaders/povTools.js FLAMER`): Team Fortress 2's Pyro's
  reach, 20 cells (6 m). Every frame the whole cone to what it hits becomes engine FIRE (SPAWN 1), blown along
  the aim, and vfx.js draws it as one stream (the `flame` event). The flame pass is a factory
  (`flameFrag(P)`) shared with a lying torch's `TORCH_FIRE`.
- **Hand lamps** (`tools/lamp.js`, the torch and the lantern, slot 6 'Light'): a point light in the world shader
  (`shaders/gfx/lighting.js lampLight`: Unreal's soft inverse-square, (U² + s²)/(d² + s²) with s =
  `gfx/lamps.js LAMP_SOFT`, windowed by (1 − (d/R)⁴)², so it carries out to most of its reach; a traced
  shadow ray, so light doesn't leak through walls). In hand the light hangs at your right side (lamp.js
  `HELD_LIGHT`, inside the body's box so never in a wall), not at the eye, so what it lights has shadows.
  `src/pov/lamps.js` keeps the lit ones and writes `gfxUniforms` (`uLampCount`, `uLampPos`, `uLampCol`); at
  most `gfx/lamps.js LAMP_MAX` at once, a held lamp first. No lamps, no cost.
  - Torch: warm and flickering (value noise with now and then a gutter), 34 cells. Its flame is `pov/flame.js`:
    a noise flame on a card that faces the eye and stands along the world's up (in the hand, partly the
    screen's), with a wider torn outer flame and a glow card; it trails when you swing or run (the air past
    it), flickers with the light, lights the hand and torch in the viewmodel pass (a point light), and throws
    embers (vfx.js, `torch:burn`). In the hand it is drawn on `viewmodel.js VIEWMODEL_GLOW_LAYER`: added over
    the finished frame and tone mapped by itself. The model is a stave with a leather grip, an iron cup and a
    tarred, corded head with glowing coals on top (models.js `ember` material). Left-click touches its heat
    to what you aim at; right-click throws it, and it lies lit where it lands for two minutes, its heat
    (`TORCH_FIRE`, no FIRE in the air) lighting what it lies on or touches in about a second.
    `tools/torch-look.mjs` takes stills of it held, thrown, turning and by day.
  - Lantern: white and much brighter, 40 cells. Left-click switches it; right-click throws it, and it lands
    unbroken and shines until it's one too many (PROPS_MAX per tool).
- Tools may have `tick(ctx)` (every frame in first person, held or not) and `worldReplaced()` (a scene load,
  undo or new grid: what they left in the world goes).
- `tools/lights-check.mjs` checks it at midnight on the GPU.

## Kick (2026-10-10): Cruelty Squad's, on `F`

- Always to hand, no hotbar slot: `F` (`kick.js KICK_KEY`). In the body F is free since the keys moved (V god view, F5
  first/third, Z zoom, C crouch); from the god view F still drops in.
  It is a body ability, `player.kick(dir)`, so an NPC's body has it too (the brain doesn't use it yet).
- A blow from the hip (2.6 cells up) along the aim, reaching 1.2 m. What it meets first: a body (`targets.js`)
  takes Noita's kick damage (0.04) and a shove (`target.shove(dv)`; `hurt(..., null)` adds no knockback of its
  own); a cell, read from the body's own probe, takes the boot over Noita's kick radius (3 px = 1.5 cells,
  `shaders/povKick.js KICK`): weak solids break into debris by the melee energy rule (ENERGY 16: glass, ice,
  plants; not wood, rock or metal) and loose matter and the debris are shoved.
- **Momentum, `pov/tug.js`:** the foot drives the pair apart at 14 m/s (a martial artist's front kick; it is
  also a Noita jump's speed), split by inverse mass. A body is 70 kg, the struck lump what its cells weigh,
  and a solid the boot doesn't break, or the floor, is anchored (infinite). Broken debris counts over the
  patch (falloff-weighted); loose matter has no cohesion, so only the cell under the sole counts and moves
  (`SOLE_CELLS`; a 30 cm cell of sand is 43 kg, so it leaves at ~9 m/s): you kick the bit of a heap in front
  of your foot, never the whole heap. A boot under a heap lifts what rests on it, so the clump that flies
  is the top of the struck column (`SURFACE_REACH` 3 cells). It's thrown up and forward at `SPLASH_ANGLE` (50°: splashed sand
  leaves its bed at 40-60°), so a kick into a pile throws sand out of it instead of driving it into the
  ground, and flies as a projectile (`ballistics.js`, kind `grain`: real speed, real 1 g, a dust trail of
  its colour off `kick:grain`) until it lands, where it goes back into the sim at its arrival speed. It's
  taken out and put back through the cell transfer, as the shovel and the hook move matter, so none is
  lost or made: on the sim's fast clock a real kick's few m/s would stop within a cell. An NPC's body has
  no projectile engine, so its kicked sand is set down at the end of its reach. So kicking a wall in the air throws you off it at 14 m/s,
  kicking the floor lifts you about a jump's height, kicked sand or water flies, and a body takes half. Standing, the ground braces you (sideways and downward
  absorbed), as with the gun's recoil. The reaction is one `applyImpulse`, which the Noita ease then treats
  like a rocket's push.
- Shows: the figure's front kick (`figure.js s.kick`: chamber, extend, retract), a boot swung up into the
  viewmodel (`createKickLeg`), `HIT.KICK`'s view jolt, `kick` event and sounds (whoosh, a thud on a body or
  an anchored kick-off; the material's own through `impact` with source `kick`, a `MELEE_SOURCES` member).
- In a Halo match the kick is Halo 3's melee on a body in the lunge (2.4 m from the eye: 70 points, from behind an
  assassination), and the bots use it (`brain.js wantsMelee`, `npc.js`); see `docs/modes.md` "Halo combat".
- Not done: a touch button (`touch.js` isn't on main yet); a pose for the Realistic body.

## Hook (2026-10-10): one rope, mass decides which way things move

`tools/hook.tool.js`, slot 5 (Gadgets), in hand from the start. Left-click fires the claw along the crosshair
(100 m/s); past 30 m it comes back empty, as Cruelty Squad's grapple fails out of range.

| It catches | What happens |
|---|---|
| A solid cell or the floor (anchored) | The rope hangs you on it (`player.tether`). **Hold left-click to reel in**: Titanfall 2's grapple, the closing speed eased toward 14 m/s (the jet's climb, the body's own top speed) the Noita way, the speed across the rope damped so it zips instead of orbiting; it ends at the claw with your momentum kept. **Let go to hang**: the rope keeps its length and you swing (Box2D's rope joint: past the length the outward speed is removed and a Baumgarte term pulls you back; gravity makes the pendulum; in the air your keys only ever add speed, so a swing keeps its momentum). The anchor cell is read back every frame (`hookCellFrag`): it tears out if it stops being solid. |
| Loose matter | It can't hold you: the claw bites one cell out (exact cell transfer, as the shovel) and the rope draws it and you together by inverse mass (`tug.js`): sand (43 kg) comes most of the way, standing you don't budge (braced), a cell of metal dust (210 kg) drags you to it. At your hand the cell is set down in front of you, moving as the claw was. |
| A body (an NPC) | Both are reeled toward each other, each by the other's share of the mass (equal bodies meet in the middle). |

- **Right-click lets go** (and drops a carried bite where the claw is). Works with the jetpack: the rope only
  stops you moving away from the anchor, so jetting up while hanging climbs toward it.
- Body rope API (`player.js`): `tether({ anchor, length, reel, hard, brace })` (kept by reference: the tool moves
  `anchor` and sets `reel`), `tether(null)`, `ropeHand()` (where it pulls: shoulder height), `rope`.
- Events: `tool:action` tool `hook`: `fire`, `catch` (id), `miss`, `tear`, `release`, `dump`.
- Cut: a verlet rope (it's a straight line; it doesn't wrap corners or sag), yanking an NPC's tool from its hand.

Check: `node tools/kick-hook-check.mjs [--port …] [--shots dir]` (a dev server; AC power).

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

## Third person: the tool in hand (2026-10-11)

In third person (and whenever the body is drawn with the camera out of its head) the body holds the
selected tool the way Garry's Mod's and Team Fortress 2's player models do: by its kind of tool.

- `src/pov/holds.js`: GMod's hold types (`pistol`, `smg`, `ar2`, `rpg`, `shotgun`, `physgun`, `melee`,
  `melee2`, `knife`, `grenade`, `slam`, `normal`, plus `torch` from Skyrim and `pogo` from Commander
  Keen). A hold puts the tool's grip at a rest point in the aim frame (the body's eye, turned to its yaw
  and a share of its pitch) and says how much of the look's pitch the torso leans into. Each model has
  its hold, its size against the viewmodel, and its hands: the right fist on the grip, the left on a
  foregrip or handguard for two-handed tools, and for the pogo stick the pegs the feet stand on.
- `src/pov/held.js`: the held model, lit by the world's light like the body (figure.js's shader), with the
  first-person tool's motion replayed on it about its grip (the swing, the kick, the throw, a lamp gone
  from the hand). It also moves the viewmodel, which is never drawn in third person, onto the held model,
  so what a tool works out from its viewmodel (a gun's muzzle flash and tracer, the hook's rope, the
  physgun's beam) leaves from the tool on the body. Tools can ask `env.heldOnBody()`. What a tool adds
  to its viewmodel (the shovel's heap, the bucket's and the flask's contents, the physgun's tip glow) is
  copied into the world where the viewmodel puts it, and a part a tool gives its own glow (the laser's
  charge strips, the tool gun's screen) glows on the body too. models.js tags its parts
  (`userData.part`) and the first-person arm (`userData.arm`) so the additions can be told apart.
- `src/pov/limbs.js`: analytic two-bone IK (the arms to the grips, the legs to the pogo's pegs) and the
  hand frames that close the realistic body's fists round a grip. Both bodies have `anchor(out)` (the eye
  a hold hangs from) and `reach({ right, left, feet, weight })`; their `update` takes `look` (the head
  follows the look, the torso leans into an aim), `lift` and `ride` (standing on a pogo stick).
- The pogo stick is ridden: its foot on the ground under the body, the body standing on its pegs (lifted
  by their height), both hands on the bar.
- Check: `node tools/tp-held-check.mjs --port P` or `--url https://tpt3d.codyh.xyz` (hands on grips, the
  pogo ridden, lit, the flash from the gun on the body, the axe's swing, what the shovel, bucket and flask
  carry, the physgun's beam, the laser's charge, first person restored, the stickman). Stills:
  `tools/tp-held-look.mjs`.

## Modules and ownership (one owner per file, to keep merges clean)

| Area | Owner | Files |
|---|---|---|
| Hardness physics: impact and blast breaking, KE→heat, debris behaviour, acid-proof shards, CPU tile port | engine | `src/elements.js` (values only), `src/physics.js`, `src/shaders/react.js`, `src/shaders/move.js`, `src/ui/tiles/*` |
| Body physics: probe readback, collisions, swimming, pressure push, vitals and damage, body→sim coupling pass | player | `src/pov/player.js`, `src/pov/vitals.js`, `src/shaders/povBody.js` |
| Camera, drop-in swoop, pointer lock, first/third person, body mesh, HUD, input, app integration | shell | `src/pov/index.js`, `src/pov/camera.js`, `src/pov/figure.js`, `src/pov/held.js`, `src/pov/holds.js`, `src/pov/limbs.js`, `src/pov/hud.js`, `src/pov/pov.css`, `src/app.js`, `src/camera.js`, `src/ui/hud.js` (help list) |
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
player.on(name, fn)                       // 'hurt' {amount, cause}, 'death' {cause}, 'land' {speed}, 'splash' {speed},
                                          // 'gib' {cause}, 'eat' {cells}
player.gibbed                             // burst into meat (Quake's gib rule): the body is gone, its figure isn't drawn
player.dispose()
```

The shell owns respawning (it calls `spawn` again after the death screen).

### Authoring a held tool

1. Append to `tools/catalog.js` (never insert: palette IDs must stay stable), choosing a slot,
   model and touch-button labels. Add `models.js` parts/icon pose and `holds.js` third-person hold.
   Bake the icon with `node tools/bake-icons.mjs --only MODEL` and verify `--check`.
2. Prefer a config-only `*.tool.js`: `meleeTool` for blows, `firearm` for rounds. For a bespoke
   tool use `tools/held.js` `heldModel(env, { model, pos, pivot? })`: initially hidden;
   `update(ctx, visible = true)` equips/follows the rig, `deselect()` hides, `dispose()` releases
   the model geometry and unregisters its hand. The shared rig belongs to the environment, not
   the tool. This is the small Roblox-style equipped/update/unequipped/cleanup lifecycle;
   actions, getters, world resources and their cleanup remain ordinary tool code.
3. Keep timers on `toolDt`/`trigger`; reset them on deselect. A scope passes `false` to held-model
   update (the rig still advances). Keep `windowShifted` for stored grid points and don't assume
   a HUD exists: NPCs use the same tools. Use `transfer.js` for conservation, and classify new
   mining sources in `constants.js`/`audio.js` rather than adding fake debris in VFX.

**Jackhammer** (`JACKHAMMER`, Dig): Rust-inspired hold-primary mining, ten strokes/s within
5 cells (1.5 m). It reuses the pickaxe's `dig.js` outlined lattice bites: energy limit 52 breaks rock (30), not
METAL (60), with the same material tags and power 30. Each mined cell enters the pack as one
debris cell (rock → stone); existing loose stone is collected too. A full pack leaves the rock
intact; a nearly full pack takes only what fits. A 0.07-cell axial stroke replaces the axe swing in both views.
`buffer: false` discards cooldown taps so release cannot trigger a delayed stroke; existing tools
keep their buffered timing. Checks: `node tools/held-tools-check.mjs` (CPU),
`node tools/mining-vfx-check.mjs` (CPU), and `node tools/jackhammer-check.mjs --port 19483`
(short guarded manual-mode GPU fixture, no app loop).

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

- `tools/action.js` `trigger(interval, { hold, button, buffer = true })`: when a button acts. HL2's weapon timing: acts on
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
- `env.feedback.notice(text)` / `refuse(text, { id, point }, { silent })`: the throttled "can't" toast, slot shake and
  `tool:action 'refuse'` (silent: no toast, a blow that bounces off). `env.feedback.act(action, extra)`: every other
  `tool:action`, with `tool` the key in lower case.
- `readout?(ctx)`: text beside the crosshair, in the god view's hover chip (the trowel's material). Without one, the crosshair shows what it's on,
  as the god view's hover does (no scanner tool: hovering is enough).
- `env.ballistics`: the shared projectiles; `fire(origin, dir, gravityScale(sim), { speed, carry, kind,
  onStrike })` flies anything ballistic (the gun's rounds, the bomb) and the toolbelt keeps it flying.
- `transfer.js` `muzzleCell()`: where something leaves the hand (the first cell clear of the body).
- `action.js` `launcher(env, { kind, model, ... })`: a thrown or fired thing (the bomb, the rocket, the lamps, the flask):
  `fire(ctx, opts)` finds the muzzle cell or refuses, fires on `env.ballistics`, kicks the rig and emits the action,
  and draws each round in flight; `launchFrom(env, ctx, refuse)` is just the muzzle part (the burrower).
- `pov/space.js` `gridSpace(env)`: `toWorld(g, out)` / `toGrid(w, out)` between grid cells and the scene.
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

Both are catalog `GEAR` entries (`...gear('KNIFE')`, `...gear('POGO')`), carried like every tool; the palette's
Tools group, Q in first person, or a class (classes.js: the Scout's pogo, the Spy's knife) puts them in hand.

## Flask (2026-10-10): Noita's potion flask

`tools/flask.tool.js` (Build slot, after the bucket) and `src/pov/ingest.js`. One flask at a time: you
start with one full of water (Noita's runs do), and once it's thrown Q (the palette) gives another, full of water.

| Input | What |
|---|---|
| Left | Chosen on the press: pointed at a liquid or powder within reach with room in the flask, or the flask empty → **scoop** (a quarter flask a dip, the aimed element only, mixed contents allowed); otherwise **pour** a stream where you aim. Finite: what it pours is spent (the bucket stays bottomless). |
| Right | **Throw** it on the shared projectiles at the bomb's speed plus yours (it hits bodies too). Where it strikes the glass shatters: `FLASK_GLASS` (4) cells of SHARDS plus every cell it held, placed in the air in front of the struck face (`transfer.put`, retried a cell higher each time until all have landed). A flask that leaves the box is gone with what it held. |
| `H` | **Drink** (Grim Dawn's potion key; V, F5, Z, E, Q, Tab, C, T, M, `,` and `.` are taken): Noita's drink, the same share of every material, `DRINK_CELLS` a gulp, handed to `ingest(body, doses)`. Hold to keep drinking. Tools and NPCs can pass `ctx.drink` / `ctx.drinkPressed`; the player's body is `ctx.player.body`. |

- **Capacity** `FLASK_CAP` = Noita's 1000 units as voxels of Noita's pixel (player.js `PX`, 0.5 cells): 1000 × 0.5³ = 125
  cells. A full drink is Noita's 10%: 13 cells.
- **Ingestion** (`ingest.js`): every dose first trades heat with the skin (it moves toward the drink's temperature by
  half the gap per full drink; above 65 °C it burns inside), after its element's row, `registerIngestion(key, effect)`:
  water quenches (a burning skin is put out), acid hurts (0.5 a full drink), lava kills ("Drank lava, 1,600 °C"),
  oil sickens (0.08), whiskey (nt-mat's element) adds 30 s of Drunk per full drink (Noita's number): the `drunk`
  event, which feel.js turns into a slow sway of the view, full at Noita's "Wasted" (45 s). A drink's hurt passes the
  Energy Shield (`player.hurt(..., { shielded: false })`). Phase 2 (statuses) is more rows.
- **Noita's potions** (`src/pov/potions.js`, phase 2): each magical liquid (nt-mat's elements) gives its status by
  touch (`registerStain`, 20 s/s with the whole skin in it, up to its submerge time) and by drink (a full drink gives the
  submerge time and drinks add up). Times are the Noita wiki's submerge times.

  | Status | Element | Time | Effect | Where |
  |---|---|---|---|---|
  | Levitating 🪶 | LEVITATIUM | 20 s | the jet flies on no fuel, climbing 75% faster (Noita's Faster Levitation) | player.js `LEVITATE_RISE` |
  | Teleportitis 🌀 | TELEPORTATIUM | 5 s | every 1.5–3.5 s a jump of 16–64 cells (Noita's shortest, 128 px) to a safe open spot: the top of a column, on solid or powder, the body's box clear of matter and nothing hot near; none found, no jump. Event `teleport` `{ from, to }` | potions.js `safeSpot` (the NPCs' world readback, ai/world.js), player.js `teleport()` |
  | Regeneration 💚 | HEALTHIUM | 7.5 s | heals 10% of a life a second | player.js `heal()` |
  | Berserk 💢 | BERSERKIUM | 15 s | the body's weapons hurt bodies 2× (status `damage` → `status.damageScale` → targets.js `dealtScale`, used by melee.js and ballistics.js) | — |
  | Charmed 💕 | PHEROMONE | 20 s | NPCs don't hunt the player while the NPC or the player is charmed (npc.js `charmed`) | Noita charms creatures; the player's own charm is our call |
  | Polymorph 🐑 | POLYMORPHINE | 20 s | helpless: no tools (status `noTools` → tools/index.js puts the tool away). Becoming a sheep is a follow-up | — |
  | Toxic ☣️ | TOXIC (drink) | 6 s a drink | nt-status's Toxic (touching sludge already gives it) | — |
- Check: `node tools/flask-check.mjs [--port …] [--shot file.png]` (a dev server; AC power).

## Gunplay v2 (2026-10-08): events and ownership

Gunplay v2 follows the Gunplay Feel Lab's recommendations: ballistic rounds handed to the sim at impact,
ZzFX sound through PositionalAudio, CC0 glTF viewmodels with spring recoil and sway, three.quarks VFX,
camera kick, trauma shake and a hitmarker, plus an optional realistic body (Quaternius) next to the stickman.

### Events (`src/pov/events.js`)

`povEvents.emit(name, payload)` / `povEvents.on(name, fn)`. Positions are **grid cells** (Vector3) unless they
say world. Emitters own their event names. Listeners never mutate payloads.

| Event | Emitted by | Payload |
|---|---|---|
| `blast` | bomb, rocket, frag | `{ point, kind? }` grid. A charge, rocket or frag (`kind: 'frag'`) went off there (sound, shake, fireball; with no `by`, the player's own: less blast damage). |
| `frag` | frag.js | `{ action: 'throw'\|'bounce'\|'pickup', point, speed? }`. A frag grenade left a hand, bounced (speed in cells/s) or was picked up off the ground. Its flight is `round:move` / `round:end` with kind `'frag'`. |
| `body:shield` | player.js (any body) | `{ id, state: 'hit'\|'break'\|'recharge'\|'full', amount?, point, height }`. A body's Energy Shield event (vitals.js), on the bus: point its feet (grid), height its own (vfx.js's shimmer and pop, audio.js). |
| `punch` | `rig.hit` (viewmodel.js `HIT`) | `{ pitch, yaw }` rad, + up and + left. Throws the view punch (feel.js). |
| `gun:fire` | pistol, SMG, sniper, rocket | `{ id?, origin, dir, muzzleWorld, gun, sound }`. A shot fired. `origin` is the physical start in grid cells; `dir` is unit length. Firearms include the ballistic `id` for their cosmetic tracer. `muzzleWorld` positions the flash in world space. `gun` identifies the tool; `sound` scales the pistol's audio. |
| `gun:dry` | legacy | `{}`. Dry-click audio hook; firearms no longer emit this. Bullets start at the eye, so close terrain stops the bullet rather than the trigger. |
| `round:move` | guns, bomb, rocket | `{ id, kind, from, to }` (kind 'round', 'bomb' or 'rocket'). A round in flight moved this frame (grid), for tracers and the rocket's smoke. |
| `round:end` | guns, bomb, rocket | `{ id, kind }`. The round is gone (impact or out of the box). |
| `impact` | gun, axe, pickaxe, knife, flask | `{ source: 'gun'\|'axe'\|'pickaxe'\|'knife'\|'flask', point, normal, id, energy, broke, body?, backstab? }` (body: a target, not a cell, was hit; id −1; backstab: the knife's lethal blow). Something was struck. id is the element hit, energy is ½·DENS·v² in sim units, and broke is true/false when the striker knows, else null. |
| `tool:action` | shovel, bucket, axe, pickaxe, knife, physgun, trowel, blowtorch, bomb, flask | `{ tool, action, id?, point?, amount? }`. tool is 'shovel'\|'bucket'\|'axe'\|'pickaxe'\|'knife'\|'physgun'\|'trowel'\|'blowtorch'\|'bomb'\|'flask'; action is 'dig'\|'chip'\|'place'\|'on'\|'off'\|'throw'\|'dump'\|'scoop'\|'pour'\|'swing'\|'refuse'\|'grab'\|'fling'\|'release'\|'blast'\|'shatter'\|'drink'. Physgun 'hold' state is read from the tool, not an event. |
| `drunk` | ingest.js (whiskey) | `{ seconds }`. Seconds of Drunk added to the player (feel.js sways the view; an NPC's has `by`). |
| `player:step` | shell (camera bob cycle) | `{ speed, inLiquid }`. A footfall. |
| `player:jet` | player | `{ on }`. The jetpack lit or went out. |
| `kick` | a body's kick (kick.js) | `{ hit: 'cell'\|'body'\|null, point, normal, dir, id, broke, mass, dv, melee?, assassination? }`. A kick, landed or not: mass is what it met (kg, Infinity when anchored), dv the kicker's own Δv (cells/s); melee: it was Halo's melee (a Halo match), assassination: from behind. |
| `perk:take` | shell | `{ key, keys, point, by? }`. A body took a perk orb: key is the orb's, keys what it gained (Gamble's two). |
| `perk:revive` | shell | `{ point }`. Extra Life brought the player back. |
| `status:on` / `status:off` | a body's status set (`status.js`) | `{ key, cause }`. A status came on or went off (cause: an element key, the status that cancelled it, `'add'`, `'faded'`, `'died'`; an NPC's carry `by`). See "Status effects". |
| `drill` | burrower | `{ point, dir, id, dt }`. Its drill cut this frame at point (grid), heading dir, mostly matter id (vfx.js's spray). The tool also emits `tool:action` 'burrower' 'fire' / 'grind' `{ point, id }`. |
| `laser:charge` | laser cannon | `{ amount, dt }` every frame it charges (0..1; audio.js's rising whine). The tool also emits `tool:action` 'laser' 'charge' / 'cancel' / 'fire'. |
| `laser` | laser cannon | `{ from, to, dir, radius }`, from/to/radius in **world** units. The beam, for vfx.js. |
| `shake` | laser cannon | `{ trauma }` 0..1. Adds to the player's screen shake (feel.js), a shared hook for any tool. |
| `body:gib` | player.js (any body) | `{ point, cells, lost, by? }`. A body burst into meat: `cells` MEAT cells laid, `lost` that found no room (buried). `by` is the NPC's id. |
| `body:eat` | player.js (any body) | `{ point, cells, by? }`. A body ate `cells` cooked meat cells. |
| `wand:fire` | wands/runtime.js | `{ origin, muzzle, muzzleWorld, dir, effect, material }`. A cast left the wand: origin is the eye (the physics origin), muzzle the drawn tip (grid; muzzleWorld world, or null). effect/material are its main spell's (wands/look.js colours it). Feel blooms the crosshair, audio plays the cast. |
| `wand:flight` | wands/runtime.js | `{ flights: [{ from, to, effect, material }], dt }`. Every bolt that moved this frame, once per frame, at its drawn position (vfx.js's trails). |
| `wand:impact` | wands/runtime.js | `{ point, normal, effect, material, radius, id, body }`. A bolt or beam landed (id: the cell hit, −1 for a body or nothing). A hit into a body also emits `impact` `{ source: 'wand', body: true, id: −1 }` for the hitmarker. |
| `wand:beam` | wands/runtime.js | `{ from, to, dir, effect, op, material, radius, hit, normal, id }`. A beam or touch, drawn from the tip (from) to its true end. |
| `wand:blast` | wands/runtime.js | `{ point, radius, power }`. A wand's pressure blast: fireball, boom and shake like `blast`, but not `blast` itself (that one lowers the player's self-damage). |
| `wand:teleport` | wands/runtime.js | `{ from, to }` feet (grid). A teleport bolt moved the caster. |

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
a **Player spawn** is where V drops you in (the one nearest the cursor) and where you respawn. Click a spawner
again with its tool to remove it. Spawners stand on world cells like signs; a new scene clears them, and the lab
comes with one axeman spawner on its open south floor. Gunners and worms are spawnable only: no scene or world
places them. Not in worlds (the window): NPCs don't follow it yet.
Each NPC (`src/pov/npc.js`, loaded on first use) hunts the player. It has the
player's body, the player's tools and a mind built from textbook game AI, each a solved problem:

| Sub-problem | How | Where |
|---|---|---|
| Body | a second `createPlayer({ quiet: true })`: same movement, swimming, burning, drowning | `npc.js` |
| Hands | `createKit(env)`: every tool, headless, its own pack and bucket (`env.owner`), the shared projectiles | `tools/index.js` |
| What's in the world | the multiplayer packer reads the cells back to the CPU every 0.5 s (id + temperature), one copy per renderer shared with the vehicles and Teleportitis, de-swizzled in a worker | `ai/world.js` (`readCells`), `ai/deswizzle.js` |
| Seeing and aiming | Amanatides & Woo voxel traversal (1987) over that copy; the tools' `ctx.aim` comes from it | `ai/world.js` |
| Getting there | a height map on a 2-cell grid in typed arrays, searched with Yuka's `AStar` step for step on them (same paths, no garbage); derived again after a readback at most every 2 s, relinked only if it changed | `ai/nav.js` |
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
swim up to breathe, dive after a player below, jet out of water at a wall.

Yuka gotcha: a `CompositeGoal` runs its subgoals in the order they were **added** (Yuka's `addSubgoal`
unshifts and `currentSubgoal()` takes the last), the reverse of Buckland's C++.

**Who did it.** Tools emit on the global bus, so an NPC's tools run inside `povEvents.as({ id, at }, fn)`:
every emit then carries `by` (the NPC's id) and `from` (its eye), and `punch` (the player's view kick) is
dropped. Rounds remember who fired them (`ballistics.js` `r.actor`) and emit as them. Listeners that are the
player's own (hitmarker, gun kick, the torch/pour/physgun loops) skip `by` events; sounds play at `point`
or `from`. `targets.js` holds everything weapons can hit that isn't cells (the player, id `'player'`, and
each NPC); a weapon never hits its own wielder. The player takes half damage from NPC weapons.

Checks: `__app.pov.npc.debug` (goal, weapon, tool, sees, pack, last refusal), `__app.pov.npc.agent`,
`__app.pov.events`, `__app.pov.npc.agent.npc.nav.stats` (map derivations, relinks, A* runs).
`node --expose-gc tools/nav-check.mjs` (CPU only): the walk map's A* against the Yuka graph search it replaced
on Dam Valley and random height maps (same reachability and path costs), the map following the world, and the
old vs new rebuild/search times and garbage.

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
pad. The player looks at one, sees its name and what it does under the crosshair, and presses **E** to take it
(Noita's pick-up rule; `pov/interact.js`, the shared look + E for every pickup); walking into one takes nothing.
An NPC walks into one, or stands against its plinth (`pov/index.js` `takePerks`). Either way the shrine's other
orbs vanish. Undoing a placed shrine takes its orbs too (the
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
| Slow Fall | a canopy's quadratic drag on the way down (a = k·v², terminal √(g/k)): you land at a T-11 parachute's 5.8 m/s (19 cells/s, against Noita's 175) at the default gravity. Implicit, so exact at any frame rate. Only while descending in air: jumps rise and the jetpack climbs as before. Landings never hurt here (Noita), so what it saves is the slam and the shake; drag ∝ area/mass, so Shrink slows it further | player.js | drag area ×2 (terminal ÷ √2) |
| Shrink | the body ×0.5: height, footprint, eye, collision box, probe use, figure and hit box (`player.size`, `.height`, `.width`, `.eyeHeight`). Gravity is the world's, so moves follow Froude similarity (Alexander): speeds ×√size, a jump clears the same body heights. Mass ∝ size³: an impulse (a blow, recoil) throws it size⁻³ as fast (capped at a blast's 60 cells/s for the probe); liquid form drag ×1/size, viscous (Stokes) ×1/size², a canopy's ×1/size; the skin trades heat ×1/size as fast (vitals.js). Blasts already scale: the push is the mean gradient over the body's own cells, ≈ ΔP over its length. Never under one cell tall | player.js, vitals.js, index.js, npc.js | ×0.5 again, down to 1 cell |
| Night Vision | goggles that switch themselves on in the dark, the local player's view only (`pov/nightVision.js`): an image intensifier's automatic brightness control, raising the scene's measured log-average luminance (post.js meter: a 16² downsample of covered pixels, read back every 4 frames while the perk is held) to middle grey, at most 16× light; on from 1 to 3 stops under middle grey over 0.4 s, off again in daylight. The picture (post.js composite): luminance × gain, AgX on a grey, P43 green phosphor, shot-noise grain (σ ∝ √(signal·gain)) and the tube's round vignette. No key, no setting | nightVision.js, gfx/post.js | ×4 more light |
| Rain Cloud | real CLOUD (id 24) kept over the head: each frame the body reads its sphere (radius 4, 2 cells over the crown) from the probe, a breeze (the coupling pass, `uOnly` = CLOUD) carries what's there with it, and the engine's brush tops its air up to 85% cloud, thick enough for the engine's own rain rule. New cloud comes at 150 cells/s at most per body; a body stops seeding while 6000 cells of its own may still be alive (counted down with the cloud's measured 67 s life), so it can't flood the world. The rain puts out fires and fills holes by the engine's rules. NPC bodies seed their own | player.js + povBody.js | radius +2, up to 10 (rain grows with its thick core) |

A new tool gets Faster Tools for free by timing its actions with `trigger` and `toolDt(ctx)` instead of `ctx.dt`.
NPC bodies carry perks too (npc.js passes `toolRate` into its kit's ctx).

Check: `node tools/perks-check.mjs [--port …] [--shot file.jpg] [--worldshot file.jpg] [--nvshot prefix] [--rainshot file.jpg]`
(a dev server; AC power). Without a server: `node tools/perks-cpu-check.mjs` runs the real body over a mock probe in
node (Slow Fall's landing speed and stacks, the jetpack under it, Shrink through a crack, jump height in body heights, a
blow's throw, the Rain Cloud's seeding, rate and budget).
Combat (shield, movement perks, knife, pogo): `node tools/combat-check.mjs [--port …] [--shot file.jpg]`.

## Status effects (2026-10-10): Noita's stains

Every body (the player's and each NPC's: `createPlayer` builds the set) has `body.status`
(`src/pov/status.js`). A stain builds from the share of the body's contact cells holding its element (the
cells vitals.js reads), × time, and wears off at 1 s/s, so it only ever shows where rate × share > 1 and
only after 0.5 s of build (a splash on a boot isn't Wet). Every status fades once its source is gone.
The built-in ones are in `src/pov/stains.js`; elements from other branches (SALTWATER, TOXIC, SLIME, BLOOD,
liquid nitrogen) are looked up by key and are no source while they don't exist.

```js
registerStatus({ key, name, icon, color, cancels: [], blocks: [], wash, move, full, refresh, show, tint, screen,
  buildRate(set), duration(set), fade(body, set), when(body, env, set), onStart(body, ctx), onTick(body, dt, ctx), onEnd(body, ctx) })
registerStain(elementKey, statusKey, { rate /* s per s, whole skin */, seconds /* at most */ })
body.status.add(key, seconds, strength = 1)   // false if unknown or blocked
body.status.has(key), .clear(key), .clearAll(), .list() /* [{ key, def, left, strength }] */, .time(key), .moveScale, .version
```

`cancels` is symmetric (either coming on clears the other); `blocks` is one way (while on, those can't build
or be added); `wash` is × fade while Wet; `move` is × speed on foot, the one movement hook (player.js
multiplies foot speed by `status.moveScale`, the product over what's on). Hook ctx: `{ set, env, hurt(amount,
cause), world }` (`hurt` is damage that isn't a blow: no shield, no bleeding).

| Status | Source | Effect | Cancels / blocks | Constants (stains.js) |
|---|---|---|---|---|
| Wet 💧 | WATER, SALTWATER (25 s/s), CLOUD fog (3), SNOW melting (4) | can't catch fire; puts Burning out; washes stains off (× their `wash`); × 3 electric shock (`WET_SHOCK`); dries faster with hot skin | cancels and blocks Burning | `WET_S` 10 s, `WET_DRY_SPAN` 20 °C |
| Oily 🛢️ | OIL (20) | fire catches × 4 faster, burns × 2.5 longer, ignites from skin at 150 °C | — (washes × 2) | `OILY_S` 15, `OILY_IGNITE`, `OILY_BURN`, `OILY_IGNITE_T` |
| Burning 🔥 | FIRE (100), LAVA (200) contact (1% of the contact cells is the least that lights it); skin past 255 °C (cotton's ignition) | 0.06 health/s (Fire Immunity: none); every 0.1 s a column of engine FIRE up one side (povTools.js `BODY_FIRE`, the tools' flame pass) that lights grass and wood beside it; vfx flame licks; burns its budget down (`full`, `refresh: false`) | cancels Frozen | `BURN_S` 4 s, `BURN_DAMAGE`, `IGNITE_T`, `BURN_FIRE_INTERVAL` |
| Frozen 🧊 | skin under 10 °C (numbness); ICE, SNOW (3: buried, not standing on it), liquid nitrogen (40) | × 0.3 speed on foot; skin over 40 °C thaws it × 6 | cancels Burning | `FROZEN_S` 4, `FROZEN_SKIN_T`, `THAW_SKIN_T`, `FROZEN_MOVE` |
| Toxic ☣️ | TOXIC sludge (20) | 0.05 health/s 'Poisoned', past the shield | — (washes × 3) | `TOXIC_S` 6, `TOXIC_DAMAGE` |
| Slimy 🫠 | SLIME (20) | × 0.6 speed on foot | — (washes × 3) | `SLIMY_S` 8, `SLIMY_MOVE` |
| Bloody 🩸 | BLOOD (15); any wound | cosmetic | — (washes × 8) | `BLOODY_S` 8 |

**Bleeding.** A hurt the Energy Shield would take (blows, bullets, slams, blasts: vitals.js emits `wound` on the
body for what gets past the shield) stains Bloody and spills 12 BLOOD cells per unit of health (16 at most per
wound, fractions carried) into the air around the chest (`transfer.js` put). Heat, cold, acid, toxin and
drowning don't bleed. A cell is 27 L, so any spill is Noita's exaggeration: game magic, said so in the code.

**Electricity.** `shock(env, wet, sparkAt)`: SHOCK_DAMAGE (0.5 health/s) × the strongest spark touching the
body (0..1) × `WET_SHOCK` while Wet. el-elec's probe puts a live cell's spark in the probe's 4th channel;
player.js `sense()` fills `env.contactSpark` with 0 until it lands. Wiring it is one line there:
`contactSpark[cn] = field(x, y, z, 3, 0);`.

**Look.** The HUD's row above the perks (icon, seconds left, a bar that runs down, a blink at the end); a
first-person edge tint in the latest stain's `screen` colour (hud.js, pov.css: heat, frost and acid live there
too); the figure's albedo mixed toward the stains' `tint` (figure.js `uTint`, also the realistic body); flame
licks off a burning body (vfx.js `burn`). NPCs run to water when Burning (brain.js Extinguish).

Check: `node tools/status-check.mjs` (CPU: the rules through real vitals.js) and `--gpu [--port …] [--shot
file.jpg]` (the real body: a pool, fire on and off the body, snow, a wound's spill, the HUD row, the lab NPC).

## Gibs and eating (2026-10-10): Cruelty Squad's healing

There is no regeneration: a body heals by eating meat cooked with fire, and meat comes from bodies killed by overkill.

- **Meat** (elements.js `MEAT`, `COOKED_MEAT`, in Powders): lean muscle's real numbers (1.05 g/cm³, ASHRAE food
  thermal properties). Raw meat is too wet to burn; at 71 °C (USDA, ground meat) it cooks, after banking the
  proteins' denaturation heat (~3.5 J/g). Cooked meat chars and burns like wood past its fat's flash point (~320 °C),
  leaving ash. Fire, the flamethrower, lava and steam (in a closed steamer; in open air it rises away) cook it
  through the engine's own heat. The phase change is elements.js `hot` (docs/elements.md, el-core's shape).
- **Gibs** (vitals.js `GIB_HEALTH`, meat.js): Quake's rule. A killing blow that drives health to −40% or below
  (Quake III `GIB_HEALTH` −40 of 100; Quake's `PlayerDie`) bursts the body. As in Quake III the corpse can still be
  gibbed: blasts, slams and blows keep taking its health down, so a blast spread over frames is one blow at any frame
  rate. Burns, cold, acid and drowning never gib. Other deaths keep the old flow. A rocket's direct blast gibs; its
  edge, or an axe, leaves a body. Landings never hurt (Noita), so falls don't gib.
- The burst lays the body's sim mass as meat: its box (1.6² × 5.5 cells) at `BODY_DENS` 9.8, the box Archimedes
  floats, is 13 cells of meat (`GIB_CELLS`). They go in through the exact cell transfer (`transfer.put`), nearest the
  body's middle, at its core temperature (37 °C) and its velocity, and the blast's own pressure throws them. A
  gibbed figure isn't drawn.
- **Eating**: cooked meat touching a body (the contact cells player.js measures) is taken out of the sim
  (`transfer.take`, exact) and heals `EAT_HEAL` (8%) a cell, only while hurt and only as many as fill the body
  (Quake's `T_Heal`: a full body leaves a health box). Raw meat isn't eaten. NPCs eat the same way.
- Sound: `eat` (two wet bites) and `gib` (a splat) in audio.js, on `body:eat` / `body:gib`.
- Check: `node tools/gibs-check.mjs` (cooking on the tile engine and the gib rule, in node);
  `--port …` adds the GPU run (cooked and charred in the sim, a rocket gibs the lab's NPC into 13 cells, cooked
  meat eaten and raw not, matter counted).

## Birds (2026-10-10): life in the world

`src/birds/`: flocks of magical birds, in the god view and first person, World and boxes. Not synced in
multiplayer (every client flies its own).

| Part | How | Where |
|---|---|---|
| Flocking | Reynolds' boids with Yuka's own behaviours on Vehicles (Separation, from the birds within 2 m only; Alignment, Cohesion, Wander, Arrive to land, Flee from a scare, Seek home and back to the flock), one EntityManager per flock; plus terrain following (a height band over the ground, looking 0.9 s ahead), which Yuka has no twin for | `flock.js` |
| What they know | one GPU pass, twice a second: per probed column (one in each 2×2 of the window) the surface, its id, its rise over the next surface across open air (a perch: a tree crown, a roof) and the band of cells over 300 °C; read back async (256 KB). Outside the window a World's `scene.ground` (+ its trees' height) | `probe.js` |
| Drawing | one InstancedMesh, wings beating in the vertex shader; lit by `gfxUniforms` sun and sky; an iridescent sheen, and at dusk and night an emissive glow and three.quarks light motes behind them (no lights) | `render.js` |
| Life | a World keeps 3 ambient flocks of 7–12 near the window; the palette's Bird flock spawner (Entities, `SPAWNER.BIRDS`) keeps one on its spot; they perch for a while, roost below −3° sun, flush from a body within 8 m, a shot (60 m), a strike (12 m) or a blast (120 m; it kills within 9 cells), burn in hot cells and fall; weapons hit them through `targets.js` (`bird:<id>`) | `index.js` |

Checks: `node tools/birds-check.mjs` (CPU: cohesion, clearance, perching, flushing, roosting, fire, a kill, cost) and
`node tools/birds-shots.mjs --port … --shots dir` (GPU, AC power).

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
