# World structures

The island's built things: what they are, where the generator puts them and why. The constructions themselves are
ordinary built-ins (`src/constructions/builtins.js`, `src/constructions/structures.js`); this doc is about their scale and
their place in the world. Phase 1 built and checked them; phase 2 placed them on the island (`src/world/structures.js`).

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

## Placement (`src/world/structures.js`)

### The layer, as built

- **Placement** is a pure function of the world P (`structuresOf`), computed once per world on the CPU twin
  (`islandTwin`): in each 64 × 64-cell square, each kind tries up to 6 hashed points (the lighthouse 48) and keeps the
  first whose ground suits it (its site rule, below). Then the whole world's candidates are thinned at once: kinds in
  rank order (rare and grand first), best site first, each kept while its box stays a GAP (8 cells) clear of every kept
  box, it is its kind's spacing from others of its kind, and its kind is under its cap. One list per world, so every
  window and the far field agree by construction. ~0.5 s per world on the CPU (once, at load; most of it the twin's
  noise for fresh columns). Seeds 20261008, 1, 2, 3 give 24–28 structures each.
- **Drawn in the scene's cells, not stamped.** Each structure's construction is baked (size 5, its quarter, one of 8
  seeds a kind) into an R8UI cell atlas; an RGBA8UI brick-column index says which structure's box covers a column
  (and which columns are a clearing); an RGBA32I table holds each box. The island's `sceneCell` applies them over its
  own cell (`STRUCT_GLSL structureCell`), with the footing grown exactly as `shaders/stamp.js` grows one (down through
  what bears no weight, to ground within the construction's footing depth). So the window's fill, its diff (a structure
  is generated, never an edit, so it costs the store nothing), the far field's build and every window move see the same
  cells. A CPU twin (`structureCellAt`) does the same for tools.
- **Trees give way** before thinning: `generator.js treeCandidate` and the island's `sceneTreeCandidate` drop a
  candidate whose trunk is within `TREE.REACH` of a structure's box (the index's clearing channel), so no crown reaches
  one and the GPU's far trees match the window's exactly.
- **Footing and facing.** The base sits on the highest ground under the box (ground sampled a brick apart), and
  buildings face uphill (village houses face their well), so the door is one step up; the downhill side shows the
  plinth. The mine and the dock sit on the ground at their origin and face downhill (into and out of the slope); a
  campfire sits on the lowest ground under it, so its stones always rest on ground.
- **The start shrine** (main's ad-hoc placement in `app.js`) now skips any spot in a structure's clearing. To move it into
  the layer fully: add a `shrine` kind whose rule is app.js's (flat dry ground nearest the start window's middle),
  ranked first with cap 1, and have the app set its orbs (`onPlaced`) from the placed record's `SHRINE_ALTARS` when the
  window first loads it, instead of stamping it; its tree felling is then the layer's clearing. The orb hook is the only
  app-side change.
- **Other scenes.** The mechanism (textures, `STRUCT_GLSL`, the tree clearing) is general: a scene includes
  `STRUCT_GLSL`, defines `structureGround`, calls `structureCell` in its `sceneCell` and adds `structureUniforms(P)`
  to its uniforms. The site rules read the island's twin (`genTop`, `genCover`, `genSlope`, `column`), so another scene
  needs those functions in its twin, or rules of its own.

### Measured (GPU run, `tools/structures-check.mjs`)

- Far build, all 256 chunks with a forced sync, structures on vs off, alternated: 853 vs 861 ms median, so no measurable
  cost: one integer texel fetch a sample. (Under another session's 99% GPU load: absolute times are inflated.)
- Stability: 0 cells changed element after 600 steps in a window over a village and one over a dock.
- Seams: a cottage across the window's +x edge, the window walked 3 steps over it, against a fresh load at the same
  origin: 0 of 40,320 cells differ.
- Trees: the far field's GPU placement against `treesIn` (`tools/far-check.mjs` step 6): 313 the same, 0 differ.
- The box's Island preset (structures off): `tools/gen-check.mjs` stability 0 changed, twin 0 cells differing, seams 0.
- First person: spawned 6 cells outside a village house's door and walking in for 1.8 s ends inside it.

### Wiring after landforms and caves merge

The rules that depend on them are keyed to twin functions; when the twin has them, the rules follow:

- **Headlands (landforms):** export a column function `islandHeadland(x, z)` (> 0 on a cliff headland) in the
  landforms source; the twin then has `T.islandHeadland`, and `structures.js headland` uses it in place of today's
  fallback (sea on 20% of a 36-cell ring, the most seaward high ground winning).
- **Cave mouths (caves):** export `islandCaveMouth(x, z)` (> 0 at a mouth on a steep bare-rock slope); `caveMouth`
  then places the mine there, facing out of the slope, instead of on today's fallback (a 0.45–2.6 slope with the
  gallery's back half under 9 cells of ground). The mine's gallery then carves into the cave or toward a coal seam.
- **Tarns (landforms):** `islandLakeClearance(x, z)` and lake water levels: the `site()` wet check already rejects
  boxes over standing water (`column(x, z)[3] > genTop`). Add a `hermit` kind (a cabin within 24 cells of a lake,
  `islandLakeClearance` small but positive) ranked after `watch`, cap 2.
- **Ria and gorge (landforms):** a dock rule for an inlet's sheltered shore works as is (sand at sea + 1..2 with
  water ahead). A bridge over the gorge needs a new construction (a timber span with a footing at each end) and a rule
  that finds the gorge's narrowest crossing between two rims of equal height.
- **Strata and coal (rocks, landforms):** nothing to wire: structures are drawn over whatever the island's cells hold.

### Where each one goes

| Structure | Where | How many, how far apart | Max rise under it | What it adds for the player |
| --- | --- | --- | --- | --- |
| Village: wells, cottages, brick houses, a campfire | a meadow plateau (plant cover) at least 64 cells across, rise ≤ 6, within 80 cells of the sea or a lake | 1–2 per island, 300 apart | 2–3 per building | A place: houses to walk into, with beds and hearths, the first sign that someone lives here. The well is the landmark you navigate back to |
| Lone cottage or cabin | meadow below the plant line; cabins in the pine zone (above 0.3 of the relief) and by mountain lakes (the hermit's cabin) | ~5 per island, 96 apart | 3 | Shelter on a long walk; a cabin by a lake is a reward for the climb |
| Dock (hut near villages) | a sand column at sea + 1 to + 2 whose sea floor, 30 cells out along the down-slope, is 3–28 cells deep (stilts reach it, the deck is over water) | 2–4 per island, 200 apart | (root only) | A way out over the water, somewhere to jump in from, and the fishing hut as a coastal home |
| Shipwreck | sand at sea − 1 to + 2, lying along the shore (her length across the down-slope) | 1–2 per island | 4 | A beach discovery: wood and steel to salvage, a story without words. Later, a keg in her hold |
| Lighthouse | a cliff headland (landforms' `islandHeadland`); until then the most seaward high ground: sea + 4 to + 40, sea on at least 20% of a 36-cell ring, the highest share wins | 1 per island | 4 | The tallest landmark, seen from everywhere: navigation. The climb ends on a gallery over the sea, and its crystal lamp marks the coast at night |
| Watchtower | a hilltop in the meadow and pine zones: higher than every sample on a 24-cell ring, slope < 0.5 | 2–3 per island, 160 apart | 4 | A reason to climb a hill and a deck to see the next goal from. Pairs with an unlit campfire at its foot |
| Ruined keep | bare rock above the plant line, on ridges | 1–2 per island | 5 (rubble hides the rest) | A goal in the bare high country, which is otherwise empty; climb it for the island's best view |
| Standing stones | a gentle summit inside the plant zone, flat over 16 cells | 1 per island | 4 | A mysterious place, and the island's perk shrine on its altar (below) |
| Mine | a cave mouth (caves' `islandCaveMouth`); until then a slope of 0.45–2.6 (the island's steepest are ~0.8) whose ground is 9+ cells over the gallery's back half, its spur over lower ground | up to 3 per island | (portal only) | An entrance into the mountain that teaches the pickaxe: follow the rails and the crystal lamps to the face, and keep digging to the coal |
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

Structures are part of the scene's cells, so the far field's build draws them at brick scale like the terrain (the
lighthouse, towers and roofs read from across the island), and a structure the window has visited comes back from its
summaries like everything else. No separate bake.

## Verifying

- `npm run construct -- --builtins` (every variant ok, at sizes 1–24 and several seeds).
- The walk check (Scale, above): a scratch BFS, worth making a lint.
- `tools/structures-check.mjs [outDir] --port N`: placement by kind, the far build's cost with structures on and off,
  stability over a village and a dock, a seam across a window edge, and stills (a village, walking into one of its
  houses, the lighthouse, a dock, a wreck, the far field from a hilltop).
