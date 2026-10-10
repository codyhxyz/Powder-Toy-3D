// A stand-in scene while the real one is being written: flat rock under open
// air. (Each scene's own file replaces it.)
const PLACEHOLDER_GROUND = 8;          // cells of rock
const PLACEHOLDER_SALT = 0x5ce4e;      // seed stream of its cells

export function placeholder(key, label) {
  return {
    key,
    label,
    params: ({ size, seed }) => ({ size, seed, sea: 0, floor: PLACEHOLDER_GROUND }),
    glsl: () => /* glsl */ `
#define PLACEHOLDER_GROUND ${PLACEHOLDER_GROUND}
#define PLACEHOLDER_SALT ${PLACEHOLDER_SALT}u
uniform uint uSceneSeed;
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = w.y < PLACEHOLDER_GROUND ? E_ROCK : E_EMPTY;
  float seed = float(seedWorld(w, uSceneSeed, PLACEHOLDER_SALT)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), SPAWNT[id], SPAWNLIFE[id], seed);
  B = vec4(0.0);
}
`,
    uniforms: (P) => ({ uSceneSeed: { value: P.seed } }),
    start: (P) => [P.size[0] / 2, P.size[2] / 2],
    ground: () => PLACEHOLDER_GROUND,
  };
}
