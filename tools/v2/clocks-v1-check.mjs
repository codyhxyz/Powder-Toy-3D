// CPU-only: V2's clocks and readouts behave as V1's (v2f/clocks; app.md C5, C6, C7, T6, T12).
// Real modules (the host clock, the tools' trigger, the console's Lua and edit queue, the profiler)
// with the GPU and the app shell faked. No browser, no GPU.
//   T6  a first-person tool's clock is real time under either engine: paused it re-arms, and at any
//       Speed it fires at its own rate (V1's toolDt = ctx.dt; V2's ran on the ticks: frozen paused);
//   C7  the console's beforesim and aftersim fire around a native tick in V1's order, B A B A B A B
//       [tick] A, so a script that counts, pairs or alternates them sees V1's sequence;
//   T12 the held brush paints at V1's rate a game step (a paint per settings.steps V1 steps) at any
//       frame rate and Speed; a click paints once;
//   C5  a frame's ticks (frameTicks) are nativeHostSteps' own; the view's clock and the scene's
//       animations move every frame at Speed under 1×, V1's one step a frame at Speed 1; the Speed
//       label shows the game speed (0.25× to 3×);
//   C6  the HUD's steps/s and the profiler count V1 steps (4 a tick), and the profiler's brick shares
//       are V2's own activity (readStats), not V1's stale maps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { trigger, toolDt } = await import('../../src/pov/tools/action.js');
const { nativeHostSteps, frameTicks, partialTick, viewStepClock, particleLagSeconds, stepClock, legacyStepHooks, brushPace, legacySteps,
  HOST_HZ, LEGACY_STEPS_PER_TICK, CATCH_UP_TICKS } = await import('../../src/v2/host.js');
const { ScriptWorld, EDIT, EDIT_TEX_W, EDIT_SEARCH_STEPS } = await import('../../src/console/world.js');
const { installBuiltins } = await import('../../src/console/api.js');
const { createLua, EVENTS } = await import('../../src/console/lua.js');
const { createProfiler } = await import('../../src/gfx/profiler.js');
const { ELEMENTS, E } = await import('../../src/elements.js');
const { PHYS } = await import('../../src/physics.js');
const { nativeParticleView } = await import('../../src/gfx/nativeParticles.js');
const { WGSL_CHECK: PARTICLE_WGSL } = await import('../../src/shaders/v2/particleRender.js');
const { CELL_M } = await import('../../src/scale.js');
const { PerspectiveCamera, Matrix4 } = await import('three');
const src = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const app = src('app.js');
const DEFAULT_STEPS = 4;   // app.js DEFAULTS.steps: V1's steps a frame at 1×
assert.equal(LEGACY_STEPS_PER_TICK, DEFAULT_STEPS, 'a native tick is V1\'s default frame of steps');
assert(/steps: 4, gravity:/.test(app), 'app.js DEFAULTS.steps is 4');

// ---- T6: the tools' clock is real time, paused and at any Speed
{
  const SMG_INTERVAL = 1 / 13;   // a held trigger's refire (s)
  // frames of `seconds` at 60 fps, the button held; ctx as pov/index.js builds it (nativeDt: the ticks' game time)
  const fires = (nativeDtOf, seconds = 1) => {
    const t = trigger(SMG_INTERVAL);
    let n = 0;
    for (let i = 0; i < 60 * seconds; i++) {
      const ctx = { dt: 1 / 60, nativeDt: nativeDtOf(i), primary: true, primaryPressed: i === 0 };
      if (t.ready(ctx)) { t.fire(); n++; }
    }
    return n;
  };
  const v1 = fires(() => undefined);
  assert.equal(v1, 1 + Math.floor(1 / SMG_INTERVAL), 'V1: the first round and 13 more a second, as its frame time says');
  assert.equal(fires(() => 0), v1, 'V2 paused (no ticks, nativeDt 0): the trigger re-arms in real time, as V1 (it fired once and froze)');
  assert.equal(fires((i) => (i % 2 ? 1 / 60 : 0)), v1, 'V2 at Speed ½ (a tick every other frame): the same rate of fire (it was half)');
  assert.equal(fires((i) => 2 / 60), v1, 'V2 at Speed 2×: the same rate of fire (it was double)');
  assert.equal(toolDt({ dt: 0.02, nativeDt: 0, toolRate: 1.5 }), 0.03, 'the Faster Tools perk still speeds the real clock');
  console.log(`PASS T6 tool clock: ${v1} rounds in a second paused, at ½× and 2×, as V1`);
}

// ---- C7: beforesim / aftersim around a native tick in V1's order (the real Lua and edit queue)
{
  const B = [16, 8, 8], SIZE = [16, 8, 8];
  const texels = B[0] * B[1] * B[2];
  // the console's CPU backend (tools/check-console.mjs's mock: one block, the GPU pass's binary search)
  function mockBackend() {
    const a = new Float32Array(texels * 4), b = new Float32Array(texels * 4);
    for (let t = 0; t < texels; t++) a[t * 4 + 1] = PHYS.AMBIENT;
    const locate = (x, y, z) => [0, x + B[0] * (z + B[2] * y)];
    const be = {
      passes: 0, epoch: () => 'a', size: () => SIZE, blockCount: 1, blockTexels: texels, locate,
      readBlocks(list, sync) { const m = new Map(list.map((i) => [i, { a: a.slice(), b: b.slice() }])); return sync ? m : Promise.resolve(m); },
      applyEdits({ count, rows, data, lo, hi }) {
        be.passes++;
        const at = (j, part) => { const t = ((Math.floor(j / EDIT_TEX_W) + part * rows) * EDIT_TEX_W + (j % EDIT_TEX_W)) * 4; return data.subarray(t, t + 4); };
        for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
          const key = (z * SIZE[1] + y) * SIZE[0] + x;
          let l = 0, h = count - 1, j = -1;
          for (let i = 0; i < EDIT_SEARCH_STEPS && l <= h; i++) {
            const mid = (l + h) >> 1, k = at(mid, 0)[0];
            if (k === key) { j = mid; break; }
            if (k < key) l = mid + 1; else h = mid - 1;
          }
          if (j < 0) continue;
          const m = at(j, 0)[1], va = at(j, 1), o = locate(x, y, z)[1] * 4;
          if (m & EDIT.SPAWN) { const n = Math.round(va[0]); a.set([n, ELEMENTS[n].temp, ELEMENTS[n].life, 0], o); }
          if (m & EDIT.TEMP) a[o + 1] = va[1];
        }
      },
      temp: (x, y, z) => a[locate(x, y, z)[1] * 4 + 1],
    };
    return be;
  }
  // a console as console/index.js wires its hooks: beforeStep dispatches beforesim then flushes the
  // queued writes, afterStep dispatches aftersim (its writes wait for the next flush)
  function consoleRun(drive) {
    const backend = mockBackend(), world = new ScriptWorld(backend, { now: () => 0 });
    installBuiltins({ world, paused: () => false, setPaused() {}, step() {}, gravity: () => 1, setGravity() {},
      brushRadius: () => 1, setBrushRadius() {}, brushShape: () => 0, setBrushShape() {}, selected: () => E.SAND, select() {},
      paint() {}, origin: () => [0, 0, 0] });
    let clock = 0;
    const L = createLua({ log: () => {}, now: () => (clock += 1e-6) });
    const run = (code) => { world.beginCommand(); const r = L.run(code); world.flush(); assert(r.ok, r.error); return r.text; };
    // counts the steps, pairs before with after, alternates a write every other step
    run(`n = 0; paired = 0; flag = false; seq = {}
      event.register(event.beforesim, function()
        n = n + 1; seq[#seq + 1] = "B" .. n; flag = true
        sim.cellProperty(2, 2, 2, "temp", (n % 2 == 0) and 500 or 100)
      end)
      event.register(event.aftersim, function()
        seq[#seq + 1] = "A" .. n
        if flag then paired = paired + 1; flag = false end
      end)`);
    const beforeStep = () => { L.dispatch(EVENTS.BEFORESIM); world.flush(); };
    const afterStep = () => { L.dispatch(EVENTS.AFTERSIM); };
    const seen = [];   // the temperature each step (V1) or tick (V2) ran on
    drive({ beforeStep, afterStep, step: () => seen.push(backend.temp(2, 2, 2)) });
    world.flush();
    return { seq: run('table.concat(seq, " ")'), paired: Number(run('paired')), n: Number(run('n')), seen, passes: backend.passes };
  }
  const STEPS = 8;
  // V1 (app.js tick's V1 loop): beforeStep, the step, afterStep, settings.steps times a frame
  const v1 = consoleRun(({ beforeStep, afterStep, step }) => { for (let i = 0; i < STEPS; i++) { beforeStep(); step(); afterStep(); } });
  // V2 (app.js nativeBeforeStep / nativeAfterStep): legacyStepHooks around each tick
  const v2 = consoleRun(({ beforeStep, afterStep, step }) => {
    const hooks = legacyStepHooks(beforeStep, afterStep);
    for (let i = 0; i < STEPS / LEGACY_STEPS_PER_TICK; i++) { hooks.before(); step(); hooks.after(); }
  });
  assert.equal(v1.seq, 'B1 A1 B2 A2 B3 A3 B4 A4 B5 A5 B6 A6 B7 A7 B8 A8');
  assert.equal(v2.seq, v1.seq, 'V2 fires them in V1\'s order (it fired B1 B2 B3 B4 A4 A4 A4 A4: every aftersim saw the last step)');
  assert.equal(v2.n, STEPS, 'a script counting steps counts V1\'s');
  assert.equal(v2.paired, v1.paired, `a before/after pair runs once a V1 step: ${v2.paired} (it ran once a tick)`);
  assert.deepEqual(v1.seen, [100, 500, 100, 500, 100, 500, 100, 500], 'V1: each step sees its own beforesim\'s write');
  assert.deepEqual(v2.seen, [500, 500], 'V2: each tick sees the write of its last step\'s beforesim, every earlier one applied before it');
  assert.equal(v2.passes, v1.passes, 'each call\'s writes go up on their own, in order, as V1\'s (none merged with the next call\'s)');
  // the console's hooks are those two (console/index.js), and the app wires them through legacyStepHooks
  const consoleSrc = src('console/index.js');
  assert(/beforeStep\(\) \{\s*if \(!active\(\)\) return;\s*if \(lua\.handlerCount\(EVENT\.BEFORESIM\)\) dispatch\(EVENT\.BEFORESIM\);\s*world\.flush\(\);/.test(consoleSrc), 'beforeStep: dispatch, then flush');
  assert(/afterStep\(\) \{\s*if \(active\(\) && lua\.handlerCount\(EVENT\.AFTERSIM\)\) dispatch\(EVENT\.AFTERSIM\);\s*\}/.test(consoleSrc), 'afterStep: dispatch only');
  assert(/const scriptSteps = legacyStepHooks\(\(\) => scripts\?\.beforeStep\(\), \(\) => scripts\?\.afterStep\(\)\);/.test(app));
  console.log(`PASS C7 Lua hooks: ${v2.seq.split(' ').length} calls over ${STEPS / LEGACY_STEPS_PER_TICK} ticks in V1's order, ${v2.paired} pairs`);
}

// ---- T12: the held brush paints at V1's rate a game step
{
  // a stroke held for `seconds` at `fps`, Speed `steps` (settings.steps); V2: the ticks frameTicks gives
  // each frame (the app's ctx.nativeToolSteps), the paints brushPace owes before them
  const stroke = (fps, steps, seconds = 2) => {
    const pace = brushPace(); pace.start();
    let acc = 0, paints = 0, legacy = 0;
    for (let i = 0; i < Math.round(fps * seconds); i++) {
      const due = frameTicks(acc, 1 / fps, steps / DEFAULT_STEPS);
      paints += pace.frame(due.n * LEGACY_STEPS_PER_TICK, steps);
      acc = due.acc; legacy += due.n * LEGACY_STEPS_PER_TICK;
    }
    return { paints, legacy };
  };
  for (const fps of [30, 48, 60, 120, 144]) for (const steps of [1, 2, 3, 4, 5, 8, 12]) {
    const { paints, legacy } = stroke(fps, steps);
    // V1: a paint a frame, before its `steps` steps: the paint instants 0, steps, 2·steps, ... the steps reach
    const want = Math.ceil(legacy / steps);
    assert(Math.abs(paints - want) <= 1, `${fps} fps, Speed ${steps}: ${paints} paints over ${legacy} V1 steps, V1's rate ${want}`);
  }
  // what a paint a frame gave (the old rule): half V1's a game step at 30 fps, twice at 120
  const at30 = stroke(30, 4), at120 = stroke(120, 4);
  assert(Math.abs(at30.paints - at30.legacy / 4) <= 1 && 30 * 2 < at30.legacy / 4 * 0.6, '30 fps: two ticks a frame, two paints (a paint a frame was half)');
  assert(Math.abs(at120.paints - at120.legacy / 4) <= 1 && 120 * 2 > at120.legacy / 4 * 1.6, '120 Hz: a paint a tick (a paint a frame was twice)');
  // a click: its one frame paints once, whether the frame ticks or not; then the next paint waits its steps
  const click = brushPace(); click.start();
  assert.equal(click.frame(0, 4), 1, 'a click on a frame without a tick paints once');
  assert.equal(click.frame(0, 4), 0, '...and nothing more until game time passes');
  const slow = brushPace(); slow.start();
  // (the instant a tick's steps end on is due at once, before the next tick: V1's paint before that step)
  assert.deepEqual([0, 0, 0, 4, 0, 0, 0, 4].map((s) => slow.frame(s, 1)), [1, 0, 0, 3, 1, 0, 0, 3],
    'Speed 1 (0.25×): four paints a tick, before its steps (V1: one a step)');
  // the app paces only a running V2 box's own brush, once a frame otherwise (paused, building, a guest's, particles)
  assert(/const paced = v2Box\(\) && v2Active\(\) && !settings\.paused && !mp\.isGuest && rayKindOfTool\(strokeTool\) === RAY_KIND\.NONE;/.test(app));
  assert(/return paced \? strokePace\.frame\(ctx\.nativeToolSteps \* LEGACY_STEPS_PER_TICK, settings\.steps\) : 1;/.test(app));
  assert(/for \(let i = 0; i < paints; i\+\+\) paintStroke\(stroke\);/.test(app), 'the frame paints what it owes');
  console.log('PASS T12 brush rate: V1\'s paints a game step at 30-144 fps and Speed 1-12; a click paints once');
}

// ---- C5: the frame's ticks, the partial tick, the view clock, the label
{
  // frameTicks is nativeHostSteps' own accumulator (a fake owner: the clock only)
  const fakeOwner = () => {
    const sim = { frame: 0, nativeTicks: 0 };
    const owner = { isReady: true, disposed: false, acc: 0, asleep: false, sim, activate() { sim.compact = owner; }, sync() {}, ticks() {} };
    owner.activate();
    return owner;
  };
  for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 2, 3]) for (const fps of [30, 60, 144]) {
    const owner = fakeOwner();
    let acc = 0;
    for (let i = 0; i < fps; i++) {
      const due = frameTicks(acc, 1 / fps, speed);
      assert.equal(nativeHostSteps(owner, 1 / fps, { speed }), due.n, 'the ticks the app reads before are the ticks it runs');
      acc = due.acc;
      assert.equal(owner.acc, acc);
    }
  }
  assert.deepEqual(frameTicks(0.5, 1, 1), { n: Math.ceil(CATCH_UP_TICKS * 1), acc: 0 }, 'past the catch-up cap time dilates');
  // Speed 1 (0.25×) at 60 fps: a tick every fourth frame. V1 at Speed 1: a step a frame.
  const owner = fakeOwner(), sim = owner.sim;
  const view = [], ticked = [];
  for (let i = 0; i < 16; i++) {
    nativeHostSteps(owner, 1 / 60, { speed: 0.25 });
    view.push(viewStepClock(sim)); ticked.push(stepClock(sim));
  }
  const steps = (a) => a.slice(1).map((x, i) => +(x - a[i]).toFixed(9));
  assert.deepEqual(steps(view), Array(15).fill(1), 'the view clock moves one V1 step every frame, as V1\'s at Speed 1');
  assert(steps(ticked).some((d) => d === 0) && steps(ticked).some((d) => d === 4), 'the ticks alone move it four steps every fourth frame');
  assert.equal(partialTick({ compact: null }), 0, 'V1: no partial tick');
  assert.equal(viewStepClock({ frame: 7, compact: null }), 7, 'V1: exactly its steps');
  // paused (no host call): it holds
  const held = viewStepClock(sim); assert.equal(viewStepClock(sim), held);
  // flying matter: a record moving at v (m/s) whose position steps a tick at a time is drawn the
  // share of a tick behind it (particleRender.js: pos - velocity × P.lag), so it moves every frame
  {
    const o = fakeOwner(), s = o.sim, v = 12;   // m/s
    let ticks = 0;
    const drawn = [], raw = [];
    for (let i = 0; i < 16; i++) {
      ticks += nativeHostSteps(o, 1 / 60, { speed: 0.25 });
      const pos = ticks * v / HOST_HZ / CELL_M;   // cells: the record after its ticks
      const view = nativeParticleView(new PerspectiveCamera(), 720, new Matrix4(), [0, 0, 0], 0, particleLagSeconds(s));
      drawn.push(pos - v * view.lag); raw.push(pos);
    }
    const perFrame = v / HOST_HZ / CELL_M * 0.25;   // cells: a quarter tick's flight
    assert.deepEqual(steps(drawn).map((d) => +(d / perFrame).toFixed(6)), Array(15).fill(1), 'drawn a quarter tick further every frame at 0.25×');
    assert(steps(raw).some((d) => d === 0), 'its record moves only on the tick frames');
    assert.equal(particleLagSeconds(s, false), 0, 'a replica draws its records as they come');
    assert.equal(particleLagSeconds({ compact: null }), 0, 'V1: no V2 records');
    const shaders = Object.fromEntries(PARTICLE_WGSL.map((c) => [c.name, c.code()]));
    for (const name of ['nativeParticleMatter', 'nativeParticleRays']) {
      assert(shaders[name].includes('o.center = bitcast<vec3f>(p.positionId.xyz) - P.origin - bitcast<vec3f>(p.velocityCore.xyz) * P.lag;'), `${name} draws on the partial tick`);
    }
    assert((shaders.nativeParticlePick.match(/particleDrawn\(p\)/g) ?? []).length === 2, 'the pick picks where the particle is drawn');
    assert(/lagSeconds: particleLagSeconds\(app\.sim, !app\.mp\?\.replica\)/.test(src('wire/rays.js')), 'the rays wire passes the lag');
    assert(/lag: this\.view\?\.lag \?\? 0/.test(src('gfx/nativeParticles.js')), "the pick's params carry it");
    // the frames between ticks are drawn (the pacer would keep the last image until the tick)
    assert(/const betweenTicks = v2Box\(\) && v2Running && stepping && stepped === 0 && !physicsV2\.asleep;/.test(app));
    assert(/runView = present && pacer\.view\(viewV, runDerived \|\| wantFrame\(\) \|\| betweenTicks\);/.test(app), 'Box');
    assert(/runView:pacer\.view\(key,derived\|\|wantFrame\(\)\|\|betweenTicks\)/.test(app), 'World');
  }
  // the app draws by it, the scene's animations run on it, the label shows the game's speed
  assert(/const now = viewStepClock\(sim\);/.test(app), 'app.js viewClock');
  assert(/const steps = viewStepClock\(sim\);/.test(src('gfx/uniforms.js')), 'gfx/uniforms.js uSimClock and the cloud drift');
  assert(/animTime \+= Math\.max\(0, stepped \+ \(physicsV2\?\.acc \?\? 0\) - accFrom\) \/ HOST_HZ;/.test(app), 'perk orbs and banners on game time with the partial tick');
  const fmt = app.match(/const fmtSpeed = \(v\) => `\$\{\+\(v \/ DEFAULTS\.steps\)\.toFixed\(2\)\}×`;/);
  assert(fmt, 'the Speed label');
  const fmtSpeed = (v) => `${+(v / DEFAULT_STEPS).toFixed(2)}×`;
  assert.deepEqual([1, 2, 3, 4, 5, 8, 12].map(fmtSpeed), ['0.25×', '0.5×', '0.75×', '1×', '1.25×', '2×', '3×'], 'Speed 1 reads 0.25× (it read 1×)');
  assert(/key: 'steps', label: 'Speed', min: 1, max: 12/.test(app));
  console.log('PASS C5 clocks: frameTicks = nativeHostSteps, the view clock and flying matter move every frame at 0.25×, Speed label 0.25×-3×');
}

// ---- C6: steps/s and the profiler in V1 steps, the profiler's shares V2's own
{
  assert(/const legacyStepped = !stepping \? 0 : stepped \* LEGACY_STEPS_PER_TICK;/.test(app));
  assert(/stepCount \+= legacyStepped;/.test(app), 'the HUD\'s steps/s');
  assert(/prof\.endFrame\(legacyStepped\);/.test(app), 'the profiler\'s per-step costs');
  // World maps: the rates are counted after the renderer branch (if(win) {...} else {...}), not inside the
  // box's, where a World frame never reached them and the HUD kept its boot fps and 0 steps/s
  const branch = app.indexOf('if(win) {\n    // The WORLD renderer failing');
  assert(branch > 0, 'tick\'s World/box renderer branch');
  const blockEnd = (open) => { let depth = 0, i = open; do { if (app[i] === '{') depth++; else if (app[i] === '}') depth--; i++; } while (depth); return i; };
  const ifEnd = blockEnd(app.indexOf('{', branch));
  assert(/^\s*else \{/.test(app.slice(ifEnd)), 'the box\'s else branch');
  const at = blockEnd(app.indexOf('{', ifEnd));
  const call = app.indexOf('countHudRates(runView, now, dt, legacyStepped)', branch);
  assert(call > at && call < app.indexOf('gpu.endFrame();', branch), 'the HUD\'s rates are counted for World frames too (after the renderer branch)');
  const rates = vm.createContext({ FPS_WINDOW: 0.5, frames: 0, fpsTime: 0, fps: 60, idleTime: 0, lastDrawAt: null, stepTime: 0, stepCount: 0, stepRate: 0 });
  const fnText = app.slice(app.indexOf('function countHudRates('), app.indexOf('\n}\n', app.indexOf('function countHudRates(')) + 2);
  vm.runInContext(fnText, rates);
  for (let i = 0; i < 61; i++) vm.runInContext(`countHudRates(true, ${i * 1000 / 30}, ${1 / 30}, ${2 * LEGACY_STEPS_PER_TICK})`, rates);
  assert(Math.abs(rates.fps - 30) < 1 && Math.abs(rates.stepRate - 240) < 5, `a World frame's rates: ${rates.fps} fps, ${rates.stepRate} steps/s`);
  assert.equal(legacySteps({ compact: {} }, 1), 4);
  // the profiler: frames of one tick (4 V1 steps), samples a second apart; V2's activity from readStats
  let passes = 0, now = 0, sample = null;
  const timing = { supported: false, enabled: false, split: false, get passCount() { return passes; }, lastFrame: 0, lastPasses: [], lastCoverage: null };
  const gpu = { timing, frameNo: 0, memory: () => ({ bytes: 0 }), adapterInfo: {} };
  const units = 512;
  const v2Sim = { g: { nx: 64, ny: 64, nz: 64 }, compact: { readStats: async () => ({ tick: 9, awake: 128, busy: 32, quiet: 0, lastBusy: 8, cols: 4, units }) },
    readMaps: async () => ({ awake: new Uint8Array(units).fill(1), drawn: new Uint8Array(units).fill(1) }) };   // V1's stale maps: everything
  const prof = createProfiler(gpu, { describe: () => ({ sim: v2Sim, renderScale: 1 }), onSample: (s) => { if (s) sample = s; } });
  prof.enable(true);
  for (let i = 0; i < 130; i++) {
    prof.beginFrame(now); passes++; gpu.frameNo++; prof.endFrame(LEGACY_STEPS_PER_TICK); now += 1000 / 60;
    await Promise.resolve();
  }
  assert(sample, 'samples');
  assert.equal(sample.awake, 32 / units, 'awake: the bricks a V2 rule was busy in (V1\'s maps said every brick)');
  assert.equal(sample.drawn, 128 / units, 'drawn: the bricks V2\'s passes ran over');
  assert(Math.abs(sample.stepsPerSec - 240) < 5, `steps/s in V1 steps: ${sample.stepsPerSec} (a tick a 60 Hz frame is 240)`);
  console.log(`PASS C6 readouts: ${sample.stepsPerSec.toFixed(0)} steps/s, awake ${sample.awake} / drawn ${sample.drawn} from V2's stats`);
}
console.log('V2 clocks and readouts as V1: passed');
