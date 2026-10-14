# Physical factory validation

Status: unreleased. The complete production loop has not passed.

## CPU evidence

The integrated controller and UI pass:

- `node --test tests/industry/*.test.js`: 30 tests.
- `node scripts/check-industry-controller.mjs`: 11 checks.
- `node scripts/check-industry-factory-ui.mjs`.
- Existing construction, transfer, and Quarry checks.
- Hearth budget/conduction checks: 284 checks, including finite native combustion after the boost accounting fix.
- Diagnostics request ownership, freshness, reset, and disposal regressions.
- Naga type validation of composed Industry, diagnostics, gate, and control shaders.

Fresh integration review found two additional input problems.
Canvas placement now releases number-input focus, so Escape and Q remain available.
Inspection no longer captures driving input.
Both fixes have CPU regressions.

## Native GPU evidence

The commands used an isolated Vite server on strict port 19973.
Each invocation used `tools/browser.mjs` and its ten-second slot limit.
No run bypassed player protection.
The browsers and server were stopped.

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
Bounded diagnostics have not yet been executed in a browser.

### Thermal: not passed

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
This revised fixture has not run on the GPU.
It does not yet assert real shovel loading, ash clearing, or bucket extraction.

CPU geometry command:
`node tools/industry-physical-check.mjs --case thermal --preflight`.

## Open requirements

- Prove useful melting with cold, buildable containment and finite physical fuel.
- Resolve the test fixture's internal-lining construction mismatch.
- Verify ash removal or another usable way to refill the firebox.
- Route actual molten metal to a separate shipping intake.
- Cool it there with actual water and confirm shipment.
- Validate the bounded diagnostics and combined controls in a browser.
- Complete release checks, push main, watch deployment, and check the live site.

Cooled metal is stationary matter; a conveyor cannot carry it to the intake.
Neither the failed melting checkpoint nor CPU tests count as end-to-end evidence.
