# Cruelty Squad: local source comparisons

These are actual embedded level meshes, not screenshot reconstructions.
No geometry is cropped, scaled down, or manually redrawn. Characters use
destination NPCs; external props and source scripts are not reproduced.

| Level | Full cells | Triangles | Runtime targets | Runtime / authored guards | Use |
|---|---|---:|---:|---:|---|
| Pharmakokinetiks | 440×384×816 | 12,903 | Mission unavailable | 21 / 21 | Compact indoor layout; Sandbox only |
| Paradise | 1088×488×1184 | 57,888 | 3 | 50 / 51 | Rooftops, streets, outdoor grapple routes |
| Androgen Assault | 680×568×808 | 50,434 | 2 | 46 / 48 | Dense combat routes and two exits |
| Apartment Atrocity | 472×1008×560 | 17,398 | 1 | 27 / 31 | Strong vertical contrast and three exits |

Pharmakokinetiks preserves both authored targets in its inventory. Pinky's
source position has no clear standing volume for our ordinary body. Its
mission is therefore disabled, not replaced with a guessed target position.
Seven obstructed guards across the other maps are explicitly omitted from
runtime spawning. Their original positions remain in the manifests.

All runtime actors have solid support and full ordinary-body clearance.
Feet use only the original X/Z and support within 3 m below the source pivot.
This is a voxel adaptation, not exact Godot character/collision emulation.
Missing character scenes are needed to establish precise pivot semantics.

Sin Space Engineering was inspected but not converted or registered. Its
enormous distant scenery exceeds the current dense-directory and full-height
streaming limits. No replacement geometry or smaller map is advertised.

## Material policy

No new elements were added. The existing catalog covers the useful physical
roles: Ceramic for clear fired-tile surfaces, Limestone for marble, Brick,
Rock, Wood, Metal, Glass, Water, Plant and self-glowing Crystal.

Painted flesh and moss patterns remain structural material. They do not
justify edible walls or spontaneous growth. Red water is not classified as
blood without evidence. Display textures become glass, not invented circuits.
Rugs use existing burnable Wood; flexible fiber behavior is not reproduced.
Original texture pixels, animated shaders and colors are not copied.
Unknown material paths fail conversion. Each manifest records the exact
mapping, usage counts and mechanical/visual losses.

A future element needs a distinct reusable interaction, not a texture name.
These maps do not currently establish such a missing mechanic.

## Private preview

Original asset redistribution permission is not established. Source and
converted data stay outside `public/`, uncommitted and absent from production.
See [source provenance](paradise-source-import.md).

```sh
node tools/import-cruelty-map.mjs --map all --source-dir /path/to/Levels
npm run dev -- --port 53927 --strictPort
```

Choose a local voxel preview in the menu. Paradise, Androgen Assault and
Apartment Atrocity also offer the target-elimination mode. Smaller adapters
may reject their full-height windows; an explicit `?win=64,64` changes only
the streamed window, not the source map. Stop your server when done.

The dev server serves only the four known JSON/bin pairs. Sin and arbitrary
paths are rejected. Builds contain neither generated maps nor the dev loader.

## CPU verification

```sh
CRUELTY_SOURCE_DIR=/path/to/Levels \
CRUELTY_OUTPUT_DIR=.tmp-cruelty-import \
node --test tools/import-cruelty-map-check.mjs tools/import-paradise-check.mjs
```

Checks compare decoded world vertices to the original concave colliders,
verify source hashes and uncropped bounds, and check every runtime actor's
clearance. Exits retain original convex vertices and SAT axes. Apartment's
arched exits are not approximated as rectangular completion volumes.
Hidden and visible actor art is excluded from terrain; hidden static world
geometry is retained. All original actor roots remain in the inventory.

Full-map GPU validation remains separate from these CPU checks.
