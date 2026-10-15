# Assembled saved terrain decoder

`tools/noita-save-decode.py` reads actual generated/persisted `world_<x>_<y>.png_petri`
chunks. It never opens room assets, invents connectors, resamples geography, launches
the game, or writes to a save. This is separate from the older room-template importer.
CPU dependencies: Python 3, numpy; Pillow only for `--preview`.

## Observed version-24 format

All offsets below refer to the decompressed buffer unless stated otherwise.

1. Outer file: little-endian uint32 compressed length, uint32 decoded length,
   exactly that many compressed bytes. Payload is **FastLZ level 2**. The decoder
   validates sizes, references (including overlap/far distances), truncation, and
   a 64 MiB per-chunk decoded limit. Other compression levels fail explicitly.
2. Big-endian uint32 triple `(24,512,512)`. Only this exact header is supported;
   the semantic meaning of `24` is not independently established.
3. At offset 12: **262,144 one-byte cells**, row-major `[y,x]`, x fastest.
   The low seven bits index the chunk-local saved material-name palette. The high
   bit marks a cell with a following saved four-byte color entry. This is not RLE.
4. At offset 262156: big-endian uint32 palette count, followed by that many
   `(uint32BE byte length, ASCII material name)` entries. These names are present
   IN THE SAVE, not inferred from WAK XML order, Wang colors, screenshot colors,
   or material physics. IDs differ between chunks. Global engine runtime IDs
   remain unknown and are unnecessary to resolve these saved terrain cells.
5. Big-endian uint32 color count, then count four-byte records. Across all 119
   central chunks this count equals the number of high-bit cells exactly. Records
   are retained as `color_bytes` without interpreting byte order/channel semantics
   or relying on their association/order for material identity.
6. Remaining data are retained byte-for-byte as `opaque_tail`. They contain other
   saved state, apparently including physics bodies. Their structure is NOT
   decoded. In particular, movable rigid-body geometry is **not rasterized** into
   the terrain prefix. An empty-looking cell can have a separate body over it.

Evidence for row-major orientation: recognizable upright terrain in actual preview,
plus source-coordinate seam checks over the complete central export. Across adjacent
valid chunk edges, matching native-name fractions were 0.659 vertical / 0.927 horizontal;
transposing each chunk gave only 0.284 / 0.405. Seams need not match perfectly (terrain
changes and prior player actions); the decoder does not repair or smooth them.

## Usage and output contract

Use the stable backup archive, not the active save symlink. Example:

```sh
WORLD="$HOME/Library/Application Support/Noita-backups/before-mina4mac-20261014-231758/Nolla_Games_Noita/worlds/_archive/main-pre-inventory-restore-2026-05-21/world"
python3 tools/noita-save-decode.py --world "$WORLD" \
  --output /tmp/noita-save-central-NEW --bounds -1024 1536 1024 13312
python3 tools/noita-save-decode.py --world "$WORLD" \
  --output /tmp/noita-save-preview-NEW --bounds 0 2048 0 2048 --preview
NOITA_SAVED_WORLD="$WORLD" python3 -m unittest discover -s tools -p 'test_noita_save_decode.py' -v
```

Bounds are **inclusive chunk origins**, multiples of 512, not pixel endpoints.
Maximum rectangle: 512 chunks (split larger requests). The output directory must
not exist; existing artifacts/symlinks are not overwritten. Output inside the
source save is forbidden. Sources are opened read-only, twice, and their hashes
and decoded metadata must remain identical between passes.

- `region.npz`: `material_id` uint16 `[y,x]`; IDs index `material_names` (sorted
  native names across the selected chunks, including unused palette entries).
  **65535 means missing source, never air.** `missing_chunks` is a bool grid
  `[chunk_y,chunk_x]`, true for absent chunks. `origin` is world pixel `[x,y]`,
  `chunk_size` is 512, `missing_id` is 65535. World y increases downward.
- `chunks/world_X_Y.npz`: exact `cell_bytes`, unflagged `material_index`, local
  `material_names`, original `color_bytes`, `opaque_tail`, and `[x,y]` origin.
  All NPZ fields load with `allow_pickle=False`.
- `manifest.json`: resolved source root, exact compressed source SHA-256 and
  decoded SHA-256 per chunk, source lengths, prefix offsets, native palettes,
  exact material histograms, missing origins, and limitations. Same source,
  rectangle, and output-independent settings produce the same data/metadata.
- Optional `preview.png`: diagnostic SHA-256-name colors, **not native colors or
  a material classification**. Air black; missing magenta. No geometry changes.

## Checked archive evidence

Exported `/tmp/noita-save-verified-central` from the example backup: 119 chunks,
31,195,136 known pixels and 262,144 missing pixels; only missing origin
`(-1024,13312)`. Raster shape `[12288,2560]`, world pixel extent
`x=[-1024,1536), y=[1536,13824)`. Combined palette: 179 names (some unused).
All 119 individual native-name histograms match the assembled raster exactly.
Full per-material counts and exact hashes are in that export's manifest.

Actual small preview: `/tmp/noita-save-verified-preview/preview.png`.
`world_0_2048.png_petri`:

- Source size 120886 = wrapper 8 + compressed 120878; decoded 1295561.
- Source SHA-256 `2371c4c8c8faa4659ec2f28bdf9ee3b47938721fffdc487b1353a2ed00a42dc3`.
- Decoded SHA-256 `0e9747215086a50a7b8949935acabd7776b27c723bb71700f1b4163cd3449543`.
- 32 local palette entries; 49803 high-bit/color entries; opaque tail 833711 bytes.
- 262144 terrain cells total: air 174940, coal_static 42404,
  rock_static_grey 28413, templebrick_static 5613, coal 3537,
  wood_static 2122, ice_static 992, wood_static_vertical 941,
  radioactive_liquid 810, water 748, gold 672, moss 348, smoke 271,
  water_ice 127, rotten_meat 89, steam 35, glowstone 24,
  ice_radioactive_static 22, slime 9, blood 7, ice_blood_static 6,
  soil 5, ceiling_plant_material 3, plant_material_red 2,
  ice_slime_static 2, grass 1, oil 1.

The optional archive tests also check an air-heavy chunk (262136 air / 8 smoke),
actual solid/fluid counts, source hashes, and an actual adjacent seam. Synthetic
tests cover malformed/truncated input, bounds, FastLZ literals/overlap/extension/far
references, local-palette remapping, flags, missingness, and source coordinates.

## Limits

This is a historical, gameplay-modified generated save, not a pristine seed export.
Unexplored/missing chunks remain unknown. No other seed supplies gaps. Trailing
body/state records remain opaque; no claim of full saved-scene reconstruction is
made. Saved terrain names are exact, but any downstream reduction to another game's
material vocabulary or 3D folding is a separate, potentially lossy operation.

## Follow-up: exact native fixed boss-arena PixelScene source

The WAK's `data/biome_impl/spliced/boss_arena.xml` explicitly places 24 material
PLZ images at game-authored world coordinates. Their rectangles tile
`[1536,4136) x [12288,13888)` exactly, without overlap or uncovered pixels.
In particular, `16.plz` is at `(3584,12288)` and `17.plz` at `(3584,12800)`.
This is the whole fixed native scene, NOT a choice of templates/connectors.
It is a different provenance from saved gameplay terrain and is not automatically
merged into, substituted for, or claimed identical to the saved archive.

PLZ is NOT the saved-name stream: it has six **little-endian** uint32s
`(1,width,height,4,compressed_length,decoded_length)`, then FastLZ-compressed raw
four-channel pixels. Material PLZs use levels 1 and 2; all 24 decode with exact
`width*height*4` length. Some images are 40 pixels wide or 64 high at scene edges.
`decode_plz(bytes) -> (pixels[y,x,4], metadata)` handles both levels, validates the
wrapper, and preserves exact pixel bytes. Existing saved-terrain `unwrap` still
accepts only level 2; saved-terrain behavior is unchanged.

`material_raster_from_plz(plz_bytes, materials_xml_bytes)` returns
`(uint16_indices[y,x], sorted_native_names, rgba[y,x,4], metadata)`.
For THESE material PixelScene images, unique RGB `wang_color` entries in native
`data/materials.xml` resolve actual named materials. This is not an engine-ID
mapping. Unknown/ambiguous colors remain **65535**, never assumed air. Metadata
includes source/decoded/XML hashes, header, level, unresolved RGB/count/candidates,
and nonopaque pixel count. PLZ has no saved-terrain color-record or physics tail;
there are exactly the declared compressed image bytes. Separately referenced
visual/background assets and scene callbacks/entities are not rasterized.

Checked artifacts (read-only files):
`/tmp/noita-native-fixed-arena-verified-v2/{arena.npz,16.npz,17.npz,manifest.json}`.
All 24 individual NPZs plus the combined NPZ have SHA-256 entries in the manifest.
The combined `arena.npz` stores `origin=[1536,12288]`, shape `[1600,2600]`, exact
RGBA, native-name indices, a full-coverage mask, and an unresolved-color mask.
A CPU reproduction probe is `/tmp/noita_fixed_arena_probe_v2.py` (run from this
checkout with a NEW output directory); it uses the existing WAK reader and the
new decoder API, XML positions only. No source/save files were changed.

Provenance:
- WAK SHA-256: `c95a0c01a55ec29267afef6bbec8a0cae0ba2b350638e2203674ed4dfb9227c3`.
- Scene XML SHA-256: `2cae47277c748fb1c7f083906f25a7b8c8eb904772039a422db2bf2e16fcb748`.
- Materials XML SHA-256: `122df34514edaf312e1a15a619b3d6a44d49ce605c929d5950c9051a57429d04`.
- `16.plz` SHA-256: `69957e76ac637d9c0014bf41c00e43150182507797c122e3e80d526ffed34e32`;
  header `(1,512,512,4,9874,1048576)`; rock_hard 191816, lava 70316,
  unresolved opaque black 12.
- `17.plz` SHA-256: `f80d3e8a2078943aae564f6088a03e7065f01711f0ab966f3c530cffec519e58`;
  header `(1,512,512,4,13599,1048576)`; rock_hard 74325, lava 13881,
  templebrick_thick_static_noedge 22362, rock_static_noedge 856,
  unresolved opaque black 150720.

Across all 4,160,000 scene pixels, 3,547,474 have unique native material names;
612,526 remain unresolved. All material PLZ pixels are opaque. Black `000000`
is absent from the material palette (`air` instead has Wang RGB `000042`).
Black likely means empty/cleared scene space: an overlapping saved 13.plz chunk
has 175653 air / 3 smoke at 175656 black locations, and 14.plz has 6656 air at
all 6656 black locations. `clean_area_before="1"` strengthens this hypothesis,
but engine loader semantics were NOT independently verified, so black remains
unresolved rather than silently turned into air. Native source pixels are exact;
a fully resolved native-material arena raster is not yet claimed.

Validation: nine tests pass including both real archive tests and new PLZ
level-1/2 literals, exact RGBA, unique/ambiguous/native palette mapping, unknown
black preservation, and corrupt PLZ rejection. All 25 generated NPZ hashes were
independently rechecked against the manifest.
