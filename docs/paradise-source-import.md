# Paradise: real source import (local-only)

**Status:** CPU-checked conversion of the actual embedded Paradise geometry in
`Levels/Level2.tscn`, not a screenshot reconstruction. Source/game-derived output
is **not committed, redistributed, or included in production**. External props,
source scripts and their gameplay are not imported. No browser/GPU test was run.

## Provenance and research

- [Paradise reference](https://crueltysquad.fandom.com/wiki/Paradise): direct
  retrieval returned HTTP 403; Context.dev retrieved the article. Viewed its
  [Level2 image](https://static.wikia.nocookie.net/crueltysquad/images/0/0f/Level2.png/revision/latest?cb=20211031112600)
  and [Compound screenshot](https://static.wikia.nocookie.net/crueltysquad/images/f/fd/Compound.png/revision/latest?cb=20221215150851).
  Images were reference only, not used to fabricate geometry or checked in.
- Actual source: [teddybear082/CrueltySquadVR-Modloader](https://github.com/teddybear082/CrueltySquadVR-Modloader)
  commit `1ab57e830d5e4a8f5ab6eb800a3e9108faafbcf8`,
  `cs-vr-mod-vr-files/mod.zip`, entry `Levels/Level2.tscn` (Godot 3 format 2).
  Archive SHA-256: `f2b522ad5ae43c6a8d555e3fb60556282bb3b3fae5cfb796f8acb128f23de12b`.
  Scene SHA-256: `4f55b5e60a6995ec2fd6c73a5181824591fc519705ea23e4d3d062b8c7bc4c4e`.
  This establishes the exact input provenance; it is not a byte-for-byte
  comparison with a currently installed commercial game build.
- [CruS Mod Base](https://github.com/CruS-Modding-Infrastructure/crus-modbase)
  README credits Consumer Softproducts with express permission to distribute
  “the game's source code **in these mods** for non-commercial use”. That is
  **not evidence that this project may redistribute the level/visual assets**.
  Its public tree was inspected; it did not supply Paradise.
- [crus.cc](https://crus.cc/maps/newest/) distributes custom levels, not an
  established openly licensed Paradise source release. A third-party H3VR
  Paradise port appeared in search; it was not used as a source or license.
- [Mapping guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2628055129)
  describes TrenchBroom `.map` -> Qodot -> Godot `.tscn`, and using Godot RE
  Tools on an owned `crueltysquad.pck`. The Level2 source retains a reference
  to the author's `Maps/Level2.map`, but that `.map` is not needed: the built
  mesh triangles are embedded in the `.tscn`.

An owned `crueltysquad.pck` restored to a Godot 3 project is the appropriate
missing input for external `Player.tscn`, `Entities/Enemies/Obj_Nerd_*.tscn`,
furniture/tree/prop meshes and original scripts. Public VR source supplies
`Player_Test.tscn` but not its inherited complete base player scene. The scoped
local Steam lookup found no default-library Cruelty Squad install. Do not use
pirate game archives. Obtain explicit applicable permission before shipping
any original or converted game geometry.

## Run privately

From the repo root, supply your actual source scene:

```sh
node tools/import-paradise.mjs --source /path/to/Levels/Level2.tscn
npm run dev -- --port 53927 --strictPort
```

Default output is `.tmp-cruelty-import/paradise.json` and `paradise.bin` (ignored
by the existing `.tmp-*` rule). The Vite **dev-only** middleware serves exactly
those two filenames at `/local-maps/`; unknown paths, traversal, other methods
and symlinks outside the directory are rejected. Production builds never serve
or copy these files. The CLI rejects `--out` under `public/`.

The dev entry registers `paradise` / scene `paradiseLocal` **only after a valid
manifest and binary load**. Missing/corrupt input produces no Paradise listing
and no stand-in geometry. It exposes `map.mission` for the separately implemented
`crueltySquad` mode; Sandbox can also select the actual imported map.

Open `http://localhost:53927/?map=paradise&win=64,64` for a private preview.
The smaller **streamed window**, not a smaller/scaled map, avoids allocating a
128x488x128 window on low-binding-limit devices. Stop your own server when done.
No launch or visual verification of this URL was performed in this task.

## Conversion contract

- `godot3.js` reads resource sections as data, resolves embedded ArrayMeshes,
  follows hierarchical column-major Godot transforms, and decodes the exact
  interleaved formats found in the source: `97559` (24-byte indexed vertices)
  and `97495` (36-byte skinned, non-indexed vertices). Unsupported layouts fail
  closed rather than reinterpret bytes. Layout is based on Godot 3.5
  `VisualServer::mesh_surface_make_offsets_from_format`; no game code executes.
- `paradise.js` maps **exact resource paths** to this game's elements. Unknown
  materials fail. Rock/tile, brick, wood, metal, glass, turf, water, flesh and
  lights get explicit mappings. No original texture pixels are copied.
- Source triangles are already in Godot meters after Qodot's authored
  `inverse_scale_factor=16`. Do **not** apply that scale again. Godot and the
  destination use Y-up; axes are unchanged. One source meter is
  `1 / CELL_M = 1 / 0.3` cells. Integer bounds translation moves negative source
  coordinates into the positive world, without rotation, crop or rescale.
  Both origin and meter scale are retained in the manifest.
- `voxelize.js` conservatively intersects triangle surfaces with cell cubes.
  Thin walls remain represented. Enclosed interiors are not invented or filled.
  Overlaps follow deterministic source node/surface/index order. Sparse 8-cell
  bricks store packed-u8 element ids with a dense brick-pointer directory.
- `importedMap.js` exposes a CPU cell twin and a direct SD-backed WGSL
  `sceneCell`. Streaming, far-field generation, existing voxel player collision
  and destructive material simulation use the **same imported cells**. There
  is no alternate hand-built collision map. Trigger Areas are excluded from
  solid matter (Water Areas excepted).
- The real converted scene is **1088x488x1184**, not the default1024x128x1024.
  Existing `scene.size`/`farLayout` machinery accepts these whole-brick bounds.
  Default128x488x128 streaming needs a~244MiB A binding;64x488x64 needs~61MiB.
  Runtime GPU pipeline/device behavior remains unverified.

## Authored mission nodes

Normal Paradise has three G-TECH executive targets. Hope Eradicated's fourth
target is not part of this contract. These values come from source nodes:

| Role | Source path | Source origin (meters) |
|---|---|---|
| Spawn | `QodotMap/entity_9_Player` | `(53, 1.5, 1.5)` |
| Target1 | `Nerd_1` | `(-20.4825, 9.00043, 151.838)` |
| Target2 | `Nerd_2` | `(26.2109, -2.04942, 148.798)` |
| Target3 | `Nerd_3` | `(-13.273, 7.00043, 188.281)` |
| Extraction | `QodotMap/entity_225_Exit` | `(52, 9.5, -9.5)` |

The manifest retains exact actor `sourceAt`/`sourcePath`. X/Z translations are
exact. Feet are the nearest occupied voxel support within3m **below each source
pivot**, not the topmost roof of a column; this keeps basement/upper-storey
actors on their authored floors. A missing support fails conversion. Source
pivot-to-feet semantics cannot be fully established without the external actor
scenes, and numerical voxel support is not a clearance/gameplay test.

There are47 instantiated standard `E_Grunt`, `E_Elite`, `E_Security` guard roots
in the manifest. They translate to existing gunners with `GUN`; this does not
claim that our NPCs reproduce original AI/weapons. Other creature/civilian
PackedScenes are listed as unresolved, not silently recreated.

Extraction derives from the actual convex trigger points: an18m-wide,
19m-high,1m-deep region. Its exact cell-space `bounds` must be preferred over
`radius` by the mission controller. `at/radius/height` is an inscribed-cylinder
fallback for the original manifest API, not a substitute for the full bounds.
Doors/elevators stay at authored transforms; source animation/scripts, ladders,
lighting, music, sky and external props are not reproduced by this importer.

## Checked evidence

The exact scene conversion completed in39.04s CPU-only:

- 57,888 non-trigger triangles rasterized.
- 7,633,563 occupied cells /49,207 sparse bricks /30,105,216 binary bytes.
- Three targets and47 guards; all50 actor positions have imported voxel support.
- Original resource inventory includes487 convex,1 concave and1 box collider;
  runtime collision is the imported surface voxels, not those original shapes.
- Nine CPU checks pass with the actual-source optional check enabled:

```sh
PARADISE_SOURCE=/path/to/Levels/Level2.tscn node --test tools/import-paradise-check.mjs
npm run check:imports
npm run build
```

Fixture tests cover binary formats, hierarchy, invalid formats/materials,
negative coordinates, conservative SAT rasterization versus exhaustive search,
sparse packing/overlap order, scene data validation/WGSL reflection, authored
mission support below roofs, and dev-route safety. Production output was checked
to contain neither the local data nor the dev loader/imported format signature.
The actual-source check also compares every decoded world triangle coordinate
against the authored concave collider:461,988 scalar coordinates match within
0.001m (textual serialization rounding; measured maximum0.000546m).
Vite's actual dev HTTP route returned the3-target/47-guard manifest and correct
binary length; its transformed main entry also passed an HTTP check. The server
was closed immediately afterward. Build warnings were existing third-party
browser externalizations/chunk sizes. No browser, GPU, deployment or push was
performed.
