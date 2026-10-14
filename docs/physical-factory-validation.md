# Physical factory validation

Status: unreleased. The complete production loop has not passed.

## CPU evidence

The integrated controller and UI pass:

- `node --test tests/industry/*.test.js`: 30 tests.
- `node scripts/check-industry-controller.mjs`: 11 checks.
- `node scripts/check-industry-factory-ui.mjs`.
- Existing construction, transfer, and Quarry checks.
- Hearth budget/conduction checks: 279 checks.
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
There was no further GPU retry.

## Open requirements

- Prove useful melting with cold, buildable containment and finite physical fuel.
- Verify ash removal or another usable way to refill the firebox.
- Route actual molten metal to a separate shipping intake.
- Cool it there with actual water and confirm shipment.
- Validate the bounded diagnostics and combined controls in a browser.
- Complete release checks, push main, watch deployment, and check the live site.

Cooled metal is stationary matter; a conveyor cannot carry it to the intake.
Neither the failed melting checkpoint nor CPU tests count as end-to-end evidence.
