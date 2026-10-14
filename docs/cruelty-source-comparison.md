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

The published geometry and appearance now come from the authorized recovered
original game through `--source-root`. Earlier geometry-only imports used the
mod source below. The pipeline does not mix those two source sets:

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
copied by the legacy geometry-only conversion. With `--source-root`, native
original appearance is retained separately; it never changes physical element
assignments. Unknown material paths fail conversion. Each manifest records the
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

## Reproducible original appearance conversion (conversion only)

The source root must be the complete recovered original game, not the old
`/tmp/cruelty-vr-unpacked` mod folder. `--source-root` selects canonical
`Levels/Level{1,2,4,6}.tscn` using the existing profiles and verifies each
adjacent original `.json` name: Pharmakokinetiks, Paradise, Androgen Assault,
Apartment Atrocity. Sin Space Engineering remains explicitly budget-blocked.
No per-map texture assignments exist: scene material references lead through
SpatialMaterial/ShaderMaterial/AnimatedTexture to the original PNG resources.

```sh
export GDRE_BIN='/tmp/gdre-cruelty/Godot RE Tools.app/Contents/MacOS/Godot RE Tools'
node tools/import-cruelty-map.mjs --map all \
  --source-root /Users/codyhergenroeder/Library/Caches/tpt-cruelty-source/recovered
# Equivalent: --gdre "$GDRE_BIN". Output remains public/local-maps/<id>.*.
```

This command regenerates all four published maps and their appearance assets.
Without `--source-root`, the existing `--source`/`--source-dir` fixture and
geometry-only behaviour is unchanged. The shared parser now also understands
standalone `[gd_resource]` roots and multiline node-group headers.

ImageMagick (`magick`, or version 6's `convert`/`identify`) supplies native-size RGBA8 PNG expansion:
no resize, atlas, palette replacement or resampling. Source import flags are
retained (repeat/filter/mipmaps/sRGB and the complete property inventory).
Original PNG alpha-border import fixup, GPU compression and generated mipmaps
are not baked into these original pixels. Pixel-changing size-limit,
premultiplied-alpha and inverted-colour import requests fail explicitly.
Identical decoded pixel sequences/dimensions share storage, while material
identity, albedo resource identity and physical material path remain distinct.
Animation frames are contiguous at equal native dimensions with source FPS;
nonuniform delays, paused/one-shot/nested animations and unequal sizes fail.

Recovered `Imported_Mesh/Snirby.material` is still a Godot `RSCC` binary. The
Node adapter recognizes `RSRC`/`RSCC` and invokes configured GDRE's generic
`--headless --bin-to-txt=FILE --output=TEMP` export, then uses the same text
resource parser and removes its temporary directory in `finally`. It does not
hand-decode binary resources, infer a texture by filename or modify the source
root. Missing GDRE is an actionable error. Provenance hashes the **original
binary**, not merely its exported text.

### Appearance v1 ABI

`src/world/import/appearanceFormat.js` is the browser-safe authoritative
contract. The writer emits gzip `<id>.appearance.binpack`, plus
`manifest.appearance` (`version`, `wordCount`/`totalWords`, `dataFile`,
`dataCompression`, uncompressed/packed SHA-256 and byte counts, materials,
texture pointers, source identities/hashes, lights/environment and losses).
All pointers are absolute **u32 word offsets**, floats are f32 bitcasts, byte
serialization is little-endian, and all spare words are zero.

- Header: 64 words; 0 version, 1 totalWords, 2–4 brickDims, 5 directoryAt,
  6 trianglesAt, 7 materialsAt, 8 materialCount, 9 triangleCount, 10 lightsAt,
  11 lightCount, 12 environmentAt, 13 maxBrickTriangles; 14–63 reserved.
- Directory: same X-fastest brick count/order as physics, 0 for empty or a
  pointer to `[count, zeroBasedTriangleIndex, ...]`. `voxelizeMeshes` calls an
  optional triangle hook once and its returned hit hook only after the same
  occupied-cell SAT acceptance used by physics. There is **one geometry walk**,
  no independent appearance voxelizer. Overlaps list all accepted triangles;
  physical overlap precedence remains unchanged.
- Triangle: 24 words, six vec4s: `p0.xyz/materialIndex`, UV-U affine
  gradient/bias, UV-V affine gradient/bias, unit normal/`dot(normal,p0)`,
  barycentric-u affine gradient/bias, barycentric-v affine gradient/bias.
  Positions are origin-adjusted world cells. Material UV scale/offset is baked
  into the UV affine functions. Barycentric inside is `u>=0,v>=0,u+v<=1`.
- Both supported mesh formats 97559 (24-byte stride) and skinned 97495
  (36-byte stride) store half-float UV at byte **20**. Godot 3.5
  `VisualServer::mesh_surface_make_offsets_from_format` and `ArrayType` put
  TEX_UV before BONES/WEIGHTS; skin bytes follow UV, not precede it.
  Positions/index arrays remain unchanged. Other layouts fail rather than guess.
- Material: 32 words: 0 textureAt, 1 width, 2 height, 3 flags; 4–7 albedo RGBA;
  8–10 emission RGB, 11 energy; 12 roughness, 13 metallic, 14 specular,
  15 expected physical element; 16 frameCount, 17 FPS, 18 frameStride,
  19 shader mode; 20 snapRes, 21 paletteswap; 22–25 roughness texture
  offset/width/height/channel, 26–29 metallic texture offset/width/height/channel;
  30–31 reserved. Texture channels are Godot 0R/1G/2B/3A/4grayscale. Null
  textureAt=0 means genuinely untextured, never a substituted picture.
  RGBA8 stores R in the least significant byte. Frame strides are pixel words.
- Flags: transparent=1, unshaded=2, repeat=4, filter=8, mipmaps=16,
  doubleSided=32, alphaScissor=64, vertexColor=128, sRGB=256, animated=512;
  Godot blend/diffuse/specular enums occupy shifts16/20/24. Reserved flags
  alphaScissor/vertexColor are not emitted by the supported resources.
- Lights: 16 words: position.xyz/type (0 omni,1 directional,2 spot),
  color.rgb/energy, direction.xyz/range, attenuation/angle/spotAttenuation/
  shadowFlag. Positions/ranges are cells; directions are normalized world
  negative-Z. Source script identities/hashes and node overrides are recorded,
  not executed; actor visual helpers are excluded from terrain.
- Environment: 32 words: ambient RGB/energy, fog RGB/enabled,
  fog begin/end in cells, curve/transmit flag, panorama offset/width/height/
  background mode, 9-word orientation Basis, rotation speed/axis (0Y,1X),
  ambient sky contribution, background energy, fog transmit curve, fog sun
  amount, fog depth enabled. Rotation defaults are read as source exported
  properties, not invented or obtained by running scripts. Full source props
  retain effects outside this fixed record (SSR, conditionals, draw distance).

### Shader modes and explicit gaps

Shader code is matched by audited **code SHA-256**, not a per-map filename
assignment. Modes are exported in `APPEARANCE_MODES`; unknown code or material
forms/properties fail with identity/hash and require review, never fake art.
The conversion records each mode and its source parameters:

| Mode | Source behaviour to port |
|---|---|
| 0 spatial | SpatialMaterial albedo, material flags, roughness/metal/specular and native texture maps |
| 1 unshaded | Original bare unshaded shader, genuinely no albedo texture |
| 2 water | UV multiplied by `(1+.01*cos(V*10+time),1+.02*sin(U*10+time))`; alpha `(R+G)*2` |
| 3 flesh | UV pulse: `clamp(1+.0005*cos/sin(UV*10+tan(time*5)),1,1.5)` |
| 4 swampWater | UV multiply `(1+.0025*cos(10+time*.5),1+.005*sin(10+time*.5))` |
| 5 scroll | Samples `2*UV+(0,-time*.2)` |
| 6 realPSX | Source view-space vertex snapping at snapRes; ambient-light-disabled, double-sided |
| 7 realPSXWobble | Snap resolution `snapRes+sin(time)*10`, optional palette swap `(R,2B,.5G)` |
| 8 psx | Original time/position-dependent vertex wobble, unshaded alpha texture |

Source scripts that change illumination, fog, sky, or geometry at runtime are
recorded, not emulated here. External PackedScene prop/actor geometry is not
expanded. Procedural skies, non-PNG texture resources, unknown shaders and
unsupported material properties fail explicitly. The runtime consumes modes
0–5, which cover the four published levels. Modes 6–8 retain their source
parameters but do not reproduce original vertex snapping or actor wobble.

**Known original data loss:** recovered Level4 ArrayMesh46 `surfaces/29`
(`Elevator1.png`) contains raw half `0x7c00` (+Infinity) at UV byte20, including
vertex0. Exactly **240 triangles** have undefined UVs (480 nonfinite source
components). Those triangles remain fully present in physics but are omitted
from the appearance acceleration only, using explicit physical-substrate
fallback. `appearance.losses` records node/surface/material, count, reason
`source-nonfinite-uv` and exact vertex/component/byte-offset/half-bit evidence.
No UV is clamped, replaced or fabricated. The other three maps have no such
omissions.

Published recovered-source appearance:

| Map | Appearance triangles | Materials | Lights | Max triangles/brick | Gzip ~MB |
|---|---:|---:|---:|---:|---:|
| Pharmakokinetiks | 12,903 | 71 | 1 | 157 | 1.78 |
| Paradise | 57,888 | 75 | 2 | 643 | 2.76 |
| Androgen Assault | 50,194 | 61 | 1 | 259 | 2.05 |
| Apartment Atrocity | 17,398 | 68 | 1 | 375 | 1.53 |

Exact compressed sizes can vary with compression-tool versions; source and
uncompressed payload hashes establish identity. Fixtures verify deterministic
word packing, gzip round trips, native RGBA texels, deduplication, animation,
UV affine mapping, brick visibility, explicit undefined-UV losses, unsupported
resources, source lighting/environment and the binary-text adapter.

```sh
node --test tools/appearance-conversion-check.mjs tools/import-cruelty-map-check.mjs
CRUELTY_SOURCE_ROOT=/path/to/recovered GDRE_BIN=/path/to/gdre \
  node --test tools/appearance-conversion-check.mjs
```

The optional four-map source tests run entirely on CPU and write no assets.
They verify canonical names, appearance pointers/indices, original-source
hash inventory, explicit Level4 omissions, and byte-for-byte equality of the
appearance-enabled geometry and missions against a legacy physics-only
conversion of the **same recovered scenes**.

### Runtime appearance

Only Cruelty Squad's material views enable original appearance. Data views,
thumbnails of data views, and other gamemodes retain their existing treatment.
Mode changes clear temporal history. Saved graphics settings remain unchanged.

The near volume and far detail meshes use one shared source-triangle lookup.
It projects the physical hit onto a nearby original triangle with a compatible
normal and matching physical element. The triangle supplies the original UV.
New cut faces without a matching original surface use the physical substrate.
No original mesh overlay hides holes or replaces voxel destruction.

The existing far-grid texture stores read-only appearance words in extra Y
planes. This adds no sampled textures or storage buffers. Terrain kernels keep
their original bounds. Runtime validation checks pointers, pixel ranges, hashes,
and fixed work limits before upload: 1,024 triangles per brick and 16 lights.

Sampling respects original repeat, filtering, sRGB, animation FPS, and native
pixel dimensions. The renderer ports the original flesh, water, swamp-water,
and scrolling UV expressions. Original materials supply ambient light, fog,
panorama, roughness, metal, specular, and blend modes. Subtractive green glass
removes green from the room instead of becoming an opaque green window.

The post pass ports `PaletteLimiter.shader`: 16/255 colour steps, signed 0.002
noise, and gamma 1. It bypasses cinematic exposure, bloom, sharpening, adaptation,
night vision, and AgX without changing saved settings.

This is not pixel-identical Godot emulation. Voxel geometry, transparent layer
ordering, specular integration, fog transmission, SSR, and dynamic source
scripts remain differences. The four source levels contain no shadow-enabled
lights. A future payload with such lights fails explicitly until supported.

```sh
node --test tools/check-source-appearance.mjs tools/check-cruelty-post.mjs
node tools/check-sampler-budget.mjs
node tools/source-appearance-gpu-check.mjs
node tools/cruelty-appearance-browser-check.mjs
```

The numerical production-WGSL test passed on the Apple GPU in a 3.206-second
total slot. It checked native pixels, projected UVs, cut/deletion fallbacks,
subtractive blending, and the mode gate. This does not establish full-app
visual parity. Earlier full-app cold boots exceeded the old ten-second limit;
subsequent checks stopped on watchdog process-query timeouts or player activity.
The shared cap is now 25 seconds, with player protection and ownership checks intact.

**Startup hotfix:** the original-art renderer is temporarily disabled at compile
time. Its per-hit triangle and texture searches were included in every material
pipeline, even outside Cruelty Squad mode. A runtime switch did not remove that
native compilation workload. Production uses ordinary element materials and
does not fetch or allocate appearance payloads. Source assets and numerical
fixtures remain available. Geometry, interactions, missions and enemy profiles
are unchanged. Re-enable only after bounded cold full-app and gameplay checks;
the standalone numerical fixture does not establish startup safety.
The built-site hotfix check cold-booted Paradise in material view, rendered,
refreshed into the active mission again, switched to Sandbox and closed the
browser within a **14.559-second total slot**. All 46 CPU deployment commands
passed; production near/far WGSL also passed CPU Naga validation.

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
