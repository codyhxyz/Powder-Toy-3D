# Physical factory delivery plan

Status: implementation contract approved. This document does not describe shipped behavior.

Base: fetched `origin/main`, `1b23e28b74afccc9a5fb7166a168450f56e781ee`.
The integration branch includes upstream updates through `3b59162c944b920c5f3954bf329cdfda315488ac`.

## Target player experience

The player processes real material through a complete production line:

1. Mine coal and metal into loose material.
2. Release a fuel batch through a physical gate.
3. Supply heat to a hearth with finite fuel.
4. Melt scrap through the existing temperature and phase-change rules.
5. Drain molten metal into a separate catch.
6. Supply cooling water from the finite reservoir.
7. Ship cooled metal through the existing intake.

The player can identify stopped equipment without guessing.
Controls use existing electronics where practical.
Routing uses existing refractory blocks before specialized pieces.

## Scope

- Finite-fuel heat with a usable ignition method.
- Physical gates that cannot erase or duplicate surrounding material.
- Accurate machine diagnostics.
- Accessible sensor and switch controls in Factory.
- Reliable grain and liquid routing.
- Construction, progression, save compatibility, documentation, and tests.
- Integration, independent review, deployment, and a live-site check.

## Exclusions

- Water wheels, windmills, steam engines, and kinetic networks.
- A new abstract electricity currency.
- An inventory or recipe menu.
- An additional E interaction handler.
- Unrelated physics changes or visual redesign.
- Streamed-world machinery or new multiplayer support.

## Required evidence

| Requirement | Evidence required before delivery | Current state |
| --- | --- | --- |
| Finite-fuel heat | Fuel exhaustion stops added heat. The heat source does not duplicate fuel. | Pending |
| Useful temperatures | A constructed hearth melts the target scrap at normal timing. | Pending |
| Ignition | A player can start the process without unrestricted Sandbox spawning. | Pending |
| Physical gate | Closed material blocks flow. Opening preserves material and temperature. | Pending |
| Obstructed closure | Closure never overwrites grains, liquids, or unrelated solids. | Pending |
| Gate lifecycle | Removal, damaged structure, pending actions, and saves preserve owned material. | Pending |
| Controls | A Factory player can install and operate permitted controls without an economy bypass. | Pending |
| Diagnostics | Each reported condition comes from current machine state or bounded observations. | Pending |
| Routing | The production line carries actual material between distinct hot and cold regions. | Pending |
| Economy | Construction charges and refunds remain correct. Existing progression remains usable. | Pending |
| Compatibility | Existing saves, built-in drives, Sandbox sparks, and unrelated modes still work. | Pending |
| End-to-end loop | Physical fuel, scrap, melt, coolant, and cooled shipment reach the expected stages. | Pending |
| Resource use | Tests use the shared browser helper and respect the total GPU-slot budget. | Pending |
| Release | Changes reach GitHub main, deployment succeeds, and the live site passes a focused check. | Pending |

## Missing-feature investigation

These are open questions, not implementation claims.

- Can existing combustion sustain the required melting temperature?
- How does the player ignite finite fuel in Factory?
- How does a gate retain its own material without hidden matter loss?
- How does a blocked gate recover without overwriting the obstruction?
- Can the player construct sensors, switches, and connections under Factory restrictions?
- Which machine conditions require new GPU observations?
- Which new fields require save migrations and progression defaults?
- Can a focused physics fixture finish within the total browser budget?

### Findings and approved decisions

- Ordinary-air coal has a 1100°C flame temperature. Steel melts at 1500°C.
- A passive coal hearth cannot satisfy the production loop.
- Add a distinct `hearth` device with an explicit finite-fuel industrial heating rule.
- Preserve the existing `heater` device and its saved behavior.
- Keep global coal chemistry and steel melting temperatures unchanged.
- The new hearth consumes actual coal state. It does not store a recipe inventory.
- The hearth needs a usable built-in ignition step and a local heat budget.
- Sensors and switches exist, but clean Factory runs cannot construct them.
- Add paid placement of permitted existing control materials through Build.
- Part purchases use existing credits. Their irreversible spend remains part of save validation.
- No physical gate exists. Add an atomic shutter with explicit material ownership.
- Gate closure cannot overwrite gas, grains, liquid, or foreign solids.
- Runtime diagnostics do not exist. Add a bounded, inspected-device probe.
- Existing foundation blocks, belts, lifts, and pumps cover general routing.
- No additional general transport pieces are approved.

## Work boundaries

Three read-only specialists investigate heat, gates and controls, and experience integration.
The parent resolves their findings into one shared interface contract.
Implementation agents then use separate worktrees with explicit file ownership.
No child pushes or deploys.

The parent integrates changes and requests independent reviews.
The parent addresses accepted findings before deployment.
Any unresolved prerequisite stays visible in this document and the delivery report.

## Validation policy

CPU checks precede GPU checks.
Each browser run has a stated purpose, fixture, port, expected startup, and total occupancy budget.
The maximum total GPU-slot occupancy is ten seconds.
Browsers close in `finally`.
Tests do not run beside other GPU work or bypass player protection.

The existing thermal script is not automatically sufficient evidence.
It can execute thousands of physics steps and needs a budget review before use.

The final report distinguishes source inspection, CPU checks, GPU checks, and live-site evidence.
