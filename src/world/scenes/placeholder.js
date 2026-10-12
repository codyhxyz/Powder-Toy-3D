import { sceneStruct, sceneHeadWGSL } from './sceneGpu.js';

// A stand-in scene while the real one is being written: flat rock under open
// air. (Each scene's own file replaces it.)
const PLACEHOLDER_GROUND = 8;          // cells of rock
const PLACEHOLDER_SALT = 0x5ce4e;      // seed stream of its cells
const PLACEHOLDER_U = sceneStruct();

export function placeholder(key, label) {
  return {
    key,
    label,
    params: ({ size, seed }) => ({ size, seed, sea: 0, floor: PLACEHOLDER_GROUND }),
    glsl: () => /* wgsl */ `
${sceneHeadWGSL(PLACEHOLDER_U)}
const PLACEHOLDER_GROUND: i32 = ${PLACEHOLDER_GROUND};
const PLACEHOLDER_SALT: u32 = ${PLACEHOLDER_SALT}u;
fn sceneCell(w: vec3i) -> SceneCell {
  let id = select(E_EMPTY, E_ROCK, w.y < PLACEHOLDER_GROUND);
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, PLACEHOLDER_SALT)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), SPAWNT(id), SPAWNLIFE(id), seed), vec4f(0.0));
}
`,
    uniformStruct: PLACEHOLDER_U,
    uniforms: (P) => ({ uSceneSeed: P.seed >>> 0 }),
    start: (P) => [P.size[0] / 2, P.size[2] / 2],
    ground: () => PLACEHOLDER_GROUND,
  };
}
