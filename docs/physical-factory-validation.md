# Physical factory validation

Status: unreleased. The native backend batch passed; actual tool strokes and repeat refueling remain unverified.

## CPU evidence

The integrated controller and UI pass:

- `node --test tests/industry/*.test.js`: 40 tests.
- `node scripts/check-industry-controller.mjs`: 11 checks.
- `node scripts/check-industry-factory-ui.mjs`.
- Existing construction, transfer, and Quarry checks.
- Hearth budget/conduction/structure checks: 356 checks, including finite native combustion and the rotated shell.
- Diagnostics request ownership, freshness, reset, and disposal regressions.
- Naga type validation of composed Industry, transfer, construction, diagnostics, gate, and control shaders.
- Pump backplate rotations, atomic construction, strict ownership, legacy preservation, and lossless marker saves.

Fresh integration review found two additional input problems.
Canvas placement now releases number-input focus, so Escape and Q remain available.
Inspection no longer captures driving input.
Both fixes have CPU regressions.

## Native GPU evidence

The commands used an isolated Vite server on strict port 19973.
Each invocation used `tools/browser.mjs`.
Earlier runs used ten-second slots. The fetched policy now allows 25 seconds total.
Every busy-check override had explicit user approval.
The later protected retries did not bypass protection.
Browsers closed after each run.

### Gates and controls: passed

Command:

`node tools/industry-physical-check.mjs --case mechanisms --port 19973`

Total slot occupancy: **7093 ms**, including startup and cleanup.

Verified on the actual 128³ simulation:

- Closure creates tagged shutter matter; opening removes it.
- An occupied aperture rejects closure without deleting foreign WALL.
- Partial shutter damage does not regenerate missing matter.
- Dismantling removes tagged cells and preserves foreign matter.
- A real battery energizes the signal port.
- TSNS placement writes its actual temperature threshold.
- Occupied control placement fails without overwriting the cell.
- SWITCH toggling writes ON=10 and the native OFF countdown=9.
- A native falling sand grain enters the aperture and blocks closure without deletion.

Report: `~/.cache/tpt-headless/runs/16439-16470.json`.

This does not prove every material, orientation, or long-running circuit.

### Thermal investigation and compact-shell pass

The first cold fixture used two fuel cells and four scrap cells.
Ignition, reduced fuel life, and native-step timing were observed.
No SCRAP-to-LAVA(METAL) transition was observed during 4800 native ticks.
Fuel became ash; final sampled scrap temperatures were approximately 111°C.
Peak temperatures were not recorded, so the final temperature is not the peak.

Total slot occupancy: **7285 ms**.
Report: `~/.cache/tpt-headless/runs/17538-17570.json`.

A second attempt loaded the full twelve-cell firebox.
The harness deadline expired before it returned observations.
No thermal conclusion can be drawn from that attempt.
Total slot occupancy: **7469 ms**.
Report: `~/.cache/tpt-headless/runs/24329-24360.json`.

The harness now records peak temperatures and retains charge in a physical well.
That checkpoint tests melting, not drainage.
Its case deadline now precedes the outer evaluation deadline.

The next attempt was refused because measured GPU use was 52%.
The launcher released the slot after **1997 ms**, before opening a browser.
There was no retry until the user confirmed they were idle.

After the user confirmed they were not playing, one protected retry completed.
The twelve-cell firebox reached 2200°C; charge peaked at 1076.8179°C.
No melt was observed after 1200 native ticks.
Total slot occupancy: **6428 ms**.
Report: `~/.cache/tpt-headless/runs/95544-95588.json`.

The boost previously spent nominal fuel even when its source-temperature cap discarded heat.
It now charges only for heat actually delivered.
Native combustion still spends fuel, and CPU checks prove the source remains finite.
An app-based retry reached a charge peak of **1273.66°C** after 768 native ticks.
The sampled COAL cell retained 0.5257 life.
The bounded run still did not observe a melt.
Total slot occupancy: **6469 ms**.
Report: `~/.cache/tpt-headless/runs/17036-17075.json`.

An optional `--harness` mode now uses the existing native Simulation harness.
It retains the 128³ physics fixture but omits app graphics startup.
This mode cannot prove UI/controller interaction.
Its first attempt was refused at 93% measured GPU load before opening a browser.
The slot was released after **1968 ms**.
GPU load alone does not establish that the user is playing.
No busy-check override was used.

The CPU investigation also found a construction mismatch:
the diagnostic fixture seeds one-cell tungsten walls and an internal baffle.
The Factory builder cannot currently reproduce that arrangement.
Even a melt in this fixture would not prove a player-buildable production line.

The next fixture replaces that diagnostic lining with real atomic construction:
one hearth and sixteen standard foundations form an open batch tub.
Its containment has 256 tungsten cells, outside the hearth reservation.
The test starts with four scrap cells and 44 physical BROKENCOAL cells at 20°C.
There is no intact COAL or internal baffle.
The geometry passes normal bounds and overlap validation.
The user approved one ten-second busy-check bypass for this fixture.
That attempt stopped before returning observations: **6144 ms** total.
The newer watchdog reserves four seconds before the slot ends for cleanup.
No thermal conclusion came from that attempt.

A normal protected run used the new 25-second slot limit.
It finished in **5729 ms**, including startup and cleanup.
All 44 broken-coal cells burned, but sampled scrap peaked at **1142.59°C**.
No melt was observed after 4800 native ticks.
Report: `~/.cache/tpt-headless/runs/40922-41407.json`.

The hearth now constructs a thin, real tungsten shell within its existing reservation.
It has 48 cells: a 16-cell floor and 32 wall/lip cells.
The open top permits loading and extraction.
The rear fuel row holds six cells; the front charge row holds six cells.
The raised outlet retains a molten heel; overflow is not a complete emptying mechanism.

**The compact shell passed a native melting checkpoint.**
The normal protected run used the actual atomic constructor, not painted test walls.
Six cold BROKENCOAL cells and four cold SCRAP cells started at 20°C.
All four scrap cells were observed as LAVA with METAL ctype.
The checkpoint took 336 native ticks in four-tick batches.
Fuel peaked at 2200°C; sampled charge peaked at **1639.69°C**.
No asynchronous API errors were reported.
Total slot occupancy: **5271 ms**.
Report: `~/.cache/tpt-headless/runs/81872-81905.json`.

This proves finite-fuel ignition and native melting in buildable containment.
It does not prove real shovel loading, ash clearing, bucket extraction, cooling, or shipment.

CPU geometry command:
`node tools/industry-physical-check.mjs --case thermal --preflight`.

### Bounded diagnostics: passed

Command:
`node tools/industry-physical-check.mjs --case diagnostics --harness --budget-ms 25000 --port 19973`.

The first protected attempt was refused at 50% measured GPU load.
It released the slot after **1940 ms**, before browser launch, and supplied no diagnostic measurements.

A later protected run passed all 14 native assertions.
Total slot occupancy: **5981 ms**.
Report: `~/.cache/tpt-headless/runs/13933-13970.json`.

Verified:

- The rotated physical shell matches the 48-cell construction geometry.
- Default hearth regions sample six fuel, six charge, and four outlet cells.
- Exhausted coal is not reported as usable fuel.
- A real OFF switch does not disable optional built-in drive.
- Required drive stops on OFF and reports ready on ON.
- A damaged base does not falsify the independent port signal.
- A negative guard material does not make an OFF switch appear ON.
- Registered gates report their signal requirement and raw port state.
- Changing gate mode invalidates the cached observation.
- Combined hearth and port inspection stays within eight regions.
- No asynchronous API errors were reported.

This numerical harness does not prove inspection-panel interaction.

### Batch production line: coolant failure

Command:
`node tools/industry-physical-check.mjs --case line --harness --budget-ms 25000 --port 19973`.

The fixture uses 41 registered devices, including 36 ordinary refractory blocks.
Total slot occupancy: **5712 ms**.
Report: `~/.cache/tpt-headless/runs/15714-15745.json`.

Observed:

- The native miner produced six usable broken-coal cells.
- Existing powder-transfer operations loaded the finite fuel and four scrap cells.
- All four scrap cells melted and entered the existing liquid bucket.
- The bucket retained their temperatures and METAL ctype.
- Ordinary powder transfer removed three ash cells.
- All 48 tungsten shell cells remained after ash clearing.
- No asynchronous API errors were reported.

The initial 24-cell water-source hold check failed.
The pump confirmed no intake or outlet transfers.
No cooling water reached the observed shipping catch, and no metal shipped.
The bucket still held all four molten cells at the end.
These observations do not establish whether the coolant fault is geometry, control, or physics.
Source review then found uncovered rear tank corners.
Native diagonal movement can cross the empty corner column between two separate face walls.
The fixture now uses 63 devices, including 58 foundations, to close tank and catch corners.
The CPU regression checks actual occupied cells, not empty machine reservations.
Native confirmation of this layout remains pending.

The first output was truncated.
The runner now supports `--output PATH` to retain complete JSON results.
Bounded probes also record initial water count, held water, pump base/control, and released-water locations.
A protected follow-up was refused at 89% measured GPU load before browser launch.
It released the slot after **2574 ms** and supplied no new physics measurements.
Its guard result is saved at `/tmp/sandustry-physical-line-coolant.json`.
GPU load does not establish that the user is playing.

Interrupted runs do not establish complete accounting of outstanding loads and pending transfers.

### Authorized verification attempts: infrastructure failures

The user approved one line run and one UI run with only the utilization check bypassed.
Both retained slot locking, ownership checks, watchdogs, and the 25-second cap.

- The line attempt stopped before assertions because the watchdog's process-table query timed out.
  It could not verify process ownership and closed fail-safe.
  Total slot occupancy: **5303 ms**.
  Report: `~/.cache/tpt-headless/runs/75077-75211.json`.
- The operations UI attempt exceeded its seven-second app-ready deadline.
  It reported no page exceptions; the optional local AI-quota endpoint was unavailable.
  Total slot occupancy: **9680 ms**.
  Report: `~/.cache/tpt-headless/runs/75845-75867.json`.

These attempts supply no new gameplay assertions.
The UI runner now allows twelve seconds for cold pipeline startup within its unchanged twenty-second work window.
It also waits for actual Factory mode before interacting.
The ownership safeguard is unchanged.
Both utilization-check approvals were consumed.

A later CPU review found an unserialized Node-local variable in the UI selection predicate.
The runner now passes that value explicitly; isolated VM evaluation verifies the predicate.
It also verifies current hover/candidate coordinates against the public screen-ray pick and bounds the whole assertion case.
These are harness fixes, not evidence of successful player interaction.

The next protected line attempt refused admission at 88% measured GPU utilization.
It released its slot after **2560 ms**, without opening a browser.
The conditional UI run did not start.
No additional override was used.

### Protected retries: sealed source and real UI

Fetched upstream `ea9bcb7` includes the revised ownership-query and cleanup policy.
Both runners retain the 25-second total cap.
The UI runner now derives its work deadline from the shared cleanup reserve.
No utilization override was used for these retries.

The 63-device batch ran for **8444 ms**.
Report: `~/.cache/tpt-headless/runs/1258-1329.json`.
Complete result: `/tmp/sandustry-physical-line-sealed.json`.

- All 24 water cells stayed behind the closed gate.
- The opened gate exposed all 12 shutter cells without deleting water.
- The pump confirmed two input cells and two output cells.
- Its base remained intact and its real native switch was ON.
- Mining preserved six usable broken-coal cells.
- All four scrap cells melted and entered the existing bucket load.
- Ash clearing preserved the full refractory shell.
- No water reached the catch. No melt was poured there and nothing shipped.

The first UI attempt stopped on an incorrect harness assertion after placing TSNS.
Escape hides `#industry-builder`, not the persistent `.industry` wallet/HUD.
That assertion now targets the actual builder and waits for its UI update.
This attempt occupied **6967 ms**; report `~/.cache/tpt-headless/runs/13350-13389.json`.

The corrected UI case **passed**, occupying **5339 ms**.
Report: `~/.cache/tpt-headless/runs/17253-17284.json`.
Result: `/tmp/sandustry-physical-factory-operations/operations.json`.

- Actual canvas clicks placed TSNS at `(48,8,64)` and SWITCH at `(48,9,64)`.
- Native readback confirmed TSNS threshold 350°C and both material IDs.
- Confirmed spending was three credits, then five credits total.
- Invalid threshold input kept the last valid controller value.
- Focused-input Q handling, canvas blur, Escape closure, and Q reopening passed.
- Actual switch inspection/toggle changed native switch life to 10.
- The drive button enabled native control on the registered starter output belt.
- Gate-mode controls and the paid-ledger header round trip passed.

The gate registration was an explicit UI-only fixture, not a physical-flow test.
This case did not simulate player shovel/bucket strokes or full terrain-save restoration.
No page exceptions or native GPU validation errors occurred.
The optional local AI-quota endpoint was unavailable; that unrelated request was recorded.

### Pump backing investigation and passing native batch

The 77-device fixture held all 120 source water cells behind the gate.
It still delivered no water to the catch and shipped nothing.
Its old output counter did not distinguish fallback returns from forward writes.
That telemetry error is fixed; returned cargo now reports `pump-return`.
Total occupancy: **8177 ms**; report `~/.cache/tpt-headless/runs/24552-24583.json`.
Result: `/tmp/sandustry-physical-line-reservoir120.json`.

A 0.6 outward-velocity trial also failed.
The corrected counters recorded 370 intake cells, 367 actual outlet writes, and zero fallback returns.
Those counts include repeated circulation of the same finite water, not unique volume.
Bounded probes found water near the outlet but none in the catch.
Total occupancy: **8010 ms**; report `~/.cache/tpt-headless/runs/29427-29458.json`.
Result: `/tmp/sandustry-physical-line-nozzle06.json`.
The ineffective velocity change was removed.

The pump lacked real backing behind its raised outlet.
New construction now adds a tagged tungsten backplate inside its existing reservation.
Six outside foundation tiles also close the raised channel's diagonal corners.
The resulting fixture has 83 buildable devices, including 78 ordinary foundations.

The protected native batch **passed all sixteen checks**:

- Atomic construction produced the 48-cell hearth shell and 40-cell pump structure.
- All 120 water cells stayed behind the closed gate.
- Mining preserved six usable broken-coal cells.
- Finite fuel melted all four initially cold scrap cells through native phase changes.
- A finite bucket load carried all four actual LAVA(METAL) cells into the wet catch.
- The pump confirmed 37 intake cells and 37 outlet writes, with zero fallback returns.
- Actual water reached the catch and warmed after contact with the melt.
- The real pump switch completed OFF→ON→OFF; outlet counts stayed unchanged after OFF.
- Four native metal shipments confirmed temperatures of 328.57, 337.14, 38.07, and 39.22°C.
- Ash transfer removed three ash cells while preserving all 48 hearth cells.
- All twenty-four pump tags survived 1920 native ticks.
- Final bucket and pump buffers were empty. Three ash cells remained in the recorded shovel load.

Total slot occupancy: **4947 ms**, including startup and cleanup.
Report: `~/.cache/tpt-headless/runs/79615-79646.json`.
Complete result: `/tmp/sandustry-physical-line-backplate.json`.
No utilization override was used.

This checkpoint used real transfer APIs with explicit candidate cells.
It did not exercise the actual shovel/bucket update methods or player gestures.
The gate controlled coolant, not precision coal feeding.
It does not prove continuous automation or repeat refueling.

## Open requirements

- Verify repeat refueling and real player shovel/bucket gestures.
- Verify precision fuel feeding; useful coolant release now passes.
- Finish compatibility checks and independent review after the physical pump change.
- Complete release checks, push main, watch deployment, and check the live site.

Cooled metal is stationary matter; a conveyor cannot carry it to the intake.
Neither melting, diagnostics, nor ash clearing alone counts as end-to-end evidence.
