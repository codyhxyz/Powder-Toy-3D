# Preservation

The map replaces the three comparison halls.
Its premise is: **Every material. Unchanged. Forever.**
The route moves from a polished public demonstration into its maintenance spaces.
The final oversized chamber contains no singularity.

## Play

Open `/?map=preservationLab`.
The map starts in first person at the reception gallery.
The old `labStudies` URL opens the new map.

Follow the gold floor line to the public window.
The service doorway reveals the back of that same sand exhibit.
The next room contains a reservoir, elevated walkway, exhaust vessel, and separate oil sump.
The side stair leads to the inventory archive.
The restricted route passes a disconnected cold-storage unit before the empty chamber.

Press **Q** to release the mouse.
Click an information plaque to inspect the material.
The inspector gives simulation facts and storage limitations.
Corporate notices provide fictional commentary, not safety guarantees.

## Authored story, generated collection

`src/lab/preservation/` contains the authored chapters and the generated archive.
Chapter plaques identify the featured materials.
The archive includes every other entry from `createExhibitCatalog`.
It does not maintain another list of element names.

Every material and named effect gets exactly one primary exhibit.
Featured materials do not receive duplicate archive cases.
Other occurrences, such as glass windows and metal walkways, remain part of the building.

Fresh generation includes newly registered elements automatically.
The archive groups entries by physical kind and storage status.
Display recipes come from `src/lab/specimens.js`, using the catalog's tags.
The indefinite-storage assessment does not decide whether a material can be displayed.
Acid uses acid-proof walls; unlit explosives rest in supported shallow trays.
Growth specimens have no feedstock, and dormant clones have no cloneable neighbors.
Antimatter rests in a wall-lined retaining cup.
Hot, cold, short-lived, and spontaneously emitting specimens use native clone-fed cases with void drains.
These replace spent material; they do not lock temperature or lifetime.
The singularity remains absent because starvation destroys it and feeding can cause a burst.
Photon, neutron, and spark tools have explanatory plates rather than fake material cubes.
The current archive supports 384 cases, beyond the engine's 256 material IDs and three named effects.

The complete plaque manifest can exceed the sign system's 64 slots.
`src/lab/scenePlaques.js` selects at most 32 nearby generated plaques.
Manual signs keep their available slots.
Saved generated keys prevent duplicate plaques after a snapshot loads.

Saved snapshots preserve their physical state.
They also preserve the complete plaque placement manifest, so later additions cannot relabel existing cases.
They do not automatically rebuild their inventory when the registry changes.
Reloading the map generates the current collection.

## Mechanical limits

The sand hopper contains a finite charge.
The reservoir and oil sump do not provide endless circulation.
Real battery-fed lamps illuminate the facility.
Disconnected housings do not simulate pumps or refrigeration.
Insulation slows the ice sample's warming but does not maintain its temperature.
The map does not claim validated radiation shielding or indefinite containment.
Small radioactive samples are live and explicitly marked as not neutron-shielded.
The archive supply and drains are native simulation materials, not protected map-only overrides.

## Validation

Run the CPU tests:

```sh
npm run check:lab
```

The tests cover registry growth, unique exhibits, actual uploaded sample/source state, connected routes, stair clearance, enclosed walking spaces, and plaque ownership.
Local native-kernel tests check acid-compatible neighbors, dormant clones, and repeated short-lived sample generation.
These checks are not a full-map, long-duration physics test.
They also block each chapter connection to detect unintended route shortcuts.

The browser check uses one 25-second GPU slot:

```sh
node tools/preservation-browser-check.mjs --port 54983
```

It checks automatic first-person entry and material inspection in Plain view.
Physics remains paused during this UI check.

Check actual native inventory before and across 24 physics ticks:

```sh
node tools/preservation-browser-check.mjs --port 54987 --inventory
```

This uses the full map in Plain view, without compiling an unused player model.
It verifies rendered-state material IDs, not merely the plaque manifest.
It does not establish long-duration thermal or neutron containment.

Capture the authentic material lighting separately:

```sh
node tools/preservation-browser-check.mjs --port 54983 --visual-only --bake-preview
```

This command uses the existing raw-preset launch without an unnecessary player model.
It saves two story screenshots in `/tmp/tpt-preservation` and generates the menu image.
Each command has its own 25-second total GPU-slot limit.

The shipped menu artwork can also be generated without GPU use:

```sh
node tools/preservation-thumb.mjs
```

This tool adapts the existing Descent CPU renderer to the exact map geometry.
Its software lighting is illustrative, not the game's material shader.
Clear panes and gases are omitted from the preview sightline.

The old comparison room modules and map entry are removed.
The old preset name remains readable for saved snapshots.

## Design reference

[Valve's Portal developer commentary](https://theportalwiki.com/wiki/Portal_developer_commentary) describes observation rooms as both implied workplaces and light sources.
The map adapts that public-room/backstage contrast.
Its inventory generation and storage policies are specific to this game.
