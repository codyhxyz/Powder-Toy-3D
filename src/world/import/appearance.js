import { APPEARANCE_VERSION, APPEARANCE_HEADER_WORDS, APPEARANCE_TRIANGLE_WORDS as TW,
  APPEARANCE_MATERIAL_WORDS as MW, APPEARANCE_LIGHT_WORDS as LW, APPEARANCE_HEADER as H } from './appearanceFormat.js';
import { ELEMENTS } from '../../elements.js';

export function validateAppearanceManifest(appearance) {
  if (appearance.version !== APPEARANCE_VERSION || appearance.encoding !== 'source-triangle-appearance-u32-v1'
    || appearance.dataCompression !== 'gzip' || !/^[\w-]+\.appearance\.binpack$/.test(appearance.dataFile)
    || !Number.isSafeInteger(appearance.totalWords) || appearance.totalWords < APPEARANCE_HEADER_WORDS
    || appearance.totalWords > 64 * 1024 * 1024) throw new Error('Unsupported imported appearance manifest');
}

/** Validate every shader-addressed pointer before uploading untrusted bytes. */
export function validateAppearance(map, words) {
  const a = map.appearance;
  validateAppearanceManifest(a);
  if (!(words instanceof Uint32Array) || words.length !== a.totalWords
    || words[H.version] !== APPEARANCE_VERSION || words[H.totalWords] !== words.length
    || map.brickDims.some((v, i) => words[H.brickDims + i] !== v)) throw new Error('Appearance header differs from its map');
  const range = (at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < APPEARANCE_HEADER_WORDS || size < 0 || at + size > words.length) throw new Error('Invalid appearance range');
  };
  const count = map.brickDims.reduce((n, v) => n * v, 1);
  const dir = words[H.directoryAt], tri = words[H.trianglesAt], mat = words[H.materialsAt], env = words[H.environmentAt];
  const nt = words[H.triangleCount], nm = words[H.materialCount];
  if (words[H.maxBrickTriangles] > 1024 || words[H.lightCount] > 16) throw new Error('Appearance exceeds supported shader work bounds');
  range(dir, count); range(tri, nt * TW); range(mat, nm * MW); range(words[H.lightsAt], words[H.lightCount] * LW); range(env, 32);
  for (let i = 0; i < count; i++) {
    const at = words[dir + i];
    if (!at) continue;
    range(at, 1);
    const n = words[at];
    if (at < dir + count || at + 1 + n > tri || n > words[H.maxBrickTriangles]) throw new Error('Invalid appearance brick list');
    for (let j = 0; j < n; j++) if (words[at + 1 + j] >= nt) throw new Error('Invalid appearance triangle index');
  }
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const finite = (at, n) => {
    for (let i = at; i < at + n; i++) if (!Number.isFinite(floats[i])) throw new Error('Nonfinite appearance value');
  };
  for (let i = 0; i < nt; i++) {
    const at = tri + i * TW;
    if (words[at + 3] >= nm) throw new Error('Invalid appearance material index');
    finite(at, 3); finite(at + 4, TW - 4);
  }
  const texture = (at, width, height, frames = 1) => {
    if (!at && !width && !height) return;
    if (!width || !height || !frames || at < env + 32) throw new Error('Invalid appearance texture');
    range(at, width * height * frames);
  };
  for (let i = 0; i < nm; i++) {
    const at = mat + i * MW;
    finite(at + 4, 11); finite(at + 17, 1);
    if (!ELEMENTS[words[at + 15]] || words[at + 19] > 8) throw new Error('Invalid appearance material');
    if (words[at + 18] !== words[at + 1] * words[at + 2]) throw new Error('Invalid appearance frame stride');
    texture(words[at], words[at + 1], words[at + 2], Math.max(words[at + 16], 1));
    // Optional scalar roughness map uses material slots 22..25.
    if (words[at + 22]) texture(words[at + 22], words[at + 23], words[at + 24]);
    if (words[at + 26]) texture(words[at + 26], words[at + 27], words[at + 28]);
  }
  for (let i = 0; i < words[H.lightCount]; i++) {
    const at = words[H.lightsAt] + i * LW;
    finite(at, 3); finite(at + 4, 11);
    if (words[at + 3] > 2) throw new Error('Invalid appearance light');
    if (words[at + 15]) throw new Error('Source light shadows are not supported by this renderer');
  }
  finite(env, 7); finite(env + 8, 3); finite(env + 16, 10); finite(env + 27, 4);
  texture(words[env + 12], words[env + 13], words[env + 14]);
  return words;
}
