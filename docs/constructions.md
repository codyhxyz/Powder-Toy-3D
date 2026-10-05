# Constructions: a guide for agents

A construction is a small JavaScript program that places cells of real materials into the sim: a house, a tree, a
fountain. Once placed, every cell is simulated, so a construction has to look right **and** hold up physically: tanks
must not leak, powder must rest on something, and a lit fire needs fuel above its ignition point.

This guide is for coding agents (and people) writing new constructions, either as built-ins or as one-offs.

## The workflow

1. Read the generated guide: `npm run construct -- --prompt`. It lists the API, every material with its real numbers
   (density, melting and ignition points), the building rules that follow from the physics, and all built-ins as worked
   examples. It is generated from the code, so it is always current.
2. Write the code as a function body in a `.js` file, using the API names as globals.
3. Run it: `npm run construct -- my-thing.js --png my-thing.png`. This prints the cell counts and the physics lint, and
   draws an isometric preview (front-right; `--view 2` shows the back). It uses no GPU or browser and takes milliseconds.
4. Fix every `ERROR`, look at the picture, and repeat. Exit code 0 means lint is clean.

The same three tools are available over MCP: `claude mcp add powder-constructions -- node scripts/mcp-construct.mjs`
gives `construction_guide`, `construct_exec` and `construct_builtin`.

## The API in brief

| Call | What it does |
| --- | --- |
| `put(x, y, z, el, opts)` | One cell. `el` is an element name (`'WOOD'`, `'WATER'`, TPT abbreviations work too) or `'AIR'` to carve |
| `get(x, y, z)` | What the code has put there so far: an element name, `'AIR'` or `null` |
| `box(x0, y0, z0, x1, y1, z1, el, opts)` | Filled box, bounds inclusive |
| `ball(cx, cy, cz, r, el, { sy, rough, holes })` | Ellipsoid; `sy` squashes it, `rough` frays the edge, `holes` leaves gaps |
| `disc(cx, y, cz, r, el, opts)` | Horizontal disc |
| `rod(a, b, r, el, opts)` | Thick segment; `r = 0.5` is a face-connected one-cell line |
| `vec`, `bend`, `clamp` | Vector maths (three.js `Vector3` method names), random branching, clamping |
| `footing(depth)` | Solid cells on `y = 0` grow down to the ground when placed on uneven terrain |
| `rnd`, `T`, `SIZE` | Seeded randomness (`rnd()`, `rnd.range`, `rnd.int`, `rnd.pick`), size scale (1 at the default size) |

`opts` is `{ temp, ctype, soft }`: temperature in °C, what a `CLONE` emits (or what `LAVA` cools into), and "don't
overwrite cells already placed".

Conventions: y is up, the base sits on `y = 0`, the build is centred on `x = 0, z = 0`, and the front faces `+z` (the
game turns it toward the camera). Scale every size with `T` and take every random choice from `rnd`, so the size slider
and *New seed* work.

## What the lint checks

| Code | Severity | Meaning |
| --- | --- | --- |
| `leak` | error | Liquid can flow out. The sim moves matter in 2×2×2 blocks, so it escapes through gaps that only touch diagonally |
| `unsupported_powder` | error | Powder with nothing under it falls on the first step |
| `too_big` | error | The bounding box doesn't fit the grid |
| `powder_slides` | warning | Powder that can topple off (fine for a pile that should settle) |
| `clone_no_source` | warning | A `CLONE` with no `ctype` copies whatever touches it first |
| `ignites_on_place` | info | Fuel placed above its ignition point next to air burns at once (right for a lit campfire) |

## Adding a built-in

1. Write the generator in `src/constructions/builtins.js` as `function name({ put, box, ... }, variant)` and add it to
   `BUILTINS`.
2. Add an entry to `BUILDS` in `src/elements.js` (id `-100` and below, a 4-letter `abbr`, colour, description, optional
   `variants`) and list its key in the Constructions group of `PALETTE`.
3. `npm run construct -- --builtins` must print `ok` for every variant.

## Model providers

Prompt-to-construction in the app is provider-neutral. A provider is `{ id, name, generate }` registered with
`registerProvider` from `src/ai/providers.js`. `generate({ system, messages, tools, signal })` does one model turn on
provider-neutral messages and returns `{ content, usage }`; the file documents the exact shapes. The agent loop
(`src/ai/agent.js`) does the rest: it runs `construct_exec` calls in the sandbox, sends back the lint report and two
preview images, and stops at `finish` or after 6 turns. `npm run construct -- --selftest` runs that loop against a
scripted provider.

For quick experiments, a provider can be registered from the browser console with
`__app.builds.registerProvider({ id, name, generate })`.
