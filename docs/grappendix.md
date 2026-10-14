# Grappendix mechanics

The E shortcut uses the original flat-screen Cruelty Squad grapple rules.
The separate Hook tool retains its existing mouse controls.

## Source

Reference: [Cruelty Squad Project Setup Tool](https://github.com/CruS-Modding-Infrastructure/crus-project-setup-tool/tree/199c95dff59cc663e958762bdab23149fa3794f7).

The reference files are `Scripts/Player.gd` and `Scripts/weapon.gd`, under `_SETUP_PROJECT_/project_scripts/`.
The source belongs to Consumer Softproducts.
This repository does not include the original scripts.
The VR mod uses different grapple physics and is not the mechanics reference.

## Attachment and force

E attaches immediately to a crosshair hit less than 20 meters away.
E again releases, including when the crosshair points at the sky.
Attachment does not change the selected weapon.
The force always acts toward the attachment point.
It does not impose a rope-length constraint or require a held button.
It does not automatically release near the attachment point.

Distance uses the body center, not the eye.
The acceleration is `gravity × 2.3 × distanceFactor`.

| Distance | Factor |
| --- | --- |
| At most 3 m | 0 |
| More than 3 m, less than 10 m | 1 |
| More than 10 m, less than 20 m | 0.7 |
| More than 20 m | 2 |
| Exactly 10 m or 20 m | 0 |

The strict comparisons match the source, including the two zero-force boundaries.
The attachment can remain active beyond its initial range.
The stronger long-distance force is therefore reachable after attachment.

## Movement

The reference baseline uses gravity of 22 m/s², movement speed of 9 m/s, and jump speed of 8 m/s.
Ground friction uses a coefficient of 6 and a minimum control speed of 10 m/s.
Ground acceleration uses a coefficient of 10.
Air acceleration uses 2, or 20 when input opposes the current motion.
Forward air control changes direction without reducing horizontal speed.
Jumping removes ground friction, which lets the grapple accelerate the player.

This movement profile applies while attached and through the flight after release.
Landing without an attachment restores normal Sandbox movement.
The Cruelty Squad mission mode uses this profile without an attachment.
Space does not activate the Noita jetpack during this profile.
The game gravity setting still scales gravity and grapple force together.

## Rendering and engine limits

The line uses four flesh-colored spheres per meter with the source pulse formula.
Each sphere has the source radius of 0.173 m.
Instancing replaces the original separate scene nodes.
The visual span has a 128 m limit, but the force has no such limit.

Our voxel collision system, body size, damage rules, and material simulation remain in use.
Broken anchors, removed actors, teleportation, and world replacement cancel the attachment.
These lifecycle protections prevent invalid anchors from pulling a new body or world.
Living enemies act as moving anchors.
Corpses receive the original reciprocal pull of 22 m/s².
The other implants are not implemented.

## Checks

Run `node tools/grapple-cpu-check.mjs`.
The check covers source force boundaries, movement, release, rendering, moving anchors, and lifecycle cleanup.
It runs the real body and controller over CPU probes at 30, 60, and 120 FPS.

Run `node tools/grapple-browser-check.mjs` for the real E-key wiring.
The browser check uses one manual-mode GPU slot with a ten-second limit.
