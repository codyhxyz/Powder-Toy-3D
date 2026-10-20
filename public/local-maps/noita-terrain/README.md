# Assembled native terrain (CPU compiler output)

Rebuild from the read-only source paths in `tools/noita-terrain-source.json`:

```sh
python3 tools/import-noita-terrain.py --decoder tools/noita-save-decode.py
NOITA_DECODER_PATH=tools/noita-save-decode.py python3 tools/import-noita-terrain-test.py
```

Each binpack (v2) holds the native plane, the inflation
depth plane and the per-block backdrop plane; `sha256` covers the native plane only,
`fieldsSha256` the other two. The inflation pass takes about a minute on a laptop.

Requires numpy and Pillow. The decoder is integrated separately; use `--decoder`
and `NOITA_DECODER_PATH` to point to that file before integration. `--inventory`
decodes and reports without publishing. `--world` / `--wak` override local paths.
No game execution, save writes, GPU use, room assembly, or terrain repairs.

`route.json` is full provenance; `src/world/scenes/descent/terrainRoute.json` is
its runtime subset. Each binpack is deterministic, four-byte-padded gzip of
320×7216 (the crop x -3072..4144) native-name palette IDs, row-major X-fastest. Hashes cover decompressed
bytes. Air is 0; OUTSIDE is 255, not air. Element IDs approximate physical roles;
they do not collapse the distinct native material IDs stored in the raster.

Core bands start at -1536 (sky above the start mountain) every 256 native pixels.
Each has 32 actual neighboring rows on both ends where the selected domain exists.
The final core ends at 13888; remaining rows are OUTSIDE. The top 32 rows are
actual saved sky where it was streamed, OUTSIDE where it was not.
Horizontal/domain caps are runtime boundaries, not claimed native materials.

Saved chunks always take priority. Only missing cells within the exact native
boss arena XML bbox `(1536,12288), width2600,height1600` use original WAK PLZ.
Opaque black becomes air ONLY in this fixed-scene fallback: the regression
fixture compares 612,469 black cells to saved material names, finding 611,991 air
cells. The clean source has every arena chunk, so no fallback cell is used. Other unknown fallback
RGBA fails. Rare unresolved callbacks in already-saved pieces are inventoried
in provenance but never interpreted or used to clear geometry.

The run starts at Noita's own start, standing on moss at `(227.5,-76)`, in
noitaTerrain05. No fluids were removed. Portal metadata is source-authored
topology, not proof that saved entities survived or remain liquid-enabled. Six
ordinary variants remain labeled unverified default candidates. All target
bodies are collision free.

The bottom two debug spawns are `hazardous-streaming-only`, unsupported native
lava-band positions, not safe starts. Their bodies fit actual resident context.
Continuous streaming enters those bands at the existing source position instead
of using debug spawns. No safe platform or headroom was added.

Source: a fresh vanilla day-0 world (`worlds/_archive/descent-clean-2026-10-17`),
streamed by the `descent_flythrough` camera mod while the player stayed at the
start. Rigid bodies/opaque physics and saved entities are not rasterized.
Fold changes angle/thickness only: source raster identity remains unchanged.
