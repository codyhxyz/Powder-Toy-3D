import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import { consoleTables, onConsoleRegister, multiValues } from './registry.js';

// The console's Lua: fengari (a Lua 5.3 VM in JavaScript, MIT), loaded only
// when the console first opens (console/index.js imports this lazily). The
// tables come from the registry (console/registry.js); event.register and the
// time limits live here.
//
// What typed code may reach: Lua's base library, string, table, math, utf8,
// coroutine and os.time/clock/date, plus the registry's tables. No io, no
// require/dofile/loadfile (fengari would fetch files over the network with
// them), no debug (debug.sethook would lift the time limit), no os.exit.
//
// Every run has a deadline, checked by a count hook every HOOK_EVERY Lua
// instructions: a typed command gets COMMAND_LIMIT_MS, one event handler call
// HANDLER_LIMIT_MS. Past it the chunk errors (and every instruction after
// errors too, so a pcall can't swallow it). A handler that errors or runs over
// is unregistered, with a message.

// TPT's event types (src/lua/LuaEvent.cpp: event.TICK, BEFORESIM, AFTERSIM;
// the compatibility layer adds event.tick and friends). The numbers are ours.
export const EVENTS = { TICK: 0, BEFORESIM: 1, AFTERSIM: 2 };
export const COMMAND_LIMIT_MS = 5000;   // as long as a construction's code may run (constructions/runtime.js EXEC_TIMEOUT_MS)
export const HANDLER_LIMIT_MS = 20;     // one handler call: past this it is removed
const HOOK_EVERY = 1000;                // Lua instructions between deadline checks
const MAX_TABLE_DEPTH = 8;              // Lua tables passed to JS: nesting kept
const MAX_TABLE_KEYS = 100000;          // and keys per table

const LUA_PRELUDE = `
-- TPT's compatibility layer (src/lua/luascripts/compat.lua), in 3D
sim, tpt, elem, ui = sim or {}, tpt or {}, elem or {}, ui or {}
print = tpt.log or print
event.tick, event.beforesim, event.aftersim = event.TICK, event.BEFORESIM, event.AFTERSIM
evt, simulation, elements, interface = event, sim, elem, ui
function tpt.register_step(f) event.register(event.tick, f) end
function tpt.unregister_step(f) event.unregister(event.tick, f) end
local function fake_boolean_wrapper(func, true_is_1)
  return function(param)
    if not param then return func() and 1 or 0 end
    local enable
    if true_is_1 then enable = param == 1 else enable = param ~= 0 end
    func(enable)
  end
end
tpt.set_pause = tpt.set_pause or fake_boolean_wrapper(sim.paused, false)
function tpt.toggle_pause() sim.paused(not sim.paused()) return tpt.set_pause() end
function sim.parts()
  local i = -1
  return function() i = sim.partNext(i) return i end
end
function tpt.element(thing)
  if type(thing) == "string" then
    local id = elem.getByName(thing)
    if id == -1 then error("Unrecognised element " .. thing, 2) end
    return id
  end
  return elem.property(thing, "Name")
end
function tpt.create(x, y, z, thing)
  if type(thing) ~= "number" then thing = tpt.element(thing or "dust") end
  return sim.partCreate(-1, x, y, z, thing)
end
function tpt.delete(x, y, z)
  if y then
    local id = sim.partID(x, y, z)
    if id then sim.partKill(id) end
    return
  end
  sim.partKill(x)
end
-- (prop, value, i) or (prop, value, x, y, z); a value may be an element name
function tpt.set_property(prop, value, x, y, z)
  if type(value) == "string" then value = tpt.element(value) end
  local i = x
  if z then i = sim.partID(x, y, z) end
  if i then sim.partProperty(i, prop, value) end
end
function tpt.get_property(prop, x, y, z)
  local i = x
  if z then i = sim.partID(x, y, z) elseif not sim.partExists(x) then i = nil end
  if i then
    if prop == "id" then return i end
  elseif prop == "type" then
    return 0
  end
  return i and sim.partProperty(i, prop)
end
setmetatable(sim, { __index = function(_, k)
  local nx, ny, nz = sim.size()
  if k == "XRES" then return nx elseif k == "YRES" then return ny elseif k == "ZRES" then return nz
  elseif k == "NUM_PARTS" then return sim.partCount() end
end })
setmetatable(tpt, {
  __index = function(_, k)
    if k == "selectedl" then return ui.activeTool(0)
    elseif k == "brushx" or k == "brushy" or k == "brushz" then return ui.brushRadius()
    elseif k == "brushID" then return ui.brushID() end
  end,
  __newindex = function(t, k, v)
    if k == "selectedl" then ui.activeTool(0, v)
    elseif k == "brushx" or k == "brushy" or k == "brushz" then ui.brushRadius(v)
    elseif k == "brushID" then ui.brushID(v)
    else rawset(t, k, v) end
  end,
})
`;

// What a Lua value at idx is in JS: nil → null; tables → arrays (1..n) or
// plain objects; functions and the rest → null.
function toJs(L, idx, depth = 0) {
  switch (lua.lua_type(L, idx)) {
    case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, idx);
    case lua.LUA_TNUMBER: return lua.lua_tonumber(L, idx);
    case lua.LUA_TSTRING: return lua.lua_tojsstring(L, idx);
    case lua.LUA_TTABLE: {
      if (depth >= MAX_TABLE_DEPTH) return null;
      idx = lua.lua_absindex(L, idx);
      const obj = {};
      let n = 0, seq = true;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, idx)) {
        if (++n > MAX_TABLE_KEYS) { lua.lua_pop(L, 2); break; }
        const k = lua.lua_type(L, -2) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -2) : lua.lua_type(L, -2) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -2) : null;
        if (k !== null) obj[k] = toJs(L, -1, depth + 1);
        if (typeof k !== 'number') seq = false;
        lua.lua_pop(L, 1);
      }
      if (seq) {
        const keys = Object.keys(obj).map(Number);
        if (keys.every((k, i) => k === i + 1)) return keys.map((k) => obj[k]);
      }
      return obj;
    }
    default: return null;
  }
}

function pushJs(L, v, depth = 0) {
  if (v == null) lua.lua_pushnil(L);
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) lua.lua_pushinteger(L, v);
    else lua.lua_pushnumber(L, v);
  } else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
  else if (Array.isArray(v) && depth < MAX_TABLE_DEPTH) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((x, i) => { pushJs(L, x, depth + 1); lua.lua_rawseti(L, -2, i + 1); });
  } else if (typeof v === 'object' && depth < MAX_TABLE_DEPTH) {
    lua.lua_createtable(L, 0, 0);
    for (const [k, x] of Object.entries(v)) { pushJs(L, x, depth + 1); lua.lua_setfield(L, -2, to_luastring(k)); }
  } else lua.lua_pushnil(L);
}

// Raise a Lua error with message msg and the caller's position (luaL_error
// without its format codes, so a % in msg is safe).
function raise(L, msg) {
  lauxlib.luaL_where(L, 1);
  lua.lua_pushstring(L, to_luastring(String(msg)));
  lua.lua_concat(L, 2);
  return lua.lua_error(L);
}

// log(text, kind): kind 'out' | 'error' | 'info'. now(): ms.
export function createLua({ log, now = () => performance.now() }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const ctx = { mode: 'command', log: (s) => log(String(s), 'out') };
  const handlers = Object.values(EVENTS).map(() => []);   // per event type: registry refs
  let deadline = Infinity, pending = '';
  // A typed command runs as a coroutine: a read that waits for the GPU yields
  // it (console/gpu.js), run and resume return { wait }, and the console
  // resumes it once the read is in. left: its time limit's remainder (the
  // wait doesn't count).
  let command = null, waiting = null, left = 0;

  // JS errors inside Lua (a too-long string.rep...) become Lua errors
  lua.lua_atnativeerror(L, (L1) => {
    const e = lua.lua_touserdata(L1, 1);
    lua.lua_pushstring(L1, to_luastring(String(e?.message ?? e)));
    return 1;
  });

  // (hooks are per thread: L's for handlers, the command's coroutine's, a script's own coroutines')
  const hook = (L1) => {
    if (now() <= deadline) return;
    lua.lua_sethook(L1, hook, lua.LUA_MASKCOUNT, 1);
    raise(L1, `stopped: ran longer than ${ctx.mode === 'command' ? COMMAND_LIMIT_MS : HANDLER_LIMIT_MS} ms`);
  };
  const arm = (ms, L1 = L) => {
    deadline = now() + ms;
    lua.lua_sethook(L1, hook, lua.LUA_MASKCOUNT, HOOK_EVERY);
  };
  lua.lua_sethook(L, hook, lua.LUA_MASKCOUNT, HOOK_EVERY);
  // pcall and xpcall as lbaselib.js has them, but marking the call's
  // CIST_OAH bit (lstate.js) first: fengari's recover() (ldo.js) restores a
  // coroutine's allowhook from that bit, which its lua_pcallk never sets, so
  // once a pcall in the command's coroutine caught an error that coroutine's
  // hooks would stay off, and with them the time limit. With the bit set,
  // recovery leaves hooks on, as Lua's own setoah does.
  const CIST_OAH = 1 << 0;
  const finishpcall = (L1, status, extra) => {
    if (status !== lua.LUA_OK && status !== lua.LUA_YIELD) {
      lua.lua_pushboolean(L1, 0);
      lua.lua_pushvalue(L1, -2);
      return 2;
    }
    return lua.lua_gettop(L1) - extra;
  };
  lua.lua_pushcfunction(L, (L1) => {
    lauxlib.luaL_checkany(L1, 1);
    lua.lua_pushboolean(L1, 1);
    lua.lua_insert(L1, 1);
    L1.ci.callstatus |= CIST_OAH;
    return finishpcall(L1, lua.lua_pcallk(L1, lua.lua_gettop(L1) - 2, lua.LUA_MULTRET, 0, 0, finishpcall), 0);
  });
  lua.lua_setglobal(L, to_luastring('pcall'));
  lua.lua_pushcfunction(L, (L1) => {
    const n = lua.lua_gettop(L1);
    lauxlib.luaL_checktype(L1, 2, lua.LUA_TFUNCTION);
    lua.lua_pushboolean(L1, 1);
    lua.lua_pushvalue(L1, 1);
    lua.lua_rotate(L1, 3, 2);
    L1.ci.callstatus |= CIST_OAH;
    return finishpcall(L1, lua.lua_pcallk(L1, n - 2, lua.LUA_MULTRET, 2, 2, finishpcall), 2);
  });
  lua.lua_setglobal(L, to_luastring('xpcall'));

  // the sandbox: drop what reaches files, the network or the hook
  const drop = (tbl, ...names) => {
    if (tbl) { lua.lua_getglobal(L, to_luastring(tbl)); if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return; } }
    for (const n of names) {
      lua.lua_pushnil(L);
      if (tbl) lua.lua_setfield(L, -2, to_luastring(n)); else lua.lua_setglobal(L, to_luastring(n));
    }
    if (tbl) lua.lua_pop(L, 1);
  };
  drop(null, 'io', 'package', 'require', 'dofile', 'loadfile', 'debug', 'fengari');
  drop('os', 'execute', 'exit', 'remove', 'rename', 'tmpname', 'getenv', 'setlocale');

  // ---- the registry's tables
  const wrap = (entry) => {
    const call = (L1) => {
      const n = lua.lua_gettop(L1);
      const args = [];
      for (let i = 1; i <= n; i++) args.push(toJs(L1, i));
      let r;
      try { r = entry.fn.apply(ctx, args); } catch (e) {
        if (typeof e?.retry === 'function') return wait(L1, e.retry, call);
        return raise(L1, e?.message ?? e);
      }
      const m = multiValues(r);
      if (m) { m.forEach((v) => pushJs(L1, v)); return m.length; }
      if (r === undefined) return 0;
      pushJs(L1, r);
      return 1;
    };
    return call;
  };
  // A builtin's read waits for the GPU (console/gpu.js: an error carrying
  // retry, thrown before the builtin changed anything): the command's
  // coroutine yields, and on resume the builtin runs again with its
  // arguments (still on the stack) and finds the blocks read.
  const wait = (L1, retry, call) => {
    if (L1 !== command || !lua.lua_isyieldable(L1)) {
      return raise(L1, 'this read waits for the GPU, which it can\'t from inside your own coroutine or a function such as table.sort or string.gsub calls: read the cell before');
    }
    waiting = retry;
    return lua.lua_yieldk(L1, 0, 0, (L2) => call(L2));
  };
  const tableOf = (name) => {
    lua.lua_getglobal(L, to_luastring(name));
    if (lua.lua_istable(L, -1)) return;
    lua.lua_pop(L, 1);
    lua.lua_newtable(L);
    lua.lua_pushvalue(L, -1);
    lua.lua_setglobal(L, to_luastring(name));
  };
  const install = (entry) => {
    tableOf(entry.table);
    if (entry.kind === 'fn') lua.lua_pushcfunction(L, wrap(entry));
    else pushJs(L, entry.value);
    lua.lua_setfield(L, -2, to_luastring(entry.name));
    lua.lua_pop(L, 1);
  };
  for (const t of consoleTables()) for (const e of t.entries) install(e);
  const offRegister = onConsoleRegister((table, name) => {
    const e = consoleTables().find((t) => t.name === table)?.entries.find((x) => x.name === name);
    if (e) install(e);
  });

  // ---- event (src/lua/LuaEvent.cpp: register returns the function)
  tableOf('event');
  for (const [k, v] of Object.entries(EVENTS)) { lua.lua_pushinteger(L, v); lua.lua_setfield(L, -2, to_luastring(k)); }
  const eventType = (L1) => {
    const t = lauxlib.luaL_checkinteger(L1, 1);
    if (!handlers[t]) raise(L1, `Invalid event type: ${t} (this console has event.TICK, event.BEFORESIM and event.AFTERSIM)`);
    lauxlib.luaL_checktype(L1, 2, lua.LUA_TFUNCTION);
    return t;
  };
  lua.lua_pushcfunction(L, (L1) => {
    const t = eventType(L1);
    lua.lua_pushvalue(L1, 2);
    handlers[t].push(lauxlib.luaL_ref(L1, lua.LUA_REGISTRYINDEX));
    lua.lua_pushvalue(L1, 2);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('register'));
  lua.lua_pushcfunction(L, (L1) => {
    const t = eventType(L1);
    const list = handlers[t];
    for (let i = list.length - 1; i >= 0; i--) {
      lua.lua_rawgeti(L1, lua.LUA_REGISTRYINDEX, list[i]);
      const same = lua.lua_rawequal(L1, -1, 2);
      lua.lua_pop(L1, 1);
      if (same) { lauxlib.luaL_unref(L1, lua.LUA_REGISTRYINDEX, list[i]); list.splice(i, 1); }
    }
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('unregister'));
  lua.lua_pop(L, 1);

  // ---- help(): the registry, by table
  lua.lua_pushcfunction(L, (L1) => {
    const what = lua.lua_isstring(L1, 1) ? lua.lua_tojsstring(L1, 1) : null;
    const tables = consoleTables();
    if (!what) {
      log(`Tables: ${tables.map((t) => t.name).join(', ')}, event. help("sim") lists one; help("sim.partCreate") shows one function.`, 'info');
      return 0;
    }
    const [tn, name] = what.split('.');
    const t = tables.find((x) => x.name === tn);
    if (!t) { log(`No table ${tn}`, 'error'); return 0; }
    const fns = t.entries.filter((e) => e.kind === 'fn' && (!name || e.name === name));
    for (const e of fns) log(`${t.name}.${e.name}(${e.args})${e.doc ? `  ${e.doc}` : ''}`, 'info');
    const vals = t.entries.filter((e) => e.kind === 'value' && (!name || e.name === name));
    if (vals.length && !name) log(`${vals.length} constants: ${vals.slice(0, 8).map((e) => `${t.name}.${e.name}`).join(', ')}${vals.length > 8 ? ', …' : ''}`, 'info');
    else for (const e of vals) log(`${t.name}.${e.name} = ${e.value}`, 'info');
    if (!fns.length && !vals.length) log(`No ${what}`, 'error');
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('help'));

  // ---- the compatibility prelude
  if (lauxlib.luaL_loadbuffer(L, to_luastring(LUA_PRELUDE), null, to_luastring('=prelude')) !== lua.LUA_OK
      || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    throw new Error(`console prelude: ${lua.lua_tojsstring(L, -1)}`);
  }

  const errorText = (L1) => {
    const t = lua.lua_type(L1, -1);
    const msg = t === lua.LUA_TSTRING || t === lua.LUA_TNUMBER ? lua.lua_tojsstring(L1, -1) : `(error object is a ${to_jsstring(lua.lua_typename(L1, t))} value)`;
    lua.lua_pop(L1, 1);
    return msg;
  };
  const loggable = (L1, i) => {
    lauxlib.luaL_tolstring(L1, i);
    const s = lua.lua_tojsstring(L1, -1);
    lua.lua_pop(L1, 1);
    return s;
  };

  // Runs the command's coroutine until it ends ({ ok, text } or { ok: false,
  // error }) or a read waits for the GPU ({ wait }: a function whose promise
  // resolves once the read is in; resume() then).
  function resume() {
    const T = command;
    if (!T) return { ok: false, error: 'no command is waiting' };
    ctx.mode = 'command';
    arm(left, T);
    const status = lua.lua_resume(T, L, 0);
    left = Math.max(0, deadline - now());
    deadline = Infinity;
    if (status === lua.LUA_YIELD) {
      const w = waiting;
      waiting = null;
      if (w) return { wait: w };
      command = null;   // a coroutine.yield of the command itself: it has no one to yield to
      return { ok: false, error: 'attempt to yield from outside a coroutine' };
    }
    command = null;
    if (status !== lua.LUA_OK) return { ok: false, error: errorText(T) };
    const out = [];
    for (let i = 1; i <= lua.lua_gettop(T); i++) out.push(loggable(T, i));
    lua.lua_settop(T, 0);
    return { ok: true, text: out.length ? out.join(', ') : null };
  }

  return {
    // A typed command (TPT's CommandInterface::Command, LuaScriptInterface.cpp):
    // tried as `return <code>` first so an expression prints its value; an
    // unfinished chunk (an error near <eof>) waits for more lines.
    // Returns { ok, text } or { ok: false, error } or { more: true }, or
    // { wait } while a read waits for the GPU (resume() once it resolves).
    run(code) {
      const src = pending ? `${pending}\n${code}` : code;
      lua.lua_settop(L, 0);
      let status = lauxlib.luaL_loadbuffer(L, to_luastring(`return ${src}`), null, to_luastring('=console'));
      if (status !== lua.LUA_OK) {
        lua.lua_pop(L, 1);
        status = lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring('=console'));
      }
      if (status !== lua.LUA_OK) {
        const error = errorText(L);
        if (error.includes("near '<eof>'") || error.includes("near <eof>")) { pending = src; return { more: true }; }
        pending = '';
        return { ok: false, error };
      }
      pending = '';
      // the chunk goes to a fresh coroutine (a read may yield it: see wait)
      command = lua.lua_newthread(L);
      lua.lua_insert(L, -2);
      lua.lua_xmove(L, command, 1);
      lua.lua_settop(L, 0);
      left = COMMAND_LIMIT_MS;
      return resume();
    },
    // After { wait }: the read is in, the command goes on. Returns as run does.
    resume,
    // A command waiting for a read that failed (the grid changed): dropped.
    abandon() { command = null; waiting = null; },

    // Throw away an unfinished multi-line chunk.
    cancel() { pending = ''; },
    get continuing() { return !!pending; },

    // Run every handler of an event type, until the frame's budget runs out
    // (until: a now() time). Returns false if it stopped for the budget.
    dispatch(type, until = Infinity) {
      const list = handlers[type];
      if (!list.length) return true;
      ctx.mode = 'event';
      for (const ref of list.slice()) {
        if (now() > until) return false;
        lua.lua_settop(L, 0);
        lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
        arm(HANDLER_LIMIT_MS);
        const status = lua.lua_pcall(L, 0, 0, 0);
        deadline = Infinity;
        if (status !== lua.LUA_OK) {
          const err = errorText(L);
          const i = list.indexOf(ref);
          if (i >= 0) { list.splice(i, 1); lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref); }
          const name = Object.keys(EVENTS).find((k) => EVENTS[k] === type).toLowerCase();
          log(`An event.${name} handler was removed: ${err}`, 'error');
        }
      }
      lua.lua_settop(L, 0);
      return true;
    },

    handlerCount(type) { return type == null ? handlers.reduce((s, l) => s + l.length, 0) : handlers[type].length; },

    // Unregister every handler (the console's "stop scripts").
    clearHandlers() {
      for (const list of handlers) { for (const ref of list) lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref); list.length = 0; }
    },

    close() { offRegister(); lua.lua_close(L); },
  };
}
