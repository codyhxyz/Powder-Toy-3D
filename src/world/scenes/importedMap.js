import { createImportedInteractionState, decodeImportedIndex } from '../import/importedInteractionState.js';
import { sceneStruct, sceneHeadWGSL } from './sceneGpu.js';
import { importedCell, sourceToCells } from '../import/voxelize.js';
import { CELL_M } from '../../scale.js';
import { ELEMENTS, K } from '../../elements.js';

// A converted source level (tools/import-cruelty-map.mjs), served from
// public/local-maps as a small manifest plus gzip-packed sparse bricks. The
// manifest is enough to list the map; its geometry is fetched only when the
// map is opened (gpu.js awaits scene.prepare before scene.data).
const IMPORT_U = sceneStruct({ uImportSize: 'vec3i', uImportBricks: 'vec3u' });

/** The manifest alone: what can be checked before its geometry is fetched. */
export function validateImportedMapManifest(map) {
  if (map.version !== 1 || map.encoding !== 'sparse-brick-u8-v1' || map.cellMeters !== CELL_M) throw new Error('Unsupported imported map version/scale');
  // Published geometry must be packed: a raw 29 MiB map exceeds the host's per-file limit.
  // (Not `.gz`: a host that recognises that name serves it as `Content-Encoding:
  // gzip`, and the fetch layer then inflates it before the loader sees it.)
  if (map.dataCompression !== 'gzip' || typeof map.dataFile !== 'string' || !map.dataFile.endsWith('.binpack')) throw new Error('Imported map data must be gzip-packed');
  if (!Array.isArray(map.size) || map.size.length !== 3 || !map.size.every((n) => Number.isSafeInteger(n) && n > 0 && n % 8 === 0) || !Array.isArray(map.brickDims) || map.brickDims.length !== 3 || !map.brickDims.every((n, i) => n === map.size[i] / 8)) throw new Error('Invalid imported dimensions');
  // The far field needs a level's border height before its geometry arrives.
  if (!Number.isFinite(map.plainHeight) || map.plainHeight < 0 || map.plainHeight > map.size[1]) throw new Error('Imported map has no plain height');
  const authoredStart = map.mission?.available === false ? sourceToCells(map, map.mission.sourceSpawn) : map.mission?.spawn;
  if (!Array.isArray(authoredStart) || authoredStart.length !== 3 || !authoredStart.every((n, i) => Number.isFinite(n) && n >= 0 && n < map.size[i])) throw new Error('Imported map has no valid authored start');
  if (map.interactions) {
    if (map.interactions.version !== 1 || !Array.isArray(map.interactions.doors) || !Array.isArray(map.interactions.ladders)) throw new Error('Invalid imported interactions');
    const owned = new Set(), paths = new Set(), volume = map.size.reduce((a, b) => a * b, 1);
    for (const door of map.interactions.doors) {
      const { min, max } = door.bounds ?? {};
      if (typeof door.sourcePath !== 'string' || paths.has(door.sourcePath) || !Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3 || !min.every((n, k) => Number.isSafeInteger(n) && Number.isSafeInteger(max[k]) && n >= 0 && max[k] > n && max[k] <= map.size[k]) || !Array.isArray(door.cells) || door.cells.length % 2) throw new Error('Invalid imported door bounds/ownership');
      paths.add(door.sourcePath);
      if (door.supported && !['res://Scripts/Door.gd', 'res://Scripts/Elevator_Door.gd'].includes(door.sourceResource)) throw new Error('Unsupported gate cannot be an ordinary door');
      for (let i = 0; i < door.cells.length; i += 2) {
        const index = door.cells[i], id = door.cells[i + 1];
        if (!Number.isSafeInteger(index) || index < 0 || index >= volume || owned.has(index) || !Number.isInteger(id) || !id || !ELEMENTS[id] || !decodeImportedIndex(map, index).every((n, k) => n >= min[k] && n < max[k])) throw new Error('Invalid imported door cell');
        owned.add(index);
      }
    }
  }
}
export function validateImportedMap(map, words) {
  validateImportedMapManifest(map);
  const count = map.brickDims.reduce((a, b) => a * b, 1), start = Math.ceil(count / 4) * 4;
  if (!(words instanceof Uint32Array) || words.length < start || words.length % 4 || (words.length - start) % 128) throw new Error('Invalid imported data size');
  for (let i = 0; i < count; i++) if (words[i] && (words[i] < start || (words[i] - start) % 128 || words[i] + 128 > words.length)) throw new Error('Invalid imported brick pointer');
  for (let i = start; i < words.length; i++) for (let k = 0; k < 4; k++) if (!ELEMENTS[(words[i] >>> (k * 8)) & 255]) throw new Error('Unknown imported element');
}
/** Inflate the packed little-endian u32 brick words. */
export async function fetchImportedWords(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Imported geometry unavailable (${response.status})`);
  let buffer = await response.arrayBuffer();
  // A host may send the packed file as `Content-Encoding: gzip`, in which case
  // the fetch layer has already inflated it. Inflate only a real gzip stream
  // (its magic bytes), so either behaviour yields the same words.
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    buffer = await new Response(new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if (buffer.byteLength % 4) throw new Error('Truncated imported data');
  const view = new DataView(buffer), words = new Uint32Array(buffer.byteLength / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  return words;
}
export function createImportedMapScene(map, words = null, { key = `${map.id ?? 'imported'}Local`, label = `${map.name ?? 'Imported map'} (source import)`, dataURL = null } = {}) {
  validateImportedMapManifest(map);
  if (words) validateImportedMap(map, words);
  const loaded = () => { if (!words) throw new Error(`${map.id}: its geometry is not loaded yet`); return words; };
  const cell = (x, y, z) => importedCell(map, loaded(), x, y, z);
  const listeners = new Set();
  const changed = (at, data) => { for (const fn of listeners) fn(at, data); };
  let interactions = words ? createImportedInteractionState(map, words, changed) : null;
  return {
    get interactionState() { return interactions; },
    subscribeData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { interactions?.reset(); },
    key, label, size: [...map.size], shrine: false, mission: map.mission,
    importManifest: map,
    // The generator's prepare (world/gpu.js) awaits this before data().
    async prepare() {
      if (words) return;
      const fetched = await fetchImportedWords(dataURL ?? map.dataFile);
      validateImportedMap(map, fetched);
      words = fetched;
      interactions = createImportedInteractionState(map, words, changed);
    },
    params: ({ seed = 0 } = {}) => ({ size: [...map.size], seed, sea: 0, floor: 0 }),
    uniformStruct: IMPORT_U,
    uniforms: (P) => ({ uSceneSeed: P.seed >>> 0, uImportSize: map.size, uImportBricks: map.brickDims }),
    data: () => ({ at: 0, words: loaded() }),
    start: () => { const at = map.mission.spawn ?? sourceToCells(map, map.mission.sourceSpawn); return [at[0], at[2]]; },
    cell,
    ground: (x, z) => {
      // Before the geometry is fetched (the far field's border median, asked
      // while the world is built) the manifest's own answer stands in.
      if (!words) return map.plainHeight;
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
/** The map's manifest now; its geometry on the first prepare. */
export async function loadImportedMap(manifestURL, options = {}) {
  const response = await fetch(manifestURL);
  if (!response.ok) throw new Error(`Imported map unavailable (${response.status})`);
  const map = await response.json();
  return createImportedMapScene(map, null, { ...options, dataURL: new URL(map.dataFile, response.url || manifestURL).href });
}
