# Team games: Big Team Battle modes (2026-10-10)

Halo-style team games in first person: teams of bots on both sides (the lab's NPCs: the player's body,
tools and Yuka brain, `docs/pov.md` "NPCs"), the player on one of them, and five modes. Code in
`src/game/`; the rules and their sources in `src/game/rules.js`.

In first person: **M** opens the match menu (mode, side, Start / End; the mouse is freed while it's open; Esc or M
closes it), **Tab** holds up the scoreboard, **.** switches team (TF2's key; a bot from the other side takes your
place). With no match running a small "M Match" chip sits top-centre. The main drawer has no match settings.

## Joining

- **One click**: the start menu's top bar has **Play** (Team Slayer on Dam Valley) and **Siege** (TF2's classes; the
  class picker opens on joining), `maps.js QUICK_PLAY`: the team is picked for you (auto-balance), Halo 3
  matchmaking's way. The gamemode categories and their maps are still there for any other pick; Start on a team
  mode's map starts that match.
- **A link**: `?mode=slayer` boots straight into a match on the mode's Play map (Dam Valley), `?map=lab&mode=ctf` on
  that map (a map not built for the mode, or a mode the build lacks, is Sandbox). The loading screen shows for it.
- **Behind the loading screen** (app.js `bootReady`, `startMode`): the bots' module (`npc.js`, Yuka) starts loading
  with the first frames (`game.prepare()`), the body drops in with no swoop (Halo cuts to your eyes), the match
  waits for the body (`game.start` needs the player, which the first drop-in builds), the bots are built and
  compiled, and the map just loaded isn't loaded again (`start(mode, { fresh: true })`). The screen comes down on
  the match running (at most 30 s).
- **Click to play**: pointer lock needs a click, and the load outlasts the Play click's, so the match shows a big
  "Click to play" while the mouse is free (the first-person "Click to look around" gives way to it).
- **Timing marks** (`performance.mark('join:<step>')`, `launch.js mark`): `click`, `app` (app.js ran), `npcs`
  (the bots' module), `first-frame`, `entered` (the body is in), `bots` (built), `match` (running), `ready` (the
  loading screen is down), `control` (the first moment with the mouse captured in a match). `tools/join-check.mjs`
  prints them.

## The match loop

A match that ends by its rules shows **Halo 3's post-game carnage report** top-centre under Halo Infinite's **Victory** / **Defeat** banner (or
who won, watching), the result line, both teams' tables (each player's score, kills, deaths, you highlighted, the
winner starred; a medals column once the roster has `medals`). It counts down `END_SCREEN_S` (10 s) and **the next
match starts by itself** on the same map with the same options (fresh terrain, sides auto-balanced again): Halo 3
matchmaking moves the party on to the next game. The way out: **Leave** (the mouse is free once Esc has released
it) or **Esc** opens the start menu, which ends the loop; so does leaving the body (V). A match ended by hand (M,
End match) shows a line and doesn't loop.

**The first seconds**: the first time you have control in a match (alive, mouse captured) a card of the match's
keys shows under the score for 9 s, once a session per rule style: Halo's (Shoot · Zoom right-click · Grenade G ·
Melee F · 1/2 or wheel swap guns · Pick up E · Scores Tab · Match menu M) and Siege's (TF2's keys with `,` Class),
which waits until the class picker, which frees the mouse, has closed. The sandbox's key hint doesn't show in a
match.

## Teams

- `body.team` is `'red' | 'blue' | 'infected' | null` on the player's body and every bot's (other modules read it:
  vehicles, classes). Infection's survivors are `'blue'` (`HUMANS`), so they can't hurt each other.
- **No friendly fire for blows**: `targets.js` takes hit rules from the game (`setHitRules`): a round or a swing
  passes through a teammate (TF2's way: it flies on to what's behind), a fresh spawn takes nothing for 2 s, and an
  infected's melee hits 3×. **The sim's damage can't be filtered**: fire, a bomb's blast, lava, a flood, a falling
  heap hurt everyone, teammates included. That's the physics and it stays.
- Every blow that lands is announced as `body:hit` `{ id, amount, cause }` with `by` (the attacker; none = the
  player). A death is credited to the last enemy who hurt the body within 8 s (a burn or a blast after a blow still
  counts, TF2's "finished off"); a bomb's blast marks every body within 10 cells, a lit torch every body within 8.
  A death no enemy is credited with is a suicide (Halo: −1 to the team in Slayer).
- Bots are recoloured per team (`npc.tint`: the wizard's robe and hood, its eyes; infected green) and carry a
  spinning team chevron overhead (Halo's waypoints): a teammate's shows through walls, an enemy's only in plain sight.
- **Auto-balance**: the player joins the side asked for (menu: Auto / Red / Blue / Watch), Auto picks either at
  random (both are even), and bots fill each side to `TEAM_SIZE` (4: 4v4 counting the player, Halo 3's Team Slayer).
  Watch: the player has no team, bots ignore them and blows pass through them.
- **Respawn**: 5 s (Halo's default) at the side's spawn point farthest from the nearest living enemy (Halo's spawn
  influence, simplified), jittered 2 cells, lifted clear of anything that has fallen on the point (a heap of sand),
  then 2 s of spawn protection. No early respawn by click during a match.

## Bots on both sides (`ai/brain.js`, `npc.js`)

An NPC built with `opponents()` (a team game's) fights whoever is on another side instead of the player:
`Agent.senseAll` keeps a Yuka `MemorySystem` record per opponent and picks Raven's target: the nearest one it can
see, else the one sensed last (+40 cells for being out of sight), keeping its current one unless another is 8 cells
nearer. Bots also have **Halo's motion tracker**: an enemy within 25 m (83 cells) moving faster than a crouch-walk
is sensed, seen or not, so they find each other on a big map. A flag carrier, and Infection's last survivor, are
revealed to everyone (Halo's waypoints) and a carrier counts as 30 cells nearer.

Objectives are one more `GoalEvaluator` (`src/game/bots.js`) beside the fight ones: the game says what this bot's
objective is (`objective(bot)` → `{ kind, at, r, want }`), the bot walks there (A*) and holds a zone or arrives at a
point; a point that moves (a carrier) is followed without re-running A* every frame. The walk's map (`ai/nav.js`)
is one layer, the top of every column, so a point under a roof or on a shrine's roof can have no path: a zone is
walked to at a point on its ring toward the bot, a walk that finds no way is tried from three more bearings, then
the bot walks to the spot 40 cells short of it on the straight line and steers straight in (Dam Valley's flags
stand in roofed halls, reached through the front doorway); after 10 s of that it gives up and (roaming) picks
another spot. On the way and in a zone it
still shoots what it sees (Raven's weapon system runs beside the goals: `takeAimAndShoot` in `ai/brain.js`, the gun
under the same fairness rules); a carrier only runs. Desirabilities on the brain's
scale (Attack 0.6 when an enemy is in sight, Hunt 0.45):

| Objective | When | Want |
|---|---|---|
| carry | it has their flag: run home | 0.9 |
| return | our flag is on the ground | 0.7 |
| getFlag (near) | their flag within 20 cells | 0.65 |
| hill / attackPoint, inside | on the zone already: stay | 0.65 |
| setup | Siege attackers wait in their spawn during setup | 0.65 |
| getFlag | CTF attackers (half of each side, Raven / Quake III roles) | 0.62 |
| hill / attackPoint / retake | go to the zone (Siege: defenders retake a point being captured) | 0.55 |
| escort / defend / anchor / guard | follow our carrier / guard our stand / hold the Siege point / a guard post in front of it | 0.5 |
| roam | Slayer, and Infection's survivors: the open ground, a new stretch every 30 s | 0.3 |

Loadouts: a carrier and the infected fight with the axe only (`agent.weapons`, Halo's flag melee and zombies);
the infected run 1.25× (`body.speedScale`, on top of a class's). In Siege every bot plays a class (below). In a Halo-style match a bot fights with its
`body.carry` (below): the SMG in bursts (Halo's AI fires the assault rifle so), the pistol, and a power weapon it
picked up (the sniper at range, rockets at the feet from past their own blast, the laser held through its 3 s
charge, its red sighting beam the tell). The new weapon entries (`SMG`, `SNIPER`, `ROCKET`, `LASER`) are only used
when a game's limits name them, so the sandbox's NPCs fight as before; with limits a bot doesn't dig, build or
breach with a tool it doesn't carry. With nothing in sight, no power weapon and a ready pad within 48 cells, a bot
goes for it (want 0.58: over going to a zone, under fighting and holding one); a pad it finds no way to is left
alone for 60 s; it takes a power weapon it walks onto.

## Halo rules (2026-10-11): the equal start and the weapons (`src/game/arsenal.js`)

Slayer, CTF, King of the Hill and Infection play by Halo's rules (`rules.js` `MODES[mode].style` `'halo'`;
`docs/halo-contract.md`); Siege plays by TF2's (classes) and none of this applies to it or to the sandbox.

- **The equal start**, on every `game:spawn` (the match's start, every respawn, a team switch), bots and the player
  alike: one Energy Shield stack (Halo 3's 70 shield over 45 health, full at once), the SMG and the pistol
  (`body.carry`; Halo: Reach's and CE's assault rifle and magnum), the SMG in hand, and two frag grenades
  (`body.grenades`, Halo 3's; thrown on `G` by the combat module). Nothing earned before (a shrine's perks, a
  class's) carries over. The infected carry the axe and pickaxe, no grenades.
- **Two weapons**: the player's hands are restricted to `body.carry` (`toolbelt.restrict`): `1` and `2` and the wheel
  swap them; no sandbox tools, no wands, and `Q` does nothing. A flag carrier, the player included, has the axe only
  while carrying (Halo's flag melee); the carry is back when the flag is gone. `game:stop` gives the hotbar back.
- **Halo's shots to kill** a full-shielded body, whatever the gun's sandbox damage (`arsenal.damageShare`, on a
  round's or the laser's hit only): the pistol 5 (Reach's magnum), the SMG 16 (Halo 3's assault rifle, about),
  the sniper rifle 2 (Halo 3, body shots), the laser 1. Rockets do their damage by blast (the sim's pressure),
  which this doesn't scale.
- **Power weapons on pads** (`layout.weapons`): each floats and turns over a glowing amber pad. Look at it and
  press `E`: "Rocket launcher · 4 rockets · E Pick up (drops SMG)". It replaces the gun in hand (Halo's two-weapon
  limit), which drops and lies there for 30 s for anyone to take; one you already carry gives its ammo. Shots are
  counted (each `gun:fire`) and shown after the weapon's name in the held-tool corner; the last one spent, it's gone
  and the other gun is in hand. A body that dies drops its power weapon where it fell, with the shots left.

| Weapon | Shots | Pad respawn | Source |
|---|---|---|---|
| Rocket launcher | 2 + 2 | 120 s | Halo 3's map spawn: a magazine and one spare |
| Sniper rifle | 4 + 4 | 120 s | Halopedia: a 4-round magazine; one spare |
| Laser cannon | 5 | 180 s | Halopedia: the Spartan Laser's battery, 20% a shot; the power-up tier's 3:00 |

  A pad's timer starts when its weapon is picked up (Halo 3's rule), and it brings a new one only once the last is
  out of play (spent, or a drop gone). The timers are Halo 3 matchmaking's power-weapon tier from community timer
  lists (Bungie.net's MCC Halo 3 list: Overshield and Camo 3:00); the per-map numbers weren't confirmed.
- **Where**: Dam Valley: the rocket launcher in the spillway basin's middle (the contested low way across), a sniper
  rifle per side on the ridge over its own forest (a jetpack's climb; Valhalla gives each team a sniper), the laser
  in the pump room on the shrine's floor in front of its altars (Valhalla's sits between the bases). The lab: the
  rocket launcher in the open middle by the first hill.

```js
game.arsenal;   // { on, pads: [{ key, ready, at, takenAt }], drops: [{ key, shots, at }], holds: { id: { KEY: shots } } }
```
Event: `game:weapon` `{ id, key, action: take | drop | empty | spawn, pad }`.

## Modes

| Mode | Rules | Win | Source |
|---|---|---|---|
| Team Slayer | a credited kill +1, a suicide −1 | 50 kills, else the most at 12 min | Halo 3 Team Slayer |
| Capture the Flag | touch their flag to carry it; it drops where the carrier dies; touching your own dropped flag returns it, and a dropped flag goes home after 30 s; capture by touching your stand with their flag while yours is home | 3 captures, else the most at 15 min | Halo CTF |
| King of the Hill | a team alone in the hill scores a point a second; two teams in it: contested, no one scores; the hill moves every 60 s through the map's hills | 100 points, else the most at 12 min | Halo 3 KOTH (Crazy King moves every 30 s) |
| Infection | one random body starts infected (Halo's alpha zombie); anyone who dies a survivor comes back infected (green, axe only, faster, 3× melee) | the infected when no survivor is left; the survivors when 3 min run out | Halo 3 Infection |
| Siege | after a 20 s setup, the attackers take the control points in order (A, B, C) before the clock runs out; below | the attackers by taking the last point, the defenders when time runs out | TF2 attack/defend (Dustbowl, Gravel Pit) |

Each new match reloads the current preset (`app.loadPreset`, as a new scene: not undoable),
so the terrain is fresh. The lab's own enemy spawner sleeps during a match.

HUD (`src/game/hud.js`, `game.css`): top-centre the mode, both scores (yours first and filled in your colour, the
other outlined; a bar under each filling toward the score to win, Halo 3's score meter), the clock and the objective (flags
home / taken / dropped; the hill's owner, when it moves and the leader's progress; survivors and infected; Siege's setup,
the point, who's on it and its capture bar); the killfeed (with the killer's weapon) and announcements top-right; the
scoreboard on Tab (your team first, your row highlighted); while you're dead, who killed you with what and
"Respawn in N" (Halo 3's death screen, under "You died"); the carnage report at the end. The motion tracker and
medals (bottom-left) and the reticle (centre) are other modules' (`docs/halo-contract.md`).

## Siege (`src/game/siege.js`): TF2's attack/defend

Siege plays by TF2's rules (`style: 'tf2'`), every number from the TF2 wiki and cited in `siege.js`. One round,
no halftime: one side attacks a row of control points, the other holds them.

- **Setup, 20 s** (TF2: 60 s on Dustbowl, cut to a third: our points are a short run and the class pick is one key).
  The attackers are held in their spawn by an invisible ring just past their farthest spawn point (TF2's setup
  gates); the defenders take their posts. The class picker is open (below). The clock shows setup's countdown.
- **Capturing** (wiki: Control point timing): attackers alone on the point fill its bar in 12 s (Gravel Pit's C),
  faster the more stand on it, by TF2's harmonic rate (2: 1.5×, 3: 1.83×, 4: 2.08×, so 5.8 s). A Runner counts as
  two (TF2's Scout). Any living defender on the point blocks it: the bar holds ("contested"). With no attacker on
  it the bar drains, full to empty in 30 s (TF2's default is 90 s for 6–60 s points; a third for our 12 s ones).
- **The next point**: taking a point unlocks the next, adds 1:30 to the clock (Dustbowl adds 4:30 for points three
  times as far apart) and moves the spawns: the attackers come back nearer the front, the defenders fall back.
- **The clock**: 3:00 after setup for the first point (`MODES.siege.timeLimit`), plus each capture's time.
  **Overtime**: at 0:00 with progress on the point or an attacker on it, the round goes on until the bar drains,
  6× faster (TF2: 90 s becomes 15 s) or the point falls.
- **Win**: the attackers by taking the last point; the defenders when time (and overtime) runs out.
- **Respawns**: attackers 4 s, defenders 8 s (Dustbowl's waves are 2 s and 10 s plus ~5 s of death cam: about
  half each, for our short walk back), then the usual 2 s of spawn protection.
- **Score**: the teams' scores are points taken and points still held. A capture is 2 points to each capper and a
  defense (killing an attacker on or near the point) 1, TF2's scoreboard.
- **The ring** is the defenders' colour, the attackers' while they capture alone, flashing while contested. HUD:
  "Setup · Red attack point A of 3 when the gates open", then "Point B of 3 · Red capturing ×3 · A taken", the bar
  under it, "Overtime!" ahead of it in overtime.

**Classes in Siege** (`docs/classes.md`): the class picker opens when the match starts and when you switch team
(TF2's class menu on joining a team). A pick applies at once during setup or in your side's respawn room (within 8
cells of one of its spawn points: TF2 swaps you on the spot there), else at your next spawn; dead, `,` picks for the
respawn. Closing the picker without ever having picked plays the Rocketeer (TF2's Soldier). Bots are dealt classes
per side, the first ones when the player takes a place: attackers Rocketeer, Runner, Pyro, Skyjack; defenders
Bulwark, Pyro, Skyjack, Rocketeer. A bot puts its class on at every spawn and fights with the class's tools its brain
knows (`agent.weapons`; `brain.js` `canFight`; a class with none fights with the gun). The Halo modes have no
classes: comma does nothing and a spawn takes the class off.

**Bots' objectives**: attackers wait in spawn during setup, then go for the current point and hold it (a bot with no
gun to shoot from the point, a Pyro or a Runner, fights an enemy it sees within 40 cells first). Defenders split: the
first defender bot (the Bulwark) anchors on the point, the others stand guard 10 cells out in front of it toward the
attackers' spawn, on three posts 0.6 rad apart, moving to the next post every 25 s (or when there's no way to one).
While attackers are on the point, every defender goes to retake it.

**Maps** (`layout.siege`, below): Dam Valley has three points, red attacking: A on red's end of the dam (its
abutment top), B on blue's end, C on the plateau at blue's front door. Blue first spawns forward on its abutment
top; when A falls red's spawn moves up onto red's abutment and blue's back to its fortress; when B falls red takes
blue's abutment spawn. The lab has two, red attacking: A in the gap between the tank and the lava pit, B past the
wooden tower toward blue's corner; once A falls red spawns north of the pit, clear of the sand heap.

Events: `game:setup` `{ open: true }` when the gates open, `game:point` `{ index, letter, team, by: [ids] }` for a
capture, `game:overtime` `{ index }`. `game.state.siege`: `{ attackers, defenders, points, stage, letter, taken,
progress, cappers, contested, overtime, setup, setupLeft, point }`. `game.inSpawnRoom()`: the player is in their
respawn room (the class picker asks it).

## Medals, tracker, power-ups (Halo matches)

A Halo-style match (`style: 'halo'`: Slayer, CTF, KOTH, Infection; not Siege) gets Halo 3's layer of reward and
awareness, `src/game/feel.js` over three modules. Sources: Halopedia ("List of Halo 3 and Halo 3: ODST medals",
"Overshield", "Motion tracker", "MLG"); each number is a named constant citing its own.

**Medals** (`medals.js`, pure; shown by `medalHud.js`). Every body earns them, bots too; the player's own pop in
bottom-left, stacked above the tracker, newest at the bottom, each for 3 s (6 at most), with a synthesized sting per
kind (`audio.js` `medalMulti | medalSpree | medalStyle | medalObjective`, a beat apart). A kill's rarest medal is
called out by a deep, slow voice (the browser's `speechSynthesis`; silent where there is none) and, for a multi-kill
or a spree, as a line high in the centre under the objective. No Halo audio or art: the badges are CSS hexagons.

| Medal | When | Source |
|---|---|---|
| Double Kill … Overkill, Killtacular, Killtrocity, Killimanjaro, Killtastrophe, Killpocalypse, Killionaire | 2 … 10 kills, each within 4 s of the last (past 10, Killionaire again) | Halo 3 |
| Killing Spree, Killing Frenzy, Running Riot, Rampage, Untouchable, Invincible | 5, 10 … 30 kills without dying (past 30, Invincible every 5) | Halo 3 |
| Killjoy | end a spree of 5 or more | Halo 3 |
| Beat Down, Assassin, Grenade Stick | the cause `melee`, `assassination`, a stuck grenade (combat's cause strings) | Halo 3 |
| Grenade Kill | the cause `grenade` | Halo 4 (Halo 3 has only the Stick) |
| Splatter, Splatter Spree (5), Vehicular Manslaughter (10) | run over (`Run over by a …`) | Halo 3 |
| Sniper Kill, Sniper Spree (5), Sharpshooter (10) | shot with the sniper in hand (Halo 3 wants a headshot) | Halo 3 |
| Laser Kill, Incineration | lasered; burned or torched | Halo 3 |
| Death from the Grave | a kill credited after the killer died | Halo 3 |
| First Strike | the match's first kill | Reach |
| Extermination | the whole enemy side (4 or more) dead at once | Halo 3 |
| Perfection | win Slayer with 15+ kills and no deaths | Halo 3 |
| Flag Score, Killed Flag Carrier, Flag Kill | capture; kill their carrier; a melee kill with the flag in hand | Halo 3 |
| Flag Returned | touch your dropped flag home | Halo 2 (Halo 3 has none) |
| Hail to the King | 5 kills in a row from inside the hill, in one life, before it moves | Halo 3 |
| Infection Spree, Mmmm... Brains; Zombie Killing Spree, Hell's Janitor; Last Man Standing | 5, 10 infections in one life; 5, 10 zombies killed; the lone survivor at the clock | Halo 3 |

Each roster entry carries `medals` (its count this match) and `medalCounts` (`{ KEY: n }`) for the scoreboard.
Events: `game:medal` `{ id, key, name, kind, mine, order }` for every award. `node tools/medals-check.mjs` checks the
rules in node.

**Motion tracker** (`tracker.js`), bottom-left beside the vitals: Halo 3's 25 m (`RADAR_M`, the bots' own), turned with
the view so ahead is up. Teammates always show (yellow); an enemy shows (red) only while it moves faster than a
crouch-walk (`player.js` `CROUCH_WALK_SPEED`) or for 1 s after it fires (`gun:fire`, `wand:fire`, `flame`, `laser`:
the bots' shots too), then fades over 0.6 s. Infection's last survivor shows on every zombie's tracker. Halo 3 doesn't
mark height; ours draws a body more than a storey (3 m) above or below as a triangle pointing up or down. A ping
sweeps out every 1.5 s. It's a 2D canvas redrawn at 30 Hz at most; hidden while you're dead or watching.

**Power-ups** (`powerups.js`): during a Halo match each shrine's Noita perks are put away and an **Overshield** floats
over its middle altar (Dam Valley: four); the match's end puts the perks back. A body (player or bot) takes one by
walking into it, Halo's way, and it returns 120 s later (Halopedia "MLG": "All Powerups spawn after 120 seconds";
Halo 3 matchmaking's own isn't documented). The Overshield is Halo 3's: 200% of the shield, one green layer on the
shield bar (Combat Evolved's and Reach's are 300%); it charges for 3 s, the body untouchable meanwhile but by a
backstab, then the extra drains away over 60 s (Halopedia: "gradually depletes", no rate given: ours). A hit takes the
extra first; the refill never brings it back; death takes it (`vitals.js` `giveOvershield`, `body.overshield()`).
Whoever wears one glows green (brighter while it charges), as in Halo; your own glow isn't drawn over your view.
Events: `game:powerup` `{ id, kind, point, mine }` (a rising charge sound). Active Camo is not in yet.

`node tools/feel-check.mjs [--url http://localhost:5424] [--preset damValley] [--shot file.jpg]` (AC power, a dev
server) checks the pads, an Overshield pickup and its bar, the tracker's canvas, a melee Double Kill's medals, and
that the match's end puts the perks back.

## Halo combat: grenades, melee and feedback (2026-10-11)

Halo's golden triangle, guns, grenades and melee, in a Halo-style match (`game.style === 'halo'`; `src/pov/halo.js`
`haloMatch()` follows `game:spawn` / `game:stop`). Halo 3's numbers, against Halo 3's 70 shield over 45 health
(one base life = 45 points: `halo.js points()`); the sources are cited beside each constant.

- **Frag grenade, `G`** (`src/pov/frag.js`, the player's key in `src/pov/combat.js`): thrown from the eye along the
  aim without putting the gun away (a lob of the left hand in the viewmodel), spending `body.grenades` (the arsenal
  gives 2 at every spawn; Halo 3 carries at most 2). It flies on the shared projectiles at Halo 3's 10 wu/s (30 m/s)
  and 90% gravity, plus the thrower's own speed, bounces off cells and bodies (keeps 0.3 of its speed into a face,
  0.35 along it, by eye: it skids on a few metres) and rolls to a stop. Fuse: 0.5 s after its first bounce, never sooner than 1.3 s after the
  throw (Halopedia "H3:Frag Grenade"), so one thrown at a wall goes off on the rebound; one that touches nothing goes
  off at 4 s. Going off is the **sim's own blast** (the rocket's pass, `rocketFrag`: crater, fireball, a pressure wave
  that throws loose matter and bodies and hurts every body, teammates and the thrower too; `blast` event with `by`,
  so kills are credited) **plus Halo's shrapnel**: 160 points within 0.5 wu falling to 60 at 1.75 wu (1.5 m to 5.3 m),
  ×0.5 against a Spartan, on the hit rules (no teammates; nobody behind a wall when the bots' world model is loaded),
  cause `'grenade'`. The shrapnel alone pops a full shield within about 2.3 m; with the blast's pressure, a body near
  the centre dies. **The dead drop their grenades** where they fall (Halo 3); a live body walking within 3 cells of one
  picks it up, to 2. Dropped ones go after 30 s or at the match's end.
- **Bots throw frags**: `ai/brain.js` `WEAPONS.FRAG` (fuzzy: mid range only, 12-45 cells, never point-blank; 6 s
  between; the gun stays in hand, `holds`), a 0.6 s wind-up (the arm up: the tell), then the bomb's low-arc lob at
  the frag's speed and gravity to land at the target's feet (σ 12% of the distance). `npc.js` throws it
  (`intent.frag`). The arsenal's bot loadout (`agent.weapons`) must include `'FRAG'` (or be null) for them to.
- **Melee, `F`** (`src/pov/kick.js`; outside a Halo match F is still the Noita kick): a body within the lunge (0.8 wu,
  2.4 m from the eye along the aim, no wall between) takes Halo 3's blow: 70 points (Halopedia "H3:Melee"), so one pops
  a full shield and the second kills ("two blows to a normally-shielded opponent's body were sufficient to kill").
  From behind (the knife's TF2 backstab test, `knife.tool.js behind`) it is Halo's **assassination**: it kills through
  any shield. You lunge into a body beyond the boot's reach (8 m/s); 0.8 s between blows (lunge range and recovery
  by eye: Halopedia gives none). No body in reach: the boot kicks the cells as ever. **Bots melee the same way**: an
  enemy in the lunge, in sight past the reaction delay, gets the bot's kick, turned to it (`brain.js wantsMelee`).
  Halo's blows (melee, shrapnel) are dealt exactly (`hurt` opts `{ exact }`), not scaled by the bodies' sandbox
  damage-taken shares (npc.js 0.6, the player's 0.5).
- **Causes** (`body.cause` → `game:kill` `cause`, the medals read them): `'melee'`, `'assassination'`, `'grenade'`.
  Everything else keeps its sandbox cause: a gun's round (pistol, SMG, sniper) `'Shot'`; the laser cannon
  `'Lasered'`; a rocket, a bomb and a frag's overpressure `'Blown up'` (vitals.js pressure damage), or a slam
  `'Slammed into …'` / `'Fell N m'`; the knife `'Stabbed'` / `'Backstabbed'`; the axe `'Axed'`, the pickaxe `'Picked apart'`; the burrower `'Bored'`; the kick
  `'Kicked'`; a vehicle `'Run over by a …'`. A rocket never hits a body itself: it kills by its blast.
- **Feedback** (`pov/hud.js`, centre): Halo's **red reticle** while the crosshair is on an enemy within the held gun's
  red-reticle range (Halo 3's auto-aim range: Assault Rifle 15 wu, Battle Rifle 17, SMG 12; the sniper and the laser
  across the map; melee tools the lunge); the **hitmarker** for any blow of yours that landed (`body:hit`: shots,
  melee, shrapnel); the **grenade count** beside the held tool's readout.
- **Shields on any body** (any match or the sandbox, `body:shield` from player.js): a gold flare and motes over a body
  whose shield takes a hit (Halo 3's shimmer), a bigger flare, sparks and the pop sound when it breaks (vfx.js,
  audio.js); for the player, a gold flare on the screen's edge (hud.js) on top of the shield's existing crackle,
  pop, recharge hum and empty beeping.

## API

```js
const game = __app.pov.game;
await game.start('ctf', { side: 'red' });   // 'slayer' | 'ctf' | 'koth' | 'infection' | 'siege'; side: auto | red | blue | spectate
                                             // fresh: true: the map was just loaded, don't reload it
game.prepare();                              // load the bots' module now (app.js: while the loading screen is up)
game.end();                                  // stop, no winner (no report, no next match)
game.leave();                                // out of the match loop, to the start menu
game.nextIn;                                 // s to the next match while the report counts down, else null
game.useLayout(layout);                      // a map's (below); null: the lab's
game.state;   // { running, mode, time, timeLeft, teamScore, objective, flags, hill, siege, roster, bots, botMs }
game.roster;  // [{ id, name, team, bot, kills, deaths, score, role, ... }]
```

Options to `start` also override the mode's rules (`scoreToWin`, `timeLimit`, `hillMoveS`, `alphas`, `teamSize`;
Siege's `setupS`, `captureS`, `timeBonus`): the check uses them to fit a run in minutes; the menu never does (tuning values are constants).
Events on `povEvents`: `game:start`, `game:end` `{ winner, score, why }`, `game:kill` `{ killer, victim, by, id, cause }`,
`game:flag` `{ team, action: taken | dropped | returned | captured, by }`, `game:hill` `{ index, at }`,
`game:infected` `{ id, by }`, `game:setup`, `game:point`, `game:overtime` (Siege, above), `game:team` `{ id, team }`,
`game:medal` and `game:powerup` (above). `game.feel` is the medals, tracker and power-ups layer (`medalsOf(id)`, `powerups`).

## Layouts

`game.useLayout(layout)` takes a map's objects in grid cells (feet on the floor):

```
{ name, size: [nx, ny, nz],
  spawns: { red: [[x, y, z], ...], blue: [...] }, flags: { red: [x, y, z], blue: [x, y, z] },
  hills: [[x, y, z, r], ...],
  siege: { attackers: 'red', points: [[x, y, z, r], ...], spawns: [{ attack: [[x, y, z]], defend: [...] }, ...], core },
  shrines: [...], vehicles: [...],           // shrines and vehicles: other modules'
  weapons: [{ key, at: [x, y, z], respawnS? }] }   // power weapons' pads (Halo-style matches: arsenal.js)
```

`siege.points` are taken in order; `siege.spawns[i]` is where each side spawns while point i is the live one (a
stage without one keeps the last stage's, the first falls back on the team spawns). `core` is the last point, kept
for older readers; a layout with only `core` plays as one point.

Without one, the loaded arena's (Dam Valley: `arenas/damValley.js` `DAM_VALLEY_LAYOUT`, `app.getArena()`); without
an arena (or with a layout that doesn't fit the box) the lab's is used (`labLayout`, any box size): red's base in the
open north-east corner, blue's in the south-west past the wooden tower; hills between the tank and the pit, the tank
and the tower, and south of the pit; Siege's points as above.

## Check

`node tools/join-check.mjs [--url http://localhost:5425]` (AC power, a dev server): the start menu's Play drops into
a Slayer match on Dam Valley with the player on a team, prints the `join:` timing marks, plays a match with its
score to win cut to 1 and asserts the carnage report and that the next match starts by itself; Esc closes the M
menu without opening the start menu.

`tools/halo-combat-check.mjs --url http://localhost:PORT` (default port 5423; `tools/combat-check.mjs` is Big Team
Battle's shield, perks, knife and pogo check) starts a Team Slayer and checks Halo
combat on the GPU: G throws a frag (the count drops, a blast goes off where it lands, its shrapnel hurts a bot
there), F's melee does Halo's 70 points (one pops a bot's full shield, a second kills it, from behind one kills),
the reticle reddens on an enemy and the shield's events reach the bus.

`node tools/modes-check.mjs [--url http://localhost:5405] [--preset lab|damValley] [--modes slayer,ctf] [--side spectate|red] [--strict] [--sweep 0,2,4,6,8] [--tour prefix]`
(AC power, a dev server). Bots only by default; each mode runs until it has done its thing or a game-time box:
kills score (Slayer), a flag is taken and captured or returned (CTF), the hill scores (KOTH), the infection
spreads (Infection), a point is taken (Siege; `--strict`: the round ends); no page errors.

`node tools/siege-check.mjs [--url http://localhost:5421] [--preset lab|damValley] [--shot file.jpg]` (AC power, a
dev server): a short-fused Siege round with the player attacking. The picker opens on the start, a pick in setup
applies at once, the setup gate holds, every bot has a class and its weapons, the gates open, the player takes A,
the clock gains time; dead, comma picks for the respawn; Slayer has no classes; sandbox's comma opens the picker.
`node tools/siege-rules-check.mjs` needs nothing: Siege's rules, classes and bot objectives on the CPU with a fake game. `--sweep` measures the frame
rate and the bots' CPU time per frame with that many bots; `--tour` screenshots a CTF match on red.

Measured 2026-10-10 (M-series MacBook, headless Chromium on Metal, with other agents' GPU runs sharing the
machine, so absolute frame rates are noisy): the bots' brains and bodies cost 1–3 ms of CPU a frame for 8 bots
(`state.botMs`); the frame rate showed no consistent drop from 0 to 8 bots (sweeps: 12 → 9 fps and 14 → 20 fps, the
machine's load setting both), so 4v4 counting the player (7 bots) is the default. Results of the bots-only run:
Slayer scored in 8–27 s, CTF took and returned a flag in 15–40 s and captured one in 181 s (`--strict`), KOTH's hill
scored 5 points in 12–40 s, Infection spread in 5–31 s, Siege swapped sides at 50 s and played both halves to a result.
On Dam Valley (`--preset damValley`): Slayer scored by 88–105 s, CTF took and returned a flag at 153 s, KOTH scored
in 29 s, Infection spread in 5 s, Siege swapped at 50 s. Paths that don't exist cost: the bots' CPU spikes to ~20 ms
a frame for a moment at a Dam Valley start, while every bot tries its bearings to unreachable spots.

## Not yet

- A bot with a power weapon doesn't save it for a fight worth it, and bots can't reach the ridges' snipers (no
  jetpack in the nav): a bot seeking one gives up and leaves that pad alone for 60 s.
- Siege (2026-10-11 rework) is unplayed in a browser: the balance (setup 20 s, 12 s captures, 4 s / 8 s respawns,
  3:00 + 1:30 a point) is TF2's numbers scaled by reasoning, not by watching bots play. `tools/siege-check.mjs` and
  `modes-check.mjs --modes siege --strict` are the first things to run.
- Siege's setup gate is invisible (a ring that pushes attackers back), not a door you can see; the respawn waves are
  per-body delays, not TF2's shared wave clock. One round per match: the sides don't swap (TF2 swaps between rounds).
- Siege bots don't use the Runner's pogo, the Spy's knife or the Sapper's pickaxe as weapons (`brain.js` has no
  entries for them); none of those classes are dealt to bots.
- Not in worlds (the window): NPCs don't follow it, so team games are box presets only.
- The NPC nav is one height-map layer: roofed halls, tunnels (Dam Valley's pump room) and the crest shrine's hill are
  reached by the straight-in fallback or not at all. A layered nav (a voxel navmesh, Recast-style) is the real fix;
  remembering unreachable spots per bot would remove the start-up spike.
