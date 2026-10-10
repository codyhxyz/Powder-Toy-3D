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
// A scene is an object:
//   key            its settings value (settings.scene)
//   label          its name in the Scene row
//   params({ size, seed })
//                  its world parameters P: at least { size, seed, sea, floor }.
//                  sea: the open water's level for the far view and GI (cells; 0
//                  for none); floor: the generator floor's thickness (cells)
//   glsl(g)        GLSL, included after the prelude, defining
//                    void sceneCell(ivec3 w, out vec4 A, out vec4 B)
//                  the generated state of world cell w in the state layout:
//                  A = (id, °C, life, ctype + seed), B = (velocity, pressure) = 0.
//                  A pure function of w and its uniforms. Matter at its spawn
//                  temperature and life (SPAWNT, SPAWNLIFE) unless the scene
//                  says otherwise, its seed hashed from w (seedWorld), as
//                  shaders/generate.js genCell does. Cheap: the fill runs it for
//                  every cell of a 128³ window, the far build for every sample.
//   uniforms(P)    its uniforms, { name: { value } }, for the passes that include glsl
//   start(P, win)  [x, z]: the world column the window starts centred on (where
//                  the most is going on); win: the window's [nx, nz]
//   ground(x, z, P)
//                  the CPU's twin of the ground: the top of the topmost solid or
//                  liquid matter at world column (x, z), in cells (the god
//                  view's home sits over it)
//   prepare(renderer, P)
//                  optional: a Promise for GPU work the scene needs before its first
//                  fill (baking textures its GLSL samples: the island bakes its
//                  columns); the world waits for it, then takes uniforms(P) again
//   dispose()      optional: textures the scene made
//   trees          optional: trees it plants, as TREE constructions
//                  (constructions/builtins.js), the island's:
//                    treesIn(x0, z0, x1, z1, P, cache)
//                      the trees whose trunks stand in world columns [x0, x1) ×
//                      [z0, z1): [{ x, y, z, variant, size, quarter, seed }], at most
//                      one a brick column, thinned as world/generator.js treesIn
//                      does; the window stamps them where it goes first
//                    glsl
//                      the far field's GPU twin of its candidates, after the scene's
//                      GLSL and shaders/far.js treeGLSL:
//                        vec4 sceneTreeCandidate(ivec2 bc): brick column bc's
//                          candidate (x the packed tree as treeOf reads it, y its
//                          ground, z its priority; 0: none)
//                        uint sceneTreeKey(ivec2 bc): its key (seed = pcg(key),
//                          quarter = (key >> 20) & 3)
//                  The far field draws them at brick scale into the bricks it builds.
//   structures     (no hook: part of the cells) a scene with structures (world/structures.js:
//                  the island's) includes STRUCT_GLSL, defines int structureGround(ivec3 w) (its
//                  own cell), applies structureCell in its sceneCell, adds structureUniforms(P)
//                  to its uniforms, and drops tree candidates where structureClears
//   farChunksPerFrame
//                  optional: far field chunks it builds a frame (world/far.js; cheap
//                  cells can go faster than the default one)
//
// Every number in a scene is a named constant (JS, and a #define in its GLSL).
// tools/check-scenes.mjs compiles every scene's GLSL and checks start and ground.
import { island } from './island.js';
import { labWorld } from './labWorld.js';
import { volcanoWorld } from './volcanoWorld.js';
import { giantLab } from './giantLab.js';
import { giantVolcano } from './giantVolcano.js';
import { patchwork } from './patchwork.js';

export const WORLD_SCENES = [island, labWorld, volcanoWorld, giantLab, giantVolcano, patchwork];
export const sceneByKey = (key) => WORLD_SCENES.find((s) => s.key === key) ?? island;
