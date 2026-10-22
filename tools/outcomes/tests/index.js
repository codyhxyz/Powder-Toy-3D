// Every outcome test, in run order, and the groups `--group` selects
// (tools/outcomes.mjs). A test: { name, key (its OUTCOMES row, default name),
// group, title, size, needs (element names), kind ('harness', the default: a
// bare simulation in tools/harness/outcomes.html; 'app': the game at `url`),
// cost (wall seconds of today's engine on SwiftShader, to batch browser runs
// under ~3 minutes), expressible(engine) → why not, or null, run(engine, ctx) →
// { criteria, headline, evidence, numbers } }.
import liquids from './liquids.js';
import solids from './solids.js';
import fire from './fire.js';
import blasts from './blasts.js';
import world from './world.js';
import census from './census.js';
import radial from './radial.js';
import movement from './movement.js';

export const TESTS = [...liquids, ...solids, ...fire, ...blasts, ...world, ...census, ...radial, ...movement];

export const GROUPS = {};
for (const t of TESTS) (GROUPS[t.group] ??= []).push(t.name);

/** The tests named (a comma list) or in the groups named; all when neither. */
export function select({ tests = '', groups = '' } = {}) {
  const want = new Set(tests.split(',').filter(Boolean));
  const gs = groups.split(',').filter(Boolean);
  for (const g of gs) { if (!GROUPS[g]) throw new Error(`no group ${g} (have: ${Object.keys(GROUPS).join(', ')})`); for (const n of GROUPS[g]) want.add(n); }
  for (const n of want) if (!TESTS.some((t) => t.name === n)) throw new Error(`no test ${n} (have: ${TESTS.map((t) => t.name).join(', ')})`);
  return want.size ? TESTS.filter((t) => want.has(t.name)) : TESTS;
}

export const byName = (name) => TESTS.find((t) => t.name === name);
