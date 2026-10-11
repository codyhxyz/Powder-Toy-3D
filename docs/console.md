# The console: Lua scripts, The Powder Toy's way

Press `` ` `` (the key left of 1) to open the console, as in The Powder Toy (`src/gui/game/GameView.cpp`:
`SDL_SCANCODE_GRAVE` opens it) and Garry's Mod. It runs **Lua 5.3** with TPT's API names, so TPT scripts and habits
carry over, with one change: every position has a `z`.

```lua
sim.partCreate(-1, 64, 100, 64, elem.DEFAULT_PT_WATR)          -- one water cell
for x = 40, 80 do sim.partCreate(-1, x, 90, 64, "SAND") end   -- a line of sand
print(sim.elementCount("WATR"))                               -- how much water there is
event.register(event.tick, function()                         -- a fountain, every frame
  sim.partCreate(-1, 64, 120, 64, elem.DEFAULT_PT_WATR)
end)
```

- **Enter** runs the line, **Shift+Enter** adds a line, and pasted text with newlines runs as one chunk. A line that
  isn't finished yet (`for i = 1, 10 do`) waits for more, with a `…` prompt, as TPT's console does. **Esc** cancels
  it, or closes the console.
- **Up / Down** walk the history, which is kept between visits (in this browser only).
- An expression prints its value (`1 + 1` prints `2`): the console tries `return <code>` first, as TPT's does
  (`CommandInterface::Command` in `src/lua/LuaScriptInterface.cpp`).
- `help()` lists the tables, `help("sim")` a table, `help("sim.partCreate")` one function.
- **Stop scripts** (shown while any handler is registered) unregisters every event handler.
- **⌘Z** undoes what a typed command changed in the world (its first write takes an undo snapshot). Event handlers'
  writes aren't undoable.

## Where code comes from

Only what you type or paste runs. Nothing runs from a URL, a save or another player. The Lua environment has no `io`,
`require`, `dofile`, `loadfile`, `debug` or `os.exit`: fengari would fetch files over the network for `require`, and
`debug.sethook` could lift the time limits. It does have Lua's base library, `string`, `table`, `math`, `utf8`,
`coroutine` and `os.time`, `os.clock` and `os.date`.

**Multiplayer:** scripts run on the host only. A guest's console is off (it says so): the guest's world is the
host's, streamed, so it has nothing of its own to script. What the host's scripts do reaches guests like any other
change.

## Why Lua, and why fengari

TPT scripts are Lua, so the console is too. [fengari](https://github.com/fengari-lua/fengari) is Lua 5.3 written in
JavaScript (MIT licence, pinned at 0.1.5 in `package.json`). It is loaded only when the console first opens: a
separate 237 kB chunk (79 kB gzipped), nothing for anyone who never presses `` ` ``. It runs about 100 to 300
`partCreate` calls per millisecond, so a loop over a 64³ box takes a second or two (`node tools/check-console.mjs`
prints the rate). Its integers are 32-bit, which is plenty for cell indices.

## The API

Positions are grid cells: `x` and `z` across, `y` up, from 0 to `sim.XRES - 1`, `sim.YRES - 1`, `sim.ZRES - 1`. In
World the grid is the window that follows you, so cell coordinates move with it; `sim.origin()` gives the world cell of
grid cell (0, 0, 0). TPT's particle index is a cell index here: `i = (z * sim.YRES + y) * sim.XRES + x`.

Elements can be given as an id (`elem.DEFAULT_PT_SAND`), a TPT name (`"WATR"`), a key (`"WATER"`) or a display name
(`"Water"`).

### sim

| Function | |
|---|---|
| `sim.partCreate(i, x, y, z, type)` | Makes a particle. `i = -1` (or `-2`) only into air, `-3` anywhere, an index replaces that particle where it is. Returns its index, or -1. |
| `sim.partKill(i)` / `sim.partKill(x, y, z)` | Removes a particle (air at room temperature is left). |
| `sim.partProperty(i, field[, value])` | Gets or sets a particle's field: `type`, `temp` (°C), `life`, `ctype`, `vx`, `vy`, `vz` (cells per step), `pressure`; `x`, `y`, `z` read only. Nil for air (TPT: no particle). |
| `sim.partChangeType(i, type)` | Changes the element and keeps everything else. |
| `sim.cellProperty(x, y, z, field[, value])` | The same for any cell, air included (air has a temperature and pressure). Setting `type` makes a fresh cell. |
| `sim.partID(x, y, z)` | The index of the particle there, or nil. |
| `sim.partExists(i)`, `sim.partPosition(i)` | Is there one; its x, y, z. |
| `for i in sim.parts() do … end` | Every particle (`sim.partNext(i)` underneath). |
| `sim.elementCount(type)`, `sim.partCount()` | How many cells hold an element, or any matter. |
| `sim.pressure(x, y, z[, value])`, `sim.pressure(x, y, z, w, h, d, value)` | A cell's air pressure, or set a box of it (TPT's `LuaBlockMap`). |
| `sim.createParts(x, y, z[, r, type, shape])` | One dab of the brush, through the brush's own pass: an element into air, or a tool (`"DEFAULT_TOOL_HEAT"`, `COOL`, `ERAS`, `PRES`, `SPRK`, `PHOT`, `NEUT`). Shape 0 sphere, 1 cube. At most 64 a frame. |
| `sim.gravity([g])` | Gravity in multiples of normal (0 off, up to the slider's 2.4). |
| `sim.paused([p])` | The pause (TPT's `sim.paused`). |
| `sim.step([n])` | Runs n steps now (1 to 240, about a second), paused or not. From a typed command only. |
| `sim.size()`, `sim.XRES`, `sim.YRES`, `sim.ZRES`, `sim.origin()`, `sim.PT_NUM` | The grid, the window's place in the world, the number of elements. |

Values are kept in the ranges the simulation keeps (`src/physics.js`): temperature −273.15 to 10,000 °C, pressure
−50 to 200, velocity ±1 cell per step, `ctype` 0 to 255.

### tpt, ui, elem

| | |
|---|---|
| `print(...)`, `tpt.log(...)` | Prints to the console, joined with `, ` (TPT's `tpt.log`). |
| `tpt.set_pause([0 or 1])`, `tpt.toggle_pause()` | TPT's pause switches (`compat.lua`). |
| `tpt.selectedl` | The selected element or tool as an identifier (`"DEFAULT_PT_SAND"`); assign to select one. `ui.activeTool(0[, identifier])` too. |
| `tpt.brushx` (`brushy`, `brushz`), `tpt.brushID` | Brush radius and shape (0 sphere, 1 cube); `ui.brushRadius`, `ui.brushID` too. |
| `tpt.set_property(prop, value, x, y, z)` / `(prop, value, i)`, `tpt.get_property(prop, x, y, z)` | TPT's property shortcuts, in 3D. |
| `tpt.create(x, y, z, type)`, `tpt.delete(x, y, z)`, `tpt.element(name or id)` | TPT's shortcuts. |
| `elem.DEFAULT_PT_<NAME>` | Element ids by TPT name (`DEFAULT_PT_SAND`, `DEFAULT_PT_WATR`, `DEFAULT_PT_LAVA`...); `elem.DEFAULT_TOOL_<NAME>` for the brush tools. |
| `elem.getByName(name)`, `elem.exists(id)` | Look an element up (-1 if there's none). |
| `elem.property(id, prop)` | `Name`, `Description`, `Color`, `Temperature`, `Weight`, `State`, `Hardness`, `FullName`, `Identifier`. Read only: the element table is baked into the shaders, so TPT's `elem.allocate` and setting properties aren't possible. |

Aliases from TPT: `simulation`, `elements`, `interface` and `evt` name the same tables.

### event

`event.register(type, fn)` calls `fn` on every event of that type and returns it; `event.unregister(type, fn)`
stops it (`src/lua/LuaEvent.cpp`). `tpt.register_step(fn)` is `event.register(event.tick, fn)`, as in TPT.

| Type | When |
|---|---|
| `event.tick` (`event.TICK`) | Once a frame, before the simulation steps, paused or not (TPT fires it every frame). |
| `event.beforesim` (`BEFORESIM`) | Before every simulation step. With Speed at 4 steps a frame, four times a frame: the one to use for "every step". |
| `event.aftersim` (`AFTERSIM`) | After every step. |

TPT's input events (`keypress`, `mousedown`...) aren't here yet.

**Time limits.** A typed command may run 5 s. One handler call may run 20 ms. All handlers together get 8 ms a frame:
past that, the rest wait for the next frame, so a slow script slows itself and never the game. Past its own limit, or
on an error, a handler is unregistered and the console says why. The limits are checked by a Lua count hook every
1000 instructions, and once one is passed every further instruction errors, so a `pcall` can't swallow it.

## Reads and writes: the GPU in between

The world lives on the GPU (`src/sim.js`: two RGBA32F textures), and reading it back synchronously stalls the frame.
So the console never reads or writes a cell directly (`src/console/world.js`):

- **Writes** are queued, one edit per cell (a second write to the same cell merges into it), and applied in one small
  GPU pass (`src/shaders/script.js`): before every simulation step, after every typed command, and at the end of each
  frame. The edits go up sorted by cell, and each cell of the pass binary-searches them, so a loop of 10,000
  `partCreate` calls costs one pass, about what one brush stroke costs. Only the bricks the edits touch are rebuilt
  for rendering, and only those wake the simulation (`sim.touch`). A write a script can't know will succeed yet
  (`partCreate(-1, ...)` into a cell that may hold matter) is checked by the GPU, as TPT's `create_part` would.
- **Reads** come from a cache of 16 × 8 × 8-cell blocks of the state, each one small rectangle of the state atlas,
  with the queued edits laid over them, so a script reads its own writes at once.
  - A **typed command** reads exactly: the first time it touches a block, it reads it back synchronously (a short
    stall, once per block).
  - An **event handler** never stalls. A block it reads that isn't cached yet is requested, and the read returns nil
    until it arrives (a frame or two). The blocks handlers keep reading are re-read asynchronously every 100 ms, at
    most 64 a frame. So a handler sees the world as it was a few steps ago, plus its own writes. Whole-grid reads in a
    handler (`sim.parts()`, `sim.elementCount`) see what has been read so far, and fill in over a few frames.

## The registry: adding functions

Everything above is registered in `src/console/registry.js` (`src/console/api.js` registers the built-ins), and any
feature can add to it, without loading the console or Lua:

```js
import { registerConsoleApi, registerConsoleValue, multi } from './console/registry.js';

registerConsoleApi('sim', 'loadStamp', function (name, x, y, z) {
  // this.mode: 'command' (typed) or 'event' (a handler); this.log(text) prints
  placeStamp(name, x, y, z);
}, { args: 'name, x, y, z', doc: 'Places a saved stamp.', writes: true });

registerConsoleValue('sim', 'MAX_STAMPS', 32);
```

- A function takes and returns plain values: numbers, strings, booleans, `null` (nil), arrays (Lua sequences) and
  plain objects (Lua tables). `return multi(a, b, c)` returns several values. Throwing an `Error` raises a Lua error
  with its message.
- The table can be one of TPT's (`sim`, `tpt`, `elem`, `ui`) or a new one (`save`, `deco`); registering a name again
  replaces it. Registrations made after the console has started reach it at once.
- `args` and `doc` show in `help()`. Mark `writes: true` for anything that changes the world or settings.
- A function that changes cells should go through the console's queue when it can (the same `ScriptWorld`), or call
  `sim.touch(lo, hi)` before its own pass, so the change is applied in order with the script's other writes. A full
  grid pass per call is fine from a typed command, but cap it per frame for handlers (`createParts` allows 64).

## Checking it

`node tools/check-console.mjs` runs Lua through fengari against a CPU mock of the GPU backend (71 checks: the API,
the edit queue and its merging, the read cache, handlers, time limits, the sandbox, late registration).
`node tools/check-shaders.mjs` compiles the write pass. In a browser, `` ` `` (or `__app.scripts.setOpen(true)`)
opens it; `__app.scripts.world` is the cache and queue. A quick check: `sim.partCreate(-1, 64, 120, 64, "WATR")` should
print an index and drop a water cell, after `sim.step(60)` `sim.partID(64, 120, 64)` should be nil (it fell), and
`event.register(event.beforesim, function() sim.partCreate(-1, 64, 120, 64, "SAND") end)` should pour a stream.
