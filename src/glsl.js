// JS numbers as shader source: the one float-literal formatter every generator
// shares, and the tuning-block-to-consts helper built on it. (The name is the
// GLSL version's, docs/webgpu.md W2: the text it writes is WGSL.) No imports,
// so any module can use it without a cycle.

// Significant digits that always round-trip a float32 (IEEE 754: 9 for binary32)
const F32_DIGITS = 9;

/**
 * x as a float literal: whole numbers get a ".0" so the literal is a float,
 * the rest the fewest significant digits that still give x's f32
 * (Math.fround(x)), so a typed f32 const holds exactly the value the CPU's
 * Float32 twins hold (tools/tables-check.mjs) without JS's 17-digit doubles.
 * A negative literal comes in parentheses, so it pastes safely after an
 * operator (`a - ${glf(b)}`).
 * @param {number|string} x
 */
export function glf(x) {
  const v = +x;
  let s;
  if (Number.isInteger(v)) s = v.toFixed(1);
  else {
    const f = Math.fround(v);
    let p = 1;
    while (p < F32_DIGITS && Math.fround(+f.toPrecision(p)) !== f) p++;
    s = String(+f.toPrecision(p));
    if (!/[.e]/.test(s)) s += '.0';
  }
  return v < 0 ? `(${s})` : s;
}

/**
 * WGSL testing element id `v` against element keys (the prelude's E_<KEY>
 * consts): idIs('j', ['A', 'B']) is `j == E_A || j == E_B` (none: false),
 * idIsNot the `!=` chain (none: true). For a handful of ids; a per-element
 * table field (shaders/common.js tablesWGSL) for more.
 * @param {string} v
 * @param {string[]} keys
 */
export const idIs = (v, keys) => keys.map((k) => `${v} == E_${k}`).join(' || ') || 'false';
export const idIsNot = (v, keys) => keys.map((k) => `${v} != E_${k}`).join(' && ') || 'true';

/**
 * A tuning block as typed consts (docs/webgpu.md H1.7): `const PREFIX_KEY: f32`
 * per entry, `i32` for the keys in `ints` (loop bounds, array sizes).
 * @param {string} prefix
 * @param {Record<string, number>} obj
 * @param {string[]} [ints]
 */
export const consts = (prefix, obj, ints = []) => Object.entries(obj)
  .map(([k, v]) => (ints.includes(k) ? `const ${prefix}_${k}: i32 = ${v};` : `const ${prefix}_${k}: f32 = ${glf(v)};`)).join('\n');
