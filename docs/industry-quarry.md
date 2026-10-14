# Open-Cut Quarry: economy and physical layout

CPU check: `node --test tools/industry-quarry-check.mjs` (no browser/GPU).

## Objectives and tuning

- Start with **24 credits**, four owned starter machines and **no deliveries**.
  The upstream belt carries only 16 nuggets and 8 sand grains; shipping, not
  spawning the map or advancing time, earns money.
- Nuggets pay **1 credit** each. Lifetime earnings unlock miner/lift at **12**,
  pump at **48**, furnace at **96**. Spending never removes an unlock.
- Cooled METAL (temperature **<=90°C**) pays **4 credits** per cell. SCRAP,
  GOLD, molten matter and hot METAL do not qualify. Mine metal into scrap,
  melt it, route the melt into a shipping catch, then cool it: solid metal
  does not ride a conveyor. Ship **32 cold METAL** and reach 96 lifetime
  earnings to complete the goal; construction/shipping continue in freeplay.
- Catalog prices are authoritative. Every successful build adds ownership;
  refunds remove ownership and return the exact cost. Starter machines are
  owned once, so dismantling them does not require having bought them.
- Saves contain version 1, owned counts and delivered `{nuggets, metal}`.
  Earnings must equal delivery value; wallet plus owned catalog value must
  equal 24 + starter catalog value + lifetime earnings. Invalid saves throw
  `TypeError` before any state is created. Unlocks/objectives are recomputed,
  never trusted from serialized display fields. Snapshots are detached JSON.
  This validates consistency, not authenticity of user-edited local saves.

These are initial minute-scale milestones, pending parent-owned real-flow
playtesting. No offline income, production timer, inventory recipe or E action.

## Map, 128³

Ground top / feet levels are **8, 16, 24, 32** (rock, limestone, sandstone).
An eight-cell-wide southern haul ramp at x72..79 connects the factory floor
and rim, with at most one cell rise per row. Spawn `[48,8,84]` has clear
headroom and a solid floor.

- **Starter line:** catalog positions x48..51, z48..63, y8 decks. Initial
  batch only at x49..50, y9..11, z48..51. No valuable grains at the intake.
- **Paydirt:** 168 nuggets mixed through the shallow north bench at
  x40..67, z28..35, y16..18; another 36 in an approachable stockpile at
  x37..42, z39..44, y9..11. Including the demo there are 220 loose nuggets.
- **Gold:** north face x44..63, z32..35, y8..13; more in the west bench.
  Ordinary GOLD breaks to NUGGETS. More than 1,000 finite GOLD cells support
  expansion even after a lost demonstration batch.
- **Metal:** east face x92..95, z44..71, y8..13 and a deeper bench seam.
  **Coal:** southern face x40..59, z92..95, y8..13 and farther-back seam.
- **Reservoir:** 960 WATER cells, surface feet-height 8, retained in glass
  at x76..89, z56..77. Dry service shelf at y4 on its west, stairs south;
  the bank can be excavated for an inlet. No CLONE or replenishment source.
- **Thermal yard:** tungsten floor x80..91, z36..47 at y7, with retaining
  lips and an open west side. No free heat: the player must build a furnace.

**Approved integration revision:** unlike the initial contract's reserved-empty
base wording, the preset now writes starter decks with catalog `baseMaterial`.
The runtime must register these existing starters without restamping/charging.
This prevents grains dropping through before asynchronous setup finishes.

## Validation limits / handoff

CPU checks cover progression, malformed saves/actions, refund loops, catalog
prices, completion/freeplay, geometry bounds/material IDs, ramps, resources,
spawn, starter placement and map eligibility. Real belt/sorter throughput,
GPU-confirmed shipping, pump inlet alignment, melt/cool capture and POV walking
need the parent's integrated browser validation. The shelf offers construction
space, but actual pump port offsets may require a tuned bank opening. No new
materials, shaders, global material rules or controls are introduced here.
