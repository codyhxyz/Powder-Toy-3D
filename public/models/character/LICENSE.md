# body.glb

**Superhero Male** from **Universal Base Characters** (Standard, free tier) by **Quaternius**:
his mesh, 65-bone humanoid rig, and his skin, eye and eyebrow textures. Played by 8 clips from
Quaternius's **Universal Animation Library** (Standard, free tier), retargeted onto his skeleton.

- Universal Base Characters: https://quaternius.com/packs/universalbasecharacters.html
  (download: https://quaternius.itch.io/universal-base-characters,
  `Universal Base Characters[Standard].zip`, `Base Characters/Godot - UE/Superhero_Male_FullBody.gltf`
  with its .bin and textures, and `Base Characters/Textures/T_Superhero_Male_Ligh.png`)
- Universal Animation Library: https://quaternius.com/packs/universalanimationlibrary.html
  (download: https://quaternius.itch.io/universal-animation-library,
  `Universal Animation Library[Standard].zip`, `Unreal-Godot/UAL1_Standard.glb` and `UAL1_Standard_RM.glb`)
- License (both): **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/
  Free to use in personal, educational and commercial projects. Credit is not
  required. Thank you, Quaternius (https://www.patreon.com/quaternius).

## What's in this file

Built by `tools/character-pack.mjs`:

| Clip | Source clip |
|---|---|
| idle | Idle_Loop |
| walk | Walk_Loop |
| jog | Jog_Fwd_Loop |
| sprint | Sprint_Loop |
| fall | Jump_Loop |
| swim | Swim_Fwd_Loop |
| tread | Swim_Idle_Loop |
| death | Death01 |

Each clip is retargeted from the animation library's mannequin to the superhero's rest pose (every
bone gets the same world-space turn off its rest pose; the hips' moves and the clip's ground speed,
`extras.speed` in metres per second, scale by his hip height). Kept: the first UV set, the albedo
maps (1024² skin, 128² eyes, 256² eyebrows) and the skin's normal map (1024²), as WebP. The
boxers are dyed purple: where the pack's black-boxers and white-boxers skins differ, the white
cloth's shading times the hat's purple. Dropped: the roughness map, the eyes' and eyebrows' normal
maps, the other UV sets and the vertex colours. The file is compressed with
`EXT_meshopt_compression` by `tools/character-compress.mjs`.
