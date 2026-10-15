# Imported Cruelty Squad interactions

Source motion and fixed appearance-envelope metadata are specified in
[Door motion conversion ABI](cruelty-door-motion-conversion.md). All four published
maps are regenerated through that shared pipeline and consumed by the runtime below.

## Evidence and supported adaptation

Geometry/inventory: local `cruelty-vr-unpacked/Levels/Level{1,2,3,4,6}.tscn`.
Behavior reference: local `cruelty-flat-reference/_SETUP_PROJECT_/project_scripts/`.
Its README identifies the scripts as decompiled/fixed original Consumer Softproducts
scripts, distributed by crustyrashky's Cruelty Squad Project Setup Tool (July 2023).
Read as reference data, never executed or copied into the destination game.
Level 3 remains blocked by the existing full-bounds/storage budget; it is audited,
not cropped or silently enabled. Level 4 is included because it is a shipped map.

- `Door.gd`: E/use toggles a 90-degree Y swing, default 2 radians/second.
  Motion-enabled imports: negative-Y hinge swing with a physical moving voxel
  leaf and original triangle artwork. Progress is linear, endpoints clamp and
  use reverses the current pose (deliberate safe adaptations of source quirks).
  Source audio/health pool are not reproduced; element destruction still applies.
- `Elevator_Door.gd`: use only starts opening from stopped/closed; slides along
  longest local horizontal dimension (ties move both), default 2 meters/second;
  starts a 5-second one-shot closing timer. Motion-enabled imports slide the
  physical leaf in the original negative direction, **no manual close**. The
  timer starts at use, not animation completion, and close steps defer if unsafe.
- `down_door.gd`: E starts downward opening and a five-second closing timer.
  Motion-enabled imports use the same safe timed moving leaf. External
  `switch_use` activation is not implemented.
- Divine gates require `Global.soul_intact`, profane gates `Global.husk_mode`,
  terror gates `Global.hope_discarded`. These are NOT ordinary free doors.
  Destination: no progression implementation; E shows the unsupported requirement.
  Source gate immunity, profane knockback, and terror gibs are not ported.
- `Ladder.gd` enables/disables ladder mode on Area enter/exit. Importer now retains
  the original convex collision volume as world-cell `points`, `axes`, and `bounds`
  under `interactions.ladders`. W/S climbs along the look direction at the source
  4.5 m/s; idle grips without gravity. Normal body collision remains active.

Each scripted/instanced authored root is in `interactions.inventory` with source
resource, finite primitive authored overrides, world yaw, and explicit treatment.
Actor metadata is also retained in authored targets/guards, their runtime subsets,
and source actor inventory; original normal/hell/chaos filtering remains unchanged.

## Safety and lifecycle

Ownership is triangle/cell intersection, not a bounding-box carve. A voxel touched
by **any** non-door geometry or another door is disqualified, regardless of source
material precedence. Motion transforms immutable original cell centers then floors
into world cells. A destination-owned two-phase `reads: 'neighbours'` edit reads
old A/B before erasing matching previously placed cells and stamping only empty
or owned destinations. Open leaves remain present and collidable. Live thermal/life
fields follow placed cells. Coalesced cells retain separate logical alive bits;
occlusion clears placement, not life, so cycles cannot shrink or resurrect leaves.
Foreign replacements and static overlaps are never overwritten. Same-element
repainting cannot be distinguished from an original live cell.

Manifests without `door.motion` retain the legacy instant retraction path.

The same sparse words serve CPU terrain and every subscribed GPU scene generator
(including far generation). Only modified packed-word runs upload on interaction,
never whole-map writes per frame. World streaming is locked through live-mask
readback and canonical updates; motion requires the whole swept envelope resident.
Outside the window poses freeze without blocking streaming, then resume. Each
step checks a conservative continuous leaf-path bound against players/NPCs; pending
time is retained across GPU readback, with catch-up bounded to 100 ms of source
motion per edit. Round-robin scheduling advances simultaneous doors independently.
Zero-delta renders do not advance motion. Actor obstructions clear accumulated time.
Moving ordinary doors also wake the existing timer-driven world update path.
`WorldWindow.load` resets changed canonical words and artwork before generation.
Save-state v2 includes actual/desired progress, logical target, alive/placed masks,
timer and captured foreign/cleared-path canonical overrides. Validation finishes before
mutation. V1 open states migrate to the open endpoint with unplaced logical
survivors: old saves contained a retracted leaf, not physical endpoint cells.
Guarded live edits place these survivors without overwriting endpoint terrain.
Missing states reset to source doors.
Capture waits for transactions started during shader preparation too. Timers
continue outside first-person view, but stop when the simulation is paused.

Original 24-word triangle records are cached lazily. Rigid poses transform p0,
normal/plane and UV/barycentric affine gradients without changing material IDs.
Scene subscribers receive sorted coalesced dirty word ranges; far-grid updates
round out to exact u32 pairs and split at atlas rows/planes, preserving adjacent
words and padding. Full appearance upload occurs only on scene build; sampler
WGSL and global resource bindings are unchanged.

CPU regression: `node --test tools/imported-door-motion-check.mjs tools/imported-interactions-check.mjs tools/check-source-appearance.mjs`.
This includes real runtime orchestration against snapshot-neighbour CPU emulation,
affine/art uploads, save/reset/epoch tests, WGSL reflection and CPU Naga. GPU/browser
validation uses `tools/cruelty-door-browser-check.mjs`: real click/E, intermediate
native GPU poses and readback, moving artwork records, reversal and mode-scoped UI.

Bounded native evidence:

- Normal-sized Androgen Assault in plain view passed click/E, intermediate poses,
  all 45 living cells, artwork changes and reversal in 8.227 seconds total.
- `tools/source-appearance-gpu-check.mjs` passed on the Apple GPU in 2.562 seconds.
  A nonuniform texture retains its exact sampled pixel after rotation, translation
  and reset through the production affine helper, range uploader and WGSL reader.
- A full realistic Androgen cold boot reached its guard at 23.985 seconds before
  assertions. This is not a completed textured-scene visual check.

The compact interaction control is a scoped input/accessibility adaptation.
Original `weapon.gd` uses doors directly, without an ordinary-door hover card.
Our Cruelty-only `[E] Open` button removes the card and redundant title, preserves
click/touch and keyboard focus, and hides the overlapping material readout only
while an imported interaction is focused. Other modes retain their controls.

Conservative overlap ownership may leave frame/static voxels in the opening.
Level 4 `QodotMap/entity_175_Door` and `QodotMap/entity_320_Door` have no exclusive
voxels; the prompt explicitly reports this rather than carving static terrain.
No claim of exact leaf geometry or universal body-clear passage is made.

Grid-aligned faces occupy the source winding's solid side only; edge-only contact
does not inflate the ceiling. Source doorway checks traverse with the real
1.6×5.5-cell body in each published map, without scaling geometry or the body.

CPU conversions measured exclusive owned cells (including restricted gates):
Level 1: 1,500; Level 2: 8,653; Level 4: 1,345; Level 6: 2,528.
No gate cells are retracted by runtime use.

## Remaining scripted losses

- Elevator platform (`Elevator.gd`): use starts vertical motion at 2 m/s; collision
  stops and reverses the next trip. Not ported; authored rest geometry only.
- `Rotator_Y.gd`, `crusher.gd`: spinning/sinusoidal moving collision remains static.
- `remote_destroyer.gd`: player-triggered destruction of overlapping destructibles
  not ported. Destructible/armored source health/piercing-only rules and use text
  are not preserved; destination elements supply their own destruction mechanics.
- Water Areas / Toxic_Water: source swim volumes, toxicity/progression variants
  not executed; imported material surfaces use destination element mechanics.
- Message/tutorial Areas, alert Events, death-mode setters, animated autoplay,
  sound Areas and light switches are inventoried but not executed.
- Enemy/civilian/torso scripts and PackedScene props/loot/weapons remain destination
  representations or unexpanded assets. Enemy/nav parity is a separate lane.
- Night/sky cycles, Qodot runtime processing, and source Navigation scripts are
  not executed. Authored normal Exit volumes remain destination mission extraction.

### Exact root-script inventory counts

| Source script | L1 | L2 | L3 (blocked) | L4 | L6 |
|---|---:|---:|---:|---:|---:|
| `res://addons/qodot/src/nodes/qodot_map.gd` | 1 | 1 | 1 | 1 | 1 |
| `res://Levels/sky_rotator.gd` | 1 | 1 | 1 | 1 | 1 |
| `res://lighttoggle.gd` | 0 | 1 | 0 | 0 | 0 |
| `res://Scripts/Alert_Event.gd` | 0 | 0 | 0 | 0 | 2 |
| `res://Scripts/Anim_Autoplay.gd` | 0 | 1 | 0 | 0 | 0 |
| `res://Scripts/crusher.gd` | 1 | 0 | 0 | 0 | 0 |
| `res://Scripts/deathmodesetter.gd` | 1 | 0 | 0 | 0 | 0 |
| `res://Scripts/Destructible_Armored.gd` | 1 | 0 | 0 | 0 | 1 |
| `res://Scripts/Destructible.gd` | 47 | 119 | 24 | 18 | 37 |
| `res://Scripts/Divine_Door.gd` | 1 | 1 | 0 | 0 | 0 |
| `res://Scripts/Door.gd` | 22 | 45 | 22 | 67 | 39 |
| `res://Scripts/down_door.gd` | 0 | 14 | 0 | 0 | 0 |
| `res://Scripts/Elevator_Door.gd` | 3 | 7 | 1 | 1 | 1 |
| `res://Scripts/Elevator.gd` | 0 | 1 | 0 | 0 | 0 |
| `res://Scripts/Enemy_Torso.gd` | 0 | 0 | 0 | 0 | 5 |
| `res://Scripts/EnemyHandler.gd` | 0 | 0 | 0 | 0 | 1 |
| `res://Scripts/Exit.gd` | 1 | 1 | 2 | 2 | 3 |
| `res://Scripts/Ladder.gd` | 1 | 4 | 1 | 4 | 2 |
| `res://Scripts/Message_Area.gd` | 1 | 1 | 1 | 1 | 1 |
| `res://Scripts/Navigation.gd` | 1 | 1 | 1 | 1 | 1 |
| `res://Scripts/Night_Cycle.gd` | 1 | 1 | 1 | 1 | 1 |
| `res://Scripts/Profane_Door.gd` | 1 | 0 | 0 | 0 | 0 |
| `res://Scripts/Randomsound.gd` | 0 | 0 | 0 | 0 | 1 |
| `res://Scripts/remote_destroyer.gd` | 1 | 0 | 0 | 1 | 5 |
| `res://Scripts/Rotator_Y.gd` | 0 | 3 | 1 | 0 | 0 |
| `res://Scripts/Stupid_Civilian.gd` | 0 | 0 | 0 | 0 | 1 |
| `res://Scripts/Toxic_Water.gd` | 0 | 1 | 0 | 0 | 0 |
| `res://Scripts/Water.gd` | 3 | 1 | 5 | 1 | 1 |
| `res://Terror_Door.gd` | 1 | 0 | 0 | 1 | 0 |

## Validation

`tools/imported-interactions-check.mjs` covers real provider/runtime orchestration
with a CPU emulation of the conditional GPU edit; canonical/generator agreement,
streamed-open words, load-before-fill reset, destruction and static overlap
preservation, replacement matter, occupancy, pending/nonresident use, restricted
gates, the five-second timer, off-view updates, save round-trips, preparation
races, shared generator preparation, actor primitives/yaw, and CPU WGSL parsing.
With `CRUELTY_SOURCE_DIR`, source counts and complete script/instance inventories
are checked against the actual supplied Level 1/2/3/4/6 scenes.
Existing importer CPU tests, import checks, async checks and production build pass.
`tools/imported-door-passage-check.mjs` exercises real body movement through
published source doorways in all four maps. `tools/cruelty-interactions-browser-check.mjs`
checks E and real GPU collision; `WGSL_CHECK` exposes the `importedDoor` kernel.
Published manifests include all integrated interaction and actor metadata.
The built-site browser check passed in a 6.73-second total GPU slot:
Pharmakokinetiks, two targets and 23 actors; real E opening cleared the standing
body probe, and E closing restored its obstruction. A separate authored-guard
visual checkpoint passed in 4.35 seconds. No geometry, body or streaming window
was reduced for either check.
