# Seamless world: the contract

Status: in progress on `arch/seamless-world`. User decision, 2026-10-24: "delete our entire approach and start
over". The diagram and the census are at https://claude.ai/artifact/SJvV56z5x4gXwbnhwoLCKD.

## The idea

Today one 128³ window does three jobs: physics, the detailed picture and lighting. Past it, a 1.2 m brick copy is
drawn by a second shader (`world/far.js drawBehind`). Every 16-cell move rebuilds all three, and the box's cut
walls draw over nearer coarse ground. The new design splits the three jobs apart:

1. **World copy (W).** The whole map at full cell detail, resident on the GPU from load. It is sparse: one u32 per
   cell, held in 4³ bricks. It is the only thing the picture reads for "what is in this cell". Physics writes the
   bricks it changed into it every tick.
2. **Fields (F).** The smooth-surface, media and thin fields (today `derived.js` / `shaders/fields.js`), held as
   camera-centred clipmaps in world cells and derived from the world copy. They update for changed bricks and for
   the slab a clip level scrolls in, under a per-frame budget.
3. **Lighting (L).** Sun shadows, colour through glass and water, bounce light, glow, lamps and torches, centred on
   the camera and marched against the world copy. They are world-anchored and updated under a fixed per-frame
   budget.
4. **The march (M).** One full-screen ray march in world cells over W, F and L, on every map, small and big. It has
   no box-shaped draw and no distance pass. Detail fits the pixel: past the distance where a cell is smaller than
   its pixel, it reads the coarser field and occupancy levels.
5. **Physics region (P).** The 128³ window stays, for physics only. A move touches nothing the picture reads: its
   new slab is filled from the world copy plus the exact-state store, and nothing on screen changes when it moves.

No on-demand paging, feedback, attempts or transactions anywhere. This is what killed the deleted WORLD renderer.
Everything is resident from load.

Touchstones: Minecraft 1.18's separate Simulation Distance and Render Distance; Noita draws frozen chunks at full
detail; Teardown ray-marches a fully resident voxel level.

## Census (2026-10-24, CPU, exact)

Table plus mixed-brick pool: Island 8 + 14 MB, Lab Complex 8 + 12, Volcano Isles 8 + 6, Giant Volcano 24 + 7,
Tinker Creek 24 + 4. Descent is out of scope for now (user: "don't worry about descent"). It must keep loading,
on the old path if need be. About 99 % of mixed bricks hold a smooth-surface element, natural rock included.

## Coordinates

Render kernels work in **world cells**: float positions in cell units, the world's corner at 0, y up. A small map
is a world the size of its box. `H.origin` is 0 for every render kernel. Physics keeps its window-local cells, and
anything crossing between the two adds `sim.origin`.

## Bind groups of render kernels (maxBindGroups 4; 8 storage buffers, 16 sampled textures a stage)

| group | owner | contents |
|---|---|---|
| 0 | existing | `RENDER_LAYOUT.FRAME`: element tables, FrameUniforms |
| 1 | **W** | world copy: 0 `WC` uniform, 1 `wcTable`, 2 `wcPool`, 3 `wcInfo`, 4 `wcOcc` (4 storage buffers) |
| 2 | **F, L, M** | 0–5 F's sampled textures (≤ 6), 6 F's `wrapLinear` sampler (repeat), 7 F's `FC` uniform; 8–13 L's sampled textures (≤ 6), 14 L's `LC` uniform, 15 and 20 L's storage buffers (≤ 2); 16 `tMediaNoise`, 17 `linearClamp` (M); 18 `flow`, 19 `aeration` (P's, physics-region indexed) |
| 3 | existing | `LAYOUT.PARAMS`: header and kernel params |

F and L each export their entries as `[binding, name, wgslType, layoutBody]` lists (`FIELDS_BINDINGS`,
`LIGHT_BINDINGS`) plus a `bindEntries()` returning resources. M assembles group 2 in `src/shaders/world/bindings.js`.
A resource that's missing binds a dummy, never a gap.

## Shared ABI (committed, `src/shaders/world/cellWord.js`, checked by `tools/world-cell-word-check.mjs`)

- **Cell word, u32:**
  - bits 0–7: id
  - bits 8–15: ctype & 255
  - bits 16–23: temperature code. Codes 0–159 are 1 °C steps from −60 to 99 °C; codes 160–255 are log steps from
    100 to 6000 °C.
  - bits 24–30: aux, 0–127. A liquid's fill (127 = whole), else matter's life fraction.
  - bit 31: 0
- **Brick table entry:** a uniform brick's cell word, or `WC_MIXED | slot`. A pool slot is 64 words, cell
  `x + 4(y + 4z)`.
- **WGSL decoders:** `wcId wcCtype wcTemp wcAux wcWord wcTempCode wcLocal`.

## Interfaces each owner provides

**W — `src/world/worldCopy.js`, `src/shaders/world/copy.js`**
- WGSL `worldCopyWGSL` declares group 1 and provides:
  - `wcCell(c: vec3i) -> u32`. Outside the world it returns air.
  - `wcA(c: vec3i) -> vec4f`, with the same meaning as `shaders/compact.js volumeA`: id, °C, life,
    ctype + seed. The seed comes from `seedWorld` of the world cell, and the liquid dither is applied from the fill.
  - `wcInfo(b: vec3i) -> u32`, with the `BRICK_INFO` bits of `shaders/bindings.js`, so the march's brick tests
    keep their meaning.
  - `wcOccupied(level: u32, c: vec3i) -> bool`. Level 0 is the brick (4³); levels 1 and 2 are 16³ and 64³ cells.
  - `WC.size` and `WC.bricks` as uniforms, so one module serves every map size.
- `class WorldCopy`:
  - `constructor(gpu, { size })`
  - `async build(scene/source)`: the whole map from the scene generator, including trees, structures and saved
    edits, before the first frame. A small map is built from its box's cells.
  - `bindGroup`, `layout`
  - `recordWriteback(frame, sim, boxes)`: physics' changed boxes, in window cells, written into the copy. It
    allocates and frees pool slots on the GPU and keeps `wcInfo` and `wcOcc` current.
  - `changes`: world-cell boxes changed since a revision, `changesSince(rev)`, for F and L.
  - `dispose()`
- Budget: writeback costs in proportion to the changed bricks, never the window.

**F — `src/gfx/worldFields.js`, `src/shaders/world/fields.js`**
- WGSL keeps the names the march calls today: `surfField surfSample surfChannel fieldCubic fieldCubicGrad
  mediaField fieldTex(tFT …) cubicShare surfNormal`. Their argument `p` is now in world cells.
- It selects the clip level from `gFieldLevel`, a private var the march sets from the pixel footprint.
- It provides `fieldLevelFor(footprintCells: f32) -> u32`.
- `class WorldFields { constructor(gpu, worldCopy); update(frame, cameraWorldCell, changes); bindEntries(); }`.
  The clip origins snap by whole bricks. Texture addressing wraps with the repeat sampler, so a scroll writes only
  the slab that came in.
- The liquids' EMA history lives in the clip texels, keyed to the world, so it survives physics moves.

**L — `src/gfx/worldLight.js`, `src/shaders/world/light.js`**
- WGSL keeps the names the march calls today, from `shaders/gfx/lighting.js`: `sunShadow` and its optics,
  `probeAt surfProbe nearField`, glow, lamps and torches, crystals and beacon, clouds and caustics. They are now in
  world cells over W and F.
- `class WorldLight { constructor(gpu, worldCopy, fields); update(frame, camera, sun, changes); bindEntries(); }`
- A fixed amount of work per frame. The camera moving or physics moving never rebuilds it as a whole.

**M — `src/shaders/world/march.js`, `src/gfx/worldView.js`, `src/shaders/world/bindings.js`, app.js frame wiring**
- The realistic view as a full-screen march in world cells that keeps `surface.js`, `liquid.js`, `media.js` and
  `grains.js` shading. Rays that leave the world go to the sky and edge-sea pass. Depth goes to TAA, and the mesh
  cut is kept.
- It deletes `world/far.js drawBehind` and the box-shaped volume draw from the realistic view, on every map.
- The data views (heat, pressure, flow, X-ray) may keep marching physics' window for now. Mark it
  `// Same look (...)`.
- M may stub F's and L's exports in `src/shaders/world/stubs.js` until they land, never in their files.
- The march is split into GPU passes (`march.js`, "The split march"): `world march` (the loop, into a G-buffer:
  hit point, gathered colour and transmittance, hit kind and ids, F's level), `world reflect` (the deferred
  reflection trace) and `world shade` (the tracer's shading tail, unchanged), recorded by `worldView.prepass`
  before the scene pass; the scene pass composites their colour and depth over the sky. 100 B a pixel at the
  scene target's size. The grain detail variants draw as one pass (their hand-off band keeps a second path
  in flight across the cut). `worldView.split = false` is the A/B.

**P — `src/world/window.js`, `src/sim.js` shift, the derived/occupancy `onShift` hooks, `src/v2/integration.js` shift**
- A move is physics only:
  - No derived, field, GI, occupancy, far or render-source work.
  - No CPU tree baking. Trees are in the world copy.
  - No synchronous readback or PackBits in the frame.
- The new slab is filled from the world copy (`wcCell` decoded into V2 cores), then the exact native store is laid
  over it.
- Saves keep working.
- Ring addressing in place of the shift copy is a stretch goal, taken only if the shift is measured past 1 ms.
- Budget: a move costs ≤ 2 ms GPU and ≤ 2 ms CPU in its frame, and the rest spreads over frames.

## Rules for every agent on this

- Your own worktree and branch from this contract's commit (`arch/sw-<letter>`). Edit only the files you own.
  Anywhere else, add new exports and never change existing ones. If you need a change to the ABI or to another
  owner's interface, say so in your report rather than doing it.
- Commit WIP to your branch as you go, with explicit file lists. `/usr/bin/git`, never `git add -A`.
- CPU first:
  - naga on every new WGSL module
  - a `tools/*-cpu-check.mjs` for every pure piece
- GPU:
  - Only with a hypothesis written down first, on AC power (`pmset -g batt`).
  - Through `tools/browser.mjs`, ≤ 25 s a slot, at most 3 slots each.
  - The user may be playing. Never `TPT_IGNORE_PLAYER`.
- Stop everything you start.
- `// Intentional (...)` / `// Same look (...)` on every difference between maps (CLAUDE.md, "Same features in
  every world").
- Borrow known solutions and cite them: clipmaps (Losasso & Hoppe 2004), DDGI scrolling volumes, sparse brick
  maps.
