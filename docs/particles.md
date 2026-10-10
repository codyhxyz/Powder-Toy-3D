# Fast particles: photons, neutrons and fission

The Powder Toy's Radioactive group needs particles that share a cell with matter and fly straight through it. TPT
keeps them in a second map beside `pmap` (`photons[y][x]`, Simulation.cpp), moves them a few pixels a frame
(`TYPE_ENERGY`: no gravity, no drag), and lets each element's `update` act on what it passes. This page says how we
do that on the GPU, what the particles do, and what comes next. Code: `src/rays.js` (the layer, its constants and the
nuclear table), `src/shaders/rays.js` (its passes). Checked on the CPU by `tools/rays-check.mjs`.

## The decision: a particle list, not a second grid

Our constraints: WebGL2 fragment shaders only (no compute, no atomics); the state is read through `fetchA`/`fetchB`
(docs/scaling.md D5); a step is a block pass and a react pass over awake supertiles (D8); an empty world must cost
nothing.

| | (a) A second per-cell layer | (b) A fixed-capacity list (chosen) |
| --- | --- | --- |
| Memory, 128³ (the World's window and the biggest box) | 2.1 M cells × 2 RGBA32F (sub-cell position, direction, energy) × 2 copies = **134 MB**; packed to 8 B/cell, 34 MB | 65,536 slots × 4 RGBA32F × 2 copies (list, scratch) = **2 MB**, any grid size. Plus the deposit target, RGBA16F laid out like the state: 16.8 MB at 128³ |
| Cost with no particles | A 26-neighbour gather over every awake cell, per substep (~0.2 ms a full pass at 128³), unless it gets its own occupancy culling | **0**: the CPU skips every pass (an async count says when the last one died) |
| Cost with n particles | The same full passes | One fragment per slot (≤ 3 cell fetches), two point draws of n |
| Moving straight at any angle | Needs a sub-cell position per cell, and two arriving in one cell collide | Free: a float position and velocity |
| Spawning (fission) | Natural: write the neighbour cell | No atomics, so children go to **fixed slot bijections** (below) |
| Drawing | Compaction, or 2.1 M points | n points straight from the list |

Spawning without atomics. Pass A advances every slot and leaves a request: how many extra children it wants this
step. Pass B fills dead slots: child k of slot i goes to slot (i + k·S) mod N, with S an odd stride that changes
every step, so a dead slot j asks only its K candidate parents (j − k·S) mod N. If slot j is alive the child is lost.
That is the hard limit of a runaway: at most N particles and K children per slot per step, so nothing can hang the
GPU. Matter that emits on its own (plutonium's spontaneous fission) uses a stripe: dead slot j examines atlas texel
j + N·(t mod M), so every cell is examined once per M = ⌈texels / N⌉ steps (32 at 128³) and emits with probability
p·M then. The rate per cell stays p while slots are free, and falls when the list is full.

Coupling back to the grid. Pass A also leaves a deposit: the cell it interacted in, the heat and the pressure. A
point draw adds the deposits into a target laid out like the state (additive blend), the react pass adds them to its
cells (T += heat / cap, P += pressure), and a second point draw zeroes the same texels again, so the target is all
zero between steps without a full clear. A second point draw marks the bricks that hold a particle (brick
resolution); the quiet map (shaders/activity.js) treats them like bricks that aren't inert, so the bricks around a
particle stay awake and the D8/D9 machinery (supertiles drawn, derived passes rebuilt) follows unchanged. That needs
a particle to move at most one brick (4 cells) in the two steps a map lives: speeds are capped at
`BRICK / ACTIVITY_PERIOD` = 2 cells/step (`RAY_V_MAX`).

When the layer runs. `Rays.active` turns on when particles or plutonium are painted, and on load and undo (they can
bring plutonium back). Every stripe cycle an async read (PBO and fence, no stall) counts live slots and the dead
slots that saw plutonium in the cycle; when both are 0 it turns off and clears the brick map.

## Interaction rules (v1)

Every particle is a Monte Carlo packet: what matters is its energy share and how often packets multiply, not how
many real photons or neutrons it stands for.

**Photon** (TPT PHOT: 3 px/frame, 680 frames, passes `PROP_PHOTPASS` elements, reflects off the rest and averages
its 922 °C with what it touches). Ours carries an RGB energy share e, starting white, and flies at `PHOTON_V`:
- Clear matter (render class glass, liquid or gas: glass, water, ice, acid, oil, steam, smoke) transmits it, and
  absorbs `1 − exp(−σ)` of each channel per cell, with σ the same per-cell extinction the renderer uses
  (elements.js `sigma`, water's within 2× of Pope & Fry). Water turns a beam blue-green and warms.
- Metals (`reflect`, the normal-incidence reflectance: steel 0.58 from its measured complex index, the F0 in
  gfx/materials.js) reflect it specularly off the face it hit and keep that share; the rest is heat.
- Anything else opaque absorbs it all.
- Absorbed energy is heat: `PHOTON_HEAT` × the share absorbed, in heat-capacity units (a white packet warms wood
  by 300 °C, past its 300 °C ignition point, as TPT's 922 °C average with 20 °C wood does). Ignition is the
  cell's own rule (react.js): photons light wood, oil and gunpowder.
- Refraction (TPT bends photons at glass faces) is left for later: it needs a surface normal.

**Neutron** (TPT NEUT: random direction, 1–2 px/frame, passes `PROP_NEUTPASS` elements, slowed 0.5% per frame by
water). Ours does real transport, one group of cross-sections joined to a thermal one:
- Energy E (MeV). Born at `NEUT_E_FAST` = 2 MeV (the mean of the Watt fission spectrum). Speed
  `NEUT_V·√(E / E_fast)`, floored at `NEUT_V_THERMAL` (a 0.025 eV neutron is 10⁴× slower than a fast one: real
  speed would freeze it, so its time is compressed, as TPT's is).
- In a cell of material m it interacts with probability 1 − exp(−Σt·ℓ) over its path ℓ. Σ = N·σ from the table
  in `src/rays.js` (`NUCLEAR`), per real cm, times `NEUT_CM_PER_CELL`. Absorption and fission follow the 1/v law
  below a fast plateau (σ(E) = max(σ_fast, σ_th·√(E_th/E))), scattering is interpolated in ln E.
- Scattering is isotropic. Off hydrogen it keeps a uniform share of its energy (elastic scattering on mass 1: E' =
  u·E, the textbook result), so about 18 collisions take a fission neutron to thermal: real moderation. Off
  heavier nuclei it keeps (α + (1 − α)·u)·E with α = ((A − 1)/(A + 1))².
- Capture ends it and leaves `CAPTURE_HEAT`. Fission ends it and starts ν new fast neutrons (2 plus a coin weighted
  ν − 2, so ν = 2.98 on average), leaves `FISSION_HEAT` and `FISSION_P`.
- Matter not in the table is transparent to neutrons in v1 (their real fast mean free paths of 3–10 cm mostly
  redirect a neutron without slowing it).
- The length scale is a liberty, stated. At 0.3 m cells a real cell of plutonium is 535 kg, about 50 critical
  masses: one painted cell would go off. `NEUT_CM_PER_CELL` = 1 makes a cell 1 cm of matter to a neutron, so the
  cross-sections keep their real ratios and a bare plutonium ball goes critical at about the radius one-group
  diffusion gives in mean free paths (R ≈ 1.9 λ_t = 5.6 cells for λ_t = 2.95 cells). The Monte Carlo of these rules
  in `tools/rays-check.mjs` measures k_eff 0.95 at R = 6 and 1.17 at R = 7 bare, so about 6.3 cells (~1,000 cells
  of powder); in a 6-cell water jacket, 0.91 at R = 4 and 1.11 at R = 5, so about 4.6 (~400 cells).

**Uranium**: natural uranium metal as a heavy powder, 19.1 g/cm³. TPT heats it under pressure; real uranium barely
does anything by itself (U-238's half-life is 4.5 × 10⁹ years, so its decay heat is ~10⁻⁸ W/g, and its spontaneous
fission gives 0.014 n/s/g, 4,400× less than reactor plutonium). So ours just sits there unless neutrons hit it. It
scatters them back (a tamper or reflector), captures some (U-238) and fissions a little (U-238 above 1 MeV, U-235's
0.72% when thermal). Its thermal η = ν·σf / σa ≈ 1.3 is the real reason natural uranium can't go critical in
light water.

**Plutonium**: Pu-239 metal as a heavy powder, 19.8 g/cm³, melting at 640 °C (into lava that is still plutonium:
its ctype). Fissile: fast σf 1.85 b, thermal 747 b (Lamarsh Table 6.1 and ENDF/B-VII.1), ν 2.98, so k∞ = ν σf / σa
≈ 2.6 and a lump past its critical size runs away. It emits spontaneous-fission neutrons at `PU_SF_RATE` per cell
per step (real weapons-grade plutonium: ~60 n/s/g, from its Pu-240). Each fission heats and pushes: the lump melts,
the pressure throws the powder apart, and the spreading lump goes subcritical. That disassembly is the real limit
on a runaway. Water around a lump returns slowed neutrons that fission 400× more readily, so a moderated lump goes
critical far smaller: a real hazard (criticality accidents happened in plutonium solutions).

## Measured (v1, `tools/rays-gpu.mjs`, headless M5, ANGLE Metal, 128³, 2026-10-10)

- **Photons**, 171 white packets painted inside each of three closed 14-cell boxes: the wood box soaked them all up
  within 10 steps (wood to 753 °C, 61 cells of fire; 233 by step 60); the metal box still held all 171 at step 10
  (metal to 86 °C) and none by step 60 (faded below `PHOTON_E_MIN` after ~7 bounces); the glass box let them all
  out by step 10 (glass to 35 °C).
- **Neutrons**, 228 painted in a water block and 228 in a stone block: mean energy in water 2 → 0.36 MeV after 10
  steps, 0.006 after 40, all 202 left thermal after 120 (still diffusing in the water); in stone they kept 2 MeV and
  flew straight out (3 of 228 left in its region at step 40).
- **Fission**: a 4³ plutonium block (64 cells) with 18 neutrons: 4 left at step 50, none at 100, the block 37 °C at
  most. A 16³ block (4,096 cells) with 58: 3,151 neutrons at step 25, 23,342 at 50, 30,751 at 75 (the list's cap
  is 65,536); it melted (3,144 cells of molten plutonium at step 50, all 4,096 by 100, at the 6,000 °C cap) under
  the pressure cap (200), then spread and went subcritical: 20,214 neutrons at 100, 607 at 400.
- **Cost per step** of the particle passes (GPU-synced, best of 4, with other sessions holding the GPU at 93–99%, so
  high): asleep **0**; awake with no particles 0.5–1.1 ms (the sweep after a load or paint, and all the time while
  plutonium is in the box); 65,536 neutrons 1.0–1.6 ms. A whole step with those 65,536 in a million cells of water:
  12–14 ms against 2.2–3.1 asleep, nearly all of it the water they keep awake.

Not yet: multiplayer guests don't see particles (the list isn't streamed); a World window move lets them go (their
positions are grid cells); a supertile asleep when a particle is born inside it may miss that particle's deposits
for one step (the quiet map is rebuilt every second step); the passes' fixed cost while awake (above) could be cut
by skipping the point draws when the last count found none.

## The rest of the Radioactive group, in order

1. **Polonium**: Po-210, 138-day half-life, 140 W/g of alpha decay: it glows red-hot by itself (a heat source in
   react.js), and as a Po-Be source it emits neutrons (the stripe emitter). Melts at 254 °C.
2. **Deuterium** (heavy water): a moderator that barely absorbs (σa 0.0013 b vs H's 0.33 b), so natural uranium in
   it goes critical. A row in `NUCLEAR`.
3. **Refraction**: photons bend at glass and water faces by Snell's law with dispersion (TPT's GLASS_IOR and
   GLASS_DISP), with the normal from the occupancy gradient.
4. **Light sources**: fire, lava and anything glowing past ~800 °C emit photons by their blackbody colour; a laser
   (TPT's BRAY emitter) emits a beam.
5. **Electrons and protons**: the same list, two more kinds. Electrons spark conductors (needs el-elec's spark),
   protons heat and transmute.
6. **Filter, quartz, glow, resist, isotope-Z, warp, exotic matter, vibranium, graviton**: rows on these kinds.
7. **Breeding**: U-238 capture → U-239 → Np-239 → Pu-239 (half-lives 23.5 min and 2.4 days), as a chance per
   capture that the cell becomes plutonium.
8. **Neutron scattering in all matter**, from each element's density and a mean nuclear mass.
</content>
</invoke>
