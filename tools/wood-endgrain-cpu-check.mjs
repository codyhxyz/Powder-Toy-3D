// Full end-grain replaces every bark output; partial coverage retains bark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { volumeFrag } from '../src/shaders/render.js';

const source = readFileSync(new URL('../src/shaders/gfx/surface.js', import.meta.url), 'utf8');
const wood = source.slice(source.indexOf('} else if (id == E_WOOD)'), source.indexOf('} else if (id == E_PLANT)'));
assert.match(wood, /let top = woodEndGrain\(n\);[\s\S]*if \(top < 1\.0\) \{[\s\S]*let pl = woodPlates/);
assert.match(wood, /m\.cav = mix\(FURROW_CAV, 1\.0, rl\) \* mix\(FURROW_CAV, 1\.0, fr\);\s*\}/);
assert.equal((wood.match(/let top = woodEndGrain/g) ?? []).length, 1);
for (const unchanged of ['m.alb = mix(m.alb, endg, top);', 'm.g *= 1.0 - top;',
  'm.cav = mix(m.cav, 1.0, top);', 'm.rough = mix(m.rough, END_ROUGH, top);']) assert(wood.includes(unchanged));

// IEEE-f32 port of the unchanged final blend, with arbitrary finite bark.
const f = Math.fround;
const mix = (a, b, t) => f(f(a * f(1 - t)) + f(b * t));
const finish = (m, end, top) => ({ alb: m.alb.map((v, i) => mix(v, end[i], top)),
  g: m.g.map((v) => f(v * f(1 - top))), cav: mix(m.cav, 1, top), rough: mix(m.rough, f(0.65), top) });
let seed = 1;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 10000; i++) {
  const bark = { alb: [rand(), rand(), rand()], g: [rand() - 0.5, rand() - 0.5, rand() - 0.5],
    cav: rand(), rough: rand() };
  const base = { alb: [0.4, 0.3, 0.2], g: [0, 0, 0], cav: 1, rough: 0.7 };
  const end = [f(rand()), f(rand()), f(rand())];
  for (const top of [0, f(0.2), f(0.9), f(0.999999), 1]) {
    const old = finish(bark, end, top), now = finish(top < 1 ? bark : base, end, top);
    // Signed zero gradients are equivalent surface normals, not state words.
    for (const key of ['alb', 'g']) for (let c = 0; c < 3; c++) assert(old[key][c] === now[key][c]);
    assert.equal(old.cav, now.cav);
    assert.equal(old.rough, now.rough);
  }
}
for (const detail of ['off', 'full']) for (const curved of [false, true]) {
  const shader = volumeFrag({ nx: 128, ny: 128, nz: 128 }, { detail, curved });
  assert.match(shader, /if \(top < 1\.0\) \{/);
}
console.log('PASS: full/partial end-grain blend equivalence; four generated WGSL variants retain the guard. CPU only, not shader execution.');
