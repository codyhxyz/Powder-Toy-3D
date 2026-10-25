# Lab Studies

Lab Studies is a hand-built comparison map, not the automatic collection.
The three halls share one indoor concourse:

- **A: Aquarium gallery.** Square powder windows, a gas window, and a shallow bathing court.
- **B: Reactor atrium.** Elevated catwalks, separate water and oil vats, and a finite powder hopper.
- **C: Containment block.** Isolated observation bays, an insulated ice sample, and an empty singularity exhibit.

## Play

1. Open `/?map=labStudies` or select **Lab Studies** in the Sandbox map menu.
2. Press **V** to enter the indoor concourse.
3. Follow the hall labels to compare the layouts.
4. To inspect a specimen, press **Q** to release the mouse.
5. Click a specimen label with the information symbol.
6. Close the facts panel before you return to the game.

The reactor hall has stairs beside the entrance.
Its water vat has a jumping gap in the upper railing.
Submerged stairs connect both vats to the floor.

Samples remain physical.
The hopper empties, grains settle, and ice warms.
The map does not provide active refrigeration or validated radiation shielding.
Reloading the map restores the authored samples and labels.

## Code

- `src/materialTraits.js` defines reusable tags and derives them from existing physics data.
- `src/elements.js` supplies semantic traits for special behaviors.
- `src/lab/facts.js` supplies shared facts for material cards and specimen inspection.
- `src/lab/catalog.js` includes every material, plus the three named effect exhibits.
- `src/lab/studies/` contains the three manually authored rooms and their shared concourse.
- `src/lab/inspector.js` displays the catalog facts when a specimen label is selected.

The catalog includes new registry entries automatically.
The study rooms do not use the catalog to place samples.
This separation lets the room designs change without changing the metadata architecture.

The catalog distinguishes a geometric candidate from an unsupported persistent specimen.
Neither status proves containment safety.
Unsupported requirements produce an explanation rather than an ordinary glass-container assumption.

See [Material metadata](material-traits.md) for the public APIs and element-authoring procedure.

## Validation

Run the CPU checks:

```sh
npm run check:lab
```

The checks cover catalog growth, hazard combinations, fact formatting, fixed dimensions, connected walking routes, enclosure, and plaque placement.
They do not prove long-term stability or every player movement.

The optional browser check uses the repository GPU launcher:

```sh
node tools/lab-studies-browser-check.mjs --port 54981
```

One run has a 25-second total GPU-slot limit.
It checks the full-size map, indoor player spawn, specimen inspection, and sign serialization.
It also captures three interior views in `/tmp/tpt-lab-studies`.
Physics remains paused during this check.

To regenerate the menu image, add `--bake-preview`.
The image uses the aquarium gallery view.
