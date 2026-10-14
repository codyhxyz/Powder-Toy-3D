# Cruelty Squad target-elimination mode

Public mode key: `crueltySquad`. Only maps explicitly listing this mode **and**
passing `validMission(map.mission)` are eligible (menu, URLs, `openMap`). Existing
procedural maps are not missions and are not presented as Paradise.

## Rules and sources

Retrieved 2026-10-14 from the Cruelty Squad wiki using its MediaWiki API:

- [Game Mechanics](https://crueltysquad.fandom.com/wiki/Game_Mechanics), Gameplay:
  "find and kill the designated targets, then leave the level by walking to an
  EXIT area"; targets are indicated on the HUD and may have hostile guards.
- Game Mechanics, Death: "restart at the beginning of a level", no quick-saves
  or checkpoints.
- [Missions](https://crueltysquad.fandom.com/wiki/Missions): assassinate the target
  or targets, then leave through the designated exit; death loses the attempt.

This mode implements that objective loop, not the original game's economy,
implants, difficulty progression, or negative-health death grace period. There
is no time limit, team score, target respawn, timed player respawn, or automatic
next mission. Existing body/combat physics determine death. Any death cause
counts for a designated target; guard deaths do not count. Death on the same
frame as extraction fails. Retry reloads the whole authored map via `openMap`.
Leaving first person leaves the mission for Sandbox.
The player starts with a pistol and SMG. The normal tool menu is disabled.
Leaving restores the previous tool selection and restrictions.

## Authored map contract

`maps.js` stays import-free. An importer must supply a real map registration
(with its matching preset/scene, size, collision and thumbnail) and this data:

```js
{
  key: 'imported-map-key',
  modes: ['crueltySquad'],
  mission: {
    id: 'authored-mission-id',
    name: 'Authored mission name',
    spawn: [x, y, z],
    spawnYaw: authoredYawRadians, // optional; Godot/Three forward is -Z
    targets: [
      { id: 'unique-target-id', name: 'Target name', at: [x, y, z] }
    ],
    guards: [
      { id: 'unique-guard-id', name: 'Guard name', at: [x, y, z], weapons: ['GUN'] }
    ],
    extraction: { at: [x, y, z], radius: positiveCells, height: positiveCells,
      bounds: { min: [x0, y0, z0], max: [x1, y1, z1] } },
    // Optional: all normal eligible source exits; either exit completes.
    extractions: [firstAuthoredExit, secondAuthoredExit]
  }
}
```

Coordinates are **feet, world cells**, not model units or centered mesh
coordinates. Box maps have zero origin; windowed maps subtract `sim.origin`.
Target/guard IDs must be unique across both lists. At least one target is
required; `guards: []` is valid. Authored extraction bounds take priority.
Completion requires player-body overlap, like the original Godot Area.
Non-box triggers also supply source convex projection `axes` and `points`.
The controller uses SAT; the marker uses the same convex shape.
Without bounds, extraction uses horizontal radius and vertical tolerance.
Author these clear of walls and
on accessible collision surfaces; the adapter never invents/relocates spawns.

Actors optionally support `style: 'axeman' | 'gunner'`, `passive: boolean`, and
`weapons: [...]`. Targets default passive/unarmed; guards default hostile with
`GUN`. Allowed tools: `AXE`, `GUN`, `SMG`, `SNIPER`, `ROCKET`, `LASER`. Existing NPC
appearances/AI are reused rather than claiming to reproduce imported character
models. Imported geometry must have simulation collision, not just visual
meshes: current player/NPC probes are simulation-cell based. Streamed worlds
also need the initial window to cover the authored spawn. Mode entry focuses
streaming on that spawn before entering. Actors outside resident cells remain
dormant at their authored positions. Window shifts move their coordinates
and invalidate local navigation goals.

## Integration and CPU checks

- `app.startMode` resolves eligibility, enters POV, calls `pov.mission.start(map)`.
- `pov/index.js` updates mission NPCs with the same frame/env as combat; the shared
  death watch includes mission actors. Legacy sandbox enemy spawners are disabled
  during the attempt. Map replacement and mode changes cancel pending loads and
  dispose mission NPCs and markers.
- Reused game markers show live target chevrons through walls and an extraction
  volume at each authored exit. `missionHud` lists target names/status and
  offers explicit Retry/Leave. It replaces the normal timed-respawn overlay.
- `node tools/mission-node-check.mjs` checks lifecycle, metadata eligibility,
  authored spawning, guard exclusion, every-cause death detection, origin-aware
  extraction, one-shot NPCs, full retry/cleanup, async entry cancellation, gunner
  loadout restrictions, and dormant streamed actors,
  without browser/GPU usage. The fixture is not a public map.
