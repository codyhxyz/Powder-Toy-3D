# City Folk independent acceptance

## Executable delivery and current evidence

Run from the integration checkout with its installed dependencies:

```sh
node --check tools/check-city-folk.mjs
node --check tools/check-city-folk-bus-acceptance.mjs
node --test tools/check-city-folk.mjs
```

This is an independent CPU acceptance suite, not a plan or a world implementation.
It imports the production `willowCoveTwin` and inspects **composed cells**, including
body envelopes, supports, water volumes, doors and authored nature materials.
Missing modules, metadata, protected-path functions or scenery FAIL; nothing is
conditionally skipped. Bus checks use the real controller, real focus loop,
real arrival-clearance routine, composed generator, and `BrickStore` codec with
edited live-cell reads. No browser, dev server, GPU, new dependency or bypass.

Baseline lane evidence (integration base `1b43dcc4ae126a92834f12a16637d945d9719fb0`):

- Both syntax checks passed.
- Complete suite: **5 passed, 8 failed, 0 skipped** (13 groups), 2.53 seconds CPU wall time.
- Passing: identity/aliases/modes/rolling-log setting and solo/co-op dimensions;
  solo save preparation; **all 134,217,728 legacy cells**, independently compared
  to the immutable pre-feature generator; original cottage/furniture/controller
  regressions; every cell of the original sprint circuit's body envelope.
- Red: terrain metadata/source, town, nature, city and transport modules have not
  been merged/composed in this lane. These are expected integration failures,
  **not evidence that the completed world is accepted**.
- Initial attempts exposed missing local dependencies; an ignored, lane-local
  `node_modules` symlink reuses the installed sprint checkout dependencies.
  No dependency files were modified. A harness output regex was corrected from
  `passed` to `pass`; the unchanged village behavior test genuinely passes.
- A separate read-only CPU composition of the transport lane's actual city source
  validated the bus acceptance harness: roundtrip, edited landings, cancellation
  races, mode isolation and finite focus checks all pass. This is component/harness
  evidence **only**, not final composed-world acceptance. The remote-boarding
  fixture uses a 64-cell offset; the published town boarding radius is22 cells.

The integrator must rerun the full command and update this evidence after joining
all lanes. A grouped test stops at its first assertion: later assertions in that
group are **unverified until the entire group passes**.

## Requirement-to-evidence checklist

`PASS(base)` establishes a preserved invariant on the assigned base, not final
integration. `RED/pending` means an executable assertion exists but has no passing
composed-world evidence yet. IDs match TAP test names.

| ID | Finished-world requirement | Executable evidence | Current status |
| --- | --- | --- | --- |
| F01 | Upper/lower neighborhoods, winding cliffs, broad ramps | Unit-rise six-cell-wide ramp sweeps; composed elevation across multiple non-collinear cliff points; new cottages at floors 48/24 | RED/pending |
| F02 | Meandering river, fork, small island, connected waterfalls | Every rasterized river/fork column is wet and bed-supported; adjacent wet vertical intervals connect; shared fork junction; dry body-clear island with four-direction wet samples and bounded dry-land flood-fill; tall falls | RED/pending |
| F03 | Separate small ponds in clearings | At least two wet, bed-supported small pond centers; four body-clear banks per pond; bounded wet-component flood-fill proves isolation from river reaches | RED/pending |
| F04 | Southern beach, coves and river mouths | Sand-supported body-clear southern beach points; southern wet mouths; coastline scan proves cove indentation relative to shoulders | RED/pending |
| F05 | Open meadows between landmarks | At least two 24-cell-wide clearing sweeps with support, body clearance and bounded slopes | RED/pending |
| F06 | Existing 552m straights and 1.14km closed circuit | Exact 552m/3808-cell dimensions; complete loop sweep; both straights at floor24 across the full six-cell envelope | PASS(base) |
| F07 | Scenic woods/riverside/cliff branches | Published scenic polylines rasterized against composed support/clearance and `cfPath`; connectivity to plaza; nearby wooded/wet/cliff context assertions | RED/pending |
| F08 | Additional bridges, alternate loops, shortcuts | More composed timber bridges than old three; two closed alternate cycles; shortcut sweeps; one connected route graph | RED/pending |
| F09 | Dirt paths and worn grass near busy places | Actual stable brown sandstone at published worn-ground site; protected routes remain clear and reserved floors unmodified by nature | RED/pending |
| F10 | Upper cedar woods, lower hardwood groves | Multiple actual trunks/crowns in declared regions; upper cedars/lower hardwood elevation; differing canopy/trunk volumes | RED/pending |
| F11 | Native-fruit trees, small orchards, flower patches | Multiple orchard trees with real red apple clusters; authored flower material at declared clearing | RED/pending |
| F12 | Beach palms, scattered rocks, shells, buried discovery spots | Multiple beach trunks/fronds distinct from hardwoods; authored rock/shell cells; limestone discovery below surface | RED/pending |
| F13 | Town hall, event square, bulletin board | Above-ground building/board geometry, square pavement, usable approaches, doors and graph reachability | RED/pending |
| F14 | Distinct Nook-/Able-inspired shopping buildings | Both real above-ground structures; distinct voxel footprint hashes; clear doors linked to plaza | RED/pending |
| F15 | Museum with café entrance | Both real structures, external entrances, café/museum adjoining doorway and access polylines | RED/pending |
| F16 | Additional upper/lower cottages | Four additional structures at floors48/24; all entrance body checks and route reachability | RED/pending |
| F17 | Vacant plots | At least two paved empty body-clear centers, physical survey stakes, entrance access | RED/pending |
| F18 | Northern gate and bus stop | Gate structure/passage; real bus shelter; clear boarding apron and connection to plaza | RED/pending |
| F19a | Separate city district, square, distinct commercial façades | City bounds independent of town/sprint; square/arrival body sweeps; three different authored façades | RED/pending |
| F19b | **Separate city physical access** | Independent city-only route graph from arrival to square and every commercial entrance, not inferred from town graph | RED/pending |
| F19c | Working city bus and return | Real discoverable boarding/return; focus-held edited arrival scans; roundtrip absolute coordinates; input freeze and duplicate-trip refusal | RED/pending |

| ID | Invariant | Evidence | Current status |
| --- | --- | --- | --- |
| I01a | Tinker Creek key, aliases, Animal Crossing and rolling log | Registered map/scene, `tinkerCreek` alias, mode availability and `effect === rollingLog` | PASS(base); rendered effect still manual |
| I01b | World3072×128×1024, unchanged simulation window | Exact dimensions; production `setGrid` invoked in CPU VM with128³; wrong height rejected | PASS(base) |
| F06 | Flat dry full-body sprint straights | Every x and full envelope, not selected center samples | PASS(base) |
| I04 | Original four cottages, doors, furniture and behavior | Exact home/entry/furniture coordinates; door voxel volumes; unchanged real-controller interaction suite executed | PASS(base) |
| I03 | Exact1024×128×1024 legacy geometry | Exhaustive cell comparison to fixed pre-feature commit, not a regenerated golden or sampled core | PASS(base) |
| I01/I02 | Solo/co-op load both sizes | Real `prepareSave`; production `setGrid`; saved origins/header unchanged; unsupported sizes rejected | PASS(base) |
| I05 | Streaming/far field/CPU consistent scenery | Same composed shared functions emitted to WGSL and callable in twin; CPU WGSL parser; independent ground scan on3000 columns×4 seeds and slab/world boundaries | RED/pending; actual GPU parity remains parent-owned |
| I06 | Bus preserves voxel edits | Real codec stores edited town/city bricks including temperature/velocity bytes; byte-for-byte store identity/content after roundtrip and refused journeys | RED/pending |
| I05/I06 | Deterministic bounded generation, no per-cell async | Valid integer cells repeated at boundaries across4 seeds; ground scans; focus loop nonconvergence checked at finite maximum | RED/pending |
| I05 | Existing shared-source machinery/dependencies | Actual composed twin functions and parsed WGSL definitions; no hand-ported overlay or added dependency | RED/pending |
| I07 | Original artwork/building shapes | Distinct composed structures are executable evidence; asset provenance and visual identity require source/art review, never infer originality from exports | **UNVERIFIED manual review** |
| I06 | Cancellation and isolation | Cancel during pending edited-cell reads; mode/inactivity/death/epoch/replacement/origin invalidation; remote boarding, legacy-size, non-Tinker and disposed bus rejected | RED/pending |

## Production seams and integration instructions

No test-only application hook is required. All coordinates are **island-local
cells**, not metres; `wcCell` receives `[x + worldX/2, y, z + worldZ/2]`.

1. Compose terrain, nature, town, city into `willowCove` for expanded worlds only.
   Preserve the legacy branch exactly. Nature runs before town. Export
   `CITY_FOLK_TERRAIN` from `willowCove.js`; the suite reads its published metadata.
   Keep `wcHeight` and expose `cfHeight`, `cfTerrainCell`, `cfPath`,
   `cfTownReserved`, `cfNatureCell`, `cfTownCell`, `cfCityCell` in the actual twin
   and emitted source. All real paths, including final town approaches, need
   `cfPath` protection. Do not replace the twin with a testing fixture.
2. Terrain adapter accepts current `routes` records (`name`, `points` or
   `curve/from/to`) and `landmarks` (`meadows`, `ponds`, `island`, `coves`,
   `mouths`, `waterfalls`, `bridges`). It derives dense curve samples using the
   actual shared `cfWoodsZ`, `cfCliffZ`, `cfRiverX`, `cfForkX`, `cfHighEdge`.
   Alternate lower cycles close along the existing sprint straight. The original
   plaza-to-circuit and original cottage connectors are included explicitly.
   Town-to-curved-woods centerline offsets are swept as additional short links.
   Update adapters to final
   published names if needed; do **not** delete blocked route assertions.
3. Town metadata uses records `{at, entry, floor, half}`: `townHall`,
   `eventSquare`, `bulletinBoard`, `nookShop`, `ableShop`, `museum`, `cafe`,
   `cottages`, `plots`, `gate`, `approaches`, `reservedFootprints`.
   The boarding record comes from `CITY_FOLK_CITY.landmarks.townStop`.
   The café's `museumDoor` is a separate required entrance.
4. Nature metadata currently declares regions `cedarWoods`, `hardwoodGrove`,
   `nativeOrchard`, `beachPalms` and points `flowerPatch`, `rocks`, `shells`,
   `discovery`, `wornGround`. Tests find actual lattice trunks in those regions
   and inspect volumes/materials, never pass merely because a kind is named.
   Orchard bounds use its published ints. Small scenery has explicit expected
   existing element IDs, not expectations generated from the composed output.
5. City metadata: `square`, `emporium`, `tailor`, `theatre`, `townStop`,
   `cityStop`, `townArrival`, `cityArrival`; arrival arrays are `[x,y,z]`.
   City walkways are independently swept from arrival to square and all doors.
   Agreed bounds `x=-160..160,z=-440..-280`, floor48; square `[0,-352]`,
   arrival `[0,48,-304]`, doors `[-88,-376]`, `[0,-384]`, `[88,-376]`.
6. Bus exports from `src/pov/village/bus.js`: `createCityBus`,
   `withCityBusFocus`, `cityBusArrivalClear`, `CITY_BUS_STOPS`. The injected
   adapter shape is the real transport API (`getWorld/getSim/getMode/getPlayer`,
   `active`, `withVillageFocus`, `requestRender`, `notify`). The CPU adapter
   shifts128³ origins in16-cell steps without replacing world/store and reads
   generator cells plus decoded edits. This checks the real helper contract;
   parent must also verify the actual village E-action/app wiring, streaming
   slabs and rendered UI. A passing helper is **not** proof that E is wired.

## Review and release gates still owned by parent

- Rerun composed CPU suite; record every TAP failure and fix implementation or
  metadata composition, not by skips or weaker assertions.
- Review scenic contextual identity, original art/provenance, distinguishability
  of landmarks, noticeability of boarding, and actual E/cancel wiring.
- Confirm scenic shoreline appearance visually. CPU tests include bounded dry-land
  flood-fill for the river island and wet-component flood-fill for each pond;
  these are not proofs of rendered shoreline quality.
- Real GPU twin/streaming/far-field equality, rolling-log appearance and actual
  edited-slab persistence are not established by the injected CPU simulation.
- Production build, independent review, GitHub deployment and live-site checks
  remain **not run** by this lane. GPU/browser launch is explicitly forbidden
  here; only parent can arrange a compliant slot.
- Shop economies, fishing, resident AI and collections are outside scope and
  are not acceptance dependencies.
