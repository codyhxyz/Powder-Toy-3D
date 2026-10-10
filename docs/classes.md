# Classes (2026-10-10): Team Fortress 2's, made of tools and perks

Part of the Big Team Battle layer. A class is a loadout: tools from the toolbelt, perks from `pov/perks.js`, and at
most two body scales. Picking one in first person works like TF2: press **comma**, pick from the row of cards, and it
takes effect at your next spawn, or at once if you spawned less than `RESPAWN_ROOM_S` (6 s) ago (TF2's respawn room).

The whole layer sits behind one constant, `CLASSES_ENABLED` in `src/pov/classes.js`. It is not a user setting.

## The classes

| # | Class | Signature tool | Other tools | Perks | Body | Role |
|---|---|---|---|---|---|---|
| 1 | Rocketeer | `ROCKET` | `BOMB` | Explosion Immunity | | rocket jumps, area denial |
| 2 | Runner | `POGO` | `AXE` | `FLEET_FOOT` | health ×0.7 | flag runner, flanker |
| 3 | Skyjack | `GUN` | | `ROCKET_BOOTS`, `BIG_TANK` | | holds the high ground, dives in |
| 4 | Bulwark | `SMG` | `GUN` | `ENERGY_SHIELD` ×2, Extra Health | speed ×0.82 | holds the hill |
| 5 | Spy | `KNIFE` | `GUN` | Breathless | | backstabs, swims in through the reservoir |
| 6 | Sapper | `PICKAXE` | `BUCKET`, `BLOWTORCH` | | | breaches walls or patches the dam |
| 7 | Pyro | `BLOWTORCH` | | Fire Immunity | | burns forests and bases |

The brief left Rocketeer, Skyjack, Bulwark and Spy without a tool they could use today. Each got one that exists now
(`BOMB`, `GUN`), so every class has something in its hands before the other branches merge.

Keys in `code` don't exist on this branch yet. They come from the combat branch (`FLEET_FOOT`, `ROCKET_BOOTS`,
`BIG_TANK`, `ENERGY_SHIELD`, `KNIFE`, `POGO`) and the weapons branch (`ROCKET`, `SMG`). Classes refer to them by key
anyway. When a class is applied, a missing perk is skipped and reported in `skipped`. A missing signature tool falls
back to the first loadout tool that exists: until the merges land, the Rocketeer holds the bomb, the Runner the axe
and the Bulwark the gun. The picker shows missing items dimmed with a dashed outline and a stand-in icon. A footer key
explains them, and their tooltip says "coming soon". Once the real tool or perk exists, its own sprite or icon
replaces the stand-in.

The data is plain (`CLASSES` in `classes.js`): key, name, tagline, role, accent colour, signature tool, tools, perks
(key to stacks), optional `body: { health, speed }` scales, and a portrait `pose`. To add a class, add an entry. With
no `pose` it gets the default aiming pose, and it takes the next number key.

## The bars

The picker's four bars (Health, Speed, Mobility and Firepower) are worked out from the loadout by `classStats(cls)`.
No class has hand-typed bars. Each tool and perk has a contribution in `TOOL_STATS` and `PERK_STATS` (per stack for
perks), on top of `STAT_BASE` (everyone has a jetpack). Firepower takes the best tool plus a quarter of each other
tool's. The body scales multiply health and speed. Each bar is the total over `STAT_FULL`, drawn as five pips.

## Applying a class

```js
import { applyClass } from './pov/classes.js';             // pure: perks and body scales
import { applyClassTo } from './pov/classPicker.js';       // the same, plus the signature tool in a toolbelt's hand
applyClassTo(body, 'PYRO', toolbelt?)   // → { cls, granted: { FIRE_IMMUNITY: 1 }, skipped: [], held: 'BLOWTORCH' } | null
```

- `body` is anything made by `createPlayer`: the player's body, or an NPC's or bot's `n.body` (pass no toolbelt; a
  bot's kit holds its own tools).
- **Perks** are added as stacks on `body.perks` and recorded in `body.classPerks`. The next class change takes back
  exactly those stacks, so perks earned at a shrine stay, including extra stacks of the class's own perk. Death clears
  every perk (`vitals.js`, unchanged). The shell applies the chosen class again on every spawn, so a class outlives
  death and shrine perks don't.
- **Body scales**: `body.speedScale` multiplies walking and running speed (not the jet or swimming; `player.js`, one
  line). `body.perks.healthScale` multiplies max health under the Extra Health stacks (`perks.js` `maxHealth`), so it
  divides every hurt, as Extra Health does. `perks.clear()` keeps it.
- `body.cls` is the applied class key, or null. An unknown class key returns null and changes nothing.
- The toolbelt is not restricted. A class only adds its perks and puts its tool in hand. On the weapons branch's
  inventory toolbelt (`tools/inventory.js`, found through `import.meta.glob`), `holdTool` gives the signature tool if
  it isn't owned and selects it by key. On today's slot toolbelt it selects the tool's slot.
- `povEvents` emits `class:change { key, body }`.

The player's choice is `__app.pov.classes`: `chosen`, `choose(key)`, `open()`, `close()`, `isOpen`, `inRoom`. It is
kept in this browser (`localStorage` `tpt3d.pov.class`). The first spawn without a class shows a toast: "Press , to
choose a class".

## The picker

`src/pov/classPicker.js` and `.css`. It is a full-screen overlay over the live world. The focused class's name is set
very large behind a row of seven cards. Each card has the class's number key, a portrait, its name and tagline, its
loadout and its bars. Below the row are the focused class's role and the spawn line ("You will spawn as Pyro" / "You
are playing Pyro" / "You just spawned: pick, and you change at once"). A `body.team` (`'red' | 'blue' |
'infected'`, from the game modes) adds a team chip and lights the floor in the team's colour.

- **Keys**: `,` opens and closes it (first person only); `1`–`7` pick and close; `←` `→` (and Tab) move the focus;
  `Enter` or `Space` pick the focused class; `Esc` closes. The picker listens in the capture phase and is created
  before the toolbelt, so while it's open the digits pick classes, not hotbar slots, and WASD, Space and Shift don't
  move the body. F, P, T and ? work as usual.
- **Comma isn't free**: in the god view it opens Settings (`app.js`). With classes on, comma in first person is the
  class key: `pov/index.js` drops it from `PASS_KEYS`. Settings stays on comma in the god view and on the topbar's
  gear in first person. The help list (`ui/hud.js`) says both.
- **Pointer lock**: opening releases the pointer. Closing with a key or a click takes it back, because those count as
  a gesture. Closing with Esc leaves the "Click to look around" prompt, since the browser won't relock on Esc.
- **Mouse**: the focus follows the mouse only when it moves, so the cursor resting mid-screen as the pointer unlocks
  doesn't steal the focus. Click picks. A click on the backdrop closes.
- **Portraits** (`classPortraits.js`): the Castle Crashers wizard (`buildCrasher`) in the class colour (robe, hood,
  glowing eyes, and a rim light in that colour). It holds the tool it would spawn with at 3.2× and is posed per class
  (`POSES`: shoulder, sprint, hover with jet flames, brace, sneak, swing, torch). It's cel-shaded with hull
  outlines, nearly side-on as in Castle Crashers, and framed from the ground up so the Skyjack's hover reads. All
  seven are drawn on the first open, one per frame, by one offscreen WebGL renderer that is disposed afterwards. The
  game's renderer isn't used.
- **Sizes**: tighter below 1120 px wide, and a squarer stage without taglines below 660 px tall. It works at 1000 px.
  Reduced motion turns off the card rise and the name swap.

## Check

`node tools/classes-check.mjs [--port 5403] [--shot file.jpg]` needs a dev server and AC power. It checks that comma
opens the picker and not Settings, with 7 cards, 28 bars, sprites, the coming-soon items and all 7 portraits. It
checks that the arrows move the focus and Esc changes nothing. A pick out of the respawn room waits for the respawn,
and Pyro comes back with Fire Immunity and the blowtorch in hand. A pick in the respawn room applies at once and takes
the old class's perks while keeping the shrine's. Runner, Bulwark, Spy and an unknown class key apply without
throwing, missing keys are skipped and the scales apply. It also checks the red team tint, and that comma opens
Settings in the god view.

## Follow-ups

- Show your class on the POV HUD (`pov/hud.js`, combat's file just now).
- Restrict the hotbar to the class's tools when a game mode asks for it (`applyClassTo` already knows the loadout).
- Bots: game modes call `applyClassTo(n.body, key)`. The NPC figure could take the class colour (`npc.js` `PALETTE`).
- Re-render the portraits when the merged branches bring the rocket, knife and pogo models (it happens on its own:
  the portraits are drawn at the first open from whatever models exist).
- Speed scale vs Fleet Foot: when both land in `player.js`'s run speed line, multiply them.
