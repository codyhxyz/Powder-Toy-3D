// CPU-only generated-WGSL branch regression. Geometry/field sampling is stubbed;
// event/suppression/element branches, counters and crossfade state are executed.
// Usage: node tools/check-clod-budget.mjs [--naga] [--shader-ref <git-ref>]
// --shader-ref is a negative control: the pre-fix shader must fail the fallback assertion.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grainsGLSL as currentGrains } from '../src/shaders/gfx/grains.js';
import { volumeFrag } from '../src/shaders/render.js';

const refIndex = process.argv.indexOf('--shader-ref');
const grainsGLSL = refIndex < 0 ? currentGrains : (await import(`data:text/javascript;base64,${Buffer.from(
  execFileSync('git', ['show', `${process.argv[refIndex + 1]}:src/shaders/gfx/grains.js`]),
).toString('base64')}`)).grainsGLSL;
const details = [
  { DETAIL_GRAIN_CLUSTERS: true },
  { DETAIL_GRAINS: true, DETAIL_GRAIN_CLUSTERS: true },
  { DETAIL_GRAINS: true },
];
function body(code, name) {
  const declaration = code.indexOf(`fn ${name}(`);
  assert(declaration >= 0, name);
  const start = code.indexOf('{', declaration);
  let depth = 1, end = start;
  while (depth && ++end < code.length) {
    if (code[end] === '{') depth++;
    if (code[end] === '}') depth--;
  }
  assert.equal(depth, 0, name);
  return code.slice(start + 1, end);
}

// Translate only syntax and the few vector expressions in these bodies; do not
// rewrite their control flow. Pointer arguments are JS getter/setter references.
function translate(source) {
  return source.replace(/\/\/[^\n]*/g, '')
    .replace(/ro \+ rd \* \(\*tEv\)/g, 'add(ro, scale(rd, tEv.value))')
    .replace(/ro \+ rd \* (tEnter|tG)/g, 'add(ro, scale(rd, $1))')
    .replace(/hp - 0\.5/g, 'add(hp, vec3f(-0.5))')
    .replace(/c0 \+ vec3i\(i & 1, \(i >> 1u\) & 1, \(i >> 2u\) & 1\)/g,
      'add(c0, vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1))')
    .replace(/\*(ev|tEv|anyHit|hitPos|w)\b/g, '$1.value')
    .replace(/&(gPebSteps|s|tStop|wS|an)\b/g,
      '({get value() { return $1; }, set value(v) { $1 = v; }})')
    .replace(/\bvar(?:<private>)?/g, 'let')
    .replace(/:\s*(?:i32|f32|bool|vec[34][if])\b/g, '')
    .replace(/\b(\d+)u\b/g, '$1');
}
const signatures = {
  isPebbles: 'id', grainElement: 'id', grainCellOk: 'c, id',
  grainSuppress: 'hp, clods, w',
  grainEvent: 'cell, id, a, ro, rd, tEnter, tExit, col, trans, ev, evCh, tEv, anyHit, hitPos',
};
function compile(code) {
  // Old shader signature is supported so exactly the same assertions run against it.
  const old = !code.includes('hp: vec3f, clods: bool, w:');
  const constants = [...code.matchAll(/^const (\w+): (?:i32|f32) = (-?[\d.e+-]+);/gm)]
    .map((m) => `const ${m[1]} = ${m[2]};`).join('\n');
  const globals = [...code.matchAll(/^var<private> g[^\n]+/gm)].map((m) => translate(m[0])).join('\n');
  const names = [...code.matchAll(/^var<private> (g\w+)/gm)].map((m) => m[1]);
  const functions = Object.entries(signatures).map(([name, args]) =>
    `function ${name}(${old && name === 'grainSuppress' ? 'hp, w' : args}) { ${translate(body(code, name))} }`).join('\n');
  return new Function('env', `
    const { E_STONE, E_EMPTY, CH_GRANULAR, EV_NONE, EV_OPAQUE, NO_HIT,
      SURFCH, fetchA, eid, outside, loneCell, footprint, grainW, grainWMax,
      clodHit, pebblesHit, pebbleFill, surfField, SURF_ISO } = env;
    const vec3f = (...v) => v.length === 1 ? [v[0], v[0], v[0]] : v;
    const vec3i = (...v) => Array.isArray(v[0]) ? v[0].map(Math.trunc) : vec3f(...v);
    const add = (a, b) => a.map((v, i) => v + b[i]);
    const scale = (a, b) => a.map(v => v * b);
    const floor = a => a.map(Math.floor), min = Math.min;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    ${constants}
    ${globals}
    ${functions}
    return { event: grainEvent, state: () => ({ ${names.join(', ')} }) };
  `);
}
const EMPTY = 0, SAND = 1, STONE = 2, SOLID = 3, GRANULAR = 2;
const NONE = 0, OPAQUE = 1, GRAIN = 4, NO_HIT = 1e20;
const key = c => c.join(',');
function fixture(code, weight, options = {}) {
  const world = new Map();
  const calls = { clod: [], pebble: 0 };
  const env = {
    E_STONE: STONE, E_EMPTY: EMPTY, CH_GRANULAR: GRANULAR,
    EV_NONE: NONE, EV_OPAQUE: OPAQUE, NO_HIT, SURF_ISO: 0.5,
    SURFCH: id => [SAND, STONE].includes(id) ? GRANULAR : -1,
    fetchA: c => world.get(key(c)) ?? EMPTY, eid: a => a, outside: () => false,
    loneCell: c => ![[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(d => env.SURFCH(env.fetchA(c.map((v, i) => v + d[i]))) === GRANULAR),
    footprint: () => 0, grainW: () => weight, grainWMax: () => weight,
    clodHit: (c, id, a, ro, rd, enter) => {
      calls.clod.push([...c]);
      return calls.clod.length === options.hitAt ? enter + options.hitOffset : NO_HIT;
    },
    pebblesHit: (...args) => {
      if (args.length === 11) args.splice(2, 1);   // (--shader-ref: before pebblesHit lost its lone argument)
      const [c, a, fill, ro, rd, enter, exit, steps, site, stop] = args;
      calls.pebble++; steps.value++; site.value = [...c]; stop.value = enter + 0.75;
      return options.pebbleHit ? enter + 0.4 : NO_HIT;
    },
    pebbleFill: () => options.fill ?? 0,
    surfField: () => [0, 0, 1, 0],
  };
  const shader = compile(code)(env);
  function segment(n, id = SAND, { ev = OPAQUE, channel = GRANULAR, neighbor = id } = {}) {
    const cell = [n * 3, 0, 0]; // five separated, genuinely lone clods
    if (neighbor !== EMPTY) world.set(key(cell), neighbor);
    const event = { value: ev }, time = { value: n * 3 + 0.5 };
    const anyHit = { value: false }, hitPos = { value: [0, 0, 0] };
    shader.event(cell, id, id, [0, 0.5, 0.5], [1, 0, 0], n * 3, n * 3 + 1,
      [0.1, 0.2, 0.3], [0.9, 0.8, 0.7], event, channel, time, anyHit, hitPos);
    return { ev: event.value, time: time.value, anyHit: anyHit.value, hitPos: hitPos.value };
  }
  return { segment, state: shader.state, calls, world };
}
const alternate = state => Object.fromEntries(Object.entries(state).filter(([k]) => k.startsWith('gAlt')));
function exhaust(f) {
  for (let n = 0; n < 4; n++) assert.equal(f.segment(n).ev, NONE, `in-budget clod ${n + 1}`);
  assert.equal(f.calls.clod.length, 4, 'final allowed geometry test runs');
  assert.equal(f.state().gClodCells, 4);
}
for (const detail of details) {
  const code = grainsGLSL(detail);
  for (const [name, value] of Object.entries({ CLOD_MAX_CELLS: 4, CLOD_STEPS: 48, PEB_MAX_STEPS: 24, PEB_SUN_STEPS: 8 })) {
    const match = code.match(new RegExp(`const ${name}: i32 = (\\d+);`));
    assert(match, name);
    assert.equal(Number(match[1]), value, `${name} budget unchanged`);
  }
  if (detail.DETAIL_GRAIN_CLUSTERS) for (const weight of [1, 0.4]) {
    const f = fixture(code, weight);
    exhaust(f);
    const alt = alternate(f.state());
    assert.equal(alt.gAltW, weight === 1 ? -1 : weight);
    if (weight < 1) {
      assert.equal(alt.gAltGeom, false);
      assert.deepEqual(alt.gAltP, [0.5, 0.5, 0.5]);
      assert.deepEqual(alt.gAltCol, [0.1, 0.2, 0.3]);
      assert.deepEqual(alt.gAltTrans, [0.9, 0.8, 0.7]);
    }
    assert.equal(f.segment(4).ev, OPAQUE, 'fifth clod retains opaque smooth fallback');
    assert.equal(f.calls.clod.length, 4);
    assert.deepEqual(alternate(f.state()), alt, 'fallback preserves stored crossfade path');
    for (const neighbor of [EMPTY, SAND]) {
      const empty = fixture(code, weight); exhaust(empty);
      const before = alternate(empty.state());
      assert.equal(empty.segment(4, EMPTY, { neighbor }).ev, OPAQUE, 'empty-cell blur envelope fallback');
      assert.deepEqual(alternate(empty.state()), before);
      assert.equal(empty.calls.clod.length, 4);
    }
    // The fourth test must still replace its surface whether geometry is before
    // or behind the smooth crossing (the latter requires suppression first).
    for (const hitOffset of [0.25, 0.75]) {
      const hit = fixture(code, weight, { hitAt: 4, hitOffset });
      for (let n = 0; n < 3; n++) assert.equal(hit.segment(n).ev, NONE);
      const result = hit.segment(3);
      assert.equal(result.ev, GRAIN);
      assert.equal(result.time, 9 + hitOffset);
      assert.equal(hit.calls.clod.length, 4);
      assert.equal(hit.state().gHitK, 0);
    }
    // Geometry-first handoff keeps its alternate and commits to texture.
    const first = fixture(code, weight, { hitAt: 1, hitOffset: 0.25 });
    assert.equal(first.segment(0).ev, weight === 1 ? GRAIN : OPAQUE);
    if (weight < 1) {
      const before = alternate(first.state());
      assert.equal(before.gAltGeom, true);
      assert.equal(before.gAltW, weight);
      assert.equal(first.segment(1).ev, OPAQUE);
      assert.equal(first.calls.clod.length, 1);
      assert.deepEqual(alternate(first.state()), before);
    }
    if (detail.DETAIL_GRAINS) {
      for (const empty of [false, true]) {
        const peb = fixture(code, weight, { fill: 1 }); exhaust(peb);
        assert.equal(peb.segment(4, empty ? EMPTY : STONE, { neighbor: STONE }).ev, NONE,
          'known pebble surface still suppresses after clod budget');
        assert.equal(peb.calls.pebble, 1);
        assert.equal(peb.calls.clod.length, 4);
      }
      const peb = fixture(code, weight, { pebbleHit: true }); exhaust(peb);
      assert.equal(peb.segment(4, STONE).ev, GRAIN);
      assert.equal(peb.state().gHitK, -2);
      const mixed = fixture(code, weight); exhaust(mixed);
      mixed.world.set(key([13, 0, 0]), SAND);
      assert.equal(mixed.segment(4, EMPTY, { neighbor: STONE }).ev, OPAQUE,
        'pebble neighbor cannot erase an untested clod envelope');
    } else {
      const gravel = fixture(code, weight); exhaust(gravel);
      assert.equal(gravel.segment(4, STONE).ev, OPAQUE, 'gravel-as-clod also falls back');
    }
    const far = fixture(code, 0);
    assert.equal(far.segment(0).ev, OPAQUE);
    assert.equal(far.calls.clod.length, 0);
    const other = fixture(code, weight);
    assert.equal(other.segment(0, SOLID, { channel: 0 }).ev, OPAQUE);
    assert.equal(other.calls.clod.length, 0);
  }
  if (detail.DETAIL_GRAINS) {
    const peb = fixture(code, 1);
    for (let n = 0; n < 23; n++) assert.equal(peb.segment(n, STONE).ev, NONE);
    assert.equal(peb.segment(23, STONE).ev, GRAIN, 'pebble budget keeps its dark-depth fallback');
    assert.equal(peb.state().gHitK, -1);
    assert.equal(peb.state().gPebSteps, 24);
    assert.equal(peb.calls.pebble, 24);
    assert.equal(peb.calls.clod.length, 0);
  }
  if (!detail.DETAIL_GRAIN_CLUSTERS) {
    const f = fixture(code, 1);
    assert.equal(f.segment(0).ev, OPAQUE, 'pebbles-only leaves sand smooth');
    assert.equal(f.segment(1, STONE).ev, NONE);
    assert.equal(f.calls.clod.length, 0);
    assert.equal(f.calls.pebble, 1);
  }
}
console.log('PASS generated grainEvent/grainSuppress: five-clod fallback, full/crossfade, empty envelopes, fourth-test hits, gAlt preservation, pebbles, unchanged budgets');

if (process.argv.includes('--naga')) {
  assert(refIndex < 0, '--naga validates current complete shaders only');
  const dir = mkdtempSync(join(tmpdir(), 'clod-budget-'));
  let count = 0;
  try {
    for (const detail of [{}, ...details]) for (const curved of [false, true]) {
      const path = join(dir, `volume-${count++}.wgsl`);
      writeFileSync(path, volumeFrag({ nx: 32, ny: 32, nz: 32 }, { detail, curved }));
      const run = spawnSync('naga', [path], { encoding: 'utf8', timeout: 120_000 });
      assert.ifError(run.error);
      assert.equal(run.status, 0, `${path}\n${run.stdout}\n${run.stderr}`);
    }
    console.log(`PASS Naga: ${count} complete straight/curved, off/clods/pebbles/both shaders`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
