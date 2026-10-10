# Team games: Big Team Battle modes (2026-10-10)

Halo-style team games in first person: teams of bots on both sides (the lab's NPCs: the player's body,
tools and Yuka brain, `docs/pov.md` "NPCs"), the player on one of them, and five modes. Code in
`src/game/`; the rules and their sources in `src/game/rules.js`.

In first person: **M** opens the match menu (mode, side, Start / End; the mouse is freed while it's open),
**Tab** holds up the scoreboard, **.** switches team (TF2's key; a bot from the other side takes your place).
With no match running a small "M Match" chip sits top-centre. The main drawer has no match settings.

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
point; a point that moves (a carrier) is followed without re-running A* every frame. On the way and in a zone it
still shoots what it sees (Raven's weapon system runs beside the goals: `takeAimAndShoot` in `ai/brain.js`, the gun
under the same fairness rules); a carrier only runs. Desirabilities on the brain's
scale (Attack 0.6 when an enemy is in sight, Hunt 0.45):

| Objective | When | Want |
|---|---|---|
| carry | it has their flag: run home | 0.9 |
| return | our flag is on the ground | 0.7 |
| getFlag (near) | their flag within 20 cells | 0.65 |
| hill / attackCore, inside | on the zone already: stay | 0.65 |
| getFlag | CTF attackers (half of each side, Raven / Quake III roles) | 0.62 |
| hill / attackCore | go to the zone | 0.55 |
| escort / defend / defendCore | follow our carrier / guard our stand / guard the core | 0.5 |
| roam | Slayer, and Infection's survivors: the open ground, a new stretch every 30 s | 0.3 |

Loadouts: a carrier and the infected fight with the axe only (`agent.weapons`, Halo's flag melee and zombies);
the infected run 1.25× (`body.speedScale`, on top of a class's).

## Modes

| Mode | Rules | Win | Source |
|---|---|---|---|
| Team Slayer | a credited kill +1, a suicide −1 | 50 kills, else the most at 12 min | Halo 3 Team Slayer |
| Capture the Flag | touch their flag to carry it; it drops where the carrier dies; touching your own dropped flag returns it, and a dropped flag goes home after 30 s; capture by touching your stand with their flag while yours is home | 3 captures, else the most at 15 min | Halo CTF |
| King of the Hill | a team alone in the hill scores a point a second; two teams in it: contested, no one scores; the hill moves every 60 s through the map's hills | 100 points, else the most at 12 min | Halo 3 KOTH (Crazy King moves every 30 s) |
| Infection | one random body starts infected (Halo's alpha zombie); anyone who dies a survivor comes back infected (green, axe only, faster, 3× melee) | the infected when no survivor is left; the survivors when 3 min run out | Halo 3 Infection |
| Siege | the attackers hold the defenders' core alone for 30 s in all (a defender inside stops the count); at the half's end (captured or 4 min) the preset reloads and the sides swap: the other team attacks from the first attackers' spawns | a capture beats none; two captures, the faster; none, the longer hold | TF2 attack/defend, stopwatch |

Each new match (and Siege's halftime) reloads the current preset (`app.loadPreset`, as a new scene: not undoable),
so the terrain is fresh. The lab's own enemy spawner sleeps during a match.

HUD (`src/game/hud.js`, `game.css`): top-centre the mode, both scores, the clock and the objective (flags home /
taken / dropped; the hill's owner, when it moves and the leader's progress; survivors and infected; the half, the
attackers and the core count); the killfeed and announcements top-right; the scoreboard on Tab; the result for 10 s.

## API

```js
const game = __app.pov.game;
await game.start('ctf', { side: 'red' });   // 'slayer' | 'ctf' | 'koth' | 'infection' | 'siege'; side: auto | red | blue | spectate
game.end();                                  // stop, no winner
game.useLayout(layout);                      // a map's (below); null: the lab's
game.state;   // { running, mode, time, timeLeft, teamScore, objective, flags, hill, siege, roster, bots, botMs }
game.roster;  // [{ id, name, team, bot, kills, deaths, score, role, ... }]
```

Options to `start` also override the mode's rules (`scoreToWin`, `timeLimit`, `hillMoveS`, `holdToWin`, `alphas`,
`teamSize`): the check uses them to fit a run in minutes; the menu never does (tuning values are constants).
Events on `povEvents`: `game:start`, `game:end` `{ winner, score, why }`, `game:kill` `{ killer, victim, by, id, cause }`,
`game:flag` `{ team, action: taken | dropped | returned | captured, by }`, `game:hill` `{ index, at }`,
`game:infected` `{ id, by }`, `game:half` `{ half, attackers, captured, time, held }`, `game:team` `{ id, team }`.

## Layouts

`game.useLayout(layout)` takes a map's objects in grid cells (feet on the floor):

```
{ name, size: [nx, ny, nz],
  spawns: { red: [[x, y, z], ...], blue: [...] }, flags: { red: [x, y, z], blue: [x, y, z] },
  hills: [[x, y, z, r], ...], siege: { attackers: 'red', core: [x, y, z, r] },
  shrines: [...], vehicles: [...] }          // shrines and vehicles: other modules'
```

Without one (or one that doesn't fit the box) the lab's is used (`labLayout`, any box size): red's base in the
open north-east corner, blue's in the south-west past the wooden tower; hills between the tank and the pit, the tank
and the tower, and south of the pit; the core in the open south of the tank, a run from blue's spawns (on top of
them the defenders contest it forever).

## Check

`node tools/modes-check.mjs [--url http://localhost:5405] [--modes slayer,ctf] [--side spectate|red] [--sweep 0,2,4,6,8] [--tour prefix]`
(AC power, a dev server). Bots only by default; each mode runs until it has done its thing or a game-time box:
kills score (Slayer), a flag is taken and captured or returned (CTF), the hill scores (KOTH), the infection
spreads (Infection), the first half ends and the sides swap (Siege); no page errors. `--sweep` measures the frame
rate and the bots' CPU time per frame with that many bots; `--tour` screenshots a CTF match on red.

Measured 2026-10-10 (M-series MacBook, headless Chromium on Metal, with other agents' GPU runs sharing the
machine, so absolute frame rates are noisy): the bots' brains and bodies cost 1–3 ms of CPU a frame for 8 bots
(`state.botMs`); the frame rate showed no consistent drop from 0 to 8 bots (sweeps: 12 → 9 fps and 14 → 20 fps, the
machine's load setting both), so 4v4 counting the player (7 bots) is the default. Results of the bots-only run:
Slayer scored in 8–27 s, CTF took and returned a flag in 15–40 s and captured one in 181 s (`--strict`), KOTH's hill
scored 5 points in 14–40 s, Infection spread in 12–31 s, Siege swapped sides at 50 s and played both halves to a result.

## Not yet

- The player carrying a flag keeps the whole hotbar (bots melee only); an infected player too. Classes could give
  the infected a loadout (`applyClass`).
- Siege swaps who attacks, not where the core is: the core stays by the first defenders' base and the second
  attackers spawn on the first attackers' side, as in TF2.
- Siege is hard on the attackers: with 4v4 on the lab the defenders nearly always stand on the core, so holds are a
  second or two and halves end on the clock. TF2 balances this with respawn waves; ours are equal.
- The POV entry hint (the first 7 s in first person) sits over the objective line.
- Not in worlds (the window): NPCs don't follow it, so team games are box presets only.
