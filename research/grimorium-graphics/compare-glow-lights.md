# Glow lights: Grimorium vs ours

Read from code in this worktree (base ff1d35e6). No GPU or build was run.

## 1. What Grimorium does

- Emitters: "Lava, fire, embers, acid, and dozens of other materials emit light. ... There can be thousands of emissive voxels in view at once. Treating each one as its own light would be way too taxing on the system, so a GPU pass runs over the chunks and condenses them." (05:03-06:24)
- Merge rule: "Each chunk is divided into eight octants, and the emissive voxels in each octant merge into a single point light. Its brightness scales with how much glowing material is there." (06:24)
- Lookup: "Each chunk then keeps a list of which lights can reach it. So when a ray reaches a surface, it only considers the handful of lights that matter locally instead of every light in the world." (06:24)
- Shadows: "the shader fires a second ray from that surface towards each light source, traversing exactly as the initial ray does. If it hits anything solid along the way, the light is blocked." (06:24-06:43)
- Sun softness only: jitter is applied to "the shadow rays for directional lights ... blended over multiple frames". The video does not say the point-light rays are jittered.
- Other sources: point lighting "could be the player, an item, or emissive world voxels" (05:03).
- Emission that lights nothing: "Emissivity is the light directly coming off the object looked at. This is different from point lighting as it doesn't actually illuminate things surrounding it ... creature's eyes" (05:03).
- Ambient floor: "a baseline that's added universally ... regardless of other light sources" (04:39).
- Hardware context: the game renders at 1/3 window resolution (07:37) on a laptop RTX 4060. That is 1/9 of the rays per frame.

## 2. What we do, exactly

**The volume that holds glow.** Glow is a 3D light texture, not a list of lights.

- Small maps (the old path):
  - The producer is `brickFrag` (`src/shaders/passes.js:745`). It writes a per-brick emission, averaged over the brick's cells (the 64-cell sum, `passes.js:738`).
  - Fire and plasma use blackbody times a gain (`passes.js:851`).
  - Other hot or luminous cells use `cellEmission * SHED + sparkEmit * LAMP_ROOM_GAIN` (`passes.js:853-860`). Lamps and live wires count here.
  - Opaque emitters are multiplied by open faces times `GLOW_FACE_GAIN` (a brick's depth in cells, `passes.js:859`, constant at `:779`). That is, a buried cell contributes nothing.
  - A brick is 4 cells (`GLOW.SPACING[0] = 4`, `src/shaders/world/light.js:87`).
  - The blur `blurFrag` (`passes.js:967`) runs six separable passes (x,y,z,x,y,z) with 5-tap weights `.10 .22 .36 .22 .10` and gain 1.15 (`passes.js:959-962`). It writes rgba16float `tLight`, one texel per brick.
  - Update rate: incremental. `brickFrag` notes a change box whenever a brick's emission differs (`passes.js:906`, `noteChange(BOX_LIGHT, ...)`). The blur re-runs only over regions that can change (`REGIONS`, `passes.js:442-460`), so cost follows how much glow changes, not the map size.
- Big maps (`src/shaders/world/light.js`, `src/shaders/world/lightWriters.js`):
  - `GLOW` is 2 clip levels of 64^3 texels, at 4 and 16 cells a texel (`light.js:84-91`).
  - The seed kernel `glowSeedFrag` (`lightWriters.js:~330-390`) averages the 64 cells of each level-0 brick. Level 1 reads ONE cell per brick, its middle, marked `Intentional (world light): the far glow is a coarse estimate`.
  - The blur is the same two 5-tap passes per axis, folded into one 9-tap kernel with gain 1.15 squared (`lightWriters.js:~323-331`). It matches the old six passes.
  - Budget: `GLOW.JOBS_PER_FRAME = 6` chunks of 8^3 texels per frame (`light.js:90`, `src/gfx/worldLight.js:183`). Only chunks touched by changes, or newly in range, are redone (`worldLight.js:180-183`).
  - World glow is tagged per chunk. A stale chunk falls through to the coarser level (`light.js` header).
- `docs/world-gi-glow.md` is a separate, disabled checkpoint (phase 4b) of a different glow producer. It is not what ships. It states the glow blur is "Exact passes x,y,z,x,y,z ... gain 1.15 each pass", and that no low-resolution tier exists.

**How a surface turns the volume into light.**

- `glowWorthIt` (`src/shaders/gfx/lighting.js:917`): look only when the glow's luminance is at least 5% of the light already there (`GLOW_REL_MIN`, `:915`).
- `glowLightScale` (`lighting.js:926-955`; the same code is at `src/shaders/world/light.js:907` for big maps):
  - 1 volume read at `p + ng * 0.55`.
  - 6 more reads for a central-difference gradient (step 2 cells).
  - The gradient gives a direction `L` and how directional the glow is (`D`, via `GLOW_DIR_LEN = 8`).
  - Up to 3 occlusion taps at 1, 2.5 and 5 cells toward the light (`GLOW_TAP_D`, `lighting.js:903`). Each reads the smooth surface fields (`surfField`) and one cell (`fetchA`). Opaque matter blocks. Lava, liquid and glass do not. Glowing opaque cells do not.
  - Taps stop at 0.75 of the light's estimated distance (`GLOW_REACH`), derived from the gradient (`r = 2 E / |grad E|`).
  - Result: `vis * mix(1, 2 * max(n.L, 0), D)`.
  - Cost about 7 filtered 3D texture reads plus at most 3 field and cell reads per pixel, only where the glow matters. No rays, no per-light loop.
- Applied once, in `shadeSurf` (`src/shaders/gfx/surface.js:2388`), as `local *= glowLightScale(...)`.
- Liquids and media read the raw volume with no direction or shadow (`src/shaders/gfx/liquid.js:132`, `sampleLight` at `lighting.js:563`).
- Second-hand views read the raw volume plus wand lights (`lighting.js:563-567`).

**The flicker history.** Commit `faccbb129` (2026-10-14), "Realistic view: near field, glow lights and sun edges from the volumes, no secondary walks":

- Before: "one shadow ray to a randomly picked glowing brick" per pixel.
- Result of that: "The +-20% TAA flicker (audit B4)".
- Change: replaced by "direction and strength from the glow volume's own gradient, shadowed by 3 taps toward the light ... as Source's ambient cubes read a light volume".
- Same commit removed the two random near-field rays and the exact sun ray. So the old design was Grimorium's shape (a few lights, a traced ray per light), except ours picked the light at random, which Grimorium's per-chunk list avoids.

**Lamps and torches (the point-light side).**

- Hand and thrown lamps (`LAMP_MAX = 8`, `src/gfx/lamps.js:8`) plus wall torches. Torches take the slots the hand lamps leave, nearest to the eye, reach 40 cells, re-picked when the eye moves 1 cell (`src/world/torchLights.js:15-25`, `slots: LAMP_MAX - 2`).
- Each lit lamp gets a real traced shadow ray per pixel (`traceNearSteps`, `src/shaders/world/light.js:1119`). It is a tube light with a jittered aim point when `soft` (`light.js:1099-1108`).
- Far torches keep only the faint volume glow (`torchLights.js` header comment).
- Cold wand lights: up to `WAND_LIGHTS = 8` (`src/shaders/bindings.js:22`), unshadowed radial falloff, a code comment says occlusion is a later option (`lighting.js:~548`).
- The comment at `torchLights.js:5-8` states why: "the glow volume spreads a cell's light over bricks: it lights nothing round it that way".

**GI probes carry glow.** Yes. `giSourceFrag` includes each emitter's own emission (`src/shaders/gi.js:331`; header `gi.js:15-24` says "a glowing thing lights a room by bounce too"). Probe history is blended at `BLEND 0.15` (`light.js:80`). Big maps have 3 probe levels, 32^3 each, spacing 4/16/64 cells.

**Emission that lights nothing.** Cells that are on view glow by `cellEmission` in their own shading. Whether a cell also feeds the light volume is decided by the filter in `brickFrag`: only hot, luminous, live or lit cells. So the Grimorium "eyes" case maps to a material that is visible-emissive but not fed to `brickFrag`. I did not find a named "emits but lights nothing" flag; I did not grep every material.

**Far lava.** `far.js` keeps a coarse far-grid glow level per far brick (`far.js:42-47`, `:175-179`, 8-bit steps). At draw time `farGlowT` (`far.js:1478-1481`) turns it into a surface temperature, so far lava is lit as incandescent matter. `farGlow` is read only at `far.js:1479`. Nothing there samples `tLight` or lights neighbours, so far lava does not light far terrain around it.

## 3. Side by side

| | Grimorium | Ours |
|---|---|---|
| Representation | list of merged point lights, 8 per chunk | 3D blurred emission texture (per brick), plus a gradient |
| Resolution | octant of a chunk (chunk size not stated) | one texel per 4-cell brick; far level one per 16 cells (big maps) |
| Light count a pixel | "handful" from the chunk list | none: 7 reads, up to 3 occluder taps |
| Light direction | exact, from the merged point | estimated from the gradient; weak when the field is flat |
| Occlusion | one full traced ray per light | 3 sparse taps, within 75% of the light's estimated distance |
| Update | GPU pass over chunks (rate not stated) | change-box driven (small maps); 6 chunks a frame (big maps) |
| Noise | rays per light, but only the sun is jittered, so stable | none: deterministic every frame (the fix at `faccbb129`) |
| Hand lights | player/item point lights, same shadow rays | up to 8 lamps, real traced shadow rays; wand lights unshadowed |
| Eyes (emit, no light) | explicit | by omission from `brickFrag`; not verified as a feature |

**Same.** Both merge many emitters into something much smaller than one light per cell. Both skip per-cell lights. Both let point lights from the player/items go through the same lighting path.

**Where we are ahead.**
- Cost is flat. A pixel does about 7 texture reads and 3 taps however many cells glow. Grimorium pays one DDA ray per light per pixel (the lights are few, but each ray is "exactly as the initial ray").
- Stable under TAA, by construction (the fix at `faccbb129`).
- Update cost follows change (the change box and the 6 jobs/frame budget).
- A glowing region's full extent counts, not only its octant centroid, so a long lava river lights as a river rather than as a few points.

**Where they may be ahead (or look better).**
- Sharp, correct shadows from a lava pool onto a nearby wall: ours has 3 taps, up to 5 cells out, inside 0.75 of the light's estimated distance. A thin wall past 5 cells, or a corner between a face and a lava pool, can leak light or fail to shadow. The tap reach is fixed at `GLOW_TAP_D = (1, 2.5, 5)`.
- Direction when many sources overlap: the gradient points at the strongest blur peak, not at each light, so two pools on opposite sides can cancel the gradient and fall back to `D ≈ 0` (undirected glow, `D` clamps to 0 when `|grad|` is small).
- Many small lights: a lone lamp in a lava cavern gets a point-light-like cone only if it is a lamp slot; a luminous crystal or a live wire next to it only gets the blurred, undirected glow.
- Fine-scale colour: ours blurs over a 4-cell brick plus the 9-tap kernel, so a 1-cell ember lights a ~4-8 cell soft blob. Grimorium's octants are coarse too, but each octant is its own point.

## 4. Anything worth trying (ranked)

1. **Nothing urgent for frame time.** Ours is already cheaper than a ray per light. The stated target (`CLAUDE.md`: steady 60 headroom) is not served by adding rays here.

2. **Look: a few real shadow rays to the dominant glow cluster, only on pixels where `D` is high and the 3 taps cannot decide.**
   - Reason from the code: `glowLightScale` is the only place a lava pool's shadow on a wall is decided, and its taps stop at 5 cells and `GLOW_REACH`. The old random-pick ray flickered because the light changed per pixel/frame. A pick that is deterministic (the brightest brick the gradient points at, found by walking up the gradient) would not flicker.
   - Test needed: a CPU harness is not enough. One screenshot comparison of a lava pool beside a wall with a post in between (and the same with a thin sheet), current taps vs ray, plus a TAA stability check across frames. That needs one GPU slot, so only after the user says shadows from lava look wrong. No user complaint is recorded in the files I read.

3. **Tap reach.** `GLOW_TAP_D` reaches 5 cells; for a bigger pool that is inside the pool's own blur radius. If shadows from large lava ponds look too soft, the constants (not new code) are the first thing to retune. This is cheap and would need only a lava-wall screenshot pair.

4. **Wand lights unshadowed** (`lighting.js:~548`, the `ponytail` comment). Grimorium shadows all point lights. If wand light leaking through walls is ever seen, reuse the lamp tracing path. Not a frame-time item.

5. **Far lava lights nothing.** Grimorium's far rings are for seeing; nothing in the video says far lava lights its neighbours either. Skip.

## 5. What the video can't tell us

- Chunk size, octant count of lights seen at once, and the "handful" number (the list length cap).
- How often the condense pass runs, or whether it runs only on changed chunks.
- Whether shadow rays for point lights are jittered (the video says jitter only for "directional lights", 06:24).
- How far a light "reaches" a chunk, or how falloff works.
- Whether lava, a large flat emitter, ends up as 8 lights or fewer per chunk, and what a whole river looks like (a few points, hence possibly banded).
- Any cost numbers: no milliseconds, no ray counts for lights. The only hardware figures are the 1/3 resolution on an RTX 4060 (07:37).
- Quality: the video states these graphics are "the current state of implementation" (00:58 area), not a final look.
