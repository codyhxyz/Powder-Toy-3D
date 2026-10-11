# Descent: build contract

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
}, ...];
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
```

If a site is computed (from the scene's generator), export a function with the
same shape instead and document it here.

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
- Gold: nuggets 10 / 50 / 200 (Noita's), walk-in; 3 per 'gold' site, bigger by tier.
  Killed spawner NPCs spill `ENEMY_GOLD[kind]` split into nuggets that vanish after
  15 s (blink the last 3). Death keeps gold for now (Noita ends the run).
- Healing: full heal (`player.heal(1)`) once per arrival on entering `temple.box`
  or `temple.pool`. Refresher: look + E → `descentWands.refresh()`, then it's gone.
- Events emitted: `descent:gold { amount, gold, point }`, `descent:buy { kind, id,
  price, gold }`, `descent:refuse { price, gold }`, `descent:heal`, `descent:refresh`.
- HUD: `povHud.update({ gold })`, null hides the "$ n" row (pov.css `.pov-gold`).
- Check: `node scripts/check-descent-temple.mjs`.
