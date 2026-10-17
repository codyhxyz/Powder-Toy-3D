# Water cost from first principles

Base `a700d765` (feat/physics-v2-finish). Research and a CPU prototype only: no production code, packed
state, save format or GPU kernel changes. No GPU, browser or headless run was made. Every cost below is a
byte count from a stated cost model, **not a GPU timing**.

## The premise to drop

R13 is the virtual-pipe model (Mei et al. 2007), which is a **2-D heightfield** method, made 3-D by letting
cells compress (W-Shadow 2009). A 3-D lake therefore has no pressure until it discovers it by compressing,
and that discovery is a sound wave running down every column. The stiff vertical acoustic mode is what
forces `SUB = 3`, `COMP ≥ 3·g·dt²`, the hidden mass, the vertical flux lane, and the cost scaling with the
awake **volume** of water: 336 B per awake cell per tick, wet or dry, 13 dispatches.

Hydrostatic pressure in a column is a prefix sum, not a wave. What a player sees and feels from bulk water is the
surface height, the flow at the surface, pressure through lids, jets and splashes. None of it needs the
interior simulated as a 3-D field.

## Recommendation: column runs (tall cells), one step a tick

Water is stored exactly as today (16 B core + 4 B bank). It is **interpreted** per (x, z) column:

- **Run**: a maximal vertical run of one liquid. A supported run is *packed*: every cell full except its
  top. Its head is its surface `η = bottom + M/FULL`, exact. There is no compression and no hidden mass in
  open water. Interior cells are never written, and their flux lanes are free.
- **Lid**: only a run filled to a solid lid compresses (Chorin's artificial compressibility, 1967):
  `η = lid + excess/(cap·COMP·FULL)`, with the excess in the run's top cell. Pipes, U-bends and full tanks
  carry pressure as today, but at one 60 Hz step (`COMP = 3·g·dt²`).
- **Fall**: a run with air under it falls as a rigid run on R1's column-fall law, as powder does.
- **Segment**: where two neighbouring columns are both open, their domains meet in a vertical face segment.
  Each segment has one depth-averaged flux: the shallow-water momentum equation without advection, with
  Audusse et al.'s (2004) hydrostatic reconstruction for the wet depth at the face, so a lake at rest over
  any floor is exactly at rest. The flux lives in the existing f16 face lane of the segment's bottom cell.
- **Depth clamp** `H_CAP = 16`: a face deeper than 16 cells accelerates as if it were 16 cells deep. This
  keeps one explicit step stable at any depth. It is also the deep-water limit, since real waves of length
  L travel at √(gL/2π), not √(gh).
- **Jets**: R14 unchanged, except that `H` is now the model's exact head.
- **Kept from R13**: integer fill, dead band = yield, viscosity as damping (converted to per tick, the
  same per second), the film rule, particles. The film rule is now the SWE dry tolerance (GeoClaw's
  `dry_tolerance`, Berger et al. 2011): a face whose upwind depth is under ⅛ cell carries no flux. The stall
  band generalises lean-sim's `1.5·damp/ACC` to `1.5·damp/(ACC·h_face)`.

Sources: tall cells (Irving et al. SIGGRAPH 2006; Chentanez and Müller, TOG 30(4) 2011); a heightfield with
spray particles (O'Brien and Hodgins 1995; Kass and Miller 1990); hydrostatic reconstruction (Audusse,
Bouchut, Bristeau, Klein and Perthame, SIAM J. Sci. Comput. 25(6) 2004). Minecraft and Teardown do not
conserve mass through pipes, and Noita and TPT have no pressure (audit-liquids B1, B2). None of the
touchstones meets the U-tube gate, so these sources come from the graphics literature.

## Gates: the bench's own tests, unchanged thresholds

Run with `node tools/outcomes.mjs --engine column --group liquids,controls`. The CPU twin of today's model
is `--engine lean`.

| gate (threshold) | current model (lean CPU twin) | column runs |
|---|---|---|
| U-tube (≤ 1 cm, rest ≤ 10 s) | 0.99 cm, rest 5.63 s | **0.02 cm**, rest 8.73 s |
| partial layer (≤ 1 cm, rest ≤ 8 s) | 0.16 cm, 4.1 s | 0.03 cm, **7.42 s (narrow)** |
| tankStill (stays full, rests ≤ 4 s) | 3.976 (0.6 % hidden), 2.55 s | **4.000 exactly, 0 s** |
| hole reach (≤ 5 %) | **12.78 % FAIL** | **1.78 %** (1.63, 1.40, 1.78 at the three heads) |
| pipe (≤ 0.1 cell over the bore) | 0.081, 43 s | 0.093 (narrow), 42 s |
| puddle (rest ≤ 6 s, edge) | 4.07 s, edge 4 | 3.65 s, edge 7 |
| yield (mud taller, water ≤ 1 layer) | n/a (one liquid) | 53 cm taller, water 0.25 |
| splash (KE ≤ 0.3) | n/a (no resident velocity) | 0.14, see the caveat below |
| mass exact | 0 | 0 |

Stability: in a 30-deep lake, a surface checkerboard decays from 0.75 to 0.007 cells in 5 s with `H_CAP = 16`.
Uncapped, it blows up to the full grid, which shows the clamp is load-bearing. A 31-deep dam break stays
bounded, with exact mass.

## Cost: bytes and passes per awake tick, both models on the same 64×32×64 scenes

Run with `node tools/v2/column-water.mjs`. Awake bricks follow the GPU rule: busy in the 3³ neighbourhood
within the last 8 ticks. The current figure is 336 B per awake cell. The column figure is 224 B per awake
brick (uncached mask reads over four passes), plus 64 B per run, 32 B per segment and 32 B per written
cell (constants in `COST`).

| scene | current | current with dry skip (agent 4) | column runs | column vs current |
|---|---|---|---|---|
| settled 24-deep lake, woken | 44.0 MB, 13 dispatches | 31.7 MB | **0.98 MB, 4 dispatches** | 45× (32×) |
| 4×4×8 block into a 16-deep pool | 20.8 MB | 15.7 MB | **0.90 MB** | 23× (17×) |
| dam break, 16×24×64 | 17.4 MB | 9.6 MB | **0.72 MB** | 24× (13×) |

Both models sleep at the same tick on the woken lake. Mass is exact in all six runs. Column cost scales with
**runs and segments, about the surface area**. Its remaining per-brick term is mask reads that L2 should mostly
absorb, so the uncached figure is the conservative one.

## Candidates, ranked

| | cost vs current | fixes | breaks / risk |
|---|---|---|---|
| **1. Column runs (prototyped)** | 1/23 to 1/45 | substeps, hidden mass, hole head (12.8 → 1.8 %), U-tube margin, still-lake interior cost, defined resident KE | no vertical shear inside a run; heat attributed to the run surface; no upward nozzle jets without R14 on +y |
| 2. Prefix-sum head inside today's per-cell 3-D pipes (docs/v2.md risk 4) | ~1/4 (est.: one step, 2 axes, ~90 B/wet cell) | hidden mass, the hole head | still volume-scaled; keeps per-cell flux in the interior |
| 3. Dry-brick skip (agent 4) | 0.55 to 0.72× (measured above) | nothing physical | none; orthogonal, and ships first |
| 4. Implicit SWE or tall-cell multigrid (Kass and Miller 1990; Chentanez and Müller 2011) | 1 + 10 to 30 surface iterations | removes `H_CAP` | a solver, more passes; only worth it if long deep-sea waves matter |
| 5. Semi-Lagrangian 3-D + projection (Stam 1999) | 3 to 10× worse (20 to 50 Poisson passes × volume) | — | mass not exact, no integer custody |
| 6. LBM D3Q19 | ~5× worse (152 B/cell/step at ~6 steps a tick for Mach ≪ 1; 76 B state) | — | 5× the 16 B core; free surface is extra (Thürey 2007) |
| 7. SPH / PBF (Macklin and Müller 2013) | 1–3 KB per particle per tick, about 1 particle per cell | — | no exact rest, no sleep |
| 8. FLIP / APIC | both a 3-D solve and particles | — | as 5 and 7 |
| 9. TPT/Noita cellular rules + particles | ~0.1× | — | no pressure: the U-tube and pipe fail (v1, audit-liquids B1/B2) |
| 10. Minecraft levels / Dwarf Fortress pressure teleport | cheap / unbounded search | — | mass not conserved / nonlocal and not GPU-shaped |

Column runs on each axis the brief asked about:

- **Exact mass**: integer runs, floor transfers under one K per sending run.
- **Determinism**: each segment is owned by its −side column, and there are no float atomics.
- **Sleep**: still runs have zero segment flux, so a lake sleeps in one 8-tick cycle.
- **Pipes and U-bends**: covered runs.
- **Multiple liquids**: runs are single-id. Another liquid is a floor or a lid, and the overburden of a
  supported upper liquid adds to the head as a column prefix sum. That overburden is designed but **not
  prototyped**.
- **Lava and mud yield**: the same dead band, per segment.
- **Heat and fuel custody**: the canonical integer share helpers, with the sending run's top cell as the
  packet source and the receiving run's top cell as the destination. This is a design only: the prototype
  carries no heat or fuel.

## Momentum, jets, splashes, and agent 7

The model gives momentum a home without any allocation. Each segment's depth-averaged flux `u` is a
staggered (MAC) momentum per face, already in the f16 lanes, and a falling run carries its fall speed. A
resident cell's velocity is complete under this model: horizontal from its faces, vertical from falling runs
and from surface continuity in packed runs. That is why the bench's splash test becomes expressible.

Resident KE is `Σ ½ρ·h·u²` per segment plus `½mv²` per falling run, and landing KE is exact at the landing
event. The splash pass at 0.14 needs a caveat: landing is inelastic and no crown is emitted, so the 0.14 is
the merged bump spreading. The crown rule (≤ 0.3 of the landing KE) remains to be built.

The jet reach is right, but discharge is not Bernoulli. Through the bench hole, the tank loses 2.3× the
Torricelli flow `A·√(2gh)`, while the current model loses 4.3 to 4.6×. The particle's mass comes from the
face flux and its speed from the head, so momentum flux is inconsistent in both models. With an exact head
per run, the fix is local: the SWE advective term on outlet faces, whose steady state is Bernoulli. That is
agent 7's contract. This model removes their need for a head scan or a compressed-head decoder.

## Migration from the current packed state

1. The core ABI is unchanged. In open runs fill ≤ FULL, and only a covered run's top cell exceeds FULL.
   Old saves load as valid input: the first column pass packs them with exact mass, and today's hidden 0.6
   to 5 % reappears once as a level rise. `core.z.x` and the low16 of `core.w` hold segment flux at segment
   bottoms. The y lane holds the falling-run speed. Interior lanes are free.
2. The R13 tick loop changes from `SUB × (flux, limit, jets, gather)` plus foam (13 dispatches) to four
   dispatches over the existing awake column list (`v2cols`): column (pack, fall, η into `liquidScratch`
   at the run bottom), flux (segments, from brick masks), limit (K per run), gather (surface writes,
   deposits, R14 jets).
3. The canonical packet, energy and fuel helpers, particle deposition, R14 predicates and foam stay the
   same, with the run surface as the source cell.
4. Rework these checks: `liquid-limiter-order`, `gather-identity`, `integer-transport`,
   `jet-restoration`. Then run the original GPU gates at unchanged thresholds.

**Size:** about 500 to 700 WGSL lines replace about 360 (src/shaders/v2.js R13, src/shaders/v2/jets.js), plus
the `_tick` loop in src/v2/physics.js.

**Risks:**
- Mask-based run scans and neighbour-domain lookup are a new kernel shape.
- Covered runs hide 5.4 % of a cell per cell of head above the lid (6.8× today's per-cell COMP, but only
  under lids).
- Sheets under ⅛ cell now stop on wet slopes too.
- Falling runs don't exchange sideways.
- Long waves deeper than 16 cells travel slower than √(gh).
- Partial and pipe pass with narrow margins.
- No GPU timing exists yet.

**Measure next:** split GPU timings of both models on these three scenes; the original GPU gates; L2 hit
rate on the mask reads; and a long-run heat-stratification check.

## The port (src/shaders/v2/columns.js)

The native tick runs the model as two kernels over the awake column list, after the block pass: `v2runs`
(pack, fall, foam decay, per-column domain records in `liquidScratch`, and the records of sleeping
neighbours) and `v2pairs` five times (one Jacobi flux stage over every x and z face, then four
transfer colours, x and z at each parity, in which a thread owns a column pair outright). Every unit of
fill moves cell to cell through `colMove`, with the exact integer share of carried energy and fuel, its
ctype, lava subtype and burning flag; a move that would leave the format is refused and retried.
`tools/v2/column-wgsl.mjs` executes the emitted `col*` bodies on the CPU, and the bench runs them with
`--engine column-wgsl`: U-tube 0.02 cm / rest 9.18 s, partial 0.02 cm / 7.7 s, puddle 3.33 s,
pipe 0.084, tankStill 4.000 / 0.02 s, yield pass, mass exact (`tools/v2/column-wgsl-check.mjs`).

Where it differs from the prototype, and why:
- **Transfers by colour, limit per pair.** Splitting the axes (x then z, each on the new heads) grows a
  point drop's ripples without bound, and alternating the colours keeps the U-tube's covered channel
  trading single quanta past 10 s. The flux stage is the prototype's Jacobi step; a sending run is
  limited by what it still holds when each pair moves, not by one K over its four sides.
- **Overfalls pour and jets launch from the exact head.** A face above the receiver's surface pours into
  the receiver's cells at its wet rows (they fall as runs); a cell left faster than 1 m/s over open space
  is marked and `src/shaders/v2/jets.js` launches it at sqrt(2 g H), H the sender's or its feeding
  neighbour's exact run head. Agent 7's energy-head term acts on contractions in the flux stage. Hole:
  1.08 % off the parabola, launch 1.00 and discharge 0.96 of Torricelli.
- **Cost.** A brick summary (support writes it, noteState clears it) lets the runs pass skip uniform
  bricks, and a per-brick-column awake word replaces the brick loop. On this note's 64×32×64 scenes the
  passes now move 1.43 MB (woken lake), 2.09 MB (pour) and 1.91 MB (dam break) per awake tick, from 6.2,
  4.09 and 4.2 MB before those fixes (R13: 44.0, 20.8, 17.4), counted as each dispatch's footprint.
- **Open and loop edges.** An open side is a dry, bottomless neighbour and an open floor drains at R1's run
  speed, into the boundary ledger; loop seams wrap like any face (the witness checks both).
- **Not yet:** radial gravity only drips liquids toward the centre (no spreading); one liquid's weight on
  another (oil on water) needs a sub-cell interface first; the splash crown.
