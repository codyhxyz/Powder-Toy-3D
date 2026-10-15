# Descent: build contract

> The playable map now uses the eight-scene source route in
> [noita-source-import.md](noita-source-import.md).
> This document describes the retained legacy Wang generator and the shared gameplay systems.

Descent is a Noita-style map: the starting mountain and the first three levels
of Noita's main path, in 3D, with wands to find. Three agents build it in
parallel against this contract; each owns its files, and integration merges them.

Reference: the Noita new-game map (user's copy; see the "Noita map reference" memory). At
game (0,0) a snow-capped mountain stands over the **Mines** (a band of horizontal
tunnels shored with timber). Under every biome is a **Holy Mountain**: a sealed
sandstone band entered by a shaft at one end, holding a horizontal temple (healing
pool, wand and spell shop, perk altar with three offers, spell refresher), left by a
drop at the other end into the next biome. Then **Coal Pits**, Holy Mountain,
**Snowy Depths**, Holy Mountain. Noita px ≈ 0.15 m; biome bands ≈ 3,600 × 900 px.

## Levels: one world scene each, the temple is the seam

Every level is its own world scene (`src/world/scenes/`), so each stays one window
tall and cheap. The temple sits at the bottom of each level; walking into its exit
loads the next level's scene with the player at that level's spawn (Noita's own
seam: biomes never touch, a Holy Mountain is always between).

| Level | Scene key | Noita biome | Tier |
| --- | --- | --- | --- |
| 1 | `descentMines` | Surface + starting mountain + Mines | 1 |
| 2 | `descentCoal` | Coal Pits | 2 |
| 3 | `descentSnow` | Snowy Depths | 3 |

After level 3's temple the run is won (a toast and back to the map menu, for now).

## Shared data: `src/world/scenes/descent/levels.js` (owner: A)

Plain data, no heavy imports (B and C import it). World cells, integers.

```js
export const DESCENT_LEVELS = [{
  key: 'descentMines', name: 'Mines', tier: 1,
  spawn: [x, y, z],                      // where the player starts the level (feet)
  temple: {
    box: [x0, y0, z0, x1, y1, z1],       // the temple's air volume (inside = in the temple)
    pool: [x0, y0, z0, x1, y1, z1],      // healing pool water volume
    altars: [[x, y, z], [x, y, z], [x, y, z]],   // perk offers (perks.js SHRINE_OFFERS = 3)
    shop: [[x, y, z], ...],              // 5 pedestal tops: shop item sites
    refresher: [x, y, z],                // spell refresher site
    exit: [x0, y0, z0, x1, y1, z1],      // entering this volume descends
  },
  loot: [{ x, y, z, kind: 'wand' | 'spell' | 'gold', tier }],   // deterministic sites, on floors in open air
  chests: [{ x, y, z, tier }],           // treasure chests (2–3; the kits' treasure nooks first)
  potions: [{ x, y, z, tier }],          // potion flasks lying about (6)
}, ...];
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
```

As built (A): the sites are computed from the scenes' JS twins
(`src/world/scenes/descent/sites.js`) and written into `levels.js` as plain data
by `node scripts/check-descent-levels.mjs --write` (the same script without
`--write` checks them: in air, on a solid floor, temple sealed in WALL, a way down
from the spawn to the temple). The levels are fixed (the world seed is unused), so
the data never goes stale at runtime. `levels.js` also exports
`nextLevel(key)` (the level after, or null) and `inBox(box, [x, y, z])`.
Facts the shapes rely on:
- every level is a 512 × 256 × 512 world (`DS_WORLD`); the temple is the same in
  all three: box `[186, 14, 246, 330, 30, 266]`, exit pit `[318, 4, 246, 330, 10, 266]`
  (you fall 10 cells into it), shop sites on BRICK pedestal tops (`y` 17), altars
  and the refresher on the temple floor (`y` 14);
- a site / spawn is the air cell the feet stand in, the cell under it solid;
- loot: 5 wand, 6 spell, 25 gold per level, `tier` = the level's tier; plus 3 chests
  and 6 potions (`sites.js` CHEST_COUNT, POTION_COUNT), picked first-come in the
  order chest, wand, spell, potion, gold (chests prefer the kits' `treasure`
  sites), all spaced apart by the same rules;
- the scenes carry `shrine: false` (no world shrine; app.js `worldShrine`) and
  `descentLevel` (0, 1, 2).
- the tunnel layout is one GLSL function, `dsTunnel` in `descent/scenes.js`
  (its header lists what a replacement must keep).
- Wang levels (`DS_LEVEL_DEFS[i].kit`, docs/wang-tiles.md; the Mines since
  2026-10-11): `dsTunnel` returns the tiling's cell (`dsWang`: GPU `wangCell`,
  twin `wangCellJS`; the kit's ROCK falls through to `dsRock`). The region starts
  at `BIOME_Y0`, offset in x and z so its exit unit sits over the temple's entry
  shaft, and holds 4 layers of 24 cells under the surface or roof. The way in
  ends in an entry hall on the region's top over the entry shaft (unit
  `ENTRY_I/ENTRY_K`); the bake checks both line up. Sites: the kit's sites the
  body's walk (`wang/walk.js walkFlood`, `sites.js wangWalk`) reaches from the
  spawn; the check also requires the walk to reach the temple. A deep level with
  a kit spawns in its entry hall.

## Events (`src/pov/events.js` povEvents)

- `descent:temple` `{ level, inside: bool }`: emitted by A when the player enters
  or leaves `temple.box`.
- `descent:exit` `{ level }`: emitted by A when the player enters `temple.exit`; A
  then loads the next level.
- `descent:level` `{ level, key }`: emitted by A after a level has loaded and the
  player stands at its spawn.

## Owners

- **A, World** (`src/world/scenes/descent/`, `src/world/scenes/index.js`,
  `src/maps.js`, app level-switch plumbing): the three scenes (GLSL `sceneCell` +
  JS twins, per scenes/index.js), the temple geometry, `levels.js`, the
  events above, the `descent` map entry (Sandbox). The player's run state (wands,
  gold, perks, health) survives a level change.
- **B, Wands** (`src/pov/wands/generate.js`, `src/pov/wands/loot.js`, minimal hooks
  in `src/pov/tools/index.js`): Noita's wand generation by tier (stats ranges,
  slots, shuffle, preloaded spells from a tier pool), wand and spell pickups at
  `loot` sites (walk into one, like perk orbs), Noita's 4 wand slots plus a spell
  bag on the Descent map, and editing allowed only while `descent:temple inside`.
  Off the Descent map, wands behave exactly as today. Another branch is rewriting
  wand visuals (`visuals.js`, `runtime.js` events, the held wand model in
  `tools/index.js`): keep edits there small and additive.
- **C, Holy Mountain** (`src/pov/descent/` or similar): gold (nuggets as pickups at
  `kind: 'gold'` sites and dropped by enemies; a gold count on the player and in the
  HUD), the shop (items on `shop` pedestals, priced by tier, bought by walking in
  with enough gold; stock from B's generator: import `generateWand(tier, seed)` and
  `randomSpell(tier, seed)` from `src/pov/wands/generate.js`; stub them until B
  lands), the perk altar (reuse perks.js / perkOrbs.js shrine offers at `altars`),
  the healing pool (full heal on touch, once per temple, as Noita's), the spell
  refresher (refills limited-use spells; until those exist, refills mana and storage).

Every number is a named constant; borrow Noita's numbers and cite them.

## B's API (wands, as built)

`src/pov/wands/generate.js` (plain data, safe to import anywhere):

- `generateWand(tier, seed)` → `{ id, name, tier, cards, config, look, noita }`.
  `config` is the compiler's: `manaMax, manaRegen` (Noita's mana and mana/s),
  `castDelay, recharge` (seconds: Noita frames ÷ 60), `capacity`, `shuffle` (0/1),
  `spellsPerCast`. Rolled from Noita's `gun_procedural.lua` budget (tier 1/2/3 =
  `generate_gun(30/40/60, level)`), preloaded from the tier's spell pool. Same seed,
  same wand; every generated deck compiles.
- `starterWand(seed)`, `bombWand(seed)`: the run's two starting wands.
- `randomSpell(tier, seed)` → spell id (any kind, weighted as Noita's shops).
- `spellPrice(tier, id, { sale })`, `wandPrice(tier, wand, { sale })`: gold, by
  `generate_shop_item.lua` (spell: `max(floor((price·0.3 + 70·tier²)/10)·10, 10)`;
  wand: `50 + 210·(tier/2 + tier²/2) ± 150`; a sale halves).

`src/pov/wands/loot.js` re-exports `descentWands` (state in `descentRun.js`,
which survives level loads):

- `descentWands.give(wand)` → `{ slot, dropped }` or null (a deck that doesn't
  compile). With four wands it replaces the held one and drops it at the player's feet.
- `descentWands.giveSpell(id)` → bool: into the spell bag (editor's library on Descent).
- `descentWands.refresh()`: every carried wand to full mana and ready (the refresher).
- Also: `wands`, `bag`, `held`, `inTemple`, `full`, `on('change' | 'drop' | 'refresh', fn)`.
- `wandLines(wand)` → the stat lines the pickup label shows (reuse for shop labels).

A run starts (`reset`: Bolt staff + bomb wand, empty bag) when a Descent level loads
from a non-Descent map. Wands sit in the Guns slot (key 3), ahead of its tools; B
edits only the held wand, only while `descent:temple` inside is true, from the bag.
Pickups (kind `wand`/`spell` sites) are look + E via `interact.provide` (the POV
shell passes `interact` and `getScene` into the toolbelt env). Until `levels.js`
exists (imported through a glob in `descentSites.js`), no scene is Descent.

## C: Holy Mountain API notes (src/pov/descent/)

- `deps.js` is the only seam: it globs A's `levels.js`, B's `wands/generate.js`
  (`generateWand`, `randomSpell`, `wandPrice`, `spellPrice`), B's `descentWands`
  (exported `descentWands` from `wands/loot.js` or `wands/generate.js`, or
  `toolbelt.descentWands`). Missing ones fall back to stand-ins (`stubs.js`; a bought
  wand is equipped with `toolbelt.equipWand`, a spell is only announced). Nothing else
  needs editing when they land.
- Look + E: the shell's `interact` (src/pov/interact.js) is passed to `createDescent`;
  the shop's items (verb Buy) and the refresher (verb Use) are offered through
  `interact.provide()`. The altar's perks come through perkOrbs' own provider.
- `pov.descent` (pov/index.js): `{ gold, goldShown, purse, level, shop, shrine,
  nuggets, refresher, arrive(key) }`. Runs every frame on a Descent scene
  (`levelByScene(settings.scene)` while in a world).
- Arrival: on `descent:level`, or (before A lands) the first live POV frame on a
  Descent scene. Arriving at `DESCENT_LEVELS[0]` starts a new run: gold 0, new run seed.
  Per arrival: the shop is rolled (seed = run seed × level key), one shrine is placed
  with `perkOrbs.shrineAt(altars)`, 'gold' loot sites get nuggets.
- Shop: `temple.shop` pedestals; Noita's coin flip: a wand shop (2 wands + 3 spells)
  or a spell shop. Look + E buys; too little gold → `use()` false, a toast, nothing taken.
  Price: Noita's `max(floor((cost × 0.30 + 70 × tier) / 10) × 10, 10)` (stubs.js
  `shopPrice`, for B to reuse).
- Gold: nuggets 10 / 50 / 200 (Noita's), walk-in; 2 per 'gold' site (25 sites a level), bigger by tier.
  Killed spawner NPCs spill `ENEMY_GOLD[kind]` split into nuggets that vanish after
  15 s (blink the last 3). Death keeps gold for now (Noita ends the run).
- Healing: full heal (`player.heal(1)`) once per arrival on entering `temple.box`
  or `temple.pool`. Refresher: look + E → `descentWands.refresh()`, then it's gone.
- Events emitted: `descent:gold { amount, gold, point }`, `descent:buy { kind, id,
  price, gold }`, `descent:refuse { price, gold }`, `descent:heal`, `descent:refresh`.
- HUD: `povHud.update({ gold })`, null hides the "$ n" row (pov.css `.pov-gold`).
- Check: `node scripts/check-descent-temple.mjs`.

## D: level switching (src/pov/descent/switch.js, app.js "Descent's level switch")

- Events, now emitted by D (payload `level` = index into `DESCENT_LEVELS`, 0 first):
  `descent:temple { level, inside }` when the body starts or stops overlapping
  `temple.box` (a dead body is in no temple; dropping into the exit pit leaves it,
  the pit is under the floor), `descent:exit { level }` once per arrival when the
  body overlaps `temple.exit`, `descent:level { level, key }` once the body stands
  at a level's spawn: after a switch, and on the first live POV frame of a Descent
  world entered by hand (the map menu's Descent, then F). Box test: the body's
  upright box (BODY_WIDTH, BODY_HEIGHT) overlaps the cell box, max inclusive, as C's.
- Switch: `settings.scene = next.key; setSize('world')` (the map menu's world load:
  build(), programs shared), wait for `win.loaded`, then `pov.enter({ at })` with the
  spawn cell's middle. `enter({ at })` teleports the existing body instead of
  `spawn()`ing it, so health, fuel and statuses carry; perks, the toolbelt,
  `descentWands` (module state) and C's purse (`pov.descent`) are never rebuilt.
  `runSnapshot()` is compared before/after and a loss is console.warn'd.
- A name card (Noita's biome title) for 2 s on every arrival; "Descending…" covers the load.
  After the last level's exit: "You reached the bottom", 4 s, out of POV, map menu.
- Death: `findDropPoint` asks `app.dropAt()` first; on a Descent level that's the
  level's spawn, so dropping in by hand and every respawn land there (Noita would
  end the run; perks are lost on death as everywhere: vitals.js).
- `__app.descent`: `{ level, index, inside, busy, frame() }`.
- Checks: `node scripts/check-descent-switch.mjs` (box tests, event order, run
  carry-over, failure path). Headless (2026-10-11, AC): Mines → Coal → Snow → won →
  menu, ~2 s per switch warm; health 0.7, a perk and 120 gold came through.
- Known: the switch drops pointer lock (build() exits POV) and re-requests it without a gesture; not checked in a real window.

## Items: potions and chests (src/pov/descent/items.js, flasks.js, chests.js)

Noita's two item kinds are wands and potions. **This relaxes the "only wands on
Descent" rule (2026-10-11) for Noita's own potions:** the FLASK tool is carried on
Descent only as flasks the run has found; no other tool is.

- Potions: a flask stands at every `potions` site, full (`FLASK_CELLS` = the flask
  tool's FLASK_CAP, 125) of one material by `flasks.js rollPotion(tier, site)`:
  Noita's potion.lua split of standard vs magic materials as three bands: common
  water, oil, toxic, blood, whiskey; uncommon acid, slime, healthium, berserkium;
  rare teleportatium, levitatium, polymorphine, pheromone; deeper tiers lean magic.
  Look + E takes it into the run's item slots.
- Item slots: `descentWands.potions` (wands/descentRun.js; `POTION_SLOTS` = 4,
  Noita's), with `givePotion(flask)` → slot or −1, `setPotionCells(slot, cells)`,
  `removePotion(slot)`. Module state: survives level switches, emptied by `reset`.
  `runSnapshot` carries `potions` (material:cells), so a switch that lost one warns.
- Hotbar: flasks sit in the **Gadgets slot (key 5)**, `POTION:j` rows, apart from the
  wands in Guns (key 3) as Noita keeps wands and items in separate rows. Holding one
  is the flask tool with that flask's contents (`flask.holdCells`); click pours or
  scoops, right-click throws (the flask is gone from the run), H drinks. The tool's
  load is written back to the run whenever it changes, and refilled from the run
  after a level switch empties the tools' loads. Off Descent nothing changes.
- Chests: one at every `chests` site; look + E opens it (the lid swings back) and
  spills `chests.js rollChest(tier, site)`: 3–6 gold nuggets always, plus 2 rolls of
  more gold / a potion / 2 spells / a wand (chest_random.lua's order of likelihood).
  Gold goes out as walk-in nuggets, a wand or spells as wand pickups
  (`descentWands.place` → wands/loot.js), a potion as a flask pickup.
- Everything is seeded by its site (`levelKey:potion:i`, `levelKey:chest:i`), and
  taken / opened ones are `descentWands.markTaken` for the run.
- Events: `descent:item { kind: 'potion', material, slot }`, `descent:chest { site, items }`.
- Check: `node scripts/check-descent-items.mjs`.
