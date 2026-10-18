# Native simulation modes

The saved gravity slider is normalized against its shipped `0.025` default.
Native acceleration is `(setting / 0.025) × 19.6 m/s²` (TF2's roughly 2g,
`docs/v2.md` §5.1), not the legacy cells/step² acceleration. `nativeModes`
validates modes and supplies the same per-dispatch values to grid and particle
kernels. `nativeBodyGravity` supplies the same vector in cells/s² for POV.
Radial gravity is constant magnitude toward the local box centre (TPT); gravity
at the exact centre and in Off mode is zero. The native tick is 1/60 second;
liquid substeps remain 1/180 second. No extra speed-slider multiplier belongs
in force or velocity conversion.

`MODE_FIELDS` / `modeWGSL` are the shared air/dynamics/contact integration API.
`mGravity` takes local cell coordinates and returns m/s². `mEdge` wraps integer
cell addresses on all three axes. `mFaceDrive` uses radial potential differences;
vertical periodic seams experience the same uniform force as any other face,
not a fictitious full-box height drop. Liquid pressure remains active at zero g.
World windows force Solid edges regardless of saved edge mode.

Changing the settings signature wakes both activity histories without touching
cell cores, fractional liquid/fall state, or energy banks. Ordinary `wake()` and
brush writes do not sweep all activity. Changes to the shared ambient temperature
also take this path when the compact engine owns the state.

Open grid faces drain gas/liquid through an isolated native boundary pass.
Cumulative removed material volume (FULL=65536 per full cell) is a 64-bit count
at `v2ActLayout(g).boundaryMass`; its two words use the pre-existing reserved
count slots and do not resize saves. Exact removed material energy, including
its apportioned bank, enters the existing 96-bit energy sink. The empty carrier
retains its own energy. Solid and periodic boundaries never drain. R5 ambient
exchange runs only on actual open side/top faces with ambient heat enabled,
not on the floor or a 0K sentinel wall.

## Integration status

This slice is **not v2 mode-completeness certification**. The fast column solver
is vertical/Solid only. Radial/Open/Loop powder must be promoted by native
dynamics to ballistic particles, with allocation backpressure retaining source
material/events when capacity is exhausted. A slow 2³-block falling substitute
is deliberately not shipped as ballistic parity. Rotated disjoint block frames
still provide topple and density-swap rules. Air mode behavior, particle edge
handling, and POV consumption are integrated by their owning lanes.

CPU checks: `node tools/v2/modes-check.mjs` and
`node tools/v2/modes-wgsl-check.mjs`; the latter validates actual emitted grid
and full-contact WGSL with Naga, without a browser or GPU. Dynamics WGSL has its
own existing CPU validator. These tests do not claim GPU execution evidence.
