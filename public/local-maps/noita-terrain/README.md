# Assembled native terrain (CPU compiler output)

Rebuild from the read-only source paths in `tools/noita-terrain-source.json`:

```sh
python3 tools/import-noita-terrain.py --decoder tools/noita-save-decode.py
NOITA_DECODER_PATH=tools/noita-save-decode.py python3 tools/import-noita-terrain-test.py
```

Requires numpy and Pillow. The decoder is integrated separately; use `--decoder`
and `NOITA_DECODER_PATH` to point to that file before integration. `--inventory`
decodes and reports without publishing. `--world` / `--wak` override local paths.
No game execution, save writes, GPU use, room assembly, or terrain repairs.

`route.json` is full provenance; `src/world/scenes/descent/terrainRoute.json` is
its runtime subset. Each binpack is deterministic, four-byte-padded gzip of
320×9216 native-name palette IDs, row-major X-fastest. Hashes cover decompressed
bytes. Air is 0; OUTSIDE is 255, not air. Element IDs approximate physical roles;
they do not collapse the distinct native material IDs stored in the raster.

Core bands start at1024 every256 native pixels. Each has32 actual neighboring
rows on both ends where the selected domain exists. The final core ends13888;
remaining rows are OUTSIDE. The top32 rows are actual saved neighboring pixels.
Horizontal/domain caps are runtime boundaries, not claimed native materials.

Saved chunks always take priority. Only missing cells within the exact native
boss arena XML bbox `(1536,12288), width2600,height1600` use original WAK PLZ.
Opaque black becomes air ONLY in this fixed-scene fallback: the regression
fixture compares455,966 black cells to saved material names, finding453,229 air
cells. Other cells include gameplay debris (2,204 bone cells in one piece),
which remain untouched wherever saved material exists. Other unknown fallback
RGBA fails. Rare unresolved callbacks in already-saved pieces are inventoried
in provenance but never interpreted or used to clear geometry.

One ending-wall chunk `(-1536,12800)` is absent in all12 inspected backup/live
world directories and outside that bbox. It is explicitly unconverted OUTSIDE;
its portal is omitted. No air or wall was synthesized there.

Native start is the airborne portal arrival `(-677,1350)`, in noitaTerrain01.
Its body is air; original oil begins47 pixels below and solid support59 below.
No fluids were removed. Portal metadata is source-authored topology, not proof
that saved entities survived or remain liquid-enabled. Two ordinary variants
remain labeled unverified default candidates. All target bodies are collision
free; the Snow arrival retains actual blood droplets.

The bottom two debug spawns are `hazardous-streaming-only`, unsupported native
lava-band positions, not safe starts. Their bodies fit actual resident context.
Continuous streaming enters those bands at the existing source position instead
of using debug spawns. No safe platform or headroom was added.

Source limits: this is a generated, gameplay-modified save, not pristine seed
regeneration. Rigid bodies/opaque physics and saved entities are not rasterized.
Fold changes angle/thickness only: source raster identity remains unchanged.
