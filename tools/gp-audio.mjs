// Headless check of POV sound (src/pov/audio.js): drop in, then emit every
// POV event and read the audio module's own stats() to see which sound played,
// where, how loud and at what pitch. Also: the voice pools cap, the underwater
// low-pass engages, POV-off and a hidden tab mute, and every preset renders
// (OfflineAudioContext) neither silent nor clipped. The body's own events
// (land, splash, hurt, death) come from real falls in a small test world.
// usage: node tools/gp-audio.mjs [--port 5204]   (needs a dev server)
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5204');
const W = 960, H = 600;

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [], warns = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 600));
  if (m.type() === 'warning' && /audio/i.test(m.text())) warns.push(m.text().slice(0, 300));
});
// the app's own module instances: after an edit vite serves them as path?t=…, a separate copy
await p.addInitScript(() => performance.setResourceTimingBufferSize(10000));
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 1000)));
await p.goto(`http://localhost:${port}/?preset=empty&size=128`);
await p.waitForFunction(() => window.__app?.pov && window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);

// A test world: a rock floor, a lake (x < 60) held back by a wall, dry land beyond.
await ev(async () => {
  const a = window.__app, sim = a.sim, g = sim.g;
  const { E } = await import('/src/elements.js');
  const LAVA_T = 1400;   // °C
  const [A, B] = sim.blankState();
  const set = (x, y, z, id) => {
    const i = sim.cellTexel(x, y, z) * 4;
    A[i] = id; A[i + 1] = id === E.LAVA ? LAVA_T : 20;
  };
  for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) {
    for (let y = 0; y < 2; y++) set(x, y, z, E.ROCK);
    if (x < 60) for (let y = 2; y < 18; y++) set(x, y, z, E.WATER);
    if (x === 60) for (let y = 2; y < 22; y++) set(x, y, z, E.WALL);
    // a walled lava pit in one corner
    const pit = x >= 100 && x < 122 && z >= 100 && z < 122, rim = pit && (x === 100 || x === 121 || z === 100 || z === 121);
    if (rim) for (let y = 2; y < 10; y++) set(x, y, z, E.WALL);
    else if (pit) for (let y = 2; y < 6; y++) set(x, y, z, E.LAVA);
  }
  sim.load(A, B);
  const url = (path) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => new URL(n).pathname === path).pop() ?? path;
  window.AU = await import(url('/src/pov/audio.js'));
  window.PE = (await import(url('/src/pov/events.js'))).povEvents;
  window.V3 = a.camera.position.constructor;
  window.EL = E;
  // the body's own sounds, which can land in any window while it settles
  window.BODY = new Set(['land', 'splashBig', 'hurtThud', 'hurtBurn', 'hurtAcid', 'hurtFrost', 'hurtDrown', 'death']);
});

// before POV: nothing starts
await p.mouse.move(W * 0.75, H * 0.6);
await wait(300);
check('silent before POV', !(await ev(() => AU.stats().started)));

// drop in (the F press is the gesture), then a click in POV
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
await ev(() => { window.__app.pov.test.assumeLocked = true; });
await p.mouse.click(W / 2, H / 2);
await p.waitForFunction(() => AU.stats().started, null, { timeout: 10000 }).catch(() => {});
await p.waitForFunction(() => AU.stats().presetsBuilt === AU.stats().presets, null, { timeout: 10000 }).catch(() => {});
let st = await ev(() => AU.stats());
check('started on a gesture in POV', st.started && st.context === 'running', `${st.context} ${st.sampleRate} Hz`);
check('every preset rendered', st.presetsBuilt === st.presets, `${st.presetsBuilt}/${st.presets} presets, ${st.buffers} buffers`);
check('master up in POV', st.master > 0, String(st.master));
const listenerOnCamera = await ev(() => window.__app.camera.children.some((c) => c.type === 'AudioListener'));
check('listener on the POV camera', listenerOnCamera);

// stand on dry land
await ev(() => { const pl = window.__app.pov.player; pl.spawn(new V3(96.5, 2, 64.5)); });
await p.waitForFunction(() => window.__app.pov.player.onGround, null, { timeout: 5000 }).catch(() => {});
await wait(400);

// emit fn(), return the plays it caused (names, in order)
const plays = (fn, arg) => ev(async ([src, arg]) => {
  const before = AU.stats().seq;
  (0, eval)(`(${src})`)(arg);
  await new Promise((r) => setTimeout(r, 30));
  return AU.stats().last.filter((x) => x.seq > before && !x.loop && !BODY.has(x.name));
}, [fn.toString(), arg]);
const names = (list) => list.map((x) => x.name).join(',');

// -- the gun
let r = await plays(() => PE.emit('gun:fire', { origin: new V3(96, 7, 64), dir: new V3(1, 0, 0) }));
check('gun:fire → shot, thump, delayed echo', names(r) === 'shot,shotThump,shotEcho' && r[2].delay > 0.1 && r.every((x) => !x.at), JSON.stringify(r.map((x) => [x.name, x.delay])));
r = await plays(() => PE.emit('gun:dry', {}));
check('gun:dry → click', names(r) === 'dryClick');

// -- impacts by material
const impact = (id, extra = {}) => plays(([id, extra]) => PE.emit('impact', {
  source: 'gun', point: new V3(...(extra.at ?? [100, 4, 64])), normal: new V3(0, 1, 0), id: EL[id], energy: extra.energy ?? 39, broke: extra.broke ?? null,
}), [id, extra]);
const families = {
  GLASS: 'shatter', SHARDS: 'shatter', WOOD: 'thunk', SAWDUST: 'thunk', PLANT: 'thunk', METAL: 'ping', SCRAP: 'ping',
  ROCK: 'crack', STONE: 'crack', ICE: 'crack', SAND: 'puff', SNOW: 'puff', GUNPOWDER: 'puff', WATER: 'splash', OIL: 'splash', LAVA: 'sizzle',
};
const rates = {};
let k = 0;
for (const [id, want] of Object.entries(families)) {
  r = await impact(id, { at: [100 + (k++ % 5) * 3, 4, 64] });
  rates[id] = r[0]?.rate;
  check(`impact ${id} → ${want}`, names(r) === want, `rate ${r[0]?.rate} gain ${r[0]?.gain} at ${r[0]?.at} delay ${r[0]?.delay}`);
}
r = await impact('WATER', { energy: 1 });
check('soft impact on water → plop', names(r) === 'plop');
r = await impact('GLASS', { broke: true });
check('broke → crunch layer', names(r) === 'shatter,crunch');
r = await impact('METAL', { broke: false });
check('gun glancing off metal → ping + ricochet', names(r) === 'ping,ricochet');
r = await plays(() => PE.emit('impact', { source: 'axe', point: new V3(100, 4, 60), id: EL.METAL, energy: 10, broke: false }));
check('axe on metal: no ricochet', names(r) === 'ping');
r = await impact('EMPTY');
check('impact on air: silent', r.length === 0);
// pitch follows hardness (within a family), loudness follows energy
const ratesNoJitter = await ev(() => ({ PLANT: AU.materialRate(EL.PLANT, 'thunk'), WOOD: AU.materialRate(EL.WOOD, 'thunk'), ICE: AU.materialRate(EL.ICE, 'crack'), ROCK: AU.materialRate(EL.ROCK, 'crack'), SCRAP: AU.materialRate(EL.SCRAP, 'ping') }));
check('softer solid plays lower', ratesNoJitter.PLANT < ratesNoJitter.WOOD && ratesNoJitter.ICE < ratesNoJitter.ROCK, JSON.stringify(ratesNoJitter));
const lo = (await impact('ROCK', { energy: 4, at: [110, 4, 70] }))[0], hi = (await impact('ROCK', { energy: 60, at: [110, 4, 74] }))[0];
check('more energy, louder', hi.gain > lo.gain, `${lo.gain} → ${hi.gain}`);
// positional: placed at the hit, late by the speed of sound
const far = (await impact('ROCK', { at: [10, 4, 10] }))[0], near = (await impact('ROCK', { at: [98, 4, 64] }))[0];
check('far hits arrive later', far.at && far.delay > near.delay && far.delay > 0.05, `near ${near.delay}s far ${far.delay}s`);

// -- tools
const tool = (payload) => plays((pl) => PE.emit('tool:action', { ...pl, id: pl.id == null ? undefined : EL[pl.id], point: pl.point ? new V3(...pl.point) : undefined }), payload);
r = await tool({ tool: 'shovel', action: 'dig', id: 'SAND', point: [98, 2, 64], amount: 20 });
check('shovel dig sand → scrape', names(r) === 'shovelScrape');
r = await tool({ tool: 'shovel', action: 'dig', id: 'WOOD', point: [98, 2, 66], amount: 10 });
check('shovel dig wood → scrape + thunk', names(r) === 'shovelScrape,thunk');
r = await tool({ tool: 'shovel', action: 'dump', id: 'SHARDS', point: [98, 2, 62], amount: 20 });
check('shovel dump shards → dump + shatter', names(r) === 'shovelDump,shatter');
r = await tool({ tool: 'shovel', action: 'refuse', id: 'WALL' });
check('refuse → clunk', names(r) === 'refuse');
r = await tool({ tool: 'bucket', action: 'scoop', id: 'WATER', amount: 12 });
check('bucket scoop → scoop', names(r) === 'bucketScoop');
// the bucket reports a pour every frame or two while the button is held
const pour = await ev(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const seen = [];
  for (let i = 0; i < 12; i++) {
    PE.emit('tool:action', { tool: 'bucket', action: 'pour', id: EL.WATER, amount: 2 });
    await frame();
    seen.push([AU.stats().loops.pourLoop, Math.round(performance.now())]);
  }
  await new Promise((r) => setTimeout(r, 600));
  await frame();
  return { during: seen.every((x) => x[0]), after: AU.stats().loops.pourLoop, seen: JSON.stringify(seen) };
});
check('pour loops while pouring, stops after', pour.during && !pour.after, JSON.stringify(pour));
r = await tool({ tool: 'axe', action: 'swing' });
check('axe swing → swoosh', names(r) === 'swoosh');
const phys = await ev(() => {
  PE.emit('tool:action', { tool: 'physgun', action: 'grab', point: new V3(100, 4, 64) });
  const on = AU.stats();
  PE.emit('tool:action', { tool: 'physgun', action: 'release' });
  const off = AU.stats();
  return { grab: on.last.slice(-2).map((x) => x.name).join(), humOn: on.loops.physHum, release: off.last.at(-1).name, humOff: !off.loops.physHum };
});
check('physgun grab → zap + hum, release → blip, hum off', phys.grab === 'physGrab,physHum' && phys.humOn && phys.release === 'physRelease' && phys.humOff, JSON.stringify(phys));
await tool({ tool: 'physgun', action: 'grab' });
r = await tool({ tool: 'physgun', action: 'fling' });
check('physgun fling → fling, hum off', names(r) === 'physFling' && !(await ev(() => AU.stats().loops)).physHum);
// a grab the physgun doesn't confirm (it isn't even selected): the hum gives up
await tool({ tool: 'physgun', action: 'grab' });
await wait(600);
check('hum stops when the physgun holds nothing', !(await ev(() => AU.stats().loops)).physHum);

// -- the body
r = await plays(() => PE.emit('player:step', { speed: 6, inLiquid: false }));
check('step → step', names(r) === 'step', `gain ${r[0]?.gain}`);
r = await plays(() => PE.emit('player:step', { speed: 3, inLiquid: true }));
check('step in liquid → wet step', names(r) === 'stepWet');

const since = () => ev(() => AU.stats().seq);
const playedSince = (n) => ev((n) => AU.stats().last.filter((x) => x.seq > n).map((x) => x.name), n);
let n0 = await since();
await ev(() => window.__app.pov.player.spawn(new V3(96.5, 9, 64.5)));
await p.waitForFunction(() => window.__app.pov.player.onGround, null, { timeout: 5000 }).catch(() => {});
await wait(200);
let got = await playedSince(n0);
check('a short drop → land', got.includes('land'), got.join(','));

n0 = await since();
await ev(() => window.__app.pov.player.spawn(new V3(30.5, 24, 64.5)));
await p.waitForFunction(() => window.__app.pov.player.headInLiquid, null, { timeout: 6000 }).catch(() => {});
await wait(400);
got = await playedSince(n0);
st = await ev(() => AU.stats());
check('falling into the lake → splash', got.includes('splashBig'), got.join(','));
check('head under → low-pass engaged', st.underwater && st.filterHz < 1000 && st.filterNowHz < 1500, `target ${st.filterHz} Hz, now ${st.filterNowHz} Hz`);
await ev(() => window.__app.pov.player.spawn(new V3(96.5, 2, 64.5)));
await wait(500);
st = await ev(() => AU.stats());
check('out of the water → filter open', !st.underwater && st.filterNowHz > 10000, `now ${st.filterNowHz} Hz`);

n0 = await since();
await ev(() => window.__app.pov.player.spawn(new V3(80.5, 45, 30.5)));
await p.waitForFunction((n) => AU.stats().last.some((x) => x.seq > n && x.name === 'land'), n0, { timeout: 20000 }).catch(() => {});
await wait(400);
got = await playedSince(n0);
check('a hard fall → land + hurt thud', got.includes('land') && got.includes('hurtThud'), got.join(','));

n0 = await since();
await ev(() => window.__app.pov.player.spawn(new V3(110.5, 2, 110.5)));
await p.waitForFunction(() => window.__app.pov.player.dead, null, { timeout: 15000 }).catch(() => {});
await wait(300);
got = await playedSince(n0);
check('walking into lava → burn + death', got.includes('hurtBurn') && got.includes('death'), `${got.join(',')} (${await ev(() => window.__app.pov.player.cause)})`);
await p.waitForFunction(() => !window.__app.pov.player.dead && window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});

// -- pooling: a burst of 40 hits across the world
st = await ev(() => {
  const before = AU.stats().stolen;
  for (let i = 0; i < 40; i++) PE.emit('impact', { source: 'gun', point: new V3(70 + i, 4, 40 + i), id: EL.ROCK, energy: 39, broke: true });
  const s = AU.stats();
  return { ...s, stolenNow: s.stolen - before };
});
check('positional voices capped', st.voices.positional <= st.voices.maxPositional && st.stolenNow > 0, `${st.voices.positional}/${st.voices.maxPositional} playing, ${st.stolenNow} cut`);
// a dozen shots 30 ms apart: 36 of your own sounds, most still ringing
st = await ev(async () => { for (let i = 0; i < 12; i++) { PE.emit('gun:fire', {}); await new Promise((r) => setTimeout(r, 30)); } return AU.stats(); });
check('flat voices capped', st.voices.flat <= st.voices.maxFlat, `${st.voices.flat}/${st.voices.maxFlat}`);

// -- every preset renders neither silent nor clipped (OfflineAudioContext)
const render = await ev(async () => {
  const out = {};
  for (const name of AU.PRESET_NAMES) {
    const bufs = AU.debugBuffers(name);
    let peak = 0, rms = 0;
    for (const buf of bufs) {
      const oc = new OfflineAudioContext(1, buf.length, buf.sampleRate);
      const src = oc.createBufferSource();
      src.buffer = buf;
      src.connect(oc.destination);
      src.start();
      const d = (await oc.startRendering()).getChannelData(0);
      let pk = 0, sq = 0;
      for (let i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); sq += d[i] * d[i]; }
      peak = Math.max(peak, pk); rms += Math.sqrt(sq / d.length) / bufs.length;
    }
    out[name] = { peak: +peak.toFixed(3), rms: +rms.toFixed(4), variants: bufs.length, seconds: +(bufs[0].duration).toFixed(2) };
  }
  return out;
});
const bad = Object.entries(render).filter(([, m]) => m.peak > 0.95 || m.peak < 0.1 || m.rms < 0.01);
check('every preset renders, none silent or clipped', bad.length === 0, bad.length ? JSON.stringify(bad) : `${Object.keys(render).length} presets`);
console.log('  shot:', JSON.stringify(render.shot), ' step:', JSON.stringify(render.step), ' physHum:', JSON.stringify(render.physHum));

// -- mute: hidden tab, then POV off
st = await ev(async () => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  const hidden = AU.stats().master;
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 100));
  return { hidden, shown: AU.stats().master };
});
check('hidden tab mutes, visible unmutes', st.hidden === 0 && st.shown > 0, JSON.stringify(st));
await ev(() => window.__app.pov.exit(true));
await wait(400);
st = await ev(() => AU.stats());
check('POV off → muted', st.master === 0);
r = await plays(() => PE.emit('gun:fire', {}));
check('no sounds outside POV', r.length === 0);

check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
if (warns.length) console.log('audio warnings:', warns.slice(0, 5).join(' | '));
await b.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
