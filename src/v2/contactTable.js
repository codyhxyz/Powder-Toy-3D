// Pure contact-table ABI: no simulation/shader imports. Both the EV packer and
// WGSL accessors use these ordered field types and vec4-padded row strides.
export const CONTACT_ROW_SCHEMA = Object.freeze([
  ['kind','i32'], ['capacity','i32'], ['offset','i32'], ['cond','f32'],
  ['density','f32'], ['spawnQ','i32'], ['spawnLife','i32'],
  ['hotQ','i32'], ['hotOut','i32'], ['hotL','i32'], ['hotGas','i32'], ['hotOf','i32'],
  ['coldQ','i32'], ['coldOut','i32'], ['coldL','i32'], ['coldOf','i32'],
  ['meltQ','i32'], ['meltInto','i32'], ['igniteQ','i32'], ['flashQ','i32'],
  ['burn','i32'], ['heat','i32'], ['flameQ','i32'], ['ash','i32'],
  ['blast','i32'], ['blastAir','i32'], ['blastChance','f32'], ['acid','i32'],
  ['edible','i32'], ['fizz','i32'], ['bed','i32'], ['rots','i32'],
  ['singFood','i32'], ['conductor','i32'], ['cost','f32'], ['wire','i32'], ['emitter','f32'],
  ['blastInto','i32'], ['blastOf','i32'], ['blastQ','i32'], ['blastPuff','i32'],
].map(Object.freeze));
export const CONTACT_RX_SCHEMA = Object.freeze([
  ['a','i32'], ['b','i32'], ['aOut','i32'], ['bOut','i32'], ['chance','f32'],
  ['minQ','i32'], ['maxQ','i32'], ['heat','i32'], ['gas','i32'], ['ceiling','i32'], ['puff','i32'],
].map(Object.freeze));
const stride = schema => Math.ceil(schema.length / 4) * 4;
export function contactTableLayout(elementCount, reactionCount) {
  const rowStride = stride(CONTACT_ROW_SCHEMA), rxStride = stride(CONTACT_RX_SCHEMA);
  const rowOffset = elementCount * 8, rxOffset = rowOffset + elementCount * rowStride;
  return { rowOffset, rowStride, rxOffset, rxStride, words: rxOffset + reactionCount * rxStride };
}

// Keep v2Table's Float32Array upload ABI, but copy the tail only as u32 words.
// EV loads vec4u: integer metadata never passes through a float NaN payload.
export function appendContactTable(prefix, rows, reactions) {
  const layout = contactTableLayout(rows.length, reactions.length);
  if (prefix.length !== layout.rowOffset) throw Error('contact EV prefix length');
  const out = new Float32Array(layout.words);
  const tailWords = new Uint32Array(layout.words - layout.rowOffset);
  const tailFloats = new Float32Array(tailWords.buffer);
  out.set(prefix);
  for (const [data, schema, offset, rowStride] of [
    [rows, CONTACT_ROW_SCHEMA, layout.rowOffset, layout.rowStride],
    [reactions, CONTACT_RX_SCHEMA, layout.rxOffset, layout.rxStride],
  ]) data.forEach((row, id) => schema.forEach(([key, type], field) => {
    const at = offset - layout.rowOffset + id * rowStride + field;
    if (type === 'i32') tailWords[at] = row[key] >>> 0;
    else tailFloats[at] = row[key];
  }));
  new Uint32Array(out.buffer).set(tailWords, layout.rowOffset);
  return out;
}
