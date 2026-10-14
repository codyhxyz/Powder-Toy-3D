# City Folk composed-world acceptance evidence

## Scope and provenance

Integration started at `bd15dca37a9b843801506a216809e80e7f61d408`, branch
`city-folk-world`, after a successful fetch: 7 ahead / 0 behind origin/main.
The completion contract is `docs/city-folk-world-contract.md` (unchanged).
Original lane commits verified and cherry-picked:

- Terrain: `e2569cb422fa24f6e628e40240f7776e2a280f24` → `80de37d`
- Town: `0b2f2c6772067238f3ab3c6dbbdfc05e84ffd3f8` → `47c0e46`
- Nature: `22dab51f2d400f6744cf94724c1028dc7fd72ab8` → `1a98c79`
- City/bus: `8e930e2adb0f196a40dc71290a1d06774b4f649e` → `bf23938`
- Independent acceptance: `3a1d74c3725963e1e9855b975a7a740baa13c8b6` → `e2768a8`

The independent acceptance lane originally reported 5 passing / 8 failing
baseline groups. Those initial reds were NOT accepted as completion. The final
composed suite passes **13/13 groups, zero failures/skips**, about **4.41 seconds
CPU wall time**. This includes **134,217,728 exact legacy cell comparisons**
against immutable pre-feature commit `1b43dcc4ae126a92834f12a16637d945d9719fb0`.
CI checkout fetches full history to make that comparison reproducible.

No browser, dev server, GPU process, player-detection bypass, push or deployment
was performed by the integration writer. GPU occupancy: **0 seconds**.
Independent review and release remain required; CPU success is not deployment.

## Integration changes inspected by the tests

- A single bounded `wcCell` wrapper composes BASE → nature → town → city →
  town bus stop for expanded worlds only. All module constants/types and shared
  source feed both the JS twin and WGSL. Bounds precede overlays. No global
  original-core X guard skips the city at `[0,-352]`. Nature support queries
  only `cfHeight` / `cfTerrainCell`, never the composed cell recursively.
- Terrain pads match both actual shops, square, museum/café, cottages, vacant
  plots and door approaches. Town approach metadata feeds the route mask and
  connected graph. Upper doors use a high avenue at Z=-94, clear of plot stakes;
  its additional bridge retains river water beneath the deck. The west plot
  also retains the channel beneath its pad instead of damming the waterfalls.
- Broad ramps retain one-cell rises and level treads. West rise joins the gate
  apron smoothly; east rise begins beyond the café pad. Hall and lower-home
  approaches go around shells, not through closed back walls. The eastern woods
  connection uses the open café/museum corridor and the museum's south entrance.
- The actual longitudinal riverside branch follows Z=36..100, 20 cells west of
  the meandering channel, connected at both ends. Its nearby water is inspected.
- Flower/rock/discovery samples moved from protected Z=100 to actual dry Z=120.
  Tree regions encompass multiple generated roots. Eastern mid-terrace cedars
  provide real context for the woods branch; beach palms occupy the outer dry
  beach rather than invalid cove-edge samples. New dirt trails use stable brown
  sandstone, while the original circuit/core retain their brick surfaces.
- Shelters leave gate/boarding clearance intact and the city walk to the square
  clear. Expanded ground scans include tall city roofs above the old 80-cell cap.
- Acceptance adapters now use published unobstructed cliff samples rather than
  sampling the new high avenue as a cliff. Assertions were not weakened or
  skipped. Added assertions inspect dirt trails, the composed adjacent gate
  post/roof, the west river reach, and emitted town-stop WGSL.
- Terrain lane tests explicitly inspect BASE pads (buildings occupy them after
  composition); independent acceptance still inspects actual composed cells.

## Finished-world checklist

All PASS entries below mean **CPU composed-world evidence**, not visual sign-off.
IDs match the independent suite's TAP names.

| ID | Requirement | Passing evidence |
| --- | --- | --- |
| F01 | Upper/lower neighborhoods, winding cliffs, broad ramps | Unit-rise body-envelope sweeps, level broad treads, physical winding cliff samples, homes at floors 48/24 |
| F02 | Meander, fork, small island, connected waterfalls | Every east/west reach and fork column wet with bed support; adjacent vertical water intervals connect; fork junction; bounded dry island flood-fill; tall falls |
| F03 | Separate small ponds in clearings | Two wet supported centers, body-clear banks, bounded isolated wet-component flood-fill |
| F04 | Southern beach, coves, river mouths | Sand-supported clear beaches, wet mouths, physical shoreline indentation scans |
| F05 | Open meadows | Multiple 24-cell-wide body-clear clearing sweeps |
| F06 | Existing 552m straights / 1.14km closed sprint circuit | Exact 552m and 3808-cell/1142.4m dimensions; complete circuit and six-cell-wide straight envelopes remain flat, dry and clear |
| F07 | Woods/riverside/cliff scenic branches | One connected protected graph; nearby composed tree trunks/cliff elevations/water; riverside Z span >=24 with >=24 actual wet neighboring samples |
| F08 | Bridges, alternate loops, shortcuts | 15 new timber bridge samples, two closed alternate cycles, connected shortcut sweeps |
| F09 | Dirt paths and worn grass | Actual sandstone dirt trails and busy-route wear; protected routes and reserved town surfaces preserved |
| F10 | Upper cedar woods / lower hardwood groves | Multiple actual trunks/crowns in declared regions; upper/lower elevations; distinct voxel volumes |
| F11 | Native fruit, orchards, flowers | Multiple actual apple trees with red fruit; generated flower material in dry clearing |
| F12 | Palms, rocks, shells, buried discoveries | Multiple dry beach palms with distinct fronds; real rock/shell cells; buried limestone and surface dig mark |
| F13 | Town hall, square, bulletin board | Above-ground structures, square pavement, doors and graph reachability |
| F14 | Distinct supply/tailor shops | Different façade hashes, actual supported structures, connected clear entrances |
| F15 | Museum and café | External entrances, adjoining café/museum doorway, connected approaches |
| F16 | Additional upper/lower cottages | Four new structures, all doors clear and connected |
| F17 | Vacant house plots | Empty supported centers, survey stakes, accessible entrances |
| F18 | Northern gate and bus stop | Gate passage, real shelter/apron, connected boarding, composed adjacent gate post and roof preserved |
| F19 | Separate city and return bus | Separate square and three distinct façades; independent city entrance graph; real controller/focus/edited-clearance roundtrip |

## Invariants and regression evidence

| ID | Invariant | Passing evidence / remaining limit |
| --- | --- | --- |
| I01 | Identity, aliases, Animal Crossing, rolling-log presentation | Registered key/alias/modes and rolling-log setting unchanged; rendered effect still parent-owned |
| I01 | World and simulation dimensions | 3072×128×1024 world; unchanged window; real production `setGrid` exercised in CPU VM |
| I03 | Exact legacy geometry | Every cell of 1024×128×1024 compared to fixed pre-feature generator; unchanged golden hash also passes |
| I04 | Original cottages, doors, furniture and behavior | Exact coordinates/door volumes and real village interaction controller regressions |
| I01/I02 | Solo/co-op loading of both sizes | Real save preparation / setGrid paths; supported dimensions and saved origins retained, unsupported sizes rejected |
| I05 | Determinism and bounded generation | Four seeds, slab/world edges, valid integer IDs, 3000 independent ground columns per seed; finite focus convergence bound; no per-cell async |
| I05 | Shared CPU/streaming/far-field scene source | Actual composed callable functions and emitted WGSL parsed with WgslReflect, including town stop; GPU execution/parity remains parent-owned |
| I06 | Store persistence and player/furniture state | Real BrickStore codec edits including non-ID state bytes survive roundtrip/refused journeys; identity preserved; status/health/furniture fixtures retained; real village E/controller checked by bus lane |
| I06 | Safe edited arrival and cancellation | Occupied/missing/wet support refused; focus held through reads; cancellation, mode/inactive/death/epoch/world replacement/origin races reject stale teleport |
| I06 | Other-mode isolation | All non-Animal-Crossing modes, non-Tinker scene, legacy geometry, remote boarding and disposed controller refuse transport |
| I07 | Original art and identity | Original authored source shapes/materials, distinct composed hashes; independent source/art/visual review still required |

## Commands and outputs

- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`: passed; 55 packages installed.
  Existing dependency audit reports **2 moderate vulnerabilities**; no dependency
  files changed, no unrelated upgrade was attempted.
- `node --check tools/check-city-folk.mjs` and bus-acceptance syntax check: passed.
- `node --test tools/check-city-folk.mjs`: **13 passed, 0 failed/skipped**.
- Four `node tools/check-city-folk-{terrain,town,nature,bus}.mjs`: passed.
  Terrain: 10180 body-width samples, 9835 connected centerline cells, 14 grounded
  pads, 15 bridges, 3 falls. Town: 9 buildings, 63756 clear body cells. Nature:
  6394 face-connected tree voxels. Bus: actual village E wiring and lifecycle.
- `node tools/check-willow-cove.mjs`: passed; 12,864,080 valid authored legacy
  cells, 5982 route samples; sprint circuit 4731 envelope samples.
- All 12 `tools/check-village*.mjs` CPU checks: passed (actions, catalogue,
  collision, crook, debt badge, interactions, jump, orders, punch, residents,
  speech, core village).
- `node tools/check-sprint.mjs`, sprint-blur and sprint-music checks: passed.
- `node tools/saves-check.mjs`: lossless cells/files/store/registry tests passed.
- `node --experimental-vm-modules tools/world-coop-cpu-check.mjs`: passed;
  production codec/transport/avatar/body tests, no GPU.
- `node tools/check-browser-launch.mjs`: passed; 12 pre-existing legacy launchers.
- `git diff --check`: passed.
- `npm run build`: passed. Existing browser-externalization and large-chunk
  warnings remain; no new dependency or asset was introduced.

The composed and four component CPU checks are registered in the deploy workflow.

## Required parent review / release gates (not claimed complete)

1. Review this composed implementation and test/adaptor changes independently.
2. Review original artwork, clear landmark identities, scenic shoreline quality,
   rolling-log appearance and discoverability of bus controls visually.
3. Verify actual GPU compilation, streaming/far-field/CPU parity, real app focus
   lifetime, E/Esc cancellation and edited slab persistence. Injected CPU evidence
   is not a replacement for these checks. Use only parent-approved <=10-second
   total GPU slots; no bypasses.
4. Fetch and reconcile any production commits newer than the assigned base,
   push main, watch successful GitHub deployment and check the live site.

No known unmet implementation bullet remains in the checked CPU scope. Shop
 economies, fishing, new AI and museum collections remain deliberately out of scope.
