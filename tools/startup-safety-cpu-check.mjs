// Actual main.js orchestration with fake DOM/adapter/modules and a fake clock.
// No browser, device, native compiler or GPU work.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { test } from 'node:test';
import { loadSourceMapManifests, SOURCE_MANIFEST_BUDGET_MS } from '../src/startupSafety.js';
import { installLocalCrueltyMaps } from '../src/world/import/localMap.js';
import { MAPS } from '../src/maps.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';

function clock() {
  let next = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimer(fn, ms) { const id = ++next; jobs.set(id, { fn, ms }); return id; },
    clearTimer(id) { jobs.delete(id); },
    fire(ms) {
      for (const [id, job] of [...jobs]) if (job.ms === ms) { jobs.delete(id); job.fn(); }
    },
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

test('map registration has a separate deadline before the menu and aborts late module downloads', async () => {
  const time = clock(), loader = deferred();
  let installs = 0;
  const pending = loadSourceMapManifests(() => loader.promise, time);
  await turn();
  time.fire(SOURCE_MANIFEST_BUDGET_MS);
  await assert.rejects(pending, /map details did not load/);
  loader.resolve({ installLocalCrueltyMaps() { installs++; } }); await turn();
  assert.equal(installs, 0);
  assert.equal(time.jobs.size, 0);
  let signal;
  const next = loadSourceMapManifests(async () => ({
    installLocalCrueltyMaps(opts) { signal = opts.signal; return new Promise(() => {}); },
  }), time);
  await turn(); time.fire(SOURCE_MANIFEST_BUDGET_MS);
  await assert.rejects(next, /10 seconds/);
  assert.equal(signal.aborted, true);
});

test('actual map installer does not register late response bodies after cancellation', async () => {
  const savedFetch = globalThis.fetch, body = deferred(), controller = new AbortController();
  const maps = MAPS.length, scenes = WORLD_SCENES.length, signals = [];
  globalThis.fetch = async (url, { signal }) => {
    signals.push(signal);
    const map = JSON.parse(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf8'));
    return { status: 200, ok: true, url: `https://fixture.test${url}`,
      async json() { await body.promise; return map; } };
  };
  try {
    const installing = installLocalCrueltyMaps({ signal: controller.signal });
    await turn();
    assert.equal(signals.length, 4);
    assert(signals.every(signal => signal === controller.signal));
    controller.abort(); body.resolve();
    assert.deepEqual(await installing, []);
    assert.equal(MAPS.length, maps);
    assert.equal(WORLD_SCENES.length, scenes);
  } finally { globalThis.fetch = savedFetch; }
});

async function mainHarness({ search = '?map=fixture', probe: suppliedProbe, onImport = () => {}, appGate, missingMap = false } = {}) {
  const time = clock(), events = [], buttons = [], imports = [];
  const launch = { map: null, mode: 'sandbox', save: null, gpu: null, startupError: null };
  let text = '';
  const error = { style: {}, children: [], append(child) { this.children.push(child); },
    get textContent() { return text; }, set textContent(v) { text = v; this.children = []; } };
  const menu = { isOpen: true,
    open() { events.push('open'); this.isOpen = true; },
    close() { events.push('close'); this.isOpen = false; },
    loading() {}, progress() {},
  };
  const location = new URL(`https://example.test/${search}`);
  location.assign = href => events.push(['assign', href]);
  location.replace = href => events.push(['replace', href]);
  const document = {
    getElementById: id => id === 'error' ? error : null,
    createElement: tag => { const el = { tag }; buttons.push(el); return el; },
  };
  const context = vm.createContext({
    document, location, window: {}, URL, URLSearchParams,
    matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null },
    history: { state: null, replaceState() {} },
    console: { error: (...args) => events.push(['error', ...args]) },
    requestAnimationFrame() {}, setTimeout: time.setTimer, clearTimeout: time.clearTimer,
  });
  const defs = {
    './fonts.css': {}, './ui/menu.css': {},
    './ui/menu.js': { createMenu: () => menu },
    './launch.js': { launch, mark() {} },
    './preload.js': { preloadGame: () => events.push('network-prefetch'),
      gameFetched: async () => {}, refreshGameFiles: async () => {},
      warmMap: () => events.push('shader-warmup') },
    './maps.js': { GAMEMODES: [{ key: 'sandbox' }], mapOf: () => null,
      mapByKey: key => missingMap ? null : ({ key }), mapsFor: () => [{ key: 'fixture' }],
      DEFAULT_MAP: 'fixture', MOBILE_MAP: 'fixture' },
    './gpu/device.js': { probeWebGPU: () => suppliedProbe ?? Promise.resolve({ ok: true, adapter: {} }) },
    './bootRecovery.js': { BOOT_RETRY: '__boot_retry', bootModuleRecovery: () => null },
    './startupSafety.js': { loadSourceMapManifests: loader => loadSourceMapManifests(loader, time) },
    './world/import/localMap.js': { installLocalCrueltyMaps: async () => {} },
    './app.js': {},
  };
  const modules = new Map();
  async function load(specifier) {
    assert(specifier in defs, `unexpected module ${specifier}`);
    if (!modules.has(specifier)) {
      const entries = Object.entries(defs[specifier]);
      const mod = new vm.SyntheticModule(entries.map(([key]) => key), function () {
        for (const [key, value] of entries) this.setExport(key, value);
      }, { context, identifier: specifier });
      modules.set(specifier, mod);
      await mod.link(() => { throw new Error('synthetic module has no imports'); });
    }
    return modules.get(specifier);
  }
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const main = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.glob = () => ({}); },
    async importModuleDynamically(specifier) {
      imports.push(specifier);
      if (specifier === './app.js') { onImport(launch); if (appGate) await appGate; }
      const mod = await load(specifier); await mod.evaluate(); return mod;
    },
  });
  await main.link(load); await main.evaluate(); await turn();
  return { launch, time, events, error, buttons, imports };
}

test('menu opening does not import the game or warm shaders', async () => {
  const h = await mainHarness({ search: '' });
  assert(h.events.includes('network-prefetch'));
  assert(!h.events.includes('shader-warmup'));
  assert(!h.imports.includes('./app.js'));
  assert.equal(h.launch.gpu, null);
  assert.equal(h.time.jobs.size, 0);
});

test('slow adapter has no overall startup deadline or recovery UI', async () => {
  const probe = deferred(), h = await mainHarness({ probe: probe.promise });
  assert.equal(h.time.jobs.size, 0);
  h.time.fire(45000); await turn();
  assert.equal(h.launch.startupError, null);
  assert.equal(h.error.textContent, '');
  assert.equal(h.buttons.length, 0);
  assert(!h.events.some(e => Array.isArray(e) && ['assign', 'replace'].includes(e[0])));
  probe.resolve({ ok: true, adapter: {} }); await turn();
  assert(h.imports.includes('./app.js'));
  assert.equal(h.error.children.length, 0);
});

test('slow app download can finish normally without a forced restart or view override', async () => {
  const app = deferred();
  const h = await mainHarness({ appGate: app.promise });
  assert.equal(h.imports.filter(s => s === './app.js').length, 1);
  assert.equal(h.time.jobs.size, 0);
  h.time.fire(45000); await turn();
  assert.equal(h.launch.startupError, null);
  app.resolve(); await turn();
  h.launch.ready();
  assert.equal(h.launch.startupError, null);
  assert.equal(h.error.textContent, '');
  assert.equal(h.error.children.length, 0);
  assert.equal(h.imports.filter(s => s === './app.js').length, 1);
  assert(!h.events.some(e => Array.isArray(e) && ['assign', 'replace'].includes(e[0])));
});

test('successful boot stays ready; actual GPU failure keeps its diagnostic without fallback UI', async () => {
  const good = await mainHarness();
  good.launch.ready();
  assert.equal(good.time.jobs.size, 0);
  good.time.fire(45000);
  assert.equal(good.launch.startupError, null);
  const bad = await mainHarness();
  const failure = Object.assign(new Error('GPU shader compilation timed out: far view'), { name: 'GraphicsFailure' });
  bad.error.textContent = failure.message; // app.js displays this before launch.failed.
  bad.launch.failed(failure);
  assert.equal(bad.time.jobs.size, 0);
  assert.equal(bad.launch.startupError, failure);
  bad.launch.ready();
  assert.equal(bad.error.textContent, failure.message);
  assert.equal(bad.error.children.length, 0);
  assert.equal(bad.buttons.length, 0);
});

test('no-adapter diagnostic does not misidentify a supported browser as unsupported', async () => {
  const h = await mainHarness({ probe: Promise.resolve({ ok: false, reason: 'no-adapter', message: 'No adapter.' }) });
  assert.match(h.error.textContent, /does not identify why/);
  assert.match(h.error.textContent, /chrome:\/\/gpu/);
  assert(!h.imports.includes('./app.js'));
  assert.equal(h.time.jobs.size, 0);
});

test('missing map cannot silently start another map even when the installer resolves without an error', async () => {
  const h = await mainHarness({ search: '?map=paradise', missingMap: true });
  assert.match(h.error.textContent, /map "paradise" is unavailable/);
  assert(!h.imports.includes('./app.js'));
  assert.equal(h.time.jobs.size, 0);
});

test('network prefetch has no automatic GPU warm-up; cancelled app boot has late-completion checks', () => {
  const preload = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8');
  const automatic = preload.slice(preload.indexOf('export function preloadGame('), preload.indexOf('let device ='));
  assert.doesNotMatch(automatic, /warmMap\(|warmDevice\(/);
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert(app.indexOf('if (launch.startupError)') < app.indexOf('if (gpu.lost || gpu.failure)'));
  assert(app.indexOf('if (launch.startupError)') < app.indexOf('gpu = await (launch.gpu'));
  assert.match(app, /const renderer = await createThreeRenderer[^\n]+\nif \(launch.startupError\)/);
  assert.match(app, /const check = async \(\) => \{\n\s+if \(graphicsFailure \|\| launch.startupError\) return;/);
});

test('actual app device block refuses cancelled imports before creation and late devices before replacement', async () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('let gpu;'), end = app.indexOf('// The canvas is ours:', start);
  assert(start > 0 && end > start);
  const code = `(async () => { ${app.slice(start, end)} return gpu; })()`;
  const failure = new Error('Startup cancelled');
  let creates = 0;
  await assert.rejects(vm.runInNewContext(code, {
    launch: { startupError: failure }, createGpu: () => { creates++; },
  }), error => error === failure);
  assert.equal(creates, 0);
  const device = deferred(), stopped = [], launch = { startupError: null };
  const pending = vm.runInNewContext(code, { launch, createGpu: () => { creates++; return device.promise; } });
  assert.equal(creates, 1);
  launch.startupError = failure;
  device.resolve({ failure, fail: e => stopped.push(e) });
  await assert.rejects(pending, error => error === failure);
  assert.deepEqual(stopped, [failure]);
  assert.equal(creates, 1);
  const replacement = deferred(), nextLaunch = { startupError: null }, replacementsStopped = [];
  let requests = 0;
  const replacing = vm.runInNewContext(code, {
    launch: nextLaunch,
    createGpu: () => ++requests === 1 ? Promise.resolve({ lost: true, destroy() {} }) : replacement.promise,
  });
  await turn();
  assert.equal(requests, 2);
  nextLaunch.startupError = failure;
  replacement.resolve({ fail: e => replacementsStopped.push(e) });
  await assert.rejects(replacing, error => error === failure);
  assert.deepEqual(replacementsStopped, [failure]);
  assert.equal(requests, 2);
});

test('retired recovery parameter cannot disable source appearance; ordinary maps still exclude it', () => {
  const script = `
    import assert from 'node:assert/strict';
    globalThis.location = { search: '?gpuSafe=1' };
    const {SOURCE_APPEARANCE_ENABLED} = await import('./src/gfx/sourceAppearance.js');
    const {volumeFrag} = await import('./src/shaders/render.js');
    assert.equal(SOURCE_APPEARANCE_ENABLED, true);
    const g = {nx:128, ny:128, nz:128, sourceGrid:[136,61,148], sourceAppearance:true};
    assert.match(volumeFrag(g), /fn sourceWord/);
    assert.doesNotMatch(volumeFrag({...g, sourceAppearance:false}), /fn sourceWord|fn sourceTexture|fn sourceDiffuse/);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});
