// The console's API registry (docs/console.md): every function and value the
// scripting console exposes is registered here, by table (sim, tpt, elem, ui,
// event or a new one) and name, the way The Powder Toy's Lua interface fills
// its tables (src/lua/LuaSimulation.cpp, LuaMisc.cpp, LuaElements.cpp: one
// luaL_Reg list per table). The built-ins (console/api.js) use it, and so can
// any other feature, without loading the console:
//
//   import { registerConsoleApi } from './console/registry.js';
//   registerConsoleApi('sim', 'loadStamp', (name, x, y, z) => { ... },
//     { args: 'name, x, y, z', doc: 'Places a saved stamp.', writes: true });
//
// Functions take and return plain JS values: numbers, strings, booleans, null
// (Lua's nil), arrays (Lua sequences) and plain objects (Lua tables). Return
// multi(a, b, c) for several results (Lua's multiple returns). Throw an Error
// to raise a Lua error with its message. While a function runs, `this` is the
// call's context (use a `function`, not an arrow, to read it):
//   this.mode    'command' (typed at the console) or 'event' (a tick handler)
//   this.log(s)  print a line to the console
// meta:
//   args    the argument list shown by help(), e.g. 'x, y, z[, value]'
//   doc     one line for help() and docs/console.md
//   writes  true if it changes the world or settings: refused for a
//           multiplayer guest (scripts run on the host only)
// This module has no dependencies, so registering costs nothing.

const tables = new Map();   // table name → Map(name → entry)
const listeners = new Set();

const MULTI = Symbol('multi');
export const multi = (...values) => ({ [MULTI]: values });
export const multiValues = (v) => (v && typeof v === 'object' && MULTI in v ? v[MULTI] : null);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function table(name) {
  if (!NAME.test(name)) throw new Error(`Console table name ${JSON.stringify(name)} must be a Lua identifier`);
  let t = tables.get(name);
  if (!t) tables.set(name, (t = new Map()));
  return t;
}

function put(tableName, name, entry) {
  if (!NAME.test(name) && !/^[A-Za-z_][\w-]*$/.test(name)) throw new Error(`Console name ${JSON.stringify(name)} is not a valid key`);
  table(tableName).set(name, { table: tableName, name, ...entry });
  for (const fn of listeners) fn(tableName, name);
}

// A function: table.name(...) in Lua. Registering a name again replaces it.
export function registerConsoleApi(tableName, name, fn, meta = {}) {
  if (typeof fn !== 'function') throw new Error(`registerConsoleApi(${tableName}.${name}): not a function`);
  put(tableName, name, { kind: 'fn', fn, args: meta.args ?? '', doc: meta.doc ?? '', writes: !!meta.writes });
}

// A constant: table.name in Lua (a number, string or boolean).
export function registerConsoleValue(tableName, name, value, meta = {}) {
  put(tableName, name, { kind: 'value', value, doc: meta.doc ?? '' });
}

export const consoleEntry = (tableName, name) => tables.get(tableName)?.get(name) ?? null;

// Every table and its entries, in registration order.
export const consoleTables = () => [...tables].map(([name, entries]) => ({ name, entries: [...entries.values()] }));

// Called with (table, name) whenever something is registered (the Lua bridge
// adds late registrations to a running console).
export function onConsoleRegister(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
