# Halo and Siege: build contract (2026-10-11)

The team games (`src/game/`, `docs/modes.md`) play by one of two rule sets, picked per mode in
`src/game/rules.js` `MODES[mode].style`:

- **`'halo'`**: Team Slayer, CTF, King of the Hill, Infection. Halo 3's equal start: everyone,
  bots included, spawns with a shield, the same two guns and two grenades. No classes, no sandbox
  tools, no spawn menu during a match.
- **`'tf2'`**: Siege. Team Fortress 2's classes: the class picker opens when you join.

The goal: you click once on the start menu and you are in a match that feels like Halo (or TF2,
for Siege) within seconds, and it's fun. Five agents build it in parallel against this contract,
each in its own worktree, each owning the files listed below. The integrator merges them.

## Shared hooks (already in this commit)

- `R.styleOf(mode)`, `R.isHalo(mode)` (rules.js); `game.style` is `'halo' | 'tf2'` while a match
  runs, else `null`.
- `povEvents` `game:spawn` `{ id, team, bot, body, mode, style }`: a body enters play in a match
  (the match's start, every respawn, a team switch). It fires after the shell has
  put the player's class on (`classes.spawned`, pov/index.js). Death clears every perk
  (vitals.js), so whatever a spawn gives (shield, loadout, grenades) is given again here, every time.
- `povEvents` `game:stop` `{ mode, style }`: the match is over, ended or abandoned (also before a
  restart). Undo what a spawn did to the player (a restricted hotbar, a hidden spawn menu).
- Existing: `game:start`, `game:end`, `game:kill` `{ killer, victim, by, id, cause }`, `game:flag`,
  `game:hill`, `game:infected`, `game:half`, `game:team`; `body:hit` `{ id, amount, cause, by }`;
  the body's own `'shield'` events (`hit | break | recharge | full`, vitals.js).

## Shared body fields

| Field | Owner (writes) | Readers | Meaning |
|---|---|---|---|
| `body.team` | game/index.js | all | `'red' \| 'blue' \| 'infected' \| null` |
| `body.carry` | arsenal | combat, feel | tool keys the body may hold in a Halo match (at most 2 guns), `null` = no limit (sandbox, Siege) |
| `body.grenades` | arsenal sets on spawn; combat spends | combat (HUD count), feel | frag grenades carried; `undefined`/`null` = grenades off (sandbox, Siege) |

## Layout field

`layout.weapons: [{ key, at: [x, y, z], respawnS }]` (grid cells, feet on the floor): the power
weapons' pads. The arsenal agent adds it to `DAM_VALLEY_LAYOUT` (arenas/damValley.js) and to
`labLayout` (game/layout.js).

## Who owns what

| Agent | Worktree, branch, port | Owns |
|---|---|---|
| **siege** | `../tpt-siege`, `siege`, 5421 | `src/game/siege.js` (new; move Siege's code out of index.js into it), Siege's parts of `game/index.js`, `pov/classes.js`, `pov/classPicker.js` + css, the class picker's gating in `pov/index.js` (open by default in Siege, never in a Halo match) |
| **arsenal** | `../tpt-halo-arsenal`, `halo-arsenal`, 5422 | `src/game/arsenal.js` (new): the equal start (shield, guns, grenade count), two-gun carry, power-weapon pads on timers with E to swap, bots' loadout (`loadout()` in game/index.js, `ai/brain.js` WEAPONS: SMG and the power weapons); the hotbar restriction (`pov/tools/index.js`, `hotbar.js`); Q spawn menu off in a match (`pov/index.js` KeyQ); `layout.weapons` |
| **combat** | `../tpt-halo-combat`, `halo-combat`, 5423 | the frag grenade on G (new module), bots throwing frags (one more `brain.js` weapon entry), F as Halo's melee in a Halo match (`pov/kick.js`), the hit marker and red reticle (`pov/hud.js`), the shield's crackle and pop on any body (`pov/vfx.js`, `pov/audio.js`) |
| **feel** | `../tpt-halo-feel`, `halo-feel`, 5424 | `src/game/medals.js` (medals, sprees), `src/game/tracker.js` (motion tracker), their CSS, the Overshield (`pov/vitals.js`, shrines in a Halo match), their sounds (`pov/audio.js`) |
| **join** | `../tpt-halo-join`, `halo-join`, 5425 | one-click Play on the start menu (`src/ui/menu.js`, menu.css, `src/main.js`, `src/launch.js`, `app.js` startMode/openMap), the next match starting by itself (`end()` in game/index.js), `game/hud.js` + `game.css`, the first seconds in a match (hints, controls card, menus) |

Two agents may need the same file (`ai/brain.js` WEAPONS: arsenal and combat; `pov/audio.js`:
combat and feel; `pov/index.js`: siege, arsenal, combat). Keep your edits there small and in
their own functions or entries, so the merge is mechanical.

## Screen regions

- top-centre: scores, clock, objective (join, game/hud.js)
- top-right: killfeed, announcements (join)
- bottom-left: motion tracker; medals stack just above it (feel), as Halo 3
- centre: reticle, hit marker (combat)
- the grenade count: beside the held weapon's readout (combat)
- the pickup prompt: the existing interact prompt (arsenal, interact.js)
- the class picker: full-screen, as today (siege)

## Keys in a match

G grenade (combat) · F melee (combat; the kick key outside a match) · E pick up / vehicles
(arsenal; interact.js) · wheel and 1/2 swap guns (arsenal) · `,` class picker in Siege only
(siege) · Tab scoreboard · `.` team (join). Q (spawn menu) does nothing in a
match (arsenal).

## Rules for every agent

- Borrow the number from Halo 3 (Siege: TF2), cite it in a comment, and give it a named constant
  (no magic numbers). Plain-English comments in the codebase's style.
- Update `docs/modes.md` for what you change.
- Commit only on your branch; don't push, don't deploy. The integrator merges and ships.
