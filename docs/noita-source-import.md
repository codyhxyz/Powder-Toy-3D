# Noita: first 3D source route

Descent now starts in a Holy Mountain and ends at the Sampo platform in Kolmi's arena.
It excludes the surface, Mines, side biomes, and parallel worlds.

The route has eight scenes:

1. Holy Mountain
2. Coal Pits
3. Snowy Depths
4. Hiisi Base
5. Underground Jungle
6. Vault
7. Temple of the Art
8. Kolmi Arena

Each biome ends in a Holy Mountain. The existing level switch preserves the player's inventory, health, perks, and gold.
The final scene completes the map route. It does not simulate the Kolmi fight or the Noita ending.

## Source pipeline

`tools/import-noita-map.py` reads the installed game's `data.wak` archive.
It checks archive bounds and reads selected members without a full extraction.
Pillow decodes the material masks. NumPy composes the voxel volumes.

The compiler selects four native material scenes per biome from that biome's Lua references.
These include mining machinery, ice bridges, Hiisi rooms, jungle huts, Vault laboratories, and crypt architecture.
The native `temple/altar.png` supplies the sanctuary silhouette.
The native `spliced/boss_arena.png` supplies the final arena and its arched bridge.

Noita calls the Coal Pits `excavationsite` and the Temple of the Art `crypt`.
Its separate `laboratory.xml` is not the Kolmi arena.

The output uses the same sparse-brick format and lazy geometry loader as the Cruelty Squad imports.
Each scene has a JSON manifest and a gzip-compressed `.binpack` under `public/local-maps/`.
Each manifest records source hashes, material translations, room transforms, connectors, and conversion losses.
The repository does not contain the original archive or extracted source images.

## Authored 3D decisions

Native mask pixels determine room silhouettes and material occupancy.
Each room has variable thickness and a horizontal quarter-turn.
Stepped depth changes add ledges rather than one constant-depth slab.

Descending galleries connect the rooms across both horizontal axes.
Cross-links reconnect the galleries, and side branches lead away from the main descent.
The first pass shares a switchback skeleton across the six biomes.
The rooms differ by their native source geometry. Further biome-specific topology remains artistic follow-up work.

The route keeps the existing body scale. The compiler adds clear corridors and safe stairs where native gaps are too small.
The CPU check tests supported, six-cell-tall body movement through the final packed geometry.
It also tests every item site and every scene transition.

## Deliberate losses

- This is a deterministic source-derived adaptation, not an exact reconstruction of Noita's seeded Wang generation.
- Nearest-neighbor reduction removes small source features.
- Native terrain names map to existing physical elements. The palette inventory records unsupported colors and omitted entity markers.
- Structural snow uses ice. Loose soil and sand use sandstone so the route does not collapse at startup.
- Source fluid volumes become shallow sealed reservoirs. Deep fluid becomes glass or basalt. Sanctuary pools remain open.
- The Holy Mountain interior has an enlarged walking volume for this game's body.
- Native visual layers, background layers, entities, scripts, and boss AI do not run here.
- The initial sanctuary and final arena have no loose loot. The six biomes retain the normal loot counts.
- These checks cover initial geometry. Destruction can remove a route, as in the rest of the game.

## Rebuild

The offline compiler requires Python 3, Pillow, NumPy, and Node.
The game requires no new runtime dependency.

From the task worktree, run:

```sh
python3 -B tools/import-noita-map.py --archive /path/to/Noita/data/data.wak
python3 -B tools/import-noita-map-test.py
node scripts/check-noita-source.mjs
node scripts/check-descent-switch.mjs
node scripts/check-descent-temple.mjs
node scripts/check-descent-items.mjs
npm run build
```

`check-descent-levels.mjs` now checks the retained legacy Wang fixtures.
It does not validate the new source route.

## First-pass evidence

The packed route contains 13,676,371 occupied cells across eight scenes.
The geometry download totals 409,785 compressed bytes.
The CPU walk reaches every goal and item site. The runner check preserves the run across seven transitions.

The Coal Pits smoke check reached first person on an Apple M5 with the Metal backend.
The successful GPU slot occupied 4.902 seconds, including startup and cleanup.
The check found no page errors or GPU validation errors.
Its screenshot is a single gameplay frame, not a converged visual regression.
The converged capture helper did not settle with the active Noita presentation.
No full manual playthrough or full Noita script-parity check took place.
