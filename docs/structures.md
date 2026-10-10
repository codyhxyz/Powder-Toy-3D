# World structures

The island's built things: what they are, where the generator puts them and why. The constructions themselves are
ordinary built-ins (`src/constructions/builtins.js`, `src/constructions/structures.js`); this doc is about their scale and
their place in the world. Phase 1 (this doc, the builds) is done; phase 2 (the placement layer) waits for the generic
scene path.

## Scale: built for the first-person body

A cell is 0.3 m. The body is 5.5 cells tall and 1.6 wide, steps up 1-cell ledges, and can't crouch or climb. The built-ins
were drawn before there was a world or a body to measure them against, and several didn't fit it. `shared.js HUMAN` now
holds the human scale every construction builds to at T = 1 (the default size, and the size World places them at):

| | cells | metres | from |
| --- | --- | --- | --- |
| door | 7 × 3 | 2.1 × 0.9 | the body's height and width plus one cell |
| room (floor to wall plate) | 8 | 2.4 | |
| window | sill 3 up, 4 tall | 0.9, 1.2 | frames the eye, 5 cells up |
| stair | 1 rise a step, 7 clear above | | the body's step-up and height |
| railing, parapet | 3 | 0.9 | |

Sizes still scale with T: below T = 1 a build is a model to look at, above it a monument. The box keeps every
built-in; the lint passes for every variant at sizes 1–24, and the lighthouse and wreck cap their scale at T = 2 to fit the
128-cell box.

### Review of the existing built-ins

| Built-in | Was | Now |
| --- | --- | --- |
| House | door 5 cells (1.5 m): the body couldn't get in. Windows 2–5 cells up: under the eye, so you saw wall. A 1 × 2-cell fireplace. Empty room | door 7 × 3, room 8 tall, windows 3 wide at eye level, a 3 × 3 fireplace, a bed (straw tick under a green quilt) and a table. Checked by walking the body in (below) |
| Campfire | ring 2.4 m across, teepee 1.8 m: a bonfire | ring 1.8 m, logs knee to waist high |
| Barrel | 2.4 m wide, 3.3 m tall, twice the body | 1.5 m, about the body's height: the smallest a sealed drum can be (a liquid-tight round shell is 1.5 cells thick; a real drum is 2 × 3 cells, all shell) |
| Igloo | inside height 1.8 m; a 0.75 m crawl tunnel the body can't use | 3 m dome, 2.4 m inside, an arched entrance walked through upright |
| Trees | 5–10 m (World draws them at sizes 3–5) | unchanged. Young-forest height, in proportion with 2.4 m eaves and 25 m hills. The far field mirrors their numbers (`shaders/far.js TREE_SHAPE`), so a change goes with the foundation's far-field work |
| Aquarium, fountain | fine for the box | unchanged; not for the world (the fountain's CLONE overflows) |
| Shrine (new on main) | fixed size for the body | fits the same scale (floor-to-roof 8 cells); its sizes could move onto `HUMAN` |

**Level of detail.** At 0.3 m cells a door is 3 cells and a window 3 × 4, so detail lives in silhouette and materials, not
ornament: contrasting materials per part (stone slab and chimney, wood walls, glass, steel hoops and rails, a tin roof,
striped masonry), and a few objects at the right size inside (bed, table, hearth log, lamp, crates, cart). In first person
the cottage reads as a room: the back windows frame the view at eye height and the bed sits under one (GPU still below).
From the god view the roofs, the lighthouse and the towers carry the read.

**Checking walkability.** A breadth-first search of the body (2 × 2 cells, 6 tall, 1-cell step up) over each build on
flat ground, from outside its front: it reaches the inside of every house, the end of the pier and the hut, the face of
the mine, the lighthouse's landing and the gallery outside its lantern, and the watchtower's deck. It found two real
bugs, both fixed: the lighthouse's taper closed the stair's diagonal to less than the body's width (`STAIR.CLEAR_R`), and
a landing must leave the stairwell open a stride further back, because the body stands on the highest tread under its
two-cell footprint (`STAIR.STRIDE`). Worth making a lint (`walkable`) in phase 2.

## The structures

| Key | Variants | What it is | Cells (T = 1) |
| --- | --- | --- | --- |
| `DOCK` | pier, hut | a plank pier on posts; the footing grows each post into a stilt down to the sea floor (posts are the only base cells), a T-head with bollards; a fisher's shack with a tin roof on the head | 13 × 4 × 32 |
| `TOWER` | lighthouse, watch, ruin | spiral stair round a newel, one cell a step under 11 clear; a striped lighthouse with a railed gallery and a glass lantern whose lamp is CRYSTAL; a braced timber watchtower with a roofed deck; a broken round keep with a stair to its broken top, a curtain wall and fallen blocks | 19 × 50 × 19, 15 × 41 × 15, 34 × 23 × 21 |
| `STONES` | | 9–12 rock monoliths (some leaning, some fallen) round a low altar, 9 m across; natural ROCK, so the pickaxe quarries it | 31 × 11 × 31 |
| `WELL` | | a stone parapet round sealed water on its own stone floor (no ground cover touches it), windlass, rope, bucket, roof | 9 × 13 × 7 |
| `MINE` | | timber portal and a 7 m gallery it carves into the hill behind it, timber sets with CRYSTAL lamps, rails on a plank floor out to a cart of rubble, crates at the face | 11 × 15 × 34 |
| `WRECK` | | a hull heeled over and sunk into the sand (cells below the base are dropped, so the beach shows there), stern stove in to ribs, a gash on her high side, mast stump, spar and anchor on the sand | 20 × 15 × 46 |

They live in `structures.js`, not `builtins.js`, because `builtins.js` is pasted into every AI prompt as worked examples;
`shared.js` (the human scale) now goes into the prompt ahead of it, so models build to the same scale.

## Placement (phase 2)

### The layer

The tree placement, generalised. A **site lattice** of 64 × 64-cell squares: each square may hold one candidate per
structure family, hashed from the world seed and the square's coordinates (kind, offset, variant, quarter, construction
seed, priority), exactly as `treeCandidate` does per brick column. A candidate is kept if its ground suits its kind (the
table below, from `layersAt` and the foundation's CPU cell function for caves, lakes and strata), and if no higher-priority
candidate of any family stands within the larger of the two's spacings (Matérn thinning, as `treesIn`). Placement then
depends only on nearby squares, so any window places the same structures as any other, and the far field can place them
at world load.

**Trees give way.** A tree candidate within a structure's clearing radius (its footprint plus 6 cells) is dropped:
`treeCandidate` asks `structuresNear`, which is cheap because structures are sparse. The far field's tree thinning needs
the same mask (a small texture of clearing discs), through the foundation's far-field hook. The GPU run below shows why:
without it a cottage door opens into a pine.

**Footing.** The base sits at the highest ground under the footprint (sampled every 2 cells), so the stamp's footing fills
a plinth on the low side and nothing is buried. A site whose rise under the footprint is more than its kind's limit is
rejected, which keeps plinths short. The front faces uphill for buildings, so the door is a single step up from the
ground (the plinth shows on the downhill side). Exceptions: the mine and the dock sit at their origin's ground (the portal,
the pier's root) and face downhill, toward the valley or the sea.

**Stamping.** Like trees: the window stamps every structure whose box meets the brick columns a move visits for the first
time, clipped to those columns, with one `stampMany` pass, and the planted record keeps it from stamping twice; after that
it comes back from the store as edits. The stamp seeds per world cell, so a structure cut across two slabs comes out the
same in both. `TREE.REACH` (16) becomes the largest half-extent of anything placed: about 40 cells with the wreck and
the ruin.

### Where each one goes

| Structure | Where | How many, how far apart | Max rise under it | What it adds for the player |
| --- | --- | --- | --- | --- |
| Village: wells, cottages, brick houses, a campfire | a meadow plateau (plant cover) at least 64 cells across, rise ≤ 6, within 80 cells of the sea or a lake | 1–2 per island, 300 apart | 2–3 per building | A place: houses to walk into, with beds and hearths, the first sign that someone lives here. The well is the landmark you navigate back to |
| Lone cottage or cabin | meadow below the plant line; cabins in the pine zone (above 0.3 of the relief) and by mountain lakes (the hermit's cabin) | ~5 per island, 96 apart | 3 | Shelter on a long walk; a cabin by a lake is a reward for the climb |
| Dock (hut near villages) | a sand column at sea + 1 to + 2 whose sea floor, 30 cells out along the down-slope, is 3–28 cells deep (stilts reach it, the deck is over water) | 2–4 per island, 200 apart | (root only) | A way out over the water, somewhere to jump in from, and the fishing hut as a coastal home |
| Shipwreck | sand at sea − 1 to + 2, lying along the shore (her length across the down-slope) | 1–2 per island | 4 | A beach discovery: wood and steel to salvage, a story without words. Later, a keg in her hold |
| Lighthouse | a cliff headland: high cliff noise, ground sea + 8 to + 30, sea on more than half a 40-cell ring around it | 1 per island (2 on a large one) | 4 | The tallest landmark, seen from everywhere: navigation. The climb ends on a gallery over the sea, and its crystal lamp marks the coast at night |
| Watchtower | a hilltop in the meadow and pine zones: higher than every sample on a 24-cell ring, slope < 0.5 | 2–3 per island, 160 apart | 4 | A reason to climb a hill and a deck to see the next goal from. Pairs with an unlit campfire at its foot |
| Ruined keep | bare rock above the plant line, on ridges | 1–2 per island | 5 (rubble hides the rest) | A goal in the bare high country, which is otherwise empty; climb it for the island's best view |
| Standing stones | a gentle summit inside the plant zone, flat over 16 cells | 1 per island | 4 | A mysterious place, and the island's perk shrine on its altar (below) |
| Mine | a cave mouth (the caves' mouth list), else a steep slope (1–2 cells per cell) that rises 8+ cells over the gallery's length behind the portal; toward a coal seam where the strata have one | 2–3 per island | (portal only) | An entrance into the mountain that teaches the pickaxe: follow the rails and the crystal lamps to the face, and keep digging to the coal |
| Campfire (unlit) | beside docks, watchtowers, mines and village greens | with those | 1 | Unlit, so the world doesn't churn; lighting it is the player's choice (warmth and light at night) |

Not placed: greenhouse (its plants grow into its troughs), fountain (its CLONE overflows), igloo (ice melts in 20 °C air),
aquarium, oil drums and lit campfires.

### Settlements

A village is a site of its own (above), laid out from its seed: the well at the plateau's flattest point; 3–6 houses on
a ring 20–30 cells out at jittered angles, at least 24 apart, each turned so its door faces the well (the quarter nearest
the direction to it); a campfire on the green; paths from each door to the well as bare ground (the layer turns plant
cover to rock along the segments, a column function like the beach bands); and a dock when the shore is within 80 cells.
Every building in it clears its trees, so the village stands in a clearing. Variants follow the village's height: brick
and cottages low, cabins in the pines.

### Stability

A loaded world must not churn, so as generated: no lit fire, no CLONE, no ice, no water that touches plants, and no
loose powder that can move. Checked per structure by the physics lint (sealed water, contained and supported powder):
the well's water sits on its own stone floor, the mine's rubble is held by the cart's walls, the campfire's stones lie on
the ground. The crystal lamps glow but never change. The one powder that can settle is the igloo's snow, and the igloo is
not placed.

### Shrines

Since main's b7e502a every world gets a shrine near the god view's start, placed ad hoc in `app.js` (flat dry ground, trees
felled). I'd fold it into the layer:

- **The start shrine** stays (it is the onboarding), but as a site of the layer. The start window is deterministic
  (`worldStart`), so the site is too, and the far field and window moves treat it like every other structure. Its tree
  felling becomes the layer's clearing rule.
- **Reward shrines** as exploration goals: on the standing stones' altar (perk orbs are markers, so no extra cells: the
  layer records the altar's world position and `perkOrbs` sets orbs there), and in deep caverns from the caves' list (a
  cavern floor well below sea level and far from any mouth), the shrine construction lit by crystal.
- Hook: the layer exposes each placed structure as a record `{ key, variant, world cell, quarter, seed, altars? }`; the
  app sets shrine orbs from records with altars when their columns are first planted, instead of from `app.js`.

### The far field

Structures are few (a few dozen per island), so the far field can show each exactly rather than as a formula like the
trees: at world load, bake each placed structure on the CPU (milliseconds each), reduce it to the far grid's bricks
(4³ cells: dominant material, solid fraction) and write those texels over the terrain's in the far build. The clearing
mask above thins the far trees the same way the window's are thinned. Lighthouse, towers and ruins are the ones that
matter from afar; the crystal lamp's glow can ride the far field's glow channel.

## Verifying

- `npm run construct -- --builtins` (every variant ok, at sizes 1–24 and several seeds).
- The walk check (above): a scratch BFS; worth committing as a lint in phase 2.
- `tools/structures-shots.mjs`: stamps them all on the World island (an inland window and the start window's shore) and
  takes god and first-person stills. Phase 1's run used it without clearing trees or turning the mine downhill; it now
  fells the trees in each clearing (as `app.js` does for the shrine) and turns the mine to face downhill. Its census
  compares cell counts before and after a few seconds of sim.
