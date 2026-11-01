# Grimorium vs ours: sun shadows, point-light shadows, ambient occlusion

Source: `research/grimorium-graphics/text/Y8HRCXxI0BY.txt` (Burkelbear Games explainer). Our code is read in the worktree `threejs-tpt-gpu-wt-grimcmp` (base ff1d35e6). CPU reading only, nothing run.

## 1. What Grimorium does (quoted)

- Sun: "Directional light applies from the direction of the sun, checking in one uniform direction to determine if it's applied or blocked due to shadow." (04:47)
- Point lights: "Point lighting comes from a point in space and could be the player, an item, or emissive world voxels." (05:03) Glowing voxels are condensed: "Each chunk is divided into eight octants, and the emissive voxels in each octant merge into a single point light." "Each chunk then keeps a list of which lights can reach it ... it only considers the handful of lights that matter locally." (05:03-06:32)
- Shadow rays: "the shader fires a second ray from that surface towards each light source, traversing exactly as the initial ray does. If it hits anything solid along the way, the light is blocked." (06:24-06:55)
- Soft sun: "Some jittering is applied to the shadow rays for directional lights to mimic the larger light source of the sun and this gets blended over multiple frames to give the slightly softer shadows." (06:24-06:55)
- AO: "an ambient occlusion pass samples the corners around each surface point to see how enclosed it is. Darkening creases, cave corners, and the bases of walls." (05:03-05:41 block; the narration puts it right after the material list)
- Frame context: renders at one third of window resolution per axis ("1/3 of window resolution, which means tracing 1 ninth as many rays", 07:37) with sub-pixel camera jitter and TAA over a history buffer (07:37-08:13). The jittered shadow rays lean on that TAA.
- Ambient: "a baseline that's added universally ... regardless of other light sources." (04:47) No GI beyond that is mentioned.
- Not stated: number of shadow rays per pixel, AO sample count, shadow ray length limit, whether gas, grass blades or transparent matter cast shadows, what the far rings do for shadows.

## 2. What we do, exactly

**Sun visibility is a cached shadow map, not a per-pixel ray.**
- Three cascades, 512x512 texels each, 8x8 texel tiles; texel size 0.5 and 2 cells for the scrolling cascades, the last cascade holds the whole world (`src/shaders/world/light.js:58-70`, `SHADOW`). Four slots, one spare for a sun turn.
- Each texel is one DDA ray from the sun side into the world (the `shadow` kernel, `src/gfx/worldLight.js:119`; the map stores first-hit depth plus a liquid/glass tint entry in `.w`, `light.js:538-548`). Opaque depth, tint start and end are all in one texel (`rgba32float`, `docs/webgpu.md:972`).
- Caching: a tile is retraced only when (a) it scrolled into range, (b) a world change box touches it, or (c) the sun turned more than 0.5 degree (`light.js:67`, `src/gfx/worldLight.js:1-5, 168-175`). Budget 160 tiles per frame, 10,240 rays (`light.js:66`). Per-tile validity is a tag pair read by `shTraced` (`light.js:476-483`); an untraced tile reads as lit for a frame or two (`light.js:525`).
- Reading it per pixel: `shCascadeFor` picks the finest cascade by geometry only, a loop of up to two bounds checks with no memory loads (`light.js:460-473`). The comment records that its older form (tag reads per cascade, inlined at each call) was "most of the world march's per-pixel cost" (`light.js:461-466`, lead 2026-10-24). Then `sunMapShadow`: four bilinear taps with a receiver-plane depth bias, one tag pair read (`light.js:506-535`).
- Soft edges (PCSS): only pixels not fully lit by the 4 taps pay for it (`light.js:538` `if (nLit == 4.0) return acc;`). Those do an 8-tap Vogel-disc blocker search (rotated per pixel by interleaved gradient noise tied to the frame, `light.js:545`) and, if the penumbra is wider than one texel, an 8-tap filter (`light.js:551-570`). So 4 taps for lit pixels, up to 4+8+8 = 20 map reads plus cascade/tag reads at an edge. The map's `.x` is duplicated into an `r32float` texture so these 16 taps read 4 bytes each (`docs/webgpu.md:996, 1874`; box view `src/shaders/gfx/lighting.js:408-433`).
- Sun size: `SUN_TAN_RADIUS = 0.021` (1.2 degrees, "stands in for a slightly hazy sky"; real sun 0.27 deg), shared with the sky disc (`src/gfx/sky.js:29`, `src/shaders/gfx/lighting.js:160-164`). The blocker search is capped at 6 cells in the big-world path (`light.js:149-151, PCSS_SEARCH_MAX`).
- Clouds multiply in: `cloudShadow` does `CLOUD_SHADOW_N` density reads along the sun (`src/shaders/gfx/clouds.js:151-159`), `sunShadow` = cloud x map (`light.js:586-591`).
- Liquids/glass: the map carries tint and optical depth, so water tints shadows and caustics are added under pools (`light.js:513-535`, `lighting.js:340-395`).
- An exact per-pixel sun ray was tried and removed for edges: "An exact DDA ray toward the sun per edge pixel used to sharpen it: a walk through the grid for a fraction of a cell, sub-pixel past a few metres" (`src/shaders/gfx/lighting.js:421-427`). `sunRayClear` stays for the probes only.
- Far field: a heightfield per channel, one bilinear read of `tFarShadow`, then `smoothstep` over FAR_SHADOW_SOFT = 1.5 cells either side of the column top (`src/shaders/farShared.js:87, 167-176`; `src/shaders/far.js:1082-1085, 1237`). It only knows column tops, so no overhangs. Plus `cloudShadow`.

**Point lights**
- Hand lamps and wall torches (at most `LAMP_MAX = 8`, `src/gfx/lamps.js:7`) get a real traced shadow ray per lamp per pixel, up to `NEAR_MAX_STEPS = 48` hierarchy steps (`lighting.js:643, 1151`). With `soft`, the aim point is jittered over the lamp's disc and height by blue-noise (`lampRand`, `lighting.js:712-714, 1134-1141`), so it is the same trick Grimorium uses for the sun (jitter + TAA), applied to the lamps.
- Lava/fire/emissive voxels do not get shadow rays. They go into a glow light volume read at the surface; its gradient gives a direction, and `GLOW_TAPS = 3` points along it ask whether opaque matter is between (`lighting.js:805-870`). The comment: "one shadow ray a pixel to a randomly picked emitting brick used to flicker under TAA" (`lighting.js:~815`).
- Light range per surface is a probe/glow clip on a cascade lattice (`PROBE`, `GLOW` in `light.js`), not per-chunk light lists.

**Ambient occlusion / "Contact Shadows" (nearGI)**
- `nearField` (`lighting.js:775-870`, UI label "Contact Shadows", `src/app.js:1687`): 6 fixed taps in the cosine hemisphere (one along the normal and a ring at 50 degrees, 1.5 to 2.6 cells out; `lighting.js:790-800`), each one a field/state lookup `nearSolid`, not a ray. Weighted occlusion, floor `NEAR_VIS_MIN = 0.15`. The occluders' albedo, emission and the light on them (`hitLight`: sun map, lamps, probes, glow) are blended in as bounce light. Cost: 6 `surfField` reads plus state reads, plus one `hitLight` (one `sunShadowAt` tap set, one probe read, `lampSeen` if lamps).
- Deliberately the same every frame: "so nothing shimmers and TAA has nothing to average (two random rays a pixel used to walk the grid for it)" (`lighting.js:775-777`). The earlier version was 2 random rays a pixel (`docs/v2/evidence/audit-render.md:178`).
- Large-scale ambient: L1 SH probe cascades (`PROBE`, `light.js:71+`), the equivalent of Grimorium's flat ambient, but occlusion-aware and bounce-carrying.

**Measured cost (docs/march-spill.md:370-385, Lab, 2560x1600 at x0.667, M5, on battery)**: shade stage total 2.07 ms of 15.56. Stubbing sun shadow: span 14.93 (about 0.6 ms); stubbing everything lighting: 14.38 (about 1.2 ms); Contact Shadows + Lava Lights off: 16.01 (within noise; "The near field and the glow's direction are within noise", `march-spill.md:~385`). The march (not shading) is the main cost per the memory notes.

## 3. Side by side

| Aspect | Grimorium | Ours | Verdict |
|---|---|---|---|
| Sun visibility | per-pixel ray, same DDA as camera | cascaded map of DDA rays, cached across frames | Different. Ours is ahead on steady-state cost; theirs is exact for every surface |
| Sun soft edge | jittered ray + TAA over frames | PCSS on the map, sun disc 1.2 deg, plus per-pixel rotated taps and TAA | Both end with TAA smoothing noise. Ours is sized by blocker distance (a real penumbra); theirs is a fixed cone |
| Sun cost per pixel | 1 ray (step count not given) | 4 taps lit; up to ~20 at edges | Ours cheaper on open ground; theirs scales with occluder complexity |
| Re-trace on change | n/a, every pixel every frame | only changed tiles; 10,240 rays/frame budget | Ours; but there is a lag (lit for 1-2 frames after a jump, `light.js:525`) |
| Transparent/tinted shadows | not stated | tint + depth in map, caustics, clouds | Ours ahead (as far as the video says) |
| Distance | rings at 2x and 4x voxel size, rays continue | world cascade covers the world, heightfield far shadow | Different. Ours: last cascade at 2 cells/texel is coarse for far PCSS |
| Point light shadows | ray per light, lights from chunk lists | ray per hand lamp (8 max), jittered; world glow without rays | Same idea for lamps. They shadow emissive voxels with rays, we use a gradient and 3 occlusion taps |
| Emissive voxels as lights | octant merge per chunk, list per chunk | glow volume (blurred emission) | Different; ours has no cap on the number of glowing cells, theirs has a light list per chunk |
| AO | corner samples around each point | 6-tap hemisphere in fields, also bounce | Same intent. Ours adds coloured bounce and is temporally stable by design |
| Ambient | flat floor | SH probe cascades | Ours ahead |

Where they might be ahead: exact shadows everywhere with no map resolution, bias or peter-panning to tune, no tile-lag; hard contact shadows exact at any scale. We pay for this with the bias machinery (`SHADOW_BIAS_MIN`, receiver-plane slope, `light.js:496-509`) and a "lit until traced" window.

## 4. Anything worth trying

1. Nothing for the sun's main path. The measured cost of sun shadow is about 0.6 ms of a 15.6 ms span (`march-spill.md:377-380`), shadows are cached, and the exact-ray alternative for edges was tried and dropped (`lighting.js:421-427`). Per-pixel sun rays would add a DDA per pixel to the stage we know is march-bound.
2. Low impact, possible look item: the world cascade is 2 cells/texel (`light.js:63`), so distant penumbrae and contact shadows are coarser than near. A test would need a close-vs-far shadow-edge capture at one fixed pose, not a GPU timing run. Only worth it if the user sees blocky far shadows.
3. Lamp ray cost: 8 lamps x up to 48 steps per pixel is the one place we pay ray cost per pixel for shadows. Grimorium culls to lights "that matter locally" per chunk. We already skip lamps by range (`d2 >= R*R`, `lighting.js:~1120`) and by `nl <= 0`; a per-brick lamp list would only help if many lamps are on. Evidence needed: a count of lamps in range during a torch-heavy scene and the profiler's lamp share. Not supported by current data.
4. Nothing from their emissive-octant merge: our glow volume has no per-chunk cap and the notes record the per-light ray version flickered.

## 5. What the video can't tell us

- Rays per pixel, ray length/step limits, or any timing for shadows or AO; the only number given is render scale 1/3 per axis on an RTX 4060 laptop (07:37).
- How many frames the shadow jitter blends, and whether it uses the same TAA history as the colour.
- Whether the AO is traced (rays) or lookup-based, how many samples, and whether it darkens by occlusion distance.
- Whether grass blades, leaves, gas density blobs or the rings cast or receive shadows or AO.
- How shadows work for the mid and far rings (2x and 4x voxels) and how they compare at a distance.
- Cloud shadows, water tint, caustics: not mentioned at all.
