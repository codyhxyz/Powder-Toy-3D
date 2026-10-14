# Grappendix mechanics

The E shortcut keeps the flat-screen Cruelty Squad force and movement rules,
with a deliberately longer voxel-world range and a finite safety cutoff.
The separate Hook tool is unchanged: 30 m throw, existing mouse/reel controls.

## Source

Reference: [Cruelty Squad Project Setup Tool](https://github.com/CruS-Modding-Infrastructure/crus-project-setup-tool/tree/199c95dff59cc663e958762bdab23149fa3794f7).

The reference files are `Scripts/Player.gd` and `Scripts/weapon.gd`, under `_SETUP_PROJECT_/project_scripts/`.
The source belongs to Consumer Softproducts.
This repository does not include the original scripts.
The VR mod uses different grapple physics and is not the force reference.
Its original `Player_Test.tscn` instances `Entities/VRPlayer.tscn`; both hand
`MovementGrapple` nodes explicitly set `grapple_length = 30.0` (Godot meters).
These were inspected in `/private/tmp/cruelty-vr-unpacked` from the VR mod
archive cited in `cruelty-source-comparison.md`; the movement script itself is
compiled `.gdc`, so no unverified VR force or release settings are claimed.
The linked flat-screen `weapon.gd`, lines 832–848, explicitly gates attachment
at `<20` meters. Neither source claims our new 100/200 m settings.

### Range adaptation (base e06a6eaa)

- Acquisition: **less than 100 m** (`100 / CELL_M` = 333⅓ cells), eye to hit.
- Safety release: **more than 200 m** (`200 / CELL_M` = 666⅔ cells), body center
  to anchor; exactly 200 m remains attached. This is a release, not a constraint.
- `CELL_M` remains **0.30 m/cell**; no map rescaling or global combat trace
  limit changes. These values apply in Sandbox as well as missions.

100 m is a deliberate 5× traversal extension over flat-screen acquisition,
not a correction to source units. Full-scale imported streets/rooftops exceed
both the old 20 m gate and the ~19.2 m half-width of a 128-cell simulation
window. The Paradise CPU fixture's actual source wall is 91.65 m away.
The 200 m safety budget leaves twice the acquisition reach for swings/falls and
moving anchors without an unlimited runaway cable. Forces, source distance
bands, E toggle, jump-to-launch and momentum on release are unchanged.

## Attachment and force

E requests an attachment to the flat physical crosshair ray less than 100 m away.
It attaches when the asynchronous live-cell trace lands (normally 1–3 frames),
without projectile flight. E again releases, including when aimed at the sky,
or cancels an acquisition that is still waiting for its trace.
Attachment does not change the selected weapon.
The force always acts toward the attachment point.
It does not impose a rope-length constraint or require a held button.
It does not automatically release near the attachment point.
It releases beyond the 200 m safety distance without changing velocity.

Force distance uses the body center, not the eye.
The acceleration is `gravity × 2.3 × distanceFactor`.

| Distance | Factor |
| --- | --- |
| At most 3 m | 0 |
| More than 3 m, less than 10 m | 1 |
| More than 10 m, less than 20 m | 0.7 |
| More than 20 m | 2 |
| Exactly 10 m or 20 m | 0 |

The strict comparisons match the source, including the two zero-force boundaries.
The attachment can remain active beyond acquisition range, up to 200 m.
The stronger long-distance force now also applies to initial long-range hits.

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
Capacity is 800 orbs, enough for the entire 200 m cable at four orbs/m,
replacing the old 512-orb/128 m cap. The source's one-batch-per-frame growth
and pulse remain; a freshly attached line takes time to grow to full length.

Acquisition no longer consumes the presentation hover (which only picks resident
cells and may be curved). One on-demand `povTrace` ray checks current resident
matter, including foreground liquids/powders that block but cannot anchor.
Beyond residency, imported maps use their canonical `scene.cell` voxel source,
with `BrickStore` edits taking precedence. Pristine source is never queried
instead of live resident cells, so destroyed walls do not reappear as anchors.
World-origin shifts transform anchor coordinates and invalidate in-flight reads.
Map/grid replacement, same-window reloads and player teleport/death cancel
pending acquisition and existing cables; they cannot clear another tool's tether.

Limits: non-imported procedural scenes have no canonical CPU cell API, so
acquisition stops at unknown terrain outside their simulation window rather
than tunnelling through it to an actor. Acquiring a far imported anchor also
fails closed while a leaving-slab save is pending. After attachment, eviction
alone is not destruction: far imported anchors validate against source/stored
edits, and all anchors validate against fresh probes when resident again.
No new persistent settings, enlarged simulation window or importer changes.

Our voxel collision system, body size, damage rules, and material simulation remain in use.
Broken anchors, removed actors, teleportation, and world replacement cancel the attachment.
These lifecycle protections prevent invalid anchors from pulling a new body or world.
Living enemies act as moving anchors.
Corpses receive the original reciprocal pull of 22 m/s².
The other implants are not implemented.

## Checks

Run `node tools/grapple-cpu-check.mjs`.
The check covers source force boundaries and 30/60/120 FPS movement, real
75 m voxel attachment/pull, the published Paradise 91.65 m far hit in a normal
128-cell window, closest resident occlusion, destroyed resident vs pristine
source cells, saved far edits, 100 m acquisition boundaries, 200 m release and
800-orb capacity, moving anchors, and stale/pending lifecycle cleanup.
The real body/controller run over CPU stand-ins for live GPU probes; this is
not evidence of GPU execution or browser E wiring on the changed build.

Run `node tools/grapple-browser-check.mjs` for the real E-key wiring.
The browser check uses one manual-mode GPU slot with a ten-second limit.
