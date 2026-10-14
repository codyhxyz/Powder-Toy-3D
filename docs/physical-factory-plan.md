# Physical factory delivery plan

Status: controller and UI integrated. Native thermal validation is unresolved. Nothing deployed yet.

Base: fetched `origin/main`, `1b23e28b74afccc9a5fb7166a168450f56e781ee`.
The integration branch includes upstream updates through `b573872e890a3283fe57db298b3f7b434cd8a46c`.

## Target player experience

The player processes real material through a complete production line:

1. Mine coal and metal into loose material.
2. Release a fuel batch through a physical gate.
3. Supply heat to a hearth with finite fuel.
4. Melt scrap through the existing temperature and phase-change rules.
5. Drain molten metal into a separate catch at the shipping intake.
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
| Finite-fuel heat | Fuel exhaustion stops added heat. The heat source does not duplicate fuel. | CPU budget and conduction checks pass; GPU pending |
| Useful temperatures | A constructed hearth melts the target scrap at normal timing. | Small fuel batch failed; full-firebox result still unavailable |
| Ignition | A player can start the process without unrestricted Sandbox spawning. | Paid starter observed on native GPU; useful melting still unverified |
| Physical gate | Closed material blocks flow. Opening preserves material and temperature. | Pending |
| Obstructed closure | Closure never overwrites grains, liquids, or unrelated solids. | Native WALL and falling-sand checks pass; other materials covered by shared preflight |
| Gate lifecycle | Removal, damaged structure, pending actions, and saves preserve owned material. | CPU lifecycle/save guards and native tagged removal/damage checks pass |
| Controls | A Factory player can install and operate permitted controls without an economy bypass. | Integrated CPU economy/UI checks and native control writes pass; browser interaction pending |
| Diagnostics | Each reported condition comes from current machine state or bounded observations. | Async CPU regressions and shader type validation pass; controller/GPU pending |
| Routing | The production line carries actual material between distinct hot and cold regions. | Pending |
| Economy | Construction charges and refunds remain correct. Existing progression remains usable. | Pending |
| Compatibility | Existing saves, built-in drives, Sandbox sparks, and unrelated modes still work. | Existing construction, controller, physics, and Quarry CPU suites pass; final integration pending |
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
- Mining must preserve coal's remaining fuel life; the old miner incorrectly cleared it.
- Ignition needs paid temperature headroom because native conduction precedes burning.
- Gates must check their bases before actuation, not only their shutter cells.
- Switch shutdown must use the native countdown to avoid immediate relatching.
- Purchased metal costs five credits because shipping one metal cell earns four credits.
- Cool metal at the intake. Cooled metal is a stationary solid, not belt cargo.
- The vertical gate controls a lateral outlet. It is not a horizontal hopper lid.
- Spent coal leaves ash. A usable firebox must allow ash removal and refueling.

### Current validation

- 279 hearth CPU budget, conduction, geometry, and composed-shader checks pass.
- 17 gate/control CPU tests pass, including native switch-bank shutdown and gate shader type validation.
- Diagnostics pass mocked asynchronous ownership, mutation, staleness, and disposal regressions.
- Existing construction, controller, machine-transfer, and Quarry CPU suites pass.
- Async-read and browser-launch policy checks pass.
- The production build passes with isolated dependencies installed from the lockfile.
- Native gate/control checks pass; total slot occupancy was 7093 ms.
- No native GPU melting, drainage, cooling, or shipment test has passed for the new hearth yet.
- See `physical-factory-validation.md` for failed checkpoints and measured slot occupancy.

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
