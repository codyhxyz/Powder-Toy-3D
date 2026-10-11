# Wang tiles: authoring a kit

`src/world/wang/` builds a level from hand-made tiles the way Noita builds its
biomes: Sean Barrett's herringbone Wang tiles (`stb_herringbone_wang_tile.h`,
public domain), taken to 3D. Each horizontal layer is a herringbone of 2:1
bricks, so no seam runs straight across; layers are shifted and transposed
against each other, so none runs straight down either; layers join through
unit-sized shafts. The scheme and its diagram are in the header of
`src/world/wang/tiling.js`.

A **kit** is one file, `src/world/wang/kits/<biome>.js` (`mines.js` is the
example), exporting `{ name, palette, tiles }`. `coal.js` (the Coal Pits) is
the second: natural caverns built from chains of vaults (`cave()`), crooked
tunnels, and coal beds at fixed heights so they read as strata across tiles.
Its palette makes `WATER` toxic sludge and `SAND` broken coal. The Snowy
Depths kit goes next to them. `node scripts/check-wang.mjs --kit coal` checks
one kit. The per-tile check also walks each tile mirrored, since a 2-wide body
sits on a mirrored tile's cells differently.

## Using a kit in a scene

```js
import { bakeWang, wangGLSL, minesKit, WANG_OUT } from '../../wang/index.js';

let W = null;   // the bake, one world at a time
const bake = (P) => (W ??= bakeWang({ kit: minesKit, seed: P.seed, size: [x, y, z], origin: [x0, y0, z0] }));
export const myScene = {
  // wangGLSL depends on the kit only, so glsl(g) works before the bake
  glsl: (g) => `${wangGLSL(minesKit)}
    void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
      int c = wangCell(w);                       // WANG_OUT outside the region
      int id = c == WANG_OUT ? E_ROCK : wangElement(c);
      ...
    }`,
  // the bake is CPU work: in prepare, or on first use (uniforms(P) can come first)
  prepare: async (renderer, P) => { bake(P); },
  uniforms: (P) => ({ ...myOwn, ...bake(P).uniforms() }),
  ground: (x, z, P) => /* scan W.wangCellJS([x, y, z]) down */,
  dispose: () => { W?.dispose(); W = null; },
};
```

- `bakeWang({ kit, seed, size, origin, entry, exit })` → `{ glsl, uniforms(),
  wangCellJS(w), elementJS(code), entry, exit, mainPath, sites, brickBox, dispose() }`.
  CPU only (about 100–200 ms for 16 × 5 × 10 units), deterministic in its inputs.
- `size` is in cells; the region holds `floor(size / U)` units across and
  `floor(size.y / H)` layers. The top layer's entry shaft opens out of the
  region's top at `entry` (world cell of the shaft's centre), the bottom
  layer's exit shaft out of its bottom at `exit`: put the spawn over one and
  the temple under the other.
- Uniforms: `tWangAtlas` (usampler3D R8UI), `tWangPlace` (usampler3D
  RGBA8UI), `uWangOrigin`, `uWangUnits` (ivec3s).
- `wangCell` is two texel fetches and a handful of compares; `wangCellJS` is
  its CPU twin (keep `glsl.js wangPorts` and `tiling.js cutPorts` in step).
- `sites`: every placed tile's sites in world cells (`loot`, `gold`,
  `treasure`, `wand`): ready-made candidates for the level's `loot` list.
- `walk.js walkFlood` floods a body over a block of codes: vet a spawn or a
  site with it.

## The tile frame

Every tile is authored once, as the brick long along x:

```
        x = 0                 U = 24               2U = 48
 z = 0   +---------N0---------+---------N1---------+
         W       unit 0       :       unit 1       E
 z = U   +---------S0---------+---------S1---------+       y: 0 .. H = 24 (up)
```

Cells are 0.30 m; a body is 5.5 cells tall and 1.6 wide, steps 1 cell, jumps
2, falls any height. The rasterizer makes a **border** of 2 cells of rock on
every face whatever the tile holds, so tiles meet only through their ports.
The floor is `y = 2` (`FLOOR`), the gallery storey's floor `y = 13`
(`HIGH_FLOOR`, a timber deck at `y = 12`).

The tiling places a tile as is, mirrored in x or z, or transposed (long along
z): up to 8 placements from one authoring. Don't put anything chiral in a
tile (writing).

## Ports and colours

Ten ports: `W E N0 N1 S0 S1` (doorways) and `D0 D1 U0 U1` (shafts through the
floor and ceiling of each unit). A tile lists, per port, the colours it
accepts, preferred first:

| Letter | Colour | What the sampler cuts |
| --- | --- | --- |
| `-` | closed | nothing |
| `D` | door | an 8 × 9 doorway at the floor with a timber set |
| `R` | rail | the same, with two rails on its floor |
| `H` | high door | the doorway at `HIGH_FLOOR` |
| `S` | shaft | a 6 × 6 hole through the floor (`D`) or ceiling (`U`) |

Unlisted side ports default to `'-D'`, shafts to `'-'`. End ports (`W`, `E`)
cut 5 cells in; side ports (`N`, `S`) cut 12, to the middle line, where a
gallery along x runs. So a tile whose gallery runs along its length gets side
doors for free, and no doorway is cut when its port is closed (no dead stubs).

**The promise**: every pair of open ports a tile accepts is connected
walking, both ways, with every floor shaft it accepts open as well (holes are
the only cut that can sever a path: give a hole a walkway round it, `bay()` in
`mines.js`), except a shaft straight down under the shaft you fell in by (the
tiling never opens a straight drop through a brick). A `U` port is a start
only: you fall in; a `D` port is reached by falling out.
`scripts/check-wang.mjs` checks every pair.

The kit must have one **universal** tile accepting every colour on every
port (the Mines' timber hall); it's the fallback that makes a pick always
exist. Give it a modest weight.

## Primitives

`prims` apply in order over solid ROCK, in canonical cells (boxes are
half-open, `[[x0, y0, z0], [x1, y1, z1]]`):

| Primitive | Shape |
| --- | --- |
| `{ box: [a, b] }` | a box |
| `{ ramp: [a, b], axis, rise }` | a wedge filling box a..b under a floor rising along `axis` (`'x'`/`'z'`); `rise: -1` slopes the other way |
| `{ stairs: [a, b], axis, rise }` | the same, a cell a step |
| `{ ball: [c, [rx, ry, rz]] }` | an ellipsoid |
| `{ cyl: [base, r, h], axis }` | a cylinder |
| `{ capsule: [a, b, r] }` | a capsule |

Options on any: `m` (material code name, default `'AIR'`), `rough` (cells of
fractal noise on the surface: 1 for a dug gallery, 2–3 for natural caves; 0
for timber), `only` (codes it may replace: `only: 'AIR'` pours a liquid into
what's carved, `only: 'ROCK'` threads a vein through rock), `salt` (share one
noise field between primitives, as a gallery's overlapping slices do).

Materials are codes, not elements (`kit.js MAT`): `AIR ROCK SOFT BEAM RAIL
RUBBLE WATER OIL GOLD CRYSTAL COAL MOSS GRAVEL METAL SAND ICE`, and the
Noita stuff a biome is dense with, each the element of its name by default:
`TORCH` (a wall torch's head), `TOXIC BLOOD ACID LAVA SLIME MUD WHISKEY TELEPORTATIUM LEVITATIUM BERSERKIUM
HEALTHIUM POLYMORPHINE GUNPOWDER TNT FUNGUS MEAT NUGGETS CLAY PLANT WOOD`
(`WOOD` is timber that stays wood when a kit remaps `BEAM`). The kit's
`palette` maps them to `elements.js` keys, so the Coal Pits can make `ROCK`
coal-streaked stone and the Snowy Depths `ROCK` ice without new codes. The
walk checks swim through the harmless liquids; `TOXIC`, `ACID` and `LAVA`
count as walls, so a path never needs a swim through them.

The scene spawns every cell at its element's spawn temperature: keep `LAVA`
away from timber, `OIL`, `GUNPOWDER` and `TNT` (nothing may burn on load).

`sites: [{ kind, at: [x, y, z] }]` mark places on a floor (the scene decides
what goes there).

## Filling a tile: variants, coats, scatters

Noita's rooms differ placement to placement in what they hold, not their
shape. Three additive tools give a kit that:

- **Variants.** `variants: N` on a tile makes N rasterized versions, weight
  `weight / N` each; the tiling picks one per placement from the bake's seed.
  Each variant resolves the tile's random prims with its own stream (fixed by
  the kit, so `check-wang` walks every variant), keeping the tile's rock noise:
  - `{ ..., chance: p }`: kept in about p of the variants;
  - `{ ..., m: { WATER: 6, OIL: 2, BLOOD: 1 } }`: a material picked by weight;
  - `{ any: [[prims], [prims], []], weights: [3, 1, 2] }`: one of the lists;
  - a nested `[prims]` list is flattened (helpers can return lists).
  A tile with any of these and no `variants` is resolved once.
- **Coat** `{ coat: [a, b], m, face, cover, depth, only }`: growth on the
  surfaces in a box, in noise patches (moss and grass on floors, fungus on
  ceilings, a blood splash). A cell of `only` (default `ROCK`) with air on
  `face` (`up` floors, `down` ceilings, `side` walls, `any`) within `depth`
  cells becomes `m`, over about `cover` (0..1) of them. A solid coat survives
  the border (the floor *is* the border).
- **Scatter** `{ scatter: [a, b], n, put: [prims], on }`: n copies of `put`
  (prims relative to the spot) at random columns of the box: `on: 'floor'`
  (default) the first air cell standing on solid scanning down from the box's
  top, `on: 'ceiling'` the first air cell under solid scanning up (a chain
  hangs down from it). Each variant scatters differently.
- **`deepest: n`** on a tile: it's placed only in the region's n lowest layers
  (lava lies low in Noita).

The atlas holds up to 100 tiles (variants count), and a kit with none of these
bakes byte-identical to before.

## Habits that pass the check first time

- Cut a gallery the tile's full length (`galleryX(IN[0], IN[1])`): the end
  doors and every side door meet it.
- Two rough boxes side by side leave a noisy seam between them: overlap them
  (or share a `salt`).
- Leave 8 clear cells over any floor a body walks, 9 over a stair's top step.
- Anything sitting in a gallery leaves 2+ cells to walk past it (`CART_BAY`).
- A raised floor over a `D` port is fine: the shaft cuts 2 cells above the
  floor (`SHAFT_CUT`).
- Run `node scripts/check-wang.mjs`; a failing pair prints as
  `tile <name>: W(1) -> N1(3) not walkable`. `--preview DIR` writes plan and
  side slices (PNG) and the brick layout (text) to look at.

## Known limits

- Going up a layer needs the jetpack (Noita's levitation): shafts are drops.
  A climbable stair-shaft colour would make up-links two-way.
- Layer floors share heights (every `H` cells): the side view still reads as
  storeys. Tiles with sunk or raised floors and tall two-layer tiles would
  break it up.
- One kit per region; mixing kits (a biome edge) would need shared port
  geometry, which they have (`GEOM`), and a per-tile kit index.
