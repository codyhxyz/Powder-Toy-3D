# mannequin.glb

**Universal Animation Library** (Standard, free tier) by **Quaternius**:
the mannequin mesh, its 65-bone humanoid rig, and 8 of its clips.

- Source: https://quaternius.com/packs/universalanimationlibrary.html
  (download: https://quaternius.itch.io/universal-animation-library,
  `Universal Animation Library[Standard].zip`, `Unreal-Godot/UAL1_Standard.glb`)
- License: **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/
  Free to use in personal, educational and commercial projects. Credit is not
  required. Thank you, Quaternius (https://www.patreon.com/quaternius).

## What's in this file

Built by `tools/character-pack.mjs` from `UAL1_Standard.glb` (and its root-motion
twin `UAL1_Standard_RM.glb`, which is used only to measure each clip's ground speed):

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

The UV sets, the other clips and the tracks that never leave their rest pose are
removed. Each clip's `extras.speed` is its root's ground speed in metres per second.
