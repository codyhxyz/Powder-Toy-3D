# Electricity

The Powder Toy's electronics are a cellular automaton: a spark sits on a conductor for a few frames and hops to the
idle conductors around it. That suits the GPU, so we borrow it, with real conductivities. The code is
`src/electricity.js` (constants, CPU helpers, GLSL), called from `shaders/react.js` and mirrored in
`ui/tiles/engine.js`. TPT's sources (read 2026-10-10): `src/simulation/elements/SPRK.cpp`, `METL.cpp`, `PSCN.cpp`,
`NSCN.cpp`, `BTRY.cpp`, `SWCH.cpp`, `INSL.cpp`, `TSNS.cpp`, and `create_part` and the life countdown in
`Simulation.cpp`.

v1 has the spark, conduction through every element with an electrical conductivity, the battery, P- and N-type
silicon, the switch, the insulator, the temperature sensor, the powered clone, Joule heating, the Spark tool and an
Electronics palette group.

## Telling a live cell

There is no SPARK element. A live cell keeps its own element (METAL, WATER, SALTWATER...) and carries the spark in
its ctype. So a probe can't look for an element key: it tests the cell.

**On the GPU**, any pass that has the prelude (`shaders/common.js`) can call:

```glsl
float cellSpark(vec4 a);   // a = fetchA(cell). 0 when not live, else the spark's strength, (0, 1]
```

which is exactly:

```glsl
int id = eid(a);
int ct = int(floor(a.w));                                   // ctype (w = ctype + seed)
bool live = CONDUCTS[id] && ct % SPARK_CYCLE > SPARK_REST;  // SPARK_CYCLE 9, SPARK_REST 4
float strength = live ? float(ct / SPARK_CYCLE) / float(SPARK_V) : 0.0;   // SPARK_V 400
```

`CONDUCTS[id]` is `elec > 0` in the element's row. Life plays no part (water keeps its latent heat there).

**The first-person probe** (`shaders/povBody.js`) now writes `cellSpark(a)` into its 4th channel, which used to hold
life and which `pov/player.js` never read. On the CPU:

```js
const spark = probe.buf[i + 3];   // texel i·4 of the readback: 0 = not live, else strength (0, 1]
```

**On the CPU from raw state A** (`[id, T, life, w]`, e.g. a cell carried by a tool), `src/electricity.js` exports
the same tests: `isLive(id, w)` and `sparkOf(id, w)` (strength, 0 when not live).

What that means for a body: metal and silicon carry a spark at full strength. Fresh water carries it a few cells,
losing a quarter of a full spark per cell (strength 0.75, 0.5, 0.25 going out from a live wire). Saltwater loses
1/400 per cell, so a whole pool goes live. A spark lasts 4 steps on a cell, then the cell rests 4 steps, so a wire
fed by a battery is live about 4 steps in 9.

## Sparking a cell from outside (lightning)

```glsl
bool sparkCell(inout vec4 a);   // prelude: give a full spark to a, if it conducts, can take one, and is ready
```

Call it on `oA` in a pass built with `copyThroughMain` (`shaders/common.js`); the activity flags follow on their
own. It does nothing to a cell that doesn't conduct, to a switch that is off, or to a conductor that is already live
or resting. The Spark tool is this call inside the brush (`shaders/passes.js`, tool `SPARK`, id -9). A bolt (branch
`el-mat`) calls it on the cells it strikes. In the dock tiles' engine, `World.spark(i)` does the same for cell `i`.

## How a spark lives in the cell state

State A is (element id, temperature, life, ctype + seed). TPT turns the conductor into a SPRK particle that keeps
the conductor in its ctype. We can't do that: our conductors must keep their own physics while they carry a spark
(water still flows and boils, metal still conducts heat and melts), and some keep latent heat or fuel in their life.
So the spark goes into the conductor's ctype, which no conductor otherwise uses:

```
ctype = phase + SPARK_CYCLE · level
phase  8 when sparked, one less per step: live while 8..5 (TPT SPRK's 4 frames), resting 4..1
       (TPT's conductor life of 4 after a spark), ready at 0
level  while live, the spark's strength left, 1..SPARK_V (400). 0 otherwise.
```

The integer stays under 2¹², so the seed in the fraction keeps 12 bits. A conductor that turns into something that
doesn't conduct loses its spark (react.js); one that melts takes lava's ctype as before.

The switch keeps its on/off state in its life, as TPT's SWCH does (`SWITCH_ON` = 10 on; 9..1 turning off, one a
step; 0 off), and so does the powered clone, whose ctype is what it copies, as Clone's is. The temperature sensor
keeps its firing flag in its life (1 while firing).

Multiplayer guests get only the phase of a conductor's ctype (`net/codec.js`), which is all the renderer needs.

## The rules in 3D

**Six face neighbours, one hop a step.** TPT's spark reaches a 5×5 stencil less its corners, two pixels a frame,
with a midpoint check so insulation in between blocks it. In 3D we use the six face neighbours:
- Current needs contact area. Two cubes that touch only along an edge or at a corner touch along a line or a point:
  no area, no current. A 5×5×5 stencil would jump air gaps, which takes ~3 MV/m in air.
- The react pass already reads the six faces, so the spark costs no extra texture fetches.
- The activity map assumes a change travels at most `INFLUENCE_PER_STEP` = 2 cells a step (`shaders/activity.js`).
  A two-cell hop would make it 3 and shorten the map's life from 2 steps to 1.
- Brush strokes are face-connected, so wires drawn with any brush size conduct.
Every hop takes one step, because the GPU updates all cells at once. TPT's "only conduct when life < 4" exists to
stop a spark running across the screen in one frame in its sequential update; we don't need it.

**A ready conductor sparks** when a face neighbour offers a spark it may take:
- a battery, or a firing temperature sensor: a full spark (`SPARK_V` levels);
- a live conductor that may conduct into it: that conductor's level.
It takes the strongest offer, less its own crossing cost (below), and sparks if anything is left.

**Who conducts into whom** (TPT's `tryConduct`, for the elements we have):
- N-type silicon never sparks P-type. This is a p-n junction: it conducts from P to N and blocks the reverse.
- A switch takes and passes sparks only while on. A live P beside it switches it on, a live N switches it off, and
  neither sparks it. A switch doesn't spark P, N or water.
- On and off spread through touching switches, one cell a step; off wins where they meet.
- The powered clone (TPT PCLN) is switched the same way and spreads on and off the same way. While on it is our
  Clone: it copies what it holds into the air beside it. It takes the first thing that touches it, but not air,
  walls, clones or the silicon that powers it. It doesn't conduct.
- Everything else conducts into every conductor, itself included.

**Crossing cost.** Each element's row gives its electrical conductivity σ in S/m (`elec`). Crossing a cell costs
`SPARK_DROP / σ` levels (`SPARK_DROP` = 5): the voltage drop across a cell is proportional to its resistance,
1/(σ·L) for a cube of edge L. Fractions are spent at random (a cost of 0.3 is one level on 30% of hops). So:

| Element | σ (S/m) | Cost per cell | Reach from a full spark |
| --- | --- | --- | --- |
| Steel (Metal, Scrap) | 7·10⁶ | 7·10⁻⁷ | unlimited |
| Copper switch contacts | 6·10⁷ | 8·10⁻⁸ | unlimited |
| Doped silicon (P, N) | 10⁴ | 5·10⁻⁴ | ~800,000 cells |
| Saltwater (el-chem) | 5 | 1 | 399 cells |
| Fresh water | 0.05 | 100 | 3 cells |

A row with `conducts: true` and no `elec` is taken as a metal (`ELEC_METAL`, 10⁶ S/m).

**Water.** TPT's water conducts as well as metal does, with long rests. Real water is a weak conductor: pure water
is 5.5·10⁻⁶ S/m, fresh and tap water about 0.005-0.05 S/m from dissolved ions (USGS, specific conductance),
seawater about 5 S/m, and steel 7·10⁶. We use 0.05 for our water and 5 for saltwater: a spark reaches about 3 cells
(~1 m) into a pond and right across a saltwater pool, as in Noita. Ice and steam don't conduct.

**Joule heating.** The levels a spark spends crossing a cell become heat there: `JOULE_PER_LEVEL` = 0.002 cap·°C
each. The power dissipated in a cell is ΔV²/R = ΔV²·σ·L, and with ΔV = `SPARK_DROP`/σ that is proportional to 1/σ,
the cost. A full spark spent in one water cell warms it 0.8 °C; water beside a battery's electrode warms a few °C a
second. Metal spends nothing, so a wire stays cold however long it carries current.

So tungsten won't glow from current in v1, and that is physics, not a gap: per cell, tungsten (σ 1.8·10⁷ S/m)
conducts better than steel. A lamp's filament glows because it is thin (a thousandth of its leads' cross-section),
and all our cells are the same size. TPT makes it glow with a special case (SPRK on TUNG adds heat every frame). The
honest way here is a filament element whose `elec` is a real filament's conductance per cell; Joule heating then
does the rest. TPT's other spark heat (+10 K a spark on metal, up to 400 °C) has no physical basis, so we left it out.

**Sources.**
- The battery sparks every ready conductor touching it, every step it is ready: a train of sparks, one every 9
  steps, down each wire. TPT's battery skips water; ours doesn't, since a battery in water does drive current.
- The temperature sensor fires while a neighbour that isn't air, a wire (σ ≥ 1000 S/m) or another sensor is hotter
  than itself by more than `MATTER_REST_T`. A firing sensor sparks its conductors like a battery, one step later.
  TPT's sensor ignores METL, its own wires; we ignore every wire, since they can warm. It holds no heat (cond 0, as
  TPT's), so its own temperature is the threshold, set with Heat and Cool.
- The Spark tool, and lightning, through `sparkCell`.

**Insulator.** TPT's INSL blocks the spark's wide stencil. With six faces, anything that doesn't conduct already
blocks it, so our insulator is a material for keeping wires apart that also blocks heat: silica aerogel's numbers
(0.015 W/m·K, half of still air's), acid-proof, and it sinters into glass at 1200 °C.

## Rendering

A live conductor gives off `SPARK_GLOW` (`gfx/materials.js`): blue-white, the colour of a discharge in air (nitrogen's
bands from 337 nm into the violet, with atomic lines across the visible), as bright as twelve times fluorite's glow.
It is added:
- on surfaces, in `shaders/gfx/surface.js` `matOf`, which already gets each cell's ctype (crisp voxels, smooth
  surfaces, grains);
- to the light volume, in `shaders/passes.js` `brickFrag`, so a spark lights what is around it.
Not yet: liquid surfaces (water and saltwater sparks show only by the light they shed), the GI probes, the far
field, and the switch's on look (TPT draws an on switch bright green).

The dock tiles draw a live cell with the same glow (`ui/tiles/render.js`).

## Cost

Nothing about electricity runs where nothing is sparking:
- `inertSelf` (`shaders/common.js`) fails for a conductor that is live or resting, a switch turning off, and a firing
  sensor (`electricQuiet`). A battery, an idle wire, an on or off switch and a sensor that sees nothing hotter are
  inert, so circuits that are off sleep like any solid.
- `inertNear` (`shaders/activity.js`) fails for a ready conductor touching a battery (it is about to spark), an off
  switch or powered clone touching an on one, a powered clone that is on and touches air, and a sensor touching
  something hotter (`electricQuietNear`). A ready conductor beside a
  live one needs no rule: the live cell isn't inert, so its brick's neighbours stay awake.
- `nearChange` marks a switch or powered clone dirty when it turns on or off, since its neighbours' tests read that.
- A sensor's faces carry no heat (cond 0), so the thermal-quiet test skips them.
- A spark moves one cell a step, inside the activity map's budget of two.
The spark itself adds about 30 ALU operations to the react pass and no texture fetches. A battery keeps its wires
awake for as long as they are connected: that is the price of a running circuit.

## The plan for the rest

The three TPT groups, in the order to build them. Everything slots into `electric()` and its two quiet tests.

**Electronics (20 in TPT).**
1. Insulated wire (INWR): a conductor that takes sparks only from P and N and other insulated wire. A sender/receiver
   rule.
2. Instant conductor (INST): a whole connected body sparks at once. On the GPU that is a flood fill, one cell a step
   at the react pass's speed; a faster one is a jump-flood pass over the conductor.
3. Thermistors (NTCT, PTCT): conduct only above or below 100 °C. A receiver rule on temperature.
4. Electrode (ETRD): arcs plasma to the nearest conductor across a gap. Needs a search beyond the faces: a ray march
   in its own pass, like the POV tools'.
5. Tesla coil (TESC): throws lightning from its sparks, through el-mat's Lightning.
6. EMP: sparks and breaks electronics in a radius. A brush-like pass.
7. Wifi (WIFI): channels by temperature; every wifi on a channel sparks together. A per-channel reduction pass (a
   texel per channel), then a lookup.
8. Battery variants and the rest (BRAY, PPIP, QRTZ, RSST...) come with the projects that own them: rays, pipes.

**Powered (10).** All take TPT's "PSCN turns on, NSCN turns off" through the life field, as the switch does
(`SWITCH_ON`, spreading through touching cells), then do their thing while on:
1. Powered void (PVOD): el-mat's VOID gated on life, as the powered clone (done in v1) gates Clone.
2. Heat switch (HSWC): conducts heat only while on. condFlux reads both cells' life.
3. Pump (PUMP) and gravity pump (GPMP): push air pressure toward their temperature while on.
4. Delay (DLAY): a conductor whose rest is its temperature in steps. A per-cell phase length.
5. Liquid crystal (LCRY), storage (STOR), powered pipe (PPIP), powered breakable clone (PBCN).

**Sensors (7).** Each fires like TSNS (life 1) and sparks its conductors a step later:
1. Pressure sensor (PSNS): air pressure above its temperature's value.
2. Detector (DTEC): a given element (its ctype) nearby.
3. Velocity sensor (VSNS), linear detector (LDTC), life sensor (LSNS).
4. Invisible wall (INVS) opens under pressure; it is a sensor-shaped solid.
TPT's sensors look up to 2 cells away (25 for some). Six faces cover most uses; a radius needs a gather in its own
pass, run only on awake sensors.

## Merging

- Saltwater (el-chem) must carry `elec: 5` (seawater ~4.8 S/m at 20 °C) besides `conducts: true`, or it conducts
  like a metal. The metals (gold, tungsten, titanium, mercury, lithium) are fine with `conducts: true` alone;
  their real σ (gold 4.1·10⁷, tungsten 1.8·10⁷, titanium 2.4·10⁶, mercury 1.0·10⁶, lithium 1.1·10⁷) changes nothing
  measurable.
- A conductor's ctype holds its spark: an element with `conducts` can't use ctype for anything else.
- The Spark tool is id -9; -8 is left for el-mat's Lightning.
