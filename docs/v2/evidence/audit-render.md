# Audit: the LOOK and the MATERIALS (render v2 input)

Scope: `src/shaders/render.js`, `src/shaders/gfx/*` (surface, grains, relief, crystal, liquid, liquidDetail,
media, mediaDetail, clouds, lighting, core, plain, deco, noise, lib), `src/gfx/materials.js` (LOOKS),
`src/gfx/post.js`, `src/gfx/sky.js`, `src/gfx/detail.js`, `src/gfx/incandescence.js`.
Tree: branch `claude/webgpu-port` @ 42f4039 (read-only; an exported copy was rendered, see "Evidence").
Line numbers are that commit's.

---

## 0. Verdict in five lines

1. The look is built on the wrong scale. Cells are 30 cm (`src/scale.js:18`), they are blurred into blobby
   isosurfaces, and then hundreds of constants' worth of millimetre-to-centimetre procedural texture are painted
   on top.
   From the default god view (39-103 m away) almost all of that texture is already faded to a flat mean
   (table in 2.3), so what the player sees is **flat-coloured clay** with rounded edges. That's the root of
   "it doesn't look good".
2. Seventeen elements get bespoke hero shaders, 13 `matOf` branches (sand, rubble, snow, gunpowder, ash,
   wood, plant, steel, fluorite, "gold" Clone, concrete, lava, and five rocks sharing CRAG); the other ~73 materials (gold, brick, salt, titanium,
   clay, mud, moss, every Noita liquid...) get a flat albedo. So detail is uneven: a fully textured crag sits
   next to plastic grass (`PLANT` far LOD) or textureless `GOLD` beside textured `CLONE`.
3. There are ~10 separate lighting models for the same scene (surfaces, floor, reflections, near-field
   bounce, liquid interiors, media, plain view, data views, figures, the page sky). They disagree on emission,
   sky and AO, and that's where the visible inconsistencies come from (2.4, bugs B1-B4).
4. Per pixel, a ray can run up to 4 secondary DDA walks (near-field ×2, glow light, exact sun ray), 2 traced
   reflections, PCSS, 4 `matOf` evaluations with 27-neighbour Worley searches, and several Bernoulli-noise
   estimators that only converge under TAA. In a sunlit god view those rays barely change the image (raw
   consecutive frames differ by 0.15/255); close up (volcano flank, 5.8 m) raw frames differ 10× more and
   TAA frames still shimmer (0.83/255), and through water there is speckle after 4 TAA frames. The
   realistic module is
   **5,400 lines / 263 KB of WGSL with 1,070 named constants** (Balanced), 6,499 lines at Full.
5. The engine-level ideas are good and worth keeping: brick-skipping DDA, one deferred shading call site,
   footprint-based LOD, data-driven LOOKS, Beer-Lambert liquids with coloured shadow-map transmittance,
   blackbody incandescence, AgX + eye adaptation + energy-conserving bloom, TAA/TAAU, the data views.

---

## 1. What the renderer is today (one paragraph, with numbers)

One fragment pass over the window box's back faces runs a voxel DDA with 4³ brick skipping
(`render.js:859-1090`). Crisp elements are bevelled voxels (`surface.js:1447`); smooth elements are the 0.5
isosurface of Gaussian-blurred occupancy (`materials.js` CHANNELS sigma 0.6-1.0), root-found per cell
(`core.js:209-251`); gases are density volumes stepped at 1 sample per cell (`media.js:50`). Every hit is
shaded once after the march (`render.js:1092-1132`) by `matOf` (procedural material, `surface.js:661-1219`)
and `shadeSurf` (GGX + multiple-scattering + Oren-Nayar + wrap SSS + glints + split-sum environment with L1 SH
probes + near-field GI rays + glow-light RIS + lamps, `surface.js:1688-1795`). Post is TAA/TAAU, bloom, eye
adaptation, CAS sharpen, AgX with a "Punchy" blend and a warm per-channel roll-off (`post.js:743-943`).

Sizes of the assembled WGSL at 128³ (my node script `v2/size.mjs` over `volumeFrag`):

| module | chars | lines | functions |
|---|---|---|---|
| realistic, detail off | 251,517 | 5,194 | |
| realistic, Balanced (default) | 263,392 | 5,400 | 320 |
| realistic, Full | 314,250 | 6,499 | |
| heat / pressure / flow / xray | 246-251 K | 5,081-5,191 | 325-328 |
| plain | 244,874 | 5,030 | 313 |

Every data view and the plain view paste the **whole** material library (surface, liquid, media, grains:
`render.js:1213-1224`) although they call almost none of it: ~245 KB of text for Tint to parse and resolve
before dead-code elimination. 1,070 `const` declarations in the realistic module. `matOf` has 3 call sites
(gatherMat, crispSurf, and the dead `albedoOf`, `surface.js:1224`, which nothing calls).

Measured costs already in the repo (`gfx/detail.js:61-101`, M-series laptop, 1280×800, extra GPU ms/frame):
relief "lab eyeWood 9 → 48 ms", grains +17 ms, clods +14 ms, smoke filaments +16 ms, flow-following smoke
+5.9 ms. Phones skip all of it: `app.js:149-153` turns off near GI, glow lights, caustics and every detail
feature, and drops to 'performance' upscale. **The target device (iPhone 17 Pro Max) is already a
second-class citizen in the current look.**

---

## 2. The slop, by kind

### 2.1 Root cause: smooth clay at 30 cm, painted with millimetres

- **Blur → isosurface turns everything into clay.** Smooth channels are the 0.5 level of occupancy blurred by
  sigma 0.6-1.0 cells (`materials.js` CHANNELS) and read trilinearly. Trilinear gradients crease at the cell
  lattice, so the normal is taken with a 0.55-cell-wide stencil "to iron them out" (`core.js:240-251`). The
  result can't hold an edge: rock cliffs, wood trunks, sand piles and plant clumps all come out as rounded
  plasticine. You can see it in the README's own hero shot (`docs/hero.jpg`: a brown clay cone, trees as green
  balls on sticks) and in `docs/arenas-dam-valley.jpg` (broccoli trees, rounded walls). Sand/water get a cubic
  B-spline only for thin features or up close (`core.js:159-207`), a second representation to tune.
- **Textures are sized in metres for a world nobody sees from 1 m.** Every material converts physical
  wavelengths through `CELL_M = 0.3` (sand grain mottle 6.7 mm, steel grooves 2 mm, concrete pits 3.6 cm,
  leaves 3.5 cm, bark plates 5 cm, lava plates 10 cm...). `lodFade` (`surface.js:104-106`, fade 0.25 → 0.5
  cycles/pixel) then removes them before they alias. That's correct anti-aliasing, but it means the detail
  is only there inside a few metres. See 2.3.
- **What survives at play distance is the "far mean"**, a hand-picked constant per material
  (`PLANT MEAN 0.88`, `STONE MEAN 0.8`, `WOOD RIDGE_MEAN 0.7`, lava `eFar`...). So the god-view look of most
  materials is one flat albedo times one fudge factor. That's the "plastic" look in the Dam Valley grass.
- **The cell is too big to be the pixel, too small to be a block.** TPT and Noita read because one cell is one
  pixel of flat, varied colour. Minecraft and Teardown read because they *embrace* the voxel and texture or
  colour it at its own scale. This renderer hides the voxel (smoothing) and then textures at 1/50th of it.
  Nothing is authored at the 0.3-3 m scale where the player actually looks.

### 2.2 Special-case material shaders (per element, `surface.js matOf` unless noted)

| element(s) | where | what it draws | visible within (1280×800, 40° FOV) | verdict |
|---|---|---|---|---|
| SAND | `surface.js:678-706`, slumps/clumps 343-356 | 3 fBm layers + Worley-free dark-grain dots + glints | slumps always; clumps < 7-14 m; grains < 2-4 m | keep slumps + glint, drop the rest |
| STONE (rubble) | `surface.js:707-789`; `grains.js` (734 lines) | two Worley cell lattices (2 × 27 neighbours, **unconditional**: no LOD early-out), tilted chip facets, ridges, voids, grit, mottle; up close real pebble geometry | chips < 15-30 m; pebble geometry < ~1 m | the one material whose pattern reads at mid range; rebuild as a texture |
| SNOW | 790-808 | drifts, clumps, crystals, deep-tint SSS | crystals < 2-4 m | flat + glint is enough |
| GUNPOWDER, ASH | 809-857 | lumps, granules, charcoal flecks that "settle in hollows" | < 2-7 m | drop |
| WOOD (bark) | 858-943 + `woodPlates` 435-495 | Worley plates in a turned stretched lattice, meander, wave-warped furrows, crease fissures, flakes, fibres, and **end-grain growth rings with a 9-cell pith search** on top faces | plates < 11-21 m; ridges < 32-63 m; flakes/fibres/rings < 2-5 m | the relief on this costs 9 → 48 ms face-on (`detail.js:68`); drop to ridges + a texture |
| PLANT | 944-999 | Worley leaf ellipses with midribs, tilt, curl | leaves < 6-13 m, then flat 0.88 | the only branch with a LOD early-out (`surface.js:973`); still flat at play distance |
| METAL | 1000-1052 | brushed streaks (6.7 mm), grooves (2 mm), smudges, anisotropic GGX, hot mill scale with blisters | streaks < 2-4 m, grooves < 0.5-1 m | anisotropy + oxide keep; grooves never seen |
| CRYSTAL (fluorite) | `crystal.js` (280 lines) + `crystalLook` `surface.js:547-657` | hexagonal **quartz** prisms (the file admits fluorite is cubic, `crystal.js:3-7`), phantom zoning seen through refraction, luminescent-concentrator piping, per-face glow, 1.2 cm growth striations | striations < 3-7 m | the most over-built feature in the renderer for one element; also in the shadow pass (lib) |
| CLONE ("polished gold") | 1056-1071 | waviness + polish haze | haze < 4-7 m | TPT's Clone is a utility block; meanwhile `GOLD`, `NUGGETS`, `TITANIUM` are flat |
| WALL (concrete) | 1072-1111 | mottle, grit, 0.3 mm-deep bug holes, rain streaks | pits < 10-20 m, grit < 4-9 m | mottle only |
| ROCK, SANDSTONE, BASALT, LIMESTONE, COAL (CRAG) | 1112-1184 + `rockCrags` 380-434 | lumps, 3 octaves of warped crease noise, grit, rust/pale patches by sky-facing, flow banding, clustered vesicles | crags 34-69 m; vesicles < 3-6 m | reads at range, but close up it is uniform worm-track crease noise (`evidence/volcano-flank-rock.png`); keep the scale and the facing-based weathering, redo the pattern, drop micro layers |
| LAVA | 1185-1215 + consts 303-330 | churning skin fBm, Worley crust plates, crack widths by temperature, rim glow, far blend `eFar` | cracks < 7-14 m, then a flat blend | the crack look is right; Worley runs unconditionally |
| liquids | `liquidDetail.js` (426 lines) | gravity-capillary ripples to 1.7 cm with physical dispersion, a **2.7 mm meniscus** (Landau & Lifshitz), whitewater with Pilch & Erdman breakup and Monahan foam decay | ripples < 5-9 m; meniscus < ~1 cm per pixel | meniscus: nobody would miss it; whitewater: an extra sim pass per step (`gfx/foam.js`) |
| lone powder cells | `grains.js` clods | 4-lobe sphere-traced clods, 48 steps, smin + 2 noise octaves | < ~0.5 m (`CLODS_FADE_M`) | drop |
| flames/smoke | `media.js`, `mediaDetail.js` (194) | soot sheets, flamelets, Wrenninge MS octaves, flow-advected two-phase noise, 5 cm filaments | filaments up close | keep a simpler fire; drop filaments/flow noise |

Count: 13 branches covering 17 elements (12 single + 5 sharing CRAG), against ~90 drawable materials. Everything without a branch is
`ALBEDO(id)` and nothing else (`surface.js:662-667`), including all of Noita's liquids, brick, salt, clay,
mud, moss, fungus, ceramic, gold, titanium, tungsten, uranium.

### 2.3 What the player actually sees: LOD distances

`lodFade(f, fp)` starts fading at f·fp = 0.25 and is 0 at 0.5 (`surface.js:104-106`). At 1280×800 with the
app's 40° vertical FOV (`app.js:350`), a pixel is 0.00091 rad. The default god view of a 128³ box
(`app.js:477`: camera (11, 12, 13), target (0, 2.5, 0), box 10 units wide) puts the box's nearest corner
**39 m** away, the target 75 m and the far corner 103 m.

| feature (wavelength) | fade starts | gone |
|---|---|---|
| steel grooves (2 mm) | 0.5 m | 1.1 m |
| sand dark grains (4.4 mm) | 1.2 m | 2.4 m |
| sand grain mottle, steel streaks (6.7 mm) | 1.8 m | 3.7 m |
| wood fibres / flakes / end-grain rings | 1.6-2.4 m | 3.1-4.9 m |
| snow crystals, gunpowder granules | 2.2-2.4 m | 4.4-4.9 m |
| rock vesicles (1.1 cm), fluorite striations (1.2 cm) | 3.1-3.3 m | 6.3-6.6 m |
| CLONE polish haze, ash flecks (1.3 cm) | 3.6 m | 7.1 m |
| water capillary ripples (finest, 1.7 cm) | 4.7 m | 9.3 m |
| concrete grit (1.6 cm), rock grit (1.8 cm) | 4.4-4.9 m | 8.8-9.9 m |
| plant leaves, sand clumps, rubble small chips, lava cracks | 6.4-6.9 m | 12.8-13.7 m |
| concrete pits / rain streaks | 8.8-9.9 m | 17.6-19.8 m |
| wood bark plates | 10.6 m | 21.1 m |
| rubble big chips | 15.1 m | 30.2 m |
| wood fissure ridges | 31.7 m | 63.4 m |
| rock crags (1st octave) | 34.3 m | 68.7 m |
| steel smudges, sand slumps, concrete mottle, rock lumps | 63-137 m | 126-275 m |

So at the default view (39-103 m), only the last two rows draw anything. Phones render at half resolution
('performance' upscale, `app.js:151`), which halves every distance above. The bespoke code is a POV-mode
feature that runs everywhere: `mCell` (27 `hash33` + compare) runs whether or not its output survives LOD for
STONE ×2 (`surface.js:749-750`), WOOD (`surface.js:480`) and LAVA (`surface.js:1196`); `mDots` and the `vnoise`
streaks/tints run unconditionally; `mFbmD` only skips octaves after the first fades.

### 2.4 Inconsistent lighting models (one scene, ten answers)

| # | where | model |
|---|---|---|
| 1 | `shadeSurf`, `surface.js:1688-1795` | GGX + Fdez-Agüera multiple scattering + Oren-Nayar (rough > 0.45) + wrap SSS + leaf transmission + glints + split-sum env (L1 SH, sharp sky where probes say open) + Lagarde spec occlusion + near-field GI rays or AO + glow-light RIS + lamps + cavity |
| 2 | `shadeFloorFw`, `surface.js:1855-1874` | Lambert only (no specular on a "weathered concrete" floor), its own AO (min of face and field AO), the full near-field GI, glow-light RIS and lamps |
| 3 | `reflShade`, `liquid.js:142-153` | `ALBEDO(id)` × (sun + probe + glow) + `emission(id, T)`: no texture, no AO, no specular, bulk temperature, emissivity 1 |
| 4 | near-field hit, `lighting.js:697-713` | `ALBEDO(hid)` × (sun + probe + glow) + `cellEmission` (skin temperature, emissivity 1) |
| 5 | liquid/glass interior, `liquid.js:47-61` | `skyAmbient(up)·gSkyIn·mix(0.25, 1, sunVis) + sunCol·sunVis·sun.y·0.6 + glow`: two hand constants (`SKY_IN_FLOOR`, `SUN_IN_GAIN`) |
| 6 | media, `media.js:181-273` | dual-lobe HG + 3 Wrenninge octaves + one self-shadow sample + `0.5·(skyAmbient(up)·skyT + skyAmbient(down))` + glow·0.25 |
| 7 | liquid/glass surface reflection, `liquid.js:16-31` | sky + a Phong-like `pow(r·sun, 400)·6` sun glint, not GGX |
| 8 | plain view, `plain.js:43-60` | its own sun (1.25, 1.15, 1.0), its own two-colour sky, its own glow curve (T/1800 K)^4, its own ACES in-shader |
| 9 | data views, `render.js:326-337` | "clay": 0.45 + 0.41·n·l + 0.21·sky, corner AO |
| 10 | the sky you see in box mode, `post.js:232-244, 915` | the page's CSS navy gradient (#232b3a → #0e1117), while 1-7 are lit by an analytic daylight sky (`gfx/sky.js`, sunTOA 1.5, multi-scatter ×2) |

Emission alone has four versions: `hotEmit` (skin drop × cavity, emissivity from albedo; `surface.js:282-286`),
`cellEmission` (skin drop, emissivity 1; `materials.js:540-541`), `emission(id, T)` (bulk T, emissivity 1;
reflections, interiors) and lava's own crust/melt blend (`surface.js:1203-1208`). Bug B2 below is what that
does on screen.

### 2.5 Noise and shimmer (things that only work because TAA averages them)

| source | where | per-frame signal |
|---|---|---|
| glow lights (lava/fire as shadowed lights) | `lighting.js:743-780` | the glow volume is multiplied by **either 0 or 2·n·l** per pixel per frame: one Bernoulli shadow ray to a randomly picked brick. With TAA's stable weight 0.07 (`post.js:195`) that leaves about ±20 % frame-to-frame flicker (EMA std √(0.07/1.93) of a Bernoulli with p ≈ 0.5) in every lava-lit area |
| near-field GI ("Contact Shadows", default on) | `lighting.js:673-717` | 2 random rays per pixel per frame, hits fade by distance; 1-bit-ish AO noise |
| PCSS | `lighting.js:368-401` | 8+8 Vogel taps rotated by IGN per frame |
| media | `media.js:50, 215-273` | **1 sample per cell** (MEDIA_STEP 1.0), jittered per frame; `DETAIL_MEDIA_STEP` adds near-camera samples |
| liquid id dither | `render.js:748, 803` | ±0.5 cell random offset per pixel per frame where liquids mix |
| glints | `surface.js:1587-1651` | ~2 px facets on a world lattice whose level tracks the footprint; TAA jitter moves samples across facets: twinkle by design |
| PCSS hard-edge fallback | `lighting.js:385-391` | an exact DDA sun ray per shadow-edge pixel (cost spike, not noise) |

The TAA clamps history to the 3×3 YCoCg box (`post.js:393-413`), so high-variance inputs keep some of their
noise and sparse ones (glints, glow-light hits) flicker rather than converge. Each estimator also burns
traced rays to produce a value the next frame half-overwrites.

Measured (see "Evidence"): in the **sunlit god view** the stochastic terms are visually quiet: two
consecutive raw frames (TAA off) of `lab-home` differ by a mean 0.15/255, 0.1 % of pixels by more than 16
levels. So the daylight god view pays for those rays and gains little from them. The noise shows where the
estimators matter: close up through water (`lab-tank`: a 2-3 px salt-and-pepper band along the oil/water
interface and around a shadow on the tank floor after 4 TAA frames, `evidence/lab-tank-fringe.png`,
`evidence/lab-tank-floor.png`), and by construction in lava-lit and cave scenes (glow-light RIS, near
field). Close up it's measurable: on the volcano flank at 5.8 m, raw consecutive frames differ by 1.60/255
mean with 2.3 % of pixels over 16 levels (10× the god view), and consecutive TAA frames still by 0.83/255.
Either way the default path spends rays where they barely show and is noisy where they do.

### 2.6 Magic numbers and fudge stacks

- 1,070 named constants in the realistic module. Many cite papers (Hunter 1977 on grain-flow tongues, Shepard
  2001 on lava roughness, Ryan & Reinhardt 1988 on bark thickness, Monahan 1971 on foam decay, Pilch & Erdman
  1987 on droplet breakup, Landau & Lifshitz for the meniscus), which gives false rigour. **The physically
  exact layers then get multiplied by game gains** that undo the physics:
  `LAMP_ROOM_GAIN 12` (`materials.js:76`), `TORCH_SHED 20`, `EMBER_SHED 10`, `CRYSTAL_SHED 0.6`
  (`materials.js:106-108`), `THIN_BODY_CELLS 24` (`liquid.js:72`: every drop drawn as 7 m of water),
  `SUN_GLINT_GAIN 6`, `FLAME_RADIANCE 3`, `FLAME_SOOT_DT 1000 °C`, `BLOB_PEAK 1.8`, `SKY_IN_FLOOR 0.25`,
  `SUN_IN_GAIN 0.6`, `LOCAL_AO_MIN 0.35`, `SUN_CAV_MIN 0.5`, `LEAF_TRANS_GAIN 1.6`, `GLOW_SCATTER 0.25`,
  `SKY.multi 2.0`, `INCAND.GAMMA 0.35`. The repo comments say these were tuned in specific scenes
  ("Tuned in the Descent's caves"), and they fight each other: the glow volume is too blurry to light
  anything (`materials.js:96-103` says a torch lit "~1/1700 of its radiance"), so sources are boosted ×10-20,
  and then glow-light RIS (2.5) adds shadowed-ness back with Bernoulli noise.
- Exposure is +0.7 EV with look 0.5 "to reproduce the old in-shader ACES" (`post.js:98-103`). Then AgX gets
  a Punchy power/saturation blend (`post.js:771-787`) and a third tone curve for warm saturated pixels
  (`post.js:797-818`). Three tone curves to recover a look that was never chosen on purpose.
- Two flavours of the same constant everywhere: `PI_S`, `PI_L`, `LUMA_W`, `LUMA`, `DECO_LUM`, `LUMA_709`, ACES
  written twice (`render.js:179-187` for the plain view, and the probe stand-ins in `surface.js:1909-1916`)
  while the realistic view tone-maps with AgX in post, `skyAmbient` versus probes versus `FU.skyUp`.

### 2.7 Features nobody would miss (or that don't exist)

- **Heat shimmer that does nothing**: `hazeBend` returns `rd` unchanged (`media.js:206-210`), yet the tracer
  calls it first thing with the comment "hot air bends light (heat shimmer): perturb the ray once"
  (`render.js:778-779`).
- `albedoOf` (`surface.js:1224-1226`): dead.
- 2.7 mm meniscus, capillary ripple octaves 3-5, concrete bug holes 0.3 mm deep, steel grooves, bark fibres
  and flakes, wood end-grain rings, sand dark mineral grains, ash charcoal flecks gathering in hollows,
  fluorite phantoms, striations and light piping, mill-scale blisters, single-cell clods. All are below
  3-7 m (2.3).
- Night-vision tube simulation with shot-noise grain and a phosphor (`post.js:851-862`): fine as a perk, but
  it lives in the hot composite shader.
- A whole second renderer (plain view, `plain.js`, 280 lines with its own lighting) kept for "the original
  look" and as the cheap test view. In v2 it should be either *the* stylised mode or gone.

### 2.8 Complexity per pixel, and compile cost

A sand pixel in the default settings (Balanced, near GI on), counted from the code:

- **march**: per visited cell, 1 brick-info read on brick change + 1 `fetchA` + in surface bricks 1-3
  `surfSample` (each 1 trilinear tap, +1 thin-mask tap, +8 cubic taps in the band) + 5-step regula falsi
  per crossing channel.
- **hit record**: `gatherSurf`: 8 `fetchA` + 8 `cellFlow` reads (granular channel); then `gatherMat` × up to 2 elements × up to
  2 flow layers = **up to 4 `matOf`** (`surface.js:1256-1268, 1363-1368`); sand's `matOf` is ~7 `mNoiseD`
  (8 `hash13` each) + 1 `mDots`. `surfNormal`: 4 `surfChannel`.
- **shading**: `fieldAO` (3 field taps + 3 `fetchA`) **thrown away when near GI is on** (B5); `sampleLight` +
  wand loop; `sunShadow` (cloud test + 4 loads, + 16 PCSS taps or a DDA at edges); `surfProbe` (4 taps);
  `nearField` (2 DDA rays ≤ 48 steps, each hit: 4 shadow loads + 4 probe taps + 1 light tap);
  `glowLightScale` (6 random brick reads + a ≤ 48-step DDA); `glintSpec` (2 facets); lamps (≤ 4 DDA rays).
- **Wasted for the floor seen in water or glass**: `reflectTrace` shades a floor hit with `shadeFloorFw`
  (`liquid.js:221-225`), which runs the full near-field GI, glow-light RIS and lamps a second time, while every
  other reflected hit gets the cheap `reflShade`.

Compile: the realistic module is a single fragment entry of ~5,400 lines, everything inlined (the code is
shaped around this: "one call site per expensive function", `render.js:764-767`, `surface.js:1253-1255`).
Another session's perf audit reported the WebGL view at ~8 s cold on Metal (`maps/external-perf-audit.md`, unverified here); here SwiftShader
builds relief/grains variants in 9-13 s and then crashes compiling them at first draw
(`render.js:1582`, `detail.js:104-111`). There are 2 realistic variants per grid (base/near gate) × 1024
detail combinations validated by `material-lod-check`. That's testing cost created by the feature matrix.

---

## 3. Concrete visual bugs (with evidence)

Severity is for v2 planning: **high** = visible in the default scenes, **medium** = visible in common
situations, **low** = correctness or cost, rarely visible.

- **B1 (high). The sky you see isn't the sky that lights the scene (box mode).** The backdrop is the page's
  CSS gradient, navy #232b3a → #0e1117, drawn in the canvas composite (`post.js:232-244`, `post.js:915`
  `o += (1.0 - a) * sky(uv)`). The scene is lit, reflected and bounced by an analytic daylight sky
  (`gfx/sky.js`, `lighting.js:112-137`, used by `envReflect`/`envReflectGI` `liquid.js:21-31` and
  `shadeSurf` `surface.js:1774`). Water, glass and metal mirror a bright blue sky that isn't on screen,
  sunlit ground sits in a night-coloured void. Shots: `shots-64/lab-home.png` (metal plate reads sky-blue
  against the navy backdrop), `docs/hero.jpg`, `docs/arenas-dam-valley.jpg`.
- **B2 (medium). Hot matter glows 3-6× brighter in reflections than in direct view.** Direct view:
  `hotEmit` uses the skin temperature `T - 200·cav` and emissivity `1 - reflectance` (`surface.js:282-286`);
  lava uses its crust/melt blend (`surface.js:1203-1208`). Reflections: `reflShade` adds
  `emission(id, a.y)`, bulk temperature, emissivity 1 (`liquid.js:152`). Liquid interiors use the same
  (`liquid.js:59-61`); near-field bounce uses yet another (`cellEmission`, `lighting.js:703`). With the
  game's incandescence table (`gfx/incandescence.js`, evaluated with `v2/` node), a 200 °C skin drop is a
  luminance ratio of 5.7× at 800 °C, 4.3× at 900 °C, 3.4× at 1000 °C, 2.5× at 1200 °C, before the
  emissivity factor (up to 2× for pale rock). Lava with a cold crust next to the sea (the volcano preset)
  can reflect as fully molten where the reflection is traced (grazing views, `liquid.js:130-131, 248-249`).
- **B3 (medium). Coloured transmittance becomes grey.** The volume writes alpha = 1 − mean(trans)
  (`render.js:1138`), and the scene behind (the backdrop, the far field, three's meshes the march was cut at)
  is attenuated by that grey alpha. A red mesh under 3 m of water keeps its red dimmed instead of going dark
  teal; the sky through a tank isn't tinted. The volume-render map flagged this (`maps/volume-render.md`
  §5.7) and the port kept it (`docs/webgpu.md` F1).
- **B4 (medium). Lava light flickers.** `glowLightScale` returns 0 or 2·n·l from one random shadow ray per
  pixel per frame (`lighting.js:743-780`), multiplied into all local glow. At TAA weight 0.07 that is about
  ±20 % frame-to-frame. Near-field GI and PCSS add their own per-frame noise (2.5). Measured raw versus TAA
  frame differences are in "Evidence".
- **B5 (low, cost). Near GI throws away the AO it made.** `shadeSurf` computes `fieldAO` (3 field taps + 3
  `fetchA`) or `faceAO` (8 `fetchA`) at `surface.js:1693`, then with `FU.nearGI` (on by default,
  `app.js:140`) replaces both its uses at `surface.js:1778-1782`. Every shaded pixel pays for it.
- **B6 (low, cost + inconsistency). The floor in a reflection is lit by the most expensive model in the
  shader.** `reflectTrace` shades a floor hit with `shadeFloorFw` (`liquid.js:221-225`): PCSS sun, near-field
  GI (2 more DDA rays), glow-light RIS (another DDA), lamps. Any other reflected hit gets `reflShade`
  (albedo × irradiance, no texture). Inside a glass tank the floor in the reflection is better lit than the
  sand next to it.
- **B7 (low). Leaving a liquid or glass drops the reflected energy.** `liquidInterface` on exit does
  `trans *= 1 - F` and adds nothing for the internally reflected part (`liquid.js:257-268`); every exit face
  darkens what's behind it slightly, more at grazing angles.
- **B8 (low). Heat shimmer is advertised but not there.** `hazeBend` returns `rd` (`media.js:206-210`), called
  at `render.js:779` under a comment that says it bends the ray.
- **B9 (design bug). Drops and streams are drawn as 7 m of water.** `THIN_BODY_CELLS = 24`
  (`liquid.js:63-77`): wherever the thin mask is set, absorption runs as if through 24 cells, so a pour is a
  saturated teal ribbon whose colour jumps where the thin mask ends, at the pool it falls into. A
  readability hack standing in for an art decision.
- **B10 (identity bug). Same material, different look.** `CLONE` and `GOLD` share the albedo
  (`materials.js:237, 302`) but only Clone has the "polished gold" branch
  (`surface.js:1056-1071`). `SCRAP`/`NUGGETS`/`TITANIUM` are steel- and gold-coloured but untextured, so they
  read as plastic next to textured `METAL`.
- **B11 (identity bug). Phones get a different game.** `MOBILE_DEFAULTS` (`app.js:149-153`) switch off near GI,
  glow lights, caustics and every close-up feature and render at half resolution. The iPhone build looks
  materially different from the Mac one (lava light unshadowed and leaking through walls, no contact bounce,
  no caustics), because the default look was never budgeted for it.
- **B12 (UI naming).** The near-field GI switch is labelled "Contact Shadows" (`app.js:1184`). It's
  traced bounce light plus AO.

---

## 4. What is genuinely good and worth keeping

Engine and principles (keep as is, or nearly):

1. **Brick-skipping DDA with an empty-distance field** (`core.js:69-109`, `skipEmpty`): crosses whole empty
   regions in one step. That's the right traversal for the primary rays and every secondary walk.
2. **One shading call site after the march** (`render.js:1092-1132`): the march records a hit; materials and
   lighting are compiled once. Keep the discipline, and move it to a wavefront split (march kernel → hit
   buffer → shade kernel) in v2.
3. **Footprint-based LOD** (`surfView`, `footprint`, `lodFade`, `surface.js:85-106`) and the analytic floor
   `fwidth` (`surface.js:1797-1849`): correct anti-aliasing without derivatives in divergent code. In v2 a
   texture with mips does this for free; the idea carries over to procedural fallbacks.
4. **World-anchored texture space** (`worldPos`, `core.js` ddaGLSL): textures don't swim when the world window
   moves. Keep.
5. **Materials as a data table** (`materials.js` LOOKS, `MATERIAL_FIELDS` → one GPU struct per element) with
   sourced albedos (USGS, measured metal F0). Extend it into the whole material definition (palette +
   texture-family index), so shaders stop branching per element.
6. **Liquids as Beer-Lambert media with per-element extinction and scattering** (`liquid.js:79-84`, LOOKS
   `scatter`): water, oil, acid, blood and potions get their colour from data. Cheap and correct.
7. **Coloured, translucent shadow map** (`lighting.js:139-161, 312-402`: depth, translucent span, tint id +
   optical depth): sunlight through water and glass comes out tinted and dimmed, and the analytic caustics
   (`lighting.js:183-234`, Laplacian of the ripple height) are cheap and look right.
8. **Blackbody incandescence with compressed brightness** (`gfx/incandescence.js`): hot steel goes dull red →
   cherry → orange → white as it should, lava cracks glow. One table, used everywhere. (Fix B2, keep this.)
9. **L1 SH probes at brick resolution** (`lighting.js:453-511`): cheap, stable diffuse sky + bounce, with sky
   visibility that keeps caves dark and lets water reflect a cave instead of the sky. The strongest candidate
   for v2's single indirect term.
10. **Crisp voxels bevelled only where exposed** (`surface.js:1441-1475`): a wall of voxels reads as one slab
    with rounded outer edges. Cheap, and the right direction if v2 shows voxels.
11. **Rock designed at the scale the player sees** (CRAG family: lumps, crags, sky-facing pale patches, rust,
    banding; crags read to ~35-70 m). Keep the scale and the weathering-by-facing idea, not the pattern: up
    close the crease noise reads as uniform worm tracks (`evidence/volcano-flank-rock.png`), with no ledges,
    strata or fractures.
12. **Glints sized to the pixel** (`surface.js:1587-1651`): sand and snow sparkle at any distance. Keep the
    idea, make it temporally stable (hash on the facet, not on the jittered sample).
13. **Post** (`post.js`): AgX, histogram eye adaptation that only brightens, energy-conserving bloom,
    TAA/TAAU with depth reprojection, CAS. Solid; v2 should keep it and drop the stacked look curves (2.6).
14. **Data views** (heat, pressure, flow, X-ray, `render.js:203-722`): this is TPT's identity and they read
    well (clay lighting, legend-exact colours). Keep, as cheap modules of their own.
15. **The mesh cut** (`gfx/meshCut.js`, `render.js:806-861`): bodies standing in water are drawn behind the
    water, not over it. Keep (and fix B3 so the tint is right).
16. **Kirchhoff emissivity idea** (`glowAt`, `surface.js:273-285`): pale rock glows less than black crust. One
    line; keep it and use the same function everywhere.

---

## 5. How the touchstones get their look (briefly)

- **The Powder Toy**: one cell = one screen pixel, a flat colour per element plus a little per-particle colour
  jitter; glow is a separate blurred additive "fire" buffer; display modes (heat, pressure, velocity,
  persistent) are cheap full-screen variants. Cost ≈ 0, instant readability: you know what every pixel is.
- **Noita**: one cell = one pixel (scaled up). Many materials sample a small authored texture tiled in
  world space (brickwork shows as bricks, ores and gold have their pattern), others are per-pixel colour
  variance; a few hand-picked effects (liquid shimmer/refraction, glow, fog of war, a 2D light map from
  emitters). Strong palettes do the work; nothing is physically derived.
- **Minecraft**: the voxel is the brand. 16×16 nearest-filtered textures per block face, smooth lighting from
  per-vertex AO and a flood-filled sky/block light (0-15), fog, no real-time shadows in vanilla. A texture
  language at block scale, readable from any distance.
- **Teardown**: 10 cm voxels with a palette per object (colour, roughness, emissive, a material type), small
  per-voxel colour noise, raymarched volumes into a G-buffer. Materials are trivial; **the lighting does the
  work** (soft shadows, AO, reflections, volumetric fog, all noisy and temporally denoised, plus bloom/DOF).

All four keep material identity cheap, authored and data-driven, at the scale of the cell or bigger, and
spend their complexity (if any) on one global lighting solution. Powder Toy 3D does the opposite: per-element
procedural micro-geometry at 1/50 of a cell, and several overlapping, partially stochastic lighting systems.
The closest fit for a 30 cm-cell 3D sandbox is **Teardown's split** (honest voxels with palette colour + good
shared lighting), with **Noita's world-space material textures** at a scale of a few texels per cell (2-8 px per
cell at god view), and **TPT's data views** as they are.

---

## 6. What this means for v2 (direction, not design)

1. **Decide the voxel's role.** Either show cells (bevelled voxels, per-cell colour variation from the seed,
   like Teardown/Minecraft) and smooth only liquids and lava, or keep smoothing but with a much smaller
   radius so piles and walls keep edges. Today's sigma 0.6-1.0 blur + trilinear isosurface is the clay.
2. **One material function, no per-element branches.** A palette entry per element (2-4 tone variants,
   roughness, metal, emissive, glint, translucency, texture family) and one world-space texture array with
   mips, sized so it reads at the god view (a few texels per cell) and at POV. Bake today's best procedural
   patterns (rock crags, rubble chips, bark ridges, lava cracks, leaves) into it offline. One
   `textureSampleGrad` replaces `matOf` (~560 lines) and the 27-neighbour Worley loops, and the hardware mip
   chain replaces `lodFade`.
3. **One lighting function used everywhere**: sun (shadow map + fixed small PCF, no PCSS, no exact edge ray)
   + SH probe irradiance with sky visibility + cheap per-voxel corner AO + emissive via the probes/light
   volume, with one emission function. Surfaces, floor, reflections, bounce and liquid interiors all call it.
   Drop the Bernoulli estimators (glow-light RIS, near-field rays) from the default path. Make the default
   the iPhone budget and add extras above it, not the reverse.
4. **Show the sky you light with** (or light with the sky you show): one sky for backdrop, reflections and
   ambient. A chosen art-directed sky (time of day, colour grade) beats a physical one nobody sees.
5. **Budget per pixel and per module.** A realistic module of ~1-1.5k lines, per-view modules that paste only
   what they call, a wavefront split so the march kernel stays small, fp16 shading as an optional fast path.
   Texture noise instead of ALU hash noise (`mNoiseD` is 8 `hash13` per octave).
6. **Keep the list in section 4.**

---

## 7. Evidence

### 7.1 How the shots were made

The read-only checkout can't boot (its `node_modules` lacks `fengari`, so Vite fails on `src/console/lua.js`
and `tools/smoke.mjs --stage boxes --views realistic` dies at boot: `v2/smoke-render.log`). I exported
HEAD 42f4039 to `v2/tree/` (`git archive`, hard-linked `node_modules` + `fengari` from `/home/user/wt/U13`) and
rendered with my own script `v2/shots.mjs`, which uses the repo's `launchBrowser`/`newTestPage` (manual mode)
and `startVite` (own port, strictPort), hides the UI, places the camera in grid cells and renders with
`__app.test.renderOnce`: TAA reset, 4 accumulated frames, then a screenshot (a full `test.render()` converge
didn't finish inside the 10-minute browser lifetime). 64³ grid (so cells are larger on screen than at 128³),
400×250, SwiftShader on a 4-core box at load average 16-26 shared with other sessions. Settings: defaults
(Balanced detail; relief/grains are off on a software adapter anyway, `detail.js:104-111`), sun (0.70, 0.71,
−0.09), near GI and glow lights on. Log: `v2/shots-64/log.txt`.

Caveat: the shots are 250 px tall, so a pixel is 3.2× wider than in the 800-px table of 2.3, and every
fade distance there is 3.2× shorter in these shots. Caveat: 4 TAA frames also means only ~4 GI updates (half the probes per frame, EMA): ambient in the shots is
lower than in a long session, so shadows read darker here than in play. I don't attribute anything to that.

### 7.2 Shots and what they show

| shot | what it shows |
|---|---|
| `shots-64/lab-home.png`, zoom `evidence/lab-home-zoom.png` | Default god view of the Lab (eye 37 m from target). The hanging sand block is a **rounded beige marshmallow**, no grain or clump visible; the wood tower a **rounded tan pillar**, no bark; the metal plate a **sky-blue tile** (it mirrors the analytic sky) under a **navy backdrop** (B1); the glass tank barely there, water clear, oil a brown slab; a teal patch on the floor beside the tank (the tinted sun through the water). Flat clay primitives on a tiled floor in a dark void. |
| `shots-64/lab-home-raw.png`, `evidence/lab-home-raw-zoom.png` | Same frame with TAA off: jaggies everywhere, otherwise the same image. Raw consecutive frames differ by 0.15/255 mean, 0.1 % of pixels > 16 levels; consecutive TAA frames 0.40/255, 0.3 % > 8. |
| `shots-64/lab-tank.png`, `evidence/lab-tank-2x.png` | The tank from the side, 6.7 m (through its glass wall). Everything is one teal haze; the oil layer is an opaque brown plank across the top; the wood tower behind the tank shows bark ridges (the 15 cm fissure layer, which survives to ~10-20 m at this resolution). A 2-3 px **speckled band** along the oil/water boundary (`evidence/lab-tank-fringe.png`) and a **bright ragged speckled rim** around a shadow on the tank floor (`evidence/lab-tank-floor.png`) after 4 TAA frames; cause not isolated (candidates: liquid-id dither `render.js:803, 1007-1009`, the translucent span of the shadow map at the glass/water boundary, caustic gain, PCSS doubling `lighting.js:401`). Cost: 4 TAA frames took 965 s against 203 s for the god view of the Lab at the same resolution (4.8× per frame). The god view covers only ~25 % of the frame with the box (76 % of its pixels are backdrop-coloured), so per covered pixel the water view is roughly 1.3-2× (fixed per-frame passes and the shared machine's load blur it). Treat this as a weak signal. |
| `shots-64/volcano-home.png`, `evidence/volcano-home-zoom.png` | Default god view of the Volcano. Rock is a **smooth chocolate-pudding dome** with faint mottling (only the crag/lump octaves survive at 37 m); the snow cap a **cotton-wool blob**; trees **green lollipops** on dark sticks with very dark shadows; the summit's lava source block a **glowing yellow candle** with bloom. |
| `shots-64/volcano-flank.png`, `evidence/volcano-flank-pair-2x.png` (left TAA, right raw), `evidence/volcano-flank-rock.png` | The flank from 5.8 m, the closest thing to a POV view. The CRAG rock is a **uniform worm-track / brain-coral pattern** of crease-noise hollows over a perfectly smooth silhouette (bump only: relief is off on a software adapter, and off by default on a real one, cost "high"): no ledges, strata, fractures or large-scale colour, the same squiggle at every point. The trees are **glossy green gumdrops** (leaves are below LOD at this resolution) on bark-textured sticks. A lone granular cell is a **beige ping-pong ball**. The snow cap is cotton wool. Raw consecutive frames differ by **1.60/255 mean, 2.3 % of pixels by more than 16 levels (10× the god view)**; consecutive TAA frames by 0.83/255, 0.7 % > 8: close up, the stochastic terms are visible as shimmer. |
| `evidence/volcano-flank-snow-raw.png` | One raw frame of the snow cap: per-pixel blue-grey speckle (near-field/PCSS noise on a bright white surface) and isolated white glint dots. That is what TAA has to clean every frame. |
| `evidence/volcano-sea-zoom.png` | The sea: grey-green mottled with bright specks, reads as **wet terrazzo**, not water (sun glints and ripples at 64³ over a 4-cell-deep sea showing the grey floor). |
| `docs/hero.jpg` (README, real GPU, the WebGL build) | Same story at 128³ on a real GPU: brown clay cone, green balls for trees, fire as glowing orange balls, sparkly turquoise sea, navy void. |
| `docs/arenas-dam-valley.jpg` (real GPU) | Flat plastic-green `PLANT` grass next to fully textured crag walls (2.3: leaves are gone past ~13 m); broccoli trees; a pitch-dark interior corridor. |
| `evidence/regress-montage.png`, `evidence/u8-real-montage.png` | Earlier sessions' shots in this container (U8): the plain view's cubes, and realistic Lab/Volcano frames at three suns (sand block with a black speckled top, black metal plate: probably unconverged GI after 3 frames, so not used as evidence of a bug). |

### 7.3 Numbers

- Module sizes, `const` count, call sites: section 1 (from `v2/size.mjs`).
- LOD fade distances: section 2.3 (from `lodFade`, `CELL_M`, the 40° FOV at 800 px).
- Glow luminance ratio across the 200 °C skin drop (bug B2): 800 °C 5.7×, 900 °C 4.3×, 1000 °C 3.4×,
  1200 °C 2.5×, 1500 °C 1.9× (the incandescence table from `gfx/incandescence.js`, evaluated in node).
- Per-feature GPU cost on an M-series laptop at 1280×800, from the repo (`detail.js:61-101`): relief
  9 → 48 ms (a bark wall face-on), grains +17 ms, clods +14 ms, smoke filaments +16 ms, flow smoke +5.9 ms,
  whitewater 1.4 ms + ~0.4 ms per sim step.
