// CPU check of the electricity (src/electricity.js) on the dock tiles' engine
// (ui/tiles/engine.js), which runs react.js's rules: small circuits in a
// side-on slice, timed step by step.
//   1. battery → metal wire → switch → metal wire: the spark reaches cell k of
//      the wire at step k, through the switch only while it is on
//   2. P-N junction: battery → P → N → metal passes, battery → N → P → metal stops at P
//   3. switch control: a spark in P beside the switch turns it on, one in N off
//   4. water: a spark reaches 3 cells into fresh water from a live wire, and Joule heating warms it, not the metal
//   5. temperature sensor: fires while something hotter touches it, and sparks its wire
//   6. the Spark tool sparks conductors only, and only ready ones
// usage: node tools/elec-check.mjs
import { E } from '../src/elements.js';
import { ELEC, SPARK_CYCLE, SPARK_COST, isLive, sparkOf } from '../src/electricity.js';
import { World } from '../src/ui/tiles/engine.js';

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

// a world with gravity off (solids don't care; water stays in its row)
const world = (nx, ny = 3) => { const w = new World(nx, ny); w.gravity = 0; return w; };
const live = (w, x, y) => isLive(w.id[w.idx(x, y)], w.ctype[w.idx(x, y)]);
// first step at which each listed cell is live (-1: never), over `steps` steps
function firstLive(w, cells, steps) {
  const first = cells.map(() => -1);
  for (let s = 1; s <= steps; s++) {
    w.step();
    cells.forEach(([x, y], k) => { if (first[k] < 0 && live(w, x, y)) first[k] = s; });
  }
  return first;
}

// 1. battery → wire → switch → wire
{
  const run = (switchOn) => {
    const w = world(24);
    w.put(0, 1, E.BATTERY);
    for (let x = 1; x <= 10; x++) w.put(x, 1, E.METAL);
    w.put(11, 1, E.SWITCH, { life: switchOn ? ELEC.SWITCH_ON : 0 });
    for (let x = 12; x <= 22; x++) w.put(x, 1, E.METAL);
    return firstLive(w, [1, 5, 10, 11, 12, 22].map((x) => [x, 1]), 40);
  };
  const on = run(true), off = run(false);
  check('wire: one cell a step from the battery, through an on switch', on.join() === [1, 5, 10, 11, 12, 22].join(), `first live at steps ${on}`);
  check('wire: an off switch stops it', off[2] === 10 && off[3] < 0 && off[4] < 0 && off[5] < 0, `first live at steps ${off}`);
  // the train of sparks a battery sends: live SPARK_LIFE steps in every SPARK_CYCLE
  const w = world(24);
  w.put(0, 1, E.BATTERY);
  for (let x = 1; x <= 22; x++) w.put(x, 1, E.METAL);
  let liveSteps = 0;
  const N = SPARK_CYCLE * 10;
  for (let s = 0; s < 30; s++) w.step();
  for (let s = 0; s < N; s++) { w.step(); if (live(w, 12, 1)) liveSteps++; }
  check('battery: a spark every SPARK_CYCLE steps, live SPARK_LIFE of them', liveSteps === 10 * ELEC.SPARK_LIFE, `${liveSteps} live steps in ${N}`);
}

// 2. the P-N junction
{
  const run = (a, b) => {
    const w = world(8);
    w.put(0, 1, E.BATTERY); w.put(1, 1, a); w.put(2, 1, b);
    for (let x = 3; x <= 6; x++) w.put(x, 1, E.METAL);
    return firstLive(w, [[1, 1], [2, 1], [6, 1]], 30);
  };
  const fwd = run(E.PSCN, E.NSCN), rev = run(E.NSCN, E.PSCN);
  check('junction: P → N conducts', fwd.join() === '1,2,6', `first live ${fwd}`);
  check('junction: N → P blocks', rev[0] === 1 && rev[1] < 0 && rev[2] < 0, `first live ${rev}`);
}

// 3. switch control: P beside a switch turns it on, N turns it off; switches go together
{
  const w = world(10, 4);
  // row 1: P (sparked by the tool) on x=1, switches x=2..4, metal after; row 2: N at x=3, above the switch
  w.put(1, 1, E.PSCN);
  for (let x = 2; x <= 4; x++) w.put(x, 1, E.SWITCH);
  for (let x = 5; x <= 8; x++) w.put(x, 1, E.METAL);
  w.put(3, 2, E.NSCN);
  w.spark(w.idx(1, 1));
  for (let s = 0; s < 6; s++) w.step();
  const onLives = [2, 3, 4].map((x) => w.life[w.idx(x, 1)]);
  check('switch: a live P turns it on, and on spreads through touching switches', onLives.every((l) => l === ELEC.SWITCH_ON), `lives ${onLives}`);
  // now a battery under the first switch: sparks pass through
  w.put(2, 0, E.BATTERY);
  const passed = firstLive(w, [[8, 1]], 20)[0];
  check('switch: on, it passes the battery\'s sparks', passed > 0, `metal at x=8 first live at step ${passed}`);
  for (let s = 0; s < SPARK_CYCLE * 2; s++) w.step();   // let the P rest
  w.spark(w.idx(3, 2));                                // N sparks
  for (let s = 0; s < 3 * ELEC.SWITCH_ON; s++) w.step();
  const offLives = [2, 3, 4].map((x) => w.life[w.idx(x, 1)]);
  let after = false;
  for (let s = 0; s < 30; s++) { w.step(); after ||= live(w, 8, 1); }
  check('switch: a live N turns them all off, and sparks stop', offLives.every((l) => l === 0) && !after, `lives ${offLives}, metal live after: ${after}`);
}

// 4. water: reach and Joule heating
{
  const w = world(16);
  w.put(0, 1, E.BATTERY);
  for (let x = 1; x <= 3; x++) w.put(x, 1, E.METAL);
  for (let x = 4; x <= 10; x++) w.put(x, 1, E.WATER);
  w.put(11, 1, E.WALL);
  for (let x = 0; x <= 11; x++) { w.put(x, 0, E.WALL); w.put(x, 2, E.WALL); }
  const reached = [4, 5, 6, 7, 8].map((x) => [x, 1]);
  let maxLevel = reached.map(() => 0);
  const T0 = [2, 4].map((x) => w.T[w.idx(x, 1)]);
  const STEPS = 400;
  for (let s = 0; s < STEPS; s++) {
    w.step();
    reached.forEach(([x, y], k) => { maxLevel[k] = Math.max(maxLevel[k], sparkOf(w.id[w.idx(x, y)], w.ctype[w.idx(x, y)])); });
  }
  const want = [0.75, 0.5, 0.25, 0, 0];
  const reach = maxLevel.filter((v) => v > 0).length;
  check('water: a spark reaches 3 cells in, losing a quarter of a full spark per cell',
    reach === 3 && maxLevel.every((v, k) => Math.abs(v - want[k]) < 1e-9), `strength by depth ${maxLevel.map((v) => v.toFixed(2))}`);
  const dMetal = w.T[w.idx(2, 1)] - T0[0], dWater = w.T[w.idx(4, 1)] - T0[1];
  check('Joule heating: water by the wire warms, the wire hardly', dWater > 1 && dMetal < dWater,
    `after ${STEPS} steps: water +${dWater.toFixed(2)} °C, metal +${dMetal.toFixed(3)} °C`);
  const saltReach = Math.ceil(ELEC.SPARK_V / (ELEC.SPARK_DROP / 5)) - 1;
  check('saltwater (σ = 5 S/m) would reach far', saltReach > 300, `${saltReach} cells; steel's cost per cell ${SPARK_COST[E.METAL].toExponential(1)}`);
}

// 5. temperature sensor
{
  const w = world(8, 4);
  w.put(1, 1, E.TSNS);
  for (let x = 2; x <= 6; x++) w.put(x, 1, E.METAL);
  w.put(1, 2, E.STONE, { T: 20 });   // at its temperature: nothing
  let quiet = true;
  for (let s = 0; s < 20; s++) { w.step(); quiet &&= !live(w, 6, 1); }
  w.T[w.idx(1, 2)] = 120;            // something hotter touches it
  const fired = firstLive(w, [[2, 1], [6, 1]], 20);
  check('sensor: quiet at its own temperature, fires when something hotter touches it', quiet && fired[0] === 2 && fired[1] === 6,
    `quiet before: ${quiet}; wire first live at steps ${fired} (fires, then sparks a step later)`);
  w.T[w.idx(1, 1)] = 200;            // heat the sensor past it: its threshold rises
  for (let s = 0; s < SPARK_CYCLE * 2; s++) w.step();
  let after = false;
  for (let s = 0; s < 30; s++) { w.step(); after ||= live(w, 2, 1); }
  check('sensor: heated past the stone, it stops', !after, `wire live after: ${after}; sensor kept ${w.T[w.idx(1, 1)].toFixed(1)} °C (it holds no heat flow)`);
}

// 6. the Spark tool
{
  const w = world(6);
  [E.METAL, E.WATER, E.STONE, E.SWITCH, E.INSULATOR].forEach((id, x) => w.put(x, 1, id));
  w.sparkBrush(3, 1.5, 4);
  const got = [0, 1, 2, 3, 4].map((x) => live(w, x, 1));
  check('Spark tool: metal and water spark; stone, an off switch and insulator don\'t', got.join() === 'true,true,false,false,false', `${got}`);
  const again = w.spark(w.idx(0, 1));
  check('Spark tool: a live cell can\'t be sparked again', !again);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
