import { E, ELEMENTS, K } from '../../../elements.js';
import { sceneStruct, sceneHeadWGSL } from '../sceneGpu.js';
import { fetchImportedWords } from '../importedMap.js';
import { createFold, foldWGSL } from './terrainFold.js';
import { validateTerrainManifest, prepareTerrainWords, nativeIndex, OUTSIDE, PALETTE_WORDS } from './terrainRaster.js';

const TERRAIN_U = sceneStruct({ uFoldA: 'vec4f', uFoldB: 'vec4f', uFoldC: 'vec4f', uRasterWidth: 'u32', uRasterMinX: 'i32', uAirT: 'f32' });
const TERRAIN_WGSL = `${sceneHeadWGSL(TERRAIN_U, { data: true })}
${foldWGSL}
fn terrainId(w: vec3i) -> i32 {
  let p = vec3f(w) + vec3f(0.5);
  let kind = foldClassify(p, SU.uFoldA, SU.uFoldB, SU.uFoldC);
  if (kind == 0) { return E_EMPTY; }
  if (kind == 2) { return E_WALL; }
  let source = foldChart(p, SU.uFoldA, SU.uFoldB, SU.uFoldC);
  let x = i32(floor(source.x)) - SU.uRasterMinX;
  let y = i32(floor(source.y)) - i32(SU.uFoldC.x);
  if (x < 0 || x >= i32(SU.uRasterWidth) || y < 0 || y >= i32(SU.uFoldC.y)) { return E_WALL; }
  let index = u32(x) + SU.uRasterWidth * u32(y);
  let native = (sdWord(${PALETTE_WORDS}u + (index >> 2u)) >> ((index & 3u) * 8u)) & 255u;
  if (native == 255u) { return E_WALL; }
  return i32(sdWord(native));
}
fn sceneCell(w: vec3i) -> SceneCell {
  let id = terrainId(w);
  var temperature = SPAWNT(id);
  if (temperature == AMBIENT) { temperature = SU.uAirT; }
  if (id == E_ICE || id == E_SNOW) { temperature = min(temperature, SU.uAirT); }
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, 0x1a90u)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), temperature, SPAWNLIFE(id), seed), vec4f(0.0));
}
`;

export function createTerrainScene(route, region, { fetchWords = fetchImportedWords } = {}) {
  validateTerrainManifest(route);
  const fold = createFold(route.fold), { sourceTop: top, sourceHeight: height } = region;
  const size = fold.dimensions(height), section = route.sections[region.sectionIndex];
  const airT = region.airT ?? section?.airT ?? (/snow|hiisi/i.test(`${region.label} ${section?.label} ${section?.key}`) ? -12 : 18);
  let words = null, packed = null, preparing = null, arrival = null;
  const toWorld = (source) => fold.forward(source, top, height);
  const spawnSource = region.key === route.startScene ? route.startSource : region.spawnSource;
  const loaded = () => { if (!words) throw new Error(`Terrain not prepared: ${region.key}`); return words; };
  const querySource = (world) => {
    const kind = fold.classify(world, top, height);
    if (kind !== 'source') return { kind, source: null, nativeIndex: null, element: kind === 'cap' ? E.WALL : E.EMPTY };
    const source = fold.inverse(world, top, height);
    const x = Math.floor(source[0]) - route.fold.sourceMinX, y = Math.floor(source[1]) - top;
    const index = x < 0 || x >= route.fold.sourceWidth || y < 0 || y >= height ? OUTSIDE : nativeIndex(loaded(), x + route.fold.sourceWidth * y);
    if (index === OUTSIDE) return { kind: 'cap', source, nativeIndex: index, element: E.WALL };
    return { kind: 'source', source, nativeIndex: index, material: route.palette[index].name, element: route.palette[index].element };
  };
  const cell = (x,y,z) => querySource([Math.floor(x)+.5,Math.floor(y)+.5,Math.floor(z)+.5]).element;
  return {
    key: region.key, label: region.label, size, shrine: false, sourceRegion: region,
    descentLevel: route.regions.indexOf(region), sectionIndex: region.sectionIndex, fold, airT,
    // Source illumination is not synthesized here; the existing POV lamp is separate.
    ambient: [0,0,0], torches: () => [], view: { dir: [-11,7,6], dist: 95, lift: 0 },
    toWorld, querySource, cell,
    setArrival(point) { arrival = point ? [...point] : null; },
    start() { const p = arrival ?? toWorld(spawnSource); return [p[0],p[2]]; },
    params: ({seed=0}={}) => ({ size:[...size],seed,sea:0,floor:0 }),
    uniformStruct: TERRAIN_U,
    uniforms(P) { const u=fold.uniforms(top,height); return {uSceneSeed:P.seed>>>0,uFoldA:u.a,uFoldB:u.b,uFoldC:u.c,uRasterWidth:route.fold.sourceWidth,uRasterMinX:route.fold.sourceMinX,uAirT:airT}; },
    async prepare() {
      if (packed) return;
      if (!preparing) preparing = (async () => {
        const raster = await fetchWords(`/local-maps/noita-terrain/${region.file}`);
        const data = await prepareTerrainWords(route,region,raster);
        words = raster; packed = data;
      })().finally(() => { preparing = null; });
      return preparing;
    },
    data() { loaded(); return { at:0,words:packed }; },
    ground(x,z) {
      if (!words) return toWorld(spawnSource)[1];
      for (let y=size[1]-1;y>=0;y--) {
        const kind=ELEMENTS[cell(x,y,z)]?.kind;
        if (kind===K.SOLID || kind===K.POWDER || kind===K.LIQUID) return y+1;
      }
      return 0;
    },
    glsl: () => TERRAIN_WGSL,
  };
}
