// CPU check of batch 2, chemistry and cold (elements.js LIQUID_NITROGEN ...
// LITHIUM and their REACTIONS; react.js oxygen, carbon dioxide and caustic
// gas), run on the dock tiles' engine port (src/ui/tiles/engine.js), which
// runs the GPU passes' rules on a 2D slice. Each check sets up a small box,
// steps it and tests what the physics says should happen. Seeded, so a run
// repeats exactly.
// usage: node tools/chem-check.mjs [--verbose]
const SEED = 20261010;
const mulberry32 = (a) => () => {
  a = (a + 0x6D2B79F5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = mulberry32(SEED);   // before the engine captures it
const { World } = await import('../src/ui/tiles/engine.js');
const { E, ELEMENTS, K, REACTIONS } = await import('../src/elements.js');
const { PHYS } = await import('../src/physics.js');

const verbose = process.argv.includes('--verbose');
const GRAVITY = 0.025;               // the game's default (app.js)
const NX = 22, NY = 40;              // a tile's width, taller for gases to travel
const EL = (k) => ELEMENTS[E[k]];

const box = (nx = NX, ny = NY) => { const w = new World(nx, ny); w.gravity = GRAVITY; return w; };
const fill = (w, x0, x1, y0, y1, key, extra = {}) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) w.put(x, y, E[key], extra);
};
const steps = (w, n, each) => { for (let s = 0; s < n; s++) { each?.(w, s); w.step(); } };
const cells = (w, key) => { const out = []; for (let i = 0; i < w.id.length; i++) if (w.id[i] === E[key]) out.push(i); return out; };
const count = (w, key) => cells(w, key).length;
const meanY = (w, key) => { const c = cells(w, key); return c.reduce((s, i) => s + Math.floor(i / w.nx), 0) / Math.max(c.length, 1); };
const maxT = (w) => w.T.reduce((m, t) => Math.max(m, t), -Infinity);
const minT = (w, key) => cells(w, key).reduce((m, i) => Math.min(m, w.T[i]), Infinity);
const lifeOf = (w, key) => cells(w, key).reduce((s, i) => s + w.life[i], 0);
const census = (w) => {
  const c = {};
  for (const id of w.id) if (id !== E.EMPTY) c[ELEMENTS[id].key] = (c[ELEMENTS[id].key] ?? 0) + 1;
  return c;
};

const results = [];
function check(name, fn) {
  let ok = false, info = '';
  try { [ok, info] = fn(); } catch (e) { info = `threw: ${e.message}`; }
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
}

// ---- the table ----
const NEW = ['LIQUID_NITROGEN', 'SALT', 'SALTWATER', 'CO2', 'DRY_ICE', 'HYDROGEN', 'OXYGEN', 'CAUSTIC_GAS', 'LITHIUM'];
check('every new element is stable (6·cond/cap < 1) and has a desc', () => {
  const bad = NEW.filter((k) => !(6 * EL(k).cond / EL(k).cap < 1) || !EL(k).desc);
  return [bad.length === 0, bad.join(' ')];
});
check('densities order as measured', () => {
  const d = (k) => EL(k).dens;
  const order = [
    ['LIQUID_NITROGEN < WATER', d('LIQUID_NITROGEN') < d('WATER')],
    ['WATER < SALTWATER', d('WATER') < d('SALTWATER')],
    ['SALTWATER < SALT', d('SALTWATER') < d('SALT')],
    ['LITHIUM < OIL', d('LITHIUM') < d('OIL')],
    ['HYDROGEN < air', d('HYDROGEN') < d('EMPTY')],
    ['air < OXYGEN < CAUSTIC_GAS < CO2', d('EMPTY') < d('OXYGEN') && d('OXYGEN') < d('CAUSTIC_GAS') && d('CAUSTIC_GAS') < d('CO2')],
    ['heavy gases sink, hydrogen rises', EL('CO2').grav > 0 && EL('CAUSTIC_GAS').grav > 0 && EL('HYDROGEN').grav < 0],
  ];
  const bad = order.filter(([, ok]) => !ok).map(([n]) => n);
  return [bad.length === 0, bad.join('; ')];
});
check('reactions name real elements', () => {
  const keyOk = (k) => k === 'SAME' || k === '*' || k in E;
  const intoOk = (x) => (Array.isArray(x) ? x.every(([k]) => keyOk(k)) : keyOk(x));
  const bad = REACTIONS.filter((r) => !keyOk(r.a) || !keyOk(r.b) || !r.into.every(intoOk));
  return [bad.length === 0, bad.map((r) => `${r.a}+${r.b}`).join(' ')];
});

// ---- movement: heavy gases pool, hydrogen rises, lithium floats ----
check('carbon dioxide sinks and pools', () => {
  const w = box();
  fill(w, 4, 18, 30, 36, 'CO2');
  const n0 = count(w, 'CO2'), y0 = meanY(w, 'CO2');
  steps(w, 1500);
  const y1 = meanY(w, 'CO2');
  return [count(w, 'CO2') === n0 && y1 < y0 - 15, `mean height ${y0.toFixed(1)} → ${y1.toFixed(1)}`];
});
check('hydrogen rises', () => {
  const w = box();
  fill(w, 4, 18, 2, 8, 'HYDROGEN');
  const y0 = meanY(w, 'HYDROGEN');
  steps(w, 400);
  const y1 = meanY(w, 'HYDROGEN');
  return [y1 > y0 + 20, `mean height ${y0.toFixed(1)} → ${y1.toFixed(1)}`];
});
check('lithium floats up through oil', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 14, 'OIL');
  fill(w, 8, 14, 0, 2, 'LITHIUM');
  steps(w, 800);
  return [meanY(w, 'LITHIUM') >= 12, `lithium mean height ${meanY(w, 'LITHIUM').toFixed(1)}, oil top 13`];
});

// ---- oxygen feeds fire, carbon dioxide smothers it ----
const WOOD_LIT = 400;   // °C, past wood's ignition
const fireBox = (gas) => {
  const w = box(NX, 24);
  if (gas !== 'EMPTY') fill(w, 0, NX, 0, 24, gas);
  fill(w, 6, 16, 0, 4, 'WOOD');
  for (let x = 6; x < 16; x++) w.T[w.idx(x, 3)] = WOOD_LIT;
  return w;
};
const BURN_STEPS = 300;
check('fuel burns faster and hotter in oxygen', () => {
  const air = fireBox('EMPTY'), oxy = fireBox('OXYGEN');
  const l0 = lifeOf(air, 'WOOD');
  let Tair = 0, Toxy = 0;
  steps(air, BURN_STEPS, (w) => { Tair = Math.max(Tair, maxT(w)); });
  steps(oxy, BURN_STEPS, (w) => { Toxy = Math.max(Toxy, maxT(w)); });
  const used = (w) => l0 - lifeOf(w, 'WOOD');
  const ratio = used(oxy) / Math.max(used(air), 1e-9);
  return [ratio > 2 && Toxy > Tair + 100,
    `fuel used ×${ratio.toFixed(1)}, hottest ${Tair.toFixed(0)} → ${Toxy.toFixed(0)} °C`];
});
check('carbon dioxide smothers a fire', () => {
  const air = fireBox('EMPTY'), co2 = fireBox('CO2');
  const l0 = lifeOf(air, 'WOOD');
  steps(air, BURN_STEPS);
  steps(co2, BURN_STEPS);
  const used = (w) => l0 - lifeOf(w, 'WOOD');
  return [used(co2) < 0.05 * used(air) && count(co2, 'FIRE') === 0,
    `fuel used ${used(air).toFixed(2)} in air, ${used(co2).toFixed(2)} in CO₂; flames ${count(air, 'FIRE')} / ${count(co2, 'FIRE')}`];
});
check('flames go out in CO₂, not in air', () => {
  const FLAME_GAP = 3;   // cells between lone flames
  const run = (gas) => {
    const w = box(NX, 24);
    if (gas !== 'EMPTY') fill(w, 0, NX, 0, 24, gas);
    for (let y = 4; y < 20; y += FLAME_GAP) for (let x = 2; x < NX - 2; x += FLAME_GAP) w.put(x, y, E.FIRE);
    const n0 = count(w, 'FIRE');
    w.step();
    return [n0, count(w, 'FIRE')];
  };
  const [n0, inCO2] = run('CO2'), [, inAir] = run('EMPTY');
  return [inCO2 === 0 && inAir > n0 / 2, `${n0} lone flames: ${inAir} left in air, ${inCO2} in CO₂`];
});

// ---- caustic gas eats as acid does ----
check('caustic gas eats stone, not glass', () => {
  const run = (floor) => {
    const w = box(NX, 24);
    fill(w, 0, NX, 0, 3, floor);
    fill(w, 0, NX, 3, 10, 'CAUSTIC_GAS');
    const n0 = count(w, floor);
    steps(w, 600);
    return n0 - count(w, floor);
  };
  const stone = run('STONE'), glass = run('GLASS');
  return [stone > 5 && glass === 0, `stone eaten ${stone}, glass eaten ${glass}`];
});

// ---- phase changes and reactions (the shared mechanisms, el-core) ----
check('liquid nitrogen boils into cold air with a puff', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 1, 'METAL', { T: PHYS.AMBIENT });
  fill(w, 4, 18, 1, 4, 'LIQUID_NITROGEN');
  const n0 = count(w, 'LIQUID_NITROGEN');
  let puff = 0, coldAir = Infinity;
  steps(w, 600, (w) => {
    puff = Math.max(puff, w.P.reduce((m, p) => Math.max(m, p), 0));
    coldAir = Math.min(coldAir, minT(w, 'EMPTY'));
  });
  const n1 = count(w, 'LIQUID_NITROGEN');
  return [n1 < n0 && coldAir < -150 && puff > 0.1, `${n0} → ${n1} cells, coldest air ${coldAir.toFixed(0)} °C, puff ${puff.toFixed(2)}`];
});
check('liquid nitrogen poured on water freezes it', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 6, 'WATER');
  fill(w, 0, NX, 6, 12, 'LIQUID_NITROGEN');
  steps(w, 1500);
  return [count(w, 'ICE') > 0, `ice ${count(w, 'ICE')}, water ${count(w, 'WATER')}`];
});
check('salt dissolves into water; brine takes no more', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 8, 'WATER');
  fill(w, 8, 14, 10, 12, 'SALT');
  const s0 = count(w, 'SALT');
  steps(w, 1500);
  const sat = box(NX, 24);
  fill(sat, 0, NX, 0, 8, 'SALTWATER');
  fill(sat, 8, 14, 10, 12, 'SALT');
  steps(sat, 1500);
  return [count(w, 'SALTWATER') > 0 && count(w, 'SALT') < s0 && count(sat, 'SALT') === s0,
    `brine ${count(w, 'SALTWATER')}, salt ${s0} → ${count(w, 'SALT')}; in brine salt stays ${count(sat, 'SALT')}`];
});
const coldBrine = (T) => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 24, 'EMPTY', { T });
  fill(w, 0, NX, 0, 6, 'SALTWATER', { T });
  steps(w, 300, (w) => { for (let i = 0; i < w.T.length; i++) if (w.id[i] === E.EMPTY) w.T[i] = T; });
  return w;
};
check('saltwater stays liquid at −15 °C, freezes into ice and salt below −21.1 °C', () => {
  const warm = coldBrine(-15), cold = coldBrine(-40);
  return [count(warm, 'ICE') === 0 && count(cold, 'ICE') > 0 && count(cold, 'SALT') > 0,
    `at −15: ice ${count(warm, 'ICE')}; at −40: ice ${count(cold, 'ICE')}, salt ${count(cold, 'SALT')}`];
});
check('boiling saltwater leaves its salt behind', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 1, 'METAL');
  fill(w, 0, NX, 1, 5, 'SALTWATER');
  steps(w, 2000, (w) => { for (let x = 0; x < NX; x++) w.T[w.idx(x, 0)] = 600; });
  return [count(w, 'STEAM') + count(w, 'CLOUD') + count(w, 'WATER') > 0 && count(w, 'SALT') > 0,
    `steam ${count(w, 'STEAM')}, salt ${count(w, 'SALT')}, brine left ${count(w, 'SALTWATER')}`];
});
check('salt melts ice', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 4, 'ICE', { T: -5 });
  fill(w, 6, 16, 4, 6, 'SALT');
  steps(w, 1500);
  return [count(w, 'SALTWATER') > 0, `brine ${count(w, 'SALTWATER')}, ice left ${count(w, 'ICE')}`];
});
check('dry ice on a hot plate sublimes into CO₂', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 1, 'METAL');
  fill(w, 6, 16, 1, 3, 'DRY_ICE');
  steps(w, 2000, (w) => { for (let x = 0; x < NX; x++) w.T[w.idx(x, 0)] = 200; });
  return [count(w, 'CO2') > 0, `CO₂ ${count(w, 'CO2')}, dry ice left ${count(w, 'DRY_ICE')}`];
});
const h2o2 = (lit) => {
  const w = box(NX, 24);
  for (let y = 2; y < 10; y++) for (let x = 4; x < 18; x++) w.put(x, y, (x + y) % 2 ? E.HYDROGEN : E.OXYGEN);
  if (lit) w.put(10, 1, E.FIRE);
  return w;
};
check('hydrogen and oxygen sit together cold; a flame sets them off into hot steam', () => {
  const cold = h2o2(false), lit = h2o2(true);
  const h0 = count(cold, 'HYDROGEN');
  let hottest = 0;
  steps(cold, 60);
  steps(lit, 60, (w) => { hottest = Math.max(hottest, maxT(w)); });
  const left = count(cold, 'HYDROGEN') + count(cold, 'OXYGEN');
  return [left === 2 * h0 && count(lit, 'HYDROGEN') < h0 / 4 && count(lit, 'STEAM') > h0 / 2 && hottest > 1500,
    `cold: ${left}/${2 * h0} left; lit: hydrogen ${h0} → ${count(lit, 'HYDROGEN')}, steam ${count(lit, 'STEAM')}, hottest ${hottest.toFixed(0)} °C`];
});
check('a flame burns hydrogen with the air into steam', () => {
  const w = box(NX, 24);
  fill(w, 6, 16, 2, 6, 'HYDROGEN');
  w.put(11, 1, E.FIRE);
  const h0 = count(w, 'HYDROGEN');
  steps(w, 300);
  return [count(w, 'HYDROGEN') < h0 / 2, `hydrogen ${h0} → ${count(w, 'HYDROGEN')}, ${JSON.stringify(census(w))}`];
});
check('lithium in water fizzes off hydrogen and heat', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 8, 'WATER');
  fill(w, 8, 14, 9, 11, 'LITHIUM');
  const l0 = count(w, 'LITHIUM');
  let hydrogen = 0, hottest = 0;
  steps(w, 800, (w) => { hydrogen = Math.max(hydrogen, count(w, 'HYDROGEN')); hottest = Math.max(hottest, maxT(w)); });
  return [count(w, 'LITHIUM') < l0 && hydrogen > 0 && hottest > 100,
    `lithium ${l0} → ${count(w, 'LITHIUM')}, most hydrogen ${hydrogen}, hottest ${hottest.toFixed(0)} °C`];
});
check('caustic gas dissolves back into acid in water', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 4, 'WATER');
  fill(w, 0, NX, 4, 8, 'CAUSTIC_GAS');
  steps(w, 200);
  return [count(w, 'ACID') > 0, `acid ${count(w, 'ACID')}, gas left ${count(w, 'CAUSTIC_GAS')}`];
});
check('boiling acid gives off caustic gas and steam', () => {
  const w = box(NX, 24);
  fill(w, 0, NX, 0, 1, 'GLASS');
  fill(w, 0, NX, 1, 5, 'ACID');
  let gas = 0, steam = 0;
  steps(w, 2000, (w) => {
    for (let x = 0; x < NX; x++) w.T[w.idx(x, 0)] = 600;
    gas = Math.max(gas, count(w, 'CAUSTIC_GAS')); steam = Math.max(steam, count(w, 'STEAM'));
  });
  return [gas > 0 && steam > gas, `most caustic gas ${gas}, most steam ${steam}`];
});

if (verbose) console.log(JSON.stringify(results, null, 1));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
