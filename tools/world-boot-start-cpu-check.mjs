// CPU only (source reading, no GPU or browser): a big map's World data load starts from its
// world's load, and that load waits for its own passes only, never the simulation's step kernels
// (move, react). In the user's cold Island load (2026-10-22, Chrome, M5) move took 5.4 s and the
// World load's first attempt began at 8.96 s, after it; the loop also slept till the step kernels
// were built. Every big map takes this path (wire/world.js). The step kernels are V2's grid passes now
// (v2/physics.js; V1's went with V1, the v1-oracle tag).
// Run: node --test tools/world-boot-start-cpu-check.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const app = read('app.js'), wire = read('wire/world.js'), sim = read('sim.js'), win = read('world/window.js'), physics = read('v2/physics.js');

// The body of the first `head ... {` block after `head` (brace matched).
function body(source, head, from = 0) {
  const at = source.indexOf(head, from);
  assert.ok(at >= 0, `no ${head}`);
  const open = source.indexOf('{', at + head.length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${head}`);
}
const keys = (block) => [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

// V2's grid passes (shaders/v2.js and its families: every one named v2…)
const isStepKernel = (name) => /^v2/.test(name);
const writers = keys(body(sim, 'this.passes = {'));
const lazy = keys(body(sim, 'this._lazy = {'));

test("the step kernels (V2's grid passes) build behind the World load on a big map", () => {
  assert.doesNotMatch(sim, /this\.kernels = \{/, "sim.js builds no step kernels (V1's went with V1)");
  assert.match(physics, /build: sim\.g\.windowed \? 'later' : 'now', first: LONG_POLES\.has\(k\.name\)/, "a window's are `later`, long poles first");
});

test("a world's load waits for its window's passes and the blank state's, never a step kernel", () => {
  // (wire/world.js imports the build's virtual world bake, so Node reads its list instead)
  const list = /export const WORLD_LOAD_PASSES = Object\.freeze\(\[([^\]]*)\]\);/.exec(wire);
  assert.ok(list, 'WORLD_LOAD_PASSES');
  const WORLD_LOAD_PASSES = [...list[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.ok(WORLD_LOAD_PASSES.length > 0);
  for (const p of WORLD_LOAD_PASSES) {
    assert.ok(!isStepKernel(p), `${p} is a step kernel`);
    assert.ok(writers.includes(p) || lazy.includes(p), `${p} is a simulation pass`);
  }
  const load = body(wire, '  loadScene(app) {');
  assert.match(load, /Promise\.all\(\[w\.whenReady\(\), sim\.prepare\(\.\.\.WORLD_LOAD_PASSES\)\]\)\.then\(/);
  assert.doesNotMatch(load, /whenSimReady|\.ready\b|kernels/, 'nothing else is awaited');
  assert.ok(load.indexOf('sim.clear()') > load.indexOf('.then('), 'the blank state is written once its pass is built');
  const ready = body(win, '  whenReady() {');
  assert.doesNotMatch(ready, /sim\.ready|kernels|readySims/);
  for (const [, names] of ready.matchAll(/sim\.prepare\(([^)]*)\)/g))
    for (const [, n] of names.matchAll(/'(\w+)'/g)) assert.ok(!isStepKernel(n), `whenReady waits for ${n}, a step kernel`);
});

test('the app loads a big map outside the simulation-ready wait, and ticks render-only meanwhile', () => {
  const preset = body(app, 'function loadPreset(name, undoable = true) {');
  const call = preset.indexOf("if (win && !mp.replica) wire('world').loadScene(ctx);");
  assert.ok(call >= 0 && call < preset.indexOf('whenSimReady('), 'loadScene is called before, not inside, whenSimReady');
  assert.equal(preset.match(/loadScene\(ctx\)/g).length, 1);
  const build = body(app, 'function build(savedWorldSize = null) {');
  const draw = /const draw = \[([^\n]*)\n([^\n]*)\];/.exec(build);
  assert.ok(draw, 'the frame draw set');
  assert.doesNotMatch(draw[0], /\bs\.ready\b/, 'a big map draws without the step kernels');
  assert.match(build, /worldDrawWait = worldMode \? Promise\.all\(draw\) : core;/);
  assert.match(build, /if \(worldMode\) worldDrawWait\.then\(/);
  // the boot starts the loop on that set (not coreWait), and its loading screen stays till both
  const boot = app.slice(app.indexOf("launch.progress?.('compile');"));
  assert.ok(boot.indexOf('await worldDrawWait;') >= 0 && boot.indexOf('await worldDrawWait;') < boot.indexOf('loop.start();'));
  assert.doesNotMatch(boot.slice(0, boot.indexOf('loop.start();')), /await coreWait;\n\s*if \(graphicsFailure\) throw graphicsFailure;\n\s*window\.__app/);
  assert.match(body(app, 'function bootReady(pending = null) {'), /if\(win&&\(!win\.renderFrame\?\.driver\?\.displayedMainFrame\|\|!coreReady\)\)\{/);
  const tick = body(app, 'function tick(now, renderOnly = false) {');
  assert.match(tick, /if \(!coreReady && !\(win && worldDrawReady\)\) return false;/);
  assert.match(tick, /const simPending = !coreReady;\n\s*renderOnly \|\|= simPending;/);
  assert.match(tick, /\(!renderOnly \|\| ctx\.descent\?\.terrainPending \|\| simPending\) && \(gpu\.inFlight/, 'still paced');
  assert.match(tick, /if \(!ctx\.descent\?\.terrainPending && !simPending\) for \(const w of live\)/, 'no afterStep hook before the simulation is ready');
});

test("a big map's build starts the World frame state's media noise beside its view pipeline", () => {
  const attach = body(wire, '  attach(app) {');
  const noise = attach.indexOf('createMediaNoise(app.gpu)');
  assert.ok(noise >= 0 && noise < attach.indexOf('new WorldWindow('));
  assert.ok(attach.indexOf('startWorldFrameView(app, scene)') < noise);
});
