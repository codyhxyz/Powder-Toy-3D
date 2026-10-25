# Material metadata and exhibit catalog

This is a data foundation, **not** a map generator, containment proof, or new
physics. Registry coverage is independent of the palette: every `ELEMENTS` row
(including `EMPTY`/Air and hidden terrain) gets exactly one material entry.
PHOTON, NEUTRON, and SPARK are separate named effect demonstrations, not voxel
rows. No other tools, builds, gear, or spawners are admitted.

## Public API

- `src/materialTraits.js`
  - `MATERIAL_TAGS`: frozen vocabulary keyed by tag string. Descriptors are
    `{ group, label, description }`; groups distinguish kind, hazard, property,
    and special behavior. `describeTag(key)` returns one or throws helpfully.
  - `validateTraits(traits = [], context = 'material')`: validates author-supplied
    **semantic exceptions only**, returns a deduplicated array. Unknown tags,
    non-arrays, non-strings, and attempts to repeat derived tags throw.
  - `materialTags(element)`: returns deduplicated tag strings, combining the
    physical row, shared contact reactions, nuclear data, and semantic traits.
  - `materialTransitions(element)`: `{ hot, cold }`, each a table transition
    or `null`. Explicit fields win. Only the water family uses active V2
    `PHASE_ROWS` when its schema lacks fields; no duplicate phase numbers.
- `src/lab/facts.js`
  - `elementFacts(element)`: data-only array of
    `{ key, chips: [prefix, value, suffix] }`. All chip parts are strings;
    concatenate them for plain text or emphasize `value` as the card does.
    Transition records additionally have `direction`, `temperature` (°C), and
    `products: [{ key, share }]` (table weights, not simultaneous yields).
    Tool rows return `[]`. No DOM, GPU context, browser, or installed third-party
    dependencies are needed to import this API. The card shows at most ten facts;
    the catalog retains the complete fact array.
- `src/lab/catalog.js`
  - `createExhibitCatalog(elements = ELEMENTS)`: an ordered array (materials in
    supplied registry order, then the three effects). Material entries have
    `{ key, elementId, name, type: 'material', category, tags, requirements,
    status, reason, facts }`. `category` is `air`, `solid`, `powder`, `liquid`,
    or `gas`. Effect entries use `type: 'effect'`, `category: 'effect'`,
    `elementId: null`, and their negative `toolId`.
    Duplicate keys/IDs, reserved effect keys, malformed rows, or tools in the
    supplied material array throw. Appended synthetic rows need no catalog edit.
  - `EFFECT_KEYS`: the explicit, frozen named-effect admission list.
  - `requirementsForTags(tags)`: deduplicated requirement IDs; all applicable
    requirements compose rather than choosing a single dominant hazard.
    Every tag must have an explicit storage policy, including empty policies.
  - `STORAGE_REQUIREMENTS`: requirement IDs mapped to
    `{ label, supported, reason }`. These are storage obligations, **not**
    material tags or physics properties.

`status: 'candidate'` means all requirements can be expressed as passive
geometric/separation suggestions. It does **not** mean built, tested, safe, or
safe indefinitely. `supported: true` has only that policy-level meaning; it is
not a simulation-tested recipe. `status: 'plaque-only'` means at least one
requirement is unsupported; `reason` includes every unsupported obligation.
Never silently replace an unsupported store with an ordinary glass box.
Temperature control, pressure shielding, neutron shielding, replication/growth
isolation, acid-compatible storage, matter-consumption isolation, replenishment,
and controlled effect sources are not implemented/validated here.

## What is derived, and what is not

Existing fields remain authoritative: `kind`, `hot`, `cold`, `melt`, `ignite`,
`burnRate`, `blast`, `acid`, `acidProof`, `cond`, `elec`, and `REACTIONS`.
Impact sensitivity derives from `blast.shock`; pressure sensitivity from
`blast.crushP` or `crush.P`. Annihilation derives from a wildcard reaction
that consumes both participants. These are distinct from ordinary flammability.
Reaction fuels also derive flammability from their heat-releasing reactions
with air or oxygen; hydrogen does not need a duplicate ignition constant.
Nuclear-fuel tags derive from positive `NUCLEAR` fission cross-sections;
spontaneous-neutron tags derive from positive `EMITTERS` rates in `rays.js`.
Water's neutron scattering does **not** make it nuclear fuel. Uranium is not
claimed to emit spontaneously at the modeled rate. No nuclear membership or
physical constants are copied into annotations.

A wildcard reaction's **source** is reactive; all its potential victims are
not inherently reactive. Explicit chemistry partners (e.g. water and salt)
are reactive and need separation from those partners. Generic susceptibility
to antimatter is not an intrinsic reactive facet or an automatic plaque-only
reason.

A phase rule is useful information, not an automatic need for active cooling.
Water at ambient, sand with a remote melting point, and ambient CO₂ remain
geometric candidates. Flammability calls for ignition separation, not mandatory
active cooling. Pressure-producing policy covers blasts, the source side of
pressure-producing reactions, acid fizz, and gas-releasing transitions whose
threshold is reached at spawn **or ambient**. A remote water boiling threshold
alone does not mandate pressure shielding. External heating/interactions still
invalidate any assumption of indefinite passive safety.

Thermal facets describe **spawn temperature**, not human injury:
`hot` is above `PHYS.AMBIENT`, `cold` below it, and `cryogenic` is at or below
−150 °C (a conventional descriptive cutoff, not a new simulation rule or safe
handling limit). Hot/cold starts conservatively need thermal control to keep
the intended sample temperature; cryogenic composes with cold. There is no
thermal-control implementation in this change. Independently, `thermally-unstable`
marks a transition threshold reached at spawn or ambient (including melting),
which requires thermal control even if the spawn temperature itself is ambient.

Facts read explicit zero-degree `hot.T`/`cold.T` correctly. Legacy `melt: 0`
means *no melt rule*, not melting at zero. Products are named, including mixed
boiling residues. Melting/boiling/condensing labels follow source/product kinds;
a non-reversible solid-to-gas/product transformation is labeled decomposition,
not melting. Other transformations (firing clay, cooking meat) remain generic
“Changes” rather than claiming a reversible phase change. These labels describe
table transformations, not proof of real chemistry or mass conservation.
Buoyancy follows the signed `grav` field at spawn, so heavy gases sink and
zero-buoyancy cloud gets no blanket “Rises” claim.

## Authoring a new element

1. Append the definition to `defs` in `src/elements.js` to preserve saved IDs.
   Provide physical fields normally. No palette or catalog admission list is
   needed for material inclusion.
2. Let the standard tags derive from those fields. Do not copy temperatures,
   densities, blast parameters, electrical values, or nuclear membership into
   metadata. A palette category is not an authoritative kind.
3. If an active special behavior cannot be derived, add semantic `traits` on
   the definition, e.g. `traits: ['growing']`. Existing annotations cover:

   | Trait | Runtime evidence |
   | --- | --- |
   | `decaying` | `src/v2/contact.js`: fire/smoke/plasma life countdown; cloud evaporation/rain |
   | `growing` | `src/v2/contact.js`: plant, moss and fungus special rules |
   | `replicating` | `src/v2/contact.js`: clone and powered-clone rules |
   | `matter-consuming` | `src/v2/contact.js`: void deletion and singularity absorption |
   | `airborne-explosive` | `src/v2/contact.js` dust-cloud ignition/burst; airborne contact wiring in `src/shaders/v2/particles.js` |
   | `oxidizer` | `src/v2/contact.js`: oxygen accelerates burning and raises flame temperature |
   | `pressure-anomaly` | `src/v2/contact.js`: singularity suction and its mass-dependent burst; composes with decay and matter consumption |
   | `biological` | `src/pov/stains.js`, `src/pov/potions.js`, `src/pov/vitals.js`: verified special body statuses/ingestion (not every generic thermal injury) |
   | `potion` | `src/pov/potions.js`: registered potion effects; not an unimplemented sheep transformation claim |

   These sources, not historical `shaders/react.js` documentation, establish the
   current behavior. An annotation describes behavior but never enables it.
4. For a genuinely new semantic trait, add a readable descriptor and semantic
   admission in `materialTraits.js`, then an explicit compositional storage
   policy in `lab/catalog.js`. An unknown tag throws; an unimplemented required
   containment capability must produce plaque-only with a reason.
5. Run `node --test tools/lab-catalog-cpu-check.mjs`. Add a combination and
   unsupported-storage test for new hazards. CPU data checks cannot establish
   an indefinite containment recipe; that requires separate runtime evidence.

This follows the repository's existing TPT-style material table/transition
mechanisms and the game's Noita-inspired status registrations, rather than
inventing parallel material parameters or treating UI palette membership as a
registry. No map/view-specific runtime behavior is introduced.
