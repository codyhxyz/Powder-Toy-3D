# Cruelty Squad source levels: conversion and provenance

Four original levels, converted from the game's own embedded meshes into this
game's 0.3 m voxels and published with the site. No authored geometry is cropped,
scaled down or manually redrawn. Empty horizontal bounds are padded to the
16-cell streaming grid. Characters use destination NPCs; external props and
source scripts are not copied.

| Level | Source size (cells) | Triangles | Runtime targets | Runtime / authored guards | Packed | Why it is here |
|---|---|---:|---:|---:|---:|---|
| Pharmakokinetiks | 448×384×816 | 12,903 | 2 | 21 / 21 | 190 KB | Compact indoor layout |
| Paradise | 1088×488×1184 | 57,888 | 3 | 50 / 51 | 478 KB | Rooftops, streets, outdoor grapple routes |
| Androgen Assault | 688×568×816 | 50,434 | 2 | 47 / 48 | 414 KB | Dense combat routes, two exits |
| Apartment Atrocity | 480×1008×560 | 17,398 | 1 | 31 / 31 | 157 KB | Strong vertical contrast, three exits |

The original converter inflated exact grid-plane surfaces into both adjoining
cells. Source winding now selects only the solid side; boundary-only triangle
edges do not thicken ceilings. This restores standing door clearance and Pinky's
placement without moving actors or shrinking bodies. All four missions are
available. Two obstructed guards are omitted, never moved; their original
positions remain in the manifests. Every runtime actor has solid support and
full ordinary-body clearance.

Feet use only the original X/Z and support within 3 m below the source pivot.
Godot actor roots are pivots, not feet, and the external character scenes
needed to settle that exactly are not available here: this is a voxel
adaptation, not character/collision emulation.

Sin Space Engineering was inspected but not converted. Its distant scenery
needs ~2840×2464×2936 cells and a 40-million-entry brick directory, past the
current storage and streaming budget. It is not replaced by a smaller map.

## Provenance and rights

The input is the original level data, not a reconstruction:

- [CrueltySquadVR-Modloader](https://github.com/teddybear082/CrueltySquadVR-Modloader)
  commit `1ab57e830d5e4a8f5ab6eb800a3e9108faafbcf8`,
  `cs-vr-mod-vr-files/mod.zip`, entries `Levels/Level{1,2,3,4,6}.tscn`
  (Godot 3 text scene, format 2).
- [CruS Mod Base](https://github.com/CruS-Modding-Infrastructure/crus-modbase)
  credits Consumer Softproducts with permission to distribute “the game's
  source code **in these mods** for non-commercial use”.
- [Paradise](https://crueltysquad.fandom.com/wiki/Paradise) and the other
  mission pages were used to confirm objective names and counts.
- `tools/import-cruelty-map.mjs` records each scene's SHA-256 in its manifest.

**That permission covers mods of Cruelty Squad. It is not evidence that these
converted level assets may be republished inside a different game.** This
project publishes them anyway, at the maintainer's direction and risk. If a
rights holder objects, remove the assets and update the build's required asset
list, or revert the publication commit. Runtime registration tolerates missing
assets; CI deliberately requires the currently published catalogue.

## Material policy

No new elements were added. The existing catalog covers every useful physical
role: Ceramic for clear fired-tile surfaces, Limestone for marble, plus Brick,
Rock, Wood, Metal, Glass, Water, Plant and self-glowing Crystal.

Painted flesh and moss patterns stay structural material: a texture does not
establish edible walls or spontaneous growth. Red water is not classified as
blood without a source mechanic. Display textures become glass, not invented
circuitry. Rugs use existing burnable Wood; flexible fibre behaviour is not
reproduced. Original texture pixels, animated shaders and colours are not
copied. Unknown material paths fail conversion. Each manifest records the
exact mapping, per-path usage counts and the mechanical and visual losses.

A future element needs a distinct reusable interaction, not a texture name.
These maps do not currently establish such a missing mechanic.

## Converting a level yourself

```sh
node tools/import-cruelty-map.mjs --map all --source-dir /path/to/Levels
node tools/import-cruelty-map.mjs --map paradise --source Level2.tscn
npm run dev -- --port 53927 --strictPort
```

Output goes to `public/local-maps/<id>.json` and `<id>.binpack`. Sparse bricks
are mostly zero, so gzip takes the largest map from 28 MiB to 478 KB — under
Cloudflare Pages' 25 MiB per-file limit. The writer refuses any other
directory, and `validateImportedMapManifest` refuses an unpacked manifest, so
a raw map cannot be shipped by accident.

The packed file is deliberately not named `.gz`. A host that recognises that
name serves it with `Content-Encoding: gzip`, and the fetch layer then inflates
it before the loader sees it, so the loader would inflate raw bytes and fail.
The loader inflates only a real gzip stream (its magic bytes), so either host
behaviour decodes to the same words; a CPU test serves the file both ways and
compares them.

## How the levels load

- `src/world/import/localMap.js` registers a map from its manifest alone
  (four small requests at boot, in parallel, cached by the host).
- The manifest also carries the median height of the level's border. The far
  field asks for that while the world is built, before any geometry is fetched
  (`world/far.js` beyondLevel); computing it at conversion keeps that answer
  source-derived rather than invented.
- `src/world/scenes/importedMap.js` builds the scene and inflates the packed
  bricks in `prepare()`, which `world/gpu.js` already awaits before `data()`:
  geometry is fetched when a map is opened, not while the menu lists it.
- The GPU generates cells from the same packed bytes the CPU collision twin
  reads, so there is no second, hand-built collision map. Existing streaming,
  destructive materials and the player's probes all use those cells.

## CPU verification

```sh
node --test tools/import-cruelty-map-check.mjs
node --test tools/imported-interactions-check.mjs
node tools/imported-door-passage-check.mjs
node tools/cruelty-enemies-cpu-check.mjs
node tools/ladder-cpu-check.mjs
node tools/check-local-map-build.mjs            # after npm run build
CRUELTY_SOURCE_DIR=/path/to/Levels node --test tools/import-cruelty-map-check.mjs
```

The always-on suite gunzips each published level, validates every brick
pointer and packed element id, and checks that each runtime actor stands on
solid support with full body clearance. The build check does the same against
`dist/` and asserts every file is under the host limit. With the source scenes
present, the suite additionally proves the published manifests match a fresh
conversion, that every decoded world vertex lies inside the authored bounds
uncropped, and that decoded geometry agrees with the original concave
colliders to within 0.002 m.

Paradise's full mission also passed a UI-mode browser check in a 5.76 s total
GPU slot: the normal 128×488×128 window, three targets, 53 actors, pistol
selected, clear player collision and a solid source floor in actual GPU cells.
That earlier browser check predates the interaction/AI changes. Current source
door passage tests use the real standing body and all four published maps.
See [interaction audit](cruelty-interaction-audit.md) and
[enemy evidence](cruelty-squad-enemies.md) for supported behavior and remaining gaps.
