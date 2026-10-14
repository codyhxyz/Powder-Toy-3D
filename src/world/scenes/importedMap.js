import { sceneStruct, sceneHeadWGSL } from './sceneGpu.js';
import { importedCell, sourceToCells } from '../import/voxelize.js';
import { CELL_M } from '../../scale.js';
import { ELEMENTS, K } from '../../elements.js';

const IMPORT_U = sceneStruct({ uImportSize: 'vec3i', uImportBricks: 'vec3u' });
export function validateImportedMap(map, words) {
  if (map.version !== 1 || map.encoding !== 'sparse-brick-u8-v1' || map.cellMeters !== CELL_M) throw new Error('Unsupported imported map version/scale');
  if (!Array.isArray(map.size) || map.size.length !== 3 || !map.size.every((n) => Number.isSafeInteger(n) && n > 0 && n % 8 === 0) || !Array.isArray(map.brickDims) || map.brickDims.length !== 3 || !map.brickDims.every((n, i) => n === map.size[i] / 8)) throw new Error('Invalid imported dimensions');
  const count = map.brickDims.reduce((a, b) => a * b, 1), start = Math.ceil(count / 4) * 4;
  if (!(words instanceof Uint32Array) || words.length < start || words.length % 4 || (words.length - start) % 128) throw new Error('Invalid imported data size');
  for (let i = 0; i < count; i++) if (words[i] && (words[i] < start || (words[i] - start) % 128 || words[i] + 128 > words.length)) throw new Error('Invalid imported brick pointer');
  for (let i = start; i < words.length; i++) for (let k = 0; k < 4; k++) if (!ELEMENTS[(words[i] >>> (k * 8)) & 255]) throw new Error('Unknown imported element');
  const authoredStart = map.mission?.available === false ? sourceToCells(map, map.mission.sourceSpawn) : map.mission?.spawn;
  if (!Array.isArray(authoredStart) || authoredStart.length !== 3 || !authoredStart.every((n, i) => Number.isFinite(n) && n >= 0 && n < map.size[i])) throw new Error('Imported map has no valid authored start');
}
export function createImportedMapScene(map, words, { key = `${map.id ?? 'imported'}Local`, label = `${map.name ?? 'Imported map'} (local source)` } = {}) {
  validateImportedMap(map, words);
  const cell = (x, y, z) => importedCell(map, words, x, y, z);
  return {
    key, label, size: [...map.size], shrine: false, mission: map.mission,
    importManifest: map,
    params: ({ seed = 0 } = {}) => ({ size: [...map.size], seed, sea: 0, floor: 0 }),
    uniformStruct: IMPORT_U,
    uniforms: (P) => ({ uSceneSeed: P.seed >>> 0, uImportSize: map.size, uImportBricks: map.brickDims }),
    data: () => ({ at: 0, words }),
    start: () => { const at = map.mission.spawn ?? sourceToCells(map, map.mission.sourceSpawn); return [at[0], at[2]]; },
    cell,
    ground: (x, z) => {
      for (let y = map.size[1] - 1; y >= 0; y--) {
        const kind = ELEMENTS[cell(Math.floor(x), y, Math.floor(z))]?.kind;
        if (kind === K.SOLID || kind === K.POWDER || kind === K.LIQUID) return y + 1;
      }
      return 0;
    },
    glsl: () => /* wgsl */ `
${sceneHeadWGSL(IMPORT_U, { data: true })}
fn importedId(w: vec3i) -> i32 {
  if (any(w < vec3i(0)) || any(w >= SU.uImportSize)) { return E_EMPTY; }
  let p = vec3u(w);
  let b = p / 8u;
  let at = sdWord(b.x + SU.uImportBricks.x * (b.y + SU.uImportBricks.y * b.z));
  if (at == 0u) { return E_EMPTY; }
  let r = p % 8u;
  let i = r.x + 8u * (r.y + 8u * r.z);
  return i32((sdWord(at + (i >> 2u)) >> ((i & 3u) * 8u)) & 255u);
}
fn sceneCell(w: vec3i) -> SceneCell {
  let id = importedId(w);
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, 0x1a90u)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), SPAWNT(id), SPAWNLIFE(id), seed), vec4f(0.0));
}
`,
  };
}
export async function loadImportedMap(manifestURL, options = {}) {
  const response = await fetch(manifestURL);
  if (!response.ok) throw new Error(`Local imported map unavailable (${response.status})`);
  const map = await response.json();
  const binary = await fetch(new URL(map.dataFile, response.url || new URL(manifestURL, globalThis.location?.href)));
  if (!binary.ok) throw new Error(`Local imported geometry unavailable (${binary.status})`);
  const buffer = await binary.arrayBuffer();
  if (buffer.byteLength % 4) throw new Error('Truncated imported data');
  const view = new DataView(buffer), words = new Uint32Array(buffer.byteLength / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  return createImportedMapScene(map, words, options);
}
