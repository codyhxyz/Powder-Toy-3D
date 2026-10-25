# Voxel traversal: what the sources say, and what our march does

Topic: how to walk rays through a voxel world fast, and in particular how to skip the empty air next to
smooth surfaces. Sources and how each was obtained: `sources.md`. Every claim about a source quotes it with
a location. Anything marked **(derived)** is this agent's own reasoning, not the source's.

Our code was read at `tpt-swp` commit `8251d9d2` (origin/main, 2026-10-25), and the `arch/wavefront`
branch at `4a454396`, read only.

Measured facts this note takes as given (from BRIEF.md and the lead): march cost tracks loop iterations
(about 800 lane-cycles an iteration). About 17 of the Lab's 39 iterations a pixel are empty air beside
smooth surfaces. Turning off the 8-tap cubic filter, or reading 4–5× fewer cells, changed nothing.

---

## 1. What the sources say

### 1.1 Amanatides & Woo 1987: the grid walk

- **Per-step cost.** "Going from one voxel to its neighbour requires only two floating point comparisons and
  one floating point addition" (Abstract). The 3D loop needs "two floating point comparisons, one floating
  point addition, two integer comparisons and one integer addition per iteration" (§The New Traversal
  Algorithm).
- **Skip what is empty; test only cells that hold something.** "We loop until either we find a voxel with a
  non-empty object list or we fall out of the end of the grid" (same §). The loop body does nothing but step
  while `list == NIL`.
- **Two loops, a lean one and an exact one.** "we don't want to do this comparison until we have hit a
  surface so we have two traversal functions, one without the extra comparison and the other with"
  (same §, on checking that a hit lies in the current voxel).
- **Grid size trade-off.** "the cost plummets with only moderate increases in the subdivision rate" (Results,
  Fig. 3), but "as we increase grid subdivision, voxel initialization time, traversal time as well as memory
  usage also become significant thus ultimately limiting the subdivision rate" (Results).
- **Precomputed light visibility in the grid.** "At the cost of two bits per light source per voxel (one
  indicating that the voxel is completely in shadow, the other indicating that nothing blocks the voxel from
  seeing the light source) a great number of these rays no longer are necessary" (Conclusions).

### 1.2 Laine & Karras 2010 (NVIDIA TR): the sparse voxel octree ray caster

- **The hierarchy skip.** "If the bit corresponding to the voxel in valid mask is not set, or the active span
  𝑡 is empty, the code determines that the ray cannot intersect the voxel and skips directly to ADVANCE"
  (§6.1, p. 12). Each node has an 8-bit valid mask and an 8-bit leaf mask, one bit a child (§5.1, p. 6).
- **Bounding volumes tighter than cubes: contours.** A contour is a pair of parallel planes per voxel: "The
  result is a collection of oriented slabs that define a tight bounding volume for the surface" (§5.2,
  p. 6). They are used for skipping: "Doing the traversal in a hierarchical fashion also has the benefit of
  being able to improve the performance by using contours as bounding volumes of their corresponding
  subtrees" (§6 "Hierarchy traversal", p. 11). Safety rule for building them: "As long as we ensure that
  the original surface is fully enclosed by each contour, we are guaranteed to get an approximation that
  contains no holes" (§7.2, p. 17). Cost: 32 bits a contour, and "contours are only required in voxels where
  they enhance the surface quality" (§5.6, p. 9).
- **Contours made it faster as well as better.** Table 4 (p. 19), Mrays/s at 1024×768, cubical voxels →
  contours: CITY 54.3 → 89.1, SIBENIK 46.5 → 94.1, CONFERENCE 43.8 → 110.3. The paper's caveat: "the two
  datasets are different in terms of their average depth, as the improved approximation provided by
  contours makes it possible to prune the hierarchy more aggressively" (§8.3).
- **A lean loop body.** "Very little arithmetic has to be carried out during ray casts, except for the
  contour evaluation which requires intersecting the ray against a pair of parallel planes" (§3.7, p. 4).
  Table 6 (p. 21) gives instructions and iterations per ray: CITY 2238 / 29.4, SIBENIK-D 3866 / 52.8,
  FAIRY 1103 / 14.8. That is **about 75 instructions an iteration (derived)**. The child descriptor is
  "fetch[ed] … only once" while ADVANCE stays in a parent (§6.1 "Caching the current child descriptor").
- **Where the time goes.** "the dominant factor is the efficiency of ray casts, as shading costs are
  negligible and post-process filtering is one to two magnitudes faster than the ray casting" (§8.3).
  SIMD efficiency "hovers usually around 70% when no beam optimization is used, and 60% with beam
  optimization enabled" (§8.5, p. 20).
- **The beam optimization (a coarse depth pass that gives each ray a head start).** "render a coarse,
  conservative distance image and then use it to adjust the starting positions of individual rays. This
  has the effect of making the individual rays skip majority of the empty space at their beginning before
  intersecting a surface" (§6.2, p. 13). How: "we divide the image into 4×4 or 8×8 pixel blocks and cast a
  distance ray for the corners of these blocks in the coarse pass … We then subtract an appropriate
  constant from their minimum to determine the starting point of the ray". The condition: "terminating
  the traversal as soon as we encounter a voxel that is not large enough to certainly cover at least one
  ray in the coarse grid. Note that contour tests must be disabled in the coarse pass". Effect (Table 6,
  iterations per ray, no beam → beam): CITY 29.4 → 19.1, SIBENIK 25.8 → 17.7, SIBENIK-D 52.8 → 27.2,
  FAIRY 14.8 → 8.1. Mrays/s: CITY 89.1 → 106.0, SIBENIK-D 38.7 → 48.3. The coarse pass took 3.6–18.2% of
  frame time ("coarse %").
- **Level of detail by distance.** "our ray caster always uses a level of detail that is appropriate for
  the distance that the ray has traversed" (§3.2, p. 3). The loop terminates when the "voxel is small
  enough" by "comparing exp2(scale) against a linear function of 𝑡𝑐max" (§6.1, p. 12).
- **What failed.**
  - A short stack was slower: "with voxels the penalty is even more pronounced" (§6.4, p. 15).
  - Reusing the primary ray's stack for secondary rays: "the initial descent in the voxel hierarchy is
    very coherent and cheap. It looks like avoiding it is not worth even the small amount of extra code"
    (§6.4).
  - Interpolated attributes: "finding the neighbors and decoding and interpolating the attributes was more
    expensive than performing the actual ray cast" (§6.4).
  - Rasterizing voxels: "the rasterizer was several times slower than the ray caster" (§6.4).
- **Surfaces are about 2-dimensional.** "As the voxels get smaller, the scenes mostly converge towards
  two-dimensional setting, i.e. average of about 4 children per voxel" (§8.2, p. 19).

### 1.3 Hart 1994/1996: sphere tracing and Lipschitz bounds

- **The step rule.** A signed distance bound satisfies |f(x)| ≤ d(x, f⁻¹(0)) (Def. 2, eq. 7). The
  march is tᵢ₊₁ = tᵢ + F(tᵢ) (eq. 11, Fig. 1). The bound comes from the Lipschitz constant: "Let f be
  Lipschitz with Lipschitz bound λ ≥ Lip f. Then the function f/λ is a signed distance bound of its
  implicit surface" (Theorem 1, §2.1; the symbols were reconstructed, since extraction lost them).
- **Combining bounds.** "the Lipschitz constant of the sum of two functions is at most the sum of their
  Lipschitz bounds … the Lipschitz constant of the composition of functions is at most the product of the
  component function's Lipschitz constants" (§2.1).
- **Blurred / soft objects (the case closest to our fields).** For the cubic falloff
  C_R(r) = 2(r/R)³ − 3(r/R)² + 1: "Its Lipschitz constant is given by Lip C(r) = |C′(R/2)| = 3/(2R)"
  (App. D.1, eq. 41). For a sum of such blobs, d(x, B) ≥ (2/3) f(x) / ΣRᵢ (eq. 38, Theorem 5): "In
  practice, local Lipschitz bounds may be used for tighter distance bounds by taking the first summation
  … over keypoints i with non-zero contributions".
- **Loose bounds cost steps linearly.** "The accuracy of the distance estimate is directly proportionate to
  the rate of convergence. Experiments on a sphere show that half the distance doubles the number of steps"
  (§4.3, Fig. 13).
- **Local bounds by partition.** "Eliminating empty space certainly aids rendering efficiency, but the
  major benefit of partitioning is that it allows the imposition of local bounds on the Lipschitz constants
  yielding tighter signed distance bounds" (§2.6.4). But in his tests: "Experiments on simple scenes failed
  to demonstrate any increased performance from the octree enhancement" (§4.3). And: "techniques based on
  image coherence and space coherence (octree) did not perform as well" (§5).
- **Where it is slow.** "ray intersection is most costly at silhouette edges. When sphere tracing these
  edges, the distance to the surface is only a fraction of the distance to the ray intersection which
  slows convergence" (§4.3). On a ground plane: "Sphere tracing will step along this ray at fixed
  intervals looking for an intersection that never happens", and the convexity bound "avoids this
  situation" (§2.6.5). The convexity enhancement "hastened convergence by 31%" (§4.3, Table 2).
- **Blind sampling can miss roots.** "one can always construct a pathological function that will cause
  such a 'blind' technique to miss one or more roots, by inserting an arbitrarily thin region between
  samples" (§1.1).
- **A distance-transform volume is the voxel version.** The 3-D distance transform "takes a binary
  'filled/unfilled' voxel array to a numerical voxel array such that each voxel contains the distance to
  the closest 'filled' voxel" (§2.6.1, citing Zuiderveld et al. 1992).

### 1.4 RTR4 ch. 26 (free chapter): grids, empty-space skipping, coherence

- **Proximity clouds.** "Another strategy is to store, in empty cells, the distance in grid units to the
  closest non-empty cell. This system is called proximity clouds [14]. During the traversal, these
  distances allow us to safely skip many cells in the line marching routine that are guaranteed to be
  empty" (§26.4.1, p. 15). Also: "Two-level nested grids are particularly fast to construct in parallel on
  GPUs" (same page).
- **Memory against arithmetic.** "the most expensive operations, in both time and energy use, are memory
  accesses, which are orders of magnitude slower than simple mathematical operations" (§26.4, p. 12).
- **Divergence from mixing shading into the trace.** If rays in one wavefront need different shading, then
  "dynamic branching must be employed, leading to wavefront divergence and larger shaders that typically
  use more registers and result in low occupancy" (§26.4.2, p. 26). And: "Ideally, we would like to avoid
  interleaving complex shading and ray tracing" (p. 26).
- **Fewer rays plus a denoiser.** SEED's reflections: "only one reflection ray and one shadow ray at the
  reflection hit per 2 × 2 pixels are shot. However, reconstruction of the image is still done at full
  resolution" (§26.5, p. 30). Also: "divide direct and indirect illumination and denoise them separately"
  (p. 28).
- No free RTR4 chapter covers volume or voxel ray marching as such (see sources.md).

### 1.5 Teardown (Gustafsson): how its renderer is built

- **Primary visibility is rasterized; each object is marched inside its own box.** "Boxen som omsluter
  alla Voxlerna reanderas fortfarande som 3 angelar på grafikkotet. Men för varje pixel då som reanderas i
  den här boxen så går man igenom. Man stegar igen den här voxelvolymen och ser vilken voxel man stöter på"
  (SweClockers 2022, chapter 08:01; machine transcription, which garbles "trianglar" and
  "grafikkortet"). Translation: "The box that encloses all the voxels is still rendered as triangles on the
  graphics card. But for each pixel rendered in this box you step through this voxel volume and see which
  voxel you hit."
- **Lighting goes through a 1-bit world volume with its own mips.** "the shadow texture, only requires one
  bit per voxel … I store eight neighboring voxels per byte in an octree fashion … I also store two mip
  levels, one for 20 cm and one for 40 cm … 256 + 32 + 4 = 292 Mb for the shadow texture instead of the two
  gigabytes" (blog 2018-10-17, "Voxel storage").
- **Coarse to fine.** "starting in the lowest mip level and if it hits, switch to the larger ones
  progressively. The base mip level requires some bit masking" (same post, "Raytracing the shadow
  texture").
- **Each ray gets only the fidelity it needs.** "I actually use both supercover and the cheaper fixed step
  tracing depending on the use case. Ambient occlusion, for instance, or volumetric fog, doesn't require
  exact tracing … you can choose which fidelity you need for each particular ray and even change fidelity
  while walking the ray" (same).
- **A short screen-space trace, then the voxel volume.** The voxel ray starts at "a safe distance, based on
  the normal and ray direction", and the gap is covered "starting in screen space, trace the safe distance
  and unless it hits something switching over to voxel raytracing" (same, "Combining with screen space").
- **Soft lights hide the grid.** "it's really easy to make soft shadows by just jittering the light
  position. This will effectively hide artefacts from the voxel grid" (same, "Light sources").
- **Cost.** "I do all ambient occlusion, lighting, fog and reflections in this scene in about 9 ms,
  including denoising. The resolution is full HD and the scene contains about ten light sources … Timings
  taken on a GTX 1080" (same, "Performance"). That is the 2018 prototype. No source gives shipped
  Teardown's frame budget or a 60 fps breakdown.
- **Exponential steps, few of them.** "I start with a small step and then increase the step exponentially
  until I reach a maximum distance … the number of steps needed for each ray is also quite low, as long as
  the step size is exponential" (blog 2018-01-03). Example: "sixteen samples per pixel, and each sample is
  marched in twelve steps". Denoise: temporal filter "around 70%", then a spatial filter "7x7 pixel kernel
  in two passes" keyed by smoothing-group ID.
- **Diffuse lighting at a quarter of the pixels.** "Congratulations, you just saved ~75% processing time
  for your diffuse lighting … Computing diffuse lighting in half resolution (quarter pixel count) allowed me
  to do eight samples per pixel instead of two" (blog 2017-11-09). It uses an edge-aware "retouch vector
  field" for the upsample.
- **The volume is updated on the CPU and traced on the GPU.** "I create a voxelized version of the level
  that is all in memory, where I just represent each voxel as a single bit … It's super fast to just
  traverse the bits in that grid instead of visiting different objects and all acceleration structures"
  (SED1772 [0:14:54]). "The ray tracing is not on the CPU. It's actually on the GPU. It's only the update
  of this shadow volume" ([0:18:01]). Voxels "are on the scale of where 1 voxel is 10 centimeters"
  ([0:07:02]). Limit: "We couldn't have more than 4,000 voxels across the world because of a texture size
  limitation in OpenGL" ([0:30:55]).
- **The successor engine drops the shadow volume.** "It relies heavily on hardware raytracing (using
  intersection shaders, still no triangles!) … it no longer uses a shadow volume, which enables unlimited
  world size, sharp shadows, no light leakage" (blog 2024-12-29). DLSS Ray Reconstruction is the denoiser.

---

## 2. Our renderer against it

| Point (source) | Ours | Verdict |
|---|---|---|
| Grid walk: Amanatides & Woo | `src/shaders/dda.js:1-2` ("The voxel DDA (Amanatides & Woo)"), `ddaStep`, `ddaJumpBox` | Follow |
| Hierarchical empty skip (L&K valid mask; Teardown's octant bits + mips) | Sparse 4³ bricks plus a bit per 16³ and 64³ node (`src/shaders/world/copy.js:20-21, 38-39`); `skipEmpty` picks the biggest empty node (`src/shaders/world/march.js:224-239`) | Follow for crisp matter and true air |
| Skip what **cannot** hold a surface (A&W "list == NIL"; L&K "cannot intersect the voxel"; RTR proximity clouds) | A brick is flagged smooth-surface (`SURF`) and `MATTER` when any brick within one brick holds a smooth-surface cell (`copy.js:831-866`; `WC_DILATE = FIELDS_DILATE`, `copy.js:57`; `FIELD_REACH` = 2 blur + 2 boost cells, `src/shaders/fields.js:106-126`). `MATTER` also feeds the 16³ and 64³ nodes (`copy.js:864, 869-870`). Every such brick is walked a cell at a time, reading the field at the cell's exit and sometimes its middle, plus a root bracket per channel (`src/shaders/render.js:1307-1358`). The world copy derives these bits "from cells (no field textures: the world copy comes before them)" (`copy.js:17-18`) | **Violate.** A 12³-cell block around every grain of sand counts as "may hold a surface", though the 0.5 surface sits about half a cell from matter (`THIN_RADIUS = 0.5`, `src/gfx/materials.js:636`) to a cell or two away. This is the 17 of 39 |
| A certificate, not a guess (L&K §7.2 "fully enclosed … no holes") | The old box renderer already certifies liquid interiors from the field's per-brick maximum: "This is a certificate, not a surface approximation" (`src/shaders/passes.js:873-875, 899`). Its smooth-surface flag used the same maximum, but with a threshold of 0.03, not 0.5 (`passes.js:773, 892`) | The machinery exists. It is not applied to the 0.5 crossing, and not in the world copy |
| Contours / slabs (L&K §5.2, §6) | None. A smooth-surface brick has no per-brick bound on where its 0.5 surface lies | Missing |
| Lean loop body (L&K ~75 instructions an iteration; A&W's two loops; RTR "avoid interleaving complex shading and ray tracing") | One loop carries glass, crystal, liquid, media, films and grains (`render.js:941-1456`). It costs about 800 lane-cycles an iteration. The march, reflect and shade split (`march.js:338-361`) moved shading out. `arch/wavefront` 9fd231c1 splits off a lean loop ("exact; not faster") | Partly. The per-iteration weight is about 10× L&K's |
| Primary rays start near what they hit (L&K beam; Teardown rasterizes boxes) | The march starts at the world box or physics window entry (`march.js:280-292, 319-336`). No coarse depth pass, and no head start from rasterized bounds | Missing |
| Lighting traced once into a cache, not per pixel per frame (Teardown's bit volume; A&W's per-voxel light bits) | Sun shadow cascades traced per texel and cached; bounce-light probes; glow clips (`src/shaders/world/light.js:9-31`: "a texel is traced once and serves every pixel and frame under it") | Follow, in a different form. Not the bottleneck: the march is 28 of the Lab's 33 ms |
| Sphere tracing / Lipschitz (Hart) | None in the world march. The air is cell-stepped, and surfaces are bracketed with 2–3 samples a cell, then 5 steps of clamped regula falsi (`src/shaders/world/fields.js:354-381`) | Not applied (see §3: a weak fit for these fields) |
| Root finding robustness (Hart §1.1 on blind sampling) | Blind sampling of a band-limited field: blur σ 0.6–1.0 cells (`materials.js:142-145`), a midpoint probe for thin matter (`render.js:1327-1330`), and the thin-feature boost to keep small features above 0.5 (`shaders/fields.js:21-33`) | Follow, by band-limiting **(derived)** |
| Detail by distance (L&K §3.2) | Field level by pixel footprint (`world/fields.js:150-164`). The march still steps world cells at full resolution inside the window | Partly. The field LOD saves reads, not iterations |

**(Derived) Why the field certificate can be exact, not heuristic.** The trilinear read and the cubic
B-spline read are both weighted averages of texels with non-negative weights summing to 1. The B-spline
weights w0..w3 at `world/fields.js:255-258` are each ≥ 0 on [0, 1] and sum to 1. So every sample a ray takes
inside a brick is at most the largest texel it can touch: the brick's own texels plus 1 (trilinear) or
2 (cubic: "the cubic reading reaches two texels", `world/fields.js:44-46`). If that maximum is below 0.5 on
every surface channel, no sample in the brick reaches the surface. The march's crossing test
(`surfCross`, which needs a sign change of φ − 0.5) can then never fire there, and the brick is air for the
march. This holds whatever the blur, normalisation, thin boost or EMA did, because it bounds the values
actually stored. The liquid-exit case is the mirror image (minimum ≥ 0.5: the existing liquid-interior
certificate). Two caveats:
- Where a sample blends into level 1 (`fieldTex` mixing `L` and `L + 1`), the maximum must cover both.
- The certificate must be refreshed wherever the fields are rewritten. The derive already lists those
  bricks (`shaders/fields.js:80-84`).

---

## 3. What we missed, ranked by likely frame-time effect

1. **A field-exact "no 0.5 crossing here" bit per brick, used in place of the one-brick dilation.** The
   bit would be the max-of-texels certificate above, on the level-0 field for each smooth channel. Mark
   bricks whose certificate holds as non-surface, and leave them out of `MATTER`, so the 16³ and 64³
   nodes empty too. Then `skipEmpty` jumps them, and so do the occupancy levels above.
   - Evidence: A&W and L&K both make the empty test the loop's main exit ("skips directly to ADVANCE",
     L&K §6.1). RTR's proximity clouds "skip many cells … that are guaranteed to be empty". Our own box
     renderer certifies the mirror case already (`passes.js:873-875`).
   - Expected effect: it targets the measured 17 of 39 iterations directly. The upper bound is about 40% of
     the Lab's loop iterations. The real share depends on how many of the 17 sit in dilated bricks
     (`cellStepsDilated` in the cost view, `docs/profiler.md:136`) rather than in air cells of bricks that
     hold matter.
   - Cost: one max reduction per dirty brick after the field derive. The box era's brick pass did the same
     reduction (`passes.js:849-891`).
2. **Contour slabs for smooth-surface bricks** (L&K §5.2, §6, §7.2). Per brick, store a normal and the
   interval [d0, d1] along it that encloses the brick's 0.5 surface, built conservatively the way L&K build
   contours ("fully enclosed"). A ray in that brick starts field sampling at the slab's entry, and leaves at
   its exit without sampling. This removes the air cells **inside** bricks that do hold a surface, which a
   per-brick bit cannot. It suits a flat water top or a sand slope, where the surface in a 4³ brick is
   nearly a plane. L&K: about 32 bits a contour (§5.2, Fig. 4), and contours were also faster in their
   table (Table 4). Hart's ground-plane remark (§2.6.5) is the same failure mode: grazing rays step for
   nothing.
3. **A coarse depth pass that gives primary rays a head start** (L&K beam optimization, §6.2): iterations
   −35% to −49% and +8% to +25% Mrays/s in their scenes, for 3.6–18.2% of frame time in the coarse pass.
   Teardown gets the same effect from rasterized object boxes (SweClockers 08:01). For us, the coarse pass
   must treat smooth-surface and media bricks as solid ("contour tests must be disabled in the coarse
   pass"). It saves only the iterations before the first contact. Our 64³ and 16³ skips already make those
   cheap, so the gain is likely smaller than L&K's. On the Lab it is unknown.
4. **A lighter loop body.** L&K's iteration is about 75 instructions; ours is about 800 lane-cycles. A&W's
   "two traversal functions" and RTR's divergence warning (§26.4.2) both point at a lean walk that hands
   off to a rich body only at a candidate cell. `arch/wavefront` is this experiment, and it measured
   slower (9fd231c1: Lab 10.7 against 9.4 ms). Items 1–2 reduce how often the rich body runs at all,
   which the split alone does not.
5. **Lighting at a quarter of the pixels, with an exponential step schedule**, in Teardown's style
   (blogs 2017-11-09 and 2018-01-03: "~75%" saved; "twelve steps" a sample). This only matters if the
   near-field, AO or lamp shadow rays (`nearSteps`) turn out to be a large share once the march is fixed.
   Today the march dominates.
6. **Sphere tracing with a Lipschitz bound: not recommended for the air near these fields (derived from
   Hart's numbers).**
   - Bound for one blur pass: a Gaussian-blurred 0/1 field of width σ has slope at most 1/(σ√2π) per cell
     **(derived)**. That is 0.40 for liquid (σ = 1.0), 0.53 for granular (0.75) and 0.66 for organic
     (0.6), so from φ = 0 the safe step is 0.5/L ≈ 1.25, 0.94 and 0.75 cells. That is no better than one
     DDA cell.
   - The thin boost scales features up "~13x" (a drop) and "~4.5x" (a stream) (`materials.js:642-643`),
     which multiplies L the same way. The normalisation by the non-crisp weight (`shaders/fields.js:16-19`)
     has no simple bound at all.
   - Hart himself: "half the distance doubles the number of steps" (§4.3), and his octree of local bounds
     "failed to demonstrate any increased performance" (§4.3).
   - A compact-support field is better bounded by its maximum over a region (item 1) than by its slope.

---

## 4. Open questions the texts could not settle

- **How the 17 empty iterations split.** How many are in dilated bricks (fixed by item 1) and how many in
  air cells of bricks that hold matter (needing item 2)? The cost view's `cellStepsDilated` and
  `cellStepsOwn` should answer it from one capture. The surface path's iterations are not counted as
  `cellSteps` (the counter covers the crisp-only fast path, `render.js:1044-1054`), so the split may need
  one more counter.
- **Teardown's shipped frame budget.** No source gives Teardown's frame budget for 60 fps or how primary
  rays and lighting divide it. The only number is the 2018 prototype's ~9 ms of lighting at 1080p on a
  GTX 1080.
- **Teardown's voxel size.** The 2018 post says 5 cm voxels in 10 cm octant bytes; the podcast says 10 cm.
  Whether shipped Teardown kept the octant bits is not stated.
- **The certificate's margin.** Is "max over the brick plus two texels < 0.5" enough given float16
  storage (`tFS rgba16float`) and hardware filtering's low-precision weights? The liquid certificate uses
  0.499 (`passes.js:899`), which suggests a margin of about 1e-3.
- **Mips of the field.** L&K and Teardown both trace coarse levels first. Whether a per-node maximum of the
  field (a field-max pyramid over the 16³ and 64³ nodes) beats feeding item 1's bit into the existing bit
  levels is not settled by these texts.
- **Which supercover paper.** The paper Gustafsson links for supercover traversal is CiteSeerX
  10.1.1.42.3443. It is probably Amanatides & Woo, but this is unverified (sources.md).
- **The journal version of Hart.** Was it changed from the 1994 manuscript read here? The Springer copy is
  paywalled.
