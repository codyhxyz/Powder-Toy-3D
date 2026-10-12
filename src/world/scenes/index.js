// World scenes: what a world (the Grid size row's World) holds everywhere.
// The Scene row lists them while the grid is a world, the way it lists the
// box presets for a box (docs/scaling.md D11, "Scenes").
//
// A scene is a pure function of the world cell, so any region of the world
// generates seamlessly next to any other: the window fills its slabs from it as
// it moves, a slab leaving the window is compared with it (only bricks that
// differ go to the edit store), and the far field summarizes the whole world
// from it. Every scene, the island too, goes through sceneCell
// (shaders/generate.js sceneFillFrag, sceneDiffFrag; shaders/far.js
// farSceneCellsFrag, farSceneFrag).
//
// A scene is an object (its GPU side: scenes/sceneGpu.js, world/gpu.js SceneGpu):
//   key            its settings value (settings.scene)
//   label          its name in the Scene row
//   size           optional: its world's size in cells [x, y, z], when not
//                  shaders/far.js WORLD_SIZE (the giant volcano's is taller).
//                  The window spans its height (app.js worldOf), so it builds
//                  its own pipelines instead of sharing the box's
//   params({ size, seed })
//                  its world parameters P: at least { size, seed, sea, floor }.
//                  sea: the open water's level for the far view and GI (cells; 0
//                  for none); floor: the generator floor's thickness (cells)
//   glsl(g)        WGSL (the name is the GLSL era's, docs/webgpu.md W2),
//                  included after the prelude in every pipeline that runs the
//                  scene, starting with sceneHeadWGSL(uniformStruct, { data })
//                  (its group-2 bindings: SU, and SD with sdWord if it has
//                  data; the SceneCell struct), and defining
//                    fn sceneCell(w: vec3i) -> SceneCell
//                  the generated state of world cell w in the state layout:
//                  A = (id, °C, life, ctype + seed), B = (velocity, pressure) = 0.
//                  A pure function of w, SU and SD. Matter at its spawn
//                  temperature and life (SPAWNT, SPAWNLIFE) unless the scene
//                  says otherwise, its seed hashed from w (seedWorld). Cheap:
//                  the fill runs it for every cell of a 128³ window, the far
//                  build for every sample. Code shared with a JS twin is the
//                  GLSL subset (themedShared.js), emitted by toWgsl
//                  (subsetWgsl.js), never hand-ported (docs/webgpu.md H1.27)
//   uniformStruct  its uniforms' struct: sceneStruct(fields) (the world seed
//                  uSceneSeed first; WGSL types, 'bool' as u32)
//   uniforms(P)    their values for world P, { name: value } (numbers, arrays,
//                  vec4s(...) for the GLSL era's uniform arrays), uSceneSeed
//                  among them
//   data(P)        optional: the words of its data buffer (SD, array<vec4u>),
//                  { at, words: Uint32Array } (words from word `at` on; what
//                  lies before is the bake's), for structures and a Wang
//                  tiling's palette, placement and atlas
//   bake           optional: { size(P) → [w, h], code() → WGSL, workgroup }: a
//                  kernel over w × h that writes the start of the data once per
//                  world, before its first fill (the island's columns), with
//                  the data read_write (sceneHeadWGSL access 'read_write')
//   pre            optional: { code(g) → WGSL (preMainWGSL over the costly part),
//                  margin(P) → [x, y, z] }: the prepass, a costly part of
//                  sceneCell computed into the data over a kernel's region
//                  plus the margin before that kernel runs, and read back
//                  there (preReadWGSL); the island's caves (sceneGpu.js)
//   start(P, win)  [x, z]: the world column the window starts centred on (where
//                  the most is going on); win: the window's [nx, nz]
//   ground(x, z, P)
//                  the CPU's twin of the ground: the top of the topmost solid or
//                  liquid matter at world column (x, z), in cells (the god
//                  view's home sits over it)
//   prepare(P)     optional: a Promise for work the scene needs before its
//                  uniforms and data are final (placing structures, baking a
//                  Wang tiling); the generator waits for it, then takes
//                  uniforms(P) and data(P)
//   dispose()      optional: what the scene cached for its worlds
//   view           optional: the god view's home, when not app.js
//                  WORLD_VIEW_DIR and WORLD_VIEW_DIST: { dir, dist, lift },
//                  the camera dist cells from the orbit target along dir, the
//                  target lift cells over the ground (the window follows only
//                  its column)
//   trees          optional: trees it plants, as TREE constructions
//                  (constructions/builtins.js), the island's:
//                    treesIn(x0, z0, x1, z1, P, cache)
//                      the trees whose trunks stand in world columns [x0, x1) ×
//                      [z0, z1): [{ x, y, z, variant, size, quarter, seed }], at most
//                      one a brick column, thinned as world/generator.js treesIn
//                      does; the window stamps them where it goes first
//                    glsl()
//                      the far field's GPU twin of its candidates, WGSL with the
//                      scene's head and cell code, after shaders/far.js treeGLSL:
//                        fn sceneTreeCandidate(bc: vec2i) -> vec4f: brick column
//                          bc's candidate (x the packed tree as treeOf reads it, y
//                          its ground, z its priority; 0: none)
//                        fn sceneTreeKey(bc: vec2i) -> u32: its key (seed =
//                          pcg(key), quarter = (key >> 20) & 3)
//                  The far field draws them at brick scale into the bricks it builds.
//   structures     (no hook: part of the cells) a scene with structures (world/structures.js:
//                  the island's) includes STRUCT_GLSL, defines fn structureGround(w: vec3i)
//                  -> i32 (its own cell), applies structureCell in its sceneCell, takes
//                  STRUCT_FIELDS into its uniformStruct and structureWords(P) into its
//                  uniforms and data, and drops tree candidates where structureClears
//   shrine         optional: false for no world shrine (app.js worldShrine; Descent's
//                  temples have their own perk altars)
//   descentLevel   optional: Descent's level index (descent/scenes.js; app.js's level switch)
//   farChunksPerFrame
//                  optional: far field chunks it builds a frame (world/far.js; cheap
//                  cells can go faster than the default one)
//
// Every number in a scene is a named constant (JS, and a typed const in its
// WGSL). tools/check-wgsl.mjs validates every scene's pipelines (world/gpu.js
// and shaders/far.js WGSL_CHECK); tools/scene-check.mjs, gen-check.mjs and
// caves-check.mjs hold the GPU to the twins, cell for cell.
import { island } from './island.js';
import { labWorld } from './labWorld.js';
import { volcanoWorld } from './volcanoWorld.js';
import { giantVolcano } from './giantVolcano.js';
import { DESCENT_SCENES } from './descent/scenes.js';
import { DESCENT_LEVELS } from './descent/levels.js';

// Descent's levels (descent/scenes.js; docs/descent-contract.md) start at their levels.js spawns
DESCENT_SCENES.forEach((s, i) => s.setSpawn(DESCENT_LEVELS[i].spawn));

export const WORLD_SCENES = [island, labWorld, volcanoWorld, giantVolcano, ...DESCENT_SCENES];
export const sceneByKey = (key) => WORLD_SCENES.find((s) => s.key === key) ?? island;
