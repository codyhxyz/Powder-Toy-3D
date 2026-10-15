# Noita: assembled terrain folded into 3D

Descent uses actual terrain from an archived Noita world.
It does not assemble room templates or generate replacement corridors.
The previous room-collage conversion is removed.

The crop starts at the native Holy Mountain arrival above Coal Pits.
It includes Snowy Depths, Hiisi Base, Underground Jungle, Vault, Temple of the Art, and Kolmi's arena.
The surface, Mines, parallel worlds, and distant side biomes are outside the crop.

## Separate pipeline stages

| Stage | Implementation | Editable input |
|---|---|---|
| Decode saved material pixels | `tools/noita-save-decode.py` | Read-only `.png_petri` chunks |
| Select the main route | `tools/import-noita-terrain.py` | `tools/noita-terrain-source.json` |
| Map native materials to physical elements | Compiler palette | `tools/noita-terrain-materials.json`, `src/elements.js` |
| Fold the terrain into X/Z | `src/world/scenes/descent/terrainFold.js` | The source configuration's `fold` object |
| Sample the source during play | `terrainScenes.js`, `terrainRaster.js` | Native raster bands and their manifest |

Native palette IDs remain separate from physical element IDs.
Changing the fold or material appearance does not change the native raster.
Changing the source crop changes only the selected source pixels.
The compiler produces deterministic gzip payloads with per-band hashes.

The default fold bends horizontal source coordinates around a 270-degree arc.
Source Y stays vertical. The ribbon has configurable thickness.
The inverse transform selects each voxel's original material pixel.
The fold does not add paths, stairs, platforms, reservoirs, or room connections.

The runtime uses 256-pixel vertical cores with 32-pixel context on each side.
The last core is shorter because the source arena ends there.
All 51 resident bands remain 320 cells tall.
Native portal coordinates connect Holy Mountains without tunnels through their walls.

## Source evidence

The source archive is `worlds/_archive/main-pre-inventory-restore-2026-05-21/world`.
The local backup root appears in `tools/noita-terrain-source.json`.
This is an actual saved world, including prior gameplay changes.
It is not a fresh regeneration from a seed.

The crop contains 63,257,088 selected pixels and 170 native materials.
The manifest records 244 saved chunks and their hashes.
The saved material names come from each chunk's own palette.
Numeric material IDs from another build are not substitutes.

Missing arena pixels use the native, assembled boss arena at its XML-authored world coordinates.
The compiler does not move or arrange its pieces.
This supplies 1,014,272 pixels.
Reserved black in these material files means air only within the documented, tested interpretation.
`black-air-regression.json` records the saved-world comparison that supports this interpretation.
Unknown colors fail compilation.

One ending-edge chunk at `(-1536,12800)` is absent from every inspected archive.
It is outside the fixed arena.
The crop excludes it and omits its portal.
`OUTSIDE` and ribbon caps are explicit conversion boundaries, not native terrain.

## Rebuild

Requirements: Python 3, NumPy, Pillow, and Node.
The browser needs no new dependency.

From the task worktree, run:

```sh
python3 -B tools/import-noita-terrain.py \
  --world /path/to/archived/world \
  --wak /path/to/Noita/data/data.wak
NOITA_DECODER_PATH=tools/noita-save-decode.py python3 -B tools/import-noita-terrain-test.py
node scripts/check-noita-fold.mjs
node scripts/check-noita-materials.mjs
node scripts/check-terrain-source.mjs
node scripts/check-terrain-raster.mjs
node scripts/check-terrain-handoff.mjs
node tools/descent-thumb.mjs
npm run build
node tools/check-local-map-build.mjs
```

The compiler writes `public/local-maps/noita-terrain/` and the small runtime manifest `src/world/scenes/descent/terrainRoute.json`.
The old `import-noita-map.py` command delegates to this compiler.
It no longer constructs geometry.

For a fold change, edit the `fold` object and rebuild.
For a material change, edit the explicit mapping or element definition and rebuild.
Unchanged native bands keep their hashes.
The source archive and installed game files remain read-only.

## Validation and limits

The independent archive check compares all 77,660,160 published saved-source cells, including overlapping context.
Every native material name matches.
The fixed-source check compares all 1,309,440 published fallback cells against the original arena files.
The 50 overlapping band pairs contain identical native bytes.
Fold tests cover inverse round trips, caps, unchanged source data, and conservative empty-column culling.

The initial arrival remains airborne, as in the source.
The compiler does not add a floor beneath it.
Hazardous bottom bands are streaming regions, not independent safe starts.

Physical elements approximate Noita material behavior.
The native bulk rock types have opaque, static physical equivalents.
Saved per-pixel color overrides, rigid-body geometry, entities, background art, and scripts are not reconstructed.
There are no fabricated loot quotas or replacement shops.
Kolmi's arena is present. Kolmi's boss AI is not.

See [the geometry contract](noita-terrain-fold-contract.md) and [the decoder format](noita-save-decoder.md).
