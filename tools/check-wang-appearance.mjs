// CPU-only: real authored Descent kits, physical goldens and all transforms.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { Appearance as A, materialId, materialAppearance, rotateAppearance, appearanceWGSL } from '../src/appearance.js';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { wangGLSL, wangData, WANG_FIELDS } from '../src/world/wang/glsl.js';
import { descentTwin, descentWang, DESCENT_SCENES } from '../src/world/scenes/descent/scenes.js';
import { makeSampler, cutPorts, cutPortsMaterial } from '../src/world/wang/tiling.js';
import { MAT, GEOM, WANG_OUT } from '../src/world/wang/kit.js';

const goldens = [
  'cde6685248029aa2dd747453dabca1e877c6866b5d6138340023845485df6aaa',
  'f1b6f98a31230a15517a7fe7b8d4ce76322bddc9491a872629f3a767fc38d869',
  '039656e7cf0f26fc9f399a145683f0a5f3fa010ff4376114661f2a950d8d5643',
];
let timber = 0, samples = 0;
let wgslSamples = 0;
function checkWGSL(baked, sample) {
  const { words, values } = wangData(baked), G = baked.kit.geom, count = 32;
  const positions = new Int32Array(count * 4), output = new Int32Array(count * 4);
  for (let i = 0; i < count; i++) positions.set([
    (i * 17) % (G.U * baked.units[0]), G.H + (i * 7) % G.H, (i * 11) % (G.U * baked.units[2]), 0,
  ], i * 4);
  const code = `${Object.entries(E).map(([n,id]) => `const E_${n}: i32=${id};`).join('\n')}
${appearanceWGSL}
struct FixtureU { ${Object.entries(WANG_FIELDS).map(([k,t]) => `${k}:${t},`).join('\n')} }
var<private> SU: FixtureU;
@group(0) @binding(0) var<storage,read> SD: array<u32>;
@group(0) @binding(1) var<storage,read> positions: array<vec4i>;
@group(0) @binding(2) var<storage,read_write> output: array<vec4i>;
fn sdWord(i:u32)->u32{return SD[i];}
${wangGLSL(baked.kit)}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
 ${Object.entries(WANG_FIELDS).map(([k,t]) => `SU.${k}=${t.startsWith('vec') ? `${t}(${values[k].join(',')})` : `${values[k]}${t === 'u32' ? 'u' : ''}`};`).join('\n')}
 let word=wangCellMaterial(positions[gid.x].xyz);
 output[gid.x]=vec4i(word,wangCell(positions[gid.x].xyz),wangElement(materialId(word)),materialAppearance(word));
}`;
  new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main', count, { 0: { 0: words, 1: positions, 2: output } });
  for (let i = 0; i < count; i++) {
    const word = sample(...positions.subarray(i * 4, i * 4 + 3));
    const paletteId = E[baked.kit.palette[Object.keys(MAT).find(k => MAT[k] === materialId(word))]] ?? E.ROCK;
    assert.deepEqual([...output.subarray(i * 4, i * 4 + 4)], [word, materialId(word), paletteId, materialAppearance(word)]);
  }
  wgslSamples += count;
}
for (let level = 0; level < 3; level++) {
  const W = descentWang(level), T = descentTwin(level), G = W.kit.geom;
  assert.equal(createHash('sha256').update(W.atlas.data).update(W.placement).digest('hex'), goldens[level]);
  const data = W.data(), at = data.values.uWangAtlasAt;
  assert.equal(data.words.length, at + Math.ceil(W.atlas.data.length / 4), 'same SD budget');
  const bytes = new Uint8Array(data.words.buffer, at * 4, W.atlas.data.length);
  for (let i = 0; i < bytes.length; i++) {
    assert.equal(bytes[i] & 63, W.atlas.data[i]);
    if (W.elementJS(W.atlas.data[i]) === E.PLANKS) { assert.ok(bytes[i] >> 6, `unlabelled timber: level ${level}, atlas ${i}`); timber++; }
  }
  for (let tile = 0; tile < W.kit.tiles.length; tile++) for (let xf = 0; xf < 8; xf++) {
    const tr = xf & 4, units = tr ? [1, 3, 2] : [2, 3, 1];
    const placement = new Uint8Array(6 * 4);
    for (let l = 0; l < 3; l++) for (let u = 0; u < 2; u++) {
      placement[4 * (u + 2 * l)] = tile;
      placement[4 * (u + 2 * l) + 1] = xf | (u ? 8 : 0);
    }
    const sampler = makeSampler({ kit: W.kit, units, atlas: W.atlas, placement }, true);
    const ty = Math.floor(tile / W.atlas.perCol) * G.H, tz = (tile % W.atlas.perCol) * G.U;
    for (let z = 0; z < G.U; z += 3) for (let y = 0; y < G.H; y += 3) for (let x = 0; x < 2 * G.U; x += 3) {
      const ax = xf & 1 ? 2 * G.U - 1 - x : x, az = xf & 2 ? G.U - 1 - z : z;
      const word = sampler(tr ? az : ax, G.H + y, tr ? ax : az);
      const packed = W.atlas.material[x + W.atlas.dims[0] * (ty + y + W.atlas.dims[1] * (tz + z))];
      assert.equal(materialId(word), packed & 63);
      const a = packed >> 6 ? A.PLANK_X + (packed >> 6) - 1 : A.NONE;
      assert.equal(materialAppearance(word), rotateAppearance(a, tr ? 1 : 0));
      samples++;
    }
    if (tile === 0) checkWGSL({ kit: W.kit, units, atlas: W.atlas, placement, origin: [0,0,0] }, sampler);
  }
  let checked = 0;
  for (const b of W.tiling.bricks.slice(0, 24)) {
    const box = W.brickBox(b);
    for (let z = box[2]; z < box[5]; z += 3) for (let x = box[0]; x < box[3]; x += 3) for (let y = box[1]; y < box[4]; y += 3) {
      const c = W.wangCellJS(x, y, z), word = W.wangCellMaterialJS(x, y, z);
      assert.equal(materialId(word), c);
      const tunnel = T.dsTunnelMaterial(x, y, z);
      assert.equal(tunnel < 0 ? -1 : materialId(tunnel), c === MAT.ROCK || c === WANG_OUT ? -1 : W.elementJS(c));
      assert.equal(materialId(T.dsCellMaterial(x, y, z)), T.dsCell(x, y, z));
      if (W.elementJS(c) === E.PLANKS && T.dsCell(x, y, z) === E.PLANKS) { assert.ok(materialAppearance(T.dsCellMaterial(x, y, z))); checked++; }
    }
  }
  assert.ok(checked, `level ${level} must exercise actual placed timber`);
  assert.match(DESCENT_SCENES[level].glsl(), /fn dsWangMaterial\(/);
}
for (const [level, x, y, z] of [[0, 19, 46, 7], [2, 91, 47, 12], [1, 57, 46, 37]]) {
  const T = descentTwin(level), word = T.dsCellMaterial(x, y, z);
  assert.equal(T.dsCell(x, y, z), E.PLANKS);
  assert.equal(materialId(word), E.PLANKS);
  assert.equal(materialAppearance(word), A.PLANK_Y);
}
for (let p = 0; p < 6; p++) for (const col of [1, 2, 3]) for (const lintel of [false, true]) {
  const G = GEOM, y0 = col === 3 ? G.HIGH_FLOOR : G.FLOOR, lat = lintel ? 0 : -G.DOOR_W / 2;
  const x = p < 2 ? (p === 0 ? G.FRAME_DEPTH : 2 * G.U - 1 - G.FRAME_DEPTH) : ((p - 2) & 1) * G.U + G.U / 2 + lat;
  const z = p < 2 ? G.U / 2 + lat : p < 4 ? G.FRAME_DEPTH : G.U - 1 - G.FRAME_DEPTH;
  const y = lintel ? y0 + G.DOOR_H - 1 : y0;
  const args = [G, MAT.ROCK, col << (2 * p), x, y, z, x, y, z], word = cutPortsMaterial(...args);
  assert.equal(cutPorts(...args), MAT.BEAM);
  assert.equal(materialId(word), MAT.BEAM);
  const expected = lintel ? (p < 2 ? A.PLANK_Z : A.PLANK_X) : A.PLANK_Y;
  assert.equal(materialAppearance(word), expected);
  const W = descentWang(1);
  for (let xf = 0; xf < 8; xf++) {
    const tr = xf & 4, units = tr ? [1, 3, 2] : [2, 3, 1], placement = new Uint8Array(24);
    for (let l = 0; l < 3; l++) for (let u = 0; u < 2; u++) {
      const o = 4 * (u + 2 * l), ports = col << (2 * p);
      placement[o + 1] = xf | (u ? 8 : 0);
      placement[o + 2] = ports & 255;
      placement[o + 3] = ports >> 8;
    }
    const sample = makeSampler({ kit: { ...W.kit, geom: G }, units, atlas: W.atlas, placement }, true);
    const ax = xf & 1 ? 2 * G.U - 1 - x : x, az = xf & 2 ? G.U - 1 - z : z;
    const rotated = sample(tr ? az : ax, G.H + y, tr ? ax : az);
    assert.equal(materialId(rotated), MAT.BEAM);
    assert.equal(materialAppearance(rotated), rotateAppearance(expected, tr ? 1 : 0));
  }
}
console.log(`Wang appearance: ${timber} timber cells, ${samples} CPU / ${wgslSamples} actual WGSL transform samples; physical goldens/budget/seams unchanged`);
