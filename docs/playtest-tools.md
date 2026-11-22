# Playtest tools

## Cutaway

Use the slice button or **J** to cycle Off → X → Y → Z → Off. The plane starts at the hovered work, or halfway through the active grid if nothing is hovered. **K** flips the hidden side. Drag the depth slider or hold **Alt+J / Alt+K** to move one cell at a time (**Shift** for eight). The readout is in world cells, so the cut stays put when a streamed window moves.

The pointer and the tool gun see the kept side. The brush centres on the retained cells at the cut face, and god-view drags started there follow the slice instead of the usual horizontal plane. Use Replace, Spark, Erase, or other tools directly on the exposed material. Cutaway changes visibility and aiming, not collision, light emitters, or simulation. Normal brush volume still applies; cells hidden by the plane can keep reacting or be affected by a large brush. Refraction keeps rays straight during cutaway so hidden material cannot bend the revealed image. A flat material view reads the exact world copy at the cut, including outside the window; the curved view clips its distance pass as well.

## Checkpoint

**N** (bookmark) saves one temporary checkpoint; **M** (reset arrow) restores it repeatedly. It is independent of Undo and separate from disk saves. Use Pause before saving or resetting if you want to inspect the exact paused state; reset leaves your play/pause choice unchanged. Checkpoints are solo-only, not a co-op rollback, and are cleared when the map changes or a disk save is opened.

Both Box and streamed World use the existing save-state readback/restore path, without a screenshot, gzip, or IndexedDB. The bookmark keeps the active grid's exact V2 cells, air/pressure, temperatures and electronics, native dynamics (including particles or blasts that already existed at capture), and the ordinary save sections for decoration and scene edits. Work queued after the checkpoint and transient POV projectiles/effects are discarded on reset. This is a simulation checkpoint, not an inventory or player-health save. It keeps the current camera mode and repositions an active body at the checkpoint's saved feet if one was captured.

In World, the bookmark also keeps the active window's origin, retained edits outside that window, planted columns, and source-map interaction state. Reset rewinds edits throughout that map, not just the currently loaded slab. If the window never moved, the restored cells are written back through the normal display update. If it moved, reset puts it back at the saved origin and rebuilds the world display from the retained store; on a large map that rebuild can take longer than a same-window reset.
