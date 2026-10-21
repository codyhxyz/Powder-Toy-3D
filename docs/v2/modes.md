# Native simulation modes

The saved gravity slider is normalized against its shipped `0.025` default.
Native acceleration is `(setting / 0.025) × 19.6 m/s²` (TF2's roughly 2g,
`docs/v2.md` §5.1), not the legacy cells/step² acceleration. `nativeModes`
validates modes and supplies the same per-dispatch values to grid and particle
kernels. `nativeBodyGravity` gives the same vector in cells/s². The first-person
body does not fall at it: under both engines it falls at Noita's gravity (5.4 g,
scaled by the setting) along `gravityAt`'s direction (`src/pov/player.js`).
Shots, throws, frags, wand bolts and the bots' aimed lobs read the same direction
through `src/pov/gravityField.js`, each at its own strength; under radial gravity
they fall toward the centre (`tools/check-radial-projectiles.mjs`).
Radial gravity is constant magnitude toward the local box centre (TPT); gravity
at the exact centre and in Off mode is zero. The native tick is 1/60 second;
liquid substeps remain 1/180 second. No extra speed-slider multiplier belongs
in force or velocity conversion.

`MODE_FIELDS` / `modeWGSL` are the shared air/dynamics/contact integration API.
`mGravity` takes local cell coordinates and returns m/s². `mEdge` wraps integer
cell addresses on all three axes. `mFaceDrive` uses radial potential differences;
vertical periodic seams experience the same uniform force as any other face,
not a fictitious full-box height drop. Liquid pressure remains active at zero g.
World windows force Solid edges regardless of saved edge mode.

Changing the settings signature wakes both activity histories without touching
cell cores, fractional liquid/fall state, or energy banks. Ordinary `wake()` and
brush writes do not sweep all activity. Changes to the shared ambient temperature
also take this path when the compact engine owns the state.

Open grid faces drain gas/liquid through an isolated native boundary pass.
Cumulative removed material volume (FULL=65536 per full cell) is a 64-bit count
at `v2ActLayout(g).boundaryMass`; its two words use the pre-existing reserved
count slots and do not resize saves. Exact removed material energy, including
its apportioned bank, enters the existing 96-bit energy sink. The empty carrier
retains its own energy. Solid and periodic boundaries never drain. R5 ambient
exchange runs only on actual open side/top faces with ambient heat enabled,
not on the floor or a 0K sentinel wall.

## Integration status

This slice is **not v2 mode-completeness certification**. The fast column solver
is vertical/Solid only. Radial/Open/Loop powder must be promoted by native
dynamics to ballistic particles, with allocation backpressure retaining source
material/events when capacity is exhausted. A slow 2³-block falling substitute
is deliberately not shipped as ballistic parity. Rotated disjoint block frames
still provide topple and density-swap rules. Air mode behavior, particle edge
handling, and POV consumption are integrated by their owning lanes.

### Liquids under radial gravity

The column runs are vertical only, so under radial gravity the same two column
passes run a cell-face model instead (`src/shaders/v2/columns.js`, `RADIAL`).
It follows The Powder Toy (`SimulationImpl::MovementPhase`): a liquid that
cannot move along the pull moves perpendicular to it. Each cell's pull is its
dominant axis (`mDown`, as `radialDrip` and V1's rotated blocks read it).

- A face along that axis packs: the upper cell's fill drops into the room of
  the cell below it.
- A face across it flows from the higher head to the lower one. The head is
  the radial potential at the surface of the liquid stacked over the cell,
  which is its distance to the centre. A lake at rest is therefore a sphere
  about the centre, not a plane.

Three stages a tick reuse the passes' threads and ownership:

1. `v2runs` writes every face's demand from frozen cells.
2. `v2pairs` stage 0 applies each column's y faces.
3. The transfer stages apply the owned pairs' x and z faces.

Every move goes through `colMove`, so mass, energy and fuel stay exact.

- `RATE` (1/8) is the largest step at which this explicit relaxation never
  overshoots.
- A covered giver keeps `KEEP` quanta, so no liquid is left standing on air.
- Liquid over open air is still `radialDrip`'s: it flies toward the centre.

Limits: the model is momentum-free, so heads relax rather than slosh. A covered
run's head stops at its lid, so a U-tube under radial gravity does not
equalise. Open and loop edges are treated as closed walls.

Its checks: `node tools/v2/radial-spread-check.mjs` and the outcome test
`radialSpread` (`tools/outcomes/tests/radial.js`, red on 7f9b2f1c's still
liquids). The vertical kernels branch on `P.gravMode == 2u` before any of
their own code, which `tools/v2/jets-check.mjs` pins.

CPU checks: `node tools/v2/modes-check.mjs` and
`node tools/v2/modes-wgsl-check.mjs`; the latter validates actual emitted grid
and full-contact WGSL with Naga, without a browser or GPU. Dynamics WGSL has its
own existing CPU validator. These tests do not claim GPU execution evidence.
