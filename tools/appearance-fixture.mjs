import { APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
import { E } from '../src/elements.js';

export function appearanceFixture() {
  const words = new Uint32Array(156), f = new Float32Array(words.buffer);
  words[H.version] = 1; words[H.totalWords] = words.length; words.set([1, 1, 1], H.brickDims);
  for (const [key, value] of Object.entries({ directoryAt: 64, trianglesAt: 67, materialsAt: 91, materialCount: 1,
    triangleCount: 1, lightsAt: 123, lightCount: 0, environmentAt: 123, maxBrickTriangles: 1 })) words[H[key]] = value;
  words.set([65, 1, 0], 64);
  f.set([0, 1, 0], 67); words[70] = 0;
  f.set([0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 1, 0, 1, 0.125, 0, 0, 0, 0, 0, 0.125, 0], 71);
  words.set([155, 1, 1, 4 | 256], 91);
  f.set([1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0], 95);
  words[106] = E.ROCK; words[107] = 1; words[109] = 1;
  f.set([1, 1, 1, 1], 123);
  words[155] = 0xff2040e0;
  const map = { brickDims: [1, 1, 1], appearance: { version: 1, encoding: 'source-triangle-appearance-u32-v1',
    totalWords: words.length, dataCompression: 'gzip', dataFile: 'fixture.appearance.binpack' } };
  return { map, words };
}
